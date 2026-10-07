import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTransportHistoryRows,transportHistoryCells,TRANSPORT_HISTORY_COLUMNS,renderTransportHistoryRows} from '../src/ui/transport-history.mjs';
import {transportHistoryCsv} from '../src/ui/customer-export.mjs';

// These saved decision records are synthetic fixtures, not operating records.
const headers=['発生時刻','履歴区分','搬送No.','搬送パターン','パレットID','系列','AGF','発生場所','状態・内容','理由','詳細'];
function decision(overrides={}){
  return {mode:'area_first',destinationArea:'PZ',selectedArea:'PZ',selectedAgfId:'AGF2',selectedBatteryPct:60,
    reservePct:40,fallback:'wait',basis:'destination_area',eligibleAgfIds:['AGF1','AGF2','AGF3'],
    candidates:[{agfId:'AGF2',area:'PZ',batteryPct:60},{agfId:'AGF3',area:'PZ',batteryPct:80}],
    tieBreak:'none',tieBreakEvidence:null,...overrides};
}
function fixture(selection=decision()){
  const task={id:'TASK-SYNTHETIC-1',kind:'01',palletId:'SIM-L2-1',sourceLineId:'L2',
    originId:'L2',originArea:'PZ',destinationId:'WRAP-INPUT',destinationArea:'PZ',agfId:'AGF2'};
  const event={type:'TASK_ASSIGNED',timeMs:60000,sequence:0,taskId:task.id,kind:task.kind,agfId:'AGF2',palletId:task.palletId,batteryPct:99};
  if(selection!==null)event.dispatchSelection=selection;
  return {runId:'SYNTHETIC-SELECTION-HISTORY',scenario:{mode:'area_first',crossAreaFallback:'wait',battery:{reservePct:40}},
    events:[event],snapshots:[{tasks:[{...task}],agfs:[{id:'AGF2',area:'WH',batteryPct:10}]}],
    final:{tasks:[{...task}],agfs:[{id:'AGF2',area:'WH',batteryPct:5}]}};
}

test('destination-area selection history explains the local lowest battery and records only the actual comparison pool',()=>{
  const [row]=buildTransportHistoryRows(fixture());
  assert.match(row.reason,/目的地（荷下ろし先）のパレタイズエリアを優先/);
  assert.match(row.reason,/候補内の最低残量AGFを選定/);
  assert.match(row.detail,/^AGF2 \/ 残量60\.0%/);
  assert.match(row.detail,/AGF2（パレタイズエリア・残量60\.0%）/);
  assert.match(row.detail,/AGF3（パレタイズエリア・残量80\.0%）/);
  assert.match(row.detail,/選定条件：残量40\.0%超/);
  assert.doesNotMatch(row.detail,/AGF1|残量99\.0%|残量10\.0%|残量5\.0%/);
  assert.doesNotMatch(row.reason+' '+row.detail,/destination_area|area_first|PZ|WH/);
});

test('cross-area fallback history identifies missing destination candidates and the saved Run choice',()=>{
  const [row]=buildTransportHistoryRows(fixture(decision({destinationArea:'WH',selectedArea:'PZ',fallback:'any',
    basis:'cross_area_fallback'})));
  assert.match(row.reason,/目的地（荷下ろし先）の製品倉庫に候補なし/);
  assert.match(row.reason,/他エリアの候補内で最低残量AGFを選定/);
  assert.match(row.reason,/他エリア選定はこのRunの設定/);
  assert.doesNotMatch(row.reason,/製品倉庫を優先|確認済み|現場規則/);
});

test('comparison mode history explains lowest battery across areas without destination priority',()=>{
  const [row]=buildTransportHistoryRows(fixture(decision({mode:'low_battery_first',basis:'all_areas',
    selectedArea:'WH',candidates:[{agfId:'AGF2',area:'WH',batteryPct:60},{agfId:'AGF3',area:'PZ',batteryPct:80}]})));
  assert.match(row.reason,/エリア優先なし/);
  assert.match(row.reason,/候補内の最低残量AGFを選定/);
  assert.match(row.detail,/AGF2（製品倉庫・残量60\.0%）/);
  assert.match(row.detail,/AGF3（パレタイズエリア・残量80\.0%）/);
  assert.doesNotMatch(row.reason,/目的地.*を優先|他エリア選定/);
});

test('each selection basis distinguishes one executable candidate from a battery comparison',async t=>{
  for(const basis of ['destination_area','cross_area_fallback','all_areas']){
    await t.test(basis,()=>{
      const [row]=buildTransportHistoryRows(fixture(decision({basis,
        mode:basis==='all_areas'?'low_battery_first':'area_first',fallback:basis==='cross_area_fallback'?'any':'wait',
        destinationArea:basis==='cross_area_fallback'?'WH':'PZ',
        candidates:[{agfId:'AGF2',area:'PZ',batteryPct:60}]})));
      assert.match(row.reason,/候補1台を選定/);
      assert.doesNotMatch(row.reason,/最低残量|同残量|ID順/);
    });
  }
});

test('recorded equal-battery ID tie break is labeled a reproducibility assumption',()=>{
  const [row]=buildTransportHistoryRows(fixture(decision({
    candidates:[{agfId:'AGF2',area:'PZ',batteryPct:60},{agfId:'AGF3',area:'PZ',batteryPct:60}],
    tieBreak:'agf_id',tieBreakEvidence:'synthetic-model-tiebreak'})));
  assert.match(row.reason,/同残量はAGF ID順（再現性のための仮定）/);
  assert.doesNotMatch(row.reason,/現場の優先順位|確認済み|正式/);
  assert.doesNotMatch(row.reason+' '+row.detail,/synthetic-model-tiebreak|agf_id/);
});

test('tie-break evidence is required and no tie rule is reconstructed from equal rounded batteries',()=>{
  const undocumented=fixture(decision({tieBreak:'agf_id',tieBreakEvidence:null}));
  assert.match(buildTransportHistoryRows(undocumented)[0].reason,/同残量の選定根拠未記録/);
  assert.doesNotMatch(buildTransportHistoryRows(undocumented)[0].reason,/ID順|再現性のための仮定/);
  const close=fixture(decision({selectedBatteryPct:60.01,
    candidates:[{agfId:'AGF2',area:'PZ',batteryPct:60.01},{agfId:'AGF3',area:'PZ',batteryPct:60.02}]}));
  assert.doesNotMatch(buildTransportHistoryRows(close)[0].reason,/同残量|ID順/);
});

test('saved selection remains authoritative after scenario, task and replay battery changes',()=>{
  const run=fixture(),before=JSON.stringify(run),original=buildTransportHistoryRows(run)[0];
  assert.equal(JSON.stringify(run),before);
  run.scenario.mode='low_battery_first';run.scenario.crossAreaFallback='any';run.scenario.battery.reservePct=90;
  run.final.tasks[0].destinationArea='WH';run.final.agfs[0].batteryPct=100;
  run.snapshots[0].tasks[0].destinationArea='WH';run.snapshots[0].agfs[0].batteryPct=1;
  const changed=buildTransportHistoryRows(run)[0];
  assert.equal(changed.reason,original.reason);
  assert.equal(changed.detail,original.detail);
  assert.match(changed.detail,/残量60\.0%/);
  assert.doesNotMatch(changed.detail,/残量90\.0%|残量100\.0%|残量1\.0%/);
});

test('legacy assignment explicitly reports missing selection reasons and preserves prior detail behavior',()=>{
  const run=fixture(null);delete run.events[0].batteryPct;
  const [snapshotRow]=buildTransportHistoryRows(run);
  assert.equal(snapshotRow.reason,'選定理由未記録');
  assert.equal(snapshotRow.detail,'AGF2 / 残量10.0%');
  run.events[0].batteryPct=72.3;
  assert.equal(buildTransportHistoryRows(run)[0].detail,'AGF2 / 残量72.3%');
  run.events[0].reason='area_first';
  assert.equal(buildTransportHistoryRows(run)[0].reason,'選定理由未記録');
});

test('customer history CSV and rendered rows retain the same eleven columns with saved selection reasons',()=>{
  const run=fixture(),rows=buildTransportHistoryRows(run),cells=transportHistoryCells(rows[0]);
  assert.deepEqual(TRANSPORT_HISTORY_COLUMNS,headers);
  assert.equal(cells.length,11);
  assert.equal(cells[9],rows[0].reason);assert.equal(cells[10],rows[0].detail);
  const csv=transportHistoryCsv(run);
  assert.ok(csv.startsWith('\ufeff'));
  assert.deepEqual(csv.slice(1).split('\r\n').map(line=>line.split(',')),[headers,cells]);
  const html=renderTransportHistoryRows(rows);
  assert.equal((html.match(/<td\b/g)??[]).length,11);
  assert.match(html,/目的地（荷下ろし先）のパレタイズエリアを優先/);
  assert.match(html,/AGF2（パレタイズエリア・残量60\.0%）/);
});
