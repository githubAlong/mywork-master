/* ============================================================================
   attendance-hub-domain.mjs —— 考勤二级导航 5 张独立表的字段契约与纯函数

   设计原则：
   · 5 张表平级独立存储，各自一张本地表（att_hub_*），共用花名册的 teacher_id。
   · 年级 / 日期 / 学科只是查询筛选条件，不再是数据隔离边界。
   · 部门 → 年级是两级配置（att_hub_departments），年级名单仍复用 /grades，
     这样旧的年级工作台、花名册筛选下拉都不用改。
   · 本文件不碰 DOM、不碰 localStorage，方便在 Node 里直接跑单测。
   ========================================================================== */

const SELECT = (list) => ({ type: 'select', options: list });

/* 默认部门：老库升级上来时，已有年级自动挂到「高中部」下，记录一条都不丢。 */
export const DEFAULT_DEPARTMENT = '高中部';

/* 年级不再写死在前端：花名册顶部接入「年级管理 / 新建年级」后，
   年级下拉和新增表单都要读 /grades 的真实年级列表。
   老库或一个年级都没建过的时候给三项兜底，别把筛选能力弄丢。 */
export const FALLBACK_GRADES = ['高一', '高二', '高三'];
export function gradeOptions(data) {
  const raw = Array.isArray(data?.grades) ? data.grades : [];
  const list = [...new Set(raw.map((g) => String(g ?? '').trim()).filter(Boolean))];
  return list.length ? list : FALLBACK_GRADES.slice();
}

export const HUB_SHEETS = {
  roster: {
    key: 'roster', label: '花名册', table: 'att_hub_roster',
    title: '花名册 · 全部教师',
    desc: '教师主数据，全年级统一编号；其余 4 张表通过教师序号关联',
    columns: [
      { key: 'teacher_id', label: '教师序号', type: 'text', width: 100 },
      { key: 'name', label: '姓名', type: 'text', required: true, width: 110 },
      { key: 'subject', label: '学科', type: 'text', width: 100 },
      { key: 'department', label: '所属部门', type: 'text', width: 120 },
      { key: 'grade', label: '年级', ...SELECT(['高一', '高二', '高三']), width: 90 },
      { key: 'status', label: '在职状态', ...SELECT(['在职', '休假', '离职']), width: 100 },
      { key: 'hire_date', label: '入职日期', type: 'date', width: 120 },
      { key: 'phone', label: '联系方式', type: 'text', width: 130 },
      { key: 'remark', label: '备注', type: 'text', width: 160 },
    ],
    defaults: { status: '在职', department: '高中部' },
    filters: ['grade', 'subject', 'q'],
  },
  duty: {
    key: 'duty', label: '坐班表', table: 'att_hub_duty',
    title: '坐班表 · 全部记录',
    desc: '坐班记录独立存储，随时可进可录，不再要求先确认上课表',
    columns: [
      { key: 'date', label: '日期', type: 'date', required: true, width: 120 },
      { key: 'teacher_id', label: '教师序号', type: 'text', width: 100 },
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
      { key: 'teacher_id', label: '教师序号', type: 'text', width: 100 },
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
      { key: 'teacher_id', label: '教师序号', type: 'text', width: 100 },
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
    /* 年级由「年级管理」动态维护，不能按写死的三个选项回落：
       否则新建一个年级后，存进去的记录会被悄悄改回「高一」。
       其余下拉仍按固定选项收敛，脏值不落库。 */
    if (c.key === 'grade' && typeof v === 'string') v = v.slice(0, 12);
    if (c.type === 'select' && c.options && v && c.key !== 'grade' && !c.options.includes(v)) v = c.options[0];
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

/* 年级名历史上两种写法并存：/grades 里常写「高一年级」，v411 迁移过的行
   被写死的下拉选项回落成了「高一」。筛选按去掉「年级」后缀后的名字比，
   动态年级列表和已迁移的数据才对得上。 */
export function gradeKey(v) {
  return String(v ?? '').trim().replace(/年级$/, '');
}

/* ---------------- 部门 → 年级（两级配置） ----------------
   年级名单仍然只有一份（/grades 的 u.settings.grades），部门只是给每个年级
   记一个归属（u.settings.gradeDept）。这样花名册筛选、旧年级工作台、
   导入导出全部不用改；部门管理页只负责建部门、把年级挂进去。 */

/** 部门名去空白、限长；重名判断也走这里 */
export function deptName(v) {
  return String(v ?? '').trim().slice(0, 20);
}

/** 取某个部门下的年级（保持 /grades 里的原始顺序，去重） */
export function gradesOfDepartment(grades, gradeDept, deptId) {
  const all = Array.isArray(grades) ? grades : [];
  const map = gradeDept && typeof gradeDept === 'object' ? gradeDept : {};
  const key = String(deptId ?? '');
  return [...new Set(all
    .map((g) => String(g ?? '').trim())
    .filter((g) => g && String(map[g] ?? '') === key))];
}

/** 花名册分表页签标题：高一年级 → 高一教师花名册 */
export function rosterTabLabel(gradeName) {
  const s = String(gradeName ?? '').trim();
  /* 只把「高一年级 / 初二年级」这类「学段 + 序号 + 年级」规范成「高一 / 初二」。
     不能直接套 gradeKey：它会剥掉任何「年级」后缀，把「七年级」削成「七」，
     页签就变成「七教师花名册」了。 */
  const g = /^(?:高|初|小)[一二三四五六七八九十0-9]+年级$/.test(s) ? s.slice(0, -2) : s;
  return g ? `${g}教师花名册` : '分表';
}

/** 日期字符串 ±N 天（纯 UTC 日历运算，避免本地时区把日期带偏） */
export function shiftDate(iso, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return String(iso ?? '');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + (Number(delta) || 0));
  return d.toISOString().slice(0, 10);
}

/** 统计快捷区间：本日 / 本月 / 本年（今天用调用方给的北京日期） */
export function periodRange(kind, today) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(today ?? '')) ? String(today) : '';
  if (!day) return { from: '', to: '', label: '全部' };
  const y = day.slice(0, 4);
  if (kind === 'day') return { from: day, to: day, label: `本日 ${day}` };
  if (kind === 'month') return { from: `${y}-${day.slice(5, 7)}-01`, to: day, label: `本月 ${y}-${day.slice(5, 7)}` };
  if (kind === 'year') return { from: `${y}-01-01`, to: day, label: `本年 ${y}` };
  return { from: '', to: '', label: '全部' };
}

/* 统一筛选：部门 / 年级 / 日期区间 / 关键词；都只是筛选，不是存储边界 */
export function filterRows(key, rows, f = {}) {
  const def = sheetDef(key);
  if (!def) return [];
  const grade = gradeKey(f.grade);
  const dept = String(f.dept || f.department || '').trim();
  const from = String(f.from || '').trim();
  const to = String(f.to || '').trim();
  const q = String(f.q || '').trim().toLowerCase();
  const subject = String(f.subject || '').trim();
  const dateKeyOf = (r) => String(r.date || r.start_at || r.period || '').slice(0, 10);
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (r.deleted_at) return false;
    /* 只有花名册有「所属部门」列；其余 4 张表不按部门过滤，
       否则传了 dept 参数会把整张表筛空。 */
    if (key === 'roster' && dept && String(r.department || '') !== dept
        && !(dept === DEFAULT_DEPARTMENT && !String(r.department || '').trim())) return false;
    if (grade && gradeKey(r.grade) !== grade) return false;
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

/* 花名册按「教师序号」升序：1 号在最前、100 号在最后。
   序号可能是纯数字、带 T- 前缀，也可能为空（手工新增还没编号），
   统一取第一段数字比较；没有序号的排最后，序号相同按 id 升序保持稳定。
   其余 4 张记录表保持后端默认顺序（新记录在前），不受影响。 */
export function sortHubRows(key, rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (key !== 'roster') return list;
  const noOf = (r) => {
    const m = String(r?.teacher_id ?? '').match(/\d+/);
    return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
  };
  return list.sort((a, b) => {
    const d = noOf(a) - noOf(b);
    if (Number.isFinite(d) && d !== 0) return d;
    return (Number(a?.id) || 0) - (Number(b?.id) || 0);
  });
}

/* ---------------- 科目分类（组织管理 · 科目管理用） ----------------
   科目只有名字，分类按名字归到四类，科目管理页的「科目分类 N」就是这里的去重数。
   新增科目时不用手填分类，界面保持设计稿那样只有一个名称输入框。 */
export const SUBJECT_CATEGORY = {
  语文: '语言与人文', 英语: '语言与人文', 日语: '语言与人文', 俄语: '语言与人文',
  历史: '语言与人文', 政治: '语言与人文', 道德与法治: '语言与人文',
  数学: '数学与科学', 物理: '数学与科学', 化学: '数学与科学', 生物: '数学与科学',
  科学: '数学与科学', 信息技术: '数学与科学', 通用技术: '数学与科学',
  音乐: '艺术与体育', 美术: '艺术与体育', 体育: '艺术与体育', 体育与健康: '艺术与体育',
  书法: '艺术与体育', 舞蹈: '艺术与体育',
};
export function subjectCategory(name) {
  const key = String(name ?? '').trim();
  if (!key) return '';
  if (SUBJECT_CATEGORY[key]) return SUBJECT_CATEGORY[key];
  /* 「体育与健康」「道德与法治」这类带后缀的写法，按包含关系兜底 */
  for (const [k, v] of Object.entries(SUBJECT_CATEGORY)) {
    if (key.includes(k)) return v;
  }
  return '其他';
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
   从 4 张业务表按 (周期, 年级) 聚合；手工修正过的行由调用方保留，不覆盖。
   · 只统计「我记录的数据」：4 张业务表里的真实录入 / 导入 / 迁移记录。
   · range = { from, to } 支持本日 / 本月 / 本年；period 是旧版的月份口径，
     两个参数都不传时统计全部。 */
export function calcStats({ roster = [], duty = [], klass = [], leave = [] }, period = '', grade = '全部', range = null) {
  const from = String(range?.from || '').trim();
  const to = String(range?.to || '').trim();
  const month = String(period || '').slice(0, 7);
  const inPeriod = (r) => {
    const d = String(r.date || r.start_at || '').slice(0, 10);
    if (from || to) {
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    }
    return !month || d.slice(0, 7) === month;
  };
  const inGrade = (r) => grade === '全部' || !grade || gradeKey(r.grade) === gradeKey(grade);
  const pick = (list) => list.filter((r) => !r.deleted_at && inPeriod(r) && inGrade(r));
  const teachers = roster.filter((r) => !r.deleted_at && inGrade(r));
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
