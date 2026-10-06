// Canvas drawing units only: these are not equipment mm dimensions or clearances.
export const TEMP_PLACE_SYMBOL=Object.freeze({
  width:56,height:32,rx:6,strokeWidth:1.5,fontSize:12,
  exitMargin:20,gap:14,wallMargin:12,
  legacyStopOffset:44.5,legacyStopPitch:78,legacyStopInset:60
});

/** Lay out one group in the already transformed world, using one common symbol scale. */
export function layoutTempPlaceSymbols({exitRight,southY,pzRight,projectionScale}){
  const symbol=TEMP_PLACE_SYMBOL;
  const span=symbol.exitMargin+3*symbol.width+2*symbol.gap+symbol.wallMargin;
  // Very compressed profiles may need the whole group reduced together. Never
  // apply an individual OT's local metric slope to its width, height or gap.
  const fit=Math.min(1,Math.max(0,pzRight-exitRight)*projectionScale/span);
  const unit=fit/projectionScale,width=symbol.width*unit,height=symbol.height*unit;
  const first=exitRight+symbol.exitMargin*unit,y=southY-symbol.wallMargin*unit-height;
  return [1,2,3].map((n,index)=>({id:'OT'+n,x:first+index*(width+symbol.gap*unit),y,
    width,height,rx:symbol.rx*unit,exitMargin:symbol.exitMargin*unit,gap:symbol.gap*unit,fit}));
}
