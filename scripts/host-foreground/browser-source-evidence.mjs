// Run-local source attestation only. Never discovers CDP endpoints or grants DOM geometry.
import {officialUrlPredicate} from './host-action-policy.mjs';

const bounded=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/u.test(value);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const sameWindow=(left,right)=>left?.pid===right?.pid&&left?.windowId===right?.windowId;
const samePage=(left,right)=>left?.pageUrl===right?.pageUrl&&left?.tabId===right?.tabId&&left?.generation===right?.generation;
const sameBounds=(left,right)=>left&&right&&['left','top','right','bottom'].every(key=>Number.isFinite(left[key])&&left[key]===right[key]);
const copyTarget=target=>Object.freeze({...target,windowTarget:Object.freeze({...target.windowTarget})});
const sameHost=(left,right)=>left?.kind===right?.kind&&left?.browser===right?.browser&&left?.profileId===right?.profileId&&left?.delivery===right?.delivery&&sameWindow(left?.windowTarget,right?.windowTarget);
const denied=reasonCode=>Object.freeze({allowed:false,reasonCode});

/**
 * Only ManagedBrowserHost.collect is accepted as the page reader. The factory
 * binds it directly to the dedicated Host, not an arbitrary model/browser URL.
 * A new observation is bracketed by two reads and exact foreground snapshots.
 * access() cannot collect or enrich an old observation. preDispatch() only
 * compares existing evidence; it never repairs a missing basedOn.
 */
export function createBrowserSourceEvidence({sourceUrls=[],foregroundScope,onEvidence=()=>{},now=Date.now,maxAgeMs=120000}={}){
 const records=new Map(),latest=new Map(),attempted=new Set(),seen=new Set(),tokens=new WeakSet();
 const officialUrl=officialUrlPredicate(sourceUrls);
 let hostTarget,collect,epoch=0,collecting=false;
 const emit=value=>onEvidence({kind:'browser.source',...value});
 const fail=(reasonCode,ids=[])=>{
  for(const id of ids){const record=records.get(String(id));if(record)records.set(String(id),Object.freeze({...record,invalidated:true,reasonCode}));}
  emit({status:'rejected',reasonCode,observationIds:ids.map(String)});return denied(reasonCode);
 };
 const exactScope=scope=>hostTarget!==undefined&&scope?.role==='browser'&&
  (scope.foregroundWindowId===hostTarget.windowTarget.windowId||
   scope.sample?.browserFindAdmission?.kind==='completed-ctrl-f-owned-uia-edit-v1'&&
   scope.sample.browserFindAdmission.rootWindowId===hostTarget.windowTarget.windowId&&
   scope.sample.browserFindAdmission.popupWindowId===scope.foregroundWindowId&&
   scope.sample.root?.pid===hostTarget.windowTarget.pid)&&
  (scope.foregroundPid===undefined||scope.foregroundPid===hostTarget.windowTarget.pid)&&
  scope.bounds&&['left','top','right','bottom'].every(key=>Number.isFinite(scope.bounds[key]))&&
  scope.bounds.right>scope.bounds.left&&scope.bounds.bottom>scope.bounds.top;
 const scopeCopy=scope=>Object.freeze({role:scope.role,foregroundWindowId:scope.foregroundWindowId,
  ...(scope.foregroundPid===undefined?{}:{foregroundPid:scope.foregroundPid}),
  ...(scope.sample?.browserFindAdmission?{sample:{browserFindAdmission:structuredClone(scope.sample.browserFindAdmission),root:{pid:scope.sample.root.pid}}}:{}),
  bounds:Object.freeze({...scope.bounds})});
 const scopeStable=(before,after)=>exactScope(before)&&exactScope(after)&&before.foregroundWindowId===after.foregroundWindowId&&sameBounds(before.bounds,after.bounds);
 const fresh=record=>record&&!record.invalidated&&record.epoch===epoch&&sameHost(record.browserTarget,hostTarget)&&
  now()>=record.collectionEndedAtMs&&now()-record.collectionEndedAtMs<=maxAgeMs;
 const recordFor=({observationId,computerSessionId,pageUrl})=>{
  const record=records.get(String(observationId));
  return fresh(record)&&record.computerSessionId===String(computerSessionId)&&
   (pageUrl===undefined||pageUrl===record.pageUrl)?record:undefined;
 };
 async function readPage(request,scope,signal){
  signal.throwIfAborted();
  if(!collect||!hostTarget||typeof foregroundScope!=='function'||!exactScope(scope))throw new Error('host_browser_identity_missing');
  if(!request.viewport||request.viewport.coordinateSpace!=='physical'||![request.viewport.width,request.viewport.height].every(value=>Number.isFinite(value)&&value>0))throw new Error('host_browser_viewport_missing');
  if(collecting)throw new Error('host_browser_collection_overlap');
  const readEpoch=epoch,collectionStartedAtMs=now();
  let result;
  collecting=true;
  try{result=await collect({...request,browserTarget:hostTarget},signal);}finally{collecting=false;}
  const after=await foregroundScope(signal);
  signal.throwIfAborted();
  const collectionEndedAtMs=now();
  if(readEpoch!==epoch||collectionEndedAtMs<collectionStartedAtMs||!scopeStable(scope,after))throw new Error('host_browser_foreground_changed');
  if(!bounded(result?.tabId)||!bounded(result?.generation)||typeof result.pageUrl!=='string')throw new Error('host_browser_source_missing');
  // Product ManagedBrowserHost only attaches visibleText after checking BOTH
  // value.navigationKey===selected.navigationKey and value.pageUrl===CDP URL.
  // Its presence is a same-collection document-stability witness even when no
  // tables exist. Never consume/serialize its text. Absence fails closed.
  if(result.visibleText?.source!=='dom-table-v1'||result.visibleText.scope!=='current-viewport')throw new Error('host_browser_document_unconfirmed');
  if(!officialUrl(result.pageUrl))throw new Error('host_browser_source_denied');
  return Object.freeze({pageUrl:result.pageUrl,tabId:result.tabId,generation:result.generation,
   browserTarget:copyTarget({...hostTarget,tabId:result.tabId,generation:result.generation}),
   collectionStartedAtMs,collectionEndedAtMs,scope:scopeCopy(after),epoch:readEpoch});
 }
 function noteFailure(error,ids,signal){
  if(signal.aborted)signal.throwIfAborted();
  const known=new Set(['host_browser_identity_missing','host_browser_viewport_missing','host_browser_collection_overlap','host_browser_foreground_changed','host_browser_source_missing','host_browser_document_unconfirmed','host_browser_source_denied']);
  return fail(known.has(error?.message)?error.message:'host_browser_collection_unavailable',ids);
 }
 return Object.freeze({
  bindHost(target,reader){
   if(!Number.isSafeInteger(target?.windowTarget?.pid)||target.windowTarget.pid<=0||!Number.isSafeInteger(target?.windowTarget?.windowId)||target.windowTarget.windowId<=0||
    target.kind!=='managed-chromium'||target.delivery!=='loopback-cdp'||!bounded(target.profileId)||!bounded(target.tabId)||!bounded(target.generation)||typeof reader!=='function')throw new Error('Exact dedicated managed browser identity unavailable');
   epoch++;records.clear();latest.clear();attempted.clear();seen.clear();hostTarget=copyTarget(target);collect=reader;
  },
  close(){epoch++;hostTarget=undefined;collect=undefined;records.clear();latest.clear();attempted.clear();seen.clear();},
  access:recordFor,
  async observeBefore({session,observationId,viewport,scope},signal){
   const id=String(observationId),sessionId=String(session.id);
   // Never replace an earlier record for the same observation identity.
   if(seen.has(id))return fail('host_browser_observation_reused',[id]);
   seen.add(id);
   latest.set(sessionId,id);
   if(!exactScope(scope))return Object.freeze({allowed:false,reasonCode:'host_browser_not_foreground'});
   try{
    const before=await readPage({observationId,computerSessionId:session.id,viewport},scope,signal);
    const token=Object.freeze({allowed:true,observationId:id,computerSessionId:sessionId,viewport:Object.freeze({...viewport}),before});
    tokens.add(token);return token;
   }catch(error){return noteFailure(error,[id],signal);}
  },
  async observeAfter({token,capture,scope},signal){
   if(!token||!tokens.has(token))return capture;
   tokens.delete(token);
   const id=token.observationId;
   try{
    if(latest.get(token.computerSessionId)!==id||token.before.epoch!==epoch)throw new Error('host_browser_observation_changed');
    const after=await readPage({observationId:id,computerSessionId:token.computerSessionId,viewport:capture.viewport},scope,signal);
    const capturedAtMs=validTime(capture.capturedAt)?Date.parse(capture.capturedAt):NaN;
    if(!samePage(token.before,after)||!scopeStable(token.before.scope,after.scope)||
     token.viewport.width!==capture.viewport.width||token.viewport.height!==capture.viewport.height||
     !Number.isFinite(capturedAtMs)||capturedAtMs<token.before.collectionEndedAtMs||capturedAtMs>after.collectionStartedAtMs)throw new Error('host_browser_observation_changed');
    const catalog=capture.grounding;
    if(catalog&&(String(catalog.observationId)!==id||String(catalog.computerSessionId)!==token.computerSessionId||
     catalog.pageUrl!==undefined&&catalog.pageUrl!==after.pageUrl))throw new Error('host_browser_source_conflict');
    const record=Object.freeze({...after,observationId:id,computerSessionId:token.computerSessionId,
     capturedAt:capture.capturedAt,collectionStartedAtMs:token.before.collectionStartedAtMs,
     viewport:Object.freeze({...capture.viewport}),invalidated:false});
    records.set(id,record);
    emit({status:'bound',evidence:record});
    // Fresh result projection only. Does not mutate capture, a prior catalog,
    // the adapter's private refs or trajectory. No DOM candidates are added.
    return {...capture,grounding:{...(catalog??{version:'grounding-catalog-v2',source:'dom',observationId:id,
     computerSessionId:token.computerSessionId,completeness:'partial',degraded:true,maxElements:256,elements:[]}),
     ...(capture.surfaceRef===undefined?{}:{surfaceRef:capture.surfaceRef}),pageUrl:record.pageUrl}};
   }catch(error){
    if(signal.aborted)signal.throwIfAborted();
    fail(['host_browser_source_conflict','host_browser_observation_changed'].includes(error?.message)?error.message:
     ['host_browser_source_denied','host_browser_source_missing','host_browser_document_unconfirmed','host_browser_foreground_changed'].includes(error?.message)?error.message:'host_browser_collection_unavailable',[id]);
    return capture;
   }
  },
  async preDispatch({session,action,scope,options},signal){
   if(['wait','switch_window'].includes(action.kind))return Object.freeze({allowed:true,notBrowserInput:true});
   const attemptKey=`${String(session.id)}:${String(action.actionId)}`;
   if(attempted.has(attemptKey))return fail('host_browser_action_replay_denied',[action.basedOn]);
   attempted.add(attemptKey);
   const executionId=String(options?.executionObservationId??action.basedOn);
   const ids=[String(action.basedOn),executionId];
   const decision=recordFor({observationId:action.basedOn,computerSessionId:session.id});
   const execution=recordFor({observationId:executionId,computerSessionId:session.id});
   if(!decision||!execution||latest.get(String(session.id))!==executionId)return fail('host_browser_observation_unconfirmed',ids);
   if(!samePage(decision,execution)||!scopeStable(decision.scope,execution.scope)||!scopeStable(execution.scope,scope))return fail('host_browser_identity_changed',ids);
   try{
    const current=await readPage({observationId:executionId,computerSessionId:session.id,viewport:execution.viewport},scope,signal);
    if(!samePage(decision,current)||!sameHost(decision.browserTarget,current.browserTarget)||!scopeStable(execution.scope,current.scope))return fail('host_browser_identity_changed',ids);
    if(!fresh(decision)||!fresh(execution))return fail('host_browser_observation_expired',ids);
    emit({status:'dispatch-validated',actionId:String(action.actionId),observationId:decision.observationId,
     executionObservationId:executionId,current:{pageUrl:current.pageUrl,tabId:current.tabId,generation:current.generation,
      collectionStartedAtMs:current.collectionStartedAtMs,collectionEndedAtMs:current.collectionEndedAtMs}});
    return Object.freeze({allowed:true,evidence:decision,executionEvidence:execution});
   }catch(error){return noteFailure(error,ids,signal);}
  },
 });
}
