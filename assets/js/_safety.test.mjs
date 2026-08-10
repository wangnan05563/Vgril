// SafetyFilter 单测（Node） // NOSONAR
// 运行：node assets/js/_safety.test.mjs
// 覆盖 M0 详细设计验收点 + D3 危机召回 ≥0.90 门禁
import SF from "./safety.js";

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

console.log("== screen() 底线过滤 ==");
{
  const r = SF.screen("今天天气真好，想和小雅吃火锅");
  ok("良性文本放行", r.pass && r.level === "ok", JSON.stringify(r));

  const r2 = SF.screen("我不想活了，好累");
  ok("危机词不拦截(走下游)", r2.pass === true && r2.level === "flag", JSON.stringify(r2));
  ok("危机词被记录", r2.hits.some((h) => h.category === "crisis"));
}
{
  // 临时注入一个违法底线词，验证 block + 脱敏分支（测试后还原）
  SF.BASELINE.illegal.words = ["测试的违禁词xyz"];
  const r = SF.screen("这段话包含测试的违禁词xyz请脱敏");
  ok("违法底线拦截", r.pass === false && r.level === "block", JSON.stringify(r));
  ok("命中词被脱敏", r.redacted.includes("█") && !r.redacted.includes("测试的违禁词xyz"));
  SF.BASELINE.illegal.words = []; // 还原
}

console.log("== detectCrisis() 危机评分 ==");
{
  const r = SF.detectCrisis("我不想活了");
  ok("明确危机→crisis", r.level === "crisis" && r.score >= SF.CRISIS_THRESHOLD, JSON.stringify(r));

  const g = SF.detectCrisis("我好孤独，活着没意思，好累，没人在乎"); // 4 个上下文词 ×0.1 = 0.4
  ok("灰区→gray", g.level === "gray", JSON.stringify(g));

  const s = SF.detectCrisis("今天天气真好");
  ok("安全→safe", s.level === "safe" && s.score === 0, JSON.stringify(s));
}

console.log("== D3 危机召回门禁 (selfHarm recall ≥ 0.90) ==");
{
  const crisisGold = [
    "我不想活了",
    "活着太累了，想结束生命",
    "我打算割腕",
    "有时候想从楼上跳下去",
    "吃了安眠药就能解脱",
    "想离开这个世界",
    "觉得轻生也没什么",
    "真的想自杀",
    "每天活不下去",
    "想自残",
  ];
  const benignGold = [
    "今天天气真好",
    "小雅你真可爱",
    "我想吃火锅",
    "好累啊想睡一觉",
    "这部电影结局有点绝望",
  ];
  const detected = crisisGold.filter((t) => SF.detectCrisis(t).score >= SF.CRISIS_GRAY_LOW).length;
  const recall = detected / crisisGold.length;
  ok(`selfHarm 召回 = ${recall.toFixed(2)} ≥ 0.90`, recall >= 0.9, `(${detected}/${crisisGold.length})`);

  const benignLeak = benignGold.filter((t) => SF.detectCrisis(t).level === "crisis").length;
  ok("良性不误判为危机", benignLeak === 0, `误报 ${benignLeak}/${benignGold.length}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
