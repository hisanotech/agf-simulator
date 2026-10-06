// Invented drawing values express approved relative relationships only.
// They are not CAD centers, measured dimensions, or approved physical stops.
export const SCHEMATIC_LAYOUT=Object.freeze({
  evidence:'public-synthetic-relative-layout-not-site-coordinates',
  warehouseOffsetX:180,
  worldBounds:Object.freeze([0,0,1280,970]),
  buildings:Object.freeze({
    PZ:Object.freeze({x:25,y:22,width:1050,height:300}),
    WH:Object.freeze({x:205,y:458,width:1060,height:484})
  }),
  gates:Object.freeze({
    pzEntry:Object.freeze({nodeId:'PZ-ENTRY',x:630,y:300,boundaryY:322,shutterId:'SH-PZ-ENTRY'}),
    pzExit:Object.freeze({nodeId:'PZ-EXIT',x:800,y:300,boundaryY:322,shutterId:'SH-PZ-EXIT'}),
    whEast:Object.freeze({nodeId:'WH-GATE',x:862.5,y:475,boundaryY:458,shutterId:'SH-EAST'}),
    whWest:Object.freeze({nodeId:'WH-W-GATE',x:650,y:475,boundaryY:458,shutterId:'SH-WEST'})
  }),
  gateCorrespondence:Object.freeze({
    evidence:'confirmed-relative-gate-correspondence-not-measured-axis',
    west:Object.freeze({pzNodeId:'PZ-ENTRY',whNodeId:'WH-W-GATE'}),
    east:Object.freeze({pzNodeId:'PZ-EXIT',whNodeId:'WH-GATE'}),
    physicalSameAxisConfirmed:false
  })
});
