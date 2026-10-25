import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const SOURCE_URL=new URL('./window-discovery.ts',import.meta.url);
const localRequire=createRequire(SOURCE_URL);
const ts=localRequire('typescript');
const js=ts.transpileModule(fs.readFileSync(SOURCE_URL,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(overrides={}){
 const calls=[];let loads=0,factories=0;
 const driver={async startSession(x){calls.push(['start',x.session]);},async callTool(){calls.push(['operation']);return {};},async endSession(x){calls.push(['end',x.session]);return {active:false};},async shutdown(){calls.push(['shutdown']);},uniffiDestroy(){calls.push(['destroy']);},...overrides};
 const sdk={StartSessionInput:{new:x=>x},EndSessionInput:{new:x=>x},CuaDriver:{connect(){factories++;calls.push(['connect']);return driver;}}};
 const state={loader:async()=>sdk};
 const module={exports:{}};
 const require=name=>{
  if(name.startsWith('node:'))return localRequire(name);
  if(name==='./cua-sdk-platform.js')return {loadCuaSdkModule:async()=>{loads++;calls.push(['load']);return state.loader(loads);}};
  if(name==='./window-contract.js')return {listWindowInventory:async(d,s,signal)=>{signal.throwIfAborted();await d.callTool('list_windows');return {windows:[],source:'cua_inventory',complete:false,completeAttestation:'missing'};},validateWindowTarget(){},captureWindowWithRetry(){throw Error('capture forbidden');},activateWindowTarget(){throw Error('activation forbidden');}};
  if(name==='./windows-visible-window-capture.js')return {captureVisibleWindowRegion(){throw Error('visible capture forbidden');}};
  throw Error('unapproved import');
 };
 vm.runInNewContext(js,{module,exports:module.exports,require,AbortSignal,DOMException,TypeError,process:{platform:'darwin'}},{filename:'frozen-window-discovery.js'});
 const discovery=new module.exports.CuaWindowDiscovery({socketPath:'PRIVATE_ENDPOINT',sessionLabel:'PRIVATE_SESSION'});
 return {discovery,driver,state,calls,sdk,loads:()=>loads,factories:()=>factories,run:()=>discovery.listInventory(new AbortController().signal)};
}
const caught=p=>p.then(()=>({resolved:true}),error=>({resolved:false,error}));
const pending=h=>h.discovery.pendingCleanup;
const plain=s=>JSON.parse(JSON.stringify(s));
test('getter frozen scalar copies do not call any operation and preserve old snapshot',async()=>{
 const h=harness(),idle=h.discovery.getLifecycleSnapshot();assert.equal(h.calls.length,0);
 await h.run();const done=h.discovery.getLifecycleSnapshot();assert.ok(Object.isFrozen(done));assert.notEqual(done,h.discovery.getLifecycleSnapshot());assert.equal(idle.phase,'idle');
 assert.ok(Object.values(done).every(x=>['string','number','boolean'].includes(typeof x)));assert.equal(JSON.stringify(done).includes('PRIVATE'),false);
 assert.deepEqual(h.calls.map(x=>x[0]),['load','connect','start','operation','load','end','shutdown','destroy']);assert.equal(done.outcome,'succeeded');assert.equal(done.cleanupAttempts,1);
});
for(const kind of ['load','connect','start','operation'])test(`${kind} original object failure and exact cleanup boundary`,async()=>{
 const e={tag:'Protocol',PRIVATE:'hidden'},h=harness();
 if(kind==='load')h.state.loader=async()=>{throw e};
 if(kind==='connect')h.sdk.CuaDriver.connect=()=>{throw e};
 if(kind==='start')h.driver.startSession=async()=>{h.calls.push(['start']);throw e};
 if(kind==='operation')h.driver.callTool=async()=>{h.calls.push(['operation']);throw e};
 const r=await caught(h.run());assert.equal(r.error,e);const snap=h.discovery.getLifecycleSnapshot();assert.equal(snap.primaryFailed,true);
 assert.equal(snap.cleanup,['load','connect'].includes(kind)?'not_started':'confirmed');assert.equal(snap.pendingCleanup,false);
 assert.equal(h.calls.filter(x=>x[0]==='end').length,['load','connect'].includes(kind)?0:1);assert.equal(JSON.stringify(snap).includes('PRIVATE'),false);
});
test('end active true is bounded to two attempts then shutdown once no destroy',async()=>{
 const h=harness();h.driver.endSession=async x=>{h.calls.push(['end',x.session]);return {active:true}};
 assert.equal((await caught(h.run())).resolved,false);const s=h.discovery.getLifecycleSnapshot();assert.equal(s.endSessionAttempts,2);assert.equal(s.pendingCleanup,true);
 assert.equal(pending(h).driver,h.driver);assert.equal(pending(h).session,'PRIVATE_SESSION');assert.equal(h.calls.filter(x=>x[0]==='shutdown').length,1);assert.equal(h.calls.filter(x=>x[0]==='destroy').length,0);
});
for(const stage of ['cleanup_load','active_getter','shutdown','destroy_getter'])test(`${stage} failure preserves exact owner without extra retry`,async()=>{
 const e={stage},h=harness();
 if(stage==='cleanup_load')h.state.loader=async n=>{if(n===2)throw e;return h.sdk;};
 if(stage==='active_getter')h.driver.endSession=async()=>Object.defineProperty({},'active',{get(){throw e}});
 if(stage==='shutdown')h.driver.shutdown=async()=>{h.calls.push(['shutdown']);throw e};
 if(stage==='destroy_getter')Object.defineProperty(h.driver,'uniffiDestroy',{get(){throw e}});
 const r=await caught(h.run());assert.equal(r.resolved,false);if(['cleanup_load','destroy_getter'].includes(stage))assert.equal(r.error,e);
 assert.equal(pending(h).driver,h.driver);assert.equal(pending(h).session,'PRIVATE_SESSION');assert.equal(h.discovery.getLifecycleSnapshot().cleanup,'unconfirmed');
 assert.equal(h.factories(),1);assert.ok(h.calls.filter(x=>x[0]==='end').length<=1);assert.equal(h.loads(),2);
});
test('hostile proxy and accessors are not invoked by diagnostic exception classifier',async()=>{
 for(const proxy of [false,true]){let taps=0;const target=Object.defineProperties({},{code:{get(){taps++;throw 0}},name:{get(){taps++;throw 0}},tag:{get(){taps++;throw 0}},message:{get(){taps++;throw 0}}});
  const e=proxy?new Proxy(target,{get(){taps++;throw 0},getOwnPropertyDescriptor(){taps++;throw 0},getPrototypeOf(){taps++;throw 0}}):target;
  const h=harness();h.sdk.CuaDriver.connect=()=>{throw e};assert.equal((await caught(h.run())).error,e);assert.equal(taps,0);assert.equal(h.discovery.getLifecycleSnapshot().primaryExceptionKind,'unknown');
 }
});
test('unexpected raw error conversion itself retains owner and exact secondary thrown identity',async()=>{
 const original={toString(){throw secondary}},secondary={PRIVATE:'secondary'},h=harness();h.driver.endSession=async()=>{throw original};
 assert.equal((await caught(h.run())).error,secondary);assert.equal(pending(h).driver,h.driver);assert.equal(pending(h).session,'PRIVATE_SESSION');assert.equal(h.discovery.getLifecycleSnapshot().cleanup,'unconfirmed');
});
test('pending retry fails before new connect preserving old owner',async()=>{
 const e={marker:'destroy'},h=harness();h.driver.uniffiDestroy=()=>{throw e};assert.equal((await caught(h.run())).error,e);const first=h.discovery.getLifecycleSnapshot();
 assert.equal((await caught(h.run())).error,e);assert.equal(h.factories(),1);assert.equal(pending(h).driver,h.driver);assert.equal(pending(h).session,'PRIVATE_SESSION');assert.equal(first.sequence,1);assert.equal(h.discovery.getLifecycleSnapshot().sequence,2);
});
test('successful old-owner retry followed by new load failure cannot claim new cleanup',async()=>{
 let destroys=0;const e={kind:'load'},h=harness();h.driver.uniffiDestroy=()=>{if(++destroys===1)throw 0};assert.equal((await caught(h.run())).error,0);
 h.state.loader=async n=>{if(n===4)throw e;return h.sdk;};assert.equal((await caught(h.run())).error,e);const s=h.discovery.getLifecycleSnapshot();assert.equal(s.cleanup,'not_started');assert.equal(s.pendingCleanup,false);assert.equal(h.factories(),1);assert.equal(s.cleanupAttempts,1);
});
test('queued abort does not replace in-flight snapshot and late cleanup finishes exact first owner',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);const h=harness();h.driver.endSession=async()=>{entered();await gate;return {active:false}};
 const first=h.run();await start;const snap=h.discovery.getLifecycleSnapshot(),controller=new AbortController(),reason={queued:true};const second=h.discovery.listInventory(controller.signal);controller.abort(reason);
 assert.equal((await caught(second)).error,reason);assert.deepEqual(plain(h.discovery.getLifecycleSnapshot()),plain(snap));assert.equal(h.factories(),1);release();await first;assert.equal(snap.complete,false);assert.equal(h.discovery.getLifecycleSnapshot().cleanup,'confirmed');assert.equal(h.factories(),1);
});
test('pre-abort zero calls keeps prior idle scalar state',async()=>{
 const h=harness(),controller=new AbortController(),reason={stop:true},snap=h.discovery.getLifecycleSnapshot();controller.abort(reason);assert.equal((await caught(h.discovery.listInventory(controller.signal))).error,reason);assert.equal(h.calls.length,0);assert.deepEqual(plain(h.discovery.getLifecycleSnapshot()),plain(snap));
});
