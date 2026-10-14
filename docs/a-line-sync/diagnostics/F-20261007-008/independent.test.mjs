import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticLauncher } from './diagnostic-launcher.mjs';

const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
class Clock {
  value=0;next=0;timers=new Map();
  now=()=>this.value;
  setTimeout=(fn,ms)=>{const id=++this.next;this.timers.set(id,{at:this.value+ms,fn});return id;};
  clearTimeout=id=>this.timers.delete(id);
  async advance(ms){this.value+=ms;for(const [id,t]of [...this.timers])if(t.at<=this.value){this.timers.delete(id);t.fn();}await flush();}
}
const deferred=()=>Promise.withResolvers();
const good=()=>({identity:{child:{pid:101,parentPid:100,start:'c1',executable:{path:'/private/tmp/cua-driver-local',sha256:'a'.repeat(64)}},parent:{pid:100,start:'p1',executable:{path:'/private/tmp/cua-driver-local',sha256:'a'.repeat(64)}},socket:{path:'/private/tmp/F005-live-20261007.Abc123/diagnostic.sock',dev:1,ino:2,uid:501,mode:0o600}},permissions:{pass:true,prompt:false,grants:{accessibility:true,screenCapture:true}}});
function setup(overrides={}){
  const clock=new Clock(),calls=[];
  const adapter={startCandidate:async()=>({owned:true}),inspect:async()=>good(),terminateExact:(_c,role)=>{calls.push(['term',role]);return true;},waitForExit:async(_c,role)=>{calls.push(['exit',role]);return true;},dispatchRunner:async()=>{calls.push(['dispatch']);},...overrides};
  return {clock,calls,launcher:createDiagnosticLauncher({adapter,clock})};
}
test('independent: awaiting_review is not dispatch and structural forged token is rejected',async()=>{
  const {launcher,calls}=setup();await launcher.start();assert.equal(launcher.snapshot().phase,'awaiting_review');assert.deepEqual(calls,[]);
  await launcher.review(Object.freeze(Object.create(null)),{approved:true,prompt:false});assert.equal(calls.some(c=>c[0]==='dispatch'),false);
});
test('independent: expired token and deadline-passed fresh inspection cannot dispatch',async()=>{
  let inspections=0;const gate=deferred();
  const {launcher,clock,calls}=setup({inspect:async()=>++inspections===1?good():gate.promise});
  await launcher.start();const review=launcher.review(launcher.getReviewToken(),{approved:true,prompt:false});await flush();
  await clock.advance(60001);gate.resolve(good());await review;assert.equal(calls.some(c=>c[0]==='dispatch'),false);
});
test('independent: concurrent review single-use and stop during fresh recheck prevents dispatch',async()=>{
  let inspections=0;const gate=deferred();
  const {launcher,calls}=setup({inspect:async()=>++inspections===2?gate.promise:good()});
  await launcher.start();const token=launcher.getReviewToken();const review=launcher.review(token,{approved:true,prompt:false});await flush();
  await launcher.review(token,{approved:true,prompt:false});await launcher.stop();gate.resolve(good());await review;
  assert.equal(calls.some(c=>c[0]==='dispatch'),false);assert.deepEqual(calls.filter(c=>c[0]==='term').map(c=>c[1]),['child','parent']);
});
test('independent: startup inspect is within 30s, late valid observation cannot yield token',async()=>{
  const gate=deferred();let inspections=0;
  const {launcher,clock,calls}=setup({inspect:async()=>++inspections===1?gate.promise:good()});
  const startup=launcher.start();await flush();await clock.advance(30000);await startup;
  assert.notEqual(launcher.snapshot().phase,'awaiting_review');assert.equal(launcher.getReviewToken(),undefined);
  gate.resolve(good());await flush();assert.equal(calls.some(c=>c[0]==='dispatch'),false);
});
test('independent: late child after start deadline can only be boundedly cleaned',async()=>{
  const child=deferred();const {launcher,clock,calls}=setup({startCandidate:()=>child.promise});
  const startup=launcher.start();await flush();await clock.advance(30000);await startup;
  assert.equal(launcher.snapshot().phase,'pending_cleanup');child.resolve({owned:true});await flush();
  assert.equal(calls.some(c=>c[0]==='dispatch'),false);assert.equal(launcher.getReviewToken(),undefined);
});
test('independent P1: clock passes deadline in resolution microtask before timer callback',async()=>{
  const child=deferred();const {launcher,clock,calls}=setup({startCandidate:()=>child.promise});
  const startup=launcher.start();await flush();clock.value=30001;child.resolve({owned:true});await flush();
  await startup;assert.notEqual(launcher.snapshot().phase,'awaiting_review');assert.equal(launcher.getReviewToken(),undefined);
  assert.equal(calls.some(c=>c[0]==='dispatch'),false);
});
test('independent: missing AX/SR and parent relation mismatch fail closed',async()=>{
  for(const mutation of [v=>{v.permissions.grants={automation:true};},v=>{v.identity.child.parentPid=999;}]){
    const {launcher,calls}=setup({inspect:async()=>{const v=good();mutation(v);return v;}});await launcher.start();
    assert.equal(launcher.getReviewToken(),undefined);assert.equal(calls.some(c=>c[0]==='dispatch'),false);
  }
});
test('independent: total cleanup5s cannot claim released on unresolved child exit',async()=>{
  const exit=deferred();const {launcher,clock,calls}=setup({waitForExit:()=>exit.promise});await launcher.start();
  const stop=launcher.stop();await flush();await clock.advance(5000);await stop;
  assert.equal(launcher.snapshot().phase,'pending_cleanup');assert.equal(calls.some(c=>c[0]==='term'&&c[1]==='parent'),false);
  exit.resolve(true);await flush();assert.equal(launcher.snapshot().phase,'pending_cleanup');
});
test('independent P1: unsettled dispatched runner cannot become globally released on stop',async()=>{
  const dispatched=deferred();const {launcher,clock,calls}=setup({dispatchRunner:()=>dispatched.promise});
  await launcher.start();const review=launcher.review(launcher.getReviewToken(),{approved:true,prompt:false});await flush();
  assert.equal(launcher.snapshot().dispatchCount,1);const stop=launcher.stop();await flush();await clock.advance(5000);await stop;
  assert.equal(launcher.snapshot().phase,'pending_cleanup');assert.deepEqual(calls,[]);
  dispatched.resolve();await review;assert.equal(launcher.snapshot().phase,'pending_cleanup');
});
test('independent P1: dispatcher settles inside cleanup budget and cleanup must proceed',async()=>{
  const dispatched=deferred();const {launcher,calls}=setup({dispatchRunner:()=>dispatched.promise});
  await launcher.start();const review=launcher.review(launcher.getReviewToken(),{approved:true,prompt:false});await flush();
  const stop=launcher.stop();await flush();dispatched.resolve();await flush();await stop;await review;
  assert.deepEqual(calls.filter(c=>c[0]==='term').map(c=>c[1]),['child','parent']);
  assert.equal(launcher.snapshot().phase,'released');
});
