import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './test-browser.mjs';

installBrowser({ href: 'http://localhost/' });
const D = await import('../js/attendance-hub-domain.mjs');
const { handle } = await import('../js/localapi.js?attendance-hub=1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

async function call(method, url, query = {}, body = undefined) {
  const res = await handle(method, url, query, body);
  assert.equal(res.ok, true, res.error || `${method} ${url}`);
  return res.data;
}

test('5 张表平级独立，表名互不重复，字段各自闭合', () => {
  assert.deepEqual(D.HUB_SHEET_KEYS, ['roster', 'duty', 'class', 'leave', 'stats']);
  assert.equal(new Set(D.HUB_TABLES).size, 5);
  for (const key of D.HUB_SHEET_KEYS) {
    const def = D.sheetDef(key);
    assert.ok(def.columns.length >= 9, `${key} 字段过少`);
    assert.equal(new Set(def.columns.map((c) => c.key)).size, def.columns.length, `${key} 字段重复`);
    assert.ok(def.columns.some((c) => c.required), `${key} 没有必填字段`);
  }
  assert.equal(D.sheetDef('unknown'), null);
  assert.equal(D.isHubSheet('roster'), true);
  assert.equal(D.isHubSheet('__proto__'), false);
});

test('normalizeRow 裁剪外来字段，validateRow 拦住缺必填', () => {
  const row = D.normalizeRow('duty', {
    date: '2026-11-25', name: ' 李承泽 ', grade: '高一', status: '在岗',
    hacked: 'x', expected: 999,
  });
  assert.equal(row.name, '李承泽');
  assert.equal(row.status, '在岗');
  assert.equal(row.hacked, undefined);
  assert.equal(row.expected, undefined);
  assert.equal(D.validateRow('duty', row), '');
  assert.match(D.validateRow('duty', { ...row, name: '' }), /姓名/);
  assert.match(D.validateRow('duty', { ...row, date: '' }), /日期/);
  /* 非法下拉值回落到第一个选项，不会把脏值写进表 */
  assert.equal(D.normalizeRow('duty', { status: '乱填的' }).status, '在岗');
});

test('年级 / 日期只是筛选条件，不再是数据隔离边界', () => {
  const rows = [
    { id: 1, date: '2026-11-20', grade: '高一', name: '李承泽', subject: '语文' },
    { id: 2, date: '2026-11-25', grade: '高二', name: '周砚秋', subject: '数学' },
    { id: 3, date: '2026-12-01', grade: '高一', name: '王波', subject: '音乐' },
    { id: 4, date: '2026-11-25', grade: '高一', name: '张三', deleted_at: 'x' },
  ];
  assert.equal(D.filterRows('duty', rows, {}).length, 3, '软删除行不出现');
  assert.equal(D.filterRows('duty', rows, { grade: '高二' }).length, 1);
  assert.equal(D.filterRows('duty', rows, { from: '2026-11-25', to: '2026-11-30' }).length, 1);
  assert.equal(D.filterRows('duty', rows, { q: '数学' }).length, 1);
  assert.equal(D.filterRows('duty', rows, { grade: '高一', q: '王波' }).length, 1);
  /* 同一张表里两个年级共存 —— 这正是解除「按年级隔离」的核心 */
  assert.equal(new Set(D.filterRows('duty', rows, {}).map((r) => r.grade)).size, 2);
});

test('CSV 导出导入往返，逗号 / 引号 / 换行不丢', () => {
  const rows = [{ date: '2026-11-25', name: '李承泽', grade: '高一', remark: '带,逗号 和"引号"\n换行' }];
  const csv = D.toCsv('duty', D.normalizeRow('duty', rows[0]) && [D.normalizeRow('duty', rows[0])]);
  const parsed = D.fromCsv('duty', csv);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows.length, 1);
  assert.match(parsed.rows[0].remark, /带,逗号 和"引号"/);
  assert.match(parsed.rows[0].remark, /换行/);
  assert.equal(parsed.rows[0].name, '李承泽');
});

test('CSV 表头中文列名与英文 key 都认，坏行有明确提示', () => {
  const zh = D.parseCsv('姓名,日期,年级\r\n李承泽,2026-11-25,高一\r\n').length;
  assert.equal(zh, 2);
  const byLabel = D.fromCsv('duty', '姓名,日期\n李承泽,2026-11-25');
  assert.equal(byLabel.rows.length, 1);
  const byKey = D.fromCsv('duty', 'name,date\n周砚秋,2026-11-24');
  assert.equal(byKey.rows.length, 1);
  const bad = D.fromCsv('duty', '姓名,日期\n,2026-11-25\n王波,2026-11-25');
  assert.equal(bad.rows.length, 1);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /第 2 行/);
  assert.ok(D.fromCsv('duty', '随便,表头\n1,2').errors.length > 0);
});

test('统计表由 4 张业务表自动汇总', () => {
  const out = D.calcStats({
    roster: [{ name: '李承泽', grade: '高一' }, { name: '周砚秋', grade: '高二' }],
    duty: [
      { name: '李承泽', grade: '高一', date: '2026-11-25', status: '在岗' },
      { name: '李承泽', grade: '高一', date: '2026-11-26', status: '缺勤' },
    ],
    klass: [{ name: '李承泽', grade: '高一', date: '2026-11-25' }],
    leave: [{ name: '周砚秋', grade: '高二', start_at: '2026-11-25' }],
  }, '2026-11', '全部');
  assert.equal(out.length, 2);
  const li = out.find((r) => r.teacher === '李承泽');
  assert.equal(li.class_count, 1);
  assert.equal(li.absent_count, 1);
  assert.equal(li.duty_minutes, 80);
  assert.equal(out.find((r) => r.teacher === '周砚秋').leave_count, 1);
  /* 按年级筛选只影响结果，不影响源表 */
  assert.equal(D.calcStats({ roster: [{ name: '李承泽', grade: '高一' }] }, '2026-11', '高二').length, 0);
});

test('5 张表接口 CRUD：新增 / 查询 / 编辑 / 软删', async () => {
  const before = await call('GET', '/att-hub/roster');
  assert.equal(before.sheet, 'roster');
  assert.equal(before.columns.length, D.sheetDef('roster').columns.length);

  const created = await call('POST', '/att-hub/roster', {}, {
    teacher_id: 'T-9001', name: '测试教师', subject: '语文', grade: '高二', status: '在职',
  });
  assert.equal(created.item.name, '测试教师');
  const id = created.item.id;

  const patched = await call('PATCH', `/att-hub/roster/${id}`, {}, { subject: '数学' });
  assert.equal(patched.item.subject, '数学');

  const list = await call('GET', '/att-hub/roster', { grade: '高二', q: '测试教师' });
  assert.equal(list.list.length, 1);
  assert.equal(list.list[0].id, id);
  assert.equal(list.total >= 1, true);

  await call('DELETE', `/att-hub/roster/${id}`);
  const after = await call('GET', '/att-hub/roster', { q: '测试教师' });
  assert.equal(after.list.length, 0);

  const missing = await handle('POST', '/att-hub/roster', {}, { name: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /姓名/);
  const badSheet = await handle('GET', '/att-hub/nope');
  assert.equal(badSheet.ok, false);
});

test('批量导入 + 刷新汇总 + 迁移幂等', async () => {
  const items = [
    { date: '2026-11-25', name: '导入甲', grade: '高一', status: '在岗' },
    { date: '2026-11-26', name: '导入乙', grade: '高二', status: '迟到' },
    { date: '', name: '缺日期', grade: '高一' },
  ];
  const imported = await call('POST', '/att-hub/duty/import', {}, { items });
  assert.equal(imported.added, 2);
  assert.equal(imported.rejected.length, 1);

  const refreshed = await call('POST', '/att-hub-refresh', {}, { period: '2026-11', grade: '全部' });
  assert.ok(refreshed.count >= 2);
  const stats = await call('GET', '/att-hub/stats');
  assert.ok(stats.list.some((r) => String(r.remark).includes('自动汇总')));

  await call('POST', '/teachers', {}, { grade: '高一', items: [{ name: '迁移测试甲', subject: '语文' }] });
  const first = await call('POST', '/att-hub-migrate');
  assert.ok(first.migrated.roster >= 1);
  const second = await call('POST', '/att-hub-migrate');
  assert.equal(second.migrated.roster, 0, '同一条旧记录不能重复迁入');
});

test('年级管理动态化：新建年级能落库，改名同步 5 张考勤表', async () => {
  const g = '测试年级A';
  const g2 = '测试年级B';
  await call('POST', '/grades', {}, { name: g });
  const created = await call('POST', '/att-hub/roster', {}, {
    name: '年级联动测试', grade: g, status: '在职',
  });
  assert.equal(created.item.grade, g, '动态年级不能被回落成「高一」');

  const renamed = await call('PATCH', `/grades/${encodeURIComponent(g)}`, {}, { name: g2 });
  assert.ok(renamed.migrated.hub >= 1, '改名要同步新考勤表');
  const list = await call('GET', '/att-hub/roster', { q: '年级联动测试' });
  assert.equal(list.list[0].grade, g2);

  assert.deepEqual(D.gradeOptions({ grades: [g2, '  ', g2] }), [g2]);
  assert.deepEqual(D.gradeOptions({ grades: [] }), ['高一', '高二', '高三']);
  assert.deepEqual(D.gradeOptions(null), ['高一', '高二', '高三']);
  assert.equal(D.normalizeRow('roster', { grade: g2 }).grade, g2);
  assert.equal(D.normalizeRow('roster', { status: '乱填的' }).status, '在职', '其它下拉仍收敛');
  assert.equal(D.gradeKey('高一年级'), '高一');
  assert.equal(D.filterRows('roster', [{ id: 1, grade: '高一' }], { grade: '高一年级' }).length, 1,
    '动态年级名要能筛到 v411 迁移时的简写');
  assert.equal(D.calcStats({ roster: [{ name: '甲', grade: '高一' }] }, '', '高一年级').length, 1);
});

test('接线：侧栏 5 个二级导航 / 路由分派 / CSS / SW 资源清单', async () => {
  const [ui, work, sw, appHtml, localdb, hub, attgrade] = await Promise.all([
    read('js/ui.js'), read('js/work.js'), read('sw.js'), read('app.html'), read('js/localdb.js'),
    read('js/attendance-hub.js'), read('js/attgrade.js'),
  ]);
  const navBlock = /\{ id: 'attendance'[\s\S]*?\]\s*\}\s*,/.exec(ui)?.[0] || '';
  for (const key of ['roster', 'duty', 'class', 'leave', 'stats']) {
    assert.match(navBlock, new RegExp(`id: '${key}'`), `侧栏缺二级导航 ${key}`);
  }
  assert.match(work, /renderAttendanceHub/);
  assert.match(work, /attendance-hub\.js/);
  assert.doesNotMatch(work, /renderAttendance\(body\)/, '旧考勤首页入口应已下线');
  assert.match(ui, /attendance: 'attendance\/roster'/, '点「考勤」应直达花名册');
  assert.match(hub, /id="ahub-grade-manage"/);
  assert.match(hub, /id="ahub-grade-add"/);
  assert.match(hub, /gradeOptions/);
  assert.match(attgrade, /花名册的年级筛选/);
  assert.match(appHtml, /attendance-hub\.css/);
  /* CACHE 每次发布都会递增，不能写死某一个版本号，否则后续任何发布都会挂在这里。
     这里只校验「存在且符合 wb-v<数字>-<名字> 的换缓存命名规范」。 */
  assert.match(sw, /const CACHE = 'wb-v\d+-[a-z0-9-]+'/);
  for (const f of ['./js/attendance-hub.js', './js/attendance-hub-domain.mjs', './css/attendance-hub.css']) {
    assert.ok(sw.includes(`'${f}'`), `SW 缺资源 ${f}`);
  }
  for (const t of D.HUB_TABLES) assert.ok(localdb.includes(`'${t}'`), `localdb 缺表 ${t}`);
});
