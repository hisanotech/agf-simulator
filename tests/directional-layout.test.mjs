import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {findOperationalPath,resolveInterfaceNode,validateOperationalTopology} from '../src/map/operational-topology.mjs';
import {WAREHOUSE_MAIN_AISLES} from '../src/map/warehouse-layout.mjs';

const graph=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
const nodeMap=new Map(graph.nodes.map(n=>[n.id,n]));
const path=(from,to,movement='empty',taskType='01')=>findOperationalPath(graph,from,to,{movement,taskType});

test('PZ is one shared running region with opposite logical lane directions',()=>{
  assert.equal(graph.trafficPolicy.pz.physicalSeparation,false);
  assert.equal(graph.trafficPolicy.pz.sharedRegionId,'PZ-SHARED');
  const north=graph.edges.filter(e=>e.corridorId==='PZ-A1'),south=graph.edges.filter(e=>e.corridorId==='PZ-A2');
  assert.ok(north.length>10&&south.length===north.length);
  assert.ok(north.every(e=>e.lanes.every(l=>l.direction==='reverse')));
  assert.ok(south.every(e=>e.lanes.every(l=>l.direction==='forward')));
  assert.ok(north.every(e=>nodeMap.get(e.fromNodeId).y===173&&nodeMap.get(e.toNodeId).y===173));
  assert.ok(south.every(e=>nodeMap.get(e.fromNodeId).y===211&&nodeMap.get(e.toNodeId).y===211));
});

test('PZ entry reaches PGW4 directly through the shared region without the old left-home detour',()=>{
  const route=path('PZ-ENTRY',resolveInterfaceNode(graph,'L4'));
  assert.ok(route);assert.equal(route.steps[0].toNodeId,'PZ-S-ENTRY');
  assert.ok(route.steps.every(s=>!['PZ-HOME','E07-TURN1','E01-TURN1'].includes(s.toNodeId)));
  assert.equal(route.steps.at(-1).toNodeId,'PZ-L4-PICKUP');
  assert.ok(route.steps.every(s=>nodeMap.get(s.toNodeId).x>=192));
});

test('every individual PZ device station has an explicit local lane-change connection',()=>{
  for(const stop of graph.nodes.filter(n=>n.equipmentId&&n.areaId==='PZ')){
    const access=nodeMap.get(stop.accessNodeId),changes=graph.edges.filter(e=>e.kind==='logical-lane-change'&&
      [e.fromNodeId,e.toNodeId].includes(access.id));
    assert.ok(changes.length,stop.id+' cannot require travel to a corridor end');
    assert.ok(changes.every(e=>e.lanes.every(l=>l.direction==='both')));
    assert.ok(changes.every(e=>e.evidence==='synthetic-explicit-lane-change-not-site-path'));
  }
});

test('all eight PZ pickup stops retain their equipment coordinates and are reachable after entry',()=>{
  const order=['PGW8','PM1','PGW7','PM2','PGW5','PM3','PGW4','HI','WRAPPER','HO','PGW2','PM4','PGW1','PGW3','PM5','PGW6'];
  for(let n=1;n<=8;n++){
    const id=resolveInterfaceNode(graph,'L'+n),stop=nodeMap.get(id),route=path('PZ-ENTRY',id);
    assert.deepEqual([stop.x,stop.y],[43+order.indexOf('PGW'+n)*63+27.5,119]);
    assert.ok(route);assert.equal(route.steps.at(-1).toNodeId,id);
    const loaded=path(id,'PZ-WRAP-IN','loaded','01');assert.ok(loaded);assert.equal(loaded.steps[0].fromNodeId,id);
  }
});

test('warehouse four main aisles use block-side down and wall-side up without changing rows or fire shutter groups',()=>{
  assert.equal(WAREHOUSE_MAIN_AISLES.length,4);
  for(const side of ['E','W']){
    const down=graph.edges.filter(e=>e.warehouseSide===side&&e.mainAisleRole==='block-side');
    const up=graph.edges.filter(e=>e.warehouseSide===side&&e.mainAisleRole==='wall-side');
    assert.ok(down.length>5&&up.length===down.length);
    assert.ok(down.every(e=>e.lanes.every(l=>l.direction==='forward')));
    assert.ok(up.every(e=>e.lanes.every(l=>l.direction==='reverse')));
    assert.ok([...down,...up].every(e=>nodeMap.get(e.fromNodeId).y<nodeMap.get(e.toNodeId).y));
  }
  assert.ok(graph.edges.filter(e=>e.id.startsWith('ACCESS-')).every(e=>e.lanes.every(l=>l.direction==='both')));
  for(const id of ['E21','E22'])assert.ok(graph.edges.find(e=>e.id===id).lanes.every(l=>l.direction==='both'));
  const fire=JSON.parse(readFileSync(new URL('../data/reference-logical-map.json',import.meta.url),'utf8'));
  for(const id of ['WH-X-U','WH-X-L']){
    const group=fire.corridors.find(c=>c.id===id);assert.equal(group.laneCount,2);
    assert.equal(group.direction,'both');assert.ok(group.lanes.every(l=>l.direction==='unresolved'));
  }
});

test('row, service, and charge connections preserve bidirectional branches while loaded warehouse routes avoid waiting stops',()=>{
  for(const edge of graph.edges.filter(e=>e.evidence==='synthetic-device-interface-not-site-stop'))
    assert.ok(edge.lanes.every(l=>l.direction==='both'));
  for(const id of ['HP1','HP2','CHARGE-PLACE1','CHARGE-PLACE2','PILLAR-WAIT-E','PILLAR-WAIT-W'])
    assert.ok(path(id,'PZ-L4-PICKUP'));
  for(const block of ['WB1','WB2','WB3','EB1','EB2']){
    const route=path('PZ-WRAP-OUT',block+'-R01-DROP','loaded','02');assert.ok(route);
    assert.ok(route.steps.every(s=>!['WH-HOME','HP1','HP2','CHARGE-PLACE1','CHARGE-PLACE2'].includes(s.toNodeId)));
  }
});

test('logical junctions and device stops declare exclusive conflict-zone resources before entry',()=>{
  validateOperationalTopology(graph);
  for(const node of graph.nodes.filter(n=>n.sharedRegionId==='PZ-SHARED'||n.mainAisleRole||n.equipmentId)){
    assert.equal(node.exclusiveTraffic,true,node.id);
    assert.ok(node.occupancyResourceIds.length,node.id);
  }
  assert.equal(graph.readiness.physicalEtaAllowed,false);
});

test('lane changes declare a reservable station conflict zone while opposite straight travel and device waits use independent resources',()=>{
  for(const change of graph.edges.filter(e=>['logical-lane-change','logical-main-aisle-change'].includes(e.kind))){
    const resource=change.mergeConflictResourceId;
    assert.ok(resource,change.id);
    for(const id of [change.fromNodeId,change.toNodeId]){
      assert.equal(nodeMap.get(id).mergeConflictResourceId,resource,id);
      assert.ok(!nodeMap.get(id).occupancyResourceIds.includes(resource),id+' straight stop must not occupy both lanes');
      for(const approach of graph.edges.filter(e=>e.id!==change.id&&[e.fromNodeId,e.toNodeId].includes(id))){
        const sameCrossing=approach.mergeConflictResourceId===resource&&
          [approach.fromNodeId,approach.toNodeId].every(endpoint=>[change.fromNodeId,change.toNodeId].includes(endpoint));
        if(sameCrossing)assert.ok(approach.occupancyResourceIds.includes(resource),
          approach.id+' fire-shutter attachment must reserve the same physical synthetic crossing');
        else assert.ok(!approach.occupancyResourceIds.includes(resource),approach.id+' straight travel must not reserve the crossing');
      }
    }
    assert.ok(change.occupancyResourceIds.includes(resource));
  }
  for(const stop of graph.nodes.filter(n=>n.equipmentId?.startsWith('PGW'))){
    assert.ok(!stop.occupancyResourceIds.some(id=>id.startsWith('LOGICAL-MERGE:')));
    assert.equal(stop.wrapperWaitArea.positionNodeId,stop.id);
    assert.deepEqual(stop.wrapperWaitArea.blocksLaneIds,[]);
    assert.deepEqual(stop.wrapperWaitArea.passingLaneIds,['PZ-A1','PZ-A2']);
  }
});
