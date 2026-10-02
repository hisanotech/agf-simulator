import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {integratedAcceptanceScenario} from '../examples/integrated-acceptance.mjs';

const priority=['HP1','HP2','PILLAR-WAIT-E','PILLAR-WAIT-W'];
function scenario(){
  const s=integratedAcceptanceScenario();delete s.initialParking;s.durationMin=20;
  s.postTaskPolicy={evidence:'user-confirmed-shared-priority',waitingPriority:[...priority]};
  s.productStreams.forEach(p=>p.enabled=false);s.productionEvents=[];s.manualRequests=[];s.magazineUses=[];
  // Only the vehicle under test occupies the PZ departure. Other vehicles have
  // independent branch stops; occupied-priority cases below set their own HPs.
  const starts=['PZ-HOME','CHARGE-PLACE1','CHARGE-PLACE2','PILLAR-WAIT-W'];
  s.agfs.forEach((a,i)=>{a.currentNodeId=starts[i];a.area=i===0?'PZ':'WH';a.status='idle';a.blocked=i!==0;});
  s.manualRequests=[{timeMs:0,kind:'04',palletId:'SIM-TEMP-1',locationId:'OT1',reentryPermission:true}];
  return s;
}
for(let occupied=0;occupied<4;occupied++)test(`shared return priority skips ${occupied} occupied stops and reserves ${priority[occupied]}`,()=>{
  const s=scenario();for(let i=0;i<occupied;i++){s.agfs[i+1].currentNodeId=priority[i];s.agfs[i+1].area='WH';}
  const r=simulate(s),request=r.events.find(e=>e.type==='WAIT_RETURN_REQUESTED'&&e.agfId==='AGF1');
  assert.equal(request.hpId,priority[occupied]);
  const snap=r.snapshots[request.sequence];
  assert.equal(snap.waitingReservations[request.hpId],'AGF1');assert.equal(snap.waitingPlaces[request.hpId],null);
  const arrived=r.events.find(e=>e.type==='WAIT_ARRIVED'&&e.agfId==='AGF1');
  assert.equal(r.snapshots[arrived.sequence].waitingReservations[request.hpId],null);
  assert.equal(r.snapshots[arrived.sequence].waitingPlaces[request.hpId],'AGF1');
  assert.ok(!r.events.some(e=>e.type==='WAIT_RETURN_REQUESTED'&&e.hpId.startsWith('CHARGE')));
});
test('all AGF IDs share the same return candidates without requiring fixed waitTargets',()=>{
  for(const agfId of ['AGF1','AGF2','AGF3','AGF4']){
    const s=scenario();s.agfs.forEach(a=>a.blocked=a.id!==agfId);
    const r=simulate(s),request=r.events.find(e=>e.type==='WAIT_RETURN_REQUESTED');
    assert.equal(request.agfId,agfId);assert.equal(request.hpId,'HP1');
    assert.deepEqual(request.waitingPriority,priority);
  }
});
test('overlapping return trips reserve different places before either arrives',()=>{
  const s=scenario();s.agfs[0].status='dispatch_pending';s.agfs[1].status='dispatch_pending';
  s.agfs[1].blocked=false;s.manualRequests=[];
  s.shutterEvents=[{timeMs:1,shutterId:'SH-EAST',passable:true}];
  const r=simulate(s),returns=r.events.filter(e=>e.type==='WAIT_RETURN_REQUESTED');
  assert.deepEqual(returns.map(e=>e.hpId),['HP1','HP2']);assert.equal(returns[0].timeMs,returns[1].timeMs);
  assert.ok(returns[1].sequence<r.events.find(e=>e.type==='WAIT_ARRIVED').sequence);
  for(const snap of r.snapshots){
    const owners=[...Object.values(snap.waitingPlaces),...Object.values(snap.waitingReservations)].filter(Boolean);
    assert.equal(owners.length,new Set(owners).size);
    for(const id of priority)assert.ok(!(snap.waitingPlaces[id]&&snap.waitingReservations[id]));
  }
});
test('freeing HP does not reorder another AGF already waiting at a pillar',()=>{
  const s=scenario();s.agfs[0].currentNodeId='HP1';s.agfs[0].area='WH';
  s.agfs[1].currentNodeId='PILLAR-WAIT-E';s.agfs[1].area='WH';s.agfs[1].blocked=false;
  s.agfs[1].batteryPct=100;s.agfs[0].batteryPct=80;
  const r=simulate(s),departed=r.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId==='AGF1');
  assert.equal(r.snapshots[departed.sequence].waitingPlaces.HP1,null);
  assert.ok(r.snapshots.every(s=>s.agfs[1].currentNodeId==='PILLAR-WAIT-E'&&s.agfs[1].status==='idle'));
  assert.ok(!r.events.some(e=>e.agfId==='AGF2'&&e.type==='WAIT_RETURN_REQUESTED'));
});
test('normal returns never use PZ or charging places and are deterministic',()=>{
  const s=scenario();const r=simulate(s);assert.deepEqual(simulate(s).events,r.events);
  const arrived=r.events.find(e=>e.type==='WAIT_ARRIVED');assert.ok(arrived);
  assert.equal(r.final.agfs[0].status,'idle');assert.ok(priority.includes(r.final.agfs[0].currentNodeId));
  const done=r.events.find(e=>e.type==='TASK_COMPLETED'&&e.kind==='04');
  assert.ok(r.snapshots.slice(done.sequence,arrived.sequence).every(s=>s.agfs[0].status!=='idle'));
});
