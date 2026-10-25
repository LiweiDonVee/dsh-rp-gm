import test from 'node:test';import assert from 'node:assert/strict';
import {createGmHost} from '../src/host.mjs';import {launch} from './fixtures.mjs';import {contractFixture} from './contract-fixture.mjs';
test('startup creates one generic story only after Database and profile are ready',async t=>{
  const f=await contractFixture(t),service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());
  const first=await service.startStory(launch()),again=await service.startStory(launch());assert.equal(first.sessionId,again.sessionId);assert.equal(first.status,'starting');assert.equal(f.presets.size,1);
  assert.deepEqual(f.counts,{creates:1,prompts:1,binds:1,initializes:1,factWrites:0,presetDisposals:0,profileBinds:1});assert.equal(f.sessions.get(first.sessionId).events[0].type,'system/message');
  await assert.rejects(service.startStory(launch({title:'changed'})),{code:'LAUNCH_CONFLICT'});
});
test('lost create response resumes reserved identity without another session',async t=>{
  const f=await contractFixture(t),service=await createGmHost(f.ctx,f.options);f.faults.createLost=true;await assert.rejects(service.startStory(launch()),{code:'LOST_RESPONSE'});await service.close();
  const resumed=await createGmHost(f.ctx,f.options);t.after(()=>resumed.close());const result=await resumed.startStory(launch());assert.ok(f.sessions.has(result.sessionId));assert.equal(f.counts.creates,1);assert.equal(f.counts.prompts,1);
});
test('lost seed and prompt responses never repeat initialization or prompt',async t=>{
  for(const fault of ['initializeLost','promptLost']){const f=await contractFixture(t),service=await createGmHost(f.ctx,f.options);f.faults[fault]=true;await assert.rejects(service.startStory(launch()),{code:'LOST_RESPONSE'});const result=await service.startStory(launch());assert.equal(result.status,'starting');assert.equal(f.counts.initializes,1);assert.equal(f.counts.prompts,1);await service.close();}
});
test('absent dependencies keep library usable and dispose owned preset',async t=>{
  const f=await contractFixture(t);f.services.delete('rpDatabase');const service=await createGmHost(f.ctx,f.options);assert.deepEqual(await service.listStories({}),{stories:[]});assert.equal((await service.diagnostics()).database,false);
  await assert.rejects(service.startStory(launch()),{code:'DATABASE_UNAVAILABLE'});assert.equal(f.counts.creates,0);await service.close();assert.equal(f.counts.presetDisposals,1);assert.equal(f.presets.size,0);
});
test('concurrent same launch and separate stories retain independent identities',async t=>{
  const f=await contractFixture(t),service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());const [a,b]=await Promise.all([service.startStory(launch()),service.startStory(launch())]);assert.equal(a.sessionId,b.sessionId);
  const other=await service.startStory(launch({launchId:'other',title:'另一场雨'}));assert.notEqual(a.sessionId,other.sessionId);assert.equal((await service.storyState({sessionId:a.sessionId})).binding.title,'雨夜客栈');assert.equal((await service.storyState({sessionId:other.sessionId})).binding.title,'另一场雨');
});
test('owner can inspect a cold story through authorized Database projection without activating an agent',async t=>{
  const f=await contractFixture(t),service=await createGmHost(f.ctx,f.options),started=await service.startStory(launch()),snapshot=await f.readSession(started.sessionId);await service.close();
  f.sessions.delete(started.sessionId);let ownerReads=0;f.db.effectiveV2=async()=>{ownerReads++;return {entries:structuredClone(f.states.get(started.sessionId).seed)};};
  const cold=await createGmHost(f.ctx,{directory:f.directory,readSession:async()=>snapshot});t.after(()=>cold.close());
  assert.equal((await cold.storyState({sessionId:started.sessionId})).facts.items[0].id,'letter-holder');assert.equal(ownerReads,1);assert.equal(f.sessions.size,0);assert.equal(f.counts.creates,1);
});
test('an imported draft cannot become the default-ready profile through story start',async t=>{
  const f=await contractFixture(t),profile=await f.last.ensureBuiltinProfile({key:'draft-fixture',profile:{name:'Imported draft',entries:[]}});f.profiles.get('draft-fixture').status='draft';
  const service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());await assert.rejects(service.startStory(launch({profile})),{code:'PROFILE_NOT_READY'});assert.equal(f.counts.creates,0);
});
test('ordinary Database startup uses public state revision without the optional content-transfer API',async t=>{
  const f=await contractFixture(t);delete f.db.contentRevision;const service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());
  const started=await service.startStory(launch());assert.equal(started.status,'starting');assert.equal(f.counts.binds,1);assert.equal(f.counts.initializes,1);assert.equal(f.counts.prompts,1);
});
test('legacy LastStep profile binding stays in the preset revision domain after aggregate revisions diverge',async t=>{
  const f=await contractFixture(t);f.last.contentRevision=async()=>({revision:999});const service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());assert.equal((await service.startStory(launch())).status,'starting');assert.equal(f.counts.profileBinds,1);
});
test('partial startup recovery preserves an already chosen ready owner style instead of binding the initial style again',async t=>{
  const f=await contractFixture(t),bind=f.last.bindSession;let lost=true;f.last.bindSession=async input=>{const result=await bind(input);if(lost){lost=false;throw Object.assign(Error('Lost profile acknowledgement'),{code:'LOST_RESPONSE'});}return result;};const service=await createGmHost(f.ctx,f.options);t.after(()=>service.close());
  await assert.rejects(service.startStory(launch()),{code:'LOST_RESPONSE'});const id=[...f.sessions.keys()][0];f.profiles.set('style-b',{id:'style-b',name:'Owner style B',version:1,status:'ready',sourceId:null,entries:[]});await f.last.bindSession({sessionId:id,profileId:'style-b',version:1,expectedRevision:(await f.last.state(id)).revision});const before=f.counts.profileBinds;
  const resumed=await service.startStory(launch());assert.equal(resumed.binding.profile.profileId,'builtin');assert.equal((await f.last.state(id)).binding.profileId,'style-b');assert.equal(f.counts.profileBinds,before);assert.equal(f.counts.prompts,1);
});
