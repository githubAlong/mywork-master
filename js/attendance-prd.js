import { api, classPicker, esc, toast, confirmDialog, saveBlob } from './core.js';
import { icon } from './ui.js';
import { createSlot } from './attday.js';
import { makeXlsx } from './attendance.js';
import { voiceSheet } from './attvoice.js';
import { cleanPeriodTime, getCanonicalPeriodNumber, normalizeTimetablePeriods } from './timetable-periods.mjs';
import { daySchooledPeriods, dayTimeRange, sameGrade, weekdayLabel } from './attendance-day-periods.mjs';
import { parseRosterFile, parseRosterText } from './roster-batch.mjs';
import { readXlsx, readDelimited } from './xlsx-lite.js';
import { ROSTER_SUBJECTS } from './roster-structure.mjs';
import { keeperForDailySlot } from './attendance-domain.mjs';
import {
  DEFAULT_PERIODS, LEAVE_TYPES, ATTENDANCE_COLUMNS, buildAttendanceExportGrid, parseLeaveDuration, formatLeaveDuration,
  nextTriState, activeLeavesFor, deriveRosterState, calculateDailySummary,
  matchesAttendancePeriod, deriveTableGridState, updateTeacherGrid, mergeTeacherGridRows, matchesGridTeacher, paginateExportGrid,
  splitAttendanceExportGrid, resolveSingleGridState,
  SUMMARY_COUNT_FIELDS, attendanceSummaryTotals, attendanceSummaryMonthBounds, summarizeAttendanceMonth,
  updateAttendanceSummaryRow, importAttendanceSummary, leaveDayParts, leaveDayPartLabel,
  LEAVE_TIME_UNITS, LEAVE_TIME_PARTS, normalizeLeaveTime, formatLeaveTime, leaveTimeFromRecord,
} from './attendance-prd-domain.mjs';

const TABS = [
  ['roster','花名册'],['seat','坐班表'],['class','上课表'],
  ['research','教研表'],['leave','请假表'],['summary','汇总统计表'],
];
/* 各表只显示本表相关的状态列（用户 11-15 规定）：坐班表是数据源、全量显示，
   上课表只看上课/听课，教研表只看教研/请假；数据仍来自同一份坐班记录。 */
const GRID_STATE_COLUMNS = { seat:['sit','class','listen','research','leave'], class:['class','listen'], research:['research','leave'] };
/* 用户 11-22 要求：坐班表和上课表、教研表默认展示一模一样。
   展示列统一取坐班表那套状态列；本表能直接勾选的格子仍按 GRID_STATE_COLUMNS 归属走，
   不属于本表的格子只读回显当天坐班总表的状态，避免出现第二条写入路径。 */
const SHEET_STATE_COLUMNS = GRID_STATE_COLUMNS.seat;
const GRID_STATE_LABELS = { sit:'坐班', class:'上课', listen:'听课', research:'教研', leave:'请假' };
/* 用户 11-23 要求：一个人同一节只能有一个状态。四列勾选项按这个优先级裁决，
   和 attendance-prd-domain.mjs 里单表内的顺序保持一致，谁先看谁后看都算得出同一个赢家。 */
const GRID_STATE_PRIORITY = ['class', 'sit', 'listen', 'research'];
const GRID_STATE_OWNERS = { sit:['seat'], class:['seat','class'], listen:['seat','class'], research:['seat','research'] };
const TYPE = { seat:'seat', class:'class', research:'research' };
const SHEET_LABELS = { seat:'坐班表', class:'上课表', research:'教研表', leave:'请假表', summary:'汇总统计表' };
const TODAY = () => new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
const rowData = (r) => r?.data && typeof r.data === 'object' ? r.data : {};
const objectValue = (value) => {
  if (value && typeof value === 'object') return value;
  try { const parsed = JSON.parse(String(value || '')); return parsed && typeof parsed === 'object' ? parsed : {}; }
  catch { return {}; }
};
/* 按键名排序后再序列化：判断「云端这行和本地这行内容是否一模一样」用，
   顺序不同不能算不同，否则每次都会误判成真冲突。 */
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => { out[key] = stableValue(value[key]); return out; }, {});
  }
  return value;
};
const SUMMER_SCHEDULE = '夏令时课表';
const WINTER_SCHEDULE = '冬令时课表';
const FALLBACK_PERIOD_TIMES = {
  [SUMMER_SCHEDULE]: {
    0:['07:00','07:50'],1:['08:00','08:45'],2:['08:55','09:40'],3:['09:50','10:35'],
    4:['10:55','11:40'],5:['14:10','14:55'],6:['15:05','15:50'],7:['16:00','16:45'],
    8:['16:55','17:40'],9:['17:50','18:35'],10:['19:00','19:45'],
  },
  [WINTER_SCHEDULE]: {
    0:['07:20','08:00'],1:['08:00','08:40'],2:['08:50','09:30'],3:['10:00','10:40'],
    4:['10:50','11:30'],5:['11:40','12:20'],6:['14:10','14:50'],7:['15:20','16:00'],
    8:['16:15','16:55'],9:['17:05','17:45'],10:['19:10','19:55'],
  },
};
const escAttr = esc;

async function chooseResearchAttendees(members, selected = members){
  return new Promise(resolve=>{
    const chosen=new Set(selected);
    const dialog=document.createElement('div');dialog.className='aprd-dialog';
    dialog.innerHTML='<div class="aprd-editor"><h3>教研签到 · 勾选到场教师</h3><div class="aprd-check-list">'+members.map(name=>'<label style="display:flex;grid-template-columns:auto 1fr;align-items:center"><input type="checkbox" value="'+esc(name)+'" '+(chosen.has(name)?'checked':'')+'> '+esc(name)+'</label>').join('')+'</div><div class="aprd-foot"><button data-cancel>取消</button><button class="primary" data-ok>确定登记</button></div></div>';
    document.body.append(dialog);
    dialog.querySelector('[data-cancel]').onclick=()=>{dialog.remove();resolve(null);};
    dialog.querySelector('[data-ok]').onclick=()=>{const picked=[...dialog.querySelectorAll('input:checked')].map(x=>x.value);dialog.remove();resolve(picked);};
  });
}


export async function renderAttendancePRD(root, { grade: initialGrade = '' } = {}) {
  let grades = (await api.get('/grades').catch(() => ({grades:[]}))).grades || [];
  let grade = grades.includes(initialGrade) ? initialGrade : (grades[0] || initialGrade || '');
  /* 用户 11-15 需求：进入考勤默认当天、全天（00:00-23:59），并优先打开坐班表 */
  let date = TODAY(), period = 0, tab = 'seat', search = '', subject = '';
  let isComposingSearch = false;
  let teachers = [], allTeachers = [], tables = [], details = {}, leaveRecords = [], prefs = {};
  let timetableSettings = {}, timetableCourses = [], timetablePeriods = [], periodTimeEdits = {};
  let showAddTeacher = false;
  let generating = false, editingSheet = '';
  /* 查看周期：日 = 当天逐节录入；月 / 年 = 每人一行累计、只读回看，六张表共用同一个开关。
     汇总表例外：它的「按月」一直是可编辑可生成的月快照，只有「按年」退成只读累计。 */
  let viewPeriod = 'day', summaryMonth = date.slice(0,7), viewYear = date.slice(0,4);
  let monthly = null, rangeState = null;
  const summaryDrafts = new Map();
  const isMonthlySummary = type => type==='summary' && viewPeriod==='month';
  /* 只读累计视图：非汇总表切到月/年就是累计，汇总表只有年是累计。 */
  const isRangeView = type => type==='summary' ? viewPeriod==='year' : viewPeriod!=='day';
  const monthKey = () => grade+'|'+summaryMonth;
  const summaryDraftKey = () => isMonthlySummary('summary') ? monthKey() : grade+'|'+date;
  const resultKey = type => isMonthlySummary(type) ? 'summary:month' : type==='summary' ? type : type+':'+period;
  // 请假与汇总没有独立的工作表表头，随当前年级和日期的坐班表同步。
  const resultTableType = type => TYPE[type] || 'seat';
  const confirmedResult = type => {
    const table=isMonthlySummary(type) ? (monthly?.key===monthKey()?monthly.table:null) : details[resultTableType(type)];
    return objectValue(table?.meta).workspace_results?.[resultKey(type)];
  };
  const editKey = type => (type==='summary' ? summaryDraftKey() : grade+'|'+date)+'|'+resultKey(type);
  const isEditing = type => editingSheet===editKey(type);
  const editConfirmedSheet = () => {
    if (confirmedResult(tab)) editingSheet=editKey(tab);
  };
  /* 生成请假表后，请假页只显示所选日期的请假记录；点「查看全部」恢复。 */
  let leaveOnlyDate = date;
  let watermarkOn = false, watermarkText = '';
  const draftCache = new Map();
  const currentScheduleType = () => {
    try {
      const saved = objectValue(typeof window !== 'undefined' ? window.localStorage?.getItem('wb_timetable_view_v1') : '');
      return saved.type === WINTER_SCHEDULE ? WINTER_SCHEDULE : SUMMER_SCHEDULE;
    } catch { return SUMMER_SCHEDULE; }
  };
  const daySchooledPeriodsOf = () => daySchooledPeriods(timetableCourses, {
    date,
    grade,
    scheduleType: currentScheduleType(),
    courseTypes: objectValue(timetableSettings.courseTypes),
    periodTimes: objectValue(timetableSettings.periodTimes),
    defaultCourseType: SUMMER_SCHEDULE,
  });
  const periodTimeOf = (number) => {
    const periodNo = Number(number);
    const scheduleType = currentScheduleType();
    const periodTimes = objectValue(timetableSettings.periodTimes);
    const periodDefinitions = objectValue(timetableSettings.periodDefinitions);
    const courseTypes = objectValue(timetableSettings.courseTypes);
    const definitionRows = [
      ...(Array.isArray(periodDefinitions[scheduleType + '|' + grade]) ? periodDefinitions[scheduleType + '|' + grade] : []),
      ...(Array.isArray(periodDefinitions[scheduleType + '|全部']) ? periodDefinitions[scheduleType + '|全部'] : []),
    ];
    const configuredPeriod = definitionRows.find(item => Number(item.period_no) === periodNo);
    const normalizedPeriods = normalizeTimetablePeriods(timetablePeriods, {periodTimes,scheduleType});
    const sharedPeriod = normalizedPeriods.find(item =>
      Number(getCanonicalPeriodNumber(item,{periodTimes,scheduleType}) ?? item.period_no) === periodNo
    );
    const course = timetableCourses.find(item => {
      const active = (!item.start_date || date >= String(item.start_date).slice(0,10))
        && (!item.end_date || date <= String(item.end_date).slice(0,10));
      const itemType = courseTypes[String(item.id)] || SUMMER_SCHEDULE;
      const itemPeriod = getCanonicalPeriodNumber(item,{periodTimes,scheduleType});
      return active && itemType === scheduleType
        && sameGrade(item.grade, grade)
        && Number(itemPeriod) === periodNo
        && cleanPeriodTime(item.start_time) && cleanPeriodTime(item.end_time);
    });
    const override = objectValue(periodTimes[scheduleType])?.[String(periodNo)] || {};
    const fallback = FALLBACK_PERIOD_TIMES[scheduleType]?.[periodNo] || [];
    const defaultPeriod = DEFAULT_PERIODS.find(item => Number(item.no) === periodNo) || {};
    const start = cleanPeriodTime(override.start_time) || cleanPeriodTime(course?.start_time)
      || cleanPeriodTime(configuredPeriod?.start_time) || cleanPeriodTime(sharedPeriod?.start_time)
      || fallback[0] || cleanPeriodTime(defaultPeriod.start) || '08:00';
    const end = cleanPeriodTime(override.end_time) || cleanPeriodTime(course?.end_time)
      || cleanPeriodTime(configuredPeriod?.end_time) || cleanPeriodTime(sharedPeriod?.end_time)
      || fallback[1] || cleanPeriodTime(defaultPeriod.end) || '08:45';
    const editKey = [date,scheduleType,grade,periodNo].join('|');
    const edited = periodTimeEdits[editKey];
    return edited ? [edited.start || start, edited.end || end] : [start,end];
  };
  const resolvePeriodRange = (number) => {
    const periodNo = Number(number);
    if (periodNo !== 0) return periodTimeOf(periodNo);
    /* 全天不再写死 00:00—23:59：当天有课取有课节次的最早开始—最晚结束；
       当天没排课（周末、节假日、这个年级今天没课）退到作息表全部节次的区间，
       手改过全天的话以手改为准（以前写死时手改根本不生效）。 */
    const schooled = daySchooledPeriodsOf();
    const times = (schooled.length ? schooled : DEFAULT_PERIODS).map(item => {
      const [start,end] = periodTimeOf(item.no);
      return { no:item.no, start, end };
    });
    const derived = dayTimeRange(times) || ['00:00','23:59'];
    const edited = periodTimeEdits[[date,currentScheduleType(),grade,0].join('|')];
    return edited ? [edited.start || derived[0], edited.end || derived[1]] : derived;
  };
  let busy = false;
  const loadMonth = async () => {
    const state = {key:monthKey(), loading:true};
    const month=summaryMonth, selectedGrade=grade;
    const roster=teachers, leaves=leaveRecords;
    monthly=state;
    paint();
    try {
      const tables = await api.get('/attendance',{grade:selectedGrade,month,include_rows:'1'});
      if(monthly!==state) return;
      const {start} = attendanceSummaryMonthBounds(month);
      state.table=keeperForDailySlot(tables,start,selectedGrade,'seat');
      state.rows=summarizeAttendanceMonth({month,grade:selectedGrade,teachers:roster,tables,leaveRecords:leaves});
    } catch(error) {
      state.error=attendanceErrorText(error);
    } finally {
      state.loading=false;
      if(monthly===state && tab==='summary' && isMonthlySummary(tab) && state.key===monthKey())paint();
    }
  };
  const load = async () => {
    if (busy) return; busy = true;
    try {
      const [g, roster, list, me, courses, periods] = await Promise.all([
        api.get('/grades'), api.get('/teachers',{grade,active:'all'}),
        api.get('/attendance',{grade,sheet_date:date}), api.get('/me').catch(()=>({user:{settings:{}},settings:{}})),
        api.get('/courses').catch(()=>[]), api.get('/periods').catch(()=>[]),
      ]);
      grades = g.grades || grades;
      allTeachers = roster.list || [];
      teachers = allTeachers.filter(t => Number(t.active ?? 1) === 1);
      tables = list || [];
      const userSettings = objectValue(me.user?.settings ?? me.settings);
      timetableSettings = objectValue(userSettings.timetable);
      timetableCourses = Array.isArray(courses) ? courses : [];
      timetablePeriods = Array.isArray(periods) ? periods : [];
      prefs = objectValue(userSettings.attendanceWorkspace);
      leaveRecords = Array.isArray(prefs.leaves) ? prefs.leaves : [];
      details = {};
      for (const type of ['seat','class','research']) {
        const t = tables.find(x => (x.sheet_type || x.kind) === type && !x.deleted_at);
        if (t) details[type] = await api.get('/attendance/'+t.id);
      }
      if(isRangeView(tab))await loadRange();
      else if(isMonthlySummary(tab))await loadMonth();
      else paint();
    } catch(e) {
      root.innerHTML = '<div class="att-work-error">'+esc(e.message || '考勤数据加载失败')+'</div>';
    } finally { busy = false; }
  };
  const savePrefs = async (patch) => {
    const next = {...prefs,...patch};
    const result = await api.patch('/me',{settings:{attendanceWorkspace:next}});
    prefs = result?.user?.settings?.attendanceWorkspace || next;
  };
  const getTable = async (type, { seedClass = true } = {}) => {
    let t = details[type];
    if (!t) {
      t = await createSlot({date,grade,type,period:String(period)});
      t = await api.get('/attendance/'+t.id);
      details[type] = t;
    }
    if (type === 'class' && seedClass) {
      const rows = Array.isArray(t.rows) ? t.rows.slice() : [];
      let changed = false;
      for (const teacher of teachers) {
        const hasPeriodRow = rows.some(row => {
          const data = rowData(row), record = data.__classRecord || {};
          return !data.__deleted && row.teacher === teacher.name
            && Number(record.period ?? period) === Number(period);
        });
        if (hasPeriodRow) continue;
        let row = rows.find(item => item.teacher === teacher.name
          && !rowData(item).__classRecord && !rowData(item).__deleted);
        if (!row) {
          row = {teacher:teacher.name,subject:teacher.subject||'',data:{}};
          rows.push(row);
        }
        row.data = {...rowData(row),__classRecord:{
          class_name:'',period:Number(period),status:'u',listeners:[],remark:'',
        }};
        changed = true;
      }
      if (changed) {
        await saveRows('class',t,rows);
        t = await api.get('/attendance/'+t.id);
        details[type] = t;
      }
    }
    return t;
  };
  /* 表头版本就地同步：PATCH 表头、写明细（表上有 touch 触发器，已确认的表还会改
     meta.confirm_dirty）都会推进云端的 updated_at。本地 details 里的版本号不跟着换，
     下一次保存就拿过期版本去比对，云端匹配 0 行，于是单人单机也弹
     「表头已被另一台设备修改」——自动保存一开就必撞。 */
  const syncHeader = (type, table, header) => {
    if (!header || !header.id) return table;
    Object.assign(table, header);
    if (type) details[type] = table;
    return table;
  };
  /* 保存串行化：自动保存的 350ms 防抖回调和「切页签/节次前落盘」会撞在一起，
     两个请求拿同一个表头版本，后一个必然被判成冲突。排队执行，谁都不用抢。 */
  let saveQueue = Promise.resolve();
  const queueSave = (task) => {
    const run = saveQueue.then(task, task);
    saveQueue = run.then(() => null, () => null);
    return run;
  };
  /* 云端冲突原文（WB_ATTENDANCE_CONFLICT: …）不该直接怼到用户脸上：
     表头版本对不上属内部时序问题，下面已自动重试；只有明细行真被别的设备改过
     才需要用户核对，那时候也必须说清「这次没保存」。 */
  const attendanceErrorText = (error) => {
    const text = String(error?.message || error || '');
    if (error?.conflictScope === 'rows') {
      return '这张考勤表刚在另一台设备上改过。为避免覆盖，本次未保存；请刷新后核对再改。';
    }
    if (/WB_ATTENDANCE_CONFLICT/.test(text)) {
      return '表头版本刚被更新过，已自动重新同步；如果反复出现，请刷新页面后再试。';
    }
    return text || '保存失败，请检查网络后重试';
  };
  const saveRows = async (type, table, rows, { alignPeriod = true } = {}) => {
    /* 保存成功后把云端的最新版本回填到本地缓存。
       表头、每一行都有自己的 updated_at，写入一次就全变；不回填的话，
       下一次点击（或切回别的节次草稿）还拿旧版本去比对，
       刚被自己保存过的行会被判成「另一台设备改过」，与表头那条同源。 */
    const refreshSavedVersions = async () => {
      const fresh = await api.get('/attendance/'+table.id).catch(() => null);
      if (!fresh?.id) return;
      const header = {...fresh};
      delete header.rows;
      syncHeader(type, table, header);
      const byId = new Map((fresh.rows||[]).map(row=>[String(row.id), row]));
      const stamp = row => {
        const saved = row?.id ? byId.get(String(row.id)) : null;
        if (saved?.updated_at) row.updated_at = saved.updated_at;
      };
      (rows||[]).forEach(stamp);
      draftCache.forEach(cached=>(cached||[]).forEach(stamp));
      (details[type]?.rows||[]).forEach(stamp);
    };
    /* 写明细会让表头版本前进，所以表头节次要在写明细之前对齐，
       并且一律用云端最新版本号去比对。 */
    if (alignPeriod && String(table.periods || '') !== String(period)) {
      const patchHeader = (expected) => api.patch('/attendance/'+table.id,
        {expected_updated_at:expected || '',periods:String(period)});
      let header;
      try {
        header = await patchHeader(table.updated_at);
      } catch (error) {
        /* 版本号过期多半是刚被自己上一次保存推进的：表头只存节次这类元数据，
           不该因此打断录入 —— 取最新版本重试一次，仍失败才算真冲突。 */
        if (!/WB_ATTENDANCE_CONFLICT/.test(String(error?.message || error || ''))) throw error;
        const latest = await api.get('/attendance/'+table.id).catch(() => null);
        header = await patchHeader(latest?.updated_at || '');
      }
      /* 这一步不能省：PATCH 成功后云端 updated_at 已经变了，
         本地还留旧值的话，下一次保存必定再被判成冲突。 */
      syncHeader(type, table, header);
    }
    const payload = rows.map(r => ({id:r.id,teacher:r.teacher,subject:r.subject,data:rowData(r),expected_updated_at:r.updated_at || ''}));
    try {
      const res = await api.post('/attendance/'+table.id+'/rows',{rows:payload,dirty:true});
      if (Array.isArray(res?.ids)) rows.forEach((r,i)=>{ if(!r.id && res.ids[i]) r.id=res.ids[i]; });
      await refreshSavedVersions();
      return res;
    } catch (error) {
      if (!/WB_ATTENDANCE_CONFLICT/.test(String(error?.message || error || ''))) throw error;
      /* 版本冲突先比内容：如果云端每一行都和这次要写的一模一样，说明只是自己
         上一次保存把版本推进了（重复写同样的值），回填最新版本重发一次就行；
         内容真的不同才算「另一台设备改过」，那种才必须让用户核对。 */
      const latest = await api.get('/attendance/'+table.id).catch(() => null);
      if (latest?.id) {
        const byId = new Map((latest.rows||[]).map(row=>[String(row.id), row]));
        const identical = rows.every(row=>{
          if (!row.id) return true;
          const current = byId.get(String(row.id));
          if (!current) return false;
          return String(current.teacher||'')===String(row.teacher||'')
            && String(current.subject||'')===String(row.subject||'')
            && JSON.stringify(stableValue(current.data||{}))===JSON.stringify(stableValue(rowData(row)));
        });
        if (identical) {
          rows.forEach(row=>{
            const current = row.id ? byId.get(String(row.id)) : null;
            if (current?.updated_at) row.updated_at = current.updated_at;
          });
          const latestHeader = {...latest};
          delete latestHeader.rows;
          syncHeader(type, table, latestHeader);
          const retry = rows.map(r => ({id:r.id,teacher:r.teacher,subject:r.subject,data:rowData(r),expected_updated_at:r.updated_at || ''}));
          const res = await api.post('/attendance/'+table.id+'/rows',{rows:retry,dirty:true});
          if (Array.isArray(res?.ids)) rows.forEach((r,i)=>{ if(!r.id && res.ids[i]) r.id=res.ids[i]; });
          await refreshSavedVersions();
          return res;
        }
      }
      /* 明细行版本冲突才是真的「另一台设备改过」：留给用户核对，不能被自动重试掩盖。 */
      error.conflictScope = 'rows';
      throw error;
    }
  };
  const persistAndReload = async (type, rows, message='已保存') => queueSave(async () => {
    const t = await getTable(type);
    await saveRows(type,t,rows);
    toast(message,'ok'); await load();
  });
  const visibleTeachers = () => teachers.filter(t =>
    (!search || (t.name+' '+t.subject).toLowerCase().includes(search.toLowerCase()))
    && (!subject || (t.subject || '未填学科') === subject)
  );
  const deptOf = (t) => prefs.teacherMeta?.[String(t.id)]?.department || '高中部';
  const noteOf = (t) => prefs.teacherMeta?.[String(t.id)]?.remark || '';
  const setTeacherMeta = async (t, patch) => {
    const teacherMeta = {...(prefs.teacherMeta || {}),[String(t.id)]:{...(prefs.teacherMeta?.[String(t.id)] || {}),...patch}};
    await savePrefs({teacherMeta});
  };

  const draftKey = type => [grade,date,period,type].join('|');
  const cloneAttendanceRow = row => ({...row,data:{...rowData(row)}});
  const getDraftRows = type => {
    const key=draftKey(type);
    if(!draftCache.has(key)){
      const source=(details[type]?.rows||[]).map(cloneAttendanceRow);
      let rows=[];
      if(type==='seat')rows=source;
      else if(type==='class')rows=source.filter(row=>(!!rowData(row).__classRecord
        && Number(rowData(row).__classRecord.period??period)===Number(period)) || rowData(row).__teacherGrid?.[String(period)]);
      else if(type==='research')rows=source.filter(row=>(!!rowData(row).__research
        && matchesAttendancePeriod(rowData(row).__research.period_time,period)) || rowData(row).__teacherGrid?.[String(period)]);
      draftCache.set(key,rows);
    }
    const rows=draftCache.get(key);
    if(type==='seat'){
      for(const teacher of teachers)if(!rows.some(row=>row.teacher===teacher.name))
        rows.push({teacher:teacher.name,subject:teacher.subject||'',data:{__periods:{}}});
    }else if(type==='class'){
      for(const teacher of teachers){
        const exists=rows.some(row=>!rowData(row).__deleted&&row.teacher===teacher.name
          && Number(rowData(row).__classRecord?.period??period)===Number(period));
        if(!exists)rows.push({teacher:teacher.name,subject:teacher.subject||'',data:{__classRecord:{
          class_name:'',period:Number(period),status:'u',listeners:[],remark:'',
        }}});
      }
    }else if(type==='research'){
      const subjects=[...new Set(teachers.map(item=>String(item.subject||'').trim()).filter(Boolean))];
      for(const subjectName of subjects){
        const exists=rows.some(row=>!rowData(row).__deleted
          && String(rowData(row).__research?.subject||row.subject||row.teacher||'').trim()===subjectName
          && matchesAttendancePeriod(rowData(row).__research?.period_time,period));
        if(!exists){
          const members=teachers.filter(item=>String(item.subject||'').trim()===subjectName).map(item=>item.name);
          rows.push({teacher:subjectName,subject:subjectName,data:{__research:{
            subject:subjectName,period_time:(period===0?'全天':'第'+period+'节'),location:'',host:'',
            expected:members.length,attendees:[],absent:members,status:'待登记',remark:'',
          }}});
        }
      }
    }
    return rows;
  };
  const mergeDraftRows = (type,table,draftRows) => {
    const rows=(table.rows||[]).map(cloneAttendanceRow);
    if(type==='seat'){
      for(const draft of draftRows){
        let target=rows.find(row=>row.teacher===draft.teacher);
        if(!target){target=cloneAttendanceRow(draft);rows.push(target);}
        const data=rowData(target),draftData=rowData(draft),periods={...(data.__periods||{})};
        const periodValue=draftData.__periods?.[String(period)]||{};
        periods[String(period)]={...(periods[String(period)]||{}),...periodValue};
        target.data={...data,__periods:periods};
      }
    }else if(type==='class'){
      for(const draft of draftRows){
        const draftData=rowData(draft),record=draftData.__classRecord;
        if(!record)continue;
        let target=draft.id?rows.find(row=>String(row.id)===String(draft.id)):null;
        if(!target&&!draft.__draftNew)target=rows.find(row=>row.teacher===draft.teacher
          && Number(rowData(row).__classRecord?.period??period)===Number(period)
          && String(rowData(row).__classRecord?.class_name||'')===String(record.class_name||''));
        if(draftData.__deleted){
          if(target)target.data={...rowData(target),__deleted:true};
          else if(draft.id)rows.push(cloneAttendanceRow(draft));
          continue;
        }
        if(!target&&!draft.__draftNew)target=rows.find(row=>row.teacher===draft.teacher
          && !rowData(row).__classRecord&&!rowData(row).__deleted);
        if(target)target.data={...rowData(target),__classRecord:{...record}};
        else{
          const added=cloneAttendanceRow(draft);delete added.__draftNew;rows.push(added);
        }
      }
    }else if(type==='research'){
      for(const draft of draftRows){
        const draftData=rowData(draft),record=draftData.__research;
        if(!record)continue;
        let target=draft.id?rows.find(row=>String(row.id)===String(draft.id)):null;
        if(!target)target=rows.find(row=>!!rowData(row).__research
          && String(rowData(row).__research.subject||row.subject||row.teacher||'').trim()===String(record.subject||'').trim()
          && matchesAttendancePeriod(rowData(row).__research.period_time,period));
        if(draftData.__deleted){if(target)target.data={...rowData(target),__deleted:true};continue;}
        if(target)target.data={...rowData(target),__research:{...record}};
        else rows.push(cloneAttendanceRow(draft));
      }
    }
    return mergeTeacherGridRows(rows,draftRows,period);
  };
  /* 表内登记的请假自动进请假总表：一个格子对应一条可追溯记录。
     清空格子删掉对应记录，手写的请假记录不受影响；同一个格子重复登记只更新不新增。 */
  const gridLeaveId = (tableId, person, atPeriod) => ['grid', tableId, atPeriod, String(person||'').trim()].join(':');
  /* 某位教师当前这一节生效的请假记录：请假表手写的整日记录、表内生成的分节记录都认，
     分节记录优先（它跟着这一节走）。请假时间列从这里回显。 */
  const leaveRecordOf = (teacher) => {
    const name = String(teacher?.name || '').trim();
    if (!name) return null;
    const scoped = activeLeavesFor(leaveRecords, date, grade).filter(record => {
      if (String(record.name || record.teacher || '').trim() !== name) return false;
      if (record.source !== 'grid') return true;
      const at = Number(record.source_period ?? 0);
      return at === 0 || at === Number(period);
    });
    return scoped.find(record => record.source === 'grid') || scoped[0] || null;
  };
  const leavesForSelection = (selectedDate = date) => activeLeavesFor(leaveRecords,selectedDate,grade).filter(record=>
    period===0 || record.source!=='grid' || Number(record.source_period)===0 || Number(record.source_period)===period);
  const syncGridLeaves = async (types) => {
    const next = new Map(leaveRecords.map(record => [String(record.id),record]));
    const seen = new Set(), sources = new Set();
    let changed = false;
    for(const type of types){
      const table=details[type];
      if(!table?.id)continue;
      sources.add(String(table.id));
      for(const row of table.rows||[]){
        const data=rowData(row);
        if(data.__deleted)continue;
        const teacher=allTeachers.find(item=>matchesGridTeacher(row,item));
        if(!teacher)continue;
        const mark=data.__teacherGrid?.[String(period)];
        const leaveType=String(mark?.leave||'').trim();
        if(!leaveType)continue;
        const id=gridLeaveId(table.id,teacher.name,period);
        const existing=next.get(id);
        seen.add(id);
        /* 请假时间（用户 11-24）：格子里填了小时/天/月就按它折算，没填按整天算。
           折算结果同时写进 days/hours/months，汇总和导出只认这几个字段。 */
        const time=normalizeLeaveTime(mark?.leave_time);
        const durationFields={
          days:time?time.days:1, hours:time?time.hours:0, months:time?time.months:0,
          duration_unit:time?time.duration_unit:'day', duration:time?time.amount:1,
          day_part:time?time.day_part:'',
          leave_time:time?{unit:time.unit,amount:time.amount,part:time.part}:null,
        };
        const sameTime=String(existing?.leave_time?JSON.stringify(existing.leave_time):'')
          ===String(durationFields.leave_time?JSON.stringify(durationFields.leave_time):'');
        if(existing?.type===leaveType&&sameTime)continue;
        next.set(id, existing ? {...existing,type:leaveType,...durationFields} : {
          id,grade,name:teacher.name,subject:teacher.subject||'',type:leaveType,
          start_date:date,end_date:date,...durationFields,status:'已批',remark:mark.remark||'',
          source:'grid',source_table:table.id,source_period:period,
        });
        changed=true;
      }
    }
    for (const [id,record] of next) {
      if (record.source!=='grid' || Number(record.source_period)!==period || !sources.has(String(record.source_table)) || seen.has(id)) continue;
      next.delete(id);
      changed = true;
    }
    if(changed){
      const leaves=[...next.values()];
      await savePrefs({leaves});
      leaveRecords=leaves;
    }
  };
  /* 在请假总表里改/删同步记录时，把表格格子一起改掉，避免下次回填又冒出来。 */
  const setGridLeaveMark = (record, leaveType) => queueSave(async () => {
    if(record?.source!=='grid')return;
    const type=['seat','class','research'].find(item=>String(details[item]?.id)===String(record.source_table));
    const atPeriod=String(record.source_period??'');
    if(!record.source_table||!atPeriod)return;
    const table=details[type] || await api.get('/attendance/'+record.source_table);
    const rows=(table.rows||[]).map(row=>({...row,data:{...rowData(row)}}));
    const row=rows.find(item=>!rowData(item).__deleted&&String(item.teacher||'').trim()===String(record.name||'').trim());
    if(!row)return;
    const grid={...(rowData(row).__teacherGrid||{})};
    grid[atPeriod]={...(grid[atPeriod]||{}),leave:leaveType||''};
    row.data={...rowData(row),__teacherGrid:grid};
    await saveRows(type,table,rows,{alignPeriod:false});
    if(type){
      details[type]={...table,rows};
      draftCache.delete([grade,date,atPeriod,type].join('|'));
    }
  });
  const persistDraft = async (type,{reload=true,key:overrideKey=null}={}) => queueSave(async () => {
    /* overrideKey：自动保存可能在用户切了日期/节次之后才触发，必须写回点击时
       那张草稿，否则会把改动写进新节次的空草稿里、旧改动丢掉。 */
    const key=overrideKey||draftKey(type),draftRows=draftCache.get(key)||getDraftRows(type),table=await getTable(type);
    const rows=mergeDraftRows(type,table,draftRows);
    await saveRows(type,table,rows);
    if(reload){
      draftCache.delete(key);
      await load();
    }else{
      /* 自动保存：不重载页面（每点一次都闪一下没法用），但要把刚写入的行同步回
         details 和草稿缓存，否则切页签回来会从旧数据重建草稿、刚点的状态丢掉。 */
      if(details[type])details[type]={...details[type],rows};
      draftCache.set(key,draftRows);
    }
  });
  /* 用户 11-12 裁决：去掉「保存本表」，点一下单元格就自动落盘。成功静默，
     只在失败时提示，避免每点一次弹一次「已保存」。 */
  let autoSaveTimer=null,pendingAutoSave=null,autoSaveInFlight=null;
  const flushAutoSave = async () => {
    clearTimeout(autoSaveTimer);
    while(autoSaveInFlight || pendingAutoSave){
      if(!autoSaveInFlight){
        const pending=pendingAutoSave;
        autoSaveInFlight=persistDraft(pending.type,{reload:false,key:pending.key})
          .then(()=>{if(pendingAutoSave===pending)pendingAutoSave=null;})
          .finally(()=>{autoSaveInFlight=null;});
      }
      await autoSaveInFlight;
    }
  };
  const flushBeforeSwitch = async () => {
    try{await flushAutoSave();return true;}
    catch(error){toast(attendanceErrorText(error),'err',4000);return false;}
  };
  const scheduleAutoSave = type => {
    clearTimeout(autoSaveTimer);
    pendingAutoSave={type,key:draftKey(type)};
    autoSaveTimer=setTimeout(()=>{void flushBeforeSwitch();},350);
  };
  const confirmTable = async (type, result) => {
    if(isMonthlySummary(type)){
      const {start}=attendanceSummaryMonthBounds(summaryMonth);
      let table=monthly.table;
      if(!table){
        const created=await createSlot({date:start,grade,type:'seat',period:'0'});
        table=await api.get('/attendance/'+created.id);
      }
      const header=await api.post('/attendance/'+table.id+'/confirm',{
        expected_updated_at:table.updated_at||'',workspace_result:{key:resultKey(type),...result},
      });
      monthly.table=syncHeader(null,table,header);
      if(String(details.seat?.id)===String(table.id))syncHeader('seat',details.seat,header);
      return;
    }
    const tableType=resultTableType(type);
    const table=details[tableType] || await getTable(tableType,{seedClass:false});
    const body={expected_updated_at:table.updated_at||'',workspace_result:{key:resultKey(type),...result}};
    if(type==='seat'){
      const rows=allTeachers.flatMap(teacher=>{
        const state=deriveTableGridState(teacher,'seat',table.rows||[],{date,period});
        if(!state.leave && !['sit','class','listen','research'].some(key=>state[key]==='y'||state[key]==='n'))return [];
        return [{id:String(teacher.id),class:state.class,listen:state.listen,research:state.research,leave:state.leave,remark:state.remark}];
      });
      body.workspace_snapshot={period,rows};
    }
    syncHeader(tableType,table,await api.post('/attendance/'+table.id+'/confirm',body));
  };
  const generateTable = async type => {
    /* 花名册没有考勤快照可生成：它的「确认生成」＝交回查看态并重拉一次名册，
       把编辑态里已经逐条落库的改动确认收口。 */
    if (type === 'roster') {
      await flushAutoSave();
      editingSheet = '';
      await load();
      toast('花名册已保存 · ' + grade + ' · ' + teachers.length + ' 位教师', 'ok');
      return;
    }
    await flushAutoSave();
    await queueSave(async () => {
      const existing = confirmedResult(type);
      if (existing && !isEditing(type) && !(type==='summary' && summaryDrafts.has(summaryDraftKey()))) return;
      if (type==='leave') await syncGridLeaves(['seat','research']);
      else if (TYPE[type]) await syncGridLeaves([type]);
      const rows = type==='leave' ? leavesForSelection() : type==='summary' ? summaryRows() : worksheetEntries(type,true);
      const grid = type==='summary' || type==='leave' ? undefined : sheetExportGrid(type,rows);
      await confirmTable(type,{rows,grid});
    });
    if(type==='summary')summaryDrafts.delete(summaryDraftKey());
    if(type==='leave')leaveOnlyDate=date;
    editingSheet='';
    paint();
    toast(SHEET_LABELS[type]+'已确认生成 · '+grade+' · '+(isMonthlySummary(type)?summaryMonth:date),'ok',4000);
  };
  /* 学科清单独立存储（prefs.subjectLists[年级]），再并上名册里实际用到的学科：
     刚新增、还没挂老师的学科也要能在筛选和登记表单里选到。 */
  const subjectList = () => [...new Set((Array.isArray(prefs.subjectLists?.[grade]) ? prefs.subjectLists[grade] : [])
    .map(item => String(item || '').trim()).filter(Boolean))];
  const saveSubjectList = async list => {
    const subjectLists = { ...(prefs.subjectLists || {}), [grade]: [...new Set(list.map(item => String(item || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')) };
    await savePrefs({ subjectLists });
  };
  const teacherSubjects = () => [...new Set([...subjectList(),
    ...[...teachers, ...(tab === 'leave' ? leaveRecords : [])].map(item => String(item.subject || '').trim())].filter(Boolean))].sort();
  /* 每个学科有多少位教师：科目下拉里直接带上人数，选之前就知道要记多少人。 */
  const subjectTeacherCounts = () => {
    const map=new Map();
    teachers.forEach(t=>{const key=String(t.subject||'').trim()||'未填学科';map.set(key,(map.get(key)||0)+1);});
    return map;
  };
  const teacherFiltersHtml = () => {
    const subjects=teacherSubjects(), counts=subjectTeacherCounts();
    /* 统一工具栏里学科筛选排在搜索框前面，六张表一致。 */
    return '<select id="aprd-subject"><option value="">全部学科（'+teachers.length+'）</option>'
      +subjects.map(item=>'<option value="'+esc(item)+'" '+(subject===item?'selected':'')+'>'+esc(item)+(counts.has(item)?'（'+counts.get(item)+'）':'')+'</option>').join('')
      +'</select>'
      +'<label class="aprd-search">'+icon('search',14)
      +'<input type="search" id="aprd-search" placeholder="搜索教师姓名" value="'+esc(search)+'"></label>'
      +'<i class="aprd-divider" aria-hidden="true"></i>';
  };
  const teacherAddCardHtml = () => {
    if(!showAddTeacher)return '';
    const subjects=[...new Set([...teacherSubjects(),...ROSTER_SUBJECTS])];
    const departments=[...new Set([
      ...(Array.isArray(prefs.departments?.[grade]) ? prefs.departments[grade] : []),
      ...teachers.map(item=>String(deptOf(item)||'').trim()),
      '高中部',
    ].filter(Boolean))];
    /* 三个输入框全部改成 combo（下拉候选 + 手动输入）：
       学科/年级/部门手输新值就地入清单，其他表候选同步；姓名输已有教师=编辑其资料（用户 11-25 要求）。 */
    return '<section class="aprd-roster-add-card" aria-label="新增教师">'
      +'<div class="aprd-roster-add-head"><div><h3>新增教师</h3><p>新增教师 / 学科 / 年级 / 部门，全部非必填；输入已有教师姓名则改为编辑其资料，其他表同步更新</p></div>'
      +'<span>当前年级：'+esc(grade)+'</span></div>'
      +'<form class="aprd-roster-add-form" id="aprd-roster-add-form">'
      +'<label>姓名<input name="name" type="text" list="aprd-name-list" placeholder="输入教师姓名（可选）" autocomplete="off">'
      +'<datalist id="aprd-name-list">'+teachers.map(item=>'<option value="'+escAttr(item.name)+'">'+esc(item.subject||'')+'</option>').join('')+'</datalist></label>'
      +'<label>学科<input name="subject" type="text" list="aprd-subject-list" placeholder="下拉选已有或直接输入新学科" autocomplete="off">'
      +'<datalist id="aprd-subject-list">'+subjects.map(item=>'<option value="'+escAttr(item)+'"></option>').join('')+'</datalist></label>'
      +'<label>归属年级<input name="grade" type="text" list="aprd-grade-list" value="'+esc(grade)+'" placeholder="可输入新年级" autocomplete="off">'
      +'<datalist id="aprd-grade-list">'+grades.map(item=>'<option value="'+escAttr(item)+'"></option>').join('')+'</datalist></label>'
      +'<label>归属部门<input name="department" type="text" list="aprd-dept-list" value="高中部" placeholder="可输入新部门" autocomplete="off">'
      +'<datalist id="aprd-dept-list">'+departments.map(item=>'<option value="'+escAttr(item)+'"></option>').join('')+'</datalist></label>'
      +'<div class="aprd-roster-add-actions"><button type="button" data-roster-add-cancel>取消</button><button type="submit" class="primary">保存</button></div>'
      +'</form></section>';
  };
  const saveDraftButton = (type,label) => '<button '+(details[type]?'':'disabled')+' data-save-'+type+'>'+(details[type]?label:'生成后可保存修改')+'</button>';
  const rosterKey = (row) => String(row.name || '').trim().replace(/\s+/g,'').toLowerCase() + '\u0000' + String(row.subject || '').trim().replace(/\s+/g,'').toLowerCase();
  const downloadRosterTemplate = () => {
    const grid=[['教师花名册导入模板'],['序号','归属部门','归属年级','姓名','学科'],['1','高中部',grade,'','']];
    saveBlob(makeXlsx({title:'花名册导入模板',grid}),'教师花名册导入模板.xlsx');
  };
  /* 水印：斜向平铺的浅色文字，压在最上层但不遮挡内容（透明度很低）。
     只有导出时打开了「带水印」才会画。 */
  const paintWatermark = (ctx, width, height, text) => {
    const label = String(text || '').trim();
    if (!label) return;
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#172744';
    ctx.font = 'bold 20px "Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-Math.PI / 9);
    const step = Math.max(200, label.length * 22 + 90);
    const halfW = Math.max(width, height), halfH = halfW;
    for (let y = -halfH; y <= halfH; y += 116) {
      for (let x = -halfW; x <= halfW; x += step) ctx.fillText(label, x, y);
    }
    ctx.restore();
  };
  /* 把导出网格切成图片：三级标题居中（表名 / 日期节次时段 / 人数统计），
     底部左侧写条数和页码、右下角写导出时间（用户 11-15 要求）。
     常规年级（120 行以内）就是一张图，只有超大名单才分页。 */
  const buildPngPages = (grid, fileBase, rowCount, watermark = '', exportTime = '') => {
    const {headings, headers, rows: bodyRows} = splitAttendanceExportGrid(grid);
    const title=String(headings[0]||fileBase),subtitle=String(headings[1]||''),stats=String(headings[2]||'');
    const widths=headers.map((header,index)=>{
      const max=Math.max(String(header).length,...bodyRows.map(row=>String(row[index]??'').length));
      return Math.max(96,Math.min(280,76+max*15));
    });
    const totalWidth=widths.reduce((sum,value)=>sum+value,0);
    const headingBlocks=[];
    if(title)headingBlocks.push({text:title,font:'bold 24px "Microsoft YaHei",sans-serif',color:'#10203a',gap:28});
    if(subtitle)headingBlocks.push({text:subtitle,font:'600 14px "Microsoft YaHei",sans-serif',color:'#16263c',gap:26});
    if(stats)headingBlocks.push({text:stats,font:'12.5px "Microsoft YaHei",sans-serif',color:'#2b3b53',gap:26});
    /* 抬头区高度按实际标题行数算：标题 46 起步，行距 28/26/26，底部留 6 */
    const rowH=48,titleH=headingBlocks.length?46+headingBlocks.reduce((sum,block)=>sum+block.gap,0)+6:26,footH=44,rowsPerPage=60;
    /* 表格字体：楷体 18 号（用户 11-19 要求），行高同步放大保证不挤压 */
    const tableFont='18px KaiTi,"KaiTi_GB2312","楷体",serif';
    const pages=[];
    for(const page of paginateExportGrid(grid, rowsPerPage)){
      const slice=page.rows, pageCount=page.pageCount, pageIndex=page.index;
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
      /* 以 2 倍像素渲染：导出图放大查看时文字仍清晰（用户 11-19 反馈放大后模糊） */
      const pixelScale=2;
      const W=Math.max(totalWidth,520);
      const H=titleH+(slice.length+1)*rowH+footH;
      canvas.width=Math.round(W*pixelScale);
      canvas.height=Math.round(H*pixelScale);
      ctx.scale(pixelScale,pixelScale);
      ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
      ctx.textAlign='center';
      let lineY=46;
      headingBlocks.forEach(block=>{
        ctx.fillStyle=block.color;ctx.font=block.font;
        ctx.fillText(block.text,W/2,lineY);
        lineY+=block.gap;
      });
      if(headingBlocks.length){
        ctx.strokeStyle='#dfe7f2';ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(0,titleH-1.5);ctx.lineTo(W,titleH-1.5);ctx.stroke();
      }
      ctx.textAlign='left';
      let y=titleH,x=0;
      headers.forEach((label,index)=>{
        ctx.fillStyle='#eef3fa';ctx.fillRect(x,y,widths[index],rowH);
        ctx.strokeStyle='#b7c6db';ctx.lineWidth=1.4;
        ctx.strokeRect(x+0.7,y+0.7,widths[index]-1.4,rowH-1.4);
        ctx.fillStyle='#000';ctx.font='bold '+tableFont;
        ctx.textAlign='center';
        ctx.fillText(String(label),x+widths[index]/2,y+31);x+=widths[index];
      });
      slice.forEach((row,rowIndex)=>{
        y+=rowH;x=0;
        row.forEach((value,index)=>{
          ctx.fillStyle=rowIndex%2?'#f9fbfe':'#fff';ctx.fillRect(x,y,widths[index],rowH);
          ctx.strokeStyle='#cbd7e7';ctx.lineWidth=1.2;
          ctx.strokeRect(x+0.6,y+0.6,widths[index]-1.2,rowH-1.2);
          ctx.fillStyle='#000';ctx.font=tableFont;
          ctx.textAlign='center';
          ctx.fillText(String(value??'').slice(0,32),x+widths[index]/2,y+31);x+=widths[index];
        });
      });
      ctx.strokeStyle='#9fb1ca';ctx.lineWidth=2;
      ctx.strokeRect(1,titleH+1,Math.min(totalWidth,W)-2,(slice.length+1)*rowH-2);
      ctx.fillStyle='#8290a5';ctx.font='11px "Microsoft YaHei",sans-serif';ctx.textAlign='left';
      ctx.fillText((pageCount>1?'第 '+(pageIndex+1)+' / '+pageCount+' 页 · ':'')+'共 '+rowCount+' 条',20,H-16);
      if(exportTime){
        ctx.textAlign='right';
        ctx.fillText('导出时间：'+exportTime,W-20,H-16);
      }
      paintWatermark(ctx,W,H,watermark);
      pages.push(canvas.toDataURL('image/png'));
    }
    return pages;
  };
  const openPngPreview = (pages, fileBase, rowCount, stats = '', exportTime = '') => {
    const dialog=document.createElement('div');
    dialog.className='attendance-prd aprd-dialog aprd-png-dialog';
    const chips=[
      '<span class="aprd-chip"><b>'+rowCount+'</b> 条记录</span>',
      stats?'<span class="aprd-chip">'+esc(stats)+'</span>':'',
      exportTime?'<span class="aprd-chip muted">导出时间 '+esc(exportTime)+'</span>':'',
      pages.length>1?'<span class="aprd-chip">共 '+pages.length+' 张图片</span>':'',
    ].filter(Boolean).join('');
    dialog.innerHTML='<section class="aprd-png-preview">'
      +'<header><div class="aprd-png-head"><span class="aprd-png-badge">PNG</span>'
      +'<div><h3>导出预览</h3><p>'+esc(fileBase)+'</p></div></div>'
      +'<button type="button" data-png-close aria-label="关闭">×</button></header>'
      +'<div class="aprd-png-meta">'+chips
      +'<span class="aprd-png-hint">滑动查看，确认无误后保存图片</span>'
      +'<div class="aprd-png-zoom"><button type="button" data-png-zoom="-1" aria-label="缩小">−</button>'
      +'<span data-png-zoom-label>适应宽度</span>'
      +'<button type="button" data-png-zoom="1" aria-label="放大">＋</button></div></div>'
      +'<div class="aprd-png-scroll">'+pages.map((src,index)=>'<figure><img src="'+src+'" alt="第 '+(index+1)+' 页" draggable="false">'+(pages.length>1?'<figcaption>第 '+(index+1)+' / '+pages.length+' 页</figcaption>':'')+'</figure>').join('')+'</div>'
      +'<footer><button type="button" data-png-close>关闭</button>'
      +'<button type="button" class="primary" data-png-download>'+(pages.length>1?'下载全部图片（'+pages.length+' 张）':'保存图片')+'</button></footer></section>';
    document.body.append(dialog);
    const close=()=>{dialog.remove();document.removeEventListener('keydown',onKey);};
    const onKey=event=>{if(event.key==='Escape')close();};
    document.addEventListener('keydown',onKey);
    /* 放大后要能逐格核对数据：缩放只作用于图片本身，
       容器负责横向/纵向滚动，按住图片可直接拖动平移，便于查看某一行的具体状态。 */
    const scroll=dialog.querySelector('.aprd-png-scroll');
    const zoomLabel=dialog.querySelector('[data-png-zoom-label]');
    const zoomOutButton=dialog.querySelector('[data-png-zoom="-1"]');
    const zoomInButton=dialog.querySelector('[data-png-zoom="1"]');
    const zoomSteps=[1,1.5,2,2.5,3];
    let zoom=1;
    const syncZoom=()=>{
      scroll.style.setProperty('--png-zoom',String(zoom));
      zoomLabel.textContent=zoom===1?'适应宽度':Math.round(zoom*100)+'%';
      zoomOutButton.disabled=zoom===1;
      zoomInButton.disabled=zoom===zoomSteps[zoomSteps.length-1];
      scroll.classList.toggle('is-zoomed',zoom>1);
    };
    const stepZoom=direction=>{
      const index=zoomSteps.indexOf(zoom);
      zoom=zoomSteps[Math.max(0,Math.min(zoomSteps.length-1,index+direction))];
      syncZoom();
    };
    zoomOutButton.addEventListener('click',()=>stepZoom(-1));
    zoomInButton.addEventListener('click',()=>stepZoom(1));
    syncZoom();
    let panning=null;
    scroll.addEventListener('pointerdown',event=>{
      if(zoom===1||event.button!==0)return;
      panning={x:event.clientX,y:event.clientY,left:scroll.scrollLeft,top:scroll.scrollTop};
      scroll.classList.add('is-panning');
      scroll.setPointerCapture(event.pointerId);
    });
    scroll.addEventListener('pointermove',event=>{
      if(!panning)return;
      scroll.scrollLeft=panning.left-(event.clientX-panning.x);
      scroll.scrollTop=panning.top-(event.clientY-panning.y);
    });
    const endPan=()=>{panning=null;scroll.classList.remove('is-panning');};
    scroll.addEventListener('pointerup',endPan);
    scroll.addEventListener('pointercancel',endPan);
    dialog.querySelectorAll('[data-png-close]').forEach(button=>button.addEventListener('click',close));
    dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
    dialog.querySelector('[data-png-download]').addEventListener('click',async()=>{
      const button=dialog.querySelector('[data-png-download]');
      button.disabled=true;
      try{
        for(let index=0;index<pages.length;index+=1){
          const blob=await (await fetch(pages[index])).blob();
          saveBlob(blob,fileBase+(pages.length>1?'（第'+(index+1)+'页）':'')+'.png');
          if(index<pages.length-1)await new Promise(resolve=>setTimeout(resolve,400));
        }
        toast(pages.length>1?'已导出 '+pages.length+' 张图片':'图片已保存','ok');
      }catch(error){toast(error.message||'图片下载失败','err');}
      finally{button.disabled=false;}
    });
  };
  const sheetExportGrid = (type, entries) => buildAttendanceExportGrid({
    type, grade, date, period: type==='summary' ? 0 : period, teachers,
    seatRows: getDraftRows('seat'),
    classRows: getDraftRows('class'),
    researchRows: getDraftRows('research'),
    leaveRecords: type==='leave' ? entries : activeLeavesFor(leaveRecords,date,grade),
    teacherMeta: prefs.teacherMeta || {},
    resolvePeriodRange,
    includeUnlisted: true,
    worksheetEntries: type==='class'||type==='research' ? entries : null,
    summaryRows: type==='summary' ? entries : null,
    summaryMonth: isMonthlySummary(type) ? summaryMonth : '',
  });
  const exportRoster = (format) => {
    const exportType = currentExportType();
    const typeLabel = SHEET_LABELS[exportType] || '花名册';
    const periodText = isMonthlySummary(exportType) ? '月汇总'
      : exportType==='summary' ? '日汇总' : period===0 ? '全天' : '第'+period+'节';
    const fileBase=(grade||'教师')+typeLabel+'-'+(isMonthlySummary(exportType)?summaryMonth:date)+'-'+periodText;
    const watermarkBox=root.querySelector('#aprd-export-watermark');
    const watermarkInput=root.querySelector('#aprd-export-watermark-text');
    watermarkOn=!!watermarkBox?.checked;
    watermarkText=String(watermarkInput?.value||'').trim();
    const watermark=watermarkOn?(watermarkText||((grade||'')+typeLabel)):'';
    const result = isEditing(exportType) || (exportType==='leave' && !leaveOnlyDate) ? null : confirmedResult(exportType);
    const entries = exportType==='summary' ? summaryRows() : exportType==='leave'
      ? (result?.rows ?? leavesForSelection())
      : TYPE[exportType] && worksheetEntries(exportType,isEditing(exportType));
    const grid = (exportType==='summary'?null:result?.grid) || sheetExportGrid(exportType,entries);
    const {headings, headers, rows} = splitAttendanceExportGrid(grid);
    const rowCount = rows.length;
    if(!rowCount){toast('当前表格没有符合条件的记录','warn');return;}
    /* 导出时间放右下角（用户 11-15 要求）：
       Excel/CSV 追加一行写在最右列，PNG 画在图片右下角，PDF 放在表格末尾右对齐。 */
    const now=new Date(),pad=value=>String(value).padStart(2,'0');
    const exportTime=now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate())
      +' '+pad(now.getHours())+':'+pad(now.getMinutes())+':'+pad(now.getSeconds());
    const timeText='导出时间：'+exportTime;
    const withFooter=()=>{
      const footer=Array.from({length:Math.max(1,headers.length)},()=>'');
      footer[footer.length-1]=timeText;
      return [...grid,footer];
    };
    if(format==='xlsx'){
      /* center:true —— 导出表格全部居中、抬头跨列合并（用户 11-24 需求）：
         PNG/PDF 早就居中了，Excel 之前一直左对齐，三套导出观感不一致。 */
      saveBlob(makeXlsx({title:fileBase,grid:withFooter(),center:true}),fileBase+'.xlsx');
      toast('已导出 '+fileBase+'.xlsx','ok');
    }else if(format==='csv'){
      const csv='\uFEFF'+withFooter().map(row=>row.map(value=>'"'+String(value??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');
      saveBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),fileBase+'.csv');
      toast('已导出 '+fileBase+'.csv','ok');
    }else if(format==='pdf'){
      const win=window.open('','_blank');
      if(!win){toast('浏览器拦截了打印窗口，请允许本站弹出窗口后重试','warn');return;}
      const headingHtml='<h1>'+esc(headings[0]||fileBase)+'</h1>'
        +(headings[1]?'<p class="aprd-print-sub">'+esc(headings[1])+'</p>':'')
        +(headings[2]?'<p class="aprd-print-stats">'+esc(headings[2])+'</p>':'');
      const body=rows.map(row=>'<tr>'+row.map(cell=>'<td>'+esc(cell)+'</td>').join('')+'</tr>').join('');
      const watermarkHtml=watermark?'<div class="aprd-print-watermark">'+esc(watermark)+'</div>':'';
      win.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+esc(fileBase)+'</title><style>'
        +'body{font-family:"Microsoft YaHei",Arial,sans-serif;padding:26px 28px;color:#1d2939}'
        +'h1{font-size:22px;text-align:center;margin:0 0 10px;letter-spacing:.5px;color:#10203a}'
        +'h1::after{content:"";display:block;width:116px;height:2.5px;background:#2a6bf2;margin:9px auto 0}'
        +'.aprd-print-sub{color:#1f3550;font-size:13.5px;font-weight:600;text-align:center;margin:0 0 6px}'
        +'.aprd-print-stats{color:#40536e;font-size:12.5px;text-align:center;margin:0 0 14px;padding-top:2px;border-top:0}'
        +'table{width:100%;border-collapse:collapse;font-size:12px;border:2px solid #9fb1ca}'
        +'th,td{border:1px solid #b7c6db;padding:7px 8px;text-align:center}'
        +'th{background:#f2f4f7;color:#344054;border-color:#a9bad2}'
        +'.aprd-print-foot{margin-top:14px;text-align:right;color:#667085;font-size:11.5px}'
        +'.aprd-print-watermark{position:fixed;inset:0;display:grid;place-items:center;font-size:64px;font-weight:800;color:rgba(23,39,68,.09);transform:rotate(-24deg);pointer-events:none;white-space:nowrap;z-index:99}'
        +'@media print{body{padding:0}}</style>'+watermarkHtml
        +headingHtml+'<table><thead><tr>'+headers.map(cell=>'<th>'+esc(cell)+'</th>').join('')+'</tr></thead><tbody>'+body+'</tbody></table>'
        +'<div class="aprd-print-foot">'+esc(timeText)+'</div>'
        +'<script>window.onload=function(){window.print()}<\\/script></html>');
      win.document.close();
      toast('已打开打印预览，可在弹窗里另存为 PDF','ok');
    }else if(format==='png'){
      /* 默认一个年级就是一张图（120 行以内不分页），先给可滚动的预览，
         确认后再下载，内容和页面表格逐格一致。 */
      const pages=buildPngPages(grid, fileBase, rowCount, watermark, exportTime);
      toast('图片已生成'+(pages.length>1?'，共 '+pages.length+' 张':''),'ok');
      openPngPreview(pages, fileBase, rowCount, headings[2]||'', exportTime);
    }
    const menu=root.querySelector('[data-roster-export-menu]');if(menu)menu.hidden=true;
  };
  const openRosterImport = () => {
    const dialog=document.createElement('div');dialog.className='attendance-prd aprd-dialog aprd-roster-dialog';
    dialog.innerHTML='<section class="aprd-roster-import">'
      +'<header><div class="aprd-import-head"><span class="aprd-import-badge">批量导入</span>'
      +'<div><h3>导入教师名单</h3><p>目标年级 <b>'+esc(grade)+'</b> · 先识别预览，确认后才写入花名册，原有考勤记录不会被覆盖</p></div></div>'
      +'<button type="button" data-import-close aria-label="关闭">×</button></header>'
      +'<div class="aprd-import-body">'
      +'<ol class="aprd-import-steps"><li class="on"><i>1</i>选择名单</li><li><i>2</i>核对预览</li><li><i>3</i>确认导入</li></ol>'
      +'<div class="aprd-import-sources">'
      +'<section class="aprd-import-card aprd-upload-zone">'
      +'<div class="aprd-import-card-head"><span class="aprd-import-num">1</span><div><b>上传名单文件</b><small>XLSX / XLS / CSV / PDF / JPG / PNG / WebP</small></div></div>'
      +'<input id="aprd-import-file" type="file" accept=".xlsx,.xls,.xlsm,.csv,.tsv,.txt,.pdf,.png,.jpg,.jpeg,.webp">'
      +'<span class="aprd-upload-icon">↑</span>'
      +'<p class="aprd-upload-title">把文件拖到这里，或点击选择文件</p>'
      +'<button type="button" data-import-browse>选择文件</button>'
      +'<small class="aprd-upload-note">上传后自动识别姓名、学科等列，识别结果可逐项修改</small>'
      +'</section>'
      +'<section class="aprd-import-card aprd-import-paste">'
      +'<div class="aprd-import-card-head"><span class="aprd-import-num">2</span><div><b>粘贴 Excel 表格</b><small>从表格里直接复制姓名、学科等列</small></div></div>'
      +'<label class="aprd-visually-hidden" for="aprd-import-text">粘贴 Excel 表格内容</label>'
      +'<textarea id="aprd-import-text" rows="4" placeholder="复制 Excel 中的姓名、学科等列，然后粘贴到这里…"></textarea>'
      +'<div class="aprd-import-paste-actions"><button type="button" data-import-template>下载 Excel 模板</button><button type="button" class="primary" data-import-paste>解析粘贴内容</button></div>'
      +'</section></div>'
      +'<div class="aprd-import-status" id="aprd-import-status" role="status">上传后会先识别并显示预览，只有点击「确认导入」才会写入花名册。</div>'
      +'<div class="aprd-import-warnings" id="aprd-import-warnings" hidden></div>'
      +'<div class="aprd-import-preview" id="aprd-import-preview" hidden>'
      +'<div class="aprd-import-preview-head"><b>名单预览</b><span>核对姓名、学科与处理方式后确认导入</span></div>'
      +'<div class="aprd-import-summary" id="aprd-import-summary"></div>'
      +'<div class="aprd-import-table-wrap"><table><thead><tr><th>序号</th><th>姓名</th><th>学科</th><th>归属部门</th><th>来源年级</th><th>处理方式</th></tr></thead><tbody id="aprd-import-rows"></tbody></table></div>'
      +'</div></div>'
      +'<footer><span class="aprd-import-foot-note">导入后可在花名册继续维护</span>'
      +'<div class="aprd-import-foot-actions"><button type="button" data-import-close>取消</button><button type="button" class="primary" data-import-confirm disabled>确认导入</button></div></footer>'
      +'</section>';
    document.body.append(dialog);
    let importRows=[];
    const $=(selector)=>dialog.querySelector(selector);
    const close=()=>{dialog.remove();document.removeEventListener('keydown',onDialogKeydown);};
    const onDialogKeydown=(event)=>{if(event.key==='Escape')close();};
    document.addEventListener('keydown',onDialogKeydown);
    dialog.addEventListener('click',(event)=>{if(event.target===dialog)close();});
    dialog.querySelectorAll('[data-import-close]').forEach(button=>button.onclick=close);
    $('[data-import-template]').onclick=downloadRosterTemplate;
    const updateStatus=(message)=>{$('#aprd-import-status').textContent=message;};
    const refreshDuplicates=()=>{
      const seen=new Set();
      importRows=importRows.map((row)=>{
        const key=rosterKey(row);
        const inFile=!!key&&seen.has(key);
        if(key)seen.add(key);
        const existing=allTeachers.find(t=>!t.deleted_at&&rosterKey(t)===key);
        let duplicateKind=inFile?'file':existing?'existing':'';
        let action=row.action||(key?'add':'skip');
        if(inFile)action='skip';
        else if(existing){if(action==='add')action='skip';}
        else if(!key)action='skip';
        else if(action!=='skip')action='add';
        return {...row,duplicateKind,duplicateId:existing?.id||null,action};
      });
    };
    const renderPreview=()=>{
      refreshDuplicates();
      const preview=$('#aprd-import-preview');
      preview.hidden=false;
      const completeRow=row=>String(row.name||'').trim()&&String(row.subject||'').trim();
      const incomplete=importRows.filter(row=>!completeRow(row)).length;
      const invalid=importRows.filter(row=>row.action!=='skip'&&!completeRow(row)).length;
      const additions=importRows.filter(row=>row.action==='add'&&completeRow(row)).length;
      const updates=importRows.filter(row=>row.action==='update'&&completeRow(row)).length;
      const skipped=importRows.filter(row=>row.action==='skip').length;
      $('#aprd-import-summary').innerHTML='<span class="aprd-chip total">识别 <b>'+importRows.length+'</b> 条</span>'
        +'<span class="aprd-chip add">新增 <b>'+additions+'</b></span>'
        +'<span class="aprd-chip update">更新 <b>'+updates+'</b></span>'
        +'<span class="aprd-chip skip">跳过 <b>'+skipped+'</b></span>'
        +(incomplete?'<span class="aprd-chip warn">'+incomplete+' 条待补全</span>':'');
      const steps=dialog.querySelectorAll('.aprd-import-steps li');
      if(steps[1])steps[1].classList.add('on');
      $('#aprd-import-warnings').hidden=!importWarnings.length;
      $('#aprd-import-warnings').textContent=importWarnings.join('；');
      $('#aprd-import-rows').innerHTML=importRows.map((row,index)=>{
        const status=row.duplicateKind==='file'?'文件内重复':row.duplicateKind==='existing'?'名册已存在':(!row.name||!row.subject?'信息不完整':'可导入');
        const options=row.duplicateKind==='file'?'<option value="skip" selected>跳过重复行</option>':row.duplicateKind==='existing'?'<option value="skip" '+(row.action==='skip'?'selected':'')+'>跳过已存在</option><option value="update" '+(row.action==='update'?'selected':'')+'>更新已有人员</option>':'<option value="add" '+(row.action==='add'?'selected':'')+'>新增人员</option><option value="skip" '+(row.action==='skip'?'selected':'')+'>跳过此行</option>';
        return '<tr><td>'+esc(row.serial||index+1)+'</td><td><input data-import-field="name" data-index="'+index+'" value="'+esc(row.name||'')+'" aria-label="姓名"></td><td><input data-import-field="subject" data-index="'+index+'" value="'+esc(row.subject||'')+'" aria-label="学科"></td><td><input data-import-field="department" data-index="'+index+'" value="'+esc(row.department||'')+'" aria-label="归属部门" placeholder="高中部"></td><td>'+esc(row.grade||grade)+'</td><td><select data-import-action="'+index+'">'+options+'</select><small class="aprd-import-row-status">'+status+'</small></td></tr>';
      }).join('');
      $('[data-import-confirm]').disabled=!importRows.some(row=>row.action!=='skip'&&String(row.name||'').trim()&&String(row.subject||'').trim());
    };
    let importWarnings=[];
    const acceptParsed=(result)=>{
      importRows=(result.rows||[]).map((row,index)=>({...row,serial:row.serial||index+1,action:row.name&&row.subject?'add':'skip'}));
      importWarnings=[...(result.warnings||[])];
      if(result.grade&&result.grade!==grade)importWarnings.unshift('文件标题识别到'+result.grade+'，当前导入目标为'+grade+'；请确认名单属于当前年级。');
      renderPreview();
    };
    const parseFile=async(file)=>{
      if(!file)return;
      updateStatus('正在解析 '+file.name+'…');
      $('[data-import-confirm]').disabled=true;
      try{
        const result=await parseRosterFile(file,grade,updateStatus);
        acceptParsed(result);
        const recognizedCount=Number.isFinite(Number(result.recognizedCount))?Number(result.recognizedCount):result.rows.length;
        const expectedCount=Number(result.expectedCount)||result.rows.length;
        updateStatus(recognizedCount<expectedCount
          ? '识别完成：有效识别 '+recognizedCount+' / '+expectedCount+' 条，缺失项已保留，请逐项补全或跳过。'
          : '识别完成：'+recognizedCount+' 条，请逐项核对后确认导入。');
      }catch(error){updateStatus(error.message||'文件解析失败');toast(error.message||'文件解析失败','err');}
    };
    const fileInput=$('#aprd-import-file');
    $('[data-import-browse]').addEventListener('click',(event)=>{event.preventDefault();fileInput.click();});
    $('.aprd-upload-zone').addEventListener('click',(event)=>{if(!event.target.closest('[data-import-browse]'))fileInput.click();});
    fileInput.onchange=()=>{const file=fileInput.files?.[0];fileInput.value='';if(file)parseFile(file);};
    $('[data-import-paste]').onclick=async()=>{
      const text=$('#aprd-import-text').value.trim();
      if(!text){toast('请先粘贴 Excel 表格内容','warn');return;}
      updateStatus('正在解析粘贴的表格…');
      try{acceptParsed(await parseRosterText(text,grade));updateStatus('解析完成，请检查预览后确认导入。');}
      catch(error){updateStatus(error.message||'粘贴内容解析失败');toast(error.message||'解析失败','err');}
    };
    $('#aprd-import-rows').addEventListener('input',(event)=>{
      const input=event.target.closest('[data-import-field]');
      if(!input)return;
      const index=Number(input.dataset.index),field=input.dataset.importField;
      if(importRows[index])importRows[index][field]=input.value;
    });
    $('#aprd-import-rows').addEventListener('change',(event)=>{
      const action=event.target.closest('[data-import-action]');
      if(action){const row=importRows[Number(action.dataset.importAction)];if(row)row.action=action.value;renderPreview();return;}
      const field=event.target.closest('[data-import-field]');
      if(field&&['name','subject'].includes(field.dataset.importField))renderPreview();
    });
    $('[data-import-confirm]').onclick=async()=>{
      refreshDuplicates();
      const selected=importRows.filter(row=>row.action!=='skip');
      const invalid=selected.filter(row=>!String(row.name||'').trim()||!String(row.subject||'').trim());
      if(invalid.length){toast('请先补全 '+invalid.length+' 条记录的姓名和学科，或将其设为跳过','warn');return;}
      const additions=selected.filter(row=>row.action==='add');
      const updates=selected.filter(row=>row.action==='update'&&row.duplicateId);
      try{
        $('[data-import-confirm]').disabled=true;
        updateStatus('正在写入教师名单…');
        const steps=dialog.querySelectorAll('.aprd-import-steps li');
        if(steps[2])steps[2].classList.add('on');
        let addedIds=[];
        if(additions.length){
          const result=await api.post('/teachers',{grade,items:additions.map(row=>({name:row.name,subject:row.subject}))});
          addedIds=Array.isArray(result?.ids)?result.ids:[];
        }
        for(const row of updates){
          await api.patch('/teachers/'+row.duplicateId,{name:row.name,subject:row.subject,active:1});
        }
        const teacherMeta={...(prefs.teacherMeta||{})};
        additions.forEach((row,index)=>{
          const id=addedIds[index];
          if(id&&(row.department||''))teacherMeta[String(id)]={...(teacherMeta[String(id)]||{}),department:row.department};
        });
        updates.forEach(row=>{
          if(row.department)teacherMeta[String(row.duplicateId)]={...(teacherMeta[String(row.duplicateId)]||{}),department:row.department};
        });
        if(JSON.stringify(teacherMeta)!==JSON.stringify(prefs.teacherMeta||{}))await savePrefs({teacherMeta});
        if(additions.length || updates.length)editConfirmedSheet();
        close();
        await load();
        toast('导入完成：新增 '+additions.length+' 人，更新 '+updates.length+' 人，跳过 '+(importRows.length-additions.length-updates.length)+' 人','ok',3600);
      }catch(error){
        $('[data-import-confirm]').disabled=false;
        updateStatus(error.message||'导入失败，请检查名单后重试');
        toast(error.message||'导入失败','err');
      }
    };
  };

  const openEditor = (title, fields, initial, onSave) => {
    const dialog = document.createElement('div'); dialog.className='aprd-dialog';
    dialog.innerHTML = '<form class="aprd-editor"><h3>'+esc(title)+'</h3>'+
      fields.map(f=>{
        const value=initial[f.key]??'';
        const required=f.required?' required':'';
        const input=f.type==='select'?'<select name="'+escAttr(f.key)+'"'+required+'>'+f.options.map(o=>'<option '+(String(value)===String(o.value)?'selected':'')+' value="'+escAttr(o.value)+'">'+esc(o.label)+'</option>').join('')+'</select>'
          :f.type==='textarea'?'<textarea name="'+escAttr(f.key)+'">'+esc(value)+'</textarea>'
          /* combo：输入框 + datalist 候选。既能下拉选已有值，也能手动输入新值（用户 11-25 要求）。 */
          :f.type==='combo'?'<input name="'+escAttr(f.key)+'" type="text" list="'+escAttr(f.key)+'-list" value="'+escAttr(value)+'"'+required+' autocomplete="off">'
            +'<datalist id="'+escAttr(f.key)+'-list">'+(f.options||[]).map(o=>'<option value="'+escAttr(o.value??o)+'">'+esc(o.label??'')+'</option>').join('')+'</datalist>'
          :'<input name="'+escAttr(f.key)+'" type="'+(f.type||'text')+'" value="'+escAttr(value)+'"'+required+(f.min!==undefined?' min="'+f.min+'"':'')+(f.step?' step="'+f.step+'"':'')+'>';
        return '<label>'+esc(f.label)+input+'</label>';
      }).join('')+
      '<div class="aprd-foot"><button type="button" data-cancel>取消</button><button class="primary" type="submit">保存</button></div></form>';
    (root.querySelector('.attendance-prd') || root).append(dialog); const form=dialog.querySelector('form');
    classPicker(form.elements.namedItem('class_name'), { courses: timetableCourses, qualified: true });
    /* 时长单位=天 时，时长换成作息表的 24 小时钟点段；小时/月仍用数字（用户 11-22 要求，不再分上午下午） */
    const durationUnit=form.querySelector('[name="duration_unit"]');
    const durationInput=form.querySelector('[name="days"]');
    if(durationUnit&&durationInput){
      const parts=leaveDayParts();
      const dayPart=document.createElement('select');
      dayPart.name='day_part';dayPart.hidden=true;
      dayPart.innerHTML=parts.map(part=>'<option value="'+escAttr(part.label)+'">'+esc(part.label+'（'+part.days+'天）')+'</option>').join('');
      if(initial.day_part)dayPart.value=leaveDayPartLabel(initial.day_part);
      durationInput.after(dayPart);
      const syncDurationMode=()=>{
        const byDay=durationUnit.value==='day';
        durationInput.hidden=byDay;durationInput.disabled=byDay;
        dayPart.hidden=!byDay;dayPart.disabled=!byDay;
      };
      durationUnit.addEventListener('change',syncDurationMode);
      syncDurationMode();
    }
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.remove();
    form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));try{await onSave(data);dialog.remove();}catch(err){toast(err.message||'保存失败','err');}};
  };
  const editLeaveRecord = (record = null, defaultTeacher = null) => {
    const recordName=record?.name||record?.teacher||'';
    const unitOf=record?.duration_unit==='month'?'month':record?.duration_unit==='hour'?'hour':'day';
    /* 历史数据存的「上午/下午/整天」编辑时统一回显成作息表钟点段（用户 11-22 要求） */
    const dayParts = leaveDayParts();
    const legacyUnitPart = record?.duration_unit === 'morning' ? dayParts[0].label
      : record?.duration_unit === 'afternoon' ? dayParts[1].label : '';
    const dayPartOf = leaveDayPartLabel(record?.day_part) || legacyUnitPart
      || (Number(record?.days ?? record?.duration ?? 1) >= 1 ? dayParts[2].label : dayParts[0].label);
    const amountOf=unitOf==='day'?dayPartOf:(record?.months??record?.hours??record?.duration??1);
    openEditor(record?'修改请假记录':'登记请假',[
      /* 教师直接手输：全校名单太长，下拉翻半天反而慢 */
      {key:'teacher',label:'教师姓名',type:'text',required:true},
      {key:'type',label:'类型',type:'select',options:[{value:'',label:'无（取消请假）'},...LEAVE_TYPES.map(x=>({value:x,label:x}))]},
      {key:'start_date',label:'开始日期',type:'date'},
      {key:'end_date',label:'结束日期',type:'date'},
      /* 时长单位放在时长上方，支持 小时/天/月；天用 上午/下午/1天（用户 11-15 要求），状态不再让用户选 */
      {key:'duration_unit',label:'时长单位',type:'select',options:[
        {value:'hour',label:'小时'},
        {value:'day',label:'天'},
        {value:'month',label:'月'},
      ]},
      {key:'days',label:'请假时长',type:'number',min:'0.01',step:'any'},
      {key:'remark',label:'备注',type:'textarea'},
    ],{
      teacher:recordName||defaultTeacher?.name||'',
      type:record?.type||'',start_date:record?.start_date||date,end_date:record?.end_date||date,
      days:amountOf,duration_unit:unitOf,day_part:dayPartOf,remark:record?.remark||'',
    },async data=>{
      const teacherName=String(data.teacher||'').trim();
      if(data.type && !teacherName)throw new Error('请填写教师姓名');
      const who=teachers.find(x=>x.name===teacherName);
      const duration = data.type ? parseLeaveDuration(data.duration_unit==='day'?data.day_part:data.days,data.duration_unit) : null;
      if(data.type && data.end_date < data.start_date)throw new Error('结束日期不能早于开始日期');
      const next=record
        ? leaveRecords.filter(x=>x!==record&&String(x.id)!==String(record.id))
        : leaveRecords.slice();
      if(data.type){
        next.push({
          ...(record||{}),id:record?.id||Date.now(),grade:record?.grade||grade,
          name:teacherName||recordName||'',subject:who?.subject||record?.subject||'',type:data.type,
          start_date:data.start_date||date,end_date:data.end_date||data.start_date||date,
          ...duration,status:record?.status||'已批',remark:data.remark||'',
        });
      }
      await setGridLeaveMark(record,data.type||'');
      await savePrefs({leaves:next});
      editConfirmedSheet();
      await load();
    });
  };
  const handleClassStatus = async teacher => {
    const table=await getTable('class');
    const records=(table.rows||[]).filter(row=>{
      const data=rowData(row), record=data.__classRecord||{};
      return !data.__deleted && row.teacher===teacher.name && Number(record.period??period)===Number(period);
    });
    const current=deriveRosterState(teacher,{seatRows:details.seat?.rows||[],classRows:table.rows||[],researchRows:details.research?.rows||[],leaveRecords,date,period}).class;
    const existing=records.find(row=>String(rowData(row).__classRecord?.class_name||'').trim())||records[0];
    const existingData=existing?{...rowData(existing).__classRecord}:{};
    const hasClassName=!!String(existingData.class_name||'').trim();
    if(records.length&&hasClassName&&(current==='y'||current==='n')){
      const next=nextTriState(current);
      records.forEach(row=>{
        const data={...rowData(row)},record={...data.__classRecord,status:next};
        row.data={...data,__classRecord:record};
      });
      await saveRows('class',table,table.rows||[]);
      await load();
      return;
    }
    openEditor('登记上课情况',[
      {key:'class_name',label:'班级',required:true},
      {key:'period',label:'节次',type:'select',options:DEFAULT_PERIODS.map(p=>({value:p.no,label:p.label}))},
      {key:'status',label:'上课状态',type:'select',options:[{value:'u',label:'未登记'},{value:'y',label:'已上课'},{value:'n',label:'未上课'}]},
      {key:'listeners',label:'听课教师'},
      {key:'remark',label:'备注',type:'textarea'},
    ],{
      class_name:existingData.class_name||'',period:String(existingData.period??period),
      status:existingData.status==='n'?'n':'y',
      listeners:Array.isArray(existingData.listeners)?existingData.listeners.join('、'):'',
      remark:existingData.remark||'',
    },async data=>{
      let row=existing;
      if(!row){
        row=(table.rows||[]).find(item=>item.teacher===teacher.name&&!rowData(item).__classRecord&&!rowData(item).__deleted);
        if(!row){row={teacher:teacher.name,subject:teacher.subject||'',data:{}};table.rows.push(row);}
      }
      const record={
        ...existingData,class_name:String(data.class_name||'').trim(),period:Number(data.period??period),
        status:data.status||'u',
        listeners:String(data.listeners||'').split(/[、,，]/).map(x=>x.trim()).filter(Boolean),
        remark:data.remark||'',
      };
      row.data={...rowData(row),__classRecord:record};
      await saveRows('class',table,table.rows||[]);
      await load();
    });
  };
  const handleResearchStatus = async teacher => {
    const table=await getTable('research');
    const subjectName=String(teacher.subject||'').trim();
    const members=teachers.filter(item=>String(item.subject||'').trim()===subjectName).map(item=>item.name);
    const existing=(table.rows||[]).find(row=>{
      const data=rowData(row),record=data.__research||{};
      return !data.__deleted && !!data.__research
        && String(record.subject||row.subject||'').trim()===subjectName
        && matchesAttendancePeriod(record.period_time,period);
    });
    const updateAttendance=async(row,record,formData=null)=>{
      const attendees=new Set(Array.isArray(record.attendees)?record.attendees:[]);
      attendees.add(teacher.name);
      const present=members.filter(name=>attendees.has(name));
      const nextRecord={
        ...record,...(formData||{}),subject:subjectName,expected:members.length,
        attendees:present,absent:members.filter(name=>!present.includes(name)),
        status:present.length?'已登记':'待登记',
      };
      row.data={...rowData(row),__research:nextRecord};
      await saveRows('research',table,table.rows||[]);
      await load();
    };
    if(existing){
      const record={...rowData(existing).__research};
      if(!String(record.period_time||'').trim()||!String(record.host||'').trim()){
        openEditor('完善教研登记',[
          {key:'period_time',label:'节次/时间',required:true},
          {key:'location',label:'地点'},
          {key:'host',label:'主持人',required:true},
        ],{period_time:record.period_time||(period===0?'全天':'第'+period+'节'),location:record.location||'',host:record.host||teacher.name},
        async data=>updateAttendance(existing,record,data));
        return;
      }
      const attendees=new Set(Array.isArray(record.attendees)?record.attendees:[]);
      if(attendees.has(teacher.name))attendees.delete(teacher.name);else attendees.add(teacher.name);
      const present=members.filter(name=>attendees.has(name));
      existing.data={...rowData(existing),__research:{
        ...record,subject:subjectName,expected:members.length,attendees:present,
        absent:members.filter(name=>!present.includes(name)),status:present.length?'已登记':'待登记',
      }};
      await saveRows('research',table,table.rows||[]);
      await load();
      return;
    }
    openEditor('登记教研签到',[
      {key:'period_time',label:'节次/时间',required:true},
      {key:'location',label:'地点'},
      {key:'host',label:'主持人',required:true},
    ],{period_time:(period===0?'全天':'第'+period+'节'),location:'',host:teacher.name},async data=>{
      const attendees=[teacher.name];
      table.rows.push({
        teacher:subjectName||teacher.name,subject:subjectName,
        data:{__research:{
          ...data,subject:subjectName,expected:members.length,attendees,
          absent:members.filter(name=>!attendees.includes(name)),status:'已登记',
        }},
      });
      await saveRows('research',table,table.rows);
      await load();
    });
  };
  const toggle = async (teacher,key) => {
    const t=await getTable('seat');
    let row=t.rows.find(r=>r.teacher===teacher.name);
    if(!row){row={teacher:teacher.name,subject:teacher.subject||'',data:{}};t.rows.push(row);}
    const d={...rowData(row)}, periods={...(d.__periods||{})}, cur={...(periods[String(period)]||{})};
    if(key==='listen'){
      cur.listen_class=cur.listen_class?'':'未指定班级';
    } else cur[key]=nextTriState(cur[key]||'u');
    periods[String(period)]=cur; d.__periods=periods; row.data=d;
    await persistAndReload('seat',t.rows);
  };
  /* 六张表共用同一个批量导出面板，避免各页签样式、水印状态不一致。 */
  const exportMenuHtml = (count) => '<div class="aprd-export-wrap"><button type="button" class="aprd-op aprd-export-toggle" data-roster-export-toggle>批量导出<i class="aprd-caret" aria-hidden="true"></i></button>'
    + '<div class="aprd-export-menu aprd-export-sheet" data-roster-export-menu hidden>'
    + '<div class="aprd-export-sheet-head"><b>导出当前工作表</b><span>' + esc(grade || '全部年级') + ' · 共 ' + count + ' 人</span></div>'
    + '<div class="aprd-export-formats">'
    + '<button type="button" data-roster-export="xlsx"><i class="aprd-export-ico xlsx">X</i><span><b>Excel 表格</b><small>.xlsx 可编辑</small></span></button>'
    + '<button type="button" data-roster-export="csv"><i class="aprd-export-ico csv">C</i><span><b>CSV 文件</b><small>.csv 通用格式</small></span></button>'
    + '<button type="button" data-roster-export="pdf"><i class="aprd-export-ico pdf">P</i><span><b>PDF 文档</b><small>打印另存 PDF</small></span></button>'
    + '<button type="button" data-roster-export="png"><i class="aprd-export-ico png">图</i><span><b>PNG 图片</b><small>先预览再保存</small></span></button>'
    + '</div><div class="aprd-export-divider"></div>'
    + '<div class="aprd-export-sheet-foot">'
    + '<label class="aprd-export-switch"><input type="checkbox" id="aprd-export-watermark" ' + (watermarkOn ? 'checked' : '') + '><span>导出带水印</span></label>'
    + '<label class="aprd-export-field"><span>水印文案</span><input type="text" id="aprd-export-watermark-text" value="' + esc(watermarkText) + '" placeholder="留空默认：年级＋表名" ' + (watermarkOn ? '' : 'disabled') + '></label>'
    + '</div></div></div>';
  const currentExportType = () => ['seat', 'class', 'research', 'leave', 'summary'].includes(tab) ? tab : 'roster';
  const worksheetState = (teacher,type,rows,useSeatDraft=isEditing(type)) => {
    const published=objectValue(details.seat?.meta).workspace_confirmed?.[String(period)] || [];
    const inherited=useSeatDraft
      ? deriveTableGridState(teacher,'seat',getDraftRows('seat'),{leaveRecords,date,period})
      : published.find(row=>row?.id===String(teacher.id)) || {};
    const own=deriveTableGridState(teacher,type,rows,{leaveRecords,date,period});
    const mark=rows.find(row=>!rowData(row).__deleted && matchesGridTeacher(row,teacher)
      && rowData(row).__teacherGrid?.[String(period)]);
    const overrides=rowData(mark).__teacherGrid?.[String(period)]?.workspaceFields || [];
    const status = key => overrides.includes(key) || own[key]==='y' || own[key]==='n'
      ? own[key] : inherited[key] || 'u';
    const listeners=type==='class' ? [...new Set(rows.flatMap(row=>{
      const data=rowData(row),record=data.__classRecord;
      return !data.__deleted && record && Number(record.period??period)===period && matchesGridTeacher(row,teacher)
        ? record.listeners || [] : [];
    }))] : [];
    return {
      ...own,class:status('class'),listen:status('listen'),research:status('research'),
      remark:overrides.includes('remark') ? own.remark : own.remark || inherited.remark || '',
      leave:own.leave || '',listeners,
    };
  };
  const includedInWorksheet = (state,type) => !state.leave && (type==='class'
    ? state.class==='y' || state.listen==='y' : state.research==='y');
  const updateWorksheet = (teacher,type,key,value) => {
    const rows=getDraftRows(type);
    const prior=rows.find(row=>!rowData(row).__deleted && matchesGridTeacher(row,teacher));
    const mark=rowData(prior).__teacherGrid?.[String(period)];
    const next=updateTeacherGrid(rows,teacher,type,period,key,value,{leaveRecords,date});
    if(type!=='seat'){
      const fields=mark?.workspaceFields || [...(GRID_STATE_COLUMNS[type]||[]),'remark'].filter(field=>
        field==='leave'||field==='remark' ? !!mark?.[field] : mark?.[field]==='y'||mark?.[field]==='n');
      next.workspaceFields=[...new Set([...fields,key])];
    }
    return next;
  };
  /* 请假可能记在坐班表、教研表的下拉里，也可能只在请假总表里。
     挡勾选项要看的是「这一节他请没请假」，不能只看本表那一条记录。 */
  const rowLeaveOf = teacher => String(deriveRosterState(teacher, {
    leaveRecords, date, period,
    seatRows: getDraftRows('seat'), classRows: getDraftRows('class'), researchRows: getDraftRows('research'),
  }).leave || '');
  /* 五列全局互斥（用户 11-23 要求）：本表勾了某一项，其他三项在归属表里一并清掉。
     updateTeacherGrid 的互斥只管单张表，跨表管不着 —— 上课表勾了听课、坐班表还留着教研，
     两张表各说各的，导出和统计也跟着错。清完要落库，并告诉他旧表多了未确认变更。 */
  const clearOtherGridStates = (teacher, currentType, key) => {
    const cleared = [];
    const owners = new Set();
    for (const [otherKey, tableTypes] of Object.entries(GRID_STATE_OWNERS)) {
      if (otherKey === key) continue;
      for (const owner of tableTypes) {
        if (owner === currentType) continue;
        const own = deriveTableGridState(teacher, owner, getDraftRows(owner), { leaveRecords, date, period });
        if (own[otherKey] !== 'y' && own[otherKey] !== 'n') continue;
        updateWorksheet(teacher, owner, otherKey, 'u');
        cleared.push({ type: owner, key: otherKey });
        owners.add(owner);
      }
    }
    return { cleared, owners };
  };
  const saveClearedGridOwners = async owners => {
    try {
      for (const owner of owners) await persistDraft(owner, { reload: false });
    } catch (error) {
      toast('旧状态清理保存失败：' + attendanceErrorText(error), 'err', 5000);
    }
  };
  const applyGridExclusiveStates = async (teacher, currentType, key, value) => {
    if (value !== 'y' && value !== 'n') return;
    const { cleared, owners } = clearOtherGridStates(teacher, currentType, key);
    if (!cleared.length) return;
    await saveClearedGridOwners(owners);
    const names = cleared.map(item => SHEET_LABELS[item.type] + '的' + GRID_STATE_LABELS[item.key]);
    toast(teacher.name + '：已清掉' + names.join('、') + '，本时段只保留' + GRID_STATE_LABELS[key]
      + '（' + [...owners].map(owner => SHEET_LABELS[owner]).join('、') + '有未确认变更，点确认生成后同步）', 'warn', 6000);
  };
  /* 请假和四个勾选项也互斥：选了请假类型，本时段勾过的一律清掉，
     不然请假记录还在、勾也留着，导出会把两样都算上。
     updateTeacherGrid 在 key 属于状态列时会把其余状态列一起清空，写 'class' 就是整行清勾。 */
  const clearGridStatesForLeave = async (teacher, currentType) => {
    const owners = new Set(GRID_STATE_PRIORITY.flatMap(key => GRID_STATE_OWNERS[key]));
    const dirty = new Set();
    for (const owner of owners) {
      const own = deriveTableGridState(teacher, owner, getDraftRows(owner), { leaveRecords, date, period });
      if (!GRID_STATE_PRIORITY.some(key => own[key] === 'y' || own[key] === 'n')) continue;
      updateWorksheet(teacher, owner, 'class', 'u');
      /* 只落真正改过的表：getDraftRows('seat') 会给缺的人补空行，
         没改也去 persistDraft 就等于凭空往坐班表塞空记录。 */
      if (owner !== currentType) dirty.add(owner);
    }
    if (dirty.size) await saveClearedGridOwners(dirty);
    return dirty;
  };
  const worksheetEntries = (type, useSeatDraft=false, showAll=false) => {
    const draftRows = getDraftRows(type);
    const context = {leaveRecords,date,period};
    return teachers.flatMap(teacher => {
      if(type!=='seat'){
        const state = worksheetState(teacher,type,draftRows,useSeatDraft);
        return showAll || includedInWorksheet(state,type) ? [{teacher,state}] : [];
      }
      const merged = deriveRosterState(teacher,{...context,seatRows:draftRows,
        classRows:details.class?.rows||[],researchRows:details.research?.rows||[]});
      const own = deriveTableGridState(teacher,type,draftRows,context);
      const hasRecord = draftRows.some(row => !rowData(row).__deleted &&
        matchesGridTeacher(row,teacher) && rowData(row).__teacherGrid?.[String(period)]);
      const state = hasRecord ? {...merged,...own,leave:merged.leave||own.leave||''} : merged;
      return [{teacher,state,department:deptOf(teacher),remark:state.remark||noteOf(teacher)}];
    });
  };
  const matchesSheetFilter = row => (!search || (row.name+' '+row.subject).toLowerCase().includes(search.toLowerCase()))
    && (!subject || (row.subject||'未填学科')===subject);
  const voiceButtonHtml = locked => '<button type="button" class="aprd-voice" data-workspace-voice'
    +(locked?' disabled':'')+'>'+icon('speak',15)+'语音速记</button>';
  /* 「新增」按页签各点各的：花名册开新增教师表单，坐班/上课/教研登记一条本表记录，
     请假开请假表单，汇总表手工补一行。按钮位置六张表一致。
     和编辑态对齐：已确认生成又没点「编辑」时，新增跟着锁住，避免误改历史。 */
  const ADD_ACTIONS = {
    roster:['data-add','新增教师'],seat:['data-add-record','新增坐班'],class:['data-add-record','新增上课'],
    research:['data-add-record','新增教研'],leave:['data-add-leave','新增请假'],summary:['data-add-summary','新增统计'],
  };
  /* 花名册新增不再要求先进编辑态：新增卡片本身就承担新增+编辑（用户 11-25 要求） */
  const addButtonLocked = type => type!=='roster' && (!!confirmedResult(type) && !isEditing(type));
  const addButtonHtml = (type,locked) => {
    const [action,label]=ADD_ACTIONS[type]||['data-add','新增'];
    const text=type==='roster'&&showAddTeacher?'收起新增教师':'＋ '+label;
    return '<button type="button" class="primary aprd-add-btn" '+action+(locked||addButtonLocked(type)?' disabled':'')+'>'+esc(text)+'</button>';
  };
  const editButtonHtml = (type,locked) => '<button type="button" class="aprd-op" data-edit-sheet'
    +(locked||isEditing(type)?' disabled':'')+'>编辑</button>';
  const generateButtonHtml = locked => '<button type="button" class="primary" data-generate'
    +(locked||generating?' disabled':'')+'>确认生成</button>';
  const sheetStatusHtml = (type,locked,statusNote) => {
    /* 加载中的月度快照也要禁写，但它不是「只读累计」，状态别说成回看。 */
    if(locked)return '<span class="aprd-filter-count" role="status">'+esc(statusNote||rangeLabel()+'累计 · 只读回看')+'</span>';
    const confirmed=confirmedResult(type), editing=isEditing(type);
    const draft=type==='summary' && summaryDrafts.has(summaryDraftKey());
    const status=editing?'编辑中 · 修改后点确认生成':draft||!confirmed?'待确认':'';
    return status?'<span class="aprd-filter-count" role="status">'+status+'</span>':'';
  };
  const countOf = value => String(Number(value) || 0);
  /* 六张表下方按钮统一：学科筛选 / 搜索框 / 语音速记 / 新增 / 编辑 / 确认生成。
     学科管理按钮已去掉：学科改在花名册新增卡片里就地创建（用户 11-25 要求）。
     花名册不再有「编辑」按钮：编辑并进新增卡片 + 行内操作。
     月/年查看态下写操作的按钮一起锁住，只留筛选可用。 */
  const toolbarMainHtml = (type, extra = '', locked = false, statusNote = '') => teacherFiltersHtml()+voiceButtonHtml(locked)
    +addButtonHtml(type,locked)+(type==='roster'?'':editButtonHtml(type,locked))
    +generateButtonHtml(locked)+sheetStatusHtml(type,locked,statusNote)+extra;
  /* 草稿与已确认快照逐行比对，只在「编辑中」算差异：
     未确认变更 = 这次编辑里改了但还没重新确认生成的行数。 */
  const gridStateValue = value => value === 'y' || value === true ? 'y' : value === 'n' ? 'n' : 'u';
  const sheetRowKey = row => String(row?.teacher?.id ?? row?.id ?? row?.teacher?.name ?? row?.teacher ?? row?.name ?? '');
  const sheetRowSignature = (row, type) => {
    const state = row?.state || row || {};
    return (GRID_STATE_COLUMNS[type] || []).filter(key => key !== 'leave')
      .map(key => key + ':' + gridStateValue(state[key])).join('|')
      + '|leave:' + (state.leave || '') + '|remark:' + String(state.remark || '');
  };
  const sheetDirtyKeys = type => {
    const confirmed = TYPE[type] ? confirmedResult(type) : null;
    if (!confirmed || !Array.isArray(confirmed.rows) || !isEditing(type)) return new Set();
    const previous = new Map(confirmed.rows.map(row => [sheetRowKey(row), sheetRowSignature(row, type)]));
    const dirty = new Set();
    for (const entry of worksheetEntries(type, true, true)) {
      const key = sheetRowKey(entry);
      /* 只对「确认快照里有的行」报差异：万一云端把快照结构改了，宁可少报也不要把整表都标成已修改。 */
      if (previous.has(key) && previous.get(key) !== sheetRowSignature(entry, type)) dirty.add(key);
    }
    return dirty;
  };
  const batchBarHtml = (type) => {
    const range = resolvePeriodRange(period);
    const periodLabel = period === 0 ? '全天'
      : (DEFAULT_PERIODS.find(item => Number(item.no) === period)?.label || ('第' + period + '节'));
    const dirtyCount = sheetDirtyKeys(type).size;
    return '<div class="aprd-batch"><div class="aprd-batch-main"><span class="aprd-batch-label">当前批次</span>'
      + '<b>' + esc(date + ' ' + weekdayLabel(date)) + '</b>'
      + '<span>' + esc(grade) + '</span><span>' + esc(currentScheduleType()) + '</span>'
      + '<span class="aprd-batch-period">' + esc(periodLabel) + ' ' + esc(range[0] + '—' + range[1]) + '</span></div>'
      + '<div class="aprd-batch-side">'
      + (dirtyCount ? '<button type="button" class="aprd-dirty-badge" data-scroll-dirty>有 ' + dirtyCount + ' 条未确认变更</button>' : '')
      + '</div></div>';
  };
  /* 批量导入/批量导出挂在卡片右上角的页签行上，可导出条数只有各张表自己算得出来，
     所以由各页签的 builder 往 tabCorner 交一份，renderPage 拼页签行时取用。 */
  let tabCorner = '';
  const tabCornerHtml = (importAction, count) => (importAction
    ? '<button type="button" class="aprd-op" '+importAction+'>批量导入</button>' : '') + exportMenuHtml(count);
  const rosterHtml = (type = 'roster') => {
    const result = isEditing(type) ? null : confirmedResult(type);
    const editable = type !== 'roster' && !result;
    const isWorksheet=type==='class'||type==='research';
    const dirtyKeys = sheetDirtyKeys(type);
    const entries = type==='roster' ? visibleTeachers().map(teacher=>({teacher}))
      /* 上课表/教研表的名单和坐班表一样全：没登记的人就是几格空白，
         不能因为「这条表还没记录」把整张表收成空（用户 11-22 要求三张表一模一样）。
         只改这份显示名单，确认生成与导出仍走 worksheetEntries 的已登记口径。 */
      : (result?.rows ?? worksheetEntries(type,isEditing(type),true)).filter(({teacher})=>matchesSheetFilter(teacher));
    const listedTeachers=entries.map(({teacher})=>teacher);
    const activeStateKeys = type === 'roster' ? [] : SHEET_STATE_COLUMNS;
    const nativeKeys = GRID_STATE_COLUMNS[type] || SHEET_STATE_COLUMNS;
    /* 只读列的取值：上课表/教研表里不属于本表的格子，回显当天坐班总表的状态，
       这样四张表同一行看到的是同一份数据，也不会多出第二条写入路径。 */
    const seatStates = type === 'class' || type === 'research'
      ? new Map(worksheetEntries('seat', isEditing('seat'), true).map(({ teacher, state }) => [String(teacher.id), state]))
      : null;
    const viewStateOf = (teacher, state) => {
      /* 五列全局互斥（用户 11-23 要求）：一行只留一个状态。
         坐班表自己就是总表，按 上课 > 坐班 > 听课 > 教研 裁决即可。 */
      if (!seatStates) return resolveSingleGridState(state, GRID_STATE_PRIORITY);
      const merged = { ...(seatStates.get(String(teacher.id)) || {}), listeners: state.listeners };
      /* 本表自己的列（连同记 y/n 的 *Status 变体）一律用本表数据：
         坐班表刚勾、还没确认生成时，子表这一格不能先显示成已登记。 */
      for (const key of nativeKeys) {
        merged[key] = state[key];
        if (key === 'listen' || key === 'research') merged[key + 'Status'] = state[key + 'Status'];
      }
      /* 子表里本表勾的排前面，坐班总表回显的排后面：
         上课表刚勾了听课、坐班表还留着教研时，这一行显示的是他手上这次勾选。 */
      return resolveSingleGridState(merged, [
        ...GRID_STATE_PRIORITY.filter(key => nativeKeys.includes(key)),
        ...GRID_STATE_PRIORITY.filter(key => !nativeKeys.includes(key)),
      ]);
    };
    const editableKey = key => editable && nativeKeys.includes(key);
    /* 花名册只维护教师名单：考勤状态不展示，但保留一列可直接填写的备注（用户 11-15 要求）。
       三张考勤表在「请假」后面多一列「请假时间」（用户 11-24 要求）。 */
    const stateHeaders = activeStateKeys.flatMap(key => key === 'leave'
      ? [GRID_STATE_LABELS[key], '请假时间'] : [GRID_STATE_LABELS[key]]);
    const columns = type === 'roster'
      ? ['序号','归属部门','归属年级','姓名','学科','备注','操作']
      : ['序号','归属部门','归属年级','姓名','学科',...stateHeaders,'备注','操作'];
    /* 花名册行内操作不再依赖「编辑」按钮（已去掉）：新增/编辑/删除随时可用。 */
    const canWrite = type === 'roster' ? true : editable;
    const actionsOf = teacher => isWorksheet
      ? '<div class="aprd-actions"><button type="button" class="aprd-op" data-edit-work-record="'+esc(teacher.id)+'">编辑</button>'
        +'<button type="button" class="aprd-op danger" data-delete-work-record="'+esc(teacher.id)+'">删除</button></div>'
      : '<div class="aprd-actions"><button type="button" class="aprd-op" data-edit="'+esc(teacher.id)+'"'+(canWrite?'':' disabled')+'>编辑</button>'
      +'<button type="button" class="aprd-op danger" data-disable="'+esc(teacher.id)+'"'+(canWrite?'':' disabled')+'>删除</button></div>';
    const rows = entries.map(({teacher,state,department,remark:savedRemark},index) => {
      if (type === 'roster') {
        return '<tr><td class="aprd-serial">'+(index+1)+'</td><td>'+esc(deptOf(teacher))+'</td><td>'+esc(teacher.grade||grade)+'</td>'
          +'<td class="aprd-name">'+esc(teacher.name)+'</td><td>'+esc(teacher.subject||'')+'</td>'
          +'<td>'+(canWrite
            ?'<input type="text" class="aprd-note-input" data-roster-note="'+esc(teacher.id)+'" value="'+escAttr(noteOf(teacher))+'" placeholder="备注" aria-label="'+escAttr(teacher.name+' 备注')+'">'
            :'<span class="aprd-remark">'+esc(noteOf(teacher)||'—')+'</span>')+'</td>'
          +'<td>'+actionsOf(teacher)+'</td></tr>';
      }
      /* 请假优先级最高：已请假的人其他四类格子显示为未登记，与导出和 KPI 口径一致，
         避免出现「上课✓ + 请假 事假」这种自相矛盾的行。 */
      const view = viewStateOf(teacher, state);
      const shown = view.leave
        ? {...view, class:'u', sit:'u', listen:'u', research:'u', listenStatus:'u', researchStatus:'u'}
        : view;
      /* 状态格做成下拉样式（设计稿）：点一下按 空白→√→×→空白 循环。
         未登记统一写「空白」，可编辑时右侧带一个小箭头。 */
      const mark = (key,value) => {
        value = value === 'y' || value === 'n' ? value : 'u';
        const label = value === 'y' ? '√' : value === 'n' ? '×' : '空白';
        const stateText = value === 'y' ? '正常' : value === 'n' ? '异常' : '未登记';
        const aria = 'aria-label="'+esc(teacher.name+' '+({class:'上课',sit:'坐班',listen:'听课',research:'教研'}[key])+'：'+stateText)+'"';
        /* 点格子接着「屏幕上这一格」往下循环，不能按合并前的原始值走：
           五列互斥后别的状态已经被压成空白，按原始值点会变成点一下就出 ×。 */
        const shownAttr = ' data-grid-value="'+value+'"';
        if (!editableKey(key)) return '<span class="aprd-mark '+value+(value==='u'?' ap-placeholder':'')+'" '+aria+'>'+(value==='u'?'—':label)+'</span>';
        return '<button type="button" class="aprd-select '+value+'" data-grid-person="'+esc(teacher.id)+'" data-grid-key="'+key+'"'+shownAttr+' '+aria
          +'><span>'+label+'</span><i class="aprd-caret"></i></button>';
      };
      const listen = shown.listenStatus || (shown.listen === true ? 'y' : shown.listen);
      const research = shown.researchStatus || (shown.research === true ? 'y' : shown.research);
      const leave = editableKey('leave') ? '<span class="aprd-leave-wrap'+(view.leave?' on':'')+'"><select class="aprd-leave-select '+(view.leave?'on':'')+'" data-grid-person="'+esc(teacher.id)+'" data-grid-key="leave" aria-label="'+esc(teacher.name+' 请假')+'">'
        +['',...new Set([...LEAVE_TYPES,view.leave].filter(Boolean))].map(value=>'<option value="'+esc(value)+'" '+(view.leave===value?'selected':'')+'>'+esc(value||'无')+'</option>').join('')+'</select><i class="aprd-caret" aria-hidden="true"></i></span>'
        : (view.leave?'<span class="aprd-mark leave">'+esc(view.leave)+'</span>':'<span class="aprd-mark ap-placeholder">—</span>');
      /* 请假时间（用户 11-24）：小时 / 天（上午·下午·全天）/ 月，数字 + 单位两个控件。
         值按「本格子填过的 → 当天请假记录 → 默认全天」取，没登记请假的人这一格只显示「—」。 */
      const leaveTimeCell = (() => {
        const current = normalizeLeaveTime(state.leave_time)
          || leaveTimeFromRecord(leaveRecordOf(teacher))
          || { unit:'day', amount:1, part:'full' };
        if (!editableKey('leave') || !view.leave) {
          const text = view.leave ? formatLeaveTime(current) : '';
          return text
            ? '<span class="aprd-mark leave">'+esc(text)+'</span>'
            : '<span class="aprd-mark ap-placeholder">—</span>';
        }
        const byDay = current.unit === 'day';
        return '<span class="aprd-lt">'
          +'<input class="aprd-lt-num" type="number" min="0.5" step="0.5" inputmode="decimal" data-leave-amount="'+esc(teacher.id)+'"'
          +' value="'+escAttr(byDay?'':current.amount)+'"'+(byDay?' hidden':'')+' aria-label="'+escAttr(teacher.name+' 请假时长')+'">'
          +'<select class="aprd-lt-unit" data-leave-unit="'+esc(teacher.id)+'" aria-label="'+escAttr(teacher.name+' 请假时长单位')+'">'
          +LEAVE_TIME_UNITS.map(unit=>'<option value="'+escAttr(unit.value)+'"'+(current.unit===unit.value?' selected':'')+'>'+esc(unit.label)+'</option>').join('')
          +'</select>'
          +'<select class="aprd-lt-part" data-leave-part="'+esc(teacher.id)+'" aria-label="'+escAttr(teacher.name+' 请假时段')+'"'+(byDay?'':' hidden')+'>'
          +LEAVE_TIME_PARTS.map(part=>'<option value="'+escAttr(part.value)+'"'+(current.part===part.value?' selected':'')+'>'+esc(part.label)+'</option>').join('')
          +'</select></span>';
      })();
      /* 备注列直接用行内输入框，默认空白，点进去就能写（用户 11-15 要求）。 */
      const remark = editable
        ? '<input type="text" class="aprd-note-input" data-grid-person="'+esc(teacher.id)+'" data-grid-key="remark" value="'+escAttr(state.remark||'')+'" placeholder="备注" aria-label="'+escAttr(teacher.name+' 备注')+'">'
        : '<span class="aprd-remark">'+esc(savedRemark||state.remark||'—')+'</span>';
      const stateCells = activeStateKeys.map(key => {
        if (key === 'leave') return '<td>'+leave+'</td><td class="aprd-lt-cell">'+leaveTimeCell+'</td>';
        if (key === 'listen') return '<td>'+mark('listen',listen)
          +(type==='class' && shown.listeners?.length ? ' '+esc(shown.listeners.join('、')) : '')+'</td>';
        if (key === 'research') return '<td>'+mark('research',research)+'</td>';
        return '<td>'+mark(key,shown[key])+'</td>';
      }).join('');
      return '<tr><td class="aprd-serial">'+(index+1)+'</td><td>'+esc(department||deptOf(teacher))+'</td><td>'+esc(teacher.grade||grade)+'</td>'
        +'<td class="aprd-name">'+esc(teacher.name)+(dirtyKeys.has(sheetRowKey({teacher}))?'<span class="aprd-dirty">已修改</span>':'')+'</td><td>'+esc(teacher.subject||'')+'</td>'
        +stateCells+'<td>'+remark+'</td>'
        +'<td>'+actionsOf(teacher)+'</td></tr>';
    }).join('');
    const tools = toolbarMainHtml(type);
    tabCorner = tabCornerHtml('data-roster-import', listedTeachers.length);
    const currentStates = entries.map(({teacher,state})=>viewStateOf(teacher,state));
    /* 设计稿的统计条：数字在上、文字在下，整条一个圆角边框，格子之间用竖线分隔。
       列统一之后统计条也跟着统一：四张表都数同一组状态，只是各自数的是本表列出来的人。 */
    const kpiOf = {
      sit:['正在坐班',state=>state.sit==='y'],
      class:['正在上课',state=>state.class==='y'],
      listen:['听课教师',state=>state.listen===true || state.listen==='y'],
      research:['教研教师',state=>state.research===true || state.research==='y'],
      leave:['请假教师',state=>!!state.leave],
    };
    const summaryItems = [
      ['当前筛选教师',listedTeachers.length],
      ...(activeStateKeys||[]).map(key=>{
        const [label,match]=kpiOf[key];
        return [label,currentStates.filter(match).length];
      }),
    ];
    /* 花名册也要统计条（用户 11-22 要求）：人数跟着当前筛选走，
       学科和部门数的是筛完之后真实出现的去重值；停用是整份名单的口径，
       跟着筛选走反而看不出是谁被停的。 */
    const rosterItems = [
      ['在册教师', listedTeachers.length],
      ['学科', new Set(listedTeachers.map(t => String(t.subject || '').trim()).filter(Boolean)).size],
      ['归属部门', new Set(listedTeachers.map(teacher => deptOf(teacher))).size],
      ['已停用', allTeachers.length - teachers.length],
    ];
    const summaryStrip = '<div class="aprd-kpis aprd-grid-summary">'
      +(type === 'roster' ? rosterItems : summaryItems).map(([label,value])=>
        '<div class="aprd-kpi'+(label==='请假教师'?' leave':'')+'"><b>'+value+'</b><span>'+label+'</span></div>').join('')+'</div>';
    return '<div class="aprd-toolbar"><div class="aprd-toolbar-main">'+tools+'</div>'
      +'<span class="aprd-filter-count">当前筛：'+esc(subject||'全部学科')+' · '+listedTeachers.length+' 位教师</span></div>'+teacherAddCardHtml()+summaryStrip
      +'<div class="aprd-table-wrap"><table><thead><tr>'+columns.map(column=>'<th>'+column+'</th>').join('')
      +'</tr></thead><tbody>'+(rows||'<tr><td colspan="'+columns.length+'" class="aprd-empty">当前筛选下暂无在岗教师</td></tr>')+'</tbody></table></div>';
  };
  const leaveHtml = () => {
    const result = leaveOnlyDate && !isEditing('leave') ? confirmedResult('leave') : null;
    const scope = leaveOnlyDate ? (result?.rows ?? leavesForSelection(leaveOnlyDate)) : leaveRecords;
    const shown=scope.filter(matchesSheetFilter);
    /* 请假表按科目筛选时同样要能看到「这个科目有多少老师」，人数取花名册而不是请假条数。 */
    const matchedTeachers=teachers.filter(t=>(!subject||String(t.subject||'').trim()===subject)&&(!search||(t.name+' '+t.subject).includes(search)));
    const dayChip = leaveOnlyDate
      ? '<span class="aprd-filter-count">仅显示 '+esc(leaveOnlyDate)+' 请假 · '+shown.length+' 条 <button type="button" class="aprd-op" data-leave-show-all>查看全部</button></span>'
      : '<span class="aprd-filter-count">当前筛：'+esc(subject||'全部学科')+' · '+matchedTeachers.length+' 位教师 / '+shown.length+' 条请假</span>';
    /* 请假记录只存姓名，部门和年级要回查花名册；取值口径与请假表导出一致，
       不然屏幕上两列和导出的两列会不一样。 */
    const teacherByName = new Map(teachers.map(t=>[String(t.name||'').trim(),t]));
    const rows = shown.map((x,index)=>{const t=teacherByName.get(String(x.name||'').trim());
      return '<tr><td class="aprd-serial">'+(index+1)+'</td><td>'+esc(t?deptOf(t):x.department||'高中部')+'</td><td>'+esc(t?.grade||x.grade||grade)+'</td>'
      +'<td>'+esc(x.name)+'</td><td>'+esc(x.subject)+'</td><td>'+esc(x.type)+'</td><td>'+esc(x.start_date)+'</td><td>'+esc(x.end_date)+'</td><td>'+esc(formatLeaveDuration(x))+'</td>'
      +(result?'<td>'+esc(x.remark||'')+'</td>'
        : '<td><input type="text" class="aprd-note-input" data-leave-note="'+esc(x.id)+'" value="'+escAttr(x.remark||'')+'" aria-label="'+escAttr(x.name+' 备注')+'"></td>')
      +'<td><button data-edit-leave="'+esc(x.id)+'">编辑</button> <button data-delete-leave="'+esc(x.id)+'">删除</button></td></tr>';
    }).join('');
    const emptyMessage = scope.length ? '暂无符合筛选条件的请假记录'
      : leaveOnlyDate ? '所选日期暂无请假记录，可点击「新增请假」登记'
        : '暂无请假记录，可点击「新增请假」登记';
    tabCorner = tabCornerHtml('', teachers.length);
    const leaveColumns = ['序号',...ATTENDANCE_COLUMNS.leave];
    /* 请假表也要统计条（用户 11-22 要求）：条数按当前筛选的请假记录数，
       时长把天数和小时各自累加，和汇总表、导出的「请假时长」同一口径。 */
    const leaveTypeCount = name => shown.filter(x => String(x.type || '').trim() === name).length;
    const leaveKpis = [
      ['请假教师', new Set(shown.map(x => String(x.name || '').trim()).filter(Boolean)).size],
      ['请假条数', shown.length],
      ['病假', leaveTypeCount('病假')],
      ['事假', leaveTypeCount('事假')],
      ['累计时长', formatLeaveDuration({
        days: shown.reduce((sum, x) => sum + (Number(x.days) || 0), 0),
        hours: shown.reduce((sum, x) => sum + (Number(x.hours) || 0), 0),
      })],
    ];
    return '<div class="aprd-toolbar"><div class="aprd-toolbar-main">'+toolbarMainHtml('leave')+'</div>'+dayChip+'</div>'
      +'<div class="aprd-kpis aprd-grid-summary">'+leaveKpis.map(([label,value])=>'<div class="aprd-kpi"><b>'+esc(value)+'</b><span>'+label+'</span></div>').join('')+'</div>'
      +'<div class="aprd-table-wrap"><table><thead><tr>'+leaveColumns.map(c=>'<th>'+c+'</th>').join('')+'<th>操作</th></tr></thead><tbody>'+(rows||'<tr><td class="aprd-empty" colspan="'+(leaveColumns.length+1)+'">'+emptyMessage+'</td></tr>')+'</tbody></table></div>';
  };
  const calculateSummaryRows = () => calculateDailySummary({teachers,seatRows:details.seat?.rows||[],classRows:details.class?.rows||[],
      researchRows:details.research?.rows||[],leaveRecords:activeLeavesFor(leaveRecords,date,grade),date}).rows;
  const summaryBaseRows = () => isMonthlySummary('summary') ? monthly?.rows || [] : calculateSummaryRows();
  const summaryRows = () => summaryDrafts.get(summaryDraftKey()) ?? confirmedResult('summary')?.rows ?? summaryBaseRows();
  const summaryDuration = row => formatLeaveDuration({days:row.leaveDays,hours:row.leaveHours});
  const summaryHtml = () => {
    const byMonth=isMonthlySummary('summary');
    if(byMonth && (monthly?.key!==monthKey() || monthly.loading || monthly.error)){
      const message=monthly?.key===monthKey() ? monthly.error : '';
      return '<div class="aprd-toolbar"><div class="aprd-toolbar-main">'+toolbarMainHtml('summary','',true,summaryMonth+' 月度快照 · 正在加载')+'</div></div>'
        +'<div class="aprd-empty" role="status">'+(message?esc(message)+' <button type="button" class="aprd-op" data-summary-retry>重新加载</button>':'正在加载月汇总…')+'</div>';
    }
    const editing=isEditing('summary');
    const showActions=editing || !!confirmedResult('summary');
    const visible=summaryRows().map((row,index)=>({row,index})).filter(({row})=>matchesSheetFilter(row));
    const s=attendanceSummaryTotals(visible.map(({row})=>row));
    const kpis=[['应到教师',s.expectedTeachers+'人'],['坐班次数',s.seatPresent],['上课次数',s.classes],['听课人次',s.listens],['请假人数',s.leavePeople+'人']];
    /* 汇总表补部门/年级：新行带 teacherId，历史确认结果里的行只有姓名，所以 id 优先、姓名兜底。 */
    const rowTeacher = r => teachers.find(t=>String(t.id)===String(r.teacherId))
      || teachers.find(t=>String(t.name||'').trim()===String(r.name||'').trim());
    const rows=visible.map(({row:r,index})=>{const t=rowTeacher(r);
      return '<tr><td class="aprd-serial">'+r.serial+'</td><td>'+esc(t?deptOf(t):r.department||'高中部')+'</td><td>'+esc(t?.grade||r.grade||grade)+'</td>'
      +'<td>'+esc(r.name)+'</td><td>'+esc(r.subject)+'</td>'
      +SUMMARY_COUNT_FIELDS.map(([key])=>'<td>'+esc(r[key])+'</td>').join('')
      +'<td>'+esc(summaryDuration(r))+'</td>'
      +(showActions?'<td><button type="button" class="aprd-op" data-summary-edit-row="'+index+'">编辑</button></td>':'')+'</tr>';
    }).join('');
    const range = byMonth ? attendanceSummaryMonthBounds(summaryMonth) : null;
    tabCorner = tabCornerHtml('data-summary-import', summaryRows().length);
    return '<div class="aprd-toolbar"><div class="aprd-toolbar-main">'
      +toolbarMainHtml('summary',editing?'<button type="button" class="aprd-op" data-summary-recalculate>按考勤重新统计</button>':'')
      +'<span class="aprd-filter-count">'+(range?range.start+' 至 '+range.end:date)+'</span>'
      +'</div></div><div class="aprd-kpis">'+kpis.map(([label,value])=>'<div class="aprd-kpi"><span>'+label+'</span><b>'+value+'</b></div>').join('')+'</div>'
      +'<div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.summary.map(c=>'<th>'+c+'</th>').join('')
      +(showActions?'<th>操作</th>':'')+'</tr></thead><tbody>'+(rows||'<tr><td class="aprd-empty" colspan="'+(ATTENDANCE_COLUMNS.summary.length+Number(showActions))+'">暂无统计记录</td></tr>')+'</tbody></table></div>';
  };
  const openSummaryImport = () => {
    const scope=summaryDraftKey();
    const dialog=document.createElement('div');
    dialog.className='aprd-dialog';
    dialog.innerHTML='<form class="aprd-editor"><h3>批量导入汇总统计表</h3>'
      +'<p>可编辑本表导出的 Excel 或 CSV 后导入，按姓名和学科匹配教师。</p>'
      +'<label>选择文件<input name="file" type="file" accept=".xlsx,.csv,.tsv" required></label>'
      +'<div class="aprd-foot"><button type="button" data-cancel>取消</button><button type="submit" class="primary">导入</button></div></form>';
    (root.querySelector('.attendance-prd')||root).append(dialog);
    const form=dialog.querySelector('form');
    const cancel=form.querySelector('[data-cancel]');
    const submit=form.querySelector('[type="submit"]');
    cancel.onclick=()=>dialog.remove();
    form.onsubmit=async event=>{
      event.preventDefault();
      const file=form.elements.namedItem('file').files[0];
      if(!file)return;
      submit.disabled=true;
      try{
        const sheets=/\.xlsx$/i.test(file.name) ? (await readXlsx(file)).sheets : [{rows:readDelimited(await file.text())}];
        const sheet=sheets.find(({rows})=>rows.some(line=>line.some(cell=>String(cell).trim()==='姓名')));
        if (scope!==summaryDraftKey() || !dialog.isConnected) return;
        const imported=importAttendanceSummary(sheet?.rows||[],summaryRows());
        summaryDrafts.set(scope,imported.rows);
        editingSheet=editKey('summary');
        dialog.remove();
        paint();
        toast('已导入 '+imported.count+' 条统计记录，请核对后确认生成','ok');
      }catch(error){toast(error.message||'导入失败','err');}
      finally{submit.disabled=false;}
    };
  };
  /* 「新增」按页签各点各的：坐班/上课/教研 = 手动录入一条本表记录（用户 11-25 要求：
     不再从花名册下拉选，教师姓名/科目全部手输；登记的是临时人员，只落本节课，不进花名册），
     登记即进入编辑态，改完还是要点「确认生成」才落到已确认结果。 */
  const openAddRecord = () => {
    const type = tab;
    const key = type === 'seat' ? 'sit' : type === 'class' ? 'class' : 'research';
    const subjectOptions = [...new Set([...teacherSubjects(), ...ROSTER_SUBJECTS])].map(value => ({ value }));
    openEditor(ADD_ACTIONS[type][1] + ' · ' + grade, [
      { key: 'name', label: '教师姓名', required: true },
      { key: 'subject', label: '科目', type: 'combo', options: subjectOptions },
      { key: 'remark', label: '备注' },
    ], { name: '', subject: '', remark: '' }, async data => {
      const name = String(data.name || '').trim();
      if (!name) throw new Error('要填写教师姓名');
      const subject = String(data.subject || '').trim();
      /* 临时教师不进花名册：id 留空，行按「姓名+科目」匹配，只写本节课的工作表行 */
      const teacher = { id: null, name, subject };
      const leaveText = rowLeaveOf(teacher);
      if (leaveText) throw new Error(name + ' 本时段已请假（' + leaveText + '），请先在请假表取消请假');
      const remark = String(data.remark || '').trim();
      editingSheet = editKey(type);
      updateWorksheet(teacher, type, key, 'y');
      if (remark) updateWorksheet(teacher, type, 'remark', remark);
      scheduleAutoSave(type);
      await applyGridExclusiveStates(teacher, type, key, 'y');
      paint();
      toast('已登记 ' + name + (subject ? '（' + subject + '）' : '') + ' 的' + ADD_ACTIONS[type][1] + '（不入花名册），确认后才会生成', 'ok');
    });
  };
  const openAddSummary = () => {
    const scope = summaryDraftKey();
    openEditor('新增汇总统计 · ' + grade, [
      { key: 'teacher', label: '教师', type: 'select', required: true,
        options: teachers.map(item => ({ value: String(item.id), label: item.name + '（' + (item.subject || '未填学科') + '）' })) },
      ...SUMMARY_COUNT_FIELDS.map(([key, label]) => ({ key, label, type: 'number', min: 0, step: 1 })),
      { key: 'leaveDuration', label: '请假时长', placeholder: '0.5天 / 2小时' },
    ], { teacher: String(teachers[0]?.id || ''), seatPresent: 0, classes: 0, listens: 0, research: 0, leaveDuration: '' }, async data => {
      const teacher = teachers.find(item => String(item.id) === String(data.teacher));
      if (!teacher) throw new Error('要选一位教师');
      const base = { serial: 0, teacherId: teacher.id, name: teacher.name, subject: teacher.subject || '',
        grade: teacher.grade || grade, department: deptOf(teacher),
        seatPresent: 0, classes: 0, listens: 0, research: 0, leaveDays: 0, leaveHours: 0 };
      const row = updateAttendanceSummaryRow(base, {
        ...Object.fromEntries(SUMMARY_COUNT_FIELDS.map(([key]) => [key, String(data[key] ?? 0)])),
        leaveDuration: String(data.leaveDuration || '').trim() || '0小时',
      });
      const rows = (summaryDrafts.get(scope) ?? summaryRows()).slice();
      summaryDrafts.set(scope, [...rows.filter(item => String(item.name || '').trim() !== String(row.name).trim()), row]
        .map((item, index) => ({ ...item, serial: index + 1 })));
      editingSheet = editKey('summary');
      paint();
      toast('已补一行统计，确认后才会生成', 'ok');
    });
  };
  /* 切页签/切查看周期后该走哪条加载路径：日视图的格子来自当天主表，
     切回按日得整页重载；月/年是累计视图，只要重取对应区间。 */
  const refreshView = async () => {
    if (viewPeriod==='day') await load();
    else if (isRangeView(tab)) await loadRange();
    else if (isMonthlySummary(tab)) await loadMonth();
    else paint();
  };
  /* 月 / 年查看：每人一行累计、只读。
     按年 = 把当年 12 个月各跑一遍月汇总再按人合并，和汇总统计表的月汇总共用
     summarizeAttendanceMonth，避免出现两套口径。 */
  const rangeKey = () => grade+'|'+viewPeriod+'|'+(viewPeriod==='year' ? viewYear : summaryMonth);
  const rangeMonths = () => viewPeriod==='year'
    ? Array.from({length:12},(_,index)=>viewYear+'-'+String(index+1).padStart(2,'0'))
    : [summaryMonth];
  const rangeLabel = () => viewPeriod==='year' ? viewYear+' 年全年' : summaryMonth+' 整月';
  const loadRange = async () => {
    const state = { key:rangeKey(), loading:true, error:'', rows:[] };
    rangeState = state;
    paint();
    const selectedGrade = grade, roster = teachers, leaves = leaveRecords;
    try {
      const chunks = await Promise.all(rangeMonths().map(month =>
        api.get('/attendance', { grade:selectedGrade, month, include_rows:'1' })));
      if (rangeState !== state || grade !== selectedGrade) return;
      const merged = new Map();
      rangeMonths().forEach((month,index)=>{
        const rows = summarizeAttendanceMonth({month,grade:selectedGrade,teachers:roster,
          tables:chunks[index],leaveRecords:leaves});
        for (const row of rows) {
          const id = row.teacherId == null
            ? 'name:'+String(row.name||'').trim()+'|'+String(row.subject||'').trim() : 'id:'+row.teacherId;
          const acc = merged.get(id) || { ...row, seatPresent:0, classes:0, listens:0, research:0, leaveDays:0, leaveHours:0 };
          for (const field of ['seatPresent','classes','listens','research','leaveDays','leaveHours'])
            acc[field] += Number(row[field]) || 0;
          merged.set(id, acc);
        }
      });
      state.rows = [...merged.values()].map((row,index)=>({ ...row, serial:index+1 }));
    } catch (error) {
      if (rangeState === state) state.error = attendanceErrorText(error);
    } finally {
      if (rangeState === state) { state.loading = false; paint(); }
    }
  };
  /* 每张表只看和自己有关的累计行：上课表要上课或听课有数，请假表要有请假时长。 */
  const RANGE_FILTER = {
    roster:()=>true, seat:()=>true, summary:()=>true,
    class:row=>row.classes>0||row.listens>0,
    research:row=>row.research>0,
    leave:row=>row.leaveDays>0||row.leaveHours>0,
  };
  const rangeHtml = type => {
    const state = rangeState && rangeState.key===rangeKey() ? rangeState : null;
    const toolbar = '<div class="aprd-toolbar"><div class="aprd-toolbar-main">'+toolbarMainHtml(type,'',true)
      +'<span class="aprd-filter-count">按'+(viewPeriod==='year'?'年':'月')+'查看：'+esc(rangeLabel())+'</span></div>';
    if (!state || state.loading) return toolbar+'<div class="aprd-empty" role="status">正在按'+(viewPeriod==='year'?'年':'月')+'汇总…</div>';
    if (state.error) return toolbar+'<div class="aprd-empty" role="status">'+esc(state.error)
      +' <button type="button" class="aprd-op" data-range-retry>重新加载</button></div>';
    const teacherByName = new Map(teachers.map(item=>[String(item.name||'').trim(),item]));
    const visible = state.rows.filter(RANGE_FILTER[type]||(()=>true)).filter(matchesSheetFilter);
    const rows = visible.map((row,index)=>{
      const teacher = teacherByName.get(String(row.name||'').trim());
      return '<tr><td class="aprd-serial">'+(index+1)+'</td>'
        +'<td>'+esc(teacher?deptOf(teacher):row.department||'高中部')+'</td>'
        +'<td>'+esc(teacher?.grade||row.grade||grade)+'</td>'
        +'<td class="aprd-name">'+esc(row.name)+'</td><td>'+esc(row.subject||'')+'</td>'
        +'<td>'+countOf(row.seatPresent)+'</td><td>'+countOf(row.classes)+'</td>'
        +'<td>'+countOf(row.listens)+'</td><td>'+countOf(row.research)+'</td>'
        +'<td><span class="aprd-remark">—</span></td>'
        +'<td>'+esc(formatLeaveDuration({days:row.leaveDays,hours:row.leaveHours}))+'</td>'
        +'<td><span class="aprd-remark">—</span></td>'
        +'<td><div class="aprd-actions"><button type="button" class="aprd-op" disabled>编辑</button></div></td></tr>';
    }).join('');
    const totals = visible.reduce((sum,row)=>({
      seatPresent:sum.seatPresent+Number(row.seatPresent||0),classes:sum.classes+Number(row.classes||0),
      listens:sum.listens+Number(row.listens||0),research:sum.research+Number(row.research||0),
    }),{seatPresent:0,classes:0,listens:0,research:0});
    const kpis = [['累计教师',visible.length+'人'],['坐班次数',totals.seatPresent],['上课次数',totals.classes],
      ['听课人次',totals.listens],['教研次数',totals.research]];
    tabCorner = tabCornerHtml('', visible.length);
    return toolbar+'</div><div class="aprd-kpis aprd-grid-summary">'+kpis.map(([label,value])=>
      '<div class="aprd-kpi"><b>'+value+'</b><span>'+label+'</span></div>').join('')+'</div>'
      +'<div class="aprd-table-wrap"><table><thead><tr>'+ATTENDANCE_COLUMNS.seat.map(column=>'<th>'+column+'</th>').join('')
      +'</tr></thead><tbody>'+(rows||'<tr><td colspan="'+ATTENDANCE_COLUMNS.seat.length+'" class="aprd-empty">'
      +'当前筛选下'+esc(rangeLabel())+'没有累计记录</td></tr>')+'</tbody></table></div>';
  };
  /* 月/年回看时屏幕上是一张累计表，「当前批次 某天 第几节」和按日的批量导入/导出
     都跟它对不上（导的是当天那份），所以这里换成累计区间，并把那两个入口收掉。 */
  const rangeBatchHtml = () => {
    const months = rangeMonths();
    return '<div class="aprd-batch"><div class="aprd-batch-main"><span class="aprd-batch-label">累计区间</span>'
      + '<b>' + esc(rangeLabel()) + '</b><span>' + esc(grade) + '</span>'
      + '<span class="aprd-batch-period">' + esc(months[0] + ' 至 ' + months[months.length - 1]) + '</span></div>'
      + '<div class="aprd-batch-side"><span class="aprd-batch-note">按'
      + (viewPeriod === 'year' ? '年' : '月') + '累计，只读回看；逐格登记与批量导入导出请切回「按日」</span></div></div>';
  };
  const renderPage = () => {
    const rangeView = isRangeView(tab);
    const batch = rangeView ? rangeBatchHtml() : (TYPE[tab] ? batchBarHtml(tab) : '');
    const periodItems = DEFAULT_PERIODS;
    /* 月汇总还在加载时 builder 会提前返回，不会交右上角的操作，所以每次重新渲染先清空。 */
    tabCorner = '';
    const content = isRangeView(tab) ? rangeHtml(tab)
      : ['roster','seat','class','research'].includes(tab)?rosterHtml(tab):tab==='leave'?leaveHtml():summaryHtml();
    const periodRange = resolvePeriodRange(period);
    const byMonth = viewPeriod==='month', byYear = viewPeriod==='year';
    root.innerHTML='<div class="attendance-prd">'
      +'<header class="aprd-head"><div class="aprd-head-title"><h2>考勤管理</h2><p>按年级独立管理坐班、教研与上课记录；完成后人工确认生效</p></div>'
      +'<span class="aprd-live"><i></i>实时</span></header>'
      +'<div class="aprd-grade">'+grades.map(g=>'<button data-grade-tab="'+esc(g)+'" class="'+(g===grade?'on':'')+'">'+esc(g)+'</button>').join('')+'</div>'
      +'<div class="aprd-filter"><div class="aprd-filter-fields">'
      +'<label>查看 <select id="aprd-view-period"><option value="day"'+(byMonth||byYear?'':' selected')+'>按日</option>'
      +'<option value="month"'+(byMonth?' selected':'')+'>按月</option>'
      +'<option value="year"'+(byYear?' selected':'')+'>按年</option></select></label>'
      +(byMonth?'<label>月份 <input type="month" id="aprd-summary-month" value="'+summaryMonth+'"></label>'
      :byYear?'<label>年份 <input type="number" id="aprd-view-year" min="2000" max="2199" step="1" value="'+viewYear+'"></label>'
      :'<label>日期 <input type="date" id="aprd-date" value="'+date+'"></label>'
      +'<label>节次 <select id="aprd-period"><option value="0" '+(period===0?'selected':'')+'>全天</option>'+periodItems.map(p=>'<option value="'+p.no+'" '+(p.no===period?'selected':'')+'>'+esc(p.label)+'</option>').join('')+'</select></label>'
      /* 时段不再用 <input type=time>：浏览器按系统语言渲染成「上午 08:00 / 下午 06:35」，
         lang 属性也扭不过来（用户 11-22 要求一律 24 小时显示），改成自己校验的文本框。 */
      +'<label>时段 <span class="aprd-time-range">'
      +'<input class="aprd-hhmm" type="text" id="aprd-start" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="08:00" title="24 小时制，如 08:00" value="'+periodRange[0]+'">'
      +'<span class="aprd-time-sep">—</span>'
      +'<input class="aprd-hhmm" type="text" id="aprd-end" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="18:35" title="24 小时制，如 18:35" value="'+periodRange[1]+'">'
      +'</span></label>')
      +'</div></div>'
      +'<section class="aprd-card"><div class="aprd-tabs-row"><nav class="aprd-tabs">'+TABS.map(([id,label])=>'<button data-tab="'+id+'" class="'+(tab===id?'on':'')+'">'+label+'</button>').join('')+'</nav>'
      +(tabCorner&&!rangeView?'<div class="aprd-tab-actions">'+tabCorner+'</div>':'')+'</div>'
      +'<div class="aprd-panel">'+batch+content+'</div></section></div>';
    root.querySelector('[data-scroll-dirty]')?.addEventListener('click',()=>{
      const row=root.querySelector('.aprd-dirty')?.closest('tr');
      if(!row)return;
      row.scrollIntoView({behavior:'smooth',block:'center'});
      row.classList.add('aprd-row-flash');
      setTimeout(()=>row.classList.remove('aprd-row-flash'),1400);
    });
    root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=async()=>{
      if(busy || generating || !await flushBeforeSwitch())return;
      tab=b.dataset.tab;
      search='';subject='';
      /* 切页签只是换一张表看，名单和状态都已经在内存里；这里再去 await load()
         等于每点一次页签把 6 个接口重跑一遍，「切换后要好久才生效」就是这个
         （用户 11-22 反馈）。只有月/年累计和月度快照是现拉的，才需要等。 */
      if(viewPeriod==='day')paint();
      else if(isRangeView(tab))await loadRange();
      else if(isMonthlySummary(tab))await loadMonth();
      else paint();
    });
    root.querySelector('[data-leave-show-all]')?.addEventListener('click',()=>{leaveOnlyDate='';paint();});
    root.querySelectorAll('[data-grade-tab]').forEach(b=>b.onclick=async()=>{if(busy||generating||!await flushBeforeSwitch())return;grade=b.dataset.gradeTab;leaveOnlyDate=date;await load();});
    const dateInput=root.querySelector('#aprd-date');
    if(dateInput)dateInput.onchange=async e=>{
      if(busy||generating||!e.target.value||!await flushBeforeSwitch()){e.target.value=date;return;}
      date=e.target.value;summaryMonth=date.slice(0,7);leaveOnlyDate=date;await load();
    };
    const periodInput=root.querySelector('#aprd-period');
    if(periodInput)periodInput.onchange=async e=>{if(busy||generating||!await flushBeforeSwitch()){e.target.value=String(period);return;}period=Number(e.target.value);paint();};
    const viewPeriodInput=root.querySelector('#aprd-view-period');
    if(viewPeriodInput)viewPeriodInput.onchange=async e=>{
      if(busy||generating){e.target.value=viewPeriod;return;}
      const next=['day','month','year'].includes(e.target.value)?e.target.value:'day';
      if(next===viewPeriod)return;
      if(next==='day'&&!await flushBeforeSwitch()){e.target.value=viewPeriod;return;}
      viewPeriod=next;
      if(viewPeriod!=='day')editingSheet='';
      await refreshView();
    };
    const viewYearInput=root.querySelector('#aprd-view-year');
    if(viewYearInput)viewYearInput.onchange=async e=>{
      if(busy||generating||!/^[0-9]{4}$/.test(e.target.value)){e.target.value=viewYear;return;}
      viewYear=e.target.value;
      await loadRange();
    };
    const monthInput=root.querySelector('#aprd-summary-month');
    if(monthInput)monthInput.onchange=async e=>{
      if(busy||generating||!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(e.target.value)){e.target.value=summaryMonth;return;}
      summaryMonth=e.target.value;
      await refreshView();
    };
    root.querySelector('[data-summary-retry]')?.addEventListener('click',loadMonth);
    root.querySelector('[data-range-retry]')?.addEventListener('click',loadRange);
    const rememberPeriodTime = () => {
      /* 文本框要认手打的 8:00，也认手机数字键盘打不出冒号的 0800；认不了就退回原值，
         别让半截时间进筛选（用户 11-22 要求时段一律 24 小时）。 */
      const to24 = (raw) => {
        const digits = raw.replace(/\D/g, '');
        const spaced = /[:：]/.test(raw) ? raw
          : digits.length === 3 ? digits[0] + ':' + digits.slice(1)
            : digits.length === 4 ? digits.slice(0, 2) + ':' + digits.slice(2) : raw;
        return cleanPeriodTime(spaced);
      };
      const hhmm = (id, fallback) => {
        const box = root.querySelector(id);
        if (!box) return '';
        const raw = String(box.value || '').trim();
        const value = to24(raw);
        if (value) box.value = value;
        else if (raw) { toast('时段按 24 小时写，例如 08:00', 'warn'); box.value = fallback; }
        return value || fallback;
      };
      const start=hhmm('#aprd-start',periodRange[0]);
      const end=hhmm('#aprd-end',periodRange[1]);
      if(start&&end&&start>=end){toast('结束时间必须晚于开始时间','warn');paint();return;}
      periodTimeEdits[[date,currentScheduleType(),grade,period].join('|')]={start,end};
    };
    root.querySelector('#aprd-start')?.addEventListener('change',rememberPeriodTime);
    root.querySelector('#aprd-end')?.addEventListener('change',rememberPeriodTime);
    const confirmButton=root.querySelector('[data-generate]');
    if(confirmButton)confirmButton.onclick=async()=>{
      if(generating)return;
      const type=tab;
      const label=confirmButton.textContent;
      generating=true;confirmButton.disabled=true;confirmButton.textContent='生成中…';
      try{await generateTable(type);}
      catch(e){toast(attendanceErrorText(e),'err');}
      finally{generating=false;if(confirmButton.isConnected){confirmButton.disabled=false;confirmButton.textContent=label;}}
    };
    root.querySelector('[data-edit-sheet]')?.addEventListener('click',()=>{
      if(generating)return;
      editingSheet=editKey(tab);
      if(tab==='leave')leaveOnlyDate=date;
      paint();
    });
    root.querySelector('[data-add-record]')?.addEventListener('click',()=>{if(!busy&&!generating)openAddRecord();});
    root.querySelector('[data-add-summary]')?.addEventListener('click',()=>{if(!busy&&!generating)openAddSummary();});
    root.querySelector('[data-summary-import]')?.addEventListener('click',()=>{if(!generating)openSummaryImport();});
    root.querySelector('[data-summary-recalculate]')?.addEventListener('click',async()=>{
      const scope=summaryDraftKey();
      if(generating || !await confirmDialog('按所选'+(isMonthlySummary('summary')?'月份':'日期')+'的考勤重新统计并替换当前汇总草稿？'))return;
      if(tab!=='summary' || scope!==summaryDraftKey())return;
      summaryDrafts.set(scope,summaryBaseRows());
      paint();
    });
    root.querySelectorAll('[data-summary-edit-row]').forEach(button=>button.onclick=()=>{
      if(generating)return;
      const index=Number(button.dataset.summaryEditRow), row=summaryRows()[index], scope=summaryDraftKey();
      const fields=[...SUMMARY_COUNT_FIELDS.map(([key,label])=>({key,label,type:'number',min:0,step:1,required:true})),
        {key:'leaveDuration',label:'请假时长'}];
      openEditor('编辑汇总统计 · '+row.name,fields,{...row,leaveDuration:summaryDuration(row)},async values=>{
        if(scope!==summaryDraftKey() || tab!=='summary')return;
        const rows=summaryRows().slice();
        rows[index]=updateAttendanceSummaryRow(row,values);
        summaryDrafts.set(scope,rows);
        editConfirmedSheet();
        paint();
      });
    });
    root.querySelector('[data-workspace-voice]').onclick=()=>{
      const type=TYPE[tab]?tab:'seat';
      const selectedPeriod=period,selectedDate=date,selectedGrade=grade;
      const cols=[{key:'class',label:'上课',type:'check'},{key:'sit',label:'坐班',type:'check'},{key:'listen',label:'听课',type:'check'},{key:'research',label:'教研',type:'check'}];
      voiceSheet({rows:teachers.map(t=>({teacher:t.name,subject:t.subject})),cols,dayParts:leaveDayParts(),onApply:items=>{
        if(period!==selectedPeriod||date!==selectedDate||grade!==selectedGrade){toast('日期、年级或节次已切换，请重新语音登记','warn');return;}
        let count=0;
        for(const item of items){
          const matches=teachers.filter(t=>t.name===item.name&&(!item.subject||t.subject===item.subject));
          if(matches.length!==1)continue;
          const teacher=matches[0],key=item.leave?'leave':item.absent?({seat:'sit',class:'class',research:'research'}[type]):item.statusKey;
          if(!['leave','class','sit','listen','research'].includes(key))continue;
          updateTeacherGrid(getDraftRows(type),teacher,type,period,key,item.leave?(item.leaveType||'事假'):item.absent?'n':'y',{leaveRecords,date});count++;
        }
        tab=type;editingSheet=editKey(type);paint();toast('已应用 '+count+' 条语音记录'+(count<items.length?'，未匹配或同名记录请核对':''),'ok',5000);
        scheduleAutoSave(type);
      }});
    };
    const searchInput = root.querySelector('#aprd-search');
    const restoreSearchFocus = target => {
      const position = target.selectionStart ?? target.value.length;
      paint();
      const next = root.querySelector('#aprd-search');
      next?.focus();
      next?.setSelectionRange(position,position);
    };
    searchInput?.addEventListener('compositionstart',()=>{isComposingSearch=true;});
    searchInput?.addEventListener('compositionend',event=>{
      isComposingSearch=false;
      search=event.target.value;
      restoreSearchFocus(event.target);
    });
    searchInput?.addEventListener('input',event=>{
      if(isComposingSearch || event.isComposing) return;
      search=event.target.value;
      restoreSearchFocus(event.target);
    });
    root.querySelector('#aprd-subject')?.addEventListener('change',e=>{subject=e.target.value;paint();});
    root.querySelectorAll('[data-grid-person]').forEach(control => {
      const teacher = teachers.find(item => String(item.id) === control.dataset.gridPerson);
      if (!teacher || !TYPE[tab]) return;
      const key = control.dataset.gridKey;
      const update = value => updateWorksheet(teacher,tab,key,value);
      if (['class','sit','listen','research'].includes(key)) control.onclick = async () => {
        if(generating)return;
        const draft=getDraftRows(tab);
        const state = tab==='seat' ? deriveTableGridState(teacher,tab,draft,{leaveRecords,date,period})
          : worksheetState(teacher,tab,draft);
        const value = nextTriState(control.dataset.gridValue || state[key]);
        const leaveText = rowLeaveOf(teacher);
        /* 请假记录跨整天，不能替他悄悄取消：这一节已经请假的人要勾别的状态，
           先让他去请假表把请假改掉，不然勾和请假会同时算进导出。 */
        if (value !== 'u' && leaveText) {
          toast(teacher.name+' 本时段已请假（'+leaveText+'），要改成'+GRID_STATE_LABELS[key]+'请先在请假表取消请假','warn',5000);
          return;
        }
        update(value);
        await applyGridExclusiveStates(teacher, tab, key, value);
        paint(); scheduleAutoSave(tab);
      };
      /* 备注列直接用行内输入框，写完（回车或失焦）即保存到本表的 __teacherGrid。 */
      else if (key === 'remark') control.addEventListener('change', () => {
        if(generating)return;
        update(String(control.value??'').trim()); scheduleAutoSave(tab);
      });
      else if (key === 'leave') control.addEventListener('change', async () => {
        if(generating)return;
        const value=String(control.value??'');
        update(value);
        /* 请假和勾是同一件事的两种说法：登记了请假，这一节就不能再算上课/坐班/听课/教研。 */
        if (value) await clearGridStatesForLeave(teacher, tab);
        scheduleAutoSave(tab);paint();
      });
      else control.addEventListener('change',() => {update(control.value);scheduleAutoSave(tab);});
    });
    /* 请假时间（用户 11-24）：数字 + 单位，单位选「天」时数字换成上午/下午/全天。
       改哪个控件都就地折算成天数存回本格子，确认生成时再落进请假记录。
       三个控件按教师 id 关联，不靠父容器取值 —— 单元格重绘时少一层依赖。 */
    root.querySelectorAll('[data-leave-unit]').forEach(unit => {
      const id = unit.dataset.leaveUnit;
      const num = root.querySelectorAll('[data-leave-amount="'+id+'"]')[0];
      const part = root.querySelectorAll('[data-leave-part="'+id+'"]')[0];
      const teacher = teachers.find(item => String(item.id) === String(id));
      if (!teacher || !num || !part || !TYPE[tab] || generating) return;
      const syncMode = () => {
        const byDay = unit.value === 'day';
        num.hidden = byDay; num.disabled = byDay;
        part.hidden = !byDay; part.disabled = !byDay;
        /* 从「天」切到「小时/月」时数字框是空的（天不填数字），补个 1 上去，
           否则 Number('') 变 0 直接被拦成「要大于 0」，用户还得再点一次。 */
        if (!byDay && !String(num.value ?? '').trim()) num.value = '1';
      };
      const commit = () => {
        const input = unit.value === 'day'
          ? { unit:'day', part:part.value }
          : { unit:unit.value, amount:Number(num.value) };
        const normalized = normalizeLeaveTime(input);
        if (!normalized) {
          toast(unit.value === 'month' ? '请假月数要大于 0' : '请假小时数要大于 0','warn');
          paint();
          return;
        }
        updateWorksheet(teacher, tab, 'leave_time', normalized);
        scheduleAutoSave(tab);
        paint();
      };
      unit.addEventListener('change',() => { syncMode(); commit(); });
      num.addEventListener('change', commit);
      part.addEventListener('change', commit);
    });
    root.querySelectorAll('[data-edit-work-record]').forEach(button=>button.onclick=()=>{
      const type=tab, teacher=teachers.find(item=>String(item.id)===button.dataset.editWorkRecord);
      if(!teacher||generating)return;
      const state=worksheetState(teacher,type,getDraftRows(type));
      const keys=type==='class'?['class','listen']:['research'];
      const options=[{value:'u',label:'空白'},{value:'y',label:'√'},{value:'n',label:'×'}];
      const fields=keys.map(key=>({key,label:key==='listen'?'听课人':GRID_STATE_LABELS[key],type:'select',options}));
      openEditor('编辑考勤记录 · '+teacher.name,[...fields,{key:'remark',label:'备注'}],state,async data=>{
        const leaveText = rowLeaveOf(teacher);
        /* 只挡「这次把勾改出来」：存量里本来就带着勾、又只想改备注的人，不能不让他保存。 */
        if (leaveText && keys.some(key=>data[key]!==state[key]&&(data[key]==='y'||data[key]==='n'))) {
          throw new Error(teacher.name+' 本时段已请假（'+leaveText+'），请先在请假表取消请假');
        }
        for(const key of [...keys,'remark'])if(data[key]!==state[key])updateWorksheet(teacher,type,key,data[key]);
        await persistDraft(type,{reload:false});
        /* 弹窗里一次能改两列（上课表有上课+听课人），落盘后按本表真实状态
           找出留下来的那一项，再去别的表清掉同一时段的旧勾。 */
        const after = deriveTableGridState(teacher, type, getDraftRows(type), { leaveRecords, date, period });
        const winner = GRID_STATE_PRIORITY.find(key=>after[key]==='y'||after[key]==='n');
        if (winner) await applyGridExclusiveStates(teacher, type, winner, after[winner]);
        editConfirmedSheet();
        paint();
      });
    });
    root.querySelectorAll('[data-delete-work-record]').forEach(button=>button.onclick=async()=>{
      const type=tab, teacher=teachers.find(item=>String(item.id)===button.dataset.deleteWorkRecord);
      if(!teacher||generating)return;
      /* 名单统一后每行都挂着删除按钮：这个人在本表这一节什么都没登记时别写空白行，
         否则点一次「删除」反而凭空多一条草稿记录。 */
      const own=worksheetState(teacher,type,getDraftRows(type));
      if(!(GRID_STATE_COLUMNS[type]||[]).some(key=>key!=='leave'&&own[key]&&own[key]!=='u')){
        toast('这个人在本表还没有登记，不用删','warn');return;
      }
      if(!await confirmDialog('删除这条考勤记录？'))return;
      if(type!==tab)return;
      for(const key of GRID_STATE_COLUMNS[type])if(key!=='leave')updateWorksheet(teacher,type,key,'u');
      editConfirmedSheet();
      scheduleAutoSave(type);paint();
    });
    root.querySelectorAll('[data-person]').forEach(b=>b.onclick=async()=>{
      const teacher=teachers.find(x=>String(x.id)===b.dataset.person);
      if(!teacher)return;
      try{
        if(b.dataset.key==='class')await handleClassStatus(teacher);
        else if(b.dataset.key==='research')await handleResearchStatus(teacher);
        else await toggle(teacher,b.dataset.key==='sit'?'status':'listen');
      }catch(error){toast(error.message||'状态保存失败','err');}
    });
    root.querySelectorAll('[data-leave]').forEach(b=>b.onclick=()=>{
      const teacher=teachers.find(x=>String(x.id)===b.dataset.leave);
      if(!teacher)return;
      const existing=activeLeavesFor(leaveRecords,date,grade).find(x=>String(x.name||x.teacher||'').trim()===teacher.name);
      editLeaveRecord(existing,teacher);
    });
    root.querySelector('[data-add]')?.addEventListener('click',()=>{showAddTeacher=!showAddTeacher;paint();});
    root.querySelector('[data-roster-add-cancel]')?.addEventListener('click',()=>{showAddTeacher=false;paint();});
    root.querySelector('#aprd-roster-add-form')?.addEventListener('submit',async event=>{
      event.preventDefault();
      const form=event.currentTarget;
      const submit=form.querySelector('[type="submit"]');
      const values=Object.fromEntries(new FormData(form));
      const name=String(values.name||'').trim();
      const subjectName=String(values.subject||'').trim();
      const department=String(values.department||'').trim();
      const teacherGrade=String(values.grade||'').trim();
      if(teacherGrade&&teacherGrade.length>12){toast('归属年级需为1至12字','warn');return;}
      if(!name&&!subjectName&&!teacherGrade&&!department){toast('请至少填写一项','warn');return;}
      submit.disabled=true;
      submit.textContent='保存中…';
      try{
        /* 新学科/新年级/新部门就地入清单：其他几张表的候选下拉、筛选同步生效（用户 11-25 要求） */
        const createdNotes=[];
        if(subjectName&&!teacherSubjects().includes(subjectName)){
          await saveSubjectList([...subjectList(),subjectName]);
          createdNotes.push('学科「'+subjectName+'」已加入清单');
        }
        if(teacherGrade&&!grades.includes(teacherGrade)){
          await api.post('/grades',{name:teacherGrade});
          createdNotes.push('年级「'+teacherGrade+'」已创建');
        }
        if(department){
          const knownDepartments=[...new Set([...(prefs.departments?.[grade]||[]),...teachers.map(item=>String(deptOf(item)||'').trim()),'高中部'].filter(Boolean))];
          if(!knownDepartments.includes(department)){
            const departments={...(prefs.departments||{}),[grade]:[...new Set([...(prefs.departments?.[grade]||[]),department])]};
            await savePrefs({departments});
            createdNotes.push('部门「'+department+'」已保存');
          }
        }
        if(!name){
          /* 只填了学科/年级/部门：清单已入库，不需要动花名册 */
          if(createdNotes.length){editConfirmedSheet();await load();toast(createdNotes.join('；'),'ok',5000);}
          else toast('没有需要保存的新内容','warn');
          return;
        }
        /* 姓名两用：与当前年级花名册同名 → 编辑其学科/年级/部门；新姓名 → 新建教师 */
        const existing=teachers.find(item=>String(item.name||'').trim()===name);
        if(existing){
          const targetGrade=teacherGrade||existing.grade||grade;
          await api.patch('/teachers/'+existing.id,{name,subject:subjectName||existing.subject||'',grade:targetGrade});
          if(department)await setTeacherMeta(existing,{department});
          editConfirmedSheet();
          await load();
          toast('教师「'+name+'」资料已更新'+(createdNotes.length?'；'+createdNotes.join('；'):''),'ok',5000);
          return;
        }
        const targetGrade=teacherGrade||grade;
        await api.post('/teachers',{grade:targetGrade,name,subject:subjectName||''});
        grade=targetGrade;
        const updated=await api.get('/teachers',{grade,active:'all'});
        const created=(updated.list||[]).find(item=>String(item.name||'').trim()===name);
        if(created)await setTeacherMeta(created,{department:department||'高中部'});
        editConfirmedSheet();
        await load();
        toast('教师「'+name+'」已新增'+(createdNotes.length?'；'+createdNotes.join('；'):''),'ok',5000);
      }catch(error){
        submit.disabled=false;
        submit.textContent='保存';
        toast(error.message||'保存失败','err');
      }
    });
    const rosterImportButton=root.querySelector('[data-roster-import]');
    if(rosterImportButton){
      rosterImportButton.type='button';
      rosterImportButton.addEventListener('click',(event)=>{event.preventDefault();openRosterImport();});
    }
    root.querySelector('[data-roster-export-toggle]')?.addEventListener('click',()=>{
      const menu=root.querySelector('[data-roster-export-menu]');
      if(menu)menu.hidden=!menu.hidden;
    });
    root.querySelectorAll('[data-roster-export]').forEach(button=>button.addEventListener('click',()=>exportRoster(button.dataset.rosterExport)));
    const watermarkToggle=root.querySelector('#aprd-export-watermark');
    const watermarkInput=root.querySelector('#aprd-export-watermark-text');
    watermarkToggle?.addEventListener('change',()=>{
      watermarkOn=watermarkToggle.checked;
      if(!watermarkInput)return;
      watermarkInput.disabled=!watermarkOn;
      if(watermarkOn)watermarkInput.focus();
    });
    watermarkInput?.addEventListener('input',()=>{watermarkText=watermarkInput.value;});
    root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
      const t=teachers.find(x=>String(x.id)===b.dataset.edit);if(!t)return;
      /* 候选统一用下拉：与新增教师一致，避免浏览器自带候选浮层各弹各的。 */
      const subjectOptions=[...new Set([...teacherSubjects(),String(t.subject||'').trim()].filter(Boolean))];
      const gradeOptions=[...new Set([...grades,String(t.grade||grade).trim()].filter(Boolean))];
      openEditor('编辑教师',[{key:'name',label:'姓名',required:true},{key:'subject',label:'学科',type:'select',required:true,options:subjectOptions.map(value=>({value,label:value}))},{key:'grade',label:'归属年级',type:'select',required:true,options:gradeOptions.map(value=>({value,label:value}))},{key:'department',label:'归属部门'},{key:'remark',label:'备注'}],{name:t.name,subject:t.subject,grade:t.grade||grade,department:deptOf(t),remark:noteOf(t)},async d=>{
        const target=String(d.grade||'').trim();if(!target||target.length>12)throw new Error('归属年级必须为1至12字');
        await api.patch('/teachers/'+t.id,{name:d.name,subject:d.subject,grade:target});
        if(!grades.includes(target))await api.post('/grades',{name:target});
        await setTeacherMeta(t,{department:d.department,remark:d.remark});
        grade=target;
        editConfirmedSheet();
        await load();
      });
    });
    root.querySelectorAll('[data-disable]').forEach(b=>b.onclick=async()=>{
      if(generating || !await confirmDialog('删除该教师？历史考勤记录将保留，教师可从回收站恢复。'))return;
      try{
        await api.del('/teachers/'+b.dataset.disable);
        editConfirmedSheet();
        await load();
      }catch(error){toast(error.message||'删除失败','err');}
    });
    root.querySelector('[data-add-leave]')?.addEventListener('click',()=>editLeaveRecord(null,teachers[0]));
    root.querySelectorAll('[data-delete-leave]').forEach(b=>b.onclick=async()=>{
      if(!await confirmDialog('删除这条请假记录？'))return;
      const record=leaveRecords.find(x=>String(x.id)===b.dataset.deleteLeave);
      try{
        await setGridLeaveMark(record,'');
        leaveRecords=leaveRecords.filter(x=>String(x.id)!==b.dataset.deleteLeave);
        await savePrefs({leaves:leaveRecords});
        editConfirmedSheet();
        await load();
      }catch(error){toast(error.message||'删除失败','err');}
    });
    root.querySelectorAll('[data-edit-leave]').forEach(b=>b.onclick=()=>{
      const record=leaveRecords.find(x=>String(x.id)===b.dataset.editLeave);
      if(record)editLeaveRecord(record);
    });
    /* 备注列行内输入：花名册写教师级备注，请假表写请假记录备注（用户 11-15 要求）。 */
    root.querySelectorAll('[data-roster-note]').forEach(input=>input.addEventListener('change',async()=>{
      const teacher=teachers.find(item=>String(item.id)===input.dataset.rosterNote);
      if(!teacher)return;
      try{await setTeacherMeta(teacher,{remark:String(input.value??'').trim()});}
      catch(error){toast(error.message||'备注保存失败','err');}
    }));
    root.querySelectorAll('[data-leave-note]').forEach(input=>input.addEventListener('change',async()=>{
      const remark=String(input.value??'').trim();
      try{await queueSave(async()=>{
        const next=leaveRecords.map(item=>String(item.id)===input.dataset.leaveNote ? {...item,remark} : item);
        await savePrefs({leaves:next});
        leaveRecords=next;
      });}
      catch(error){toast(error.message||'备注保存失败','err');}
    }));

    root.querySelector('[data-add-class]')?.addEventListener('click',()=>openEditor('新增班级上课记录',[
      {key:'class_name',label:'班级',required:true},
      {key:'teacher',label:'任课教师',type:'select',options:teachers.map(item=>({value:item.name,label:item.name}))},
      {key:'period',label:'节次',type:'select',options:DEFAULT_PERIODS.map(item=>({value:item.no,label:item.label}))},
      {key:'status',label:'上课状态',type:'select',options:[{value:'u',label:'未登记'},{value:'y',label:'已上课'},{value:'n',label:'未上课'}]},
      {key:'listeners',label:'听课教师'},{key:'remark',label:'备注',type:'textarea'},
    ],{period:String(period),status:'u'},async data=>{
      const teacher=teachers.find(item=>item.name===data.teacher);
      if(!teacher)throw new Error('请先选择任课教师');
      getDraftRows('class').push({teacher:teacher.name,subject:teacher.subject||'',__draftNew:true,data:{__classRecord:{
        class_name:String(data.class_name||'').trim(),period:Number(data.period??period),status:data.status||'u',
        listeners:String(data.listeners||'').split(/[、,，]/).map(item=>item.trim()).filter(Boolean),remark:data.remark||'',
      }}});
      paint();
    }));
    root.querySelectorAll('[data-class-index]').forEach(el=>el.addEventListener('change',()=>{
      const row=getDraftRows('class')[Number(el.dataset.classIndex)];
      if(!row)return;
      const data={...rowData(row)},record={...(data.__classRecord||{period:Number(period),status:'u',listeners:[],remark:''})};
      if(el.dataset.k==='listeners')record.listeners=el.value.split(/[、,，]/).map(item=>item.trim()).filter(Boolean);
      else if(el.dataset.k==='period')record.period=Number(el.value);
      else record[el.dataset.k]=el.value;
      row.data={...data,__classRecord:record};
    }));
    root.querySelectorAll('[data-delete-class]').forEach(button=>button.addEventListener('click',()=>{
      const row=getDraftRows('class')[Number(button.dataset.deleteClass)];
      if(!row)return;
      row.data={...rowData(row),__deleted:true};paint();
    }));
    root.querySelector('[data-save-class]')?.addEventListener('click',async()=>{try{await persistDraft('class');toast('上课表修改已保存','ok');}catch(error){toast(attendanceErrorText(error),'err');}});




    root.querySelectorAll('[data-seat]').forEach(el=>el.addEventListener('change',()=>{
      const teacher=teachers.find(item=>String(item.id)===String(el.dataset.seat));
      if(!teacher)return;
      const row=getDraftRows('seat').find(item=>item.teacher===teacher.name);
      if(!row)return;
      const data={...rowData(row)},periods={...(data.__periods||{})},record={...(periods[String(period)]||{})};
      record[el.dataset.k]=el.value;periods[String(period)]=record;row.data={...data,__periods:periods};
    }));
    root.querySelector('[data-save-seat]')?.addEventListener('click',async()=>{try{await persistDraft('seat');toast('坐班表修改已保存','ok');}catch(error){toast(attendanceErrorText(error),'err');}});


    root.querySelector('[data-add-research]')?.addEventListener('click',()=>{
      const subjects=teacherSubjects();
      openEditor('新增教研安排',[
        {key:'subject',label:'学科',type:'select',options:subjects.map(item=>({value:item,label:item}))},
        {key:'period_time',label:'节次/时间',required:true},
        {key:'location',label:'地点'},
        {key:'host',label:'主持人',type:'select',options:teachers.map(item=>({value:item.name,label:item.name}))},
        {key:'remark',label:'备注',type:'textarea'},
      ],{subject:subjects[0]||'',period_time:(period===0?'全天':'第'+period+'节'),location:'',host:teachers[0]?.name||'',remark:''},async data=>{
        const subjectName=String(data.subject||'').trim();
        const members=teachers.filter(item=>String(item.subject||'').trim()===subjectName).map(item=>item.name);
        const draftRows=getDraftRows('research');
        let row=draftRows.find(item=>String(rowData(item).__research?.subject||item.subject||item.teacher||'').trim()===subjectName
          && matchesAttendancePeriod(rowData(item).__research?.period_time,period));
        if(!row){row={teacher:subjectName,subject:subjectName,data:{}};draftRows.push(row);}
        const old=rowData(row).__research||{};
        const picked=await chooseResearchAttendees(members,Array.isArray(old.attendees)?old.attendees:members);
        if(picked===null)return;
        row.data={...rowData(row),__research:{...old,...data,subject:subjectName,expected:members.length,
          attendees:picked,absent:members.filter(name=>!picked.includes(name)),status:picked.length?'已登记':'待登记'}};
        paint();
      });
    });
    root.querySelectorAll('[data-research-toggle]').forEach(button=>button.addEventListener('click',()=>{
      const teacher=teachers.find(item=>String(item.id)===String(button.dataset.researchToggle));
      if(!teacher)return;
      const row=getDraftRows('research').find(item=>String(rowData(item).__research?.subject||item.subject||item.teacher||'').trim()===String(teacher.subject||'').trim()
        && matchesAttendancePeriod(rowData(item).__research?.period_time,period));
      if(!row)return;
      const record={...(rowData(row).__research||{})},members=teachers.filter(item=>String(item.subject||'').trim()===String(teacher.subject||'').trim()).map(item=>item.name);
      const attendees=new Set(Array.isArray(record.attendees)?record.attendees:[]);
      if(attendees.has(teacher.name))attendees.delete(teacher.name);else attendees.add(teacher.name);
      const present=members.filter(name=>attendees.has(name));
      row.data={...rowData(row),__research:{...record,subject:teacher.subject,expected:members.length,attendees:present,
        absent:members.filter(name=>!present.includes(name)),status:present.length?'已登记':'待登记'}};
      paint();
    }));
    root.querySelectorAll('[data-research-edit]').forEach(button=>button.addEventListener('click',()=>{
      const teacher=teachers.find(item=>String(item.id)===String(button.dataset.researchEdit));
      if(!teacher)return;
      const subjectName=String(teacher.subject||'').trim(),members=teachers.filter(item=>String(item.subject||'').trim()===subjectName).map(item=>item.name);
      const row=getDraftRows('research').find(item=>String(rowData(item).__research?.subject||item.subject||item.teacher||'').trim()===subjectName
        && matchesAttendancePeriod(rowData(item).__research?.period_time,period));
      if(!row)return;
      const old={...(rowData(row).__research||{})};
      openEditor('修改教研安排',[
        {key:'period_time',label:'节次/时间',required:true},
        {key:'location',label:'地点'},
        {key:'host',label:'主持人',type:'select',options:teachers.map(item=>({value:item.name,label:item.name}))},
        {key:'remark',label:'备注',type:'textarea'},
      ],{period_time:old.period_time||(period===0?'全天':'第'+period+'节'),location:old.location||'',host:old.host||teacher.name,remark:old.remark||''},async data=>{
        const picked=await chooseResearchAttendees(members,Array.isArray(old.attendees)?old.attendees:[]);
        if(picked===null)return;
        row.data={...rowData(row),__research:{...old,...data,subject:subjectName,expected:members.length,
          attendees:picked,absent:members.filter(name=>!picked.includes(name)),status:picked.length?'已登记':'待登记'}};
        paint();
      });
    }));
    root.querySelector('[data-save-research]')?.addEventListener('click',async()=>{try{await persistDraft('research');toast('教研表修改已保存','ok');}catch(error){toast(attendanceErrorText(error),'err');}});
  };
  /* 勾选/编辑后是整块重绘（root.innerHTML 全换），浏览器会把滚动位置归零：
     勾第 12 行就跳回表格顶部，没法连续登记。这里在重绘前后记住窗口和表格的
     滚动位置再还原，勾在哪里就还停在哪个位置。 */
  const paint = () => {
    const table = root.querySelector('.aprd-table-wrap');
    const tableTop = table ? table.scrollTop : 0;
    let winTop = 0;
    if (typeof window !== 'undefined') winTop = window.scrollY || document.documentElement.scrollTop || 0;
    renderPage();
    const nextTable = root.querySelector('.aprd-table-wrap');
    if (nextTable && tableTop) nextTable.scrollTop = tableTop;
    if (winTop) window.scrollTo(0, winTop);
  };
  await load();
}
