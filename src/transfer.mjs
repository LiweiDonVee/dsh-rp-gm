import {isDeepStrictEqual} from 'node:util';
import {clone,entryKey,fail,readState,requestFingerprint} from './core.mjs';
import {acceptedFactPresentations,projectSession} from './session.mjs';
import {envelope,normalizeState,sessionIds} from './transfer-schema.mjs';
import {validateInitialSources} from './sources.mjs';
import {needsReviewOwners,verifyReviewSources} from './review-transfer.mjs';

const required=message=>fail('RESTORE_REQUIREMENT_MISSING',message,409);
const invalid=message=>fail('RESTORE_PAYLOAD_INVALID',message,400);
const sameRefs=(left,right)=>requestFingerprint(left.map(entryKey).sort())===requestFingerprint(right.map(entryKey).sort());
function sourceIdentity(snapshot){const header=clone(snapshot.header);if(header.delegationDepth===undefined)header.delegationDepth=0;return {header,events:[...snapshot.events].sort((a,b)=>a.seq-b.seq)};}
function validateOpeningSource(record,view,views){
  if(!record.opening)return;const source=record.opening.source,assistant=view.events.find(event=>event.type==='assistant/message'&&event.data?.message?.id===source.assistantMessageId);
  const call=view.events.find(event=>event.type==='tool/call'&&event.data?.name==='rp_begin_story'&&event.data.callId===source.callId&&event.data.turn===assistant?.data.turn&&event.data.step===assistant?.data.step);
  if(!assistant||!call||source.callSeq!==undefined&&call.seq!==source.callSeq||!assistant.data.message.content?.some(block=>block.type==='tool-call'&&block.name==='rp_begin_story'&&block.id===source.callId))invalid('Opening source is not a real canonical GM call');
  const start=view.events.find(event=>event.seq===source.turnStartSeq&&event.type==='turn/start');if(!start||start.data?.turn!==call.data.turn||start.seq>=assistant.seq||assistant.seq>=call.seq)invalid('Opening source is outside its canonical turn');
  const [origin]=JSON.parse(record.opening.turnKey);let cursor=record.binding.sessionId;const seen=new Set();
  while(cursor!==origin&&!seen.has(cursor)){seen.add(cursor);cursor=views.get(cursor)?.header.parentSession;}
  if(cursor!==origin)invalid('Opening source does not belong to this Session ancestry');
}
export function createGmTransfer({ctx,store,readSession,notify,factOperationLive}){
  function requirements(state){const missing=[];const db=ctx.get('rpDatabase'),last=ctx.get('rpLastStep');if(db?.apiVersion!==2||typeof db.effectiveV2!=='function')missing.push('rpDatabase.apiVersion=2');if(!last||['profile','state','narratives'].some(key=>typeof last[key]!=='function'))missing.push('rpLastStep');if(state&&needsReviewOwners(state)){if(db?.capabilities?.factReview!==1||typeof db.factReviewState!=='function')missing.push('rpDatabase.capabilities.factReview=1');if(last?.capabilities?.narrativeRevisions!==1||typeof last.presentFact!=='function')missing.push('rpLastStep.capabilities.narrativeRevisions=1');}return missing;}
  function notGenerating(ids){if(ids.some(id=>ctx.agents.get(id)?.status==='running'||factOperationLive?.(id)))fail('EXPORT_CHANGED','A selected story is generating; retry its snapshot when idle',409);}
  async function available(state,ids,signal){
    const missing=requirements(state);if(missing.length)required(`Required owner services are missing: ${missing.join(', ')}`);
    const views=new Map(),sources=new Map();
    for(const id of ids){signal?.throwIfAborted();const observed=await readSession(id,signal);if(!observed)required(`Canonical destination Session is missing: ${id}`);if(observed.header?.id!==id||observed.header.agentPreset!=='rp-gm')invalid('Session identity or generic preset does not match GM metadata');sources.set(id,clone(observed));views.set(id,projectSession(observed));}
    for(const record of state.payload.bindings){
      signal?.throwIfAborted();const {binding}=record,view=views.get(binding.sessionId);
      if((view.header.parentSession??undefined)!==(record.parentSessionId??undefined))invalid('GM binding ancestry does not match canonical Session header');validateOpeningSource(record,view,views);
      await verifyReviewSources(record,view,ctx.get('rpDatabase'),signal);
      let database,profile,presentation;try{database=await ctx.get('rpDatabase').effectiveV2({sessionId:binding.sessionId,signal});profile=await ctx.get('rpLastStep').profile(binding.profile,signal);presentation=await ctx.get('rpLastStep').state(binding.sessionId,signal);}catch(error){if(['NOT_BOUND','NOT_FOUND','SESSION_NOT_FOUND','PROFILE_NOT_FOUND','BINDING_NOT_FOUND'].includes(error.code))required('Required Database or presentation state has not been restored');throw error;}
      if(database.binding?.schemaVersion!==2||!sameRefs(database.binding.factEntryRefs??[],binding.factEntryRefs))invalid('Database fact binding does not match GM registered references');
      await validateInitialSources(ctx.get('rpDatabase'),binding.sources,signal);
      const keys=new Set(database.entries.map(entry=>entryKey(entry.ref)));if(binding.factEntryRefs.some(ref=>!keys.has(entryKey(ref))))required('A registered GM state entry is missing');readState(database);
      if(profile.profile?.id!==binding.profile.profileId||profile.profile.version!==binding.profile.version)required('Initial launch style provenance is unavailable');
      const current=presentation.binding;if(typeof current?.profileId!=='string'||!Number.isSafeInteger(current.version)||current.version<1)required('Current LastStep binding is unavailable');
      let style;try{style=await ctx.get('rpLastStep').profile({profileId:current.profileId,version:current.version},signal);}catch(error){if(error.code==='PROFILE_NOT_FOUND')required('Current LastStep style has not been restored');throw error;}
      if(style.profile?.status!=='ready'||style.profile.id!==current.profileId||style.profile.version!==current.version)required('Current LastStep style is not ready');
      const narratives=await ctx.get('rpLastStep').narratives({sessionId:binding.sessionId,signal});
      for(const item of [...record.review?.decisions??[],...record.review?.presentations??[]])if(item.result?.presentation.status==='complete'&&!narratives.records.some(value=>value.factReceiptId===item.result.factReceiptId&&value.ref?.presentationId===item.result.presentation.presentationId))invalid('Completed GM writing metadata lacks its accepted canonical LastStep record');
      if(binding.status==='active'){
        const receiptId=record.opening?.receiptId;if(!receiptId||!acceptedFactPresentations(view).some(item=>item.factReceiptId===receiptId)||!narratives.records.some(item=>item.factReceiptId===receiptId))invalid('Active GM metadata lacks its accepted canonical opening');
      }
    }
    signal?.throwIfAborted();return sources;
  }
  return {
    contentRevision:()=>store.contentRevision(),
    async exportState(input){
      const ids=sessionIds(input.sessionIds);notGenerating(ids);const captured=normalizeState(await store.exportSelection(ids),ids);
      if(captured.payload.bindings.some(record=>record.binding.status==='restoring'))fail('EXPORT_CHANGED','A selected story is still restoring',409);
      const before=await available(captured,ids,input.signal);notGenerating(ids);
      for(const id of ids){const after=await readSession(id,input.signal);if(!after||!isDeepStrictEqual(sourceIdentity(before.get(id)),sourceIdentity(after)))fail('EXPORT_CHANGED','Canonical source changed during GM export',409);}
      if((await store.contentRevision()).revision!==captured.revision)fail('EXPORT_CHANGED','GM metadata changed during export',409);return clone(captured);
    },
    async preflightRestore(input){
      try{const minimal=envelope(input);normalizeState(minimal.state,minimal.sessionIds);const conflicts=await store.previewTransfer({sessionIds:minimal.sessionIds,state:minimal.state}),missing=requirements(minimal.state);return {supported:!conflicts.length&&!missing.length,conflicts,requirements:missing};}
      catch(error){if(error.code==='RESTORE_REQUIREMENT_MISSING')return {supported:false,conflicts:[],requirements:[error.requirement??error.message]};if(error.code==='RESTORE_PAYLOAD_INVALID')return {supported:false,conflicts:[{code:error.code,id:'gm'}],requirements:[]};throw error;}
    },
    async restoreState(input){const minimal=envelope(input,true),result=await store.restoreTransfer(minimal,normalized=>available(normalized,minimal.sessionIds,input.signal),input.signal);for(const id of result.restoredSessionIds)notify(id);return result;},
  };
}
