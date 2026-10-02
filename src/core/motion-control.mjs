const required=(test,message)=>{if(!test)throw new Error(message);};

export const HEADING_DEGREES={east:0,south:90,west:180,north:270};
export const normalizeHeading=degrees=>((degrees%360)+360)%360;
export function directionHeading(from,to){
  return normalizeHeading(Math.atan2(to.y-from.y,to.x-from.x)*180/Math.PI);
}
export function turnAngle(from,to){
  // A shortest angular difference is a synthetic model convention. It does not
  // establish a site's permitted clockwise/counterclockwise turn direction.
  const angle=((normalizeHeading(to)-normalizeHeading(from)+540)%360)-180;
  return angle===-180?180:angle;
}
export function cardinalHeading(degrees){
  return ['east','south','west','north'][Math.round(normalizeHeading(degrees)/90)%4];
}
export function validateMotionControl(control){
  if(!control)return;
  required(control.turnRateDegPerSec==null||Number.isFinite(control.turnRateDegPerSec)&&
    control.turnRateDegPerSec>0,'motionControl.turnRateDegPerSec must be positive or unresolved');
  if(control.turnRateDegPerSec!=null)required(typeof control.turnRateEvidence==='string'&&control.turnRateEvidence,
    'motionControl.turnRateEvidence is required for a configured rate');
  required(control.turningConsumesBattery==null||typeof control.turningConsumesBattery==='boolean',
    'motionControl.turningConsumesBattery must be explicit or unresolved');
  for(const key of ['pickupPositioningMin','pickupForkInsertedMin','dropoffPositioningMin','dropoffForkInsertedMin']){
    required(control[key]==null||Number.isFinite(control[key])&&control[key]>=0,
      'motionControl.'+key+' must be nonnegative or unresolved');
    if(control[key]!=null)required(typeof control.handlingEvidence==='string'&&control.handlingEvidence,
      'motionControl.handlingEvidence is required for configured handling phases');
  }
}
export function handlingDurations(control,kind){
  const keys=kind==='pickup'?['pickupPositioningMin','pickupForkInsertedMin']:
    ['dropoffPositioningMin','dropoffForkInsertedMin'];
  if(!control||keys.every(key=>!(key in control)))return {kind:'legacy-unsplit'};
  if(keys.some(key=>control[key]==null))return {kind:'unresolved'};
  return {kind:'split',positioningMs:Math.round(control[keys[0]]*60000),
    forkInsertedMs:Math.round(control[keys[1]]*60000),evidence:control.handlingEvidence};
}
