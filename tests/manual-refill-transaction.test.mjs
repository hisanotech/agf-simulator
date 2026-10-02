import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {configuredNeutralScenario} from './fixtures/neutral-scenario.mjs';
import {appendRunInput,createInitialPreview} from '../src/ui/run-input.mjs';

test('manual refill is appended at displayed time and does not mutate saved Run or initial inventory',()=>{
  const s=configuredNeutralScenario();s.durationMin=1;s.aligners[2].quantity=0;
  const old=simulate(s),before=structuredClone(old.scenario);
  const next=appendRunInput(old,'alignerRefillEvents',{timeMs:30000,alignerId:'AL3',operationType:'individual'});
  assert.deepEqual(old.scenario,before);assert.equal(old.final.aligners.AL3.quantity,0);
  assert.equal(next.final.aligners.AL3.quantity,10);
  assert.equal(next.scenario.aligners[2].quantity,0);
  assert.equal(next.scenario.alignerRefillEvents[0].timeMs,30000);
});
test('failed refill re-simulation leaves old result and event inputs intact',()=>{
  const s=configuredNeutralScenario();s.durationMin=1;const old=simulate(s);
  const before=structuredClone(old);
  assert.throws(()=>appendRunInput(old,'alignerRefillEvents',{timeMs:30000,alignerId:'MISSING',operationType:'individual'}));
  assert.deepEqual(old,before);
});
test('unconfigured initial preview is explicitly not a calculated Run and does not guess the magazine mapping',()=>{
  const s=configuredNeutralScenario();s.lineMagazineMap.L1=null;
  const before=structuredClone(s),preview=createInitialPreview(s);
  assert.equal(preview.previewOnly,true);assert.deepEqual(s,before);
  assert.equal(preview.snapshots[0].tasks.length,0);
  assert.equal(preview.scenario.lineMagazineMap.L1,null);
  assert.deepEqual(Object.values(preview.snapshots[0].magazines).map(m=>m.quantity),[10,10,10,10,10]);
});
