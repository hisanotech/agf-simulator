import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {defaultProductStreams,generateProductionEvents} from '../src/core/production-streams.mjs';
import {integratedAcceptanceScenario} from '../examples/integrated-acceptance.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {analyzeRun} from '../src/ui/replay-model.mjs';

const intervals=[17.2,36.5,36.5,22.9,25.3,21.5,36.5,36.5];
const initial=['CHARGE-PLACE1','CHARGE-PLACE2','HP1','HP2'];
const lineIds=intervals.map((_,i)=>'L'+(i+1));
for(const [i,value] of intervals.entries())test(`theoretical discharge default L${i+1} is ${value} min/PL in both ordinary and extended runs`,()=>{
  assert.equal(createDemoScenario('standard').lineIntervalsMin[i],value);
  const streams=createDemoScenario('extended').productStreams.filter(s=>s.sourceLineId===lineIds[i]);
  assert.equal(streams.length,4);assert.ok(streams.every(s=>s.intervalMin===value));
});
test('only ordinary full pallets are enabled by default; theoretical intervals are not PLC history',()=>{
  for(const streams of [defaultProductStreams(),createDemoScenario('extended').productStreams]){
    assert.equal(streams.filter(s=>s.enabled).length,8);
    assert.ok(streams.every(s=>s.enabled===(s.productType==='normal'&&s.loadType==='full')));
  }
  for(const preset of ['standard','extended'])assert.equal(createDemoScenario(preset).evidence.production,'theoretical-pallet-discharge-100pct');
  assert.deepEqual(defaultProductStreams().filter(s=>s.enabled).map(s=>s.intervalMin),intervals);
});
test('explicit interval edits take precedence and produce deterministic integer-millisecond production',()=>{
  const streams=defaultProductStreams();streams[0].intervalMin=9.25;streams[0].startOffsetMin=2;
  const a=generateProductionEvents(streams,180*60000,lineIds),b=generateProductionEvents(streams,180*60000,lineIds);
  assert.deepEqual(a,b);assert.ok(a.every(e=>Number.isInteger(e.timeMs)));
  const l1=a.filter(e=>e.sourceLineId==='L1');
  assert.equal(l1[0].timeMs,11.25*60000);assert.equal(l1[1].timeMs-l1[0].timeMs,9.25*60000);
  assert.equal(l1[0].inputKind,'synthetic-product-interval');
});
function quiet(){
  const s=integratedAcceptanceScenario();s.durationMin=10;s.productStreams.forEach(p=>p.enabled=false);
  s.productionEvents=[];s.manualRequests=[];s.magazineUses=[];return s;
}
for(const [i,id] of initial.entries())test(`AGF${i+1} defaults to ${id} as an idle stop, independent of chargers`,()=>{
  assert.equal(createDemoScenario('extended').agfs[i].currentNodeId,id);
  const r=simulate(quiet()),a=r.snapshots[0].agfs[i];
  assert.equal(a.currentNodeId,id);assert.equal(a.status,'idle');assert.equal(a.chargerId,null);
  assert.equal((r.snapshots[0].waitingPlaces??r.snapshots[0].chargePlaces)[id]??r.snapshots[0].chargePlaces[id],a.id);
});
test('four initial stops are distinct and consume no charger capacity or charge time',()=>{
  const r=simulate(quiet()),first=r.snapshots[0];
  assert.equal(new Set(first.agfs.map(a=>a.currentNodeId)).size,4);
  assert.deepEqual(first.chargePlaces,{'CHARGE-PLACE1':'AGF1','CHARGE-PLACE2':'AGF2'});
  assert.equal(first.waitingPlaces.HP1,'AGF3');assert.equal(first.waitingPlaces.HP2,'AGF4');
  assert.ok(Object.values(first.chargers).every(x=>x===null));
  assert.equal(r.metrics.chargingStarts,0);assert.equal(analyzeRun(r).chargeMs,0);
});
for(const [i,id] of initial.entries())test(`AGF${i+1} can leave initial ${id} for its first ordinary empty route and release only its stop`,()=>{
  const s=quiet();s.agfs[i].batteryPct=80;
  s.manualRequests=[{timeMs:0,kind:'04',palletId:'SIM-TEMP-1',locationId:'OT1',reentryPermission:true}];
  const r=simulate(s),assigned=r.events.find(e=>e.type==='TASK_ASSIGNED');
  assert.equal(assigned.agfId,'AGF'+(i+1));
  const entered=r.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId===assigned.agfId);
  assert.equal(entered.fromNodeId,id);assert.equal(entered.movement,'empty');
  const snap=r.snapshots[entered.sequence];
  assert.equal((id.startsWith('HP')?snap.waitingPlaces:snap.chargePlaces)[id],null);
  assert.ok(!r.events.some(e=>e.type==='CHARGER_RELEASED'||e.type==='CHARGE_STARTED'));
});
test('low initial battery triggers charging conditions, without fixing a stop to an electrical device',()=>{
  const s=quiet();s.agfs[1].batteryPct=s.battery.chargeStartPct;
  const r=simulate(s),start=r.events.find(e=>e.type==='CHARGE_STARTED');
  assert.equal(start.agfId,'AGF2');assert.equal(start.chargePlaceId,'CHARGE-PLACE2');
  assert.equal(start.chargerId,'CHARGER1');assert.equal(start.timeMs,0);
  const high=quiet();high.agfs[1].batteryPct=high.battery.chargeStartPct+.000001;
  assert.equal(simulate(high).metrics.chargingStarts,0);
});
