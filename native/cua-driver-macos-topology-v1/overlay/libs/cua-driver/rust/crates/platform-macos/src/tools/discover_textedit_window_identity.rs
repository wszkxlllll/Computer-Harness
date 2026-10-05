//! Explicit, bounded TextEdit identity discovery. No content, global inventory,
//! capture, input, focus, launch, or OS permission prompts. Identity is a fresh
//! candidate only: the existing fixed-target topology admission stays separate.
use std::{collections::HashSet, ffi::c_void, sync::OnceLock, time::{Duration, Instant}};
use async_trait::async_trait;
use core_foundation::{array::{CFArray, CFArrayRef, CFArrayCreate}, base::{CFEqual, CFGetTypeID, CFTypeRef, TCFType, kCFAllocatorDefault},
    dictionary::CFDictionary, number::{CFNumber,CFNumberIsFloatType}, string::CFString};
use objc2::rc::Retained;
use objc2::runtime::NSObjectProtocol;
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::NSString;
use serde_json::{json, Value};
use cua_driver_core::{protocol::ToolResult, tool::{Tool, ToolDef}};
use crate::ax::bindings::*;
use super::get_target_window_topology::{AxReader, OwnedAx, ordinary_root};

pub const NAME: &str = "discover_textedit_window_identity";
pub const BUNDLE: &str = "com.apple.TextEdit";
pub(super) fn running_application_equal(before:&NSRunningApplication,after:&NSRunningApplication)->bool {
    // Documented instance identity, not Objective-C object address or PID.
    // Locked objc2 0.5 NSObjectProtocol takes &AnyObject.
    before.isEqual(after.as_ref())
}
const MAX_MS: u64 = 3000;
static DEF: OnceLock<ToolDef> = OnceLock::new();
#[link(name="CoreGraphics", kind="framework")]
extern "C" { fn CGWindowListCreateDescriptionFromArray(window_array: CFArrayRef) -> CFArrayRef; }
pub struct TextEditWindowIdentityTool;

fn request(args: &Value) -> Result<String, &'static str> {
    let object = args.as_object().ok_or("identity_arguments_invalid")?;
    if object.len() != 2 || !object.keys().all(|k| matches!(k.as_str(), "bundle_id" | "request_nonce"))
        || args["bundle_id"] != BUNDLE { return Err("identity_bundle_not_authorized"); }
    uuid::Uuid::parse_str(args["request_nonce"].as_str().ok_or("identity_nonce_invalid")?)
        .map(|n| n.to_string()).map_err(|_| "identity_nonce_invalid")
}

#[async_trait]
impl Tool for TextEditWindowIdentityTool {
    fn def(&self) -> &ToolDef {
        DEF.get_or_init(|| ToolDef { name:NAME.into(), description:
            "Explicit TextEdit-only ordinary-window numeric identity candidate. No content or activation; does not authorize subsequent window actions.".into(),
            input_schema:json!({"type":"object","required":["bundle_id","request_nonce"],
                "properties":{"bundle_id":{"type":"string","const":BUNDLE},"request_nonce":{"type":"string","format":"uuid"}},"additionalProperties":false}),
            read_only:true, destructive:false, idempotent:false, open_world:false })
    }
    async fn invoke(&self, mut args: Value) -> ToolResult {
        cua_driver_core::tool_args::sanitize_reserved_args(&mut args);
        let nonce = match request(&args) { Ok(n) => n, Err(reason) => return unknown(reason, None) };
        // Registry policy/authorization precedes this invocation. No worker is
        // constructed until schema passes. ObjC/AX retains never cross await.
        match tokio::task::spawn_blocking(move || sample(&nonce)).await {
            Ok(Ok(value)) => ToolResult::text("TextEdit identity candidate; fixed-target verification required.").with_structured(value),
            Ok(Err(failure)) => {
                let mut result=unknown(failure.reason,None);
                if let (Some(value),Some(diagnostic))=(result.structured_content.as_mut(),failure.diagnostic) {
                    value["instance_diagnostic"]=diagnostic;
                }
                result
            },
            Err(_) => unknown("identity_worker_failed", None),
        }
    }
}

fn unknown(reason: &'static str, nonce: Option<&str>) -> ToolResult {
    ToolResult::error("TextEdit identity discovery not verified.").with_structured(json!({
        "schema_version":1,"producer_version":"harness-textedit-identity-v1",
        "scope":"com.apple.TextEdit-ordinary-window-identity","read_only":true,
        "status":"unknown","reason_code":reason,"request_nonce":nonce
    }))
}
fn deadline(start: Instant) -> Result<(), &'static str> {
    if start.elapsed() > Duration::from_millis(MAX_MS) { Err("identity_deadline") } else { Ok(()) }
}
fn unique_count(count: usize, reason: &'static str) -> Result<(), &'static str> {
    if count == 1 { Ok(()) } else { Err(reason) }
}

#[derive(Clone, Copy)]
enum InstanceSample { First, Second }
impl InstanceSample { fn label(self)->&'static str { match self {Self::First=>"first",Self::Second=>"second"} } }
const MAX_INSTANCE_ITEMS:usize=32;
struct IdentityFailure { reason:&'static str, diagnostic:Option<Value> }
impl From<&'static str> for IdentityFailure {
    fn from(reason:&'static str)->Self { Self {reason,diagnostic:None} }
}
#[derive(Clone,Copy)]
enum BundleMatch { Match, Mismatch, Missing }
struct InstanceItem { pid:i32, object:usize, terminated:bool, bundle:BundleMatch }
fn instance_diagnostic(count:usize, phase:InstanceSample, mut item:impl FnMut(usize)->InstanceItem)->Value {
    if count>MAX_INSTANCE_ITEMS {
        return json!({"sample_phase":phase.label(),"count_class":"over_limit","inspection_complete":false});
    }
    let mut pids=HashSet::new(); let mut objects=HashSet::new();
    let (mut positive,mut duplicate,mut terminated,mut invalid,mut matches,mut mismatches,mut missing)=(0usize,0usize,0usize,0usize,0usize,0usize,0usize);
    for index in 0..count {
        let value=item(index);
        if value.pid>0 { positive+=1; pids.insert(value.pid); } else { invalid+=1; }
        if !objects.insert(value.object) { duplicate+=1; }
        if value.terminated { terminated+=1; }
        match value.bundle {BundleMatch::Match=>matches+=1,BundleMatch::Mismatch=>mismatches+=1,BundleMatch::Missing=>missing+=1}
    }
    json!({"sample_phase":phase.label(),"count_class":"bounded_multiple","inspection_complete":true,
        "total_items":count,"positive_pid_items":positive,"distinct_positive_pid_count":pids.len(),
        "duplicate_object_items":duplicate,"terminated_items":terminated,"invalid_pid_items":invalid,
        "bundle_match_items":matches,"bundle_mismatch_items":mismatches,"bundle_missing_items":missing})
}
fn instance_count_reason(count:usize, sample:InstanceSample) -> Result<(),&'static str> {
    match (count,sample) {
        (1,_) => Ok(()),
        (0,InstanceSample::First) => Err("identity_instance_first_not_found"),
        (0,InstanceSample::Second) => Err("identity_instance_second_not_found"),
        (_,InstanceSample::First) => Err("identity_instance_first_multiple"),
        (_,InstanceSample::Second) => Err("identity_instance_second_multiple"),
    }
}
unsafe fn application(sample:InstanceSample) -> Result<Retained<NSRunningApplication>, IdentityFailure> {
    let applications = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(BUNDLE));
    let count=applications.count();
    if let Err(reason)=instance_count_reason(count,sample) {
        // Diagnose only this returned fixed-bundle array. Never remove entries,
        // deduplicate into acceptance, query windows, or emit identities.
        let diagnostic=if count>=2 {Some(instance_diagnostic(count,sample,|index| {
            let app=applications.objectAtIndex(index);
            let bundle=match app.bundleIdentifier() {
                Some(value) if value.to_string()==BUNDLE=>BundleMatch::Match,
                Some(_)=>BundleMatch::Mismatch, None=>BundleMatch::Missing,
            };
            InstanceItem {pid:app.processIdentifier(),object:(&*app as *const NSRunningApplication) as usize,
                terminated:app.isTerminated(),bundle}
        }))} else {None};
        return Err(IdentityFailure {reason,diagnostic});
    }
    let application = applications.objectAtIndex(0);
    if application.isTerminated() || application.processIdentifier() <= 0
        || application.bundleIdentifier().as_ref().map(|s| s.to_string()).as_deref() != Some(BUNDLE) {
        return Err("identity_instance_invalid".into());
    }
    Ok(application)
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct CgIdentity { pid:i32, window_id:u32, layer:i32, bounds:[f64;4] }
impl CgIdentity {pub(super) fn task_bounds(&self)->[f64;4]{self.bounds}}
#[derive(Clone,Copy,Debug,PartialEq)]
pub(super) enum CgPurpose {VisibleIdentity,ExcludedDialog}
#[derive(Clone,Copy,Debug,PartialEq)]
enum Field<T> {Missing,WrongType,Conversion,Value(T)}
#[derive(Clone,Copy,Debug,PartialEq)]
pub(super) struct CgFailure {pub reason:&'static str,field:&'static str,class:&'static str}
impl CgFailure {
    pub(super) fn diagnostic(self,purpose:CgPurpose)->Value {json!({"phase":if purpose==CgPurpose::ExcludedDialog {"excluded_dialog_cg"}else{"target_cg"},"field":self.field,"error_class":self.class})}
}
fn cg_failure(field:&'static str,class:&'static str)->CgFailure {
    CgFailure {reason:match class {"not_ordered_missing"|"not_ordered_false"=>"identity_cg_not_visible","mismatch"=>"identity_cg_identity_mismatch",_=>"identity_cg_invalid"},field,class}
}
fn required<T>(field:Field<T>,name:&'static str)->Result<T,CgFailure> {
    match field {Field::Value(value)=>Ok(value),Field::Missing=>Err(cg_failure(name,"missing")),Field::WrongType=>Err(cg_failure(name,"wrong_type")),Field::Conversion=>Err(cg_failure(name,"conversion"))}
}
// Only the window ID uses the SDK's signed32 bit representation. Never apply
// this reinterpretation to PIDs/layers or arbitrary negative i64 values.
pub(super) fn cg_window_id(value:i64)->Option<u32> {
    if value<0 {i32::try_from(value).ok().map(|value|value as u32)}else{u32::try_from(value).ok()}
}
fn cg_record(pid:i32,id:u32,purpose:CgPurpose,owner:Field<i64>,number:Field<i64>,layer:Field<i64>,visible:Field<bool>,bounds:Field<[Field<f64>;4]>)->Result<CgIdentity,CgFailure> {
    let owner=i32::try_from(required(owner,"owner")?).map_err(|_|cg_failure("owner","out_of_range"))?;
    let number=cg_window_id(required(number,"id")?).filter(|value|*value>0).ok_or(cg_failure("id","out_of_range"))?;
    let layer=i32::try_from(required(layer,"layer")?).map_err(|_|cg_failure("layer","out_of_range"))?;
    if owner<=0 {return Err(cg_failure("owner","out_of_range"));}
    if owner!=pid {return Err(cg_failure("owner","mismatch"));}
    if number!=id || id==0 {return Err(cg_failure("id","mismatch"));}
    if layer!=0 {return Err(cg_failure("layer","mismatch"));}
    // Optional absent means not ordered, never true. Explicit false is another
    // valid provenance of not ordered; malformed values are never absence.
    match visible {
        Field::Value(true)=>(),Field::Missing|Field::Value(false) if purpose==CgPurpose::ExcludedDialog=>(),
        Field::Missing=>return Err(cg_failure("onscreen","not_ordered_missing")),
        Field::Value(false)=>return Err(cg_failure("onscreen","not_ordered_false")),
        Field::WrongType=>return Err(cg_failure("onscreen","wrong_type")),Field::Conversion=>return Err(cg_failure("onscreen","conversion")),
    }
    let values=required(bounds,"bounds")?;let mut decoded=[0.0;4];
    for (index,name) in ["x","y","width","height"].iter().enumerate() {
        let value=required(values[index],name)?;
        if !value.is_finite() || value.abs()>1e9 || (index>=2 && value<=0.0) {return Err(cg_failure(name,"out_of_range"));}
        decoded[index]=value;
    }
    Ok(CgIdentity {pid:owner,window_id:number,layer,bounds:decoded})
}
#[cfg(test)]
fn cg_fields(pid:i32, window_id:u32, owner:Option<i64>, id:Option<i64>, layer:Option<i64>, visible:Option<bool>, bounds:[Option<f64>;4]) -> Result<CgIdentity,&'static str> {
    let owner=owner.and_then(|v|i32::try_from(v).ok()).ok_or("identity_cg_invalid")?;
    let id=id.and_then(|v|u32::try_from(v).ok()).ok_or("identity_cg_invalid")?;
    let layer=layer.and_then(|v|i32::try_from(v).ok()).ok_or("identity_cg_invalid")?;
    if visible!=Some(true) { return Err("identity_cg_not_visible"); }
    let [Some(x),Some(y),Some(width),Some(height)] = bounds else { return Err("identity_cg_invalid"); };
    if ![x,y,width,height].iter().all(|v|v.is_finite() && v.abs()<=1e9) || width<=0.0 || height<=0.0 { return Err("identity_cg_invalid"); }
    if owner!=pid || id!=window_id || layer!=0 || pid<=0 || window_id==0 { return Err("identity_cg_identity_mismatch"); }
    Ok(CgIdentity { pid:owner,window_id:id,layer,bounds:[x,y,width,height] })
}
fn stable_pair(pid:i32, second_pid:i32, id:u32, second_id:u32, same_application:bool, same_ax:bool,
    before:&CgIdentity, after:&CgIdentity) -> Result<(),&'static str> {
    if !application_and_pid(same_application,pid,second_pid) || !same_ax || id!=second_id || before!=after { Err("identity_changed") } else { Ok(()) }
}
pub(super) fn application_and_pid(equal:bool,pid:i32,second_pid:i32)->bool {equal && pid==second_pid}
fn child_role(role:&str) -> Result<(),&'static str> { child_kind(role,None) }
pub(super) fn empty_sheets(advertised:bool, query:impl FnOnce()->Result<usize,&'static str>) -> Result<(),&'static str> {
    if !advertised { return Err("identity_attached_relationship_unknown"); }
    if query()? != 0 { return Err("identity_attached_window"); }
    Ok(())
}
pub(super) fn child_kind(role:&str, subrole:Option<&str>) -> Result<(),&'static str> {
    if subrole.is_some_and(|sub|matches!(sub,"AXDialog"|"AXSystemDialog"|"AXSheet"|"AXFloatingWindow"|"AXPopover")) { return Err("identity_attached_window"); }
    if subrole==Some("AXUnknownSubrole") { return Err("identity_child_role_unknown"); }
    match role {
        "AXWindow"|"AXSheet"|"AXDialog"|"AXSystemDialog"|"AXMenu"|"AXPopover" => Err("identity_attached_window"),
        "AXGroup"|"AXScrollArea"|"AXTextArea"|"AXTextField"|"AXButton"|"AXStaticText"|"AXToolbar"|
        "AXSplitGroup"|"AXSplitter"|"AXCheckBox"|"AXRadioButton"|"AXPopUpButton"|"AXMenuButton"|"AXImage"|
        "AXList"|"AXTable"|"AXRow"|"AXColumn"|"AXCell"|"AXLayoutArea"|"AXLayoutItem"|"AXLink"|
        "AXSlider"|"AXValueIndicator"|"AXProgressIndicator"|"AXBusyIndicator"|"AXRuler"|"AXRulerMarker" => Ok(()),
        _ => Err("identity_child_role_unknown"),
    }
}
fn integer_value(is_number:bool,is_float:impl FnOnce()->bool,convert:impl FnOnce()->Option<i64>)->Field<i64> {
    if !is_number || is_float(){return Field::WrongType;}
    convert().map(Field::Value).unwrap_or(Field::Conversion)
}
unsafe fn typed_integer(dict:&CFDictionary<*const c_void,*const c_void>,key:&str)->Field<i64> {
    let Some(value)=dict.find(CFString::new(key).as_concrete_TypeRef() as *const c_void) else{return Field::Missing;};
    let value=*value as CFTypeRef;
    integer_value(CFGetTypeID(value)==CFNumber::type_id(),||CFNumberIsFloatType(value as _)!=0,
        ||CFNumber::wrap_under_get_rule(value as _).to_i64())
}
unsafe fn typed_number(dict:&CFDictionary<*const c_void,*const c_void>,key:&str)->Field<f64> {
    let Some(value)=dict.find(CFString::new(key).as_concrete_TypeRef() as *const c_void) else{return Field::Missing;};
    let value=*value as CFTypeRef;
    if CFGetTypeID(value)!=CFNumber::type_id(){return Field::WrongType;}
    CFNumber::wrap_under_get_rule(value as _).to_f64().map(Field::Value).unwrap_or(Field::Conversion)
}
fn exact_description_request<T>(window_id:u32, query:impl FnOnce(&[*const c_void;1])->Result<T,&'static str>) -> Result<T,&'static str> {
    if window_id == 0 { return Err("identity_cg_invalid"); }
    // CGWindowID arrays contain pointer-sized integer values, NOT CFNumbers,
    // pointers to u32 storage or CFTypes. See Apple's SonOfGrab sample.
    query(&[window_id as usize as *const c_void])
}
pub(super) unsafe fn cg_identity(pid:i32, window_id:u32) -> Result<CgIdentity, &'static str> {
    cg_identity_for(pid,window_id,CgPurpose::VisibleIdentity).map_err(|failure|failure.reason)
}
pub(super) unsafe fn cg_identity_for(pid:i32, window_id:u32,purpose:CgPurpose) -> Result<CgIdentity,CgFailure> {
    // Request precisely this ID. IncludingWindow alone is not an exact-list
    // contract; never fall back to a global/relative list and filter its rows.
    let pointer = exact_description_request(window_id,|ids| {
        let input = CFArrayCreate(kCFAllocatorDefault,ids.as_ptr(),1,std::ptr::null());
        if input.is_null() { return Err("identity_cg_failed"); }
        // NULL callbacks: integer slots are never retained/released as CFTypes.
        let input = CFArray::<*const c_void>::wrap_under_create_rule(input);
        Ok(CGWindowListCreateDescriptionFromArray(input.as_concrete_TypeRef()))
    }).map_err(|reason|CgFailure {reason,field:"description",class:"unavailable"})?;
    if pointer.is_null() { return Err(CgFailure {reason:"identity_cg_failed",field:"description",class:"unavailable"}); }
    if CFGetTypeID(pointer as CFTypeRef) != CFArray::<CFTypeRef>::type_id() {
        core_foundation::base::CFRelease(pointer as CFTypeRef); return Err(CgFailure {reason:"identity_cg_type",field:"description",class:"wrong_type"});
    }
    let rows = CFArray::<CFTypeRef>::wrap_under_create_rule(pointer);
    unique_count(rows.len() as usize, "identity_cg_ambiguous").map_err(|reason|CgFailure {reason,field:"description",class:if rows.len()==0{"empty"}else{"multiple"}})?;
    let item = *rows.iter().next().ok_or(CgFailure {reason:"identity_cg_ambiguous",field:"description",class:"empty"})?;
    if CFGetTypeID(item) != CFDictionary::<*const c_void,*const c_void>::type_id() { return Err(CgFailure {reason:"identity_cg_type",field:"description",class:"wrong_type"}); }
    let dict = CFDictionary::<*const c_void,*const c_void>::wrap_under_get_rule(item as _);
    let owner=typed_integer(&dict,"kCGWindowOwnerPID");let id=typed_integer(&dict,"kCGWindowNumber");let layer=typed_integer(&dict,"kCGWindowLayer");
    let visible=match dict.find(CFString::new("kCGWindowIsOnscreen").as_concrete_TypeRef() as *const c_void) {
        None=>Field::Missing,Some(value)=>{let value=*value as CFTypeRef;
            if CFGetTypeID(value)!=core_foundation::boolean::CFBoolean::type_id(){Field::WrongType}
            else{Field::Value(bool::from(core_foundation::boolean::CFBoolean::wrap_under_get_rule(value as _)))}}
    };
    let bounds=match dict.find(CFString::new("kCGWindowBounds").as_concrete_TypeRef() as *const c_void) {
        None=>Field::Missing,Some(value)=>{let value=*value as CFTypeRef;
            if CFGetTypeID(value)!=CFDictionary::<*const c_void,*const c_void>::type_id(){Field::WrongType}
            else{let bounds=CFDictionary::<*const c_void,*const c_void>::wrap_under_get_rule(value as _);
                Field::Value([typed_number(&bounds,"X"),typed_number(&bounds,"Y"),typed_number(&bounds,"Width"),typed_number(&bounds,"Height")])}}
    };
    cg_record(pid,window_id,purpose,owner,id,layer,visible,bounds)
}

unsafe fn window(reader:&mut AxReader, pid:i32) -> Result<OwnedAx,&'static str> {
    let pointer = AXUIElementCreateApplication(pid);
    if pointer.is_null() { return Err("identity_ax_unavailable"); }
    let app = OwnedAx(pointer);
    let app_names = reader.names(app.0)?;
    if reader.pid(app.0)? != pid || !app_names.contains("AXWindows") || !app_names.contains("AXHidden") { return Err("identity_ax_scope_unknown"); }
    if reader.boolean(app.0,"AXHidden")? { return Err("identity_instance_hidden"); }
    let mut windows = reader.elements(app.0,"AXWindows")?;
    unique_count(windows.len(),"identity_window_ambiguous")?;
    let root = windows.pop().ok_or("identity_window_ambiguous")?;
    let names = reader.names(root.0)?;
    if reader.pid(root.0)? != pid || !names.contains("AXRole") || !names.contains("AXSubrole") || !names.contains("AXMinimized") || !names.contains("AXModal") {
        return Err("identity_ax_scope_unknown");
    }
    let role = reader.string(root.0,"AXRole")?;
    let subrole = reader.string(root.0,"AXSubrole")?;
    ordinary_root(&role, Some(&subrole))?;
    if reader.boolean(root.0,"AXMinimized")? { return Err("identity_window_minimized"); }
    if reader.boolean(root.0,"AXModal")? { return Err("identity_attached_window"); }
    if names.contains("AXHidden") && reader.boolean(root.0,"AXHidden")? { return Err("identity_window_hidden"); }
    // Do not filter attached sheets away to manufacture a unique ordinary root.
    empty_sheets(names.contains("AXSheets"),||Ok(reader.elements(root.0,"AXSheets")?.len()))?;
    if !names.contains("AXChildren") { return Err("identity_attached_relationship_unknown"); }
    // Bounded direct-root relationship evidence, not a claim of global absence.
    // Any malformed/unmapped item refuses; never filter it into a unique root.
    let children=reader.elements(root.0,"AXChildren")?;
    if children.len()>128 { return Err("identity_children_limit"); }
    for child in children {
        let child_names=reader.names(child.0)?;
        if reader.pid(child.0)?!=pid { return Err("identity_parent_mismatch"); }
        let child_subrole=if child_names.contains("AXSubrole") {Some(reader.string(child.0,"AXSubrole")?)} else {None};
        child_kind(&reader.string(child.0,"AXRole")?,child_subrole.as_deref())?;
        let parent=reader.element(child.0,"AXParent")?;
        if CFEqual(parent.0 as CFTypeRef,root.0 as CFTypeRef)==0 { return Err("identity_parent_mismatch"); }
    }
    if !names.contains("AXParent") { return Err("identity_parent_unknown"); }
    let parent = reader.element(root.0,"AXParent")?;
    if CFEqual(parent.0 as CFTypeRef, app.0 as CFTypeRef) == 0 { return Err("identity_parent_mismatch"); }
    Ok(root)
}

fn sample(nonce:&str) -> Result<Value,IdentityFailure> {
    if !crate::permissions::status::accessibility_granted() { return Err("identity_accessibility_required".into()); }
    let start = Instant::now();
    unsafe {
        let before = application(InstanceSample::First)?;
        let pid = before.processIdentifier();
        let mut reader = AxReader::identity_reader(start);
        let first = window(&mut reader,pid)?;
        let window_id = reader.window_id(first.0)?;
        let cg_before = cg_identity(pid,window_id)?;
        deadline(start)?;
        let second = window(&mut reader,pid)?;
        let second_id = reader.window_id(second.0)?;
        let after = application(InstanceSample::Second)?;
        let same_instance = running_application_equal(&before,&after);
        if before.isTerminated() || after.isTerminated() { return Err("identity_changed".into()); }
        let cg_after = cg_identity(pid,window_id)?;
        stable_pair(pid,after.processIdentifier(),window_id,second_id,same_instance,
            CFEqual(first.0 as CFTypeRef,second.0 as CFTypeRef)!=0,&cg_before,&cg_after)?;
        deadline(start)?;
        Ok(json!({"schema_version":1,"producer_version":"harness-textedit-identity-v1",
            "source_commit":"d114f35fec05ecd37bf529e5587be86852205b64","scope":"com.apple.TextEdit-ordinary-window-identity",
            "read_only":true,"status":"verified","reason_code":"verified","bundle_id":BUNDLE,
            "pid":pid,"window_id":window_id,"request_nonce":nonce,"sample_epoch":uuid::Uuid::new_v4().to_string(),
            "elapsed_ms":start.elapsed().as_millis() as u64,"candidate_only":true,"identity_lifecycle":"bounded-observation"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn exact_bundle_and_nonce_only() {
        let nonce=uuid::Uuid::new_v4().to_string();
        assert_eq!(request(&json!({"bundle_id":BUNDLE,"request_nonce":nonce})).unwrap(),nonce);
        for args in [json!({"bundle_id":"com.apple.Terminal","request_nonce":nonce}),json!({"bundle_id":BUNDLE,"request_nonce":"private"}),
            json!({"bundle_id":BUNDLE,"request_nonce":nonce,"pid":1}),json!({"request_nonce":nonce}),Value::Null] { assert!(request(&args).is_err()); }
    }
    #[test] fn no_filtered_unique_or_empty_success() { assert!(unique_count(1,"ambiguous").is_ok()); for n in [0,2,2049] { assert!(unique_count(n,"ambiguous").is_err()); } }
    #[test] fn instance_count_diagnostic_preserves_exact_one_and_sample_phase() {
        for phase in [InstanceSample::First,InstanceSample::Second] { assert!(instance_count_reason(1,phase).is_ok()); }
        assert_eq!(instance_count_reason(0,InstanceSample::First).unwrap_err(),"identity_instance_first_not_found");
        assert_eq!(instance_count_reason(0,InstanceSample::Second).unwrap_err(),"identity_instance_second_not_found");
        for count in [2,2049,usize::MAX] {
            assert_eq!(instance_count_reason(count,InstanceSample::First).unwrap_err(),"identity_instance_first_multiple");
            assert_eq!(instance_count_reason(count,InstanceSample::Second).unwrap_err(),"identity_instance_second_multiple");
        }
    }
    #[test] fn ordinary_root_must_be_actual() { assert!(ordinary_root("AXWindow",Some("AXStandardWindow")).is_ok()); for sub in [None,Some("AXSheet"),Some("AXDialog"),Some("AXSystemDialog"),Some("AXFloatingWindow")] { assert!(ordinary_root("AXWindow",sub).is_err()); } }
    #[test] fn bounded_multiple_properties_never_manufacture_unique_acceptance() {
        let values=[InstanceItem {pid:41,object:7,terminated:false,bundle:BundleMatch::Match},
            InstanceItem {pid:41,object:7,terminated:true,bundle:BundleMatch::Missing},
            InstanceItem {pid:-1,object:8,terminated:true,bundle:BundleMatch::Mismatch}];
        let diagnostic=instance_diagnostic(values.len(),InstanceSample::First,|index| {
            let item=&values[index]; InstanceItem {pid:item.pid,object:item.object,terminated:item.terminated,bundle:item.bundle}
        });
        assert_eq!(diagnostic["total_items"],3); assert_eq!(diagnostic["positive_pid_items"],2);
        assert_eq!(diagnostic["distinct_positive_pid_count"],1); assert_eq!(diagnostic["duplicate_object_items"],1);
        assert_eq!(diagnostic["terminated_items"],2); assert_eq!(diagnostic["invalid_pid_items"],1);
        for key in ["bundle_match_items","bundle_mismatch_items","bundle_missing_items"] {assert_eq!(diagnostic[key],1);}
        assert!(instance_count_reason(values.len(),InstanceSample::First).is_err());
        assert!(diagnostic.get("pid").is_none()); assert!(diagnostic.get("object").is_none());
    }
    #[test] fn oversized_array_has_zero_property_access_and_no_partial_counts() {
        for count in [33,usize::MAX] {
            let mut hits=0;
            let value=instance_diagnostic(count,InstanceSample::Second,|_| {hits+=1;panic!("must not inspect oversized array")});
            assert_eq!(hits,0); assert_eq!(value["count_class"],"over_limit");
            assert_eq!(value["inspection_complete"],false); assert_eq!(value.as_object().unwrap().len(),3);
            assert!(instance_count_reason(count,InstanceSample::Second).is_err());
        }
        let mut hits=0;
        let value=instance_diagnostic(32,InstanceSample::Second,|index| {hits+=1;InstanceItem {pid:1,object:index,terminated:false,bundle:BundleMatch::Match}});
        assert_eq!(hits,32);assert_eq!(value["total_items"],32);
    }
    #[test] fn descriptor_is_private_read_only_and_exact() { let tool=TextEditWindowIdentityTool; assert!(tool.def().read_only); assert!(!tool.def().destructive); assert_eq!(tool.def().input_schema["properties"]["bundle_id"]["const"],BUNDLE); }
    fn cg() -> CgIdentity { cg_fields(41,u32::MAX,Some(41),Some(i64::from(u32::MAX)),Some(0),Some(true),[Some(1.0),Some(2.0),Some(640.0),Some(480.0)]).unwrap() }
    #[test]fn semantic_instance_and_numeric_identity_are_independent_required_evidence(){
        assert!(application_and_pid(true,41,41));assert!(!application_and_pid(false,41,41));assert!(!application_and_pid(true,41,42));
        let observed=cg();
        assert!(stable_pair(41,41,u32::MAX,u32::MAX,true,true,&observed,&observed).is_ok());
        assert!(stable_pair(41,41,u32::MAX,u32::MAX,false,true,&observed,&observed).is_err());
        assert!(stable_pair(41,42,u32::MAX,u32::MAX,true,true,&observed,&observed).is_err());
        assert!(stable_pair(41,41,u32::MAX,u32::MAX,true,false,&observed,&observed).is_err());
        let mut changed=observed.clone();changed.bounds[0]+=1.0;
        assert!(stable_pair(41,41,u32::MAX,u32::MAX,true,true,&observed,&changed).is_err());
    }
    fn decoded(purpose:CgPurpose,visible:Field<bool>)->Result<CgIdentity,CgFailure> {
        cg_record(41,7,purpose,Field::Value(41),Field::Value(7),Field::Value(0),visible,
            Field::Value([Field::Value(0.0),Field::Value(0.0),Field::Value(640.0),Field::Value(480.0)]))
    }
    #[test]fn cg_visibility_qualification_is_explicit_and_never_defaults_malformed_to_absence(){
        for (visible,class) in [(Field::Missing,"not_ordered_missing"),(Field::Value(false),"not_ordered_false")] {
            assert_eq!(decoded(CgPurpose::VisibleIdentity,visible).unwrap_err(),cg_failure("onscreen",class));
            assert!(decoded(CgPurpose::ExcludedDialog,visible).is_ok());
        }
        for purpose in [CgPurpose::VisibleIdentity,CgPurpose::ExcludedDialog] {
            assert!(decoded(purpose,Field::Value(true)).is_ok());
            for (visible,class) in [(Field::WrongType,"wrong_type"),(Field::Conversion,"conversion")] {
                assert_eq!(decoded(purpose,visible).unwrap_err(),cg_failure("onscreen",class));
            }
        }
    }
    #[test]fn cg_integer_decoder_is_lossless_and_only_window_id_reinterprets_signed32(){
        assert_eq!(integer_value(false,||panic!("wrong type must short circuit"),||panic!("no conversion")),Field::WrongType);
        assert_eq!(integer_value(true,||true,||panic!("floating integer field must not truncate")),Field::WrongType);
        assert_eq!(integer_value(true,||false,||None),Field::Conversion);
        assert_eq!(integer_value(true,||false,||Some(7)),Field::Value(7));
        for (number,id) in [(7,7),(-1,u32::MAX),(i64::from(i32::MIN),0x80000000),(i64::from(u32::MAX),u32::MAX)] {
            assert_eq!(cg_window_id(number),Some(id));
            assert!(cg_record(41,id,CgPurpose::VisibleIdentity,Field::Value(41),Field::Value(number),Field::Value(0),Field::Value(true),
                Field::Value([Field::Value(0.0),Field::Value(0.0),Field::Value(1.0),Field::Value(1.0)])).is_ok());
        }
        for number in [i64::MIN,i64::from(i32::MIN)-1,i64::from(u32::MAX)+1,i64::MAX] {assert_eq!(cg_window_id(number),None);}
        assert!(cg_record(41,7,CgPurpose::ExcludedDialog,Field::Value(-1),Field::Value(7),Field::Value(0),Field::Missing,Field::Missing).is_err());
    }
    #[test]fn cg_required_fields_do_not_relax_for_excluded_dialog(){
        let bounds=Field::Value([Field::Value(0.0),Field::Value(0.0),Field::Value(1.0),Field::Value(1.0)]);
        for purpose in [CgPurpose::VisibleIdentity,CgPurpose::ExcludedDialog] {
            for bad in [Field::Missing,Field::WrongType,Field::Conversion] {
                for index in 0..3 {let mut fields=[Field::Value(41),Field::Value(7),Field::Value(0)];fields[index]=bad;
                    assert_eq!(cg_record(41,7,purpose,fields[0],fields[1],fields[2],Field::Value(true),bounds).unwrap_err().field,["owner","id","layer"][index]);}
            }
            for (owner,id,layer,field) in [(42,7,0,"owner"),(41,8,0,"id"),(41,7,1,"layer"),(i64::MAX,7,0,"owner"),(41,7,i64::MAX,"layer")] {
                assert_eq!(cg_record(41,7,purpose,Field::Value(owner),Field::Value(id),Field::Value(layer),Field::Value(true),bounds).unwrap_err().field,field);
            }
        }
    }
    #[test]fn cg_bounds_and_fixed_failure_projection_preserve_first_invalid_field(){
        for purpose in [CgPurpose::VisibleIdentity,CgPurpose::ExcludedDialog] {
            for bad in [Field::Missing,Field::WrongType,Field::Conversion] {
                assert_eq!(cg_record(41,7,purpose,Field::Value(41),Field::Value(7),Field::Value(0),Field::Value(true),bad).unwrap_err().field,"bounds");
            }
            for index in 0..4 {for bad in [Field::Missing,Field::WrongType,Field::Conversion,Field::Value(f64::NAN),Field::Value(f64::INFINITY),Field::Value(1e10)] {
                let mut values=[Field::Value(0.0),Field::Value(0.0),Field::Value(1.0),Field::Value(1.0)];values[index]=bad;
                let failure=cg_record(41,7,purpose,Field::Value(41),Field::Value(7),Field::Value(0),Field::Value(true),Field::Value(values)).unwrap_err();
                assert_eq!(failure.field,["x","y","width","height"][index]);assert_eq!(failure.diagnostic(purpose).as_object().unwrap().len(),3);
            }}
            for size in [0.0,-1.0] {assert!(cg_record(41,7,purpose,Field::Value(41),Field::Value(7),Field::Value(0),Field::Value(true),Field::Value([Field::Value(0.0),Field::Value(0.0),Field::Value(size),Field::Value(1.0)])).is_err());}
        }
    }
    #[test] fn exact_description_uses_one_raw_id_without_fallback_or_truncation() {
        for id in [1,7,u32::MAX] {
            let mut calls=0;
            let result=exact_description_request(id,|ids| { calls+=1; assert_eq!(ids.len(),1); assert_eq!(ids[0] as usize,id as usize); Ok(id) });
            assert_eq!(result,Ok(id)); assert_eq!(calls,1);
            let mut failures=0;
            assert_eq!(exact_description_request::<()>(id,|_| {failures+=1;Err("identity_cg_failed")}),Err("identity_cg_failed"));
            assert_eq!(failures,1);
        }
        assert_eq!(exact_description_request::<()>(0,|_| panic!("zero ID must not query")),Err("identity_cg_invalid"));
    }
    #[test] fn exact_description_empty_multiple_and_invalid_rows_still_refuse() {
        for count in [0,2,32,usize::MAX] { assert_eq!(unique_count(count,"identity_cg_ambiguous"),Err("identity_cg_ambiguous")); }
        assert!(unique_count(1,"identity_cg_ambiguous").is_ok());
        let bounds=[Some(0.0),Some(0.0),Some(640.0),Some(480.0)];
        assert!(cg_fields(41,7,Some(42),Some(7),Some(0),Some(true),bounds).is_err());
        assert!(cg_fields(41,7,Some(41),Some(8),Some(0),Some(true),bounds).is_err());
        assert!(cg_fields(41,7,Some(41),Some(7),Some(0),Some(false),bounds).is_err());
        assert!(cg_fields(41,7,Some(41),Some(7),Some(0),Some(true),[Some(0.0),Some(0.0),None,Some(480.0)]).is_err());
    }
    #[test] fn cg_missing_malformed_owner_and_visibility_never_default() {
        let bounds=[Some(0.0),Some(0.0),Some(640.0),Some(480.0)];
        for (owner,id,layer,visible) in [(None,Some(7),Some(0),Some(true)),(Some(41),None,Some(0),Some(true)),
            (Some(41),Some(7),None,Some(true)),(Some(41),Some(7),Some(0),None),(Some(41),Some(7),Some(0),Some(false)),
            (Some(42),Some(7),Some(0),Some(true)),(Some(41),Some(8),Some(0),Some(true)),(Some(41),Some(7),Some(1),Some(true))] {
            assert!(cg_fields(41,7,owner,id,layer,visible,bounds).is_err());
        }
        for width in [None,Some(0.0),Some(-1.0),Some(f64::NAN),Some(f64::INFINITY)] {
            assert!(cg_fields(41,7,Some(41),Some(7),Some(0),Some(true),[Some(0.0),Some(0.0),width,Some(480.0)]).is_err());
        }
        assert_eq!(cg().window_id,u32::MAX);
    }
    #[test] fn retained_object_and_both_numeric_samples_must_match() {
        let a=cg(); assert!(stable_pair(41,41,u32::MAX,u32::MAX,true,true,&a,&a).is_ok());
        for (pid,id,app,ax) in [(42,u32::MAX,true,true),(41,1,true,true),(41,u32::MAX,false,true),(41,u32::MAX,true,false)] {
            assert!(stable_pair(41,pid,u32::MAX,id,app,ax,&a,&a).is_err());
        }
        let mut b=a.clone(); b.bounds[0]+=1.0; assert!(stable_pair(41,41,u32::MAX,u32::MAX,true,true,&a,&b).is_err());
    }
    #[test] fn attached_and_unknown_children_are_not_filtered() {
        for role in ["AXSheet","AXWindow","AXDialog","AXMenu","AXPopover","AXUnknown","AXInvented",""] { assert!(child_role(role).is_err()); }
        for role in ["AXGroup","AXScrollArea","AXTextArea","AXButton"] { assert!(child_role(role).is_ok()); }
        for subrole in ["AXSheet","AXDialog","AXSystemDialog","AXPopover","AXUnknownSubrole"] { assert!(child_kind("AXGroup",Some(subrole)).is_err()); }
    }
    #[test] fn sheets_unknown_query_error_and_presence_are_not_absence() {
        let mut calls=0; assert_eq!(empty_sheets(false,||{ calls+=1; Ok(0) }).unwrap_err(),"identity_attached_relationship_unknown"); assert_eq!(calls,0);
        for error in ["ax_unsupported","ax_query_error","ax_array_type","ax_duplicate_child"] { assert_eq!(empty_sheets(true,||Err(error)).unwrap_err(),error); }
        assert!(empty_sheets(true,||Ok(0)).is_ok()); assert!(empty_sheets(true,||Ok(1)).is_err());
    }
    #[tokio::test] async fn invalid_request_stops_before_native_sampler() {
        let result=TextEditWindowIdentityTool.invoke(json!({"bundle_id":"com.apple.Terminal","request_nonce":uuid::Uuid::new_v4().to_string()})).await;
        assert_eq!(result.is_error,Some(true)); assert_eq!(result.structured_content.unwrap()["reason_code"],"identity_bundle_not_authorized");
    }
}
