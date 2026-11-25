import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['.git', '.wrangler', 'dist', 'node_modules'].includes(entry.name)) continue;
      out.push(...await walk(target));
    }
    else out.push(target);
  }
  return out;
}

const files = await walk(root);
const jsFiles = files.filter((file) => /\.(?:js|mjs)$/i.test(file)
  && !file.includes(`${path.sep}.git${path.sep}`));

for (const file of jsFiles) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) failures.push(`语法错误 ${path.relative(root, file)}\n${checked.stderr}`);
}

const swPath = path.join(root, 'sw.js');
const sw = await readFile(swPath, 'utf8');
const cacheMatches = [...sw.matchAll(/const CACHE\s*=\s*['"]([^'"]+)['"]/g)];
if (cacheMatches.length !== 1) failures.push(`Service Worker 必须只有一个缓存版本，实际 ${cacheMatches.length}`);

const assetBlock = /const ASSETS\s*=\s*\[([\s\S]*?)\];/.exec(sw);
if (!assetBlock) failures.push('没有找到 Service Worker ASSETS 清单');
const assets = new Set([...String(assetBlock?.[1] || '').matchAll(/['"]\.\/([^'"]+)['"]/g)]
  .map((match) => match[1].replaceAll('/', path.sep)));

for (const asset of assets) {
  try {
    const info = await stat(path.join(root, asset));
    if (!info.isFile()) failures.push(`Service Worker 资源不是文件：${asset}`);
  } catch {
    failures.push(`Service Worker 资源不存在：${asset}`);
  }
}

for (const file of jsFiles) {
  const relative = path.relative(root, file);
  if (relative.startsWith(`js${path.sep}`) && !assets.has(relative)) {
    failures.push(`JavaScript 未列入 Service Worker：${relative}`);
  }
}

/* 【模块引用必须指向真实存在的文件】
   静态站点没有打包器，浏览器按模块图逐个下载。只要有一个 import 指向
   不存在的文件名（改名后漏改、文件漏提交），这条链上的页面就会整页打不开，
   而且用户刷新也没用 —— 只能清缓存。2026-11 就出现过这种故障：
   报错的是一个从来没存在过的 roster-photo-parsers.mjs，页面停在「仍在加载」。
   把这类错误挡在提交/发布之前，比上线后再救便宜得多。 */
const SPECIFIER = /(?:\bfrom\s*|(?:^|[^\w$.])(?:import|require)\s*(?:\(\s*)?)['"]([^'"]+)['"]/g;
for (const file of jsFiles) {
  const relativeToRoot = path.relative(root, file);
  /* 只看我们自己写的 js/ 模块；assets/ 下是第三方打包文件（mammoth、pdf.js 等），
     里面的 require 走的是它们自己的打包器约定，不该由这份检查判定。 */
  if (!relativeToRoot.startsWith(`js${path.sep}`)) continue;
  const dir = path.dirname(file);
  const source = await readFile(file, 'utf8');
  const seen = new Set();
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    if (seen.has(specifier)) continue;
    seen.add(specifier);
    const resolved = path.resolve(dir, specifier.split('?')[0]);
    const candidates = [resolved, `${resolved}.mjs`, `${resolved}.js`, path.join(resolved, 'index.js')];
    let exists = false;
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) { exists = true; break; }
      } catch { /* 继续试下一个候选 */ }
    }
    if (!exists) failures.push(`引用了不存在的模块：${relativeToRoot} → ${specifier}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(JSON.stringify({
  jsFiles: jsFiles.length,
  serviceWorkerAssets: assets.size,
  cacheVersion: cacheMatches[0][1],
  syntax: 'passed',
  resources: 'complete',
}, null, 2));
