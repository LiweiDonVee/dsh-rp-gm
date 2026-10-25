import {clone,entryKey,fail,readState,requestFingerprint,text} from './core.mjs';
import {acceptedFactPresentations} from './session.mjs';
import {validateInitialSources} from './sources.mjs';
import {rollbackBoundary} from './rollback.mjs';import {isDeepStrictEqual} from 'node:util';

function restoreInput(input){text(input.restoreId,'Restore ID');if(!Array.isArray(input.sessionIds)||!input.sessionIds.length||new Set(input.sessionIds).size!==input.sessionIds.length||input.sessionIds.some(id=>typeof id!=='string'||!id.trim()))fail('INVALID_RESTORE','Restore requires distinct destination session IDs');return [...input.sessionIds].sort();}

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
  async function fork(input,atSeq,expected){
    await runtime.assertPlayable(input.sessionId);const current=await runtime.inspect(input),last=ctx.get('rpLastStep');
    if(typeof last?.inheritSession!=='function')fail('LAST_STEP_INHERIT_UNAVAILABLE','RP LastStep with causal child profile inheritance is required',503);
    if(atSeq!==undefined&&(!Number.isSafeInteger(atSeq)||atSeq<0))fail('INVALID_PREFIX','Fork prefix must be a nonnegative canonical sequence');
    if(expected&&(current.lastFactReceipt?.id!==expected.lastFactReceipt.id||rollbackBoundary(current.view,current.lastFactReceipt,current.record.opening?.receiptId)!==atSeq||!isDeepStrictEqual(current.view.events,expected.view.events)||!isDeepStrictEqual(current.agent.session.snapshotEvents(),current.view.events)))fail('ROLLBACK_UNAVAILABLE','Story input changed before rollback; inspect it again',409);
    const created=await ctx.typertGateway.invoke({namespace:'session',method:'fork',args:{request:{sessionId:input.sessionId,...atSeq===undefined?{}:{atSeq}}},peer:ctx.connection.browserPeer,signal:input.signal});
    const child=await readSession(created.sessionId,input.signal);if(child?.header.parentSession!==input.sessionId)fail('INVALID_ANCESTRY','Host did not return the requested child ancestry',409);
    await store.inherit(input.sessionId,created.sessionId);
    try{
      await database().effectiveV2({sessionId:created.sessionId,signal:input.signal});await last.inheritSession({parentSessionId:input.sessionId,sessionId:created.sessionId,signal:input.signal});
      const context=ctx.get('rpContext');if(context?.state)await context.state({sessionId:created.sessionId,signal:input.signal});
      await store.setStatus(created.sessionId,'starting');const record=await runtime.refresh(created.sessionId,ctx.agents.get(created.sessionId),input.signal);notify(created.sessionId);return {sessionId:created.sessionId,binding:clone(record.binding)};
    }catch(error){await store.setStatus(created.sessionId,'restoring');throw error;}
  }
  return {
    forkStory:input=>fork(input,input.atSeq),
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
        if(activeProfile.profile?.status!=='ready'||activeProfile.profile.id!==binding.profileId||activeProfile.profile.version!==binding.version||ctx.tools.get('run_code',agent)!==undefined||typeof last.isEnabled==='function'&&!last.isEnabled(id))fail('RESTORE_INCOMPLETE','Current presentation style or native admission is unavailable',409);
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
