import {validateOperationalTopology} from '../map/operational-topology.mjs';

const required=(condition,message)=>{if(!condition)throw new Error(message);};

// Avoidance-side priority is separate from dispatch and from right-of-way.
// Feasibility must come from an explicitly provided route, not a drawing guess.
export function chooseAvoidance({candidates,tieBreakPolicy=null}){
  required(Array.isArray(candidates),'avoidance candidates must be an array');
  required(candidates.every(c=>typeof c.agfId==='string'&&c.agfId.length)&&
    new Set(candidates.map(c=>c.agfId)).size===candidates.length,'unique avoidance AGF IDs required');
  if(tieBreakPolicy!==null)required(tieBreakPolicy?.kind==='agf_id'&&
    tieBreakPolicy.evidence==='synthetic-model-tiebreak','avoidance ID tie-break requires synthetic-model-tiebreak evidence');
  const possible=candidates.filter(c=>c.moving===true&&c.avoidancePossible===true);
  if(!possible.length)return {status:'unavailable',agfId:null,reason:'NO_EXPLICIT_AVOIDANCE_ROUTE',evidence:'unresolved'};
  if(possible.length===1)return {status:'selected',agfId:possible[0].agfId,
    reason:'ONLY_FEASIBLE_MOVING_AGF',evidence:'user-confirmed-rule'};
  const empty=possible.filter(c=>c.loaded===false),ranked=empty.length?empty:possible;
  if(ranked.length===1)return {status:'selected',agfId:ranked[0].agfId,
    reason:'EMPTY_MOVING_PRIORITY',evidence:'user-confirmed-rule'};
  if(!tieBreakPolicy)return {status:'unresolved',agfId:null,reason:'AVOIDANCE_TIE_UNRESOLVED',evidence:'unresolved'};
  const selected=ranked.toSorted((a,b)=>a.agfId.localeCompare(b.agfId,'en'))[0];
  return {status:'selected',agfId:selected.agfId,reason:'SYNTHETIC_ID_TIE_BREAK',evidence:tieBreakPolicy.evidence};
}

const pathFor=(graph,startNodeId,targetNodeId,edgeIds,{movement,taskType})=>{
  const edges=new Map(graph.edges.map(e=>[e.id,e]));let current=startNodeId;const steps=[];
  if(!Array.isArray(edgeIds)||!edgeIds.length)return null;
  for(const edgeId of edgeIds){
    const edge=edges.get(edgeId);
    if(!edge)return null;
    const traversal=edge.fromNodeId===current?'forward':edge.toNodeId===current?'reverse':null;
    if(!traversal||!edge.lanes.some(l=>l.direction==='both'||l.direction===traversal)||
      !edge.accessScopes.some(s=>s.movement===movement&&(s.taskTypes.includes('*')||s.taskTypes.includes(taskType))))return null;
    const toNodeId=traversal==='forward'?edge.toNodeId:edge.fromNodeId;
    const durationMs=Math.ceil(edge.distanceMm*1000/edge.speedMmPerSec[movement]);
    if(!Number.isFinite(durationMs)||durationMs<=0)return null;
    steps.push({edgeId,fromNodeId:current,toNodeId,traversal,distanceMm:edge.distanceMm,durationMs,
      shutterId:edge.shutterId??null,
      ...(edge.displayPath?{displayPath:structuredClone(traversal==='forward'?edge.displayPath:edge.displayPath.toReversed())}:{})});
    current=toNodeId;
  }
  if(current!==targetNodeId)return null;
  return {kind:'synthetic-operational',movement,taskType,etaStatus:'synthetic-assumption',measuredDistanceMm:null,
    modelDistanceMm:steps.reduce((sum,s)=>sum+s.distanceMm,0),
    modelDurationMs:steps.reduce((sum,s)=>sum+s.durationMs,0),steps};
};

export function findExplicitAvoidancePlan(graph,{currentNodeId,conflictGroupId,movement,taskType,planId=null}){
  validateOperationalTopology(graph);
  const nodes=new Set(graph.nodes.map(n=>n.id));
  const plans=(graph.avoidancePlans??[]).filter(plan=>plan.fromNodeId===currentNodeId&&
    plan.conflictGroupId===conflictGroupId&&(!planId||plan.id===planId))
    .toSorted((a,b)=>a.id.localeCompare(b.id,'en'));
  for(const plan of plans){
    // The public helper only operates on explicitly evidenced synthetic routes.
    if(plan.evidence!=='synthetic-assumption'||!nodes.has(plan.viaNodeId)||plan.viaNodeId===currentNodeId)continue;
    const outboundPath=pathFor(graph,currentNodeId,plan.viaNodeId,plan.outboundEdgeIds,{movement,taskType});
    const returnPath=pathFor(graph,plan.viaNodeId,currentNodeId,plan.returnEdgeIds,{movement,taskType});
    if(outboundPath&&returnPath)return {planId:plan.id,fromNodeId:plan.fromNodeId,viaNodeId:plan.viaNodeId,
      conflictGroupId:plan.conflictGroupId,evidence:plan.evidence,outboundPath,returnPath};
  }
  return null;
}
