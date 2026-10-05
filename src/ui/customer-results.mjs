import {escapeHtml as esc,minutes} from './format.mjs';
import {analyzeRun} from './replay-model.mjs';
import {renderCustomerConditions,customerConditionDifferences,selectionLabel,customerLocationName} from './customer-conditions.mjs';

const transports=[['01','パレタイザ → 包装機'],['02','包装機 → 製品倉庫'],['03','整列機 → マガジン'],
  ['04','仮置き場 → 包装機'],['05','仮置き場 → 製品倉庫']];
const kinds=transports.map(([kind])=>kind);
const timeGroups=[['travel','移動',['moving_empty','moving_loaded','moving_to_charge','moving_to_wait']],
  ['handling','荷役',['handling_pickup','handling_dropoff','positioning_for_pickup','picking_fork_inserted','positioning_for_dropoff','dropping_fork_inserted']],
  ['turning','旋回',['turning']],['idle','待機',['idle','hp_wait']],
  ['traffic','通行待ち',['waiting_traffic','waiting_avoidance','waiting_interference']],
  ['equipment','設備待ち',['wait_drop','waiting_pickup','waiting_wrapper_input']],
  ['charging','充電',['charging']],['chargeWait','充電待ち',['waiting_charge','waiting_charge_place']]];
const durationTotal=durations=>Object.values(durations).reduce((sum,value)=>sum+value,0);
const groupedTimes=durations=>{
  const result=timeGroups.map(([key,label,statuses])=>({key,label,timeMs:statuses.reduce((sum,status)=>sum+(durations[status]??0),0)}));
  result.push({key:'other',label:'設定・その他待ち',timeMs:durationTotal(durations)-result.reduce((sum,row)=>sum+row.timeMs,0)});
  return result;
};
const roundedTenths=groups=>{
  const rows=groups.map((group,index)=>({group,index,raw:group.timeMs/6000,value:Math.floor(group.timeMs/6000)}));
  const remainder=Math.round(rows.reduce((sum,row)=>sum+row.raw,0))-rows.reduce((sum,row)=>sum+row.value,0);
  const order=[...rows].sort((a,b)=>b.raw%1-a.raw%1||a.index-b.index);
  for(let i=0;i<remainder;i++)order[i].value++;
  return rows.map(row=>({...row.group,minutes:row.value/10}));
};

export function customerPendingReason(task,agf){
  const status=agf?.status,reason=task.waitReason??agf?.movement?.waitingReason??'';
  // A reservation reason can remain through the departure turn until actual
  // segment entry. Describe the saved activity before interpreting that reason.
  if(status==='waiting_wrapper_input')return '包装機入口待ち';
  if(status==='turning')return '旋回中';
  if(['moving_empty','moving_loaded','moving_to_charge','moving_to_wait'].includes(status))return '搬送中';
  if(['handling_pickup','handling_dropoff','positioning_for_pickup','picking_fork_inserted',
    'positioning_for_dropoff','dropping_fork_inserted'].includes(status))return '荷役中';
  if(status==='waiting_motion_configuration')return '走行・荷役条件の設定待ち';
  if(['waiting_traffic','waiting_avoidance','waiting_interference'].includes(status))return '通行待ち';
  if(['waiting_charge','waiting_charge_place','charging'].includes(status))return '充電待ち';
  if(task.status==='waiting_wrapper_input'||String(reason).startsWith('WRAPPER_INPUT'))return '包装機入口待ち';
  if(/UNREACHABLE|UNRESOLVED|NO_ASSIGNED_STORAGE/.test(reason))return '経路・搬送条件の確認待ち';
  if(!task.agfId||task.status==='queued')return 'AGF割当待ち';
  if(task.status==='wait_drop'||task.status==='wait_pickup'||/PERMISSION|LOCATION|MAGAZINE|ALIGNER/.test(reason))return '設備待ち';
  return '搬送中';
}

/** Official completion events alone define customer achievements. */
export function customerRunSummary(run,analysis=analyzeRun(run)){
  const tasks=run.final.tasks??[],taskMap=new Map(tasks.map(task=>[task.id,task]));
  const completed=new Map();
  for(const event of run.events){
    if(event.type!=='TASK_COMPLETED')continue;
    const task=taskMap.get(event.taskId),kind=event.kind??task?.kind,agfId=event.agfId??task?.agfId;
    if(!kinds.includes(kind)||!(run.final.agfs??[]).some(agf=>agf.id===agfId))
      throw new Error('正式完了イベントの搬送区分またはAGFが不正です。');
    completed.set(event.taskId,{kind,agfId});
  }
  const byKind=transports.map(([kind,content])=>({kind,content,requested:tasks.filter(task=>task.kind===kind).length,
    completed:[...completed.values()].filter(row=>row.kind===kind).length,
    pending:tasks.filter(task=>task.kind===kind&&!completed.has(task.id)).length}));
  const agfs=(run.final.agfs??[]).map(agf=>{
    const time=analysis.agfs.find(row=>row.id===agf.id),own=[...completed.values()].filter(row=>row.agfId===agf.id);
    return {id:agf.id,completed:own.length,byKind:kinds.map(kind=>({kind,completed:own.filter(row=>row.kind===kind).length})),
      finalBatteryPct:agf.batteryPct,chargeCount:run.events.filter(event=>event.type==='CHARGE_STARTED'&&event.agfId===agf.id).length,
      chargingMs:time?.durations.charging??0,timeGroups:roundedTenths(groupedTimes(time?.durations??{}))};
  });
  const pendingTasks=tasks.filter(task=>!completed.has(task.id)).map(task=>({kind:task.kind,
    origin:customerLocationName(task.originId),destination:customerLocationName(task.destinationId),agfId:task.agfId??'未割当',
    reason:customerPendingReason(task,(run.final.agfs??[]).find(agf=>agf.taskId===task.id))}));
  return {completed:completed.size,pending:pendingTasks.length,byKind,agfs,pendingTasks,
    wrapperInputWaitMs:analysis.wrapperInputWaitMs??0,durationMin:run.scenario.durationMin};
}
const table=(headers,rows)=>`<div class="table-scroll"><table><thead><tr>${headers.map(header=>`<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const card=(label,value,unit='件',tone='')=>`<div class="metric ${tone}"><div class="metric-label">${esc(label)}</div><strong>${esc(value)}</strong><small>${unit}</small></div>`;

export function renderCustomerResults(run,analysis){
  const data=customerRunSummary(run,analysis);
  return `${renderCustomerConditions(run)}
    <section class="panel section customer-summary"><div class="panel-heading"><h2>結果サマリー</h2><span class="muted">正式に完了した搬送を集計</span></div><div class="analysis-metrics">
    ${card('シミュレーション時間',data.durationMin,'分')+card('総搬送完了',data.completed,'件','success')+card('未完了搬送',data.pending,'件','warning')+data.byKind.map(row=>card('搬送'+row.kind+' 完了',row.completed)).join('')}</div></section>
    <section class="panel section"><div class="panel-heading"><h2>搬送実績</h2><span class="muted">要求・完了・未完了を区別</span></div>${table(['搬送','内容','要求','完了','未完了'],data.byKind.map(row=>['搬送'+row.kind,row.content,row.requested,row.completed,row.pending]))}</section>
    <section class="panel section"><div class="panel-heading"><h2>AGF別実績</h2><span class="muted">充電回数は実際の充電開始回数</span></div>${table(['AGF','搬送完了',...kinds.map(kind=>'搬送'+kind),'最終バッテリー','充電回数','充電時間'],data.agfs.map(agf=>[agf.id,agf.completed,...agf.byKind.map(row=>row.completed),agf.finalBatteryPct.toFixed(1)+'%',agf.chargeCount+'回',minutes(agf.chargingMs)+'分']))}
    <p class="method-note">AGF別完了数の合計＝搬送01～05の完了数合計＝総搬送完了数。実行終了時に搬送途中のものは完了に含めません。初期充電場所での停止は充電回数に含めません。</p></section>
    <section class="panel section"><div class="panel-heading"><h2>未完了搬送</h2><span class="badge">${data.pending}件</span></div>${data.pendingTasks.length?table(['搬送','搬送元','搬送先','AGF','状態','未完了理由'],data.pendingTasks.map(task=>['搬送'+task.kind,task.origin,task.destination,task.agfId,'未完了',task.reason])):'<p class="notice">未完了搬送はありません。</p>'}
    <p class="method-note">包装機入口待ち時間：4台合計 ${minutes(data.wrapperInputWaitMs)}分。荷受け位置で包装機の空き・予約解放を待つ時間です。</p></section>
    <details class="panel section customer-time"><summary>稼働時間内訳</summary><p class="method-note">単位：分。移動・荷役・旋回・各待ち・充電を重複なく分類します。表示端数は各AGFの合計が実行時間と一致するよう調整します。</p>${table(['AGF',...data.agfs[0]?.timeGroups.map(group=>group.label)??[]],data.agfs.map(agf=>[agf.id,...agf.timeGroups.map(group=>group.minutes.toFixed(1))]))}</details>`;
}

export function renderCustomerComparison(runs){
  const data=runs.map(run=>customerRunSummary(run)),differences=customerConditionDifferences(runs);
  return `<section class="panel"><div class="panel-heading"><h2>条件の違い</h2><span class="muted">各結果に保存された実行条件を比較</span></div>${differences.length?table(['対象','条件','結果A','結果B'],differences.map(row=>[row.target||'共通',row.label,row.left+(row.unit?' '+row.unit:''),row.right+(row.unit?' '+row.unit:'')])):'<p class="notice">保存された条件は同じです。</p>'}</section>
    <div class="comparison-grid">${runs.map((run,i)=>`<section class="panel strategy-panel"><h2>結果${i===0?'A':'B'} · ${selectionLabel(run.scenario.mode)}</h2><div class="strategy-kpis">${card('搬送完了',data[i].completed,'件','success')+card('未完了搬送',data[i].pending,'件','warning')}</div>${table(['搬送','完了','未完了'],data[i].byKind.map(row=>['搬送'+row.kind,row.completed,row.pending]))}</section>`).join('')}</div>`;
}
