//! New-window-only observation session. No titles, body, URL, activation,
//! input, capture fallback or Run authority. Handles never leave this worker.
use std::{cell::RefCell,collections::HashSet,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering},mpsc},thread,time::{Duration,Instant}};
use async_trait::async_trait;
use core_foundation::base::{CFEqual,CFTypeRef};
use objc2::rc::Retained;
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::NSString;
use serde_json::{json,Value};
use cua_driver_core::{protocol::{Content,ToolResult},tool::{Tool,ToolDef,ToolRegistry}};
use base64::{Engine,engine::general_purpose::STANDARD};
use crate::ax::bindings::*;
use super::{get_target_window_topology::{AxReader,OwnedAx,ordinary_root},
    discover_textedit_window_identity::{cg_identity,running_application_equal,child_kind,empty_sheets},
    controlled_window_capture::{self,Bound,Captured}};
pub const PREPARE:&str="prepare_textedit_new_window_observation";
pub const OPEN:&str="open_textedit_new_window_session";
pub const OBSERVE:&str="observe_textedit_window_session";
pub const CLOSE:&str="close_textedit_window_session";
pub const SCOPE:&str="com.apple.TextEdit-new-window-observation-session";
pub const PRODUCER:&str="harness-textedit-window-session-v1";
const BUNDLE:&str="com.apple.TextEdit";
const REQUEST:Duration=Duration::from_secs(8);
const ADMISSION_TTL:Duration=Duration::from_secs(30);
const SESSION_TTL:Duration=Duration::from_secs(60);
const MAX_ROOTS:usize=128;
#[derive(Clone,Copy,Debug,PartialEq,Eq)]enum Op{Prepare,Open,Observe,Close}
impl Op{fn name(self)->&'static str{match self{Self::Prepare=>PREPARE,Self::Open=>OPEN,Self::Observe=>OBSERVE,Self::Close=>CLOSE}}}
struct Request {op:Op,nonce:String,reference:Option<String>,deadline:Instant,cancel:Arc<AtomicBool>,
    reply:tokio::sync::oneshot::Sender<ToolResult>,control:Arc<Control>,child_diagnostic:RefCell<Option<Value>>}
impl Request {fn alive(&self)->Result<(),&'static str>{
    if self.cancel.load(Ordering::SeqCst) || self.control.revoked.load(Ordering::SeqCst)
        || self.reply.is_closed() || Instant::now()>=self.deadline {Err("session_request_expired")}else{Ok(())}
}fn can_reply(&self)->bool{!self.cancel.load(Ordering::SeqCst) && !self.reply.is_closed() && Instant::now()<self.deadline}}
#[derive(Default)]struct Meta {reference:Option<String>,nonce:Option<String>,terminal:bool,expires:Option<Instant>,active_cancel:Option<Arc<AtomicBool>>,published:u64}
struct Control {meta:Mutex<Meta>,revoked:AtomicBool,busy:AtomicBool}
impl Control {fn new()->Self{Self{meta:Mutex::new(Meta::default()),revoked:AtomicBool::new(false),busy:AtomicBool::new(false)}}
    fn revoke(&self){if let Ok(meta)=self.meta.lock(){self.revoked.store(true,Ordering::SeqCst);if let Some(cancel)=&meta.active_cancel{cancel.store(true,Ordering::SeqCst);}}}}
struct Client {queue:mpsc::SyncSender<Request>,control:Arc<Control>,stop:Arc<AtomicBool>}
impl Drop for Client {fn drop(&mut self){self.control.revoke();self.stop.store(true,Ordering::SeqCst);}}
struct Cancel {cancel:Arc<AtomicBool>,control:Arc<Control>,armed:bool}
impl Drop for Cancel{fn drop(&mut self){if self.armed{self.control.revoke();self.cancel.store(true,Ordering::SeqCst);}}}
struct SessionTool {op:Op,def:ToolDef,client:Arc<Client>}
fn descriptor(status:&str,nonce:&str)->Value{json!({"schema_version":1,"producer_version":PRODUCER,"scope":SCOPE,
    "status":status,"request_nonce":nonce,"input_authorized":false,"run_ref_issued":false,"global_topology_complete":false,"activation_started":false})}
fn failure(reason:&'static str,nonce:&str)->ToolResult{let mut value=descriptor("unknown",nonce);value["reason_code"]=json!(reason);
    ToolResult::error("New-window observation is not verified. No input or activation authorized.").with_structured(value)}
fn arguments(args:&Value,op:Op)->Result<(String,Option<String>),&'static str>{
    let object=args.as_object().ok_or("session_arguments_invalid")?;
    let keys=if op==Op::Prepare{vec!["bundle_id","request_nonce"]}else{vec!["session_ref","request_nonce"]};
    if object.len()!=keys.len() || !object.keys().all(|k|keys.contains(&k.as_str())){return Err("session_arguments_invalid");}
    if op==Op::Prepare && args["bundle_id"]!=BUNDLE{return Err("session_task_not_authorized");}
    let nonce=uuid::Uuid::parse_str(args["request_nonce"].as_str().ok_or("session_arguments_invalid")?).map_err(|_|"session_arguments_invalid")?.to_string();
    let reference=if op==Op::Prepare{None}else{Some(uuid::Uuid::parse_str(args["session_ref"].as_str().ok_or("session_arguments_invalid")?).map_err(|_|"session_arguments_invalid")?.to_string())};
    Ok((nonce,reference))
}
fn definition(op:Op)->ToolDef{ToolDef{name:op.name().into(),description:"Opt-in fixed TextEdit new-window observation only; no title, document value, URL, activation or input. Session refs are actor-local, not Run refs.".into(),
    input_schema:if op==Op::Prepare{json!({"type":"object","required":["bundle_id","request_nonce"],"properties":{"bundle_id":{"const":BUNDLE,"type":"string"},"request_nonce":{"type":"string","format":"uuid"}},"additionalProperties":false})}
    else{json!({"type":"object","required":["session_ref","request_nonce"],"properties":{"session_ref":{"type":"string","format":"uuid"},"request_nonce":{"type":"string","format":"uuid"}},"additionalProperties":false})},
    read_only:true,destructive:false,idempotent:false,open_world:false}}
#[async_trait]impl Tool for SessionTool {
    fn def(&self)->&ToolDef{&self.def}
    async fn invoke(&self,mut args:Value)->ToolResult{
        cua_driver_core::tool_args::sanitize_reserved_args(&mut args);
        let (nonce,reference)=match arguments(&args,self.op){Ok(v)=>v,Err(e)=>return failure(e,"")};
        if self.op==Op::Close {
            let meta=match self.client.control.meta.lock(){Ok(v)=>v,Err(_)=>return failure("session_state_unavailable",&nonce)};
            if meta.reference.as_ref()!=reference.as_ref(){return failure("session_ref_invalid",&nonce);}
            self.client.control.revoked.store(true,Ordering::SeqCst);
            if let Some(cancel)=&meta.active_cancel{cancel.store(true,Ordering::SeqCst);}
            let mut value=descriptor(if meta.terminal{"closed"}else{"closing"},&nonce);value["session_ref"]=json!(reference);
            // No queue dependency: an in-progress synchronous capture sees the
            // tombstone at its next guard. Objects remain until real completion.
            return ToolResult::text("Session observation authority revoked; pending work is not hard-cancelled.").with_structured(value);
        }
        if self.client.control.revoked.load(Ordering::SeqCst){return failure("session_closed",&nonce);}
        if self.client.control.busy.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err(){return failure("session_pending",&nonce);}
        let (reply,receiver)=tokio::sync::oneshot::channel();let cancel=Arc::new(AtomicBool::new(false));let mut cancel_guard=Cancel{cancel:cancel.clone(),control:self.client.control.clone(),armed:true};
        let deadline={let mut meta=match self.client.control.meta.lock(){Ok(v)=>v,Err(_)=>{self.client.control.busy.store(false,Ordering::SeqCst);return failure("session_state_unavailable",&nonce)}};
            meta.active_cancel=Some(cancel.clone());meta.expires.map_or(Instant::now()+REQUEST,|expires|expires.min(Instant::now()+REQUEST))};
        let request=Request{op:self.op,nonce:nonce.clone(),reference,deadline,cancel,reply,control:self.client.control.clone(),child_diagnostic:RefCell::new(None)};
        if self.client.queue.try_send(request).is_err(){self.client.control.busy.store(false,Ordering::SeqCst);return failure("session_worker_unavailable",&nonce);}
        match tokio::time::timeout(REQUEST,receiver).await{Ok(Ok(v))=>{cancel_guard.armed=false;v},_=>{
            self.client.control.revoke();let mut result=failure("session_pending_terminal",&nonce);
            if let Some(v)=result.structured_content.as_mut(){v["status"]=json!("closing");}result
        }}
    }
}
struct Root {app:usize,pid:i32,id:u32,root:OwnedAx}
struct Catalog {apps:Vec<Retained<NSRunningApplication>>,roots:Vec<Root>}
struct Candidate {app:Retained<NSRunningApplication>,root:OwnedAx,bound:Bound}
trait Backend {
    type Baseline;type Candidate;
    fn prepare(&mut self,request:&Request)->Result<Self::Baseline,&'static str>;
    fn open(&mut self,baseline:Self::Baseline,request:&Request)->Result<Self::Candidate,&'static str>;
    fn observe(&mut self,candidate:&Self::Candidate,request:&Request)->Result<Captured,&'static str>;
}
struct Native;
unsafe fn catalog(request:&Request)->Result<Catalog,&'static str>{
    request.alive()?;if !crate::permissions::status::accessibility_granted(){return Err("session_accessibility_required");}
    let applications=NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(BUNDLE));
    if applications.len()>32{return Err("session_inventory_limit");}
    let mut result=Catalog{apps:Vec::new(),roots:Vec::new()};let mut pids=HashSet::new();let mut ids=HashSet::new();
    let mut reader=AxReader::guarded_identity_reader(Instant::now(),request.deadline,request.cancel.clone());
    for index in 0..applications.len(){request.alive()?;let app=applications.objectAtIndex(index);
        let pid=app.processIdentifier();
        if app.isTerminated() || pid<=0 || !pids.insert(pid) || app.bundleIdentifier().is_none_or(|s|s.to_string()!=BUNDLE){return Err("session_application_unknown");}
        let ax=OwnedAx(AXUIElementCreateApplication(pid));if ax.0.is_null(){return Err("session_identity_unknown");}
        if reader.pid(ax.0)?!=pid{return Err("session_identity_unknown");}
        let names=reader.names(ax.0)?;if !names.contains("AXWindows"){return Err("session_inventory_unknown");}
        let windows=reader.elements(ax.0,"AXWindows")?;
        if result.roots.len()+windows.len()>MAX_ROOTS{return Err("session_inventory_limit");}
        let app_index=result.apps.len();result.apps.push(app.clone());
        for root in windows {request.alive()?;
            let names=reader.names(root.0)?;
            if reader.pid(root.0)?!=pid || !["AXRole","AXSubrole","AXParent"].iter().all(|name|names.contains(*name)){return Err("session_identity_unknown");}
            let role=reader.string(root.0,"AXRole")?;let sub=reader.string(root.0,"AXSubrole")?;
            if role!="AXWindow" || !["AXStandardWindow","AXDialog","AXSystemDialog","AXSheet","AXFloatingWindow"].contains(&sub.as_str()){return Err("session_identity_unknown");}
            let parent=reader.element(root.0,"AXParent")?;
            if CFEqual(parent.0 as CFTypeRef,ax.0 as CFTypeRef)==0{return Err("session_identity_unknown");}
            let id=reader.window_id(root.0)?;if id==0 || !ids.insert(id){return Err("session_inventory_unknown");}
            if result.roots.iter().any(|old|CFEqual(old.root.0 as CFTypeRef,root.0 as CFTypeRef)!=0){return Err("session_inventory_unknown");}
            result.roots.push(Root{app:app_index,pid,id,root});
        }
    }request.alive()?;Ok(result)
}
fn new_index(before:&[(i32,u32)],after:&[(i32,u32)],mut same:impl FnMut(usize,usize)->bool)->Result<usize,&'static str>{
    if before.len()>MAX_ROOTS || after.len()!=before.len()+1 || after.len()>MAX_ROOTS{return Err("session_new_window_ambiguous");}
    let mut ids=HashSet::new();if after.iter().any(|(pid,id)|*pid<=0 || *id==0 || !ids.insert(*id)){return Err("session_inventory_unknown");}
    for (i,key) in before.iter().enumerate(){let index=after.iter().position(|actual|actual==key).ok_or("session_baseline_changed")?;
        if !same(i,index){return Err("session_baseline_changed");}}
    let index=after.iter().position(|key|!before.contains(key)).ok_or("session_new_window_ambiguous")?;
    if before.iter().enumerate().any(|(i,_)|same(i,index)){return Err("session_baseline_changed");}Ok(index)
}
fn keys(catalog:&Catalog)->Vec<(i32,u32)>{catalog.roots.iter().map(|r|(r.pid,r.id)).collect()}
unsafe fn same_catalog(before:&Catalog,after:&Catalog)->bool{
    if before.apps.len()!=after.apps.len() || before.roots.len()!=after.roots.len(){return false;}
    if !before.apps.iter().all(|app|after.apps.iter().any(|other|!app.isTerminated() && !other.isTerminated()
        && app.processIdentifier()==other.processIdentifier() && running_application_equal(app,other))){return false;}
    before.roots.iter().all(|r|after.roots.iter().any(|other|r.pid==other.pid && r.id==other.id && CFEqual(r.root.0 as CFTypeRef,other.root.0 as CFTypeRef)!=0))
}
fn observation_child_classes(role:&str,subrole:Option<&str>)->(&'static str,&'static str){
    let role=match role{"AXColorWell"=>"color_well","AXComboBox"=>"combo_box","AXWindow"|"AXSheet"|"AXDialog"|"AXSystemDialog"|"AXMenu"|"AXPopover"=>"attached",
        other if child_kind(other,None).is_ok()=>"legacy_control",_=>"other"};
    let subrole=match subrole{None=>"absent",Some("AXUnknown"|"AXUnknownSubrole")=>"unknown",
        Some("AXDialog"|"AXSystemDialog"|"AXSheet"|"AXFloatingWindow"|"AXSystemFloatingWindow"|"AXPopover")=>"attached",Some(_)=>"other"};
    (role,subrole)
}
fn observation_child_kind(role:&str,subrole:Option<&str>)->Result<(),&'static str>{
    let (class,sub)=observation_child_classes(role,subrole);
    if class=="attached" || sub=="attached"{return Err("identity_attached_window");}
    if sub=="unknown"{return Err("session_child_role_unknown");}
    if matches!(class,"color_well"|"combo_box"){return Ok(());}
    child_kind(role,subrole).map_err(|reason|if reason=="identity_child_role_unknown"{"session_child_role_unknown"}else{reason})
}
fn observation_child_association(role:&str,subrole:Option<&str>,associate:impl FnOnce()->Result<bool,&'static str>)->Result<(),&'static str>{
    observation_child_kind(role,subrole)?;
    if associate()?{Ok(())}else{Err("bootstrap_parent_mismatch")}
}
fn record_child_failure(request:&Request,role:&str,subrole:Option<&str>){
    let mut first=request.child_diagnostic.borrow_mut();if first.is_none(){let (role,subrole)=observation_child_classes(role,subrole);
        *first=Some(json!({"phase":"target_relationships","role_class":role,"subrole_class":subrole}));}
}
unsafe fn observation_relationships(reader:&mut AxReader,window:AXUIElementRef,pid:i32,request:&Request)->Result<(),&'static str>{
    let names=reader.names(window)?;
    if !names.contains("AXChildren"){return Err("bootstrap_target_relationship_children_missing");}
    if names.contains("AXSheets"){empty_sheets(true,||Ok(reader.elements(window,"AXSheets")?.len()))?;}
    let children=reader.elements(window,"AXChildren")?;if children.len()>128{return Err("bootstrap_children_limit");}
    for child in children{let names=reader.names(child.0)?;let sub=if names.contains("AXSubrole"){Some(reader.string(child.0,"AXSubrole")?)}else{None};
        let role=reader.string(child.0,"AXRole")?;
        if observation_child_kind(&role,sub.as_deref()).is_err(){record_child_failure(request,&role,sub.as_deref());}
        observation_child_association(&role,sub.as_deref(),||{let parent=reader.element(child.0,"AXParent")?;
            Ok(reader.pid(child.0)?==pid && CFEqual(parent.0 as CFTypeRef,window as CFTypeRef)!=0)})?;
    }Ok(())
}
unsafe fn validate(candidate:&Candidate,request:&Request)->Result<(),&'static str>{
    request.alive()?;let app=&candidate.app;let Bound{pid,id,frame}=candidate.bound;
    if app.isTerminated() || app.processIdentifier()!=pid || app.isHidden(){return Err("session_identity_changed");}
    let mut reader=AxReader::guarded_identity_reader(Instant::now(),request.deadline,request.cancel.clone());
    let ax=OwnedAx(AXUIElementCreateApplication(pid));if ax.0.is_null(){return Err("session_identity_unknown");}
    let roots=reader.elements(ax.0,"AXWindows")?;
    if roots.len()>MAX_ROOTS{return Err("session_inventory_limit");}
    let mut ids=HashSet::new();for root in &roots{request.alive()?;
        let actual=reader.window_id(root.0)?;if reader.pid(root.0)?!=pid || actual==0 || !ids.insert(actual){return Err("session_inventory_unknown");}}
    let matches:Vec<_>=roots.iter().filter(|r|CFEqual(r.0 as CFTypeRef,candidate.root.0 as CFTypeRef)!=0).collect();
    if matches.len()!=1{return Err("session_identity_changed");}let root=candidate.root.0;
    if reader.pid(root)?!=pid || reader.window_id(root)?!=id{return Err("session_identity_changed");}
    let names=reader.names(root)?;
    if !["AXRole","AXSubrole","AXParent","AXMinimized","AXModal","AXChildren"].iter().all(|name|names.contains(*name)){return Err("session_relationship_unknown");}
    ordinary_root(&reader.string(root,"AXRole")?,Some(&reader.string(root,"AXSubrole")?))?;
    let parent=reader.element(root,"AXParent")?;
    if CFEqual(parent.0 as CFTypeRef,ax.0 as CFTypeRef)==0 || reader.boolean(root,"AXMinimized")? || reader.boolean(root,"AXModal")?{return Err("session_relationship_unknown");}
    if names.contains("AXHidden") && reader.boolean(root,"AXHidden")?{return Err("session_relationship_unknown");}
    let cg=cg_identity(pid,id)?;if cg.task_bounds()!=frame{return Err("session_geometry_changed");}
    observation_relationships(&mut reader,root,pid,request)?;request.alive()?;Ok(())
}
impl Backend for Native {
    type Baseline=Catalog;type Candidate=Candidate;
    fn prepare(&mut self,r:&Request)->Result<Catalog,&'static str>{unsafe{let first=catalog(r)?;let second=catalog(r)?;
        if !same_catalog(&first,&second){return Err("session_baseline_changed");}Ok(first)}}
    fn open(&mut self,before:Catalog,r:&Request)->Result<Candidate,&'static str>{unsafe{
        let first=catalog(r)?;let mut second=catalog(r)?;
        if !same_catalog(&first,&second){return Err("session_baseline_changed");}
        if before.apps.len()!=second.apps.len() || !before.apps.iter().all(|app|second.apps.iter().any(|other|!app.isTerminated() && !other.isTerminated()
            && app.processIdentifier()==other.processIdentifier() && running_application_equal(app,other))){return Err("session_baseline_changed");}
        let index=new_index(&keys(&before),&keys(&second),|i,j|CFEqual(before.roots[i].root.0 as CFTypeRef,second.roots[j].root.0 as CFTypeRef)!=0)?;
        let root=second.roots.remove(index);let cg=cg_identity(root.pid,root.id)?;
        let candidate=Candidate{app:second.apps[root.app].clone(),root:root.root,bound:Bound{pid:root.pid,id:root.id,frame:cg.task_bounds()}};
        validate(&candidate,r)?;Ok(candidate)
    }}
    fn observe(&mut self,c:&Candidate,r:&Request)->Result<Captured,&'static str>{
        controlled_window_capture::capture(c.bound,||r.alive(),||unsafe{validate(c,r)})
    }
}
fn worker<B:Backend>(receiver:mpsc::Receiver<Request>,client:Arc<Control>,stop:Arc<AtomicBool>,mut backend:B){
    let mut baseline:Option<(B::Baseline,Instant,String)>=None;let mut session:Option<(B::Candidate,Instant,String,u64)>=None;
    let mut prepared=false;let mut opened=false;let mut seen=HashSet::new();
    loop {
        if stop.load(Ordering::SeqCst) || client.revoked.load(Ordering::SeqCst){baseline=None;session=None;
            if let Ok(mut meta)=client.meta.lock(){meta.terminal=true;}if stop.load(Ordering::SeqCst){break;}}
        let r=match receiver.recv_timeout(Duration::from_millis(50)){Ok(r)=>r,Err(mpsc::RecvTimeoutError::Timeout)=>{
            if baseline.as_ref().is_some_and(|v|Instant::now()>=v.1) || session.as_ref().is_some_and(|v|Instant::now()>=v.1){if let Ok(meta)=client.meta.lock(){client.revoked.store(true,Ordering::SeqCst);if let Some(cancel)=&meta.active_cancel{cancel.store(true,Ordering::SeqCst);}}}continue;},Err(_)=>break};
        let answer=(||->Result<ToolResult,&'static str>{r.alive()?;if seen.len()>=4{return Err("session_request_limit");}if !seen.insert(r.nonce.clone()){return Err("session_nonce_consumed");}
            match r.op {
                Op::Prepare=>{if prepared{return Err("session_prepare_consumed");}prepared=true;
                    let value=backend.prepare(&r)?;r.alive()?;let reference=uuid::Uuid::new_v4().to_string();
                    baseline=Some((value,Instant::now()+ADMISSION_TTL,reference.clone()));
                    let mut meta=client.meta.lock().map_err(|_|"session_state_unavailable")?;meta.reference=Some(reference.clone());meta.nonce=Some(r.nonce.clone());meta.expires=baseline.as_ref().map(|v|v.1);
                    let mut value=descriptor("prepared_baseline",&r.nonce);value["session_ref"]=json!(reference);value["ttl_ms"]=json!(30000);
                    value["gui_new_provenance_required"]=json!(true);Ok(ToolResult::text("Baseline retained; trusted task must perform its separately authorized GUI New before open.").with_structured(value))}
                Op::Open=>{if opened{return Err("session_open_consumed");}opened=true;
                    let (before,expires,reference)=baseline.take().ok_or("session_baseline_unavailable")?;
                    if r.reference.as_ref()!=Some(&reference) || Instant::now()>=expires{return Err("session_ref_invalid");}
                    let candidate=backend.open(before,&r)?;r.alive()?;
                    if Instant::now()>=expires{return Err("session_ref_expired");}
                    let session_ref=uuid::Uuid::new_v4().to_string();session=Some((candidate,Instant::now()+SESSION_TTL,session_ref.clone(),0));
                    {let mut meta=client.meta.lock().map_err(|_|"session_state_unavailable")?;meta.reference=Some(session_ref.clone());meta.expires=session.as_ref().map(|v|v.1);}
                    let mut value=descriptor("open",&r.nonce);value["session_ref"]=json!(session_ref);value["ttl_ms"]=json!(60000);value["generation"]=json!(1);
                    value["identity_evidence"]=json!("bounded_new_window");value["creation_receipt_verified"]=json!(false);
                    Ok(ToolResult::text("Unique bounded new window retained for observation only; not an empty-document or input grant.").with_structured(value))}
                Op::Observe=>{let (candidate,expires,reference,frame_epoch)=session.as_mut().ok_or("session_not_open")?;
                    if r.reference.as_ref()!=Some(reference) || Instant::now()>=*expires{return Err("session_ref_expired");}
                    if *frame_epoch>=2{return Err("session_observation_limit");}
                    let captured=backend.observe(candidate,&r)?;r.alive()?;
                    if Instant::now()>=*expires{return Err("session_ref_expired");}*frame_epoch+=1;
                    let mut value=descriptor("observed",&r.nonce);value["session_ref"]=json!(reference);value["generation"]=json!(1);value["frame_epoch"]=json!(*frame_epoch);value["viewport"]=captured.viewport;
                    Ok(ToolResult{content:vec![Content::image_png(STANDARD.encode(captured.png))],structured_content:Some(value),..Default::default()})}
                Op::Close=>Err("session_arguments_invalid")
            }
        })();
        let failed=answer.is_err();let result=match answer{Ok(v)=>v,Err(e)=>{baseline=None;session=None;let mut result=failure(e,&r.nonce);
            if let Some(diagnostic)=r.child_diagnostic.borrow().as_ref(){if let Some(value)=result.structured_content.as_mut(){value["child_diagnostic"]=diagnostic.clone();}}result}};
        // The slot releases only after all synchronous native work and local
        // retained objects of that operation have actually reached a terminal.
        // Same publication lock as Close. No capture/query runs under it.
        let delivered=if let Ok(meta)=client.meta.lock(){
            client.busy.store(false,Ordering::SeqCst);
            let eligible=if failed{r.can_reply()}else{r.alive().is_ok()};
            if failed{client.revoked.store(true,Ordering::SeqCst);if let Some(cancel)=&meta.active_cancel{cancel.store(true,Ordering::SeqCst);}}
            if eligible{let _=r.reply.send(result);true}else{false}
        }else{false};
        if !delivered{baseline=None;session=None;client.revoke();}
        if client.revoked.load(Ordering::SeqCst){baseline=None;session=None;if let Ok(mut meta)=client.meta.lock(){meta.terminal=true;}}
    }
}
pub struct Publication(Arc<Control>);
impl Publication {
    pub fn revoke(&self){self.0.revoke();}
    /// Final receipt publication shares the same linearization lock as every
    /// revocation. A privately written but uncommitted file is never advertised.
    pub fn emit(&self,reference:&str,epoch:u64,emit:impl FnOnce()->Result<(),&'static str>)->Result<(),&'static str>{
        let meta=self.0.meta.lock().map_err(|_|"session_state_unavailable")?;
        if self.0.revoked.load(Ordering::SeqCst) || meta.terminal || meta.reference.as_deref()!=Some(reference)
            || meta.expires.is_none_or(|expires|Instant::now()>=expires) || meta.published!=epoch{return Err("session_publication_revoked");}
        emit()
    }
    pub fn terminal(&self)->bool{self.0.meta.lock().is_ok_and(|meta|meta.terminal && !self.0.busy.load(Ordering::SeqCst))}
    /// Linearizes actual file publication against revoke. Caller supplies only
    /// its trusted private-root write, never a public arbitrary output path.
    pub fn publish(&self,reference:&str,epoch:u64,write:impl FnOnce()->Result<(),&'static str>)->Result<(),&'static str>{
        let mut meta=self.0.meta.lock().map_err(|_|"session_state_unavailable")?;
        if self.0.revoked.load(Ordering::SeqCst) || meta.terminal || meta.reference.as_deref()!=Some(reference)
            || meta.expires.is_none_or(|expires|Instant::now()>=expires) || epoch!=meta.published+1 || epoch>2{return Err("session_publication_revoked");}
        match write(){Ok(())=>{if self.0.revoked.load(Ordering::SeqCst) || meta.expires.is_none_or(|expires|Instant::now()>=expires){self.0.revoked.store(true,Ordering::SeqCst);return Err("session_publication_revoked");}meta.published=epoch;Ok(())},Err(e)=>{self.0.revoked.store(true,Ordering::SeqCst);if let Some(cancel)=&meta.active_cancel{cancel.store(true,Ordering::SeqCst);}Err(e)}}
    }
}
fn register_backend<B:Backend+Send+'static>(registry:&mut ToolRegistry,backend:B)->Publication{
    let (queue,receiver)=mpsc::sync_channel(1);let control=Arc::new(Control::new());let stop=Arc::new(AtomicBool::new(false));
    let client=Arc::new(Client{queue,control:control.clone(),stop:stop.clone()});
    thread::spawn(move||worker(receiver,control,stop,backend));
    for op in [Op::Prepare,Op::Open,Op::Observe,Op::Close]{registry.register(Box::new(SessionTool{op,def:definition(op),client:client.clone()}));}
    Publication(client.control.clone())
}
pub fn register(registry:&mut ToolRegistry)->Publication{register_backend(registry,Native)}

#[cfg(test)]mod tests{
    use super::*;
    use std::sync::atomic::AtomicUsize;
    #[test]fn session_observation_controls_keep_parent_pid_and_attached_unknown_gates(){
        for role in ["AXColorWell","AXComboBox","AXTextArea","AXButton"]{
            let calls=std::cell::Cell::new(0);assert!(observation_child_association(role,None,||{calls.set(calls.get()+1);Ok(true)}).is_ok());assert_eq!(calls.get(),1);
            assert_eq!(observation_child_association(role,None,||Ok(false)),Err("bootstrap_parent_mismatch"));
            assert_eq!(observation_child_association(role,None,||Err("ax_query_error")),Err("ax_query_error"));
            for sub in ["AXUnknown","AXUnknownSubrole"]{assert_eq!(observation_child_association(role,Some(sub),||panic!("unknown must stop association query")),Err("session_child_role_unknown"));}
            for sub in ["AXSheet","AXDialog","AXSystemDialog","AXFloatingWindow","AXSystemFloatingWindow","AXPopover"]{assert_eq!(observation_child_association(role,Some(sub),||panic!("attached must stop association query")),Err("identity_attached_window"));}
        }
        for role in ["AXWindow","AXSheet","AXDialog","AXSystemDialog","AXMenu","AXPopover"]{assert_eq!(observation_child_association(role,None,||panic!("attached role")),Err("identity_attached_window"));}
        assert_eq!(observation_child_association("unrecognized",None,||panic!("unknown role")),Err("session_child_role_unknown"));
        // The old shared classifier remains strict and is not reused as an
        // expanded legacy identity/taskproof/input admission contract.
        assert_eq!(child_kind("AXColorWell",None),Err("identity_child_role_unknown"));assert_eq!(child_kind("AXComboBox",None),Err("identity_child_role_unknown"));
    }
    #[test]fn session_child_diagnostic_is_first_closed_and_request_local(){
        let control=Arc::new(Control::new());let (reply,_receiver)=tokio::sync::oneshot::channel();
        let request=Request{op:Op::Open,nonce:uuid::Uuid::new_v4().to_string(),reference:None,deadline:Instant::now()+REQUEST,cancel:Arc::new(AtomicBool::new(false)),reply,control:control.clone(),child_diagnostic:RefCell::new(None)};
        record_child_failure(&request,"AXColorWell",Some("AXUnknown"));record_child_failure(&request,"private-role",Some("private-subrole"));
        assert_eq!(*request.child_diagnostic.borrow(),Some(json!({"phase":"target_relationships","role_class":"color_well","subrole_class":"unknown"})));
        let (reply,_receiver)=tokio::sync::oneshot::channel();let next=Request{op:Op::Open,nonce:uuid::Uuid::new_v4().to_string(),reference:None,deadline:Instant::now()+REQUEST,cancel:Arc::new(AtomicBool::new(false)),reply,control,child_diagnostic:RefCell::new(None)};
        assert!(next.child_diagnostic.borrow().is_none());record_child_failure(&next,"private-role",Some("private-subrole"));assert!(!next.child_diagnostic.borrow().as_ref().unwrap().to_string().contains("private"));
    }
    #[test]fn session_publication_revoke_and_final_output_share_one_linearization_lock(){
        let control=Arc::new(Control::new());let reference=uuid::Uuid::new_v4().to_string();
        {let mut meta=control.meta.lock().unwrap();meta.reference=Some(reference.clone());meta.expires=Some(Instant::now()+SESSION_TTL);}
        let publication=Publication(control.clone());publication.publish(&reference,1,||Ok(())).unwrap();
        let (entered,entry)=mpsc::channel();let (release,wait)=mpsc::channel();let p=Publication(control.clone());let r=reference.clone();
        let emit=thread::spawn(move||p.emit(&r,1,||{entered.send(()).unwrap();wait.recv().unwrap();Ok(())}));entry.recv().unwrap();
        let (done,revoked)=mpsc::channel();let c=control.clone();let revoke=thread::spawn(move||{c.revoke();done.send(()).unwrap();});
        assert!(revoked.try_recv().is_err());release.send(()).unwrap();assert!(emit.join().unwrap().is_ok());revoked.recv().unwrap();revoke.join().unwrap();
        assert!(publication.emit(&reference,1,||panic!("after revoke output")).is_err());
        assert!(publication.publish(&reference,2,||panic!("after revoke file")).is_err());
    }
    #[test]fn session_publication_expiry_and_cancel_drop_do_not_publish_or_revoke_normal_reply(){
        let control=Arc::new(Control::new());let reference=uuid::Uuid::new_v4().to_string();let publication=Publication(control.clone());
        {let mut meta=control.meta.lock().unwrap();meta.reference=Some(reference.clone());meta.expires=Some(Instant::now()+SESSION_TTL);}
        let cancel=Arc::new(AtomicBool::new(false));drop(Cancel{cancel:cancel.clone(),control:control.clone(),armed:false});assert!(!control.revoked.load(Ordering::SeqCst));assert!(!cancel.load(Ordering::SeqCst));
        assert!(publication.publish(&reference,1,||Ok(())).is_ok());
        control.meta.lock().unwrap().expires=Some(Instant::now());assert!(publication.emit(&reference,1,||panic!("expired output")).is_err());
        drop(Cancel{cancel:cancel.clone(),control:control.clone(),armed:true});assert!(control.revoked.load(Ordering::SeqCst));assert!(cancel.load(Ordering::SeqCst));
    }
    fn context(source:&str)->Arc<cua_driver_core::session_authorization::EffectiveAuthorizationContext>{
        use std::io::Write;
        use cua_driver_core::{authorization::PermissionMode,session_authorization::{SessionModeCeiling,SessionAuthorizationRegistry}};
        let path=std::env::temp_dir().join(format!("cua-window-session-{}.yaml",uuid::Uuid::new_v4()));
        let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(&path).unwrap();file.write_all(source.as_bytes()).unwrap();drop(file);
        let manifest=Arc::new(cua_driver_core::session_manifest::load_manifest(&path).expect("valid session manifest"));std::fs::remove_file(path).unwrap();
        let ceiling=SessionModeCeiling::for_trusted_sessions([PermissionMode::Standard],false,Duration::from_secs(120),Duration::from_secs(60)).unwrap();
        SessionAuthorizationRegistry::with_ceiling(ceiling).compatibility_context(PermissionMode::Standard,Some(manifest)).unwrap()
    }
    fn allow()->String{format!("version: 3\nallow:\n  tools: [{PREPARE}, {OPEN}, {OBSERVE}, {CLOSE}]\nresources:\n  textedit_new_window_observation: true\n  textedit_new_window_pixels: true\n")}
    fn args(op:Op,reference:Option<&str>)->Value{let nonce=uuid::Uuid::new_v4().to_string();if op==Op::Prepare{json!({"bundle_id":BUNDLE,"request_nonce":nonce})}else{json!({"session_ref":reference.unwrap(),"request_nonce":nonce})}}
    struct Held(Arc<AtomicUsize>);impl Drop for Held{fn drop(&mut self){self.0.fetch_add(1,Ordering::SeqCst);}}
    struct Fake {calls:Arc<AtomicUsize>,drops:Arc<AtomicUsize>,failure:bool,block:Option<Arc<(Mutex<(bool,bool)>,std::sync::Condvar)>>}
    impl Backend for Fake{
        type Baseline=usize;type Candidate=Held;
        fn prepare(&mut self,_:&Request)->Result<usize,&'static str>{self.calls.fetch_add(1,Ordering::SeqCst);if self.failure{Err("session_baseline_changed")}else{Ok(1)}}
        fn open(&mut self,b:usize,_:&Request)->Result<Held,&'static str>{assert_eq!(b,1);self.calls.fetch_add(1,Ordering::SeqCst);Ok(Held(self.drops.clone()))}
        fn observe(&mut self,_:&Held,r:&Request)->Result<Captured,&'static str>{self.calls.fetch_add(1,Ordering::SeqCst);
            if let Some(block)=&self.block{let (lock,cv)=&**block;let mut state=lock.lock().unwrap();state.0=true;cv.notify_all();while !state.1{state=cv.wait(state).unwrap();}}
            r.alive()?;Ok(Captured{png:vec![1,2,3],viewport:json!({})})}
    }
    #[test]fn session_new_window_delta_preserves_every_old_object_and_id(){
        let before=[(1,7),(2,8)];let after=[(2,8),(1,7),(1,9)];
        assert_eq!(new_index(&before,&after,|i,j|before[i]==after[j]),Ok(2));
        assert!(new_index(&before,&after,|_,_|false).is_err());
        assert!(new_index(&before,&[(1,7),(2,8),(1,7)],|_,_|true).is_err());
        assert!(new_index(&before,&[(1,7),(2,8),(1,9),(1,10)],|_,_|true).is_err());
        assert!(new_index(&before,&[(1,7),(2,8),(1,9)],|i,j|j==2 || before[i]==after[j]).is_err());
    }
    #[test]fn session_parameters_reject_old_title_pid_and_self_claimed_creation(){
        assert!(arguments(&args(Op::Prepare,None),Op::Prepare).is_ok());
        for key in ["pid","window_id","document_title","created","_session_id"]{let mut value=args(Op::Prepare,None);value[key]=json!(true);assert!(arguments(&value,Op::Prepare).is_err());}
        assert!(arguments(&json!({"bundle_id":"other","request_nonce":uuid::Uuid::new_v4().to_string()}),Op::Prepare).is_err());
    }
    #[tokio::test]async fn session_real_tools_canonical_allow_reaches_prepare_open_two_frames_and_close(){
        let calls=Arc::new(AtomicUsize::new(0));let drops=Arc::new(AtomicUsize::new(0));let mut registry=ToolRegistry::new();
        let publication=register_backend(&mut registry,Fake{calls:calls.clone(),drops:drops.clone(),failure:false,block:None});let ctx=context(&allow());
        let prepared=registry.invoke_with_context(PREPARE,args(Op::Prepare,None),ctx.clone()).await;assert_ne!(prepared.is_error,Some(true));
        let reference=prepared.structured_content.unwrap()["session_ref"].as_str().unwrap().to_owned();
        let opened=registry.invoke_with_context(OPEN,args(Op::Open,Some(&reference)),ctx.clone()).await;assert_ne!(opened.is_error,Some(true));
        let reference=opened.structured_content.unwrap()["session_ref"].as_str().unwrap().to_owned();
        for epoch in [1,2]{let result=registry.invoke_with_context(OBSERVE,args(Op::Observe,Some(&reference)),ctx.clone()).await;
            assert_ne!(result.is_error,Some(true));assert_eq!(result.structured_content.unwrap()["frame_epoch"],epoch);assert_eq!(result.content.len(),1);}
        let closed=registry.invoke_with_context(CLOSE,args(Op::Close,Some(&reference)),ctx).await;assert_eq!(closed.structured_content.unwrap()["status"],"closing");
        while !publication.terminal(){tokio::task::yield_now().await;}
        assert_eq!(calls.load(Ordering::SeqCst),4);assert_eq!(drops.load(Ordering::SeqCst),1);
        assert!(publication.publish(&reference,1,||panic!("revoked publication")).is_err());
    }
    #[tokio::test]async fn session_canonical_missing_pixels_read_denied_and_bad_nonce_never_call_backend(){
        for source in [allow().replace("textedit_new_window_pixels: true","textedit_new_window_pixels: false"),
            format!("version: 3\nallow:\n  tools: [{OBSERVE}]\ndeny:\n  tools: [{PREPARE}]\nresources:\n  textedit_new_window_observation: true\n  textedit_new_window_pixels: true\n")]{
            let calls=Arc::new(AtomicUsize::new(0));let mut registry=ToolRegistry::new();let publication=register_backend(&mut registry,Fake{calls:calls.clone(),drops:Arc::new(AtomicUsize::new(0)),failure:false,block:None});
            let ctx=context(&source);let result=registry.invoke_with_context(OBSERVE,args(Op::Observe,Some(&uuid::Uuid::new_v4().to_string())),ctx.clone()).await;
            assert_eq!(result.is_error,Some(true));assert_eq!(calls.load(Ordering::SeqCst),0);
            let mut bad=args(Op::Prepare,None);bad["request_nonce"]=json!("bad");assert_eq!(registry.invoke_with_context(PREPARE,bad,ctx).await.is_error,Some(true));
            publication.revoke();while !publication.terminal(){tokio::task::yield_now().await;}
        }
    }
    #[tokio::test]async fn session_worker_fixed_failure_is_delivered_not_swallowed_as_timeout(){
        let mut registry=ToolRegistry::new();let publication=register_backend(&mut registry,Fake{calls:Arc::new(AtomicUsize::new(0)),drops:Arc::new(AtomicUsize::new(0)),failure:true,block:None});
        let result=registry.invoke_with_context(PREPARE,args(Op::Prepare,None),context(&allow())).await;
        assert_eq!(result.is_error,Some(true));assert_eq!(result.structured_content.unwrap()["reason_code"],"session_baseline_changed");
        while !publication.terminal(){tokio::task::yield_now().await;}
    }
    #[tokio::test]async fn session_close_during_real_worker_block_holds_object_and_discards_late_pixels(){
        let block=Arc::new((Mutex::new((false,false)),std::sync::Condvar::new()));let drops=Arc::new(AtomicUsize::new(0));let mut registry=ToolRegistry::new();
        let publication=register_backend(&mut registry,Fake{calls:Arc::new(AtomicUsize::new(0)),drops:drops.clone(),failure:false,block:Some(block.clone())});
        let registry=Arc::new(registry);let ctx=context(&allow());let prepared=registry.invoke_with_context(PREPARE,args(Op::Prepare,None),ctx.clone()).await;
        let reference=prepared.structured_content.unwrap()["session_ref"].as_str().unwrap().to_owned();let opened=registry.invoke_with_context(OPEN,args(Op::Open,Some(&reference)),ctx.clone()).await;
        let reference=opened.structured_content.unwrap()["session_ref"].as_str().unwrap().to_owned();let r=registry.clone();let c=ctx.clone();let a=args(Op::Observe,Some(&reference));
        let work=tokio::spawn(async move{r.invoke_with_context(OBSERVE,a,c).await});
        while !block.0.lock().unwrap().0{tokio::task::yield_now().await;}
        let close=registry.invoke_with_context(CLOSE,args(Op::Close,Some(&reference)),ctx.clone()).await;assert_eq!(close.structured_content.unwrap()["status"],"closing");
        assert!(!publication.terminal());assert_eq!(drops.load(Ordering::SeqCst),0);
        assert_eq!(registry.invoke_with_context(OBSERVE,args(Op::Observe,Some(&reference)),ctx).await.is_error,Some(true));
        {let mut state=block.0.lock().unwrap();state.1=true;block.1.notify_all();}
        let result=work.await.unwrap();assert_eq!(result.is_error,Some(true));assert!(result.content.iter().all(|c|!matches!(c,Content::Image{..})));
        while !publication.terminal(){tokio::task::yield_now().await;}assert_eq!(drops.load(Ordering::SeqCst),1);
    }
}
