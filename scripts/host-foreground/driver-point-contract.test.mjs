import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WINDOWS_DESKTOP_POINT_CONTRACT as contract,actionSamplePoints,requestSamplePoints} from './driver-point-contract.mjs';
import {scopeComputerModule} from './host-scope-computer.mjs';
import {createForegroundScope} from './native-scope.mjs';
const capture={surfaceRef:{kind:'desktop'},viewport:{width:1280,height:720,coordinateSpace:'physical'}};
const request=(x,y)=>({target:{kind:'desktop',display_id:'primary'},delivery_mode:'foreground',x,y});
const project=(kind,point)=>actionSamplePoints({kind,point},capture,contract);
for(const kind of ['click','double_click','right_click','scroll'])test(`${kind} samples native truncation, preserving the Runtime float`,()=>{
 const input={x:153.5,y:434.3125};assert.deepEqual(project(kind,input),[{x:153,y:434}]);assert.deepEqual(input,{x:153.5,y:434.3125});
 assert.deepEqual(project(kind,{x:-153.5,y:-0.75}),[{x:-153,y:0}]);
 assert.deepEqual(requestSamplePoints(kind==='scroll'?'scroll':'click',request(-153.5,434.3125),contract),[{x:-153,y:434}]);
});
test('drag follows all twenty native steps and rounds negative displacement ties away from zero',()=>{
 const points=actionSamplePoints({kind:'drag',from:{x:10.75,y:-20.75},to:{x:0.5,y:-10.5}},capture,contract);
 assert.equal(points.length,21);assert.deepEqual(points[0],{x:10,y:-20});assert.deepEqual(points[1],{x:9,y:-19});assert.deepEqual(points.at(-1),{x:0,y:-10});
 assert.deepEqual(requestSamplePoints('drag',{target:{kind:'desktop',display_id:'primary'},delivery_mode:'foreground',from_x:10.75,from_y:-20.75,to_x:0.5,to_y:-10.5},contract),points);
});
test('unknown contracts, coordinate spaces and unsupported request paths fail closed',()=>{
 assert.throws(()=>actionSamplePoints({kind:'click',point:{x:1.5,y:2.5}},capture));
 assert.throws(()=>actionSamplePoints({kind:'click',point:{x:1.5,y:2.5}},{...capture,surfaceRef:{kind:'window'}},contract));
 for(const point of [null,{x:NaN,y:1},{x:Infinity,y:1},{x:2147483648,y:1},{x:1}])assert.throws(()=>project('click',point));
 assert.throws(()=>actionSamplePoints({kind:'type',point:{x:1,y:1}},capture,contract));
 assert.throws(()=>requestSamplePoints('click',{...request(1,2),target:{kind:'window',pid:1,window_id:2}},contract));
 assert.throws(()=>requestSamplePoints('drag',{...request(1,2),steps:21},contract));
});
test('PS bridge refuses floats before invoking any native probe',async()=>{
 const probe=createForegroundScope({recordFile:'must-not-be-read',getBrowserTarget(){throw Error('Must not reach process launch');}});
 assert.equal((await probe(undefined,{x:153.5,y:434.3125})).errorCode,'host_probe_integer_point_required');
});
function fixture({bounds={left:-200,top:-100,right:1000,bottom:600},hitTransform=point=>point,dispatchTransform=point=>point,driverContract=contract,maxAgeMs=120000}={}){
 const native={valid:true,pid:10,windowId:100,threadId:20,dpi:96,processStartTicks:'1000',parentWindowId:0,ownerWindowId:0,
  windowClass:'Synthetic',visible:true,enabled:true,minimized:false,cloakedKnown:true,cloaked:false,boundsValid:true,bounds};
 const sample={role:'editor',coordinateSpace:'physical-screen-pixels',physicalCoordinates:true,rootIdentityValid:true,guiInfoValid:true,controlsComplete:true,
  foregroundWindowId:100,focusWindowId:100,captureWindowId:0,activeWindowId:100,root:native,foreground:native,ownerChain:[native],focusWindow:native,focusParents:[native],
  regions:[{kind:'foreground',window:native,parentChain:[native],ownerChain:[native]}]};
 const events=[],probes=[],sent=[];let altered=false,unknown=false,old=false;
 const foregroundScope=async(_signal,point)=>{
  const time=Date.now()-(old?10000:0),value=structuredClone(sample);if(altered)value.foregroundWindowId=999;
  if(point){probes.push(point);value.pointHit={point:hitTransform(point),window:native,parentChain:[native],ownerChain:[native]};}
  return {schema:'host-point-scope/v1',capturedAt:time,completedAt:time,sample:value,recheck:structuredClone(value),role:value.role};
 };
 const driver={async callTool(name,json){sent.push({name,args:JSON.parse(json)});return {isError:false,text:'sent'};}};
 class ExternalComputer{
  constructor(options){this.driver=options.driverFactory('fixture');}
  async observe(){return {...capture,capturedAt:new Date().toISOString()};}
  async execute(_session,action,signal){
   let name='click',args;
   if(action.kind==='drag'){
    name='drag';const from=dispatchTransform(action.from),to=dispatchTransform(action.to);
    args={target:{kind:'desktop',display_id:'primary'},delivery_mode:'foreground',from_x:from.x,from_y:from.y,to_x:to.x,to_y:to.y};
   }else{const point=dispatchTransform(action.point);args=request(point.x,point.y);}
   const result=await this.driver.callTool(name,JSON.stringify(args),{signal});
   return {actionId:action.actionId,status:result.isError?'refused':unknown?'partial':'completed'};
  }
 }
 const sourceEvidence={observeBefore:async()=>null,observeAfter:async({capture})=>capture};
 const scoped=scopeComputerModule({CuaDriverComputer:ExternalComputer},{foregroundScope,sourceEvidence,driverContract,connectDriver:()=>driver,onEvidence:event=>events.push(event),maxAgeMs});
 const computer=new scoped.module.CuaDriverComputer(),session={id:'session',viewport:capture.viewport},signal=new AbortController().signal;
 const observe=id=>computer.observe(session,id,signal);
 const action=(point={x:153.5,y:434.3125},basedOn='obs')=>({kind:'click',point,actionId:'action',basedOn});
 return {events,probes,sent,action,observe,execute:(value=action(),options)=>computer.execute(session,value,signal,options),
  inspect:async value=>scoped.inspect({session,action:value,scope:await foregroundScope()},signal),outside(){altered=true;},unknown(){unknown=true;},expire(){old=true;}};
}
test('fractional Runtime center passes both Host gates; Driver receives original floats',async()=>{
 const f=fixture();await f.observe('obs');assert.equal((await f.inspect(f.action())).ok,true);
 assert.equal((await f.execute()).status,'completed');assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].args.x,153.5);assert.equal(f.sent[0].args.y,434.3125);
 assert.ok(f.probes.every(point=>point.x===153&&point.y===434));
 assert.ok(f.events.some(event=>event.stage==='native-dispatch'&&event.result.ok));
 assert.equal((await f.execute()).status,'refused');assert.equal(f.sent.length,1);
});
test('final Computer dispatch coordinates, not earlier action coordinates, are rechecked',async()=>{
 const f=fixture({dispatchTransform:()=>({x:1000.1,y:434.3125})});await f.observe('obs');
 assert.equal((await f.inspect(f.action())).ok,true);assert.equal((await f.execute()).status,'refused');assert.equal(f.sent.length,0);
 assert.ok(f.probes.some(point=>point.x===1000));
});
test('mismatched native hit never authorizes a neighboring pixel',async()=>{
 const f=fixture({hitTransform:point=>({...point,x:point.x+1})});await f.observe('obs');assert.equal((await f.execute()).status,'refused');assert.equal(f.sent.length,0);
});
for(const [point,allowed]of [[{x:-199.9,y:-99.9},true],[{x:999.9,y:599.9},true],[{x:1000,y:599},false],[{x:999,y:600},false],[{x:-201.1,y:0},false]])test(`half-open exact region at ${point.x},${point.y}`,async()=>{
 const f=fixture();await f.observe('obs');assert.equal((await f.execute(f.action(point))).status,allowed?'completed':'refused');assert.equal(f.sent.length,allowed?1:0);
});
test('stale scopes and changed native foreground remain refusals',async()=>{
 const f=fixture();await f.observe('obs');f.outside();assert.equal((await f.execute()).status,'refused');assert.equal(f.sent.length,0);
 const g=fixture({maxAgeMs:100});await g.observe('obs');g.expire();assert.equal((await g.execute()).status,'refused');assert.equal(g.sent.length,0);
});
test('unknown dispatch consumes the execution observation without replay',async()=>{
 const f=fixture();await f.observe('obs');f.unknown();assert.equal((await f.execute()).status,'partial');assert.equal((await f.execute()).status,'refused');
 await f.observe('obs-2');assert.equal((await f.execute(f.action({x:153.5,y:434.3125},'obs-2'))).status,'refused');assert.equal(f.sent.length,1);
});
test('drag preflight and final Driver gate both inspect intermediate samples, not just endpoints',async()=>{
 const action={kind:'drag',from:{x:0.75,y:10.75},to:{x:10.75,y:10.75},actionId:'drag',basedOn:'obs'};
 const good=fixture();await good.observe('obs');assert.equal((await good.execute(action)).status,'completed');
 assert.equal(good.events.filter(event=>event.kind==='host.point.checked'&&event.stage==='native-dispatch').length,21);
 const bad=fixture({hitTransform:point=>point.x===5?{...point,x:6}:point});await bad.observe('obs');
 assert.equal((await bad.inspect(action)).ok,false);assert.equal(bad.sent.length,0);
 let finalPhase=false;
 const late=fixture({dispatchTransform:point=>{finalPhase=true;return point;},hitTransform:point=>finalPhase&&point.x===5?{...point,x:6}:point});
 await late.observe('obs');assert.equal((await late.inspect(action)).ok,true);
 assert.equal((await late.execute(action)).status,'refused');assert.equal(late.sent.length,0);
 assert.ok(late.events.some(event=>event.stage==='native-dispatch'&&event.result.ok===false));
});
