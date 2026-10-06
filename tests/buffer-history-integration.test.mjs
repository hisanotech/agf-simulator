import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {analyzeLineBuffers} from '../src/ui/buffer-analysis.mjs';
import {buildTransportHistoryRows,TRANSPORT_HISTORY_COLUMNS,transportHistoryCells} from '../src/ui/transport-history.mjs';
import {transportHistoryCsv} from '../src/ui/customer-export.mjs';
import {eventCsv} from '../src/ui/export.mjs';
import {reasons,eventNames} from '../src/ui/format.mjs';
import {bufferHistoryScenario} from './fixtures/buffer-history-scenario.mjs';

test('three-hour buffer recovery preserves one planned pallet through production and 01/02 transport history',()=>{
  const scenario=bufferHistoryScenario(),run=simulate(scenario),rows=buildTransportHistoryRows(run);
  assert.ok(run.events.every(e=>e.timeMs<=180*60000));
  assert.ok(run.snapshots.every(s=>s.lines.L1.length<=1));
  const blocked=run.events.find(e=>e.type==='LINE_BUFFER_BLOCKED');
  assert.ok(blocked);assert.equal(blocked.timeMs,20*60000);
  const id=blocked.plannedPalletId,resumed=run.events.find(e=>e.type==='PRODUCTION_RESUMED_FROM_BUFFER'&&e.plannedPalletId===id);
  assert.ok(resumed);assert.equal(resumed.timeMs,22*60000);
  assert.equal(resumed.palletId,id);
  const before=run.snapshots[blocked.sequence];
  assert.equal(before.pallets.some(p=>p.palletId===id),false);
  assert.equal(before.magazines.M1.quantity,99);
  const trace=rows.filter(row=>row.palletId===id);
  assert.ok(trace.some(row=>row.type==='LINE_BUFFER_BLOCKED'&&row.taskId==='－'&&row.agfId==='－'));
  assert.ok(trace.some(row=>row.type==='PRODUCTION_RESUMED_FROM_BUFFER'));
  for(const kind of ['01','02'])assert.ok(trace.some(row=>row.kind===kind&&row.type==='TASK_COMPLETED'));
  for(let index=1;index<rows.length;index++)assert.ok(rows[index].timeMs>rows[index-1].timeMs||
    rows[index].timeMs===rows[index-1].timeMs&&rows[index].sequence>rows[index-1].sequence);
  assert.deepEqual(run.events,simulate(scenario).events);
});

test('history CSV uses exactly the same eleven Japanese cells as the displayed saved Run',()=>{
  const run=simulate(bufferHistoryScenario({durationMin:60})),rows=buildTransportHistoryRows(run);
  const csv=transportHistoryCsv(run),records=csv.slice(1).split('\r\n');
  assert.ok(csv.startsWith('\ufeff'));assert.equal(records[0],TRANSPORT_HISTORY_COLUMNS.join(','));
  assert.equal(TRANSPORT_HISTORY_COLUMNS.length,11);assert.equal(records.length,rows.length+1);
  const escape=value=>{const s=String(value??'');return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
  assert.deepEqual(records.slice(1),rows.map(row=>transportHistoryCells(row).map(escape).join(',')));
  assert.equal(rows.some(row=>['SEGMENT_ENTERED','SEGMENT_EXITED','ROUTE_PLANNED'].includes(row.type)),false);
  const detailed=eventCsv(run,'BUFFER-INTEGRATION').slice(1).split('\r\n');
  assert.ok(detailed[0].includes('blockedSinceMs'));assert.ok(detailed[0].includes('lineCapacity'));
  assert.equal(reasons.LINE_BUFFER_FULL,'系列バッファ空き待ち');
  assert.equal(reasons.WAIT_NEXT_TAKT,'補充済み・次タクト待ち');
  assert.equal(eventNames.PRODUCTION_RESUMED_FROM_BUFFER,'系列バッファ待ち生産再開');
});

test('buffer stop analysis agrees with causal saved history and includes unfinished stop through the horizon',()=>{
  const run=simulate(bufferHistoryScenario({durationMin:21})),analysis=analyzeLineBuffers(run);
  assert.equal(analysis.fullCount,1);assert.equal(analysis.stopMs,60000);assert.equal(analysis.maxStopMs,60000);
  assert.equal(analysis.delayedPalletCount,1);assert.equal(analysis.endedBufferStoppedLineCount,1);
  const line=analysis.lines.find(row=>row.lineId==='L1');
  assert.equal(line.capacity,1);assert.equal(line.maxQuantity,1);assert.equal(line.endedStatus,'生産停止中');
  assert.equal(buildTransportHistoryRows(run).filter(row=>row.type==='LINE_BUFFER_BLOCKED').length,analysis.fullCount);
  const recovered=simulate(bufferHistoryScenario({durationMin:30})),resolved=analyzeLineBuffers(recovered);
  assert.equal(resolved.fullCount,1);assert.equal(resolved.stopMs,120000);assert.equal(resolved.maxStopMs,120000);
  assert.equal(resolved.endedBufferStoppedLineCount,0);
  // Recorded final/snapshot counters cannot replace the causal history.
  const copied={...recovered,final:{...recovered.final,bufferStatistics:{stopMs:999999}},snapshots:[]};
  assert.deepEqual(analyzeLineBuffers(copied),resolved);
});
