import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {clone,fail,requestFingerprint,text} from './core.mjs';
import {normalizeState} from './transfer-schema.mjs';

const queues=new Map();
const hash=value=>createHash('sha256').update(value).digest('hex');
const statuses=new Set(['prepared','starting','active','failed','restoring']);
const steps=new Set(['created','sources','initialized','profile','prompt']);
const bindingFields=new Set(['schemaVersion','id','sessionId','launchId','title','status','character','persona','opening','examples','sources','profile','factEntryRefs','createdAt']);

/** Atomic binding/launch metadata only. World entries and fact receipts live in Database. */
export function createBindingStore({directory}) {
  const root=resolve(text(directory,'Store directory')),path=join(root,'state.json'),queueKey=process.platform==='win32'?root.toLowerCase():root;
  async function read(){
    try{const state=JSON.parse(await readFile(path,'utf8'));state.revision??=0;if(state.schemaVersion!==1||!Number.isSafeInteger(state.revision)||state.revision<0||!state.launches||!state.bindings)fail('STORE_CORRUPT','Unsupported GM metadata',500);return state;}
    catch(error){if(error.code==='ENOENT')return {schemaVersion:1,revision:0,launches:{},bindings:{}};if(error instanceof SyntaxError)fail('STORE_CORRUPT','Invalid GM metadata JSON',500);throw error;}
  }
  function serial(work){const result=(queues.get(queueKey)??Promise.resolve()).then(work),settled=result.then(()=>{},()=>{});queues.set(queueKey,settled);void settled.then(()=>{if(queues.get(queueKey)===settled)queues.delete(queueKey);});return result;}
  const get=work=>serial(async()=>clone(work(await read())));
  async function mutate(work){return serial(async()=>{const state=await read(),before=JSON.stringify(state),result=await work(state);if(JSON.stringify(state)!==before){state.revision++;await mkdir(root,{recursive:true});const temporary=join(root,`.state-${randomUUID()}.tmp`);try{await writeFile(temporary,JSON.stringify(state),{encoding:'utf8',flag:'wx'});await rename(temporary,path);}catch(error){await rm(temporary,{force:true});throw error;}}return clone(result);});}
  function launchOf(state,id){const value=state.launches[hash(text(id,'Launch ID'))];if(!value)fail('LAUNCH_NOT_FOUND','Launch is unavailable',404);return value;}
  function bound(state,id){const value=state.bindings[hash(text(id,'Session ID'))];if(!value)fail('STORY_NOT_FOUND','Story binding is unavailable',404);return value;}
  return {
    contentRevision:()=>get(state=>({revision:state.revision})),
    exportSelection:ids=>get(state=>{const bindings=ids.map(id=>{const value=state.bindings[hash(id)];if(!value)fail('RESTORE_REQUIREMENT_MISSING','Selected GM binding is unavailable',409,{requirement:`gm-binding:${id}`});return value;}),launches=[...new Set(bindings.map(item=>item.binding.launchId))].map(id=>launchOf(state,id));return {schemaVersion:1,revision:state.revision,payload:{bindings,launches}};}),
    reserve(request){return mutate(state=>{const key=hash(request.launchId),fingerprint=requestFingerprint(request),existing=state.launches[key];if(existing){if(existing.fingerprint!==fingerprint)fail('LAUNCH_CONFLICT','This launch already belongs to a different reviewed request',409);return existing;}return state.launches[key]={launchId:request.launchId,fingerprint,id:randomUUID(),sessionId:randomUUID(),promptRequestId:randomUUID(),createdAt:new Date().toISOString(),progress:{}};});},
    launch:id=>get(state=>state.launches[hash(id)]??null),
    prepare(id,binding){return mutate(state=>{const launch=launchOf(state,id);if(Object.keys(binding).some(key=>!bindingFields.has(key))||binding.schemaVersion!==1||binding.sessionId!==launch.sessionId||binding.id!==launch.id||binding.launchId!==id)fail('INVALID_BINDING','Binding must contain only reviewed metadata');const existing=state.bindings[hash(binding.sessionId)];if(existing){const {status:oldStatus,...old}=existing.binding,{status:newStatus,...next}=binding;void oldStatus;void newStatus;if(requestFingerprint(old)!==requestFingerprint(next))fail('LAUNCH_CONFLICT','Prepared binding cannot change',409);return existing;}return state.bindings[hash(binding.sessionId)]={binding:clone(binding)};});},
    checkpoint(id,step){if(!steps.has(step))fail('INVALID_PROGRESS','Unknown launch step');return mutate(state=>{const launch=launchOf(state,id);launch.progress[step]=true;delete launch.error;return launch;});},
    binding:id=>get(state=>state.bindings[hash(id)]??null),
    bindings:()=>get(state=>Object.values(state.bindings)),
    setStatus(id,status){if(!statuses.has(status))fail('INVALID_STATUS','Unknown story status');return mutate(state=>{const value=bound(state,id);value.binding.status=status;return value;});},
    diagnostic(id,error){return mutate(state=>{const value=launchOf(state,id);value.error={code:String(error.code??'START_FAILED'),message:String(error.message??'Story startup failed')};return value;});},
    receipt(id,receiptId){return mutate(state=>{const value=bound(state,id);value.lastReceiptId=text(receiptId,'Receipt ID');return value;});},
    opening(id,source,replace=false){return mutate(state=>{const value=bound(state,id);if(!value.opening||replace)value.opening={turnKey:source.turnKey,source:clone(source.source)};if(source.receiptId){if(value.opening.receiptId&&value.opening.receiptId!==source.receiptId)fail('OPENING_CONFLICT','Opening receipt identity cannot change',409);value.opening.receiptId=source.receiptId;}return value.opening;});},
    inherit(parentId,childId){return mutate(state=>{const existing=state.bindings[hash(childId)];if(existing)return existing;const parent=bound(state,parentId);return state.bindings[hash(childId)]={binding:{...clone(parent.binding),id:randomUUID(),sessionId:childId,status:'restoring'},parentSessionId:parentId,...parent.lastReceiptId?{lastReceiptId:parent.lastReceiptId}:{},...parent.opening?{opening:clone(parent.opening)}:{}};});},
    gate:id=>get(state=>state.restoreGates?.[hash(id)]??null),
    restoreJob:id=>get(state=>state.restoreJobs?.[hash(id)]??null),
    previewTransfer(input){return get(state=>{
      const fingerprint=requestFingerprint(input),matching=Object.values(state.restoreTransfers??{}).find(job=>job.fingerprint===fingerprint&&job.sessionIds.every(id=>state.restoreGates?.[hash(id)]?.restoreId===job.restoreId)),conflicts=[];
      for(const id of input.sessionIds)if(state.bindings[hash(id)]&&!matching?.sessionIds.includes(id))conflicts.push({code:'RESTORE_ID_CONFLICT',id});
      for(const startup of input.state.payload.launches)if(state.launches[hash(startup.launchId)]&&!matching)conflicts.push({code:'RESTORE_ID_CONFLICT',id:startup.launchId});return conflicts;
    });},
    restoreTransfer(input,verify,signal){return mutate(async state=>{
      const fingerprint=requestFingerprint({sessionIds:input.sessionIds,state:input.state}),prior=state.restoreTransfers?.[hash(input.restoreId)],reservation=state.restoreJobs?.[hash(input.restoreId)];
      if(prior){if(prior.fingerprint!==fingerprint)fail('RESTORE_ID_CONFLICT','Restore identity already belongs to different GM metadata',409);return prior.result;}
      if(reservation&&requestFingerprint(reservation.sessionIds)!==requestFingerprint(input.sessionIds))fail('RESTORE_ID_CONFLICT','Restore destination set cannot change',409);
      for(const id of input.sessionIds){if(state.bindings[hash(id)])fail('RESTORE_ID_CONFLICT','Destination GM binding already exists',409);const gate=state.restoreGates?.[hash(id)];if(gate&&gate.restoreId!==input.restoreId)fail('RESTORE_ID_CONFLICT','Another restore job owns this destination',409);}
      const incoming=normalizeState(input.state,input.sessionIds);
      if(input.expectedRevision!==state.revision)fail('REVISION_CONFLICT','GM metadata changed; reload its content revision',409);
      if(!reservation||input.sessionIds.some(id=>state.restoreGates?.[hash(id)]?.restoreId!==input.restoreId))fail('RESTORE_REQUIREMENT_MISSING','Reserve GM execution before restoring metadata',409);
      for(const startup of incoming.payload.launches)if(state.launches[hash(startup.launchId)])fail('RESTORE_ID_CONFLICT','Destination launch identity already exists',409);
      await verify(incoming);signal?.throwIfAborted();
      for(const startup of incoming.payload.launches)state.launches[hash(startup.launchId)]=clone(startup);
      for(const record of incoming.payload.bindings){state.restoreGates[hash(record.binding.sessionId)].priorStatus=record.binding.status;state.bindings[hash(record.binding.sessionId)]={...clone(record),binding:{...clone(record.binding),status:'restoring'}};}
      const result={revision:state.revision+1,restoredSessionIds:[...input.sessionIds]};state.restoreTransfers??={};state.restoreTransfers[hash(input.restoreId)]={restoreId:input.restoreId,fingerprint,sessionIds:[...input.sessionIds],result};return result;
    });},
    reserveRestore(restoreId,sessionIds){return mutate(state=>{
      state.restoreGates??={};state.restoreJobs??={};const key=hash(restoreId),ids=[...sessionIds].sort(),job=state.restoreJobs[key];
      if(job&&requestFingerprint(job.sessionIds)!==requestFingerprint(ids))fail('RESTORE_ID_CONFLICT','Restore reservation identity cannot change',409);
      for(const id of ids){const gate=state.restoreGates[hash(id)];if(gate&&gate.restoreId!==restoreId)fail('RESTORE_ID_CONFLICT','Another restore job owns this destination',409);}
      if(job?.complete)return job;
      for(const id of ids){const record=state.bindings[hash(id)];state.restoreGates[hash(id)]??={restoreId,priorStatus:record?.binding.status??'starting'};if(record)record.binding.status='restoring';}
      return state.restoreJobs[key]??={restoreId,sessionIds:ids,complete:false};
    });},
    activateRestored(restoreId,sessionIds){return mutate(state=>{
      const job=state.restoreJobs?.[hash(restoreId)];if(!job)fail('RESTORE_ID_CONFLICT','Restore job does not own these destinations',409);if(job.complete)return job;
      for(const id of sessionIds){const gate=state.restoreGates?.[hash(id)];if(gate?.restoreId!==restoreId)fail('RESTORE_ID_CONFLICT','Restore job does not own this destination',409);bound(state,id);}
      for(const id of sessionIds){const gate=state.restoreGates[hash(id)];bound(state,id).binding.status=['prepared','starting','active','failed'].includes(gate.priorStatus)?gate.priorStatus:'starting';delete state.restoreGates[hash(id)];}
      job.complete=job.sessionIds.every(id=>state.restoreGates[hash(id)]?.restoreId!==restoreId);return job;
    });},
  };
}
