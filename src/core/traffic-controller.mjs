const allowed=(lane,traversal)=>lane.direction==='both'||lane.direction===traversal;
const required=(condition,message)=>{if(!condition)throw new Error(message);};
const positioningPhases=new Set(['positioning_pickup','positioning_dropoff']);
const forkPhases=new Set(['picking_fork_inserted','dropping_fork_inserted']);
const opposite={east:'west',west:'east',north:'south',south:'north',forward:'reverse',reverse:'forward'};

export function createTrafficController(edges){
  const edgeMap=new Map(edges.map(edge=>[edge.id,edge]));
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
  const joinGroup=(agfId,groupId,direction,requestOrder)=>{
    const current=following.get(agfId);
    if(current?.groupId===groupId&&current.direction===direction)return current;
    const member={agfId,groupId,direction,requestOrder,order:++groupSequence,evidence:'event-request-order'};
    following.set(agfId,member);return member;
  };
  const ordered=()=>[...following.values()].sort((a,b)=>a.order-b.order);
  const groupBlocked=(agfId,groupId,direction,requestOrder)=>{
    const member=joinGroup(agfId,groupId,direction,requestOrder);
    const positioning=[...handling].filter(([id,state])=>id!==agfId&&state.groupId===groupId&&
      positioningPhases.has(state.phase)).map(([id])=>id);
    if(positioning.length)return {blockers:positioning,reason:'HANDLING_POSITIONING'};
    const leaders=ordered().filter(other=>other.agfId!==agfId&&other.groupId===groupId&&
      other.direction===direction&&other.order<member.order).map(other=>other.agfId);
    return leaders.length?{blockers:leaders,reason:'NO_OVERTAKING'}:null;
  };
  const wait=(agfId,blockers,requestOrder,reason)=>{
    const unique=[...new Set(blockers)].sort();
    waits.set(agfId,{blockers:unique,requestOrder,reason});
    return {entered:false,laneId:null,resources:[],blockers:unique,reason};
  };
  return {
    recoveryPolicy:'detect-only',
    tryEnter({agfId,edgeId,traversal,requestOrder=0,groupDirection:explicitDirection}){
      const edge=edgeMap.get(edgeId);
      if(!edge)throw new Error('unknown traffic edge '+edgeId);
      if(activeEdges.has(agfId))throw new Error('AGF already holds traffic resources '+agfId);
      if(!['yes','no-alternating','controlled'].includes(edge.lanePolicy?.simultaneousPassing))
        throw new Error('explicit passing policy required '+edgeId);
      const lanes=edge.lanes.filter(lane=>allowed(lane,traversal)).sort((a,b)=>a.id.localeCompare(b.id,'en'));
      if(!lanes.length)throw new Error('edge has no lane for '+traversal);
      const direction=groupDirection(edge,traversal,explicitDirection),groupId=edge.noOvertakingGroupId;
      if(groupId){
        const blocked=groupBlocked(agfId,groupId,direction,requestOrder);
        if(blocked)return wait(agfId,blocked.blockers,requestOrder,blocked.reason);
      }else leaveGroup(agfId);
      const sharedResources=[...edge.occupancyResourceIds,
        ...(edge.lanePolicy.simultaneousPassing==='yes'?[]:['edge:'+edgeId])];
      for(const lane of lanes){
        const resources=[...new Set([lane.resourceId??lane.id,...sharedResources])];
        const blockers=blockersFor(resources).filter(id=>id!==agfId);
        if(!blockers.length){
          hold(agfId,resources);activeEdges.set(agfId,edgeId);waits.delete(agfId);
          return {entered:true,laneId:lane.id,resources,
            ...(groupId?{noOvertakingGroupId:groupId,groupDirection:direction}:{})};
        }
      }
      const resources=[...lanes.map(lane=>lane.resourceId??lane.id),...sharedResources];
      const blockers=blockersFor(resources).filter(id=>id!==agfId);
      return wait(agfId,blockers,requestOrder,'OCCUPIED');
    },
    reserveResources({agfId,resourceIds,requestOrder=0,groupId=null,groupDirection:direction=null}){
      required(Array.isArray(resourceIds)&&resourceIds.every(id=>typeof id==='string'&&id.length),
        'explicit traffic resource IDs required');
      if(groupId)required(typeof direction==='string'&&direction.length,'explicit reservation group direction required');
      if(groupId){
        const blocked=groupBlocked(agfId,groupId,direction,requestOrder);
        if(blocked)return wait(agfId,blocked.blockers,requestOrder,blocked.reason);
      }
      const resources=[...new Set(resourceIds)],blockers=blockersFor(resources).filter(id=>id!==agfId);
      if(blockers.length)return wait(agfId,blockers,requestOrder,'OCCUPIED');
      hold(agfId,resources);waits.delete(agfId);
      return {entered:true,resources,blockers:[]};
    },
    releaseResources(agfId,resourceIds){
      required(Array.isArray(resourceIds),'resource IDs must be an array');
      const removed=new Set(resourceIds);
      for(const resource of removed)if(owner(resource)===agfId)owners.delete(resource);
      const remaining=(held.get(agfId)??[]).filter(id=>!removed.has(id));
      if(remaining.length)held.set(agfId,remaining);else held.delete(agfId);
    },
    release(agfId,{keepFollowingOrder=false,retainResourceIds=[]}={}){
      const retained=new Set(retainResourceIds);
      const resources=held.get(agfId)??[];
      for(const resource of resources)if(!retained.has(resource)&&owner(resource)===agfId)owners.delete(resource);
      const remaining=resources.filter(id=>retained.has(id));
      if(remaining.length)held.set(agfId,remaining);else held.delete(agfId);
      activeEdges.delete(agfId);waits.delete(agfId);
      if(!keepFollowingOrder)leaveGroup(agfId);
    },
    leaveGroup,
    setHandlingPhase({agfId,groupId,phase,resourceIds=[]}){
      required(typeof groupId==='string'&&groupId.length,'explicit handling group required');
      required(positioningPhases.has(phase)||forkPhases.has(phase),'unknown handling phase '+phase);
      required(Array.isArray(resourceIds)&&resourceIds.every(id=>typeof id==='string'&&id.length),
        'explicit handling resource IDs required');
      const blockers=blockersFor(resourceIds).filter(id=>id!==agfId);
      if(blockers.length)return wait(agfId,blockers,0,'OCCUPIED');
      hold(agfId,resourceIds);handling.set(agfId,{groupId,phase,resourceIds:[...resourceIds]});
      if(forkPhases.has(phase))leaveGroup(agfId);
      waits.delete(agfId);
      return {entered:true,resources:[...resourceIds],blockers:[]};
    },
    clearHandlingPhase(agfId){
      handling.delete(agfId);
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
      handling:[...handling].sort().map(([agfId,value])=>({agfId,...value,resourceIds:[...value.resourceIds]}))};}
  };
}
