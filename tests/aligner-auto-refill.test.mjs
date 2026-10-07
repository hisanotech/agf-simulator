import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario,createLegacyScenario} from '../src/ui/scenario.mjs';
import {buildRunConditions,renderRunConditions} from '../src/ui/run-conditions.mjs';
import {conditionCsv} from '../src/ui/export.mjs';
import {renderSupplySettings} from '../src/ui/extended-settings.mjs';

// Explicit synthetic fixture. Travel times and instant reloading are model
// assumptions; this does not describe an observed facility operation.
const fixture=(overrides={})=>({
  durationMin:12,mode:'area_first',fallback:'any',lineCapacity:100,
  productionModel:'legacy_external_pallets',lineIntervalsMin:Array(8).fill(0),generatedDestinationIds:['S1'],
  alignerRefillPolicy:'all_empty_auto',wrapper:{inputCapacity:1,outputCapacity:2},
  agfs:['A1','A2','A3','A4'].map(id=>({id,area:'PZ',batteryPct:100})),chargerIds:['C1','C2'],
  battery:{reservePct:40,chargeStartPct:40,chargeTargetPct:80,consumptionPct:0,chargeMinPerPct:2.4},
  times:{emptyMin:1,loadedMin:1,pickupMin:0,dropoffMin:0,wrapMin:1,labelMin:0,exitMin:0,chargeTravelMin:1},
  warehouse:[{id:'S1',rowId:'R1',capacity:100,permission:true}],
  magazines:Array.from({length:5},(_,i)=>({id:'M'+(i+1),quantity:4,capacity:20,trigger:3,refillBatch:10,permission:true})),
  aligners:Array.from({length:5},(_,i)=>({id:'AL'+(i+1),quantity:10})),
  magazineUses:Array.from({length:5},(_,i)=>({timeMs:0,magazineId:'M'+(i+1)})),
  ...overrides
});
const of=(run,type)=>run.events.filter(e=>e.type===type);
const autoOperations=run=>of(run,'ALIGNER_REFILL_OPERATED').filter(e=>e.automatic===true);

test('automatic all-empty policy keeps four empty aligners empty until the last actual pickup',()=>{
  const run=simulate(fixture({durationMin:1.5}));
  assert.equal(of(run,'ALIGNER_STACK_PICKED').length,4);
  assert.deepEqual(Object.values(run.final.aligners).map(a=>a.quantity),[0,0,0,0,10]);
  assert.equal(autoOperations(run).length,0);
  assert.equal(run.final.aligners.AL5.reservedTaskId,run.final.tasks.find(t=>t.alignerId==='AL5').id);
});

test('last actual pickup triggers one deterministic all-five refill at the same timestamp',()=>{
  const scenario=fixture(),before=structuredClone(scenario),run=simulate(scenario);
  const picks=of(run,'ALIGNER_STACK_PICKED'),last=picks.at(-1),operation=autoOperations(run)[0];
  assert.equal(picks.length,5);assert.equal(autoOperations(run).length,1);
  assert.ok(operation);assert.equal(operation.operationType,'all');assert.equal(operation.policy,'all_empty_auto');
  assert.equal(operation.trigger,'all_empty');assert.equal(operation.timeMs,last.timeMs);
  assert.ok(operation.sequence>last.sequence);
  assert.ok(Object.values(run.snapshots[last.sequence].aligners).every(a=>a.quantity===0&&!a.reservedTaskId));
  const refills=of(run,'ALIGNER_REFILLED');assert.equal(refills.length,5);
  assert.deepEqual(refills.map(e=>e.alignerId),['AL1','AL2','AL3','AL4','AL5']);
  assert.ok(refills.every(e=>e.automatic===true&&e.operationType==='all'&&e.quantityBefore===0&&e.quantityAfter===10&&e.timeMs===last.timeMs));
  assert.deepEqual(Object.values(run.final.aligners).map(a=>a.quantity),Array(5).fill(10));
  assert.deepEqual(scenario,before);assert.deepEqual(run.events,simulate(scenario).events);
});

test('automatic fill reevaluates existing refill-needed state and preserves magazine drop causality',()=>{
  const scenario=fixture();
  scenario.magazineUses.push(...Array.from({length:10},(_,i)=>({timeMs:130000+i*1000,magazineId:'M1'})));
  const run=simulate(scenario),operation=autoOperations(run)[0],requests=of(run,'TASK_REQUESTED').filter(e=>e.kind==='03');
  assert.equal(requests.length,6);assert.equal(autoOperations(run).length,1);
  const resumed=requests.at(-1),task=run.final.tasks.find(t=>t.id===resumed.taskId);
  assert.equal(resumed.timeMs,operation.timeMs);
  assert.ok(resumed.sequence>of(run,'ALIGNER_REFILLED').at(-1).sequence);
  assert.equal(task.alignerId,'AL1');
  assert.equal(run.snapshots[resumed.sequence].aligners.AL1.reservedTaskId,task.id);
  const finalDrop=of(run,'MAGAZINE_REFILLED').filter(e=>e.magazineId==='M1').at(-1);
  assert.equal(finalDrop.quantityBefore,3);assert.equal(finalDrop.quantityAfter,13);
  assert.ok(finalDrop.timeMs>operation.timeMs);assert.equal(run.final.aligners.AL1.quantity,0);
});

test('each later all-five exhaustion reloads exactly once and conserves inventory through both cycles',()=>{
  const scenario=fixture();
  scenario.magazineUses.push(...Array.from({length:5},(_,i)=>Array.from({length:10},(_,j)=>
    ({timeMs:300000+j*1000,magazineId:'M'+(i+1)}))).flat());
  const run=simulate(scenario);
  assert.equal(of(run,'ALIGNER_STACK_PICKED').length,10);assert.equal(autoOperations(run).length,2);
  assert.equal(of(run,'ALIGNER_REFILLED').length,10);
  for(const operation of autoOperations(run)){
    assert.ok(Object.values(run.snapshots[operation.sequence].aligners).every(a=>a.quantity===0&&!a.reservedTaskId));
    assert.equal(of(run,'ALIGNER_REFILLED').filter(e=>e.timeMs===operation.timeMs).length,5);
  }
  for(const initial of scenario.aligners){
    const picked=of(run,'ALIGNER_STACK_PICKED').filter(e=>e.alignerId===initial.id).length;
    const added=of(run,'ALIGNER_REFILLED').filter(e=>e.alignerId===initial.id).reduce((n,e)=>n+e.quantityAfter-e.quantityBefore,0);
    assert.equal(run.final.aligners[initial.id].quantity,initial.quantity-10*picked+added);
  }
  assert.ok(Object.values(run.final.aligners).every(a=>a.quantity===10));
  assert.deepEqual(run.events,simulate(scenario).events);
});

test('coupled production uses automatic stocks only after actual pickup empties the fifth aligner',()=>{
  const run=simulate(fixture({productionModel:'empty_pallet_supply',magazineUses:[],magazineEmptyRecoveryPolicy:null,
    lineMagazineMap:Object.fromEntries(Array.from({length:8},(_,i)=>['L'+(i+1),'M'+(i<5?i+1:1)])),
    productionEvents:Array.from({length:5},(_,i)=>({timeMs:0,palletId:'SYNTHETIC-P'+(i+1),lineId:'L'+(i+1),destinationLocationId:'S1'}))}));
  assert.equal(of(run,'EMPTY_PALLET_DISCHARGED').length,5);assert.equal(of(run,'PALLET_EXITED').length,5);
  assert.equal(of(run,'ALIGNER_STACK_PICKED').length,5);assert.equal(autoOperations(run).length,1);
  const lastPickup=of(run,'ALIGNER_STACK_PICKED').at(-1),operation=autoOperations(run)[0];
  assert.equal(operation.timeMs,lastPickup.timeMs);assert.ok(operation.sequence>lastPickup.sequence);
  assert.ok(Object.values(run.final.aligners).every(a=>a.quantity===10));
});

test('all-empty policy fills an explicitly empty initial state once without a timer loop or double loading',()=>{
  const run=simulate(fixture({aligners:Array.from({length:5},(_,i)=>({id:'AL'+(i+1),quantity:0})),magazineUses:[],
    alignerRefillEvents:[{timeMs:0,alignerId:null,operationType:'all'},{timeMs:60000,alignerId:'AL1',operationType:'individual'}]}));
  assert.equal(run.snapshots[0].aligners.AL1.quantity,0);
  assert.equal(autoOperations(run).length,1);assert.equal(autoOperations(run)[0].timeMs,0);
  assert.equal(of(run,'ALIGNER_REFILLED').length,5);
  assert.equal(of(run,'ALIGNER_REFILL_OPERATED').length,3);
  assert.ok(Object.values(run.final.aligners).every(a=>a.quantity===10));
});

test('automatic loading does not override aligner permission or permit duplicate reservation',()=>{
  const aligners=Array.from({length:5},(_,i)=>({id:'AL'+(i+1),quantity:0,permission:false}));
  const run=simulate(fixture({aligners,permissionEvents:[{timeMs:60000,target:'aligner',targetId:'AL2',permitted:true}]}));
  assert.equal(autoOperations(run).length,1);
  const requested=of(run,'TASK_REQUESTED').filter(e=>e.kind==='03');assert.equal(requested.length,1);
  assert.equal(requested[0].timeMs,60000);
  assert.equal(run.final.tasks.find(t=>t.id===requested[0].taskId).alignerId,'AL2');
  assert.equal(of(run,'ALIGNER_STACK_PICKED').length,1);
  for(const snapshot of run.snapshots){
    const reservations=Object.values(snapshot.aligners).map(a=>a.reservedTaskId).filter(Boolean);
    assert.equal(new Set(reservations).size,reservations.length);
    assert.ok(Object.values(snapshot.aligners).every(a=>[0,10].includes(a.quantity)));
  }
});

test('omitted and explicit manual policies preserve legacy empty-supply behavior',()=>{
  for(const policy of [undefined,'manual']){
    const run=simulate(fixture({alignerRefillPolicy:policy,aligners:Array.from({length:5},(_,i)=>({id:'AL'+(i+1),quantity:0}))}));
    assert.equal(autoOperations(run).length,0);assert.equal(of(run,'ALIGNER_REFILLED').length,0);
    assert.equal(of(run,'TASK_REQUESTED').filter(e=>e.kind==='03').length,0);
    assert.ok(Object.values(run.final.aligners).every(a=>a.quantity===0));
  }
});

test('unknown automatic policies and incomplete all-five configuration fail closed',()=>{
  for(const policy of ['automatic','all_empty',false])assert.throws(()=>simulate(fixture({alignerRefillPolicy:policy})),/alignerRefillPolicy/);
  assert.throws(()=>simulate(fixture({aligners:[{id:'AL1',quantity:0}]})),/five|5|alignerRefillPolicy/);
});

test('ordinary presets and their saved conditions visibly preserve confirmed all-empty automatic policy',()=>{
  for(const preset of ['standard','extended']){
    const scenario=createDemoScenario(preset),run={scenario},rows=buildRunConditions(run);
    assert.equal(scenario.alignerRefillPolicy,'all_empty_auto');
    assert.equal(scenario.evidence.alignerRefillPolicy,'user-confirmed-all-empty-auto');
    const policy=rows.find(r=>r.category==='ALIGNER'&&r.key==='settings'&&r.subkey==='alignerRefillPolicy');
    assert.equal(policy.value,'all_empty_auto');assert.equal(policy.evidence,'user-confirmed-all-empty-auto');
    assert.match(conditionCsv(run),/ALIGNER,settings,alignerRefillPolicy,all_empty_auto,user-confirmed-all-empty-auto/);
    assert.match(renderRunConditions(run),/全5台が0枚になった時に全機10枚へ自動装填/);
    assert.match(renderSupplySettings(scenario),/全5台が0枚/);
    assert.match(renderSupplySettings(scenario),/実測.*時間|所要時間.*未確定/);
  }
  const legacy=createLegacyScenario('manual');assert.notEqual(legacy.alignerRefillPolicy,'all_empty_auto');
  const rows=buildRunConditions({scenario:legacy});
  assert.equal(rows.find(r=>r.category==='ALIGNER'&&r.subkey==='alignerRefillPolicy').value,'manual');
});
