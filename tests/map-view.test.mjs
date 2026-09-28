import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectAgfPosition} from '../src/core/motion-projection.mjs';
import {initMap} from '../src/ui/map-view.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {simulate} from '../src/core/simulate.mjs';

const topology=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));

test('motion projection interpolates only from saved core movement state',()=>{
  const agf={id:'A1',currentNodeId:'PZ-LINE',movement:{current:{
    fromNodeId:'PZ-LINE',toNodeId:'PZ-WRAP-IN',enteredAt:1000,exitAt:5000
  }}};
  assert.deepEqual(projectAgfPosition(agf,topology,1000),{x:180,y:105,progress:0,nodeId:null});
  assert.deepEqual(projectAgfPosition(agf,topology,3000),{x:370,y:105,progress:.5,nodeId:null});
  assert.deepEqual(projectAgfPosition(agf,topology,5000),{x:560,y:105,progress:1,nodeId:null});
  const stopped={id:'A2',currentNodeId:'WH-HOME',movement:null};
  assert.deepEqual(projectAgfPosition(stopped,topology,3000),{x:760,y:620,progress:null,nodeId:'WH-HOME'});
});

function mockSvg(){
  return {innerHTML:'',attrs:{},setAttribute(name,value){this.attrs[name]=value;},addEventListener(){},
    getScreenCTM(){return null;},querySelectorAll(){return[];}};
}

test('concept map renders G01-G17 semantic markers without claiming CAD coordinates',()=>{
  const scenario=createDemoScenario('manual'),run=simulate(scenario),svg=mockSvg();
  const map=initMap({svg,onSelectAgf(){},onSelectBlock(){}});
  map.render(run.final,'AGF1',{timeMs:run.scenario.durationMin*60000,topology:null});
  for(let number=1;number<=17;number++)assert.match(svg.innerHTML,
    new RegExp(`data-acceptance="G${String(number).padStart(2,'0')}"`));
  assert.match(svg.innerHTML,/data-band="PZ"[\s\S]*data-band="INTER"[\s\S]*data-band="WH"/);
  assert.match(svg.innerHTML,/パレタイズ西SH/);
  assert.match(svg.innerHTML,/パレタイズ出口SH/);
  assert.match(svg.innerHTML,/柱前待機候補/);
  assert.match(svg.innerHTML,/AGF進入禁止/);
  assert.match(svg.innerHTML,/概念図・実寸ではありません/);
});

test('synthetic graph replay exposes projected AGF coordinates and route edges from saved events',()=>{
  const input=createDemoScenario('physical');
  input.durationMin=60;
  const run=simulate(input);
  const enteredIndex=run.events.findIndex(event=>event.type==='SEGMENT_ENTERED');
  assert.ok(enteredIndex>=0);
  const event=run.events[enteredIndex],snapshot=run.snapshots[enteredIndex];
  const agf=snapshot.agfs.find(item=>item.id===event.agfId);
  const position=projectAgfPosition(agf,input.operationalTopology,event.timeMs+event.modelDurationMs/2);
  assert.ok(Number.isFinite(position.x)&&Number.isFinite(position.y));
  assert.equal(position.progress,.5);
});

test('position updates move existing markers between events without rebuilding the map',()=>{
  const svg=mockSvg(),attributes={};
  const marker={dataset:{agf:'AGF1'},setAttribute(name,value){attributes[name]=value;},querySelector(){return null;}};
  svg.querySelectorAll=()=>[marker];
  const map=initMap({svg,onSelectAgf(){},onSelectBlock(){}});
  const agf={id:'AGF1',movement:{current:{fromNodeId:'PZ-HOME',toNodeId:'PZ-LINE',enteredAt:0,exitAt:6000}}};
  svg.innerHTML='unchanged map';
  map.updatePositions([{...agf,displayPosition:projectAgfPosition(agf,topology,3000)}]);
  assert.equal(attributes.transform,'translate(150,167.5)');
  map.updatePositions([{...agf,displayPosition:projectAgfPosition(agf,topology,4000)}]);
  assert.equal(attributes.transform,'translate(160,146.66666666666669)');
  assert.equal(svg.innerHTML,'unchanged map');
});