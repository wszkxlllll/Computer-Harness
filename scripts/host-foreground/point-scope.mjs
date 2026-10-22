import {isDeepStrictEqual} from 'node:util';

// Host-only Win32 evidence consumption. These functions compare native identities
// and geometry, not file contents, hashes, screenshots, titles, or UI text.
// Protocol: probe before/after observation; retain a binding only if stable.
// Immediately before dispatch, probe with the actual physical point and assess
// that SAME observation binding. No new evidence may be attached to an old
// observation. One PS invocation proves one point; assess each point separately.
// The probe and CUA dispatch are different processes: this is a last-moment
// fail-closed recheck, NOT an atomic Win32 check-and-send primitive. Never replay
// a candidate after a failed check or an unknown dispatch result.

const integer=Number.isSafeInteger;
const positive=value=>integer(value)&&value>0;
const failure=reason=>({ok:false,reason});
const sameWindow=(left,right)=>left?.windowId===right?.windowId&&left?.pid===right?.pid&&left?.processStartTicks===right?.processStartTicks;
function rect(value){
 if(!value||!['left','top','right','bottom'].every(key=>integer(value[key]))||value.right<=value.left||value.bottom<=value.top)throw Error('invalid physical bounds');
 return {left:value.left,top:value.top,right:value.right,bottom:value.bottom};
}
function window(value){
 if(!value||value.valid!==true||!positive(value.pid)||!positive(value.windowId)||!positive(value.threadId)||!positive(value.dpi)||
    !/^\d+$/u.test(value.processStartTicks??'')||!integer(value.parentWindowId)||!integer(value.ownerWindowId)||
    typeof value.windowClass!=='string'||!value.windowClass||
    !['visible','enabled','minimized','cloakedKnown','cloaked','boundsValid'].every(key=>typeof value[key]==='boolean')||!value.boundsValid)throw Error('missing exact native identity/geometry');
 return {pid:value.pid,windowId:value.windowId,processStartTicks:value.processStartTicks,threadId:value.threadId,
  parentWindowId:value.parentWindowId,ownerWindowId:value.ownerWindowId,windowClass:value.windowClass,dpi:value.dpi,
  visible:value.visible,enabled:value.enabled,minimized:value.minimized,cloakedKnown:value.cloakedKnown,cloaked:value.cloaked,bounds:rect(value.bounds)};
}
function chain(value,edge){
 if(!Array.isArray(value)||value.length===0||value.length>32)throw Error('missing localized relationship chain');
 const result=value.map(window),seen=new Set();
 for(let index=0;index<result.length;index++){
  const entry=result[index];if(seen.has(entry.windowId))throw Error('cyclic native relationship');seen.add(entry.windowId);
  if(index+1<result.length&&entry[edge]!==result[index+1].windowId)throw Error('broken native relationship edge');
 }
 return result;
}
function visible(value,{enabled=true,topLevel=false}={}){
 return value.visible&&!value.minimized&&(!enabled||value.enabled)&&(!value.cloakedKnown||!value.cloaked)&&(!topLevel||value.cloakedKnown);
}
function sample(value){
 if(!value||!['editor','browser'].includes(value.role)||value.coordinateSpace!=='physical-screen-pixels'||value.physicalCoordinates!==true||
    value.rootIdentityValid!==true||value.guiInfoValid!==true||typeof value.controlsComplete!=='boolean'||
    !positive(value.foregroundWindowId)||!['focusWindowId','captureWindowId','activeWindowId'].every(key=>integer(value[key])&&value[key]>=0))throw Error('unconfirmed foreground, physical DPI, or GUI-thread evidence');
 const root=window(value.root),foreground=window(value.foreground),owners=chain(value.ownerChain,'ownerWindowId');
 const find=value.browserFindAdmission;
 const admittedFind=value.role==='browser'&&find?.kind==='completed-ctrl-f-owned-uia-edit-v1'&&
  find.rootWindowId===root.windowId&&find.popupWindowId===foreground.windowId&&foreground.ownerWindowId===root.windowId&&
  find.focus?.confirmed===true&&find.focus.controlType==='Edit'&&find.focus.nativeWindowId===foreground.windowId&&
  find.focus.processId===root.pid&&Array.isArray(find.focus.runtimeId)&&find.focus.runtimeId.length>0;
 if(!visible(root,{enabled:false,topLevel:true})||!visible(foreground,{topLevel:true})||foreground.windowId!==value.foregroundWindowId||
    !sameWindow(owners[0],foreground)||!owners.some(entry=>sameWindow(entry,root))||
    (!sameWindow(foreground,root)&&foreground.windowClass!=='#32770'&&!admittedFind))throw Error('unproven exact Run root/dialog ownership');
 if(!Array.isArray(value.regions)||value.regions.length===0||value.regions.length>4097)throw Error('missing exact region set');
 const regions=value.regions.map(region=>{
  const native=window(region.window),parents=chain(region.parentChain,'parentWindowId'),regionOwners=chain(region.ownerChain,'ownerWindowId');
  if(!visible(native)||!sameWindow(regionOwners[0],native))throw Error('region is not currently usable');
  if(region.kind==='foreground'){
   if(!isDeepStrictEqual(native,foreground)||!sameWindow(parents[0],native)||!isDeepStrictEqual(regionOwners,owners))throw Error('foreground region mismatch');
   return {kind:'foreground',window:native,parentChain:parents,ownerChain:regionOwners};
  }
  if(region.kind!=='combo-list'||region.proof!=='GetComboBoxInfo')throw Error('unknown list relationship');
  const control=window(region.control);
  if(region.comboWindowId!==control.windowId||region.listWindowId!==native.windowId||!visible(control)||
     !['ComboBox','ComboBoxEx32'].includes(control.windowClass)||!sameWindow(parents[0],control)||
     !parents.some(entry=>sameWindow(entry,foreground)))throw Error('list is not linked to the exact foreground combo control');
  // GetComboBoxInfo's exact HWND relationship, not PID equality or class name,
  // is authoritative. A legitimate cross-process child/list is not rejected.
  return {kind:'combo-list',proof:region.proof,comboWindowId:region.comboWindowId,listWindowId:region.listWindowId,
   window:native,control,parentChain:parents,ownerChain:regionOwners};
 });
 if(regions.filter(region=>region.kind==='foreground').length!==1||new Set(regions.map(region=>region.window.windowId)).size!==regions.length)throw Error('ambiguous exact region set');
 regions.sort((left,right)=>left.kind.localeCompare(right.kind)||left.window.windowId-right.window.windowId);
 const inputTargets={};
 for(const name of ['focus','capture']){
  const id=value[`${name}WindowId`];
  if(!id){inputTargets[name]=null;continue;}
  const native=window(value[`${name}Window`]),parents=chain(value[`${name}Parents`],'parentWindowId');
  if(native.windowId!==id||!visible(native)||!sameWindow(parents[0],native)||
     !regions.some(region=>parents.some(entry=>sameWindow(entry,region.window))))throw Error(`${name} target is outside the exact scope`);
  inputTargets[name]={window:native,parentChain:parents};
 }
 if(value.activeWindowId!==foreground.windowId)throw Error('GUI active window conflicts with foreground');
 return {role:value.role,root,foreground,ownerChain:owners,regions,inputTargets,
  ...(admittedFind?{browserFindAdmission:structuredClone(find)}:{}),
  focusWindowId:value.focusWindowId,captureWindowId:value.captureWindowId,activeWindowId:value.activeWindowId};
}
function hit(value){
 if(!value||!integer(value.point?.x)||!integer(value.point?.y))throw Error('missing current WindowFromPoint evidence');
 const native=window(value.window),parents=chain(value.parentChain,'parentWindowId'),owners=chain(value.ownerChain,'ownerWindowId');
 if(!visible(native)||!sameWindow(parents[0],native)||!sameWindow(owners[0],native))throw Error('unusable current hit');
 return {point:{x:value.point.x,y:value.point.y},window:native,parentChain:parents,ownerChain:owners};
}
function readScope(scope){
 if(scope?.schema!=='host-point-scope/v1'||!integer(scope.capturedAt)||!integer(scope.completedAt)||scope.capturedAt>scope.completedAt)throw Error('missing probe envelope');
 const identity=sample(scope.sample),recheck=sample(scope.recheck);
 if(!isDeepStrictEqual(identity,recheck))throw Error('scope changed during native probe; observe again');
 if(Boolean(scope.sample.pointHit)!==Boolean(scope.recheck.pointHit))throw Error('point evidence changed during native probe');
 let pointHit;
 if(scope.sample.pointHit){pointHit=hit(scope.sample.pointHit);if(!isDeepStrictEqual(pointHit,hit(scope.recheck.pointHit)))throw Error('hit changed during native probe; observe again');}
 return {identity,pointHit,capturedAt:scope.capturedAt,completedAt:scope.completedAt};
}
const inside=(point,bounds)=>point.x>=bounds.left&&point.x<bounds.right&&point.y>=bounds.top&&point.y<bounds.bottom;
const knownObservation=value=>(typeof value==='string'&&value.length>0)||(integer(value)&&value>=0);

export function capturePointScopeBinding({scope,observationId,collectedAt=Date.now()}){
 try{
  if(!knownObservation(observationId)||!integer(collectedAt))throw Error('missing observation identity/time');
  const evidence=readScope(scope);
  if(collectedAt<evidence.completedAt)throw Error('scope was collected after the bound observation');
  return {ok:true,binding:{schema:'host-point-binding/v1',observationId,collectedAt,probeCapturedAt:evidence.capturedAt,
   probeCompletedAt:evidence.completedAt,scopeIdentity:evidence.identity,role:evidence.identity.role,
   foregroundWindowId:evidence.identity.foreground.windowId,regions:evidence.identity.regions}};
 }catch(error){return failure(error.message);}
}

export function assessPointScope({binding,currentScope,observationId,points=[],maxAgeMs=5000,now=Date.now()}){
 try{
  if(binding?.schema!=='host-point-binding/v1'||!knownObservation(observationId)||binding.observationId!==observationId)throw Error('scope is not bound to this observation');
  if(!positive(maxAgeMs)||!integer(now)||!integer(binding.collectedAt)||!integer(binding.probeCapturedAt)||
     now<binding.collectedAt||now-binding.probeCapturedAt>maxAgeMs)throw Error('observation scope expired; observe again');
  const current=readScope(currentScope);
  if(current.capturedAt<binding.probeCompletedAt||current.completedAt>now||now-current.capturedAt>maxAgeMs)throw Error('dispatch probe is not current');
  if(!isDeepStrictEqual(binding.scopeIdentity,current.identity))throw Error('foreground, identity, focus, bounds, or popup set changed; observe again');
  if(!Array.isArray(points)||points.some(point=>!integer(point?.x)||!integer(point?.y)))throw Error('points must be physical integer screen coordinates');
  for(const point of points){
   const currentHit=current.pointHit;
   if(!currentHit||!isDeepStrictEqual(point,currentHit.point)||!inside(point,currentHit.window.bounds))throw Error('missing exact current point hit');
   const region=current.identity.regions.find(candidate=>inside(point,candidate.window.bounds)&&
    currentHit.parentChain.some(entry=>sameWindow(entry,candidate.window)));
   if(!region)throw Error('point hits no verified foreground/control region');
  }
  return {ok:true};
 }catch(error){return failure(error.message);}
}
