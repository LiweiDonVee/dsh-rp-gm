import {isDeepStrictEqual} from 'node:util';
import {fail} from './core.mjs';import {acceptedFactPresentations} from './session.mjs';

const unavailable=()=>fail('ROLLBACK_UNAVAILABLE','The factual turn has no isolated canonical input prefix',409);

/** Public durable input lineage only. Never mutates an inbox or the original events. */
export function rollbackBoundary(view,receipt,openingReceiptId){
  const events=view.events,start=events.find(event=>event.seq===receipt?.source?.turnStartSeq&&event.type==='turn/start');
  if(receipt?.kind!=='turn'||!start)unavailable();
  const call=events.find(event=>event.type==='tool/call'&&event.data.name==='rp_commit_turn'&&event.data.callId===receipt.source.callId&&event.data.turn===start.data.turn&&(receipt.source.callSeq===undefined||event.seq===receipt.source.callSeq));
  if(!call||!events.some(event=>event.type==='assistant/message'&&event.data.message?.id===receipt.source.assistantMessageId&&event.seq>start.seq&&event.seq<call.seq))unavailable();
  const step=events.find(event=>event.type==='step/start'&&event.seq>start.seq&&event.data.turn===start.data.turn);if(!step||step.seq>=call.seq)unavailable();
  const end=events.find(event=>event.type==='turn/end'&&event.seq>start.seq&&event.data.turn===start.data.turn),limit=events.find(event=>event.seq>step.seq&&(event.type==='step/end'&&event.data.turn===step.data.turn&&event.data.step===step.data.step||event.type==='step/start'||event.type==='turn/end'))?.seq??Infinity;
  const queues={'next-turn':[],'next-step':[]},instances=new Set(),claims=[],closedEmpty=[];let open;
  for(const event of events){
    if(event.type==='turn/start')open=event.data.turn;
    if(event.type==='agent/inbox/spliced'){
      const data=event.data,queue=queues[data.target],count=data.removedCount??0;
      if(!queue||!Number.isSafeInteger(data.start)||data.start<0||!Number.isSafeInteger(count)||count<0||data.start+count>queue.length||!Array.isArray(data.inserted))unavailable();
      const removed=queue.slice(data.start,data.start+count),byId=new Map(removed.map(instance=>[instance.message.id,instance]));
      const inserted=data.inserted.map(message=>{if(typeof message?.id!=='string'||!message.id)unavailable();const instance=byId.get(message.id)??{enqueueSeq:event.seq};instance.message=message;instances.add(instance);return instance;});
      queue.splice(data.start,count,...inserted);
      const pending=[...queues['next-turn'],...queues['next-step']];if(new Set(pending.map(instance=>instance.message.id)).size!==pending.length)unavailable();
      if(event.seq>start.seq&&event.seq<step.seq&&count>0&&!data.inserted.length&&data.outcome===undefined)claims.push(...removed);
    }
    if(event.type==='turn/end')open=undefined;
    if(open===undefined&&!queues['next-turn'].length&&!queues['next-step'].length)closedEmpty.push(event.seq);
  }
  if(!claims.length||new Set(claims.map(instance=>instance.message.id)).size!==claims.length)unavailable();
  for(const instance of claims){const matches=events.filter(event=>event.type==='user/message'&&event.seq>step.seq&&event.seq<limit&&event.data.id===instance.message.id);if(matches.length!==1||!isDeepStrictEqual(matches[0].data.source,instance.message.source))unavailable();}
  const enqueue=Math.min(...claims.map(instance=>instance.enqueueSeq)),cut=closedEmpty.findLast(seq=>seq<enqueue&&seq<start.seq),priorEnd=events.findLast(event=>event.type==='turn/end'&&event.seq<start.seq)?.seq;
  if(cut===undefined||priorEnd===undefined||cut<priorEnd||!events.some(event=>event.type==='system/message'&&event.surfaceOp==='append'&&event.seq<=cut)||!acceptedFactPresentations(view).some(item=>item.factReceiptId===openingReceiptId&&item.result.seq<=cut))unavailable();
  if([...instances].some(instance=>instance.enqueueSeq>cut&&instance.enqueueSeq<start.seq&&!claims.includes(instance)))unavailable();
  if([...queues['next-turn'],...queues['next-step']].some(instance=>!claims.includes(instance)&&(instance.enqueueSeq<start.seq||instance.enqueueSeq>(end?.seq??Infinity))))unavailable();
  return cut;
}
