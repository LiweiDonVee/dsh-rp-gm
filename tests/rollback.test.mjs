import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createGmHost} from '../src/host.mjs';import {launch} from './fixtures.mjs';import {contractFixture} from './contract-fixture.mjs';import {nativeFixture} from './native-fixture.mjs';
async function opened(t){const f=nativeFixture(await contractFixture(t)),service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());const {sessionId:id}=await service.startStory(launch());f.installPresenter(service);const opening=await f.runTool(id,'rp_begin_story');await f.runTool(id,'rp_present',{factReceiptId:opening.id});await service.binding({sessionId:id});return {...f,service,id};}
const message=()=>({id:randomUUID(),role:'user',source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'Identified fixture action'}]});
function splice(f,id,target,start,inserted,removedCount,outcome){return f.append(f.sessions.get(id),'agent/inbox/spliced',{target,start,inserted,...removedCount===undefined?{}:{removedCount},...outcome?{outcome}:{}});}
function claim(f,id,nextTurn,nextStep=[]){const agent=f.sessions.get(id),turn=(agent.events.findLast(event=>event.type==='turn/start')?.data.turn??0)+1;f.append(agent,'turn/start',{turn});if(nextStep.length)splice(f,id,'next-step',0,[],nextStep.length);splice(f,id,'next-turn',0,[],1);f.append(agent,'step/start',{turn,step:1});for(const input of [...nextStep,nextTurn])f.append(agent,'user/message',structuredClone(input),'append');}
async function commit(f,id=f.id){const state=await f.runTool(id,'rp_gm_state'),receipt=await f.runTool(id,'rp_commit_turn',{expectedRevision:state.revision,summary:'测试事实回合',packet:{playerAction:'已识别输入'}});await f.runTool(id,'rp_present',{factReceiptId:receipt.id});return receipt;}
function pending(events){const queues={'next-turn':[],'next-step':[]};for(const event of events)if(event.type==='agent/inbox/spliced'){const data=event.data;queues[data.target].splice(data.start,data.removedCount??0,...data.inserted);}return queues;}

test('rollback excludes sequential intake while preserving harmless metadata and the previous closed turn',async t=>{
  const f=await opened(t),agent=f.sessions.get(f.id),closed=agent.events.at(-1);const metadata=f.append(agent,'fixture/metadata',{reviewed:true});const receipt=await commit(f),before=structuredClone(agent.events),child=await f.service.rollbackStory({sessionId:f.id});
  assert.equal(f.forks.at(-1).atSeq,metadata.seq);assert.ok(metadata.seq>=closed.seq);assert.ok(metadata.seq<receipt.source.turnStartSeq-1);assert.deepEqual(agent.events,before);assert.deepEqual(f.sessions.get(child.sessionId).events,before.slice(0,metadata.seq+1));assert.deepEqual(pending(f.sessions.get(child.sessionId).events),{'next-turn':[],'next-step':[]});
});

test('rollback traces a same-ID pending edit back to its first enqueue',async t=>{
  const f=await opened(t),input=message(),boundary=f.sessions.get(f.id).events.at(-1).seq,enqueue=splice(f,f.id,'next-turn',0,[input]),edited={...input,content:[{type:'text',text:'Edited pending action'}]};splice(f,f.id,'next-turn',0,[edited],1,'canceled');claim(f,f.id,edited);await commit(f);const child=await f.service.rollbackStory({sessionId:f.id});
  assert.equal(f.forks.at(-1).atSeq,boundary);assert.ok(boundary<enqueue.seq);assert.deepEqual(pending(f.sessions.get(child.sessionId).events),{'next-turn':[],'next-step':[]});
});

test('rollback rejects early dual-queue input instead of discarding a preceding completed turn',async t=>{
  const f=await opened(t);await f.runTool(f.id,'rp_gm_state');const early=message();splice(f,f.id,'next-step',0,[early]);await commit(f);const beforeTurn=f.sessions.get(f.id).events.at(-1).seq,next=message();splice(f,f.id,'next-turn',0,[next]);claim(f,f.id,next,[early]);await commit(f);const parent=structuredClone(f.sessions.get(f.id).events),count=f.sessions.size;
  await assert.rejects(f.service.rollbackStory({sessionId:f.id}),{code:'ROLLBACK_UNAVAILABLE'});assert.equal(f.sessions.size,count);assert.equal(f.forks.length,0);assert.deepEqual(f.sessions.get(f.id).events,parent);assert.ok(beforeTurn>parent.find(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(input=>input.id===early.id)).seq);
});

test('rollback rejects a shared enqueue with independent pending work before creating a child',async t=>{
  const f=await opened(t),input=message(),independent=message();splice(f,f.id,'next-turn',0,[input,independent]);claim(f,f.id,input);await commit(f);const count=f.sessions.size;await assert.rejects(f.service.rollbackStory({sessionId:f.id}),{code:'ROLLBACK_UNAVAILABLE'});assert.equal(f.sessions.size,count);assert.equal(f.forks.length,0);
});

test('rollback rejects mismatched source identity',async t=>{
  const f=await opened(t),input=message();splice(f,f.id,'next-turn',0,[input]);claim(f,f.id,{...input,source:{...input.source,rpcId:'foreign-rpc'}});await commit(f);await assert.rejects(f.service.rollbackStory({sessionId:f.id}),{code:'ROLLBACK_UNAVAILABLE'});assert.equal(f.forks.length,0);
});

test('rollback does not mistake a canceled deletion for a claimed intake',async t=>{
  const f=await opened(t),input=message();splice(f,f.id,'next-turn',0,[input]);const agent=f.sessions.get(f.id),turn=agent.events.findLast(event=>event.type==='turn/start').data.turn+1;f.append(agent,'turn/start',{turn});splice(f,f.id,'next-turn',0,[],1,'canceled');f.append(agent,'step/start',{turn,step:1});f.append(agent,'user/message',input,'append');await commit(f);await assert.rejects(f.service.rollbackStory({sessionId:f.id}),{code:'ROLLBACK_UNAVAILABLE'});assert.equal(f.forks.length,0);
});

test('rollback refuses new durable input arriving during its final relationship check',async t=>{
  const f=await opened(t);await commit(f);await f.service.storyState({sessionId:f.id});const access=f.db.factAccess;let checks=0;f.db.factAccess=async input=>{if(++checks===2)splice(f,f.id,'next-turn',0,[message()]);return access(input);};const count=f.sessions.size;
  await assert.rejects(f.service.rollbackStory({sessionId:f.id}),{code:'ROLLBACK_UNAVAILABLE'});assert.equal(checks,2);assert.equal(f.forks.length,0);assert.equal(f.sessions.size,count);
});

test('rollback may cut inside an inherited prefix without clamping to the child end-seed',async t=>{
  const f=await opened(t),boundary=f.sessions.get(f.id).events.at(-1).seq;await commit(f);const first=await f.service.forkStory({sessionId:f.id}),agent=f.sessions.get(first.sessionId);f.append(agent,'session/end-seed',{inherited:true});const inherited=agent.events.length,child=await f.service.rollbackStory({sessionId:first.sessionId});
  assert.equal(f.forks.at(-1).atSeq,boundary);assert.ok(boundary<inherited-1);assert.equal(f.sessions.get(child.sessionId).session.header.parentSession,first.sessionId);assert.deepEqual(pending(f.sessions.get(child.sessionId).events),{'next-turn':[],'next-step':[]});
});
