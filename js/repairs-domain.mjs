const REPAIR_STATUS_ALIASES = new Map([
  ['pending','pending'],['待处理','pending'],['待维修','pending'],['待修复','pending'],
  ['doing','doing'],['处理中','doing'],['维修中','doing'],['正在维修','doing'],['修复中','doing'],
  ['done','done'],['已修好','done'],['已修复','done'],['修好了','done'],['已完成','done'],['修复完成','done'],['完成','done'],
  ['canceled','canceled'],['cancelled','canceled'],['已取消','canceled'],['取消','canceled'],
]);
const REPAIR_STATUS_LABELS = {pending:'待处理',doing:'处理中',done:'已修好',canceled:'已取消'};
export function normalizeRepairStatus(value) {
  const raw=String(value??'').trim();
  if(!raw)return 'pending';
  return REPAIR_STATUS_ALIASES.get(raw.toLowerCase())||raw;
}
export function repairStatusInputValue(value) {
  const raw=String(value??'').trim();
  if(!raw)return REPAIR_STATUS_LABELS.pending;
  const normalized=normalizeRepairStatus(raw);
  return REPAIR_STATUS_LABELS[normalized]||raw;
}
export function isRepairFixed(row) {
  return normalizeRepairStatus(row?.status)==='done';
}

/* 修复状态的三态口径（用户 11-27）：
   以前列表只判「修没修好」两态（已修好 / 未修好），弹窗里却是三态（待修复 / 修复中 /
   已修复）—— 同一条记录弹窗写着「修复中」、列表却显示「未修好」，看着像两个字段。
   现在列表、弹窗、统计卡全部读 repairStatusView，里外同一个词、同一个色。
   key 用来选配色（fixed 绿 / doing 蓝 / pending 橙 / canceled 灰）。 */
const REPAIR_STATUS_VIEW = {
  pending: { key: 'pending', label: '待修复' },
  doing: { key: 'doing', label: '修复中' },
  done: { key: 'fixed', label: '已修复' },
  canceled: { key: 'canceled', label: '已取消' },
};
export function repairStatusView(value) {
  const hit = REPAIR_STATUS_VIEW[normalizeRepairStatus(value)];
  if (hit) return hit;
  /* 用户自己敲的自由文本（等待配件 / 已联系厂家…）原样显示，按未修复配色 */
  const raw = String(value ?? '').trim();
  return { key: 'pending', label: raw || '待修复' };
}
export function repairStatusForSave(value, fixed) {
  if (fixed) return 'done';
  const status = normalizeRepairStatus(value);
  return status === 'done' ? 'pending' : status;
}
export function isRepairTracked(row) {
  const value=row?.follow_up;
  return value===true||value===1||value==='1'||['true','yes','是'].includes(String(value??'').trim().toLowerCase());
}
export function summarizeRepairs(rows,month) {
  const target=String(month||'');
  const monthRows=(Array.isArray(rows)?rows:[]).filter(row=>String(row?.date||'').slice(0,7)===target);
  const trackedRows=monthRows.filter(isRepairTracked);
  /* 统计卡要和列表那一列说同一套词（用户 11-27）：以前卡片只有「已修复 / 未修复」两态，
     列表却写着 待修复 / 修复中 / 已修复，还会把「已取消」算进未修复里，数字和列表对不上。
     现在按 repairStatusView 的 key 分区计数，四类相加恒等于总数（含自由文本 -> pending）。 */
  const byStatus={pending:0,doing:0,fixed:0,canceled:0};
  for(const row of monthRows) byStatus[repairStatusView(row.status).key]+=1;
  return {
    rows:monthRows,total:monthRows.length,
    fixed:byStatus.fixed,
    pending:byStatus.pending,
    doing:byStatus.doing,
    canceled:byStatus.canceled,
    /* 未修复 = 待修复 + 修复中；已取消不算「没修好」，单独一张灰卡，不混进来 */
    unfinished:byStatus.pending+byStatus.doing,
    tracked:trackedRows.length,
    reminders:trackedRows.map(row=>({id:row.id,item:String(row.item||'未填写设备名称'),remark:String(row.remark||'')})),
  };
}
