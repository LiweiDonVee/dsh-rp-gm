import {clone,entryKey,fail,readState,requestFingerprint,text} from './core.mjs';
import {acceptedFactPresentations} from './session.mjs';

function restoreInput(input){text(input.restoreId,'Restore ID');if(!Array.isArray(input.sessionIds)||!input.sessionIds.length||new Set(input.sessionIds).size!==input.sessionIds.length||input.sessionIds.some(id=>typeof id!=='string'||!id.trim()))fail('INVALID_RESTORE','Restore requires distinct destination session IDs');return [...input.sessionIds].sort();}

export function createStoryBranches({ctx,store,runtime,database,readSession,notify}){
  async function fork(input,atSeq){
    await runtime.assertPlayable(input.sessionId);await runtime.inspect(input);const last=ctx.get('rpLastStep');
    if(typeof last?.inheritSession!=='function')fail('LAST_STEP_INHERIT_UNAVAILABLE','RP LastStep with causal child profile inheritance is required',503);
    if(atSeq!==undefined&&(!Number.isSafeInteger(atSeq)||atSeq<0))fail('INVALID_PREFIX','Fork prefix must be a nonnegative canonical sequence');
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
      if(receipt?.kind!=='turn'||receipt.source.turnStartSeq<1||!current.view.events.some(event=>event.type==='system/message'&&event.seq<receipt.source.turnStartSeq))fail('ROLLBACK_UNAVAILABLE','No ordinary factual turn can be rolled back while preserving the opening',409);
      return fork(input,receipt.source.turnStartSeq-1);
    },
    async reserveRestore(input){const ids=restoreInput(input);await store.reserveRestore(input.restoreId,ids);for(const id of ids)notify(id);return {restoreId:input.restoreId,sessionIds:ids};},
    async activateRestored(input){
      const ids=restoreInput(input),job=await store.restoreJob(input.restoreId);if(!job||requestFingerprint(job.sessionIds)!==requestFingerprint(ids))fail('RESTORE_CONFLICT','Restore job does not own this destination set',409);
      if(job.complete)return {restoreId:input.restoreId,sessionIds:ids};
      const last=ctx.get('rpLastStep');if(!last?.profile||!last.state)fail('LAST_STEP_UNAVAILABLE','Required presentation state is unavailable',503);
      for(const id of ids){
        const gate=await store.gate(id);if(gate?.restoreId!==input.restoreId)fail('RESTORE_CONFLICT','Restore job does not own this destination',409);
        const record=await store.binding(id),agent=ctx.agents.get(id);if(!record||record.binding.status!=='restoring'||!agent||agent.session.header?.agentPreset!=='rp-gm')fail('RESTORE_INCOMPLETE','Restoring binding and safe native Agent setup are required',409);
        const current=await runtime.inspect({sessionId:id,agent,signal:input.signal}),snapshot=await current.access.snapshot();readState(snapshot);
        if(requestFingerprint(snapshot.binding.sources)!==requestFingerprint(record.binding.sources)||requestFingerprint(snapshot.binding.factEntryRefs.map(entryKey).sort())!==requestFingerprint(record.binding.factEntryRefs.map(entryKey).sort()))fail('RESTORE_INCOMPLETE','Restored Database binding does not match fixed story references',409);
        const profile=await last.profile(record.binding.profile,input.signal),binding=(await last.state(id,input.signal)).binding;
        if(profile.profile?.status!=='ready'||profile.profile.id!==record.binding.profile.profileId||profile.profile.version!==record.binding.profile.version||binding?.profileId!==record.binding.profile.profileId||binding.version!==record.binding.profile.version)fail('RESTORE_INCOMPLETE','Restored presentation profile is unavailable',409);
        if(gate.priorStatus==='active'){
          const narratives=last.narratives?(await last.narratives({sessionId:id,agent,signal:input.signal})).records:acceptedFactPresentations(current.view);let opened=false;
          for(const narrative of narratives)if(narrative.factReceiptId){try{const receipt=await current.access.getReceipt(narrative.factReceiptId);if(receipt.kind==='opening'&&receipt.sessionId===id){opened=true;break;}}catch(error){if(!['INACTIVE_SOURCE','RECEIPT_NOT_FOUND'].includes(error.code))throw error;}}
          if(!opened)fail('RESTORE_INCOMPLETE','Active restored story requires its accepted canonical opening',409);
        }
      }
      input.signal?.throwIfAborted();await store.activateRestored(input.restoreId,ids);for(const id of ids)notify(id);return {restoreId:input.restoreId,sessionIds:ids};
    },
  };
}
