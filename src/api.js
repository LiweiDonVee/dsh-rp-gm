export function createGmApi(send=(...args)=>globalThis.fetch(...args),base=globalThis.document?.baseURI){
  async function request(action,input={},signal,path='api/rp-gm/request'){const response=await send(new URL(path,base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...input}),signal});let data;try{data=await response.json();}catch{throw Object.assign(new Error('无法读取故事响应，请重试。'),{status:response.status});}if(!response.ok||data?.error)throw Object.assign(new Error(data?.error?.message??'故事操作失败。'),{status:response.status,code:data?.error?.code,receiptId:data?.error?.receiptId});return data;}
  function pause(signal){return new Promise((resolve,reject)=>{signal?.throwIfAborted();const aborted=()=>{clearTimeout(timer);reject(signal.reason);},timer=setTimeout(()=>{signal?.removeEventListener('abort',aborted);resolve();},300);signal?.addEventListener('abort',aborted,{once:true});});}
  async function perform(kind,input,signal,path='api/rp-gm/request'){
    const {sessionId,operationId,...payload}=input,resuming=kind.startsWith('resume');
    const operation={sessionId,operationId:resuming?crypto.randomUUID():operationId,kind,input:resuming?{...payload,targetOperationId:operationId}:payload};
    let receipt=await request('submitOperation',operation,signal,path);
    while(['accepted','running','cancelling'].includes(receipt.operation.status)){await pause(signal);receipt=await request('operation',{sessionId,operationId:operation.operationId},signal,path);}
    if(receipt.operation.status==='complete')return receipt.operation.result;
    throw Object.assign(new Error(receipt.operation.error?.message??({cancelled:'操作已取消。',interrupted:'电脑执行已中断，请读取当前状态后恢复。'}[receipt.operation.status]??'故事操作失败。')),{code:receipt.operation.error?.code??receipt.operation.status.toUpperCase(),operation:receipt.operation});
  }
  return {library:signal=>request('library',{},signal),startSample:(launchId,openingId,signal)=>request('startSample',{launchId,openingId},signal),state:(sessionId,signal)=>request('state',{sessionId},signal),
    submitOperation:(input,signal)=>request('submitOperation',input,signal),
    operation:(input,signal)=>request('operation',input,signal),
    operations:(input,signal)=>request('operations',input,signal),
    cancelOperation:(input,signal)=>request('cancelOperation',input,signal),
    cancelTurn:(input,signal)=>request('cancelTurn',input,signal),
    reviewState:(sessionId,signal)=>request('reviewState',{sessionId},signal),
    configureReview:(input,signal)=>request('configureReview',input,signal),
    decideFacts:(input,signal)=>perform('decideFacts',input,signal),
    resumeFactDecision:(input,signal)=>perform('resumeFactDecision',input,signal),
    regenerateFacts:(input,signal)=>perform('regenerateFacts',input,signal),
    resumeFactGeneration:(input,signal)=>perform('resumeFactGeneration',input,signal),
    cancelFactGeneration:(input,signal)=>request('cancelFactGeneration',input,signal),
    resumeFactPresentation:(input,signal)=>perform('resumeFactPresentation',input,signal),
    storyHistory:(sessionId,signal)=>request('storyHistory',{sessionId},signal,'api/rp-last-step/request'),
    regenerateProse:(input,signal)=>request('regenerateProse',input,signal,'api/rp-last-step/request'),
    subscribe(sessionId,onEvent,onError){const url=new URL('api/rp-gm/events',base);url.searchParams.set('sessionId',sessionId);const source=new EventSource(url);for(const type of ['connected','changed'])source.addEventListener(type,event=>{let value;try{value=JSON.parse(event.data);}catch{return;}if(value?.sessionId===sessionId)onEvent(value);});source.onerror=onError;return()=>source.close();},
  };
}
