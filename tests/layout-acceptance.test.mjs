import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SCHEMATIC_LAYOUT as drawing} from '../src/map/schematic-layout.mjs';
import {
  WAREHOUSE_BLOCKS,
  WAREHOUSE_MAIN_AISLES,
  WAREHOUSE_RULES,
  WAREHOUSE_SERVICE,
  warehouseLocations
} from '../src/map/warehouse-layout.mjs';

const map=JSON.parse(readFileSync(new URL('../data/reference-logical-map.json',import.meta.url),'utf8'));
const layout=map.layoutAcceptance??{};
const corridor=id=>map.corridors.find(item=>item.id===id);
const criterion=id=>(layout.criteria??[]).find(item=>item.id===id);

test('G01 schematic has palletizing, exterior passage and warehouse as three separate bands',()=>{
  assert.deepEqual(layout.verticalBands,['PZ','INTER','WH']);
  assert.equal(layout.coordinateBasis,'schematic-relative-only');
  assert.equal(layout.physicalCoordinatesConfirmed,false);
  assert.ok(criterion('G01'));
});

test('G02 palletizing north face has no AGF gate',()=>{
  assert.equal(layout.palletizing?.northFaceAgfGate,false);
  assert.ok(criterion('G02'));
});

// The retained DXF-free reference fixture is not a source for obsolete gate
// positions. Current drawing relationships live in the shared synthetic model.
test('G03 palletizing entry shutter is on the south face near HO rather than the west end',()=>{
  assert.equal(drawing.gates.pzEntry.boundaryY,drawing.buildings.PZ.y+drawing.buildings.PZ.height);
  assert.ok(Math.abs(drawing.gates.pzEntry.x-637.5)<27.5);
  assert.ok(drawing.gates.pzEntry.x<drawing.gates.pzExit.x);
  assert.ok(criterion('G03'));
});
test('G04 east warehouse shutter aligns with the warehouse aisle pair independently of the PZ exit',()=>{
  const offset=drawing.warehouseOffsetX;
  assert.equal(drawing.gates.whEast.x,offset+(665+700)/2);
  assert.notEqual(drawing.gates.pzExit.x,drawing.gates.whEast.x);
  assert.ok(drawing.buildings.WH.x>drawing.buildings.PZ.x);
  assert.deepEqual(layout.symbolicGroups?.['WH-E-MAIN-GROUP']?.members,['WH-E-MAIN-1','WH-E-MAIN-2']);
  assert.ok(criterion('G04'));
});
test('G05 obsolete east palletizing shutter is absent from the completed schematic contract',()=>{
  assert.equal(corridor('PZ-E-OUT'),undefined);
  assert.equal(layout.palletizing?.obsoleteEastGateDisplay,'removed');
  assert.ok(criterion('G05'));
});

test('G06 normal return uses a distinct PZ exit and the east-offset warehouse gate',()=>{
  assert.equal(drawing.gates.pzExit.nodeId,'PZ-EXIT');assert.equal(drawing.gates.whEast.nodeId,'WH-GATE');
  assert.ok(drawing.gates.pzExit.x<drawing.gates.whEast.x);
  assert.ok(criterion('G06'));
});
test('G07 normal palletizing entry reaches the HO-facing opening instead of the legacy west-end opening',()=>{
  assert.equal(drawing.gates.pzEntry.nodeId,'PZ-ENTRY');
  assert.notEqual(drawing.gates.pzEntry.nodeId,drawing.gates.pzExit.nodeId);
  assert.ok(drawing.gates.whEast.x>drawing.gates.pzEntry.x);
  assert.ok(criterion('G07'));
});
test('G08 west warehouse shutter is excluded normally but retained as an unresolved failure detour',()=>{
  assert.equal(map.accessRules?.warehouseGates?.normal?.west,'not-used');
  assert.equal(map.accessRules?.warehouseGates?.normal?.east,'entry-exit');
  assert.equal(map.accessRules?.warehouseGates?.eastFailureDetour?.west,'conditional');
  assert.equal(map.accessRules?.warehouseGates?.eastFailureDetour?.palletizingGateReversal,'required-existing-rule');
  assert.equal(map.accessRules?.warehouseGates?.eastFailureDetour?.activationCondition,'unresolved');
  assert.equal(map.accessRules?.warehouseGates?.eastFailureDetour?.operationProcedure,'unresolved');
  assert.equal(map.accessRules?.warehouseGates?.eastFailureDetour?.routingReady,false);
  assert.ok(criterion('G08'));
});

test('G09 palletizing shared region has opposite logical lanes with local changes instead of end-only detours',()=>{
  for(const id of ['PZ-A1','PZ-A2']){
    assert.equal(corridor(id).direction,id==='PZ-A1'?'east-to-west':'west-to-east');
    assert.equal(corridor(id).laneCount,1);assert.equal(corridor(id).sharedRegionId,'PZ-SHARED');
    assert.equal(corridor(id).physicalSeparation,false);
  }
  assert.ok(map.links.some(link=>link.id==='L-PZ-SHARED-LANE-CHANGE'&&link.status==='confirmed'));
  assert.ok(!map.links.some(link=>['PZ-CON-W','PZ-CON-E'].includes(link.from)||['PZ-CON-W','PZ-CON-E'].includes(link.to)));
  assert.ok(criterion('G09'));
});

test('G10 OT1 to OT3 are ordered east of the exit along the palletizing south wall',()=>{
  assert.deepEqual(layout.palletizing?.temporaryPlaces,
    {ids:['OT1','OT2','OT3'],face:'south',relativeToExit:'east',order:'west-to-east'});
  assert.ok(criterion('G10'));
});

test('G11 warehouse has two west and two east main aisles beside the central fire wall',()=>{
  assert.equal(WAREHOUSE_MAIN_AISLES.filter(item=>item.side==='west').length,2);
  assert.equal(WAREHOUSE_MAIN_AISLES.filter(item=>item.side==='east').length,2);
  assert.equal(layout.warehouse?.mainAislePlacement,'between-storage-blocks-and-central-fire-wall');
  assert.ok(criterion('G11'));
});

test('G12 only the two fire shutter corridor groups cross the central wall',()=>{
  assert.equal(WAREHOUSE_RULES.fireShutterCrossings,2);
  assert.equal(WAREHOUSE_RULES.freeWallCrossing,false);
  for(const id of ['WH-X-U','WH-X-L']){
    const crossing=corridor(id);
    assert.equal(crossing.kind,'fire-shutter-corridor-group');
    assert.deepEqual(crossing.groupOperation,
      {direction:'both',laneCount:2,simultaneousPassing:'yes',evidence:'user-confirmed'});
    assert.equal(crossing.lanes.length,2);
    assert.ok(crossing.lanes.every(lane=>lane.direction==='unresolved'));
  }
  assert.ok(criterion('G12'));
});

test('G13 warehouse capacity and east empty column remain fixed without physical coordinates',()=>{
  assert.equal(warehouseLocations().length,802);
  assert.deepEqual(WAREHOUSE_BLOCKS.map(block=>block.rows),[7,3,13,3,3]);
  assert.deepEqual(WAREHOUSE_BLOCKS.filter(block=>block.id.startsWith('EB')).map(block=>block.emptyColumns),[[10],[10]]);
  assert.equal(layout.physicalCoordinatesConfirmed,false);
  assert.ok(criterion('G13'));
});

test('G14 service waiting and charging places are separate in a vertical left column',()=>{
  assert.deepEqual(WAREHOUSE_SERVICE.arrangement.left,
    ['waiting-1','waiting-2','charge-1','charge-2']);
  assert.equal(layout.warehouse?.serviceVehicleOrientation,'east-west');
  assert.ok(criterion('G14'));
});

test('G15 five aligners are above the forbidden empty-pallet storage on the right',()=>{
  assert.equal(WAREHOUSE_SERVICE.aligners.length,5);
  assert.equal(WAREHOUSE_SERVICE.arrangement.rightTop,'five-aligners');
  assert.equal(WAREHOUSE_SERVICE.arrangement.rightBottom,'empty-pallet-storage');
  assert.ok(criterion('G15'));
});

test('G16 four normal waiting places retain two south-service and two rack-gap pillar places',()=>{
  assert.equal(WAREHOUSE_SERVICE.waitingCandidates.totalCount,4);
  assert.deepEqual(WAREHOUSE_SERVICE.waitingCandidates.groups,[
    {kind:'south-service',count:2,placeIds:['HP1','HP2']},
    {kind:'rack-gap-pillars',count:2,sides:['west','east'],placeIds:['PILLAR-WAIT-W','PILLAR-WAIT-E']}
  ]);
  assert.equal(WAREHOUSE_SERVICE.waitingCandidates.wsIdMapping,'unresolved');
  assert.ok(criterion('G16'));
});

test('G17 empty-pallet storage remains outside every AGF route',()=>{
  assert.equal(WAREHOUSE_SERVICE.emptyPalletStorage.agfAccess,'forbidden');
  assert.deepEqual(WAREHOUSE_SERVICE.emptyPalletStorage.routeNodes,[]);
  assert.ok(criterion('G17'));
});

test('all G01 to G17 criteria are explicit schematic checks rather than CAD coordinate assertions',()=>{
  assert.deepEqual((layout.criteria??[]).map(item=>item.id),
    Array.from({length:17},(_,index)=>`G${String(index+1).padStart(2,'0')}`));
  assert.ok(layout.criteria.every(item=>item.scope==='schematic-relative'&&item.physicalCoordinateCheck===false));
});
