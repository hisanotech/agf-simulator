import {simulate} from '../core/simulate.mjs';
import {projectBatteryPct,batteryModel} from '../core/battery-model.mjs';
import {projectAgfPosition} from '../core/motion-projection.mjs';
import {createDemoScenario} from './scenario.mjs';
import {snapshotIndexAt,replayTime,analyzeRun,compareRuns,effectiveStatus} from './replay-model.mjs';
import {initMap,renderWarehouseBlock,describeSlot} from './map-view.mjs';
import {renderAnalysis,renderComparison,metric} from './analysis-view.mjs';
import {initCadPanel} from './cad-panel.mjs';
import {eventCsv} from './export.mjs';
import {WAREHOUSE_BLOCKS} from '../map/warehouse-layout.mjs';
import {escapeHtml as esc,clock,states,taskNames,reasons,eventNames,areaName,locationName,badge} from './format.mjs';

const $=id=>document.getElementById(id);
const timeFields=[['emptyMin','空走（分）'],['loadedMin','積載走行（分）'],['pickupMin','荷受け（分）'],
  ['dropoffMin','荷下ろし（分）'],['wrapMin','包装（分）'],['labelMin','ラベル（分）'],['exitMin','出口移送（分）'],['chargeTravelMin','充電場所への移動（分）']];
const batteryFields=[['reservePct','選定残量下限（%）'],['chargeStartPct','充電要求（%）'],['chargeTargetPct','復帰残量（%）'],
  ['activeReferenceMin','基準稼働時間（分）'],['activeReferenceConsumptionPct','基準時間での消費（ポイント）'],
  ['consumptionPct','旧方式：1タスク消費（ポイント）'],['chargeMinPerPct','1ポイント充電に要する時間（分）']];
const numeric=id=>Number($(id).value);
const input=(id,label,value,min=0,step=.1,max='')=>`<label>${esc(label)}<input id="${id}" type="number" min="${min}" step="${step}" ${max!==''?`max="${max}"`:''} value="${value}" required></label>`;
let base=createDemoScenario(),result=null,analysis=null,comparison=null,runId='',runNumber=0;
let timeMs=0,currentIndex=-1,batterySecond=-1,selectedAgf='AGF1',activeView='monitor',dirty=false,frame=null,anchor=null;
let selectedBlock='WB1',reservationKind='05';
const map=initMap({svg:$('map'),onSelectAgf:selectAgf,onSelectBlock:openWarehouse});

function populateSettings(scenario) {
  $('duration').value=scenario.durationMin;$('lineCapacity').value=scenario.lineCapacity;
  $('fallback').value=scenario.fallback;$('mode').value=scenario.mode;
  $('inputCapacity').value=scenario.wrapper.inputCapacity;$('outputCapacity').value=scenario.wrapper.outputCapacity;
  $('line-fields').innerHTML=scenario.lineIntervalsMin.map((n,i)=>`<div class="line-setting"><h3>系列 ${i+1}</h3>${input('line-'+i,'搬出間隔（分）',n)}${input('offset-'+i,'初回ずらし（分）',scenario.lineStartOffsetsMin[i],0,.001)}</div>`).join('');
  $('time-fields').innerHTML=timeFields.map(([id,label])=>input(id,label,scenario.times[id],id==='wrapMin'?.001:0,.001)).join('');
  $('battery-fields').innerHTML='<label>消費方式<select id="battery-model"><option value="active_time">走行・荷役の稼働時間</option><option value="per_task">タスク単位（旧シナリオ再現用）</option></select></label>'+
    batteryFields.map(([id,label])=>input(id,label,scenario.battery[id],['chargeMinPerPct','activeReferenceMin'].includes(id)?.001:0,.001,id.endsWith('Pct')&&id!=='chargeMinPerPct'?100:'')).join('');
  $('battery-model').value=batteryModel(scenario.battery);syncBatteryFields();
  $('agf-fields').innerHTML=scenario.agfs.map((a,i)=>`<div><h3>${a.id}</h3>${input('initial-battery-'+i,'初期残量（%）',a.batteryPct,0,.1,100)}<label>初期エリア<select id="initial-area-${i}"><option value="PZ" ${a.area==='PZ'?'selected':''}>パレタイズ</option><option value="WH" ${a.area==='WH'?'selected':''}>製品倉庫</option></select></label></div>`).join('');
}
function syncBatteryFields(){const active=$('battery-model').value==='active_time';
  for(const id of ['activeReferenceMin','activeReferenceConsumptionPct']){$(id).disabled=!active;$(id).parentElement.hidden=!active;}
  $('consumptionPct').disabled=active;$('consumptionPct').parentElement.hidden=active;
}
function scenarioFromSettings() {
  if(!$('settings-form').checkValidity()) {
    showView('settings');$('settings-form').reportValidity();throw new Error('設定値の入力範囲・単位を確認してください。');
  }
  const scenario=structuredClone(base);
  scenario.durationMin=numeric('duration');scenario.mode=$('mode').value;scenario.fallback=$('fallback').value;
  scenario.lineCapacity=numeric('lineCapacity');
  scenario.wrapper={inputCapacity:numeric('inputCapacity'),outputCapacity:numeric('outputCapacity')};
  scenario.lineIntervalsMin=Array.from({length:8},(_,i)=>numeric('line-'+i));
  scenario.lineStartOffsetsMin=Array.from({length:8},(_,i)=>numeric('offset-'+i));
  scenario.times=Object.fromEntries(timeFields.map(([id])=>[id,numeric(id)]));
  scenario.battery=Object.fromEntries(batteryFields.map(([id])=>[id,numeric(id)]));
  scenario.battery.consumptionModel=$('battery-model').value;
  scenario.evidence.batteryConsumption=scenario.battery.consumptionModel==='active_time'&&
    scenario.battery.activeReferenceMin===360&&scenario.battery.activeReferenceConsumptionPct===70?
    'supplier-assumption-user-relayed':'scenario-assumption';
  scenario.evidence.batteryScope=scenario.battery.consumptionModel==='active_time'?'user-confirmed-driving-and-handling':'legacy-per-task';
  scenario.agfs=scenario.agfs.map((a,i)=>{const area=$('initial-area-'+i).value;return {...a,
    batteryPct:numeric('initial-battery-'+i),area,
    ...(scenario.motionModel==='synthetic_graph'?{currentNodeId:area==='PZ'?'PZ-HOME':'WH-HOME'}:{})};});
  return scenario;
}
function markDirty(value=true) {dirty=value;$('dirty-state').hidden=!value;}
function friendlyError(error) {
  const message=error.message??String(error);
  if(/duplicate|already reserved|reserved temporary/.test(message))return '二重予約です。同じパレットの既存予約を確認してください。';
  if(/temporary pallet|location mismatch|unreserved pallet at specified temporary/.test(message))return '対象パレットと仮置き場が一致しないか、その時刻に利用できません。';
  if(/explicit permission/.test(message))return '再投入／入庫の許可を確認し、チェックを入れてください。';
  if(/warehouse destination|reserve manual destination|available destination|05 destination unavailable/.test(message))return '搬送先を予約できません。空き・許可・同じ行の既存タスクを確認してください。';
  if(/aligner supply already ready or reserved/.test(message))return 'この整列機はすでに搬送OK、またはタスクで予約済みです。荷受け完了後に再度準備してください。';
  if(/magazine empty/.test(message))return 'マガジンが空です。補充が完了するまで使用できません。';
  if(/battery depleted/.test(message))return '走行・荷役中に電池残量が不足する条件です。初期残量・消費率・充電要求・工程時間を見直してください。途中での充電割込みは未実装です。';
  if(/battery/.test(message))return '電池設定を確認してください。基準稼働時間・充電時間は正の値、消費は0〜100ポイント、充電要求は復帰残量未満にしてください。';
  if(/capacity|overflow|underflow/.test(message))return '設備容量または在荷条件を満たせません。搬出間隔・バッファ容量・手動使用回数を確認してください。';
  return message;
}
function showError(error){$('error').textContent=friendlyError(error);$('error').hidden=false;}
function clearError(){$('error').hidden=true;$('notification').hidden=true;}
function notify(message){$('notification').textContent=message;$('notification').hidden=false;}
function showView(view) {
  if(!['monitor','settings','tasks','analysis','comparison'].includes(view))view='monitor';
  activeView=view;
  document.querySelectorAll('.view').forEach(el=>{el.hidden=el.id!=='view-'+view;});
  document.querySelectorAll('[data-view]').forEach(el=>{const active=el.dataset.view===view;el.classList.toggle('active',active);
    if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
  if(view==='tasks')renderTasks();
  if(view==='monitor')renderSnapshot();
  history.replaceState(null,'','#'+view);
}
function adoptRun(next,at=0) {
  pause();result=next;base=structuredClone(next.scenario);analysis=analyzeRun(next);
  runId='LOCAL-'+String(++runNumber).padStart(3,'0');timeMs=Math.min(at,next.scenario.durationMin*60000);currentIndex=-1;
  markDirty(false);$('seek').max=String(analysis.durationMs);$('end-clock').textContent=clock(analysis.durationMs);
  $('run-state').textContent='計算済み';$('run-context').textContent=`${runId} · ${next.scenario.durationMin}分 · ${next.scenario.mode==='area_first'?'エリア優先あり':'エリア優先なし'}`;
  $('analysis-run').textContent=runId+' / 全期間の結果';$('analysis-body').innerHTML=renderAnalysis(next,analysis);
  comparison=null;$('comparison-body').innerHTML='<div class="empty-state"><span>⇄</span><h2>同一条件で選定方式を比較</h2><p>「比較実行」で現在の設定を計算します。</p></div>';
  setTime(timeMs,true);
}
function execute(){clearError();try{const candidate=simulate(scenarioFromSettings());adoptRun(candidate);notify('設定を反映して計算しました。再生・シークで各時刻の状態を確認できます。');}catch(error){showError(error);}}
function pause(){if(frame!==null)cancelAnimationFrame(frame);frame=null;anchor=null;$('play').setAttribute('aria-pressed','false');}
function play(){if(!result||frame!==null)return;if(timeMs>=analysis.durationMs)setTime(0);
  anchor={sim:timeMs,wall:performance.now(),speed:numeric('speed')};$('play').setAttribute('aria-pressed','true');
  const tick=now=>{setTime(replayTime(anchor.sim,now-anchor.wall,anchor.speed,analysis.durationMs));
    if(timeMs>=analysis.durationMs){pause();return;}frame=requestAnimationFrame(tick);};
  frame=requestAnimationFrame(tick);
}
function setTime(ms,force=false){if(!result)return;timeMs=Math.max(0,Math.min(analysis.durationMs,Math.floor(ms)));
  $('seek').value=String(timeMs);$('clock').textContent=clock(timeMs);
  const index=snapshotIndexAt(result.events,timeMs);
  if(force||index!==currentIndex){currentIndex=index;renderSnapshot();}
  else {
    if(result.scenario.motionModel==='synthetic_graph')map.updatePositions(snapshot().agfs);
    if(Math.floor(timeMs/1000)!==batterySecond)renderBattery();
  }
  batterySecond=Math.floor(timeMs/1000);
}
const snapshot=()=>{if(!result)return null;const index=Math.max(0,currentIndex),saved=result.snapshots[index];
  return {...saved,agfs:saved.agfs.map(a=>({...a,batteryPct:projectBatteryPct(a,saved.tasks.find(t=>t.id===a.taskId),
    result.scenario.battery,timeMs-result.events[index].timeMs),
    displayPosition:projectAgfPosition(a,result.scenario.operationalTopology,timeMs)}))};
};
function renderBattery(){for(const a of snapshot().agfs){
  document.querySelectorAll(`[data-battery-text="${a.id}"]`).forEach(el=>{el.textContent=a.batteryPct.toFixed(1)+'%';});
  document.querySelectorAll(`[data-battery-bar="${a.id}"]`).forEach(el=>{el.style.width=a.batteryPct+'%';el.classList.toggle('low',a.batteryPct<=result.scenario.battery.chargeStartPct);});
}}
function selectAgf(id){selectedAgf=id;renderSnapshot();}
function renderSnapshot(){if(!result)return;const snap=snapshot();
  const completed=snap.tasks.filter(t=>t.status==='completed').length;
  const held=snap.tasks.filter(t=>t.status!=='completed'&&t.waitReason).length;
  const working=snap.agfs.filter(a=>['moving_empty','moving_loaded'].includes(effectiveStatus(a,snap))).length;
  $('metrics').innerHTML=metric('搬送要求',snap.tasks.length,'件','表示時点の累計','','↗')+metric('搬送完了',completed,'件','表示時点の累計','success','✓')+
    metric('保留タスク',held,'件',`未完了 ${snap.tasks.length-completed}件`,'warning','◷')+metric('作業中AGF',working,'/ 4台','空走・荷受け / 積載・荷下ろし','accent','▥');
  map.render(snap,selectedAgf,{timeMs,topology:result.scenario.operationalTopology??null});
  $('agf-list').innerHTML=snap.agfs.map((a,i)=>{
    const task=snap.tasks.find(t=>t.id===a.taskId),status=effectiveStatus(a,snap);
    return `<button class="agf-card${a.id===selectedAgf?' selected':''}" data-select-agf="${esc(a.id)}" aria-pressed="${a.id===selectedAgf}">
      <div class="agf-card-head"><span class="agf-id"><span class="vehicle-number">${i+1}</span>${esc(a.id)}</span>${badge(status)}</div>
      <div class="battery-line"><span>電池</span><span class="battery-track"><i data-battery-bar="${a.id}" class="${a.batteryPct<=result.scenario.battery.chargeStartPct?'low':''}" style="width:${a.batteryPct}%"></i></span><b data-battery-text="${a.id}">${a.batteryPct.toFixed(1)}%</b></div>
      <dl class="agf-details"><dt>タスク</dt><dd>${task?esc(task.id)+' / '+task.kind:'—'}</dd><dt>搬送元 → 先</dt><dd>${task?esc(locationName(task.originId))+' → '+esc(locationName(task.destinationId)):'—'}</dd>
      <dt>積載</dt><dd>${esc(a.carriedPalletId??'なし')}</dd><dt>現在位置</dt><dd>${esc(a.currentNodeId??areaName(a.area)+'（概念エリア）')}</dd><dt>方向</dt><dd>${esc(a.heading??'未確定')}</dd></dl></button>`;
  }).join('');
  const selected=snap.agfs.find(a=>a.id===selectedAgf),task=snap.tasks.find(t=>t.id===selected?.taskId);
  const movement=selected?.movement,current=movement?.current;
  $('route-detail').innerHTML=`<b>${esc(selectedAgf)}</b> ${task?`${esc(task.id)} · ${task.kind} ｜ ${esc(locationName(task.originId))} → ${esc(locationName(task.destinationId))}<br>`:'｜ 実行中タスクなし · '}<span class="muted">${current?`合成区間 ${esc(current.edgeId)} / ${esc(current.fromNodeId)} → ${esc(current.toNodeId)} / ${esc(selected.heading??'方向未定')}`:'実CAD経路・確定ETAは未承認'}</span>`;
  $('charger-list').innerHTML=Object.entries(snap.chargers).map(([id,agf],i)=>`<div class="charger-row"><span>ϟ 充電器 ${i+1}</span><b>${agf?esc(agf)+' · 充電中':'○ 空き'}</b></div>`).join('');
  const chip=(label,ready=false)=>`<span class="equipment-chip${ready?' ready':''}">${esc(label)}</span>`;
  $('equipment-list').innerHTML=[
    ['系列バッファ',Object.entries(snap.lines).map(([id,pl])=>chip(id+' '+pl.length+'/'+result.scenario.lineCapacity)).join('')],
    ['包装機',`<p>投入 ${snap.wrapper.input.length}/${result.scenario.wrapper.inputCapacity} · 回収 ${snap.wrapper.output.length}/${result.scenario.wrapper.outputCapacity}<br>処理中：${esc(snap.wrapper.processing??'なし')}</p>`],
    ['マガジン',Object.values(snap.magazines).map(m=>chip(m.id+' '+m.quantity+'枚'+(m.pending?' 補充要求':''),m.pending)).join('')],
    ['整列機・倉庫',Object.values(snap.aligners).map(a=>chip(a.id+(a.ready?' OK':' 待機'),a.ready)).join('')+`<p>倉庫内 ${Object.values(snap.warehouse).reduce((n,s)=>n+s.palletIds.length,0)} PL · サンプル在庫</p>`]
  ].map(([title,content])=>`<div class="equipment-group"><h3>${title}</h3><div class="equipment-chips">${content}</div></div>`).join('');
  renderLog();renderTasks();if($('warehouse-dialog').open)renderWarehouse();
}
function renderLog(){if(!result)return;const agfFilter=$('log-agf').value,taskFilter=$('log-task').value.trim().toUpperCase();
  const rows=[];
  for(let i=0;i<=currentIndex;i++) {
    const e=result.events[i],task=result.snapshots[i].tasks.find(t=>t.id===e.taskId),agf=e.agfId??task?.agfId??'';
    if(agfFilter&&agf!==agfFilter||taskFilter&&!(e.taskId??'').includes(taskFilter))continue;
    rows.push({e,task,agf});
  }
  $('log-count').textContent=rows.length+'件'+(rows.length>250?' / 最新250件表示':'');
  $('log').innerHTML=rows.slice(-250).reverse().map(({e,task,agf})=>`<tr><td class="mono">${clock(e.timeMs)}</td><td title="${esc(e.type)}">${esc(eventNames[e.type]??e.type)}</td><td>${esc(agf||'—')}</td><td class="mono">${esc(e.taskId??'—')}</td><td>${esc(locationName(task?.originId??e.lineId))}</td><td>${esc(locationName(task?.destinationId??e.locationId))}</td><td class="reason">${esc(e.reason?(reasons[e.reason]??e.reason):task?(states[task.status]??task.status):e.type==='RUN_STARTED'?'合成入力':'記録済み')}</td></tr>`).join('')||'<tr><td class="empty-cell" colspan="7">該当するイベントはありません。</td></tr>';
}
function renderTasks(){if(!result)return;const snap=snapshot();
  $('task-time').textContent=clock(timeMs)+' 時点';
  $('task-counts').innerHTML=['01','02','03','04','05'].map(kind=>{const own=snap.tasks.filter(t=>t.kind===kind),done=own.filter(t=>t.status==='completed').length;
    return `<div class="task-kind-card"><span class="kind">TRANSPORT ${kind}</span>${taskNames[kind]}<b>${own.length}</b><small>完了 ${done} / 未完了 ${own.length-done}</small></div>`;}).join('');
  const kind=$('task-kind').value,state=$('task-state').value;
  const tasks=snap.tasks.filter(t=>(!kind||t.kind===kind)&&(!state||(state==='completed'?t.status==='completed':t.status!=='completed')));
  $('task-list').innerHTML=tasks.toReversed().map(t=>`<tr><td class="mono">${esc(t.id)} <span class="badge">${t.kind}</span></td><td>${badge(t.status)}</td><td class="mono">${esc(t.palletId??(t.kind==='03'?'空PL '+snap.magazines[t.magazineId].refillBatch+'枚':'—'))}</td><td>${esc(locationName(t.originId))}</td><td>${esc(locationName(t.destinationId))}</td><td>${esc(t.agfId??'未割当')}</td><td class="reason">${esc(t.waitReason?reasons[t.waitReason]??t.waitReason:'—')}</td></tr>`).join('')||'<tr><td class="empty-cell" colspan="7">この時刻・条件に該当するタスクはありません。モニターで時刻を進めるか、04・05を予約してください。</td></tr>';
  $('replenishment-status').textContent=Object.values(snap.magazines).map(m=>m.id+': '+m.quantity+'枚'+(m.pending?'（補充要求）':'')).join(' / ');
}
function openWarehouse(id){pause();selectedBlock=id;renderWarehouse();if(!$('warehouse-dialog').open)$('warehouse-dialog').showModal();}
function renderWarehouse(){$('warehouse-body').innerHTML=renderWarehouseBlock(selectedBlock,numeric('warehouse-tier'),snapshot());
  $('block-tabs').innerHTML=WAREHOUSE_BLOCKS.map(b=>`<button data-block-tab="${b.id}" class="${b.id===selectedBlock?'tab-active':''}" aria-pressed="${b.id===selectedBlock}">${b.id}</button>`).join('');
  $('slot-detail').textContent='保管位置を選択すると詳細を表示します。';}
function requireSavedSettings(){if(dirty)throw new Error('設定変更が未反映です。「実行」で条件を確定してから手動入力してください。');}
function openReservation(kind){clearError();try{requireSavedSettings();pause();reservationKind=kind;
  $('reservation-title').textContent=kind+' '+taskNames[kind]+'を予約';$('reservation-time').textContent=`${runId} / ${clock(timeMs)} に追加します。`;
  $('reservation-error').hidden=true;$('permission').checked=false;
  const temps=snapshot().temporaryPallets;
  $('temp-pallet').replaceChildren(...temps.map(p=>new Option(p.palletId+(p.reservedTaskId?'（予約済み）':''),p.palletId)));
  $('manual-slot').replaceChildren(...result.scenario.warehouse.map(s=>new Option(s.id,s.id)));
  $('manual-destination').hidden=kind==='04';syncTemporary();$('reservation-dialog').showModal();
 }catch(error){showError(error);}}
function syncTemporary(){const temp=snapshot().temporaryPallets.find(p=>p.palletId===$('temp-pallet').value);
  if(temp){$('temp-location').value=temp.locationId;$('manual-slot').value=temp.destinationLocationId;}}
function addInput(listName,entry) {requireSavedSettings();const candidate=structuredClone(result.scenario);candidate[listName].push(entry);
  const next=simulate(candidate);adoptRun(next,timeMs);notify('手動入力を追加して再計算しました。表示時刻を維持しています。');}
function reserve(event){event.preventDefault();$('reservation-error').hidden=true;try{
  if(!$('permission').checked)throw new Error('explicit permission');
  const palletId=$('temp-pallet').value;if(!palletId)throw new Error('この時刻に利用できる仮置きパレットがありません。');
  if(result.scenario.manualRequests.some(r=>r.palletId===palletId))throw new Error('duplicate reservation');
  const entry={timeMs,kind:reservationKind,palletId,locationId:$('temp-location').value,requestedBy:'local-simulator-ui'};
  if(reservationKind==='04')entry.reentryPermission=true;
  else{entry.storagePermission=true;entry.destinationLocationId=$('manual-slot').value;}
  addInput('manualRequests',entry);$('reservation-dialog').close();
 }catch(error){$('reservation-error').textContent=friendlyError(error);$('reservation-error').hidden=false;}}
function compare(){pause();clearError();try{const scenario=scenarioFromSettings();comparison=compareRuns(scenario);
  $('comparison-body').innerHTML=renderComparison(comparison);showView('comparison');notify('2方式を同一入力で比較しました。比較条件はこの結果に保持しています。');
 }catch(error){showError(error);}}

populateSettings(base);
for(let i=1;i<=4;i++)$('log-agf').add(new Option('AGF'+i,'AGF'+i));
for(let i=1;i<=5;i++){$('mag-select').add(new Option('マガジン'+i,'M'+i));$('align-select').add(new Option('整列機'+i,'AL'+i));}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
$('settings-form').addEventListener('submit',event=>event.preventDefault());
$('settings-form').addEventListener('input',event=>{markDirty();if(event.target.id==='battery-model')syncBatteryFields();});$('mode').addEventListener('change',()=>markDirty());
$('scenario-select').addEventListener('change',()=>{pause();base=createDemoScenario($('scenario-select').value);populateSettings(base);markDirty();notify('シナリオを設定欄に読み込みました。「実行」で反映します。');});
$('run').addEventListener('click',execute);$('run-settings').addEventListener('click',()=>{execute();if(!dirty)showView('monitor');});
$('reset').addEventListener('click',()=>{pause();clearError();base=createDemoScenario($('scenario-select').value);populateSettings(base);execute();});
$('compare').addEventListener('click',compare);$('compare-page').addEventListener('click',compare);
$('play').addEventListener('click',play);$('pause').addEventListener('click',pause);$('stop').addEventListener('click',()=>{pause();setTime(0);});
$('speed').addEventListener('change',()=>{const wasPlaying=frame!==null;pause();if(wasPlaying)play();});
$('seek').addEventListener('input',()=>{pause();setTime(numeric('seek'));});
$('next-event').addEventListener('click',()=>{pause();const next=result.events.find(e=>e.timeMs>timeMs);setTime(next?.timeMs??analysis.durationMs);});
$('map-fit').addEventListener('click',map.fit);$('map-in').addEventListener('click',()=>map.zoom(.8));$('map-out').addEventListener('click',()=>map.zoom(1.25));$('map-warehouse').addEventListener('click',map.warehouse);
$('agf-list').addEventListener('click',event=>{const b=event.target.closest('[data-select-agf]');if(b)selectAgf(b.dataset.selectAgf);});
$('log-agf').addEventListener('change',renderLog);$('log-task').addEventListener('input',renderLog);$('task-kind').addEventListener('change',renderTasks);$('task-state').addEventListener('change',renderTasks);
$('warehouse-tier').addEventListener('change',renderWarehouse);$('block-tabs').addEventListener('click',event=>{const b=event.target.closest('[data-block-tab]');if(b){selectedBlock=b.dataset.blockTab;renderWarehouse();}});
$('warehouse-body').addEventListener('click',event=>{const b=event.target.closest('[data-slot]');if(b)$('slot-detail').textContent=describeSlot(b.dataset.slot,snapshot());});
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
$('manual04').addEventListener('click',()=>openReservation('04'));$('manual05').addEventListener('click',()=>openReservation('05'));$('temp-pallet').addEventListener('change',syncTemporary);$('reservation-form').addEventListener('submit',reserve);
$('mag-use').addEventListener('click',()=>{clearError();try{addInput('magazineUses',{timeMs,magazineId:$('mag-select').value});}catch(error){showError(error);}});
$('align-ready').addEventListener('click',()=>{clearError();try{addInput('alignerReadyEvents',{timeMs,alignerId:$('align-select').value});}catch(error){showError(error);}});
$('csv').addEventListener('click',()=>{if(!result)return;const url=URL.createObjectURL(new Blob([eventCsv(result,runId)],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=runId+'-events.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify(runId+' の実行条件と全イベントをCSVに出力しました。');});
initCadPanel({showError:error=>{$('cad-error').textContent=friendlyError(error);$('cad-error').hidden=false;},clearError:()=>{$('cad-error').hidden=true;}});
for(const id of ['open-cad','open-cad-map'])$(id).addEventListener('click',()=>{pause();$('cad-dialog').showModal();});
adoptRun(simulate(base));showView(location.hash.slice(1)||'monitor');
