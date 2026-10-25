import React from 'react';import {GmWorkspace,GmIcon} from './GmWorkspace.jsx';import css from './styles.css';
export const inject=['slots','sidebarRight','sidebarRightTabs'];
export const TAB_ID='dsh-rp-gm/workspace',TAB_KIND='rp-gm';
function OpenButton({open}){return <button type="button" className="rpgm-open-entry" aria-label="打开故事 GM" title="故事 GM" onClick={open}><GmIcon/><span>故事 GM</span></button>;}
export function apply(ctx){
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.rpGm='';style.textContent=css;document.head.append(style);return()=>style.remove();},'GM styles');
  function Body({sessionId,useTabInfo}){const {tab}=useTabInfo();return <GmWorkspace sessionId={sessionId} visible={tab.visible}/>;}
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:TAB_ID,kind:TAB_KIND,title:()=> '故事 GM',guide:[{id:TAB_KIND,order:36,title:()=> '故事 GM',description:()=> '公开样例、开场与当前事实'}]}),'GM tab');
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:TAB_ID},Body)),'GM pane');
  for(const name of ['conversation.session.header.actions','conversation.hero.options','rp.studio.workspace.actions'])ctx.effect(()=>ctx.slots.inject(name,()=>ctx.slots.register({name,id:TAB_ID,order:36,inject:()=>({open:()=>ctx.sidebarRight.openTab(TAB_KIND)})},OpenButton)),`GM entry ${name}`);
}
