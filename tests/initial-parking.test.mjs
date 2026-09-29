import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario,initialAgfFromSettings} from '../src/ui/scenario.mjs';
import {integratedAcceptanceScenario} from '../examples/integrated-acceptance.mjs';
import {analyzeRun} from '../src/ui/replay-model.mjs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';

const places=['HP1','HP2','CHARGE-PLACE1','CHARGE-PLACE2'];
test('settings preserve configurable explicit parking instead of replacing it with WH-HOME',()=>{
  const s=createDemoScenario('extended');
  for(const position of places)assert.deepEqual(initialAgfFromSettings(s,s.agfs[0],{position,batteryPct:75}),
    {...s.agfs[0],area:'WH',currentNodeId:position,batteryPct:75});
  assert.throws(()=>initialAgfFromSettings(s,s.agfs[0],{position:'WH-HOME',batteryPct:75}),/initial parking/);
});
function quiet(){
  const s=integratedAcceptanceScenario();s.durationMin=5;
  s.productStreams.forEach(p=>p.enabled=false);s.manualRequests=[];s.magazineUses=[];
  return s;
}
test('extended initial positions are four distinct explicit sample stops, never internal home junctions',()=>{
  const s=createDemoScenario('extended');
  assert.deepEqual(s.agfs.map(a=>a.currentNodeId),places);
  assert.equal(s.initialParking.evidence,'synthetic-explicit-example');
  const positions=s.agfs.map(a=>projectAgfPosition(a,s.operationalTopology,0));
  assert.equal(new Set(positions.map(p=>[p.x,p.y].join(','))).size,4);
  assert.ok(s.operationalTopology.nodes.some(n=>n.id==='WH-HOME'));
  assert.ok(s.operationalTopology.nodes.some(n=>n.id==='PZ-HOME'));
});
test('initial charging-place parking occupies stops only and accounts no charging or travel time',()=>{
  const r=simulate(quiet()),initial=r.snapshots[0];
  assert.deepEqual(initial.waitingPlaces,{HP1:'AGF1',HP2:'AGF2'});
  assert.deepEqual(initial.chargePlaces,{'CHARGE-PLACE1':'AGF3','CHARGE-PLACE2':'AGF4'});
  assert.ok(r.snapshots.every(s=>Object.values(s.chargers).every(v=>v===null)));
  assert.ok(r.final.agfs.every(a=>a.status==='idle'&&a.chargerId===null));
  assert.ok(!r.events.some(e=>e.type==='CHARGE_REQUESTED'));
  for(const a of analyzeRun(r).agfs){assert.equal(a.durations.charging??0,0);assert.equal(a.workingMs,0);}
});
test('initial parking permits permutations but rejects duplicate, internal or already-charging starts',()=>{
  const s=quiet();s.agfs.forEach((a,i)=>a.currentNodeId=places[3-i]);
  assert.equal(simulate(s).snapshots[0].chargePlaces['CHARGE-PLACE2'],'AGF1');
  s.agfs[0].currentNodeId=s.agfs[1].currentNodeId;assert.throws(()=>simulate(s),/initial parking/);
  s.agfs.forEach((a,i)=>a.currentNodeId=places[i]);s.agfs[0].currentNodeId='WH-HOME';
  assert.throws(()=>simulate(s),/initial parking/);
  s.agfs[0].currentNodeId='HP1';s.agfs[2].status='charging';assert.throws(()=>simulate(s),/initial parking/);
});
test('an initial charging-place AGF can win ordinary dispatch and releases its stop on departure',()=>{
  const s=quiet();s.agfs[2].batteryPct=80;
  s.manualRequests=[{timeMs:0,kind:'04',palletId:'SIM-TEMP-1',locationId:'OT1',reentryPermission:true}];
  const r=simulate(s),assigned=r.events.find(e=>e.type==='TASK_ASSIGNED');
  assert.equal(assigned.agfId,'AGF3');
  assert.equal(r.snapshots[assigned.sequence].chargePlaces['CHARGE-PLACE1'],'AGF3');
  const departure=r.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId==='AGF3');
  assert.equal(r.snapshots[departure.sequence].chargePlaces['CHARGE-PLACE1'],null);
  assert.ok(!r.events.some(e=>e.type==='CHARGE_STARTED'));
});
test('actual charging claims a charger only at start, independently of charging-place numbering',()=>{
  const s=quiet();s.agfs[3].batteryPct=40;
  const r=simulate(s),start=r.events.find(e=>e.type==='CHARGE_STARTED');
  assert.equal(start.agfId,'AGF4');assert.equal(start.chargerId,'CHARGER1');
  assert.equal(r.snapshots[start.sequence].agfs[3].currentNodeId,'CHARGE-PLACE2');
  assert.ok(r.snapshots.slice(0,start.sequence).every(s=>Object.values(s.chargers).every(v=>v===null)));
  assert.equal(r.snapshots[start.sequence].chargePlaces['CHARGE-PLACE1'],'AGF3');
  assert.ok(analyzeRun(r).agfs[3].durations.charging>0);
});
test('outgoing shutter wait retains initial stop occupancy until segment entry',()=>{
  const s=quiet();s.agfs[2].batteryPct=80;
  s.manualRequests=[{timeMs:0,kind:'04',palletId:'SIM-TEMP-1',locationId:'OT1',reentryPermission:true}];
  const edge=s.operationalTopology.edges.find(e=>e.toNodeId==='CHARGE-PLACE1');
  edge.shutterId='PARKING-TEST-GATE';
  s.operationalTopology.shutters.push({id:edge.shutterId,initiallyPassable:false,permissionSource:'synthetic-scenario'});
  s.shutterEvents=[{timeMs:120000,shutterId:edge.shutterId,passable:true}];
  const r=simulate(s),departure=r.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId==='AGF3');
  assert.equal(departure.timeMs,120000);
  r.snapshots.forEach((snapshot,i)=>{if(r.events[i].timeMs<departure.timeMs)assert.equal(snapshot.chargePlaces['CHARGE-PLACE1'],'AGF3');});
  assert.equal(r.snapshots[departure.sequence].chargePlaces['CHARGE-PLACE1'],null);
});
test('occupied charging stops block arrival until departure, without overbooking or changing HP fallback',()=>{
  const s=quiet();s.durationMin=20;s.agfs.forEach(a=>a.batteryPct=40);s.battery.chargeMinPerPct=.01;
  const r=simulate(s);
  assert.equal(r.events.filter(e=>e.type==='CHARGE_STARTED').length,4);
  for(const snap of r.snapshots){
    const occupants=Object.values(snap.chargePlaces).filter(Boolean);
    assert.equal(new Set(occupants).size,occupants.length);
    const charging=snap.agfs.filter(a=>a.status==='charging');assert.ok(charging.length<=2);
    for(const a of charging){assert.equal(snap.chargePlaces[a.currentNodeId],a.id);assert.equal(snap.chargers[a.chargerId],a.id);}
  }
  assert.ok(r.events.some(e=>e.type==='SEGMENT_WAITING'&&e.reason==='CHARGE_PLACE_OCCUPIED'));
  assert.ok(analyzeRun(r).agfs.some(a=>a.durations.waiting_charge>0));
  assert.ok(r.events.filter(e=>e.type==='WAIT_RETURN_REQUESTED').every(e=>['HP1','HP2'].includes(e.hpId)));
  assert.ok(r.final.agfs.filter(a=>a.status==='waiting_hp_capacity').length>0);
  assert.deepEqual(simulate(s).events,r.events);
});
