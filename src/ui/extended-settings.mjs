import {WAREHOUSE_BLOCKS,NORMAL_WAITING_PRIORITY} from '../map/warehouse-layout.mjs';
import {syntheticWarehousePolicy} from '../../examples/synthetic-warehouse-policy.mjs';
import {escapeHtml as esc,locationName} from './format.mjs';

const rowIds=WAREHOUSE_BLOCKS.flatMap(b=>Array.from({length:b.rows},(_,i)=>`${b.id}-R${String(i+1).padStart(2,'0')}`));
const label=(type,load)=>(type==='normal'?'普通銘柄':'特注銘柄')+'・'+(load==='full'?'満載':'端数');
export function populateExtendedSettings(s){
  const root=document.getElementById('extended-settings');root.hidden=!s.warehousePolicy;
  document.querySelectorAll('[data-extended-setting]').forEach(el=>{
    el.hidden=!s.warehousePolicy;
    // Hidden controls still participate in browser constraint validation.
    el.querySelectorAll('input,select,button').forEach(input=>input.disabled=!s.warehousePolicy);
  });
  document.getElementById('legacy-settings-note').hidden=!!s.warehousePolicy;
  document.getElementById('line-fields').parentElement.hidden=!!s.productStreams;
  populateSupplySettings(s);
  if(!s.warehousePolicy)return;
  document.getElementById('product-stream-fields').innerHTML=s.productStreams.map((stream,i)=>`<tr>
    <td>${esc(stream.sourceLineId)}</td><td>${label(stream.productType,stream.loadType)}</td>
    <td><input type="checkbox" data-stream-enabled="${i}" aria-label="${stream.sourceLineId} ${label(stream.productType,stream.loadType)} ON" ${stream.enabled?'checked':''}></td>
    <td><input type="number" min="0.001" step="0.001" data-stream-interval="${i}" value="${stream.intervalMin}" aria-label="${stream.sourceLineId} ${label(stream.productType,stream.loadType)} 間隔（分）"></td>
    <td><input type="number" min="0" step="0.001" data-stream-offset="${i}" value="${stream.startOffsetMin}" aria-label="${stream.sourceLineId} ${label(stream.productType,stream.loadType)} 初回ずらし（分）"></td></tr>`).join('');
  document.getElementById('warehouse-row-fields').innerHTML=rowIds.map(rowId=>{
    const a=s.warehousePolicy.rowAssignments.find(a=>a.rowId===rowId),owner=a?.usage==='special'?'SPECIAL':a?.sourceLineId??'';
    const priority=s.warehousePolicy.rowPriority?.[owner]?.indexOf(rowId)??-1;
    return `<tr><th>${rowId}</th><td><select data-row-owner="${rowId}" aria-label="${rowId} 用途">${[['','未割当'],...Array.from({length:8},(_,i)=>['L'+(i+1),'系列 '+(i+1)]),['SPECIAL','共通・特注銘柄']].map(([v,t])=>`<option value="${v}" ${v===owner?'selected':''}>${t}</option>`).join('')}</select></td>
      <td><input type="number" min="1" step="1" data-row-priority="${rowId}" value="${priority<0?'':priority+1}" aria-label="${rowId} 同用途内の優先順位" placeholder="未設定"></td></tr>`;
  }).join('');
  document.getElementById('hp-target-fields').innerHTML=NORMAL_WAITING_PRIORITY.map((id,i)=>
    `<div><h3>${i+1}. ${esc(locationName(id))}</h3><span class="muted">全AGF共通・空きかつ未予約</span></div>`).join('');
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
    ['AGF・充電設定','初期状態・電池・倉庫待機',[section('agf-fields'),section('battery-fields'),extended[2]]]
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
  readSupplySettings(s);
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
  s.postTaskPolicy={evidence:'user-confirmed-shared-priority',waitingPriority:[...NORMAL_WAITING_PRIORITY]};
}
export function loadSyntheticSettingsExample(s){
  readSupplySettings(s);
  // Replace the row-allocation example only; preserve edited production streams.
  s.productStreams=s.productStreams.map((stream,i)=>({...stream,
    enabled:document.querySelector(`[data-stream-enabled="${i}"]`).checked,
    intervalMin:Number(document.querySelector(`[data-stream-interval="${i}"]`).value),
    startOffsetMin:Number(document.querySelector(`[data-stream-offset="${i}"]`).value)}));
  s.warehousePolicy=syntheticWarehousePolicy();
  populateExtendedSettings(s);
}

const roman=['I','II','III','IV','V','VI','VII','VIII'];
function populateSupplySettings(s){
  const root=document.getElementById('supply-settings');
  if(!root)return;
  root.hidden=s.productionModel!=='empty_pallet_supply';
  if(root.hidden){root.replaceChildren();return;}
  root.innerHTML=`<h3>空パレット供給・整列機初期装填</h3>
    <p class="notice">8系列と5マガジンの実対応は未確定です。全系列の対応を明示するまで通常Runは開始できません。空時の再開方式も自動選択しません。</p>
    <div class="fields supply-mapping">${Array.from({length:8},(_,i)=>{const id='L'+(i+1);return `<label>GW${roman[i]} / ${id} 使用マガジン<select data-line-magazine="${id}" aria-label="${id} 使用マガジン"><option value="">未設定</option>${s.magazines.map(m=>`<option value="${m.id}" ${s.lineMagazineMap?.[id]===m.id?'selected':''}>${m.id}</option>`).join('')}</select></label>`;}).join('')}</div>
    <label>マガジン0枚停止後の再開方式<select id="magazine-recovery-policy"><option value="">未設定 · 補充後も生産保留</option><option value="immediate_retry">保留生産を補充直後に再試行</option><option value="next_takt">次のタクトから生産</option></select></label>
    <p class="muted">現場の再開方式は未確定です。選択値はこのRunの明示条件として保存します。</p>
    <div class="supply-initial fields">${s.magazines.map(m=>`<label>${m.id} 初期枚数<input type="number" min="0" max="${m.capacity}" step="1" value="${m.quantity}" data-initial-magazine="${m.id}" aria-label="${m.id} 初期枚数"></label>`).join('')}${s.aligners.map(a=>`<label>${a.id} 初期枚数<select data-initial-aligner="${a.id}" aria-label="${a.id} 初期枚数"><option value="10" ${a.quantity===10?'selected':''}>10枚</option><option value="0" ${a.quantity===0?'selected':''}>0枚 · 明示検証条件</option></select></label>`).join('')}</div>`;
  document.getElementById('magazine-recovery-policy').value=s.magazineEmptyRecoveryPolicy??'';
}
function readSupplySettings(s){
  if(s.productionModel!=='empty_pallet_supply')return;
  s.lineMagazineMap=Object.fromEntries(Array.from({length:8},(_,i)=>{const id='L'+(i+1);return [id,document.querySelector(`[data-line-magazine="${id}"]`).value||null];}));
  s.magazineEmptyRecoveryPolicy=document.getElementById('magazine-recovery-policy').value||null;
  s.magazines=s.magazines.map(m=>({...m,quantity:Number(document.querySelector(`[data-initial-magazine="${m.id}"]`).value)}));
  s.aligners=s.aligners.map(a=>({id:a.id,quantity:Number(document.querySelector(`[data-initial-aligner="${a.id}"]`).value)}));
  s.evidence.lineMagazineMap=Object.values(s.lineMagazineMap).every(Boolean)?'explicit-scenario-setting':'unconfigured';
  s.evidence.magazineEmptyRecoveryPolicy=s.magazineEmptyRecoveryPolicy?'explicit-scenario-setting':'unresolved';
  s.evidence.inventory=s.magazines.every(m=>m.quantity===10)&&s.aligners.every(a=>a.quantity===10)?'user-confirmed-neutral-start':'explicit-scenario-initial-inventory';
}
