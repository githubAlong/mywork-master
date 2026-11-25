/* ============================================================================
   attendance-hub.js —— 考勤一级导航下 5 个二级导航的独立页面

   由 work.js 在 #/attendance/<sheetKey> 时按需加载。
   5 个页面共用这一套版式：标题 + 筛选条 + 批量操作 + 独立表格 + 分页。
   数据走 /att-hub/* 接口，各自存在独立的 att_hub_* 表里。
   ========================================================================== */
import { api, esc, toast, confirmDialog, saveBlob } from './core.js';
import {
  HUB_SHEETS, sheetDef, blankRow, toCsv, fromCsv, validateRow,
} from './attendance-hub-domain.mjs';

const PAGE_SIZE = 20;
const GRADES = ['高一', '高二', '高三'];

const optionHTML = (list, cur) => list.map((v) =>
  `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(v)}</option>`).join('');

function statusCls(v) {
  const s = String(v || '');
  if (['在岗', '已上课', '已通过', '在职'].includes(s)) return 'ok';
  if (['迟到', '待审批', '休假', '调课', '代课'].includes(s)) return 'warn';
  if (['缺勤', '已驳回', '离职', '未上课'].includes(s)) return 'bad';
  return '';
}

function fieldHTML(col, value) {
  const v = value == null ? '' : String(value);
  const id = `ahub-f-${col.key}`;
  if (col.type === 'select') {
    return `<label class="ahub-field"><span>${esc(col.label)}${col.required ? ' <i>*</i>' : ''}</span>
      <select name="${esc(col.key)}" id="${esc(id)}"><option value="">全部 / 未填</option>${optionHTML(col.options || [], v)}</select></label>`;
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

export async function renderAttendanceHub(root, { sheet = 'roster' } = {}) {
  const key = HUB_SHEETS[sheet] ? sheet : 'roster';
  const def = HUB_SHEETS[key];
  const S = {
    key, def,
    filters: { grade: '', subject: '', from: '', to: '', q: '' },
    page: 1, list: [], total: 0, busy: false,
  };

  root.innerHTML = `
    <div class="ahub">
      <header class="ahub-head">
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

      <section class="ahub-card ahub-filters">
        <label class="ahub-field"><span>年级</span>
          <select id="ahub-grade"><option value="">全部年级</option>${optionHTML(GRADES, '')}</select></label>
        ${def.filters.includes('subject') ? `<label class="ahub-field"><span>学科</span>
          <input id="ahub-subject" placeholder="如 语文" autocomplete="off"></label>` : ''}
        ${def.filters.includes('from') ? `<label class="ahub-field"><span>起始日期</span><input type="date" id="ahub-from"></label>
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
            ${key === 'stats' ? '<button class="ahub-btn" id="ahub-refresh">刷新汇总</button>' : ''}
            <button class="ahub-btn ghost" id="ahub-migrate" title="把旧年级工作台里的历史数据同步到这 5 张表">同步旧数据</button>
          </div>
          <span class="ahub-tip">年级 / 日期只是筛选条件，切换不会隐藏或清除已存数据</span>
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

  /* ---------------- 数据加载 ---------------- */
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
    const body = `<form id="ahub-form" class="ahub-form">
      ${S.def.columns.map((c) => fieldHTML(c, values[c.key])).join('')}
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
    const ok = await confirmDialog(`确定删除这条${def.label}记录吗？删除后可在回收站之外通过重新同步旧数据找回（如来自迁移）。`, { title: '删除记录', okText: '删除', danger: true });
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
  bindFilter('#ahub-grade', 'grade');
  bindFilter('#ahub-subject', 'subject');
  bindFilter('#ahub-from', 'from');
  bindFilter('#ahub-to', 'to');
  bindFilter('#ahub-q', 'q');
  $('#ahub-reset').onclick = () => {
    S.filters = { grade: '', subject: '', from: '', to: '', q: '' };
    ['#ahub-grade', '#ahub-subject', '#ahub-from', '#ahub-to', '#ahub-q'].forEach((s) => { const e = $(s); if (e) e.value = ''; });
    S.page = 1; load({ silent: true });
  };
  $('#ahub-add').onclick = () => openForm();
  $('#ahub-import').onclick = openImport;
  $('#ahub-export').onclick = exportCsv;
  $('#ahub-prev').onclick = () => { if (S.page > 1) { S.page -= 1; paint(); } };
  $('#ahub-next').onclick = () => { if (S.page * PAGE_SIZE < S.list.length) { S.page += 1; paint(); } };
  $('#ahub-migrate').onclick = async () => {
    try {
      const res = await api.post('/att-hub-migrate');
      const sum = Object.entries(res.migrated || {}).map(([k, v]) => `${HUB_SHEETS[k].label} ${v}`).join('、');
      toast(`同步完成：${sum || '没有新增数据'}`, 'ok', 4200);
      await load({ silent: true });
    } catch (e) { toast('同步失败：' + (e.message || e), 'warn'); }
  };
  if ($('#ahub-refresh')) $('#ahub-refresh').onclick = async () => {
    try {
      const res = await api.post('/att-hub-refresh', { period: S.filters.from || '', grade: S.filters.grade || '全部' });
      toast(`已重算 ${res.count} 条汇总（手工修正的记录保留）`, 'ok', 3500);
      await load({ silent: true });
    } catch (e) { toast('汇总失败：' + (e.message || e), 'warn'); }
  };

  await load();
}
