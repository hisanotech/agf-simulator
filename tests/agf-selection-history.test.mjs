import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTransportHistoryRows,transportHistoryCells,TRANSPORT_HISTORY_COLUMNS,renderTransportHistoryRows} from '../src/ui/transport-history.mjs';
import {transportHistoryCsv} from '../src/ui/customer-export.mjs';

// Saved decisions are synthetic fixtures, not operating records.
const headers=['発生時刻','履歴区分','搬送No.','搬送パターン','パレットID','系列','AGF','AGF1状態','AGF2状態','AGF3状態','AGF4状態','発生場所','状態・内容','詳細'];
const dashes=['－','－','－','－'];
function decision(overrides={}){
  return {mode:'area_first',destinationArea:'PZ',selectedArea:'PZ',selectedAgfId:'AGF2',selectedBatteryPct:60,
    reservePct:40,fallback:'wait',basis:'destination_area',eligibleAgfIds:['AGF1','AGF2','AGF3'],
    candidates:[{agfId:'AGF2',area:'PZ',batteryPct:60},{agfId:'AGF3',area:'PZ',batteryPct:80}],
    evaluations:[{agfId:'AGF1',area:'WH',batteryPct:76.2,status:'moving_loaded',eligible:false,exclusionReason:'STATUS_NOT_AVAILABLE'},
      {agfId:'AGF2',area:'PZ',batteryPct:60,status:'idle',eligible:true,selected:true},
      {agfId:'AGF3',area:'PZ',batteryPct:80,status:'idle',eligible:true},
      {agfId:'AGF4',area:'WH',batteryPct:39.8,status:'charging',eligible:false,exclusionReason:'STATUS_NOT_AVAILABLE'}],
    tieBreak:'none',tieBreakEvidence:null,...overrides};
}
function fixture(selection=decision()){
  const task={id:'TASK-SYNTHETIC-1',kind:'01',palletId:'SIM-L2-1',sourceLineId:'L2',
    originId:'L2',originArea:'PZ',destinationId:'WRAP-INPUT',destinationArea:'PZ',agfId:'AGF2'};
  const event={type:'TASK_ASSIGNED',timeMs:60000,sequence:0,taskId:task.id,kind:task.kind,agfId:'AGF2',palletId:task.palletId,batteryPct:99};
  if(selection!==null)event.dispatchSelection=selection;
  return {runId:'SYNTHETIC-SELECTION-HISTORY',scenario:{mode:'area_first',crossAreaFallback:'wait',battery:{reservePct:40}},
    events:[event],snapshots:[{tasks:[{...task}],agfs:[{id:'AGF2',area:'WH',batteryPct:10,status:'charging'}]}],
    final:{tasks:[{...task}],agfs:[{id:'AGF2',area:'WH',batteryPct:5,status:'moving_loaded'}]}};
}

test('destination-area assignment exposes the selected AGF and saved four-vehicle states without explanatory prose',()=>{
  const [row]=buildTransportHistoryRows(fixture());
  assert.equal(row.agfId,'AGF2');
  assert.deepEqual(row.agfStates,['搬送中 / 製品倉庫 / 76.2%','待機 / パレタイズエリア / 60.0%',
    '待機 / パレタイズエリア / 80.0%','充電中 / 製品倉庫 / 39.8%']);
  assert.equal(row.detail,'－');assert.equal(Object.hasOwn(row,'reason'),false);
  assert.doesNotMatch(transportHistoryCells(row).join(' '),/候補|対象外|選定下限|最低残量|destination_area|area_first|moving_loaded/);
});

test('cross-area fallback displays the actual saved area rather than a destination-derived area',()=>{
  const selection=decision({destinationArea:'WH',selectedArea:'PZ',fallback:'any',basis:'cross_area_fallback'});
  const [row]=buildTransportHistoryRows(fixture(selection));
  assert.equal(row.agfStates[1],'待機 / パレタイズエリア / 60.0%');
  assert.equal(row.agfId,'AGF2');assert.equal(row.detail,'－');
});

test('all-area mode keeps vehicle states independent of the mode and candidate list',()=>{
  const selection=decision({mode:'low_battery_first',basis:'all_areas',
    candidates:[{agfId:'AGF2',area:'PZ',batteryPct:60}]});
  const [row]=buildTransportHistoryRows(fixture(selection));
  assert.deepEqual(row.agfStates,buildTransportHistoryRows(fixture())[0].agfStates);
  assert.equal(row.detail,'－');
});

test('each selection basis omits single-candidate lowest-battery prose',async t=>{
  for(const basis of ['destination_area','cross_area_fallback','all_areas']){
    await t.test(basis,()=>{
      const [row]=buildTransportHistoryRows(fixture(decision({basis,
        mode:basis==='all_areas'?'low_battery_first':'area_first',fallback:basis==='cross_area_fallback'?'any':'wait',
        candidates:[{agfId:'AGF2',area:'PZ',batteryPct:60}]})));
      assert.equal(row.agfId,'AGF2');assert.equal(row.detail,'－');
      assert.doesNotMatch(transportHistoryCells(row).join(' '),/候補1台|最低残量|同残量|ID順/);
    });
  }
});

test('equal-battery tie evidence remains saved while the customer history shows states only',()=>{
  const run=fixture(decision({tieBreak:'agf_id',tieBreakEvidence:'synthetic-model-tiebreak',
    evaluations:decision().evaluations.map(e=>e.agfId==='AGF3'?{...e,batteryPct:60}:e)}));
  const before=JSON.stringify(run),[row]=buildTransportHistoryRows(run);
  assert.equal(row.agfStates[1],'待機 / パレタイズエリア / 60.0%');
  assert.equal(row.agfStates[2],'待機 / パレタイズエリア / 60.0%');
  assert.equal(row.agfId,'AGF2');assert.equal(row.detail,'－');
  assert.equal(JSON.stringify(run),before);
  assert.equal(run.events[0].dispatchSelection.tieBreakEvidence,'synthetic-model-tiebreak');
});

test('state projection neither reconstructs tie rules nor loses exact saved battery precision',()=>{
  const undocumented=fixture(decision({tieBreak:'agf_id',tieBreakEvidence:null}));
  assert.equal(buildTransportHistoryRows(undocumented)[0].detail,'－');
  const close=fixture(decision({evaluations:decision().evaluations.map(e=>
    ['AGF2','AGF3'].includes(e.agfId)?{...e,batteryPct:e.agfId==='AGF2'?60.01:60.02}:e)}));
  const before=JSON.stringify(close),[row]=buildTransportHistoryRows(close);
  assert.equal(row.agfStates[1],'待機 / パレタイズエリア / 60.0%');
  assert.equal(row.agfStates[2],'待機 / パレタイズエリア / 60.0%');
  assert.equal(JSON.stringify(close),before);assert.equal(close.events[0].dispatchSelection.evaluations[2].batteryPct,60.02);
});

test('saved selection states remain authoritative after scenario, task and replay battery changes',()=>{
  const run=fixture(),before=JSON.stringify(run),original=buildTransportHistoryRows(run)[0];
  assert.equal(JSON.stringify(run),before);
  run.scenario.mode='low_battery_first';run.scenario.crossAreaFallback='any';run.scenario.battery.reservePct=90;
  run.final.tasks[0].destinationArea='WH';run.final.agfs[0]={id:'AGF2',area:'WH',batteryPct:100,status:'charging'};
  run.snapshots[0].tasks[0].destinationArea='WH';run.snapshots[0].agfs[0]={id:'AGF2',area:'WH',batteryPct:1,status:'moving_loaded'};
  const changed=buildTransportHistoryRows(run)[0];
  assert.deepEqual(changed.agfStates,original.agfStates);assert.equal(changed.detail,'－');
  assert.equal(changed.agfStates[1],'待機 / パレタイズエリア / 60.0%');
});

test('legacy assignments without saved evaluations never reconstruct states from event or snapshot batteries',()=>{
  for(const selection of [null,(()=>{const s=decision();delete s.evaluations;return s;})()]){
    const run=fixture(selection),[row]=buildTransportHistoryRows(run);
    assert.deepEqual(row.agfStates,dashes);assert.equal(row.detail,'－');assert.equal(row.agfId,'AGF2');
    run.events[0].batteryPct=72.3;run.events[0].reason='area_first';
    assert.deepEqual(buildTransportHistoryRows(run)[0].agfStates,dashes);
  }
});

test('customer history CSV and rendered rows share exactly fourteen columns with no reason column',()=>{
  const run=fixture(),rows=buildTransportHistoryRows(run),cells=transportHistoryCells(rows[0]);
  assert.deepEqual(TRANSPORT_HISTORY_COLUMNS,headers);assert.equal(headers.includes('理由'),false);
  assert.equal(cells.length,14);assert.equal(cells[6],'AGF2');assert.deepEqual(cells.slice(7,11),rows[0].agfStates);
  assert.equal(cells[13],'－');
  const csv=transportHistoryCsv(run);assert.ok(csv.startsWith('\ufeff'));
  assert.deepEqual(csv.slice(1).split('\r\n').map(line=>line.split(',')),[headers,cells]);
  const html=renderTransportHistoryRows(rows);assert.equal((html.match(/<td\b/g)??[]).length,14);
  assert.match(html,/待機 \/ パレタイズエリア \/ 60\.0%/);
  assert.doesNotMatch(html,/選定理由|候補|対象外|選定下限/);
});
