/*
 * 赛博女友「小雅」(CodexQQSkin) — 数字人子系统 DigitalHuman
 * 对应：REQ-MM-01（生成）/ REQ-MM-02（≤3s 降级）/ REQ-MM-03（多供应商可切换）/ REQ-MM-04（口型脉冲近似）
 * 双模：浏览器 window.DigitalHuman；Node module.exports（纯逻辑可单测）
 *
 * 衔接契约（见《详细设计_M1》§7 + §0 安全约束）：
 *  - D1 隐私边界：仅当前轮文本经 /api/dh/<provider> 出境，绝不携带记忆/情绪/关系上下文（同源 LLM/TTS 约束）。
 *  - D2 SSRF：provider 来自服务端配置白名单；dhTransport 外层注入，本模块不拼 URL、不接收用户任意 host。
 *  - REQ-MM-03：多供应商统一前端接口；厂商请求体差异在 /api/dh/<provider> 代理内消化（前端不感知字段差）。
 *  - REQ-MM-02：生成硬限时 API_TIMEOUT=3000ms；超时/限流/网络错 → fallbackCSS（呼吸 + 口型脉冲近似）。
 *  - D7 修订：fallbackCSS 以 "口型脉冲近似" 呈现，UI 如实标注，不宣称真实唇形同步。
 *  - REQ-COMP-01：speak 入口统一挂 renderAIBadge（"由 AI 生成，非真人"水印）。
 */
(function (global) {
  'use strict';

  // 供应商白名单（与 server.py /api/dh/<provider> 路由对齐；不可由前端任意扩展）
  // local 为纯前端 SVG 本地动画数字人（免费/离线/零延迟），不发网络请求，仅作 fallback 来源
  var DEFAULT_PROVIDERS = ['zhiying', 'heygen', 'guiji', 'local'];

  var API_TIMEOUT = 3000; // ≤3s 降级硬限（REQ-MM-02）

  // ---- 纯函数 ----

  // Promise 超时包裹：超时抛 Error('timeout')
  function withTimeout(promise, ms) {
    ms = ms || API_TIMEOUT;
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  // 错误分类：决定降级路径与提示文案（纯函数，便于单测）
  function classifyError(err) {
    if (!err) return 'unknown';
    var m = String(err.message || err).toLowerCase();
    if (m.indexOf('timeout') !== -1 || m.indexOf('abort') !== -1) return 'timeout';
    if (m.indexOf('429') !== -1 || m.indexOf('rate') !== -1 || m.indexOf('limit') !== -1) return 'rate_limit';
    if (m.indexOf('network') !== -1 || m.indexOf('fetch') !== -1 ||
        m.indexOf('econn') !== -1 || m.indexOf('enotfound') !== -1 || m.indexOf('unreachable') !== -1) return 'network';
    return 'unknown';
  }

  // 校验 provider 是否在白名单（REQ-MM-03 防任意供应商注入）
  function isValidProvider(provider, list) {
    list = list || DEFAULT_PROVIDERS;
    return list.indexOf(provider) !== -1;
  }

  // 口型脉冲近似参数：依据文本长度估算口播时长与开合周期（非真实唇形同步）
  function computeLipPulse(text) {
    var len = (text || '').replace(/\s+/g, '').length;
    var reading = Math.max(400, Math.min(8000, len * 180)); // 朗读总时长 ms
    var period = 220;                                       // 单次开合周期 ms
    return { durationMs: reading, periodMs: period, label: '口型脉冲近似（非真实唇形同步）' };
  }

  // ---- DigitalHuman 类（副作用经 opts 注入）----
  function DigitalHuman(opts) {
    opts = opts || {};
    this.providers = opts.providers || DEFAULT_PROVIDERS.slice();
    this.current = opts.current || this.providers[0];
    this.dhTransport = opts.dhTransport || null; // async (provider, text) => videoUrl
    this.config = opts.config || null;           // { save: (patch)=>Promise }
    this.aiBadgeHook = opts.aiBadgeHook || (typeof window !== 'undefined' ? null : null);
    this.uiToastHook = opts.uiToastHook || null; // (msg) => void
    this.hooks = opts.hooks || {};               // { onPlayVideo, onFallback }
  }

  DigitalHuman.prototype.provider = function () { return this.current; };

  // REQ-MM-03 切换供应商（白名单校验）
  DigitalHuman.prototype.switch = function (provider) {
    if (!isValidProvider(provider, this.providers)) {
      throw new Error('unknown provider: ' + provider);
    }
    this.current = provider;
    if (this.config && typeof this.config.save === 'function') {
      return Promise.resolve(this.config.save({ digitalHuman: { provider: provider } }));
    }
    return Promise.resolve(true);
  };

  // REQ-MM-01/02/04 生成；超时/限流/网络错 → 降级 fallbackCSS
  DigitalHuman.prototype.speak = function (text) {
    var self = this;
    if (this.aiBadgeHook) this.aiBadgeHook('digitalhuman'); // REQ-COMP-01
    // 本地动画数字人：纯前端 SVG + 口型脉冲，零延迟、离线、免费（不请求网络）
    if (this.current === 'local') {
      this.fallbackCSS(text);
      return Promise.resolve({ mode: 'fallback', reason: 'local' });
    }
    if (this.dhTransport && this.current) {
      return withTimeout(this.dhTransport(this.current, text), API_TIMEOUT)
        .then(function (video) {
          if (self.hooks.onPlayVideo) self.hooks.onPlayVideo(video, text);
          return { mode: 'provider', provider: self.current, video: video };
        })
        .catch(function (err) {
          var kind = classifyError(err);
          self.fallbackCSS(text);
          if (self.uiToastHook) {
            self.uiToastHook('数字人视频暂不可用（' + kind + '），已切换为本地形象');
          }
          return { mode: 'fallback', reason: kind };
        });
    }
    // 无网络 / 无传输能力 → 全程本地降级
    this.fallbackCSS(text);
    if (this.uiToastHook) this.uiToastHook('数字人视频暂不可用，已切换为本地形象');
    return Promise.resolve({ mode: 'fallback', reason: 'offline' });
  };

  // REQ-MM-02/04 本地降级：呼吸 + 口型脉冲近似（驱动参数供 UI 动画使用）
  DigitalHuman.prototype.fallbackCSS = function (text) {
    var pulse = computeLipPulse(text);
    if (this.hooks.onFallback) this.hooks.onFallback(text, pulse);
    return pulse;
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DEFAULT_PROVIDERS: DEFAULT_PROVIDERS,
      API_TIMEOUT: API_TIMEOUT,
      withTimeout: withTimeout,
      classifyError: classifyError,
      isValidProvider: isValidProvider,
      computeLipPulse: computeLipPulse,
      DigitalHuman: DigitalHuman
    };
  } else {
    global.DigitalHuman = DigitalHuman;
    global.XiaoyaDH = {
      DEFAULT_PROVIDERS: DEFAULT_PROVIDERS,
      API_TIMEOUT: API_TIMEOUT,
      withTimeout: withTimeout,
      classifyError: classifyError,
      isValidProvider: isValidProvider,
      computeLipPulse: computeLipPulse,
      DigitalHuman: DigitalHuman
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
