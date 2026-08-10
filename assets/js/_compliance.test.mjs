// ComplianceGate 单测（Node） // NOSONAR
import CG from "./compliance.js";

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

console.log("== 年龄确认状态机（REQ-COMP-02 正式稿：未成年一律拒服）==");
ok("未确认→unconfirmed", CG.evaluateAgeGate({ confirmed: false }).state === "unconfirmed");
ok("成年确认→confirmed/adult", CG.evaluateAgeGate({ confirmed: true, isMinor: false }).state === "confirmed" && CG.evaluateAgeGate({ confirmed: true, isMinor: false }).mode === "adult");
ok("未成年确认→rejected(拒服)", CG.evaluateAgeGate({ confirmed: true, isMinor: true }).state === "rejected" && CG.evaluateAgeGate({ confirmed: true, isMinor: true }).mode === "minor");
ok("拒服原因标记", CG.evaluateAgeGate({ confirmed: true, isMinor: true }).reason === "minor-not-served");

console.log("== 训练硬锁 (REQ-COMP-05) ==");
ok("训练授权恒为拒绝", CG.isTrainingAllowed() === false);
ok("常量训练锁为 false", CG.TRAINING_ALLOWED === false);

console.log("== 防沉迷计时 (REQ-COMP-03) ==");
{
  // 成年：2h 提醒
  const a = CG.tick({ mode: "adult", continuousMs: 0 }, 2 * 3600 * 1000);
  ok("成年连续2h→需提醒", a.needRemind === true && a.needLock === false);

  const a0 = CG.tick({ mode: "adult", continuousMs: 0 }, 3600 * 1000);
  ok("成年连续1h→不提醒", a0.needRemind === false);

  // 未成年不再进入 tick（门禁已拒服）；为防御性，tick 对 minor 也不产出锁定
  const m = CG.tick({ mode: "minor", continuousMs: 0 }, 3 * 3600 * 1000);
  ok("未成年(防御)→不提醒不锁定", m.needRemind === false && m.needLock === false);

  // 累加语义
  let s = { mode: "adult", continuousMs: 0, dailyMs: 0 };
  CG.tick(s, 3600 * 1000);
  const r = CG.tick(s, 3600 * 1000);
  ok("连续累加至2h→提醒", r.needRemind === true && s.continuousMs === 7200000);
}

console.log("== 增强模式判定 / 数据出境告知（修订_P0 §1）==");
{
  ok("本地默认→非增强", CG.isEnhancedMode({}) === false);
  ok("仅开本地数字人→非增强", CG.isEnhancedMode({ dhEnabled: true, dhProvider: "local" }) === false);
  ok("启用远程大模型→增强", CG.isEnhancedMode({ llmEnabled: true, llmKey: "sk-x" }) === true);
  ok("启用远程数字人→增强", CG.isEnhancedMode({ dhEnabled: true, dhProvider: "heygen" }) === true);
  ok("数字人关→非增强", CG.isEnhancedMode({ dhEnabled: false, dhProvider: "heygen" }) === false);

  const local = CG.outboundNotice({});
  ok("本地模式文案", local.mode === "local" && /默认不上云/.test(local.text));

  const enh = CG.outboundNotice({ llmEnabled: true, llmKey: "sk-x", noCarryMemory: false });
  ok("增强模式·携带记忆文案", enh.mode === "enhanced" && enh.carriesMemory === true);

  const enhNo = CG.outboundNotice({ llmEnabled: true, llmKey: "sk-x", noCarryMemory: true });
  ok("增强模式·不携带记忆文案", enhNo.mode === "enhanced" && enhNo.carriesMemory === false && /不随 prompt 出境/.test(enhNo.text));
}

console.log("== 默认合规配置 ==");
{
  const d = CG.defaultCompliance();
  ok("训练硬锁默认 false", d.trainingOptIn === false);
  ok("记忆出境默认 false", d.noCarryMemory === false);
  ok("年龄未确认", d.ageConfirmedAt === null);
}

console.log("== 危机干预载荷 (REQ-COMP-04 / D3) ==");
{
  const c = CG.onCrisis({ score: 0.8, hits: ["不想活"] });
  ok("停止AI回复", c.stopAiReply === true);
  ok("展示干预界面", c.showIntervention === true);
  ok("含心理援助资源(≥2条热线)", c.resources.filter((r) => r.tel).length >= 2);
  ok("阻断AI开解内容", c.aiComfortBlocked === true);
  ok("回传信号", c.signal && c.signal.score === 0.8);
}

console.log("== DOM 守卫 (Node 下不崩溃) ==");
ok("renderAIBadge 在 Node 返回 null", CG.renderAIBadge() === null);
ok("ensureComplianceGate 在 Node 直接 resolve", CG.ensureComplianceGate() instanceof Promise);
let threw = false;
try {
  CG.wipeAll(null);
} catch {
  threw = true;
}
ok("wipeAll 缺适配器抛错(守卫)", threw);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);