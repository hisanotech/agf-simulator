import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseLocations} from '../src/map/warehouse-layout.mjs';
import {syntheticWarehousePolicy} from '../examples/synthetic-warehouse-policy.mjs';
import {validateWarehousePolicy,chooseWarehouseLocation,validateStoredPallets,warehouseAvailability} from '../src/core/warehouse-policy.mjs';
import {defaultProductStreams,generateProductionEvents} from '../src/core/production-streams.mjs';
import {simulate} from '../src/core/simulate.mjs';
import {createDemoScenario} from '../src/ui/scenario.mjs';
import {eventCsv} from '../src/ui/export.mjs';

const lineIds=Array.from({length:8},(_,i)=>'L'+(i+1));
const product=(sourceLineId='L1',productType='normal',loadType='full')=>({sourceLineId,productType,loadType});
function context(p=product()){
  return {pallet:p,policy:syntheticWarehousePolicy(),slots:new Map(warehouseLocations().map(s=>[s.id,{...s,palletIds:[],reserved:[]}])),
    pallets:new Map(),rowBusy:new Set()};
}
const select=c=>chooseWarehouseLocation(c);
const validate=(c,specialEnabled=true)=>validateWarehousePolicy(c.policy,[...c.slots.values()],{lineIds,specialEnabled});
function place(c,slotId,p=c.pallet){const id='STORED-'+c.pallets.size;c.pallets.set(id,{palletId:id,...p});c.slots.get(slotId).palletIds.push(id);return id;}

test('W01/W02 western placement starts left; eastern placement starts right',()=>{
  assert.equal(select(context()).location.id,'WB1-R01-C01-T1');
  assert.equal(select(context(product('L7'))).location.id,'EB1-R01-C18-T1');
});
test('W03/W06 full stored lower pallet supports either upper load; empty lower never does',()=>{
  for(const loadType of ['full','partial']){const c=context(product('L1','normal',loadType));
    assert.equal(select(c).location.tier,1);place(c,'WB1-R01-C01-T1',product());
    assert.equal(select(c).location.id,'WB1-R01-C01-T2');}
});
test('W04/W05 partial lower pallet blocks upper and advances to the next lower column',()=>{
  const c=context();place(c,'WB1-R01-C01-T1',product('L1','normal','partial'));
  assert.equal(select(c).location.id,'WB1-R01-C02-T1');
  assert.equal(warehouseAvailability(c.slots,c.pallets).blockedUpper,1);
});
test('W07 east empty column ten is not a placement candidate',()=>{
  const c=context(product('L7'));for(let col=18;col>=11;col--)for(const tier of [1,2])
    place(c,`EB1-R01-C${col}-T${tier}`);
  assert.equal(select(c).location.id,'EB1-R01-C09-T1');
});
test('W08/W09 full line region does not spill into another line or special region',()=>{
  const c=context();for(const s of c.slots.values())if(s.rowId.startsWith('WB1-R0')&&s.row<=3)place(c,s.id);
  assert.equal(select(c).location,null);assert.equal(select(c).reason,'ASSIGNED_STORAGE_FULL');
  assert.ok(select(context(product('L2'))).location);
});
test('W10 all registered lines require at least one assigned row',()=>{
  const c=context();c.policy.rowAssignments=c.policy.rowAssignments.filter(a=>a.sourceLineId!=='L8');
  assert.throws(()=>validate(c),/L8/);
});
test('W11 line assignments cannot be split or shared and unknown cross-block adjacency fails closed',()=>{
  const c=context();c.policy.rowAssignments.find(a=>a.rowId==='WB1-R02').sourceLineId='L2';
  assert.throws(()=>validate(c),/分断/);
  const shared=context();shared.policy.rowAssignments.push({...shared.policy.rowAssignments[0]});
  assert.throws(()=>validate(shared),/重複/);
  const cross=context();cross.policy.rowAssignments.find(a=>a.rowId==='WB2-R01').sourceLineId='L1';
  assert.throws(()=>validate(cross),/ブロック跨ぎ/);
});
test('W12 special products from every source line use their shared special region',()=>{
  for(const line of lineIds)assert.equal(select(context(product(line,'special'))).location.id,'EB2-R02-C18-T1');
});
test('W13/W14 split special area and enabled special streams without an area are rejected',()=>{
  const split=context();split.policy.rowAssignments.find(a=>a.rowId==='EB2-R01').usage='special';
  split.policy.rowAssignments.find(a=>a.rowId==='EB2-R02').usage='normal';
  split.policy.rowAssignments.find(a=>a.rowId==='EB2-R02').sourceLineId='L8';
  assert.throws(()=>validate(split),/分断/);
  const absent=context();absent.policy.rowAssignments=absent.policy.rowAssignments.filter(a=>a.usage!=='special');
  assert.throws(()=>validate(absent),/特注/);
  assert.doesNotThrow(()=>validate(absent,false));
});
test('W15/W16 special full supports upper; special partial blocks upper',()=>{
  for(const load of ['full','partial']){const c=context(product('L4','special',load));
    place(c,'EB2-R02-C18-T1');assert.equal(select(c).location.id,load==='full'?'EB2-R02-C18-T2':'EB2-R02-C17-T1');}
});
test('W17 lower reservation is not lower-tier support and row occupancy is respected',()=>{
  const c=context();c.slots.get('WB1-R01-C01-T1').reserved.push('RESERVED-FULL');
  c.pallets.set('RESERVED-FULL',product());
  assert.equal(select(c).location.id,'WB1-R01-C02-T1');
  c.rowBusy.add('WB1-R01');assert.equal(select(c).location.rowId,'WB1-R02');
});
test('row priority is explicit and missing priority holds instead of guessing',()=>{
  const c=context();delete c.policy.rowPriority.L1;assert.equal(select(c).reason,'ROW_PRIORITY_UNRESOLVED');
  c.policy.rowPriority.L1=['WB1-R03','WB1-R02','WB1-R01'];assert.equal(select(c).location.rowId,'WB1-R03');
});
test('initial floating upper pallets and upper pallets above partial loads fail',()=>{
  for(const lower of [null,'partial']){const c=context();place(c,'WB1-R01-C01-T2');
    if(lower)place(c,'WB1-R01-C01-T1',product('L1','normal',lower));
    assert.throws(()=>validateStoredPallets(c.slots,c.pallets,c.policy,lineIds),/2段目/);}
});
test('802 theoretical capacity remains distinct from future capacity and current supported slots',()=>{
  const c=context();let a=warehouseAvailability(c.slots,c.pallets);
  assert.equal(a.theoretical,802);assert.equal(a.additionalIfFull,802);assert.equal(a.additionalIfPartial,401);
  assert.equal(a.immediatelyPlaceable,401);
  place(c,'WB1-R01-C01-T1',product('L1','normal','partial'));a=warehouseAvailability(c.slots,c.pallets);
  assert.equal(a.theoretical,802);assert.equal(a.additionalIfFull,800);assert.equal(a.additionalIfPartial,400);
});
test('W19 default production enables only normal full pallets',()=>{
  const streams=defaultProductStreams(),events=generateProductionEvents(streams,180*60000,lineIds);
  assert.equal(streams.filter(s=>s.enabled).length,8);
  assert.ok(events.length>0&&events.every(e=>e.productType==='normal'&&e.loadType==='full'));
});
for(const [type,load] of [['normal','partial'],['special','full'],['special','partial']])
  test(`W20-W23 enabled ${type}/${load} is generated while disabled variants are absent`,()=>{
    const streams=defaultProductStreams().map(s=>({...s,enabled:s.sourceLineId==='L1'&&s.productType===type&&s.loadType===load}));
    const events=generateProductionEvents(streams,180*60000,lineIds);
    assert.equal(events.length,10);
    assert.deepEqual(events.map(e=>e.timeMs),Array.from({length:10},(_,i)=>(i+1)*1032000));
    assert.ok(events.every(e=>e.sourceLineId==='L1'&&e.productType===type&&e.loadType===load));
  });
test('W24/W25 frequency changes exact event times; same conditions and reordered settings are deterministic',()=>{
  const s=defaultProductStreams().map(s=>({...s,enabled:s.enabled&&s.sourceLineId==='L1',intervalMin:20,startOffsetMin:0}));
  const a=generateProductionEvents(s,60*60000,lineIds);assert.deepEqual(a.map(e=>e.timeMs),[1200000,2400000,3600000]);
  assert.deepEqual(generateProductionEvents(s.toReversed(),60*60000,lineIds),a);
  s.find(s=>s.enabled).intervalMin=30;assert.deepEqual(generateProductionEvents(s,60*60000,lineIds).map(e=>e.timeMs),[1800000,3600000]);
});

function integrated(){
  const s=createDemoScenario('physical');s.lineIntervalsMin=Array(8).fill(0);s.warehousePolicy=syntheticWarehousePolicy();
  for(const slot of s.warehouse){slot.palletIds=[];slot.permission=true;}
  s.temporaryPallets=s.temporaryPallets.map((p,i)=>({...p,sourceLineId:'L'+(i+1),productType:'normal',loadType:'full'}));
  return s;
}
test('W18 attributes survive 01, wrapping, 02, storage and CSV including source line for special pallets',()=>{
  const s=integrated();s.productionEvents=[{timeMs:0,lineId:'L4',palletId:'SPECIAL-PARTIAL',productType:'special',loadType:'partial'}];
  const run=simulate(s),p=run.final.pallets.find(p=>p.palletId==='SPECIAL-PARTIAL');
  assert.equal(p.stage,'stored');assert.equal(p.sourceLineId,'L4');assert.equal(p.destinationLocationId,'EB2-R02-C18-T1');
  for(const task of run.final.tasks){assert.equal(task.sourceLineId,'L4');assert.equal(task.productType,'special');assert.equal(task.loadType,'partial');}
  for(const event of run.events.filter(e=>e.palletId==='SPECIAL-PARTIAL')){assert.equal(event.productType,'special');assert.equal(event.loadType,'partial');}
  assert.ok(eventCsv(run,'PRODUCTS').includes('sourceLineId'));
  assert.ok(eventCsv(run,'PRODUCTS').includes('special,partial'));
});
test('concurrent 05 requests reserve distinct slots; upper placement occurs after full lower delivery',()=>{
  const s=integrated();s.temporaryPallets.forEach(p=>p.sourceLineId='L8');
  s.manualRequests=s.temporaryPallets.map(p=>({timeMs:0,kind:'05',palletId:p.palletId,locationId:p.locationId,storagePermission:true}));
  const run=simulate(s),stored=run.events.filter(e=>e.type==='STORE_COMPLETED');
  assert.deepEqual(stored.map(e=>e.locationId),['EB2-R01-C18-T1','EB2-R01-C18-T2','EB2-R01-C17-T1']);
  for(const snap of run.snapshots)for(const slot of Object.values(snap.warehouse))assert.ok(slot.reserved.length+slot.palletIds.length<=1);
  const upper=run.events.find(e=>e.type==='WAREHOUSE_LOCATION_RESERVED'&&e.locationId==='EB2-R01-C18-T2');
  assert.ok(upper.timeMs>=stored[0].timeMs);
});

test('external production cannot contradict its physical source line identity',()=>{
  const s=integrated();s.productionEvents=[{timeMs:0,lineId:'L1',sourceLineId:'L2',palletId:'BAD-SOURCE'}];
  assert.throws(()=>simulate(s),/sourceLineId/);
});

test('saved warehouse history retains empty, reserved and delivered states after later events',()=>{
  const s=integrated(),p=s.temporaryPallets[0];
  s.manualRequests=[{timeMs:0,kind:'05',palletId:p.palletId,locationId:p.locationId,storagePermission:true}];
  const r=simulate(s),reservation=r.events.find(e=>e.type==='WAREHOUSE_LOCATION_RESERVED');
  const store=r.events.find(e=>e.type==='STORE_COMPLETED'),id=store.locationId;
  assert.deepEqual(r.snapshots[0].warehouse[id].palletIds,[]);
  assert.deepEqual(r.snapshots[0].warehouse[id].reserved,[]);
  assert.deepEqual(r.snapshots[reservation.sequence].warehouse[id].reserved,[p.palletId]);
  assert.deepEqual(r.snapshots[reservation.sequence].warehouse[id].palletIds,[]);
  assert.deepEqual(r.snapshots[store.sequence].warehouse[id].reserved,[]);
  assert.deepEqual(r.snapshots[store.sequence].warehouse[id].palletIds,[p.palletId]);
});
