import {WAREHOUSE_BLOCKS,warehouseLocations,slotStatus,WAREHOUSE_SERVICE} from '../map/warehouse-layout.mjs';
import {escapeHtml as esc,states,locationName} from './format.mjs';

const slots=warehouseLocations();
const palette={empty:'#e2e8f0',occupied:'#10b981',reserved:'#f59e0b',unavailable:'#64748b',unknown:'#cbd5e1'};
const statusNames={empty:'空き',occupied:'使用中',reserved:'予約済み',unavailable:'使用不可',unknown:'未取得'};
// These are drawing coordinates of a schematic, with no relationship to CAD coordinates.
const blockBoxes={WB1:[45,500,330,95],WB2:[45,607,330,64],WB3:[45,683,330,172],EB1:[720,500,330,95],EB2:[720,607,330,95]};
const text=(x,y,label,cls='')=>`<text x="${x}" y="${y}" class="${cls}">${esc(label)}</text>`;
const rect=(x,y,w,h,cls='')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" class="${cls}"/>`;

export function initMap({svg,onSelectAgf,onSelectBlock}) {
  let box=[0,0,1100,970],drag=null,snapshot=null,selected='AGF1';
  const updateView=()=>svg.setAttribute('viewBox',box.join(' '));
  const fit=()=>{box=[0,0,1100,970];updateView();};
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

  function markerLayouts(agfs){
    const positions=agfs.map((agf,index)=>({agf,index,x:agf.displayPosition?.x??(210+index*160),
      y:agf.displayPosition?.y??(agf.area==='PZ'?235:465)}));
    return positions.map(position=>{
      const peers=positions.filter(other=>other.x===position.x&&other.y===position.y)
        .sort((left,right)=>left.agf.id.localeCompare(right.agf.id,'en'));
      return {...position,labelX:(peers.findIndex(other=>other.agf.id===position.agf.id)-(peers.length-1)/2)*120};
    });
  }

  function render(next,selectedId,{timeMs=0,topology=null}={}) {
    snapshot=next;selected=selectedId;
    const selectedTask=snapshot.tasks.find(t=>t.id===snapshot.agfs.find(a=>a.id===selected)?.taskId);
    const targeted=id=>[selectedTask?.originId,selectedTask?.destinationId].includes(id)?' target-equipment':'';
    function equipment(id,label,x,y,w,h,detail='') {
      return `<g class="equipment${targeted(id)}">${rect(x,y,w,h,'equipment-body')}${text(x+w/2,y+h*(detail ? .3 : .5),label,'equipment-label align-center'+(w<80||h<45?' compact-label':''))}${detail?text(x+w/2,y+h*.74,detail,'map-small align-center'):''}</g>`;
    }
    const equipmentOrder=['PGW8','PM1','PGW7','PM2','PGW5','PM3','PGW4','HI','WRAPPER','HO','PGW2','PM4','PGW1','PGW3','PM5','PGW6'];
    let lineIndex=0,magazineIndex=0;
    const equipmentStrip=equipmentOrder.map((id,index)=>{
      const x=43+index*63,label=id==='WRAPPER'?'包装機':id;
      let detail='';
      if(id.startsWith('PGW'))detail=(snapshot.lines['L'+(++lineIndex)]?.length??0)+' PL';
      if(id.startsWith('PM'))detail=(Object.values(snapshot.magazines)[magazineIndex++]?.quantity??0)+'枚';
      return equipment(id,label,x,65,55,54,detail);
    }).join('');
    const temps=[1,2,3].map((n,i)=>equipment('OT'+n,'OT'+n,810+i*78,252,69,34,
      `${snapshot.temporaryPallets.filter(p=>p.locationId==='OT'+n).length} PL`)).join('');
    const blocks=WAREHOUSE_BLOCKS.map(block=>{
      const [x,y,w,h]=blockBoxes[block.id],bw=(w-32)/block.columns,bh=(h-50)/block.rows;
      const blockSlots=slots.filter(s=>s.blockId===block.id);
      const used=blockSlots.filter(s=>slotStatus(snapshot.warehouse[s.id])==='occupied').length;
      const count=blockSlots.length;
      const active=[selectedTask?.originId,selectedTask?.destinationId].some(id=>id?.startsWith(block.id+'-'));
      let cells='';
      for(let r=1;r<=block.rows;r++)for(let c=1;c<=block.columns;c++) {
        if(block.emptyColumns.includes(c)){cells+=`<rect x="${x+16+(c-1)*bw}" y="${y+40+(r-1)*bh}" width="${bw-2}" height="${bh-2}" fill="url(#gap)"/>`;continue;}
        const pair=blockSlots.filter(s=>s.row===r&&s.column===c).map(s=>slotStatus(snapshot.warehouse[s.id]));
        const state=['unavailable','reserved','occupied','empty'].find(s=>pair.includes(s))??'unknown';
        cells+=`<rect x="${x+16+(c-1)*bw}" y="${y+40+(r-1)*bh}" width="${bw-2}" height="${bh-2}" rx="2" fill="${palette[state]}"/>`;
      }
      return `<g data-block="${block.id}" role="button" tabindex="0" aria-label="${block.id} ${block.label} ${count}保管位置の行列段を表示" class="warehouse-block${active?' target-equipment':''}">
        ${rect(x,y,w,h,'block-body')}${text(x+15,y+25,block.id+'  '+block.rows+'行 × '+block.columns+'列 × 2段')}
        ${text(x+w-15,y+25,used+'/'+count+' PL','map-small align-end')}${cells}</g>`;
    }).join('');
    const nodeMap=topology?new Map(topology.nodes.map(node=>[node.id,node])):null;
    const selectedAgf=snapshot.agfs.find(agf=>agf.id===selected);
    const routeOverlay=topology&&selectedAgf?.movement?.steps?.length?selectedAgf.movement.steps.map(step=>{
      const from=nodeMap.get(step.fromNodeId),to=nodeMap.get(step.toNodeId);
      return from&&to?`<path d="M${from.x} ${from.y} L${to.x} ${to.y}" class="active-route" data-route-edge="${esc(step.edgeId)}"/>`:'';
    }).join(''):'';
    const agfs=markerLayouts(snapshot.agfs).map(({agf,index,x,y,labelX})=>{
      const status=snapshot.tasks.find(task=>task.id===agf.taskId)?.status==='wait_drop'?'wait_drop':agf.status;
      const positionLabel=agf.displayPosition?`合成グラフ位置 ${agf.currentNodeId??agf.movement?.current?.edgeId??''}`:'所属エリアの仮位置';
      return `<g data-agf="${esc(agf.id)}" data-heading="${esc(agf.heading??'unresolved')}" role="button" tabindex="0" aria-label="${esc(agf.id+' '+(states[status]??status)+' '+positionLabel)}" class="agf-marker${agf.id===selected?' selected':''}" transform="translate(${x},${y})">
        <title>${esc(agf.id+'：'+positionLabel+' / '+(agf.heading??'向き未確定'))}</title>
        <path class="agf-leader" d="M0 0 H${labelX}"/><circle class="agf-position" cx="0" cy="0" r="3"/>
        <g class="agf-label" transform="translate(${labelX},0)"><rect class="agf-halo" x="-33" y="-25" width="104" height="50" rx="15"/>
        <rect x="-23" y="-18" width="46" height="36" rx="9" class="agf-body"/><text x="0" y="6" text-anchor="middle" class="agf-number">${index+1}</text>
        ${agf.heading?text(0,-27,{east:'→',west:'←',north:'↑',south:'↓'}[agf.heading]??'·','heading-label'):''}<text x="35" y="-4" class="map-small" data-battery-text="${agf.id}">${agf.batteryPct.toFixed(1)}%</text><text x="35" y="13" class="map-small">${agf.carriedPalletId?'▣ 積載':'□ 空車'}</text></g></g>`;
    }).join('');
    svg.innerHTML=`<defs><pattern id="map-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" fill="#cbd5e1"/></pattern>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#0e7490"/></marker>
      <pattern id="gap" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 6 L6 0" stroke="#94a3b8" stroke-width="1"/></pattern></defs>
      <rect x="-2000" y="-2000" width="6000" height="6000" fill="#f1f5f9"/><rect x="10" y="10" width="1080" height="950" fill="url(#map-grid)"/>
      <g data-acceptance="G01">${rect(25,22,1050,300,'zone')}<g data-band="PZ">${text(48,51,'01 / パレタイズエリア','zone-heading')}</g>
      ${rect(25,337,1050,105,'exterior-zone')}<g data-band="INTER">${text(48,362,'02 / 外通路','zone-heading')}</g>
      ${rect(25,458,1050,484,'zone')}<g data-band="WH">${text(48,487,'03 / 製品倉庫','zone-heading')}</g></g>
      <g data-acceptance="G02">${text(1050,51,'北面にAGF出入口なし','map-small align-end')}</g>
      ${equipmentStrip}
      <g data-acceptance="G09"><path d="M55 173 H1040 M55 211 H1040 M55 173 V211 M1040 173 V211" class="provisional-path"/>${text(550,197,'通路1・2：各双方向1車線・両端接続','path-label')}</g>
      <g data-acceptance="G03"><rect x="158" y="291" width="68" height="31" class="shutter-gate"/>${text(192,312,'パレタイズ西SH','shutter-label')}</g>
      <g data-acceptance="G04"><path d="M760 291 V500" class="alignment-axis"/><rect x="724" y="291" width="72" height="31" class="shutter-gate"/>${text(760,312,'パレタイズ出口SH','shutter-label')}<rect x="724" y="444" width="72" height="28" class="shutter-gate"/>${text(760,464,'製品倉庫東SH','shutter-label')}</g>
      <g data-acceptance="G05">${text(1040,306,'旧東SHなし','map-small align-end')}</g>
      <g data-acceptance="G06"><path d="M760 322 V444" class="normal-flow return-flow" marker-end="url(#arrow)"/>${text(778,410,'南へ直進','map-small')}</g>
      <g data-acceptance="G07"><path d="M724 390 H192 V322" class="normal-flow entry-flow" marker-end="url(#arrow)"/>${text(450,382,'倉庫東SH → 西行 → パレ西SH','map-small')}</g>
      <g data-acceptance="G08"><rect x="120" y="444" width="70" height="28" class="shutter-gate inactive"/>${text(155,464,'倉庫西SH','shutter-label')}${text(200,464,'通常不使用・異常時迂回は未確定','map-small')}</g>
      <g data-acceptance="G10">${temps}${text(807,242,'出口東隣・南壁沿い','map-small')}</g>
      <g data-acceptance="G11"><path d="M400 500 V915 M435 500 V915 M665 500 V915 M700 500 V915" class="provisional-path"/>${[400,435,665,700].map((x,i)=>text(x,495,(i<2?'西':'東')+(i%2+1),'aisle-label')).join('')}</g>
      <g data-acceptance="G12"><path d="M550 490 V545 M550 580 V752 M550 787 V915" class="center-wall"/><rect x="530" y="545" width="40" height="35" rx="3" class="fire-gate"/><rect x="530" y="752" width="40" height="35" rx="3" class="fire-gate"/>${text(550,568,'北防火SH','shutter-label')}${text(550,775,'南防火SH','shutter-label')}<text x="558" y="650" class="map-small" transform="rotate(90 558 650)">中央壁・横断不可</text></g>
      <g data-acceptance="G13">${blocks}${text(735,714,'EB第10列：パレットなし・通行可否未確定','map-small')}${text(1040,487,'概念保管位置 802 PL','map-small align-end')}</g>
      <g data-acceptance="G14">${WAREHOUSE_SERVICE.waitingPlaces.map((p,i)=>equipment(p.id,'待機 '+(i+1)+' ↔',720,744+i*31,125,27)).join('')}${WAREHOUSE_SERVICE.chargePlaces.map((p,i)=>equipment(p.id,'充電 '+(i+1)+' ↔',720,808+i*31,125,27)).join('')}</g>
      <g data-acceptance="G15">${Object.values(snapshot.aligners).map((a,i)=>equipment(a.id,'AL'+(i+1),858+i*38,744,34,40,a.ready?'OK':'')).join('')}<rect x="858" y="801" width="192" height="73" rx="7" fill="url(#gap)" stroke="#b45353" stroke-width="1.5"/>${text(870,825,'空パレ置き場（有人供給）','map-small')}</g>
      <g data-acceptance="G16"><rect x="470" y="616" width="63" height="26" class="waiting-candidate"/><rect x="568" y="616" width="63" height="26" class="waiting-candidate"/>${text(501,634,'柱前待機候補 西','map-small align-center')}${text(599,634,'柱前待機候補 東','map-small align-center')}</g>
      <g data-acceptance="G17">${text(870,852,'× AGF進入禁止','forbidden-label')}</g>
      ${text(48,930,'概念図・実寸ではありません。未承認経路から実距離・確定ETAを生成しません。','map-small')}${routeOverlay}${agfs}`;
    updateView();
  }
  function updatePositions(agfs){
    const layouts=markerLayouts(agfs);
    for(const marker of svg.querySelectorAll('[data-agf]')){
      const position=layouts.find(item=>item.agf.id===marker.dataset.agf);
      if(!position)continue;
      marker.setAttribute('transform',`translate(${position.x},${position.y})`);
      marker.querySelector('.agf-label')?.setAttribute('transform',`translate(${position.labelX},0)`);
      marker.querySelector('.agf-leader')?.setAttribute('d',`M0 0 H${position.labelX}`);
    }
  }
  return {render,updatePositions,fit,zoom,warehouse:()=>{box=[10,365,1080,585];updateView();},
    getSnapshot:()=>snapshot};
}

export function renderWarehouseBlock(blockId,tier,snapshot) {
  const block=WAREHOUSE_BLOCKS.find(b=>b.id===blockId);
  if(!block)return '';
  const own=slots.filter(s=>s.blockId===blockId);
  const counts=Object.fromEntries(Object.keys(palette).map(state=>[state,own.filter(s=>slotStatus(snapshot.warehouse[s.id])===state).length]));
  const cell=(row,column)=>{
    if(block.emptyColumns.includes(column))return '<div class="slot-gap" title="空列：配置対象外・通行可否未確定">／</div>';
    const slot=own.find(s=>s.row===row&&s.column===column&&s.tier===tier),state=slotStatus(snapshot.warehouse[slot.id]);
    return `<button class="slot slot-${state}" data-slot="${slot.id}" aria-label="${slot.id} ${statusNames[state]}" title="${slot.id} · ${statusNames[state]}"><span>${row}-${column}</span><b>${state==='occupied'?'●':state==='reserved'?'◷':state==='unavailable'?'×':'·'}</b></button>`;
  };
  return `<div class="block-summary"><div><span class="eyebrow">WAREHOUSE / ${block.id}</span><h2>${block.label} · ${block.id}</h2><p>${block.rows}行 × ${block.columns}列 × 2段 ${block.emptyColumns.length?'（第10列は配置対象外）':''}</p></div><strong>${own.length}<small>保管位置</small></strong></div>
    <div class="slot-counts">${Object.entries(counts).filter(([s])=>s!=='unknown').map(([s,n])=>`<span><i class="legend-dot slot-${s}"></i>${statusNames[s]} <b>${n}</b></span>`).join('')}</div>
    <div class="notice">概念図・サンプル在庫 ／ 各行は双方向1車線、横並び通行不可。個別停止位置・主通路への接続は未確認です。</div>
    <div class="warehouse-scroll"><div class="slot-grid" style="--cols:${block.columns}"><span></span>${Array.from({length:block.columns},(_,i)=>`<span class="col-number">${i+1}列</span>`).join('')}
      ${Array.from({length:block.rows},(_,i)=>`<span class="row-number">${i+1}行<br><small>↔ 1車線</small></span>${Array.from({length:block.columns},(_,c)=>cell(i+1,c+1)).join('')}`).join('')}</div></div>
    <p class="muted">${tier}段を表示中。集計は2段合計。${block.emptyColumns.length?'斜線の空列は道路を意味しません。':''}位置を選ぶとパレット・予約を確認できます。</p>`;
}

export function describeSlot(id,snapshot) {
  const slot=snapshot.warehouse[id];
  return `${locationName(id)} ｜ ${statusNames[slotStatus(slot)]} ｜ パレット：${slot?.palletIds?.join(', ')||'なし'} ｜ 予約：${slot?.reserved?.join(', ')||'なし'}`;
}
