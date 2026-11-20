import test from 'node:test';
import assert from 'node:assert/strict';
import {createGmHost} from '../src/host.mjs';
import {normalizeTurn} from '../src/core.mjs';
import {contractFixture} from './contract-fixture.mjs';
import {nativeFixture} from './native-fixture.mjs';
import {reviewFixture,decisionInput} from './fact-review-fixture.mjs';
import {launch} from './fixtures.mjs';

async function opened(t,changes={}){
  const f=nativeFixture(await contractFixture(t)),service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());
  const {sessionId:id}=await service.startStory(launch(changes));f.installPresenter(service);
  const opening=await f.runTool(id,'rp_begin_story');await f.runTool(id,'rp_present',{factReceiptId:opening.id});
  return {...f,service,id};
}
async function context(f){
  f.ctx.currentAgent=f.sessions.get(f.id);await f.emit('system-prompt/assemble',{}, {},async()=>{});
  const text=f.contexts.find(item=>item.name==='rp-gm-state').text();
  return {text,state:JSON.parse(text.slice(text.indexOf('\n')+1))};
}
const ordinary=(state,changes={})=>({expectedRevision:state.expectedRevision,summary:'望向窗外',packet:{playerAction:'我望向窗外'},...changes});
const manyFacts={schemaVersion:1,items:Array.from({length:13},(_,index)=>({id:`fact-${index}`,text:`已经确立的事实 ${index}。`}))};
const readCalls=f=>f.sessions.get(f.id).events.filter(event=>event.type==='tool/call'&&['rp_gm_state','rp_db_catalog','rp_db_read','rp_db_search'].includes(event.data.name));

test('a short action commits from injected revision without preliminary reads or dropping unpreviewed facts',async t=>{
  const f=await opened(t,{initialFacts:manyFacts}),{state}=await context(f);
  assert.equal(state.expectedRevision,f.getRevision());assert.equal(state.expectedRevisionAvailable,true);
  assert.equal(state.factCount,13);assert.equal(state.facts.length,12);assert.equal(state.factsComplete,false);
  const receipt=await f.runTool(f.id,'rp_commit_turn',ordinary(state));
  assert.equal(receipt.kind,'turn');assert.equal(f.counts.factWrites,2);assert.equal(readCalls(f).length,0);
  assert.deepEqual((await f.service.storyState({sessionId:f.id})).facts,manyFacts);
  assert.deepEqual(f.states.get(f.id).changes.at(-1).operations,[]);
});

test('a complete preview supports a full state replacement that retains prior facts',async t=>{
  const f=await opened(t),{state}=await context(f);assert.equal(state.sceneComplete,true);assert.equal(state.factsComplete,true);
  const facts={schemaVersion:1,items:[...state.facts,{id:'door',text:'前门已经打开。'}]},scene={...state.scene,location:'客栈门口'};
  await f.runTool(f.id,'rp_commit_turn',ordinary(state,{scene,facts}));assert.equal(readCalls(f).length,0);
  const current=await f.service.storyState({sessionId:f.id});assert.deepEqual(current.facts,facts);assert.deepEqual(current.scene,scene);
});

test('incomplete scene and facts previews can be replaced after one full state read without losing old content',async t=>{
  const facts=structuredClone(manyFacts);facts.items[0].text='已确定的公开内容。'.repeat(80);
  const scene={...launch().initialScene,location:'长廊'.repeat(800)},f=await opened(t,{initialScene:scene,initialFacts:facts}),{state}=await context(f);
  assert.equal(state.sceneComplete,false);assert.equal(state.scene.schemaVersion,1);assert.equal(state.factsComplete,false);
  assert.equal(state.facts[0].text,facts.items[0].text.slice(0,500));
  const full=await f.runTool(f.id,'rp_gm_state'),next={schemaVersion:1,items:[...full.facts.items,{id:'new',text:'旅人已看见门外的灯。'}]};
  await f.runTool(f.id,'rp_commit_turn',ordinary({...state,expectedRevision:full.revision},{scene:full.scene,facts:next}));
  const current=await f.service.storyState({sessionId:f.id});assert.deepEqual(current.scene,scene);assert.deepEqual(current.facts,next);assert.equal(readCalls(f).length,1);
});

test('the injected commit revision comes from the same live snapshot and stays separate from receipt revisions',async t=>{
  const f=await opened(t),receipt=f.states.get(f.id).receipts.at(-1);receipt.factRevision=77;receipt.factRoundId='round-77';
  f.bumpRevision();f.bumpRevision();const access=f.db.factAccess;let snapshots=0;
  f.db.factAccess=async input=>{const current=await access(input);return {...current,snapshot:async()=>{snapshots++;return current.snapshot();}};};
  f.db.state=()=>{throw Error('Prompt revision must not require another Database state read');};
  const {state}=await context(f);assert.equal(snapshots,1);assert.equal(state.expectedRevision,f.getRevision());
  assert.notEqual(state.expectedRevision,receipt.databaseRevision);assert.notEqual(state.expectedRevision,receipt.factRevision);
  assert.equal(state.factRevision,77);assert.equal(state.factRoundId,'round-77');assert.equal(state.lastFactReceiptId,receipt.id);
});

test('missing or invalid snapshot revisions are marked unavailable without using factRevision as a fallback',async t=>{
  const f=await opened(t),access=f.db.factAccess;f.states.get(f.id).receipts.at(-1).factRevision=77;let revision;
  f.db.factAccess=async input=>{const current=await access(input);return {...current,snapshot:async()=>({...await current.snapshot(),revision})};};
  for(revision of [undefined,-1,1.5,'77']){
    const {state}=await context(f);assert.equal(state.expectedRevisionAvailable,false);assert.equal(Object.hasOwn(state,'expectedRevision'),false);assert.equal(state.factRevision,77);
    assert.throws(()=>normalizeTurn(ordinary(state)),error=>error.code==='INVALID_TURN'&&error.message.includes('CURRENT_GM_STORY.expectedRevision')&&error.message.includes('not FactReceipt.factRevision'));
  }
});

test('long character cards leave valid bounded JSON with exact revision and review controls',async t=>{
  const f=await opened(t,{title:'标题'.repeat(1000),character:{...launch().character,description:'长角色资料\\"\n'.repeat(5000),personality:'性格'.repeat(8000),scenario:'情境'.repeat(8000)},persona:{...launch().persona,description:'玩家设定'.repeat(8000)}});
  const pending={roundId:'round-one',pendingCandidateId:'candidate-one'};
  Object.assign(f.db,{capabilities:{factReview:1},factReviewState:async()=>({databaseRevision:f.getRevision(),rounds:[pending],decisions:[{status:'recorded'}],projection:{latestRoundId:pending.roundId}}),factDecision:async()=>null,recordFactDecision:async()=>{},finalizeFactDecision:async()=>{},stageFactCandidate:async()=>{}});
  const {text,state}=await context(f);assert.ok(text.length<10000);assert.equal(state.expectedRevision,f.getRevision());assert.equal(state.status,'active');
  assert.equal(state.review.pendingCandidateId,'candidate-one');assert.deepEqual(state.review.pendingDecision,{status:'recorded'});
  assert.equal(state.characterComplete,false);assert.equal(state.personaComplete,false);assert.equal(state.character.version,1);assert.equal(state.persona.version,1);
  assert.equal(state.sceneComplete,true);assert.equal(state.factsComplete,true);assert.equal(state.scene.schemaVersion,1);
  assert.deepEqual((await f.service.storyState({sessionId:f.id})).binding.character.description,'长角色资料\\"\n'.repeat(5000));
});

test('approval already enabled allows a direct proposal from injected revision and preserves pending decision metadata',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true}),{state}=await context(f);assert.equal(state.review.enabled,true);
  const result=await f.runTool(f.id,'rp_propose_turn',ordinary(state));assert.equal(result.status,'pending');assert.equal(readCalls(f).length,0);
  const round=f.rounds.get(result.roundId);assert.deepEqual(round.candidates[0].payload.facts,launch().initialFacts);assert.equal(f.counts.factWrites,1);
  let prompt=(await context(f)).state;assert.equal(prompt.review.pendingCandidateId,result.candidateId);
  f.faults.finalize=true;await assert.rejects(f.service.decideFacts(decisionInput(f,await f.service.reviewState({sessionId:f.id}))),{code:'LOST_RESPONSE'});
  prompt=(await context(f)).state;assert.equal(prompt.review.pendingDecision.status,'recorded');
  [...f.decisions.values()][0].status='interrupted';prompt=(await context(f)).state;assert.equal(prompt.review.pendingDecision.status,'interrupted');
});

test('a running fact generation is visible in injected review state',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true}),initial=(await context(f)).state;
  await f.runTool(f.id,'rp_propose_turn',ordinary(initial));f.sessions.get(f.id).options={provider:'fixture',model:'held',maxTokens:100};
  let enter;const entered=new Promise(resolve=>{enter=resolve;});
  f.ctx.llm={prepareCall:async config=>({config,stream:async function*(input){enter();yield await new Promise((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}));}})};
  const review=await f.service.reviewState({sessionId:f.id}),pending=f.service.regenerateFacts({sessionId:f.id,roundId:review.latestRound.roundId,operationId:'held-generation',expectedRoundVersion:review.latestRound.version,instruction:'保留既有事实'}),rejected=assert.rejects(pending,{name:'AbortError'});
  await entered;const {state}=await context(f);assert.equal(state.review.generation.status,'running');assert.equal(state.review.pendingCandidateId,review.latestRound.pendingCandidateId);assert.equal(state.expectedRevision,f.getRevision());
  const job=(await f.service.reviewState({sessionId:f.id})).generation;await f.service.cancelFactGeneration({sessionId:f.id,jobId:job.id});await rejected;assert.equal(f.counts.factWrites,1);
});

test('revision conflicts still reject and a fresh state read permits the next ordinary turn',async t=>{
  const f=await opened(t),{state}=await context(f);f.bumpRevision();
  await assert.rejects(f.runTool(f.id,'rp_commit_turn',ordinary(state)),{code:'REVISION_CONFLICT'});assert.equal(f.counts.factWrites,1);
  assert.deepEqual((await f.service.storyState({sessionId:f.id})).facts,launch().initialFacts);
  const full=await f.runTool(f.id,'rp_gm_state');await f.runTool(f.id,'rp_commit_turn',ordinary({...state,expectedRevision:full.revision}));assert.equal(f.counts.factWrites,2);
});

test('cold owner reads retain the existing scene/facts DTO without requiring a live snapshot revision',async t=>{
  const f=await opened(t),view=await f.readSession(f.id),before=await f.service.storyState({sessionId:f.id});await f.service.close();f.sessions.delete(f.id);
  f.db.effectiveV2=async()=>({entries:structuredClone(f.states.get(f.id).seed)});
  const cold=await createGmHost(f.ctx,{...f.options,readSession:async()=>view});t.after(()=>cold.close());
  const state=await cold.storyState({sessionId:f.id});assert.deepEqual(state.scene,before.scene);assert.deepEqual(state.facts,before.facts);assert.equal(Object.hasOwn(state,'revision'),false);
});
