import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrafficController} from '../src/core/traffic-controller.mjs';
import {chooseAvoidance,findExplicitOvertakingPlan,orderTrafficRequests} from '../src/core/interference-control.mjs';

const edge=(id,overrides={})=>({id,fromNodeId:'A',toNodeId:'B',lanes:[{id:id+'-L1',direction:'both'}],
  lanePolicy:{laneCount:1,simultaneousPassing:'no-alternating'},occupancyResourceIds:[],...overrides});
const enter=(traffic,agfId,edgeId='NEAR')=>traffic.tryEnter({agfId,edgeId,traversal:'forward'});
test('explicit local handling edge set blocks its frontage while leaving distant segments in the group available',()=>{
  const traffic=createTrafficController([edge('NEAR',{noOvertakingGroupId:'G',noOvertakingForwardDirection:'east'}),
    edge('FAR',{noOvertakingGroupId:'G',noOvertakingForwardDirection:'east'})]);
  traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase:'positioning_pickup',blockedEdgeIds:['NEAR']});
  assert.equal(enter(traffic,'PASSER','NEAR').reason,'HANDLING_POSITIONING');
  traffic.leaveGroup('PASSER');
  assert.equal(enter(traffic,'DISTANT','FAR').entered,true);
  traffic.release('DISTANT');
  traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase:'picking_fork_inserted',blockedEdgeIds:['NEAR']});
  assert.equal(enter(traffic,'PASSER','NEAR').entered,true);
});
test('local handling does not hide a separate occupied lane or unknown frontage edge',()=>{
  const traffic=createTrafficController([edge('NEAR')]);
  enter(traffic,'OWNER');
  traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase:'picking_fork_inserted',blockedEdgeIds:['NEAR']});
  assert.equal(enter(traffic,'PASSER').entered,false);
  assert.throws(()=>traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase:'positioning_pickup',blockedEdgeIds:['MISSING']}),/handling edge/);
});
test('exclusive node occupancy and reservation are checked before segment entry, then committed on arrival',()=>{
  const traffic=createTrafficController([edge('FROM-A'),edge('FROM-C',{fromNodeId:'C'})],{
    nodes:[{id:'A',exclusiveTraffic:true},{id:'B',exclusiveTraffic:true},{id:'C',exclusiveTraffic:true}]});
  traffic.setNodeOccupant({agfId:'A1',nodeId:'A'});traffic.setNodeOccupant({agfId:'A2',nodeId:'C'});
  assert.equal(enter(traffic,'A1','FROM-A').entered,true);
  const blocked=enter(traffic,'A2','FROM-C');assert.equal(blocked.entered,false);assert.equal(blocked.reason,'TARGET_NODE_OCCUPIED');
  assert.equal(traffic.snapshot().nodeReservations.B,'A1');
  traffic.depart({agfId:'A1',fromNodeId:'A'});traffic.release('A1');traffic.commitArrival({agfId:'A1',nodeId:'B'});
  assert.equal(traffic.snapshot().nodeOccupants.B,'A1');assert.equal(traffic.snapshot().nodeReservations.B,undefined);
  assert.equal(enter(traffic,'A2','FROM-C').entered,false);
  traffic.depart({agfId:'A1',fromNodeId:'B'});
  assert.equal(enter(traffic,'A2','FROM-C').entered,true);
});
test('exclusive stop rejects duplicate initial occupancy, while unmarked shared legacy home remains explicit',()=>{
  const traffic=createTrafficController([edge('E')],{nodes:[{id:'A',exclusiveTraffic:true},{id:'HOME',exclusiveTraffic:false}]});
  traffic.setNodeOccupant({agfId:'A1',nodeId:'A'});
  assert.throws(()=>traffic.setNodeOccupant({agfId:'A2',nodeId:'A'}),/node occupied/);
  traffic.setNodeOccupant({agfId:'A1',nodeId:'HOME'});traffic.setNodeOccupant({agfId:'A2',nodeId:'HOME'});
  assert.equal(traffic.snapshot().nodeOccupants.HOME,undefined);
});
test('runtime traffic order preserves an inside vehicle, then loaded before empty, then request order without AGF ID sorting',()=>{
  const requests=[{agfId:'A1',loaded:false,requestOrder:1},{agfId:'Z9',loaded:true,requestOrder:4},
    {agfId:'Z8',loaded:true,requestOrder:3},{agfId:'Z7',loaded:false,requestOrder:8,currentSegment:true}];
  const original=structuredClone(requests),ordered=orderTrafficRequests(requests);
  assert.deepEqual(ordered.map(r=>r.agfId),['Z7','Z8','Z9','A1']);assert.deepEqual(requests,original);
});
test('same-state avoidance runtime tie lets the earlier request proceed and records the explicit model evidence',()=>{
  const candidates=[{agfId:'A1',loaded:false,moving:true,avoidancePossible:true,requestOrder:9},
    {agfId:'Z9',loaded:false,moving:true,avoidancePossible:true,requestOrder:2}];
  const choice=chooseAvoidance({candidates,tieBreakPolicy:{kind:'request_order',evidence:'synthetic runtime tie-break'}});
  assert.equal(choice.agfId,'A1');assert.equal(choice.evidence,'synthetic runtime tie-break');
  assert.throws(()=>chooseAvoidance({candidates,tieBreakPolicy:{kind:'request_order',evidence:'site-priority'}}),/runtime tie-break/);
});
test('late registration of a physically ahead vehicle in an explicit logical group does not block its departure behind a rear vehicle',()=>{
  const make=(id,fromNodeId,toNodeId)=>edge(id,{fromNodeId,toNodeId,noOvertakingGroupId:'DOWN',noOvertakingForwardDirection:'south'});
  const traffic=createTrafficController([make('UPPER','A','B'),make('LOWER','B','C')],{
    nodes:[{id:'A',exclusiveTraffic:true},{id:'B',exclusiveTraffic:true},{id:'C',exclusiveTraffic:true}]});
  traffic.setNodeOccupant({agfId:'REAR',nodeId:'A'});traffic.setNodeOccupant({agfId:'AHEAD',nodeId:'B'});
  traffic.reserveResources({agfId:'REAR',resourceIds:[],groupId:'DOWN',groupDirection:'south',fromNodeId:'A',edgeId:'UPPER',requestOrder:1});
  assert.equal(enter(traffic,'REAR','UPPER').reason,'TARGET_NODE_OCCUPIED');
  assert.equal(enter(traffic,'AHEAD','LOWER').entered,true);
  traffic.depart({agfId:'AHEAD',fromNodeId:'B'});traffic.release('AHEAD');traffic.commitArrival({agfId:'AHEAD',nodeId:'C'});
  assert.equal(enter(traffic,'REAR','UPPER').entered,true);
});
test('straight opposing lanes do not reserve a nearby declared merge zone without a lane-change plan',()=>{
  const traffic=createTrafficController([edge('NORTH',{fromNodeId:'N1',toNodeId:'N2'}),
    edge('SOUTH',{fromNodeId:'S2',toNodeId:'S1'}),edge('CHANGE',{fromNodeId:'N2',toNodeId:'S1',
      mergeConflictResourceId:'MERGE',occupancyResourceIds:['MERGE']})],{
    nodes:['N1','N2','S1','S2'].map(id=>({id,exclusiveTraffic:true}))});
  assert.equal(enter(traffic,'N','NORTH').entered,true);
  assert.equal(enter(traffic,'S','SOUTH').entered,true);
  assert.equal(traffic.snapshot().owners.MERGE,undefined);
});
test('planned lane change reserves both ends and actual lane before approach so a reciprocal arrival cannot swap endpoints',()=>{
  const traffic=createTrafficController([edge('NORTH',{fromNodeId:'N1',toNodeId:'N2'}),
    edge('SOUTH',{fromNodeId:'S2',toNodeId:'S1'}),edge('CHANGE',{fromNodeId:'N2',toNodeId:'S1',
      mergeConflictResourceId:'MERGE',occupancyResourceIds:['MERGE']})],{
    nodes:['N1','N2','S1','S2'].map(id=>({id,exclusiveTraffic:true}))});
  const future={edgeId:'CHANGE',fromNodeId:'N2',toNodeId:'S1',traversal:'forward'};
  const entered=traffic.tryEnter({agfId:'N',edgeId:'NORTH',traversal:'forward',lookaheadSteps:[future]});
  assert.equal(entered.entered,true);assert.equal(traffic.snapshot().owners.MERGE,'N');
  assert.equal(traffic.snapshot().owners['CHANGE-L1'],'N');assert.equal(traffic.snapshot().nodeReservations.S1,'N');
  assert.ok(entered.futureResourceIds.includes('node:N2')&&entered.futureResourceIds.includes('node:S1'));
  assert.equal(enter(traffic,'S','SOUTH').entered,false);
  traffic.release('N',{retainResourceIds:entered.futureResourceIds});traffic.commitArrival({agfId:'N',nodeId:'N2'});
  assert.equal(traffic.snapshot().nodeReservations.S1,'N');
  assert.equal(traffic.tryEnter({agfId:'N',edgeId:'CHANGE',traversal:'forward'}).entered,true);
  traffic.depart({agfId:'N',fromNodeId:'N2'});traffic.release('N');traffic.commitArrival({agfId:'N',nodeId:'S1'});
  assert.equal(traffic.snapshot().owners.MERGE,undefined);
});
test('a planned merge approach acquires nothing when the far endpoint already has a stopped vehicle',()=>{
  const traffic=createTrafficController([edge('NORTH',{fromNodeId:'N1',toNodeId:'N2'}),
    edge('CHANGE',{fromNodeId:'N2',toNodeId:'S1',mergeConflictResourceId:'MERGE',occupancyResourceIds:['MERGE']})],{
    nodes:['N1','N2','S1'].map(id=>({id,exclusiveTraffic:true}))});
  traffic.setNodeOccupant({agfId:'S',nodeId:'S1'});
  const entered=traffic.tryEnter({agfId:'N',edgeId:'NORTH',traversal:'forward',
    lookaheadSteps:[{edgeId:'CHANGE',fromNodeId:'N2',toNodeId:'S1',traversal:'forward'}]});
  assert.equal(entered.entered,false);assert.deepEqual(traffic.snapshot().owners,{});
});
test('a rear approach cannot pre-reserve a future merge zone that its already-ahead group leader needs to leave',()=>{
  const group={noOvertakingGroupId:'ENTRY',noOvertakingForwardDirection:'east'};
  const traffic=createTrafficController([edge('APPROACH',{fromNodeId:'BEFORE',toNodeId:'A'}),
    edge('MERGE',{fromNodeId:'A',toNodeId:'B',...group,mergeConflictResourceId:'ZONE',occupancyResourceIds:['ZONE']}),
    edge('MIDDLE',{fromNodeId:'B',toNodeId:'C',...group}),
    edge('LEAVE',{fromNodeId:'C',toNodeId:'D',...group,occupancyResourceIds:['ZONE']})],{
    nodes:['BEFORE','A','B','C','D'].map(id=>({id,exclusiveTraffic:true}))});
  traffic.setNodeOccupant({agfId:'AHEAD',nodeId:'C'});
  assert.equal(traffic.reserveResources({agfId:'AHEAD',resourceIds:[],groupId:'ENTRY',groupDirection:'east',
    fromNodeId:'C',edgeId:'LEAVE',requestOrder:1}).entered,true);
  const rear=traffic.tryEnter({agfId:'REAR',edgeId:'APPROACH',traversal:'forward',requestOrder:2,
    lookaheadSteps:[{edgeId:'MERGE',fromNodeId:'A',toNodeId:'B',traversal:'forward'}]});
  assert.equal(rear.entered,false);
  assert.equal(rear.reason,'NO_OVERTAKING');
  assert.equal(traffic.snapshot().owners.ZONE,undefined);
  assert.equal(enter(traffic,'AHEAD','LEAVE').entered,true);
  assert.equal(traffic.snapshot().owners.ZONE,'AHEAD');
});
test('a declared three-part alternating passage reserves its final stop before entry and releases its span only after crossing',()=>{
  const passage=(id,fromNodeId,toNodeId)=>edge(id,{fromNodeId,toNodeId,atomicPassageId:'EXPLICIT-PASSAGE',
    lanes:[{id:id+'-L1',resourceId:'ORIGINAL-PASSAGE-LANE',direction:'both'}],occupancyResourceIds:['PASSAGE']});
  const traffic=createTrafficController([passage('P1','A','B'),passage('P2','B','C'),passage('P3','C','D')],{
    nodes:['A','B','C','D'].map(id=>({id,exclusiveTraffic:true}))});
  traffic.setNodeOccupant({agfId:'FORWARD',nodeId:'A'});traffic.setNodeOccupant({agfId:'OPPOSING',nodeId:'D'});
  const p2={edgeId:'P2',fromNodeId:'B',toNodeId:'C',traversal:'forward'};
  const p3={edgeId:'P3',fromNodeId:'C',toNodeId:'D',traversal:'forward'};
  const request=()=>traffic.tryEnter({agfId:'FORWARD',edgeId:'P1',traversal:'forward',lookaheadSteps:[p2,p3]});
  assert.equal(request().reason,'TARGET_NODE_OCCUPIED');assert.deepEqual(traffic.snapshot().owners,{});
  traffic.depart({agfId:'OPPOSING',fromNodeId:'D'});
  const entered=request();assert.equal(entered.entered,true);
  assert.equal(traffic.snapshot().nodeReservations.D,'FORWARD');
  traffic.depart({agfId:'FORWARD',fromNodeId:'A'});
  traffic.release('FORWARD',{retainResourceIds:entered.futureResourceIds});traffic.commitArrival({agfId:'FORWARD',nodeId:'B'});
  assert.equal(traffic.snapshot().owners['ORIGINAL-PASSAGE-LANE'],'FORWARD');
  assert.equal(traffic.tryEnter({agfId:'OPPOSING',edgeId:'P3',traversal:'reverse'}).entered,false);
  const middle=traffic.tryEnter({agfId:'FORWARD',edgeId:'P2',traversal:'forward',lookaheadSteps:[p3]});
  traffic.depart({agfId:'FORWARD',fromNodeId:'B'});
  traffic.release('FORWARD',{retainResourceIds:middle.futureResourceIds});traffic.commitArrival({agfId:'FORWARD',nodeId:'C'});
  assert.equal(traffic.snapshot().owners['ORIGINAL-PASSAGE-LANE'],'FORWARD');
  assert.equal(traffic.tryEnter({agfId:'FORWARD',edgeId:'P3',traversal:'forward'}).entered,true);
  traffic.depart({agfId:'FORWARD',fromNodeId:'C'});traffic.release('FORWARD');traffic.commitArrival({agfId:'FORWARD',nodeId:'D'});
  assert.equal(traffic.snapshot().owners['ORIGINAL-PASSAGE-LANE'],undefined);
});
test('adjacent explicit lane-change and device-stop merges precheck the occupied final stop before either approach endpoint is reserved',()=>{
  const traffic=createTrafficController([edge('MAIN',{fromNodeId:'A',toNodeId:'B'}),
    edge('CHANGE',{fromNodeId:'B',toNodeId:'C',mergeConflictResourceId:'CHANGE-ZONE',occupancyResourceIds:['CHANGE-ZONE']}),
    edge('DEVICE',{fromNodeId:'C',toNodeId:'D',mergeConflictResourceId:'DEVICE-STOP',occupancyResourceIds:['DEVICE-STOP']})],{
    nodes:['A','B','C','D'].map(id=>({id,exclusiveTraffic:true}))});
  traffic.setNodeOccupant({agfId:'DEPARTING',nodeId:'D'});
  const entrant=traffic.tryEnter({agfId:'NEW',edgeId:'MAIN',traversal:'forward',lookaheadSteps:[
    {edgeId:'CHANGE',fromNodeId:'B',toNodeId:'C',traversal:'forward'},
    {edgeId:'DEVICE',fromNodeId:'C',toNodeId:'D',traversal:'forward'}]});
  assert.equal(entrant.entered,false);assert.equal(entrant.reason,'TARGET_NODE_OCCUPIED');
  assert.deepEqual(traffic.snapshot().owners,{});assert.deepEqual(traffic.snapshot().nodeReservations,{});
  assert.equal(traffic.tryEnter({agfId:'DEPARTING',edgeId:'DEVICE',traversal:'reverse'}).entered,true);
});
test('an explicit merge approach followed immediately by an atomic passage checks the entire declared span before partial endpoint reservation',()=>{
  const traffic=createTrafficController([edge('MAIN',{fromNodeId:'A',toNodeId:'B'}),
    edge('CHANGE',{fromNodeId:'B',toNodeId:'C',mergeConflictResourceId:'CHANGE-ZONE',occupancyResourceIds:['CHANGE-ZONE']}),
    edge('P1',{fromNodeId:'C',toNodeId:'D',atomicPassageId:'FIRE',occupancyResourceIds:['FIRE-LANE']}),
    edge('P2',{fromNodeId:'D',toNodeId:'E',atomicPassageId:'FIRE',occupancyResourceIds:['FIRE-LANE']}),
    edge('ORDINARY',{fromNodeId:'E',toNodeId:'F'})],{
    nodes:['A','B','C','D','E','F'].map(id=>({id,exclusiveTraffic:true}))});
  traffic.setNodeOccupant({agfId:'OPPOSING',nodeId:'E'});
  const lookaheadSteps=[['CHANGE','B','C'],['P1','C','D'],['P2','D','E'],['ORDINARY','E','F']]
    .map(([edgeId,fromNodeId,toNodeId])=>({edgeId,fromNodeId,toNodeId,traversal:'forward'}));
  const request=()=>traffic.tryEnter({agfId:'APPROACHING',edgeId:'MAIN',traversal:'forward',lookaheadSteps});
  assert.equal(request().entered,false);assert.deepEqual(traffic.snapshot().owners,{});
  traffic.depart({agfId:'OPPOSING',fromNodeId:'E'});
  assert.equal(request().entered,true);assert.equal(traffic.snapshot().nodeReservations.E,'APPROACHING');
  assert.equal(traffic.snapshot().nodeReservations.F,undefined);
  assert.equal(traffic.snapshot().owners['ORDINARY-L1'],undefined);
});

const graph=()=>({schemaVersion:'operational-topology-v1',datasetKind:'synthetic',evidence:'synthetic-assumption',
  coordinateSystem:'synthetic-display',readiness:{operationalRoutingReady:true,physicalEtaAllowed:false},
  nodes:[{id:'A',x:0,y:0},{id:'B',x:0,y:10},{id:'C',x:100,y:10},{id:'D',x:100,y:0},{id:'WAIT',x:50,y:0}]
    .map(n=>({...n,type:'junction',areaId:'PZ',approvalState:'synthetic-validated'})),
  edges:[{id:'START-CHANGE',fromNodeId:'A',toNodeId:'B'},
    {id:'OPPOSITE',fromNodeId:'C',toNodeId:'B',direction:'forward'},
    {id:'REJOIN',fromNodeId:'C',toNodeId:'D'}].map(e=>({...edge(e.id),...e,
      lanes:[{id:e.id+'-L1',direction:e.direction??'both'}],distanceMm:1000,
      speedMmPerSec:{empty:1000,loaded:500,charge:1000},approvalState:'synthetic-validated',
      accessScopes:['empty','loaded','charge'].map(movement=>({movement,taskTypes:['*']}))})),
  shutters:[],interfaceBindings:[],overtakingPlans:[{id:'SYNTHETIC-OVERTAKING',blockedNodeId:'WAIT',fromNodeId:'A',
    rejoinNodeId:'D',edgeIds:['START-CHANGE','OPPOSITE','REJOIN'],
    temporaryReverseEdgeIds:['OPPOSITE'],resourceIds:['CHANGE-ZONE','OPPOSITE-L1','ALONGSIDE-ZONE','RETURN-ZONE'],
    evidence:'synthetic-assumption'}]});
const stopped=()=>({id:'BLOCKED',status:'waiting_wrapper_input',currentNodeId:'WAIT',departurePlanned:false,movement:{current:null}});
const planFor=(g=graph(),blockedAgf=stopped(),regularBlocked=true)=>findExplicitOvertakingPlan(g,{
  currentNodeId:'A',blockedAgf,regularBlocked,movement:'empty',taskType:'01'});

test('only an explicit waiting-wrapper-input stop yields an exceptional path with its declared temporary reverse traversal',()=>{
  const g=graph(),plan=planFor(g);assert.ok(plan);assert.equal(plan.path.steps.at(-1).toNodeId,'D');
  assert.equal(plan.path.steps[1].traversal,'reverse');assert.equal(plan.path.steps[1].temporaryDirectionException,true);
  assert.equal(plan.path.measuredDistanceMm,null);assert.equal(plan.evidence,'synthetic-assumption');
  for(const status of ['moving_loaded','waiting_traffic','waiting_charge','turning','positioning_for_pickup'])assert.equal(planFor(g,{...stopped(),status}),null);
  assert.equal(planFor(g,{...stopped(),departurePlanned:true}),null);
  assert.equal(planFor(g,{...stopped(),departurePlanned:undefined}),null);
  assert.equal(planFor(g,{...stopped(),movement:{current:{edgeId:'MOVING'}}}),null);
  assert.equal(planFor(g,stopped(),false),null);
  const missing=graph();missing.overtakingPlans=[];assert.equal(planFor(missing),null);
});
test('an overtaking plan without an explicit reverse permission or complete four-zone declaration cannot be used',()=>{
  const g=graph();g.overtakingPlans[0].temporaryReverseEdgeIds=[];
  assert.throws(()=>planFor(g),/undeclared reverse|direction|reverse/);
  const incomplete=graph();incomplete.overtakingPlans[0].resourceIds.pop();
  assert.throws(()=>planFor(incomplete),/four|4|resource/);
});
test('the four overtaking zones are reserved atomically before departure and held until the explicit rejoin completes',()=>{
  const g=graph(),plan=planFor(g),traffic=createTrafficController(g.edges,{nodes:g.nodes});
  const reserved=traffic.reserveOvertaking({agfId:'PASSER',blockedAgfId:'BLOCKED',blockedAgf:stopped(),regularBlocked:true,plan});
  assert.equal(reserved.entered,true);
  assert.throws(()=>traffic.completeOvertaking('PASSER'),/complete|unfinished|arrival/);
  for(const step of plan.path.steps){
    const entered=traffic.tryEnter({agfId:'PASSER',edgeId:step.edgeId,traversal:step.traversal,overtakingPlanId:plan.planId});
    assert.equal(entered.entered,true);
    traffic.release('PASSER');
    for(const resource of plan.resourceIds)assert.equal(traffic.snapshot().owners[resource],'PASSER');
  }
  traffic.completeOvertaking('PASSER');
  assert.deepEqual(traffic.snapshot().owners,{});
  assert.deepEqual(traffic.snapshot().overtaking,[]);
});
test('any occupied overtaking zone prevents the whole reservation without stopping its owner or acquiring partial zones',()=>{
  for(const occupied of graph().overtakingPlans[0].resourceIds){
    const g=graph(),plan=planFor(g),traffic=createTrafficController(g.edges);
    traffic.reserveResources({agfId:'ONCOMING',resourceIds:[occupied]});
    const before=traffic.snapshot().owners;
    const result=traffic.reserveOvertaking({agfId:'PASSER',blockedAgfId:'BLOCKED',blockedAgf:stopped(),regularBlocked:true,plan});
    assert.equal(result.entered,false);assert.deepEqual(traffic.snapshot().owners,before);
    assert.deepEqual(result.blockers,['ONCOMING']);
  }
});
test('normal vehicles cannot use the reverse exception and leased vehicles cannot use undeclared route steps',()=>{
  const g=graph(),plan=planFor(g),traffic=createTrafficController(g.edges);
  assert.throws(()=>traffic.tryEnter({agfId:'NORMAL',edgeId:'OPPOSITE',traversal:'reverse'}),/no lane/);
  traffic.reserveOvertaking({agfId:'PASSER',blockedAgfId:'BLOCKED',blockedAgf:stopped(),regularBlocked:true,plan});
  assert.throws(()=>traffic.tryEnter({agfId:'PASSER',edgeId:'OPPOSITE',traversal:'reverse',overtakingPlanId:plan.planId}),/overtaking.*step|planned.*step/);
  assert.equal(traffic.snapshot().owners['OPPOSITE-L1'],'PASSER');
});
test('overtaking reserves actual route resources and rejects an occupied lane even if four named zones look free',()=>{
  const g=graph(),plan=planFor(g),traffic=createTrafficController(g.edges);
  traffic.reserveResources({agfId:'ONCOMING',resourceIds:['START-CHANGE-L1']});
  const before=traffic.snapshot().owners;
  assert.equal(traffic.reserveOvertaking({agfId:'PASSER',blockedAgfId:'BLOCKED',blockedAgf:stopped(),regularBlocked:true,plan}).entered,false);
  assert.deepEqual(traffic.snapshot().owners,before);
});
test('overtaking cannot reserve an occupied exclusive rejoin point and reports its blocked AGF while its lease is active',()=>{
  const g=graph();g.nodes.find(n=>n.id==='D').exclusiveTraffic=true;
  const plan=planFor(g),traffic=createTrafficController(g.edges,{nodes:g.nodes});
  traffic.setNodeOccupant({agfId:'AHEAD',nodeId:'D'});
  assert.equal(traffic.reserveOvertaking({agfId:'PASSER',blockedAgfId:'BLOCKED',blockedAgf:stopped(),regularBlocked:true,plan}).entered,false);
  traffic.depart({agfId:'AHEAD',fromNodeId:'D'});
  assert.equal(traffic.reserveOvertaking({agfId:'PASSER',blockedAgfId:'BLOCKED',blockedAgf:stopped(),regularBlocked:true,plan}).entered,true);
  assert.equal(traffic.isBeingOvertaken('BLOCKED'),true);
  assert.equal(traffic.isBeingOvertaken('OTHER'),false);
});
