const required=(condition,message)=>{if(!condition)throw new Error(message);};
const movements=new Set(['empty','loaded','charge','wait']);
const laneDirections=new Set(['forward','reverse','both']);
const nodeTypes=new Set(['home','pickup','dropoff','charge','wait','shutter-wait','junction','turn','passage']);

const uniqueMap=(items,label)=>{
  required(Array.isArray(items),label+' must be an array');
  const map=new Map();
  for(const item of items){
    required(item?.id&&!map.has(item.id),label+' duplicate or missing id');
    map.set(item.id,item);
  }
  return map;
};

export function validateOperationalTopology(graph){
  required(graph?.schemaVersion==='operational-topology-v1','Expected operational-topology-v1');
  required(graph.datasetKind==='synthetic','public synthetic validator rejects non-synthetic datasets');
  required(graph.evidence==='synthetic-assumption','synthetic evidence is required');
  required(graph.coordinateSystem==='synthetic-display','synthetic display coordinate system is required');
  required(graph.readiness?.operationalRoutingReady===true&&graph.readiness?.physicalEtaAllowed===false,
    'synthetic routing must not claim physical ETA');
  const nodes=uniqueMap(graph.nodes,'nodes'),edges=uniqueMap(graph.edges,'edges');
  const laneIds=new Set();
  for(const node of nodes.values()){
    required(nodeTypes.has(node.type),'invalid node type '+node.id);
    required(Number.isFinite(node.x)&&Number.isFinite(node.y),'synthetic display coordinates required '+node.id);
    required(node.approvalState==='synthetic-validated','invalid node approval '+node.id);
    required(['PZ','WH','INTER'].includes(node.areaId),'invalid node area '+node.id);
  }
  for(const edge of edges.values()){
    required(nodes.has(edge.fromNodeId)&&nodes.has(edge.toNodeId)&&edge.fromNodeId!==edge.toNodeId,
      'invalid edge endpoints '+edge.id);
    required(Number.isFinite(edge.distanceMm)&&edge.distanceMm>0,'invalid distance '+edge.id);
    for(const movement of ['empty','loaded','charge',...(edge.accessScopes?.some(s=>s.movement==='wait')?['wait']:[])])required(Number.isFinite(edge.speedMmPerSec?.[movement])&&
      edge.speedMmPerSec[movement]>0,'invalid speed '+edge.id+'/'+movement);
    required(edge.approvalState==='synthetic-validated','invalid edge approval '+edge.id);
    if(edge.displayPath){
      const points=edge.displayPath,from=nodes.get(edge.fromNodeId),to=nodes.get(edge.toNodeId);
      required(Array.isArray(points)&&points.length>=2&&points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)),
        'invalid synthetic display path '+edge.id);
      required(points[0].x===from.x&&points[0].y===from.y&&points.at(-1).x===to.x&&points.at(-1).y===to.y,
        'display path endpoints must match nodes '+edge.id);
      required(points.every((p,i)=>!i||p.x!==points[i-1].x||p.y!==points[i-1].y),'zero display segment '+edge.id);
    }
    required(Array.isArray(edge.accessScopes),'accessScopes required '+edge.id);
    for(const scope of edge.accessScopes){
      required(movements.has(scope.movement),'invalid movement '+edge.id);
      required(Array.isArray(scope.taskTypes)&&scope.taskTypes.length,'task types required '+edge.id);
    }
    required(Array.isArray(edge.lanes)&&edge.lanes.length===edge.lanePolicy?.laneCount,
      'lane count mismatch '+edge.id);
    for(const lane of edge.lanes){
      required(lane.id&&!laneIds.has(lane.id),'duplicate lane '+lane.id);
      required(laneDirections.has(lane.direction),'invalid lane direction '+edge.id);
      laneIds.add(lane.id);
    }
    required(['yes','no-alternating','controlled'].includes(edge.lanePolicy.simultaneousPassing),
      'invalid passing policy '+edge.id);
    required(Array.isArray(edge.occupancyResourceIds),'occupancy resources required '+edge.id);
  }
  required(Array.isArray(graph.interfaceBindings)&&graph.interfaceBindings.every(binding=>
    binding.pattern&&nodes.has(binding.nodeId)),'invalid interface bindings');
  const gates=uniqueMap(graph.shutters??[],'shutters');
  for(const edge of edges.values())if(edge.shutterId)required(gates.has(edge.shutterId),'unknown shutter '+edge.id);
  return {datasetKind:graph.datasetKind,nodes:nodes.size,edges:edges.size,lanes:laneIds.size};
}

export function resolveInterfaceNode(graph,interfaceId){
  validateOperationalTopology(graph);
  const exact=graph.interfaceBindings.find(binding=>binding.pattern===interfaceId);
  if(exact)return exact.nodeId;
  const wildcard=graph.interfaceBindings.filter(binding=>binding.pattern.endsWith('*'))
    .sort((a,b)=>b.pattern.length-a.pattern.length||a.pattern.localeCompare(b.pattern,'en'))
    .find(binding=>interfaceId.startsWith(binding.pattern.slice(0,-1)));
  return wildcard?.nodeId??null;
}

const supports=(edge,movement,taskType)=>edge.accessScopes.some(scope=>
  scope.movement===movement&&(scope.taskTypes.includes('*')||scope.taskTypes.includes(taskType)));
const traversals=edge=>{
  const output=[];
  if(edge.lanes.some(lane=>lane.direction==='forward'||lane.direction==='both'))
    output.push({from:edge.fromNodeId,to:edge.toNodeId,traversal:'forward'});
  if(edge.lanes.some(lane=>lane.direction==='reverse'||lane.direction==='both'))
    output.push({from:edge.toNodeId,to:edge.fromNodeId,traversal:'reverse'});
  return output;
};

export function findOperationalPath(graph,startNodeId,endNodeId,{movement,taskType}){
  validateOperationalTopology(graph);
  required(movements.has(movement)&&typeof taskType==='string','movement and taskType required');
  const nodes=new Map(graph.nodes.map(node=>[node.id,node]));
  required(nodes.has(startNodeId)&&nodes.has(endNodeId),'unknown path endpoint');
  if(startNodeId===endNodeId)return {kind:'synthetic-operational',movement,taskType,
    etaStatus:'synthetic-assumption',measuredDistanceMm:null,modelDistanceMm:0,modelDurationMs:0,steps:[]};
  const adjacency=new Map(graph.nodes.map(node=>[node.id,[]]));
  for(const edge of graph.edges.filter(edge=>supports(edge,movement,taskType)).sort((a,b)=>a.id.localeCompare(b.id,'en'))){
    const durationMs=Math.ceil(edge.distanceMm*1000/edge.speedMmPerSec[movement]);
    for(const traversal of traversals(edge))adjacency.get(traversal.from).push({
      edgeId:edge.id,fromNodeId:traversal.from,toNodeId:traversal.to,traversal:traversal.traversal,
      distanceMm:edge.distanceMm,durationMs,shutterId:edge.shutterId??null,
      ...(edge.displayPath?{displayPath:structuredClone(traversal.traversal==='forward'?edge.displayPath:edge.displayPath.toReversed())}:{})
    });
  }
  const best=new Map([[startNodeId,{duration:0,key:'',previous:null,step:null}]]),pending=[startNodeId];
  while(pending.length){
    pending.sort((left,right)=>{
      const a=best.get(left),b=best.get(right);
      return a.duration-b.duration||a.key.localeCompare(b.key,'en')||left.localeCompare(right,'en');
    });
    const current=pending.shift();
    if(current===endNodeId)break;
    const state=best.get(current);
    for(const step of adjacency.get(current)){
      const duration=state.duration+step.durationMs,key=state.key+'|'+step.edgeId;
      const old=best.get(step.toNodeId);
      if(!old||duration<old.duration||(duration===old.duration&&key.localeCompare(old.key,'en')<0)){
        best.set(step.toNodeId,{duration,key,previous:current,step});
        if(!pending.includes(step.toNodeId))pending.push(step.toNodeId);
      }
    }
  }
  if(!best.has(endNodeId))return null;
  const steps=[];
  for(let node=endNodeId;node!==startNodeId;node=best.get(node).previous)steps.unshift(best.get(node).step);
  return {kind:'synthetic-operational',movement,taskType,etaStatus:'synthetic-assumption',
    measuredDistanceMm:null,modelDistanceMm:steps.reduce((sum,step)=>sum+step.distanceMm,0),
    modelDurationMs:steps.reduce((sum,step)=>sum+step.durationMs,0),steps};
}
