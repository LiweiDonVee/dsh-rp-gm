import {GmError,object,requestFingerprint} from './core.mjs';import {SAMPLE,sampleStory} from './samples.mjs';
import {normalizeDecision} from './review-schema.mjs';
import {OPERATION_ACCEPTED,OPERATION_HTTP_STATUS} from './operations.mjs';
const fields={library:[],startSample:['launchId','openingId'],startStory:['launchId','title','character','persona','opening','examples','sources','profile','initialScene','initialFacts'],state:['sessionId'],binding:['sessionId']};
Object.assign(fields,{reviewState:['sessionId'],configureReview:['sessionId','enabled','expectedRevision'],decideFacts:['decision'],resumeFactDecision:['sessionId','operationId'],regenerateFacts:['sessionId','roundId','operationId','expectedRoundVersion','instruction'],resumeFactGeneration:['sessionId','operationId'],cancelFactGeneration:['sessionId','jobId'],resumeFactPresentation:['sessionId','roundId','operationId']});
Object.assign(fields,{submitOperation:['sessionId','operationId','kind','input'],operation:['sessionId','launchId','operationId'],operations:['sessionId','launchId'],cancelOperation:['sessionId','launchId','operationId']});
fields.cancelTurn=['sessionId','expectedTurnStartSeq'];
const id=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256;
const failure=(status,code,message,receiptId)=>Response.json({error:{code,message,...typeof receiptId==='string'?{receiptId}:{}}},{status,headers:{'cache-control':'no-store'}});
function errorResponse(error){if(error instanceof GmError||error?.name==='DatabaseError'||error?.name==='PresetError')return failure(error.status??400,error.code,error.message,error.receiptId);if(error?.name==='AbortError')return failure(499,'CANCELLED','The operation was cancelled');return failure(503,'UNAVAILABLE','Story service is temporarily unavailable');}

export function createGmRoutes(service){
  let stopped=false;const streams=new Set();
  async function startDetached(input,signal){
    if(typeof service.submitOperation!=='function')return service.startStory({...input,signal});
    let history;try{history=await service.operations({launchId:input.launchId,signal});}catch(error){if(error.code!=='OPERATION_NOT_FOUND')throw error;}
    const previous=history?.operations.findLast(value=>value.kind==='startStory'),operationId=previous&&['accepted','running','cancelling','complete'].includes(previous.status)?previous.operationId:`launch.${requestFingerprint({launchId:input.launchId,previous:previous?.operationId??null})}`;
    let receipt=await service.submitOperation({operationId,kind:'startStory',input},signal);
    while(['accepted','running','cancelling'].includes(receipt.operation.status)){
      await new Promise((resolve,reject)=>{signal.throwIfAborted();const aborted=()=>{clearTimeout(timer);reject(signal.reason);},timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},100);signal.addEventListener('abort',aborted,{once:true});});
      receipt=await service.operation({launchId:input.launchId,operationId,signal});
    }
    if(receipt.operation.status==='complete')return receipt.operation.result;
    throw new GmError(receipt.operation.error?.code??'HOST_INTERRUPTED',receipt.operation.error?.message??'Story startup did not complete; read its operation state',receipt[OPERATION_HTTP_STATUS]??409);
  }
  return {
    async request(request){
      if(stopped)return failure(503,'UNAVAILABLE','GM plugin is unloaded');
      let input;try{input=await request.json();}catch{return failure(400,'INVALID_REQUEST','A JSON operation is required');}
      if(!object(input)||!Object.hasOwn(fields,input.action)||Object.keys(input).some(key=>key!=='action'&&!fields[input.action].includes(key)))return failure(400,'INVALID_REQUEST','Unexpected story operation fields');
      const operationAction=['submitOperation','operation','operations','cancelOperation'].includes(input.action);
      if(!operationAction&&fields[input.action].includes('sessionId')&&!id(input.sessionId)||input.action==='startSample'&&(!id(input.launchId)||!id(input.openingId))||operationAction&&(input.sessionId!==undefined&&!id(input.sessionId)||input.launchId!==undefined&&!id(input.launchId)))return failure(400,'INVALID_REQUEST','A valid story identity is required');
      try{
        request.signal.throwIfAborted();const {action,...args}=input;let result;
        if(action==='library')result={apiVersion:1,...await service.listStories({signal:request.signal}),dependencies:await service.diagnostics(),sample:SAMPLE};
        else if(action==='startSample')result=await startDetached(sampleStory(args),request.signal);
        else if(action==='startStory')result=await startDetached(args,request.signal);
        else if(action==='submitOperation')result=await service.submitOperation(args,request.signal);
        else if(action==='operation')result=await service.operation({...args,signal:request.signal});
        else if(action==='operations')result=await service.operations({...args,signal:request.signal});
        else if(action==='cancelOperation')result=await service.cancelOperation(args,request.signal);
        else if(action==='cancelTurn')result=await service.cancelTurn(args);
        else if(action==='decideFacts')result=await service.decideFacts({...normalizeDecision(args.decision),signal:request.signal});
        else result=await service[action==='state'?'storyState':action]({...args,signal:request.signal});
        return Response.json(result,{status:action==='submitOperation'&&result?.[OPERATION_ACCEPTED]===true?202:200,headers:{'cache-control':'no-store'}});
      }catch(error){return errorResponse(error);}
    },
    async events(request){
      if(stopped)return failure(503,'UNAVAILABLE','GM plugin is unloaded');const sessionId=new URL(request.url).searchParams.get('sessionId');if(!id(sessionId))return failure(400,'INVALID_REQUEST','A session is required');
      try{
        if(!await service.binding({sessionId,signal:request.signal}))return failure(404,'STORY_NOT_FOUND','Story binding is unavailable');
        if(stopped||request.signal.aborted)return new Response(null,{status:204});let cleanup=()=>{};
        const body=new ReadableStream({start(controller){
          let closed=false,unsubscribe=()=>{};const encoder=new TextEncoder();
          const write=(type,data)=>{if(closed)return;const bytes=encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);if(controller.desiredSize<bytes.byteLength){cleanup();return;}controller.enqueue(bytes);};
          const aborted=()=>cleanup();const timer=setInterval(()=>write('heartbeat',{sessionId}),15000);timer.unref?.();
          cleanup=cancelled=>{if(closed)return;closed=true;clearInterval(timer);unsubscribe();streams.delete(cleanup);request.signal.removeEventListener('abort',aborted);if(cancelled!==true)controller.close();};
          streams.add(cleanup);request.signal.addEventListener('abort',aborted,{once:true});unsubscribe=service.subscribe(sessionId,()=>write('changed',{type:'changed',sessionId}));
          if(stopped||request.signal.aborted)cleanup();else write('connected',{type:'connected',sessionId});
        },cancel(){cleanup(true);}},{highWaterMark:16384,size:chunk=>chunk.byteLength});
        return new Response(body,{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'}});
      }catch(error){return errorResponse(error);}
    },
    close(){stopped=true;for(const close of streams)close();},
  };
}
