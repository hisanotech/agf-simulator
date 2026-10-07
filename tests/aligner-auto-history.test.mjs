import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTransportHistoryRows,transportHistoryCells,renderTransportHistoryRows} from '../src/ui/transport-history.mjs';
import {transportHistoryCsv} from '../src/ui/customer-export.mjs';
import {eventCsv} from '../src/ui/export.mjs';
import {customerConditionRows,renderCustomerConditions} from '../src/ui/customer-conditions.mjs';
import {customerConditionsCsv} from '../src/ui/customer-export.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';

// Saved synthetic events: confirmed trigger, provisional zero-duration timing.
const fixture=()=>{
  const metadata={timeMs:60000,operationType:'all',automatic:true,policy:'all_empty_auto',trigger:'all_empty',
    evidence:'user-confirmed-all-empty-auto',timingEvidence:'provisional-same-timestamp-event'};
  const events=[{...metadata,type:'ALIGNER_REFILL_OPERATED',sequence:0,targetIds:['AL1','AL2','AL3','AL4','AL5']},
    ...Array.from({length:5},(_,i)=>({...metadata,type:'ALIGNER_REFILLED',sequence:i+1,alignerId:'AL'+(i+1),
      quantityBefore:0,quantityAfter:10,operatedAt:60000}))];
  return {runId:'SYN-AUTO-HISTORY',scenario:{mode:'area_first',battery:{consumptionModel:'per_task'}},events,
    snapshots:events.map(()=>({tasks:[],agfs:[]})),final:{tasks:[]}};
};

test('automatic aligner loading has Japanese causal and provisional timing explanations in history and customer CSV',()=>{
  const run=fixture(),rows=buildTransportHistoryRows(run);
  assert.equal(rows.length,6);
  assert.equal(rows[0].content,'整列機全機自動装填');
  assert.equal(rows[0].location,'整列機 全機');
  assert.match(rows[0].reason,/整列機5台がすべて0枚/);
  assert.match(rows[0].detail,/全5台を各10枚へ/);
  for(const row of rows.slice(1)){
    assert.equal(row.content,'整列機自動装填');assert.match(row.detail,/0→10 枚/);
    assert.match(row.reason,/整列機5台がすべて0枚/);
  }
  for(const row of rows){
    assert.match(row.detail,/装填時間未確定/);assert.match(row.detail,/同一時刻の暫定モデル/);
    assert.doesNotMatch(row.content,/手動/);assert.equal(transportHistoryCells(row).length,11);
  }
  assert.match(transportHistoryCsv(run),/整列機全機自動装填/);
  assert.match(renderTransportHistoryRows(rows),/整列機自動装填/);
});

test('automatic loading detailed CSV preserves automatic trigger and timing evidence without relabeling manual history',()=>{
  const run=fixture(),csv=eventCsv(run,run.runId),headers=csv.slice(1).split('\r\n')[0].split(',');
  for(const field of ['automatic','trigger','timingEvidence'])assert.ok(headers.includes(field),field);
  assert.match(csv,/provisional-same-timestamp-event/);
  run.events=run.events.map(({automatic,trigger,policy,evidence,timingEvidence,...event})=>event);
  const rows=buildTransportHistoryRows(run);
  assert.equal(rows[0].content,'整列機補充操作');assert.equal(rows[1].content,'整列機手動補充');
  assert.equal(rows[1].detail,'0→10 枚');assert.equal(rows[0].reason,'－');
});

test('ordinary result conditions and customer CSV disclose the saved automatic rule and unresolved reload duration',()=>{
  const input=createDemoScenario(),run={scenario:structuredClone(input)};
  input.alignerRefillPolicy='manual';
  const rows=customerConditionRows(run),policy=rows.find(r=>r.key==='aligner.refillPolicy'),timing=rows.find(r=>r.key==='aligner.refillTiming');
  assert.match(policy?.value??'',/全5台が0枚.*全機10枚/);
  assert.match(policy.evidence,/ユーザー確認済み/);
  assert.match(timing?.value??'',/装填時間未確定/);assert.match(timing.evidence,/同一時刻.*暫定/);
  assert.match(renderCustomerConditions(run),/全5台が0枚/);
  assert.match(customerConditionsCsv(run),/全5台が0枚/);
  run.scenario.alignerRefillPolicy='manual';
  const manual=customerConditionRows(run);
  assert.equal(manual.find(r=>r.key==='aligner.refillPolicy').value,'手動補充');
  assert.equal(manual.some(r=>r.key==='aligner.refillTiming'),false);
});
