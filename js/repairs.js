/* ================= 维修（第 23 条） =================
   报修这件事以前全靠群里喊一句，事后没人记得「修没修、谁修的、花了多少钱」。
   这一页只干三件事：记下坏了什么、看清楚哪些还没修、修完留个底。
   状态只有四种，够用且不会让用户选半天：
     pending 待修复 → doing 修复中 → done 已修复（canceled 已取消） */
import {
  api, esc, toast, sheet, confirmDialog, ymd,
} from './core.js';
import { registerView, icon, pageHead } from './ui.js';
import { summarizeRepairs, isRepairTracked, isRepairFixed, repairStatusView } from './repairs-domain.mjs';

/* 维修状态使用自由文本输入，保留旧状态兼容。 */
const URG = {
  low: { label: '不急', chip: 'grey' },
  normal: { label: '一般', chip: 'blue' },
  high: { label: '急', chip: 'red' },
};

/* 存量记录的状态文案统一走 repairStatusView（待修复 / 修复中 / 已修复，自由文本原样）；
   列表徽标和编辑弹窗都用这一份，避免「里面写修复中、外面显示未修好」。 */
function repairStatusDisplay(row) {
  return repairStatusView(row?.status).label;
}

/* 老链接 #/repairs 兜底（render() 里会先 translate 成 work/repairs） */
registerView(async function repairs(main) {
  main.innerHTML = pageHead('维修记录表', '按月份查看维修记录、处理状态与待跟踪事项');
  const box = document.createElement('div');
  main.appendChild(box);
  return renderRepairsBody(box);
});

/* 二级导航「工作 → 维修」直接调这里，正文挂到传入的容器上 */
export async function renderRepairsBody(box) {
  let rows = [];
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let activeMonth = currentMonth;

  const load = async () => {
    box.innerHTML = '<div class="empty">正在加载维修记录…</div>';
    try {
      rows = await api.get('/repairs', { month: activeMonth });
      if (!Array.isArray(rows)) rows = [];
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message || '维修记录加载失败')}
        <div style="margin-top:10px"><button class="btn ghost sm" id="rp-retry">重新加载</button></div></div>`;
      box.querySelector('#rp-retry')?.addEventListener('click', load);
      return;
    }
    paint();
  };

  const paint = () => {
    const stats = summarizeRepairs(rows, activeMonth);
    const tableRows = stats.rows.length ? stats.rows.map((r, index) => {
      const tracked = isRepairTracked(r);
      const status = repairStatusView(r.status);
      return `<tr>
        <td class="rp-ledger-no">${esc(r.seq || index + 1)}</td>
        <td>${esc(r.date || '—')}</td>
        <td class="rp-ledger-item">${esc(r.item || '—')}</td>
        <td>${esc(r.place || '—')}</td>
        <td class="rp-ledger-record">${esc(r.fault || '—')}</td>
        <td>${esc(r.reporter || '—')}</td>
        <td><span class="rp-ledger-state is-${status.key}">${esc(status.label)}</span></td>
        <td><span class="rp-ledger-track ${tracked ? 'is-tracked' : ''}">${tracked ? '是' : '否'}</span></td>
        <td class="rp-ledger-remark">${esc(r.remark || '')}</td>
        <td><div class="rp-ledger-actions">
          <button type="button" class="rp-ledger-edit" data-rp-edit="${esc(r.id)}">编辑</button>
          <button type="button" class="rp-ledger-delete" data-rp-del="${esc(r.id)}">删除</button>
        </div></td>
      </tr>`;
    }).join('') : '<tr><td colspan="10" class="rp-ledger-empty">这个月份暂无维修记录</td></tr>';

    const reminderHTML = stats.reminders.length
      ? stats.reminders.map((item) => `<span class="rp-ledger-reminder-item"><b>${esc(item.item)}</b>：${esc(item.remark)}</span>`).join('')
      : '<span class="rp-ledger-reminder-empty">当前月份暂无待跟踪事项</span>';

    box.innerHTML = `
      <section class="rp-ledger">
        <div class="rp-ledger-toolbar">
          <div class="rp-ledger-month">
            <label for="rp-ledger-month">选择统计月份：</label>
            <input id="rp-ledger-month" type="month" value="${esc(activeMonth)}">
            <button type="button" class="btn ghost sm" id="rp-ledger-view">查看该月数据</button>
          </div>
          <button type="button" class="btn primary sm rp-ledger-add" id="rp-ledger-add">${icon('plus', 15)} 新增维修记录</button>
        </div>
        <div class="rp-ledger-stats">
          <article class="rp-ledger-stat rp-ledger-stat-blue">
            <div class="rp-ledger-stat-label">本月总维修</div><div class="rp-ledger-stat-num">${stats.total}</div><div class="rp-ledger-stat-unit">条</div>
          </article>
          <article class="rp-ledger-stat rp-ledger-stat-green">
            <div class="rp-ledger-stat-label">已修复</div><div class="rp-ledger-stat-num">${stats.fixed}</div><div class="rp-ledger-stat-unit">条</div>
          </article>
          <article class="rp-ledger-stat rp-ledger-stat-orange">
            <div class="rp-ledger-stat-label">未修复</div><div class="rp-ledger-stat-num">${stats.unfinished}</div><div class="rp-ledger-stat-unit">条</div>
          </article>
          <article class="rp-ledger-stat rp-ledger-stat-red">
            <div class="rp-ledger-stat-label">需要跟踪</div><div class="rp-ledger-stat-num">${stats.tracked}</div><div class="rp-ledger-stat-unit">条</div>
          </article>
        </div>
        <div class="rp-ledger-reminders">
          <div class="rp-ledger-reminders-title">${icon('pin', 15)} 待跟踪提醒</div>
          <div class="rp-ledger-reminders-list">${reminderHTML}</div>
        </div>
        <div class="rp-ledger-table-wrap">
          <table class="rp-ledger-table">
            <thead><tr>
              <th>序号</th><th>维修日期</th><th>设备名称</th><th>位置</th><th>维修记录</th>
              <th>报修人</th><th>修复状态</th><th>是否跟踪</th><th>备注</th><th>操作</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        <div class="rp-ledger-foot">共 ${stats.total} 条维修记录 · 统计月份：${esc(activeMonth)}</div>
      </section>`;

    box.querySelector('#rp-ledger-view').onclick = () => {
      const nextMonth = box.querySelector('#rp-ledger-month')?.value || '';
      if (!/^\d{4}-\d{2}$/.test(nextMonth)) return toast('请选择有效的统计月份', 'warn');
      activeMonth = nextMonth;
      load();
    };
    box.querySelector('#rp-ledger-month').onkeydown = (event) => {
      if (event.key === 'Enter') box.querySelector('#rp-ledger-view').click();
    };
    box.querySelector('#rp-ledger-add').onclick = () => editor(null);
    box.querySelectorAll('[data-rp-edit]').forEach((button) => {
      button.onclick = () => editor(rows.find((row) => String(row.id) === button.dataset.rpEdit));
    });
    box.querySelectorAll('[data-rp-del]').forEach((button) => {
      button.onclick = async () => {
        const row = rows.find((item) => String(item.id) === button.dataset.rpDel);
        if (!row) return;
        if (!await confirmDialog(`删除「${row.item || row.fault || '维修记录'}」这条维修记录？删除后可在全局回收站恢复。`)) return;
        button.disabled = true;
        try {
          await api.del('/repairs/' + row.id);
          toast('已删除，记录已移入回收站');
          await load();
        } catch (e) {
          button.disabled = false;
          toast(e.message || '删除失败', 'err');
        }
      };
    });
  };

  async function editor(row) {
    const isNew = !row;
    const today = ymd(new Date());
    const body = document.createElement('div');
    body.className = 'sheet-body';
    body.innerHTML = `
      <div class="rp-form-section">
        <div class="rp-form-section-title">报修信息</div>
        <div class="form-grid">
          <div class="field"><label class="field-label">报修日期</label>
            <input class="input" id="d" type="date" value="${esc(row?.date || today)}"></div>
          <div class="field"><label class="field-label">紧急程度</label>
            <select class="input" id="u">
              ${Object.entries(URG).map(([k, v]) => `<option value="${k}" ${(row?.urgency || 'normal') === k ? 'selected' : ''}>${v.label}</option>`).join('')}
            </select></div>
        </div>
        <div class="form-grid">
          <div class="field"><label class="field-label">位置</label>
            <input class="input" id="pl" value="${esc(row?.place || '')}" placeholder="如 高二(3)班教室"></div>
          <div class="field"><label class="field-label">设备名称</label>
            <input class="input" id="it" value="${esc(row?.item || '')}" placeholder="如 投影仪 / 门锁 / 灯管 / 网线"></div>
        </div>
      </div>
      <div class="rp-form-section">
        <div class="rp-form-section-title">故障与处理</div>
        <div class="field"><label class="field-label">故障描述</label>
          <textarea class="input" id="fl" rows="2" placeholder="如：开机后一直闪红灯，投不出画面">${esc(row?.fault || '')}</textarea></div>
        <div class="form-grid">
          <div class="field"><label class="field-label">报修人 <span class="tiny muted">（选填）</span></label>
            <input class="input" id="rp" value="${esc(row?.reporter || '')}" placeholder="谁发现的"></div>
          <div class="field"><label class="field-label">维修人 <span class="tiny muted">（选填）</span></label>
            <input class="input" id="hd" value="${esc(row?.handler || '')}" placeholder="如 后勤王师傅"></div>
        </div>
      </div>
      <div class="rp-form-section">
        <div class="rp-form-section-title">处理结果</div>
        <div class="form-grid">
          <div class="field"><label class="field-label" for="fx">修复状态</label>
            <div class="rp-combo" id="fx-combo">
              <input class="input" id="fx" value="${esc(repairStatusDisplay(row))}" placeholder="可手动输入，或点右侧选择" autocomplete="off">
              <button type="button" class="rp-combo-toggle" id="fx-toggle" aria-label="展开状态选项" aria-expanded="false">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 5.5L7 9.5L11 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <div class="rp-combo-menu" id="fx-menu" hidden>
                <button type="button" class="rp-combo-option" data-rp-status="待修复"><span class="rp-combo-dot is-pending"></span>待修复</button>
                <button type="button" class="rp-combo-option" data-rp-status="修复中"><span class="rp-combo-dot is-doing"></span>修复中</button>
                <button type="button" class="rp-combo-option" data-rp-status="已修复"><span class="rp-combo-dot is-done"></span>已修复</button>
              </div>
            </div>
            <div class="rp-combo-hint">可直接输入，或点右侧箭头选择</div>
          </div>
          <div class="field"><label class="field-label">是否跟踪</label>
            <label class="rp-follow-control"><input type="checkbox" id="fu" ${row?.follow_up === true || row?.follow_up === 1 || row?.follow_up === '1' ? 'checked' : ''}><span>需要持续跟踪处理</span></label></div>
        </div>
        <div class="field"><label class="field-label">备注</label>
          <input class="input" id="rm" value="${esc(row?.remark || '')}" placeholder="有什么要补充的？直接在这里写"></div>
      </div>
      <div class="confirm-actions rp-form-actions">
        ${row ? '<button class="btn ghost rp-btn-delete" id="del">删除</button>' : ''}
        <button class="btn ghost" id="cancel">取消</button>
        <button class="btn primary" id="ok">保存</button>
      </div>`;
    const s = sheet({ title: isNew ? '新增维修记录' : '维修记录修改', body, wide: true });
    const $ = (id) => body.querySelector('#' + id);

    /* 状态组合框：输入框可直接键入；点右侧箭头展开固定三项，选中后回填。 */
    const combo = $('fx-combo');
    const menu = $('fx-menu');
    const toggle = $('fx-toggle');
    const closeCombo = () => {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      combo.classList.remove('is-open');
    };
    toggle.onclick = (event) => {
      event.stopPropagation();
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      toggle.setAttribute('aria-expanded', String(willOpen));
      combo.classList.toggle('is-open', willOpen);
    };
    menu.querySelectorAll('[data-rp-status]').forEach((option) => {
      option.onclick = (event) => {
        event.stopPropagation();
        $('fx').value = option.dataset.rpStatus;
        closeCombo();
        $('fx').focus();
      };
    });
    body.addEventListener('click', (event) => {
      if (!combo.contains(event.target)) closeCombo();
    });
    $('fx').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeCombo();
    });
    $('cancel').onclick = s.close;
    $('del')?.addEventListener('click', async () => {
      if (await confirmDialog('删除这条报修记录？')) {
        try { await api.del('/repairs/' + row.id); s.close(); toast('已删除'); load(); }
        catch (e) { toast(e.message, 'err'); }
      }
    });
    $('ok').onclick = async () => {
      const payload = {
        date: $('d').value || today,
        place: $('pl').value.trim(),
        item: $('it').value.trim(),
        fault: $('fl').value.trim(),
        urgency: $('u').value,
        status: $('fx').value.trim() || '待修复',
        reporter: $('rp').value.trim(),
        handler: $('hd').value.trim(),
        /* 维修不产生费用：界面已去掉费用栏，这里只沿用存量值，不改历史记录。 */
        cost: Number(row?.cost) || 0,
        follow_up: $('fu').checked,
        remark: $('rm').value.trim(),
      };
      if (!payload.fault) return toast('请填写故障描述', 'warn');
      /* 修好日期只加不清：
         以前 status 一旦不是 done 就把 fixed_at 抹成空串，等于把「这台投影仪
         10 月 3 号修过」这件事直接删掉。改成「改成已修好时补今天，其余情况保留原值」，
         历史不会被一次误操作抹掉。 */
      if (isRepairFixed({ status: payload.status }) && !row?.fixed_at) payload.fixed_at = today;
      const btn = $('ok'); btn.disabled = true; btn.textContent = '保存中…';
      try {
        if (isNew) await api.post('/repairs', payload);
        else await api.patch('/repairs/' + row.id, payload);
        s.close(); toast('已保存'); load();
      } catch (e) {
        btn.disabled = false; btn.textContent = '保存';
        toast(e.message || '保存失败', 'err');
      }
    };
  }

  await load();
}
