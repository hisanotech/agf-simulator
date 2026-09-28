import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {analyzeRun} from '../src/ui/replay-model.mjs';

function scenario(kind){
  const s=createDemoScenario('physical');s.durationMin=180;s.lineIntervalsMin=Array(8).fill(0);
  if(kind==='05')s.manualRequests=[{timeMs:0,kind,palletId:'SIM-TEMP-1',locationId:'OT1',
    destinationLocationId:s.generatedDestinationIds[0],storagePermission:true}];
  else {s.aligners[0].ready=true;s.magazineUses=[{timeMs:0,magazineId:'M1'}];}
  return s;
}

for(const kind of ['05','03'])test(`synthetic ${kind} permission loss holds its load and reservations until recovery`,()=>{
  const s=scenario(kind),baseline=simulate(s),task=baseline.final.tasks[0];
  const dropAt=task.completedAt,recoveryAt=dropAt+60000;
  const target=kind==='05'?'warehouse':'magazine',targetId=task.destinationId;
  s.permissionEvents=[{timeMs:dropAt-1,target,targetId,permitted:false},
    {timeMs:recoveryAt,target,targetId,permitted:true}];
  const original=structuredClone(s),run=simulate(s),held=run.events.find(e=>e.type==='TASK_WAITING'&&
    e.reason===(kind==='05'?'LOCATION_PERMISSION':'MAGAZINE_PERMISSION'));
  assert.ok(held);
  const snap=run.snapshots[held.sequence],agf=snap.agfs.find(a=>a.id===task.agfId);
  assert.ok(agf.carriedPalletId);assert.equal(snap.tasks[0].status,'wait_drop');
  if(kind==='05'){
    assert.deepEqual(snap.warehouse[targetId].reserved,['SIM-TEMP-1']);
    assert.equal(snap.warehouse[targetId].palletIds.length,0);
  }
  assert.equal(run.final.tasks[0].completedAt,recoveryAt);
  assert.equal(analyzeRun(run).dropWaitMs,60000);
  assert.equal(run.events.filter(e=>e.type==='TASK_DROPPED').length,1);
  assert.equal(run.events.filter(e=>e.type==='EQUIPMENT_PERMISSION_CHANGED').length,2);
  assert.equal(run.final.agfs.find(a=>a.id===task.agfId).batteryPct,baseline.final.agfs.find(a=>a.id===task.agfId).batteryPct);
  assert.deepEqual(simulate(s).events,run.events);assert.deepEqual(s,original);
});

test('invalid equipment permission targets and nonboolean states fail before simulation',()=>{
  for(const event of [
    {target:'warehouse',targetId:'missing',permitted:true},
    {target:'magazine',targetId:'M1',permitted:'false'},
    {target:'wrapper',targetId:'WRAPPER',permitted:false}
  ]){const s=scenario('05');s.permissionEvents=[{timeMs:0,...event}];
    assert.throws(()=>simulate(s),/permission event/);}
});
