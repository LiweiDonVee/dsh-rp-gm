import {clone,entryKey,fail,object,readState,requestFingerprint,text} from './core.mjs';
import {acceptedFactPresentations} from './session.mjs';
import {validateInitialSources} from './sources.mjs';
import {rollbackBoundary} from './rollback.mjs';import {isDeepStrictEqual} from 'node:util';
import {usesNativeTools} from './native-tools.mjs';
import {verifyInheritedPrefix} from './lineage.mjs';

function restoreInput(input){text(input.restoreId,'Restore ID');if(!Array.isArray(input.sessionIds)||!input.sessionIds.length||new Set(input.sessionIds).size!==input.sessionIds.length||input.sessionIds.some(id=>typeof id!=='string'||!id.trim()))fail('INVALID_RESTORE','Restore requires distinct destination session IDs');return [...input.sessionIds].sort();}

const narrativeFields=['sessionId','presentationId','assistantMessageId','callSeq','baseResultSeq','resultSeq'];
const sameNarrativeRef=(left,right)=>Boolean(left&&right&&narrativeFields.every(key=>left[key]===right[key]));
function readingRef(input){const ref=input.basedOn;if(!object(ref)||Object.keys(ref).length!==narrativeFields.length||!narrativeFields.every(key=>key.endsWith('Seq')?Number.isSafeInteger(ref[key])&&ref[key]>=0:typeof ref[key]==='string'&&ref[key].length>0)||ref.sessionId!==input.sessionId)fail('INVALID_NARRATIVE_REF','A complete narrative reference for this story is required');return clone(ref);}

/** Follow physical turns: an adopted result may still carry its original turn number. */
function readingBoundary(view,narrative,receipt){
  const events=view.events,start=events.find(event=>event.seq===receipt.source?.turnStartSeq&&event.type==='turn/start');
  const unavailable=(message,blockingSeq)=>fail('READING_FORK_UNAVAILABLE',message,409,{factReceiptId:receipt.id,turnStartSeq:receipt.source?.turnStartSeq,resultSeq:narrative.ref.resultSeq,...blockingSeq===undefined?{}:{blockingSeq}});
  const call=events.find(event=>event.type==='tool/call'&&event.data.callId===receipt.source?.callId&&(receipt.source.callSeq===undefined||event.seq===receipt.source.callSeq));
  if(!start||!call||call.data.turn!==start.data.turn||!['rp_begin_story','rp_commit_turn','rp_propose_turn'].includes(call.data.name)||!events.some(event=>event.type==='assistant/message'&&event.data.message?.id===receipt.source.assistantMessageId&&event.seq>start.seq&&event.seq<call.seq))unavailable('The selected reading has no canonical factual turn');
  const result=events.find(event=>event.seq===narrative.ref.resultSeq),base=events.find(event=>event.seq===narrative.ref.baseResultSeq);
  if(result?.type!=='tool/result'||base?.data.meta?.rpLastStep?.record?.id!==narrative.ref.presentationId||narrative.ref.resultSeq<call.seq)unavailable('The selected reading has no canonical result prefix');
  const decision=receipt.decisionSource,settled=decision?events.find(event=>event.seq===decision.doneSeq&&event.type==='command/done'&&event.data.commandId===decision.commandId&&event.data.kind==='success'):undefined;
  if(decision&&!settled)unavailable('The selected facts have no confirmed native decision');
  const minimum=Math.max(narrative.ref.resultSeq,settled?.seq??call.seq),queues={'next-turn':[],'next-step':[]};
  const owner=message=>message?.source?.kind==='rp-last-step-owner'&&['adopt','retry','presentFact','regenerateProse'].includes(message.source.operation);
  let open,naturalEnd=-1,closed=false;
  for(const event of events){
    if(event.type==='turn/start')open={seq:event.seq,turn:event.data.turn,managed:false};
    if(event.type==='agent/inbox/spliced'){
      const data=event.data,queue=queues[data.target],count=data.removedCount??0;
      if(!queue||!Number.isSafeInteger(data.start)||data.start<0||!Number.isSafeInteger(count)||count<0||data.start+count>queue.length||!Array.isArray(data.inserted))unavailable('The native inbox history cannot isolate this reading',event.seq);
      const removed=queue.splice(data.start,count,...data.inserted);
      if(open?.seq>start.seq&&removed.length&&data.outcome===undefined){if(removed.some(message=>!owner(message)))unavailable('A later player action started before the selected reading',open.seq);open.managed=true;}
    }
    if(event.seq>start.seq&&event.type==='user/message'){
      if(owner(event.data)){if(open)open.managed=true;}
      else if(['user','user-rpc'].includes(event.data.source?.kind)&&(open?.seq!==start.seq||event.seq>call.seq))unavailable('A later player action started before the selected reading',event.seq);
    }
    if(event.seq>start.seq&&event.type==='tool/call'&&open?.seq!==start.seq&&event.data.name!=='rp_present')unavailable('Later factual or tool work precedes the selected reading',event.seq);
    if(event.type==='turn/end'){
      if(open?.seq===start.seq){if(event.data.reason?.kind==='forked')unavailable('A host fork closer is not a completed factual turn',event.seq);closed=true;}
      else if(open?.seq>start.seq&&!open.managed)unavailable('A later turn is not an isolated RP reading operation',open.seq);
      if(open?.turn===event.data.turn&&event.data.reason?.kind!=='forked')naturalEnd=event.seq;open=undefined;
    }
    if(closed&&!open&&naturalEnd>=minimum&&!queues['next-turn'].length&&!queues['next-step'].length)return event.seq;
  }
  unavailable('The selected reading has no naturally closed empty-inbox prefix');
}

export function createStoryBranches({ctx,store,runtime,database,readSession,notify}){
  async function receiptProof(current,snapshot,record,sessionId){
    const latest=current.lastFactReceipt,ids=new Set([record.lastReceiptId,record.opening?.receiptId,latest?.id].filter(Boolean)),refs=record.binding.factEntryRefs.map(entryKey).sort(),entries=new Map(snapshot.entries.map(entry=>[entryKey(entry.ref),entry]));
    for(const receiptId of ids){let receipt;try{receipt=await current.access.getReceipt(receiptId);}catch(error){
      const optionalHint=receiptId===record.lastReceiptId&&receiptId!==latest?.id&&receiptId!==record.opening?.receiptId;
      if(error.code==='INACTIVE_SOURCE'&&receiptId!==latest?.id||optionalHint&&error.code==='RECEIPT_NOT_FOUND')continue;
      if(['INACTIVE_SOURCE','RECEIPT_NOT_FOUND'].includes(error.code))fail('RESTORE_INCOMPLETE','Restored factual receipt is unavailable or inactive',409);throw error;}
      if(receipt.sessionId!==sessionId||!['opening','turn'].includes(receipt.kind)||!Array.isArray(receipt.stateRefs)||requestFingerprint(receipt.stateRefs.map(entryKey).sort())!==requestFingerprint(refs)||receipt.stateRefs.some(ref=>!Number.isSafeInteger(ref.version)||ref.version<1))fail('RESTORE_INCOMPLETE','Restored factual receipt ownership or state refs are invalid',409);
      if(receipt.id===latest?.id&&receipt.stateRefs.some(ref=>entries.get(entryKey(ref))?.version!==ref.version))fail('RESTORE_INCOMPLETE','Latest factual receipt does not match active state versions',409);
    }
    return latest;
  }
  async function fork(input,atSeq,expected,fromReading=false){
    await runtime.assertPlayable(input.sessionId);const current=await runtime.inspect(input),last=ctx.get('rpLastStep');
    if(typeof last?.inheritSession!=='function')fail('LAST_STEP_INHERIT_UNAVAILABLE','RP LastStep with causal child profile inheritance is required',503);
    let reading;
    if(fromReading){
      const basedOn=readingRef(input);
      if(typeof last.storyHistory!=='function')fail('LAST_STEP_HISTORY_UNAVAILABLE','RP LastStep effective story history is required',503);
      const history=await last.storyHistory({sessionId:input.sessionId,agent:current.agent,signal:input.signal}),selected=history.records.find(record=>sameNarrativeRef(record.ref,basedOn));
      if(!selected||typeof selected.factReceiptId!=='string')fail('NARRATIVE_CONFLICT','The selected reference is not a current formal story reading',409);
      const receipt=await current.access.getReceipt(selected.factReceiptId);
      if(receipt.sessionId!==input.sessionId)fail('RECEIPT_NOT_FOUND','The selected facts are unavailable in this story',404);
      atSeq=readingBoundary(current.view,selected,receipt);reading={basedOn,selected:clone(selected),receipt};
    }
    if(atSeq!==undefined&&(!Number.isSafeInteger(atSeq)||atSeq<0))fail('INVALID_PREFIX','Fork prefix must be a nonnegative canonical sequence');
    if(expected&&(current.lastFactReceipt?.id!==expected.lastFactReceipt.id||rollbackBoundary(current.view,current.lastFactReceipt,current.record.opening?.receiptId)!==atSeq||!isDeepStrictEqual(current.view.events,expected.view.events)||!isDeepStrictEqual(current.agent.session.snapshotEvents(),current.view.events)))fail('ROLLBACK_UNAVAILABLE','Story input changed before rollback; inspect it again',409);
    const source=await ctx.sessionQuery.observeSession(input.sessionId,{projectionMode:'none',signal:input.signal});let sourceEvents;
    try{if(source.header.id!==input.sessionId||!isDeepStrictEqual(source.events,current.view.events))fail('EXPORT_CHANGED','Story input changed before the fork request',409);sourceEvents=clone(source.events);}
    finally{source[Symbol.dispose]();}
    const created=await ctx.typertGateway.invoke({namespace:'session',method:'fork',args:{request:{sessionId:input.sessionId,...atSeq===undefined?{}:{atSeq}}},peer:ctx.connection.browserPeer,signal:input.signal});
    const child=await readSession(created.sessionId,input.signal);
    if(!child||child.header.id!==created.sessionId||child.header.parentSession!==undefined&&child.header.parentSession!==input.sessionId)fail('INVALID_ANCESTRY','Host returned a conflicting child identity',409);
    const observed=await ctx.sessionQuery.observeSession(created.sessionId,{projectionMode:'none',signal:input.signal});
    try{
      if(observed.header.id!==created.sessionId)fail('INVALID_ANCESTRY','Host returned a different observed child',409);
      const count=verifyInheritedPrefix({header:observed.header,events:observed.events,inheritedEventCount:observed.inheritedEventCount},{events:sourceEvents});
      if(atSeq!==undefined&&count!==atSeq+1)fail('INVALID_ANCESTRY','Host did not preserve the requested exact fork prefix',409);
    }finally{observed[Symbol.dispose]();}
    await store.inherit(input.sessionId,created.sessionId);
    try{
      await database().effectiveV2({sessionId:created.sessionId,signal:input.signal});await last.inheritSession({parentSessionId:input.sessionId,sessionId:created.sessionId,signal:input.signal});
      const context=ctx.get('rpContext');if(context?.state)await context.state({sessionId:created.sessionId,signal:input.signal});
      await store.setStatus(created.sessionId,'starting');const record=await runtime.refresh(created.sessionId,ctx.agents.get(created.sessionId),input.signal);
      if(reading){
        const inherited=await runtime.inspect({sessionId:created.sessionId,signal:input.signal}),branchRef={...reading.basedOn,sessionId:created.sessionId};
        const history=await last.storyHistory({sessionId:created.sessionId,agent:inherited.agent,signal:input.signal}),selected=history.records.find(item=>sameNarrativeRef(item.ref,branchRef)),receipt=await inherited.access.getReceipt(reading.receipt.id);
        if(!selected||selected.factReceiptId!==reading.receipt.id||selected.text!==reading.selected.text||receipt.sessionId!==created.sessionId||inherited.lastFactReceipt?.id!==reading.receipt.id||readingBoundary(inherited.view,selected,receipt)!==atSeq)fail('INVALID_ANCESTRY','The child did not retain the selected reading and factual boundary',409);
        notify(created.sessionId);return {sessionId:created.sessionId,binding:clone(record.binding),parentSessionId:input.sessionId,basedOn:reading.basedOn,branchRef};
      }
      notify(created.sessionId);return {sessionId:created.sessionId,binding:clone(record.binding)};
    }catch(error){await store.setStatus(created.sessionId,'restoring');throw error;}
  }
  return {
    forkStory:input=>fork(input,input.atSeq),
    forkStoryAtReading:input=>fork(input,undefined,undefined,true),
    async rollbackStory(input){
      await runtime.assertPlayable(input.sessionId);const current=await runtime.inspect(input),receipt=current.lastFactReceipt;
      const atSeq=rollbackBoundary(current.view,receipt,current.record.opening?.receiptId);
      return fork(input,atSeq,current);
    },
    async reserveRestore(input){const ids=restoreInput(input);await store.reserveRestore(input.restoreId,ids);for(const id of ids)notify(id);return {restoreId:input.restoreId,sessionIds:ids};},
    async activateRestored(input){
      const ids=restoreInput(input),job=await store.restoreJob(input.restoreId);if(!job||requestFingerprint(job.sessionIds)!==requestFingerprint(ids))fail('RESTORE_ID_CONFLICT','Restore job does not own this destination set',409);
      if(job.complete)return {restoreId:input.restoreId,sessionIds:ids};
      const last=ctx.get('rpLastStep');if(!last?.profile||!last.state)fail('LAST_STEP_UNAVAILABLE','Required presentation state is unavailable',503);
      for(const id of ids){
        const gate=await store.gate(id);if(gate?.restoreId!==input.restoreId)fail('RESTORE_ID_CONFLICT','Restore job does not own this destination',409);
        const record=await store.binding(id),agent=ctx.agents.get(id);if(!record||record.binding.status!=='restoring'||!agent||agent.session.header?.agentPreset!=='rp-gm')fail('RESTORE_INCOMPLETE','Restoring binding and safe native Agent setup are required',409);
        const current=await runtime.inspect({sessionId:id,agent,signal:input.signal}),snapshot=await current.access.snapshot();readState(snapshot);
        if(snapshot.binding?.schemaVersion!==2||requestFingerprint((snapshot.binding.factEntryRefs??[]).map(entryKey).sort())!==requestFingerprint(record.binding.factEntryRefs.map(entryKey).sort()))fail('RESTORE_INCOMPLETE','Restored Database fact binding does not match registered story references',409);
        await validateInitialSources(database(),record.binding.sources,input.signal);
        const initial=await last.profile(record.binding.profile,input.signal),binding=(await last.state(id,input.signal)).binding;
        if(initial.profile?.id!==record.binding.profile.profileId||initial.profile.version!==record.binding.profile.version)fail('RESTORE_INCOMPLETE','Initial launch style provenance is unavailable',409);
        if(typeof binding?.profileId!=='string'||!Number.isSafeInteger(binding.version)||binding.version<1)fail('RESTORE_INCOMPLETE','Current presentation binding is unavailable',409);
        const activeProfile=await last.profile({profileId:binding.profileId,version:binding.version},input.signal);
        if(activeProfile.profile?.status!=='ready'||activeProfile.profile.id!==binding.profileId||activeProfile.profile.version!==binding.version||!usesNativeTools(ctx,agent)||typeof last.isEnabled==='function'&&!last.isEnabled(id))fail('RESTORE_INCOMPLETE','Current presentation style or native admission is unavailable',409);
        const latest=await receiptProof(current,snapshot,record,id);
        if(gate.priorStatus==='active'){
          if(!latest)fail('RESTORE_INCOMPLETE','Active restored story requires an active factual receipt',409);
          const narratives=last.narratives?(await last.narratives({sessionId:id,agent,signal:input.signal})).records:acceptedFactPresentations(current.view);let opened=false;
          for(const narrative of narratives)if(narrative.factReceiptId){try{const receipt=await current.access.getReceipt(narrative.factReceiptId);if(receipt.kind==='opening'&&receipt.sessionId===id){opened=true;break;}}catch(error){if(!['INACTIVE_SOURCE','RECEIPT_NOT_FOUND'].includes(error.code))throw error;}}
          if(!opened)fail('RESTORE_INCOMPLETE','Active restored story requires its accepted canonical opening',409);
        }
      }
      input.signal?.throwIfAborted();await store.activateRestored(input.restoreId,ids);for(const id of ids)notify(id);return {restoreId:input.restoreId,sessionIds:ids};
    },
  };
}
