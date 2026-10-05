import {escapeHtml as esc} from './format.mjs';
import {warehouseRowOwner} from '../core/warehouse-policy.mjs';

const lineNames=['GWI','GWII','GWIII','GWIV','GWV','GWVI','GWVII','GWVIII'];
const variants=[['normal','full','普通満載'],['normal','partial','普通端数'],['special','full','特注満載'],['special','partial','特注端数']];
const categories={RUN:'Run情報・根拠区分',EQUIPMENT:'設備の初期状態',AGF:'AGF選定・初期配置・待機',
  PRODUCTION:'8系列の生産条件',WRAPPER:'包装機',TIMING:'時間設定',GRAPH:'走行モデル',GRAPH_EDGE:'区間距離・接続',
  GRAPH_SPEED:'区間ごとの速度',GRAPH_NODE:'個別停止点・荷役姿勢占有',AVOIDANCE_PLAN:'明示された合成退避経路',
  CHARGING:'充電器・充電場所',BATTERY:'バッテリー・充電条件',MAGAZINE:'空パレットマガジン',
  ALIGNER:'整列機の初期状態',WAREHOUSE:'倉庫の系列割当',MOTION_CONTROL:'停止旋回・荷役姿勢',
  INPUTS:'手動操作・入力イベント',REPRODUCIBILITY:'再現用Scenario'};
const evidenceNames={'user-confirmed':'ユーザー確認済み','user-confirmed-initial-placement':'ユーザー確認済みの初期配置',
  'user-confirmed-shared-priority':'ユーザー確認済みの共通待機順位','synthetic':'合成値','synthetic-assumption':'合成モデルの仮定',
  'scenario-assumption':'Scenarioの設定・仮定','explicit-scenario-setting':'明示設定',
  'provisional-derived':'暫定値・カタログ値から導出（停止旋回の実測値ではありません）','provisional-simulation':'暫定シミュレーション値',
  'supplier-assumption-user-relayed':'供給元の想定（ユーザー共有）','legacy-ready-derived-model':'旧readyからのモデル換算',
  'implementation-default':'旧モデルの既定値','unresolved':'未確定','unconfigured':'未設定','saved-run':'保存済みRun',
  'deterministic-model-tie-break':'再現性のためのモデル上の同率処理',
  'synthetic-model-tiebreak':'合成モデル限定の同率処理',
  'user-confirmed-neutral-start':'ユーザー確認済みのニュートラル初期状態',
  'user-confirmed-driving-and-handling':'ユーザー確認済み（走行・荷役）',
  'theoretical-pallet-discharge-100pct':'設備能力100%の理論タクト','synthetic-phases':'初回ずらしの合成仮定',
  'synthetic-intervals':'合成の搬出間隔','unreviewed':'未レビュー','legacy-model':'旧モデルの再現用',
  'private-dxf-proportions-provisional':'非公開図面の相対寸法に基づく暫定モデル・縮尺未校正',
  'legacy-per-task':'旧タスク単位の再現用'};
const labels={id:'Run ID',executedAt:'実行日時',durationMin:'実行時間（分）',durationMs:'実行時間（ms）',preset:'Scenario名 / preset',
  motionModel:'走行モデル',physicalEtaAllowed:'実測ETAとしての使用',initialPosition:'初期位置',initialArea:'初期エリア',
  initialBatteryPct:'初期バッテリー（%）',initialStatus:'初期状態',bufferCapacity:'製品バッファ容量（PL/系列）',
  inputCapacity:'投入容量（PL）',outputCapacity:'出口容量（PL）',inboundAgfLimit:'投入側へ割当可能なAGF上限（台）',
  conveyorCapacity:'内部コンベア保持容量（PL・処理中を含む）',
  initialQuantity:'初期枚数',capacity:'設定上限（枚）',trigger:'補充必要となる残数（枚）',refillBatch:'補充量（枚）',
  magazineEmptyRecoveryPolicy:'0枚停止後の再開方式',intervalMin:'搬出間隔（分）',offsetMin:'初回ずらし（分）',magazineId:'使用マガジン',
  destinationAreaPriority:'目的地エリア優先',batteryOrder:'バッテリー選定順',eligibility:'選定対象の条件',tieBreak:'同率時の処理',
  fallback:'目的地エリアに候補がない場合',consumptionModel:'消費モデル',activeReferenceMin:'基準稼働時間（分）',
  activeReferenceConsumptionPct:'基準時間での消費（ポイント）',reservePct:'搬送選定の残量下限（%）',chargeStartPct:'充電開始閾値（%）',
  chargeTargetPct:'充電終了閾値（%）',chargeMinPerPct:'1ポイントの充電時間（分）',consumptionPct:'旧タスク単位消費（ポイント）',
  emptyMin:'空走の固定時間（分）',loadedMin:'積載走行の固定時間（分）',pickupMin:'荷受け（分）',dropoffMin:'荷下ろし（分）',
  wrapMin:'包装（分）',labelMin:'ラベル（分）',exitMin:'出口移送（分）',chargeTravelMin:'充電場所までの固定移動（分）',
  distanceMm:'合成モデル距離（mm）',fromNodeId:'始点',toNodeId:'終点',accessScopes:'搬送・動作の通行対象',block:'ブロック',row:'行',
  coordinateUnit:'モデル座標の単位',metricLayoutProfile:'このRunの縮尺プロファイル・根拠',displayPath:'Runのmm経路点（旧入力は描画座標）',
  owner:'系列・用途',rowPriority:'同用途内の行優先順位',theoreticalPL:'理論容量（PL）',assignedPL:'割当済み行の容量（PL）',
  turnRateDegPerSec:'旋回角速度（deg/s）',turnRateEvidence:'旋回角速度の根拠',turningConsumesBattery:'旋回時間を消費対象に含める',
  turningBatteryEvidence:'旋回の電池消費対象の根拠',avoidanceTieBreakPolicy:'同状態の回避候補タイブレーク',
  turnRateDerivation:'等価旋回角速度の導出条件',
  noOvertakingGroupId:'追越禁止の通行グループ',noOvertakingForwardDirection:'グループの順方向',
  interfaceId:'対象設備',kind:'停止点の種別',handlingGroupId:'設備前通路グループ',handlingResourceIds:'姿勢移行の占有対象',
  occupancyResourceIds:'占有対象',outboundEdgeIds:'明示退避経路の区間順',returnEdgeIds:'明示復帰経路の区間順',
  pickupPositioningMin:'荷受け姿勢への移行（分）',pickupForkInsertedMin:'フォーク挿入後の荷受け（分）',
  dropoffPositioningMin:'荷下ろし姿勢への移行（分）',dropoffForkInsertedMin:'フォーク挿入後の荷下ろし（分）',handlingEvidence:'荷役相時間の根拠'};
const ownerOf=warehouseRowOwner;

/** Pure projection of saved run.scenario; no input form or current clock is read. */
export function buildRunConditions(run,{runId=run.runId??null,executedAt=run.executedAt??null}={}){
  const s=run.scenario,rows=[];
  if(!s)throw new Error('Saved run.scenario is required for simulation conditions');
  const evidence=(field,otherwise='scenario-assumption')=>s.evidence?.[field]??otherwise;
  const add=(category,key,subkey,value,source,label='')=>rows.push({category,key,subkey,value:value===undefined?null:
    value!==null&&typeof value==='object'?structuredClone(value):value,
    evidence:source??'scenario-assumption',label});
  const graph=s.motionModel==='synthetic_graph';
  for(const [key,value] of Object.entries({id:runId,executedAt,durationMin:s.durationMin,
    durationMs:Number.isFinite(s.durationMin)?Math.round(s.durationMin*60000):null,preset:s.preset,
    motionModel:s.motionModel??'fixed_time',physicalEtaAllowed:s.operationalTopology?.readiness?.physicalEtaAllowed??false}))
    add('RUN',key,'',value,key==='physicalEtaAllowed'?(graph?'synthetic-assumption':'scenario-assumption'):'saved-run');
  for(const [key,value] of Object.entries(s.evidence??{}))add('RUN','evidence',key,value,value);
  add('EQUIPMENT','palletizer','bufferCapacity',s.lineCapacity,evidence('structure'));
  add('EQUIPMENT','temporaryPallets','initialCount',s.temporaryPallets?.length??0,evidence('inventory'));
  add('EQUIPMENT','warehouse','initialPalletCount',(s.warehouse??[]).reduce((n,slot)=>n+(slot.palletIds?.length??0),0),evidence('inventory'));
  add('EQUIPMENT','manualRequests','initialCount',s.manualRequests?.filter(e=>e.timeMs===0).length??0,evidence('inventory'));
  add('AGF','mode','',s.mode,'saved-run','選定方式');
  add('AGF','selection','destinationAreaPriority',s.mode==='area_first','user-confirmed');
  add('AGF','selection','batteryOrder','ascending','user-confirmed');
  add('AGF','selection','eligibility',s.postTaskPolicy?
    '(idle || dispatch_pending) && !blocked && batteryPct > reservePct && batteryPct > chargeStartPct':
    'idle && !blocked && batteryPct > reservePct','user-confirmed');
  add('AGF','selection','tieBreak','AGF ID ascending','deterministic-model-tie-break');
  add('AGF','selection','fallback',s.fallback??'wait',s.fallback===undefined?'implementation-default':evidence('fallback'));
  const waiting=s.postTaskPolicy?.waitingPriority;
  if(waiting?.length)waiting.forEach((id,i)=>add('AGF','waitingPriority',String(i+1),id,s.postTaskPolicy.evidence,'共通待機順位 '+(i+1)));
  else add('AGF','waitingPriority','',null,'unconfigured','通常待機場所の優先順位');
  for(const a of s.agfs??[]){
    add('AGF',a.id,'initialPosition',a.currentNodeId,s.initialParking?.evidence??evidence('coordinates','unreviewed'));
    add('AGF',a.id,'initialArea',a.area,evidence('inventory'));
    add('AGF',a.id,'initialBatteryPct',a.batteryPct,evidence('battery'));
    add('AGF',a.id,'initialStatus',a.status??'idle',a.status===undefined?'implementation-default':evidence('inventory'));
  }
  add('CHARGING','chargers','count',s.chargerIds?.length??null,evidence('structure'));
  (s.chargerIds??[]).forEach((id,i)=>add('CHARGING','charger',String(i+1),id,evidence('structure'),'充電器 '+(i+1)));
  (s.chargePlaceIds??[]).forEach((id,i)=>add('CHARGING','chargePlace',String(i+1),id,s.initialParking?.evidence??evidence('coordinates'),'充電停止位置 '+(i+1)));
  for(const [key,value] of Object.entries(s.battery??{}))add('BATTERY','settings',key,value,
    ['activeReferenceMin','activeReferenceConsumptionPct','consumptionModel'].includes(key)?evidence('batteryConsumption'):evidence('battery'));
  if(s.evidence?.batteryScope)add('BATTERY','settings','scope',s.evidence.batteryScope,s.evidence.batteryScope,'消費対象の稼働時間');
  for(const [key,value] of Object.entries(s.wrapper??{}))add('WRAPPER','settings',key,value,key==='inboundAgfLimit'?evidence('timing'):evidence('structure'));
  for(const [key,value] of Object.entries(s.times??{})){
    const unused=graph&&['emptyMin','loadedMin','chargeTravelMin'].includes(key);
    const phased=graph&&s.motionControl&&['pickupPositioningMin','pickupForkInsertedMin','dropoffPositioningMin','dropoffForkInsertedMin'].some(key=>Object.hasOwn(s.motionControl,key));
    add('TIMING','settings',key,value,evidence('timing'),(labels[key]??key)+(unused||phased&&['pickupMin','dropoffMin'].includes(key)?'（graph Runでは未使用）':''));
  }
  if(graph){
    const control=s.motionControl??{};
    for(const key of ['turnRateDegPerSec','turnRateEvidence','turnRateDerivation','turningConsumesBattery','turningBatteryEvidence','avoidanceTieBreakPolicy','pickupPositioningMin',
      'pickupForkInsertedMin','dropoffPositioningMin','dropoffForkInsertedMin','handlingEvidence']){
      const value=control[key];
      const source=['turningConsumesBattery','turningBatteryEvidence'].includes(key)?(typeof control.turningConsumesBattery==='boolean'?control.turningBatteryEvidence??'explicit-scenario-setting':'unresolved'):
        key==='avoidanceTieBreakPolicy'?value?.evidence??'unresolved':
        key.startsWith('turnRate')?control.turnRateEvidence??'unresolved':control.handlingEvidence??'unresolved';
      add('MOTION_CONTROL','settings',key,value,source);
    }
  }
  add('PRODUCTION','settings','source',s.productionEvents?'explicit-events':s.productStreams?'product-streams':'line-intervals',evidence('production'));
  add('PRODUCTION','settings','model',s.productionModel??'legacy_external_pallets',s.productionModel===undefined?'legacy-model':evidence('production'));
  if(s.lineMagazineMapPolicy)add('PRODUCTION','settings','lineMagazineMapPolicy',s.lineMagazineMapPolicy,evidence('lineMagazineMap'),'系列・マガジン対応の固定方針');
  for(let i=0;i<8;i++){
    const id='L'+(i+1),streams=s.productStreams?.filter(stream=>stream.sourceLineId===id),normal=streams?.find(stream=>stream.productType==='normal'&&stream.loadType==='full');
    add('PRODUCTION',id,'intervalMin',normal?.intervalMin??s.lineIntervalsMin?.[i],evidence('production'),lineNames[i]+' 搬出間隔（分）');
    add('PRODUCTION',id,'offsetMin',normal?.startOffsetMin??s.lineStartOffsetsMin?.[i],evidence('productionOffsets'),lineNames[i]+' 初回ずらし（分）');
    add('PRODUCTION',id,'magazineId',s.lineMagazineMap?.[id],s.lineMagazineMap?.[id]?evidence('lineMagazineMap'):'unconfigured',lineNames[i]+' 使用マガジン');
    for(const [type,load,label] of variants){
      const stream=streams?.find(stream=>stream.productType===type&&stream.loadType===load),variant=type+'-'+load;
      const legacyEnabled=type==='normal'&&load==='full'&&(s.lineIntervalsMin?.[i]??0)>0;
      add('PRODUCTION',id,variant+'.enabled',streams?stream?.enabled:legacyEnabled,evidence('production'),lineNames[i]+' '+label+' ON/OFF');
      if(stream){
        add('PRODUCTION',id,variant+'.intervalMin',stream.intervalMin,evidence('production'),lineNames[i]+' '+label+' 間隔（分）');
        add('PRODUCTION',id,variant+'.offsetMin',stream.startOffsetMin,evidence('productionOffsets'),lineNames[i]+' '+label+' ずらし（分）');
      }
    }
  }
  add('MAGAZINE','settings','magazineEmptyRecoveryPolicy',s.magazineEmptyRecoveryPolicy,
    s.magazineEmptyRecoveryPolicy?evidence('magazineEmptyRecoveryPolicy'):'unconfigured');
  for(const m of s.magazines??[]){
    add('MAGAZINE',m.id,'initialQuantity',m.quantity,evidence('inventory'));
    for(const key of ['capacity','trigger','refillBatch','permission'])add('MAGAZINE',m.id,key,m[key],evidence(key==='capacity'?'magazineCapacity':'structure'));
  }
  for(const a of s.aligners??[]){
    const legacy=a.quantity===undefined&&typeof a.ready==='boolean';
    add('ALIGNER',a.id,'initialQuantity',legacy?(a.ready?10:0):a.quantity,legacy?'legacy-ready-derived-model':evidence('inventory'));
  }
  if(graph){
    const topology=s.operationalTopology;
    for(const key of ['graphId','revision','coordinateSystem','coordinateUnit','datasetKind','readiness','metricLayoutProfile'])add('GRAPH','settings',key,topology?.[key],topology?.metricLayoutProfile?.evidence??topology?.evidence??'synthetic-assumption');
    for(const edge of topology?.edges??[]){
      for(const key of ['fromNodeId','toNodeId','distanceMm','displayPath','accessScopes','lanePolicy','lanes','occupancyResourceIds','shutterId','noOvertakingGroupId','noOvertakingForwardDirection'])add('GRAPH_EDGE',edge.id,key,edge[key],topology.metricLayoutProfile?.evidence??topology.evidence??'synthetic-assumption');
      for(const movement of ['empty','loaded','charge','wait'])add('GRAPH_SPEED',edge.id,movement,edge.speedMmPerSec?.[movement],topology.evidence??'synthetic-assumption',
        edge.id+' '+({empty:'空走',loaded:'積載',charge:'充電移動',wait:'待機場所へ復帰'})[movement]+'（mm/s）');
    }
    for(const node of topology?.nodes??[])for(const key of ['x','y','interfaceId','kind','handlingGroupId','handlingResourceIds','occupancyResourceIds'])
      if(node[key]!==undefined)add('GRAPH_NODE',node.id,key,node[key],node.evidence??topology.evidence??'synthetic-assumption');
    for(const plan of topology?.avoidancePlans??[])for(const [key,value] of Object.entries(plan))
      add('AVOIDANCE_PLAN',plan.id,key,value,plan.evidence??'unresolved');
  }
  const warehouseRows=new Map(),assignments=new Map((s.warehousePolicy?.rowAssignments??[]).map(a=>[a.rowId,a]));
  for(const slot of s.warehouse??[])if(slot.rowId)warehouseRows.set(slot.rowId,{block:slot.blockId,row:slot.row});
  add('WAREHOUSE','capacity','theoreticalPL',(s.warehouse??[]).reduce((n,slot)=>n+(slot.capacity??1),0),evidence('structure'));
  add('WAREHOUSE','capacity','assignedPL',s.warehousePolicy?(s.warehouse??[]).filter(slot=>ownerOf(assignments.get(slot.rowId))!=='UNASSIGNED').reduce((n,slot)=>n+(slot.capacity??1),0):null,s.warehousePolicy?.evidence??'unconfigured');
  for(const [rowId,row] of [...warehouseRows].sort(([a],[b])=>a.localeCompare(b,'en'))){
    const owner=ownerOf(assignments.get(rowId)),priority=s.warehousePolicy?.rowPriority?.[owner]?.indexOf(rowId);
    for(const [key,value] of Object.entries({...row,owner,rowPriority:priority===undefined||priority<0?null:priority+1}))add('WAREHOUSE',rowId,key,value,s.warehousePolicy?.evidence??'unconfigured');
  }
  for(const key of ['productionEvents','manualRequests','alignerRefillEvents','magazineUses','alignerReadyEvents','permissionEvents','shutterEvents','interferenceEvents']){
    const events=s[key];if(events===undefined)continue;
    add('INPUTS',key,'count',events.length,'saved-run',key+' 件数');
    events.forEach((event,i)=>add('INPUTS',key,String(i+1),event,'saved-run'));
  }
  // Exact saved input accompanies readable rows to retain every reproducibility setting.
  add('REPRODUCIBILITY','scenarioJson','',JSON.stringify(s),'saved-run','保存済みScenario JSON');
  return rows;
}

const displayValue=(value,row)=>{
  if(value===null)return row.category==='WAREHOUSE'&&row.subkey==='rowPriority'?'未設定／対象外':'未設定';
  if(value==='UNASSIGNED')return '未割当';
  if(/^L[1-8]$/.test(String(value)))return lineNames[Number(value.slice(1))-1]+' ('+value+')';
  if(value==='SPECIAL')return 'SPECIAL（特注）';
  if(value==='immediate_retry')return '補充直後に再試行（immediate_retry）';
  if(value==='next_takt')return '次タクトから再開（next_takt）';
  if(value==='area_first')return 'エリア優先あり（area_first）';
  if(value==='low_battery_first')return 'エリア優先なし（low_battery_first）';
  if(value==='any')return '他エリアから選定（明示設定）';
  if(value==='wait')return '候補が現れるまで待機';
  if(value==='ascending')return '残量の少ない順';
  if(typeof value==='boolean')return row.category==='PRODUCTION'?(value?'ON':'OFF'):(value?'はい':'いいえ');
  return typeof value==='object'?JSON.stringify(value):String(value);
};
export function renderRunConditions(run,context={}){
  const rows=buildRunConditions(run,context),groups=[...new Set(rows.map(r=>r.category))];
  return `<section class="panel run-conditions" aria-labelledby="run-conditions-title"><div class="panel-heading"><div><h2 id="run-conditions-title">シミュレーション条件</h2><span class="muted">保存済みRunのScenario · 未反映のフォーム変更は含みません</span></div><span class="badge">${esc(context.runId??run.runId??'Run条件')}</span></div>
    <p class="method-note">合成距離・速度・時間はモデルの仮定です。実CAD座標・実測ETAとは区別してください。未設定の対応表や再開方式は補完せず表示します。</p>
    ${groups.map(category=>{
      const items=rows.filter(r=>r.category===category);
      if(category==='REPRODUCIBILITY')return `<details class="condition-category"><summary>再現用Scenario JSON</summary><pre class="condition-json">${esc(JSON.stringify(run.scenario,null,2))}</pre></details>`;
      return `<details class="condition-category" ${category==='RUN'?'open':''}><summary>${categories[category]}<span>${items.length}項目</span></summary><div class="table-scroll"><table><thead><tr><th>対象</th><th>項目</th><th>実行時の値</th><th>根拠区分</th></tr></thead><tbody>${items.map(row=>`<tr><th scope="row">${esc(/^L[1-8]$/.test(row.key)?lineNames[Number(row.key.slice(1))-1]+' ('+row.key+')':row.key)}</th><td>${esc(row.label||labels[row.subkey]||labels[row.key]||row.subkey||row.key)}</td><td class="condition-value ${row.value===null?'condition-unset':''}">${esc(displayValue(row.value,row))}</td><td>${esc(evidenceNames[row.evidence]??row.evidence)}</td></tr>`).join('')}</tbody></table></div></details>`;
    }).join('')}</section>`;
}
