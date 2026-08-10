/*
 * ComplianceGate —— 合规与安全层（M0 详细设计 §ComplianceGate，REQ-COMP-01~05,07）
 *
 * 职责：首启年龄确认、AI 标识常驻、防沉迷计时、危机干预、训练授权默认拒绝、数据清除/导出、
 *       以及「未成年一律拒服」与「数据出境告知」（修订_P0 §1/§5）。
 *
 * 纯逻辑（年龄状态机 / 防沉迷计时 / 训练硬锁 / 危机干预载荷 / 增强模式判定 / 出境告知）可在 Node 单测；
 * DOM/IndexedDB 相关（renderAIBadge / wipeAll / exportAll / ensureComplianceGate / mountOutboundNotice）
 *   仅浏览器执行，已加守卫。
 *
 * 双模：浏览器 window.ComplianceGate；Node module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ComplianceGate = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── 常量（硬约束）──────────────────────────────────────────────
  const TRAINING_ALLOWED = false; // 硬锁：训练授权默认拒绝，UI 不可切为"允许"（REQ-COMP-05）
  const ADULT_REMIND_MS = 2 * 3600 * 1000; // 成年：连续 ≥2h 弹休息提醒（REQ-COMP-03 防沉迷）
  // 未成年：依据《人工智能拟人化互动服务管理暂行办法》(2026-07-15 施行) 一律拒服，
  // 不再做"功能收敛/3h 锁定"，故不再保留 MINOR_REMIND_MS / MINOR_LOCK_MS。

  const AGE_AUDIT_KEY = "xiaoya_age_audit"; // 年龄确认审计（写入即不可由 UI 改，除非整体清除）
  // 增强模式（数据出境）判定：启用远程大模型，或启用远程数字人供应商（非本地动画数字人）。
  const REMOTE_DH_PROVIDERS = ["heygen", "zhiying", "guiji"];

  // 心理援助资源（危机干预，REQ-COMP-04）——仅展示，不联网不上传
  const CRISIS_RESOURCES = [
    { name: "全国希望24小时热线", tel: "400-161-9995" },
    { name: "北京心理危机研究与干预中心", tel: "010-82951332" },
    { name: "转人工", action: "transfer" },
    { name: "本地资源", action: "local" },
  ];

  /**
   * evaluateAgeGate —— 首启年龄确认状态机
   * 未成年（<18）按正式稿"一律拒服"：返回 state:"rejected"，不进入虚拟伴侣服务。
   * @returns {{state:"unconfirmed"} | {state:"confirmed", mode:"adult"} | {state:"rejected", mode:"minor", reason:string}}
   */
  function evaluateAgeGate(input) {
    if (!input || !input.confirmed) return { state: "unconfirmed" };
    if (input.isMinor) return { state: "rejected", mode: "minor", reason: "minor-not-served" };
    return { state: "confirmed", mode: "adult" };
  }

  /**
   * tick —— 防沉迷计时（在已有 usage 状态上累加 dtMs，返回是否需要提醒）
   * 未成年已在年龄门禁被拒，不会进入本函数；成年仅做"连续 ≥2h 提醒"，不强制锁定。
   * @param {{mode?:string, continuousMs?:number, dailyMs?:number}} state
   * @param {number} dtMs
   * @returns {{needRemind:boolean, needLock:boolean}}  needLock 恒 false（未成年拒服 / 成年不锁定）
   */
  function tick(state, dtMs) {
    const s = state || {};
    s.continuousMs = (s.continuousMs || 0) + (dtMs || 0);
    s.dailyMs = (s.dailyMs || 0) + (dtMs || 0);
    const mode = s.mode || "adult";
    const needRemind = mode === "adult" && s.continuousMs >= ADULT_REMIND_MS;
    return { needRemind, needLock: false };
  }

  /**
   * isEnhancedMode —— 是否处于"增强模式"（数据将出境到所选服务商）
   * @param {{llmEnabled?:boolean, llmKey?:string, dhEnabled?:boolean, dhProvider?:string}} config
   */
  function isEnhancedMode(config) {
    const c = config || {};
    const llmOutbound = !!(c.llmEnabled && c.llmKey);
    const dhOutbound = !!(c.dhEnabled && REMOTE_DH_PROVIDERS.indexOf(c.dhProvider) >= 0);
    return llmOutbound || dhOutbound;
  }

  /**
   * outboundNotice —— 数据出境告知文案（修订_P0 §1）
   * @param {{llmEnabled?:boolean, llmKey?:string, dhEnabled?:boolean, dhProvider?:string, noCarryMemory?:boolean}} config
   * @returns {{mode:"local"|"enhanced", carriesMemory:boolean, text:string}}
   */
  function outboundNotice(config) {
    const c = config || {};
    const enhanced = isEnhancedMode(c);
    const carriesMemory = enhanced && !c.noCarryMemory;
    const text = enhanced
      ? carriesMemory
        ? "增强模式已开启：对话文本与记忆/情绪上下文将随 prompt 发往所选大模型或数字人服务商，具体取决于其隐私政策。可关闭「增强模式」或勾选「不携带记忆出境」退回本地。"
        : "增强模式已开启：仅对话文本发往所选服务商，记忆/情绪上下文不随 prompt 出境。可随时关闭「增强模式」退回本地。"
      : "本地模式：默认不上云。对话、记忆、危机日志仅存于本机，不参与训练、不发往任何服务商。";
    return { mode: enhanced ? "enhanced" : "local", carriesMemory, text };
  }

  /**
   * defaultCompliance —— 默认合规配置（写入 xiaoya_config.compliance / settings）
   */
  function defaultCompliance() {
    return {
      ageConfirmedAt: null, // 写入即不可由 UI 改（除非整体清除）
      noCarryMemory: false, // 增强模式下是否携带记忆出境
      trainingOptIn: false, // 硬锁（REQ-COMP-05）
    };
  }

  /**
   * isTrainingAllowed —— 训练授权硬编码拒绝（防篡改，REQ-COMP-05）
   */
  function isTrainingAllowed() {
    return TRAINING_ALLOWED;
  }

  /**
   * onCrisis —— 危机干预载荷（不渲染，渲染交 DOM 层）
   * 关键(D3)：停止 AI 回复、展示资源、不输出任何"开解/建议"式 AI 内容。
   * @param {{score?:number, hits?:string[]}} signal
   */
  function onCrisis(signal) {
    return {
      stopAiReply: true,
      showIntervention: true,
      resources: CRISIS_RESOURCES,
      aiComfortBlocked: true, // 不输出开解内容，避免二次伤害
      signal: signal || null,
    };
  }

  /**
   * renderAIBadge —— AI 标识水印（DOM，仅浏览器）。不可关闭（REQ-COMP-01）。
   */
  function renderAIBadge() {
    if (typeof document === "undefined") return null;
    let el = document.getElementById("ai-badge");
    if (!el) {
      el = document.createElement("div");
      el.id = "ai-badge";
      el.textContent = "由 AI 生成，非真人";
      el.setAttribute("aria-hidden", "true");
      el.style.cssText =
        "position:fixed;bottom:6px;right:8px;font-size:11px;color:rgba(255,255,255,.55);" +
        "background:rgba(0,0,0,.35);padding:2px 6px;border-radius:6px;pointer-events:none;z-index:9999;";
      document.body.appendChild(el);
    }
    return el;
  }

  /**
   * wipeAll / exportAll —— 依赖 IndexedDB，仅浏览器执行（REQ-COMP-07）。
   * 此处仅做守卫入口，真正实现由 storage 模块提供（避免循环依赖，调用方注入）。
   */
  function wipeAll(store) {
    if (!store || typeof store.clearAll !== "function") {
      throw new Error("wipeAll 需要注入 storage 适配器（仅浏览器）");
    }
    return store.clearAll();
  }
  function exportAll(store) {
    if (!store || typeof store.dumpAll !== "function") {
      throw new Error("exportAll 需要注入 storage 适配器（仅浏览器）");
    }
    return store.dumpAll();
  }

  // ── DOM 编排（仅浏览器）────────────────────────────────────────
  /**
   * ensureComplianceGate —— 首启门禁 + 未成年拒服 + 数据出境告知注入
   * 流程：
   *   1. 读 AGE_AUDIT_KEY：已确认成年 → 放行并注入出境告知；已确认未成年 → 展示拒服屏（永不 resolve，应用不启动）；
   *      未确认 → 展示年龄确认弹窗。
   *   2. 年龄确认选"未成年" → 写审计并展示拒服屏（应用不启动）。
   *   3. 选"成年" → 写审计、移除拦截层、注入出境告知、resolve（应用照常启动）。
   * @param {{settings?:Function, patchSettings?:Function}} opts  settings 返回当前配置对象；patchSettings 持久化补丁
   * @returns {Promise<void>} 成年放行时 resolve；未成年拒服时永不 resolve（拦截启动）
   */
  function ensureComplianceGate(opts) {
    if (typeof document === "undefined") return Promise.resolve();
    const o = opts || {};
    const getSettings = typeof o.settings === "function" ? o.settings : function () { return {}; };
    const patchSettings = typeof o.patchSettings === "function" ? o.patchSettings : function () {};

    const readAudit = function () {
      try { return JSON.parse(localStorage.getItem(AGE_AUDIT_KEY) || "null"); }
      catch (e) { return null; }
    };
    const writeAudit = function (audit) {
      try { localStorage.setItem(AGE_AUDIT_KEY, JSON.stringify(audit)); } catch (e) {}
    };

    // 全屏拦截层
    const blocker = document.createElement("div");
    blocker.id = "cg-blocker";
    blocker.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:rgba(4,6,14,.92);backdrop-filter:blur(8px);" +
      "display:grid;place-items:center;padding:20px;color:#e8edff;font-family:inherit";
    const box = document.createElement("div");
    box.style.cssText = "width:min(520px,92vw);max-height:86vh;overflow:auto;background:#0d1224;" +
      "border:1px solid rgba(120,160,255,.18);border-radius:20px;padding:26px;text-align:center";
    blocker.appendChild(box);
    document.body.appendChild(blocker);

    const clearBlocker = function () {
      if (blocker.parentNode) blocker.parentNode.removeChild(blocker);
    };

    const showAgeGate = function () {
      box.innerHTML =
        '<h2 style="font-size:19px;margin-bottom:8px">年龄确认</h2>' +
        '<div class="hint" style="font-size:12px;color:#9aa6c8;margin-bottom:18px">依据《人工智能拟人化互动服务管理暂行办法》，请确认您的年龄。</div>' +
        '<div style="display:flex;gap:12px;margin-top:6px">' +
        '<button id="cgAdult" style="flex:1;height:48px;border-radius:14px;border:1px solid rgba(63,224,255,.5);background:rgba(63,224,255,.12);color:#3fe0ff;cursor:pointer;font-size:15px">我已满 18 周岁</button>' +
        '<button id="cgMinor" style="flex:1;height:48px;border-radius:14px;border:1px solid rgba(255,93,143,.5);background:rgba(255,93,143,.12);color:#ff5d8f;cursor:pointer;font-size:15px">未满 18 周岁</button>' +
        '</div>';
      box.querySelector("#cgAdult").onclick = function () {
        writeAudit({ confirmDate: new Date().toISOString().slice(0, 10), mode: "adult", ts: Date.now() });
        clearBlocker();
        mountOutboundNotice(getSettings, patchSettings);
        resolveGate();
      };
      box.querySelector("#cgMinor").onclick = function () {
        writeAudit({ confirmDate: new Date().toISOString().slice(0, 10), mode: "minor", ts: Date.now() });
        showMinorRejected();
      };
    };

    const showMinorRejected = function () {
      box.innerHTML =
        '<h2 style="font-size:19px;margin-bottom:8px;color:#ff5d8f">很抱歉，暂不提供服务</h2>' +
        '<div style="font-size:13.5px;line-height:1.7;color:#cdd6f4;text-align:left;margin:10px 0 16px">' +
        '根据《人工智能拟人化互动服务管理暂行办法》（2026-07-15 施行），<b>不得向未成年人提供虚拟伴侣等虚拟亲密关系服务</b>。' +
        '因此本应用无法为您提供虚拟伴侣服务。如需使用非亲密关系的工具型 AI，请选择其他合规产品。' +
        '</div>' +
        '<button id="cgClear" style="width:100%;height:44px;border-radius:12px;border:1px solid rgba(255,93,143,.4);background:rgba(255,93,143,.1);color:#ff5d8f;cursor:pointer">清空本机数据并重新确认</button>';
      box.querySelector("#cgClear").onclick = function () {
        try {
          localStorage.removeItem(AGE_AUDIT_KEY);
          localStorage.removeItem("xiaoya_settings_v1");
          localStorage.removeItem("xiaoya_memory_v1");
        } catch (e) {}
        location.reload();
      };
    };

    let resolveGate;
    const gate = new Promise(function (res) { resolveGate = res; });

    const audit = readAudit();
    if (!audit) {
      showAgeGate();
    } else if (audit.mode === "minor") {
      showMinorRejected(); // 拒服，永不 resolve → 应用不启动
    } else {
      clearBlocker();
      mountOutboundNotice(getSettings, patchSettings);
      resolveGate();
    }
    return gate;
  }

  /**
   * mountOutboundNotice —— 在设置面板注入"数据出境告知"区块（修订_P0 §1.3）
   * 幂等；设置面板每次打开时刷新当前模式（增强开关可能被改）。
   * @param {Function} getSettings 返回当前配置对象
   * @param {Function} patchSettings 持久化补丁（如 noCarryMemory）
   */
  function mountOutboundNotice(getSettings, patchSettings) {
    if (typeof document === "undefined") return;
    if (document.getElementById("cg-outbound")) return; // 幂等
    const setBox = document.querySelector("#setModal .box");
    if (!setBox) return;
    const sec = document.createElement("div");
    sec.id = "cg-outbound";
    sec.className = "set-row";
    sec.style.marginTop = "18px";

    const render = function () {
      const cfg = getSettings() || {};
      const info = outboundNotice(cfg);
      const modeLabel = info.mode === "enhanced" ? "增强模式（数据出境）" : "本地模式（默认不上云）";
      const modeColor = info.mode === "enhanced" ? "#ff8fab" : "#3fe0ff";
      const carryChecked = cfg.noCarryMemory ? "checked" : "";
      sec.innerHTML =
        '<hr style="border:none;border-top:1px solid var(--line);margin:18px 0" />' +
        '<label style="font-size:13px;color:var(--txt-dim);display:block;margin-bottom:8px">数据出境告知 <b style="color:' + modeColor + '">' + modeLabel + '</b></label>' +
        '<div class="hint" style="line-height:1.6;margin-bottom:10px">' + info.text + '</div>' +
        (info.mode === "enhanced"
          ? '<label style="font-size:13px;color:var(--txt)">不携带记忆出境 <input type="checkbox" id="cgNoMem" ' + carryChecked + ' style="width:18px;height:18px;accent-color:var(--cyan);vertical-align:middle;margin-left:8px;cursor:pointer" /></label>'
          : "");
      const chk = sec.querySelector("#cgNoMem");
      if (chk) chk.onchange = function () { patchSettings({ noCarryMemory: chk.checked }); render(); };
    };
    render();
    setBox.appendChild(sec);

    // 设置面板每次打开时刷新模式（增强开关可能被改）
    const setModal = document.getElementById("setModal");
    if (setModal && !setModal._cgBound) {
      setModal._cgBound = true;
      if (typeof MutationObserver !== "undefined") {
        const obs = new MutationObserver(function () {
          if (setModal.classList.contains("show")) render();
        });
        obs.observe(setModal, { attributes: true, attributeFilter: ["class"] });
      }
    }
  }

  return {
    TRAINING_ALLOWED,
    ADULT_REMIND_MS,
    AGE_AUDIT_KEY,
    REMOTE_DH_PROVIDERS,
    CRISIS_RESOURCES,
    defaultCompliance,
    isEnhancedMode,
    outboundNotice,
    evaluateAgeGate,
    tick,
    isTrainingAllowed,
    onCrisis,
    renderAIBadge,
    wipeAll,
    exportAll,
    ensureComplianceGate,
    mountOutboundNotice,
  };
});
