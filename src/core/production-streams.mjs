const minute=n=>Math.round(n*60000);
const required=(ok,msg)=>{if(!ok)throw new Error('PRODUCTION_CONFIG: '+msg);};
export const productVariants=[['normal','full'],['normal','partial'],['special','full'],['special','partial']];
/** User-confirmed defaults at theoretical 100% equipment capacity, not PLC history. */
export const THEORETICAL_LINE_INTERVALS_MIN=Object.freeze([17.2,36.5,36.5,22.9,25.3,21.5,36.5,36.5]);
export function defaultProductStreams(intervals=THEORETICAL_LINE_INTERVALS_MIN,offsets=Array(8).fill(0)){
  return intervals.flatMap((interval,i)=>productVariants.map(([productType,loadType],index)=>({
    sourceLineId:'L'+(i+1),productType,loadType,enabled:index===0&&interval>0,
    intervalMin:interval||THEORETICAL_LINE_INTERVALS_MIN[i],startOffsetMin:offsets[i]??0})));
}
export function generateProductionEvents(streams,durationMs,lineIds){
  required(Array.isArray(streams),'搬出種別設定が必要です。');
  const seen=new Set(),events=[];
  for(const s of streams){
    const key=[s.sourceLineId,s.productType,s.loadType].join('-');
    required(!seen.has(key)&&lineIds.includes(s.sourceLineId)&&productVariants.some(v=>v[0]===s.productType&&v[1]===s.loadType),
      '系列／搬出種別が不明、または重複しています。');seen.add(key);
    required(typeof s.enabled==='boolean','搬出ON/OFFを指定してください。');
    if(!s.enabled)continue;
    required(Number.isFinite(s.intervalMin)&&minute(s.intervalMin)>0&&Number.isFinite(s.startOffsetMin)&&s.startOffsetMin>=0,
      'ONの搬出間隔は1ミリ秒以上、初回ずらしは0以上にしてください。');
    for(let timeMs=minute(s.intervalMin)+minute(s.startOffsetMin),n=1;timeMs<=durationMs;timeMs+=minute(s.intervalMin),n++)
      events.push({timeMs,lineId:s.sourceLineId,sourceLineId:s.sourceLineId,productType:s.productType,loadType:s.loadType,
        palletId:`SIM-${key}-${n}`,inputKind:'synthetic-product-interval'});
  }
  return events.sort((a,b)=>a.timeMs-b.timeMs||a.palletId.localeCompare(b.palletId,'en'));
}
