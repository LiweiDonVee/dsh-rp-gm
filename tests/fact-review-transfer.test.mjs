import test from 'node:test';import assert from 'node:assert/strict';import {normalizeState} from '../src/transfer-schema.mjs';import {reviewFixture,propose,decisionInput} from './fact-review-fixture.mjs';
test('SavedStory GM payload retains explicit review policy and immutable decision coordination',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true});await propose(f);f.faults.runOnly=true;await assert.rejects(f.service.decideFacts(decisionInput(f,await f.service.reviewState({sessionId:f.id}))),{code:'LOST_RESPONSE'});
  const exported=await f.service.exportState({sessionIds:[f.id]}),record=exported.payload.bindings[0];assert.equal(record.review.enabled,true);assert.equal(record.review.decisions[0].request.action,'approve');assert.equal(JSON.stringify(record.review).includes('密封信件'),false);assert.deepEqual(normalizeState(exported,[f.id]),exported);
  const forged=structuredClone(exported);forged.payload.bindings[0].review.decisions[0].requestHash='0'.repeat(64);assert.throws(()=>normalizeState(forged,[f.id]),{code:'RESTORE_PAYLOAD_INVALID'});
});
test('restore preflight reports missing review dependencies and legacy payload stays supported',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true}),exported=await f.service.exportState({sessionIds:[f.id]});delete f.db.capabilities;delete f.last.capabilities;
  const check=await f.service.preflightRestore({sessionIds:[f.id],state:exported});assert.equal(check.supported,false);assert.ok(check.requirements.includes('rpDatabase.capabilities.factReview=1'));
  const old=structuredClone(exported);delete old.payload.bindings[0].review;assert.doesNotThrow(()=>normalizeState(old,[f.id]));
});
test('GM transfer cannot claim completed writing without the matching accepted LastStep record',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true});await propose(f);const approved=await f.service.decideFacts(decisionInput(f,await f.service.reviewState({sessionId:f.id}))),read=f.last.narratives;f.last.narratives=async input=>{const value=await read(input);return {...value,records:value.records.filter(record=>record.factReceiptId!==approved.factReceiptId)};};
  await assert.rejects(f.service.exportState({sessionIds:[f.id]}),{code:'RESTORE_PAYLOAD_INVALID'});
});
