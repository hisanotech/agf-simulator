const rounded = value => Math.round(value * 1_000_000) / 1_000_000;

// Omission preserves historical scenarios; new UI scenarios choose active_time explicitly.
export const batteryModel = battery => battery.consumptionModel ?? 'per_task';

export function validateBatteryModel(battery) {
  const model = batteryModel(battery);
  if (!['per_task', 'active_time'].includes(model)) throw new Error('invalid battery consumption model');
  if (model === 'per_task') {
    if (!Number.isFinite(battery.consumptionPct) || battery.consumptionPct < 0)
      throw new Error('invalid per-task battery consumption');
  } else if (!Number.isFinite(battery.activeReferenceMin) || Math.round(battery.activeReferenceMin * 60_000) <= 0 ||
    !Number.isFinite(battery.activeReferenceConsumptionPct) || battery.activeReferenceConsumptionPct < 0 ||
    battery.activeReferenceConsumptionPct > 100) {
    throw new Error('invalid active-time battery reference');
  }
}

export const isBatteryActive = (agf, task) => agf.status === 'moving_empty' ||
  (agf.status === 'moving_loaded' && task?.status !== 'wait_drop') ||
  agf.status === 'moving_to_charge' || agf.status === 'moving_to_wait';

export const activeConsumptionPct = (battery, elapsedMs) =>
  elapsedMs / Math.round(battery.activeReferenceMin * 60_000) * battery.activeReferenceConsumptionPct;

// Pure projection from an event snapshot; never changes the run or creates events.
export function projectBatteryPct(agf, task, battery, elapsedMs) {
  if (batteryModel(battery) !== 'active_time') return agf.batteryPct;
  const elapsed = Math.max(0, elapsedMs);
  if (isBatteryActive(agf, task))
    return rounded(Math.max(0, agf.batteryPct - activeConsumptionPct(battery, elapsed)));
  if (agf.status === 'charging')
    return rounded(Math.min(battery.chargeTargetPct, agf.batteryPct + elapsed / 60_000 / battery.chargeMinPerPct));
  return agf.batteryPct;
}

// Accumulate integer active milliseconds against an absolute baseline, so unrelated
// events cannot introduce repeated-rounding drift into dispatch decisions.
export function createBatteryLedger(agfs, battery) {
  const accounts = new Map(agfs.map(a => [a.id, {basePct:a.batteryPct, activeMs:0, charge:null}]));
  return {
    advance(fromMs, toMs, tasks) {
      for (const agf of agfs) {
        const account = accounts.get(agf.id);
        if (isBatteryActive(agf, tasks.get(agf.taskId))) {
          account.activeMs += toMs - fromMs;
          const pct = account.basePct - activeConsumptionPct(battery, account.activeMs);
          if (pct < -0.000000001) throw new Error('battery depleted during active work: ' + agf.id);
          agf.batteryPct = rounded(Math.max(0, pct));
        } else if (agf.status === 'charging' && account.charge) {
          agf.batteryPct = rounded(Math.min(battery.chargeTargetPct,
            account.charge.pct + (toMs - account.charge.timeMs) / 60_000 / battery.chargeMinPerPct));
        }
      }
    },
    startCharge(agf, timeMs) {
      accounts.get(agf.id).charge = {timeMs, pct:agf.batteryPct};
    },
    finishCharge(agf) {
      accounts.set(agf.id, {basePct:agf.batteryPct, activeMs:0, charge:null});
    }
  };
}
