// Fictitious round dimensions for the public harness. These are not site measurements.
// Local CAD-derived calibration belongs in an ignored private profile.
export const syntheticMetricLayout={
  schemaVersion:'metric-layout-profile-v1',id:'public-synthetic-mm',revision:'2',
  evidence:'synthetic-assumption',sourceKind:'synthetic',coordinateUnit:'mm',
  legacyBounds:[0,0,1280,970],
  axisAnchors:{x:[[0,0],[1280,51200]],y:[[0,0],[322,9660],[475,14250],[970,25140]]},
  readiness:{physicalEtaAllowed:false,metricScaleVerified:false,referenceOriginVerified:false},
  assumptions:['Fictitious mm model; not a measured layout or approved physical stop.',
    'Retains logical connectivity, directions, speeds and occupancy resources.']
};
