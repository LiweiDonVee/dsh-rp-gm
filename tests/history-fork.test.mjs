import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createGmHost} from '../src/host.mjs';import {acceptedFactPresentations,projectSession} from '../src/session.mjs';
import {contractFixture} from './contract-fixture.mjs';import {nativeFixture} from './native-fixture.mjs';import {launch} from './fixtures.mjs';

// LastStep's effective-history contract over this fixture's canonical results.
function installHistory(f){
  f.last.storyHistory=async({sessionId})=>{
    const agent=f.sessions.get(sessionId),view=projectSession({header:agent.session.header,events:agent.events}),selected=new Map();
    for(const {result,call,assistant,factReceiptId} of acceptedFactPresentations(view)){
      const base=agent.events.find(event=>event.type==='tool/result'&&event.surfaceOp==='append'&&event.data.message.toolCallId===call.data.callId);
      const record={ref:{sessionId,presentationId:base.data.meta.rpLastStep.record.id,assistantMessageId:assistant.data.message.id,callSeq:call.seq,baseResultSeq:base.seq,resultSeq:result.seq},factReceiptId,text:result.data.message.content.map(block=>block.text??'').join('\n')};
      selected.set(factReceiptId,record);
    }
    return {schemaVersion:1,records:[...selected.values()]};
  };
}
async function opened(t){
  const f=nativeFixture(await contractFixture(t));installHistory(f);
  // Current Database exposes latestReceipt, including a proposal inherited by a child.
  const factAccess=f.db.factAccess;f.db.factAccess=async input=>{const access=await factAccess(input);return {...access,latestReceipt:async()=>{
    for(const receipt of [...f.states.get(input.sessionId).receipts].sort((left,right)=>right.source.turnStartSeq-left.source.turnStartSeq||right.databaseRevision-left.databaseRevision))try{return await access.getReceipt(receipt.id);}catch(error){if(error.code!=='INACTIVE_SOURCE')throw error;}return null;
  }};};
  const service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());const {sessionId:id}=await service.startStory(launch());f.installPresenter(service);const opening=await f.runTool(id,'rp_begin_story');await f.runTool(id,'rp_present',{factReceiptId:opening.id});await service.binding({sessionId:id});return {...f,service,id};
}
async function round(f,index){const state=await f.runTool(f.id,'rp_gm_state'),receipt=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:`Round ${index}`,facts:{schemaVersion:1,items:[{id:'round',text:`Fact round ${index}`}]},packet:{playerAction:`Action ${index}`}});f.append(f.sessions.get(f.id),'user/message',{id:randomUUID(),role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'Current runtime context before the next native step'}]},'append');await f.runTool(f.id,'rp_present',{factReceiptId:receipt.id});return {receipt,record:(await f.last.storyHistory({sessionId:f.id})).records.at(-1),end:f.sessions.get(f.id).events.at(-1).seq};}
const input=()=>({id:randomUUID(),role:'user',source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'Next player action'}]});
function revise(f,record,{management=false}={}){
  const agent=f.sessions.get(f.id),lastTurn=agent.events.findLast(event=>event.type==='turn/start').data.turn;
  if(management){
    const message={id:randomUUID(),role:'user',source:{kind:'rp-last-step-owner',operation:'adopt'},content:[{type:'text',text:'Adopt prose without advancing facts'}]};
    f.append(agent,'agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]});f.append(agent,'turn/start',{turn:lastTurn+1});f.append(agent,'agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});
  }else agent.events.pop();
  const data=structuredClone(agent.events.find(event=>event.seq===record.ref.resultSeq).data);data.message.content=[{type:'text',text:'Adopted third-round reading'}];
  const result=f.append(agent,'tool/result',data,{op:'replace',startSeq:record.ref.resultSeq,endSeq:record.ref.resultSeq},[record.ref.callSeq,record.ref.resultSeq]);
  const end=f.append(agent,'turn/end',{turn:management?lastTurn+1:lastTurn,reason:{kind:management?'blocked':'completed'}});
  return {ref:{...record.ref,resultSeq:result.seq},end:end.seq};
}

test('eight action rounds branch at the third formal reading with exact facts and an unchanged parent',async t=>{
  const f=await opened(t),rounds=[];for(let index=1;index<=8;index++)rounds.push(await round(f,index));
  const target=rounds[2],parent=structuredClone(f.sessions.get(f.id).events),before={...f.counts};
  const child=await f.service.forkStoryAtReading({sessionId:f.id,basedOn:target.record.ref});
  assert.equal(f.service.capabilities.forkStoryAtReading,1);assert.deepEqual(Object.keys(child).sort(),['basedOn','binding','branchRef','parentSessionId','sessionId']);assert.equal(child.parentSessionId,f.id);assert.deepEqual(child.basedOn,target.record.ref);assert.deepEqual(child.branchRef,{...target.record.ref,sessionId:child.sessionId});assert.equal(child.binding.sessionId,child.sessionId);
  assert.equal(f.forks.at(-1).atSeq,target.end);assert.deepEqual(f.sessions.get(child.sessionId).events,parent.slice(0,target.end+1));assert.deepEqual(f.sessions.get(f.id).events,parent);
  const state=await f.service.storyState({sessionId:child.sessionId});assert.equal(state.lastFactReceipt.id,target.receipt.id);assert.equal(state.lastFactReceipt.sessionId,child.sessionId);assert.equal(state.facts.items[0].text,'Fact round 3');assert.equal((await f.service.storyState({sessionId:f.id})).facts.items[0].text,'Fact round 8');assert.equal((await f.last.storyHistory({sessionId:child.sessionId})).records.length,4);assert.deepEqual(f.counts,before);
});

test('a content-only adoption before its own natural turn end supplies the branch reading',async t=>{
  const f=await opened(t);await round(f,1);await round(f,2);const third=await round(f,3),adopted=revise(f,third.record);await round(f,4);
  const child=await f.service.forkStoryAtReading({sessionId:f.id,basedOn:adopted.ref});assert.equal(f.forks.at(-1).atSeq,adopted.end);assert.equal((await f.last.storyHistory({sessionId:child.sessionId})).records.at(-1).text,'Adopted third-round reading');
});

test('RP-only management adoption before the next action uses its physical end despite the result old turn',async t=>{
  const f=await opened(t),third=await round(f,3),adopted=revise(f,third.record,{management:true});const agent=f.sessions.get(f.id);assert.notEqual(agent.events.find(event=>event.seq===adopted.ref.resultSeq).data.turn,agent.events.at(-1).data.turn);await round(f,4);
  const child=await f.service.forkStoryAtReading({sessionId:f.id,basedOn:adopted.ref});assert.equal(f.forks.at(-1).atSeq,adopted.end);assert.ok(adopted.end>adopted.ref.resultSeq);assert.equal((await f.service.storyState({sessionId:child.sessionId})).lastFactReceipt.id,third.receipt.id);
});

test('reviewed facts keep their original action while the confirmed decision and owner presentation precede the cut',async t=>{
  const f=await opened(t),state=await f.runTool(f.id,'rp_gm_state'),receipt=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:'Reviewed action',packet:{playerAction:'Reviewed player action'}}),agent=f.sessions.get(f.id);
  const call=agent.events.find(event=>event.seq===receipt.source.callSeq),assistant=agent.events.find(event=>event.data?.message?.id===receipt.source.assistantMessageId);call.data.name='rp_propose_turn';assistant.data.message.content[0].name='rp_propose_turn';f.finish(f.id);
  const commandId=randomUUID(),requestHash='a'.repeat(64),run=f.append(agent,'command/run',{commandId,name:'rp-gm-fact-decision',args:`approve ${requestHash}`,source:{kind:'user'}}),done=f.append(agent,'command/done',{commandId,kind:'success',text:JSON.stringify({schemaVersion:1,operationId:'approve',requestHash})});
  const saved=f.states.get(f.id).receipts.find(item=>item.id===receipt.id);saved.decisionSource={sessionId:f.id,commandId,runSeq:run.seq,requestHash,doneSeq:done.seq};
  const message={id:randomUUID(),role:'user',source:{kind:'rp-last-step-owner',operation:'presentFact'},content:[{type:'text',text:'Present approved facts'}]},turn=agent.events.findLast(event=>event.type==='turn/start').data.turn+1;
  f.append(agent,'agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]});f.append(agent,'turn/start',{turn});f.append(agent,'agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});f.append(agent,'step/start',{turn,step:1});f.append(agent,'user/message',message,'append');
  await f.runTool(f.id,'rp_present',{factReceiptId:receipt.id});const selected=(await f.last.storyHistory({sessionId:f.id})).records.at(-1),boundary=agent.events.at(-1).seq;await round(f,4);
  const child=await f.service.forkStoryAtReading({sessionId:f.id,basedOn:selected.ref});assert.equal(f.forks.at(-1).atSeq,boundary);assert.ok(selected.ref.callSeq>done.seq);assert.ok(done.seq>receipt.source.turnStartSeq);assert.equal((await f.service.storyState({sessionId:child.sessionId})).lastFactReceipt.id,receipt.id);
});

test('missing factual decision confirmation and missing history support fail before a fork',async t=>{
  const f=await opened(t),third=await round(f,3),saved=f.states.get(f.id).receipts.find(item=>item.id===third.receipt.id);saved.decisionSource={commandId:'not-confirmed',doneSeq:third.end};
  await assert.rejects(f.service.forkStoryAtReading({sessionId:f.id,basedOn:third.record.ref}),{code:'READING_FORK_UNAVAILABLE'});delete saved.decisionSource;delete f.last.storyHistory;
  await assert.rejects(f.service.forkStoryAtReading({sessionId:f.id,basedOn:third.record.ref}),{code:'LAST_STEP_HISTORY_UNAVAILABLE'});assert.equal(f.forks.length,0);
});

test('a later adoption of old prose cannot cross the next action and creates no child',async t=>{
  const f=await opened(t),third=await round(f,3);await round(f,4);const adopted=revise(f,third.record,{management:true}),parent=structuredClone(f.sessions.get(f.id).events),size=f.sessions.size;
  await assert.rejects(f.service.forkStoryAtReading({sessionId:f.id,basedOn:adopted.ref}),error=>error.code==='READING_FORK_UNAVAILABLE'&&error.factReceiptId===third.receipt.id&&error.resultSeq===adopted.ref.resultSeq&&Number.isSafeInteger(error.blockingSeq));assert.equal(f.sessions.size,size);assert.equal(f.forks.length,0);assert.deepEqual(f.sessions.get(f.id).events,parent);
});

test('references must name the exact current formal selection, and inactive facts remain authoritative',async t=>{
  const f=await opened(t),third=await round(f,3),adopted=revise(f,third.record,{management:true});
  for(const basedOn of [{...adopted.ref,extra:true},{...adopted.ref,sessionId:'foreign'},{...adopted.ref,resultSeq:-1}])await assert.rejects(f.service.forkStoryAtReading({sessionId:f.id,basedOn}),{code:'INVALID_NARRATIVE_REF'});
  await assert.rejects(f.service.forkStoryAtReading({sessionId:f.id,basedOn:third.record.ref}),{code:'NARRATIVE_CONFLICT'});f.states.get(f.id).inactive.add(third.receipt.id);await assert.rejects(f.service.forkStoryAtReading({sessionId:f.id,basedOn:adopted.ref}),{code:'INACTIVE_SOURCE'});assert.equal(f.forks.length,0);
});

test('early next-turn and next-step inputs cannot be inherited behind the selected reading',async t=>{
  for(const target of ['next-turn','next-step']){
    const f=await opened(t),third=await round(f,3),agent=f.sessions.get(f.id);agent.events.pop();f.append(agent,'agent/inbox/spliced',{target,start:0,inserted:[input()]});f.append(agent,'turn/end',{turn:agent.events.findLast(event=>event.type==='turn/start').data.turn,reason:{kind:'completed'}});
    await assert.rejects(f.service.forkStoryAtReading({sessionId:f.id,basedOn:third.record.ref}),{code:'READING_FORK_UNAVAILABLE'});assert.equal(f.forks.length,0);
  }
});

test('next-step input already consumed by the selected factual turn belongs to that action',async t=>{
  const f=await opened(t),state=await f.runTool(f.id,'rp_gm_state'),agent=f.sessions.get(f.id),message=input();f.append(agent,'agent/inbox/spliced',{target:'next-step',start:0,inserted:[message]});f.append(agent,'agent/inbox/spliced',{target:'next-step',start:0,removedCount:1,inserted:[]});f.append(agent,'user/message',message,'append');
  const receipt=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:'Current next-step action',packet:{playerAction:'Next player action'}});await f.runTool(f.id,'rp_present',{factReceiptId:receipt.id});const record=(await f.last.storyHistory({sessionId:f.id})).records.at(-1),boundary=agent.events.at(-1).seq;
  const child=await f.service.forkStoryAtReading({sessionId:f.id,basedOn:record.ref});assert.equal(f.forks.at(-1).atSeq,boundary);assert.ok(f.sessions.get(child.sessionId).events.some(event=>event.type==='user/message'&&event.data.id===message.id));
});

test('a canceled queued action can leave an empty prefix after the reading natural end',async t=>{
  const f=await opened(t),third=await round(f,3),agent=f.sessions.get(f.id);agent.events.pop();f.append(agent,'agent/inbox/spliced',{target:'next-turn',start:0,inserted:[input()]});f.append(agent,'turn/end',{turn:agent.events.findLast(event=>event.type==='turn/start').data.turn,reason:{kind:'completed'}});const canceled=f.append(agent,'agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[],outcome:'canceled'});
  await f.service.forkStoryAtReading({sessionId:f.id,basedOn:third.record.ref});assert.equal(f.forks.at(-1).atSeq,canceled.seq);
});

test('a host-added fork closer cannot turn an unfinished inherited reading into a natural boundary',async t=>{
  const f=await opened(t),third=await round(f,3),first=await f.service.forkStory({sessionId:f.id,atSeq:third.record.ref.resultSeq}),agent=f.sessions.get(first.sessionId);
  f.append(agent,'session/end-seed',{inherited:true});f.append(agent,'turn/end',{turn:agent.events.findLast(event=>event.type==='turn/start').data.turn,reason:{kind:'forked'}});const count=f.forks.length;
  await assert.rejects(f.service.forkStoryAtReading({sessionId:first.sessionId,basedOn:{...third.record.ref,sessionId:first.sessionId}}),{code:'READING_FORK_UNAVAILABLE'});assert.equal(f.forks.length,count);
});

test('child verification rejects a changed formal reading and retains the restoring recovery state',async t=>{
  const f=await opened(t),third=await round(f,3),history=f.last.storyHistory;f.last.storyHistory=async input=>{const value=await history(input);if(input.sessionId!==f.id)value.records.at(-1).factReceiptId='wrong-facts';return value;};
  await assert.rejects(f.service.forkStoryAtReading({sessionId:f.id,basedOn:third.record.ref}),{code:'INVALID_ANCESTRY'});assert.equal(f.forks.length,1);const child=[...f.sessions.keys()].find(id=>id!==f.id);assert.equal((await f.service.binding({sessionId:child})).status,'restoring');
});

test('legacy full forks, explicit native prefixes and rollback retain their return contract',async t=>{
  const f=await opened(t),openingEnd=f.sessions.get(f.id).events.at(-1).seq;await round(f,1);
  for(const child of [await f.service.forkStory({sessionId:f.id}),await f.service.forkStory({sessionId:f.id,atSeq:openingEnd}),await f.service.rollbackStory({sessionId:f.id})])assert.deepEqual(Object.keys(child).sort(),['binding','sessionId']);assert.equal(f.forks.at(-1).atSeq,openingEnd);
});
