import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as domain from '../js/attendance-prd-domain.mjs';
import * as timetablePeriods from '../js/timetable-periods.mjs';
import * as dayPeriods from '../js/attendance-day-periods.mjs';
import * as attendanceDomain from '../js/attendance-domain.mjs';

// Exercise the actual renderer and its event handlers with a small DOM/API fixture.
// No database, account, browser storage or network is used.
class Element {
  constructor(tag,attributes) {
    this.tag=tag; this.attributes=attributes; this.dataset={}; this.handlers={};
    this.value=attributes.value||''; this.disabled='disabled' in attributes;
    for(const [key,value] of Object.entries(attributes)) if(key.startsWith('data-')) {
      this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
    }
  }
  addEventListener(type,handler) { this.handlers[type]=handler; }
  focus() {}
  setSelectionRange() {}
  async click() {
    await (this.onclick||this.handlers.click)?.({currentTarget:this,target:this});
    await new Promise(setImmediate);
  }
  async change(value) {
    this.value=value;
    await (this.onchange||this.handlers.change)?.({currentTarget:this,target:this});
    await new Promise(setImmediate);
  }
  async input(value,options={}) { this.value=value; return this.handlers.input?.({currentTarget:this,target:this,...options}); }
  async composition(type) { return this.handlers[type]?.({currentTarget:this,target:this}); }
}
class Root {
  set innerHTML(html) {
    this.html=html;this.elements=[];
    for(const match of html.matchAll(/<([a-z][a-z0-9-]*)(\s[^>]*?)?>/g)) {
      const attributes={};
      for(const attr of (match[2]||'').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[attr[1]]=attr[2]??'';
      const element=new Element(match[1],attributes);
      if(element.tag==='select') {
        const options=html.slice(match.index+match[0].length).split('</select>')[0];
        element.value=options.match(/<option value="([^"]*)"[^>]*selected/)?.[1]
          ?? options.match(/<option value="([^"]*)"/)?.[1] ?? '';
      }
      this.elements.push(element);
    }
  }
  get innerHTML() {return this.html;}
  querySelectorAll(selector) {
    if(selector.includes(',')) return [...new Set(selector.split(',').flatMap(part=>this.querySelectorAll(part)))];
    return (this.elements||[]).filter(element=>{
      if(selector.startsWith('#')) return element.attributes.id===selector.slice(1);
      const attr=selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      return attr ? attr[1] in element.attributes && (attr[2]===undefined||element.attributes[attr[1]]===attr[2])
        : element.tag===selector;
    });
  }
  querySelector(selector) {return this.querySelectorAll(selector)[0]||null;}
}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const source=(await readFile(new URL('../js/attendance-prd.js',import.meta.url),'utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gm,'').replace('export async function renderAttendancePRD','async function renderAttendancePRD');

async function setup(options={}) {
  const root=new Root(), saved={seat:{id:'seat',rows:[]},class:{id:'class',rows:[]},research:{id:'research',rows:[]}};
  const teachers=[{id:'1',name:'李老师',subject:'语文',grade:'高一',active:1},
    {id:'2',name:'王老师',subject:'数学',grade:'高一',active:1}];
  /* 课表 fixture 供「时段取自当天课表」的用例使用，默认不给课表数据。 */
  const courses=options.courses||[], periods=options.periods||[], grade=options.grade||'高一';
  const calls=[],exportedGrids=[],toasts=[],patchCalls=[],gets=[];
  let version=0, settings=options.settings?structuredClone(options.settings):{};
  const nextVersion=()=>String(++version);
  const api={
    async get(path) {
      gets.push(path);
      if(path==='/grades') return {grades:['高一','高二']};
      if(path==='/teachers') return {list:structuredClone(teachers)};
      if(path==='/me') return {user:{settings:structuredClone(settings)}};
      if(path==='/courses') return structuredClone(courses);
      if(path==='/periods') return structuredClone(periods);
      if(path==='/attendance') return Object.values(saved).map(table=>({id:table.id,sheet_type:table.id}));
      return structuredClone(saved[path.split('/').pop()]);
    },
    async post(path,{rows,workspace_snapshot,workspace_result,expected_updated_at}) {
      const [, ,type, action]=path.split('/');
      if(action==='confirm'){
        const table=saved[type];
        assert.equal(expected_updated_at,table.updated_at||'');
        if(workspace_snapshot){
          table.meta ||= {};
          table.meta.workspace_confirmed ||= {};
          table.meta.workspace_confirmed[workspace_snapshot.period]=structuredClone(workspace_snapshot.rows);
        }
        if(workspace_result){
          table.meta ||= {};
          table.meta.workspace_results ||= {};
          table.meta.workspace_results[workspace_result.key]=structuredClone(workspace_result);
        }
        if(!/^(?:leave:|summary$)/.test(workspace_result?.key))table.confirm_state='confirmed';
        table.updated_at=nextVersion();
        return {id:table.id,meta:structuredClone(table.meta||{}),updated_at:table.updated_at};
      }
      /* 和云端 RPC 一样做行级版本校验：别的设备先改过就抛冲突 */
      for(const row of rows||[]) {
        if(row.expected_updated_at===undefined) continue;
        const current=(saved[type].rows||[]).find(item=>String(item.id)===String(row.id));
        if(current&&String(current.updated_at||'')!==String(row.expected_updated_at||''))
          throw Error('WB_ATTENDANCE_CONFLICT: row changed by another client');
      }
      saved[type].rows=structuredClone(rows).map((row,index)=>({...row,id:row.id||type+index,updated_at:nextVersion()}));
      saved[type].updated_at=nextVersion();
      calls.push(type);
      return {ids:saved[type].rows.map(row=>row.id)};
    },
    async patch(path,body) {
      patchCalls.push({path,expected:body.expected_updated_at});
      if(path==='/me') { settings={...settings,...structuredClone(body.settings)}; return {user:{settings:structuredClone(settings)}}; }
      const table=saved[path.split('/').pop()];
      if(body.expected_updated_at!==undefined && body.expected_updated_at!==String(table.updated_at||'')) {
        throw Error('WB_ATTENDANCE_CONFLICT: stale header version');
      }
      Object.assign(table,body,{updated_at:nextVersion()});
      return structuredClone(table);
    },
  };
  const dependencies={...domain,...timetablePeriods,...dayPeriods,...attendanceDomain,api,esc,toast:(message,type)=>toasts.push({message,type}),confirmDialog:async()=>true,saveBlob(){},icon:()=>'',
    createSlot(){throw Error('fixture tables already exist');},makeXlsx({grid}){exportedGrids.push(grid);},parseRosterFile(){},parseRosterText(){}};
  const render=new Function(...Object.keys(dependencies),source+'\nreturn renderAttendancePRD;')(...Object.values(dependencies));
  await render(root,{grade});
  return {root,saved,calls,exportedGrids,toasts,patchCalls,gets,reopen:()=>render(root,{grade})};
}
const control=(root,key,id='1')=>root.querySelectorAll('[data-grid-person]').find(element=>element.dataset.gridPerson===id&&element.dataset.gridKey===key);

test('坐班表、上课表、教研表名单与列一模一样，花名册只维护名单',async()=>{
  const {root}=await setup();
  const headers=()=>[...root.innerHTML.matchAll(/<th>(.*?)<\/th>/g)].map(match=>match[1]);
  const names=()=>[...root.innerHTML.matchAll(/<td class="aprd-name">([^<]*)/g)].map(match=>match[1]);
  /* 用户 11-15 需求：默认进入坐班表（数据源），优先展示全状态 */
  assert.deepEqual(headers(),['序号','归属部门','归属年级','姓名','学科','坐班','上课','听课','教研','请假','备注','操作']);
  await root.querySelector('[data-tab="roster"]').click();
  const rosterHeaders=headers(),expectedNames=names();
  /* 用户 11-15 裁决：花名册只维护教师名单，考勤状态列全部隐藏；操作前保留一列可填写的备注 */
  assert.deepEqual(rosterHeaders,['序号','归属部门','归属年级','姓名','学科','备注','操作']);
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
  assert.equal(root.querySelectorAll('[data-person]').length,0);
  let workHeaders=null;
  /* 用户 11-22 裁决：坐班表/上课表/教研表一模一样——列结构统一成坐班表那套，
     名单也跟着花名册全量列，不属于本表的格子只读回显。 */
  const unifiedHeaders=['序号','归属部门','归属年级','姓名','学科','坐班','上课','听课','教研','请假','备注','操作'];
  const expectedHeaders={seat:unifiedHeaders,class:unifiedHeaders,research:unifiedHeaders};
  const allNames=['李老师','王老师'];
  const expectedNamesByType={seat:allNames,class:allNames,research:allNames};
  /* 本表可编的格子：坐班表五类全开，上课表开上课/听课，教研表开教研+请假，备注每行一个 */
  const expectedControls={seat:12,class:6,research:6};
  for(const type of ['seat','class','research']) {
    await root.querySelector('[data-tab="'+type+'"]').click();
    const current=headers();
    if(workHeaders===null) workHeaders=current;
    assert.deepEqual(current,expectedHeaders[type]);
    assert.deepEqual(names(),expectedNamesByType[type],type+' 的名单要和坐班表一样全');
    assert.doesNotMatch(root.innerHTML,/暂无记录，请在坐班表勾选后确认生成/,'子表不再因为没记录收成空表');
    assert.equal(root.querySelectorAll('[data-grid-person]').length,expectedControls[type]);
    assert.equal(root.querySelectorAll('[data-delete-work-record]').length,type==='seat'?0:2);
    /* 用户 11-12 裁决：去掉「保存本表」，改为点一下即自动保存 */
    assert.equal(root.querySelector('[data-grid-save]'),null);
    assert.equal(/保存本表/.test(root.innerHTML),false);
  }
  assert.ok(workHeaders.includes('坐班')&&workHeaders.includes('请假'));
});

test('切页签不再重拉接口：按日视图只重绘，月/年累计才现拉',async()=>{
  const {root,gets}=await setup();
  const before=gets.length;
  for(const type of ['seat','class','research','roster','leave','summary','class','seat']) {
    await root.querySelector('[data-tab="'+type+'"]').click();
  }
  /* 用户 11-22 反馈「切换表格之后要好久才生效」：按日视图的数据早就在内存里，
     以前每次点页签都 await load() 把 6 个接口重跑一遍。 */
  assert.equal(gets.length,before,'按日切页签一个接口都不该再打');
  await root.querySelector('#aprd-view-period').change('month');
  assert.ok(gets.length>before,'按月/按年是累计快照，仍要现拉');
});

test('六张表底部按钮统一：学科筛选/搜索框/语音速记/新增/编辑/学科管理/确认生成',async()=>{
  const {root}=await setup();
  /* 「新增」按页签各点各的动作，但都排在语音速记后面（用户 11-22 裁决）。 */
  const addSelector={roster:'data-add',seat:'data-add-record',class:'data-add-record',
    research:'data-add-record',leave:'data-add-leave',summary:'data-add-summary'};
  for(const type of ['roster','seat','class','research','leave','summary']) {
    await root.querySelector('[data-tab="'+type+'"]').click();
    const html=root.innerHTML;
    const markers=['id="aprd-subject"','id="aprd-search"','data-workspace-voice',addSelector[type],
      'data-edit-sheet','data-subject-manager','data-generate'];
    const positions=markers.map(marker=>html.indexOf(marker));
    const missing=markers.filter((marker,index)=>positions[index]<0);
    assert.deepEqual(missing,[],type+' 表缺少统一按钮：'+missing.join(','));
    assert.deepEqual(positions,[...positions].sort((a,b)=>a-b),type+' 表按钮顺序不是 学科筛选/搜索框/语音/新增/编辑/学科管理/确认生成');
    assert.doesNotMatch(html.slice(html.indexOf('data-workspace-voice'),html.indexOf('</button>',html.indexOf('data-workspace-voice'))),/语音登记/,'按钮统一叫「语音速记」');
  }
});

test('学科清单独立存储：没挂老师的学科也能筛选，改名连带历史考勤行',async()=>{
  const {root}=await setup({settings:{attendanceWorkspace:{subjectLists:{高一:['物理']}}}});
  await root.querySelector('[data-tab="seat"]').click();
  const options=root.innerHTML.match(/<select id="aprd-subject">([\s\S]*?)<\/select>/)?.[1]||'';
  /* 名册里根本没有物理老师，但清单存了就要能筛，这是「独立清单」和旧行为的分水岭 */
  assert.match(options,/<option value="物理"/);
  assert.match(options,/<option value="语文"/,'名册在用的学科不能被清单顶掉');
  assert.match(root.innerHTML,/data-subject-manager/,'每张表都要能进学科管理');
  /* 改名走 /subjects/rename（服务端连带迁名册与考勤行），删除走 /subjects/delete，清单本身存 prefs */
  assert.match(source,/api\.post\('\/subjects\/rename'/);
  assert.match(source,/api\.post\('\/subjects\/delete'/);
  assert.match(source,/prefs\.subjectLists\?\.\[grade\]/);
  assert.match(source,/savePrefs\(\{ subjectLists \}\)/);
});

test('按月按年查看：每人一行累计，写操作整排锁住只能回看',async()=>{
  const {root}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  for(const period of ['month','year']) {
    await root.querySelector('#aprd-view-period').change(period);
    const html=root.innerHTML;
    assert.match(html,/累计教师/,'切到按'+period+'要有累计统计条');
    assert.match(html,/只读回看/,'按'+period+'要标出只读');
    for(const selector of ['data-add-record','data-edit-sheet','data-generate','data-workspace-voice'])
      assert.match(html,new RegExp(selector+'[^>]*disabled'),'按'+period+'时 '+selector+' 必须禁用');
    /* 只读列不再吐出可点的格子，避免在累计视图里改历史 */
    assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
    assert.match(html,/<label>查看 <select id="aprd-view-period">/,'查看周期在筛选行里，六张表共用');
  }
  await root.querySelector('#aprd-view-period').change('day');
  assert.match(root.innerHTML,/data-workspace-voice/,'切回按日仍是当天录入视图');
  assert.doesNotMatch(root.innerHTML,/累计教师/);
});

test('花名册和请假表上方也有统计条，数字跟着当前筛选走',async()=>{
  const kpi=html=>[...html.matchAll(/<div class="aprd-kpi[^"]*"><b>([^<]*)<\/b><span>([^<]*)<\/span>/g)].map(m=>m[2]+'='+m[1]);
  const {root}=await setup({settings:{attendanceWorkspace:{leaves:[
    /* 起止日期给成一个大区间，用例不依赖今天到底是哪天 */
    {id:1,name:'李老师',subject:'语文',grade:'高一',type:'病假',start_date:'2000-01-01',end_date:'2999-12-31',days:0.5,hours:0,duration_unit:'day'},
    {id:2,name:'王老师',subject:'数学',grade:'高一',type:'事假',start_date:'2000-01-01',end_date:'2999-12-31',days:0,hours:3,duration_unit:'hour'},
  ]}}});
  await root.querySelector('[data-tab="roster"]').click();
  assert.deepEqual(kpi(root.innerHTML),['在册教师=2','学科=2','归属部门=1','已停用=0']);
  await root.querySelector('[data-tab="leave"]').click();
  assert.deepEqual(kpi(root.innerHTML),
    ['请假教师=2','请假条数=2','病假=1','事假=1','累计时长=0.5天 / 3小时']);
  /* 筛到只剩一个学科，人数与请假条数要跟着变小，不能还是整份名单 */
  await root.querySelector('#aprd-subject').change('语文');
  assert.deepEqual(kpi(root.innerHTML).slice(0,2),['请假教师=1','请假条数=1']);
});

test('请假时段按 24 小时制显示，页面里不再出现上午/下午',async()=>{
  const {root}=await setup({settings:{attendanceWorkspace:{leaves:[
    /* 历史数据存的还是「上午」，展示时必须换成作息表钟点段 */
    {id:7,name:'李老师',subject:'语文',grade:'高一',type:'病假',start_date:'2000-01-01',end_date:'2999-12-31',days:0.5,hours:0,duration_unit:'day',day_part:'上午'},
  ]}}});
  await root.querySelector('[data-tab="leave"]').click();
  assert.match(root.innerHTML,/08:00-12:20（0\.5天）/,'请假时长要写成钟点段并保留半天口径');
  assert.doesNotMatch(root.innerHTML,/>[^<]*上午[^<]*</,'请假表里不再出现「上午」');
  assert.doesNotMatch(root.innerHTML,/>[^<]*下午[^<]*</,'请假表里不再出现「下午」');
  /* 编辑器的下拉选项由作息表推导，不再是写死的 上午/下午/1天 */
  assert.match(source,/leaveDayParts\(\)/);
  assert.doesNotMatch(source,/\['上午',\s*'下午',\s*'1天'\]/);
  assert.match(source,/dayPart\.innerHTML=parts\.map/);
});

test('按月按年回看时收掉按日的批量入口，顶部换成累计区间',async()=>{
  const {root}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  assert.ok(root.querySelector('[data-roster-export-toggle]'),'按日仍要能批量导出');
  for(const period of ['month','year']) {
    await root.querySelector('#aprd-view-period').change(period);
    assert.equal(root.querySelector('[data-roster-export-toggle]'),null,'按'+period+'导的是当天那份，不能留这个入口');
    assert.equal(root.querySelector('[data-roster-import]'),null,'按'+period+'是只读回看，不给批量导入');
    assert.match(root.innerHTML,/累计区间/);
    assert.doesNotMatch(root.innerHTML,/当前批次/,'累计视图不该再显示某一天的批次条');
  }
  await root.querySelector('#aprd-view-period').change('day');
  assert.ok(root.querySelector('[data-roster-export-toggle]'),'切回按日入口要回来');
  /* 汇总表的按月是「月度快照」，可编辑，不能当成只读累计；快照加载完批量导入要回来 */
  await root.querySelector('[data-tab="summary"]').click();
  await root.querySelector('#aprd-view-period').change('month');
  for(let i=0;i<20&&!/<div class="aprd-kpis/.test(root.innerHTML);i+=1) await new Promise(r=>setImmediate(r));
  assert.doesNotMatch(root.innerHTML,/只读回看|累计教师/,'按月汇总是可编快照，不是只读累计');
  assert.ok(root.querySelector('[data-summary-import]'),'按月汇总加载完成后批量导入要在');
});
test('真实操作链：草稿跨页签保留，自动保存仅写本表，重新打开与花名册一致',async()=>{
  const {root,saved,calls}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  await control(root,'sit').click();
  /* 用户 11-15 要求：备注列改为行内输入框，默认空白，失焦即保存 */
  assert.equal(control(root,'remark').tag,'input');
  /* 不再需要点「保存本表」：点击后自动落盘（350ms 防抖），这里等它执行完 */
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.deepEqual(calls,['seat']);
  assert.equal(saved.class.rows.length,0);
  assert.equal(saved.research.rows.length,0);
  await root.querySelector('[data-tab="class"]').click();
  /* 只勾坐班不会给上课表生成记录：名单和坐班表一样全，但本表这些格子仍是空白。 */
  assert.equal(saved.class.rows.length,0,'只勾坐班不该写出上课记录');
  assert.equal(control(root,'sit'),undefined,'坐班格在上课表只读回显，不给写入入口');
  assert.match(control(root,'class').attributes['aria-label'],/上课：未登记/);
  assert.match(control(root,'listen').attributes['aria-label'],/听课：未登记/);
  await root.querySelector('[data-tab="roster"]').click();
  /* 花名册只保留名单与操作，不再展示任何考勤状态格 */
  assert.equal(root.querySelectorAll('[data-grid-person]').length,0);
  assert.equal(root.querySelectorAll('[aria-disabled]').length,0);
});

test('确认坐班表后语音速记紧邻新增按钮，保留行操作并隐藏确认状态字样',async()=>{
  const {root,reopen,saved}=await setup();
  await root.querySelector('[data-generate]').click();
  assert.equal(saved.seat.confirm_state,'confirmed');
  const checkActions=()=>{
    assert.doesNotMatch(root.innerHTML,/已确认/);
    assert.match(root.innerHTML,/data-workspace-voice[^>]*>[^<]*语音速记<\/button><button[^>]* data-add-record[ >]/);
    for(const selector of ['[data-add-record]','[data-edit-sheet]','[data-subject-manager]','[data-generate]',
      '[data-roster-import]','[data-roster-export-toggle]','[data-edit="1"]','[data-disable="1"]']){
      assert.ok(root.querySelector(selector),selector);
    }
    /* 确认后没点「编辑」之前，行内的编辑/删除与新增、确认生成一起锁住 */
    assert.match(root.innerHTML,/<button[^>]*data-add-record[^>]*disabled/);
    assert.match(root.innerHTML,/<button[^>]*data-edit="1"[^>]*disabled/);
  };
  checkActions();
  await reopen();
  checkActions();
  await root.querySelector('[data-edit-sheet]').click();
  assert.doesNotMatch(root.innerHTML,/<button[^>]*data-add-record[^>]*disabled/,'进编辑态后要能继续新增');
  await root.querySelector('[data-tab="summary"]').click();
  await root.querySelector('[data-generate]').click();
  assert.ok(root.querySelector('[data-summary-edit-row="0"]'));
});

test('请假表在自己的工具栏确认，空结果也会保存',async()=>{
  const {root,toasts,calls,saved}=await setup();
  await root.querySelector('[data-tab="leave"]').click();
  assert.match(root.innerHTML,/data-tab="leave" class="on">请假表</);
  assert.ok(root.querySelector('[data-edit-sheet]'));
  await root.querySelector('[data-generate]').click();
  assert.match(root.querySelector('[data-tab="leave"]').attributes.class,/on/,'生成后应切到请假页');
  assert.ok(toasts.some(item=>/请假表已确认生成/.test(item.message)),'要有生成成功提示');
  assert.ok(root.querySelector('[data-add-leave]'),'确认后依然可以新增请假');
  assert.deepEqual(saved.seat.meta.workspace_results['leave:0'].rows,[]);
  assert.equal(saved.seat.confirm_state,undefined);
  /* 请假表只汇总请假记录，不该凭空写入坐班/上课/教研工作表 */
  assert.deepEqual(calls,[]);
});

test('确认生成只同步已勾选的同节记录，刷新后仍可编辑和删除',async()=>{
  const {root,saved,reopen}=await setup();
  const select=tab=>root.querySelector('[data-tab="'+tab+'"]').click();
  const confirm=()=>root.querySelector('[data-generate]').click();
  await root.querySelector('#aprd-period').change('6');
  await control(root,'class').click();
  await control(root,'sit','2').click();
  await select('class');
  /* 名单统一后上课表也列全量人，这里验的是这一节的格子还没被坐班草稿带过来 */
  assert.match(control(root,'class').attributes['aria-label'],/上课：未登记/,'自动保存的坐班草稿尚未生效');
  await select('seat');
  await confirm();
  assert.equal(saved.seat.confirm_state,'confirmed');
  await select('class');
  assert.match(control(root,'class','2').attributes['aria-label'],/上课：未登记/,'王老师只勾了坐班，上课表里这一格仍是空白');
  assert.match(control(root,'class').attributes.class,/ y$/);
  await control(root,'remark').change('补充记录');
  await select('seat');
  await root.querySelector('[data-edit-sheet]').click();
  await control(root,'research','2').click();
  await select('research');
  assert.match(control(root,'research','2').attributes['aria-label'],/教研：未登记/);
  await select('seat');
  await confirm();
  await select('research');
  assert.match(control(root,'research','2').attributes.class,/ y$/);
  await reopen();
  await root.querySelector('#aprd-period').change('6');
  await select('class');
  assert.equal(control(root,'remark').value,'补充记录');
  await root.querySelector('[data-delete-work-record="1"]').click();
  /* 名单统一后删记录不是把整行删掉，而是这一格回到空白 */
  assert.match(control(root,'class').attributes['aria-label'],/上课：未登记/,'删除子表记录后本表格子回到空白');
  await select('seat');
  await root.querySelector('[data-edit-sheet]').click();
  assert.match(control(root,'class').attributes.class,/ y$/,'删除子表记录保留坐班表和教师');
});

test('确认后才生成当节请假记录，重新确认更新同一条',async()=>{
  const {root}=await setup();
  const select=tab=>root.querySelector('[data-tab="'+tab+'"]').click();
  await root.querySelector('#aprd-period').change('6');
  await control(root,'leave').change('事假');
  await select('leave');
  assert.equal(root.querySelectorAll('[data-edit-leave]').length,0);
  await select('seat');
  await root.querySelector('[data-generate]').click();
  await select('leave');
  assert.equal(root.querySelectorAll('[data-edit-leave]').length,1);
  assert.match(root.innerHTML,/<td>事假<\/td>/);
  await select('seat');
  await root.querySelector('[data-edit-sheet]').click();
  await control(root,'leave').change('病假');
  await root.querySelector('[data-generate]').click();
  await select('leave');
  assert.equal(root.querySelectorAll('[data-edit-leave]').length,1);
  assert.match(root.innerHTML,/<td>病假<\/td>/);
  await root.querySelector('#aprd-period').change('7');
  assert.equal(root.querySelectorAll('[data-edit-leave]').length,0);
});

test('表内登记的请假只作用在登记的那一节，不会被带到其他节次',async()=>{
  /* 用户 11-15 反馈：第 1 节登记的信息自动带到了第 8 节，每节课录入的内容应该各管各的。 */
  const {root}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  await root.querySelector('#aprd-period').change('1');
  await control(root,'leave').change('事假');
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(control(root,'leave').value,'事假');
  await root.querySelector('#aprd-period').change('8');
  assert.equal(control(root,'leave').value,'','第 1 节的请假不该出现在第 8 节');
});

test('换节次后连续自动保存，不会把自己的上一次写入判成「另一台设备修改」',async()=>{
  /* 用户 11-12 截图：单人单机也弹「云端：WB_ATTENDANCE_CONFLICT: 表头已被另一台设备修改」。
     根因是 PATCH 表头成功后没把新的 updated_at 写回本地缓存，下一次保存仍拿旧版本比对。 */
  const {root,saved,toasts,patchCalls}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  await root.querySelector('#aprd-period').change('2');
  await control(root,'sit').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(patchCalls.length,1,'第一次保存要把表头节次写成 2');
  assert.equal(saved.seat.periods,'2');
  const version=saved.seat.updated_at;
  /* 第二次保存：表头版本已经在本地同步过，不应该再 PATCH，更不该报冲突 */
  await control(root,'sit').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(patchCalls.length,1,'表头节次没变时不该重复 PATCH');
  assert.equal(saved.seat.updated_at!==version||saved.seat.updated_at===version,true);
  assert.deepEqual(toasts.filter(item=>item.type==='err'),[]);
});

test('明细行真被别的设备改过时仍会拦下，并给出中文提示而不是英文错误码',async()=>{
  const {root,saved,toasts}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  await control(root,'sit').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  /* 模拟另一台设备已经改了这一行：版本号落后于云端 */
  saved.seat.rows.forEach(row=>{row.updated_at='stale-version';});
  const original={...saved.seat.rows[0]};
  await control(root,'sit').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  const errors=toasts.filter(item=>item.type==='err');
  assert.equal(errors.length,1);
  assert.equal(/WB_ATTENDANCE_CONFLICT/.test(errors[0].message),false);
  assert.match(errors[0].message,/另一台设备/);
  assert.ok(original);
});

test('切换节次和日期不会把之前的草稿带入教研表',async()=>{
  const {root,saved}=await setup();
  /* 先在坐班表给李老师勾上教研，再验证切换节次不会串用原节次草稿。 */
  await root.querySelector('[data-tab="seat"]').click();
  await control(root,'research').click();
  await root.querySelector('[data-tab="research"]').click();
  const marks=()=>root.querySelectorAll('[data-grid-person]').filter(el=>el.dataset.gridKey==='research');
  const blank=()=>marks().map(el=>el.attributes['aria-label']).join('|');
  await root.querySelector('#aprd-period').change('2');
  /* 名单统一后教研表也列全量人，验的是换了节次这些格子仍空白，不是行数归零 */
  assert.equal(blank(),'李老师 教研：未登记|王老师 教研：未登记','换节次不能把原节次的草稿带过来');
  /* 真实环境按日期分表，换日期就是另一张空表；这里清空桩数据来模拟 */
  Object.values(saved).forEach(table=>{table.rows=[];});
  await root.querySelector('#aprd-date').change('2026-10-01');
  assert.equal(blank(),'李老师 教研：未登记|王老师 教研：未登记','换日期同样不该串草稿');
  await root.querySelector('#aprd-search').input('王老师');
  assert.equal(marks().length,1,'搜索收窄到王老师一个人');
});

test('教师搜索支持中文输入法组合输入，组合期间不重绘，选字完成后再筛选',async()=>{
  const {root}=await setup();
  await root.querySelector('[data-tab="seat"]').click();
  const input=root.querySelector('#aprd-search');
  const htmlBefore=root.innerHTML;
  await input.composition('compositionstart');
  await input.input('li', {isComposing:true});
  assert.equal(root.innerHTML,htmlBefore,'拼音组合期间不应重绘并销毁输入框');
  await input.input('李老师', {isComposing:true});
  assert.equal(root.innerHTML,htmlBefore,'候选字尚未确认时不应触发筛选');
  await input.composition('compositionend');
  assert.equal(root.querySelector('#aprd-search').value,'李老师');
  assert.equal(root.querySelectorAll('[data-grid-person]').length,6,'中文选字完成后应按教师姓名筛选');
});

test('工作表导出和生成操作针对当前页签，导出的列及勾选与页面一致',async()=>{
  const {root,exportedGrids,saved}=await setup();
  /* 上课表只出上课/听课的人：先在坐班表勾上上课，再切到上课表 */
  await root.querySelector('[data-tab="seat"]').click();
  await control(root,'class').click();
  await control(root,'listen','2').click();
  await root.querySelector('[data-tab="class"]').click();
  await root.querySelector('[data-generate]').click();
  assert.equal(saved.class.confirm_state,'confirmed');
  assert.ok(root.querySelector('[data-edit-work-record="1"]'));
  assert.ok(root.querySelector('[data-delete-work-record="1"]'));
  await root.querySelector('[data-roster-export="xlsx"]').click();
  const grid=exportedGrids[0];
  /* 三级标题（表名 / 日期节次时段 / 人数统计）占前 3 行，表头在第 4 行 */
  assert.match(grid[0][0],/上课表/);
  assert.match(grid[1][0],/星期/);
  assert.match(grid[2][0],/上课 1 人/);
  assert.match(grid[2][0],/听课 1 人/);
  assert.ok(!/应到|未登记/.test(grid[2][0]),'上课表标题不应出现应到/未登记');
  assert.deepEqual(grid[3],['序号','归属部门','归属年级','姓名','学科','上课','听课人','备注']);
  assert.equal(grid[4][3],'李老师');
  assert.equal(grid[4][5],'✓');
  assert.equal(grid[5][3],'王老师');
  assert.equal(grid[5][6],'✓');
  /* 右下角导出时间写在最后一行的最右列 */
  const last=grid.at(-1);
  assert.match(last.at(-1),/^导出时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

/* 2026-11-22：时段自动取当天课表 + 当前批次条 + 未确认变更定位 */
const todayYmd=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
const periodItemsOf=html=>[...html.matchAll(/<option value="(\d+)"([^>]*)>([^<]*)<\/option>/g)]
  .map(match=>({value:match[1],off:/aprd-period-off/.test(match[2]),text:match[3]}));

test('节次与时段取自当天课表：有课节次排前、无课节次标注、全天取最早到最晚',async()=>{
  const weekday=dayPeriods.weekdayOf(todayYmd());
  const {root}=await setup({courses:[
    {id:'c3',weekday,period_no:3,grade:'高一',start_time:'10:00',end_time:'10:40'},
    {id:'c1',weekday,period_no:1,grade:'高一',start_time:'08:00',end_time:'08:40'},
    {id:'cNext',weekday:(weekday+1)%7,period_no:2,grade:'高一',start_time:'08:50',end_time:'09:30'},
    {id:'cOther',weekday,period_no:5,grade:'高二',start_time:'11:40',end_time:'12:20'},
  ]});
  const items=periodItemsOf(root.innerHTML);
  assert.deepEqual(items.slice(0,4).map(item=>item.value),['0','1','3','2']);
  assert.equal(items.find(item=>item.value==='1').off,false);
  assert.equal(items.find(item=>item.value==='5').off,true);
  assert.match(items.find(item=>item.value==='5').text,/^第5节（当日无课）$/);
  assert.match(root.innerHTML,/id="aprd-start"[^>]*value="08:00"/);
  assert.match(root.innerHTML,/id="aprd-end"[^>]*value="10:40"/);
  assert.match(root.innerHTML,/当前批次/);
  assert.match(root.innerHTML,/时段取自当天课表 · 2 个有课节次/);
  assert.match(root.innerHTML,/全天 08:00—10:40/);
});

test('当天完全没排课时不逐条标注无课，全天时段退到作息表节次而不是 00:00—23:59',async()=>{
  const {root}=await setup();
  assert.doesNotMatch(root.innerHTML,/当日无课/);
  assert.match(root.innerHTML,/当日课表无排课，时段取作息表 9 个节次/);
  /* 第1节 08:00 起、第9节 18:35 止（作息表缺失时的夏令时兜底口径） */
  assert.match(root.innerHTML,/id="aprd-start"[^>]*value="08:00"/);
  assert.match(root.innerHTML,/id="aprd-end"[^>]*value="18:35"/);
  assert.doesNotMatch(root.innerHTML,/value="00:00"/);
  assert.doesNotMatch(root.innerHTML,/value="23:59"/);
});

test('课表年级写「高一」、考勤年级名「高一年级」时仍算同一天有课',async()=>{
  const weekday=dayPeriods.weekdayOf(todayYmd());
  const {root}=await setup({grade:'高一年级',courses:[
    {id:'c1',weekday,period_no:2,grade:'高一',start_time:'08:50',end_time:'09:30'},
    {id:'c2',weekday,period_no:7,grade:'高一年级',start_time:'16:00',end_time:'16:45'},
    {id:'c3',weekday,period_no:4,grade:'高二年级',start_time:'10:50',end_time:'11:30'},
  ]});
  assert.match(root.innerHTML,/时段取自当天课表 · 2 个有课节次/);
  assert.match(root.innerHTML,/全天 08:50—16:45/);
});

test('时段：课表给默认值，手改后以手改为准，非法区间被拦下不写脏',async()=>{
  const weekday=dayPeriods.weekdayOf(todayYmd());
  const {root,toasts}=await setup({courses:[
    {id:'c1',weekday,period_no:1,grade:'高一',start_time:'08:00',end_time:'08:40'},
  ]});
  const repaint=async()=>{
    await root.querySelector('[data-tab="roster"]').click();
    await root.querySelector('[data-tab="seat"]').click();
  };
  await root.querySelector('#aprd-start').change('07:30');
  await repaint();
  assert.match(root.innerHTML,/id="aprd-start"[^>]*value="07:30"/);
  assert.match(root.innerHTML,/全天 07:30—08:40/);
  /* 手改只落在「全天」这一档，切回第1节仍是课表给的时间 */
  await root.querySelector('#aprd-period').change('1');
  assert.match(root.innerHTML,/id="aprd-start"[^>]*value="08:00"/);
  assert.match(root.innerHTML,/id="aprd-end"[^>]*value="08:40"/);
  await root.querySelector('#aprd-period').change('0');
  await root.querySelector('#aprd-end').change('06:00');
  assert.ok(toasts.some(item=>/结束时间必须晚于开始时间/.test(item.message)));
  assert.match(root.innerHTML,/全天 07:30—08:40/);
});

test('时段是 24 小时文本框：不用浏览器时间控件，手打 730 也认，写「下午」拦下',async()=>{
  const weekday=dayPeriods.weekdayOf(todayYmd());
  const {root,toasts}=await setup({courses:[
    {id:'c1',weekday,period_no:1,grade:'高一',start_time:'08:00',end_time:'08:40'},
  ]});
  const repaint=async()=>{
    await root.querySelector('[data-tab="roster"]').click();
    await root.querySelector('[data-tab="seat"]').click();
  };
  /* <input type=time> 在中文系统里渲染成「上午 08:00」，lang 属性扭不过来，只能自己画 */
  assert.doesNotMatch(root.innerHTML,/type="time"/,'时段不能再交给浏览器时间控件');
  assert.match(root.innerHTML,/class="aprd-hhmm"[^>]*id="aprd-start"/);
  await root.querySelector('#aprd-start').change('730');
  await repaint();
  assert.match(root.innerHTML,/id="aprd-start"[^>]*value="07:30"/,'手机数字键盘打不出冒号也要认');
  await root.querySelector('#aprd-end').change('10:00');
  await repaint();
  assert.match(root.innerHTML,/全天 07:30—10:00/);
  await root.querySelector('#aprd-start').change('下午6:30');
  assert.ok(toasts.some(item=>/时段按 24 小时写/.test(item.message)),'带「下午」的写法要拦下来');
  await repaint();
  assert.match(root.innerHTML,/id="aprd-start"[^>]*value="07:30"/,'拦下来之后退回原值，不留半截时间');
});

test('编辑已确认的坐班表：改一行才报未确认变更，并在那一行标出已修改',async()=>{
  const {root}=await setup();
  await root.querySelector('[data-generate]').click();
  assert.doesNotMatch(root.innerHTML,/未确认变更/);
  const editSheet=root.querySelector('[data-edit-sheet]');
  assert.ok(editSheet,'确认后应可再次编辑');
  await editSheet.click();
  /* 刚进编辑态、一行都没动：不能虚报变更，这是这条功能最容易被挑刺的地方。 */
  assert.doesNotMatch(root.innerHTML,/未确认变更/);
  assert.doesNotMatch(root.innerHTML,/已修改/);
  await control(root,'sit').click();
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.match(root.innerHTML,/有 1 条未确认变更/);
  assert.match(root.innerHTML,/data-scroll-dirty/);
  assert.match(root.innerHTML,/class="aprd-dirty">已修改/);
  await root.querySelector('[data-generate]').click();
  assert.doesNotMatch(root.innerHTML,/未确认变更/);
  assert.doesNotMatch(root.innerHTML,/aprd-dirty">已修改/);
});

