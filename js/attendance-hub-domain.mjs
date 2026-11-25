/* ============================================================================
   attendance-hub-domain.mjs —— 考勤二级导航 5 张独立表的字段契约与纯函数

   设计原则：
   · 5 张表平级独立存储，各自一张本地表（att_hub_*），共用花名册的 teacher_id。
   · 年级 / 日期 / 学科只是查询筛选条件，不再是数据隔离边界。
   · 本文件不碰 DOM、不碰 localStorage，方便在 Node 里直接跑单测。
   ========================================================================== */

const SELECT = (list) => ({ type: 'select', options: list });

export const HUB_SHEETS = {
  roster: {
    key: 'roster', label: '花名册', table: 'att_hub_roster',
    title: '花名册 · 全部教师',
    desc: '教师主数据，全年级统一编号；其余 4 张表通过教师 ID 关联',
    columns: [
      { key: 'teacher_id', label: '教师ID', type: 'text', width: 100 },
      { key: 'name', label: '姓名', type: 'text', required: true, width: 110 },
      { key: 'subject', label: '学科', type: 'text', width: 100 },
      { key: 'department', label: '所属部门', type: 'text', width: 120 },
      { key: 'grade', label: '年级', ...SELECT(['高一', '高二', '高三']), width: 90 },
      { key: 'class_name', label: '任教班级', type: 'text', width: 110 },
      { key: 'status', label: '在职状态', ...SELECT(['在职', '休假', '离职']), width: 100 },
      { key: 'hire_date', label: '入职日期', type: 'date', width: 120 },
      { key: 'phone', label: '联系方式', type: 'text', width: 130 },
      { key: 'remark', label: '备注', type: 'text', width: 160 },
    ],
    defaults: { status: '在职', grade: '高一' },
    filters: ['grade', 'subject', 'q'],
  },
  duty: {
    key: 'duty', label: '坐班表', table: 'att_hub_duty',
    title: '坐班表 · 全部记录',
    desc: '坐班记录独立存储，随时可进可录，不再要求先确认上课表',
    columns: [
      { key: 'date', label: '日期', type: 'date', required: true, width: 120 },
      { key: 'teacher_id', label: '教师ID', type: 'text', width: 100 },
      { key: 'name', label: '姓名', type: 'text', required: true, width: 110 },
      { key: 'grade', label: '年级', ...SELECT(['高一', '高二', '高三']), width: 90 },
      { key: 'period', label: '节次', type: 'text', width: 90 },
      { key: 'start_time', label: '开始时间', type: 'time', width: 110 },
      { key: 'end_time', label: '结束时间', type: 'time', width: 110 },
      { key: 'status', label: '坐班状态', ...SELECT(['在岗', '迟到', '缺勤', '请假']), width: 100 },
      { key: 'place', label: '地点', type: 'text', width: 110 },
      { key: 'remark', label: '备注', type: 'text', width: 160 },
    ],
    defaults: { status: '在岗' },
    filters: ['grade', 'from', 'to', 'q'],
  },
  class: {
    key: 'class', label: '上课表', table: 'att_hub_class',
    title: '上课表 · 全部记录',
    desc: '原「课程表」并入此处，上课记录不再挂在坐班表里',
    columns: [
      { key: 'date', label: '日期', type: 'date', required: true, width: 120 },
      { key: 'teacher_id', label: '教师ID', type: 'text', width: 100 },
      { key: 'name', label: '姓名', type: 'text', required: true, width: 110 },
      { key: 'grade', label: '年级', ...SELECT(['高一', '高二', '高三']), width: 90 },
      { key: 'class_name', label: '班级', type: 'text', width: 110 },
      { key: 'period', label: '节次', type: 'text', width: 90 },
      { key: 'subject', label: '科目', type: 'text', width: 100 },
      { key: 'status', label: '上课状态', ...SELECT(['已上课', '未上课', '调课', '代课']), width: 100 },
      { key: 'room', label: '教室', type: 'text', width: 100 },
      { key: 'remark', label: '备注', type: 'text', width: 160 },
    ],
    defaults: { status: '已上课' },
    filters: ['grade', 'from', 'to', 'q'],
  },
  leave: {
    key: 'leave', label: '请假表', table: 'att_hub_leave',
    title: '请假表 · 全部记录',
    desc: '支持跨日期、跨年级登记与历史查询，不再只能登记当日',
    columns: [
      { key: 'teacher_id', label: '教师ID', type: 'text', width: 100 },
      { key: 'name', label: '姓名', type: 'text', required: true, width: 110 },
      { key: 'grade', label: '年级', ...SELECT(['高一', '高二', '高三']), width: 90 },
      { key: 'leave_type', label: '请假类型', ...SELECT(['事假', '病假', '年假', '公假', '其他']), width: 100 },
      { key: 'start_at', label: '开始时间', type: 'text', required: true, width: 150 },
      { key: 'end_at', label: '结束时间', type: 'text', width: 150 },
      { key: 'hours', label: '时长', type: 'text', width: 90 },
      { key: 'reason', label: '事由', type: 'text', width: 160 },
      { key: 'approve_status', label: '审批状态', ...SELECT(['待审批', '已通过', '已驳回']), width: 100 },
      { key: 'registrar', label: '登记人', type: 'text', width: 110 },
      { key: 'remark', label: '备注', type: 'text', width: 160 },
    ],
    defaults: { leave_type: '事假', approve_status: '待审批' },
    filters: ['grade', 'from', 'to', 'q'],
  },
  stats: {
    key: 'stats', label: '统计表', table: 'att_hub_stats',
    title: '统计表 · 汇总',
    desc: '由 4 张业务表自动汇总，可手动修正并留痕，不再是只读死表',
    columns: [
      { key: 'period', label: '统计周期', type: 'text', required: true, width: 130 },
      { key: 'grade', label: '年级', ...SELECT(['全部', '高一', '高二', '高三']), width: 90 },
      { key: 'teacher', label: '教师', type: 'text', width: 110 },
      { key: 'expected', label: '应到', type: 'number', width: 80 },
      { key: 'actual', label: '实到', type: 'number', width: 80 },
      { key: 'duty_minutes', label: '坐班时长', type: 'number', width: 100 },
      { key: 'class_count', label: '上课节数', type: 'number', width: 100 },
      { key: 'leave_count', label: '请假次数', type: 'number', width: 100 },
      { key: 'absent_count', label: '缺勤次数', type: 'number', width: 100 },
      { key: 'remark', label: '备注', type: 'text', width: 160 },
    ],
    defaults: { grade: '全部', expected: 0, actual: 0, duty_minutes: 0, class_count: 0, leave_count: 0, absent_count: 0 },
    filters: ['grade', 'from', 'to', 'q'],
  },
};

export const HUB_SHEET_KEYS = Object.keys(HUB_SHEETS);
export const HUB_TABLES = HUB_SHEET_KEYS.map((k) => HUB_SHEETS[k].table);
export const isHubSheet = (key) => Object.prototype.hasOwnProperty.call(HUB_SHEETS, key);
export const sheetDef = (key) => HUB_SHEETS[key] || null;

/* 一张表允许写入的字段 = 列定义 + 迁移来源标记（_src 不展示、不导出） */
export function writableKeys(key) {
  const def = sheetDef(key);
  return def ? def.columns.map((c) => c.key) : [];
}

export function blankRow(key, extra = {}) {
  const def = sheetDef(key);
  if (!def) return {};
  const row = {};
  for (const c of def.columns) row[c.key] = '';
  return { ...row, ...(def.defaults || {}), ...extra };
}

/* 裁剪 + 去空白：只保留本表字段，避免批量导入把别的表的列塞进来 */
export function normalizeRow(key, input = {}) {
  const def = sheetDef(key);
  if (!def) return {};
  const out = {};
  for (const c of def.columns) {
    let v = input[c.key];
    if (v === undefined || v === null) v = '';
    if (typeof v === 'string') v = v.trim();
    if (c.type === 'number') v = Number(v) || 0;
    if (c.type === 'select' && c.options && v && !c.options.includes(v)) v = c.options[0];
    out[c.key] = v;
  }
  return out;
}

/* 必填校验：返回错误文案，空字符串表示通过 */
export function validateRow(key, row) {
  const def = sheetDef(key);
  if (!def) return '未知的数据表';
  for (const c of def.columns) {
    if (c.required && !String(row?.[c.key] ?? '').trim()) return `请填写「${c.label}」`;
  }
  return '';
}

/* 统一筛选：年级 / 日期区间 / 关键词；年级和日期都只是筛选，不是存储边界 */
export function filterRows(key, rows, f = {}) {
  const def = sheetDef(key);
  if (!def) return [];
  const grade = String(f.grade || '').trim();
  const from = String(f.from || '').trim();
  const to = String(f.to || '').trim();
  const q = String(f.q || '').trim().toLowerCase();
  const subject = String(f.subject || '').trim();
  const dateKeyOf = (r) => String(r.date || r.start_at || r.period || '').slice(0, 10);
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (r.deleted_at) return false;
    if (grade && String(r.grade || '') !== grade) return false;
    if (subject && String(r.subject || '') !== subject) return false;
    const d = dateKeyOf(r);
    if (from && d && d < from) return false;
    if (to && d && d > to) return false;
    if (q) {
      /* 搜整行而不是只搜已定义列：迁移进来的历史记录可能带额外字段
         （学科、旧表标记等），按列定义拼字符串会把它们漏掉。 */
      const hay = Object.values(r)
        .map((v) => (v && typeof v === 'object' ? '' : String(v ?? '')))
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ---------------- CSV 批量导入 / 导出 ---------------- */
export function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(key, rows) {
  const def = sheetDef(key);
  if (!def) return '';
  const head = def.columns.map((c) => csvEscape(c.label)).join(',');
  const lines = (Array.isArray(rows) ? rows : []).map((r) =>
    def.columns.map((c) => csvEscape(r[c.key])).join(','));
  return '\ufeff' + [head, ...lines].join('\r\n');
}

/* 逐字符解析，兼容引号包裹、字段内逗号与换行；表头按中文列名匹配，也兼容英文字段 key */
export function parseCsv(text) {
  const src = String(text || '').replace(/^\ufeff/, '');
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((v) => String(v).trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((v) => String(v).trim() !== '')) rows.push(row);
  return rows;
}

export function fromCsv(key, text) {
  const def = sheetDef(key);
  if (!def) return { rows: [], errors: ['未知的数据表'] };
  const grid = parseCsv(text);
  if (!grid.length) return { rows: [], errors: ['文件是空的'] };
  const header = grid[0].map((s) => String(s).trim());
  const byLabel = new Map(def.columns.map((c) => [c.label, c.key]));
  const byKey = new Map(def.columns.map((c) => [c.key, c.key]));
  const keys = header.map((h) => byLabel.get(h) || byKey.get(h) || '');
  if (!keys.includes('name') && !keys.includes('period')) {
    return { rows: [], errors: ['表头对不上，请使用「导出」得到的 CSV 作为模板'] };
  }
  const rows = []; const errors = [];
  grid.slice(1).forEach((cells, i) => {
    const raw = {};
    keys.forEach((k, j) => { if (k) raw[k] = cells[j] ?? ''; });
    const row = normalizeRow(key, raw);
    const err = validateRow(key, row);
    if (err) errors.push(`第 ${i + 2} 行：${err}`);
    else rows.push(row);
  });
  return { rows, errors };
}

/* ---------------- 统计表自动汇总 ----------------
   从 4 张业务表按 (周期, 年级) 聚合；手工修正过的行由调用方保留，不覆盖。 */
export function calcStats({ roster = [], duty = [], klass = [], leave = [] }, period = '', grade = '全部') {
  const inPeriod = (r) => !period || String(r.date || r.start_at || '').slice(0, 7) === String(period).slice(0, 7);
  const inGrade = (r) => grade === '全部' || !grade || String(r.grade || '') === grade;
  const pick = (list) => list.filter((r) => !r.deleted_at && inPeriod(r) && inGrade(r));
  const teachers = pick(roster);
  const duties = pick(duty);
  const classes = pick(klass);
  const leaves = pick(leave);
  const names = new Set(teachers.map((t) => String(t.name || '').trim()).filter(Boolean));
  for (const r of [...duties, ...classes, ...leaves]) {
    const n = String(r.name || '').trim();
    if (n) names.add(n);
  }
  const people = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const countBy = (list, name) => list.filter((r) => String(r.name || '').trim() === name).length;
  return people.map((name) => ({
    period: String(period || '全部'),
    grade: grade || '全部',
    teacher: name,
    expected: 1,
    actual: duties.some((r) => String(r.name || '').trim() === name && r.status === '在岗') ? 1 : 0,
    duty_minutes: countBy(duties, name) * 40,
    class_count: countBy(classes, name),
    leave_count: countBy(leaves, name),
    absent_count: duties.filter((r) => String(r.name || '').trim() === name && r.status === '缺勤').length,
    remark: '自动汇总',
  }));
}

/* 迁移来源标记：同一条旧记录只迁一次 */
export function migrationKey(sheet, tableId, rowId) {
  return `${sheet}:${tableId}:${rowId}`;
}
