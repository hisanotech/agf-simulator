import {createDemoScenario} from '../src/ui/scenario.mjs';
import {syntheticWarehousePolicy} from './synthetic-warehouse-policy.mjs';

/** Reproducible synthetic examples only. No site allocation, HP priority or timing approval. */
export function integratedAcceptanceScenario(kind='normal'){
  if(!['normal','recovery','charging-boundary'].includes(kind))throw new Error('Unknown acceptance case');
  const s=createDemoScenario('extended');
  s.warehousePolicy=syntheticWarehousePolicy();
  s.postTaskPolicy={evidence:'synthetic-explicit-example',waitTargets:{AGF1:'HP1',AGF2:'HP2',AGF3:'PILLAR-WAIT-W',AGF4:'PILLAR-WAIT-E'}};
  s.evidence.acceptanceCase=kind;
  const partial=s.productStreams.find(p=>p.sourceLineId==='L1'&&p.productType==='normal'&&p.loadType==='partial');
  Object.assign(partial,{enabled:true,intervalMin:80,startOffsetMin:15});
  const special=s.productStreams.filter(p=>p.sourceLineId==='L4'&&p.productType==='special');
  special.forEach((p,i)=>Object.assign(p,{enabled:true,intervalMin:120+i*5,startOffsetMin:0}));
  Object.assign(s.temporaryPallets[0],{loadType:'partial'});
  Object.assign(s.temporaryPallets[1],{productType:'special'});
  Object.assign(s.temporaryPallets[2],{productType:'special',loadType:'partial'});
  s.manualRequests=[
    {timeMs:2*60000,kind:'04',palletId:'SIM-TEMP-1',locationId:'OT1',reentryPermission:true},
    {timeMs:5*60000,kind:'05',palletId:'SIM-TEMP-2',locationId:'OT2',storagePermission:true},
    {timeMs:9*60000,kind:'05',palletId:'SIM-TEMP-3',locationId:'OT3',storagePermission:true}
  ];
  s.aligners[0].ready=true;s.magazineUses=[{timeMs:0,magazineId:'M1'}];
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
    s.productStreams.forEach(p=>p.enabled=false);s.manualRequests=[];s.magazineUses=[];
  }
  return s;
}
