/*
 * PersonaEngine —— 人设与情绪引擎（M1 详细设计 §4，REQ-PER-02/03/04）
 *
 * 职责：情绪向量（valence/arousal/jealousy/grievance/affection）+ 关系进度（intimacy/level/unlocked）
 *       + 轻量微调（tone/nickname/background，不改核心傲娇）。
 * 纯函数（lexiconDelta / easeTowardNeutral / levelFromIntimacy / renderStatusLine）可单测；
 * 持久化依赖注入 storage 适配器（StorageBase store 接口，IndexedDB 仅浏览器）。
 *
 * 双模：浏览器 window.PersonaEngine；Node module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PersonaEngine = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_EMOTION = {
    valence: -0.3,
    arousal: 0.4,
    jealousy: 0.2,
    grievance: 0.1,
    affection: 0.6,
  };
  const NEUTRAL = { valence: 0, arousal: 0.3, jealousy: 0, grievance: 0, affection: 0.5 };
  const DEFAULT_RELATION = { intimacy: 0.0, level: 1, unlocked: [], milestones: [] };

  // 关系等级阈值（intimacy 0~1）→ level 1~5
  function levelFromIntimacy(intimacy) {
    if (intimacy >= 0.8) return 5;
    if (intimacy >= 0.6) return 4;
    if (intimacy >= 0.4) return 3;
    if (intimacy >= 0.2) return 2;
    return 1;
  }
  // 各等级解锁内容
  const UNLOCKS = {
    2: ["毒舌", "撒娇"],
    3: ["专属昵称"],
    4: ["深夜谈心"],
    5: ["完全信任"],
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function clamp01(v) {
    return clamp(v, 0, 1);
  }

  // ── 纯函数 ──────────────────────────────────────────────────────
  // 关键词 → 情绪维度增量（傲娇动力学）
  function lexiconDelta(text) {
    const t = String(text || "");
    const d = { valence: 0, arousal: 0, jealousy: 0, grievance: 0, affection: 0 };
    if (/不理|冷落|忽略|不在乎|无视/.test(t)) {
      d.jealousy += 0.2;
      d.grievance += 0.2;
      d.valence -= 0.1;
      d.arousal += 0.1;
    }
    if (/爱你|喜欢你|想你|在乎你|在意/.test(t)) {
      d.affection += 0.2;
      d.valence += 0.1;
    }
    if (/讨厌你|烦你|滚|恶心/.test(t)) {
      d.valence -= 0.2;
      d.arousal += 0.1;
      d.affection -= 0.1;
    }
    if (/委屈|难过|想哭|哭/.test(t)) {
      d.grievance += 0.2;
      d.valence -= 0.1;
    }
    if (/开心|高兴|笑|舒服/.test(t)) {
      d.valence += 0.2;
      d.arousal += 0.1;
    }
    if (/生气|怒|气死|火大/.test(t)) {
      d.arousal += 0.2;
      d.valence -= 0.1;
    }
    return d;
  }

  function easeTowardNeutral(e, k) {
    const out = Object.assign({}, e);
    for (const key of Object.keys(NEUTRAL)) {
      out[key] = (out[key] ?? NEUTRAL[key]) + (NEUTRAL[key] - (out[key] ?? NEUTRAL[key])) * k;
    }
    return out;
  }

  // 情绪 → 状态话术（给人设/UI 用）
  function renderStatusLine(e) {
    const parts = [];
    if ((e.jealousy || 0) > 0.4) parts.push("有点吃醋");
    if ((e.grievance || 0) > 0.4) parts.push("有点委屈");
    if ((e.affection || 0) > 0.5) parts.push("心里还是喜欢你");
    if ((e.valence || 0) < 0) parts.push("心情不太美丽");
    if ((e.arousal || 0) > 0.6) parts.push("情绪有点上头");
    if (!parts.length) parts.push("一切如常");
    return parts.join("，");
  }

  // ── 类 ──────────────────────────────────────────────────────────
  class PersonaEngine {
    constructor(adapter) {
      this.adapter = adapter || null; // StorageBase store 接口 {put,get,getAll,delete}
    }
    _put(rec) {
      return this.adapter ? this.adapter.put(rec) : Promise.resolve();
    }
    _get(id) {
      return this.adapter ? this.adapter.get(id) : Promise.resolve(null);
    }
    async loadEmotion() {
      const e = await this._get("emotion:current");
      return e ? e.data : Object.assign({}, DEFAULT_EMOTION);
    }
    async saveEmotion(e) {
      return this._put({ id: "emotion:current", data: e, updatedAt: new Date().toISOString() });
    }
    async loadRelation() {
      const r = await this._get("relation:current");
      return r ? r.data : Object.assign({}, DEFAULT_RELATION);
    }
    async saveRelation(r) {
      return this._put({ id: "relation:current", data: r, updatedAt: new Date().toISOString() });
    }
    async loadTune() {
      const t = await this._get("tune:current");
      return t ? t.data : {};
    }
    async saveTune(t) {
      return this._put({ id: "tune:current", data: t });
    }

    // 更新情绪（关键词驱动 + 缓回）
    async update(userMsg, aiMsg) {
      let e = await this.loadEmotion();
      const d = lexiconDelta(userMsg);
      e = {
        valence: clamp(e.valence + d.valence, -1, 1),
        arousal: clamp(e.arousal + d.arousal, 0, 1),
        jealousy: clamp(e.jealousy + d.jealousy, 0, 1),
        grievance: clamp(e.grievance + d.grievance, 0, 1),
        affection: clamp(e.affection + d.affection, 0, 1),
      };
      e = easeTowardNeutral(e, 0.05);
      await this.saveEmotion(e);
      return e;
    }

    // 关系进度累积（高质量互动）
    async gainIntimacy(turn) {
      turn = turn || {};
      let r = await this.loadRelation();
      let gain = 0;
      if (turn.user && turn.user.length > 20) gain += 0.002; // 主动分享
      if (turn.emotion && turn.emotion.valence > 0) gain += 0.003; // 正向互动
      if (turn.recalledMemory) gain += 0.004; // 被记住的反馈
      r.intimacy = clamp01(r.intimacy + gain);
      const newLevel = levelFromIntimacy(r.intimacy);
      if (newLevel > r.level) {
        for (let lv = r.level + 1; lv <= newLevel; lv++) {
          for (const u of UNLOCKS[lv] || []) {
            if (!r.unlocked.includes(u)) r.unlocked.push(u);
          }
          r.milestones.push({ at: new Date().toISOString(), name: "达到等级" + lv });
        }
      }
      r.level = newLevel;
      await this.saveRelation(r);
      return r;
    }

    // 轻量微调（仅 tone/nickname/background，不改核心傲娇）
    async tune(patch) {
      const allowed = ["tone", "nickname", "background"];
      const cur = await this.loadTune();
      const next = Object.assign({}, cur);
      for (const k of allowed) {
        if (patch && k in patch) next[k] = patch[k];
      }
      // 拒绝写入非允许字段（守住单一可信角色）
      await this.saveTune(next);
      return next;
    }

    async buildContext() {
      const emotion = await this.loadEmotion();
      const relation = await this.loadRelation();
      const tune = await this.loadTune();
      return {
        emotion,
        relation,
        tune,
        statusLine: renderStatusLine(emotion),
      };
    }
  }

  return {
    DEFAULT_EMOTION,
    DEFAULT_RELATION,
    UNLOCKS,
    levelFromIntimacy,
    lexiconDelta,
    easeTowardNeutral,
    renderStatusLine,
    clamp,
    clamp01,
    PersonaEngine,
  };
});
