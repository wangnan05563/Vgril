#!/usr/bin/env python3
# check_config_integrity.py - 校验高并发 POST /api/config 后的配置完整性
# 用法: python check_config_integrity.py
# 重点验证: 并发写共享 .tmp 路径是否导致 JSON 撕裂 / 关键字段丢失。
import os, json, glob

CFG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "xiaoya_config.json")
EXPECT_KEYS = ["dhKey", "llmEnabled", "dhEnabled", "dhProvider", "dhAvatar", "dhVoice",
               "llmEndpoint", "llmKey", "llmModel", "llmSystem", "compliance"]


def main():
    print("=== config integrity check ===")
    # 1) 遗留 .tmp
    tmp = CFG + ".tmp"
    print("lingering .tmp exists:", os.path.exists(tmp))
    # 2) 主文件可解析?
    try:
        with open(CFG, encoding="utf-8") as f:
            raw = f.read()
        cfg = json.loads(raw)
        print("xiaoya_config.json: VALID JSON, bytes=", len(raw))
    except Exception as e:
        print("xiaoya_config.json: CORRUPTED JSON ->", e)
        print("RESULT: FAIL (torn write)")
        return
    # 3) 关键字段
    missing = [k for k in EXPECT_KEYS if k not in cfg]
    print("missing keys:", missing if missing else "none")
    print("llmModel =", cfg.get("llmModel"))
    print("llmKey present:", "llmKey" in cfg and bool(cfg.get("llmKey")))
    # 4) 判定
    if missing:
        print("RESULT: FAIL (lost keys under concurrency: %s)" % missing)
    elif not cfg.get("llmKey"):
        print("RESULT: FAIL (llmKey lost)")
    else:
        print("RESULT: OK (valid + complete; last-writer-wins observed, llmModel=%s)" % cfg.get("llmModel"))


if __name__ == "__main__":
    main()
