import {mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {simulate} from '../src/core/simulate.mjs';
import {analyzeRun,durationTenths} from '../src/ui/replay-model.mjs';
import {eventCsv} from '../src/ui/export.mjs';
import {integratedAcceptanceScenario} from '../examples/integrated-acceptance.mjs';

const out=new URL('../private/review-2026-09-28/acceptance/',import.meta.url);
mkdirSync(out,{recursive:true});
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summaries=[];
for(const kind of ['normal','recovery','charging-boundary']){
  let commonSource=null;
  for(const mode of ['area_first','low_battery_first']){
    const scenario={...integratedAcceptanceScenario(kind),mode};
    const run=simulate(scenario),repeat=simulate(scenario),analysis=analyzeRun(run);
    assert.equal(sha(run.events),sha(repeat.events),'deterministic events');
    assert.deepEqual(run.final,repeat.final,'deterministic final state');
    const source=run.events.filter(e=>e.type==='PALLET_EXITED').map(e=>[e.timeMs,e.palletId,e.sourceLineId,e.productType,e.loadType]);
    if(commonSource)assert.deepEqual(source,commonSource,'same exogenous stream between modes');else commonSource=source;
    for(const a of analysis.agfs){
      assert.equal(Object.values(a.durations).reduce((s,n)=>s+n,0),180*60000);
      assert.equal(Object.values(durationTenths(a.durations)).reduce((s,n)=>s+n,0),1800);
    }
    for(const snap of run.snapshots){
      assert.ok(Object.values(snap.chargers).filter(Boolean).length<=2);
      for(const slot of Object.values(snap.warehouse))assert.ok(slot.reserved.length+slot.palletIds.length<=slot.capacity);
    }
    const name=kind+'-'+mode;
    writeFileSync(new URL(name+'.scenario.json',out),JSON.stringify(scenario,null,2));
    writeFileSync(new URL(name+'.events.json',out),JSON.stringify(run.events,null,2));
    writeFileSync(new URL(name+'.csv',out),eventCsv(run,name));
    const summary={name,scenarioSha256:sha(scenario),eventSha256:sha(run.events),events:run.events.length,
      metrics:run.metrics,analysis,deterministic:true,sameInputAcrossModes:true,
      endAgfs:run.final.agfs.map(a=>({id:a.id,status:a.status,batteryPct:a.batteryPct,node:a.currentNodeId})),
      holdReasons:[...new Set(run.events.map(e=>e.reason).filter(Boolean))],
      maxChargers:Math.max(...run.snapshots.map(s=>Object.values(s.chargers).filter(Boolean).length)),
      scope:'synthetic-only; not physical acceptance or measured throughput'};
    summaries.push(summary);
    console.log(JSON.stringify({name,created:run.metrics.created,stored:run.metrics.stored,completed:analysis.completed,
      pending:analysis.pending,events:run.events.length,chargeStarts:run.metrics.chargingStarts,byKind:run.metrics.byKind,
      holdReasons:summary.holdReasons,deterministic:true}));
  }
}
writeFileSync(new URL('summary.json',out),JSON.stringify(summaries,null,2));
