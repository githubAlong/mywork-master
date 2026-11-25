/* ============================================================================
   attendance-departments.js —— 考勤 · 部门管理（v3 新增第 6 个二级导航）

   位置：一级「考勤」下、花名册上面。
   结构：部门 → 年级 两级。先新建部门（高中部），再在该部门下新建年级
        （高一年级 / 高二年级）。列表树形展示，部门行与年级行都能编辑、删除。
   数据：走 /departments，年级名单仍复用 /grades，花名册分表页签由这里驱动。
   ========================================================================== */
import { api, esc, toast, confirmDialog } from './core.js';
import { rosterTabLabel } from './attendance-hub-domain.mjs';

function overlay(title, body, { wide = false, sub = '', size = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ahub-mask';
  const dialogCls = `ahub-dialog${wide ? ' wide' : ''}${size ? ' ' + size : ''}`;
  wrap.innerHTML = `<div class="${dialogCls}" role="dialog" aria-modal="true">
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
  /* 标题栏 ×、表单里的「取消」都带 data-close，必须全部绑定。
     原写法只 querySelector 了第一个（标题栏 ×），所以表单里的「取消」点了没反应。 */
  wrap.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  return { wrap, close };
}

export async function renderAttendanceDepartments(root) {
  const S = { view: null, busy: false };

  root.innerHTML = `
    <div class="ahub ahub-dept">
      <header class="ahub-head">
        <div>
          <div class="ahub-crumb">考勤 <span>/</span> 部门管理</div>
          <div class="ahub-dept-titlerow">
            <h1>部门管理</h1>
            <span class="ahub-count" id="ad-count">—</span>
          </div>
          <p>先新建部门，再在该部门下新建年级；建好的年级会自动成为花名册的分表页签与四张考勤表的筛选条件</p>
        </div>
        <div class="ahub-head-right">
          <button class="ahub-btn" id="ad-grade-add">＋ 新建年级</button>
          <button class="ahub-btn primary" id="ad-dept-add">＋ 新建部门</button>
        </div>
      </header>

      <section class="ahub-card ahub-dept-steps">
        <span class="ahub-dept-steps-t">新建顺序</span>
        <span class="ahub-dept-step">① 新建部门，名称填 <b>「高中部」</b></span>
        <span class="ahub-dept-arrow">→</span>
        <span class="ahub-dept-step">② 新建年级时所属部门选 <b>「高中部」</b></span>
        <span class="ahub-dept-arrow">→</span>
        <span class="ahub-dept-step">③ 花名册自动多一个分表页签</span>
      </section>

      <section class="ahub-card">
        <div class="ahub-toolbar">
          <div class="ahub-toolbar-left">
            <b style="font-size:14px">部门与年级</b>
            <span class="ahub-tip">部门一行，其下年级缩进；每行都能编辑、删除</span>
          </div>
          <button class="ahub-btn" id="ad-refresh">刷新</button>
        </div>
        <div class="ahub-table-wrap">
          <table class="ahub-table ahub-dept-table">
            <thead><tr>
              <th>部门 / 年级</th>
              <th>教师数</th>
              <th>花名册页签</th>
              <th class="ahub-ops">操作</th>
            </tr></thead>
            <tbody id="ad-tbody"></tbody>
          </table>
        </div>
      </section>

      <div class="ahub-note-bar">
        <div><b>编辑：</b>可改部门名 / 年级名；改名后花名册与四张考勤表里已有记录的名称同步更新，不会出现对不上的旧名字。</div>
        <div><b>删除：</b>先二次确认并提示影响范围；只解除关联，教师与考勤记录全部保留。</div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);

  async function load({ silent = false } = {}) {
    if (S.busy) return;
    S.busy = true;
    try {
      S.view = await api.get('/departments');
      paint();
    } catch (e) {
      if (!silent) toast('加载失败：' + (e.message || e), 'warn', 4000);
      $('#ad-tbody').innerHTML = `<tr><td colspan="4" class="ahub-empty">加载失败，请刷新重试</td></tr>`;
    } finally { S.busy = false; }
  }

  function paint() {
    const v = S.view || { list: [], unassigned: [], grades: [] };
    const body = $('#ad-tbody');
    const rows = [];
    for (const d of v.list) {
      rows.push(`<tr class="ahub-dept-row" data-dept="${esc(d.id)}">
        <td><span class="ahub-dept-name"><b>▾ ${esc(d.name)}</b><span class="ahub-pill blue">部门</span></span></td>
        <td><b>${d.teacherCount || 0}</b></td>
        <td>总花名册</td>
        <td class="ahub-ops">
          <button class="ahub-link" data-act="dept-edit" data-id="${esc(d.id)}">编辑</button>
          <button class="ahub-link danger" data-act="dept-del" data-id="${esc(d.id)}">删除</button>
        </td></tr>`);
      for (const g of d.grades) {
        rows.push(`<tr class="ahub-dept-sub" data-grade="${esc(g.name)}" data-dept="${esc(d.id)}">
          <td><span class="ahub-dept-name" style="padding-left:26px">└ ${esc(g.name)}<span class="ahub-pill gray">年级</span></span></td>
          <td>${g.teacherCount || 0}</td>
          <td>${esc(rosterTabLabel(g.name))}</td>
          <td class="ahub-ops">
            <button class="ahub-link" data-act="grade-edit" data-name="${esc(g.name)}" data-id="${esc(d.id)}">编辑</button>
            <button class="ahub-link danger" data-act="grade-del" data-name="${esc(g.name)}">删除</button>
          </td></tr>`);
      }
    }
    for (const g of v.unassigned || []) {
      rows.push(`<tr class="ahub-dept-sub" data-grade="${esc(g.name)}">
        <td><span class="ahub-dept-name" style="padding-left:26px">└ ${esc(g.name)}<span class="ahub-pill gray">年级</span><span class="ahub-pill orange">未分配</span></span></td>
        <td>${g.teacherCount || 0}</td>
        <td>—</td>
        <td class="ahub-ops">
          <button class="ahub-link" data-act="grade-edit" data-name="${esc(g.name)}">编辑</button>
          <button class="ahub-link danger" data-act="grade-del" data-name="${esc(g.name)}">删除</button>
        </td></tr>`);
    }
    if (!v.list.length && !(v.unassigned || []).length) {
      rows.push(`<tr><td colspan="4" class="ahub-empty">还没有部门。点右上角「＋ 新建部门」先建一个「高中部」，再在里面新建年级。</td></tr>`);
    } else {
      rows.push(`<tr><td colspan="4" class="ahub-dept-foot">＋ 新增部门后，这里自动多一组；该部门下每建一个年级，花名册自动多一个分表页签</td></tr>`);
    }
    body.innerHTML = rows.join('');
    $('#ad-count').textContent = `共 ${v.list.length} 个部门 · ${(v.grades || []).length} 个年级`;

    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        if (act === 'dept-edit') return openDeptEdit(btn.dataset.id);
        if (act === 'dept-del') return removeDept(btn.dataset.id);
        if (act === 'grade-edit') return openGradeEdit(btn.dataset.name, btn.dataset.id || '');
        if (act === 'grade-del') return removeGrade(btn.dataset.name);
      };
    });
  }

  /* ---------------- 部门 ---------------- */
  function openDeptAdd() {
    const body = `<form id="ad-form" class="ahub-form one">
      <label class="ahub-field"><span>部门名称 <i>*</i></span>
        <input name="name" id="ad-name" placeholder="如：高中部" autocomplete="off"></label>
      <div class="ahub-field-hint">如：高中部、初中部；2-10 个字，重名会提示已存在</div>
      <div class="ahub-form-err" id="ad-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('新建部门', body, { sub: '建好后可在该部门下继续新建年级', size: 'sm' });
    const form = wrap.querySelector('#ad-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) { wrap.querySelector('#ad-err').textContent = '请填写部门名称'; return; }
      try {
        await api.post('/departments', { name });
        close(); toast(`已新建部门「${name}」`, 'ok'); await load({ silent: true });
      } catch (ex) { wrap.querySelector('#ad-err').textContent = ex.message || String(ex); }
    };
    setTimeout(() => wrap.querySelector('#ad-name')?.focus(), 30);
  }

  function openDeptEdit(id) {
    const d = (S.view?.list || []).find((x) => String(x.id) === String(id));
    if (!d) return;
    const body = `<form id="ad-form" class="ahub-form one">
      <label class="ahub-field"><span>部门名称 <i>*</i></span>
        <input name="name" id="ad-name" value="${esc(d.name)}" autocomplete="off"></label>
      <div class="ahub-field-hint">改名后，花名册与四张考勤表里的旧名称会同步更新</div>
      <div class="ahub-form-err" id="ad-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('编辑部门', body, { sub: '只改名称，不影响该部门下的年级与教师', size: 'sm' });
    const form = wrap.querySelector('#ad-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = String(new FormData(form).get('name') || '').trim();
      if (!name) { wrap.querySelector('#ad-err').textContent = '请填写部门名称'; return; }
      try {
        const r = await api.patch(`/departments/${encodeURIComponent(id)}`, { name });
        close(); toast(`已保存「${name}」，${r.renamedRows || 0} 条花名册记录同步更新`, 'ok', 3500);
        await load({ silent: true });
      } catch (ex) { wrap.querySelector('#ad-err').textContent = ex.message || String(ex); }
    };
  }

  async function removeDept(id) {
    const d = (S.view?.list || []).find((x) => String(x.id) === String(id));
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
    const depts = S.view?.list || [];
    if (!depts.length) { toast('请先新建一个部门，再在部门里新建年级', 'warn', 3500); return; }
    const opts = depts.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    const body = `<form id="ad-form" class="ahub-form">
      <label class="ahub-field"><span>所属部门 <i>*</i></span>
        <select name="departmentId" id="ad-dept">${opts}</select></label>
      <label class="ahub-field"><span>年级名称 <i>*</i></span>
        <input name="name" id="ad-name" placeholder="如：高一年级" autocomplete="off"></label>
      <div class="ahub-field-hint">如：高一年级、高二年级；建好后花名册会自动多一个对应的分表页签</div>
      <div class="ahub-form-err" id="ad-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('新建年级', body, { sub: '年级挂在部门下，并成为花名册的一个分表页签' });
    const form = wrap.querySelector('#ad-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      const departmentId = String(fd.get('departmentId') || '');
      if (!name) { wrap.querySelector('#ad-err').textContent = '请填写年级名称'; return; }
      try {
        await api.post(`/departments/${encodeURIComponent(departmentId)}/grades`, { name });
        close(); toast(`已新建年级「${name}」，花名册自动多一个分表页签`, 'ok', 3500);
        await load({ silent: true });
      } catch (ex) { wrap.querySelector('#ad-err').textContent = ex.message || String(ex); }
    };
    setTimeout(() => wrap.querySelector('#ad-name')?.focus(), 30);
  }

  function openGradeEdit(oldName, deptId) {
    const depts = S.view?.list || [];
    const opts = ['<option value="">暂不调整部门</option>']
      .concat(depts.map((d) => `<option value="${esc(d.id)}"${String(d.id) === String(deptId) ? ' selected' : ''}>${esc(d.name)}</option>`)).join('');
    const body = `<form id="ad-form" class="ahub-form">
      <label class="ahub-field"><span>年级名称 <i>*</i></span>
        <input name="name" id="ad-name" value="${esc(oldName)}" autocomplete="off"></label>
      <label class="ahub-field"><span>改所属部门</span>
        <select name="departmentId" id="ad-dept">${opts}</select></label>
      <div class="ahub-field-hint">改名或换部门后，花名册与四张考勤表里的记录会同步更新</div>
      <div class="ahub-form-err" id="ad-err"></div>
      <div class="ahub-form-actions">
        <button type="button" class="ahub-btn" data-close>取消</button>
        <button type="submit" class="ahub-btn primary">保存</button>
      </div></form>`;
    const { wrap, close } = overlay('编辑年级', body, { sub: '只改名称或所属部门，不影响已录入的教师与考勤记录' });
    const form = wrap.querySelector('#ad-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      const departmentId = String(fd.get('departmentId') || '');
      if (!name) { wrap.querySelector('#ad-err').textContent = '请填写年级名称'; return; }
      try {
        const r = await api.patch(`/departments/grades/${encodeURIComponent(oldName)}`, { name, departmentId });
        const n = (r.migrated?.hub || 0) + (r.migrated?.teachers || 0) + (r.migrated?.tables || 0);
        close(); toast(`已保存「${name}」${n ? `，${n} 条记录同步更新` : ''}`, 'ok', 3500);
        await load({ silent: true });
      } catch (ex) { wrap.querySelector('#ad-err').textContent = ex.message || String(ex); }
    };
  }

  async function removeGrade(name) {
    const ok = await confirmDialog(
      `确定删除年级「${name}」吗？只从部门列表移除，已录入的教师与考勤记录全部保留，可在「全部年级」下查看。`,
      { title: '删除年级', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api.del(`/departments/grades/${encodeURIComponent(name)}`);
      toast('已删除年级，相关记录全部保留', 'ok');
      await load({ silent: true });
    } catch (e) { toast('删除失败：' + (e.message || e), 'warn'); }
  }

  $('#ad-dept-add').onclick = openDeptAdd;
  $('#ad-grade-add').onclick = openGradeAdd;
  $('#ad-refresh').onclick = () => load({ silent: true });
  await load();
}
