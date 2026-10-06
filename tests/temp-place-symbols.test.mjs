import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initMap} from '../src/ui/map-view.mjs';
import {convertTopologyToMetric,createMetricCanvasProjection} from '../src/map/metric-layout.mjs';
import {SCHEMATIC_LAYOUT} from '../src/map/schematic-layout.mjs';
import {syntheticMetricLayout} from '../examples/synthetic-metric-layout.mjs';
import {nonlinearTempPlaceProfile} from './fixtures/temp-place-profiles.mjs';
import {layoutTempPlaceSymbols} from '../src/ui/temp-place-symbols.mjs';

const source=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
const attr=(tag,key)=>tag?.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function segmentHitsBox(a,b,box){
  let low=0,high=1;
  for(const [axis,min,max] of [['x',box.x,box.right],['y',box.y,box.bottom]]){
    const delta=b[axis]-a[axis];
    if(Math.abs(delta)<1e-9){if(a[axis]<min||a[axis]>max)return false;continue;}
    const t0=(min-a[axis])/delta,t1=(max-a[axis])/delta;
    low=Math.max(low,Math.min(t0,t1));high=Math.min(high,Math.max(t0,t1));
    if(low>high)return false;
  }
  return true;
}
function rendered(profile,selectedLocation=null){
  const graph=convertTopologyToMetric(source,profile);
  const svg={innerHTML:'',clientWidth:1400,clientHeight:850,attributes:{},
    setAttribute(key,value){this.attributes[key]=value;},addEventListener(){}};
  const map=initMap({svg,onSelectAgf(){},onSelectBlock(){}});
  const snapshot={warehouse:{},lines:{},magazines:{},aligners:{},temporaryPallets:[],
    tasks:selectedLocation?[{id:'SELECTED',originId:selectedLocation,destinationId:'WRAP-INPUT'}]:[],
    agfs:[{id:'AGF1',area:'PZ',status:'idle',batteryPct:100,taskId:selectedLocation?'SELECTED':null,
      currentNodeId:'PZ-EXIT',displayPosition:graph.nodes.find(node=>node.id==='PZ-EXIT')}]};
  map.render(snapshot,'AGF1',{topology:graph});
  const scale=createMetricCanvasProjection(profile,{padding:96,sourceBounds:SCHEMATIC_LAYOUT.worldBounds}).scale;
  const symbols=[1,2,3].map(n=>{
    const id='OT'+n,group=svg.innerHTML.match(new RegExp(`<g data-equipment="${id}"[^>]*>([\\s\\S]*?)<\\/g>`));
    assert.ok(group,id);const rect=group[1].match(/<rect[^>]*>/)?.[0];
    const [x,y,width,height]=['x','y','width','height'].map(key=>Number(attr(rect,key)));
    return {id,group:group[0],rect,x,y,width,height,right:x+width,bottom:y+height,
      label:group[1].match(/<text[^>]*data-temp-label[^>]*>/)?.[0]};
  });
  const gate=svg.innerHTML.match(/<rect data-map-id="PZ-S-OUT"[^>]*>/)?.[0];
  return {graph,html:svg.innerHTML,symbols,scale,gate};
}

for(const [name,profile] of [['public',syntheticMetricLayout],['nonlinear',nonlinearTempPlaceProfile]]){
  test(`${name} rendered OT symbols share width, height, rounding and label placement`,()=>{
    const {symbols,scale}=rendered(profile),first=symbols[0];
    for(const symbol of symbols){
      close(symbol.width,first.width);close(symbol.height,first.height);
      assert.equal(attr(symbol.rect,'rx'),attr(first.rect,'rx'));
      assert.equal(attr(symbol.rect,'stroke-width'),attr(first.rect,'stroke-width'));
      assert.ok(symbol.label,'dedicated OT label');
      close(Number(attr(symbol.label,'x'))-symbol.x,symbol.width/2);
      close(Number(attr(symbol.label,'y'))-symbol.y,Number(attr(first.label,'y'))-first.y);
      assert.equal(attr(symbol.label,'style'),attr(first.label,'style'));
      assert.match(symbol.group,/data-size-basis="schematic-symbol"/);
      assert.ok(symbol.width*scale>=40&&symbol.height*scale>=24);
    }
  });

  test(`${name} OT group has clear exit clearance, equal gaps and no normal return intersection`,()=>{
    const {symbols,gate,scale,html}=rendered(profile),gateRight=Number(attr(gate,'x'))+Number(attr(gate,'width'));
    assert.ok((symbols[0].x-gateRight)*scale>=16,'visibly separate exit and OT1');
    const gaps=symbols.slice(1).map((symbol,i)=>symbol.x-symbols[i].right);
    assert.ok(gaps.every(gap=>gap*scale>=12));close(gaps[0],gaps[1]);
    assert.ok(symbols.every(symbol=>symbol.x>gateRight),'normal exit vertical segment stays west of all symbols');
    const route=html.match(/<path data-map-id="NORMAL-RETURN"[^>]*>/)?.[0];
    const coordinates=attr(route,'d').match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number),points=[];
    for(let index=0;index<coordinates.length;index+=2)points.push({x:coordinates[index],y:coordinates[index+1]});
    for(const symbol of symbols)for(let index=1;index<points.length;index++)
      assert.equal(segmentHitsBox(points[index-1],points[index],symbol),false,'rendered return line cannot enter an OT symbol');
  });

  test(`${name} OT stop anchors and saved routes are preserved while selection only changes emphasis`,()=>{
    const normal=rendered(profile),selected=rendered(profile,'OT1'),other=rendered(profile,'OT2');
    for(let index=0;index<3;index++){
      const symbol=normal.symbols[index],node=normal.graph.nodes.find(item=>item.equipmentId===symbol.id);
      assert.ok(node);
      const stop=normal.html.match(new RegExp(`<circle[^>]*data-temp-stop="${symbol.id}"[^>]*>`))?.[0];
      assert.ok(stop,'saved stop is a separate anchor');
      close(Number(attr(stop,'cx')),node.x);close(Number(attr(stop,'cy')),node.y);
      assert.match(normal.html,new RegExp(`data-temp-connector="${symbol.id}"`));
      for(const key of ['x','y','width','height','rx']){
        assert.equal(attr(symbol.rect,key),attr(selected.symbols[index].rect,key));
        assert.equal(attr(symbol.rect,key),attr(other.symbols[index].rect,key));
      }
    }
    assert.match(selected.symbols[0].group,/target-equipment/);
    assert.match(other.symbols[1].group,/target-equipment/);
    assert.deepEqual(normal.graph,convertTopologyToMetric(source,profile));
  });
}

test('OT display group follows exit movement as one unit without changing symbol geometry or gaps',()=>{
  const base={exitRight:800,southY:322,pzRight:1400,projectionScale:1};
  const before=layoutTempPlaceSymbols(base),after=layoutTempPlaceSymbols({...base,exitRight:850});
  before.forEach((symbol,index)=>{
    close(after[index].x-symbol.x,50);
    for(const key of ['y','width','height','rx','gap'])assert.equal(after[index][key],symbol[key]);
  });
});

test('a compressed profile fits all OT symbols together without individual distortion',()=>{
  const places=layoutTempPlaceSymbols({exitRight:800,southY:322,pzRight:920,projectionScale:1});
  assert.ok(places[0].fit<1);
  places.forEach(place=>{close(place.width,places[0].width);close(place.height,places[0].height);
    close(place.width/place.height,56/32);});
  assert.ok(places.at(-1).x+places.at(-1).width<920);
});

test('OT symbols retain common geometry when X band gradients vary between their north and south edges',()=>{
  const banded={...structuredClone(nonlinearTempPlaceProfile),id:'SYNTHETIC-OT-UNEQUAL-BANDS',
    xBands:[{atY:250,anchors:structuredClone(nonlinearTempPlaceProfile.axisAnchors.x)},
      {atY:312,anchors:[[0,0],[1280,51200]]}]};
  const {symbols}=rendered(banded);
  symbols.forEach(symbol=>{close(symbol.width,symbols[0].width);close(symbol.height,symbols[0].height);});
});
