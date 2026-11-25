import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [responsiveCss, teacherCss, homeJs, appHtml, sw] = await Promise.all([
  readFile(new URL('../css/home-responsive.css', import.meta.url), 'utf8'),
  readFile(new URL('../css/teacher-ui.css', import.meta.url), 'utf8'),
  readFile(new URL('../js/home.js', import.meta.url), 'utf8'),
  readFile(new URL('../app.html', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
]);

/* 首页对齐修正（确认图 v2）只动两件事：
     1. 搜索条铺满内容区，搜索按钮固定在最右端；
     2. 第二行三张卡底边齐平。
   功能、占位文案、按钮、卡片数量、字段名、导航、配色一律不动。 */

test('搜索条铺满内容区，不再被大屏 520px 限成窄条', () => {
  assert.match(
    responsiveCss,
    /\.home-redesign \.home-topbar \.searchbar \{ width: 100%; max-width: none; \}/,
    '搜索条必须有铺满规则',
  );
  assert.doesNotMatch(
    responsiveCss,
    /\.home-topbar \.searchbar \{ max-width: 520px; \}/,
    '大屏档不得再把搜索条限成 520px',
  );
});

test('大屏档不再给搜索条设窄上限，也不给 topbar 加会让它收缩的水平 auto 边距', () => {
  assert.match(responsiveCss, /body:not\(\.is-wide\) \.home-redesign #home-grid \{[^}]*max-width: 1800px/);
  /* topbar 是 flex column 的 item，margin-inline:auto 会让它收缩到内容宽度，
     搜索条反而变窄；这一条不能加回来。 */
  assert.doesNotMatch(responsiveCss, /\.home-redesign \.home-topbar \{[^}]*margin-inline/);
});

test('搜索按钮固定在搜索条最右端，占位文案与按钮本身不变', () => {
  assert.match(responsiveCss, /\.home-redesign \.home-topbar \.searchbar \.sb-go \{ margin-left: auto; flex: 0 0 auto; \}/);
  assert.match(homeJs, /<button class="sb-go" id="search-go" title="搜索" aria-label="搜索">/);
  assert.match(homeJs, /placeholder="搜索任务 \/ 课程 \/ 笔记 \/ 出勤…（支持模糊与精准）"/);
  assert.match(homeJs, /<div class="searchbar" id="searchbar">/);
});

test('第二行三张卡底边齐平：清掉日历卡的 8px 下移', () => {
  assert.match(
    responsiveCss,
    /\.home-redesign #home-grid > \.hg-item\[data-hcard="calendar"\] \{ transform: none; \}/,
  );
  assert.match(responsiveCss, /\.home-redesign #home-grid > \.hg-item \{ align-self: stretch; \}/);
  /* 旧规则仍在 teacher-ui.css，由后加载且特异性更高的适配层覆盖；不改原文件 */
  assert.match(teacherCss, /\.home-redesign \.hg-item\[data-hcard="calendar"\] \{ transform:translateY\(8px\); \}/);
});

test('没有新增卡片、没有改字段名、没有动导航', () => {
  /* 只数卡片节点；js 里还有 [data-hcard="calendar"] 这样的选择器，不算卡片 */
  const cards = homeJs.match(/<div class="hg-item" data-hcard="[a-zA-Z]+"/g) || [];
  assert.equal(cards.length, 10, '首页卡片数量必须保持 10 张');
  for (const id of ['profile', 'timeline', 'todayCourse', 'todayTodo', 'calendar', 'weather']) {
    assert.ok(cards.includes(`<div class="hg-item" data-hcard="${id}"`), `卡片 ${id} 不应被删改`);
  }
  assert.doesNotMatch(homeJs, /<div class="hg-item" data-hcard="shortcut/);
});

test('适配层仍已接入首屏、SW 预缓存，并换了缓存版本', () => {
  assert.match(appHtml, /href="css\/home-responsive\.css"/);
  assert.match(sw, /\.\/css\/home-responsive\.css/);
  /* 版本号每次发布都会变，只校验命名格式，避免后续发布被硬编码断言卡住 */
  assert.match(sw, /const CACHE = 'wb-v\d+-[a-z0-9-]+'/);
});
