import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRunConditions,renderRunConditions} from '../src/ui/run-conditions.mjs';
import {conditionCsv,conditionCsvFilename,eventCsv} from '../src/ui/export.mjs';
import {defaultProductStreams} from '../src/core/production-streams.mjs';
import {warehouseLocations} from '../src/map/warehouse-layout.mjs';
import {analyzeRun} from '../src/ui/replay-model.mjs';
import {renderAnalysis} from '../src/ui/analysis-view.mjs';
import {projectBatteryPct} from '../src/core/battery-model.mjs';

/** Synthetic test mapping only: these assignments are not site settings. */
function fixture(){
  return {runId:'SYNTHETIC-CONDITIONS-01',executedAt:'2026-10-01T00:00:00.000Z',scenario:{
    preset:'synthetic-test',durationMin:180,mode:'area_first',fallback:'any',motionModel:'synthetic_graph',
    evidence:{structure:'user-confirmed',inventory:'synthetic',production:'synthetic-test',timing:'synthetic-assumption',
      lineMagazineMap:'synthetic-test-mapping',batteryConsumption:'supplier-assumption-user-relayed'},
    lineCapacity:2,lineIntervalsMin:Array(8).fill(0),lineStartOffsetsMin:Array(8).fill(0),
    productStreams:defaultProductStreams([11,12,13,14,15,16,17,18],[1,2,3,4,5,6,7,8]),
    lineMagazineMap:{L1:'M1',L2:'M1',L3:'M2',L4:'M2',L5:'M3',L6:'M3',L7:'M4',L8:'M5'},
    magazineEmptyRecoveryPolicy:'next_takt',productionModel:'empty_pallet_supply',
    magazines:Array.from({length:5},(_,i)=>({id:'M'+(i+1),quantity:10,capacity:20,trigger:3,refillBatch:10})),
    aligners:Array.from({length:5},(_,i)=>({id:'AL'+(i+1),quantity:10})),
    wrapper:{inputCapacity:1,outputCapacity:2,inboundAgfLimit:3},
    times:{emptyMin:2,loadedMin:3,pickupMin:.5,dropoffMin:.5,wrapMin:3.3,labelMin:.2,exitMin:.2,chargeTravelMin:2},
    agfs:['CHARGE-PLACE1','CHARGE-PLACE2','HP1','HP2'].map((currentNodeId,i)=>({id:'AGF'+(i+1),area:'WH',currentNodeId,batteryPct:100,status:'idle'})),
    initialParking:{evidence:'user-confirmed-initial-placement',placeIds:['CHARGE-PLACE1','CHARGE-PLACE2','HP1','HP2']},
    postTaskPolicy:{evidence:'user-confirmed-shared-priority',waitingPriority:['HP1','HP2','PILLAR-WAIT-E','PILLAR-WAIT-W']},
    chargerIds:['CHARGER1','CHARGER2'],chargePlaceIds:['CHARGE-PLACE1','CHARGE-PLACE2'],
    battery:{consumptionModel:'active_time',activeReferenceMin:360,activeReferenceConsumptionPct:70,
      reservePct:40,chargeStartPct:40,chargeTargetPct:80,chargeMinPerPct:2.4},
    warehouse:warehouseLocations(),warehousePolicy:{evidence:'synthetic-test-allocation',
      rowAssignments:[{rowId:'WB1-R01',usage:'normal',sourceLineId:'L1'},{rowId:'WB1-R02',usage:'special',sourceLineId:null}],
      rowPriority:{L1:['WB1-R01'],SPECIAL:['WB1-R02']}},
    operationalTopology:{graphId:'SYNTHETIC-EDGE-TEST',evidence:'synthetic-assumption',coordinateSystem:'synthetic-display',
      readiness:{physicalEtaAllowed:false},edges:[{id:'TEST-E1',fromNodeId:'FROM',toNodeId:'TO',distanceMm:10000,
        speedMmPerSec:{empty:900,loaded:650,charge:700,wait:600},accessScopes:[]}],nodes:[]},
    manualRequests:[],alignerRefillEvents:[],temporaryPallets:[],magazineUses:[],alignerReadyEvents:[]
  },events:[],snapshots:[]};
}
const find=(rows,category,key,subkey='')=>rows.find(r=>r.category===category&&r.key===key&&r.subkey===subkey)?.value;

test('saved selection conditions include charge-priority eligibility only when post-task policy is enabled',()=>{
  const run=fixture();
  const eligibility=find(buildRunConditions(run),'AGF','selection','eligibility');
  assert.match(eligibility,/dispatch_pending/);
  assert.match(eligibility,/batteryPct > chargeStartPct/);
  delete run.scenario.postTaskPolicy;
  const legacyEligibility=find(buildRunConditions(run),'AGF','selection','eligibility');
  assert.doesNotMatch(legacyEligibility,/dispatch_pending|chargeStartPct/);
  assert.match(legacyEligibility,/batteryPct > reservePct/);
});

test('conditions are obtained only from the saved run and preserve run identity and evidence',()=>{
  const run=fixture(),form=structuredClone(run.scenario),before=structuredClone(run);
  const conditions=buildRunConditions(run);
  form.durationMin=999;form.productStreams[0].intervalMin=999;form.lineMagazineMap.L1='M5';
  assert.deepEqual(buildRunConditions(run),conditions);
  assert.deepEqual(run,before);
  assert.equal(find(conditions,'RUN','id'),'SYNTHETIC-CONDITIONS-01');
  assert.equal(find(conditions,'RUN','executedAt'),'2026-10-01T00:00:00.000Z');
  assert.equal(find(conditions,'RUN','durationMin'),180);
  assert.ok(conditions.some(r=>r.evidence==='synthetic-test-mapping'));
});

test('conditions contain all eight intervals offsets mapping and four explicit product toggles',()=>{
  const rows=buildRunConditions(fixture());
  for(let i=1;i<=8;i++){
    assert.equal(find(rows,'PRODUCTION','L'+i,'intervalMin'),10+i);
    assert.equal(find(rows,'PRODUCTION','L'+i,'offsetMin'),i);
    assert.equal(find(rows,'PRODUCTION','L'+i,'magazineId'),fixture().scenario.lineMagazineMap['L'+i]);
    assert.equal(find(rows,'PRODUCTION','L'+i,'normal-full.enabled'),true);
    for(const variant of ['normal-partial','special-full','special-partial'])
      assert.equal(find(rows,'PRODUCTION','L'+i,variant+'.enabled'),false);
    for(const variant of ['normal-full','normal-partial','special-full','special-partial']){
      assert.equal(find(rows,'PRODUCTION','L'+i,variant+'.intervalMin'),10+i);
      assert.equal(find(rows,'PRODUCTION','L'+i,variant+'.offsetMin'),i);
    }
  }
});

test('initial equipment quantities capacities and AGF stops are retained independently of charger devices',()=>{
  const rows=buildRunConditions(fixture());
  for(let i=1;i<=5;i++){
    assert.equal(find(rows,'MAGAZINE','M'+i,'initialQuantity'),10);
    assert.equal(find(rows,'ALIGNER','AL'+i,'initialQuantity'),10);
    assert.equal(find(rows,'MAGAZINE','M'+i,'trigger'),3);
    assert.equal(find(rows,'MAGAZINE','M'+i,'refillBatch'),10);
  }
  ['CHARGE-PLACE1','CHARGE-PLACE2','HP1','HP2'].forEach((id,i)=>assert.equal(find(rows,'AGF','AGF'+(i+1),'initialPosition'),id));
  assert.equal(find(rows,'EQUIPMENT','palletizer','bufferCapacity'),2);
  assert.equal(find(rows,'WRAPPER','settings','inputCapacity'),1);
  assert.equal(find(rows,'WRAPPER','settings','outputCapacity'),2);
  assert.equal(find(rows,'CHARGING','chargers','count'),2);
  assert.equal(find(rows,'CHARGING','chargePlace','1'),'CHARGE-PLACE1');
  assert.equal(find(rows,'CHARGING','charger','1'),'CHARGER1');
});

test('selection destination priority battery rule fallback waiting and charging thresholds are reproducible',()=>{
  const run=fixture(),rows=buildRunConditions(run);
  assert.equal(find(rows,'AGF','mode'),'area_first');
  assert.equal(find(rows,'AGF','selection','destinationAreaPriority'),true);
  assert.equal(find(rows,'AGF','selection','batteryOrder'),'ascending');
  assert.equal(find(rows,'AGF','selection','fallback'),'any');
  assert.deepEqual([1,2,3,4].map(i=>find(rows,'AGF','waitingPriority',String(i))),run.scenario.postTaskPolicy.waitingPriority);
  for(const [key,value] of Object.entries(run.scenario.battery))assert.equal(find(rows,'BATTERY','settings',key),value);
  for(let i=1;i<=4;i++)assert.equal(find(rows,'AGF','AGF'+i,'initialBatteryPct'),100);
  run.scenario.mode='low_battery_first';
  assert.equal(find(buildRunConditions(run),'AGF','selection','destinationAreaPriority'),false);
});

test('exact wrapper timing and each graph edge movement speed are included without measured ETA claims',()=>{
  const rows=buildRunConditions(fixture());
  for(const [key,value] of Object.entries(fixture().scenario.times))assert.equal(find(rows,'TIMING','settings',key),value);
  for(const [key,value] of Object.entries(fixture().scenario.operationalTopology.edges[0].speedMmPerSec))
    assert.equal(find(rows,'GRAPH_SPEED','TEST-E1',key),value);
  assert.equal(find(rows,'GRAPH_EDGE','TEST-E1','distanceMm'),10000);
  assert.equal(find(rows,'RUN','physicalEtaAllowed'),false);
  assert.ok(rows.filter(r=>r.category==='GRAPH_SPEED').every(r=>r.evidence==='synthetic-assumption'));
});

test('fixed time conditions retain empty loaded charging and handling times instead of fabricated graph speeds',()=>{
  const run=fixture();run.scenario.motionModel='fixed_time';delete run.scenario.operationalTopology;
  const rows=buildRunConditions(run);
  assert.equal(find(rows,'TIMING','settings','emptyMin'),2);
  assert.equal(find(rows,'TIMING','settings','loadedMin'),3);
  assert.equal(find(rows,'TIMING','settings','chargeTravelMin'),2);
  assert.equal(find(rows,'RUN','motionModel'),'fixed_time');
  assert.equal(rows.filter(r=>r.category==='GRAPH_SPEED').length,0);
});

test('all warehouse rows show block row owner and priority including unassigned rows',()=>{
  const rows=buildRunConditions(fixture());
  assert.equal(rows.filter(r=>r.category==='WAREHOUSE'&&r.subkey==='owner').length,29);
  assert.equal(find(rows,'WAREHOUSE','WB1-R01','owner'),'L1');
  assert.equal(find(rows,'WAREHOUSE','WB1-R02','owner'),'SPECIAL');
  assert.equal(find(rows,'WAREHOUSE','WB1-R03','owner'),'UNASSIGNED');
  assert.equal(find(rows,'WAREHOUSE','WB1-R01','rowPriority'),1);
  assert.equal(find(rows,'WAREHOUSE','WB1-R03','rowPriority'),null);
  assert.equal(find(rows,'WAREHOUSE','EB2-R03','block'),'EB2');
  assert.equal(find(rows,'WAREHOUSE','EB2-R03','row'),3);
  assert.equal(find(rows,'WAREHOUSE','capacity','theoreticalPL'),802);
});

test('unset magazine map and empty recovery policy remain visibly unresolved and never choose a site rule',()=>{
  const run=fixture();run.scenario.lineMagazineMap={};run.scenario.magazineEmptyRecoveryPolicy=null;
  const rows=buildRunConditions(run);
  for(let i=1;i<=8;i++)assert.equal(find(rows,'PRODUCTION','L'+i,'magazineId'),null);
  assert.equal(find(rows,'MAGAZINE','settings','magazineEmptyRecoveryPolicy'),null);
  assert.match(renderRunConditions(run),/未設定/);
  assert.ok(!renderRunConditions(run).includes('次タクトから再開'));
  assert.ok(conditionCsv(run).includes('MAGAZINE,settings,magazineEmptyRecoveryPolicy,UNSET,unconfigured'));
});

test('legacy aligner readiness is labelled as legacy derivation only for older saved scenarios',()=>{
  const run=fixture();run.scenario.aligners=[{id:'AL1',ready:true},{id:'AL2',ready:false}];
  const rows=buildRunConditions(run);
  assert.equal(find(rows,'ALIGNER','AL1','initialQuantity'),10);
  assert.equal(find(rows,'ALIGNER','AL2','initialQuantity'),0);
  assert.equal(rows.find(r=>r.category==='ALIGNER'&&r.key==='AL1'&&r.subkey==='initialQuantity').evidence,'legacy-ready-derived-model');
});

test('conditions CSV is a distinct BOM file with structured keys and complete saved scenario payload',()=>{
  const run=fixture(),csv=conditionCsv(run,'CSV-RUN');
  assert.ok(csv.startsWith('\ufeffcategory,key,subkey,value,evidence\r\n'));
  assert.ok(csv.includes('RUN,id,,CSV-RUN,'));
  assert.ok(csv.includes('PRODUCTION,L8,intervalMin,18,'));
  assert.ok(csv.includes('WAREHOUSE,WB1-R03,owner,UNASSIGNED,'));
  assert.ok(csv.includes('MAGAZINE,settings,magazineEmptyRecoveryPolicy,next_takt,'));
  assert.ok(csv.includes('""lineMagazineMap""'));
  assert.equal(conditionCsvFilename('CSV-RUN'),'CSV-RUN-conditions.csv');
  assert.notEqual(conditionCsvFilename('CSV-RUN'),'CSV-RUN-events.csv');
  assert.ok(eventCsv(run,'CSV-RUN').startsWith('\ufeffrunId,mode,'));
  assert.equal(conditionCsv(run,'CSV-RUN'),csv);
});

test('conditions output safely escapes CSV and rendered Japanese labels and uses saved values',()=>{
  const run=fixture();run.scenario.preset='sample, "quoted"\n<script>';run.scenario.times.labelMin=7.125;
  const csv=conditionCsv(run),html=renderRunConditions(run);
  assert.ok(csv.includes('"sample, ""quoted""\n<script>"'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('シミュレーション条件'));
  assert.ok(html.includes('GWVIII'));
  assert.ok(html.includes('未割当'));
  assert.ok(html.includes('7.125'));
});

test('explicit unassigned rows and omitted rows use the same conditions owner and assigned capacity',()=>{
  const run=fixture();run.scenario.warehousePolicy.rowAssignments.push({rowId:'WB1-R03',usage:'unassigned',sourceLineId:null});
  const rows=buildRunConditions(run);
  assert.equal(find(rows,'WAREHOUSE','WB1-R03','owner'),'UNASSIGNED');
  assert.equal(find(rows,'WAREHOUSE','WB1-R04','owner'),'UNASSIGNED');
  assert.equal(find(rows,'WAREHOUSE','capacity','assignedPL'),52);
  assert.equal(find(rows,'WAREHOUSE','capacity','theoreticalPL'),802);
});

test('projected condition objects cannot mutate saved input events or graph readiness',()=>{
  const run=fixture();run.scenario.alignerRefillEvents=[{timeMs:60000,alignerId:'AL1',operationType:'individual'}];
  const before=structuredClone(run.scenario),rows=buildRunConditions(run);
  rows.find(r=>r.category==='INPUTS'&&r.key==='alignerRefillEvents'&&r.subkey==='1').value.timeMs=999;
  rows.find(r=>r.category==='GRAPH'&&r.subkey==='readiness').value.physicalEtaAllowed=true;
  assert.deepEqual(run.scenario,before);
});

test('inventory event CSV keeps actual quantities aligner identity operation and production recovery',()=>{
  const run=fixture();run.events=[{timeMs:0,sequence:0,type:'RUN_STARTED'},
    {timeMs:60000,sequence:1,type:'EMPTY_PALLET_DISCHARGED',magazineId:'M1',lineId:'L1',palletId:'SYNTHETIC-P1',quantityBefore:4,quantityAfter:3},
    {timeMs:65000,sequence:2,type:'ALIGNER_STACK_PICKED',alignerId:'AL1',taskId:'03-TEST',agfId:'AGF1',quantityBefore:10,quantityAfter:0,pickedAt:65000},
    {timeMs:70000,sequence:3,type:'ALIGNER_REFILLED',alignerId:'AL1',operationType:'individual',quantityBefore:0,quantityAfter:10,operatedAt:70000},
    {timeMs:80000,sequence:4,type:'PRODUCTION_RECOVERY_WAIT_NEXT_TAKT',lineId:'L1',magazineId:'M1',policy:'next_takt',count:1}];
  run.snapshots=run.events.map(()=>({tasks:[]}));
  const lines=eventCsv(run,'INVENTORY-CSV').slice(1).split('\r\n'),columns=lines[0].split(','),values=lines.slice(2).map(line=>line.split(','));
  const get=(row,key)=>row[columns.indexOf(key)];
  assert.equal(get(values[0],'quantityBefore'),'4');
  assert.equal(get(values[0],'quantityAfter'),'3');
  assert.equal(get(values[1],'alignerId'),'AL1');
  assert.equal(get(values[1],'pickedAt'),'65000');
  assert.equal(get(values[2],'operationType'),'individual');
  assert.equal(get(values[2],'operatedAt'),'70000');
  assert.equal(get(values[3],'policy'),'next_takt');
  assert.equal(get(values[3],'count'),'1');
});

test('pickup permission wait is separate from travel handling and drop wait and consumes no working battery',()=>{
  const run=fixture();run.scenario.durationMin=1000/60000;run.scenario.warehousePolicy=null;
  const transitions=[[0,'idle','queued'],[100,'moving_empty','assigned'],[300,'waiting_pickup','wait_pickup'],
    [450,'moving_empty','assigned'],[550,'moving_loaded','picked'],[750,'moving_loaded','wait_drop'],[1000,'idle','completed']];
  run.events=transitions.map(([timeMs],sequence)=>({timeMs,sequence,type:'SYNTHETIC-STATE-CHANGE'}));
  run.snapshots=transitions.map(([timeMs,status,taskStatus])=>({agfs:[{id:'AGF1',status,batteryPct:100,taskId:'03-TEST',
    ...(timeMs===450?{movement:{current:null,steps:[],stepIndex:0}}:{})}],
    tasks:[{id:'03-TEST',kind:'03',status:taskStatus,requestedAt:0,assignedAt:100}],warehouse:{},pallets:[]}));
  run.final=run.snapshots.at(-1);
  const data=analyzeRun(run),durations=data.agfs[0].durations;
  assert.equal(durations.idle,100);assert.equal(durations.moving_empty,200);
  assert.equal(durations.handling_pickup,100);assert.equal(durations.moving_loaded,200);
  assert.equal(durations.waiting_pickup,150);assert.equal(durations.wait_drop,250);
  assert.equal(Object.values(durations).reduce((a,b)=>a+b,0),1000);
  assert.equal(data.agfs[0].workingMs,500);assert.equal(data.agfs[0].utilizationPct,50);
  assert.equal(data.pickupWaitMs,150);assert.equal(data.dropWaitMs,250);
  for(const index of [2,5])assert.equal(projectBatteryPct(run.snapshots[index].agfs[0],run.snapshots[index].tasks[0],run.scenario.battery,150),100);
  for(const index of [1,3,4])assert.ok(projectBatteryPct(run.snapshots[index].agfs[0],run.snapshots[index].tasks[0],run.scenario.battery,150)<100);
  assert.ok(renderAnalysis(run,data).includes('metric-label">荷受け許可待ち'));
});
