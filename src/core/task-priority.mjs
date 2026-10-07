// Specification 07a defaults are editable simulation settings, not measured
// facility operating priorities. Missing configuration preserves legacy FIFO.
export const DEFAULT_TASK_PRIORITIES=Object.freeze({
  wrapperOutput:10,
  magazines:Object.freeze({M1:24,M2:22,M3:23,M4:20,M5:21}),
  lines:Object.freeze({L1:30,L2:34,L3:34,L4:32,L5:33,L6:31,L7:34,L8:34})
});
const automaticKinds=new Set(['01','02','03']);
const fail=message=>{throw new Error('TASK_PRIORITY_CONFIG: '+message);};
const objectWithKeys=(value,keys,path)=>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(path+' must be an object');
  for(const key of Object.keys(value))if(!keys.includes(key))fail(path+'.'+key+' is not a supported equipment setting');
  for(const key of keys)if(!Object.hasOwn(value,key))fail(path+'.'+key+' is required');
};
const validPriority=(value,path)=>{
  if(!Number.isInteger(value)||value<1||value>99)fail(path+' must be an integer from 1 to 99');
};

/** Validate the complete explicit setting; do not fill missing equipment. */
export function validateTaskPriorities(settings){
  if(settings===undefined)return;
  objectWithKeys(settings,['wrapperOutput','magazines','lines'],'taskPriorities');
  validPriority(settings.wrapperOutput,'taskPriorities.wrapperOutput');
  for(const group of ['magazines','lines']){
    const ids=Object.keys(DEFAULT_TASK_PRIORITIES[group]);
    objectWithKeys(settings[group],ids,'taskPriorities.'+group);
    for(const id of ids)validPriority(settings[group][id],`taskPriorities.${group}.${id}`);
  }
}

/** Resolve once when the request is created, before any assignment mutates it. */
export function resolveTaskPriority(task,settings){
  if(settings===undefined||!automaticKinds.has(task.kind))return {};
  let prioritySourceId,taskPriority;
  if(task.kind==='01'){
    prioritySourceId=task.sourceLineId;
    if(!Object.hasOwn(settings.lines,prioritySourceId))fail('01 requires a known sourceLineId');
    taskPriority=settings.lines[prioritySourceId];
  }else if(task.kind==='02'){
    prioritySourceId='WRAPPER-OUTPUT';taskPriority=settings.wrapperOutput;
  }else{
    prioritySourceId=task.magazineId;
    if(!Object.hasOwn(settings.magazines,prioritySourceId))fail('03 requires a known magazineId');
    taskPriority=settings.magazines[prioritySourceId];
  }
  return {prioritySourceId,taskPriority};
}

/** Replace only queued automatic-task positions; retain manual-task positions,
 * completed/assigned positions and the underlying pending list unchanged. */
export function orderPendingTasks(pendingIds,tasks,settings){
  if(settings===undefined)return pendingIds;
  const automatic=id=>{
    const task=tasks.get(id);
    return task?.status==='queued'&&automaticKinds.has(task.kind);
  };
  const sorted=pendingIds.filter(automatic).sort((left,right)=>{
    const a=tasks.get(left),b=tasks.get(right);
    return a.taskPriority-b.taskPriority||a.requestedAt-b.requestedAt||a.requestSequence-b.requestSequence;
  });
  let next=0;
  return pendingIds.map(id=>automatic(id)?sorted[next++]:id);
}
