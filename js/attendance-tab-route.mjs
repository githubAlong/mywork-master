/* 考勤侧栏六张表入口 → 旧版工作台六页签的映射（v425，方案 C）。
   纯函数单独放一个模块，方便单测；work.js 只负责把 hash 第三段丢进来。

   - 六页签：花名册 / 坐班表 / 上课表 / 教研表 / 请假表 / 汇总统计表
   - v417~v423 的独立表老链接（departments / duty / stats）也映射到页签，
     不会白屏、不会再打开已经下线的独立表页面
   - 中文年级名（高一 / 高二 / 高三）不属于页签，返回空串，
     由 work.js 当作初始年级继续传给工作台
*/
export const ATTENDANCE_TABS = Object.freeze([
  'roster', 'seat', 'class', 'research', 'leave', 'summary',
]);

const LEGACY_TAB = Object.freeze({
  departments: 'roster',
  duty: 'seat',
  stats: 'summary',
});

export function attendanceTabOf(raw) {
  const key = String(raw ?? '').trim();
  if (ATTENDANCE_TABS.includes(key)) return key;
  return LEGACY_TAB[key] || '';
}
