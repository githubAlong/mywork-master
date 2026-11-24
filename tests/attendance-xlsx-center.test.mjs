import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './test-browser.mjs';

installBrowser({ href: 'http://localhost/' });
/* attendance.js 在模块顶层会碰 document/window，补齐这一层最小桩 */
globalThis.document.createElement = () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
globalThis.document.querySelector = () => null;
globalThis.document.querySelectorAll = () => [];
globalThis.document.body.appendChild = () => {};
globalThis.document.documentElement = { style: {}, classList: { add() {}, remove() {} } };

const { makeXlsx } = await import('../js/attendance.js?xlsx-center-test=1');

/* zip 用 store 方式（不压缩），所以直接把字节按 UTF-8 解码就能读到里面的 XML */
const decode = async (blob) => new TextDecoder('utf-8').decode(new Uint8Array(await blob.arrayBuffer()));

const grid = () => [
  ['高一年级教师坐班表'],
  ['2026-11-24 星期一 · 第1节（08:00—08:45）'],
  ['坐班 1 人 · 上课 1 人'],
  ['序号', '归属部门', '归属年级', '姓名', '学科', '坐班', '上课'],
  [1, '高中部', '高一', '李老师', '语文', '✓', ''],
  [2, '高中部', '高一', '王老师', '数学', '', '✓'],
  ['', '', '', '', '', '', '导出时间：2026-11-24 13:00:00'],
];

test('Excel 导出居中：抬头跨列合并、表头加粗灰底、数据格居中带边框', async () => {
  const xml = await decode(makeXlsx({ title: '坐班表', grid: grid(), center: true }));

  assert.match(xml, /xl\/styles\.xml/, '没有注入样式表，Excel 里就会左对齐');
  assert.match(xml, /<Override PartName="\/xl\/styles\.xml"/, '[Content_Types].xml 缺样式声明，WPS 会报文件损坏');
  assert.match(xml, /Target="styles\.xml"/, 'workbook 关系里缺 styles，Excel 不认样式');

  /* 三级抬头各占一行，都要跨到最后一列（G） */
  for (const row of [1, 2, 3]) assert.match(xml, new RegExp(`<mergeCell ref="A${row}:G${row}"/>`), `第 ${row} 行抬头没合并`);
  assert.match(xml, /<mergeCells count="3">/);

  /* 抬头三层字号/字重不同：一级 14 加粗、二级加粗、三级常规 */
  assert.match(xml, /r="A1" s="3"/);
  assert.match(xml, /r="A2" s="4"/);
  assert.match(xml, /r="A3" s="5"/);
  /* 表头行（第一格是「序号」）走 s=2：加粗 + 浅灰底 */
  assert.match(xml, /r="A4" s="2"/);
  assert.match(xml, /FFEEF3FA/);
  /* 数据格走 s=1：居中 + 细边框 */
  assert.match(xml, /r="F5" s="1"/);
  /* 末行「导出时间」写在最右列，第一格是空的，不能被当成抬头合并 */
  assert.doesNotMatch(xml, /mergeCell ref="A7:G7"/);
  assert.match(xml, /horizontal="center"/);
});

test('不传 center 的导出保持原样：没有样式表、没有合并、单元格不带样式', async () => {
  const xml = await decode(makeXlsx({ title: '考勤表', grid: grid() }));
  assert.doesNotMatch(xml, /styles\.xml/);
  assert.doesNotMatch(xml, /mergeCell/);
  assert.doesNotMatch(xml, /<c r="A1" s=/);
  assert.match(xml, /<c r="A5"><v>1<\/v><\/c>/, '序号列仍要写成数字，避免绿三角');
});
