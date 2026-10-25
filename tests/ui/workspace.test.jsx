import React from 'react';import {describe,it,expect,vi} from 'vitest';import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {GmWorkspace} from '../../src/GmWorkspace.jsx';
const library={stories:[],dependencies:{database:true,lastStep:true,context:false,loop:false},sample:{id:'rainy-inn',title:'雨夜客栈',openings:[{id:'rain',text:'雨声敲打客栈的窗。'},{id:'lamp',text:'灯火照着客栈前厅。'}]}};
const state={binding:{title:'雨夜客栈',status:'starting',character:{name:'林遥',version:1},persona:{name:'旅人',version:1}},scene:{title:'前厅',location:'客栈',presentActorIds:['traveler']},facts:{items:[{id:'letter-holder',text:'信件由旅人持有。'}]}};
describe('native GM workspace',()=>{
  it('keeps library and dependency diagnostics usable when start operation is unavailable',async()=>{
    const api={library:async()=>({...library,dependencies:{database:false,lastStep:false}}),startSample:async()=>{throw Error('需要 RP Database 0.2');}};render(<GmWorkspace api={api}/>);
    await screen.findByText('雨夜客栈');expect(screen.getByText(/需要 RP Database/)).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'开始所选故事'}));expect(await screen.findByRole('alert')).toHaveTextContent('需要 RP Database 0.2');
  });
  it('retries a lost launch response with the same identity and reads current Database facts',async()=>{
    let attempts=0;const ids=[];const api={library:async()=>library,startSample:async(id)=>{ids.push(id);if(++attempts===1)throw Error('连接中断，请重试');return {sessionId:'story',status:'starting'};},state:async()=>state,subscribe:()=>()=>{}};
    render(<GmWorkspace api={api}/>);await screen.findByText('雨夜客栈');fireEvent.click(screen.getByRole('button',{name:'开始所选故事'}));await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'重试这个开局'}));
    expect(await screen.findByText('信件由旅人持有。')).toBeInTheDocument();expect(ids).toHaveLength(2);expect(ids[1]).toBe(ids[0]);expect(screen.getByText('story')).toBeInTheDocument();
  });
  it('reads selected existing story status without starting another session',async()=>{
    const startSample=vi.fn();const api={library:async()=>({...library,stories:[{sessionId:'story',title:'另一场雨',status:'active'}]}),state:async()=>({...state,binding:{...state.binding,status:'active'}}),startSample,subscribe:()=>()=>{}};
    render(<GmWorkspace api={api}/>);fireEvent.click(await screen.findByRole('button',{name:'查看 另一场雨'}));await waitFor(()=>expect(screen.getByText('信件由旅人持有。')).toBeInTheDocument());expect(startSample).not.toHaveBeenCalled();
  });
});
