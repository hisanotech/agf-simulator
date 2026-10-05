import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoScenario,createLegacyScenario,initialAgfFromSettings} from '../src/ui/scenario.mjs';
import {renderAnalysis,renderComparison} from '../src/ui/analysis-view.mjs';
import {analyzeRun,durationTenths} from '../src/ui/replay-model.mjs';
import {simulate} from '../src/core/simulate.mjs';

function fixture(){
  const scenario=createDemoScenario();scenario.durationMin=1;scenario.lineIntervalsMin=[10,20,30,40,50,60,70,80];
  delete scenario.productStreams;scenario.mode='area_first';scenario.times.wrapMin=3.3;
  const tasks=[['T1','01','AGF1','completed'],['T2','02','AGF1','completed'],['T3','03','AGF2','completed'],
    ['T4','01','AGF3','picked'],['T5','05',null,'queued']].map(([id,kind,agfId,status])=>({id,kind,agfId,status,requestedAt:0,
      assignedAt:agfId?1000:null,originId:'L4',destinationId:'WRAP-INPUT',waitReason:id==='T5'?'NO_ELIGIBLE_AGF':null}));
  const agfs=scenario.agfs.map((a,i)=>({...a,batteryPct:70.123+i,status:i===2?'waiting_wrapper_input':'idle',taskId:i===2?'T4':null}));
  const final={tasks,agfs,pallets:[],warehouse:{}};
  const events=[{type:'RUN_STARTED',timeMs:0,sequence:0},{type:'TASK_COMPLETED',timeMs:1000,sequence:1,taskId:'T1',kind:'01',agfId:'AGF1'},
    {type:'TASK_COMPLETED',timeMs:2000,sequence:2,taskId:'T2',kind:'02',agfId:'AGF1'},
    {type:'TASK_COMPLETED',timeMs:3000,sequence:3,taskId:'T3',kind:'03',agfId:'AGF2'},
    {type:'CHARGE_STARTED',timeMs:4000,sequence:4,agfId:'AGF3'},
    {type:'CHARGE_REQUESTED',timeMs:5000,sequence:5,agfId:'AGF4'},
    {type:'RUN_ENDED',timeMs:60000,sequence:6}];
  return {runId:'SYNTHETIC-CUSTOMER',scenario,final,events,snapshots:events.map(()=>structuredClone(final)),metrics:{stored:1}};
}
test('customer analysis leads with saved Japanese conditions and isolates old raw details',()=>{
  const html=renderAnalysis(fixture());
  assert.ok(html.indexOf('シミュレーション条件')<html.indexOf('結果サマリー'));
  assert.ok(html.indexOf('結果サマリー')<html.indexOf('搬送実績'));
  assert.ok(html.indexOf('搬送実績')<html.indexOf('AGF別実績'));
  assert.match(html,/<details[^>]*developer-details[^>]*>/);
  const customer=html.split('class="developer-details"')[0];
  assert.doesNotMatch(customer,/area_first|TASK_COMPLETED|waiting_wrapper_input|scenarioJson|synthetic-assumption|T4/);
  assert.match(customer,/包装機入口待ち/);
});
test('official completion events agree for all AGFs all transport kinds and every AGF subtotal',async()=>{
  const {customerRunSummary}=await import('../src/ui/customer-results.mjs'),run=fixture(),data=customerRunSummary(run);
  assert.equal(data.completed,3);assert.equal(data.pending,2);
  assert.equal(data.byKind.reduce((n,k)=>n+k.completed,0),3);
  assert.equal(data.agfs.reduce((n,a)=>n+a.completed,0),3);
  for(const a of data.agfs)assert.equal(a.byKind.reduce((n,k)=>n+k.completed,0),a.completed);
  assert.equal(data.agfs[0].completed,2);assert.equal(data.agfs[1].completed,1);
  assert.equal(data.agfs[0].finalBatteryPct,70.123);
  assert.equal(data.agfs[2].chargeCount,1);assert.equal(data.agfs[3].chargeCount,0);
  assert.equal(data.pendingTasks.find(t=>t.kind==='01').reason,'包装機入口待ち');
});

test('unfinished transport reason follows actual saved activity rather than a retained wrapper input reason',async()=>{
  const {customerPendingReason,customerRunSummary}=await import('../src/ui/customer-results.mjs'),run=fixture();
  const task=run.final.tasks.find(task=>task.id==='T4'),agf=run.final.agfs.find(agf=>agf.taskId===task.id);
  task.waitReason='WRAPPER_INPUT';
  for(const [status,expected] of [['turning','旋回中'],['moving_loaded','搬送中'],['handling_dropoff','荷役中'],
    ['positioning_for_pickup','荷役中'],['waiting_traffic','通行待ち'],['waiting_wrapper_input','包装機入口待ち']]){
    agf.status=status;
    assert.equal(customerPendingReason(task,agf),expected,status);
    assert.equal(customerRunSummary(run).pendingTasks.find(row=>row.kind==='01').reason,expected,status);
  }
  task.waitReason=null;agf.status='waiting_wrapper_input';
  assert.equal(customerPendingReason(task,agf),'包装機入口待ち');
});
test('final status alone is not customer completion and initial charging stop never counts as charge',async()=>{
  const {customerRunSummary}=await import('../src/ui/customer-results.mjs'),run=fixture();
  run.events=run.events.filter(e=>!['TASK_COMPLETED','CHARGE_STARTED'].includes(e.type));run.snapshots=run.events.map(()=>structuredClone(run.final));
  const data=customerRunSummary(run);assert.equal(data.completed,0);
  assert.ok(data.agfs.every(a=>a.chargeCount===0));assert.equal(data.pending,5);
});
test('saved customer conditions preserve executed intervals speeds wrapper times and provisional evidence after form changes',async()=>{
  const {customerConditionRows}=await import('../src/ui/customer-conditions.mjs'),run=fixture(),before=customerConditionRows(run),draft=structuredClone(run.scenario);
  draft.lineIntervalsMin[0]=999;draft.times.wrapMin=999;
  assert.deepEqual(customerConditionRows(run),before);
  assert.equal(before.find(r=>r.key==='line.L1.interval').value,10);
  assert.equal(before.find(r=>r.key==='line.L1.hourly').value,6);
  assert.equal(before.find(r=>r.key==='wrapper.wrapMin').value,3.3);
  assert.equal(before.find(r=>r.key==='agf.AGF1.position').value,'充電場所1');
  assert.equal(before.find(r=>r.key==='motion.turnRateDegPerSec').value,12.1);
  assert.match(before.find(r=>r.key==='motion.turnRateDegPerSec').evidence,/暫定/);
  assert.ok(before.some(r=>r.key==='speed.empty'));
});
test('customer CSV files have Japanese headers and remain separate from internal event and condition exports',async()=>{
  const {customerConditionsCsv,transportResultsCsv,agfResultsCsv}=await import('../src/ui/customer-export.mjs'),run=fixture();
  const conditions=customerConditionsCsv(run),transport=transportResultsCsv(run),agf=agfResultsCsv(run);
  for(const csv of [conditions,transport,agf])assert.ok(csv.startsWith('\ufeff'));
  assert.match(conditions,/区分,項目,対象,値,単位,根拠/);assert.match(transport,/搬送,内容,要求件数,完了件数,未完了件数/);
  assert.match(agf,/AGF,搬送完了件数,搬送01,搬送02,搬送03,搬送04,搬送05,最終バッテリー/);
  for(const csv of [conditions,transport,agf])assert.doesNotMatch(csv,/area_first|TASK_COMPLETED|waiting_wrapper_input|synthetic-assumption/);
  assert.ok(agf.includes('70.1'));assert.ok(transport.includes('搬送01'));
});

test('customer achievement CSVs reconcile actual completed transports charging starts and final battery from a reproducible legacy charge Run',async()=>{
  const {transportResultsCsv,agfResultsCsv}=await import('../src/ui/customer-export.mjs');
  const scenario=createLegacyScenario('charge'),run=simulate(scenario);
  const transportRows=transportResultsCsv(run).slice(1).split('\r\n').slice(1).map(row=>row.split(','));
  const agfRows=agfResultsCsv(run).slice(1).split('\r\n').slice(1).map(row=>row.split(','));
  const completions=run.events.filter(event=>event.type==='TASK_COMPLETED');
  assert.ok(completions.length>0);
  assert.ok(run.events.some(event=>event.type==='CHARGE_STARTED'));
  assert.equal(transportRows.reduce((sum,row)=>sum+Number(row[3]),0),completions.length);
  assert.equal(agfRows.reduce((sum,row)=>sum+Number(row[1]),0),completions.length);
  for(const row of transportRows){
    const kind=row[0].replace('搬送','');
    assert.equal(Number(row[3]),completions.filter(event=>event.kind===kind).length);
    assert.equal(Number(row[2]),Number(row[3])+Number(row[4]));
  }
  for(const row of agfRows){
    const agf=run.final.agfs.find(agf=>agf.id===row[0]);
    assert.equal(Number(row[1]),row.slice(2,7).reduce((sum,value)=>sum+Number(value),0));
    assert.equal(Number(row[7]),Number(agf.batteryPct.toFixed(1)));
    assert.equal(Number(row[8]),run.events.filter(event=>event.type==='CHARGE_STARTED'&&event.agfId===agf.id).length);
  }
});

test('customer conditions CSV quotes saved display names containing commas quotes and newlines',async()=>{
  const {customerConditionsCsv}=await import('../src/ui/customer-export.mjs'),run=fixture();
  run.scenario.agfs[0].id='合成機体, "試験"\n1';
  const csv=customerConditionsCsv(run);
  assert.match(csv,/"合成機体, ""試験""\n1"/);
});
test('comparison reports actual saved condition differences using Japanese names',()=>{
  const left=fixture(),right=fixture();right.scenario.mode='low_battery_first';right.scenario.lineIntervalsMin[0]=15;
  const html=renderComparison([left,right]);
  assert.match(html,/条件の違い/);assert.match(html,/GWI/);assert.match(html,/15/);assert.match(html,/搬送先エリア優先/);
});
test('wrapper and charging-place waits remain exclusive and customer time rows total the full three-hour horizon',async()=>{
  const {customerRunSummary}=await import('../src/ui/customer-results.mjs'),run=fixture();run.scenario.durationMin=180;
  run.events=[0,3600000,7200000,10800000].map((timeMs,sequence)=>({timeMs,sequence,type:'SYNTHETIC_STATE'}));
  run.snapshots=run.events.map((_,i)=>({...structuredClone(run.final),agfs:run.final.agfs.map(a=>({...a,
    status:a.id==='AGF1'?['waiting_wrapper_input','waiting_charge_place','charging','idle'][i]:'idle',taskId:null}))}));
  run.final=run.snapshots.at(-1);
  const analysis=analyzeRun(run),data=customerRunSummary(run,analysis);
  assert.equal(analysis.wrapperInputWaitMs,3600000);assert.equal(analysis.chargePlaceWaitMs,3600000);
  assert.equal(analysis.chargeWaitMs,3600000);assert.equal(analysis.trafficWaitMs,0);
  for(const row of analysis.agfs){
    assert.equal(Object.values(row.durations).reduce((a,b)=>a+b,0),10800000);
    assert.equal(Object.values(durationTenths(row.durations)).reduce((a,b)=>a+b,0),1800);
  }
  for(const row of data.agfs)assert.equal(row.timeGroups.reduce((a,b)=>a+b.minutes,0),180);
  const first=data.agfs[0];
  assert.equal(first.timeGroups.find(t=>t.key==='equipment').minutes,60);
  assert.equal(first.timeGroups.find(t=>t.key==='chargeWait').minutes,60);
  assert.equal(first.timeGroups.find(t=>t.key==='charging').minutes,60);
});
test('traffic conditions use saved policy values and never label a legacy Run with the new directions',async()=>{
  const {customerConditionRows}=await import('../src/ui/customer-conditions.mjs'),run=fixture();
  const policy=run.scenario.operationalTopology.trafficPolicy;
  assert.equal(policy.pz.south,'west_to_east');
  let rows=customerConditionRows(run);
  assert.equal(rows.find(row=>row.key==='traffic.pz').value,'南側：西→東 / 北側：東→西');
  assert.equal(rows.find(row=>row.key==='traffic.warehouse').value,'保管ブロック側：上→下 / 中央壁側：下→上');
  policy.pz.south='both';policy.warehouse.wallSide=null;
  rows=customerConditionRows(run);
  assert.equal(rows.find(row=>row.key==='traffic.pz').value,'南側：双方向 / 北側：東→西');
  assert.equal(rows.find(row=>row.key==='traffic.warehouse').value,'保管ブロック側：上→下 / 中央壁側：未設定');
  delete run.scenario.operationalTopology.trafficPolicy;
  rows=customerConditionRows(run);
  assert.doesNotMatch(rows.find(row=>row.key==='traffic.pz').value,/南側：西→東/);
});
test('customer CSV filenames remain distinct and retain the saved Run name',async()=>{
  const {customerCsvFilename}=await import('../src/ui/customer-export.mjs'),run=fixture();
  const names=['conditions','transport','agf'].map(kind=>customerCsvFilename(run,kind));
  assert.equal(new Set(names).size,3);for(const name of names){assert.match(name,/SYNTHETIC-CUSTOMER/);assert.doesNotMatch(name,/object Object/);}
});
test('configured per-edge speeds and disabled stream state come from the saved Scenario',async()=>{
  const {customerConditionRows,customerConditionDifferences}=await import('../src/ui/customer-conditions.mjs'),run=fixture();
  run.scenario.operationalTopology.edges[0].speedMmPerSec.empty=321;
  assert.match(String(customerConditionRows(run).find(row=>row.key==='speed.empty').value),/0\.321/);
  const right=structuredClone(run);right.scenario.productStreams=[{sourceLineId:'L1',enabled:true,productType:'special',loadType:'partial',intervalMin:7,startOffsetMin:2}];
  const rows=customerConditionRows(right);
  assert.equal(rows.find(row=>row.key==='line.L2.disabled').value,'停止');
  assert.ok(!rows.some(row=>row.key==='line.L2.normal.full.interval'));
  assert.equal(rows.filter(row=>row.key.endsWith('.magazine')).length,8);
  const differences=customerConditionDifferences([run,right]);
  assert.ok(differences.some(row=>row.target==='GWI'&&row.label==='特注・端数 搬出間隔'&&row.right==='7'));
});
test('confirmed wrapper stops and neutral capacities distinguish internal conveyor storage from entrance and exit transfer slots',async()=>{
  const {customerConditionRows}=await import('../src/ui/customer-conditions.mjs'),run=fixture();
  assert.equal(run.scenario.wrapper.inputCapacity,1);assert.equal(run.scenario.wrapper.outputCapacity,1);
  assert.equal(run.scenario.wrapper.conveyorCapacity,5);
  const rows=customerConditionRows(run);
  assert.equal(rows.find(row=>row.key==='wrapper.inputStopCount').value,1);
  assert.equal(rows.find(row=>row.key==='wrapper.outputStopCount').value,1);
  assert.equal(rows.find(row=>row.key==='wrapper.conveyorCapacity').value,5);
  const legacy=createLegacyScenario('physical');
  assert.equal(legacy.wrapper.conveyorCapacity,undefined);assert.equal(legacy.wrapper.outputCapacity,2);
});
test('legacy graph startup and unchanged area controls keep four independent stops without creating initial charging assignments',()=>{
  const s=createLegacyScenario('physical'),ids=s.agfs.map(a=>a.currentNodeId);
  assert.deepEqual(ids,['CHARGE-PLACE1','CHARGE-PLACE2','HP1','HP2']);
  assert.ok(s.agfs.every(a=>a.area==='WH'&&a.status==='idle'&&a.chargerId==null));
  const read=s.agfs.map(a=>initialAgfFromSettings(s,a,{position:a.area,batteryPct:a.batteryPct}));
  assert.deepEqual(read.map(a=>a.currentNodeId),ids);
});
test('separate developer event CSV retains wrapper reservation conveyor evidence and explicit overtaking participants',async()=>{
  const {eventCsv}=await import('../src/ui/export.mjs'),run=fixture();
  run.events=[{type:'RUN_STARTED',timeMs:0,sequence:0},
    {type:'WRAPPER_INPUT_RESERVED',timeMs:1000,sequence:1,reservationCount:1,inputCount:0},
    {type:'WRAPPER_CONVEYOR_ACCEPTED',timeMs:2000,sequence:2,conveyorQuantity:4,conveyorCapacity:5,transferTimingEvidence:'unresolved-transfer-time-same-event-sequence'},
    {type:'OVERTAKING_STARTED',timeMs:3000,sequence:3,blockedAgfId:'AGF2',resourceIds:['SYNTHETIC-RESOURCE'],temporaryReverseEdgeIds:['SYNTHETIC-EDGE']}];
  run.snapshots=run.events.map(()=>({tasks:[]}));
  const csv=eventCsv(run,'SYNTHETIC-CUSTOMER'),header=csv.slice(1).split('\r\n')[0].split(',');
  for(const key of ['reservationCount','inputCount','conveyorQuantity','conveyorCapacity','transferTimingEvidence','blockedAgfId','resourceIds','temporaryReverseEdgeIds'])assert.ok(header.includes(key),key);
  assert.match(csv,/unresolved-transfer-time-same-event-sequence/);
  assert.match(csv,/SYNTHETIC-RESOURCE/);assert.match(csv,/SYNTHETIC-EDGE/);
});
