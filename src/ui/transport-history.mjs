import {clock,escapeHtml as esc,reasons,states} from './format.mjs';

export const TRANSPORT_HISTORY_COLUMNS=Object.freeze(['発生時刻','履歴区分','搬送No.','搬送パターン','パレットID','系列','AGF','AGF1状態','AGF2状態','AGF3状態','AGF4状態','発生場所','状態・内容','詳細']);
const dash='－';
// Only business transitions belong in the normal history. Route geometry,
// segment entry/exit, node passage and resource bookkeeping remain in the
// existing developer event CSV; they are deliberately absent from this list.
const businessEvents={
  RUN_STARTED:['実行','シミュレーション開始'],RUN_ENDED:['実行','シミュレーション終了'],
  PRODUCTION_DUE:['生産','生産タイミング到来'],EMPTY_PALLET_DISCHARGED:['生産','空パレット払い出し'],
  PALLETIZED:['生産','製品パレット化'],PALLET_EXITED:['生産','系列から製品搬出'],
  LINE_BUFFER_BLOCKED:['生産停止','系列バッファ満杯・生産停止'],
  LINE_BUFFER_RELEASED:['バッファ解放','系列バッファ空き発生'],
  PRODUCTION_RESUMED_FROM_BUFFER:['生産再開','系列バッファ待ち生産再開'],
  PRODUCTION_BLOCKED_EMPTY_PALLET:['生産停止','空パレット待ち・生産停止'],
  PRODUCTION_BLOCKED_RECOVERY_POLICY:['生産停止','再開方式未設定・生産保留'],
  PRODUCTION_RECOVERY_UNRESOLVED:['生産停止','再開方式未設定・生産保留'],
  PRODUCTION_RETRY_WAITING_BUFFER:['生産停止','系列バッファ空き待ち'],
  PRODUCTION_RECOVERY_WAIT_NEXT_TAKT:['生産停止','空パレット補充済み・次タクト待ち'],
  TASK_REQUESTED:['搬送要求','搬送要求'],MANUAL_TASK_RESERVED:['搬送要求','手動搬送予約'],
  TASK_ASSIGNED:['AGF割当','AGF割当'],TASK_POSITIONING_STARTED:['荷役','荷役開始'],
  TASK_PICKED:['荷受け','荷受け完了'],PICKUP_COMPLETED:['荷受け','荷受け完了'],
  TASK_DROPPED:['荷下ろし','荷下ろし完了'],TASK_COMPLETED:['搬送完了','搬送完了'],
  TASK_WAITING:['搬送保留','搬送保留'],TASK_02_HELD:['搬送保留','搬送02 発行保留'],
  PICKUP_PERMISSION_GRANTED:['荷受け','荷受け許可・再開'],STORE_COMPLETED:['入庫','入庫完了'],
  WRAP_STARTED:['包装','包装開始'],WRAP_COMPLETED:['包装','包装完了'],
  LABEL_COMPLETED:['包装','ラベル完了'],EXIT_READY:['包装','包装機出口・回収可能'],
  WRAP_OUTPUT_BLOCKED:['搬送保留','包装機出口待ち'],WRAPPER_EXIT_WAITING:['搬送保留','包装機出口待ち'],
  WRAPPER_INPUT_WAITING:['搬送保留','包装機入口待ち'],WRAPPER_INPUT_WAIT_ENDED:['搬送保留','包装機入口待ち解除'],
  WRAPPER_DEPARTURE_WAITING:['搬送保留','包装機入口への出発待ち'],
  WRAPPER_CONVEYOR_ACCEPTED:['包装','包装機内部へ受渡し'],
  SEGMENT_WAITING:['搬送保留','交通待ち'],SHUTTER_WAITING:['搬送保留','シャッター前停止'],
  TRAFFIC_WAIT_ENDED:['搬送保留','交通待ち解除'],MOTION_CONFIGURATION_WAITING:['搬送保留','走行・荷役設定待ち'],
  HANDLING_RESOURCE_WAITING:['搬送保留','設備前の姿勢移行待ち'],
  DEADLOCK_DETECTED:['搬送保留','交通の相互待ちを検出'],
  INTERFERENCE_DETECTED:['搬送保留','干渉を検出'],INTERFERENCE_DEFERRED:['搬送保留','干渉判断待ち'],
  AVOIDANCE_STARTED:['交通','干渉回避開始'],AVOIDANCE_COMPLETED:['交通','干渉回避完了'],
  AVOIDANCE_UNAVAILABLE:['搬送保留','退避経路の確認待ち'],AVOIDANCE_TIE_UNRESOLVED:['搬送保留','回避側の判断待ち'],
  OVERTAKING_WAITING:['搬送保留','包装機入口待ちAGFの横通過待ち'],
  OVERTAKING_STARTED:['交通','包装機入口待ちAGFの横通過開始'],OVERTAKING_COMPLETED:['交通','横通過・正規レーンへの復帰完了'],
  CHARGE_REQUESTED:['充電','充電要求'],CHARGE_ARRIVED:['充電','充電場所到着'],CHARGE_WAITING:['充電','充電待ち'],
  CHARGE_STARTED:['充電','充電開始'],CHARGE_ENDED:['充電','充電完了'],CHARGE_COMPLETED:['充電','充電完了'],
  CHARGE_ROUTE_WAITING:['充電','充電経路の確認待ち'],
  WAIT_RETURN_REQUESTED:['待機','倉庫待機場所へ復帰開始'],WAIT_RETURN_HELD:['搬送保留','待機場所への復帰保留'],
  WAIT_ARRIVED:['待機','倉庫待機場所に到着'],
  MAGAZINE_REFILL_NEEDED:['補充','マガジン補充必要'],MAGAZINE_REFILL_REQUESTED:['補充','マガジン補充要求'],
  MAGAZINE_REFILLED:['補充','マガジン補充完了'],MAGAZINE_USED:['生産','空パレット使用'],
  ALIGNER_STACK_PICKED:['荷受け','整列機10枚荷受け'],ALIGNER_REFILL_OPERATED:['補充','整列機補充操作'],
  ALIGNER_REFILLED:['補充','整列機手動補充'],ALIGNER_READY:['補充','整列機搬送準備完了'],
  EQUIPMENT_PERMISSION_CHANGED:['設備','設備の受入許可変更'],SHUTTER_STATE_CHANGED:['設備','シャッター通行許可変更']
};
const productionTypes=new Set(Object.keys(businessEvents).filter(type=>/^(PRODUCTION|LINE_BUFFER|PALLET|EMPTY_PALLET)/.test(type)));
const warehouseSlot=/^(WB[1-3]|EB[12])-R(\d+)-C(\d+)-T([12])$/;
const hasNumber=value=>Number.isFinite(value);
const quantityChange=event=>hasNumber(event.quantityBefore)&&hasNumber(event.quantityAfter)?`${event.quantityBefore}→${event.quantityAfter} PL`:null;
const selectionArea=area=>({PZ:'パレタイズエリア',WH:'製品倉庫'})[area]??'エリア未記録';
const savedStatusLabel=status=>({idle:'待機',hp_wait:'待機',dispatch_pending:'待機',moving_empty:'搬送中',moving_loaded:'搬送中',
  moving_to_wait:'待機場所へ移動中',moving_to_charge:'充電場所へ移動中'})[String(status??'').toLowerCase()]??states[String(status??'').toLowerCase()]??
  ({error:'異常',comm_error:'通信異常',manual:'有人モード',picking:'荷受け中',dropping:'荷下ろし中'})[String(status??'').toLowerCase()]??'状態未記録';
const hasEvaluations=selection=>Array.isArray(selection?.evaluations);

function savedVehicleState(evaluation){
  let status=savedStatusLabel(evaluation.status);
  if(evaluation.blocked||evaluation.exclusionReason==='BLOCKED')status='利用不可';
  else if(['PICKUP_ROUTE_UNREACHABLE','LOADED_ROUTE_UNREACHABLE'].includes(evaluation.exclusionReason))status='利用不可（経路なし）';
  else if(evaluation.exclusionReason==='BATTERY_INVALID')status='利用不可（残量不明）';
  else if(status==='待機'&&['BATTERY_RESERVE','BATTERY_CHARGE_START'].includes(evaluation.exclusionReason))status+='（残量不足）';
  return `${status} / ${selectionArea(evaluation.area)} / ${hasNumber(evaluation.batteryPct)?evaluation.batteryPct.toFixed(1)+'%':'残量未記録'}`;
}
// Only assignment-time evaluations are authoritative; never fill missing
// states from current replay snapshots, candidates or final vehicle state.
function assignmentStates(event){
  if(!['TASK_ASSIGNED','TASK_WAITING'].includes(event.type)||!hasEvaluations(event.dispatchSelection))return Array(4).fill(dash);
  const byId=new Map(event.dispatchSelection.evaluations.map(evaluation=>[evaluation.agfId,evaluation]));
  return ['AGF1','AGF2','AGF3','AGF4'].map(id=>{
    const evaluation=byId.get(id);
    return !evaluation||event.type==='TASK_WAITING'&&evaluation.evaluationStatus!=='evaluated'?dash:savedVehicleState(evaluation);
  });
}

/** Business names never disclose a raw topology node, edge or resource ID. */
export function transportHistoryLocation(id,topology,scenario){
  if(!id)return dash;
  if(/^L[1-8]$/.test(id))return '系列'+id.slice(1);
  const pickup=/^PZ-L([1-8])-PICKUP$/.exec(id);if(pickup)return '系列'+pickup[1];
  if(/^OT[1-3]$/.test(id))return '仮置き'+id.slice(2);
  if(/^M[1-5]$/.test(id))return 'マガジン'+id.slice(1);
  if(/^AL[1-5]$/.test(id))return '整列機'+id.slice(2);
  if(/^(WB[1-3]|EB[12])(?:-|$)/.test(id))return '製品倉庫 '+id.split('-')[0];
  if(scenario?.warehouse?.some(location=>location.id===id))return '製品倉庫';
  const names={'WRAP-INPUT':'包装機 搬入口','WRAP-OUTPUT':'包装機 搬出口',
    'CHARGE-PLACE1':'充電場所1','CHARGE-PLACE2':'充電場所2',CHARGER1:'充電器1',CHARGER2:'充電器2',
    HP1:'HP1',HP2:'HP2','PILLAR-WAIT-E':'東側柱前','PILLAR-WAIT-W':'西側柱前',PZ:'パレタイズエリア',WH:'製品倉庫'};
  if(names[id])return names[id];
  const node=topology?.nodes?.find(node=>node.id===id);
  if(node?.interfaceId&&node.interfaceId!==id)return transportHistoryLocation(node.interfaceId,null,scenario);
  return '搬送経路';
}
const reasonText=(event)=>{
  if(event.automatic===true&&['ALIGNER_REFILL_OPERATED','ALIGNER_REFILLED'].includes(event.type))return '整列機5台がすべて0枚';
  const reason=event.reason??({LINE_BUFFER_BLOCKED:'LINE_BUFFER_FULL',PRODUCTION_RETRY_WAITING_BUFFER:'LINE_BUFFER_FULL',
    PRODUCTION_BLOCKED_EMPTY_PALLET:'EMPTY_PALLET',PRODUCTION_BLOCKED_RECOVERY_POLICY:'RECOVERY_POLICY_UNSET',
    PRODUCTION_RECOVERY_UNRESOLVED:'RECOVERY_POLICY_UNSET',SHUTTER_WAITING:'SHUTTER',SEGMENT_WAITING:'OCCUPIED',
    WRAPPER_INPUT_WAITING:'WRAPPER_INPUT',WRAPPER_EXIT_WAITING:'WRAPPER_OUTPUT_FULL',WRAP_OUTPUT_BLOCKED:'WRAPPER_OUTPUT_FULL'})[event.type];
  if(event.type==='PRODUCTION_RESUMED_FROM_BUFFER')return 'バッファ空き';
  if(!reason)return event.type==='CHARGE_WAITING'?'充電器・充電場所の空き待ち':dash;
  if(reasons[reason])return reasons[reason];
  if(reason==='WRAPPER_OUTPUT_FULL')return '包装機出口の空き待ち';
  if(reason==='ALIGNER_PERMISSION')return '整列機の荷受け許可待ち';
  // Unknown internal reason codes stay available in the developer export.
  return /[ぁ-んァ-ヶ一-龯]/.test(reason)?reason:'搬送条件の確認待ち';
};
function eventLocation(event,task,agf,lineId,topology,scenario){
  const type=event.type;
  const name=id=>transportHistoryLocation(id,topology,scenario);
  if(productionTypes.has(type))return name(lineId);
  if(type==='SHUTTER_STATE_CHANGED'||type==='SHUTTER_WAITING')return 'シャッター';
  if(type==='ALIGNER_REFILL_OPERATED'&&event.operationType==='all')return '整列機 全機';
  if(type.startsWith('ALIGNER_'))return name(event.alignerId??task?.originId);
  if(type.startsWith('MAGAZINE_'))return name(event.magazineId??task?.destinationId);
  if(type.startsWith('CHARGE_'))return event.chargePlaceId||agf?.currentNodeId?name(event.chargePlaceId??agf.currentNodeId):'充電場所（停止点未設定）';
  if(type.startsWith('WAIT_'))return name(event.hpId??agf?.currentNodeId);
  if(type==='STORE_COMPLETED')return name(event.locationId??event.storageLocationId??task?.destinationId);
  if(type==='TASK_02_HELD')return '包装機 搬出口';
  if(/^(WRAP|LABEL|EXIT_READY)/.test(type))return type.includes('INPUT')||type==='WRAPPER_DEPARTURE_WAITING'?
    '包装機 搬入口':type.includes('OUTPUT')||type.includes('EXIT')||type==='EXIT_READY'?'包装機 搬出口':'包装機';
  const drop=type==='TASK_DROPPED'||type==='TASK_COMPLETED'||type==='TASK_POSITIONING_STARTED'&&event.operation==='dropoff';
  if(type.startsWith('TASK_')||type==='PICKUP_COMPLETED'||type==='MANUAL_TASK_RESERVED'||type==='PICKUP_PERMISSION_GRANTED')
    return name(drop?task?.destinationId:task?.originId??lineId);
  return name(agf?.currentNodeId??event.nodeId);
}
function details(event,{task,agf,scenario,chargeStarts}){
  const type=event.type,change=quantityChange(event);
  if(type==='TASK_ASSIGNED')return dash;
  if(event.automatic===true&&['ALIGNER_REFILL_OPERATED','ALIGNER_REFILLED'].includes(type)){
    const quantity=change?.replace(' PL',' 枚')??'全5台を各10枚へ';
    const timing=event.timingEvidence==='provisional-same-timestamp-event'?
      '装填時間未確定（同一時刻の暫定モデル）':'装填時間の根拠未記録';
    return quantity+' / '+timing;
  }
  if(type==='LINE_BUFFER_BLOCKED'||type==='PRODUCTION_RETRY_WAITING_BUFFER'){
    const quantity=event.quantityAfter??event.quantityBefore??event.quantity,capacity=event.lineCapacity??event.capacity??scenario.lineCapacity;
    return hasNumber(quantity)&&hasNumber(capacity)?`${quantity}/${capacity} PL`:dash;
  }
  if(type==='LINE_BUFFER_RELEASED')return change??dash;
  if(type==='PRODUCTION_RESUMED_FROM_BUFFER'){
    const waitMs=event.waitMs??(hasNumber(event.blockedSinceMs)?event.timeMs-event.blockedSinceMs:null);
    return [hasNumber(waitMs)?`停止${(waitMs/60000).toFixed(1)}分`:null,change].filter(Boolean).join(' / ')||dash;
  }
  if(type==='TASK_PICKED'&&change)return 'バッファ '+change;
  if(type==='STORE_COMPLETED'){
    const id=event.locationId??event.storageLocationId??task?.destinationId,slot=warehouseSlot.exec(id??'');
    return slot?`${slot[1]}-R${slot[2]}-C${slot[3]}-${slot[4]}段目`:dash;
  }
  if(type==='CHARGE_STARTED')return hasNumber(event.batteryPct)?`${event.batteryPct.toFixed(1)}% → ${scenario.battery?.chargeTargetPct?.toFixed(1)??'未設定'}%（予定）`:dash;
  if(type==='CHARGE_ENDED'||type==='CHARGE_COMPLETED'){
    const start=chargeStarts.get(event.agfId),end=event.batteryPct??agf?.batteryPct;
    return hasNumber(start)&&hasNumber(end)?`${start.toFixed(1)}% → ${end.toFixed(1)}%`:hasNumber(end)?`残量${end.toFixed(1)}%`:dash;
  }
  if(change)return change.replace(' PL',/^(ALIGNER|MAGAZINE|EMPTY_PALLET)/.test(type)?' 枚':' PL');
  if(hasNumber(event.quantity))return event.quantity+'枚';
  if(hasNumber(event.waitMs))return `待ち${(event.waitMs/60000).toFixed(1)}分`;
  if(type==='TASK_COMPLETED'&&task?.destinationId)return '搬送先：'+transportHistoryLocation(task.destinationId,scenario.operationalTopology,scenario);
  if(type==='EQUIPMENT_PERMISSION_CHANGED')return event.permitted?'受入可能':'受入不可';
  if(type==='SHUTTER_STATE_CHANGED')return event.passable?'通行可能':'通行不可';
  return dash;
}

/** Pure adapter: project saved events/snapshots, preserving causal event order. */
export function buildTransportHistoryRows(run,{timeMs=Infinity,agfId='',taskId=''}={}){
  const scenario=run.scenario??{},topology=scenario.operationalTopology;
  const finalTasks=new Map((run.final?.tasks??[]).map(task=>[task.id,task])),chargeStarts=new Map();
  const ordered=(run.events??[]).map((event,index)=>({event,index})).sort((a,b)=>a.event.timeMs-b.event.timeMs||a.event.sequence-b.event.sequence||a.index-b.index);
  const rows=[];
  for(const {event,index} of ordered){
    if(event.timeMs>timeMs)break;
    const definition=businessEvents[event.type];if(!definition)continue;
    const saved=run.snapshots?.[index],task=saved?.tasks?.find(task=>task.id===event.taskId)??finalTasks.get(event.taskId);
    const preTask=productionTypes.has(event.type),eventTaskId=preTask?null:event.taskId;
    const assigned=preTask?null:event.type==='TASK_ASSIGNED'?event.agfId??event.dispatchSelection?.selectedAgfId??null:
      event.type==='TASK_WAITING'&&hasEvaluations(event.dispatchSelection)?
      event.dispatchSelection.selectedAgfId:event.agfId??(event.type==='TASK_REQUESTED'?null:task?.agfId);
    const agf=saved?.agfs?.find(agf=>agf.id===assigned);
    const palletId=event.palletId??event.plannedPalletId??task?.palletId??null;
    const pallet=saved?.pallets?.find(pallet=>pallet.palletId===palletId);
    const source=event.lineId??event.sourceLineId??task?.sourceLineId??pallet?.sourceLineId??pallet?.lineId??(/^L[1-8]$/.test(task?.originId??'')?task.originId:null);
    const lineId=/^L[1-8]$/.test(source??'')?source:dash;
    const kind=eventTaskId&&/^(01|02|03|04|05)$/.test(event.kind??task?.kind??'')?(event.kind??task.kind):dash;
    let [category,content]=definition;
    if(event.automatic===true&&['ALIGNER_REFILL_OPERATED','ALIGNER_REFILLED'].includes(event.type))
      content=event.type==='ALIGNER_REFILL_OPERATED'?'整列機全機自動装填':'整列機自動装填';
    if(event.type==='TASK_POSITIONING_STARTED'){
      category=event.operation==='dropoff'?'荷下ろし':'荷受け';content=category+'開始';
    }
    if(['TASK_REQUESTED','TASK_ASSIGNED','TASK_POSITIONING_STARTED','TASK_PICKED','TASK_DROPPED','TASK_COMPLETED','TASK_WAITING','PICKUP_COMPLETED'].includes(event.type)&&kind!==dash)
      content='搬送'+kind+' '+content;
    if(event.type==='CHARGE_STARTED'&&hasNumber(event.batteryPct))chargeStarts.set(event.agfId,event.batteryPct);
    const briefReason=event.type==='TASK_ASSIGNED'?dash:reasonText(event),eventDetail=details(event,{task,agf,scenario,chargeStarts});
    const detail=[...new Set([briefReason,eventDetail].filter(value=>value&&value!==dash))].join(' / ')||dash;
    const row={type:event.type,timeMs:event.timeMs,sequence:event.sequence,category,taskId:eventTaskId??dash,kind,
      palletId:palletId??dash,plannedPalletId:event.plannedPalletId??null,lineId,agfId:assigned??dash,
      agfStates:assignmentStates(event),location:eventLocation(event,task,agf,lineId===dash?null:lineId,topology,scenario),content,detail};
    if(agfId&&row.agfId!==agfId||taskId&&!String(row.taskId).toUpperCase().includes(String(taskId).toUpperCase()))continue;
    rows.push(row);
  }
  return rows;
}
export const transportHistoryCells=row=>[clock(row.timeMs),row.category,row.taskId,row.kind,row.palletId,row.lineId,row.agfId,...row.agfStates,row.location,row.content,row.detail];
export const renderTransportHistoryRows=rows=>rows.map(row=>`<tr>${transportHistoryCells(row).map((value,index)=>`<td${[0,2,3,4].includes(index)?' class="mono"':index>=7&&index<=10?' class="agf-state"':''}>${esc(value)}</td>`).join('')}</tr>`).join('');
