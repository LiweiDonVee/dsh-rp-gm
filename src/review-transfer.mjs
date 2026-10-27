import {clone,fail,requestFingerprint,text} from './core.mjs';
import {exactFields,normalizeCandidate,operationToken,revision} from './review-schema.mjs';
const invalid=message=>fail('RESTORE_PAYLOAD_INVALID',message,400);
const hash=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/u.test(value))invalid('Invalid owner request hash');return value;};
function source(value,sessionId,requestHash,complete=false){
  exactFields(value,['sessionId','commandId','runSeq','requestHash',...complete?['doneSeq']:[]]);if(value.sessionId!==sessionId||hash(value.requestHash)!==requestHash)invalid('Owner command identity does not match its request');text(value.commandId,'Command ID');revision(value.runSeq);if(complete&&revision(value.doneSeq)<=value.runSeq)invalid('Owner completion must follow its command');
}
function model(value){exactFields(value,['provider','model','reasoningEffort','maxTokens']);text(value.provider,'Provider');text(value.model,'Model');if(value.reasoningEffort!==undefined)text(value.reasoningEffort,'Reasoning effort');if(value.maxTokens!==undefined&&revision(value.maxTokens)<1)invalid('Invalid model token limit');}
function result(value,entry){
  exactFields(value,['operationId','status','roundId','factReceiptId','presentation']);if(value.operationId!==entry.operationId||value.roundId!==entry.request.roundId||!['approved','cancelled'].includes(value.status))invalid('Fact decision outcome does not match its request');
  if(value.status==='approved')text(value.factReceiptId,'Fact receipt ID');else if(value.factReceiptId!==undefined)invalid('Cancellation has no new fact receipt');
  exactFields(value.presentation,['status','presentationId','errorCode']);if(!['not-requested','complete','failed','interrupted'].includes(value.presentation.status))invalid('Unknown presentation outcome');if(value.presentation.status==='complete')text(value.presentation.presentationId,'Presentation ID');if(value.presentation.errorCode!==undefined)text(value.presentation.errorCode,'Error code');
}
export function normalizeReview(value,sessionId){
  exactFields(value,['schemaVersion','revision','enabled','decisions','generations','presentations']);if(value.schemaVersion!==1||typeof value.enabled!=='boolean'||!Array.isArray(value.decisions)||!Array.isArray(value.generations)||value.presentations!==undefined&&!Array.isArray(value.presentations))invalid('Unsupported GM review metadata');revision(value.revision);
  const ids=new Set();
  for(const entry of value.decisions){
    exactFields(entry,['operationId','request','requestHash','expectedRoundVersion','expectedDatabaseRevision','presentationOperationId','source','completion','result']);operationToken(entry.operationId);if(ids.has(entry.operationId))invalid('Duplicate owner decision');ids.add(entry.operationId);operationToken(entry.presentationOperationId);revision(entry.expectedRoundVersion);revision(entry.expectedDatabaseRevision);
    const request=entry.request;exactFields(request,['sessionId','roundId','candidateId','action','candidatePayloadHash','custom']);if(request.sessionId!==sessionId||!['approve','custom','cancel'].includes(request.action))invalid('Decision request has the wrong owner or action');text(request.roundId,'Round ID');text(request.candidateId,'Candidate ID');hash(request.candidatePayloadHash);if(request.action==='custom')normalizeCandidate(request.custom);else if(request.custom!==undefined)invalid('Unexpected custom decision data');if(requestFingerprint(request)!==hash(entry.requestHash))invalid('Owner decision hash changed');
    if(entry.source)source(entry.source,sessionId,entry.requestHash);if(entry.completion)source(entry.completion,sessionId,entry.requestHash,true);if(entry.result)result(entry.result,entry);
  }
  const jobs=new Set();
  for(const job of value.generations){
    exactFields(job,['id','operationId','roundId','status','candidateId','errorCode','model','request','requestHash','source','completion','decisionOperationId']);text(job.id,'Generation job ID');operationToken(job.operationId);if(jobs.has(job.operationId))invalid('Duplicate generation operation');jobs.add(job.operationId);text(job.roundId,'Round ID');operationToken(job.decisionOperationId);
    if(!['running','complete','failed','cancelled','interrupted'].includes(job.status))invalid('Unknown generation status');if(job.candidateId!==undefined)text(job.candidateId,'Candidate ID');if(job.errorCode!==undefined)text(job.errorCode,'Error code');if(job.model)model(job.model);
    const request=job.request;exactFields(request,['schemaVersion','sessionId','roundId','operationId','expectedRoundVersion','instruction','approvalRequired']);if(request.schemaVersion!==1||request.sessionId!==sessionId||request.roundId!==job.roundId||request.operationId!==job.operationId||typeof request.approvalRequired!=='boolean')invalid('Generation request identity changed');revision(request.expectedRoundVersion);text(request.instruction,'Instruction',true);if(requestFingerprint(request)!==hash(job.requestHash))invalid('Generation request hash changed');if(job.source)source(job.source,sessionId,job.requestHash);if(job.completion)source(job.completion,sessionId,job.requestHash,true);if(job.status==='complete'&&(!job.candidateId||!job.completion))invalid('Completed generation requires a staged candidate and command completion');
  }
  const presentations=new Set();for(const item of value.presentations??[]){exactFields(item,['operationId','roundId','factReceiptId','presentationOperationId','result']);operationToken(item.operationId);operationToken(item.presentationOperationId);text(item.roundId,'Round ID');text(item.factReceiptId,'Fact receipt ID');if(presentations.has(item.operationId))invalid('Duplicate child presentation coordination');presentations.add(item.operationId);if(item.result){result(item.result,{operationId:item.operationId,request:{roundId:item.roundId}});if(item.result.factReceiptId!==item.factReceiptId)invalid('Child presentation receipt does not match its provenance');}}
  return clone(value);
}
export function needsReviewOwners(state){return state.payload.bindings.some(record=>record.review&&(record.review.enabled||record.review.decisions.length||record.review.generations.length||record.review.presentations?.length));}
export async function verifyReviewSources(record,view,db,signal){
  const review=record.review;if(!review||!review.decisions.length&&!review.generations.length&&!review.presentations?.length)return;
  const state=await db.factReviewState({sessionId:record.binding.sessionId,signal});
  function actual(source,name,operationId,requestHash,expected){
    if(!source)return;const runs=view.events.filter(event=>event.type==='command/run'&&event.data?.commandId===source.commandId),run=runs[0];
    if(runs.length!==1||run.seq!==source.runSeq||run.data.name!==name||run.data.source?.kind!=='user'||JSON.stringify(run.data.args?.trim().split(/\s+/u))!==JSON.stringify([operationId,requestHash]))invalid('Review metadata lacks its exact canonical owner command');
    if(source.doneSeq!==undefined){const done=view.events.find(event=>event.seq===source.doneSeq);let value;try{value=JSON.parse(done?.data?.text);}catch{invalid('Owner completion result is unavailable');}if(done.type!=='command/done'||done.data.commandId!==source.commandId||done.data.kind!=='success'||requestFingerprint(value)!==requestFingerprint(expected))invalid('Review metadata lacks a matching successful owner completion');}
  }
  for(const entry of review.decisions){
    actual(entry.source,'rp-gm-fact-decision',entry.operationId,entry.requestHash);actual(entry.completion,'rp-gm-fact-decision',entry.operationId,entry.requestHash,{schemaVersion:1,operationId:entry.operationId,requestHash:entry.requestHash});
    if(entry.result){const decision=state.decisions.find(value=>value.operationId===entry.operationId);if(decision?.status!=='applied'||decision.requestHash!==entry.requestHash||entry.result.status==='approved'&&decision.factReceiptId!==entry.result.factReceiptId)invalid('Decision outcome has no corresponding Database settlement');}
  }
  for(const job of review.generations){
    const candidate=state.rounds.find(round=>round.roundId===job.roundId)?.candidates.find(value=>value.operationId===job.operationId);
    actual(job.source,'rp-gm-fact-regenerate',job.operationId,job.requestHash);if(job.candidateId&&candidate?.id!==job.candidateId)invalid('Generation metadata lacks its staged candidate');
    if(job.completion){if(!candidate)invalid('Generation completion lacks a staged candidate');actual(job.completion,'rp-gm-fact-regenerate',job.operationId,job.requestHash,{schemaVersion:1,operationId:job.operationId,candidateId:candidate.id,payloadHash:candidate.payloadHash});if(job.status==='complete'&&candidate.generationConfirmed!==true)invalid('Generation output is not confirmed by Database');}
  }
  for(const item of review.presentations??[]){const decision=state.decisions.find(value=>value.operationId===item.operationId);if(decision?.status!=='applied'||decision.factReceiptId!==item.factReceiptId||decision.roundId!==item.roundId||decision.source?.sessionId===record.binding.sessionId)invalid('Child writing coordination lacks inherited applied provenance');}
}
