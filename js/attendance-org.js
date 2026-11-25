/* ============================================================================
   attendance-org.js —— 考勤 · 组织管理

   位置：一级「考勤」下的二级导航（原「部门管理」，2026-11-26 更名为组织管理）。
   结构：一个页面四个页签 —— 部门管理 / 年级管理 / 教师管理 / 科目管理。
        · 部门 / 年级：读写 /departments（年级是部门的下级，删年级只解除关联）
        · 教师：读写 /org/teachers（花名册主数据，旧工作台 teachers 表里多出来的人会自动补进来）
        · 科目：读写 /org/subjects，人数按花名册里该学科的教师数实时统计
   版式严格照设计稿：页签条 + 标题徽标 + 两张统计卡 + 一行一卡列表 + 底部虚线提示。
   ========================================================================== */
import { api, esc, toast, confirmDialog } from './core.js';
import { rosterTabLabel, subjectCategory } from './attendance-hub-domain.mjs';

/* ---------------- 图标 ---------------- */
const ICONS = {
  deptTab: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.6" y="3.6" width="7" height="7" rx="1.6"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.6"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.6"/><rect x="13.4" y="13.4" width="7" height="7" rx="1.6"/></svg>`,
  gradeTab: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 8.7 12 4.6l9.4 4.1L12 12.8 2.6 8.7Z"/><path d="M6.7 10.7v4.1c0 1.6 2.4 2.9 5.3 2.9s5.3-1.3 5.3-2.9v-4.1"/></svg>`,
  teacherTab: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.1"/><path d="M5.2 20c0-3.3 3-5.6 6.8-5.6s6.8 2.3 6.8 5.6"/></svg>`,
  subjectTab: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.2A1.6 1.6 0 0 1 5.6 3.6H19a1 1 0 0 1 1 1v14.8a1 1 0 0 1-1 1H5.6A1.6 1.6 0 0 1 4 18.8V5.2Z"/><path d="M8 3.6v16.8M11.2 8.4h5"/></svg>`,

  dept: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="6.2" r="2.4"/><circle cx="6" cy="17.8" r="2.4"/><circle cx="18" cy="17.8" r="2.4"/><path d="M12 8.6v3.6M12 12.2H6v3.2M12 12.2h6v3.2"/></svg>`,
  teacher: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="3"/><path d="M4 20c0-3.1 2.7-5.3 6-5.3s6 2.2 6 5.3"/><path d="M16.2 5.6a2.7 2.7 0 0 1 0 5.1M17.4 14.9c2 .6 3.4 2.3 3.4 4.4"/></svg>`,
  grade: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 8.7 12 4.6l9.4 4.1L12 12.8 2.6 8.7Z"/><path d="M6.7 10.7v4.1c0 1.6 2.4 2.9 5.3 2.9s5.3-1.3 5.3-2.9v-4.1"/></svg>`,
  subject: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.2A1.6 1.6 0 0 1 5.6 3.6H19a1 1 0 0 1 1 1v14.8a1 1 0 0 1-1 1H5.6A1.6 1.6 0 0 1 4 18.8V5.2Z"/><path d="M8 3.6v16.8M11.2 8.4h5"/></svg>`,

  folder: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 6.6A1.6 1.6 0 0 1 5 5h4l2 2.2h8a1.6 1.6 0 0 1 1.6 1.6v8.6A1.6 1.6 0 0 1 19 19H5a1.6 1.6 0 0 1-1.6-1.6V6.6Z"/></svg>`,
  book: `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.2A1.6 1.6 0 0 1 5.6 3.6H19a1 1 0 0 1 1 1v14.8a1 1 0 0 1-1 1H5.6A1.6 1.6 0 0 1 4 18.8V5.2Z"/><path d="M8 3.6v16.8M11.2 8.4h5"/></svg>`,
  caret: `<svg viewBox="0 0 10 10" width="10" height="10" fill="none"><path d="M1.6 3.3 5 6.7l3.4-3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  refresh: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.3 6.4A5.4 5.4 0 1 0 13.4 9.6"/><path d="M13.5 3.1v3.5H10"/></svg>`,
  bulb: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.6a4.2 4.2 0 0 1 2.6 7.5c-.4.3-.6.7-.6 1.2v.5H6v-.5c0-.5-.2-.9-.6-1.2A4.2 4.2 0 0 1 8 1.6Z"/><path d="M6.3 13.1h3.4"/></svg>`,
};

/* 科目图标：按常见科目给个小图形，其他科目用书本兜底 */
const SUBJECT_ICON = {
  math: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7.5h6M8 4.5v6"/><path d="M14 6.2l4 4M18 6.2l-4 4"/><path d="M5 16h6"/><path d="M14 16h4M16 14v4"/></svg>`,
  music: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.4" cy="17.2" r="2.6"/><circle cx="17.4" cy="15.4" r="2.6"/><path d="M10 17.2V6.6l10-2v10.8"/></svg>`,
  art: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4a8.6 8.6 0 1 0 0 17.2c1.4 0 2-.9 2-1.9 0-1.4-1.2-1.7-1.2-2.9 0-1 .8-1.7 1.9-1.7h1.6a4.3 4.3 0 0 0 4.3-4.3c0-3.6-3.9-6.4-8.6-6.4Z"/><circle cx="8.3" cy="10.2" r=".9" fill="currentColor" stroke="none"/><circle cx="11.6" cy="7.4" r=".9" fill="currentColor" stroke="none"/><circle cx="15.4" cy="8.8" r=".9" fill="currentColor" stroke="none"/></svg>`,
  sport: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v4.2M12 16.2v4.2M3.6 12h4.2M16.2 12h4.2"/></svg>`,
  book: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.2A1.6 1.6 0 0 1 5.6 3.6H19a1 1 0 0 1 1 1v14.8a1 1 0 0 1-1 1H5.6A1.6 1.6 0 0 1 4 18.8V5.2Z"/><path d="M8 3.6v16.8M11.2 8.4h5"/></svg>`,
};
function subjectIcon(name) {
  const s = String(name || '');
  if (/数学/.test(s)) return SUBJECT_ICON.math;
  if (/音乐/.test(s)) return SUBJECT_ICON.music;
  if (/美术|艺术/.test(s)) return SUBJECT_ICON.art;
  if (/体育/.test(s)) return SUBJECT_ICON.sport;
  return SUBJECT_ICON.book;
}

/* ---------------- 弹窗（沿用 ahub 的弹窗骨架） ---------------- */
function overlay(title, body, { sub = '', size = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ahub-mask';
  wrap.innerHTML = `<div class="ahub-dialog${size ? ' ' + size : ''}" role="dialog" aria-modal="true">
    <div class="ahub-dialog-head">
      <div class="ahub-dialog-tt"><b>${esc(title)}</b>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
      <button type="button" class="ahub-x" data-close aria-label="关闭">×</button>
    </div>
    <div class="ahub-dialog-body">${body}</div>
  </div>`;
  document.body.appendChild(wrap);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    wrap.remove();
  }
  wrap.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  return { wrap, close };
}

const TABS = [
  { id: 'dept', label: '部门管理', icon: ICONS.deptTab },
  { id: 'grade', label: '年级管理', icon: ICONS.gradeTab },
  { id: 'teacher', label: '教师管理', icon: ICONS.teacherTab },
  { id: 'subject', label: '科目管理', icon: ICONS.subjectTab },
];

export async function renderAttendanceOrg(root) {
  const S = { tab: 'dept', depts: null, teachers: [], subjects: [], busy: false };

  root.innerHTML = `
    <div class="org">
      <div class="org-crumb" id="org-crumb">考勤 <span>/</span> 组织管理 <span>/</span> 部门管理</div>
      <nav class="org-tabs" id="org-tabs">
        ${TABS.map((t, i) => `<button class="org-tab${i === 0 ? ' on' : ''}" data-tab="${t.id}">
          <span class="org-tab-ico">${t.icon}</span>${t.label}</button>`).join('')}
      </nav>
      <div id="org-panel"></div>
    </div>`;

  const $ = (s) => root.querySelector(s);

  /* ---------------- 数据 ---------------- */
  async function load({ silent = false } = {}) {
    if (S.busy) return;
    S.busy = true;
    try {
      const [depts, roster, subjects] = await Promise.all([
        api.get('/departments'),
        api.get('/org/teachers'),
        api.get('/org/subjects'),
      ]);
      S.depts = depts || { list: [], unassigned: [], grades: [] };
      S.teachers = Array.isArray(roster?.list) ? roster.list : [];
      S.subjects = Array.isArray(subjects?.list) ? subjects.list : [];
      paint();
    } catch (e) {
      if (!silent) toast('加载失败：' + (e.message || e), 'warn', 4000);
      $('#org-panel').innerHTML = `<div class="org-card"><div class="org-empty">加载失败，点「刷新」重试</div></div>`;
    } finally { S.busy = false; }
  }

  /* 教师按序号升序，和花名册保持同一顺序 */
  function teacherRows() {
    const no = (t) => {
      const m = String(t?.teacher_id ?? '').match(/\d+/);
      return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
    };
    return S.teachers.slice().sort((a, b) => {
      const d = no(a) - no(b);
      if (Number.isFinite(d) && d !== 0) return d;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
  }

  function deptOptions(selected) {
    return (S.depts?.list || []).map((d) => `<option value="${esc(d.name)}"${d.name === selected ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
  }

  /* ---------------- 页签 ---------------- */
  function switchTab(id) {
    S.tab = id;
    $('#org-tabs').querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    const cur = TABS.find((t) => t.id === id);
    $('#org-crumb').innerHTML = `考勤 <span>/</span> 组织管理 <span>/</span> ${esc(cur?.label || '')}`;
    paint();
  }

  function paint() {
    const panel = $('#org-panel');
    if (S.tab === 'dept') return paintDept(panel);
    if (S.tab === 'grade') return paintGrade(panel);
    if (S.tab === 'teacher') return paintTeacher(panel);
    return paintSubject(panel);
  }

  /* 公共骨架：标题 + 徽标 + 操作按钮 + 两张统计卡 + 列表卡 + 底部虚线提示 */
  function shell({ title, badge, actionId, actionLabel, stats, listTitle, listHint, body, foot }) {
    return `
      <div class="org-head">
        <h1 class="org-title">${esc(title)} <span class="org-badge">${esc(badge)}</span></h1>
        <button class="org-btn primary" id="${actionId}">＋ ${esc(actionLabel)}</button>
      </div>
      <div class="org-stats">
        ${stats.map((s) => `<div class="org-stat">
          <span class="org-stat-ico">${s.icon}</span>
          <div class="org-stat-body">
            <span class="org-stat-lb">${esc(s.label)}</span>
            <b class="org-stat-num">${esc(String(s.value))}</b>
          </div></div>`).join('')}
      </div>
      <section class="org-card">
        <div class="org-card-head">
          <b class="org-card-title">${esc(listTitle)}</b>
          <span class="org-card-hint">${esc(listHint)}</span>
          <button class="org-btn org-refresh" id="org-refresh">${ICONS.refresh}刷新</button>
        </div>
        <div class="org-list" id="org-list">${body}</div>
        <div class="org-foot"><span class="org-foot-ico">${ICONS.bulb}</span>${esc(foot)}</div>
      </section>`;
  }

  const teacherTotal = () => S.teachers.length;
  const gradeTotal = () => (S.depts?.grades || []).length;

  /* ---------------- 部门管理 ---------------- */
  function paintDept(panel) {
    const v = S.depts || { list: [], unassigned: [], grades: [] };
    const rows = v.list.map((d) => `
      <div class="org-row">
        <span class="org-caret">${ICONS.caret}</span>
        <span class="org-ico">${ICONS.folder}</span>
        <b class="org-name">${esc(d.name)}</b>
        <span class="org-pill">部门</span>
        <div class="org-cell"><span class="org-cell-lb">教师数</span><b>${d.teacherCount || 0}</b></div>
        <div class="org-cell"><span class="org-cell-lb">花名册页签</span><b>总花名册</b></div>
        <div class="org-ops">
          <button class="org-link" data-act="dept-edit" data-id="${esc(d.id)}">编辑</button>
          <button class="org-link danger" data-act="dept-del" data-id="${esc(d.id)}">删除</button>
        </div>
      </div>`).join('');

    panel.innerHTML = shell({
      title: '部门管理',
      badge: `共 ${v.list.length} 个部门`,
      actionId: 'org-dept-add', actionLabel: '新建部门',
      stats: [
        { icon: ICONS.dept, label: '部门总数', value: v.list.length },
        { icon: ICONS.teacher, label: '在编教师', value: teacherTotal() },
      ],
      listTitle: '部门列表', listHint: '每行均可编辑、删除',
      body: rows || `<div class="org-empty">还没有部门，点右上角「＋ 新建部门」先建一个。</div>`,
      foot: '＋ 新建部门后，这里自动多一行；部门下新建年级，花名册自动多一个分表页签',
    });

    $('#org-dept-add').onclick = openDeptAdd;
    bindRowActs(panel);
  }

  /* ---------------- 年级管理 ---------------- */
  function paintGrade(panel) {
    const v = S.depts || { list: [], unassigned: [] };
    const rows = [];
    for (const d of v.list) {
      for (const g of d.grades) {
        rows.push(gradeRow(g.name, d.name, g.teacherCount));
      }
    }
    for (const g of v.unassigned || []) rows.push(gradeRow(g.name, '未分配', g.teacherCount));

    panel.innerHTML = shell({
      title: '年级管理',
      badge: `共 ${gradeTotal()} 个年级`,
      actionId: 'org-grade-add', actionLabel: '新建年级',
      stats: [
        { icon: ICONS.grade, label: '年级总数', value: gradeTotal() },
        { icon: ICONS.teacher, label: '在编教师', value: teacherTotal() },
      ],
      listTitle: '年级列表', listHint: '每行均可编辑、删除',
      body: rows.join('') || `<div class="org-empty">还没有年级，点右上角「＋ 新建年级」先建一个。</div>`,
      foot: '＋ 新建年级后，这里自动多一条',
    });

    $('#org-grade-add').onclick = openGradeAdd;
    bindRowActs(panel);
  }

  function gradeRow(name, deptName, count) {
    return `<div class="org-row">
      <span class="org-ico">${ICONS.book}</span>
      <b class="org-name">${esc(name)}</b>
      <span class="org-pill gray">年级</span>
      <div class="org-cell"><span class="org-cell-lb">所属部门</span><b>${esc(deptName)}</b></div>
      <div class="org-cell"><span class="org-cell-lb">教师数</span><b>${count || 0}</b></div>
      <div class="org-cell"><span class="org-cell-lb">花名册</span><b>${esc(rosterTabLabel(name))}</b></div>
      <div class="org-ops">
        <button class="org-link" data-act="grade-edit" data-name="${esc(name)}" data-dept="${esc(deptName)}">编辑</button>
        <button class="org-link danger" data-act="grade-del" data-name="${esc(name)}">删除</button>
      </div>
    </div>`;
  }

  /* ---------------- 教师管理 ---------------- */
  function paintTeacher(panel) {
    const list = teacherRows();
    const subjects = new Set(list.map((t) => String(t.subject || '').trim()).filter(Boolean));
    const rows = list.map((t, i) => `<div class="org-row">
      <span class="org-no">${i + 1}</span>
      <b class="org-name">${esc(t.name || '')}</b>
      ${t.subject ? `<span class="org-subj" data-c="${esc(t.subject)}">${esc(t.subject)}</span>` : ''}
      <div class="org-cell"><span class="org-cell-lb">所属部门</span><b>${esc(t.department || '—')}</b></div>
      <div class="org-cell"><span class="org-cell-lb">所属年级</span><b>${esc(t.grade || '—')}</b></div>
      <div class="org-ops">
        <button class="org-link" data-act="teacher-edit" data-id="${esc(t.id)}">编辑</button>
        <button class="org-link danger" data-act="teacher-del" data-id="${esc(t.id)}">删除</button>
      </div>
    </div>`).join('');

    panel.innerHTML = shell({
      title: '教师管理',
      badge: `共 ${list.length} 名教师`,
      actionId: 'org-teacher-add', actionLabel: '新增教师',
      stats: [
        { icon: ICONS.teacher, label: '教师总数', value: list.length },
        { icon: ICONS.subject, label: '覆盖科目', value: subjects.size },
      ],
      listTitle: '教师名单', listHint: '每行均可编辑、删除',
      body: rows || `<div class="org-empty">还没有教师，点右上角「＋ 新增教师」开始录入。</div>`,
      foot: '＋ 新增教师后，这里自动多一条',
    });

    $('#org-teacher-add').onclick = () => openTeacherForm(null);
    bindRowActs(panel);
  }

  /* ---------------- 科目管理 ---------------- */
  function paintSubject(panel) {
    const list = S.subjects;
    const cats = new Set(list.map((s) => s.category || subjectCategory(s.name)));
    const rows = list.map((s) => `<div class="org-row">
      <span class="org-subj-ico" data-c="${esc(s.name)}">${subjectIcon(s.name)}</span>
      <b class="org-name">${esc(s.name)}</b>
      <div class="org-cell row"><span class="org-cell-lb">人数</span><b>${s.count || 0}</b></div>
      <div class="org-ops">
        <button class="org-link" data-act="subject-edit" data-id="${esc(s.id)}">编辑</button>
        <button class="org-link danger" data-act="subject-del" data-id="${esc(s.id)}">删除</button>
      </div>
    </div>`).join('');

    panel.innerHTML = shell({
      title: '科目管理',
      badge: `共 ${list.length} 个科目`,
      actionId: 'org-subject-add', actionLabel: '新增科目',
      stats: [
        { icon: ICONS.subject, label: '科目总数', value: list.length },
        { icon: ICONS.teacher, label: '科目分类', value: cats.size },
      ],
      listTitle: '科目列表', listHint: '每行均可编辑、删除',
      body: rows || `<div class="org-empty">还没有科目，点右上角「＋ 新增科目」开始录入。</div>`,
      foot: '＋ 新增科目后，这里自动多一条',
    });

    $('#org-subject-add').onclick = openSubjectAdd;
    bindRowActs(panel);
  }

  /* ---------------- 行内操作绑定 ---------------- */
  function bindRowActs(panel) {
    const refresh = panel.querySelector('#org-refresh');
    if (refresh) refresh.onclick = () => load({ silent: true });
    panel.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        if (act === 'dept-edit') return openDeptEdit(btn.dataset.id);
        if (act === 'dept-del') return removeDept(btn.dataset.id);
        if (act === 'grade-edit') return openGradeEdit(btn.dataset.name, btn.dataset.dept);
        if (act === 'grade-del') return removeGrade(btn.dataset.name);
        if (act === 'teacher-edit') return openTeacherForm(btn.dataset.id);
        if (act === 'teacher-del') return removeTeacher(btn.dataset.id);
        if (act === 'subject-edit') return openSubjectEdit(btn.dataset.id);
        if (act === 'subject-del') return removeSubject(btn.dataset.id);
      };
    });
  }

  /* ---------------- 部门 ---------------- */
  function openDeptAdd() {
    const body = `<form id="org-form" class="ahub-form one">
      <label class="ahub-field"><span>部门名称 <i>*</i></span>
        <input name="name" id="org-name" placeholder="如：高中部" autocomplete="off"></label>
      <div class="ahub-field-hint">如：高中部、初中部；重名会提示已存在</div>
      <div class="ahub-form-err" id="org-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('新建部门', body, { sub: '建好后可在该部门下继续新建年级', size: 'sm' });
    const form = wrap.querySelector('#org-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) { wrap.querySelector('#org-err').textContent = '请填写部门名称'; return; }
      try {
        await api.post('/departments', { name });
        close(); toast(`已新建部门「${name}」`, 'ok'); await load({ silent: true });
      } catch (ex) { wrap.querySelector('#org-err').textContent = ex.message || String(ex); }
    };
    setTimeout(() => wrap.querySelector('#org-name')?.focus(), 30);
  }

  function openDeptEdit(id) {
    const d = (S.depts?.list || []).find((x) => String(x.id) === String(id));
    if (!d) return;
    const body = `<form id="org-form" class="ahub-form one">
      <label class="ahub-field"><span>部门名称 <i>*</i></span>
        <input name="name" id="org-name" value="${esc(d.name)}" autocomplete="off"></label>
      <div class="ahub-field-hint">改名后，花名册与考勤表里的旧名称会同步更新</div>
      <div class="ahub-form-err" id="org-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('编辑部门', body, { sub: '只改名称，不影响该部门下的年级与教师', size: 'sm' });
    const form = wrap.querySelector('#org-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) { wrap.querySelector('#org-err').textContent = '请填写部门名称'; return; }
      try {
        const r = await api.patch(`/departments/${encodeURIComponent(id)}`, { name });
        close(); toast(`已保存「${name}」，${r.renamedRows || 0} 条花名册记录同步更新`, 'ok', 3500);
        await load({ silent: true });
      } catch (ex) { wrap.querySelector('#org-err').textContent = ex.message || String(ex); }
    };
  }

  async function removeDept(id) {
    const d = (S.depts?.list || []).find((x) => String(x.id) === String(id));
    if (!d) return;
    const ok = await confirmDialog(
      `确定删除部门「${d.name}」吗？${d.gradeCount || d.teacherCount
        ? `该部门下有 ${d.gradeCount} 个年级、${d.teacherCount} 位教师；年级会变成「未分配」，所有教师与考勤记录全部保留，不会删除数据。`
        : '删除后可在需要时重新新建同名部门。'}`,
      { title: '删除部门', okText: '删除', danger: true });
    if (!ok) return;
    try {
      let r = await api.del(`/departments/${encodeURIComponent(id)}`);
      if (r.blocked) {
        const yes = await confirmDialog(
          `「${d.name}」下还有 ${r.gradeCount} 个年级、${r.teacherCount} 位教师。确认继续删除吗？年级会变为未分配，记录全部保留。`,
          { title: '再次确认', okText: '确认删除', danger: true });
        if (!yes) return;
        r = await api.del(`/departments/${encodeURIComponent(id)}?force=1`);
      }
      toast('已删除部门，相关记录全部保留', 'ok');
      await load({ silent: true });
    } catch (e) { toast('删除失败：' + (e.message || e), 'warn'); }
  }

  /* ---------------- 年级 ---------------- */
  function openGradeAdd() {
    const depts = S.depts?.list || [];
    if (!depts.length) { toast('请先新建一个部门，再在部门里新建年级', 'warn', 3500); return; }
    const opts = depts.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    const body = `<form id="org-form" class="ahub-form">
      <label class="ahub-field"><span>所属部门 <i>*</i></span>
        <select name="departmentId" id="org-dept">${opts}</select></label>
      <label class="ahub-field"><span>年级名称 <i>*</i></span>
        <input name="name" id="org-name" placeholder="如：高一年级" autocomplete="off"></label>
      <div class="ahub-field-hint">如：高一年级、高二年级；建好后花名册会自动多一个对应的分表页签</div>
      <div class="ahub-form-err" id="org-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('新建年级', body, { sub: '年级挂在部门下，并成为花名册的一个分表页签' });
    const form = wrap.querySelector('#org-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      const departmentId = String(fd.get('departmentId') || '');
      if (!name) { wrap.querySelector('#org-err').textContent = '请填写年级名称'; return; }
      try {
        await api.post(`/departments/${encodeURIComponent(departmentId)}/grades`, { name });
        close(); toast(`已新建年级「${name}」，花名册自动多一个分表页签`, 'ok', 3500);
        await load({ silent: true });
      } catch (ex) { wrap.querySelector('#org-err').textContent = ex.message || String(ex); }
    };
    setTimeout(() => wrap.querySelector('#org-name')?.focus(), 30);
  }

  function openGradeEdit(name, deptName) {
    const depts = S.depts?.list || [];
    const cur = depts.find((d) => d.name === deptName);
    const opts = ['<option value="">暂不调整部门</option>']
      .concat(depts.map((d) => `<option value="${esc(d.id)}"${cur && d.id === cur.id ? ' selected' : ''}>${esc(d.name)}</option>`)).join('');
    const body = `<form id="org-form" class="ahub-form">
      <label class="ahub-field"><span>年级名称 <i>*</i></span>
        <input name="name" id="org-name" value="${esc(name)}" autocomplete="off"></label>
      <label class="ahub-field"><span>改所属部门</span>
        <select name="departmentId" id="org-dept">${opts}</select></label>
      <div class="ahub-field-hint">改名或换部门后，花名册与考勤表里的记录会同步更新</div>
      <div class="ahub-form-err" id="org-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('编辑年级', body, { sub: '只改名称或所属部门，不影响已录入的教师与考勤记录' });
    const form = wrap.querySelector('#org-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const newName = String(fd.get('name') || '').trim();
      const departmentId = String(fd.get('departmentId') || '');
      if (!newName) { wrap.querySelector('#org-err').textContent = '请填写年级名称'; return; }
      try {
        const r = await api.patch(`/departments/grades/${encodeURIComponent(name)}`, { name: newName, departmentId });
        const n = (r.migrated?.hub || 0) + (r.migrated?.teachers || 0) + (r.migrated?.tables || 0);
        close(); toast(`已保存「${newName}」${n ? `，${n} 条记录同步更新` : ''}`, 'ok', 3500);
        await load({ silent: true });
      } catch (ex) { wrap.querySelector('#org-err').textContent = ex.message || String(ex); }
    };
  }

  async function removeGrade(name) {
    const ok = await confirmDialog(
      `确定删除年级「${name}」吗？只从部门列表移除，已录入的教师与考勤记录全部保留。`,
      { title: '删除年级', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api.del(`/departments/grades/${encodeURIComponent(name)}`);
      toast('已删除年级，相关记录全部保留', 'ok');
      await load({ silent: true });
    } catch (e) { toast('删除失败：' + (e.message || e), 'warn'); }
  }

  /* ---------------- 教师 ---------------- */
  function openTeacherForm(id) {
    const t = id ? S.teachers.find((x) => String(x.id) === String(id)) : null;
    const editing = !!t;
    const grades = S.depts?.grades || [];
    const body = `<form id="org-form" class="ahub-form">
      <label class="ahub-field"><span>姓名 <i>*</i></span>
        <input name="name" id="org-name" value="${esc(t?.name || '')}" placeholder="如：李老师" autocomplete="off"></label>
      <label class="ahub-field"><span>学科</span>
        <input name="subject" id="org-subject" value="${esc(t?.subject || '')}" placeholder="如：语文" autocomplete="off"></label>
      <label class="ahub-field"><span>所属部门</span>
        <select name="department" id="org-dept">${deptOptions(t?.department || (S.depts?.list?.[0]?.name || ''))}</select></label>
      <label class="ahub-field"><span>所属年级</span>
        <select name="grade" id="org-grade">
          <option value="">—</option>
          ${grades.map((g) => `<option value="${esc(g)}"${g === t?.grade ? ' selected' : ''}>${esc(g)}</option>`).join('')}
        </select></label>
      <label class="ahub-field"><span>在职状态</span>
        <select name="status" id="org-status">
          ${['在职', '休假', '离职'].map((s) => `<option value="${s}"${(t?.status || '在职') === s ? ' selected' : ''}>${s}</option>`).join('')}
        </select></label>
      <div class="ahub-form-err" id="org-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay(editing ? '编辑教师' : '新增教师', body, {
      sub: editing ? '改完直接同步到花名册' : '新增后自动出现在花名册，序号按现有名单顺延',
    });
    const form = wrap.querySelector('#org-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      if (!String(data.name || '').trim()) { wrap.querySelector('#org-err').textContent = '请填写姓名'; return; }
      try {
        if (editing) await api.patch(`/org/teachers/${encodeURIComponent(id)}`, data);
        else await api.post('/org/teachers', data);
        close(); toast(editing ? '已保存' : '已新增教师', 'ok');
        await load({ silent: true });
      } catch (ex) { wrap.querySelector('#org-err').textContent = ex.message || String(ex); }
    };
    setTimeout(() => wrap.querySelector('#org-name')?.focus(), 30);
  }

  async function removeTeacher(id) {
    const t = S.teachers.find((x) => String(x.id) === String(id));
    if (!t) return;
    const ok = await confirmDialog(`确定删除教师「${t.name}」吗？删除后不再出现在花名册与考勤名单里。`,
      { title: '删除教师', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api.del(`/org/teachers/${encodeURIComponent(id)}`);
      toast('已删除教师', 'ok');
      await load({ silent: true });
    } catch (e) { toast('删除失败：' + (e.message || e), 'warn'); }
  }

  /* ---------------- 科目 ---------------- */
  function openSubjectAdd() {
    const body = `<form id="org-form" class="ahub-form one">
      <label class="ahub-field"><span>科目名称 <i>*</i></span>
        <input name="name" id="org-name" placeholder="如：语文" autocomplete="off"></label>
      <div class="ahub-field-hint">科目分类按名称自动归档（语言与人文 / 数学与科学 / 艺术与体育 / 其他）</div>
      <div class="ahub-form-err" id="org-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('新增科目', body, { sub: '人数按花名册里该学科的教师数统计', size: 'sm' });
    const form = wrap.querySelector('#org-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) { wrap.querySelector('#org-err').textContent = '请填写科目名称'; return; }
      try {
        await api.post('/org/subjects', { name });
        close(); toast(`已新增科目「${name}」`, 'ok'); await load({ silent: true });
      } catch (ex) { wrap.querySelector('#org-err').textContent = ex.message || String(ex); }
    };
    setTimeout(() => wrap.querySelector('#org-name')?.focus(), 30);
  }

  function openSubjectEdit(id) {
    const s = S.subjects.find((x) => String(x.id) === String(id));
    if (!s) return;
    const body = `<form id="org-form" class="ahub-form one">
      <label class="ahub-field"><span>科目名称 <i>*</i></span>
        <input name="name" id="org-name" value="${esc(s.name)}" autocomplete="off"></label>
      <div class="ahub-field-hint">改名后，花名册里该学科的教师会一起改成新名称</div>
      <div class="ahub-form-err" id="org-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('编辑科目', body, { sub: '只改名称，不影响其他科目', size: 'sm' });
    const form = wrap.querySelector('#org-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) { wrap.querySelector('#org-err').textContent = '请填写科目名称'; return; }
      try {
        await api.patch(`/org/subjects/${encodeURIComponent(id)}`, { name });
        close(); toast(`已保存「${name}」`, 'ok'); await load({ silent: true });
      } catch (ex) { wrap.querySelector('#org-err').textContent = ex.message || String(ex); }
    };
  }

  async function removeSubject(id) {
    const s = S.subjects.find((x) => String(x.id) === String(id));
    if (!s) return;
    const extra = s.count ? `还有 ${s.count} 位教师的学科是「${s.name}」，删除科目不会改教师资料。` : '删除后可在需要时重新新增。';
    const ok = await confirmDialog(`确定删除科目「${s.name}」吗？${extra}`,
      { title: '删除科目', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api.del(`/org/subjects/${encodeURIComponent(id)}`);
      toast('已删除科目', 'ok');
      await load({ silent: true });
    } catch (e) { toast('删除失败：' + (e.message || e), 'warn'); }
  }

  /* ---------------- 事件 ---------------- */
  $('#org-tabs').querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => switchTab(b.dataset.tab);
  });

  await load();
}
