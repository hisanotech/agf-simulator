import {syntheticMetricLayout} from '../../examples/synthetic-metric-layout.mjs';

// Deliberately invented slopes (30 / 60 / 100) over the old OT footprints.
// Reproduces the bug without a private drawing or calibration profile.
export const nonlinearTempPlaceProfile={...structuredClone(syntheticMetricLayout),
  id:'SYNTHETIC-OT-UNEQUAL-SLOPES',evidence:'synthetic-regression-not-site-geometry',
  axisAnchors:{...structuredClone(syntheticMetricLayout.axisAnchors),
    x:[[0,0],[800,32000],[810,32400],[879,34470],[888,34830],
      [957,38970],[966,39330],[1035,46230],[1280,51200]]}};
