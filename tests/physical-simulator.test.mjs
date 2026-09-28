import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {analyzeRun} from '../src/ui/replay-model.mjs';

const topology=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));

function scenario(){
  const value=createDemoScenario('manual');
  value.durationMin=20;
  value.motionModel='synthetic_graph';
  value.operationalTopology=structuredClone(topology);
  value.agfs=value.agfs.map((agf,index)=>({...agf,currentNodeId:index<2?'PZ-HOME':'WH-HOME'}));
  value.productionEvents=[{timeMs:0,lineId:'L1',palletId:'SYN-PHYSICAL-1',
    destinationLocationId:value.generatedDestinationIds[0]}];
  value.lineIntervalsMin=Array(8).fill(0);
  value.times={...value.times,pickupMin:.01,dropoffMin:.01,wrapMin:.05,labelMin:.01,exitMin:.01};
  return value;
}

test('synthetic graph drives empty and loaded segments around existing pickup and drop events',()=>{
  const run=simulate(scenario());
  const types=run.events.map(event=>event.type);
  assert.ok(types.includes('ROUTE_PLANNED'));
  assert.ok(types.includes('SEGMENT_ENTERED'));
  assert.ok(types.includes('SEGMENT_EXITED'));
  const task=run.final.tasks.find(item=>item.kind==='01');
  assert.equal(task.status,'completed');
  const assigned=run.events.find(event=>event.type==='TASK_ASSIGNED'&&event.taskId===task.id);
  const pickup=run.events.find(event=>event.type==='TASK_PICKED'&&event.taskId===task.id);
  const dropped=run.events.find(event=>event.type==='TASK_DROPPED'&&event.taskId===task.id);
  const completed=run.events.find(event=>event.type==='TASK_COMPLETED'&&event.taskId===task.id);
  assert.ok(assigned.timeMs<pickup.timeMs&&pickup.timeMs<dropped.timeMs&&dropped.timeMs===completed.timeMs);
  assert.ok(run.events.filter(event=>event.taskId===task.id&&event.type==='SEGMENT_ENTERED')
    .some(event=>event.movement==='empty'));
  assert.ok(run.events.filter(event=>event.taskId===task.id&&event.type==='SEGMENT_ENTERED')
    .some(event=>event.movement==='loaded'));
  assert.equal(run.metrics.scenarioTiming,'synthetic-graph-assumption');
  assert.equal(run.scenario.operationalTopology.readiness.physicalEtaAllowed,false);
  assert.deepEqual(run.final.traffic.owners,{});
});

test('closed shutter holds at its approach and resumes only after an explicit synthetic permission event',()=>{
  const input=scenario();
  input.operationalTopology.shutters[0].initiallyPassable=false;
  input.shutterEvents=[{timeMs:120000,shutterId:'SH-EAST',passable:true}];
  input.agfs=input.agfs.map(agf=>({...agf,currentNodeId:'WH-HOME',area:'WH'}));
  const run=simulate(input);
  const wait=run.events.find(event=>event.type==='SHUTTER_WAITING');
  const opened=run.events.find(event=>event.type==='SHUTTER_STATE_CHANGED'&&event.passable);
  const entered=run.events.find(event=>event.type==='SEGMENT_ENTERED'&&event.edgeId==='E09');
  assert.ok(wait&&opened&&entered);
  assert.ok(wait.timeMs<opened.timeMs&&entered.timeMs>=opened.timeMs);
  assert.ok(run.events.some(event=>event.type==='TRAFFIC_WAIT_ENDED'&&event.reason==='SHUTTER'));
  assert.equal(run.snapshots[wait.sequence].gates['SH-EAST'].passable,false);
  assert.equal(run.snapshots[opened.sequence].gates['SH-EAST'].passable,true);
  assert.notEqual(run.snapshots[wait.sequence].gates['SH-EAST'],run.snapshots[opened.sequence].gates['SH-EAST']);
});

test('unreachable pickup stays queued and never mutates pallet or AGF load',()=>{
  const input=scenario();
  input.operationalTopology.edges=input.operationalTopology.edges.filter(edge=>!['E01','E02'].includes(edge.id));
  input.agfs=input.agfs.map(agf=>({...agf,currentNodeId:'PZ-HOME',area:'PZ'}));
  const run=simulate(input);
  const task=run.final.tasks.find(item=>item.kind==='01');
  assert.equal(task.status,'queued');
  assert.equal(task.waitReason,'UNREACHABLE_ROUTE');
  assert.ok(!run.events.some(event=>event.type==='TASK_PICKED'&&event.taskId===task.id));
  assert.ok(run.final.agfs.every(agf=>agf.carriedPalletId===null));
});

test('unreachable replenishment does not reserve an aligner without an AGF assignment',()=>{
  const input=scenario();
  input.productionEvents=[];
  input.aligners[0].ready=true;
  input.magazineUses=[{timeMs:0,magazineId:'M1'}];
  input.operationalTopology.edges=input.operationalTopology.edges.filter(edge=>edge.id!=='E12');
  const run=simulate(input),task=run.final.tasks.find(item=>item.kind==='03');
  assert.equal(task.status,'queued');
  assert.equal(task.waitReason,'UNREACHABLE_ROUTE');
  assert.equal(run.final.aligners.AL1.reservedTaskId,null);
  assert.equal(run.final.aligners.AL1.ready,true);
  assert.ok(!run.events.some(event=>event.type==='TASK_ASSIGNED'&&event.taskId===task.id));
});

test('synthetic graph run is deterministic even when serialized edge order changes',()=>{
  const first=scenario(),second=scenario();
  second.operationalTopology.edges.reverse();
  const a=simulate(first),b=simulate(second);
  assert.deepEqual(a.events,b.events);
  assert.deepEqual(a.final,b.final);
});

test('legacy fixed-time scenario retains its original event vocabulary',()=>{
  const run=simulate(createDemoScenario('manual'));
  assert.ok(!run.events.some(event=>event.type.startsWith('SEGMENT_')||event.type==='ROUTE_PLANNED'));
  assert.ok(!('traffic' in run.final));
});

test('three-hour synthetic run integrates all transports, traffic and charging with reproducible input',()=>{
  const input=scenario();
  input.durationMin=180;
  input.agfs=input.agfs.map(agf=>({...agf,batteryPct:40.01}));
  input.productionEvents.push({timeMs:0,lineId:'L2',palletId:'SYN-PHYSICAL-2',
    destinationLocationId:input.generatedDestinationIds[1]});
  input.manualRequests=[
    {timeMs:0,kind:'04',palletId:'SIM-TEMP-1',locationId:'OT1',reentryPermission:true},
    {timeMs:0,kind:'05',palletId:'SIM-TEMP-2',locationId:'OT2',storagePermission:true,
      destinationLocationId:input.temporaryPallets[1].destinationLocationId}
  ];
  input.alignerReadyEvents=[{timeMs:0,alignerId:'AL1'}];
  input.magazineUses=[{timeMs:180000,magazineId:'M1'}];
  const original=structuredClone(input),run=simulate(input),repeated=simulate(input);
  assert.deepEqual(input,original);
  assert.deepEqual(run.events,repeated.events);
  assert.deepEqual(run.final,repeated.final);
  assert.equal(run.events.at(-1).timeMs,10800000);
  for(const kind of ['01','02','03','04','05'])assert.ok(run.metrics.byKind[kind]>0,kind);
  assert.equal(run.metrics.pendingTasks,0);
  assert.ok(run.events.some(event=>event.type==='SEGMENT_WAITING'));
  assert.ok(run.events.some(event=>event.type==='CHARGE_WAITING'));
  assert.ok(run.events.some(event=>event.type==='SEGMENT_ENTERED'&&event.movement==='charge'));
  for(const event of run.events.filter(event=>event.type==='CHARGE_STARTED')){
    const snapshot=run.snapshots[event.sequence],agf=snapshot.agfs.find(item=>item.id===event.agfId);
    assert.equal(agf.currentNodeId,'WH-CHARGE');
  }
  for(const snapshot of run.snapshots){
    const occupied=Object.values(snapshot.chargers).filter(Boolean);
    assert.ok(occupied.length<=2);
    assert.equal(new Set(occupied).size,occupied.length);
    assert.ok(snapshot.agfs.every(agf=>agf.batteryPct>=0&&agf.batteryPct<=100));
  }
  assert.deepEqual(run.final.traffic.owners,{});
  assert.deepEqual(run.final.traffic.waiting,[]);
  for(const agf of analyzeRun(run).agfs)
    assert.equal(Object.values(agf.durations).reduce((total,value)=>total+value,0),10800000);
  for(const palletId of ['SYN-PHYSICAL-1','SYN-PHYSICAL-2','SIM-TEMP-1','SIM-TEMP-2']){
    assert.equal(Object.values(run.final.warehouse).filter(slot=>slot.palletIds.includes(palletId)).length,1);
  }
  const otherMode=simulate({...input,mode:'low_battery_first'});
  const productionEvents=value=>value.events.filter(event=>event.type==='PALLET_EXITED')
    .map(({sequence,...event})=>event);
  assert.deepEqual(productionEvents(run),productionEvents(otherMode));
  assert.deepEqual(run.scenario.productionEvents,otherMode.scenario.productionEvents);
});