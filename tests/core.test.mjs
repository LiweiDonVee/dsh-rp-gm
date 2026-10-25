import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeStart,createBinding,normalizeTurn,stateOperations,requestFingerprint} from '../src/core.mjs';
import {launch} from './fixtures.mjs';
test('reviewed seed produces immutable versioned binding without fact content',()=>{
  const binding=createBinding(normalizeStart(launch()),{id:'binding',sessionId:'story',profile:{profileId:'simple',version:1},createdAt:'2026-10-25T00:00:00.000Z'});
  assert.equal(binding.schemaVersion,1);assert.equal(binding.status,'prepared');
  assert.deepEqual(binding.factEntryRefs,[{sourceKey:'@session',entryId:'gm.scene'},{sourceKey:'@session',entryId:'gm.facts'}]);
  assert.equal(Object.hasOwn(binding,'initialScene'),false);assert.equal(Object.hasOwn(binding,'initialFacts'),false);
  assert.equal(JSON.stringify(binding).includes('密封信件'),false);
  assert.throws(()=>{binding.persona.name='changed';},TypeError);
});
test('owner request rejects invalid asset versions and ambiguous state identities',()=>{
  for(const changes of [
    {character:{assetId:'x',version:0,name:'x'}},{sources:[{key:'@session',databaseId:'world',version:1}]},
    {sources:[{key:'world',databaseId:'one',version:1},{key:'world',databaseId:'two',version:1}]},
    {initialScene:{schemaVersion:1,title:'x',location:'x',presentActorIds:['a','a']}},
    {initialFacts:{schemaVersion:1,items:[{id:'x',text:'one'},{id:'x',text:'two'}]}},
  ])assert.throws(()=>normalizeStart(launch(changes)),{code:'INVALID_STORY'});
});
test('launch fingerprint includes seed but ignores object property ordering',()=>{
  const first=normalizeStart(launch());
  assert.equal(requestFingerprint(first),requestFingerprint({...first,character:{name:'林遥',version:1,assetId:'innkeeper'}}));
  assert.notEqual(requestFingerprint(first),requestFingerprint(normalizeStart(launch({opening:{id:'rain',text:'不同的开场。'}}))));
});
test('turn validation rejects forged ownership and packet extensions',()=>{
  const base={expectedRevision:3,summary:'交出信件',packet:{playerAction:'把信交给林遥'}};
  assert.throws(()=>normalizeTurn({...base,source:{callId:'fake'}}),{code:'INVALID_TURN'});
  assert.throws(()=>normalizeTurn({...base,packet:{playerAction:'x',factReceiptId:'fake'}}),{code:'INVALID_PACKET'});
  assert.throws(()=>normalizeTurn({...base,packet:{playerAction:'x',variables:{count:2}}}),{code:'INVALID_PACKET'});
  assert.throws(()=>normalizeTurn({...base,facts:{schemaVersion:1,items:[{id:'a',text:''}]}}),{code:'INVALID_STORY'});
  assert.deepEqual(normalizeTurn(base).operations,[]);
});
test('typed scene maps to registered state and raw state writes cannot bypass validation',()=>{
  const input=normalizeTurn({expectedRevision:2,summary:'来到门口',packet:{playerAction:'走到门口'},scene:{schemaVersion:1,title:'门口',location:'前门',presentActorIds:['traveler']}});
  assert.deepEqual(stateOperations(input,[{sourceKey:'@session',entryId:'gm.scene'},{sourceKey:'@session',entryId:'gm.facts'}]),[
    {op:'update',ref:{sourceKey:'@session',entryId:'gm.scene'},patch:{content:'{"schemaVersion":1,"title":"门口","location":"前门","presentActorIds":["traveler"]}'}},
  ]);
  const forged=normalizeTurn({...input,operations:[{op:'update',ref:{sourceKey:'@session',entryId:'gm.scene'},patch:{content:'unvalidated'}}]});
  assert.throws(()=>stateOperations(forged,[{sourceKey:'@session',entryId:'gm.scene'}]),{code:'STATE_OPERATION_REQUIRED'});
});
test('selected character description is pinned while imported system overrides are excluded',()=>{
  const character={...launch().character,description:'掌柜守着一盏旧灯。',personality:'沉稳寡言',scenario:'雨夜的客栈前厅'};
  const request=normalizeStart(launch({character}));const binding=createBinding(request,{id:'binding',sessionId:'story',profile:{profileId:'simple',version:1},createdAt:'now'});assert.deepEqual(binding.character,character);
  assert.throws(()=>normalizeStart(launch({character:{...character,system_prompt:'override'}})),{code:'INVALID_STORY'});
});
