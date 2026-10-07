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
  const eligible = agfs.filter(a =>
    a.status === 'idle' && !a.blocked &&
    Number.isFinite(a.batteryPct) && a.batteryPct > reservePct
  );
  let candidates = eligible;
  let basis='all_areas';
  if (mode === 'area_first') {
    const local = eligible.filter(a => a.area === task.destinationArea);
    if (local.length) {candidates=local;basis='destination_area';}
    else if (fallback === 'wait') return {agf:null,selection:null}; // Cross-area fallback remains an explicit scenario choice.
    else basis='cross_area_fallback';
  }
  candidates.sort((a, b) => a.batteryPct - b.batteryPct ||
    String(a.id).localeCompare(String(b.id), 'en'));
  const agf=candidates[0];
  if(!agf)return {agf:null,selection:null};
  const tied=candidates.filter(candidate=>candidate.batteryPct===agf.batteryPct).length>1;
  return {agf,selection:{mode,destinationArea:task.destinationArea,selectedArea:agf.area,
    selectedAgfId:agf.id,selectedBatteryPct:agf.batteryPct,reservePct,fallback,basis,
    eligibleAgfIds:eligible.map(candidate=>candidate.id).sort((a,b)=>String(a).localeCompare(String(b),'en')),
    candidates:candidates.map(candidate=>({agfId:candidate.id,area:candidate.area,batteryPct:candidate.batteryPct})),
    tieBreak:tied?'agf_id':'none',tieBreakEvidence:tied?'synthetic-model-tiebreak':null}};
}
