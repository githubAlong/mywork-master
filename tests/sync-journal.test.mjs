import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeSnapshots,applyConflictChoices,readJournal,writeJournal,localDrafts} from '../js/sync-journal.mjs';
import {installBrowser} from './test-browser.mjs';
test('three-way merge preserves independent record and module edits without relying on clocks',()=>{
 const base={notes:[{id:1,title:'A',content:'old'}],todos:[{id:2,status:'todo'}]};
 const local=structuredClone(base),remote=structuredClone(base);local.notes[0].title='B';remote.notes[0].content='new';remote.todos[0].status='done';
 const result=mergeSnapshots(base,local,remote);assert.deepEqual(result.conflicts,[]);assert.deepEqual(result.payload,{notes:[{id:1,title:'B',content:'new'}],todos:[{id:2,status:'done'}]});
});
test('same-field edits, delete-versus-edit and colliding new numeric IDs require explicit choices',()=>{
 for(const [base,local,remote] of [
  [{notes:[{id:1,title:'A'}]},{notes:[{id:1,title:'L'}]},{notes:[{id:1,title:'R'}]}],
  [{notes:[{id:1,title:'A'}]},{notes:[{id:1,title:'A',deleted_at:'now'}]},{notes:[{id:1,title:'R'}]}],
  [{notes:[]},{notes:[{id:1,title:'L'}]},{notes:[{id:1,title:'R'}]}]
 ]){
  const result=mergeSnapshots(base,local,remote);assert.equal(result.conflicts.length,1);
  assert.throws(()=>applyConflictChoices(result.payload,result.conflicts,{}));
  const choice={[JSON.stringify(result.conflicts[0].path)]:'remote'};
  assert.deepEqual(applyConflictChoices(result.payload,result.conflicts,choice),remote);
 }
});
test('deletions and record additions survive unrelated edits',()=>{
 const base={notes:[{id:1,title:'A'},{id:2,title:'B'}]},local={notes:[{id:2,title:'B'}]},remote={notes:[{id:1,title:'A'},{id:2,title:'C'},{id:3,title:'new'}]};
 const result=mergeSnapshots(base,local,remote);assert.equal(result.conflicts.length,0);assert.deepEqual(result.payload.notes,[{id:2,title:'C'},{id:3,title:'new'}]);
});
test('journal is account-scoped, malformed data fails closed, and unusual keys remain data',()=>{
 const storage=installBrowser();writeJournal(storage,'A',{base:{notes:[]},draft:{notes:[{id:1,title:'A'}]},revision:2});
 assert.equal(readJournal(storage,'B'),null);assert.equal(readJournal(storage,'A').draft.notes[0].title,'A');
 storage.setItem('wb_sync_journal_v1:B','{"uid":"A","version":1,"base":{}}');assert.throws(()=>readJournal(storage,'B'));
 const base=JSON.parse('{"__proto__":{"x":1}}'),local=JSON.parse('{"__proto__":{"x":2}}'),remote=JSON.parse('{"__proto__":{"x":1},"title":"R"}');
 const result=mergeSnapshots(base,local,remote);assert.equal(Object.getPrototypeOf(result.payload),Object.prototype);assert.equal(result.payload.__proto__.x,2);assert.equal({}.x,undefined);
});
test('local stale caches merge different fields, preserve same-field conflicts and never overwrite the other tab',async()=>{
 const storage=installBrowser(),db=await import('../js/localdb.js');db.setActiveAccount('local-tab-test');db.replaceAll({...db.blank(),notes:[{id:1,title:'base',content:'base'}]});
 const local=db.load();local.notes[0].title='my title';const other=db.exportJSON();other.notes[0].title='base';other.notes[0].content='other content';storage.setItem(db.DB_KEY,JSON.stringify(other));
 assert.equal(db.save(),true);assert.equal(db.load().notes[0].title,'my title');assert.equal(db.load().notes[0].content,'other content');
 db.load().notes[0].title='next local';const current=JSON.parse(storage.getItem(db.DB_KEY));current.notes[0].title='next other';storage.setItem(db.DB_KEY,JSON.stringify(current));
 assert.throws(()=>db.save(),/另一个标签页/);assert.equal(JSON.parse(storage.getItem(db.DB_KEY)).notes[0].title,'next other');
 const drafts=localDrafts(storage,'local-tab-test');assert.equal(drafts.length,1);assert.equal(drafts[0].draft.notes[0].title,'next local');assert.equal(localDrafts(storage,'another-account').length,0);
});
