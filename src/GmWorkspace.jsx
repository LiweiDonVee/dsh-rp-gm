import React,{useEffect,useRef,useState} from 'react';import {createGmApi} from './api.js';
const defaultApi=createGmApi(),PENDING_KEY='dsh-rp-gm.pending-sample.v1';
const labels={prepared:'已准备',starting:'开场进行中',active:'进行中',failed:'启动待恢复',restoring:'分支待恢复'};
function savedLaunch(){try{const value=JSON.parse(sessionStorage.getItem(PENDING_KEY));return typeof value?.launchId==='string'&&typeof value?.openingId==='string'?value:null;}catch{return null;}}
function saveLaunch(value){try{if(value)sessionStorage.setItem(PENDING_KEY,JSON.stringify(value));else sessionStorage.removeItem(PENDING_KEY);}catch{/* The current panel still keeps its retry identity. */}}
export function GmIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4zM20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h3z"/></svg>;}

export function GmWorkspace({sessionId,visible=true,api=defaultApi}){
  const [library,setLibrary]=useState(null),[snapshot,setSnapshot]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState(sessionId??''),[pending,setPending]=useState(savedLaunch),[openingId,setOpeningId]=useState(()=>savedLaunch()?.openingId??'rain'),[created,setCreated]=useState(false);
  const stateView=snapshot?.sessionId===selected?snapshot:null,state=stateView?.data;
  const activeRequest=useRef(null);
  useEffect(()=>{if(!visible)return;const life=new AbortController();api.library(life.signal).then(setLibrary).catch(error=>{if(!life.signal.aborted)setError(error.message);});return()=>life.abort();},[api,visible]);
  useEffect(()=>{if(sessionId)setSelected(sessionId);},[sessionId]);
  useEffect(()=>()=>activeRequest.current?.abort(),[]);
  useEffect(()=>{
    if(!visible||!selected||!api.state)return;const life=new AbortController();let latest=0;setSnapshot({sessionId:selected,data:null});
    const load=()=>{const request=++latest;return api.state(selected,life.signal).then(value=>{if(!life.signal.aborted&&request===latest)setSnapshot({sessionId:selected,data:value});}).catch(error=>{if(!life.signal.aborted&&request===latest)setSnapshot({sessionId:selected,data:null,error:error.message});});};
    void load();const stop=api.subscribe?.(selected,load,()=>{});return()=>{life.abort();stop?.();};
  },[api,selected,visible]);
  async function begin(){
    const request=pending??{launchId:crypto.randomUUID(),openingId};setPending(request);saveLaunch(request);setBusy(true);setError('');const life=new AbortController();activeRequest.current=life;
    try{const result=await api.startSample(request.launchId,request.openingId,life.signal);setSelected(result.sessionId);setLibrary(await api.library(life.signal));setPending(null);saveLaunch(null);setCreated(true);}
    catch(error){if(!life.signal.aborted)setError(error.message);}
    finally{if(!life.signal.aborted)setBusy(false);}
  }
  if(!visible)return null;
  const sample=library?.sample,dependencies=library?.dependencies;
  return <section className="rpgm-workspace" aria-label="通用故事 GM">
    <header className="rpgm-heading"><GmIcon/><div><h2>故事 GM</h2><p>选择一个开场，让故事从这里开始。</p></div></header>
    {error&&<p role="alert" className="rpgm-error">{error}</p>}
    {dependencies&&(!dependencies.database||!dependencies.lastStep)&&<p className="rpgm-diagnostic">{!dependencies.database&&'需要 RP Database 0.2（API v2）。'}{!dependencies.lastStep&&'需要 RP LastStep 0.3。'} 安装后可重试；故事库仍可查看。</p>}
    {!library&&<p role="status">正在读取故事库…</p>}
    {sample&&<section className="rpgm-card" aria-label="公开故事样例"><div className="rpgm-eyebrow">原创公开样例</div><h3>{sample.title}</h3><p>{sample.description}</p>
      <label htmlFor="rpgm-opening">开场</label><select id="rpgm-opening" value={openingId} disabled={busy||!!pending} onChange={event=>setOpeningId(event.target.value)}>{sample.openings.map((opening,index)=><option key={opening.id} value={opening.id}>开场 {index+1}</option>)}</select>
      <blockquote>{sample.openings.find(opening=>opening.id===openingId)?.text}</blockquote>
      <button type="button" className="rpgm-primary" disabled={busy} onClick={begin}>{busy?'正在准备故事…':pending?'重试这个开局':created?'另开所选故事':'开始所选故事'}</button>
      <p className="rpgm-hint">开场沿用所选原文。此后由你决定行动。</p>
    </section>}
    {library?.stories.length>0&&<section className="rpgm-card"><h3>你的故事</h3><ul className="rpgm-stories">{library.stories.map(story=><li key={story.sessionId}><div><strong>{story.title}</strong><span>{labels[story.status]??story.status}</span></div><button type="button" aria-label={`查看 ${story.title}`} onClick={()=>{setSelected(story.sessionId);setError('');}}>查看状态</button></li>)}</ul></section>}
    {selected&&<section className="rpgm-card" aria-label="当前故事状态"><div className="rpgm-eyebrow">当前故事</div>{state?<><h3>{state.binding.title}</h3><p>{labels[state.binding.status]??state.binding.status} · {state.binding.character.name} v{state.binding.character.version} · 玩家：{state.binding.persona.name}</p><h4>{state.scene.title}</h4><p>{state.scene.location}{state.scene.time?` · ${state.scene.time}`:''}</p><ul className="rpgm-facts">{state.facts.items.map(fact=><li key={fact.id}>{fact.text}</li>)}</ul>{state.lastFactReceipt&&<p className="rpgm-hint">最近事实回执：{state.lastFactReceipt.id}</p>}</>:stateView?.error?<p role="alert" className="rpgm-error">{stateView.error}</p>:<p role="status">正在读取当前事实…</p>}<p className="rpgm-hint">原生会话 ID：<code>{selected}</code></p><p className="rpgm-hint">在会话列表打开该故事，继续输入你的行动。</p></section>}
    <footer className="rpgm-hint">GM 提交事实 · Database 保存状态 · Context 可选选材 · LastStep 呈现正文</footer>
  </section>;
}
