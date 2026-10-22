import {isDeepStrictEqual} from 'node:util';
const sameNative=(a,b)=>a?.windowId===b?.windowId&&a?.pid===b?.pid&&a?.processStartTicks===b?.processStartTicks;
const isFindShortcut=action=>action.kind==='keypress'&&action.keys.length===2&&action.keys.some(k=>k.toUpperCase()==='CTRL')&&action.keys.some(k=>k.toUpperCase()==='F');
export function createBrowserFindAdmission({now=Date.now,maxAgeMs=120000}={}){
 let intent;
 return {
  completed({action,receipt,scope}){
   if(receipt.status!=='completed'){intent=undefined;return;}
   if(isFindShortcut(action)&&scope.role==='browser'&&sameNative(scope.sample?.root,scope.sample?.foreground)&&
      scope.sample.browserPopupInventoryComplete===true&&scope.recheck.browserPopupInventoryComplete===true&&
      isDeepStrictEqual(scope.sample.browserOwnedPopups,scope.recheck.browserOwnedPopups)){
    intent={actionId:action.actionId,observationId:action.basedOn,root:structuredClone(scope.sample.root),baseline:scope.sample.browserOwnedPopups.map(w=>w.windowId),completedAt:now()};
   }else if(action.kind==='keypress'&&action.keys.some(k=>['ESC','ESCAPE'].includes(k.toUpperCase())))intent=undefined;
  },
  project(value){
   if(value.sample?.role!=='browser-popup'){
    if(intent&&value.sample?.foregroundWindowId!==intent.root.windowId)intent=undefined;
    return value;
   }
   if(!intent||now()<intent.completedAt||now()-intent.completedAt>maxAgeMs)return value;
   const proofs=[value.browserPopupFocus,value.browserPopupFocusRecheck];
   if(!proofs.every(p=>p?.confirmed===true&&p.controlType==='Edit'&&Array.isArray(p.runtimeId)&&p.runtimeId.length>0)||!isDeepStrictEqual(proofs[0],proofs[1]))return value;
   for(const sample of [value.sample,value.recheck]){
    const extras=sample.browserOwnedPopups?.filter(w=>!intent.baseline.includes(w.windowId));
    if(!sameNative(sample.root,intent.root)||sample.browserPopupInventoryComplete!==true||extras?.length!==1||
       !sameNative(extras[0],sample.foreground)||sample.foreground.ownerWindowId!==intent.root.windowId||
       sample.foreground.pid!==intent.root.pid||proofs[0].nativeWindowId!==sample.foregroundWindowId||proofs[0].processId!==intent.root.pid)return value;
   }
   const admission={kind:'completed-ctrl-f-owned-uia-edit-v1',actionId:intent.actionId,observationId:intent.observationId,
    completedAt:intent.completedAt,rootWindowId:intent.root.windowId,popupWindowId:value.sample.foregroundWindowId,focus:proofs[0]};
   return {...value,sample:{...value.sample,role:'browser',browserFindAdmission:admission},recheck:{...value.recheck,role:'browser',browserFindAdmission:admission}};
  },
 };
}
