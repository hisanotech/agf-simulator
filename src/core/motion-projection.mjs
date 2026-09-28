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
    if(current.displayPath){
      const points=current.displayPath,lengths=points.slice(1).map((p,i)=>Math.hypot(p.x-points[i].x,p.y-points[i].y));
      let distance=lengths.reduce((sum,n)=>sum+n,0)*progress;
      for(let i=0;i<lengths.length;i++){
        if(distance<lengths[i]||i===lengths.length-1){
          const a=points[i],b=points[i+1],part=clamp(distance/lengths[i]),dx=b.x-a.x,dy=b.y-a.y;
          return {x:a.x+dx*part,y:a.y+dy*part,progress,nodeId:null,
            heading:Math.abs(dx)>=Math.abs(dy)?(dx>=0?'east':'west'):(dy>=0?'south':'north')};
        }
        distance-=lengths[i];
      }
    }
    return {x:from.x+(to.x-from.x)*progress,y:from.y+(to.y-from.y)*progress,progress,nodeId:null};
  }
  const node=nodes.get(agf.currentNodeId);
  return node?{x:node.x,y:node.y,progress:null,nodeId:node.id}:null;
}
