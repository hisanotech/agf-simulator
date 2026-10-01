import {simulate} from '../core/simulate.mjs';
import {warehouseAvailability} from '../core/warehouse-policy.mjs';

export function snapshotIndexAt(events,timeMs) {
  let lo=0,hi=events.length;
  while(lo<hi) {const mid=(lo+hi)>>>1;if(events[mid].timeMs<=timeMs)lo=mid+1;else hi=mid;}
  return lo-1;
}
export function replayTime(anchorMs,elapsedWallMs,speed,durationMs) {
  if(![1,2,4].includes(speed)||![anchorMs,elapsedWallMs,durationMs].every(n=>Number.isFinite(n)&&n>=0))
    throw new Error('Invalid replay clock');
  return Math.min(Math.round(durationMs),Math.floor(anchorMs+elapsedWallMs*speed));
}
export function replayFrameTime(anchor,frameMs,durationMs) {
  // Use one clock domain. A frame's timestamp may precede performance.now()
  // in the input handler that requested it, especially on speed changes.
  anchor.wall??=frameMs;
  return replayTime(anchor.sim,frameMs-anchor.wall,anchor.speed,durationMs);
}
export function effectiveStatus(agf,snapshot) {
  if(agf.status==='waiting_traffic'&&agf.movement?.waitingReason==='CHARGE_PLACE')return 'waiting_charge';
  if(agf.status==='idle'&&snapshot.waitingPlaces?.[agf.currentNodeId]===agf.id)return 'hp_wait';
  if(snapshot.tasks.find(task=>task.id===agf.taskId)?.status==='wait_drop')return 'wait_drop';
  const movement=agf.movement;
  if(movement&&!movement.current&&movement.stepIndex===movement.steps.length){
    if(agf.status==='moving_empty')return 'handling_pickup';
    if(agf.status==='moving_loaded')return 'handling_dropoff';
  }
  return agf.status;
}
export const workingStatuses=['moving_empty','moving_loaded','handling_pickup','handling_dropoff'];
export const durationStatuses=['idle','moving_empty','handling_pickup','moving_loaded','handling_dropoff',
  'waiting_traffic','wait_drop','moving_to_wait','hp_wait','moving_to_charge','charging','waiting_charge',
  'waiting_hp_instruction','waiting_hp_capacity','waiting_hp_route'];

/** Round the table together so displayed tenths sum to the displayed run duration.
 * Analysis, utilization and CSV retain exact milliseconds. Ties use column order. */
export function durationTenths(durations) {
  const cells=durationStatuses.map((status,index)=>({status,index,value:(durations[status]??0)/6000}));
  const values=Object.fromEntries(cells.map(c=>[c.status,Math.floor(c.value)]));
  const remaining=Math.round(cells.reduce((sum,c)=>sum+c.value,0))-Object.values(values).reduce((a,b)=>a+b,0);
  const order=[...cells].sort((a,b)=>(b.value%1)-(a.value%1)||a.index-b.index);
  for(let i=0;i<remaining;i++)values[order[i].status]++;
  return values;
}

/** Integrate saved states over simulated time, including the tail after the last event. */
export function analyzeRun(run) {
  const durationMs=Math.round(run.scenario.durationMin*60000);
  const agfs=run.final.agfs.map(agf=>({id:agf.id,durations:{},timeline:[]}));
  for(let i=0;i<run.events.length;i++) {
    const startMs=run.events[i].timeMs,endMs=Math.min(durationMs,run.events[i+1]?.timeMs??durationMs);
    if(endMs<=startMs)continue;
    for(const row of agfs) {
      const snapshot=run.snapshots[i],agf=snapshot.agfs.find(a=>a.id===row.id);
      const status=effectiveStatus(agf,snapshot);
      row.durations[status]=(row.durations[status]??0)+endMs-startMs;
      const last=row.timeline.at(-1);
      if(last?.status===status&&last.taskId===agf.taskId&&last.endMs===startMs)last.endMs=endMs;
      else row.timeline.push({startMs,endMs,status,taskId:agf.taskId});
    }
  }
  for(const row of agfs) {
    row.workingMs=workingStatuses.reduce((sum,status)=>sum+(row.durations[status]??0),0);
    row.utilizationPct=durationMs?100*row.workingMs/durationMs:0;
  }
  const tasks=run.final.tasks;
  const byKind=['01','02','03','04','05'].map(kind=>{
    const own=tasks.filter(t=>t.kind===kind);
    return {kind,requested:own.length,completed:own.filter(t=>t.status==='completed').length,
      pending:own.filter(t=>t.status!=='completed').length};
  });
  const sum=key=>agfs.reduce((total,agf)=>total+(agf.durations[key]??0),0);
  const productStats=new Map();
  const activePallets=new Set(tasks.map(t=>t.palletId).filter(Boolean));
  for(const p of run.final.pallets??[]){
    if(!activePallets.has(p.palletId)||!p.productType)continue;
    const key=[p.sourceLineId,p.productType,p.loadType].join('/');
    if(!productStats.has(key))productStats.set(key,{sourceLineId:p.sourceLineId,productType:p.productType,loadType:p.loadType,requested:0,stored:0,pending:0});
    const row=productStats.get(key);row.requested++;row[p.stage==='stored'?'stored':'pending']++;
  }
  return {durationMs,agfs,byKind,requested:tasks.length,
    products:[...productStats.values()].sort((a,b)=>[a.sourceLineId,a.productType,a.loadType].join().localeCompare([b.sourceLineId,b.productType,b.loadType].join(),'en')),
    storage:run.scenario.warehousePolicy?warehouseAvailability(new Map(Object.entries(run.final.warehouse)),
      new Map(run.final.pallets.map(p=>[p.palletId,p])),run.scenario.warehousePolicy):null,
    completed:tasks.filter(t=>t.status==='completed').length,
    pending:tasks.filter(t=>t.status!=='completed').length,
    held:tasks.filter(t=>t.status!=='completed'&&t.waitReason).length,
    preRequestHeld:(run.final.pallets??[]).filter(p=>p.stage==='exit_ready'&&p.waitReason).length,
    utilizationPct:agfs.length?agfs.reduce((n,a)=>n+a.utilizationPct,0)/agfs.length:0,
    idleMs:sum('idle')+sum('hp_wait'),hpWaitMs:sum('hp_wait'),waitReturnMs:sum('moving_to_wait'),
    hpBlockedMs:sum('waiting_hp_instruction')+sum('waiting_hp_capacity')+sum('waiting_hp_route'),
    dropWaitMs:sum('wait_drop'),chargeMs:sum('charging'),
    trafficWaitMs:sum('waiting_traffic'),
    chargeWaitMs:sum('waiting_charge'),chargeTravelMs:sum('moving_to_charge'),
    requestWaitMs:tasks.reduce((n,t)=>n+Math.max(0,(t.assignedAt??durationMs)-t.requestedAt),0)};
}

export function compareRuns(scenario) {
  return ['area_first','low_battery_first'].map(mode=>simulate({...structuredClone(scenario),mode}));
}
