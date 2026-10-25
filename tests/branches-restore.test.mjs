import test from 'node:test';import assert from 'node:assert/strict';
import {createGmHost} from '../src/host.mjs';import {launch} from './fixtures.mjs';import {contractFixture} from './contract-fixture.mjs';import {nativeFixture} from './native-fixture.mjs';
async function opened(t){const f=nativeFixture(await contractFixture(t)),service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());const {sessionId:id}=await service.startStory(launch());f.installPresenter(service);const opening=await f.runTool(id,'rp_begin_story');await f.runTool(id,'rp_present',{factReceiptId:opening.id});await service.binding({sessionId:id});return {...f,service,id};}
test('generic rollback creates a child before the latest ordinary factual turn and preserves parent',async t=>{
  const f=await opened(t);assert.deepEqual((await f.service.storyState({sessionId:f.id})).capabilities,{rollback:false,fork:true,autoplay:false});await assert.rejects(f.service.rollbackStory({sessionId:f.id}),{code:'ROLLBACK_UNAVAILABLE'});
  const state=await f.runTool(f.id,'rp_gm_state'),receipt=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:'交信',facts:{schemaVersion:1,items:[{id:'letter-holder',text:'林遥持有信件。'}]},packet:{playerAction:'交信'}});
  assert.equal((await f.service.storyState({sessionId:f.id})).capabilities.rollback,true);
  const child=await f.service.rollbackStory({sessionId:f.id});assert.notEqual(child.sessionId,f.id);assert.equal(f.forks[0].atSeq,receipt.source.turnStartSeq-1);assert.equal(f.profileInherits.includes(child.sessionId),true);
  assert.equal((await f.service.storyState({sessionId:child.sessionId})).facts.items[0].text,'密封信件由旅人持有。');assert.equal((await f.service.storyState({sessionId:f.id})).facts.items[0].text,'林遥持有信件。');assert.equal(child.binding.status,'active');
});
test('fork initializes optional Context plan and refuses missing LastStep inheritance before creating child',async t=>{
  const f=await opened(t),contextCalls=[];f.services.set('rpContext',{state:async input=>{contextCalls.push(input.sessionId);return {};}});
  const child=await f.service.forkStory({sessionId:f.id});assert.equal(contextCalls.includes(child.sessionId),true);assert.equal(child.binding.character.assetId,'innkeeper');
  delete f.last.inheritSession;const count=f.sessions.size;await assert.rejects(f.service.forkStory({sessionId:f.id}),{code:'LAST_STEP_INHERIT_UNAVAILABLE'});assert.equal(f.sessions.size,count);
});
test('restore reservation is exclusive and blocks native play without writing facts or prompts',async t=>{
  const f=await opened(t),writes=f.counts.factWrites,prompts=f.counts.prompts;await f.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id,'destination']});
  await f.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id,'destination']});await assert.rejects(f.service.reserveRestore({restoreId:'other-job',sessionIds:[f.id]}),{code:'RESTORE_CONFLICT'});
  await assert.rejects(f.runTool(f.id,'rp_begin_story'),{code:'STORY_RESTORING'});assert.deepEqual((await f.service.storyState({sessionId:f.id})).capabilities,{rollback:false,fork:false,autoplay:false});assert.equal(f.counts.factWrites,writes);assert.equal(f.counts.prompts,prompts);
  await assert.rejects(f.service.activateRestored({restoreId:'restore-one',sessionIds:[f.id,'destination']}),{code:'RESTORE_INCOMPLETE'});await assert.rejects(f.runTool(f.id,'rp_begin_story'),{code:'STORY_RESTORING'});
});
test('activation validates restored state and profile then clears only matching execution gate without replay',async t=>{
  const f=await opened(t),before={writes:f.counts.factWrites,prompts:f.counts.prompts,initializes:f.counts.initializes};await f.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id]});
  await assert.rejects(f.service.activateRestored({restoreId:'wrong',sessionIds:[f.id]}),{code:'RESTORE_CONFLICT'});await f.service.activateRestored({restoreId:'restore-one',sessionIds:[f.id]});
  assert.equal((await f.service.binding({sessionId:f.id})).status,'active');assert.equal((await f.runTool(f.id,'rp_begin_story')).kind,'opening');assert.deepEqual({writes:f.counts.factWrites,prompts:f.counts.prompts,initializes:f.counts.initializes},before);
});
test('a child with failed profile inheritance cannot become playable merely by reading its canonical opening',async t=>{
  const f=await opened(t);f.last.inheritSession=async()=>{throw Object.assign(Error('profile unavailable'),{code:'PROFILE_UNAVAILABLE'});};await assert.rejects(f.service.forkStory({sessionId:f.id}),{code:'PROFILE_UNAVAILABLE'});
  const child=[...f.sessions.keys()].find(id=>id!==f.id);assert.equal((await f.service.binding({sessionId:child})).status,'restoring');await assert.rejects(f.service.presentation({sessionId:child,agent:f.sessions.get(child),factReceiptId:'any'}),{code:'STORY_RESTORING'});
});
test('restore gate blocks a partial startup retry and only reserved native pre-steps',async t=>{
  const f=nativeFixture(await contractFixture(t)),service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());f.faults.initializeLost=true;await assert.rejects(service.startStory(launch()),{code:'LOST_RESPONSE'});
  const id=[...f.sessions.keys()][0];await service.reserveRestore({restoreId:'restore-partial',sessionIds:[id]});await assert.rejects(service.startStory(launch()),{code:'STORY_RESTORING'});assert.equal(f.counts.prompts,0);
  let entered=0;await f.emit('agent/pre-step',{agent:f.sessions.get(id)},()=>{entered++;});assert.equal(entered,0);
  const foreign=f.makeAgent('foreign');await f.emit('agent/pre-step',{agent:foreign},()=>{entered++;});assert.equal(entered,1);
});
