import test from 'node:test';
import assert from 'node:assert/strict';
import {warehouseLocations} from '../src/map/warehouse-layout.mjs';
import {validateWarehousePolicy,chooseWarehouseLocation,warehouseAvailability,validateStoredPallets} from '../src/core/warehouse-policy.mjs';
import {initMap,renderWarehouseBlock} from '../src/ui/map-view.mjs';
import {WAREHOUSE_OWNER_COLORS,warehouseOwnerLegend} from '../src/ui/warehouse-colors.mjs';

const lineIds=Array.from({length:8},(_,i)=>'L'+(i+1));
// Synthetic test allocation: one row per owner, with the other rows deliberately unassigned.
const minimalPolicy=()=>({evidence:'synthetic-test-allocation',rowAssignments:[
  ...lineIds.slice(0,7).map((sourceLineId,i)=>({rowId:`WB1-R0${i+1}`,usage:'normal',sourceLineId})),
  {rowId:'EB1-R01',usage:'normal',sourceLineId:'L8'},
  {rowId:'EB2-R01',usage:'special',sourceLineId:null}
],rowPriority:{}});
const inventory=()=>new Map(warehouseLocations().map(s=>[s.id,{...s,palletIds:[],reserved:[]}]));
const validate=(policy,specialEnabled=true)=>validateWarehousePolicy(policy,warehouseLocations(),{lineIds,specialEnabled});
const pallet=(sourceLineId='L1',productType='normal')=>({sourceLineId,productType,loadType:'full'});

test('partial row allocation is valid; explicit unassigned rows carry no owner or usable capacity',()=>{
  const policy=minimalPolicy();assert.doesNotThrow(()=>validate(policy));
  policy.rowAssignments.push({rowId:'WB2-R01',usage:'unassigned',sourceLineId:null});
  const owners=validate(policy);assert.equal(owners.size,9);assert.ok(!owners.has('UNASSIGNED'));
  const availability=warehouseAvailability(inventory(),new Map(),policy);
  assert.equal(availability.theoretical,802);
  assert.equal(availability.assignedCapacity,7*26+2*34);
  assert.equal(availability.unassignedCapacity,802-availability.assignedCapacity);
  assert.equal(availability.additionalIfFull,availability.assignedCapacity);
});

test('an explicit unassigned row may not silently retain a source-line owner or be shared',()=>{
  const invalid=minimalPolicy();invalid.rowAssignments.push({rowId:'WB2-R01',usage:'unassigned',sourceLineId:'L1'});
  assert.throws(()=>validate(invalid),/未割当/);
  const shared=minimalPolicy();shared.rowAssignments.push({rowId:'WB1-R01',usage:'unassigned',sourceLineId:null});
  assert.throws(()=>validate(shared),/重複/);
});

test('unassigned rows never accept normal or special overflow even when their slots are empty',()=>{
  const policy=minimalPolicy();policy.rowAssignments.push({rowId:'EB2-R02',usage:'unassigned',sourceLineId:null});
  for(const p of [pallet(),pallet('L5','special')]){
    const slots=inventory(),ownerRow=p.productType==='special'?'EB2-R01':'WB1-R01';
    for(const slot of slots.values())if(slot.rowId===ownerRow){
      slot.palletIds.push('FULL-'+slot.id);
    }
    const selection=chooseWarehouseLocation({pallet:p,policy,slots,pallets:new Map(),rowBusy:new Set()});
    assert.equal(selection.location,null);assert.equal(selection.reason,'ASSIGNED_STORAGE_FULL');
    assert.ok([...slots.values()].filter(s=>s.rowId==='EB2-R02').every(s=>s.palletIds.length===0));
  }
});

test('all eight lines and enabled SPECIAL still require an assigned row',()=>{
  for(const id of lineIds){const policy=minimalPolicy();policy.rowAssignments=policy.rowAssignments.filter(a=>a.sourceLineId!==id);
    assert.throws(()=>validate(policy),new RegExp(id));}
  const policy=minimalPolicy();policy.rowAssignments=policy.rowAssignments.filter(a=>a.usage!=='special');
  assert.throws(()=>validate(policy),/特注/);assert.doesNotThrow(()=>validate(policy,false));
});

test('an unassigned gap cannot split the continuous region of one owner',()=>{
  const policy=minimalPolicy();policy.rowAssignments.find(a=>a.rowId==='WB1-R02').usage='unassigned';
  policy.rowAssignments.find(a=>a.rowId==='WB1-R02').sourceLineId=null;
  policy.rowAssignments.find(a=>a.sourceLineId==='L3').sourceLineId='L1';
  policy.rowAssignments.push({rowId:'WB2-R01',usage:'normal',sourceLineId:'L2'},{rowId:'WB2-R02',usage:'normal',sourceLineId:'L3'});
  assert.throws(()=>validate(policy),/L1の領域が分断/);
});

test('initial inventory is rejected in either omitted or explicitly unassigned rows',()=>{
  for(const explicit of [false,true]){
    const policy=minimalPolicy(),slots=inventory(),id='WB2-R01-C01-T1';
    if(explicit)policy.rowAssignments.push({rowId:'WB2-R01',usage:'unassigned',sourceLineId:null});
    slots.get(id).palletIds.push('INVALID');
    assert.throws(()=>validateStoredPallets(slots,new Map([['INVALID',pallet()]]),policy,lineIds),/行用途/);
  }
});

function snapshot(policy=minimalPolicy()){
  return {warehouse:Object.fromEntries(inventory()),warehouseAllocation:policy,storagePolicyActive:true,
    tasks:[],agfs:[],lines:{},magazines:{},aligners:{},temporaryPallets:[],pallets:[]};
}
function mapHtml(snap){
  const svg={innerHTML:'',setAttribute(){},addEventListener(){}};
  initMap({svg,onSelectAgf(){},onSelectBlock(){}}).render(snap,'AGF1');return svg.innerHTML;
}

test('map and warehouse dialog identify the same owner with the same color and readable labels',()=>{
  const snap=snapshot(),html=mapHtml(snap);
  const mapOwner=html.match(/data-warehouse-row="WB1-R01"[^>]*data-owner="L1"[^>]*fill="([^"]+)"/);
  assert.ok(mapOwner,'the map exposes an owner marker for the actual row');
  const dialog=renderWarehouseBlock('WB1',1,snap);
  assert.match(dialog,new RegExp(`data-warehouse-row="WB1-R01"[^>]*data-owner="L1"[^>]*--owner-color:${mapOwner[1]}`));
  assert.match(html,/WB1-R01[^<]*GWI/);assert.match(dialog,/GWI/);
  assert.match(html,/data-warehouse-row="WB2-R01"[^>]*data-owner="UNASSIGNED"/);
  assert.match(renderWarehouseBlock('WB2',1,snap),/未割当/);
});

test('series coloring preserves every existing rack cell coordinate and column count',()=>{
  const colored=mapHtml(snapshot()),plain=mapHtml(snapshot(null));
  const geometry=html=>[...html.matchAll(/<rect\b[^>]*data-row="[^"]+"[^>]*>/g)].map(([tag])=>{
    const attrs=Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,k,v])=>[k,v]));
    return Object.fromEntries(['data-row','data-column','data-tiers','x','y','width','height'].map(k=>[k,attrs[k]]));
  });
  assert.equal(geometry(colored).length,407);assert.deepEqual(geometry(colored),geometry(plain));
  for(const state of ['empty','occupied','reserved','unavailable'])assert.ok(renderWarehouseBlock('WB1',1,snapshot()).includes(`slot-${state}`));
});

test('all ten warehouse owners have shared legend colors and textual names without normal red',()=>{
  const colors=Object.values(WAREHOUSE_OWNER_COLORS),legend=warehouseOwnerLegend();
  assert.equal(colors.length,10);assert.equal(new Set(colors.map(c=>c.color)).size,10);
  for(const {owner,label,color} of colors){
    assert.match(legend,new RegExp(`data-owner="${owner}"[^>]*><i style="background:${color}"></i>${label}`));
    assert.ok(!['#dc2626','#ef4444'].includes(color));
  }
});

test('allocation coloring preserves occupied, reserved and prohibited slot-state semantics',()=>{
  const snap=snapshot();
  snap.warehouse['WB1-R01-C01-T1'].palletIds=['OCCUPIED'];
  snap.pallets.push({palletId:'OCCUPIED',...pallet()});
  snap.warehouse['WB1-R01-C02-T1'].reserved=['RESERVED'];
  for(const tier of [1,2])snap.warehouse[`WB1-R01-C03-T${tier}`].permission=false;
  const html=mapHtml(snap),dialog=renderWarehouseBlock('WB1',1,snap);
  for(const [column,fill,state] of [[1,'#10b981','occupied'],[2,'#f59e0b','reserved'],[3,'#64748b','unavailable']]){
    assert.match(html,new RegExp(`data-row="1" data-column="${column}"[^>]*fill="${fill}"`));
    assert.match(dialog,new RegExp(`class="slot slot-${state} warehouse-owner-slot"[^>]*data-slot="WB1-R01-C0${column}-T1"`));
  }
  assert.equal(snap.warehouse['WB1-R01-C01-T1'].palletIds[0],'OCCUPIED');
});
