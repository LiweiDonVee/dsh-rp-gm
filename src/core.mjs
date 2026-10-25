import {createHash} from 'node:crypto';

export class GmError extends Error {
  constructor(code,message,status=400,details={}) {super(message);this.name='GmError';this.code=code;this.status=status;Object.assign(this,details);}
}
export const fail=(code,message,status,details)=>{throw new GmError(code,message,status,details);};
export const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const clone=value=>structuredClone(value);
export function freeze(value) {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function text(value,label,empty=false,code='INVALID_STORY') {if(typeof value!=='string'||(!empty&&!value.trim()))fail(code,`${label} must be ${empty?'a string':'a nonempty string'}`);return value;}
function keys(value,allowed,code='INVALID_STORY') {if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(code,'Unexpected fields');}
function positive(value,label) {if(!Number.isSafeInteger(value)||value<1)fail('INVALID_STORY',`${label} requires a positive version`);return value;}
function strings(value,label,distinct=false) {if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!item.trim())||(distinct&&new Set(value).size!==value.length))fail('INVALID_STORY',`${label} requires ${distinct?'distinct ':''}nonempty strings`);return [...value];}
function asset(value,persona=false) {
  keys(value,persona?['assetId','version','name','description']:['assetId','version','name','description','personality','scenario']);
  const fixed={};if(!persona)for(const key of ['description','personality','scenario'])if(value[key]!==undefined)fixed[key]=text(value[key],`Character ${key}`,true);
  return {assetId:text(value.assetId,'Asset ID'),version:positive(value.version,'Asset'),name:text(value.name,'Asset name'),...persona?{description:text(value.description,'Persona description',true)}:fixed};
}
export function normalizeScene(value) {
  keys(value,['schemaVersion','title','location','time','presentActorIds']);
  if(value.schemaVersion!==1)fail('INVALID_STORY','Scene schemaVersion must be 1');
  return {schemaVersion:1,title:text(value.title,'Scene title'),location:text(value.location,'Scene location'),...value.time===undefined?{}:{time:text(value.time,'Scene time',true)},presentActorIds:strings(value.presentActorIds,'Present actors',true)};
}
export function normalizeFacts(value) {
  keys(value,['schemaVersion','items']);if(value.schemaVersion!==1||!Array.isArray(value.items))fail('INVALID_STORY','Facts require schemaVersion 1 and items');
  const ids=new Set();const items=value.items.map(item=>{keys(item,['id','text']);const id=text(item.id,'Fact ID');if(ids.has(id))fail('INVALID_STORY','Fact IDs must be distinct');ids.add(id);return {id,text:text(item.text,'Fact text')};});
  return {schemaVersion:1,items};
}
export function normalizeStart(value) {
  keys(value,['launchId','title','character','persona','opening','examples','sources','profile','initialScene','initialFacts','signal']);
  keys(value.opening,['id','text']);
  if(!Array.isArray(value.sources))fail('INVALID_STORY','Sources must be a binding array');
  const used=new Set();const sources=value.sources.map(source=>{keys(source,['key','databaseId','version']);const key=text(source.key,'Source key');if(key==='@session'||used.has(key))fail('INVALID_STORY','Source keys must be distinct owner slots');used.add(key);return {key,databaseId:text(source.databaseId,'Database ID'),version:positive(source.version,'Source')};});
  let profile;if(value.profile!==undefined){keys(value.profile,['profileId','version']);profile={profileId:text(value.profile.profileId,'Profile ID'),version:positive(value.profile.version,'Profile')};}
  return freeze({launchId:text(value.launchId,'Launch ID'),title:text(value.title,'Story title'),character:asset(value.character),persona:asset(value.persona,true),opening:{id:text(value.opening.id,'Opening ID'),text:text(value.opening.text,'Opening text')},examples:text(value.examples??'','Examples',true),sources,...profile?{profile}:{},initialScene:normalizeScene(value.initialScene),initialFacts:normalizeFacts(value.initialFacts)});
}
function stable(value) {return Array.isArray(value)?value.map(stable):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;}
export const requestFingerprint=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const STATE_REFS=freeze([{sourceKey:'@session',entryId:'gm.scene'},{sourceKey:'@session',entryId:'gm.facts'}]);
export function createBinding(request,{id,sessionId,profile,createdAt}) {
  return freeze({schemaVersion:1,id,sessionId,launchId:request.launchId,title:request.title,status:'prepared',character:clone(request.character),persona:clone(request.persona),opening:clone(request.opening),examples:request.examples,sources:clone(request.sources),profile:clone(profile),factEntryRefs:clone(STATE_REFS),createdAt});
}
export function seedEntries(request) {
  return [['gm.scene','Current scene',request.initialScene],['gm.facts','Established facts',request.initialFacts]].map(([id,title,value])=>({id,title,content:JSON.stringify(value),keywords:[],tags:['gm-state'],notes:'',readOnly:false,mode:'auto',version:1}));
}
export function normalizePacket(value) {
  keys(value,['playerAction','sceneInstruction','resolvedChanges','visibleConsequences','openHooks','proseConstraints','publicFactRefs','variables'],'INVALID_PACKET');
  const result={playerAction:text(value.playerAction,'Player action',false,'INVALID_PACKET')};
  if(value.sceneInstruction!==undefined)result.sceneInstruction=text(value.sceneInstruction,'Scene instruction',true,'INVALID_PACKET');
  for(const key of ['resolvedChanges','visibleConsequences','openHooks','proseConstraints','publicFactRefs'])if(value[key]!==undefined){if(!Array.isArray(value[key])||value[key].some(item=>typeof item!=='string'))fail('INVALID_PACKET',`${key} must be strings`);result[key]=[...value[key]];}
  if(value.variables!==undefined){if(!object(value.variables)||Object.values(value.variables).some(item=>typeof item!=='string'))fail('INVALID_PACKET','Variables must contain public strings');result.variables=clone(value.variables);}
  return freeze(result);
}
export function normalizeTurn(value) {
  keys(value,['expectedRevision','scene','facts','operations','summary','packet'],'INVALID_TURN');
  if(!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0)fail('INVALID_TURN','expectedRevision is required');
  if(value.operations!==undefined&&(!Array.isArray(value.operations)||value.operations.some(op=>!object(op))))fail('INVALID_TURN','Operations must be objects');
  return freeze({expectedRevision:value.expectedRevision,...value.scene===undefined?{}:{scene:normalizeScene(value.scene)},...value.facts===undefined?{}:{facts:normalizeFacts(value.facts)},operations:clone(value.operations??[]),summary:text(value.summary,'Summary',false,'INVALID_TURN'),packet:normalizePacket(value.packet)});
}
export const entryKey=ref=>JSON.stringify([ref.sourceKey,ref.entryId]);
export function stateOperations(input,refs) {
  const protectedKeys=new Set(refs.map(entryKey));
  for(const op of input.operations)if(op.ref&&protectedKeys.has(entryKey(op.ref)))fail('STATE_OPERATION_REQUIRED','Use typed scene/facts for registered state');
  const operations=[];
  for(const [field,id] of [['scene','gm.scene'],['facts','gm.facts']])if(input[field]!==undefined){const ref=refs.find(item=>item.sourceKey==='@session'&&item.entryId===id);if(!ref)fail('STATE_UNAVAILABLE','Registered story state is unavailable',409);operations.push({op:'update',ref:clone(ref),patch:{content:JSON.stringify(input[field])}});}
  return [...operations,...clone(input.operations)];
}
export function readState(snapshot) {
  const find=id=>snapshot.entries.find(entry=>entry.ref?.sourceKey==='@session'&&entry.ref.entryId===id);
  let scene,facts;try{scene=normalizeScene(JSON.parse(find('gm.scene')?.content));facts=normalizeFacts(JSON.parse(find('gm.facts')?.content));}catch{fail('STATE_UNAVAILABLE','Enabled current story state is unavailable',409);}
  return {scene,facts};
}
