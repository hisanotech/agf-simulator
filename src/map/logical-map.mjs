/**
 * Public-safe logical map validation and *conceptual* graph traversal.
 *
 * No geometry or measured time is generated here. A confirmed conceptual link
 * is not a verified collision-free physical route.
 */
import {WAREHOUSE_BLOCKS} from './warehouse-layout.mjs';
const accessValues = new Set(['allowed', 'forbidden', 'unresolved']);
const directionValues = new Set(['both', 'forward', 'reverse', 'entry-only', 'exit-only', 'unresolved']);
const passingValues = new Set(['yes', 'no-alternating', 'reported-yes', 'unresolved', 'not-applicable']);
const linkDirections = new Set(['both', 'forward', 'reverse']);
const linkStatuses = new Set(['confirmed', 'unresolved', 'provisional']);

function requireThat(value, message) {
  if (!value) throw new Error(message);
}
function uniqueIdMap(items, label) {
  requireThat(Array.isArray(items), label + ' must be an array');
  const output = new Map();
  for (const item of items) {
    requireThat(item && typeof item.id === 'string' && item.id.trim(), label + ': missing id');
    requireThat(!output.has(item.id), label + ': duplicate id ' + item.id);
    output.set(item.id, item);
  }
  return output;
}

export function validateLogicalMap(map) {
  requireThat(map && map.schemaVersion === 'logical-map-v1', 'Expected logical-map-v1');
  requireThat(map.geometry?.coordinateSystem === 'none' && map.geometry?.measured === false,
    'Public logical map must not declare measured geometry');
  requireThat(map.geometry?.hasActualSiteCoordinates === false &&
              map.geometry?.hasMeasuredDistances === false &&
              map.geometry?.hasConfirmedTurnOrStopPoints === false,
    'Missing public-safe geometry qualifications');
  const areas = uniqueIdMap(map.areas, 'areas');
  const corridors = uniqueIdMap(map.corridors, 'corridors');
  const links = uniqueIdMap(map.links, 'links');
  const groups = uniqueIdMap(map.corridorGroups, 'corridorGroups');
  const interfaces = uniqueIdMap(map.interfaces, 'interfaces');
  const required = ['PZ-A1', 'PZ-A2', 'PZ-CON-W', 'PZ-CON-E', 'PZ-DEV', 'PZ-OT',
    'PZ-W-IN', 'PZ-S-OUT', 'WH-E-GATE', 'WH-E-V', 'WH-W-V', 'WH-X-U', 'WH-X-L', 'WH-ROW', 'WH-W-GATE'];
  for (const id of required) requireThat(corridors.has(id), 'Missing agreed corridor ' + id);
  for (const corridor of corridors.values()) {
    requireThat(areas.has(corridor.area), 'Unknown corridor area: ' + corridor.id);
    requireThat(accessValues.has(corridor.access), 'Invalid corridor access: ' + corridor.id);
    requireThat(directionValues.has(corridor.direction), 'Invalid corridor direction: ' + corridor.id);
    requireThat(passingValues.has(corridor.simultaneousPassing), 'Invalid passing flag: ' + corridor.id);
    requireThat(corridor.geometryStatus === 'not-measured', 'Unexpected geometry status: ' + corridor.id);
    requireThat(corridor.laneCount === null ||
      (Number.isInteger(corridor.laneCount) && corridor.laneCount > 0),
      'Invalid lane count: ' + corridor.id);
    if (corridor.access !== 'allowed') {
      requireThat(corridor.simultaneousPassing !== 'yes', 'Unresolved/forbidden corridor cannot have confirmed passing: ' + corridor.id);
    }
  }
  for (const group of groups.values()) {
    requireThat(Array.isArray(group.members) && group.members.length >= 2, 'Invalid group ' + group.id);
    requireThat(new Set(group.members).size === group.members.length, 'Duplicate group member ' + group.id);
    const members = group.members.map(id => {
      requireThat(corridors.has(id), 'Missing group member ' + id);
      return corridors.get(id);
    });
    requireThat(group.aggregateLaneCount === members.reduce((sum, x) => sum + x.laneCount, 0),
      'Aggregate lane count mismatch ' + group.id);
  }
  for (const link of links.values()) {
    const from = corridors.get(link.from), to = corridors.get(link.to);
    requireThat(from && to && link.from !== link.to, 'Invalid link endpoints: ' + link.id);
    requireThat(linkDirections.has(link.direction), 'Invalid link direction: ' + link.id);
    requireThat(linkStatuses.has(link.status), 'Invalid link status: ' + link.id);
    requireThat(link.reviewState === (link.status === 'confirmed' ? 'user-confirmed-abstract' : 'pending-confirmation'),
      'Link status requires separate review evidence: ' + link.id);
    if (link.status === 'confirmed') {
      requireThat(from.access === 'allowed' && to.access === 'allowed',
        'Confirmed link uses unapproved corridor: ' + link.id);
      requireThat(from.area === to.area,
        'Confirmed inter-area link requires reviewed gate/stop geometry: ' + link.id);
    }
  }
  const usedInterfaces = new Set();
  for (const item of interfaces.values()) {
    requireThat(corridors.has(item.corridor), 'Unknown interface corridor: ' + item.id);
    requireThat(Array.isArray(item.ids) && item.individualStopNodes === 'unresolved',
      'Interface points cannot be invented: ' + item.id);
    requireThat(item.count === null || item.count === item.ids.length ||
      (item.endpointCount === item.ids.length && item.endpointCount >= item.count),
      'Interface count mismatch: ' + item.id);
    for (const id of item.ids) {
      requireThat(!usedInterfaces.has(id), 'Duplicate interface ID: ' + id);
      usedInterfaces.add(id);
    }
  }
  const warehouseGates=map.accessRules?.warehouseGates;
  requireThat(warehouseGates?.normal?.east==='entry-exit'&&warehouseGates?.normal?.west==='not-used'&&
    warehouseGates?.eastFailureDetour?.west==='conditional'&&
    warehouseGates?.eastFailureDetour?.palletizingGateReversal==='required-existing-rule'&&
    warehouseGates?.eastFailureDetour?.activationCondition==='unresolved'&&
    warehouseGates?.eastFailureDetour?.operationProcedure==='unresolved'&&
    warehouseGates?.eastFailureDetour?.routingReady===false&&corridors.get('WH-W-GATE').access==='unresolved',
    'Warehouse gates must separate normal east access from the unresolved west detour');
  for(const id of ['WH-X-U','WH-X-L']){
    const crossing=corridors.get(id);
    requireThat(crossing.kind==='fire-shutter-corridor-group'&&crossing.direction==='both'&&
      crossing.laneCount===2&&crossing.simultaneousPassing==='yes'&&
      JSON.stringify(crossing.groupOperation)===JSON.stringify({direction:'both',laneCount:2,simultaneousPassing:'yes',evidence:'user-confirmed'})&&
      crossing.lanes?.length===2&&crossing.lanes.every(lane=>lane.direction==='unresolved'&&lane.evidence==='unresolved'),
      'Fire shutter group operation is confirmed while individual lane directions remain unresolved: '+id);
  }
  const acceptance=map.layoutAcceptance;
  requireThat(acceptance?.coordinateBasis==='schematic-relative-only'&&acceptance.physicalCoordinatesConfirmed===false&&
    JSON.stringify(acceptance.verticalBands)===JSON.stringify(['PZ','INTER','WH'])&&
    acceptance.palletizing?.northFaceAgfGate===false&&acceptance.palletizing?.obsoleteEastGateDisplay==='removed'&&
    JSON.stringify(acceptance.symbolicGroups?.['WH-E-MAIN-GROUP']?.members)===
      JSON.stringify(['WH-E-MAIN-1','WH-E-MAIN-2'])&&
    !corridors.has('PZ-E-OUT')&&acceptance.criteria?.length===17&&
    acceptance.criteria.every((item,index)=>item.id===`G${String(index+1).padStart(2,'0')}`&&
      item.scope==='schematic-relative'&&item.physicalCoordinateCheck===false),
    'G01-G17 must remain schematic-relative acceptance criteria without invented coordinates');
  const pair = groups.get('PZ-PAIR');
  requireThat(pair && pair.aggregateLaneCount === 2 &&
    pair.members.every(id => corridors.get(id).laneCount === 1),
    'Palletizing 2-lane designation is the combination of the two one-lane corridors');
  requireThat(map.accessRules?.task02?.reserveDestination === 'at-task-issue' &&
    map.accessRules?.task02?.holdIfSameRowPutTask === true,
    'Task 02 destination reservation and same-row hold must be preserved');
  const layout=map.warehouseLayout;
  requireThat(layout?.capacity===802&&JSON.stringify(layout.blocks)===JSON.stringify(WAREHOUSE_BLOCKS),
    'Warehouse block capacity and east empty column must match the reviewed structure');
  requireThat(layout.mainAisles?.length===4&&new Set(layout.mainAisles.map(a=>a.id)).size===4&&
    ['east','west'].every(side=>layout.mainAisles.filter(a=>a.side===side).length===2)&&
    layout.mainAisles.every(a=>a.direction==='unresolved'&&a.laneCount===null&&a.simultaneousPassing==='unresolved'),
    'Main aisle count is four; individual direction and lane conditions remain unresolved');
  requireThat(corridors.get('WH-ROW').laneCount===1&&corridors.get('WH-ROW').direction==='both'&&
    corridors.get('WH-ROW').simultaneousPassing==='no-alternating','Warehouse rows cannot allow side-by-side passing');
  const service=layout.service;
  requireThat(service?.waitingPlaces?.length===2&&service.chargePlaces?.length===2&&service.chargers?.length===2&&
    service.aligners?.length===5&&new Set([...service.waitingPlaces,...service.chargePlaces].map(p=>p.id)).size===4&&
    service.chargePlaces.every(p=>p.chargerId===null)&&service.accessFrom==='east-main-aisles'&&
    service.accessEvidence==='user-confirmed'&&service.branchAssignment==='unresolved',
    'Service waiting and charging places must be separate; east group access is confirmed, branches unresolved');
  requireThat(service.waitingCandidates?.totalCount===4&&service.waitingCandidates?.groups?.length===2&&
    service.waitingCandidates.groups.find(group=>group.kind==='south-service')?.count===2&&
    service.waitingCandidates.groups.find(group=>group.kind==='fire-shutter-pillars')?.count===2&&
    service.waitingCandidates.wsIdMapping==='unresolved',
    'Four waiting candidates must retain two south-service and two fire-shutter pillar candidates');
  requireThat(service.emptyPalletStorage?.agfAccess==='forbidden'&&service.emptyPalletStorage.routeNodes?.length===0,
    'Empty pallet storage is forbidden and must not contain route nodes');
  return {
    areas: areas.size, corridors: corridors.size, links: links.size,
    confirmedLinks: [...links.values()].filter(x => x.status === 'confirmed').length,
    unresolvedLinks: [...links.values()].filter(x => x.status !== 'confirmed').length
  };
}

/**
 * Returns only a sequence of confirmed conceptual corridor IDs.
 * It does not return a path for an unresolved entry/exit, row slot or inter-area link.
 */
export function findConceptualPath(map, startCorridorId, endCorridorId) {
  validateLogicalMap(map);
  const corridors = new Map(map.corridors.map(c => [c.id, c]));
  requireThat(corridors.has(startCorridorId) && corridors.has(endCorridorId),
    'Unknown start/end corridor');
  if (corridors.get(startCorridorId).access !== 'allowed' ||
      corridors.get(endCorridorId).access !== 'allowed') return null;
  const adjacency = new Map([...corridors.keys()].map(id => [id, []]));
  for (const link of map.links) {
    if (link.status !== 'confirmed') continue;
    if (link.direction !== 'reverse') adjacency.get(link.from).push(link.to);
    if (link.direction !== 'forward') adjacency.get(link.to).push(link.from);
  }
  const queue = [startCorridorId], previous = new Map([[startCorridorId, null]]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current === endCorridorId) {
      const path = [];
      for (let at = current; at !== null; at = previous.get(at)) path.unshift(at);
      return {kind: 'conceptual-only', measuredDistanceMm: null, etaMs: null, corridors: path};
    }
    for (const next of adjacency.get(current)) {
      if (!previous.has(next)) {
        previous.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}
