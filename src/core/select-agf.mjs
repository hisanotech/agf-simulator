/** Deterministic selector. area_first is destination-area first (approved rule). */
export function selectAgf(agfs, task, { mode, reservePct, fallback = 'wait' }) {
  return selectAgfWithReason(agfs,task,{mode,reservePct,fallback}).agf;
}

/** Record the decision from the same candidate set used by the selector.
 * Battery and areas are copied before assignment mutates the live vehicles. */
export function selectAgfWithReason(agfs, task, { mode, reservePct, fallback = 'wait' }) {
  if (!['area_first', 'low_battery_first'].includes(mode)) throw new Error('Unknown mode');
  if (!Number.isFinite(reservePct)) throw new Error('reservePct must be specified');
  if (!task || typeof task.destinationArea !== 'string' || !task.destinationArea)
    throw new Error('destinationArea required');
  if (!['wait', 'any'].includes(fallback)) throw new Error('Unknown fallback');
  const evaluations=agfs.map(a=>({agfId:a.id,area:a.area,batteryPct:a.batteryPct,status:a.status,blocked:!!a.blocked,
    eligible:false,vehicleEligible:false,exclusionReason:null,selected:false,evaluationStatus:'evaluated'}));
  // Save each actual short-circuit rejection beside the existing predicates.
  const eligible = agfs.filter((a,index) => {
    const evaluation=evaluations[index];
    if(a.status!=='idle')evaluation.exclusionReason='STATUS_NOT_AVAILABLE';
    else if(a.blocked)evaluation.exclusionReason='BLOCKED';
    else if(!Number.isFinite(a.batteryPct))evaluation.exclusionReason='BATTERY_INVALID';
    else if(a.batteryPct<=reservePct)evaluation.exclusionReason='BATTERY_RESERVE';
    else evaluation.eligible=evaluation.vehicleEligible=true;
    return evaluation.eligible;
  });
  const ids=values=>values.map(a=>a.id).sort((a,b)=>String(a).localeCompare(String(b),'en'));
  evaluations.sort((a,b)=>String(a.agfId).localeCompare(String(b.agfId),'en'));
  const stages=[{stage:'vehicle_eligibility',eligibleAgfIds:ids(eligible),
    excluded:evaluations.filter(e=>!e.eligible).map(e=>({agfId:e.agfId,exclusionReason:e.exclusionReason}))}];
  let candidates = eligible;
  let basis='all_areas';
  if (mode === 'area_first') {
    const local = eligible.filter(a => a.area === task.destinationArea);
    if (local.length) {candidates=local;basis='destination_area';}
    else if (fallback === 'wait') {candidates=[];basis='destination_area_wait';} // Cross-area fallback remains explicit.
    else basis='cross_area_fallback';
  }
  const candidateIds=new Set(candidates.map(a=>a.id));
  for(const evaluation of evaluations)if(evaluation.eligible&&!candidateIds.has(evaluation.agfId)){
    evaluation.eligible=false;
    evaluation.exclusionReason=basis==='destination_area_wait'?'AREA_FALLBACK_DISABLED':'AREA_NOT_PRIORITIZED';
  }
  stages.push({stage:'area',basis,eligibleAgfIds:ids(candidates),
    excluded:evaluations.filter(e=>e.vehicleEligible&&!e.eligible).map(e=>({agfId:e.agfId,exclusionReason:e.exclusionReason}))});
  candidates.sort((a, b) => a.batteryPct - b.batteryPct ||
    String(a.id).localeCompare(String(b.id), 'en'));
  const agf=candidates[0];
  const minimum=candidates.filter(candidate=>candidate.batteryPct===agf?.batteryPct);
  const tied=minimum.length>1;
  if(agf)evaluations.find(e=>e.agfId===agf.id).selected=true;
  stages.push({stage:'battery',eligibleAgfIds:minimum.map(a=>a.id),rankedAgfIds:candidates.map(a=>a.id)},
    {stage:'id_tie_break',eligibleAgfIds:minimum.map(a=>a.id),selectedAgfId:agf?.id??null,
      evidence:tied?'synthetic-model-tiebreak':null});
  return {agf:agf??null,selection:{mode,destinationArea:task.destinationArea,selectedArea:agf?.area??null,
    selectedAgfId:agf?.id??null,selectedBatteryPct:agf?.batteryPct??null,reservePct,fallback,basis,
    eligibleAgfIds:eligible.map(candidate=>candidate.id).sort((a,b)=>String(a).localeCompare(String(b),'en')),
    candidates:candidates.map(candidate=>({agfId:candidate.id,area:candidate.area,batteryPct:candidate.batteryPct})),
    tieBreak:tied?'agf_id':'none',tieBreakEvidence:tied?'synthetic-model-tiebreak':null,evaluations,stages}};
}
