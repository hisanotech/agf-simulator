import test from 'node:test';
import assert from 'node:assert/strict';
import {integratedAcceptanceScenario} from '../examples/integrated-acceptance.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {analyzeRun,durationTenths} from '../src/ui/replay-model.mjs';
import {generateProductionEvents} from '../src/core/production-streams.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';

function invariant(run){
  const analysis=analyzeRun(run);
  for(const a of analysis.agfs){
    assert.equal(Object.values(a.durations).reduce((s,n)=>s+n,0),10800000);
    assert.equal(Object.values(durationTenths(a.durations)).reduce((s,n)=>s+n,0),1800);
  }
  assert.ok(run.snapshots.every(s=>Object.values(s.chargers).filter(Boolean).length<=2));
  return analysis;
}
test('mixed-product acceptance preserves all eight theoretical discharge times without additive production',()=>{
  const defaults=createDemoScenario('extended'),lineIds=Array.from({length:8},(_,i)=>'L'+(i+1));
  const expected=generateProductionEvents(defaults.productStreams,180*60000,lineIds).map(p=>[p.timeMs,p.sourceLineId]);
  for(const kind of ['normal','recovery']){
    const s=integratedAcceptanceScenario(kind);
    assert.deepEqual(s.productionEvents.map(p=>[p.timeMs,p.sourceLineId]),expected);
    assert.equal(new Set(s.productionEvents.map(p=>p.productType+'/'+p.loadType)).size,4);
  }
});
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
test('explicit synthetic wrapper admission keeps outflow possible during a 30-minute shutter outage',()=>{
  const s=integratedAcceptanceScenario('recovery'),r=simulate(s);
  for(const snap of r.snapshots){
    assert.ok(snap.wrapper.input.length<=s.wrapper.inputCapacity);
    assert.ok(snap.wrapper.output.length<=s.wrapper.outputCapacity);
    assert.ok(snap.wrapper.reservedInboundTaskIds.length<=s.wrapper.inboundAgfLimit);
    for(const id of snap.wrapper.reservedInboundTaskIds){
      const t=snap.tasks.find(t=>t.id===id);assert.ok(['01','04'].includes(t.kind)&&t.status!=='completed');
    }
    assert.ok(snap.agfs.filter(a=>snap.tasks.find(t=>t.id===a.taskId)?.status==='wait_drop'&&
      snap.tasks.find(t=>t.id===a.taskId)?.destinationId==='WRAP-INPUT').length<4);
  }
  assert.ok(r.events.some(e=>e.type==='TASK_WAITING'&&e.reason==='WRAPPER_INBOUND_LIMIT'));
  assert.ok(r.final.tasks.some(t=>t.kind==='02'&&t.completedAt>55*60000));
  assert.ok(r.final.tasks.filter(t=>t.kind==='05').every(t=>t.status==='completed'));
});
test('four initial low-battery AGFs retain two-port exclusion and partial charging at the three-hour horizon',()=>{
  const r=simulate(integratedAcceptanceScenario('charging-boundary'));invariant(r);
  assert.equal(r.metrics.chargingStarts,4);
  assert.ok(r.events.some(e=>e.type==='CHARGE_WAITING'));
  assert.equal(r.final.agfs.filter(a=>a.status==='charging').length,2);
  assert.equal(r.events.filter(e=>e.type==='CHARGER_RELEASED').length,2);
  assert.ok(r.final.agfs.filter(a=>a.status==='charging').every(a=>a.batteryPct>40&&a.batteryPct<100));
});
