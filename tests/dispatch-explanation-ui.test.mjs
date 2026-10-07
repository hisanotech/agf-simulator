import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTransportHistoryRows,transportHistoryCells,renderTransportHistoryRows,TRANSPORT_HISTORY_COLUMNS} from '../src/ui/transport-history.mjs';
import {transportHistoryCsv} from '../src/ui/customer-export.mjs';
import {eventCsv} from '../src/ui/export.mjs';

// All dispatch decisions below are synthetic, never site observations.
const dashes=['－','－','－','－'];
const evaluation=(agfId,area,batteryPct,extra={})=>({agfId,area,batteryPct,status:'idle',blocked:false,
  eligible:false,selected:false,exclusionReason:null,evaluationStatus:'evaluated',...extra});
function decision(overrides={}){
  return {mode:'area_first',destinationArea:'WH',selectedAgfId:'AGF2',selectedArea:'WH',selectedBatteryPct:48.2,
    reservePct:40,chargeStartPct:40,fallback:'wait',basis:'destination_area',tieBreak:'none',tieBreakEvidence:null,
    candidates:[{agfId:'AGF2',area:'WH',batteryPct:48.2},{agfId:'AGF3',area:'WH',batteryPct:70}],
    evaluations:[evaluation('AGF1','PZ',76.2,{status:'moving_empty',exclusionReason:'STATUS_NOT_AVAILABLE'}),
      evaluation('AGF2','WH',48.2,{eligible:true,selected:true}),evaluation('AGF3','WH',71.5,{eligible:true}),
      evaluation('AGF4','WH',39.8,{status:'charging',exclusionReason:'STATUS_NOT_AVAILABLE'})],...overrides};
}
function fixture(selection=decision(),type='TASK_ASSIGNED',reason){
  const task={id:'TASK-SYNTHETIC-STATE',kind:'02',palletId:'SIM-L2-1',sourceLineId:'L2',
    originId:'WRAP-OUTPUT',destinationId:'SYNTHETIC-STORAGE',destinationArea:'WH'};
  const event={type,timeMs:60000,sequence:0,taskId:task.id,kind:task.kind,palletId:task.palletId};
  if(type==='TASK_ASSIGNED')event.agfId='AGF2';if(reason)event.reason=reason;if(selection)event.dispatchSelection=selection;
  return {runId:'SYNTHETIC-DISPATCH-STATE',scenario:{mode:'area_first',battery:{reservePct:40,chargeStartPct:40}},events:[event],
    snapshots:[{tasks:[task],agfs:[{id:'AGF2',area:'PZ',batteryPct:9,status:'charging'}]}],final:{tasks:[task]}};
}
const firstRow=(selection,type,reason)=>buildTransportHistoryRows(fixture(selection,type,reason))[0];

test('assignment shows all four saved Japanese states side by side and selected AGF in the existing AGF column',()=>{
  const row=firstRow(decision());
  assert.equal(row.agfId,'AGF2');assert.deepEqual(row.agfStates,['搬送中 / パレタイズエリア / 76.2%',
    '待機 / 製品倉庫 / 48.2%','待機 / 製品倉庫 / 71.5%','充電中 / 製品倉庫 / 39.8%']);
  assert.equal(row.detail,'－');assert.equal(Object.hasOwn(row,'reason'),false);
  assert.doesNotMatch(transportHistoryCells(row).join(' '),/候補|対象外|選定下限|最低残量|STATUS_NOT_AVAILABLE|moving_empty|idle/);
  const reordered=decision();reordered.evaluations.reverse();
  assert.deepEqual(firstRow(reordered).agfStates,row.agfStates);
  const selectionOnly=fixture();delete selectionOnly.events[0].agfId;
  selectionOnly.final.tasks[0].agfId='AGF4';
  assert.equal(buildTransportHistoryRows(selectionOnly)[0].agfId,'AGF2');
});

test('a single candidate uses the same concise state presentation without additional comparison text',()=>{
  const row=firstRow(decision({candidates:[{agfId:'AGF2',area:'WH',batteryPct:48.2}],evaluations:decision().evaluations.map(e=>
    e.agfId==='AGF3'?{...e,eligible:false,exclusionReason:'BLOCKED'}:e)}));
  assert.equal(row.agfId,'AGF2');assert.equal(row.agfStates[2],'利用不可 / 製品倉庫 / 71.5%');
  assert.equal(row.detail,'－');assert.doesNotMatch(transportHistoryCells(row).join(' '),/最低残量|候補1台|ID順/);
});

test('equal-battery tie metadata remains internal and cannot change saved status presentation',()=>{
  const selection=decision({tieBreak:'agf_id',tieBreakEvidence:'synthetic-model-tiebreak'});
  const row=firstRow(selection),withoutEvidence=firstRow({...selection,tieBreakEvidence:null});
  assert.deepEqual(withoutEvidence.agfStates,row.agfStates);assert.equal(row.detail,'－');
  assert.doesNotMatch(transportHistoryCells(row).join(' '),/ID順|同残量|再現性|synthetic-model-tiebreak|agf_id/);
  assert.equal(selection.tieBreakEvidence,'synthetic-model-tiebreak');
});

test('cross-area fallback status cells use saved vehicle areas and do not substitute the destination',()=>{
  const selection=decision({basis:'cross_area_fallback',fallback:'any',selectedArea:'PZ',evaluations:decision().evaluations.map(e=>
    e.agfId==='AGF2'?{...e,area:'PZ'}:e)});
  const row=firstRow(selection);assert.equal(row.agfStates[1],'待機 / パレタイズエリア / 48.2%');
  assert.equal(row.agfId,'AGF2');assert.equal(row.detail,'－');
});

test('all-area mode preserves every saved vehicle state without an area-priority explanation',()=>{
  const row=firstRow(decision({mode:'low_battery_first',basis:'all_areas'}));
  assert.deepEqual(row.agfStates,firstRow(decision()).agfStates);assert.equal(row.detail,'－');
});

test('every recorded exclusion yields a concise Japanese state with area and saved battery',async t=>{
  const cases=[
    ['STATUS_NOT_AVAILABLE','charging',39,'充電中'],['STATUS_NOT_AVAILABLE','waiting_traffic',65,'交通待ち'],
    ['STATUS_NOT_AVAILABLE','moving_to_wait',65,'待機場所へ移動中'],
    ['STATUS_NOT_AVAILABLE','positioning_for_pickup',65,'荷受け姿勢へ移行'],
    ['BLOCKED','idle',65,'利用不可'],['BATTERY_INVALID','idle',null,'利用不可（残量不明）'],
    ['BATTERY_RESERVE','idle',40,'待機（残量不足）'],['BATTERY_CHARGE_START','idle',39.5,'待機（残量不足）'],
    ['AREA_NOT_PRIORITIZED','idle',65,'待機'],['AREA_FALLBACK_DISABLED','idle',65,'待機'],
    ['PICKUP_ROUTE_UNREACHABLE','idle',65,'利用不可（経路なし）'],
    ['LOADED_ROUTE_UNREACHABLE','idle',65,'利用不可（経路なし）'],
    ['UNKNOWN_INTERNAL_REASON','unknown_internal_status',65,'状態未記録']
  ];
  for(const [exclusionReason,status,batteryPct,label] of cases){
    await t.test(exclusionReason+' '+status,()=>{
      const row=firstRow(decision({evaluations:[evaluation('AGF1','WH',batteryPct,{status,exclusionReason})]}));
      assert.ok(row.agfStates[0].startsWith(label+' / 製品倉庫 / '));
      if(Number.isFinite(batteryPct))assert.ok(row.agfStates[0].endsWith(batteryPct.toFixed(1)+'%'));
      else assert.ok(row.agfStates[0].endsWith('残量未記録'));
      assert.deepEqual(row.agfStates.slice(1),dashes.slice(1));
      assert.doesNotMatch(row.agfStates.join(' '),new RegExp(exclusionReason+'|'+status));
    });
  }
});

test('saved blocked true overrides idle even when an earlier filter records a different exclusion code',()=>{
  const row=firstRow(decision({evaluations:[evaluation('AGF1','WH',39,{blocked:true,exclusionReason:'BATTERY_CHARGE_START'})]}));
  assert.equal(row.agfStates[0],'利用不可 / 製品倉庫 / 39.0%');assert.deepEqual(row.agfStates.slice(1),dashes.slice(1));
});

test('HP and dispatch-pending statuses simplify to idle while moving statuses remain distinct',()=>{
  const selection=decision({evaluations:[evaluation('AGF1','WH',70,{status:'hp_wait'}),evaluation('AGF2','WH',65,{status:'dispatch_pending'}),
    evaluation('AGF3','PZ',60,{status:'moving_loaded'}),evaluation('AGF4','WH',55,{status:'moving_to_wait'})]});
  assert.deepEqual(firstRow(selection).agfStates,['待機 / 製品倉庫 / 70.0%','待機 / 製品倉庫 / 65.0%',
    '搬送中 / パレタイズエリア / 60.0%','待機場所へ移動中 / 製品倉庫 / 55.0%']);
});

test('evaluated waiting decisions display all four saved states and no selected AGF',()=>{
  const evaluations=[evaluation('AGF1','WH',38,{exclusionReason:'BATTERY_CHARGE_START'}),
    evaluation('AGF2','WH',55,{status:'charging',exclusionReason:'STATUS_NOT_AVAILABLE'}),
    evaluation('AGF3','PZ',60,{exclusionReason:'AREA_FALLBACK_DISABLED'}),
    evaluation('AGF4','WH',60,{exclusionReason:'PICKUP_ROUTE_UNREACHABLE'})];
  const row=firstRow(decision({selectedAgfId:null,selectedArea:null,selectedBatteryPct:null,candidates:[],evaluations}),
    'TASK_WAITING','NO_ELIGIBLE_AGF');
  assert.equal(row.agfId,'－');assert.deepEqual(row.agfStates,['待機（残量不足） / 製品倉庫 / 38.0%',
    '充電中 / 製品倉庫 / 55.0%','待機 / パレタイズエリア / 60.0%','利用不可（経路なし） / 製品倉庫 / 60.0%']);
  assert.equal(row.detail,'実行可能AGF待ち');assert.doesNotMatch(row.detail,/候補|対象外|選定下限|選定なし/);
});

test('waiting preconditions expose states only for vehicles whose selection evaluation actually ran',()=>{
  const gate=evaluationStatus=>decision({selectedAgfId:null,selectedArea:null,selectedBatteryPct:null,candidates:[],
    taskExclusionReason:'ALIGNER_PERMISSION',evaluations:decision().evaluations.map(e=>({...e,eligible:false,selected:false,
      exclusionReason:'TASK_PRECONDITION',evaluationStatus}))});
  const notEvaluated=firstRow(gate('not_evaluated'),'TASK_WAITING','ALIGNER_PERMISSION');
  assert.deepEqual(notEvaluated.agfStates,dashes);assert.equal(notEvaluated.detail,'整列機の荷受け許可待ち');
  const evaluated=firstRow(gate('evaluated'),'TASK_WAITING','ALIGNER_PERMISSION');
  assert.deepEqual(evaluated.agfStates,firstRow(decision()).agfStates);
  const partial=gate('evaluated');partial.evaluations[1].evaluationStatus='not_evaluated';
  assert.equal(firstRow(partial,'TASK_WAITING','ALIGNER_PERMISSION').agfStates[1],'－');
  assert.doesNotMatch(evaluated.detail+' '+notEvaluated.detail,/未評価|未実施|選定保留|候補|対象外/);
});

test('saved decision states remain authoritative when settings and replay snapshots are altered or absent',()=>{
  const run=fixture(),before=JSON.stringify(run),original=buildTransportHistoryRows(run)[0];assert.equal(JSON.stringify(run),before);
  run.scenario.mode='low_battery_first';run.scenario.battery.reservePct=99;run.scenario.battery.chargeStartPct=95;
  run.snapshots[0].agfs[0]={id:'AGF2',area:'PZ',batteryPct:1,status:'moving_loaded'};run.final.tasks[0].destinationArea='PZ';
  run.final.agfs=[{id:'AGF2',area:'PZ',batteryPct:100,status:'charging'}];
  assert.deepEqual(buildTransportHistoryRows(run)[0].agfStates,original.agfStates);
  delete run.snapshots;assert.deepEqual(buildTransportHistoryRows(run)[0].agfStates,original.agfStates);
});

test('unassigned waiting records never borrow a later AGF assignment from the final task',()=>{
  const run=fixture(decision({selectedAgfId:null,selectedArea:null,selectedBatteryPct:null,candidates:[],
    evaluations:decision().evaluations.map(e=>({...e,eligible:false,selected:false,exclusionReason:'BLOCKED'}))}),
    'TASK_WAITING','NO_ELIGIBLE_AGF');run.final.tasks[0].agfId='AGF4';delete run.snapshots;
  const [row]=buildTransportHistoryRows(run);assert.equal(row.agfId,'－');assert.ok(row.agfStates.every(state=>state.startsWith('利用不可 / ')));
  assert.equal(buildTransportHistoryRows(run,{agfId:'AGF4'}).length,0);
});

test('legacy missing evaluations keep four dashes without inventing states from candidates or snapshots',()=>{
  const selection=decision();delete selection.evaluations;
  for(const saved of [selection,null,decision({evaluations:[]}),decision({evaluations:[evaluation('AGF99','WH',100)]})]){
    const row=firstRow(saved);assert.deepEqual(row.agfStates,dashes);assert.equal(row.detail,'－');assert.equal(row.agfId,'AGF2');
  }
  const waiting=firstRow({...selection,selectedAgfId:null,candidates:[]},'TASK_WAITING','NO_ELIGIBLE_AGF');
  assert.deepEqual(waiting.agfStates,dashes);assert.equal(waiting.detail,'実行可能AGF待ち');
});

test('non-assignment business events do not project saved decision states into the new columns',()=>{
  for(const type of ['TASK_REQUESTED','TASK_PICKED','TASK_DROPPED','TASK_COMPLETED','CHARGE_STARTED','PALLET_EXITED']){
    const row=firstRow(decision(),type);assert.deepEqual(row.agfStates,dashes,type);
  }
});

test('fourteen UI and CSV cells share the same data and escape customer content exactly once',()=>{
  const run=fixture(),rows=buildTransportHistoryRows(run),cells=transportHistoryCells(rows[0]),csv=transportHistoryCsv(run);
  assert.equal(TRANSPORT_HISTORY_COLUMNS.length,14);assert.equal(cells.length,14);assert.equal(TRANSPORT_HISTORY_COLUMNS.includes('理由'),false);
  const quote=value=>/[",\r\n]/.test(String(value))?'"'+String(value).replaceAll('"','""')+'"':String(value);
  assert.equal(csv,'\ufeff'+[TRANSPORT_HISTORY_COLUMNS.map(quote).join(','),cells.map(quote).join(',')].join('\r\n'));
  const html=renderTransportHistoryRows(rows);assert.equal((html.match(/<td\b/g)??[]).length,14);
  for(const state of rows[0].agfStates)assert.ok(html.includes(state));
  const injected={...rows[0],detail:'<script>"x" & danger</script>'},escaped=renderTransportHistoryRows([injected]);
  assert.match(escaped,/&lt;script&gt;&quot;x&quot; &amp; danger&lt;\/script&gt;/);assert.doesNotMatch(escaped,/<script>/);
  const css=readFileSync(new URL('../src/ui/dashboard.css',import.meta.url),'utf8');
  assert.match(css,/\.transport-history\s+td\.agf-state\s*\{[^}]*white-space:\s*normal/);
});

test('internal waiting reasons and saved evaluations survive customer simplification and developer export',()=>{
  const run=fixture(decision({selectedAgfId:null,candidates:[]}), 'TASK_WAITING','NO_ELIGIBLE_AGF'),before=JSON.stringify(run);
  const customer=transportHistoryCsv(run);assert.equal(JSON.stringify(run),before);
  assert.doesNotMatch(customer,/NO_ELIGIBLE_AGF|STATUS_NOT_AVAILABLE|AREA_NOT_PRIORITIZED/);
  assert.equal(run.events[0].reason,'NO_ELIGIBLE_AGF');assert.equal(run.events[0].dispatchSelection.evaluations.length,4);
  assert.match(eventCsv(run,run.runId),/NO_ELIGIBLE_AGF/);
});
