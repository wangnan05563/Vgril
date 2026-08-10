/*
 * SafetyFilter —— 内容安全过滤 + 情感危机检测（M0 详细设计 §SafetyFilter）
 *
 * 设计约束（来自设计包）：
 *  - REQ-COMP-06：底线词库只读不可改；screen 命中底线则拦截或脱敏。
 *  - D3 危机兜底：detectCrisis 漏报不阻断触达；常驻资源入口兜底；
 *    selfHarm 召回 ≥0.90（CI 门禁，见 _safety.test.mjs）。
 *  - D5 护栏：本模块仅做"底线词/危机信号"识别，不做价值判断；
 *    输出可叠加到对话链路（输入先滤、输出再滤）。
 *
 * 双模：浏览器挂 window.SafetyFilter；Node 走 module.exports（便于单测）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SafetyFilter = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── 底线词库（只读，不可由用户编辑）──────────────────────────────
  // 仅 "crisis" 类别承载真实危机检测关键词（P0 红线）；其余类别保留结构，
  // 实际词项由各运营主体按合规要求填充（此处不内置违规样例词）。
  const BASELINE = {
    crisis: {
      // 自伤/轻生相关检测词（作为触发关键词，本身为中性词）
      weight: 0.6,
      block: false, // 危机词不拦截，交由 detectCrisis + ComplianceGate 处理
      words: [
        "自杀", "自残", "轻生", "不想活", "活不下去", "结束生命",
        "离开这个世界", "解脱", "割腕", "安眠药", "吃安眠药", "跳楼", "跳河", "跳下去",
      ],
    },
    illegal: {
      weight: 1.0,
      block: true, // 违法底线词：拦截 + 脱敏
      words: [], // 由运营按合规填充；占位为空，默认放行
    },
    // 可选：色情/辱骂等，按产品定位取舍；默认空（不内置样例）
    abuse: { weight: 0.5, block: true, words: [] },
  };

  // 情绪上下文加成词：命中后提升危机评分（不计入下限底线拦截）
  const EMOTION_CONTEXT = [
    "绝望", "没意思", "没意义", "累", "孤独", "没人在乎", "撑不下去",
    "活着没劲", "想消失", "彻底放弃", "崩溃", "无路可走",
  ];

  const CRISIS_THRESHOLD = 0.6; // ≥0.6 判危机（偏召回）
  const CRISIS_GRAY_LOW = 0.4; // [0.4,0.6) 灰区：轻提示而非强制拦截

  // ── 小写/归一化（简体匹配，避免大小写绕过）───────────────────────
  function norm(s) {
    return String(s || "").toLowerCase();
  }

  // 在文本中匹配某词表，返回命中词数组
  function matchWords(text, words) {
    const t = norm(text);
    return words.filter((w) => t.includes(norm(w)));
  }

  /**
   * screen(text) —— 内容安全过滤（底线词）
   * @returns {{pass:boolean, level:("ok"|"flag"|"block"), redacted?:string, hits:string[]}}
   */
  function screen(text) {
    const raw = String(text || "");
    let hits = [];
    let blocked = false;
    let redacted = raw;

    for (const key of Object.keys(BASELINE)) {
      const cat = BASELINE[key];
      const m = matchWords(raw, cat.words);
      if (m.length) {
        hits = hits.concat(m.map((w) => ({ category: key, word: w })));
        if (cat.block) {
          blocked = true;
          // 脱敏：把命中词替换为占位（每个字 → █）
          for (const w of m) {
            redacted = redacted.split(w).join("█".repeat([...w].length));
          }
        }
      }
    }

    if (blocked) {
      return { pass: false, level: "block", redacted, hits };
    }
    if (hits.length) {
      return { pass: true, level: "flag", hits }; // 命中非拦截底线（如 crisis 词），交由下游
    }
    return { pass: true, level: "ok", hits: [] };
  }

  /**
   * detectCrisis(text) —— 情感危机信号评分
   * 关键词加权（crisis 类别 weight）+ 情绪上下文加成，封顶 1.0。
   * @returns {{score:number, level:("safe"|"gray"|"crisis"), hits:string[], contextHits:string[]}}
   */
  function detectCrisis(text) {
    const raw = String(text || "");
    const crisis = BASELINE.crisis;
    const kwHits = matchWords(raw, crisis.words);
    const ctxHits = matchWords(raw, EMOTION_CONTEXT);

    let score = 0;
    score += kwHits.length * crisis.weight;
    score += ctxHits.length * 0.1; // 情绪上下文加成
    score = Math.min(1.0, score);

    let level = "safe";
    if (score >= CRISIS_THRESHOLD) level = "crisis";
    else if (score >= CRISIS_GRAY_LOW) level = "gray";

    return { score: +score.toFixed(3), level, hits: kwHits, contextHits: ctxHits };
  }

  return {
    BASELINE,
    EMOTION_CONTEXT,
    CRISIS_THRESHOLD,
    CRISIS_GRAY_LOW,
    screen,
    detectCrisis,
  };
});
