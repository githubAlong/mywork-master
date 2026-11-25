/* ============================================================================
   attendance-hub.js —— 考勤一级导航下 6 个二级导航的独立页面

   由 work.js 在 #/attendance/<sheetKey> 时按需加载（部门管理走独立模块）。
   5 张数据表共用这一套版式：标题 + 筛选条 + 批量操作 + 独立表格 + 分页。
   数据走 /att-hub/* 接口，各自存在独立的 att_hub_* 表里。

   v3：
   · 花名册 = 部门分组 + 「总花名册 / 高一教师花名册 / 高二教师花名册」页签，
     页签只是同一份数据的筛选视图，不复制数据；新增部门/年级自动多页签。
   · 坐班 / 上课 / 请假：按日期「上一天 / 下一天」翻页查看当天记录。
   · 统计：本日 / 本月 / 本年，只汇总真实录入 / 导入 / 迁移的记录。
   · 每表原有功能（增删改、批量导入、导出 CSV、搜索、筛选、分页）一个不删。
   ========================================================================== */
import { api, esc, toast, confirmDialog, saveBlob } from './core.js';
import {
  HUB_SHEETS, sheetDef, blankRow, toCsv, fromCsv, validateRow, gradeOptions,
  gradeKey, rosterTabLabel, shiftDate, periodRange, DEFAULT_DEPARTMENT,
} from './attendance-hub-domain.mjs';

const PAGE_SIZE = 20;
/* 年级列表从 /grades 动态读取（见 loadGrades），这里不再写死。 */

const optionHTML = (list, cur) => list.map((v) =>
  `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(v)}</option>`).join('');

function statusCls(v) {
  const s = String(v || '');
  if (['在岗', '已上课', '已通过', '在职'].includes(s)) return 'ok';
  if (['迟到', '待审批', '休假', '调课', '代课'].includes(s)) return 'warn';
  if (['缺勤', '已驳回', '离职', '未上课'].includes(s)) return 'bad';
  return '';
}

function fieldHTML(col, value, extra = {}) {
  const v = value == null ? '' : String(value);
  const id = `ahub-f-${col.key}`;
  /* 所属部门由「部门管理」带出，不再手填：渲染成部门下拉 */
  if (extra.departmentOptions && col.key === 'department') {
    const opts = extra.departmentOptions;
    const merged = v && !opts.includes(v) ? [v, ...opts] : opts;
    return `<label class="ahub-field"><span>${esc(col.label)}${col.required ? ' <i>*</i>' : ''}</span>
      <select name="${esc(col.key)}" id="${esc(id)}">${optionHTML(merged, v)}</select></label>`;
  }
  if (col.type === 'select') {
    /* 编辑历史记录时，旧年级可能已经从年级列表里删掉了；
       把当前值补进选项，避免打开编辑框就静默丢掉一个字段。 */
    const opts = col.options || [];
    const merged = v && !opts.includes(v) ? [v, ...opts] : opts;
    return `<label class="ahub-field"><span>${esc(col.label)}${col.required ? ' <i>*</i>' : ''}</span>
      <select name="${esc(col.key)}" id="${esc(id)}"><option value="">全部 / 未填</option>${optionHTML(merged, v)}</select></label>`;
  }
  const type = col.type === 'date' ? 'date' : col.type === 'time' ? 'time' : col.type === 'number' ? 'number' : 'text';
  return `<label class="ahub-field"><span>${esc(col.label)}${col.required ? ' <i>*</i>' : ''}</span>
    <input type="${type}" name="${esc(col.key)}" id="${esc(id)}" value="${esc(v)}" autocomplete="off"></label>`;
}

function overlay(title, body, { wide = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ahub-mask';
  wrap.innerHTML = `<div class="ahub-dialog${wide ? ' wide' : ''}">
    <div class="ahub-dialog-head"><b>${esc(title)}</b><button class="ahub-x" data-close aria-label="关闭">×</button></div>
    <div class="ahub-dialog-body">${body}</div>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('[data-close]').onclick = close;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
  return { wrap, close };
}

/* 北京日期：与服务端口径一致，凌晨 0~8 点不会差一天 */
function todayCn() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export async function renderAttendanceHub(root, { sheet = 'roster' } = {}) {
  const key = HUB_SHEETS[sheet] ? sheet : 'roster';
  const def = HUB_SHEETS[key];
  const isRoster = key === 'roster';
  const isStats = key === 'stats';
  const hasDate = def.filters.includes('from');
  const S = {
    key, def,
    filters: { dept: '', grade: '', subject: '', from: '', to: '', q: '' },
    page: 1, list: [], total: 0, busy: false,
    grades: gradeOptions(null),
    deptView: null, deptId: '', tab: 'all',
    day: todayCn(), period: '',
  };

  root.innerHTML = `
    <div class="ahub">
      <header class="ahub-head${isRoster ? ' ahub-head-roster' : ''}">
        <div>
          <div class="ahub-crumb">考勤 <span>/</span> ${esc(def.label)}</div>
          <h1>${esc(def.title)}</h1>
          <p>${esc(def.desc)}</p>
        </div>
        <div class="ahub-head-right">
          <span class="ahub-tag">独立表 · ${esc(HUB_SHEETS[key].table)}</span>
          <span class="ahub-count" id="ahub-count">—</span>
        </div>
      </header>

      ${isRoster ? `<section class="ahub-card">
        <div class="ahub-deptbar" id="ahub-deptbar">
          <span class="ahub-deptbar-label">部门</span>
          <select id="ahub-dept"><option value="">全部部门</option></select>
          <div class="ahub-tablist" id="ahub-tablist"></div>
          <a class="ahub-deptbar-link" href="#/attendance/departments">部门管理 →</a>
        </div>
      </section>` : ''}

      ${hasDate && !isStats ? `<section class="ahub-card">
        <div class="ahub-daynav">
          <span class="ahub-daynav-label">按日期翻页查看当天记录</span>
          <button class="ahub-btn ghost" id="ahub-prev-day">← 上一天</button>
          <input type="date" id="ahub-day" value="${esc(S.day)}">
          <button class="ahub-btn ghost" id="ahub-next-day">下一天 →</button>
          <button class="ahub-btn ghost" id="ahub-all-days">全部日期</button>
          <span class="ahub-daynav-state" id="ahub-day-state">当前：全部日期</span>
        </div>
      </section>` : ''}

      ${isStats ? `<section class="ahub-card">
        <div class="ahub-periods">
          <span class="ahub-daynav-label">统计我记录的考勤数据</span>
          <button class="ahub-btn ghost" data-period="day">本日</button>
          <button class="ahub-btn ghost" data-period="month">本月</button>
          <button class="ahub-btn ghost" data-period="year">本年</button>
          <button class="ahub-btn ghost" data-period="">全部</button>
          <span class="ahub-periods-state" id="ahub-period-state">当前：全部记录</span>
        </div>
      </section>` : ''}

      <section class="ahub-card ahub-filters">
        <label class="ahub-field"><span>年级</span>
          <select id="ahub-grade"><option value="">全部年级</option>${optionHTML(S.grades, '')}</select></label>
        ${def.filters.includes('subject') ? `<label class="ahub-field"><span>学科</span>
          <input id="ahub-subject" placeholder="如 语文" autocomplete="off"></label>` : ''}
        ${hasDate ? `<label class="ahub-field"><span>起始日期</span><input type="date" id="ahub-from"></label>
        <label class="ahub-field"><span>结束日期</span><input type="date" id="ahub-to"></label>` : ''}
        <label class="ahub-field grow"><span>搜索</span>
          <input id="ahub-q" placeholder="姓名 / 学科 / 备注等任意字段" autocomplete="off"></label>
        <button class="ahub-btn ghost" id="ahub-reset">重置</button>
      </section>

      <section class="ahub-card">
        <div class="ahub-toolbar">
          <div class="ahub-toolbar-left">
            <button class="ahub-btn primary" id="ahub-add">＋ 新增记录</button>
            <button class="ahub-btn" id="ahub-import">批量导入 CSV</button>
            <button class="ahub-btn" id="ahub-export">导出 CSV</button>
            ${isStats ? '<button class="ahub-btn" id="ahub-refresh">刷新汇总</button>' : ''}
          </div>
          <span class="ahub-tip">部门 / 年级 / 日期只是筛选条件，切换不会隐藏或清除已存数据</span>
        </div>
        <div class="ahub-table-wrap">
          <table class="ahub-table">
            <thead><tr id="ahub-thead"></tr></thead>
            <tbody id="ahub-tbody"></tbody>
          </table>
        </div>
        <div class="ahub-pager">
          <button class="ahub-btn ghost" id="ahub-prev">← 上一页</button>
          <span id="ahub-page">第 1 页</span>
          <button class="ahub-btn ghost" id="ahub-next">下一页 →</button>
        </div>
      </section>
    </div>`;

  const $ = (sel) => root.querySelector(sel);

  /* ---------------- 部门 / 年级配置 ---------------- */
  async function loadDepts() {
    const data = await api.get('/departments').catch(() => null);
    S.deptView = data;
    const list = Array.isArray(data?.list) ? data.list : [];
    /* 默认停在「全部部门」：所有部门下的年级分表都要出现在页签里。
       以前默认选中「高中部」，新建部门 / 年级后花名册仍只显示高中部那几张表，
       用户会以为新部门没生效。只有用户手动选过部门才保留选择。 */
    if (S.deptId && !list.some((d) => String(d.id) === String(S.deptId))) S.deptId = '';
    const sel = $('#ahub-dept');
    if (sel) {
      sel.innerHTML = `<option value="">全部部门</option>${list.map((d) =>
        `<option value="${esc(d.id)}"${String(d.id) === String(S.deptId) ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}`;
    }
    /* 花名册筛选下拉用同一份年级名单，避免两处不同步 */
    if (data && Array.isArray(data.grades) && data.grades.length) {
      S.grades = [...new Set(data.grades.map((g) => String(g).trim()).filter(Boolean))];
      const gsel = $('#ahub-grade');
      if (gsel) gsel.innerHTML = `<option value="">全部年级</option>${optionHTML(S.grades, S.filters.grade)}`;
    }
    paintTabs();
  }

  function currentDept() {
    return (S.deptView?.list || []).find((d) => String(d.id) === String(S.deptId)) || null;
  }

  function paintTabs() {
    const box = $('#ahub-tablist');
    if (!box) return;
    const d = currentDept();
    /* 选「全部部门」时把所有部门的年级合起来做页签，避免分表凭空消失 */
    const allGrades = (S.deptView?.list || []).flatMap((x) => x.grades || []);
    const grades = d ? d.grades : allGrades;
    /* 总表计数取部门配置的真实统计，不用 S.total —— 后者是当前筛选后的行数，
       切到某个年级页签时「总花名册 · N」会跟着变小，看起来像数据丢了。 */
    const totalAll = [...allGrades, ...(S.deptView?.unassigned || [])]
      .reduce((s, g) => s + (Number(g.teacherCount) || 0), 0);
    const tabs = [{ k: 'all', label: '总花名册', count: d ? d.teacherCount : (totalAll || S.total) }];
    for (const g of grades) {
      tabs.push({ k: g.name, label: rosterTabLabel(g.name), count: g.teacherCount || 0 });
    }
    if (!tabs.some((t) => t.k === S.tab)) S.tab = 'all';
    box.innerHTML = tabs.map((t) =>
      `<button type="button" class="ahub-tab${String(t.k) === String(S.tab) ? ' on' : ''}" data-tab="${esc(t.k)}">${esc(t.label)} · ${Number(t.count) || 0}</button>`).join('');
    box.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.onclick = () => {
        S.tab = btn.dataset.tab;
        S.filters.grade = S.tab === 'all' ? '' : S.tab;
        S.page = 1;
        paintTabs();
        load({ silent: true });
      };
    });
  }

  async function loadGrades() {
    const data = await api.get('/grades').catch(() => null);
    if (!S.deptView) S.grades = gradeOptions(data);
    const sel = $('#ahub-grade');
    if (!sel) return;
    const cur = sel.value || '';
    /* 正在筛的年级如果被删掉了，暂时保留这一项，不让筛选条件突然跳回「全部」 */
    const list = cur && !S.grades.includes(cur) ? [cur, ...S.grades] : S.grades;
    sel.innerHTML = `<option value="">全部年级</option>${optionHTML(list, cur)}`;
  }

  /* ---------------- 数据加载 ---------------- */
  /* 花名册增删改之后重新取一次部门配置，页签上的「· N」才不会停在旧数字。
     只更新数据，不重建部门下拉、不改动用户当前选中的部门。 */
  async function refreshDeptCounts() {
    const data = await api.get('/departments').catch(() => null);
    if (data && Array.isArray(data.list)) {
      S.deptView = { ...(S.deptView || {}), ...data };
      paintTabs();
    }
  }

  async function load({ silent = false } = {}) {
    if (S.busy) return;
    S.busy = true;
    try {
      let data = await api.get(`/att-hub/${key}`, S.filters);
      if (data.needsMigration) {
        await api.post('/att-hub-migrate');
        data = await api.get(`/att-hub/${key}`, S.filters);
        if (!silent) toast('已把原考勤工作台的历史数据同步到 5 张新表', 'ok', 3200);
      }
      S.list = Array.isArray(data.list) ? data.list : [];
      S.total = Number(data.total) || S.list.length;
      paint();
      if (isRoster) await refreshDeptCounts();
    } catch (e) {
      if (!silent) toast('加载失败：' + (e.message || e), 'warn', 4000);
      $('#ahub-tbody').innerHTML = `<tr><td colspan="12" class="ahub-empty">加载失败，请刷新重试</td></tr>`;
    } finally {
      S.busy = false;
    }
  }

  function paint() {
    const cols = S.def.columns;
    $('#ahub-thead').innerHTML = cols.map((c) => `<th style="min-width:${c.width || 100}px">${esc(c.label)}</th>`).join('') + '<th class="ahub-ops">操作</th>';
    const pages = Math.max(1, Math.ceil(S.list.length / PAGE_SIZE));
    if (S.page > pages) S.page = pages;
    const start = (S.page - 1) * PAGE_SIZE;
    const pageRows = S.list.slice(start, start + PAGE_SIZE);
    $('#ahub-tbody').innerHTML = pageRows.length
      ? pageRows.map((r) => `<tr data-id="${esc(r.id)}">${cols.map((c) => {
        const v = r[c.key];
        const cls = c.type === 'select' && v ? `ahub-status ahub-st-${statusCls(v)}` : '';
        return `<td${cls ? ` class="${cls}"` : ''}>${v === '' || v == null ? '<span class="ahub-dash">—</span>' : esc(v)}</td>`;
      }).join('')}<td class="ahub-ops">
        <button class="ahub-link" data-act="edit">编辑</button>
        <button class="ahub-link danger" data-act="del">删除</button></td></tr>`).join('')
      : `<tr><td colspan="${cols.length + 1}" class="ahub-empty">暂无记录。点「＋ 新增记录」开始录入，或用「批量导入 CSV」一次导入。</td></tr>`;
    $('#ahub-count').textContent = `共 ${S.total} 条 · 当前筛选 ${S.list.length} 条`;
    $('#ahub-page').textContent = `第 ${S.page} / ${pages} 页`;
    $('#ahub-prev').disabled = S.page <= 1;
    $('#ahub-next').disabled = S.page >= pages;

    $('#ahub-tbody').querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.closest('tr')?.dataset.id;
        const row = S.list.find((x) => String(x.id) === String(id));
        if (!row) return;
        if (btn.dataset.act === 'edit') openForm(row);
        else await removeRow(row);
      };
    });
  }

  /* ---------------- 新增 / 编辑 ---------------- */
  function openForm(row = null) {
    const editing = !!row;
    const values = { ...blankRow(key), ...(row || {}) };
    if (!row && isRoster) {
      /* 所属部门 / 年级由部门分组和当前页签自动带出，不用手填 */
      values.department = currentDept()?.name || DEFAULT_DEPARTMENT;
      if (S.tab !== 'all') values.grade = S.tab;
      else if (!values.grade) values.grade = gradeKey(S.grades[0] || '') || '';
    }
    if (!row && values.grade && !S.grades.includes(values.grade)) values.grade = S.grades[0] || '';
    const deptOptions = (S.deptView?.list || []).map((d) => d.name);
    /* 年级下拉用动态列表，其余列保持字段契约里的固定选项 */
    const cols = S.def.columns.map((c) => (c.key === 'grade' ? { ...c, options: S.grades } : c));
    const body = `<form id="ahub-form" class="ahub-form">
      ${cols.map((c) => fieldHTML(c, values[c.key], { departmentOptions: isRoster ? deptOptions : null })).join('')}
      <div class="ahub-form-err" id="ahub-form-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn ghost" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">${editing ? '保存修改' : '确认新增'}</button>
      </div></form>`;
    const { wrap, close } = overlay(editing ? `编辑${def.label}记录` : `新增${def.label}记录`, body, { wide: true });
    wrap.querySelector('[data-close]').onclick = close;
    const form = wrap.querySelector('#ahub-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const err = validateRow(key, data);
      if (err) { wrap.querySelector('#ahub-form-err').textContent = err; return; }
      try {
        if (editing) await api.patch(`/att-hub/${key}/${row.id}`, data);
        else await api.post(`/att-hub/${key}`, data);
        close(); toast(editing ? '已保存' : '已新增', 'ok');
        await load({ silent: true });
      } catch (ex) {
        wrap.querySelector('#ahub-form-err').textContent = ex.message || String(ex);
      }
    };
    const first = form.querySelector('input,select');
    if (first) first.focus();
  }

  async function removeRow(row) {
    const ok = await confirmDialog(`确定删除这条${def.label}记录吗？`, { title: '删除记录', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api.del(`/att-hub/${key}/${row.id}`);
      toast('已删除', 'ok');
      await load({ silent: true });
    } catch (e) { toast('删除失败：' + (e.message || e), 'warn'); }
  }

  /* ---------------- 批量导入 / 导出 ---------------- */
  function openImport() {
    const head = S.def.columns.map((c) => c.label).join(',');
    const body = `<div class="ahub-import">
      <p>支持 CSV 文件，或直接粘贴表格内容。表头请用「导出 CSV」得到的列名，顺序可以不同。</p>
      <div class="ahub-code">${esc(head)}</div>
      <label class="ahub-field"><span>选择 CSV 文件</span><input type="file" id="ahub-file" accept=".csv,.txt,text/csv"></label>
      <label class="ahub-field"><span>或粘贴 CSV 文本</span><textarea id="ahub-text" rows="7" placeholder="${esc(head)}"></textarea></label>
      <div class="ahub-import-preview" id="ahub-preview">等待输入…</div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn ghost" data-close>取消</button>
        <button type="button" class="ahub-btn primary" id="ahub-do-import">确认导入</button>
      </div></div>`;
    const { wrap, close } = overlay(`批量导入${def.label}`, body, { wide: true });
    wrap.querySelector('[data-close]').onclick = close;
    const preview = wrap.querySelector('#ahub-preview');
    const textArea = wrap.querySelector('#ahub-text');
    let parsed = { rows: [], errors: [] };
    const refresh = () => {
      parsed = fromCsv(key, textArea.value || '');
      preview.innerHTML = parsed.errors.length
        ? `<span class="ahub-bad">${parsed.rows.length} 条可导入，${parsed.errors.length} 条有问题：</span> ${esc(parsed.errors.slice(0, 4).join('；'))}`
        : `<span class="ahub-good">${parsed.rows.length} 条数据校验通过，可以导入</span>`;
    };
    textArea.oninput = refresh;
    wrap.querySelector('#ahub-file').onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      textArea.value = await f.text();
      refresh();
    };
    wrap.querySelector('#ahub-do-import').onclick = async () => {
      if (!parsed.rows.length) { toast('没有可导入的数据', 'warn'); return; }
      try {
        const res = await api.post(`/att-hub/${key}/import`, { items: parsed.rows });
        close();
        toast(`已导入 ${res.added} 条${res.rejected?.length ? `，跳过 ${res.rejected.length} 条` : ''}`, 'ok', 3200);
        await load({ silent: true });
      } catch (ex) { toast('导入失败：' + (ex.message || ex), 'warn', 4000); }
    };
  }

  function exportCsv() {
    if (!S.list.length) { toast('当前筛选没有数据可导出', 'warn'); return; }
    const blob = new Blob([toCsv(key, S.list)], { type: 'text/csv;charset=utf-8' });
    saveBlob(blob, `${def.label}-${new Date().toISOString().slice(0, 10)}.csv`);
    toast(`已导出 ${S.list.length} 条`, 'ok');
  }

  /* ---------------- 事件绑定 ---------------- */
  const bindFilter = (sel, name) => {
    const el = $(sel);
    if (!el) return;
    const apply = () => { S.filters[name] = el.value; S.page = 1; load({ silent: true }); };
    if (el.tagName === 'SELECT') el.onchange = apply;
    else { let timer; el.oninput = () => { clearTimeout(timer); timer = setTimeout(apply, 280); }; }
  };
  if ($('#ahub-dept')) {
    $('#ahub-dept').onchange = () => {
      S.deptId = $('#ahub-dept').value;
      const d = currentDept();
      S.filters.dept = d ? d.name : '';
      S.filters.grade = ''; S.tab = 'all'; S.page = 1;
      paintTabs(); load({ silent: true });
    };
  }
  bindFilter('#ahub-grade', 'grade');
  /* 年级下拉与三张表页签是同一个筛选条件，必须双向同步：
     手动选年级时高亮对应页签（或回到总花名册），否则会出现「表格是高一、页签却停在总表」。 */
  const gradeSel = $('#ahub-grade');
  if (gradeSel && isRoster) {
    const prev = gradeSel.onchange;
    gradeSel.onchange = () => {
      prev?.();
      /* 「全部部门」下没有 currentDept()，要用全部部门的年级池来匹配页签，
         否则手动选年级后页签会错误地跳回总花名册。 */
      const pool = currentDept()?.grades || (S.deptView?.list || []).flatMap((x) => x.grades || []);
      const match = pool.find((g) => gradeKey(g.name) === gradeKey(S.filters.grade));
      S.tab = S.filters.grade ? (match?.name || 'all') : 'all';
      paintTabs();
    };
  }
  bindFilter('#ahub-subject', 'subject');
  bindFilter('#ahub-from', 'from');
  bindFilter('#ahub-to', 'to');
  bindFilter('#ahub-q', 'q');
  $('#ahub-reset').onclick = () => {
    S.filters = { dept: S.filters.dept, grade: '', subject: '', from: '', to: '', q: '' };
    ['#ahub-grade', '#ahub-subject', '#ahub-from', '#ahub-to', '#ahub-q'].forEach((s) => { const e = $(s); if (e) e.value = ''; });
    S.tab = 'all'; S.day = todayCn(); S.period = '';
    paintTabs(); paintDayState(); paintPeriodState();
    S.page = 1; load({ silent: true });
  };

  /* 按日期翻页：选中某天时 from=to=该天；「全部日期」清掉日期筛选 */
  function paintDayState() {
    const el = $('#ahub-day-state');
    if (!el) return;
    el.textContent = S.filters.from && S.filters.from === S.filters.to
      ? `当前：${S.filters.from} 的记录` : '当前：全部日期';
  }
  function setDay(d) {
    S.day = d;
    const input = $('#ahub-day');
    if (input) input.value = d;
    S.filters.from = d; S.filters.to = d;
    const f = $('#ahub-from'), t = $('#ahub-to');
    if (f) f.value = d; if (t) t.value = d;
    S.page = 1;
    paintDayState();
    load({ silent: true });
  }
  if ($('#ahub-prev-day')) {
    $('#ahub-prev-day').onclick = () => setDay(shiftDate(S.day, -1));
    $('#ahub-next-day').onclick = () => setDay(shiftDate(S.day, 1));
    $('#ahub-day').onchange = (e) => { if (e.target.value) setDay(e.target.value); };
    $('#ahub-all-days').onclick = () => {
      S.filters.from = ''; S.filters.to = '';
      const f = $('#ahub-from'), t = $('#ahub-to');
      if (f) f.value = ''; if (t) t.value = '';
      S.page = 1; paintDayState(); load({ silent: true });
    };
  }

  /* 统计：本日 / 本月 / 本年 */
  function paintPeriodState() {
    const el = $('#ahub-period-state');
    if (!el) return;
    el.textContent = S.period ? `当前：${periodRange(S.period, todayCn()).label}` : '当前：全部记录';
    root.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('on', b.dataset.period === S.period));
  }
  root.querySelectorAll('[data-period]').forEach((btn) => {
    btn.onclick = async () => {
      S.period = btn.dataset.period || '';
      const r = periodRange(S.period, todayCn());
      S.filters.from = r.from; S.filters.to = r.to;
      const f = $('#ahub-from'), t = $('#ahub-to');
      if (f) f.value = r.from; if (t) t.value = r.to;
      S.page = 1;
      paintPeriodState();
      try {
        const res = await api.post('/att-hub-refresh', {
          from: r.from, to: r.to, label: r.label, grade: S.filters.grade || '全部',
        });
        toast(`已按「${r.label}」重算 ${res.count} 条汇总（手工修正的记录保留）`, 'ok', 3500);
      } catch (e) { toast('汇总失败：' + (e.message || e), 'warn'); }
      await load({ silent: true });
    };
  });

  $('#ahub-add').onclick = () => openForm();
  $('#ahub-import').onclick = openImport;
  $('#ahub-export').onclick = exportCsv;
  $('#ahub-prev').onclick = () => { if (S.page > 1) { S.page -= 1; paint(); } };
  $('#ahub-next').onclick = () => { if (S.page * PAGE_SIZE < S.list.length) { S.page += 1; paint(); } };
  if ($('#ahub-refresh')) $('#ahub-refresh').onclick = async () => {
    try {
      const r = periodRange(S.period, todayCn());
      const res = await api.post('/att-hub-refresh', {
        period: S.filters.from || '', grade: S.filters.grade || '全部',
        from: S.filters.from, to: S.filters.to, label: r.label || '全部',
      });
      toast(`已重算 ${res.count} 条汇总（手工修正的记录保留）`, 'ok', 3500);
      await load({ silent: true });
    } catch (e) { toast('汇总失败：' + (e.message || e), 'warn'); }
  };

  await loadDepts();
  if (isRoster && currentDept()) S.filters.dept = currentDept().name;
  await loadGrades();
  await load();
}
