import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (await readFile(new URL('../student.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const read = async (p) => (await readFile(new URL(p, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

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

test('任务页是固定展示框：富文本安全渲染、任务类型来自教师输入、字号由编辑器格式决定', () => {
  if (src.includes('学生端 · 今日任务')) return;
  /* 固定展示框 class 落在有任务与空态两张卡上 */
  assert.match(src, /stu-task-card stu-task-display/, '任务卡带展示框 class');
  /* 富文本必须经白名单净化后才进 innerHTML，避免教师端粘贴的脚本/事件属性穿透 */
  assert.match(src, /import \{ sanitizeTaskHtml \} from '\.\/js\/rich-text\.mjs'/);
  assert.match(src, /const body = sanitizeTaskHtml\(t\.content\)/);
  assert.match(src, /<div class="st-card-body">\$\{body\}/);
  /* 任务类型不再写死「课堂自习」，由教师端 task_type 下发，旧数据才回落默认值 */
  assert.match(src, /任务类型：\$\{esc\(t\.task_type \|\| '课堂自习'\)\}/);
  /* v400 的全局字号下发链路已整体移除：字号/颜色/对齐全部由编辑器内联格式决定 */
  assert.doesNotMatch(src, /--task-font-size/);
  assert.doesNotMatch(src, /taskFontSize\(/);
  assert.doesNotMatch(src, /link\?\.display|link\.display/);
  assert.doesNotMatch(src, /beforeDisplay/);
  /* 两个按钮与弹层彻底移除，避免留空指针绑定 */
  assert.doesNotMatch(src, /id="st-view"/);
  assert.doesNotMatch(src, /id="st-save"/);
  assert.doesNotMatch(src, /openTaskModal/);
  assert.doesNotMatch(src, /保存任务图/);
});

test('教师后台：任务类型自由输入、Word 式编辑器、左右分栏，全局字号滑块已删除', async () => {
  const ss = await read('../js/selfstudy.js');
  /* 任务类型：可手输，默认「课堂自习」，空值回落，写进 payload */
  assert.match(ss, /id="ssm-type"/);
  assert.match(ss, /maxlength="20"/);
  assert.match(ss, /task_type: '课堂自习'/, '表单默认值');
  assert.match(ss, /task_type: form\.task_type\.trim\(\) \|\| '课堂自习'/, '保存时回落');
  assert.match(ss, /form\.task_type = e\.target\.value/, '输入即写回表单');
  /* Word 式编辑器：工具栏 + contenteditable 纸面 + execCommand */
  assert.match(ss, /class="rt-editor/);
  assert.match(ss, /id="rt-size"/, '字号下拉属于编辑器格式，需保留');
  assert.match(ss, /data-rt="justifyCenter"/);
  assert.match(ss, /data-rt="removeFormat"/);
  assert.match(ss, /id="ssm-content" contenteditable="true"/);
  assert.match(ss, /taskHtmlForEditor\(form\.content\)/, '编辑器初值兼容新旧数据');
  assert.match(ss, /document\.execCommand/);
  /* 字数统计、500 字上限、任务图 PNG 都走纯文本降级；保存走净化后的 HTML */
  assert.match(ss, /taskPlainText\(form\.content\)/);
  assert.match(ss, /content: taskPlainText\(form\.content\)/, 'PNG 降级为纯文本');
  assert.match(ss, /content: sanitizeTaskHtml\(form\.content\)/, '入库前净化');
  /* 布局：左大编辑区 + 右发布设置/任务列表 */
  assert.match(ss, /class="ssm-page"/);
  assert.match(ss, /class="ssm-page-side"/);
  assert.match(ss, /发布设置/);
  assert.match(ss, /await syncMaterialSharing\(\)/);
  /* v400 的「学生端任务展示」全局字号配置整条链路已删除 */
  assert.doesNotMatch(ss, /studentTaskDisplay/);
  assert.doesNotMatch(ss, /ss-task-font/);
  assert.doesNotMatch(ss, /学生端任务展示/);
});

test('本地与云端学生接口都下发 task_type，且不再下发 display 配置', async () => {
  const local = await read('../js/localapi.js');
  const cloud = await read('../supabase/functions/student-api/handler.mjs');
  for (const [name, code] of [['localapi', local], ['handler', cloud]]) {
    assert.match(code, /task_type: t\.task_type \|\| ''/, name + ' 下发任务类型，旧任务回落空串');
    assert.doesNotMatch(code, /display: taskDisplay/, name + ' 不再下发 display');
    assert.doesNotMatch(code, /studentTaskDisplay/, name + ' 不再读全局字号 meta');
    assert.doesNotMatch(code, /savedTaskFont/, name + ' 不再做 18–48 边界收敛');
  }
  /* 云端有主接口与自习接口两处下发白名单，必须同步 */
  assert.equal((cloud.match(/task_type: t\.task_type \|\| ''/g) || []).length, 2, 'handler 两处白名单都要带 task_type');
});

test('本地表字段白名单包含 task_type，否则新字段会被本地库丢掉', async () => {
  const db = await read('../js/localdb.js');
  const line = db.match(/selfstudy_tasks:\s*\[([^\]]+)\]/);
  assert.ok(line, '找到 selfstudy_tasks 字段定义');
  assert.match(line[1], /'task_type'/);
});

test('富文本模块同时被教师端与学生端引用，且已列入 SW 资源清单', async () => {
  const ss = await read('../js/selfstudy.js');
  const sw = await read('../sw.js');
  assert.match(ss, /from '\.\/rich-text\.mjs'/);
  assert.match(src, /from '\.\/js\/rich-text\.mjs'/);
  assert.match(sw, /'\.\/js\/rich-text\.mjs'/, 'SW 必须缓存富文本模块');
  assert.match(sw, /const CACHE = 'wb-v\d{3,}[^']*'/, '缓存版本沿用 v402 之后递增的命名');
});

test('标签页图标是「课」，不再让浏览器去要仓库里没有的 favicon.ico', () => {
  if (src.includes('学生端 · 今日任务')) return;
  const icon = src.match(/<link rel="icon" href="([^"]+)">/);
  assert.ok(icon, 'student.html 要有自己的 favicon 声明');
  assert.match(icon[1], /^data:image\/svg\+xml,/);
  assert.ok(decodeURIComponent(icon[1]).includes('课'), '图标里就是「课」这个字');
});
