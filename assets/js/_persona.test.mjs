// PersonaEngine 单测（Node） // NOSONAR
import P from "./persona.js";

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
  };
}

console.log("== 纯函数 ==");
{
  const d = P.lexiconDelta("你为什么不理我，好难过");
  ok("被冷落→吃醋↑", d.jealousy > 0 && d.grievance > 0);
  const love = P.lexiconDelta("我好喜欢你呀");
  ok("表白→好感↑", love.affection > 0 && love.valence > 0);
  const hate = P.lexiconDelta("我讨厌你");
  ok("讨厌→效价↓", hate.valence < 0 && hate.affection < 0);

  ok("level 0→1", P.levelFromIntimacy(0) === 1);
  ok("level 0.5→3", P.levelFromIntimacy(0.5) === 3);
  ok("level 0.9→5", P.levelFromIntimacy(0.9) === 5);

  ok("缓回趋向中性", P.easeTowardNeutral({ valence: -1, arousal: 1, jealousy: 1, grievance: 1, affection: 0 }, 0.5).valence === -0.5);

  const sl = P.renderStatusLine({ jealousy: 0.6, affection: 0.7 });
  ok("状态话术含吃醋", sl.includes("吃醋") && sl.includes("喜欢你"));
}

console.log("== update 情绪更新（含适配器） ==");
{
  const ad = memAdapter();
  const pe = new P.PersonaEngine(ad);
  const e0 = await pe.loadEmotion();
  ok("初始情绪=默认", e0.jealousy === 0.2);
  const e1 = await pe.update("你为什么不理我，我好委屈", "哼");
  ok("update 后吃醋升高", e1.jealousy > P.DEFAULT_EMOTION.jealousy, "j=" + e1.jealousy.toFixed(3));
  ok("情绪已持久化", (await ad.get("emotion:current")).data.jealousy === e1.jealousy);
}

console.log("== gainIntimacy 关系进度 ==");
{
  const ad = memAdapter();
  const pe = new P.PersonaEngine(ad);
  const r0 = await pe.loadRelation();
  ok("初始等级=1", r0.level === 1);
  // 多次高质量互动累积跨阈值
  let r = r0;
  for (let i = 0; i < 200; i++) {
    r = await pe.gainIntimacy({ user: "今天跟你说了好多好多心里话呢很长一段", emotion: { valence: 0.5 }, recalledMemory: true });
  }
  ok("累积后亲密>0", r.intimacy > 0, "intimacy=" + r.intimacy.toFixed(3));
  ok("跨阈值解锁内容", r.unlocked.length > 0, JSON.stringify(r.unlocked));
  ok("等级已提升", r.level > 1, "level=" + r.level);
}

console.log("== tune 轻量微调 ==");
{
  const ad = memAdapter();
  const pe = new P.PersonaEngine(ad);
  const t = await pe.tune({ tone: "gentle", nickname: "宝贝", core: "改核心设定" });
  ok("tone/nickname 生效", t.tone === "gentle" && t.nickname === "宝贝");
  ok("拒绝非允许字段(守核心)", !("core" in t));
}

console.log("== buildContext ==");
{
  const ad = memAdapter();
  const pe = new P.PersonaEngine(ad);
  await pe.update("我爱你", "哼");
  const ctx = await pe.buildContext();
  ok("含 emotion", ctx.emotion && typeof ctx.emotion.valence === "number");
  ok("含 relation", ctx.relation && typeof ctx.relation.level === "number");
  ok("含 statusLine 文本", typeof ctx.statusLine === "string" && ctx.statusLine.length > 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
