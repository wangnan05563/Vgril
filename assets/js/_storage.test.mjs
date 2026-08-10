// StorageMigrator / IndexedDB 基座单测（Node） // NOSONAR
import SB from "./storage.js";

let pass = 0,
  fail = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✓", name, extra);
  } else {
    fail++;
    console.error("  ✗", name, extra);
  }
}

console.log("== 数据库 schema ==");
ok("DB 名 = xiaoya", SB.DB_NAME === "xiaoya");
ok("DB 版本 = 1", SB.DB_VERSION === 1);
ok(
  "7 个 store 齐全",
  JSON.stringify(SB.STORES) ===
    JSON.stringify(["memory", "emotion", "relation", "session", "crisisLog", "meta", "captions"]),
  JSON.stringify(SB.STORES)
);

console.log("== parseLegacy 兼容旧格式 ==");
{
  // JSON 数组
  const a = SB.parseLegacy('[{"role":"user","text":"你好"},{"role":"ai","text":"哼"}]');
  ok("JSON 数组解析", a.length === 2 && a[0].role === "user" && a[1].role === "ai");

  // 纯文本（交替）
  const t = SB.parseLegacy("今天天气真好\n小雅你真可爱");
  ok("纯文本按行交替", t.length === 2 && t[0].role === "user" && t[1].role === "ai");

  // 带角色标记
  const m = SB.parseLegacy("我：想吃火锅\n小雅：走啊");
  ok("角色标记解析", m[0].role === "user" && m[0].text === "想吃火锅" && m[1].role === "ai");

  // 空 / 异常
  ok("null→空数组", SB.parseLegacy(null).length === 0);
  ok("空串→空数组", SB.parseLegacy("   ").length === 0);
}

console.log("== transformLegacy 迁移载荷 ==");
{
  const r = SB.transformLegacy('[{"role":"user","text":"我不吃香菜"}]', "2026-08-08T00:00:00Z");
  ok("生成 session 记录", r.session && r.session.id.startsWith("legacy-"));
  ok("legacy 标记", r.session.legacy === true);
  ok("turns 数量正确", r.count === 1 && r.session.turns[0].text === "我不吃香菜");
  ok("createdAt 透传", r.session.createdAt === "2026-08-08T00:00:00Z");
}

console.log("== IndexedDB 守卫 (Node 下 openDB 抛错) ==");
let threw = false;
try {
  await SB.openDB();
} catch {
  threw = true;
}
ok("openDB 在 Node 抛错(无 indexedDB)", threw);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
