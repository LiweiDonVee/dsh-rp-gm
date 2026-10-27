import test from 'node:test';import assert from 'node:assert/strict';
import {acceptedFactPresentations,canonicalSource,captureFactTurn,projectSession} from '../src/session.mjs';import {launch,sourceEvents} from './fixtures.mjs';
const execution=(events,changes={})=>({agent:{session:{id:'story',snapshotEvents:()=>events}},callId:'commit',rootCallId:'commit',...changes});
test('source uses actual assistant and call identity plus enclosing turn start',()=>{
  const events=sourceEvents();
  assert.deepEqual(canonicalSource(execution(events),'rp_commit_turn'),{turnKey:'["story",0]',source:{assistantMessageId:'assistant-one',callId:'commit',callSeq:2,turnStartSeq:0}});
  assert.equal(canonicalSource(execution([...events,{seq:3,type:'turn/end',data:{turn:1}},...sourceEvents({startSeq:5,turn:2})]),'rp_commit_turn').turnKey,'["story",5]');
});
test('forged nested stale and wrong-tool executions cannot mint canonical source',()=>{
  const events=sourceEvents();
  for(const exec of [execution(events,{callId:'fake'}),execution(events,{parent:{}}),execution(events,{rootCallId:'different'})])assert.throws(()=>canonicalSource(exec,'rp_commit_turn'),{code:'INVALID_SOURCE'});
  assert.throws(()=>canonicalSource(execution(events),'rp_begin_story'),{code:'INVALID_SOURCE'});
  assert.throws(()=>canonicalSource(execution([...events,{seq:3,type:'user/message',data:{id:'replacement'},surfaceOp:{op:'replace',startSeq:1,endSeq:1}}]),'rp_commit_turn'),{code:'INACTIVE_SOURCE'});
});
test('compaction preserves source anchors',()=>{
  const events=[...sourceEvents(),{seq:3,type:'assistant/message',surfaceOp:{op:'replace',startSeq:1,endSeq:1},data:{message:{id:'compact',source:{kind:'compact-checkpoint'},content:[]}}}];
  assert.deepEqual(projectSession({header:{id:'story'},events}).activeAssistantIds,['assistant-one','compact']);
  assert.equal(canonicalSource(execution(events),'rp_commit_turn').source.callSeq,2);
});
test('accepted factual presentation uses explicit canonical receipt metadata including rewrite lineage',()=>{
  const events=sourceEvents({tool:'rp_present'});events[1].data.message.content[0].arguments='{"rewriteOf":"draft-one"}';events[2].data.arguments='{"rewriteOf":"draft-one"}';
  events.push({seq:3,type:'tool/result',surfaceOp:'append',sourceEventSeqs:[2],data:{turn:1,step:1,message:{id:'result',source:{kind:'tool',callId:'commit'},toolCallId:'commit',content:[{type:'text',text:'Any prose'}]},meta:{rpLastStep:{schemaVersion:1,record:{id:'presentation',status:'complete',factReceiptId:'fact-one'}}}}});
  assert.deepEqual(acceptedFactPresentations(projectSession({header:{id:'story'},events})).map(value=>value.factReceiptId),['fact-one']);
  delete events[3].data.meta.rpLastStep.record.factReceiptId;assert.equal(acceptedFactPresentations(projectSession({header:{id:'story'},events})).length,0);
});

// Minimal field excerpt of SDK44's 2026-10-26T13-29-23-969Z-9dd3d59e/a-live.json.
// Its observed seq/IDs/source kinds/order are retained; the runtime snapshot body is reduced to its first line.
const measuredPendingPrefix=()=>[
  {seq:4,type:'turn/start',data:{turn:1}},
  {seq:8,type:'user/message',surfaceOp:'append',data:{id:'0f050822-2478-4478-bc2c-953b7d98502d',role:'user',source:{kind:'user'},content:[{type:'text',text:'SDK_PROBE_PENDING pending-original'}]}},
  {seq:9,type:'user/message',surfaceOp:'append',data:{id:'f87735bc-03fa-4ef7-bed1-f3fe1bf8978e',role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'}]}},
  {seq:13,type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,message:{id:'5ae32c1c-0f71-4ef9-b376-97d053844504',role:'assistant',content:[{type:'tool-call',id:'51851021-f20e-4c1c-a1ec-7354512b94c7',name:'sdk_probe_pending',arguments:'{"operationId":"pending-original"}'}]}}},
  {seq:14,type:'tool/call',data:{turn:1,step:1,callId:'51851021-f20e-4c1c-a1ec-7354512b94c7',name:'sdk_probe_pending',arguments:'{"operationId":"pending-original"}'}},
];
function captured(events){const id='session-b777cbe7-60c7-4259-889f-e0188375f733',callId='51851021-f20e-4c1c-a1ec-7354512b94c7',exec={agent:{session:{id,snapshotEvents:()=>events}},callId,rootCallId:callId},canonical=canonicalSource(exec,'sdk_probe_pending');return captureFactTurn(projectSession({header:{id},events}),canonical,launch());}
test('capture uses the real player in the measured rc3 user then runtime-context order',()=>{
  const events=measuredPendingPrefix(),before=structuredClone(events);assert.deepEqual(captured(events).playerInput,{seq:8,messageId:'0f050822-2478-4478-bc2c-953b7d98502d',text:'SDK_PROBE_PENDING pending-original'});assert.deepEqual(events,before);
});
test('capture freezes the latest real user before the canonical assistant, without text heuristics',()=>{
  const events=measuredPendingPrefix();events.splice(1,0,{seq:7,type:'user/message',surfaceOp:'append',data:{id:'earlier-player',source:{kind:'user'},content:[{type:'text',text:'Earlier action'}]}});events.find(event=>event.seq===8).data.content[0].text='Current runtime context. This is the player choosing these words.';events.at(-1).seq=16;events.splice(-1,0,{seq:15,type:'user/message',surfaceOp:'append',data:{id:'later-player',source:{kind:'user'},content:[{type:'text',text:'A later user message cannot change this fact assistant input'}]}});
  assert.deepEqual(captured(events).playerInput,{seq:8,messageId:'0f050822-2478-4478-bc2c-953b7d98502d',text:'Current runtime context. This is the player choosing these words.'});
});
