//! Explicitly selected current-foreground TextEdit identity candidate only.
//! Selection authority is external trusted Host/test policy, never a nonce or
//! caller boolean. No activation, title/value, image, other-app AX or input.
use std::{collections::HashSet,ffi::c_void,sync::OnceLock,time::{Instant,Duration}};
use async_trait::async_trait;
use core_foundation::{array::{CFArray,CFArrayRef},base::{CFEqual,CFGetTypeID,CFTypeRef,TCFType},
    boolean::CFBoolean,dictionary::CFDictionary,number::{CFNumber,CFNumberIsFloatType},string::CFString};
use objc2::rc::Retained;
use objc2_app_kit::{NSRunningApplication,NSWorkspace};
use serde_json::{json,Value};
use cua_driver_core::{protocol::ToolResult,tool::{Tool,ToolDef}};
use crate::ax::bindings::*;
use super::get_target_window_topology::{AxReader,OwnedAx,ordinary_root};
use super::discover_textedit_window_identity::{cg_identity,empty_sheets,child_kind,running_application_equal,application_and_pid};
pub const NAME:&str="discover_user_selected_textedit_window_identity";
const BUNDLE:&str="com.apple.TextEdit";
const MAX_ROWS:usize=512;
const MAX_MS:u64=3000;
static DEF:OnceLock<ToolDef>=OnceLock::new();
#[link(name="CoreGraphics",kind="framework")]
extern "C" {fn CGWindowListCopyWindowInfo(options:u32,relative_to_window:u32)->CFArrayRef;}
pub struct UserSelectedTextEditWindowIdentityTool;
fn request(args:&Value)->Result<String,&'static str> {
    let object=args.as_object().ok_or("selected_identity_arguments_invalid")?;
    if object.len()!=2 || !object.keys().all(|key|matches!(key.as_str(),"bundle_id"|"request_nonce")) || args["bundle_id"]!=BUNDLE {
        return Err("selected_identity_bundle_not_authorized");
    }
    uuid::Uuid::parse_str(args["request_nonce"].as_str().ok_or("selected_identity_nonce_invalid")?)
        .map(|n|n.to_string()).map_err(|_|"selected_identity_nonce_invalid")
}
fn unknown(reason:&'static str)->ToolResult {
    ToolResult::error("Selected TextEdit identity not verified.").with_structured(json!({
        "schema_version":1,"producer_version":"harness-textedit-selected-identity-v1",
        "scope":"com.apple.TextEdit-user-selected-foreground-window-identity","read_only":true,"status":"unknown","reason_code":reason}))
}
#[async_trait]
impl Tool for UserSelectedTextEditWindowIdentityTool {
    fn def(&self)->&ToolDef {DEF.get_or_init(||ToolDef {name:NAME.into(),description:
        "Explicitly authorized current-foreground TextEdit numeric identity candidate, including bounded relative CG conflict metadata. No content, activation or subsequent input authority.".into(),
        input_schema:json!({"type":"object","required":["bundle_id","request_nonce"],"properties":{
            "bundle_id":{"type":"string","const":BUNDLE},"request_nonce":{"type":"string","format":"uuid"}},"additionalProperties":false}),
        read_only:true,destructive:false,idempotent:false,open_world:false})}
    async fn invoke(&self,mut args:Value)->ToolResult {
        cua_driver_core::tool_args::sanitize_reserved_args(&mut args);
        let nonce=match request(&args){Ok(n)=>n,Err(reason)=>return unknown(reason)};
        match tokio::task::spawn_blocking(move||sample(&nonce)).await {
            Ok(Ok(value))=>ToolResult::text("Selected TextEdit identity candidate; fresh fixed-target verification required.").with_structured(value),
            Ok(Err(reason))=>unknown(reason),Err(_)=>unknown("selected_identity_worker_failed")
        }
    }
}
fn deadline(start:Instant)->Result<(),&'static str> {
    if start.elapsed()>Duration::from_millis(MAX_MS){Err("selected_identity_deadline")}else{Ok(())}
}
unsafe fn foreground_application()->Result<Retained<NSRunningApplication>,&'static str> {
    // Cached AppKit state only locates a candidate; independent WindowServer
    // process and relative CG-order evidence below must agree, never fallback.
    let app=NSWorkspace::sharedWorkspace().frontmostApplication().ok_or("selected_identity_front_app_unknown")?;
    front_app_state(||app.isTerminated(),||app.processIdentifier(),||app.bundleIdentifier()
        .map(|value|value.to_string()==BUNDLE))?;
    Ok(app)
}
fn front_app_state(terminated:impl FnOnce()->bool,pid:impl FnOnce()->i32,bundle:impl FnOnce()->Option<bool>)->Result<(),&'static str> {
    // Preserve the original short-circuit getter order and refusal predicate.
    // Only closed diagnostic classification changes; no actual values escape.
    if terminated(){return Err("selected_identity_front_app_terminated");}
    if pid()<=0{return Err("selected_identity_front_app_pid_invalid");}
    match bundle() {
        None=>Err("selected_identity_front_app_bundle_missing"),
        Some(false)=>Err("selected_identity_front_app_bundle_mismatch"),
        Some(true)=>Ok(()),
    }
}
pub(super) unsafe fn focused_window(reader:&mut AxReader,pid:i32)->Result<OwnedAx,&'static str> {
    let pointer=AXUIElementCreateApplication(pid);if pointer.is_null(){return Err("identity_ax_unavailable");}
    let app=OwnedAx(pointer);let names=reader.names(app.0)?;
    if reader.pid(app.0)?!=pid || !names.contains("AXFocusedWindow") || !names.contains("AXHidden") {return Err("identity_ax_scope_unknown");}
    if reader.boolean(app.0,"AXHidden")? {return Err("identity_instance_hidden");}
    let root=reader.element(app.0,"AXFocusedWindow")?;let names=reader.names(root.0)?;
    if reader.pid(root.0)?!=pid || !names.contains("AXRole") || !names.contains("AXSubrole") || !names.contains("AXMinimized") || !names.contains("AXModal") {
        return Err("identity_ax_scope_unknown");
    }
    ordinary_root(&reader.string(root.0,"AXRole")?,Some(&reader.string(root.0,"AXSubrole")?))?;
    if reader.boolean(root.0,"AXMinimized")? {return Err("identity_window_minimized");}
    if reader.boolean(root.0,"AXModal")? {return Err("identity_attached_window");}
    if names.contains("AXHidden") && reader.boolean(root.0,"AXHidden")? {return Err("identity_window_hidden");}
    empty_sheets(names.contains("AXSheets"),||Ok(reader.elements(root.0,"AXSheets")?.len()))?;
    if !names.contains("AXChildren") || !names.contains("AXParent") {return Err("identity_attached_relationship_unknown");}
    let parent=reader.element(root.0,"AXParent")?;
    if CFEqual(parent.0 as CFTypeRef,app.0 as CFTypeRef)==0 {return Err("identity_parent_mismatch");}
    let children=reader.elements(root.0,"AXChildren")?;if children.len()>128 {return Err("identity_children_limit");}
    for child in children {
        let names=reader.names(child.0)?;if reader.pid(child.0)?!=pid {return Err("identity_parent_mismatch");}
        let sub=if names.contains("AXSubrole"){Some(reader.string(child.0,"AXSubrole")?)}else{None};
        child_kind(&reader.string(child.0,"AXRole")?,sub.as_deref())?;
        let parent=reader.element(child.0,"AXParent")?;
        if CFEqual(parent.0 as CFTypeRef,root.0 as CFTypeRef)==0 {return Err("identity_parent_mismatch");}
    }
    // Other ordinary windows/process instances are not enumerated or filtered.
    Ok(root)
}
#[derive(Clone,Debug)]
struct OrderRow {pid:i32,id:u32,layer:i32,on_screen:bool}
fn ordinary_order(pid:i32,id:u32,rows:&[OrderRow])->Result<(),&'static str> {
    if rows.is_empty() || rows.len()>MAX_ROWS {return Err("selected_identity_cg_order_unknown");}
    let mut seen=HashSet::new();let mut target=false;
    for (index,row) in rows.iter().enumerate() {
        if row.pid<=0 || row.id==0 || !row.on_screen || !seen.insert(row.id) {return Err("selected_identity_cg_order_unknown");}
        if row.id==id {
            if row.pid!=pid || row.layer!=0 || index!=rows.len()-1 {return Err("selected_identity_cg_order_conflict");}
            target=true;
        } else if row.layer==0 {return Err("selected_identity_cg_order_conflict");}
    }
    if target {Ok(())} else {Err("selected_identity_cg_order_unknown")}
}
unsafe fn cg_number(dict:&CFDictionary<*const c_void,*const c_void>,key:&str)->Option<i64> {
    let value=*dict.find(CFString::new(key).as_concrete_TypeRef() as *const c_void)? as CFTypeRef;
    crate::input::skylight::strict_integer_value(!value.is_null() && CFGetTypeID(value)==CFNumber::type_id(),
        ||CFNumberIsFloatType(value as _)!=0,||CFNumber::wrap_under_get_rule(value as _).to_i64())
}
fn order_identity(mut read:impl FnMut(&str)->Option<i64>)->Option<(i32,u32,i32)> {
    let pid=read("kCGWindowOwnerPID").and_then(|v|i32::try_from(v).ok())?;
    let id=read("kCGWindowNumber").and_then(super::discover_textedit_window_identity::cg_window_id)?;
    let layer=read("kCGWindowLayer").and_then(|v|i32::try_from(v).ok())?;
    Some((pid,id,layer))
}
pub(super) unsafe fn cg_order(pid:i32,id:u32)->Result<(),&'static str> {
    // Relative at-or-above target, not full inventory. Read only numeric/boolean
    // fields of other-owner conflicts; never title/name or another app's AX.
    let pointer=CGWindowListCopyWindowInfo((1<<1)|(1<<3),id);
    if pointer.is_null(){return Err("selected_identity_cg_order_unknown");}
    if CFGetTypeID(pointer as CFTypeRef)!=CFArray::<CFTypeRef>::type_id(){
        core_foundation::base::CFRelease(pointer as CFTypeRef);return Err("selected_identity_cg_order_unknown");
    }
    let array=CFArray::<CFTypeRef>::wrap_under_create_rule(pointer);
    if array.len()==0 || array.len() as usize>MAX_ROWS {return Err("selected_identity_cg_order_unknown");}
    let mut rows=Vec::with_capacity(array.len() as usize);
    for value in array.iter() {
        if CFGetTypeID(*value)!=CFDictionary::<*const c_void,*const c_void>::type_id(){return Err("selected_identity_cg_order_unknown");}
        let dict=CFDictionary::<*const c_void,*const c_void>::wrap_under_get_rule(*value as _);
        let (pid,id,layer)=order_identity(|key|cg_number(&dict,key)).ok_or("selected_identity_cg_order_unknown")?;
        let visible=*dict.find(CFString::new("kCGWindowIsOnscreen").as_concrete_TypeRef() as *const c_void).ok_or("selected_identity_cg_order_unknown")? as CFTypeRef;
        if CFGetTypeID(visible)!=CFBoolean::type_id(){return Err("selected_identity_cg_order_unknown");}
        rows.push(OrderRow {pid,id,layer,on_screen:bool::from(CFBoolean::wrap_under_get_rule(visible as _))});
    }
    ordinary_order(pid,id,&rows)
}
fn continuity(same_app:bool,same_ax:bool,same_numeric:bool)->Result<(),&'static str> {
    if same_app && same_ax && same_numeric {Ok(())} else {Err("selected_identity_changed")}
}
fn front_process_proof(value:Option<bool>)->Result<(),&'static str> {
    if value==Some(true){Ok(())}else{Err("selected_identity_front_process_unverified")}
}
fn selected_second_window<T>(equal:bool,pid:i32,second_pid:i32,read:impl FnOnce()->Result<T,&'static str>)->Result<T,&'static str> {
    if !application_and_pid(equal,pid,second_pid){return Err("selected_identity_changed");}
    read()
}
fn sample(nonce:&str)->Result<Value,&'static str> {
    if !crate::permissions::status::accessibility_granted(){return Err("identity_accessibility_required");}
    let start=Instant::now();
    unsafe {
        let before=foreground_application()?;let pid=before.processIdentifier();let mut reader=AxReader::identity_reader(start);
        let first=focused_window(&mut reader,pid)?;let id=reader.window_id(first.0)?;
        let cg_before=cg_identity(pid,id)?;
        front_process_proof(crate::input::skylight::front_process_matches(pid,id))?;
        cg_order(pid,id)?;deadline(start)?;
        let after=foreground_application()?;let second_pid=after.processIdentifier();
        let second=selected_second_window(running_application_equal(&before,&after),pid,second_pid,||focused_window(&mut reader,second_pid))?;
        let second_id=reader.window_id(second.0)?;
        let cg_after=cg_identity(second_pid,second_id)?;
        front_process_proof(crate::input::skylight::front_process_matches(second_pid,second_id))?;
        cg_order(second_pid,second_id)?;
        continuity(running_application_equal(&before,&after),CFEqual(first.0 as CFTypeRef,second.0 as CFTypeRef)!=0,
            pid==second_pid && id==second_id && cg_before==cg_after && !before.isTerminated() && !after.isTerminated())?;
        deadline(start)?;
        Ok(json!({"schema_version":1,"producer_version":"harness-textedit-selected-identity-v1",
            "source_commit":"d114f35fec05ecd37bf529e5587be86852205b64",
            "scope":"com.apple.TextEdit-user-selected-foreground-window-identity","read_only":true,"status":"verified","reason_code":"verified",
            "bundle_id":BUNDLE,"pid":pid,"window_id":id,"request_nonce":nonce,"sample_epoch":uuid::Uuid::new_v4().to_string(),
            "elapsed_ms":start.elapsed().as_millis() as u64,"candidate_only":true,"identity_lifecycle":"bounded-observation"}))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn selected_order_identity_uses_strict_integer_and_window_only_bit_pattern() {
        let decode=|number,pid,layer|order_identity(|key|Some(match key {"kCGWindowOwnerPID"=>pid,"kCGWindowNumber"=>number,"kCGWindowLayer"=>layer,_=>panic!("field")}));
        assert_eq!(decode(-1,7,0),Some((7,u32::MAX,0)));
        assert_eq!(decode(i32::MIN as i64,7,0),Some((7,0x80000000,0)));
        for (number,pid,layer) in [(-2147483649,7,0),(4294967296,7,0),(7,4294967295,0),(7,7,2147483648)] {assert_eq!(decode(number,pid,layer),None);}
        for (number,float,converted) in [(false,false,Some(7)),(true,true,Some(7)),(true,false,None)] {
            assert_eq!(order_identity(|_|crate::input::skylight::strict_integer_value(number,||float,||converted)),None);
        }
        assert_eq!(ordinary_order(7,u32::MAX,&[OrderRow {pid:7,id:u32::MAX,layer:0,on_screen:true}]),Ok(()));
        for row in [OrderRow {pid:0,id:7,layer:0,on_screen:true},OrderRow {pid:-1,id:7,layer:0,on_screen:true},OrderRow {pid:7,id:0,layer:0,on_screen:true},OrderRow {pid:7,id:7,layer:0,on_screen:false}] {
            assert_eq!(ordinary_order(7,7,&[row]),Err("selected_identity_cg_order_unknown"));
        }
        let mut fields=Vec::new();assert_eq!(order_identity(|key|{fields.push(key.to_owned());None}),None);assert_eq!(fields,vec!["kCGWindowOwnerPID"]);
    }
    #[test]fn selected_semantic_or_pid_mismatch_stops_before_second_window_read(){
        let calls=std::cell::Cell::new(0);
        for (semantic,pid,second_pid) in [(false,41,41),(true,41,42),(false,41,42)] {
            assert_eq!(selected_second_window(semantic,pid,second_pid,||{calls.set(calls.get()+1);Ok(7)}),Err("selected_identity_changed"));
        }
        assert_eq!(calls.get(),0);
        assert_eq!(selected_second_window(true,41,41,||{calls.set(calls.get()+1);Ok(7)}),Ok(7));assert_eq!(calls.get(),1);
        assert_eq!(selected_second_window::<()>(true,41,41,||Err("ax_query_error")),Err("ax_query_error"));
        for (semantic,ax,numeric) in [(false,true,true),(true,false,true),(true,true,false)] {assert!(continuity(semantic,ax,numeric).is_err());}
    }
    use super::*;
    fn target()->OrderRow {OrderRow {pid:41,id:7,layer:0,on_screen:true}}
    #[test] fn exact_selected_schema_does_not_accept_confirmation_or_target_injection() {
        let nonce=uuid::Uuid::new_v4().to_string();
        assert_eq!(request(&json!({"bundle_id":BUNDLE,"request_nonce":nonce})).unwrap(),nonce);
        for value in [json!({"bundle_id":"com.apple.Terminal","request_nonce":nonce}),json!({"bundle_id":BUNDLE,"request_nonce":"private"}),
            json!({"bundle_id":BUNDLE,"request_nonce":nonce,"user_confirmed":true}),json!({"bundle_id":BUNDLE,"request_nonce":nonce,"pid":41})] {assert!(request(&value).is_err());}
        assert_eq!(UserSelectedTextEditWindowIdentityTool.def().name,NAME);
        assert!(UserSelectedTextEditWindowIdentityTool.def().read_only);
    }
    #[test] fn front_app_diagnostics_preserve_lazy_getter_order_and_refusal() {
        use std::cell::Cell;
        let hits=Cell::new(0usize);
        assert_eq!(front_app_state(||{hits.set(hits.get()+1);true},||panic!("PID getter must not run"),||panic!("bundle getter must not run")).unwrap_err(),
            "selected_identity_front_app_terminated");assert_eq!(hits.get(),1);
        for pid in [0,-1,i32::MIN] {
            let hits=Cell::new(0usize);
            assert_eq!(front_app_state(||{hits.set(hits.get()+1);false},||{hits.set(hits.get()+1);pid},||panic!("bundle getter must not run")).unwrap_err(),
                "selected_identity_front_app_pid_invalid");assert_eq!(hits.get(),2);
        }
        for (bundle,reason) in [(None,Some("selected_identity_front_app_bundle_missing")),(Some(false),Some("selected_identity_front_app_bundle_mismatch")),(Some(true),None)] {
            let hits=Cell::new(0usize);
            let result=front_app_state(||{assert_eq!(hits.get(),0);hits.set(1);false},||{assert_eq!(hits.get(),1);hits.set(2);41},
                ||{assert_eq!(hits.get(),2);hits.set(3);bundle});
            assert_eq!(result.err(),reason);assert_eq!(hits.get(),3);
        }
    }
    #[test] fn relative_order_requires_unique_exact_last_target_and_no_ordinary_above() {
        assert!(ordinary_order(41,7,&[target()]).is_ok());
        let nonordinary=OrderRow {pid:42,id:8,layer:5,on_screen:true};
        assert!(ordinary_order(41,7,&[nonordinary.clone(),target()]).is_ok());
        let mut owner=target();owner.pid=42;
        let mut hidden=target();hidden.on_screen=false;
        let mut bad=target();bad.id=0;
        let mut invalid_owner=nonordinary.clone();invalid_owner.pid=0;
        let above=OrderRow {pid:41,id:9,layer:0,on_screen:true};
        for rows in [vec![],vec![nonordinary.clone()],vec![target(),target()],vec![owner],vec![hidden],vec![bad],
            vec![above,target()],vec![target(),nonordinary],vec![invalid_owner,target()]] {assert!(ordinary_order(41,7,&rows).is_err());}
    }
    #[test] fn relative_order_bounds_do_not_truncate_to_apparent_success() {
        let mut rows=(0..MAX_ROWS-1).map(|n|OrderRow {pid:42,id:100+n as u32,layer:5,on_screen:true}).collect::<Vec<_>>();
        rows.push(target());assert!(ordinary_order(41,7,&rows).is_ok());
        rows.insert(0,OrderRow {pid:42,id:9999,layer:5,on_screen:true});assert!(ordinary_order(41,7,&rows).is_err());
    }
    #[test] fn independent_front_process_and_bounded_object_continuity_are_required() {
        assert!(front_process_proof(Some(true)).is_ok());for value in [Some(false),None]{assert!(front_process_proof(value).is_err());}
        assert!(continuity(true,true,true).is_ok());for flags in [(false,true,true),(true,false,true),(true,true,false)]{assert!(continuity(flags.0,flags.1,flags.2).is_err());}
    }
    #[tokio::test] async fn unauthorized_bundle_stops_before_selected_os_sampler() {
        let result=UserSelectedTextEditWindowIdentityTool.invoke(json!({"bundle_id":"com.apple.Terminal","request_nonce":uuid::Uuid::new_v4().to_string()})).await;
        assert_eq!(result.is_error,Some(true));assert_eq!(result.structured_content.unwrap()["reason_code"],"selected_identity_bundle_not_authorized");
    }
}
