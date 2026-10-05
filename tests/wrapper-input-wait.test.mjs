import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {createLegacyScenario} from '../src/ui/scenario.mjs';
import {analyzeRun} from '../src/ui/replay-model.mjs';

// Entirely invented topology and timings for causal, capacity and position tests.
export function wrapperWaitingScenario(){
  const s=createLegacyScenario('manual');
  s.durationMin=10;s.motionModel='synthetic_graph';s.lineCapacity=2;
  s.wrapper={inputCapacity:1,outputCapacity:1,inboundAgfLimit:3};s.times.wrapMin=20;
  s.productionEvents=Array.from({length:4},(_,i)=>({timeMs:0,lineId:'L'+(i+1),
    palletId:'SYN-WRAPPER-'+(i+1),destinationLocationId:s.generatedDestinationIds[i]}));
  s.manualRequests=[];s.magazineUses=[];s.alignerReadyEvents=[];
  s.motionControl={turnRateDegPerSec:45,turnRateEvidence:'synthetic-assumption',turningConsumesBattery:true,
    pickupPositioningMin:.001,pickupForkInsertedMin:.001,dropoffPositioningMin:.001,
    dropoffForkInsertedMin:.001,handlingEvidence:'synthetic-assumption'};
  s.agfs.forEach((a,i)=>{a.currentNodeId='START'+i;a.area='PZ';a.headingDeg=0;a.batteryPct=100;});
  const nodes=[];const edges=[];const bindings=[];
  const node=(id,x,y,type,exclusiveTraffic=true)=>nodes.push({id,x,y,type,exclusiveTraffic,areaId:'PZ',approvalState:'synthetic-validated'});
  const edge=(id,fromNodeId,toNodeId)=>edges.push({id,fromNodeId,toNodeId,distanceMm:1000,
    speedMmPerSec:{empty:1000,loaded:1000,charge:1000},approvalState:'synthetic-validated',
    accessScopes:['empty','loaded','charge'].map(movement=>({movement,taskTypes:['*']})),
    lanePolicy:{laneCount:1,simultaneousPassing:'no-alternating'},lanes:[{id:id+'-LANE',direction:'both'}],occupancyResourceIds:[]});
  for(let i=0;i<4;i++){
    node('START'+i,i*100,0,'home');node('PGW'+i,i*100,100,'pickup');
    edge('PICK'+i,'START'+i,'PGW'+i);edge('DELIVER'+i,'PGW'+i,'WRAP-IN');
    bindings.push({pattern:'L'+(i+1),nodeId:'PGW'+i});
  }
  node('WRAP-IN',500,100,'dropoff');node('WRAP-OUT',600,100,'pickup');
  node('STORE',700,100,'dropoff');node('CHARGE',800,100,'charge');
  edge('OUT','WRAP-IN','WRAP-OUT');edge('STORE-E','WRAP-OUT','STORE');edge('CHARGE-E','STORE','CHARGE');
  bindings.push({pattern:'WRAP-INPUT',nodeId:'WRAP-IN'},{pattern:'WRAP-OUTPUT',nodeId:'WRAP-OUT'},
    {pattern:'WB*',nodeId:'STORE'},{pattern:'EB*',nodeId:'STORE'},{pattern:'CHARGE-PLACE',nodeId:'CHARGE'});
  s.operationalTopology={schemaVersion:'operational-topology-v1',datasetKind:'synthetic',evidence:'synthetic-assumption',
    coordinateSystem:'synthetic-display',readiness:{operationalRoutingReady:true,physicalEtaAllowed:false},
    nodes,edges,interfaceBindings:bindings,shutters:[]};
  return s;
}

test('full or reserved wrapper input keeps loaded 01 at its own PGW with its task and pallet',()=>{
  const r=simulate(wrapperWaitingScenario());
  const waiting=r.final.agfs.filter(a=>a.status==='waiting_wrapper_input');assert.ok(waiting.length>0);
  for(const a of waiting){
    const t=r.final.tasks.find(t=>t.id===a.taskId);
    assert.equal(a.currentNodeId,'PGW'+(Number(t.originId.slice(1))-1));
    assert.equal(a.carriedPalletId,t.palletId);assert.equal(t.waitReason,'WRAPPER_INPUT');
    assert.ok(!r.events.some(e=>e.type==='SEGMENT_ENTERED'&&e.taskId===t.id&&e.movement==='loaded'));
  }
  for(const snap of r.snapshots)assert.ok(snap.wrapper.input.length+snap.wrapper.reservedInputTaskIds.length<=1);
  assert.ok(analyzeRun(r).agfs.some(a=>a.durations.waiting_wrapper_input>0));
});
test('waiting pickup turns once towards its valid wrapper departure without moving during the wait',()=>{
  const r=simulate(wrapperWaitingScenario());
  for(const a of r.final.agfs.filter(a=>a.status==='waiting_wrapper_input')){
    const picked=r.events.find(e=>e.type==='TASK_PICKED'&&e.taskId===a.taskId);
    const turns=r.events.filter(e=>e.type==='TURN_STARTED'&&e.agfId===a.id&&e.timeMs>=picked.timeMs);
    assert.equal(turns.length,1);assert.equal(turns[0].targetHeadingDeg,0);
    const wait=r.events.find(e=>e.type==='WRAPPER_INPUT_WAITING'&&e.taskId===a.taskId);
    const completed=r.events.find(e=>e.type==='TURN_COMPLETED'&&e.agfId===a.id&&e.startedAt===turns[0].timeMs);
    assert.ok(completed.sequence<wait.sequence);
    assert.ok(r.snapshots.slice(wait.sequence).every(s=>s.agfs.find(x=>x.id===a.id).currentNodeId===a.currentNodeId));
  }
});
test('wrapper permission release reevaluates waiting reservations and permits one departure at capacity one',()=>{
  const s=wrapperWaitingScenario();s.wrapper.permission=false;
  s.permissionEvents=[{timeMs:120000,target:'wrapper',targetId:'WRAP-INPUT',permitted:true}];
  const r=simulate(s);
  assert.ok(!r.events.some(e=>e.type==='SEGMENT_ENTERED'&&e.movement==='loaded'&&e.timeMs<120000));
  assert.ok(r.events.some(e=>e.type==='WRAPPER_INPUT_RESERVED'&&e.timeMs===120000));
  assert.ok(r.events.some(e=>e.type==='TASK_COMPLETED'&&e.kind==='01'));
  for(const snap of r.snapshots)assert.ok(snap.wrapper.input.length+snap.wrapper.reservedInputTaskIds.length<=1);
  assert.deepEqual(simulate(s).events,r.events);
});

test('wrapper waiting clocks agree with replay and exclude departure turning and traffic',()=>{
  const run=simulate(wrapperWaitingScenario());
  const analysis=analyzeRun(run);
  const recorded=run.final.tasks.reduce((sum,t)=>sum+(t.wrapperInputWaitMs??0),0);
  assert.equal(recorded,analysis.wrapperInputWaitMs);
  const first=run.events.find(e=>e.type==='WRAPPER_INPUT_WAIT_ENDED');
  assert.ok(first);
  const task=run.final.tasks.find(t=>t.id===first.taskId);
  const pickup=run.events.find(e=>e.type==='TASK_PICKED'&&e.taskId===task.id);
  assert.ok(run.events.some(e=>e.type==='TURN_STARTED'&&e.agfId===first.agfId&&e.timeMs>=pickup.timeMs&&e.timeMs<first.timeMs));
  assert.equal(first.waitMs,0);
  assert.equal(task.wrapperInputWaitMs,0);
});

test('an unrelated production event preserves a reserved delivery shutter wait and its saved duration category',()=>{
  const scenario=wrapperWaitingScenario();scenario.durationMin=1;
  scenario.agfs.forEach((agf,index)=>{agf.blocked=index>0;});
  scenario.productionEvents=scenario.productionEvents.slice(0,2);
  scenario.productionEvents[1].timeMs=10000;
  scenario.operationalTopology.edges.find(edge=>edge.id==='DELIVER0').shutterId='SYN-CLOSED';
  scenario.operationalTopology.shutters=[{id:'SYN-CLOSED',initiallyPassable:false}];
  const run=simulate(scenario),agf=run.final.agfs[0],task=run.final.tasks.find(task=>task.id===agf.taskId);
  assert.ok(run.events.some(event=>event.type==='SHUTTER_WAITING'&&event.agfId===agf.id));
  assert.equal(agf.status,'waiting_traffic');
  assert.equal(agf.movement.waitingReason,'SHUTTER');
  assert.ok(run.final.wrapper.reservedInputTaskIds.includes(task.id));
  assert.equal(task.wrapperInputWaitMs,0);
  assert.equal(analyzeRun(run).wrapperInputWaitMs,0);
  assert.ok(analyzeRun(run).agfs[0].durations.waiting_traffic>0);
});

function overtakingScenario(){
  const s=wrapperWaitingScenario();s.wrapper.permission=false;s.durationMin=2;
  const g=s.operationalTopology;
  g.nodes=[['BEHIND',0,0,'home'],['FRONT',100,0,'pickup'],['AHEAD',200,0,'junction'],
    ['TARGET',300,0,'pickup'],['N-START',0,-100,'junction'],['N-END',200,-100,'junction'],
    ['WRAP-IN',400,0,'dropoff'],['WRAP-OUT',500,0,'pickup'],['STORE',600,0,'dropoff'],
    ['CHARGE',700,0,'charge'],['PARK3',-100,100,'home'],['PARK4',-200,100,'home']]
    .map(([id,x,y,type])=>({id,x,y,type,exclusiveTraffic:true,areaId:'PZ',approvalState:'synthetic-validated'}));
  const prototype=s.operationalTopology.edges[0];
  g.edges=[['SOUTH-BEFORE','BEHIND','FRONT'],['SOUTH-AFTER','FRONT','AHEAD'],['SOUTH-TARGET','AHEAD','TARGET'],
    ['WRAPPER','FRONT','WRAP-IN'],['TARGET-WRAP','TARGET','WRAP-IN'],['CHANGE-IN','BEHIND','N-START'],
    ['NORTH','N-END','N-START'],['CHANGE-OUT','N-END','AHEAD'],['OUT','WRAP-IN','WRAP-OUT'],
    ['STORE','WRAP-OUT','STORE'],['CHARGE-E','STORE','CHARGE']].map(([id,fromNodeId,toNodeId])=>({
      ...structuredClone(prototype),id,fromNodeId,toNodeId,
      lanes:[{id:id+'-LANE',direction:id==='NORTH'?'forward':id.startsWith('SOUTH')?'forward':'both'}],
      distanceMm:id==='NORTH'?10000:1000}));
  g.interfaceBindings=g.interfaceBindings.filter(b=>!b.pattern.startsWith('L'));
  g.interfaceBindings.push({pattern:'L1',nodeId:'FRONT'},{pattern:'L2',nodeId:'TARGET'});
  g.overtakingPlans=[{id:'SYN-ONLY-WRAPPER-BYPASS',blockedNodeId:'FRONT',fromNodeId:'BEHIND',rejoinNodeId:'AHEAD',
    edgeIds:['CHANGE-IN','NORTH','CHANGE-OUT'],temporaryReverseEdgeIds:['NORTH'],
    resourceIds:['BYPASS-ENTRY','BYPASS-OPPOSITE','BYPASS-SIDE','BYPASS-REJOIN'],evidence:'synthetic-assumption'}];
  s.agfs.forEach((a,i)=>{a.currentNodeId=['FRONT','BEHIND','PARK3','PARK4'][i];a.blocked=i>1;a.headingDeg=0;});
  s.productionEvents=s.productionEvents.slice(0,2);s.productionEvents[1].timeMs=5000;
  return s;
}
test('a declared wrapper-only bypass traverses the opposite lane and rejoins without teleportation',()=>{
  const r=simulate(overtakingScenario());
  const started=r.events.find(e=>e.type==='OVERTAKING_STARTED');assert.ok(started);
  const completed=r.events.find(e=>e.type==='OVERTAKING_COMPLETED');assert.ok(completed);
  const entered=r.events.filter(e=>e.type==='SEGMENT_ENTERED'&&e.agfId===started.agfId&&
    e.sequence>started.sequence&&e.sequence<completed.sequence);
  assert.deepEqual(entered.map(e=>e.edgeId),['CHANGE-IN','NORTH','CHANGE-OUT']);
  assert.equal(entered[1].fromNodeId,'N-START');assert.equal(entered[1].toNodeId,'N-END');
  assert.equal(completed.nodeId,'AHEAD');
  assert.ok(r.events.some(e=>e.type==='SEGMENT_ENTERED'&&e.edgeId==='SOUTH-TARGET'&&e.sequence>completed.sequence));
  assert.ok(r.snapshots.slice(started.sequence,completed.sequence).every(s=>s.traffic.overtaking.length===1));
});
test('wrapper reservation during an active bypass never starts the stopped front AGF until lease release',()=>{
  const s=overtakingScenario();s.permissionEvents=[{timeMs:8000,target:'wrapper',targetId:'WRAP-INPUT',permitted:true}];
  const r=simulate(s),completed=r.events.find(e=>e.type==='OVERTAKING_COMPLETED');assert.ok(completed);
  const reserved=r.events.find(e=>e.type==='WRAPPER_INPUT_RESERVED'&&e.agfId==='AGF1');
  assert.ok(reserved&&reserved.timeMs<completed.timeMs);
  const depart=r.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId==='AGF1'&&e.movement==='loaded');
  assert.ok(depart&&depart.sequence>completed.sequence);
  assert.deepEqual(simulate(s).events,r.events);
});

test('wrapper permission returning between bypass events records the departure wait transition for replay',()=>{
  for(const timeMs of [9000,15000]){
    const scenario=overtakingScenario();
    scenario.permissionEvents=[{timeMs,target:'wrapper',targetId:'WRAP-INPUT',permitted:true}];
    const run=simulate(scenario),completed=run.events.find(event=>event.type==='OVERTAKING_COMPLETED');
    assert.ok(completed);
    const departure=run.events.find(event=>event.type==='SEGMENT_ENTERED'&&event.agfId==='AGF1'&&event.movement==='loaded');
    assert.ok(departure&&departure.sequence>completed.sequence);
    const recordedWait=run.final.tasks.reduce((sum,task)=>sum+(task.wrapperInputWaitMs??0),0);
    assert.equal(recordedWait,analyzeRun(run).wrapperInputWaitMs,'permission returned at '+timeMs);
    assert.deepEqual(simulate(scenario).events,run.events);
  }
});
test('an occupied rejoin node rejects exceptional passing and holds the follower before entry',()=>{
  const s=overtakingScenario();s.agfs[2].currentNodeId='AHEAD';
  const r=simulate(s);
  assert.ok(!r.events.some(e=>e.type==='OVERTAKING_STARTED'));
  assert.equal(r.final.agfs[1].currentNodeId,'BEHIND');
  assert.equal(r.final.agfs[1].status,'waiting_traffic');
});
