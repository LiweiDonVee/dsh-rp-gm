import assert from 'node:assert/strict';
import test from 'node:test';
import {createSessionLineage} from '../src/lineage.mjs';
const prefix={seq:0,type:'system/message',data:{text:'public fixture'}};
function fixture(){
  const sessions=new Map([['parent',{header:{id:'parent'},events:[prefix],inheritedEventCount:0}],['child',{header:{id:'child'},events:[structuredClone(prefix)],inheritedEventCount:1}]]),bindings=new Map();let disposed=0;
  const read=createSessionLineage({ctx:{sessionQuery:{observeSession:async id=>({...structuredClone(sessions.get(id)),[Symbol.dispose](){disposed++;}})}},store:{binding:async id=>bindings.get(id)},readSession:async id=>sessions.get(id)});
  return{sessions,bindings,read,disposed:()=>disposed};
}
test('GM durable fork lineage survives detached reads without mutating Session headers',async()=>{
  const f=fixture();f.bindings.set('parent',{});f.bindings.set('child',{parentSessionId:'parent'});
  assert.deepEqual(await f.read({sessionId:'child'}),{sessionId:'child',parentSessionId:'parent',inheritedEventCount:1});
  assert.equal(Object.hasOwn(f.sessions.get('child').header,'parentSession'),false);assert.equal(f.disposed(),2);
  f.sessions.get('parent').events[0].data.text='different';await assert.rejects(f.read({sessionId:'child'}),{code:'INVALID_ANCESTRY'});
});
test('installed GM preserves verified legacy ancestry for independent non-GM stories',async()=>{
  const f=fixture();f.sessions.get('child').header.parentSession='parent';
  assert.equal(f.bindings.size,0);assert.equal((await f.read({sessionId:'child'})).parentSessionId,'parent');
  f.bindings.set('child',{parentSessionId:'other'});await assert.rejects(f.read({sessionId:'child'}),{code:'INVALID_ANCESTRY'});
});
