import {WAREHOUSE_BLOCKS,warehouseLocations,slotStatus,displayedSlotStatus,WAREHOUSE_SERVICE} from '../map/warehouse-layout.mjs';
import {escapeHtml as esc,stateLabel,locationName,productLabel} from './format.mjs';
import {warehouseRowStyle,warehouseOwnerLegend} from './warehouse-colors.mjs';
import {metricPoint,createMetricCanvasProjection} from '../map/metric-layout.mjs';

import {effectiveStatus} from './replay-model.mjs';

const slots=warehouseLocations();
const palette={empty:'#e2e8f0',occupied:'#10b981',reserved:'#f59e0b',unavailable:'#64748b',unknown:'#cbd5e1',unsupported:'#dbe5f1'};
const statusNames={empty:'空き',occupied:'使用中',reserved:'予約済み',unavailable:'使用不可',unknown:'未取得',unsupported:'下段成立待ち'};
// These are drawing coordinates of a schematic, with no relationship to CAD coordinates.
const blockBoxes={WB1:[45,514,266,112],WB2:[45,644,266,72],WB3:[45,734,266,172],EB1:[710,514,356,82],EB2:[710,644,356,82]};
const aisleXs=[400,435,665,700],eastAxis=(aisleXs[2]+aisleXs[3])/2;
// A canvas projection never changes graph distance or the saved simulation clock.
// Metric profiles map this legacy schematic into the same mm space as graph nodes.
export const MAP_VIEWBOX=[0,0,1400,850];
// Identity anchors are used only to fit the old non-metric diagram, never to
// claim that its original drawing units were millimetres.
const legacyProfile={schemaVersion:'metric-layout-profile-v1',id:'legacy-canvas-only',revision:0,
  coordinateUnit:'mm',evidence:'legacy-canvas-projection-only',
  readiness:{physicalEtaAllowed:false,metricScaleVerified:false},legacyBounds:[0,0,1100,970],
  axisAnchors:{x:[[0,0],[1100,1100]],y:[[0,0],[970,970]]}};
const text=(x,y,label,cls='',attrs='')=>`<text x="${x}" y="${y}" class="${cls}" ${attrs}>${esc(label)}</text>`;
const rect=(x,y,w,h,cls='',id='',anchor=null)=>`<rect data-map-id="${id}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8" class="${cls}"${anchor?` data-anchor-x="${anchor.x}" data-anchor-y="${anchor.y}" data-anchor-face="${anchor.face}"${anchor.maxWidth?` data-maximum-width="${anchor.maxWidth}"`:''}`:''}/>`;
const markerHeading=(heading,degrees)=>Number.isFinite(degrees)&&degrees%90!==0?
  degrees.toFixed(0)+'°':({east:'→',west:'←',north:'↑',south:'↓'})[heading]??'·';

const tagAttribute=(tag,key)=>tag.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
const withTagAttribute=(tag,key,value)=>{
  const pattern=new RegExp(`(\\s${key}=")[^"]*(")`);
  return pattern.test(tag)?tag.replace(pattern,(_,before,after)=>before+value+after):
    tag.replace(/\/?\s*>$/,ending=>` ${key}="${value}"`+ending);
};
// Only the app-owned static template enters this parser. Saved graph geometry is
// already in world coordinates and is appended afterwards, so it cannot be mapped twice.
function mapSceneryPath(path,point,metric){
  const tokens=path.match(/[MLHVZ]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)??[];
  let command=null,x=0,y=0,index=0;const output=[];
  while(index<tokens.length){
    if(/^[MLHVZ]$/i.test(tokens[index]))command=tokens[index++].toUpperCase();
    if(command==='Z'){output.push('Z');command=null;continue;}
    if(command==='M'||command==='L'){
      x=Number(tokens[index++]);y=Number(tokens[index++]);const p=point({x,y});
      output.push(command+p.x+' '+p.y);if(command==='M')command='L';
    }else if(command==='H'){x=Number(tokens[index++]);const p=point({x,y});output.push(metric?'L'+p.x+' '+p.y:'H'+p.x);}
    else if(command==='V'){y=Number(tokens[index++]);const p=point({x,y});output.push(metric?'L'+p.x+' '+p.y:'V'+p.y);}
    else throw new Error('Unsupported static map path');
  }
  return output.join(' ');
}
const labelFontSize=classes=>classes.includes('zone-heading')?14:classes.includes('equipment-label')?12:
  /map-small|path-label|aisle-label|shutter-label/.test(classes)?11:13;
function mapScenery(source,point,scale,metric,pathOverrides,pixelScale=1,focus='overview'){
  return source.replace(/<(rect|path|circle|text)\b[^>]*>/g,(tag,type)=>{
    let result=tag;
    if(type==='rect'){
      const x=Number(tagAttribute(tag,'x')),y=Number(tagAttribute(tag,'y'));
      const a=point({x,y}),b=point({x:x+Number(tagAttribute(tag,'width')),y:y+Number(tagAttribute(tag,'height'))});
      const dimensions={x:a.x,y:a.y,width:b.x-a.x,height:b.y-a.y};
      if(metric&&tagAttribute(tag,'data-anchor-face')){
        const ax=Number(tagAttribute(tag,'data-anchor-x')),ay=Number(tagAttribute(tag,'data-anchor-y'));
        const center=point({x:ax,y:ay}),face=tagAttribute(tag,'data-anchor-face');
        // A nonlinear anchor table can have a different slope on each side of
        // a stop. Keep the handoff face at that stop, not the midpoint of two
        // transformed rectangle corners. These are unmeasured equipment symbols.
        dimensions.width=point({x:x+Number(tagAttribute(tag,'width')),y:ay}).x-point({x,y:ay}).x;
        const maximum=Number(tagAttribute(tag,'data-maximum-width'));
        if(maximum>0)dimensions.width=Math.min(dimensions.width,maximum);
        dimensions.x=center.x-dimensions.width/2;
        dimensions.y=center.y-dimensions.height*(face==='south'?1:face==='center'?.5:0);
      }
      for(const [key,value] of Object.entries(dimensions))result=withTagAttribute(result,key,value);
      if(tagAttribute(tag,'rx')!==undefined)result=withTagAttribute(result,'rx',Number(tagAttribute(tag,'rx'))/scale);
    }else if(type==='path')result=withTagAttribute(result,'d',pathOverrides?.get(tagAttribute(tag,'data-map-id'))??mapSceneryPath(tagAttribute(tag,'d'),point,metric));
    else if(type==='circle'){
      const p=point({x:Number(tagAttribute(tag,'cx')),y:Number(tagAttribute(tag,'cy'))});
      result=withTagAttribute(withTagAttribute(result,'cx',p.x),'cy',p.y);
      result=withTagAttribute(result,'r',Number(tagAttribute(tag,'r'))/scale);
    }else{
      const p=point({x:Number(tagAttribute(tag,'x')),y:Number(tagAttribute(tag,'y'))});
      const angle=tagAttribute(tag,'transform')?.match(/rotate\(([-\d.]+)/)?.[1];
      result=withTagAttribute(withTagAttribute(result,'x',p.x),'y',p.y);
      result=withTagAttribute(result,'data-map-label','world');
      if(angle)result=withTagAttribute(result,'data-label-angle',angle);
      result=withTagAttribute(result,'style',`font-size:${labelFontSize(tagAttribute(tag,'class')??'')}px`);
      result=withTagAttribute(result,'transform',`translate(${p.x} ${p.y}) scale(${1/(scale*pixelScale)}) ${angle?`rotate(${angle}) `:''}translate(${-p.x} ${-p.y})`);
      if(tagAttribute(tag,'data-overview-hidden')==='true')result=withTagAttribute(result,'visibility',focus==='PZ'?'visible':'hidden');
      if(metric&&tagAttribute(tag,'data-pz-note')==='true')result=withTagAttribute(result,'visibility',focus==='PZ'?'visible':'hidden');
      if(metric&&tagAttribute(tag,'data-pz-inline')==='true')result=withTagAttribute(result,'visibility','hidden');
    }
    return type==='text'?result:withTagAttribute(result,'vector-effect','non-scaling-stroke');
  });
}

export function initMap({svg,onSelectAgf,onSelectBlock}) {
  let box=[...MAP_VIEWBOX],drag=null,snapshot=null,selected='AGF1';
  let focus='overview';
  let equipmentCallouts=[];
  let layoutProfile=null,projection=createMetricCanvasProjection(legacyProfile);
  const sceneryPoint=p=>layoutProfile?metricPoint(p,layoutProfile):p;
  const screenScale=()=>{
    const width=Number(svg.clientWidth),height=Number(svg.clientHeight);
    return width>0&&height>0?Math.min(width/box[2],height/box[3]):width>0?width/box[2]:1;
  };
  function renderEquipmentCallouts(){
    if(!layoutProfile||!equipmentCallouts.length)return '';
    const pixels=screenScale(),rowEnds=[-Infinity,-Infinity,-Infinity];
    const top=Math.min(...equipmentCallouts.map(item=>projection.point(item.top).y));
    const labels=equipmentCallouts.map((item,index)=>{
      const anchor=projection.point(item.anchor),row=index%3;
      const label=item.label+(item.detail&&(focus==='PZ'||item.selected)?' · '+item.detail:'');
      const width=[...label].reduce((n,char)=>n+(/[\x00-\x7f]/.test(char)?6.3:12),0)/pixels;
      const x=Math.max(anchor.x,rowEnds[row]+width/2+4/pixels),y=top-(6+row*14)/pixels;
      rowEnds[row]=x+width/2;
      return `<path data-label-leader="${esc(item.id)}" d="M${anchor.x} ${anchor.y} L${x} ${y+3/pixels}" fill="none" stroke="#64748b" stroke-width="1" vector-effect="non-scaling-stroke"/>
        <text data-callout-equipment="${esc(item.id)}" x="${x}" y="${y}" class="align-center" style="font-size:${12/pixels}px"><title>${esc(item.label+(item.detail?' · '+item.detail:''))}</title>${esc(label)}</text>`;
    }).join('');
    const heading=projection.point(sceneryPoint({x:48,y:22}));
    return `<g data-equipment-label-layer="true" data-text-unit="viewport-pixels"><text x="${heading.x}" y="${top-53/pixels}" class="zone-heading" style="font-size:${14/pixels}px">01 / パレタイズエリア</text>${labels}</g>`;
  }
  const refreshLabels=()=>{
    if(!svg.querySelectorAll)return;
    const inverse=1/(projection.scale*screenScale());
    for(const label of svg.querySelectorAll('[data-map-label="world"]')){
      if(!label.getAttribute)continue;
      const x=Number(label.getAttribute('x')),y=Number(label.getAttribute('y')),angle=label.getAttribute('data-label-angle');
      label.setAttribute('transform',`translate(${x} ${y}) scale(${inverse}) ${angle?`rotate(${angle}) `:''}translate(${-x} ${-y})`);
      if(label.getAttribute('data-overview-hidden')==='true')label.setAttribute('visibility',focus==='PZ'?'visible':'hidden');
      if(layoutProfile&&label.getAttribute('data-pz-note')==='true')label.setAttribute('visibility',focus==='PZ'?'visible':'hidden');
      if(layoutProfile&&label.getAttribute('data-pz-inline')==='true')label.setAttribute('visibility','hidden');
    }
    const layer=svg.querySelector?.('[data-equipment-label-layer="true"]');
    if(layer)layer.outerHTML=renderEquipmentCallouts();
  };
  const updateView=()=>{svg.setAttribute('viewBox',box.join(' '));refreshLabels();};
  const fit=()=>{focus='overview';box=[...MAP_VIEWBOX];updateView();};
  const zoom=factor=>{const w=Math.max(300,Math.min(1800,box[2]*factor)),h=w*box[3]/box[2];
    box=[box[0]+(box[2]-w)/2,box[1]+(box[3]-h)/2,w,h];updateView();};
  svg.addEventListener('wheel',event=>{event.preventDefault();zoom(event.deltaY>0?1.12:1/1.12);},{passive:false});
  svg.addEventListener('pointerdown',event=>{
    if(event.target.closest('[data-agf],[data-block]')||event.button!==0)return;
    const matrix=svg.getScreenCTM();if(!matrix)return;
    drag={x:event.clientX,y:event.clientY,box:[...box],scale:matrix.a};svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove',event=>{if(!drag)return;
    box=[drag.box[0]-(event.clientX-drag.x)/drag.scale,drag.box[1]-(event.clientY-drag.y)/drag.scale,...drag.box.slice(2)];updateView();});
  const endDrag=()=>{drag=null;};svg.addEventListener('pointerup',endDrag);svg.addEventListener('pointercancel',endDrag);
  const activate=target=>{const agf=target.closest('[data-agf]'),block=target.closest('[data-block]');
    if(agf)onSelectAgf(agf.dataset.agf);if(block)onSelectBlock(block.dataset.block);};
  svg.addEventListener('click',event=>activate(event.target));
  svg.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate(event.target);}});
  if(typeof ResizeObserver==='function')new ResizeObserver(refreshLabels).observe(svg);

  function markerLayouts(agfs){
    const positions=agfs.map((agf,index)=>({agf,index,...(agf.displayPosition??sceneryPoint({x:210+index*160,
      y:agf.area==='PZ'?235:465}))}));
    return positions.map(position=>{
      const peers=positions.filter(other=>other.x===position.x&&other.y===position.y)
        .sort((left,right)=>left.agf.id.localeCompare(right.agf.id,'en'));
      // The west pillar stop sits in a narrow rack gap. Move only its label;
      // the dot and replay coordinates still identify the saved stop position.
      const pillarOffset=position.agf.currentNodeId==='PILLAR-WAIT-W'&&!position.agf.movement?.current?40:0;
      return {...position,labelX:(pillarOffset+(peers.findIndex(other=>other.agf.id===position.agf.id)-(peers.length-1)/2)*120)/projection.scale};
    });
  }

  function render(next,selectedId,{timeMs=0,topology=null}={}) {
    snapshot=next;selected=selectedId;
    layoutProfile=topology?.metricLayoutProfile??null;
    projection=createMetricCanvasProjection(layoutProfile??legacyProfile,{padding:layoutProfile?96:24});
    equipmentCallouts=[];
    const selectedTask=snapshot.tasks.find(t=>t.id===snapshot.agfs.find(a=>a.id===selected)?.taskId);
    const targeted=id=>[selectedTask?.originId,selectedTask?.destinationId].includes(equipmentInterface(id))?' target-equipment':'';
    function equipment(id,label,x,y,w,h,detail='') {
      const face=/^(PGW|PM)/.test(id)||['HI','HO'].includes(id)?'south':/^(OT|AL)/.test(id)?'north':'center';
      const anchor={x:x+w/2,y:y+h*(face==='south'?1:face==='center'?.5:0),face};
      if(layoutProfile&&equipmentOrder.includes(id)){
        const at=sceneryPoint(anchor).x;
        const gaps=equipmentOrder.filter(other=>other!==id).map(other=>Math.abs(at-sceneryPoint({x:70.5+equipmentOrder.indexOf(other)*63,y:anchor.y}).x));
        // Cap only the schematic equipment symbol; saved stop positions,
        // edge lengths, lane geometry and handling resources remain unchanged.
        anchor.maxWidth=Math.min(...gaps)*.88;
        equipmentCallouts.push({id,label,detail,selected:!!targeted(id),
          anchor:sceneryPoint({x:anchor.x,y:y+h/2}),top:sceneryPoint({x:anchor.x,y})});
      }
      const pzInline=equipmentOrder.includes(id),overviewHidden=(pzInline||id.startsWith('OT'))&&!targeted(id);
      return `<g data-equipment="${id}" class="equipment${targeted(id)}"><title>${esc(label+(detail?' · '+detail:''))}</title>${rect(x,y,w,h,'equipment-body','',anchor)}${text(x+w/2,y+h*(detail ? .3 : .5),label,'equipment-label align-center'+(w<80||h<45?' compact-label':''),`data-pz-inline="${pzInline}"`)}${detail?text(x+w/2,y+h*.74,detail,'map-small align-center',`data-overview-hidden="${overviewHidden}" data-pz-inline="${pzInline}"`):''}</g>`;
    }
    const equipmentOrder=['PGW8','PM1','PGW7','PM2','PGW5','PM3','PGW4','HI','WRAPPER','HO','PGW2','PM4','PGW1','PGW3','PM5','PGW6'];
    const equipmentInterface=id=>id.startsWith('PGW')?'L'+id.slice(3):id.startsWith('PM')?'M'+id.slice(2):({HI:'WRAP-INPUT',HO:'WRAP-OUTPUT'}[id]??id);
    const equipmentStrip=equipmentOrder.map((id,index)=>{
      const x=43+index*63,label=id==='WRAPPER'?'包装機':id;
      let detail='';
      if(id.startsWith('PGW'))detail=(snapshot.lines[equipmentInterface(id)]?.length??0)+' PL';
      if(id.startsWith('PM'))detail=(snapshot.magazines[equipmentInterface(id)]?.quantity??0)+'枚';
      return equipment(id,label,x,65,55,54,detail);
    }).join('');
    const temps=[1,2,3].map((n,i)=>equipment('OT'+n,'OT'+n,810+i*78,262,69,50,
      `${snapshot.temporaryPallets.filter(p=>p.locationId==='OT'+n).length} PL`)).join('');
    const blocks=WAREHOUSE_BLOCKS.map(block=>{
      const [x,y,w,h]=blockBoxes[block.id],bw=(w-32)/block.columns,bh=(h-50)/block.rows;
      const blockSlots=slots.filter(s=>s.blockId===block.id);
      const used=blockSlots.filter(s=>displayedSlotStatus(snapshot.warehouse[s.id],snapshot)==='occupied').length;
      const count=blockSlots.length;
      const active=[selectedTask?.originId,selectedTask?.destinationId].some(id=>id?.startsWith(block.id+'-'));
      let cells='';
      for(let r=1;r<=block.rows;r++){
        const rowId=block.id+'-R'+String(r).padStart(2,'0'),owner=warehouseRowStyle(snapshot.warehouseAllocation,rowId);
        const rowLabel=rowId+' · '+owner.label;
        // Allocation markers sit in the existing rack margin. Cell and rack geometry stays unchanged.
        cells+=`<rect data-warehouse-row="${rowId}" data-owner="${owner.owner}" x="${x+10}" y="${y+40+(r-1)*bh}" width="3" height="${bh-2}" fill="${owner.color}"><title>${esc(rowLabel)}</title></rect>`;
        for(let c=1;c<=block.columns;c++) {
          if(block.emptyColumns.includes(c)){cells+=`<rect data-row="${r}" data-column="${c}" data-tiers="2" x="${x+16+(c-1)*bw}" y="${y+40+(r-1)*bh}" width="${bw-2}" height="${bh-2}" fill="url(#gap)"><title>${esc(rowLabel)} · 第10列は配置対象外</title></rect>`;continue;}
          const pair=blockSlots.filter(s=>s.row===r&&s.column===c).map(s=>displayedSlotStatus(snapshot.warehouse[s.id],snapshot));
          const state=['occupied','reserved','unavailable','empty','unsupported'].find(s=>pair.includes(s))??'unknown';
          const fill=['empty','unsupported'].includes(state)?owner.tint:palette[state];
          cells+=`<rect data-row="${r}" data-column="${c}" data-tiers="2" data-owner="${owner.owner}" x="${x+16+(c-1)*bw}" y="${y+40+(r-1)*bh}" width="${bw-2}" height="${bh-2}" rx="2" fill="${fill}" stroke="${owner.color}" stroke-width=".65"><title>${esc(rowLabel)} · ${c}列 · ${statusNames[state]}</title></rect>`;
        }
      }
      return `<g data-block="${block.id}" role="button" tabindex="0" aria-label="${block.id} ${block.label} ${count}保管位置の行列段を表示" class="warehouse-block${active?' target-equipment':''}">
        ${rect(x,y,w,h,'block-body')}${text(x+15,y+25,block.id+'  '+block.rows+' × '+block.columns+' × 2段')}
        ${text(x+w-15,y+25,used+'/'+count+' PL','map-small align-end')}${cells}</g>`;
    }).join('');
    const nodeMap=topology?new Map(topology.nodes.map(node=>[node.id,node])):null;
    const normalPaths=new Map();
    if(layoutProfile)for(const [source,id] of [['E08','NORMAL-ENTRY'],['E09','NORMAL-RETURN']]){
      const parts=(topology.edges??[]).filter(edge=>edge.splitSourceEdgeId===source||edge.id===source)
        .sort((a,b)=>(a.splitPartIndex??0)-(b.splitPartIndex??0));
      if(parts.length&&parts.every(edge=>edge.displayPath?.length>=2)){
        const points=parts.flatMap((edge,index)=>index?edge.displayPath.slice(1):edge.displayPath);
        normalPaths.set(id,points.map((p,index)=>(index?'L':'M')+p.x+' '+p.y).join(' '));
      }
    }
    const selectedAgf=snapshot.agfs.find(agf=>agf.id===selected);
    const routeOverlay=topology&&selectedAgf?.movement?.steps?.length?selectedAgf.movement.steps.map(step=>{
      const from=nodeMap.get(step.fromNodeId),to=nodeMap.get(step.toNodeId);
      const points=step.displayPath??[from,to];
      return from&&to?`<path d="${points.map((p,i)=>(i?'L':'M')+p.x+' '+p.y).join(' ')}" class="active-route" data-route-edge="${esc(step.edgeId)}" vector-effect="non-scaling-stroke"/>`:'';
    }).join(''):'';
    const agfs=markerLayouts(snapshot.agfs).map(({agf,index,x,y,labelX})=>{
      const status=effectiveStatus(agf,snapshot);
      const positionLabel=agf.displayPosition?`合成グラフ位置 ${locationName(agf.currentNodeId??agf.movement?.current?.edgeId??'')}`:'所属エリアの仮位置';
      const parked=agf.displayPosition&&!agf.movement?.current&&['HP1','HP2','PILLAR-WAIT-W','PILLAR-WAIT-E','CHARGE-PLACE1','CHARGE-PLACE2'].includes(agf.currentNodeId);
      const headingDeg=agf.displayPosition?.headingDeg??agf.headingDeg??({east:0,south:90,west:180,north:270})[agf.heading];
      const orientation=Number.isFinite(headingDeg)?headingDeg:0;
      const body=parked?`<rect class="agf-halo" x="-17" y="-13" width="77" height="26" rx="8"/><g class="agf-orientation" transform="rotate(${orientation})"><rect x="-13" y="-12" width="26" height="24" rx="6" class="agf-body"/><path class="agf-forks" d="M13 -5 H20 M13 5 H20"/></g>${text(0,6,index+1,'agf-number align-center')}${text(23,6,agf.batteryPct.toFixed(1)+'%','map-small',`data-battery-text="${agf.id}"`)}`:
        `<rect class="agf-halo" x="-33" y="-25" width="104" height="50" rx="15"/><g class="agf-orientation" transform="rotate(${orientation})"><rect x="-23" y="-18" width="46" height="36" rx="9" class="agf-body"/><path class="agf-forks" d="M23 -7 H33 M23 7 H33"/></g>${text(0,6,index+1,'agf-number align-center')}${agf.heading?text(0,-27,markerHeading(agf.heading,headingDeg),'heading-label'):''}${text(38,-4,agf.batteryPct.toFixed(1)+'%','map-small',`data-battery-text="${agf.id}"`)}${text(38,13,agf.carriedPalletId?'▣ 積載':'□ 空車','map-small')}`;
      return `<g data-agf="${esc(agf.id)}" data-heading="${esc(agf.heading??'unresolved')}" data-heading-deg="${headingDeg??'unresolved'}" data-motion-state="${esc(status)}" role="button" tabindex="0" aria-label="${esc(agf.id+' '+(stateLabel(status,!!agf.movement))+' '+positionLabel)}" class="agf-marker${agf.id===selected?' selected':''}" transform="translate(${x},${y})">
        <title>${esc(agf.id+'：'+positionLabel+' / '+(agf.heading??'向き未確定')+' / '+(agf.carriedPalletId?'積載':'空車'))}</title>
        <path class="agf-leader" d="M0 0 H${labelX}" vector-effect="non-scaling-stroke"/><circle class="agf-position" cx="0" cy="0" r="${3/projection.scale}"/>
        <g class="agf-label" transform="translate(${labelX},0) scale(${1/projection.scale})">${body}</g></g>`;
    }).join('');
    const scenery=`<rect x="-2000" y="-2000" width="6000" height="6000" fill="#f1f5f9"/><rect x="10" y="10" width="1080" height="950" fill="url(#map-grid)"/>
      <g data-acceptance="G01">${rect(25,22,1050,300,'zone','PZ')}<g data-band="PZ"><title>パレタイズエリア・北面にAGF出入口なし</title>${text(48,51,'01 / パレタイズエリア','zone-heading','data-pz-inline="true"')}</g>
      ${rect(25,337,1050,105,'exterior-zone','INTER')}<g data-band="INTER">${text(48,362,'02 / 外通路','zone-heading')}</g>
      ${rect(25,458,1050,484,'zone','WH')}<g data-band="WH">${text(48,487,'03 / 製品倉庫','zone-heading')}</g></g>
      <g data-acceptance="G02"><title>北面にAGF出入口なし</title>${text(1050,51,'北面にAGF出入口なし','map-small align-end','data-pz-note="true"')}</g>
      ${equipmentStrip}
      <g data-acceptance="G09"><title>同一走行空間：北 ← ／ 南 → ・設備前で明示的に合流</title><rect data-map-id="PZ-SHARED" data-physical-separation="false" x="55" y="158" width="985" height="69" rx="8" fill="#06b6d4" fill-opacity=".07"/><path data-map-id="PZ-A1" d="M55 173 H1040" class="provisional-path" marker-start="url(#arrow)"/><path data-map-id="PZ-A2" d="M55 211 H1040" class="provisional-path" marker-end="url(#arrow)"/><path data-map-id="PZ-MERGES" d="${[70.5,120,133.5,192,196.5,259.5,322.5,385.5,448.5,511.5,574.5,637.5,682.5,700.5,763.5,826.5,840,844.5,889.5,922.5,952.5,1000.5,1015.5].map(x=>`M${x} 173 V211`).join(' ')}" class="provisional-path" opacity=".45"/>${text(550,197,'同一走行空間：北 ← ／ 南 → ・設備前で明示的に合流','path-label','data-pz-note="true"')}</g>
      <g data-acceptance="G03"><rect data-map-id="PZ-W-IN" aria-label="パレタイズ西SH" x="158" y="291" width="68" height="31" class="shutter-gate" data-anchor-x="192" data-anchor-y="306.5" data-anchor-face="center"/>${text(192,312,'西SH','shutter-label')}</g>
      <g data-acceptance="G04"><path d="M${eastAxis} 291 V500" class="alignment-axis"/><rect data-map-id="PZ-S-OUT" aria-label="パレタイズ出口SH" x="${eastAxis-36}" y="291" width="72" height="31" class="shutter-gate" data-anchor-x="${eastAxis}" data-anchor-y="306.5" data-anchor-face="center"/>${text(eastAxis,312,'出口SH','shutter-label')}<rect data-map-id="WH-E-GATE" aria-label="製品倉庫東SH" x="${eastAxis-36}" y="444" width="72" height="28" class="shutter-gate" data-anchor-x="${eastAxis}" data-anchor-y="458" data-anchor-face="center"/>${text(eastAxis,464,'東SH','shutter-label')}</g>
      <g data-acceptance="G05"></g>
      <g data-acceptance="G06"><path data-map-id="NORMAL-RETURN" d="M${eastAxis} 322 V444" class="normal-flow return-flow" marker-end="url(#arrow)"/>${text(eastAxis+18,426,'南へ直進','map-small')}</g>
      <g data-acceptance="G07"><path data-map-id="NORMAL-ENTRY" d="M${eastAxis} 444 V390 H192 V322" class="normal-flow entry-flow" marker-end="url(#arrow)"/>${text(250,380,'倉庫東SH → 西行 → パレ西SH','map-small')}</g>
      <g data-acceptance="G08"><rect data-map-id="WH-W-GATE" x="120" y="444" width="70" height="28" class="shutter-gate inactive" data-anchor-x="155" data-anchor-y="458" data-anchor-face="center"/>${text(155,464,'倉庫西SH','shutter-label')}${text(200,464,'通常不使用・異常時迂回は未確定','map-small')}</g>
      <g data-acceptance="G10"><title>仮置き場は出口東隣・南壁沿い</title>${temps}${text(807,251,'出口東隣・南壁沿い','map-small','data-pz-note="true"')}</g>
      <g data-acceptance="G11">${aisleXs.map((x,i)=>`<path data-map-id="WH-${i<2?'W':'E'}-MAIN-${i%2+1}" data-direction="${i===0||i===3?'north-to-south':'south-to-north'}" d="M${x} 500 V915" class="provisional-path" ${i===0||i===3?'marker-end':'marker-start'}="url(#arrow)"/>${text(x,495,(i<2?'西':'東')+(i%2+1)+(i===0||i===3?'↓':'↑'),'aisle-label')}`).join('')}</g>
      <g data-acceptance="G12"><path data-map-id="CENTRAL-WALL" d="M550 490 V545 M550 580 V752 M550 787 V915" class="center-wall"/><rect data-map-id="FIRE-NORTH" x="530" y="545" width="40" height="35" rx="3" class="fire-gate"/><rect data-map-id="FIRE-SOUTH" x="530" y="752" width="40" height="35" rx="3" class="fire-gate"/>${text(550,568,'北防火SH','shutter-label')}${text(550,775,'南防火SH','shutter-label')}<text x="558" y="650" class="map-small" transform="rotate(90 558 650)">中央壁・横断不可</text></g>
      <g data-acceptance="G13">${blocks}${text(710,640,'EB第10列：パレットなし・通行可否未確定','map-small')}${text(1040,487,'概念保管位置 802 PL','map-small align-end')}</g>
      <g data-acceptance="G14">${[...WAREHOUSE_SERVICE.waitingPlaces.filter(p=>p.id.startsWith('HP')),...WAREHOUSE_SERVICE.chargePlaces].map((p,i)=>{
        const y=i<2?765+i*31:829+(i-2)*31;
        return `<g data-equipment="${p.id}" class="equipment">${rect(719.5,y,125,27,'equipment-body','',{x:782,y:y+13.5,face:'center'})}${text(725,y+13.5,i<2?p.id:'充電'+(i-1),'map-small')}</g>`;
      }).join('')}</g>
      <g data-acceptance="G15">${Object.values(snapshot.aligners).map((a,i)=>equipment(a.id,'AL'+(i+1),858+i*38,765,34,40,(a.quantity??(a.ready?10:0))+'枚')).join('')}<rect data-map-id="EMPTY-PALLET-STORE" x="858" y="825" width="192" height="73" rx="7" fill="url(#gap)" stroke="#b45353" stroke-width="1.5"/>${text(870,849,'空パレ置き場（有人供給）','map-small')}</g>
      <g data-acceptance="G16"><rect data-map-id="PILLAR-WAIT-W" aria-label="柱前待機 西（WB2とWB3間の東寄り・実停止座標未確定）" x="286" y="720" width="20" height="10" class="waiting-candidate"><title>柱前西：通常待機場所・相対位置確認済み、実停止座標未確定</title></rect><path d="M306 725 H318" class="waiting-candidate"/>${text(320,758,'柱前待機 西','map-small')}<rect data-map-id="PILLAR-WAIT-E" aria-label="柱前待機 東（EB1とEB2間の西寄り・実停止座標未確定）" x="715" y="603" width="20" height="12" class="waiting-candidate"><title>柱前東：通常待機場所・相対位置確認済み、実停止座標未確定</title></rect>${text(815,616,'柱前待機 東','map-small')}</g>
      <g data-acceptance="G17">${text(870,876,'× AGF進入禁止','forbidden-label')}</g>
      ${text(48,930,layoutProfile?'mmモデル・縮尺と実停止位置は未検証。実距離・確定ETAではありません。':'概念図・実寸ではありません。未承認経路から実距離・確定ETAを生成しません。','map-small')}`;
    const scale=projection.scale;
    svg.innerHTML=`<defs><pattern id="map-grid" width="${24/scale}" height="${24/scale}" patternUnits="userSpaceOnUse"><circle cx="${1/scale}" cy="${1/scale}" r="${.8/scale}" fill="#cbd5e1"/></pattern>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="${6/scale}" markerHeight="${6/scale}" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#0e7490"/></marker>
      <pattern id="gap" width="${6/scale}" height="${6/scale}" patternUnits="userSpaceOnUse"><path d="M0 ${6/scale} L${6/scale} 0" stroke="#94a3b8" stroke-width="${1/scale}"/></pattern></defs>
      <g data-schematic="landscape" data-coordinate-unit="${layoutProfile?'mm':'schematic'}" ${layoutProfile?`data-metric-profile="${esc(layoutProfile.id)}" `:''}transform="translate(${projection.offsetX} ${projection.offsetY}) scale(${scale})">${mapScenery(scenery,sceneryPoint,scale,!!layoutProfile,normalPaths,screenScale(),focus)}${routeOverlay}${agfs}</g>${renderEquipmentCallouts()}`;
    updateView();
  }
  function updatePositions(agfs){
    const layouts=markerLayouts(agfs);
    for(const marker of svg.querySelectorAll('[data-agf]')){
      const position=layouts.find(item=>item.agf.id===marker.dataset.agf);
      if(!position)continue;
      marker.setAttribute('transform',`translate(${position.x},${position.y})`);
      const heading=position.agf.heading;
      marker.setAttribute('data-heading',heading??'unresolved');
      const headingDeg=position.agf.displayPosition?.headingDeg??position.agf.headingDeg??({east:0,south:90,west:180,north:270})[heading];
      marker.setAttribute('data-heading-deg',headingDeg??'unresolved');
      marker.querySelector('.agf-orientation')?.setAttribute('transform',`rotate(${Number.isFinite(headingDeg)?headingDeg:0})`);
      const arrow=marker.querySelector('.heading-label');
      if(arrow)arrow.textContent=markerHeading(heading,headingDeg);
      marker.querySelector('.agf-label')?.setAttribute('transform',`translate(${position.labelX},0) scale(${1/projection.scale})`);
      marker.querySelector('.agf-leader')?.setAttribute('d',`M0 0 H${position.labelX}`);
    }
  }
  return {render,updatePositions,fit,zoom,palletizing:()=>{
    focus='PZ';
    const a=projection.point(sceneryPoint({x:10,y:10})),b=projection.point(sceneryPoint({x:1090,y:332}));
    const margin=64/screenScale();
    box=[a.x,a.y-margin,b.x-a.x,b.y-a.y+margin];updateView();},warehouse:()=>{
    focus='WH';
    const a=projection.point(sceneryPoint({x:10,y:450})),b=projection.point(sceneryPoint({x:1090,y:960}));
    box=[a.x,a.y,b.x-a.x,b.y-a.y];updateView();},
    getSnapshot:()=>snapshot};
}

export function renderWarehouseBlock(blockId,tier,snapshot) {
  const block=WAREHOUSE_BLOCKS.find(b=>b.id===blockId);
  if(!block)return '';
  const own=slots.filter(s=>s.blockId===blockId);
  const counts=Object.fromEntries(Object.keys(palette).map(state=>[state,own.filter(s=>displayedSlotStatus(snapshot.warehouse[s.id],snapshot)===state).length]));
  const cell=(row,column)=>{
    if(block.emptyColumns.includes(column))return '<div class="slot-gap" title="空列：配置対象外・通行可否未確定">／</div>';
    const slot=own.find(s=>s.row===row&&s.column===column&&s.tier===tier),state=displayedSlotStatus(snapshot.warehouse[slot.id],snapshot);
    const owner=warehouseRowStyle(snapshot.warehouseAllocation,slot.rowId);
    return `<button class="slot slot-${state} warehouse-owner-slot" data-slot="${slot.id}" data-owner="${owner.owner}" style="--owner-color:${owner.color}" aria-label="${slot.id} ${owner.label} ${statusNames[state]}" title="${slot.id} · ${owner.label} · ${statusNames[state]}"><span>${row}-${column}</span><b>${state==='occupied'?'●':state==='reserved'?'◷':state==='unavailable'?'×':'·'}</b></button>`;
  };
  const rowHeader=row=>{
    const rowId=block.id+'-R'+String(row).padStart(2,'0'),owner=warehouseRowStyle(snapshot.warehouseAllocation,rowId);
    return `<span class="row-number warehouse-owner-row" data-warehouse-row="${rowId}" data-owner="${owner.owner}" style="--owner-color:${owner.color}">${row}行<small>↔ 1車線</small><small class="warehouse-owner-label">${esc(owner.label)}</small></span>`;
  };
  return `<div class="block-summary"><div><span class="eyebrow">WAREHOUSE / ${block.id}</span><h2>${block.label} · ${block.id}</h2><p>${block.rows}行 × ${block.columns}列 × 2段 ${block.emptyColumns.length?'（第10列は配置対象外）':''}</p></div><strong>${own.length}<small>保管位置</small></strong></div>
    <div class="slot-counts">${Object.entries(counts).filter(([s])=>s!=='unknown').map(([s,n])=>`<span><i class="legend-dot slot-${s}"></i>${statusNames[s]} <b>${n}</b></span>`).join('')}</div>
    ${warehouseOwnerLegend()}<p class="muted">行の枠・背景は系列割当、●／◷／×とマスの色は保管状態です。未割当行には入庫しません。</p>
    <div class="notice">概念図・Runの保存済み在庫 ／ 各行は双方向1車線、横並び通行不可。個別停止位置・主通路への接続は未確認です。</div>
    <div class="warehouse-scroll"><div class="slot-grid" style="--cols:${block.columns}"><span></span>${Array.from({length:block.columns},(_,i)=>`<span class="col-number">${i+1}列</span>`).join('')}
      ${Array.from({length:block.rows},(_,i)=>`${rowHeader(i+1)}${Array.from({length:block.columns},(_,c)=>cell(i+1,c+1)).join('')}`).join('')}</div></div>
    <p class="muted">${tier}段を表示中。集計は2段合計。${block.emptyColumns.length?'斜線の空列は道路を意味しません。':''}位置を選ぶとパレット・予約を確認できます。</p>`;
}

export function describeSlot(id,snapshot) {
  const slot=snapshot.warehouse[id];
  return `${locationName(id)} ｜ ${statusNames[displayedSlotStatus(slot,snapshot)]} ｜ パレット：${slot?.palletIds?.map(palletId=>palletId+' ('+productLabel(snapshot.pallets.find(p=>p.palletId===palletId))+')').join(', ')||'なし'} ｜ 予約：${slot?.reserved?.join(', ')||'なし'}`;
}
