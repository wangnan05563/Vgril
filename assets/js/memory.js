/*
 * MemoryStore —— 长期语义记忆（M1 详细设计 §3，REQ-PER-01）
 *
 * 职责：跨会话长期语义记忆，按主题归档；抽取/召回/衰减/编辑。
 *  - ruleExtract：本地轻量规则抽取（离线可用，纯函数）
 *  - getRelevant：主题相似 + 关键词重叠 + 重要性 的混合召回（纯函数 scoreMemory）
 *  - decay：低频旧记忆降权 + 上限裁剪
 *  - list/update/remove：记忆库可视化与编辑（REQ-FUN-03 复用）
 *
 * 适配：依赖注入 storage 适配器 {put,get,getAll,delete}（对应 StorageBase 的 store 封装）。
 *       纯函数可在 Node 单测；DOM/IndexedDB 仅浏览器。
 * 双模：浏览器 window.MemoryStore；Node module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MemoryStore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86400000;

  function uid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function nowISO() {
    return new Date().toISOString();
  }

  // ── 纯函数：相似度 / 重叠 / 评分（可单测）────────────────────────
  function topicSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.6;
    return 0;
  }
  function cjkBigrams(s) {
    const chars = Array.from(s || "").filter((ch) => /[一-鿿]/.test(ch));
    const out = [];
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
    return out;
  }
  function keywordOverlap(a, b) {
    const A = new Set(cjkBigrams(a));
    const B = new Set(cjkBigrams(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / Math.max(A.size, B.size);
  }
  function scoreMemory(m, ctx) {
    return (
      topicSim(m.topic, ctx.topic) * 0.4 +
      keywordOverlap(m.text, ctx.user || "") * 0.4 +
      (m.importance || 0.5) * 0.2
    );
  }

  // ── 本地规则抽取（离线，纯函数）─────────────────────────────────
  // 返回 [{type, topic, text, importance}]
  function ruleExtract(turn) {
    const user = turn && turn.user ? String(turn.user) : "";
    const facts = [];
    const push = (type, topic, text, importance) => {
      if (text) facts.push({ type, topic, text, importance: importance || 0.6 });
    };

    // 食物偏好：不吃/讨厌/不喜欢(吃) + X
    let m = user.match(/(?:不吃|讨厌|不喜欢吃?|不爱吃)\s*([一-鿿]{1,6})/);
    if (m) push("pref", "食物", "小雅记得用户不吃" + m[1], 0.7);

    // 喜欢/爱吃 + X
    m = user.match(/(?:喜欢|爱吃|爱吃)\s*([一-鿿]{1,6})/);
    if (m) push("pref", "食物", "用户喜欢" + m[1], 0.6);

    // 记住/记得 + 内容
    m = user.match(/(?:记住|记得)\s*[，,]?\s*(.{2,20})/);
    if (m) push("fact", "偏好", "用户让小雅记住：" + m[1].replace(/[。.]$/, ""), 0.7);

    // 约定/说好/答应
    m = user.match(/(?:约定|说好|答应|说好了)\s*[，,]?\s*(.{2,20})/);
    if (m) push("promise", "约定", "与用户的约定：" + m[1].replace(/[。.]$/, ""), 0.8);

    // 生日 / 日期
    m = user.match(/生日.*?(\d+月\d+日|\d+-\d+)/);
    if (m) push("event", "日期", "用户生日：" + m[1], 0.9);

    return facts;
  }

  // ── 类 ──────────────────────────────────────────────────────────
  class MemoryStore {
    constructor(adapter, opts) {
      this.adapter = adapter || null; // {put, get, getAll, delete}
      this.MAX_MEMORY = (opts && opts.maxMemory) || 500;
    }
    _put(rec) {
      return this.adapter ? this.adapter.put(rec) : Promise.resolve();
    }
    _getAll() {
      return this.adapter ? this.adapter.getAll() : Promise.resolve([]);
    }
    _delete(id) {
      return this.adapter ? this.adapter.delete(id) : Promise.resolve();
    }
    _get(id) {
      return this.adapter ? this.adapter.get(id) : Promise.resolve(null);
    }

    // 抽取并入库（若 adapter 存在）；可选 LLM 摘要仅当前轮文本（D1，此处不实现网络）
    async extract(turn, opts) {
      opts = opts || {};
      const facts = ruleExtract(turn);
      const ts = nowISO();
      for (const f of facts) {
        const rec = {
          id: uid(),
          type: f.type,
          topic: f.topic,
          text: f.text,
          createdAt: ts,
          lastRecalled: ts,
          importance: f.importance,
          recallCount: 0,
        };
        await this._put(rec);
      }
      await this.decay();
      return facts.length;
    }

    // 召回 topK（更新 lastRecalled/recallCount）
    async getRelevant(ctx, topK) {
      topK = topK || 5;
      const all = await this._getAll();
      const scored = all
        .map((m) => ({ m, s: scoreMemory(m, ctx) }))
        .sort((a, b) => b.s - a.s);
      const top = scored.slice(0, topK);
      const ts = nowISO();
      for (const t of top) {
        if (t.s <= 0) continue; // 零相关不更新、不返回
        t.m.lastRecalled = ts;
        t.m.recallCount = (t.m.recallCount || 0) + 1;
        await this._put(t.m);
      }
      return top.filter((t) => t.s > 0).map((t) => t.m);
    }

    // 衰减 + 上限裁剪
    async decay() {
      const all = await this._getAll();
      const ts = Date.now();
      for (const m of all) {
        const idleDays = (ts - new Date(m.lastRecalled || ts).getTime()) / DAY;
        m.importance = Math.max(0.1, (m.importance || 0.5) - idleDays * 0.005);
        await this._put(m);
      }
      if (all.length > this.MAX_MEMORY) {
        const sorted = all.slice().sort((a, b) => (a.importance || 0.5) - (b.importance || 0.5));
        const toDel = sorted.slice(0, all.length - this.MAX_MEMORY);
        for (const m of toDel) await this._delete(m.id);
      }
      return all.length;
    }

    async list(filter) {
      let all = await this._getAll();
      if (filter && filter.type) all = all.filter((m) => m.type === filter.type);
      if (filter && filter.topic) all = all.filter((m) => m.topic === filter.topic);
      return all;
    }
    async update(id, patch) {
      const m = await this._get(id);
      if (!m) return false;
      Object.assign(m, patch, { id }); // 保护 id 不被改
      await this._put(m);
      return true;
    }
    async remove(id) {
      await this._delete(id);
      return true;
    }
  }

  return {
    DAY,
    uid,
    topicSim,
    keywordOverlap,
    scoreMemory,
    ruleExtract,
    MemoryStore,
  };
});
