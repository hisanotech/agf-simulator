/** Invented fixed-time software regression inputs; not facility records or timing. */
export function taskPriorityScenario(overrides={}){
  return {
    name:'Synthetic equipment-priority regression',preset:'synthetic-priority-test',
    evidence:{production:'synthetic-regression',timing:'synthetic-assumption'},
    durationMin:15,mode:'area_first',fallback:'any',motionModel:'fixed_time',lineCapacity:8,
    productionModel:'legacy_external_pallets',lineIntervalsMin:Array(8).fill(0),
    generatedDestinationIds:['S1'],wrapper:{inputCapacity:1,outputCapacity:1,conveyorCapacity:5},
    agfs:[1,2,3,4].map(n=>({id:'AGF'+n,area:'PZ',batteryPct:100,blocked:n>1})),
    chargerIds:['C1','C2'],battery:{reservePct:40,chargeStartPct:40,chargeTargetPct:80,
      consumptionPct:0,chargeMinPerPct:.1},
    times:{emptyMin:1,loadedMin:1,pickupMin:0,dropoffMin:0,wrapMin:.1,labelMin:0,
      exitMin:0,chargeTravelMin:1},
    warehouse:[{id:'S1',rowId:'R1',capacity:100,permission:true}],
    magazines:[1,2,3,4,5].map(n=>({id:'M'+n,quantity:4,capacity:100,trigger:3,refillBatch:10,permission:true})),
    aligners:[1,2,3,4,5].map(n=>({id:'AL'+n,quantity:10})),
    productionEvents:[{timeMs:0,lineId:'L8',palletId:'SYN-PRIORITY-SEED',destinationLocationId:'S1'}],
    taskPriorities:{wrapperOutput:10,magazines:{M1:24,M2:22,M3:23,M4:20,M5:21},
      lines:{L1:30,L2:34,L3:34,L4:32,L5:33,L6:31,L7:34,L8:34}},
    ...overrides
  };
}
