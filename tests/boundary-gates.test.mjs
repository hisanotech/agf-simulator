import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateOperationalTopology,findOperationalPath} from '../src/map/operational-topology.mjs';
import {convertTopologyToMetric,createMetricCanvasProjection,metricPathLength} from '../src/map/metric-layout.mjs';
import {syntheticMetricLayout} from '../examples/synthetic-metric-layout.mjs';
import {createTrafficController} from '../src/core/traffic-controller.mjs';

const source=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
const point=(graph,id)=>graph.nodes.find(node=>node.id===id);
const route=(graph,from,to,movement='empty')=>findOperationalPath(graph,from,to,{movement,taskType:'02'});
const nodeIds=path=>[path.steps[0].fromNodeId,...path.steps.map(step=>step.toNodeId)];
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} differs from ${b}`);

test('separate PZ south openings place entry near and south of HO while preserving HI and HO stops',()=>{
  const entry=point(source,'PZ-ENTRY'),exit=point(source,'PZ-EXIT');
  const hi=point(source,'PZ-WRAP-IN'),ho=point(source,'PZ-WRAP-OUT');
  assert.notEqual(entry.id,exit.id);assert.ok(entry.x<exit.x);
  assert.ok(Math.abs(entry.x-ho.x)<15);assert.ok(entry.y>ho.y);
  assert.notEqual(hi.id,ho.id);assert.notEqual(hi.x,ho.x);
  assert.equal(source.readiness.physicalEtaAllowed,false);
  assert.equal(source.readiness.metricScaleVerified,false);
});

test('warehouse has a saved synthetic east offset and separate normal-east and unused-west shutters',()=>{
  const layout=source.layoutGeometry;
  assert.ok(layout,'relative building geometry is part of the saved topology');
  assert.ok(layout.buildings.WH.x>layout.buildings.PZ.x);
  assert.equal(layout.warehouseOffsetX,180);
  const east=point(source,'WH-GATE'),west=point(source,'WH-W-GATE');
  assert.ok(west&&east);assert.notEqual(west.id,east.id);assert.ok(west.x<east.x);
  assert.equal(source.edges.some(edge=>edge.fromNodeId===west.id||edge.toNodeId===west.id),false);
  const wall=layout.buildings.WH.x+510;
  for(const id of ['WH-E-NORTH-WALL','WH-W-NORTH-WALL','WH-E-SOUTH-WALL','WH-W-SOUTH-WALL']){
    const node=point(source,id);assert.ok(node.y>layout.buildings.WH.y);
    assert.ok(Math.abs(node.x-wall)<200,'fire crossing remains within the warehouse');
  }
});

test('normal east warehouse to PZ entry is a shortest time-cost route without passing the entry then reversing',()=>{
  const graph=convertTopologyToMetric(source,syntheticMetricLayout);
  const path=route(graph,'WH-GATE','PZ-ENTRY');assert.ok(path);
  assert.deepEqual(nodeIds(path),['WH-GATE','E08-TURN1','E09-TURN1','E08-TURN2','PZ-ENTRY']);
  const goal=point(graph,'PZ-ENTRY'),start=point(graph,'WH-GATE');
  const points=path.steps.flatMap(step=>step.displayPath);
  assert.ok(points.every(p=>p.x>=goal.x&&p.x<=start.x));
  for(let i=1;i<points.length;i++)assert.ok(points[i].x<=points[i-1].x,'entry approach never folds back');
  assert.equal(path.modelDurationMs,path.steps.reduce((sum,step)=>sum+
    Math.ceil(step.distanceMm/graph.edges.find(edge=>edge.id===step.edgeId).speedMmPerSec.empty*1000),0));
  const alternative=structuredClone(graph);
  const slow=alternative.edges.find(edge=>edge.id==='E08-PART2');slow.speedMmPerSec.empty=1;
  assert.ok(route(alternative,'WH-GATE','PZ-ENTRY').modelDurationMs>path.modelDurationMs);
});

test('normal PZ exit goes through outside junctions to east warehouse without using entry',()=>{
  const graph=convertTopologyToMetric(source,syntheticMetricLayout);
  const path=route(graph,'PZ-EXIT','WH-GATE','loaded');assert.ok(path);
  assert.deepEqual(nodeIds(path),['PZ-EXIT','E09-TURN1','E08-TURN1','WH-GATE']);
  assert.equal(nodeIds(path).includes('PZ-ENTRY'),false);
  assert.ok(path.steps.every(step=>graph.edges.find(edge=>edge.id===step.edgeId).occupancyResourceIds.includes('OUTDOOR-JUNCTION')));
  close(path.modelDistanceMm,path.steps.reduce((sum,step)=>sum+metricPathLength(step.displayPath),0));
});

test('building boundaries reject new or altered crossings outside their declared shutters',()=>{
  for(const make of [graph=>{
    const edge=structuredClone(graph.edges.find(e=>e.id==='E08-PART3'));
    edge.id='ILLEGAL-BOUNDARY';edge.lanes=[{id:'ILLEGAL-LANE',direction:'forward'}];
    edge.fromNodeId='E08-TURN1';edge.toNodeId='PZ-WRAP-OUT';
    edge.displayPath=[point(graph,edge.fromNodeId),point(graph,edge.toNodeId)].map(({x,y})=>({x,y}));
    graph.edges.push(edge);
  },graph=>{
    graph.edges.find(edge=>edge.id==='E08-PART3').shutterId='SH-PZ-EXIT';
  }]){
    const changed=structuredClone(source);make(changed);
    assert.throws(()=>validateOperationalTopology(changed),/boundary|opening|shutter/i);
  }
  validateOperationalTopology(source);
  validateOperationalTopology(convertTopologyToMetric(source,syntheticMetricLayout));
});

test('nonlinear private-style profile aligns outdoor turns to their actual saved gate axes before distance calculation',()=>{
  // Deliberately invented anchors test shape consistency, not a CAD measurement.
  const profile=structuredClone(syntheticMetricLayout);
  profile.id='synthetic-offset-band-test';profile.xBands=[
    {atY:322,anchors:[[0,0],[630,26000],[682.5,28000],[1280,52000]]},
    {atY:458,anchors:[[0,15000],[1280,66200]]}
  ];
  const graph=convertTopologyToMetric(source,profile);
  close(point(graph,'E08-TURN1').x,point(graph,'WH-GATE').x);
  close(point(graph,'E08-TURN2').x,point(graph,'PZ-ENTRY').x);
  close(point(graph,'E09-TURN1').x,point(graph,'PZ-EXIT').x);
  const path=route(graph,'WH-GATE','PZ-ENTRY'),goal=point(graph,'PZ-ENTRY');
  assert.ok(path.steps.flatMap(step=>step.displayPath).every(p=>p.x>=goal.x));
  for(const edge of graph.edges)close(edge.distanceMm,metricPathLength(edge.displayPath));
  assert.equal(graph.readiness.metricScaleVerified,false);assert.equal(graph.readiness.physicalEtaAllowed,false);
  validateOperationalTopology(graph);
});

test('entry moves into the existing shared lanes without a common west-home detour',()=>{
  const path=route(source,'PZ-ENTRY','PZ-WRAP-OUT');assert.ok(path);
  assert.ok(nodeIds(path).includes('PZ-S-ENTRY'));
  assert.deepEqual(nodeIds(route(source,'PZ-ENTRY','PZ-WRAP-IN')),
    ['PZ-ENTRY','PZ-S-ENTRY','PZ-N-ENTRY','PZ-WRAP-IN-ACCESS','PZ-WRAP-IN']);
  assert.equal(nodeIds(path).includes('PZ-HOME'),false);
  for(const nodeId of ['PZ-S-ENTRY','PZ-N-ENTRY'])assert.equal(point(source,nodeId).x,630);
  assert.equal(source.trafficPolicy.pz.physicalSeparation,false);
});

test('missing declared openings and fabricated openings off the gate axis fail closed',()=>{
  const missing=structuredClone(source);
  missing.layoutGeometry.boundaries[0].permittedCrossings.shift();
  assert.throws(()=>validateOperationalTopology(missing),/boundary outside a declared shutter opening/);
  const fabricated=structuredClone(source);
  const edge=fabricated.edges.find(item=>item.id==='E08-PART3');
  edge.displayPath.splice(1,0,{x:640,y:322});
  fabricated.layoutGeometry.boundaries[0].permittedCrossings[0].point.x=640;
  assert.throws(()=>validateOperationalTopology(fabricated),/boundary opening must remain on its declared gate axis/);
});

test('fire shutter stops and all warehouse devices retain their warehouse-relative positions',()=>{
  const old=source.layoutGeometry.buildings.WH;
  for(const [id,x,y] of [
    ['WH-E-NORTH-WALL',665,562.5],['WH-W-NORTH-WALL',435,562.5],
    ['WH-E-SOUTH-WALL',665,769.5],['WH-W-SOUTH-WALL',435,769.5],
    ['HP1',782,778.5],['HP2',782,809.5],['CHARGE-PLACE1',782,842.5],['CHARGE-PLACE2',782,873.5]
  ]){
    const node=point(source,id);
    assert.equal(node.x-old.x,x-25,id+' warehouse-relative x');
    assert.equal(node.y,y,id+' warehouse-relative y');
  }
});

test('expanded schematic extent is framed without changing saved metric anchors or route distances',()=>{
  const profile=structuredClone(syntheticMetricLayout);profile.legacyBounds=[0,0,1100,970];
  profile.axisAnchors.x=[[0,0],[1100,44000]];
  const saved=structuredClone(profile),graph=convertTopologyToMetric(source,profile);
  const before=route(graph,'WH-GATE','PZ-ENTRY');
  const canvas=createMetricCanvasProjection(profile,{sourceBounds:[0,0,1280,970]});
  assert.ok(canvas.bounds.maxX>=51200);
  const corner=canvas.point({x:51200,y:profile.axisAnchors.y.at(-1)[1]});
  assert.ok(corner.x<=1400-24&&corner.y<=850-24);
  assert.deepEqual(profile,saved);
  assert.deepEqual(route(graph,'WH-GATE','PZ-ENTRY'),before);
});

test('opposing exterior arrivals finish through the shared turns without a node-swap deadlock',()=>{
  for(const order of [['EXIT','ENTRY'],['ENTRY','EXIT']]){
    const traffic=createTrafficController(source.edges,{nodes:source.nodes});
    const actors={
      EXIT:{id:'EXIT',path:route(source,'PZ-EXIT','WH-GATE','loaded'),index:0},
      ENTRY:{id:'ENTRY',path:route(source,'WH-GATE','PZ-ENTRY'),index:0}
    };
    for(const actor of Object.values(actors))traffic.setNodeOccupant({agfId:actor.id,nodeId:actor.path.steps[0].fromNodeId});
    let rounds=0;
    while(Object.values(actors).some(actor=>actor.index<actor.path.steps.length)&&rounds++<20){
      for(const id of order){
        const actor=actors[id],step=actor.path.steps[actor.index];if(!step)continue;
        const entered=traffic.tryEnter({...step,agfId:id,requestOrder:rounds,
          lookaheadSteps:actor.path.steps.slice(actor.index+1)});
        if(!entered.entered)continue;
        traffic.depart({agfId:id,fromNodeId:step.fromNodeId});
        traffic.release(id,{keepFollowingOrder:true,retainResourceIds:[
          ...(point(source,step.toNodeId).occupancyResourceIds??[]),...(entered.futureResourceIds??[])]});
        traffic.commitArrival({agfId:id,nodeId:step.toNodeId});actor.index++;
      }
      assert.deepEqual(traffic.detectDeadlocks(),[]);
    }
    assert.ok(rounds<20,'opposing arrivals make progress in both request orders');
    for(const actor of Object.values(actors))assert.equal(actor.index,actor.path.steps.length);
  }
});
