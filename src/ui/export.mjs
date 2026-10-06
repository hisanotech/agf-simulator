import {buildRunConditions} from './run-conditions.mjs';

const csvCell=value=>{const s=typeof value==='object'&&value!==null?JSON.stringify(value):String(value??'');
  return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};

/** Separate human-readable conditions file; source is the saved Run only. */
export function conditionCsv(run,runId=run.runId){
  const columns=['category','key','subkey','value','evidence'];
  const rows=buildRunConditions(run,{runId}).map(row=>columns.map(key=>csvCell(key==='value'&&row[key]===null?'UNSET':row[key])).join(','));
  return '\ufeff'+[columns.join(','),...rows].join('\r\n');
}
export const conditionCsvFilename=runId=>String(runId??'run')+'-conditions.csv';

/** A complete reproducible scenario is retained in the first event row. */
export function eventCsv(run,runId) {
  const columns=['runId','mode','timeMs','sequence','type','kind','taskId','palletId','agfId','originId','destinationId',
    'status','lineId','magazineId','locationId','reason','inputKind','edgeId','laneId','fromNodeId','toNodeId','nodeId','movement','heading','modelDurationMs',
    'headingDeg','fromHeadingDeg','targetHeadingDeg','angleDeg','startedAt','completedAt','turnDurationMs','turnRateDegPerSec','turnRateEvidence',
    'phase','phaseDurationMs','handlingEvidence','turningConsumesBattery','turningBatteryEvidence','motionControlJson',
    'planId','otherAgfId','blockedAgfId','agfIds','conflictGroupId','selectionReason','selectionEvidence','routeEvidence',
    'resourceIds','temporaryReverseEdgeIds','waitingPositionEvidence','waitMs','reservationCount','inputCount',
    'conveyorQuantity','conveyorCapacity','transferTimingEvidence',
    'operation','positioningMs','forkInsertedMs','angleEvidence','turningConsumptionStatus','resources','blockers','noOvertakingGroupId','groupDirection',
    'shutterId','passable','etaStatus','target','targetId','permitted','permissionEvidence','hpId','placeId','chargePlaceId','chargerId',
    'sourceLineId','productType','loadType','storageLocationId','blockId','row','column','tier','storageResult',
    'alignerId','quantityBefore','quantityAfter','quantity','refillBatch','refillNeeded','pickedAt','operatedAt','operationType',
    'originalDueAt','blockedSinceMs','lineCapacity','capacity','retry','recoveryPolicy','policy','count','sourceSelectionEvidence','evidence','plannedPalletId','palletStatus','processingTimeStatus','targetIds',
    'timingStatus','inventoryStatus','batteryModel','batteryConsumptionBasis','batteryScope','scenarioJson'];
  const cell=csvCell;
  const rows=run.events.map((event,index)=>{
    const task=run.snapshots[index].tasks.find(t=>t.id===event.taskId);
    const row={runId,mode:run.scenario.mode,originId:task?.originId,destinationId:task?.destinationId,
      status:task?.status,agfId:task?.agfId,...event,
      storageResult:event.type==='STORE_COMPLETED'?'stored':event.type==='TASK_02_HELD'||(task?.kind==='05'&&event.type==='TASK_WAITING')?'held':'',
      timingStatus:run.scenario.motionModel==='synthetic_graph'?'synthetic-graph-assumption':'scenario-assumption',
      inventoryStatus:run.scenario.evidence?.inventory??'unspecified',batteryModel:run.scenario.battery.consumptionModel??'per_task',
      batteryConsumptionBasis:run.scenario.evidence?.batteryConsumption??'scenario-assumption',
      batteryScope:run.scenario.evidence?.batteryScope??'legacy-per-task',scenarioJson:index===0?JSON.stringify(run.scenario):''};
    if(index===0&&run.scenario.motionControl)row.motionControlJson=JSON.stringify(run.scenario.motionControl);
    return columns.map(column=>cell(row[column])).join(',');
  });
  return '\ufeff'+[columns.join(','),...rows].join('\r\n');
}
