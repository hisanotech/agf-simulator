import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {warehouseLocations} from '../src/map/warehouse-layout.mjs';
import {syntheticWarehousePolicy} from '../examples/synthetic-warehouse-policy.mjs';
import {generateProductionEvents} from '../src/core/production-streams.mjs';

// Explicit synthetic test mapping, timings and device inventory; not site data.
const fixture=(extra={})=>({durationMin:20,mode:'area_first',fallback:'any',lineCapacity:1,
  productionModel:'empty_pallet_supply',lineMagazineMap:Object.fromEntries(Array.from({length:8},(_,i)=>['L'+(i+1),'M1'])),
  magazineEmptyRecoveryPolicy:'immediate_retry',lineIntervalsMin:Array(8).fill(0),generatedDestinationIds:['S1'],
  wrapper:{inputCapacity:1,outputCapacity:2},agfs:['A1','A2','A3','A4'].map(id=>({id,area:'PZ',batteryPct:100})),
  chargerIds:['C1','C2'],battery:{reservePct:40,chargeStartPct:40,chargeTargetPct:80,consumptionPct:0,chargeMinPerPct:2.4},
  times:{emptyMin:5,loadedMin:1,pickupMin:0,dropoffMin:0,wrapMin:1,labelMin:0,exitMin:0,chargeTravelMin:1},
  warehouse:[{id:'S1',rowId:'R1',capacity:100,permission:true}],
  magazines:[{id:'M1',quantity:20,capacity:30,trigger:3,refillBatch:10,permission:true}],
  aligners:[{id:'AL1',quantity:0}],productionEvents:[],...extra});
const due=(timeMs,palletId,lineId='L1')=>({timeMs,palletId,lineId,destinationLocationId:'S1'});
const events=(run,type)=>run.events.filter(e=>e.type===type);
const assertCapacity=run=>assert.ok(run.snapshots.every(s=>Object.values(s.lines).every(l=>l.length<=run.scenario.lineCapacity)));

test('full line ends normally without an empty-pallet discharge, real pallet or extra backlog',()=>{
  const scenario=fixture({fallback:'wait',agfs:['A1','A2','A3','A4'].map(id=>({id,area:'WH',batteryPct:100})),
    productionEvents:[due(0,'P1'),due(60000,'P2'),due(120000,'P3'),due(180000,'P4')]});
  const run=simulate(scenario);assertCapacity(run);
  assert.equal(events(run,'PALLET_EXITED').length,1);assert.equal(events(run,'PALLETIZED').length,1);
  assert.equal(events(run,'EMPTY_PALLET_DISCHARGED').length,1);assert.equal(run.final.magazines.M1.quantity,19);
  assert.deepEqual(run.final.pallets.map(p=>p.palletId),['P1']);assert.deepEqual(run.final.lines.L1,['P1']);
  const blocked=events(run,'LINE_BUFFER_BLOCKED');assert.equal(blocked.length,1);
  assert.equal(blocked[0].plannedPalletId,'P2');assert.equal(blocked[0].palletId,undefined);
  assert.equal(blocked[0].originalDueAt,60000);assert.equal(blocked[0].blockedSinceMs,60000);
  assert.equal(run.final.productionStatus.L1.reason,'LINE_BUFFER_FULL');
  assert.equal(run.final.productionStatus.L1.plannedPalletId,'P2');
  assert.deepEqual(run.events,simulate(scenario).events);
});
test('01 pickup releases one slot and resumes only the same pending pallet in causal order',()=>{
  const run=simulate(fixture({productionEvents:[due(0,'P1'),due(60000,'P2'),due(120000,'P3')]}));assertCapacity(run);
  const picked=events(run,'TASK_PICKED').find(e=>e.palletId==='P1');
  const released=events(run,'LINE_BUFFER_RELEASED')[0],resumed=events(run,'PRODUCTION_RESUMED_FROM_BUFFER')[0];
  assert.ok(picked.sequence<released.sequence&&released.sequence<resumed.sequence);
  assert.equal(picked.timeMs,300000);assert.equal(released.timeMs,picked.timeMs);assert.equal(resumed.timeMs,picked.timeMs);
  assert.equal(released.quantityBefore,1);assert.equal(released.quantityAfter,0);
  assert.equal(resumed.quantityBefore,0);assert.equal(resumed.quantityAfter,1);assert.equal(resumed.waitMs,240000);
  assert.equal(resumed.palletId,'P2');assert.equal(resumed.plannedPalletId,'P2');
  assert.equal(events(run,'PALLET_EXITED').filter(e=>e.palletId==='P2').length,1);
  assert.equal(events(run,'PALLET_EXITED').filter(e=>e.palletId==='P3').length,0);
  assert.equal(events(run,'TASK_REQUESTED').find(e=>e.palletId==='P2').kind,'01');
});
test('interval production pauses its clock and bases the next takt on actual buffer resume',()=>{
  const run=simulate(fixture({durationMin:9,lineIntervalsMin:[1,0,0,0,0,0,0,0]}));assertCapacity(run);
  const exited=events(run,'PALLET_EXITED');assert.deepEqual(exited.slice(0,3).map(e=>[e.palletId,e.timeMs]),
    [['SIM-L1-1',60000],['SIM-L1-2',360000],['SIM-L1-3',660000]].filter(([,t])=>t<=540000));
  const dueEvents=events(run,'PRODUCTION_DUE');
  assert.ok(dueEvents.some(e=>e.plannedPalletId==='SIM-L1-3'&&e.timeMs===420000));
  assert.ok(!dueEvents.some(e=>[180000,240000,300000].includes(e.timeMs)));
});
test('legacy supplied pallets obey full-buffer stop without consuming magazine inventory',()=>{
  const run=simulate(fixture({productionModel:'legacy_external_pallets',lineMagazineMap:undefined,
    productionEvents:[due(0,'P1'),due(60000,'P2')]}));assertCapacity(run);
  assert.equal(run.final.magazines.M1.quantity,20);assert.equal(events(run,'EMPTY_PALLET_DISCHARGED').length,0);
  assert.equal(events(run,'PRODUCTION_RESUMED_FROM_BUFFER')[0].palletId,'P2');
});
test('invalid line capacity remains rejected',()=>{
  for(const lineCapacity of [0,-1,1.5])assert.throws(()=>simulate(fixture({lineCapacity})),/lineCapacity/);
});

for(const policy of ['immediate_retry','next_takt',null])test('buffer then empty supply preserves planned identity and explicit recovery '+String(policy),()=>{
  const run=simulate(fixture({durationMin:22,magazineEmptyRecoveryPolicy:policy,
    magazines:[{id:'M1',quantity:1,capacity:30,trigger:0,refillBatch:10,permission:true}],
    productionEvents:[due(0,'P1'),due(60000,'P2'),due(960000,'P3')],
    alignerRefillEvents:[{timeMs:480000,alignerId:'AL1',operationType:'individual'}]}));assertCapacity(run);
  const blocked=events(run,'LINE_BUFFER_BLOCKED')[0],released=events(run,'LINE_BUFFER_RELEASED')[0];
  const empty=events(run,'PRODUCTION_BLOCKED_EMPTY_PALLET').find(e=>e.plannedPalletId==='P2');
  assert.ok(blocked.sequence<released.sequence&&released.sequence<empty.sequence);
  assert.equal(empty.timeMs,300000);assert.equal(empty.blockedSinceMs,60000);
  const refill=events(run,'MAGAZINE_REFILLED')[0];assert.equal(refill.timeMs,840000);
  const resumed=events(run,'PRODUCTION_RESUMED_FROM_BUFFER');
  if(policy===null){
    assert.equal(resumed.length,0);assert.equal(run.final.productionStatus.L1.reason,'RECOVERY_POLICY_UNSET');
    assert.equal(run.final.productionStatus.L1.plannedPalletId,'P2');
  }else{
    assert.equal(resumed[0].palletId,'P2');assert.equal(resumed[0].plannedPalletId,'P2');
    assert.equal(resumed[0].timeMs,policy==='immediate_retry'?840000:960000);
    assert.equal(resumed[0].waitMs,resumed[0].timeMs-60000);
    const request=events(run,'TASK_REQUESTED').find(e=>e.palletId==='P2');assert.equal(request.kind,'01');
    if(policy==='next_takt'){
      assert.match(resumed[0].evidence,/next_takt/);
      assert.equal(events(run,'PALLET_EXITED').some(e=>e.palletId==='P3'),false);
    }
  }
});
test('empty supply then full buffer starts its buffer wait at the actual capacity transition',()=>{
  const run=simulate(fixture({durationMin:22,
    magazines:[{id:'M1',quantity:1,capacity:30,trigger:0,refillBatch:10,permission:false}],
    aligners:[{id:'AL1',quantity:10}],
    productionEvents:[due(0,'P1'),due(360000,'P2'),due(600000,'P3')],
    permissionEvents:[{timeMs:600000,target:'magazine',targetId:'M1',permitted:true}]}));assertCapacity(run);
  const empty=events(run,'PRODUCTION_BLOCKED_EMPTY_PALLET').find(e=>e.plannedPalletId==='P2');
  const blocked=events(run,'LINE_BUFFER_BLOCKED').find(e=>e.plannedPalletId==='P2');
  const resumed=events(run,'PRODUCTION_RESUMED_FROM_BUFFER').find(e=>e.plannedPalletId==='P2');
  assert.equal(empty.timeMs,360000);assert.equal(blocked.timeMs,600000);assert.equal(blocked.blockedSinceMs,600000);
  assert.equal(resumed.palletId,'P2');assert.equal(resumed.timeMs,900000);assert.equal(resumed.waitMs,300000);
});
test('multiple lines stop independently and one pickup cannot resume a different full line',()=>{
  const run=simulate(fixture({productionEvents:[due(0,'P1','L1'),due(0,'Q1','L2'),
    due(60000,'P2','L1'),due(60000,'Q2','L2'),due(120000,'P3','L1'),due(120000,'Q3','L2')]}));assertCapacity(run);
  assert.deepEqual(events(run,'LINE_BUFFER_BLOCKED').map(e=>[e.lineId,e.plannedPalletId]),[['L1','P2'],['L2','Q2']]);
  assert.deepEqual(events(run,'PRODUCTION_RESUMED_FROM_BUFFER').map(e=>[e.lineId,e.palletId]),[['L1','P2'],['L2','Q2']]);
  for(const resume of events(run,'PRODUCTION_RESUMED_FROM_BUFFER'))assert.equal(events(run,'LINE_BUFFER_RELEASED')
    .find(e=>e.lineId===resume.lineId&&e.plannedPalletId===resume.plannedPalletId).timeMs,resume.timeMs);
});
const fourStreams=()=>[['normal','full'],['normal','partial'],['special','full'],['special','partial']]
  .map(([productType,loadType],i)=>({sourceLineId:'L1',productType,loadType,enabled:true,
    intervalMin:i+1,startOffsetMin:0}));
test('all product variant clocks pause together and each restarts from actual buffer resume',()=>{
  const streams=fourStreams(),run=simulate(fixture({durationMin:9,productStreams:streams,
    warehouse:warehouseLocations(),warehousePolicy:syntheticWarehousePolicy()}));assertCapacity(run);
  const stopped=events(run,'LINE_BUFFER_BLOCKED')[0],resumed=events(run,'PRODUCTION_RESUMED_FROM_BUFFER')[0];
  assert.equal(stopped.plannedPalletId,'SIM-L1-normal-full-2');assert.equal(resumed.palletId,stopped.plannedPalletId);
  assert.equal(resumed.timeMs,360000);
  assert.ok(!events(run,'PRODUCTION_DUE').some(e=>e.timeMs>120000&&e.timeMs<360000));
  const next=events(run,'PRODUCTION_DUE').find(e=>!e.retry&&e.timeMs>resumed.timeMs);
  assert.equal(next.timeMs,420000);assert.equal(next.plannedPalletId,'SIM-L1-normal-full-3');
  assert.equal(run.final.productionStatus.L1.plannedPalletId,next.plannedPalletId);
  assert.ok(!run.final.pallets.some(p=>p.loadType==='partial'||p.productType==='special'));
});
test('unblocked product streams preserve configured first offsets, intervals and deterministic variant order',()=>{
  for(const offsets of [false,true]){
    const streams=fourStreams().map((s,i)=>({...s,startOffsetMin:offsets?i/10:0})),durationMin=5;
    const scenario=fixture({durationMin,lineCapacity:100,productStreams:streams,
      warehouse:warehouseLocations(),warehousePolicy:syntheticWarehousePolicy()});
    const run=simulate(scenario),planned=generateProductionEvents(streams,durationMin*60000,Array.from({length:8},(_,i)=>'L'+(i+1)));
    assert.deepEqual(events(run,'PALLET_EXITED').map(e=>[e.palletId,e.timeMs]),planned.map(e=>[e.palletId,e.timeMs]));
    assert.deepEqual(run.events,simulate(scenario).events);
  }
});
test('next-takt empty recovery of an interval buffer stop retains its ID and starts following takt at real resume',()=>{
  const run=simulate(fixture({durationMin:17,magazineEmptyRecoveryPolicy:'next_takt',
    magazines:[{id:'M1',quantity:1,capacity:30,trigger:0,refillBatch:10,permission:true}],
    lineIntervalsMin:[1,0,0,0,0,0,0,0],
    alignerRefillEvents:[{timeMs:480000,alignerId:'AL1',operationType:'individual'}]}));assertCapacity(run);
  const resumed=events(run,'PRODUCTION_RESUMED_FROM_BUFFER')[0];
  assert.equal(resumed.timeMs,900000);assert.equal(resumed.palletId,'SIM-L1-2');
  assert.match(resumed.evidence,/next_takt/);
  const next=events(run,'PRODUCTION_DUE').find(e=>e.timeMs>resumed.timeMs&&!e.retry);
  assert.equal(next.timeMs,960000);assert.equal(next.plannedPalletId,'SIM-L1-3');
});
test('a previously retained empty-supply retry is not lost when another same-time opportunity stops the buffer',()=>{
  const run=simulate(fixture({durationMin:28,
    magazines:[{id:'M1',quantity:1,capacity:30,trigger:0,refillBatch:10,permission:false}],
    aligners:[{id:'AL1',quantity:10}],
    productionEvents:[due(0,'P1'),due(360000,'P2'),due(600000,'P3'),due(600000,'P4')],
    permissionEvents:[{timeMs:600000,target:'magazine',targetId:'M1',permitted:true}]}));assertCapacity(run);
  assert.equal(events(run,'PRODUCTION_BLOCKED_EMPTY_PALLET').find(e=>e.plannedPalletId==='P2').timeMs,360000);
  assert.deepEqual(events(run,'PALLET_EXITED').map(e=>e.palletId),['P1','P3','P4','P2']);
  assert.equal(events(run,'EMPTY_PALLET_DISCHARGED').filter(e=>e.palletId==='P2').length,1);
  assert.equal(events(run,'PRODUCTION_RESUMED_FROM_BUFFER').find(e=>e.plannedPalletId==='P2').palletId,'P2');
});
