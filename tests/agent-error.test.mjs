import test from 'node:test';import assert from 'node:assert/strict';import {registerGmAgent} from '../src/agent.mjs';import {contractFixture} from './contract-fixture.mjs';
async function fixture(t,error){const f=await contractFixture(t),agent=f.makeAgent('error-story'),runtime={ensure:async()=>true,reserved:async()=>false,toolState:async()=>{throw error;}};const close=await registerGmAgent(f.ctx,runtime,async()=> '');t.after(close);return {agent,definition:agent.tools.get('rp_gm_state')};}
const execution=agent=>({agent,callId:'call-one',rootCallId:'call-one',signal:new AbortController().signal});
const outcome=message=>Object.freeze({isError:true,error:Object.freeze({message}),content:Object.freeze([{type:'text',text:`Error: ${message}`}])});
test('native error finalization preserves failure and exposes only safe kernel receipt fields',async t=>{
  const error=Object.assign(Error('This turn already owns a receipt'),{name:'DatabaseError',code:'TURN_ALREADY_COMMITTED',receiptId:'fact-one',status:409,providerPayload:{apiKey:'never-project'}}),{agent,definition}=await fixture(t,error),exec=execution(agent);
  await assert.rejects(definition.execute({},exec),caught=>caught===error);const failed=outcome(error.message),content=definition.finalizeContent(exec,failed);
  assert.deepEqual(JSON.parse(content[0].text),{error:{code:'TURN_ALREADY_COMMITTED',message:'This turn already owns a receipt',receiptId:'fact-one'}});assert.equal(failed.isError,true);assert.equal(failed.error.message,error.message);assert.equal(content[0].text.includes('never-project'),false);assert.equal(definition.finalizeContent(exec,failed),undefined);
});
test('post-policy redaction and cancellation content are never replaced by kernel projection',async t=>{
  const error=Object.assign(Error('Committed'),{name:'DatabaseError',code:'TURN_ALREADY_COMMITTED',receiptId:'fact-one'}),{agent,definition}=await fixture(t,error);
  for(const [message,content]of [['Committed','Redacted by owner policy'],['tool call aborted','Error: tool call aborted']]){const exec=execution(agent);await assert.rejects(definition.execute({},exec));assert.equal(definition.finalizeContent(exec,{isError:true,error:{message},content:[{type:'text',text:content}]}),undefined);}
});
test('unknown dependency errors retain the native SDK failure projection',async t=>{
  const error=Object.assign(Error('Unexpected dependency failure'),{code:'HTTP_ERROR',providerPayload:{secret:'never-project'}}),{agent,definition}=await fixture(t,error),exec=execution(agent);await assert.rejects(definition.execute({},exec));assert.equal(definition.finalizeContent(exec,outcome(error.message)),undefined);
});
