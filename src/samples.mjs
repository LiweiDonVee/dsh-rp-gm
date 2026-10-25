import {clone,fail,freeze} from './core.mjs';
export const SAMPLE=freeze({id:'rainy-inn',title:'雨夜客栈',description:'原创公开样例：一位旅人、一封密封信件与尚未作出的选择。',openings:[
  {id:'rain',text:'雨水沿着客栈的窗棂流下。你带着一封尚未拆开的信走进前厅，信仍在你的手中。掌柜林遥将一盏灯移到桌边，抬眼问：“借宿，还是等人？”门外传来马蹄踏过水洼的声音。'},
  {id:'lamp',text:'客栈前厅只亮着一盏灯。你在门边停下，外衣还滴着水，那封密封信件仍由你保管。掌柜林遥合上账簿，示意炉边的空椅：“先暖暖身子吧。”楼上传来一次轻轻的敲门声。'},
]});
export function sampleStory({launchId,openingId}) {
  const opening=SAMPLE.openings.find(item=>item.id===openingId);if(!opening)fail('OPENING_NOT_FOUND','Choose one of the reviewed sample openings',404);
  return {launchId,title:SAMPLE.title,character:{assetId:'dsh-rp-gm.rainy-inn.innkeeper',version:1,name:'林遥',description:'林遥经营这间偏僻的客栈，习惯在雨夜为晚来的客人留一盏灯。',personality:'沉稳寡言，先听清对方的来意再回答。',scenario:'旅人带着密封信件来到雨夜客栈。当前事实以 Database 和已提交方向包为准。'},persona:{assetId:'dsh-rp-gm.rainy-inn.traveler',version:1,name:'旅人',description:'一位刚抵达客栈的旅人。行动、言语和内心想法由玩家自己决定。'},opening:clone(opening),examples:'林遥：“炉边还有一张空椅。”\n旅人可以坐下、询问、离开，或选择其他行动。示例不代表已经发生的事。',sources:[],initialScene:{schemaVersion:1,title:'雨夜客栈',location:'客栈前厅',presentActorIds:['traveler','innkeeper']},initialFacts:{schemaVersion:1,items:[{id:'letter-holder',text:'一封尚未拆开的密封信件当前由旅人持有。'},{id:'innkeeper',text:'林遥是客栈掌柜，正在前厅。'}]}};
}
