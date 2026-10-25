import {randomUUID} from 'node:crypto';import {GmError,clone,entryKey,requestFingerprint} from '../src/core.mjs';
export function nativeFixture(f){
  const invoke=f.ctx.typertGateway.invoke;f.forks=[];f.profileInherits=[];
  f.ctx.typertGateway.invoke=async input=>{if(input.namespace!=='session'||input.method!=='fork')return invoke(input);const request=input.args.request,parent=f.sessions.get(request.sessionId),child=f.makeAgent(randomUUID(),parent.id);child.events.push(...clone(parent.events.filter(event=>request.atSeq===undefined||event.seq<=request.atSeq)));f.forks.push(clone(request));await f.emit('agent/created',{agent:child});return {sessionId:child.id};};
  f.last.inheritSession=async input=>{const child=f.sessions.get(input.sessionId);if(child.session.header.parentSession!==input.parentSessionId)throw new GmError('INVALID_ANCESTRY','not a child',403);if(!f.lastBindings.has(child.id)){f.lastBindings.set(child.id,clone(f.lastBindings.get(input.parentSessionId)));f.profileInherits.push(input.sessionId);}return {binding:clone(f.lastBindings.get(child.id))};};
  f.db.factAccess=async({sessionId,agent})=>{
    if(f.sessions.get(sessionId)!==agent)throw new GmError('AGENT_MISMATCH','wrong agent',403);
    let state=f.states.get(sessionId);if(!state){const parent=f.states.get(agent.session.header.parentSession);if(parent){state=clone(parent);state.inactive=new Set(parent.inactive);for(const receipt of state.receipts)if(!agent.events.some(event=>event.type==='assistant/message'&&event.data.message.id===receipt.source.assistantMessageId))state.inactive.add(receipt.id);f.states.set(sessionId,state);}}
    if(!state)throw new GmError('NOT_BOUND','missing state',409);
    const entries=()=>{const values=clone(state.seed);for(const change of state.changes){if(state.inactive.has(change.receiptId))continue;for(const op of change.operations){const target=values.find(e=>op.ref&&entryKey(e.ref)===entryKey(op.ref));if(op.op==='update')Object.assign(target,clone(op.patch),{version:target.version+1});else if(op.op==='add')values.push({...clone(op.entry),ref:{sourceKey:'@session',entryId:op.entry.id}});}}return values;};
    const project=value=>{const {fingerprint,...receipt}=value;void fingerprint;return {...clone(receipt),...receipt.sessionId===sessionId?{}:{originSessionId:receipt.sessionId,sessionId}};};
    const getReceipt=async id=>{const value=state.receipts.find(r=>r.id===id);if(!value)throw new GmError('RECEIPT_NOT_FOUND','missing',404);if(state.inactive.has(id))throw new GmError('INACTIVE_SOURCE','inactive',409);return project(value);};
    return {snapshot:async()=>({revision:f.getRevision(),binding:clone(state.binding),entries:entries().filter(e=>e.mode!=='disabled'),notes:[],changes:clone(state.changes)}),getReceipt,
      currentReceipt:async key=>{const value=state.receipts.find(r=>r.turnKey===key);if(value&&state.inactive.has(value.id))throw new GmError('INACTIVE_SOURCE','inactive',409);return value?project(value):null;},
      commit:async input=>{
        if(input.turnKey!==JSON.stringify([sessionId,input.source.turnStartSeq]))throw new GmError('INVALID_SOURCE','turn mismatch',403);
        const call=agent.events.find(e=>e.seq===input.source.callSeq);if(call?.type!=='tool/call'||call.data.callId!==input.source.callId||!['rp_begin_story','rp_commit_turn'].includes(call.data.name))throw new GmError('INVALID_SOURCE','not native',403);
        const payload={operations:input.operations,summary:input.summary,packet:input.packet,kind:input.kind,...input.openingText?{openingText:input.openingText}:{}};
        const previous=state.receipts.find(r=>r.turnKey===input.turnKey&&!state.inactive.has(r.id));if(previous){if(previous.fingerprint!==requestFingerprint(payload))throw new GmError('TURN_ALREADY_COMMITTED','conflict',409,{receiptId:previous.id});return project(previous);}
        if(input.expectedRevision!==f.getRevision())throw new GmError('REVISION_CONFLICT','stale',409);
        for(const op of input.operations){const target=op.ref?entries().find(e=>entryKey(e.ref)===entryKey(op.ref)):null;if(target?.readOnly||target?.mode==='disabled')throw new GmError(target.readOnly?'READ_ONLY':'DISABLED','owner policy',403);}
        const id=randomUUID(),revision=f.bumpRevision();f.counts.factWrites++;
        const receipt={schemaVersion:1,id,sessionId,turnKey:input.turnKey,source:clone(input.source),kind:input.kind,databaseRevision:revision,changeId:input.operations.length?randomUUID():null,stateRefs:state.binding.factEntryRefs.map(ref=>({...clone(ref),version:1})),summary:input.summary,packet:clone(input.packet),...input.openingText?{openingText:input.openingText}:{},createdAt:new Date().toISOString(),fingerprint:requestFingerprint(payload)};
        state.changes.push({receiptId:id,operations:clone(input.operations)});state.receipts.push(receipt);
        if(f.faults.commitLost){f.faults.commitLost=false;throw new GmError('LOST_RESPONSE','Lost fact response',503);}return project(receipt);
      },
    };
  };
  f.db.effectiveV2=async input=>(await f.db.factAccess({...input,agent:f.sessions.get(input.sessionId)})).snapshot();
  f.runTool=async(id,name,args={})=>{
    const agent=f.sessions.get(id);f.ctx.currentAgent=agent;let start=agent.events.findLast(e=>e.type==='turn/start');const end=agent.events.findLast(e=>e.type==='turn/end');if(!start||(end&&end.seq>start.seq))start=f.append(agent,'turn/start',{turn:(start?.data.turn??0)+1});
    const turn=start.data.turn,step=agent.events.filter(e=>e.type==='assistant/message'&&e.data.turn===turn).length+1,callId=randomUUID();
    f.append(agent,'assistant/message',{turn,step,message:{id:randomUUID(),role:'assistant',content:[{type:'tool-call',id:callId,name,arguments:JSON.stringify(args)}]}},'append');const call=f.append(agent,'tool/call',{turn,step,callId,name,arguments:JSON.stringify(args)});
    const definition=agent.tools.get(name);if(!definition)throw Error(`Tool unavailable: ${name}`);let ended=false;
    const result=await definition.execute(args,{agent,callId,rootCallId:callId,signal:new AbortController().signal,concludeTurn:()=>{ended=true;}});
    const meta=definition.output?.presentationMeta?.(args,result),content=definition.output?.render?.(args,result)??[{type:'text',text:JSON.stringify(result)}];
    const event=f.append(agent,'tool/result',{turn,step,message:{id:randomUUID(),role:'tool',toolCallId:callId,source:{kind:'tool',callId},content},...meta?{meta}:{}},'append',[call.seq]);await f.emit('session/event',agent.session,event);if(ended)f.append(agent,'turn/end',{turn,reason:'completed'});return result;
  };
  f.installPresenter=service=>{for(const agent of f.sessions.values())agent.ctx.tools.register({name:'rp_present',output:{render:(_args,value)=>[{type:'text',text:value.text}],presentationMeta:(_args,value)=>({rpLastStep:{schemaVersion:1,record:{...value,status:'complete'}}})},execute:async(args,exec)=>{const resolved=await service.presentation({sessionId:exec.agent.id,agent:exec.agent,factReceiptId:args.factReceiptId});if(f.faults.writer)throw new GmError('WRITER_FAILED','Fixture writer failed',503);exec.concludeTurn();return {id:randomUUID(),factReceiptId:resolved.factReceipt.id,status:'rendered',text:resolved.factReceipt.kind==='opening'?resolved.factReceipt.openingText:'林遥接过了信件。'};}});};
  f.finish=id=>{const agent=f.sessions.get(id);f.append(agent,'turn/end',{turn:agent.events.findLast(e=>e.type==='turn/start')?.data.turn,reason:'failed'});};
  return f;
}
