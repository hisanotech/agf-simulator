import test from 'node:test';
import assert from 'node:assert/strict';
import {integratedAcceptanceScenario} from '../examples/integrated-acceptance.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {analyzeRun,durationTenths} from '../src/ui/replay-model.mjs';

function invariant(run){
  const analysis=analyzeRun(run);
  for(const a of analysis.agfs){
    assert.equal(Object.values(a.durations).reduce((s,n)=>s+n,0),10800000);
    assert.equal(Object.values(durationTenths(a.durations)).reduce((s,n)=>s+n,0),1800);
  }
  assert.ok(run.snapshots.every(s=>Object.values(s.chargers).filter(Boolean).length<=2));
  return analysis;
}
test('three-hour extended model retains all task kinds, four product variants and identical comparison input',()=>{
  const s=integratedAcceptanceScenario(),a=simulate(s),b=simulate({...s,mode:'low_battery_first'});
  invariant(a);invariant(b);
  assert.deepEqual(a.events,simulate(s).events);
  for(const kind of ['01','02','03','04','05'])assert.ok(a.metrics.byKind[kind]>0);
  const source=r=>r.events.filter(e=>e.type==='PALLET_EXITED').map(e=>[e.timeMs,e.palletId,e.sourceLineId,e.productType,e.loadType]);
  assert.deepEqual(source(a),source(b));
  assert.equal(new Set(source(a).map(e=>e.slice(3).join('/'))).size,4);
  for(const t of a.final.tasks.filter(t=>['02','05'].includes(t.kind)&&t.status==='completed')){
    assert.equal(t.storageResult,'stored');assert.ok(t.sourceLineId&&t.blockId&&t.row&&t.column&&t.tier);
  }
});
test('three-hour extended model recovers from synthetic storage permission and shutter loss',()=>{
  const r=simulate(integratedAcceptanceScenario('recovery')),a=invariant(r);
  assert.ok(a.dropWaitMs>0&&a.trafficWaitMs>0);
  assert.ok(r.events.some(e=>e.type==='SHUTTER_WAITING'));
  assert.ok(r.events.some(e=>e.type==='TASK_WAITING'&&e.reason==='LOCATION_PERMISSION'));
  assert.ok(r.final.tasks.filter(t=>t.kind==='05').every(t=>t.status==='completed'&&t.waitReason===null));
});
test('four initial low-battery AGFs retain two-port exclusion and partial charging at the three-hour horizon',()=>{
  const r=simulate(integratedAcceptanceScenario('charging-boundary'));invariant(r);
  assert.equal(r.metrics.chargingStarts,4);
  assert.ok(r.events.some(e=>e.type==='CHARGE_WAITING'));
  assert.equal(r.final.agfs.filter(a=>a.status==='charging').length,2);
  assert.equal(r.events.filter(e=>e.type==='CHARGER_RELEASED').length,2);
  assert.ok(r.final.agfs.filter(a=>a.status==='charging').every(a=>a.batteryPct>40&&a.batteryPct<100));
});
