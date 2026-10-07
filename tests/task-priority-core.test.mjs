import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {taskPriorityScenario} from './fixtures/task-priority-scenario.mjs';
import {DEFAULT_TASK_PRIORITIES,validateTaskPriorities,resolveTaskPriority,orderPendingTasks}
  from '../src/core/task-priority.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';

const produced=(timeMs,lineId,palletId)=>({timeMs,lineId,palletId,destinationLocationId:'S1'});
const assignments=run=>run.events.filter(e=>e.type==='TASK_ASSIGNED');
const firstAfterSeed=run=>assignments(run).find(e=>e.palletId!=='SYN-PRIORITY-SEED');
const defaults=()=>structuredClone(DEFAULT_TASK_PRIORITIES);
const queued=(id,kind,taskPriority,requestedAt,requestSequence,extra={})=>({id,kind,taskPriority,
  requestedAt,requestSequence,status:'queued',...extra});
const priorityPaths=()=>[['wrapperOutput'],...[1,2,3,4,5].map(n=>['magazines','M'+n]),
  ...[1,2,3,4,5,6,7,8].map(n=>['lines','L'+n])];
const update=(settings,path,value)=>{if(path.length===1)settings[path[0]]=value;else settings[path[0]][path[1]]=value;};

test('07a default priorities include exactly fourteen editable values and are nested immutable',()=>{
  assert.deepEqual(DEFAULT_TASK_PRIORITIES,taskPriorityScenario().taskPriorities);
  assert.equal(priorityPaths().length,14);
  assert.ok(Object.isFrozen(DEFAULT_TASK_PRIORITIES));
  assert.ok(Object.isFrozen(DEFAULT_TASK_PRIORITIES.lines));
  assert.ok(Object.isFrozen(DEFAULT_TASK_PRIORITIES.magazines));
  assert.throws(()=>{DEFAULT_TASK_PRIORITIES.lines.L1=99;},TypeError);
});

test('priority validation permits ties and both inclusive integer boundaries',()=>{
  for(const value of [1,34,99]){
    const settings=defaults();for(const path of priorityPaths())update(settings,path,value);
    assert.doesNotThrow(()=>validateTaskPriorities(settings));
    assert.doesNotThrow(()=>simulate(taskPriorityScenario({taskPriorities:settings,durationMin:.1})));
  }
});

for(const [name,value] of [['zero',0],['over maximum',100],['fraction',1.5],['empty string',''],
  ['numeric string','10'],['null',null],['undefined',undefined],['nonfinite',Infinity]]){
  test('all fourteen explicit priority fields reject '+name,()=>{
    for(const path of priorityPaths()){
      const settings=defaults();update(settings,path,value);
      assert.throws(()=>validateTaskPriorities(settings),/TASK_PRIORITY_CONFIG/);
      assert.throws(()=>simulate(taskPriorityScenario({taskPriorities:settings,durationMin:.1})),/TASK_PRIORITY_CONFIG/);
    }
  });
}

test('explicit priority configuration rejects every missing field, extra equipment and malformed groups',()=>{
  for(const path of priorityPaths()){
    const settings=defaults();if(path.length===1)delete settings[path[0]];else delete settings[path[0]][path[1]];
    assert.throws(()=>validateTaskPriorities(settings),/TASK_PRIORITY_CONFIG/);
  }
  for(const mutation of [s=>{s.lines.L9=30;},s=>{s.magazines.M6=20;},s=>{s.charging=0;},
    s=>{s.lines=[];},s=>{s.magazines=null;},s=>{delete s.lines;}]){
    const settings=defaults();mutation(settings);
    assert.throws(()=>validateTaskPriorities(settings),/TASK_PRIORITY_CONFIG/);
  }
  for(const malformed of [null,[],{},10])assert.throws(()=>validateTaskPriorities(malformed),/TASK_PRIORITY_CONFIG/);
  assert.doesNotThrow(()=>validateTaskPriorities(undefined),'only omitted settings select legacy FIFO');
});

test('resolver uses source line, wrapper output and destination magazine without inventing manual priority',()=>{
  const settings=defaults();
  assert.deepEqual(resolveTaskPriority({kind:'01',sourceLineId:'L1'},settings),{prioritySourceId:'L1',taskPriority:30});
  assert.deepEqual(resolveTaskPriority({kind:'02',sourceLineId:'L8'},settings),{prioritySourceId:'WRAPPER-OUTPUT',taskPriority:10});
  assert.deepEqual(resolveTaskPriority({kind:'03',magazineId:'M1',alignerId:'M4'},settings),{prioritySourceId:'M1',taskPriority:24});
  for(const kind of ['04','05'])assert.deepEqual(resolveTaskPriority({kind},settings),{});
  assert.deepEqual(resolveTaskPriority({kind:'01'},undefined),{});
  for(const task of [{kind:'01'},{kind:'01',lineId:'L1'},{kind:'01',sourceLineId:'L9'},
    {kind:'03',alignerId:'AL1'},{kind:'03',magazineId:'M6'}]){
    assert.throws(()=>resolveTaskPriority(task,settings),/TASK_PRIORITY_CONFIG/);
  }
});

test('only queued automatic positions change, preserving manual and active task positions',()=>{
  const tasks=new Map([
    queued('04-A','04',undefined,0,0),queued('01-L2','01',34,10,2),
    queued('02-A','02',10,20,3),queued('05-A','05',undefined,30,4),
    queued('01-L1','01',30,40,5),queued('ACTIVE','01',1,0,1,{status:'moving_loaded'})
  ].map(t=>[t.id,t]));
  const pending=[...tasks.keys()],before=structuredClone([...tasks]);
  assert.deepEqual(orderPendingTasks(pending,tasks,defaults()),['04-A','02-A','01-L1','05-A','01-L2','ACTIVE']);
  assert.deepEqual(pending,[...tasks.keys()]);assert.deepEqual([...tasks],before);
  assert.deepEqual(orderPendingTasks(pending,tasks,undefined),pending);
});

test('priority ties use requested time then saved sequence even if pending IDs are reversed',()=>{
  const rows=[queued('NEW','01',34,200,1),queued('LATE-SEQUENCE','01',34,100,9),
    queued('EARLY-SEQUENCE','01',34,100,3)];
  const tasks=new Map(rows.map(t=>[t.id,t]));
  assert.deepEqual(orderPendingTasks(['NEW','LATE-SEQUENCE','EARLY-SEQUENCE'],tasks,defaults()),
    ['EARLY-SEQUENCE','LATE-SEQUENCE','NEW']);
});

test('saved task priorities remain authoritative if configuration is edited after creation',()=>{
  const settings=defaults(),tasks=new Map([queued('L1','01',30,0,1),queued('L2','01',34,0,2)].map(t=>[t.id,t]));
  settings.lines.L2=1;settings.lines.L1=99;
  assert.deepEqual(orderPendingTasks(['L2','L1'],tasks,settings),['L1','L2']);
});

test('pending L1 outranks earlier L2 when the occupied vehicle becomes free',()=>{
  const scenario=taskPriorityScenario({productionEvents:[produced(0,'L8','SYN-PRIORITY-SEED'),
    produced(30_000,'L2','SYN-PRIORITY-L2'),produced(40_000,'L1','SYN-PRIORITY-L1')]});
  const run=simulate(scenario);
  assert.equal(firstAfterSeed(run).palletId,'SYN-PRIORITY-L1');
});

test('pending 03 uses destination M4 priority ahead of earlier M1 rather than aligner ID order',()=>{
  const run=simulate(taskPriorityScenario({magazineUses:[{timeMs:30_000,magazineId:'M1'},
    {timeMs:40_000,magazineId:'M4'}]}));
  const event=firstAfterSeed(run),task=run.final.tasks.find(t=>t.id===event.taskId);
  assert.equal(event.kind,'03');assert.equal(task.magazineId,'M4');
  assert.equal(task.alignerId,'AL2','source reservations retain the existing deterministic tie-break');
});

test('pending 02 precedes an older 01 when both wait for the same occupied AGF',()=>{
  const run=simulate(taskPriorityScenario({productionEvents:[produced(0,'L8','SYN-PRIORITY-SEED'),
    produced(30_000,'L1','SYN-PRIORITY-OCCUPIER'),produced(40_000,'L2','SYN-PRIORITY-OLDER-01')]}));
  const outflow=run.events.find(e=>e.type==='TASK_REQUESTED'&&e.kind==='02');
  const older=run.events.find(e=>e.type==='TASK_REQUESTED'&&e.palletId==='SYN-PRIORITY-OLDER-01');
  assert.ok(outflow.timeMs>older.timeMs);
  assert.equal(assignments(run)[2].kind,'02');assert.equal(assignments(run)[2].taskId,outflow.taskId);
});

test('equal-priority queued lines honor older request and same-time event sequence',()=>{
  for(const arrivals of [[produced(30_000,'L3','SYN-PRIORITY-EARLY'),produced(40_000,'L2','SYN-PRIORITY-LATE')],
    [produced(30_000,'L3','SYN-PRIORITY-EARLY'),produced(30_000,'L2','SYN-PRIORITY-LATE')]]){
    const run=simulate(taskPriorityScenario({productionEvents:[produced(0,'L8','SYN-PRIORITY-SEED'),...arrivals]}));
    const requests=run.events.filter(e=>e.type==='TASK_REQUESTED'&&['SYN-PRIORITY-EARLY','SYN-PRIORITY-LATE'].includes(e.palletId));
    assert.ok(requests[0].sequence<requests[1].sequence);
    assert.equal(firstAfterSeed(run).palletId,'SYN-PRIORITY-EARLY');
  }
});

test('an unavailable high-priority 02 stays queued while a lower-priority 03 is assigned',()=>{
  const run=simulate(taskPriorityScenario({fallback:'wait',magazineUses:[{timeMs:30_000,magazineId:'M1'},
    {timeMs:135_000,magazineId:'M4'}]}));
  const outflow=run.events.find(e=>e.type==='TASK_REQUESTED'&&e.kind==='02');
  assert.ok(outflow);assert.equal(outflow.taskPriority,10);
  const lower=assignments(run).find(e=>e.taskPriority===20);assert.ok(lower);
  const hold=run.events.find(e=>e.type==='TASK_WAITING'&&e.taskId===outflow.taskId);
  assert.ok(hold);assert.ok(hold.sequence<lower.sequence);
  const atLowerAssignment=run.snapshots[lower.sequence].tasks.find(t=>t.id===outflow.taskId);
  assert.equal(atLowerAssignment.status,'queued');assert.equal(atLowerAssignment.waitReason,'NO_ELIGIBLE_AGF');
  assert.equal(run.final.tasks.find(t=>t.id===outflow.taskId).status,'queued');
  assert.ok(!assignments(run).some(e=>e.taskId===outflow.taskId));
});

test('each assignment in one dispatch reevaluates AGFs after the preceding task changes their status',()=>{
  const run=simulate(taskPriorityScenario({productionEvents:[],
    agfs:[1,2,3,4].map(n=>({id:'AGF'+n,area:'PZ',batteryPct:100})),
    aligners:[1,2,3,4,5].map(n=>({id:'AL'+n,quantity:0})),
    magazineUses:[{timeMs:0,magazineId:'M1'},{timeMs:0,magazineId:'M4'}],
    alignerRefillEvents:[{timeMs:30_000,operationType:'all'}]}));
  const allocated=assignments(run).filter(e=>e.timeMs===30_000);
  assert.equal(allocated.length,2);
  assert.deepEqual(allocated.map(e=>e.taskPriority),[20,24]);
  assert.deepEqual(allocated.map(e=>e.agfId),['AGF1','AGF2']);
  const reevaluation=allocated[1].dispatchSelection.evaluations.find(e=>e.agfId==='AGF1');
  assert.equal(reevaluation.status,'moving_empty');assert.equal(reevaluation.eligible,false);
});

test('request sequence and resolved priority persist in task, first snapshot and assignment events',()=>{
  const scenario=taskPriorityScenario({magazineUses:[{timeMs:30_000,magazineId:'M4'}]}),run=simulate(scenario);
  for(const requested of run.events.filter(e=>e.type==='TASK_REQUESTED')){
    const task=run.final.tasks.find(t=>t.id===requested.taskId);
    assert.equal(task.requestSequence,requested.sequence);assert.equal(requested.requestSequence,requested.sequence);
    assert.equal(task.requestedAt,requested.timeMs);
    assert.equal(requested.taskPriority,task.taskPriority);assert.equal(requested.prioritySourceId,task.prioritySourceId);
    const first=run.snapshots[requested.sequence].tasks.find(t=>t.id===task.id);
    assert.equal(first.requestSequence,requested.sequence);assert.equal(first.taskPriority,requested.taskPriority);
    const assigned=assignments(run).find(e=>e.taskId===task.id);
    if(assigned){assert.equal(assigned.taskPriority,requested.taskPriority);assert.equal(assigned.prioritySourceId,requested.prioritySourceId);}
  }
  const before=structuredClone(run.events);scenario.taskPriorities.lines.L8=1;run.scenario.taskPriorities.lines.L8=99;
  assert.deepEqual(run.events,before);
});

test('editing equipment priority changes only a new run and does not alter an already saved result',()=>{
  const scenario=taskPriorityScenario({productionEvents:[produced(0,'L8','SYN-PRIORITY-SEED'),
    produced(30_000,'L2','SYN-PRIORITY-L2'),produced(40_000,'L1','SYN-PRIORITY-L1')]}),old=simulate(scenario);
  const saved=structuredClone({events:old.events,snapshots:old.snapshots});
  scenario.taskPriorities.lines.L2=1;
  assert.equal(firstAfterSeed(old).palletId,'SYN-PRIORITY-L1');
  assert.equal(firstAfterSeed(simulate(scenario)).palletId,'SYN-PRIORITY-L2');
  assert.deepEqual({events:old.events,snapshots:old.snapshots},saved);
});

test('late high-priority request never preempts an already assigned transport',()=>{
  const settings=defaults();settings.lines.L1=1;
  const run=simulate(taskPriorityScenario({taskPriorities:settings,productionEvents:[produced(0,'L8','SYN-PRIORITY-SEED'),
    produced(30_000,'L1','SYN-PRIORITY-HIGH-LATE')]}));
  const seed=assignments(run)[0],done=run.events.find(e=>e.type==='TASK_COMPLETED'&&e.taskId===seed.taskId);
  assert.equal(done.timeMs,120_000);assert.equal(seed.agfId,'AGF1');
  const late=run.events.find(e=>e.type==='TASK_REQUESTED'&&e.palletId==='SYN-PRIORITY-HIGH-LATE');
  assert.ok(late.timeMs<done.timeMs);
  assert.ok(assignments(run).filter(e=>e.timeMs<done.timeMs).every(e=>e.taskId===seed.taskId));
  const next=assignments(run).find(e=>e.taskId===late.taskId);assert.ok(next.sequence>done.sequence);
});

test('initial charge threshold is checked before queued ordinary transport in priority-enabled runs',()=>{
  for(const batteryPct of [39,40]){
    const scenario=taskPriorityScenario();scenario.agfs[0].batteryPct=batteryPct;
    const run=simulate(scenario),request=run.events.find(e=>e.type==='CHARGE_REQUESTED'&&e.agfId==='AGF1');
    const finished=run.events.find(e=>e.type==='CHARGE_ENDED'&&e.agfId==='AGF1');
    assert.equal(request.timeMs,0);assert.ok(finished);
    assert.ok(assignments(run).length);assert.ok(assignments(run).every(e=>e.agfId!=='AGF1'||e.sequence>finished.sequence));
    assert.ok(request.sequence<assignments(run)[0].sequence);
    assert.ok(!run.events.some(e=>e.type==='TASK_REQUESTED'&&e.kind==='CHARGE'));
  }
  const scenario=taskPriorityScenario();scenario.agfs[0].batteryPct=41;
  assert.equal(assignments(simulate(scenario))[0].timeMs,0,'above threshold stays eligible');
});

test('charge takes precedence after completion without interrupting the active low-energy transport',()=>{
  const scenario=taskPriorityScenario({productionEvents:[produced(0,'L8','SYN-PRIORITY-SEED'),
    produced(30_000,'L1','SYN-PRIORITY-PENDING')]}),settings=scenario.battery;
  scenario.agfs[0].batteryPct=41;settings.consumptionPct=2;
  const run=simulate(scenario),done=run.events.find(e=>e.type==='TASK_COMPLETED'&&e.palletId==='SYN-PRIORITY-SEED');
  const charge=run.events.find(e=>e.type==='CHARGE_REQUESTED'&&e.agfId==='AGF1');
  const charged=run.events.find(e=>e.type==='CHARGE_ENDED'&&e.agfId==='AGF1');
  assert.equal(done.timeMs,120_000);assert.equal(charge.timeMs,done.timeMs);assert.ok(charge.sequence>done.sequence);
  const next=assignments(run).find(e=>e.palletId==='SYN-PRIORITY-PENDING');
  assert.ok(next.sequence>charged.sequence);
});

test('manual 04 and 05 requests keep no priority fields and preserve their FIFO assignment order',()=>{
  const scenario=taskPriorityScenario({productionEvents:[],temporaryPallets:[
    {palletId:'SYN-MANUAL-04',locationId:'OT1',destinationLocationId:'S1'},
    {palletId:'SYN-MANUAL-05',locationId:'OT2',destinationLocationId:'S1'}],
    manualRequests:[{timeMs:0,kind:'04',palletId:'SYN-MANUAL-04',locationId:'OT1',reentryPermission:true},
      {timeMs:1,kind:'05',palletId:'SYN-MANUAL-05',locationId:'OT2',destinationLocationId:'S1',storagePermission:true}]});
  const run=simulate(scenario),manualAssignments=assignments(run).filter(e=>['04','05'].includes(e.kind));
  assert.deepEqual(manualAssignments.map(e=>e.kind),['04','05']);
  for(const task of run.final.tasks.filter(t=>['04','05'].includes(t.kind))){
    assert.ok(!Object.hasOwn(task,'taskPriority'));assert.ok(!Object.hasOwn(task,'prioritySourceId'));
    const request=run.events.find(e=>e.type==='TASK_REQUESTED'&&e.taskId===task.id);
    assert.ok(!Object.hasOwn(request,'taskPriority'));assert.ok(!Object.hasOwn(request,'prioritySourceId'));
    const assignment=manualAssignments.find(e=>e.taskId===task.id);
    assert.ok(!Object.hasOwn(assignment,'taskPriority'));assert.ok(!Object.hasOwn(assignment,'prioritySourceId'));
  }
});

test('omitted configuration preserves FIFO and never silently adds standard equipment priorities',()=>{
  const scenario=taskPriorityScenario({taskPriorities:undefined,productionEvents:[produced(0,'L8','SYN-PRIORITY-SEED'),
    produced(30_000,'L2','SYN-PRIORITY-L2'),produced(40_000,'L1','SYN-PRIORITY-L1')]});
  const run=simulate(scenario);assert.equal(firstAfterSeed(run).palletId,'SYN-PRIORITY-L2');
  assert.ok(run.final.tasks.every(t=>!Object.hasOwn(t,'taskPriority')&&!Object.hasOwn(t,'prioritySourceId')));
  assert.ok(run.events.filter(e=>['TASK_REQUESTED','TASK_ASSIGNED'].includes(e.type)).every(e=>!Object.hasOwn(e,'taskPriority')));
  assert.deepEqual(simulate(scenario).events,run.events);
  for(const preset of ['manual','physical','charge'])assert.equal(createDemoScenario(preset).taskPriorities,undefined);
});

test('synthetic graph requests carry priority while route and initial parking checks remain enforced',()=>{
  const scenario=createDemoScenario('physical');scenario.durationMin=.1;scenario.lineIntervalsMin=Array(8).fill(0);
  scenario.temporaryPallets=[];scenario.productionEvents=[produced(0,'L1','SYN-PRIORITY-GRAPH')];
  scenario.productionEvents[0].destinationLocationId=scenario.generatedDestinationIds[0];
  scenario.taskPriorities=defaults();
  const run=simulate(scenario),request=run.events.find(e=>e.type==='TASK_REQUESTED'&&e.kind==='01');
  const assignment=assignments(run)[0];
  assert.equal(request.prioritySourceId,'L1');assert.equal(request.taskPriority,30);
  assert.equal(assignment.taskPriority,30);assert.equal(assignment.etaStatus,'synthetic-assumption');
  assert.ok(run.events.some(e=>e.type==='SEGMENT_ENTERED'));
  assert.deepEqual(simulate(scenario).events,run.events);
});
