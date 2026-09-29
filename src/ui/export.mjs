/** A complete reproducible scenario is retained in the first event row. */
export function eventCsv(run,runId) {
  const columns=['runId','mode','timeMs','sequence','type','kind','taskId','palletId','agfId','originId','destinationId',
    'status','lineId','magazineId','locationId','reason','inputKind','edgeId','laneId','fromNodeId','toNodeId','nodeId','movement','heading','modelDurationMs',
    'shutterId','passable','etaStatus','target','targetId','permitted','permissionEvidence','hpId','placeId','chargePlaceId','chargerId',
    'sourceLineId','productType','loadType','storageLocationId','blockId','row','column','tier','storageResult',
    'timingStatus','inventoryStatus','batteryModel','batteryConsumptionBasis','batteryScope','scenarioJson'];
  const cell=value=>{const s=String(value??'');return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
  const rows=run.events.map((event,index)=>{
    const task=run.snapshots[index].tasks.find(t=>t.id===event.taskId);
    const row={runId,mode:run.scenario.mode,originId:task?.originId,destinationId:task?.destinationId,
      status:task?.status,agfId:task?.agfId,...event,
      storageResult:event.type==='STORE_COMPLETED'?'stored':event.type==='TASK_02_HELD'||(task?.kind==='05'&&event.type==='TASK_WAITING')?'held':'',
      timingStatus:run.scenario.motionModel==='synthetic_graph'?'synthetic-graph-assumption':'scenario-assumption',
      inventoryStatus:run.scenario.evidence?.inventory??'unspecified',batteryModel:run.scenario.battery.consumptionModel??'per_task',
      batteryConsumptionBasis:run.scenario.evidence?.batteryConsumption??'scenario-assumption',
      batteryScope:run.scenario.evidence?.batteryScope??'legacy-per-task',scenarioJson:index===0?JSON.stringify(run.scenario):''};
    return columns.map(column=>cell(row[column])).join(',');
  });
  return '\ufeff'+[columns.join(','),...rows].join('\r\n');
}
