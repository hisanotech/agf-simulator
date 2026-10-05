/** UI error navigation only. Core validators remain authoritative. */
export const nativeInvalidFields=root=>[...root.querySelectorAll('input,select,textarea')]
  .filter(field=>!field.disabled&&field.willValidate&&field.validity?.valid===false);

export function nativeFieldMessage(field){
  const v=field.validity??{};
  if(v.badInput||v.typeMismatch)return '数値を正しい形式で入力してください。';
  if(v.valueMissing)return '値を入力してください。';
  if(v.rangeUnderflow)return `${field.min}以上の値を入力してください。`;
  if(v.rangeOverflow)return `${field.max}以下の値を入力してください。`;
  if(v.stepMismatch)return `${field.step||1}刻みの値を入力してください。`;
  return '入力値と単位を確認してください。';
}

export function describeSettingsError(error){
  const message=error.message??String(error);
  const result={message:message.replace(/^(WAREHOUSE_CONFIG|PRODUCTION_CONFIG|MOTION_CONFIG):\s*/,''),selectors:[],section:null,owner:null};
  if(error.settingsFieldSelectors?.length)return {...result,selectors:error.settingsFieldSelectors};
  if(/lineMagazineMap/.test(message))return {...result,section:'#supply-settings',kind:'mapping',
    message:'GWI～GWVIIIの全8系列に、使用するマガジンを指定してください。'};
  if(/magazineEmptyRecoveryPolicy/.test(message))return {...result,selectors:['#magazine-recovery-policy'],message:'空パレット0枚停止後の再開方式を確認してください。'};
  if(/WAREHOUSE_CONFIG|行優先順位/.test(message))return {...result,section:'#warehouse-row-fields',
    owner:message.match(/\b(L[1-8]|SPECIAL)\b/)?.[1]??(/特注/.test(message)?'SPECIAL':null),
    kind:/優先順位/.test(message)?'priority':'allocation'};
  if(/initial parking|initial HP capacity|initial parking selection/.test(message))return {...result,section:'#agf-fields',kind:'parking',message:'初期停止位置は4台を重複なく配置してください。'};
  if(/invalid battery settings/.test(message))return {...result,selectors:['#chargeStartPct','#chargeTargetPct'],message:'充電要求の残量を、復帰残量より小さくしてください。'};
  if(/battery/.test(message)){
    const key=message.match(/battery\.([A-Za-z]+)/)?.[1];
    return {...result,selectors:key?['#'+key]:[],section:'#battery-fields',message:'電池・充電条件を確認してください。基準稼働時間と充電時間は正の値、消費は0～100ポイントで指定します。'};
  }
  if(/MOTION_CONFIG/.test(message))return {...result,section:'#motion-settings',message:'停止旋回・荷役姿勢を確認してください。旋回角速度は正の値、荷役時間は0以上で入力します。'};
  if(/PRODUCTION_CONFIG/.test(message))return {...result,section:'#product-stream-fields'};
  if(/magazine settings/.test(message))return {...result,selectors:['[data-initial-magazine]'],message:'マガジンの初期枚数は容量内の整数で入力してください。'};
  if(/aligner quantity/.test(message))return {...result,selectors:['[data-initial-aligner]'],message:'整列機の初期枚数は0枚または10枚です。'};
  const time=message.match(/times\.([A-Za-z]+)/)?.[1];
  if(time)return {...result,selectors:['#'+time],message:'工程時間を確認してください。包装は正の値、その他は0以上の分で入力します。'};
  const key=['durationMin','lineCapacity','conveyor','wrapper capacities','inboundAgfLimit','fallback'].find(key=>message.includes(key));
  if(key)return {...result,selectors:({durationMin:['#duration'],lineCapacity:['#lineCapacity'],conveyor:['#conveyorCapacity'],
    'wrapper capacities':['#inputCapacity','#outputCapacity'],inboundAgfLimit:['#inboundAgfLimit'],fallback:['#fallback']})[key],
    message:'設備容量・対象時間・選定条件の値を確認してください。'};
  return result;
}

/** Find the affected controls from their current displayed values. */
export function settingsErrorControls(root,error,description=describeSettingsError(error)){
  const all=selector=>[...root.querySelectorAll(selector)].filter(field=>!field.disabled);
  const native=nativeInvalidFields(root);if(native.length)return native;
  if(description.selectors.length)return [...new Set(description.selectors.flatMap(all))];
  if(description.kind==='mapping')return all('[data-line-magazine]').filter(field=>!field.value);
  if(description.kind==='parking'){
    const fields=all('[id^="initial-position-"]');
    return fields.filter(field=>fields.some(other=>other!==field&&other.value===field.value));
  }
  if(description.kind==='allocation'||description.kind==='priority'){
    const fields=all('[data-row-owner]'),assigned=fields.filter(field=>field.value===description.owner);
    if(!assigned.length)return fields.filter(field=>!field.value).length?fields.filter(field=>!field.value):fields;
    if(description.kind==='priority')return assigned.flatMap(field=>all(`[data-row-priority="${field.dataset.rowOwner}"]`));
    // Include the gap which disconnects two rows assigned to the same series.
    const bounds=new Map();
    for(const field of assigned){const [block,row]=field.dataset.rowOwner.split('-R'),n=Number(row),b=bounds.get(block)??[n,n];bounds.set(block,[Math.min(b[0],n),Math.max(b[1],n)]);}
    return fields.filter(field=>{const [block,row]=field.dataset.rowOwner.split('-R'),b=bounds.get(block);return b&&Number(row)>=b[0]&&Number(row)<=b[1];});
  }
  return description.section?all(description.section+' input,'+description.section+' select'):[];
}

export function clearSettingsErrors(root){
  root.querySelectorAll('[data-settings-error]').forEach(node=>node.remove());
  root.querySelectorAll('[data-settings-invalid]').forEach(field=>{
    field.removeAttribute('aria-invalid');
    const ids=(field.getAttribute('aria-describedby')??'').split(/\s+/).filter(id=>id&&!id.startsWith('settings-error-'));
    if(ids.length)field.setAttribute('aria-describedby',ids.join(' '));else field.removeAttribute('aria-describedby');
    field.removeAttribute('data-settings-invalid');
  });
  root.querySelectorAll('.settings-invalid').forEach(node=>node.classList.remove('settings-invalid'));
}

export function applySettingsError(root,error){
  clearSettingsErrors(root);
  const description=describeSettingsError(error),controls=settingsErrorControls(root,error,description);
  const doc=root.ownerDocument;
  for(const [index,field] of controls.entries()){
    const id='settings-error-'+index;
    field.setAttribute('aria-invalid','true');field.setAttribute('data-settings-invalid','true');
    field.setAttribute('aria-describedby',[(field.getAttribute('aria-describedby')??''),id].filter(Boolean).join(' '));
    field.closest('tr')?.classList.add('settings-invalid');
    const note=doc.createElement('span');note.id=id;note.className='settings-field-error';note.dataset.settingsError='true';
    note.textContent='⚠ '+(field.validity?.valid===false?nativeFieldMessage(field):description.message);
    field.insertAdjacentElement('afterend',note);
    for(let parent=field.parentElement;parent&&parent!==root;parent=parent.parentElement){
      if(parent.tagName!=='DETAILS')continue;
      parent.open=true;parent.classList.add('settings-invalid');
    }
  }
  const target=controls[0]??(description.section?root.querySelector(description.section):null)??root;
  const summary=doc.createElement('div');summary.className='settings-error-summary';summary.dataset.settingsError='true';summary.setAttribute('role','alert');
  summary.textContent=`⚠ 設定を反映できませんでした。${controls.length?`確認が必要な入力欄：${controls.length}か所。`:''} ${description.message}`;
  root.prepend(summary);
  // Open the fallback section too, when an imported setting has no editable control.
  for(let parent=target;parent&&parent!==root;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
  if(target===root)root.setAttribute('tabindex','-1');
  target.scrollIntoView({behavior:'auto',block:'center',inline:'nearest'});
  target.focus?.({preventScroll:true});
  return {target,controls,description};
}
