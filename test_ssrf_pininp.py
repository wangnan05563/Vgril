# -*- coding: utf-8 -*-
"""SSRF DNS 重绑定(TOCTOU) 钉死 IP 修复的回归测试。
验证点：
  1) 连接时校验(_resolve_public_ip)是权威门禁 —— 入口网关放行后，若连接前解析翻成私网/元数据地址，必被拒（窗口关闭）。
  2) 直连路径会钉死解析出的公网 IP，且 Host 头/TLS SNI 仍用原主机名。
  3) 真实 socket 集成：pin 到被测 IP 能连通本地服务，且服务端收到的 Host 头正确。
"""
import socket, threading, sys, types

# 在导入 server 前，避免 heygen/llm 等模块级联网解析影响；导入后我们再 monkeypatch。
import importlib.util
spec = importlib.util.spec_from_file_location("server", r"D:\code\otherProjects\21_Vgril\server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

_fail = []
_ok = []

def check(name, cond):
    ( _ok if cond else _fail ).append(name)
    print(("PASS " if cond else "FAIL ") + name)

# ---------------- 1) TOCTOU 闭合：入口放行后，连接前翻成私网/元数据仍必须被拒 ----------------
# 入口网关(_assert_public_host)看到公网 -> 放行
server.socket.getaddrinfo = lambda h, p, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
try:
    server._assert_public_host("flip.example")
    entry_passed = True
except ValueError:
    entry_passed = False
check("入口网关对公网 IP 放行", entry_passed)

# 连接前(_resolve_public_ip)翻成元数据地址 -> 必须拒绝（证明连接时校验是权威门禁，窗口关闭）
server.socket.getaddrinfo = lambda h, p, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 0))]
try:
    server._resolve_public_ip("flip.example", 443)
    check("TOCTOU: 入口放行后连接前翻成元数据仍被拒", False)
except ValueError:
    check("TOCTOU: 入口放行后连接前翻成元数据仍被拒", True)

# 还原 getaddrinfo
server.socket.getaddrinfo = socket.getaddrinfo

# ---------------- 2) 正常公网解析返回 IP 字符串 ----------------
server.socket.getaddrinfo = lambda h, p, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
try:
    ip = server._resolve_public_ip("public.example", 443)
    check("正常公网解析返回字面量 IP", ip == "93.184.216.34")
except ValueError:
    check("正常公网解析返回字面量 IP", False)

# ---------------- 3) 仅私网解析必拒 ----------------
server.socket.getaddrinfo = lambda h, p, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 0))]
try:
    server._resolve_public_ip("private.example", 443)
    check("仅私网解析被拒", False)
except ValueError:
    check("仅私网解析被拒", True)
server.socket.getaddrinfo = socket.getaddrinfo

# ---------------- 4) TLS pin 对象属性正确（不真正连接） ----------------
conn = server._ConnPool().get("x.com", 443, True, pin_ip="1.2.3.4")
check("TLS pin: host 为原主机名(SNI 源)", getattr(conn, "host", None) == "x.com")
check("TLS pin: _pin_ip 为钉死 IP", getattr(conn, "_pin_ip", None) == "1.2.3.4")
try:
    conn.close()
except Exception:
    pass

# ---------------- 5) 真实 socket 集成：pin 直连 + Host 头正确 ----------------
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = ("host=%s" % self.headers.get("Host", "")).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

# 让 flip.example 解析到 127.0.0.1:port，并允许该 IP 通过公网校验（仅测试用）
server.socket.getaddrinfo = lambda h, p, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
_orig_assert = server._assert_public_ip
server._assert_public_ip = lambda ip: None  # 测试白名单：放行 127.0.0.1
try:
    status, headers, body = server._pooled_request("GET", "http://flip.example:%d/ping" % port)
    check("集成: 状态码 200", status == 200)
    check("集成: 服务端收到的 Host 头为原主机名", body == ("host=flip.example:%d" % port).encode())
finally:
    server._assert_public_ip = _orig_assert
    server.socket.getaddrinfo = socket.getaddrinfo
    srv.shutdown()

print("\n== 结果: %d 通过 / %d 失败 ==" % (len(_ok), len(_fail)))
sys.exit(1 if _fail else 0)
