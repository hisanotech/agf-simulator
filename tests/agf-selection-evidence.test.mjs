import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as selector from '../src/core/select-agf.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {bufferHistoryScenario} from './fixtures/buffer-history-scenario.mjs';
import {eventCsv} from '../src/ui/export.mjs';

const vehicle=(id,area,batteryPct,extra={})=>({id,area,batteryPct,status:'idle',...extra});
const decide=(agfs,mode='area_first',fallback='any')=>selector.selectAgfWithReason(agfs,
  {destinationArea:'WH'},{mode,reservePct:40,fallback});

test('assignment saves the actual destination-area decision and candidate battery at assignment time',()=>{
  const input=bufferHistoryScenario({durationMin:60,agfs:[vehicle('AGF1','PZ',70),vehicle('AGF2','PZ',80),
    vehicle('AGF3','WH',60),vehicle('AGF4','WH',90)]});
  const run=simulate(input),assigned=run.events.find(e=>e.type==='TASK_ASSIGNED'&&e.kind==='02');
  assert.ok(assigned);assert.equal(assigned.agfId,'AGF3');
  assert.equal(assigned.dispatchSelection.basis,'destination_area');
  assert.equal(assigned.dispatchSelection.destinationArea,'WH');
  assert.equal(assigned.dispatchSelection.selectedBatteryPct,60);
  assert.deepEqual(assigned.dispatchSelection.candidates.map(a=>a.agfId),['AGF3','AGF4']);
  assert.deepEqual(run.events,simulate(input).events);
  const before=structuredClone(assigned.dispatchSelection);
  run.final.agfs[2].batteryPct=5;run.scenario.mode='low_battery_first';input.agfs[2].batteryPct=99;
  assert.deepEqual(assigned.dispatchSelection,before);
});

test('decision evidence comes from the same selector and excludes busy blocked or reserve-boundary vehicles',()=>{
  const agfs=[vehicle('AGF1','PZ',41),vehicle('AGF2','WH',80),vehicle('AGF3','WH',70),
    vehicle('BUSY','WH',50,{status:'charging'}),vehicle('BLOCKED','WH',45,{blocked:true}),vehicle('RESERVE','WH',40)];
  const before=structuredClone(agfs),decision=decide(agfs);
  assert.equal(decision.agf,agfs[2]);assert.equal(decision.agf,selector.selectAgf(agfs,{destinationArea:'WH'},
    {mode:'area_first',reservePct:40,fallback:'any'}));
  assert.deepEqual(decision.selection.eligibleAgfIds,['AGF1','AGF2','AGF3']);
  assert.deepEqual(decision.selection.candidates.map(a=>a.agfId),['AGF3','AGF2']);
  assert.equal(decision.selection.tieBreak,'none');assert.deepEqual(agfs,before);
  agfs[2].batteryPct=100;assert.equal(decision.selection.selectedBatteryPct,70);
});

test('explicit cross-area fallback and area-independent low battery selection retain distinct evidence',()=>{
  const agfs=[vehicle('AGF1','PZ',70),vehicle('AGF2','PZ',60)];
  assert.equal(decide(agfs).selection.basis,'cross_area_fallback');
  assert.equal(decide(agfs).agf.id,'AGF2');
  const waiting=decide(agfs,'area_first','wait');
  assert.equal(waiting.agf,null);assert.equal(waiting.selection.selectedAgfId,null);
  assert.deepEqual(waiting.selection.candidates,[]);
  assert.ok(waiting.selection.evaluations.every(e=>!e.eligible&&e.exclusionReason==='AREA_FALLBACK_DISABLED'));
  const all=decide([...agfs,vehicle('AGF3','WH',90)],'low_battery_first');
  assert.equal(all.selection.basis,'all_areas');assert.equal(all.agf.id,'AGF2');
});

test('only a tie at the selected lowest battery records the existing synthetic ID tie-break',()=>{
  const agfs=[vehicle('AGF2','WH',70),vehicle('AGF1','WH',70),vehicle('AGF3','WH',90)];
  const first=decide(agfs),second=decide([...agfs].reverse());
  assert.equal(first.agf.id,'AGF1');assert.deepEqual(first.selection,second.selection);
  assert.equal(first.selection.tieBreak,'agf_id');assert.equal(first.selection.tieBreakEvidence,'synthetic-model-tiebreak');
  assert.equal(decide([vehicle('AGF1','WH',60),vehicle('AGF2','WH',70),vehicle('AGF3','WH',70)]).selection.tieBreak,'none');
});

test('graph assignment records only the final route-feasible candidates and selected AGF',()=>{
  const input=createDemoScenario('manual'),topology=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
  input.durationMin=2;input.motionModel='synthetic_graph';input.operationalTopology=topology;
  const starts=['HP1','HP2','CHARGE-PLACE1','CHARGE-PLACE2'];
  input.agfs=input.agfs.map((a,i)=>({...a,area:'WH',currentNodeId:starts[i],batteryPct:[50,60,80,90][i]}));
  topology.edges=topology.edges.filter(e=>e.fromNodeId!=='HP1'&&e.toNodeId!=='HP1');
  input.productionEvents=[{timeMs:0,lineId:'L1',palletId:'SYN-SELECTION',destinationLocationId:input.generatedDestinationIds[0]}];
  input.manualRequests=[];input.magazineUses=[];input.alignerReadyEvents=[];
  const run=simulate(input),assigned=run.events.find(e=>e.type==='TASK_ASSIGNED'&&e.kind==='01');
  assert.ok(assigned);assert.equal(assigned.agfId,input.agfs[1].id);
  assert.equal(assigned.dispatchSelection.selectedAgfId,assigned.agfId);
  assert.equal(assigned.dispatchSelection.basis,'cross_area_fallback');
  assert.equal(assigned.dispatchSelection.eligibleAgfIds.includes(input.agfs[0].id),false);
  assert.deepEqual(assigned.dispatchSelection.candidates.map(a=>a.agfId),input.agfs.slice(1).map(a=>a.id));
  assert.equal(assigned.dispatchSelection.evaluations.length,4);
  const excluded=assigned.dispatchSelection.evaluations.find(e=>e.agfId===input.agfs[0].id);
  assert.equal(excluded.eligible,false);assert.equal(excluded.exclusionReason,'PICKUP_ROUTE_UNREACHABLE');
});

test('developer event CSV preserves saved selection evidence as a separate object',()=>{
  const run=simulate(bufferHistoryScenario({durationMin:30})),assigned=run.events.find(e=>e.type==='TASK_ASSIGNED');
  assert.ok(assigned.dispatchSelection);const csv=eventCsv(run,'SYN-SELECTION');
  assert.match(csv.split('\r\n')[0],/dispatchSelection/);
  assert.ok(csv.includes(JSON.stringify(assigned.dispatchSelection).replaceAll('"','""')));
});
