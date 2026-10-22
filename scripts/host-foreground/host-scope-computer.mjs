import {capturePointScopeBinding,assessPointScope} from './point-scope.mjs';
import {actionSamplePoints,requestSamplePoints,guardNativeDriver} from './driver-point-contract.mjs';
import {assessMultilineEditor,isMultilineAction} from './focused-editor-evidence.mjs';

// Host-only Windows specialization. No product contract or portable Runtime change.
// Scope sampling and CUA dispatch are separate calls, not an atomic OS input gate.
export function scopeComputerModule(module,{foregroundScope,sourceEvidence,onEvidence=()=>{},maxAgeMs=120000,driverContract,connectDriver,foregroundVisibleCapture,isLocalSocket}){
 const bindings=new Map();
 const key=(session,id)=>`${session.id}:${id}`;
 const latest=new Map();
 const captures=new Map();
 const attempted=new Set();
 const failure=(reason)=>({ok:false,reason});
 const inspect=async({session,action,options,scope,dispatch=false,finalPoints},signal)=>{
  const id=options?.executionObservationId??action.basedOn;
  if(finalPoints===undefined&&latest.get(String(session.id))!==String(id))return failure('host_observation_not_current');
  const original=bindings.get(key(session,action.basedOn)),execution=bindings.get(key(session,id));
  if(!original||!execution)return failure('host_scope_binding_missing');
  if(isMultilineAction(action)){
   const multiline=assessMultilineEditor(scope);
   if(!multiline.ok)return multiline;
  }
  let points;
  try{points=finalPoints??actionSamplePoints(action,captures.get(key(session,action.basedOn)),driverContract);}
  catch(error){return failure(error.message);}
  if(points.length&&typeof connectDriver!=='function')return failure('host_final_driver_gate_missing');
  for(const binding of original===execution?[original]:[original,execution]){
   const stable=assessPointScope({binding,currentScope:scope,observationId:binding.observationId,points:[],maxAgeMs});
   if(!stable.ok)return stable;
   for(const point of points){
    const current=await foregroundScope(signal,point);
    const result=assessPointScope({binding,currentScope:current,observationId:binding.observationId,points:[point],maxAgeMs});
    onEvidence({kind:'host.point.checked',stage:finalPoints===undefined?'action-preflight':'native-dispatch',observationId:id,
     actionId:action.actionId,driverContract,point,scope:current,result});
    if(!result.ok)return result;
   }
  }
  if(scope.role==='browser'){
   if(dispatch){
    const result=await sourceEvidence.preDispatch({session,action,options,scope},signal);
    if(!result.allowed)return failure(result.reasonCode);
   }else if(!sourceEvidence.access({observationId:action.basedOn,computerSessionId:session.id})||
    !sourceEvidence.access({observationId:id,computerSessionId:session.id}))return failure('host_browser_observation_unconfirmed');
  }
  return {ok:true};
 };
 class ScopedComputer extends module.CuaDriverComputer {
  constructor(options={}){
   let instance;
   // Supplying the Driver seam must not disable the product's existing local
   // Windows foreground capture fallback used by desktop grounding.
   const captureOptions=options.driverFactory===undefined&&options.windowDeliveryMode==='foreground'&&isLocalSocket?.(options.socketPath)
    ?{windowCaptureRetry:{...options.windowCaptureRetry,foregroundVisibleCapture:options.windowCaptureRetry?.foregroundVisibleCapture??foregroundVisibleCapture}}:{};
   super(typeof connectDriver==='function'?{...options,...captureOptions,driverFactory:socket=>guardNativeDriver(
    options.driverFactory?options.driverFactory(socket):connectDriver(socket),
    (name,args,signal)=>instance.checkNativeRequest(name,args,signal))}:options);
   instance=this;
  }
  async checkNativeRequest(name,args,signal){
   const context=this.dispatchContext;
   if(!context||context.nativeAttempted)return failure('host_native_dispatch_grant_missing');
   context.nativeAttempted=true;
   let points;
   if(isMultilineAction(context.action)){
    if(name!=='type_text'||args.target?.kind!=='desktop'||args.target.display_id!=='primary'||args.delivery_mode!=='foreground')
     return failure('host_multiline_dispatch_path_unproven');
    points=[];
   }else{
    try{points=requestSamplePoints(name,args,driverContract);}catch(error){return failure(error.message);}
    const expected=context.action.kind==='drag'?'drag':context.action.kind==='scroll'?'scroll':'click';
    if(name!==expected)return failure('host_native_dispatch_path_changed');
   }
   const scope=await foregroundScope(signal);
   const result=await inspect({...context,scope,dispatch:false,finalPoints:points},signal);
   onEvidence({kind:'host.native.dispatch.checked',actionId:context.action.actionId,name,driverContract,points,result});
   signal?.throwIfAborted();
   return result;
  }
  async observe(session,observationId,signal){
   const before=await foregroundScope(signal);
   const provisional=capturePointScopeBinding({scope:before,observationId});
   const token=await sourceEvidence.observeBefore({session,observationId,viewport:session.viewport,scope:before},signal);
   const capture=await super.observe(session,observationId,signal);
   const after=await foregroundScope(signal);
   const projected=await sourceEvidence.observeAfter({token,capture,scope:after},signal);
   // Page collection can itself span a focus change. Bind only after its final sample.
   const finalScope=await foregroundScope(signal);
   const stable=provisional.ok?assessPointScope({binding:provisional.binding,currentScope:finalScope,observationId,points:[],maxAgeMs}):provisional;
   const recorded=stable.ok?capturePointScopeBinding({scope:finalScope,observationId}):stable;
   // Retain bounded decision provenance for Runtime executionObservationId.
   while(bindings.size>=32){const oldest=bindings.keys().next().value;bindings.delete(oldest);captures.delete(oldest);}
   latest.set(String(session.id),String(observationId));
   if(recorded.ok)bindings.set(key(session,observationId),recorded.binding);
   captures.set(key(session,observationId),{surfaceRef:capture.surfaceRef,viewport:capture.viewport});
   onEvidence({kind:'host.observation.scope',observationId,computerSessionId:session.id,scope:finalScope,result:recorded.ok?{ok:true}:recorded});
   return projected;
  }
  async execute(session,action,signal,options){
   if(action.kind==='wait')return super.execute(session,action,signal,options);
   if(action.kind==='switch_window'){
    latest.delete(String(session.id));bindings.clear();captures.clear();
    return super.execute(session,action,signal,options);
   }
   if(attempted.has(key(session,action.actionId)))return {
    actionId:action.actionId,status:'refused',driverCode:'HOST_SCOPE_CHANGED',
    message:'This action ID already entered Computer dispatch; no input was sent'};
   const scope=await foregroundScope(signal);
   const result=await inspect({session,action,options,scope,dispatch:true},signal);
   if(!result.ok){
    latest.delete(String(session.id));bindings.clear();captures.clear();
    return {actionId:action.actionId,status:'refused',driverCode:'HOST_SCOPE_CHANGED',message:`${result.reason}; fresh observation required; no input was sent`};
   }
   // Consume the execution grant before dispatch. A subsequent batch action
   // needs Runtime's fresh executionObservationId; unknown effects cannot
   // reuse the same grant. Keep decision provenance only for that fresh check.
   latest.delete(String(session.id));
   attempted.add(key(session,action.actionId));
   signal.throwIfAborted();
   if(this.dispatchContext)throw Error('Host refuses concurrent Computer input');
   this.dispatchContext={session,action,options,nativeAttempted:false};
   try{
    const receipt=await super.execute(session,action,signal,options);
    foregroundScope.noteCompletedAction?.({action,receipt,scope});
    return receipt;
   }finally{this.dispatchContext=undefined;}
  }
 }
 return {module:{...module,CuaDriverComputer:ScopedComputer},inspect};
}
