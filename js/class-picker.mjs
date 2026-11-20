import { openChoices, isChoicesOpen, closeChoices } from './choice-panel.mjs';

export function classSuggestions(rows, { qualified = false } = {}) {
  const unique = new Map();
  for (const row of rows || []) {
    if (row?.deleted_at) continue;
    const grade = String(row?.grade ?? '').trim();
    const name = String(typeof row === 'string' ? row : row?.class_name ?? '').trim();
    if (!name) continue;
    const label = grade && !name.startsWith(grade) ? grade + name : name;
    const value = qualified ? label : name;
    const key = qualified ? value : JSON.stringify([label, value]);
    if (!unique.has(key)) unique.set(key, { value, label, grade });
  }
  return [...unique.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
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

function panelItems(choices) {
  return choices.map((choice) => ({
    value: choice.value,
    label: choice.label,
    group: choice.grade || '',
  }));
}

export function setClassSuggestions(input, rows, { gradeInput, qualified } = {}) {
  if (!input) return;
  const choices = classSuggestions(rows, { qualified });
  const doc = input.ownerDocument;
  const parent = input.parentElement;
  let wrapper = parent.classList.contains('class-picker') ? parent : null;
  let arrow = wrapper?.querySelector('.class-picker-arrow') || null;

  if (!wrapper) {
    wrapper = doc.createElement('span');
    wrapper.className = 'class-picker';
    input.replaceWith(wrapper);
    wrapper.append(input);

    arrow = doc.createElement('span');
    arrow.className = 'class-picker-arrow';
    arrow.setAttribute('role', 'button');
    arrow.setAttribute('tabindex', '-1');
    arrow.setAttribute('aria-label', '选择班级');
    arrow.title = '展开课表班级（也可以直接输入）';
    arrow.append(chevron());
    wrapper.append(arrow);

    arrow.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isChoicesOpen()) { closeChoices(); return; }
      if (input.readOnly || input.disabled) return;
      show(input.value.trim());
    });

    input.addEventListener('input', (event) => {
      if (!event.isTrusted) return;
      if (input.readOnly || input.disabled) return;
      const list = wrapper.__classPanelItems || [];
      if (!input.value.trim() || !list.length) { closeChoices(); return; }
      show(input.value);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' || isChoicesOpen()) return;
      if (input.readOnly || input.disabled) return;
      event.preventDefault();
      show(input.value.trim());
    });
  }

  const items = panelItems(choices);
  wrapper.__classPanelItems = items;
  wrapper.__classChoices = choices;
  wrapper.__classGradeInput = gradeInput;
  arrow.hidden = !items.length;

  function show(filter) {
    const list = wrapper.__classPanelItems || [];
    if (!list.length) { closeChoices(); return; }
    openChoices(wrapper, {
      items: list,
      input,
      filter,
      selected: input.value.trim(),
      emptyHint: filter ? '没找到「' + filter + '」的班级，直接输入也能保存' : '',
      minWidth: Math.max(220, wrapper.offsetWidth),
      maxWidth: 380,
      onPick: (item) => {
        const choice = (wrapper.__classChoices || []).find((row) => row.value === item.value);
        const target = wrapper.__classGradeInput;
        if (target && choice?.grade) target.value = choice.grade;
        input.value = item.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
  }
}
