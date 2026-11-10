export const DEFAULT_PERIODS = [
  { no: 1, label: '第1节', start: '08:00', end: '08:45' },
  { no: 2, label: '第2节', start: '08:55', end: '09:40' },
  { no: 3, label: '第3节', start: '10:00', end: '10:45' },
  { no: 4, label: '第4节', start: '10:55', end: '11:40' },
  { no: 5, label: '第5节', start: '14:20', end: '15:05' },
  { no: 6, label: '第6节', start: '15:15', end: '16:00' },
  { no: 7, label: '第7节', start: '16:10', end: '16:55' },
  { no: 8, label: '第8节', start: '17:05', end: '17:50' },
  { no: 9, label: '第9节', start: '18:30', end: '19:15' },
];

export const LEAVE_TYPES = ['事假', '病假', '婚假', '丧假', '产假', '公假', '调休', '公出'];

const TEACHER_COLUMNS = Object.freeze(['序号', '归属部门', '归属年级', '姓名', '学科', '上课', '坐班', '听课', '教研', '请假', '备注', '操作']);
export const ATTENDANCE_COLUMNS = {
  roster: TEACHER_COLUMNS,
  seat: TEACHER_COLUMNS,
  class: TEACHER_COLUMNS,
  research: TEACHER_COLUMNS,
  leave: ['姓名', '学科', '类型', '开始', '结束', '天数', '状态', '备注'],
  summary: ['序号', '姓名', '学科', '坐班（在/应到）', '上课节次', '听课次数', '教研（已到/—）', '请假天数', '综合状态'],
};

export function nextTriState(value) {
  return value === 'y' ? 'n' : 'y';
}

export function leaveCoversDate(leave, date) {
  const start = String(leave?.start_date || leave?.from || '');
  const end = String(leave?.end_date || leave?.to || start);
  return !!start && !!date && start <= date && end >= date;
}

export function activeLeavesFor(leaveRecords, date, grade) {
  return (Array.isArray(leaveRecords) ? leaveRecords : []).filter((item) =>
    (!grade || String(item.grade || '') === String(grade))
    && leaveCoversDate(item, date)
    && item.status !== '已撤销'
  );
}

function rowData(row) {
  return row?.data && typeof row.data === 'object' ? row.data : {};
}

function periodRecord(row, period) {
  const data = rowData(row);
  const periods = data.__periods && typeof data.__periods === 'object' ? data.__periods : {};
  return periods[String(period)] || periods['第' + period + '节'] || {};
}

export function matchesAttendancePeriod(value, period) {
  const match = String(value || '').match(/(?:第\s*)?(\d+)(?:\s*[-~至]\s*(\d+))?\s*节/);
  if (!match) return true;
  const current = Number(period);
  return current >= Number(match[1]) && current <= Number(match[2] || match[1]);
}

function deriveLegacyRosterState(teacher, {
  seatRows = [],
  classRows = [],
  researchRows = [],
  leaveRecords = [],
  date = '',
  period = 1,
} = {}) {
  const name = String(teacher?.name || '').trim();
  const seatRow = seatRows.find((row) => String(row.teacher || '').trim() === name);
  const selectedSeat = periodRecord(seatRow, period);
  const classRecords = classRows.filter((row) => {
    const data = rowData(row);
    const record = data.__classRecord || {};
    return !data.__deleted
      && String(row.teacher || '').trim() === name
      && Number(record.period || period) === Number(period);
  });
  const researchRecords = researchRows.filter((row) => {
    const d = rowData(row).__research || {};
    return Array.isArray(d.attendees)
      && d.attendees.includes(name)
      && matchesAttendancePeriod(d.period_time, period);
  });
  const leaves = (Array.isArray(leaveRecords) ? leaveRecords : []).filter((item) =>
    String(item.name || item.teacher || '').trim() === name && leaveCoversDate(item, date)
  );
  const classStatus = classRecords.some((row) => (rowData(row).__classRecord || {}).status === 'y') ? 'y'
    : classRecords.some((row) => (rowData(row).__classRecord || {}).status === 'n') ? 'n' : 'u';
  const seatStatus = selectedSeat.status === 'y' || selectedSeat.status === 'n' ? selectedSeat.status : 'u';
  const listensFromSeat = !!String(selectedSeat.listen_class || '').trim();
  const listensFromClass = classRows.some((row) => {
    const data = rowData(row);
    const record = data.__classRecord || {};
    return !data.__deleted
      && Number(record.period || period) === Number(period)
      && Array.isArray(record.listeners)
      && record.listeners.includes(name);
  });
  return {
    class: classStatus,
    sit: seatStatus,
    listen: listensFromSeat || listensFromClass || !!selectedSeat.listen_class,
    research: researchRecords.length > 0,
    leave: leaves[0]?.type || '',
    leaveRecords: leaves,
    seatRecord: selectedSeat,
  };
}

function calculateLegacyDailySummary({
  teachers = [],
  seatRows = [],
  classRows = [],
  researchRows = [],
  leaveRecords = [],
  date = '',
} = {}) {
  const people = (teachers || []).filter((teacher) => teacher && teacher.active !== false && Number(teacher.active ?? 1) !== 0);
  const activeLeaves = activeLeavesFor(leaveRecords, date);
  const rows = people.map((teacher, index) => {
    const name = String(teacher.name || '').trim();
    const seatRow = seatRows.find((row) => String(row.teacher || '').trim() === name);
    const seatPeriods = Array.from({ length: 9 }, (_, i) => periodRecord(seatRow, i + 1));
    const registeredSeat = seatPeriods.filter((record) => record.status === 'y' || record.status === 'n');
    const seatPresent = registeredSeat.filter((record) => record.status === 'y').length;
    const assignedClasses = classRows.filter((row) => {
      const data = rowData(row);
      return !data.__deleted && String(row.teacher || '').trim() === name;
    });
    const taught = assignedClasses.filter((row) => (rowData(row).__classRecord || {}).status === 'y').length;
    const listenedFromSeat = seatPeriods.filter((record) => !!String(record.listen_class || '').trim()).length;
    const listenedFromClass = classRows.filter((row) => {
      const data = rowData(row);
      return !data.__deleted && Array.isArray(data.__classRecord?.listeners) && data.__classRecord.listeners.includes(name);
    }).length;
    const researchCount = researchRows.filter((row) => {
      const research = rowData(row).__research || {};
      return Array.isArray(research.attendees) && research.attendees.includes(name);
    }).length;
    const leaves = activeLeaves.filter((item) => String(item.name || item.teacher || '').trim() === name);
    const leaveDays = leaves.reduce((sum, item) => sum + (Number(item.days) || 0), 0);
    const hasClassAbsence = assignedClasses.some((row) => (rowData(row).__classRecord || {}).status === 'n');
    const hasSeatAbsence = registeredSeat.some((record) => record.status === 'n');
    const overall = leaves.length ? '请假' : hasClassAbsence ? '空堂待核实'
      : hasSeatAbsence ? '未坐班' : registeredSeat.length ? '正常' : '未登记';
    return {
      serial: index + 1,
      name,
      subject: teacher.subject || '',
      seatPresent,
      seatExpected: registeredSeat.length,
      classes: taught,
      listens: listenedFromSeat + listenedFromClass,
      research: researchCount ? '已到' : '—',
      leaveDays,
      overall,
      note: teacher.remark || teacher.note || '',
    };
  });
  const seatPresent = rows.reduce((sum, row) => sum + row.seatPresent, 0);
  const seatExpected = rows.reduce((sum, row) => sum + row.seatExpected, 0);
  const classes = rows.reduce((sum, row) => sum + row.classes, 0);
  const listens = rows.reduce((sum, row) => sum + row.listens, 0);
  const leavePeople = new Set(activeLeaves.map((item) => String(item.name || item.teacher || '').trim()).filter(Boolean)).size;
  return {
    expectedTeachers: people.length,
    seatRate: seatExpected ? Math.round((seatPresent / seatExpected) * 100) : 0,
    seatPresent,
    seatExpected,
    classes,
    listens,
    leavePeople,
    rows,
  };
}

const GRID_TYPES = ['seat', 'class', 'research'];
const GRID_KEYS = ['class', 'sit', 'listen', 'research'];
const gridRecord = (row, period) => rowData(row).__teacherGrid?.[String(period)];
export function matchesGridTeacher(row, teacher) {
  const id = rowData(row).__teacherId;
  if (id != null && teacher?.id != null) return String(id) === String(teacher.id);
  return String(row?.teacher || '').trim() === String(teacher?.name || '').trim()
    && String(row?.subject || '').trim() === String(teacher?.subject || '').trim();
}

export function deriveTableGridState(teacher, type, rows, context = {}) {
  const legacy = deriveLegacyRosterState(teacher, {
    ...context, seatRows: [], classRows: [], researchRows: [],
    [type + 'Rows']: rows.filter(row => !rowData(row).__deleted && (matchesGridTeacher(row, teacher)
      || (type === 'research' && rowData(row).__research
        && String(rowData(row).__research.subject || row.subject || row.teacher || '').trim() === String(teacher.subject || '').trim()))),
  });
  // Class listening records name the listener rather than the class teacher.
  if (type === 'class') legacy.listen = deriveLegacyRosterState(teacher, { ...context, classRows: rows }).listen;
  const row = rows.find(item => !rowData(item).__deleted && matchesGridTeacher(item, teacher));
  const saved = gridRecord(row, context.period || 1) || {};
  return {
    class: legacy.class, sit: legacy.sit, listen: legacy.listen ? 'y' : 'u',
    research: legacy.research ? 'y' : 'u', leave: legacy.leave,
    remark: type === 'seat' ? legacy.seatRecord?.remark || ''
      : rowData(row).__classRecord?.remark || rowData(row).__research?.remark || '',
    ...saved,
  };
}

export function updateTeacherGrid(rows, teacher, type, period, key, value, context = {}) {
  if (!GRID_TYPES.includes(type) || ![...GRID_KEYS, 'leave', 'remark'].includes(key)) {
    throw new Error('无效的考勤表或字段');
  }
  let row = rows.find(item => !rowData(item).__deleted && matchesGridTeacher(item, teacher));
  if (!row) {
    row = { teacher: teacher.name, subject: teacher.subject || '', data: {} };
    rows.push(row);
  }
  const record = deriveTableGridState(teacher, type, rows, { ...context, period });
  const next = { ...record, [key]: value };
  row.teacher = teacher.name;
  row.subject = teacher.subject || '';
  row.data = {
    ...rowData(row), __teacherId: teacher.id,
    __teacherGrid: { ...(rowData(row).__teacherGrid || {}), [String(period)]: next },
  };
  return next;
}

export function mergeTeacherGridRows(savedRows, draftRows, period) {
  const rows = savedRows.map(row => ({ ...row, data: { ...rowData(row) } }));
  for (const draft of draftRows) {
    const record = gridRecord(draft, period);
    if (!record || rowData(draft).__deleted) continue;
    const teacher = { id: rowData(draft).__teacherId, name: draft.teacher, subject: draft.subject };
    let target = rows.find(row => !rowData(row).__deleted && matchesGridTeacher(row, teacher));
    if (!target) {
      target = { teacher: draft.teacher, subject: draft.subject, data: {} };
      rows.push(target);
    }
    target.teacher = draft.teacher;
    target.subject = draft.subject;
    target.data = {
      ...rowData(target), __teacherId: rowData(draft).__teacherId,
      __teacherGrid: { ...(rowData(target).__teacherGrid || {}), [String(period)]: { ...record } },
    };
  }
  return rows;
}

export function deriveRosterState(teacher, context = {}) {
  const legacy = deriveLegacyRosterState(teacher, context);
  const period = context.period || 1;
  const hasGrid = GRID_TYPES.some(type => (context[type + 'Rows'] || []).some(row =>
    !rowData(row).__deleted && matchesGridTeacher(row, teacher) && gridRecord(row, period)));
  if (!hasGrid) return legacy;
  const states = GRID_TYPES.map(type => deriveTableGridState(teacher, type, context[type + 'Rows'] || [], context));
  const aggregate = key => states.some(state => state[key] === 'y') ? 'y'
    : states.some(state => state[key] === 'n') ? 'n' : 'u';
  return {
    ...legacy, class: aggregate('class'), sit: aggregate('sit'),
    listen: aggregate('listen') === 'y', research: aggregate('research') === 'y',
    listenStatus: aggregate('listen'), researchStatus: aggregate('research'),
    leave: states.find(state => state.leave)?.leave || legacy.leave,
  };
}

export function calculateDailySummary(context = {}) {
  const summary = calculateLegacyDailySummary(context);
  const people = (context.teachers || []).filter(teacher => teacher && Number(teacher.active ?? 1) !== 0);
  const leavePeople = new Set(activeLeavesFor(context.leaveRecords, context.date)
    .map(row => String(row.name || row.teacher || '').trim()).filter(Boolean));
  people.forEach((teacher, index) => {
    const periods = new Set();
    for (const type of GRID_TYPES) for (const row of context[type + 'Rows'] || []) {
      if (rowData(row).__deleted || !matchesGridTeacher(row, teacher)) continue;
      for (const value of Object.keys(rowData(row).__teacherGrid || {})) periods.add(Number(value));
    }
    if (!periods.size) return;
    const output = summary.rows[index];
    const states = [...periods].map(period => ({ period, state: deriveRosterState(teacher, { ...context, period }) }));
    const seats = Array.from({ length: 9 }, (_, i) => deriveRosterState(teacher, { ...context, period: i + 1 }).sit);
    output.seatPresent = seats.filter(value => value === 'y').length;
    output.seatExpected = seats.filter(value => value === 'y' || value === 'n').length;
    // Retain legacy records outside the edited periods, including multiple classes.
    const classes = (context.classRows || []).filter(row => !rowData(row).__deleted
      && matchesGridTeacher(row, teacher) && rowData(row).__classRecord?.status === 'y'
      && !periods.has(Number(rowData(row).__classRecord.period || 1))).length;
    output.classes = classes + states.filter(item => item.state.class === 'y').length;
    const seatListens = (context.seatRows || []).filter(row => matchesGridTeacher(row, teacher))
      .flatMap(row => Object.entries(rowData(row).__periods || {}))
      .filter(([period, record]) => !periods.has(Number(period)) && !!record.listen_class).length;
    const classListens = (context.classRows || []).filter(row => !rowData(row).__deleted
      && !periods.has(Number(rowData(row).__classRecord?.period || 1))
      && rowData(row).__classRecord?.listeners?.includes(teacher.name)).length;
    output.listens = seatListens + classListens + states.filter(item => item.state.listen).length;
    const legacyResearch = (context.researchRows || []).some(row => rowData(row).__research?.attendees?.includes(teacher.name)
      && ![...periods].some(period => matchesAttendancePeriod(rowData(row).__research.period_time, period)));
    output.research = legacyResearch || states.some(item => item.state.research) ? '已到' : '—';
    const onLeave = states.some(item => item.state.leave) || output.leaveDays > 0;
    if (onLeave) leavePeople.add(teacher.name);
    output.overall = onLeave ? '请假' : states.some(item => item.state.class === 'n') ? '空堂待核实'
      : seats.includes('n') ? '未坐班' : output.seatExpected ? '正常' : '未登记';
  });
  summary.seatPresent = summary.rows.reduce((sum, row) => sum + row.seatPresent, 0);
  summary.seatExpected = summary.rows.reduce((sum, row) => sum + row.seatExpected, 0);
  summary.seatRate = summary.seatExpected ? Math.round(summary.seatPresent / summary.seatExpected * 100) : 0;
  summary.classes = summary.rows.reduce((sum, row) => sum + row.classes, 0);
  summary.listens = summary.rows.reduce((sum, row) => sum + row.listens, 0);
  summary.leavePeople = leavePeople.size;
  return summary;
}
