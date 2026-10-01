import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {integratedAcceptanceScenario} from '../examples/integrated-acceptance.mjs';
import {WAREHOUSE_SERVICE} from '../src/map/warehouse-layout.mjs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';

const waits=['HP1','HP2','PILLAR-WAIT-W','PILLAR-WAIT-E'];
function scenario(){
  const s=integratedAcceptanceScenario();s.durationMin=10;
  s.productStreams.forEach(p=>p.enabled=false);s.manualRequests=[];s.magazineUses=[];
  return s;
}
test('four normal warehouse waiting places are distinct from charging places and have no fixed site assignment',()=>{
  assert.deepEqual(WAREHOUSE_SERVICE.waitingPlaces.map(p=>p.id),waits);
  assert.ok(WAREHOUSE_SERVICE.waitingPlaces.every(p=>p.stopNodeId===null));
  const s=scenario();assert.deepEqual(Object.values(s.postTaskPolicy.waitTargets),waits);
  assert.equal(s.postTaskPolicy.evidence,'synthetic-explicit-example');
});
test('all four return destinations must be explicit, exclusive and reachable before execution',()=>{
  for(const fault of ['missing','partial','duplicate','unreachable','charging','pz']){
    const s=scenario();
    if(fault==='missing')s.postTaskPolicy.waitTargets={};
    if(fault==='partial')delete s.postTaskPolicy.waitTargets.AGF4;
    if(fault==='duplicate')s.postTaskPolicy.waitTargets.AGF4=s.postTaskPolicy.waitTargets.AGF1;
    if(fault==='unreachable')s.operationalTopology.edges=s.operationalTopology.edges.filter(e=>e.toNodeId!=='HP1'&&e.fromNodeId!=='HP1');
    if(fault==='charging')s.postTaskPolicy.waitTargets.AGF4='CHARGE-PLACE2';
    if(fault==='pz')s.postTaskPolicy.waitTargets.AGF4='PZ-HOME';
    assert.throws(()=>simulate(s),/waiting|return target/,fault);
  }
});
for(const [agfId,target] of [['AGF3','PILLAR-WAIT-W'],['AGF4','PILLAR-WAIT-E']]){
  test(`${agfId} returns from PZ to explicit ${target} through the normal exit and east gate`,()=>{
    const s=scenario();s.agfs.forEach(a=>a.blocked=a.id!==agfId);
    s.manualRequests=[{timeMs:0,kind:'04',palletId:'SIM-TEMP-1',locationId:'OT1',reentryPermission:true}];
    const r=simulate(s),done=r.events.find(e=>e.type==='TASK_COMPLETED'&&e.kind==='04');
    const route=r.events.slice(done.sequence).find(e=>e.type==='ROUTE_PLANNED'&&e.movement==='wait');
    assert.ok(route.edgeIds.includes('E09')&&route.edgeIds.includes('E10'));
    const arrived=r.events.find(e=>e.type==='WAIT_ARRIVED'&&e.agfId===agfId);
    assert.equal(arrived.hpId,target);const a=r.snapshots[arrived.sequence].agfs.find(a=>a.id===agfId);
    assert.equal(a.currentNodeId,target);assert.equal(a.status,'idle');assert.equal(r.snapshots[arrived.sequence].waitingPlaces[target],agfId);
    const segment=r.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId===agfId&&e.movement==='wait');
    assert.equal(projectAgfPosition(r.snapshots[segment.sequence].agfs.find(a=>a.id===agfId),s.operationalTopology,segment.timeMs+segment.modelDurationMs/2).progress,.5);
    assert.ok(!r.events.some(e=>e.type==='WAIT_RETURN_HELD'&&e.reason==='HP_TARGET_UNRESOLVED'));
  });
}
test('west pillar return waits for fire shutter permission, then resumes to the configured place',()=>{
  const s=scenario();s.agfs.forEach(a=>a.blocked=a.id!=='AGF3');
  s.manualRequests=[{timeMs:0,kind:'04',palletId:'SIM-TEMP-1',locationId:'OT1',reentryPermission:true}];
  s.shutterEvents=[{timeMs:0,shutterId:'SH-FIRE-NORTH',passable:false},{timeMs:300000,shutterId:'SH-FIRE-NORTH',passable:true}];
  const r=simulate(s);assert.ok(r.events.some(e=>e.type==='SHUTTER_WAITING'&&e.shutterId==='SH-FIRE-NORTH'));
  assert.ok(r.events.find(e=>e.type==='WAIT_ARRIVED'&&e.agfId==='AGF3').timeMs>=300000);
});
test('four completed charges return to four explicit waiting places without remaining parked on chargers',()=>{
  const s=scenario();s.agfs.forEach(a=>a.batteryPct=40);s.battery.chargeTargetPct=100;s.battery.chargeMinPerPct=.01;
  const r=simulate(s);assert.equal(r.metrics.chargingStarts,4);
  assert.deepEqual(Object.keys(r.final.waitingPlaces).filter(id=>r.final.waitingPlaces[id]),waits);
  assert.ok(r.final.agfs.every(a=>a.status==='idle'&&a.chargerId===null&&waits.includes(a.currentNodeId)));
  assert.ok(Object.values(r.final.chargePlaces).every(v=>v===null));
  assert.ok(Object.values(r.final.chargers).every(v=>v===null));
  assert.deepEqual(simulate(s).events,r.events);
});
