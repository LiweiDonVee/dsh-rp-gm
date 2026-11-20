import test from 'node:test';import assert from 'node:assert/strict';
import {createGmHost} from '../src/host.mjs';import {createGmRoutes} from '../src/routes.mjs';import {createGmApi} from '../src/api.js';import {contractFixture} from './contract-fixture.mjs';import {nativeFixture} from './native-fixture.mjs';import {launch} from './fixtures.mjs';
async function active(t){
  const f=nativeFixture(await contractFixture(t)),calls=[];let openTurnStartSeq=25;
  f.ctx.agents.turnBoundaryOf=session=>{assert.equal(session.id,f.id);return {openTurnStartSeq};};
  const service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());const {sessionId:id}=await service.startStory(launch());f.id=id;f.installPresenter(service);const opening=await f.runTool(id,'rp_begin_story');await f.runTool(id,'rp_present',{factReceiptId:opening.id});await service.binding({sessionId:id});
  const agent=f.sessions.get(id);agent.cancel=(reason,options)=>{calls.push({openTurnStartSeq,reason,options});};agent.status='running';return {...f,service,agent,calls,setTurn:value=>{openTurnStartSeq=value;}};
}
test('cancelTurn synchronously stops only the exact running projected turn and preserves its inbox',async t=>{
  const f=await active(t);f.agent.session.snapshotEvents=()=>{throw Error('cancelTurn must use the turnBoundary projection');};
  assert.deepEqual(await f.service.cancelTurn({sessionId:f.id,expectedTurnStartSeq:25}),{schemaVersion:1,sessionId:f.id,expectedTurnStartSeq:25,accepted:true,observedTurnStartSeq:25});assert.deepEqual(f.calls,[{openTurnStartSeq:25,reason:{kind:'user'},options:{keepInbox:true}}]);
});
test('a delayed stop for an older or completed turn never aborts the following turn',async t=>{
  const f=await active(t);f.setTurn(50);
  assert.deepEqual(await f.service.cancelTurn({sessionId:f.id,expectedTurnStartSeq:25}),{schemaVersion:1,sessionId:f.id,expectedTurnStartSeq:25,accepted:false,observedTurnStartSeq:50,reason:'stale-or-complete'});assert.equal(f.calls.length,0);
  f.agent.status='idle';f.setTurn(null);assert.equal((await f.service.cancelTurn({sessionId:f.id,expectedTurnStartSeq:50})).accepted,false);f.agent.status='running';f.setTurn(75);assert.equal((await f.service.cancelTurn({sessionId:f.id,expectedTurnStartSeq:50})).accepted,false);assert.equal(f.calls.length,0);assert.equal((await f.service.cancelTurn({sessionId:f.id,expectedTurnStartSeq:75})).accepted,true);assert.equal(f.calls.length,1);
});
test('projection comparison and native abort share one synchronous critical section',async t=>{
  const f=await active(t);let nativeTurn=25;f.ctx.agents.turnBoundaryOf=()=>{queueMicrotask(()=>{nativeTurn=50;f.setTurn(50);});return {openTurnStartSeq:25};};f.agent.cancel=()=>f.calls.push(nativeTurn);
  assert.equal((await f.service.cancelTurn({sessionId:f.id,expectedTurnStartSeq:25})).accepted,true);assert.deepEqual(f.calls,[25]);assert.equal(nativeTurn,50);
});
test('cancelTurn validates binding, restore gate and finite fields before touching the native Agent',async t=>{
  const f=await active(t),routes=createGmRoutes(f.service);t.after(()=>routes.close());const send=(_url,init)=>routes.request(new Request('http://localhost/api/rp-gm/request',init)),api=createGmApi(send,'http://localhost/');assert.equal((await api.cancelTurn({sessionId:f.id,expectedTurnStartSeq:25})).accepted,true);f.calls.length=0;
  for(const expectedTurnStartSeq of [undefined,0,-1,1.2,'25',Number.MAX_SAFE_INTEGER+1])await assert.rejects(api.cancelTurn({sessionId:f.id,expectedTurnStartSeq}),{code:'INVALID_REQUEST',status:400});await assert.rejects(api.cancelTurn({sessionId:f.id,expectedTurnStartSeq:25,agent:'forged'}),{code:'INVALID_REQUEST',status:400});await assert.rejects(api.cancelTurn({sessionId:'foreign',expectedTurnStartSeq:25}),{code:'STORY_NOT_FOUND',status:404});
  await f.service.reserveRestore({restoreId:'turn-stop-restore',sessionIds:[f.id]});await assert.rejects(api.cancelTurn({sessionId:f.id,expectedTurnStartSeq:25}),{code:'STORY_RESTORING',status:409});assert.equal(f.calls.length,0);
});
test('cancelTurn rejects a prepared story and closed or absent projection never cancels',async t=>{
  const f=await active(t),other=await f.service.startStory(launch({launchId:'prepared-story'}));await assert.rejects(f.service.cancelTurn({sessionId:other.sessionId,expectedTurnStartSeq:25}),{code:'STORY_NOT_ACTIVE'});f.setTurn(undefined);assert.deepEqual(await f.service.cancelTurn({sessionId:f.id,expectedTurnStartSeq:25}),{schemaVersion:1,sessionId:f.id,expectedTurnStartSeq:25,accepted:false,observedTurnStartSeq:null,reason:'stale-or-complete'});assert.equal(f.calls.length,0);
});
