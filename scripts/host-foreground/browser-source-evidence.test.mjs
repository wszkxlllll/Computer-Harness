import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBrowserSourceEvidence} from './browser-source-evidence.mjs';

const signal=new AbortController().signal;
const viewport=Object.freeze({width:1440,height:900,coordinateSpace:'physical'});
const target=Object.freeze({kind:'managed-chromium',browser:'edge',profileId:'run-profile',delivery:'loopback-cdp',
 windowTarget:Object.freeze({pid:301,windowId:401}),tabId:'tab-1',generation:'doc-1'});
const ownedScope=()=>({role:'browser',foregroundPid:301,foregroundWindowId:401,bounds:{left:0,top:0,right:1200,bottom:850}});

// A synthetic page/window state machine drives the REAL evidence reducer.
// The reader models the product's identity attestation contract, not guard
// answers; all authorization/projection/invalidation is implementation logic.
function scenario(){
 let time=Date.parse('2026-10-19T10:00:00.000Z'),scope=ownedScope(),page={url:'https://official.test/guide',tabId:'tab-1',generation:'doc-1'},witness=true,reads=0;
 const events=[],session={id:'computer-1',viewport};
 let duringRead;
 const evidence=createBrowserSourceEvidence({sourceUrls:['https://official.test/guide'],foregroundScope:async()=>scope,
  now:()=>time,onEvidence:event=>events.push(event)});
 evidence.bindHost(target,async()=>{
  reads++;time+=5;if(duringRead){const run=duringRead;duringRead=undefined;run();}
  return {candidates:[],coordinateSpace:'css',viewportMetrics:{cssWidth:1200,cssHeight:800,deviceScaleFactor:1},
   pageUrl:page.url,tabId:page.tabId,generation:page.generation,
   ...(witness?{visibleText:{source:'dom-table-v1',scope:'current-viewport',regions:[]}}:{})};
 });
 async function before(id='observation-1'){
  return evidence.observeBefore({session,observationId:id,viewport,scope},signal);
 }
 async function finish(token,patch={}){
  time+=5;
  const capture={capturedAt:new Date(time).toISOString(),viewport,surfaceRef:{surfaceId:'desktop-1',generation:1,kind:'desktop'},screenshot:{mediaType:'image/png',data:new Uint8Array()},...patch};
  time+=5;
  return {capture,result:await evidence.observeAfter({token,capture,scope},signal)};
 }
 async function observe(id='observation-1',patch={}){return finish(await before(id),patch);}
 const action=(id='action-1',basedOn='observation-1')=>({kind:'type',actionId:id,basedOn,text:'synthetic query'});
 const check=(value=action(),options)=>evidence.preDispatch({session,action:value,scope,options},signal);
 return {evidence,events,session,before,finish,observe,action,check,get reads(){return reads;},
  navigate(url,generation=page.generation){page={...page,url,generation};},switchTab(){page={...page,tabId:'tab-2'};},
  setScope(value){scope=value;},removeUrl(){page={...page,url:undefined};},removeWitness(){witness=false;},
  duringRead(fn){duringRead=fn;},advance(ms){time+=ms;}};
}

test('Ctrl+F absent Document geometry receives fresh source-only catalog without mutating capture',async()=>{
 const run=scenario();const {capture,result}=await run.observe();
 assert.equal(capture.grounding,undefined);
 assert.equal(result.grounding.pageUrl,'https://official.test/guide');
 assert.equal(result.grounding.observationId,'observation-1');
 assert.equal(result.grounding.computerSessionId,'computer-1');
 assert.deepEqual(result.grounding.elements,[]);
 assert.equal(result.grounding.completeness,'partial');
 const record=run.evidence.access({observationId:'observation-1',computerSessionId:'computer-1',pageUrl:result.grounding.pageUrl});
 assert.equal(record.browserTarget.windowTarget.windowId,401);
 assert.equal(record.tabId,'tab-1');assert.equal(record.generation,'doc-1');
 assert.ok(record.collectionStartedAtMs<=Date.parse(record.capturedAt));
 assert.ok(record.collectionEndedAtMs>=Date.parse(record.capturedAt));
 assert.equal((await run.check()).allowed,true);
 assert.equal((await run.check()).reasonCode,'host_browser_action_replay_denied');
});

test('existing fresh catalog preserves elements and rejects conflicting sources',async()=>{
 const run=scenario(),catalog={version:'grounding-catalog-v2',source:'hybrid',observationId:'observation-1',computerSessionId:'computer-1',
  completeness:'partial',degraded:false,maxElements:256,elements:[{elementRef:'real-ref',role:'button',source:'uia'}]};
 const {result}=await run.observe('observation-1',{grounding:catalog});
 assert.equal(catalog.pageUrl,undefined);assert.equal(result.grounding.elements,catalog.elements);
 const conflict=scenario();await conflict.observe('observation-1',{grounding:{...catalog,pageUrl:'https://official.test/different'}});
 assert.equal(conflict.evidence.access({observationId:'observation-1',computerSessionId:'computer-1'}),undefined);
 assert.equal((await conflict.check()).allowed,false);
});

for(const [label,mutate]of [
 ['external site',run=>run.navigate('https://outside.test/guide')],
 ['authentication route',run=>run.navigate('https://official.test/oauth/authorize')],
 ['same-URL document reload',run=>run.navigate('https://official.test/guide','doc-2')],
 ['same-origin URL change',run=>run.navigate('https://official.test/another')],
 ['active tab replacement',run=>run.switchTab()],
 ['private browser window',run=>run.setScope({...ownedScope(),foregroundWindowId:999})],
 ['missing source',run=>run.removeUrl()],
 ['same-collection navigation witness missing',run=>run.removeWitness()],
 ['browser moved',run=>run.setScope({...ownedScope(),bounds:{left:10,top:0,right:1210,bottom:850}})],
])test(`${label} between observation and dispatch never reaches input and retires basedOn`,async()=>{
 const run=scenario();await run.observe();mutate(run);
 let sent=0;const dispatch=await run.check();if(dispatch.allowed)sent++;
 assert.equal(sent,0);assert.equal(dispatch.allowed,false);
 assert.equal(run.evidence.access({observationId:'observation-1',computerSessionId:'computer-1'}),undefined);
});

test('navigation during capture cannot retroactively bless the old observation',async()=>{
 const run=scenario(),token=await run.before();run.navigate('https://official.test/guide','doc-2');
 const {capture,result}=await run.finish(token);
 assert.equal(result,capture);assert.equal(result.grounding,undefined);
 assert.equal((await run.check()).allowed,false);
});

test('foreground switches during read-only dispatch collect are rejected',async()=>{
 const run=scenario();await run.observe();run.duringRead(()=>run.setScope({...ownedScope(),role:'outside',foregroundWindowId:999}));
 assert.equal((await run.check()).reasonCode,'host_browser_foreground_changed');
});

test('fresh execution observation must agree with original decision and latest session observation',async()=>{
 const run=scenario();await run.observe();await run.observe('execution-1');
 assert.equal((await run.check(run.action(),{executionObservationId:'execution-1'})).allowed,true);
 const changed=scenario();await changed.observe();changed.switchTab();await changed.observe('execution-1');
 assert.equal((await changed.check(changed.action(),{executionObservationId:'execution-1'})).allowed,false);
});

test('no guard-time read may repair missing observation evidence',async()=>{
 const run=scenario();const reads=run.reads;
 assert.equal((await run.check()).reasonCode,'host_browser_observation_unconfirmed');assert.equal(run.reads,reads);
 await run.observe();
 assert.equal(run.evidence.access({observationId:'observation-1',computerSessionId:'different-session'}),undefined);
 assert.equal(run.evidence.access({observationId:'observation-1',computerSessionId:'computer-1',pageUrl:'https://official.test/other'}),undefined);
});

test('expired observation and reused observation identities stay refused',async()=>{
 const expired=scenario();await expired.observe();expired.advance(120001);assert.equal((await expired.check()).allowed,false);
 const reused=scenario();await reused.observe();const token=await reused.before();assert.equal(token.allowed,false);
 assert.equal(reused.evidence.access({observationId:'observation-1',computerSessionId:'computer-1'}),undefined);
});

test('closed/replaced Run Host cannot authenticate an earlier observation',async()=>{
 const run=scenario();await run.observe();run.evidence.close();
 assert.equal((await run.check()).allowed,false);
});

test('source unavailable at observation time never gains evidence after recovery',async()=>{
 const run=scenario();run.removeUrl();const token=await run.before();run.navigate('https://official.test/guide');
 const {capture,result}=await run.finish(token);assert.equal(result,capture);
 assert.equal((await run.check()).allowed,false);
 assert.equal((await run.before()).reasonCode,'host_browser_observation_reused');
});

test('native Ctrl+F popup evidence survives observation recording and dispatch validation',async()=>{
 const run=scenario();
 run.setScope({...ownedScope(),foregroundWindowId:402,bounds:{left:700,top:80,right:1100,bottom:160},
  sample:{root:{pid:301},browserFindAdmission:{kind:'completed-ctrl-f-owned-uia-edit-v1',rootWindowId:401,popupWindowId:402}}});
 const {result}=await run.observe();
 assert.equal(result.grounding.pageUrl,'https://official.test/guide');
 const record=run.evidence.access({observationId:'observation-1',computerSessionId:'computer-1'});
 assert.equal(record.scope.foregroundWindowId,402);
 assert.equal((await run.check()).allowed,true);
});
