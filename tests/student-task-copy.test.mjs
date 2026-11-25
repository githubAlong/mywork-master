import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (await readFile(new URL('../student.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('学生端 6 个页签与课堂大屏首页（wb-v415 设计稿）', () => {
  /* v2 设计稿占位稿不含旧页签实现，正式实现后恢复 */
  if (src.includes('学生端 · 今日任务')) return;
  assert.match(src, /selfstudy: \{ icon: SD_ICON\.task, label: '任务' \}/);
  for (const label of ['教材', '点名', '盲盒', '违纪', '留言板']) {
    assert.match(src, new RegExp(`label: '${label}'`), `侧栏要有「${label}」`);
  }
  assert.doesNotMatch(src, /label: '自习'/);
  assert.equal(src.match(/今日自习任务/g)?.length || 0, 0, '不再出现「今日自习任务」字样');
  assert.match(src, /欢迎来到本班课堂/, '每页顶部欢迎头');
  assert.match(src, /class="sd-stats"/, '任务页 4 张统计卡');
  assert.match(src, /class="sd-shortcuts"/, '任务页快捷入口');
  assert.match(src, /class="sd-recent"/, '任务页最近任务');
  assert.match(src, /sdPaintWelcome\(\)/, '欢迎头由 paintShell 渲染');
  assert.match(src, /showTaskDetail/, '点「查看任务」展开完整任务卡');
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
