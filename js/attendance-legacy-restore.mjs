/* ============================================================================
 * 考勤工作台恢复 · 历史数据自动补齐（纯函数层）
 * ----------------------------------------------------------------------------
 * 背景（2026-11-26 设计确认）：
 *   用户要求把 v417~v423 的「5 张独立表」页面恢复成旧版 PRD 单页工作台，
 *   并且「之前的历史数据也要同步过来」。
 *
 *   旧版工作台读的是 teachers / attendance_tables / attendance_rows /
 *   settings.attendanceWorkspace.leaves；v417 之后新录入的数据落在
 *   att_hub_roster / duty / class / leave / stats 五张表里。
 *   两套存储必须合并，否则恢复界面后这几天新录的记录会凭空消失。
 *
 *   「哪些是这几天新录的」不用猜：/att-hub-migrate 把旧数据迁进 hub 时
 *   会给每行打 `_src` 标记。所以：
 *     - 带 `_src`     = 从旧版迁过来的副本，旧版本来就有，跳过；
 *     - 不带 `_src`   = 用户在新表页亲手录的，必须回填；
 *     - 带 `_restored`= 本模块已回填过，跳过（行级幂等）。
 *
 *   本文件只做「形状转换」，不碰 localStorage；落库在 localapi.js 的
 *   ensureLegacyRestore()。这样纯函数可以直接单测，也能在浏览器里安全重试。
 * ========================================================================== */

export const LEGACY_RESTORE_VERSION = 'v424-attendance-restore';
export const HUB_RESTORE_KEYS = ['roster', 'duty', 'class', 'leave', 'stats'];

const txt = (v) => String(v ?? '').trim();
const day = (v) => txt(v).slice(0, 10);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

/** 只保留「用户在新表页亲手录入、且尚未回填」的行。 */
export function freshHubRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter(
    (r) => r && !r.deleted_at && !r._src && !r._restored,
  );
}

/** 新花名册行 → 旧版 teachers 行。没有姓名或部门为空时不生成。 */
export function hubTeacherToLegacy(row = {}) {
  const name = txt(row.name);
  if (!name) return null;
  return {
    name,
    subject: txt(row.subject),
    grade: txt(row.grade) || '高一',
    phone: txt(row.phone),
    active: /离职|停用/.test(txt(row.status)) ? 0 : 1,
  };
}

/** 旧版坐班表的勾选列 key（与 localapi.defaultCols('seat') 保持一致）。 */
const CHECK_KEYS = ['k_上课', 'k_坐班', 'k_听课', 'k_教研', 'k_请假'];

/**
 * 新「坐班表 / 上课表」行 → 旧版 attendance_rows 的一行。
 * 同时写 `__teacherGrid`（PRD 首选）和勾选列（legacy 回退路径），
 * 保证按「全天」和按「第 N 节」查看都能把状态显示出来。
 */
export function hubSheetRowToLegacy(kind, row = {}, options = {}) {
  const name = txt(row.name);
  if (!name) return null;
  const date = day(row.date) || today();
  const grade = txt(row.grade) || '高一';
  const subject = txt(row.subject) || txt(options.subject);
  const status = txt(row.status);
  const remarkParts = [txt(row.remark)];

  const grid = {
    class: 'u', sit: 'u', listen: 'u', research: 'u',
    leave: '', leave_time: null, remark: txt(row.remark),
  };
  const checks = {};
  for (const k of CHECK_KEYS) checks[k] = '';

  let extraLeave = null;
  if (kind === 'duty') {
    if (/请假/.test(status)) {
      grid.leave = '事假';
      checks.k_请假 = '1';
      extraLeave = {
        id: `hub-duty-${row.id ?? `${date}-${name}`}`,
        grade, name, subject, type: '事假',
        start_date: date, end_date: date,
        days: 1, hours: 0, months: 0,
        duration_unit: 'day', duration: 1, day_part: '', leave_time: null,
        status: '已批', remark: [txt(row.remark), txt(row.place)].filter(Boolean).join('；'),
        source: 'hub', source_hub_id: row.id ?? null,
      };
    } else if (/缺勤|旷/.test(status)) {
      grid.sit = 'n';
    } else {
      /* 在岗 / 迟到 / 留空都算坐班在场；迟到只留痕，不改状态口径 */
      grid.sit = 'y';
      checks.k_坐班 = '1';
      if (/迟到/.test(status)) remarkParts.unshift('迟到');
    }
    if (txt(row.place)) remarkParts.push(txt(row.place));
  } else {
    /* 上课表：已上课 / 调课 / 代课都算有课，未上课记 n */
    grid.class = /未上课|停课/.test(status) ? 'n' : 'y';
    if (grid.class === 'y') checks.k_上课 = '1';
    if (/调课|代课/.test(status)) remarkParts.unshift(status);
    if (txt(row.class_name)) remarkParts.push(txt(row.class_name));
    if (txt(row.room)) remarkParts.push(txt(row.room));
  }

  const remark = remarkParts.filter(Boolean).join('；');
  grid.remark = remark;
  const data = {
    ...checks,
    k_remark: remark,
    __teacherGrid: { '0': grid },
    /* 行级来源标记：即使版本标记被清掉，重复执行也不会再插一行 */
    __hub: { sheet: kind, id: row.id ?? null },
  };
  return {
    type: kind === 'duty' ? 'seat' : 'class',
    date, grade, name, subject, data, extraLeave,
  };
}

/** 新「请假表」行 → 旧版 settings.attendanceWorkspace.leaves 记录。 */
export function hubLeaveToLegacy(row = {}, options = {}) {
  const name = txt(row.name);
  if (!name) return null;
  const start = day(row.start_at) || today();
  const end = day(row.end_at) || start;
  const hours = Number(row.hours) || 0;
  const days = hours >= 8 ? Math.max(1, Math.round(hours / 8)) : 1;
  const remark = [txt(row.reason), txt(row.remark)].filter(Boolean).join('；');
  return {
    id: `hub-leave-${row.id ?? `${start}-${name}`}`,
    grade: txt(row.grade) || '高一',
    name,
    subject: txt(options.subject),
    type: txt(row.leave_type) || '事假',
    start_date: start, end_date: end,
    days, hours, months: 0,
    duration_unit: 'day', duration: days, day_part: '', leave_time: null,
    status: /驳回/.test(txt(row.approve_status)) ? '已撤销' : '已批',
    remark,
    source: 'hub', source_hub_id: row.id ?? null,
    registrar: txt(row.registrar),
  };
}

/** 新「统计表」行在旧版没有一一对应的格子，原样归档，保证一条不丢。 */
export function hubStatsToLegacy(row = {}) {
  return { ...row, _hubSheet: 'stats' };
}

/**
 * 一次性生成回填计划（纯函数，不写库）。
 * @param {object} snapshot hub = 5 张独立表的行；teachers/leaves/rows 是旧版现状
 * @returns {{teacherAdds, sheetAdds, leaveAdds, statsArchive, freshIds, counts}}
 */
export function planHubBackfill(snapshot = {}) {
  const {
    hub = {}, teachers = [], leaves = [],
    subjectOf: lookupSubject = () => '',
  } = snapshot;

  const freshIds = {};
  const fresh = {};
  for (const key of HUB_RESTORE_KEYS) {
    fresh[key] = freshHubRows(hub[key]);
    freshIds[key] = fresh[key].map((r) => String(r.id));
  }

  /* 学科解析要同时看「旧名册」和「本次新补的教师」：
     旧工作台按 姓名 + 学科 认领格子，两者对不上时记录会显示成空白。 */
  const nameSubject = new Map(
    (teachers || []).filter((t) => !t.deleted_at)
      .map((t) => [txt(t.name), txt(t.subject)]),
  );
  const subjectOf = (name) => txt(lookupSubject(name)) || nameSubject.get(txt(name)) || '';

  /* 教师去重：年级 + 姓名 + 学科 三条一起看（与 /teachers POST 判重一致） */
  const seenTeacher = new Set(
    (teachers || []).filter((t) => !t.deleted_at)
      .map((t) => [txt(t.grade), txt(t.name), txt(t.subject)].join('|')),
  );
  const teacherAdds = [];
  const addTeacher = (raw) => {
    if (!raw) return;
    const key = [txt(raw.grade), txt(raw.name), txt(raw.subject)].join('|');
    if (seenTeacher.has(key)) return;
    seenTeacher.add(key);
    teacherAdds.push(raw);
    nameSubject.set(txt(raw.name), txt(raw.subject));
  };
  for (const r of fresh.roster) addTeacher(hubTeacherToLegacy(r));
  /* 状态表里出现、但名单里查不到的教师也要补，否则格子没人认领 */
  for (const kind of ['duty', 'class', 'leave']) {
    for (const r of fresh[kind]) {
      const name = txt(r.name);
      if (!name) continue;
      addTeacher({
        name,
        subject: txt(r.subject) || txt(subjectOf(name)),
        grade: txt(r.grade) || '高一',
        phone: '', active: 1,
      });
    }
  }

  const sheetAdds = [];
  const leaveAdds = [];
  const seenLeave = new Set((leaves || []).map((l) => txt(l.id)));

  for (const kind of ['duty', 'class']) {
    for (const r of fresh[kind]) {
      const plan = hubSheetRowToLegacy(kind, r, { subject: subjectOf(txt(r.name)) });
      if (!plan) continue;
      sheetAdds.push(plan);
      if (plan.extraLeave && !seenLeave.has(plan.extraLeave.id)) {
        seenLeave.add(plan.extraLeave.id);
        leaveAdds.push(plan.extraLeave);
      }
    }
  }
  for (const r of fresh.leave) {
    const plan = hubLeaveToLegacy(r, { subject: subjectOf(txt(r.name)) });
    if (plan && !seenLeave.has(plan.id)) {
      seenLeave.add(plan.id);
      leaveAdds.push(plan);
    }
  }

  const statsArchive = fresh.stats.map(hubStatsToLegacy);
  return {
    teacherAdds, sheetAdds, leaveAdds, statsArchive, freshIds,
    counts: {
      teachers: teacherAdds.length,
      sheets: sheetAdds.length,
      leaves: leaveAdds.length,
      stats: statsArchive.length,
    },
  };
}
