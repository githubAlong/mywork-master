import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const R = await import('../js/assistant-route.mjs');
const { ASSISTANT_TABS, ASSISTANT_ROOT, ASSISTANT_DEFAULT, normalizeAssistantRoute } = R;

test('小助手：6 个二级导航顺序、文案与一级分组，回收站保持一级', async () => {
  const ui = await read('js/ui.js');
  const literal = /export const NAV = (\[[\s\S]*?\n\]);/.exec(ui)?.[1];
  assert.ok(literal, '找不到 NAV 定义');
  const NAV = Function(`"use strict"; return ${literal};`)();

  const assistant = NAV.find((n) => n.id === 'materials');
  assert.ok(assistant, '缺少「小助手」一级导航');
  assert.equal(assistant.label, '小助手');
  assert.deepEqual(assistant.sub.map((s) => [s.id, s.label]), [
    ['selfstudy', '任务'], ['textbook', '教材'], ['pick', '点名'],
    ['mystery', '盲盒'], ['misconduct', '违纪'], ['bulletin', '留言板'],
  ]);
  assert.equal(assistant.default, ASSISTANT_DEFAULT, '点一级标题应进「任务」');
  assert.equal(NAV.filter((n) => n.id === 'materials').length, 1);

  const recycle = NAV.find((n) => n.id === 'recycle');
  assert.ok(recycle && !recycle.sub, '回收站必须仍是一级导航，不能放进小助手');
  for (const id of ASSISTANT_TABS) {
    assert.equal(NAV.some((n) => n.id === id), false, `${id} 不该再是平级一级导航`);
  }
});

test('小助手：旧地址归一化到 #/materials/<tab>，新地址与老课件页不动', () => {
  for (const tab of ASSISTANT_TABS) {
    assert.equal(normalizeAssistantRoute(tab), `${ASSISTANT_ROOT}/${tab}`);
    assert.equal(normalizeAssistantRoute(`${ASSISTANT_ROOT}/${tab}`), `${ASSISTANT_ROOT}/${tab}`);
  }
  assert.equal(normalizeAssistantRoute('textbook/3'), 'materials/textbook/3');
  assert.equal(normalizeAssistantRoute('work/materials/pick'), 'materials/pick');
  assert.equal(normalizeAssistantRoute('work/textbook'), 'materials/textbook');
  assert.equal(normalizeAssistantRoute('work/materials'), 'materials/selfstudy');
  assert.equal(normalizeAssistantRoute(ASSISTANT_ROOT), ASSISTANT_ROOT, '#/materials 老课件页保留');
  for (const other of ['home', 'daily/notes', 'attendance/roster', 'recycle', 'me']) {
    assert.equal(normalizeAssistantRoute(other), other, `${other} 不能被误改`);
  }
});

test('小助手：路由接线、页面分发与缓存版本齐全', async () => {
  const [ui, main, work, sw] = await Promise.all([
    read('js/ui.js'), read('js/main.js'), read('js/work.js'), read('sw.js'),
  ]);
  assert.match(ui, /normalizeAssistantRoute\(path\)/, 'render 必须调用归一化');
  assert.match(ui, /materials: 'materials\/selfstudy'/, '侧栏点一级标题要进任务');
  assert.match(ui, /n\.default \? `\$\{n\.id\}\/\$\{n\.default\}`/, '底部导航要进分组默认页');
  assert.match(ui, /id === 'materials'\) return r === 'materials'/, '一级高亮要在');
  assert.match(main, /ASSISTANT_TABS\.includes\(seg\)/, '首屏模块映射要用共用清单');
  assert.match(main, /ASSISTANT_ROOT/, '新地址首屏要加载 work.js');

  /* 6 个页面只是换了入口，页面本身仍走原来的渲染函数 */
  assert.match(work, /m\.renderSelfstudyBody\(body\)/, '任务页保持原自习管理内容');
  assert.doesNotMatch(work, /studentTab: 'checkin'/, '任务页不能切成学生签到面板');
  for (const tab of ASSISTANT_TABS.filter((x) => x !== 'selfstudy')) {
    assert.match(work, new RegExp(`renderStudentModule\\(body, '${tab}'\\)`), `${tab} 页面分发不能丢`);
  }
  const cache = /const CACHE = 'wb-v(\d+)-([a-z0-9-]+)'/.exec(sw);
  assert.ok(cache, 'SW 必须带缓存版本号');
  assert.ok(Number(cache[1]) >= 414, '本次发布的缓存版本必须不低于 v414');
  assert.match(sw, /\.\/js\/assistant-route\.mjs/, '新模块要进 SW 预缓存清单');
});
