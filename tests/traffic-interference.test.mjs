import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrafficController} from '../src/core/traffic-controller.mjs';
import {chooseAvoidance,findExplicitAvoidancePlan} from '../src/core/interference-control.mjs';

const edge=(id,overrides={})=>({id,fromNodeId:'N1',toNodeId:'N2',
  lanes:[{id:id+'-L1',direction:'both'},{id:id+'-L2',direction:'both'}],
  lanePolicy:{laneCount:2,simultaneousPassing:'yes'},occupancyResourceIds:[],
  noOvertakingGroupId:'G',noOvertakingForwardDirection:'east',...overrides});
const enter=(traffic,agfId,edgeId='E',traversal='forward',requestOrder=0)=>
  traffic.tryEnter({agfId,edgeId,traversal,requestOrder});

test('declared no-overtaking group stops a same-direction follower despite a free second lane',()=>{
  const traffic=createTrafficController([edge('E')]);
  assert.equal(enter(traffic,'LEADER','E','forward',1).entered,true);
  const follower=enter(traffic,'FOLLOWER','E','forward',2);
  assert.equal(follower.entered,false);
  assert.equal(follower.reason,'NO_OVERTAKING');
  assert.deepEqual(follower.blockers,['LEADER']);
  assert.equal(traffic.snapshot().owners['E-L2'],undefined);
  assert.deepEqual(traffic.snapshot().followingOrder.map(a=>a.agfId),['LEADER','FOLLOWER']);
  traffic.release('LEADER');
  assert.equal(enter(traffic,'FOLLOWER','E','forward',2).entered,true);
});

test('no-overtaking order persists while the leader changes edges in the same declared group',()=>{
  const traffic=createTrafficController([edge('E1'),edge('E2')]);
  enter(traffic,'LEADER','E1','forward',1);
  traffic.release('LEADER',{keepFollowingOrder:true});
  assert.equal(enter(traffic,'FOLLOWER','E2','forward',2).entered,false);
  assert.equal(enter(traffic,'LEADER','E2','forward',3).entered,true);
  traffic.release('LEADER');
  assert.equal(enter(traffic,'FOLLOWER','E2','forward',2).entered,true);
});

test('no-overtaking direction refers to the group and not each edge endpoint order',()=>{
  const traffic=createTrafficController([edge('E1'),edge('E2',{noOvertakingForwardDirection:'west'})]);
  enter(traffic,'LEADER','E1','forward',1);
  const following=enter(traffic,'FOLLOWER','E2','reverse',2);
  assert.equal(following.entered,false);
  assert.deepEqual(following.blockers,['LEADER']);
});

test('declared group ordering permits opposite directions only when lane and resource rules allow',()=>{
  const traffic=createTrafficController([edge('E')]);
  assert.equal(enter(traffic,'A1','E','forward',1).entered,true);
  assert.equal(enter(traffic,'A2','E','reverse',2).entered,true);
  assert.equal(enter(traffic,'A3','E','reverse',3).entered,false);
});

test('a missing group direction is rejected instead of guessing a direction',()=>{
  const traffic=createTrafficController([edge('E',{noOvertakingForwardDirection:null})]);
  assert.throws(()=>enter(traffic,'A1'),/group direction/);
  assert.deepEqual(traffic.snapshot().owners,{});
});

test('a same timestamp retry retains the existing follower order without duplicate membership',()=>{
  const traffic=createTrafficController([edge('E')]);
  enter(traffic,'L','E','forward',1);
  enter(traffic,'F1','E','forward',2);
  enter(traffic,'F2','E','forward',3);
  enter(traffic,'F1','E','forward',99);
  traffic.release('L');
  assert.equal(enter(traffic,'F2','E','forward',4).entered,false);
  assert.equal(enter(traffic,'F1','E','forward',5).entered,true);
  assert.deepEqual(traffic.snapshot().followingOrder.map(a=>a.agfId),['F1','F2']);
});

for(const phase of ['positioning_pickup','positioning_dropoff']){
  test(phase+' blocks the equipment-front group in either direction',()=>{
    const traffic=createTrafficController([edge('E')]);
    traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase,resourceIds:['FRONT-J']});
    for(const traversal of ['forward','reverse']){
      const blocked=enter(traffic,'PASSER','E',traversal,1);
      assert.equal(blocked.entered,false);
      assert.equal(blocked.reason,'HANDLING_POSITIONING');
      assert.deepEqual(blocked.blockers,['HANDLER']);
    }
    assert.equal(traffic.snapshot().owners['FRONT-J'],'HANDLER');
    traffic.clearHandlingPhase('HANDLER');
    traffic.release('HANDLER');
    assert.equal(enter(traffic,'PASSER','E','forward',1).entered,true);
  });
}

for(const phase of ['picking_fork_inserted','dropping_fork_inserted']){
  test(phase+' clears the positioning block but preserves other resource constraints',()=>{
    const traffic=createTrafficController([edge('FREE'),edge('BLOCKED',{occupancyResourceIds:['FRONT-J']})]);
    traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase:'positioning_pickup',resourceIds:['FRONT-J']});
    assert.equal(enter(traffic,'A1','FREE','forward',1).entered,false);
    traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase,resourceIds:['FRONT-J']});
    assert.equal(enter(traffic,'A1','FREE','forward',1).entered,true);
    traffic.release('A1');
    assert.equal(enter(traffic,'A2','BLOCKED','forward',2).entered,false);
    assert.equal(traffic.snapshot().owners['FRONT-J'],'HANDLER');
  });
}

test('fork inserted does not override a one-lane occupation',()=>{
  const traffic=createTrafficController([edge('E',{lanes:[{id:'ONE',direction:'both'}],
    lanePolicy:{laneCount:1,simultaneousPassing:'no-alternating'}})]);
  enter(traffic,'HANDLER','E','forward',1);
  traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase:'positioning_pickup'});
  traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase:'picking_fork_inserted'});
  assert.equal(enter(traffic,'A2','E','forward',2).entered,false);
  assert.equal(traffic.snapshot().owners.ONE,'HANDLER');
});

test('turn resources remain occupied and are inherited by the next segment atomically',()=>{
  const traffic=createTrafficController([edge('E',{occupancyResourceIds:['TURN-J']})]);
  assert.equal(traffic.reserveResources({agfId:'TURNER',resourceIds:['TURN-J'],requestOrder:1,
    groupId:'G',groupDirection:'east'}).entered,true);
  assert.equal(enter(traffic,'A2','E','forward',2).entered,false);
  assert.equal(enter(traffic,'TURNER','E','forward',3).entered,true);
  assert.equal(traffic.snapshot().owners['TURN-J'],'TURNER');
  assert.throws(()=>enter(traffic,'TURNER','E','forward',4),/already holds/);
  traffic.release('TURNER');
  assert.deepEqual(traffic.snapshot().owners,{});
});

test('resource reservation is atomic and cannot erase previously held lane resources',()=>{
  const traffic=createTrafficController([edge('E')]);
  enter(traffic,'A1','E','forward',1);
  traffic.reserveResources({agfId:'A2',resourceIds:['J2'],requestOrder:2});
  const before=traffic.snapshot();
  assert.equal(traffic.reserveResources({agfId:'A1',resourceIds:['J1','J2'],requestOrder:3}).entered,false);
  assert.deepEqual(traffic.snapshot().owners,before.owners);
  assert.equal(traffic.snapshot().owners['E-L1'],'A1');
});

test('retaining explicit resources at segment exit preserves a turning junction only',()=>{
  const traffic=createTrafficController([edge('E',{occupancyResourceIds:['TURN-J']})]);
  enter(traffic,'A1');
  traffic.release('A1',{retainResourceIds:['TURN-J'],keepFollowingOrder:true});
  assert.deepEqual(traffic.snapshot().owners,{'TURN-J':'A1'});
  traffic.releaseResources('A1',['TURN-J']);
  assert.deepEqual(traffic.snapshot().owners,{});
  traffic.leaveGroup('A1');
  assert.deepEqual(traffic.snapshot().followingOrder,[]);
});

test('added following and handling waits remain visible to deadlock detection',()=>{
  const traffic=createTrafficController([edge('E')]);
  enter(traffic,'A1','E','forward',1);
  enter(traffic,'A2','E','forward',2);
  traffic.waitFor('A1',['A2']);
  assert.deepEqual(traffic.detectDeadlocks(),[['A1','A2']]);
});

test('a same-direction follower cannot reserve a free turning resource ahead of its leader',()=>{
  const traffic=createTrafficController([edge('E')]);
  enter(traffic,'LEADER','E','forward',1);
  const reserved=traffic.reserveResources({agfId:'FOLLOWER',resourceIds:['AHEAD-TURN'],requestOrder:2,
    groupId:'G',groupDirection:'east'});
  assert.equal(reserved.entered,false);
  assert.equal(reserved.reason,'NO_OVERTAKING');
  assert.equal(traffic.snapshot().owners['AHEAD-TURN'],undefined);
});

test('split two-lane edges preserve lane resource identity and permit only the other original lane',()=>{
  const make=id=>edge(id,{noOvertakingGroupId:null,lanes:[
    {id:id+'-L1',resourceId:'ORIGINAL-L1',direction:'both'},
    {id:id+'-L2',resourceId:'ORIGINAL-L2',direction:'both'}]});
  const traffic=createTrafficController([make('PART1'),make('PART2')]);
  assert.equal(enter(traffic,'A1','PART1').laneId,'PART1-L1');
  assert.equal(enter(traffic,'A2','PART2').laneId,'PART2-L2');
  assert.equal(enter(traffic,'A3','PART2').entered,false);
  assert.deepEqual(traffic.snapshot().owners,{'ORIGINAL-L1':'A1','ORIGINAL-L2':'A2'});
});

test('invalid handling phase cannot alter occupied resources or release an existing block',()=>{
  const traffic=createTrafficController([edge('E')]);
  traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase:'positioning_pickup',resourceIds:['FRONT-J']});
  const before=traffic.snapshot();
  assert.throws(()=>traffic.setHandlingPhase({agfId:'HANDLER',groupId:'G',phase:'invented'}),/unknown handling phase/);
  assert.deepEqual(traffic.snapshot(),before);
});

const candidate=(agfId,loaded=false,overrides={})=>({agfId,moving:true,loaded,avoidancePossible:true,...overrides});
test('avoidance selects the only moving vehicle with an explicit feasible avoidance operation',()=>{
  const selected=chooseAvoidance({candidates:[candidate('A1',false,{avoidancePossible:false}),candidate('A2',true)]});
  assert.equal(selected.agfId,'A2');
  assert.equal(selected.reason,'ONLY_FEASIBLE_MOVING_AGF');
  assert.equal(chooseAvoidance({candidates:[candidate('A1',false,{moving:false}),candidate('A2',true)]}).agfId,'A2');
});

test('empty moving vehicle avoids before a loaded moving vehicle regardless of task selection order',()=>{
  for(const candidates of [[candidate('A1',true),candidate('A2')],[candidate('A2'),candidate('A1',true)]]){
    const selected=chooseAvoidance({candidates});
    assert.equal(selected.agfId,'A2');
    assert.equal(selected.reason,'EMPTY_MOVING_PRIORITY');
    assert.equal(selected.evidence,'user-confirmed-rule');
  }
});

test('same-state avoidance tie remains explicitly unresolved without a declared model tie-break',()=>{
  for(const loaded of [false,true]){
    const selected=chooseAvoidance({candidates:[candidate('A2',loaded),candidate('A1',loaded)]});
    assert.equal(selected.status,'unresolved');
    assert.equal(selected.reason,'AVOIDANCE_TIE_UNRESOLVED');
    assert.equal(selected.agfId,null);
  }
});

test('synthetic ID avoidance tie-break requires explicit evidence and is deterministic',()=>{
  const candidates=[candidate('A2'),candidate('A1')];
  const selected=chooseAvoidance({candidates,tieBreakPolicy:{kind:'agf_id',evidence:'synthetic-model-tiebreak'}});
  assert.equal(selected.agfId,'A1');
  assert.equal(selected.evidence,'synthetic-model-tiebreak');
  assert.throws(()=>chooseAvoidance({candidates,tieBreakPolicy:{kind:'agf_id'}}),/synthetic-model-tiebreak/);
});

test('no available moving avoidance vehicle is held rather than inventing a route',()=>{
  const selected=chooseAvoidance({candidates:[candidate('A1',false,{avoidancePossible:false}),candidate('A2',true,{moving:false})]});
  assert.equal(selected.status,'unavailable');
  assert.equal(selected.reason,'NO_EXPLICIT_AVOIDANCE_ROUTE');
  assert.equal(selected.agfId,null);
});

const avoidanceGraph=()=>({schemaVersion:'operational-topology-v1',datasetKind:'synthetic',
  evidence:'synthetic-assumption',coordinateSystem:'synthetic-display',
  readiness:{operationalRoutingReady:true,physicalEtaAllowed:false},
  nodes:[{id:'MAIN',type:'junction',x:0,y:0},{id:'TURN',type:'turn',x:0,y:10},{id:'BAY',type:'wait',x:10,y:10}]
    .map(n=>({...n,areaId:'PZ',approvalState:'synthetic-validated'})),
  edges:[{id:'OUT1',fromNodeId:'MAIN',toNodeId:'TURN',distanceMm:1000},
    {id:'OUT2',fromNodeId:'TURN',toNodeId:'BAY',distanceMm:1000}]
    .map(e=>({...e,speedMmPerSec:{empty:1000,loaded:500,charge:1000,wait:1000},
      lanes:[{id:e.id+'-L1',direction:'both'}],lanePolicy:{laneCount:1,simultaneousPassing:'no-alternating'},
      occupancyResourceIds:[],approvalState:'synthetic-validated',accessScopes:[{movement:'empty',taskTypes:['*']},{movement:'loaded',taskTypes:['*']}]})),
  interfaceBindings:[],shutters:[],avoidancePlans:[{id:'SYNTHETIC-BAY',fromNodeId:'MAIN',viaNodeId:'BAY',
    outboundEdgeIds:['OUT1','OUT2'],returnEdgeIds:['OUT2','OUT1'],conflictGroupId:'G',evidence:'synthetic-assumption'}]});

test('explicit synthetic avoidance plan supplies exactly the declared outbound and return edges',()=>{
  const plan=findExplicitAvoidancePlan(avoidanceGraph(),{currentNodeId:'MAIN',conflictGroupId:'G',movement:'empty',taskType:'01'});
  assert.equal(plan.planId,'SYNTHETIC-BAY');
  assert.deepEqual(plan.outboundPath.steps.map(s=>s.edgeId),['OUT1','OUT2']);
  assert.deepEqual(plan.returnPath.steps.map(s=>s.edgeId),['OUT2','OUT1']);
  assert.equal(plan.outboundPath.steps.at(-1).toNodeId,'BAY');
  assert.equal(plan.returnPath.steps.at(-1).toNodeId,'MAIN');
  assert.equal(plan.outboundPath.modelDurationMs,2000);
  assert.equal(plan.returnPath.measuredDistanceMm,null);
  assert.equal(plan.evidence,'synthetic-assumption');
});

test('missing explicit avoidance node or plan never generates a nearby refuge',()=>{
  const graph=avoidanceGraph();graph.avoidancePlans=[];
  assert.equal(findExplicitAvoidancePlan(graph,{currentNodeId:'MAIN',conflictGroupId:'G',movement:'empty',taskType:'01'}),null);
  assert.equal(findExplicitAvoidancePlan(avoidanceGraph(),{currentNodeId:'TURN',conflictGroupId:'G',movement:'empty',taskType:'01'}),null);
});

test('avoidance rejects disallowed reverse lanes and task/movement access',()=>{
  const graph=avoidanceGraph();graph.edges[0].lanes[0].direction='forward';
  assert.throws(()=>findExplicitAvoidancePlan(graph,{currentNodeId:'MAIN',conflictGroupId:'G',movement:'empty',taskType:'01'}),/forbidden avoidance edge/);
  const restricted=avoidanceGraph();restricted.edges[0].accessScopes=[{movement:'loaded',taskTypes:['05']}];
  assert.equal(findExplicitAvoidancePlan(restricted,{currentNodeId:'MAIN',conflictGroupId:'G',movement:'loaded',taskType:'01'}),null);
});

test('declared avoidance route uses model distance and speed, never displayed geometry',()=>{
  const graph=avoidanceGraph();graph.nodes[1].y=100000;
  const plan=findExplicitAvoidancePlan(graph,{currentNodeId:'MAIN',conflictGroupId:'G',movement:'loaded',taskType:'02'});
  assert.equal(plan.outboundPath.modelDistanceMm,2000);
  assert.equal(plan.outboundPath.modelDurationMs,4000);
});
