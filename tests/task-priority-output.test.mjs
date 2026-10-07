import test from 'node:test';
import assert from 'node:assert/strict';
import {customerConditionRows,customerConditionDifferences,renderCustomerConditions} from '../src/ui/customer-conditions.mjs';
import {customerConditionsCsv,transportHistoryCsv} from '../src/ui/customer-export.mjs';
import {buildRunConditions,renderRunConditions} from '../src/ui/run-conditions.mjs';
import {eventCsv,conditionCsv} from '../src/ui/export.mjs';
import {renderComparison} from '../src/ui/analysis-view.mjs';
import {compareRuns} from '../src/ui/replay-model.mjs';
import {createLegacyScenario} from '../src/ui/scenario.mjs';
import {TRANSPORT_HISTORY_COLUMNS} from '../src/ui/transport-history.mjs';

// Specification-confirmed simulation defaults, not physical facility priorities.
const priorities={wrapperOutput:10,magazines:{M1:24,M2:22,M3:23,M4:20,M5:21},
  lines:{L1:30,L2:34,L3:34,L4:32,L5:33,L6:31,L7:34,L8:34}};
const priorityKeys=['taskPriorities.wrapperOutput',...Object.keys(priorities.magazines).map(id=>'taskPriorities.magazines.'+id),
  ...Object.keys(priorities.lines).map(id=>'taskPriorities.lines.'+id)];
const priorityValues=[10,24,22,23,20,21,30,34,34,32,33,31,34,34];

function fixture(){
  const scenario=createLegacyScenario('standard');
  scenario.durationMin=1;scenario.taskPriorities=structuredClone(priorities);
  scenario.evidence.taskPriorities='simulation-default-task-priorities';
  const final={tasks:[],agfs:scenario.agfs.map(a=>({...a,status:'idle'})),pallets:[],warehouse:{}};
  const events=[{type:'RUN_STARTED',timeMs:0,sequence:0},{type:'RUN_ENDED',timeMs:60000,sequence:1}];
  return {runId:'SYNTHETIC-PRIORITY-OUTPUT',scenario,events,final,snapshots:events.map(()=>structuredClone(final)),metrics:{stored:0}};
}
const priorityRows=run=>customerConditionRows(run).filter(row=>row.category==='搬送タスク優先度');

test('customer conditions and BOM CSV expose all 14 saved task priorities without editable charging priority',()=>{
  const run=fixture(),rows=priorityRows(run),csv=customerConditionsCsv(run);
  assert.equal(rows.length,14);
  assert.deepEqual(rows.map(row=>row.key),priorityKeys);
  assert.deepEqual(rows.map(row=>row.value),priorityValues);
  assert.deepEqual(rows.map(row=>row.target),['包装機出口','M1','M2','M3','M4','M5','L1','L2','L3','L4','L5','L6','L7','L8']);
  assert.ok(rows.every(row=>row.label==='優先度'&&row.unit===''&&/シミュレーション初期設定/.test(row.evidence)));
  assert.ok(csv.startsWith('\ufeff区分,項目,対象,値,単位,根拠'));
  assert.equal(csv.split('\r\n').filter(line=>line.startsWith('搬送タスク優先度,')).length,14);
  assert.ok(csv.includes('搬送タスク優先度,優先度,M4,20,,'));
  assert.ok(csv.includes('搬送タスク優先度,優先度,L1,30,,'));
  assert.doesNotMatch(rows.map(row=>row.target).join(' / '),/CHARGER|充電/);
  assert.match(renderCustomerConditions(run),/搬送タスク優先度/);
});

test('priority conditions use saved scenario values and do not read unexecuted form changes or final task values',()=>{
  const run=fixture(),before=priorityRows(run),csv=customerConditionsCsv(run),draft=structuredClone(run.scenario);
  draft.taskPriorities.wrapperOutput=1;draft.taskPriorities.magazines.M4=99;draft.taskPriorities.lines.L1=98;
  run.final.tasks.push({id:'SYNTHETIC-FINAL-TASK',taskPriority:77,prioritySourceId:'L1'});
  assert.deepEqual(priorityRows(run),before);
  assert.equal(customerConditionsCsv(run),csv);
  const explicit=fixture();explicit.scenario.taskPriorities.lines.L1=98;
  explicit.scenario.evidence.taskPriorities='explicit-scenario-setting';
  assert.equal(priorityRows(explicit).find(row=>row.target==='L1').value,98);
  assert.match(priorityRows(explicit).find(row=>row.target==='L1').evidence,/この実行の明示条件/);
});

test('developer conditions and separate condition CSV retain the exact 14 saved priorities and source evidence',()=>{
  const run=fixture(),rows=buildRunConditions(run).filter(row=>row.category==='TASK_PRIORITY');
  assert.equal(rows.length,14);
  assert.deepEqual(rows.map(row=>row.key),['WRAPPER-OUTPUT','M1','M2','M3','M4','M5','L1','L2','L3','L4','L5','L6','L7','L8']);
  assert.deepEqual(rows.map(row=>row.value),priorityValues);
  assert.ok(rows.every(row=>row.subkey==='priority'&&row.evidence==='simulation-default-task-priorities'));
  assert.match(renderRunConditions(run),/搬送タスク優先度/);
  const csv=conditionCsv(run);
  assert.ok(csv.includes('TASK_PRIORITY,M4,priority,20,simulation-default-task-priorities'));
  assert.equal(csv.split('\r\n').filter(row=>row.startsWith('TASK_PRIORITY,')).length,14);
});

test('legacy missing task priorities display FIFO compatibility without fabricating default equipment values',()=>{
  const run=fixture();delete run.scenario.taskPriorities;
  const rows=priorityRows(run),developer=buildRunConditions(run).filter(row=>row.category==='TASK_PRIORITY');
  assert.equal(rows.length,1);assert.match(rows[0].value,/legacy FIFO/);assert.match(rows[0].value,/要求順/);
  assert.equal(developer.length,1);assert.equal(developer[0].value,'legacy_fifo');
  assert.match(renderCustomerConditions(run),/legacy FIFO/);assert.match(renderRunConditions(run),/legacy FIFO/);
  assert.equal(customerConditionsCsv(run).split('\r\n').filter(row=>row.startsWith('搬送タスク優先度,優先度,')).length,0);
  assert.ok(!priorityRows(run).some(row=>typeof row.value==='number'));
});

test('comparison identifies each equipment priority difference and does not call different priorities common conditions',()=>{
  const left=fixture(),right=fixture();
  right.scenario.taskPriorities.wrapperOutput=11;right.scenario.taskPriorities.magazines.M4=19;right.scenario.taskPriorities.lines.L1=29;
  const differences=customerConditionDifferences([left,right]);
  assert.deepEqual(differences.map(row=>[row.target,row.left,row.right]),[['包装機出口','10','11'],['M4','20','19'],['L1','30','29']]);
  const html=renderComparison([left,right]);
  assert.match(html,/条件の違い/);assert.match(html,/M4/);
  assert.doesNotMatch(html,/同一条件の比較|比較に使った共通条件/);
  assert.match(html,/条件が異なる/);
  const noPriorities=fixture();delete noPriorities.scenario.taskPriorities;
  assert.ok(customerConditionDifferences([left,noPriorities]).some(row=>row.label==='優先度'));
});

test('selection mode comparison clones identical priority settings and preserves its input',()=>{
  const scenario=fixture().scenario;scenario.lineIntervalsMin=Array(8).fill(0);scenario.manualRequests=[];
  scenario.magazineUses=[];scenario.alignerReadyEvents=[];
  const before=structuredClone(scenario),runs=compareRuns(scenario);
  assert.deepEqual(scenario,before);
  assert.notEqual(runs[0].scenario.mode,runs[1].scenario.mode);
  assert.deepEqual(runs[0].scenario.taskPriorities,priorities);
  assert.deepEqual(runs[1].scenario.taskPriorities,priorities);
  assert.equal(customerConditionDifferences(runs).filter(row=>row.label==='優先度').length,0);
});

test('developer event CSV preserves request and assignment priority metadata while customer history stays 14 columns',()=>{
  const run=fixture();run.events=[{type:'TASK_REQUESTED',timeMs:0,sequence:5,taskId:'SYNTHETIC-T1',kind:'01',
    prioritySourceId:'L1',taskPriority:30,requestSequence:5},
  {type:'TASK_ASSIGNED',timeMs:1000,sequence:6,taskId:'SYNTHETIC-T1',kind:'01',agfId:'AGF1',
    prioritySourceId:'L1',taskPriority:30,requestSequence:5}];
  const savedTask={id:'SYNTHETIC-T1',kind:'01',status:'assigned',taskPriority:99,prioritySourceId:'L8',requestSequence:77};
  run.snapshots=run.events.map(()=>({tasks:[savedTask]}));run.final.tasks=[savedTask];
  const lines=eventCsv(run,'SYNTHETIC-PRIORITY-CSV').slice(1).split('\r\n'),columns=lines[0].split(',');
  for(const field of ['prioritySourceId','taskPriority','requestSequence'])assert.ok(columns.includes(field),field);
  // The second line has no scenario JSON quoting; it must use the event's saved values, not the changed final task.
  const assigned=lines[2].split(',');
  assert.equal(assigned[columns.indexOf('prioritySourceId')],'L1');
  assert.equal(assigned[columns.indexOf('taskPriority')],'30');
  assert.equal(assigned[columns.indexOf('requestSequence')],'5');
  assert.equal(TRANSPORT_HISTORY_COLUMNS.length,14);
  assert.equal(transportHistoryCsv(run).slice(1).split('\r\n')[0].split(',').length,14);
  assert.ok(!TRANSPORT_HISTORY_COLUMNS.includes('優先度'));
});
