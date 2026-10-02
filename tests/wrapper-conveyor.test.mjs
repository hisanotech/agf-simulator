import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {createLegacyScenario} from '../src/ui/scenario.mjs';

function conveyorScenario(){
  const s=createLegacyScenario('standard');s.durationMin=5;
  delete s.lineIntervalsMin;delete s.lineOffsetsMin;
  s.wrapper={inputCapacity:1,outputCapacity:1,conveyorCapacity:5};
  s.times={...s.times,emptyMin:.001,loadedMin:.001,pickupMin:.001,dropoffMin:.001,wrapMin:.1,labelMin:.02,exitMin:.02};
  s.warehouse.forEach(slot=>slot.permission=false);
  s.productionEvents=Array.from({length:8},(_,i)=>({timeMs:0,lineId:'L'+(i+1),palletId:'SYN-CONVEYOR-'+i,
    destinationLocationId:s.generatedDestinationIds[i]}));
  s.magazineUses=[];s.alignerReadyEvents=[];s.manualRequests=[];s.temporaryPallets=[];
  return s;
}
test('internal five-pallet conveyor and single-pallet input/output remain separate bounded inventories',()=>{
  const r=simulate(conveyorScenario());
  assert.ok(r.snapshots.some(s=>s.wrapper.conveyor.length===5));
  for(const s of r.snapshots){
    assert.ok(s.wrapper.input.length<=1);assert.ok(s.wrapper.output.length<=1);assert.ok(s.wrapper.conveyor.length<=5);
    const all=[...s.wrapper.input,...s.wrapper.output,...s.wrapper.conveyor];
    assert.equal(new Set(all).size,all.length);
    if(s.wrapper.processing)assert.ok(s.wrapper.conveyor.includes(s.wrapper.processing));
  }
  assert.equal(r.final.wrapper.output.length,1);assert.equal(r.final.wrapper.conveyor.length,5);
  assert.ok(r.events.some(e=>e.type==='WRAPPER_EXIT_WAITING'));
  let processing=null;
  for(const e of r.events){
    if(e.type==='WRAP_STARTED'){assert.equal(processing,null);processing=e.palletId;}
    if(e.type==='WRAP_COMPLETED'){assert.equal(processing,e.palletId);processing=null;}
  }
  assert.deepEqual(simulate(conveyorScenario()).events,r.events);
});
test('a released outlet advances ready internal pallets and frees conveyor admission without additional transfer time',()=>{
  const s=conveyorScenario();s.permissionEvents=s.warehouse.map(slot=>({timeMs:120000,target:'warehouse',targetId:slot.id,permitted:true}));
  const r=simulate(s);
  assert.equal(r.metrics.stored,8);assert.equal(r.final.wrapper.conveyor.length,0);
  assert.equal(r.events.filter(e=>e.type==='WRAPPER_CONVEYOR_ACCEPTED').length,8);
  for(const e of r.events.filter(e=>e.type==='EXIT_READY')){
    const label=r.events.find(x=>x.type==='LABEL_COMPLETED'&&x.palletId===e.palletId);
    assert.ok(label.sequence<e.sequence);
  }
});
test('invalid conveyor capacity is rejected before equipment or transport state changes',()=>{
  for(const invalid of [0,-1,1.5]){
    const s=conveyorScenario();s.wrapper.conveyorCapacity=invalid;
    assert.throws(()=>simulate(s),/conveyor capacity/);
  }
});
