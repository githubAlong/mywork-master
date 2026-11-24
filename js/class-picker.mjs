import { openChoices, isChoicesFor, closeChoices } from './choice-panel.mjs';
import { normGrade, inferGrade, normClass, gradeRank } from './grade-class.mjs';

/* 候选列表：年级不再无脑拼进标签。
   以前 label 一律是「高二5班」，于是「上课记录」这类已经有独立「上课年级」字段的表单，
   下拉里还是「高二5班 / 高二6班 / …」，年级显示两遍。
   现在按字段形态分两种：
     · 有独立年级框 → 标签和写入值都只给班名「5班」，年级单独存；
       候选跨年级时用分组标题区分。
     · 只有班级一列（没有年级框）→ 标签和值都带前缀「高二5班」，否则年级会丢。 */
export function classSuggestions(rows, { qualified = false } = {}) {
  const unique = new Map();
  for (const row of rows || []) {
    if (row?.deleted_at) continue;
    const rawName = typeof row === 'string' ? row : row?.class_name;
    const grade = normGrade(typeof row === 'string' ? '' : row?.grade) || inferGrade(rawName);
    const name = normClass(rawName, grade);
    /* 归一后是空的 = 这行只有年级、没有班号（「高二」「高二()」这类脏数据）。
       以前它会原样进候选，下拉第一行就多出个「高二」，点它存进去也是个坏班级值。 */
    if (!name) continue;
    const id = grade + '#' + name;
    if (unique.has(id)) continue;
    /* qualified = 这个字段是页面上唯一的班级列（没有单独年级框），
       年级丢掉就补不回来，所以标签和写入值都带上前缀「高二5班」。
       反之只给班名「5班」——年级就在旁边那个框里，再拼一遍就是重复。 */
    const value = qualified && grade ? grade + name : name;
    unique.set(id, { id, value, label: value, grade });
  }
  return [...unique.values()].sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade)
    || a.label.localeCompare(b.label, 'zh-Hans-CN', { numeric: true }));
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

/* grouped：只有候选跨了年级才给分组标题。单一年的候选列表再加一行「高二」
   没有任何信息量，就是重复。 */
function panelItems(choices, { grouped = false } = {}) {
  return choices.map((choice) => ({
    id: choice.id,
    value: choice.value,
    label: choice.label,
    group: grouped ? (choice.grade || '未填年级') : '',
  }));
}

export function setClassSuggestions(input, rows, { gradeInput, qualified } = {}) {
  if (!input) return;
  const all = classSuggestions(rows, { qualified });
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
    arrow.append(chevron());
    wrapper.append(arrow);

    arrow.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      /* 面板正给自己用 → 再点一次收起；在别的字段上 → 直接换成自己的候选。 */
      if (isChoicesFor(input)) { closeChoices(); return; }
      if (input.readOnly || input.disabled) return;
      show('');
    });

    input.addEventListener('input', (event) => {
      if (!event.isTrusted || !isChoicesFor(input) || input.readOnly || input.disabled) return;
      show(input.value);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' || isChoicesFor(input)) return;
      if (input.readOnly || input.disabled || !wrapper.__classPanelItems?.length) return;
      event.preventDefault();
      show('');
    });
  }

  /* 年级框有值时按年级收窄候选：上面选了「高二」，下面这一列就只留高二的班。
     一个都匹配不上（数据对不齐）就退回全量，不能让下拉变空、录不进去。 */
  function paint(nextAll) {
    if (nextAll) wrapper.__classAll = nextAll;
    const pool = wrapper.__classAll || [];
    const wantGrade = normGrade(wrapper.__classGradeInput?.value) || '';
    const matched = wantGrade ? pool.filter((choice) => choice.grade === wantGrade) : [];
    const choices = matched.length ? matched : pool;
    const grades = new Set(choices.map((choice) => choice.grade).filter(Boolean));
    /* 分组标题只在「标签里没有年级」时才需要：qualified 时每行已经写着「高二5班」，
       再顶一个「高二」标题就是同一件事说两遍。 */
    const grouped = !wrapper.__classQualified && grades.size > 1;
    const items = panelItems(choices, { grouped });
    wrapper.__classPanelItems = items;
    wrapper.__classChoices = choices;
    if (arrow) arrow.hidden = !items.length;
  }

  wrapper.__classAll = all;
  wrapper.__classQualified = Boolean(qualified);
  /* 后一次调用没传 gradeInput 时不要把它清掉，否则年级联动会失效。 */
  if (gradeInput) wrapper.__classGradeInput = gradeInput;
  paint();

  /* 换了年级要重算候选。只挂一次：classPickerAuto 会连续调两次，
     每次都挂就会叠出重复监听。 */
  if (gradeInput && !wrapper.__classGradeBound) {
    wrapper.__classGradeBound = true;
    const onChange = () => paint();
    gradeInput.addEventListener('input', onChange);
    gradeInput.addEventListener('change', onChange);
  }

  function show(filter) {
    const list = wrapper.__classPanelItems || [];
    if (!list.length) { closeChoices(); return; }
    openChoices(wrapper, {
      items: list,
      input,
      filter,
      selected: input.value.trim(),
      minWidth: Math.max(220, wrapper.offsetWidth),
      maxWidth: 380,
      onPick: (item) => {
        /* 按 id 找：同班号跨年级时 value 会重名（两个「5班」），
           只按 value 找会拿到第一个，年级就填错了。 */
        const choices = wrapper.__classChoices || [];
        const choice = choices.find((row) => row.id === item.id)
          || choices.find((row) => row.value === item.value);
        const target = wrapper.__classGradeInput;
        if (target && choice?.grade) target.value = choice.grade;
        input.value = choice?.value ?? item.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
  }
}
