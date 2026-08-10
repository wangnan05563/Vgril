#!/usr/bin/env python3
# mock_llm_upstream.py - 本地可控延迟上游，用于隔离 server.py 代理路径的本地性能。
#
# 用法:
#   python mock_llm_upstream.py [delay_ms] [port]
# 默认 delay=10ms, port=9099。
#
# 说明:
#   server.py 的 /api/llm 有 SSRF 守卫(强制 https + 公网 host)，本机 localhost 作上游会被拒。
#   但 /api/heygen 的 proxy() 信任 HEYGEN_HOST 环境变量且不做 host 校验，
#   因此测试时把 HEYGEN_HOST 指向本 mock(http://127.0.0.1:9099)，
#   用 /api/heygen 路径等价验证代理吞吐/并发（proxy() 与 proxy_llm() 代码路径一致）。
#   本 mock 用 ThreadingHTTPServer，自身不成为瓶颈。
import sys, time, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DELAY = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0   # 每请求模拟上游延迟(ms)
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 9099


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code=200, obj=None):
        if obj is None:
            obj = {"code": 100, "data": {"mock": True, "path": self.path}}
        body = json.dumps(obj).encode("utf-8")
        # 模拟上游处理延迟
        if DELAY > 0:
            time.sleep(DELAY / 1000.0)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length:
            self.rfile.read(min(length, 1 << 20))  # 只读掉 body，避免阻塞
        self._send()

    def log_message(self, *a):
        pass


def run():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print("MOCK_UPSTREAM_READY http://127.0.0.1:%d delay=%.1fms" % (PORT, DELAY))
    srv.serve_forever()


if __name__ == "__main__":
    run()
