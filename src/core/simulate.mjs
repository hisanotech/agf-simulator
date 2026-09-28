import { selectAgf } from './select-agf.mjs';
import { batteryModel, validateBatteryModel, createBatteryLedger } from './battery-model.mjs';
import {validateOperationalTopology,findOperationalPath,resolveInterfaceNode} from '../map/operational-topology.mjs';
import {createTrafficController} from './traffic-controller.mjs';

const minute = value => Math.round(value * 60_000);
const required = (test, message) => { if (!test) throw new Error(message); };
const clone = value => structuredClone(value);
const byId = (a, b) => String(a.id).localeCompare(String(b.id), 'en');

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
  for (const a of agfs) required(Number.isFinite(a.batteryPct) && a.batteryPct >= 0 && a.batteryPct <= 100 &&
    typeof a.area === 'string' && a.area, 'invalid AGF initial position/battery');
  if(graphMode)for(const a of agfs)required(graphNodes.has(a.currentNodeId),'graph AGF needs a known currentNodeId');
  const batteryLedger = batteryModel(battery) === 'active_time' ? createBatteryLedger(agfs,battery) : null;
  const chargers = new Map((scenario.chargerIds ?? []).map(id => [id,null]));
  required(chargers.size === 2 && new Set(scenario.chargerIds).size === 2, 'two chargers required');
  const slots = new Map((scenario.warehouse ?? []).map(s => [s.id,{...s,palletIds:[...(s.palletIds ?? [])],reserved:[]}]));
  required(slots.size > 0 && slots.size === scenario.warehouse.length, 'unique warehouse locations required');
  for (const s of slots.values()) required(s.id && s.rowId && Number.isInteger(s.capacity) &&
    s.capacity > 0 && s.palletIds.length <= s.capacity, 'invalid warehouse location');
  const magazineCfg = scenario.magazines ?? [];
  const magazines = new Map(magazineCfg.map(m => [m.id,{...m,pending:false}]));
  for (const m of magazines.values()) required(Number.isInteger(m.quantity) && m.quantity >= 0 &&
    Number.isInteger(m.capacity) && m.capacity >= m.quantity &&
    Number.isInteger(m.trigger) && m.trigger >= 0 &&
    Number.isInteger(m.refillBatch) && m.refillBatch > 0, 'invalid magazine settings');
  const aligners = new Map((scenario.aligners ?? []).map(a => [a.id,{...a,reservedTaskId:null}]));
  const temps = new Map((scenario.temporaryPallets ?? []).map(p => [p.palletId,{...p,reservedTaskId:null}]));
  required(temps.size === (scenario.temporaryPallets ?? []).length, 'duplicate temporary pallet');
  for (const p of temps.values()) required(['OT1','OT2','OT3'].includes(p.locationId), 'unknown temporary location');
  const pallets = new Map([...temps.values()].map(p => [p.palletId,{...p,stage:'temporary'}]));
  const tasks = new Map(), queue = [], history = [], snapshots = [], rowBusy = new Set();
  const wrapper = {input:[], output:[], processing:null, readyToRelease:false};
  let now = 0, order = 0, nextTask = 0;
  const stats = {created:0, stored:0, completed:0, byKind:{}, chargingStarts:0};
  const pending = [];
  const snapshot = () => ({
    agfs:clone(agfs), lines:Object.fromEntries([...lines].map(([k,v]) => [k,[...v]])),
    wrapper:clone(wrapper), chargers:Object.fromEntries(chargers),
    magazines:Object.fromEntries([...magazines].map(([k,v]) => [k,clone(v)])),
    aligners:Object.fromEntries([...aligners].map(([k,v]) => [k,clone(v)])),
    temporaryPallets:clone([...temps.values()]),
    warehouse:Object.fromEntries([...slots].map(([k,v]) => [k,clone(v)])),
    tasks:clone([...tasks.values()]), pallets:clone([...pallets.values()]),
    ...(graphMode?{traffic:traffic.snapshot(),gates:Object.fromEntries([...gates].map(([id,state])=>[id,clone(state)]))}:{})
  });
  const record = (type, fields={}) => {
    history.push({timeMs:now,sequence:history.length,type,
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
    agf.status=movement==='empty'?'moving_empty':movement==='loaded'?'moving_loaded':'moving_to_charge';
    agf.movement={movement,taskId,steps:clone(path.steps),stepIndex:0,nextType,delayMs,
      current:null,waitingReason:null,retryScheduled:false};
    record('ROUTE_PLANNED',{taskId,kind:task?.kind??'CHARGE',agfId:agf.id,movement,
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
    const t = {id:'T' + String(++nextTask).padStart(5,'0'),kind,status:'queued',
      requestedAt:now,assignedAt:null,pickupAt:null,completedAt:null,waitReason:null,...fields};
    tasks.set(t.id,t); pending.push(t.id);
    record('TASK_REQUESTED',{taskId:t.id,kind,palletId:t.palletId ?? null});
    return t;
  };
  const canReserveSlot = s => s && s.permission !== false &&
    s.palletIds.length + s.reserved.length < s.capacity && !rowBusy.has(s.rowId);
  const reserveSlot = (slotId,palletId) => {
    const s=slots.get(slotId);
    if (!canReserveSlot(s)) return false;
    s.reserved.push(palletId); rowBusy.add(s.rowId); return true;
  };
  const issue02 = () => {
    let changed=false;
    for (const p of pallets.values()) {
      if (p.stage !== 'exit_ready') continue;
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
    t.status='completed'; t.completedAt=now; t.waitReason=null; a.status='idle'; a.taskId=null; a.carriedPalletId=null;
    if(graphMode)a.movement=null;
    a.area=t.destinationArea;
    if (!batteryLedger) a.batteryPct=Math.max(0,Math.round((a.batteryPct-battery.consumptionPct)*1000)/1000);
    stats.completed++; stats.byKind[t.kind]=(stats.byKind[t.kind]??0)+1;
    record('TASK_COMPLETED',{taskId:t.id,kind:t.kind,agfId:a.id,palletId:t.palletId ?? null});
    if (a.batteryPct <= battery.chargeStartPct) {
      a.status='moving_to_charge';
      record('CHARGE_REQUESTED',{agfId:a.id,batteryPct:a.batteryPct});
      if(graphMode){
        const path=routeFor(a.currentNodeId,'CHARGE-PLACE','charge','CHARGE');
        if(path)beginRoute(null,a,'charge',path,'CHARGE_ARRIVED');
        else {a.status='waiting_traffic';record('CHARGE_ROUTE_WAITING',{agfId:a.id,reason:'UNREACHABLE_CHARGE_ROUTE'});}
      }else schedule(now+minute(times.chargeTravelMin),'CHARGE_ARRIVED',{agfId:a.id});
    }
  };
  const completeDrop = (t,a) => {
    if (t.kind === '01' || t.kind === '04') {
      if (wrapper.input.length >= scenario.wrapper.inputCapacity) {
        t.status='wait_drop'; hold(t,'WRAPPER_INPUT_FULL'); return false;
      }
      wrapper.input.push(t.palletId); pallets.get(t.palletId).stage='wrapper_input';
    } else if (t.kind === '02' || t.kind === '05') {
      const s=slots.get(t.destinationId);
      required(s && s.reserved.includes(t.palletId) &&
        s.palletIds.length < s.capacity, 'unavailable reserved warehouse location');
      if(s.permission===false){t.status='wait_drop';hold(t,'LOCATION_PERMISSION');return false;}
      s.reserved.splice(s.reserved.indexOf(t.palletId),1); s.palletIds.push(t.palletId);
      rowBusy.delete(s.rowId); pallets.get(t.palletId).stage='stored'; stats.stored++;
      record('STORE_COMPLETED',{taskId:t.id,palletId:t.palletId,locationId:s.id});
    } else if (t.kind === '03') {
      const m=magazines.get(t.magazineId);
      if (m.permission === false) { t.status='wait_drop'; hold(t,'MAGAZINE_PERMISSION'); return false; }
      required(m.pending && m.quantity+m.refillBatch <= m.capacity,'magazine refill exceeds capacity');
      m.quantity+=m.refillBatch; m.pending=false;
      record('MAGAZINE_REFILLED',{taskId:t.id,magazineId:m.id,quantity:m.quantity,sourceReady:true});
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
      if (t.kind === '03' && !t.alignerId) {
        const source=[...aligners.values()].filter(a => a.ready === true && !a.reservedTaskId).sort(byId)[0];
        if (!source) {hold(t,'ALIGNER_NOT_READY'); continue;}
        t.alignerId=source.id; t.originId=source.id;
      }
      const a=selectAgf(agfs,{destinationArea:t.destinationArea},{
        mode:scenario.mode,reservePct:battery.reservePct,fallback});
      if (!a) {hold(t,'NO_ELIGIBLE_AGF'); continue;}
      if (t.kind === '03') {
        const source=aligners.get(t.alignerId);
        if (!source?.ready || source.reservedTaskId) {t.alignerId=null;hold(t,'ALIGNER_NOT_READY');continue;}
      }
      let selected=a,routePair=null;
      if(graphMode){
        const candidates=[];
        for(const candidate of agfs){
          if(candidate.status!=='idle'||candidate.batteryPct<battery.reservePct)continue;
          const empty=routeFor(candidate.currentNodeId,t.originId,'empty',t.kind);
          const originNodeId=resolveInterfaceNode(topology,t.originId);
          const loaded=originNodeId?routeFor(originNodeId,t.destinationId,'loaded',t.kind):null;
          if(empty&&loaded)candidates.push({candidate,empty,loaded});
        }
        selected=selectAgf(candidates.map(item=>item.candidate),{destinationArea:t.destinationArea},{
          mode:scenario.mode,reservePct:battery.reservePct,fallback});
        routePair=candidates.find(item=>item.candidate===selected)??null;
        if(!selected||!routePair){hold(t,'UNREACHABLE_ROUTE');continue;}
      }
      if(t.kind==='03')aligners.get(t.alignerId).reservedTaskId=t.id;
      t.status='moving_empty'; t.assignedAt=now; t.agfId=selected.id; t.waitReason=null;
      t.emptyRoute=graphMode?routePair.empty:null;t.loadedRoute=graphMode?routePair.loaded:null;
      selected.status='moving_empty'; selected.taskId=t.id;
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
    a.status='charging'; a.area='WH'; a.chargerId=chargerId; chargers.set(chargerId,agfId);
    batteryLedger?.startCharge(a,now);
    stats.chargingStarts++;
    record('CHARGE_STARTED',{agfId,chargerId,batteryPct:a.batteryPct});
    schedule(now+minute((battery.chargeTargetPct-a.batteryPct)*battery.chargeMinPerPct),
      'CHARGE_ENDED',{agfId,chargerId});
  };
  const permissionTargets={warehouse:slots,magazine:magazines};
  for(const event of scenario.permissionEvents??[]){
    required(Number.isInteger(event.timeMs)&&event.timeMs>=0&&typeof event.permitted==='boolean'&&
      permissionTargets[event.target]?.has(event.targetId),'invalid equipment permission event');
    schedule(event.timeMs,'EQUIPMENT_PERMISSION_CHANGED',{
      target:event.target,targetId:event.targetId,permitted:event.permitted});
  }
  const production=scenario.productionEvents ?? [];
  required(!(production.length && (scenario.lineIntervalsMin ?? []).some(n => n > 0)),
    'productionEvents and lineIntervalsMin are mutually exclusive');
  if (production.length) {
    for (const x of production) {
      required(Number.isInteger(x.timeMs) && x.timeMs>=0 &&
        lines.has(x.lineId) && x.palletId && slots.has(x.destinationLocationId),
        'invalid external production event');
      schedule(x.timeMs,'PALLET_EXITED',{...x,inputKind:'external'});
    }
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
        schedule(t,'PALLET_EXITED',{timeMs:t,lineId:'L'+(i+1),
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
    mapStatus:graphMode?'synthetic-operational':'conceptual-only',
    timingStatus:graphMode?'synthetic-graph-assumption':'scenario-assumption'});
  while(queue.length) {
    queue.sort((a,b)=>a.timeMs-b.timeMs || a.order-b.order);
    const e=queue.shift();
    if (e.timeMs>durationMs) break;
    batteryLedger?.advance(now,e.timeMs,tasks);
    now=e.timeMs;
    if (e.type === 'PALLET_EXITED') {
      const l=lines.get(e.lineId);
      required(l && !pallets.has(e.palletId),'unknown line or duplicate pallet');
      required(l.length<scenario.lineCapacity,'line buffer overflow at '+e.lineId+' / '+now);
      required(slots.has(e.destinationLocationId),'destination unknown');
      l.push(e.palletId);
      pallets.set(e.palletId,{palletId:e.palletId,lineId:e.lineId,
        destinationLocationId:e.destinationLocationId,stage:'line',inputKind:e.inputKind});
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
      if (e.kind==='05') required(slots.has(e.destinationLocationId) &&
        reserveSlot(e.destinationLocationId,e.palletId),'05 destination unavailable');
      p.stage='queued_'+e.kind;
      const t=request(e.kind,{palletId:e.palletId,originArea:'PZ',
        destinationArea:e.kind==='04'?'PZ':'WH',originId:e.locationId,
        destinationId:e.kind==='04'?'WRAP-INPUT':e.destinationLocationId,requestedBy:e.requestedBy??'operator'});
      temp.reservedTaskId=t.id;
      record('MANUAL_TASK_RESERVED',{taskId:t.id,kind:t.kind,palletId:e.palletId});
    } else if (e.type === 'MAGAZINE_USED') {
      const m=magazines.get(e.magazineId);
      required(m.quantity>0,'magazine empty');
      m.quantity--; record('MAGAZINE_USED',{magazineId:m.id,quantity:m.quantity});
      if (m.quantity===m.trigger && !m.pending) {
        m.pending=true; record('MAGAZINE_REFILL_REQUESTED',{magazineId:m.id,quantity:m.quantity});
        request('03',{palletId:null,magazineId:m.id,originArea:'WH',destinationArea:'PZ',
          originId:null,destinationId:m.id});
      }
    } else if (e.type === 'ALIGNER_READY') {
      const a=aligners.get(e.alignerId);
      required(!a.ready && !a.reservedTaskId,'aligner supply already ready or reserved');
      a.ready=true; record('ALIGNER_READY',{alignerId:a.id});
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
        required(source.ready && source.reservedTaskId===t.id,'03 pickup before aligner ready');
        source.ready=false; source.reservedTaskId=null;
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
          if(movement.waitingReason)record('TRAFFIC_WAIT_ENDED',{taskId:movement.taskId,agfId:a.id,
            edgeId:step.edgeId,reason:movement.waitingReason});
          movement.waitingReason=null;
          movement.current={edgeId:step.edgeId,laneId:entered.laneId,fromNodeId:step.fromNodeId,
            toNodeId:step.toNodeId,enteredAt:now,exitAt:now+step.durationMs,
            ...(step.displayPath?{displayPath:clone(step.displayPath)}:{})};
          a.status=movement.movement==='empty'?'moving_empty':movement.movement==='loaded'?'moving_loaded':'moving_to_charge';
          a.heading=heading(step.fromNodeId,step.toNodeId);
          record('SEGMENT_ENTERED',{taskId:movement.taskId,agfId:a.id,edgeId:step.edgeId,
            laneId:entered.laneId,fromNodeId:step.fromNodeId,toNodeId:step.toNodeId,
            movement:movement.movement,heading:a.heading,modelDurationMs:step.durationMs});
          schedule(now+step.durationMs,'SEGMENT_EXITED',{agfId:a.id});
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
    } else if (e.type === 'CHARGE_ARRIVED') {
      const a=agfs.find(a=>a.id===e.agfId);
      required(a?.status==='moving_to_charge','charge arrival without travel');
      a.area='WH';record('CHARGE_ARRIVED',{agfId:a.id});
      startCharge(a.id);
    } else if (e.type === 'CHARGE_ENDED') {
      const a=agfs.find(a=>a.id===e.agfId);
      required(a?.status==='charging' && a.chargerId===e.chargerId &&
        chargers.get(e.chargerId)===a.id,'invalid charge end');
      a.batteryPct=battery.chargeTargetPct;a.status='idle';a.chargerId=null;
      batteryLedger?.finishCharge(a);
      chargers.set(e.chargerId,null);
      record('CHARGE_ENDED',{agfId:a.id,chargerId:e.chargerId,batteryPct:a.batteryPct});
      if (chargeQueue.length) startCharge(chargeQueue.shift());
    } else throw new Error('unsupported event '+e.type);
    wakeDrops(); issue02(); dispatch();
  }
  if (batteryLedger) {
    batteryLedger.advance(now,durationMs,tasks);
    now=durationMs;
    record('RUN_ENDED',{batteryModel:'active_time'});
  }
  return {scenario,events:history,snapshots,final:snapshot(),metrics:{
    ...stats,pendingTasks:[...tasks.values()].filter(t=>t.status!=='completed').length,
    elapsedMin:scenario.durationMin,scenarioTiming:graphMode?'synthetic-graph-assumption':'assumption-not-measured',
    taskWaitMin:[...tasks.values()].filter(t=>t.assignedAt!==null)
      .map(t=>({taskId:t.id,kind:t.kind,waitMin:(t.assignedAt-t.requestedAt)/60_000}))
  }};
}
