#!/usr/bin/env python3
"""PROOF 静态服务：按路径映射，不用把界面复制进投放目录。

用法: python3 server.py <root> <port> [idleMinutes] [activityFile] [uiDir]

映射规则：
    /                    → 302 /proof/home-v1/
    /proof/home-v1/*     → <uiDir>/*           （界面，随插件走）
    /data.json           → <root>/data.json     （数据，随用户走）
    /f/*                 → <root>/f/*           （发送过来的东西）
其它路径按 <root> 正常解析；node_modules / .git 一律 404，避免软链接把源码目录暴露出去。

空闲 idleMinutes 后自动退出。
"""
import os
import sys
import time
import threading
import json
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])
IDLE_MIN = int(sys.argv[3]) if len(sys.argv) > 3 else 60
ACTIVITY = sys.argv[4] if len(sys.argv) > 4 else ""
UI_DIR = os.path.abspath(sys.argv[5]) if len(sys.argv) > 5 else os.path.join(ROOT, "proof", "home-v1")

UI_PREFIX = "/proof/home-v1"

# 护城墙：软链接模式下 /f/ 指向源码目录，这些一律 404
BLOCK_DIRS = {"node_modules", "__pycache__", "venv", ".venv", ".next", "dist_node"}
BLOCK_EXTS = (".pem", ".key", ".p12", ".pfx", ".keystore", ".env", ".npmrc", ".netrc")

# link 项目里的文件是软链接：源文件一改，data.json 里记的大小/mtime 就是旧快照。
# 所以 /data.json 每次请求都按实际情况重扫一遍（规则与 src/index.ts 的 collectFiles 对齐）。
SKIP_NAMES = {"node_modules", ".git", ".DS_Store", ".proof"}
MAX_FILES = 400
MAX_DEPTH = 8
KIND_EXTS = {
    "web": (".html", ".htm"),
    "image": (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".heic"),
    "video": (".mp4", ".mov", ".webm", ".m4v", ".ogv"),
    "doc": (".pdf", ".md", ".txt", ".csv"),
    "asset": (".js", ".mjs", ".css", ".json", ".wasm", ".map", ".woff", ".woff2", ".ttf"),
}


def kind_of(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    for kind, exts in KIND_EXTS.items():
        if ext in exts:
            return kind
    return "file"


def scan_files(base: str, rel: str = "", depth: int = 0, out=None) -> list:
    if out is None:
        out = []
    if len(out) >= MAX_FILES or depth > MAX_DEPTH:
        return out
    try:
        entries = sorted(os.listdir(os.path.join(base, rel)))
    except OSError:
        return out
    for name in entries:
        if name in SKIP_NAMES:
            continue
        r = rel + "/" + name if rel else name
        full = os.path.join(base, r)
        try:
            st = os.stat(full)  # 跟随软链接
        except OSError:
            continue
        if os.path.isdir(full):
            scan_files(base, r, depth + 1, out)
        elif os.path.isfile(full):
            out.append({"p": r, "kind": kind_of(r), "bytes": st.st_size, "mtime": int(st.st_mtime * 1000)})
        if len(out) >= MAX_FILES:
            break
    return out


def project_kind(files: list) -> str:
    if any(f["p"].lower().endswith("index.html") for f in files):
        return "web"
    if files and all(f["kind"] == "image" for f in files):
        return "image"
    if files and all(f["kind"] == "video" for f in files):
        return "video"
    return files[0]["kind"] if len(files) == 1 else "file"


def blocked(path: str) -> bool:
    for seg in path.split("/"):
        if not seg:
            continue
        if seg in BLOCK_DIRS:
            return True
        if seg.startswith("."):          # 任何点文件/点目录：.env .git .npmrc .ssh …
            return True
        if seg.lower().endswith(BLOCK_EXTS):
            return True
    return False


def touch_activity() -> None:
    if not ACTIVITY:
        return
    try:
        with open(ACTIVITY, "w", encoding="utf-8") as f:
            f.write(str(int(time.time())))
    except OSError:
        pass


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):  # noqa: N802
        p = urllib.parse.urlsplit(path).path
        if p == "/data.json":
            return os.path.join(ROOT, "data.json")
        if p == UI_PREFIX or p.startswith(UI_PREFIX + "/"):
            rel = p[len(UI_PREFIX):].lstrip("/") or "index.html"
            full = os.path.normpath(os.path.join(UI_DIR, rel))
            if not full.startswith(os.path.normpath(UI_DIR)):
                return os.path.join(ROOT, "__denied__")
            return full
        if blocked(p):
            return os.path.join(ROOT, "__denied__")
        return super().translate_path(path)

    def do_GET(self):  # noqa: N802
        touch_activity()
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", UI_PREFIX + "/")
            self.end_headers()
            return
        if path == "/data.json":
            self.send_data()
            return
        # ?list=1 强制列出目录内容（否则有 index.html 时会直接返回首页）
        if urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("list") == ["1"]:
            target = self.translate_path(path)
            if os.path.isdir(target):
                # list_directory 只发响应头并返回文件对象，body 要自己 copy
                listing = self.list_directory(target)
                try:
                    if listing:
                        self.copyfile(listing, self.wfile)
                finally:
                    if listing:
                        listing.close()
                return
        super().do_GET()

    def send_data(self):
        """实时重算：每次请求都反映此刻的真实状态，不依赖有人调用工具。

        - 断链：link 项目的软链接目标是否还在
        - 清单：link 项目的文件大小/mtime 按源文件现算（发送时的快照会被源文件改动弄旧）
        """
        try:
            with open(os.path.join(ROOT, "data.json"), encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {"updated": None, "totals": {}, "projects": []}
        for proj in data.get("projects", []):
            if proj.get("mode") != "link":
                proj["broken"] = False
                continue
            d = os.path.join(ROOT, proj.get("dir", ""))
            missing = []
            try:
                for entry in os.listdir(d):
                    if not os.path.exists(os.path.join(d, entry)):  # 跟随链接
                        missing.append(entry)
            except OSError:
                missing = ["(项目目录不存在)"]
            proj["broken"] = bool(missing)
            if missing:
                proj["missing"] = missing[:5]
            else:
                proj.pop("missing", None)

            files = scan_files(d)
            if files:
                counts = {}
                for f in files:
                    counts[f["kind"]] = counts.get(f["kind"], 0) + 1
                proj["files"] = files
                proj["count"] = len(files)
                proj["counts"] = counts
                proj["bytes"] = sum(f["bytes"] for f in files)
                proj["kind"] = project_kind(files)

        totals = {}
        for proj in data.get("projects", []):
            for k, v in (proj.get("counts") or {}).items():
                totals[k] = totals.get(k, 0) + v
        data["totals"] = totals

        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):  # noqa: N802
        touch_activity()
        super().do_HEAD()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))
        sys.stderr.flush()


def watchdog(srv: ThreadingHTTPServer) -> None:
    while True:
        time.sleep(30)
        try:
            last = int(open(ACTIVITY, encoding="utf-8").read().strip())
        except Exception:
            last = int(time.time())
        if time.time() - last > IDLE_MIN * 60:
            sys.stderr.write("idle for %d min, shutting down\n" % IDLE_MIN)
            srv.shutdown()
            return


def main() -> None:
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    touch_activity()
    threading.Thread(target=watchdog, args=(srv,), daemon=True).start()
    sys.stderr.write("root=%s ui=%s port=%d idle=%dm\n" % (ROOT, UI_DIR, PORT, IDLE_MIN))
    sys.stderr.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
