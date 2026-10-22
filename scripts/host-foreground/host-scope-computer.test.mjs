import assert from 'node:assert/strict';
import {test} from 'node:test';
import {scopeComputerModule} from './host-scope-computer.mjs';
import {createBrowserSourceEvidence} from './browser-source-evidence.mjs';
const viewport={width:1280,height:720,coordinateSpace:'physical'};
function fixture(){
 const native={valid:true,pid:10,windowId:100,threadId:20,dpi:96,processStartTicks:'1000',parentWindowId:0,ownerWindowId:0,
  windowClass:'Browser',visible:true,enabled:true,minimized:false,cloakedKnown:true,cloaked:false,boundsValid:true,bounds:{left:0,top:0,right:1000,bottom:600}};
 const sample={role:'browser',coordinateSpace:'physical-screen-pixels',physicalCoordinates:true,rootIdentityValid:true,guiInfoValid:true,controlsComplete:true,
  foregroundWindowId:100,focusWindowId:100,captureWindowId:0,activeWindowId:100,root:native,foreground:native,ownerChain:[native],focusWindow:native,focusParents:[native],
  regions:[{kind:'foreground',window:native,parentChain:[native],ownerChain:[native]}]};
 let outside=false,generation='doc-1',sent=0,receiptStatus='completed';
 const foregroundScope=async()=>{const time=Date.now();const value=structuredClone(sample);if(outside)value.role='outside';
  return {schema:'host-point-scope/v1',capturedAt:time,completedAt:time,sample:value,recheck:structuredClone(value),role:value.role,foregroundPid:10,foregroundWindowId:100,bounds:native.bounds};};
 const target={kind:'managed-chromium',browser:'edge',profileId:'owned',delivery:'loopback-cdp',windowTarget:{pid:10,windowId:100},tabId:'tab-1',generation:'doc-1'};
 const sourceEvidence=createBrowserSourceEvidence({sourceUrls:['https://official.test/guide'],foregroundScope});
 sourceEvidence.bindHost(target,async()=>({candidates:[],pageUrl:'https://official.test/guide',tabId:'tab-1',generation,
  visibleText:{source:'dom-table-v1',scope:'current-viewport',regions:[]}}));
 class ExternalComputer{
  async observe(){return {capturedAt:new Date().toISOString(),viewport,surfaceRef:{surfaceId:'desktop',generation:1,kind:'desktop'},screenshot:{data:new Uint8Array(),mediaType:'image/png'}};}
  async execute(_session,action){sent++;return {actionId:action.actionId,status:receiptStatus};}
 }
 const scoped=scopeComputerModule({CuaDriverComputer:ExternalComputer},{foregroundScope,sourceEvidence});
 const computer=new scoped.module.CuaDriverComputer(),session={id:'session',viewport},controller=new AbortController();
 const action=(id='action-1',basedOn='obs-1')=>({kind:'type',text:'synthetic',actionId:id,basedOn});
 const observe=id=>computer.observe(session,id,controller.signal);
 const inspect=async value=>scoped.inspect({session,action:value,scope:await foregroundScope()},controller.signal);
 const execute=(value,options)=>computer.execute(session,value,controller.signal,options);
 return {action,observe,inspect,execute,controller,get sent(){return sent;},outside:()=>{outside=true;},navigate:()=>{generation='doc-2';},unknown:()=>{receiptStatus='partial';}};
}
test('policy inspection does not consume dispatch permission; completed input consumes execution observation',async()=>{
 const f=fixture();await f.observe('obs-1');assert.equal((await f.inspect(f.action())).ok,true);
 assert.equal((await f.execute(f.action())).status,'completed');assert.equal(f.sent,1);
 assert.equal((await f.execute(f.action('action-2'))).driverCode,'HOST_SCOPE_CHANGED');assert.equal(f.sent,1);
});
test('foreground replacement after policy inspection prevents any input',async()=>{
 const f=fixture();await f.observe('obs-1');assert.equal((await f.inspect(f.action())).ok,true);f.outside();
 assert.equal((await f.execute(f.action())).status,'refused');assert.equal(f.sent,0);
});
test('cancellation after policy inspection never starts the external input primitive',async()=>{
 const f=fixture();await f.observe('obs-1');assert.equal((await f.inspect(f.action())).ok,true);f.controller.abort();
 await assert.rejects(f.execute(f.action()),{name:'AbortError'});assert.equal(f.sent,0);
});
test('same-URL document replacement after observation prevents dispatch',async()=>{
 const f=fixture();await f.observe('obs-1');f.navigate();assert.equal((await f.execute(f.action())).status,'refused');assert.equal(f.sent,0);
});
test('unknown input outcome cannot reuse an observation or replay its action ID after re-observing',async()=>{
 const f=fixture();await f.observe('obs-1');f.unknown();assert.equal((await f.execute(f.action())).status,'partial');
 assert.equal((await f.execute(f.action())).status,'refused');await f.observe('obs-2');
 assert.equal((await f.execute(f.action('action-1','obs-2'))).status,'refused');assert.equal(f.sent,1);
});
test('Runtime batch continuation needs a fresh agreeing execution observation, not a new original decision',async()=>{
 const f=fixture();await f.observe('obs-1');assert.equal((await f.execute(f.action())).status,'completed');
 await f.observe('obs-2');assert.equal((await f.execute(f.action('action-2'),{executionObservationId:'obs-2'})).status,'completed');assert.equal(f.sent,2);
});
