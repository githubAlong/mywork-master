import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* 面板是单例的，一旦「内容换成 B 的候选、写入目标还指着 A」，选中就会串到别的字段。
   生产上真实踩过：先点开上课班级的面板，再到节次里打字，选中第9节 —— 班级框也被写成「第9节」。
   这里用源码不变量兜住，防止以后改成 updateChoices 一把梭。 */

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('updateChoices 只接受面板当前属主输入框的更新', () => {
  const source = read('js/choice-panel.mjs');
  assert.match(source, /const \{[^}]*\binput\b[^}]*\} = options;/);
  assert.match(source, /if \(input && state\.input !== input\) return;/);
  assert.match(source, /export function isChoicesFor\(input\)/);
});

test('可编辑输入框只在面板属于自己时就地刷新，否则另开面板', () => {
  const source = read('js/editable-choices.js');
  assert.match(source, /if \(isChoicesFor\(input\)\) updateChoices\(/);
  assert.ok(
    !/if \(isChoicesOpen\(\)\) updateChoices\(/.test(source),
    '不能再看「有没有面板」就 update，必须确认面板是自己的',
  );
  assert.match(source, /else show\(input\.value\);/);
});

test('班级选择器同样按属主判断，箭头点击可切到自己的面板', () => {
  const source = read('js/class-picker.mjs');
  assert.match(source, /if \(isChoicesFor\(input\)\) \{ closeChoices\(\); return; \}/);
  assert.ok(!/isChoicesOpen\(\)/.test(source), '班级选择器不该再按「面板开着」就整体关闭');
});

test('节次候选挂到 __choiceItems 后摘掉原生 datalist，避免两套下拉叠在一起', () => {
  const source = read('js/class-records.js');
  assert.match(source, /periodInput\.__choiceItems = periodChoices;/);
  assert.match(source, /periodInput\.removeAttribute\('list'\);/);
});
