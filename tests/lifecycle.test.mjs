import test from 'node:test';import assert from 'node:assert/strict';
import * as host from '../src/host.mjs';import {contractFixture} from './contract-fixture.mjs';import {launch} from './fixtures.mjs';
test('plugin owns native service routes and disposes them with its preset',async t=>{
  const f=await contractFixture(t),routes=new Map();f.ctx.connection.fetch={register:definition=>{routes.set(definition.path,definition);return()=>routes.delete(definition.path);}};
  assert.equal(typeof host.apply,'function');await host.apply(f.ctx,f.options);assert.equal(f.services.get('rpGM').apiVersion,1);
  assert.deepEqual([...routes.keys()].sort(),['/api/rp-gm/events','/api/rp-gm/request']);const response=await routes.get('/api/rp-gm/request').fetch(new Request('http://localhost/api/rp-gm/request',{method:'POST',body:'{"action":"library"}'}));assert.equal(response.status,200);
  for(const cleanup of f.effects.reverse())await cleanup();assert.equal(routes.size,0);assert.equal(f.presets.size,0);
});
test('unload cancels an unfinished launch before any first prompt is queued',async t=>{
  const f=await contractFixture(t);let entered;const waiting=new Promise(resolve=>{entered=resolve;});f.db.initializeStoryState=input=>new Promise((_resolve,reject)=>{entered();input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});});
  const service=await host.createGmHost(f.ctx,f.options),pending=service.startStory(launch());const rejected=assert.rejects(pending,{name:'AbortError'});await waiting;await service.close();await rejected;assert.equal(f.counts.prompts,0);assert.equal(f.presets.size,0);
});
