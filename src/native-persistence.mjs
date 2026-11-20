import {fail} from './core.mjs';

/** Cold session observations come from persistence. Live sources need a flush before use. */
export async function flushNativeSession(ctx,sessionId){
  const service=ctx.sessions,session=service?.get?.(sessionId)??ctx.agents.get(sessionId)?.session;
  if(session&&(typeof service?.flush!=='function'||!await service.flush(session)))
    fail('SESSION_PERSISTENCE_UNAVAILABLE','The host must provide per-session durable flush before confirming GM work',503);
}
