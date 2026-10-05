import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {createLegacyScenario} from '../src/ui/scenario.mjs';

// Explicit synthetic test geometry and timing. The bay is a fixture declaration,
// never inferred from a nearby drawing position or offered as a site retreat.
function routeSwitchScenario(){
  const s=createLegacyScenario('manual');
  s.durationMin=1;s.motionModel='synthetic_graph';
  s.motionControl={turnRateDegPerSec:90,turnRateEvidence:'synthetic-assumption',turningConsumesBattery:true,
    pickupPositioningMin:0,pickupForkInsertedMin:.001,
    dropoffPositioningMin:0,dropoffForkInsertedMin:.001,handlingEvidence:'synthetic-assumption'};
  s.wrapper={inputCapacity:1,outputCapacity:1,inboundAgfLimit:2};
  s.times={...s.times,wrapMin:100};
  s.agfs=s.agfs.map((a,i)=>({...a,area:'PZ',currentNodeId:['START1','START2','PARK3','PARK4'][i],
    headingDeg:0,batteryPct:100,blocked:i>1}));
  const nodes=[['START1',0,0,'home'],['APPROACH',100,0,'junction'],['MERGE-END',200,0,'junction'],
    ['START2',100,100,'home'],['PGW1',300,0,'pickup'],['PGW2',300,100,'pickup'],
    ['WRAP-IN',400,50,'dropoff'],['WRAP-OUT',450,50,'pickup'],['STORE',500,50,'dropoff'],
    ['CHARGE',0,200,'charge'],['PARK3',0,300,'home'],['PARK4',0,400,'home'],['BAY',100,-100,'wait']]
    .map(([id,x,y,type])=>({id,x,y,type,areaId:'PZ',approvalState:'synthetic-validated',exclusiveTraffic:true}));
  const make=(id,fromNodeId,toNodeId,{distanceMm=1000,resources=[],shutterId=null,merge=false}={})=>({
    id,fromNodeId,toNodeId,distanceMm,speedMmPerSec:{empty:1000,loaded:1000,charge:1000},
    approvalState:'synthetic-validated',accessScopes:['empty','loaded','charge'].map(movement=>({movement,taskTypes:['*']})),
    lanePolicy:{laneCount:1,simultaneousPassing:'no-alternating'},lanes:[{id:id+'-LANE',direction:'both'}],
    occupancyResourceIds:resources,...(shutterId?{shutterId}:{}),...(merge?{mergeConflictResourceId:'MERGE-ZONE'}:{})});
  s.operationalTopology={schemaVersion:'operational-topology-v1',datasetKind:'synthetic',evidence:'synthetic-assumption',
    coordinateSystem:'synthetic-display',readiness:{operationalRoutingReady:true,physicalEtaAllowed:false},nodes,
    edges:[make('APPROACH-EDGE','START1','APPROACH',{distanceMm:5000}),
      make('MERGE','APPROACH','MERGE-END',{resources:['MERGE-ZONE'],shutterId:'TEST-SH',merge:true}),
      make('TO-PGW1','MERGE-END','PGW1'),make('TO-PGW2','START2','PGW2',{resources:['MERGE-ZONE']}),
      make('WRAP1','PGW1','WRAP-IN'),make('WRAP2','PGW2','WRAP-IN'),make('OUTPUT','WRAP-IN','WRAP-OUT'),
      make('STORE-EDGE','WRAP-OUT','STORE'),make('CHARGE-EDGE','START1','CHARGE'),make('BAY-EDGE','APPROACH','BAY')],
    interfaceBindings:[{pattern:'L1',nodeId:'PGW1'},{pattern:'L2',nodeId:'PGW2'},
      {pattern:'WRAP-INPUT',nodeId:'WRAP-IN'},{pattern:'WRAP-OUTPUT',nodeId:'WRAP-OUT'},
      {pattern:'WB*',nodeId:'STORE'},{pattern:'EB*',nodeId:'STORE'},{pattern:'CHARGE-PLACE',nodeId:'CHARGE'}],
    shutters:[{id:'TEST-SH',initiallyPassable:false}],
    avoidancePlans:[{id:'DECLARED-BAY',fromNodeId:'APPROACH',viaNodeId:'BAY',
      outboundEdgeIds:['BAY-EDGE'],returnEdgeIds:['BAY-EDGE'],conflictGroupId:'MERGE-ZONE',evidence:'synthetic-assumption'}]};
  s.productionEvents=[{timeMs:0,lineId:'L1',palletId:'SYN-SWITCH1',destinationLocationId:s.generatedDestinationIds[0]},
    {timeMs:0,lineId:'L2',palletId:'SYN-SWITCH2',destinationLocationId:s.generatedDestinationIds[1]}];
  s.interferenceEvents=[{timeMs:6000,agfIds:['AGF1','AGF2'],conflictGroupId:'MERGE-ZONE',evidence:'synthetic-assumption'}];
  s.shutterEvents=[{timeMs:20000,shutterId:'TEST-SH',passable:true}];
  return s;
}

test('switching to an explicit avoidance route clears future merge arrival reservations while retaining the occupied stop',()=>{
  const scenario=routeSwitchScenario(),run=simulate(scenario);
  const approached=run.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.agfId==='AGF1'&&e.edgeId==='APPROACH-EDGE');
  assert.ok(approached);
  assert.equal(run.snapshots[approached.sequence].traffic.nodeReservations['MERGE-END'],'AGF1');
  const started=run.events.find(e=>e.type==='AVOIDANCE_STARTED'&&e.agfId==='AGF1');
  assert.ok(started,'the stopped approach vehicle has an explicitly declared retreat');
  const state=run.snapshots[started.sequence];
  assert.equal(state.traffic.nodeReservations['MERGE-END'],undefined);
  assert.equal(state.traffic.owners['node:MERGE-END'],undefined);
  assert.equal(state.traffic.nodeOccupants.APPROACH,'AGF1');
  assert.ok(run.events.some(e=>e.type==='AVOIDANCE_COMPLETED'&&e.agfId==='AGF1'));
  assert.equal(run.events.filter(e=>e.type==='TASK_PICKED'&&e.kind==='01').length,2,
    'both original pickups resume; an idle vehicle at the exclusive inlet still blocks a second drop-off');
  assert.deepEqual(run.events,simulate(scenario).events);
});
