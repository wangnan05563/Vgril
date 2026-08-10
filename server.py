#!/usr/bin/env python3
# server.py - 静态文件服务 + HeyGen / 腾讯智影(数智人) 反向代理
#
# 作用：
#   1) 托管 index.html / xiaoya.png 等静态资源
#   2) /api/heygen/*  转发到 HeyGen，并在服务端注入 API Key（规避 CORS，Key 不落地前端）
#   3) /api/zhiying/* 走腾讯云 TC3-HMAC-SHA256 签名调用数智人 CreateVideo / DescribeVideo
#      （腾讯云 SecretId/SecretKey 只在服务端，前端只传文本与 Avatar/Voice ID）
#
# 运行：  python server.py   ->  打开 http://127.0.0.1:8080
#
# 密钥配置（优先级：环境变量 > keys.json）：
#   HeyGen:        HEYGEN_API_KEY       或 keys.json {"heygen":"sk-..."}
#   腾讯智影:       ZHIYING_SECRET_ID / ZHIYING_SECRET_KEY
#                  或 keys.json {"zhiying_secret_id":"...","zhiying_secret_key":"..."}
#                  （可选）ZHIYING_REGION 默认 ap-guangzhou；ZHIYING_VERSION 默认 2022-05-31

import json
import os
import sys
import time
import tempfile
import hashlib
import hmac
import datetime
import webbrowser
import socket
import threading
import collections
import ssl
import http.client
import ipaddress
import urllib.request
import urllib.error
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer

# ---------- 出站请求：支持代理 + 可配置超时 ----------
API_TIMEOUT = int(os.environ.get("API_TIMEOUT", "30"))

def _build_opener():
    proxies = {}
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
        v = os.environ.get(key)
        if v:
            proxies["http"] = v
            proxies["https"] = v
    if proxies:
        return urllib.request.build_opener(urllib.request.ProxyHandler(proxies))
    return urllib.request.build_opener()

_OPENER = _build_opener()

def _open(req, timeout=API_TIMEOUT):
    """代理感知的出站请求；超时/连接失败会抛出可读异常。"""
    return _OPENER.open(req, timeout=timeout)

def _net_msg(e):
    """把 urllib 的网络异常翻译成中文可读信息。"""
    reason = getattr(e, "reason", e)
    s = str(reason)
    if isinstance(reason, (TimeoutError, socket.timeout)) or "10060" in s or "timed out" in s.lower():
        return "无法连接上游服务器（网络超时）。请确认本机可访问外网，或已通过 HTTPS_PROXY 配置代理，且防火墙未拦截。"
    if "10061" in s or "refused" in s.lower():
        return "上游服务器拒绝连接（连接被拒）。请检查端点地址或代理设置。"
    return "连接上游服务失败：%s" % s


# ---------------- 出站连接池（keep-alive，避免每请求重建 TLS/连接） ----------------
def _proxy_for(url):
    """返回该 URL 应使用的上游代理（按 scheme 取 HTTPS_PROXY/HTTP_PROXY）。无则返回 None。"""
    p = urllib.parse.urlparse(url)
    if p.scheme == "https":
        return os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    return os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """钉死 IP 直连：TCP 连到 pin_ip，但 TLS 的 SNI 与证书校验使用原始主机名。

    本机托管 Python 的 http.client.HTTPSConnection 不接受 server_hostname 构造参数，
    故覆盖 connect()：建立 socket 后按原主机名做 wrap_socket（而非按 IP），
    从而既防 DNS 重绑定、又不触发证书主机名不匹配。
    """
    def __init__(self, host, port, pin_ip, context, timeout):
        super().__init__(host, port, context=context, timeout=timeout)
        self._pin_ip = pin_ip

    def connect(self):
        self.sock = self._create_connection((self._pin_ip, self.port),
                                            self.timeout, self.source_address)
        if self._context is not None:
            self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


class _ConnPool:
    """极简线程安全连接池：复用上游 keep-alive 连接（仅限直连场景）。"""
    def __init__(self, maxsize=32):
        self._lock = threading.Lock()
        self._buckets = collections.defaultdict(collections.deque)
        self._maxsize = maxsize

    def _key(self, host, port, use_ssl):
        return (host, port, use_ssl)

    def get(self, host, port, use_ssl, pin_ip=None):
        k = self._key(host, port, use_ssl)
        with self._lock:
            if self._buckets[k]:
                return self._buckets[k].popleft()
        if use_ssl:
            ctx = ssl.create_default_context()
            if pin_ip is not None:
                # 钉死 IP 直连：TLS SNI/证书校验仍用原主机名 host（见 _PinnedHTTPSConnection）
                return _PinnedHTTPSConnection(host, port, pin_ip, ctx, API_TIMEOUT)
            return http.client.HTTPSConnection(host, port, context=ctx, timeout=API_TIMEOUT)
        if pin_ip is not None:
            return http.client.HTTPConnection(pin_ip, port, timeout=API_TIMEOUT)
        return http.client.HTTPConnection(host, port, timeout=API_TIMEOUT)

    def put(self, host, port, use_ssl, conn):
        k = self._key(host, port, use_ssl)
        with self._lock:
            if len(self._buckets[k]) < self._maxsize:
                self._buckets[k].append(conn)
                return
        try:
            conn.close()
        except Exception:
            pass


_POOL = _ConnPool(maxsize=32)


def _keep_alive(resp):
    if "close" in (resp.getheader("Connection") or "").lower():
        return False
    return getattr(resp, "version", 11) >= 11


def _pooled_request(method, url, body=None, headers=None):
    """直连（无代理）场景：复用上游 keep-alive 连接。返回 (status, headers, body)。
    网络层失败抛 URLError（供 _net_msg 转译）；响应超限抛 ValueError。"""
    p = urllib.parse.urlparse(url)
    host = p.hostname
    port = p.port or (443 if p.scheme == "https" else 80)
    use_ssl = p.scheme == "https"
    path = p.path or "/"
    if p.query:
        path += "?" + p.query
    hdrs = dict(headers or {})
    if "Host" not in hdrs:
        hdrs["Host"] = host if port in (80, 443) else "%s:%d" % (host, port)
    # DNS 重绑定（TOCTOU）闭环：解析一次并校验为「公网 IP」，直连钉死该 IP；
    # TLS 的 SNI/证书校验仍使用原始主机名（server_hostname），与 IP 解耦。
    pin_ip = _resolve_public_ip(host, port)
    for attempt in range(2):
        conn = _POOL.get(host, port, use_ssl, pin_ip=pin_ip)
        try:
            conn.request(method, path, body=body, headers=hdrs)
            resp = conn.getresponse()
            body_bytes = _read_bounded(resp)
            status = resp.status
            resp_headers = {k.lower(): v for k, v in resp.getheaders()}
            if _keep_alive(resp):
                _POOL.put(host, port, use_ssl, conn)
            else:
                try:
                    conn.close()
                except Exception:
                    pass
            return status, resp_headers, body_bytes
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            if attempt == 0:
                continue
            raise urllib.error.URLError(e)


def _proxy_upstream(method, url, body=None, headers=None):
    """出站代理统一入口：配了上游代理则走原 urllib（保持 HTTPS_PROXY 行为），
    否则走连接池（keep-alive）。成功均返回 (status, headers, body)；网络失败抛 URLError。"""
    if _proxy_for(url):
        req = urllib.request.Request(url, data=body, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with _open(req) as r:
                return r.status, {k.lower(): v for k, v in r.getheaders()}, _read_bounded(r)
        except urllib.error.HTTPError as e:
            return e.code, {k.lower(): v for k, v in e.headers.items()}, _read_bounded(e)
    return _pooled_request(method, url, body=body, headers=headers)


# ---------------- 出站安全：SSRF / 开放代理 防护 ----------------
# 防止 /api/llm 被当成跳板打内网或云元数据（169.254.169.254）。
# 关键原则：被代理的目标 URL 只能来自「服务端配置 / 环境变量」（白名单或公网 https），
#          绝不允许由客户端请求头（x-llm-endpoint）指定任意 URL。
MAX_RESPONSE_BYTES = int(os.environ.get("MAX_RESPONSE_BYTES", str(32 * 1024 * 1024)))
# 入站连接 socket 超时（防 Slow-loris / 半开连接长期占用线程与并发信号量槽）
SOCKET_TIMEOUT = float(os.environ.get("SOCKET_TIMEOUT", "60"))
# 入站请求体上限（防恶意超大 Content-Length 拖占信号量槽）；超界返回 413
MAX_REQUEST_BODY = int(os.environ.get("MAX_REQUEST_BODY", str(10 * 1024 * 1024)))
# 腾讯云调用专用超时（视频生成可能较慢，独立于通用 API_TIMEOUT）
TENCENT_TIMEOUT = int(os.environ.get("TENCENT_TIMEOUT", "90"))
# 大模型 endpoint 默认仅允许这些公网白名单主机：
#   - 默认非空 = 默认拒绝"任意公网可代理"，消除开放代理能力；
#   - 受信任主机 DNS 非攻击者可控，使 DNS 重绑定在本地端口跳板场景下无实际利用价值；
#   - 用户仍可用 LLM_ALLOWED_HOSTS 环境变量扩展自有端点。
_DEFAULT_LLM_ALLOWED_HOSTS = "api.deepseek.com,api.openai.com,api.siliconflow.cn,open.bigmodel.cn,dashscope.aliyuncs.com"
_LLM_ALLOWED_HOSTS = [h.strip().lower() for h in os.environ.get("LLM_ALLOWED_HOSTS", _DEFAULT_LLM_ALLOWED_HOSTS).split(",") if h.strip()]
# 请求体超限哨兵（区别于"无 body"的 None）
_BODY_TOO_LARGE = object()


def _assert_public_ip(ip):
    """拒绝私网/环回/链路本地(含云元数据 169.254.169.254)/保留/组播/未指定地址。"""
    if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
            or ip.is_multicast or ip.is_unspecified):
        raise ValueError("目标是内网/保留地址，已拒绝（安全策略）")


def _assert_public_host(host):
    """允许域名（解析后逐 IP 校验）；拒绝字面量私网 IP，解析到私网也拒绝。"""
    host = (host or "").strip().lower()
    if not host:
        raise ValueError("缺少主机名")
    try:
        ip = ipaddress.ip_address(host)            # 字面量 IP
        _assert_public_ip(ip)
        return
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        raise ValueError("无法解析主机：%s" % host)
    if not infos:
        raise ValueError("无法解析主机：%s" % host)
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        _assert_public_ip(ip)


def _resolve_public_ip(host, port):
    """一次性解析并校验，返回可用于直连的公网 IP 字符串（消除 DNS 重绑定 TOCTOU）。

    与 _assert_public_host（入口网关，校验所有解析 IP）不同，这里解析出的 IP 会
    **直接**用于建立 TCP/TLS 连接，从而把「安全校验」与「实际连接」收敛到同一次
    getaddrinfo 结果 —— 连接只打到刚刚校验过的那个 IP，重绑定窗口被关闭。
    """
    host = (host or "").strip().lower()
    if not host:
        raise ValueError("缺少主机名")
    try:
        ip = ipaddress.ip_address(host)            # 字面量 IP
        _assert_public_ip(ip)
        return host
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, port or 443, type=socket.SOCK_STREAM)
    except Exception:
        raise ValueError("无法解析主机：%s" % host)
    if not infos:
        raise ValueError("无法解析主机：%s" % host)
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        try:
            _assert_public_ip(ip)
            return info[4][0]                       # 返回字面量 IP（钉死直连）
        except ValueError:
            continue
    raise ValueError("主机解析到的地址均非公网，已拒绝：%s" % host)


def _safe_target(url):
    """校验出站目标：仅 https、无 userinfo/非法端口、主机非私网。返回规范化 URL。"""
    if not url or "@" in url.split("?", 1)[0]:
        raise ValueError("非法目标（含 userinfo）")
    p = urllib.parse.urlparse(url)
    if p.scheme != "https":
        raise ValueError("仅允许 https 出站")
    if not p.hostname:
        raise ValueError("缺少主机名")
    if p.port is not None and not (1 <= p.port <= 65535):
        raise ValueError("非法端口")
    _assert_public_host(p.hostname)
    return url


def _safe_llm_endpoint(url):
    """大模型 endpoint 必须是服务端配置的公网 https；设了 LLM_ALLOWED_HOSTS 须命中白名单。"""
    url = _safe_target(url)
    if _LLM_ALLOWED_HOSTS:
        host = urllib.parse.urlparse(url).hostname.lower()
        if host not in _LLM_ALLOWED_HOSTS:
            raise ValueError("endpoint 主机不在白名单：%s" % host)
    return url


def _read_bounded(r, limit=MAX_RESPONSE_BYTES):
    """带上限读取上游响应，防止异常/恶意大响应拖垮本机。"""
    chunks, total = [], 0
    while True:
        chunk = r.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise ValueError("上游响应超过 %d 字节上限，已拒绝" % limit)
        chunks.append(chunk)
    return b"".join(chunks)


PORT = int(os.environ.get("PORT", "8080"))
# onefile 下 PyInstaller 将资源解压到 sys._MEIPASS；源码模式回退到本文件目录。
# 静态文件根必须锚定 HERE（见 Handler.__init__ 的 directory=HERE），
# 否则 SimpleHTTPRequestHandler 会回退到进程 cwd，暴露运行目录下的源码 assets。
HERE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
# HEYGEN_HOST 出站安全：与 /api/llm 同标准（失败即 fail-closed）。
# 仅允许 https、拒绝 userinfo、拒绝私网/环回/链路本地(含 169.254.169.254) 主机，
# 避免把本服务配置成打内网的跳板（即便它由服务端环境变量指定，也坚持统一校验）。
_HEYGEN_HOST_RAW = os.environ.get("HEYGEN_HOST", "https://api.heygen.com")
def _harden_heygen_host(raw):
    p = urllib.parse.urlparse(raw)
    if p.scheme != "https":
        raise ValueError("HEYGEN_HOST 必须为 https")
    if "@" in (p.netloc or ""):
        raise ValueError("HEYGEN_HOST 含非法 userinfo")
    try:
        _assert_public_host(p.hostname)
    except ValueError:
        raise
    except Exception:
        # DNS 解析失败（离线环境）：仅拒绝字面量私网 IP，放行无法解析的域名
        try:
            _assert_public_ip(ipaddress.ip_address(p.hostname))
        except ValueError:
            pass
    return raw
try:
    HEYGEN_HOST = _harden_heygen_host(_HEYGEN_HOST_RAW)
except ValueError as e:
    # 配置非法（私网/非 https）：宁可禁用 HeyGen 代理，也不做不安全转发
    print("[安全] HEYGEN_HOST 未通过校验，HeyGen 代理已禁用：%s" % e)
    HEYGEN_HOST = None
JSON_CONTENT_TYPE = "application/json"
HEYGEN_API_PREFIX = "/api/heygen"
DH_PREFIX = "/api/dh"            # 统一数字人代理前缀：/api/dh/<provider>[/sub...]


def heygen_proxy(path, method, body, api_key=None):
    """HeyGen 转发核心（SSRF/路径穿越加固统一在此）；返回 (status, headers, body)。
    供 Handler.proxy 与 app_asgi 共用，避免 D2 安全逻辑分叉。失败抛 ValueError/URLError。"""
    if not path.startswith(HEYGEN_API_PREFIX):
        raise ValueError("非 HeyGen 代理路径")
    rel = path[len(HEYGEN_API_PREFIX):]
    if not rel.startswith("/"):
        rel = "/" + rel
    # SSRF/路径穿越防护：拒绝 .. / // / @ / 反斜杠 / 控制字符 / NUL
    bad = ("..", "//", "\\", "@", "\r", "\n", "%00")
    query = ""
    if "?" in path:
        query = path.split("?", 1)[1]
    if any(c in rel for c in bad) or any(c in query for c in bad):
        raise ValueError("路径含非法字符（疑似穿越）")
    prefixes = [p.strip() for p in os.environ.get("HEYGEN_ALLOWED_PREFIXES", "").split(",") if p.strip()]
    if prefixes and not any(rel.startswith(p) for p in prefixes):
        raise ValueError("路径不在允许前缀白名单")
    if HEYGEN_HOST is None:
        raise ValueError("HeyGen host 未通过安全校验，代理已禁用")
    url = HEYGEN_HOST + rel
    if query:
        url += "?" + query
    hdrs = {"Content-Type": JSON_CONTENT_TYPE}
    if api_key:
        hdrs["x-api-key"] = api_key
    return _proxy_upstream(method, url, body=body, headers=hdrs)


def load_keys():
    keys = {}
    v = os.environ.get("HEYGEN_API_KEY")
    if v:
        keys["heygen"] = v
    zid = os.environ.get("ZHIYING_SECRET_ID")
    zk = os.environ.get("ZHIYING_SECRET_KEY")
    if zid:
        keys["zhiying_secret_id"] = zid
    if zk:
        keys["zhiying_secret_key"] = zk
    p = os.path.join(HERE, "keys.json")
    if os.path.exists(p):
        try:
            keys.update(json.load(open(p, encoding="utf-8")))
        except Exception as e:
            print("读取 keys.json 失败：", e)
    # PyInstaller 单文件 exe：额外读取可执行文件同目录的 keys.json
    if getattr(sys, "frozen", False):
        ep = os.path.join(os.path.dirname(sys.executable), "keys.json")
        if os.path.exists(ep):
            try:
                keys.update(json.load(open(ep, encoding="utf-8")))
            except Exception as e:
                print("读取 exe 同目录 keys.json 失败：", e)
    return keys


KEYS = load_keys()
ZHIYING_REGION = os.environ.get("ZHIYING_REGION", KEYS.get("zhiying_region", "ap-guangzhou"))
ZHIYING_VERSION = os.environ.get("ZHIYING_VERSION", "2022-05-31")

# ---------------- 前端 API 配置持久化（服务端文件兜底） ----------------
# 解决 localStorage 按端口隔离 / 被清空导致"刷新或重启后 API 配置丢失"的问题。
# 客户端设置面板修改后，除写 localStorage 外，还会 POST 到 /api/config，
# 服务端落地到 xiaoya_config.json（与 exe 同目录），跨端口/重启均保留。
# 冻结成 exe 双击运行时，__file__ 指向临时解压目录；配置必须落在 exe 同目录才持久。
if getattr(sys, "frozen", False):
    _CFG_DIR = os.path.dirname(sys.executable)
else:
    _CFG_DIR = HERE
CONFIG_FILE = os.path.join(_CFG_DIR, "xiaoya_config.json")
CONFIG_KEYS = ("dhEnabled", "dhProvider", "dhKey", "dhAvatar", "dhVoice",
               "llmEnabled", "llmEndpoint", "llmKey", "llmModel", "llmSystem",
               "ttsEndpoint", "ttsKey")

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            return json.load(open(CONFIG_FILE, encoding="utf-8"))
        except Exception as e:
            print("读取 xiaoya_config.json 失败：", e)
    return {}

CONFIG = load_config()

# 串行化配置写，避免高并发下共享 .tmp 路径争用导致 HTTP 500 / 丢失更新
_CONFIG_LOCK = threading.Lock()

def save_config(incoming):
    """合并入站配置并原子写入 xiaoya_config.json。返回 (code, obj)。"""
    if not isinstance(incoming, dict):
        return 400, {"error": {"message": "配置须为 JSON 对象"}}
    with _CONFIG_LOCK:
        for k in CONFIG_KEYS:
            if k in incoming:
                CONFIG[k] = incoming[k]
        payload = json.dumps(CONFIG, ensure_ascii=False, indent=2)
        # 每写用唯一临时文件 + 重试：规避 Windows 杀软/索引器对共享 .tmp 的瞬时限锁（PermissionError），
        # 也彻底消除多进程/多线程对同一 .tmp 名的争用。os.replace 保证原子落地、不撕裂。
        last_err = None
        for attempt in range(5):
            fd, tmppath = tempfile.mkstemp(dir=_CFG_DIR, prefix=".cfg_", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(payload)
                os.replace(tmppath, CONFIG_FILE)
                return 200, {"ok": True}
            except Exception as e:
                last_err = e
                try:
                    if os.path.exists(tmppath):
                        os.remove(tmppath)
                except Exception:
                    pass
                if attempt < 4:
                    time.sleep(0.005 * (attempt + 1))
                    continue
                return 500, {"error": {"message": "写入配置失败：" + str(e)}}
        return 500, {"error": {"message": "写入配置失败：" + str(last_err)}}


# ---------------- 腾讯云 TC3-HMAC-SHA256 签名 ----------------
def tencent_sign(secret_id, secret_key, service, action, region, payload_str, host):
    algorithm = "TC3-HMAC-SHA256"
    timestamp = int(time.time())
    date = datetime.datetime.fromtimestamp(timestamp, tz=datetime.timezone.utc).replace(tzinfo=None).strftime("%Y-%m-%d")
    ct = "application/json; charset=utf-8"
    canonical_headers = "content-type:%s\nhost:%s\n" % (ct, host)
    signed_headers = "content-type;host"
    payload_hash = hashlib.sha256(payload_str.encode("utf-8")).hexdigest()
    canonical_request = "%s\n%s\n%s\n%s\n%s\n%s" % (
        "POST", "/", "", canonical_headers, signed_headers, payload_hash)
    credential_scope = "%s/%s/tc3_request" % (date, service)
    string_to_sign = "%s\n%d\n%s\n%s" % (
        algorithm, timestamp, credential_scope,
        hashlib.sha256(canonical_request.encode()).hexdigest())

    def hmac_s(key, msg):
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    secret_date = hmac_s(("TC3" + secret_key).encode(), date)
    secret_service = hmac_s(secret_date, service)
    secret_signing = hmac_s(secret_service, "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
    authorization = "%s Credential=%s/%s, SignedHeaders=%s, Signature=%s" % (
        algorithm, secret_id, credential_scope, signed_headers, signature)
    return {
        "Authorization": authorization,
        "Content-Type": ct,
        "Host": host,
        "X-TC-Action": action,
        "X-TC-Timestamp": str(timestamp),
        "X-TC-Version": ZHIYING_VERSION,
        "X-TC-Region": region,
    }


def tencent_call(action, payload, region):
    host = "dh.tencentcloudapi.com"
    sid = KEYS.get("zhiying_secret_id", "")
    sk = KEYS.get("zhiying_secret_key", "")
    if not sid or not sk:
        raise RuntimeError("未配置腾讯云 SecretId/SecretKey（服务端 keys.json 或环境变量）")
    body = json.dumps(payload)
    headers = tencent_sign(sid, sk, "dh", action, region, body, host)
    req = urllib.request.Request("https://" + host + "/", data=body.encode(),
                                 headers=headers, method="POST")
    # 走统一代理通道（尊重 HTTPS_PROXY），超时独立于通用 API_TIMEOUT
    with _open(req, TENCENT_TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def zhiying_create(text, avatar, voice):
    # 数字人播报视频请求体；字段以腾讯智影/数智人控制台模板为准，按需调整
    payload = {
        "VideoData": json.dumps({
            "VideoType": 1,
            "DigitalHuman": {"DigitalHumanId": avatar},
            "Tts": {"Text": text, "VoiceType": voice},
            "Background": {"BackgroundType": 0},
        }),
        "VideoType": 1,
    }
    resp = tencent_call("CreateVideo", payload, ZHIYING_REGION)
    r = resp.get("Response", resp)
    if "Error" in r:
        return {"error": {"message": r["Error"].get("Message", "error")}}
    return {"data": {"video_id": r.get("VideoId") or r.get("TaskId") or ""}}


def zhiying_describe(video_id):
    resp = tencent_call("DescribeVideo", {"VideoId": video_id}, ZHIYING_REGION)
    r = resp.get("Response", resp)
    if "Error" in r:
        return {"error": {"message": r["Error"].get("Message", "error")}}
    url = r.get("VideoUrl") or (r.get("VideoUrlSet") or [None])[0] or ""
    return {"data": {"status": r.get("Status", ""), "video_url": url}}


# 有界并发：超过上限快速返回 503（fail-fast），避免线程无限堆积拖垮整体
_MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "256"))
_REQ_SEMA = threading.Semaphore(_MAX_CONCURRENT)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # 开启服务端 keep-alive，避免每请求重建连接

    def __init__(self, *args, **kwargs):
        # 静态文件根固定为 HERE：onefile 下 HERE 即 PyInstaller 解压目录 _MEIPASS，
        # 内嵌的 dist/assets 在此。否则 SimpleHTTPRequestHandler 会回退到进程 cwd，
        # 暴露运行目录下的源码 assets（含 _*.test.mjs 等），破坏单文件自包含。
        # 必须在 super().__init__() 之前设置：父类构造会同步处理首请求，
        # end_headers 会读取该属性（POST 路径不设置，故需默认存在）
        self._static_req = False
        super().__init__(*args, directory=HERE, **kwargs)
        # 设连接级超时：避免 Slow-loris / 半开连接长期占用线程与并发信号量槽
        # （keep-alive 空闲连接到期由服务端主动关闭，handle_error 已静默，无 traceback）
        try:
            self.connection.settimeout(SOCKET_TIMEOUT)
        except Exception:
            pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", JSON_CONTENT_TYPE)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _safe_json(self, code, obj):
        try:
            self._json(code, obj)
        except OSError:
            pass  # 客户端已断开连接，忽略写入错误

    def _send_proxy_result(self, status, headers, body):
        ct = headers.get("content-type") or JSON_CONTENT_TYPE
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _read_body(self, default=b"{}"):
        """读取请求体并做上限保护；超限发送 413 并返回哨兵；无 Content-Length 时返回 default。"""
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > MAX_REQUEST_BODY:
            self.send_error(413)
            return _BODY_TOO_LARGE
        return self.rfile.read(length) if length else default

    def do_GET(self):
        if not self._acquire():
            return
        self._static_req = False
        try:
            if self.path.startswith(HEYGEN_API_PREFIX):
                return self.proxy()
            if self.path.startswith("/api/zhiying/status"):
                return self.zhiying_status()
            if self.path.startswith(DH_PREFIX):
                return self.proxy_dh(self._dh_provider(), None)
            if self.path.split("?")[0] == "/api/config":
                return self.get_config()
            self._static_req = True
            return super().do_GET()
        finally:
            self._release()

    def do_POST(self):
        if not self._acquire():
            return
        try:
            if self.path.startswith(HEYGEN_API_PREFIX):
                body = self._read_body(default=None)
                if body is _BODY_TOO_LARGE:
                    return
                return self.proxy(body)
            if self.path.startswith("/api/llm"):
                body = self._read_body()
                if body is _BODY_TOO_LARGE:
                    return
                return self.proxy_llm(body)
            if self.path.startswith("/api/zhiying/generate"):
                body = self._read_body()
                if body is _BODY_TOO_LARGE:
                    return
                return self.zhiying_generate(body)
            if self.path.startswith(DH_PREFIX):
                body = self._read_body(default=None)
                if body is _BODY_TOO_LARGE:
                    return
                return self.proxy_dh(self._dh_provider(), body)
            if self.path.split("?")[0] == "/api/tts":
                body = self._read_body()
                if body is _BODY_TOO_LARGE:
                    return
                return self.tts_proxy(body)
            if self.path.split("?")[0] == "/api/config":
                body = self._read_body()
                if body is _BODY_TOO_LARGE:
                    return
                try:
                    incoming = json.loads(body or b"{}")
                except Exception as e:
                    return self._json(400, {"error": {"message": "无效 JSON：" + str(e)}})
                code, obj = save_config(incoming)
                return self._json(code, obj)
            self.send_error(405)
        finally:
            self._release()

    # ---- 前端 API 配置（GET 返回当前配置，供跨端口/重启恢复）----
    def get_config(self):
        return self._json(200, CONFIG)

    # ---- HeyGen 透明转发（注入 x-api-key；host 固定，仅校验路径防穿越）----
    def proxy(self, body=None):
        key = self.headers.get("x-api-key") or KEYS.get("heygen")
        try:
            status, headers, body = heygen_proxy(self.path, self.command, body, api_key=key)
            self._send_proxy_result(status, headers, body)
        except ValueError as e:                       # 响应超限 / 路径非法 / host 禁用
            self._safe_json(502, {"error": {"message": str(e)}})
        except urllib.error.URLError as e:
            self._safe_json(502, {"error": {"message": _net_msg(e)}})
        except Exception as e:
            self._safe_json(502, {"error": {"message": str(e)}})

    # ---- 大模型代理（endpoint 仅来自服务端配置，规避 SSRF / 开放代理）----
    def proxy_llm(self, body):
        # SEC：endpoint 必须来自服务端配置或环境变量，绝不可由客户端请求头指定
        endpoint = os.environ.get("LLM_ENDPOINT") or CONFIG.get("llmEndpoint")
        if not endpoint:
            return self._json(400, {"error": {"message":
                "服务端未配置大模型 endpoint（请在设置面板填写，将持久化到服务端 xiaoya_config.json）"}})
        try:
            endpoint = _safe_llm_endpoint(endpoint)
        except ValueError as e:
            return self._json(400, {"error": {"message": "endpoint 未通过安全校验：" + str(e)}})
        # 密钥优先取服务端配置（llmKey），前端 x-llm-key 头仍可作为便捷覆盖
        key = CONFIG.get("llmKey") or self.headers.get("x-llm-key")
        hdrs = {"Content-Type": JSON_CONTENT_TYPE}
        if key:
            hdrs["Authorization"] = "Bearer " + key
        try:
            status, headers, body = _proxy_upstream("POST", endpoint, body=body, headers=hdrs)
            self._send_proxy_result(status, headers, body)
        except ValueError as e:                       # 响应超限
            self._safe_json(502, {"error": {"message": str(e)}})
        except urllib.error.URLError as e:
            self._safe_json(502, {"error": {"message": _net_msg(e)}})
        except Exception as e:
            self._safe_json(502, {"error": {"message": str(e)}})

    # ---- 统一数字人代理 /api/dh/<provider>[/sub...]（REQ-MM-03 多供应商同构）----
    def _dh_provider(self):
        # /api/dh/<provider>[/sub...] -> provider
        rest = self.path[len(DH_PREFIX):]
        if not rest.startswith("/"):
            return ""
        return rest[1:].split("/", 1)[0]

    def proxy_dh(self, provider, body):
        provider = (provider or "").strip().lower()
        if not provider:
            return self._json(400, {"error": {"message": "缺少数字人供应商（/api/dh/<provider>）"}})
        if provider == "local":
            # 本地动画数字人由前端 SVG 处理，不发网络请求，无服务端路由
            return self._json(400, {"error": {"message": "本地数字人由前端 SVG 处理，无服务端路由"}})
        if provider == "zhiying":
            # 子路径 /api/dh/zhiying/status?video_id= -> 状态查询；其余 -> 生成
            sub = self.path[len(DH_PREFIX + "/zhiying"):]
            if sub.startswith("/status"):
                return self.zhiying_status()
            return self.zhiying_generate(body)
        if provider == "heygen":
            # 把 /api/dh/heygen/<sub> 转发到 HEYGEN_HOST + /<sub>（复用既有 SSRF 加固代理）
            saved = self.path
            try:
                sub = self.path[len(DH_PREFIX + "/heygen"):]
                if not sub.startswith("/"):
                    sub = "/" + sub
                self.path = HEYGEN_API_PREFIX + sub
                return self.proxy(body)
            finally:
                self.path = saved
        if provider == "guiji":
            # 硅基后端未实现（悬空），明确 501 而非静默 404
            return self._json(501, {"error": {"message": "数字人后端 guiji 未实现（后端悬空）"}})
        return self._json(404, {"error": {"message": "未知数字人供应商：" + provider}})

    # ---- 神经语音代理 POST /api/tts（与 /api/llm 同构，endpoint 仅服务端 + SSRF 加固）----
    def tts_proxy(self, body):
        # SEC：endpoint 必须来自服务端配置或环境变量，绝不可由客户端请求头指定
        endpoint = os.environ.get("TTS_ENDPOINT") or CONFIG.get("ttsEndpoint")
        if not endpoint:
            return self._json(400, {"error": {"message":
                "服务端未配置 TTS endpoint（请在设置面板填写 ttsEndpoint，将持久化到服务端 xiaoya_config.json）"}})
        try:
            endpoint = _safe_target(endpoint)
        except ValueError as e:
            return self._json(400, {"error": {"message": "TTS endpoint 未通过安全校验：" + str(e)}})
        key = CONFIG.get("ttsKey") or self.headers.get("x-tts-key")
        hdrs = {"Content-Type": JSON_CONTENT_TYPE}
        if key:
            hdrs["Authorization"] = "Bearer " + key
        try:
            status, headers, body = _proxy_upstream("POST", endpoint, body=body, headers=hdrs)
            self._send_proxy_result(status, headers, body)
        except ValueError as e:                       # 响应超限
            self._safe_json(502, {"error": {"message": str(e)}})
        except urllib.error.URLError as e:
            self._safe_json(502, {"error": {"message": _net_msg(e)}})
        except Exception as e:
            self._safe_json(502, {"error": {"message": str(e)}})

    # ---- 腾讯智影 / 数智人 ----
    def zhiying_generate(self, body):
        try:
            data = json.loads(body or b"{}")
            text = data.get("text", "")
            avatar = data.get("avatar", "")
            voice = data.get("voice", "")
            self._json(200, zhiying_create(text, avatar, voice))
        except Exception as e:
            self._json(200, {"error": {"message": str(e)}})

    def zhiying_status(self):
        q = self.path.split("?", 1)[1] if "?" in self.path else ""
        vid = {k: v for x in q.split("&") if "=" in x for k, v in [x.split("=", 1)]}.get("video_id", "")
        try:
            self._json(200, zhiying_describe(vid))
        except Exception as e:
            self._json(200, {"error": {"message": str(e)}})

    def _acquire(self):
        if not _REQ_SEMA.acquire(timeout=0.05):
            self._safe_json(503, {"error": {"message": "服务繁忙，请稍后重试（并发上限 %d）" % _MAX_CONCURRENT}})
            return False
        return True

    def _release(self):
        try:
            _REQ_SEMA.release()
        except Exception:
            pass

    def end_headers(self):
        if getattr(self, "_static_req", False):
            self.send_header("Cache-Control", "public, max-age=300")
            self._static_req = False
        super().end_headers()

    def log_message(self, *args):
        pass  # 静默处理请求日志，避免刷屏式输出（生产环境由上游日志系统记录）


class QuietHTTPServer(ThreadingHTTPServer):
    # 提高 accept 队列深度，避免高并发下连接被拒（单线程时代的 request_queue_size=5 是瓶颈之一）
    request_queue_size = 256
    daemon_threads = True

    def handle_error(self, request, client_address):
        # 静默处理客户端断开等常见错误，避免刷屏式 traceback
        pass

if __name__ == "__main__":
    def port_free(p):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", p)); s.close(); return True
        except OSError:
            return False
    actual_port = PORT
    while actual_port < PORT + 10:
        if port_free(actual_port):
            break
        print(f"[提示] 端口 {actual_port} 被占用，尝试 {actual_port + 1} ...")
        actual_port += 1
    else:
        print(f"[错误] 端口 {PORT}~{PORT + 9} 均被占用，无法启动。请关闭占用程序后重试。")
        sys.exit(1)
    print(f"静态服务 + HeyGen/腾讯智影 代理 已启动: http://127.0.0.1:{actual_port}")
    if not KEYS.get("heygen"):
        print("[提示] 服务端 HEYGEN_API_KEY / keys.json 未配置（可选）。若已在应用设置面板填写 HeyGen Key，将通过前端请求头正常调用，无需此项。")
    if not (KEYS.get("zhiying_secret_id") and KEYS.get("zhiying_secret_key")):
        print("[提示] 服务端未配置腾讯云 SecretId/SecretKey（可选）。仅腾讯智影数字人需要；只用 HeyGen 则不受影响。")
    # 冻结成 exe 双击运行时，自动打开浏览器（python 直接运行时加 --open 也可）
    if getattr(sys, "frozen", False) or "--open" in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{actual_port}/index.html")).start()
    QuietHTTPServer(("127.0.0.1", actual_port), Handler).serve_forever()
