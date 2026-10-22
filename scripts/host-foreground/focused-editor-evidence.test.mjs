import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessMultilineEditor,isMultilineAction} from './focused-editor-evidence.mjs';
function probe(){
 const root={windowId:10,pid:20,processStartTicks:'30',valid:true};
 const focus={...root,windowId:11,windowClass:'Edit',editStyleKnown:true,editMultiline:true,editReadOnly:false,visible:true,enabled:true,minimized:false};
 const sample={role:'editor',rootIdentityValid:true,guiInfoValid:true,root,foreground:root,focusWindow:focus,foregroundWindowId:10,activeWindowId:10,focusWindowId:11,focusParents:[focus,root]};
 return {sample,recheck:structuredClone(sample)};
}
test('allows a proven focused writable native document control',()=>assert.equal(assessMultilineEditor(probe()).ok,true));
for(const scenario of ['browser','dialog','single-line','readonly','unknown-style','different-process','missing-parent','focus-changed','disabled','hidden']){
 test(`refuses multiline input for ${scenario}`,()=>{
  const scope=probe();
  for(const value of [scope.sample,scope.recheck]){
   if(scenario==='browser')value.role='browser';
   if(scenario==='dialog')value.foreground={...value.root,windowId:12};
   if(scenario==='single-line')value.focusWindow.editMultiline=false;
   if(scenario==='readonly')value.focusWindow.editReadOnly=true;
   if(scenario==='unknown-style')delete value.focusWindow.editStyleKnown;
   if(scenario==='different-process')value.focusWindow.pid=99;
   if(scenario==='missing-parent')value.focusParents=[value.focusWindow];
   if(scenario==='disabled')value.focusWindow.enabled=false;
   if(scenario==='hidden')value.focusWindow.visible=false;
  }
  if(scenario==='focus-changed'){scope.recheck.focusWindowId=15;scope.recheck.focusWindow.windowId=15;}
  assert.equal(assessMultilineEditor(scope).ok,false);
 });
}
test('recognizes all supported line boundaries without treating ordinary text as multiline',()=>{
 for(const separator of ['\n','\r','\u0085','\u2028','\u2029'])assert.equal(isMultilineAction({kind:'type',text:`a${separator}b`}),true);
 assert.equal(isMultilineAction({kind:'type',text:'ordinary paragraph'}),false);
 assert.equal(isMultilineAction({kind:'keypress',keys:['Enter']}),false);
});
