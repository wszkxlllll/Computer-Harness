// Foreground-caret Enter input is authorized only in the Run's native document
// editor, never a browser, filename/search field, dialog or merely same-PID app.
export function assessMultilineEditor(scope){
 const sample=scope?.sample,recheck=scope?.recheck;
 const valid=value=>{
  if(value?.role!=='editor'||value.rootIdentityValid!==true||value.guiInfoValid!==true)return false;
  const root=value.root,foreground=value.foreground,focus=value.focusWindow;
  if(!root?.valid||!foreground?.valid||!focus?.valid||root.windowId!==foreground.windowId||
     root.pid!==foreground.pid||root.processStartTicks!==foreground.processStartTicks||
     value.foregroundWindowId!==root.windowId||value.activeWindowId!==root.windowId||value.focusWindowId!==focus.windowId||
     focus.pid!==root.pid||focus.processStartTicks!==root.processStartTicks||focus.windowClass!=='Edit'||
     focus.editStyleKnown!==true||focus.editMultiline!==true||focus.editReadOnly!==false||
     !focus.visible||!focus.enabled||focus.minimized)return false;
  const parents=value.focusParents;
  return Array.isArray(parents)&&parents[0]?.windowId===focus.windowId&&parents.some(parent=>
   parent.windowId===root.windowId&&parent.pid===root.pid&&parent.processStartTicks===root.processStartTicks);
 };
 return valid(sample)&&valid(recheck)&&sample.focusWindowId===recheck.focusWindowId
  ? {ok:true}
  : {ok:false,reason:'Multiline input requires the current Run-owned root editor and a proven focused writable ES_MULTILINE Edit; no input authorized'};
}
export const isMultilineAction=action=>action?.kind==='type'&&/[\r\n\u0085\u2028\u2029]/u.test(action.text);
