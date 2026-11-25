/* 花名册排序 + 分页器：序号 1→100 升序、每页可选 10/20/50/100 落右下角 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const D = await import('../js/attendance-hub-domain.mjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

test('花名册按教师序号升序：1 号在最前、100 号在最后', () => {
  /* 后端默认按 id 倒序返回（最新录入在前），这就是「100 号在最上面」的来源 */
  const rows = [
    { id: 4, teacher_id: '100' },
    { id: 3, teacher_id: '99' },
    { id: 2, teacher_id: '1' },
    { id: 1, teacher_id: 'T-0010' },
  ];
  const sorted = D.sortHubRows('roster', rows).map((r) => r.teacher_id);
  assert.deepEqual(sorted, ['1', 'T-0010', '99', '100']);
  /* 不改入参数组，只返回新数组 */
  assert.equal(rows[0].teacher_id, '100');
});

test('没有序号的花名册记录排最后，序号相同按 id 升序保持稳定', () => {
  const rows = [
    { id: 9, teacher_id: '' },
    { id: 5, teacher_id: '2' },
    { id: 3, teacher_id: '2' },
    { id: 7, teacher_id: null },
  ];
  const sorted = D.sortHubRows('roster', rows);
  assert.deepEqual(sorted.slice(0, 2).map((r) => r.id), [3, 5], '同号按 id 升序');
  assert.deepEqual(sorted.slice(2).map((r) => r.id).sort(), [7, 9], '空序号排最后');
});

test('其余 4 张记录表保持后端默认顺序，不被教师序号重排', () => {
  const rows = [
    { id: 3, teacher_id: '100', date: '2026-11-26' },
    { id: 2, teacher_id: '1', date: '2026-11-25' },
  ];
  for (const key of ['duty', 'class', 'leave', 'stats']) {
    assert.deepEqual(D.sortHubRows(key, rows).map((r) => r.id), [3, 2], `${key} 不该重排`);
  }
  assert.deepEqual(D.sortHubRows('roster', null), [], '空数据不报错');
});

test('页面接入排序，分页器提供 10/20/50/100 且靠右下角', async () => {
  const js = await readFile(path.join(root, 'js/attendance-hub.js'), 'utf8');
  assert.match(js, /sortHubRows/, '列表必须走升序排序');
  assert.match(js, /const PAGE_SIZES = \[10, 20, 50, 100\]/);
  assert.match(js, /id="ahub-pagesize"/);
  /* 切每页条数后回到第 1 页，避免停在不存在的页码 */
  assert.match(js, /S\.pageSize = PAGE_SIZES\.includes\(n\) \? n : DEFAULT_PAGE_SIZE;[\s\S]{0,80}S\.page = 1;/);

  const css = await readFile(path.join(root, 'css/attendance-hub.css'), 'utf8');
  const pager = css.match(/\.ahub-pager \{[\s\S]*?\}/);
  assert.ok(pager, '缺少 .ahub-pager 样式');
  assert.match(pager[0], /justify-content: space-between/);
  assert.match(css, /\.ahub-pagesize select/);
});
