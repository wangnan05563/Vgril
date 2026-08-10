# app_asgi.py - 赛博女友小雅（CodexQQSkin）ASGI 入口（FastAPI）
#
# 设计原则：
#  - 安全/代理/配置引擎完全复用 server.py 的模块级函数（_safe_target/_proxy_upstream/
#    heygen_proxy/zhiying_*/save_config/CONFIG 等），不在本文件重写 D2 SSRF 逻辑，避免分叉。
#  - 仅重写「HTTP 请求→出站代理→HTTP 响应」的胶水层，适配 FastAPI/Starlette。
#  - 与 server.py 行为对齐：并发信号量 503 fail-fast、CORS、静态 Cache-Control、路径穿越防护。
import os
import json
import urllib.error

import server  # 复用所有 stdlib 安全/代理助手（纯标准库，导入安全）
from fastapi import FastAPI, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="CodexQQSkin")


# ---------------- 响应辅助 ----------------

def _json(status, obj):
    return Response(
        content=json.dumps(obj, ensure_ascii=False).encode("utf-8"),
        status_code=status,
        media_type=server.JSON_CONTENT_TYPE,
    )


def _err(status, msg):
    return _json(status, {"error": {"message": msg}})


def _proxy_resp(status, headers, body):
    ct = headers.get("content-type") or server.JSON_CONTENT_TYPE
    return Response(content=body, status_code=status, media_type=ct)


def _body_too_large():
    return _err(413, "请求体过大")


# ---------------- 中间件：并发闸 + CORS + 静态缓存 ----------------

@app.middleware("http")
async def gate(request: Request, call_next):
    # 并发信号量（非阻塞获取，避免阻塞事件循环）；超限快速 503
    if not server._REQ_SEMA.acquire(False):
        return _err(503, "服务繁忙，请稍后重试（并发上限 %d）" % server._MAX_CONCURRENT)
    try:
        resp = await call_next(request)
    finally:
        server._REQ_SEMA.release()
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    # 静态资源缓存（与 server.py end_headers 对齐）
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "public, max-age=300"
    return resp


# ---------------- API 路由（复用 server 引擎）----------------

@app.get("/api/config")
async def api_config_get():
    return server.CONFIG


@app.post("/api/config")
async def api_config_post(request: Request):
    body = await request.body()
    if len(body) > server.MAX_REQUEST_BODY:
        return _body_too_large()
    try:
        incoming = json.loads(body or b"{}")
    except Exception as e:
        return _err(400, "无效 JSON：" + str(e))
    code, obj = server.save_config(incoming)
    return _json(code, obj)


def _upstream_json(endpoint, request, body, key_header, default_key):
    """通用出站代理：endpoint 仅服务端配置 + SSRF 校验 + 透传音频二进制。"""
    if not endpoint:
        return _err(400, default_key)
    try:
        endpoint = server._safe_target(endpoint) if key_header == "x-tts-key" else server._safe_llm_endpoint(endpoint)
    except ValueError as e:
        return _err(400, "endpoint 未通过安全校验：" + str(e))
    key = server.CONFIG.get(key_header) or request.headers.get(key_header)
    hdrs = {"Content-Type": server.JSON_CONTENT_TYPE}
    if key:
        hdrs["Authorization"] = "Bearer " + key
    try:
        status, headers, b = server._proxy_upstream("POST", endpoint, body=body, headers=hdrs)
        return _proxy_resp(status, headers, b)
    except ValueError as e:                       # 响应超限
        return _err(502, str(e))
    except urllib.error.URLError as e:
        return _err(502, server._net_msg(e))
    except Exception as e:
        return _err(502, str(e))


@app.post("/api/llm")
async def api_llm(request: Request):
    body = await request.body()
    if len(body) > server.MAX_REQUEST_BODY:
        return _body_too_large()
    endpoint = os.environ.get("LLM_ENDPOINT") or server.CONFIG.get("llmEndpoint")
    return _upstream_json(
        endpoint, request, body, "x-llm-key",
        "服务端未配置大模型 endpoint（请在设置面板填写，将持久化到服务端 xiaoya_config.json）",
    )


@app.post("/api/tts")
async def api_tts(request: Request):
    body = await request.body()
    if len(body) > server.MAX_REQUEST_BODY:
        return _body_too_large()
    endpoint = os.environ.get("TTS_ENDPOINT") or server.CONFIG.get("ttsEndpoint")
    return _upstream_json(
        endpoint, request, body, "x-tts-key",
        "服务端未配置 TTS endpoint（请在设置面板填写 ttsEndpoint，将持久化到服务端 xiaoya_config.json）",
    )


@app.api_route("/api/heygen{path:path}", methods=["GET", "POST"])
async def api_heygen(path: str, request: Request):
    method = request.method
    body = await request.body()
    if method == "POST" and len(body) > server.MAX_REQUEST_BODY:
        return _body_too_large()
    key = request.headers.get("x-api-key") or server.KEYS.get("heygen")
    try:
        status, headers, b = server.heygen_proxy(
            request.url.path, method, body if method == "POST" else None, api_key=key
        )
        return _proxy_resp(status, headers, b)
    except ValueError as e:                       # 路径非法 / host 禁用 / 响应超限
        return _err(502, str(e))
    except urllib.error.URLError as e:
        return _err(502, server._net_msg(e))
    except Exception as e:
        return _err(502, str(e))


def _video_id_of(request):
    q = request.url.query
    return {k: v for x in q.split("&") if "=" in x for k, v in [x.split("=", 1)]}.get("video_id", "")


@app.get("/api/zhiying/status")
async def api_zhiying_status(request: Request):
    try:
        return _json(200, server.zhiying_describe(_video_id_of(request)))
    except Exception as e:
        return _json(200, {"error": {"message": str(e)}})


@app.post("/api/zhiying/generate")
async def api_zhiying_generate(request: Request):
    body = await request.body()
    if len(body) > server.MAX_REQUEST_BODY:
        return _body_too_large()
    try:
        data = json.loads(body or b"{}")
        return _json(200, server.zhiying_create(
            data.get("text", ""), data.get("avatar", ""), data.get("voice", "")))
    except Exception as e:
        return _json(200, {"error": {"message": str(e)}})


@app.api_route("/api/dh/{provider:path}", methods=["GET", "POST"])
async def api_dh(provider: str, request: Request):
    method = request.method
    body = await request.body()
    if method == "POST" and len(body) > server.MAX_REQUEST_BODY:
        return _body_too_large()
    key = request.headers.get("x-api-key") or server.KEYS.get("heygen")
    # /api/dh/<provider>[/sub...] -> 解析 provider 与子路径
    rest = request.url.path[len(server.DH_PREFIX):].strip("/")
    seg = rest.split("/", 1)
    prov = seg[0]
    sub = "/" + seg[1] if len(seg) > 1 else ""
    if not prov:
        return _err(400, "缺少数字人供应商（/api/dh/<provider>）")
    if prov == "local":
        return _err(400, "本地数字人由前端 SVG 处理，无服务端路由")
    if prov == "zhiying":
        if sub.startswith("/status"):
            try:
                return _json(200, server.zhiying_describe(_video_id_of(request)))
            except Exception as e:
                return _json(200, {"error": {"message": str(e)}})
        try:
            data = json.loads(body or b"{}")
            return _json(200, server.zhiying_create(
                data.get("text", ""), data.get("avatar", ""), data.get("voice", "")))
        except Exception as e:
            return _json(200, {"error": {"message": str(e)}})
    if prov == "heygen":
        try:
            status, headers, b = server.heygen_proxy(
                server.HEYGEN_API_PREFIX + sub, method, body if method == "POST" else None, api_key=key)
            return _proxy_resp(status, headers, b)
        except ValueError as e:
            return _err(502, str(e))
        except urllib.error.URLError as e:
            return _err(502, server._net_msg(e))
        except Exception as e:
            return _err(502, str(e))
    if prov == "guiji":
        return _err(501, "数字人后端 guiji 未实现（后端悬空）")
    return _err(404, "未知数字人供应商：" + prov)


# ---------------- CORS 预检（OPTIONS 全局 204）----------------

@app.options("/{full_path:path}")
async def options_handler(full_path: str):
    return Response(status_code=204)


# ---------------- 未知 /api 路径：JSON 404（注册于静态挂载之前）----------------

@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def api_catchall(path: str):
    return _err(404, "未知 API 路径：/api/" + path)


# ---------------- 静态资源（最后挂载，SPA 回退 index.html）----------------

app.mount("/", StaticFiles(directory=server.HERE, html=True), name="static")
