import { selectAgf } from './select-agf.mjs';
import { batteryModel, validateBatteryModel, createBatteryLedger } from './battery-model.mjs';
import {validateOperationalTopology,findOperationalPath,resolveInterfaceNode,splitSyntheticDisplayTurns} from '../map/operational-topology.mjs';
import {createTrafficController} from './traffic-controller.mjs';
import {directionHeading,turnAngle,cardinalHeading,HEADING_DEGREES,validateMotionControl,handlingDurations} from './motion-control.mjs';
import {chooseAvoidance,findExplicitAvoidancePlan,findExplicitOvertakingPlan} from './interference-control.mjs';
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
  const conveyorCapacity=scenario.wrapper.conveyorCapacity??null;
  required(conveyorCapacity===null||Number.isInteger(conveyorCapacity)&&conveyorCapacity>0,
    'wrapper conveyor capacity must be a positive integer');
  const graphMode=scenario.motionModel==='synthetic_graph';
  const motionControl=scenario.motionControl??null;
  validateMotionControl(motionControl);
  const postTaskPolicy=scenario.postTaskPolicy??null;
  required(!postTaskPolicy||graphMode,'HP return requires an explicit synthetic graph');
  required(graphMode||scenario.motionModel===undefined||scenario.motionModel==='fixed_time',
    'motionModel must be fixed_time or synthetic_graph');
  const topology=graphMode?splitSyntheticDisplayTurns(scenario.operationalTopology):null;
  if(graphMode)scenario.operationalTopology=topology;
  if(graphMode)validateOperationalTopology(topology);
  const graphNodes=graphMode?new Map(topology.nodes.map(node=>[node.id,node])):null;
  const graphEdges=graphMode?new Map(topology.edges.map(edge=>[edge.id,edge])):null;
  const traffic=graphMode?createTrafficController(topology.edges,{nodes:topology.nodes}):null;
  const gates=graphMode?new Map(topology.shutters.map(gate=>[gate.id,{passable:gate.initiallyPassable}])):null;
  const lines = new Map(Array.from({length:8}, (_,i) => ['L' + (i+1), []]));
  const agfs = (scenario.agfs ?? []).map(a => ({...a, status:a.status ?? 'idle', taskId:null,
    carriedPalletId:null,chargerId:null,...(graphMode?{movement:null,heading:a.heading??null,
      headingDeg:a.headingDeg??HEADING_DEGREES[a.heading]??null,turn:null,
      turningConsumesBattery:motionControl?.turningConsumesBattery??null}: {})}));
  required(agfs.length === 4 && new Set(agfs.map(a => a.id)).size === 4, 'four unique AGFs required');
  if(scenario.wrapper.inboundAgfLimit!==undefined)required(Number.isInteger(scenario.wrapper.inboundAgfLimit)&&
    scenario.wrapper.inboundAgfLimit>=1&&scenario.wrapper.inboundAgfLimit<=agfs.length,'invalid wrapper inbound AGF limit');
  for (const a of agfs) required(Number.isFinite(a.batteryPct) && a.batteryPct >= 0 && a.batteryPct <= 100 &&
    typeof a.area === 'string' && a.area, 'invalid AGF initial position/battery');
  if(graphMode)for(const a of agfs)required(graphNodes.has(a.currentNodeId),'graph AGF needs a known currentNodeId');
  if(graphMode)for(const a of agfs)traffic.setNodeOccupant?.({agfId:a.id,nodeId:a.currentNodeId});
  const batteryLedger = batteryModel(battery) === 'active_time' ? createBatteryLedger(agfs,battery) : null;
  const chargers = new Map((scenario.chargerIds ?? []).map(id => [id,null]));
  required(chargers.size === 2 && new Set(scenario.chargerIds).size === 2, 'two chargers required');
  const waitingPlaces=new Map(NORMAL_WAITING_PLACES.map(p=>[p.id,null]));
  const waitingReservations=new Map(NORMAL_WAITING_PLACES.map(p=>[p.id,null]));
  const waitingPriority=postTaskPolicy?.waitingPriority??NORMAL_WAITING_PRIORITY;
  // Stop occupancy is independent of electrical charger occupancy. The optional
  // ordered places are explicit synthetic scenario input, never a place/charger pair.
  const chargePlaces=new Map((scenario.chargePlaceIds??[]).map(id=>[id,null]));
  const chargePlaceReservations=new Map((scenario.chargePlaceIds??[]).map(id=>[id,null]));
  const parkingChargeQueue=[];
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
  const wrapper = {input:[], output:[], processing:null, readyToRelease:false,permission:scenario.wrapper.permission!==false,
    ...(conveyorCapacity!==null?{conveyor:[]}:{})};
  const wrapperInboundReservations=new Set();
  const wrapperInputReservations=new Set();
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
    wrapper:{...clone(wrapper),...(graphMode?{reservedInboundTaskIds:[...wrapperInboundReservations],
      reservedInputTaskIds:[...wrapperInputReservations]}:{})},
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
    ...(chargePlaces.size?{chargePlaces:Object.fromEntries(chargePlaces),chargePlaceReservations:Object.fromEntries(chargePlaceReservations)}:{}),
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
    const moving=fields.agfId&&agfs.find(a=>a.id===fields.agfId);
    const motionEvent=['SEGMENT_REQUEST','SEGMENT_EXITED','TURN_COMPLETED','HANDLING_REQUEST',
      'AVOIDANCE_REACHED','AVOIDANCE_RETURNED','WRAPPER_WAIT_READY','OVERTAKING_COMPLETED'].includes(type);
    queue.push({timeMs,order:order++,type,...fields,
      ...(motionEvent?{movementGeneration:moving?.movementGeneration}:{})});
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
    return directionHeading(from,to);
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
    if(nextType==='PICKUP'||nextType==='DROPOFF')beginHandling(agf,nextType==='PICKUP'?'pickup':'dropoff',delayMs);
    else schedule(now+delayMs,nextType,{taskId,agfId:agf.id});
  };
  const beginRoute=(task,agf,movement,path,nextType,delayMs=0)=>{
    const taskId=task?.id??null;
    agf.status=movement==='empty'?'moving_empty':movement==='loaded'?'moving_loaded':movement==='wait'?'moving_to_wait':'moving_to_charge';
    agf.movementGeneration=(agf.movementGeneration??0)+1;
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
    for(const agf of [...agfs].sort((a,b)=>Number(!!b.carriedPalletId)-Number(!!a.carriedPalletId)||
      (a.movement?.requestOrder??Infinity)-(b.movement?.requestOrder??Infinity))){
      const movement=agf.movement;
      if(agf.status!=='waiting_traffic'||!movement||movement.retryScheduled)continue;
      if(movement.handlingPending){movement.retryScheduled=true;schedule(now,'HANDLING_REQUEST',{agfId:agf.id});continue;}
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
  const holdMotion=(agf,reason,fields={})=>{
    agf.status='waiting_motion_configuration';
    if(agf.movement.waitingReason!==reason){
      agf.movement.waitingReason=reason;
      record('MOTION_CONFIGURATION_WAITING',{agfId:agf.id,taskId:agf.taskId,nodeId:agf.currentNodeId,reason,...fields});
    }
  };
  const beginTurn=(agf,step,afterType='SEGMENT_REQUEST')=>{
    const target=heading(step.fromNodeId,step.toNodeId);
    if(agf.headingDeg==null){
      // No preceding direction exists at startup. This initializes only the
      // synthetic display heading, with explicit evidence rather than site pose.
      agf.headingDeg=target;agf.heading=cardinalHeading(target);
      record('HEADING_INITIALIZED',{agfId:agf.id,headingDeg:target,evidence:'synthetic-first-segment-heading-not-site-pose'});
      return false;
    }
    const angle=turnAngle(agf.headingDeg,target);
    if(Math.abs(angle)<1e-7)return false;
    if(!motionControl?.turnRateDegPerSec){holdMotion(agf,'TURN_RATE_UNRESOLVED',{targetHeadingDeg:target,angleDeg:angle});return true;}
    const resourceIds=graphNodes.get(agf.currentNodeId).occupancyResourceIds??[];
    const edge=graphEdges.get(step.edgeId);
    const opposite={east:'west',west:'east',north:'south',south:'north',forward:'reverse',reverse:'forward'};
    const groupDirection=step.traversal==='forward'?edge.noOvertakingForwardDirection:opposite[edge.noOvertakingForwardDirection];
    if(traffic.reserveResources){
      const reserved=traffic.reserveResources({agfId:agf.id,resourceIds,
        edgeId:step.edgeId,fromNodeId:step.fromNodeId,requestOrder:agf.movement.requestOrder??order,
        ...(edge.noOvertakingGroupId?{groupId:edge.noOvertakingGroupId,groupDirection}:{})});
      if(!reserved.entered){
        agf.status='waiting_traffic';agf.movement.waitingReason='TURN_RESOURCE';
        record('SEGMENT_WAITING',{agfId:agf.id,taskId:agf.taskId,edgeId:step.edgeId,
          blockers:reserved.blockers,reason:'TURN_RESOURCE_OCCUPIED'});return true;
      }
    }
    const duration=Math.ceil(Math.abs(angle)/motionControl.turnRateDegPerSec*1000);
    agf.status='turning';agf.movement.waitingReason=null;
    agf.turn={nodeId:agf.currentNodeId,fromHeadingDeg:agf.headingDeg,targetHeadingDeg:target,angleDeg:angle,
      startedAt:now,completedAt:now+duration,rateDegPerSec:motionControl.turnRateDegPerSec,
      evidence:motionControl.turnRateEvidence,resourceIds,afterType};
    record('TURN_STARTED',{agfId:agf.id,taskId:agf.taskId,nodeId:agf.currentNodeId,
      fromHeadingDeg:agf.headingDeg,targetHeadingDeg:target,angleDeg:angle,startedAt:now,completedAt:now+duration,
      turnDurationMs:duration,turnRateDegPerSec:motionControl.turnRateDegPerSec,turnRateEvidence:motionControl.turnRateEvidence,
      angleEvidence:'synthetic-shortest-angle-not-site-turn-permission',
      turningConsumptionStatus:motionControl.turningConsumesBattery==null?'unresolved-excluded-from-active-model':
        motionControl.turningConsumesBattery?'explicit-active-time':'explicit-excluded'});
    schedule(now+duration,'TURN_COMPLETED',{agfId:agf.id,startedAt:now});return true;
  };
  const beginHandling=(agf,operation,legacyDelayMs)=>{
    const expected=resolveInterfaceNode(topology,operation==='pickup'?tasks.get(agf.taskId).originId:tasks.get(agf.taskId).destinationId);
    required(agf.currentNodeId===expected,'handling before individual interface arrival');
    const phases=handlingDurations(motionControl,operation);
    if(phases.kind==='unresolved'){holdMotion(agf,'HANDLING_PHASES_UNRESOLVED',{operation});return;}
    const node=graphNodes.get(agf.currentNodeId),groupId=node.handlingGroupId??null;
    const phase=operation==='pickup'?'positioning_pickup':'positioning_dropoff';
    if(groupId&&traffic.setHandlingPhase){
      const reserved=traffic.setHandlingPhase({agfId:agf.id,groupId,phase,resourceIds:node.handlingResourceIds??[],
        ...((node.localHandlingBlockedEdgeIds??node.handlingBlockedEdgeIds)?
          {blockedEdgeIds:node.localHandlingBlockedEdgeIds??node.handlingBlockedEdgeIds}:{})});
      if(!reserved.entered){
        agf.status='waiting_traffic';agf.movement.waitingReason='HANDLING_RESOURCE';
        agf.movement.handlingPending={operation,legacyDelayMs};
        record('HANDLING_RESOURCE_WAITING',{agfId:agf.id,taskId:agf.taskId,nodeId:agf.currentNodeId,
          blockers:reserved.blockers,operation});return;
      }
    }
    delete agf.movement.handlingPending;agf.movement.waitingReason=null;agf.movement.retryScheduled=false;
    agf.handling={operation,startedAt:now,groupId,kind:phases.kind,forkInsertedMs:phases.forkInsertedMs??null};
    // Old regression scenarios keep their indivisible modeled handling duration.
    // No invented ratio or unconditional passing exception is introduced.
    if(phases.kind==='legacy-unsplit'){
      agf.status=operation==='pickup'?'moving_empty':'moving_loaded';
      schedule(now+legacyDelayMs,operation==='pickup'?'PICKUP':'DROPOFF',{taskId:agf.taskId});return;
    }
    agf.status=operation==='pickup'?'positioning_for_pickup':'positioning_for_dropoff';
    record('TASK_POSITIONING_STARTED',{agfId:agf.id,taskId:agf.taskId,nodeId:agf.currentNodeId,operation,
      positioningMs:phases.positioningMs,forkInsertedMs:phases.forkInsertedMs,handlingEvidence:phases.evidence});
    schedule(now+phases.positioningMs,operation==='pickup'?'PICKUP_FORK_INSERTED':'DROPOFF_FORK_INSERTED',
      {agfId:agf.id,taskId:agf.taskId});
  };
  const clearHandling=agf=>{
    const node=graphNodes.get(agf.currentNodeId);
    traffic?.clearHandlingPhase?.(agf.id);traffic?.releaseResources?.(agf.id,node.handlingResourceIds??[]);
    traffic?.leaveGroup?.(agf.id);agf.handling=null;wakeTraffic();
  };
  const reservationLookahead=movement=>{
    const nextSteps=movement.steps.slice(movement.stepIndex+1);
    const current=graphEdges.get(movement.steps[movement.stepIndex]?.edgeId);
    let passageId=current?.atomicPassageId??null;
    const steps=[];
    for(const step of nextSteps){
      const edge=graphEdges.get(step.edgeId);
      if(passageId){if(edge?.atomicPassageId!==passageId)break;}
      else if(edge?.atomicPassageId)passageId=edge.atomicPassageId;
      else if(!edge?.mergeConflictResourceId)break;
      steps.push(step);
    }
    return steps;
  };
  const beginWrapperDelivery=(task,agf)=>{
    // A pending delivery stays at its individual pickup interface. The immutable
    // path determines the first valid departure heading; no display-only move.
    agf.movementGeneration=(agf.movementGeneration??0)+1;
    agf.movement={movement:'loaded',taskId:task.id,steps:task.loadedRoute.steps,stepIndex:0,
      nextType:'DROPOFF',delayMs:minute(times.dropoffMin),current:null,waitingReason:'WRAPPER_INPUT',
      retryScheduled:false,wrapperDeparture:true,requestOrder:history.length};
    agf.wrapperWaitStartedAt=now;agf.departurePlanned=false;
    task.waitReason='WRAPPER_INPUT';task.wrapperWaitStartedAt=now;task.wrapperInputWaitMs??=0;
    const step=agf.movement.steps[0];
    const available=wrapper.permission&&wrapper.input.length+wrapperInputReservations.size<scenario.wrapper.inputCapacity;
    agf.movement.wrapperOrientationPending=!available;
    if(!available&&step&&beginTurn(agf,step,'WRAPPER_WAIT_READY'))return;
    agf.movement.wrapperOrientationPending=false;
    agf.status='waiting_wrapper_input';
    record('WRAPPER_INPUT_WAITING',{taskId:task.id,kind:task.kind,agfId:agf.id,palletId:task.palletId,
      nodeId:agf.currentNodeId,reason:wrapper.permission?'WRAPPER_INPUT_FULL_OR_RESERVED':'WRAPPER_PERMISSION',
      waitingPositionEvidence:'synthetic-individual-device-interface-not-site-stop'});
  };
  const wakeWrapperInputs=()=>{
    if(!graphMode)return;
    const waiters=agfs.filter(a=>a.movement?.wrapperDeparture&&!a.movement.current&&a.status!=='turning'&&
      !['waiting_motion_configuration','waiting_interference'].includes(a.status))
      .sort((a,b)=>a.movement.requestOrder-b.movement.requestOrder);
    for(const a of waiters){
      const t=tasks.get(a.taskId);
      if(!wrapperInputReservations.has(t.id)){
        if(!wrapper.permission||wrapper.input.length+wrapperInputReservations.size>=scenario.wrapper.inputCapacity)continue;
        wrapperInputReservations.add(t.id);
        record('WRAPPER_INPUT_RESERVED',{taskId:t.id,agfId:a.id,palletId:t.palletId,
          reservationCount:wrapperInputReservations.size,inputCount:wrapper.input.length,
          selectionEvidence:'synthetic runtime tie-break'});
        record('ROUTE_PLANNED',{taskId:t.id,kind:t.kind,agfId:a.id,movement:'loaded',
          edgeIds:t.loadedRoute.steps.map(s=>s.edgeId),modelDistanceMm:t.loadedRoute.modelDistanceMm,
          modelDurationMs:t.loadedRoute.modelDurationMs,etaStatus:t.loadedRoute.etaStatus});
      }
      if(traffic.isBeingOvertaken?.(a.id)){
        if(a.status!=='waiting_traffic'||a.movement.waitingReason!=='OVERTAKING'){
          a.status='waiting_traffic';a.movement.waitingReason='OVERTAKING';a.departurePlanned=false;
          record('WRAPPER_DEPARTURE_WAITING',{agfId:a.id,taskId:a.taskId,nodeId:a.currentNodeId,reason:'OVERTAKING'});
        }
        continue;
      }
      if(!wrapper.permission||a.movement.retryScheduled)continue;
      a.movement.retryScheduled=true;a.departurePlanned=true;
      if(a.movement.steps.length)schedule(now,'SEGMENT_REQUEST',{agfId:a.id});
      else completeRoute(a);
    }
  };
  const avoidanceReturnReady=agf=>{
    const other=agfs.find(a=>a.id===agf.avoidance.otherAgfId);
    const group=agf.avoidance.conflictGroupId;
    if(!other?.movement)return true;
    const state=traffic.snapshot();
    const ownsResource=Object.entries(state.owners).some(([resourceId,owner])=>owner===other.id&&resourceId===group);
    const follows=state.followingOrder?.some(member=>member.agfId===other.id&&member.groupId===group);
    if(ownsResource||follows)return false;
    if(other.currentNodeId===agf.avoidance.resumeNodeId)return false;
    // A current segment can still cover the explicit conflict resource even if
    // its group is represented only by a shared occupancy resource.
    const covers=edge=>edge&&(edge.noOvertakingGroupId===group||edge.occupancyResourceIds.includes(group)||'edge:'+edge.id===group);
    return !covers(graphEdges.get(other.movement.current?.edgeId))&&
      !covers(graphEdges.get(other.movement.steps[other.movement.stepIndex]?.edgeId));
  };
  const wakeAvoidance=()=>{
    if(!graphMode)return;
    for(const a of agfs)if(a.status==='waiting_avoidance'&&a.avoidance?.phase==='waiting'&&avoidanceReturnReady(a)){
      a.avoidance.phase='returning';
      record('AVOIDANCE_RETURN_STARTED',{agfId:a.id,taskId:a.taskId,planId:a.avoidance.plan.planId});
      beginRoute(tasks.get(a.taskId)??null,a,a.avoidance.originalMovement.movement,
        a.avoidance.plan.returnPath,'AVOIDANCE_RETURNED');
    }
  };
  const tryAvoidance=(blocked,blockers,edge,reason)=>{
    if(['NO_OVERTAKING','HANDLING_POSITIONING'].includes(reason))return false;
    const conflictGroupId=edge.noOvertakingGroupId??edge.occupancyResourceIds[0]??'edge:'+edge.id;
    const pair=[blocked,...blockers.map(id=>agfs.find(a=>a.id===id)).filter(Boolean)];
    const feasible=pair.map(a=>{
      const moving=!!a.movement&&!a.avoidance&&!a.movement.current&&a.status!=='turning'&&!a.handling;
      const plan=moving?findExplicitAvoidancePlan(topology,{currentNodeId:a.currentNodeId,conflictGroupId,
        movement:a.movement.movement,taskType:tasks.get(a.taskId)?.kind??(a.movement.movement==='wait'?'WAIT':'CHARGE')}):null;
      return {agfId:a.id,moving,loaded:!!a.carriedPalletId,avoidancePossible:!!plan,plan,
        requestOrder:a.movement?.requestOrder??history.length};
    });
    const selection=chooseAvoidance({candidates:feasible,tieBreakPolicy:motionControl?.avoidanceTieBreakPolicy??null});
    if(selection.status!=='selected'){
      const key=selection.reason+'|'+pair.map(a=>a.id).sort().join('|');
      if(blocked.movement.avoidanceHoldKey!==key){blocked.movement.avoidanceHoldKey=key;
        record(selection.reason==='AVOIDANCE_TIE_UNRESOLVED'?'AVOIDANCE_TIE_UNRESOLVED':'AVOIDANCE_UNAVAILABLE',
          {agfId:blocked.id,taskId:blocked.taskId,conflictGroupId,reason:selection.reason,evidence:selection.evidence});}
      return false;
    }
    const selected=agfs.find(a=>a.id===selection.agfId),plan=feasible.find(c=>c.agfId===selected.id).plan;
    if(plan.outboundPath.steps.some(step=>step.shutterId&&!gates.get(step.shutterId)?.passable)||
      plan.returnPath.steps.some(step=>step.shutterId&&!gates.get(step.shutterId)?.passable))return false;
    const other=pair.find(a=>a.id!==selected.id);
    selected.avoidance={plan,originalMovement:selected.movement,resumeNodeId:selected.currentNodeId,
      otherAgfId:other.id,pausedOther:other.status==='waiting_interference',conflictGroupId,phase:'outbound'};
    // The explicit detour replaces the planned arrival path. Its old lookahead
    // reservations must not survive after their resource owners are released.
    traffic.cancelNodeReservation(selected.id);
    traffic.release(selected.id);
    record('AVOIDANCE_STARTED',{agfId:selected.id,taskId:selected.taskId,otherAgfId:selected.avoidance.otherAgfId,
      planId:plan.planId,conflictGroupId,selectionReason:selection.reason,selectionEvidence:selection.evidence,
      routeEvidence:plan.evidence});
    beginRoute(tasks.get(selected.taskId)??null,selected,selected.avoidance.originalMovement.movement,
      plan.outboundPath,'AVOIDANCE_REACHED');return selected===blocked;
  };
  const tryOvertaking=(agf,blockers)=>{
    if(agf.overtaking||agf.avoidance||agf.movement?.current||agf.status==='turning')return false;
    for(const id of blockers){
      const front=agfs.find(a=>a.id===id);
      if(tasks.get(front?.taskId)?.kind!=='01')continue;
      const movement=agf.movement,kind=tasks.get(agf.taskId)?.kind??(movement.movement==='wait'?'WAIT':'CHARGE');
      const plan=findExplicitOvertakingPlan(topology,{currentNodeId:agf.currentNodeId,blockedAgf:front,
        regularBlocked:true,movement:movement.movement,taskType:kind});
      if(!plan||plan.path.steps.some(s=>s.shutterId&&!gates.get(s.shutterId)?.passable))continue;
      const end=movement.steps.at(-1)?.toNodeId;
      const continuation=findOperationalPath(topology,plan.rejoinNodeId,end,{movement:movement.movement,taskType:kind});
      if(!continuation)continue;
      const lease=traffic.reserveOvertaking({agfId:agf.id,blockedAgfId:front.id,blockedAgf:front,
        regularBlocked:true,plan,requestOrder:movement.requestOrder});
      if(!lease.entered){
        record('OVERTAKING_WAITING',{agfId:agf.id,blockedAgfId:front.id,taskId:agf.taskId,
          planId:plan.planId,blockers:lease.blockers,reason:lease.reason});continue;
      }
      traffic.cancelNodeReservation(agf.id);
      traffic.release(agf.id,{retainResourceIds:graphNodes.get(agf.currentNodeId).occupancyResourceIds??[]});
      traffic.leaveGroup(agf.id);
      agf.overtaking={plan,originalMovement:movement,continuation};
      record('OVERTAKING_STARTED',{agfId:agf.id,blockedAgfId:front.id,taskId:agf.taskId,planId:plan.planId,
        resourceIds:lease.resources,temporaryReverseEdgeIds:plan.temporaryReverseEdgeIds,evidence:plan.evidence});
      beginRoute(tasks.get(agf.taskId),agf,movement.movement,plan.path,'OVERTAKING_COMPLETED');return true;
    }
    return false;
  };
  const pendingInterferences=[];
  const evaluateInterference=notice=>{
    const pair=notice.agfIds.map(id=>agfs.find(a=>a.id===id));
    if(pair.some(a=>a.movement?.current||a.status==='turning'))return false;
    if(pair.some(a=>!a.movement||a.handling||a.avoidance))return true;
    for(const a of pair){a.status='waiting_interference';a.movement.waitingReason='INTERFERENCE';}
    const edge=topology.edges.find(edge=>edge.noOvertakingGroupId===notice.conflictGroupId||
      edge.occupancyResourceIds.includes(notice.conflictGroupId)||'edge:'+edge.id===notice.conflictGroupId);
    required(edge,'unknown explicit interference group');
    tryAvoidance(pair[0],[pair[1].id],edge,'INTERFERENCE');return true;
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
    if(conveyorCapacity!==null){
      // Internal holding capacity is separate from the single inlet/outlet.
      // No unconfirmed conveyor-transfer duration or parallel wrapping is added.
      while(wrapper.input.length&&wrapper.conveyor.length<conveyorCapacity){
        const id=wrapper.input.shift(),p=pallets.get(id);
        required(p.stage==='wrapper_input','invalid conveyor input pallet');
        p.stage='wrapper_conveyor';wrapper.conveyor.push(id);
        record('WRAPPER_CONVEYOR_ACCEPTED',{palletId:id,conveyorQuantity:wrapper.conveyor.length,
          conveyorCapacity,transferTimingEvidence:'unresolved-transfer-time-same-event-sequence'});
      }
    }
    if(wrapper.processing!==null)return;
    const id=conveyorCapacity!==null?wrapper.conveyor.find(id=>pallets.get(id).stage==='wrapper_conveyor'):wrapper.input.shift();
    if(!id)return;
    const p=pallets.get(id);
    required(p.stage===(conveyorCapacity!==null?'wrapper_conveyor':'wrapper_input'),'invalid wrapper input pallet');
    wrapper.processing=id; p.stage='wrapping';
    record('WRAP_STARTED',{palletId:id});
    schedule(now+minute(times.wrapMin),'WRAP_FINISHED',{palletId:id});
  };
  const releaseWrap = () => {
    if (!wrapper.readyToRelease || conveyorCapacity===null&&wrapper.output.length >= scenario.wrapper.outputCapacity) return;
    const id=wrapper.processing, p=pallets.get(id);
    required(id && p.stage === 'wrapping', 'invalid wrapper release');
    if(conveyorCapacity===null)wrapper.output.push(id);
    wrapper.processing=null; wrapper.readyToRelease=false; p.stage='wrapped';
    record('WRAP_COMPLETED',{palletId:id});
    schedule(now+minute(times.labelMin),'LABEL_COMPLETED',{palletId:id});
    maybeStartWrap();
  };
  const releaseWrapperOutput=()=>{
    if(conveyorCapacity===null)return;
    for(const id of [...wrapper.conveyor]){
      const p=pallets.get(id);
      if(p.stage!=='wrapper_exit_pending')continue;
      if(wrapper.output.length>=scenario.wrapper.outputCapacity)break;
      wrapper.conveyor.splice(wrapper.conveyor.indexOf(id),1);wrapper.output.push(id);p.stage='exit_ready';
      record('EXIT_READY',{palletId:id,conveyorQuantity:wrapper.conveyor.length,outputQuantity:wrapper.output.length});
    }
    maybeStartWrap();
  };
  const finishTask = (t,a) => {
    if(graphMode)clearHandling(a);
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
      if (!wrapper.permission||wrapper.input.length >= scenario.wrapper.inputCapacity) {
        t.status='wait_drop'; hold(t,'WRAPPER_INPUT_FULL'); return false;
      }
      if(graphMode){
        required(wrapperInboundReservations.delete(t.id),'wrapper drop without reserved inbound capacity');
        required(wrapperInputReservations.delete(t.id),'wrapper drop without input-slot reservation');
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
        .filter(c=>c.path&&(chargePlaces.get(c.id)===a.id||!chargePlaces.get(c.id)&&
          (!chargePlaceReservations.get(c.id)||chargePlaceReservations.get(c.id)===a.id)));
      if(chargePlaces.size&&!choices.length){
        a.status='waiting_charge_place';a.movement=null;
        if(!parkingChargeQueue.includes(a.id))parkingChargeQueue.push(a.id);
        record('SEGMENT_WAITING',{agfId:a.id,nodeId:a.currentNodeId,reason:'CHARGE_PLACE_OCCUPIED',
          blockers:[...chargePlaces.values()].filter(Boolean),phase:'before-travel'});
        record('CHARGE_WAITING',{agfId:a.id,reason:'CHARGE_PLACE_OCCUPIED',phase:'before-travel'});return;
      }
      const load=id=>(chargePlaces.get(id)?1:0)+agfs.filter(other=>other.chargeTarget===id&&other.id!==chargePlaces.get(id)).length;
      choices.sort((a1,b1)=>(chargePlaces.get(a1.id)===a.id?-1:chargePlaces.get(b1.id)===a.id?1:load(a1.id)-load(b1.id)));
      const target=chargePlaces.size?choices[0]?.id:'CHARGE-PLACE';
      const path=chargePlaces.size?choices[0]?.path:routeFor(a.currentNodeId,target,'charge','CHARGE');
      if(path){
        if(postTaskPolicy)releasePlaces(a);
        if(chargePlaces.size&&chargePlaces.get(target)!==a.id){
          chargePlaceReservations.set(target,a.id);
          record('CHARGE_PLACE_RESERVED',{agfId:a.id,chargePlaceId:target});
        }
        a.chargeTarget=target;beginRoute(null,a,'charge',path,'CHARGE_ARRIVED');
      }
      else {a.status='waiting_traffic';record('CHARGE_ROUTE_WAITING',{agfId:a.id,reason:'UNREACHABLE_CHARGE_ROUTE'});}
    }else schedule(now+minute(times.chargeTravelMin),'CHARGE_ARRIVED',{agfId:a.id});
  };
  const wakeChargePlaces=()=>{
    if(!chargePlaces.size)return;
    for(const id of [...parkingChargeQueue]){
      const a=agfs.find(a=>a.id===id);
      if(![...chargePlaces].some(([place,owner])=>!owner&&!chargePlaceReservations.get(place)))break;
      parkingChargeQueue.splice(parkingChargeQueue.indexOf(id),1);requestCharge(a);
    }
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
  const permissionTargets={warehouse:slots,magazine:magazines,aligner:aligners,wrapper:new Map([['WRAP-INPUT',wrapper]])};
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
  for(const x of scenario.interferenceEvents??[]){
    required(graphMode&&Number.isInteger(x.timeMs)&&x.timeMs>=0&&x.evidence==='synthetic-assumption'&&
      x.agfIds?.length===2&&new Set(x.agfIds).size===2&&x.agfIds.every(id=>agfs.some(a=>a.id===id))&&
      typeof x.conflictGroupId==='string','invalid explicit synthetic interference notice');
    schedule(x.timeMs,'INTERFERENCE_DETECTED',x);
  }
  record('RUN_STARTED',{inputKind:production.length?'external':'synthetic-interval',mode:scenario.mode,
    productionModel:coupledProduction?'empty_pallet_supply':'legacy_external_pallets',
    mapStatus:graphMode?'synthetic-operational':'conceptual-only',
    timingStatus:graphMode?'synthetic-graph-assumption':'scenario-assumption'});
  chargeIdleAgfs();
  const operatorPhase=e=>e.type==='ALIGNER_REFILL_OPERATED'?2:e.type==='SEGMENT_REQUEST'?1:0;
  const advanceWrapperWait=endMs=>{
    const elapsed=endMs-now;
    if(elapsed<=0)return;
    for(const agf of agfs)if(agf.status==='waiting_wrapper_input'){
      const task=tasks.get(agf.taskId);
      if(task)task.wrapperInputWaitMs=(task.wrapperInputWaitMs??0)+elapsed;
    }
  };
  while(queue.length) {
    // A displayed-time operator input follows endogenous events already visible
    // at that instant, including dynamically scheduled pickup/drop events. This
    // is an ordering phase only: it adds no invented elapsed processing time.
    // Simultaneous requests are arbitrated after same-time state transitions.
    // Loaded traffic precedes empty traffic; equal requests use event order only.
    // This is a synthetic runtime tie-break, never an AGF-number site priority.
    const loadPriority=e=>e.type==='SEGMENT_REQUEST'?Number(!agfs.find(a=>a.id===e.agfId)?.carriedPalletId):0;
    queue.sort((a,b)=>a.timeMs-b.timeMs || operatorPhase(a)-operatorPhase(b) ||
      loadPriority(a)-loadPriority(b)||a.order-b.order);
    const e=queue.shift();
    if (e.timeMs>durationMs) break;
    if(e.movementGeneration!==undefined&&agfs.find(a=>a.id===e.agfId)?.movementGeneration!==e.movementGeneration)continue;
    advanceWrapperWait(e.timeMs);
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
    } else if(e.type==='INTERFERENCE_DETECTED'){
      record('INTERFERENCE_DETECTED',{agfIds:[...e.agfIds],conflictGroupId:e.conflictGroupId,evidence:e.evidence});
      if(!evaluateInterference(e)){
        pendingInterferences.push(e);
        record('INTERFERENCE_DEFERRED',{agfIds:[...e.agfIds],conflictGroupId:e.conflictGroupId,
          reason:'STOP_AT_EXPLICIT_NODE_BEFORE_AVOIDANCE'});
      }
    } else if(e.type==='HANDLING_REQUEST'){
      const a=agfs.find(a=>a.id===e.agfId),waiting=a?.movement?.handlingPending;
      required(a&&waiting,'handling retry without a pending arrival');
      a.movement.retryScheduled=false;beginHandling(a,waiting.operation,waiting.legacyDelayMs);
    } else if(e.type==='AVOIDANCE_REACHED'){
      const a=agfs.find(a=>a.id===e.agfId);
      required(a?.avoidance?.phase==='outbound'&&a.currentNodeId===a.avoidance.plan.viaNodeId,
        'avoidance arrival outside the explicit retreat');
      a.status='waiting_avoidance';a.avoidance.phase='waiting';
      record('AVOIDANCE_REACHED',{agfId:a.id,taskId:a.taskId,planId:a.avoidance.plan.planId,nodeId:a.currentNodeId});
      if(a.avoidance.pausedOther){
        const other=agfs.find(other=>other.id===a.avoidance.otherAgfId);
        required(other?.status==='waiting_interference'&&other.movement,'paused interference partner was lost');
        other.status=other.movement.movement==='empty'?'moving_empty':'moving_loaded';other.movement.waitingReason=null;
        schedule(now,'SEGMENT_REQUEST',{agfId:other.id});
      }
    } else if(e.type==='AVOIDANCE_RETURNED'){
      const a=agfs.find(a=>a.id===e.agfId),avoidance=a?.avoidance;
      required(avoidance?.phase==='returning'&&a.currentNodeId===avoidance.resumeNodeId,'invalid avoidance return');
      a.movement=avoidance.originalMovement;a.movement.retryScheduled=false;a.movement.waitingReason=null;
      a.movementGeneration++;
      a.status=a.movement.movement==='empty'?'moving_empty':a.movement.movement==='loaded'?'moving_loaded':
        a.movement.movement==='wait'?'moving_to_wait':'moving_to_charge';a.avoidance=null;
      record('AVOIDANCE_COMPLETED',{agfId:a.id,taskId:a.taskId,planId:avoidance.plan.planId,nodeId:a.currentNodeId});
      schedule(now,'SEGMENT_REQUEST',{agfId:a.id});
    } else if(e.type==='PICKUP_FORK_INSERTED'||e.type==='DROPOFF_FORK_INSERTED'){
      const a=agfs.find(a=>a.id===e.agfId),pickup=e.type==='PICKUP_FORK_INSERTED';
      required(a?.taskId===e.taskId&&a.status===(pickup?'positioning_for_pickup':'positioning_for_dropoff'),
        'fork insertion without positioning');
      a.status=pickup?'picking_fork_inserted':'dropping_fork_inserted';
      const node=graphNodes.get(a.currentNodeId);
      if(a.handling.groupId)traffic.setHandlingPhase?.({agfId:a.id,groupId:a.handling.groupId,
        phase:a.status,resourceIds:node.handlingResourceIds??[],
        ...((node.localHandlingBlockedEdgeIds??node.handlingBlockedEdgeIds)?
          {blockedEdgeIds:node.localHandlingBlockedEdgeIds??node.handlingBlockedEdgeIds}:{})});
      record(e.type,{agfId:a.id,taskId:a.taskId,nodeId:a.currentNodeId,operation:pickup?'pickup':'dropoff'});
      schedule(now+a.handling.forkInsertedMs,pickup?'PICKUP':'DROPOFF',{taskId:a.taskId});wakeTraffic();
    } else if (e.type === 'PICKUP') {
      const t=tasks.get(e.taskId), a=agfs.find(a=>a.id===t?.agfId);
      required(t?.status==='moving_empty' && a?.taskId===t.id && ['moving_empty','picking_fork_inserted'].includes(a.status),
        'pickup without assignment');
      if(graphMode)required(a.currentNodeId===resolveInterfaceNode(topology,t.originId),
        'pickup before individual interface arrival');
      if (t.kind==='01') {
        const l=lines.get(pallets.get(t.palletId).lineId);
        required(l.includes(t.palletId),'01 pallet missing at line');
        l.splice(l.indexOf(t.palletId),1);
      } else if (t.kind==='02') {
        required(wrapper.output.includes(t.palletId) && pallets.get(t.palletId).stage==='queued_02',
          '02 pickup before exit readiness');
        wrapper.output.splice(wrapper.output.indexOf(t.palletId),1);
        releaseWrap();releaseWrapperOutput();
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
      if(graphMode)clearHandling(a);
      t.status='moving_loaded';t.pickupAt=now;
      a.status='moving_loaded';a.area=t.originArea;a.carriedPalletId=t.palletId??('EMPTY-STACK-'+t.id);
      record('TASK_PICKED',{taskId:t.id,kind:t.kind,agfId:a.id,palletId:t.palletId??null});
      if(graphMode&&['01','04'].includes(t.kind))beginWrapperDelivery(t,a);
      else if(graphMode)beginRoute(t,a,'loaded',t.loadedRoute,'DROPOFF',minute(times.dropoffMin));
      else schedule(now+minute(times.loadedMin+times.dropoffMin),'DROPOFF',{taskId:t.id});
    } else if (e.type === 'DROPOFF') {
      const t=tasks.get(e.taskId),a=agfs.find(a=>a.id===t?.agfId);
      required(t?.status==='moving_loaded' && a?.taskId===t.id,'drop without pickup');
      if(graphMode)required(a.currentNodeId===resolveInterfaceNode(topology,t.destinationId),
        'dropoff before individual interface arrival');
      completeDrop(t,a);
    } else if (e.type === 'WRAP_FINISHED') {
      required(wrapper.processing===e.palletId && !wrapper.readyToRelease,
        'invalid wrap completion');
      wrapper.readyToRelease=true;
      if (conveyorCapacity===null&&wrapper.output.length>=scenario.wrapper.outputCapacity)
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
      if(conveyorCapacity!==null){
        p.stage='wrapper_exit_pending';
        if(wrapper.output.length>=scenario.wrapper.outputCapacity)record('WRAPPER_EXIT_WAITING',{palletId:e.palletId,reason:'WRAPPER_OUTPUT_FULL'});
        releaseWrapperOutput();
      }else{p.stage='exit_ready';record('EXIT_READY',{palletId:e.palletId});}
    } else if(e.type==='EQUIPMENT_PERMISSION_CHANGED'){
      permissionTargets[e.target].get(e.targetId).permission=e.permitted;
      if(e.target==='warehouse')dirtySlots.add(e.targetId);
      record('EQUIPMENT_PERMISSION_CHANGED',{target:e.target,targetId:e.targetId,permitted:e.permitted,
        permissionEvidence:'scenario-assumption'});
    } else if(e.type==='SHUTTER_STATE_CHANGED'){
      gates.get(e.shutterId).passable=e.passable;
      record('SHUTTER_STATE_CHANGED',{shutterId:e.shutterId,passable:e.passable});
      wakeTraffic();
    } else if(e.type==='OVERTAKING_COMPLETED'){
      const a=agfs.find(a=>a.id===e.agfId),passing=a?.overtaking;
      required(passing&&a.currentNodeId===passing.plan.rejoinNodeId,'overtaking completion before explicit rejoin');
      traffic.completeOvertaking(a.id);a.overtaking=null;
      record('OVERTAKING_COMPLETED',{agfId:a.id,taskId:a.taskId,planId:passing.plan.planId,nodeId:a.currentNodeId});
      beginRoute(tasks.get(a.taskId),a,passing.originalMovement.movement,passing.continuation,
        passing.originalMovement.nextType,passing.originalMovement.delayMs);
      wakeTraffic();
    } else if(e.type==='WRAPPER_WAIT_READY'){
      const a=agfs.find(a=>a.id===e.agfId);
      required(a?.movement?.wrapperDeparture&&!a.movement.current,'wrapper wait before pickup');
      a.movement.wrapperOrientationPending=false;a.movement.retryScheduled=false;
      a.status='waiting_wrapper_input';a.departurePlanned=false;
      record('WRAPPER_INPUT_WAITING',{taskId:a.taskId,agfId:a.id,palletId:a.carriedPalletId,nodeId:a.currentNodeId,
        reason:'WRAPPER_INPUT_FULL_OR_RESERVED',waitingPositionEvidence:'synthetic-individual-device-interface-not-site-stop'});
    } else if(e.type==='TURN_COMPLETED'){
      const a=agfs.find(a=>a.id===e.agfId),turn=a?.turn;
      required(a?.status==='turning'&&turn?.startedAt===e.startedAt&&turn.completedAt===now,
        'turn completion without a stopped turn');
      a.headingDeg=turn.targetHeadingDeg;a.heading=cardinalHeading(a.headingDeg);
      a.status=a.movement.movement==='empty'?'moving_empty':a.movement.movement==='loaded'?'moving_loaded':
        a.movement.movement==='wait'?'moving_to_wait':'moving_to_charge';
      a.turn=null;
      record('TURN_COMPLETED',{agfId:a.id,taskId:a.taskId,nodeId:a.currentNodeId,startedAt:turn.startedAt,
        headingDeg:a.headingDeg,angleDeg:turn.angleDeg,turnDurationMs:now-turn.startedAt});
      // Retain the stopped node's explicit resources until the outgoing segment
      // owns its lane as well. Release at segment exit; no same-time entry gap.
      a.movement.retryScheduled=true;
      schedule(now,turn.afterType??'SEGMENT_REQUEST',{agfId:a.id});wakeTraffic();
    } else if(e.type==='SEGMENT_REQUEST'){
      const a=agfs.find(agf=>agf.id===e.agfId),movement=a?.movement;
      required(a&&movement&&movement.stepIndex<movement.steps.length,'segment request without movement');
      if(a.status==='waiting_interference')continue;
      movement.retryScheduled=false;
      movement.requestOrder??=e.order;
      const step=movement.steps[movement.stepIndex],edge=graphEdges.get(step.edgeId);
      if(movement.wrapperOrientationPending){
        if(beginTurn(a,step,'WRAPPER_WAIT_READY'))continue;
        movement.wrapperOrientationPending=false;
      }
      if(movement.wrapperDeparture&&traffic.isBeingOvertaken?.(a.id)){
        if(a.status!=='waiting_traffic'||movement.waitingReason!=='OVERTAKING'){
          a.status='waiting_traffic';movement.waitingReason='OVERTAKING';a.departurePlanned=false;
          record('WRAPPER_DEPARTURE_WAITING',{agfId:a.id,taskId:a.taskId,nodeId:a.currentNodeId,reason:'OVERTAKING'});
        }
        continue;
      }
      if(movement.wrapperDeparture&&(!wrapperInputReservations.has(a.taskId)||!wrapper.permission)){
        if(a.status!=='waiting_wrapper_input'){
          a.status='waiting_wrapper_input';movement.waitingReason='WRAPPER_INPUT';a.departurePlanned=false;
          record('WRAPPER_INPUT_WAITING',{agfId:a.id,taskId:a.taskId,nodeId:a.currentNodeId,
            reason:wrapper.permission?'WRAPPER_INPUT_FULL_OR_RESERVED':'WRAPPER_PERMISSION'});
        }
        continue;
      }
      if(beginTurn(a,step))continue;
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
        const entered=traffic.tryEnter({agfId:a.id,edgeId:step.edgeId,traversal:step.traversal,
          requestOrder:movement.requestOrder,fromNodeId:step.fromNodeId,toNodeId:step.toNodeId,
          lookaheadSteps:reservationLookahead(movement),
          ...(a.overtaking?{overtakingPlanId:a.overtaking.plan.planId}:{})});
        if(!entered.entered){
          if(movement.waitingReason!=='RESOURCE'){
            movement.waitingReason='RESOURCE';a.status='waiting_traffic';
            if(movement.wrapperDeparture)a.departurePlanned=false;
            record('SEGMENT_WAITING',{taskId:movement.taskId,agfId:a.id,edgeId:step.edgeId,
              blockers:entered.blockers,reason:entered.reason??'OCCUPIED'});
            const deadlocks=traffic.detectDeadlocks();
            if(deadlocks.length)record('DEADLOCK_DETECTED',{cycles:deadlocks,recoveryPolicy:'detect-only'});
          }
          if(!tryOvertaking(a,entered.blockers))tryAvoidance(a,entered.blockers,edge,entered.reason);
        }else{
          traffic.depart?.({agfId:a.id,fromNodeId:step.fromNodeId});
          if(movement.wrapperDeparture){
            movement.wrapperDeparture=false;a.departurePlanned=true;tasks.get(a.taskId).waitReason=null;
            const waitMs=tasks.get(a.taskId).wrapperInputWaitMs??0;
            record('WRAPPER_INPUT_WAIT_ENDED',{agfId:a.id,taskId:a.taskId,waitMs});
          }
          if(waitingPlaces.get(step.fromNodeId)===a.id){
            waitingPlaces.set(step.fromNodeId,null);
            record('PARKING_RELEASED',{agfId:a.id,placeId:step.fromNodeId});
          }
          if(chargePlaces.get(step.fromNodeId)===a.id){
            chargePlaces.set(step.fromNodeId,null);
            record('PARKING_RELEASED',{agfId:a.id,placeId:step.fromNodeId});
            if(a.chargerId)releaseCharger(a);
          }
          if(chargePlaces.has(step.toNodeId)){
            chargePlaces.set(step.toNodeId,a.id);chargePlaceReservations.set(step.toNodeId,null);
          }
          if(movement.waitingReason)record('TRAFFIC_WAIT_ENDED',{taskId:movement.taskId,agfId:a.id,
            edgeId:step.edgeId,reason:movement.waitingReason});
          movement.waitingReason=null;
          movement.current={edgeId:step.edgeId,laneId:entered.laneId,fromNodeId:step.fromNodeId,
            toNodeId:step.toNodeId,enteredAt:now,exitAt:now+step.durationMs,
            futureResourceIds:entered.futureResourceIds??[],
            ...(step.displayPath?{displayPath:clone(step.displayPath)}:{})};
          a.status=movement.movement==='empty'?'moving_empty':movement.movement==='loaded'?'moving_loaded':
            movement.movement==='wait'?'moving_to_wait':'moving_to_charge';
          a.headingDeg=heading(step.fromNodeId,step.toNodeId);a.heading=cardinalHeading(a.headingDeg);
          record('SEGMENT_ENTERED',{taskId:movement.taskId,agfId:a.id,edgeId:step.edgeId,
            laneId:entered.laneId,fromNodeId:step.fromNodeId,toNodeId:step.toNodeId,
            movement:movement.movement,heading:a.heading,headingDeg:a.headingDeg,modelDurationMs:step.durationMs});
          schedule(now+step.durationMs,'SEGMENT_EXITED',{agfId:a.id});
          // Resume other waiters only after this AGF has its moving status/current
          // segment. Waking it while still waiting would queue a duplicate entry.
          if(chargePlaces.has(step.fromNodeId)){wakeTraffic();wakeChargePlaces();}
        }
      }
    } else if(e.type==='SEGMENT_EXITED'){
      const a=agfs.find(agf=>agf.id===e.agfId),movement=a?.movement,current=movement?.current;
      required(a&&movement&&current,'segment exit without movement');
      const edge=graphEdges.get(current.edgeId),nextStep=movement.steps[movement.stepIndex+1],nextEdge=graphEdges.get(nextStep?.edgeId);
      const opposite={east:'west',west:'east',north:'south',south:'north',forward:'reverse',reverse:'forward'};
      const groupDirection=(edge,traversal)=>traversal==='forward'?edge?.noOvertakingForwardDirection:opposite[edge?.noOvertakingForwardDirection];
      const keepFollowingOrder=!!edge.noOvertakingGroupId&&
        (nextEdge?.noOvertakingGroupId===edge.noOvertakingGroupId&&groupDirection(edge,current.traversal??
          movement.steps[movement.stepIndex].traversal)===groupDirection(nextEdge,nextStep.traversal)||
          !nextStep&&graphNodes.get(current.toNodeId).handlingGroupId===edge.noOvertakingGroupId);
      traffic.release(a.id,{keepFollowingOrder,retainResourceIds:[...(graphNodes.get(current.toNodeId).occupancyResourceIds??[]),
        ...(current.futureResourceIds??[])]});
      traffic.commitArrival?.({agfId:a.id,nodeId:current.toNodeId});
      a.currentNodeId=current.toNodeId;a.area=graphNodes.get(a.currentNodeId).areaId;
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
    for(let i=pendingInterferences.length-1;i>=0;i--)if(evaluateInterference(pendingInterferences[i]))pendingInterferences.splice(i,1);
    wakeDrops(); wakePickups(); issue02(); issue03(); chargeIdleAgfs(); dispatch(); settleWaiting(); scheduleBlockedRetries();wakeAvoidance();
    if(!['SEGMENT_REQUEST','HANDLING_REQUEST'].includes(e.type))wakeWrapperInputs();
  }
  advanceWrapperWait(durationMs);
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
