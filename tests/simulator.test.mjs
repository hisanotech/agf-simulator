import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/core/simulate.mjs';

const fixture = (overrides={}) => ({
  durationMin:30,mode:'area_first',fallback:'any',lineCapacity:2,
  lineIntervalsMin:[0,0,0,0,0,0,0,0],
  generatedDestinationIds:['S1'],wrapper:{inputCapacity:1,outputCapacity:2},
  agfs:['A1','A2','A3','A4'].map((id,i)=>({id,area:i<2?'PZ':'WH',batteryPct:100})),
  chargerIds:['C1','C2'],
  battery:{reservePct:40,chargeStartPct:40,chargeTargetPct:80,consumptionPct:1.5,chargeMinPerPct:2.4},
  times:{emptyMin:1,loadedMin:1,pickupMin:0,dropoffMin:0,wrapMin:1,labelMin:0,exitMin:0,chargeTravelMin:1},
  warehouse:[{id:'S1',rowId:'R1',capacity:10,permission:true}],
  magazines:[{id:'M1',quantity:4,capacity:20,trigger:3,refillBatch:10,permission:true}],
  aligners:[{id:'AL1',ready:true}],
  productionEvents:[{timeMs:60_000,lineId:'L1',palletId:'P1',destinationLocationId:'S1'}],
  ...overrides
});
const types = result => result.events.map(e=>e.type);
test('01 -> wrap -> label -> exit -> 02 -> slot, with deterministic replay',()=>{
  const scenario=fixture(), a=simulate(scenario), b=simulate(scenario);
  assert.deepEqual(a.events,b.events);
  assert.deepEqual(a.snapshots,b.snapshots);
  assert.equal(a.metrics.stored,1);
  assert.deepEqual(a.final.warehouse.S1.palletIds,['P1']);
  const seq=types(a);
  for (const type of ['PALLET_EXITED','TASK_PICKED','WRAP_STARTED','WRAP_COMPLETED',
    'LABEL_COMPLETED','EXIT_READY','STORE_COMPLETED']) assert.ok(seq.includes(type),type);
  const exit=a.events.findIndex(e=>e.type==='EXIT_READY');
  const task02=a.events.findIndex(e=>e.type==='TASK_REQUESTED'&&e.kind==='02');
  assert.ok(exit<task02);
  assert.equal(a.metrics.scenarioTiming,'assumption-not-measured');
});
test('destination-area vehicle wins over lower battery at origin',()=>{
  const a=simulate(fixture({agfs:[
    {id:'A1',area:'PZ',batteryPct:50},{id:'A2',area:'PZ',batteryPct:70},
    {id:'A3',area:'WH',batteryPct:41},{id:'A4',area:'WH',batteryPct:90}
  ]}));
  const task02=a.events.find(e=>e.type==='TASK_ASSIGNED'&&e.kind==='02');
  assert.equal(task02.agfId,'A3');
});
test('explicit wait fallback does not invent cross-area dispatch',()=>{
  const s=fixture({fallback:'wait',agfs:['A1','A2','A3','A4'].map(id=>({id,area:'WH',batteryPct:100}))});
  const a=simulate(s);
  assert.equal(a.metrics.completed,0);
  assert.equal(a.final.lines.L1.length,1);
  assert.ok(a.events.some(e=>e.reason==='NO_ELIGIBLE_AGF'));
});
test('capacity overflow fails rather than losing a produced pallet',()=>{
  const s=fixture({lineCapacity:1,productionEvents:[
    {timeMs:0,lineId:'L1',palletId:'P1',destinationLocationId:'S1'},
    {timeMs:0,lineId:'L1',palletId:'P2',destinationLocationId:'S1'}
  ],agfs:['A1','A2','A3','A4'].map(id=>({id,area:'WH',batteryPct:100})),fallback:'wait'});
  assert.throws(()=>simulate(s),/line buffer overflow/);
});
test('03 is triggered only by real usage at exact remaining quantity and refilled at drop',()=>{
  const s=fixture({productionEvents:[],lineIntervalsMin:[0,0,0,0,0,0,0,0],
    magazineUses:[{timeMs:0,magazineId:'M1'}]});
  const a=simulate(s);
  assert.equal(types(a).filter(x=>x==='MAGAZINE_REFILL_REQUESTED').length,1);
  assert.equal(types(a).filter(x=>x==='MAGAZINE_REFILLED').length,1);
  assert.equal(a.final.magazines.M1.quantity,13);
  assert.equal(a.final.aligners.AL1.ready,false);
});
test('03 cannot pick an unready aligner',()=>{
  const s=fixture({productionEvents:[],lineIntervalsMin:[0,0,0,0,0,0,0,0],
    aligners:[{id:'AL1',ready:false}],magazineUses:[{timeMs:0,magazineId:'M1'}]});
  const a=simulate(s);
  assert.equal(a.metrics.byKind['03']??0,0);
  assert.equal(a.final.magazines.M1.pending,false);
  assert.equal(a.final.magazines.M1.refillNeeded,true);
  assert.ok(!a.events.some(e=>e.type==='TASK_REQUESTED'&&e.kind==='03'));
});
test('04 re-enters wrapping and eventually stores same pallet',()=>{
  const s=fixture({productionEvents:[],lineIntervalsMin:[0,0,0,0,0,0,0,0],
    temporaryPallets:[{palletId:'P0',locationId:'OT1',destinationLocationId:'S1'}],
    manualRequests:[{timeMs:0,kind:'04',palletId:'P0',locationId:'OT1',reentryPermission:true}]});
  const a=simulate(s);
  assert.equal(a.metrics.byKind['04'],1);assert.equal(a.metrics.byKind['02'],1);
  assert.deepEqual(a.final.warehouse.S1.palletIds,['P0']);
});
test('05 needs an explicit storage permission and cannot double-book 04/05',()=>{
  const base={productionEvents:[],lineIntervalsMin:[0,0,0,0,0,0,0,0],
    temporaryPallets:[{palletId:'P0',locationId:'OT1',destinationLocationId:'S1'}]};
  assert.throws(()=>simulate(fixture({...base,manualRequests:[
    {timeMs:0,kind:'05',palletId:'P0',locationId:'OT1',destinationLocationId:'S1'}
  ]})),/explicit permission/);
  assert.throws(()=>simulate(fixture({...base,manualRequests:[
    {timeMs:0,kind:'04',palletId:'P0',locationId:'OT1',reentryPermission:true},
    {timeMs:0,kind:'05',palletId:'P0',locationId:'OT1',destinationLocationId:'S1',storagePermission:true}
  ]})),/unreserved pallet/);
  const a=simulate(fixture({...base,manualRequests:[
    {timeMs:0,kind:'05',palletId:'P0',locationId:'OT1',destinationLocationId:'S1',storagePermission:true}
  ]}));
  assert.equal(a.metrics.byKind['05'],1);
});
test('only two chargers can be occupied and charging finishes at the scenario target',()=>{
  const s=fixture({durationMin:20,productionEvents:[
    {timeMs:0,lineId:'L1',palletId:'P1',destinationLocationId:'S1'},
    {timeMs:0,lineId:'L2',palletId:'P2',destinationLocationId:'S1'},
    {timeMs:0,lineId:'L3',palletId:'P3',destinationLocationId:'S1'}
  ],agfs:['A1','A2','A3','A4'].map(id=>({id,area:'PZ',batteryPct:41})),
    battery:{reservePct:0,chargeStartPct:40,chargeTargetPct:80,consumptionPct:2,chargeMinPerPct:0.1}});
  const a=simulate(s);
  for (const snap of a.snapshots)
    assert.ok(Object.values(snap.chargers).filter(Boolean).length<=2);
  assert.ok(types(a).includes('CHARGE_STARTED'));
  assert.ok(a.events.some(e=>e.type==='CHARGE_ENDED'&&e.batteryPct===80));
});
test('synthetic per-line interval creates traceable input, not claimed PLC history',()=>{
  const a=simulate(fixture({productionEvents:[],durationMin:10,
    lineIntervalsMin:[5,0,0,0,0,0,0,0]}));
  const p=a.events.filter(e=>e.type==='PALLET_EXITED');
  assert.deepEqual(p.map(e=>e.timeMs),[300_000,600_000]);
  assert.ok(p.every(e=>e.inputKind==='synthetic-interval'));
});


test('02 reserves a destination and records same-row hold until prior put completes',()=>{
  const a=simulate(fixture({productionEvents:[
    {timeMs:0,lineId:'L1',palletId:'P1',destinationLocationId:'S1'},
    {timeMs:0,lineId:'L2',palletId:'P2',destinationLocationId:'S1'}
  ]}));
  assert.ok(a.events.some(e=>e.type==='TASK_02_HELD' && e.reason==='SAME_ROW_ACTIVE'));
  assert.equal(a.metrics.byKind['02'],2);
  assert.deepEqual(a.final.warehouse.S1.palletIds.sort(),['P1','P2']);
  assert.ok(a.snapshots.every(s=>s.warehouse.S1.reserved.length<=1));
});
