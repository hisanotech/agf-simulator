/** Synthetic software regression only: no facility timing, geometry or records. */
export function bufferHistoryScenario(overrides={}){
  return {
    name:'Synthetic buffer recovery integration',preset:'synthetic-buffer-regression',
    evidence:{production:'synthetic-regression',timing:'synthetic-assumption',inventory:'synthetic-regression'},
    durationMin:180,mode:'area_first',fallback:'any',lineCapacity:1,
    productionModel:'empty_pallet_supply',lineMagazineMapPolicy:'scenario',
    lineMagazineMap:Object.fromEntries(Array.from({length:8},(_,i)=>['L'+(i+1),'M1'])),
    lineMagazineMapEvidence:'synthetic test mapping',magazineEmptyRecoveryPolicy:'immediate_retry',
    lineIntervalsMin:[10,0,0,0,0,0,0,0],lineStartOffsetsMin:Array(8).fill(0),
    generatedDestinationIds:['S1'],wrapper:{inputCapacity:1,conveyorCapacity:5,outputCapacity:1},
    agfs:[1,2,3,4].map(n=>({id:'AGF'+n,area:n===4?'WH':'PZ',batteryPct:100})),chargerIds:['C1','C2'],
    battery:{reservePct:40,chargeStartPct:40,chargeTargetPct:80,consumptionPct:0,chargeMinPerPct:2.4},
    times:{emptyMin:12,loadedMin:1,pickupMin:0,dropoffMin:0,wrapMin:1,labelMin:0,exitMin:0,chargeTravelMin:1},
    warehouse:[{id:'S1',rowId:'R1',capacity:100,permission:true}],
    magazines:[{id:'M1',quantity:100,capacity:120,trigger:3,refillBatch:10,permission:true}],
    aligners:[{id:'AL1',quantity:10}],...overrides
  };
}
