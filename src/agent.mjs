import {fail,object} from './core.mjs';
export const TOOL_NAMES=Object.freeze(['rp_gm_state','rp_begin_story','rp_commit_turn']);
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const output={schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};

export async function registerGmAgent(ctx,runtime,contextFor) {
  const scopes=new Map(),cache=new WeakMap(),disposers=[];let stopped=false;
  const definitions=[
    {name:'rp_gm_state',description:'Read the current story scene, established facts, Database revision and active factual receipt.',parameters:schema({}),method:'toolState'},
    {name:'rp_begin_story',description:'Commit the owner-selected opening once. The seed and exact text come from the story binding, never tool arguments.',parameters:schema({}),method:'begin'},
    {name:'rp_commit_turn',description:'Atomically commit this turn once, respecting human policies. Reuse its receipt if presentation fails.',parameters:schema({expectedRevision:{type:'integer',minimum:0},scene:{type:'object'},facts:{type:'object'},operations:{type:'array',items:{type:'object'}},summary:{type:'string'},packet:{type:'object'}},['expectedRevision','summary','packet']),method:'commit'},
  ];
  async function attach(agent,retrySetup=false){
    if(stopped)return;const existing=scopes.get(agent);if(existing){if(retrySetup)await runtime.ensure(agent,existing.life.signal);return;}
    const record={tools:[],restriction:undefined,life:new AbortController()};scopes.set(agent,record);
    let bound;try{bound=await runtime.ensure(agent,record.life.signal);}catch(error){if(record.life.signal.aborted)return;scopes.delete(agent);throw error;}if(stopped||scopes.get(agent)!==record)return;
    if(bound&&ctx.tools.get('run_code',agent)===undefined){
      for(const definition of definitions)record.tools.push(agent.ctx.tools.register({...definition,output,execute:async(args,exec)=>{
        if(!object(args)||Object.keys(args).some(key=>!Object.hasOwn(definition.parameters.properties,key)))fail('INVALID_TOOL_ARGUMENTS','Unexpected GM tool arguments');
        exec.signal.throwIfAborted();return definition.method==='commit'?runtime.commit(args,exec):runtime[definition.method](exec);
      }}));
    }else{const inherited=TOOL_NAMES.filter(name=>ctx.tools.get(name,agent)!==undefined);if(inherited.length)record.restriction=agent.ctx.tools.restrict({deny:inherited});}
  }
  function release(agent){const record=scopes.get(agent);if(!record)return;record.life.abort();for(const dispose of record.tools.reverse())dispose();record.restriction?.();scopes.delete(agent);}
  disposers.push(ctx.on('agent/created',({agent})=>attach(agent)));
  disposers.push(ctx.on('agent/disposed',({agent})=>release(agent)));
  disposers.push(ctx.on('agent/pre-step',async({agent},next)=>{
    if(await runtime.reserved(agent.session.id)){try{await attach(agent,true);}catch{return {kind:'reject'};}if(await runtime.reserved(agent.session.id))return {kind:'reject'};}
    return next();
  }));
  disposers.push(ctx.systemPrompt.context({name:'rp-gm-state',order:280,required:true,interpolate:false,text:()=>cache.get(ctx.agents.currentInitiator())??''}));
  disposers.push(ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{const agent=ctx.agents.currentInitiator();if(agent&&await runtime.ensure(agent)){await runtime.assertPlayable(agent.session.id);await attach(agent);cache.set(agent,await contextFor(agent));}return next();},{prepend:true}));
  for(const agent of ctx.agents.list())await attach(agent);
  const close=()=>{if(stopped)return;stopped=true;for(const agent of scopes.keys())release(agent);for(const dispose of disposers.reverse())dispose();};
  close.sync=attach;return close;
}
