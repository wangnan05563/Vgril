// MemoryStore 单测（Node） // NOSONAR
import M from "./memory.js";

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

// 内存适配器（模拟 StorageBase store 接口）
function memAdapter() {
  const map = new Map();
  return {
    put: (rec) => {
      map.set(rec.id, rec);
      return Promise.resolve();
    },
    get: (id) => Promise.resolve(map.get(id) || null),
    getAll: () => Promise.resolve([...map.values()]),
    delete: (id) => {
      map.delete(id);
      return Promise.resolve();
    },
    _size: () => map.size,
  };
}

console.log("== 纯函数：相似度 / 重叠 / 评分 ==");
ok("topicSim 相等=1", M.topicSim("食物", "食物") === 1);
ok("topicSim 包含=0.6", M.topicSim("食物偏好", "食物") === 0.6);
ok("topicSim 无关=0", M.topicSim("食物", "工作") === 0);
ok("keywordOverlap 相关>0", M.keywordOverlap("我不吃香菜", "香菜很好吃") > 0);
ok("keywordOverlap 无关=0", M.keywordOverlap("苹果手机", "篮球比赛") === 0);
{
  const s = M.scoreMemory(
    { topic: "食物", text: "用户不吃香菜", importance: 0.7 },
    { topic: "食物", user: "今天吃香菜吗" }
  );
  ok("scoreMemory 匹配项较高", s > 0.7, "s=" + s.toFixed(3));
}

console.log("== ruleExtract 本地抽取 ==");
{
  const a = M.ruleExtract({ user: "我不吃香菜" });
  ok("不吃→pref/食物", a.some((f) => f.type === "pref" && f.topic === "食物" && f.text.includes("香菜")));

  const b = M.ruleExtract({ user: "我喜欢喝奶茶" });
  ok("喜欢→pref/食物", b.some((f) => f.text.includes("奶茶")));

  const c = M.ruleExtract({ user: "记住我怕黑" });
  ok("记住→fact", c.some((f) => f.type === "fact" && f.text.includes("怕黑")));

  const none = M.ruleExtract({ user: "今天天气真好" });
  ok("无关文本不抽", none.length === 0);
}

console.log("== extract / getRelevant（含适配器） ==");
{
  const ad = memAdapter();
  const ms = new M.MemoryStore(ad);
  const n = await ms.extract({ user: "我不吃香菜" });
  ok("extract 入库 1 条", n === 1 && ad._size() === 1);

  const rel = await ms.getRelevant({ topic: "食物", user: "晚饭吃香菜怎么样" }, 5);
  ok("getRelevant 召回香菜记忆", rel.length === 1 && rel[0].text.includes("香菜"));
  ok("召回后 recallCount+1", rel[0].recallCount === 1);
}

console.log("== decay 衰减 + 上限裁剪 ==");
{
  // 单条衰减：旧记忆重要性应下降
  const ad1 = memAdapter();
  const ms1 = new M.MemoryStore(ad1, { maxMemory: 100 });
  const ts = new Date(Date.now() - 100 * M.DAY).toISOString();
  ad1.put({ id: "old1", type: "fact", topic: "t", text: "mem", createdAt: ts, lastRecalled: ts, importance: 0.5, recallCount: 0 });
  await ms1.decay();
  ok("decay 后重要性下降(<0.5)", (await ad1.get("old1")).importance < 0.5, "imp=" + (await ad1.get("old1")).importance);

  // 上限裁剪：5 条超 maxMemory=3 → 裁剪至 3
  const ad2 = memAdapter();
  const ms2 = new M.MemoryStore(ad2, { maxMemory: 3 });
  for (let i = 0; i < 5; i++) {
    ad2.put({ id: "x" + i, type: "fact", topic: "t", text: "mem" + i, createdAt: ts, lastRecalled: ts, importance: 0.5, recallCount: 0 });
  }
  await ms2.decay();
  ok("超过上限裁剪至 3", ad2._size() === 3, "size=" + ad2._size());
}

console.log("== list / update / remove ==");
{
  const ad = memAdapter();
  const ms = new M.MemoryStore(ad);
  await ms.extract({ user: "我喜欢奶茶" });
  const all = await ms.list();
  ok("list 返回全部", all.length === 1);
  const id = all[0].id;
  await ms.update(id, { text: "用户超爱奶茶" });
  ok("update 生效", (await ad.get(id)).text === "用户超爱奶茶");
  await ms.remove(id);
  ok("remove 生效", (await ad.get(id)) === null);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
