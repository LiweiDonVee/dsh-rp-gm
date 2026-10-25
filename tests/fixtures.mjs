export const launch=(changes={})=>({
  launchId:'launch-one',title:'雨夜客栈',character:{assetId:'innkeeper',version:1,name:'林遥'},
  persona:{assetId:'traveler',version:1,name:'旅人',description:'一位自行决定行动的旅人。'},
  opening:{id:'rain',text:'雨声敲打客栈的窗。林遥将一盏灯放在桌边。'},examples:'',sources:[],
  initialScene:{schemaVersion:1,title:'雨夜客栈',location:'客栈前厅',presentActorIds:['traveler','innkeeper']},
  initialFacts:{schemaVersion:1,items:[{id:'letter-holder',text:'密封信件由旅人持有。'}]},...changes,
});
export const sourceEvents=({tool='rp_commit_turn',callId='commit',assistantId='assistant-one',turn=1,startSeq=0}={})=>[
  {seq:startSeq,type:'turn/start',data:{turn}},
  {seq:startSeq+1,type:'assistant/message',surfaceOp:'append',data:{turn,step:1,message:{id:assistantId,role:'assistant',content:[{type:'tool-call',id:callId,name:tool,arguments:'{}'}]}}},
  {seq:startSeq+2,type:'tool/call',data:{turn,step:1,callId,name:tool,arguments:'{}'}},
];
