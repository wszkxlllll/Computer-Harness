//! Finite controlled-document bootstrap. All retained ObjC/AX objects are
//! created, checked and released on one private worker; no unsafe Send impl.
//! Title reads are a NEW task-specific permission, never existing identity grants.
use std::{collections::HashSet,sync::{Arc,OnceLock,atomic::{AtomicBool,Ordering},mpsc},thread,time::{Duration,Instant}};
use async_trait::async_trait;
use core_foundation::base::{CFEqual,CFTypeRef};
use objc2::rc::Retained;
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::NSString;
use serde_json::{json,Value};
use cua_driver_core::{protocol::ToolResult,tool::{Tool,ToolDef,ToolRegistry}};
use crate::ax::bindings::*;
use super::{get_target_window_topology::{AxReader,OwnedAx,ordinary_root,BootstrapAxScope},
    discover_textedit_window_identity::{cg_identity_for,CgPurpose,empty_sheets,child_kind,CgIdentity,running_application_equal},
    discover_user_selected_textedit_window_identity::cg_order};
pub const DISCOVER:&str="discover_controlled_textedit_window";
pub const ACTIVATE:&str="activate_controlled_textedit_window";
pub const BUNDLE:&str="com.apple.TextEdit";
pub const TITLE:&str="未命名2.txt";
const TTL:Duration=Duration::from_secs(15);
const REQUEST_TIME:Duration=Duration::from_secs(8);
const MAX_APPS:usize=32;
const MAX_WINDOWS:usize=128;
static READ_DEF:OnceLock<ToolDef>=OnceLock::new();
static WRITE_DEF:OnceLock<ToolDef>=OnceLock::new();

struct Command {activate:bool,nonce:String,reference:Option<String>,deadline:Instant,task_proof:bool,
    cancelled:Arc<AtomicBool>,started:Arc<AtomicBool>,reply:tokio::sync::oneshot::Sender<ToolResult>,cg_diagnostic:std::cell::RefCell<Option<Value>>,comparison_diagnostic:std::cell::RefCell<Option<Value>>,activation_diagnostic:std::cell::RefCell<Option<Value>>,intersection_diagnostic:std::cell::RefCell<Option<Value>>}
impl Command {
    fn alive(&self)->Result<(),&'static str> {
        if self.cancelled.load(Ordering::SeqCst) || self.reply.is_closed() || Instant::now()>=self.deadline {
            Err("bootstrap_request_expired")
        }else{Ok(())}
    }
}
struct Client {queue:mpsc::SyncSender<Command>,stop:Arc<AtomicBool>}
impl Drop for Client {fn drop(&mut self){self.stop.store(true,Ordering::SeqCst);}}
struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {fn drop(&mut self){self.0.store(true,Ordering::SeqCst);}}
struct BootstrapTool {client:Arc<Client>,activate:bool,task_proof:bool}
struct Candidate {app:Retained<NSRunningApplication>,root:OwnedAx,pid:i32,id:u32,cg:CgIdentity}
struct Lease<C> {candidate:C,nonce:String,reference:String,expires:Instant,activated:bool,proof_consumed:bool}
trait Backend {
    type Candidate;
    fn trusted(&mut self)->bool;
    fn discover(&mut self,command:&Command)->Result<Self::Candidate,&'static str>;
    fn same(&self,before:&Self::Candidate,after:&Self::Candidate)->bool;
    fn comparison_failure(&self,before:&Self::Candidate,after:&Self::Candidate)->Option<&'static str> {
        if self.same(before,after){None}else{Some("unclassified")}
    }
    fn identity(&self,candidate:&Self::Candidate)->(i32,u32);
    fn activate(&mut self,candidate:&Self::Candidate,command:&Command)->Result<(),&'static str>;
    fn foreground(&mut self,candidate:&Self::Candidate,command:&Command)->Result<(),&'static str>;
    fn task_proof(&mut self,_candidate:&Self::Candidate,_command:&Command)->Result<Value,&'static str>{Err("task_proof_unavailable")}
}
struct Native;
impl Backend for Native {
    type Candidate=Candidate;
    fn trusted(&mut self)->bool {crate::permissions::status::accessibility_granted()}
    fn discover(&mut self,command:&Command)->Result<Candidate,&'static str>{unsafe{discover(command)}}
    fn same(&self,before:&Candidate,after:&Candidate)->bool{same(before,after)}
    fn comparison_failure(&self,before:&Candidate,after:&Candidate)->Option<&'static str>{native_comparison_failure(before,after)}
    fn identity(&self,candidate:&Candidate)->(i32,u32){(candidate.pid,candidate.id)}
    fn activate(&mut self,candidate:&Candidate,command:&Command)->Result<(),&'static str>{unsafe{activate(candidate,command)}}
    fn foreground(&mut self,candidate:&Candidate,command:&Command)->Result<(),&'static str>{unsafe{foreground(candidate,command)}}
    fn task_proof(&mut self,candidate:&Candidate,command:&Command)->Result<Value,&'static str>{unsafe{
        let mut reader=AxReader::bootstrap_reader(Instant::now(),command.deadline,command.cancelled.clone());
        let _focused=focused_exact_target(&mut reader,candidate,command)?;
        let value=super::get_target_window_topology::task_sample(candidate.pid,candidate.id,candidate.root.0,candidate.cg.task_bounds(),
            &command.nonce,command.deadline,command.cancelled.clone(),||command.alive(),|value|{
                let mut slot=command.intersection_diagnostic.borrow_mut();if slot.is_none(){*slot=Some(value);}
            })?;
        foreground(candidate,command)?;Ok(value)
    }}
}

fn public_args(args:&Value,activate:bool)->Result<(String,Option<String>),&'static str> {
    let object=args.as_object().ok_or("bootstrap_arguments_invalid")?;
    let allowed=if activate {vec!["request_nonce","candidate_ref"]} else {vec!["bundle_id","document_title","request_nonce"]};
    let finalize=!activate && object.contains_key("candidate_ref");
    if object.len()!=allowed.len()+usize::from(finalize) || !object.keys().all(|key|allowed.contains(&key.as_str()) || (finalize && key=="candidate_ref")) {
        return Err("bootstrap_arguments_invalid");
    }
    if !activate && (args["bundle_id"]!=BUNDLE || args["document_title"]!=TITLE) {return Err("bootstrap_task_not_authorized");}
    let nonce=uuid::Uuid::parse_str(args["request_nonce"].as_str().ok_or("bootstrap_nonce_invalid")?)
        .map_err(|_|"bootstrap_nonce_invalid")?.to_string();
    let reference=if activate || finalize {Some(uuid::Uuid::parse_str(args["candidate_ref"].as_str().ok_or("bootstrap_ref_invalid")?)
        .map_err(|_|"bootstrap_ref_invalid")?.to_string())}else{None};
    Ok((nonce,reference))
}
fn result(reason:&'static str,started:bool)->ToolResult {
    ToolResult::error("Controlled TextEdit bootstrap not verified; do not replay activation.").with_structured(json!({
        "schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
        "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"unknown","reason_code":reason,
        "activation_started":started,"input_authorized":false}))
}
#[async_trait]
impl Tool for BootstrapTool {
    fn def(&self)->&ToolDef {
        if self.task_proof {static DEF:OnceLock<ToolDef>=OnceLock::new();return DEF.get_or_init(||ToolDef{
            name:super::get_target_window_topology::TASK_PROOF.into(),description:"Opt-in task-only proof bound to the actor's spent retained controlled document lease. No capture or input grant.".into(),
            input_schema:json!({"type":"object","required":["request_nonce","candidate_ref"],"properties":{
                "request_nonce":{"type":"string","format":"uuid"},"candidate_ref":{"type":"string","format":"uuid"}},"additionalProperties":false}),
            read_only:true,destructive:false,idempotent:false,open_world:false});}
        let activate=self.activate;
        (if activate {&WRITE_DEF}else{&READ_DEF}).get_or_init(||ToolDef {
            name:if activate {ACTIVATE}else{DISCOVER}.into(),
            description:if activate {"Single exact activation of a retained controlled TextEdit candidate. Steals foreground; no typing or subsequent input grant."}
                else {"Task-authorized fixed TextEdit AXTitle comparison for the controlled document only; other titles never returned. No activation."}.into(),
            input_schema:if activate {json!({"type":"object","required":["request_nonce","candidate_ref"],"properties":{
                "request_nonce":{"type":"string","format":"uuid"},"candidate_ref":{"type":"string","format":"uuid"}},"additionalProperties":false})}
                else{json!({"type":"object","required":["bundle_id","document_title","request_nonce"],"properties":{
                    "bundle_id":{"type":"string","const":BUNDLE},"document_title":{"type":"string","const":TITLE},
                    "request_nonce":{"type":"string","format":"uuid"},"candidate_ref":{"type":"string","format":"uuid"}},"additionalProperties":false})},
            read_only:!activate,destructive:false,idempotent:false,open_world:false})
    }
    async fn invoke(&self,mut args:Value)->ToolResult {
        cua_driver_core::tool_args::sanitize_reserved_args(&mut args);
        let (nonce,reference)=match public_args(&args,self.activate || self.task_proof){Ok(value)=>value,Err(reason)=>return result(reason,false)};
        let (reply,receiver)=tokio::sync::oneshot::channel();
        let cancelled=Arc::new(AtomicBool::new(false));let _cancel=Cancel(cancelled.clone());
        let started=Arc::new(AtomicBool::new(false));
        let command=Command {activate:self.activate,task_proof:self.task_proof,nonce,reference,deadline:Instant::now()+REQUEST_TIME,cancelled,started:started.clone(),reply,cg_diagnostic:std::cell::RefCell::new(None),comparison_diagnostic:std::cell::RefCell::new(None),activation_diagnostic:std::cell::RefCell::new(None),intersection_diagnostic:std::cell::RefCell::new(None)};
        if self.client.queue.try_send(command).is_err(){return result("bootstrap_worker_unavailable",false);}
        match tokio::time::timeout(REQUEST_TIME,receiver).await {
            Ok(Ok(value))=>value,
            // A write already underway cannot be hard-cancelled by this timeout.
            _=>{
                let mut value=result("bootstrap_worker_outcome_unknown",started.load(Ordering::SeqCst));
                if let Some(evidence)=value.structured_content.as_mut(){evidence["activation_may_have_started"]=json!(self.activate);}
                value
            },
        }
    }
}
pub fn register(registry:&mut ToolRegistry) {
    register_mode(registry,false);
}
pub fn register_task_target(registry:&mut ToolRegistry){register_mode(registry,true);}
fn register_mode(registry:&mut ToolRegistry,task:bool) {
    let (queue,receiver)=mpsc::sync_channel::<Command>(1);
    let stop=Arc::new(AtomicBool::new(false));let worker_stop=stop.clone();
    // Constructing the worker performs no OS query. Canonical policy executes
    // before command dispatch; only plain messages cross this thread boundary.
    thread::spawn(move||worker(receiver,worker_stop,Native));
    let client=Arc::new(Client {queue,stop});
    registry.register(Box::new(BootstrapTool {client:client.clone(),activate:false,task_proof:false}));
    if task {registry.register(Box::new(BootstrapTool {client:client.clone(),activate:false,task_proof:true}));
        registry.register(Box::new(super::get_target_window_topology::ControlledTaskCapabilitiesTool));}
    registry.register(Box::new(BootstrapTool {client,activate:true,task_proof:false}));
}
fn bounds(apps:usize,per_app:usize,total:usize)->Result<(),&'static str> {
    if apps==0 || apps>MAX_APPS || per_app>64 || total>MAX_WINDOWS {Err("bootstrap_enumeration_limit")}else{Ok(())}
}
fn unique(matches:usize)->Result<(),&'static str> {
    match matches {1=>Ok(()),0=>Err("bootstrap_document_not_found"),_=>Err("bootstrap_document_ambiguous")}
}
unsafe fn root(reader:&mut AxReader,app:AXUIElementRef,window:AXUIElementRef,pid:i32)->Result<(),&'static str> {
    reader.bootstrap_phase("target_ready");
    let names=reader.names(window)?;
    root_fields(true,||Ok(reader.pid(window)?==pid),|key|names.contains(key))?;
    matched_target_kind(&reader.string(window,"AXRole")?,&reader.string(window,"AXSubrole")?)?;
    if reader.boolean(window,"AXMinimized")? || reader.boolean(window,"AXModal")?
        || (names.contains("AXHidden") && reader.boolean(window,"AXHidden")?) {return Err("bootstrap_root_not_ready");}
    let parent=reader.element(window,"AXParent")?;
    if CFEqual(parent.0 as CFTypeRef,app as CFTypeRef)==0 {return Err("bootstrap_parent_mismatch");}
    root_relationships(reader,window,pid,RelationshipMode::MatchedOrdinary)
}
#[derive(Clone,Copy)]pub(super) enum RelationshipMode {MatchedOrdinary,ExcludedDialog}
fn relationship_edges(mode:RelationshipMode,sheets_advertised:bool,children_advertised:bool,read_sheets:impl FnOnce()->Result<usize,&'static str>)->Result<(),&'static str> {
    if !children_advertised {return Err(match mode {
        RelationshipMode::MatchedOrdinary=>"bootstrap_target_relationship_children_missing",
        RelationshipMode::ExcludedDialog=>"bootstrap_excluded_dialog_children_missing",
    });}
    if !sheets_advertised {
        return match mode {
            RelationshipMode::MatchedOrdinary=>Ok(()),
            RelationshipMode::ExcludedDialog=>Ok(()),
        };
    }
    empty_sheets(true,read_sheets)
}
pub(super) unsafe fn root_relationships(reader:&mut AxReader,window:AXUIElementRef,pid:i32,mode:RelationshipMode)->Result<(),&'static str> {
    reader.bootstrap_phase(match mode{RelationshipMode::MatchedOrdinary=>"target_relationships",RelationshipMode::ExcludedDialog=>"excluded_dialog_relationships"});
    let names=reader.names(window)?;
    relationship_edges(mode,names.contains("AXSheets"),names.contains("AXChildren"),||Ok(reader.elements(window,"AXSheets")?.len()))?;
    let children=reader.elements(window,"AXChildren")?;
    if children.len()>128 {return Err("bootstrap_children_limit");}
    for child in children {
        let names=reader.names(child.0)?;let sub=if names.contains("AXSubrole"){Some(reader.string(child.0,"AXSubrole")?)}else{None};
        child_kind(&reader.string(child.0,"AXRole")?,sub.as_deref())?;
        let parent=reader.element(child.0,"AXParent")?;
        if reader.pid(child.0)?!=pid || CFEqual(parent.0 as CFTypeRef,window as CFTypeRef)==0 {return Err("bootstrap_parent_mismatch");}
    }
    Ok(())
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]enum IdentityKind {Ordinary,Dialog}
fn matched_target_kind(role:&str,subrole:&str)->Result<(),&'static str> {
    ordinary_root(role,Some(subrole)).map_err(|_|"bootstrap_matched_target_not_ordinary")
}
fn identity_kind(role:&str,subrole:&str)->Result<IdentityKind,&'static str> {
    match (role,subrole) {
        ("AXWindow","AXStandardWindow")=>Ok(IdentityKind::Ordinary),
        ("AXWindow","AXDialog")=>Ok(IdentityKind::Dialog),
        _=>Err("bootstrap_identity_kind_unsupported"),
    }
}
fn candidate_relation(kind:IdentityKind,matched:bool,exclude:impl FnOnce()->Result<(),&'static str>)->Result<(),&'static str> {
    match (kind,matched) {
        (IdentityKind::Dialog,true)=>Err("bootstrap_matched_target_not_ordinary"),
        (IdentityKind::Dialog,false)=>exclude(),
        (IdentityKind::Ordinary,_)=>Ok(()),
    }
}
fn exclude_non_target_dialog(modal:Result<bool,&'static str>,relationships:impl FnOnce()->Result<(),&'static str>,cg:impl FnOnce()->Result<(),&'static str>)->Result<(),&'static str> {
    if modal.map_err(|_|"bootstrap_non_target_dialog_not_excludable")? {return Err("bootstrap_non_target_dialog_not_excludable");}
    relationships()?;cg()
}
fn exclusion_identity(kind:IdentityKind,id:u32,original_id:u32,matched:Result<bool,&'static str>)->Result<(),&'static str> {
    if kind!=IdentityKind::Dialog || id!=original_id || matched.map_err(|_|"bootstrap_non_target_identity_changed")? {
        Err("bootstrap_non_target_identity_changed")
    }else{Ok(())}
}
unsafe fn identity_root(reader:&mut AxReader,app:AXUIElementRef,window:AXUIElementRef,pid:i32)->Result<(u32,IdentityKind),&'static str> {
    reader.bootstrap_phase("identity");
    let names=reader.names(window)?;
    root_fields(false,||Ok(reader.pid(window)?==pid),|key|names.contains(key))?;
    let kind=identity_kind(&reader.string(window,"AXRole")?,&reader.string(window,"AXSubrole")?)?;
    let parent=reader.element(window,"AXParent")?;
    if CFEqual(parent.0 as CFTypeRef,app as CFTypeRef)==0 {return Err("bootstrap_parent_mismatch");}
    let id=reader.window_id(window)?;
    positive_identity_id(id)?;Ok((id,kind))
}
const IDENTITY_FIELDS:[(&str,&str);4]=[
    ("AXRole","bootstrap_identity_role_missing"),("AXSubrole","bootstrap_identity_subrole_missing"),
    ("AXTitle","bootstrap_identity_title_missing"),("AXParent","bootstrap_identity_parent_missing")];
const TARGET_FIELDS:[(&str,&str);7]=[
    ("AXRole","bootstrap_target_role_missing"),("AXSubrole","bootstrap_target_subrole_missing"),
    ("AXTitle","bootstrap_target_title_missing"),("AXMinimized","bootstrap_target_minimized_missing"),
    ("AXModal","bootstrap_target_modal_missing"),("AXParent","bootstrap_target_parent_missing"),
    ("AXChildren","bootstrap_target_children_missing")];
fn root_fields(target:bool,pid_matches:impl FnOnce()->Result<bool,&'static str>,mut advertised:impl FnMut(&str)->bool)->Result<(),&'static str> {
    if !pid_matches()? {return Err(if target{"bootstrap_target_pid_mismatch"}else{"bootstrap_identity_pid_mismatch"});}
    let fields:&[(&str,&str)]=if target{&TARGET_FIELDS}else{&IDENTITY_FIELDS};
    for (key,reason) in fields {if !advertised(key){return Err(reason);}}
    Ok(())
}
fn positive_identity_id(id:u32)->Result<(),&'static str> {
    if id==0{Err("bootstrap_identity_window_id_zero")}else{Ok(())}
}
fn title_matches(title:Result<&str,&'static str>)->Result<bool,&'static str> {Ok(title?==TITLE)}
fn target_ready(matched:bool,ready:impl FnOnce()->Result<(),&'static str>)->Result<(),&'static str> {
    if matched {ready()}else{Ok(())}
}
unsafe fn discover(command:&Command)->Result<Candidate,&'static str> {
    command.alive()?;
    let applications=NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(BUNDLE));
    bounds(applications.count(),0,0)?;
    let mut reader=AxReader::bootstrap_reader(Instant::now(),command.deadline,command.cancelled.clone());let mut pids=HashSet::new();let mut ids=HashSet::new();
    let mut matches=Vec::new();let mut total=0;
    for index in 0..applications.count() {
        reader.bootstrap_phase("instance");
        command.alive()?;
        let application=applications.objectAtIndex(index);
        let pid=application.processIdentifier();
        if application.isTerminated() || pid<=0 || !pids.insert(pid)
            || application.bundleIdentifier().map(|s|s.to_string()).as_deref()!=Some(BUNDLE) {return Err("bootstrap_instance_invalid");}
        let pointer=AXUIElementCreateApplication(pid);if pointer.is_null(){return Err("bootstrap_ax_unavailable");}
        let app=OwnedAx(pointer);let names=reader.names(app.0)?;
        if reader.pid(app.0)?!=pid || !names.contains("AXWindows") {return Err("bootstrap_instance_unknown");}
        let windows=reader.elements(app.0,"AXWindows")?;
        total+=windows.len();bounds(applications.count(),windows.len(),total)?;
        for window in windows {
            command.alive()?;
            let (id,kind)=identity_root(&mut reader,app.0,window.0,pid)?;
            if id==0 || !ids.insert(id){return Err("bootstrap_identity_duplicate");}
            // Permission is limited to bounded identity comparison. Drop every
            // non-target title immediately; never place it in Value/error/log.
            let title=reader.bounded_identity_string(window.0,"AXTitle").map_err(|_|"bootstrap_identity_title_unknown")?;
            let matched=title_matches(Ok(&title))?;drop(title);
            candidate_relation(kind,matched,||{
                let (current_id,current_kind)=identity_root(&mut reader,app.0,window.0,pid)
                    .map_err(|_|"bootstrap_non_target_identity_changed")?;
                let current_title=reader.bounded_identity_string(window.0,"AXTitle")
                    .map_err(|_|"bootstrap_identity_title_unknown")?;
                exclusion_identity(current_kind,current_id,id,title_matches(Ok(&current_title)))?;drop(current_title);
                reader.bootstrap_phase("excluded_dialog_relationships");
                let names=reader.names(window.0)?;
                let modal=if names.contains("AXModal"){reader.boolean(window.0,"AXModal")}else{Err("ax_unsupported")};
                // Exact numeric CG ownership/layer proof, never a relationship
                // inferred from PID or a claim that this window cannot obscure.
                exclude_non_target_dialog(modal,||root_relationships(&mut reader,window.0,pid,RelationshipMode::ExcludedDialog),||bootstrap_cg_identity(command,pid,id,CgPurpose::ExcludedDialog).map(|_|()))
            })?;
            target_ready(matched,||{
                reader.bootstrap_phase("target_ready");
                if !names.contains("AXHidden") || reader.boolean(app.0,"AXHidden")? {return Err("bootstrap_instance_unknown");}
                root(&mut reader,app.0,window.0,pid)
            })?;
            if matched {
                let cg=bootstrap_cg_identity(command,pid,id,CgPurpose::VisibleIdentity)?;
                matches.push(Candidate {app:application.clone(),root:window,pid,id,cg});
            }
        }
    }
    unique(matches.len())?;
    matches.pop().ok_or("bootstrap_document_not_found")
}
fn same(before:&Candidate,after:&Candidate)->bool {
    native_comparison_failure(before,after).is_none()
}
fn native_comparison_failure(before:&Candidate,after:&Candidate)->Option<&'static str> {
    comparison_component([running_application_equal(&before.app,&after.app),
        unsafe{!before.app.isTerminated() && !after.app.isTerminated()},before.pid==after.pid && before.id==after.id,
        before.cg==after.cg,unsafe {CFEqual(before.root.0 as CFTypeRef,after.root.0 as CFTypeRef)!=0}])
}
fn comparison_component(checks:[bool;5])->Option<&'static str> {
    ["app_semantics","application_terminated","numeric_identity","cg_geometry","ax_identity"].into_iter()
        .zip(checks).find_map(|(name,passed)|if passed{None}else{Some(name)})
}
fn check_comparison<B:Backend>(backend:&B,command:&Command,before:&B::Candidate,after:&B::Candidate,phase:&'static str)->Result<(),&'static str> {
    if let Some(component)=backend.comparison_failure(before,after) {
        *command.comparison_diagnostic.borrow_mut()=Some(json!({"phase":phase,"component":component}));
        return Err("bootstrap_identity_changed");
    }
    Ok(())
}
unsafe fn bootstrap_cg_identity(command:&Command,pid:i32,id:u32,purpose:CgPurpose)->Result<CgIdentity,&'static str> {
    cg_identity_for(pid,id,purpose).map_err(|failure|{
        record_cg_diagnostic(command,failure.diagnostic(purpose));
        failure.reason
    })
}
fn record_cg_diagnostic(command:&Command,diagnostic:Value) {
    let mut evidence=command.cg_diagnostic.borrow_mut();
    if evidence.is_none(){*evidence=Some(diagnostic);}
}
fn continuity(app:bool,identity:bool,geometry:bool,ax:bool)->bool {app && identity && geometry && ax}
fn consume<T>(lease:&mut Option<T>)->Result<T,&'static str> {lease.take().ok_or("bootstrap_ref_unavailable")}
fn lease_key_valid(expires:Instant,nonce:&str,reference:&str,command:&Command)->Result<(),&'static str> {
    command.alive()?;
    if Instant::now()>=expires || command.nonce!=nonce || command.reference.as_deref()!=Some(reference) {
        Err("bootstrap_ref_expired_or_mismatched")
    }else{Ok(())}
}
unsafe fn foreground(candidate:&Candidate,command:&Command)->Result<(),&'static str> {
    command.alive()?;
    let mut reader=AxReader::bootstrap_reader(Instant::now(),command.deadline,command.cancelled.clone());reader.bootstrap_phase("foreground");
    let _focused=focused_exact_target(&mut reader,candidate,command)?;
    if crate::input::skylight::front_process_matches(candidate.pid,candidate.id)!=Some(true) {
        return Err("bootstrap_foreground_unconfirmed");
    }
    cg_order(candidate.pid,candidate.id)
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]enum FocusField {Pid,WindowId}
fn focused_application_valid(expected:i32,terminated:impl FnOnce()->bool,pid:impl FnOnce()->i32)->Result<(),&'static str> {
    if terminated() || pid()!=expected{return Err("bootstrap_focused_application_changed");}Ok(())
}
fn focused_binding(equal:bool,pid:i32,id:u32,mut read:impl FnMut(FocusField)->Result<i64,&'static str>)->Result<(),&'static str> {
    if !equal{return Err("bootstrap_focused_object_mismatch");}
    if read(FocusField::Pid)?!=i64::from(pid){return Err("bootstrap_focused_pid_mismatch");}
    if read(FocusField::WindowId)?!=i64::from(id){return Err("bootstrap_focused_window_id_mismatch");}
    Ok(())
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]enum FocusStage {Binding,Identity,Cg,Readiness}
fn focused_target_steps(mut check:impl FnMut(FocusStage)->Result<(),&'static str>)->Result<(),&'static str> {
    for stage in [FocusStage::Binding,FocusStage::Identity,FocusStage::Cg,FocusStage::Readiness]{check(stage)?;}
    Ok(())
}
fn focused_identity(kind:IdentityKind,id:u32,expected:u32,title:impl FnOnce()->Result<bool,&'static str>)->Result<(),&'static str> {
    if id!=expected{return Err("bootstrap_focused_window_id_mismatch");}
    if kind!=IdentityKind::Ordinary{return Err("bootstrap_matched_target_not_ordinary");}
    if !title()?{return Err("bootstrap_focused_title_mismatch");}
    Ok(())
}
// Bootstrap-only bridge. The old standalone unique/selected identity contracts
// remain strict. A retained exact object must be proven before title/relations.
unsafe fn focused_exact_target(reader:&mut AxReader,candidate:&Candidate,command:&Command)->Result<OwnedAx,&'static str> {
    command.alive()?;reader.bootstrap_phase("foreground");
    focused_application_valid(candidate.pid,||candidate.app.isTerminated(),||candidate.app.processIdentifier())?;
    let pointer=AXUIElementCreateApplication(candidate.pid);if pointer.is_null(){return Err("bootstrap_ax_unavailable");}
    let app=OwnedAx(pointer);let names=reader.names(app.0)?;
    if reader.pid(app.0)?!=candidate.pid{return Err("bootstrap_focused_app_pid_mismatch");}
    if !names.contains("AXFocusedWindow"){return Err("bootstrap_focused_window_missing");}
    if !names.contains("AXHidden"){return Err("bootstrap_focused_hidden_missing");}
    if reader.boolean(app.0,"AXHidden")?{return Err("bootstrap_instance_unknown");}
    let focused=reader.element(app.0,"AXFocusedWindow")?;
    focused_target_steps(|stage|{
        command.alive()?;
        match stage {
            FocusStage::Binding=>focused_binding(CFEqual(candidate.root.0 as CFTypeRef,focused.0 as CFTypeRef)!=0,candidate.pid,candidate.id,
                |field|match field {FocusField::Pid=>reader.pid(focused.0).map(i64::from),FocusField::WindowId=>reader.window_id(focused.0).map(i64::from)}),
            FocusStage::Identity=>{
                let (id,kind)=identity_root(reader,app.0,focused.0,candidate.pid)?;
                focused_identity(kind,id,candidate.id,||{
                    let title=reader.bounded_identity_string(focused.0,"AXTitle").map_err(|_|"bootstrap_identity_title_unknown")?;
                    title_matches(Ok(&title))
                })
            },
            FocusStage::Cg=>{
                let cg=bootstrap_cg_identity(command,candidate.pid,candidate.id,CgPurpose::VisibleIdentity)?;
                if cg!=candidate.cg{return Err("bootstrap_focused_geometry_changed");}Ok(())
            },
            FocusStage::Readiness=>root(reader,app.0,focused.0,candidate.pid),
        }
    })?;
    command.alive()?;Ok(focused)
}
fn lease_valid<C>(lease:&Lease<C>,command:&Command)->Result<(),&'static str> {
    lease_key_valid(lease.expires,&lease.nonce,&lease.reference,command)
}
fn write_step(command:&Command,write:impl FnOnce()->bool)->Result<(),&'static str> {
    command.alive()?;command.started.store(true,Ordering::SeqCst);
    if write(){Ok(())}else{Err("bootstrap_activation_unconfirmed")}
}
fn activation_failure(command:&Command,step:&'static str,class:&'static str) {
    let mut diagnostic=command.activation_diagnostic.borrow_mut();
    if diagnostic.is_none(){*diagnostic=Some(json!({"step":step,"error_class":class}));}
}
fn activation_ax_class(code:i32)->&'static str {
    match code {-25200=>"failure",-25201=>"illegal_argument",-25202=>"invalid_element",-25204=>"cannot_complete",
        -25205=>"unsupported",-25206=>"action_unsupported",-25208=>"not_implemented",-25211=>"api_disabled",-25212=>"no_value",_=>"other"}
}
fn activation_ax_step(command:&Command,step:&'static str,write:impl FnOnce()->i32)->Result<(),&'static str> {
    write_step(command,||{let code=write();if code!=kAXErrorSuccess{activation_failure(command,step,activation_ax_class(code));}code==kAXErrorSuccess})
}
fn activation_confirmation(front:Option<bool>,order:impl FnOnce()->Result<(),&'static str>)->(bool,&'static str) {
    match front {None=>(false,"front_unknown"),Some(false)=>(false,"front_mismatch"),Some(true)=>match order() {
        Ok(())=>(true,"stability_deadline"),Err("selected_identity_cg_order_unknown")=>(false,"order_unknown"),
        Err("selected_identity_cg_order_conflict")=>(false,"order_conflict"),Err(_)=>(false,"order_unconfirmed")}}
}
unsafe fn activate(candidate:&Candidate,command:&Command)->Result<(),&'static str> {
    // One explicit sequence, never stock BringToFront/Cocoa all-window raise.
    let fronted=crate::input::skylight::set_front_process_persistently_diagnostic(candidate.pid,candidate.id,|| {
        command.alive()?;command.started.store(true,Ordering::SeqCst);Ok::<(),&'static str>(())
    },|step,class|activation_failure(command,step,class))?;
    if !fronted{return Err("bootstrap_activation_unconfirmed");}
    let keyed=crate::input::skylight::make_exact_window_key_diagnostic(candidate.pid,candidate.id,|| {
        command.alive()?;
        command.started.store(true,Ordering::SeqCst);
        Ok::<(),&'static str>(())
    },|step,class|activation_failure(command,step,class))?;
    if !keyed {return Err("bootstrap_activation_unconfirmed");}
    activation_ax_step(command,"ax_raise",||perform_action(candidate.root.0,"AXRaise"))?;
    activation_ax_step(command,"ax_main",||set_bool_attr_true(candidate.root.0,"AXMain"))?;
    // AXFocused is writable only for keyboard-focusable elements, not an
    // ordinary window root. Do not write a body element or add a replacement.
    let deadline=Instant::now()+Duration::from_millis(900);let mut stable=None;
    loop {
        command.alive()?;
        let mut reader=AxReader::bootstrap_reader(Instant::now(),command.deadline,command.cancelled.clone());reader.bootstrap_phase("foreground");
        let _focused=focused_exact_target(&mut reader,candidate,command).map_err(|reason|{activation_failure(command,"focus_bridge","verification_rejected");reason})?;
        let (exact,failure)=activation_confirmation(crate::input::skylight::front_process_matches(candidate.pid,candidate.id),||cg_order(candidate.pid,candidate.id));
        if exact {
            let start=stable.get_or_insert(Instant::now());
            if start.elapsed()>=Duration::from_millis(100){return Ok(());}
        }else{stable=None;}
        if Instant::now()>=deadline {activation_failure(command,"confirmation",failure);return Err("bootstrap_activation_unconfirmed");}
        thread::sleep(Duration::from_millis(20));
    }
}
fn worker<B:Backend>(receiver:mpsc::Receiver<Command>,stop:Arc<AtomicBool>,mut backend:B) {
    let mut lease:Option<Lease<B::Candidate>>=None;let mut discovered=false;
    while !stop.load(Ordering::SeqCst) {
        let command=match receiver.recv_timeout(Duration::from_millis(100)) {Ok(c)=>c,Err(mpsc::RecvTimeoutError::Timeout)=>{
            if lease.as_ref().is_some_and(|l|Instant::now()>=l.expires){lease=None;}continue;},Err(_)=>break};
        let diagnostic_scope=BootstrapAxScope::new();
        let answer=(||->Result<Value,&'static str>{
            command.alive()?;
            if command.task_proof {
                let retained=consume(&mut lease)?;
                if retained.activated{command.started.store(true,Ordering::SeqCst);}
                lease_valid(&retained,&command)?;
                if !retained.activated{return Err("bootstrap_activation_required");}
                if retained.proof_consumed{return Err("task_proof_consumed");}
                if !backend.trusted(){return Err("bootstrap_accessibility_required");}
                let fresh=backend.discover(&command)?;check_comparison(&backend,&command,&retained.candidate,&fresh,"finalize")?;
                lease_valid(&retained,&command)?;
                let value=backend.task_proof(&retained.candidate,&command)?;
                lease_valid(&retained,&command)?;
                let fresh=backend.discover(&command)?;check_comparison(&backend,&command,&retained.candidate,&fresh,"finalize")?;
                lease_valid(&retained,&command)?;lease=Some(Lease{proof_consumed:true,..retained});return Ok(value);
            }
            if !command.activate {
                if command.reference.is_some() {
                    let retained=consume(&mut lease)?;
                    lease_valid(&retained,&command)?;
                    if !retained.activated {return Err("bootstrap_activation_required");}
                    command.started.store(true,Ordering::SeqCst);
                    if !backend.trusted(){return Err("bootstrap_accessibility_required");}
                    let fresh=backend.discover(&command)?;command.alive()?;
                    check_comparison(&backend,&command,&retained.candidate,&fresh,"finalize")?;
                    backend.foreground(&retained.candidate,&command)?;lease_valid(&retained,&command)?;
                    let (pid,id)=backend.identity(&retained.candidate);
                    return Ok(json!({"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
                        "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"finalized","request_nonce":command.nonce,
                        "pid":pid,"window_id":id,"activation_started":true,"input_authorized":false}));
                }
                if discovered{return Err("bootstrap_discovery_consumed");}discovered=true;
                if !backend.trusted(){return Err("bootstrap_accessibility_required");}
                let before=backend.discover(&command)?;command.alive()?;
                let after=backend.discover(&command)?;command.alive()?;
                check_comparison(&backend,&command,&before,&after,"first_pair")?;
                let (pid,id)=backend.identity(&before);
                let reference=uuid::Uuid::new_v4().to_string();
                let value=json!({"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
                    "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"candidate","candidate_ref":reference,
                    "request_nonce":command.nonce,"pid":pid,"window_id":id,"ttl_ms":15000,"input_authorized":false});
                lease=Some(Lease {candidate:before,nonce:command.nonce.clone(),reference,expires:Instant::now()+TTL,activated:false,proof_consumed:false});
                Ok(value)
            }else{
                // Removing the lease BEFORE any validation/write makes every
                // failure terminal and prevents unknown activation replay.
                let retained=consume(&mut lease)?;
                if retained.activated {return Err("bootstrap_activation_consumed");}
                lease_valid(&retained,&command)?;
                if !backend.trusted(){return Err("bootstrap_accessibility_required");}
                let fresh=backend.discover(&command)?;command.alive()?;
                check_comparison(&backend,&command,&retained.candidate,&fresh,"preactivate")?;
                lease_valid(&retained,&command)?;
                backend.activate(&retained.candidate,&command)?;
                let after=backend.discover(&command)?;command.alive()?;
                check_comparison(&backend,&command,&retained.candidate,&after,"postactivate")?;
                let (pid,id)=backend.identity(&retained.candidate);
                let value=json!({"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
                    "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"activated","request_nonce":command.nonce,
                    "pid":pid,"window_id":id,"activation_started":true,"input_authorized":false});
                lease=Some(Lease {activated:true,..retained});
                Ok(value)
            }
        })();
        let value=match answer {Ok(value)=>ToolResult::text("Controlled bootstrap stage verified; no subsequent input grant.").with_structured(value),
            Err(reason)=>{lease=None;let mut value=result(reason,command.started.load(Ordering::SeqCst));
                if command.task_proof {let mut evidence=super::get_target_window_topology::task_capability();
                    evidence["status"]=json!("unknown");evidence["reason_code"]=json!(reason);
                    evidence["request_nonce"]=json!(command.nonce);evidence["activation_started"]=json!(command.started.load(Ordering::SeqCst));
                    if reason=="task_upper_intersection"{if let Some(diagnostic)=command.intersection_diagnostic.borrow_mut().take(){evidence["intersection_diagnostic"]=diagnostic;}}
                    value=ToolResult::error("Controlled task target is unknown; no input authorized.").with_structured(evidence);}
                if let (Some(diag),Some(structured))=(diagnostic_scope.take(),value.structured_content.as_mut()){structured["ax_diagnostic"]=diag;}
                if let (Some(diag),Some(structured))=(command.cg_diagnostic.borrow_mut().take(),value.structured_content.as_mut()){structured["cg_diagnostic"]=diag;}
                if let (Some(diag),Some(structured))=(command.comparison_diagnostic.borrow_mut().take(),value.structured_content.as_mut()){structured["comparison_diagnostic"]=diag;}
                if let (Some(diag),Some(structured))=(command.activation_diagnostic.borrow_mut().take(),value.structured_content.as_mut()){structured["activation_diagnostic"]=diag;}
                value}};
        let _=command.reply.send(value);
    }
    // Lease and all retained references are dropped on this worker, not async.
}

#[cfg(test)]mod tests {
    use super::*;
    #[test]fn activation_ax_returns_are_closed_and_actual_write_failure_preserves_started(){
        assert_eq!(activation_ax_class(-25205),"unsupported");assert_eq!(activation_ax_class(-25206),"action_unsupported");
        assert_eq!(activation_ax_class(-25208),"not_implemented");assert_eq!(activation_ax_class(123),"other");
        let (request,_reply)=command();let calls=std::cell::Cell::new(0);
        assert_eq!(activation_ax_step(&request,"ax_raise",||{calls.set(calls.get()+1);-25206}),Err("bootstrap_activation_unconfirmed"));
        assert_eq!(calls.get(),1);assert!(request.started.load(Ordering::SeqCst));
        assert_eq!(request.activation_diagnostic.borrow().as_ref(),Some(&json!({"step":"ax_raise","error_class":"action_unsupported"})));
        let (cancelled,_cancelled_reply)=command();cancelled.cancelled.store(true,Ordering::SeqCst);
        assert!(activation_ax_step(&cancelled,"ax_main",||panic!("cancelled write")).is_err());
        assert!(!cancelled.started.load(Ordering::SeqCst));assert!(cancelled.activation_diagnostic.borrow().is_none());
    }
    #[test]fn activation_confirmation_keeps_front_short_circuit_and_existing_order_error(){
        assert_eq!(activation_confirmation(None,||panic!("unknown front queried CG")),(false,"front_unknown"));
        assert_eq!(activation_confirmation(Some(false),||panic!("different front queried CG")),(false,"front_mismatch"));
        for (reason,class) in [("selected_identity_cg_order_unknown","order_unknown"),("selected_identity_cg_order_conflict","order_conflict"),("private-other","order_unconfirmed")] {
            let calls=std::cell::Cell::new(0);
            assert_eq!(activation_confirmation(Some(true),||{calls.set(calls.get()+1);Err(reason)}),(false,class));assert_eq!(calls.get(),1);
        }
        assert_eq!(activation_confirmation(Some(true),||Ok(())),(true,"stability_deadline"));
    }
    #[test]fn activation_diagnostic_is_first_failure_and_fresh_command_only(){
        let (first,_reply)=command();let (next,_next_reply)=command();
        activation_failure(&first,"exact_key_release","write_rejected");activation_failure(&first,"ax_main","other");
        assert_eq!(first.activation_diagnostic.borrow_mut().take(),Some(json!({"step":"exact_key_release","error_class":"write_rejected"})));
        assert!(next.activation_diagnostic.borrow().is_none());
    }
    #[test]fn focused_binding_mismatch_stops_before_title_and_relationship_reads(){
        let app_pid_reads=std::cell::Cell::new(0);let after_guard=std::cell::Cell::new(0);
        assert_eq!(focused_application_valid(41,||true,||{app_pid_reads.set(app_pid_reads.get()+1);41})
            .and_then(|_|{after_guard.set(after_guard.get()+1);Ok(())}),Err("bootstrap_focused_application_changed"));
        assert_eq!(app_pid_reads.get(),0);assert_eq!(after_guard.get(),0);
        assert_eq!(focused_application_valid(41,||false,||{app_pid_reads.set(app_pid_reads.get()+1);42})
            .and_then(|_|{after_guard.set(after_guard.get()+1);Ok(())}),Err("bootstrap_focused_application_changed"));
        assert_eq!(app_pid_reads.get(),1);assert_eq!(after_guard.get(),0);
        assert!(focused_application_valid(41,||false,||41).is_ok());
        let mut visited=Vec::new();
        assert_eq!(focused_binding(false,41,7,|field|{visited.push(field);Ok(0)}),Err("bootstrap_focused_object_mismatch"));assert!(visited.is_empty());
        assert_eq!(focused_binding(true,41,7,|field|{visited.push(field);Ok(42)}),Err("bootstrap_focused_pid_mismatch"));assert_eq!(visited,vec![FocusField::Pid]);
        visited.clear();assert_eq!(focused_binding(true,41,7,|field|{visited.push(field);Ok(if field==FocusField::Pid{41}else{8})}),Err("bootstrap_focused_window_id_mismatch"));
        assert_eq!(visited,vec![FocusField::Pid,FocusField::WindowId]);
        visited.clear();assert!(focused_binding(true,41,u32::MAX,|field|{visited.push(field);Ok(if field==FocusField::Pid{41}else{i64::from(u32::MAX)})}).is_ok());
        assert_eq!(visited.len(),2);assert_eq!(focused_binding(true,41,7,|_|Err("ax_query_error")),Err("ax_query_error"));
    }
    #[test]fn focused_known_target_requires_fresh_ordinary_class_and_exact_title(){
        let calls=std::cell::Cell::new(0);
        assert_eq!(focused_identity(IdentityKind::Ordinary,8,7,||{calls.set(calls.get()+1);Ok(true)}),Err("bootstrap_focused_window_id_mismatch"));
        assert_eq!(focused_identity(IdentityKind::Dialog,7,7,||{calls.set(calls.get()+1);Ok(true)}),Err("bootstrap_matched_target_not_ordinary"));assert_eq!(calls.get(),0);
        assert_eq!(focused_identity(IdentityKind::Ordinary,7,7,||{calls.set(calls.get()+1);Ok(false)}),Err("bootstrap_focused_title_mismatch"));
        assert_eq!(focused_identity(IdentityKind::Ordinary,7,7,||Err("bootstrap_identity_title_unknown")),Err("bootstrap_identity_title_unknown"));
        assert!(focused_identity(IdentityKind::Ordinary,7,7,||{calls.set(calls.get()+1);Ok(true)}).is_ok());assert_eq!(calls.get(),2);
    }
    #[test]fn focused_production_pipeline_proves_identity_and_cg_before_target_relationships(){
        let stages=[FocusStage::Binding,FocusStage::Identity,FocusStage::Cg,FocusStage::Readiness];
        for (index,failed) in stages.iter().enumerate(){
            let mut visited=Vec::new();assert_eq!(focused_target_steps(|stage|{visited.push(stage);if stage==*failed{Err("ax_query_error")}else{Ok(())}}),Err("ax_query_error"));
            assert_eq!(visited,stages[..=index]);
        }
        let mut visited=Vec::new();assert!(focused_target_steps(|stage|{visited.push(stage);Ok(())}).is_ok());assert_eq!(visited,stages);
    }
    #[test]fn focused_exact_qualified_target_optional_sheets_never_relaxes_parent_children_or_errors(){
        let calls=std::cell::Cell::new(0);
        assert!(focused_target_steps(|stage|match stage{
            FocusStage::Binding=>focused_binding(true,41,7,|field|Ok(if field==FocusField::Pid{41}else{7})),
            FocusStage::Identity=>focused_identity(IdentityKind::Ordinary,7,7,||Ok(true)),
            FocusStage::Cg=>Ok(()),
            FocusStage::Readiness=>{root_fields(true,||Ok(true),|_|true)?;relationship_edges(RelationshipMode::MatchedOrdinary,false,true,||{calls.set(calls.get()+1);Ok(0)})},
        }).is_ok());assert_eq!(calls.get(),0);
        assert_eq!(root_fields(true,||Ok(true),|key|key!="AXParent"),Err("bootstrap_target_parent_missing"));
        assert_eq!(relationship_edges(RelationshipMode::MatchedOrdinary,false,false,||panic!("missing Children must refuse")),Err("bootstrap_target_relationship_children_missing"));
        for reason in ["ax_unsupported","ax_no_value","ax_query_error","ax_array_type"]{
            assert_eq!(relationship_edges(RelationshipMode::MatchedOrdinary,true,true,||Err(reason)),Err(reason));
        }
        assert!(relationship_edges(RelationshipMode::MatchedOrdinary,true,true,||Ok(1)).is_err());
        assert!(child_kind("AXSheet",None).is_err());assert!(empty_sheets(false,||panic!("old strict helper must not query")).is_err());
    }
    #[test]fn native_comparison_components_preserve_all_guards_and_first_failure(){
        assert_eq!(comparison_component([true;5]),None);
        for (index,expected) in ["app_semantics","application_terminated","numeric_identity","cg_geometry","ax_identity"].iter().enumerate() {
            let mut checks=[true;5];checks[index]=false;assert_eq!(comparison_component(checks),Some(*expected));
            for later in index+1..5{checks[later]=false;}assert_eq!(comparison_component(checks),Some(*expected));
        }
    }
    #[test]fn comparison_gate_reuses_one_result_and_records_only_current_command_phase(){
        struct Probe {calls:std::cell::Cell<usize>,failure:std::cell::Cell<Option<&'static str>>}
        impl Backend for Probe {
            type Candidate=();fn trusted(&mut self)->bool{panic!("no query")}
            fn discover(&mut self,_:&Command)->Result<(),&'static str>{panic!("no query")}
            fn same(&self,_:&(),_:&())->bool{panic!("do not compare twice")}
            fn comparison_failure(&self,_:&(),_:&())->Option<&'static str>{self.calls.set(self.calls.get()+1);self.failure.get()}
            fn identity(&self,_:&())->(i32,u32){panic!("no values")}
            fn activate(&mut self,_:&(),_:&Command)->Result<(),&'static str>{panic!("no write")}
            fn foreground(&mut self,_:&(),_:&Command)->Result<(),&'static str>{panic!("no query")}
        }
        let probe=Probe {calls:std::cell::Cell::new(0),failure:std::cell::Cell::new(None)};
        let (first,_receiver)=command();assert!(check_comparison(&probe,&first,&(),&(),"first_pair").is_ok());
        assert_eq!(probe.calls.get(),1);assert!(first.comparison_diagnostic.borrow().is_none());
        for phase in ["first_pair","preactivate","postactivate","finalize"] {
            let (fresh,_receiver)=command();probe.failure.set(Some("app_semantics"));
            assert_eq!(check_comparison(&probe,&fresh,&(),&(),phase),Err("bootstrap_identity_changed"));
            assert_eq!(fresh.comparison_diagnostic.borrow().as_ref(),Some(&json!({"phase":phase,"component":"app_semantics"})));
            assert!(first.comparison_diagnostic.borrow().is_none());
        }
        assert_eq!(probe.calls.get(),5);
    }
    #[test]fn cg_failure_is_first_per_command_and_fresh_command_has_no_stale_evidence(){
        let (first,_receiver)=command();let (next,_next_receiver)=command();
        assert!(first.cg_diagnostic.borrow().is_none());assert!(next.cg_diagnostic.borrow().is_none());
        let expected=json!({"phase":"excluded_dialog_cg","field":"owner","error_class":"missing"});
        record_cg_diagnostic(&first,expected.clone());
        record_cg_diagnostic(&first,json!({"phase":"target_cg","field":"onscreen","error_class":"not_ordered"}));
        assert_eq!(first.cg_diagnostic.borrow_mut().take(),Some(expected));
        assert!(first.cg_diagnostic.borrow_mut().take().is_none());assert!(next.cg_diagnostic.borrow().is_none());
        drop(first);assert!(next.cg_diagnostic.borrow().is_none());
    }
    #[test]fn bootstrap_request_is_fixed_task_and_ref_only(){
        let nonce=uuid::Uuid::new_v4().to_string();
        assert!(public_args(&json!({"bundle_id":BUNDLE,"document_title":TITLE,"request_nonce":nonce}),false).is_ok());
        assert!(public_args(&json!({"bundle_id":BUNDLE,"document_title":"private","request_nonce":nonce}),false).is_err());
        assert!(public_args(&json!({"bundle_id":BUNDLE,"document_title":TITLE,"request_nonce":nonce,"pid":1}),false).is_err());
        assert!(public_args(&json!({"candidate_ref":nonce,"request_nonce":nonce}),true).is_ok());
    }
    #[test]fn bounded_all_candidates_never_first_or_filtered_unique(){
        assert!(bounds(32,64,128).is_ok());assert!(bounds(33,1,1).is_err());assert!(bounds(1,65,65).is_err());assert!(bounds(1,1,129).is_err());
        assert!(unique(1).is_ok());assert!(unique(0).is_err());assert!(unique(2).is_err());
    }
    fn command()->(Command,tokio::sync::oneshot::Receiver<ToolResult>) {
        let (reply,receiver)=tokio::sync::oneshot::channel();
        (Command {activate:true,task_proof:false,nonce:"task".into(),reference:Some("reference".into()),deadline:Instant::now()+REQUEST_TIME,cg_diagnostic:std::cell::RefCell::new(None),comparison_diagnostic:std::cell::RefCell::new(None),activation_diagnostic:std::cell::RefCell::new(None),intersection_diagnostic:std::cell::RefCell::new(None),
            cancelled:Arc::new(AtomicBool::new(false)),started:Arc::new(AtomicBool::new(false)),reply},receiver)
    }
    #[test]fn closed_cancelled_and_expired_commands_never_pass_write_gate(){
        let (mut value,receiver)=command();assert!(value.alive().is_ok());
        value.deadline=Instant::now();assert!(value.alive().is_err());assert!(!value.started.load(Ordering::SeqCst));
        value.deadline=Instant::now()+REQUEST_TIME;value.cancelled.store(true,Ordering::SeqCst);assert!(value.alive().is_err());
        value.cancelled.store(false,Ordering::SeqCst);drop(receiver);assert!(value.alive().is_err());
    }
    #[test]fn cancellation_before_write_and_between_steps_preserves_effect_evidence(){
        let (value,_receiver)=command();value.cancelled.store(true,Ordering::SeqCst);
        assert!(write_step(&value,||panic!("cancelled before write")).is_err());assert!(!value.started.load(Ordering::SeqCst));
        value.cancelled.store(false,Ordering::SeqCst);
        assert!(write_step(&value,||{value.cancelled.store(true,Ordering::SeqCst);true}).is_ok());
        assert!(value.started.load(Ordering::SeqCst));assert!(write_step(&value,||panic!("later unstarted step")).is_err());
    }
    #[test]fn real_command_alive_stops_exact_key_internal_writes(){
        for stop_after in [0,1] {
            for mode in [0,1,2] {
                let (value,receiver)=command();let started=value.started.clone();
                let value=std::cell::RefCell::new(value);let receiver=std::cell::RefCell::new(Some(receiver));
                let writes=std::cell::RefCell::new(Vec::new());
                let result=crate::input::skylight::exact_key_write_sequence(|| {
                    let current=value.borrow();current.alive()?;current.started.store(true,Ordering::SeqCst);Ok::<(),&'static str>(())
                },|step| {
                    writes.borrow_mut().push(step);
                    if step==stop_after {
                        match mode {
                            0=>value.borrow().cancelled.store(true,Ordering::SeqCst),
                            1=>value.borrow_mut().deadline=Instant::now(),
                            _=>{receiver.borrow_mut().take();}
                        }
                    }
                    true
                });
                assert!(result.is_err());assert!(started.load(Ordering::SeqCst));
                assert_eq!(*writes.borrow(),(0..=stop_after).collect::<Vec<_>>());
            }
        }
    }
    #[test]fn lease_ref_ttl_identity_and_consumption_are_independent_guards(){
        let (value,_receiver)=command();
        assert!(lease_key_valid(Instant::now()+TTL,"task","reference",&value).is_ok());
        assert!(lease_key_valid(Instant::now(),"task","reference",&value).is_err());
        assert!(lease_key_valid(Instant::now()+TTL,"other","reference",&value).is_err());
        assert!(lease_key_valid(Instant::now()+TTL,"task","other",&value).is_err());
        for flags in [[false,true,true,true],[true,false,true,true],[true,true,false,true],[true,true,true,false]] {
            assert!(!continuity(flags[0],flags[1],flags[2],flags[3]));
        }
        assert!(continuity(true,true,true,true));
        let mut lease=Some(1);assert_eq!(consume(&mut lease).unwrap(),1);assert!(consume(&mut lease).is_err());
    }
    #[test]fn known_non_target_need_not_be_operable_but_unknown_is_never_filtered(){
        assert!(!title_matches(Ok("another controlled title")).unwrap());
        assert!(target_ready(false,||panic!("non-target hidden/minimized state must not be queried")).is_ok());
        assert!(title_matches(Err("ax_unsupported")).is_err());
        assert!(ordinary_root("AXUnknown",Some("AXStandardWindow")).is_err());
        assert!(target_ready(true,||Err("bootstrap_root_not_ready")).is_err());
        assert!(target_ready(true,||Ok(())).is_ok());
    }
    #[test]fn identity_classification_only_knows_ordinary_and_explicit_dialog(){
        assert_eq!(identity_kind("AXWindow","AXStandardWindow"),Ok(IdentityKind::Ordinary));
        assert_eq!(identity_kind("AXWindow","AXDialog"),Ok(IdentityKind::Dialog));
        for (role,subrole) in [("AXWindow","AXSystemDialog"),("AXWindow","AXSheet"),("AXSheet",""),("AXWindow",""),("AXUnknown","AXStandardWindow")] {
            assert_eq!(identity_kind(role,subrole),Err("bootstrap_identity_kind_unsupported"));
        }
    }
    #[test]fn root_diagnostics_preserve_pid_short_circuit_and_reader_errors(){
        for target in [false,true] {
            let calls=std::cell::Cell::new(0);
            let reason=if target{"bootstrap_target_pid_mismatch"}else{"bootstrap_identity_pid_mismatch"};
            assert_eq!(root_fields(target,||{calls.set(calls.get()+1);Ok(false)},|_|panic!("PID mismatch must not check fields")),Err(reason));
            assert_eq!(calls.get(),1);
            assert_eq!(root_fields(target,||Err("ax_query_error"),|_|panic!("PID error must not check fields")),Err("ax_query_error"));
        }
    }
    #[test]fn root_diagnostics_report_first_missing_field_in_existing_order(){
        for target in [false,true] {
            let fields:&[(&str,&str)]=if target{&TARGET_FIELDS}else{&IDENTITY_FIELDS};
            for missing in 0..fields.len() {
                let seen=std::cell::RefCell::new(Vec::new());
                assert_eq!(root_fields(target,||Ok(true),|key|{seen.borrow_mut().push(key.to_owned());key!=fields[missing].0}),Err(fields[missing].1));
                assert_eq!(*seen.borrow(),fields[..=missing].iter().map(|(key,_)|key.to_string()).collect::<Vec<_>>());
            }
            let seen=std::cell::Cell::new(0);
            assert_eq!(root_fields(target,||Ok(true),|_|{seen.set(seen.get()+1);true}),Ok(()));
            assert_eq!(seen.get(),fields.len());
            assert_eq!(root_fields(target,||Ok(true),|_|false),Err(fields[0].1));
        }
    }
    #[test]fn zero_identity_window_id_is_closed_without_changing_valid_range(){
        assert_eq!(positive_identity_id(0),Err("bootstrap_identity_window_id_zero"));
        assert_eq!(positive_identity_id(1),Ok(()));assert_eq!(positive_identity_id(u32::MAX),Ok(()));
    }
    #[test]fn matched_ordinary_unadvertised_sheet_edge_never_queries_or_claims_empty(){
        assert_eq!(relationship_edges(RelationshipMode::MatchedOrdinary,false,true,||panic!("unadvertised optional edge must not be queried")),Ok(()));
        let seen=std::cell::Cell::new(0);
        assert_eq!(relationship_edges(RelationshipMode::MatchedOrdinary,true,true,||{seen.set(seen.get()+1);Ok(0)}),Ok(()));
        assert_eq!(seen.get(),1);
        for advertised in [false,true,false] {
            assert!(relationship_edges(RelationshipMode::MatchedOrdinary,advertised,true,||{seen.set(seen.get()+1);Ok(0)}).is_ok());
        }
        assert_eq!(seen.get(),2);
        assert!(relationship_edges(RelationshipMode::MatchedOrdinary,false,true,||panic!("first sample no edge")).is_ok());
        assert!(relationship_edges(RelationshipMode::MatchedOrdinary,true,true,||Ok(1)).is_err());
    }
    #[test]fn advertised_sheet_edge_query_failures_and_present_sheets_still_refuse(){
        for mode in [RelationshipMode::MatchedOrdinary,RelationshipMode::ExcludedDialog] {
            for reason in ["ax_unsupported","ax_no_value","ax_query_error","ax_wrong_type","ax_invalid_element"] {
                let seen=std::cell::Cell::new(0);
                assert_eq!(relationship_edges(mode,true,true,||{seen.set(seen.get()+1);Err(reason)}),Err(reason));assert_eq!(seen.get(),1);
            }
            let seen=std::cell::Cell::new(0);
            assert!(relationship_edges(mode,true,true,||{seen.set(seen.get()+1);Ok(1)}).is_err());assert_eq!(seen.get(),1);
            assert!(relationship_edges(mode,true,true,||Ok(0)).is_ok());
        }
    }
    #[test]fn excluded_dialog_optional_edge_does_not_relax_mandatory_children(){
        assert_eq!(relationship_edges(RelationshipMode::ExcludedDialog,false,true,||panic!("unadvertised edge is not queried")),Ok(()));
        for mode in [RelationshipMode::MatchedOrdinary,RelationshipMode::ExcludedDialog] {
            let reason=match mode {RelationshipMode::MatchedOrdinary=>"bootstrap_target_relationship_children_missing",RelationshipMode::ExcludedDialog=>"bootstrap_excluded_dialog_children_missing"};
            assert_eq!(relationship_edges(mode,true,false,||panic!("children missing must stop sheet query")),Err(reason));
        }
        assert!(empty_sheets(false,||panic!("old identity helper unchanged")).is_err());
        assert_eq!(root_fields(true,||Ok(true),|key|key!="AXSheets"),Ok(()));
        assert!(root_fields(true,||Ok(true),|key|key!="AXChildren").is_err());
    }
    #[test]fn non_target_optional_sheet_branch_needs_all_prior_candidate_gates(){
        let calls=std::cell::Cell::new(0);
        assert!(candidate_relation(IdentityKind::Ordinary,true,||panic!("ordinary target must not use exclusion")).is_ok());
        assert!(target_ready(true,||matched_target_kind("AXWindow","AXStandardWindow")).is_ok());
        let approved=||exclude_non_target_dialog(Ok(false),||relationship_edges(RelationshipMode::ExcludedDialog,false,true,||panic!("no unadvertised query")),||{calls.set(calls.get()+1);Ok(())});
        assert!(candidate_relation(IdentityKind::Dialog,false,approved).is_ok());assert_eq!(calls.get(),1);assert!(unique(1).is_ok());
        assert!(candidate_relation(IdentityKind::Dialog,true,||panic!("matching dialog must never take exclusion mode")).is_err());
        assert!(identity_kind("AXWindow","AXSystemDialog").is_err());assert!(identity_kind("AXWindow","AXSheet").is_err());
        assert!(exclude_non_target_dialog(Ok(true),||panic!("modal must stop relation"),||panic!("modal must stop CG")).is_err());
        assert!(exclusion_identity(IdentityKind::Dialog,7,7,Ok(true)).is_err());
    }
    #[test]fn excluded_dialog_fresh_missing_then_advertised_sheet_never_caches_absence(){
        let calls=std::cell::Cell::new(0);
        assert!(relationship_edges(RelationshipMode::ExcludedDialog,false,true,||panic!("first no edge query")).is_ok());
        assert!(relationship_edges(RelationshipMode::ExcludedDialog,true,true,||{calls.set(calls.get()+1);Ok(1)}).is_err());assert_eq!(calls.get(),1);
        for reason in ["ax_unsupported","ax_no_value","ax_query_error","ax_wrong_type"] {
            assert_eq!(relationship_edges(RelationshipMode::ExcludedDialog,true,true,||{calls.set(calls.get()+1);Err(reason)}),Err(reason));
        }
        assert_eq!(calls.get(),5);
        for advertised in [false,true] {
            assert_eq!(relationship_edges(RelationshipMode::ExcludedDialog,advertised,false,||panic!("children missing must prevent query")),Err("bootstrap_excluded_dialog_children_missing"));
            assert_eq!(relationship_edges(RelationshipMode::MatchedOrdinary,advertised,false,||panic!("children missing must prevent query")),Err("bootstrap_target_relationship_children_missing"));
        }
        assert!(empty_sheets(false,||panic!("shared old helper remains strict")).is_err());
    }
    #[test]fn non_target_dialog_needs_complete_exclusion_and_never_becomes_target(){
        let calls=std::cell::Cell::new(0);
        assert!(candidate_relation(IdentityKind::Dialog,false,||{calls.set(calls.get()+1);Ok(())}).is_ok());
        assert_eq!(calls.get(),1);
        for reason in ["bootstrap_non_target_dialog_not_excludable","bootstrap_non_target_relationship_unknown","bootstrap_parent_mismatch","identity_cg_mismatch","ax_query_error"] {
            assert_eq!(candidate_relation(IdentityKind::Dialog,false,||Err(reason)),Err(reason));
        }
        assert_eq!(candidate_relation(IdentityKind::Dialog,true,||panic!("matching dialog must not be filtered")),Err("bootstrap_matched_target_not_ordinary"));
        assert!(candidate_relation(IdentityKind::Ordinary,false,||panic!("unrelated ordinary readiness unchanged")).is_ok());
        let mut matches=0;let excluded=std::cell::Cell::new(0);
        for (kind,matched) in [(IdentityKind::Ordinary,true),(IdentityKind::Dialog,false)] {
            candidate_relation(kind,matched,|| {
                excluded.set(excluded.get()+1);
                exclude_non_target_dialog(Ok(false),||Ok(()),||Ok(()))
            }).unwrap();
            target_ready(matched,||matched_target_kind("AXWindow","AXStandardWindow")).unwrap();
            if matched{matches+=1;}
        }
        assert_eq!(excluded.get(),1);assert!(unique(matches).is_ok());
    }
    #[test]fn matching_target_recheck_refuses_ordinary_to_dialog_change(){
        assert_eq!(matched_target_kind("AXWindow","AXStandardWindow"),Ok(()));
        for subrole in ["AXDialog","AXSystemDialog","AXSheet",""] {
            assert_eq!(matched_target_kind("AXWindow",subrole),Err("bootstrap_matched_target_not_ordinary"));
        }
        assert!(matched_target_kind("AXUnknown","AXStandardWindow").is_err());
        assert!(title_matches(Err("bootstrap_identity_title_unknown")).is_err());
        assert!(unique(2).is_err());
    }
    #[test]fn non_target_dialog_exclusion_checks_actual_complete_gate_in_order(){
        assert!(exclusion_identity(IdentityKind::Dialog,7,7,Ok(false)).is_ok());
        for (kind,id,matched) in [(IdentityKind::Ordinary,7,Ok(false)),(IdentityKind::Dialog,8,Ok(false)),
            (IdentityKind::Dialog,7,Ok(true)),(IdentityKind::Dialog,7,Err("ax_query_error"))] {
            assert_eq!(exclusion_identity(kind,id,7,matched),Err("bootstrap_non_target_identity_changed"));
        }
        for modal in [Ok(true),Err("ax_unsupported"),Err("ax_query_error")] {
            assert_eq!(exclude_non_target_dialog(modal,||panic!("modal unknown must stop relationship query"),||panic!("modal unknown must stop CG query")),Err("bootstrap_non_target_dialog_not_excludable"));
        }
        for reason in ["ax_sheet_present","bootstrap_parent_mismatch","bootstrap_non_target_relationship_unknown","bootstrap_children_limit"] {
            assert_eq!(exclude_non_target_dialog(Ok(false),||Err(reason),||panic!("relationship unknown must stop CG")),Err(reason));
        }
        assert_eq!(exclude_non_target_dialog(Ok(false),||Ok(()),||Err("identity_cg_mismatch")),Err("identity_cg_mismatch"));
        let calls=std::cell::RefCell::new(Vec::new());
        assert!(exclude_non_target_dialog(Ok(false),||{calls.borrow_mut().push("relations");Ok(())},||{calls.borrow_mut().push("cg");Ok(())}).is_ok());
        assert_eq!(*calls.borrow(),vec!["relations","cg"]);
    }
    struct Fake {reads:Arc<std::sync::atomic::AtomicUsize>,writes:Arc<std::sync::atomic::AtomicUsize>,
        values:std::collections::VecDeque<usize>,write_error:bool,focus_error:bool}
    impl Backend for Fake {
        type Candidate=usize;
        fn trusted(&mut self)->bool{true}
        fn discover(&mut self,_:&Command)->Result<usize,&'static str>{self.reads.fetch_add(1,Ordering::SeqCst);Ok(self.values.pop_front().unwrap_or(1))}
        fn same(&self,before:&usize,after:&usize)->bool{before==after}
        fn identity(&self,_:&usize)->(i32,u32){(7,8)}
        fn activate(&mut self,_:&usize,command:&Command)->Result<(),&'static str>{command.alive()?;command.started.store(true,Ordering::SeqCst);
            self.writes.fetch_add(1,Ordering::SeqCst);if self.write_error{Err("bootstrap_activation_unconfirmed")}else{Ok(())}}
        fn foreground(&mut self,_:&usize,_:&Command)->Result<(),&'static str>{if self.focus_error{Err("bootstrap_foreground_unconfirmed")}else{Ok(())}}
        fn task_proof(&mut self,candidate:&usize,command:&Command)->Result<Value,&'static str>{command.alive()?;
            if *candidate!=1{return Err("task_retained_changed");}
            Ok(json!({"status":"fake_task_proof","input_authorized":false}))}
    }
    fn fake(values:Vec<usize>,write_error:bool,focus_error:bool)->(mpsc::SyncSender<Command>,thread::JoinHandle<()>,Arc<std::sync::atomic::AtomicUsize>,Arc<std::sync::atomic::AtomicUsize>){
        let (sender,receiver)=mpsc::sync_channel(1);let reads=Arc::new(std::sync::atomic::AtomicUsize::new(0));let writes=Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let backend=Fake {reads:reads.clone(),writes:writes.clone(),values:values.into(),write_error,focus_error};
        let handle=thread::spawn(move||worker(receiver,Arc::new(AtomicBool::new(false)),backend));(sender,handle,reads,writes)
    }
    async fn ask(sender:&mpsc::SyncSender<Command>,activate:bool,reference:Option<String>)->ToolResult {
        let (mut command,receiver)=command();command.activate=activate;command.reference=reference;
        sender.send(command).unwrap();receiver.await.unwrap()
    }
    async fn ask_task(sender:&mpsc::SyncSender<Command>,reference:String)->ToolResult {
        let (mut request,receiver)=command();request.activate=false;request.task_proof=true;request.reference=Some(reference);
        sender.send(request).unwrap();receiver.await.unwrap()
    }
    #[tokio::test]async fn task_target_actor_proof_retains_same_spent_lease_for_finalization_and_never_reactivates(){
        let (sender,handle,reads,writes)=fake(vec![1;7],false,false);
        let candidate=ask(&sender,false,None).await;let reference=candidate.structured_content.unwrap()["candidate_ref"].as_str().unwrap().to_owned();
        assert_ne!(ask(&sender,true,Some(reference.clone())).await.is_error,Some(true));
        assert_ne!(ask_task(&sender,reference.clone()).await.is_error,Some(true));
        assert_ne!(ask(&sender,false,Some(reference.clone())).await.is_error,Some(true));
        assert_eq!(ask(&sender,true,Some(reference)).await.is_error,Some(true));
        assert_eq!(reads.load(Ordering::SeqCst),7);assert_eq!(writes.load(Ordering::SeqCst),1);drop(sender);handle.join().unwrap();
    }
    #[tokio::test]async fn task_target_actor_repeated_proof_or_replacement_destroys_lease_without_new_write(){
        for changed in [false,true]{
            let values=if changed{vec![1,1,1,1,2]}else{vec![1;6]};let (sender,handle,_reads,writes)=fake(values,false,false);
            let candidate=ask(&sender,false,None).await;let reference=candidate.structured_content.unwrap()["candidate_ref"].as_str().unwrap().to_owned();
            assert_ne!(ask(&sender,true,Some(reference.clone())).await.is_error,Some(true));
            let proof=ask_task(&sender,reference.clone()).await;
            if changed{assert_eq!(proof.is_error,Some(true));}else{assert_ne!(proof.is_error,Some(true));
                assert_eq!(ask_task(&sender,reference.clone()).await.is_error,Some(true));}
            assert_eq!(ask(&sender,true,Some(reference)).await.is_error,Some(true));
            assert_eq!(writes.load(Ordering::SeqCst),1);drop(sender);handle.join().unwrap();
        }
    }
    #[tokio::test]async fn real_actor_pipeline_keeps_spent_object_until_final_read_and_never_rewrites(){
        let (sender,handle,reads,writes)=fake(vec![1;5],false,false);
        let candidate=ask(&sender,false,None).await;
        let reference=candidate.structured_content.unwrap()["candidate_ref"].as_str().unwrap().to_owned();
        assert_ne!(ask(&sender,true,Some(reference.clone())).await.is_error,Some(true));
        assert_ne!(ask(&sender,false,Some(reference.clone())).await.is_error,Some(true));
        assert_eq!(ask(&sender,true,Some(reference)).await.is_error,Some(true));
        assert_eq!(writes.load(Ordering::SeqCst),1);assert_eq!(reads.load(Ordering::SeqCst),5);
        drop(sender);handle.join().unwrap();
    }
    #[tokio::test]async fn actor_unknown_write_replacement_and_final_focus_failure_are_terminal(){
        for (values,write_error,focus_error,expected_writes) in [(vec![1,1,2],false,false,0),(vec![1;5],true,false,1),(vec![1;5],false,true,1)] {
            let (sender,handle,_reads,writes)=fake(values,write_error,focus_error);
            let candidate=ask(&sender,false,None).await;
            let reference=candidate.structured_content.unwrap()["candidate_ref"].as_str().unwrap().to_owned();
            let activated=ask(&sender,true,Some(reference.clone())).await;
            if focus_error {
                assert_ne!(activated.is_error,Some(true));
                let final_result=ask(&sender,false,Some(reference.clone())).await;
                assert_eq!(final_result.is_error,Some(true));assert_eq!(final_result.structured_content.unwrap()["activation_started"],true);
            }else{assert_eq!(activated.is_error,Some(true));}
            assert_eq!(ask(&sender,true,Some(reference)).await.is_error,Some(true));
            assert_eq!(writes.load(Ordering::SeqCst),expected_writes);
            drop(sender);handle.join().unwrap();
        }
    }
    #[tokio::test]async fn actor_expired_and_closed_queued_commands_make_zero_queries(){
        let (sender,handle,reads,writes)=fake(vec![1;5],false,false);
        let (mut expired,receiver)=command();expired.activate=false;expired.reference=None;expired.deadline=Instant::now();
        sender.send(expired).unwrap();assert_eq!(receiver.await.unwrap().is_error,Some(true));
        let (mut closed,receiver)=command();closed.activate=false;closed.reference=None;drop(receiver);sender.send(closed).unwrap();
        drop(sender);handle.join().unwrap();assert_eq!(reads.load(Ordering::SeqCst),0);assert_eq!(writes.load(Ordering::SeqCst),0);
    }
    fn manifest_context(source:&str)->Arc<cua_driver_core::session_authorization::EffectiveAuthorizationContext> {
        use cua_driver_core::{authorization::PermissionMode,session_authorization::{SessionModeCeiling,SessionAuthorizationRegistry}};
        use std::io::Write;
        // No new crate/feature dependency. Pure test file, no OS GUI/query.
        let path=std::env::temp_dir().join(format!("cua-bootstrap-manifest-{}.yaml",uuid::Uuid::new_v4()));
        let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(&path).unwrap();
        file.write_all(source.as_bytes()).unwrap();drop(file);
        let manifest=Arc::new(cua_driver_core::session_manifest::load_manifest(&path).expect("real manifest loads"));
        std::fs::remove_file(path).unwrap();
        let ceiling=SessionModeCeiling::for_trusted_sessions([PermissionMode::Standard],false,Duration::from_secs(60),Duration::from_secs(30)).unwrap();
        SessionAuthorizationRegistry::with_ceiling(ceiling).compatibility_context(PermissionMode::Standard,Some(manifest)).unwrap()
    }
    #[tokio::test]async fn task_target_real_tool_canonical_allow_reaches_actor_and_denied_read_never_queues(){
        let proof=super::super::get_target_window_topology::TASK_PROOF;
        let (queue,receiver)=mpsc::sync_channel(1);let client=Arc::new(Client{queue,stop:Arc::new(AtomicBool::new(false))});
        let mut denied=ToolRegistry::new();denied.register(Box::new(BootstrapTool{client,activate:false,task_proof:true}));
        let deny=format!("version: 3\nallow:\n  tools: [{proof}]\ndeny:\n  tools: [{DISCOVER}]\nresources:\n  controlled_textedit_identity: true\n  controlled_textedit_task_target: true\n");
        let context=manifest_context(&deny);let nonce=uuid::Uuid::new_v4().to_string();
        assert_eq!(denied.invoke_with_context(proof,json!({"candidate_ref":uuid::Uuid::new_v4().to_string(),"request_nonce":nonce}),context).await.is_error,Some(true));
        assert!(matches!(receiver.try_recv(),Err(mpsc::TryRecvError::Empty)));
        let (sender,handle,reads,writes)=fake(vec![1;7],false,false);let client=Arc::new(Client{queue:sender.clone(),stop:Arc::new(AtomicBool::new(false))});
        let mut registry=ToolRegistry::new();for (activate,task_proof) in [(false,false),(true,false),(false,true)]{
            registry.register(Box::new(BootstrapTool{client:client.clone(),activate,task_proof}));}
        let allow=format!("version: 3\nallow:\n  tools: [{DISCOVER}, {ACTIVATE}, {proof}]\nresources:\n  controlled_textedit_identity: true\n  controlled_textedit_activation: true\n  controlled_textedit_task_target: true\n");
        let context=manifest_context(&allow);let read=json!({"bundle_id":BUNDLE,"document_title":TITLE,"request_nonce":nonce});
        let candidate=registry.invoke_with_context(DISCOVER,read.clone(),context.clone()).await;assert_ne!(candidate.is_error,Some(true));
        let reference=candidate.structured_content.unwrap()["candidate_ref"].as_str().unwrap().to_owned();let bound=json!({"candidate_ref":reference,"request_nonce":nonce});
        assert_ne!(registry.invoke_with_context(ACTIVATE,bound.clone(),context.clone()).await.is_error,Some(true));
        assert_ne!(registry.invoke_with_context(proof,bound,context.clone()).await.is_error,Some(true));
        let mut final_read=read;final_read["candidate_ref"]=json!(reference);
        assert_ne!(registry.invoke_with_context(DISCOVER,final_read,context).await.is_error,Some(true));
        assert_eq!(reads.load(Ordering::SeqCst),7);assert_eq!(writes.load(Ordering::SeqCst),1);
        drop(registry);drop(client);drop(sender);handle.join().unwrap();
    }
    #[tokio::test]async fn canonical_real_tools_reach_fake_actor_only_with_both_grants(){
        let allow=format!("version: 3\nallow:\n  tools: [{DISCOVER}, {ACTIVATE}]\nresources:\n  controlled_textedit_identity: true\n  controlled_textedit_activation: true\n");
        for denied in [DISCOVER,ACTIVATE] {
            let other=if denied==DISCOVER{ACTIVATE}else{DISCOVER};
            let source=format!("version: 3\nallow:\n  tools: [{other}]\ndeny:\n  tools: [{denied}]\nresources:\n  controlled_textedit_identity: true\n  controlled_textedit_activation: true\n");
            let (sender,handle,reads,writes)=fake(vec![1;5],false,false);
            let client=Arc::new(Client {queue:sender.clone(),stop:Arc::new(AtomicBool::new(false))});let mut registry=ToolRegistry::new();
            registry.register(Box::new(BootstrapTool {client,activate:true,task_proof:false}));
            let context=manifest_context(&source);assert_eq!(context.capability_manifest().unwrap().decision(denied),cua_driver_core::session_manifest::ManifestDecision::Deny);
            let answer=registry.invoke_with_context(ACTIVATE,json!({"candidate_ref":uuid::Uuid::new_v4().to_string(),"request_nonce":uuid::Uuid::new_v4().to_string()}),context).await;
            assert_eq!(answer.is_error,Some(true));drop(registry);drop(sender);handle.join().unwrap();
            assert_eq!(reads.load(Ordering::SeqCst),0);assert_eq!(writes.load(Ordering::SeqCst),0);
        }
        let (sender,handle,reads,writes)=fake(vec![1;5],false,false);
        let client=Arc::new(Client {queue:sender.clone(),stop:Arc::new(AtomicBool::new(false))});let mut registry=ToolRegistry::new();
        registry.register(Box::new(BootstrapTool {client:client.clone(),activate:false,task_proof:false}));registry.register(Box::new(BootstrapTool {client,activate:true,task_proof:false}));
        let context=manifest_context(&allow);let nonce=uuid::Uuid::new_v4().to_string();
        let args=json!({"bundle_id":BUNDLE,"document_title":TITLE,"request_nonce":nonce});
        let candidate=registry.invoke_with_context(DISCOVER,args.clone(),context.clone()).await;
        assert_ne!(candidate.is_error,Some(true));
        let reference=candidate.structured_content.unwrap()["candidate_ref"].as_str().unwrap().to_owned();
        let answer=registry.invoke_with_context(ACTIVATE,json!({"candidate_ref":reference,"request_nonce":nonce}),context.clone()).await;
        assert_ne!(answer.is_error,Some(true));
        let mut final_args=args;final_args["candidate_ref"]=json!(reference);
        let answer=registry.invoke_with_context(DISCOVER,final_args,context).await;
        assert_ne!(answer.is_error,Some(true));assert_eq!(answer.structured_content.unwrap()["status"],"finalized");
        assert_eq!(reads.load(Ordering::SeqCst),5);assert_eq!(writes.load(Ordering::SeqCst),1);
        drop(registry);drop(sender);handle.join().unwrap();
    }
}
