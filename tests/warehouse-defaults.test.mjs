import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {syntheticWarehousePolicy} from '../examples/synthetic-warehouse-policy.mjs';
import {validateWarehousePolicy} from '../src/core/warehouse-policy.mjs';
import {createInitialPreview} from '../src/ui/run-input.mjs';

for(const preset of ['standard','extended'])test(`${preset} starts with the user-requested example row allocation and no product inventory`,()=>{
  const scenario=createDemoScenario(preset),example=syntheticWarehousePolicy();
  assert.deepEqual(scenario.warehousePolicy.rowAssignments,example.rowAssignments);
  assert.deepEqual(scenario.warehousePolicy.rowPriority,example.rowPriority);
  assert.equal(scenario.warehousePolicy.evidence,'user-requested-example-default');
  assert.doesNotThrow(()=>validateWarehousePolicy(scenario.warehousePolicy,scenario.warehouse,
    {lineIds:Array.from({length:8},(_,i)=>'L'+(i+1)),specialEnabled:true}));
  assert.equal(scenario.warehouse.length,802);
  assert.ok(scenario.warehouse.every(slot=>slot.palletIds.length===0));
  const preview=createInitialPreview(scenario);
  assert.deepEqual(preview.scenario.warehousePolicy,scenario.warehousePolicy);
  assert.ok(preview.final.tasks.length===0&&preview.final.pallets.length===0);
  // The supply mapping was subsequently confirmed, but recovery is still unresolved.
  assert.deepEqual(scenario.lineMagazineMap,{L1:'M4',L2:'M4',L3:'M5',L4:'M3',L5:'M2',L6:'M5',L7:'M2',L8:'M1'});
  assert.equal(scenario.magazineEmptyRecoveryPolicy,null);
});

test('editing a default row allocation cannot mutate the example or the next scenario',()=>{
  const edited=createDemoScenario();edited.warehousePolicy.rowAssignments.pop();
  edited.warehousePolicy.rowPriority.L1.reverse();
  const fresh=createDemoScenario(),example=syntheticWarehousePolicy();
  assert.deepEqual(fresh.warehousePolicy.rowAssignments,example.rowAssignments);
  assert.deepEqual(fresh.warehousePolicy.rowPriority,example.rowPriority);
});
