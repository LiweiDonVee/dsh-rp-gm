import {GmError,object} from './core.mjs';import {SAMPLE,sampleStory} from './samples.mjs';
import {normalizeDecision} from './review-schema.mjs';
const fields={library:[],startSample:['launchId','openingId'],startStory:['launchId','title','character','persona','opening','examples','sources','profile','initialScene','initialFacts'],state:['sessionId'],binding:['sessionId']};
Object.assign(fields,{reviewState:['sessionId'],configureReview:['sessionId','enabled','expectedRevision'],decideFacts:['decision'],resumeFactDecision:['sessionId','operationId'],regenerateFacts:['sessionId','roundId','operationId','expectedRoundVersion','instruction'],resumeFactGeneration:['sessionId','operationId'],cancelFactGeneration:['sessionId','jobId'],resumeFactPresentation:['sessionId','roundId','operationId']});
const id=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256;
const failure=(status,code,message,receiptId)=>Response.json({error:{code,message,...typeof receiptId==='string'?{receiptId}:{}}},{status,headers:{'cache-control':'no-store'}});
function errorResponse(error){if(error instanceof GmError||error?.name==='DatabaseError'||error?.name==='PresetError')return failure(error.status??400,error.code,error.message,error.receiptId);if(error?.name==='AbortError')return failure(499,'CANCELLED','The operation was cancelled');return failure(503,'UNAVAILABLE','Story service is temporarily unavailable');}

export function createGmRoutes(service){
  let stopped=false;const streams=new Set();
  return {
    async request(request){
      if(stopped)return failure(503,'UNAVAILABLE','GM plugin is unloaded');
      let input;try{input=await request.json();}catch{return failure(400,'INVALID_REQUEST','A JSON operation is required');}
      if(!object(input)||!Object.hasOwn(fields,input.action)||Object.keys(input).some(key=>key!=='action'&&!fields[input.action].includes(key)))return failure(400,'INVALID_REQUEST','Unexpected story operation fields');
      if(fields[input.action].includes('sessionId')&&!id(input.sessionId)||input.action==='startSample'&&(!id(input.launchId)||!id(input.openingId)))return failure(400,'INVALID_REQUEST','A valid story identity is required');
      try{
        request.signal.throwIfAborted();const {action,...args}=input;let result;
        if(action==='library')result={apiVersion:1,...await service.listStories({signal:request.signal}),dependencies:await service.diagnostics(),sample:SAMPLE};
        else if(action==='startSample')result=await service.startStory({...sampleStory(args),signal:request.signal});
        else if(action==='decideFacts')result=await service.decideFacts({...normalizeDecision(args.decision),signal:request.signal});
        else result=await service[action==='state'?'storyState':action]({...args,signal:request.signal});
        return Response.json(result,{headers:{'cache-control':'no-store'}});
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
