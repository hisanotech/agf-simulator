import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredNeutralScenario} from './fixtures/neutral-scenario.mjs';
import {integratedAcceptanceScenario} from '../examples/integrated-acceptance.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';
import {isBatteryActive} from '../src/core/battery-model.mjs';
import {analyzeRun,durationTenths} from '../src/ui/replay-model.mjs';

const sum=values=>values.reduce((n,value)=>n+value,0);

function assertTrafficAndClock(run){
  const nodes=new Map(run.scenario.operationalTopology.nodes.map(n=>[n.id,n]));
  const edges=new Map(run.scenario.operationalTopology.edges.map(e=>[e.id,e]));
  const durationMs=Math.round(run.scenario.durationMin*60000);
  for(let index=0;index<run.snapshots.length;index++){
    const snapshot=run.snapshots[index],event=run.events[index],traffic=snapshot.traffic;
    for(const [nodeId,agfId] of Object.entries(traffic.nodeOccupants)){
      const agf=snapshot.agfs.find(a=>a.id===agfId);
      assert.ok(nodes.get(nodeId)?.exclusiveTraffic,`undeclared exclusive node ${nodeId}`);
      assert.equal(agf.currentNodeId,nodeId,`${agfId} current occupancy at ${event.sequence}`);
      assert.ok(!agf.movement?.current||agf.movement.current.exitAt<=event.timeMs,
        `${agfId} departed but still owns a current stop`);
    }
    for(const [nodeId,agfId] of Object.entries(traffic.nodeReservations)){
      const agf=snapshot.agfs.find(a=>a.id===agfId);
      const movement=agf.movement,next=movement?.steps[movement.stepIndex],afterNext=movement?.steps[movement.stepIndex+1];
      const plannedTargets=[movement?.current?.toNodeId,next?.toNodeId,
        ...(afterNext&&edges.get(afterNext.edgeId)?.mergeConflictResourceId?[afterNext.toNodeId]:[])];
      assert.ok(plannedTargets.includes(nodeId),`${agfId} has an unplanned target reservation at ${event.sequence}`);
      assert.equal(traffic.owners['node:'+nodeId],agfId,`${agfId} reservation has no atomic resource owner`);
      assert.ok(!traffic.nodeOccupants[nodeId]||traffic.nodeOccupants[nodeId]===agfId,
        `${nodeId} current and arriving vehicles conflict`);
    }
    const actualLanes=new Set();
    for(const agf of snapshot.agfs){
      assert.ok(Number.isFinite(agf.batteryPct)&&agf.batteryPct>=0&&agf.batteryPct<=100);
      const segment=agf.movement?.current;if(!segment||segment.exitAt<=event.timeMs)continue;
      const edge=edges.get(segment.edgeId),lane=edge.lanes.find(l=>l.id===segment.laneId);
      assert.ok(lane,`unknown lane ${segment.laneId}`);
      const resourceId=lane.resourceId??lane.id;
      assert.equal(traffic.owners[resourceId],agf.id,`${agf.id} does not hold its actual lane`);
      assert.ok(!actualLanes.has(resourceId),`two AGFs are inside ${resourceId}`);actualLanes.add(resourceId);
      for(const resource of edge.occupancyResourceIds)assert.equal(traffic.owners[resource],agf.id,
        `${agf.id} does not hold shared conflict ${resource}`);
    }
    const endMs=Math.min(durationMs,run.events[index+1]?.timeMs??durationMs);
    if(endMs<=event.timeMs)continue;
    // Every current synthetic segment is straight. Check closest approach over
    // the whole saved interval, including crossings between event timestamps.
    const paths=snapshot.agfs.map(agf=>({id:agf.id,
      start:projectAgfPosition(agf,run.scenario.operationalTopology,event.timeMs),
      end:projectAgfPosition(agf,run.scenario.operationalTopology,endMs)}));
    for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++){
      const a=paths[i],b=paths[j];if(!a.start||!a.end||!b.start||!b.end)continue;
      const rx=a.start.x-b.start.x,ry=a.start.y-b.start.y;
      const vx=a.end.x-a.start.x-b.end.x+b.start.x,vy=a.end.y-a.start.y-b.end.y+b.start.y;
      const squared=vx*vx+vy*vy,t=squared?Math.max(0,Math.min(1,-(rx*vx+ry*vy)/squared)):0;
      const separation=Math.hypot(rx+t*vx,ry+t*vy);
      assert.ok(separation>1e-7,
        `synthetic centers overlap: ${a.id}/${b.id} at ${event.timeMs+(endMs-event.timeMs)*t}ms (${event.type})`);
    }
  }
  for(const agf of analyzeRun(run).agfs){
    assert.equal(sum(Object.values(agf.durations)),durationMs);
    assert.equal(sum(Object.values(durationTenths(agf.durations))),Math.round(durationMs/6000));
  }
}

function assertActiveEnergy(run){
  const durationMs=Math.round(run.scenario.durationMin*60000);
  const accounts=new Map(run.scenario.agfs.map(a=>[a.id,{base:a.batteryPct,activeMs:0}]));
  for(let index=0;index<run.events.length;index++){
    const event=run.events[index];
    if(event.type==='CHARGE_ENDED')accounts.set(event.agfId,{base:event.batteryPct,activeMs:0});
    const elapsed=Math.min(durationMs,run.events[index+1]?.timeMs??durationMs)-event.timeMs;
    if(elapsed<=0)continue;
    const snapshot=run.snapshots[index];
    for(const agf of snapshot.agfs)if(isBatteryActive(agf,snapshot.tasks.find(t=>t.id===agf.taskId)))
      accounts.get(agf.id).activeMs+=elapsed;
  }
  for(const agf of run.final.agfs){
    if(agf.status==='charging')continue; // Partial charging has a separate projection contract.
    const account=accounts.get(agf.id),expected=account.base-account.activeMs/
      Math.round(run.scenario.battery.activeReferenceMin*60000)*run.scenario.battery.activeReferenceConsumptionPct;
    assert.ok(Math.abs(agf.batteryPct-expected)<=.000002,`${agf.id} energy differs from saved active states`);
  }
}

for(const [name,build] of [['neutral',configuredNeutralScenario],['mixed integrated',integratedAcceptanceScenario]]){
  test(`three-hour ${name} synthetic traffic keeps exclusive nodes, lane resources, projection, clocks and energy consistent`,()=>{
    for(const mode of ['area_first','low_battery_first']){
      const scenario=build();scenario.mode=mode;const run=simulate(scenario);
      assert.equal(run.events.at(-1).timeMs,10800000);
      assertTrafficAndClock(run);assertActiveEnergy(run);
      assert.ok(run.metrics.completed>0);
    }
  });
}

test('opposite warehouse main-lane travel does not hold a distant lane-change zone after four initial charging stops',()=>{
  const scenario=integratedAcceptanceScenario('charging-boundary');scenario.durationMin=20;
  scenario.battery.chargeMinPerPct=.01; // Explicit short synthetic test timing.
  const run=simulate(scenario);
  assert.equal(run.metrics.chargingStarts,4);
  assert.equal(run.events.filter(e=>e.type==='CHARGER_RELEASED').length,4);
  assert.equal(run.events.filter(e=>e.type==='DEADLOCK_DETECTED').length,0);
  assertTrafficAndClock(run);assertActiveEnergy(run);
});
