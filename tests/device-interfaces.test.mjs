import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {findOperationalPath,resolveInterfaceNode,validateOperationalTopology,splitSyntheticDisplayTurns} from '../src/map/operational-topology.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {createLegacyScenario} from '../src/ui/scenario.mjs';

const graph=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
const evidence='synthetic-device-interface-not-site-stop';
const equipmentOrder=['PGW8','PM1','PGW7','PM2','PGW5','PM3','PGW4','HI','WRAPPER','HO','PGW2','PM4','PGW1','PGW3','PM5','PGW6'];
const node=id=>graph.nodes.find(n=>n.id===id);
const empty=(from,to,taskType='01')=>findOperationalPath(graph,from,to,{movement:'empty',taskType});

test('all eight production interfaces terminate at their own PGW pickup stop',()=>{
  const ids=[];
  for(let n=1;n<=8;n++){
    const id=resolveInterfaceNode(graph,'L'+n),stop=node(id);
    assert.equal(id,`PZ-L${n}-PICKUP`);
    assert.equal(stop.type,'pickup');assert.equal(stop.interfaceId,'L'+n);
    assert.equal(stop.equipmentId,'PGW'+n);assert.equal(stop.evidence,evidence);
    assert.deepEqual([stop.x,stop.y],[43+equipmentOrder.indexOf('PGW'+n)*63+55/2,119]);
    ids.push(id);
  }
  assert.equal(new Set(ids).size,8);
  assert.equal(graph.readiness.physicalEtaAllowed,false);
  assert.equal(resolveInterfaceNode(graph,'L9'),null);
});

test('every PGW and magazine stop branches north from palletizing aisle one',()=>{
  for(const prefix of ['L','M'])for(let n=1;n<=(prefix==='L'?8:5);n++){
    const stop=node(resolveInterfaceNode(graph,prefix+n));
    const branches=graph.edges.filter(edge=>[edge.fromNodeId,edge.toNodeId].includes(stop.id));
    assert.equal(branches.length,1);
    const branch=branches[0],junction=node(branch.fromNodeId===stop.id?branch.toNodeId:branch.fromNodeId);
    assert.equal(junction.y,173);assert.equal(junction.x,stop.x);
    assert.equal(junction.corridorId,'PZ-A1');assert.equal(branch.evidence,evidence);
    assert.equal(branch.modelDistanceEvidence,'explicit-synthetic-device-branch-distance-not-display-length');
    assert.ok(empty('WH-HOME',stop.id,prefix==='L'?'01':'03'));
  }
});

test('each individual device stop holds an explicit synthetic stop resource through handling and turning',()=>{
  for(const stop of graph.nodes.filter(n=>n.evidence===evidence)){
    const resource='DEVICE-STOP:'+stop.interfaceId;
    assert.deepEqual(stop.occupancyResourceIds,[resource]);
    assert.ok(stop.handlingResourceIds.includes(resource));
    const branch=graph.edges.find(e=>e.toNodeId===stop.id);
    assert.ok(branch.occupancyResourceIds.includes(resource));
    // Retaining a device footprint must not occupy the whole travel aisle after
    // fork insertion; aisle positioning is a separate declared handling group.
    assert.ok(stop.handlingResourceIds.every(id=>!id.startsWith('PZ-A1-MAIN')));
  }
});

test('magazines, temporary places and aligners have distinct device stops and no generic binding',()=>{
  for(const [prefix,count,type,old] of [['M',5,'dropoff','PZ-MAG'],['OT',3,'pickup','PZ-OT'],['AL',5,'pickup','WH-ALIGN']]){
    const ids=[];
    for(let n=1;n<=count;n++){
      const id=resolveInterfaceNode(graph,prefix+n),stop=node(id);
      assert.ok(stop);assert.equal(stop.type,type);assert.equal(stop.interfaceId,prefix+n);
      assert.equal(stop.evidence,evidence);assert.notEqual(id,old);ids.push(id);
    }
    assert.equal(new Set(ids).size,count);
    assert.equal(resolveInterfaceNode(graph,prefix+(count+1)),null);
    assert.equal(node(old).type,'junction');
  }
  assert.equal(node('PZ-LINE').type,'junction');
});

test('wrapper input and output retain separate equipment stops through their aisle-one branches',()=>{
  const input=node(resolveInterfaceNode(graph,'WRAP-INPUT')),output=node(resolveInterfaceNode(graph,'WRAP-OUTPUT'));
  assert.equal(input.id,'PZ-WRAP-IN');assert.equal(output.id,'PZ-WRAP-OUT');assert.notEqual(input.id,output.id);
  assert.equal(input.equipmentId,'HI');assert.equal(output.equipmentId,'HO');
  assert.deepEqual([input.x,input.y],[511.5,119]);assert.deepEqual([output.x,output.y],[637.5,119]);
  for(const stop of [input,output]){
    const branch=graph.edges.find(e=>e.toNodeId===stop.id);
    assert.equal(node(branch.fromNodeId).corridorId,'PZ-A1');
    assert.equal(node(branch.fromNodeId).y,173);
  }
});

test('PGW4 empty endpoint and loaded start use the same individual pickup stop',()=>{
  const target=resolveInterfaceNode(graph,'L4');
  const inbound=empty('CHARGE-PLACE1',target),outbound=findOperationalPath(graph,target,'PZ-WRAP-IN',{movement:'loaded',taskType:'01'});
  assert.ok(inbound);assert.ok(outbound);
  assert.equal(inbound.steps.at(-1).toNodeId,'PZ-L4-PICKUP');
  assert.equal(outbound.steps[0].fromNodeId,'PZ-L4-PICKUP');
  assert.deepEqual(inbound.steps.at(-1).displayPath.at(-1),{x:448.5,y:119});
  assert.equal(inbound.steps.at(-1).fromNodeId,node(target).accessNodeId);
});

test('disconnecting one individual device branch fails routing instead of resolving its generic junction',()=>{
  for(let n=1;n<=8;n++){
    const changed=structuredClone(graph),target=resolveInterfaceNode(changed,'L'+n);
    changed.edges=changed.edges.filter(e=>e.toNodeId!==target&&e.fromNodeId!==target);
    assert.equal(findOperationalPath(changed,'WH-HOME',target,{movement:'empty',taskType:'01'}),null);
    assert.equal(resolveInterfaceNode(changed,'L'+n),target);
  }
});

test('operational display paths expose every turn as an explicit node and straight edge',()=>{
  validateOperationalTopology(graph);
  for(const edge of graph.edges){
    assert.equal(edge.displayPath.length,2,edge.id+' must not hide an internal bend');
    const [a,b]=edge.displayPath;
    assert.ok(a.x===b.x||a.y===b.y,edge.id+' must follow its straight schematic segment');
  }
  assert.ok(graph.nodes.some(n=>n.type==='turn'));
  for(const sourceId of ['E01','E04','E07','E08','E13','E14','E15','E16','E17']){
    const parts=graph.edges.filter(e=>e.splitSourceEdgeId===sourceId);
    assert.ok(parts.length>1,sourceId);
    assert.equal(parts.reduce((sum,e)=>sum+e.distanceMm,0),parts[0].splitSourceDistanceMm);
    assert.ok(parts.every(e=>e.modelDistanceEvidence==='explicit-synthetic-equal-segment-allocation-not-display-length'));
  }
});

test('synthetic dedicated-interface evidence cannot silently claim a physical stop',()=>{
  const changed=structuredClone(graph);
  changed.nodes.find(n=>n.id==='PZ-L4-PICKUP').evidence='site-confirmed';
  assert.throws(()=>validateOperationalTopology(changed),/device interface evidence/);
});

function bentFixture(laneCount=1){
  return {schemaVersion:'operational-topology-v1',datasetKind:'synthetic',evidence:'synthetic-assumption',
    coordinateSystem:'synthetic-display',readiness:{operationalRoutingReady:true,physicalEtaAllowed:false},
    nodes:[{id:'START',type:'home',areaId:'PZ',x:0,y:0,approvalState:'synthetic-validated'},
      {id:'END',type:'pickup',areaId:'PZ',x:4,y:300,approvalState:'synthetic-validated'}],
    edges:[{id:'BENT',fromNodeId:'START',toNodeId:'END',distanceMm:3000,
      speedMmPerSec:{empty:1000,loaded:800,charge:900},
      lanes:Array.from({length:laneCount},(_,index)=>({id:'LANE'+(index+1),direction:'both'})),
      lanePolicy:{laneCount,simultaneousPassing:laneCount===1?'no-alternating':'yes'},
      occupancyResourceIds:['DECLARED-JUNCTION'],shutterId:null,
      accessScopes:[{movement:'empty',taskTypes:['*']},{movement:'loaded',taskTypes:['*']},{movement:'charge',taskTypes:['CHARGE']}],
      approvalState:'synthetic-validated',displayPath:[{x:0,y:0},{x:4,y:0},{x:4,y:300}],
      noOvertakingGroupId:'MODEL-CORRIDOR',noOvertakingForwardDirection:'forward'}],
    interfaceBindings:[{pattern:'DEVICE',nodeId:'END'}],shutters:[]};
}

test('custom bent edges become explicit synthetic turns with distance allocation independent of display length',()=>{
  const input=bentFixture(),before=structuredClone(input),split=splitSyntheticDisplayTurns(input);
  assert.deepEqual(input,before);
  assert.equal(split.edges.length,2);assert.equal(split.nodes.length,3);
  assert.deepEqual(split.edges.map(e=>e.distanceMm),[1500,1500]);
  const turn=split.nodes.find(n=>n.type==='turn');
  assert.deepEqual([turn.x,turn.y],[4,0]);
  assert.equal(turn.turnPositionEvidence,'derived-synthetic-display-bend-not-site-turn');
  assert.ok(turn.occupancyResourceIds.length);
  const route=findOperationalPath(split,'START','END',{movement:'empty',taskType:'01'});
  assert.equal(route.modelDistanceMm,3000);assert.equal(route.modelDurationMs,3000);
  assert.deepEqual(route.steps.map(s=>s.noOvertakingGroupId),['MODEL-CORRIDOR','MODEL-CORRIDOR']);
  assert.ok(split.edges.every(e=>e.occupancyResourceIds.includes('LANE1')&&e.occupancyResourceIds.includes('DECLARED-JUNCTION')));
  assert.ok(split.edges.every(e=>e.modelDistanceEvidence==='explicit-synthetic-equal-segment-allocation-not-display-length'));
  assert.deepEqual(splitSyntheticDisplayTurns(split),split);
});

test('split two-lane geometry retains separate lane resources and remaps explicit outbound and return avoidance paths',()=>{
  const input=bentFixture(2);
  input.avoidancePlans=[{id:'EXPLICIT-SYNTHETIC-RETREAT',fromNodeId:'START',viaNodeId:'END',
    outboundEdgeIds:['BENT'],returnEdgeIds:['BENT'],conflictGroupId:'MODEL-CORRIDOR',evidence:'synthetic-assumption'}];
  const split=splitSyntheticDisplayTurns(input),ids=split.edges.map(e=>e.id);
  assert.deepEqual(split.avoidancePlans[0].outboundEdgeIds,ids);
  assert.deepEqual(split.avoidancePlans[0].returnEdgeIds,ids.toReversed());
  assert.ok(split.edges.every(e=>e.lanes[0].resourceId==='LANE1'&&e.lanes[1].resourceId==='LANE2'));
  assert.ok(split.edges.every(e=>!e.occupancyResourceIds.includes('LANE1')&&!e.occupancyResourceIds.includes('LANE2')));
  assert.ok(split.edges.every(e=>e.lanePolicy.simultaneousPassing==='yes'&&e.lanePolicy.laneCount===2));
  validateOperationalTopology(split);
});

test('invalid traffic metadata and invented or disconnected avoidance routes fail closed',()=>{
  const group=bentFixture();delete group.edges[0].noOvertakingForwardDirection;
  assert.throws(()=>validateOperationalTopology(group),/forward direction/);
  const lane=bentFixture();lane.edges[0].lanes[0].resourceId='';
  assert.throws(()=>validateOperationalTopology(lane),/lane resource/);
  const invented=bentFixture();invented.avoidancePlans=[{id:'BAD',fromNodeId:'START',viaNodeId:'END',
    outboundEdgeIds:['UNKNOWN'],returnEdgeIds:['BENT'],conflictGroupId:'MODEL-CORRIDOR',evidence:'synthetic-assumption'}];
  assert.throws(()=>validateOperationalTopology(invented),/unknown avoidance edge/);
  const wrongDirection=bentFixture();wrongDirection.edges[0].lanes[0].direction='forward';
  wrongDirection.avoidancePlans=[{id:'BAD',fromNodeId:'START',viaNodeId:'END',
    outboundEdgeIds:['BENT'],returnEdgeIds:['BENT'],conflictGroupId:'MODEL-CORRIDOR',evidence:'synthetic-assumption'}];
  assert.throws(()=>validateOperationalTopology(wrongDirection),/forbidden avoidance edge/);
});

function oneLineScenario(n){
  const s=createLegacyScenario('manual');
  s.durationMin=20;s.motionModel='synthetic_graph';s.operationalTopology=structuredClone(graph);
  s.agfs=s.agfs.map((a,i)=>({...a,currentNodeId:'WH-HOME',area:'WH',blocked:i!==0}));
  s.lineIntervalsMin=Array(8).fill(0);
  s.productionEvents=[{timeMs:0,lineId:'L'+n,palletId:'SYNTHETIC-PGW'+n,destinationLocationId:s.generatedDestinationIds[0]}];
  s.magazineUses=[];s.manualRequests=[];
  s.times={...s.times,pickupMin:.01,dropoffMin:.01,wrapMin:.05,labelMin:.01,exitMin:.01};
  // This is a named synthetic legacy handling fixture, not a site rate or a
  // guessed split of positioning and fork-inserted handling durations.
  s.motionControl={turnRateDegPerSec:45,turnRateEvidence:'synthetic-assumption',turningConsumesBattery:null};
  return s;
}

for(let n=1;n<=8;n++)test(`L${n} 01 reaches its own PGW${n} stop before pickup and departs loaded from that exact stop`,()=>{
  const scenario=oneLineScenario(n),run=simulate(scenario),task=run.final.tasks.find(t=>t.kind==='01');
  assert.equal(task.status,'completed');assert.equal(task.originId,'L'+n);
  const target='PZ-L'+n+'-PICKUP',picked=run.events.find(e=>e.type==='TASK_PICKED'&&e.taskId===task.id);
  const arrival=run.events.find(e=>e.type==='SEGMENT_EXITED'&&e.taskId===task.id&&e.movement==='empty'&&e.nodeId===target);
  assert.ok(arrival&&picked);assert.ok(arrival.sequence<picked.sequence);assert.ok(arrival.timeMs<=picked.timeMs);
  const agfAtPickup=run.snapshots[picked.sequence].agfs.find(a=>a.id===picked.agfId);
  assert.equal(agfAtPickup.currentNodeId,target);assert.equal(agfAtPickup.carriedPalletId,task.palletId);
  assert.equal(task.emptyRoute.steps.at(-1).toNodeId,target);
  assert.equal(task.loadedRoute.steps[0].fromNodeId,target);
  assert.deepEqual(task.emptyRoute.steps.at(-1).displayPath.at(-1),{x:node(target).x,y:node(target).y});
  const loaded=run.events.find(e=>e.type==='SEGMENT_ENTERED'&&e.taskId===task.id&&e.movement==='loaded');
  assert.equal(loaded.fromNodeId,target);assert.ok(loaded.sequence>picked.sequence);
  assert.deepEqual(run.final.traffic.owners,{});
  assert.ok(!run.events.some(e=>e.type==='DEADLOCK_DETECTED'));
  assert.ok(!run.events.some(e=>e.type==='TASK_PICKED'&&e.taskId===task.id&&
    run.snapshots[e.sequence].agfs.find(a=>a.id===e.agfId).currentNodeId!==target));
});

test('a disconnected PGW4 access keeps 01 queued without pickup or AGF teleportation',()=>{
  const s=oneLineScenario(4),target='PZ-L4-PICKUP';
  s.operationalTopology.edges=s.operationalTopology.edges.filter(e=>e.fromNodeId!==target&&e.toNodeId!==target);
  const run=simulate(s),task=run.final.tasks.find(t=>t.kind==='01');
  assert.equal(task.status,'queued');assert.equal(task.waitReason,'UNREACHABLE_ROUTE');
  assert.ok(!run.events.some(e=>e.taskId===task.id&&['TASK_PICKED','SEGMENT_ENTERED'].includes(e.type)));
  assert.ok(run.final.agfs.every(a=>a.currentNodeId==='WH-HOME'&&a.carriedPalletId===null));
  assert.equal(run.final.lines.L4.length,1);
});
