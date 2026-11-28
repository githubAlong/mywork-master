import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './test-browser.mjs';

installBrowser({ href: 'http://localhost/' });
const R = await import('../js/attendance-legacy-restore.mjs');
const { handle } = await import('../js/localapi.js?legacy-restore=1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

async function call(method, url, query = {}, body = undefined) {
  const res = await handle(method, url, query, body);
  assert.equal(res.ok, true, res.error || `${method} ${url}`);
  return res.data;
}

/* ============================ 纯函数：形状转换 ============================ */

test('freshHubRows 只挑「用户在新表页亲手录入、且未回填」的行', () => {
  const rows = [
    { id: 1, name: '新录入' },
    { id: 2, name: '旧数据副本', _src: 'roster|teachers|9' },
    { id: 3, name: '已回填', _restored: R.LEGACY_RESTORE_VERSION },
    { id: 4, name: '已删除', deleted_at: '2026-11-26T00:00:00Z' },
  ];
  assert.deepEqual(R.freshHubRows(rows).map((r) => r.id), [1]);
  assert.deepEqual(R.freshHubRows(null), []);
  assert.deepEqual(R.HUB_RESTORE_KEYS, ['roster', 'duty', 'class', 'leave', 'stats']);
});

test('教师 / 请假记录映射成旧版字段形状', () => {
  assert.equal(R.hubTeacherToLegacy({ name: '' }), null);
  const t = R.hubTeacherToLegacy({
    name: ' 王芳 ', subject: '语文', grade: '高二', phone: '13800000000', status: '离职',
  });
  assert.deepEqual(t, { name: '王芳', subject: '语文', grade: '高二', phone: '13800000000', active: 0 });
  assert.equal(R.hubTeacherToLegacy({ name: '张三' }).grade, '高一', '缺年级时给默认年级');

  const l = R.hubLeaveToLegacy({
    id: 7, name: '毕晓鸣', grade: '高二', leave_type: '事假',
    start_at: '2026-11-24 08:00', end_at: '2026-11-24 18:00',
    reason: '家中有事', approve_status: '已通过', hours: '',
  });
  assert.equal(l.id, 'hub-leave-7');
  assert.equal(l.start_date, '2026-11-24');
  assert.equal(l.end_date, '2026-11-24');
  assert.equal(l.type, '事假');
  assert.equal(l.status, '已批');
  assert.match(l.remark, /家中有事/);
  assert.equal(l.source, 'hub');
});

test('坐班 / 上课状态同时写 __teacherGrid 与旧版勾选列', () => {
  const duty = R.hubSheetRowToLegacy('duty', {
    id: 11, date: '2026-11-24', name: '李承泽', grade: '高二', status: '在岗', place: '三楼',
  }, { subject: '数学' });
  assert.equal(duty.type, 'seat');
  assert.equal(duty.subject, '数学');
  assert.equal(duty.data.__teacherGrid['0'].sit, 'y');
  assert.equal(duty.data.k_坐班, '1');
  assert.match(duty.data.k_remark, /三楼/);
  assert.equal(duty.extraLeave, null);

  const late = R.hubSheetRowToLegacy('duty', {
    id: 12, date: '2026-11-24', name: '李承泽', status: '迟到',
  });
  assert.equal(late.data.__teacherGrid['0'].sit, 'y', '迟到仍算在场，只留痕');
  assert.match(late.data.k_remark, /迟到/);

  const absent = R.hubSheetRowToLegacy('duty', {
    id: 13, date: '2026-11-24', name: '李承泽', status: '缺勤',
  });
  assert.equal(absent.data.__teacherGrid['0'].sit, 'n');

  const onLeave = R.hubSheetRowToLegacy('duty', {
    id: 14, date: '2026-11-24', name: '李承泽', grade: '高二', status: '请假',
  });
  assert.equal(onLeave.data.__teacherGrid['0'].leave, '事假');
  assert.equal(onLeave.data.k_请假, '1');
  assert.equal(onLeave.extraLeave.type, '事假');

  const klass = R.hubSheetRowToLegacy('class', {
    id: 15, date: '2026-11-24', name: '李承泽', grade: '高二',
    status: '已上课', subject: '数学', class_name: '高二(3)班',
  });
  assert.equal(klass.type, 'class');
  assert.equal(klass.data.__teacherGrid['0'].class, 'y');
  assert.equal(klass.data.k_上课, '1');
  assert.match(klass.data.k_remark, /高二\(3\)班/);

  assert.equal(R.hubSheetRowToLegacy('duty', { date: '2026-11-24' }), null, '没姓名不生成行');
});

test('planHubBackfill：_src 副本跳过 / 教师去重 / 新教师学科联动 / 请假去重', () => {
  const hub = {
    roster: [
      { id: 1, name: '新教师', subject: '语文', grade: '高二' },
      { id: 2, name: '旧教师', subject: '数学', grade: '高一', _src: 'roster|teachers|1' },
    ],
    duty: [{ id: 3, date: '2026-11-24', name: '新教师', grade: '高二', status: '在岗' }],
    class: [],
    leave: [
      { id: 4, name: '新教师', grade: '高二', start_at: '2026-11-24 08:00', leave_type: '事假' },
    ],
    stats: [{ id: 5, period: '2026-11', teacher: '新教师' }],
  };
  const plan = R.planHubBackfill({
    hub,
    teachers: [{ name: '老教师', subject: '英语', grade: '高一' }],
    leaves: [{ id: 'hub-leave-4', name: '新教师' }],
  });
  assert.equal(plan.counts.teachers, 1, '只补 1 位新教师，_src 副本不重复补');
  assert.equal(plan.teacherAdds[0].name, '新教师');
  assert.equal(plan.counts.sheets, 1);
  assert.equal(plan.sheetAdds[0].subject, '语文', '状态行学科要跟新补的教师一致');
  assert.equal(plan.counts.leaves, 0, '已有同 id 的请假不再插入');
  assert.equal(plan.counts.stats, 1);
  assert.equal(plan.statsArchive[0]._hubSheet, 'stats');
  assert.deepEqual(plan.freshIds.roster, ['1']);
});

/* ============================ 接口：真实落库 + 幂等 ============================ */

test('POST /attendance/restore-hub：五类数据回填旧版数据源，重复调用不产生重复行', async () => {
  const DATE = '2026-11-24';
  await call('POST', '/att-hub/roster', {}, {
    name: '回填甲', subject: '语文', grade: '高二', department: '高中部', status: '在职',
  });
  await call('POST', '/att-hub/duty', {}, {
    date: DATE, name: '回填甲', grade: '高二', status: '在岗', place: '三楼',
  });
  await call('POST', '/att-hub/class', {}, {
    date: DATE, name: '回填甲', grade: '高二', subject: '语文', status: '已上课',
  });
  await call('POST', '/att-hub/leave', {}, {
    name: '回填甲', grade: '高二', leave_type: '事假',
    start_at: `${DATE} 08:00`, end_at: `${DATE} 18:00`, reason: '家中有事', approve_status: '已通过',
  });
  await call('POST', '/att-hub/stats', {}, {
    period: '2026-11', grade: '高二', teacher: '回填甲', expected: 1, actual: 1,
  });

  const first = await call('POST', '/attendance/restore-hub', {}, {});
  assert.equal(first.already, false);
  assert.equal(first.version, R.LEGACY_RESTORE_VERSION);
  assert.equal(first.restored.teachers, 1);
  assert.equal(first.restored.sheets, 2, '坐班 + 上课各一行');
  assert.equal(first.restored.leaves, 1);
  assert.equal(first.restored.stats, 1);

  /* 教师进了旧版名册 */
  const roster = await call('GET', '/teachers', { grade: '高二', active: 'all' });
  const teacher = roster.list.find((t) => t.name === '回填甲');
  assert.ok(teacher, '新教师要出现在旧版花名册');
  assert.equal(teacher.subject, '语文');

  /* 工作表 + 行：__teacherGrid 与勾选列都落到 attendance_rows */
  const tables = await call('GET', '/attendance', { grade: '高二', sheet_date: DATE });
  assert.ok(tables.some((t) => t.sheet_type === 'seat'), '要惰性建坐班表');
  assert.ok(tables.some((t) => t.sheet_type === 'class'), '要惰性建上课表');
  const seat = tables.find((t) => t.sheet_type === 'seat');
  const detail = await call('GET', `/attendance/${seat.id}`);
  const row = detail.rows.find((r) => r.teacher === '回填甲');
  assert.ok(row, '坐班表要有该教师行');
  assert.equal(row.subject, '语文', '学科要与名册一致，否则工作台认领不到');
  assert.equal(row.data.__teacherGrid['0'].sit, 'y');
  assert.equal(row.data.k_坐班, '1');
  assert.equal(row.data.__hub.sheet, 'duty');

  /* 请假 + 统计归档写回 /me 设置 */
  const me = await call('GET', '/me');
  const ws = me.user.settings.attendanceWorkspace;
  assert.ok(ws.leaves.some((l) => l.id.startsWith('hub-leave-') && l.name === '回填甲'));
  assert.equal(ws.hubArchive.length, 1);
  assert.equal(ws.hubArchive[0]._hubSheet, 'stats');

  /* 第二次：版本标记命中，直接跳过 */
  const second = await call('POST', '/attendance/restore-hub', {}, {});
  assert.equal(second.already, true);

  /* 强制重跑：内容去重生效，一条都不再插 */
  const forced = await call('POST', '/attendance/restore-hub', {}, { force: '1' });
  assert.equal(forced.already, false);
  assert.deepEqual(forced.restored, { teachers: 0, sheets: 0, leaves: 0, stats: 0 });
  const roster2 = await call('GET', '/teachers', { grade: '高二', active: 'all' });
  assert.equal(roster2.list.filter((t) => t.name === '回填甲').length, 1, '不能重复插教师');
  const detail2 = await call('GET', `/attendance/${seat.id}`);
  assert.equal(detail2.rows.filter((r) => r.teacher === '回填甲').length, 1, '不能重复插考勤行');
});

test('接线：侧栏单入口 / 旧工作台路由 / 自动补齐 / SW 资源', async () => {
  const [ui, work, sw, localapi] = await Promise.all([
    read('js/ui.js'), read('js/work.js'), read('sw.js'), read('js/localapi.js'),
  ]);
  assert.match(ui, /{ id: 'attendance', label: '考勤', icon: 'users' }/);
  const route = await read('js/attendance-tab-route.mjs');
  for (const key of ['roster', 'seat', 'class', 'research', 'leave', 'summary']) {
    assert.ok(route.includes("'" + key + "'"), '旧书签映射缺少 ' + key);
  }
  assert.match(work, /renderAttendancePRD/);
  assert.doesNotMatch(work, /renderAttendanceHub/);
  assert.match(work, /\/attendance\/restore-hub/);
  assert.match(localapi, /ensureLegacyRestore/);
  assert.match(localapi, /on\('POST', '\/attendance\/restore-hub'/);
  assert.match(localapi, /LEGACY_RESTORE_VERSION/);
  /* 缓存版本每次发布都会递增，只校验命名规范，不写死某一个版本号。 */
  assert.match(sw, /const CACHE = 'wb-v\d+-[a-z0-9-]+'/);
  assert.match(sw, /'\.\/js\/attendance-legacy-restore\.mjs'/);
  /* 可见按钮按用户上一轮要求：不能加回来 */
  const hub = await read('js/attendance-hub.js');
  assert.doesNotMatch(hub, /ahub-migrate/);
});
