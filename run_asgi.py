# run_asgi.py - 赛博女友小雅（CodexQQSkin）ASGI 启动器
#
# 用 uvicorn 运行 app_asgi.app。关键：
#  - 直接传 app 对象（非 import 字符串），避免冻结后 importlib 解析失败。
#  - loop="asyncio"（避免 uvloop C 扩展在 onefile 下的兼容问题）、workers=1（不启多进程）。
import os

import uvicorn

import app_asgi

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(
        app_asgi.app,
        host="127.0.0.1",
        port=port,
        loop="asyncio",
        workers=1,
        log_level="warning",
    )
