// Node 单测：StudioWorkflow（REQ-CT-01/02/03/FUN-01/02/03） // NOSONAR
// 运行：node assets/js/_studio.test.mjs
import assert from 'node:assert';
import { validateTheme, canApplyScene, classifyShare, StudioWorkflow } from './studio.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

console.log('== validateTheme 字段白名单（REQ-FUN-02 防注入） ==');
{
  const good = { id: 'sakura', colors: { bg: '#FFF0F5', accent: '#FF9EBB' }, avatarFilter: 'saturate(1.1) hue-rotate(-8deg)' };
  ok('合法主题通过', validateTheme(good).ok === true);
  const evilField = { id: 'x', evil: 'boom', colors: {} };
  ok('未知字段拒绝', validateTheme(evilField).ok === false && validateTheme(evilField).errors.join().includes('未知主题字段'));
  const evilFilter = { id: 'x', avatarFilter: 'url(http://evil)' };
  ok('avatarFilter 含 url() 拒绝', validateTheme(evilFilter).ok === false);
  const evilJs = { id: 'x', avatarFilter: 'expression(alert(1))' };
  ok('avatarFilter 含 expression 拒绝', validateTheme(evilJs).ok === false);
  const evilColor = { id: 'x', colors: { bg: '#fff', hack: '1' } };
  ok('未知颜色字段拒绝', validateTheme(evilColor).ok === false);
}

console.log('== canApplyScene 解锁校验（REQ-FUN-01） ==');
{
  const scene = { id: 'late_night', unlockLevel: 5, name: '深夜谈心' };
  ok('未达等级拒绝', canApplyScene(scene, 3).ok === false && canApplyScene(scene, 3).required === 5);
  ok('达等级放行', canApplyScene(scene, 5).ok === true);
  ok('无 unlockLevel 常驻', canApplyScene({ id: 'daily' }, 0).ok === true);
  ok('scene 不存在拒绝', canApplyScene(null, 1).ok === false);
}

console.log('== classifyShare 分享安检（D5/D3） ==');
{
  const safety = { screen: (t) => (t === '底线' ? { pass: false, text: '█' } : { pass: true, text: t }) };
  ok('正常可分享', classifyShare({ textContent: '美好瞬间', blob: {} }, safety, []).ok === true);
  ok('底线词阻止分享', classifyShare({ textContent: '底线', blob: {} }, safety, []).ok === false);
  const crisisWin = [[2000, 5000]];
  ok('重叠危机时段阻止', classifyShare({ textContent: 'hi', timeWindow: [3000, 4000] }, null, crisisWin).ok === false);
  ok('危机时段不重叠放行', classifyShare({ textContent: 'hi', timeWindow: [6000, 7000] }, null, crisisWin).ok === true);
}

console.log('== StudioWorkflow 编排（注入 hooks/适配器） ==');
{
  const applied = [];
  const studio = new StudioWorkflow({
    scenes: { late_night: { id: 'late_night', unlockLevel: 5 }, daily: { id: 'daily' } },
    safety: { screen: (t) => ({ pass: true, text: t }) },
    config: { save: async (p) => { applied.push(p); return true; } },
    hooks: { onApplyTheme: (p) => applied.push({ theme: p.id }), onDownload: () => {}, onToast: () => {} }
  });
  // 场景：未解锁
  const r1 = studio.applyScene('late_night', 3);
  ok('场景未解锁被拒', r1.ok === false);
  // 场景：解锁
  const r2 = studio.applyScene('daily', 3);
  ok('场景解锁成功', r2.ok === true);
  // 主题校验失败时仍走 toast 不写入
  const bad = studio.applyTheme({ id: 'evil', hack: 1 });
  ok('非法主题被拒', bad.ok === false);
  const good = studio.applyTheme({ id: 'sakura', colors: { bg: '#fff' } });
  ok('合法主题应用成功', good.ok === true);
  ok('onApplyTheme hook 触发', applied.some((x) => x.theme === 'sakura'));
  // 分享：安检通过触发下载
  let downloaded = false;
  studio.hooks.onDownload = () => { downloaded = true; };
  const s = studio.share({ textContent: '美好', blob: {}, name: 'a.webm' });
  ok('分享放行并下载', s.ok === true && downloaded === true);
}

await new Promise((r) => setTimeout(r, 30));
console.log('\n==== StudioWorkflow 单测汇总 ====');
console.log('PASS=' + pass + '  FAIL=' + fail);
assert.strictEqual(fail, 0, '存在失败时断言终止');
process.exit(fail === 0 ? 0 : 1);
