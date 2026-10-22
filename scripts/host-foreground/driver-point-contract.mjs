import {isMultilineAction} from './focused-editor-evidence.mjs';
// Pinned to the existing isolated Windows CUA 0.22.2 candidate, not a generic
// rounding policy. Desktop click/scroll/drag cast f64 to i32 (toward zero).
// See README.md for the required coordinate attestation and deployment limits.
export const WINDOWS_DESKTOP_POINT_CONTRACT='windows-cua-0.22.2-desktop-f64-as-i32-v1';
const pointerKinds=new Set(['click','double_click','right_click','scroll','drag']);
const int32=value=>Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
function coordinate(value){
 if(typeof value!=='number'||!Number.isFinite(value)||value< -2147483648||value>2147483647)throw Error('host_driver_coordinate_unprovable');
 const result=Math.trunc(value);return result===0?0:result;
}
function point(value){
 if(!value||typeof value!=='object')throw Error('host_driver_point_missing');
 return {x:coordinate(value.x),y:coordinate(value.y)};
}
// Rust f64::round rounds ties away from zero, unlike JS Math.round for negatives.
const rustRound=value=>value<0?-Math.round(-value):Math.round(value);
function drag(from,to){
 if(!int32(to.x-from.x)||!int32(to.y-from.y))throw Error('host_driver_drag_delta_unprovable');
 const points=[from];
 for(let index=1;index<=20;index++){
  const t=index/20;
  points.push({x:from.x+rustRound((to.x-from.x)*t),y:from.y+rustRound((to.y-from.y)*t)});
 }
 return points;
}
function contract(value){if(value!==WINDOWS_DESKTOP_POINT_CONTRACT)throw Error('host_driver_point_contract_unconfirmed');}
export function actionSamplePoints(action,capture,driverContract){
 if(!pointerKinds.has(action.kind)){
  if(action.point!==undefined||action.from!==undefined||action.to!==undefined)throw Error('host_driver_unexpected_point_path');
  if(!['type','keypress','select_option','wait','switch_window'].includes(action.kind))throw Error('host_driver_action_path_unproven');
  return [];
 }
 contract(driverContract);
 if(capture?.surfaceRef?.kind!=='desktop'||capture.viewport?.coordinateSpace!=='physical')throw Error('host_driver_non_desktop_projection_unproven');
 return action.kind==='drag'?drag(point(action.from),point(action.to)):[point(action.point)];
}
export function requestSamplePoints(name,args,driverContract){
 if(!['click','scroll','drag'].includes(name))return null;
 contract(driverContract);
 if(args.target?.kind!=='desktop'||args.target.display_id!=='primary'||args.delivery_mode!=='foreground'||
    ['pid','window_id','element_index','element_token','from_zoom'].some(key=>args[key]!==undefined))throw Error('host_driver_request_projection_unproven');
 if(name==='drag'){
  if(args.steps!==undefined||args.duration_ms!==undefined)throw Error('host_driver_drag_profile_unproven');
  return drag(point({x:args.from_x,y:args.from_y}),point({x:args.to_x,y:args.to_y}));
 }
 return [point(args)];
}
export function guardNativeDriver(driver,check){
 return new Proxy(driver,{get(target,name){
  if(name==='callTool')return async(tool,json,options)=>{
   if(['click','scroll','drag'].includes(tool)||(tool==='type_text'&&isMultilineAction({kind:'type',text:JSON.parse(json).text}))){
    const checked=await check(tool,JSON.parse(json),options?.signal);
    if(!checked.ok)return {isError:true,degraded:false,errorCode:'HOST_SCOPE_CHANGED',text:`${checked.reason}; fresh observation required; no input was sent`,
     structuredJson:JSON.stringify({code:'HOST_SCOPE_CHANGED',no_input_sent:true})};
   }
   return target.callTool(tool,json,options);
  };
  const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
 }});
}
