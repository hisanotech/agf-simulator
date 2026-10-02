import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoScenario,createLegacyScenario} from '../src/ui/scenario.mjs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';
import {analyzeRun,durationStatuses,durationTenths,workingStatuses} from '../src/ui/replay-model.mjs';
import {buildRunConditions,renderRunConditions} from '../src/ui/run-conditions.mjs';
import {conditionCsv,eventCsv} from '../src/ui/export.mjs';
import {states,reasons,eventNames} from '../src/ui/format.mjs';
import {renderMotionSettings,motionControlFromSettings} from '../src/ui/extended-settings.mjs';
import {initMap} from '../src/ui/map-view.mjs';

const controlFields=['turnRateDegPerSec','pickupPositioningMin','pickupForkInsertedMin',
  'dropoffPositioningMin','dropoffForkInsertedMin','turningConsumesBattery'];
const topology={nodes:[{id:'TURN',x:20,y:40},{id:'NEXT',x:20,y:80}],edges:[]};
const turningAgf=()=>({id:'AGF1',status:'turning',currentNodeId:'TURN',heading:'east',headingDeg:0,
  taskId:'01-SYNTHETIC',movement:{current:null},turn:{nodeId:'TURN',fromHeadingDeg:0,targetHeadingDeg:90,
    angleDeg:90,startedAt:1000,completedAt:3000,rateDegPerSec:45,evidence:'synthetic-assumption'}});

for(const preset of ['standard','extended'])test(`${preset} leaves real turn and handling phase settings unresolved`,()=>{
  const s=createDemoScenario(preset);
  for(const field of controlFields)assert.equal(s.motionControl?.[field],null,field);
  assert.equal(s.motionControl.turnRateEvidence,'unresolved');
  assert.equal(s.motionControl.handlingEvidence,'unresolved');
});
test('legacy graph fixture declares only synthetic turn timing without inventing handling splits',()=>{
  const s=createLegacyScenario('physical');
  assert.equal(s.motionControl.turnRateDegPerSec,45);
  assert.equal(s.motionControl.turnRateEvidence,'synthetic-assumption');
  assert.equal(s.motionControl.pickupPositioningMin,undefined);
  assert.equal(s.motionControl.dropoffForkInsertedMin,undefined);
});
test('normal motion settings display blank unresolved values and independent deg per second and minute units',()=>{
  const scenario=createDemoScenario(),html=renderMotionSettings(scenario);
  assert.match(html,/旋回角速度（deg\/s）/);assert.match(html,/荷受け姿勢への移行（分）/);
  assert.match(html,/フォーク挿入後の荷下ろし（分）/);assert.match(html,/未確定 · 時間分類のみ/);
  for(const key of controlFields.slice(0,-1))assert.match(html,new RegExp(`data-motion-setting="${key}"[^>]*value=""`));
  const values=Object.fromEntries(controlFields.map(key=>[key,'']));
  assert.deepEqual(motionControlFromSettings(scenario.motionControl,values),scenario.motionControl);
});
test('explicit motion form values retain evidence and never split the old aggregate handling time',()=>{
  const previous=createLegacyScenario('physical').motionControl;
  const unchanged=motionControlFromSettings(previous,{turnRateDegPerSec:'45',turningConsumesBattery:''});
  assert.equal(unchanged.turnRateEvidence,'synthetic-assumption');
  assert.equal(unchanged.pickupPositioningMin,undefined);
  const values={turnRateDegPerSec:'30',turningConsumesBattery:'true',pickupPositioningMin:'0.1',pickupForkInsertedMin:'0.4',
    dropoffPositioningMin:'0.2',dropoffForkInsertedMin:'0.3'};
  const updated=motionControlFromSettings(previous,values);
  assert.equal(updated.turnRateEvidence,'explicit-scenario-setting');assert.equal(updated.handlingEvidence,'explicit-scenario-setting');
  assert.equal(updated.turningConsumesBattery,true);assert.equal(updated.pickupPositioningMin,.1);
  assert.throws(()=>motionControlFromSettings(previous,{...values,turnRateDegPerSec:'0'}),/MOTION_CONFIG/);
  assert.throws(()=>motionControlFromSettings(previous,{...values,pickupPositioningMin:'-1'}),/MOTION_CONFIG/);
});
test('saved turning replay changes heading over event time and keeps translation stationary',()=>{
  const a=turningAgf(),before=structuredClone(a);
  for(const [timeMs,headingDeg] of [[0,0],[1000,0],[2000,45],[3000,90],[4000,90]]){
    const p=projectAgfPosition(a,topology,timeMs);
    assert.equal(p.x,20);assert.equal(p.y,40);assert.equal(p.nodeId,'TURN');
    assert.equal(p.headingDeg,headingDeg);assert.equal(p.translationalSpeedMmPerSec,0);
  }
  assert.deepEqual(a,before);
});
test('counterclockwise and wraparound saved turns project signed angle without jumping',()=>{
  const a=turningAgf();
  a.turn={...a.turn,fromHeadingDeg:0,targetHeadingDeg:270,angleDeg:-90};
  assert.equal(projectAgfPosition(a,topology,2000).headingDeg,315);
  assert.equal(projectAgfPosition(a,topology,3000).headingDeg,270);
  a.turn={...a.turn,fromHeadingDeg:270,targetHeadingDeg:0,angleDeg:90};
  assert.equal(projectAgfPosition(a,topology,2000).headingDeg,315);
  assert.equal(projectAgfPosition(a,topology,3000).headingDeg,0);
});
test('idle replay retains saved heading and straight segment replay uses its actual direction',()=>{
  const a=turningAgf();delete a.turn;a.status='idle';a.headingDeg=180;
  assert.equal(projectAgfPosition(a,topology,2000).headingDeg,180);
  a.status='moving_empty';a.movement.current={fromNodeId:'TURN',toNodeId:'NEXT',enteredAt:1000,exitAt:3000,
    displayPath:[{x:20,y:40},{x:20,y:80}]};
  assert.equal(projectAgfPosition(a,topology,2000).headingDeg,90);
  assert.equal(projectAgfPosition(a,topology,2000).y,60);
});
test('map marker uses projected heading rotation while the saved turn point stays fixed',()=>{
  const scenario=createDemoScenario(),attributes={},svg={innerHTML:'',addEventListener(){},setAttribute(key,value){attributes[key]=value;}};
  const agf=turningAgf();agf.displayPosition=projectAgfPosition(agf,topology,2000);agf.headingDeg=agf.displayPosition.headingDeg;agf.batteryPct=100;
  const snapshot={agfs:[agf],tasks:[],lines:{L4:['SYNTHETIC-PL']},magazines:{},aligners:{},temporaryPallets:[],
    warehouse:Object.fromEntries(scenario.warehouse.map(slot=>[slot.id,{...slot,palletIds:[],reserved:[]}]))};
  const map=initMap({svg,onSelectAgf(){},onSelectBlock(){}});map.render(snapshot,'AGF1',{topology,timeMs:2000});
  assert.match(svg.innerHTML,/data-heading-deg="45"/);assert.match(svg.innerHTML,/data-motion-state="turning"/);
  assert.match(svg.innerHTML,/class="agf-orientation" transform="rotate\(45\)"/);
  assert.match(svg.innerHTML,/class="agf-marker selected" transform="translate\(20,40\)"/);
  assert.equal(attributes.viewBox,'0 0 1400 850');
});

function conditionFixture(){return {runId:'TURN-SYNTHETIC',scenario:{...createLegacyScenario('physical'),
  motionControl:{turnRateDegPerSec:45,turnRateEvidence:'synthetic-assumption',turningConsumesBattery:null,
    pickupPositioningMin:.1,pickupForkInsertedMin:.4,dropoffPositioningMin:.2,dropoffForkInsertedMin:.3,
    handlingEvidence:'synthetic-assumption'}},events:[],snapshots:[]};}
test('saved Run conditions and separate conditions CSV retain every turn and handling phase with evidence',()=>{
  const run=conditionFixture(),rows=buildRunConditions(run);
  for(const field of controlFields){
    const row=rows.find(r=>r.category==='MOTION_CONTROL'&&r.subkey===field);
    assert.ok(row,field);assert.equal(row.value,run.scenario.motionControl[field]);
    assert.equal(row.evidence,field==='turningConsumesBattery'?'unresolved':'synthetic-assumption');
  }
  run.scenario.motionControl.turnRateDegPerSec=null;run.scenario.motionControl.turnRateEvidence='unresolved';
  const csv=conditionCsv(run),html=renderRunConditions(run);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('MOTION_CONTROL,settings,turnRateDegPerSec,UNSET,unresolved'));
  assert.ok(csv.includes('MOTION_CONTROL,settings,pickupPositioningMin,0.1,synthetic-assumption'));
  assert.match(html,/停止旋回・荷役姿勢/);assert.match(html,/旋回角速度（deg\/s）/);
});
test('turning battery and equal-state avoidance remain unresolved unless a model assumption is explicit',()=>{
  const run=conditionFixture();run.scenario.motionControl.turningBatteryEvidence='unresolved';
  run.scenario.motionControl.avoidanceTieBreakPolicy=null;
  let rows=buildRunConditions(run);
  assert.equal(rows.find(r=>r.category==='MOTION_CONTROL'&&r.subkey==='avoidanceTieBreakPolicy').evidence,'unresolved');
  run.scenario.motionControl.turningConsumesBattery=true;
  run.scenario.motionControl.turningBatteryEvidence='synthetic-assumption';
  run.scenario.motionControl.avoidanceTieBreakPolicy={kind:'agf_id',evidence:'synthetic-model-tiebreak'};
  rows=buildRunConditions(run);
  assert.equal(rows.find(r=>r.category==='MOTION_CONTROL'&&r.subkey==='turningConsumesBattery').evidence,'synthetic-assumption');
  assert.equal(rows.find(r=>r.category==='MOTION_CONTROL'&&r.subkey==='avoidanceTieBreakPolicy').evidence,'synthetic-model-tiebreak');
  assert.match(renderRunConditions(run),/合成モデル限定の同率処理/);
});
test('turn event CSV preserves node headings angle duration rate and evidence',()=>{
  const run=conditionFixture();run.events=[{timeMs:1000,sequence:0,type:'TURN_STARTED',agfId:'AGF1',
    nodeId:'TURN',fromHeadingDeg:0,targetHeadingDeg:90,angleDeg:90,turnDurationMs:2000,
    turnRateDegPerSec:45,turnRateEvidence:'synthetic-assumption',evidence:'synthetic-assumption'}];
  run.snapshots=[{tasks:[]}];
  const lines=eventCsv(run,'TURN-CSV').slice(1).split('\r\n'),columns=lines[0].split(','),cells=lines[1].split(',');
  for(const [key,value] of Object.entries({nodeId:'TURN',fromHeadingDeg:'0',targetHeadingDeg:'90',angleDeg:'90',
    turnDurationMs:'2000',turnRateDegPerSec:'45',turnRateEvidence:'synthetic-assumption'}))
    assert.equal(cells[columns.indexOf(key)],value,key);
});
test('Japanese state event and unresolved reason labels distinguish stopped turn and handling phases',()=>{
  assert.equal(states.turning,'旋回中');
  for(const status of ['positioning_for_pickup','picking_fork_inserted','positioning_for_dropoff','dropping_fork_inserted','waiting_motion_configuration'])
    assert.ok(states[status],status);
  for(const name of ['TURN_STARTED','TURN_COMPLETED','TASK_POSITIONING_STARTED','PICKUP_FORK_INSERTED','DROPOFF_FORK_INSERTED'])
    assert.ok(eventNames[name],name);
  assert.match(reasons.TURN_RATE_UNRESOLVED,/旋回角速度/);
  assert.match(reasons.HANDLING_PHASES_UNRESOLVED,/荷役/);
});
test('turning positioning and fork phases form exclusive time categories with exact run duration',()=>{
  const statuses=['idle','moving_empty','turning','positioning_for_pickup','picking_fork_inserted',
    'moving_loaded','positioning_for_dropoff','dropping_fork_inserted','waiting_motion_configuration','idle'];
  const run=conditionFixture();run.scenario.durationMin=.15;run.scenario.warehousePolicy=null;
  run.events=statuses.map((_,i)=>({timeMs:i*1000,sequence:i,type:'SYNTHETIC-STATE'}));
  run.snapshots=statuses.map(status=>({agfs:[{id:'AGF1',status,taskId:'01-SYNTHETIC'}],
    tasks:[{id:'01-SYNTHETIC',kind:'01',status:'assigned',requestedAt:0,assignedAt:1000}],pallets:[],warehouse:{}}));
  run.final=run.snapshots.at(-1);
  const data=analyzeRun(run),row=data.agfs[0];
  for(const status of statuses.slice(0,-1))assert.equal(row.durations[status],1000,status);
  assert.equal(Object.values(row.durations).reduce((a,b)=>a+b,0),9000);
  assert.equal(row.workingMs,7000);assert.equal(data.turningMs,1000);
  assert.equal(data.positioningMs,2000);assert.equal(data.forkHandlingMs,2000);
  assert.equal(data.motionConfigurationWaitMs,1000);
  assert.equal(Object.values(durationTenths(row.durations)).reduce((a,b)=>a+b,0),2);
  for(const status of statuses.slice(1,-2))assert.ok(workingStatuses.includes(status));
  assert.ok(durationStatuses.includes('waiting_motion_configuration'));
});
test('avoidance and interference waits retain exact horizon time and are traffic wait rather than working travel',()=>{
  const run=conditionFixture();run.scenario.durationMin=.05;
  const statuses=['waiting_avoidance','waiting_interference','waiting_traffic','idle'];
  run.events=statuses.map((_,i)=>({timeMs:i*1000,sequence:i,type:'SYNTHETIC-STATE'}));
  run.snapshots=statuses.map(status=>({agfs:[{id:'AGF1',status,taskId:null}],tasks:[],pallets:[],warehouse:{}}));
  run.final=run.snapshots.at(-1);
  const data=analyzeRun(run);
  assert.equal(data.trafficWaitMs,3000);assert.equal(data.avoidanceWaitMs,1000);assert.equal(data.agfs[0].workingMs,0);
  assert.equal(Object.values(data.agfs[0].durations).reduce((a,b)=>a+b,0),3000);
  for(const status of statuses.slice(0,-1))assert.ok(durationStatuses.includes(status));
});
