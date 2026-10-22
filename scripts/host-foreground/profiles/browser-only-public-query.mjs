// Full desktop observations, but only current official-page input in the exact owned browser.
const forbidden=/(?:立即(?:支付|付款|缴费|预约|挂号|绑定)|确认(?:支付|付款|缴费|预约|挂号|提交|绑定)|提交(?:预约|订单|工单)|(?:^|\s)(?:log\s*in|sign\s*in|登录|登入|注册|实名|验证码|账户|账号|预约|挂号|预约挂号|在线客服|立即绑定|发送验证码|上传文件|submit|send|publish|pay|purchase|delete|提交|发送|发布|支付|付款|缴费|购买|删除)(?:$|\s))/iu;
const protectedEffects=new Set(['destructive','financial','external_commitment','sensitive_disclosure','security_change']);
export function officialUrlPredicate(initialUrl){
 const officialHost=new URL(initialUrl).hostname;
 return value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&url.hostname===officialHost&&!url.username&&!url.password&&!/(?:^|[/?#&=_-])(?:login|signin|register|account|passport|oauth)(?:$|[/?#&=_-])/iu.test(url.pathname+url.search+url.hash);}catch{return false;}};
}
export function createTaskActionPolicy({risk,riskTimeoutMs,initialUrl,foregroundScope,inspectScope}){
 const guard=new risk.LayeredRiskGuard({maxModelRequests:0,timeoutMs:riskTimeoutMs});
 const officialUrl=officialUrlPredicate(initialUrl);
 return {async evaluate(context,signal){
  const decision=await guard.evaluate(context,signal);
  if(decision.decision==='deny')return decision;
  const deny=(reasonCode,reason)=>({...decision,decision:'deny',reasonCode,reason,policyVersion:`${decision.policyVersion}+official-public-task-scope`});
  const catalog=context.candidate.decisionObservation.grounding;
  const hasInput=context.candidate.actions.some(action=>action.kind!=='wait');
  const scope=hasInput?await foregroundScope(signal):null;
  if(hasInput&&scope.role!=='browser')return deny('host_foreground_scope_denied','Input requires this Run exact foreground browser, not the shell or another app');
  if(hasInput&&!officialUrl(catalog?.pageUrl))return deny('host_browser_scope_unconfirmed','Current official page identity is required before desktop browser input');
  if(typeof catalog?.pageUrl==='string'&&catalog.pageUrl.length>0&&!officialUrl(catalog.pageUrl))return deny('host_official_scope_denied','Observed page is outside this task official website');
  if(context.candidate.calls.some(call=>call.declaredEffect?.effects.some(effect=>protectedEffects.has(effect))))return deny('host_commitment_effect_denied','Only public observation, navigation, and local query editing are authorized');
  const text=(context.candidate.groundingEvidence??[]).map(item=>`${item.name??''} ${item.description??''}`).join('\n');
  if(forbidden.test(text))return deny('host_frozen_scope_denied','Grounded account, booking, submission, payment, or external commitment target is outside the authorized public query');
  for(const action of context.candidate.actions){
   if(action.kind==='switch_window')return deny('host_window_switch_denied','These public-query tasks authorize input only in their dedicated browser');
   if(action.kind!=='wait'){
    const checked=await inspectScope({session:context.candidate.session,action,scope},signal);
    if(!checked.ok)return deny('host_desktop_scope_unconfirmed',checked.reason);
   }
   if(action.kind==='keypress'){
    const keys=action.keys.map(key=>key.toLowerCase());
    if(keys.some(key=>['win','windows','meta','super','cmd','command'].includes(key))||(keys.includes('alt')&&keys.some(key=>['tab','esc','escape','space'].includes(key)))||(keys.includes('ctrl')&&keys.includes('shift')&&keys.includes('esc')))return deny('host_global_shortcut_denied','Global shell and task switching shortcuts are outside this public query');
   }
   const element=catalog?.elements?.find(item=>item.elementRef===action.groundingRef);
   if(element?.href&&element.href!=='#'&&!element.href.startsWith('javascript:')){
    let destination;try{destination=new URL(element.href,catalog?.pageUrl||initialUrl).href;}catch{return deny('host_destination_scope_denied','Observed destination cannot be resolved as an official public URL');}
    if(!officialUrl(destination))return deny('host_destination_scope_denied','Observed destination is outside authorized public pages');
   }
   if(action.kind==='type'){
    const urls=action.text.match(/https?:\/\/[^\s]+/gu)??[];
    if(urls.some(url=>!officialUrl(url)))return deny('host_typed_destination_denied','Typed URL is outside the official public query');
   }
  }
  // Only passive observation or declared public navigation/local query edits
  // may reach the runner's automatic approval handler; unknown effects are denied.
  if(decision.decision==='require_approval'){
   const passive=context.candidate.actions.every(action=>action.kind==='scroll'||action.kind==='wait');
   const withinPublicQuery=context.candidate.calls.every(call=>call.declaredEffect&&call.declaredEffect.effects.every(effect=>['observe','navigate','local_edit'].includes(effect)));
   if(!passive&&!withinPublicQuery)return deny('host_auto_approval_scope_denied','Automatic approval does not authorize external commitments, account operations, or unknown effects');
  }
  return decision;
 }};
}
