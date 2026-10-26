import {fail} from './core.mjs';

const messageOf=event=>event.type==='user/message'?event.data:event.data?.message;
export function projectSession(snapshot) {
  const events=[...new Map((snapshot.events??snapshot.records??[]).map(row=>row.type==='event'?row.event:row).filter(event=>Number.isSafeInteger(event?.seq)).map(event=>[event.seq,event])).values()].sort((a,b)=>a.seq-b.seq);
  const nodes=[],semantic=new Map(),bySeq=new Map(events.map(event=>[event.seq,event]));
  for(const event of events){
    if(event.surfaceOp==='append'){nodes.push(event.seq);semantic.set(event.seq,[event.seq]);continue;}
    if(event.surfaceOp?.op!=='replace')continue;
    const start=nodes.indexOf(event.surfaceOp.startSeq),end=nodes.indexOf(event.surfaceOp.endSeq);if(start<0||end<start)continue;
    const old=nodes.slice(start,end+1),preserved=messageOf(event)?.source?.kind==='compact-checkpoint'?old.flatMap(seq=>semantic.get(seq)??[seq]):[];
    semantic.set(event.seq,[...preserved,event.seq]);nodes.splice(start,end-start+1,event.seq);
  }
  const activeSeqs=new Set(nodes.flatMap(seq=>semantic.get(seq)??[seq]));
  const activeAssistantIds=events.filter(event=>activeSeqs.has(event.seq)&&event.type==='assistant/message'&&typeof event.data?.message?.id==='string').map(event=>event.data.message.id);
  return {header:snapshot.header,sessionId:snapshot.header?.id,events,visible:nodes.map(seq=>bySeq.get(seq)),activeEvents:events.filter(event=>activeSeqs.has(event.seq)),activeSeqs,activeAssistantIds};
}

export function canonicalToolResults(view,names,{includeErrors=false}={}) {
  const bySeq=new Map(view.events.map(event=>[event.seq,event]));
  function sourceCall(event,seen=new Set()) {
    if(!event||seen.has(event.seq))return null;seen.add(event.seq);
    if(event.type==='tool/call')return event;
    for(const seq of event.sourceEventSeqs??[]){const found=sourceCall(bySeq.get(seq),seen);if(found)return found;}return null;
  }
  const results=[];
  for(const result of view.activeEvents){
    const message=result.data?.message;if(result.type!=='tool/result'||!includeErrors&&message?.isError||message?.source?.kind!=='tool'||message.toolCallId!==message.source.callId)continue;
    const call=sourceCall(result);if(!call||!names.includes(call.data?.name)||call.data.callId!==message.toolCallId||call.data.turn!==result.data.turn||call.data.step!==result.data.step)continue;
    const assistant=view.events.findLast(event=>event.seq<call.seq&&event.type==='assistant/message'&&event.data?.turn===call.data.turn&&event.data?.step===call.data.step&&event.data.message?.content?.some(block=>block.type==='tool-call'&&block.id===call.data.callId&&block.name===call.data.name));
    if(!assistant||!view.activeAssistantIds.includes(assistant.data.message.id))continue;
    let args;try{args=JSON.parse(call.data.arguments);}catch{continue;}
    results.push({result,call,assistant,args});
  }
  return results;
}
export function acceptedFactPresentations(view) {
  return canonicalToolResults(view,['rp_present']).filter(({result})=>result.data.meta?.rpLastStep?.schemaVersion===1&&result.data.meta.rpLastStep.record?.status==='complete'&&typeof result.data.meta.rpLastStep.record.factReceiptId==='string').map(value=>({...value,factReceiptId:value.result.data.meta.rpLastStep.record.factReceiptId}));
}
export function canonicalSource(exec,toolName) {
  const session=exec.agent?.session;
  if(!session||typeof session.id!=='string'||typeof session.snapshotEvents!=='function'||exec.parent!==undefined||typeof exec.callId!=='string'||exec.callId!==exec.rootCallId)fail('INVALID_SOURCE','A direct native tool execution is required',403);
  const view=projectSession({header:session.header??{id:session.id},events:session.snapshotEvents()});
  const call=view.events.findLast(event=>event.type==='tool/call'&&event.data?.callId===exec.callId&&event.data?.name===toolName);
  if(!call)fail('INVALID_SOURCE','Canonical tool call is unavailable',403);
  const assistant=view.events.findLast(event=>event.seq<call.seq&&event.type==='assistant/message'&&event.data?.turn===call.data.turn&&event.data?.step===call.data.step&&event.data.message?.content?.some(block=>block.type==='tool-call'&&block.name===toolName&&block.id===exec.callId));
  if(!assistant)fail('INVALID_SOURCE','Canonical assistant does not own the tool call',403);
  if(!view.activeAssistantIds.includes(assistant.data.message.id))fail('INACTIVE_SOURCE','The factual source is no longer active',409);
  const start=view.events.findLast(event=>event.seq<assistant.seq&&event.type==='turn/start');
  if(!start||start.data?.turn!==call.data.turn||view.events.some(event=>event.type==='turn/end'&&event.seq>start.seq&&event.seq<call.seq))fail('INVALID_SOURCE','Tool call is outside its canonical turn',403);
  return {turnKey:JSON.stringify([session.id,start.seq]),source:{assistantMessageId:assistant.data.message.id,callId:exec.callId,callSeq:call.seq,turnStartSeq:start.seq}};
}

/** Captures real current-turn input/evidence, never model-authored capture fields. */
export function captureFactTurn(view,canonical,binding){
  const rows=view.events.filter(event=>event.seq>canonical.source.turnStartSeq&&event.seq<canonical.source.callSeq),player=rows.findLast(event=>event.type==='user/message');
  if(!player||typeof player.data?.id!=='string')fail('FACT_CAPTURE_UNAVAILABLE','The canonical player input is unavailable',409);
  const content=message=>(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
  const excluded=new Set(['rp_gm_state','rp_begin_story','rp_commit_turn','rp_propose_turn','rp_present']),names=[...new Set(rows.filter(event=>event.type==='tool/call'&&!excluded.has(event.data?.name)).map(event=>event.data.name))];
  const observations=canonicalToolResults(view,names,{includeErrors:true}).filter(({result,call})=>call.seq>canonical.source.turnStartSeq&&result.seq<canonical.source.callSeq).map(({result,call})=>({callSeq:call.seq,resultSeq:result.seq,toolName:call.data.name,text:content(result.data.message)}));
  return {playerInput:{seq:player.seq,messageId:player.data.id,text:content(player.data)},story:{title:binding.title,character:structuredClone(binding.character),persona:structuredClone(binding.persona),examples:binding.examples},observations};
}

/** Authenticated owner snapshot, including paged canonical history. Never appends. */
export function createSessionReader(ctx) {
  return async(sessionId,signal)=>{
    signal?.throwIfAborted();const life=new AbortController(),combined=signal?AbortSignal.any([signal,life.signal]):life.signal;let iterator;
    try{
      const stream=await ctx.typertGateway.stream({namespace:'session',method:'follow',args:{request:{address:{kind:'session',sessionId},maxMessages:100}},peer:ctx.connection.browserPeer,signal:combined});
      iterator=stream[Symbol.asyncIterator]();const first=await iterator.next(),snapshot=first.value;
      if(first.done||snapshot?.type!=='snapshot'||snapshot.header?.id!==sessionId||!Array.isArray(snapshot.records))fail('SESSION_UNAVAILABLE','Canonical session snapshot is unavailable',503);
      const events=[...snapshot.records];let page=snapshot,before=snapshot.cursor+1;
      while(page.hasMore){const next=Math.min(...page.records.map(row=>(row.type==='event'?row.event:row).seq));if(!Number.isSafeInteger(next)||next>=before)fail('SESSION_UNAVAILABLE','Canonical history did not advance',503);before=next;page=await ctx.typertGateway.invoke({namespace:'session',method:'page',args:{request:{address:{kind:'session',sessionId},throughSeq:snapshot.cursor,beforeSeq:before,maxMessages:500}},peer:ctx.connection.browserPeer,signal:combined});if(!Array.isArray(page.records))fail('SESSION_UNAVAILABLE','Canonical history is unavailable',503);events.push(...page.records);}
      return {header:snapshot.header,events:events.map(row=>row.type==='event'?row.event:row),projections:snapshot.projections};
    }catch(error){if(combined.aborted)combined.throwIfAborted();if(['session/not-found','gateway/not-found','SESSION_NOT_FOUND'].includes(error.code))return null;throw error;}
    finally{life.abort();try{await iterator?.return?.();}catch{/* Reader cleanup preserves the original result. */}}
  };
}
