import {simulate} from '../core/simulate.mjs';

/** Recalculate first. Callers replace their result only after this succeeds. */
export function appendRunInput(run,listName,entry){
  if(!run||run.previewOnly)throw new Error('先に設定を反映して実行してください。');
  const candidate=structuredClone(run.scenario);
  (candidate[listName]??=[]).push(structuredClone(entry));
  return simulate(candidate);
}

/** Initial display only, never a Run or a performance result. Use the engine's
 * initialization so stop occupancy/equipment cannot diverge from actual replay. */
export function createInitialPreview(scenario){
  const input=structuredClone(scenario);
  input.durationMin=1/60000;
  input.productionModel='legacy_external_pallets';
  delete input.warehousePolicy;
  input.lineIntervalsMin=Array(8).fill(0);
  delete input.productStreams;
  for(const list of ['productionEvents','manualRequests','magazineUses','alignerReadyEvents','alignerRefillEvents','permissionEvents','shutterEvents'])input[list]=[];
  const initialized=simulate(input);
  return {previewOnly:true,scenario:structuredClone(scenario),events:[initialized.events[0]],
    snapshots:[initialized.snapshots[0]],final:initialized.snapshots[0]};
}
