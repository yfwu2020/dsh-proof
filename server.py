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
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])
IDLE_MIN = int(sys.argv[3]) if len(sys.argv) > 3 else 60
ACTIVITY = sys.argv[4] if len(sys.argv) > 4 else ""
UI_DIR = os.path.abspath(sys.argv[5]) if len(sys.argv) > 5 else os.path.join(ROOT, "proof", "home-v1")

UI_PREFIX = "/proof/home-v1"
BLOCK = {"node_modules", ".git", ".proof", ".DS_Store"}


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
        if any(seg in BLOCK for seg in p.split("/")):
            return os.path.join(ROOT, "__denied__")
        return super().translate_path(path)

    def do_GET(self):  # noqa: N802
        touch_activity()
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", UI_PREFIX + "/")
            self.end_headers()
            return
        super().do_GET()

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
