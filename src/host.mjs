import {homedir} from 'node:os';import {join} from 'node:path';
import {clone,createBinding,fail,freeze,normalizeStart,object,requestFingerprint,seedEntries,text} from './core.mjs';
import {createBindingStore} from './store.mjs';import {createSessionReader} from './session.mjs';
import {BUILTIN_PROFILE,BUILTIN_PROFILE_KEY,GM_PROTOCOL} from './profile.mjs';
import {createGmRuntime} from './runtime.mjs';import {registerGmAgent} from './agent.mjs';
import {createGmRoutes} from './routes.mjs';
import {createStoryBranches} from './branches.mjs';
import {createGmTransfer} from './transfer.mjs';
import {createFactReview} from './review.mjs';
import {createFactGenerator} from './fact-model.mjs';
import {usesNativeTools} from './native-tools.mjs';
import {createSessionLineage} from './lineage.mjs';
import {createGmOperations,domainInput} from './operations.mjs';
import {flushNativeSession} from './native-persistence.mjs';

export const name='rp-gm';
export const inject=['connection','typertGateway','agents','tools','systemPrompt','agentPresets','commands','sessionQuery','llm','sessions'];
export const PRESET_ID='rp-gm';

function acceptedOpeningRequest(view,requestId){
  const matches=message=>message?.source?.kind==='user'&&message.source.rpcId===requestId;
  return view?.events.some(event=>
    event.type==='user/message'&&matches(event.data)
    ||event.type==='agent/inbox/spliced'&&event.data?.inserted?.some(matches));
}

function promptFields(input,limit){
  const value=clone(input),complete=JSON.stringify(value).length<=limit;
  const fields=Object.keys(value).filter(key=>typeof value[key]==='string'||Array.isArray(value[key]));
  while(JSON.stringify(value).length>limit){
    const key=fields.reduce((longest,key)=>JSON.stringify(value[key]).length>JSON.stringify(value[longest]).length?key:longest);
    value[key]=value[key].slice(0,Math.floor(value[key].length/2));
  }
  return {value,complete};
}

function storyPrompt(state){
  const scene=promptFields(state.scene,1000),character=promptFields(state.binding.character,1400),persona=promptFields(state.binding.persona,900),facts=[];
  for(const item of state.facts.items.slice(0,12)){
    const preview={id:item.id,text:item.text.slice(0,500)};
    if(JSON.stringify([...facts,preview]).length>4800)break;
    facts.push(preview);
  }
  const expectedRevisionAvailable=Number.isSafeInteger(state.revision)&&state.revision>=0;
  return `CURRENT_GM_STORY (Database selected facts are authoritative; older native commits/prose are audit. Preview completeness is explicit.)\n${JSON.stringify({
    title:state.binding.title.slice(0,80),status:state.binding.status,expectedRevisionAvailable,...expectedRevisionAvailable?{expectedRevision:state.revision}:{},
    lastFactReceiptId:state.lastFactReceipt?.id,factRoundId:state.lastFactReceipt?.factRoundId,factRevision:state.lastFactReceipt?.factRevision,
    review:state.review?{enabled:state.review.enabled,pendingCandidateId:state.review.latestRound?.pendingCandidateId??null,pendingDecision:state.review.pendingDecision?{status:state.review.pendingDecision.status}:null,generation:state.review.generation?{status:state.review.generation.status}:null}:undefined,
    scene:scene.value,sceneComplete:scene.complete,facts,factCount:state.facts.items.length,factsComplete:facts.length===state.facts.items.length&&facts.every((item,index)=>item.text===state.facts.items[index].text),
    character:character.value,characterComplete:character.complete,persona:persona.value,personaComplete:persona.complete,
  })}`;
}

export async function createGmHost(ctx,options={}) {
  const store=options.store??createBindingStore({directory:options.directory??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'app-data','rp-gm')}),readSession=options.readSession??createSessionReader(ctx);
  const sessionLineage=createSessionLineage({ctx,store,readSession});
  const tasks=new Map(),operations=new Map(),subscribers=new Map(),disposers=[];let stopped=false,adapter;
  const notify=id=>{for(const fn of subscribers.get(id)??[])try{fn({type:'changed',sessionId:id});}catch{/* Observers do not own committed state. */}};
  async function run(signal,work){if(stopped)fail('UNAVAILABLE','GM plugin is unloaded',503);const life=new AbortController(),combined=signal?AbortSignal.any([signal,life.signal]):life.signal;combined.throwIfAborted();const pending=Promise.resolve().then(()=>work(combined));operations.set(life,pending);try{return await pending;}finally{operations.delete(life);}}
  const database=()=>{const value=ctx.get('rpDatabase');if(value?.apiVersion!==2||typeof value.factAccess!=='function'||typeof value.initializeStoryState!=='function')fail('DATABASE_UNAVAILABLE','Install RP Database 0.2 with fact service API v2',503);return value;};
  const lastStep=()=>{const value=ctx.get('rpLastStep');if(typeof value?.ensureBuiltinProfile!=='function'||typeof value.bindSession!=='function')fail('LAST_STEP_UNAVAILABLE','Install RP LastStep 0.3 with builtin and factual presentation support',503);return value;};
  async function viewFor(id,agent,signal){if(agent){if(agent.session.id!==id||ctx.agents.get(id)!==agent)fail('AGENT_MISMATCH','Caller does not own this story',403);return {header:agent.session.header??{id},events:agent.session.snapshotEvents()};}return readSession(id,signal);}
  async function bound(id,agent,signal){const view=await viewFor(id,agent,signal);if(!view)return null;let record=await store.binding(id);if(!record&&view.header?.agentPreset===PRESET_ID&&view.header?.parentSession){const parent=await bound(view.header.parentSession,undefined,signal);if(parent)record=await store.inherit(view.header.parentSession,id);}return record;}
  let review,jobs;
  const factOperationLive=id=>review?.isLive(id)||jobs?.isLive(id);
  const runtime=createGmRuntime({ctx,store,database,bound,viewFor,notify,reviewState:input=>review.reviewState(input),factOperationLive});
  const generator=createFactGenerator(ctx);disposers.push(()=>generator.close());review=createFactReview({ctx,store,runtime,database,bound,viewFor,notify,generator});disposers.push(()=>review.close());
  const branches=createStoryBranches({ctx,store,runtime,database,readSession,notify});
  const transfer=createGmTransfer({ctx,store,readSession,notify,factOperationLive});
  const result=record=>({binding:freeze(clone(record.binding)),sessionId:record.binding.sessionId,status:record.binding.status});
  async function hasDurableOpening(journal,signal){
    await flushNativeSession(ctx,journal.sessionId);
    const view=await readSession(journal.sessionId,signal);
    return view?.header.agentPreset===PRESET_ID&&acceptedOpeningRequest(view,journal.promptRequestId);
  }
  async function start(request,signal){
    let journal=await store.reserve(request),record=await store.binding(journal.sessionId);
    await runtime.assertPlayable(journal.sessionId);
    if(journal.progress.prompt&&record){
      if(!await hasDurableOpening(journal,signal))fail('OPENING_REQUEST_UNCONFIRMED','The saved launch has no matching native opening request',409);
      return result(record);
    }
    try{
      if(typeof ctx.sessions?.flush!=='function')fail('SESSION_PERSISTENCE_UNAVAILABLE','The host must provide per-session durable flush',503);
      const db=database(),last=lastStep();
      for(const source of request.sources){const resolved=await db.database({databaseId:source.databaseId,version:source.version,signal});if(resolved.database?.id!==source.databaseId||resolved.database.version!==source.version)fail('SOURCE_UNAVAILABLE','Pinned source version is unavailable',409);}
      const profile=record?.binding.profile??request.profile??await last.ensureBuiltinProfile({key:BUILTIN_PROFILE_KEY,profile:clone(BUILTIN_PROFILE)});
      const resolved=await last.profile(profile,signal);if(resolved.profile?.status!=='ready'||resolved.profile.id!==profile.profileId||resolved.profile.version!==profile.version)fail('PROFILE_NOT_READY','Choose an explicitly ready profile version',409);
      if(!record)record=await store.prepare(request.launchId,createBinding(request,{...journal,profile}),options.factApprovalDefault===true);
      let snapshot=await readSession(journal.sessionId,signal);
      if(snapshot&&snapshot.header.agentPreset!==PRESET_ID)fail('SESSION_CONFLICT','Reserved session belongs to another preset',409);
      if(!snapshot){const created=await ctx.typertGateway.invoke({namespace:'session',method:'create',args:{request:{sessionId:journal.sessionId,agentPreset:PRESET_ID}},peer:ctx.connection.browserPeer,signal});if(created.sessionId!==journal.sessionId)fail('SESSION_CONFLICT','Host did not retain the reserved session identity',409);}
      if(!usesNativeTools(ctx,ctx.agents.get(journal.sessionId)))fail('NATIVE_TOOLS_REQUIRED','Configure native tools before starting a GM story',409);
      if(!journal.progress.created)journal=await store.checkpoint(request.launchId,'created');
      if(!journal.progress.sources){await db.bindSources({sessionId:journal.sessionId,sources:clone(request.sources),expectedRevision:(await db.state({signal})).revision,resetOverlay:false,signal});journal=await store.checkpoint(request.launchId,'sources');}
      if(!journal.progress.initialized){await db.initializeStoryState({sessionId:journal.sessionId,entries:seedEntries(request),factEntryRefs:clone(record.binding.factEntryRefs),launchId:request.launchId,expectedRevision:(await db.state({signal})).revision,signal});journal=await store.checkpoint(request.launchId,'initialized');}
      if(!journal.progress.profile){const state=await last.state(journal.sessionId,signal);if(state.binding){const current=await last.profile({profileId:state.binding.profileId,version:state.binding.version},signal);if(current.profile?.status!=='ready')fail('PROFILE_NOT_READY','The current owner-selected style is not ready',409);}else await last.bindSession({sessionId:journal.sessionId,...profile,expectedRevision:state.revision},signal);journal=await store.checkpoint(request.launchId,'profile');}
      await store.setStatus(journal.sessionId,'starting');
      const agent=ctx.agents.get(journal.sessionId);if(agent)await adapter?.sync(agent);
      snapshot=await readSession(journal.sessionId,signal);
      const accepted=acceptedOpeningRequest(snapshot,journal.promptRequestId);
      if(!accepted)await ctx.typertGateway.invoke({namespace:'session',method:'prompt',args:{request:{sessionId:journal.sessionId,requestId:journal.promptRequestId,mode:'queue',content:[{type:'text',text:'开始这个已审核的故事。先调用 rp_begin_story，然后仅以 rp_present({factReceiptId}) 呈现已选开场。'}]}},peer:ctx.connection.browserPeer,signal});
      if(!await hasDurableOpening(journal,signal))fail('OPENING_REQUEST_UNCONFIRMED','The host did not retain the exact opening request after durable flush',409);
      signal?.throwIfAborted();
      await store.checkpoint(request.launchId,'prompt');notify(journal.sessionId);return result(await store.binding(journal.sessionId));
    }catch(error){if(record)await store.setStatus(journal.sessionId,'failed');await store.diagnostic(request.launchId,error);notify(journal.sessionId);throw error;}
  }
  async function startStory(input){
    const request=normalizeStart(input),fingerprint=requestFingerprint(request),pending=tasks.get(request.launchId);
    if(pending){
      if(pending.fingerprint!==fingerprint)fail('LAUNCH_CONFLICT','This launch is already starting with different data',409);
      return pending.promise;
    }
    const promise=start(request,input.signal);
    tasks.set(request.launchId,{fingerprint,promise});
    try{return await promise;}finally{tasks.delete(request.launchId);}
  }
  async function cancelTurn(input,signal){
    if(!object(input)||Object.keys(input).some(key=>!['sessionId','expectedTurnStartSeq'].includes(key)))fail('INVALID_REQUEST','Unexpected turn cancellation fields');
    const sessionId=text(input.sessionId,'Session ID',false,'INVALID_REQUEST'),expectedTurnStartSeq=input.expectedTurnStartSeq;
    if(!Number.isSafeInteger(expectedTurnStartSeq)||expectedTurnStartSeq<=0)fail('INVALID_REQUEST','A positive expected turn start sequence is required');
    const record=await bound(sessionId,undefined,signal);
    await runtime.assertPlayable(sessionId);
    signal?.throwIfAborted();
    if(!record)fail('STORY_NOT_FOUND','Story binding is unavailable',404);
    if(record.binding.status!=='active')fail('STORY_NOT_ACTIVE','Only an active RP story can stop its current turn',409);
    const agent=ctx.agents.get(sessionId);
    // Keep the native turn identity check and cancel in the same synchronous section.
    const open=agent?.session.header.agentPreset===PRESET_ID?ctx.agents.turnBoundaryOf(agent.session)?.openTurnStartSeq:null;
    const observedTurnStartSeq=Number.isSafeInteger(open)&&open>0?open:null;
    const accepted=agent?.status==='running'&&observedTurnStartSeq===expectedTurnStartSeq;
    if(accepted)agent.cancel({kind:'user'},{keepInbox:true});
    return {schemaVersion:1,sessionId,expectedTurnStartSeq,accepted,observedTurnStartSeq,...accepted?{}:{reason:'stale-or-complete'}};
  }
  async function authorizeOperation(input,submitting,signal){
    const launchId=input.kind==='startStory'?input.input.launchId:input.launchId;
    if(launchId){
      const journal=await store.launch(launchId);
      if(input.kind==='startStory'&&!journal&&!input.sessionId)return {launchId};
      if(!journal)fail('OPERATION_NOT_FOUND','The stored launch operation is unavailable',404);
      if(input.sessionId&&input.sessionId!==journal.sessionId)fail('AGENT_MISMATCH','The launch and session identities do not match',403);
      if(submitting)await runtime.assertPlayable(journal.sessionId);
      const view=await readSession(journal.sessionId,signal);
      if(view&&view.header.agentPreset!==PRESET_ID)fail('AGENT_MISMATCH','This launch belongs to another preset',403);
      return {sessionId:journal.sessionId,launchId};
    }
    if(submitting)await runtime.assertPlayable(input.sessionId);
    const record=await bound(input.sessionId,undefined,signal);
    if(!record&&(submitting||!await store.launchForSession(input.sessionId)))
      fail('OPERATION_NOT_FOUND','The stored operation is unavailable',404);
    const view=await readSession(input.sessionId,signal);
    if(view&&view.header.agentPreset!==PRESET_ID)fail('AGENT_MISMATCH','This session belongs to another preset',403);
    return {sessionId:input.sessionId};
  }
  jobs=createGmOperations({store,notify,authorize:authorizeOperation,
    execute:(kind,input)=>kind==='startStory'?startStory(input):review[kind](input),
    async reconcile(operation){
      if(operation.kind!=='startStory')return review.operationOutcome(operation.kind,domainInput(operation));
      const journal=await store.launch(operation.launchId),record=journal&&await store.binding(journal.sessionId);
      if(!record||!await hasDurableOpening(journal))return null;
      if(!journal.progress.prompt)await store.checkpoint(journal.launchId,'prompt');
      if(['prepared','failed'].includes(record.binding.status)){
        await store.setStatus(journal.sessionId,'starting');
        record.binding.status='starting';
      }
      return {status:'complete',result:result(record)};
    },
  });
  const service={apiVersion:1,capabilities:{factReview:1,factRegeneration:1,sessionLineage:1,operations:1,forkStoryAtReading:1},
    submitOperation:(input,signal)=>jobs.submitOperation(input,signal),
    operation:input=>run(input.signal,signal=>jobs.operation({...input,signal})),
    operations:input=>run(input.signal,signal=>jobs.operations({...input,signal})),
    cancelOperation:(input,signal)=>jobs.cancelOperation(input,signal),
    cancelTurn:input=>run(undefined,signal=>cancelTurn(input,signal)),
    sessionLineage:input=>run(input.signal,signal=>sessionLineage({...input,signal})),
    reviewState:input=>run(input.signal,signal=>review.reviewState({...input,signal})),
    configureReview:input=>run(input.signal,signal=>review.configureReview({...input,signal})),
    decideFacts:input=>run(input.signal,signal=>review.decideFacts({...input,signal})),
    resumeFactDecision:input=>run(input.signal,signal=>review.resumeFactDecision({...input,signal})),
    resumeFactPresentation:input=>run(input.signal,signal=>review.resumeFactPresentation({...input,signal})),
    regenerateFacts:input=>run(input.signal,signal=>review.regenerateFacts({...input,signal})),
    resumeFactGeneration:input=>run(input.signal,signal=>review.resumeFactGeneration({...input,signal})),
    cancelFactGeneration:input=>run(input.signal,signal=>review.cancelFactGeneration({...input,signal})),
    startStory:input=>run(input.signal,signal=>startStory({...input,signal})),
    binding:input=>run(input.signal,async signal=>{const record=await runtime.refresh(input.sessionId,undefined,signal);return record?freeze(clone(record.binding)):null;}),
    storyState:input=>run(input.signal,signal=>runtime.storyState({...input,signal})),
    presentation:input=>run(input.signal,signal=>runtime.presentation({...input,signal})),
    forkStory:input=>run(input.signal,signal=>branches.forkStory({...input,signal})),
    forkStoryAtReading:input=>run(input.signal,signal=>branches.forkStoryAtReading({...input,signal})),
    rollbackStory:input=>run(input.signal,signal=>branches.rollbackStory({...input,signal})),
    reserveRestore:input=>run(input.signal,signal=>branches.reserveRestore({...input,signal})),
    activateRestored:input=>run(input.signal,signal=>branches.activateRestored({...input,signal})),
    exportState:input=>run(input.signal,signal=>transfer.exportState({...input,signal})),
    preflightRestore:input=>run(input.signal,signal=>transfer.preflightRestore({...input,signal})),
    restoreState:input=>run(input.signal,signal=>transfer.restoreState({...input,signal})),
    contentRevision:(input={})=>run(input.signal,()=>transfer.contentRevision()),
    listStories:({signal}={})=>run(signal,async()=>({stories:(await store.bindings()).map(({binding})=>({sessionId:binding.sessionId,title:binding.title,status:binding.status,character:binding.character,persona:binding.persona}))})),
    diagnostics:()=>run(undefined,async()=>({database:ctx.get('rpDatabase')?.apiVersion===2,lastStep:typeof ctx.get('rpLastStep')?.ensureBuiltinProfile==='function',context:!!ctx.get('rpContext'),loop:!!ctx.get('loopStudio'),lastStepProseRegeneration:ctx.get('rpLastStep')?.capabilities?.narrativeRevisions===1&&typeof ctx.get('rpLastStep').storyHistory==='function'&&typeof ctx.get('rpLastStep').regenerateProse==='function'})),
    subscribe(id,fn){const set=subscribers.get(id)??new Set();set.add(fn);subscribers.set(id,set);return()=>{set.delete(fn);if(!set.size)subscribers.delete(id);};},
    async close(){if(stopped)return;stopped=true;for(const life of operations.keys())life.abort();await Promise.allSettled([jobs.close(),...operations.values()]);for(const dispose of disposers.splice(0).reverse())await dispose();subscribers.clear();},
  };
  disposers.push(await ctx.agentPresets.register({id:PRESET_ID,name:'通用故事 GM',description:'所有故事共用的原生 GM',plugins:[{id:'persona',name:'@deepseek-ai/dsh-persona',config:{prefix:GM_PROTOCOL}}]}));
  adapter=await registerGmAgent(ctx,runtime,async agent=>{try{return storyPrompt(await runtime.storyState({sessionId:agent.session.id,agent}));}catch(error){return `GM state unavailable (${error.code??'UNAVAILABLE'}). Do not invent facts; use rp_gm_state after the dependency is restored.`;}});
  disposers.push(adapter);
  disposers.push(ctx.on('session/event',(session,event)=>{if(!stopped&&['tool/result','assistant/message','turn/end','user/message'].includes(event.type))void run(undefined,signal=>runtime.refresh(session.id,ctx.agents.get(session.id),signal)).catch(()=>{});}));
  return service;
}

export async function apply(ctx,options={}) {
  const service=await createGmHost(ctx,options),routes=createGmRoutes(service);ctx.provide('rpGM',service);
  const unregister=[ctx.connection.fetch.register({path:'/api/rp-gm/request',methods:['POST'],requestBody:'buffered',fetch:request=>routes.request(request)}),ctx.connection.fetch.register({path:'/api/rp-gm/events',methods:['GET'],requestBody:'buffered',fetch:request=>routes.events(request)})];
  ctx.effect(()=>async()=>{routes.close();await service.close();for(const dispose of unregister)dispose();},'Generic GM runtime');
}
