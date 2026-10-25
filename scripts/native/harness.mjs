// Isolated rc.3 smoke fixture. Only the local model is deterministic;
// GM, Database, LastStep, Loop and canonical Session execution are real installed packages.
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';import {readFile} from 'node:fs/promises';import {dirname,join} from 'node:path';
export const name='gm-native-harness';
export const inject=['llm','agents','tools','connection','typertGateway','agentPresets','sessionQuery','sessionPersistence'];
const textOf=message=>typeof message?.content==='string'?message.content:(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
async function* tool(name,args){const id=randomUUID();yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)};yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}};yield {type:'finish',reason:{kind:'tool-calls'}};}
async function* prose(text){yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};}
function toolResults(messages){const calls=new Map();for(const message of messages)for(const block of Array.isArray(message.content)?message.content:[])if(block.type==='tool-call')calls.set(block.id,block.name);return messages.filter(message=>message.role==='tool').map(message=>{let value;try{value=JSON.parse(textOf(message));}catch{value=null;}return {name:calls.get(message.toolCallId),value,isError:message.isError};});}

export async function apply(ctx){
  const counts={gm:0,assembly:0,writer:0},requests=[],retryEvidence=[],disposers=[];let failWriter=false,retryCommit;
  const invoke=(method,request,signal)=>ctx.typertGateway.invoke({namespace:'session',method,args:{request},peer:ctx.connection.browserPeer,signal});
  const adapter={
    providerInfo:id=>({id,name:'GM native deterministic fixture'}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_provider,_model,value)=>value,
    listModels:async provider=>['gm','assembly','writer'].map(id=>({provider,id,name:id})),resolveModel:async(provider,id)=>({provider,id,name:id}),
    async prepareCall(provider,id,signal){return {model:await this.resolveModel(provider,id,signal),stream:options=>this.stream(id,options)};},
    async* stream(model,options){
      if(!Object.hasOwn(counts,model))throw Error('Unknown deterministic fixture model');if(++counts[model]>64)throw Error('GM_NATIVE_FIXTURE_REQUEST_LIMIT');
      requests.push({model,messageCount:options.messages.length,messages:structuredClone(model==='gm'?options.messages.slice(-12).map(message=>({...message,content:Array.isArray(message.content)?message.content.map(block=>block.type==='text'?{...block,text:block.text.slice(0,4000)}:block):message.content})):options.messages)});
      if(model==='assembly'){yield*prose('{"commit":true}');return;}
      if(model==='writer'){if(failWriter)throw Error('GM_NATIVE_FORCED_WRITER_FAILURE');const input=JSON.parse(textOf(options.messages.findLast(message=>message.role==='user')));yield*prose(input.packet.playerAction.includes('把信交给林遥')?'林遥接过密封信，轻轻点头。信件现在由她保管。':'雨声仍在窗外持续，客栈里暂时安静下来。');return;}
      const messages=options.messages??[],human=messages.findLastIndex(message=>message.role==='user'&&['user','user-rpc'].includes(message.source?.kind)),action=textOf(messages[human]),results=toolResults(messages.slice(human+1)),last=name=>results.findLast(result=>result.name===name);
      if(last('rp_present')?.isError){yield*prose('正文呈现失败；保留已提交事实，等待明确的正文重试请求。');return;}
      const requestedRewrite=action.match(/["']?rewriteOf["']?\s*[:=]\s*["']([^"']+)["']/u);if(action.includes('rp_present')&&requestedRewrite){yield*tool('rp_present',{rewriteOf:requestedRewrite[1]});return;}
      if(action.includes('rp_begin_story')){const begun=last('rp_begin_story');if(!begun){yield*tool('rp_begin_story',{});return;}if(!begun.value?.id)throw Error(`Opening tool failed: ${JSON.stringify(begun.value)}`);yield*tool('rp_present',{factReceiptId:begun.value.id});return;}
      if(action.includes('重试正文')){const catalog=last('rp_last_step_catalog');if(!catalog){yield*tool('rp_last_step_catalog',{});return;}const retry=catalog.value?.presentations?.find(item=>item.canRetry);if(!retry)throw Error('GM_NATIVE_NO_ELIGIBLE_RETRY');yield*tool('rp_present',{rewriteOf:retry.id});return;}
      const state=last('rp_gm_state'),committed=last('rp_commit_turn');
      if(!state){yield*tool('rp_gm_state',{});return;}
      if(action.includes('验证冲突回执')){const commits=results.filter(result=>result.name==='rp_commit_turn');if(commits.length<2){yield*tool('rp_commit_turn',{expectedRevision:state.value.revision,summary:commits.length?'Conflicting native probe':'Initial native probe',packet:{playerAction:action}});return;}yield*prose('冲突回执探针结束，世界条目未修改。');return;}
      if(committed?.value?.id){yield*tool('rp_present',{factReceiptId:committed.value.id});return;}
      if(!state.value?.facts)throw Error(`GM state failed: ${JSON.stringify(state.value)}`);
      const transfer=action.includes('把信交给林遥'),facts=transfer?{schemaVersion:1,items:state.value.facts.items.map(item=>item.id==='letter-holder'?{...item,text:'密封信件当前由林遥持有。'}:item)}:undefined;
      yield*tool('rp_commit_turn',{expectedRevision:state.value.revision,...facts?{facts}:{},summary:transfer?'旅人将密封信交给林遥。':'旅人停下来等候。',packet:{playerAction:action,resolvedChanges:transfer?['密封信件当前由林遥持有。']:[],visibleConsequences:transfer?['林遥接过密封信件，现在由她保管。']:['客栈里仍能听见雨声。']}});
    },
  };
  disposers.push(ctx.llm.registerAdapter(['gm-native-local'],adapter));
  disposers.push(ctx.on('tools/execute',async(exec,next)=>{if(retryCommit!==exec.agent.session.id||exec.name!=='rp_commit_turn')return next();retryCommit=undefined;const first=await next();if(first.isError)return first;const revision=(await ctx.get('rpDatabase').state({signal:exec.signal})).revision,second=await next();retryEvidence.push({sessionId:exec.agent.session.id,callId:exec.callId,firstReceiptId:first.value.id,secondReceiptId:second.value?.id,secondIsError:second.isError,firstRevision:revision,secondRevision:(await ctx.get('rpDatabase').state({signal:exec.signal})).revision});return second;}));
  async function snapshot(sessionId){const observed=await ctx.sessionQuery.observeSession(sessionId);try{const result={header:observed.header,events:observed.events,inheritedEventCount:observed.inheritedEventCount,live:!!ctx.agents.get(sessionId)};for(const [key,read]of [['gm',()=>ctx.get('rpGM').storyState({sessionId})],['database',()=>ctx.get('rpDatabase').effectiveV2({sessionId})],['narratives',()=>ctx.get('rpLastStep').narratives({sessionId})]])try{result[key]=await read();}catch(error){result[key]={error:{code:error.code,message:error.message}};}return result;}finally{observed[Symbol.dispose]();}}
  async function capture(sessionIds,signal){
    const ids=[...sessionIds].sort(),owners={database:ctx.get('rpDatabase'),lastStep:ctx.get('rpLastStep'),gm:ctx.get('rpGM')};
    async function locked(index){
      if(index<ids.length){const agent=ctx.agents.get(ids[index]);return agent?agent.runMaintenance(()=>locked(index+1)):locked(index+1);}
      const revisions=Object.fromEntries(await Promise.all(Object.entries(owners).map(async([name,owner])=>[name,await owner.contentRevision({signal})]))),bindings=await Promise.all(ids.map(sessionId=>owners.gm.binding({sessionId,signal}))),states={};
      states.database=await owners.database.exportState({sessionIds:ids,signal});states.lastStep=await owners.lastStep.exportState({sessionIds:ids,additionalProfileRefs:bindings.map(binding=>binding.profile),signal});states.gm=await owners.gm.exportState({sessionIds:ids,signal});
      const sessions=await Promise.all(ids.map(snapshot)),loopPolicies=await Promise.all(ids.map(async sessionId=>({sessionId,policy:(await ctx.get('loopStudio').inspect(sessionId,signal)).effectivePolicy}))),profiles=await Promise.all(ids.map(async sessionId=>({sessionId,binding:(await owners.lastStep.state(sessionId,signal)).binding})));
      for(const [name,owner]of Object.entries(owners))if(revisions[name].revision!==(await owner.contentRevision({signal})).revision)throw Error('Owner changed during fixture capture');
      return {sessionIds:ids,sessions,states,loopPolicies,profiles,initialProfiles:bindings.map(binding=>({sessionId:binding.sessionId,profile:binding.profile})),counts:{...counts}};
    }
    return locked(0);
  }
  disposers.push(ctx.connection.fetch.register({path:'/api/gm-native-harness',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    try{const input=await request.json();let value;
      if(input.action==='ready'){const gm=ctx.get('rpGM'),last=ctx.get('rpLastStep');value={gm:gm?.apiVersion,database:ctx.get('rpDatabase')?.apiVersion,context:!!ctx.get('rpContext'),loop:!!ctx.get('loopStudio'),gmMethods:Object.fromEntries(['exportState','preflightRestore','restoreState','contentRevision'].map(key=>[key,typeof gm?.[key]==='function'])),lastStep:Object.fromEntries(['ensureBuiltinProfile','narratives','material','inheritSession','presentationSummaries','retryPresentation','exportState','preflightRestore','restoreState','contentRevision'].map(key=>[key,typeof last?.[key]==='function'])),presets:(await ctx.agentPresets.list()).filter(item=>item.id==='rp-gm')};}
      else if(input.action==='snapshot')value=await snapshot(input.sessionId);
      else if(input.action==='counters')value={counts,requests,retryEvidence};
      else if(input.action==='retryNextCommit'){retryCommit=input.sessionId;value={enabled:true,mechanism:'Public tools/execute retry; first real result discarded'};}
      else if(input.action==='failWriter'){failWriter=input.enabled===true;value={failWriter};}
      else if(input.action==='prompt'){const receipt=await invoke('prompt',{sessionId:input.sessionId,requestId:input.requestId??randomUUID(),mode:'queue',content:[{type:'text',text:input.text}]},request.signal);await ctx.agents.get(input.sessionId).whenIdle();value={receipt,...await snapshot(input.sessionId)};}
      else if(input.action==='idle'){await ctx.agents.get(input.sessionId)?.whenIdle();value=await snapshot(input.sessionId);}
      else if(input.action==='routes'){const loop=ctx.get('loopStudio'),state=await loop.inspect(input.sessionId,request.signal);value=await loop.savePolicy({sessionId:input.sessionId,scope:'session',expectedRevision:state.revision,policy:{enabled:true,routes:{'rp-last-step.assemble':{provider:'gm-native-local',model:'assembly'},'rp-last-step.render':{provider:'gm-native-local',model:'writer'}}}},request.signal);}
      else if(input.action==='resume'){const handle=await ctx.agents.resume({resumeSessionId:input.sessionId,agentOptions:{provider:'gm-native-local',model:'gm'},setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'rp-gm');}});disposers.push(()=>handle.dispose());value=await snapshot(input.sessionId);}
      else if(input.action==='flush'){await ctx.sessionPersistence.flush();value={flushed:true};}
      else if(input.action==='material')value=await ctx.get('rpLastStep').material({sessionId:input.sessionId,presentationId:input.presentationId,signal:request.signal});
      else if(input.action==='summaries')value=await ctx.get('rpLastStep').presentationSummaries({sessionId:input.sessionId,signal:request.signal});
      else if(input.action==='retryLast'){const operation=await ctx.get('rpLastStep').retryPresentation({sessionId:input.sessionId,presentationId:input.presentationId,signal:request.signal});await ctx.agents.get(input.sessionId)?.whenIdle();value={operation,...await snapshot(input.sessionId)};}
      else if(input.action==='profileState'){const state=await ctx.get('rpLastStep').state(input.sessionId,request.signal);value={revision:state.revision,binding:state.binding,profiles:state.profiles,aggregate:await ctx.get('rpLastStep').contentRevision({signal:request.signal})};}
      else if(input.action==='style'){if(!['b','c'].includes(input.variant))throw Error('Unknown reviewed synthetic style');const last=ctx.get('rpLastStep'),profile=await last.ensureBuiltinProfile({key:`dsh-rp-gm.native-style.${input.variant}.v1`,profile:{name:`Native style ${input.variant.toUpperCase()}`,entries:[{id:'style',name:'Reviewed native style',role:'system',order:0,enabled:true,phase:'render',required:true,locked:true,content:`STYLE_${input.variant.toUpperCase()}: 使用简洁中文，严格保留已经提交的公开事实与玩家控制。`}]}}),before=await last.state(input.sessionId,request.signal);await last.bindSession({sessionId:input.sessionId,...profile,expectedRevision:before.revision},request.signal);value={profile,binding:(await last.state(input.sessionId,request.signal)).binding,initial:(await ctx.get('rpGM').binding({sessionId:input.sessionId})).profile};}
      else if(input.action==='receipt')value=await (await ctx.get('rpDatabase').factAccess({sessionId:input.sessionId,agent:ctx.agents.get(input.sessionId),signal:request.signal})).getReceipt(input.receiptId);
      else if(input.action==='exportGM')value=await ctx.get('rpGM').exportState({sessionIds:input.sessionIds,signal:request.signal});
      else if(input.action==='preflightGM')value=await ctx.get('rpGM').preflightRestore({sessionIds:input.sessionIds,state:input.state,signal:request.signal});
      else if(input.action==='restoreGM')value=await ctx.get('rpGM').restoreState({restoreId:input.restoreId,sessionIds:input.sessionIds,state:input.state,expectedRevision:input.expectedRevision,signal:request.signal});
      else if(input.action==='captureOwners')value=await capture(input.sessionIds,request.signal);
      else if(input.action==='preflightOwners'){value={};for(const [key,service]of [['database','rpDatabase'],['lastStep','rpLastStep'],['gm','rpGM']])value[key]=await ctx.get(service).preflightRestore({sessionIds:input.sessionIds,state:input.states[key],signal:request.signal});}
      else if(input.action==='reserveRestore')value=await ctx.get('rpGM').reserveRestore({restoreId:input.restoreId,sessionIds:input.sessionIds,signal:request.signal});
      else if(input.action==='importExact'){
        // Only this test coordinator transports original public records. Product GM never appends history.
        const {header,events,inheritedEventCount}=input.session;if(!Number.isSafeInteger(inheritedEventCount)||inheritedEventCount<0||inheritedEventCount>events.length)throw Error('Missing authoritative inheritedEventCount');
        const handle=await ctx.sessionPersistence.create(header,{inheritedEventCount});try{await handle.append(events);await handle.flush();}finally{await handle.close();}value=await snapshot(header.id);
      }
      else if(input.action==='restoreOwner'){
        const services={database:'rpDatabase',lastStep:'rpLastStep',gm:'rpGM'},owner=ctx.get(services[input.owner]);if(!owner)throw Error('Unknown fixture owner');const before=await owner.contentRevision({signal:request.signal});value=await owner.restoreState({restoreId:input.restoreId,sessionIds:input.sessionIds,state:input.state,expectedRevision:input.expectedRevision??before.revision,signal:request.signal});
      }
      else if(input.action==='activateRestore')value=await ctx.get('rpGM').activateRestored({restoreId:input.restoreId,sessionIds:input.sessionIds,signal:request.signal});
      else if(input.action==='restoreRoute'){const loop=ctx.get('loopStudio'),before=await loop.inspect(input.sessionId,request.signal);value=await loop.savePolicy({sessionId:input.sessionId,scope:'session',policy:input.policy,expectedRevision:before.revision},request.signal);}
      else if(input.action==='forkGM')value=await ctx.get('rpGM').forkStory({sessionId:input.sessionId,...input.atSeq===undefined?{}:{atSeq:input.atSeq},signal:request.signal});
      else if(input.action==='rollbackGM')value=await ctx.get('rpGM').rollbackStory({sessionId:input.sessionId,signal:request.signal});
      else if(input.action==='unloadGM'){await ctx.get('rpGM').close();const agent=ctx.agents.get(input.sessionId);value={presets:(await ctx.agentPresets.list()).filter(item=>item.id==='rp-gm'),tools:Object.fromEntries(['rp_gm_state','rp_begin_story','rp_commit_turn'].map(name=>[name,ctx.tools.get(name,agent)!==undefined]))};}
      else if(input.action==='sdkTools'){const require=createRequire(process.argv[1]),base=dirname(require.resolve('@deepseek-ai/dsh-tools/package.json')),manifest=JSON.parse(await readFile(join(base,'package.json'),'utf8')),files={};for(const file of new Set(['README.md',manifest.types,'types/index.d.ts','lib/index.d.ts'].filter(Boolean)))try{files[file]=await readFile(join(base,file),'utf8');}catch{/* Only published public SDK documentation is requested. */}const entry=require.resolve('@deepseek-ai/dsh-tools');value={name:manifest.name,version:manifest.version,files,entry:await readFile(entry,'utf8')};}
      else throw Error('Unknown isolated harness action');
      return Response.json({ok:true,value});
    }catch(error){return Response.json({ok:false,error:{code:error.code,message:error.message,stack:error.stack}},{status:500});}
  }}));
  ctx.effect(()=>async()=>{for(const dispose of disposers.splice(0).reverse())await dispose();},'GM isolated native fixture');
}
