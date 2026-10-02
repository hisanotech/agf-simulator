import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';

// Synthetic test mapping only. This is not the unconfirmed facility mapping.
const syntheticTestMapping=Object.fromEntries(Array.from({length:8},(_,i)=>['L'+(i+1),'M1']));
const event=(timeMs,palletId,lineId='L1')=>({timeMs,palletId,lineId,destinationLocationId:'S1'});
const fixture=(overrides={})=>({
  durationMin:20,mode:'area_first',fallback:'any',lineCapacity:100,
  productionModel:'empty_pallet_supply',lineMagazineMap:{...syntheticTestMapping},
  lineMagazineMapEvidence:'synthetic test mapping',magazineEmptyRecoveryPolicy:null,
  lineIntervalsMin:Array(8).fill(0),generatedDestinationIds:['S1'],
  wrapper:{inputCapacity:1,outputCapacity:2},
  agfs:['A1','A2','A3','A4'].map(id=>({id,area:'PZ',batteryPct:100})),chargerIds:['C1','C2'],
  battery:{reservePct:40,chargeStartPct:40,chargeTargetPct:80,consumptionPct:0,chargeMinPerPct:2.4},
  times:{emptyMin:1,loadedMin:1,pickupMin:0,dropoffMin:0,wrapMin:1,labelMin:0,exitMin:0,chargeTravelMin:1},
  warehouse:[{id:'S1',rowId:'R1',capacity:100,permission:true}],
  magazines:Array.from({length:5},(_,i)=>({id:'M'+(i+1),quantity:10,capacity:20,trigger:3,refillBatch:10,permission:true})),
  aligners:Array.from({length:5},(_,i)=>({id:'AL'+(i+1),quantity:10})),
  productionEvents:[],...overrides
});
const magazine=(quantity,extra={})=>({id:'M1',quantity,capacity:20,trigger:3,refillBatch:10,permission:true,...extra});
const of=(run,type)=>run.events.filter(e=>e.type===type);
const requests=(run,kind)=>of(run,'TASK_REQUESTED').filter(e=>e.kind===kind);

test('neutral core start has ten empty pallets per magazine and aligner, no WIP or reservations',()=>{
  const initial=simulate(fixture()).snapshots[0];
  assert.deepEqual(Object.values(initial.magazines).map(m=>m.quantity),Array(5).fill(10));
  assert.deepEqual(Object.values(initial.aligners).map(a=>a.quantity),Array(5).fill(10));
  assert.ok(Object.values(initial.aligners).every(a=>a.ready&&a.reservedTaskId===null));
  assert.ok(Object.values(initial.magazines).every(m=>!m.refillNeeded&&!m.pending));
  assert.equal(initial.tasks.length,0);assert.equal(initial.pallets.length,0);assert.equal(initial.temporaryPallets.length,0);
  assert.ok(Object.values(initial.lines).every(q=>q.length===0));
  assert.deepEqual(initial.wrapper.input,[]);assert.deepEqual(initial.wrapper.output,[]);assert.equal(initial.wrapper.processing,null);
  assert.ok(Object.values(initial.warehouse).every(s=>s.palletIds.length===0&&s.reserved.length===0));
  assert.ok(Object.values(initial.chargers).every(a=>a===null));
});
test('production consumes exactly one empty pallet before palletizing, exit and 01 request at one timestamp',()=>{
  const run=simulate(fixture({productionEvents:[event(0,'P1')]}));
  const trace=run.events.filter(e=>e.palletId==='P1'&&['PRODUCTION_DUE','EMPTY_PALLET_DISCHARGED','PALLETIZED','PALLET_EXITED','TASK_REQUESTED'].includes(e.type));
  assert.deepEqual(trace.slice(0,5).map(e=>e.type),['PRODUCTION_DUE','EMPTY_PALLET_DISCHARGED','PALLETIZED','PALLET_EXITED','TASK_REQUESTED']);
  assert.ok(trace.slice(0,5).every(e=>e.timeMs===0));assert.equal(trace[4].kind,'01');
  assert.ok(trace.slice(1,5).every((e,i)=>e.sequence>trace[i].sequence));
  assert.equal(run.final.magazines.M1.quantity,9);assert.equal(of(run,'EMPTY_PALLET_DISCHARGED').length,1);
  assert.equal(of(run,'MAGAZINE_USED').length,0);
  assert.deepEqual(Object.fromEntries(['magazineId','lineId','palletId','quantityBefore','quantityAfter','timeMs'].map(k=>[k,trace[1][k]])),
    {magazineId:'M1',lineId:'L1',palletId:'P1',quantityBefore:10,quantityAfter:9,timeMs:0});
});
test('empty magazine cannot create a real pallet, exit, buffer occupancy or 01 request',()=>{
  const run=simulate(fixture({magazines:[magazine(0)],productionEvents:[event(0,'P1')]}));
  assert.equal(of(run,'PALLET_EXITED').length,0);assert.equal(of(run,'PALLETIZED').length,0);assert.equal(requests(run,'01').length,0);
  assert.equal(run.final.pallets.length,0);assert.deepEqual(run.final.lines.L1,[]);assert.equal(run.final.magazines.M1.quantity,0);
  assert.equal(of(run,'PRODUCTION_BLOCKED_EMPTY_PALLET').length,1);
  assert.equal(run.final.productionStatus.L1.reason,'EMPTY_PALLET');
});
test('coupled production requires complete known mapping and accepts shared magazine supply',()=>{
  for(const mapping of [undefined,{L1:'M1'},{...syntheticTestMapping,L8:'M404'}])
    assert.throws(()=>simulate(fixture({lineMagazineMap:mapping})),/PRODUCTION_CONFIG/);
  const run=simulate(fixture({productionEvents:[event(0,'P1','L1'),event(1,'P2','L8')]}));
  assert.equal(run.final.magazines.M1.quantity,8);assert.equal(of(run,'EMPTY_PALLET_DISCHARGED').length,2);
});
test('coupled production rejects legacy independent uses instead of consuming twice',()=>{
  assert.throws(()=>simulate(fixture({productionEvents:[event(0,'P1')],magazineUses:[{timeMs:0,magazineId:'M1'}]})),/legacy|magazineUses/);
  assert.throws(()=>simulate(fixture({aligners:[{id:'AL1',quantity:0}],alignerReadyEvents:[{timeMs:30000,alignerId:'AL1'}]})),/legacy|alignerReadyEvents/);
});
test('4 to 3 creates one refill-needed state but no 03 when every aligner is empty',()=>{
  const run=simulate(fixture({magazines:[magazine(4)],aligners:[{id:'AL1',quantity:0}],productionEvents:[event(0,'P1'),event(1,'P2'),event(2,'P3'),event(3,'P4')]}));
  assert.equal(of(run,'MAGAZINE_REFILL_NEEDED').length,1);assert.equal(requests(run,'03').length,0);
  assert.equal(run.final.magazines.M1.refillNeeded,true);assert.equal(run.final.magazines.M1.pending,false);
  assert.equal(run.final.magazines.M1.quantity,0);
});
test('03 issuance reserves a loaded aligner before assignment and pickup empties it permanently',()=>{
  const run=simulate(fixture({magazines:[magazine(4)],aligners:[{id:'AL1',quantity:10}],productionEvents:[event(0,'P1')],
    agfs:['A1','A2','A3','A4'].map(id=>({id,area:'WH',batteryPct:100})),fallback:'wait'}));
  const requestedIndex=run.events.findIndex(e=>e.type==='TASK_REQUESTED'&&e.kind==='03'),requested=run.events[requestedIndex];
  assert.equal(run.snapshots[requestedIndex].aligners.AL1.reservedTaskId,requested.taskId);
  assert.equal(run.final.aligners.AL1.quantity,10); // Destination-area restriction leaves issued task unassigned.
  const completed=simulate(fixture({magazines:[magazine(4)],aligners:[{id:'AL1',quantity:10}],productionEvents:[event(0,'P1')]}));
  const picked=of(completed,'ALIGNER_STACK_PICKED')[0];
  assert.equal(picked.quantityBefore,10);assert.equal(picked.quantityAfter,0);assert.equal(picked.pickedAt,picked.timeMs);
  assert.ok(picked.taskId&&picked.agfId);assert.equal(completed.final.aligners.AL1.quantity,0);assert.equal(completed.final.aligners.AL1.ready,false);
});
test('two refill-needed magazines cannot reserve the same aligner stack',()=>{
  const run=simulate(fixture({magazines:[magazine(4),{...magazine(4),id:'M2'}],aligners:[{id:'AL1',quantity:10}],
    lineMagazineMap:{...syntheticTestMapping,L2:'M2'},productionEvents:[event(0,'P1'),event(0,'P2','L2')],
    agfs:['A1','A2','A3','A4'].map(id=>({id,area:'WH',batteryPct:100})),fallback:'wait'}));
  assert.equal(requests(run,'03').length,1);assert.equal(run.final.magazines.M2.refillNeeded,true);assert.equal(run.final.magazines.M2.pending,false);
});
for(const arrivalQuantity of [3,2,1,0])test('03 drop adds ten to current magazine quantity '+arrivalQuantity,()=>{
  const count=4-arrivalQuantity,productionEvents=Array.from({length:count},(_,i)=>event(i*1000,'P'+i));
  const run=simulate(fixture({magazines:[magazine(4)],aligners:[{id:'AL1',quantity:10}],productionEvents}));
  assert.equal(requests(run,'03').length,1);assert.equal(of(run,'MAGAZINE_REFILL_NEEDED').length,1);
  const refill=of(run,'MAGAZINE_REFILLED')[0];assert.equal(refill.quantityBefore,arrivalQuantity);assert.equal(refill.quantityAfter,arrivalQuantity+10);
  assert.equal(run.final.magazines.M1.quantity,arrivalQuantity+10);assert.equal(run.final.magazines.M1.refillNeeded,false);
});
test('permission alone never replenishes; only permitted completed drop adds the stack',()=>{
  const run=simulate(fixture({magazines:[magazine(4,{permission:false})],aligners:[{id:'AL1',quantity:10}],productionEvents:[event(0,'P1')],
    permissionEvents:[{timeMs:600000,target:'magazine',targetId:'M1',permitted:true}]}));
  assert.equal(run.events.filter(e=>e.type==='MAGAZINE_REFILLED').length,1);
  const allowed=run.events.findIndex(e=>e.type==='EQUIPMENT_PERMISSION_CHANGED'),refilled=run.events.findIndex(e=>e.type==='MAGAZINE_REFILLED');
  assert.equal(run.snapshots[allowed].magazines.M1.quantity,3);assert.ok(refilled>allowed);assert.equal(run.events[refilled].quantityAfter,13);
});
test('aligner permission loss after assignment holds pickup without consumption until explicit recovery',()=>{
  const run=simulate(fixture({magazines:[magazine(4)],aligners:[{id:'AL1',quantity:10}],productionEvents:[event(0,'P1')],
    permissionEvents:[{timeMs:30000,target:'aligner',targetId:'AL1',permitted:false},
      {timeMs:300000,target:'aligner',targetId:'AL1',permitted:true}]}));
  const waiting=run.events.findIndex(e=>e.type==='TASK_WAITING'&&e.reason==='ALIGNER_PERMISSION');
  assert.ok(waiting>=0);assert.equal(run.snapshots[waiting].aligners.AL1.quantity,10);
  assert.equal(run.snapshots[waiting].agfs.find(a=>a.taskId===run.events[waiting].taskId).status,'waiting_pickup');
  assert.equal(of(run,'ALIGNER_STACK_PICKED')[0].timeMs,300000);assert.equal(run.final.aligners.AL1.quantity,0);
});
test('individual refill changes only empty target and loaded target remains ten',()=>{
  const run=simulate(fixture({aligners:[{id:'AL1',quantity:0},{id:'AL2',quantity:0},{id:'AL3',quantity:10}],
    alignerRefillEvents:[{timeMs:60000,alignerId:'AL1',operationType:'individual'},{timeMs:120000,alignerId:'AL3',operationType:'individual'}]}));
  assert.deepEqual(Object.values(run.final.aligners).map(a=>a.quantity),[10,0,10]);
  const inputs=of(run,'ALIGNER_REFILL_OPERATED');assert.equal(inputs.length,2);assert.equal(inputs[0].timeMs,60000);
  assert.equal(inputs[0].operationType,'individual');assert.equal(of(run,'ALIGNER_REFILLED').length,1);
});
test('all refill restores empty aligners only and records operation type',()=>{
  const run=simulate(fixture({aligners:[{id:'AL1',quantity:0},{id:'AL2',quantity:10},{id:'AL3',quantity:0}],
    alignerRefillEvents:[{timeMs:45000,alignerId:null,operationType:'all'}]}));
  assert.deepEqual(Object.values(run.final.aligners).map(a=>a.quantity),[10,10,10]);
  assert.equal(of(run,'ALIGNER_REFILLED').length,2);assert.ok(of(run,'ALIGNER_REFILLED').every(e=>e.operationType==='all'&&e.timeMs===45000));
});
test('manual aligner refill reevaluates refill-needed magazine and issues 03 only afterward',()=>{
  const run=simulate(fixture({magazines:[magazine(4)],aligners:[{id:'AL1',quantity:0},{id:'AL2',quantity:0}],productionEvents:[event(0,'P1')],
    alignerRefillEvents:[{timeMs:180000,alignerId:'AL2',operationType:'individual'}]}));
  const task=requests(run,'03')[0];assert.equal(task.timeMs,180000);assert.equal(run.final.tasks.find(t=>t.id===task.taskId).alignerId,'AL2');
  assert.equal(run.final.aligners.AL1.quantity,0);assert.equal(run.final.aligners.AL2.quantity,0);
});
test('displayed-time refill at the exact pickup timestamp operates after the observed pickup without adding time',()=>{
  const scenario=fixture({magazines:[magazine(4)],aligners:[{id:'AL1',quantity:10},{id:'AL2',quantity:0}],productionEvents:[event(0,'P1')]});
  const before=simulate(scenario),pickup=of(before,'ALIGNER_STACK_PICKED')[0];
  const run=simulate({...scenario,alignerRefillEvents:[
    {timeMs:pickup.timeMs,alignerId:'AL1',operationType:'individual'},
    {timeMs:pickup.timeMs,alignerId:null,operationType:'all'}
  ]});
  const refills=of(run,'ALIGNER_REFILLED');assert.equal(run.final.aligners.AL1.quantity,10);assert.equal(run.final.aligners.AL2.quantity,10);
  assert.ok(refills.every(e=>e.timeMs===pickup.timeMs));
  assert.equal(refills.filter(e=>e.alignerId==='AL1').length,1); // all must not make the just-filled stack20.
  assert.ok(run.events.find(e=>e.type==='ALIGNER_STACK_PICKED').sequence<refills.find(e=>e.alignerId==='AL1').sequence);
  assert.deepEqual(run.events,simulate(run.scenario).events);
});
test('invalid refill operations and contradictory quantity/ready inputs are rejected',()=>{
  assert.throws(()=>simulate(fixture({aligners:[{id:'AL1',quantity:0,ready:true}]})),/aligner/);
  for(const input of [{timeMs:0,alignerId:'AL404',operationType:'individual'},{timeMs:0,alignerId:'AL1',operationType:'automatic'},{timeMs:-1,alignerId:'AL1',operationType:'individual'}])
    assert.throws(()=>simulate(fixture({alignerRefillEvents:[input]})),/aligner refill/);
});
for(const recovery of ['immediate_retry','next_takt',null])test('empty recovery policy '+String(recovery)+' is explicit and replayable',()=>{
  const scenario=fixture({magazines:[magazine(4)],aligners:[{id:'AL1',quantity:10}],magazineEmptyRecoveryPolicy:recovery,
    productionEvents:Array.from({length:5},(_,i)=>event(i*1000,'P'+i))});
  const run=simulate(scenario);
  assert.equal(of(run,'PRODUCTION_BLOCKED_EMPTY_PALLET').length,1);
  assert.equal(of(run,'PALLET_EXITED').filter(e=>e.palletId==='P4').length,recovery==='immediate_retry'?1:0);
  if(recovery==='immediate_retry')assert.ok(of(run,'PALLET_EXITED').find(e=>e.palletId==='P4').timeMs>4000);
  else assert.equal(run.final.magazines.M1.quantity,10);
  assert.deepEqual(run.events,simulate(scenario).events);
});
test('immediate retry retains multiple missed opportunities and drains them only as line buffer capacity frees',()=>{
  const scenario=fixture({durationMin:40,lineCapacity:2,magazines:[magazine(4,{permission:false})],aligners:[{id:'AL1',quantity:10}],
    productionEvents:Array.from({length:9},(_,i)=>event(i*120000,'P'+i)),magazineEmptyRecoveryPolicy:'immediate_retry',
    permissionEvents:[{timeMs:1200000,target:'magazine',targetId:'M1',permitted:true}]});
  const run=simulate(scenario);
  assert.equal(of(run,'PRODUCTION_BLOCKED_EMPTY_PALLET').length,5);
  assert.equal(of(run,'PALLET_EXITED').length,9);assert.equal(run.final.magazines.M1.quantity,5);
  for(const id of ['P4','P5','P6','P7','P8'])assert.equal(of(run,'PALLET_EXITED').filter(e=>e.palletId===id).length,1);
  const retryExits=of(run,'PALLET_EXITED').filter(e=>['P4','P5','P6','P7','P8'].includes(e.palletId));
  assert.deepEqual(retryExits.map(e=>e.palletId),['P4','P5','P6','P7','P8']);
  assert.ok(retryExits[4].timeMs>retryExits[0].timeMs); // Existing pickup events free capacity; no new duration is assumed.
  assert.ok(run.snapshots.every(s=>s.lines.L1.length<=2));assert.deepEqual(run.events,simulate(scenario).events);
});
test('ordinary external production capacity overflow remains fatal rather than being silently deferred',()=>{
  const scenario=fixture({lineCapacity:1,productionEvents:[event(0,'P1'),event(0,'P2')]});
  assert.throws(()=>simulate(scenario),/line buffer overflow/);
});
test('unknown recovery policy is rejected instead of silently defaulting',()=>{
  assert.throws(()=>simulate(fixture({magazineEmptyRecoveryPolicy:'guess'})),/PRODUCTION_CONFIG/);
});
test('next-takt recovery starts only a new due attempt; unset recovery never silently resumes the line',()=>{
  const productionEvents=[...Array.from({length:5},(_,i)=>event(i*1000,'P'+i)),event(900000,'P5')];
  const run=simulate(fixture({magazines:[magazine(4)],aligners:[{id:'AL1',quantity:10}],productionEvents,magazineEmptyRecoveryPolicy:'next_takt'}));
  assert.equal(of(run,'PALLET_EXITED').filter(e=>e.palletId==='P4').length,0);
  assert.equal(of(run,'PALLET_EXITED').filter(e=>e.palletId==='P5').length,1);assert.equal(run.final.magazines.M1.quantity,9);
  const unset=simulate({...run.scenario,magazineEmptyRecoveryPolicy:null});
  assert.equal(of(unset,'PALLET_EXITED').filter(e=>e.palletId==='P5').length,0);
  assert.equal(of(unset,'PRODUCTION_BLOCKED_RECOVERY_POLICY').length,1);assert.equal(unset.final.magazines.M1.quantity,10);
  assert.equal(unset.final.productionStatus.L1.reason,'RECOVERY_POLICY_UNSET');
});
test('duplicate production IDs and a non-ten refill batch fail closed',()=>{
  assert.throws(()=>simulate(fixture({productionEvents:[event(0,'P1'),event(1,'P1')]})),/duplicate/);
  assert.throws(()=>simulate(fixture({magazines:[magazine(0)],productionEvents:[event(0,'P1'),event(1,'P1')]})),/duplicate/);
  assert.throws(()=>simulate(fixture({magazines:[magazine(4,{refillBatch:20,capacity:40})],productionEvents:[event(0,'P1')]})),/ten|10|batch/);
});
test('a consumed aligner stack cannot be automatically reused for another magazine',()=>{
  const run=simulate(fixture({magazines:[magazine(4),{...magazine(4),id:'M2'}],aligners:[{id:'AL1',quantity:10}],
    lineMagazineMap:{...syntheticTestMapping,L2:'M2'},productionEvents:[event(0,'P1'),event(600000,'P2','L2')]}));
  assert.equal(requests(run,'03').length,1);assert.equal(run.final.magazines.M2.refillNeeded,true);
  assert.equal(run.final.aligners.AL1.quantity,0);assert.equal(run.final.magazines.M2.quantity,3);
});
test('empty-pallet conservation holds across supplies, two manual refills and all saved snapshots',()=>{
  const scenario=fixture({durationMin:40,magazines:[magazine(4)],aligners:[{id:'AL1',quantity:10}],
    productionEvents:Array.from({length:18},(_,i)=>event(i*120000,'P'+i)),
    alignerRefillEvents:[{timeMs:1000000,alignerId:'AL1',operationType:'individual'},{timeMs:2000000,alignerId:null,operationType:'all'}],
    magazineEmptyRecoveryPolicy:'next_takt'});
  const run=simulate(scenario),issued=of(run,'EMPTY_PALLET_DISCHARGED').length,refills=of(run,'MAGAZINE_REFILLED').length;
  assert.equal(run.final.magazines.M1.quantity,4-issued+10*refills);
  assert.equal(run.final.aligners.AL1.quantity,10+10*of(run,'ALIGNER_REFILLED').length-10*of(run,'ALIGNER_STACK_PICKED').length);
  assert.ok(run.snapshots.every(s=>Object.values(s.magazines).every(m=>m.quantity>=0)&&Object.values(s.aligners).every(a=>[0,10].includes(a.quantity)&&a.ready===(a.quantity===10))));
});
test('legacy external pallet fixture does not silently consume a magazine',()=>{
  const scenario=fixture({productionModel:undefined,lineMagazineMap:undefined,productionEvents:[event(0,'P1')]});
  const run=simulate(scenario);assert.equal(run.final.magazines.M1.quantity,10);assert.equal(of(run,'EMPTY_PALLET_DISCHARGED').length,0);
});
