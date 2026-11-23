import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weekdayOf, weekdayLabel, isCourseOnDate, daySchooledPeriods, dayTimeRange, orderPeriods, sameGrade,
} from '../js/attendance-day-periods.mjs';

const SUMMER = '夏令时课表';
/* 用被测函数自己反推星期，测试就不会随日历漂移。 */
const MONDAY = '2026-03-02';
const mon = weekdayOf(MONDAY);
const course = (patch = {}) => ({
  id: 'c1', weekday: mon, period_no: 1, grade: '高一',
  start_time: '08:00', end_time: '08:40', ...patch,
});

test('weekdayOf 按本地日期解析，周日=0，非法日期给 -1', () => {
  assert.equal(weekdayOf('2026-03-01'), 0);
  assert.equal(weekdayOf(MONDAY), 1);
  assert.equal(weekdayLabel(MONDAY), '周一');
  assert.equal(weekdayOf('2026-03-08'), 0);
  assert.equal(weekdayOf('不是日期'), -1);
  assert.equal(weekdayLabel(''), '');
});

test('isCourseOnDate 按星期、生效日期、作息类型、年级四道条件筛课', () => {
  const base = { date: MONDAY, grade: '高一', scheduleType: SUMMER, defaultCourseType: SUMMER };
  assert.equal(isCourseOnDate(course(), base), true);
  assert.equal(isCourseOnDate(course({ weekday: (mon + 1) % 7 }), base), false);
  assert.equal(isCourseOnDate(course({ start_date: '2026-04-01' }), base), false);
  assert.equal(isCourseOnDate(course({ end_date: '2026-02-28' }), base), false);
  assert.equal(isCourseOnDate(course({ id: 'cX' }), { ...base, courseTypes: { cX: '冬令时课表' } }), false);
  assert.equal(isCourseOnDate(course({ id: 'cX' }), { ...base, courseTypes: { cX: SUMMER } }), true);
  assert.equal(isCourseOnDate(course({ grade: '高二' }), base), false);
  assert.equal(isCourseOnDate(course({ grade: '全部' }), base), true);
  assert.equal(isCourseOnDate(course({ grade: '' }), base), true);
  assert.equal(isCourseOnDate(null, base), false);
});

test('daySchooledPeriods 返回当天实际有课的节次并升序去重', () => {
  const options = { date: MONDAY, grade: '高一', scheduleType: SUMMER, defaultCourseType: SUMMER };
  const rows = [
    course({ id: 'a', period_no: 3, start_time: '10:00', end_time: '10:40' }),
    course({ id: 'b', period_no: 1, start_time: '08:00', end_time: '08:40' }),
    course({ id: 'c', period_no: 1, start_time: '08:05', end_time: '08:45' }),
    course({ id: 'd', period_no: 2, weekday: (mon + 2) % 7 }),
    course({ id: 'e', period_no: 4, start_time: '', end_time: '11:30' }),
    course({ id: 'f', period_no: 5, start_time: '11:40', end_time: '11:40' }),
  ];
  assert.deepEqual(daySchooledPeriods(rows, options).map((item) => item.no), [1, 3]);
  assert.deepEqual(daySchooledPeriods(rows, options)[0], { no: 1, start: '08:00', end: '08:40' });
  assert.deepEqual(daySchooledPeriods([], options), []);
  assert.deepEqual(daySchooledPeriods(undefined, options), []);
});

test('dayTimeRange 取当天最早开始到最晚结束，脏数据不外溢', () => {
  assert.deepEqual(dayTimeRange([
    { no: 3, start: '10:00', end: '10:40' },
    { no: 1, start: '08:00', end: '08:40' },
    { no: 7, start: '15:20', end: '16:00' },
  ]), ['08:00', '16:00']);
  assert.deepEqual(dayTimeRange([{ no: 1, start: '08:00', end: '08:40' }]), ['08:00', '08:40']);
  assert.equal(dayTimeRange([]), null);
  assert.equal(dayTimeRange(null), null);
  // 早于 07:00 的早读与晚于 23:00 的跨天数据整条剔除，不会拼出开始晚于结束的时间段。
  assert.deepEqual(dayTimeRange([
    { no: 1, start: '06:30', end: '07:20' },
    { no: 2, start: '08:00', end: '23:30' },
  ]), null);
  assert.deepEqual(dayTimeRange([
    { no: 1, start: '06:30', end: '07:20' },
    { no: 2, start: '08:00', end: '08:40' },
  ]), ['08:00', '08:40']);
  assert.deepEqual(dayTimeRange([{ no: 1, start: '08:00', end: '08:00' }]), null);
  assert.deepEqual(dayTimeRange([{ no: 1 }]), null);
});

test('orderPeriods 把当天有课的节次排前面，无课节次保留并打标记', () => {
  const periods = [
    { no: 1, label: '第1节' }, { no: 2, label: '第2节' },
    { no: 3, label: '第3节' }, { no: 4, label: '第4节' },
  ];
  const ordered = orderPeriods(periods, [{ no: 3 }, { no: 1 }]);
  assert.deepEqual(ordered.map((item) => item.no), [1, 3, 2, 4]);
  assert.deepEqual(ordered.map((item) => item.schooled), [true, true, false, false]);
  assert.deepEqual(ordered[0].label, '第1节');
  assert.deepEqual(orderPeriods(periods, []).map((item) => item.schooled), [false, false, false, false]);
});

test('年级名「高一年级」和课表里的「高一」算同一个年级', () => {
  assert.equal(sameGrade('高一', '高一年级'), true);
  assert.equal(sameGrade('高一年级', '高一'), true);
  assert.equal(sameGrade('高一年级', '高二年级'), false);
  assert.equal(sameGrade('', '高一'), true);
  assert.equal(sameGrade('全部', '高一'), true);
  const date = '2026-11-24';
  const weekday = weekdayOf(date);
  const options = { date, grade: '高一年级', scheduleType: SUMMER, defaultCourseType: SUMMER };
  assert.equal(isCourseOnDate({ id: 1, weekday, grade: '高一' }, options), true);
  assert.equal(isCourseOnDate({ id: 2, weekday, grade: '高一年级' }, options), true);
  assert.equal(isCourseOnDate({ id: 3, weekday, grade: '高二年级' }, options), false);
});
