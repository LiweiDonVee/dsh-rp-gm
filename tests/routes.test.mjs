import test from 'node:test';import assert from 'node:assert/strict';
import {createGmRoutes} from '../src/routes.mjs';import {createGmApi} from '../src/api.js';
const request=body=>new Request('http://localhost/api/rp-gm/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
function fixture(){const calls=[];return {calls,service:{diagnostics:async()=>({database:false,lastStep:false,context:false,loop:false}),listStories:async()=>({stories:[]}),startStory:async input=>{calls.push(input);return {sessionId:'story',status:'starting',binding:{title:input.title}};},storyState:async()=>({binding:{sessionId:'story'},scene:{title:'前厅'},facts:{items:[]}}),binding:async({sessionId})=>sessionId==='story'?{sessionId}:null,subscribe:()=>()=>{}}};}
test('library remains available without dependencies and sample uses reviewed owner seed',async()=>{
  const {service,calls}=fixture(),routes=createGmRoutes(service);const library=await (await routes.request(request({action:'library'}))).json();assert.equal(library.dependencies.database,false);assert.equal(library.sample.openings.length,2);
  const response=await routes.request(request({action:'startSample',launchId:'stable-launch',openingId:'rain'}));assert.equal(response.status,200);assert.equal(calls[0].launchId,'stable-launch');assert.deepEqual(calls[0].sources,[]);assert.equal(calls[0].initialFacts.items[0].id,'letter-holder');routes.close();
});
test('owner request rejects extra ownership/source fields before service call',async()=>{
  const {service,calls}=fixture(),routes=createGmRoutes(service);
  for(const input of [{action:'startSample',launchId:'x',openingId:'rain',source:{callId:'forged'}},{action:'factAccess',sessionId:'story'},{action:'state',sessionId:'story',agent:'forged'}])assert.equal((await routes.request(request(input))).status,400);
  assert.equal(calls.length,0);routes.close();
});
test('error projection preserves existing receipt id and API exposes it without parsing messages',async()=>{
  const {service}=fixture();service.startStory=async()=>{throw Object.assign(new Error('Already committed'),{name:'DatabaseError',code:'TURN_ALREADY_COMMITTED',status:409,receiptId:'fact-one'});};
  const routes=createGmRoutes(service),api=createGmApi((_url,init)=>routes.request(new Request('http://localhost/api/rp-gm/request',init)),'http://localhost/');
  await assert.rejects(api.startSample('launch','rain'),error=>error.code==='TURN_ALREADY_COMMITTED'&&error.receiptId==='fact-one'&&error.status===409);routes.close();
});
test('events require owned binding and send metadata only',async()=>{
  const {service}=fixture(),routes=createGmRoutes(service);
  assert.equal((await routes.events(new Request('http://localhost/api/rp-gm/events?sessionId=foreign'))).status,404);
  const response=await routes.events(new Request('http://localhost/api/rp-gm/events?sessionId=story')),reader=response.body.getReader(),first=new TextDecoder().decode((await reader.read()).value);
  assert.equal(first.includes('"sessionId":"story"'),true);assert.equal(first.includes('facts'),false);routes.close();assert.equal((await reader.read()).done,true);
});
