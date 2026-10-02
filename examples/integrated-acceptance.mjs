import {createDemoScenario} from '../src/ui/scenario.mjs';
import {syntheticWarehousePolicy} from './synthetic-warehouse-policy.mjs';
import {generateProductionEvents} from '../src/core/production-streams.mjs';

/** Reproducible synthetic inventory/geometry/timing, with confirmed waiting priority. */
export function integratedAcceptanceScenario(kind='normal'){
  if(!['normal','recovery','charging-boundary'].includes(kind))throw new Error('Unknown acceptance case');
  const s=createDemoScenario('extended');
  // Explicit legacy regression fixture: pre-existing stocks/inputs are NOT the
  // ordinary neutral Run. New coupled-production acceptance uses a separate fixture.
  s.productionModel='legacy_external_pallets';
  s.lineIntervalsMin=Array(8).fill(0);
  s.magazines.forEach(m=>{m.quantity=4;});
  s.aligners=s.aligners.map(a=>({id:a.id,quantity:0}));
  s.temporaryPallets=[1,2,3].map(i=>({palletId:'SIM-TEMP-'+i,locationId:'OT'+i,
    destinationLocationId:null,sourceLineId:'L'+i,productType:'normal',loadType:'full'}));
  s.warehousePolicy=syntheticWarehousePolicy();
  s.evidence.acceptanceCase=kind;
  // Four variants share the same 100%-capacity theoretical production stream.
  // Adding independent variant streams would exceed that baseline and create
  // impossible same-line discharge bursts. These substitutions are test inputs,
  // not observed product mix or an operational production rule.
  s.productionEvents=generateProductionEvents(s.productStreams,180*60000,Array.from({length:8},(_,i)=>'L'+(i+1)));
  const l1=s.productionEvents.filter(p=>p.sourceLineId==='L1');l1[1].loadType='partial';
  const l4=s.productionEvents.filter(p=>p.sourceLineId==='L4');
  l4[0].productType='special';l4[1].productType='special';l4[1].loadType='partial';
  s.productionEvents.forEach((p,i)=>p.palletId='ACCEPT-'+p.sourceLineId+'-'+(i+1));
  s.productStreams.forEach(p=>p.enabled=false);
  s.evidence.production='synthetic-fixed-theoretical-stream-with-mixed-products';
  Object.assign(s.temporaryPallets[0],{loadType:'partial'});
  Object.assign(s.temporaryPallets[1],{productType:'special'});
  Object.assign(s.temporaryPallets[2],{productType:'special',loadType:'partial'});
  s.manualRequests=[
    {timeMs:2*60000,kind:'04',palletId:'SIM-TEMP-1',locationId:'OT1',reentryPermission:true},
    {timeMs:5*60000,kind:'05',palletId:'SIM-TEMP-2',locationId:'OT2',storagePermission:true},
    {timeMs:9*60000,kind:'05',palletId:'SIM-TEMP-3',locationId:'OT3',storagePermission:true}
  ];
  s.aligners[0].quantity=10;s.magazineUses=[{timeMs:0,magazineId:'M1'}];
  if(kind==='recovery'){
    s.permissionEvents=[
      {timeMs:5*60000+1,target:'warehouse',targetId:'EB2-R02-C18-T1',permitted:false},
      {timeMs:35*60000,target:'warehouse',targetId:'EB2-R02-C18-T1',permitted:true}
    ];
    s.shutterEvents=[{timeMs:25*60000,shutterId:'SH-EAST',passable:false},
      {timeMs:55*60000,shutterId:'SH-EAST',passable:true}];
  }
  if(kind==='charging-boundary'){
    s.agfs.forEach(a=>{a.batteryPct=40;});
    s.battery.chargeTargetPct=100;
    s.productionEvents=[];s.manualRequests=[];s.magazineUses=[];
  }
  return s;
}
