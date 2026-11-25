/* 兼容别名：roster-photo-parsers.mjs → roster-photo-parser.mjs
 *
 * 为什么留这个文件：
 * 这个模块在某个历史版本里曾经用过复数文件名，浏览器/Service Worker 里
 * 残留的旧 ocr.js 仍会按 `./roster-photo-parsers.mjs` 去请求。静态站点上
 * 一个模块 404 会让整条 import 链失败，最终表现为「整页停在仍在加载」，
 * 用户无论刷新多少次都进不去（除非手动清缓存）。
 * 这里用一行转发兜住这种旧引用，代价是几行代码，收益是页面永远不会因为
 * 一个文件名对不上而彻底打不开。
 *
 * 真身是 roster-photo-parser.mjs，新代码请直接引用它。
 */
export * from './roster-photo-parser.mjs';
