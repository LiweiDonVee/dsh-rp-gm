import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewFixture,decisionInput} from './fact-review-fixture.mjs';
import {nativeBatch} from './native-batch-fixture.mjs';

function readTool(agent,name,text){agent.ctx.tools.register({name,execute:async()=>({text})});}
const proposal=state=>({expectedRevision:state.revision,summary:'门已打开',facts:{schemaVersion:1,items:[{id:'door',text:'门已打开。'}]},packet:{playerAction:'推门'}});

test('same-message read/search then final proposal keeps exact source and stages one review',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true}),agent=f.sessions.get(f.id);
  readTool(agent,'rp_db_read','先前已读取的门锁事实');readTool(agent,'rp_db_search','同批新检索结果');
  await f.runTool(f.id,'rp_db_read',{});const state=await f.runTool(f.id,'rp_gm_state');
  let submissions=0;const access=f.db.factAccess;f.db.factAccess=async input=>{const value=await access(input);return {...value,propose:async request=>{submissions++;return value.propose(request);}};};
  const batch=await nativeBatch(f,f.id,[{name:'rp_db_search',args:{query:'门锁'}},{name:'rp_propose_turn',args:proposal(state)}]);
  assert.equal(batch.results[0].error,undefined);assert.equal(batch.results[1].error,undefined);assert.equal(batch.results[1].value.status,'pending');assert.equal(batch.concluded,true);assert.equal(submissions,1);
  assert.ok(batch.results[0].event.seq<batch.calls[1].seq);
  let review=await f.service.reviewState({sessionId:f.id});
  assert.equal(review.latestRound.source.assistantMessageId,batch.assistant.data.message.id);assert.equal(review.latestRound.source.callId,batch.calls[1].data.callId);assert.equal(review.latestRound.source.callSeq,batch.calls[1].seq);
  assert.deepEqual(review.latestRound.capture.observations.map(item=>item.toolName),['rp_db_read']);
  assert.equal(f.counts.factWrites,1);assert.equal(f.presentations.length,0);assert.ok(review.latestRound.pendingCandidateId);
  const input=decisionInput(f,review),approved=await f.service.decideFacts(input);assert.equal(approved.status,'approved');assert.equal(f.counts.factWrites,2);
  assert.deepEqual(await f.service.decideFacts(input),approved);assert.equal(f.counts.factWrites,2);assert.equal(submissions,1);
  review=await f.service.reviewState({sessionId:f.id});assert.equal(review.latestRound.pendingCandidateId,null);
});

test('proposal with a following read refuses before staging or concluding the turn',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true}),agent=f.sessions.get(f.id),state=await f.runTool(f.id,'rp_gm_state');readTool(agent,'rp_db_read','仍可正常读取');
  const batch=await nativeBatch(f,f.id,[{name:'rp_propose_turn',args:proposal(state)},{name:'rp_db_read'}]);
  assert.equal(batch.results[0].error.code,'FINAL_TERMINAL_REQUIRED');assert.equal(batch.results[1].error,undefined);assert.equal(batch.concluded,false);
  assert.equal((await f.service.reviewState({sessionId:f.id})).latestRound,null);assert.equal(f.counts.factWrites,1);assert.equal(f.presentations.length,0);
});

test('same-message state read and final proposal still require a direct native execution',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true}),state=await f.runTool(f.id,'rp_gm_state');
  const batch=await nativeBatch(f,f.id,[{name:'rp_gm_state'},{name:'rp_propose_turn',args:proposal(state)}]),call=batch.calls[1];
  assert.equal(batch.results[1].error,undefined);
  await assert.rejects(f.sessions.get(f.id).tools.get('rp_propose_turn').execute(proposal(state),{agent:f.sessions.get(f.id),callId:call.data.callId,rootCallId:call.data.callId,parent:{},signal:new AbortController().signal,concludeTurn:()=>{throw Error('Nested call must not conclude');}}),{code:'INVALID_SOURCE'});
  assert.equal(f.rounds.size,1);assert.equal(f.counts.factWrites,1);
});

test('capture excludes same-message status results under both native event orders',async t=>{
  for(const allCallsBeforeResults of [false,true])await t.test(allCallsBeforeResults?'calls logged together':'exclusive call/result barriers',async sub=>{
    const f=await reviewFixture(sub,{factApprovalDefault:true}),agent=f.sessions.get(f.id);
    readTool(agent,'rp_context_status','model-visible earlier status');await f.runTool(f.id,'rp_context_status');
    readTool(agent,'rp_context_status','same-message status not yet seen by model');
    const state=await f.runTool(f.id,'rp_gm_state'),batch=await nativeBatch(f,f.id,[{name:'rp_context_status'},{name:'rp_propose_turn',args:proposal(state)}],{allCallsBeforeResults});
    assert.equal(batch.results[1].error,undefined);
    const captured=(await f.service.reviewState({sessionId:f.id})).latestRound.capture;
    assert.deepEqual(captured.observations.map(item=>JSON.parse(item.text).text),['model-visible earlier status']);
    assert.ok(captured.observations.every(item=>item.resultSeq<batch.assistant.seq));
  });
});
