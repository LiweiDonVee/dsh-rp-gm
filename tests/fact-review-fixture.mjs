import {randomUUID} from 'node:crypto';
import {contractFixture} from './contract-fixture.mjs';
import {nativeFixture} from './native-fixture.mjs';
import {createGmHost} from '../src/host.mjs';
import {clone,GmError,readState,requestFingerprint} from '../src/core.mjs';
import {launch} from './fixtures.mjs';
import {acceptedFactPresentations,projectSession} from '../src/session.mjs';

// Explicit frozen Database / LastStep / public-host contract fixtures. This is not native acceptance.
export async function reviewFixture(t,options={},setup){
  const f=nativeFixture(await contractFixture(t)),commands=new Map(),rounds=new Map(),decisions=new Map(),commandInputs=[],generationInputs=[],stages=[],presentations=[],acceptedProse=[];
  f.ctx.commands={register:definition=>{commands.set(definition.name,definition);return()=>commands.delete(definition.name);}};
  f.ctx.sessionQuery={observeSession:async id=>({events:clone(f.sessions.get(id).events),[Symbol.dispose](){}})};
  const invoke=f.ctx.typertGateway.invoke;
  f.ctx.typertGateway.invoke=async input=>{
    if(input.namespace!=='commands')return invoke(input);
    const {agentId,line}=input.args;if(!line.startsWith('/'))throw new GmError('INVALID_COMMAND','Native commands require a slash');const agent=f.sessions.get(agentId),[name,...tokens]=line.slice(1).trim().split(/\s+/u),commandId=randomUUID(),definition=commands.get(name);
    if(!definition)throw new GmError('COMMAND_NOT_FOUND','Unknown command');
    const args=' '+tokens.join(' '),run=f.append(agent,'command/run',{commandId,name,args,source:{kind:'user'}});commandInputs.push({input:clone({...input,signal:undefined}),run});
    let result;try{result=await definition.handler(Object.freeze({agent,commandId,rawInput:args,attachments:[],signal:input.signal??new AbortController().signal}));}catch(error){f.append(agent,'command/done',{commandId,kind:'error',text:error.message});throw error;}
    if(f.faults.beforeDone){await f.faults.beforeDone({name,run,result});}
    if(f.faults.runOnly){f.faults.runOnly=false;throw new GmError('LOST_RESPONSE','Command stopped before done',503);}
    f.append(agent,'command/done',{commandId,...result});
    if(f.faults.commandLost){f.faults.commandLost=false;throw new GmError('LOST_RESPONSE','Command response lost',503);}
    return result;
  };
  const access=f.db.factAccess;
  f.db.capabilities={factReview:1};
  f.db.factAccess=async input=>{
    const a=await access(input);
    return {...a,latestReceipt:async()=>clone(f.states.get(input.sessionId).receipts.at(-1)??null),
      commit:async request=>{if([...rounds.values()].some(r=>r.sessionId===input.sessionId&&r.pendingCandidateId))throw new GmError('FACT_REVIEW_PENDING','Pending review');const base=readState(await a.snapshot()),receipt=await a.commit(request);if(request.capture){const round=makeRound(input.sessionId,request,base,receipt);rounds.set(round.roundId,round);Object.assign(f.states.get(input.sessionId).receipts.at(-1),{factRoundId:round.roundId,factRevision:1,candidateId:round.candidates[0].id});return clone(f.states.get(input.sessionId).receipts.at(-1));}return receipt;},
      propose:async request=>{if([...rounds.values()].some(r=>r.sessionId===input.sessionId&&r.pendingCandidateId))throw new GmError('FACT_REVIEW_PENDING','Pending review');const round=makeRound(input.sessionId,request,readState(await a.snapshot()));rounds.set(round.roundId,round);f.bumpRevision();return {round:clone(round),candidateId:round.pendingCandidateId};},
    };
  };
  function makeRound(sessionId,request,base,receipt){
    const payload=clone({scene:base.scene,facts:base.facts,summary:request.summary,packet:request.packet});for(const op of request.operations??[]){if(op.ref?.entryId==='gm.scene')payload.scene=JSON.parse(op.patch.content);if(op.ref?.entryId==='gm.facts')payload.facts=JSON.parse(op.patch.content);}
    const roundId=randomUUID(),candidate={id:randomUUID(),roundId,createdAt:new Date().toISOString(),origin:'main-gm',payload,payloadHash:requestFingerprint(payload)};
    return {roundId,version:1,sessionId,turnKey:request.turnKey,source:clone(request.source),base:clone(base),capture:clone(request.capture),candidates:[candidate],pendingCandidateId:receipt?null:candidate.id,activeReceiptId:receipt?.id??null,approvalRequired:!receipt,latest:true,canRegenerate:true};
  }
  function all(sessionId){return [...rounds.values()].filter(r=>r.sessionId===sessionId);}
  function state(sessionId){const values=all(sessionId);return {databaseRevision:f.getRevision(),rounds:clone(values),decisions:clone([...decisions.values()].filter(d=>d.source.sessionId===sessionId)),projection:{schemaVersion:1,latestRoundId:values.at(-1)?.roundId??null,groups:values.map(r=>({roundId:r.roundId,source:clone(r.source),activeReceiptId:r.activeReceiptId,factRevision:r.activeReceiptId?1:null,pendingCandidateId:r.pendingCandidateId}))}};}
  f.db.factReviewState=async({sessionId})=>state(sessionId);f.db.factReviewProjection=async({sessionId})=>state(sessionId).projection;
  f.db.factDecision=async({operationId})=>clone(decisions.get(operationId)??null);
  f.db.stageFactCandidate=async input=>{
    stages.push(clone({...input,signal:undefined}));const round=rounds.get(input.roundId),existing=round.candidates.find(c=>c.operationId===input.operationId);
    if(input.completion){const done=f.sessions.get(input.sessionId).events.find(e=>e.seq===input.completion.doneSeq);if(done?.type!=='command/done'||done.data.kind!=='success')throw new GmError('DECISION_NOT_CONFIRMED','Missing done');const text=JSON.parse(done.data.text);if(text.candidateId!==existing?.id||text.payloadHash!==existing.payloadHash)throw new GmError('DECISION_SOURCE_INVALID','Wrong result');existing.generationConfirmed=true;round.pendingCandidateId=existing.id;round.approvalRequired=input.approvalRequired;round.version++;return {round:clone(round),candidateId:existing.id};}
    if(existing)return {round:clone(round),candidateId:existing.id};
    if(round.version!==input.expectedRoundVersion)throw new GmError('REVISION_CONFLICT','Stale round');
    const candidate={id:randomUUID(),roundId:round.roundId,createdAt:new Date().toISOString(),origin:'regenerated',payload:clone(input.payload),payloadHash:requestFingerprint(input.payload),operationId:input.operationId,generationConfirmed:false,model:clone(input.model)};round.candidates.push(candidate);round.version++;f.bumpRevision();return {round:clone(round),candidateId:candidate.id};
  };
  f.db.recordFactDecision=async input=>{
    const round=rounds.get(input.roundId),old=decisions.get(input.operationId);
    if(old){if(old.requestHash!==input.source.requestHash)throw new GmError('OPERATION_ID_CONFLICT','Changed request');if(old.status==='applied')return {operationId:old.operationId,status:'applied',factReceiptId:old.factReceiptId};old.source=clone(input.source);return {operationId:old.operationId,status:'recorded'};}
    if(round.version!==input.expectedRoundVersion||f.getRevision()!==input.expectedDatabaseRevision)throw new GmError('REVISION_CONFLICT','Stale review');
    const decision={operationId:input.operationId,roundId:input.roundId,candidateId:input.candidateId,action:input.action,requestHash:input.source.requestHash,status:'recorded',source:clone(input.source)};
    if(input.action==='custom'){const candidate={id:randomUUID(),roundId:round.roundId,createdAt:new Date().toISOString(),origin:'owner',payload:clone(input.custom),payloadHash:requestFingerprint(input.custom)};round.candidates.push(candidate);decision.selectedCandidateId=candidate.id;}
    decisions.set(input.operationId,decision);f.bumpRevision();return {operationId:input.operationId,status:'recorded'};
  };
  f.db.finalizeFactDecision=async input=>{
    const d=decisions.get(input.operationId),round=rounds.get(d.roundId),agent=f.sessions.get(input.sessionId),done=agent.events.find(e=>e.seq===input.source.doneSeq);
    if(d.status!=='applied'&&(d.source.commandId!==input.source.commandId||done?.data.kind!=='success'||done.data.commandId!==input.source.commandId))throw new GmError('DECISION_NOT_CONFIRMED','Unconfirmed');
    if(f.faults.finalize){f.faults.finalize=false;throw new GmError('LOST_RESPONSE','Finalize unavailable',503);}
    if(d.status==='applied')return {operationId:d.operationId,status:d.action==='cancel'?'cancelled':'approved',round:clone(round),...d.factReceiptId?{receipt:clone(f.states.get(input.sessionId).receipts.find(r=>r.id===d.factReceiptId))}:{}};
    if(d.action==='cancel'){round.pendingCandidateId=null;round.version++;d.status='applied';d.completion=clone(input.source);return {operationId:d.operationId,status:'cancelled',round:clone(round)};}
    const candidate=round.candidates.find(c=>c.id===(d.selectedCandidateId??d.candidateId)),id=randomUUID(),s=f.states.get(input.sessionId),receipt={schemaVersion:1,id,sessionId:input.sessionId,turnKey:round.turnKey,source:clone(round.source),kind:'turn',factRoundId:round.roundId,factRevision:s.receipts.filter(r=>r.factRoundId===round.roundId).length+1,candidateId:candidate.id,decisionSource:clone(input.source),databaseRevision:f.bumpRevision(),stateRefs:s.binding.factEntryRefs.map(r=>({...r,version:2})),summary:candidate.payload.summary,packet:clone(candidate.payload.packet),createdAt:new Date().toISOString()};
    f.counts.factWrites++;s.receipts.push(receipt);s.changes.push({receiptId:id,operations:[['scene','gm.scene'],['facts','gm.facts']].map(([key,entryId])=>({op:'update',ref:{sourceKey:'@session',entryId},patch:{content:JSON.stringify(candidate.payload[key])}}))});round.activeReceiptId=id;round.pendingCandidateId=null;round.version++;d.status='applied';d.factReceiptId=id;d.completion=clone(input.source);return {operationId:d.operationId,status:'approved',round:clone(round),receipt:clone(receipt)};
  };
  f.last.capabilities={narrativeRevisions:1};f.last.presentFact=async input=>{presentations.push(clone({...input,signal:undefined}));if(f.faults.presentation)return {status:'failed',errorCode:'WRITER_FAILED'};acceptedProse.push(clone({...input,signal:undefined}));return {status:'complete',presentationId:'presentation-'+input.factReceiptId};};
  f.last.narratives=async({sessionId})=>({records:[...acceptedFactPresentations(projectSession(await f.readSession(sessionId))).map(item=>({id:item.result.data.meta.rpLastStep.record.id,factReceiptId:item.factReceiptId,ref:{sessionId,presentationId:item.result.data.meta.rpLastStep.record.id},text:item.result.data.message.content[0].text})),...acceptedProse.filter(input=>input.sessionId===sessionId).map(input=>({id:'presentation-'+input.factReceiptId,factReceiptId:input.factReceiptId,ref:{sessionId,presentationId:'presentation-'+input.factReceiptId},text:'Contract accepted prose'}))]});
  await setup?.(f);const service=await createGmHost(f.ctx,{...f.options,...options});f.service=service;t.after(()=>service.close());
  const started=await service.startStory(launch());f.id=started.sessionId;f.installPresenter(service);const opening=await f.runTool(f.id,'rp_begin_story');await f.runTool(f.id,'rp_present',{factReceiptId:opening.id});
  return {...f,rounds,decisions,commands,commandInputs,generationInputs,stages,presentations,state};
}
export async function propose(f,changes={}){const state=await f.runTool(f.id,'rp_gm_state');return f.runTool(f.id,'rp_propose_turn',{expectedRevision:state.revision,summary:'交信',facts:{schemaVersion:1,items:[{id:'letter-holder',text:'林遥持有信件。'}]},packet:{playerAction:'把信交给林遥'},...changes});}
export function decisionInput(f,review,changes={}){return {sessionId:f.id,roundId:review.latestRound.roundId,candidateId:review.latestRound.pendingCandidateId,action:'approve',operationId:'owner-one',expectedRoundVersion:review.latestRound.version,expectedDatabaseRevision:review.databaseRevision,...changes};}
