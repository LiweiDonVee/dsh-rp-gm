// DSH 0.2.2-rc.1's supported JSON Schema subset. Domain constraints such as
// nonempty text, unique IDs and finite public scalars are checked by core.mjs.
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'};
const nonempty={type:'string',description:'Nonempty text.'};
const strings={type:'array',items:string};

export const SCENE_SCHEMA=object({
  schemaVersion:{type:'integer',const:1},title:nonempty,location:nonempty,time:string,
  presentActorIds:{type:'array',items:nonempty,description:'Distinct actor IDs currently present.'},
},['schemaVersion','title','location','presentActorIds']);
export const FACTS_SCHEMA=object({
  schemaVersion:{type:'integer',const:1},
  items:{type:'array',description:'Complete replacement of established public facts. Preserve every still-valid fact; omit facts when unchanged. Read rp_gm_state before replacing an incomplete facts preview. Each item has only id and text; IDs must be distinct. Keep private or hidden details out of facts and packet.',items:object({id:nonempty,text:nonempty},['id','text'])},
},['schemaVersion','items']);
export const PACKET_SCHEMA=object({
  playerAction:nonempty,sceneInstruction:string,resolvedChanges:strings,
  visibleConsequences:strings,openHooks:strings,proseConstraints:strings,publicFactRefs:strings,
  // rc.1 supports only boolean additionalProperties, so values are checked at
  // the input boundary and normalized to Database's public-string contract.
  variables:{type:'object',additionalProperties:true,description:'Public variables only. Every value must be a string, finite number, or boolean; numbers and booleans are converted to strings. No null, arrays, objects, or private notes.',examples:[{checkDC:12,checkTotal:17,checkMargin:5,checkPassed:true}]},
},['playerAction']);

const ref=object({sourceKey:nonempty,entryId:nonempty},['sourceKey','entryId']);
const contentFields={title:string,content:string,keywords:strings,tags:strings,notes:string};
// Database 0.3.2 exposes no reusable operation-schema export. These are its
// public factAccess.commit v2 qualified operations, not rp_db_patch entryKeys.
export const OPERATION_SCHEMA={oneOf:[
  object({op:{type:'string',const:'add'},entry:object({id:nonempty,...contentFields,readOnly:{type:'boolean',const:false},mode:{type:'string',const:'auto'},version:{type:'integer',const:1}},['id'])},['op','entry']),
  object({op:{type:'string',const:'update'},ref,patch:object(contentFields)},['op','ref','patch']),
  object({op:{type:'string',const:'remove'},ref},['op','ref']),
  object({op:{type:'string',const:'note'},ref,text:nonempty},['op','ref','text']),
]};
export const TURN_SCHEMA=object({
  expectedRevision:{type:'integer',description:'Current nonnegative Database revision: expectedRevision from CURRENT_GM_STORY when expectedRevisionAvailable=true, or revision from rp_gm_state. Never use FactReceipt.factRevision.'},
  scene:SCENE_SCHEMA,facts:FACTS_SCHEMA,
  operations:{type:'array',items:OPERATION_SCHEMA,description:'Optional non-state Database operations. Use qualified ref {sourceKey,entryId}; update gm.scene/gm.facts through typed scene/facts instead. Owner permissions still apply.'},
  summary:nonempty,packet:PACKET_SCHEMA,
},['expectedRevision','summary','packet']);
