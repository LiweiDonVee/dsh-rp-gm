import {isDeepStrictEqual} from 'node:util';
import {clone,fail} from './core.mjs';

export function verifyInheritedPrefix(child,parent){
  const count=child.inheritedEventCount;
  if(!Number.isSafeInteger(count)||count<1||count>child.events.length||count>parent.events.length
    ||!isDeepStrictEqual(child.events.slice(0,count),parent.events.slice(0,count)))fail('INVALID_ANCESTRY','The child does not preserve the recorded parent prefix',409);
  return count;
}

/** Host-only provenance reader. It never refreshes GM or asks another RP owner. */
export function createSessionLineage({ctx,store,readSession}){
  async function observe(id,signal){
    signal?.throwIfAborted();
    if(!await readSession(id,signal))fail('SESSION_NOT_FOUND','The lineage Session is unavailable',404);
    const view=await ctx.sessionQuery.observeSession(id,{projectionMode:'none',signal});
    try{signal?.throwIfAborted();return{header:clone(view.header),events:clone(view.events),inheritedEventCount:view.inheritedEventCount};}
    finally{view[Symbol.dispose]();}
  }
  return async({sessionId,signal})=>{
    const child=await observe(sessionId,signal),record=await store.binding(sessionId),stored=record?.parentSessionId,legacy=child.header.parentSession;
    if(stored!==undefined&&legacy!==undefined&&stored!==legacy)fail('INVALID_ANCESTRY','GM lineage conflicts with the canonical legacy parent',409);
    const parentSessionId=stored??legacy??null;
    if(parentSessionId!==null){
      if(typeof parentSessionId!=='string'||!parentSessionId||parentSessionId===sessionId||stored!==undefined&&!await store.binding(parentSessionId))fail('INVALID_ANCESTRY','The recorded GM parent is unavailable',409);
      verifyInheritedPrefix(child,await observe(parentSessionId,signal));
    }
    return Object.freeze({sessionId,parentSessionId,inheritedEventCount:child.inheritedEventCount});
  };
}
