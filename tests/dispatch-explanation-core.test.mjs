import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectAgf,selectAgfWithReason} from '../src/core/select-agf.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {bufferHistoryScenario} from './fixtures/buffer-history-scenario.mjs';

// Invented vehicle states, routes and times for explanation regression only.
const vehicle=(id,area,batteryPct,extra={})=>({id,area,batteryPct,status:'idle',...extra});
const four=()=>[vehicle('AGF1','PZ',70),vehicle('AGF2','PZ',80),
  vehicle('AGF3','WH',60),vehicle('AGF4','WH',90)];
const options={mode:'area_first',reservePct:40,fallback:'any'};
const decide=(agfs,overrides={})=>selectAgfWithReason(agfs,{destinationArea:'WH'},{...options,...overrides});
const evaluations=selection=>{
  assert.ok(selection,'saved selection is required for assignments and failed selections');
  assert.equal(selection.evaluations?.length,4,'all four AGFs must be recorded');
  assert.deepEqual(selection.evaluations.map(row=>row.agfId).sort(),['AGF1','AGF2','AGF3','AGF4']);
  return Object.fromEntries(selection.evaluations.map(row=>[row.agfId,row]));
};
const eligibleIds=selection=>selection.evaluations.filter(row=>row.eligible).map(row=>row.agfId).sort();
const fixedScenario=(overrides={})=>bufferHistoryScenario({durationMin:.1,lineIntervalsMin:Array(8).fill(0),
  productionEvents:[{timeMs:0,lineId:'L1',palletId:'SYN-EXPLANATION-1',destinationLocationId:'S1'}],
  ...overrides});
function graphScenario(){
  const s=createDemoScenario('manual');
  s.durationMin=.1;s.motionModel='synthetic_graph';
  s.operationalTopology=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
  const starts=['HP1','HP2','CHARGE-PLACE1','CHARGE-PLACE2'];
  s.agfs=s.agfs.map((a,i)=>({...a,currentNodeId:starts[i],area:'WH',batteryPct:[50,60,80,90][i]}));
  s.productionEvents=[{timeMs:0,lineId:'L1',palletId:'SYN-EXPLANATION-GRAPH',destinationLocationId:s.generatedDestinationIds[0]}];
  s.manualRequests=[];s.magazineUses=[];s.alignerReadyEvents=[];s.lineIntervalsMin=Array(8).fill(0);
  return s;
}
const disconnect=(s,nodeId)=>{s.operationalTopology.edges=s.operationalTopology.edges.filter(e=>
  e.fromNodeId!==nodeId&&e.toNodeId!==nodeId);};
const eventOf=(run,type,reason=null)=>{
  const event=run.events.find(e=>e.type===type&&(!reason||e.reason===reason));
  assert.ok(event,`${type}${reason?' '+reason:''} must be recorded`);return event;
};

test('saved dispatch states retain blocked flags even when status or battery rejects a vehicle first',()=>{
  const agfs=[vehicle('AGF1','PZ',85,{status:'moving_loaded',blocked:true}),
    vehicle('AGF2','PZ',75,{blocked:true}),vehicle('AGF3','PZ',40,{blocked:true}),vehicle('AGF4','PZ',90)];
  const selected=selectAgfWithReason(agfs,{destinationArea:'PZ'},options);
  const selectorRows=evaluations(selected.selection);
  assert.equal(selectorRows.AGF1.blocked,true);
  assert.equal(selectorRows.AGF1.exclusionReason,'STATUS_NOT_AVAILABLE');
  assert.equal(selectorRows.AGF4.blocked,false);
  const run=simulate(fixedScenario({agfs})),saved=evaluations(eventOf(run,'TASK_ASSIGNED').dispatchSelection);
  assert.deepEqual(Object.values(saved).map(row=>row.blocked),[true,true,true,false]);
  agfs[0].blocked=false;
  assert.equal(saved.AGF1.blocked,true);
});

test('fixed-time assignment saves all four original states and the exclusions actually applied',()=>{
  const input=fixedScenario({agfs:[vehicle('AGF1','PZ',85,{status:'moving_loaded'}),
    vehicle('AGF2','PZ',75,{status:'charging'}),vehicle('AGF3','PZ',40),vehicle('AGF4','PZ',90)]});
  const run=simulate(input),event=eventOf(run,'TASK_ASSIGNED'),rows=evaluations(event.dispatchSelection);
  assert.equal(event.agfId,'AGF4');
  assert.equal(rows.AGF1.status,'moving_loaded');assert.equal(rows.AGF1.exclusionReason,'STATUS_NOT_AVAILABLE');
  assert.equal(rows.AGF2.status,'charging');assert.equal(rows.AGF2.exclusionReason,'STATUS_NOT_AVAILABLE');
  assert.equal(rows.AGF3.batteryPct,40);assert.equal(rows.AGF3.exclusionReason,'BATTERY_RESERVE');
  assert.equal(rows.AGF4.eligible,true);assert.equal(rows.AGF4.selected,true);assert.equal(rows.AGF4.exclusionReason,null);
  assert.ok([rows.AGF1,rows.AGF2,rows.AGF3].every(row=>!row.eligible&&!row.selected));
});

test('area-first evaluations distinguish the final candidate pool from otherwise usable vehicles',()=>{
  const decision=decide(four()),rows=evaluations(decision.selection);
  assert.equal(decision.agf.id,'AGF3');
  assert.equal(rows.AGF1.exclusionReason,'AREA_NOT_PRIORITIZED');
  assert.equal(rows.AGF2.exclusionReason,'AREA_NOT_PRIORITIZED');
  assert.deepEqual(eligibleIds(decision.selection),['AGF3','AGF4']);
  assert.equal(rows.AGF3.selected,true);assert.equal(rows.AGF4.selected,false);
  assert.deepEqual(decision.selection.candidates.map(row=>row.agfId),['AGF3','AGF4']);
});

test('selector records blocked invalid-battery and inclusive reserve-boundary exclusions',()=>{
  const agfs=[vehicle('AGF1','WH',70,{blocked:true}),vehicle('AGF2','WH',NaN),
    vehicle('AGF3','WH',40),vehicle('AGF4','WH',41)];
  const decision=decide(agfs),rows=evaluations(decision.selection);
  assert.equal(rows.AGF1.exclusionReason,'BLOCKED');assert.equal(rows.AGF2.exclusionReason,'BATTERY_INVALID');
  assert.equal(rows.AGF3.exclusionReason,'BATTERY_RESERVE');assert.equal(decision.agf,agfs[3]);
  assert.equal(selectAgf(agfs,{destinationArea:'WH'},options),agfs[3]);
  assert.deepEqual(eligibleIds(decision.selection),['AGF4']);
});

test('failed selector retains all four reasons while its vehicle-only wrapper still returns null',()=>{
  const agfs=[vehicle('AGF1','WH',70,{status:'moving_to_wait'}),vehicle('AGF2','WH',70,{blocked:true}),
    vehicle('AGF3','WH',40),vehicle('AGF4','WH',Infinity)];
  const decision=decide(agfs),rows=evaluations(decision.selection);
  assert.equal(decision.agf,null);assert.equal(selectAgf(agfs,{destinationArea:'WH'},options),null);
  assert.equal(decision.selection.selectedAgfId,null);assert.deepEqual(decision.selection.candidates,[]);
  assert.deepEqual(Object.values(rows).map(row=>row.exclusionReason),
    ['STATUS_NOT_AVAILABLE','BLOCKED','BATTERY_RESERVE','BATTERY_INVALID']);
  assert.ok(Object.values(rows).every(row=>!row.eligible&&!row.selected));
});

test('explicit area wait records fallback-disabled for each usable nonlocal AGF',()=>{
  const agfs=four().map(a=>({...a,area:'PZ'})),decision=decide(agfs,{fallback:'wait'});
  const rows=evaluations(decision.selection);assert.equal(decision.agf,null);
  assert.ok(Object.values(rows).every(row=>row.exclusionReason==='AREA_FALLBACK_DISABLED'&&!row.eligible));
});

test('low-battery selection and ID ties record four eligible vehicles without changing the winner',()=>{
  const agfs=[vehicle('AGF2','PZ',55),vehicle('AGF1','WH',55),vehicle('AGF3','WH',60),vehicle('AGF4','PZ',80)];
  const decision=decide(agfs,{mode:'low_battery_first'}),rows=evaluations(decision.selection);
  assert.equal(decision.agf.id,'AGF1');assert.equal(decision.selection.tieBreak,'agf_id');
  assert.ok(Object.values(rows).every(row=>row.eligible&&row.exclusionReason===null));
  assert.equal(Object.values(rows).filter(row=>row.selected).length,1);
  assert.deepEqual(decision.selection,decide([...agfs].reverse(),{mode:'low_battery_first'}).selection);
});

test('NO_ELIGIBLE_AGF waiting event saves the four evaluated vehicle reasons',()=>{
  const input=fixedScenario({agfs:[vehicle('AGF1','PZ',80,{status:'charging'}),
    vehicle('AGF2','PZ',80,{status:'moving_empty'}),vehicle('AGF3','PZ',40),vehicle('AGF4','PZ',60,{blocked:true})]});
  const run=simulate(input),event=eventOf(run,'TASK_WAITING','NO_ELIGIBLE_AGF'),rows=evaluations(event.dispatchSelection);
  assert.equal(rows.AGF1.exclusionReason,'STATUS_NOT_AVAILABLE');assert.equal(rows.AGF2.exclusionReason,'STATUS_NOT_AVAILABLE');
  assert.equal(rows.AGF3.exclusionReason,'BATTERY_RESERVE');assert.equal(rows.AGF4.exclusionReason,'BLOCKED');
  assert.ok(Object.values(rows).every(row=>!row.eligible&&!row.selected));
  assert.ok(!run.events.some(e=>e.type==='TASK_ASSIGNED'));
});

test('graph assignment includes pickup-route exclusions and the actual route-feasible stage IDs',()=>{
  const input=graphScenario();disconnect(input,'HP1');
  const event=eventOf(simulate(input),'TASK_ASSIGNED'),rows=evaluations(event.dispatchSelection);
  assert.equal(event.agfId,'AGF2');assert.equal(rows.AGF1.exclusionReason,'PICKUP_ROUTE_UNREACHABLE');
  assert.deepEqual(eligibleIds(event.dispatchSelection),['AGF2','AGF3','AGF4']);
  assert.deepEqual(event.dispatchSelection.stages.find(stage=>stage.stage==='route').eligibleAgfIds,
    ['AGF2','AGF3','AGF4']);
});

test('graph final pool reapplies destination preference after its sole local vehicle loses the route',()=>{
  const input=graphScenario();input.agfs[0].area='PZ';disconnect(input,'HP1');
  const event=eventOf(simulate(input),'TASK_ASSIGNED'),rows=evaluations(event.dispatchSelection);
  assert.equal(event.agfId,'AGF2');assert.equal(event.dispatchSelection.basis,'cross_area_fallback');
  assert.equal(rows.AGF1.exclusionReason,'PICKUP_ROUTE_UNREACHABLE');
  assert.ok([rows.AGF2,rows.AGF3,rows.AGF4].every(row=>row.eligible&&row.exclusionReason===null));
});

test('unreachable pickup waiting event records all four route exclusions without assignment',()=>{
  const input=graphScenario(),target=input.operationalTopology.interfaceBindings.find(b=>b.pattern==='L1').nodeId;
  disconnect(input,target);
  const run=simulate(input),event=eventOf(run,'TASK_WAITING','UNREACHABLE_ROUTE'),rows=evaluations(event.dispatchSelection);
  assert.ok(Object.values(rows).every(row=>row.exclusionReason==='PICKUP_ROUTE_UNREACHABLE'&&!row.eligible));
  assert.ok(!run.events.some(e=>e.type==='TASK_ASSIGNED'));
});

test('reachable pickups with no loaded route record loaded-route failure for all four AGFs',()=>{
  const input=graphScenario();
  input.operationalTopology.edges.forEach(edge=>{edge.accessScopes=edge.accessScopes.filter(scope=>scope.movement!=='loaded');});
  const run=simulate(input),event=eventOf(run,'TASK_WAITING','UNREACHABLE_ROUTE'),rows=evaluations(event.dispatchSelection);
  assert.ok(Object.values(rows).every(row=>row.exclusionReason==='LOADED_ROUTE_UNREACHABLE'&&!row.eligible));
  assert.ok(!run.events.some(e=>e.type==='TASK_ASSIGNED'));
});

test('graph final area wait preserves route failure and explains disabled fallback for its remaining vehicles',()=>{
  const input=graphScenario();input.fallback='wait';input.agfs[0].area='PZ';disconnect(input,'HP1');
  const run=simulate(input),event=eventOf(run,'TASK_WAITING','UNREACHABLE_ROUTE'),rows=evaluations(event.dispatchSelection);
  assert.equal(rows.AGF1.exclusionReason,'PICKUP_ROUTE_UNREACHABLE');
  assert.ok([rows.AGF2,rows.AGF3,rows.AGF4].every(row=>row.exclusionReason==='AREA_FALLBACK_DISABLED'&&!row.eligible));
  assert.equal(event.dispatchSelection.selectedAgfId,null);
});

test('availability charge-start rejection is retained at its own boundary before selector checks',()=>{
  const input=graphScenario();
  input.postTaskPolicy={waitingPriority:['HP1','HP2','PILLAR-WAIT-E','PILLAR-WAIT-W'],evidence:'synthetic-assumption'};
  input.battery={...input.battery,reservePct:30,chargeStartPct:40};
  input.agfs[0].batteryPct=40;input.agfs[0].blocked=true;
  const event=eventOf(simulate(input),'TASK_ASSIGNED'),rows=evaluations(event.dispatchSelection);
  assert.equal(rows.AGF1.exclusionReason,'BATTERY_CHARGE_START');assert.equal(rows.AGF1.eligible,false);
  assert.equal(event.agfId,'AGF2');
});

test('wrapper task admission gate saves all four vehicles as not evaluated at that gate',()=>{
  const input=graphScenario();input.wrapper={...input.wrapper,inboundAgfLimit:1};
  input.productionEvents.push({timeMs:0,lineId:'L2',palletId:'SYN-EXPLANATION-GATE',destinationLocationId:input.generatedDestinationIds[1]});
  const event=eventOf(simulate(input),'TASK_WAITING','WRAPPER_INBOUND_LIMIT'),rows=evaluations(event.dispatchSelection);
  assert.ok(Object.values(rows).every(row=>row.exclusionReason==='TASK_PRECONDITION'&&
    row.taskExclusionReason==='WRAPPER_INBOUND_LIMIT'&&row.evaluationStatus==='not_evaluated'&&!row.eligible&&!row.selected));
});

test('03 source gate preserves checked vehicle exclusions and labels its actual precondition rejection',()=>{
  const input=fixedScenario({durationMin:1,productionModel:'legacy_external_pallets',
    agfs:four().map((a,i)=>({...a,area:'PZ',blocked:i>0})),
    magazines:[{id:'M1',quantity:4,capacity:120,trigger:3,refillBatch:10,permission:true}],
    magazineUses:[{timeMs:1,magazineId:'M1'}],
    permissionEvents:[{timeMs:2,target:'aligner',targetId:'AL1',permitted:false}],
    times:{emptyMin:.01,loadedMin:.01,pickupMin:.01,dropoffMin:.01,wrapMin:20,labelMin:0,exitMin:0,chargeTravelMin:1}});
  const event=eventOf(simulate(input),'TASK_WAITING','ALIGNER_PERMISSION'),rows=evaluations(event.dispatchSelection);
  assert.equal(rows.AGF1.exclusionReason,'TASK_PRECONDITION');assert.equal(rows.AGF1.taskExclusionReason,'ALIGNER_PERMISSION');
  assert.equal(rows.AGF1.evaluationStatus,'evaluated');assert.equal(rows.AGF1.eligible,false);assert.equal(rows.AGF1.selected,false);
  assert.ok([rows.AGF2,rows.AGF3,rows.AGF4].every(row=>row.exclusionReason==='BLOCKED'&&!row.eligible));
});

test('saved assignment and waiting evaluations survive later run state changes without sharing mutable arrays',()=>{
  const input=fixedScenario({durationMin:60,agfs:four()}),run=simulate(input),repeat=simulate(input);
  assert.deepEqual(run.events,repeat.events);assert.deepEqual(run.snapshots,repeat.snapshots);
  const assignment=eventOf(run,'TASK_ASSIGNED');evaluations(assignment.dispatchSelection);
  const before=structuredClone(assignment.dispatchSelection);
  input.agfs[0].batteryPct=1;run.scenario.agfs[0].batteryPct=2;run.final.agfs[0].batteryPct=3;
  run.snapshots.at(-1).agfs[0].batteryPct=4;
  assert.deepEqual(assignment.dispatchSelection,before);
  const other=run.events.find(e=>e!==assignment&&e.dispatchSelection);
  assert.ok(other);other.dispatchSelection.evaluations[0].batteryPct=5;
  other.dispatchSelection.stages[0].eligibleAgfIds.push('SYN-OTHER');
  assert.deepEqual(assignment.dispatchSelection,before);
});
