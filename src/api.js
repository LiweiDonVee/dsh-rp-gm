export function createGmApi(send=(...args)=>globalThis.fetch(...args),base=globalThis.document?.baseURI){
  async function request(action,input={},signal,path='api/rp-gm/request'){const response=await send(new URL(path,base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...input}),signal});let data;try{data=await response.json();}catch{throw Object.assign(new Error('无法读取故事响应，请重试。'),{status:response.status});}if(!response.ok||data?.error)throw Object.assign(new Error(data?.error?.message??'故事操作失败。'),{status:response.status,code:data?.error?.code,receiptId:data?.error?.receiptId});return data;}
  return {library:signal=>request('library',{},signal),startSample:(launchId,openingId,signal)=>request('startSample',{launchId,openingId},signal),state:(sessionId,signal)=>request('state',{sessionId},signal),
    reviewState:(sessionId,signal)=>request('reviewState',{sessionId},signal),
    configureReview:(input,signal)=>request('configureReview',input,signal),
    decideFacts:(input,signal)=>request('decideFacts',{decision:input},signal),
    resumeFactDecision:(input,signal)=>request('resumeFactDecision',input,signal),
    regenerateFacts:(input,signal)=>request('regenerateFacts',input,signal),
    resumeFactGeneration:(input,signal)=>request('resumeFactGeneration',input,signal),
    cancelFactGeneration:(input,signal)=>request('cancelFactGeneration',input,signal),
    resumeFactPresentation:(input,signal)=>request('resumeFactPresentation',input,signal),
    storyHistory:(sessionId,signal)=>request('storyHistory',{sessionId},signal,'api/rp-last-step/request'),
    regenerateProse:(input,signal)=>request('regenerateProse',input,signal,'api/rp-last-step/request'),
    subscribe(sessionId,onEvent,onError){const url=new URL('api/rp-gm/events',base);url.searchParams.set('sessionId',sessionId);const source=new EventSource(url);for(const type of ['connected','changed'])source.addEventListener(type,event=>{let value;try{value=JSON.parse(event.data);}catch{return;}if(value?.sessionId===sessionId)onEvent(value);});source.onerror=onError;return()=>source.close();},
  };
}
