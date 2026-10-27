import {randomUUID} from 'node:crypto';
import {clone,fail,freeze,object,requestFingerprint,text} from './core.mjs';
import {exactFields,normalizeCandidate,normalizeDecision,normalizeGeneration,operationToken,revision} from './review-schema.mjs';

const DECIDE='rp-gm-fact-decision';
const GENERATE='rp-gm-fact-regenerate';
const tokens=value=>typeof value==='string'?value.trim().split(/\s+/u):[];
const safeError=error=>String(error?.code??(error?.name==='AbortError'?'CANCELLED':'PRESENTATION_FAILED'));
const reservedDecision=value=>['recorded','interrupted'].includes(value.status);

/** Durable GM coordination only. Database owns every baseline, candidate and effective fact. */
export function createFactReview({ctx,store,runtime,database,bound,viewFor,notify,generator}){
  const live=new Map(),dispatches=new Map(),disposers=[];
  function provider(){const db=database();if(db.capabilities?.factReview!==1||['factReviewState','factDecision','recordFactDecision','finalizeFactDecision','stageFactCandidate'].some(key=>typeof db[key]!=='function'))fail('FACT_REVIEW_UNAVAILABLE','Install Database with fact review support',503);return db;}
  async function owned(input,requireIdle=false){
    await runtime.assertPlayable(input.sessionId);const record=await bound(input.sessionId,undefined,input.signal);if(!record)fail('STORY_NOT_FOUND','Story binding is unavailable',404);
    const agent=ctx.agents.get(input.sessionId);if(requireIdle&&(!agent||agent.status!=='idle'))fail(agent?'STORY_BUSY':'AGENT_REQUIRED',agent?'Wait for the current story operation to finish':'Open the native story session for this operation',409);return record;
  }
  async function exclusive(input,work,kind='decision'){if(live.has(input.sessionId))fail('STORY_BUSY','Another fact operation is still running',409);const life=new AbortController(),signal=input.signal?AbortSignal.any([input.signal,life.signal]):life.signal;live.set(input.sessionId,{life,kind,operationId:input.operationId});try{await owned({...input,signal},true);return await work({...input,signal});}finally{live.delete(input.sessionId);}}
  async function events(sessionId,signal){
    if(ctx.sessionQuery?.observeSession){const view=await ctx.sessionQuery.observeSession(sessionId,{projections:'none'});try{signal?.throwIfAborted();return clone(view.events);}finally{view[Symbol.dispose]();}}
    return (await viewFor(sessionId,ctx.agents.get(sessionId),signal))?.events??[];
  }
  function validRun(rows,source,name,operationId,hash){const matches=rows.filter(row=>row.type==='command/run'&&row.data?.commandId===source.commandId);if(matches.length!==1||matches[0].seq!==source.runSeq||matches[0].data.name!==name||matches[0].data.source?.kind!=='user'||JSON.stringify(tokens(matches[0].data.args))!==JSON.stringify([operationId,hash]))fail('DECISION_SOURCE_INVALID','The exact owner command source is unavailable',403);return matches[0];}
  async function anchor(invocation,name,operationId,hash){
    const sessionId=invocation.agent.session.id,scope=dispatches.get(sessionId);if(scope?.name!==name||scope.operationId!==operationId||scope.requestHash!==hash||!live.has(sessionId)||invocation.agent!==ctx.agents.get(sessionId)||typeof invocation.commandId!=='string')fail('DECISION_SOURCE_INVALID','An active owner request is required',403);
    const rows=await events(sessionId,invocation.signal),matches=rows.filter(row=>row.type==='command/run'&&row.data?.commandId===invocation.commandId);if(matches.length!==1)fail('DECISION_SOURCE_INVALID','A unique owner command source is required',403);
    const source={sessionId,commandId:invocation.commandId,runSeq:matches[0].seq,requestHash:hash};validRun(rows,source,name,operationId,hash);return source;
  }
  async function completion(source,name,operationId,hash,expected){
    if(!source)return null;const rows=await events(source.sessionId);validRun(rows,source,name,operationId,hash);const matches=rows.filter(row=>row.type==='command/done'&&row.data?.commandId===source.commandId);
    if(matches.length!==1||matches[0].seq<=source.runSeq||matches[0].data.kind!=='success')return null;
    let value;try{value=JSON.parse(matches[0].data.text);}catch{fail('DECISION_SOURCE_INVALID','Owner command completion did not return its bound result',403);}
    if(!object(value)||JSON.stringify(Object.keys(value).sort())!==JSON.stringify(Object.keys(expected).sort())||requestFingerprint(value)!==requestFingerprint(expected))fail('DECISION_SOURCE_INVALID','Owner command completion does not match the stored request',403);
    return {...clone(source),doneSeq:matches[0].seq};
  }
  async function dispatch(input,name,operationId,requestHash){
    if(typeof ctx.commands?.register!=='function')fail('OWNER_COMMAND_UNAVAILABLE','A recorded native owner command is required',503);
    dispatches.set(input.sessionId,{name,operationId,requestHash});try{await ctx.typertGateway.invoke({namespace:'commands',method:'execute',args:{agentId:input.sessionId,line:`/${name} ${operationId} ${requestHash}`,submittedAttachments:[]},peer:ctx.connection.browserPeer,signal:input.signal});}finally{dispatches.delete(input.sessionId);}
  }
  const findDecision=async(sessionId,operationId)=>(await store.review(sessionId)).decisions.find(item=>item.operationId===operationId);
  async function saveDecision(sessionId,operationId,patch){await store.updateReview(sessionId,state=>{const item=state.decisions.find(value=>value.operationId===operationId);Object.assign(item,clone(patch));});notify(sessionId);}
  async function decisionHandler(invocation){
    const args=tokens(invocation.rawInput);if(args.length!==2)fail('DECISION_SOURCE_INVALID','Expected the stored operation and request hash',403);const [operationId,hash]=args,sessionId=invocation.agent.session.id,entry=await findDecision(sessionId,operationId);
    if(!entry||entry.requestHash!==hash||requestFingerprint(entry.request)!==hash)fail('DECISION_SOURCE_INVALID','Owner request metadata does not match the command',403);
    const source=await anchor(invocation,DECIDE,operationId,hash);await saveDecision(sessionId,operationId,{source});
    const {candidatePayloadHash,...request}=entry.request;void candidatePayloadHash;
    await provider().recordFactDecision({...request,operationId,expectedRoundVersion:entry.expectedRoundVersion,expectedDatabaseRevision:entry.expectedDatabaseRevision,source,signal:invocation.signal});
    notify(sessionId);
    return {kind:'success',text:JSON.stringify({schemaVersion:1,operationId,requestHash:hash})};
  }
  if(ctx.commands?.register)disposers.push(ctx.commands.register({name:DECIDE,description:'Record the exact owner fact decision; fact application follows successful completion.',recordInput:true,input:{hint:'<operationId> <requestHash>'},handler:decisionHandler}));
  const findJob=async(sessionId,operationId)=>(await store.review(sessionId)).generations.find(item=>item.operationId===operationId);
  function publicJob(job){return {id:job.id,operationId:job.operationId,roundId:job.roundId,status:job.status,...job.candidateId?{candidateId:job.candidateId}:{},...job.errorCode?{errorCode:job.errorCode}:{},...job.model?{model:clone(job.model)}:{}};}
  async function saveJob(sessionId,operationId,patch){await store.updateReview(sessionId,state=>{const job=state.generations.find(value=>value.operationId===operationId);Object.assign(job,clone(patch));});notify(sessionId);}
  function generatedCandidate(state,job){return state.rounds.find(round=>round.roundId===job.roundId)?.candidates.find(candidate=>candidate.operationId===job.operationId);}
  function generationTarget(state,job,candidate){
    const round=state.rounds.find(round=>round.roundId===job.roundId);if(!round)fail('FACT_ROUND_NOT_FOUND','The captured fact round is unavailable',404);
    if(state.projection.latestRoundId!==round.roundId||!round.latest)fail('FACT_ROUND_NOT_LATEST','Only the latest factual round can be regenerated',409);
    if(state.decisions.some(value=>value.roundId===round.roundId&&reservedDecision(value)&&value.operationId!==job.decisionOperationId))fail('FACT_REVIEW_PENDING','Settle the existing decision before changing its candidate',409);
    if(candidate){const index=round.candidates.findIndex(value=>value.id===candidate.id);if(index!==round.candidates.length-1||candidate.generationConfirmed===true&&round.pendingCandidateId!==candidate.id)fail('FACT_BASE_CHANGED','A newer candidate or decision supersedes this generation',409);}
    else if(round.version!==job.request.expectedRoundVersion)fail('FACT_BASE_CHANGED','The fact round changed before generation',409);
    return round;
  }
  async function generationHandler(invocation){
    const args=tokens(invocation.rawInput);if(args.length!==2)fail('DECISION_SOURCE_INVALID','Expected the stored generation operation and hash',403);const [operationId,hash]=args,sessionId=invocation.agent.session.id;let job=await findJob(sessionId,operationId);
    if(!job||job.requestHash!==hash||requestFingerprint(job.request)!==hash)fail('DECISION_SOURCE_INVALID','Stored generation request does not match the command',403);
    const source=await anchor(invocation,GENERATE,operationId,hash),state=await provider().factReviewState({sessionId,signal:invocation.signal});let candidate=generatedCandidate(state,job);const replaying=!!candidate,round=generationTarget(state,job,candidate);
    await saveJob(sessionId,operationId,{source});
    if(!candidate){
      if(!generator?.select||!generator?.generate)fail('FACT_GENERATOR_UNAVAILABLE','The fact generation model service is unavailable',503);
      const model=await generator.select({sessionId,jobId:job.id,signal:invocation.signal});await saveJob(sessionId,operationId,{model});invocation.signal.throwIfAborted();
      const payload=normalizeCandidate(await generator.generate({sessionId,jobId:job.id,request:freeze(clone(job.request)),round:freeze(clone(round)),model:freeze(clone(model)),signal:invocation.signal}));invocation.signal.throwIfAborted();
      const staged=await provider().stageFactCandidate({sessionId,roundId:job.roundId,payload,model,operationId,expectedRoundVersion:job.request.expectedRoundVersion,source,approvalRequired:job.request.approvalRequired,generationRequest:clone(job.request),signal:invocation.signal});invocation.signal.throwIfAborted();candidate=staged.round.candidates.find(value=>value.id===staged.candidateId);if(!candidate)fail('GENERATION_NOT_STAGED','Database did not return its staged candidate',409);
    }
    job=await findJob(sessionId,operationId);if(job.status==='cancelled'&&!replaying)fail('CANCELLED','The generation was cancelled',409);invocation.signal.throwIfAborted();await saveJob(sessionId,operationId,{candidateId:candidate.id,model:job.model??candidate.model});
    return {kind:'success',text:JSON.stringify({schemaVersion:1,operationId,candidateId:candidate.id,payloadHash:candidate.payloadHash})};
  }
  if(ctx.commands?.register)disposers.push(ctx.commands.register({name:GENERATE,description:'Generate one tool-free fact candidate from its immutable captured request.',recordInput:true,input:{hint:'<operationId> <requestHash>'},handler:generationHandler}));
  async function acceptedPresentation(sessionId,factReceiptId,signal){const last=ctx.get('rpLastStep');if(typeof last?.narratives!=='function')return null;return (await last.narratives({sessionId,signal})).records.filter(item=>item.factReceiptId===factReceiptId).at(-1)??null;}
  async function present(input,entry,result,save=value=>saveDecision(input.sessionId,entry.operationId,{result:value})){
    const last=ctx.get('rpLastStep');let presentation;
    try{
      if(last?.capabilities?.narrativeRevisions!==1||typeof last.presentFact!=='function')fail('LAST_STEP_UNAVAILABLE','Install LastStep with fact presentation support',503);
      presentation=await last.presentFact({sessionId:input.sessionId,factReceiptId:result.factReceiptId,operationId:entry.presentationOperationId,signal:input.signal});
      if(!['complete','failed','interrupted'].includes(presentation?.status)||presentation.status==='complete'&&typeof presentation.presentationId!=='string')fail('PRESENTATION_NOT_CONFIRMED','The writer has no confirmed presentation result',409);
      if(presentation.status==='complete'&&(await acceptedPresentation(input.sessionId,result.factReceiptId,input.signal))?.ref?.presentationId!==presentation.presentationId)fail('PRESENTATION_NOT_CONFIRMED','No accepted canonical prose matches this presentation',409);
      presentation={status:presentation.status,...typeof presentation.presentationId==='string'?{presentationId:presentation.presentationId}:{},...typeof presentation.errorCode==='string'?{errorCode:presentation.errorCode}:{}};
    }catch(error){
      if(error.code==='FACT_ALREADY_PRESENTED'&&typeof last?.narratives==='function'){
        const accepted=(await last.narratives({sessionId:input.sessionId,signal:input.signal})).records.filter(item=>item.factReceiptId===result.factReceiptId).at(-1);
        if(accepted?.ref?.presentationId)presentation={status:'complete',presentationId:accepted.ref.presentationId};
      }
      presentation??={status:input.signal?.aborted?'interrupted':'failed',errorCode:safeError(error)};
    }
    const value={...result,presentation};await save(value);return value;
  }
  async function settleDecision(input,entry,write=true){
    const db=provider(),decision=await db.factDecision({sessionId:input.sessionId,operationId:entry.operationId,signal:input.signal});
    if(decision?.status==='failed')fail(decision.errorCode??'FACT_DECISION_FAILED','This decision was refused; use a new explicit operation after reviewing current state',409);
    let source=decision?.source??entry.source,done=await completion(source,DECIDE,entry.operationId,entry.requestHash,{schemaVersion:1,operationId:entry.operationId,requestHash:entry.requestHash});
    if(!done){await dispatch(input,DECIDE,entry.operationId,entry.requestHash);entry=await findDecision(input.sessionId,entry.operationId);source=(await db.factDecision({sessionId:input.sessionId,operationId:entry.operationId,signal:input.signal}))?.source??entry.source;done=await completion(source,DECIDE,entry.operationId,entry.requestHash,{schemaVersion:1,operationId:entry.operationId,requestHash:entry.requestHash});}
    if(!done)fail('DECISION_NOT_CONFIRMED','The owner command has no matching successful completion',409);
    const finalized=await db.finalizeFactDecision({sessionId:input.sessionId,operationId:entry.operationId,source:done,signal:input.signal});
    if(!['approved','cancelled'].includes(finalized.status)||finalized.status==='approved'&&!finalized.receipt?.id)fail('DECISION_NOT_CONFIRMED','The Database has not confirmed a fact outcome',409);
    const accepted=finalized.receipt?await acceptedPresentation(input.sessionId,finalized.receipt.id,input.signal):null;
    const result={operationId:entry.operationId,status:finalized.status,roundId:finalized.round.roundId,...finalized.receipt?{factReceiptId:finalized.receipt.id}:{},presentation:accepted?{status:'complete',presentationId:accepted.ref.presentationId}:{status:finalized.status==='approved'&&write?'interrupted':'not-requested'}};
    await saveDecision(input.sessionId,entry.operationId,{result,completion:done});if(finalized.receipt)await store.receipt(input.sessionId,finalized.receipt.id);notify(input.sessionId);
    return result.status==='approved'&&write&&!accepted?present(input,entry,result):result;
  }
  async function replayDecision(input,entry){
    const decision=await provider().factDecision({sessionId:input.sessionId,operationId:entry.operationId,signal:input.signal});
    if(decision?.status!=='applied'||decision.requestHash!==entry.requestHash||entry.result.factReceiptId!==decision.factReceiptId||!await completion(decision.source,DECIDE,entry.operationId,entry.requestHash,{schemaVersion:1,operationId:entry.operationId,requestHash:entry.requestHash}))fail('DECISION_NOT_CONFIRMED','The stored outcome has no matching successful native decision',409);
    const accepted=entry.result.status==='approved'?await acceptedPresentation(input.sessionId,entry.result.factReceiptId,input.signal):null;
    if(accepted){const result={...clone(entry.result),presentation:{status:'complete',presentationId:accepted.ref.presentationId}};if(requestFingerprint(result)!==requestFingerprint(entry.result))await saveDecision(input.sessionId,entry.operationId,{result});return result;}
    return clone(entry.result);
  }
  async function decide(input,write=true){
    const normalized=normalizeDecision(input),old=await findDecision(input.sessionId,normalized.operationId);
    if(old){const semantic={sessionId:normalized.sessionId,roundId:normalized.roundId,candidateId:normalized.candidateId,action:normalized.action,candidatePayloadHash:old.request.candidatePayloadHash,...normalized.custom?{custom:normalized.custom}:{}};if(requestFingerprint(semantic)!==old.requestHash)fail('OPERATION_ID_CONFLICT','This operation already belongs to another decision',409);return old.result?replayDecision(input,old):settleDecision(input,old,write);}
    const state=await provider().factReviewState({sessionId:input.sessionId,signal:input.signal}),round=state.rounds.find(value=>value.roundId===normalized.roundId),candidate=round?.candidates.find(value=>value.id===normalized.candidateId);
    if(!candidate)fail('FACT_CANDIDATE_NOT_FOUND','The displayed fact candidate is unavailable',404);
    if(state.projection.latestRoundId!==round.roundId||!round.latest)fail('FACT_ROUND_NOT_LATEST','Only the latest factual round can be reviewed',409);
    if(round.pendingCandidateId!==candidate.id)fail('FACT_BASE_CHANGED','The pending candidate changed; reload it',409);
    const request={sessionId:normalized.sessionId,roundId:normalized.roundId,candidateId:normalized.candidateId,action:normalized.action,candidatePayloadHash:candidate.payloadHash,...normalized.custom?{custom:normalized.custom}:{}},entry={operationId:normalized.operationId,request,requestHash:requestFingerprint(request),expectedRoundVersion:normalized.expectedRoundVersion,expectedDatabaseRevision:normalized.expectedDatabaseRevision,presentationOperationId:randomUUID()};
    await store.updateReview(input.sessionId,state=>{state.decisions.push(entry);});notify(input.sessionId);return settleDecision(input,entry,write);
  }
  async function settleGeneration(input,job,allowNew=false,write=true){
    const db=provider();let state=await db.factReviewState({sessionId:input.sessionId,signal:input.signal}),candidate=generatedCandidate(state,job),round=state.rounds.find(value=>value.roundId===job.roundId),previousDecision=await findDecision(input.sessionId,job.decisionOperationId);
    if(previousDecision?.result)return {job:publicJob(job),round,decision:await replayDecision(input,previousDecision)};
    if(!candidate&&!allowNew)fail('GENERATION_NOT_STAGED','No candidate was staged; explicitly start a new fact generation',409);
    generationTarget(state,job,candidate);
    try{
      let done=candidate?await completion(job.source,GENERATE,job.operationId,job.requestHash,{schemaVersion:1,operationId:job.operationId,candidateId:candidate.id,payloadHash:candidate.payloadHash}):null;
      if(previousDecision&&candidate?.generationConfirmed&&done){const decision=await settleDecision(input,previousDecision,write);round=(await db.factReviewState({sessionId:input.sessionId,signal:input.signal})).rounds.find(value=>value.roundId===job.roundId);return {job:publicJob(job),round,decision};}
      if(!done){await dispatch(input,GENERATE,job.operationId,job.requestHash);job=await findJob(input.sessionId,job.operationId);state=await db.factReviewState({sessionId:input.sessionId,signal:input.signal});candidate=generatedCandidate(state,job);if(!candidate)fail('GENERATION_NOT_STAGED','The generation command did not stage a candidate',409);generationTarget(state,job,candidate);done=await completion(job.source,GENERATE,job.operationId,job.requestHash,{schemaVersion:1,operationId:job.operationId,candidateId:candidate.id,payloadHash:candidate.payloadHash});}
      if(!done)fail('DECISION_NOT_CONFIRMED','The generation command has no matching successful completion',409);input.signal?.throwIfAborted();
      const confirmed=await db.stageFactCandidate({sessionId:input.sessionId,roundId:job.roundId,payload:clone(candidate.payload),...job.model?{model:clone(job.model)}:{},operationId:job.operationId,expectedRoundVersion:job.request.expectedRoundVersion,source:job.source,approvalRequired:job.request.approvalRequired,generationRequest:clone(job.request),completion:done,signal:input.signal});
      round=confirmed.round;await saveJob(input.sessionId,job.operationId,{candidateId:candidate.id,status:'complete',completion:done,errorCode:undefined});job=await findJob(input.sessionId,job.operationId);
      if(job.request.approvalRequired)return {job:publicJob(job),round};
      state=await db.factReviewState({sessionId:input.sessionId,signal:input.signal});const decision=await decide({sessionId:input.sessionId,roundId:job.roundId,candidateId:candidate.id,action:'approve',operationId:job.decisionOperationId,expectedRoundVersion:round.version,expectedDatabaseRevision:state.databaseRevision,signal:input.signal},write);round=(await db.factReviewState({sessionId:input.sessionId,signal:input.signal})).rounds.find(value=>value.roundId===job.roundId);return {job:publicJob(job),round,decision};
    }catch(error){
      const current=await findJob(input.sessionId,job.operationId);if(current.status!=='complete')await saveJob(input.sessionId,job.operationId,{status:current.status==='cancelled'?'cancelled':input.signal?.aborted?'interrupted':'failed',errorCode:safeError(error)});throw error;
    }
  }
  async function resumePresentation(input){
    exactFields(input,['sessionId','roundId','operationId','signal']);text(input.roundId,'Round ID');operationToken(input.operationId);let entry=await findDecision(input.sessionId,input.operationId);
    const state=await provider().factReviewState({sessionId:input.sessionId,signal:input.signal}),round=state.rounds.find(value=>value.roundId===input.roundId),decision=state.decisions.find(value=>value.operationId===input.operationId);
    if(decision?.status!=='applied'||decision.action==='cancel'||!decision.factReceiptId)fail('DECISION_NOT_CONFIRMED','An applied fact decision is required before writing',409);
    let result;
    if(entry){
      if(entry.request.roundId!==input.roundId)fail('OPERATION_ID_CONFLICT','This decision belongs to another fact round',409);
      result=entry.result?await replayDecision(input,entry):await settleDecision(input,entry,false);entry=await findDecision(input.sessionId,input.operationId);if(result.presentation.status==='complete')return result;
    }
    if(state.projection.latestRoundId!==input.roundId||round?.activeReceiptId!==decision.factReceiptId||round.pendingCandidateId||state.decisions.some(reservedDecision))fail('FACT_VERSION_SUPERSEDED','This fact revision cannot be presented now',409);
    if(entry)return present(input,entry,result);
    if(decision.source?.sessionId===input.sessionId)fail('OPERATION_NOT_FOUND','The local fact decision coordination is unavailable',404);
    // Inherited applied provenance is read-only. Never record/finalize a parent operation in the child.
    const accepted=await acceptedPresentation(input.sessionId,decision.factReceiptId,input.signal);
    result={operationId:input.operationId,status:'approved',roundId:input.roundId,factReceiptId:decision.factReceiptId,presentation:accepted?{status:'complete',presentationId:accepted.ref.presentationId}:{status:'not-requested'}};
    if(accepted)return result;
    const metadata=await store.review(input.sessionId);let presentation=(metadata.presentations??[]).find(value=>value.operationId===input.operationId);
    if(presentation&&(presentation.roundId!==input.roundId||presentation.factReceiptId!==decision.factReceiptId))fail('OPERATION_ID_CONFLICT','The child presentation operation belongs to another fact receipt',409);
    if(!presentation){presentation={operationId:input.operationId,roundId:input.roundId,factReceiptId:decision.factReceiptId,presentationOperationId:randomUUID()};await store.updateReview(input.sessionId,value=>{value.presentations??=[];value.presentations.push(presentation);});}
    return present(input,presentation,result,async value=>{await store.updateReview(input.sessionId,state=>{state.presentations.find(item=>item.operationId===input.operationId).result=value;});notify(input.sessionId);});
  }
  const api={
    async reviewState(input){
      exactFields(input,['sessionId','signal']);await owned(input);let metadata=await store.review(input.sessionId);const state=await provider().factReviewState({sessionId:input.sessionId,signal:input.signal}),lastJob=metadata.generations.at(-1);let generation=null;
      if(lastJob){const candidate=generatedCandidate(state,lastJob),patch={...candidate?{candidateId:candidate.id}:{},...lastJob.status==='running'&&live.get(input.sessionId)?.operationId!==lastJob.operationId?{status:'interrupted'}:{}};if(Object.keys(patch).some(key=>lastJob[key]!==patch[key])){await saveJob(input.sessionId,lastJob.operationId,patch);metadata=await store.review(input.sessionId);}generation=publicJob(metadata.generations.at(-1));if(generation.status==='complete'&&(!candidate?.generationConfirmed||!await completion(lastJob.source,GENERATE,lastJob.operationId,lastJob.requestHash,{schemaVersion:1,operationId:lastJob.operationId,candidateId:candidate.id,payloadHash:candidate.payloadHash})))generation={...generation,status:'interrupted'};}
      const latestRound=state.rounds.find(value=>value.roundId===state.projection.latestRoundId)??null;
      const accepted=latestRound?.activeReceiptId?await acceptedPresentation(input.sessionId,latestRound.activeReceiptId,input.signal):null;
      const pendingDecision=state.decisions.find(reservedDecision)??(!accepted?state.decisions.findLast(value=>value.status==='applied'&&value.action!=='cancel'&&value.factReceiptId===latestRound?.activeReceiptId):null)??null;
      return {revision:metadata.revision,enabled:metadata.enabled,databaseRevision:state.databaseRevision,latestRound,pendingDecision,generation};
    },
    configureReview:input=>exclusive(input,async input=>{exactFields(input,['sessionId','enabled','expectedRevision','signal']);provider();if(typeof input.enabled!=='boolean')fail('INVALID_REVIEW_REQUEST','enabled must be boolean');revision(input.expectedRevision);const updated=await store.updateReview(input.sessionId,state=>{if(state.revision!==input.expectedRevision)fail('REVISION_CONFLICT','Fact review settings changed; reload them',409);state.enabled=input.enabled;});notify(input.sessionId);return {revision:updated.revision,enabled:updated.enabled};}),
    decideFacts:input=>exclusive(input,decide),
    resumeFactDecision:input=>exclusive(input,async input=>{exactFields(input,['sessionId','operationId','signal']);const entry=await findDecision(input.sessionId,operationToken(input.operationId));if(!entry)fail('OPERATION_NOT_FOUND','The stored fact decision is unavailable',404);return entry.result?replayDecision(input,entry):settleDecision(input,entry,false);}),
    resumeFactPresentation:input=>exclusive(input,resumePresentation),
    regenerateFacts:input=>exclusive(input,async input=>{
      const metadata=await store.review(input.sessionId),old=metadata.generations.find(value=>value.operationId===input.operationId),state=await provider().factReviewState({sessionId:input.sessionId,signal:input.signal}),round=state.rounds.find(value=>value.roundId===input.roundId);
      if(!round){const receipt=typeof runtime.inspect==='function'?(await runtime.inspect(input)).lastFactReceipt:null;fail(receipt?.id===input.roundId?'LEGACY_BASELINE_UNAVAILABLE':'FACT_ROUND_NOT_FOUND','No captured baseline is available for this fact round',409);}
      const request=normalizeGeneration(input,old?.request.approvalRequired??(round.pendingCandidateId?true:metadata.enabled)),requestHash=requestFingerprint(request);
      if(old){if(old.requestHash!==requestHash)fail('OPERATION_ID_CONFLICT','This generation operation has another frozen request',409);return settleGeneration(input,old);}
      if(!round.canRegenerate)fail(round.blockCode??'FACT_ROUND_NOT_LATEST','This fact round is not eligible for regeneration',409);
      const job={id:randomUUID(),operationId:request.operationId,roundId:request.roundId,status:'running',request,requestHash,decisionOperationId:randomUUID()};generationTarget(state,job);await store.updateReview(input.sessionId,value=>{value.generations.push(job);});notify(input.sessionId);return settleGeneration(input,job,true);
    },'generation'),
    resumeFactGeneration:input=>exclusive(input,async input=>{exactFields(input,['sessionId','operationId','signal']);const job=await findJob(input.sessionId,operationToken(input.operationId));if(!job)fail('OPERATION_NOT_FOUND','The stored generation job is unavailable',404);return settleGeneration(input,job,false,false);},'generation'),
    async cancelFactGeneration(input){exactFields(input,['sessionId','jobId','signal']);await owned(input);text(input.jobId,'Generation job ID');const job=(await store.review(input.sessionId)).generations.find(value=>value.id===input.jobId);if(!job)fail('OPERATION_NOT_FOUND','The generation job is unavailable',404);if(job.status==='complete')return {job:publicJob(job)};await saveJob(input.sessionId,job.operationId,{status:'cancelled'});const operation=live.get(input.sessionId);if(operation?.kind==='generation'&&operation.operationId===job.operationId)operation.life.abort();return {job:publicJob(await findJob(input.sessionId,job.operationId))};},
    isLive:sessionId=>live.has(sessionId),
    close(){for(const operation of live.values())operation.life.abort();for(const dispose of disposers.reverse())dispose();},
  };
  return api;
}
