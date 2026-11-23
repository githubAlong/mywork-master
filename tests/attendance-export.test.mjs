import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  attendanceExportFileName,
  attendanceExportGrid,
  recentMonthKeys,
  resolveWatermarkText,
} from '../js/attendance-export.mjs';

test('PDF/PNG/Excel export source keeps each attendance table separate', () => {
  const rows = [{ teacher: '张老师', subject: '语文', data: { k_上课: '1', k_请假: '0' } }];
  const columns = [
    { key: 'k_上课', label: '上课', type: 'check' },
    { key: 'k_请假', label: '请假', type: 'check' },
  ];
  const seat = attendanceExportGrid({ grade: '高一', date: '2026-11-06', type: 'seat', columns, rows });
  const classSheet = attendanceExportGrid({ grade: '高一', date: '2026-11-06', type: 'class', columns, rows });
  assert.match(seat[0][0], /坐班表/);
  assert.match(classSheet[0][0], /上课表/);
  assert.notDeepEqual(seat[0], classSheet[0]);
  assert.equal(
    attendanceExportFileName({ grade: '高一', date: '2026-11-06', type: 'class', extension: 'xlsx' }),
    '高一上课表_2026-11-06.xlsx',
  );
});

test('watermark can be disabled or rendered with fixed placeholders', () => {
  assert.equal(resolveWatermarkText({ on: false, text: '{grade}' }, { grade: '高一' }), '');
  assert.equal(
    resolveWatermarkText({ on: true, text: '{grade}-{date}-{name}' }, {
      grade: '高一', date: '2026-11-06', name: '坐班表',
    }),
    '高一-2026-11-06-坐班表',
  );
});

test('rolling year window crosses the calendar-year boundary', () => {
  assert.deepEqual(recentMonthKeys(new Date(2026, 1, 15), 12), [
    '2025-03', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08',
    '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02',
  ]);
});

test('PNG 导出不再画标题下那条横线，表格文字统一黑色', async () => {
  const src = (await readFile(new URL('../js/attendance-prd.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const png = src.slice(src.indexOf('const buildPngPages'), src.indexOf('const openPngPreview'));
  assert.ok(png.length > 500, '要能截到 buildPngPages 那一段');
  assert.doesNotMatch(png, /2a6bf2|rule:\s*true/, '那条横线按标题基线往下画，正好压在第二行日期上');
  assert.equal((png.match(/ctx\.fillStyle='#000'/g) || []).length, 2, '表头和数据格各一处，都用黑色');
  assert.doesNotMatch(png, /#34445d/, '蓝灰色只留给抬头，表格里不再用');
});
