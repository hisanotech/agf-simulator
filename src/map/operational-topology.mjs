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
    if(node.equipmentId){
      required(node.interfaceId&&node.evidence==='synthetic-device-interface-not-site-stop',
        'synthetic device interface evidence required '+node.id);
      required(['pickup','dropoff'].includes(node.type),'device interface must be an individual stop '+node.id);
      required(nodes.has(node.accessNodeId),'device interface access node required '+node.id);
    }
    for(const field of ['occupancyResourceIds','handlingResourceIds'])if(node[field]!==undefined)
      required(Array.isArray(node[field])&&node[field].every(id=>typeof id==='string'&&id.length>0),
        'invalid '+field+' '+node.id);
    if(node.handlingGroupId!==undefined)required(typeof node.handlingGroupId==='string'&&node.handlingGroupId.length>0,
      'invalid handling group '+node.id);
    if(node.exclusiveTraffic!==undefined)required(typeof node.exclusiveTraffic==='boolean',
      'invalid exclusive traffic flag '+node.id);
    if(node.localHandlingBlockedEdgeIds!==undefined){
      required(Array.isArray(node.localHandlingBlockedEdgeIds)&&
        node.localHandlingBlockedEdgeIds.every(id=>edges.has(id)), 'invalid local handling edges '+node.id);
      required(node.handlingScopeEvidence==='synthetic-equipment-front-edge-declaration-not-site-boundary',
        'synthetic local handling scope evidence required '+node.id);
    }
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
      if(lane.resourceId!==undefined)required(typeof lane.resourceId==='string'&&lane.resourceId.length>0,
        'invalid lane resource '+edge.id);
      laneIds.add(lane.id);
    }
    required(['yes','no-alternating','controlled'].includes(edge.lanePolicy.simultaneousPassing),
      'invalid passing policy '+edge.id);
    required(Array.isArray(edge.occupancyResourceIds),'occupancy resources required '+edge.id);
    if(edge.noOvertakingGroupId!==undefined){
      required(typeof edge.noOvertakingGroupId==='string'&&edge.noOvertakingGroupId.length>0,
        'invalid no-overtaking group '+edge.id);
      required(typeof edge.noOvertakingForwardDirection==='string'&&edge.noOvertakingForwardDirection.length>0,
        'no-overtaking forward direction required '+edge.id);
    }
  }
  required(Array.isArray(graph.interfaceBindings)&&graph.interfaceBindings.every(binding=>
    binding.pattern&&nodes.has(binding.nodeId)),'invalid interface bindings');
  const gates=uniqueMap(graph.shutters??[],'shutters');
  for(const edge of edges.values())if(edge.shutterId)required(gates.has(edge.shutterId),'unknown shutter '+edge.id);
  if(graph.avoidancePlans!==undefined){
    const plans=uniqueMap(graph.avoidancePlans,'avoidance plans');
    for(const plan of plans.values()){
      required(plan.evidence==='synthetic-assumption','synthetic avoidance plan evidence required '+plan.id);
      required(nodes.has(plan.fromNodeId)&&nodes.has(plan.viaNodeId)&&plan.fromNodeId!==plan.viaNodeId,
        'invalid avoidance stop '+plan.id);
      required(typeof plan.conflictGroupId==='string'&&plan.conflictGroupId.length>0,'avoidance conflict group required '+plan.id);
      const checkRoute=(edgeIds,fromId,toId)=>{
        required(Array.isArray(edgeIds)&&edgeIds.length>0,'explicit avoidance edges required '+plan.id);
        let current=fromId;
        for(const id of edgeIds){
          const edge=edges.get(id);required(edge,'unknown avoidance edge '+id);
          const traversal=traversals(edge).find(t=>t.from===current);
          required(traversal,'disconnected or forbidden avoidance edge '+id);current=traversal.to;
        }
        required(current===toId,'avoidance route endpoint mismatch '+plan.id);
      };
      checkRoute(plan.outboundEdgeIds,plan.fromNodeId,plan.viaNodeId);
      checkRoute(plan.returnEdgeIds,plan.viaNodeId,plan.fromNodeId);
    }
  }
  if(graph.overtakingPlans!==undefined){
    const plans=uniqueMap(graph.overtakingPlans,'overtaking plans');
    for(const plan of plans.values()){
      required(plan.evidence==='synthetic-assumption','synthetic overtaking plan evidence required '+plan.id);
      required([plan.blockedNodeId,plan.fromNodeId,plan.rejoinNodeId].every(id=>nodes.has(id))&&
        plan.fromNodeId!==plan.rejoinNodeId,'invalid overtaking plan stops '+plan.id);
      required(Array.isArray(plan.resourceIds)&&plan.resourceIds.length>=4&&
        plan.resourceIds.every(id=>typeof id==='string'&&id.length>0)&&
        new Set(plan.resourceIds).size===plan.resourceIds.length,'four explicit overtaking clearance resources required '+plan.id);
      required(Array.isArray(plan.edgeIds)&&plan.edgeIds.length>0&&
        Array.isArray(plan.temporaryReverseEdgeIds)&&
        plan.temporaryReverseEdgeIds.every(id=>plan.edgeIds.includes(id)), 'explicit overtaking edges required '+plan.id);
      let current=plan.fromNodeId;
      for(const id of plan.edgeIds){
        const edge=edges.get(id);required(edge,'unknown overtaking edge '+id);
        let traversal=traversals(edge).find(t=>t.from===current);
        if(!traversal&&plan.temporaryReverseEdgeIds.includes(id)&&edge.toNodeId===current)
          traversal={from:edge.toNodeId,to:edge.fromNodeId};
        required(traversal,'disconnected or undeclared reverse overtaking edge '+id);current=traversal.to;
      }
      required(current===plan.rejoinNodeId,'overtaking route endpoint mismatch '+plan.id);
    }
  }
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
      ...(edge.noOvertakingGroupId?{noOvertakingGroupId:edge.noOvertakingGroupId,
        noOvertakingForwardDirection:edge.noOvertakingForwardDirection}:{}),
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

// Display coordinates locate synthetic turns only. Distances are apportioned
// equally from the input model distance, never measured from the drawing.
// The caller must use the returned graph for both scheduling and replay.
export function splitSyntheticDisplayTurns(input){
  validateOperationalTopology(input);
  const graph=structuredClone(input),nodeMap=new Map(graph.nodes.map(node=>[node.id,node]));
  const reservedIds=new Set([...graph.nodes.map(n=>n.id),...graph.edges.map(e=>e.id),
    ...graph.edges.flatMap(e=>e.lanes.map(l=>l.id))]);
  const uniqueId=base=>{let id=base,n=2;while(reservedIds.has(id))id=base+'-'+n++;reservedIds.add(id);return id;};
  const splitMap=new Map(),output=[];
  for(const source of graph.edges){
    if(!source.displayPath||source.displayPath.length<=2){output.push(source);continue;}
    const points=source.displayPath,segments=points.length-1,ids=[source.fromNodeId];
    for(let index=1;index<points.length-1;index++){
      const id=uniqueId(source.id+'-TURN'+index),from=nodeMap.get(source.fromNodeId),to=nodeMap.get(source.toNodeId);
      const node={id,type:'turn',areaId:from.areaId===to.areaId?from.areaId:'INTER',...points[index],
        approvalState:'synthetic-validated',evidence:'synthetic-assumption',
        turnPositionEvidence:'derived-synthetic-display-bend-not-site-turn',
        exclusiveTraffic:true,occupancyResourceIds:['synthetic-turn:'+id]};
      graph.nodes.push(node);nodeMap.set(id,node);ids.push(id);
    }
    ids.push(source.toNodeId);
    const distances=[],equal=source.distanceMm/segments;
    for(let index=0,allocated=0;index<segments;index++){
      const distance=index===segments-1?source.distanceMm-allocated:equal;
      distances.push(distance);allocated+=distance;
    }
    const partIds=[];
    for(let index=0;index<segments;index++){
      const id=index===0?source.id:uniqueId(source.id+'-PART'+(index+1));partIds.push(id);
      const shared=source.lanes.length===1?[source.lanes[0].resourceId??source.lanes[0].id]:[];
      const junctionResources=[...(nodeMap.get(ids[index]).occupancyResourceIds??[]),
        ...(nodeMap.get(ids[index+1]).occupancyResourceIds??[])];
      output.push({...source,id,fromNodeId:ids[index],toNodeId:ids[index+1],distanceMm:distances[index],
        lanes:source.lanes.map(lane=>({...lane,id:index===0?lane.id:uniqueId(lane.id+'-PART'+(index+1)),
          resourceId:lane.resourceId??lane.id})),
        occupancyResourceIds:[...new Set([...source.occupancyResourceIds,...shared,...junctionResources])],
        displayPath:[points[index],points[index+1]],splitSourceEdgeId:source.id,splitPartIndex:index,
        splitSourceDistanceMm:source.distanceMm,
        modelDistanceEvidence:'explicit-synthetic-equal-segment-allocation-not-display-length'});
    }
    splitMap.set(source.id,partIds);
  }
  graph.edges=output;
  for(const node of graph.nodes)if(node.localHandlingBlockedEdgeIds)
    node.localHandlingBlockedEdgeIds=node.localHandlingBlockedEdgeIds.flatMap(id=>splitMap.get(id)??[id]);
  for(const plan of graph.avoidancePlans??[])for(const field of ['outboundEdgeIds','returnEdgeIds']){
    let current=field==='outboundEdgeIds'?plan.fromNodeId:plan.viaNodeId;
    plan[field]=plan[field].flatMap(id=>{
      const source=input.edges.find(edge=>edge.id===id),forward=source.fromNodeId===current;
      current=forward?source.toNodeId:source.fromNodeId;
      const parts=splitMap.get(id)??[id];return forward?parts:parts.toReversed();
    });
  }
  for(const plan of graph.overtakingPlans??[]){
    const reverse=new Set(plan.temporaryReverseEdgeIds),newReverse=[];
    let current=plan.fromNodeId;
    plan.edgeIds=plan.edgeIds.flatMap(id=>{
      const source=input.edges.find(edge=>edge.id===id),forward=source.fromNodeId===current;
      current=forward?source.toNodeId:source.fromNodeId;
      const parts=splitMap.get(id)??[id];if(reverse.has(id))newReverse.push(...parts);
      return forward?parts:parts.toReversed();
    });
    plan.temporaryReverseEdgeIds=newReverse;
  }
  validateOperationalTopology(graph);
  return graph;
}
