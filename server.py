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
        super().do_GET()

    def send_data(self):
        """实时重算断链：每次请求都反映此刻的真实状态，不依赖有人调用工具。"""
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
