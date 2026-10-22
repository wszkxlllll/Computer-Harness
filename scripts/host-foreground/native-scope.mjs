import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {createBrowserFindAdmission} from './browser-find-admission.mjs';
const execFile=promisify(execFileCallback);
export function createForegroundScope({recordFile,getBrowserTarget,runner=import.meta.dirname}){
 const findAdmission=createBrowserFindAdmission();
 const probe=async(signal,point)=>{
  // Never let PowerShell parameter binding choose a different sample by implicit
  // banker's rounding. Only the pinned Driver projection may produce this point.
  if(point!==undefined&&(!Number.isInteger(point?.x)||!Number.isInteger(point?.y)||
     point.x< -2147483648||point.x>2147483647||point.y< -2147483648||point.y>2147483647)){
   return {role:'outside',bounds:null,probeFailed:true,errorCode:'host_probe_integer_point_required'};
  }
  const target=getBrowserTarget();
  const args=['-NoProfile','-NonInteractive','-File',join(runner,'foreground-scope.ps1'),'-EditorRecord',recordFile,'-BrowserPid',String(target?.pid??0),'-BrowserWindowId',String(target?.windowId??0)];
  if(point)args.push('-PointX',String(point.x),'-PointY',String(point.y));
  try{
   const {stdout}=await execFile(process.env.DS_PWSH,args,{windowsHide:true,timeout:10000,maxBuffer:2*1024*1024,signal});
   const value=findAdmission.project(JSON.parse(stdout.trim()));
   return {...value,role:value.sample?.role??'outside',foregroundPid:value.sample?.foreground?.pid,
    foregroundWindowId:value.sample?.foregroundWindowId,bounds:value.sample?.foreground?.bounds};
  }catch(error){
   signal?.throwIfAborted();
   return {role:'outside',bounds:null,probeFailed:true,errorCode:typeof error.code==='string'?error.code:'native_scope_unavailable'};
  }
 };
 probe.noteCompletedAction=value=>findAdmission.completed(value);
 return probe;
}
