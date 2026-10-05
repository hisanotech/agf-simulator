import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {configuredNeutralScenario} from './fixtures/neutral-scenario.mjs';
for(const preset of ['standard','extended'])test(`${preset} uses the confirmed fixed magazine map while recovery remains unset`,()=>{
  const s=createDemoScenario(preset);
  assert.equal(s.productionModel,'empty_pallet_supply');
  assert.deepEqual(Object.keys(s.lineMagazineMap),Array.from({length:8},(_,i)=>'L'+(i+1)));
  assert.deepEqual(s.lineMagazineMap,{L1:'M4',L2:'M4',L3:'M5',L4:'M3',L5:'M2',L6:'M5',L7:'M2',L8:'M1'});
  assert.equal(s.lineMagazineMapPolicy,'fixed');
  assert.equal(s.evidence.lineMagazineMap,'user-confirmed-fixed-magazine-mapping');
  assert.equal(s.magazineEmptyRecoveryPolicy,null);
  assert.equal(s.magazineUses.length,0);
  s.durationMin=1;
  assert.doesNotThrow(()=>simulate(s));
});

test('a missing or unknown magazine still prevents an ordinary Run after the mapping is confirmed',()=>{
  for(const value of [undefined,'M404']){
    const s=createDemoScenario();s.durationMin=1;s.lineMagazineMap.L8=value;
    assert.throws(()=>simulate(s),/PRODUCTION_CONFIG/);
  }
});
test('ordinary Run begins with neutral equipment and stop occupancy, never charged fixture stock',()=>{
  const s=configuredNeutralScenario();s.durationMin=1;
  const r=simulate(s),initial=r.snapshots[0];
  assert.equal(initial.tasks.length,0);assert.equal(initial.temporaryPallets.length,0);
  assert.ok(Object.values(initial.lines).every(x=>x.length===0));
  assert.deepEqual(initial.wrapper.input,[]);assert.deepEqual(initial.wrapper.output,[]);
  assert.equal(initial.wrapper.processing,null);
  assert.ok(Object.values(initial.warehouse).every(x=>x.palletIds.length===0&&x.reserved.length===0));
  assert.deepEqual(Object.values(initial.magazines).map(m=>m.quantity),[10,10,10,10,10]);
  assert.ok(Object.values(initial.magazines).every(m=>!m.pending&&!m.refillNeeded));
  assert.deepEqual(Object.values(initial.aligners).map(a=>a.quantity),[10,10,10,10,10]);
  assert.ok(Object.values(initial.aligners).every(a=>a.ready&&!a.reservedTaskId));
  assert.ok(Object.values(initial.chargers).every(x=>x===null));
  assert.deepEqual(initial.agfs.map(a=>a.currentNodeId),['CHARGE-PLACE1','CHARGE-PLACE2','HP1','HP2']);
  assert.ok(initial.agfs.every(a=>a.batteryPct===100&&a.status==='idle'&&a.chargerId===null));
  assert.equal(r.metrics.created,0);
});
