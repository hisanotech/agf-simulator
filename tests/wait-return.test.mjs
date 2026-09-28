import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {selectAgf} from '../src/core/select-agf.mjs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';
import {analyzeRun} from '../src/ui/replay-model.mjs';

function scenario(){
  const s=createDemoScenario('physical');s.durationMin=180;s.lineIntervalsMin=Array(8).fill(0);
  s.agfs.forEach((a,i)=>{a.blocked=i!==0;a.area='WH';a.currentNodeId='WH-HOME';a.batteryPct=90;});
  s.postTaskPolicy={waitTargets:{AGF1:'HP1',AGF2:'HP2'},evidence:'synthetic-explicit-test'};
  s.manualRequests=[{timeMs:0,kind:'05',palletId:'SIM-TEMP-1',locationId:'OT1',storagePermission:true,
    destinationLocationId:s.generatedDestinationIds[0]}];
  return s;
}
const nextRequest=(s,timeMs)=>({timeMs,kind:'05',palletId:'SIM-TEMP-2',locationId:'OT2',storagePermission:true,
  destinationLocationId:s.generatedDestinationIds.find(id=>s.warehouse.find(w=>w.id===id).rowId!==s.warehouse.find(w=>w.id===s.generatedDestinationIds[0]).rowId)});

test('H26 next selected task starts directly at the prior drop without an HP detour',()=>{
  const s=scenario();s.manualRequests.push(nextRequest(s,0));const r=simulate(s);
  const a=r.final.tasks[0],b=r.final.tasks[1];assert.equal(a.agfId,b.agfId);assert.equal(a.completedAt,b.assignedAt);
  const between=r.events.filter(e=>e.timeMs>=a.completedAt&&e.timeMs<=b.assignedAt);
  assert.ok(!between.some(e=>e.type==='WAIT_RETURN_REQUESTED'));
});
test('H28/H32/H33 no next task returns to HP, consumes battery, occupies segments and projects position',()=>{
  const r=simulate(scenario()),arrived=r.events.find(e=>e.type==='WAIT_ARRIVED'),request=r.events.find(e=>e.type==='WAIT_RETURN_REQUESTED');
  assert.ok(arrived&&request);assert.ok(arrived.timeMs>request.timeMs);
  const entered=r.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.movement==='wait');assert.ok(entered);
  const a=r.snapshots[entered.sequence].agfs.find(a=>a.id===entered.agfId);
  assert.equal(a.status,'moving_to_wait');assert.ok(Object.values(r.snapshots[entered.sequence].traffic.owners).includes(a.id));
  assert.equal(projectAgfPosition(a,r.scenario.operationalTopology,entered.timeMs+entered.modelDurationMs/2).progress,.5);
  const before=r.snapshots[request.sequence].agfs[0],after=r.snapshots[arrived.sequence].agfs[0];
  assert.ok(after.batteryPct<before.batteryPct);assert.equal(after.currentNodeId,'HP1');assert.equal(after.status,'idle');
  assert.ok(analyzeRun(r).agfs[0].durations.moving_to_wait>0);
});
test('H29/H30/H38 a request during return cannot interrupt it, but can dispatch after HP arrival',()=>{
  const s=scenario(),first=simulate(s),entered=first.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.movement==='wait');
  assert.ok(entered);s.manualRequests.push(nextRequest(s,entered.timeMs+1));const r=simulate(s);
  const arrival=r.events.find(e=>e.type==='WAIT_ARRIVED');assert.ok(r.final.tasks[1].assignedAt>=arrival.timeMs);
  assert.equal(selectAgf([{id:'A',status:'moving_to_wait',taskId:null,batteryPct:90,area:'WH'}],
    {destinationArea:'WH'},{mode:'area_first',reservePct:40}),null);
});
for(const pending of [false,true])test(`H27/H34-H37 charging wins; after target 100% ${pending?'next task':'HP'} departs and frees charger`,()=>{
  const s=scenario();s.agfs[0].batteryPct=40.01;s.battery.chargeTargetPct=100;s.battery.chargeMinPerPct=.01;
  if(pending)s.manualRequests.push(nextRequest(s,0));const r=simulate(s);
  const charged=r.events.find(e=>e.type==='CHARGE_ENDED');assert.ok(charged);
  if(pending)assert.ok(r.final.tasks[1].assignedAt>=charged.timeMs);
  else assert.ok(r.events.some(e=>e.type==='WAIT_RETURN_REQUESTED'&&e.timeMs>=charged.timeMs));
  assert.ok(r.events.some(e=>e.type==='CHARGER_RELEASED'&&e.timeMs>=charged.timeMs));
  assert.ok(Object.values(r.final.chargers).every(a=>a===null));
});
test('unconfigured HP selection never invents a fixed HP or a pillar fallback',()=>{
  const s=scenario();s.postTaskPolicy.waitTargets={};const r=simulate(s),a=r.final.agfs[0];
  assert.equal(a.status,'waiting_hp_instruction');assert.equal(a.taskId,null);
  assert.ok(!r.events.some(e=>e.type==='WAIT_RETURN_REQUESTED'));
});

test('battery crossing the charge threshold on HP return starts charging after arrival',()=>{
  const s=scenario(),probe=simulate(s);
  const done=probe.events.find(e=>e.type==='TASK_COMPLETED'),arrived=probe.events.find(e=>e.type==='WAIT_ARRIVED');
  const atDone=probe.snapshots[done.sequence].agfs[0].batteryPct;
  const atHp=probe.snapshots[arrived.sequence].agfs[0].batteryPct;
  s.agfs[0].batteryPct=s.battery.chargeStartPct+(90-atDone)+(atDone-atHp)/2;
  const r=simulate(s),arrival=r.events.find(e=>e.type==='WAIT_ARRIVED');
  const charge=r.events.find(e=>e.type==='CHARGE_REQUESTED');
  assert.ok(charge);assert.equal(charge.timeMs,arrival.timeMs);
  assert.ok(r.snapshots[arrival.sequence].agfs[0].batteryPct<=s.battery.chargeStartPct);
  assert.ok(r.events.some(e=>e.type==='CHARGE_STARTED'));
});

test('initial idle AGF at the charge threshold charges even with no production events',()=>{
  const s=scenario();s.manualRequests=[];s.agfs[0].batteryPct=s.battery.chargeStartPct;
  s.agfs[0].currentNodeId='HP1';const r=simulate(s);
  assert.equal(r.events.find(e=>e.type==='CHARGE_REQUESTED')?.timeMs,0);
  assert.ok(r.events.some(e=>e.type==='CHARGE_STARTED'));
});

test('H31 HP return obeys shutter permission and resumes only after reopening',()=>{
  const s=scenario(),edge=s.operationalTopology.edges.find(e=>e.toNodeId==='HP1');
  edge.shutterId='SH-HP-TEST';
  s.operationalTopology.shutters.push({id:edge.shutterId,initiallyPassable:true,permissionSource:'synthetic-scenario'});
  s.shutterEvents=[{timeMs:0,shutterId:edge.shutterId,passable:false},{timeMs:30*60000,shutterId:edge.shutterId,passable:true}];
  const r=simulate(s),wait=r.events.find(e=>e.type==='SHUTTER_WAITING'&&e.edgeId===edge.id);
  assert.ok(wait);assert.equal(wait.shutterId,edge.shutterId);
  assert.ok(r.events.find(e=>e.type==='WAIT_ARRIVED').timeMs>=30*60000);
});

test('full or unreachable HP holds without a fallback, overlapping occupancy or idle status',()=>{
  for(const cause of ['full','unreachable']){
    const s=scenario();
    if(cause==='full')s.agfs[1].currentNodeId='HP1';
    else s.operationalTopology.edges=s.operationalTopology.edges.filter(e=>e.toNodeId!=='HP1'&&e.fromNodeId!=='HP1');
    const r=simulate(s);assert.equal(r.final.agfs[0].status,cause==='full'?'waiting_hp_capacity':'waiting_hp_route');
    assert.ok(!r.events.some(e=>e.type==='WAIT_ARRIVED'));
    if(cause==='full')assert.equal(r.final.waitingPlaces.HP1,'AGF2');
  }
});
