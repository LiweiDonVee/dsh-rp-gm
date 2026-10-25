import test from 'node:test';import assert from 'node:assert/strict';
import {createBinding,normalizeStart,seedEntries} from '../src/core.mjs';import {createBindingStore} from '../src/store.mjs';import {createSessionReader} from '../src/session.mjs';
import {launch} from './fixtures.mjs';import {contractFixture} from './contract-fixture.mjs';
const {createGmHost}=await import(process.env.GM_PAGINATION_HOST??new URL('../src/host.mjs',import.meta.url).href);

// Public gateway pagination fixture. The reader/provider are real GM code; owner data is synthetic.
async function pagedSource(t){
  const f=await contractFixture(t),store=createBindingStore({directory:f.directory}),request=normalizeStart(launch()),journal=await store.reserve(request),profile=await f.last.ensureBuiltinProfile({key:'pagination-ready',profile:{name:'Ready style',entries:[]}}),binding=createBinding(request,{...journal,profile});
  await store.prepare(request.launchId,binding);await store.setStatus(journal.sessionId,'starting');
  await f.db.bindSources({sessionId:journal.sessionId,sources:[],expectedRevision:(await f.db.state()).revision});
  await f.db.initializeStoryState({sessionId:journal.sessionId,entries:seedEntries(request),factEntryRefs:binding.factEntryRefs,launchId:request.launchId,expectedRevision:(await f.db.state()).revision});
  await f.last.bindSession({sessionId:journal.sessionId,...profile,expectedRevision:(await f.last.state(journal.sessionId)).revision});
  f.db.effectiveV2=async()=>{const value=f.states.get(journal.sessionId);return {binding:structuredClone(value.binding),entries:structuredClone(value.seed)};};f.last.narratives=async()=>({records:[]});
  const canonical={header:{id:journal.sessionId,agentPreset:'rp-gm',audit:{revision:1}},events:Array.from({length:105},(_,seq)=>({seq,type:'system/message',surfaceOp:'append',data:{message:{id:`message-${seq}`,role:'system',content:[{type:'text',text:`Public fixture record ${seq}`}]}}}))};
  let current,followCalls=0,pageCalls=0,onSecond;
  f.ctx.typertGateway.stream=async function*(input){assert.equal(input.namespace,'session');assert.equal(input.method,'follow');assert.equal(input.peer,f.ctx.connection.browserPeer);assert.equal(input.args.request.address.sessionId,journal.sessionId);assert.equal(input.args.request.maxMessages,100);if(++followCalls===2)onSecond?.(canonical);current=structuredClone(canonical);yield {type:'snapshot',header:current.header,cursor:current.events.at(-1).seq,records:current.events.slice(-100),hasMore:true};};
  f.ctx.typertGateway.invoke=async input=>{assert.equal(input.namespace,'session');assert.equal(input.method,'page');assert.equal(input.peer,f.ctx.connection.browserPeer);assert.equal(input.args.request.throughSeq,current.events.at(-1).seq);assert.equal(input.args.request.maxMessages,500);pageCalls++;return {records:current.events.filter(event=>event.seq<input.args.request.beforeSeq).map(event=>({type:'event',event})),hasMore:false};};
  const service=await createGmHost(f.ctx,{directory:f.directory});t.after(()=>service.close());
  return {service,id:journal.sessionId,store,canonical,read:createSessionReader(f.ctx),reset(change){followCalls=0;pageCalls=0;onSecond=change;},counts:()=>({followCalls,pageCalls})};
}

test('stable 105-event public pagination exports through the actual Session reader',async t=>{
  const f=await pagedSource(t),first=await f.read(f.id),second=await f.read(f.id);assert.deepEqual(first,second);assert.deepEqual(first.events.map(event=>event.seq),[...Array.from({length:100},(_,index)=>index+5),0,1,2,3,4]);
  f.reset();const revision=await f.store.contentRevision(),state=await f.service.exportState({sessionIds:[f.id]});assert.equal(state.revision,revision.revision);assert.equal(state.payload.bindings[0].binding.sessionId,f.id);assert.deepEqual(f.counts(),{followCalls:2,pageCalls:2});assert.deepEqual(await f.store.contentRevision(),revision);
});

test('paged source fence accepts only the T10 missing/undefined delegationDepth zero equivalence',async t=>{
  for(const [name,before,after]of [['missing to zero','missing',0],['undefined to zero',undefined,0],['zero to missing',0,'missing']])await t.test(name,async t=>{const f=await pagedSource(t);if(before!=='missing')f.canonical.header.delegationDepth=before;f.reset(value=>{if(after==='missing')delete value.header.delegationDepth;else value.header.delegationDepth=after;});await f.service.exportState({sessionIds:[f.id]});assert.deepEqual(f.counts(),{followCalls:2,pageCalls:2});});
});

test('paged source fence rejects appended records and complete header/event field changes',async t=>{
  const changes=[
    ['append',value=>value.events.push({seq:105,type:'user/message',surfaceOp:'append',data:{id:'new-input',role:'user',content:[{type:'text',text:'New input'}]}})],
    ['earlier page content',value=>{value.events[1].data.message.content[0].text='Changed earlier page';}],
    ['new event field',value=>{value.events[1].audit={version:1};}],
    ['new undefined event field',value=>{value.events[1].audit=undefined;}],
    ['existing header field',value=>{value.header.audit.revision=2;}],
    ['new header field',value=>{value.header.futureField='new';}],
    ['new undefined header field',value=>{value.header.futureField=undefined;}],
    ['nonzero delegationDepth',value=>{value.header.delegationDepth=1;}],
    ['string delegationDepth',value=>{value.header.delegationDepth='0';}],
    ['null delegationDepth',value=>{value.header.delegationDepth=null;}],
  ];
  for(const [name,change]of changes)await t.test(name,async t=>{const f=await pagedSource(t),revision=await f.store.contentRevision();f.reset(change);await assert.rejects(f.service.exportState({sessionIds:[f.id]}),{code:'EXPORT_CHANGED'});assert.deepEqual(f.counts(),{followCalls:2,pageCalls:2});assert.deepEqual(await f.store.contentRevision(),revision);});
});
