import test from 'node:test';
import assert from 'node:assert/strict';
import {initMap} from '../src/ui/map-view.mjs';
import {readFileSync} from 'node:fs';
import {SCHEMATIC_LAYOUT} from '../src/map/schematic-layout.mjs';
import {metricPoint,convertTopologyToMetric,createMetricCanvasProjection} from '../src/map/metric-layout.mjs';

// Explicit synthetic metric mapping. This is not CAD geometry or a site scale.
const profile={schemaVersion:'metric-layout-profile-v1',id:'SYNTHETIC-METRIC-MAP',revision:1,
  coordinateUnit:'mm',evidence:'synthetic-metric-test',readiness:{physicalEtaAllowed:false,metricScaleVerified:false},legacyBounds:[0,0,1100,970],
  axisAnchors:{x:[[0,0],[1100,22000]],y:[[0,0],[970,9700]]}};
const stop={id:'PZ-L4-PICKUP',equipmentId:'PGW4',interfaceId:'L4',x:8970,y:1190};
const access={id:'PZ-A1-PGW4-ACCESS',x:8970,y:1730};
const topology={metricLayoutProfile:profile,nodes:[stop,access],edges:[]};
function snapshot(){return {tasks:[],warehouse:{},lines:{},magazines:{},temporaryPallets:[],
  aligners:Object.fromEntries(Array.from({length:5},(_,i)=>['AL'+(i+1),{id:'AL'+(i+1),quantity:10}])),
  agfs:[{id:'AGF1',area:'PZ',status:'moving_loaded',batteryPct:100,currentNodeId:stop.id,
    heading:'east',headingDeg:45,displayPosition:{x:stop.x,y:stop.y,headingDeg:45},
    movement:{current:null,steps:[{edgeId:'METRIC-BRANCH',fromNodeId:access.id,toNodeId:stop.id,
      displayPath:[{x:access.x,y:access.y},{x:stop.x,y:stop.y}]}]}}]};}
function render(graph=topology,snap=snapshot(),dimensions={}){
  const svg={innerHTML:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(){},...dimensions};
  const map=initMap({svg,onSelectAgf(){},onSelectBlock(){}});map.render(snap,'AGF1',{topology:graph});
  return {map,svg,html:svg.innerHTML};
}
const attr=(tag,key)=>tag.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];

test('metric map uses one uniform world projection for equipment, saved paths and AGF positions',()=>{
  const {svg,html}=render();
  assert.equal(svg.attributes.viewBox,'0 0 1400 850');
  assert.match(html,/data-coordinate-unit="mm"/);
  const scene=html.match(/<g data-schematic="landscape"[^>]*>/)?.[0];
  assert.ok(scene);assert.match(attr(scene,'transform'),/^translate\([^)]*\) scale\([^ )]+\)$/);
  assert.doesNotMatch(attr(scene,'transform'),/scale\([^ ]+ [^)]+\)/);
  assert.ok(html.includes('d="M8970 1730 L8970 1190" class="active-route" data-route-edge="METRIC-BRANCH"'));
  const marker=html.match(/<g data-agf="AGF1"[^>]*>/)?.[0];
  assert.equal(attr(marker,'transform'),'translate(8970,1190)');
  assert.match(html,/class="agf-orientation" transform="rotate\(45\)"/);
  for(let i=1;i<=17;i++)assert.ok(html.includes(`data-acceptance="G${String(i).padStart(2,'0')}"`));
});

test('metric scenery transforms equipment geometry rather than changing only AGF or route coordinates',()=>{
  const {html}=render();
  const group=html.match(/<g data-equipment="PGW4"[^>]*>([\s\S]*?)<\/g>/)?.[1];
  const box=group?.match(/<rect[^>]*>/)?.[0];assert.ok(box);
  assert.equal(Number(attr(box,'x'))+Number(attr(box,'width'))/2,stop.x);
  assert.equal(Number(attr(box,'y'))+Number(attr(box,'height')),stop.y);
  const pz=html.match(/<rect data-map-id="PZ"[^>]*>/)?.[0];
  assert.deepEqual(['x','y','width','height'].map(key=>Number(attr(pz,key))),[500,220,21000,3000]);
  const cellTags=[...html.matchAll(/<rect[^>]*data-row="\d+"[^>]*>/g)].map(m=>m[0]);
  assert.equal(cellTags.filter(tag=>attr(tag,'fill')!=='url(#gap)').length*2,802);
  assert.ok(html.includes('第10列は配置対象外'));
  assert.match(html,/mm/);assert.match(html,/未確認|未検証|未承認/);
});

test('live metric position updates retain saved millimetres without applying the scenery transform twice',()=>{
  const {map,svg}=render(),attributes={},childAttributes={};
  const child={setAttribute(k,v){childAttributes[k]=v;},textContent:''};
  const marker={dataset:{agf:'AGF1'},setAttribute(k,v){attributes[k]=v;},querySelector(){return child;}};
  svg.querySelectorAll=()=>[marker];
  const moved={...snapshot().agfs[0],displayPosition:{x:9000,y:1500,headingDeg:90},heading:'south'};
  map.updatePositions([moved]);
  assert.equal(attributes.transform,'translate(9000,1500)');assert.equal(attributes['data-heading-deg'],90);
  map.fit();assert.equal(svg.attributes.viewBox,'0 0 1400 850');
});

test('legacy map retains its logical positions while using an isotropic canvas projection',()=>{
  const snap=snapshot();snap.agfs[0].displayPosition={x:448.5,y:119};
  const {html}=render(null,snap),scene=html.match(/<g data-schematic="landscape"[^>]*>/)?.[0];
  assert.ok(scene);assert.match(attr(scene,'transform'),/^translate\([^)]*\) scale\([^ )]+\)$/);
  assert.equal(attr(html.match(/<g data-agf="AGF1"[^>]*>/)?.[0],'transform'),'translate(448.5,119)');
});

const nonlinearProfile=()=>({...structuredClone(profile),id:'SYNTHETIC-LOCAL-PZ-WARP',
  axisAnchors:{x:[[0,0],[448.5,8970],[511.5,14010],[637.5,17790],[1100,44000]],y:[[0,0],[970,29100]]},
  xBands:[{atY:322,anchors:[[0,0],[448.5,8970],[511.5,14010],[637.5,17790],[1100,44000]]},
    {atY:458,anchors:[[0,0],[1100,44000]]}]});
function nonlinearMap(){
  const input=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
  const graph=convertTopologyToMetric(input,nonlinearProfile()),snap=snapshot();
  snap.agfs[0].movement=null;snap.agfs[0].displayPosition=graph.nodes.find(n=>n.id===stop.id);
  return {...render(graph,snap),graph};
}
const equipmentBox=(html,id)=>html.match(new RegExp(`<g data-equipment="${id}"[^>]*>([\\s\\S]*?)<\\/g>`))?.[1]?.match(/<rect[^>]*>/)?.[0];
const pathTag=(html,id)=>html.match(new RegExp(`<path data-map-id="${id}"[^>]*>`))?.[0];
const nearly=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('nonlinear PZ equipment symbols retain the individual stop at their north or south handoff face',()=>{
  const {html,graph}=nonlinearMap();
  for(const node of graph.nodes.filter(n=>n.equipmentId)){
    if(node.equipmentId.startsWith('OT')){
      const stop=html.match(new RegExp(`<circle[^>]*data-temp-stop="${node.equipmentId}"[^>]*>`))?.[0];
      assert.ok(stop,'OT symbol keeps a separate operational handoff anchor');
      nearly(Number(attr(stop,'cx')),node.x);nearly(Number(attr(stop,'cy')),node.y);
      assert.match(html,new RegExp(`data-temp-connector="${node.equipmentId}"`));
      continue;
    }
    const box=equipmentBox(html,node.equipmentId);assert.ok(box,node.equipmentId);
    const [x,y,w,h]=['x','y','width','height'].map(key=>Number(attr(box,key)));
    nearly(x+w/2,node.x);
    nearly(node.equipmentId.startsWith('AL')?y:y+h,node.y);
  }
  const wrapper=equipmentBox(html,'WRAPPER'),center=metricPoint({x:574.5,y:92},nonlinearProfile());
  nearly(Number(attr(wrapper,'x'))+Number(attr(wrapper,'width'))/2,center.x);
  nearly(Number(attr(wrapper,'y'))+Number(attr(wrapper,'height'))/2,center.y);
});

test('nonlinear equipment symbols cannot overlap their neighbours when their anchors have unequal slopes',()=>{
  const {html}=nonlinearMap(),order=['PGW8','PM1','PGW7','PM2','PGW5','PM3','PGW4','HI','WRAPPER','HO','PGW2','PM4','PGW1','PGW3','PM5','PGW6'];
  const boxes=order.map(id=>equipmentBox(html,id));
  for(let i=1;i<boxes.length;i++)assert.ok(Number(attr(boxes[i-1],'x'))+Number(attr(boxes[i-1],'width'))<Number(attr(boxes[i],'x')),order[i]+' equipment symbol overlap');
});

test('PZ horizontal warping is confined above the warehouse and preserves its common rack column pitch',()=>{
  const {html}=nonlinearMap(),cells=[...html.matchAll(/<rect[^>]*data-row="\d+"[^>]*>/g)].map(m=>m[0]);
  assert.equal(cells.filter(tag=>attr(tag,'fill')!=='url(#gap)').length*2,802);
  for(const cell of cells)nearly(Number(attr(cell,'width')),640);
  assert.match(attr(pathTag(html,'WH-E-MAIN-1'),'d'),/^M[^ ]+ [^ ]+ L[^ ]+ [^ ]+$/);
});

test('metric normal outdoor arrows use exactly the saved E08 and E09 edge geometry',()=>{
  const {html,graph}=nonlinearMap();
  for(const [source,id] of [['E08','NORMAL-ENTRY'],['E09','NORMAL-RETURN']]){
    const parts=graph.edges.filter(e=>e.splitSourceEdgeId===source).sort((a,b)=>a.splitPartIndex-b.splitPartIndex);
    const points=parts.flatMap((edge,i)=>i?edge.displayPath.slice(1):edge.displayPath);
    assert.ok(points.length>2);
    assert.equal(attr(pathTag(html,id),'d'),points.map((p,i)=>(i?'L':'M')+p.x+' '+p.y).join(' '));
  }
});

test('map labels account for actual viewport size and remain readable without moving equipment',()=>{
  const {html}=render(topology,snapshot(),{clientWidth:700,clientHeight:425});
  const group=html.match(/<g data-equipment="PGW4"[^>]*>([\s\S]*?)<\/g>/)?.[1];
  const label=group?.match(/<text[^>]*>/)?.[0];assert.ok(label);
  const scale=createMetricCanvasProjection(profile,{padding:96,sourceBounds:SCHEMATIC_LAYOUT.worldBounds}).scale;
  assert.ok(attr(label,'transform').includes(`scale(${2/scale})`));
  assert.match(attr(label,'style'),/font-size:(?:1[1-9]|[2-9]\d)px/);
  assert.equal(Number(attr(equipmentBox(html,'PGW4'),'x'))+Number(attr(equipmentBox(html,'PGW4'),'width'))/2,stop.x);
});

test('PZ metric equipment labels use a separate staggered callout layer without changing handoff coordinates',()=>{
  const {graph}=nonlinearMap(),{html}=render(graph,snapshot(),{clientWidth:700,clientHeight:425});
  assert.match(html,/data-equipment-label-layer="true"/);
  const ids=[...html.matchAll(/data-callout-equipment="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,16);assert.equal(new Set(ids).size,16);
  const labels=[...html.matchAll(/<text[^>]*data-callout-equipment="[^"]+"[^>]*>/g)].map(m=>m[0]);
  assert.equal(new Set(labels.map(label=>attr(label,'y'))).size,3);
  for(const label of labels)assert.match(attr(label,'style'),/font-size:24px/);
  const node=graph.nodes.find(n=>n.equipmentId==='PGW4'),box=equipmentBox(html,'PGW4');
  nearly(Number(attr(box,'x'))+Number(attr(box,'width'))/2,node.x);
  nearly(Number(attr(box,'y'))+Number(attr(box,'height')),node.y);
  assert.match(html,/data-label-leader="PGW4"/);
});

test('palletizing focus preserves the world projection while framing only its equipment and gates',()=>{
  const {map,svg}=render();map.palletizing();
  const focused=svg.attributes.viewBox.split(' ').map(Number);
  assert.ok(focused.every(Number.isFinite)&&focused[2]>0&&focused[3]>0);
  assert.ok(focused[2]<1400&&focused[3]<850);
  nearly(focused[2]/focused[3],1400/850);
  map.fit();assert.equal(svg.attributes.viewBox,'0 0 1400 850');
});

test('metric overview retains inventory and battery details in titles without colliding with equipment labels',()=>{
  const {html}=render();
  const block=html.match(/<g data-block="WB1"[^>]*>([\s\S]*?)<\/g>/)?.[1];
  const count=block?.match(/<text[^>]*data-wh-detail="true"[^>]*>/)?.[0];
  assert.ok(count);assert.equal(attr(count,'visibility'),'hidden');assert.ok(block.includes('0/182 PL'));
  const aligner=html.match(/<g data-equipment="AL1"[^>]*>([\s\S]*?)<\/g>/)?.[1];
  const quantity=aligner?.match(/<text[^>]*data-wh-detail="true"[^>]*>/)?.[0];
  assert.ok(quantity);assert.equal(attr(quantity,'visibility'),'hidden');assert.ok(aligner.includes('10枚'));
  const battery=html.match(/<text[^>]*data-agf-battery="true"[^>]*>/)?.[0];
  assert.ok(battery);assert.equal(attr(battery,'visibility'),'hidden');assert.ok(html.includes('100.0%'));
  assert.ok(html.includes('同一走行空間：北 ← ／ 南 → ・設備前で明示的に合流'));
  assert.ok(html.includes('北 ← ／ 南 →'));
});

test('warehouse zoom reveals optional details and fitting the overview hides them again',()=>{
  const {map,svg}=render(),states={};
  const label=(kind)=>({getAttribute(key){return ({x:'0',y:'0','data-wh-detail':kind==='inventory'?'true':null,'data-detail-selected':'false'})[key]??null;},
    setAttribute(key,value){states[kind+'-'+key]=value;}});
  const inventory=label('inventory'),battery=label('battery');
  svg.querySelectorAll=selector=>selector==='[data-agf-battery="true"]'?[battery]:[inventory];
  map.warehouse();assert.equal(states['inventory-visibility'],'visible');assert.equal(states['battery-visibility'],'visible');
  map.fit();assert.equal(states['inventory-visibility'],'hidden');assert.equal(states['battery-visibility'],'hidden');
});

test('PZ entrance and exit callout labels stay separate at PC and narrow viewport sizes without moving openings',()=>{
  for(const dimensions of [{clientWidth:1264,clientHeight:720},{clientWidth:700,clientHeight:425},{clientWidth:390,clientHeight:270}]){
    const {html}=render(topology,snapshot(),dimensions);
    const layer=html.match(/<g data-gate-label-layer="true"[^>]*>([\s\S]*?)<\/g>/)?.[1];
    assert.ok(layer,'separate exterior gate label layer');
    const labels=[...layer.matchAll(/<rect[^>]*data-gate-label-box="[^"]+"[^>]*>/g)].map(m=>m[0]);
    assert.equal(labels.length,2);
    assert.ok(Number(attr(labels[0],'x'))+Number(attr(labels[0],'width'))<Number(attr(labels[1],'x')));
    assert.match(layer,/PZ入口SH/);assert.match(layer,/PZ出口SH/);
    const entry=html.match(/<rect data-map-id="PZ-IN"[^>]*>/)?.[0];
    const exit=html.match(/<rect data-map-id="PZ-S-OUT"[^>]*>/)?.[0];
    nearly(Number(attr(entry,'x'))+Number(attr(entry,'width'))/2,metricPoint({x:SCHEMATIC_LAYOUT.gates.pzEntry.x,y:300},profile).x);
    nearly(Number(attr(exit,'x'))+Number(attr(exit,'width'))/2,metricPoint({x:SCHEMATIC_LAYOUT.gates.pzExit.x,y:300},profile).x);
  }
});
