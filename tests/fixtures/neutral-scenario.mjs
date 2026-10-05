import {createDemoScenario} from '../../src/ui/scenario.mjs';
import {syntheticWarehousePolicy} from '../../examples/synthetic-warehouse-policy.mjs';

/** Separate synthetic regression mapping; never replaces the confirmed ordinary Run. */
export function configuredNeutralScenario(){
  const s=createDemoScenario();
  s.lineMagazineMap={L1:'M1',L2:'M2',L3:'M3',L4:'M4',L5:'M5',L6:'M1',L7:'M2',L8:'M3'};
  s.lineMagazineMapPolicy='scenario';
  s.evidence.lineMagazineMap='synthetic-test-mapping';
  // Declared software-test assumptions, never default real machine values.
  s.motionControl={turnRateDegPerSec:45,turnRateEvidence:'synthetic-assumption',
    turningConsumesBattery:true,turningBatteryEvidence:'synthetic-assumption',
    pickupPositioningMin:.2,pickupForkInsertedMin:.3,
    dropoffPositioningMin:.2,dropoffForkInsertedMin:.3,handlingEvidence:'synthetic-assumption'};
  s.warehousePolicy=syntheticWarehousePolicy();
  return s;
}
