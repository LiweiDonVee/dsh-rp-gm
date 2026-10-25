import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {GmError,clone,requestFingerprint} from '../src/core.mjs';

// GM-A contracted dependency fixtures; not actual Database, LastStep or rc.3 acceptance.
export async function contractFixture(t){
  const directory=await mkdtemp(join(tmpdir(),'rp-gm-host-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const sessions=new Map(),listeners=new Map(),presets=new Map(),services=new Map(),effects=[],contexts=[],states=new Map(),profiles=new Map(),lastBindings=new Map(),prompts=new Set();
  const counts={creates:0,prompts:0,binds:0,initializes:0,factWrites:0,presetDisposals:0,profileBinds:0},faults={};let revision=0,profileRevision=0;
  const emit=async(name,...args)=>{const snapshot=(listeners.get(name)??[]).slice();for(const fn of snapshot)await fn(...args);};
  const append=(agent,type,data,surfaceOp,sourceEventSeqs)=>{const event={seq:agent.events.length,type,data,...surfaceOp?{surfaceOp}:{},...sourceEventSeqs?{sourceEventSeqs}:{}};agent.events.push(event);return event;};
  const makeAgent=(id,parentSession)=>{
    const tools=new Map(),denied=new Set(),events=[];
    const agent={id,status:'idle',events,tools,denied,session:{id,header:{id,agentPreset:'rp-gm',...parentSession?{parentSession}:{}},snapshotEvents:()=>clone(events),deriveMessages:()=>events.filter(e=>e.type==='assistant/message').map(e=>e.data.message)},ctx:{tools:{register:definition=>{tools.set(definition.name,definition);return()=>tools.delete(definition.name);},restrict:({deny})=>{for(const name of deny)denied.add(name);return()=>{for(const name of deny)denied.delete(name);};}}},whenIdle:async()=>{}};
    sessions.set(id,agent);return agent;
  };
  const ctx={get:name=>services.get(name),provide:(name,value)=>services.set(name,value),connection:{browserPeer:{principal:{kind:'owner'}}},
    agents:{get:id=>sessions.get(id),list:()=>[...sessions.values()],currentInitiator:()=>ctx.currentAgent},
    tools:{get:(name,agent)=>name==='run_code'?undefined:agent?.denied.has(name)?undefined:agent?.tools.get(name)},
    systemPrompt:{context:definition=>{contexts.push(definition);return()=>contexts.splice(contexts.indexOf(definition),1);}},
    on:(name,fn)=>{const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list);return()=>list.splice(list.indexOf(fn),1);},emit:(name,...args)=>{void emit(name,...args);},effect:fn=>effects.push(fn()),
    agentPresets:{register:async definition=>{if(presets.has(definition.id))throw Error('duplicate preset');presets.set(definition.id,clone(definition));return()=>{presets.delete(definition.id);counts.presetDisposals++;};}},
    typertGateway:{invoke:async({namespace,method,args})=>{
      if(namespace!=='session')throw Error('unsupported namespace');const request=args.request;
      if(method==='create'){let agent=sessions.get(request.sessionId);if(!agent){agent=makeAgent(request.sessionId);counts.creates++;await emit('agent/created',{agent});}if(faults.createLost){faults.createLost=false;throw new GmError('LOST_RESPONSE','Lost create response',503);}return {sessionId:agent.id,agentPreset:request.agentPreset};}
      if(method==='prompt'){const agent=sessions.get(request.sessionId);if(!states.get(agent.id)?.initialized||!lastBindings.has(agent.id))throw Error('prompt before ready');if(!prompts.has(request.requestId)){prompts.add(request.requestId);counts.prompts++;if(!agent.events.length)append(agent,'system/message',{message:{id:'head',role:'system',content:[{type:'text',text:'protected native head'}]}},'append');append(agent,'user/message',{id:randomUUID(),role:'user',source:{kind:'user-rpc',rpcId:request.requestId},content:clone(request.content)},'append');}if(faults.promptLost){faults.promptLost=false;throw new GmError('LOST_RESPONSE','Lost prompt response',503);}return {accepted:true};}
      throw Error(`unsupported ${method}`);
    }},
  };
  const db={apiVersion:2,contentRevision:async()=>({revision}),database:async({databaseId,version})=>({revision,database:{id:databaseId,version,name:'Source',entries:[]}}),
    bindSources:async input=>{const old=states.get(input.sessionId);if(old)return {revision,binding:clone(old.binding)};if(input.expectedRevision!==revision)throw new GmError('REVISION_CONFLICT','stale',409);counts.binds++;const state={binding:{schemaVersion:2,sources:clone(input.sources),factEntryRefs:[]},seed:[],changes:[],receipts:[],inactive:new Set()};states.set(input.sessionId,state);revision++;return {revision,binding:clone(state.binding)};},
    initializeStoryState:async input=>{const state=states.get(input.sessionId);if(!state)throw Error('no binding');const fingerprint=requestFingerprint({entries:input.entries,factEntryRefs:input.factEntryRefs});if(state.initialized){if(state.initialized.fingerprint!==fingerprint)throw new GmError('LAUNCH_CONFLICT','different seed',409);return clone(state.initialized.result);}if(input.expectedRevision!==revision)throw new GmError('REVISION_CONFLICT','stale',409);state.seed=input.entries.map(entry=>({...clone(entry),ref:{sourceKey:'@session',entryId:entry.id}}));state.binding.factEntryRefs=clone(input.factEntryRefs);counts.initializes++;revision++;const result={revision,factEntryRefs:clone(input.factEntryRefs)};state.initialized={launchId:input.launchId,fingerprint,result};if(faults.initializeLost){faults.initializeLost=false;throw new GmError('LOST_RESPONSE','Lost seed response',503);}return result;},
    factAccess:async({sessionId,agent})=>{if(sessions.get(sessionId)!==agent)throw new GmError('AGENT_MISMATCH','wrong owner',403);const state=states.get(sessionId);return {snapshot:async()=>({revision,binding:clone(state.binding),entries:clone(state.seed),notes:[],changes:[]}),currentReceipt:async()=>null,getReceipt:async()=>{throw new GmError('RECEIPT_NOT_FOUND','missing',404);}};},
  };
  const last={contentRevision:async()=>({revision:profileRevision}),ensureBuiltinProfile:async({key,profile})=>{if(Object.keys(profile).some(k=>!['name','entries'].includes(k)))throw Error('builtin identity injection');let found=profiles.get(key);if(!found){found={id:'builtin',name:profile.name,entries:clone(profile.entries),version:1,status:'ready',sourceId:null};profiles.set(key,found);profileRevision++;}return {profileId:found.id,version:found.version};},
    profile:async({profileId,version})=>{const profile=[...profiles.values()].find(p=>p.id===profileId&&p.version===version);if(!profile)throw new GmError('PROFILE_NOT_FOUND','missing profile',404);return {revision:profileRevision,profile:clone(profile)};},state:async id=>({revision:profileRevision,binding:clone(lastBindings.get(id)??null)}),bindSession:async input=>{lastBindings.set(input.sessionId,{profileId:input.profileId,version:input.version});counts.profileBinds++;profileRevision++;return {revision:profileRevision};},
  };
  services.set('rpDatabase',db);services.set('rpLastStep',last);
  const readSession=async id=>{const agent=sessions.get(id);return agent?{header:clone(agent.session.header),events:clone(agent.events)}:null;};
  return {ctx,directory,counts,faults,services,sessions,presets,states,profiles,lastBindings,contexts,effects,emit,append,makeAgent,readSession,options:{directory,readSession},db,last,
    getRevision:()=>revision,bumpRevision:()=>++revision,
  };
}
