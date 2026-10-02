import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {configuredNeutralScenario} from './fixtures/neutral-scenario.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {analyzeRun,durationTenths} from '../src/ui/replay-model.mjs';
import {warehouseRowOwner} from '../src/core/warehouse-policy.mjs';

const digest=events=>createHash('sha256').update(JSON.stringify(events)).digest('hex');
const sum=items=>items.reduce((n,value)=>n+value,0);
function initialAssertions(run){
  const initial=run.snapshots[0];
  assert.equal(run.scenario.durationMin,180);
  assert.equal(run.scenario.productionModel,'empty_pallet_supply');
  assert.equal(run.scenario.evidence.lineMagazineMap,'synthetic-test-mapping');
  assert.equal(initial.tasks.length,0);assert.equal(initial.pallets.length,0);
  assert.equal(initial.temporaryPallets.length,0);
  assert.deepEqual(initial.wrapper.input,[]);assert.deepEqual(initial.wrapper.output,[]);
  assert.equal(initial.wrapper.processing,null);
  assert.ok(Object.values(initial.lines).every(ids=>ids.length===0));
  assert.ok(Object.values(initial.warehouse).every(s=>s.palletIds.length===0&&s.reserved.length===0));
  assert.ok(Object.values(initial.magazines).every(m=>m.quantity===10&&!m.pending&&!m.refillNeeded));
  assert.ok(Object.values(initial.aligners).every(a=>a.quantity===10&&a.ready&&!a.reservedTaskId));
  assert.deepEqual(initial.agfs.map(a=>a.currentNodeId),['CHARGE-PLACE1','CHARGE-PLACE2','HP1','HP2']);
  assert.ok(initial.agfs.every(a=>a.status==='idle'&&a.batteryPct===100&&a.chargerId===null));
  assert.ok(Object.values(initial.chargers).every(a=>a===null));
}
function flowAssertions(run){
  const exits=run.events.filter(e=>e.type==='PALLET_EXITED');assert.ok(exits.length>0);
  for(const exit of exits){
    const empty=run.events.filter(e=>e.type==='EMPTY_PALLET_DISCHARGED'&&e.palletId===exit.palletId);
    const palletized=run.events.find(e=>e.type==='PALLETIZED'&&e.palletId===exit.palletId);
    const request=run.events.find(e=>e.type==='TASK_REQUESTED'&&e.kind==='01'&&e.palletId===exit.palletId);
    assert.equal(empty.length,1);assert.ok(palletized&&request);
    assert.equal(empty[0].quantityBefore-empty[0].quantityAfter,1);
    assert.equal(empty[0].magazineId,run.scenario.lineMagazineMap[exit.lineId]);
    assert.equal(empty[0].timeMs,exit.timeMs);assert.equal(palletized.timeMs,exit.timeMs);
    assert.equal(request.timeMs,exit.timeMs);
    assert.ok(empty[0].sequence<palletized.sequence&&palletized.sequence<exit.sequence&&exit.sequence<request.sequence);
  }
  for(const input of run.scenario.magazines){
    const consumed=run.events.filter(e=>e.type==='EMPTY_PALLET_DISCHARGED'&&e.magazineId===input.id).length;
    const supplied=sum(run.events.filter(e=>e.type==='MAGAZINE_REFILLED'&&e.magazineId===input.id).map(e=>e.quantityAfter-e.quantityBefore));
    assert.equal(run.final.magazines[input.id].quantity,input.quantity-consumed+supplied);
  }
  for(const initial of run.scenario.aligners){
    const picked=run.events.filter(e=>e.type==='ALIGNER_STACK_PICKED'&&e.alignerId===initial.id).length;
    assert.equal(run.final.aligners[initial.id].quantity,initial.quantity-picked*10);
  }
  for(const event of run.events.filter(e=>e.type==='TASK_REQUESTED'&&e.kind==='03')){
    const task=run.snapshots[event.sequence].tasks.find(t=>t.id===event.taskId);
    const source=run.snapshots[event.sequence].aligners[task.alignerId];
    assert.equal(source.quantity,10);assert.equal(source.reservedTaskId,task.id);
    assert.ok(run.snapshots[event.sequence].magazines[task.magazineId].refillNeeded);
  }
}
function capacityAssertions(run){
  const warehouseOwners=new Map(run.scenario.warehousePolicy.rowAssignments.map(a=>[a.rowId,warehouseRowOwner(a)]));
  for(const snapshot of run.snapshots){
    assert.ok(snapshot.wrapper.input.length<=run.scenario.wrapper.inputCapacity);
    assert.ok(snapshot.wrapper.output.length<=run.scenario.wrapper.outputCapacity);
    assert.ok(Object.values(snapshot.chargers).filter(Boolean).length<=2);
    const reservations=Object.values(snapshot.aligners).map(a=>a.reservedTaskId).filter(Boolean);
    assert.equal(new Set(reservations).size,reservations.length);
    assert.ok(Object.values(snapshot.aligners).every(a=>[0,10].includes(a.quantity)&&a.ready===(a.quantity>=10)));
    assert.ok(Object.values(snapshot.magazines).every(m=>m.quantity>=0&&m.quantity<=m.capacity));
    for(const slot of Object.values(snapshot.warehouse))assert.ok(slot.palletIds.length+slot.reserved.length<=slot.capacity);
  }
  for(const event of run.events.filter(e=>e.type==='STORE_COMPLETED')){
    const slot=run.final.warehouse[event.locationId],p=run.final.pallets.find(p=>p.palletId===event.palletId);
    assert.equal(warehouseOwners.get(slot.rowId),p.productType==='special'?'SPECIAL':p.sourceLineId);
    assert.notEqual(warehouseOwners.get(slot.rowId),'UNASSIGNED');
    assert.ok(!(slot.blockId.startsWith('EB')&&slot.column===10));
  }
  const data=analyzeRun(run);assert.equal(data.storage.theoretical,802);
  for(const a of data.agfs){
    assert.equal(sum(Object.values(a.durations)),180*60000);
    assert.equal(sum(Object.values(durationTenths(a.durations))),180*10);
  }
}

for(const mode of ['area_first','low_battery_first']){
  test(`neutral 3-hour ${mode} run preserves empty start, causal supply, all capacities and determinism`,()=>{
    const scenario=configuredNeutralScenario();scenario.mode=mode;
    const before=structuredClone(scenario),run=simulate(scenario);
    initialAssertions(run);flowAssertions(run);capacityAssertions(run);
    assert.equal(run.events[0].type,'RUN_STARTED');assert.equal(run.events.at(-1).timeMs,180*60000);
    assert.deepEqual(scenario,before);assert.equal(digest(run.events),digest(simulate(scenario).events));
  });
}

test('neutral 3-hour supply boundary with all aligners empty records blocked production without a 03 task',()=>{
  const scenario=configuredNeutralScenario();scenario.aligners.forEach(a=>a.quantity=0);
  const run=simulate(scenario),blocked=run.events.filter(e=>e.type==='PRODUCTION_BLOCKED_EMPTY_PALLET');
  assert.ok(blocked.length>0);assert.equal(run.final.tasks.filter(t=>t.kind==='03').length,0);
  assert.equal(run.events.filter(e=>e.type==='ALIGNER_RESERVED').length,0);
  assert.ok(Object.values(run.final.magazines).some(m=>m.refillNeeded&&!m.pending));
  for(const event of blocked){
    assert.ok(!run.events.some(e=>e.type==='PALLET_EXITED'&&e.palletId===event.plannedPalletId));
    assert.ok(!run.final.pallets.some(p=>p.palletId===event.plannedPalletId));
    assert.ok(!run.final.tasks.some(t=>t.palletId===event.plannedPalletId));
    assert.equal(event.quantity,0);
  }
  capacityAssertions(run);assert.equal(digest(run.events),digest(simulate(scenario).events));
});

test('partial warehouse allocation retains 802 physical slots and stores only in explicitly owned rows for 3 hours',()=>{
  const scenario=configuredNeutralScenario(),seen=new Set();
  scenario.warehousePolicy.rowAssignments=scenario.warehousePolicy.rowAssignments.filter(a=>{
    const owner=warehouseRowOwner(a);if(seen.has(owner))return false;seen.add(owner);return true;
  });
  scenario.warehousePolicy.rowPriority=Object.fromEntries(scenario.warehousePolicy.rowAssignments.map(a=>[warehouseRowOwner(a),[a.rowId]]));
  const run=simulate(scenario),data=analyzeRun(run);capacityAssertions(run);flowAssertions(run);
  assert.equal(data.storage.theoretical,802);assert.ok(data.storage.assignedCapacity<802);
  assert.equal(data.storage.unassignedCapacity,802-data.storage.assignedCapacity);
  const assigned=new Set(scenario.warehousePolicy.rowAssignments.map(a=>a.rowId));
  assert.ok(Object.values(run.final.warehouse).filter(s=>!assigned.has(s.rowId)).every(s=>s.palletIds.length===0&&s.reserved.length===0));
});
