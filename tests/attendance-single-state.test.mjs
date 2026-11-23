import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  deriveRosterState, deriveTableGridState, resolveSingleGridState, updateTeacherGrid,
} from '../js/attendance-prd-domain.mjs';

const teacher = { id: 't1', name: '毕晓鸿', subject: '数学', grade: '高二', active: 1 };
const context = { date: '2026-11-23', period: 4, leaveRecords: [] };

test('一个人同一节只留一个状态：按优先级裁决，其余清成未登记', () => {
  const collapsed = resolveSingleGridState({
    class: 'y', sit: 'y', listen: 'y', research: 'y', leave: '病假', remark: '第4节',
  });
  assert.deepEqual(collapsed, {
    class: 'y', sit: 'u', listen: 'u', research: 'u', leave: '病假', remark: '第4节',
  });
  /* 「×」和 true（老数据里的布尔勾）一样算勾了，不能因为它不是 'y' 就当没登记。 */
  assert.equal(resolveSingleGridState({ sit: 'n', listen: true }).sit, 'n');
  assert.equal(resolveSingleGridState({ sit: 'n', listen: true }).listen, 'u');
  assert.equal(resolveSingleGridState({ sit: 'y', researchStatus: 'y' }).researchStatus, 'u');
  /* 没勾就不动对象：Status 键原本不存在时不能凭空补 'u'，
     界面按 listenStatus || listen 取值，多一个 'u' 会把真勾选项显示成空白。 */
  const clean = { class: 'u', sit: 'u', listen: 'u', research: 'u', leave: '', remark: '' };
  assert.equal(resolveSingleGridState(clean), clean);
  assert.equal('listenStatus' in resolveSingleGridState({ sit: 'y', listen: 'y' }), false);
});

test('子表里本次勾选排前面，坐班总表回显的排后面', () => {
  /* 上课表本表勾了听课、坐班总表还留着教研：这一格显示他手上这次勾选。 */
  const merged = { sit: 'u', class: 'u', listen: 'y', research: 'y', leave: '', remark: '' };
  const order = ['class', 'listen', 'sit', 'research'];
  assert.deepEqual(resolveSingleGridState(merged, order),
    { sit: 'u', class: 'u', listen: 'y', research: 'u', leave: '', remark: '' });
  /* 顺序反过来（教研表本表列是教研）就留教研，规则只认谁先看谁后看。 */
  const otherOrder = ['research', 'class', 'sit', 'listen'];
  assert.equal(resolveSingleGridState(merged, otherOrder).research, 'y');
  assert.equal(resolveSingleGridState(merged, otherOrder).listen, 'u');
});

test('历史数据里一格留了两个勾，读出来只显示优先级最高的那个', () => {
  const rows = [{ teacher: teacher.name, subject: teacher.subject, data: { __teacherGrid: {
    4: { class: 'y', sit: 'y', listen: 'u', research: 'y', leave: '', remark: '老数据' },
  } } }];
  const state = deriveTableGridState(teacher, 'seat', rows, context);
  assert.equal(state.class, 'y');
  assert.equal(state.sit, 'u');
  assert.equal(state.research, 'u');
  /* 只换显示：原始记录一个字都不动，月/年累计仍按落库的每一格算。 */
  assert.equal(rows[0].data.__teacherGrid['4'].sit, 'y');
  assert.equal(rows[0].data.__teacherGrid['4'].research, 'y');
});

test('勾选项和请假并存时，勾掉的那一格退回未登记而不是留着', () => {
  const rows = [];
  updateTeacherGrid(rows, teacher, 'seat', 4, 'class', 'y', context);
  updateTeacherGrid(rows, teacher, 'seat', 4, 'leave', '事假', context);
  const state = deriveTableGridState(teacher, 'seat', rows, context);
  assert.equal(state.leave, '事假');
  assert.equal(state.class, 'y');
  /* 循环点第三下（√→×→空白）之后这一格必须真的空掉，否则请假 + 空白勾会各算一次。 */
  updateTeacherGrid(rows, teacher, 'seat', 4, 'class', 'u', context);
  const after = deriveTableGridState(teacher, 'seat', rows, context);
  assert.equal(after.class, 'u');
  assert.equal(after.leave, '事假');
});

const source = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('请假记在坐班表的下拉里，另外两张表也认这一节的请假', () => {
  const seatRows = [];
  updateTeacherGrid(seatRows, teacher, 'seat', 4, 'class', 'y', context);
  updateTeacherGrid(seatRows, teacher, 'seat', 4, 'leave', '事假', context);
  const state = deriveRosterState(teacher, { ...context, seatRows, classRows: [], researchRows: [] });
  assert.equal(state.leave, '事假');
  /* 请假在优先级最前面：合并出来的这一节只剩请假，勾选项一律退回未登记。 */
  assert.equal(state.class, 'u');
});

test('界面接线：四个写入口都走同一套互斥，勾不动已请假的人', async () => {
  const js = await source('../js/attendance-prd.js');
  assert.match(js, /resolveSingleGridState,/, '要从 domain 模块拿裁决函数，界面不再自己拼优先级');
  assert.match(js, /const GRID_STATE_PRIORITY = \['class', 'sit', 'listen', 'research'\]/);
  assert.match(js, /const GRID_STATE_OWNERS = \{ sit:\['seat'\], class:\['seat','class'\], listen:\['seat','class'\], research:\['seat','research'\] \}/,
    '每一项归哪张表写，决定清冲突时要动哪几张表');
  /* 请假记在哪张表都可能：挡勾选项要看合并后的这一节，不能只看本表那一条。 */
  const leaveHelper = js.slice(js.indexOf('const rowLeaveOf'), js.indexOf('const clearOtherGridStates'));
  assert.match(leaveHelper, /deriveRosterState\(teacher, \{/);
  assert.match(leaveHelper, /seatRows: getDraftRows\('seat'\), classRows: getDraftRows\('class'\), researchRows: getDraftRows\('research'\)/);
  /* 显示层：坐班总表回显的格子也参与裁决，本表勾的排前面。 */
  assert.match(js, /return resolveSingleGridState\(state, GRID_STATE_PRIORITY\)/);
  assert.match(js, /return resolveSingleGridState\(merged, \[/);
  /* 点格子：接着屏幕上这一格循环，先挡掉已请假的人，再清别的表的旧勾。 */
  assert.match(js, /const shownAttr = ' data-grid-value="'\+value\+'"'/, '按钮要把屏上显示的值带出去，点击才接得上');
  const click = js.slice(js.indexOf("if (['class','sit','listen','research'].includes(key)) control.onclick"), js.indexOf("else if (key === 'remark')"));
  assert.match(click, /nextTriState\(control\.dataset\.gridValue \|\| state\[key\]\)/);
  assert.match(click, /const leaveText = rowLeaveOf\(teacher\);/);
  assert.match(click, /if \(value !== 'u' && leaveText\)/);
  assert.match(click, /await applyGridExclusiveStates\(teacher, tab, key, value\)/);
  /* 请假下拉：登记请假就把这一节的勾清掉，并且只落真正改过的表。 */
  const leave = js.slice(js.indexOf("else if (key === 'leave') control.addEventListener"), js.indexOf("else control.addEventListener"));
  assert.match(leave, /if \(value\) await clearGridStatesForLeave\(teacher, tab\)/);
  assert.match(js, /if \(owner !== currentType\) dirty\.add\(owner\)/,
    'getDraftRows(seat) 会给缺的人补空行，没改过的表不能顺手 persistDraft');
  /* 编辑弹窗与「新增」也走同一条路，不能再留一个能同时勾两项的入口。 */
  const editor = js.slice(js.indexOf("openEditor('编辑考勤记录 · '"), js.indexOf("root.querySelectorAll('[data-delete-work-record]')"));
  assert.match(editor, /const leaveText = rowLeaveOf\(teacher\);/);
  assert.match(editor, /GRID_STATE_PRIORITY\.find\(key=>after\[key\]==='y'\|\|after\[key\]==='n'\)/);
  assert.match(editor, /await applyGridExclusiveStates\(teacher, type, winner, after\[winner\]\)/);
  assert.match(editor, /throw new Error\(teacher\.name\+' 本时段已请假（'/);
  const add = js.slice(js.indexOf('const openAddRecord'), js.indexOf('const openAddSummary'));
  assert.match(add, /await applyGridExclusiveStates\(teacher, type, key, 'y'\)/);
  assert.match(add, /const leaveText = rowLeaveOf\(teacher\);/);
  assert.match(add, /if \(leaveText\) throw new Error/);
});

test('清完旧勾要告诉他动了哪张表，并提醒另一张表要点确认生成', async () => {
  const js = await source('../js/attendance-prd.js');
  const helper = js.slice(js.indexOf('const clearOtherGridStates'), js.indexOf('const worksheetEntries'));
  assert.match(helper, /updateWorksheet\(teacher, owner, otherKey, 'u'\)/);
  assert.match(helper, /if \(own\[otherKey\] !== 'y' && own\[otherKey\] !== 'n'\) continue/,
    '本来就没勾的表不要去写，否则白白给那张表造一条空记录');
  assert.match(helper, /persistDraft\(owner, \{ reload: false \}\)/, '跨表保存不能挤掉自动保存那一个待发槽位');
  assert.match(helper, /已清掉/, '要提示改了哪项');
  assert.match(helper, /有未确认变更，点确认生成后同步/, '另一张表的已确认结果还是旧的，要说清楚');
});
