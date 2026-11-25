/* 组织管理（部门 / 年级 / 教师 / 科目 四页签）：接口 + 页面接线 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './test-browser.mjs';

installBrowser({ href: 'http://localhost/' });
const D = await import('../js/attendance-hub-domain.mjs');
const { handle } = await import('../js/localapi.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

async function call(method, url, query = {}, body = undefined) {
  const res = await handle(method, url, query, body);
  assert.equal(res.ok, true, res.error || `${method} ${url}`);
  return res.data;
}

test('科目分类按名称归档，未知科目落「其他」', () => {
  assert.equal(D.subjectCategory('语文'), '语言与人文');
  assert.equal(D.subjectCategory('数学'), '数学与科学');
  assert.equal(D.subjectCategory('体育与健康'), '艺术与体育');
  assert.equal(D.subjectCategory('道德与法治'), '语言与人文');
  assert.equal(D.subjectCategory('心理健康'), '其他');
  assert.equal(D.subjectCategory(''), '');
});

test('科目种子来自花名册学科，人数按教师数实时统计', async () => {
  await call('POST', '/att-hub/roster', {}, { name: '甲老师', subject: '语文', department: '高中部', grade: '高一年级', status: '在职' });
  await call('POST', '/att-hub/roster', {}, { name: '乙老师', subject: '语文', department: '高中部', grade: '高二年级', status: '在职' });
  await call('POST', '/att-hub/roster', {}, { name: '丙老师', subject: '数学', department: '高中部', grade: '高一年级', status: '在职' });

  const v = await call('GET', '/org/subjects');
  const chinese = v.list.find((s) => s.name === '语文');
  const math = v.list.find((s) => s.name === '数学');
  assert.ok(chinese, '花名册里有的学科要自动进科目表');
  assert.equal(chinese.count, 2);
  assert.equal(chinese.category, '语言与人文');
  assert.equal(math.count, 1);
  assert.equal(math.category, '数学与科学');
  /* 分类去重数与列表一致 */
  assert.equal(v.categories.length, new Set(v.list.map((s) => s.category)).size);
});

test('新增 / 重名 / 改名同步花名册 / 删除保留教师', async () => {
  const before = await call('GET', '/org/subjects');
  const added = await call('POST', '/org/subjects', {}, { name: '信息技术' });
  const it = added.list.find((s) => s.name === '信息技术');
  assert.ok(it, '新增后科目列表里要有');
  assert.equal(it.category, '数学与科学');
  assert.equal(it.count, 0, '没有教师教的科目人数为 0');

  const dup = await handle('POST', '/org/subjects', {}, { name: '信息技术' });
  assert.equal(dup.ok, false, '重名要拦住');

  const empty = await handle('POST', '/org/subjects', {}, { name: '  ' });
  assert.equal(empty.ok, false, '空名要拦住');

  /* 改名：花名册里同一学科的教师跟着改，人数不会掉成 0 */
  const renamed = await call('PATCH', `/org/subjects/${encodeURIComponent(it.id)}`, {}, { name: '通用技术' });
  assert.ok(renamed.list.some((s) => s.name === '通用技术'));
  assert.ok(!renamed.list.some((s) => s.name === '信息技术'));

  const teacher = (await call('GET', '/att-hub/roster', { q: '甲老师' })).list[0];
  const chinese = before.list.find((s) => s.name === '语文');
  await call('PATCH', `/org/subjects/${encodeURIComponent(chinese.id)}`, {}, { name: '语文阅读' });
  const after = (await call('GET', '/att-hub/roster', { q: '甲老师' })).list[0];
  assert.equal(after.subject, '语文阅读', '科目改名要同步教师学科');
  assert.equal(after.name, teacher.name);

  /* 删除科目：只删科目本身，教师资料一条不动 */
  const del = await call('DELETE', `/org/subjects/${encodeURIComponent(it.id)}`);
  assert.ok(!del.list.some((s) => s.id === it.id), '删除后科目列表里不该再有');
  const kept = (await call('GET', '/att-hub/roster', { q: '甲老师' })).list[0];
  assert.equal(kept.subject, '语文阅读');
  assert.equal(kept.name, '甲老师');
});

test('教师管理：旧工作台的人会补进名单、新增自动排序号、重复读取不重复插', async () => {
  /* 旧版工作台的花名册存 teachers 表（没有部门字段），组织管理读花名册主数据 */
  await call('POST', '/teachers', {}, { grade: '高一年级', items: [{ name: '旧表老师', subject: '历史' }] });
  const v1 = await call('GET', '/org/teachers');
  const hit = v1.list.filter((t) => t.name === '旧表老师');
  assert.equal(hit.length, 1, '旧表里的人在教师管理里要能看到');
  assert.equal(hit[0].department, '高中部', '补进来时按年级归属带出部门');
  assert.ok(String(hit[0].teacher_id || '').length, '补进来的人也要有教师序号');

  const v2 = await call('GET', '/org/teachers');
  assert.equal(v2.list.filter((t) => t.name === '旧表老师').length, 1, '重复读取不能重复插');

  const made = await call('POST', '/org/teachers', {}, {
    name: '新来老师', subject: '地理', department: '高中部', grade: '高二年级', status: '在职',
  });
  assert.ok(made.list.some((t) => t.name === '新来老师'));
  const next = made.list.filter((t) => t.name === '新来老师')[0];
  assert.equal(Number(next.teacher_id) > 0, true, '新增教师要有序号');

  const edited = await call('PATCH', `/org/teachers/${encodeURIComponent(next.id)}`, {}, { name: '新来老师', subject: '地理', grade: '高二年级' });
  assert.equal(edited.list.find((t) => String(t.id) === String(next.id)).name, '新来老师');

  const del = await call('DELETE', `/org/teachers/${encodeURIComponent(next.id)}`);
  assert.ok(!del.list.some((t) => String(t.id) === String(next.id)), '删除后名单里不该再有');
});

test('组织管理页：四个页签、统计卡、底部提示、导航与路由接线', async () => {
  const js = await read('js/attendance-org.js');
  for (const label of ['部门管理', '年级管理', '教师管理', '科目管理']) {
    assert.ok(js.includes(`label: '${label}'`), `缺页签 ${label}`);
  }
  /* 设计稿上的关键文案 */
  assert.ok(js.includes('每行均可编辑、删除'));
  assert.ok(js.includes('＋ 新建部门后，这里自动多一行；部门下新建年级，花名册自动多一个分表页签'));
  assert.ok(js.includes('＋ 新建年级后，这里自动多一条'));
  assert.ok(js.includes('＋ 新增教师后，这里自动多一条'));
  assert.ok(js.includes('＋ 新增科目后，这里自动多一条'));
  /* 四个页签各自的统计卡口径 */
  assert.ok(js.includes("label: '部门总数'") && js.includes("label: '在编教师'"));
  assert.ok(js.includes("label: '年级总数'"));
  assert.ok(js.includes("label: '教师总数'") && js.includes("label: '覆盖科目'"));
  assert.ok(js.includes("label: '科目总数'") && js.includes("label: '科目分类'"));

  const nav = await read('js/ui.js');
  assert.match(nav, /\{ id: 'organization', label: '组织管理'/, '考勤二级导航要叫组织管理');
  assert.ok(!nav.includes("label: '部门管理', icon"), '旧的「部门管理」二级项不应再出现');

  const work = await read('js/work.js');
  assert.match(work, /raw === 'organization'/);
  assert.match(work, /attendance-org\.js/);

  const css = await read('css/attendance-org.css');
  for (const cls of ['.org-tabs', '.org-tab.on', '.org-stats', '.org-row', '.org-foot']) {
    assert.ok(css.includes(cls), `缺样式 ${cls}`);
  }

  const sw = await read('sw.js');
  assert.ok(sw.includes("./js/attendance-org.js'"), 'SW 要缓存页面脚本');
  assert.ok(sw.includes("./css/attendance-org.css'"), 'SW 要缓存页面样式');
  assert.match(sw, /const CACHE = 'wb-v\d+-[^']+'/);
});

test('教师名单分页：每页 10 / 20 条，右下角分页器，切条数回到第 1 页', async () => {
  const js = await read('js/attendance-org.js');

  /* 只给教师名单加 10 / 20，两档都要有，默认 20 */
  assert.match(js, /const TEACHER_PAGE_SIZES = \[10, 20\];/);
  assert.match(js, /const TEACHER_PAGE_DEFAULT = 20;/);
  assert.match(js, /const TEACHER_PAGE_KEY = 'org\.teacherPageSize';/);

  /* 记忆选择：读不出来就落默认，写失败（隐私模式）不报错 */
  assert.match(js, /function readTeacherPageSize\(\)[\s\S]{0,220}TEACHER_PAGE_SIZES\.includes\(n\) \? n : TEACHER_PAGE_DEFAULT/);
  assert.match(js, /function saveTeacherPageSize\(n\)[\s\S]{0,140}localStorage\.setItem\(TEACHER_PAGE_KEY, String\(n\)\)/);

  /* 分页器结构：左侧范围 + 上一页 / 页码 / 下一页 + 每页条数 */
  assert.match(js, /class="org-pager"/);
  assert.match(js, /id="org-page-total">显示 \$\{start \+ 1\}–\$\{start \+ pageList\.length\} 条 \/ 共 \$\{list\.length\} 名教师/);
  assert.match(js, /id="org-prev"/);
  assert.match(js, /id="org-next"/);
  assert.match(js, /id="org-pagesize"/);

  /* 序号跟着整份名单走，翻页不从头数 */
  assert.match(js, /<span class="org-no">\$\{start \+ i \+ 1\}<\/span>/);

  /* 切每页条数后回到第 1 页并记住 */
  assert.match(js, /S\.pageSize = TEACHER_PAGE_SIZES\.includes\(n\) \? n : TEACHER_PAGE_DEFAULT;[\s\S]{0,80}S\.page = 1;/);
  assert.match(js, /saveTeacherPageSize\(S\.pageSize\)/);

  /* 数据变少（删教师 / 重载）时页码要收回到有效范围 */
  assert.match(js, /S\.page = Math\.min\(Math\.max\(1, S\.page\), pages\)/);

  /* 只有教师页签带分页器，其他三个页签不传 pager */
  const deptBody = js.slice(js.indexOf('function paintDept'), js.indexOf('function paintGrade'));
  const gradeBody = js.slice(js.indexOf('function paintGrade'), js.indexOf('/* ---------------- 教师管理'));
  const subjectBody = js.slice(js.indexOf('function paintSubject'), js.indexOf('/* ---------------- 行内操作绑定'));
  for (const [name, body] of [['部门', deptBody], ['年级', gradeBody], ['科目', subjectBody]]) {
    assert.ok(!body.includes('org-pager'), `${name}页签不该出现分页器`);
  }

  const css = await read('css/attendance-org.css');
  for (const cls of ['.org-pager {', '.org-pager-right', '.org-pagesize', '.org-btn.ghost', '.org-btn:disabled']) {
    assert.ok(css.includes(cls), `缺分页样式 ${cls}`);
  }
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.org-pager \{ justify-content: center; \}/);
});
