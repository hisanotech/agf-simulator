import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeLineBuffers} from '../src/ui/buffer-analysis.mjs';
import {renderBufferAnalysis,renderAnalysis} from '../src/ui/analysis-view.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {bufferHistoryScenario} from './fixtures/buffer-history-scenario.mjs';

const minute=60_000;
function fixture(events=[],durationMin=100){
  const scenario=createDemoScenario();scenario.durationMin=durationMin;scenario.lineCapacity=3;
  const final={tasks:[],agfs:scenario.agfs.map(a=>({...a,status:'idle',taskId:null})),pallets:[],warehouse:{},
    lines:{L1:['WRONG-SNAPSHOT']},productionStatus:{L1:{state:'ready',reason:null}}};
  return {scenario,events,final,snapshots:events.map(()=>structuredClone(final)),metrics:{stored:0}};
}
const event=(type,lineId,timeMin,extra={})=>({type,lineId,timeMs:timeMin*minute,sequence:0,...extra});
const blocked=(lineId,timeMin,id,extra={})=>event('LINE_BUFFER_BLOCKED',lineId,timeMin,
  {plannedPalletId:id,blockedSinceMs:timeMin*minute,quantityBefore:3,quantityAfter:3,capacity:3,...extra});
const resumed=(lineId,timeMin,id,extra={})=>event('PRODUCTION_RESUMED_FROM_BUFFER',lineId,timeMin,
  {plannedPalletId:id,palletId:id,quantityBefore:2,quantityAfter:3,capacity:3,...extra});

test('buffer analysis pairs saved transport history and counts the horizon tail without snapshot truth',()=>{
  const run=fixture([blocked('L1',20,'PL-A'),event('LINE_BUFFER_RELEASED','L1',35,{quantityBefore:3,quantityAfter:2}),
    event('PRODUCTION_BLOCKED_EMPTY_PALLET','L1',35,{plannedPalletId:'PL-A'}),resumed('L1',40,'PL-A'),
    blocked('L1',60,'PL-B'),blocked('L2',30,'PL-C'),resumed('L2',45,'PL-C')]);
  const data=analyzeLineBuffers(run),l1=data.lines[0],l2=data.lines[1];
  assert.equal(data.fullCount,3);assert.equal(data.stopMs,75*minute);assert.equal(data.maxStopMs,40*minute);
  assert.equal(data.delayedPalletCount,3);assert.equal(data.endedStoppedLineCount,1);
  assert.equal(l1.fullCount,2);assert.equal(l1.stopMs,60*minute);assert.equal(l1.maxStopMs,40*minute);
  assert.equal(l1.endedStatus,'生産停止中');assert.equal(l1.maxQuantity,3);
  assert.equal(l2.stopMs,15*minute);assert.equal(l2.endedStatus,'生産可能');
  assert.equal(data.lines.length,8);assert.equal(data.lines[7].capacity,3);
  assert.deepEqual(l1.intervals.map(i=>[i.plannedPalletId,i.startMs,i.endMs,i.resumed]),
    [['PL-A',20*minute,40*minute,true],['PL-B',60*minute,100*minute,false]]);
});

test('buffer release never ends a buffer-caused stop before actual pallet production',()=>{
  const run=fixture([blocked('L1',20,'PL-A'),event('LINE_BUFFER_RELEASED','L1',35,{quantityBefore:3,quantityAfter:2}),
    event('PRODUCTION_BLOCKED_EMPTY_PALLET','L1',35,{plannedPalletId:'PL-A'})]);
  const data=analyzeLineBuffers(run);
  assert.equal(data.stopMs,80*minute);assert.equal(data.maxStopMs,80*minute);
  assert.equal(data.endedStoppedLineCount,1);assert.equal(data.lines[0].endedReason,'EMPTY_PALLET');
});

test('same-time processing order and duplicate notices do not invent extra delayed pallets',()=>{
  const run=fixture([resumed('L1',20,'PL-A',{sequence:3}),blocked('L1',20,'PL-A',{sequence:1}),
    blocked('L1',20,'PL-A',{sequence:2})]);
  const original=structuredClone(run.events),data=analyzeLineBuffers(run);
  assert.equal(data.fullCount,1);assert.equal(data.delayedPalletCount,1);assert.equal(data.stopMs,0);
  assert.equal(data.endedStoppedLineCount,0);assert.deepEqual(run.events,original);
});

test('resume for another planned pallet cannot close the saved stop interval',()=>{
  const data=analyzeLineBuffers(fixture([blocked('L1',20,'PL-A'),resumed('L1',40,'PL-B')]));
  assert.equal(data.stopMs,80*minute);assert.equal(data.endedStoppedLineCount,1);
  assert.equal(data.lines[0].intervals[0].plannedPalletId,'PL-A');
});

test('historical buffer occupancy is reconstructed from output and pickup events, never final occupancy',()=>{
  const run=fixture([event('PALLET_EXITED','L1',0,{palletId:'P1'}),event('PALLET_EXITED','L1',1,{palletId:'P2'}),
    {type:'TASK_PICKED',timeMs:2*minute,sequence:0,taskId:'T1',palletId:'P1',kind:'01'},
    event('PALLET_EXITED','L1',3,{palletId:'P3'}),event('PALLET_EXITED','L1',4,{palletId:'P4'})]);
  run.final.lines.L1=[];run.final.tasks=[{id:'T1',kind:'01',originId:'L1',palletId:'P1'}];
  const data=analyzeLineBuffers(run);
  assert.equal(data.lines[0].maxQuantity,3);assert.equal(data.lines[0].fullCount,0);
});

test('empty-pallet-only stops are distinguishable and do not inflate buffer counts or durations',()=>{
  const data=analyzeLineBuffers(fixture([event('PRODUCTION_BLOCKED_EMPTY_PALLET','L2',20,{plannedPalletId:'P2'})]));
  assert.equal(data.fullCount,0);assert.equal(data.stopMs,0);assert.equal(data.delayedPalletCount,0);
  assert.equal(data.lines[1].endedStatus,'生産停止中');assert.equal(data.lines[1].endedReason,'EMPTY_PALLET');
});

test('ended and future events are limited to the saved run horizon',()=>{
  const data=analyzeLineBuffers(fixture([blocked('L1',20,'P1',{blockedSinceMs:10*minute}),resumed('L1',120,'P1')],100));
  assert.equal(data.fullCount,1);assert.equal(data.stopMs,90*minute);assert.equal(data.endedStoppedLineCount,1);
});

test('buffer result section shows five metrics, eight line rows and Japanese states without raw codes',()=>{
  const html=renderBufferAnalysis(fixture([blocked('L1',20,'P1')]));
  for(const text of ['バッファ満杯発生回数','バッファ満杯停止時間','最大連続停止時間','生産遅延PL数',
    '終了時生産停止系列数','容量','最大在荷','満杯発生回数','停止時間','最大停止時間','遅延PL','終了時状態'])
    assert.ok(html.includes(text),text);
  assert.equal((html.match(/data-buffer-line="L[1-8]"/g)??[]).length,8);
  assert.match(html,/生産停止中/);assert.match(html,/搬送履歴/);
  assert.doesNotMatch(html,/LINE_BUFFER_BLOCKED|PRODUCTION_RESUMED_FROM_BUFFER|イベント一覧/);
});

test('customer results include buffer analysis outside developer details and retain existing analysis',()=>{
  const events=[{type:'RUN_STARTED',timeMs:0,sequence:0},blocked('L1',20,'P1')],html=renderAnalysis(fixture(events));
  assert.ok(html.indexOf('系列バッファ分析')<html.indexOf('class="developer-details"'));
  assert.match(html,/結果サマリー/);assert.match(html,/AGF別実績/);assert.match(html,/AGF タイムライン/);
});

test('refilled buffer-stopped line keeps the horizon wait but shows next-takt reason until real resume',()=>{
  const due=(timeMs,palletId)=>({timeMs,palletId,lineId:'L1',destinationLocationId:'S1'});
  const scenario=bufferHistoryScenario({durationMin:15,magazineEmptyRecoveryPolicy:'next_takt',
    lineIntervalsMin:Array(8).fill(0),productionEvents:[due(0,'P1'),due(minute,'P2'),due(16*minute,'P3')],
    magazines:[{id:'M1',quantity:1,capacity:30,trigger:0,refillBatch:10,permission:true}],
    aligners:[{id:'AL1',quantity:0}],
    alignerRefillEvents:[{timeMs:8*minute,alignerId:'AL1',operationType:'individual'}]});
  scenario.times.emptyMin=5;
  const run=simulate(scenario),data=analyzeLineBuffers(run),line=data.lines[0];
  assert.equal(run.final.magazines.M1.quantity,10);
  assert.equal(run.final.productionStatus.L1.reason,'WAIT_NEXT_TAKT');
  assert.equal(line.endedStatus,'生産停止中');assert.equal(line.endedReason,'WAIT_NEXT_TAKT');
  assert.equal(line.stopMs,14*minute);assert.equal(line.maxStopMs,14*minute);
  assert.equal(line.fullCount,1);assert.equal(line.delayedPalletCount,1);
  assert.equal(data.endedBufferStoppedLineCount,1);assert.equal(line.intervals[0].resumed,false);
  const html=renderBufferAnalysis(run);
  assert.match(html,/補充済み・次タクト待ち/);
  assert.doesNotMatch(html,/<span class="muted">空パレット待ち<\/span>/);
  // Recovery of an empty-only stop has no suspended buffer PL to wait for.
  const emptyOnly=analyzeLineBuffers(fixture([event('PRODUCTION_BLOCKED_EMPTY_PALLET','L2',20),
    event('PRODUCTION_RECOVERY_WAIT_NEXT_TAKT','L2',50,{retainedBufferPallet:false})]));
  assert.equal(emptyOnly.lines[1].endedStatus,'生産可能');assert.equal(emptyOnly.endedStoppedLineCount,0);
});
