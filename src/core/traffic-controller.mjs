const allowed=(lane,traversal)=>lane.direction==='both'||lane.direction===traversal;
const required=(condition,message)=>{if(!condition)throw new Error(message);};
const positioningPhases=new Set(['positioning_pickup','positioning_dropoff']);
const forkPhases=new Set(['picking_fork_inserted','dropping_fork_inserted']);
const opposite={east:'west',west:'east',north:'south',south:'north',forward:'reverse',reverse:'forward'};

export function createTrafficController(edges,{nodes=[]}={}){
  const edgeMap=new Map(edges.map(edge=>[edge.id,edge]));
  const exclusiveNodes=new Set(nodes.filter(node=>node.exclusiveTraffic===true).map(node=>node.id));
  const nodeOccupants=new Map(),nodeReservations=new Map(),overtaking=new Map();
  const owners=new Map(),held=new Map(),waits=new Map(),activeEdges=new Map();
  // Groups are explicit logical declarations, never inferred from drawing positions.
  // A stopped follower is conservative: no unspecified separation/speed is assumed.
  const following=new Map(),handling=new Map();let groupSequence=0;
  const owner=resourceId=>owners.get(resourceId)??null;
  const blockersFor=resources=>[...new Set(resources.map(owner).filter(Boolean))].sort();
  const hold=(agfId,resources)=>{
    for(const resource of resources)owners.set(resource,agfId);
    held.set(agfId,[...new Set([...(held.get(agfId)??[]),...resources])]);
  };
  const leaveGroup=agfId=>following.delete(agfId);
  const groupDirection=(edge,traversal,explicit)=>{
    if(!edge.noOvertakingGroupId)return null;
    const direction=explicit??(traversal==='forward'?edge.noOvertakingForwardDirection:
      opposite[edge.noOvertakingForwardDirection]);
    required(typeof direction==='string'&&direction.length,'explicit no-overtaking group direction required '+edge.id);
    return direction;
  };
  const joinGroup=(agfId,groupId,direction,requestOrder,positionNodeId=null)=>{
    const current=following.get(agfId);
    if(current?.groupId===groupId&&current.direction===direction){
      if(positionNodeId!==null)current.positionNodeId=positionNodeId;
      return current;
    }
    const member={agfId,groupId,direction,requestOrder,positionNodeId,order:++groupSequence,evidence:'event-request-order'};
    following.set(agfId,member);return member;
  };
  const ordered=()=>[...following.values()].sort((a,b)=>a.order-b.order);
  const groupReachability=new Map();
  const reachable=(groupId,direction,from,to)=>{
    const key=groupId+'\u0000'+direction;
    if(!groupReachability.has(key)){
      const adjacency=new Map();
      for(const edge of edges){
        if(edge.noOvertakingGroupId!==groupId)continue;
        for(const traversal of ['forward','reverse']){
          if(groupDirection(edge,traversal)!==direction||!edge.lanes.some(lane=>allowed(lane,traversal)))continue;
          const source=traversal==='forward'?edge.fromNodeId:edge.toNodeId;
          const target=traversal==='forward'?edge.toNodeId:edge.fromNodeId;
          adjacency.set(source,[...(adjacency.get(source)??[]),target]);
        }
      }
      groupReachability.set(key,adjacency);
    }
    const adjacency=groupReachability.get(key),visited=new Set([from]),pending=[from];
    while(pending.length){
      for(const next of adjacency.get(pending.shift())??[]){
        if(next===to)return true;
        if(!visited.has(next)){visited.add(next);pending.push(next);}
      }
    }
    return false;
  };
  const aheadOf=(candidate,member)=>{
    if(candidate.positionNodeId&&member.positionNodeId&&candidate.positionNodeId!==member.positionNodeId){
      // Directed logical progression distinguishes a vehicle already ahead from a later group registration.
      // Drawing coordinates and registration time do not establish physical front/back order.
      const candidateAhead=reachable(member.groupId,member.direction,member.positionNodeId,candidate.positionNodeId);
      const memberAhead=reachable(member.groupId,member.direction,candidate.positionNodeId,member.positionNodeId);
      if(candidateAhead!==memberAhead)return candidateAhead;
    }
    return candidate.order<member.order;
  };
  const blockersInGroup=(member,edgeId=null,ignoreAgfId=null)=>{
    const {agfId,groupId,direction}=member;
    const positioning=[...handling].filter(([id,state])=>id!==agfId&&id!==ignoreAgfId&&state.groupId===groupId&&
      positioningPhases.has(state.phase)&&(!state.blockedEdgeIds||state.blockedEdgeIds.includes(edgeId))).map(([id])=>id);
    if(positioning.length)return {blockers:positioning,reason:'HANDLING_POSITIONING'};
    const leaders=ordered().filter(other=>other.agfId!==agfId&&other.agfId!==ignoreAgfId&&other.groupId===groupId&&
      other.direction===direction&&aheadOf(other,member)).map(other=>other.agfId);
    return leaders.length?{blockers:leaders,reason:'NO_OVERTAKING'}:null;
  };
  const groupBlocked=(agfId,groupId,direction,requestOrder,edgeId=null,ignoreAgfId=null,positionNodeId=null)=>
    blockersInGroup(joinGroup(agfId,groupId,direction,requestOrder,positionNodeId),edgeId,ignoreAgfId);
  const futureGroupBlocked=(agfId,edge,step,requestOrder,ignoreAgfId=null)=>{
    if(!edge.noOvertakingGroupId)return null;
    const groupId=edge.noOvertakingGroupId,direction=groupDirection(edge,step.traversal);
    const current=following.get(agfId);
    const member={agfId,groupId,direction,requestOrder,positionNodeId:step.fromNodeId,
      order:current?.groupId===groupId&&current.direction===direction?current.order:groupSequence+1};
    // Preview the future constraint without registering the vehicle in a group
    // it has not entered. A rear approach must not reserve a shared conflict
    // zone that its already-ahead leader still needs in order to leave.
    return blockersInGroup(member,step.edgeId,ignoreAgfId);
  };
  const wait=(agfId,blockers,requestOrder,reason)=>{
    const unique=[...new Set(blockers)].sort();
    waits.set(agfId,{blockers:unique,requestOrder,reason});
    return {entered:false,laneId:null,resources:[],blockers:unique,reason};
  };
  return {
    recoveryPolicy:'detect-only',
    tryEnter({agfId,edgeId,traversal,requestOrder=0,groupDirection:explicitDirection,overtakingPlanId=null,
      fromNodeId=null,toNodeId=null,lookaheadSteps=[]}){
      const edge=edgeMap.get(edgeId);
      if(!edge)throw new Error('unknown traffic edge '+edgeId);
      if(activeEdges.has(agfId))throw new Error('AGF already holds traffic resources '+agfId);
      if(!['yes','no-alternating','controlled'].includes(edge.lanePolicy?.simultaneousPassing))
        throw new Error('explicit passing policy required '+edgeId);
      const lease=overtaking.get(agfId),leaseStep=lease?.steps[lease.stepIndex];
      if(overtakingPlanId||lease)required(lease&&(!overtakingPlanId||lease.planId===overtakingPlanId)&&
        leaseStep?.edgeId===edgeId&&leaseStep.traversal===traversal,'overtaking planned step mismatch');
      const directionException=!!leaseStep?.temporaryDirectionException&&lease.temporaryReverseEdgeIds.includes(edgeId);
      const lanes=edge.lanes.filter(lane=>allowed(lane,traversal)||directionException).sort((a,b)=>a.id.localeCompare(b.id,'en'));
      if(!lanes.length)throw new Error('edge has no lane for '+traversal);
      const from=fromNodeId??(traversal==='forward'?edge.fromNodeId:edge.toNodeId);
      const to=toNodeId??(traversal==='forward'?edge.toNodeId:edge.fromNodeId);
      required(from===(traversal==='forward'?edge.fromNodeId:edge.toNodeId)&&
        to===(traversal==='forward'?edge.toNodeId:edge.fromNodeId),'traffic edge endpoint mismatch');
      const targetBlockers=exclusiveNodes.has(to)?[nodeOccupants.get(to),nodeReservations.get(to)].filter(id=>id&&id!==agfId):[];
      if(targetBlockers.length)return wait(agfId,targetBlockers,requestOrder,'TARGET_NODE_OCCUPIED');
      required(Array.isArray(lookaheadSteps),'traffic lookahead must be explicit route steps');
      const futureResources=[],futureNodes=[];
      let passageId=edge.atomicPassageId??null;
      const futureSteps=[];
      // Adjacent explicit merges may lead directly into one declared atomic
      // passage. Check its far end before holding an approach junction that
      // the opposite vehicle would need to leave. Ordinary travel ends this
      // narrow reservation span; it is never a whole-route reservation.
      for(const step of lookaheadSteps){
        const futureEdge=edgeMap.get(step.edgeId);
        if(passageId){if(futureEdge?.atomicPassageId!==passageId)break;}
        else if(futureEdge?.atomicPassageId)passageId=futureEdge.atomicPassageId;
        else if(!futureEdge?.mergeConflictResourceId)break;
        futureSteps.push(step);
      }
      let previousNodeId=to;
      for(const futureStep of futureSteps){
        const futureEdge=edgeMap.get(futureStep.edgeId);
        required(futureStep.fromNodeId===previousNodeId&&['forward','reverse'].includes(futureStep.traversal)&&
          futureStep.fromNodeId===(futureStep.traversal==='forward'?futureEdge.fromNodeId:futureEdge.toNodeId)&&
          futureStep.toNodeId===(futureStep.traversal==='forward'?futureEdge.toNodeId:futureEdge.fromNodeId),
          'declared merge lookahead endpoint mismatch');
        required(futureEdge.lanes.some(lane=>allowed(lane,futureStep.traversal)),'merge lookahead direction forbidden');
        const futureFollowing=futureGroupBlocked(agfId,futureEdge,futureStep,requestOrder,lease?.blockedAgfId);
        if(futureFollowing)return wait(agfId,futureFollowing.blockers,requestOrder,futureFollowing.reason);
        futureNodes.push(...[futureStep.fromNodeId,futureStep.toNodeId].filter(id=>exclusiveNodes.has(id)));
        const futureBlockers=futureNodes.flatMap(id=>[nodeOccupants.get(id),nodeReservations.get(id)])
          .filter(id=>id&&id!==agfId);
        if(futureBlockers.length)return wait(agfId,futureBlockers,requestOrder,'TARGET_NODE_OCCUPIED');
        futureResources.push(...(futureEdge.mergeConflictResourceId?[futureEdge.mergeConflictResourceId]:[]),
          ...futureEdge.lanes.map(lane=>lane.resourceId??lane.id),
          ...futureEdge.occupancyResourceIds,...futureNodes.map(id=>'node:'+id),
          ...(futureEdge.lanePolicy.simultaneousPassing==='yes'?[]:['edge:'+futureEdge.id]));
        previousNodeId=futureStep.toNodeId;
      }
      const localPositioning=[...handling].filter(([id,state])=>id!==agfId&&id!==lease?.blockedAgfId&&
        positioningPhases.has(state.phase)&&state.blockedEdgeIds?.includes(edgeId)).map(([id])=>id);
      if(localPositioning.length)return wait(agfId,localPositioning,requestOrder,'HANDLING_POSITIONING');
      const direction=groupDirection(edge,traversal,explicitDirection),groupId=edge.noOvertakingGroupId;
      if(groupId){
        const blocked=groupBlocked(agfId,groupId,direction,requestOrder,edgeId,lease?.blockedAgfId,from);
        if(blocked)return wait(agfId,blocked.blockers,requestOrder,blocked.reason);
      }else leaveGroup(agfId);
      const sharedResources=[...edge.occupancyResourceIds,
        ...[from,to].filter(id=>exclusiveNodes.has(id)).map(id=>'node:'+id),
        ...(edge.lanePolicy.simultaneousPassing==='yes'?[]:['edge:'+edgeId]),...futureResources];
      for(const lane of lanes){
        const resources=[...new Set([lane.resourceId??lane.id,...sharedResources])];
        const blockers=blockersFor(resources).filter(id=>id!==agfId);
        if(!blockers.length){
          hold(agfId,resources);activeEdges.set(agfId,edgeId);waits.delete(agfId);
          if(exclusiveNodes.has(to))nodeReservations.set(to,agfId);
          for(const nodeId of futureNodes)nodeReservations.set(nodeId,agfId);
          return {entered:true,laneId:lane.id,resources,futureResourceIds:[...new Set(futureResources)],
            ...(groupId?{noOvertakingGroupId:groupId,groupDirection:direction}:{})};
        }
      }
      const resources=[...lanes.map(lane=>lane.resourceId??lane.id),...sharedResources];
      const blockers=blockersFor(resources).filter(id=>id!==agfId);
      return wait(agfId,blockers,requestOrder,'OCCUPIED');
    },
    reserveResources({agfId,resourceIds,requestOrder=0,groupId=null,groupDirection:direction=null,edgeId=null,fromNodeId=null}){
      required(Array.isArray(resourceIds)&&resourceIds.every(id=>typeof id==='string'&&id.length),
        'explicit traffic resource IDs required');
      if(groupId)required(typeof direction==='string'&&direction.length,'explicit reservation group direction required');
      if(groupId){
        const blocked=groupBlocked(agfId,groupId,direction,requestOrder,edgeId,overtaking.get(agfId)?.blockedAgfId,fromNodeId);
        if(blocked)return wait(agfId,blocked.blockers,requestOrder,blocked.reason);
      }
      const resources=[...new Set(resourceIds)],blockers=blockersFor(resources).filter(id=>id!==agfId);
      if(blockers.length)return wait(agfId,blockers,requestOrder,'OCCUPIED');
      hold(agfId,resources);waits.delete(agfId);
      return {entered:true,resources,blockers:[]};
    },
    releaseResources(agfId,resourceIds){
      required(Array.isArray(resourceIds),'resource IDs must be an array');
      const leased=new Set(overtaking.get(agfId)?.resourceIds??[]);
      const removed=new Set(resourceIds.filter(id=>!leased.has(id)));
      for(const resource of removed)if(owner(resource)===agfId)owners.delete(resource);
      const remaining=(held.get(agfId)??[]).filter(id=>!removed.has(id));
      if(remaining.length)held.set(agfId,remaining);else held.delete(agfId);
    },
    release(agfId,{keepFollowingOrder=false,retainResourceIds=[]}={}){
      const retained=new Set([...retainResourceIds,...(overtaking.get(agfId)?.resourceIds??[])]);
      const resources=held.get(agfId)??[];
      for(const resource of resources)if(!retained.has(resource)&&owner(resource)===agfId)owners.delete(resource);
      const remaining=resources.filter(id=>retained.has(id));
      if(remaining.length)held.set(agfId,remaining);else held.delete(agfId);
      if(activeEdges.has(agfId)&&overtaking.has(agfId))overtaking.get(agfId).stepIndex++;
      activeEdges.delete(agfId);waits.delete(agfId);
      if(!keepFollowingOrder)leaveGroup(agfId);
    },
    leaveGroup,
    setHandlingPhase({agfId,groupId,phase,resourceIds=[],blockedEdgeIds=null}){
      required(typeof groupId==='string'&&groupId.length,'explicit handling group required');
      required(positioningPhases.has(phase)||forkPhases.has(phase),'unknown handling phase '+phase);
      required(Array.isArray(resourceIds)&&resourceIds.every(id=>typeof id==='string'&&id.length),
        'explicit handling resource IDs required');
      if(blockedEdgeIds!==null)required(Array.isArray(blockedEdgeIds)&&blockedEdgeIds.every(id=>edgeMap.has(id)),
        'unknown explicit handling edge');
      const blockers=blockersFor(resourceIds).filter(id=>id!==agfId);
      if(blockers.length)return wait(agfId,blockers,0,'OCCUPIED');
      hold(agfId,resourceIds);handling.set(agfId,{groupId,phase,resourceIds:[...resourceIds],
        ...(blockedEdgeIds!==null?{blockedEdgeIds:[...blockedEdgeIds]}:{})});
      if(forkPhases.has(phase)||blockedEdgeIds!==null)leaveGroup(agfId);
      waits.delete(agfId);
      return {entered:true,resources:[...resourceIds],blockers:[]};
    },
    clearHandlingPhase(agfId){
      handling.delete(agfId);
    },
    setNodeOccupant({agfId,nodeId}){
      if(!exclusiveNodes.has(nodeId))return;
      required(!nodeOccupants.has(nodeId)||nodeOccupants.get(nodeId)===agfId,'exclusive node occupied '+nodeId);
      required(!nodeReservations.has(nodeId)||nodeReservations.get(nodeId)===agfId,'exclusive node reserved '+nodeId);
      nodeOccupants.set(nodeId,agfId);
    },
    depart({agfId,fromNodeId}){
      if(nodeOccupants.get(fromNodeId)===agfId)nodeOccupants.delete(fromNodeId);
    },
    commitArrival({agfId,nodeId}){
      if(following.has(agfId))following.get(agfId).positionNodeId=nodeId;
      if(!exclusiveNodes.has(nodeId))return;
      required(nodeReservations.get(nodeId)===agfId||nodeOccupants.get(nodeId)===agfId,
        'exclusive node arrival without reservation '+nodeId);
      required(!nodeOccupants.has(nodeId)||nodeOccupants.get(nodeId)===agfId,'exclusive node occupied '+nodeId);
      nodeReservations.delete(nodeId);nodeOccupants.set(nodeId,agfId);
    },
    cancelNodeReservation(agfId){
      for(const [nodeId,owner] of nodeReservations)if(owner===agfId)nodeReservations.delete(nodeId);
    },
    reserveOvertaking({agfId,blockedAgfId,blockedAgf,regularBlocked,plan,requestOrder=0}){
      required(canOvertakeWaitingWrapper({blockedAgf,regularBlocked})&&blockedAgf.id===blockedAgfId,
        'overtaking requires stopped waiting-wrapper-input AGF with no departure planned');
      required(!overtaking.has(agfId)&&!activeEdges.has(agfId),'AGF already moving or overtaking');
      required(plan?.path?.steps?.length&&Array.isArray(plan.resourceIds)&&plan.resourceIds.length>=4&&
        new Set(plan.resourceIds).size===plan.resourceIds.length,'overtaking requires four distinct resources and a declared route');
      const routeResources=[],routeNodes=new Set();
      for(const step of plan.path.steps){
        const edge=edgeMap.get(step.edgeId);
        required(edge,'unknown overtaking route edge '+step.edgeId);
        required(step.fromNodeId===(step.traversal==='forward'?edge.fromNodeId:edge.toNodeId)&&
          step.toNodeId===(step.traversal==='forward'?edge.toNodeId:edge.fromNodeId),'overtaking route endpoint mismatch');
        routeNodes.add(step.fromNodeId);routeNodes.add(step.toNodeId);
        routeResources.push(...edge.lanes.map(lane=>lane.resourceId??lane.id),...edge.occupancyResourceIds,
          ...(edge.lanePolicy.simultaneousPassing==='yes'?[]:['edge:'+edge.id]));
      }
      for(const nodeId of routeNodes)if(exclusiveNodes.has(nodeId))routeResources.push('node:'+nodeId);
      const resources=[...new Set([...plan.resourceIds,...routeResources])];
      const nodeBlockers=[...routeNodes].filter(nodeId=>exclusiveNodes.has(nodeId))
        .flatMap(nodeId=>[nodeOccupants.get(nodeId),nodeReservations.get(nodeId)]).filter(id=>id&&id!==agfId);
      const blockers=[...new Set([...blockersFor(resources).filter(id=>id!==agfId),...nodeBlockers])];
      if(blockers.length)return wait(agfId,blockers,requestOrder,'OVERTAKING_RESOURCE_OCCUPIED');
      hold(agfId,resources);waits.delete(agfId);
      overtaking.set(agfId,{planId:plan.planId,blockedAgfId,resourceIds:resources,
        temporaryReverseEdgeIds:[...plan.temporaryReverseEdgeIds],steps:plan.path.steps.map(s=>({...s})),stepIndex:0});
      return {entered:true,resources:[...resources],blockers:[]};
    },
    isBeingOvertaken(agfId){return [...overtaking.values()].some(lease=>lease.blockedAgfId===agfId);},
    completeOvertaking(agfId){
      const lease=overtaking.get(agfId);
      required(lease&&!activeEdges.has(agfId)&&lease.stepIndex===lease.steps.length,'overtaking route unfinished before completion');
      overtaking.delete(agfId);this.releaseResources(agfId,lease.resourceIds);leaveGroup(agfId);
    },
    waitFor(agfId,blockers){waits.set(agfId,{blockers:[...new Set(blockers)].sort(),requestOrder:0});},
    detectDeadlocks(){
      const cycles=[],seenKeys=new Set();
      const walk=(start,current,path)=>{
        for(const next of waits.get(current)?.blockers??[]){
          if(next===start&&path.length>1){
            const cycle=[...path].sort(),key=cycle.join('|');
            if(!seenKeys.has(key)){seenKeys.add(key);cycles.push(cycle);}
          }else if(!path.includes(next)&&waits.has(next))walk(start,next,[...path,next]);
        }
      };
      for(const start of [...waits.keys()].sort())walk(start,start,[start]);
      return cycles.sort((a,b)=>a.join('|').localeCompare(b.join('|'),'en'));
    },
    snapshot(){return {owners:Object.fromEntries([...owners].sort()),
      waiting:[...waits].sort().map(([agfId,value])=>({agfId,...value})),
      followingOrder:ordered().map(member=>({...member})),
      handling:[...handling].sort().map(([agfId,value])=>({agfId,...value,resourceIds:[...value.resourceIds],
        ...(value.blockedEdgeIds?{blockedEdgeIds:[...value.blockedEdgeIds]}:{})})),
      nodeOccupants:Object.fromEntries([...nodeOccupants].sort()),nodeReservations:Object.fromEntries([...nodeReservations].sort()),
      overtaking:[...overtaking].sort().map(([agfId,value])=>({agfId,planId:value.planId,blockedAgfId:value.blockedAgfId,
        resourceIds:[...value.resourceIds],stepIndex:value.stepIndex}))};}
  };
}
import {canOvertakeWaitingWrapper} from './interference-control.mjs';
