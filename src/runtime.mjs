import {clone,fail,freeze,normalizeTurn,readState,stateOperations} from './core.mjs';
import {acceptedFactPresentations,canonicalSource,canonicalToolResults,captureFactTurn,projectSession} from './session.mjs';

export function createGmRuntime({ctx,store,database,bound,viewFor,notify,reviewState,factOperationLive}) {
  async function reserved(sessionId){return !!await store.gate(sessionId)||(await store.binding(sessionId))?.binding.status==='restoring';}
  async function assertPlayable(sessionId){if(await reserved(sessionId))fail('STORY_RESTORING','This story is reserved or its required state is still restoring',409);}
  async function accepted(view,agent,signal){const last=ctx.get('rpLastStep');if(typeof last?.narratives==='function'){const value=await last.narratives({sessionId:view.sessionId,agent,signal});return value.records.filter(item=>typeof item.factReceiptId==='string');}return acceptedFactPresentations(view);}
  async function scope(input){const record=await bound(input.sessionId,input.agent,input.signal);if(!record)fail('STORY_NOT_FOUND','This session is not a GM story',404);const agent=input.agent??ctx.agents.get(input.sessionId);if(!agent)fail('AGENT_REQUIRED','Open the native story session for this operation',409);if(ctx.agents.get(input.sessionId)!==agent)fail('AGENT_MISMATCH','Caller does not own this story',403);const view=projectSession(await viewFor(input.sessionId,agent,input.signal));const access=await database().factAccess({sessionId:input.sessionId,agent,signal:input.signal});return {record,agent,view,access};}
  async function latest({record,view,access}) {
    if(typeof access.latestReceipt==='function')return await access.latestReceipt()??undefined;
    const ids=new Set();if(record.lastReceiptId)ids.add(record.lastReceiptId);
    for(const {result} of canonicalToolResults(view,['rp_begin_story','rp_commit_turn']))try{const value=JSON.parse(result.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'));if(typeof value.id==='string')ids.add(value.id);}catch{/* Only this protocol's structured tool results are references. */}
    const receipts=[];
    for(const id of ids)try{receipts.push(await access.getReceipt(id));}catch(error){if(!['INACTIVE_SOURCE','RECEIPT_NOT_FOUND'].includes(error.code))throw error;}
    const starts=view.events.filter(event=>event.type==='turn/start');
    for(const start of starts){
      let receipt;try{receipt=await access.currentReceipt(JSON.stringify([view.sessionId,start.seq]));}catch(error){if(error.code==='INACTIVE_SOURCE')continue;throw error;}
      if(receipt&&!receipts.some(value=>value.id===receipt.id))receipts.push(receipt);
    }
    return receipts.sort((a,b)=>b.source.turnStartSeq-a.source.turnStartSeq||(b.source.callSeq??0)-(a.source.callSeq??0))[0];
  }
  async function refresh(sessionId,agent,signal) {
    const record=await bound(sessionId,agent,signal);if(!record)return null;
    if(await store.gate(sessionId)||record.binding.status==='restoring')return record;
    const live=agent??ctx.agents.get(sessionId),view=projectSession(await viewFor(sessionId,live,signal)),presentations=await accepted(view,live,signal);let opened=false;
    if(live&&presentations.length&&ctx.get('rpDatabase')?.apiVersion===2){const access=await database().factAccess({sessionId,agent:live,signal});for(const item of presentations){try{const receipt=await access.getReceipt(item.factReceiptId);if(receipt.kind==='opening'&&receipt.sessionId===sessionId){opened=true;if(record.opening?.receiptId!==receipt.id){record.opening=await store.opening(sessionId,{turnKey:receipt.turnKey,source:receipt.source,receiptId:receipt.id},true);}break;}}catch(error){if(!['INACTIVE_SOURCE','RECEIPT_NOT_FOUND'].includes(error.code))throw error;}}}
    else opened=record.binding.status==='active'&&presentations.some(item=>item.factReceiptId===record.opening?.receiptId);
    const status=opened?'active':['active','restoring'].includes(record.binding.status)?'restoring':record.binding.status;
    if(status!==record.binding.status){await store.setStatus(sessionId,status);record.binding.status=status;notify(sessionId);}
    return record;
  }
  async function storyState(input){
    const record=await refresh(input.sessionId,input.agent,input.signal);if(!record)fail('STORY_NOT_FOUND','Story binding is unavailable',404);
    const agent=input.agent??ctx.agents.get(input.sessionId);
    const gated=await reserved(input.sessionId),fork=typeof ctx.get('rpLastStep')?.inheritSession==='function'&&!gated;
    if(!agent){const snapshot=await database().effectiveV2({sessionId:input.sessionId,signal:input.signal});return {binding:freeze(clone(record.binding)),...readState({...snapshot,entries:snapshot.entries.filter(entry=>entry.mode!=='disabled')}),capabilities:{rollback:false,fork,autoplay:false}};}
    const current=await scope({...input,agent}),snapshot=await current.access.snapshot(),receipt=await latest(current);
    const review=!gated&&database().capabilities?.factReview===1?await reviewState?.({sessionId:input.sessionId,signal:input.signal}):undefined;
    return {binding:freeze(clone(record.binding)),...readState(snapshot),...receipt?{lastFactReceipt:freeze(clone(receipt))}:{},...review?{review}:{},capabilities:{rollback:fork&&receipt?.kind==='turn'&&receipt.source.turnStartSeq>0,fork,autoplay:false,...review?{factReview:true,factRegeneration:true}:{}}};
  }
  return {
    refresh,storyState,reserved,assertPlayable,
    inspect:async input=>{const current=await scope(input);return {...current,lastFactReceipt:await latest(current)};},
    ensure:async(agent,signal)=>{
      signal?.throwIfAborted();let record=await bound(agent.session.id,agent,signal);if(!record)return false;signal?.throwIfAborted();
      if(record.parentSessionId&&record.binding.status==='restoring'&&!await store.gate(agent.session.id)){
        const last=ctx.get('rpLastStep');if(typeof last?.inheritSession==='function'&&ctx.get('rpDatabase')?.apiVersion===2){
          await database().effectiveV2({sessionId:agent.session.id,agent,signal});signal?.throwIfAborted();await last.inheritSession({parentSessionId:record.parentSessionId,sessionId:agent.session.id,signal});
          const context=ctx.get('rpContext');if(context?.state)await context.state({sessionId:agent.session.id,agent,signal});
          signal?.throwIfAborted();await store.setStatus(agent.session.id,'starting');record=await refresh(agent.session.id,agent,signal);
        }
      }
      return !!record;
    },
    async toolState(exec){const id=exec.agent.session.id,current=await scope({sessionId:id,agent:exec.agent,signal:exec.signal}),snapshot=await current.access.snapshot(),receipt=await latest(current),source=canonicalSource(exec,'rp_gm_state'),currentReceipt=await current.access.currentReceipt(source.turnKey),review=database().capabilities?.factReview===1?await reviewState?.({sessionId:id,signal:exec.signal}):undefined;return {binding:freeze(clone((await refresh(id,exec.agent,exec.signal)).binding)),...readState(snapshot),revision:snapshot.revision,...receipt?{lastFactReceipt:receipt}:{},currentReceipt,...review?{review,authority:{factReceiptId:receipt?.id??null,factRoundId:receipt?.factRoundId??null,factRevision:receipt?.factRevision??null,pending:!!review.latestRound?.pendingCandidateId||['recorded','interrupted'].includes(review.pendingDecision?.status)||review.generation?.status==='running',historicalText:'audit; Database selected revision is authoritative'}}:{}};},
    async begin(exec){
      await assertPlayable(exec.agent.session.id);
      const id=exec.agent.session.id,current=await scope({sessionId:id,agent:exec.agent,signal:exec.signal}),canonical=canonicalSource(exec,'rp_begin_story');
      let previous=current.record.opening;
      if(previous?.receiptId)try{return await current.access.getReceipt(previous.receiptId);}catch(error){if(!['INACTIVE_SOURCE','RECEIPT_NOT_FOUND'].includes(error.code))throw error;previous=null;}
      if(previous){const recovered=await current.access.currentReceipt(previous.turnKey);if(recovered){await store.opening(id,{...previous,receiptId:recovered.id});await store.receipt(id,recovered.id);return recovered;}}
      previous=await store.opening(id,canonical,true);
      const snapshot=await current.access.snapshot();readState(snapshot);
      const binding=current.record.binding,receipt=await current.access.commit({turnKey:previous.turnKey,source:previous.source,expectedRevision:snapshot.revision,operations:[],summary:`故事开场：${binding.title}`,packet:{playerAction:'开始故事',visibleConsequences:[binding.opening.text]},kind:'opening',openingText:binding.opening.text});
      await store.opening(id,{...previous,receiptId:receipt.id});await store.receipt(id,receipt.id);notify(id);return receipt;
    },
    async commit(args,exec){
      await assertPlayable(exec.agent.session.id);
      if(factOperationLive?.(exec.agent.session.id))fail('FACT_REVIEW_PENDING','A fact review operation is still running',409);
      const input=normalizeTurn(args),id=exec.agent.session.id,record=await refresh(id,exec.agent,exec.signal);if(record?.binding.status!=='active')fail('OPENING_REQUIRED','Present the selected opening before committing a normal turn',409);
      const current=await scope({sessionId:id,agent:exec.agent,signal:exec.signal}),canonical=canonicalSource(exec,'rp_commit_turn');
      const policy=await store.review(id),feature=database().capabilities?.factReview===1;
      if(feature){const state=await database().factReviewState({sessionId:id,signal:exec.signal});if(state.rounds.some(round=>round.pendingCandidateId)||state.decisions.some(value=>['recorded','interrupted'].includes(value.status)))fail('FACT_REVIEW_PENDING','Resolve the pending fact review before starting another round',409);}
      if(policy.enabled)fail(feature?'FACT_APPROVAL_REQUIRED':'FACT_REVIEW_UNAVAILABLE',feature?'Submit rp_propose_turn as the sole terminal call for owner review':'Install Database with fact review support',409);
      const receipt=await current.access.commit({...canonical,expectedRevision:input.expectedRevision,operations:stateOperations(input,record.binding.factEntryRefs),summary:input.summary,packet:clone(input.packet),kind:'turn',...feature?{capture:captureFactTurn(current.view,canonical,record.binding)}:{}});
      await store.receipt(id,receipt.id);notify(id);return receipt;
    },
    async propose(args,exec){
      await assertPlayable(exec.agent.session.id);const input=normalizeTurn(args),id=exec.agent.session.id,record=await refresh(id,exec.agent,exec.signal);
      if(factOperationLive?.(id))fail('FACT_REVIEW_PENDING','A fact review operation is still running',409);
      if(record?.binding.status!=='active')fail('OPENING_REQUIRED','Present the selected opening before proposing a normal turn',409);
      const current=await scope({sessionId:id,agent:exec.agent,signal:exec.signal}),canonical=canonicalSource(exec,'rp_propose_turn'),assistant=current.view.events.find(event=>event.type==='assistant/message'&&event.data.message.id===canonical.source.assistantMessageId),calls=assistant.data.message.content.filter(block=>block.type==='tool-call');
      if(calls.length!==1||typeof exec.concludeTurn!=='function')fail('SOLE_TERMINAL_REQUIRED','rp_propose_turn must be the sole direct terminal call',409);
      if(database().capabilities?.factReview!==1||typeof current.access.propose!=='function')fail('FACT_REVIEW_UNAVAILABLE','Install Database with fact review support',503);
      const state=await database().factReviewState({sessionId:id,signal:exec.signal}),sameSource=round=>round.turnKey===canonical.turnKey&&round.source.callId===canonical.source.callId&&round.source.assistantMessageId===canonical.source.assistantMessageId;
      if(state.rounds.some(round=>round.pendingCandidateId&&!sameSource(round))||state.decisions.some(value=>['recorded','interrupted'].includes(value.status)))fail('FACT_REVIEW_PENDING','Resolve the pending fact review before another proposal',409);
      if(!(await store.review(id)).enabled&&!state.rounds.some(round=>round.pendingCandidateId&&sameSource(round)))fail('FACT_APPROVAL_DISABLED','Use rp_commit_turn while fact approval is off',409);
      const pending=await current.access.propose({...canonical,expectedRevision:input.expectedRevision,operations:stateOperations(input,record.binding.factEntryRefs),summary:input.summary,packet:clone(input.packet),kind:'turn',capture:captureFactTurn(current.view,canonical,record.binding)});
      notify(id);exec.concludeTurn();return {schemaVersion:1,status:'pending',roundId:pending.round.roundId,candidateId:pending.candidateId,roundVersion:pending.round.version};
    },
    async presentation(input){
      await assertPlayable(input.sessionId);
      const current=await scope(input),receipt=await current.access.getReceipt(input.factReceiptId),last=await latest(current);
      if(receipt.sessionId!==input.sessionId)fail('RECEIPT_NOT_FOUND','Receipt is unavailable in this story',404);
      if(last&&last.id!==receipt.id)fail('FACT_RECEIPT_SUPERSEDED','A later active factual commit supersedes this receipt',409);
      if((await accepted(current.view,current.agent,input.signal)).some(item=>item.factReceiptId===receipt.id))fail('FACT_ALREADY_PRESENTED','This factual receipt already has an accepted presentation',409);
      const binding=current.record.binding;
      return freeze({factReceipt:clone(receipt),packet:clone(receipt.packet),story:{title:binding.title,character:clone(binding.character),persona:clone(binding.persona),examples:binding.examples}});
    },
  };
}
