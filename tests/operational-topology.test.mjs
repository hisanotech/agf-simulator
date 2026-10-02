import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  validateOperationalTopology,
  findOperationalPath,
  resolveInterfaceNode
} from '../src/map/operational-topology.mjs';

const graph=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(graph);

test('synthetic operational topology is explicit, metric, but never presented as CAD physical ETA',()=>{
  const result=validateOperationalTopology(graph);
  assert.equal(result.datasetKind,'synthetic');
  assert.equal(result.nodes,215);
  assert.equal(graph.nodes.filter(n=>n.evidence==='synthetic-device-interface-not-site-stop').length,23);
  assert.deepEqual(graph.nodes.filter(n=>n.type==='wait').map(n=>n.id),['HP1','HP2','PILLAR-WAIT-W','PILLAR-WAIT-E']);
  assert.ok(result.edges>0);
  assert.equal(graph.evidence,'synthetic-assumption');
  assert.equal(graph.readiness.operationalRoutingReady,true);
  assert.equal(graph.readiness.physicalEtaAllowed,false);
  assert.equal(graph.coordinateSystem,'synthetic-display');
});

test('path calculation uses phase speed, explicit direction and stable edge tie breaks',()=>{
  const empty=findOperationalPath(graph,'WH-HOME','PZ-LINE',{movement:'empty',taskType:'01'});
  const loaded=findOperationalPath(graph,'PZ-LINE','PZ-WRAP-IN',{movement:'loaded',taskType:'01'});
  assert.ok(empty.steps.length>0);
  assert.ok(loaded.steps.length>0);
  assert.equal(empty.etaStatus,'synthetic-assumption');
  assert.equal(empty.measuredDistanceMm,null);
  assert.ok(Number.isInteger(empty.modelDurationMs)&&empty.modelDurationMs>0);
  const reversed=copy();reversed.edges.reverse();
  assert.deepEqual(findOperationalPath(reversed,'WH-HOME','PZ-LINE',{movement:'empty',taskType:'01'}),empty);
});

test('interface bindings resolve exact and wildcard task endpoints without inventing site nodes',()=>{
  assert.equal(resolveInterfaceNode(graph,'L8'),'PZ-L8-PICKUP');
  assert.equal(resolveInterfaceNode(graph,'WRAP-INPUT'),'PZ-WRAP-IN');
  assert.equal(resolveInterfaceNode(graph,'WB1-R01-C01-T1'),'WB1-R01-DROP');
  assert.equal(resolveInterfaceNode(graph,'UNKNOWN'),null);
});

test('invalid metrics, directions and approval states fail closed',()=>{
  const noSpeed=copy();noSpeed.edges[0].speedMmPerSec.loaded=0;
  assert.throws(()=>validateOperationalTopology(noSpeed),/speed/);
  const badDirection=copy();badDirection.edges[0].lanes[0].direction='unresolved';
  assert.throws(()=>validateOperationalTopology(badDirection),/lane direction/);
  const unapproved=copy();unapproved.edges[0].approvalState='draft';
  assert.throws(()=>validateOperationalTopology(unapproved),/approval/);
  const privateGraph=copy();privateGraph.datasetKind='private-approved';
  assert.throws(()=>validateOperationalTopology(privateGraph),/public synthetic validator/);
});

test('unreachable movement returns null instead of treating another movement as allowed',()=>{
  const changed=copy();
  for(const edge of changed.edges)edge.accessScopes=edge.accessScopes.filter(scope=>scope.movement!=='charge');
  validateOperationalTopology(changed);
  assert.equal(findOperationalPath(changed,'PZ-LINE','WH-CHARGE',{movement:'charge',taskType:'CHARGE'}),null);
});
