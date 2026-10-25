import React from 'react';import {describe,it,expect,vi} from 'vitest';import {act,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {GmWorkspace} from '../../src/GmWorkspace.jsx';
const library={stories:[],dependencies:{database:true,lastStep:true,context:false,loop:false},sample:{id:'rainy-inn',title:'雨夜客栈',openings:[{id:'rain',text:'雨声敲打客栈的窗。'},{id:'lamp',text:'灯火照着客栈前厅。'}]}};
const state={binding:{title:'雨夜客栈',status:'starting',character:{name:'林遥',version:1},persona:{name:'旅人',version:1}},scene:{title:'前厅',location:'客栈',presentActorIds:['traveler']},facts:{items:[{id:'letter-holder',text:'信件由旅人持有。'}]}};
const twoStories={...library,stories:[{sessionId:'story-a',title:'故事甲',status:'active'},{sessionId:'story-b',title:'故事乙',status:'active'}]};
function deferred(){let resolve,reject;const promise=new Promise((complete,fail)=>{resolve=complete;reject=fail;});return {promise,resolve,reject};}
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
  it('clears the previous story facts while the selected story is pending or its read fails',async()=>{
    const pending=deferred(),api={library:async()=>twoStories,state:id=>id==='story-a'?Promise.resolve(state):pending.promise,subscribe:()=>()=>{}};
    render(<GmWorkspace api={api} sessionId="story-a"/>);await screen.findByText('信件由旅人持有。');fireEvent.click(screen.getByRole('button',{name:'查看 故事乙'}));
    expect(screen.queryByText('信件由旅人持有。')).not.toBeInTheDocument();expect(screen.getByText('story-b')).toBeInTheDocument();
    await act(async()=>{pending.reject(Error('故事乙暂不可读'));});expect(await screen.findByRole('alert')).toHaveTextContent('故事乙暂不可读');expect(screen.queryByText('信件由旅人持有。')).not.toBeInTheDocument();
  });
  it('a late launch-state response cannot overwrite another selected story',async()=>{
    const pending=deferred(),other={...state,binding:{...state.binding,title:'故事乙'},facts:{items:[{id:'holder',text:'故事乙的信件在门口。'}]}};
    const api={library:async()=>twoStories,startSample:async()=>({sessionId:'story-a',status:'starting'}),state:id=>id==='story-a'?pending.promise:Promise.resolve(other),subscribe:()=>()=>{}};
    render(<GmWorkspace api={api}/>);await screen.findByRole('button',{name:'开始所选故事'});fireEvent.click(screen.getByRole('button',{name:'开始所选故事'}));await screen.findByText('story-a');fireEvent.click(screen.getByRole('button',{name:'查看 故事乙'}));await screen.findByText('故事乙的信件在门口。');
    await act(async()=>{pending.resolve(state);});expect(screen.getByText('故事乙的信件在门口。')).toBeInTheDocument();expect(screen.queryByText('信件由旅人持有。')).not.toBeInTheDocument();expect(screen.getByText('story-b')).toBeInTheDocument();
  });
  it('ignores a failed read that arrives after a different story has been selected',async()=>{
    const pending=deferred(),other={...state,facts:{items:[{id:'holder',text:'故事乙的信件在门口。'}]}};
    const api={library:async()=>twoStories,state:id=>id==='story-a'?pending.promise:Promise.resolve(other),subscribe:()=>()=>{}};
    render(<GmWorkspace api={api} sessionId="story-a"/>);fireEvent.click(await screen.findByRole('button',{name:'查看 故事乙'}));await screen.findByText('故事乙的信件在门口。');
    await act(async()=>{pending.reject(Error('故事甲的迟到错误'));});expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(screen.getByText('故事乙的信件在门口。')).toBeInTheDocument();
  });
});
