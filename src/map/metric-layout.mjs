const required=(condition,message)=>{if(!condition)throw new Error('metric layout: '+message);};

/** A profile is an explicit model input, never proof of CAD scale or route approval. */
function validateAnchors(anchors,label){
  required(Array.isArray(anchors)&&anchors.length>=2,label+' requires at least two anchors');
  for(let index=0;index<anchors.length;index++){
    const anchor=anchors[index];
    required(Array.isArray(anchor)&&anchor.length===2&&anchor.every(Number.isFinite),
      label+' anchors must contain finite source/model millimeter pairs');
    if(index)required(anchor[0]>anchors[index-1][0]&&anchor[1]>anchors[index-1][1],
      label+' source and millimeter anchors must increase strictly');
  }
}
export function validateMetricLayoutProfile(profile){
  required(profile?.schemaVersion==='metric-layout-profile-v1','expected metric-layout-profile-v1');
  for(const field of ['id','evidence'])required(typeof profile[field]==='string'&&profile[field].length>0,
    field+' is required');
  required(typeof profile.revision==='string'&&profile.revision.length>0||
    Number.isInteger(profile.revision)&&profile.revision>=0,'revision is required');
  required(profile.coordinateUnit==='mm','coordinateUnit must be mm');
  required(profile.readiness?.physicalEtaAllowed===false&&profile.readiness?.metricScaleVerified===false,
    'an unverified model profile must not claim verified metric scale or physical ETA');
  for(const axis of ['x','y'])validateAnchors(profile.axisAnchors?.[axis],axis+' axis');
  if(profile.xBands!==undefined){
    required(Array.isArray(profile.xBands)&&profile.xBands.length>=2,'xBands requires at least two bands');
    for(let index=0;index<profile.xBands.length;index++){
      const band=profile.xBands[index];
      required(Number.isFinite(band?.atY)&&(!index||band.atY>profile.xBands[index-1].atY),
        'xBands atY values must be finite and increase strictly');
      validateAnchors(band.anchors,'xBands '+index);
    }
  }
  return profile;
}

function axisValue(value,anchors){
  required(Number.isFinite(value),'point coordinates must be finite');
  let index=0;
  while(index<anchors.length-2&&value>anchors[index+1][0])index++;
  const [a,b]=[anchors[index],anchors[index+1]];
  // Outside the declared bounds use the nearest declared slope, not a guessed
  // new scale. The extrapolated point remains an unverified model position.
  const converted=a[1]+(value-a[0])*(b[1]-a[1])/(b[0]-a[0]);
  required(Number.isFinite(converted),'converted metric point must be finite');
  return converted;
}
function bandX(point,profile){
  const bands=profile.xBands;
  if(!bands)return axisValue(point?.x,profile.axisAnchors.x);
  if(point?.y<=bands[0].atY)return axisValue(point.x,bands[0].anchors);
  if(point?.y>=bands.at(-1).atY)return axisValue(point.x,bands.at(-1).anchors);
  let index=0;
  while(index<bands.length-2&&point?.y>bands[index+1].atY)index++;
  const [a,b]=[bands[index],bands[index+1]],weight=(point?.y-a.atY)/(b.atY-a.atY);
  const x0=axisValue(point?.x,a.anchors),x1=axisValue(point?.x,b.anchors);
  return x0+(x1-x0)*weight;
}
const pointWithProfile=(point,profile)=>({
  x:bandX(point,profile),y:axisValue(point?.y,profile.axisAnchors.y)
});

/** Convert a legacy drawing point using only the supplied anchor table. */
export function metricPoint(point,profile){
  validateMetricLayoutProfile(profile);
  return pointWithProfile(point,profile);
}

export function metricWorldBounds(profile){
  validateMetricLayoutProfile(profile);
  const xAnchors=[profile.axisAnchors.x,...(profile.xBands??[]).map(band=>band.anchors)];
  const minX=Math.min(...xAnchors.map(anchors=>anchors[0][1]));
  const maxX=Math.max(...xAnchors.map(anchors=>anchors.at(-1)[1]));
  const minY=profile.axisAnchors.y[0][1],maxY=profile.axisAnchors.y.at(-1)[1];
  return {x:minX,y:minY,width:maxX-minX,height:maxY-minY,minX,minY,maxX,maxY};
}

/** Equal scale on both axes keeps displayed lengths proportional to model mm. */
export function createMetricCanvasProjection(profile,{width=1400,height=850,padding=24}={}){
  const bounds=metricWorldBounds(profile);
  required(Number.isFinite(width)&&Number.isFinite(height)&&Number.isFinite(padding)&&padding>=0&&
    width>2*padding&&height>2*padding,'canvas size must exceed its padding');
  const scale=Math.min((width-2*padding)/bounds.width,(height-2*padding)/bounds.height);
  const offsetX=(width-bounds.width*scale)/2-bounds.minX*scale;
  const offsetY=(height-bounds.height*scale)/2-bounds.minY*scale;
  return {scale,offsetX,offsetY,bounds,width,height,
    point:point=>({x:offsetX+point.x*scale,y:offsetY+point.y*scale}),
    inversePoint:point=>({x:(point.x-offsetX)/scale,y:(point.y-offsetY)/scale})};
}

export function metricPathLength(points){
  required(Array.isArray(points)&&points.length>=2&&
    points.every(point=>Number.isFinite(point?.x)&&Number.isFinite(point?.y)),
    'distance requires a finite millimeter path');
  return points.slice(1).reduce((sum,point,index)=>sum+
    Math.hypot(point.x-points[index].x,point.y-points[index].y),0);
}

/** Keep operational connectivity/policies while recalculating one mm geometry. */
export function convertTopologyToMetric(input,profile){
  validateMetricLayoutProfile(profile);
  required(input?.schemaVersion==='operational-topology-v1'&&input.datasetKind==='synthetic'&&
    input.evidence==='synthetic-assumption','conversion requires an explicit synthetic operational model');
  if(input.coordinateSystem==='synthetic-mm'){
    required(JSON.stringify(input.metricLayoutProfile)===JSON.stringify(profile),
      'already metric topology requires the identical saved profile');
    return structuredClone(input);
  }
  required(input.coordinateSystem==='synthetic-display','source coordinates must be synthetic-display');
  required(Array.isArray(input.nodes)&&Array.isArray(input.edges),'nodes and edges are required');
  const graph=structuredClone(input),oldNodes=new Map(input.nodes.map(node=>[node.id,node]));
  graph.coordinateSystem='synthetic-mm';graph.coordinateUnit='mm';
  graph.metricLayoutProfile=structuredClone(profile);
  graph.readiness={...graph.readiness,physicalEtaAllowed:false,metricScaleVerified:false};
  graph.nodes=graph.nodes.map(node=>({...node,...pointWithProfile(node,profile),
    coordinateEvidence:'metric-profile-derived-synthetic-position-not-site-stop'}));
  for(const edge of graph.edges){
    const from=oldNodes.get(edge.fromNodeId),to=oldNodes.get(edge.toNodeId);
    required(from&&to,'unknown edge endpoint '+edge.id);
    const points=edge.displayPath??[{x:from.x,y:from.y},{x:to.x,y:to.y}];
    edge.displayPath=points.map(point=>pointWithProfile(point,profile));
    edge.distanceMm=metricPathLength(edge.displayPath);
    required(edge.distanceMm>0,'zero metric distance '+edge.id);
    edge.modelDistanceEvidence='explicit-unverified-metric-profile-polyline-length';
  }
  const sourceTotals=new Map();
  for(const edge of graph.edges)if(edge.splitSourceEdgeId)
    sourceTotals.set(edge.splitSourceEdgeId,(sourceTotals.get(edge.splitSourceEdgeId)??0)+edge.distanceMm);
  for(const edge of graph.edges)if(edge.splitSourceEdgeId)
    edge.splitSourceDistanceMm=sourceTotals.get(edge.splitSourceEdgeId);
  graph.displayEvidence='uniform metric-model geometry; scale and site stops unverified; physical ETA not permitted';
  const previousEvidence=graph.modelEvidence??{};
  const retainedEvidence=Object.fromEntries(Object.entries(previousEvidence)
    .filter(([key])=>!/(distance|allocation|timing|station)/i.test(key)));
  graph.modelEvidence={...retainedEvidence,legacyDistanceEvidence:previousEvidence,
    coordinateUnit:'mm',metricProfileId:profile.id,
    metricProfileRevision:profile.revision,metricScaleVerified:false,
    timingBasis:'model-millimeter-polyline-distance-and-explicit-speed-not-measured-ETA',
    turnDistanceAllocation:'metric model segments retain their own millimeter lengths'};
  return graph;
}
