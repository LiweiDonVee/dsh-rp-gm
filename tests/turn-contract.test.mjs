import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePacket,normalizeTurn} from '../src/core.mjs';
import {TURN_SCHEMA,SCENE_SCHEMA,FACTS_SCHEMA,PACKET_SCHEMA} from '../src/turn-schema.mjs';
import {reviewFixture,propose} from './fact-review-fixture.mjs';

const variables={checkDC:12,checkTotal:17,checkMargin:5,checkPassed:true,zero:0,no:false,note:'  原文  ',empty:''};
const normalized={checkDC:'12',checkTotal:'17',checkMargin:'5',checkPassed:'true',zero:'0',no:'false',note:'  原文  ',empty:''};

test('commit and proposal publish the same complete nested turn schema',async t=>{
  const f=await reviewFixture(t),agent=f.sessions.get(f.id);
  for(const name of ['rp_commit_turn','rp_propose_turn']){
    const schema=agent.tools.get(name).parameters;
    assert.equal(schema,TURN_SCHEMA);assert.equal(schema.properties.scene,SCENE_SCHEMA);assert.equal(schema.properties.facts,FACTS_SCHEMA);assert.equal(schema.properties.packet,PACKET_SCHEMA);
    assert.deepEqual(schema.properties.facts.properties.items.items.required,['id','text']);
    assert.deepEqual(Object.keys(schema.properties.facts.properties.items.items.properties),['id','text']);
    assert.equal(schema.properties.facts.properties.items.items.additionalProperties,false);
    assert.deepEqual(schema.required,['expectedRevision','summary','packet']);
    assert.equal(schema.properties.packet.required.includes('playerAction'),true);
    assert.deepEqual(schema.properties.operations.items.oneOf.map(branch=>branch.properties.op.const),['add','update','remove','note']);
  }
});

test('public variable scalars normalize without mutating or trimming input',()=>{
  const input={playerAction:'掷骰',variables:structuredClone(variables)},before=structuredClone(input),packet=normalizePacket(input);
  assert.deepEqual(packet.variables,normalized);assert.deepEqual(input,before);assert.ok(Object.isFrozen(packet.variables));
  for(const value of [null,[],{},Infinity,-Infinity,NaN,undefined])assert.throws(()=>normalizePacket({playerAction:'掷骰',variables:{checkTotal:value}}),error=>error.code==='INVALID_PACKET'&&error.message.includes('packet.variables["checkTotal"]')&&error.message.includes('finite number'));
  for(const value of [null,[],7,'x'])assert.throws(()=>normalizePacket({playerAction:'掷骰',variables:value}),error=>error.code==='INVALID_PACKET'&&error.message.includes('packet.variables must be an object'));
  assert.throws(()=>normalizePacket({playerAction:'掷骰',visibleConsequences:['已知',3]}),error=>error.message.includes('packet.visibleConsequences[1]'));
});

test('fact aliases and visibility reject with a repairable path and never publish hidden text',async t=>{
  const f=await reviewFixture(t),state=await f.runTool(f.id,'rp_gm_state'),base={expectedRevision:state.revision,summary:'结果',packet:{playerAction:'行动'}};
  const input={...base,facts:{schemaVersion:1,items:[{key:'door',text:'私人线索',visibility:'private'}]}};
  const agent=f.sessions.get(f.id),definition=agent.tools.get('rp_commit_turn'),exec={agent,signal:new AbortController().signal};
  let failure;try{await definition.execute(input,exec);}catch(error){failure=error;}
  assert.equal(failure.code,'INVALID_STORY');assert.match(failure.message,/facts\.items\[0\]\.key/u);assert.match(failure.message,/facts\.items\[0\]\.visibility/u);assert.match(failure.message,/id, text/u);assert.match(failure.message,/do not remove visibility/u);
  const content=definition.finalizeContent(exec,{isError:true,error:{message:failure.message},content:[{type:'text',text:`Error: ${failure.message}`}]});
  assert.equal(JSON.parse(content[0].text).error.code,'INVALID_STORY');assert.equal(content[0].text.includes('私人线索'),false);
  assert.equal(f.counts.factWrites,1);assert.deepEqual((await f.service.storyState({sessionId:f.id})).facts,state.facts);
  assert.throws(()=>normalizeTurn({...base,facts:{schemaVersion:1,items:[{text:'公开'}]}}),error=>error.message.includes('facts.items[0].id'));
  assert.throws(()=>normalizeTurn({...base,scene:{schemaVersion:1,title:'门口',location:'前门',presentActorIds:[],extra:true}}),error=>error.message.includes('scene.extra'));
});

test('ordinary dice commit reaches the public receipt as strings and keeps owner policies',async t=>{
  const f=await reviewFixture(t),state=await f.runTool(f.id,'rp_gm_state');
  const receipt=await f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,scene:{...state.scene,location:'前门'},facts:{schemaVersion:1,items:[{id:'door',text:'门已打开。'}]},summary:'检定通过',packet:{playerAction:'推门',variables}});
  assert.deepEqual(receipt.packet.variables,normalized);assert.equal(f.counts.factWrites,2);
  assert.deepEqual((await f.service.presentation({sessionId:f.id,agent:f.sessions.get(f.id),factReceiptId:receipt.id})).packet.variables,normalized);
  f.finish(f.id);const current=await f.runTool(f.id,'rp_gm_state');f.states.get(f.id).seed.find(entry=>entry.id==='gm.facts').readOnly=true;
  await assert.rejects(f.runTool(f.id,'rp_commit_turn',{expectedRevision:current.revision,summary:'锁定事实',facts:{schemaVersion:1,items:[]},packet:{playerAction:'行动',variables}}),{code:'READ_ONLY'});assert.equal(f.counts.factWrites,2);
});

test('reviewed dice proposal preserves the approval boundary and normalizes candidate variables',async t=>{
  const f=await reviewFixture(t,{factApprovalDefault:true}),state=await f.runTool(f.id,'rp_gm_state');
  await assert.rejects(f.runTool(f.id,'rp_commit_turn',{expectedRevision:state.revision,summary:'绕过',packet:{playerAction:'行动',variables}}),{code:'FACT_APPROVAL_REQUIRED'});
  f.finish(f.id);const result=await propose(f,{packet:{playerAction:'推门',variables}}),review=await f.service.reviewState({sessionId:f.id});
  assert.equal(result.status,'pending');assert.deepEqual(review.latestRound.candidates[0].payload.packet.variables,normalized);assert.equal(f.counts.factWrites,1);assert.equal(f.presentations.length,0);assert.ok(review.latestRound.pendingCandidateId);
});
