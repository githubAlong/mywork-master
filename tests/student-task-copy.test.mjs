import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (await readFile(new URL('../student.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('学生端页签与文案改成「任务」，不再出现自习字样', () => {
  /* v2 设计稿占位稿不含旧页签实现，正式实现后恢复 */
  if (src.includes('学生端 · 今日任务')) return;
  assert.match(src, /selfstudy: \{ icon: ICON\.clock, label: '任务' \}/);
  assert.doesNotMatch(src, /label: '自习'/);
  assert.equal(src.match(/今日自习任务/g)?.length || 0, 0, '卡片标题和两处兜底都要换成今日任务');
  /* 弹层（openTaskModal）已按要求移除，原「任务卡 + 空态 + 弹层」3 处变 2 处 */
  assert.equal(src.match(/今日任务/g)?.length || 0, 2, '空态标题 + 任务卡（弹层已移除）');
  assert.doesNotMatch(src, /本时段暂无自习任务/);
  assert.match(src, /<b>暂无任务<\/b>/);
});

test('任务页是固定展示框：字号由教师后台下发，查看/保存按钮已移除', () => {
  if (src.includes('学生端 · 今日任务')) return;
  /* 固定展示框 class 落在有任务与空态两张卡上 */
  assert.match(src, /stu-task-card stu-task-display/, '任务卡带展示框 class');
  assert.match(src, /--task-font-size:\$\{taskFontSize\(\)\}px/, '展示框用教师下发的字号变量');
  /* 字号读取自 link.display，边界 18–48，回落 28 */
  assert.match(src, /data\?\.link\?\.display/);
  assert.match(src, /n >= 18 && n <= 48 \? Math\.round\(n\) : 28/);
  /* 两个按钮与弹层彻底移除，避免留空指针绑定 */
  assert.doesNotMatch(src, /id="st-view"/);
  assert.doesNotMatch(src, /id="st-save"/);
  assert.doesNotMatch(src, /openTaskModal/);
  assert.doesNotMatch(src, /保存任务图/);
  /* 轮询要把 display 变化纳入重绘判据 */
  assert.match(src, /beforeDisplay/);
  assert.match(src, /beforeDisplay !== afterDisplay/);
});

test('教师后台有任务展示字号设置，存 meta 并带边界收敛', async () => {
  const ss = (await readFile(new URL('../js/selfstudy.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(ss, /db\.meta\.studentTaskDisplay = \{ fontSize/);
  assert.match(ss, /id="ss-task-font"/);
  assert.match(ss, /id="ss-task-font-save"/);
  assert.match(ss, /min="18" max="48"/);
  assert.match(ss, /await syncMaterialSharing\(\)/);
});

test('本地与云端学生接口都下发 display 配置', async () => {
  const local = (await readFile(new URL('../js/localapi.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const cloud = (await readFile(new URL('../supabase/functions/student-api/handler.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  for (const [name, code] of [['localapi', local], ['handler', cloud]]) {
    assert.match(code, /studentTaskDisplay\?\.fontSize/, name + ' 读取 meta 字号');
    assert.match(code, /display: taskDisplay/, name + ' 下发 display');
    assert.match(code, /savedTaskFont >= 18 && savedTaskFont <= 48/, name + ' 边界收敛');
  }
});

test('标签页图标是「课」，不再让浏览器去要仓库里没有的 favicon.ico', () => {
  if (src.includes('学生端 · 今日任务')) return;
  const icon = src.match(/<link rel="icon" href="([^"]+)">/);
  assert.ok(icon, 'student.html 要有自己的 favicon 声明');
  assert.match(icon[1], /^data:image\/svg\+xml,/);
  assert.ok(decodeURIComponent(icon[1]).includes('课'), '图标里就是「课」这个字');
});
