import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/core/simulate.mjs';

test('legacy three-hour 41-minute synthetic input remains reproducible and capacity safe',()=>{
  const scenario={
    durationMin:180,mode:'area_first',fallback:'any',
    lineCapacity:2,lineIntervalsMin:[41,41,41,41,41,41,41,41],
    lineStartOffsetsMin:Array.from({length:8},(_,i)=>Number((i*41/8).toFixed(3))),
    generatedDestinationIds:Array.from({length:6},(_,i)=>'SYN-W'+(i+1)),
    wrapper:{inputCapacity:1,outputCapacity:2},
    agfs:['AGF1','AGF2','AGF3','AGF4'].map((id,i)=>({id,area:i<2?'PZ':'WH',batteryPct:100,status:'idle'})),
    chargerIds:['CHARGER1','CHARGER2'],
    battery:{reservePct:40,chargeStartPct:40,chargeTargetPct:80,consumptionPct:1.5,chargeMinPerPct:2.4},
    times:{emptyMin:2,loadedMin:3,pickupMin:0.5,dropoffMin:0.5,wrapMin:3.3,labelMin:0.2,exitMin:0.2,chargeTravelMin:2},
    warehouse:Array.from({length:6},(_,i)=>({id:'SYN-W'+(i+1),rowId:'SYN-ROW'+(i+1),capacity:50,permission:true})),
    magazines:Array.from({length:5},(_,i)=>({id:'M'+(i+1),quantity:4,capacity:20,trigger:3,refillBatch:10,permission:true})),
    aligners:Array.from({length:5},(_,i)=>({id:'AL'+(i+1),ready:false})),
    temporaryPallets:[1,2,3].map(i=>({palletId:'SIM-TEMP-'+i,locationId:'OT'+i,destinationLocationId:'SYN-W'+i}))
  };
  const first=simulate(scenario),second=simulate(scenario);
  assert.deepEqual(first.events,second.events);
  assert.equal(first.metrics.created,28);
  assert.ok(first.metrics.stored>0);
  for(const snap of first.snapshots) {
    assert.ok(Object.values(snap.lines).every(line=>line.length<=2));
    assert.ok(snap.wrapper.input.length<=1&&snap.wrapper.output.length<=2);
    assert.ok(Object.values(snap.chargers).filter(Boolean).length<=2);
  }
});
