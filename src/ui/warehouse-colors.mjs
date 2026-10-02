import {warehouseRowOwner} from '../core/warehouse-policy.mjs';
import {escapeHtml as esc} from './format.mjs';

/** Display colors identify allocation only; they do not change slot state or permissions. */
export const WAREHOUSE_OWNER_COLORS=Object.freeze(Object.fromEntries([
  ['L1','GWI','#0284c7','#e0f2fe'],['L2','GWII','#0d9488','#ccfbf1'],
  ['L3','GWIII','#7c3aed','#ede9fe'],['L4','GWIV','#b45309','#ffedd5'],
  ['L5','GWV','#4d7c0f','#ecfccb'],['L6','GWVI','#a21caf','#fae8ff'],
  ['L7','GWVII','#334155','#e2e8f0'],['L8','GWVIII','#ca8a04','#fef9c3'],
  ['SPECIAL','SPECIAL','#d946ef','#f5d0fe'],['UNASSIGNED','未割当','#94a3b8','#f1f5f9']
].map(([owner,label,color,tint])=>[owner,Object.freeze({owner,label,color,tint})])));

export function warehouseRowStyle(policy,rowId){
  const owner=warehouseRowOwner(policy?.rowAssignments?.find(a=>a.rowId===rowId));
  return WAREHOUSE_OWNER_COLORS[owner]??WAREHOUSE_OWNER_COLORS.UNASSIGNED;
}

/** Shared by the overall map and its warehouse detail dialog. */
export function warehouseOwnerLegend(){
  return `<div class="warehouse-owner-legend" aria-label="倉庫の系列割当凡例">${Object.values(WAREHOUSE_OWNER_COLORS).map(({owner,label,color})=>
    `<span data-owner="${owner}"><i style="background:${color}"></i>${esc(label)}</span>`).join('')}</div>`;
}
