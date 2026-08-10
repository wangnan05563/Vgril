/*
 * StorageMigrator / IndexedDB 基座（M0 详细设计 §StorageMigrator）
 *
 * 职责：建立 xiaoya IndexedDB（store: memory/emotion/relation/session/crisisLog/meta/captions）；
 *       首次启动将旧 localStorage 明文对话迁移进 IndexedDB 并脱敏归档（原 localStorage 仅留 UI 偏好）。
 * 纯逻辑（parseLegacy / transformLegacy）可在 Node 单测；openDB / migrate 仅浏览器执行（IndexedDB）。
 *
 * 双模：浏览器 window.StorageBase；Node module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StorageBase = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DB_NAME = "xiaoya";
  const DB_VERSION = 1;
  // 7 个 store（captions 由 M2 新增，一并建好）
  const STORES = ["memory", "emotion", "relation", "session", "crisisLog", "meta", "captions"];

  /**
   * parseLegacy —— 解析旧 localStorage 对话（纯函数，可单测）
   * 兼容两种形态：JSON 数组 [{role,text}] / 纯文本（按换行或"小雅："/"我："切分）。
   * @returns {Array<{role:"user"|"ai", text:string}>}
   */
  function parseLegacy(raw) {
    if (raw == null) return [];
    let arr;
    if (typeof raw === "string") {
      const s = raw.trim();
      if (!s) return [];
      try {
        const obj = JSON.parse(s);
        arr = Array.isArray(obj) ? obj : [obj];
      } catch {
        // 纯文本：按换行切，交替 user/ai；或按"我："/"小雅："标记
        arr = s.split(/\r?\n+/).filter(Boolean);
        return arr.map((line, i) => {
          const m = line.match(/^(我|用户|U)[:：]\s*(.*)$/) || line.match(/^(小雅|AI|A)[:：]\s*(.*)$/);
          if (m) {
            const isUser = /^(我|用户|U)/.test(m[1]);
            return { role: isUser ? "user" : "ai", text: m[2] };
          }
          return { role: i % 2 === 0 ? "user" : "ai", text: line };
        });
      }
    } else if (Array.isArray(raw)) {
      arr = raw;
    } else {
      arr = [raw];
    }
    return arr
      .map((x) => {
        if (x && typeof x === "object" && "text" in x) {
          const role = x.role === "ai" || x.role === "assistant" ? "ai" : "user";
          return { role, text: String(x.text || "") };
        }
        return null;
      })
      .filter((x) => x && x.text);
  }

  /**
   * transformLegacy —— 把旧对话转为迁移载荷（纯函数，可单测）
   * 生成一条 session 记录 + 可选记忆摘要（这里仅归档原文，抽取交给 M1 MemoryStore）。
   * @returns {{session:{id:string, createdAt:string, turns:Array, legacy:true}, count:number}}
   */
  function transformLegacy(raw, now) {
    const turns = parseLegacy(raw);
    const ts = now || new Date().toISOString();
    const session = {
      id: "legacy-" + (ts || "sess"),
      createdAt: ts,
      turns,
      legacy: true,
    };
    return { session, count: turns.length };
  }

  /**
   * openDB —— 打开/升级 IndexedDB（仅浏览器）
   * @returns {Promise<IDBDatabase>}
   */
  function openDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        return reject(new Error("indexedDB 不可用（仅浏览器）"));
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: "id" });
          }
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * clearAll / dumpAll —— 供 ComplianceGate.wipeAll/exportAll 注入（仅浏览器）
   */
  async function clearAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, "readwrite");
      let pending = STORES.length;
      for (const name of STORES) {
        tx.objectStore(name).clear().onsuccess = () => {
          if (--pending === 0) resolve(true);
        };
      }
      tx.onerror = () => reject(tx.error);
    });
  }
  async function dumpAll() {
    const db = await openDB();
    const out = {};
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, "readonly");
      let pending = STORES.length;
      for (const name of STORES) {
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => {
          out[name] = req.result;
          if (--pending === 0) resolve(out);
        };
        req.onerror = () => reject(req.error);
      }
    });
  }

  return {
    DB_NAME,
    DB_VERSION,
    STORES,
    parseLegacy,
    transformLegacy,
    openDB,
    clearAll,
    dumpAll,
  };
});
