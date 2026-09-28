import {simulate} from '../core/simulate.mjs';

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
export function effectiveStatus(agf,snapshot) {
  return snapshot.tasks.find(task=>task.id===agf.taskId)?.status==='wait_drop'?'wait_drop':agf.status;
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
    row.workingMs=(row.durations.moving_empty??0)+(row.durations.moving_loaded??0);
    row.utilizationPct=durationMs?100*row.workingMs/durationMs:0;
  }
  const tasks=run.final.tasks;
  const byKind=['01','02','03','04','05'].map(kind=>{
    const own=tasks.filter(t=>t.kind===kind);
    return {kind,requested:own.length,completed:own.filter(t=>t.status==='completed').length,
      pending:own.filter(t=>t.status!=='completed').length};
  });
  const sum=key=>agfs.reduce((total,agf)=>total+(agf.durations[key]??0),0);
  return {durationMs,agfs,byKind,requested:tasks.length,
    completed:tasks.filter(t=>t.status==='completed').length,
    pending:tasks.filter(t=>t.status!=='completed').length,
    held:tasks.filter(t=>t.status!=='completed'&&t.waitReason).length,
    preRequestHeld:(run.final.pallets??[]).filter(p=>p.stage==='exit_ready'&&p.waitReason).length,
    utilizationPct:agfs.length?agfs.reduce((n,a)=>n+a.utilizationPct,0)/agfs.length:0,
    idleMs:sum('idle'),dropWaitMs:sum('wait_drop'),chargeMs:sum('charging'),
    trafficWaitMs:sum('waiting_traffic'),
    chargeWaitMs:sum('waiting_charge'),chargeTravelMs:sum('moving_to_charge'),
    requestWaitMs:tasks.reduce((n,t)=>n+Math.max(0,(t.assignedAt??durationMs)-t.requestedAt),0)};
}

export function compareRuns(scenario) {
  return ['area_first','low_battery_first'].map(mode=>simulate({...structuredClone(scenario),mode}));
}
