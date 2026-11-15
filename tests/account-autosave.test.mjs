import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './test-browser.mjs';

let scenario = 0;
const flush = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise(setImmediate); };

async function setup(context, { missing = false, failOnce = false } = {}) {
  const storage = installBrowser({ href: 'https://githubalong.github.io/mywork-master/' });
  globalThis.window = new EventTarget();
  const element = () => ({ style: {}, classList: { add() {} }, appendChild() {}, remove() {}, isConnected: false });
  document.getElementById = element;
  document.createElement = () => ({ content: { firstElementChild: element() } });
  const db = await import('../js/localdb.js');
  const uid = 'autosave-test-' + ++scenario;
  db.setActiveAccount(uid);
  storage.setItem('wb_supa_tok', JSON.stringify({ uid, access_token: 'test-only', expires_at: Date.now() + 3600000 }));
  let remote = missing ? null : { payload: { ...db.blank(), notes: [{ id: 1, title: 'original' }] }, revision: 1 };
  storage.setItem(db.DB_KEY, JSON.stringify(remote?.payload || db.blank()));
  const writes = [];
  let release = null;
  let hold = false;
  let shouldFail = failOnce;
  let failureMode='',enforceRevision=false,commitThenFail=false,failReads=false;
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/rpc/wb_save_user_data')) {
      const body = JSON.parse(options.body);
      writes.push(body);
      if(failureMode==='busy')return Response.json({message:'WB_DATA_WRITE_BUSY',code:'55P03'},{status:500});
      if (shouldFail) { shouldFail = false; throw new TypeError('Failed to fetch'); }
      if(enforceRevision && remote && Number(body.p_expected_revision)!==remote.revision){
        if(JSON.stringify(remote.payload)===JSON.stringify(body.p_payload))return Response.json([remote]);
        return Response.json({message:'WB_DATA_REVISION_CONFLICT',code:'40001'},{status:409});
      }
      if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
      remote = { payload: body.p_payload, revision: (remote?.revision || 0) + 1 };
      if(commitThenFail){commitThenFail=false;throw new TypeError('Response lost after commit');}
      return Response.json([remote]);
    }
    if(failReads)throw new TypeError('Offline snapshot read');
    return Response.json(remote ? [remote] : []);
  };
  const sync = await import('../js/cloudsync.js?autosave=' + scenario);
  await sync.initializeAccountSync();
  window.addEventListener('wb:localchange', sync.hookSave);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async (milliseconds = 800) => { context.mock.timers.tick(milliseconds); await flush(); };
  return { db, sync, storage, writes, advance, holdNext: () => { hold = true; }, release: () => release(),
    failure:mode=>{failureMode=mode;},failReads:value=>{failReads=value;},useRevision:()=>{enforceRevision=true;},loseResponse:()=>{commitThenFail=true;},readRemote:()=>remote,
    restart:async()=>{
      context.mock.timers.reset();context.mock.timers.enable({apis:['setTimeout']});
      globalThis.window=new EventTarget();db.replaceMemFromDisk();
      const restored=await import('../js/cloudsync.js?recovery='+uid+'-'+Math.random());
      await restored.initializeAccountSync();window.addEventListener('wb:localchange',restored.hookSave);return restored;
    },
    remote: payload => { remote = { payload, revision: (remote?.revision || 0) + 1 }; } };
}

test('opening a fresh account does not upload an unchanged initial snapshot', async context => {
  const state = await setup(context, { missing: true });
  await state.advance(10000);
  await state.sync.initializeAccountSync();
  await state.sync.pushNow();
  assert.equal(state.writes.length, 0);
});

test('repeated identical local saves and sync notifications produce no uploads', async context => {
  const state = await setup(context);
  let changes = 0;
  window.addEventListener('wb:localchange', () => { changes += 1; });
  state.db.load();
  for (let count = 0; count < 10; count += 1) { assert.equal(state.db.save(), true); state.sync.hookSave(); }
  await state.advance(30000);
  assert.equal(changes, 0);
  assert.equal(state.writes.length, 0);
});

test('one real edit is saved once and rapid edits are combined into the latest payload', async context => {
  const state = await setup(context);
  state.db.load().notes[0].title = 'first';
  state.db.save();
  await state.advance(400);
  state.db.load().notes[0].title = 'latest';
  state.db.save();
  await state.advance(799);
  assert.equal(state.writes.length, 0);
  await state.advance(1);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].p_payload.notes[0].title, 'latest');
  for (let count = 0; count < 5; count += 1) state.sync.hookSave();
  await state.advance(30000);
  assert.equal(state.writes.length, 1);
});

test('reverting before debounce expires cancels the upload', async context => {
  const state = await setup(context);
  state.db.load().notes[0].title = 'temporary';
  state.db.save();
  state.db.load().notes[0].title = 'original';
  state.db.save();
  await state.advance(30000);
  assert.equal(state.writes.length, 0);
});

test('edits made while a save is in flight are saved afterwards without being lost', async context => {
  const state = await setup(context);
  state.holdNext();
  state.db.load().notes[0].title = 'in-flight';
  state.db.save();
  await state.advance();
  state.db.load().notes[0].title = 'latest';
  state.db.save();
  state.release();
  await flush();
  await state.advance();
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[1].p_payload.notes[0].title, 'latest');
  await state.advance(30000);
  assert.equal(state.writes.length, 2);
});

test('reverting to the old baseline during an in-flight save is preserved', async context => {
  const state = await setup(context);
  state.holdNext();
  state.db.load().notes[0].title = 'in-flight';
  state.db.save();
  await state.advance();
  state.db.load().notes[0].title = 'original';
  state.db.save();
  state.release();
  await flush();
  await state.advance();
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[1].p_payload.notes[0].title, 'original');
});

test('remote refresh updates the baseline without uploading the downloaded snapshot', async context => {
  const state = await setup(context);
  state.remote({ ...state.db.blank(), notes: [{ id: 1, title: 'remote' }] });
  assert.equal(await state.sync.refreshAccountSync(), true);
  state.db.save();
  state.sync.hookSave();
  await state.advance(30000);
  assert.equal(state.writes.length, 0);
  state.db.load().notes[0].title = 'edited remote';
  state.db.save();
  await state.advance();
  assert.equal(state.writes.length, 1);
});

test('transient failure retries the unsaved edit, then stops retrying after acknowledgement', async context => {
  const state = await setup(context, { failOnce: true });
  context.mock.method(console, 'error', () => {});
  state.db.load().notes[0].title = 'keep this edit';
  state.db.save();
  await state.advance();
  assert.equal(state.writes.length, 1);
  await state.advance(1500);
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[1].p_payload.notes[0].title, 'keep this edit');
  await state.advance(30000);
  assert.equal(state.writes.length, 2);
});

test('saving identical fields does not update record timestamps or signal a change', async context => {
  const state = await setup(context);
  let changes = 0;
  window.addEventListener('wb:localchange', () => { changes += 1; });
  state.db.updateRow('notes', 1, { title: 'original' });
  await state.advance(30000);
  assert.equal(state.db.load().notes[0].updated_at, undefined);
  assert.equal(changes, 0);
  assert.equal(state.writes.length, 0);
});

test('periodic reminder and message reads do not trigger automatic saves', async context => {
  const state = await setup(context);
  const { handle } = await import('../js/localapi.js');
  let changes = 0;
  window.addEventListener('wb:localchange', () => { changes += 1; });
  for (let count = 0; count < 20; count += 1) {
    assert.equal((await handle('GET', '/reminders')).ok, true);
    assert.equal((await handle('GET', '/messages')).ok, true);
    await state.advance(5000);
  }
  assert.equal(changes, 0);
  assert.equal(state.writes.length, 0);
});

test('semantically identical snapshots with reordered keys do not upload', async context => {
  const state = await setup(context);
  const original = state.db.load();
  state.db.replaceAll(Object.fromEntries(Object.entries(original).reverse()));
  await state.advance(30000);
  assert.equal(state.writes.length, 0);
});

test('remote events cannot overwrite a local revert while its earlier save is still in flight', async context => {
  const state = await setup(context);
  state.holdNext();
  state.db.load().notes[0].title = 'in-flight';
  state.db.save();
  await state.advance();
  state.db.load().notes[0].title = 'original';
  state.db.save();
  state.remote({ ...state.db.blank(), notes: [{ id: 1, title: 'remote event' }] });
  assert.equal(await state.sync.refreshAccountSync(), false);
  assert.equal(state.db.load().notes[0].title, 'original');
  state.release();
  await flush();
  await state.advance();
  assert.equal(state.writes.at(-1).p_payload.notes[0].title, 'original');
});

test('pending edits are journaled synchronously and survive a reload before the debounce fires', async context=>{
  const state=await setup(context);state.db.load().notes[0].title='survive reload';state.db.save();
  const key='wb_sync_journal_v1:'+state.db.activeAccountId();
  assert.equal(JSON.parse(state.storage.getItem(key)).draft.notes[0].title,'survive reload');
  const restored=await state.restart();assert.equal(state.db.load().notes[0].title,'survive reload');
  assert.equal(restored.getAccountSyncStatus().pending,true);await state.advance();
  assert.equal(state.readRemote().payload.notes[0].title,'survive reload');
  assert.equal(JSON.parse(state.storage.getItem(key)).draft,null);
});
test('acknowledgement loss is recovered by reading the server without uploading twice',async context=>{
  const state=await setup(context);state.loseResponse();state.db.load().notes[0].title='committed';state.db.save();await state.advance();
  assert.equal(state.writes.length,1);assert.equal(state.sync.getAccountSyncStatus().status,'saved');await state.advance(60000);assert.equal(state.writes.length,1);
});
test('a reverted edit survives a reload while the earlier request may have committed',async context=>{
  // A real page reload releases its Web Lock even if the server request finishes later.
  if(globalThis.navigator?.locks)context.mock.method(navigator.locks,'request',async(_name,_options,run)=>run());
  const state=await setup(context);state.holdNext();state.db.load().notes[0].title='in-flight';state.db.save();await state.advance();
  state.db.load().notes[0].title='original';state.db.save();
  state.remote(state.writes[0].p_payload);
  const restored=await state.restart();assert.equal(state.db.load().notes[0].title,'original');
  assert.equal(restored.getAccountSyncStatus().pending,true);await state.advance();
  assert.equal(state.readRemote().payload.notes[0].title,'original',JSON.stringify({status:restored.getAccountSyncStatus(),conflicts:restored.getSyncConflicts(),writes:state.writes.map(row=>row.p_payload.notes)}));
});
test('busy writes stop after a bounded number of retries and resume when connectivity returns',async context=>{
  const state=await setup(context);state.failure('busy');state.db.load().notes[0].title='queued';state.db.save();
  for(let i=0;i<8;i++)await state.advance(60000);
  assert.equal(state.writes.length,5);assert.equal(state.sync.getAccountSyncStatus().status,'error');
  const journal=JSON.parse(state.storage.getItem('wb_sync_journal_v1:'+state.db.activeAccountId()));assert.equal(journal.draft.notes[0].title,'queued');
  state.failure('');window.dispatchEvent(new Event('online'));await state.advance(250);
  assert.equal(state.writes.length,6);assert.equal(state.readRemote().payload.notes[0].title,'queued');
});
test('different fields are rebased against the acknowledged base after another device saves',async context=>{
  const state=await setup(context);state.useRevision();state.db.load().notes[0].title='local title';state.db.save();
  state.remote({...state.db.blank(),notes:[{id:1,title:'original',content:'remote content'}]});
  await state.advance();assert.equal(state.readRemote().payload.notes[0].title,'local title');assert.equal(state.readRemote().payload.notes[0].content,'remote content');
  assert.equal(state.sync.getAccountSyncStatus().status,'saved');
});
test('same-field conflicts remain durable until an explicit field choice is saved',async context=>{
  const state=await setup(context);state.useRevision();state.db.load().notes[0].title='local title';state.db.save();
  state.remote({...state.db.blank(),notes:[{id:1,title:'remote title'}]});await state.advance();
  assert.equal(state.sync.getAccountSyncStatus().status,'conflict');assert.equal(state.writes.length,1);
  const restored=await state.restart();assert.equal(state.db.load().notes[0].title,'local title');assert.equal(restored.getAccountSyncStatus().status,'conflict');
  const conflicts=restored.getSyncConflicts();assert.equal(conflicts.length,1);
  await restored.resolveAccountSyncConflicts({[JSON.stringify(conflicts[0].path)]:'local'});
  assert.equal(state.readRemote().payload.notes[0].title,'local title');
});
test('first upgrade preserves divergent legacy cache instead of overwriting it',async context=>{
  const state=await setup(context);state.storage.removeItem('wb_sync_journal_v1:'+state.db.activeAccountId());
  const local=state.db.exportJSON();local.notes[0].title='legacy unsynced';state.storage.setItem(state.db.DB_KEY,JSON.stringify(local));
  const restored=await state.restart();assert.equal(state.db.load().notes[0].title,'legacy unsynced');assert.equal(restored.getAccountSyncStatus().status,'conflict');
  assert.equal(state.writes.length,0);
  await restored.resolveAccountSyncConflicts({'[]':'local'});assert.equal(state.readRemote().payload.notes[0].title,'legacy unsynced');
});
test('read failures do not replace local data, and corrupt journals fail closed',async context=>{
  const state=await setup(context),raw=state.storage.getItem(state.db.DB_KEY);
  state.storage.setItem('wb_sync_journal_v1:'+state.db.activeAccountId(),'{broken');
  await assert.rejects(state.restart());assert.equal(state.storage.getItem(state.db.DB_KEY),raw);
});

test('offline reload restores the journal and uploads only after the online event',async context=>{
  const state=await setup(context);
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),network={onLine:false};
  Object.defineProperty(globalThis,'navigator',{value:network,configurable:true});
  context.after(()=>Object.defineProperty(globalThis,'navigator',descriptor));
  state.db.load().notes[0].title='offline edit';state.db.save();state.failReads(true);
  const restored=await state.restart();assert.equal(restored.getAccountSyncStatus().status,'offline');assert.equal(state.db.load().notes[0].title,'offline edit');
  state.db.load().notes[0].content='still offline';state.db.save();await state.advance(60000);assert.equal(state.writes.length,0);
  network.onLine=true;state.failReads(false);window.dispatchEvent(new Event('online'));await state.advance(250);
  assert.equal(state.readRemote().payload.notes[0].title,'offline edit');assert.equal(state.readRemote().payload.notes[0].content,'still offline');
});
test('journal quota failure is visible and does not erase the latest local database on reload',async context=>{
  const state=await setup(context),original=state.storage.setItem.bind(state.storage);
  state.storage.setItem=(key,value)=>{if(key.startsWith('wb_sync_journal_v1:'))throw new DOMException('quota','QuotaExceededError');original(key,value);};
  state.db.load().notes[0].title='keep despite quota';state.db.save();
  assert.equal(state.sync.getAccountSyncStatus().status,'error');assert.equal(state.writes.length,0);assert.equal(state.sync.exportPendingSync().memory.notes[0].title,'keep despite quota');
  state.storage.setItem=original;await state.restart();assert.equal(state.db.load().notes[0].title,'keep despite quota');await state.advance();assert.equal(state.readRemote().payload.notes[0].title,'keep despite quota');
});
test('an account switch during token acquisition cancels the old snapshot before sending it',async context=>{
  const state=await setup(context),uid=state.db.activeAccountId(),cloud=await import('../js/cloud.js');
  const request=cloud.saveWorkbenchSnapshot(state.db.exportJSON(),1,uid);
  state.storage.setItem('wb_supa_tok',JSON.stringify({uid:'another-user',access_token:'another-test-token',expires_at:Date.now()+3600000}));
  await assert.rejects(request,/账号已切换/);assert.equal(state.writes.length,0);
});
test('a late response from the previous account cannot acknowledge or replace the next account',async context=>{
  const state=await setup(context);state.holdNext();state.db.load().notes[0].title='account A pending';state.db.save();await state.advance();
  state.db.setActiveAccount('account-B');const second={...state.db.blank(),notes:[{id:1,title:'account B data'}]};
  state.storage.setItem(state.db.DB_KEY,JSON.stringify(second));state.db.replaceMemFromDisk();
  state.storage.setItem('wb_supa_tok',JSON.stringify({uid:'account-B',access_token:'another-test-token',expires_at:Date.now()+3600000}));
  state.remote(second);await state.sync.initializeAccountSync();state.release();await flush();
  assert.equal(state.db.load().notes[0].title,'account B data');
  assert.equal(JSON.parse(state.storage.getItem('wb_sync_journal_v1:account-B')).base.notes[0].title,'account B data');
});

