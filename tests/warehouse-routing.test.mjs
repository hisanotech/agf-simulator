import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {findOperationalPath,resolveInterfaceNode} from '../src/map/operational-topology.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';
import {snapshotIndexAt} from '../src/ui/replay-model.mjs';
import {initMap} from '../src/ui/map-view.mjs';
import {warehouseLocations} from '../src/map/warehouse-layout.mjs';
import {SCHEMATIC_LAYOUT} from '../src/map/schematic-layout.mjs';

const graph=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
const stops=['WH-HOME','HP1','HP2','CHARGE-PLACE1','CHARGE-PLACE2','PILLAR-WAIT-E','PILLAR-WAIT-W'];
const path=(origin,dest,kind='02',g=graph)=>findOperationalPath(g,resolveInterfaceNode(g,origin),resolveInterfaceNode(g,dest),{movement:'loaded',taskType:kind});
const crosses=route=>route.steps.filter(s=>s.shutterId?.startsWith('SH-FIRE')).map(s=>s.shutterId);
for(const block of ['WB1','WB2','WB3','EB1','EB2'])test(`${block}: 02 and 05 reach the target row without south service or waiting stops`,()=>{
  const dest=block+'-R01-C01-T1';
  for(const [kind,origin] of [['02','WRAP-OUTPUT'],['05','OT1']]){
    const route=path(origin,dest,kind);assert.ok(route);
    assert.equal(route.steps.at(-1).toNodeId,block+'-R01-DROP');
    assert.ok(route.steps.every(s=>!stops.includes(s.fromNodeId)&&!stops.includes(s.toNodeId)));
    assert.deepEqual(crosses(route),block.startsWith('WB')?['SH-FIRE-NORTH']:[]);
    assert.ok(route.steps.some(s=>s.edgeId==='E09'));
  }
  const two=path('WRAP-OUTPUT',dest).steps,five=path('OT1',dest,'05').steps;
  assert.deepEqual(two.slice(two.findIndex(s=>s.fromNodeId==='WH-GATE')),five.slice(five.findIndex(s=>s.fromNodeId==='WH-GATE')));
});
test('all 802 synthetic slots resolve to their own row interface; row lanes stay exclusive and bidirectional',()=>{
  for(const slot of warehouseLocations()){
    assert.equal(resolveInterfaceNode(graph,slot.id),slot.rowId+'-DROP');
    const route=path('WRAP-OUTPUT',slot.id);assert.ok(route);
    assert.ok(route.steps.every(s=>!stops.includes(s.fromNodeId)&&!stops.includes(s.toNodeId)));
    assert.deepEqual(crosses(route),slot.blockId.startsWith('WB')?['SH-FIRE-NORTH']:[]);
    const edge=graph.edges.find(e=>e.id===route.steps.at(-1).edgeId);
    assert.deepEqual(edge.lanes.map(l=>l.direction),['both']);assert.equal(edge.lanePolicy.laneCount,1);
    assert.equal(edge.lanePolicy.simultaneousPassing,'no-alternating');
  }
});
test('southern origin selects the shortest south fire crossing rather than hardcoding north',()=>{
  const route=findOperationalPath(graph,'WH-E-SOUTH','WB3-R13-DROP',{movement:'loaded',taskType:'05'});
  assert.ok(route);assert.deepEqual(crosses(route),['SH-FIRE-SOUTH']);
});
function scenario(){
  const s=createDemoScenario('physical');s.durationMin=30;s.lineIntervalsMin=Array(8).fill(0);
  s.productionEvents=[{timeMs:0,lineId:'L1',palletId:'ROUTE-02',destinationLocationId:'WB1-R01-C01-T1'}];
  s.agfs.forEach((a,i)=>a.blocked=i!==0);return s;
}
test('closed fire shutter waits, reopens and continues the original shortest 02 route',()=>{
  const s=scenario();s.shutterEvents=[{timeMs:0,shutterId:'SH-FIRE-NORTH',passable:false},{timeMs:20*60000,shutterId:'SH-FIRE-NORTH',passable:true}];
  const r=simulate(s),task=r.final.tasks.find(t=>t.kind==='02');assert.equal(task.status,'completed');
  const planned=r.events.find(e=>e.type==='ROUTE_PLANNED'&&e.taskId===task.id&&e.movement==='loaded');
  const waits=r.events.filter(e=>e.taskId===task.id&&e.type==='SHUTTER_WAITING');assert.equal(waits.length,1);
  assert.equal(waits[0].shutterId,'SH-FIRE-NORTH');
  const entered=r.events.filter(e=>e.type==='SEGMENT_ENTERED'&&e.taskId===task.id&&e.movement==='loaded');
  assert.deepEqual(entered.map(e=>e.edgeId),planned.edgeIds);
  assert.ok(entered.find(e=>e.edgeId===waits[0].edgeId).timeMs>=20*60000);
  assert.ok(!r.events.some(e=>e.type==='SEGMENT_ENTERED'&&e.edgeId==='E22'&&e.taskId===task.id));
});
test('saved 02 movement, interpolation and cyan display use identical engine edge paths',()=>{
  const r=simulate(scenario()),t=r.final.tasks.find(t=>t.kind==='02');
  for(const event of r.events.filter(e=>e.type==='SEGMENT_ENTERED'&&e.taskId===t.id&&e.movement==='loaded')){
    const timeMs=event.timeMs+Math.floor(event.modelDurationMs/2),snap=r.snapshots[snapshotIndexAt(r.events,timeMs)];
    const a=snap.agfs.find(a=>a.id===event.agfId),svg={innerHTML:'',setAttribute(){},addEventListener(){}};
    const step=a.movement.steps.find(s=>s.edgeId===event.edgeId),edge=graph.edges.find(e=>e.id===event.edgeId);
    assert.deepEqual(step.displayPath,step.traversal==='forward'?edge.displayPath:edge.displayPath.toReversed());
    initMap({svg,onSelectAgf(){},onSelectBlock(){}}).render(snap,a.id,{timeMs,topology:graph});
    assert.deepEqual([...svg.innerHTML.matchAll(/data-route-edge="([^"]+)"/g)].map(m=>m[1]),a.movement.steps.map(s=>s.edgeId));
    const d=step.displayPath.map((p,i)=>(i?'L':'M')+p.x+' '+p.y).join(' ');
    assert.ok(svg.innerHTML.includes(`d="${d}" class="active-route" data-route-edge="${event.edgeId}"`));
    const projected=projectAgfPosition(a,graph,timeMs);assert.ok(projected.progress>0&&projected.progress<1);
  }
});
test('every synthetic central-wall crossing belongs to one of the two permitted fire shutters',()=>{
  const ids=new Set(),wallX=550+SCHEMATIC_LAYOUT.warehouseOffsetX;
  for(const edge of graph.edges)for(let i=1;i<edge.displayPath.length;i++){
    const a=edge.displayPath[i-1],b=edge.displayPath[i];
    if((a.x-wallX)*(b.x-wallX)>=0||a.y<490||b.y<490)continue;
    const y=a.y+(b.y-a.y)*(wallX-a.x)/(b.x-a.x);
    assert.ok((y>=545&&y<=580)||(y>=752&&y<=787),`${edge.id} crosses wall at ${y}`);
    assert.equal(edge.shutterId,y<600?'SH-FIRE-NORTH':'SH-FIRE-SOUTH');ids.add(edge.shutterId);
  }
  assert.deepEqual([...ids].sort(),['SH-FIRE-NORTH','SH-FIRE-SOUTH']);
});

test('saved route geometry stays immutable through later movement while final output remains independently editable',()=>{
  const r=simulate(scenario()),assigned=r.events.find(e=>e.type==='TASK_ASSIGNED'&&e.kind==='02');
  const saved=r.snapshots[assigned.sequence].tasks.find(t=>t.id===assigned.taskId).loadedRoute;
  const points=structuredClone(saved.steps);
  assert.ok(Object.isFrozen(saved)&&Object.isFrozen(saved.steps));
  assert.ok(saved.steps.every(s=>Object.isFrozen(s)&&Object.isFrozen(s.displayPath)&&s.displayPath.every(Object.isFrozen)));
  assert.throws(()=>saved.steps[0].displayPath[0].x=9999,TypeError);
  assert.deepEqual(saved.steps,points);
  const final=r.final.tasks.find(t=>t.id===assigned.taskId);
  final.loadedRoute.steps[0].displayPath[0].x=9999;
  assert.deepEqual(saved.steps,points);
  assert.equal(r.snapshots.at(-1).tasks.find(t=>t.id===assigned.taskId).loadedRoute,saved);
});

test('saved entity versions retain requested, assigned and delivered states after later transitions',()=>{
  const r=simulate(scenario()),request=r.events.find(e=>e.type==='TASK_REQUESTED'&&e.kind==='02');
  const assigned=r.events.find(e=>e.type==='TASK_ASSIGNED'&&e.taskId===request.taskId);
  const done=r.events.find(e=>e.type==='TASK_COMPLETED'&&e.taskId===request.taskId);
  const before=r.snapshots[request.sequence].tasks.find(t=>t.id===request.taskId);
  const moving=r.snapshots[assigned.sequence].tasks.find(t=>t.id===request.taskId);
  const after=r.snapshots[done.sequence].tasks.find(t=>t.id===request.taskId);
  assert.equal(before.status,'queued');assert.equal(before.agfId,undefined);
  assert.equal(moving.status,'moving_empty');assert.equal(moving.completedAt,null);
  assert.equal(after.status,'completed');assert.equal(after.completedAt,done.timeMs);
  assert.equal(r.snapshots[request.sequence].pallets.find(p=>p.palletId===request.palletId).stage,'queued_02');
  assert.equal(r.snapshots[done.sequence].pallets.find(p=>p.palletId===request.palletId).stage,'stored');
  r.final.pallets.find(p=>p.palletId===request.palletId).stage='edited';
  assert.equal(r.snapshots.at(-1).pallets.find(p=>p.palletId===request.palletId).stage,'stored');
});
