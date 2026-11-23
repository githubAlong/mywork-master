import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* 点名页的班级名单原来只有一个「管理班级名单」弹层，进去只能整段粘贴姓名：
   班名写错、班建错了、想单独看某个班的名单，都没有入口。
   这里用源码不变量兜住三件事：行上有查看/编辑/删除、编辑走 PATCH、删除先进回收站。 */

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const work = read('js/work.js');

test('班级名单每一行都有查看 / 编辑 / 删除三个入口', () => {
  assert.match(work, /data-ros-view="\$\{r\.id\}"/);
  assert.match(work, /data-ros-edit="\$\{r\.id\}"/);
  assert.match(work, /data-ros-del="\$\{r\.id\}"/);
  /* 三个按钮要真的绑上事件，否则只是三个装饰图标 */
  ['ros-view', 'ros-edit', 'ros-del'].forEach((k) => {
    assert.match(work, new RegExp(`querySelectorAll\\('\\[data-${k}\\]'\\)`), k + ' 没绑事件');
  });
});

test('编辑弹层改的是同一个班（PATCH /rosters/:id），不是新建', () => {
  const fn = work.slice(work.indexOf('function rosterEditDialog'), work.indexOf('async function deleteRoster'));
  assert.match(fn, /await api\.patch\('\/rosters\/' \+ r\.id,/);
  assert.match(fn, /class_name/);
  assert.match(fn, /count/);
  assert.ok(!/api\.post\('\/rosters'/.test(fn), '编辑不能走 POST，会多出一个班');
  /* 有姓名时人数必须跟名单走，否则界面显示 40 人、名单只有 3 个 */
  assert.match(fn, /const count = names\.length \|\|/);
});

test('删除先二次确认，再软删除（可在回收站还原）', () => {
  const fn = work.slice(work.indexOf('async function deleteRoster'), work.indexOf('/* ================= 课件 + 课堂签到'));
  assert.match(fn, /confirmDialog\(/);
  assert.match(fn, /await api\.del\('\/rosters\/' \+ r\.id\)/);
  assert.match(fn, /回收站/);
});

test('查看弹层展示完整名单并可复制', () => {
  const fn = work.slice(work.indexOf('function rosterViewDialog'), work.indexOf('function rosterEditDialog'));
  assert.match(fn, /ros-grid/);
  assert.match(fn, /navigator\.clipboard\.writeText/);
  /* 没姓名时给的是「去编辑」的引导，不是空白弹层 */
  assert.match(fn, /还没导入姓名/);
});

test('完整名单网格样式存在', () => {
  const css = read('css/design-refresh.css');
  assert.match(css, /\.ros-grid\s*\{[^}]*grid-template-columns/);
  assert.match(css, /\.ros-item\s*\{/);
});
