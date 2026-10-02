import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {createLegacyScenario} from '../src/ui/scenario.mjs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';
import {turnAngle} from '../src/core/motion-control.mjs';

function turnScenario(){
  const s=createLegacyScenario('manual');
  s.durationMin=10;s.motionModel='synthetic_graph';
  // Explicit, invented motion values used only by this software regression.
  s.motionControl={turnRateDegPerSec:45,turnRateEvidence:'synthetic-assumption',turningConsumesBattery:true,
    pickupPositioningMin:.001,pickupForkInsertedMin:.002,
    dropoffPositioningMin:.003,dropoffForkInsertedMin:.004,handlingEvidence:'synthetic-assumption'};
  s.agfs=s.agfs.map((a,i)=>({...a,currentNodeId:'START',headingDeg:0,blocked:i!==0}));
  const nodes=[['START',0,0,'home'],['CORNER',100,0,'turn'],['PZ-L4-PICKUP',100,100,'pickup'],
    ['WRAP-IN',200,0,'dropoff'],['WRAP-OUT',300,0,'pickup'],['STORE',400,0,'dropoff'],['CHARGE',0,200,'charge']]
    .map(([id,x,y,type])=>({id,x,y,type,areaId:'PZ',approvalState:'synthetic-validated'}));
  const edges=[['TO-CORNER','START','CORNER'],['TO-PGW4','CORNER','PZ-L4-PICKUP'],
    ['TO-WRAP','CORNER','WRAP-IN'],['WRAP-CROSS','WRAP-IN','WRAP-OUT'],
    ['TO-STORE','WRAP-OUT','STORE'],['TO-CHARGE','START','CHARGE']].map(([id,fromNodeId,toNodeId])=>({
      id,fromNodeId,toNodeId,distanceMm:1000,speedMmPerSec:{empty:1000,loaded:1000,charge:1000},
      approvalState:'synthetic-validated',accessScopes:['empty','loaded','charge'].map(movement=>({movement,taskTypes:['*']})),
      lanePolicy:{laneCount:1,simultaneousPassing:'no-alternating'},lanes:[{id:id+'-LANE',direction:'both'}],occupancyResourceIds:[]}));
  s.operationalTopology={schemaVersion:'operational-topology-v1',datasetKind:'synthetic',evidence:'synthetic-assumption',
    coordinateSystem:'synthetic-display',readiness:{operationalRoutingReady:true,physicalEtaAllowed:false},nodes,edges,
    interfaceBindings:[{pattern:'L4',nodeId:'PZ-L4-PICKUP'},{pattern:'WRAP-INPUT',nodeId:'WRAP-IN'},
      {pattern:'WRAP-OUTPUT',nodeId:'WRAP-OUT'},{pattern:'WB*',nodeId:'STORE'},{pattern:'EB*',nodeId:'STORE'},
      {pattern:'CHARGE-PLACE',nodeId:'CHARGE'}],shutters:[]};
  s.productionEvents=[{timeMs:0,lineId:'L4',palletId:'SYN-TURN-L4',destinationLocationId:s.generatedDestinationIds[0]}];
  return s;
}

test('explicit stopped turns precede each new direction and retain the current task',()=>{
  const run=simulate(turnScenario()),turns=run.events.filter(e=>e.type==='TURN_STARTED');
  assert.ok(turns.length>=3);
  for(const started of turns){
    const completed=run.events.find(e=>e.type==='TURN_COMPLETED'&&e.agfId===started.agfId&&e.startedAt===started.timeMs);
    assert.ok(completed);assert.equal(completed.timeMs-started.timeMs,Math.ceil(Math.abs(started.angleDeg)/45*1000));
    const state=run.snapshots[started.sequence].agfs.find(a=>a.id===started.agfId);
    assert.equal(state.status,'turning');assert.equal(state.movement.current,null);assert.equal(state.taskId,started.taskId);
    const first=projectAgfPosition(state,run.scenario.operationalTopology,started.timeMs);
    const middle=projectAgfPosition(state,run.scenario.operationalTopology,(started.timeMs+completed.timeMs)/2);
    assert.equal(first.x,middle.x);assert.equal(first.y,middle.y);
    assert.ok(!run.events.some(e=>e.type==='SEGMENT_ENTERED'&&e.agfId===started.agfId&&
      e.timeMs>=started.timeMs&&e.timeMs<completed.timeMs));
  }
  assert.ok(turns.some(e=>Math.abs(e.angleDeg)===90));assert.ok(turns.some(e=>Math.abs(e.angleDeg)===180));
  const zero=run.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.edgeId==='TO-CORNER');
  assert.equal(zero.timeMs,0);assert.ok(!turns.some(e=>e.timeMs===0));
});
test('unconfigured turn rate holds at the real synthetic corner without pickup or teleport',()=>{
  const s=turnScenario();s.motionControl.turnRateDegPerSec=null;s.motionControl.turnRateEvidence='unresolved';
  const run=simulate(s),a=run.final.agfs[0];
  assert.equal(a.currentNodeId,'CORNER');assert.equal(a.status,'waiting_motion_configuration');
  assert.ok(run.events.some(e=>e.reason==='TURN_RATE_UNRESOLVED'));
  assert.ok(!run.events.some(e=>e.type==='TASK_PICKED'||e.type==='TURN_STARTED'));
});
test('pickup and drop handling phases use explicit inputs and inventory changes only after fork handling',()=>{
  const s=turnScenario(),run=simulate(s),task=run.final.tasks.find(t=>t.kind==='01');
  const arrival=run.events.find(e=>e.type==='ROUTE_COMPLETED'&&e.taskId===task.id&&e.movement==='empty');
  const positioning=run.events.find(e=>e.type==='TASK_POSITIONING_STARTED'&&e.taskId===task.id&&e.operation==='pickup');
  const fork=run.events.find(e=>e.type==='PICKUP_FORK_INSERTED'&&e.taskId===task.id);
  const picked=run.events.find(e=>e.type==='TASK_PICKED'&&e.taskId===task.id);
  assert.equal(arrival.nodeId,'PZ-L4-PICKUP');assert.equal(positioning.timeMs,arrival.timeMs);
  assert.equal(fork.timeMs-positioning.timeMs,60);assert.equal(picked.timeMs-fork.timeMs,120);
  const drop=run.events.find(e=>e.type==='TASK_POSITIONING_STARTED'&&e.taskId===task.id&&e.operation==='dropoff');
  const dropFork=run.events.find(e=>e.type==='DROPOFF_FORK_INSERTED'&&e.taskId===task.id);
  const dropped=run.events.find(e=>e.type==='TASK_DROPPED'&&e.taskId===task.id);
  assert.equal(dropFork.timeMs-drop.timeMs,180);assert.equal(dropped.timeMs-dropFork.timeMs,240);
  assert.equal(run.snapshots[fork.sequence].lines.L4.length,1);
  assert.equal(run.snapshots[picked.sequence].lines.L4.length,0);
});
test('unconfigured handling phases do not silently divide existing pickup time',()=>{
  const s=turnScenario();s.motionControl.pickupPositioningMin=null;
  const run=simulate(s);
  assert.ok(run.events.some(e=>e.reason==='HANDLING_PHASES_UNRESOLVED'));
  assert.equal(run.final.agfs[0].currentNodeId,'PZ-L4-PICKUP');
  assert.ok(!run.events.some(e=>e.type==='TASK_PICKED'));
});
test('turn timing remains deterministic and 180 degrees takes twice as long as 90',()=>{
  const s=turnScenario(),a=simulate(s),b=simulate(s);assert.deepEqual(a.events,b.events);
  const turns=a.events.filter(e=>e.type==='TURN_STARTED');
  const ninety=turns.find(e=>Math.abs(e.angleDeg)===90),half=turns.find(e=>Math.abs(e.angleDeg)===180);
  assert.ok(ninety&&half);assert.equal(half.turnDurationMs,2*ninety.turnDurationMs);
  assert.equal(turnAngle(0,0),0);assert.equal(turnAngle(0,90),90);assert.equal(turnAngle(0,180),180);
});

export {turnScenario};
