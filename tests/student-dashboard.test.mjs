import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (await readFile(new URL('../student.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const sw = (await readFile(new URL('../sw.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const css = (await readFile(new URL('../css/student-dashboard.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('新样式层必须在紫色主题之后加载，并进 SW 缓存清单', () => {
  const purple = src.indexOf('href="css/student-purple.css"');
  const dash = src.indexOf('href="css/student-dashboard.css"');
  assert.ok(purple > 0 && dash > purple, '加载顺序：workbench → purple → dashboard');
  assert.match(sw, /'\.\/css\/student-dashboard\.css'/, 'SW 要预缓存新样式');
  /* 缓存版本每次发布都会递增，不能写死某一个版本号，否则后续任何发布都会挂在这里。
     只校验「符合 wb-v<数字>-<名字> 规范」且版本数字不低于本次引入的 415。 */
  const cache = /const CACHE = 'wb-v(\d+)-[a-z0-9-]+'/.exec(sw);
  assert.ok(cache, 'SW 缺少符合 wb-v<数字>-<名字> 规范的 CACHE');
  assert.ok(Number(cache[1]) >= 415, '缓存版本要递增');
  assert.match(css, /\.sd-stats/, '样式层含统计卡布局');
  assert.match(css, /\.sd-welcome/, '样式层含欢迎头');
});

test('任务页仪表盘：4 张统计卡接真实数据，不写死示意数字', () => {
  assert.match(src, /待完成任务/);
  assert.match(src, /已完成/);
  assert.match(src, /违纪记录/);
  assert.match(src, /新留言/);
  assert.match(src, /num: mine\.length/, '待完成任务取真实任务数');
  assert.match(src, /\(data\.misconduct \|\| \[\]\)\.length/, '违纪记录取真实记录数');
  assert.match(src, /\(data\.bulletin \|\| \[\]\)\.length/, '新留言取真实回复数');
  assert.doesNotMatch(src, /sd-stat-num">3</, '不能把设计稿的示意数字写死');
});

test('快捷入口 4 个、搜索与通知、任务详情都可用', () => {
  for (const id of ['material', 'roll', 'punish', 'bulletin']) {
    assert.match(src, new RegExp(`\\{ id: '${id}', label:`), `入口 ${id} 要存在`);
  }
  assert.match(src, /data-go="\$\{s\.id\}"/, '快捷入口绑定跳转');
  assert.match(src, /sd-search-input/, '搜索框');
  assert.match(src, /sd-bell/, '通知铃铛');
  assert.match(src, /sdSearchItems\(/, '搜索有结果逻辑');
  assert.match(src, /id="sd-view-task"/, '查看任务按钮');
  assert.match(src, /studentCardHtml\(t\)/, '详情仍复用原完整任务卡');
});

test('签到功能不丢：侧栏仍 6 项，进行中签到从任务页提示卡进入', () => {
  assert.match(src, /availTabs\.filter\(\(t\) => t !== 'checkin'\)/, '侧栏隐藏临时签到项');
  assert.match(src, /id="sd-checkin"/, '任务页有去签到入口');
  assert.match(src, /paintCheckin\(\)/, '签到页渲染保留');
  assert.match(src, /tab === 'checkin' && t === 'roll'/, '签到时点名项高亮');
});

test('违纪 / 留言板字数统计与教材、点名、盲盒的设计稿细节', () => {
  assert.match(src, /maxlength="200"/, '违纪 200 字');
  assert.match(src, /maxlength="500"/, '留言 500 字');
  assert.match(src, /id="mc-count"/);
  assert.match(src, /id="bl-count"/);
  assert.match(src, /sd-reply-empty/, '教师回复空态插画');
  assert.match(src, /sd-section-title">\$\{SD_ICON\.book\} 全部资料/, '教材页标题');
  assert.match(src, /id="pk-norepeat" checked/, '点名默认不重复');
  assert.match(src, /sd-box-card/, '盲盒装饰卡');
});
