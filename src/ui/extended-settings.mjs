import {WAREHOUSE_BLOCKS} from '../map/warehouse-layout.mjs';
import {productVariants} from '../core/production-streams.mjs';
import {syntheticWarehousePolicy} from '../../examples/synthetic-warehouse-policy.mjs';
import {escapeHtml as esc} from './format.mjs';

const rowIds=WAREHOUSE_BLOCKS.flatMap(b=>Array.from({length:b.rows},(_,i)=>`${b.id}-R${String(i+1).padStart(2,'0')}`));
const label=(type,load)=>(type==='normal'?'普通銘柄':'特注銘柄')+'・'+(load==='full'?'満載':'端数');
export function populateExtendedSettings(s){
  const root=document.getElementById('extended-settings');root.hidden=!s.warehousePolicy;
  document.querySelectorAll('[data-extended-setting]').forEach(el=>el.hidden=!s.warehousePolicy);
  document.getElementById('legacy-settings-note').hidden=!!s.warehousePolicy;
  document.getElementById('line-fields').parentElement.hidden=!!s.productStreams;
  if(!s.warehousePolicy)return;
  document.getElementById('product-stream-fields').innerHTML=s.productStreams.map((stream,i)=>`<tr>
    <td>${esc(stream.sourceLineId)}</td><td>${label(stream.productType,stream.loadType)}</td>
    <td><input type="checkbox" data-stream-enabled="${i}" aria-label="${stream.sourceLineId} ${label(stream.productType,stream.loadType)} ON" ${stream.enabled?'checked':''}></td>
    <td><input type="number" min="0.001" step="0.001" data-stream-interval="${i}" value="${stream.intervalMin}" aria-label="${stream.sourceLineId} ${label(stream.productType,stream.loadType)} 間隔（分）"></td>
    <td><input type="number" min="0" step="0.001" data-stream-offset="${i}" value="${stream.startOffsetMin}" aria-label="${stream.sourceLineId} ${label(stream.productType,stream.loadType)} 初回ずらし（分）"></td></tr>`).join('');
  document.getElementById('warehouse-row-fields').innerHTML=rowIds.map(rowId=>{
    const a=s.warehousePolicy.rowAssignments.find(a=>a.rowId===rowId),owner=a?.usage==='special'?'SPECIAL':a?.sourceLineId??'';
    const priority=s.warehousePolicy.rowPriority?.[owner]?.indexOf(rowId)??-1;
    return `<tr><th>${rowId}</th><td><select data-row-owner="${rowId}" aria-label="${rowId} 用途">${[['','未設定'],...Array.from({length:8},(_,i)=>['L'+(i+1),'系列 '+(i+1)]),['SPECIAL','共通・特注銘柄']].map(([v,t])=>`<option value="${v}" ${v===owner?'selected':''}>${t}</option>`).join('')}</select></td>
      <td><input type="number" min="1" step="1" data-row-priority="${rowId}" value="${priority<0?'':priority+1}" aria-label="${rowId} 同用途内の優先順位" placeholder="未設定"></td></tr>`;
  }).join('');
  document.getElementById('hp-target-fields').innerHTML=s.agfs.map(a=>`<label>${a.id}の復帰先（今回のシナリオ）<select data-hp-target="${a.id}"><option value="">未設定・選択待ち</option>${['HP1','HP2'].map(id=>`<option ${s.postTaskPolicy.waitTargets[a.id]===id?'selected':''}>${id}</option>`).join('')}</select></label>`).join('');
}

/** Move existing controls into four disclosure groups; no field values are replaced. */
export function organizeSettings(){
  const form=document.getElementById('settings-form'),grid=form.querySelector('.settings-grid');
  const section=id=>document.getElementById(id).closest('section');
  const extended=[...document.getElementById('extended-settings').children];
  extended.forEach(el=>el.dataset.extendedSetting='true');
  const groups=[
    ['基本設定','時間・設備・容量',[section('duration'),section('time-fields')]],
    ['搬出設定','8系列・4種別・発生頻度',[section('line-fields'),extended[0]]],
    ['倉庫設定','行割当・入庫順位',[extended[1]]],
    ['AGF・充電設定','初期状態・電池・HP復帰',[section('agf-fields'),section('battery-fields'),extended[2]]]
  ];
  for(const [index,[name,description,sections]] of groups.entries()){
    const details=document.createElement('details');details.className='panel settings-category';details.open=index===0;
    const summary=document.createElement('summary');summary.textContent=name;
    const small=document.createElement('small');small.textContent=description;summary.append(small);
    const body=document.createElement('div');body.className='settings-grid';
    for(const section of sections){section.classList.add('wide');body.append(section);}
    details.append(summary,body);form.append(details);
  }
  grid.remove();
}
export function readExtendedSettings(s){
  if(!s.warehousePolicy)return;
  const get=selector=>document.querySelector(selector);
  s.lineIntervalsMin=Array(8).fill(0);
  s.productStreams=s.productStreams.map((stream,i)=>({...stream,
    enabled:get(`[data-stream-enabled="${i}"]`).checked,
    intervalMin:Number(get(`[data-stream-interval="${i}"]`).value),startOffsetMin:Number(get(`[data-stream-offset="${i}"]`).value)}));
  const assignments=[],priorities={};
  for(const rowId of rowIds){
    const owner=get(`[data-row-owner="${rowId}"]`).value;
    if(!owner)continue;
    assignments.push({rowId,usage:owner==='SPECIAL'?'special':'normal',sourceLineId:owner==='SPECIAL'?null:owner});
    (priorities[owner]??=[]).push({rowId,value:get(`[data-row-priority="${rowId}"]`).value});
  }
  const rowPriority={};
  for(const [owner,rows] of Object.entries(priorities)){
    if(rows.some(r=>r.value===''))continue;
    const values=rows.map(r=>Number(r.value));
    if(new Set(values).size!==values.length||values.some(n=>!Number.isInteger(n)||n<1))throw new Error(`${owner}の行優先順位は重複のない正整数にしてください。`);
    rowPriority[owner]=rows.sort((a,b)=>Number(a.value)-Number(b.value)).map(r=>r.rowId);
  }
  s.warehousePolicy={evidence:'explicit-scenario-setting',rowAssignments:assignments,rowPriority};
  s.postTaskPolicy={evidence:'explicit-scenario-setting',waitTargets:Object.fromEntries(s.agfs.map(a=>[a.id,get(`[data-hp-target="${a.id}"]`).value]).filter(([,id])=>id))};
}
export function loadSyntheticSettingsExample(s){
  // This button replaces allocation and HP examples only; preserve edited streams.
  s.productStreams=s.productStreams.map((stream,i)=>({...stream,
    enabled:document.querySelector(`[data-stream-enabled="${i}"]`).checked,
    intervalMin:Number(document.querySelector(`[data-stream-interval="${i}"]`).value),
    startOffsetMin:Number(document.querySelector(`[data-stream-offset="${i}"]`).value)}));
  s.warehousePolicy=syntheticWarehousePolicy();
  s.postTaskPolicy={evidence:'synthetic-explicit-example',waitTargets:{AGF1:'HP1',AGF2:'HP2',AGF3:'HP1',AGF4:'HP2'}};
  populateExtendedSettings(s);
}
