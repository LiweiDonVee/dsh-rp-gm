import test from 'node:test';import assert from 'node:assert/strict';import {createGmRoutes} from '../src/routes.mjs';import {createGmApi} from '../src/api.js';
test('native review HTTP envelope preserves the owner decision action and rejects source override',async()=>{
  let received;const routes=createGmRoutes({decideFacts:async input=>{received=input;return {operationId:input.operationId,status:'cancelled',roundId:input.roundId,presentation:{status:'not-requested'}};}}),send=(_url,init)=>routes.request(new Request('http://localhost/api/rp-gm/request',init)),api=createGmApi(send,'http://localhost/');
  const value=await api.decideFacts({sessionId:'story',roundId:'round',candidateId:'candidate',action:'cancel',operationId:'operation',expectedRoundVersion:2,expectedDatabaseRevision:5});assert.equal(value.status,'cancelled');assert.equal(received.action,'cancel');
  const response=await send(null,{method:'POST',body:JSON.stringify({action:'resumeFactDecision',sessionId:'story',operationId:'operation',source:{commandId:'fake'}})});assert.equal(response.status,400);routes.close();
});
test('GM prose controls call the existing LastStep endpoint directly with its exact DTO',async()=>{
  const calls=[],api=createGmApi(async(url,init)=>{calls.push({url:new URL(url).pathname,body:JSON.parse(init.body)});return Response.json({records:[]});},'http://localhost/'),ref={sessionId:'story',presentationId:'presentation',assistantMessageId:'assistant',callSeq:1,baseResultSeq:2,resultSeq:2};
  await api.storyHistory('story');await api.regenerateProse({sessionId:'story',basedOn:ref,operationId:'prose-one',instruction:'更简洁'});assert.deepEqual(calls,[{url:'/api/rp-last-step/request',body:{action:'storyHistory',sessionId:'story'}},{url:'/api/rp-last-step/request',body:{action:'regenerateProse',sessionId:'story',basedOn:ref,operationId:'prose-one',instruction:'更简洁'}}]);
});
