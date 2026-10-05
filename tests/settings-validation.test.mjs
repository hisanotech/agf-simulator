import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeInvalidFields,nativeFieldMessage,describeSettingsError,settingsErrorControls} from '../src/ui/settings-validation.mjs';
import {syntheticWarehousePolicy} from '../examples/synthetic-warehouse-policy.mjs';
import {validateWarehousePolicy} from '../src/core/warehouse-policy.mjs';
import {warehouseLocations} from '../src/map/warehouse-layout.mjs';

const field=(value,dataset={},extra={})=>({value,dataset,disabled:false,willValidate:true,validity:{valid:true},...extra});
const root=fields=>({querySelectorAll(selector){
  if(selector==='input,select,textarea')return fields;
  if(selector==='[data-row-owner]')return fields.filter(f=>f.dataset.rowOwner);
  if(selector==='[data-line-magazine]')return fields.filter(f=>f.dataset.lineMagazine);
  if(selector==='[id^="initial-position-"]')return fields.filter(f=>f.id?.startsWith('initial-position-'));
  const priority=selector.match(/^\[data-row-priority="([\w-]+)"\]$/)?.[1];
  if(priority)return fields.filter(f=>f.dataset.rowPriority===priority);
  if(selector.startsWith('#'))return fields.filter(f=>f.id===selector.slice(1));
  throw new Error('Unexpected test selector: '+selector);
}});
const capture=fn=>{try{fn();assert.fail('Expected validation to reject this setting');}catch(error){if(error.code==='ERR_ASSERTION')throw error;return error;}};
const warehouseError=policy=>capture(()=>validateWarehousePolicy(policy,warehouseLocations(),{lineIds:Array.from({length:8},(_,i)=>'L'+(i+1)),specialEnabled:false}));

test('numeric constraints target invalid enabled fields, with Japanese reasons and no disabled false positives',()=>{
  const valid=field('1'),invalid=field('-1',{}, {min:'0',validity:{valid:false,rangeUnderflow:true}});
  const hiddenLegacy=field('',{}, {disabled:true,validity:{valid:false,valueMissing:true}});
  assert.deepEqual(nativeInvalidFields(root([valid,invalid,hiddenLegacy])),[invalid]);
  assert.equal(nativeFieldMessage(invalid),'0以上の値を入力してください。');
  assert.equal(nativeFieldMessage({validity:{valueMissing:true}}),'値を入力してください。');
  assert.equal(nativeFieldMessage({validity:{stepMismatch:true},step:'.001'}),'.001刻みの値を入力してください。');
});

test('missing magazine mapping highlights only unconfigured lines',()=>{
  const fields=Array.from({length:8},(_,i)=>field(i===1||i===6?'':'M1',{lineMagazine:'L'+(i+1)}));
  const error=new Error('PRODUCTION_CONFIG: lineMagazineMap must assign every L1–L8 to an existing magazine');
  assert.deepEqual(settingsErrorControls(root(fields),error),[fields[1],fields[6]]);
  assert.match(describeSettingsError(error).message,/全8系列/);
});

test('disconnected warehouse allocation reveals both assigned rows and the intervening gap',()=>{
  const policy=syntheticWarehousePolicy();policy.rowAssignments=policy.rowAssignments.filter(a=>a.rowId!=='WB1-R02');
  const fields=[field('L1',{rowOwner:'WB1-R01'}),field('',{rowOwner:'WB1-R02'}),field('L1',{rowOwner:'WB1-R03'}),field('L2',{rowOwner:'WB1-R04'})];
  const error=warehouseError(policy);
  assert.match(error.message,/L1の領域が分断/);
  assert.deepEqual(settingsErrorControls(root(fields),error),fields.slice(0,3));
});

test('a missing series allocation navigates to editable unassigned rows',()=>{
  const policy=syntheticWarehousePolicy();policy.rowAssignments=policy.rowAssignments.filter(a=>a.sourceLineId!=='L8');
  const fields=[field('L7',{rowOwner:'EB1-R03'}),field('',{rowOwner:'EB2-R01'}),field('SPECIAL',{rowOwner:'EB2-R02'})];
  const error=warehouseError(policy);
  assert.match(error.message,/L8に最低1行/);
  assert.deepEqual(settingsErrorControls(root(fields),error),[fields[1]]);
});

test('duplicate warehouse priority identifies the offending priority inputs rather than all settings',()=>{
  const fields=[field('1',{rowPriority:'WB1-R01'}),field('1',{rowPriority:'WB1-R02'}),field('3',{rowPriority:'WB1-R03'})];
  const error=Object.assign(new Error('L1の行優先順位は重複のない正整数にしてください。'),{
    settingsFieldSelectors:['[data-row-priority="WB1-R01"]','[data-row-priority="WB1-R02"]']});
  assert.deepEqual(settingsErrorControls(root(fields),error),fields.slice(0,2));
});

test('duplicate initial parking highlights only the AGFs sharing a stop',()=>{
  const fields=['CHARGE-PLACE1','CHARGE-PLACE1','HP1','HP2'].map((v,i)=>field(v,{}, {id:'initial-position-'+i}));
  assert.deepEqual(settingsErrorControls(root(fields),new Error('invalid initial parking: four distinct allowed idle stops required')),fields.slice(0,2));
});

test('invalid charging threshold relation reveals both thresholds',()=>{
  const fields=[field('90',{}, {id:'chargeStartPct'}),field('80',{}, {id:'chargeTargetPct'}),field('40',{}, {id:'reservePct'})];
  assert.deepEqual(settingsErrorControls(root(fields),new Error('invalid battery settings')),fields.slice(0,2));
});

test('native invalid field takes priority over a later model error',()=>{
  const invalid=field('',{}, {id:'duration',validity:{valid:false,valueMissing:true}});
  assert.deepEqual(settingsErrorControls(root([invalid,field('',{lineMagazine:'L1'})]),new Error('lineMagazineMap')),[invalid]);
});
