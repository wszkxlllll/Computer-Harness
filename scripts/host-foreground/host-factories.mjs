import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {computerFactories} from './window-preparation.mjs';
import {scopeComputerModule} from './host-scope-computer.mjs';
import {WINDOWS_DESKTOP_POINT_CONTRACT} from './driver-point-contract.mjs';
export async function createHostFactories(root,{sourceUrls,foregroundScope,onEvidence=()=>{}}){
 const driverContract=process.env.DS_DRIVER_POINT_CONTRACT;
 if(driverContract!==WINDOWS_DESKTOP_POINT_CONTRACT)throw Error('Explicit pinned isolated Windows Driver coordinate-contract attestation required');
 const {browserSourceEvidence,...dependencies}=await computerFactories(root,{sourceUrls,foregroundScope,onEvidence});
 let inspect;
 dependencies.importCuaComputer=async()=>{
  const module=await import(pathToFileURL(join(root,'packages/computer-cua/dist/index.js')).href);
  if(process.platform!=='win32')throw Error('Pinned native point contract requires Windows');
  const {loadCuaSdkModule}=await import(pathToFileURL(join(root,'packages/computer-cua/dist/cua-sdk-platform.js')).href);
  const sdk=await loadCuaSdkModule('win32');
  const {captureVisibleWindowRegion}=await import(pathToFileURL(join(root,'packages/computer-cua/dist/windows-visible-window-capture.js')).href);
  const {isLocalWindowsNamedPipeSocket}=await import(pathToFileURL(join(root,'packages/computer-cua/dist/window-contract.js')).href);
  const scoped=scopeComputerModule(module,{foregroundScope,sourceEvidence:browserSourceEvidence,onEvidence,
   driverContract,connectDriver:socket=>sdk.CuaDriver.connect(socket),
   foregroundVisibleCapture:captureVisibleWindowRegion,isLocalSocket:isLocalWindowsNamedPipeSocket});
  inspect=scoped.inspect;
  return scoped.module;
 };
 return {dependencies,browserSourceEvidence,inspectScope:(...args)=>inspect?inspect(...args):Promise.resolve({ok:false,reason:'host_computer_not_open'})};
}
