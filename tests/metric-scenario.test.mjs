import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {buildRunConditions} from '../src/ui/run-conditions.mjs';
import {conditionCsv,eventCsv} from '../src/ui/export.mjs';
import {customerConditionRows} from '../src/ui/customer-conditions.mjs';

// Deliberately fictitious dimensions. This fixture contains no CAD measurements.
const profile={schemaVersion:'metric-layout-profile-v1',id:'synthetic-test-mm',revision:'test-1',
  evidence:'synthetic-assumption',coordinateUnit:'mm',legacyBounds:[0,0,1100,970],
  axisAnchors:{x:[[0,0],[1100,44000]],y:[[0,0],[322,10000],[475,16000],[970,26000]]},
  readiness:{physicalEtaAllowed:false,metricScaleVerified:false,referenceOriginVerified:false}};

test('neutral scenario accepts a metric layout without changing logical connectivity or startup state',()=>{
  const legacy=createDemoScenario(),s=createDemoScenario('standard',{metricProfile:profile});
  assert.equal(s.operationalTopology.coordinateSystem,'synthetic-mm');
  assert.equal(s.operationalTopology.coordinateUnit,'mm');
  const logic=g=>g.edges.map(({id,fromNodeId,toNodeId,lanes,lanePolicy,occupancyResourceIds,accessScopes,shutterId})=>
    ({id,fromNodeId,toNodeId,lanes,lanePolicy,occupancyResourceIds,accessScopes,shutterId}));
  assert.deepEqual(logic(s.operationalTopology),logic(legacy.operationalTopology));
  assert.deepEqual(s.agfs,legacy.agfs);assert.deepEqual(s.magazines,legacy.magazines);
  assert.deepEqual(s.initialParking,legacy.initialParking);assert.deepEqual(s.warehouse,legacy.warehouse);
  assert.equal(s.operationalTopology.readiness.physicalEtaAllowed,false);
  assert.equal(legacy.operationalTopology.coordinateSystem,'synthetic-display');
});

test('saved run conditions retain the metric profile, coordinates and paths independently of input changes',()=>{
  const scenario=createDemoScenario('standard',{metricProfile:profile});
  const saved=structuredClone(scenario),rows=buildRunConditions({scenario:saved});
  assert.deepEqual(rows.find(r=>r.category==='GRAPH'&&r.subkey==='metricLayoutProfile')?.value,profile);
  const node=saved.operationalTopology.nodes.find(n=>n.interfaceId==='L1');
  assert.equal(rows.find(r=>r.category==='GRAPH_NODE'&&r.key===node.id&&r.subkey==='x')?.value,node.x);
  const edge=saved.operationalTopology.edges.find(e=>e.id==='E08-PART2');
  assert.deepEqual(rows.find(r=>r.category==='GRAPH_EDGE'&&r.key===edge.id&&r.subkey==='displayPath')?.value,edge.displayPath);
  scenario.operationalTopology.nodes[0].x+=100;
  assert.deepEqual(buildRunConditions({scenario:saved}),rows);
});

test('metric conditions exports distinguish the model from measured CAD and preserve reproducible geometry',()=>{
  const scenario=createDemoScenario('standard',{metricProfile:profile}),run={scenario,events:[],snapshots:[]};
  const csv=conditionCsv(run,'METRIC-TEST');
  assert.ok(csv.startsWith('\ufeffcategory,key,subkey,value,evidence'));
  assert.match(csv,/metricLayoutProfile/);assert.match(csv,/synthetic-test-mm/);
  assert.match(csv,/GRAPH_NODE,PZ-L1-PICKUP,x/);assert.match(csv,/GRAPH_EDGE,E08-PART2,displayPath/);
  assert.notEqual(csv,eventCsv(run,'METRIC-TEST'));
  const readable=customerConditionRows(run);
  assert.equal(readable.find(row=>row.key==='map.unit').value,'mm');
  assert.equal(readable.find(row=>row.key==='map.scaleVerified').value,'未確認');
});
