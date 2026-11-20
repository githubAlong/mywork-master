import { activeAccountId } from './localdb.js';
import { openChoices, updateChoices, closeChoices, isChoicesFor } from './choice-panel.mjs';

const selector = 'input[list], input:not([type]), input[type="text"], input[type="search"]';
const wired = new WeakMap();
const HISTORY_LIMIT = 5;

function historyKey(input) {
  const field = input.id || input.name;
  const account = activeAccountId();
  const dialog = input.closest('.sheet');
  const label = input.labels?.[0]?.textContent || (input.closest('.editable-choice') || input).previousElementSibling?.textContent || '';
  const autocomplete = input.getAttribute('autocomplete') || '';
  if (!field || !account || document.getElementById('s-app') || input.type === 'password'
      || input.form?.querySelector('input[type="password"]')
      || input.closest('[data-no-input-history], [data-hist]')
      || /password|username|one-time-code|email|tel|cc-/i.test(autocomplete)
      || /pass(word)?|secret|token|captcha|otp|api[-_ ]?key|access[-_ ]?key|(?:^|[-_])(?:pin|pwd|acct|account|phone|email|reset|rst)(?:$|[-_])|密码|验证码|口令|账号|电话|手机|邮箱|身份证/i.test(field + ' ' + label)
      || dialog?.querySelector('input[type="password"]')) return '';
  const page = location.hash.split('?')[0];
  const scope = dialog?.querySelector('.sheet-title')?.textContent?.trim().replace(/^(新增|编辑|修改)/, '') || '';
  return 'wb_input_recent_v1:' + JSON.stringify([account, page, scope, field]);
}

function recent(key) {
  if (!key) return [];
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(stored) ? stored.filter(v => typeof v === 'string').slice(0, HISTORY_LIMIT) : [];
  } catch { return []; }
}

/* 候选来源优先级：页面显式挂的 __choiceItems（可带分组和时间段）→ 原生 datalist → 历史输入。 */
function collectItems(input, key) {
  const items = [];
  const seen = new Set();
  const push = (value, label, hint, group) => {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    items.push({ value: text, label: String(label ?? text).trim() || text, hint, group });
  };

  const custom = input.__choiceItems;
  if (Array.isArray(custom) && custom.length) {
    for (const item of custom) push(item.value, item.label, item.hint, item.group);
    return items;
  }

  for (const option of input.list?.options || []) {
    if (option.value && !option.disabled) push(option.value, option.label || option.value);
  }
  for (const value of recent(key)) push(value, value);
  return items;
}

function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3.5 5.5L7 9l3.5-3.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function refreshArrow(input) {
  const state = wired.get(input);
  if (!state) return;
  const items = collectItems(input, historyKey(input));
  state.items = items;
  state.arrow.hidden = !items.length;
  const labelText = input.getAttribute('aria-label') || input.labels?.[0]?.textContent?.trim() || input.placeholder || '选项';
  state.arrow.setAttribute('aria-label', '展开' + labelText.replace(/\s*\*?\s*$/, ''));
  state.arrow.title = '展开选项（也可以直接输入）';
}

function enhance(input) {
  if (!(input instanceof HTMLInputElement)) return;
  /* 班级字段由 class-picker 接管（候选来自课表 + 花名册），别再套一层历史值下拉。 */
  if (input.closest('.class-picker')) return;
  const key = historyKey(input);
  if (key && !input.hasAttribute('autocomplete')) input.autocomplete = 'off';

  const items = collectItems(input, key);
  if (!input.list && !items.length) return;

  if (wired.get(input)) { refreshArrow(input); return; }

  const doc = input.ownerDocument;
  const wrap = doc.createElement('span');
  wrap.className = 'editable-choice';
  input.before(wrap);
  wrap.append(input);

  const arrow = doc.createElement('span');
  arrow.className = 'editable-choice-arrow';
  arrow.setAttribute('role', 'button');
  arrow.setAttribute('tabindex', '-1');
  arrow.append(chevron());
  wrap.append(arrow);

  wired.set(input, { arrow, items, key });
  refreshArrow(input);

  const show = (filter) => {
    const list = collectItems(input, historyKey(input));
    if (!list.length) { closeChoices(); return; }
    openChoices(wrap, {
      items: list,
      input,
      filter,
      selected: input.value.trim(),
      emptyHint: filter ? '没找到「' + filter + '」，直接输入也能保存' : '',
      minWidth: Math.max(220, wrap.offsetWidth),
    });
  };

  arrow.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    /* 面板正给自己用 → 再点一次收起；面板在别的字段上 → 换成自己的候选（不要只关掉）。 */
    if (isChoicesFor(input)) { closeChoices(); return; }
    if (input.readOnly || input.disabled) return;
    show('');
  });

  /* 只响应用户真打字：选中后回填会以程序方式派发 input，那种不该把面板再弹出来。 */
  input.addEventListener('input', (event) => {
    if (!event.isTrusted) return;
    if (input.readOnly || input.disabled) return;
    const list = collectItems(input, historyKey(input));
    if (!input.value.trim() || !list.length) { closeChoices(); return; }
    const emptyHint = '没找到「' + input.value.trim() + '」，直接输入也能保存';
    /* 只有面板归自己时才就地刷新；归别人时直接另开一个，
       否则面板会被换成我的候选、选中却写回上一个字段。 */
    if (isChoicesFor(input)) updateChoices({ items: list, filter: input.value, selected: input.value, emptyHint, input });
    else show(input.value);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' || isChoicesFor(input)) return;
    if (input.readOnly || input.disabled) return;
    event.preventDefault();
    show(input.value.trim());
  });
}

document.addEventListener('change', ({ target: input }) => {
  if (!(input instanceof HTMLInputElement) || !['text', 'search'].includes(input.type) || input.readOnly) return;
  const key = historyKey(input);
  const value = input.value.trim();
  if (!key || !value || value.length > 256) return;
  try { localStorage.setItem(key, JSON.stringify([value, ...recent(key).filter(item => item !== value)].slice(0, HISTORY_LIMIT))); }
  catch { return; }
  enhance(input);
}, true);

function scan(root) {
  if (!(root instanceof Element)) return;
  if (root.matches(selector)) enhance(root);
  root.querySelectorAll(selector).forEach(enhance);
}

scan(document.body);
new MutationObserver(records => {
  let listsChanged = false;
  for (const record of records) {
    record.addedNodes.forEach(scan);
    if (record.type === 'attributes' && record.target.matches(selector)) enhance(record.target);
    if (record.target.closest('datalist') || Array.from(record.addedNodes).some(node => node instanceof HTMLDataListElement)) listsChanged = true;
  }
  if (listsChanged) document.querySelectorAll('input[list]').forEach(enhance);
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['list', 'disabled', 'readonly'] });
