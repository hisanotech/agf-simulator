import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMetricLayoutProfile, metricPoint, metricWorldBounds,
  createMetricCanvasProjection, convertTopologyToMetric
} from '../src/map/metric-layout.mjs';
import {validateOperationalTopology,findOperationalPath,splitSyntheticDisplayTurns}
  from '../src/map/operational-topology.mjs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';

// Invented round anchors are software test inputs, never facility dimensions.
const profile=()=>({schemaVersion:'metric-layout-profile-v1',id:'SYNTHETIC-ROUND-ANCHORS',revision:1,
  evidence:'synthetic-test-assumption',coordinateUnit:'mm',
  readiness:{physicalEtaAllowed:false,metricScaleVerified:false},
  axisAnchors:{x:[[0,0],[10,20000],[20,40000]],y:[[0,0],[10,5000],[20,15000]]}});
function legacyGraph(){
  return {schemaVersion:'operational-topology-v1',datasetKind:'synthetic',evidence:'synthetic-assumption',
    coordinateSystem:'synthetic-display',readiness:{operationalRoutingReady:true,physicalEtaAllowed:false},
    nodes:[{id:'START',type:'home',areaId:'PZ',x:0,y:0,approvalState:'synthetic-validated'},
      {id:'END',type:'pickup',areaId:'PZ',x:10,y:10,approvalState:'synthetic-validated',
        localHandlingBlockedEdgeIds:['BENT'],handlingScopeEvidence:'synthetic-equipment-front-edge-declaration-not-site-boundary'},
      {id:'CHARGE',type:'charge',areaId:'WH',x:0,y:10,approvalState:'synthetic-validated'}],
    edges:[{id:'BENT',fromNodeId:'START',toNodeId:'END',distanceMm:3000,
      speedMmPerSec:{empty:1000,loaded:800,charge:900,wait:1000},
      lanes:[{id:'LANE',direction:'both'}],lanePolicy:{laneCount:1,simultaneousPassing:'no-alternating'},
      occupancyResourceIds:['DECLARED-JUNCTION'],shutterId:'SYNTHETIC-SH',
      accessScopes:['empty','loaded','charge','wait'].map(movement=>({movement,taskTypes:['*']})),
      approvalState:'synthetic-validated',displayPath:[{x:0,y:0},{x:10,y:0},{x:10,y:10}],
      noOvertakingGroupId:'SYNTHETIC-CORRIDOR',noOvertakingForwardDirection:'forward'}],
    shutters:[{id:'SYNTHETIC-SH',initiallyPassable:true}],interfaceBindings:[{pattern:'L1',nodeId:'END'}],
    avoidancePlans:[{id:'SYNTHETIC-RETREAT',fromNodeId:'START',viaNodeId:'END',
      outboundEdgeIds:['BENT'],returnEdgeIds:['BENT'],conflictGroupId:'SYNTHETIC-CORRIDOR',evidence:'synthetic-assumption'}]};
}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);

test('metric profiles interpolate each declared axis without silently claiming a verified site scale',()=>{
  const p=profile();validateMetricLayoutProfile(p);
  assert.deepEqual(metricPoint({x:5,y:15},p),{x:10000,y:10000});
  assert.deepEqual(metricPoint({x:-5,y:30},p),{x:-10000,y:25000});
  assert.deepEqual(metricWorldBounds(p),{x:0,y:0,width:40000,height:15000,minX:0,minY:0,maxX:40000,maxY:15000});
  for(const mutate of [p=>p.coordinateUnit='m',p=>p.readiness.physicalEtaAllowed=true,
    p=>p.readiness.metricScaleVerified=true,p=>p.axisAnchors.x=[[0,0]],
    p=>p.axisAnchors.x=[[0,0],[0,1000]],p=>p.axisAnchors.x=[[0,0],[10,-1000]],
    p=>p.axisAnchors.y=[[0,0],[10,NaN]],p=>delete p.evidence]){
    const invalid=profile();mutate(invalid);assert.throws(()=>validateMetricLayoutProfile(invalid),/metric/i);
  }
});

test('a single canvas scale preserves millimeter distance ratios and inverse point projection',()=>{
  const projection=createMetricCanvasProjection(profile(),{width:1400,height:850,padding:24});
  const a=projection.point({x:0,y:0}),b=projection.point({x:1000,y:0}),c=projection.point({x:0,y:1000});
  near(b.x-a.x,c.y-a.y);near(projection.scale,1352/40000);
  assert.deepEqual(projection.inversePoint(projection.point({x:20000,y:7500})),{x:20000,y:7500});
  assert.ok(a.x>=24&&a.y>=24);
  const end=projection.point({x:40000,y:15000});assert.ok(end.x<=1376&&end.y<=826);
  assert.throws(()=>createMetricCanvasProjection(profile(),{width:40,padding:24}),/canvas/i);
});

test('metric conversion preserves graph logic and copies the exact profile used to calculate distance',()=>{
  const input=legacyGraph(),before=structuredClone(input),p=profile(),converted=convertTopologyToMetric(input,p);
  assert.deepEqual(input,before);assert.equal(converted.coordinateSystem,'synthetic-mm');
  assert.equal(converted.coordinateUnit,'mm');assert.equal(converted.readiness.physicalEtaAllowed,false);
  assert.equal(converted.readiness.metricScaleVerified,false);assert.equal(converted.datasetKind,'synthetic');
  assert.equal(converted.evidence,'synthetic-assumption');assert.deepEqual(converted.metricLayoutProfile,p);
  assert.equal(converted.edges[0].distanceMm,25000);
  assert.deepEqual(converted.edges[0].displayPath,[{x:0,y:0},{x:20000,y:0},{x:20000,y:5000}]);
  assert.deepEqual(converted.nodes.map(n=>n.id),before.nodes.map(n=>n.id));
  for(const field of ['id','fromNodeId','toNodeId','speedMmPerSec','lanes','lanePolicy','accessScopes',
    'occupancyResourceIds','shutterId','noOvertakingGroupId','noOvertakingForwardDirection'])
    assert.deepEqual(converted.edges[0][field],before.edges[0][field],field);
  assert.deepEqual(converted.interfaceBindings,before.interfaceBindings);
  assert.deepEqual(converted.avoidancePlans,before.avoidancePlans);assert.deepEqual(converted.shutters,before.shutters);
  validateOperationalTopology(converted);
  p.axisAnchors.x[1][1]=123;assert.equal(converted.metricLayoutProfile.axisAnchors.x[1][1],20000);
});

test('metric topology rejects missing profile, unit mismatch and distances inconsistent with its millimeter path',()=>{
  const metric=convertTopologyToMetric(legacyGraph(),profile());
  for(const mutate of [g=>delete g.metricLayoutProfile,g=>g.coordinateUnit='m',
    g=>g.edges[0].distanceMm=3000,g=>g.edges[0].displayPath[1].x+=10]){
    const invalid=structuredClone(metric);mutate(invalid);assert.throws(()=>validateOperationalTopology(invalid),/metric|distance/i);
  }
});

test('metric edge distances determine phase duration and projected movement without visual speed jumps',()=>{
  const graph=convertTopologyToMetric(legacyGraph(),profile());
  for(const [movement,expected] of [['empty',25000],['loaded',31250],['charge',27778],['wait',25000]]){
    const route=findOperationalPath(graph,'START','END',{movement,taskType:'01'});
    assert.equal(route.modelDistanceMm,25000);assert.equal(route.modelDurationMs,expected);
    assert.equal(route.measuredDistanceMm,null);assert.equal(route.etaStatus,'synthetic-assumption');
  }
  const moving={movement:{current:{fromNodeId:'START',toNodeId:'END',enteredAt:0,exitAt:25000,
    displayPath:graph.edges[0].displayPath}}};
  const position=time=>projectAgfPosition(moving,graph,time);
  assert.deepEqual([position(12000).x,position(12000).y],[12000,0]);
  near(position(21000).x,20000);near(position(21000).y,1000);
  near(Math.hypot(position(12000).x-position(11000).x,position(12000).y-position(11000).y),1000);
  near(Math.hypot(position(22000).x-position(21000).x,position(22000).y-position(21000).y),1000);
});

test('metric bend splitting uses each millimeter segment while legacy display splitting stays compatible',()=>{
  const legacy=legacyGraph(),metric=convertTopologyToMetric(legacy,profile());
  assert.deepEqual(splitSyntheticDisplayTurns(legacy).edges.map(e=>e.distanceMm),[1500,1500]);
  const split=splitSyntheticDisplayTurns(metric);
  assert.deepEqual(split.edges.map(e=>e.distanceMm),[20000,5000]);
  assert.ok(split.edges.every(e=>e.splitSourceDistanceMm===25000));
  assert.deepEqual(splitSyntheticDisplayTurns(split),split);
  assert.deepEqual(split.avoidancePlans[0].outboundEdgeIds,['BENT','BENT-PART2']);
  assert.deepEqual(split.avoidancePlans[0].returnEdgeIds,['BENT-PART2','BENT']);
  assert.ok(split.edges.every(e=>e.occupancyResourceIds.includes('LANE')&&e.occupancyResourceIds.includes('DECLARED-JUNCTION')));
  assert.deepEqual(split.nodes.find(n=>n.id==='END').localHandlingBlockedEdgeIds,['BENT','BENT-PART2']);
  assert.equal(findOperationalPath(split,'START','END',{movement:'empty',taskType:'01'}).modelDurationMs,25000);
});

test('conversion recalculates already split source totals and never applies the coordinate transform twice',()=>{
  const legacy=splitSyntheticDisplayTurns(legacyGraph()),p=profile(),metric=convertTopologyToMetric(legacy,p);
  assert.deepEqual(metric.edges.map(e=>e.distanceMm),[20000,5000]);
  assert.ok(metric.edges.every(e=>e.splitSourceDistanceMm===25000));
  assert.deepEqual(convertTopologyToMetric(metric,p),metric);
  const changed=profile();changed.revision=2;assert.throws(()=>convertTopologyToMetric(metric,changed),/metric.*profile|already/i);
});

test('metric split-source totals cannot retain stale distances after conversion or manual edits',()=>{
  const metric=convertTopologyToMetric(splitSyntheticDisplayTurns(legacyGraph()),profile());
  metric.edges[1].splitSourceDistanceMm=3000;
  assert.throws(()=>validateOperationalTopology(metric),/metric.*split|split.*distance/i);
});

test('metric conversion rejects nonfinite extrapolation rather than returning unrenderable nodes',()=>{
  const p=profile();p.axisAnchors.x=[[0,0],[1,1e308]];
  assert.throws(()=>metricPoint({x:10,y:0},p),/metric.*finite/i);
});

const bandProfile=()=>({...profile(),xBands:[
  {atY:5,anchors:[[0,0],[10,10000],[20,40000]]},
  {atY:15,anchors:[[0,0],[10,20000],[20,40000]]}
]});
test('separate layout x bands keep PZ spacing distinct from uniform warehouse column pitch',()=>{
  const p=bandProfile();validateMetricLayoutProfile(p);
  assert.deepEqual(metricPoint({x:10,y:0},p),{x:10000,y:0});
  assert.deepEqual(metricPoint({x:10,y:10},p),{x:15000,y:5000});
  assert.deepEqual(metricPoint({x:10,y:20},p),{x:20000,y:15000});
  const wh=[0,5,10,15,20].map(x=>metricPoint({x,y:20},p).x);
  assert.deepEqual(wh.slice(1).map((x,i)=>x-wh[i]),[10000,10000,10000,10000]);
  // A shared x anchor can preserve a shutter axis independently of other gaps.
  for(const y of [0,5,10,15,20])assert.equal(metricPoint({x:20,y},p).x,40000);
  const graph=convertTopologyToMetric(legacyGraph(),p);
  assert.deepEqual(graph.nodes.find(n=>n.id==='END').x,15000);
  const points=graph.edges[0].displayPath;
  assert.equal(graph.edges[0].distanceMm,10000+Math.hypot(5000,5000));
  assert.deepEqual(points,[{x:0,y:0},{x:10000,y:0},{x:15000,y:5000}]);
  validateOperationalTopology(graph);
});

test('band anchors expand world bounds and reject missing, unordered or nonfinite declarations',()=>{
  const p=bandProfile();p.xBands[1].anchors=[[0,-10000],[20,50000]];
  assert.deepEqual(metricWorldBounds(p),{x:-10000,y:0,width:60000,height:15000,
    minX:-10000,minY:0,maxX:50000,maxY:15000});
  for(const mutate of [p=>p.xBands=[],p=>p.xBands.pop(),p=>p.xBands[1].atY=5,
    p=>p.xBands[0].atY=NaN,p=>delete p.xBands[1].anchors,
    p=>p.xBands[0].anchors=[[0,0],[0,1000]],p=>p.xBands[0].anchors=[[0,0],[10,-1000]]]){
    const invalid=bandProfile();mutate(invalid);assert.throws(()=>validateMetricLayoutProfile(invalid),/metric/i);
  }
});

test('conversion separates historical distance assumptions from its current metric timing evidence',()=>{
  const g=legacyGraph();g.modelEvidence={deviceBranchDistanceMm:1000,crossingDistanceMm:6000,
    timingBasis:'old-explicit-distance',directionPolicy:'existing-logical-policy'};
  const converted=convertTopologyToMetric(g,profile());
  assert.equal(converted.modelEvidence.deviceBranchDistanceMm,undefined);
  assert.equal(converted.modelEvidence.crossingDistanceMm,undefined);
  assert.deepEqual(converted.modelEvidence.legacyDistanceEvidence,g.modelEvidence);
  assert.equal(converted.modelEvidence.directionPolicy,'existing-logical-policy');
  assert.equal(converted.modelEvidence.timingBasis,'model-millimeter-polyline-distance-and-explicit-speed-not-measured-ETA');
});
