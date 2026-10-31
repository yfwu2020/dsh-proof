#!/usr/bin/env python3
"""PROOF 静态服务：按需启动，空闲自动退出。

用法: python3 server.py <root> <port> [idleMinutes] [activityFile]

- 每个请求刷新 activityFile 的 mtime
- 看门狗每 30 秒检查一次，空闲超过 idleMinutes 就自己 shutdown
- stdout/stderr 由调用方接管（插件里是 detached 子进程）
"""
import os
import sys
import time
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = sys.argv[1]
PORT = int(sys.argv[2])
IDLE_MIN = int(sys.argv[3]) if len(sys.argv) > 3 else 60
ACTIVITY = sys.argv[4] if len(sys.argv) > 4 else ""


def touch_activity() -> None:
    if not ACTIVITY:
        return
    try:
        with open(ACTIVITY, "w", encoding="utf-8") as f:
            f.write(str(int(time.time())))
    except OSError:
        pass


APP_ENTRY = "/proof/home-v1/"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):  # noqa: N802
        touch_activity()
        # 根路径直接进首页（不再有收件箱）
        if self.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", APP_ENTRY)
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
    sys.stderr.write("serving %s on :%d (idle stop %d min)\n" % (ROOT, PORT, IDLE_MIN))
    sys.stderr.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
