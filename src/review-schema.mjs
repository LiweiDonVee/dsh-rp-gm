import {clone,fail,normalizeFacts,normalizePacket,normalizeScene,object,text} from './core.mjs';

export function exactFields(value,allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('INVALID_REVIEW_REQUEST','Unexpected fact review fields');}
export function operationToken(value){text(value,'Operation ID',false,'INVALID_REVIEW_REQUEST');if(!/^[A-Za-z0-9_.:-]{1,256}$/u.test(value))fail('INVALID_REVIEW_REQUEST','Operation ID must be one opaque token');return value;}
export function revision(value){if(!Number.isSafeInteger(value)||value<0)fail('INVALID_REVIEW_REQUEST','A nonnegative revision is required');return value;}
export function normalizeCandidate(value){exactFields(value,['scene','facts','summary','packet']);return {scene:normalizeScene(value.scene),facts:normalizeFacts(value.facts),summary:text(value.summary,'Summary',false,'INVALID_REVIEW_REQUEST'),packet:clone(normalizePacket(value.packet))};}
export function normalizeDecision(input){
  exactFields(input,['sessionId','roundId','candidateId','action','custom','operationId','expectedRoundVersion','expectedDatabaseRevision','signal']);
  if(!['approve','custom','cancel'].includes(input.action)||input.action!=='custom'&&input.custom!==undefined)fail('INVALID_REVIEW_REQUEST','Choose approve, custom, or cancel');
  return {sessionId:text(input.sessionId,'Session ID'),roundId:text(input.roundId,'Round ID'),candidateId:text(input.candidateId,'Candidate ID'),action:input.action,...input.action==='custom'?{custom:normalizeCandidate(input.custom)}:{},operationId:operationToken(input.operationId),expectedRoundVersion:revision(input.expectedRoundVersion),expectedDatabaseRevision:revision(input.expectedDatabaseRevision)};
}
export function normalizeGeneration(input,approvalRequired){
  exactFields(input,['sessionId','roundId','operationId','expectedRoundVersion','instruction','signal']);
  return {schemaVersion:1,sessionId:text(input.sessionId,'Session ID'),roundId:text(input.roundId,'Round ID'),operationId:operationToken(input.operationId),expectedRoundVersion:revision(input.expectedRoundVersion),instruction:text(input.instruction??'','Instruction',true,'INVALID_REVIEW_REQUEST'),approvalRequired};
}
