import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTransportHistoryRows,transportHistoryCells,renderTransportHistoryRows,TRANSPORT_HISTORY_COLUMNS} from '../src/ui/transport-history.mjs';
import {transportHistoryCsv} from '../src/ui/customer-export.mjs';

// All saved dispatch decisions below are synthetic, never site observations.
const evaluation=(agfId,area,batteryPct,extra={})=>({agfId,area,batteryPct,status:'idle',eligible:false,selected:false,
  exclusionReason:null,evaluationStatus:'evaluated',...extra});
function decision(overrides={}){
  return {mode:'area_first',destinationArea:'WH',selectedAgfId:'AGF2',selectedArea:'WH',selectedBatteryPct:48.2,
    reservePct:40,chargeStartPct:40,fallback:'wait',basis:'destination_area',tieBreak:'none',tieBreakEvidence:null,
    candidates:[{agfId:'AGF2',area:'WH',batteryPct:48.2},{agfId:'AGF3',area:'WH',batteryPct:70}],
    evaluations:[evaluation('AGF1','PZ',60,{status:'moving_empty',exclusionReason:'STATUS_NOT_AVAILABLE'}),
      evaluation('AGF2','WH',48.2,{eligible:true,selected:true}),evaluation('AGF3','WH',70,{eligible:true}),
      evaluation('AGF4','PZ',45,{exclusionReason:'AREA_NOT_PRIORITIZED'})],...overrides};
}
function fixture(selection=decision(),type='TASK_ASSIGNED',reason){
  const task={id:'TASK-SYNTHETIC-EXPLANATION',kind:'02',palletId:'SIM-L2-1',sourceLineId:'L2',
    originId:'WRAP-OUTPUT',destinationId:'SYNTHETIC-STORAGE',destinationArea:'WH'};
  const event={type,timeMs:60000,sequence:0,taskId:task.id,kind:task.kind,palletId:task.palletId};
  if(type==='TASK_ASSIGNED')event.agfId='AGF2';
  if(reason)event.reason=reason;
  if(selection)event.dispatchSelection=selection;
  return {runId:'SYNTHETIC-DISPATCH-EXPLANATION',scenario:{mode:'area_first',battery:{reservePct:40,chargeStartPct:40}},
    events:[event],snapshots:[{tasks:[task],agfs:[{id:'AGF2',area:'PZ',batteryPct:9,status:'charging'}]}],final:{tasks:[task]}};
}
const firstRow=(selection,type,reason)=>buildTransportHistoryRows(fixture(selection,type,reason))[0];

test('saved assignment explains all four AGFs and the final comparison pool with short multiline Japanese copy',()=>{
  const row=firstRow(decision());
  assert.match(row.reason,/製品倉庫.*優先/);
  assert.match(row.reason,/候補2台/);
  assert.match(row.reason,/最低残量.*AGF2.*選定/);
  assert.match(row.detail,/^選定 AGF2（製品倉庫・48\.2%）\n/);
  const lines=row.detail.split('\n');
  assert.match(lines.find(line=>line.startsWith('候補 ')),/AGF2.*48\.2%.*待機.*AGF3.*70\.0%/);
  assert.doesNotMatch(lines.find(line=>line.startsWith('候補 ')),/AGF1|AGF4/);
  assert.match(lines.find(line=>line.startsWith('対象外 ')),/AGF1.*60\.0%.*空走.*AGF4.*45\.0%.*目的地エリア外/);
  assert.match(row.detail,/選定下限40%超/);
  assert.doesNotMatch(row.reason+' '+row.detail,/STATUS_NOT_AVAILABLE|AREA_NOT_PRIORITIZED|moving_empty|idle|PZ|WH/);
});

test('a single final candidate is identified without claiming a lowest-battery comparison',()=>{
  const row=firstRow(decision({candidates:[{agfId:'AGF2',area:'WH',batteryPct:48.2}],evaluations:decision().evaluations.map(e=>
    e.agfId==='AGF3'?{...e,eligible:false,exclusionReason:'BLOCKED'}:e)}));
  assert.match(row.reason,/候補1台.*AGF2.*選定/);
  assert.doesNotMatch(row.reason,/最低残量|同残量|ID順/);
});

test('same minimum battery reports only the tied minimum count and requires saved ID tie-break evidence',()=>{
  const candidates=[{agfId:'AGF2',area:'WH',batteryPct:48.2},{agfId:'AGF3',area:'WH',batteryPct:48.2},
    {agfId:'AGF4',area:'WH',batteryPct:70}];
  const selection=decision({candidates,tieBreak:'agf_id',tieBreakEvidence:'synthetic-model-tiebreak'});
  assert.match(firstRow(selection).reason,/候補3台.*最低残量が同じ2台.*AGF2/);
  assert.match(firstRow(selection).reason,/AGF ID順.*再現性のための仮定/);
  const missingEvidence=firstRow({...selection,tieBreakEvidence:null});
  assert.match(missingEvidence.reason,/同残量の選定根拠未記録/);
  assert.doesNotMatch(missingEvidence.reason,/ID順|再現性のための仮定/);
  const rounded=firstRow(decision({candidates:[{agfId:'AGF2',area:'WH',batteryPct:48.21},
    {agfId:'AGF3',area:'WH',batteryPct:48.22}],selectedBatteryPct:48.21}));
  assert.doesNotMatch(rounded.reason,/同じ|同残量|ID順/);
});

test('cross-area fallback records missing destination candidates and the saved Run option',()=>{
  const row=firstRow(decision({basis:'cross_area_fallback',fallback:'any',selectedArea:'PZ',
    candidates:[{agfId:'AGF2',area:'PZ',batteryPct:48.2}]}));
  assert.match(row.reason,/製品倉庫に候補なし/);
  assert.match(row.reason,/他エリア.*候補1台.*AGF2/);
  assert.match(row.reason,/このRunの設定/);
});

test('all-area mode identifies its final comparison count without destination priority',()=>{
  const row=firstRow(decision({mode:'low_battery_first',basis:'all_areas'}));
  assert.match(row.reason,/エリア優先なし.*候補2台.*AGF2/);
  assert.doesNotMatch(row.reason,/目的地.*優先|他エリア/);
});

test('every saved exclusion is translated and preserves the state, area, and battery used in the decision',async t=>{
  const cases=[
    ['STATUS_NOT_AVAILABLE','charging',39,'充電中'],['STATUS_NOT_AVAILABLE','waiting_traffic',65,'交通待ち'],
    ['STATUS_NOT_AVAILABLE','moving_to_wait',65,'倉庫待機場所へ復帰'],['STATUS_NOT_AVAILABLE','positioning_for_pickup',65,'荷受け姿勢'],
    ['BLOCKED','idle',65,'利用不可'],['BATTERY_INVALID','idle',null,'残量不正'],
    ['BATTERY_RESERVE','idle',40,'選定下限40%以下'],['BATTERY_CHARGE_START','idle',39.5,'充電開始40%以下'],
    ['AREA_NOT_PRIORITIZED','idle',65,'目的地エリア外'],['AREA_FALLBACK_DISABLED','idle',65,'他エリア選定なし'],
    ['PICKUP_ROUTE_UNREACHABLE','idle',65,'荷受け点への経路に到達不可'],
    ['LOADED_ROUTE_UNREACHABLE','idle',65,'荷下ろし先への経路に到達不可'],
    ['UNKNOWN_INTERNAL_REASON','unknown_internal_status',65,'判定理由未記録']
  ];
  for(const [exclusionReason,status,batteryPct,label] of cases){
    await t.test(exclusionReason+' '+status,()=>{
      const row=firstRow(decision({evaluations:[evaluation('AGF1','WH',batteryPct,{status,exclusionReason})]}));
      assert.ok(row.detail.includes(label));
      assert.match(row.detail,/AGF1（製品倉庫/);
      if(Number.isFinite(batteryPct))assert.ok(row.detail.includes(batteryPct.toFixed(1)+'%'));
      assert.doesNotMatch(row.detail,new RegExp(exclusionReason+'|'+status));
    });
  }
});

test('waiting dispatch lists all vehicle exclusions and has no selected vehicle',()=>{
  const evaluations=[evaluation('AGF1','WH',38,{exclusionReason:'BATTERY_CHARGE_START'}),
    evaluation('AGF2','WH',55,{status:'charging',exclusionReason:'STATUS_NOT_AVAILABLE'}),
    evaluation('AGF3','PZ',60,{exclusionReason:'AREA_FALLBACK_DISABLED'}),
    evaluation('AGF4','WH',60,{exclusionReason:'PICKUP_ROUTE_UNREACHABLE'})];
  const row=firstRow(decision({selectedAgfId:null,selectedArea:null,selectedBatteryPct:null,candidates:[],evaluations}),
    'TASK_WAITING','NO_ELIGIBLE_AGF');
  assert.match(row.reason,/実行可能AGF待ち.*候補0台/);
  assert.match(row.detail,/^選定なし\n候補 なし\n対象外 /);
  for(const e of evaluations)assert.ok(row.detail.includes(e.agfId));
  assert.doesNotMatch(row.detail,/選定 AGF|選定理由未記録/);
  const areaWait=firstRow(decision({selectedAgfId:null,candidates:[],evaluations}), 'TASK_WAITING','NO_AREA_AGF');
  assert.match(areaWait.reason,/製品倉庫に候補なし/);
});

test('task preconditions distinguish vehicles not evaluated from vehicles evaluated before the task was held',()=>{
  const gate=evaluationStatus=>decision({selectedAgfId:null,selectedArea:null,selectedBatteryPct:null,candidates:[],
    taskExclusionReason:'ALIGNER_PERMISSION',evaluations:decision().evaluations.map(e=>({...e,eligible:false,selected:false,
      exclusionReason:'TASK_PRECONDITION',evaluationStatus}))});
  const notEvaluated=firstRow(gate('not_evaluated'),'TASK_WAITING','ALIGNER_PERMISSION');
  assert.match(notEvaluated.reason,/整列機の荷受け許可待ち.*AGF判定は未実施/);
  assert.match(notEvaluated.detail,/\n未評価 .*AGF1.*AGF2.*AGF3.*AGF4/);
  assert.doesNotMatch(notEvaluated.detail,/対象外 |搬送中のため|選定下限40%以下/);
  const evaluated=firstRow(gate('evaluated'),'TASK_WAITING','ALIGNER_PERMISSION');
  assert.match(evaluated.reason,/整列機の荷受け許可待ち.*AGF選定を保留/);
  assert.match(evaluated.detail,/\n選定保留 .*AGF1.*AGF2.*AGF3.*AGF4/);
  assert.doesNotMatch(evaluated.reason+' '+evaluated.detail,/未評価|未実施/);
});

test('saved decisions remain authoritative when settings and replay snapshots are altered or absent',()=>{
  const run=fixture(),before=JSON.stringify(run),original=buildTransportHistoryRows(run)[0];
  assert.equal(JSON.stringify(run),before);
  run.scenario.mode='low_battery_first';run.scenario.battery.reservePct=99;run.scenario.battery.chargeStartPct=95;
  run.snapshots[0].agfs[0]={id:'AGF2',area:'PZ',batteryPct:1,status:'moving_loaded'};
  run.final.tasks[0].destinationArea='PZ';
  const changed=buildTransportHistoryRows(run)[0];
  assert.equal(changed.reason,original.reason);assert.equal(changed.detail,original.detail);
  delete run.snapshots;
  assert.equal(buildTransportHistoryRows(run)[0].detail,original.detail);
});

test('unassigned waiting records never borrow a later AGF assignment from the final task',()=>{
  const run=fixture(decision({selectedAgfId:null,selectedArea:null,selectedBatteryPct:null,candidates:[],
    evaluations:decision().evaluations.map(e=>({...e,eligible:false,selected:false,exclusionReason:'BLOCKED'}))}),
    'TASK_WAITING','NO_ELIGIBLE_AGF');
  run.final.tasks[0].agfId='AGF4';delete run.snapshots;
  const [row]=buildTransportHistoryRows(run);
  assert.equal(row.agfId,'－');
  assert.match(row.detail,/^選定なし/);
  assert.equal(buildTransportHistoryRows(run,{agfId:'AGF4'}).length,0);
});

test('legacy decisions explicitly disclose missing all-vehicle evaluation without inventing snapshot eligibility',()=>{
  const selection=decision();delete selection.evaluations;
  const row=firstRow(selection);
  assert.match(row.detail,/全台評価未記録/);
  assert.match(row.detail,/残量48\.2%/);
  assert.doesNotMatch(row.detail,/残量9\.0%|充電中|対象外/);
  const absent=firstRow(null);
  assert.equal(absent.reason,'選定理由未記録');
  const waiting=firstRow({...selection,selectedAgfId:null,candidates:[]},'TASK_WAITING','NO_ELIGIBLE_AGF');
  assert.match(waiting.detail,/全台評価未記録/);
});

test('multiline detail is escaped once and shared unchanged by eleven UI and CSV cells',()=>{
  const run=fixture(),rows=buildTransportHistoryRows(run),cells=transportHistoryCells(rows[0]),csv=transportHistoryCsv(run);
  assert.equal(TRANSPORT_HISTORY_COLUMNS.length,11);assert.equal(cells.length,11);
  const quote=value=>/[",\r\n]/.test(String(value))?'"'+String(value).replaceAll('"','""')+'"':String(value);
  assert.equal(csv,'\ufeff'+[TRANSPORT_HISTORY_COLUMNS.map(quote).join(','),cells.map(quote).join(',')].join('\r\n'));
  const html=renderTransportHistoryRows(rows);
  assert.equal((html.match(/<td\b/g)??[]).length,11);
  assert.match(html,/<td class="dispatch-detail">選定 AGF2/);
  assert.ok(html.includes(rows[0].detail));
  const css=readFileSync(new URL('../src/ui/dashboard.css',import.meta.url),'utf8');
  assert.match(css,/\.transport-history\s+td\.dispatch-detail\s*\{[^}]*white-space:\s*pre-line/);
});
