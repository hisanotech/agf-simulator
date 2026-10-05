import {warehouseLocations,NORMAL_WAITING_PRIORITY} from '../map/warehouse-layout.mjs';
import syntheticTopology from '../../examples/synthetic-operational-topology.json' with {type:'json'};
import {defaultProductStreams,THEORETICAL_LINE_INTERVALS_MIN} from '../core/production-streams.mjs';
import {syntheticWarehousePolicy} from '../../examples/synthetic-warehouse-policy.mjs';
import {convertTopologyToMetric} from '../map/metric-layout.mjs';

// User-confirmed fixed supply correspondence. This does not define CAD positions.
export const CONFIRMED_LINE_MAGAZINE_MAP=Object.freeze({
  L1:'M4',L2:'M4',L3:'M5',L4:'M3',L5:'M2',L6:'M5',L7:'M2',L8:'M1'
});

/** Confirmed defaults carry evidence; unmeasured geometry/timing stay model assumptions. */
export function createDemoScenario(preset='standard',{metricProfile=null}={}) {
  if(preset==='standard'||preset==='extended'){
    const s=createLegacyScenario('physical');s.preset=preset;
    s.wrapper={...s.wrapper,inputCapacity:1,outputCapacity:1,conveyorCapacity:5};
    s.lineIntervalsMin=[...THEORETICAL_LINE_INTERVALS_MIN];
    s.lineStartOffsetsMin=productionOffsets();
    s.productStreams=defaultProductStreams(undefined,s.lineStartOffsetsMin);
    s.evidence.production='theoretical-pallet-discharge-100pct';
    s.productionModel='empty_pallet_supply';
    s.lineMagazineMap={...CONFIRMED_LINE_MAGAZINE_MAP};
    s.lineMagazineMapPolicy='fixed';
    s.magazineEmptyRecoveryPolicy=null;
    s.evidence.lineMagazineMap='user-confirmed-fixed-magazine-mapping';
    s.evidence.magazineEmptyRecoveryPolicy='unresolved';
    s.evidence.inventory='user-confirmed-neutral-start';
    // User requested this existing example as the editable initial allocation.
    // It does not approve physical CAD coordinates or route geometry.
    s.warehousePolicy={...syntheticWarehousePolicy(),evidence:'user-requested-example-default'};
    s.postTaskPolicy={evidence:'user-confirmed-shared-priority',waitingPriority:[...NORMAL_WAITING_PRIORITY]};
    // User-confirmed startup only. The actual stop coordinates remain synthetic.
    s.initialParking={evidence:'user-confirmed-initial-placement',placeIds:['CHARGE-PLACE1','CHARGE-PLACE2','HP1','HP2']};
    s.chargePlaceIds=['CHARGE-PLACE1','CHARGE-PLACE2'];
    // User-requested provisional defaults. Equivalent angular speed derived
    // from catalogue turning travel, not a measured stationary turn rate.
    s.motionControl={turnRateDegPerSec:12.1,turnRateEvidence:'provisional-derived',turningConsumesBattery:true,
      turningBatteryEvidence:'provisional-simulation',avoidanceTieBreakPolicy:null,
      turnRateDerivation:{radiusM:1.424,loadedTurningSpeedMps:.3,source:'user-provided-public-catalogue-values',
        classification:'equivalent-angular-rate-not-measured-stationary-turn'},
      pickupPositioningMin:.25,pickupForkInsertedMin:.10,dropoffPositioningMin:.25,dropoffForkInsertedMin:.15,
      handlingEvidence:'provisional-simulation'};
    s.agfs.forEach((a,i)=>{a.currentNodeId=s.initialParking.placeIds[i];a.area='WH';});
    s.warehouse.forEach(slot=>{slot.palletIds=[];slot.permission=true;});
    s.magazines.forEach(m=>{m.quantity=10;});
    s.aligners=s.aligners.map(a=>({id:a.id,quantity:10}));
    s.temporaryPallets=[];
    s.alignerRefillEvents=[];
    return withMetricLayout(s,metricProfile);
  }
  return withMetricLayout(createLegacyScenario(preset),metricProfile);
}

function withMetricLayout(scenario,profile){
  if(profile&&scenario.operationalTopology){
    scenario.operationalTopology=convertTopologyToMetric(scenario.operationalTopology,profile);
    scenario.evidence.coordinates=profile.evidence;
    scenario.evidence.distance=profile.evidence;
  }
  return scenario;
}

/** Explicit legacy/regression fixtures, never the neutral ordinary Run. */
export function createLegacyScenario(preset='standard') {
  if(!['standard','charge','manual','physical'].includes(preset))throw new Error('Unknown sample scenario');
  const warehouse=warehouseLocations();
  // Exercise all status styles with declared sample state, never a claim about actual inventory.
  warehouse.at(-1).permission=false;
  warehouse.find(slot=>slot.id==='WB1-R07-C13-T2').palletIds=['SIM-INITIAL-1'];
  const generatedDestinationIds=warehouse.filter(slot=>slot.column<=9&&slot.permission&&
    !slot.palletIds?.length).sort((a,b)=>a.column-b.column||a.tier-b.tier||a.row-b.row||
      a.blockId.localeCompare(b.blockId,'en')).map(slot=>slot.id);
  return {
    preset,durationMin:180,mode:'area_first',fallback:'any',lineCapacity:2,
    productionModel:'legacy_external_pallets',
    // Explicit regression assumption; not the unknown real machine angular rate.
    // Preserve legacy indivisible handling durations rather than guessing a split.
    motionControl:{turnRateDegPerSec:45,turnRateEvidence:'synthetic-assumption',turningConsumesBattery:true,turningBatteryEvidence:'synthetic-assumption',avoidanceTieBreakPolicy:null},
    evidence:{structure:'user-confirmed',coordinates:'unreviewed',inventory:'synthetic',
      production:preset==='standard'?'theoretical-pallet-discharge-100pct':'synthetic-intervals',
      productionOffsets:'synthetic-phases',timing:'scenario-assumption',battery:'scenario-assumption',
      batteryConsumption:'supplier-assumption-user-relayed',batteryScope:'user-confirmed-driving-and-handling'},
    lineIntervalsMin:Array.from({length:8},(_,i)=>preset==='manual'?0:preset==='charge'?(i<4?60:0):preset==='physical'?(i<2?45:0):THEORETICAL_LINE_INTERVALS_MIN[i]),
    lineStartOffsetsMin:preset==='standard'?productionOffsets():Array(8).fill(0),
    generatedDestinationIds,
    wrapper:{inputCapacity:1,outputCapacity:2,...(preset==='physical'?{inboundAgfLimit:3}:{})},
    agfs:Array.from({length:4},(_,i)=>({id:'AGF'+(i+1),area:preset==='physical'?'WH':i<2?'PZ':'WH',
      batteryPct:preset==='charge'?41:100,status:'idle',...(preset==='physical'?{currentNodeId:['CHARGE-PLACE1','CHARGE-PLACE2','HP1','HP2'][i]}:{})})),
    chargerIds:['CHARGER1','CHARGER2'],
    battery:{consumptionModel:'active_time',activeReferenceMin:360,activeReferenceConsumptionPct:70,
      reservePct:40,chargeStartPct:40,chargeTargetPct:80,consumptionPct:1.5,chargeMinPerPct:2.4},
    times:{emptyMin:2,loadedMin:3,pickupMin:.5,dropoffMin:.5,wrapMin:3.3,labelMin:.2,exitMin:.2,chargeTravelMin:2},
    warehouse,
    magazines:Array.from({length:5},(_,i)=>({id:'M'+(i+1),quantity:4,capacity:20,trigger:3,refillBatch:10,permission:true})),
    aligners:Array.from({length:5},(_,i)=>({id:'AL'+(i+1),ready:false})),
    temporaryPallets:[1,2,3].map(i=>({palletId:'SIM-TEMP-'+i,locationId:'OT'+i,
      destinationLocationId:generatedDestinationIds.at(-i)})),
    manualRequests:[],magazineUses:[],alignerReadyEvents:[],
    ...(preset==='physical'?{motionModel:'synthetic_graph',operationalTopology:structuredClone(syntheticTopology),
      shutterEvents:[]}:{})
  };
}

// Stagger only the first release as an explicit synthetic phase, independently of
// the confirmed theoretical intervals. User-entered offsets/intervals supersede it.
const productionOffsets=()=>THEORETICAL_LINE_INTERVALS_MIN.map((interval,i)=>Number((interval*i/8).toFixed(3)));

/** Preserve explicit parking selections when the settings form builds a run. */
export function initialAgfFromSettings(scenario,agf,{batteryPct,position}){
  if(scenario.initialParking){
    if(!scenario.initialParking.placeIds.includes(position))throw new Error('invalid initial parking selection');
    return {...agf,batteryPct,area:'WH',currentNodeId:position};
  }
  return {...agf,batteryPct,area:position,...(scenario.motionModel==='synthetic_graph'?
    {currentNodeId:position===agf.area&&agf.currentNodeId?agf.currentNodeId:position==='PZ'?'PZ-HOME':'WH-HOME'}:{})};
}
