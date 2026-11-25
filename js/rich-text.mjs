/* ============================================================================
   rich-text.mjs —— 自习任务「Word 式」内容的统一处理
   ----------------------------------------------------------------------------
   教师在自习管理页用 contenteditable 排版，content 字段存的是 HTML。
   教师端、学生端、任务图生成、预览都走同一套逻辑：

   1) sanitizeTaskHtml()  按白名单过滤 HTML 后再 innerHTML，杜绝脚本注入
   2) taskPlainText()     降级成纯文本，用于字数统计 / PNG 生成 / 变化比较
   3) taskHtmlForEditor() 把旧纯文本与新 HTML 统一成编辑器初值

   为什么用自己写的字符串 tokenizer 而不是 DOMParser：
     · 浏览器和 Node（测试）行为一致，不依赖 DOM 实现差异
     · 白名单 + 属性过滤 + 标签配对都在一处，安全审计一眼能看完
     · 老师的内容会在 localapi / Edge Function / 云端快照多处流转，
       任何一处被塞进 <img onerror> 都会在学生机上执行，必须兜住
   ========================================================================== */

/* contenteditable 的 execCommand('fontSize') 只接受 1–7，用这张表换成 px。 */
export const FONT_SIZES = [
  { size: 1, px: 12, label: '12' },
  { size: 2, px: 14, label: '14' },
  { size: 3, px: 16, label: '16' },
  { size: 4, px: 18, label: '18' },
  { size: 5, px: 24, label: '24' },
  { size: 6, px: 30, label: '30' },
  { size: 7, px: 36, label: '36' },
];
const PX_BY_SIZE = Object.fromEntries(FONT_SIZES.map((x) => [String(x.size), x.px]));

const ALLOWED_TAGS = new Set([
  'P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE',
  'UL', 'OL', 'LI', 'H3', 'H4', 'H5', 'BLOCKQUOTE', 'FONT',
]);
const VOID_TAGS = new Set(['BR']);
const ALLOWED_STYLES = new Set([
  'font-size', 'color', 'text-align', 'font-weight', 'font-style',
  'text-decoration', 'text-decoration-line', 'line-height', 'background-color',
]);
const ALIGN_VALUES = new Set(['left', 'center', 'right', 'justify', 'start', 'end']);
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgb\(\s*[\d\s,.]+\s*\)|rgba\(\s*[\d\s,.]+\s*\)|[a-z]{3,20})$/i;
const SIZE_RE = /^(\d{1,3}(?:\.\d+)?)px$/i;

function safeStyle(raw) {
  const out = [];
  for (const part of String(raw || '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (!ALLOWED_STYLES.has(key) || !val) continue;
    let ok = false;
    if (key === 'font-size') ok = SIZE_RE.test(val) && parseFloat(val) >= 8 && parseFloat(val) <= 96;
    else if (key === 'color' || key === 'background-color') ok = COLOR_RE.test(val);
    else if (key === 'text-align') ok = ALIGN_VALUES.has(val.toLowerCase());
    else if (key === 'font-weight') ok = /^(normal|bold|[1-9]00)$/i.test(val);
    else if (key === 'font-style') ok = /^(normal|italic|oblique)$/i.test(val);
    else if (key === 'text-decoration' || key === 'text-decoration-line') ok = /^(none|underline|line-through|overline)(\s+(none|underline|line-through|overline))*$/i.test(val);
    else if (key === 'line-height') ok = /^(\d{1,2}(\.\d+)?|\d{1,3}px|\d{1,3}%)$/i.test(val);
    if (ok) out.push(`${key}:${val}`);
  }
  return out.join(';');
}

/* 从一段标签文本里取出 name 和白名单属性，返回净化后的开标签字符串；
   不允许的标签返回 ''（只丢弃标签本身，文字内容仍保留）。 */
function parseOpenTag(raw) {
  const m = raw.match(/^<\s*([a-zA-Z][a-zA-Z0-9]*)\b([\s\S]*?)\/?\s*>$/);
  if (!m) return null;
  let tag = m[1].toUpperCase();
  const attrs = m[2] || '';
  if (!ALLOWED_TAGS.has(tag)) return null;

  const get = (name) => {
    const re = new RegExp(`${name}\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, 'i');
    const hit = attrs.match(re);
    return hit ? (hit[2] ?? hit[3] ?? hit[4] ?? '') : '';
  };

  let style = safeStyle(get('style'));
  const align = get('align').toLowerCase();
  if (ALIGN_VALUES.has(align)) style = safeStyle(`${style};text-align:${align}`);

  /* execCommand('fontSize'/'foreColor') 常产出 <font size color>，转成 span */
  if (tag === 'FONT') {
    const size = get('size');
    const color = get('color');
    const extra = [];
    if (size && PX_BY_SIZE[size]) extra.push(`font-size:${PX_BY_SIZE[size]}px`);
    if (color && COLOR_RE.test(color)) extra.push(`color:${color}`);
    const merged = [style, ...extra].filter(Boolean).join(';');
    return { tag: 'SPAN', self: false, html: `<span${merged ? ` style="${merged}"` : ''}>` };
  }

  if (VOID_TAGS.has(tag)) return { tag, self: true, html: `<${tag.toLowerCase()}>` };
  return { tag, self: false, html: `<${tag.toLowerCase()}${style ? ` style="${style}"` : ''}>` };
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'H3', 'H4', 'H5', 'BLOCKQUOTE', 'LI', 'UL', 'OL']);

/** 把任意输入（HTML 或旧纯文本）安全地转成可 innerHTML 的 HTML 字符串 */
export function sanitizeTaskHtml(input) {
  const raw = String(input ?? '');
  if (!raw.trim()) return '';
  if (!isRichHtml(raw)) return plainToHtml(raw);

  const out = [];
  const stack = [];
  /* 按标签切分，文本段与标签段交替 */
  const parts = raw.split(/(<[^>]*>)/g).filter((s) => s !== '');
  for (const part of parts) {
    if (!part.startsWith('<')) {
      /* 文本段：把可能出现的裸 < 转义，其余原样（教师输入的文字） */
      out.push(part.replace(/</g, '&lt;'));
      continue;
    }
    const close = part.match(/^<\s*\/\s*([a-zA-Z][a-zA-Z0-9]*)\s*>$/);
    if (close) {
      const tag = close[1].toUpperCase();
      if (!ALLOWED_TAGS.has(tag) || VOID_TAGS.has(tag)) continue;
      /* 只闭合确实开过、且位于栈顶的标签，避免不配对标签穿透 */
      const idx = stack.lastIndexOf(tag);
      if (idx < 0) continue;
      while (stack.length > idx) {
        const t = stack.pop();
        out.push(`</${t.toLowerCase()}>`);
      }
      continue;
    }
    const open = parseOpenTag(part);
    if (!open) continue; /* 危险/无关标签：丢标签，文字保留 */
    if (open.self) { out.push(open.html); continue; }
    out.push(open.html);
    stack.push(open.tag);
  }
  while (stack.length) out.push(`</${stack.pop().toLowerCase()}>`);
  return out.join('');
}

/** 是否已是富文本 HTML（旧数据是纯文本，不能当 HTML 解析） */
export function isRichHtml(input) {
  return /<\s*(p|div|br|span|b|strong|i|em|u|s|ul|ol|li|h[1-6]|font|blockquote)\b/i.test(String(input ?? ''));
}

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 纯文本按行拆成段落，多行转成 ol/li */
export function plainToHtml(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  const items = lines.map((line) => line.replace(/^\s*(?:\d+[.、)]|[-•])\s*/, ''));
  if (items.length > 1) return `<ol>${items.map((x) => `<li>${escText(x)}</li>`).join('')}</ol>`;
  return `<div>${escText(items[0])}</div>`;
}

/** 编辑器初值：新数据用净化后的 HTML，旧纯文本转成段落 */
export function taskHtmlForEditor(input) {
  const raw = String(input ?? '');
  if (!raw.trim()) return '';
  return isRichHtml(raw) ? sanitizeTaskHtml(raw) : plainToHtml(raw);
}

const decodeEntities = (s) => String(s)
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');

/** 提取纯文本（字数统计 / 任务图生成 / 变化比较用），块级标签转换行 */
export function taskPlainText(input) {
  const raw = String(input ?? '');
  if (!raw.trim()) return '';
  if (!isRichHtml(raw)) return raw.trim();
  let text = '';
  for (const part of raw.split(/(<[^>]*>)/g)) {
    if (!part) continue;
    if (!part.startsWith('<')) { text += part; continue; }
    const name = (part.match(/^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/) || [])[1];
    const tag = String(name || '').toUpperCase();
    if (tag === 'BR' || BLOCK_TAGS.has(tag)) text += '\n';
  }
  return decodeEntities(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 富文本行数（用于任务图分页前的粗判） */
export function taskLinesOf(input) {
  return taskPlainText(input).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
