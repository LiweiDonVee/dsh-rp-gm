import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createBindingStore} from '../src/store.mjs';import {createBinding,normalizeStart} from '../src/core.mjs';import {launch} from './fixtures.mjs';
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'rp-gm-store-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,store:createBindingStore({directory})};}
test('same launch resumes durable identity and conflicting payload cannot replace it',async t=>{
  const {directory,store}=await fixture(t),request=normalizeStart(launch());
  const first=await store.reserve(request);await store.checkpoint(request.launchId,'created');
  const replay=await createBindingStore({directory}).reserve(request);
  assert.equal(replay.sessionId,first.sessionId);assert.equal(replay.promptRequestId,first.promptRequestId);assert.equal(replay.progress.created,true);
  await assert.rejects(store.reserve(normalizeStart(launch({title:'不同故事'}))),{code:'LAUNCH_CONFLICT'});
  assert.equal((await store.launch(request.launchId)).sessionId,first.sessionId);
});
test('metadata journal never persists initial scene or factual seed',async t=>{
  const {directory,store}=await fixture(t),request=normalizeStart(launch()),reserved=await store.reserve(request);
  await store.prepare(request.launchId,createBinding(request,{...reserved,profile:{profileId:'simple',version:1}}));
  const raw=await readFile(join(directory,'state.json'),'utf8');
  for(const forbidden of ['initialScene','initialFacts','密封信件','客栈前厅'])assert.equal(raw.includes(forbidden),false,forbidden);
  assert.equal((await store.binding(reserved.sessionId)).binding.profile.profileId,'simple');
});
test('cross-handle launch races allocate one identity and distinct stories stay isolated',async t=>{
  const {directory,store}=await fixture(t),request=normalizeStart(launch());
  const [a,b]=await Promise.all([store.reserve(request),createBindingStore({directory}).reserve(request)]);assert.equal(a.sessionId,b.sessionId);
  const other=await store.reserve(normalizeStart(launch({launchId:'launch-two'})));assert.notEqual(other.sessionId,a.sessionId);
  for(const record of [a,other])await store.prepare(record.launchId,createBinding(normalizeStart(launch({launchId:record.launchId})),{...record,profile:{profileId:'simple',version:1}}));
  await store.setStatus(a.sessionId,'active');assert.equal((await store.binding(other.sessionId)).binding.status,'prepared');
});
test('fork metadata preserves fixed assets and receipt pointer without copying facts',async t=>{
  const {store}=await fixture(t),request=normalizeStart(launch()),record=await store.reserve(request);
  await store.prepare(record.launchId,createBinding(request,{...record,profile:{profileId:'simple',version:1}}));await store.receipt(record.sessionId,'fact-one');
  const child=await store.inherit(record.sessionId,'child');
  assert.equal(child.binding.sessionId,'child');assert.equal(child.parentSessionId,record.sessionId);assert.equal(child.lastReceiptId,'fact-one');
  assert.deepEqual(child.binding.character,{assetId:'innkeeper',version:1,name:'林遥'});assert.notEqual(child.binding.id,record.id);
});
