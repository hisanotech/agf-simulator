import {createDemoScenario} from '../../src/ui/scenario.mjs';
import {syntheticWarehousePolicy} from '../../examples/synthetic-warehouse-policy.mjs';

/** Synthetic test mapping only. The actual 8→5 supply correspondence is unresolved. */
export function configuredNeutralScenario(){
  const s=createDemoScenario();
  s.lineMagazineMap={L1:'M1',L2:'M2',L3:'M3',L4:'M4',L5:'M5',L6:'M1',L7:'M2',L8:'M3'};
  s.evidence.lineMagazineMap='synthetic-test-mapping';
  s.warehousePolicy=syntheticWarehousePolicy();
  return s;
}
