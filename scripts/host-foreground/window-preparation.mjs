// Host adaptation of main-eight/window-preparation.mjs. The production host owns
// all browser launch, transport, window binding and close behavior.
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBrowserSourceEvidence} from './browser-source-evidence.mjs';
export async function computerFactories(root,{onEvidence=()=>{},sourceUrls=[],foregroundScope}={}){
 const {ManagedBrowserHost}=await import(pathToFileURL(join(root,'packages/computer-cua/dist/index.js')).href);
 const browserSourceEvidence=createBrowserSourceEvidence({sourceUrls,foregroundScope,onEvidence});
 return {browserSourceEvidence,createManagedBrowserHost(options){
  const host=new ManagedBrowserHost({...options,startupTimeoutMs:60000});
  return new Proxy(host,{get(target,property){
   if(property==='start')return async signal=>{
    const record=await target.start(signal);const identity=record.target.windowTarget;
    if(!Number.isSafeInteger(identity.pid)||!Number.isSafeInteger(identity.windowId))throw new Error('Exact owned browser window identity unavailable');
    browserSourceEvidence.bindHost(record.target,target.collect.bind(target));
    onEvidence({kind:'managed-browser.identity',target:identity});return record;
   };
   if(property==='createTransport')return()=>{
    const transport=target.createTransport();return new Proxy(transport,{get(delegate,name){
     if(name==='collect')return async(request,signal)=>{const result=await delegate.collect(request,signal);onEvidence({kind:'viewport',observationId:request.observationId,viewportMetrics:result.viewportMetrics,pageUrl:result.pageUrl});return result;};
     const value=Reflect.get(delegate,name,delegate);return typeof value==='function'?value.bind(delegate):value;
    }});
   };
   if(property==='close')return async()=>{browserSourceEvidence.close();return target.close();};
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
 }};
}
