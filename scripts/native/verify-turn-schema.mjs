// Supply the exact installed/extracted @deepseek-ai package directory. This
// uses the real native executor and DeepSeek Messages serializer with an
// in-process fetch fixture; it never contacts a provider or reads user data.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {registerGmAgent} from '../../src/agent.mjs';
import {normalizeTurn} from '../../src/core.mjs';
import {contractFixture} from '../../tests/contract-fixture.mjs';

if(!process.argv[2])throw Error('Pass the exact DSH @deepseek-ai package directory');
const root=resolve(process.argv[2]),load=name=>import(pathToFileURL(join(root,name,'lib/index.js')).href);
const [sdk,{NativeToolExecutor},{DeepSeekAdapter,resolveAdapterOptions}]=await Promise.all([load('dsh-tools'),load('dsh-tool-executor-native'),load('dsh-llm-deepseek')]);
const versions={};for(const name of ['dsh-tools','dsh-tool-executor-native','dsh-llm-deepseek'])versions[name]=JSON.parse(await readFile(join(root,name,'package.json'),'utf8')).version;
const cleanup=[],f=await contractFixture({after:fn=>cleanup.push(fn)}),agent=f.makeAgent('schema-fixture');
const close=await registerGmAgent(f.ctx,{ensure:async()=>true,reserved:async()=>false},async()=> '');cleanup.push(close);
const originalFetch=globalThis.fetch;
try{
  const definitions=['rp_commit_turn','rp_propose_turn'].map(name=>agent.tools.get(name));
  for(const definition of definitions)sdk.assertObjectJsonSchema(definition.parameters);
  const executor=new NativeToolExecutor(f.ctx),schemas=executor.describe(definitions).schemas;
  const input={expectedRevision:0,scene:{schemaVersion:1,title:'检定',location:'门口',presentActorIds:['player']},facts:{schemaVersion:1,items:[{id:'door',text:'门已打开。'}]},summary:'检定通过',packet:{playerAction:'推门',variables:{checkDC:12,checkTotal:17,checkMargin:5,checkPassed:true}},operations:[{op:'note',ref:{sourceKey:'world',entryId:'door'},text:'已经检查门锁。'}]};
  for(const schema of schemas){
    assert.deepEqual(sdk.validateJsonSchemaValue(schema.parameters,input,''),[]);
    const invalid={...input,facts:{schemaVersion:1,items:[{key:'door',text:'错误字段',visibility:'public'}]}};
    assert.ok(sdk.validateJsonSchemaValue(schema.parameters,invalid,'').length>0);
  }
  let request,calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;assert.equal(url,'https://schema-fixture.invalid/v1/messages');request=JSON.parse(options.body);
    const events=[{type:'message_start',message:{usage:{input_tokens:1,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ok'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
    return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  };
  const options=resolveAdapterOptions({baseURL:'https://schema-fixture.invalid',models:[{id:'fixture',inputModalities:['text']}],thinking:'disabled',streamIdleTimeoutMs:10000});
  const adapter=new DeepSeekAdapter({options:()=>options,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'schema-fixture',resolveFiles:()=>({}),prepareExtensions:async()=>({fields:{},accept:async()=>{}})});
  const chunks=[];for await(const chunk of adapter.stream({provider:'fixture',model:'fixture',maxTokens:32,reasoningEffort:'off',messages:[{role:'user',content:[{type:'text',text:'schema fixture'}]}],tools:schemas}))chunks.push(chunk);
  assert.equal(calls,1);assert.equal(chunks.at(-1).type,'finish');
  for(const tool of request.tools){assert.deepEqual(tool.input_schema,agent.tools.get(tool.name).parameters);assert.deepEqual(tool.input_schema.properties.facts.properties.items.items.required,['id','text']);}
  assert.deepEqual(normalizeTurn(input).packet.variables,{checkDC:'12',checkTotal:'17',checkMargin:'5',checkPassed:'true'});
  process.stdout.write(JSON.stringify({versions,nativeSchemas:schemas.map(tool=>tool.name),requestSchemasPreserved:true,publicScalarsNormalized:true,fetchFixtureCalls:calls,externalRequests:0})+'\n');
}finally{
  globalThis.fetch=originalFetch;
  for(const dispose of cleanup.reverse())await dispose();
}
