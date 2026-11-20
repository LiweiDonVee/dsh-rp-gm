import {randomUUID} from 'node:crypto';

// Match rc.1 exclusive barriers: each call and its result are persisted before
// the next exclusive call starts. Also cover histories with calls logged first.
export async function nativeBatch(f,id,tools,{allCallsBeforeResults=false}={}){
  const agent=f.sessions.get(id);f.ctx.currentAgent=agent;
  let start=agent.events.findLast(event=>event.type==='turn/start');
  if(!start||agent.events.findLast(event=>event.type==='turn/end')?.seq>start.seq)start=f.startTurn(id).start;
  const turn=start.data.turn,step=agent.events.filter(event=>event.type==='assistant/message'&&event.data.turn===turn).length+1;
  const blocks=tools.map(tool=>({type:'tool-call',id:randomUUID(),name:tool.name,arguments:JSON.stringify(tool.args??{})}));
  const assistant=f.append(agent,'assistant/message',{turn,step,message:{id:randomUUID(),role:'assistant',content:blocks}},'append');
  const appendCall=block=>f.append(agent,'tool/call',{turn,step,callId:block.id,name:block.name,arguments:block.arguments});
  const calls=allCallsBeforeResults?blocks.map(appendCall):[];
  const results=[];let concluded=false;
  for(const [index,block]of blocks.entries()){
    calls[index]??=appendCall(block);
    const definition=agent.tools.get(block.name),args=tools[index].args??{};
    let value,error;
    try{if(!definition)throw Error(`Tool unavailable: ${block.name}`);value=await definition.execute(args,{agent,callId:block.id,rootCallId:block.id,signal:new AbortController().signal,concludeTurn:()=>{concluded=true;}});}catch(caught){error=caught;}
    const content=error?[{type:'text',text:`Error: ${error.message}`}]:definition.output?.render?.(args,value)??[{type:'text',text:JSON.stringify(value)}];
    const result=f.append(agent,'tool/result',{turn,step,message:{id:randomUUID(),role:'tool',toolCallId:block.id,source:{kind:'tool',callId:block.id},content,...error?{isError:true}:{}}},'append',[calls[index].seq]);
    await f.emit('session/event',agent.session,result);results.push({value,error,event:result});
  }
  if(concluded)f.append(agent,'turn/end',{turn,reason:'completed'});
  return {assistant,calls,results,concluded};
}
