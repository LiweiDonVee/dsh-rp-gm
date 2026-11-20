import {clone,fail,normalizeStart,object,requestFingerprint,text} from './core.mjs';
import {exactFields,normalizeDecision,operationToken,revision} from './review-schema.mjs';

export const OPERATION_ACCEPTED=Symbol.for('dsh.rp.operation.accepted');
export const OPERATION_HTTP_STATUS=Symbol('operationHttpStatus');
export const OWNER_CANCELLED=new DOMException('The owner cancelled this operation','AbortError');
const pending=value=>['accepted','running','cancelling'].includes(value.status);
const scopeOf=value=>({...value.launchId?{launchId:value.launchId}:{sessionId:value.sessionId},operationId:value.operationId});

export function operationEnvelope(value,accepted=false){
  const {operationId,sessionId,launchId,kind,status,revision,createdAt,updatedAt,result,error}=value;
  const operation={operationId,sessionId,kind,status,revision,createdAt,updatedAt};
  if(launchId)operation.launchId=launchId;
  if(result!==undefined)operation.result=clone(result);
  if(error)operation.error={code:error.code,...error.message?{message:error.message}:{}};
  const envelope={schemaVersion:1,operation};
  if(accepted)Object.defineProperty(envelope,OPERATION_ACCEPTED,{value:true});
  if(error?.httpStatus)Object.defineProperty(envelope,OPERATION_HTTP_STATUS,{value:error.httpStatus});
  return envelope;
}

export function normalizeOperation(value){
  exactFields(value,['sessionId','operationId','kind','input']);
  const operationId=operationToken(value.operationId),kind=text(value.kind,'Operation kind');
  if(!object(value.input)||['sessionId','operationId','signal'].some(key=>Object.hasOwn(value.input,key)))fail('INVALID_REVIEW_REQUEST','Operation input cannot override its context or signal');
  if(kind==='startStory')return {operationId,kind,...value.sessionId!==undefined?{sessionId:text(value.sessionId,'Session ID')}:{},input:normalizeStart(value.input)};
  const sessionId=text(value.sessionId,'Session ID');let input;
  if(kind==='decideFacts'){
    input=normalizeDecision({...value.input,sessionId,operationId});
    delete input.sessionId;
    delete input.operationId;
  }else if(kind==='regenerateFacts'){
    exactFields(value.input,['roundId','expectedRoundVersion','instruction']);
    input={
      roundId:text(value.input.roundId,'Round ID'),
      expectedRoundVersion:revision(value.input.expectedRoundVersion),
      instruction:text(value.input.instruction??'','Instruction',true,'INVALID_REVIEW_REQUEST'),
    };
  }else if(['resumeFactDecision','resumeFactGeneration','resumeFactPresentation'].includes(kind)){
    const presentation=kind==='resumeFactPresentation';
    exactFields(value.input,presentation?['roundId','targetOperationId']:['targetOperationId']);
    input={targetOperationId:operationToken(value.input.targetOperationId??operationId)};
    if(presentation)input.roundId=text(value.input.roundId,'Round ID');
  }else fail('INVALID_REVIEW_REQUEST','This operation kind is not supported');
  return {sessionId,operationId,kind,input};
}

export function operationScope(input,list=false){
  exactFields(input,list?['sessionId','launchId','signal']:['sessionId','launchId','operationId','signal']);
  if(!input.sessionId&&!input.launchId)fail('INVALID_REVIEW_REQUEST','A session or launch identity is required');
  return {...input.sessionId!==undefined?{sessionId:text(input.sessionId,'Session ID')}:{},...input.launchId!==undefined?{launchId:text(input.launchId,'Launch ID')}:{},...list?{}:{operationId:operationToken(input.operationId)}};
}
export function domainInput(operation,signal){
  const {targetOperationId,...input}=operation.input;return {...clone(input),...operation.kind==='startStory'?{}:{sessionId:operation.sessionId,operationId:targetOperationId??operation.operationId},...signal?{signal}:{}};
}

/** Request lifetimes end at the durable receipt. Only the PC owner can abort execution. */
export function createGmOperations({store,authorize,execute,reconcile,notify}){
  const runs=new Map(),admissions=new Set();let closed=false,recovery,closing;
  const assertOpen=()=>{if(closed)fail('UNAVAILABLE','GM plugin is unloaded',503);};
  const changed=operation=>{if(operation.sessionId)notify(operation.sessionId);};
  async function update(operation,work){const value=await store.updateOperation(scopeOf(operation),work);changed(value);return value;}
  async function evidence(operation){
    try{return await reconcile(operation);}
    catch(error){
      if(['DECISION_NOT_CONFIRMED','DECISION_SOURCE_INVALID'].includes(error?.code))return null;
      return undefined;
    }
  }
  async function recover(){
    recovery??=(async()=>{
      for(const operation of await store.operations()){
        if(!pending(operation)&&!['interrupted','complete'].includes(operation.status))continue;
        const outcome=await evidence(operation);
        await update(operation,current=>{
          if(current.status==='complete'){
            // Older packages could persist complete while the native command was still buffered.
            // An unavailable proof reader leaves the original result available for a later check.
            if(outcome!==undefined&&outcome?.status!=='complete'){
              current.status='interrupted';
              current.error={code:'NATIVE_COMPLETION_UNCONFIRMED'};
            }
            return;
          }
          if(!pending(current)&&current.status!=='interrupted')return;
          current.status=outcome?.status??'interrupted';
          if(outcome?.result!==undefined)current.result=clone(outcome.result);
          if(outcome)delete current.error;
          else current.error??={code:'HOST_INTERRUPTED'};
        });
      }
    })();
    return recovery;
  }
  async function finish(operation,outcome,fallback){
    return update(operation,current=>{
      if(current.status==='complete'||current.status==='cancelled')return;
      if(outcome){current.status=outcome.status;if(outcome.result!==undefined)current.result=clone(outcome.result);delete current.error;}
      else if(pending(current)){current.status=fallback.status;current.error=fallback.error;if(fallback.result!==undefined)current.result=clone(fallback.result);}
    });
  }
  async function run(operation,life){
    try{
      const current=await update(operation,value=>{if(value.status==='accepted')value.status='running';});
      if(current.status==='cancelling'){
        await finish(operation,await evidence(operation),{status:'cancelled',error:{code:'CANCELLED'}});
        return;
      }
      if(current.status!=='running')return;
      life.signal.throwIfAborted();
      const result=await execute(operation.kind,domainInput(operation,life.signal));
      // A result may arrive after cancellation. Confirm durable domain state before calling that race complete.
      const outcome=life.signal.aborted?await evidence(operation):{status:'complete',result};
      await finish(operation,outcome,{status:'cancelled',result,error:{code:'CANCELLED'}});
    }catch(error){
      const outcome=await evidence(operation);
      const cancelled=life.signal.reason===OWNER_CANCELLED;
      const recognized=['GmError','DatabaseError','PresetError'].includes(error?.name);
      const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)?error.code:'OPERATION_FAILED';
      const message=recognized?error.message:'The story operation failed';
      const httpStatus=recognized?error.status??400:503;
      await finish(operation,outcome,cancelled
        ?{status:'cancelled',error:{code:'CANCELLED'}}
        :{status:'failed',error:{code,message,httpStatus}});
    }
  }
  function schedule(operation){
    const key=JSON.stringify(scopeOf(operation)),life=new AbortController(),task={life,operation,promise:null};runs.set(key,task);
    task.promise=run(operation,life).finally(()=>runs.delete(key));
    // The caller has already received a durable receipt. Failed persistence is visible as interrupted on restart.
    void task.promise.catch(()=>{});
  }
  async function submit(input,signal){
    assertOpen();signal?.throwIfAborted();
    const normalized=normalizeOperation(input);
    await recover();assertOpen();
    const identity=await authorize(normalized,true,signal);assertOpen();signal?.throwIfAborted();
    const createdAt=new Date().toISOString(),operation={...normalized,...identity,fingerprint:requestFingerprint({kind:normalized.kind,input:normalized.input}),status:'accepted',revision:1,createdAt,updatedAt:createdAt};
    const accepted=await store.acceptOperation(operation);changed(accepted.operation);
    if(accepted.created){if(closed)return operationEnvelope(await update(accepted.operation,value=>{value.status='interrupted';value.error={code:'HOST_INTERRUPTED'};}),true);schedule(accepted.operation);}
    return operationEnvelope(accepted.operation,accepted.created);
  }
  const api={
    recover,
    submitOperation(input,signal){const promise=submit(input,signal);admissions.add(promise);void promise.finally(()=>admissions.delete(promise)).catch(()=>{});return promise;},
    async operation(input){assertOpen();const scope=operationScope(input);await recover();await authorize(scope,false,input.signal);const operation=await store.operation(scope);if(!operation)fail('OPERATION_NOT_FOUND','The stored operation is unavailable',404);return operationEnvelope(operation);},
    async operations(input){assertOpen();const scope=operationScope(input,true);await recover();await authorize(scope,false,input.signal);return {schemaVersion:1,operations:(await store.operations(scope)).map(operation=>operationEnvelope(operation).operation)};},
    async cancelOperation(input,signal){
      assertOpen();const scope=operationScope(input);await recover();await authorize(scope,false,signal);signal?.throwIfAborted();
      const found=await store.operation(scope);if(!found)fail('OPERATION_NOT_FOUND','The stored operation is unavailable',404);
      const operation=await update(found,value=>{if(['accepted','running'].includes(value.status))value.status='cancelling';});
      if(operation.status==='cancelling'){
        const task=runs.get(JSON.stringify(scopeOf(operation)));
        if(task)task.life.abort(OWNER_CANCELLED);
        else await finish(operation,await evidence(operation),{status:'cancelled',error:{code:'CANCELLED'}});
      }
      return operationEnvelope(await store.operation(scope));
    },
    isLive:sessionId=>[...runs.values()].some(task=>task.operation.sessionId===sessionId),
    close(){
      if(closing)return closing;closed=true;
      closing=(async()=>{
        await Promise.allSettled(admissions);await recover();
        const active=[...runs.values()];
        // Record owner shutdown before aborting domain work; AbortError cannot turn it into user cancellation.
        for(const task of active)await update(task.operation,value=>{if(pending(value)){value.status='interrupted';value.error={code:'HOST_INTERRUPTED'};}});
        for(const task of active)task.life.abort(new DOMException('The PC host stopped','AbortError'));
        await Promise.allSettled(active.map(task=>task.promise));
      })();return closing;
    },
  };return api;
}
