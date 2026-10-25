import test from 'node:test';import assert from 'node:assert/strict';
import {createGmHost} from '../src/host.mjs';import {createBindingStore} from '../src/store.mjs';import {launch} from './fixtures.mjs';import {contractFixture} from './contract-fixture.mjs';import {nativeFixture} from './native-fixture.mjs';
import {createBinding,normalizeStart} from '../src/core.mjs';
async function source(t,afterRead){const f=nativeFixture(await contractFixture(t));if(afterRead)f.options.readSession=async(id,signal)=>{const view=await f.readSession(id,signal);await afterRead(f,id);return view;};const service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());const {sessionId:id}=await service.startStory(launch());f.installPresenter(service);const opening=await f.runTool(id,'rp_begin_story'),presented=await f.runTool(id,'rp_present',{factReceiptId:opening.id});await service.binding({sessionId:id});
  const events=f.sessions.get(id).events,call=events.find(event=>event.type==='tool/call'&&event.data.name==='rp_present'),result=events.find(event=>event.type==='tool/result'&&event.data.message.toolCallId===call.data.callId),assistant=events.find(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.id===call.data.callId));
  f.last.narratives=async()=>({records:[{id:JSON.stringify([presented.id,result.seq]),ref:{sessionId:id,presentationId:presented.id,assistantMessageId:assistant.data.message.id,callSeq:call.seq,baseResultSeq:result.seq,resultSeq:result.seq},turn:1,action:'开始故事',text:launch().opening.text,factReceiptId:opening.id}]});return {...f,service,id,opening};}
async function destination(t,from){
  const f=await contractFixture(t),observations=new Map([[from.id,await from.readSession(from.id)]]),snapshot=await from.db.effectiveV2({sessionId:from.id});let reads=0,agentReads=0;
  f.options.readSession=async id=>{reads++;return structuredClone(observations.get(id)??null);};
  f.db.effectiveV2=async()=>structuredClone(snapshot);f.db.factAccess=async()=>{agentReads++;throw Error('Pre-resume restore cannot manufacture a fact Agent');};
  f.last.profile=(...args)=>from.last.profile(...args);f.last.state=(...args)=>from.last.state(...args);f.last.narratives=(...args)=>from.last.narratives(...args);
  const service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());return {...f,service,observations,reads:()=>reads,agentReads:()=>agentReads};
}
test('GM provider exports selected metadata only with a stable durable content revision',async t=>{
  const f=await source(t),before=await f.service.contentRevision({}),state=await f.service.exportState({sessionIds:[f.id]});
  assert.equal(state.schemaVersion,1);assert.equal(state.revision,before.revision);assert.deepEqual(Object.keys(state.payload).sort(),['bindings','launches']);assert.equal(state.payload.bindings[0].binding.sessionId,f.id);assert.equal(state.payload.launches[0].launchId,'launch-one');
  const serialized=JSON.stringify(state.payload);for(const forbidden of ['initialFacts','initialScene','密封信件由旅人持有。','restoreGates'])assert.equal(serialized.includes(forbidden),false,forbidden);
  await f.service.binding({sessionId:f.id});assert.equal((await f.service.contentRevision({})).revision,before.revision);
  const store=createBindingStore({directory:f.directory});await store.setStatus(f.id,'starting');assert.ok((await f.service.contentRevision({})).revision>before.revision);assert.equal((await createBindingStore({directory:f.directory}).contentRevision()).revision,(await f.service.contentRevision({})).revision);
});
test('preflight is nonmutating and does not require destination canonical sessions to exist',async t=>{
  const f=await source(t),state=await f.service.exportState({sessionIds:[f.id]}),d=await destination(t,f);d.observations.clear();const before=await d.service.contentRevision({});
  assert.deepEqual(await d.service.preflightRestore({sessionIds:[f.id],state}),{supported:true,conflicts:[],requirements:[]});assert.equal(d.reads(),0);assert.deepEqual(await d.service.contentRevision({}),before);
  const bad=structuredClone(state);bad.payload.bindings[0].binding.initialFacts={items:[]};const preview=await d.service.preflightRestore({sessionIds:[f.id],state:bad});assert.equal(preview.supported,false);assert.equal(preview.conflicts[0].code,'RESTORE_PAYLOAD_INVALID');
});
test('restore validates real owner projections before resume and persists only restoring metadata',async t=>{
  const f=await source(t),state=await f.service.exportState({sessionIds:[f.id]}),d=await destination(t,f);await d.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id]});
  const result=await d.service.restoreState({restoreId:'restore-one',sessionIds:[f.id],state,expectedRevision:(await d.service.contentRevision({})).revision});assert.deepEqual(result.restoredSessionIds,[f.id]);assert.equal(d.agentReads(),0);assert.equal(d.sessions.size,0);
  const record=await createBindingStore({directory:d.directory}).binding(f.id);assert.equal(record.binding.status,'restoring');assert.deepEqual(record.binding.character,launch().character);assert.equal((await d.service.listStories({})).stories[0].status,'restoring');
  const reads=d.reads();d.observations.clear();assert.deepEqual(await d.service.restoreState({restoreId:'restore-one',sessionIds:[f.id],state,expectedRevision:0}),result);assert.equal(d.reads(),reads);
});
test('failed proof leaves GM data and revision unchanged while completed identity checks precede deeper proof',async t=>{
  const f=await source(t),state=await f.service.exportState({sessionIds:[f.id]}),d=await destination(t,f);await d.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id]});const original=d.observations.get(f.id);d.observations.clear();
  const before=await d.service.contentRevision({});await assert.rejects(d.service.restoreState({restoreId:'restore-one',sessionIds:[f.id],state,expectedRevision:before.revision}),{code:'RESTORE_REQUIREMENT_MISSING'});assert.deepEqual(await d.service.contentRevision({}),before);assert.deepEqual(await d.service.listStories({}),{stories:[]});
  const changed=structuredClone(state);changed.payload.bindings[0].binding.persona.description='Changed reviewed source';const reads=d.reads();
  await assert.rejects(d.service.restoreState({restoreId:'restore-one',sessionIds:['absent'],state,expectedRevision:0}),{code:'RESTORE_ID_CONFLICT'});assert.equal(d.reads(),reads);
  d.observations.set(f.id,original);await d.service.restoreState({restoreId:'restore-one',sessionIds:[f.id],state,expectedRevision:(await d.service.contentRevision({})).revision});
  changed.payload.bindings[0].binding.character.system_prompt='Invalid extension';await assert.rejects(d.service.restoreState({restoreId:'restore-one',sessionIds:[f.id],state:changed,expectedRevision:0}),{code:'RESTORE_ID_CONFLICT'});
});
test('activation defers Agent-scoped receipt/ref proof and retains the reservation when that proof fails',async t=>{
  const f=await source(t),state=await f.service.exportState({sessionIds:[f.id]}),d=await destination(t,f);await d.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id]});await d.service.restoreState({restoreId:'restore-one',sessionIds:[f.id],state,expectedRevision:(await d.service.contentRevision({})).revision});assert.equal(d.agentReads(),0);
  nativeFixture(d);d.states.set(f.id,structuredClone(f.states.get(f.id)));const agent=d.makeAgent(f.id);agent.events.push(...structuredClone(f.sessions.get(f.id).events));await d.emit('agent/created',{agent});
  const receipt=d.states.get(f.id).receipts.find(item=>item.id===f.opening.id);receipt.stateRefs[0].version=999;
  await assert.rejects(d.service.activateRestored({restoreId:'restore-one',sessionIds:[f.id]}),{code:'RESTORE_INCOMPLETE'});assert.equal((await d.service.binding({sessionId:f.id})).status,'restoring');
  receipt.stateRefs[0].version=1;await d.service.activateRestored({restoreId:'restore-one',sessionIds:[f.id]});assert.equal((await d.service.binding({sessionId:f.id})).status,'active');assert.equal(d.counts.factWrites,0);assert.equal(d.counts.prompts,0);
});

test('activation ignores an inherited future receipt hint absent from the actual child prefix',async t=>{
  const f=await source(t),state=await f.service.exportState({sessionIds:[f.id]});state.payload.bindings[0].lastReceiptId='parent-future-not-in-prefix';
  const d=await destination(t,f);await d.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id]});await d.service.restoreState({restoreId:'restore-one',sessionIds:[f.id],state,expectedRevision:(await d.service.contentRevision({})).revision});
  nativeFixture(d);d.states.set(f.id,structuredClone(f.states.get(f.id)));const agent=d.makeAgent(f.id);agent.events.push(...structuredClone(f.sessions.get(f.id).events));await d.emit('agent/created',{agent});
  await d.service.activateRestored({restoreId:'restore-one',sessionIds:[f.id]});assert.equal((await d.service.binding({sessionId:f.id})).status,'active');assert.equal((await d.service.storyState({sessionId:f.id})).lastFactReceipt.id,f.opening.id);assert.equal(d.counts.factWrites,0);
});
test('export rejects generation and changed metadata or canonical source without nesting coordinator maintenance',async t=>{
  let change;const f=await source(t,async(f,id)=>{if(change){const action=change;change=null;await action(f,id);}}),agent=f.sessions.get(f.id);agent.runMaintenance=()=>{throw Error('Coordinator maintenance must not be nested');};
  await f.service.exportState({sessionIds:[f.id]});agent.status='running';await assert.rejects(f.service.exportState({sessionIds:[f.id]}),{code:'EXPORT_CHANGED'});agent.status='idle';
  change=(f,id)=>createBindingStore({directory:f.directory}).setStatus(id,'starting');await assert.rejects(f.service.exportState({sessionIds:[f.id]}),{code:'EXPORT_CHANGED'});
  await createBindingStore({directory:f.directory}).setStatus(f.id,'active');change=(f,id)=>{f.append(f.sessions.get(id),'user/message',{id:'changed-source',role:'user',source:{kind:'user'},content:[{type:'text',text:'New owner input'}]},'append');};await assert.rejects(f.service.exportState({sessionIds:[f.id]}),{code:'EXPORT_CHANGED'});
});
test('invalid canonical proof leaves metadata and revision unchanged and existing identities stay protected',async t=>{
  const f=await source(t),state=await f.service.exportState({sessionIds:[f.id]}),preview=await f.service.preflightRestore({sessionIds:[f.id],state});assert.equal(preview.supported,false);assert.equal(preview.conflicts[0].code,'RESTORE_ID_CONFLICT');
  const d=await destination(t,f);await d.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id]});const before=await d.service.contentRevision({}),bad=structuredClone(state);bad.payload.bindings[0].opening.source.callId='forged-call';
  await assert.rejects(d.service.restoreState({restoreId:'restore-one',sessionIds:[f.id],state:bad,expectedRevision:before.revision}),{code:'RESTORE_PAYLOAD_INVALID'});assert.deepEqual(await d.service.contentRevision({}),before);assert.deepEqual(await d.service.listStories({}),{stories:[]});assert.equal(d.agentReads(),0);
});
test('duplicate concurrent restore calls perform one atomic metadata merge and preserve unrelated stories',async t=>{
  const f=await source(t),state=await f.service.exportState({sessionIds:[f.id]}),d=await destination(t,f),store=createBindingStore({directory:d.directory}),request=normalizeStart(launch({launchId:'unrelated-story',title:'Unrelated'})),journal=await store.reserve(request);await store.prepare(request.launchId,createBinding(request,{...journal,profile:{profileId:'builtin',version:1}}));const unrelated=await store.binding(journal.sessionId);
  await d.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id]});const before=(await d.service.contentRevision({})).revision;
  const input={restoreId:'restore-one',sessionIds:[f.id],state,expectedRevision:before},[first,second]=await Promise.all([d.service.restoreState(input),d.service.restoreState(input)]);assert.deepEqual(first,second);assert.equal(first.revision,before+1);assert.equal((await d.service.listStories({})).stories.length,2);assert.equal(d.reads(),1);assert.deepEqual(await store.binding(journal.sessionId),unrelated);
});
test('launch style remains provenance while a legitimate LastStep owner rebind stays authoritative across restore',async t=>{
  const f=await source(t),initial=(await f.service.binding({sessionId:f.id})).profile;f.profiles.set('style-b',{id:'style-b',name:'Current style B',version:1,status:'ready',sourceId:null,entries:[]});
  await f.last.bindSession({sessionId:f.id,profileId:'style-b',version:1,expectedRevision:(await f.last.state(f.id)).revision});const binds=f.counts.profileBinds;await f.service.startStory(launch());assert.equal(f.counts.profileBinds,binds);assert.equal((await f.last.state(f.id)).binding.profileId,'style-b');
  const state=await f.service.exportState({sessionIds:[f.id]});assert.deepEqual(state.payload.bindings[0].binding.profile,initial);const d=await destination(t,f);await d.service.reserveRestore({restoreId:'restore-one',sessionIds:[f.id]});await d.service.restoreState({restoreId:'restore-one',sessionIds:[f.id],state,expectedRevision:(await d.service.contentRevision({})).revision});
  nativeFixture(d);d.states.set(f.id,structuredClone(f.states.get(f.id)));const agent=d.makeAgent(f.id);agent.events.push(...structuredClone(f.sessions.get(f.id).events));await d.emit('agent/created',{agent});await d.service.activateRestored({restoreId:'restore-one',sessionIds:[f.id]});assert.deepEqual((await d.service.binding({sessionId:f.id})).profile,initial);assert.equal((await d.last.state(f.id)).binding.profileId,'style-b');assert.equal(d.counts.profileBinds,0);
});
