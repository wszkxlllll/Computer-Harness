//! Harness topology v2 overlay on Cua d114f35fec05ecd37bf529e5587be86852205b64.
//! Read-only CG all-layer snapshots and strict target AX ancestry. No capture,
//! activation, input, AX enablement, title/value reads, or element index cache.
use std::collections::HashSet;
use std::ffi::c_void;
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use async_trait::async_trait;
use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{CFEqual, CFGetTypeID, CFRelease, CFTypeRef, TCFType},
    dictionary::CFDictionary,
    number::{CFNumber, CFNumberIsFloatType},
    string::CFString,
};
use cua_driver_core::{protocol::ToolResult, tool::{Tool, ToolDef}};
use serde_json::{json, Value};
use crate::ax::bindings::*;
use crate::input::skylight::{EvidenceFailure,evidence_failure};

const MAX_ROWS: usize = 4096;
const MAX_NODES: usize = 2048;
const MAX_DEPTH: usize = 40;
const MAX_MS: u64 = 6000;
const MAX_QUERIES: usize = 32768;
const SOURCE_COMMIT: &str = "d114f35fec05ecd37bf529e5587be86852205b64";
const SCOPE: &str = "target-ax-closure-cg-all-layers-v1";
static EPOCH: OnceLock<String> = OnceLock::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static DEF: OnceLock<ToolDef> = OnceLock::new();
static CAP_DEF: OnceLock<ToolDef> = OnceLock::new();
// Observation-only CF identity retains, never registered in the actuator
// element cache. At most 16 targets * (root + 32 visible overlay objects).
static IDENTITIES: OnceLock<Mutex<Vec<((i32,u32), IdentitySnapshot)>>> = OnceLock::new();
struct IdentityRef { pointer: usize, token: String }
impl Drop for IdentityRef { fn drop(&mut self) { unsafe { CFRelease(self.pointer as CFTypeRef); } } }
struct IdentitySnapshot { root: IdentityRef, overlays: Vec<IdentityRef>, sampled: Instant }
unsafe fn retained_identity(pointer: usize, token: String) -> IdentityRef {
    core_foundation::base::CFRetain(pointer as CFTypeRef);
    IdentityRef { pointer, token }
}
unsafe fn identity_tokens(pid: i32, window_id: u32, root: usize, overlays: &[usize]) -> Result<(String,Vec<String>), &'static str> {
    let mut cache = IDENTITIES.get_or_init(|| Mutex::new(Vec::new())).lock().map_err(|_| "identity_cache_unavailable")?;
    cache.retain(|(_, snapshot)| snapshot.sampled.elapsed() < Duration::from_secs(180));
    let previous = cache.iter().position(|(target,_)| *target == (pid,window_id)).map(|index| cache.remove(index).1);
    let root_matches = previous.as_ref().is_some_and(|snapshot| CFEqual(snapshot.root.pointer as CFTypeRef, root as CFTypeRef) != 0);
    let root_token = if root_matches { previous.as_ref().unwrap().root.token.clone() } else { uuid::Uuid::new_v4().to_string() };
    let tokens: Vec<String> = overlays.iter().map(|pointer| {
        if root_matches {
            if let Some(known) = previous.as_ref().unwrap().overlays.iter().find(|known| CFEqual(known.pointer as CFTypeRef,*pointer as CFTypeRef) != 0) {
                return known.token.clone();
            }
        }
        uuid::Uuid::new_v4().to_string()
    }).collect();
    let snapshot = IdentitySnapshot { root: retained_identity(root,root_token.clone()),
        overlays: overlays.iter().zip(tokens.iter()).map(|(pointer,token)| retained_identity(*pointer,token.clone())).collect(),
        sampled: Instant::now() };
    if cache.len() >= 16 { cache.remove(0); }
    cache.push(((pid,window_id),snapshot));
    // previous references are dropped only after every CFEqual/retain while
    // holding the lock; no raw pointers appear in output or input routing.
    Ok((root_token,tokens))
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(options: u32, relative_to_window: u32) -> CFArrayRef;
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    fn AXValueGetTypeID() -> core_foundation::base::CFTypeID;
}

pub struct TargetWindowTopologyTool;
pub struct TargetWindowTopologyCapabilitiesTool;

// Separate task capability. Nothing in this mode upgrades v2 metadata or
// grants capture/input. It is only registered by the explicit finite host.
pub(super) const TASK_PROOF: &str = "prove_controlled_textedit_task_target";
pub(super) const TASK_CAP: &str = "get_controlled_textedit_task_target_capabilities";
pub(super) const TASK_SCOPE: &str = "com.apple.TextEdit-controlled-document-task-target";
pub(super) fn task_capability() -> Value {
    json!({"schema_version":1,"producer_version":"harness-controlled-textedit-task-target-v1",
        "source_commit":SOURCE_COMMIT,"scope":TASK_SCOPE,"read_only":true,
        "global_topology_complete":false,"input_authorized":false,"run_ref_issued":false,
        "identity_lifecycle":"actor-retained-bounded-observation","max_rows":MAX_ROWS,
        "max_nodes":MAX_NODES,"max_elapsed_ms":MAX_MS,"max_queries":MAX_QUERIES})
}
pub(super) struct ControlledTaskCapabilitiesTool;
#[async_trait]
impl Tool for ControlledTaskCapabilitiesTool {
    fn def(&self)->&ToolDef {static TASK_DEF:OnceLock<ToolDef>=OnceLock::new();
        TASK_DEF.get_or_init(||tool_def(TASK_CAP,json!({"type":"object","properties":{},"additionalProperties":false})))}
    async fn invoke(&self,mut args:Value)->ToolResult {
        cua_driver_core::tool_args::sanitize_reserved_args(&mut args);
        if !args.as_object().is_some_and(|o|o.is_empty()){return ToolResult::error("Task capability request invalid.");}
        ToolResult::text("Controlled task target capability v1; no input grant.").with_structured(task_capability())
    }
}

fn capability() -> Value {
    json!({
        "schema_version": 2, "producer_version": "harness-topology-v2",
        "source_commit": SOURCE_COMMIT, "scope": SCOPE, "read_only": true,
        "global_topology_complete": false, "identity_lifecycle": "bounded-observation",
        "max_rows": MAX_ROWS, "max_nodes": MAX_NODES, "max_elapsed_ms": MAX_MS, "max_queries": MAX_QUERIES
    })
}

fn tool_def(name: &str, schema: Value) -> ToolDef {
    ToolDef { name: name.into(),
        description: "Read-only versioned exact-target CG/AX topology evidence. Bounded observation, not OS lifecycle or global ownership proof. No screenshots or content.".into(),
        input_schema: schema, read_only: true, destructive: false, idempotent: name.ends_with("_capabilities"), open_world: false }
}

#[async_trait]
impl Tool for TargetWindowTopologyCapabilitiesTool {
    fn def(&self) -> &ToolDef {
        CAP_DEF.get_or_init(|| tool_def("get_target_window_topology_capabilities", json!({
            "type":"object", "properties":{}, "additionalProperties":false
        })))
    }
    async fn invoke(&self, mut args: Value) -> ToolResult {
        cua_driver_core::tool_args::sanitize_reserved_args(&mut args);
        if !args.as_object().is_some_and(|value| value.is_empty()) {
            return ToolResult::error("Topology capability request schema invalid.");
        }
        ToolResult::text("Target topology capability v2.").with_structured(capability())
    }
}

#[async_trait]
impl Tool for TargetWindowTopologyTool {
    fn def(&self) -> &ToolDef {
        DEF.get_or_init(|| tool_def("get_target_window_topology", json!({
            "type":"object", "required":["pid","window_id","request_nonce"],
            "properties":{"pid":{"type":"integer","minimum":1,"maximum":2147483647},
                "window_id":{"type":"integer","minimum":1,"maximum":u32::MAX},
                "request_nonce":{"type":"string","format":"uuid"}}, "additionalProperties":false
        })))
    }
    async fn invoke(&self, mut args: Value) -> ToolResult {
        cua_driver_core::tool_args::sanitize_reserved_args(&mut args);
        let request = (|| {
            let object = args.as_object()?;
            if object.len() != 3 { return None; }
            let pid = i32::try_from(args["pid"].as_i64()?).ok().filter(|v| *v > 0)?;
            let window_id = u32::try_from(args["window_id"].as_u64()?).ok().filter(|v| *v > 0)?;
            let nonce = args["request_nonce"].as_str()?;
            let nonce = uuid::Uuid::parse_str(nonce).ok()?.to_string();
            Some((pid, window_id, nonce))
        })();
        let Some((pid, window_id, nonce)) = request else {
            return ToolResult::error("Topology target request schema invalid.");
        };
        match tokio::task::spawn_blocking(move || sample(pid, window_id, nonce)).await {
            Ok(value) if value["status"] == "verified" => ToolResult::text("Verified bounded target topology.").with_structured(value),
            Ok(value) => ToolResult::error("Target topology is unknown; no mutation performed.").with_structured(value),
            Err(_) => ToolResult::error("Target topology worker unavailable; no mutation performed."),
        }
    }
}

fn elapsed(start: Instant) -> u64 { start.elapsed().as_millis().min(u64::MAX as u128) as u64 }
fn deadline(start: Instant) -> Result<(), &'static str> {
    if start.elapsed() >= Duration::from_millis(MAX_MS) { Err("deadline") } else { Ok(()) }
}

fn sample(pid: i32, window_id: u32, nonce: String) -> Value {
    let start = Instant::now();
    let started = SystemTime::now().duration_since(UNIX_EPOCH).map(|v| v.as_millis() as u64).unwrap_or(0);
    let mut value = capability();
    value["target"] = json!({"pid":pid,"window_id":window_id});
    value["request_nonce"] = json!(nonce);
    value["session_epoch"] = json!(EPOCH.get_or_init(|| uuid::Uuid::new_v4().to_string()));
    value["sequence"] = json!(SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1);
    value["started_unix_ms"] = json!(started);
    let before = cg_snapshot(start);
    // Never query any AX process until an exact CG target is present once.
    let target_present = exact_target(&before, pid, window_id);
    let ax = if target_present { unsafe { ax_closure(pid, window_id, start, &before) } }
        else { ax_unknown("target_unresolved", 0, 0) };
    let after = cg_snapshot(start);
    let stable = before["status"] == "success" && after["status"] == "success" && before["rows"] == after["rows"];
    let cg_complete = before["status"] == "success" && after["status"] == "success";
    let ax_complete = ax["status"] == "success" && ax["closure_complete"] == true;
    let verified = stable && cg_complete && ax_complete && exact_target(&after, pid, window_id) && elapsed(start) <= MAX_MS;
    value["status"] = json!(if verified {"verified"} else {"unknown"});
    value["reason_code"] = json!(if verified {"verified"} else if !cg_complete {"cg_unknown"} else if !stable {"snapshot_changed"} else if !ax_complete {"ax_unknown"} else {"target_unresolved"});
    value["cg_enumeration_complete"] = json!(cg_complete);
    value["target_closure_complete"] = json!(ax_complete);
    value["stable"] = json!(stable);
    value["cg_before"] = before;
    value["cg_after"] = after;
    value["ax"] = ax;
    value["elapsed_ms"] = json!(elapsed(start));
    value
}

fn exact_target(snapshot: &Value, pid: i32, window_id: u32) -> bool {
    snapshot["status"] == "success" && snapshot["rows"].as_array().is_some_and(|rows|
        rows.iter().filter(|row| row["pid"] == pid && row["window_id"] == window_id && row["layer"] == 0).count() == 1)
}

// v2 above remains unchanged. Public identity/geometry and private Space
// evidence are separate in this task-only contract; no row is discarded.
fn task_space(target:bool,ids:Result<Vec<u64>,EvidenceFailure>,current:impl FnOnce()->Result<u64,EvidenceFailure>)->Result<Value,EvidenceFailure> {
    match ids {
        Err(failure) if !target && failure==evidence_failure("space_set","empty")=>
            Ok(json!({"status":"not_proven","reason_code":"typed_empty"})),
        Err(failure)=>Err(failure),
        Ok(ids)=>{let (ids,current)=complete_window_spaces_result(ids,current)?;
            Ok(json!({"status":"verified","space_ids":ids,"current_space_id":current}))},
    }
}
unsafe fn task_public_row(item:CFTypeRef,z:usize,spaces:&crate::input::skylight::SpaceQuery,pid:i32,id:u32)->Result<Value,EvidenceFailure> {
    if item.is_null() || CFGetTypeID(item)!=CFDictionary::<*const c_void,*const c_void>::type_id(){return Err(evidence_failure("row","wrong_type"));}
    let dict=CFDictionary::<*const c_void,*const c_void>::wrap_under_get_rule(item as _);
    let (window_id,owner,layer)=cg_integer_identity_result(|key,field|dict_integer_result(&dict,key,field))?;
    let pointer=dict_value(&dict,"kCGWindowBounds").ok_or(evidence_failure("bounds","missing"))?;
    if pointer.is_null() || CFGetTypeID(pointer)!=CFDictionary::<*const c_void,*const c_void>::type_id(){return Err(evidence_failure("bounds","wrong_type"));}
    let bounds=CFDictionary::<*const c_void,*const c_void>::wrap_under_get_rule(pointer as _);
    let [x,y,width,height]=cg_row_geometry(|key,field|dict_float_result(&bounds,key,field))?;
    let space=task_space(owner==pid && window_id==id,spaces.task_window_space_ids_result(window_id),||spaces.current_space_for_window_result(window_id))?;
    Ok(json!({"pid":owner,"window_id":window_id,"layer":layer,"z_index":z,
        "bounds":{"x":x,"y":y,"width":width,"height":height},"space":space}))
}
fn task_rows(total:usize,mut read:impl FnMut(usize)->Result<Value,EvidenceFailure>,mut guard:impl FnMut()->Result<(),&'static str>)->Result<Vec<Value>,&'static str> {
    if total==0 || total>MAX_ROWS{return Err("task_public_limit");}
    let mut rows=Vec::with_capacity(total);let mut ids=HashSet::new();
    for index in 0..total {guard()?;let row=read(index).map_err(|_|"task_public_invalid")?;
        let id=row["window_id"].as_u64().ok_or("task_public_invalid")?;
        if !ids.insert(id){return Err("task_public_duplicate");}rows.push(row);}
    Ok(rows)
}
fn task_snapshot(start:Instant,pid:i32,id:u32,mut guard:impl FnMut()->Result<(),&'static str>)->Result<Vec<Value>,&'static str> {
    guard()?;deadline(start)?;
    let pointer=unsafe{CGWindowListCopyWindowInfo(1,0)};
    if pointer.is_null(){return Err("task_public_unavailable");}
    if unsafe{CFGetTypeID(pointer as CFTypeRef)}!=CFArray::<CFTypeRef>::type_id(){unsafe{CFRelease(pointer as CFTypeRef);}return Err("task_public_invalid");}
    let raw:CFArray<CFTypeRef>=unsafe{CFArray::wrap_under_create_rule(pointer)};
    let total=raw.len() as usize;
    if total==0 || total>MAX_ROWS{return Err("task_public_limit");}
    let spaces=crate::input::skylight::SpaceQuery::new().ok_or("task_space_unavailable")?;
    task_rows(total,|index|unsafe{task_public_row(*raw.get(index as _).ok_or(evidence_failure("row","missing"))?,total-index,&spaces,pid,id)},guard)
}
fn task_target_identity(rows:&[Value],pid:i32,id:u32,expected:[f64;4])->Result<usize,&'static str> {
    let matches:Vec<_>=rows.iter().filter(|row|row["window_id"]==id).collect();
    if matches.len()!=1{return Err("task_target_unresolved");}
    let target=matches[0];
    if target["pid"]!=pid || target["layer"]!=0 || target["space"]["status"]!="verified" {return Err("task_target_unresolved");}
    let bounds=&target["bounds"];
    if [bounds["x"].as_f64(),bounds["y"].as_f64(),bounds["width"].as_f64(),bounds["height"].as_f64()]!=expected.map(Some){return Err("task_target_geometry_changed");}
    let index=rows.iter().position(|row|row["window_id"]==id).ok_or("task_target_unresolved")?;
    Ok(index)
}
fn intersection_shape(target:[f64;4],other:[f64;4])->Option<&'static str>{
    let [x,y,w,h]=target;let [rx,ry,rw,rh]=other;
    if !(rx<x+w && x<rx+rw && ry<y+h && y<ry+rh){return None;}
    // Equal rectangles are contains_target, not double-counted as inside.
    Some(if rx<=x && ry<=y && rx+rw>=x+w && ry+rh>=y+h {"contains_target"}
        else if rx>=x && ry>=y && rx+rw<=x+w && ry+rh<=y+h {"inside_target"}else{"partial"})
}
fn task_intersections(rows:&[Value],index:usize,pid:i32,expected:[f64;4],phase:&'static str)->Result<Value,&'static str>{
    let mut buckets=std::collections::BTreeMap::<(&str,&str,&str,&str),usize>::new();
    let (mut total_empty,mut upper_empty,mut intersect_empty,mut intersections)=(0usize,0usize,0usize,0usize);
    for (i,row) in rows.iter().enumerate(){
        let space=match row["space"]["status"].as_str(){Some("verified")=>"verified",
            Some("not_proven") if row["space"]["reason_code"]=="typed_empty"=>"typed_empty",_=>return Err("task_public_invalid")};
        if space=="typed_empty"{total_empty+=1;}if i>=index{continue;}
        if space=="typed_empty"{upper_empty+=1;}
        let b=&row["bounds"];let (Some(x),Some(y),Some(w),Some(h))=(b["x"].as_f64(),b["y"].as_f64(),b["width"].as_f64(),b["height"].as_f64())else{return Err("task_public_invalid");};
        let Some(shape)=intersection_shape(expected,[x,y,w,h])else{continue;};
        intersections+=1;if space=="typed_empty"{intersect_empty+=1;}
        let owner=if row["pid"]==pid{"same_pid"}else{"other_pid"};
        let layer=row["layer"].as_i64().ok_or("task_public_invalid")?;
        let layer=if layer<0{"below"}else if layer==0{"equal"}else{"above"};
        *buckets.entry((owner,layer,space,shape)).or_default()+=1;
    }
    let buckets:Vec<_>=buckets.into_iter().map(|((owner,layer,space,shape),count)|json!({"owner_relation":owner,
        "layer_relation":layer,"space_state":space,"shape_relation":shape,"count":count})).collect();
    Ok(json!({"phase":phase,"public_row_count":rows.len(),"upper_row_count":index,"intersection_count":intersections,
        "typed_empty_row_count":total_empty,"upper_typed_empty_row_count":upper_empty,
        "intersection_typed_empty_row_count":intersect_empty,"buckets":buckets}))
}
fn task_target_with_diagnostic(rows:&[Value],pid:i32,id:u32,expected:[f64;4],phase:&'static str,record:impl FnOnce(Value))->Result<(),&'static str>{
    let index=task_target_identity(rows,pid,id,expected)?;
    let evidence=task_intersections(rows,index,pid,expected,phase)?;
    if evidence["intersection_count"].as_u64().is_some_and(|n|n>0){record(evidence);Err("task_upper_intersection")}else{Ok(())}
}
fn task_target(rows:&[Value],pid:i32,id:u32,expected:[f64;4])->Result<(),&'static str>{
    task_target_with_diagnostic(rows,pid,id,expected,"before",|_|{})
}
pub(super) unsafe fn task_sample(pid:i32,id:u32,root:AXUIElementRef,expected:[f64;4],nonce:&str,
    request_deadline:Instant,cancel:std::sync::Arc<std::sync::atomic::AtomicBool>,alive:impl Fn()->Result<(),&'static str>,mut diagnostic:impl FnMut(Value))->Result<Value,&'static str> {
    let start=Instant::now();alive()?;
    let before=task_snapshot(start,pid,id,||{alive()?;deadline(start)})?;
    task_target_with_diagnostic(&before,pid,id,expected,"before",&mut diagnostic)?;alive()?;
    let pointer=AXUIElementCreateApplication(pid);if pointer.is_null(){return Err("task_ax_unknown");}let app=OwnedAx(pointer);
    let mut reader=AxReader::bootstrap_reader(start,request_deadline,cancel);reader.cg_rows=before.clone();
    let names=reader.names(app.0)?;
    if !names.contains("AXFocusedWindow"){return Err("task_ax_unknown");}
    let focused=reader.element(app.0,"AXFocusedWindow")?;
    task_retained_root(CFEqual(root as CFTypeRef,focused.0 as CFTypeRef)!=0,||{
        Ok(reader.pid(focused.0)?==pid && reader.window_id(focused.0)?==id)
    })?;
    let root_names=reader.names(focused.0)?;
    if !root_names.contains("AXChildren") || !root_names.contains("AXParent"){return Err("task_ax_unknown");}
    // Actual root Parent is checked by walk; the retained root is never
    // replaced by a newly found numeric target or an opaque observation token.
    reader.walk(focused,app.0,"target".into(),pid,id,0,false)?;
    if names.contains("AXMenuBar"){let menu=reader.element(app.0,"AXMenuBar")?;reader.walk(menu,app.0,"app_menu".into(),pid,id,0,true)?;}
    if reader.unassociated_menu || !reader.overlays.is_empty(){return Err("task_ax_overlay_unknown");}
    ordinary_root(reader.root_role.as_deref().unwrap_or(""),reader.root_subrole.as_deref())?;
    alive()?;deadline(start)?;
    let after=task_snapshot(start,pid,id,||{alive()?;deadline(start)})?;
    task_target_with_diagnostic(&after,pid,id,expected,"after",&mut diagnostic)?;
    if before!=after{return Err("task_snapshot_changed");}alive()?;deadline(start)?;
    let mut value=task_capability();value["status"]=json!("verified");value["reason_code"]=json!("verified");
    value["target"]=json!({"pid":pid,"window_id":id});value["request_nonce"]=json!(nonce);
    value["public_enumeration_complete"]=json!(true);value["target_space_complete"]=json!(true);
    value["target_ax_closure_complete"]=json!(true);value["retained_identity_verified"]=json!(true);
    value["upper_intersections_absent"]=json!(true);value["stable"]=json!(true);
    value["cg_before"]=json!(before);value["cg_after"]=json!(after);
    value["ax"]=json!({"root_role":"AXWindow","root_subrole":"AXStandardWindow","query_count":reader.queries,
        "node_count":reader.nodes,"overlays":[],"unassociated_menu_present":false});value["elapsed_ms"]=json!(elapsed(start));Ok(value)
}
fn task_retained_root(equal:bool,identity:impl FnOnce()->Result<bool,&'static str>)->Result<(),&'static str>{
    if !equal || !identity()?{Err("task_retained_changed")}else{Ok(())}
}

fn cg_unknown(reason: &str, raw: usize, retained: usize, skipped: usize, duplicates: usize, rows: Vec<Value>) -> Value {
    json!({"status":"error","reason_code":reason,"raw_count":raw,"retained_count":retained,
        "skipped_count":skipped,"duplicate_count":duplicates,"rows":rows})
}

/// Unlike legacy windows.rs, no layer filter, no swallowed null/row errors,
/// no title/application-name reads and no invented zero geometry/Space values.
fn cg_snapshot(start: Instant) -> Value {
    if deadline(start).is_err() { return cg_unknown("deadline", 0, 0, 0, 0, vec![]); }
    let pointer = unsafe { CGWindowListCopyWindowInfo(1, 0) }; // OnScreenOnly, EVERY layer including desktop/system.
    if pointer.is_null() { return cg_unknown("cg_null", 0, 0, 0, 0, vec![]); }
    if unsafe { CFGetTypeID(pointer as CFTypeRef) } != CFArray::<CFTypeRef>::type_id() {
        unsafe { CFRelease(pointer as CFTypeRef); }
        return cg_unknown("cg_root_type", 0, 0, 0, 0, vec![]);
    }
    let raw: CFArray<CFTypeRef> = unsafe { CFArray::wrap_under_create_rule(pointer) };
    let total = raw.len() as usize;
    if total > MAX_ROWS { return cg_unknown("row_limit", total, 0, total, 0, vec![]); }
    let Some(space_query) = crate::input::skylight::SpaceQuery::new() else {
        return cg_unknown("space_unknown", total, 0, total, 0, vec![]);
    };
    let mut rows = Vec::new();
    let mut skipped = 0;
    let mut duplicates = 0;
    let mut identities = HashSet::new();
    let mut failures=std::collections::BTreeMap::new();
    for (index, item) in raw.iter().enumerate() {
        if deadline(start).is_err() { return cg_unknown("deadline", total, rows.len(), total - rows.len(), duplicates, rows); }
        let row = unsafe { parse_cg_row(*item, total - index, &space_query) };
        match row {
            Ok(row) if identities.insert(row["window_id"].as_u64().unwrap()) => rows.push(row),
            Ok(_) => { duplicates += 1; skipped += 1;add_row_failure(&mut failures,evidence_failure("identity","duplicate")); }
            Err(failure) => {skipped += 1;add_row_failure(&mut failures,failure);},
        }
    }
    if skipped != 0 {let mut value=cg_unknown("invalid_rows", total, rows.len(), skipped, duplicates, rows);
        value["row_failure_counts"]=row_failure_counts(&failures);return value;}
    json!({"status":"success","raw_count":total,"retained_count":rows.len(),"skipped_count":0,"duplicate_count":0,"rows":rows})
}
fn add_row_failure(failures:&mut std::collections::BTreeMap<(&'static str,&'static str),usize>,failure:EvidenceFailure) {
    *failures.entry((failure.field,failure.class)).or_default()+=1;
}
fn row_failure_counts(failures:&std::collections::BTreeMap<(&'static str,&'static str),usize>)->Value {
    json!(failures.iter().map(|((field,class),count)|json!({"field":field,"error_class":class,"count":count})).collect::<Vec<_>>())
}

unsafe fn dict_value(dict: &CFDictionary<*const c_void, *const c_void>, key: &str) -> Option<CFTypeRef> {
    dict.find(CFString::new(key).as_concrete_TypeRef() as *const c_void).map(|value| *value as CFTypeRef)
}
unsafe fn dict_integer(dict: &CFDictionary<*const c_void, *const c_void>, key: &str) -> Option<i64> {
    dict_integer_result(dict,key,"integer").ok()
}
unsafe fn dict_integer_result(dict:&CFDictionary<*const c_void,*const c_void>,key:&str,field:&'static str)->Result<i64,EvidenceFailure> {
    let value=dict_value(dict,key).ok_or(evidence_failure(field,"missing"))?;
    crate::input::skylight::strict_integer_result(!value.is_null() && CFGetTypeID(value)==CFNumber::type_id(),
        || CFNumberIsFloatType(value as _) != 0,
        || CFNumber::wrap_under_get_rule(value as _).to_i64()).map_err(|class|evidence_failure(field,class))
}
unsafe fn dict_float(dict: &CFDictionary<*const c_void, *const c_void>, key: &str) -> Option<f64> {
    dict_float_result(dict,key,"float").ok()
}
unsafe fn dict_float_result(dict:&CFDictionary<*const c_void,*const c_void>,key:&str,field:&'static str)->Result<f64,EvidenceFailure> {
    let value=dict_value(dict,key).ok_or(evidence_failure(field,"missing"))?;
    if value.is_null() || CFGetTypeID(value)!=CFNumber::type_id(){return Err(evidence_failure(field,"wrong_type"));}
    let number=CFNumber::wrap_under_get_rule(value as _).to_f64().ok_or(evidence_failure(field,"conversion"))?;
    finite_row_float(field,number)
}
fn finite_row_float(field:&'static str,number:f64)->Result<f64,EvidenceFailure> {
    if !number.is_finite() || number.abs()>1e9{return Err(evidence_failure(field,"out_of_range"));}Ok(number)
}
fn cg_row_geometry(mut read:impl FnMut(&str,&'static str)->Result<f64,EvidenceFailure>)->Result<[f64;4],EvidenceFailure> {
    let x=read("X","x")?;let y=read("Y","y")?;let width=read("Width","width")?;let height=read("Height","height")?;
    if width<=0.0{return Err(evidence_failure("width","nonpositive"));}if height<=0.0{return Err(evidence_failure("height","nonpositive"));}
    Ok([x,y,width,height])
}
fn cg_integer_identity(mut read: impl FnMut(&str) -> Option<i64>) -> Option<(u32,i32,i32)> {
    cg_integer_identity_result(|key,_|read(key).ok_or(evidence_failure("integer","missing"))).ok()
}
fn cg_integer_identity_result(mut read:impl FnMut(&str,&'static str)->Result<i64,EvidenceFailure>)->Result<(u32,i32,i32),EvidenceFailure> {
    let window_id=super::discover_textedit_window_identity::cg_window_id(read("kCGWindowNumber","id")?).filter(|id|*id>0).ok_or(evidence_failure("id","out_of_range"))?;
    let pid=i32::try_from(read("kCGWindowOwnerPID","pid")?).ok().filter(|pid|*pid>0).ok_or(evidence_failure("pid","out_of_range"))?;
    let layer=i32::try_from(read("kCGWindowLayer","layer")?).map_err(|_|evidence_failure("layer","out_of_range"))?;
    Ok((window_id,pid,layer))
}
fn complete_window_spaces(mut ids: Vec<u64>, current: impl FnOnce()->Option<u64>) -> Option<(Vec<u64>,u64)> {
    complete_window_spaces_result(std::mem::take(&mut ids),||current().ok_or(evidence_failure("current_space","unavailable"))).ok()
}
fn complete_window_spaces_result(mut ids:Vec<u64>,current:impl FnOnce()->Result<u64,EvidenceFailure>)->Result<(Vec<u64>,u64),EvidenceFailure> {
    if ids.is_empty(){return Err(evidence_failure("space_set","empty"));}if ids.len()>32{return Err(evidence_failure("space_set","limit"));}
    ids.sort_unstable();
    if ids[0]==0{return Err(evidence_failure("space_item","nonpositive"));}
    if ids.windows(2).any(|pair|pair[0]==pair[1]){return Err(evidence_failure("space_item","duplicate"));}
    let current=current()?;
    if current==0{return Err(evidence_failure("current_space","nonpositive"));}
    if !ids.contains(&current){return Err(evidence_failure("space_membership","current_not_member"));}
    Ok((ids,current))
}
unsafe fn parse_cg_row(item: CFTypeRef, z_index: usize, spaces: &crate::input::skylight::SpaceQuery) -> Result<Value,EvidenceFailure> {
    if item.is_null() || CFGetTypeID(item)!=CFDictionary::<*const c_void,*const c_void>::type_id(){return Err(evidence_failure("row","wrong_type"));}
    let dict = CFDictionary::<*const c_void, *const c_void>::wrap_under_get_rule(item as _);
    let (window_id,pid,layer)=cg_integer_identity_result(|key,field|dict_integer_result(&dict,key,field))?;
    let bounds_value=dict_value(&dict,"kCGWindowBounds").ok_or(evidence_failure("bounds","missing"))?;
    if bounds_value.is_null() || CFGetTypeID(bounds_value)!=CFDictionary::<*const c_void,*const c_void>::type_id(){return Err(evidence_failure("bounds","wrong_type"));}
    let bounds = CFDictionary::<*const c_void, *const c_void>::wrap_under_get_rule(bounds_value as _);
    let [x,y,width,height]=cg_row_geometry(|key,field|dict_float_result(&bounds,key,field))?;
    let space_ids=spaces.window_space_ids_result(window_id)?;
    let (space_ids,current_space_id)=complete_window_spaces_result(space_ids,||spaces.current_space_for_window_result(window_id))?;
    Ok(json!({"pid":pid,"window_id":window_id,"layer":layer,"z_index":z_index,
        "bounds":{"x":x,"y":y,"width":width,"height":height},"space_ids":space_ids,"current_space_id":current_space_id}))
}

pub(super) struct OwnedAx(pub(super) AXUIElementRef);
impl Drop for OwnedAx { fn drop(&mut self) { unsafe { CFRelease(self.0 as CFTypeRef); } } }
#[repr(C)] struct NativePoint { x: f64, y: f64 }
#[repr(C)] struct NativeSize { width: f64, height: f64 }
pub(super) fn ordinary_root(role: &str, subrole: Option<&str>) -> Result<(), &'static str> {
    match (role, subrole) {
        ("AXWindow", Some("AXStandardWindow")) => Ok(()),
        ("AXWindow", Some("AXDialog" | "AXSystemDialog" | "AXSheet")) | ("AXSheet", _) => Err("ax_root_dialog_unsupported"),
        _ => Err("ax_root_kind_unknown"),
    }
}

thread_local! {static BOOT_AX_DIAGNOSTIC:std::cell::RefCell<(bool,bool,Option<Value>)>=const {std::cell::RefCell::new((false,false,None))};}
pub(super) struct BootstrapAxScope(std::marker::PhantomData<std::rc::Rc<()>>);
impl BootstrapAxScope {
    pub(super) fn new()->Self {BOOT_AX_DIAGNOSTIC.with(|slot|*slot.borrow_mut()=(true,false,None));Self(std::marker::PhantomData)}
    pub(super) fn take(&self)->Option<Value>{BOOT_AX_DIAGNOSTIC.with(|slot|slot.borrow_mut().2.take())}
}
impl Drop for BootstrapAxScope {fn drop(&mut self){BOOT_AX_DIAGNOSTIC.with(|slot|*slot.borrow_mut()=(false,false,None));}}
fn ax_error_class(code:i32)->&'static str {
    match code {0=>"null_result",-25200=>"failure",-25201=>"illegal_argument",-25202=>"invalid_element",
        -25204=>"cannot_complete",-25205=>"unsupported",-25211=>"api_disabled",-25212=>"no_value",_=>"other"}
}
fn diagnostic_attribute(name:&str)->&'static str {
    match name {"AXRole"=>"role","AXSubrole"=>"subrole","AXTitle"=>"title","AXParent"=>"parent",
        "AXWindows"=>"windows","AXFocusedWindow"=>"focused_window","AXChildren"=>"children","AXSheets"=>"sheets",
        "AXMinimized"=>"minimized","AXModal"=>"modal","AXHidden"=>"hidden",_=>"other"}
}
fn record_ax_failure(enabled:bool,phase:&'static str,operation:&'static str,attribute:&str,class:&'static str) {
    if !enabled{return;}
    BOOT_AX_DIAGNOSTIC.with(|slot|{let mut slot=slot.borrow_mut();if slot.0 && !slot.1{slot.1=true;slot.2=Some(json!({
        "phase":match phase{"instance"|"identity"|"target_ready"|"target_relationships"|"excluded_dialog_relationships"|"foreground"=>phase,_=>"other"},
        "operation":match operation{"messaging_timeout"|"attribute_names"|"attribute_value"|"pid"|"window_id"=>operation,_=>"other"},
        "attribute":diagnostic_attribute(attribute),"error_class":match class{"failure"|"illegal_argument"|"invalid_element"|"cannot_complete"|"unsupported"|"api_disabled"|"no_value"|"null_result"|"wrong_type"|"invalid_value"=>class,_=>"other"}}));}});
}
pub(super) struct AxReader { start: Instant, queries: usize, nodes: usize, seen: Vec<OwnedAx>, overlays: Vec<Value>, overlay_refs:Vec<usize>, unassociated_menu: bool, cg_rows: Vec<Value>, root_role: Option<String>, root_subrole: Option<String>, request_guard:Option<(Instant,std::sync::Arc<std::sync::atomic::AtomicBool>)>, bootstrap_diagnostic:bool, bootstrap_phase:&'static str }
impl AxReader {
    pub(super) fn identity_reader(start: Instant) -> Self {
        Self { start, queries:0, nodes:0, seen:vec![], overlays:vec![], overlay_refs:vec![], unassociated_menu:false,
            cg_rows:vec![], root_role:None, root_subrole:None, request_guard:None,bootstrap_diagnostic:false,bootstrap_phase:"instance" }
    }
    pub(super) fn guarded_identity_reader(start:Instant,deadline:Instant,cancel:std::sync::Arc<std::sync::atomic::AtomicBool>)->Self {
        let mut reader=Self::identity_reader(start);reader.request_guard=Some((deadline,cancel));reader
    }
    pub(super) fn bootstrap_reader(start:Instant,deadline:Instant,cancel:std::sync::Arc<std::sync::atomic::AtomicBool>)->Self {
        let mut reader=Self::guarded_identity_reader(start,deadline,cancel);reader.bootstrap_diagnostic=true;reader
    }
    pub(super) fn bootstrap_phase(&mut self,phase:&'static str){self.bootstrap_phase=phase;}
    fn failure(&self,operation:&'static str,attribute:&str,class:&'static str){record_ax_failure(self.bootstrap_diagnostic,self.bootstrap_phase,operation,attribute,class);}
    fn budget(&mut self) -> Result<(), &'static str> {
        if self.request_guard.as_ref().is_some_and(|(deadline,cancel)|Instant::now()>=*deadline || cancel.load(Ordering::SeqCst)) {
            return Err("bootstrap_request_expired");
        }
        deadline(self.start)?;
        if self.queries >= MAX_QUERIES { return Err("ax_query_limit"); }
        self.queries += 1;
        Ok(())
    }
    pub(super) unsafe fn names(&mut self, element: AXUIElementRef) -> Result<HashSet<String>, &'static str> {
        self.budget()?;
        let timeout=AXUIElementSetMessagingTimeout(element,0.2);
        if timeout != kAXErrorSuccess {self.failure("messaging_timeout","",ax_error_class(timeout));return Err("ax_timeout_unavailable");}
        let mut pointer = std::ptr::null();
        let code=AXUIElementCopyAttributeNames(element,&mut pointer);
        if code != kAXErrorSuccess || pointer.is_null() {
            if !pointer.is_null() { CFRelease(pointer as CFTypeRef); }
            self.failure("attribute_names","",ax_error_class(code));
            return Err("ax_names_error");
        }
        if CFGetTypeID(pointer as CFTypeRef) != CFArray::<CFTypeRef>::type_id() { CFRelease(pointer as CFTypeRef);self.failure("attribute_names","","wrong_type"); return Err("ax_names_type"); }
        let array: CFArray<CFTypeRef> = CFArray::wrap_under_create_rule(pointer);
        if array.len() > 256 { return Err("ax_names_limit"); }
        let mut names = HashSet::new();
        for value in array.iter() {
            if CFGetTypeID(*value) != CFString::type_id() {self.failure("attribute_names","","wrong_type"); return Err("ax_names_type"); }
            if !names.insert(CFString::wrap_under_get_rule(*value as _).to_string()) { return Err("ax_names_duplicate"); }
        }
        Ok(names)
    }
    unsafe fn attribute(&mut self, element: AXUIElementRef, name: &str) -> Result<CFTypeRef, &'static str> {
        self.budget()?;
        let mut value: CFTypeRef = std::ptr::null();
        let code = AXUIElementCopyAttributeValue(element, CFString::new(name).as_concrete_TypeRef(), &mut value);
        if code != kAXErrorSuccess || value.is_null() {
            if !value.is_null() { CFRelease(value); }
            self.failure("attribute_value",name,ax_error_class(code));
            return Err(if code == kAXErrorAttributeUnsupported || code == kAXErrorNoValue {"ax_unsupported"} else {"ax_query_error"});
        }
        Ok(value)
    }
    pub(super) unsafe fn string(&mut self, element: AXUIElementRef, name: &str) -> Result<String, &'static str> {
        let value = self.attribute(element, name)?;
        if CFGetTypeID(value) != CFString::type_id() { CFRelease(value);self.failure("attribute_value",name,"wrong_type"); return Err("ax_string_type"); }
        Ok(CFString::wrap_under_create_rule(value as _).to_string())
    }
    /// Task identity only: bound the CF string before allocating/converting it.
    pub(super) unsafe fn bounded_identity_string(&mut self, element: AXUIElementRef, name: &str) -> Result<String, &'static str> {
        extern "C" { fn CFStringGetLength(value: core_foundation::string::CFStringRef) -> isize; }
        let value=self.attribute(element,name)?;
        if CFGetTypeID(value)!=CFString::type_id() { CFRelease(value);self.failure("attribute_value",name,"wrong_type"); return Err("ax_string_type"); }
        let text=CFString::wrap_under_create_rule(value as _);
        let length=CFStringGetLength(text.as_concrete_TypeRef());
        if !(1..=256).contains(&length) { return Err("bootstrap_title_limit"); }
        let text=text.to_string();
        if text.len()>1024 || text.chars().any(char::is_control) { return Err("bootstrap_title_invalid"); }
        Ok(text)
    }
    pub(super) unsafe fn boolean(&mut self, element: AXUIElementRef, name: &str) -> Result<bool, &'static str> {
        use core_foundation::boolean::CFBoolean;
        let value = self.attribute(element, name)?;
        if CFGetTypeID(value) == CFBoolean::type_id() {
            return Ok(bool::from(CFBoolean::wrap_under_create_rule(value as _)));
        }
        if CFGetTypeID(value) == CFNumber::type_id() {
            let number = CFNumber::wrap_under_create_rule(value as _).to_i64();
            return match number { Some(0) => Ok(false), Some(1) => Ok(true), _ => {self.failure("attribute_value",name,"invalid_value");Err("ax_bool_type")} };
        }
        CFRelease(value);
        self.failure("attribute_value",name,"wrong_type");
        Err("ax_bool_type")
    }
    unsafe fn frame(&mut self, element: AXUIElementRef, pid: i32, window_id: u32, names: &HashSet<String>) -> Result<Value, &'static str> {
        if !names.contains("AXPosition") || !names.contains("AXSize") { return Err("ax_geometry_unsupported"); }
        let position = self.attribute(element, "AXPosition")?;
        let mut point = NativePoint { x:0.0, y:0.0 };
        let valid_position = CFGetTypeID(position) == AXValueGetTypeID() &&
            AXValueGetType(position as AXValueRef) == kAXValueCGPointType &&
            AXValueGetValue(position as AXValueRef, kAXValueCGPointType, &mut point as *mut _ as *mut c_void);
        CFRelease(position);
        if !valid_position { return Err("ax_geometry_type"); }
        let size = self.attribute(element, "AXSize")?;
        let mut dimensions = NativeSize { width:0.0, height:0.0 };
        let valid_size = CFGetTypeID(size) == AXValueGetTypeID() &&
            AXValueGetType(size as AXValueRef) == kAXValueCGSizeType &&
            AXValueGetValue(size as AXValueRef, kAXValueCGSizeType, &mut dimensions as *mut _ as *mut c_void);
        CFRelease(size);
        if !valid_size || ![point.x,point.y,dimensions.width,dimensions.height].iter().all(|v| v.is_finite() && v.abs() <= 1e9) ||
            dimensions.width <= 0.0 || dimensions.height <= 0.0 { return Err("ax_geometry_invalid"); }
        let row = self.cg_rows.iter().find(|row| row["pid"] == pid && row["window_id"] == window_id).ok_or("ax_cg_unresolved")?;
        let bounds = &row["bounds"];
        let (x,y,w,h) = (bounds["x"].as_f64().ok_or("ax_cg_geometry")?,bounds["y"].as_f64().ok_or("ax_cg_geometry")?,
            bounds["width"].as_f64().ok_or("ax_cg_geometry")?,bounds["height"].as_f64().ok_or("ax_cg_geometry")?);
        if point.x < x || point.y < y || point.x + dimensions.width > x+w || point.y + dimensions.height > y+h {
            return Err("ax_geometry_outside_capture");
        }
        Ok(json!({"x":point.x,"y":point.y,"width":dimensions.width,"height":dimensions.height}))
    }
    pub(super) unsafe fn element(&mut self, element: AXUIElementRef, name: &str) -> Result<OwnedAx, &'static str> {
        let value = self.attribute(element, name)?;
        if CFGetTypeID(value) != AXUIElementGetTypeID() { CFRelease(value);self.failure("attribute_value",name,"wrong_type"); return Err("ax_element_type"); }
        Ok(OwnedAx(value as AXUIElementRef))
    }
    pub(super) unsafe fn elements(&mut self, element: AXUIElementRef, name: &str) -> Result<Vec<OwnedAx>, &'static str> {
        let value = self.attribute(element, name)?;
        if CFGetTypeID(value) != CFArray::<CFTypeRef>::type_id() { CFRelease(value);self.failure("attribute_value",name,"wrong_type"); return Err("ax_array_type"); }
        let array = CFArray::<CFTypeRef>::wrap_under_create_rule(value as _);
        if array.len() as usize > MAX_NODES { return Err("ax_nodes_limit"); }
        let mut result: Vec<OwnedAx> = Vec::new();
        for item in array.iter() {
            if CFGetTypeID(*item) != AXUIElementGetTypeID() {self.failure("attribute_value",name,"wrong_type"); return Err("ax_child_type"); }
            if result.iter().any(|other| CFEqual(other.0 as CFTypeRef, *item) != 0) { return Err("ax_duplicate_child"); }
            core_foundation::base::CFRetain(*item);
            result.push(OwnedAx(*item as AXUIElementRef));
        }
        Ok(result)
    }
    pub(super) unsafe fn window_id(&mut self, element: AXUIElementRef) -> Result<u32, &'static str> {
        self.budget()?;
        let mut id = 0;
        let code=_AXUIElementGetWindow(element,&mut id);
        if code != kAXErrorSuccess || id == 0 {self.failure("window_id","",if code==0{"invalid_value"}else{ax_error_class(code)});Err("ax_window_unresolved")}else{Ok(id)}
    }
    pub(super) unsafe fn pid(&mut self, element: AXUIElementRef) -> Result<i32, &'static str> {
        self.budget()?;
        let mut pid = 0;
        let code=AXUIElementGetPid(element,&mut pid);
        if code != kAXErrorSuccess || pid <= 0 {self.failure("pid","",if code==0{"invalid_value"}else{ax_error_class(code)});Err("ax_pid_unresolved")}else{Ok(pid)}
    }
    unsafe fn walk(&mut self, element: OwnedAx, parent: AXUIElementRef, path: String, pid: i32, root_id: u32, depth: usize, menu_scope: bool) -> Result<(), &'static str> {
        if depth > MAX_DEPTH || self.nodes >= MAX_NODES { return Err("ax_nodes_limit"); }
        if self.seen.iter().any(|seen| CFEqual(seen.0 as CFTypeRef, element.0 as CFTypeRef) != 0) { return Err("ax_cycle_or_duplicate"); }
        if self.pid(element.0)? != pid { return Err("ax_foreign_pid"); }
        let names = self.names(element.0)?;
        // For every non-root edge, prove the actual AXParent, not inherited pid or geometry.
        if !parent.is_null() {
            if !names.contains("AXParent") { return Err("ax_parent_unknown"); }
            let owner = self.element(element.0, "AXParent")?;
            if CFEqual(owner.0 as CFTypeRef, parent as CFTypeRef) == 0 { return Err("ax_parent_mismatch"); }
        }
        let role = self.string(element.0, "AXRole")?;
        let subrole = if names.contains("AXSubrole") { Some(self.string(element.0, "AXSubrole")?) } else { None };
        if depth == 0 && !menu_scope {
            ordinary_root(&role, subrole.as_deref())?;
            self.root_role = Some(role.clone());
            self.root_subrole = subrole.clone();
        }
        let kind = match role.as_str() {
            "AXMenu" => Some("menu"), "AXPopover" => Some("popup"), "AXSheet" => Some("dialog"),
            "AXWindow" if depth > 0 && subrole.as_deref().is_some_and(|v| matches!(v, "AXDialog"|"AXSystemDialog"|"AXSheet")) => Some("dialog"),
            "AXWindow" if depth > 0 => return Err("ax_nested_window_unknown"),
            "AXUnknown" => return Err("ax_unknown_role"),
            _ => None,
        };
        // Explicit typed visibility only; hidden menus may exist in an exposed
        // menu tree even while closed. Unsupported visibility is NOT absence.
        let hidden = if kind.is_some() && names.contains("AXHidden") { Some(self.boolean(element.0, "AXHidden")?) } else { None };
        let visible = if kind.is_some() && names.contains("AXVisible") { Some(self.boolean(element.0, "AXVisible")?) } else { None };
        if hidden.is_some() && visible.is_some() && hidden == visible { return Err("ax_visibility_conflict"); }
        let explicitly_hidden = hidden.or(visible.map(|v| !v));
        if let Some(kind) = kind {
            let is_hidden = explicitly_hidden.ok_or("ax_overlay_visibility_unknown")?;
            if is_hidden { self.nodes += 1; self.seen.push(element); return Ok(()); }
            if menu_scope { self.unassociated_menu = true; }
            else {
                let id = self.window_id(element.0)?;
                let frame = self.frame(element.0, pid, id, &names)?;
                let source = if hidden.is_some() && visible.is_some() {"consistent_both"} else if hidden.is_some() {"AXHidden"} else {"AXVisible"};
                self.overlays.push(json!({"kind":kind,"pid":pid,"window_id":id,"parent_window_id":root_id,"path":path,
                    "visible":true,"geometry_verified":true,"visibility_source":source,"frame":frame}));
                self.overlay_refs.push(element.0 as usize);
                if self.overlays.len() > 32 { return Err("ax_overlay_limit"); }
            }
        }
        let pointer = element.0;
        self.nodes += 1;
        self.seen.push(element);
        let mut edges: Vec<(&str, usize, OwnedAx)> = Vec::new();
        for (attribute, suffix) in [("AXChildren","children"),("AXSheets","sheets")] {
            // Successful attributeNames with an absent property is the only absence route.
            // Unsupported/noValue on an advertised property never becomes an empty array.
            if names.contains(attribute) {
                for (index, child) in self.elements(pointer, attribute)?.into_iter().enumerate() {
                    // The same retained AX object may be exposed by both
                    // Children and Sheets. Merge ONLY this exact same-parent
                    // cross-attribute reference, never PID/CGID/geometry.
                    if !edges.iter().any(|(_, _, other)| CFEqual(other.0 as CFTypeRef, child.0 as CFTypeRef) != 0) {
                        edges.push((suffix, index, child));
                    }
                }
            }
        }
        for (suffix, index, child) in edges {
            self.walk(child, pointer, format!("{path}/{suffix}.{index}"), pid, root_id, depth + 1, menu_scope)?;
        }
        Ok(())
    }
}

fn ax_unknown(reason: &str, queries: usize, nodes: usize) -> Value {
    json!({"status":"error","reason_code":reason,"target_resolved":false,"closure_complete":false,
        "query_count":queries,"node_count":nodes,"skipped_count":0,"truncated":reason == "ax_nodes_limit" || reason == "ax_query_limit",
        "unassociated_menu_present":null,"overlays":[]})
}

unsafe fn ax_closure(pid: i32, window_id: u32, start: Instant, cg: &Value) -> Value {
    let pointer = AXUIElementCreateApplication(pid);
    if pointer.is_null() { return ax_unknown("ax_app_unavailable",0,0); }
    let app = OwnedAx(pointer);
    let mut reader = AxReader { start, queries:0, nodes:0, seen:vec![], overlays:vec![], overlay_refs:vec![], unassociated_menu:false,
        cg_rows:cg["rows"].as_array().cloned().unwrap_or_default(), root_role:None, root_subrole:None, request_guard:None,bootstrap_diagnostic:false,bootstrap_phase:"instance" };
    let result = (|| -> Result<(), &'static str> {
        let app_names = reader.names(app.0)?;
        if !app_names.contains("AXWindows") || !app_names.contains("AXFocusedWindow") { return Err("ax_app_scope_unknown"); }
        let windows = reader.elements(app.0, "AXWindows")?;
        let mut target = None;
        for window in windows {
            reader.names(window.0)?; // Sets per-object timeout; preserves names-query failures.
            if reader.pid(window.0)? != pid || reader.string(window.0, "AXRole")? != "AXWindow" { return Err("ax_windows_identity"); }
            if reader.window_id(window.0)? == window_id {
                if target.is_some() { return Err("ax_target_duplicate"); }
                target = Some(window);
            }
        }
        let target = target.ok_or("ax_target_unresolved")?;
        let focused = reader.element(app.0, "AXFocusedWindow")?;
        if CFEqual(target.0 as CFTypeRef, focused.0 as CFTypeRef) == 0 || reader.window_id(focused.0)? != window_id {
            return Err("ax_focus_mismatch");
        }
        reader.walk(target, std::ptr::null_mut(), "target".into(), pid, window_id, 0, false)?;
        // Application menus are not asserted owned by this window. Reading only this
        // app's menu closure can detect unassociated menus; presence stays unknown.
        if app_names.contains("AXMenuBar") {
            let menu = reader.element(app.0, "AXMenuBar")?;
            reader.walk(menu, app.0, "app_menu".into(), pid, window_id, 0, true)?;
        }
        if reader.unassociated_menu { return Err("unassociated_menu"); }
        deadline(start)
    })();
    match result {
        Err(reason) => ax_unknown(reason, reader.queries, reader.nodes),
        Ok(()) => {
            let root_role = reader.root_role.as_deref().unwrap_or("");
            let root_subrole = reader.root_subrole.as_deref();
            if let Err(reason) = ordinary_root(root_role, root_subrole) { return ax_unknown(reason,reader.queries,reader.nodes); }
            let root = reader.seen.first().map(|element| element.0 as usize).unwrap_or(0);
            if root == 0 { return ax_unknown("identity_unavailable",reader.queries,reader.nodes); }
            let (root_token,tokens) = match identity_tokens(pid,window_id,root,&reader.overlay_refs) {
                Ok(tokens) => tokens, Err(reason) => return ax_unknown(reason,reader.queries,reader.nodes),
            };
            for (overlay,token) in reader.overlays.iter_mut().zip(tokens) { overlay["identity_token"] = json!(token); }
            json!({"status":"success","target_resolved":true,"closure_complete":true,
                "query_count":reader.queries,"node_count":reader.nodes,"skipped_count":0,"truncated":false,
                "root_role":root_role,"root_subrole":root_subrole,"root_query_status":"success","root_classification":"ordinary",
                "target_identity_token":root_token,"unassociated_menu_present":false,"overlays":reader.overlays})
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task_row(id:u32,pid:i32,z:usize,bounds:[f64;4],space:Value)->Value {
        let [x,y,width,height]=bounds;json!({"window_id":id,"pid":pid,"layer":0,"z_index":z,
            "bounds":{"x":x,"y":y,"width":width,"height":height},"space":space})
    }
    #[test]fn task_intersection_diagnostic_covers_all_cross_buckets_and_both_sample_phases(){
        let verified=json!({"status":"verified","space_ids":[1],"current_space_id":1});
        let empty=json!({"status":"not_proven","reason_code":"typed_empty"});
        let mut rows=Vec::new();
        for pid in [1,2] {for layer in [-1,0,1] {for space in [verified.clone(),empty.clone()] {
            for bounds in [[-1.0,-1.0,102.0,102.0],[1.0,1.0,2.0,2.0],[99.0,99.0,2.0,2.0]] {
                let mut row=task_row(rows.len() as u32+10,pid,1,bounds,space.clone());row["layer"]=json!(layer);rows.push(row);
            }
        }}}
        rows.push(task_row(99,2,1,[100.0,0.0,2.0,2.0],empty.clone()));
        rows.push(task_row(7,1,1,[0.0,0.0,100.0,100.0],verified));
        rows.push(task_row(100,2,1,[0.0,0.0,2.0,2.0],empty));
        for phase in ["before","after"] {
            let mut evidence=None;
            assert_eq!(task_target_with_diagnostic(&rows,1,7,[0.0,0.0,100.0,100.0],phase,|value|evidence=Some(value)),Err("task_upper_intersection"));
            let value=evidence.unwrap();assert_eq!(value["phase"],phase);assert_eq!(value["public_row_count"],39);
            assert_eq!(value["upper_row_count"],37);assert_eq!(value["intersection_count"],36);
            assert_eq!(value["typed_empty_row_count"],20);assert_eq!(value["upper_typed_empty_row_count"],19);
            assert_eq!(value["intersection_typed_empty_row_count"],18);
            let buckets=value["buckets"].as_array().unwrap();assert_eq!(buckets.len(),36);assert!(buckets.iter().all(|b|b["count"]==1));
        }
        assert_eq!(intersection_shape([0.0,0.0,100.0,100.0],[0.0,0.0,100.0,100.0]),Some("contains_target"));
        assert_eq!(intersection_shape([0.0,0.0,100.0,100.0],[100.0,0.0,2.0,2.0]),None);
    }
    #[test]fn task_intersection_diagnostic_never_records_success_or_unqualified_target(){
        let target=task_row(7,1,1,[0.0,0.0,100.0,100.0],json!({"status":"verified","space_ids":[1],"current_space_id":1}));
        assert!(task_target_with_diagnostic(&[target.clone()],1,7,[0.0,0.0,100.0,100.0],"before",|_|panic!("success diagnostic")).is_ok());
        for (pid,id,bounds) in [(2,7,[0.0,0.0,100.0,100.0]),(1,8,[0.0,0.0,100.0,100.0]),(1,7,[1.0,0.0,100.0,100.0])] {
            assert!(task_target_with_diagnostic(&[target.clone()],pid,id,bounds,"after",|_|panic!("unqualified diagnostic")).is_err());
        }
    }
    #[test]fn task_target_space_empty_is_explicit_and_never_upgrades_target_or_other_errors(){
        let empty=evidence_failure("space_set","empty");
        assert_eq!(task_space(false,Err(empty),||panic!("empty queried current")).unwrap(),json!({"status":"not_proven","reason_code":"typed_empty"}));
        assert_eq!(task_space(true,Err(empty),||panic!("target empty queried current")),Err(empty));
        for failure in [evidence_failure("space_set","invalid_count"),evidence_failure("space_set","wrong_type"),evidence_failure("space_item","duplicate"),evidence_failure("space_item","nonpositive")] {
            assert_eq!(task_space(false,Err(failure),||panic!("failed set queried current")),Err(failure));}
        assert!(task_space(true,Ok(vec![1,2]),||Ok(2)).is_ok());
        assert!(task_space(true,Ok(vec![1]),||Ok(2)).is_err());
    }
    #[test]fn task_target_preserves_empty_rows_and_detects_all_public_duplicates_and_changes(){
        let rows=vec![task_row(8,2,2,[200.0,0.0,10.0,10.0],json!({"status":"not_proven","reason_code":"typed_empty"})),
            task_row(7,1,1,[0.0,0.0,100.0,100.0],json!({"status":"verified","space_ids":[1],"current_space_id":1}))];
        let parsed=task_rows(2,|i|Ok(rows[i].clone()),||Ok(())).unwrap();assert_eq!(parsed,rows);
        assert!(task_target(&parsed,1,7,[0.0,0.0,100.0,100.0]).is_ok());
        assert_eq!(task_rows(2,|_|Ok(rows[0].clone()),||Ok(())),Err("task_public_duplicate"));
        assert_eq!(task_rows(4097,|_|panic!("limit read"),||Ok(())),Err("task_public_limit"));
        assert_eq!(task_rows(2,|_|panic!("cancel read"),||Err("cancelled")),Err("cancelled"));
        for key in ["window_id","pid","layer","z_index"] {let mut changed=parsed.clone();changed[0][key]=json!(99);assert_ne!(parsed,changed);}
        let mut changed=parsed.clone();changed.swap(0,1);assert_ne!(parsed,changed);
        let mut geometry=parsed.clone();geometry[1]["bounds"]["x"]=json!(1.0);
        assert_eq!(task_target(&geometry,1,7,[0.0,0.0,100.0,100.0]),Err("task_target_geometry_changed"));
    }
    #[test]fn task_target_any_layer_or_pid_upper_overlap_refuses_without_space_filter(){
        for layer in [-1,0,1000] {let mut upper=task_row(8,2,2,[99.0,0.0,10.0,10.0],json!({"status":"not_proven","reason_code":"typed_empty"}));upper["layer"]=json!(layer);
            let target=task_row(7,1,1,[0.0,0.0,100.0,100.0],json!({"status":"verified","space_ids":[1],"current_space_id":1}));
            assert_eq!(task_target(&[upper,target],1,7,[0.0,0.0,100.0,100.0]),Err("task_upper_intersection"));}
    }
    #[test]fn task_target_retained_object_replacement_refuses_before_numeric_or_relationship_reads(){
        assert_eq!(task_retained_root(false,||panic!("new object with same numbers read")),Err("task_retained_changed"));
        assert_eq!(task_retained_root(true,||Ok(false)),Err("task_retained_changed"));
        assert_eq!(task_retained_root(true,||Err("ax_query_error")),Err("ax_query_error"));
        assert!(task_retained_root(true,||Ok(true)).is_ok());
        assert_ne!(task_capability()["schema_version"],capability()["schema_version"]);
        assert_ne!(task_capability()["producer_version"],capability()["producer_version"]);
    }
    #[test]
    fn topology_row_failure_first_field_preserves_integer_and_geometry_read_order() {
        let mut fields=Vec::new();
        assert_eq!(super::cg_integer_identity_result(|_,field|{fields.push(field);if field=="pid"{Err(super::evidence_failure(field,"floating"))}else{Ok(7)}}),Err(super::evidence_failure("pid","floating")));
        assert_eq!(fields,vec!["id","pid"]);
        for field in ["id","pid","layer"] {
            let result=super::cg_integer_identity_result(|_,actual|if actual==field{Err(super::evidence_failure(actual,"missing"))}else{Ok(7)});
            assert_eq!(result,Err(super::evidence_failure(field,"missing")));
        }
        for field in ["x","y","width","height"] {
            let mut read=Vec::new();let result=super::cg_row_geometry(|_,actual|{read.push(actual);if actual==field{Err(super::evidence_failure(actual,"conversion"))}else{Ok(7.0)}});
            assert_eq!(result,Err(super::evidence_failure(field,"conversion")));assert_eq!(read.last(),Some(&field));
            assert_eq!(super::finite_row_float(field,f64::NAN),Err(super::evidence_failure(field,"out_of_range")));
        }
        let mut read=Vec::new();assert_eq!(super::cg_row_geometry(|_,field|{read.push(field);Ok(if field=="width"{0.0}else{7.0})}),Err(super::evidence_failure("width","nonpositive")));
        assert_eq!(read,vec!["x","y","width","height"]);
        assert!(super::cg_row_geometry(|_,_|Ok(7.0)).is_ok());
    }
    #[test]
    fn topology_detailed_space_failure_propagates_actual_edge_and_membership() {
        assert_eq!(super::complete_window_spaces_result(vec![0,7],||panic!("bad set queried current")),Err(super::evidence_failure("space_item","nonpositive")));
        assert_eq!(super::complete_window_spaces_result(vec![7,7],||panic!("duplicate queried current")),Err(super::evidence_failure("space_item","duplicate")));
        assert_eq!(super::complete_window_spaces_result(vec![7,9],||Err(super::evidence_failure("managed_display","wrong_type"))),Err(super::evidence_failure("managed_display","wrong_type")));
        assert_eq!(super::complete_window_spaces_result(vec![7,9],||Ok(8)),Err(super::evidence_failure("space_membership","current_not_member")));
        assert_eq!(super::complete_window_spaces_result(vec![7,9],||Ok(0)),Err(super::evidence_failure("current_space","nonpositive")));
        assert_eq!(super::complete_window_spaces_result(vec![9,7],||Ok(7)),Ok((vec![7,9],7)));
    }
    #[test]
    fn topology_failure_buckets_are_deterministic_and_keep_duplicate_identity_separate() {
        let mut failures=std::collections::BTreeMap::new();
        for failure in [super::evidence_failure("space_item","nonpositive"),super::evidence_failure("pid","floating"),super::evidence_failure("space_item","nonpositive"),super::evidence_failure("identity","duplicate")] {
            super::add_row_failure(&mut failures,failure);
        }
        assert_eq!(super::row_failure_counts(&failures),serde_json::json!([
            {"field":"identity","error_class":"duplicate","count":1},{"field":"pid","error_class":"floating","count":1},{"field":"space_item","error_class":"nonpositive","count":2}]));
        assert_eq!(failures.values().sum::<usize>(),4);
        assert_eq!(super::row_failure_counts(&std::collections::BTreeMap::new()),serde_json::json!([]));
    }
    #[test]
    fn topology_complete_spaces_requires_every_member_and_exact_current_membership() {
        assert_eq!(super::complete_window_spaces(vec![9,7],||Some(7)),Some((vec![7,9],7)));
        assert_eq!(super::complete_window_spaces(vec![7,9],||Some(9)),Some((vec![7,9],9)));
        for (ids,current) in [(vec![],7),(vec![0,7],7),(vec![7,7],7),(vec![7,9],8),(vec![7,9],0),((1..=33).collect(),7)] {
            assert_eq!(super::complete_window_spaces(ids,||Some(current)),None);
        }
        assert_eq!(super::complete_window_spaces(vec![7],||None),None);
        assert_eq!(super::complete_window_spaces(vec![0,7],||panic!("invalid set queried current Space")),None);
    }
    #[test]
    fn topology_integer_window_id_contract_preserves_only_signed32_id_bits() {
        use super::super::discover_textedit_window_identity::cg_window_id;
        use crate::input::skylight::strict_integer_value;
        assert_eq!(cg_window_id(-1),Some(u32::MAX));
        assert_eq!(cg_window_id(i32::MIN as i64),Some(0x8000_0000));
        assert_eq!(cg_window_id(u32::MAX as i64),Some(u32::MAX));
        assert_eq!(cg_window_id(i32::MIN as i64-1),None);
        assert_eq!(cg_window_id(u32::MAX as i64+1),None);
        assert_eq!(cg_window_id(0).filter(|id|*id>0),None);
        assert!(i32::try_from(u32::MAX as i64).is_err());
        assert_eq!(i32::try_from(-1_i64).ok().filter(|pid|*pid>0),None);
        assert_eq!(strict_integer_value(true,||true,||Some(-1)),None);
        assert_eq!(strict_integer_value(true,||false,||None),None);
        let decode=|number,pid,layer|super::cg_integer_identity(|key|Some(match key {
            "kCGWindowNumber"=>number,"kCGWindowOwnerPID"=>pid,"kCGWindowLayer"=>layer,_=>panic!("unexpected field")
        }));
        assert_eq!(decode(-1,7,-1),Some((u32::MAX,7,-1)));
        assert_eq!(decode(i32::MIN as i64,7,0),Some((0x8000_0000,7,0)));
        for (number,pid,layer) in [(0,7,0),(-2147483649,7,0),(4294967296,7,0),(7,0,0),(7,-1,0),(7,4294967295,0),(7,7,2147483648)] {
            assert_eq!(decode(number,pid,layer),None);
        }
        let mut fields=Vec::new();
        assert_eq!(super::cg_integer_identity(|key|{fields.push(key.to_owned());Some(0)}),None);
        assert_eq!(fields,vec!["kCGWindowNumber"]);
    }
    #[test]fn bootstrap_ax_error_classifier_is_closed_and_structures_are_distinct(){
        for (code,class) in [(0,"null_result"),(-25200,"failure"),(-25201,"illegal_argument"),(-25202,"invalid_element"),
            (-25204,"cannot_complete"),(-25205,"unsupported"),(-25211,"api_disabled"),(-25212,"no_value"),(123,"other")] {
            assert_eq!(super::ax_error_class(code),class);
        }
        assert_eq!(super::diagnostic_attribute("AXTitle"),"title");assert_eq!(super::diagnostic_attribute("private-value"),"other");
    }
    #[test]fn bootstrap_ax_diagnostic_scope_first_failure_take_drop_and_next_request(){
        use super::*;
        {let scope=BootstrapAxScope::new();
            record_ax_failure(true,"identity","attribute_value","AXParent","cannot_complete");
            record_ax_failure(true,"foreground","pid","","api_disabled");
            assert_eq!(scope.take(),Some(json!({"phase":"identity","operation":"attribute_value","attribute":"parent","error_class":"cannot_complete"})));
            record_ax_failure(true,"foreground","pid","","failure");
            assert!(scope.take().is_none());}
        record_ax_failure(true,"identity","pid","","failure");
        let scope=BootstrapAxScope::new();assert!(scope.take().is_none());
        record_ax_failure(true,"private-stage","private-op","private-attribute","private-class");
        assert_eq!(scope.take(),Some(json!({"phase":"other","operation":"other","attribute":"other","error_class":"other"})));
    }
    #[test]fn bootstrap_ax_diagnostic_reader_optin_does_not_add_queries_or_change_old_default(){
        use super::*;
        let scope=BootstrapAxScope::new();let cancel=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let old=AxReader::identity_reader(Instant::now());old.failure("attribute_value","AXTitle","failure");assert!(scope.take().is_none());
        let old_guarded=AxReader::guarded_identity_reader(Instant::now(),Instant::now()+Duration::from_secs(1),cancel.clone());
        old_guarded.failure("attribute_value","AXTitle","failure");assert!(scope.take().is_none());
        let mut reader=AxReader::bootstrap_reader(Instant::now(),Instant::now()+Duration::from_secs(1),cancel.clone());
        reader.bootstrap_phase("target_ready");reader.failure("attribute_value","AXModal","wrong_type");
        assert_eq!(reader.queries,0);assert_eq!(scope.take().unwrap()["error_class"],"wrong_type");
        cancel.store(true,Ordering::SeqCst);assert_eq!(reader.budget(),Err("bootstrap_request_expired"));
        assert_eq!(reader.queries,0);assert!(scope.take().is_none());
    }
    #[test]fn optional_bootstrap_read_guard_refuses_before_query_without_changing_legacy_budget(){
        let start=Instant::now();let mut legacy=AxReader::identity_reader(start);assert!(legacy.request_guard.is_none());assert!(legacy.budget().is_ok());
        let cancel=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut guarded=AxReader::guarded_identity_reader(start,start+Duration::from_secs(1),cancel.clone());
        assert!(guarded.budget().is_err());assert_eq!(guarded.queries,0);
        cancel.store(false,Ordering::SeqCst);assert!(guarded.budget().is_ok());
        let mut expired=AxReader::guarded_identity_reader(start,Instant::now(),cancel);assert!(expired.budget().is_err());assert_eq!(expired.queries,0);
    }
    use super::*;
    #[test] fn window_schema_preserves_complete_u32_range() {
        let tool = TargetWindowTopologyTool;
        assert_eq!(tool.def().input_schema["properties"]["window_id"]["maximum"].as_u64(), Some(u64::from(u32::MAX)));
        assert!(u64::from(u32::MAX) > i32::MAX as u64);
    }
    #[test] fn root_kind_requires_actual_standard_window_not_a_default() {
        assert!(ordinary_root("AXWindow",Some("AXStandardWindow")).is_ok());
        for subrole in [None,Some("AXDialog"),Some("AXSystemDialog"),Some("AXSheet"),Some("AXFloatingWindow"),Some("AXUnknownSubrole"),Some("")] {
            assert!(ordinary_root("AXWindow",subrole).is_err());
        }
        assert!(ordinary_root("AXSheet",Some("AXStandardWindow")).is_err());
        assert!(ordinary_root("AXUnknown",Some("AXStandardWindow")).is_err());
        // Same CGID/retained AX object is not authorization when its actual
        // subrole changes: the classification gate runs on every traversal.
        assert!(ordinary_root("AXWindow",Some("AXDialog")).is_err());
    }
    #[test] fn capability_does_not_attest_global_topology_or_window_lifetime() {
        assert_eq!(capability()["global_topology_complete"], false);
        assert_eq!(capability()["identity_lifecycle"], "bounded-observation");
        assert_eq!(capability()["source_commit"], SOURCE_COMMIT);
    }
    #[test] fn failure_and_skips_are_never_success_empty() {
        let value = cg_unknown("cg_null", 0, 0, 0, 0, vec![]);
        assert_eq!(value["status"], "error");
        assert!(!exact_target(&value, 41, 101));
        assert_eq!(ax_unknown("ax_unsupported", 1, 0)["closure_complete"], false);
    }
    #[test] fn exact_target_requires_owner_id_and_ordinary_layer() {
        for row in [json!({"pid":42,"window_id":101,"layer":0}),json!({"pid":41,"window_id":102,"layer":0}),json!({"pid":41,"window_id":101,"layer":8})] {
            assert!(!exact_target(&json!({"status":"success","rows":[row]}),41,101));
        }
        assert!(exact_target(&json!({"status":"success","rows":[{"pid":41,"window_id":101,"layer":0}]}),41,101));
    }
    #[test] fn reserved_transport_envelope_is_not_a_public_argument() {
        let mut args = json!({"pid":41,"window_id":101,"request_nonce":"00000000-0000-0000-0000-000000000001",
            "_session_id":"trusted","_transport_session_id":"trusted"});
        cua_driver_core::tool_args::sanitize_reserved_args(&mut args);
        assert_eq!(args.as_object().unwrap().len(),3);
        let mut capabilities = json!({"_session_id":"trusted"});
        cua_driver_core::tool_args::sanitize_reserved_args(&mut capabilities);
        assert!(capabilities.as_object().unwrap().is_empty());
    }
}
