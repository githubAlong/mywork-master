import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [grid, teacherCss, responsiveCss, appHtml, sw] = await Promise.all([
  readFile(new URL('../js/homegrid.js', import.meta.url), 'utf8'),
  readFile(new URL('../css/teacher-ui.css', import.meta.url), 'utf8'),
  readFile(new URL('../css/home-responsive.css', import.meta.url), 'utf8'),
  readFile(new URL('../app.html', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
]);

test('JS 与 CSS 使用同一组首页响应式断点', () => {
  assert.match(grid, /HOME_BP\s*=\s*Object\.freeze\(\{\s*desktop:\s*1600,\s*tablet:\s*860,\s*narrow:\s*520\s*\}\)/);
  assert.match(grid, /const BP = \{ desktop: HOME_BP\.desktop, tablet: HOME_BP\.tablet \}/);
  /* 首页整屏平铺档位必须跟随 1600，否则大屏规则和 JS 三套布局错配 */
  assert.match(teacherCss, /@media \(min-width: 1600px\)/);
  assert.match(teacherCss, /@media \(max-width: 1599px\)/);
  assert.doesNotMatch(teacherCss, /@media \(min-width: 1180px\)/);
  assert.doesNotMatch(teacherCss, /@media \(max-width: 1179px\)/);
  assert.match(teacherCss, /@media\(max-width:1599px\)/);
});

test('响应式适配层覆盖大屏 / 抽屉 / 手机 / 极窄屏四档', () => {
  assert.match(responsiveCss, /@media \(min-width: 1600px\)/);
  assert.match(responsiveCss, /@media \(min-width: 1101px\) and \(max-width: 1599px\)/);
  assert.match(responsiveCss, /@media \(min-width: 861px\) and \(max-width: 1100px\)/);
  assert.match(responsiveCss, /@media \(max-width: 860px\)/);
  assert.match(responsiveCss, /@media \(max-width: 520px\)/);
});

test('手机档强制单列，并用 !important 盖掉 JS 写入的 12 列内联坐标', () => {
  assert.match(responsiveCss, /grid-template-columns:\s*minmax\(0, 1fr\) !important/);
  assert.match(responsiveCss, /grid-column:\s*1 \/ -1 !important/);
  assert.match(responsiveCss, /grid-row:\s*auto !important/);
  assert.match(responsiveCss, /grid-auto-rows:\s*auto !important/);
  assert.match(responsiveCss, /--nav-h\) \+ var\(--safe-b\)/);
});

test('适配层只作用于首页，不出现影响全站的裸选择器', () => {
  /* 每一条规则都以首页作用域开头（通用注释与花括号行忽略） */
  const selectors = responsiveCss
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('{') && !line.startsWith('/*') && !line.startsWith('*'));
  assert.ok(selectors.length > 10, '适配层规则数量异常');
  for (const sel of selectors) {
    assert.ok(
      /^(@media|body:not\(\.is-wide\)|\.app:has\(#home-grid\)|\.home-redesign|\})/.test(sel),
      `存在可能影响全站的选择器：${sel}`,
    );
  }
});

test('新样式已接入首屏、SW 预缓存与版本换缓存', () => {
  assert.match(appHtml, /href="css\/home-responsive\.css"/);
  assert.match(sw, /\.\/css\/home-responsive\.css/);
  assert.match(sw, /const CACHE = 'wb-v\d+-[a-z0-9-]+'/);
});
