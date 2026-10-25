import test from 'node:test';import assert from 'node:assert/strict';
import {acceptedFactPresentations,canonicalSource,projectSession} from '../src/session.mjs';import {sourceEvents} from './fixtures.mjs';
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
