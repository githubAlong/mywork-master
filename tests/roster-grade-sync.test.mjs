/* 花名册年级回填（wb-v420）

   线上真实故障：v411 把旧名册迁进 att_hub_roster 时，100 位老师的年级全落成「高一」，
   页签变成「高一教师花名册 · 100 / 高二教师花名册 · 0」——高二那 50 多位老师明明在库里。
   修法是按老师最初给的四张纸表（SEED_ROSTER，姓名唯一）回填一次，
   新花名册与旧名册（teachers）一起改。这里锁住四条行为：
     1. 空库不落标记，将来导入还能回填；
     2. 全高一的库读完就分成 46 / 54，页签计数与旧名册同时正确；
     3. 幂等，第二次读不再动数据；
     4. 回填过之后手工改的年级不会被冲掉。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './test-browser.mjs';

installBrowser({ href: 'http://localhost/' });
const { handle } = await import('../js/localapi.js?roster-grade-sync=1');
/* 不能带 query：带 query 会生成另一份模块实例，看不到 localapi 写进内存的状态 */
const L = await import('../js/localdb.js');
const D = await import('../js/attendance-hub-domain.mjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function call(method, url, query = {}, body = undefined) {
  const res = await handle(method, url, query, body);
  assert.equal(res.ok, true, res.error || `${method} ${url}`);
  return res.data;
}

/* 直接读页面那份「旧名册」，保证对照表与代码里的一致，而不是测试自己另抄一份 */
async function legacyRoster() {
  const src = await readFile(path.join(root, 'js/localapi.js'), 'utf8');
  const block = src.match(/const SEED_ROSTER = \{([\s\S]*?)\n\};/)[1];
  const parse = (key) => {
    const seg = block.match(new RegExp(key + ': \\[([\\s\\S]*?)\\n  \\],'));
    return seg ? [...seg[1].matchAll(/\['([^']+)', '([^']+)'\]/g)].map((m) => ({ name: m[1], subject: m[2] })) : [];
  };
  return { gradeOne: parse('高一'), gradeTwo: parse('高二') };
}

const spread = (rows) => rows.reduce((m, r) => {
  const k = r.grade || '(空)';
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});

const storedRoster = () => L.load()[D.HUB_SHEETS.roster.table] || [];

test('空库不落回填标记，导入后仍会按旧名册分年级', async () => {
  await call('POST', '/auth/register', {}, { account: 'roster_grade_sync', password: '123456' });
  await call('GET', '/att-hub/roster', {});
  assert.equal(storedRoster().length, 0);
  assert.equal(L.load().meta.rosterGradeSynced, undefined, '空库不能打标记');
});

test('全落成高一的 100 人读完分成 46 / 54，页签与旧名册同时正确', async (t) => {
  const { gradeOne, gradeTwo } = await legacyRoster();
  assert.equal(gradeOne.length, 46);
  assert.ok(gradeTwo.length >= 54);

  await call('POST', '/grades', {}, { name: '高一' });
  /* 复现故障：100 人一律按高一导入，再迁进新花名册 */
  await call('POST', '/teachers', {}, { grade: '高一', items: [...gradeOne, ...gradeTwo].slice(0, 100) });
  await call('POST', '/att-hub-migrate', {});
  assert.deepEqual(spread(storedRoster()), { 高一: 100 }, '迁移后应全是高一（故障现场）');

  const first = await call('GET', '/att-hub/roster', {});
  assert.deepEqual(spread(first.list), { 高一: 46, 高二: 54 }, '100 人要分成 46 / 54');

  const dept = await call('GET', '/departments', {});
  assert.ok(dept.grades.includes('高一') && dept.grades.includes('高二'), '年級名单要含高一高二');
  const high = dept.list.find((d) => d.name === '高中部');
  assert.ok(high, '应有高中部');
  const counts = Object.fromEntries(high.grades.map((g) => [g.name, g.teacherCount]));
  assert.deepEqual(counts, { 高一: 46, 高二: 54 }, '页签计数要跟真实人数一致');

  /* 旧名册（年级工作台那份）也要一起分开，坐班 / 上课 / 教研表取名单才对得上 */
  const h1 = await call('GET', '/teachers', { grade: '高一', active: 'all' });
  const h2 = await call('GET', '/teachers', { grade: '高二', active: 'all' });
  assert.deepEqual([h1.list.length, h2.list.length], [46, 54]);

  t.diagnostic(`回填后：${JSON.stringify(spread(first.list))}`);
});

test('幂等：第二次读取不再改数据', async () => {
  const before = spread(storedRoster());
  const again = await call('GET', '/att-hub/roster', {});
  assert.deepEqual(spread(again.list), before);
  assert.equal(L.load().meta.rosterGradeSynced, 1, '跑过之后要有标记');
});

test('回填过之后，手工改的年级不会被冲掉', async () => {
  const list = (await call('GET', '/att-hub/roster', {})).list;
  const one = list.find((r) => r.grade === '高二');
  assert.ok(one, '应有高二教师');
  await call('PATCH', `/att-hub/roster/${one.id}`, {}, { grade: '高一' });
  const after = await call('GET', '/att-hub/roster', {});
  assert.equal(spread(after.list)['高二'], 53, '手工修改要保持');
});
