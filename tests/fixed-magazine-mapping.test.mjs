import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoScenario,CONFIRMED_LINE_MAGAZINE_MAP} from '../src/ui/scenario.mjs';
import {lineMagazineMapFromSettings,renderSupplySettings} from '../src/ui/extended-settings.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {buildRunConditions} from '../src/ui/run-conditions.mjs';
import {customerConditionRows} from '../src/ui/customer-conditions.mjs';
import {conditionCsv,eventCsv} from '../src/ui/export.mjs';
import {customerConditionsCsv} from '../src/ui/customer-export.mjs';

// User-confirmed equipment correspondence; travel coordinates/times remain synthetic.
const confirmed={L1:'M4',L2:'M4',L3:'M5',L4:'M3',L5:'M2',L6:'M5',L7:'M2',L8:'M1'};
function onePalletPerLine(){
  const s=createDemoScenario();s.durationMin=1;
  delete s.productStreams;s.lineIntervalsMin=Array(8).fill(0);
  s.productionEvents=Object.keys(confirmed).map((lineId,i)=>({timeMs:i*1000,lineId,palletId:'TEST-'+lineId}));
  return s;
}

test('all eight lines consume their confirmed magazine exactly once, including shared supply',()=>{
  const run=simulate(onePalletPerLine());
  const discharge=run.events.filter(e=>e.type==='EMPTY_PALLET_DISCHARGED');
  assert.equal(discharge.length,8);
  assert.deepEqual(Object.fromEntries(discharge.map(e=>[e.lineId,e.magazineId])),confirmed);
  assert.deepEqual(Object.fromEntries(Object.entries(run.final.magazines).map(([id,m])=>[id,m.quantity])),
    {M1:9,M2:8,M3:9,M4:8,M5:8});
  for(const e of discharge){
    assert.equal(e.quantityBefore-e.quantityAfter,1);
    const causal=run.events.filter(x=>x.palletId===e.palletId&&['EMPTY_PALLET_DISCHARGED','PALLETIZED','PALLET_EXITED','TASK_REQUESTED'].includes(x.type));
    assert.deepEqual(causal.map(x=>x.type),['EMPTY_PALLET_DISCHARGED','PALLETIZED','PALLET_EXITED','TASK_REQUESTED']);
    assert.equal(causal.at(-1).kind,'01');
    assert.ok(causal.every(x=>x.timeMs===e.timeMs));
    assert.ok(causal.slice(1).every((x,i)=>x.sequence>causal[i].sequence));
  }
  assert.equal(run.events.filter(e=>e.type==='MAGAZINE_USED').length,0);
});

test('empty shared M4 blocks only its dependent lines and never falls back to another magazine',()=>{
  const s=onePalletPerLine();s.magazines.find(m=>m.id==='M4').quantity=0;
  const run=simulate(s),blocked=run.events.filter(e=>e.type==='PRODUCTION_BLOCKED_EMPTY_PALLET');
  assert.deepEqual(blocked.map(e=>e.lineId),['L1','L2']);
  assert.equal(run.final.magazines.M4.quantity,0);
  assert.equal(run.events.filter(e=>e.type==='PALLET_EXITED').length,6);
  assert.ok(run.events.filter(e=>e.type==='TASK_REQUESTED'&&e.kind==='01').every(e=>!['TEST-L1','TEST-L2'].includes(e.palletId)));
});

test('fixed supply settings display the eight confirmed values without allowing edits',()=>{
  const s=createDemoScenario(),html=renderSupplySettings(s);
  assert.match(html,/ユーザー確認済み.*固定対応/);
  for(const [id,magazineId] of Object.entries(confirmed)){
    const select=html.match(new RegExp(`<select[^>]*data-line-magazine="${id}"[^>]*>[\\s\\S]*?</select>`))?.[0];
    assert.ok(select,id+' must remain visible');assert.match(select,/disabled/);
    assert.match(select,new RegExp(`<option value="${magazineId}" selected>マガジン${magazineId.slice(1)}（${magazineId}）</option>`));
  }
  assert.match(html,/未設定 · 補充後も生産保留/);
  assert.equal(s.magazineEmptyRecoveryPolicy,null);
});

test('saving fixed settings ignores altered magazine controls and makes an independent copy',()=>{
  const s=createDemoScenario(),edited=Object.fromEntries(Object.keys(confirmed).map(id=>[id,'M1']));
  const saved=lineMagazineMapFromSettings(s,edited);
  assert.deepEqual(saved,confirmed);
  saved.L1='M2';
  assert.deepEqual(s.lineMagazineMap,confirmed);
  assert.deepEqual(CONFIRMED_LINE_MAGAZINE_MAP,confirmed);
  assert.deepEqual(createDemoScenario('extended').lineMagazineMap,confirmed);
});

test('explicit synthetic fixture correspondence remains available without changing the ordinary Run',()=>{
  const s=createDemoScenario();s.lineMagazineMapPolicy='scenario';
  const synthetic=Object.fromEntries(Object.keys(confirmed).map(id=>[id,'M1']));
  assert.deepEqual(lineMagazineMapFromSettings(s,synthetic),synthetic);
  assert.doesNotMatch(renderSupplySettings(s),/<select[^>]*data-line-magazine="L1"[^>]*disabled/);
  assert.deepEqual(createDemoScenario().lineMagazineMap,confirmed);
});

test('saved conditions and both conditions CSVs retain confirmed mapping evidence independently of later edits',()=>{
  const scenario=onePalletPerLine(),run=simulate(scenario);
  run.runId='FIXED-MAPPING-TEST';
  const before=customerConditionRows(run);
  scenario.lineMagazineMap.L1='M1';
  assert.deepEqual(customerConditionRows(run),before);
  const rows=buildRunConditions(run),csv=conditionCsv(run),customerCsv=customerConditionsCsv(run);
  assert.equal(rows.find(r=>r.category==='PRODUCTION'&&r.subkey==='lineMagazineMapPolicy').value,'fixed');
  for(const [id,magazineId] of Object.entries(confirmed)){
    const raw=rows.find(r=>r.category==='PRODUCTION'&&r.key===id&&r.subkey==='magazineId');
    assert.equal(raw.value,magazineId);assert.equal(raw.evidence,'user-confirmed-fixed-magazine-mapping');
    const row=before.find(r=>r.key==='line.'+id+'.magazine');
    assert.equal(row.value,'マガジン'+magazineId.slice(1));assert.equal(row.evidence,'ユーザー確認済み・固定対応');
    assert.ok(csv.includes(`PRODUCTION,${id},magazineId,${magazineId},user-confirmed-fixed-magazine-mapping`));
    assert.ok(customerCsv.includes(`使用マガジン,${row.target},${row.value},,ユーザー確認済み・固定対応`));
  }
  assert.equal(csv.charCodeAt(0),0xfeff);assert.equal(customerCsv.charCodeAt(0),0xfeff);
  const events=eventCsv(run,run.runId);
  assert.ok(events.includes('EMPTY_PALLET_DISCHARGED'));
  assert.notEqual(csv,events);
  assert.equal(run.scenario.magazineEmptyRecoveryPolicy,null);
});
