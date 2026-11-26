import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTENDANCE_TABS, attendanceTabOf } from '../js/attendance-tab-route.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

test('考勤侧栏六张表入口 → 工作台六页签', () => {
  assert.deepEqual(ATTENDANCE_TABS, [
    'roster', 'seat', 'class', 'research', 'leave', 'summary',
  ]);
  for (const key of ATTENDANCE_TABS) assert.equal(attendanceTabOf(key), key);
  assert.equal(ATTENDANCE_TABS.length, new Set(ATTENDANCE_TABS).size);
});

test('v417~v423 老链接落到页签；中文年级名仍作为初始年级', () => {
  assert.equal(attendanceTabOf('departments'), 'roster');
  assert.equal(attendanceTabOf('duty'), 'seat');
  assert.equal(attendanceTabOf('stats'), 'summary');
  assert.equal(attendanceTabOf('高一'), '');
  assert.equal(attendanceTabOf('高二年级'), '');
  assert.equal(attendanceTabOf(''), '');
  assert.equal(attendanceTabOf(null), '');
  assert.equal(attendanceTabOf('  leave  '), 'leave');
});

test('工作台仍是旧版六页签，花名册字段一个都不改', async () => {
  const [prd, work] = await Promise.all([
    read('js/attendance-prd.js'), read('js/work.js'),
  ]);
  for (const [id, label] of [
    ['roster', '花名册'], ['seat', '坐班表'], ['class', '上课表'],
    ['research', '教研表'], ['leave', '请假表'], ['summary', '汇总统计表'],
  ]) {
    assert.ok(prd.includes(`['${id}','${label}']`), `工作台缺页签 ${label}`);
  }
  /* 方案 C 的关键：花名册保持现在这样，不换成独立表那套字段
     （v433 起多一列「在职状态」，是人事属性，不属于独立表的考勤字段） */
  assert.ok(prd.includes("? ['序号','归属部门','归属年级','姓名','学科','在职状态','备注','操作']"),
    '花名册列不能改');
  assert.ok(!prd.includes('教师序号'), '花名册不应混入独立表的「教师序号」列');
  assert.ok(work.includes('grade: initialGrade, tab: initialTab'), '初始页签要传进工作台');
  assert.ok(prd.includes('TABS.some(([id]) => id === initialTab)'), '未知页签回落坐班表');
});

test('新模块进 SW 预缓存清单，缓存版本按规范递增', async () => {
  const sw = await read('sw.js');
  assert.match(sw, /'\.\/js\/attendance-tab-route\.mjs'/, 'SW 要预缓存页签映射模块');
  assert.match(sw, /const CACHE = 'wb-v\d+-[a-z0-9-]+'/);
});
