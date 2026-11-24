import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const files = [
  '_headers',
  'index.html',
  'app.html',
  'manifest.webmanifest',
  'sw.js',
  'app.js',
  'student.html',
  'teacher.html',
  'student.bundle.js',
];
/* tools/ 也要进 dist：tools/normalize-class.html 是历史班级数据清洗页，
   老师要在线上直接打开用；不加进来线上就是 404。 */
const directories = ['assets', 'css', 'icons', 'js', 'previews', 'tools'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) {
  await cp(path.join(root, file), path.join(output, file));
}
for (const directory of directories) {
  await cp(path.join(root, directory), path.join(output, directory), { recursive: true });
}
console.log(output);
