import test from 'node:test';import assert from 'node:assert/strict';
import {createGmHost} from '../src/host.mjs';import {launch} from './fixtures.mjs';import {contractFixture} from './contract-fixture.mjs';import {nativeFixture} from './native-fixture.mjs';
async function story(t){const f=nativeFixture(await contractFixture(t)),service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());const result=await service.startStory(launch());f.installPresenter(service);return {...f,service,id:result.sessionId};}
async function opened(t){const f=await story(t),receipt=await f.runTool(f.id,'rp_begin_story');await f.runTool(f.id,'rp_present',{factReceiptId:receipt.id});return {...f,openingReceipt:receipt};}
test('native opening uses owner text and becomes active only after canonical rp_present acceptance',async t=>{
  const f=await story(t);await assert.rejects(f.runTool(f.id,'rp_begin_story',{openingText:'forged'}),{code:'INVALID_TOOL_ARGUMENTS'});
  const receipt=await f.runTool(f.id,'rp_begin_story');assert.equal(receipt.kind,'opening');assert.equal(receipt.openingText,launch().opening.text);assert.equal((await f.service.binding({sessionId:f.id})).status,'starting');
  const resolved=await f.service.presentation({sessionId:f.id,agent:f.sessions.get(f.id),factReceiptId:receipt.id});assert.deepEqual(resolved.story,{title:'雨夜客栈',character:launch().character,persona:launch().persona,examples:''});
  const presentation=await f.runTool(f.id,'rp_present',{factReceiptId:receipt.id});assert.equal(presentation.text,launch().opening.text);assert.equal((await f.service.binding({sessionId:f.id})).status,'active');
  assert.equal((await f.runTool(f.id,'rp_begin_story')).id,receipt.id);assert.equal(f.counts.factWrites,1);
});
test('lost fact response recovers one stable receipt and conflicting same turn exposes its id',async t=>{
  const f=await opened(t),state=await f.runTool(f.id,'rp_gm_state');const input={expectedRevision:state.revision,summary:'交出信件',facts:{schemaVersion:1,items:[{id:'letter-holder',text:'密封信件由林遥持有。'}]},packet:{playerAction:'把信交给林遥'}};
  f.faults.commitLost=true;await assert.rejects(f.runTool(f.id,'rp_commit_turn',input),{code:'LOST_RESPONSE'});const receipt=await f.runTool(f.id,'rp_commit_turn',input);assert.equal(f.counts.factWrites,2);
  assert.equal((await f.runTool(f.id,'rp_commit_turn',input)).id,receipt.id);assert.equal(f.counts.factWrites,2);
  await assert.rejects(f.runTool(f.id,'rp_commit_turn',{...input,summary:'different'}),error=>error.code==='TURN_ALREADY_COMMITTED'&&error.receiptId===receipt.id);
  assert.equal((await f.service.storyState({sessionId:f.id})).facts.items[0].text,'密封信件由林遥持有。');
});
test('owner lock rejects before fact mutation and disabled state is not exposed',async t=>{
  const f=await opened(t),state=await f.runTool(f.id,'rp_gm_state');f.states.get(f.id).seed.find(e=>e.id==='gm.facts').readOnly=true;
  await assert.rejects(f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:'change',facts:{schemaVersion:1,items:[]},packet:{playerAction:'act'}}),{code:'READ_ONLY'});assert.equal(f.counts.factWrites,1);
  f.states.get(f.id).seed.find(e=>e.id==='gm.facts').mode='disabled';await assert.rejects(f.runTool(f.id,'rp_gm_state'),{code:'STATE_UNAVAILABLE'});
});
test('writer failure and recovery in a new native turn reuse fact receipt without another fact commit',async t=>{
  const f=await opened(t),state=await f.runTool(f.id,'rp_gm_state');const receipt=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:'等待',packet:{playerAction:'等待'}});f.faults.writer=true;
  await assert.rejects(f.runTool(f.id,'rp_present',{factReceiptId:receipt.id}),{code:'WRITER_FAILED'});f.finish(f.id);
  const recovered=await f.service.presentation({sessionId:f.id,agent:f.sessions.get(f.id),factReceiptId:receipt.id});assert.equal(recovered.factReceipt.id,receipt.id);assert.equal(f.counts.factWrites,2);
  f.faults.writer=false;await f.runTool(f.id,'rp_present',{factReceiptId:receipt.id});assert.equal(f.counts.factWrites,2);
});
test('unbound agents do not receive GM tools and dispose releases the owned scopes',async t=>{
  const f=await story(t),foreign=f.makeAgent('foreign');foreign.session.header.agentPreset='standard';await f.emit('agent/created',{agent:foreign});assert.equal(foreign.tools.has('rp_commit_turn'),false);
  const agent=f.sessions.get(f.id);assert.equal(agent.tools.has('rp_commit_turn'),true);await f.service.close();assert.equal(agent.tools.has('rp_commit_turn'),false);
});
test('fork retrieves causal Database prefix and rollback removes later receipt without flattening facts',async t=>{
  const f=await opened(t),parent=f.sessions.get(f.id),prefix=structuredClone(parent.events),state=await f.runTool(f.id,'rp_gm_state');
  const receipt=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:'交信',facts:{schemaVersion:1,items:[{id:'letter-holder',text:'林遥持有信件。'}]},packet:{playerAction:'交信'}});
  const child=f.makeAgent('child',f.id);child.events.push(...prefix);await f.emit('agent/created',{agent:child});
  const forked=await f.service.storyState({sessionId:'child'});assert.equal(forked.binding.status,'active');assert.equal(forked.binding.character.assetId,'innkeeper');assert.equal(forked.facts.items[0].text,'密封信件由旅人持有。');assert.equal(forked.lastFactReceipt.id,f.openingReceipt.id);
  f.states.get(f.id).inactive.add(receipt.id);const source=parent.events.find(e=>e.type==='assistant/message'&&e.data.message.id===receipt.source.assistantMessageId);
  f.append(parent,'user/message',{id:'rewound',role:'user',content:[]},{op:'replace',startSeq:source.seq,endSeq:parent.events.filter(e=>e.surfaceOp==='append').at(-1).seq});
  const rewound=await f.service.storyState({sessionId:f.id});assert.equal(rewound.facts.items[0].text,'密封信件由旅人持有。');assert.equal(rewound.lastFactReceipt.id,f.openingReceipt.id);
  await assert.rejects(f.service.presentation({sessionId:f.id,agent:parent,factReceiptId:receipt.id}),{code:'INACTIVE_SOURCE'});
});
test('fork before opening uses own canonical opening source rather than parent future receipt',async t=>{
  const f=await story(t),parent=f.sessions.get(f.id),prefix=structuredClone(parent.events);
  const parentOpening=await f.runTool(f.id,'rp_begin_story');await f.runTool(f.id,'rp_present',{factReceiptId:parentOpening.id});
  const child=f.makeAgent('early-child',f.id);child.events.push(...prefix);await f.emit('agent/created',{agent:child});f.installPresenter(f.service);
  const receipt=await f.runTool('early-child','rp_begin_story');assert.equal(receipt.sessionId,'early-child');assert.notEqual(receipt.id,parentOpening.id);assert.equal(receipt.source.assistantMessageId,child.events.findLast(e=>e.type==='assistant/message').data.message.id);
});
test('receipt presentation refuses unrelated stories and superseded factual receipts',async t=>{
  const f=await opened(t),other=await f.service.startStory(launch({launchId:'unrelated'}));
  await assert.rejects(f.service.presentation({sessionId:other.sessionId,agent:f.sessions.get(f.id),factReceiptId:f.openingReceipt.id}),{code:'AGENT_MISMATCH'});
  const state=await f.runTool(f.id,'rp_gm_state');await f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:'later',packet:{playerAction:'wait'}});
  await assert.rejects(f.service.presentation({sessionId:f.id,agent:f.sessions.get(f.id),factReceiptId:f.openingReceipt.id}),{code:'FACT_RECEIPT_SUPERSEDED'});
});
test('binding metadata remains readable while missing Database blocks factual operations',async t=>{
  const f=await opened(t);await f.service.binding({sessionId:f.id});f.services.delete('rpDatabase');assert.equal((await f.service.binding({sessionId:f.id})).status,'active');assert.equal((await f.service.listStories({})).stories.length,1);await assert.rejects(f.service.storyState({sessionId:f.id}),{code:'DATABASE_UNAVAILABLE'});
});
test('lost opening response reuses the one committed owner opening',async t=>{
  const f=await story(t);f.faults.commitLost=true;await assert.rejects(f.runTool(f.id,'rp_begin_story'),{code:'LOST_RESPONSE'});const recovered=await f.runTool(f.id,'rp_begin_story');assert.equal(recovered.openingText,launch().opening.text);assert.equal(f.counts.factWrites,1);
});
test('an accepted receipt cannot create another formal presentation even before metadata refresh',async t=>{
  const f=await story(t),receipt=await f.runTool(f.id,'rp_begin_story');await f.runTool(f.id,'rp_present',{factReceiptId:receipt.id});await assert.rejects(f.service.presentation({sessionId:f.id,agent:f.sessions.get(f.id),factReceiptId:receipt.id}),{code:'FACT_ALREADY_PRESENTED'});assert.equal(f.counts.factWrites,1);
});
test('unload cancels an inherited scope still awaiting dependency setup',async t=>{
  const f=await opened(t),original=f.db.effectiveV2;let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  f.db.effectiveV2=async input=>{if(input.sessionId==='deferred-child'){entered();await waiting;}return original(input);};
  const child=f.makeAgent('deferred-child',f.id);child.events.push(...structuredClone(f.sessions.get(f.id).events));const attaching=f.emit('agent/created',{agent:child});await ready;await f.service.close();release();await attaching;
  assert.equal(child.tools.has('rp_commit_turn'),false);assert.equal(f.profileInherits.includes(child.id),false);
});
test('inactive historical turn selectors do not block the preceding active receipt or resurrect later facts',async t=>{
  const f=await opened(t),stateA=await f.runTool(f.id,'rp_gm_state');
  const receiptA=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:stateA.revision,summary:'把信放在柜台',facts:{schemaVersion:1,items:[{id:'letter-holder',text:'密封信件放在柜台上。'}]},packet:{playerAction:'把信放在柜台'}});f.finish(f.id);
  const stateB=await f.runTool(f.id,'rp_gm_state'),receiptB=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:stateB.revision,summary:'掌柜收信',facts:{schemaVersion:1,items:[{id:'letter-holder',text:'密封信件由林遥持有。'}]},packet:{playerAction:'请掌柜保管信件'}});f.finish(f.id);
  const agent=f.sessions.get(f.id),source=agent.events.find(event=>event.type==='assistant/message'&&event.data.message.id===receiptB.source.assistantMessageId);f.states.get(f.id).inactive.add(receiptB.id);
  f.append(agent,'user/message',{id:'owner-rewind',role:'user',content:[]},{op:'replace',startSeq:source.seq,endSeq:agent.events.filter(event=>event.surfaceOp==='append').at(-1).seq});
  const access=await f.db.factAccess({sessionId:f.id,agent});await assert.rejects(access.currentReceipt(receiptB.turnKey),{code:'INACTIVE_SOURCE'});assert.equal((await access.getReceipt(receiptA.id)).id,receiptA.id);
  const current=await f.service.storyState({sessionId:f.id});assert.equal(current.lastFactReceipt.id,receiptA.id);assert.equal(current.facts.items[0].text,'密封信件放在柜台上。');
  assert.equal((await f.service.presentation({sessionId:f.id,agent,factReceiptId:receiptA.id})).factReceipt.id,receiptA.id);const nativeState=await f.runTool(f.id,'rp_gm_state');assert.equal(nativeState.lastFactReceipt.id,receiptA.id);assert.equal(nativeState.currentReceipt,null);
  const boundary=agent.events.findLast(event=>event.type==='turn/end'&&event.seq<receiptA.source.turnStartSeq).seq;await f.service.rollbackStory({sessionId:f.id});assert.equal(f.forks.at(-1).atSeq,boundary);assert.equal((await f.service.storyState({sessionId:f.id})).facts.items[0].text,'密封信件放在柜台上。');assert.equal(f.counts.factWrites,3);
});
test('historical receipt discovery still propagates dependency errors other than inactive source',async t=>{
  const f=await opened(t),state=await f.runTool(f.id,'rp_gm_state'),receipt=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:'等待',packet:{playerAction:'等待'}}),original=f.db.factAccess;
  f.db.factAccess=async input=>{const access=await original(input);return {...access,currentReceipt:async key=>{if(key===receipt.turnKey)throw Object.assign(Error('Database selector unavailable'),{code:'DATABASE_UNAVAILABLE'});return access.currentReceipt(key);}};};
  await assert.rejects(f.service.storyState({sessionId:f.id}),{code:'DATABASE_UNAVAILABLE'});await assert.rejects(f.service.presentation({sessionId:f.id,agent:f.sessions.get(f.id),factReceiptId:receipt.id}),{code:'DATABASE_UNAVAILABLE'});assert.equal(f.counts.factWrites,2);
});
