export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const clock=ms=>{const s=Math.floor(ms/1000);return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(n=>String(n).padStart(2,'0')).join(':');};
export const minutes=ms=>(ms/60000).toFixed(1);
export const states={idle:'待機',moving_empty:'空走・荷受け',moving_loaded:'積載・荷下ろし',wait_drop:'荷下ろし待ち',
  moving_to_wait:'倉庫待機場所へ復帰',hp_wait:'倉庫内待機',dispatch_pending:'次動作判定',
  waiting_hp_instruction:'HP選択待ち',waiting_hp_capacity:'HP満杯・復帰保留',waiting_hp_route:'HP経路保留',
  handling_pickup:'荷受け',handling_dropoff:'荷下ろし',
  waiting_traffic:'交通待ち',waiting_charge:'充電待ち',moving_to_charge:'充電場所へ移動',charging:'充電中',queued:'割当待ち',completed:'完了'};
export const stateLabel=(status,graphMode=false)=>graphMode&&status==='moving_empty'?'空走':
  graphMode&&status==='moving_loaded'?'積載走行':states[status]??status;
export const taskNames={'01':'製品の包装投入','02':'製品の倉庫入庫','03':'空パレット補充','04':'仮置きから再投入','05':'仮置きから入庫'};
export const reasons={LOCATION_PERMISSION:'入庫許可なし',SAME_ROW_ACTIVE:'同じ行の置きタスク完了待ち',LOCATION_FULL_OR_RESERVED:'入庫先が満杯または予約済み',
  NO_ASSIGNED_STORAGE:'対象用途の行なし',ROW_PRIORITY_UNRESOLVED:'同用途の行優先順位が未設定',ASSIGNED_STORAGE_FULL:'対象系列／特注領域が満杯',
  HP_TARGET_UNRESOLVED:'復帰先が未設定',HP_CAPACITY_UNRESOLVED:'待機場所の占有・予約の解放待ち',UNREACHABLE_WAIT_ROUTE:'倉庫待機場所への経路が到達不能',
  WRAPPER_INPUT_FULL:'包装機の投入空き待ち',WRAPPER_INBOUND_LIMIT:'包装投入への同時AGF割当が上限（合成条件）',NO_ELIGIBLE_AGF:'実行可能AGF待ち',NO_AREA_AGF:'目的地エリアのAGF待ち',ALIGNER_NOT_READY:'整列機の搬送OK待ち',
  NO_READY_ALIGNER:'整列機の搬送OK待ち',MAGAZINE_PERMISSION:'マガジン許可待ち',UNREACHABLE_ROUTE:'合成グラフ上で到達不能',
  UNREACHABLE_CHARGE_ROUTE:'充電経路へ到達不能',CHARGE_PLACE_OCCUPIED:'充電停止位置の解放待ち',OCCUPIED:'区間・交差点の解放待ち',SHUTTER:'シャッター許可待ち'};
export const eventNames={RUN_STARTED:'シミュレーション開始',RUN_ENDED:'シミュレーション終了',TASK_PICKED:'荷受け完了',TASK_DROPPED:'荷下ろし完了',CHARGE_ENDED:'充電完了',
  MANUAL_TASK_RESERVED:'手動搬送予約',MAGAZINE_REFILL_REQUESTED:'空PL補充要求',WRAP_OUTPUT_BLOCKED:'包装機出口待ち',
  SIMULATION_STARTED:'シミュレーション開始',PALLET_EXITED:'系列から搬出',TASK_REQUESTED:'搬送要求',TASK_ASSIGNED:'AGF割当',
  TASK_WAITING:'搬送保留',TASK_02_HELD:'02発行保留',PICKUP_COMPLETED:'荷受け完了',TASK_COMPLETED:'搬送完了',
  STORE_COMPLETED:'入庫完了',WRAP_STARTED:'包装開始',WRAP_COMPLETED:'包装完了',LABEL_COMPLETED:'ラベル完了',EXIT_READY:'回収可能',
  CHARGE_REQUESTED:'充電移動開始',CHARGE_ARRIVED:'充電場所到着',CHARGE_STARTED:'充電開始',CHARGE_COMPLETED:'充電完了',
  CHARGE_WAITING:'充電待ち',MAGAZINE_USED:'空PL使用',ALIGNER_READY:'整列機 搬送OK',MAGAZINE_REFILLED:'補充完了',SIMULATION_FINISHED:'シミュレーション終了'};
Object.assign(eventNames,{ROUTE_PLANNED:'合成経路決定',SEGMENT_WAITING:'区間進入待ち',SEGMENT_ENTERED:'区間進入',SEGMENT_EXITED:'区間退出',
  WAIT_RETURN_REQUESTED:'倉庫待機場所へ復帰開始',WAIT_RETURN_HELD:'復帰保留',WAIT_ARRIVED:'倉庫待機場所に到着',CHARGER_RELEASED:'充電器解放',PARKING_RELEASED:'停止位置解放',
  WAREHOUSE_LOCATION_RESERVED:'倉庫配置先予約',
  EQUIPMENT_PERMISSION_CHANGED:'設備受入許可変更',
  ROUTE_COMPLETED:'合成経路到着',SHUTTER_WAITING:'シャッター前停止',SHUTTER_STATE_CHANGED:'シャッター許可変更',
  TRAFFIC_WAIT_ENDED:'交通待ち解除',DEADLOCK_DETECTED:'デッドロック検出',CHARGE_ROUTE_WAITING:'充電経路保留'});
export const areaName=id=>id==='PZ'?'パレタイズ':id==='WH'?'製品倉庫':id;
export const locationName=id=>({ 'WRAP-INPUT':'包装機 投入','WRAP-OUTPUT':'包装機 回収',OT1:'仮置き1',OT2:'仮置き2',OT3:'仮置き3',
  'PILLAR-WAIT-W':'柱前西','PILLAR-WAIT-E':'柱前東',
  CHARGER1:'充電器1',CHARGER2:'充電器2','CHARGE-PLACE1':'充電場所1','CHARGE-PLACE2':'充電場所2'}[id]??(/^L\d$/.test(id??'')?'系列'+id.slice(1):/^M\d$/.test(id??'')?'マガジン'+id.slice(1):/^AL\d$/.test(id??'')?'整列機'+id.slice(2):id??'—'));
export const productLabel=p=>p?.productType&&p?.loadType?
  `${p.sourceLineId??'系列未取得'} / ${p.productType==='special'?'特注':'普通'}・${p.loadType==='partial'?'端数':'満載'}`:'属性未取得';
export const badge=(status,label=states[status]??status)=>`<span class="badge state-${escapeHtml(status)}"><span aria-hidden="true">${status==='completed'?'✓':status.includes('wait')||status==='queued'?'◷':status==='charging'?'ϟ':'●'}</span> ${escapeHtml(label)}</span>`;
