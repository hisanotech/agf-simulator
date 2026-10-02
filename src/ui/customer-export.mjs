import {customerConditionRows} from './customer-conditions.mjs';
import {customerRunSummary} from './customer-results.mjs';

const cell=value=>{const text=String(value??'');return /[",\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;};
const csv=(header,rows)=>'\ufeff'+[header,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
export const customerConditionsCsv=run=>csv(['区分','項目','対象','値','単位','根拠'],customerConditionRows(run).map(row=>[
  row.category,row.label,row.target||'共通',row.value===null?'未設定':typeof row.value==='boolean'?(row.value?'あり':'なし'):row.value,row.unit,row.evidence]));
export const transportResultsCsv=run=>csv(['搬送','内容','要求件数','完了件数','未完了件数'],customerRunSummary(run).byKind.map(row=>[
  '搬送'+row.kind,row.content,row.requested,row.completed,row.pending]));
export const agfResultsCsv=run=>csv(['AGF','搬送完了件数','搬送01','搬送02','搬送03','搬送04','搬送05','最終バッテリー（%）','充電回数','充電時間（分）'],customerRunSummary(run).agfs.map(agf=>[
  agf.id,agf.completed,...agf.byKind.map(row=>row.completed),agf.finalBatteryPct.toFixed(1),agf.chargeCount,(agf.chargingMs/60000).toFixed(1)]));
export const customerCsvFilename=(run,kind)=>String(typeof run==='object'?run?.runId??'結果':run??'結果')+'-'+({conditions:'シミュレーション条件',transport:'搬送実績',agf:'AGF別実績'})[kind]+'.csv';
