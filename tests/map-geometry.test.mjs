import test from 'node:test';
import assert from 'node:assert/strict';
import {initMap} from '../src/ui/map-view.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {WAREHOUSE_BLOCKS} from '../src/map/warehouse-layout.mjs';
import {readFileSync} from 'node:fs';

// Inspect the actual rendered SVG, not a parallel model of its expected layout.
const svg={innerHTML:'',attributes:{},setAttribute(key,value){this.attributes[key]=value;},addEventListener(){}};
const map=initMap({svg,onSelectAgf(){},onSelectBlock(){}});
map.render(simulate(createDemoScenario('manual')).final,'AGF1');
const html=svg.innerHTML;
test('landscape display fills a 1400 by 850 canvas while preserving the shared schematic projection',()=>{
  assert.equal(svg.attributes.viewBox,'0 0 1400 850');
  const [,sx,sy]=html.match(/data-schematic="landscape" transform="scale\(([^ ]+) ([^)]+)\)"/);
  assert.equal(1100*Number(sx),1400);assert.equal(970*Number(sy),850);
  assert.ok(1050*Number(sx)/1400>.95); // building bands use the available width
  map.zoom(.8);map.fit();assert.equal(svg.attributes.viewBox,'0 0 1400 850');
});
const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,k,v])=>[k,v]));
const tags=[...html.matchAll(/<(rect|path|g)\b[^>]*>/g)].map(m=>({tag:m[1],...attrs(m[0])}));
const item=id=>{const value=tags.find(t=>t['data-map-id']===id);assert.ok(value,id);return value;};
const rectangle=tag=>{const [x,y,w,h]=['x','y','width','height'].map(k=>Number(tag[k]));
  assert.ok([x,y,w,h].every(Number.isFinite));return {x,y,w,h,right:x+w,bottom:y+h,cx:x+w/2,cy:y+h/2};};
const box=id=>rectangle(item(id));
const group=(key,id)=>html.match(new RegExp(`<g ${key}="${id}"[^>]*>([\\s\\S]*?)<\\/g>`))?.[1]??'';
const equipment=id=>rectangle(attrs(group('data-equipment',id).match(/<rect\b[^>]*>/)?.[0]??''));
const block=id=>rectangle(attrs(group('data-block',id).match(/<rect\b[^>]*>/)?.[0]??''));
const numbers=id=>(item(id).d.match(/-?\d+(?:\.\d+)?/g)??[]).map(Number);
const inside=(a,b)=>a.x>=b.x&&a.right<=b.right&&a.y>=b.y&&a.bottom<=b.bottom;
const pz=box('PZ'),wh=box('WH'),out=box('PZ-S-OUT'),east=box('WH-E-GATE');

test('G01 drawn building bands enclose separate zones with exterior space between',()=>{
  const inter=box('INTER');assert.ok(pz.bottom<inter.y&&inter.bottom<wh.y);
  for(const b of WAREHOUSE_BLOCKS)assert.ok(inside(block(b.id),wh));
});
test('G02/G03/G05 actual gates use the south face; no obsolete east opening or label',()=>{
  const gates=tags.filter(t=>t.class?.split(' ').includes('shutter-gate'));
  const pzGates=gates.filter(t=>t['data-map-id']?.startsWith('PZ-')).map(rectangle);
  assert.equal(pzGates.length,2);
  assert.ok(pzGates.every(g=>g.bottom===pz.bottom&&g.y>pz.y));
  assert.ok(box('PZ-W-IN').right<out.x);
  assert.doesNotMatch(html,/旧東SH|PZ-E-OUT/);
});
test('G04/G06 gate and aisle centers align and the return connects their south/north faces',()=>{
  const x1=numbers('WH-E-MAIN-1')[0],x2=numbers('WH-E-MAIN-2')[0];
  assert.equal(out.cx,(x1+x2)/2);assert.equal(east.cx,out.cx);assert.equal(east.cy,wh.y);
  assert.deepEqual(numbers('NORMAL-RETURN'),[out.cx,out.bottom,east.y]);
});
test('G07/G08 normal entry connects east warehouse gate to west palletizing gate only',()=>{
  const entry=box('PZ-W-IN'),west=box('WH-W-GATE');
  const [x,y,turnY,turnX,endY]=numbers('NORMAL-ENTRY');
  assert.equal(x,east.cx);assert.equal(y,east.y);assert.equal(turnX,entry.cx);assert.equal(endY,entry.bottom);
  assert.ok(turnY>pz.bottom&&turnY<wh.y&&turnX<x);
  assert.equal(west.cy,wh.y);assert.ok(item('WH-W-GATE').class.includes('inactive'));
  assert.ok(west.right<entry.cx); // no normal line enters this separate opening
});
test('G09 opposite logical lanes share one region with equipment-front connections; equipment order is retained',()=>{
  const a=numbers('PZ-A1'),b=numbers('PZ-A2');
  assert.ok(a[1]<b[1]);assert.equal(a[0],b[0]);assert.equal(a[2],b[2]);
  assert.equal(item('PZ-SHARED')['data-physical-separation'],'false');
  assert.ok(item('PZ-A1')['marker-start']);assert.equal(item('PZ-A1')['marker-end'],undefined);
  assert.ok(item('PZ-A2')['marker-end']);assert.equal(item('PZ-A2')['marker-start'],undefined);
  const merges=numbers('PZ-MERGES');assert.ok(merges.length>30);
  for(let i=0;i<merges.length;i+=3){assert.equal(merges[i+1],a[1]);assert.equal(merges[i+2],b[1]);}
  for(const x of [192,448.5,511.5,637.5,682.5])assert.ok(merges.filter((_,i)=>i%3===0).includes(x));
  const order=['PGW8','PM1','PGW7','PM2','PGW5','PM3','PGW4','HI','WRAPPER','HO','PGW2','PM4','PGW1','PGW3','PM5','PGW6'];
  order.forEach((id,i)=>{const e=equipment(id);assert.ok(inside(e,pz)&&e.bottom<a[1]);
    if(i)assert.ok(equipment(order[i-1]).right<e.x);});
});
test('G10 temporary places stay ordered against the south wall east of the exit',()=>{
  let last=out.right;for(const id of ['OT1','OT2','OT3']){const e=equipment(id);
    assert.ok(inside(e,pz)&&e.x>last&&pz.bottom-e.bottom<e.h);last=e.right;}
});
test('G11 four main aisles fit between storage and the central wall',()=>{
  const west=['WH-W-MAIN-1','WH-W-MAIN-2'].map(id=>numbers(id)[0]);
  const eastXs=['WH-E-MAIN-1','WH-E-MAIN-2'].map(id=>numbers(id)[0]);
  const wall=numbers('CENTRAL-WALL')[0];assert.equal(new Set([...west,...eastXs]).size,4);
  for(const id of ['WB1','WB2','WB3'])assert.ok(block(id).right<Math.min(...west));
  assert.ok(Math.max(...west)<wall&&wall<Math.min(...eastXs));
  for(const id of ['EB1','EB2'])assert.ok(Math.max(...eastXs)<block(id).x);
  for(const id of ['WH-W-MAIN-1','WH-E-MAIN-2']){
    assert.equal(item(id)['data-direction'],'north-to-south');assert.ok(item(id)['marker-end']);
    assert.equal(item(id)['marker-start'],undefined);
  }
  for(const id of ['WH-W-MAIN-2','WH-E-MAIN-1']){
    assert.equal(item(id)['data-direction'],'south-to-north');assert.ok(item(id)['marker-start']);
    assert.equal(item(id)['marker-end'],undefined);
  }
});
test('G12 central wall opens exactly at the two fire shutters inside the warehouse',()=>{
  const n=box('FIRE-NORTH'),s=box('FIRE-SOUTH'),wall=numbers('CENTRAL-WALL');
  assert.equal(n.cx,s.cx);assert.ok(inside(n,wh)&&inside(s,wh)&&n.bottom<s.y);
  assert.deepEqual(wall,[n.cx,490,n.y,n.cx,n.bottom,s.y,n.cx,s.bottom,915]);
  assert.equal(tags.filter(t=>t.class==='fire-gate').length,2);
});
test('G13 actual rack cells preserve common column width, every row/column/tier and 802 slots',()=>{
  let capacity=0,pitch=null;
  for(const b of WAREHOUSE_BLOCKS){
    const cells=[...group('data-block',b.id).matchAll(/<rect\b[^>]*data-row[^>]*>/g)].map(m=>attrs(m[0]));
    assert.equal(cells.length,b.rows*b.columns);
    const widths=new Set(cells.map(c=>Number(c.width)));assert.equal(widths.size,1);
    const cellWidth=[...widths][0];if(pitch===null)pitch=cellWidth;assert.equal(cellWidth,pitch);
    for(const c of cells){assert.equal(c['data-tiers'],'2');
      const gap=b.emptyColumns.includes(Number(c['data-column']));assert.equal(c.fill==='url(#gap)',gap);
      if(!gap)capacity+=2;}
  }
  assert.equal(capacity,802);assert.ok(block('WB1').bottom<block('WB2').y&&block('WB2').bottom<block('WB3').y);
  assert.ok(block('EB1').w>block('WB1').w&&block('EB1').bottom<block('EB2').y);
});
test('G14/G15 service places are a horizontal-body vertical column below EB2, beside five aligners above storage',()=>{
  const places=['HP1','HP2','CHARGE-PLACE1','CHARGE-PLACE2'].map(equipment),rack=block('EB2');
  places.forEach((p,i)=>{assert.ok(p.y>rack.bottom&&inside(p,wh)&&p.w>p.h);assert.equal(p.x,places[0].x);
    if(i)assert.ok(places[i-1].bottom<p.y);});
  const storage=box('EMPTY-PALLET-STORE');
  for(let i=1;i<=5;i++){const a=equipment('AL'+i);assert.ok(a.x>places[0].right&&a.y>rack.bottom&&a.bottom<storage.y);
    if(i>1){assert.equal(a.y,equipment('AL1').y);assert.ok(a.x>equipment('AL'+(i-1)).right);}}
  assert.ok(storage.x>places[0].right&&inside(storage,wh));
});
test('G16/G17 pillar candidates occupy the confirmed rack gaps without moving racks or entering forbidden storage',()=>{
  const w=box('PILLAR-WAIT-W'),e=box('PILLAR-WAIT-E'),wb2=block('WB2'),wb3=block('WB3'),eb1=block('EB1'),eb2=block('EB2');
  assert.ok(w.y>wb2.bottom&&w.bottom<wb3.y&&w.x>wb2.cx&&w.right<=wb2.right);
  assert.ok(e.y>eb1.bottom&&e.bottom<eb2.y&&e.x>=eb1.x&&e.right<eb1.cx);
  for(const [id,expected] of Object.entries({WB1:[45,514,266,112],WB2:[45,644,266,72],WB3:[45,734,266,172],EB1:[710,514,356,82],EB2:[710,644,356,82]})){
    const b=block(id);assert.deepEqual([b.x,b.y,b.w,b.h],expected);
  }
  const store=box('EMPTY-PALLET-STORE');
  for(const id of ['WH-E-MAIN-1','WH-E-MAIN-2'])assert.ok(numbers(id)[0]<store.x);
  assert.doesNotMatch(html,/data-route-edge="[^"]*EMPTY/);
});

test('synthetic replay paths cross the wall only through fire shutters and never enter empty pallet storage',()=>{
  const graph=JSON.parse(readFileSync(new URL('../examples/synthetic-operational-topology.json',import.meta.url),'utf8'));
  const storage=box('EMPTY-PALLET-STORE'),gates=[box('FIRE-NORTH'),box('FIRE-SOUTH')],wall=gates[0].cx;
  const insideStorage=p=>p.x>=storage.x&&p.x<=storage.right&&p.y>=storage.y&&p.y<=storage.bottom;
  for(const edge of graph.edges){
    assert.ok(edge.displayPath,edge.id);
    const points=edge.displayPath;
    for(let i=1;i<points.length;i++){
      const a=points[i-1],b=points[i];
      assert.ok(a.x===b.x||a.y===b.y,'orthogonal synthetic segment '+edge.id);
      // All fixture segments are orthogonal; detect intersection over the full segment, not just endpoints.
      const overlapX=Math.max(a.x,b.x)>=storage.x&&Math.min(a.x,b.x)<=storage.right;
      const overlapY=Math.max(a.y,b.y)>=storage.y&&Math.min(a.y,b.y)<=storage.bottom;
      assert.ok(!(overlapX&&overlapY)&&!insideStorage(a)&&!insideStorage(b),edge.id+' forbidden storage');
      if((a.x-wall)*(b.x-wall)<0&&a.y>=wh.y){
        assert.ok(gates.some(g=>a.y>g.y&&a.y<g.bottom),edge.id+' wall crossing');
      }
    }
  }
  const entry=graph.edges.filter(e=>e.splitSourceEdgeId==='E08').sort((a,b)=>a.splitPartIndex-b.splitPartIndex),
    exit=graph.edges.filter(e=>e.splitSourceEdgeId==='E09').sort((a,b)=>a.splitPartIndex-b.splitPartIndex);
  assert.equal(entry.length,3);
  assert.equal(entry[0].fromNodeId,'WH-GATE');assert.equal(entry.at(-1).toNodeId,'PZ-ENTRY');
  assert.ok(entry.every((e,i)=>!i||entry[i-1].toNodeId===e.fromNodeId));
  assert.deepEqual([entry[0].displayPath[0],...entry.map(e=>e.displayPath[1])],
    [{x:682.5,y:475},{x:682.5,y:390},{x:192,y:390},{x:192,y:300}]);
  assert.equal(exit[0].fromNodeId,'PZ-EXIT');assert.equal(exit.at(-1).toNodeId,'WH-GATE');
  assert.ok(exit.every((e,i)=>!i||exit[i-1].toNodeId===e.fromNodeId));
  assert.deepEqual([exit[0].displayPath[0],...exit.map(e=>e.displayPath[1])],
    [{x:682.5,y:300},{x:682.5,y:390},{x:682.5,y:475}]);
  assert.ok([...entry,...exit].every(e=>e.lanes.every(l=>l.direction==='forward')));
});
