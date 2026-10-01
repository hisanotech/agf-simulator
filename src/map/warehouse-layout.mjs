/** User-confirmed abstract structure. No CAD coordinates, routes or measured distances. */
export const WAREHOUSE_BLOCKS = Object.freeze([
  {id:'WB1',label:'西側1',rows:7,columns:13,tiers:2,emptyColumns:[]},
  {id:'WB2',label:'西側2',rows:3,columns:13,tiers:2,emptyColumns:[]},
  {id:'WB3',label:'西側3',rows:13,columns:13,tiers:2,emptyColumns:[]},
  {id:'EB1',label:'東側1',rows:3,columns:18,tiers:2,emptyColumns:[10]},
  {id:'EB2',label:'東側2',rows:3,columns:18,tiers:2,emptyColumns:[10]}
].map(block=>Object.freeze({...block,emptyColumns:Object.freeze(block.emptyColumns)})));

export const WAREHOUSE_RULES = Object.freeze({
  evidence:'user-confirmed-abstract-structure',mainAisles:Object.freeze({west:2,east:2}),
  rowDirection:'both',rowLaneCount:1,sideBySidePassing:false,adjacentRowsSimultaneous:true,
  slowdownThreshold:'unresolved',slowdownRate:'unresolved',fireShutterCrossings:2,
  freeWallCrossing:false,emptyColumnAccess:'unresolved',physicalEtaAllowed:false
});

export const WAREHOUSE_MAIN_AISLES=Object.freeze(['W','E'].flatMap(side=>[1,2].map(n=>Object.freeze({
  id:`WH-${side}-MAIN-${n}`,side:side==='W'?'west':'east',access:'allowed',
  direction:'unresolved',laneCount:null,simultaneousPassing:'unresolved',connectionPoints:'unresolved'
}))));

const places=(prefix,count)=>Object.freeze(Array.from({length:count},(_,i)=>Object.freeze({
  id:prefix+(i+1),positionEvidence:'relative-only',stopNodeId:null,...(prefix==='CHARGE-PLACE'?{chargerId:null}:{})
})));
export const NORMAL_WAITING_PLACES=Object.freeze([...places('HP',2),
  Object.freeze({id:'PILLAR-WAIT-E',positionEvidence:'relative-only',stopNodeId:null,relativeTo:'EB1-EB2-gap-west'}),
  Object.freeze({id:'PILLAR-WAIT-W',positionEvidence:'relative-only',stopNodeId:null,relativeTo:'WB2-WB3-gap-east'})]);
/** User-confirmed return priority, shared by every AGF; unrelated to initial parking. */
export const NORMAL_WAITING_PRIORITY=Object.freeze(NORMAL_WAITING_PLACES.map(p=>p.id));
export const WAREHOUSE_SERVICE=Object.freeze({
  relativeTo:'south-of-EB2',accessFrom:'east-main-aisles',accessEvidence:'user-confirmed',branchAssignment:'unresolved',
  waitingCandidates:Object.freeze({totalCount:4,normalUse:true,groups:Object.freeze([
    Object.freeze({kind:'south-service',count:2,placeIds:Object.freeze(['HP1','HP2'])}),
    Object.freeze({kind:'rack-gap-pillars',count:2,sides:Object.freeze(['west','east']),placeIds:Object.freeze(['PILLAR-WAIT-W','PILLAR-WAIT-E'])})
  ]),wsIdMapping:'unresolved'}),
  waitingPlaces:NORMAL_WAITING_PLACES,chargePlaces:places('CHARGE-PLACE',2),chargers:places('CHARGER',2),aligners:places('AL',5),
  arrangement:Object.freeze({left:['waiting-1','waiting-2','charge-1','charge-2'],rightTop:'five-aligners',rightBottom:'empty-pallet-storage'}),
  emptyPalletStorage:Object.freeze({agfAccess:'forbidden',supplyBy:'operator',routeNodes:Object.freeze([]),capacity:null})
});

/** Symbolic IDs for sample inventory; correspondence to actual site slot IDs is unreviewed. */
export function warehouseLocations() {
  return WAREHOUSE_BLOCKS.flatMap(block=>Array.from({length:block.rows},(_,r)=>
    Array.from({length:block.columns},(_,c)=>block.emptyColumns.includes(c+1)?[]:
      Array.from({length:block.tiers},(_,t)=>({
        id:`${block.id}-R${String(r+1).padStart(2,'0')}-C${String(c+1).padStart(2,'0')}-T${t+1}`,
        blockId:block.id,row:r+1,column:c+1,tier:t+1,
        rowId:`${block.id}-R${String(r+1).padStart(2,'0')}`,
        capacity:1,permission:true
      }))).flat()).flat());
}

export function slotStatus(slot) {
  if(!slot)return 'unknown';
  if(slot.permission===false)return 'unavailable';
  if(slot.palletIds?.length)return 'occupied';
  if(slot.reserved?.length)return 'reserved';
  return 'empty';
}

/** Extra rules are derived from saved inventory, without modifying location permissions. */
export function displayedSlotStatus(slot,snapshot){
  const base=slotStatus(slot);
  if(!snapshot.storagePolicyActive||slot?.tier!==2||base!=='empty')return base;
  const lower=Object.values(snapshot.warehouse).find(s=>s.rowId===slot.rowId&&s.column===slot.column&&s.tier===1);
  const lowerPallet=snapshot.pallets.find(p=>p.palletId===lower?.palletIds[0]);
  if(lowerPallet?.loadType==='partial')return 'unavailable';
  if(lowerPallet?.loadType!=='full')return 'unsupported';
  return base;
}
