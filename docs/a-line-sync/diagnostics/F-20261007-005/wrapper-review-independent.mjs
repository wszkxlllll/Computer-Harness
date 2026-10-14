import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createObservedCuaImporter, projectDiagnostic } from './activation-receipt-observer.mjs';

const diag={schema:'cua.frontmost_window_diagnostic.v1',source:'observe_exact_window_existing_visible_windows_snapshot',state:'present',frontmost_window_pid:42,frontmost_window_id:88,layer:0,z:9,is_on_screen:true,target_pid_relation:'same',target_window_id_relation:'different'};
const receipt={structuredJson:JSON.stringify({pid:42,window_id:7,observed:{frontmost_ordinary_window_id:88,frontmost_window_diagnostic:diag}})};
async function wrap(driver,onEvidence=()=>{}) {
  class Computer {constructor(options){this.options=options}}
  const importer=createObservedCuaImporter({importCuaComputer:async()=>({CuaDriverComputer:Computer}),connectDriver:()=>driver,onEvidence});
  const module=await importer();return new module.CuaDriverComputer({}).options.driverFactory('synthetic');
}
if(process.argv.includes('--async-sink-child')){
  const driver=await wrap({callTool:()=>Promise.resolve(receipt)},()=>Promise.reject(new Error('ASYNC_SINK_FAILURE')));
  assert.equal(await driver.callTool('bring_to_front','{}'),receipt);
  await new Promise(r=>setTimeout(r,20));
}else{
test('private brands, this getters and detached lifecycle methods bind to original driver exactly once',async()=>{
  class Driver {#brand=1;counts={start:0,end:0,shutdown:0,destroy:0};
    get brand(){return this.#brand}
    startSession(){assert.equal(this.#brand,1);this.counts.start++;return Promise.resolve({active:true})}
    endSession(){assert.equal(this.#brand,1);this.counts.end++;return Promise.resolve({active:false})}
    shutdown(){assert.equal(this.#brand,1);this.counts.shutdown++;return Promise.resolve()}
    uniffiDestroy(){assert.equal(this.#brand,1);this.counts.destroy++}
    callTool(){assert.equal(this.#brand,1);return Promise.resolve(receipt)}
  }
  const original=new Driver(),driver=await wrap(original);assert.equal(driver.brand,1);
  await driver.startSession();await driver.endSession();await driver.shutdown();const destroy=driver.uniffiDestroy;destroy.call(driver);
  assert.deepEqual(original.counts,{start:1,end:1,shutdown:1,destroy:1});
});
test('nonbring never reads structuredJson getter, preserves native Promise identity',async()=>{
  let reads=0;const result={get structuredJson(){reads++;throw Error('must not access')}};
  const pending=Promise.resolve(result),driver=await wrap({callTool:()=>pending});
  assert.equal(driver.callTool('list_windows','{}'),pending);await pending;assert.equal(reads,0);
});
test('actual abort reason and synchronous native throw remain unchanged',async()=>{
  const c=new AbortController(),reason=new Error('synthetic abort');c.abort(reason);let calls=0;
  const driver=await wrap({callTool(_n,_a,opts){calls++;opts.signal.throwIfAborted()}});
  assert.throws(()=>driver.callTool('bring_to_front','{}',{signal:c.signal}),e=>e===reason);assert.equal(calls,1);
});
test('bring receipt getter failure is swallowed without changing returned result',async()=>{
  const result={get structuredJson(){throw Error('private getter')}};const driver=await wrap({callTool:()=>Promise.resolve(result)});
  assert.equal(await driver.callTool('bring_to_front','{}'),result);
});
test('bring returns identical Promise and result while emitting one safe bound projection',async()=>{
 const promise=Promise.resolve(receipt),evidence=[];
 const driver=await wrap({callTool:()=>promise},e=>evidence.push(e));
 const returned=driver.callTool('bring_to_front','{}');assert.equal(returned,promise);assert.equal(await returned,receipt);
 assert.deepEqual(evidence,[{...diag,target_pid:42,target_window_id:7}]);
 assert.equal(JSON.stringify(evidence).includes('PRIVATE_MARKER'),false);
});
test('boundary numbers, missing/invalid states, schema and malicious nested fields fail closed',()=>{
 const project=d=>projectDiagnostic(JSON.stringify({pid:42,window_id:7,observed:{frontmost_ordinary_window_id:d.frontmost_window_id,frontmost_window_diagnostic:d}}));
 for(const [key,values] of Object.entries({frontmost_window_pid:[0,-1,2**31,1.5],frontmost_window_id:[0,-1,2**32,1.5],z:[0,-1,2**32,1.5],is_on_screen:[null,0,'true']}))for(const v of values)assert.equal(project({...diag,[key]:v}),undefined);
 assert.ok(project({...diag,frontmost_window_pid:0x7fffffff,target_pid_relation:'different',frontmost_window_id:0xffffffff,z:0xffffffff}));
 assert.equal(project({...diag,schema:'UNKNOWN'}),undefined);
 assert.equal(project({...diag,state:'missing'}),undefined);
 for(const state of ['missing','invalid'])assert.equal(project({...diag,state,frontmost_window_pid:null,frontmost_window_id:null,layer:null,z:null,is_on_screen:null,target_pid_relation:'unknown',target_window_id_relation:'unknown'}),undefined);
 assert.equal(JSON.stringify(project({...diag,secret:{title:'PRIVATE_MARKER'},app_name:'PRIVATE_MARKER'})).includes('PRIVATE_MARKER'),false);
});
test('FIX: async evidence sink rejection is consumed without child process failure',()=>{
 const child=spawnSync(process.execPath,[import.meta.filename,'--async-sink-child'],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.doesNotMatch(child.stderr,/ASYNC_SINK_FAILURE/);
});
test('FIX: valid-shaped diagnostic with legacy receipt ID and target relation conflicts is rejected',()=>{
 const conflicting=JSON.stringify({pid:42,window_id:88,observed:{frontmost_ordinary_window_id:999,frontmost_window_diagnostic:diag}});
 assert.equal(projectDiagnostic(conflicting),undefined);
});
test('OBSERVED: function identities change on every get; immutable own functions violate Proxy invariant',async()=>{
 const driver=await wrap({callTool:()=>Promise.resolve(receipt),shutdown(){}});
 assert.notEqual(driver.shutdown,driver.shutdown);assert.notEqual(driver.callTool,driver.callTool);
 const immutable={};Object.defineProperty(immutable,'shutdown',{value:function(){},writable:false,configurable:false});
 const decorated=await wrap(immutable);assert.throws(()=>decorated.shutdown,TypeError);
});
}
