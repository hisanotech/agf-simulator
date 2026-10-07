import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDemoScenario,createLegacyScenario} from '../src/ui/scenario.mjs';
import * as settings from '../src/ui/extended-settings.mjs';
import {describeSettingsError,settingsErrorControls} from '../src/ui/settings-validation.mjs';

const defaults={wrapperOutput:10,magazines:{M1:24,M2:22,M3:23,M4:20,M5:21},
  lines:{L1:30,L2:34,L3:34,L4:32,L5:33,L6:31,L7:34,L8:34}};
const rawValues=priorities=>({'wrapperOutput':String(priorities.wrapperOutput),
  ...Object.fromEntries(Object.entries(priorities.magazines).map(([id,value])=>['magazines.'+id,String(value)])),
  ...Object.fromEntries(Object.entries(priorities.lines).map(([id,value])=>['lines.'+id,String(value)]))});
const capture=fn=>{try{fn();assert.fail('Expected priority rejection');}catch(error){if(error.code==='ERR_ASSERTION')throw error;return error;}};

for(const preset of ['standard','extended'])test(`${preset} starts with the fourteen specified simulation task priorities`,()=>{
  const scenario=createDemoScenario(preset);
  assert.deepEqual(scenario.taskPriorities,defaults);
  assert.equal(scenario.evidence.taskPriorities,'simulation-default-task-priorities');
});
test('editing a scenario does not mutate defaults or another ordinary scenario',()=>{
  const a=createDemoScenario(),b=createDemoScenario();
  a.taskPriorities.magazines.M4=1;a.taskPriorities.lines.L1=99;
  assert.deepEqual(b.taskPriorities,defaults);
  assert.deepEqual(createDemoScenario().taskPriorities,defaults);
});
test('legacy fixtures do not gain implicit automatic task priorities',()=>{
  for(const preset of ['standard','physical','charge','manual'])assert.equal(createLegacyScenario(preset).taskPriorities,undefined);
  for(const preset of ['physical','charge','manual'])assert.equal(createDemoScenario(preset).taskPriorities,undefined);
});
test('priority settings expose exactly fourteen required integer inputs without a charging control',()=>{
  const html=settings.renderTaskPrioritySettings(createDemoScenario()),inputs=[...html.matchAll(/<input\b[^>]*>/g)].map(match=>match[0]);
  assert.equal(inputs.length,14);
  for(const input of inputs){assert.match(input,/data-task-priority=/);assert.match(input,/type="number"/);
    assert.match(input,/min="1"/);assert.match(input,/max="99"/);assert.match(input,/step="1"/);assert.match(input,/\brequired\b/);}
  const fields=rawValues(defaults);
  for(const [path,value] of Object.entries(fields))assert.ok(inputs.some(input=>input.includes(`data-task-priority="${path}"`)&&input.includes(`value="${value}"`)),path);
  assert.match(html,/数値が小さいほど優先/);assert.match(html,/包装機出口/);assert.match(html,/パレットマガジン/);assert.match(html,/系列/);
  assert.doesNotMatch(html,/data-task-priority="[^\"]*(?:charge|CHARGER)/i);
  assert.equal(settings.renderTaskPrioritySettings(createLegacyScenario()),'');
});
test('saved priority values repopulate without being replaced by initial defaults',()=>{
  const scenario=createDemoScenario();scenario.taskPriorities.wrapperOutput=2;scenario.taskPriorities.magazines.M1=99;scenario.taskPriorities.lines.L8=1;
  const html=settings.renderTaskPrioritySettings(scenario);
  for(const [key,value] of [['wrapperOutput',2],['magazines.M1',99],['lines.L8',1]])
    assert.match(html,new RegExp(`data-task-priority="${key}"[^>]*value="${value}"`));
});
test('priority form conversion preserves duplicate priorities and does not mutate saved input',()=>{
  const saved=structuredClone(defaults),values=rawValues(defaults);values['lines.L1']='34';values.wrapperOutput='99';
  const next=settings.taskPrioritiesFromSettings(saved,values);
  assert.equal(next.lines.L1,34);assert.equal(next.lines.L2,34);assert.equal(next.wrapperOutput,99);
  assert.deepEqual(saved,defaults);assert.notEqual(next,saved);assert.notEqual(next.lines,saved.lines);
  assert.equal(settings.taskPrioritiesFromSettings(undefined,{}),undefined);
});
for(const value of ['', '0','100','1.5','NaN','Infinity','-2'])test(`invalid priority ${JSON.stringify(value)} identifies its own form control`,()=>{
  const values=rawValues(defaults);values['magazines.M2']=value;
  const error=capture(()=>settings.taskPrioritiesFromSettings(defaults,values));
  assert.match(error.message,/TASK_PRIORITY_CONFIG/);
  assert.deepEqual(error.settingsFieldSelectors,['[data-task-priority="magazines.M2"]']);
  const description=describeSettingsError(error);assert.match(description.message,/優先度/);assert.doesNotMatch(description.message,/TASK_PRIORITY_CONFIG/);
  const control={disabled:false,willValidate:true,validity:{valid:true},value};
  const root={querySelectorAll(selector){if(selector==='input,select,textarea'||selector==='[data-task-priority="magazines.M2"]')return [control];throw new Error(selector);}};
  assert.deepEqual(settingsErrorControls(root,error),[control]);
});
test('a missing priority remains an error rather than being converted into zero or a default',()=>{
  const values=rawValues(defaults);delete values['lines.L7'];
  const error=capture(()=>settings.taskPrioritiesFromSettings(defaults,values));
  assert.deepEqual(error.settingsFieldSelectors,['[data-task-priority="lines.L7"]']);
});
test('priority module validation rejects misspelled equipment instead of silently ignoring it',()=>{
  const values=rawValues(defaults);values['magazines.M6']='22';
  assert.throws(()=>settings.taskPrioritiesFromSettings(defaults,values),/TASK_PRIORITY_CONFIG/);
});
test('priority settings integrate with existing category, read, dirty, execution and reset paths',()=>{
  const extended=readFileSync(new URL('../src/ui/extended-settings.mjs',import.meta.url),'utf8');
  const app=readFileSync(new URL('../src/ui/app.mjs',import.meta.url),'utf8'),html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/id="task-priority-fields"/);
  assert.match(extended,/populateTaskPrioritySettings\(s\)/);assert.match(extended,/readTaskPrioritySettings\(s\)/);
  assert.match(extended,/'搬送タスク優先度'/);
  assert.match(app,/settings-form'\)\.addEventListener\('input',[^\n]*markDirty/);
  assert.match(app,/simulate\(scenarioFromSettings\(\)\)/);
  assert.match(app,/reset'\)\.addEventListener\('click',[^\n]*populateSettings\(base\)/);
});

test('reading the priority category applies changes only to the candidate and records explicit evidence',()=>{
  const saved={...createLegacyScenario('manual'),taskPriorities:structuredClone(defaults)};
  saved.evidence.taskPriorities='simulation-default-task-priorities';
  const candidate=structuredClone(saved),values=rawValues(defaults),originalDocument=globalThis.document;
  values['lines.L1']='1';
  globalThis.document={querySelectorAll(selector){assert.equal(selector,'[data-task-priority]');
    return Object.entries(values).map(([taskPriority,value])=>({dataset:{taskPriority},value}));}};
  try{
    settings.readExtendedSettings(candidate);
    assert.equal(candidate.taskPriorities.lines.L1,1);
    assert.equal(candidate.evidence.taskPriorities,'explicit-scenario-setting');
    assert.deepEqual(saved.taskPriorities,defaults);
    assert.equal(saved.evidence.taskPriorities,'simulation-default-task-priorities');
    const unchanged=structuredClone(saved);values['lines.L1']='30';settings.readExtendedSettings(unchanged);
    assert.equal(unchanged.evidence.taskPriorities,'simulation-default-task-priorities');
  }finally{if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;}
});

test('priority population shows saved values and removes inactive required controls for legacy presets',()=>{
  const prioritySection={hidden:false},category={hidden:false},priorityRoot={innerHTML:'',closest(selector){return selector==='section'?prioritySection:category;}};
  const nodes={'extended-settings':{},'legacy-settings-note':{},'line-fields':{parentElement:{}},'task-priority-fields':priorityRoot};
  const originalDocument=globalThis.document;
  globalThis.document={getElementById(id){return nodes[id]??null;},querySelectorAll(){return [];}};
  try{
    const scenario={...createLegacyScenario('manual'),taskPriorities:structuredClone(defaults)};
    scenario.taskPriorities.magazines.M4=8;
    settings.populateExtendedSettings(scenario);
    assert.equal(prioritySection.hidden,false);assert.equal(category.hidden,false);
    assert.match(priorityRoot.innerHTML,/data-task-priority="magazines.M4"[^>]*value="8"/);
    settings.populateExtendedSettings(createLegacyScenario('manual'));
    assert.equal(prioritySection.hidden,true);assert.equal(category.hidden,true);assert.equal(priorityRoot.innerHTML,'');
  }finally{if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;}
});
