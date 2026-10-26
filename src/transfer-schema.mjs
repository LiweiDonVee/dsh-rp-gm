import {clone,entryKey,fail,normalizeCharacter,normalizePersona,normalizeProfileRef,normalizeSources,object} from './core.mjs';
import {normalizeReview} from './review-transfer.mjs';
const invalid=message=>fail('RESTORE_PAYLOAD_INVALID',message,400);
const statuses=new Set(['prepared','starting','active','failed','restoring']);
const bindingKeys=['schemaVersion','id','sessionId','launchId','title','status','character','persona','opening','examples','sources','profile','factEntryRefs','createdAt'];
function keys(value,allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))invalid('Unexpected GM metadata fields');}
function string(value,label,empty=false){if(typeof value!=='string'||!empty&&!value.trim())invalid(`${label} must be a string`);return value;}
function integer(value,label){if(!Number.isSafeInteger(value)||value<0)invalid(`${label} must be a nonnegative integer`);return value;}
function json(value,seen=new Set()){
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))invalid('Nonfinite JSON number');return;}
  if(typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid('State must be plain serializable JSON');
  seen.add(value);for(const child of Array.isArray(value)?value:Object.values(value))json(child,seen);seen.delete(value);
}
export function sessionIds(value){if(!Array.isArray(value)||!value.length||value.some(id=>typeof id!=='string'||!id.trim())||new Set(value).size!==value.length)invalid('Distinct Session IDs are required');return [...value].sort();}
export function envelope(input,restore=false){
  keys(input,restore?['restoreId','sessionIds','state','expectedRevision','signal']:['sessionIds','state','signal']);const ids=sessionIds(input.sessionIds),state=input.state;
  if(!object(state)||!Number.isSafeInteger(state.schemaVersion)||state.schemaVersion<1||!Number.isSafeInteger(state.revision)||state.revision<0||!object(state.payload))invalid('A versioned GM state envelope is required');json(state);
  if(restore){string(input.restoreId,'Restore ID');integer(input.expectedRevision,'Expected revision');}
  return {sessionIds:ids,state:clone(state),...restore?{restoreId:input.restoreId,expectedRevision:input.expectedRevision}:{}};
}
function ref(value){keys(value,['sourceKey','entryId']);return {sourceKey:string(value.sourceKey,'Source key'),entryId:string(value.entryId,'Entry ID')};}
function canonical(value){keys(value,['assistantMessageId','callId','callSeq','turnStartSeq']);return {assistantMessageId:string(value.assistantMessageId,'Assistant ID'),callId:string(value.callId,'Call ID'),...value.callSeq===undefined?{}:{callSeq:integer(value.callSeq,'Call sequence')},turnStartSeq:integer(value.turnStartSeq,'Turn start')};}
function openingPointer(value){
  keys(value,['turnKey','source','receiptId']);const source=canonical(value.source);let identity;try{identity=JSON.parse(value.turnKey);}catch{invalid('Invalid canonical turn key');}
  if(!Array.isArray(identity)||identity.length!==2||typeof identity[0]!=='string'||!identity[0].trim()||identity[1]!==source.turnStartSeq||JSON.stringify(identity)!==value.turnKey)invalid('Canonical turn key does not match source');
  return {turnKey:value.turnKey,source,...value.receiptId===undefined?{}:{receiptId:string(value.receiptId,'Opening receipt ID')}};
}
function binding(value){
  keys(value,bindingKeys);if(value.schemaVersion!==1||!statuses.has(value.status))invalid('Unsupported StoryBinding version or status');keys(value.opening,['id','text']);
  const sources=normalizeSources(value.sources),refs=value.factEntryRefs;if(!Array.isArray(refs))invalid('Fact refs must be an array');const factEntryRefs=refs.map(ref),slots=new Set(['@session',...sources.map(source=>source.key)]);
  if(new Set(factEntryRefs.map(entryKey)).size!==factEntryRefs.length||factEntryRefs.some(item=>!slots.has(item.sourceKey))||!['gm.scene','gm.facts'].every(id=>factEntryRefs.some(item=>item.sourceKey==='@session'&&item.entryId===id)))invalid('Registered story state refs are invalid');
  return {schemaVersion:1,id:string(value.id,'Binding ID'),sessionId:string(value.sessionId,'Session ID'),launchId:string(value.launchId,'Launch ID'),title:string(value.title,'Story title'),status:value.status,character:normalizeCharacter(value.character),persona:normalizePersona(value.persona),opening:{id:string(value.opening.id,'Opening ID'),text:string(value.opening.text,'Opening text')},examples:string(value.examples,'Examples',true),sources,profile:normalizeProfileRef(value.profile),factEntryRefs,createdAt:string(value.createdAt,'Created at')};
}
function record(value){keys(value,['binding','parentSessionId','lastReceiptId','opening','review']);return {binding:binding(value.binding),...value.parentSessionId===undefined?{}:{parentSessionId:string(value.parentSessionId,'Parent Session ID')},...value.lastReceiptId===undefined?{}:{lastReceiptId:string(value.lastReceiptId,'Fact receipt ID')},...value.opening===undefined?{}:{opening:openingPointer(value.opening)},...value.review===undefined?{}:{review:normalizeReview(value.review,value.binding.sessionId)}};}
function launch(value){
  keys(value,['launchId','fingerprint','id','sessionId','promptRequestId','createdAt','progress','error']);if(typeof value.fingerprint!=='string'||!/^[a-f0-9]{64}$/u.test(value.fingerprint))invalid('Invalid launch fingerprint');keys(value.progress,['created','sources','initialized','profile','prompt']);if(Object.values(value.progress).some(item=>typeof item!=='boolean'))invalid('Invalid launch progress');
  let error;if(value.error!==undefined){keys(value.error,['code','message']);error={code:string(value.error.code,'Error code'),message:string(value.error.message,'Error message',true)};}
  return {launchId:string(value.launchId,'Launch ID'),fingerprint:value.fingerprint,id:string(value.id,'Binding ID'),sessionId:string(value.sessionId,'Session ID'),promptRequestId:string(value.promptRequestId,'Prompt request ID'),createdAt:string(value.createdAt,'Created at'),progress:clone(value.progress),...error?{error}:{}};
}
export function normalizeState(state,ids){
  try{
    keys(state,['schemaVersion','revision','payload']);if(state.schemaVersion!==1)invalid('Unsupported GM transfer schema');keys(state.payload,['bindings','launches']);if(!Array.isArray(state.payload.bindings)||!Array.isArray(state.payload.launches))invalid('GM payload requires binding and launch metadata');
    const compare=(a,b)=>a===b?0:a<b?-1:1,bindings=state.payload.bindings.map(record).sort((a,b)=>compare(a.binding.sessionId,b.binding.sessionId)),launches=state.payload.launches.map(launch).sort((a,b)=>compare(a.launchId,b.launchId));
    const byId=new Map(bindings.map(item=>[item.binding.sessionId,item])),byLaunch=new Map(launches.map(item=>[item.launchId,item]));if(byId.size!==bindings.length||byLaunch.size!==launches.length||bindings.length!==ids.length||ids.some(id=>!byId.has(id))||new Set(bindings.map(item=>item.binding.id)).size!==bindings.length)invalid('GM metadata identities do not match requested Sessions');
    for(const item of bindings){const startup=byLaunch.get(item.binding.launchId);if(!startup)invalid('Story launch metadata is missing');for(const dependency of [item.parentSessionId,startup.sessionId])if(dependency&&!byId.has(dependency))fail('RESTORE_REQUIREMENT_MISSING','Required GM ancestor metadata is missing',409,{requirement:`session:${dependency}`});}
    for(const startup of launches){const root=byId.get(startup.sessionId);if(!root||root.binding.launchId!==startup.launchId||root.binding.id!==startup.id||!bindings.some(item=>item.binding.launchId===startup.launchId))invalid('Launch ownership does not match binding metadata');}
    return {schemaVersion:1,revision:state.revision,payload:{bindings,launches}};
  }catch(error){if(['RESTORE_PAYLOAD_INVALID','RESTORE_REQUIREMENT_MISSING'].includes(error.code))throw error;invalid(`Invalid GM metadata: ${error.code??'INVALID_DATA'}`);}
}
