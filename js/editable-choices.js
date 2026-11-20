import { activeAccountId } from './localdb.js';

const selector = 'input[list], input:not([type]), input[type="text"], input[type="search"]';
const pickers = new WeakMap();
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

function allOptions(input, key) {
  const options = new Map();
  for (const option of input.list?.options || []) {
    if (option.value && !option.disabled) options.set(option.value, option.label || option.value);
  }
  for (const value of recent(key)) {
    if (!options.has(value)) options.set(value, value);
  }
  return options;
}

function enhance(input) {
  if (!(input instanceof HTMLInputElement)) return;
  const key = historyKey(input);
  if (key && !input.hasAttribute('autocomplete')) input.autocomplete = 'off';
  const options = allOptions(input, key);
  if (!input.list && !options.size) return;
  const existing = pickers.get(input);
  if (existing) { existing(); return; }

  const wrap = document.createElement('span');
  wrap.className = 'editable-choice';
  const picker = document.createElement('select');
  picker.className = 'editable-choice-picker';
  const label = input.getAttribute('aria-label') || input.labels?.[0]?.textContent || input.previousElementSibling?.textContent;
  picker.setAttribute('aria-label', label?.trim() ? '选择' + label.trim() : '打开选项');
  const arrow = document.createElement('span');
  arrow.className = 'editable-choice-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '▾';
  input.before(wrap);
  wrap.append(input, picker, arrow);

  const sync = () => {
    const choices = allOptions(input, historyKey(input));
    picker.disabled = input.matches(':disabled') || input.readOnly || !choices.size;
    picker.hidden = arrow.hidden = !choices.size;
    const placeholder = new Option('请选择', '');
    placeholder.disabled = true;
    picker.replaceChildren(placeholder, ...Array.from(choices, ([value, text]) => new Option(text, value)));
    picker.value = input.value;
    if (picker.selectedIndex < 0) picker.selectedIndex = 0;
  };
  pickers.set(input, sync);
  picker.addEventListener('pointerdown', sync);
  picker.addEventListener('focus', sync);
  picker.addEventListener('input', event => event.stopPropagation());
  picker.addEventListener('change', event => {
    event.stopPropagation();
    if (!picker.value) return;
    input.value = picker.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  sync();
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
