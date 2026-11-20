import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {createGmHost} from '../src/host.mjs';import {createGmRoutes} from '../src/routes.mjs';import {createBindingStore} from '../src/store.mjs';import {OPERATION_ACCEPTED} from '../src/operations.mjs';
import {createGmApi} from '../src/api.js';
import {reviewFixture,propose,decisionInput} from './fact-review-fixture.mjs';import {contractFixture} from './contract-fixture.mjs';import {launch} from './fixtures.mjs';

const generated={scene:{schemaVersion:1,title:'门口',location:'客栈门口',presentActorIds:['traveler']},facts:{schemaVersion:1,items:[{id:'holder',text:'信件由林遥持有。'}]},summary:'交信后的判断',packet:{playerAction:'把信交给林遥'}};
function gate(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function settled(service,scope){
  const identity={...scope.launchId?{launchId:scope.launchId}:{sessionId:scope.sessionId},operationId:scope.operationId};
  for(let attempt=0;attempt<200;attempt++){const value=await service.operation(identity);if(!['accepted','running','cancelling'].includes(value.operation.status))return value;await delay(5);}
  assert.fail('The operation did not settle');
}
async function generationFixture(t){
  const requests=[],holds=[];const f=await reviewFixture(t,{factApprovalDefault:true},f=>{
    f.services.set('loopStudio',{registerParticipant:()=>()=>{},resolveRoute:()=>({provider:'contract-local',model:'facts'}),recordTrace:()=>{}});
    f.ctx.llm={prepareCall:async config=>({config,stream:async function*(input){requests.push(input);const hold=holds.shift();if(hold){hold.entered.resolve();await Promise.race([hold.release.promise,new Promise((_resolve,reject)=>{input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});})]);}yield {type:'block-end',index:0,block:{type:'text',text:JSON.stringify(generated)}};yield {type:'finish',reason:{kind:'stop'}};}})};
  });await propose(f);
  const input=async(operationId='generation-one')=>{const state=await f.service.reviewState({sessionId:f.id});return {sessionId:f.id,operationId,kind:'regenerateFacts',input:{roundId:state.latestRound.roundId,expectedRoundVersion:state.latestRound.version,instruction:'保留已执行结果'}};};
  const hold=()=>{const value={entered:gate(),release:gate()};holds.push(value);return value;};return {...f,requests,input,hold};
}
const request=(input,signal)=>new Request('http://localhost/api/rp-gm/request',{method:'POST',body:JSON.stringify(input),signal});

test('HTTP acceptance is durable, survives request/SSE disconnect, and simultaneous duplicates run one model',async t=>{
  const f=await generationFixture(t),routes=createGmRoutes(f.service);t.after(()=>routes.close());const input=await f.input(),hold=f.hold(),life=new AbortController();
  const response=await routes.request(request({action:'submitOperation',...input},life.signal));assert.equal(response.status,202);const receipt=await response.json();assert.equal(receipt.operation.status,'accepted');assert.equal(typeof receipt.operation.createdAt,'string');assert.equal(receipt.operation.updatedAt,receipt.operation.createdAt);assert.equal(Object.hasOwn(receipt,'accepted'),false);
  const persisted=JSON.parse(await readFile(join(f.directory,'state.json'),'utf8'));assert.equal(persisted.operations[0].operationId,input.operationId);assert.equal(persisted.operations[0].fingerprint.length,64);
  await hold.entered.promise;const events=await routes.events(new Request(`http://localhost/api/rp-gm/events?sessionId=${f.id}`,{signal:life.signal}));await events.body.getReader().read();life.abort();
  const duplicates=await Promise.all(Array.from({length:8},()=>routes.request(request({action:'submitOperation',...input}))));assert.ok(duplicates.every(value=>value.status===200));assert.equal(f.requests.length,1);assert.equal(f.requests[0].signal.aborted,false);
  const wrong=await routes.request(request({action:'submitOperation',...input,input:{...input.input,instruction:'changed'}}));assert.equal(wrong.status,409);assert.equal((await wrong.json()).error.code,'OPERATION_ID_CONFLICT');
  const query=await routes.request(request({action:'operation',sessionId:f.id,operationId:input.operationId}));assert.equal(query.status,200);assert.equal((await query.json()).operation.status,'running');
  hold.release.resolve();const done=await settled(f.service,input);assert.equal(done.operation.status,'complete');assert.equal(done.operation.result.job.status,'complete');assert.ok(done.operation.revision>1);assert.equal(f.commandInputs.length,1);assert.equal(f.stages.length,2);assert.equal(f.counts.factWrites,1);
  const list=await (await routes.request(request({action:'operations',sessionId:f.id}))).json();assert.equal(list.operations.length,1);assert.equal(list.operations[0].status,'complete');
});

test('concurrent first submissions share one accepted receipt and do not double dispatch',async t=>{
  const f=await generationFixture(t),input=await f.input(),hold=f.hold();const values=await Promise.all(Array.from({length:12},()=>f.service.submitOperation(input)));
  assert.equal(values.filter(value=>value[OPERATION_ACCEPTED]).length,1);await hold.entered.promise;assert.equal(f.requests.length,1);assert.equal((await f.service.operations({sessionId:f.id})).operations.length,1);hold.release.resolve();assert.equal((await settled(f.service,input)).operation.status,'complete');assert.equal(f.commandInputs.length,1);
});

test('explicit cancellation targets one generation, keeps facts, and cannot abort the next operation',async t=>{
  const f=await generationFixture(t),input=await f.input(),hold=f.hold();await f.service.submitOperation(input);await hold.entered.promise;
  const cancelling=await f.service.cancelOperation({sessionId:f.id,operationId:input.operationId});assert.ok(['cancelling','cancelled'].includes(cancelling.operation.status));const done=await settled(f.service,input);assert.equal(done.operation.status,'cancelled');assert.equal((await f.service.reviewState({sessionId:f.id})).generation.status,'cancelled');assert.equal(f.stages.length,0);assert.equal(f.counts.factWrites,1);
  const next=await f.input('generation-two'),nextHold=f.hold();await f.service.submitOperation(next);await nextHold.entered.promise;
  assert.equal((await f.service.cancelOperation({sessionId:f.id,operationId:input.operationId})).operation.status,'cancelled');await assert.rejects(f.service.cancelOperation({sessionId:f.id,operationId:'unknown'}),{code:'OPERATION_NOT_FOUND'});assert.equal(f.requests[1].signal.aborted,false);
  nextHold.release.resolve();assert.equal((await settled(f.service,next)).operation.status,'complete');assert.equal(f.requests.length,2);assert.equal(f.counts.factWrites,1);
});

test('cancellation after durable candidate confirmation reports complete even when its response was delayed',async t=>{
  const f=await generationFixture(t),stage=f.db.stageFactCandidate,entered=gate(),release=gate(),input=await f.input();
  f.db.stageFactCandidate=async value=>{const result=await stage(value);if(value.completion){entered.resolve();await release.promise;}return result;};
  await f.service.submitOperation(input);await entered.promise;const cancelled=await f.service.cancelOperation({sessionId:f.id,operationId:input.operationId});assert.equal(cancelled.operation.status,'cancelling');release.resolve();
  const done=await settled(f.service,input);assert.equal(done.operation.status,'complete');assert.equal(done.operation.result.job.status,'complete');assert.equal(f.requests.length,1);assert.equal(f.stages.length,2);assert.equal(f.counts.factWrites,1);
});

test('cancel remains pending until an in-flight confirmation settles and reports its actual durable result',async t=>{
  const f=await generationFixture(t),stage=f.db.stageFactCandidate,entered=gate(),release=gate(),input=await f.input();
  f.db.stageFactCandidate=async value=>{if(value.completion){entered.resolve();await release.promise;}return stage(value);};
  await f.service.submitOperation(input);await entered.promise;assert.equal((await f.service.cancelOperation({sessionId:f.id,operationId:input.operationId})).operation.status,'cancelling');
  release.resolve();const done=await settled(f.service,input);assert.equal(done.operation.status,'complete');assert.equal(done.operation.result.job.status,'complete');assert.equal(f.counts.factWrites,1);assert.equal(f.stages.length,2);
});

test('unload records interrupted before abort and a duplicate after restart never reruns a model',async t=>{
  const f=await generationFixture(t),input=await f.input(),hold=f.hold();await f.service.submitOperation(input);await hold.entered.promise;await f.service.close();
  const state=JSON.parse(await readFile(join(f.directory,'state.json'),'utf8'));assert.equal(state.operations[0].status,'interrupted');assert.equal(state.operations[0].error.code,'HOST_INTERRUPTED');
  const cold=await createGmHost(f.ctx,f.options);t.after(()=>cold.close());const prior=await cold.submitOperation(input);assert.equal(prior.operation.status,'interrupted');assert.equal(prior[OPERATION_ACCEPTED],undefined);assert.equal(f.requests.length,1);assert.equal(f.counts.factWrites,1);
  await assert.rejects(cold.operation({sessionId:f.id,operationId:input.operationId,source:{commandId:'forged'}}),{code:'INVALID_REVIEW_REQUEST'});
});

test('cold reconciliation confirms canonical decisions without issuing a command or a writer again',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true});await propose(f);const {sessionId,operationId,...input}=decisionInput(f,await f.service.reviewState({sessionId:f.id})),submission={sessionId,operationId,kind:'decideFacts',input};await f.service.submitOperation(submission);const done=await settled(f.service,submission);assert.equal(done.operation.result.status,'approved');await f.service.close();
  const path=join(f.directory,'state.json'),state=JSON.parse(await readFile(path,'utf8'));state.operations[0].status='running';delete state.operations[0].result;await writeFile(path,JSON.stringify(state));
  const cold=await createGmHost(f.ctx,f.options);t.after(()=>cold.close());const found=await cold.operation({sessionId,operationId});assert.equal(found.operation.status,'complete');assert.equal(found.operation.result.factReceiptId,done.operation.result.factReceiptId);assert.equal(f.commandInputs.length,1);assert.equal(f.presentations.length,1);assert.equal(f.counts.factWrites,2);
  const persisted=JSON.parse(await readFile(path,'utf8'));persisted.operations[0].status='running';delete persisted.operations[0].result;const agent=f.sessions.get(f.id);agent.events.splice(agent.events.findIndex(event=>event.type==='command/done'),1);await cold.close();await writeFile(path,JSON.stringify(persisted));const unconfirmed=await createGmHost(f.ctx,f.options);t.after(()=>unconfirmed.close());assert.equal((await unconfirmed.operation({sessionId,operationId})).operation.status,'interrupted');assert.equal(f.counts.factWrites,2);
});

test('cold reconciliation confirms generation from candidate and exact done rather than replaying generation',async t=>{
  const f=await generationFixture(t),input=await f.input();await f.service.submitOperation(input);const done=await settled(f.service,input);await f.service.close();const path=join(f.directory,'state.json'),state=JSON.parse(await readFile(path,'utf8'));state.operations[0].status='running';delete state.operations[0].result;await writeFile(path,JSON.stringify(state));const cold=await createGmHost(f.ctx,f.options);t.after(()=>cold.close());assert.deepEqual((await cold.operation({sessionId:f.id,operationId:input.operationId})).operation.result,done.operation.result);assert.equal(f.requests.length,1);assert.equal(f.commandInputs.length,1);assert.equal(f.stages.length,2);
});

test('legacy cached complete without its original durable native done becomes interrupted without replay',async t=>{
  const f=await generationFixture(t),input=await f.input();await f.service.submitOperation(input);const complete=await settled(f.service,input);await f.service.close();const agent=f.sessions.get(f.id),doneIndex=agent.events.findIndex(event=>event.type==='command/done'),[done]=agent.events.splice(doneIndex,1);
  const cold=await createGmHost(f.ctx,f.options);t.after(()=>cold.close());const migrated=await cold.operation({sessionId:f.id,operationId:input.operationId});assert.equal(migrated.operation.status,'interrupted');assert.equal(migrated.operation.error.code,'NATIVE_COMPLETION_UNCONFIRMED');assert.deepEqual(migrated.operation.result,complete.operation.result);assert.equal(f.requests.length,1);assert.equal(f.commandInputs.length,1);assert.equal(f.counts.factWrites,1);await cold.close();
  agent.events.splice(doneIndex,0,done);const repaired=await createGmHost(f.ctx,f.options);t.after(()=>repaired.close());assert.equal((await repaired.operation({sessionId:f.id,operationId:input.operationId})).operation.status,'complete');assert.equal(f.requests.length,1);assert.equal(f.commandInputs.length,1);
});

test('valid historical completion keeps its original result after another round and branch on cold start',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true});await propose(f);const {sessionId,operationId,...input}=decisionInput(f,await f.service.reviewState({sessionId:f.id})),submission={sessionId,operationId,kind:'decideFacts',input};await f.service.submitOperation(submission);const complete=await settled(f.service,submission);assert.equal(complete.operation.status,'complete');
  await propose(f,{summary:'下一回合',packet:{playerAction:'在门口等候'}});const next=decisionInput(f,await f.service.reviewState({sessionId:f.id}),{operationId:'next-round',action:'cancel'});await f.service.decideFacts(next);await f.service.forkStory({sessionId:f.id});await f.service.close();
  const cold=await createGmHost(f.ctx,f.options);t.after(()=>cold.close());const historical=await cold.operation({sessionId:f.id,operationId});assert.equal(historical.operation.status,'complete');assert.deepEqual(historical.operation.result,complete.operation.result);assert.equal(f.counts.factWrites,2);assert.equal(f.commandInputs.length,2);
});

test('explicit resume uses a new receipt and a same-session domain target without duplicating facts',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true});await propose(f);const decision=decisionInput(f,await f.service.reviewState({sessionId:f.id}));f.faults.runOnly=true;await assert.rejects(f.service.decideFacts(decision),{code:'LOST_RESPONSE'});
  const input={sessionId:f.id,operationId:'resume-owner-one',kind:'resumeFactDecision',input:{targetOperationId:decision.operationId}};await f.service.submitOperation(input);const done=await settled(f.service,input);assert.equal(done.operation.status,'complete');assert.equal(done.operation.result.operationId,decision.operationId);assert.equal(f.counts.factWrites,2);assert.equal(f.presentations.length,0);
  await assert.rejects(f.service.submitOperation({...input,input:{targetOperationId:'another-target'}}),{code:'OPERATION_ID_CONFLICT'});
  const bad={sessionId:f.id,operationId:'unknown-target',kind:'resumeFactDecision',input:{targetOperationId:'foreign'}};await f.service.submitOperation(bad);const failed=await settled(f.service,bad);assert.equal(failed.operation.status,'failed');assert.equal(failed.operation.error.code,'OPERATION_NOT_FOUND');assert.equal(f.counts.factWrites,2);
});

test('stored presentation recovery is its own operation and never repeats fact settlement',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true});await propose(f);const decision=decisionInput(f,await f.service.reviewState({sessionId:f.id}));f.faults.presentation=true;await f.service.decideFacts(decision);f.faults.presentation=false;
  const input={sessionId:f.id,operationId:'resume-prose',kind:'resumeFactPresentation',input:{roundId:decision.roundId,targetOperationId:decision.operationId}};await f.service.submitOperation(input);const done=await settled(f.service,input);assert.equal(done.operation.result.presentation.status,'complete');assert.equal(f.commandInputs.length,1);assert.equal(f.counts.factWrites,2);
  const wrong={...input,operationId:'wrong-round',input:{...input.input,roundId:'other-round'}};await f.service.submitOperation(wrong);assert.equal((await settled(f.service,wrong)).operation.error.code,'OPERATION_ID_CONFLICT');
});

test('legacy explicit generation cancellation still cancels its durable PC operation',async t=>{
  const f=await generationFixture(t),input=await f.input(),hold=f.hold();await f.service.submitOperation(input);await hold.entered.promise;const state=await f.service.reviewState({sessionId:f.id});await f.service.cancelFactGeneration({sessionId:f.id,jobId:state.generation.id});assert.equal((await settled(f.service,input)).operation.status,'cancelled');assert.equal(f.counts.factWrites,1);
});

test('invalid fields, stale versions and missing receipts do not produce successful work',async t=>{
  const f=await generationFixture(t),input=await f.input(),routes=createGmRoutes(f.service);t.after(()=>routes.close());
  for(const patch of [{signal:'forged'},{operationId:'override'},{sessionId:'foreign'},{source:{commandId:'forged'}}]){const response=await routes.request(request({action:'submitOperation',...input,input:{...input.input,...patch}}));assert.equal(response.status,400);}
  const before=new AbortController();before.abort();assert.equal((await routes.request(request({action:'submitOperation',...input},before.signal))).status,499);assert.equal((await f.service.operations({sessionId:f.id})).operations.length,0);
  const notFound=await routes.request(request({action:'operation',sessionId:f.id,operationId:input.operationId}));assert.equal(notFound.status,404);assert.equal((await notFound.json()).error.code,'OPERATION_NOT_FOUND');
  await f.service.submitOperation({...input,input:{...input.input,expectedRoundVersion:999}});assert.equal((await settled(f.service,input)).operation.status,'failed');assert.equal(f.requests.length,0);assert.equal(f.counts.factWrites,1);
});

test('startStory is launch scoped, detached, and recoverable after a lost prompt acknowledgement',async t=>{
  const f=await contractFixture(t),service=await createGmHost(f.ctx,f.options),routes=createGmRoutes(service);t.after(()=>service.close());t.after(()=>routes.close());const entered=gate(),release=gate(),initialize=f.db.initializeStoryState;f.db.initializeStoryState=async input=>{entered.resolve();await release.promise;return initialize(input);};
  const input={operationId:'launch-receipt',kind:'startStory',input:launch()},life=new AbortController();const response=await routes.request(request({action:'submitOperation',...input},life.signal));assert.equal(response.status,202);const receipt=await response.json();assert.equal(receipt.operation.launchId,'launch-one');await entered.promise;life.abort();assert.equal((await service.operation({launchId:'launch-one',operationId:input.operationId})).operation.status,'running');assert.equal((await service.operation({sessionId:receipt.operation.sessionId,operationId:input.operationId})).operation.status,'running');
  assert.equal((await routes.request(request({action:'submitOperation',...input}))).status,200);await assert.rejects(service.submitOperation({...input,input:launch({title:'changed'})}),{code:'OPERATION_ID_CONFLICT'});await assert.rejects(service.operation({launchId:'launch-one',sessionId:'foreign',operationId:input.operationId}),{code:'AGENT_MISMATCH'});
  f.faults.promptLost=true;release.resolve();const done=await settled(service,{launchId:'launch-one',operationId:input.operationId});assert.equal(done.operation.status,'complete');assert.equal(f.counts.creates,1);assert.equal(f.counts.initializes,1);assert.equal(f.counts.prompts,1);assert.equal((await service.submitOperation(input)).operation.result.sessionId,receipt.operation.sessionId);
});

test('a receipt cannot be acknowledged when durable acceptance fails',async t=>{
  const f=await contractFixture(t),store=createBindingStore({directory:f.directory});store.acceptOperation=async()=>{throw Object.assign(Error('No space for receipt'),{code:'ENOSPC'});};const service=await createGmHost(f.ctx,{...f.options,store});t.after(()=>service.close());await assert.rejects(service.submitOperation({operationId:'not-persisted',kind:'startStory',input:launch()}),{code:'ENOSPC'});assert.equal(f.counts.creates,0);assert.equal(f.counts.prompts,0);await assert.rejects(service.operation({launchId:'launch-one',operationId:'not-persisted'}),{code:'OPERATION_NOT_FOUND'});
});

test('concurrent launch submissions attach the reserved identity to the winning durable request',async t=>{
  const f=await contractFixture(t),service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());
  const submission={operationId:'launch-race',kind:'startStory',input:launch()};
  const outcomes=await Promise.allSettled([
    service.submitOperation(submission),
    service.submitOperation({...submission,input:launch({title:'another payload'})}),
  ]);
  const [accepted]=outcomes.filter(item=>item.status==='fulfilled');
  const [conflict]=outcomes.filter(item=>item.status==='rejected');
  assert.equal(accepted.value[OPERATION_ACCEPTED],true);
  assert.equal(conflict.reason.code,'OPERATION_ID_CONFLICT');
  const done=await settled(service,accepted.value.operation);
  assert.equal(done.operation.result.sessionId,accepted.value.operation.sessionId);
  assert.equal(f.counts.creates,1);
});

test('GM API unmount only ends polling while its accepted fact generation continues on PC',async t=>{
  const f=await generationFixture(t),routes=createGmRoutes(f.service);t.after(()=>routes.close());const api=createGmApi((_url,init)=>routes.request(new Request('http://localhost/api/rp-gm/request',init)),'http://localhost/'),input=await f.input(),hold=f.hold(),life=new AbortController();
  const waiting=api.regenerateFacts({sessionId:f.id,operationId:input.operationId,...input.input},life.signal),aborted=assert.rejects(waiting,{name:'AbortError'});await hold.entered.promise;life.abort();await aborted;assert.equal(f.requests[0].signal.aborted,false);hold.release.resolve();assert.equal((await settled(f.service,input)).operation.status,'complete');assert.equal(f.requests.length,1);
});

test('legacy sample HTTP wait can disconnect and explicitly retry startup without another owner',async t=>{
  const f=await contractFixture(t),service=await createGmHost(f.ctx,f.options),routes=createGmRoutes(service);t.after(()=>service.close());t.after(()=>routes.close());const entered=gate(),release=gate(),initialize=f.db.initializeStoryState;f.db.initializeStoryState=async input=>{entered.resolve();await release.promise;return initialize(input);};
  const life=new AbortController(),pending=routes.request(request({action:'startSample',launchId:'sample-launch',openingId:'rain'},life.signal));await entered.promise;life.abort();assert.equal((await pending).status,499);assert.equal(f.counts.prompts,0);release.resolve();
  const retried=await routes.request(request({action:'startSample',launchId:'sample-launch',openingId:'rain'}));assert.equal(retried.status,200);assert.equal((await retried.json()).status,'starting');assert.equal(f.counts.creates,1);assert.equal(f.counts.prompts,1);
  const other=f.last.profile;let unavailable=true;f.last.profile=async(...args)=>{if(unavailable)throw Object.assign(Error('Unavailable profile'),{code:'PROFILE_NOT_READY'});return other(...args);};
  assert.equal((await routes.request(request({action:'startSample',launchId:'retry-launch',openingId:'rain'}))).status,503);unavailable=false;assert.equal((await routes.request(request({action:'startSample',launchId:'retry-launch',openingId:'rain'}))).status,200);assert.equal(f.counts.creates,2);assert.equal(f.counts.prompts,2);
});

test('generation settlement submitted with a separate target reuses its staged candidate without a model',async t=>{
  const f=await generationFixture(t),input=await f.input();f.faults.runOnly=true;await f.service.submitOperation(input);assert.equal((await settled(f.service,input)).operation.status,'failed');assert.equal(f.requests.length,1);
  const resume={sessionId:f.id,operationId:'settle-generation',kind:'resumeFactGeneration',input:{targetOperationId:input.operationId}};await f.service.submitOperation(resume);const done=await settled(f.service,resume);assert.equal(done.operation.status,'complete');assert.equal(done.operation.result.job.operationId,input.operationId);assert.equal(f.requests.length,1);assert.equal(f.commandInputs.length,2);assert.equal(f.counts.factWrites,1);
});

test('an approved decision keeps its writer across disconnect; duplicate acceptance never writes facts twice',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true});await propose(f);const {sessionId,operationId,...input}=decisionInput(f,await f.service.reviewState({sessionId:f.id})),submission={sessionId,operationId,kind:'decideFacts',input},entered=gate(),release=gate(),present=f.last.presentFact,writerSignals=[];
  f.last.presentFact=async input=>{writerSignals.push(input.signal);entered.resolve();await release.promise;return present(input);};const routes=createGmRoutes(f.service);t.after(()=>routes.close());const life=new AbortController();assert.equal((await routes.request(request({action:'submitOperation',...submission},life.signal))).status,202);await entered.promise;life.abort();
  assert.equal((await routes.request(request({action:'submitOperation',...submission}))).status,200);assert.equal(writerSignals[0].aborted,false);assert.equal(f.counts.factWrites,2);assert.equal(f.commandInputs.length,1);release.resolve();const done=await settled(f.service,submission);assert.equal(done.operation.result.presentation.status,'complete');assert.equal(f.counts.factWrites,2);assert.equal(writerSignals.length,1);
});

test('cancelling approval during writing preserves the committed receipt for an explicit presentation resume',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true});await propose(f);const {sessionId,operationId,...input}=decisionInput(f,await f.service.reviewState({sessionId:f.id})),submission={sessionId,operationId,kind:'decideFacts',input},entered=gate(),present=f.last.presentFact,signals=[];
  f.last.presentFact=input=>{signals.push(input.signal);entered.resolve();return new Promise((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}));};
  await f.service.submitOperation(submission);await entered.promise;assert.equal(f.counts.factWrites,2);await f.service.cancelOperation({sessionId,operationId});const cancelled=await settled(f.service,submission);assert.equal(cancelled.operation.status,'cancelled');assert.equal(cancelled.operation.result.status,'approved');assert.equal(cancelled.operation.result.presentation.status,'interrupted');assert.equal(signals[0].aborted,true);const receipt=cancelled.operation.result.factReceiptId;
  f.last.presentFact=present;const resume={sessionId,operationId:'resume-cancelled-writer',kind:'resumeFactPresentation',input:{roundId:input.roundId,targetOperationId:operationId}};await f.service.submitOperation(resume);const done=await settled(f.service,resume);assert.equal(done.operation.result.factReceiptId,receipt);assert.equal(done.operation.result.presentation.status,'complete');assert.equal(f.counts.factWrites,2);assert.equal(f.commandInputs.length,1);
  const second=await f.service.startStory(launch({launchId:'another-story'})),foreign={sessionId:second.sessionId,operationId:'foreign-resume',kind:'resumeFactDecision',input:{targetOperationId:operationId}};await f.service.submitOperation(foreign);const refused=await settled(f.service,foreign);assert.equal(refused.operation.status,'failed');assert.equal(refused.operation.error.code,'OPERATION_NOT_FOUND');assert.equal(f.counts.factWrites,2);
});
