// Isolated GM + installed Database public-host integration. The fixture logs
// rc.1 exclusive ordering (call/result before the next call); no models are used.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGmHost} from '../../src/host.mjs';
import {acceptedFactPresentations,projectSession} from '../../src/session.mjs';
import {contractFixture} from '../../tests/contract-fixture.mjs';
import {nativeFixture} from '../../tests/native-fixture.mjs';
import {nativeBatch} from '../../tests/native-batch-fixture.mjs';
import {launch} from '../../tests/fixtures.mjs';

if(!process.argv[2])throw Error('Pass the installed Database package directory');
const root=resolve(process.argv[2]),manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const {createDatabaseHost}=await import(pathToFileURL(join(root,manifest.main)).href),cleanup=[];
const f=nativeFixture(await contractFixture({after:fn=>cleanup.push(fn)}));
f.ctx.on('agent/created',({agent})=>{agent.ctx.on=f.ctx.on;});
f.ctx.typertGateway.stream=async({args})=>({async *[Symbol.asyncIterator](){
  const agent=f.sessions.get(args.request.address.sessionId);if(!agent)throw Error('Fixture session missing');
  yield {type:'snapshot',header:structuredClone(agent.session.header),records:structuredClone(agent.events),cursor:agent.events.at(-1)?.seq??0,hasMore:false};
}});
try{
  const db=await createDatabaseHost(f.ctx,{directory:join(f.directory,'actual-database')});cleanup.push(()=>db.close());f.services.set('rpDatabase',db);
  const initialize=db.initializeStoryState;db.initializeStoryState=async input=>{const value=await initialize(input);f.states.set(input.sessionId,{initialized:true});return value;};
  let submissions=0,captured;const factAccess=db.factAccess;db.factAccess=async input=>{const value=await factAccess(input);return {...value,propose:async request=>{submissions++;captured=structuredClone(request.capture);return value.propose(request);}};};
  const gm=await createGmHost(f.ctx,{...f.options,factApprovalDefault:true});cleanup.push(()=>gm.close());
  const started=await gm.startStory(launch());f.id=started.sessionId;f.installPresenter(gm);
  const opening=await f.runTool(f.id,'rp_begin_story');await f.runTool(f.id,'rp_present',{factReceiptId:opening.id});
  f.last.narratives=async({sessionId})=>({records:acceptedFactPresentations(projectSession(await f.readSession(sessionId))).map(item=>({id:item.result.data.meta.rpLastStep.record.id,factReceiptId:item.factReceiptId}))});
  f.last.capabilities={narrativeRevisions:1};f.last.presentFact=async()=>{throw Error('A pending proposal must not start writing');};
  const catalog=await f.runTool(f.id,'rp_db_catalog'),key=catalog.entries.find(entry=>entry.id==='gm.facts').key;
  // A completed prior-message read is model-visible and must survive capture.
  await f.runTool(f.id,'rp_db_read',{entryIds:[key]});
  const state=await f.runTool(f.id,'rp_gm_state'),args={expectedRevision:state.revision,summary:'仍在门口',packet:{playerAction:'查看门口'}};
  const batch=await nativeBatch(f,f.id,[{name:'rp_db_read',args:{entryIds:[key]}},{name:'rp_propose_turn',args}]);
  for(const result of batch.results)if(result.error)throw result.error;
  assert.equal(batch.results[1].value.status,'pending');assert.equal(batch.concluded,true);assert.equal(submissions,1);
  assert.ok(batch.results[0].event.seq<batch.calls[1].seq);assert.deepEqual(captured.observations.map(item=>item.toolName),['rp_db_catalog','rp_db_read']);
  assert.ok(captured.observations.every(item=>item.resultSeq<batch.assistant.seq));
  const review=await db.factReviewState({sessionId:f.id}),pending=review.rounds.at(-1);
  assert.equal(pending.source.callId,batch.calls[1].data.callId);assert.equal(pending.pendingCandidateId,batch.results[1].value.candidateId);
  const access=await db.factAccess({sessionId:f.id,agent:f.sessions.get(f.id)});assert.equal((await access.latestReceipt()).id,opening.id);
  const exported=await db.exportState({sessionIds:[f.id]}),gmExported=await gm.exportState({sessionIds:[f.id]});
  assert.equal(exported.schemaVersion,1);assert.equal(gmExported.schemaVersion,1);assert.equal(submissions,1);
  process.stdout.write(JSON.stringify({databaseVersion:manifest.version,source:'installed Database public createDatabaseHost',batch:'read then proposal',exclusiveCallResultOrdering:true,proposals:submissions,pending:true,capturedPriorMessageObservations:captured.observations.length,capturedSameBatchObservations:0,latestReceiptRemainsOpening:true,databaseExport:'PASS',gmExport:'PASS',externalRequests:0})+'\n');
}finally{for(const dispose of cleanup.reverse())await dispose();}
