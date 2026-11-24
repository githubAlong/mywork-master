import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLeaveTime, formatLeaveTime, leaveTimeFromRecord, leaveDayParts,
} from '../js/attendance-prd-domain.mjs';

/* 2026-11-24 用户需求：坐班/上课/教研三张表在请假列后面加「请假时间」，
   填法三种——小时（输几就是几小时）、天（上午/下午/全天）、月（输几就是几个月）。 */

test('请假时间：小时与月按数字折算，天按上午/下午/全天', () => {
  const hour = normalizeLeaveTime({ unit: 'hour', amount: 3 });
  assert.equal(hour.hours, 3);
  assert.equal(hour.days, 0);
  assert.equal(formatLeaveTime(hour), '3小时');

  const month = normalizeLeaveTime({ unit: 'month', amount: 2 });
  assert.equal(month.months, 2);
  assert.equal(month.days, 60);
  assert.equal(formatLeaveTime(month), '2个月');

  const morning = normalizeLeaveTime({ unit: 'day', part: 'morning' });
  assert.equal(morning.days, 0.5);
  assert.equal(formatLeaveTime(morning), '上午');

  const afternoon = normalizeLeaveTime({ unit: 'day', part: 'afternoon' });
  assert.equal(afternoon.days, 0.5);
  assert.equal(formatLeaveTime(afternoon), '下午');

  const full = normalizeLeaveTime({ unit: 'day', part: 'full' });
  assert.equal(full.days, 1);
  assert.equal(formatLeaveTime(full), '全天');
});

test('请假时间：天这一档同时给出作息表钟点段，请假表和导出照旧按 24 小时显示', () => {
  const parts = leaveDayParts();
  const morning = normalizeLeaveTime({ unit: 'day', part: 'morning' });
  assert.equal(morning.day_part, parts[0].label);
  const afternoon = normalizeLeaveTime({ unit: 'day', part: 'afternoon' });
  assert.equal(afternoon.day_part, parts[1].label);
  const full = normalizeLeaveTime({ unit: 'day', part: 'full' });
  assert.equal(full.day_part, parts[2].label);
});

test('请假时间：非法输入不落库', () => {
  assert.equal(normalizeLeaveTime(null), null);
  assert.equal(normalizeLeaveTime({ unit: 'hour', amount: 0 }), null);
  assert.equal(normalizeLeaveTime({ unit: 'hour', amount: -2 }), null);
  assert.equal(normalizeLeaveTime({ unit: 'hour', amount: 'abc' }), null);
  assert.equal(normalizeLeaveTime({ unit: 'week', amount: 1 }), null);
  /* 没给 part 时按全天兜底，不能变成 0 天 */
  assert.equal(normalizeLeaveTime({ unit: 'day' }).days, 1);
});

test('请假记录反推请假时间：手写的记录也能回显成小时/上午/下午/全天/月', () => {
  assert.equal(formatLeaveTime(leaveTimeFromRecord({ duration_unit: 'hour', hours: 2 })), '2小时');
  assert.equal(formatLeaveTime(leaveTimeFromRecord({ duration_unit: 'month', months: 3 })), '3个月');
  assert.equal(formatLeaveTime(leaveTimeFromRecord({ duration_unit: 'morning' })), '上午');
  assert.equal(formatLeaveTime(leaveTimeFromRecord({ duration_unit: 'afternoon' })), '下午');
  assert.equal(formatLeaveTime(leaveTimeFromRecord({ duration_unit: 'day', days: 1 })), '全天');
  const parts = leaveDayParts();
  assert.equal(formatLeaveTime(leaveTimeFromRecord({ duration_unit: 'day', days: 0.5, day_part: parts[0].label })), '上午');
  assert.equal(formatLeaveTime(leaveTimeFromRecord({ duration_unit: 'day', days: 0.5, day_part: parts[1].label })), '下午');
  assert.equal(leaveTimeFromRecord(null), null);
});

test('切到小时/月再切回天，仍记得刚才选的上午/下午/全天', () => {
  const hour = normalizeLeaveTime({ unit: 'hour', amount: 2, part: 'afternoon' });
  assert.equal(hour.part, 'afternoon');
  const back = normalizeLeaveTime({ unit: 'day', part: hour.part });
  assert.equal(back.part, 'afternoon');
  assert.equal(back.days, 0.5);
  /* 没带档位时默认全天，不能落成 0.5 天 */
  assert.equal(normalizeLeaveTime({ unit: 'hour', amount: 2 }).part, 'full');
});

test('请假时间往返：写进去再按记录反推，标签不变', () => {
  for (const input of [
    { unit: 'hour', amount: 2 },
    { unit: 'hour', amount: 1.5 },
    { unit: 'month', amount: 3 },
    { unit: 'day', part: 'morning' },
    { unit: 'day', part: 'afternoon' },
    { unit: 'day', part: 'full' },
  ]) {
    const normalized = normalizeLeaveTime(input);
    const record = { ...normalized, leave_time: { unit: normalized.unit, amount: normalized.amount, part: normalized.part } };
    assert.equal(formatLeaveTime(leaveTimeFromRecord(record)), formatLeaveTime(normalized));
  }
});
