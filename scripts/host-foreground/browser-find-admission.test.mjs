import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBrowserFindAdmission} from './browser-find-admission.mjs';
function scenario(){
 let time=1000;
 const admission=createBrowserFindAdmission({now:()=>time});
 const root={windowId:10,pid:20,processStartTicks:'30000'};
 const baseline={role:'browser',sample:{root,foreground:root,browserPopupInventoryComplete:true,browserOwnedPopups:[]},recheck:{browserPopupInventoryComplete:true,browserOwnedPopups:[]}};
 const action={kind:'keypress',keys:['CTRL','F'],actionId:'find-open',basedOn:'original'};
 const child={windowId:11,pid:20,processStartTicks:'30000',ownerWindowId:10};
 const sample={role:'browser-popup',root,foreground:child,foregroundWindowId:11,browserPopupInventoryComplete:true,browserOwnedPopups:[child]};
 const focus={confirmed:true,controlType:'Edit',runtimeId:[1,2,3],nativeWindowId:11,processId:20};
 const popup={sample:structuredClone(sample),recheck:structuredClone(sample),browserPopupFocus:structuredClone(focus),browserPopupFocusRecheck:structuredClone(focus)};
 return {admission,baseline,action,popup,advance:ms=>{time+=ms;}};
}
test('completed Ctrl+F plus new direct-owned popup and exact focused UIA edit admit only that popup',()=>{
 const f=scenario();f.admission.completed({action:f.action,receipt:{status:'completed'},scope:f.baseline});
 const result=f.admission.project(f.popup);assert.equal(result.sample.role,'browser');
 assert.equal(result.sample.browserFindAdmission.popupWindowId,11);assert.equal(result.sample.browserFindAdmission.rootWindowId,10);
 assert.equal(f.popup.sample.role,'browser-popup');
});
for(const [label,mutate]of [
 ['no preceding completed shortcut',f=>{}],
 ['refused shortcut',f=>f.admission.completed({action:f.action,receipt:{status:'refused'},scope:f.baseline})],
 ['partial baseline',f=>{f.baseline.sample.browserPopupInventoryComplete=false;f.admission.completed({action:f.action,receipt:{status:'completed'},scope:f.baseline});}],
 ['preexisting popup',f=>{f.baseline.sample.browserOwnedPopups=[f.popup.sample.foreground];f.baseline.recheck.browserOwnedPopups=structuredClone(f.baseline.sample.browserOwnedPopups);f.admission.completed({action:f.action,receipt:{status:'completed'},scope:f.baseline});}],
])test(`${label} never authorizes a browser child`,()=>{const f=scenario();mutate(f);assert.equal(f.admission.project(f.popup).sample.role,'browser-popup');});
for(const [label,mutate]of [
 ['unknown UIA control',f=>{f.popup.browserPopupFocus.controlType='Button';f.popup.browserPopupFocusRecheck.controlType='Button';}],
 ['focus changed during probe',f=>{f.popup.browserPopupFocusRecheck.runtimeId=[9];}],
 ['private-window owner',f=>{f.popup.sample.foreground.ownerWindowId=99;}],
 ['more than one new popup',f=>{f.popup.sample.browserOwnedPopups.push({windowId:12});}],
 ['expired intent',f=>f.advance(120001)],
])test(`${label} prevents popup admission`,()=>{
 const f=scenario();f.admission.completed({action:f.action,receipt:{status:'completed'},scope:f.baseline});mutate(f);
 assert.equal(f.admission.project(f.popup).sample.role,'browser-popup');
});
test('switching away or completing Escape retires find intent',()=>{
 for(const escape of [false,true]){
  const f=scenario();f.admission.completed({action:f.action,receipt:{status:'completed'},scope:f.baseline});
  if(escape)f.admission.completed({action:{kind:'keypress',keys:['ESC']},receipt:{status:'completed'},scope:{}});
  else f.admission.project({sample:{role:'outside',foregroundWindowId:99}});
  assert.equal(f.admission.project(f.popup).sample.role,'browser-popup');
 }
});
