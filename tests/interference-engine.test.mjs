import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {createLegacyScenario} from '../src/ui/scenario.mjs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';

// Every coordinate, distance, timing, and collision resource below is an
// explicit synthetic software fixture. It is not a site retreat or safety model.
function interferenceScenario(){
  const s=createLegacyScenario('manual');
  s.durationMin=2;s.motionModel='synthetic_graph';
  s.motionControl={turnRateDegPerSec:45,turnRateEvidence:'synthetic-assumption',turningConsumesBattery:true,
    pickupPositioningMin:.001,pickupForkInsertedMin:.001,
    dropoffPositioningMin:.001,dropoffForkInsertedMin:.001,handlingEvidence:'synthetic-assumption'};
  s.times={...s.times,wrapMin:100};s.wrapper={inputCapacity:2,outputCapacity:2,inboundAgfLimit:2};
  s.agfs=s.agfs.map((a,i)=>({...a,area:'PZ',currentNodeId:i===1?'START2':'START1',headingDeg:0,
    batteryPct:99+i/10,blocked:i>1}));
  const nodes=[['START1',0,0,'home'],['START2',0,100,'home'],['PGW1',100,0,'pickup'],['PGW2',100,100,'pickup'],
    ['WRAP-IN',200,50,'dropoff'],['WRAP-OUT',300,50,'pickup'],['STORE',400,50,'dropoff'],
    ['CHARGE',0,300,'charge'],['SYNTHETIC-BAY2',0,200,'wait']]
    .map(([id,x,y,type])=>({id,x,y,type,areaId:'PZ',approvalState:'synthetic-validated'}));
  const make=(id,fromNodeId,toNodeId,{distanceMm=1000,movements=['empty','loaded','charge'],resources=[]}={})=>({
    id,fromNodeId,toNodeId,distanceMm,speedMmPerSec:{empty:1000,loaded:1000,charge:1000},
    approvalState:'synthetic-validated',accessScopes:movements.map(movement=>({movement,taskTypes:['*']})),
    lanePolicy:{laneCount:1,simultaneousPassing:'no-alternating'},lanes:[{id:id+'-LANE',direction:'both'}],
    occupancyResourceIds:resources});
  const edges=[make('TO-PGW1','START1','PGW1',{distanceMm:20000,movements:['empty'],resources:['SYNTHETIC-CONFLICT']}),
    make('TO-PGW2','START2','PGW2',{movements:['empty'],resources:['SYNTHETIC-CONFLICT']}),
    make('PGW1-TO-WRAP','PGW1','WRAP-IN',{movements:['loaded']}),
    make('PGW2-TO-WRAP','PGW2','WRAP-IN',{movements:['loaded']}),
    make('WRAP-CROSS','WRAP-IN','WRAP-OUT'),make('STORE-ACCESS','WRAP-OUT','STORE'),
    make('CHARGE-ACCESS','START1','CHARGE',{movements:['charge']}),
    make('EXPLICIT-BAY2','START2','SYNTHETIC-BAY2',{movements:['empty','loaded']})];
  s.operationalTopology={schemaVersion:'operational-topology-v1',datasetKind:'synthetic',evidence:'synthetic-assumption',
    coordinateSystem:'synthetic-display',readiness:{operationalRoutingReady:true,physicalEtaAllowed:false},nodes,edges,
    interfaceBindings:[{pattern:'L1',nodeId:'PGW1'},{pattern:'L2',nodeId:'PGW2'},
      {pattern:'WRAP-INPUT',nodeId:'WRAP-IN'},{pattern:'WRAP-OUTPUT',nodeId:'WRAP-OUT'},
      {pattern:'WB*',nodeId:'STORE'},{pattern:'EB*',nodeId:'STORE'},{pattern:'CHARGE-PLACE',nodeId:'CHARGE'}],shutters:[],
    avoidancePlans:[{id:'EXPLICIT-SYNTHETIC-RETREAT2',fromNodeId:'START2',viaNodeId:'SYNTHETIC-BAY2',
      outboundEdgeIds:['EXPLICIT-BAY2'],returnEdgeIds:['EXPLICIT-BAY2'],conflictGroupId:'SYNTHETIC-CONFLICT',
      evidence:'synthetic-assumption'}]};
  s.productionEvents=[{timeMs:0,lineId:'L1',palletId:'SYN-INTERFERENCE-1',destinationLocationId:s.generatedDestinationIds[0]},
    {timeMs:0,lineId:'L2',palletId:'SYN-INTERFERENCE-2',destinationLocationId:s.generatedDestinationIds[1]}];
  return s;
}

test('explicit retreat waits for the conflicting vehicle to pass, then turns back and completes its original task',()=>{
  const scenario=interferenceScenario(),run=simulate(scenario);
  const started=run.events.find(e=>e.type==='AVOIDANCE_STARTED');
  assert.ok(started,'the stopped resource waiter has an explicitly declared synthetic retreat');
  assert.equal(started.agfId,'AGF2');assert.equal(started.selectionReason,'ONLY_FEASIBLE_MOVING_AGF');
  const reached=run.events.find(e=>e.type==='AVOIDANCE_REACHED'&&e.agfId===started.agfId);
  const returning=run.events.find(e=>e.type==='AVOIDANCE_RETURN_STARTED'&&e.agfId===started.agfId);
  const returned=run.events.find(e=>e.type==='AVOIDANCE_COMPLETED'&&e.agfId===started.agfId);
  const leaderExited=run.events.find(e=>e.type==='SEGMENT_EXITED'&&e.edgeId==='TO-PGW1');
  assert.ok(reached&&returning&&returned&&leaderExited);
  assert.equal(reached.nodeId,'SYNTHETIC-BAY2');assert.equal(returned.nodeId,'START2');
  assert.ok(reached.timeMs<leaderExited.timeMs,'fixture retreat is reached before the 20 second passing segment ends');
  assert.ok(returning.timeMs>=leaderExited.timeMs,'a missing no-overtaking group does not permit premature retreat return');
  const retreatTurn=run.events.find(e=>e.type==='TURN_STARTED'&&e.agfId==='AGF2'&&e.timeMs>=started.timeMs&&e.timeMs<reached.timeMs);
  const returnTurn=run.events.find(e=>e.type==='TURN_STARTED'&&e.agfId==='AGF2'&&e.timeMs>=returning.timeMs&&e.timeMs<returned.timeMs);
  const resumedTurn=run.events.find(e=>e.type==='TURN_STARTED'&&e.agfId==='AGF2'&&e.timeMs>=returned.timeMs&&e.nodeId==='START2');
  assert.equal(retreatTurn.angleDeg,90);assert.equal(returnTurn.angleDeg,180);assert.equal(resumedTurn.angleDeg,90);
  for(const event of run.events.filter(e=>e.agfId==='AGF2'&&e.timeMs>=started.timeMs&&e.timeMs<=returned.timeMs)){
    if(event.taskId!==undefined)assert.equal(event.taskId,started.taskId);
  }
  const task=run.final.tasks.find(t=>t.id===started.taskId);
  assert.equal(task.kind,'01');assert.equal(task.status,'completed');assert.equal(task.palletId,'SYN-INTERFERENCE-2');
  for(const state of run.snapshots.filter(s=>s.timeMs>=reached.timeMs&&s.timeMs<returning.timeMs)){
    const a=state.agfs.find(a=>a.id==='AGF2');assert.equal(a.currentNodeId,'SYNTHETIC-BAY2');
    if(a.status==='waiting_avoidance')assert.equal(projectAgfPosition(a,run.scenario.operationalTopology,state.timeMs).y,200);
  }
  assert.deepEqual(run.final.traffic.owners,{});
  assert.deepEqual(run.events,simulate(scenario).events);
});

test('a missing retreat plan never uses an existing nearby synthetic bay or teleports the waiter',()=>{
  const s=interferenceScenario();s.operationalTopology.avoidancePlans=[];
  const run=simulate(s),waiting=run.events.find(e=>e.type==='SEGMENT_WAITING'&&e.agfId==='AGF2');
  assert.ok(waiting);assert.ok(run.events.some(e=>e.type==='AVOIDANCE_UNAVAILABLE'&&e.reason==='NO_EXPLICIT_AVOIDANCE_ROUTE'));
  assert.ok(!run.events.some(e=>e.type==='AVOIDANCE_STARTED'||e.edgeId==='EXPLICIT-BAY2'));
  const entered=run.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId==='AGF2'&&e.edgeId==='TO-PGW2');
  const leaderExited=run.events.find(e=>e.type==='SEGMENT_EXITED'&&e.edgeId==='TO-PGW1');
  assert.ok(entered.timeMs>=leaderExited.timeMs);
  for(const snapshot of run.snapshots.filter(s=>s.sequence>=waiting.sequence&&s.timeMs<entered.timeMs)){
    assert.equal(snapshot.agfs.find(a=>a.id==='AGF2').currentNodeId,'START2');
  }
  assert.equal(run.final.tasks.filter(t=>t.kind==='01'&&t.status==='completed').length,2);
});

test('an explicitly declared retreat occupancy resource stays reserved while the AGF waits in the bay',()=>{
  const s=interferenceScenario(),resourceId='SYNTHETIC-BAY2-OCCUPANCY';
  s.operationalTopology.nodes.find(n=>n.id==='SYNTHETIC-BAY2').occupancyResourceIds=[resourceId];
  s.operationalTopology.edges.find(e=>e.id==='EXPLICIT-BAY2').occupancyResourceIds=[resourceId];
  const run=simulate(s),reached=run.events.find(e=>e.type==='AVOIDANCE_REACHED');
  const returning=run.events.find(e=>e.type==='AVOIDANCE_RETURN_STARTED');
  assert.ok(reached.timeMs<returning.timeMs);
  for(const state of run.snapshots.filter(s=>s.sequence>=reached.sequence&&s.sequence<returning.sequence)){
    assert.equal(state.traffic.owners[resourceId],'AGF2','being stopped in the explicit bay does not free its occupied resource');
  }
  assert.deepEqual(run.final.traffic.owners,{});
});

test('same-direction faster follower cannot enter a free alternate lane or exit ahead of its leader',()=>{
  const s=interferenceScenario();s.operationalTopology.avoidancePlans=[];
  for(const e of s.operationalTopology.edges.filter(e=>['TO-PGW1','TO-PGW2'].includes(e.id))){
    e.occupancyResourceIds=[];e.noOvertakingGroupId='SYNTHETIC-TWO-LANE-GROUP';e.noOvertakingForwardDirection='east';
    e.lanes=[{id:e.id+'-1',direction:'both'},{id:e.id+'-2',direction:'both'}];
    e.lanePolicy={laneCount:2,simultaneousPassing:'yes'};
  }
  const run=simulate(s),leaderExit=run.events.find(e=>e.type==='SEGMENT_EXITED'&&e.edgeId==='TO-PGW1');
  const followerEnter=run.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.edgeId==='TO-PGW2');
  const followerExit=run.events.find(e=>e.type==='SEGMENT_EXITED'&&e.edgeId==='TO-PGW2');
  assert.ok(run.events.some(e=>e.type==='SEGMENT_WAITING'&&e.agfId==='AGF2'&&e.reason==='NO_OVERTAKING'));
  assert.ok(followerEnter.timeMs>=leaderExit.timeMs);assert.ok(followerExit.timeMs>leaderExit.timeMs);
  assert.ok(!run.events.some(e=>e.type==='AVOIDANCE_STARTED'));
});

function handlingScenario(laneCount){
  const s=interferenceScenario();s.operationalTopology.avoidancePlans=[];
  s.productionEvents[1].timeMs=1500;
  Object.assign(s.motionControl,{pickupPositioningMin:1/60,pickupForkInsertedMin:10/60});
  Object.assign(s.operationalTopology.nodes.find(n=>n.id==='PGW1'),{
    handlingGroupId:'SYNTHETIC-FRONTAGE',handlingResourceIds:['ORIGINAL-DEVICE-LANE1']});
  for(const e of s.operationalTopology.edges.filter(e=>['TO-PGW1','TO-PGW2'].includes(e.id))){
    e.distanceMm=1000;e.occupancyResourceIds=[];
    e.noOvertakingGroupId='SYNTHETIC-FRONTAGE';e.noOvertakingForwardDirection='east';
    e.lanes=Array.from({length:laneCount},(_,i)=>({id:e.id+'-'+(i+1),resourceId:'ORIGINAL-DEVICE-LANE'+(i+1),direction:'both'}));
    e.lanePolicy={laneCount,simultaneousPassing:laneCount===1?'no-alternating':'yes'};
  }
  return s;
}

test('positioning blocks the frontage and explicit fork insertion permits only a valid free alternate lane',()=>{
  const run=simulate(handlingScenario(2));
  const positioning=run.events.find(e=>e.type==='TASK_POSITIONING_STARTED'&&e.agfId==='AGF1'&&e.operation==='pickup');
  const inserted=run.events.find(e=>e.type==='PICKUP_FORK_INSERTED'&&e.agfId==='AGF1');
  const picked=run.events.find(e=>e.type==='TASK_PICKED'&&e.agfId==='AGF1');
  const follower=run.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId==='AGF2'&&e.edgeId==='TO-PGW2');
  assert.ok(run.events.some(e=>e.type==='SEGMENT_WAITING'&&e.reason==='HANDLING_POSITIONING'));
  assert.ok(follower.timeMs>=inserted.timeMs&&follower.timeMs<picked.timeMs);
  assert.equal(follower.laneId,'TO-PGW2-2');
  assert.ok(!run.events.some(e=>e.type==='SEGMENT_ENTERED'&&e.agfId==='AGF2'&&
    e.timeMs>=positioning.timeMs&&e.timeMs<inserted.timeMs));
  assert.equal(run.snapshots[follower.sequence].traffic.owners['ORIGINAL-DEVICE-LANE1'],'AGF1');
  assert.equal(run.snapshots[follower.sequence].traffic.owners['ORIGINAL-DEVICE-LANE2'],'AGF2');
});

test('fork insertion alone does not override occupied single-lane resources',()=>{
  const run=simulate(handlingScenario(1));
  const inserted=run.events.find(e=>e.type==='PICKUP_FORK_INSERTED'&&e.agfId==='AGF1');
  const picked=run.events.find(e=>e.type==='TASK_PICKED'&&e.agfId==='AGF1');
  const follower=run.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId==='AGF2'&&e.edgeId==='TO-PGW2');
  assert.ok(inserted.timeMs<picked.timeMs);
  assert.ok(follower.timeMs>=picked.timeMs);
  assert.equal(run.snapshots[inserted.sequence].traffic.owners['ORIGINAL-DEVICE-LANE1'],'AGF1');
});

function declaredPairScenario(){
  const s=interferenceScenario();
  s.operationalTopology.nodes.push({id:'SYNTHETIC-BAY1',type:'wait',x:-100,y:0,areaId:'PZ',approvalState:'synthetic-validated'});
  s.operationalTopology.edges.push({...structuredClone(s.operationalTopology.edges.find(e=>e.id==='EXPLICIT-BAY2')),
    id:'EXPLICIT-BAY1',fromNodeId:'START1',toNodeId:'SYNTHETIC-BAY1',lanes:[{id:'EXPLICIT-BAY1-LANE',direction:'both'}]});
  s.operationalTopology.avoidancePlans.push({id:'EXPLICIT-SYNTHETIC-RETREAT1',fromNodeId:'START1',viaNodeId:'SYNTHETIC-BAY1',
    outboundEdgeIds:['EXPLICIT-BAY1'],returnEdgeIds:['EXPLICIT-BAY1'],conflictGroupId:'SYNTHETIC-CONFLICT',evidence:'synthetic-assumption'});
  s.interferenceEvents=[{timeMs:0,agfIds:['AGF1','AGF2'],conflictGroupId:'SYNTHETIC-CONFLICT',evidence:'synthetic-assumption'}];
  return s;
}

test('explicit same-state interference detection remains unresolved in event history and does not move either vehicle',()=>{
  const s=declaredPairScenario(),run=simulate(s);
  const unresolved=run.events.find(e=>e.type==='AVOIDANCE_TIE_UNRESOLVED');
  assert.ok(unresolved);assert.equal(unresolved.timeMs,0);
  assert.ok(!run.events.some(e=>e.type==='AVOIDANCE_STARTED'||e.type==='TASK_PICKED'||e.type==='SEGMENT_ENTERED'));
  assert.equal(run.final.agfs[0].currentNodeId,'START1');assert.equal(run.final.agfs[1].currentNodeId,'START2');
  assert.ok(run.final.tasks.filter(t=>t.kind==='01').every(t=>t.status!=='completed'));
  assert.deepEqual(run.events,simulate(s).events);
});

test('explicit synthetic same-state tie-break records its evidence and retains both tasks through avoidance',()=>{
  const s=declaredPairScenario();
  s.motionControl.avoidanceTieBreakPolicy={kind:'agf_id',evidence:'synthetic-model-tiebreak'};
  const run=simulate(s),started=run.events.find(e=>e.type==='AVOIDANCE_STARTED');
  assert.ok(started);assert.equal(started.agfId,'AGF1');
  assert.equal(started.selectionEvidence,'synthetic-model-tiebreak');
  assert.ok(run.events.some(e=>e.type==='AVOIDANCE_COMPLETED'&&e.agfId==='AGF1'));
  const otherExited=run.events.find(e=>e.type==='SEGMENT_EXITED'&&e.agfId==='AGF2'&&e.edgeId==='TO-PGW2');
  const returnStarted=run.events.find(e=>e.type==='AVOIDANCE_RETURN_STARTED'&&e.agfId==='AGF1');
  assert.ok(returnStarted.timeMs>=otherExited.timeMs,'an explicitly paused partner must pass before retreat return begins');
  assert.equal(run.final.tasks.filter(t=>t.kind==='01'&&t.status==='completed').length,2);
  assert.deepEqual(run.events,simulate(s).events);
});

test('explicit interference received during a segment is deferred without interrupting motion or teleporting',()=>{
  const s=declaredPairScenario();s.interferenceEvents[0].timeMs=500;
  const run=simulate(s),deferred=run.events.find(e=>e.type==='INTERFERENCE_DEFERRED');
  assert.ok(deferred);assert.equal(deferred.timeMs,500);
  const state=run.snapshots[deferred.sequence].agfs.find(a=>a.id==='AGF1');
  assert.equal(state.currentNodeId,'START1');assert.equal(state.movement.current.edgeId,'TO-PGW1');
  const exited=run.events.find(e=>e.type==='SEGMENT_EXITED'&&e.edgeId==='TO-PGW1');
  assert.equal(exited.timeMs,20000);
  assert.ok(!run.events.some(e=>e.type==='AVOIDANCE_STARTED'&&e.agfId==='AGF1'&&e.timeMs<exited.timeMs));
});

test('declared engine interference chooses the empty moving vehicle to avoid while the loaded vehicle keeps its pallet',()=>{
  const s=declaredPairScenario();
  s.operationalTopology.edges.find(e=>e.id==='TO-PGW1').distanceMm=1000;
  s.operationalTopology.nodes.find(n=>n.id==='WRAP-IN').y=0;
  const loadedEdge=s.operationalTopology.edges.find(e=>e.id==='PGW1-TO-WRAP');
  loadedEdge.shutterId='SYNTHETIC-LOADED-GATE';loadedEdge.occupancyResourceIds=['SYNTHETIC-CONFLICT'];
  s.operationalTopology.shutters=[{id:'SYNTHETIC-LOADED-GATE',initiallyPassable:false,permissionSource:'synthetic-scenario'}];
  s.shutterEvents=[{timeMs:8000,shutterId:'SYNTHETIC-LOADED-GATE',passable:true}];
  s.operationalTopology.nodes.find(n=>n.id==='SYNTHETIC-BAY1').x=100;
  s.operationalTopology.nodes.find(n=>n.id==='SYNTHETIC-BAY1').y=-100;
  s.operationalTopology.edges.find(e=>e.id==='EXPLICIT-BAY1').fromNodeId='PGW1';
  s.operationalTopology.avoidancePlans.find(p=>p.id==='EXPLICIT-SYNTHETIC-RETREAT1').fromNodeId='PGW1';
  s.productionEvents[1].timeMs=2000;s.interferenceEvents[0].timeMs=2000;
  const run=simulate(s),detected=run.events.find(e=>e.type==='INTERFERENCE_DETECTED');
  const snapshot=run.snapshots[detected.sequence];
  assert.equal(snapshot.agfs.find(a=>a.id==='AGF1').carriedPalletId,'SYN-INTERFERENCE-1');
  assert.equal(snapshot.agfs.find(a=>a.id==='AGF2').carriedPalletId,null);
  const started=run.events.find(e=>e.type==='AVOIDANCE_STARTED'&&e.timeMs>=2000);
  assert.equal(started.agfId,'AGF2');assert.equal(started.selectionReason,'EMPTY_MOVING_PRIORITY');
  assert.ok(!run.events.some(e=>e.type==='AVOIDANCE_STARTED'&&e.agfId==='AGF1'));
  assert.equal(run.final.tasks.filter(t=>t.kind==='01'&&t.status==='completed').length,2);
});

export {interferenceScenario};
