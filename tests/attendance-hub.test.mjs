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

test('接线：侧栏 6 个二级导航 / 路由分派 / CSS / SW 资源清单', async () => {
  const [ui, work, sw, appHtml, localdb, hub, attgrade, dept, domain, css] = await Promise.all([
    read('js/ui.js'), read('js/work.js'), read('sw.js'), read('app.html'), read('js/localdb.js'),
    read('js/attendance-hub.js'), read('js/attgrade.js'), read('js/attendance-departments.js'),
    read('js/attendance-hub-domain.mjs'), read('css/attendance-hub.css'),
  ]);
  const navBlock = /\{ id: 'attendance'[\s\S]*?\]\s*\}\s*,/.exec(ui)?.[0] || '';
  for (const key of ['departments', 'roster', 'duty', 'class', 'leave', 'stats']) {
    assert.match(navBlock, new RegExp(`id: '${key}'`), `侧栏缺二级导航 ${key}`);
  }
  /* 部门管理必须排在花名册上面（二级列表第 1 项） */
  assert.ok(navBlock.indexOf("id: 'departments'") < navBlock.indexOf("id: 'roster'"),
    '部门管理应放在花名册上面');
  assert.match(work, /renderAttendanceHub/);
  assert.match(work, /attendance-hub\.js/);
  assert.match(work, /renderAttendanceDepartments/);
  assert.match(work, /attendance-departments\.js/);
  assert.doesNotMatch(work, /renderAttendance\(body\)/, '旧考勤首页入口应已下线');
  assert.match(ui, /attendance: 'attendance\/roster'/, '点「考勤」应直达花名册');

  /* v3：年级管理 / 新建年级两个入口全部搬进部门管理页 */
  assert.match(dept, /id="ad-dept-add"/, '部门管理缺「新建部门」');
  assert.match(dept, /id="ad-grade-add"/, '部门管理缺「新建年级」');
  assert.match(dept, /data-act="dept-edit"/);
  assert.match(dept, /data-act="dept-del"/);
  assert.match(dept, /data-act="grade-edit"/);
  assert.match(dept, /data-act="grade-del"/);
  assert.match(dept, /新建顺序/);
  assert.doesNotMatch(hub, /id="ahub-grade-manage"/, '花名册顶部不应再有年级管理');
  assert.doesNotMatch(hub, /id="ahub-grade-add"/, '花名册顶部不应再有新建年级');

  /* 花名册三张表页签 + 四表按日期翻页 + 统计本日/本月/本年 */
  assert.match(hub, /ahub-tablist/, '花名册缺分表页签容器');
  assert.match(hub, /rosterTabLabel/);
  assert.match(hub, /api\.get\('\/departments'\)/);
  /* 新建部门 / 年级后，花名册必须能看到新分表；默认不能锁在「高中部」 */
  assert.match(hub, /默认停在「全部部门」/, '花名册默认要展示所有部门的年级分表');
  assert.match(hub, /refreshDeptCounts/, '增删改后页签计数要即时刷新');
  assert.match(hub, /ahub-prev-day/);
  assert.match(hub, /ahub-next-day/);
  assert.match(hub, /data-period="day"/);
  assert.match(hub, /data-period="month"/);
  assert.match(hub, /data-period="year"/);
  assert.match(hub, /periodRange/);
  assert.match(hub, /shiftDate/);
  /* 「同步旧数据」按钮按要求去掉，但后台自动迁移保留 */
  assert.doesNotMatch(hub, /ahub-migrate/, '同步旧数据按钮应已移除');
  assert.match(hub, /needsMigration/, '后台自动迁移必须保留');
  /* 每表原有功能一个不删 */
  for (const id of ['ahub-add', 'ahub-import', 'ahub-export', 'ahub-prev', 'ahub-next', 'ahub-reset', 'ahub-q']) {
    assert.match(hub, new RegExp(`id="${id}"`), `缺原有功能 ${id}`);
  }
  assert.match(attgrade, /花名册的年级筛选/);
  assert.match(appHtml, /attendance-hub\.css/);
  /* 字段口径：教师序号 / 无任教班级 / 默认高中部 */
  assert.doesNotMatch(domain, /label: '教师ID'|label: '任教班级'/);
  assert.match(domain, /label: '教师序号'/);
  assert.match(domain, /DEFAULT_DEPARTMENT = '高中部'/);
  assert.match(css, /ahub-dept-steps/);
  assert.match(css, /ahub-tablist/);
  assert.match(css, /ahub-daynav/);
  assert.match(css, /ahub-periods/);
  /* CACHE 每次发布都会递增，不能写死某一个版本号，否则后续任何发布都会挂在这里。
     这里只校验「存在且符合 wb-v<数字>-<名字> 的换缓存命名规范」。 */
  assert.match(sw, /const CACHE = 'wb-v\d+-[a-z0-9-]+'/);
  for (const f of ['./js/attendance-hub.js', './js/attendance-hub-domain.mjs',
    './js/attendance-departments.js', './css/attendance-hub.css']) {
    assert.ok(sw.includes(`'${f}'`), `SW 缺资源 ${f}`);
  }
  for (const t of [...D.HUB_TABLES, 'att_hub_departments']) {
    assert.ok(localdb.includes(`'${t}'`), `localdb 缺表 ${t}`);
  }
});

test('花名册字段：教师序号 / 高中部 / 去掉任教班级 / 备注列保留', () => {
  const cols = D.sheetDef('roster').columns.map((c) => c.key);
  assert.ok(cols.includes('teacher_id'));
  assert.ok(cols.includes('department'));
  assert.ok(cols.includes('remark'), '备注列保留（只清空内容）');
  assert.ok(!cols.includes('class_name'), '任教班级列应删除');
  assert.equal(D.sheetDef('roster').defaults.department, '高中部');
  assert.equal(D.blankRow('roster').department, '高中部');
  /* 其它 4 张表的教师序号列名也统一 */
  for (const k of ['duty', 'class', 'leave']) {
    assert.equal(D.sheetDef(k).columns.find((c) => c.key === 'teacher_id').label, '教师序号');
  }
});

test('部门 / 页签 / 日期 / 统计区间纯函数', () => {
  assert.equal(D.DEFAULT_DEPARTMENT, '高中部');
  assert.deepEqual(D.gradesOfDepartment(['高一', '高二', '初一'], { 高一: 1, 高二: 1, 初一: 2 }, 1), ['高一', '高二']);
  assert.deepEqual(D.gradesOfDepartment(['高一', '高二'], {}, 1), []);
  assert.equal(D.rosterTabLabel('高一年级'), '高一教师花名册');
  assert.equal(D.rosterTabLabel('高二'), '高二教师花名册');
  assert.equal(D.rosterTabLabel('七年级'), '七年级教师花名册', '不能把「七年级」削成「七」');
  assert.equal(D.rosterTabLabel('初一年级'), '初一教师花名册');
  assert.equal(D.shiftDate('2026-11-25', 1), '2026-11-26');
  assert.equal(D.shiftDate('2026-11-01', -1), '2026-10-31');
  assert.equal(D.shiftDate('2026-01-01', -1), '2025-12-31');
  assert.deepEqual(D.periodRange('day', '2026-11-26'), { from: '2026-11-26', to: '2026-11-26', label: '本日 2026-11-26' });
  assert.deepEqual(D.periodRange('month', '2026-11-26'), { from: '2026-11-01', to: '2026-11-26', label: '本月 2026-11' });
  assert.deepEqual(D.periodRange('year', '2026-11-26'), { from: '2026-01-01', to: '2026-11-26', label: '本年 2026' });
  /* 部门筛选只作用于花名册，其余表不会被筛空 */
  assert.equal(D.filterRows('roster', [{ id: 1, department: '高中部' }, { id: 2, department: '初中部' }], { dept: '高中部' }).length, 1);
  assert.equal(D.filterRows('duty', [{ id: 1, date: '2026-11-25', name: '甲' }], { dept: '高中部' }).length, 1);
  /* 统计区间：本日只算当天记录 */
  const data = {
    roster: [{ name: '甲', grade: '高一' }],
    duty: [{ name: '甲', grade: '高一', date: '2026-11-25', status: '在岗' },
      { name: '甲', grade: '高一', date: '2026-11-26', status: '缺勤' }],
    klass: [], leave: [],
  };
  assert.equal(D.calcStats(data, '', '全部', { from: '2026-11-26', to: '2026-11-26' })[0].absent_count, 1);
  assert.equal(D.calcStats(data, '', '全部', { from: '2026-11-25', to: '2026-11-25' })[0].absent_count, 0);
});

test('部门管理接口：初始化幂等 / 部门年级两级 CRUD / 改名级联 / 删除保留记录', async () => {
  /* 老库升级：第一次访问自动建「高中部」+ 高一 / 高二，重复访问不能重复建 */
  const v0 = await call('GET', '/departments');
  assert.equal(v0.defaultDepartment, '高中部');
  assert.ok(v0.list.some((d) => d.name === '高中部'), '首次访问要自动建「高中部」');
  assert.ok(v0.grades.includes('高一') && v0.grades.includes('高二'), '空库要有高一 / 高二初始年级');
  const v0b = await call('GET', '/departments');
  assert.equal(v0b.list.length, v0.list.length, '重复 GET 不能重复建部门');
  assert.deepEqual(v0b.grades, v0.grades, '重复 GET 不能重复补年级');

  /* 先新建部门，再在部门里新建年级 —— 用户要的顺序 */
  const made = await call('POST', '/departments', {}, { name: ' 初中部 ' });
  assert.equal(made.item.name, '初中部', '部门名要去空格');
  const deptId = made.item.id;
  const dupDept = await handle('POST', '/departments', {}, { name: '初中部' });
  assert.equal(dupDept.ok, false, '重名部门要拦住');
  const emptyDept = await handle('POST', '/departments', {}, { name: '   ' });
  assert.equal(emptyDept.ok, false, '空部门名要拦住');

  const g = '七年级';
  const madeGrade = await call('POST', `/departments/${deptId}/grades`, {}, { name: g });
  assert.equal(madeGrade.item.name, g);
  assert.equal(madeGrade.item.departmentId, deptId);
  assert.ok(madeGrade.list.find((d) => String(d.id) === String(deptId)).grades.some((x) => x.name === g),
    '新建的年级要挂在指定部门下面');
  const dupGrade = await handle('POST', `/departments/${deptId}/grades`, {}, { name: g });
  assert.equal(dupGrade.ok, false, '重名年级要拦住');
  const gradeNotFound = await handle('POST', '/departments/99999/grades', {}, { name: '八年级' });
  assert.equal(gradeNotFound.ok, false, '部门不存在时不能建年级');

  /* 在这个年级下放一条花名册记录，供改名 / 删除级联验证 */
  await call('POST', '/att-hub/roster', {}, {
    name: '部门联动教师', grade: g, department: '初中部', status: '在职',
  });
  const findTeacher = async () => (await call('GET', '/att-hub/roster', { q: '部门联动教师' })).list[0];
  assert.equal((await findTeacher()).department, '初中部');

  /* 年级改名：花名册记录、年级名单、部门归属一起同步 */
  const g2 = '七年级A';
  const renamedGrade = await call('PATCH', `/departments/grades/${encodeURIComponent(g)}`, {}, { name: g2 });
  assert.ok(renamedGrade.grades.includes(g2));
  assert.ok(!renamedGrade.grades.includes(g));
  assert.equal((await findTeacher()).grade, g2, '年级改名要同步已有花名册记录');
  assert.ok(renamedGrade.list.find((d) => String(d.id) === String(deptId)).grades.some((x) => x.name === g2),
    '改名后年级仍留在原部门下');

  /* 部门改名：花名册「所属部门」列同步 */
  const renamedDept = await call('PATCH', `/departments/${deptId}`, {}, { name: '初中部A' });
  assert.ok(renamedDept.renamedRows >= 1, '部门改名要同步花名册所属部门');
  assert.equal((await findTeacher()).department, '初中部A');

  /* 删除部门：有数据时先返回影响范围，前端二次确认带 force=1 才真删 */
  const blocked = await call('DELETE', `/departments/${deptId}`);
  assert.equal(blocked.blocked, true, '有年级 / 教师时不能直接删');
  assert.ok((await call('GET', '/departments')).list.some((d) => String(d.id) === String(deptId)),
    'blocked 状态下部门必须还在');
  const forced = await call('DELETE', `/departments/${deptId}`, { force: '1' });
  assert.equal(forced.blocked, false);
  assert.ok(!forced.list.some((d) => String(d.id) === String(deptId)), 'force 后部门要真删掉');
  assert.ok(forced.unassigned.some((x) => x.name === g2), '部门删掉后年级变成「未分配」而不是消失');

  /* 删除年级：只解除名单与归属，教师与 5 张考勤表记录一条不删 */
  const delGrade = await call('DELETE', `/departments/grades/${encodeURIComponent(g2)}`);
  assert.equal(delGrade.keptRecords, true);
  assert.ok(!delGrade.grades.includes(g2));
  assert.equal((await findTeacher()).name, '部门联动教师', '删年级不能删教师');
});
