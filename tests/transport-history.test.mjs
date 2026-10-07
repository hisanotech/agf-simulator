import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTransportHistoryRows,transportHistoryCells,TRANSPORT_HISTORY_COLUMNS,renderTransportHistoryRows} from '../src/ui/transport-history.mjs';
import {transportHistoryCsv,customerCsvFilename} from '../src/ui/customer-export.mjs';

const headers=['発生時刻','履歴区分','搬送No.','搬送パターン','パレットID','系列','AGF','AGF1状態','AGF2状態','AGF3状態','AGF4状態','発生場所','状態・内容','詳細'];
function fixture(){
  const task={id:'TASK-012',kind:'01',palletId:'SIM-L2-4',sourceLineId:'L2',originId:'L2',destinationId:'WRAP-INPUT',agfId:'AGF2'};
  const events=[
    {type:'LINE_BUFFER_BLOCKED',timeMs:1200000,sequence:3,lineId:'L2',plannedPalletId:'SIM-L2-5',quantityBefore:3,quantityAfter:3,capacity:3,blockedSinceMs:1200000},
    {type:'TASK_PICKED',timeMs:2100000,sequence:5,taskId:task.id,kind:'01',palletId:task.palletId,agfId:'AGF2',lineId:'L2',quantityBefore:3,quantityAfter:2},
    {type:'LINE_BUFFER_RELEASED',timeMs:2100000,sequence:6,lineId:'L2',plannedPalletId:'SIM-L2-5',quantityBefore:3,quantityAfter:2,capacity:3},
    {type:'PRODUCTION_RESUMED_FROM_BUFFER',timeMs:2100000,sequence:7,lineId:'L2',plannedPalletId:'SIM-L2-5',palletId:'SIM-L2-5',quantityBefore:2,quantityAfter:3,capacity:3,waitMs:900000},
    {type:'TASK_REQUESTED',timeMs:2100000,sequence:8,taskId:'TASK-013',kind:'01',palletId:'SIM-L2-5'},
    {type:'SEGMENT_ENTERED',timeMs:2100000,sequence:9,taskId:task.id,agfId:'AGF2',edgeId:'PRIVATE-INTERNAL-EDGE'},
    {type:'SHUTTER_WAITING',timeMs:2100000,sequence:10,taskId:task.id,agfId:'AGF2',reason:'SHUTTER',shutterId:'SYN-TEST'},
    {type:'SEGMENT_EXITED',timeMs:2110000,sequence:11,taskId:task.id,agfId:'AGF2',edgeId:'PRIVATE-INTERNAL-EDGE'}
  ];
  const queued={...task,id:'TASK-013',palletId:'SIM-L2-5',agfId:null};
  return {runId:'SYNTHETIC-HISTORY',scenario:{durationMin:40,lineCapacity:3,battery:{chargeTargetPct:80}},events,
    snapshots:events.map(()=>({tasks:[task,queued],agfs:[{id:'AGF2',batteryPct:72.3}],pallets:[{palletId:'SIM-L2-5',sourceLineId:'L2'}]})),final:{tasks:[task,queued]}};
}
test('transport history has exactly fourteen Japanese business columns shared with customer CSV',()=>{
  const run=fixture(),rows=buildTransportHistoryRows(run),csv=transportHistoryCsv(run);
  assert.deepEqual(TRANSPORT_HISTORY_COLUMNS,headers);
  assert.ok(csv.startsWith('\ufeff'));
  assert.equal(csv.slice(1).split('\r\n')[0],headers.join(','));
  assert.deepEqual(csv.slice(1).split('\r\n').slice(1).map(row=>row.split(',')),rows.map(transportHistoryCells));
  assert.equal(customerCsvFilename(run,'history'),'SYNTHETIC-HISTORY-搬送履歴.csv');
});
test('buffer stop release resume and transport follow the same planned pallet with saved sequence ordering',()=>{
  const run=fixture(),pairs=run.events.map((event,index)=>({event,snapshot:run.snapshots[index]})).reverse();
  run.events=pairs.map(pair=>pair.event);run.snapshots=pairs.map(pair=>pair.snapshot);
  const rows=buildTransportHistoryRows(run),stopped=rows.find(row=>row.type==='LINE_BUFFER_BLOCKED');
  assert.deepEqual(rows.map(row=>row.sequence),[3,5,6,7,8,10]);
  assert.deepEqual(transportHistoryCells(stopped),['00:20:00','生産停止','－','－','SIM-L2-5','L2','－','－','－','－','－','系列2','系列バッファ満杯・生産停止','系列バッファ空き待ち / 3/3 PL']);
  assert.equal(Object.hasOwn(stopped,'reason'),false);
  assert.equal(rows.find(row=>row.type==='TASK_PICKED').detail,'バッファ 3→2 PL');
  assert.equal(rows.find(row=>row.type==='LINE_BUFFER_RELEASED').detail,'3→2 PL');
  assert.equal(rows.find(row=>row.type==='PRODUCTION_RESUMED_FROM_BUFFER').detail,'バッファ空き / 停止15.0分 / 2→3 PL');
  assert.ok(rows.every(row=>row.agfStates.every(state=>state==='－')));
  assert.equal(rows.find(row=>row.type==='TASK_REQUESTED').palletId,stopped.palletId);
  assert.equal(rows.find(row=>row.type==='TASK_PICKED').agfId,'AGF2');
});
test('history filters use saved task assignment and never invent a task or expose developer events',()=>{
  const run=fixture(),before=JSON.stringify(run),rows=buildTransportHistoryRows(run);
  assert.equal(rows.find(row=>row.type==='TASK_REQUESTED').agfId,'－');
  assert.equal(buildTransportHistoryRows(run,{timeMs:1200000}).length,1);
  assert.deepEqual(buildTransportHistoryRows(run,{agfId:'AGF2'}).map(row=>row.type),['TASK_PICKED','SHUTTER_WAITING']);
  assert.deepEqual(buildTransportHistoryRows(run,{taskId:'task-012'}).map(row=>row.type),['TASK_PICKED','SHUTTER_WAITING']);
  const html=renderTransportHistoryRows(rows);
  assert.equal((html.split('</tr>')[0].match(/<td\b/g)??[]).length,14);
  assert.doesNotMatch(html,/SEGMENT_ENTERED|PRIVATE-INTERNAL-EDGE|LINE_BUFFER_BLOCKED|SHUTTER_WAITING/);
  assert.equal(JSON.stringify(run),before);
});
test('assignment storage charging and handling rows use business locations quantities and Japanese categories',()=>{
  const run=fixture();
  run.events=[{type:'TASK_ASSIGNED',timeMs:0,sequence:0,taskId:'TASK-012',agfId:'AGF2'},
    {type:'TASK_POSITIONING_STARTED',timeMs:1,sequence:1,taskId:'TASK-012',agfId:'AGF2',operation:'pickup'},
    {type:'STORE_COMPLETED',timeMs:2,sequence:2,taskId:'TASK-012',agfId:'AGF2',locationId:'WB3-R05-C03-T1'},
    {type:'CHARGE_STARTED',timeMs:3,sequence:3,agfId:'AGF2',chargePlaceId:'CHARGE-PLACE1',batteryPct:39.8},
    {type:'CHARGE_ENDED',timeMs:4,sequence:4,agfId:'AGF2',batteryPct:80}];
  run.snapshots=run.events.map(()=>({tasks:run.final.tasks,agfs:[{id:'AGF2',currentNodeId:'CHARGE-PLACE1',batteryPct:72.3}]}));
  const rows=buildTransportHistoryRows(run);
  assert.equal(rows[0].detail,'－');assert.deepEqual(rows[0].agfStates,['－','－','－','－']);
  assert.equal(rows[1].content,'搬送01 荷受け開始');
  assert.equal(rows[2].location,'製品倉庫 WB3');assert.equal(rows[2].detail,'WB3-R05-C03-1段目');
  assert.equal(rows[3].location,'充電場所1');assert.equal(rows[4].detail,'39.8% → 80.0%');
  const [held]=buildTransportHistoryRows({...run,events:[{type:'TASK_02_HELD',timeMs:5,sequence:0,
    palletId:'SIM-L2-5',sourceLineId:'L2',reason:'ROW_BUSY'}],snapshots:[]});
  assert.equal(held.location,'包装機 搬出口');
  assert.equal(held.taskId,'－');assert.equal(held.agfId,'－');
});
test('existing monitor table uses fourteen-column transport history with a separate history CSV action',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),app=readFileSync(new URL('../src/ui/app.mjs',import.meta.url),'utf8');
  const table=html.match(/<section class="panel event-panel[\s\S]*?<\/section>/)?.[0];
  assert.ok(table);assert.match(table,/<h2>搬送履歴/);assert.doesNotMatch(table,/イベントログ|イベント一覧|生産イベント一覧/);
  assert.deepEqual([...table.matchAll(/<th>([^<]+)<\/th>/g)].map(match=>match[1]),headers);
  assert.match(html,/id="transport-history-csv"/);assert.match(app,/transportHistoryCsv\(result\)/);
  assert.doesNotMatch(app,/rows\.slice\(-250\)\.reverse\(\)/);
});

test('refilled production awaiting its explicit next takt is not displayed as an actual restart',()=>{
  const run=fixture();
  run.events=[{type:'PRODUCTION_RECOVERY_WAIT_NEXT_TAKT',timeMs:60000,sequence:0,
    lineId:'L2',plannedPalletId:'SIM-L2-5',reason:'WAIT_NEXT_TAKT'}];
  run.snapshots=[];
  const [row]=buildTransportHistoryRows(run);
  assert.equal(row.category,'生産停止');
  assert.equal(row.content,'空パレット補充済み・次タクト待ち');
  assert.equal(row.detail,'補充済み・次タクト待ち');assert.equal(Object.hasOwn(row,'reason'),false);
  assert.equal(row.taskId,'－');
  assert.equal(row.agfId,'－');
  assert.equal(row.palletId,'SIM-L2-5');
});
