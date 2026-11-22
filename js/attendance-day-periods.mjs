import { cleanPeriodTime, getCanonicalPeriodNumber } from './timetable-periods.mjs';

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function toMinutes(time) {
  const parts = String(time || '').split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function toTime(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

export function weekdayOf(date) {
  const parsed = new Date(String(date || '') + 'T00:00:00');
  return Number.isNaN(parsed.getTime()) ? -1 : parsed.getDay();
}

export function weekdayLabel(date) {
  const index = weekdayOf(date);
  return index >= 0 ? WEEKDAY_LABELS[index] : '';
}

/* 课表里的年级写「高一」，考勤年级名常写成「高一年级」，去掉后缀再比，
   否则同一天明明有课却判成无排课。空值和「全部/全体」仍按通配处理。 */
export function sameGrade(a, b) {
  const norm = (value) => String(value || '').trim().replace(/年级$/, '');
  const left = norm(a);
  const right = norm(b);
  if (!left || !right || ['全部', '全体'].includes(left) || ['全部', '全体'].includes(right)) return true;
  return left === right;
}

/* 排课生效判定与考勤页原有的节次时间链保持同一口径：星期 + 生效日期 + 作息类型 + 年级。 */
export function isCourseOnDate(course, options = {}) {
  if (!course) return false;
  const weekday = options.weekday ?? weekdayOf(options.date);
  if (weekday < 0 || Number(course.weekday) !== weekday) return false;
  const day = String(options.date || '');
  if (course.start_date && day < String(course.start_date).slice(0, 10)) return false;
  if (course.end_date && day > String(course.end_date).slice(0, 10)) return false;
  const scheduleType = String(options.scheduleType || '');
  const courseType = (options.courseTypes || {})[String(course.id)] ?? options.defaultCourseType ?? '';
  if (scheduleType && courseType && courseType !== scheduleType) return false;
  const courseGrade = String(course.grade || '').trim();
  if (courseGrade && !['全部', '全体'].includes(courseGrade) && !sameGrade(courseGrade, options.grade)) return false;
  return true;
}

/* 返回当天实际有课的节次，按节次升序；同一节次多张课表行取第一条带时间的。 */
export function daySchooledPeriods(courses, options = {}) {
  const list = Array.isArray(courses) ? courses : [];
  const periodTimes = options.periodTimes || {};
  const byNumber = new Map();
  for (const course of list) {
    if (!isCourseOnDate(course, options)) continue;
    const number = Number(getCanonicalPeriodNumber(course, {
      periodTimes,
      scheduleType: options.scheduleType,
    }) ?? course.period_no);
    const start = cleanPeriodTime(course.start_time);
    const end = cleanPeriodTime(course.end_time);
    if (!Number.isFinite(number) || number <= 0 || !start || !end || toMinutes(end) <= toMinutes(start)) continue;
    if (!byNumber.has(number)) byNumber.set(number, { no: number, start, end });
  }
  return [...byNumber.values()].sort((a, b) => a.no - b.no);
}

/* 早于 07:00 或晚于 23:00 的节次多半是脏数据或跨天课表，整条不参与全天窗口，
   否则会出现开始时间比结束时间还晚的区间。 */
export function dayTimeRange(periods, options = {}) {
  const min = Number(options.earliestStart ?? 7 * 60);
  const max = Number(options.latestEnd ?? 23 * 60);
  const list = (Array.isArray(periods) ? periods : []).filter((item) => {
    const start = toMinutes(item?.start);
    const end = toMinutes(item?.end);
    return Number.isFinite(start) && Number.isFinite(end) && start >= min && end <= max && end > start;
  });
  if (!list.length) return null;
  return [toTime(Math.min(...list.map((item) => toMinutes(item.start)))),
    toTime(Math.max(...list.map((item) => toMinutes(item.end))))];
}

/* 节次下拉顺序：当天有课的排前面，没课的保留在后面并标注，避免无课节次填不了坐班/教研。 */
export function orderPeriods(periods, schooled) {
  const numbers = new Set((Array.isArray(schooled) ? schooled : []).map((item) => Number(item.no)));
  return (Array.isArray(periods) ? periods : [])
    .map((item) => ({ ...item, schooled: numbers.has(Number(item.no)) }))
    .sort((a, b) => Number(a.schooled === b.schooled) ? Number(a.no) - Number(b.no) : (a.schooled ? -1 : 1));
}
