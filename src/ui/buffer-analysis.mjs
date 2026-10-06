const lineIds=Array.from({length:8},(_,i)=>'L'+(i+1));
const blockedReasons={PRODUCTION_BLOCKED_EMPTY_PALLET:'EMPTY_PALLET',
  PRODUCTION_BLOCKED_RECOVERY_POLICY:'RECOVERY_POLICY_UNSET',PRODUCTION_RECOVERY_UNRESOLVED:'RECOVERY_POLICY_UNSET',
  PRODUCTION_RETRY_WAITING_BUFFER:'LINE_BUFFER_FULL'};
const validQuantity=value=>Number.isInteger(value)&&value>=0;
const plannedId=event=>event.plannedPalletId??event.palletId??null;

/** Recalculate buffer waits from the same saved events that supply transport
 * history. User-confirmed intervals end at actual production resume, not at
 * buffer release: a subsequent empty-pallet wait is part of the delayed PL.
 * Snapshots and engine metrics are not a second source of buffer totals. */
export function analyzeLineBuffers(run){
  const durationMs=Math.max(0,Math.round(run.scenario.durationMin*60_000));
  const lines=lineIds.map(lineId=>({lineId,capacity:run.scenario.lineCapacity,maxQuantity:0,
    fullCount:0,stopMs:0,maxStopMs:0,delayedPalletCount:0,endedStatus:'生産可能',endedReason:null,intervals:[]}));
  const byLine=new Map(lines.map(line=>[line.lineId,line])),occupancy=new Map(lineIds.map(id=>[id,new Set()]));
  const tasks=new Map((run.final?.tasks??[]).map(task=>[task.id,task]));
  const palletLines=new Map((run.final?.pallets??[]).map(pallet=>[pallet.palletId,pallet.sourceLineId]));
  const active=new Map(),seenStops=new Set();
  const ordered=(run.events??[]).map((event,index)=>({event,index}))
    .filter(({event})=>Number.isInteger(event.timeMs)&&event.timeMs>=0&&event.timeMs<=durationMs)
    .sort((a,b)=>a.event.timeMs-b.event.timeMs||(a.event.sequence??0)-(b.event.sequence??0)||a.index-b.index);
  for(const {event} of ordered){
    const task=tasks.get(event.taskId),id=event.lineId??event.sourceLineId??palletLines.get(event.palletId)??
      ((event.kind??task?.kind)==='01'?task?.originId:null),line=byLine.get(id);
    if(!line)continue;
    const current=occupancy.get(id),bufferEvent=['LINE_BUFFER_BLOCKED','LINE_BUFFER_RELEASED',
      'PRODUCTION_RESUMED_FROM_BUFFER','PALLET_EXITED'].includes(event.type)||
      event.type==='TASK_PICKED'&&(event.kind??task?.kind)==='01';
    if(bufferEvent){
      for(const quantity of [event.quantityBefore,event.quantityAfter])
        if(validQuantity(quantity))line.maxQuantity=Math.max(line.maxQuantity,quantity);
    }
    if(event.type==='PALLET_EXITED'){
      if(event.palletId){current.add(event.palletId);palletLines.set(event.palletId,id);}
      line.maxQuantity=Math.max(line.maxQuantity,current.size);
      if(!active.has(id)){line.endedStatus='生産可能';line.endedReason=null;}
    }else if(event.type==='TASK_PICKED'&&(event.kind??task?.kind)==='01'){
      current.delete(event.palletId??task?.palletId);
    }else if(event.type==='LINE_BUFFER_BLOCKED'){
      line.endedStatus='生産停止中';line.endedReason='LINE_BUFFER_FULL';
      const palletId=plannedId(event),key=id+'\u0000'+(palletId??String(event.originalDueAt??event.timeMs));
      if(seenStops.has(key))continue;
      // A production line has one suspended PL. A repeated full notice for that
      // PL must not create a second interval when another prerequisite changes.
      if(active.has(id))continue;
      seenStops.add(key);
      const startMs=Math.min(event.timeMs,Math.max(0,Number.isInteger(event.blockedSinceMs)?event.blockedSinceMs:event.timeMs));
      const interval={plannedPalletId:palletId,startMs,endMs:null,resumed:false,stopMs:0};
      line.intervals.push(interval);active.set(id,interval);
    }else if(event.type==='PRODUCTION_RESUMED_FROM_BUFFER'){
      const interval=active.get(id),palletId=plannedId(event);
      if(interval&&interval.plannedPalletId!==null&&palletId!==interval.plannedPalletId)continue;
      if(interval){interval.endMs=event.timeMs;interval.resumed=true;active.delete(id);}
      line.endedStatus='生産可能';line.endedReason=null;
    }else if(blockedReasons[event.type]){
      line.endedStatus='生産停止中';line.endedReason=blockedReasons[event.type];
    }else if(event.type==='PRODUCTION_RECOVERY_WAIT_NEXT_TAKT'){
      // Refill is not production resume for the retained buffer PL. Keep the
      // interval open, but replace the obsolete empty-supply waiting reason.
      line.endedStatus=active.has(id)?'生産停止中':'生産可能';
      line.endedReason=active.has(id)?'WAIT_NEXT_TAKT':null;
    }
  }
  for(const line of lines){
    for(const interval of line.intervals){
      interval.endMs??=durationMs;interval.stopMs=Math.max(0,interval.endMs-interval.startMs);
      line.stopMs+=interval.stopMs;line.maxStopMs=Math.max(line.maxStopMs,interval.stopMs);
    }
    line.fullCount=line.intervals.length;line.delayedPalletCount=line.intervals.length;
    if(active.has(line.lineId))line.endedStatus='生産停止中';
  }
  const sum=key=>lines.reduce((total,line)=>total+line[key],0);
  return {durationMs,lines,fullCount:sum('fullCount'),stopMs:sum('stopMs'),
    maxStopMs:Math.max(...lines.map(line=>line.maxStopMs)),delayedPalletCount:sum('delayedPalletCount'),
    endedStoppedLineCount:lines.filter(line=>line.endedStatus==='生産停止中').length,
    endedBufferStoppedLineCount:active.size};
}
