import assert from 'node:assert/strict';
import {test} from 'node:test';
import {capturePointScopeBinding,assessPointScope} from './point-scope.mjs';
const rect=(left,top,right,bottom)=>({left,top,right,bottom});
const native=(windowId,bounds,patch={})=>({valid:true,pid:10,windowId,threadId:20,dpi:144,processStartTicks:'10000',parentWindowId:0,ownerWindowId:0,
 windowClass:'Synthetic',visible:true,enabled:true,minimized:false,cloakedKnown:true,cloaked:false,boundsValid:true,bounds,...patch});
function fixture(){
 const root=native(100,rect(10,10,600,600),{enabled:false});
 const dialog=native(101,rect(100,100,500,400),{ownerWindowId:100,windowClass:'#32770'});
 const control=native(102,rect(200,320,350,350),{parentWindowId:101,windowClass:'ComboBox'});
 const list=native(103,rect(200,350,350,550),{ownerWindowId:101});
 const sample={role:'editor',coordinateSpace:'physical-screen-pixels',physicalCoordinates:true,rootIdentityValid:true,guiInfoValid:true,controlsComplete:false,
  foregroundWindowId:101,focusWindowId:102,captureWindowId:0,activeWindowId:101,root,foreground:dialog,ownerChain:[dialog,root],focusWindow:control,focusParents:[control,dialog],
  regions:[{kind:'foreground',window:dialog,parentChain:[dialog],ownerChain:[dialog,root]},
   {kind:'combo-list',proof:'GetComboBoxInfo',comboWindowId:102,listWindowId:103,window:list,control,parentChain:[control,dialog],ownerChain:[list,dialog,root]}]};
 const time=Date.now();
 const scope={schema:'host-point-scope/v1',capturedAt:time,completedAt:time,sample:structuredClone(sample),recheck:structuredClone(sample)};
 const binding=capturePointScopeBinding({scope,observationId:'obs',collectedAt:time});assert.equal(binding.ok,true,binding.reason);
 const current=(point,window=list,parents=[list])=>{
  const value=structuredClone(scope);value.capturedAt=time+1;value.completedAt=time+1;
  for(const row of [value.sample,value.recheck])row.pointHit={point,window,parentChain:parents,ownerChain:window.windowId===103?[list,dialog,root]:[window]};
  return value;
 };
 const check=(value,points=[])=>assessPointScope({binding:binding.binding,currentScope:value,observationId:'obs',points,maxAgeMs:100,now:time+2});
 return {scope,binding:binding.binding,current,check,root,dialog,control,list,time};
}
test('out-of-dialog list item is accepted only through exact combo identity and current hit',()=>{
 const f=fixture(),point={x:220,y:480};assert.equal(f.check(f.current(point),[point]).ok,true);
 // Partial localized control enumeration is not a global-inventory veto.
 assert.equal(f.scope.sample.controlsComplete,false);
});
test('bounding union gaps, taskbar and unrelated menus are not input regions',()=>{
 for(const [point,window]of [[{x:450,y:480},native(900,rect(400,450,600,600))],[{x:300,y:700},native(901,rect(0,680,1000,740))],[{x:220,y:480},native(902,rect(200,350,350,550),{windowClass:'#32768'})]]){
  const f=fixture();assert.equal(f.check(f.current(point,window,[window]),[point]).ok,false);
 }
});
test('same PID and popup class do not replace GetComboBoxInfo proof',()=>{
 const f=fixture(),value=f.current({x:220,y:480});
 for(const sample of [value.sample,value.recheck])sample.regions[1].proof='same-pid';
 assert.equal(f.check(value,[{x:220,y:480}]).ok,false);
});
test('precise control relationship permits a cross-process list',()=>{
 const f=fixture();
 for(const sample of [f.scope.sample,f.scope.recheck]){
  sample.regions[1].window.pid=30;sample.regions[1].window.processStartTicks='30000';
  sample.regions[1].ownerChain[0].pid=30;sample.regions[1].ownerChain[0].processStartTicks='30000';
 }
 const captured=capturePointScopeBinding({scope:f.scope,observationId:'cross',collectedAt:f.time});assert.equal(captured.ok,true,captured.reason);
 const value=structuredClone(f.scope),point={x:220,y:480};value.capturedAt=f.time+1;value.completedAt=f.time+1;
 for(const sample of [value.sample,value.recheck]){const list=sample.regions[1].window;sample.pointHit={point,window:list,parentChain:[list],ownerChain:sample.regions[1].ownerChain};}
 assert.equal(assessPointScope({binding:captured.binding,currentScope:value,observationId:'cross',points:[point],now:f.time+2}).ok,true);
});
for(const [label,change]of [
 ['closed list',sample=>{sample.regions=sample.regions.slice(0,1);}],
 ['moved list',sample=>{sample.regions[1].window.bounds.bottom+=10;sample.regions[1].ownerChain[0].bounds.bottom+=10;}],
 ['different foreground',sample=>{sample.foregroundWindowId=999;}],
 ['recycled process identity',sample=>{sample.root.processStartTicks='99999';}],
 ['different focus',sample=>{sample.focusWindowId=0;}],
 ['DPI changed',sample=>{sample.foreground.dpi=96;}],
])test(`${label} invalidates observation instead of reusing old allowed coordinates`,()=>{
 const f=fixture(),value=f.current({x:220,y:480});for(const sample of [value.sample,value.recheck])change(sample);
 assert.equal(f.check(value,[{x:220,y:480}]).ok,false);
});
test('change inside the probe and stale observation both fail closed',()=>{
 const f=fixture(),value=f.current({x:220,y:480});value.recheck.foregroundWindowId=999;
 assert.equal(f.check(value).ok,false);
 assert.equal(assessPointScope({binding:f.binding,currentScope:f.scope,observationId:'obs',now:f.time+501,maxAgeMs:500}).ok,false);
 assert.equal(assessPointScope({binding:f.binding,currentScope:f.scope,observationId:'old',now:f.time}).ok,false);
});
