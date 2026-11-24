import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (await readFile(new URL('../js/realtime.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

/* 曾经的 BUG：onclose 用「距连接尝试满 10 秒」当"曾经通"的判据清零 tries。
   被墙 / 表没发布的连接握手挂住从不推 phx_reply，却每轮满 10 秒后才关闭，
   于是 tries 被反复清零 → 永远走 tries===1 的 0ms 分支，控制台刷屏「0ms 后重试」。
   修法：只有 status 到过 live 且稳住 5 秒（isLived）才清零。 */
test('断线清零重连次数按"真通且稳住"判，不再按墙钟', () => {
  assert.match(src, /const LIVE_GRACE_MS = \d+;/, '有最短在线时长门槛');
  assert.match(src, /st\.status === 'live'[\s\S]{0,180}Date\.now\(\) - st\.since >= LIVE_GRACE_MS/, 'onclose 要求既 live 又稳住');
  assert.match(src, /if \(isLived\(\)\) st\.tries = 0;/, '只有稳住 5 秒的连接才清零');
  assert.doesNotMatch(src, /Date\.now\(\) - \(st\.openAt[^)]*\) > \d+\) st\.tries/, '不再有 openAt 墙钟清零的旧判据');
  assert.doesNotMatch(src, /markOpen|st\.openAt/, 'openAt/markOpen 这套已随之删除，不留死代码');
});

test('健康信号由 phx_reply 亮绿灯，但清零交给 isLived', () => {
  const reply = src.slice(src.indexOf("case 'phx_reply'"), src.indexOf("case 'phx_error'"));
  assert.match(reply, /setStatus\('live'\)/, '收到 ok 回执才亮绿灯');
  assert.doesNotMatch(reply, /st\.tries = 0;/, '不在这里清零——回一条 ok 就断的坏连接会借它刷屏');
});

test('退避曲线不变：第一次 0ms 立即重来，之后 1s→30s 封顶', () => {
  assert.match(src, /st\.tries === 1 \? 0 :/, '保留"首次失败立即重试"的设计');
  assert.match(src, /Math\.min\(30000, 1000 \* Math\.pow\(2, Math\.min\(st\.tries - 2, 5\)\)\)/, '指数退避封顶 30 秒');
});

/* 真正的刷屏根因：服务端回 phx_reply{status:'error'} 时以前也当成"通了"，
   tries 被清成 0 → 每轮都 0ms 重连 → 浏览器一条接一条打 WebSocket failed。 */
test('phx_reply error 不清零重连次数、不亮绿灯，只报订阅被拒', () => {
  const reply = src.slice(src.indexOf("case 'phx_reply'"), src.indexOf("case 'phx_error'"));
  assert.match(reply, /m\.payload\?\.status === 'ok'/, '只有 ok 回执才算真通');
  const okBranch = reply.slice(reply.indexOf("=== 'ok'"), reply.indexOf("else if"));
  assert.doesNotMatch(okBranch, /st\.tries = 0/, '单条 ok 回执不能立刻清零（回一条就断的坏连接会刷屏）');
  assert.match(okBranch, /setStatus\('live'\)/, 'ok 才亮绿灯');
  const errorBranch = reply.slice(reply.indexOf('else if'));
  assert.match(errorBranch, /status === 'error'/, 'error 回执单独处理');
  assert.match(errorBranch, /wb:realtime-denied/, 'error 回执走"订阅被拒"提示');
  assert.doesNotMatch(errorBranch, /st\.tries = 0/, 'error 绝不重置退避');
  assert.doesNotMatch(errorBranch, /setStatus\('live'\)/, 'error 绝不假装连上');
});

test('连续失败有上限，外部明确信号才重新给重试额度', () => {
  assert.match(src, /const MAX_TRIES = \d+;/, '有重试上限');
  assert.match(src, /if \(st\.tries >= MAX_TRIES\)/, '到上限就停手，不再刷控制台');
  assert.match(src, /export function start\(\)[\s\S]*?st\.tries = 0;/, '新一轮会话重置额度');
  assert.match(src, /reconnect\('网络恢复', true\)/, '网络恢复给新额度');
  assert.match(src, /reconnect\('页面回到前台，连接已断', true\)/, '页面回前台给新额度');
});
