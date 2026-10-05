import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateOperationalTopology} from '../src/map/operational-topology.mjs';

const graph=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
const nodes=new Map(graph.nodes.map(node=>[node.id,node]));
const between=(value,a,b)=>value>=Math.min(a,b)&&value<=Math.max(a,b);
const sharedResources=(a,b)=>a.occupancyResourceIds.some(id=>b.occupancyResourceIds.includes(id))||
  a.lanes.some(left=>b.lanes.some(right=>(left.resourceId??left.id)===(right.resourceId??right.id)));

test('every intersecting synthetic travel segment declares a shared exclusive junction or conflict resource',()=>{
  validateOperationalTopology(graph);
  for(let i=0;i<graph.edges.length;i++)for(let j=i+1;j<graph.edges.length;j++){
    const a=graph.edges[i],b=graph.edges[j];
    assert.equal(a.displayPath.length,2,a.id+' must expose an actual stop at every turn');
    const [a1,a2]=a.displayPath,[b1,b2]=b.displayPath;
    let cross=null;
    if(a1.x===a2.x&&b1.y===b2.y&&between(a1.x,b1.x,b2.x)&&between(b1.y,a1.y,a2.y))
      cross={x:a1.x,y:b1.y};
    if(b1.x===b2.x&&a1.y===a2.y&&between(b1.x,a1.x,a2.x)&&between(a1.y,b1.y,b2.y))
      cross={x:b1.x,y:a1.y};
    if(!cross)continue;
    const junction=[a.fromNodeId,a.toNodeId].find(id=>[b.fromNodeId,b.toNodeId].includes(id)&&
      nodes.get(id).exclusiveTraffic&&nodes.get(id).x===cross.x&&nodes.get(id).y===cross.y);
    assert.ok(junction||sharedResources(a,b),`${a.id}/${b.id} crosses without an atomic traffic declaration`);
  }
});

test('synthetic segments with overlapping centerlines share a reservable lane or conflict resource',()=>{
  for(let i=0;i<graph.edges.length;i++)for(let j=i+1;j<graph.edges.length;j++){
    const a=graph.edges[i],b=graph.edges[j],[a1,a2]=a.displayPath,[b1,b2]=b.displayPath;
    let overlap=false;
    if(a1.x===a2.x&&b1.x===b2.x&&a1.x===b1.x)
      overlap=Math.min(Math.max(a1.y,a2.y),Math.max(b1.y,b2.y))>
        Math.max(Math.min(a1.y,a2.y),Math.min(b1.y,b2.y));
    if(a1.y===a2.y&&b1.y===b2.y&&a1.y===b1.y)
      overlap=Math.min(Math.max(a1.x,a2.x),Math.max(b1.x,b2.x))>
        Math.max(Math.min(a1.x,a2.x),Math.min(b1.x,b2.x));
    if(overlap)assert.ok(sharedResources(a,b),`${a.id}/${b.id} overlaps without an exclusive declaration`);
  }
});

test('fire shutter crossing uses the actual four aisle junctions while retaining explicit synthetic distance and alternation',()=>{
  for(const [id,station] of [['E21','NORTH'],['E22','SOUTH']]){
    const parts=graph.edges.filter(edge=>edge.splitSourceEdgeId===id).sort((a,b)=>a.splitPartIndex-b.splitPartIndex);
    assert.equal(parts.length,3);
    assert.deepEqual([parts[0].fromNodeId,...parts.map(edge=>edge.toNodeId)],
      [`WH-E-${station}`,`WH-E-${station}-WALL`,`WH-W-${station}-WALL`,`WH-W-${station}`]);
    assert.equal(parts.reduce((total,edge)=>total+edge.distanceMm,0),6000);
    assert.ok(parts.every(edge=>edge.lanes.length===1&&edge.lanes[0].direction==='both'&&
      edge.lanes[0].resourceId===id+'-L1'&&edge.lanePolicy.simultaneousPassing==='no-alternating'));
    assert.ok(parts.every(edge=>edge.shutterId==='SH-FIRE-'+station));
    assert.ok(parts.every(edge=>edge.atomicPassageId==='SYNTHETIC-FIRE-PASSAGE:'+id));
  }
});

test('atomic synthetic passages reject disconnected parts and independently reservable lane resources',()=>{
  const disconnected=structuredClone(graph);
  const part=disconnected.edges.find(edge=>edge.id==='E21-PART2');
  part.fromNodeId='HP1';part.toNodeId='HP2';
  const [from,to]=[part.fromNodeId,part.toNodeId].map(id=>nodes.get(id));
  part.displayPath=[{x:from.x,y:from.y},{x:to.x,y:to.y}];
  assert.throws(()=>validateOperationalTopology(disconnected),/passage parts must be connected/);
  const independent=structuredClone(graph);
  independent.edges.find(edge=>edge.id==='E21-PART2').lanes[0].resourceId='independent-lane';
  assert.throws(()=>validateOperationalTopology(independent),/passage must retain one shared lane resource/);
});

test('outdoor return cannot pass through a vehicle stopped at the existing inlet turn',()=>{
  const parts=graph.edges.filter(edge=>edge.splitSourceEdgeId==='E09').sort((a,b)=>a.splitPartIndex-b.splitPartIndex);
  assert.equal(parts.length,2);
  assert.equal(parts[0].toNodeId,'E08-TURN1');
  assert.equal(parts[1].fromNodeId,'E08-TURN1');
  assert.ok(nodes.get('E08-TURN1').exclusiveTraffic);
  assert.equal(parts.reduce((total,edge)=>total+edge.distanceMm,0),parts[0].splitSourceDistanceMm);
  const incoming=graph.edges.find(edge=>edge.id==='E08');
  assert.ok(parts.every(edge=>sharedResources(edge,incoming)));
  assert.equal(incoming.mergeConflictResourceId,'OUTDOOR-JUNCTION');
  assert.equal(parts[1].mergeConflictResourceId,incoming.mergeConflictResourceId,
    'opposite arrivals must reserve through the whole shared passage before reaching its endpoints');
});

test('all aligner access stations and the internal service junction retain separate exclusive stops',()=>{
  for(const id of ['WH-ALIGN',...Array.from({length:5},(_,i)=>`WH-AL${i+1}-ACCESS`)]){
    const node=nodes.get(id);assert.equal(node.exclusiveTraffic,true,id);
    assert.ok(node.occupancyResourceIds.includes('NODE:'+id),id);
  }
  assert.equal(graph.nodes.filter(node=>node.equipmentId).length,23);
  assert.equal(graph.edges.some(edge=>edge.lanes.length>1),false,
    'this conservative synthetic fixture does not permit opposing vehicles on an identical display centerline');
});

test('all individual device branches precheck their existing stop before reserving the access junction',()=>{
  const branches=graph.edges.filter(edge=>edge.id.startsWith('DEVICE-'));
  assert.equal(branches.length,23);
  for(const branch of branches){
    const stop=nodes.get(branch.toNodeId),resource='DEVICE-STOP:'+stop.interfaceId;
    assert.equal(branch.fromNodeId,stop.accessNodeId);
    assert.equal(branch.mergeConflictResourceId,resource,branch.id);
    assert.ok(branch.occupancyResourceIds.includes(resource),branch.id);
    assert.ok(stop.occupancyResourceIds.includes(resource),branch.id);
    assert.equal(branch.mergeConflictEvidence,'explicit-synthetic-existing-device-stop-not-site-clearance');
  }
  const invalid=structuredClone(graph);
  invalid.edges.find(edge=>edge.id==='DEVICE-WRAP-INPUT').mergeConflictResourceId='invented-zone';
  assert.throws(()=>validateOperationalTopology(invalid),/merge resource must be included/);
});
