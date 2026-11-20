import { state } from './ui.js';
import { api, el, esc, toast, sheet, confirmDialog, ymd, download } from './core.js';
import {
  addPaymentPatch,
  buildInvigSummary,
  calcDurationMinutes,
  calcInvigAmount,
  parseSettlementMeta,
  removePaymentPatch,
  settlementOf,
  undoLegacySettlementPatch,
} from './invigilation-domain.mjs';

const TYPE_LABEL = {
  school: '学校分配',
  '替他人': '我代别人',
  '他人替我': '别人代我',
};
const DEFAULT_RULES = {
  mode: '分钟',
  schoolHourlyRate: 40,
};

function currentMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function shiftMonth(value, delta) {
  const parts = String(value).split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function monthLabel(value) {
  const parts = String(value || '').split('-');
  return parts.length === 2 ? parts[0] + '年' + Number(parts[1]) + '月' : '选择月份';
}
function money(value) {
  return (Math.round((Number(value) || 0) * 100) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
/* 用户 11-15 要求：日期统一显示年月日，不再只显示 MM/DD */
function dateLabel(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return match ? Number(match[1]) + '年' + Number(match[2]) + '月' + Number(match[3]) + '日' : text || '—';
}
function timeLabel(row) {
  const start = String(row.start_time || '').slice(0, 5);
  const end = String(row.end_time || '').slice(0, 5);
  return start && end ? start + '—' + end : start || end || '—';
}
function rowType(row) {
  return row.duty_type || 'school';
}
function typeLabel(row) {
  return TYPE_LABEL[rowType(row)] || '其他';
}
function peerLabel(row) {
  if (rowType(row) === 'school') return '学校分配';
  return String(row.peer_name || row.orig_teacher || row.person || '未填写');
}
function statusLabel(row, state) {
  const type = rowType(row);
  if (state.status === 'unpriced') return '未计价';
  if (state.status === 'done') return type === 'school' ? '已到账' : '已结清';
  if (state.status === 'partial') return type === 'school' ? '部分到账' : type === '替他人' ? '部分收款' : '部分付款';
  return type === 'school' ? '待学校发放' : type === '替他人' ? '待收款' : '待付款';
}
function statusClass(state) {
  return state.status === 'done' ? 'done' : state.status === 'partial' ? 'part' : state.status === 'unpriced' ? 'wait' : 'todo';
}
function paymentActionLabel(row) {
  const type = rowType(row);
  return type === 'school' ? '记到账' : type === '替他人' ? '记收款' : '记付款';
}
function paymentDirection(row) {
  const type = rowType(row);
  return type === 'school' ? '学校到账' : type === '替他人' ? '同事收款' : '同事付款';
}
function paymentId() {
  return 'ivp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}
function csvCell(value) {
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}
function csvText(headers, rows) {
  return '\ufeff' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
function downloadBlob(content, mime, filename) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  download(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function invigTeacherNames(row) {
  const type = rowType(row);
  if (type === 'school') return { original: row.orig_teacher || '学校分配', actual: row.person || '本人' };
  return {
    original: row.orig_teacher || (type === '替他人' ? row.peer_name || '' : '本人'),
    actual: type === '他人替我' ? (row.person && row.person !== '本人' ? row.person : row.peer_name || '') : row.person || '本人',
  };
}
function htmlTable(rows) {
  return '<table><thead><tr><th>日期</th><th>类型</th><th>考试名称</th><th>科目</th><th>考场</th><th>时间</th><th>时长</th><th>原监考人</th><th>实际监考人</th><th>金额（元）</th><th>签字</th></tr></thead><tbody>'
    + rows.map((row) => {
      const { original, actual } = invigTeacherNames(row);
      return '<tr><td>' + esc(row.date || '') + '</td><td>' + esc(typeLabel(row)) + '</td><td>' + esc(row.exam_name || '') + '</td><td>' + esc(row.subject || '') + '</td><td>' + esc(row.room || row.place || '') + '</td><td>' + esc(timeLabel(row)) + '</td><td>' + esc(row.duration_min || row.minutes || 0) + ' 分钟</td><td>' + esc(original) + '</td><td>' + esc(actual) + '</td><td>' + money(row.pay_amount != null ? row.pay_amount : row.amount) + '</td><td></td></tr>';
    }).join('')
    + '</tbody></table>';
}
function sheetDocument(month, rows) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>监考表</title><style>'
    + 'body{font-family:Microsoft YaHei,Arial,sans-serif;color:#222;padding:24px}h1{text-align:center;font-size:22px;margin:0 0 8px}.meta{text-align:center;color:#666;margin-bottom:18px;font-size:12px}'
    + 'table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #777;padding:7px 5px;text-align:center}th{background:#f0f1f5}.sign{display:flex;justify-content:space-between;margin-top:24px;font-size:12px}'
    + '@page{size:A4 landscape;margin:12mm}</style></head><body><h1>' + monthLabel(month) + '监考安排表</h1><div class="meta">共 ' + rows.length + ' 场监考</div>'
    + htmlTable(rows) + '<div class="sign"><span>填表人：________________</span><span>审核：________________</span><span>日期：________________</span></div></body></html>';
}

export async function renderInvigilation(box) {
  let month = currentMonth();
  let activeTab = 'records';
  let rows = [];
  let cloudLoaded = false;
  let rules = { ...DEFAULT_RULES };
  let summary = buildInvigSummary([], rules);
  let typeFilter = 'all';
  let statusFilter = 'all';
  let subjectFilter = 'all';
  let keyword = '';
  let sheetFilter = 'all';

  const rowById = (id) => rows.find((row) => String(row.id) === String(id));
  const reload = async () => {
    box.innerHTML = '<div class="iv-loading">正在读取监考台账…</div>';
    try {
      const data = await api.get('/invig/summary?month=' + month);
      rows = Array.isArray(data.rows) ? data.rows : [];
      cloudLoaded = data.source === 'cloud';
      rules = { ...DEFAULT_RULES, ...(data.rules || {}) };
      summary = buildInvigSummary(rows, rules);
      render();
      return true;
    } catch (error) {
      box.innerHTML = '<div class="iv-error"><b>监考台账加载失败</b><span>' + esc(error.message || '请检查网络后重试') + '</span><button class="btn primary" data-retry>重新加载</button></div>';
      box.querySelector('[data-retry]').onclick = reload;
      return false;
    }
  };

  const render = () => {
    box.innerHTML = '<div class="iv-page">'
      + '<div class="iv-toolbar">'
      + '<div class="iv-month"><button class="icon-btn sm" data-prev-month aria-label="上个月">‹</button><input type="month" id="iv-month" value="' + esc(month) + '" aria-label="选择月份"><button class="icon-btn sm" data-next-month aria-label="下个月">›</button></div>'
      + '<span class="iv-toolbar-spacer"></span>'
      + '<span class="tiny muted" role="status">' + (cloudLoaded ? '已读取云端监考记录' : '显示本机监考记录') + '</span>'
      + '<button class="btn ghost sm" data-rules>计价设置</button>'
      + '<button class="btn ghost sm" data-export-records>导出记录</button>'
      + '<button class="btn primary sm" data-add>＋ 记一场监考</button>'
      + '</div>'
      + '<nav class="iv-tabs">'
      + '<button class="' + (activeTab === 'records' ? 'on' : '') + '" data-tab="records">监考记录 <span>' + rows.length + '</span></button>'
      + '<button class="' + (activeTab === 'settlement' ? 'on' : '') + '" data-tab="settlement">月度结算</button>'
      + '<button class="' + (activeTab === 'sheet' ? 'on' : '') + '" data-tab="sheet">监考表</button>'
      + '</nav>'
      + '<div class="iv-content" data-iv-content></div>'
      + '</div>';

    box.querySelector('[data-prev-month]').onclick = () => { month = shiftMonth(month, -1); reload(); };
    box.querySelector('[data-next-month]').onclick = () => { month = shiftMonth(month, 1); reload(); };
    box.querySelector('#iv-month').onchange = (event) => {
      if (!event.target.value) return;
      month = event.target.value;
      reload();
    };
    box.querySelector('[data-rules]').onclick = openRules;
    box.querySelector('[data-add]').onclick = () => openEditor(null);
    box.querySelector('[data-export-records]').onclick = exportRecords;
    box.querySelectorAll('[data-tab]').forEach((button) => {
      button.onclick = () => {
        activeTab = button.dataset.tab;
        render();
      };
    });

    const content = box.querySelector('[data-iv-content]');
    if (activeTab === 'records') content.innerHTML = renderRecords();
    else if (activeTab === 'settlement') content.innerHTML = renderSettlement();
    else content.innerHTML = renderSheet();
    bindContent();
  };

  function renderKpis() {
    const netText = summary.net.direction === 'even'
      ? '应收与应付已平'
      : (summary.net.direction === 'receivable' ? '净应收 ' : '净应付 ') + money(Math.abs(summary.net.amount)) + ' 元';
    return '<div class="iv-kpis">'
      + '<article class="iv-kpi iv-kpi-primary"><span>本月监考总时长</span><strong>' + money(summary.minutes) + '<small>分钟</small></strong><em>' + summary.total + ' 场 · ' + Math.floor(summary.minutes / 60) + ' 小时 ' + (summary.minutes % 60) + ' 分</em></article>'
      + '<article class="iv-kpi"><span>学校应发</span><strong>' + money(summary.school.amount) + '<small>元</small></strong><em>已到账 ' + money(summary.school.paid) + ' · 待到账 ' + money(summary.school.unpaid) + '</em></article>'
      + '<article class="iv-kpi"><span>我应收</span><strong class="green">' + money(summary.sub_out.open_amount) + '<small>元</small></strong><em>应收总额 ' + money(summary.sub_out.amount) + ' · 已收 ' + money(summary.sub_out.paid_amount) + '</em></article>'
      + '<article class="iv-kpi"><span>我应付</span><strong class="amber">' + money(summary.sub_in.open_amount) + '<small>元</small></strong><em>应付总额 ' + money(summary.sub_in.amount) + ' · 已付 ' + money(summary.sub_in.paid_amount) + '</em></article>'
      + '<article class="iv-kpi"><span>同事往来净额</span><strong>' + (summary.net.direction === 'even' ? '已平' : money(Math.abs(summary.net.amount)) + '<small>元</small>') + '</strong><em>' + netText + '（不含学校款）</em></article>'
      + '</div>';
  }

  function filteredRows() {
    const key = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      const state = settlementOf(row);
      if (typeFilter !== 'all' && rowType(row) !== typeFilter) return false;
      if (statusFilter !== 'all' && state.status !== statusFilter) return false;
      if (subjectFilter !== 'all' && String(row.subject || '') !== subjectFilter) return false;
      if (key) {
        const text = [row.exam_name, row.subject, row.room, row.peer_name, row.person, row.remark, row.grade].join(' ').toLowerCase();
        if (!text.includes(key)) return false;
      }
      return true;
    });
  }

  function renderRecordRow(row, index) {
    const state = settlementOf(row);
    const type = rowType(row);
    const amountSub = state.paid > 0
      ? '已收付 ' + money(state.paid) + ' · 剩余 ' + money(state.remaining)
      : (state.status === 'unpriced' ? '尚未计价' : '待结 ' + money(state.remaining));
    const actions = (state.remaining > 0 && state.status !== 'unpriced'
      ? '<button class="iv-action primary" data-pay="' + esc(row.id) + '">' + paymentActionLabel(row) + '</button>'
      : '')
      + '<button class="iv-action" data-history="' + esc(row.id) + '">收付明细</button>'
      + '<button class="iv-action" data-edit="' + esc(row.id) + '">编辑</button>'
      + '<button class="iv-action danger" data-delete="' + esc(row.id) + '">删除</button>';
    return '<tr>'
      + '<td class="iv-no">' + (index + 1) + '</td>'
      + '<td class="iv-date"><b>' + esc(dateLabel(row.date)) + '</b></td>'
      + '<td><span class="iv-type ' + (type === 'school' ? 'school' : type === '替他人' ? 'earn' : 'pay') + '">' + esc(typeLabel(row)) + '</span></td>'
      /* 用户 11-15 要求：考试名称、科目、年级各占一列，不再合并成「考试 / 科目」 */
      + '<td class="iv-exam"><b>' + esc(row.exam_name || '未填写考试名称') + '</b></td>'
      + '<td>' + esc(row.subject || '—') + '</td>'
      + '<td>' + esc(row.grade || '—') + '</td>'
      + '<td>' + esc(row.room || row.place || '—') + '</td>'
      + '<td class="iv-time">' + esc(timeLabel(row)) + '</td>'
      + '<td class="iv-num">' + money(row.duration_min || row.minutes || 0) + ' 分钟</td>'
      + '<td>' + esc(peerLabel(row)) + '</td>'
      + '<td class="iv-money"><b>¥' + money(state.total) + '</b></td>'
      /* 用户 11-15 要求：金额与收付分开成两列记录 */
      + '<td class="iv-pay-state">' + amountSub + '</td>'
      + '<td><span class="iv-status ' + statusClass(state) + '">' + esc(statusLabel(row, state)) + '</span></td>'
      + '<td class="iv-actions">' + actions + '</td>'
      + '</tr>';
  }

  function renderRecords() {
    const filtered = filteredRows();
    const subjects = [...new Set(rows.map((row) => String(row.subject || '').trim()).filter(Boolean))].sort();
    const subjectOptions = ['<option value="all">全部科目</option>'].concat(subjects.map((subject) => '<option value="' + esc(subject) + '"' + (subjectFilter === subject ? ' selected' : '') + '>' + esc(subject) + '</option>')).join('');
    const rowsHtml = filtered.length
      ? filtered.map(renderRecordRow).join('')
      : '<tr><td colspan="14"><div class="iv-empty"><b>没有符合条件的监考记录</b><span>可以调整筛选条件，或新增一场监考。</span><button class="btn primary sm" data-add-empty>新增监考</button></div></td></tr>';
    return renderKpis()
      + '<div class="iv-filterbar">'
      + '<select data-filter-type><option value="all">全部监考类型</option><option value="school"' + (typeFilter === 'school' ? ' selected' : '') + '>学校分配</option><option value="替他人"' + (typeFilter === '替他人' ? ' selected' : '') + '>我代别人</option><option value="他人替我"' + (typeFilter === '他人替我' ? ' selected' : '') + '>别人代我</option></select>'
      + '<select data-filter-status><option value="all">全部结算状态</option><option value="unpaid"' + (statusFilter === 'unpaid' ? ' selected' : '') + '>待结算</option><option value="partial"' + (statusFilter === 'partial' ? ' selected' : '') + '>部分结算</option><option value="done"' + (statusFilter === 'done' ? ' selected' : '') + '>已结清</option><option value="unpriced"' + (statusFilter === 'unpriced' ? ' selected' : '') + '>未计价</option></select>'
      + '<select data-filter-subject>' + subjectOptions + '</select>'
      + '<input data-filter-keyword type="search" placeholder="搜索考试、考场、科目或老师" value="' + esc(keyword) + '">'
      + '<button class="btn ghost sm" data-filter-reset>清空筛选</button>'
      + '<span class="iv-filter-count">显示 ' + filtered.length + ' / ' + rows.length + ' 场</span>'
      + '</div>'
      + '<section class="iv-panel">'
      + '<div class="iv-panel-head"><div><b>监考记录</b><span>点击收付明细可查看每一笔到账或付款</span></div><span class="iv-panel-meta">' + monthLabel(month) + '</span></div>'
      + '<div class="iv-table-wrap"><table class="iv-table"><thead><tr><th>序号</th><th>日期</th><th>类型</th><th>考试名称</th><th>科目</th><th>年级</th><th>考场</th><th>时间</th><th>时长</th><th>对方</th><th>金额</th><th>收付</th><th>状态</th><th>操作</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>'
      + '<div class="iv-table-foot"><span>学校款单独统计；同事之间按实际收付金额逐笔对账。</span><b>本月共 ' + rows.length + ' 场</b></div>'
      + '</section>';
  }

  function renderSettlementRow(row) {
    const state = settlementOf(row);
    return '<tr><td>' + esc(dateLabel(row.date)) + '</td><td>' + esc(row.exam_name || row.subject || '监考') + '</td><td>' + esc(row.room || row.place || '—') + '</td><td>' + esc(timeLabel(row)) + '</td><td class="iv-num">¥' + money(state.total) + '</td><td class="iv-num">¥' + money(state.paid) + '</td><td class="iv-num">¥' + money(state.remaining) + '</td><td><span class="iv-status ' + statusClass(state) + '">' + esc(statusLabel(row, state)) + '</span></td><td>' + (state.remaining > 0 && state.status !== 'unpriced'
      ? '<button class="iv-action primary" data-pay="' + esc(row.id) + '">' + paymentActionLabel(row) + '</button>'
      : '<button class="iv-action" data-history="' + esc(row.id) + '">查看明细</button>') + '</td></tr>';
  }

  function renderPersonGroup(person, index) {
    const label = person.direction === 'out' ? '应收' : '应付';
    const openRows = person.items.map((item) => item.row);
    return '<article class="iv-person-card">'
      + '<div class="iv-person-head"><div class="iv-person-name"><b>' + esc(person.name) + '</b><span class="iv-type ' + (person.direction === 'out' ? 'earn' : 'pay') + '">' + label + '</span><small>' + person.count + ' 场</small></div>'
      + '<div class="iv-person-money"><span>应结 <b>¥' + money(person.amount) + '</b></span><span>已' + (person.direction === 'out' ? '收' : '付') + ' <b>¥' + money(person.paid_amount) + '</b></span><span>待' + (person.direction === 'out' ? '收' : '付') + ' <b class="iv-due">¥' + money(person.open_amount) + '</b></span></div>'
      + '<div class="iv-person-actions">' + (person.open_amount > 0
        ? '<button class="btn primary sm" data-pay-all="' + index + '">结清剩余</button>'
        : '<span class="iv-status done">已结清</span>') + '</div></div>'
      + '<div class="iv-table-wrap"><table class="iv-table iv-settle-table"><thead><tr><th>日期</th><th>考试 / 考场</th><th>应结</th><th>已' + (person.direction === 'out' ? '收' : '付') + '</th><th>剩余</th><th>状态</th><th>操作</th></tr></thead><tbody>'
      + openRows.map((row) => {
        const state = settlementOf(row);
        return '<tr><td>' + esc(dateLabel(row.date)) + '</td><td>' + esc(row.exam_name || row.subject || '监考') + (row.room ? '<small class="iv-cell-sub">' + esc(row.room) + '</small>' : '') + '</td><td>¥' + money(state.total) + '</td><td>¥' + money(state.paid) + '</td><td>¥' + money(state.remaining) + '</td><td><span class="iv-status ' + statusClass(state) + '">' + esc(statusLabel(row, state)) + '</span></td><td>' + (state.remaining > 0 && state.status !== 'unpriced'
          ? '<button class="iv-action primary" data-pay="' + esc(row.id) + '">' + paymentActionLabel(row) + '</button>'
          : '<button class="iv-action" data-history="' + esc(row.id) + '">明细</button>') + '</td></tr>';
      }).join('')
      + '</tbody></table></div></article>';
  }

  function renderSettlement() {
    const schoolRows = rows.filter((row) => rowType(row) === 'school');
    const schoolHtml = schoolRows.length
      ? schoolRows.map(renderSettlementRow).join('')
      : '<tr><td colspan="9"><div class="iv-empty compact">本月没有学校分配的监考记录</div></td></tr>';
    const peopleHtml = summary.people.length
      ? summary.people.map(renderPersonGroup).join('')
      : '<div class="iv-empty"><b>暂无同事往来账</b><span>选择「我代别人」或「别人代我」录入监考后，会自动生成往来账。</span></div>';
    return '<div class="iv-settlement-summary">'
      + '<article><span>学校应发</span><b>¥' + money(summary.school.amount) + '</b><small>已到账 ¥' + money(summary.school.paid) + '</small></article>'
      + '<article><span>学校待到账</span><b class="iv-due">¥' + money(summary.school.unpaid) + '</b><small>' + summary.school.count + ' 场学校监考</small></article>'
      + '<article><span>同事应收待结</span><b class="green">¥' + money(summary.sub_out.open_amount) + '</b><small>累计已收 ¥' + money(summary.sub_out.paid_amount) + '</small></article>'
      + '<article><span>同事应付待结</span><b class="amber">¥' + money(summary.sub_in.open_amount) + '</b><small>累计已付 ¥' + money(summary.sub_in.paid_amount) + '</small></article>'
      + '</div>'
      + '<section class="iv-panel iv-school-statement"><div class="iv-panel-head"><div><b>学校监考结算单</b><span>按学校规则核算，月底统一对账</span></div><div class="iv-panel-actions"><button class="btn ghost sm" data-school-pay-all>全部记到账</button></div></div>'
      + '<div class="iv-statement-total"><div><span>本月总时长</span><b>' + money(summary.minutes) + ' 分钟</b></div><div><span>应发金额</span><b>¥' + money(summary.school.amount) + '</b></div><div><span>已到账</span><b class="green">¥' + money(summary.school.paid) + '</b></div><div><span>待到账</span><b class="iv-due">¥' + money(summary.school.unpaid) + '</b></div></div>'
      + '<div class="iv-table-wrap"><table class="iv-table"><thead><tr><th>日期</th><th>考试 / 科目</th><th>考场</th><th>时间</th><th>应发</th><th>已到账</th><th>待到账</th><th>状态</th><th>操作</th></tr></thead><tbody>' + schoolHtml + '</tbody></table></div>'
      + '</section>'
      + '<section class="iv-settlement-people"><div class="iv-section-heading"><div><b>同事往来结算</b><span>我代别人产生应收，别人代我产生应付；每一笔可分次收付。</span></div></div>'
      + peopleHtml + '</section>';
  }

  function renderSheet() {
    const filtered = rows.filter((row) => sheetFilter === 'all' || rowType(row) === sheetFilter)
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.start_time || '').localeCompare(String(b.start_time || '')));
    const body = filtered.length ? filtered.map((row, index) => {
      const { original, actual } = invigTeacherNames(row);
      return '<tr><td>' + (index + 1) + '</td><td>' + esc(dateLabel(row.date)) + '</td><td>' + esc(typeLabel(row)) + '</td><td>' + esc(row.exam_name || '') + '</td><td>' + esc(row.subject || '') + '</td><td>' + esc(row.room || row.place || '') + '</td><td>' + esc(timeLabel(row)) + '</td><td>' + money(row.duration_min || row.minutes || 0) + '</td><td>' + esc(original) + '</td><td>' + esc(actual) + '</td><td>¥' + money(row.pay_amount != null ? row.pay_amount : row.amount) + '</td><td></td></tr>';
    }).join('') : '<tr><td colspan="12"><div class="iv-empty compact">当前月份暂无监考记录</div></td></tr>';
    return '<div class="iv-sheet-toolbar"><div><b>' + monthLabel(month) + '监考表</b><span>自动汇总本月监考安排，可打印或导出。</span></div>'
      + '<div class="iv-sheet-actions"><select data-sheet-filter><option value="all">全部类型</option><option value="school"' + (sheetFilter === 'school' ? ' selected' : '') + '>学校分配</option><option value="替他人"' + (sheetFilter === '替他人' ? ' selected' : '') + '>我代别人</option><option value="他人替我"' + (sheetFilter === '他人替我' ? ' selected' : '') + '>别人代我</option></select>'
      + '<button class="btn ghost sm" data-sheet-export="csv">导出 CSV</button><button class="btn ghost sm" data-sheet-export="word">导出 Word</button><button class="btn primary sm" data-sheet-export="print">打印 / PDF</button></div></div>'
      + '<section class="iv-paper"><h2>' + monthLabel(month) + '监考安排表</h2><div class="iv-paper-meta"><span>共 ' + filtered.length + ' 场</span><span>学校分配 / 同事代监分类登记</span></div>'
      + '<div class="iv-table-wrap"><table class="iv-table iv-paper-table"><thead><tr><th>序号</th><th>日期</th><th>类型</th><th>考试名称</th><th>科目</th><th>考场</th><th>时间</th><th>时长（分）</th><th>原监考人</th><th>实际监考人</th><th>金额（元）</th><th>签字</th></tr></thead><tbody>' + body + '</tbody></table></div>'
      + '<div class="iv-sign-row"><span>填表人：________________</span><span>教务审核：________________</span><span>日期：________________</span></div></section>';
  }

  function bindContent() {
    box.querySelector('[data-filter-type]')?.addEventListener('change', (event) => { typeFilter = event.target.value; renderContentOnly(); });
    box.querySelector('[data-filter-status]')?.addEventListener('change', (event) => { statusFilter = event.target.value; renderContentOnly(); });
    box.querySelector('[data-filter-subject]')?.addEventListener('change', (event) => { subjectFilter = event.target.value; renderContentOnly(); });
    box.querySelector('[data-filter-keyword]')?.addEventListener('change', (event) => { keyword = event.target.value; renderContentOnly(); });
    box.querySelector('[data-filter-reset]')?.addEventListener('click', () => {
      typeFilter = 'all'; statusFilter = 'all'; subjectFilter = 'all'; keyword = '';
      renderContentOnly();
    });
    box.querySelector('[data-add-empty]')?.addEventListener('click', () => openEditor(null));
    box.querySelector('[data-school-pay-all]')?.addEventListener('click', payAllSchool);
    box.querySelector('[data-sheet-filter]')?.addEventListener('change', (event) => { sheetFilter = event.target.value; renderContentOnly(); });
    box.querySelectorAll('[data-sheet-export]').forEach((button) => {
      button.onclick = () => exportSheet(button.dataset.sheetExport);
    });
    box.querySelectorAll('[data-pay]').forEach((button) => {
      button.onclick = () => {
        const row = rowById(button.dataset.pay);
        if (row) openPayment(row);
      };
    });
    box.querySelectorAll('[data-history]').forEach((button) => {
      button.onclick = () => {
        const row = rowById(button.dataset.history);
        if (row) openHistory(row);
      };
    });
    box.querySelectorAll('[data-edit]').forEach((button) => {
      button.onclick = () => {
        const row = rowById(button.dataset.edit);
        if (row) openEditor(row);
      };
    });
    box.querySelectorAll('[data-delete]').forEach((button) => {
      button.onclick = async () => {
        const row = rowById(button.dataset.delete);
        if (!row) return;
        const state = settlementOf(row);
        const warning = state.paid > 0 ? '这场已有收付记录，删除后会影响历史对账。' : '';
        if (!(await confirmDialog('确定删除 ' + (row.exam_name || '这场监考') + '？' + (warning ? '\n' + warning : ''), { danger: true, okText: '删除' }))) return;
        try {
          const deletedId = String(row.id);
          await api.del('/invigilations/' + deletedId);
          const refreshed = await reload();
          if (!refreshed) return;
          if (rowById(deletedId)) {
            toast('删除请求已提交，但刷新后记录仍存在，请稍后重试', 'err');
            return;
          }
          toast('监考记录已删除');
        } catch (error) { toast(error.message || '删除失败', 'err'); }
      };
    });
    box.querySelectorAll('[data-pay-all]').forEach((button) => {
      button.onclick = () => {
        const person = summary.people[Number(button.dataset.payAll)];
        if (person) payAllRows(person.open_items.map((item) => item.row), person.direction === 'out' ? '月度批量收款' : '月度批量付款');
      };
    });
  }

  function renderContentOnly() {
    const content = box.querySelector('[data-iv-content]');
    if (!content) return;
    if (activeTab === 'records') content.innerHTML = renderRecords();
    else if (activeTab === 'settlement') content.innerHTML = renderSettlement();
    else content.innerHTML = renderSheet();
    bindContent();
  }

  async function openPayment(row) {
    const state = settlementOf(row);
    if (state.remaining <= 0) return openHistory(row);
    const title = paymentDirection(row);
    const now = new Date();
    const body = el('<div class="sheet-body iv-sheet-body">'
      + '<div class="iv-pay-summary"><div><span>本场应结</span><b>¥' + money(state.total) + '</b></div><div><span>已收付</span><b class="green">¥' + money(state.paid) + '</b></div><div><span>剩余未结</span><b class="iv-due">¥' + money(state.remaining) + '</b></div></div>'
      + '<div class="field"><label class="field-label">本次金额（元）</label><input class="input" id="iv-pay-amount" type="number" min="0.01" max="' + state.remaining + '" step="0.01" value="' + state.remaining + '"></div>'
      + '<div class="form-grid"><div class="field"><label class="field-label">收付日期</label><input class="input" id="iv-pay-date" type="date" value="' + ymd(now) + '"></div><div class="field"><label class="field-label">收付时间</label><input class="input" id="iv-pay-time" type="time" value="' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + '"></div></div>'
      + '<div class="field"><label class="field-label">收付方式</label><select class="input" id="iv-pay-method"><option value="转账">转账</option><option value="微信">微信</option><option value="支付宝">支付宝</option><option value="现金">现金</option><option value="其他">其他</option></select></div>'
      + '<div class="field"><label class="field-label">备注</label><textarea class="input" id="iv-pay-note" rows="2" placeholder="例如：先收一半，剩余下周结"></textarea></div>'
      + '<div class="iv-form-hint">可以只填写本次实际收付金额，剩余金额会自动保留，不会提前标记结清。</div>'
      + '<div class="confirm-actions"><button class="btn ghost" id="iv-pay-cancel">取消</button><button class="btn primary" id="iv-pay-save">保存这笔收付</button></div>'
      + '</div>');
    const modal = sheet({ title: title + ' · ' + (row.peer_name || row.exam_name || '监考记录'), body, wide: true });
    body.querySelector('#iv-pay-cancel').onclick = modal.close;
    body.querySelector('#iv-pay-save').onclick = async () => {
      const amount = Number(body.querySelector('#iv-pay-amount').value);
      const date = body.querySelector('#iv-pay-date').value;
      const time = body.querySelector('#iv-pay-time').value || '12:00';
      if (!date) return toast('请选择收付日期', 'warn');
      const paidAt = new Date(date + 'T' + time + ':00').toISOString();
      const payment = {
        id: paymentId(),
        amount,
        paid_at: paidAt,
        method: body.querySelector('#iv-pay-method').value,
        note: body.querySelector('#iv-pay-note').value.trim(),
      };
      try {
        const patch = addPaymentPatch(row, payment);
        await api.patch('/invigilations/' + row.id, patch);
        modal.close();
        toast('已记录' + (rowType(row) === 'school' ? '学校到账' : rowType(row) === '替他人' ? '收款' : '付款') + ' ¥' + money(amount));
        reload();
      } catch (error) { toast(error.message || '保存收付记录失败', 'err'); }
    };
  }

  async function openHistory(row) {
    const state = settlementOf(row);
    const meta = parseSettlementMeta(row.pay_note);
    const items = meta.payments.length
      ? meta.payments.map((payment) => '<div class="iv-payment-history-row"><div><b>¥' + money(payment.amount) + '</b><small>' + esc(payment.paid_at ? payment.paid_at.replace('T', ' ').slice(0, 16) : '未记录日期') + ' · ' + esc(payment.method || '未填写方式') + '</small>' + (payment.note ? '<em>' + esc(payment.note) + '</em>' : '') + '</div><button class="iv-action danger" data-remove-payment="' + esc(payment.id) + '">删除</button></div>').join('')
      : state.legacy
        ? '<div class="iv-legacy-note">这是旧版一键结清记录，原系统没有保存逐笔收付日期和金额。</div>'
        : '<div class="iv-empty compact">暂时没有收付明细</div>';
    const body = el('<div class="sheet-body iv-sheet-body"><div class="iv-pay-summary"><div><span>应结总额</span><b>¥' + money(state.total) + '</b></div><div><span>已收付</span><b class="green">¥' + money(state.paid) + '</b></div><div><span>剩余未结</span><b class="iv-due">¥' + money(state.remaining) + '</b></div></div><div class="iv-history-list">' + items + '</div>'
      + (state.legacy ? '<div class="confirm-actions"><button class="btn ghost" id="iv-undo-legacy">撤销旧版结清标记</button></div>' : '')
      + '<div class="confirm-actions"><button class="btn ghost" id="iv-history-close">关闭</button>' + (state.remaining > 0 && state.status !== 'unpriced' ? '<button class="btn primary" id="iv-history-add">' + paymentActionLabel(row) + '</button>' : '') + '</div></div>');
    const modal = sheet({ title: '收付明细 · ' + (row.peer_name || row.exam_name || '监考记录'), body, wide: true });
    body.querySelector('#iv-history-close').onclick = modal.close;
    body.querySelector('#iv-history-add')?.addEventListener('click', () => { modal.close(); openPayment(row); });
    body.querySelector('#iv-undo-legacy')?.addEventListener('click', async () => {
      if (!(await confirmDialog('撤销旧版结清标记后，这笔记录会重新计入待结金额。确定继续吗？', { danger: true, okText: '撤销结清' }))) return;
      try {
        await api.patch('/invigilations/' + row.id, undoLegacySettlementPatch());
        modal.close();
        toast('已撤销旧版结清标记');
        reload();
      } catch (error) { toast(error.message || '撤销失败', 'err'); }
    });
    body.querySelectorAll('[data-remove-payment]').forEach((button) => {
      button.onclick = async () => {
        if (!(await confirmDialog('确定删除这笔收付明细？删除后剩余金额会重新计算。', { danger: true, okText: '删除明细' }))) return;
        try {
          await api.patch('/invigilations/' + row.id, removePaymentPatch(row, button.dataset.removePayment));
          modal.close();
          toast('已删除收付明细');
          reload();
        } catch (error) { toast(error.message || '删除失败', 'err'); }
      };
    });
  }

  function openEditor(row) {
    const isNew = !row;
    const initialType = rowType(row || { duty_type: 'school' });
    const paidState = row ? settlementOf(row) : { paid: 0, total: 0, remaining: 0, structured: false, legacy: false };
    const body = el('<div class="sheet-body iv-sheet-body">'
      + '<div class="iv-form-section"><div class="iv-form-section-title">01 · 监考关系</div><div class="iv-type-options">'
      + '<button type="button" class="iv-type-option" data-kind="school">学校分配<small>学校统一安排，月底结算</small></button>'
      + '<button type="button" class="iv-type-option" data-kind="替他人">我代别人<small>我替同事监考，形成应收</small></button>'
      + '<button type="button" class="iv-type-option" data-kind="他人替我">别人代我<small>同事替我监考，形成应付</small></button>'
      + '</div><div class="iv-form-hint" id="iv-kind-hint"></div></div>'
      + '<div class="iv-form-section"><div class="iv-form-section-title">02 · 考试信息</div><div class="form-grid">'
      + '<div class="field"><label class="field-label">监考日期 <i>*</i></label><input class="input" id="iv-date" type="date" value="' + esc(row && row.date || ymd()) + '"></div>'
      + '<div class="field"><label class="field-label">考试名称</label><input class="input" id="iv-exam" value="' + esc(row && row.exam_name || '') + '" placeholder="例如：期中考试"></div>'
      + '<div class="field"><label class="field-label">科目</label><input class="input" id="iv-subject" value="' + esc(row && row.subject || '') + '" placeholder="例如：语文"></div>'
      + '<div class="field"><label class="field-label">年级 / 考试批次</label><input class="input" id="iv-grade" value="' + esc(row && row.grade || '') + '" placeholder="例如：高一"></div>'
      + '<div class="field"><label class="field-label">考场</label><input class="input" id="iv-room" value="' + esc(row && (row.room || row.place) || '') + '" placeholder="例如：教学楼 301"></div>'
      + '<div class="field"><label class="field-label">座位数（选填）</label><input class="input" id="iv-seats" type="number" min="0" value="' + esc(row && row.seat_count || '') + '"></div>'
      + '</div></div>'
      + '<div class="iv-form-section"><div class="iv-form-section-title">03 · 时间与金额</div><div class="form-grid">'
      + '<div class="field"><label class="field-label">开始时间</label><input class="input" id="iv-start" type="time" value="' + esc(row && row.start_time || '') + '"></div>'
      + '<div class="field"><label class="field-label">结束时间</label><input class="input" id="iv-end" type="time" value="' + esc(row && row.end_time || '') + '"></div>'
      + '<div class="field"><label class="field-label" for="iv-minutes">监考时长（分钟）</label><input class="input" id="iv-minutes" type="number" min="0" step="1" value="' + esc(row && (row.duration_min || row.minutes) || '') + '"></div>'
      + '<div class="field" id="iv-hourly-wrap"><label class="field-label" for="iv-hourly">学校发放标准（元/小时）</label><input class="input" id="iv-hourly" type="number" min="0" step="0.01" value="' + esc(row?.pay_rule === '小时' && row.unit_price != null ? row.unit_price : rules.schoolHourlyRate) + '"></div>'
      + '<div class="field"><label class="field-label" for="iv-amount" id="iv-amount-label">本场应结金额（元）</label><input class="input" id="iv-amount" type="number" min="0" step="0.01" value="' + esc(row && (row.pay_amount != null ? row.pay_amount : row.amount) != null ? (row.pay_amount != null ? row.pay_amount : row.amount) : '') + '"></div>'
      + '</div><div class="iv-form-hint" id="iv-price-hint"></div></div>'
      + '<div class="iv-form-section"><div class="iv-form-section-title">04 · 监考人员</div>'
      + '<div class="form-grid" id="iv-peer-wrap">'
      + '<div class="field"><label class="field-label" for="iv-original">原监考人</label><input class="input" id="iv-original" list="iv-peer-list" placeholder="填写原监考人姓名"></div>'
      + '<div class="field"><label class="field-label" for="iv-substitute">代监考人</label><input class="input" id="iv-substitute" list="iv-peer-list" placeholder="填写代监考人姓名"></div>'
      + '<datalist id="iv-peer-list"></datalist></div></div>'
      + '<div class="iv-form-section"><div class="iv-form-section-title">05 · 备注</div><div class="field"><textarea class="input" id="iv-remark" rows="3" placeholder="记录考场要求、试卷领取地点等">' + esc(row && row.remark || '') + '</textarea></div></div>'
      + (row ? '<div class="iv-edit-settlement">当前收付：已收 / 已付 ¥' + money(paidState.paid) + '，剩余 ¥' + money(paidState.remaining) + '。<button type="button" class="iv-action" id="iv-edit-history">查看收付明细</button></div>' : '')
      + '<div class="confirm-actions"><button class="btn ghost" id="iv-edit-cancel">取消</button><button class="btn primary" id="iv-edit-save">保存监考记录</button></div>'
      + '</div>');
    const modal = sheet({ title: isNew ? '新增监考记录' : '编辑监考记录', body, wide: true });
    const q = (id) => body.querySelector('#' + id);
    let dutyType = initialType;
    let schoolPriceChanged = isNew;
    const oldPayNote = row && row.pay_note || '';
    const oldMeta = parseSettlementMeta(oldPayNote);
    const selfName = String(state.user?.nickname || '').trim();
    const teachers = row && initialType !== 'school' ? invigTeacherNames(row) : { original: '', actual: '本人' };
    const inputName = value => value === '本人' ? selfName : value;
    let namedType = initialType === 'school' ? '替他人' : initialType;
    q('iv-original').value = inputName(teachers.original);
    q('iv-substitute').value = inputName(teachers.actual);
    const peerList = [...new Set(rows.flatMap(item => [item.peer_name, item.orig_teacher, item.person]).filter(name => name && name !== '本人'))];
    q('iv-peer-list').innerHTML = peerList.map((name) => '<option value="' + esc(name) + '">').join('');

    const syncKind = () => {
      const school = dutyType === 'school';
      q('iv-peer-wrap').classList.toggle('hidden', school);
      q('iv-hourly-wrap').classList.toggle('hidden', !school);
      q('iv-amount-label').textContent = school ? '学校应付金额（元）' : '本场应结金额（元）';
      q('iv-amount').readOnly = !school;
      q('iv-kind-hint').textContent = school
        ? '学校统一安排，学校款单独核算，不计入同事往来净额。'
        : dutyType === '替他人'
          ? '你替同事完成监考，对方应向你付款，系统记入「我应收」。'
          : '同事替你完成监考，你需要向对方付款，系统记入「我应付」。';
      body.querySelectorAll('[data-kind]').forEach((button) => button.classList.toggle('on', button.dataset.kind === dutyType));
      q('iv-price-hint').textContent = school
        ? '可直接填写分钟数，或填写起止时间自动计算。默认标准可在「计价设置」修改。'
        : '同事代监按 1 元/分钟计算。';
    };
    const syncDuration = () => {
      const duration = calcDurationMinutes(q('iv-start').value, q('iv-end').value);
      q('iv-minutes').readOnly = duration != null;
      if (duration != null) q('iv-minutes').value = duration;
    };
    const recalc = () => {
      const duration = Number(q('iv-minutes').value);
      if (dutyType === 'school') {
        schoolPriceChanged = true;
        const rate = q('iv-hourly');
        q('iv-amount').value = q('iv-minutes').value && rate.value && rate.validity.valid
          ? calcInvigAmount('school', duration, { mode: '小时', schoolHourlyRate: rate.value }).toFixed(2) : '';
      } else {
        q('iv-amount').value = calcInvigAmount(dutyType, duration, rules);
      }
    };
    body.querySelectorAll('[data-kind]').forEach((button) => {
      button.onclick = () => {
        if (dutyType === button.dataset.kind) return;
        dutyType = button.dataset.kind;
        if (dutyType !== 'school' && dutyType !== namedType) {
          const original = q('iv-original');
          const substitute = q('iv-substitute');
          [original.value, substitute.value] = [substitute.value, original.value];
          namedType = dutyType;
        }
        syncKind();
        recalc();
      };
    });
    q('iv-start').oninput = q('iv-end').oninput = () => { syncDuration(); recalc(); };
    q('iv-minutes').oninput = q('iv-hourly').oninput = recalc;
    syncDuration();
    syncKind();
    if (dutyType !== 'school' && !paidState.paid && !paidState.legacy && Number(q('iv-minutes').value) > 0) recalc();

    q('iv-edit-cancel').onclick = modal.close;
    q('iv-edit-history')?.addEventListener('click', () => { modal.close(); openHistory(row); });
    q('iv-edit-save').onclick = async () => {
      const date = q('iv-date').value;
      const start = q('iv-start').value;
      const end = q('iv-end').value;
      const originalTeacher = dutyType === 'school' ? row?.orig_teacher || '' : q('iv-original').value.trim();
      const actualTeacher = dutyType === 'school' ? '本人' : q('iv-substitute').value.trim();
      const peer = dutyType === '替他人' ? originalTeacher : actualTeacher;
      const exam = q('iv-exam').value.trim();
      const room = q('iv-room').value.trim();
      if (!date) return toast('请选择监考日期', 'warn');
      if (dutyType !== 'school' && (!originalTeacher || !actualTeacher)) return toast('请分别填写原监考人和代监考人的姓名', 'warn');
      if (!!start !== !!end) return toast('开始时间和结束时间需要同时填写', 'warn');
      const durationInput = q('iv-minutes');
      const rateInput = q('iv-hourly');
      if (!durationInput.validity.valid) return toast('监考时长请输入非负整数分钟', 'warn');
      if (dutyType === 'school' && schoolPriceChanged && (!rateInput.value || !rateInput.validity.valid)) {
        return toast('请输入有效的学校发放标准', 'warn');
      }
      const duration = start && end ? calcDurationMinutes(start, end) : Number(durationInput.value) || 0;
      if (!exam && !room && !start && !duration) return toast('考试名称、考场、开始时间或监考时长至少填一项', 'warn');
      if (dutyType !== 'school' && duration <= 0 && (isNew || initialType !== dutyType)) return toast('请输入代监时长', 'warn');
      const amount = Number(q('iv-amount').value) || 0;
      // 注意：oldState 必须在 if (row) 外面声明——后面拼 payload 时（第 621 行附近）
      // 还要用它判断结构化收付，写在块内会变成 ReferenceError，编辑已有记录必挂。
      const oldState = row ? settlementOf(row) : null;
      if (row) {
        if (oldState.legacy && Math.abs(amount - oldState.total) > 0.009) {
          return toast('这条旧版记录已结清。请先在「收付明细」撤销旧版结清标记，再修改金额。', 'warn');
        }
        if (oldState.structured && amount + 0.009 < oldState.paid) {
          return toast('本场金额不能低于已经实际收付的金额，请先调整收付明细。', 'warn');
        }
      }
      const keepLegacyPrice = dutyType !== 'school' && initialType === dutyType && row
        && row.pay_rule !== '代监按分钟' && amount === paidState.total
        && (paidState.paid > 0 || paidState.legacy || duration <= 0);
      const payload = {
        date,
        duty_type: dutyType,
        type: TYPE_LABEL[dutyType],
        exam_name: exam,
        subject: q('iv-subject').value.trim(),
        grade: q('iv-grade').value.trim(),
        room,
        place: room,
        seat_count: Number(q('iv-seats').value) || 0,
        start_time: start,
        end_time: end,
        start_at: date && start ? date + 'T' + start : '',
        end_at: date && end ? date + 'T' + end : '',
        duration_min: duration,
        minutes: duration,
        pay_hours: Math.round(duration / 60 * 100) / 100,
        pay_amount: amount,
        amount,
        pay_rule: dutyType === 'school' ? (schoolPriceChanged ? '小时' : row?.pay_rule)
          : keepLegacyPrice ? row.pay_rule : '代监按分钟',
        unit_price: dutyType === 'school'
          ? (schoolPriceChanged ? Number(rateInput.value) : row?.unit_price)
          : keepLegacyPrice ? row.unit_price : 1,
        peer_name: dutyType === 'school' ? '' : peer,
        person: actualTeacher,
        orig_teacher: originalTeacher,
        remark: q('iv-remark').value.trim(),
        pay_note: oldPayNote,
        school_paid: row ? Number(row.school_paid || 0) : 0,
        paid: row ? Number(row.paid || 0) : 0,
        settled_at: row ? row.settled_at || null : null,
        settle_key: row ? row.settle_key || '' : '',
        status: row && row.status ? row.status : 'done',
      };
      if (row && oldState.structured) {
        const newState = settlementOf({ ...row, pay_amount: amount, amount });
        if (rowType(row) === 'school') {
          payload.school_paid = newState.remaining <= 0.009 ? 1 : 0;
          payload.paid = payload.school_paid;
        } else if (newState.remaining > 0.009) {
          payload.settled_at = null;
          payload.settle_key = '';
        }
      }
      try {
        if (isNew) await api.post('/invigilations', payload);
        else await api.patch('/invigilations/' + row.id, payload);
        modal.close();
        toast('监考记录已保存');
        reload();
      } catch (error) { toast(error.message || '保存失败', 'err'); }
    };
  }

  async function openRules() {
    const current = { ...DEFAULT_RULES, ...(rules || {}) };
    const body = el('<div class="sheet-body iv-sheet-body">'
      + '<div class="field"><label class="field-label" for="iv-rule-hourly">学校默认发放标准（元/小时）</label><input class="input" id="iv-rule-hourly" type="number" min="0" step="0.01" value="' + esc(current.schoolHourlyRate) + '"></div>'
      + '<div class="iv-form-hint">同事代监按 1 元/分钟计算。</div>'
      + '<div class="iv-form-hint">默认标准用于之后新增的监考记录。</div>'
      + '<div class="confirm-actions"><button class="btn ghost" id="iv-rule-cancel">取消</button><button class="btn primary" id="iv-rule-save">保存计价规则</button></div></div>');
    const modal = sheet({ title: '监考计价设置', body, wide: true });
    const hourly = body.querySelector('#iv-rule-hourly');
    body.querySelector('#iv-rule-cancel').onclick = modal.close;
    const saveButton = body.querySelector('#iv-rule-save');
    saveButton.onclick = async () => {
      if (!hourly.value || !hourly.validity.valid) return toast('请输入有效的计价标准', 'warn');
      saveButton.disabled = true;
      try {
        await api.patch('/invig/rules', { schoolHourlyRate: Number(hourly.value) });
        modal.close();
        toast('计价规则已保存');
        reload();
      } catch (error) { toast(error.message || '保存计价规则失败', 'err'); }
      finally { saveButton.disabled = false; }
    };
  }

  async function payAllRows(targetRows, note) {
    const openRows = targetRows.filter((row) => settlementOf(row).remaining > 0);
    if (!openRows.length) return toast('没有待结算金额', 'warn');
    if (!(await confirmDialog('将为 ' + openRows.length + ' 场记录分别补记剩余金额，确定继续吗？', { okText: '确认结算' }))) return;
    let completed = 0;
    for (const row of openRows) {
      const state = settlementOf(row);
      try {
        const patch = addPaymentPatch(row, {
          id: paymentId(),
          amount: state.remaining,
          paid_at: new Date().toISOString(),
          method: '月度结算',
          note,
        });
        await api.patch('/invigilations/' + row.id, patch);
        completed += 1;
      } catch (error) {
        toast('已完成 ' + completed + ' 场，后续记录失败：' + (error.message || '未知错误'), 'err', 6000);
        reload();
        return;
      }
    }
    toast('已结算 ' + completed + ' 场');
    reload();
  }

  async function payAllSchool() {
    const schoolRows = rows.filter((row) => rowType(row) === 'school' && settlementOf(row).remaining > 0);
    await payAllRows(schoolRows, '学校月度结算');
  }

  function exportRecords() {
    const headers = ['日期', '监考类型', '考试名称', '科目', '年级', '考场', '开始时间', '结束时间', '时长（分钟）', '对方老师', '原监考人', '代监考人', '应结金额', '已收付', '剩余未结', '结算状态', '备注'];
    const data = rows.map((row) => {
      const state = settlementOf(row);
      return [
        row.date, typeLabel(row), row.exam_name, row.subject, row.grade, row.room || row.place,
        row.start_time, row.end_time, row.duration_min || row.minutes, peerLabel(row), invigTeacherNames(row).original, invigTeacherNames(row).actual,
        state.total, state.paid, state.remaining, statusLabel(row, state), row.remark,
      ];
    });
    downloadBlob(csvText(headers, data), 'text/csv;charset=utf-8', '监考记录-' + month + '.csv');
  }

  function exportSheet(format) {
    const selected = rows.filter((row) => sheetFilter === 'all' || rowType(row) === sheetFilter)
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.start_time || '').localeCompare(String(b.start_time || '')));
    if (format === 'csv') {
      const headers = ['序号', '日期', '类型', '考试名称', '科目', '考场', '时间', '时长（分钟）', '原监考人', '实际监考人', '金额（元）', '签字'];
      const data = selected.map((row, index) => {
        const { original, actual } = invigTeacherNames(row);
        return [
          index + 1, row.date, typeLabel(row), row.exam_name, row.subject, row.room || row.place,
          timeLabel(row), row.duration_min || row.minutes || 0,
          original, actual,
          row.pay_amount != null ? row.pay_amount : row.amount, '',
        ];
      });
      downloadBlob(csvText(headers, data), 'text/csv;charset=utf-8', '监考表-' + month + '.csv');
      return;
    }
    const documentHtml = sheetDocument(month, selected);
    if (format === 'word') {
      downloadBlob('\ufeff' + documentHtml, 'application/msword;charset=utf-8', '监考表-' + month + '.doc');
      return;
    }
    const win = window.open('', '_blank');
    if (!win) return toast('浏览器拦截了打印窗口，请允许弹出窗口后重试', 'err');
    win.document.open();
    win.document.write(documentHtml);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }

  await reload();
}
