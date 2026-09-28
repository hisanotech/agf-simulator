const allowed=(lane,traversal)=>lane.direction==='both'||lane.direction===traversal;

export function createTrafficController(edges){
  const edgeMap=new Map(edges.map(edge=>[edge.id,edge]));
  const owners=new Map(),held=new Map(),waits=new Map();
  const owner=resourceId=>owners.get(resourceId)??null;
  const blockersFor=resources=>[...new Set(resources.map(owner).filter(Boolean))].sort();
  const hold=(agfId,resources)=>{
    for(const resource of resources)owners.set(resource,agfId);
    held.set(agfId,resources);
  };
  return {
    recoveryPolicy:'detect-only',
    tryEnter({agfId,edgeId,traversal,requestOrder=0}){
      const edge=edgeMap.get(edgeId);
      if(!edge)throw new Error('unknown traffic edge '+edgeId);
      if(held.has(agfId))throw new Error('AGF already holds traffic resources '+agfId);
      if(!['yes','no-alternating','controlled'].includes(edge.lanePolicy?.simultaneousPassing))
        throw new Error('explicit passing policy required '+edgeId);
      const lanes=edge.lanes.filter(lane=>allowed(lane,traversal)).sort((a,b)=>a.id.localeCompare(b.id,'en'));
      if(!lanes.length)throw new Error('edge has no lane for '+traversal);
      const sharedResources=[...edge.occupancyResourceIds,
        ...(edge.lanePolicy.simultaneousPassing==='yes'?[]:['edge:'+edgeId])];
      for(const lane of lanes){
        const resources=[lane.id,...sharedResources];
        const blockers=blockersFor(resources).filter(id=>id!==agfId);
        if(!blockers.length){hold(agfId,resources);waits.delete(agfId);return {entered:true,laneId:lane.id,resources};}
      }
      const resources=[...lanes.map(lane=>lane.id),...sharedResources];
      const blockers=blockersFor(resources).filter(id=>id!==agfId);
      waits.set(agfId,{blockers,requestOrder});
      return {entered:false,laneId:null,resources:[],blockers};
    },
    release(agfId){
      for(const resource of held.get(agfId)??[])if(owner(resource)===agfId)owners.delete(resource);
      held.delete(agfId);waits.delete(agfId);
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
    snapshot(){return {owners:Object.fromEntries([...owners].sort()),waiting:[...waits].sort().map(([agfId,value])=>({agfId,...value}))};}
  };
}