import {win32} from 'node:path';
import {assessMultilineEditor,isMultilineAction} from './focused-editor-evidence.mjs';
const protectedEffects=new Set(['destructive','financial','external_commitment','sensitive_disclosure','security_change']);
const forbidden=/(?:立即(?:支付|付款|缴费|预约|挂号|绑定|办理)|确认(?:支付|付款|缴费|预约|挂号|提交|绑定)|提交(?:预约|订单|工单)|(?:^|\s)(?:log\s*in|sign\s*in|登录|登入|注册|实名|验证码|账户|账号|在线客服|立即绑定|发送验证码|上传文件|submit|send|publish|pay|purchase|delete|提交|发送|发布|支付|付款|缴费|购买|删除)(?:$|\s))/iu;
export function officialUrlPredicate(sourceUrls){
 const hosts=new Set(sourceUrls.map(value=>new URL(value).hostname));
 return value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&hosts.has(url.hostname)&&!url.username&&!url.password&&!/(?:^|[/?#&=_-])(?:login|signin|register|account|passport|oauth)(?:$|[/?#&=_-])/iu.test(url.pathname+url.search+url.hash);}catch{return false;}};
}
export function createTaskActionPolicy({risk,riskTimeoutMs,sourceUrls,outputFile,foregroundScope,inspectScope}){
 const guard=new risk.LayeredRiskGuard({maxModelRequests:0,timeoutMs:riskTimeoutMs});
 const officialUrl=officialUrlPredicate(sourceUrls);
 return {async evaluate(context,signal){
  const decision=await guard.evaluate(context,signal);if(decision.decision==='deny')return decision;
  const deny=(reasonCode,reason)=>({...decision,decision:'deny',reasonCode,reason,policyVersion:`${decision.policyVersion}+host-opt-public-and-owned-file-v1`});
  const candidate=context.candidate,catalog=candidate.decisionObservation.grounding;
  if(typeof catalog?.pageUrl==='string'&&catalog.pageUrl.length>0&&!officialUrl(catalog.pageUrl))return deny('host_official_scope_denied','Observed page is outside the frozen official source hosts');
  const scope=await foregroundScope(signal),local=scope.role==='editor';
  // Native desktop capture remains full; input is still limited to the two Run-owned apps.
  // switch_window is separately exact-allowlisted by the production Computer and never rebinds.
  const hasInput=candidate.actions.some(action=>!['switch_window','wait'].includes(action.kind));
  if(hasInput&&!['editor','browser'].includes(scope.role))return deny('host_foreground_scope_denied','Foreground app is not this Run editor/browser; no terminal or personal-app input');
  if(hasInput&&scope.role==='browser'&&!officialUrl(catalog?.pageUrl))return deny('host_browser_scope_unconfirmed','Public official page identity must be present before browser input');
  if(candidate.calls.some(call=>call.declaredEffect?.effects.some(effect=>protectedEffects.has(effect))))return deny('host_commitment_effect_denied','Real submissions, payments, disclosure, destructive changes and external commitments are forbidden');
  const text=(candidate.groundingEvidence??[]).map(item=>`${item.name??''} ${item.description??''}`).join('\n');
  if(!local&&forbidden.test(text))return deny('host_frozen_scope_denied','Website account, submission, booking, payment or external-send control is forbidden');
  // Saving/opening this run document is local_edit, not a website submission. Never approve overwrite confirmation.
  if(local&&/(?:确认替换|替换现有|已存在.*(?:替换|覆盖)|confirm save as|already exists|replace existing|删除|delete)/iu.test(text))return deny('host_overwrite_denied','Only the new run document is authorized; no replacement or deletion');
  for(const action of candidate.actions){
   if(isMultilineAction(action)){
    const multiline=assessMultilineEditor(scope);
    if(!multiline.ok)return deny('host_multiline_target_unconfirmed',multiline.reason);
   }
   if(!['switch_window','wait'].includes(action.kind)){
    if(typeof inspectScope!=='function')return deny('host_scope_binding_missing','Observation-bound scope verifier unavailable; no input authorized');
    const checked=await inspectScope({session:candidate.session,action,scope},signal);
    if(!checked.ok)return deny('host_desktop_scope_unconfirmed',checked.reason);
   }
   if(action.kind==='keypress'){
    const keys=action.keys.map(key=>key.toLowerCase());
    if(keys.some(key=>['win','windows','meta','super','cmd','command'].includes(key))||(keys.includes('alt')&&keys.some(key=>['tab','esc','escape','space'].includes(key)))||(keys.includes('ctrl')&&keys.includes('shift')&&keys.includes('esc')))return deny('host_global_shortcut_denied','Global shell/task switching shortcuts are outside the owned-app scope; use scoped switch_window');
   }
   const element=catalog?.elements?.find(item=>item.elementRef===action.groundingRef);
   if(!local&&element?.href&&element.href!=='#'&&!element.href.startsWith('javascript:')){
    let destination;try{destination=new URL(element.href,catalog?.pageUrl||sourceUrls[0]).href;}catch{return deny('host_destination_scope_denied','Unresolvable destination');}
    if(!officialUrl(destination))return deny('host_destination_scope_denied','Destination is outside the official source hosts');
   }
   if(action.kind==='type'){
    if(!local&&(action.text.match(/https?:\/\/[^\s]+/gu)??[]).some(url=>!officialUrl(url)))return deny('host_typed_destination_denied','Typed URL is outside official source hosts');
    // A document body may quote URLs and safety words. File dialogs are authorized
    // only for this exact new path; direct absolute destinations cannot escape via another extension.
    if(local){
     const typed=action.text.trim(),normalize=value=>value.replaceAll('/','\\').replace(/\\$/u,'').toLowerCase();
     const approved=new Set([normalize(outputFile),normalize(win32.dirname(outputFile))]);
     if(/^(?:[A-Za-z]:[\\/]|\\\\|file:)/iu.test(typed)&&!approved.has(normalize(typed)))return deny('host_file_scope_denied','Only this Run outputFile or its new directory may be opened');
     if(/(?:文件名|file\s*name)/iu.test(element?.name??'')&&normalize(typed)!==normalize(outputFile))return deny('host_file_scope_denied','File-name controls require the exact authorized outputFile');
     const paths=action.text.match(/(?:[A-Za-z]:\\|\\\\)[^\r\n"<>|]*?\.txt\b/gu)??[];
     if(paths.some(path=>normalize(path)!==normalize(outputFile)))return deny('host_file_scope_denied','Only this Run outputFile may be saved or opened');
    }
   }
  }
  if(decision.decision==='require_approval'){
   const passive=candidate.actions.every(action=>action.kind==='wait'||action.kind==='switch_window'||(action.kind==='scroll'&&['editor','browser'].includes(scope.role)));
   const authorizedEffects=candidate.calls.every(call=>call.declaredEffect&&call.declaredEffect.effects.every(effect=>['observe','navigate','local_edit'].includes(effect)));
   if(!passive&&!authorizedEffects)return deny('host_auto_approval_scope_denied','Only public browsing and local new-document editing can be automatically approved');
  }
  return decision;
 }};
}
