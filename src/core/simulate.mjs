import { selectAgf } from './select-agf.mjs';
import { batteryModel, validateBatteryModel, createBatteryLedger } from './battery-model.mjs';
import {validateOperationalTopology,findOperationalPath,resolveInterfaceNode} from '../map/operational-topology.mjs';
import {createTrafficController} from './traffic-controller.mjs';
import {validateWarehousePolicy,validateProduct,validateStoredPallets,chooseWarehouseLocation,canUseUpper} from './warehouse-policy.mjs';
import {generateProductionEvents} from './production-streams.mjs';
import {NORMAL_WAITING_PLACES,NORMAL_WAITING_PRIORITY} from '../map/warehouse-layout.mjs';

const minute = value => Math.round(value * 60_000);
const required = (test, message) => { if (!test) throw new Error(message); };
const clone = value => structuredClone(value);
const byId = (a, b) => String(a.id).localeCompare(String(b.id), 'en');

// Route geometry is constant for an entire movement. Share this frozen part in
// saved states; copying it for every event makes long replay histories quadratic.
const saveRoute=path=>{
  if(Object.isFrozen(path))return path;
  for(const step of path.steps){
    if(step.displayPath){step.displayPath.forEach(Object.freeze);Object.freeze(step.displayPath);}
    Object.freeze(step);
  }
  Object.freeze(path.steps);return Object.freeze(path);
};

/**
 * Offline, deterministic discrete-event model. All travel and handling durations are
 * scenario-provided model values, NOT measured route/ETA results. No physical routing
 * or PLC/WCS/RCS commands are performed.
 */
export function simulate(rawScenario) {
  const scenario = clone(rawScenario);
  const durationMs = minute(scenario.durationMin);
  required(Number.isInteger(durationMs) && durationMs > 0, 'durationMin must be positive');
  const times = scenario.times ?? {};
  for (const key of ['emptyMin','loadedMin','pickupMin','dropoffMin','wrapMin','labelMin','exitMin','chargeTravelMin']) {
    required(Number.isFinite(times[key]) && times[key] >= 0, 'times.' + key + ' must be nonnegative');
  }
  required(times.wrapMin > 0, 'times.wrapMin must be positive');
  const battery = scenario.battery ?? {};
  for (const key of ['reservePct','chargeStartPct','chargeTargetPct','chargeMinPerPct']) {
    required(Number.isFinite(battery[key]), 'battery.' + key + ' is required');
  }
  required(battery.reservePct >= 0 && battery.chargeStartPct >= 0 &&
    battery.chargeStartPct < battery.chargeTargetPct && battery.chargeTargetPct <= 100 &&
    battery.chargeMinPerPct > 0, 'invalid battery settings');
  validateBatteryModel(battery);
  required(['area_first','low_battery_first'].includes(scenario.mode), 'mode required');
  const fallback = scenario.fallback ?? 'wait';
  required(['wait','any'].includes(fallback), 'fallback must be wait or any');
  required(Number.isInteger(scenario.lineCapacity) && scenario.lineCapacity > 0, 'lineCapacity required');
  required(Number.isInteger(scenario.wrapper?.inputCapacity) && scenario.wrapper.inputCapacity > 0 &&
    Number.isInteger(scenario.wrapper?.outputCapacity) && scenario.wrapper.outputCapacity > 0,
    'wrapper capacities required');
  const graphMode=scenario.motionModel==='synthetic_graph';
  const postTaskPolicy=scenario.postTaskPolicy??null;
  required(!postTaskPolicy||graphMode,'HP return requires an explicit synthetic graph');
  required(graphMode||scenario.motionModel===undefined||scenario.motionModel==='fixed_time',
    'motionModel must be fixed_time or synthetic_graph');
  const topology=graphMode?scenario.operationalTopology:null;
  if(graphMode)validateOperationalTopology(topology);
  const graphNodes=graphMode?new Map(topology.nodes.map(node=>[node.id,node])):null;
  const graphEdges=graphMode?new Map(topology.edges.map(edge=>[edge.id,edge])):null;
  const traffic=graphMode?createTrafficController(topology.edges):null;
  const gates=graphMode?new Map(topology.shutters.map(gate=>[gate.id,{passable:gate.initiallyPassable}])):null;
  const lines = new Map(Array.from({length:8}, (_,i) => ['L' + (i+1), []]));
  const agfs = (scenario.agfs ?? []).map(a => ({...a, status:a.status ?? 'idle', taskId:null,
    carriedPalletId:null,chargerId:null,...(graphMode?{movement:null,heading:null}: {})}));
  required(agfs.length === 4 && new Set(agfs.map(a => a.id)).size === 4, 'four unique AGFs required');
  if(scenario.wrapper.inboundAgfLimit!==undefined)required(Number.isInteger(scenario.wrapper.inboundAgfLimit)&&
    scenario.wrapper.inboundAgfLimit>=1&&scenario.wrapper.inboundAgfLimit<=agfs.length,'invalid wrapper inbound AGF limit');
  for (const a of agfs) required(Number.isFinite(a.batteryPct) && a.batteryPct >= 0 && a.batteryPct <= 100 &&
    typeof a.area === 'string' && a.area, 'invalid AGF initial position/battery');
  if(graphMode)for(const a of agfs)required(graphNodes.has(a.currentNodeId),'graph AGF needs a known currentNodeId');
  const batteryLedger = batteryModel(battery) === 'active_time' ? createBatteryLedger(agfs,battery) : null;
  const chargers = new Map((scenario.chargerIds ?? []).map(id => [id,null]));
  required(chargers.size === 2 && new Set(scenario.chargerIds).size === 2, 'two chargers required');
  const waitingPlaces=new Map(NORMAL_WAITING_PLACES.map(p=>[p.id,null]));
  const waitingReservations=new Map(NORMAL_WAITING_PLACES.map(p=>[p.id,null]));
  const waitingPriority=postTaskPolicy?.waitingPriority??NORMAL_WAITING_PRIORITY;
  // Stop occupancy is independent of electrical charger occupancy. The optional
  // ordered places are explicit synthetic scenario input, never a place/charger pair.
  const chargePlaces=new Map((scenario.chargePlaceIds??[]).map(id=>[id,null]));
  if(chargePlaces.size){
    required(postTaskPolicy&&chargePlaces.size===2&&scenario.chargePlaceIds.length===2&&
      [...chargePlaces.keys()].every(id=>graphNodes.get(id)?.type==='charge'&&resolveInterfaceNode(topology,id)===id),
      'two explicit synthetic charging stops required');
  }
  if(scenario.initialParking){
    const allowed=new Set(['HP1','HP2',...chargePlaces.keys()]);
    required(postTaskPolicy&&allowed.size===4&&scenario.initialParking.evidence&&
      scenario.initialParking.placeIds?.length===4&&new Set(scenario.initialParking.placeIds).size===4&&
      scenario.initialParking.placeIds.every(id=>allowed.has(id))&&
      new Set(agfs.map(a=>a.currentNodeId)).size===4&&
      agfs.every(a=>allowed.has(a.currentNodeId)&&a.status==='idle'&&a.area===graphNodes.get(a.currentNodeId).areaId),
      'invalid initial parking: four distinct allowed idle stops required');
  }
  for(const a of agfs)if(chargePlaces.has(a.currentNodeId)){
    required(!chargePlaces.get(a.currentNodeId),'initial parking capacity exceeded');
    chargePlaces.set(a.currentNodeId,a.id);
  }
  if(postTaskPolicy){
    required(!Object.keys(postTaskPolicy.waitTargets??{}).length,
      'AGF-specific normal waiting return targets are no longer supported');
    required(Array.isArray(waitingPriority)&&waitingPriority.length===4&&
      waitingPriority.every((id,i)=>id===NORMAL_WAITING_PRIORITY[i]),'invalid shared normal waiting priority');
    for(const target of waitingPriority){
      required(graphNodes.get(target)?.type==='wait'&&resolveInterfaceNode(topology,target)===target,
        'normal waiting place needs an explicit synthetic node');
      const starts=topology.nodes.filter(n=>['home','pickup','dropoff','charge'].includes(n.type));
      for(const start of starts)required(findOperationalPath(topology,start.id,target,{movement:'wait',taskType:'WAIT'}),
        'unreachable normal waiting return target: '+target);
    }
    for(const a of agfs)if(waitingPlaces.has(a.currentNodeId)){
      required(!waitingPlaces.get(a.currentNodeId),'initial HP capacity exceeded');waitingPlaces.set(a.currentNodeId,a.id);
    }
  }
  const slots = new Map((scenario.warehouse ?? []).map(s => [s.id,{...s,palletIds:[...(s.palletIds ?? [])],reserved:[]}]));
  required(slots.size > 0 && slots.size === scenario.warehouse.length, 'unique warehouse locations required');
  for (const s of slots.values()) required(s.id && s.rowId && Number.isInteger(s.capacity) &&
    s.capacity > 0 && s.palletIds.length <= s.capacity, 'invalid warehouse location');
  const magazineCfg = scenario.magazines ?? [];
  const magazines = new Map(magazineCfg.map(m => [m.id,{...m,refillNeeded:false,pending:false}]));
  required(magazines.size===magazineCfg.length,'duplicate magazine ID');
  for (const m of magazines.values()) required(typeof m.id==='string'&&m.id&&Number.isInteger(m.quantity) && m.quantity >= 0 &&
    Number.isInteger(m.capacity) && m.capacity >= m.quantity &&
    Number.isInteger(m.trigger) && m.trigger >= 0 &&
    Number.isInteger(m.refillBatch) && m.refillBatch > 0, 'invalid magazine settings');
  // Legacy regression fixtures can provide ready only. Quantity is the single
  // mutable inventory value; ready is always derived and never independently set.
  const alignerCfg=scenario.aligners??[];
  const aligners = new Map(alignerCfg.map(a=>{
    const quantity=a.quantity??(a.ready===true?10:0);
    required(typeof a.id==='string'&&a.id&&[0,10].includes(quantity)&&(a.ready===undefined||a.ready===(quantity>=10)),
      'invalid aligner quantity/ready configuration');
    return [a.id,{...a,quantity,get ready(){return this.quantity>=10;},reservedTaskId:null}];
  }));
  required(aligners.size===alignerCfg.length,'duplicate aligner ID');
  const coupledProduction=scenario.productionModel==='empty_pallet_supply';
  required(scenario.productionModel===undefined||['empty_pallet_supply','legacy_external_pallets'].includes(scenario.productionModel),
    'PRODUCTION_CONFIG: unknown productionModel');
  const recoveryPolicy=scenario.magazineEmptyRecoveryPolicy??null;
  required([null,'immediate_retry','next_takt'].includes(recoveryPolicy),
    'PRODUCTION_CONFIG: invalid magazineEmptyRecoveryPolicy');
  if(coupledProduction){
    const mapping=scenario.lineMagazineMap;
    required(mapping&&typeof mapping==='object'&&!Array.isArray(mapping)&&
      Object.keys(mapping).length===lines.size&&[...lines.keys()].every(id=>magazines.has(mapping[id])),
      'PRODUCTION_CONFIG: lineMagazineMap must assign every L1–L8 to an existing magazine');
    required(!(scenario.magazineUses??[]).length,
      'PRODUCTION_CONFIG: magazineUses is legacy/test-only and cannot be combined with empty_pallet_supply');
    required(!(scenario.alignerReadyEvents??[]).length,
      'PRODUCTION_CONFIG: alignerReadyEvents is legacy/test-only; use explicit manual alignerRefillEvents');
  }
  const blockedProduction=new Map(),retryScheduled=new Set(),
    productionStatus=new Map([...lines.keys()].map(id=>[id,{state:'ready',reason:null}]));
  const temps = new Map((scenario.temporaryPallets ?? []).map(p => [p.palletId,{...p,reservedTaskId:null}]));
  required(temps.size === (scenario.temporaryPallets ?? []).length, 'duplicate temporary pallet');
  for (const p of temps.values()) required(['OT1','OT2','OT3'].includes(p.locationId), 'unknown temporary location');
  const pallets = new Map([...temps.values()].map(p => [p.palletId,{...p,stage:'temporary'}]));
  const warehousePolicy=scenario.warehousePolicy??null,lineIds=[...lines.keys()];
  for(const p of scenario.initialPallets??[]){
    required(p.palletId&&!pallets.has(p.palletId),'duplicate initial pallet');
    pallets.set(p.palletId,{...p,stage:'stored'});
  }
  if(warehousePolicy){
    validateWarehousePolicy(warehousePolicy,[...slots.values()],{lineIds,
      specialEnabled:(scenario.productStreams??[]).some(s=>s.enabled&&s.productType==='special')||
        [...(scenario.productionEvents??[]),...temps.values()].some(p=>p.productType==='special')});
    for(const p of temps.values())validateProduct(p,lineIds);
    validateStoredPallets(slots,pallets,warehousePolicy,lineIds);
  }
  const tasks = new Map(), queue = [], history = [], snapshots = [], rowBusy = new Set();
  const wrapper = {input:[], output:[], processing:null, readyToRelease:false};
  const wrapperInboundReservations=new Set();
  let now = 0, order = 0, nextTask = 0;
  const stats = {created:0, stored:0, completed:0, byKind:{}, chargingStarts:0};
  const pending = [];
  // Warehouse state changes far less often than movement events. Share only frozen
  // versions across snapshots; mutable simulation slots never escape into history.
  const dirtySlots=new Set(slots.keys());
  const savedEntities=new WeakMap();
  // Task/pallet transitions change flat fields; nested routes are frozen above.
  // Reuse the saved version while every field is identical. A later transition
  // creates a new version, so older replay states never observe live mutations.
  const saveEntity=value=>{
    const keys=Object.keys(value),previous=savedEntities.get(value);
    if(previous&&keys.length===previous.keys.length&&keys.every((key,i)=>key===previous.keys[i]&&
      Object.is(value[key],previous.values[i])))return previous.snapshot;
    const {emptyRoute,loadedRoute,...state}=value,saved=clone(state);
    if('emptyRoute' in value)saved.emptyRoute=emptyRoute;
    if('loadedRoute' in value)saved.loadedRoute=loadedRoute;
    Object.freeze(saved);
    savedEntities.set(value,{keys,values:keys.map(key=>value[key]),snapshot:saved});return saved;
  };
  let savedWarehouse=null;
  const snapshotWarehouse=()=>{
    if(dirtySlots.size){
      const next={...savedWarehouse};
      for(const id of dirtySlots){
        const saved=clone(slots.get(id));
        Object.freeze(saved.palletIds);Object.freeze(saved.reserved);next[id]=Object.freeze(saved);
      }
      savedWarehouse=Object.freeze(next);dirtySlots.clear();
    }
    return savedWarehouse;
  };
  const snapshot = () => ({
    agfs:agfs.map(a=>{
      if(!a.movement)return clone(a);
      const saved=clone({...a,movement:{...a.movement,steps:[]}});
      saved.movement.steps=a.movement.steps;return saved;
    }), lines:Object.fromEntries([...lines].map(([k,v]) => [k,[...v]])),
    wrapper:{...clone(wrapper),...(graphMode?{reservedInboundTaskIds:[...wrapperInboundReservations]}:{})},
    chargers:Object.fromEntries(chargers),
    magazines:Object.fromEntries([...magazines].map(([k,v]) => [k,clone(v)])),
    aligners:Object.fromEntries([...aligners].map(([k,v]) => [k,clone(v)])),
    ...(coupledProduction?{productionStatus:Object.fromEntries([...productionStatus].map(([k,v])=>[k,clone(v)]))}:{}),
    temporaryPallets:clone([...temps.values()]),
    warehouse:snapshotWarehouse(),
    tasks:[...tasks.values()].map(saveEntity), pallets:[...pallets.values()].map(saveEntity),
    ...(warehousePolicy?{storagePolicyActive:true}:{}),
    ...(postTaskPolicy?{waitingPlaces:Object.fromEntries(waitingPlaces),
      waitingReservations:Object.fromEntries(waitingReservations)}:{}),
    ...(chargePlaces.size?{chargePlaces:Object.fromEntries(chargePlaces)}:{}),
    ...(graphMode?{traffic:traffic.snapshot(),gates:Object.fromEntries([...gates].map(([id,state])=>[id,clone(state)]))}:{})
  });
  const record = (type, fields={}) => {
    const p=pallets.get(fields.palletId??tasks.get(fields.taskId)?.palletId);
    const location=slots.get(fields.locationId??p?.destinationLocationId);
    history.push({timeMs:now,sequence:history.length,type,
      ...(p?{sourceLineId:p.sourceLineId??p.lineId??null,productType:p.productType??null,loadType:p.loadType??null}:{}),
      ...(location?{storageLocationId:location.id,blockId:location.blockId,row:location.row,column:location.column,tier:location.tier}:{}),
      ...(graphMode?{etaStatus:'synthetic-assumption'}:{}),...fields});
    snapshots.push(snapshot());
  };
  const schedule = (timeMs, type, fields={}) => {
    required(Number.isInteger(timeMs) && timeMs >= now, 'cannot schedule event in the past: ' + type);
    queue.push({timeMs,order:order++,type,...fields});
  };
  const hold = (task, reason) => {
    if (task.waitReason !== reason) {
      task.waitReason=reason;
      if(['02','05'].includes(task.kind))task.storageResult='held';
      record('TASK_WAITING',{taskId:task.id,kind:task.kind,palletId:task.palletId ?? null,reason});
    }
  };
  const heading=(fromNodeId,toNodeId)=>{
    const from=graphNodes.get(fromNodeId),to=graphNodes.get(toNodeId);
    const dx=to.x-from.x,dy=to.y-from.y;
    return Math.abs(dx)>=Math.abs(dy)?(dx>=0?'east':'west'):(dy>=0?'south':'north');
  };
  const routeFor=(startNodeId,interfaceId,movement,taskType)=>{
    const endNodeId=resolveInterfaceNode(topology,interfaceId);
    return endNodeId?findOperationalPath(topology,startNodeId,endNodeId,{movement,taskType}):null;
  };
  const completeRoute=agf=>{
    const {nextType,delayMs,taskId,movement}=agf.movement;
    // Keep the arrived route in every snapshot until handling finishes, including
    // snapshots recorded by unrelated equipment events and zero-distance pickup.
    record('ROUTE_COMPLETED',{taskId,agfId:agf.id,movement,nodeId:agf.currentNodeId});
    schedule(now+delayMs,nextType,{taskId,agfId:agf.id});
  };
  const beginRoute=(task,agf,movement,path,nextType,delayMs=0)=>{
    const taskId=task?.id??null;
    agf.status=movement==='empty'?'moving_empty':movement==='loaded'?'moving_loaded':movement==='wait'?'moving_to_wait':'moving_to_charge';
    agf.movement={movement,taskId,steps:saveRoute(path).steps,stepIndex:0,nextType,delayMs,
      current:null,waitingReason:null,retryScheduled:false};
    record('ROUTE_PLANNED',{taskId,kind:task?.kind??(movement==='wait'?'WAIT':'CHARGE'),agfId:agf.id,movement,
      edgeIds:path.steps.map(step=>step.edgeId),modelDistanceMm:path.modelDistanceMm,
      modelDurationMs:path.modelDurationMs,etaStatus:path.etaStatus});
    if(path.steps.length)schedule(now,'SEGMENT_REQUEST',{agfId:agf.id});
    else completeRoute(agf);
  };
  const wakeTraffic=()=>{
    if(!graphMode)return;
    for(const agf of [...agfs].sort(byId)){
      const movement=agf.movement;
      if(agf.status!=='waiting_traffic'||!movement||movement.retryScheduled)continue;
      const step=movement.steps[movement.stepIndex];
      if(movement.waitingReason==='SHUTTER'&&!gates.get(step.shutterId)?.passable)continue;
      movement.retryScheduled=true;schedule(now,'SEGMENT_REQUEST',{agfId:agf.id});
    }
  };
  const request = (kind, fields) => {
    const p=pallets.get(fields.palletId);
    const location=slots.get(fields.destinationId);
    const t = {id:'T' + String(++nextTask).padStart(5,'0'),kind,status:'queued',
      requestedAt:now,assignedAt:null,pickupAt:null,completedAt:null,waitReason:null,
      ...(p?{sourceLineId:p.sourceLineId??p.lineId??null,productType:p.productType??null,loadType:p.loadType??null}:{}),
      ...(['02','05'].includes(kind)?{storageResult:location?'reserved':'pending'}:{}),
      ...(location?{storageLocationId:location.id,blockId:location.blockId,row:location.row,column:location.column,tier:location.tier}:{}),...fields};
    tasks.set(t.id,t); pending.push(t.id);
    record('TASK_REQUESTED',{taskId:t.id,kind,palletId:t.palletId ?? null});
    return t;
  };
  const issue03=()=>{
    // ID ordering is a deterministic model tie-break, not a facility priority.
    for(const m of [...magazines.values()].sort(byId)){
      if(!m.refillNeeded||m.pending)continue;
      required(m.refillBatch===10,'03 refill batch must match one ten-pallet aligner stack');
      const source=[...aligners.values()].filter(a=>a.quantity===10&&!a.reservedTaskId&&
        a.permission!==false&&!a.blocked).sort(byId)[0];
      if(!source)continue;
      const taskId='T'+String(nextTask+1).padStart(5,'0');
      source.reservedTaskId=taskId;m.pending=true;
      const task=request('03',{palletId:null,magazineId:m.id,alignerId:source.id,
        originArea:'WH',destinationArea:'PZ',originId:source.id,destinationId:m.id,
        quantityAtRequest:m.quantity,refillBatch:m.refillBatch,
        sourceSelectionEvidence:'deterministic model tie-break: ID order'});
      required(task.id===taskId,'03 source reservation/task ID mismatch');
      record('ALIGNER_RESERVED',{taskId:task.id,alignerId:source.id,magazineId:m.id,quantity:source.quantity,
        evidence:'deterministic model tie-break: ID order'});
    }
  };
  const flagRefillNeeded=m=>{
    if(m.quantity!==m.trigger||m.refillNeeded)return;
    m.refillNeeded=true;
    record('MAGAZINE_REFILL_NEEDED',{magazineId:m.id,quantity:m.quantity});
    // Retain the legacy inventory history name. This does not issue a03 task.
    record('MAGAZINE_REFILL_REQUESTED',{magazineId:m.id,quantity:m.quantity,requestStatus:'refill-needed'});
  };
  const scheduleBlockedRetries=()=>{
    if(!coupledProduction||recoveryPolicy!=='immediate_retry')return;
    // Explicit model: retain supplied, missed input opportunities in input order.
    // Retry only when both physical inventories have room/supply. Existing pickup
    // events wake the queue; no artificial time or additional capacity is added.
    for(const [lineId,attempts] of blockedProduction){
      if(!attempts.length||retryScheduled.has(lineId))continue;
      const m=magazines.get(scenario.lineMagazineMap[lineId]);
      if(m.quantity===0)continue;
      if(lines.get(lineId).length>=scenario.lineCapacity){
        if(productionStatus.get(lineId).reason!=='LINE_BUFFER_FULL'){
          productionStatus.set(lineId,{state:'blocked',reason:'LINE_BUFFER_FULL',magazineId:m.id});
          record('PRODUCTION_RETRY_WAITING_BUFFER',{lineId,magazineId:m.id,blockedAttemptCount:attempts.length,
            recoveryPolicy,evidence:'explicit immediate_retry model: retained input order, capacity-constrained'});
        }
        continue;
      }
      const attempt=attempts.shift();if(!attempts.length)blockedProduction.delete(lineId);
      retryScheduled.add(lineId);
      schedule(now,'PRODUCTION_DUE',{...attempt,timeMs:now,retry:true,originalDueAt:attempt.originalDueAt??attempt.timeMs});
    }
  };
  const resumeBlockedProduction=magazineId=>{
    for(const [lineId,attempts] of blockedProduction){
      if(scenario.lineMagazineMap[lineId]!==magazineId||!attempts.length)continue;
      if(recoveryPolicy==='immediate_retry'){
        productionStatus.set(lineId,{state:'ready',reason:null});
      }else if(recoveryPolicy==='next_takt'){
        blockedProduction.delete(lineId);
        productionStatus.set(lineId,{state:'ready',reason:null});
        record('PRODUCTION_RECOVERY_WAIT_NEXT_TAKT',{lineId,magazineId,discardedAttemptCount:attempts.length,
          recoveryPolicy,evidence:'explicit scenario recovery policy'});
      }else{
        productionStatus.set(lineId,{state:'blocked',reason:'RECOVERY_POLICY_UNSET',magazineId});
        record('PRODUCTION_RECOVERY_UNRESOLVED',{lineId,magazineId,blockedAttemptCount:attempts.length,
          recoveryPolicy:null,evidence:'unresolved: recovery policy not selected'});
      }
    }
    scheduleBlockedRetries();
  };
  const canReserveSlot = s => s && s.permission !== false &&
    s.palletIds.length + s.reserved.length < s.capacity && !rowBusy.has(s.rowId);
  const reserveSlot = (slotId,palletId) => {
    const s=slots.get(slotId);
    if (!canReserveSlot(s)) return false;
    s.reserved.push(palletId);dirtySlots.add(s.id); rowBusy.add(s.rowId); return true;
  };
  const issue02 = () => {
    let changed=false;
    for (const p of pallets.values()) {
      if (p.stage !== 'exit_ready') continue;
      if(warehousePolicy){
        const choice=chooseWarehouseLocation({pallet:p,policy:warehousePolicy,slots,pallets,rowBusy});
        if(!choice.location){
          if(p.waitReason!==choice.reason){p.waitReason=choice.reason;record('TASK_02_HELD',{palletId:p.palletId,reason:choice.reason});}
          continue;
        }
        p.destinationLocationId=choice.location.id;
      }
      if (!p.destinationLocationId || !slots.has(p.destinationLocationId))
        throw new Error('02 needs an explicit destinationLocationId for ' + p.palletId);
      if (!reserveSlot(p.destinationLocationId,p.palletId)) {
        const s=slots.get(p.destinationLocationId);
        const reason=s.permission===false?'LOCATION_PERMISSION':
          rowBusy.has(s.rowId)?'SAME_ROW_ACTIVE':'LOCATION_FULL_OR_RESERVED';
        if (p.waitReason!==reason) {
          p.waitReason=reason;
          record('TASK_02_HELD',{palletId:p.palletId,locationId:s.id,reason});
        }
        continue;
      }
      p.waitReason=null; p.stage='queued_02';
      request('02',{palletId:p.palletId,originArea:'PZ',destinationArea:'WH',
        originId:'WRAP-OUTPUT',destinationId:p.destinationLocationId});
      changed=true;
    }
    return changed;
  };
  const maybeStartWrap = () => {
    if (wrapper.processing !== null || wrapper.input.length === 0) return;
    const id=wrapper.input.shift(), p=pallets.get(id);
    required(p.stage === 'wrapper_input', 'invalid wrapper input pallet');
    wrapper.processing=id; p.stage='wrapping';
    record('WRAP_STARTED',{palletId:id});
    schedule(now+minute(times.wrapMin),'WRAP_FINISHED',{palletId:id});
  };
  const releaseWrap = () => {
    if (!wrapper.readyToRelease || wrapper.output.length >= scenario.wrapper.outputCapacity) return;
    const id=wrapper.processing, p=pallets.get(id);
    required(id && p.stage === 'wrapping', 'invalid wrapper release');
    wrapper.output.push(id); wrapper.processing=null; wrapper.readyToRelease=false; p.stage='wrapped';
    record('WRAP_COMPLETED',{palletId:id});
    schedule(now+minute(times.labelMin),'LABEL_COMPLETED',{palletId:id});
    maybeStartWrap();
  };
  const finishTask = (t,a) => {
    t.status='completed'; t.completedAt=now; t.waitReason=null;
    a.status=postTaskPolicy?'dispatch_pending':'idle'; a.taskId=null; a.carriedPalletId=null;
    if(graphMode)a.movement=null;
    a.area=t.destinationArea;
    if (!batteryLedger) a.batteryPct=Math.max(0,Math.round((a.batteryPct-battery.consumptionPct)*1000)/1000);
    stats.completed++; stats.byKind[t.kind]=(stats.byKind[t.kind]??0)+1;
    record('TASK_COMPLETED',{taskId:t.id,kind:t.kind,agfId:a.id,palletId:t.palletId ?? null});
    if (a.batteryPct <= battery.chargeStartPct) requestCharge(a);
  };
  const completeDrop = (t,a) => {
    if (t.kind === '01' || t.kind === '04') {
      if (wrapper.input.length >= scenario.wrapper.inputCapacity) {
        t.status='wait_drop'; hold(t,'WRAPPER_INPUT_FULL'); return false;
      }
      if(graphMode){
        required(wrapperInboundReservations.delete(t.id),'wrapper drop without reserved inbound capacity');
      }
      wrapper.input.push(t.palletId); pallets.get(t.palletId).stage='wrapper_input';
    } else if (t.kind === '02' || t.kind === '05') {
      const s=slots.get(t.destinationId);
      required(s && s.reserved.includes(t.palletId) &&
        s.palletIds.length < s.capacity, 'unavailable reserved warehouse location');
      if(s.permission===false){t.status='wait_drop';hold(t,'LOCATION_PERMISSION');return false;}
      if(warehousePolicy&&s.tier===2)required(canUseUpper([...slots.values()].find(l=>
        l.rowId===s.rowId&&l.column===s.column&&l.tier===1),pallets),'upper tier needs a stored full lower pallet');
      s.reserved.splice(s.reserved.indexOf(t.palletId),1); s.palletIds.push(t.palletId);
      dirtySlots.add(s.id);
      rowBusy.delete(s.rowId); pallets.get(t.palletId).stage='stored'; stats.stored++;
      t.storageResult='stored';record('STORE_COMPLETED',{taskId:t.id,palletId:t.palletId,locationId:s.id,storageResult:'stored'});
    } else if (t.kind === '03') {
      const m=magazines.get(t.magazineId);
      if (m.permission === false) { t.status='wait_drop'; hold(t,'MAGAZINE_PERMISSION'); return false; }
      required(m.pending && m.quantity+m.refillBatch <= m.capacity,'magazine refill exceeds capacity');
      const quantityBefore=m.quantity;
      m.quantity+=m.refillBatch; m.pending=false;m.refillNeeded=false;
      record('MAGAZINE_REFILLED',{taskId:t.id,agfId:a.id,magazineId:m.id,quantity:m.quantity,
        quantityBefore,quantityAfter:m.quantity,refillBatch:m.refillBatch,sourceReady:true});
      if(coupledProduction)resumeBlockedProduction(m.id);
    }
    record('TASK_DROPPED',{taskId:t.id,kind:t.kind,agfId:a.id,palletId:t.palletId ?? null});
    finishTask(t,a);
    if (t.kind === '01' || t.kind === '04') maybeStartWrap();
    if (t.kind === '02' || t.kind === '05') issue02();
    return true;
  };
  const wakeDrops = () => {
    for (const t of tasks.values()) {
      if (t.status !== 'wait_drop') continue;
      const a=agfs.find(a => a.taskId===t.id);
      if (a) completeDrop(t,a);
    }
  };
  const dispatch = () => {
    for (const id of pending) {
      const t=tasks.get(id);
      if (t.status !== 'queued') continue;
      // An explicit synthetic vehicle-admission limit leaves a vehicle for
      // wrapper outflow under congestion. It is not a facility priority rule or
      // an extra physical input slot. Actual drops still enforce input capacity.
      if(graphMode&&['01','04'].includes(t.kind)&&
        wrapperInboundReservations.size>=scenario.wrapper.inboundAgfLimit){
        hold(t,'WRAPPER_INBOUND_LIMIT');continue;
      }
      if(warehousePolicy&&t.kind==='05'&&!t.destinationId){
        const p=pallets.get(t.palletId),choice=chooseWarehouseLocation({pallet:p,policy:warehousePolicy,slots,pallets,rowBusy});
        if(!choice.location){hold(t,choice.reason);continue;}
        required(reserveSlot(choice.location.id,p.palletId),'05 automatic destination reservation failed');
        t.destinationId=choice.location.id;p.destinationLocationId=choice.location.id;
        Object.assign(t,{storageLocationId:choice.location.id,blockId:choice.location.blockId,row:choice.location.row,
          column:choice.location.column,tier:choice.location.tier,storageResult:'reserved'});
        record('WAREHOUSE_LOCATION_RESERVED',{taskId:t.id,palletId:p.palletId,locationId:choice.location.id});
      }
      const available=a=>(a.status==='idle'||(postTaskPolicy&&a.status==='dispatch_pending'))&&
        (!postTaskPolicy||a.batteryPct>battery.chargeStartPct);
      const choose=values=>{
        const chosen=selectAgf(values.filter(available).map(a=>a.status==='dispatch_pending'?{...a,status:'idle'}:a),
          {destinationArea:t.destinationArea},{mode:scenario.mode,reservePct:battery.reservePct,fallback});
        return values.find(a=>a.id===chosen?.id)??null;
      };
      const a=choose(agfs);
      if (!a) {hold(t,'NO_ELIGIBLE_AGF'); continue;}
      if (t.kind === '03') {
        const source=aligners.get(t.alignerId);
        required(source?.quantity===10&&source.reservedTaskId===t.id,'03 source must remain loaded and reserved');
        if(source.permission===false||source.blocked){hold(t,'ALIGNER_PERMISSION');continue;}
      }
      let selected=a,routePair=null;
      if(graphMode){
        const candidates=[];
        for(const candidate of agfs){
          if(!available(candidate)||candidate.batteryPct<=battery.reservePct)continue;
          const empty=routeFor(candidate.currentNodeId,t.originId,'empty',t.kind);
          const originNodeId=resolveInterfaceNode(topology,t.originId);
          const loaded=originNodeId?routeFor(originNodeId,t.destinationId,'loaded',t.kind):null;
          if(empty&&loaded)candidates.push({candidate,empty,loaded});
        }
        selected=choose(candidates.map(item=>item.candidate));
        routePair=candidates.find(item=>item.candidate===selected)??null;
        if(!selected||!routePair){hold(t,'UNREACHABLE_ROUTE');continue;}
      }
      if(postTaskPolicy)releasePlaces(selected);
      t.status='moving_empty'; t.assignedAt=now; t.agfId=selected.id; t.waitReason=null;
      t.emptyRoute=graphMode?saveRoute(routePair.empty):null;t.loadedRoute=graphMode?saveRoute(routePair.loaded):null;
      selected.status='moving_empty'; selected.taskId=t.id;
      if(graphMode&&['01','04'].includes(t.kind))wrapperInboundReservations.add(t.id);
      record('TASK_ASSIGNED',{taskId:t.id,kind:t.kind,agfId:selected.id,palletId:t.palletId ?? null});
      if(graphMode)beginRoute(t,selected,'empty',routePair.empty,'PICKUP',minute(times.pickupMin));
      else schedule(now+minute(times.emptyMin+times.pickupMin),'PICKUP',{taskId:t.id});
    }
  };
  const chargeQueue = [];
  const startCharge = agfId => {
    const a=agfs.find(a => a.id===agfId);
    if(graphMode)a.movement=null;
    const free=[...chargers].find(([id,occupant]) => occupant===null);
    if (!free) {
      a.status='waiting_charge'; if (!chargeQueue.includes(agfId)) chargeQueue.push(agfId);
      record('CHARGE_WAITING',{agfId}); return;
    }
    const [chargerId]=free;
    required(a.status === 'moving_to_charge' || a.status === 'waiting_charge', 'AGF not at charging location');
    if(chargePlaces.size)required(chargePlaces.get(a.currentNodeId)===a.id,'charge start without occupied stop');
    a.status='charging'; a.area='WH'; a.chargerId=chargerId; chargers.set(chargerId,agfId);
    batteryLedger?.startCharge(a,now);
    stats.chargingStarts++;
    record('CHARGE_STARTED',{agfId,chargerId,batteryPct:a.batteryPct,
      ...(chargePlaces.size?{chargePlaceId:a.currentNodeId}:{})});
    schedule(now+minute((battery.chargeTargetPct-a.batteryPct)*battery.chargeMinPerPct),
      'CHARGE_ENDED',{agfId,chargerId});
  };
  const releaseCharger=a=>{
    if(a.chargerId&&a.status!=='charging'){
      const chargerId=a.chargerId;chargers.set(chargerId,null);a.chargerId=null;
      record('CHARGER_RELEASED',{agfId:a.id,chargerId});
      if(chargeQueue.length)startCharge(chargeQueue.shift());
    }
  };
  const wakePickups=()=>{
    for(const t of tasks.values()){
      if(t.status!=='wait_pickup')continue;
      const source=aligners.get(t.alignerId),a=agfs.find(a=>a.taskId===t.id);
      if(!a||source?.permission===false||source?.blocked)continue;
      required(source?.quantity===10&&source.reservedTaskId===t.id,'held 03 pickup lost its reserved stack');
      t.status='moving_empty';t.waitReason=null;a.status='moving_empty';
      record('PICKUP_PERMISSION_GRANTED',{taskId:t.id,agfId:a.id,alignerId:source.id});
      schedule(now,'PICKUP',{taskId:t.id});
    }
  };
  const releasePlaces=a=>{
    for(const [id,owner] of waitingReservations)if(owner===a.id)waitingReservations.set(id,null);
    a.waitTarget=null;
    a.chargeTarget=null;
    // An AGF still waiting for its outgoing segment physically holds its stop.
    // For occupied stops, release at SEGMENT_ENTERED, not route planning.
    if(chargePlaces.get(a.currentNodeId)!==a.id)releaseCharger(a);
  };
  const requestCharge=a=>{
    a.status='moving_to_charge';
    record('CHARGE_REQUESTED',{agfId:a.id,batteryPct:a.batteryPct});
    if(graphMode){
      // Keep an occupied initial charging stop when charging there. Otherwise
      // prefer a free, reachable stop, then the shortest queue in scenario order.
      const choices=[...chargePlaces.keys()].map(id=>({id,path:routeFor(a.currentNodeId,id,'charge','CHARGE')}))
        .filter(c=>c.path);
      const load=id=>(chargePlaces.get(id)?1:0)+agfs.filter(other=>other.chargeTarget===id&&other.id!==chargePlaces.get(id)).length;
      choices.sort((a1,b1)=>(chargePlaces.get(a1.id)===a.id?-1:chargePlaces.get(b1.id)===a.id?1:load(a1.id)-load(b1.id)));
      const target=chargePlaces.size?choices[0]?.id:'CHARGE-PLACE';
      const path=chargePlaces.size?choices[0]?.path:routeFor(a.currentNodeId,target,'charge','CHARGE');
      if(path){
        if(postTaskPolicy)releasePlaces(a);
        a.chargeTarget=target;beginRoute(null,a,'charge',path,'CHARGE_ARRIVED');
      }
      else {a.status='waiting_traffic';record('CHARGE_ROUTE_WAITING',{agfId:a.id,reason:'UNREACHABLE_CHARGE_ROUTE'});}
    }else schedule(now+minute(times.chargeTravelMin),'CHARGE_ARRIVED',{agfId:a.id});
  };
  const chargeIdleAgfs=()=>{
    if(!postTaskPolicy)return;
    for(const a of [...agfs].sort(byId))if(!a.blocked&&['idle','dispatch_pending'].includes(a.status)&&
      a.batteryPct<=battery.chargeStartPct)requestCharge(a);
  };
  const settleWaiting=()=>{
    if(!postTaskPolicy)return;
    for(const a of [...agfs].sort(byId)){
      if(!['dispatch_pending','waiting_hp_capacity'].includes(a.status))continue;
      if(waitingPlaces.get(a.currentNodeId)===a.id){
        a.status='idle';a.waitTarget=null;
        record('WAIT_ARRIVED',{agfId:a.id,hpId:a.currentNodeId,batteryPct:a.batteryPct,alreadyParked:true});
        continue;
      }
      const target=waitingPriority.find(id=>!waitingPlaces.get(id)&&!waitingReservations.get(id));
      const holdReturn=(status,reason)=>{
        if(a.status!==status){a.status=status;record('WAIT_RETURN_HELD',{agfId:a.id,hpId:target??null,reason});}
      };
      if(!target){holdReturn('waiting_hp_capacity','HP_CAPACITY_UNRESOLVED');continue;}
      const path=routeFor(a.currentNodeId,target,'wait','WAIT');
      required(path,'unreachable normal waiting return target: '+target);
      releasePlaces(a);waitingReservations.set(target,a.id);a.waitTarget=target;
      record('WAIT_RETURN_REQUESTED',{agfId:a.id,hpId:target,waitingPriority:[...waitingPriority]});
      beginRoute(null,a,'wait',path,'WAIT_ARRIVED');
    }
  };
  const permissionTargets={warehouse:slots,magazine:magazines,aligner:aligners};
  for(const event of scenario.permissionEvents??[]){
    required(Number.isInteger(event.timeMs)&&event.timeMs>=0&&typeof event.permitted==='boolean'&&
      permissionTargets[event.target]?.has(event.targetId),'invalid equipment permission event');
    schedule(event.timeMs,'EQUIPMENT_PERMISSION_CHANGED',{
      target:event.target,targetId:event.targetId,permitted:event.permitted});
  }
  const production=scenario.productionEvents ?? [];
  required(new Set(production.map(x=>x.palletId)).size===production.length,'duplicate production pallet ID');
  required(!(production.length && ((scenario.lineIntervalsMin ?? []).some(n => n > 0)||scenario.productStreams?.some(s=>s.enabled))),
    'productionEvents and lineIntervalsMin are mutually exclusive');
  if (production.length) {
    for (const x of production) {
      required(Number.isInteger(x.timeMs) && x.timeMs>=0 &&
        lines.has(x.lineId) && x.palletId && (warehousePolicy||slots.has(x.destinationLocationId)),
        'invalid external production event');
      required(x.sourceLineId===undefined||x.sourceLineId===x.lineId,'sourceLineId must match production lineId');
      schedule(x.timeMs,coupledProduction?'PRODUCTION_DUE':'PALLET_EXITED',{...x,inputKind:'external'});
    }
  } else if(scenario.productStreams){
    required(warehousePolicy,'product streams require warehouse policy');
    for(const event of generateProductionEvents(scenario.productStreams,durationMs,lineIds))
      schedule(event.timeMs,coupledProduction?'PRODUCTION_DUE':'PALLET_EXITED',event);
  } else {
    required(Array.isArray(scenario.lineIntervalsMin) && scenario.lineIntervalsMin.length===8,
      'eight independent lineIntervalsMin required');
    const destinations=scenario.generatedDestinationIds ?? [];
    required(destinations.length && destinations.every(id=>slots.has(id)),
      'synthetic interval input needs explicit generatedDestinationIds');
    const offsets=scenario.lineStartOffsetsMin ?? Array(8).fill(0);
    required(Array.isArray(offsets) && offsets.length===8,'eight start offsets required');
    let n=0;
    scenario.lineIntervalsMin.forEach((interval,i) => {
      required(Number.isFinite(interval) && interval>=0, 'invalid line interval');
      required(Number.isFinite(offsets[i]) && offsets[i]>=0,'invalid line start offset');
      if (!interval) return;
      const step=minute(interval), start=step+minute(offsets[i]);
      required(step>0,'line interval is below millisecond precision');
      for (let t=start,k=1;t<=durationMs;t+=step,k++) {
        schedule(t,coupledProduction?'PRODUCTION_DUE':'PALLET_EXITED',{timeMs:t,lineId:'L'+(i+1),
          palletId:'SIM-L'+(i+1)+'-'+k,
          destinationLocationId:destinations[n++%destinations.length],inputKind:'synthetic-interval'});
      }
    });
  }
  for (const x of scenario.magazineUses ?? []) {
    required(magazines.has(x.magazineId) && Number.isInteger(x.timeMs) && x.timeMs>=0,
      'invalid magazine-use event');
    schedule(x.timeMs,'MAGAZINE_USED',x);
  }
  for (const x of scenario.alignerReadyEvents ?? []) {
    required(aligners.has(x.alignerId) && Number.isInteger(x.timeMs) && x.timeMs>=0,
      'invalid aligner-ready event');
    schedule(x.timeMs,'ALIGNER_READY',x);
  }
  for(const x of scenario.alignerRefillEvents??[]){
    required(Number.isInteger(x.timeMs)&&x.timeMs>=0&&['individual','all'].includes(x.operationType)&&
      (x.operationType==='all'||aligners.has(x.alignerId)),'invalid aligner refill event');
    schedule(x.timeMs,'ALIGNER_REFILL_OPERATED',x);
  }
  for (const x of scenario.manualRequests ?? []) {
    required(['04','05'].includes(x.kind) && Number.isInteger(x.timeMs) && x.timeMs>=0,
      'invalid manual task');
    schedule(x.timeMs,'MANUAL_REQUEST',x);
  }
  for(const x of scenario.shutterEvents??[]){
    required(graphMode&&Number.isInteger(x.timeMs)&&x.timeMs>=0&&gates.has(x.shutterId)&&
      typeof x.passable==='boolean','invalid shutter event');
    schedule(x.timeMs,'SHUTTER_STATE_CHANGED',x);
  }
  record('RUN_STARTED',{inputKind:production.length?'external':'synthetic-interval',mode:scenario.mode,
    productionModel:coupledProduction?'empty_pallet_supply':'legacy_external_pallets',
    mapStatus:graphMode?'synthetic-operational':'conceptual-only',
    timingStatus:graphMode?'synthetic-graph-assumption':'scenario-assumption'});
  chargeIdleAgfs();
  const operatorPhase=e=>e.type==='ALIGNER_REFILL_OPERATED'?1:0;
  while(queue.length) {
    // A displayed-time operator input follows endogenous events already visible
    // at that instant, including dynamically scheduled pickup/drop events. This
    // is an ordering phase only: it adds no invented elapsed processing time.
    queue.sort((a,b)=>a.timeMs-b.timeMs || operatorPhase(a)-operatorPhase(b) || a.order-b.order);
    const e=queue.shift();
    if (e.timeMs>durationMs) break;
    batteryLedger?.advance(now,e.timeMs,tasks);
    now=e.timeMs;
    if (e.type === 'PRODUCTION_DUE'||e.type==='PALLET_EXITED') {
      const l=lines.get(e.lineId);
      required(l && !pallets.has(e.palletId),'unknown line or duplicate pallet');
      required(warehousePolicy||slots.has(e.destinationLocationId),'destination unknown');
      const attributes={sourceLineId:e.sourceLineId??e.lineId,productType:e.productType??'normal',loadType:e.loadType??'full'};
      validateProduct(attributes,lineIds);
      if(e.type==='PRODUCTION_DUE'){
        if(e.retry)retryScheduled.delete(e.lineId);
        const m=magazines.get(scenario.lineMagazineMap[e.lineId]);
        record('PRODUCTION_DUE',{lineId:e.lineId,palletId:e.palletId,magazineId:m.id,inputKind:e.inputKind,
          palletStatus:'planned-input',retry:e.retry===true,originalDueAt:e.originalDueAt??now,
          ...(e.retry?{evidence:'explicit immediate_retry model: retained input order, capacity-constrained'}:{})});
        if(m.quantity===0||(recoveryPolicy===null&&blockedProduction.has(e.lineId))){
          const reason=m.quantity===0?'EMPTY_PALLET':'RECOVERY_POLICY_UNSET';
          productionStatus.set(e.lineId,{state:'blocked',reason,magazineId:m.id});
          if(!blockedProduction.has(e.lineId))blockedProduction.set(e.lineId,[]);
          blockedProduction.get(e.lineId)[e.retry?'unshift':'push']({...e});
          record(reason==='EMPTY_PALLET'?'PRODUCTION_BLOCKED_EMPTY_PALLET':'PRODUCTION_BLOCKED_RECOVERY_POLICY',
            {lineId:e.lineId,magazineId:m.id,plannedPalletId:e.palletId,quantity:m.quantity,reason,
              recoveryPolicy,evidence:recoveryPolicy===null?'unresolved: recovery policy not selected':'explicit scenario recovery policy'});
          wakeDrops();wakePickups();issue02();issue03();chargeIdleAgfs();dispatch();settleWaiting();scheduleBlockedRetries();
          continue;
        }
        if(e.retry&&l.length>=scenario.lineCapacity){
          if(!blockedProduction.has(e.lineId))blockedProduction.set(e.lineId,[]);
          blockedProduction.get(e.lineId).unshift({...e});
          scheduleBlockedRetries();continue;
        }
        required(l.length<scenario.lineCapacity,'line buffer overflow at '+e.lineId+' / '+now);
        const quantityBefore=m.quantity;m.quantity--;
        productionStatus.set(e.lineId,{state:'ready',reason:null});
        record('EMPTY_PALLET_DISCHARGED',{magazineId:m.id,lineId:e.lineId,palletId:e.palletId,
          quantityBefore,quantityAfter:m.quantity,quantity:m.quantity,...attributes});
        flagRefillNeeded(m);
      }else required(l.length<scenario.lineCapacity,'line buffer overflow at '+e.lineId+' / '+now);
      pallets.set(e.palletId,{palletId:e.palletId,lineId:e.lineId,...attributes,
        destinationLocationId:warehousePolicy?null:e.destinationLocationId,
        stage:coupledProduction?'palletized':'line',inputKind:e.inputKind});
      if(e.type==='PRODUCTION_DUE')record('PALLETIZED',{lineId:e.lineId,palletId:e.palletId,
        magazineId:scenario.lineMagazineMap[e.lineId],inputKind:e.inputKind,
        processingTimeStatus:'unresolved: no added processing delay'});
      l.push(e.palletId);pallets.get(e.palletId).stage='line';
      stats.created++;
      record('PALLET_EXITED',{lineId:e.lineId,palletId:e.palletId,inputKind:e.inputKind});
      request('01',{palletId:e.palletId,originArea:'PZ',destinationArea:'PZ',
        originId:e.lineId,destinationId:'WRAP-INPUT'});
    } else if (e.type === 'MANUAL_REQUEST') {
      const p=pallets.get(e.palletId), temp=temps.get(e.palletId);
      required(p && p.stage==='temporary' && temp?.locationId===e.locationId && !temp.reservedTaskId,
        'manual 04/05 requires unreserved pallet at specified temporary location');
      required(e.kind==='04' ? e.reentryPermission===true : e.storagePermission===true,
        'manual request requires explicit permission');
      if (e.kind==='05'&&!warehousePolicy) required(slots.has(e.destinationLocationId) &&
        reserveSlot(e.destinationLocationId,e.palletId),'05 destination unavailable');
      p.stage='queued_'+e.kind;
      const t=request(e.kind,{palletId:e.palletId,originArea:'PZ',
        destinationArea:e.kind==='04'?'PZ':'WH',originId:e.locationId,
        destinationId:e.kind==='04'?'WRAP-INPUT':warehousePolicy?null:e.destinationLocationId,requestedBy:e.requestedBy??'operator'});
      temp.reservedTaskId=t.id;
      record('MANUAL_TASK_RESERVED',{taskId:t.id,kind:t.kind,palletId:e.palletId});
    } else if (e.type === 'MAGAZINE_USED') {
      const m=magazines.get(e.magazineId);
      required(m.quantity>0,'magazine empty');
      m.quantity--; record('MAGAZINE_USED',{magazineId:m.id,quantity:m.quantity});
      flagRefillNeeded(m);
    } else if (e.type === 'ALIGNER_READY') {
      const a=aligners.get(e.alignerId);
      required(!a.ready && !a.reservedTaskId,'aligner supply already ready or reserved');
      a.quantity=10; record('ALIGNER_READY',{alignerId:a.id,quantityBefore:0,quantityAfter:10,
        evidence:'legacy/test-only explicit aligner supply input'});
    } else if(e.type==='ALIGNER_REFILL_OPERATED'){
      const targets=e.operationType==='all'?[...aligners.values()].sort(byId):[aligners.get(e.alignerId)];
      record('ALIGNER_REFILL_OPERATED',{alignerId:e.alignerId??null,operationType:e.operationType,
        operatedAt:now,targetIds:targets.map(a=>a.id)});
      for(const a of targets){
        if(a.quantity===10)continue;
        required(a.quantity===0&&!a.reservedTaskId,'aligner refill requires an empty unreserved aligner');
        const quantityBefore=a.quantity;a.quantity=10;
        record('ALIGNER_REFILLED',{alignerId:a.id,operationType:e.operationType,quantityBefore,quantityAfter:10,operatedAt:now});
      }
    } else if (e.type === 'PICKUP') {
      const t=tasks.get(e.taskId), a=agfs.find(a=>a.id===t?.agfId);
      required(t?.status==='moving_empty' && a?.taskId===t.id && a.status==='moving_empty',
        'pickup without assignment');
      if (t.kind==='01') {
        const l=lines.get(pallets.get(t.palletId).lineId);
        required(l.includes(t.palletId),'01 pallet missing at line');
        l.splice(l.indexOf(t.palletId),1);
      } else if (t.kind==='02') {
        required(wrapper.output.includes(t.palletId) && pallets.get(t.palletId).stage==='queued_02',
          '02 pickup before exit readiness');
        wrapper.output.splice(wrapper.output.indexOf(t.palletId),1);
        releaseWrap();
      } else if (t.kind==='03') {
        const source=aligners.get(t.alignerId);
        required(source.quantity===10 && source.reservedTaskId===t.id,'03 pickup before aligner ready');
        if(source.permission===false||source.blocked){
          t.status='wait_pickup';a.status='waiting_pickup';hold(t,'ALIGNER_PERMISSION');continue;
        }
        source.quantity=0;source.reservedTaskId=null;
        record('ALIGNER_STACK_PICKED',{alignerId:source.id,taskId:t.id,agfId:a.id,
          quantityBefore:10,quantityAfter:0,pickedAt:now});
      } else {
        const temp=temps.get(t.palletId);
        required(temp?.reservedTaskId===t.id,'04/05 pallet not reserved');
        temps.delete(t.palletId);
      }
      if (t.palletId) pallets.get(t.palletId).stage='on_agf_'+t.kind;
      t.status='moving_loaded';t.pickupAt=now;
      a.status='moving_loaded';a.area=t.originArea;a.carriedPalletId=t.palletId??('EMPTY-STACK-'+t.id);
      record('TASK_PICKED',{taskId:t.id,kind:t.kind,agfId:a.id,palletId:t.palletId??null});
      if(graphMode)beginRoute(t,a,'loaded',t.loadedRoute,'DROPOFF',minute(times.dropoffMin));
      else schedule(now+minute(times.loadedMin+times.dropoffMin),'DROPOFF',{taskId:t.id});
    } else if (e.type === 'DROPOFF') {
      const t=tasks.get(e.taskId),a=agfs.find(a=>a.id===t?.agfId);
      required(t?.status==='moving_loaded' && a?.taskId===t.id,'drop without pickup');
      completeDrop(t,a);
    } else if (e.type === 'WRAP_FINISHED') {
      required(wrapper.processing===e.palletId && !wrapper.readyToRelease,
        'invalid wrap completion');
      wrapper.readyToRelease=true;
      if (wrapper.output.length>=scenario.wrapper.outputCapacity)
        record('WRAP_OUTPUT_BLOCKED',{palletId:e.palletId});
      else releaseWrap();
    } else if (e.type === 'LABEL_COMPLETED') {
      const p=pallets.get(e.palletId);
      required(p?.stage==='wrapped','label before wrapping');
      p.stage='labeled';record('LABEL_COMPLETED',{palletId:e.palletId});
      schedule(now+minute(times.exitMin),'EXIT_READY',{palletId:e.palletId});
    } else if (e.type === 'EXIT_READY') {
      const p=pallets.get(e.palletId);
      required(p?.stage==='labeled','exit before label');
      p.stage='exit_ready';record('EXIT_READY',{palletId:e.palletId});
    } else if(e.type==='EQUIPMENT_PERMISSION_CHANGED'){
      permissionTargets[e.target].get(e.targetId).permission=e.permitted;
      if(e.target==='warehouse')dirtySlots.add(e.targetId);
      record('EQUIPMENT_PERMISSION_CHANGED',{target:e.target,targetId:e.targetId,permitted:e.permitted,
        permissionEvidence:'scenario-assumption'});
    } else if(e.type==='SHUTTER_STATE_CHANGED'){
      gates.get(e.shutterId).passable=e.passable;
      record('SHUTTER_STATE_CHANGED',{shutterId:e.shutterId,passable:e.passable});
      wakeTraffic();
    } else if(e.type==='SEGMENT_REQUEST'){
      const a=agfs.find(agf=>agf.id===e.agfId),movement=a?.movement;
      required(a&&movement&&movement.stepIndex<movement.steps.length,'segment request without movement');
      movement.retryScheduled=false;
      const step=movement.steps[movement.stepIndex],edge=graphEdges.get(step.edgeId);
      if(step.shutterId&&!gates.get(step.shutterId)?.passable){
        if(movement.waitingReason!=='SHUTTER'){
          movement.waitingReason='SHUTTER';a.status='waiting_traffic';
          record('SHUTTER_WAITING',{taskId:movement.taskId,agfId:a.id,edgeId:step.edgeId,
            shutterId:step.shutterId,nodeId:a.currentNodeId});
        }
      }else if(chargePlaces.has(step.toNodeId)&&chargePlaces.get(step.toNodeId)&&chargePlaces.get(step.toNodeId)!==a.id){
        if(movement.waitingReason!=='CHARGE_PLACE'){
          movement.waitingReason='CHARGE_PLACE';a.status='waiting_traffic';
          record('SEGMENT_WAITING',{taskId:movement.taskId,agfId:a.id,edgeId:step.edgeId,
            blockers:[chargePlaces.get(step.toNodeId)],reason:'CHARGE_PLACE_OCCUPIED',chargePlaceId:step.toNodeId});
          if(movement.movement==='charge')record('CHARGE_WAITING',{agfId:a.id,chargePlaceId:step.toNodeId,
            reason:'CHARGE_PLACE_OCCUPIED',phase:'before-arrival'});
        }
      }else{
        const entered=traffic.tryEnter({agfId:a.id,edgeId:step.edgeId,traversal:step.traversal,requestOrder:e.order});
        if(!entered.entered){
          if(movement.waitingReason!=='RESOURCE'){
            movement.waitingReason='RESOURCE';a.status='waiting_traffic';
            record('SEGMENT_WAITING',{taskId:movement.taskId,agfId:a.id,edgeId:step.edgeId,
              blockers:entered.blockers,reason:'OCCUPIED'});
            const deadlocks=traffic.detectDeadlocks();
            if(deadlocks.length)record('DEADLOCK_DETECTED',{cycles:deadlocks,recoveryPolicy:'detect-only'});
          }
        }else{
          if(waitingPlaces.get(step.fromNodeId)===a.id){
            waitingPlaces.set(step.fromNodeId,null);
            record('PARKING_RELEASED',{agfId:a.id,placeId:step.fromNodeId});
          }
          if(chargePlaces.get(step.fromNodeId)===a.id){
            chargePlaces.set(step.fromNodeId,null);
            record('PARKING_RELEASED',{agfId:a.id,placeId:step.fromNodeId});
            if(a.chargerId)releaseCharger(a);
          }
          if(chargePlaces.has(step.toNodeId))chargePlaces.set(step.toNodeId,a.id);
          if(movement.waitingReason)record('TRAFFIC_WAIT_ENDED',{taskId:movement.taskId,agfId:a.id,
            edgeId:step.edgeId,reason:movement.waitingReason});
          movement.waitingReason=null;
          movement.current={edgeId:step.edgeId,laneId:entered.laneId,fromNodeId:step.fromNodeId,
            toNodeId:step.toNodeId,enteredAt:now,exitAt:now+step.durationMs,
            ...(step.displayPath?{displayPath:clone(step.displayPath)}:{})};
          a.status=movement.movement==='empty'?'moving_empty':movement.movement==='loaded'?'moving_loaded':
            movement.movement==='wait'?'moving_to_wait':'moving_to_charge';
          a.heading=heading(step.fromNodeId,step.toNodeId);
          record('SEGMENT_ENTERED',{taskId:movement.taskId,agfId:a.id,edgeId:step.edgeId,
            laneId:entered.laneId,fromNodeId:step.fromNodeId,toNodeId:step.toNodeId,
            movement:movement.movement,heading:a.heading,modelDurationMs:step.durationMs});
          schedule(now+step.durationMs,'SEGMENT_EXITED',{agfId:a.id});
          // Resume other waiters only after this AGF has its moving status/current
          // segment. Waking it while still waiting would queue a duplicate entry.
          if(chargePlaces.has(step.fromNodeId))wakeTraffic();
        }
      }
    } else if(e.type==='SEGMENT_EXITED'){
      const a=agfs.find(agf=>agf.id===e.agfId),movement=a?.movement,current=movement?.current;
      required(a&&movement&&current,'segment exit without movement');
      traffic.release(a.id);a.currentNodeId=current.toNodeId;a.area=graphNodes.get(a.currentNodeId).areaId;
      record('SEGMENT_EXITED',{taskId:movement.taskId,agfId:a.id,edgeId:current.edgeId,
        laneId:current.laneId,nodeId:a.currentNodeId,movement:movement.movement});
      movement.current=null;movement.stepIndex++;
      if(movement.stepIndex<movement.steps.length)schedule(now,'SEGMENT_REQUEST',{agfId:a.id});
      else completeRoute(a);
      wakeTraffic();
    } else if(e.type==='WAIT_ARRIVED'){
      const a=agfs.find(a=>a.id===e.agfId);
      required(postTaskPolicy&&a?.status==='moving_to_wait'&&waitingReservations.get(a.waitTarget)===a.id&&
        !waitingPlaces.get(a.waitTarget)&&a.currentNodeId===a.waitTarget,
        'HP arrival without reserved return');
      waitingReservations.set(a.waitTarget,null);waitingPlaces.set(a.waitTarget,a.id);
      a.status='idle';a.movement=null;
      record('WAIT_ARRIVED',{agfId:a.id,hpId:a.waitTarget,batteryPct:a.batteryPct});
    } else if (e.type === 'CHARGE_ARRIVED') {
      const a=agfs.find(a=>a.id===e.agfId);
      required(a?.status==='moving_to_charge','charge arrival without travel');
      a.area='WH';record('CHARGE_ARRIVED',{agfId:a.id});
      startCharge(a.id);
    } else if (e.type === 'CHARGE_ENDED') {
      const a=agfs.find(a=>a.id===e.agfId);
      required(a?.status==='charging' && a.chargerId===e.chargerId &&
        chargers.get(e.chargerId)===a.id,'invalid charge end');
      a.batteryPct=battery.chargeTargetPct;a.status=postTaskPolicy?'dispatch_pending':'idle';
      if(!postTaskPolicy)a.chargerId=null;
      batteryLedger?.finishCharge(a);
      if(!postTaskPolicy)chargers.set(e.chargerId,null);
      record('CHARGE_ENDED',{agfId:a.id,chargerId:e.chargerId,batteryPct:a.batteryPct});
      if (!postTaskPolicy&&chargeQueue.length) startCharge(chargeQueue.shift());
    } else throw new Error('unsupported event '+e.type);
    wakeDrops(); wakePickups(); issue02(); issue03(); chargeIdleAgfs(); dispatch(); settleWaiting(); scheduleBlockedRetries();
  }
  if (batteryLedger) {
    batteryLedger.advance(now,durationMs,tasks);
    now=durationMs;
    record('RUN_ENDED',{batteryModel:'active_time'});
  }
  // Final state remains an independent, editable result for existing consumers.
  return {scenario,events:history,snapshots,final:{...snapshot(),agfs:clone(agfs),tasks:clone([...tasks.values()]),pallets:clone([...pallets.values()]),
    warehouse:clone(snapshotWarehouse())},metrics:{
    ...stats,pendingTasks:[...tasks.values()].filter(t=>t.status!=='completed').length,
    elapsedMin:scenario.durationMin,scenarioTiming:graphMode?'synthetic-graph-assumption':'assumption-not-measured',
    taskWaitMin:[...tasks.values()].filter(t=>t.assignedAt!==null)
      .map(t=>({taskId:t.id,kind:t.kind,waitMin:(t.assignedAt-t.requestedAt)/60_000}))
  }};
}
