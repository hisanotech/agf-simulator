const clamp=value=>Math.max(0,Math.min(1,value));

/** Projects a saved synthetic movement. It never plans a route or changes simulation state. */
export function projectAgfPosition(agf,topology,timeMs){
  if(!topology)return null;
  const nodes=new Map(topology.nodes.map(node=>[node.id,node]));
  const current=agf.movement?.current;
  if(current){
    const from=nodes.get(current.fromNodeId),to=nodes.get(current.toNodeId);
    if(!from||!to)return null;
    const duration=current.exitAt-current.enteredAt;
    const progress=duration>0?clamp((timeMs-current.enteredAt)/duration):1;
    return {x:from.x+(to.x-from.x)*progress,y:from.y+(to.y-from.y)*progress,progress,nodeId:null};
  }
  const node=nodes.get(agf.currentNodeId);
  return node?{x:node.x,y:node.y,progress:null,nodeId:node.id}:null;
}