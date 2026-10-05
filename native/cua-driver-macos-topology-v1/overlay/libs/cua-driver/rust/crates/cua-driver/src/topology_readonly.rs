//! Isolated opt-in topology and new-window observation hosts. Only the explicit
//! new-window session registers native independent-window capture; no SDK/full
//! platform assembly, history, browser, update or permission prompt is started.
use std::{collections::{HashMap,HashSet}, ffi::CString, fs::{self, File}, io::Write,
    os::unix::{fs::{FileTypeExt, MetadataExt, OpenOptionsExt}, io::{AsRawFd, FromRawFd}},
    path::{Component, Path, PathBuf}, time::Duration};
use cua_driver_core::{daemon::{DaemonRequest, DaemonResponse}, tool::ToolRegistry};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TARGET: &str = "get_target_window_topology";
const CAPABILITIES: &str = "get_target_window_topology_capabilities";
const MAX_FRAME: usize = 4096;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const SOCKET: &str = "topology.sock";
const PID: &str = "topology.pid";
const POLICY: &str = "policy.yaml";
// Exact closed producer reasons, not arbitrary upstream messages.
const AX_REASONS: &[&str] = &[
    "identity_cache_unavailable", "identity_unavailable", "deadline", "target_unresolved",
    "ax_root_dialog_unsupported", "ax_root_kind_unknown", "ax_query_limit", "ax_timeout_unavailable",
    "ax_names_error", "ax_names_type", "ax_names_limit", "ax_names_duplicate", "ax_unsupported",
    "ax_query_error", "ax_string_type", "ax_bool_type", "ax_geometry_unsupported", "ax_geometry_type",
    "ax_geometry_invalid", "ax_cg_unresolved", "ax_cg_geometry", "ax_geometry_outside_capture",
    "ax_element_type", "ax_array_type", "ax_nodes_limit", "ax_child_type", "ax_duplicate_child",
    "ax_window_unresolved", "ax_pid_unresolved", "ax_cycle_or_duplicate", "ax_foreign_pid",
    "ax_parent_unknown", "ax_parent_mismatch", "ax_nested_window_unknown", "ax_unknown_role",
    "ax_visibility_conflict", "ax_overlay_visibility_unknown", "ax_overlay_limit", "ax_app_unavailable",
    "ax_app_scope_unknown", "ax_windows_identity", "ax_target_duplicate", "ax_target_unresolved",
    "ax_focus_mismatch", "unassociated_menu",
];

#[derive(Debug)]
struct Options { root: PathBuf, pid: i32, window_id: u32, call: Option<(String, Option<String>)> }

fn options(args: &[String]) -> Result<Options, &'static str> {
    let client = args.first().map(String::as_str) == Some("topology-readonly-call");
    let mut fields = HashMap::new();
    let mut pairs = args[1..].chunks_exact(2);
    for pair in &mut pairs {
        let key = pair[0].as_str();
        if !matches!(key, "--state-root" | "--pid" | "--window-id")
            && !(client && matches!(key, "--tool" | "--request-nonce")) { return Err("readonly_arguments_invalid"); }
        if fields.insert(key, pair[1].as_str()).is_some() { return Err("readonly_arguments_invalid"); }
    }
    if !pairs.remainder().is_empty() { return Err("readonly_arguments_invalid"); }
    let root = PathBuf::from(*fields.get("--state-root").ok_or("readonly_state_root_required")?);
    let pid = fields.get("--pid").and_then(|s| s.parse::<i32>().ok()).filter(|v| *v > 0).ok_or("readonly_target_invalid")?;
    let window_id = fields.get("--window-id").and_then(|s| s.parse::<u32>().ok()).filter(|v| *v > 0).ok_or("readonly_target_invalid")?;
    let call = if client {
        let tool = *fields.get("--tool").ok_or("readonly_tool_required")?;
        let nonce = fields.get("--request-nonce").copied();
        match (tool, nonce) {
            (CAPABILITIES, None) => Some((tool.to_owned(), None)),
            (TARGET, Some(nonce)) => Some((tool.to_owned(), Some(uuid::Uuid::parse_str(nonce).map_err(|_| "readonly_nonce_invalid")?.to_string()))),
            _ => return Err("readonly_tool_invalid"),
        }
    } else { None };
    Ok(Options { root, pid, window_id, call })
}

// Do not let inherited internal-worker triggers or permissive launch modes
// select a different startup path. No raw environment values enter errors.
fn environment_allowed(key: &str, value: &str) -> bool {
    if !key.starts_with("CUA_") { return true; }
    match key {
        "CUA_DRIVER_POLICY_FILE" | "CUA_DRIVER_MANAGED_POLICY_FILE" => true,
        "CUA_DRIVER_PERMISSION_MODE" => value == "standard",
        "CUA_DRIVER_DISABLE_UNRESTRICTED" => matches!(value, "1" | "true"),
        "CUA_DRIVER_RS_TELEMETRY_ENABLED" | "CUA_TELEMETRY_ENABLED" => matches!(value, "0" | "false"),
        "CUA_DRIVER_RS_UPDATE_CHECK" => matches!(value, "0" | "false"),
        _ => false,
    }
}

struct StateRoot { path: PathBuf, directory: File, dev: u64, ino: u64 }
impl StateRoot {
    fn open(path: &Path) -> Result<Self, &'static str> {
        if !path.is_absolute() || path.to_str().is_none() || path.components().any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
            || path == Path::new("/") { return Err("readonly_state_root_invalid"); }
        let uid = unsafe { libc::geteuid() };
        // Reject symlinks in every component. Writable ancestors are allowed
        // only for root-owned sticky temporary directories (e.g. /private/tmp).
        for ancestor in path.ancestors() {
            let metadata = fs::symlink_metadata(ancestor).map_err(|_| "readonly_state_root_invalid")?;
            if !metadata.is_dir() || metadata.file_type().is_symlink()
                || (metadata.uid() != 0 && metadata.uid() != uid)
                || (metadata.mode() & 0o022 != 0 && !(metadata.uid() == 0 && metadata.mode() & 0o1000 != 0)) {
                return Err("readonly_state_root_invalid");
            }
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| "readonly_state_root_invalid")?;
        if metadata.uid() != uid || metadata.mode() & 0o777 != 0o700 { return Err("readonly_state_root_not_private"); }
        let directory = fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW).open(path).map_err(|_| "readonly_state_root_invalid")?;
        let opened = directory.metadata().map_err(|_| "readonly_state_root_invalid")?;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() { return Err("readonly_state_root_changed"); }
        Ok(Self { path: path.to_owned(), directory, dev: opened.dev(), ino: opened.ino() })
    }
    fn check(&self) -> Result<(), &'static str> {
        let current = Self::open(&self.path)?;
        if current.dev != self.dev || current.ino != self.ino { return Err("readonly_state_root_changed"); }
        Ok(())
    }
    fn policy_path(&self, path: &Path) -> Result<(), &'static str> {
        if path.parent() != Some(self.path.as_path()) { return Err("readonly_policy_not_private"); }
        let metadata = fs::symlink_metadata(path).map_err(|_| "readonly_policy_not_private")?;
        if !metadata.is_file() || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 { return Err("readonly_policy_not_private"); }
        self.check()
    }
    fn socket_identity(&self) -> Result<(u64,u64,u32), &'static str> {
        self.check()?;
        let meta = fs::symlink_metadata(self.path.join(SOCKET)).map_err(|_| "readonly_socket_unavailable")?;
        if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } { return Err("readonly_socket_invalid"); }
        Ok((meta.dev(), meta.ino(), meta.uid()))
    }
    fn server_pid(&self) -> Result<u32, &'static str> {
        self.check()?;
        let name = CString::new(PID).unwrap();
        let fd = unsafe { libc::openat(self.directory.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW) };
        if fd < 0 { return Err("readonly_pid_unavailable"); }
        let file = unsafe { File::from_raw_fd(fd) };
        let meta = file.metadata().map_err(|_| "readonly_pid_invalid")?;
        if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 || meta.len() > 32 || meta.nlink() != 1 { return Err("readonly_pid_invalid"); }
        let mut text = String::new();
        std::io::Read::read_to_string(&mut std::io::Read::take(file, 32), &mut text).map_err(|_| "readonly_pid_invalid")?;
        text.trim().parse::<u32>().ok().filter(|pid| *pid > 0).ok_or("readonly_pid_invalid")
    }
    fn create(&self, name: &str) -> Result<OwnedEntry, &'static str> {
        self.check()?;
        let name = CString::new(name).map_err(|_| "readonly_state_invalid")?;
        let fd = unsafe { libc::openat(self.directory.as_raw_fd(), name.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW, 0o600) };
        if fd < 0 { return Err("readonly_state_exists_or_unavailable"); }
        let file = unsafe { File::from_raw_fd(fd) };
        Ok(OwnedEntry { file })
    }
}

// Deliberately no unlink on Drop: fstatat+unlinkat is not an atomic conditional
// removal. Retain private artifacts for the operator to inspect; each launch
// requires a fresh root. No path replacement can trigger our automatic delete.
struct OwnedEntry { file: File }

fn checked_call(options: &Options, name: &str, args: &Value) -> Result<(), &'static str> {
    let object = args.as_object().ok_or("readonly_request_invalid")?;
    if name == CAPABILITIES && object.is_empty() { return Ok(()); }
    if name != TARGET || object.len() != 3 || !object.keys().all(|k| matches!(k.as_str(), "pid" | "window_id" | "request_nonce")) {
        return Err("readonly_request_invalid");
    }
    if args["pid"].as_i64() != Some(i64::from(options.pid)) || args["window_id"].as_u64() != Some(u64::from(options.window_id)) {
        return Err("readonly_target_not_authorized");
    }
    uuid::Uuid::parse_str(args["request_nonce"].as_str().ok_or("readonly_nonce_invalid")?).map_err(|_| "readonly_nonce_invalid")?;
    Ok(())
}

fn parse_request(value: &Value) -> Result<DaemonRequest, &'static str> {
    let object = value.as_object().ok_or("readonly_request_invalid")?;
    if !object.keys().all(|k| matches!(k.as_str(), "method" | "name" | "args")) { return Err("readonly_request_invalid"); }
    let method = value["method"].as_str().ok_or("readonly_request_invalid")?;
    match method {
        "metadata" if object.len() == 1 => {},
        "call" if object.len() == 3 => {},
        _ => return Err("readonly_method_not_allowed"),
    }
    serde_json::from_value(value.clone()).map_err(|_| "readonly_request_invalid")
}

fn metadata(root: &StateRoot, options: &Options) -> Value {
    let mut value = serde_json::to_value(cua_driver_core::daemon::current_daemon_metadata()).unwrap();
    value["isolation_mode"] = json!("target-topology-readonly-v1");
    value["topology_schema_version"] = json!(2);
    value["target"] = json!({"pid":options.pid,"window_id":options.window_id});
    value["state_root_identity"] = json!({"device":root.dev,"inode":root.ino,"uid":unsafe { libc::geteuid() }});
    value
}

fn validate_metadata(value: &Value, root: &StateRoot, options: &Options, server_pid: u32) -> Result<(), &'static str> {
    let parsed: cua_driver_core::daemon::DaemonMetadata = serde_json::from_value(value.clone()).map_err(|_| "readonly_metadata_invalid")?;
    let expected = cua_driver_core::daemon::current_daemon_metadata();
    if parsed.contract_version != expected.contract_version || parsed.driver_version != expected.driver_version
        || parsed.tools_list_schema_version != expected.tools_list_schema_version
        || parsed.capability_version != expected.capability_version || parsed.mcp_protocol_version != expected.mcp_protocol_version
        || parsed.pid != server_pid || parsed.embedded || value["isolation_mode"] != "target-topology-readonly-v1"
        || value["topology_schema_version"] != 2 || value["target"] != json!({"pid":options.pid,"window_id":options.window_id})
        || value["state_root_identity"] != json!({"device":root.dev,"inode":root.ino,"uid":unsafe { libc::geteuid() }}) {
        return Err("readonly_metadata_mismatch");
    }
    Ok(())
}

async fn dispatch(registry: &ToolRegistry, root: &StateRoot, options: &Options, value: Value) -> DaemonResponse {
    let request = match parse_request(&value) { Ok(request) => request, Err(code) => return DaemonResponse::err(code, 77) };
    if request.method == "metadata" { return DaemonResponse::ok(metadata(root, options)); }
    let Some(name) = request.name else { return DaemonResponse::err("readonly_request_invalid", 77); };
    let Some(args) = request.args else { return DaemonResponse::err("readonly_request_invalid", 77); };
    if let Err(code) = checked_call(options, &name, &args) { return DaemonResponse::err(code, 77); }
    // Canonical per-call standard/policy/hard-invariant enforcement; no direct
    // Tool::invoke shortcut and no caller-reserved runtime fields accepted.
    DaemonResponse::ok(serde_json::to_value(registry.invoke_from_trusted_adapter(&name, args).await).unwrap())
}

async fn read_frame(reader: &mut (impl tokio::io::AsyncRead + Unpin)) -> Result<Value, &'static str> {
    let read = async {
        let mut frame = Vec::new();
        loop {
            let byte = reader.read_u8().await.map_err(|_| "readonly_frame_invalid")?;
            if byte == b'\n' { break; }
            if frame.len() >= MAX_FRAME { return Err("readonly_frame_too_large"); }
            frame.push(byte);
        }
        serde_json::from_slice::<Value>(&frame).map_err(|_| "readonly_frame_invalid")
    };
    tokio::time::timeout(IO_TIMEOUT, read).await.map_err(|_| "readonly_read_timeout")?
}

async fn serve(root: &StateRoot, options: &Options) -> Result<(), &'static str> {
    root.check()?;
    let socket = root.path.join(SOCKET);
    // Never unlink or take over an existing endpoint, even one with this name.
    if fs::symlink_metadata(&socket).is_ok() { return Err("readonly_socket_exists"); }
    let mut pid = root.create(PID)?;
    writeln!(&mut pid.file, "{}", std::process::id()).map_err(|_| "readonly_state_write_failed")?;
    let listener = tokio::net::UnixListener::bind(&socket).map_err(|_| "readonly_socket_unavailable")?;
    root.socket_identity()?;
    let mut registry = ToolRegistry::new();
    platform_macos::tools::register_target_topology_readonly(&mut registry);
    // One connection at a time: no overlapping CG/AX probes or unlimited
    // workers. Frame/read/write bounds prevent an incomplete client monopolizing
    // the endpoint indefinitely. Native probes retain their own bounded checks;
    // this host does not claim to forcibly cancel synchronous AX operations.
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|_| "readonly_transport_unavailable")?;
        root.check()?;
        let mut uid: libc::uid_t = 0; let mut gid: libc::gid_t = 0;
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != unsafe { libc::geteuid() } { continue; }
        let response = match read_frame(&mut stream).await {
            Ok(value) => dispatch(&registry, root, options, value).await,
            Err(code) => DaemonResponse::err(code, 77),
        };
        let mut bytes = serde_json::to_vec(&response).map_err(|_| "readonly_response_invalid")?;
        bytes.push(b'\n');
        let _ = tokio::time::timeout(IO_TIMEOUT, stream.write_all(&bytes)).await;
    }
}

fn client(root: &StateRoot, options: &Options) -> Result<(), &'static str> {
    root.check()?;
    let identity = root.socket_identity()?;
    let server_pid = root.server_pid()?;
    let socket = root.path.join(SOCKET);
    let socket = socket.to_str().ok_or("readonly_state_root_invalid")?;
    // Pure core protocol: do not enter the ordinary CLI/SDK/telemetry path.
    let handshake = cua_driver_core::daemon::send_request(socket, &DaemonRequest { method: "metadata".into(), name:None, args:None, session_id:None, observation_origin:None, client_kind:None }).map_err(|_| "readonly_metadata_unavailable")?;
    if !handshake.ok { return Err("readonly_metadata_unavailable"); }
    validate_metadata(handshake.result.as_ref().ok_or("readonly_metadata_invalid")?, root, options, server_pid)?;
    root.check()?;
    if root.socket_identity()? != identity || root.server_pid()? != server_pid { return Err("readonly_endpoint_changed"); }
    let (tool, nonce) = options.call.as_ref().unwrap();
    let args = match nonce { Some(nonce) => json!({"pid": options.pid, "window_id": options.window_id, "request_nonce":nonce}), None => json!({}) };
    let request = DaemonRequest { method: "call".into(), name: Some(tool.clone()), args: Some(args), session_id: None, observation_origin: None, client_kind: None };
    let response = cua_driver_core::daemon::send_request(socket, &request).map_err(|_| "readonly_request_transport_failed")?;
    root.check()?;
    if root.socket_identity()? != identity || root.server_pid()? != server_pid { return Err("readonly_endpoint_changed"); }
    let verified = verified_result(&response, options, tool, nonce.as_deref());
    // Fixed safe diagnostic projection is useful even for native unknown.
    // Never print the response body/text or arbitrary structured fields.
    println!("{}", json!({"ok":verified.is_ok(),"evidence":safe_evidence(&response, options, tool, nonce.as_deref())}));
    verified.map(|_| ())
}

fn contract_matches(value: &Value) -> bool {
    value["schema_version"] == 2 && value["producer_version"] == "harness-topology-v2"
        && value["source_commit"] == "d114f35fec05ecd37bf529e5587be86852205b64"
        && value["scope"] == "target-ax-closure-cg-all-layers-v1" && value["read_only"] == true
        && value["global_topology_complete"] == false && value["identity_lifecycle"] == "bounded-observation"
        && value["max_rows"] == 4096 && value["max_nodes"] == 2048 && value["max_queries"] == 32768 && value["max_elapsed_ms"] == 6000
}

fn safe_evidence(response: &DaemonResponse, options: &Options, tool: &str, nonce: Option<&str>) -> Value {
    let Some(result) = response.result.as_ref().filter(|v| v.is_object()) else { return json!({"contract_verified":false}); };
    let Some(value) = result.get("structuredContent").filter(|v| contract_matches(v)) else { return json!({"contract_verified":false}); };
    if tool == TARGET && (value["target"] != json!({"pid":options.pid,"window_id":options.window_id}) || value["request_nonce"].as_str() != nonce) {
        return json!({"contract_verified":false});
    }
    let mut output = json!({"contract_verified":true,"schema_version":2,"producer_version":"harness-topology-v2"});
    if let Some(error) = result["isError"].as_bool() { output["tool_error"] = json!(error); }
    if tool != TARGET { return output; }
    output["target"] = json!({"pid":options.pid,"window_id":options.window_id});
    output["request_nonce"] = json!(nonce);
    fn fields(from: &Value, output: &mut Value, numeric: &[&str], boolean: &[&str], enums: &[(&str,&[&str])]) {
        for key in numeric { if let Some(n) = from[*key].as_u64().filter(|n| *n <= u64::from(u32::MAX)) { output[*key] = json!(n); } }
        for key in boolean { if let Some(b) = from[*key].as_bool() { output[*key] = json!(b); } }
        for (key, allowed) in enums { if let Some(s) = from[*key].as_str().filter(|s| allowed.contains(s)) { output[*key] = json!(s); } }
    }
    fields(value,&mut output,&["sequence","elapsed_ms"], &["stable","cg_enumeration_complete","target_closure_complete"],
        &[("status", &["verified","unknown"]),("reason_code", &["verified","cg_unknown","snapshot_changed","ax_unknown","target_unresolved"])]);
    for key in ["session_epoch"] { if let Some(id) = value[key].as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()) { output[key] = json!(id.to_string()); } }
    let mut ax = json!({});
    fields(&value["ax"],&mut ax,&["query_count","node_count","skipped_count"], &["target_resolved","closure_complete","truncated","unassociated_menu_present"],
        &[("status", &["success","error"]),("root_query_status", &["success","error","unsupported"]),("root_classification", &["ordinary","unknown"]),
          ("root_role", &["AXWindow","AXSheet","AXDialog","AXUnknown"]),("root_subrole", &["AXStandardWindow","AXDialog","AXSystemDialog","AXSheet","AXFloatingWindow","AXUnknownSubrole"]),
          ("reason_code", AX_REASONS)]);
    output["ax"] = ax;
    for key in ["cg_before","cg_after"] {
        let sample = &value[key]; let mut cg = json!({});
        fields(sample,&mut cg,&["raw_count","retained_count","skipped_count","duplicate_count"], &[],
            &[("status", &["success","error"]),("reason_code", &["cg_null","cg_root_type","space_unknown","row_limit","deadline","invalid_rows"])]);
        if result["isError"]==true && value["status"]=="unknown" && value["reason_code"]=="cg_unknown" {
            if let Some(counts)=safe_row_failure_counts(sample){cg["row_failure_counts"]=counts;}
        }
        if let Some(rows) = sample["rows"].as_array() {
            if let Some(row) = rows.iter().find(|row| row["pid"] == options.pid && row["window_id"] == options.window_id) {
                if let Some(space) = row["current_space_id"].as_u64().filter(|s| *s > 0 && *s <= u64::from(u32::MAX)) { cg["target_current_space_id"] = json!(space); }
                if let Some(on_space) = row["on_current_space"].as_bool() { cg["target_on_current_space"] = json!(on_space); }
            }
        }
        output[key] = cg;
    }
    output
}
fn safe_row_failure_counts(sample:&Value)->Option<Value> {
    if sample["status"]!="error" || sample["reason_code"]!="invalid_rows" {return None;}
    let raw=sample["raw_count"].as_u64().filter(|n|*n<=4096)?;
    let retained=sample["retained_count"].as_u64()?;let skipped=sample["skipped_count"].as_u64()?;
    let duplicates=sample["duplicate_count"].as_u64()?;
    if skipped==0 || retained.checked_add(skipped)!=Some(raw) || duplicates>skipped{return None;}
    let rows=sample["row_failure_counts"].as_array().filter(|v|!v.is_empty() && v.len()<=64)?;
    let mut seen=std::collections::BTreeSet::new();let mut rebuilt=Vec::new();let mut sum=0u64;let mut duplicate_bucket=0;
    for row in rows {
        let field=row["field"].as_str()?;let class=row["error_class"].as_str()?;
        let allowed=match field {
            "row"=>class=="wrong_type","identity"=>class=="duplicate",
            "id"|"pid"|"layer"=>["missing","wrong_type","floating","conversion","out_of_range"].contains(&class),
            "bounds"=>["missing","wrong_type"].contains(&class),
            "x"|"y"=>["missing","wrong_type","conversion","out_of_range"].contains(&class),
            "width"|"height"=>["missing","wrong_type","conversion","out_of_range","nonpositive"].contains(&class),
            "space_set"=>["unavailable","null_result","wrong_type","empty","limit"].contains(&class),
            "space_item"=>["unavailable","wrong_type","floating","conversion","nonpositive","duplicate"].contains(&class),
            "managed_display"=>["unavailable","null_result","wrong_type","empty"].contains(&class),
            "current_space"=>["unavailable","nonpositive"].contains(&class),"space_membership"=>class=="current_not_member",_=>false,
        };
        if !allowed || !seen.insert((field,class)){return None;}
        let count=row["count"].as_u64().filter(|n|*n>0 && *n<=skipped)?;sum=sum.checked_add(count)?;
        if field=="identity"{duplicate_bucket=count;}
        rebuilt.push(json!({"field":field,"error_class":class,"count":count}));
    }
    if sum!=skipped || duplicate_bucket!=duplicates{return None;}
    Some(json!(rebuilt))
}

fn verified_result<'a>(response: &'a DaemonResponse, options: &Options, tool: &str, nonce: Option<&str>) -> Result<&'a Value, &'static str> {
    if !response.ok { return Err("readonly_request_refused"); }
    let result = response.result.as_ref().filter(|v| v.is_object()).ok_or("readonly_response_invalid")?;
    if result.get("isError").is_some_and(|v| v != &Value::Bool(false)) { return Err("readonly_request_refused"); }
    let value = result.get("structuredContent").filter(|v| v.is_object()).ok_or("readonly_response_invalid")?;
    if result.get("degraded").is_some_and(|v| v != &Value::Bool(false)) || value.get("degraded").is_some_and(|v| v != &Value::Bool(false)) || !contract_matches(value) {
        return Err("readonly_response_contract_mismatch");
    }
    if tool == CAPABILITIES { return Ok(value); }
    if tool != TARGET || value["target"] != json!({"pid":options.pid,"window_id":options.window_id})
        || value["request_nonce"].as_str() != nonce { return Err("readonly_response_target_mismatch"); }
    let ax = &value["ax"];
    if value["status"] != "verified" || value["reason_code"] != "verified" || value["stable"] != true
        || value["cg_enumeration_complete"] != true || value["target_closure_complete"] != true
        || !value["elapsed_ms"].as_u64().is_some_and(|n| n <= 6000) || !value["sequence"].as_u64().is_some_and(|n| n > 0)
        || value["session_epoch"].as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()).is_none()
        || ax["status"] != "success" || ax["target_resolved"] != true || ax["closure_complete"] != true
        || ax["truncated"] != false || ax["skipped_count"] != 0 || ax["unassociated_menu_present"] != false
        || ax["root_role"] != "AXWindow" || ax["root_subrole"] != "AXStandardWindow" || ax["root_query_status"] != "success" || ax["root_classification"] != "ordinary"
        || ax["target_identity_token"].as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()).is_none()
        || !ax["node_count"].as_u64().is_some_and(|n| n > 0 && n <= 2048)
        || !ax["query_count"].as_u64().is_some_and(|n| n > 0 && n <= 32768) || !ax["overlays"].is_array() {
        return Err("readonly_topology_not_verified");
    }
    for sample in [&value["cg_before"], &value["cg_after"]] {
        let rows = sample["rows"].as_array().ok_or("readonly_response_invalid")?;
        if sample["status"] != "success" || sample["raw_count"].as_u64() != Some(rows.len() as u64)
            || sample["retained_count"].as_u64() != Some(rows.len() as u64) || sample["skipped_count"] != 0 || sample["duplicate_count"] != 0
            || rows.len() > 4096 || rows.iter().filter(|row| row["pid"] == options.pid && row["window_id"] == options.window_id && row["layer"] == 0).count() != 1 {
            return Err("readonly_topology_not_verified");
        }
    }
    if value["cg_before"]["rows"] != value["cg_after"]["rows"] { return Err("readonly_topology_not_verified"); }
    Ok(value)
}

struct DiscoveryOptions { root:PathBuf, nonce:String, selected:bool }
fn discovery_options(args:&[String]) -> Result<DiscoveryOptions,&'static str> {
    let selected=args.first().map(String::as_str)==Some("textedit-selected-identity-readonly");
    if !matches!(args.first().map(String::as_str),Some("textedit-identity-readonly"|"textedit-selected-identity-readonly")) || args.len() != 7 { return Err("readonly_arguments_invalid"); }
    let mut fields=HashMap::new();
    for pair in args[1..].chunks_exact(2) {
        if !matches!(pair[0].as_str(),"--state-root"|"--bundle-id"|"--request-nonce")
            || fields.insert(pair[0].as_str(),pair[1].as_str()).is_some() { return Err("readonly_arguments_invalid"); }
    }
    if fields.get("--bundle-id").copied() != Some("com.apple.TextEdit") { return Err("readonly_bundle_not_authorized"); }
    let root=PathBuf::from(*fields.get("--state-root").ok_or("readonly_state_root_required")?);
    let nonce=uuid::Uuid::parse_str(fields.get("--request-nonce").copied().ok_or("readonly_nonce_invalid")?).map_err(|_|"readonly_nonce_invalid")?.to_string();
    Ok(DiscoveryOptions { root,nonce,selected })
}

// No raw ToolResult text or arbitrary producer keys are printed. Candidate
// verification is identity-only, never a full topology/input authorization.
fn discovery_evidence(response:&Value, nonce:&str) -> (Value,bool) {
    identity_evidence(response,nonce,false)
}
fn identity_evidence(response:&Value,nonce:&str,selected:bool)->(Value,bool) {
    let producer=if selected {"harness-textedit-selected-identity-v1"}else{"harness-textedit-identity-v1"};
    let scope=if selected {"com.apple.TextEdit-user-selected-foreground-window-identity"}else{"com.apple.TextEdit-ordinary-window-identity"};
    let value=&response["structuredContent"];
    let contract=value["schema_version"]==1 && value["producer_version"]==producer
        && value["scope"]==scope && value["read_only"]==true;
    let verified=contract && response.get("isError").is_none_or(|v| v==false)
        && value["status"]=="verified" && value["reason_code"]=="verified"
        && value["source_commit"]=="d114f35fec05ecd37bf529e5587be86852205b64"
        && value["request_nonce"]==nonce && value["bundle_id"]=="com.apple.TextEdit"
        && value["candidate_only"]==true && value["identity_lifecycle"]=="bounded-observation"
        && value["pid"].as_i64().is_some_and(|n| n>0 && n<=i64::from(i32::MAX))
        && value["window_id"].as_u64().is_some_and(|n| n>0 && n<=u64::from(u32::MAX))
        && value["elapsed_ms"].as_u64().is_some_and(|n| n<=3000)
        && value["sample_epoch"].as_str().and_then(|s|uuid::Uuid::parse_str(s).ok()).is_some();
    let mut evidence=json!({"schema_version":1,"scope":scope,
        "status":if verified {"verified"} else {"unknown"},"candidate_only":true,"request_nonce":nonce});
    if verified {
        for key in ["pid","window_id","sample_epoch","elapsed_ms"] { evidence[key]=value[key].clone(); }
    } else if contract {
        if let Some(reason)=value["reason_code"].as_str().filter(|reason| AX_REASONS.contains(reason) || IDENTITY_REASONS.contains(reason) || (selected && SELECTED_IDENTITY_REASONS.contains(reason))) {
            evidence["reason_code"]=json!(reason);
            if !selected && value["status"]=="unknown" && response["isError"]==true {
                if let Some(diagnostic)=identity_instance_evidence(reason,&value["instance_diagnostic"]) {
                    evidence["instance_diagnostic"]=diagnostic;
                }
            }
        }
    }
    (evidence,verified)
}
const SELECTED_IDENTITY_REASONS:&[&str]=&["selected_identity_arguments_invalid","selected_identity_bundle_not_authorized",
    "selected_identity_nonce_invalid","selected_identity_worker_failed","selected_identity_deadline","selected_identity_front_app_unknown",
    "selected_identity_front_app_mismatch","selected_identity_front_app_terminated","selected_identity_front_app_pid_invalid",
    "selected_identity_front_app_bundle_missing","selected_identity_front_app_bundle_mismatch","selected_identity_cg_order_unknown","selected_identity_cg_order_conflict",
    "selected_identity_changed","selected_identity_front_process_unverified"];
fn identity_instance_evidence(reason:&str,value:&Value)->Option<Value> {
    let phase=match reason {"identity_instance_first_multiple"=>"first","identity_instance_second_multiple"=>"second",_=>return None};
    if value["sample_phase"]!=phase {return None;}
    if value["count_class"]=="over_limit" && value["inspection_complete"]==false {
        return Some(json!({"sample_phase":phase,"count_class":"over_limit","inspection_complete":false}));
    }
    if value["count_class"]!="bounded_multiple" || value["inspection_complete"]!=true {return None;}
    let keys=["total_items","positive_pid_items","distinct_positive_pid_count","duplicate_object_items",
        "terminated_items","invalid_pid_items","bundle_match_items","bundle_mismatch_items","bundle_missing_items"];
    let mut counts=[0u64;9];
    for (index,key) in keys.iter().enumerate() {counts[index]=value[*key].as_u64().filter(|n|*n<=32)?;}
    let [total,positive,distinct,duplicate,terminated,invalid,matches,mismatches,missing]=counts;
    if !(2..=32).contains(&total) || counts.iter().any(|n|*n>total) || positive+invalid!=total
        || matches+mismatches+missing!=total || distinct>positive || duplicate>total-1
        || (positive>0 && distinct==0) || terminated>total {return None;}
    let mut result=json!({"sample_phase":phase,"count_class":"bounded_multiple","inspection_complete":true});
    for (key,count) in keys.iter().zip(counts) {result[*key]=json!(count);}
    Some(result)
}
const IDENTITY_REASONS:&[&str]=&["identity_arguments_invalid","identity_bundle_not_authorized","identity_nonce_invalid",
    "identity_instance_first_not_found","identity_instance_first_multiple","identity_instance_second_not_found","identity_instance_second_multiple",
    "identity_worker_failed","identity_deadline","identity_instance_ambiguous","identity_instance_invalid","identity_cg_failed",
    "identity_cg_type","identity_cg_ambiguous","identity_cg_invalid","identity_cg_not_visible","identity_cg_identity_mismatch",
    "identity_ax_unavailable","identity_ax_scope_unknown","identity_instance_hidden","identity_window_ambiguous",
    "identity_window_minimized","identity_window_hidden","identity_attached_window","identity_parent_unknown","identity_parent_mismatch",
    "identity_accessibility_required","identity_changed","identity_child_role_unknown","identity_attached_relationship_unknown","identity_children_limit"];

fn discover(args:&[String]) -> Result<(),&'static str> {
    let options=discovery_options(args)?;
    if std::env::vars_os().any(|(key,value)|key.to_str().is_some_and(|key|!environment_allowed(key,value.to_str().unwrap_or("")))) {
        return Err("readonly_environment_conflict");
    }
    let root=StateRoot::open(&options.root)?;
    let policy=root.path.join(POLICY);
    root.policy_path(&policy)?;
    if std::env::var_os("CUA_DRIVER_POLICY_FILE").is_some_and(|path|Path::new(&path)!=policy) { return Err("readonly_policy_not_private"); }
    if let Some(managed)=std::env::var_os("CUA_DRIVER_MANAGED_POLICY_FILE") { root.policy_path(Path::new(&managed))?; }
    std::env::set_var("CUA_DRIVER_POLICY_FILE",&policy);
    crate::configure_startup_permission_mode(Some("standard"),false,None,false,&[]).map_err(|_|"readonly_authorization_invalid")?;
    // AX trust is checked by the production Tool *after* canonical policy:
    // a denied request does not even perform an OS permission-status query.
    let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_|"readonly_runtime_unavailable")?;
    let mut registry=ToolRegistry::new();
    let tool=if options.selected {
        platform_macos::tools::register_textedit_selected_identity_readonly(&mut registry);
        "discover_user_selected_textedit_window_identity"
    } else {
        platform_macos::tools::register_textedit_identity_readonly(&mut registry);
        "discover_textedit_window_identity"
    };
    let result=runtime.block_on(registry.invoke_from_trusted_adapter(tool,
        json!({"bundle_id":"com.apple.TextEdit","request_nonce":options.nonce})));
    root.check()?;
    let response=serde_json::to_value(result).map_err(|_|"readonly_response_invalid")?;
    let (evidence,verified)=if options.selected {identity_evidence(&response,&options.nonce,true)}else{discovery_evidence(&response,&options.nonce)};
    println!("{evidence}");
    if verified { Ok(()) } else { Err("readonly_identity_not_verified") }
}

const BOOT_READ:&str="discover_controlled_textedit_window";
const BOOT_WRITE:&str="activate_controlled_textedit_window";
const BOOT_TITLE:&str="未命名2.txt";
const TASK_PROOF:&str="prove_controlled_textedit_task_target";
const TASK_CAP:&str="get_controlled_textedit_task_target_capabilities";
fn task_contract(value:&Value)->bool {
    value["schema_version"]==1 && value["producer_version"]=="harness-controlled-textedit-task-target-v1"
        && value["source_commit"]=="d114f35fec05ecd37bf529e5587be86852205b64"
        && value["scope"]=="com.apple.TextEdit-controlled-document-task-target" && value["read_only"]==true
        && value["global_topology_complete"]==false && value["input_authorized"]==false && value["run_ref_issued"]==false
        && value["identity_lifecycle"]=="actor-retained-bounded-observation"
        && value["max_rows"]==4096 && value["max_nodes"]==2048 && value["max_elapsed_ms"]==6000 && value["max_queries"]==32768
}
fn task_public_rows(value:&Value,pid:i32,id:u32)->Option<Value> {
    let rows=value.as_array()?;if rows.is_empty() || rows.len()>4096{return None;}
    let mut ids=HashSet::new();let mut result=Vec::with_capacity(rows.len());let mut target=None;
    for (index,row) in rows.iter().enumerate(){
        let owner=i32::try_from(row["pid"].as_i64()?).ok().filter(|n|*n>0)?;
        let wid=u32::try_from(row["window_id"].as_u64()?).ok().filter(|n|*n>0)?;
        let layer=i32::try_from(row["layer"].as_i64()?).ok()?;
        if !ids.insert(wid) || row["z_index"].as_u64()?!=u64::try_from(rows.len()-index).ok()?{return None;}
        let bounds=&row["bounds"];let mut numbers=[0.0;4];
        for (i,key) in ["x","y","width","height"].iter().enumerate(){numbers[i]=bounds[*key].as_f64()?;
            if !numbers[i].is_finite() || numbers[i].abs()>1e9 || (i>=2 && numbers[i]<=0.0){return None;}}
        let space=&row["space"];let projected=if space["status"]=="verified"{
            let raw=space["space_ids"].as_array()?;if raw.is_empty() || raw.len()>32{return None;}
            let mut set=HashSet::new();let mut values=Vec::new();
            for item in raw {let n=item.as_u64().filter(|n|*n>0)?;if !set.insert(n){return None;}values.push(n);}
            if values.windows(2).any(|pair|pair[0]>=pair[1]){return None;}
            let current=space["current_space_id"].as_u64().filter(|n|*n>0)?;if !set.contains(&current){return None;}
            json!({"status":"verified","space_ids":values,"current_space_id":current})
        }else if space["status"]=="not_proven" && space["reason_code"]=="typed_empty" && wid!=id {
            json!({"status":"not_proven","reason_code":"typed_empty"})
        }else{return None;};
        if wid==id {if owner!=pid || layer!=0 || projected["status"]!="verified"{return None;}target=Some((index,numbers));}
        result.push(json!({"pid":owner,"window_id":wid,"layer":layer,"z_index":rows.len()-index,
            "bounds":{"x":numbers[0],"y":numbers[1],"width":numbers[2],"height":numbers[3]},"space":projected}));
    }
    let (index,[x,y,w,h])=target?;
    for row in &result[..index]{let b=&row["bounds"];
        let (rx,ry,rw,rh)=(b["x"].as_f64()?,b["y"].as_f64()?,b["width"].as_f64()?,b["height"].as_f64()?);
        if rx<x+w && x<rx+rw && ry<y+h && y<ry+rh{return None;}}
    Some(json!(result))
}
fn task_evidence(result:&Value,nonce:&str,identity:(i32,u32))->(Value,bool) {
    let value=&result["structuredContent"];let mut evidence=json!({"contract_verified":false});
    if !task_contract(value) || value["request_nonce"]!=nonce{return (evidence,false);}
    evidence["contract_verified"]=json!(true);
    evidence["schema_version"]=json!(1);evidence["producer_version"]=json!("harness-controlled-textedit-task-target-v1");
    evidence["scope"]=json!("com.apple.TextEdit-controlled-document-task-target");
    evidence["global_topology_complete"]=json!(false);evidence["input_authorized"]=json!(false);evidence["run_ref_issued"]=json!(false);
    if result["isError"]==true && value["status"]=="unknown" {
        let reason=value["reason_code"].as_str().unwrap_or("");
        const REASONS:&[&str]=&["task_public_limit","task_public_invalid","task_public_duplicate","task_public_unavailable",
            "task_space_unavailable","task_target_unresolved","task_target_geometry_changed","task_upper_intersection",
            "task_ax_unknown","task_retained_changed","task_ax_overlay_unknown","task_snapshot_changed","task_proof_consumed",
            "bootstrap_request_expired","bootstrap_ref_expired_or_mismatched","bootstrap_ref_unavailable","bootstrap_activation_required",
            "bootstrap_accessibility_required","bootstrap_identity_changed","deadline"];
        evidence["status"]=json!("unknown");evidence["reason_code"]=json!(if REASONS.contains(&reason){reason}else{"task_proof_unknown"});
        if reason=="task_upper_intersection"{if let Some(diagnostic)=safe_task_intersections(&value["intersection_diagnostic"]){
            evidence["intersection_diagnostic"]=diagnostic;}}
        return (evidence,false);
    }
    let valid_error=result.get("isError").is_none_or(|v|v==&json!(false)) && result.get("degraded").is_none_or(|v|v==&json!(false));
    let flags=["public_enumeration_complete","target_space_complete","target_ax_closure_complete","retained_identity_verified","upper_intersections_absent","stable"];
    if !valid_error || value["status"]!="verified" || value["reason_code"]!="verified"
        || value["target"]["pid"]!=identity.0 || value["target"]["window_id"]!=identity.1 || flags.iter().any(|key|value[*key]!=true)
        || !value["elapsed_ms"].as_u64().is_some_and(|n|n<=6000){return(evidence,false);}
    let (Some(before),Some(after))=(task_public_rows(&value["cg_before"],identity.0,identity.1),task_public_rows(&value["cg_after"],identity.0,identity.1))else{return(evidence,false);};
    let ax=&value["ax"];
    if before!=after || ax["root_role"]!="AXWindow" || ax["root_subrole"]!="AXStandardWindow"
        || ax["unassociated_menu_present"]!=false || !ax["overlays"].as_array().is_some_and(|a|a.is_empty())
        || !ax["query_count"].as_u64().is_some_and(|n|n>0 && n<=32768)
        || !ax["node_count"].as_u64().is_some_and(|n|n>0 && n<=2048){return(evidence,false);}
    evidence["status"]=json!("verified");evidence["public_row_count"]=json!(before.as_array().unwrap().len());
    evidence["space_not_proven_count"]=json!(before.as_array().unwrap().iter().filter(|r|r["space"]["status"]=="not_proven").count());
    for flag in flags{evidence[flag]=json!(true);}evidence["input_authorized"]=json!(false);evidence["run_ref_issued"]=json!(false);
    (evidence,true)
}
fn safe_task_intersections(value:&Value)->Option<Value>{
    let phase=value["phase"].as_str()?;if !["before","after"].contains(&phase){return None;}
    let keys=["public_row_count","upper_row_count","intersection_count","typed_empty_row_count","upper_typed_empty_row_count","intersection_typed_empty_row_count"];
    let mut counts=[0u64;6];for (i,key) in keys.iter().enumerate(){counts[i]=value[*key].as_u64().filter(|n|*n<=4096)?;}
    let [public,upper,intersection,empty,upper_empty,intersection_empty]=counts;
    if public<2 || upper==0 || upper>=public || intersection==0 || intersection>upper || empty>=public
        || upper_empty>upper || upper_empty>empty || intersection_empty>intersection || intersection_empty>upper_empty
        || upper_empty-intersection_empty>upper-intersection || empty-upper_empty>public-upper-1
        || intersection-intersection_empty>upper-upper_empty{return None;}
    let raw=value["buckets"].as_array()?;if raw.is_empty() || raw.len()>36{return None;}
    let mut seen=HashSet::new();let mut projected=Vec::new();let (mut sum,mut empty_sum)=(0u64,0u64);
    for bucket in raw {
        let owner=bucket["owner_relation"].as_str()?;let layer=bucket["layer_relation"].as_str()?;
        let space=bucket["space_state"].as_str()?;let shape=bucket["shape_relation"].as_str()?;
        if !["same_pid","other_pid"].contains(&owner) || !["below","equal","above"].contains(&layer)
            || !["verified","typed_empty"].contains(&space) || !["contains_target","inside_target","partial"].contains(&shape)
            || !seen.insert((owner,layer,space,shape)){return None;}
        let count=bucket["count"].as_u64().filter(|n|*n>0 && *n<=intersection)?;sum=sum.checked_add(count)?;
        if space=="typed_empty"{empty_sum=empty_sum.checked_add(count)?;}
        projected.push(json!({"owner_relation":owner,"layer_relation":layer,"space_state":space,"shape_relation":shape,"count":count}));
    }
    if sum!=intersection || empty_sum!=intersection_empty{return None;}
    let mut result=json!({"phase":phase,"buckets":projected});for (key,count) in keys.iter().zip(counts){result[*key]=json!(count);}Some(result)
}
fn bootstrap_options(args:&[String])->Result<(PathBuf,String),&'static str> {
    if !matches!(args.first().map(String::as_str),Some("textedit-task-bootstrap"|"textedit-task-target-bootstrap")){return Err("bootstrap_arguments_invalid");}
    let mut fields=HashMap::new();let mut pairs=args[1..].chunks_exact(2);
    for pair in &mut pairs {
        if !matches!(pair[0].as_str(),"--state-root"|"--request-nonce") || fields.insert(pair[0].as_str(),pair[1].as_str()).is_some(){return Err("bootstrap_arguments_invalid");}
    }
    if !pairs.remainder().is_empty(){return Err("bootstrap_arguments_invalid");}
    let root=PathBuf::from(*fields.get("--state-root").ok_or("readonly_state_root_required")?);
    let nonce=uuid::Uuid::parse_str(fields.get("--request-nonce").ok_or("readonly_nonce_invalid")?)
        .map_err(|_|"readonly_nonce_invalid")?.to_string();
    Ok((root,nonce))
}
fn bootstrap_stage(result:&Value,nonce:&str,status:&str)->Result<(i32,u32),&'static str> {
    if result.get("isError").is_some_and(|v|v!=&json!(false)) || result.get("degraded").is_some_and(|v|v!=&json!(false)) {
        return Err(bootstrap_reason(result));
    }
    let value=&result["structuredContent"];
    if value["schema_version"]!=1 || value["producer_version"]!="harness-controlled-textedit-bootstrap-v1"
        || value["scope"]!="com.apple.TextEdit-controlled-document-bootstrap" || value["status"]!=status
        || value["request_nonce"]!=nonce || value["input_authorized"]!=false {return Err("bootstrap_stage_not_verified");}
    let pid=value["pid"].as_i64().and_then(|n|i32::try_from(n).ok()).filter(|n|*n>0).ok_or("bootstrap_stage_not_verified")?;
    let id=value["window_id"].as_u64().and_then(|n|u32::try_from(n).ok()).filter(|n|*n>0).ok_or("bootstrap_stage_not_verified")?;
    if status!="candidate" && value["activation_started"]!=true {return Err("bootstrap_stage_not_verified");}
    Ok((pid,id))
}
const BOOT_REASONS:&[&str]=&["bootstrap_arguments_invalid","bootstrap_task_not_authorized","bootstrap_nonce_invalid",
    "bootstrap_ref_invalid","bootstrap_title_limit","bootstrap_title_invalid","bootstrap_request_expired","bootstrap_worker_unavailable",
    "bootstrap_worker_outcome_unknown","bootstrap_enumeration_limit","bootstrap_document_not_found","bootstrap_document_ambiguous",
    "bootstrap_root_unknown","bootstrap_root_not_ready","bootstrap_parent_mismatch","bootstrap_children_limit","bootstrap_instance_invalid",
    "bootstrap_matched_target_not_ordinary","bootstrap_identity_kind_unsupported","bootstrap_identity_title_unknown",
    "bootstrap_non_target_relationship_unknown","bootstrap_non_target_dialog_not_excludable",
    "bootstrap_non_target_identity_changed",
    "bootstrap_identity_pid_mismatch","bootstrap_identity_role_missing","bootstrap_identity_subrole_missing",
    "bootstrap_identity_title_missing","bootstrap_identity_parent_missing","bootstrap_identity_window_id_zero",
    "bootstrap_target_pid_mismatch","bootstrap_target_role_missing","bootstrap_target_subrole_missing",
    "bootstrap_target_title_missing","bootstrap_target_minimized_missing","bootstrap_target_modal_missing",
    "bootstrap_target_parent_missing","bootstrap_target_children_missing","bootstrap_target_sheets_missing",
    "bootstrap_target_relationship_children_missing","bootstrap_excluded_dialog_children_missing",
    "bootstrap_focused_object_mismatch","bootstrap_focused_pid_mismatch","bootstrap_focused_window_id_mismatch",
    "bootstrap_focused_app_pid_mismatch","bootstrap_focused_window_missing","bootstrap_focused_hidden_missing",
    "bootstrap_focused_title_mismatch","bootstrap_focused_geometry_changed",
    "bootstrap_focused_application_changed",
    "bootstrap_ax_unavailable","bootstrap_instance_unknown","bootstrap_identity_duplicate","bootstrap_ref_expired_or_mismatched",
    "bootstrap_activation_unconfirmed","bootstrap_foreground_unconfirmed","bootstrap_accessibility_required","bootstrap_ref_unavailable",
    "bootstrap_activation_required","bootstrap_discovery_consumed","bootstrap_identity_changed","bootstrap_activation_consumed"];
fn bootstrap_reason(result:&Value)->&'static str {
    let value=&result["structuredContent"];
    if value["schema_version"]!=1 || value["producer_version"]!="harness-controlled-textedit-bootstrap-v1"
        || value["scope"]!="com.apple.TextEdit-controlled-document-bootstrap" || value["status"]!="unknown" {return "bootstrap_stage_not_verified";}
    let reason=value["reason_code"].as_str().unwrap_or("");
    BOOT_REASONS.iter().chain(AX_REASONS).chain(IDENTITY_REASONS).chain(SELECTED_IDENTITY_REASONS)
        .copied().find(|allowed|*allowed==reason).unwrap_or("bootstrap_stage_not_verified")
}
fn bootstrap_ax_diagnostic(result:&Value)->Option<Value> {
    let value=&result["structuredContent"];
    if result["isError"]!=true || value["schema_version"]!=1 || value["producer_version"]!="harness-controlled-textedit-bootstrap-v1"
        || value["scope"]!="com.apple.TextEdit-controlled-document-bootstrap" || value["status"]!="unknown" {return None;}
    let diagnostic=&value["ax_diagnostic"];
    let phase=diagnostic["phase"].as_str()?;let operation=diagnostic["operation"].as_str()?;
    let attribute=diagnostic["attribute"].as_str()?;let class=diagnostic["error_class"].as_str()?;
    if !["instance","identity","target_ready","target_relationships","excluded_dialog_relationships","foreground","other"].contains(&phase)
        || !["messaging_timeout","attribute_names","attribute_value","pid","window_id"].contains(&operation)
        || !["role","subrole","title","parent","windows","focused_window","children","sheets","minimized","modal","hidden","other"].contains(&attribute)
        || !["failure","illegal_argument","invalid_element","cannot_complete","unsupported","api_disabled","no_value","null_result","wrong_type","invalid_value","other"].contains(&class)
        || (operation!="attribute_value" && attribute!="other")
        || (class=="null_result" && !["attribute_names","attribute_value"].contains(&operation))
        || (class=="wrong_type" && !["attribute_names","attribute_value"].contains(&operation))
        || (class=="invalid_value" && !["attribute_value","pid","window_id"].contains(&operation)) {return None;}
    Some(json!({"phase":phase,"operation":operation,"attribute":attribute,"error_class":class}))
}
fn bootstrap_cg_diagnostic(result:&Value)->Option<Value> {
    let value=&result["structuredContent"];
    if result["isError"]!=true || value["schema_version"]!=1 || value["producer_version"]!="harness-controlled-textedit-bootstrap-v1"
        || value["scope"]!="com.apple.TextEdit-controlled-document-bootstrap" || value["status"]!="unknown" {return None;}
    let diagnostic=&value["cg_diagnostic"];
    let phase=diagnostic["phase"].as_str()?;let field=diagnostic["field"].as_str()?;let class=diagnostic["error_class"].as_str()?;
    if !["target_cg","excluded_dialog_cg"].contains(&phase){return None;}
    let allowed=match field {
        "description"=>["unavailable","wrong_type","empty","multiple"].contains(&class),
        "owner"|"id"|"layer"=>["missing","wrong_type","conversion","out_of_range","mismatch"].contains(&class),
        "onscreen"=>["wrong_type","conversion","not_ordered_missing","not_ordered_false"].contains(&class),
        "bounds"=>["missing","wrong_type","conversion"].contains(&class),
        "x"|"y"|"width"|"height"=>["missing","wrong_type","conversion","out_of_range"].contains(&class),_=>false,
    };
    if !allowed || (matches!(class,"not_ordered_missing"|"not_ordered_false") && phase!="target_cg"){return None;}
    let reason=if field=="description" {match class {"unavailable"=>"identity_cg_failed","wrong_type"=>"identity_cg_type",_=>"identity_cg_ambiguous"}}
        else {match class {"not_ordered_missing"|"not_ordered_false"=>"identity_cg_not_visible","mismatch"=>"identity_cg_identity_mismatch",_=>"identity_cg_invalid"}};
    if value["reason_code"]!=reason{return None;}
    Some(json!({"phase":phase,"field":field,"error_class":class}))
}
fn bootstrap_comparison_diagnostic(result:&Value,stage:&str)->Option<Value> {
    let value=&result["structuredContent"];
    if result["isError"]!=true || value["schema_version"]!=1 || value["producer_version"]!="harness-controlled-textedit-bootstrap-v1"
        || value["scope"]!="com.apple.TextEdit-controlled-document-bootstrap" || value["status"]!="unknown"
        || value["reason_code"]!="bootstrap_identity_changed" {return None;}
    let diagnostic=&value["comparison_diagnostic"];
    let phase=diagnostic["phase"].as_str()?;let component=diagnostic["component"].as_str()?;
    let compatible=matches!((stage,phase),("discovery","first_pair")|("activation","preactivate"|"postactivate")|("finalize","finalize"));
    if !compatible
        || !["app_semantics","application_terminated","numeric_identity","cg_geometry","ax_identity","unclassified"].contains(&component) {return None;}
    Some(json!({"phase":phase,"component":component}))
}
fn bootstrap_activation_diagnostic(result:&Value,stage:&str)->Option<Value> {
    let value=&result["structuredContent"];
    if stage!="activation" || result["isError"]!=true || value["schema_version"]!=1
        || value["producer_version"]!="harness-controlled-textedit-bootstrap-v1"
        || value["scope"]!="com.apple.TextEdit-controlled-document-bootstrap" || value["status"]!="unknown" {return None;}
    let diagnostic=&value["activation_diagnostic"];
    let step=diagnostic["step"].as_str()?;let class=diagnostic["error_class"].as_str()?;
    let valid=match step {
        "persistent_front"|"exact_key_front"=>["unavailable","target_unresolved","write_rejected"].contains(&class),
        "exact_key_press"=>["unavailable","write_rejected"].contains(&class),"exact_key_release"=>class=="write_rejected",
        "ax_raise"|"ax_main"=>["failure","illegal_argument","invalid_element","cannot_complete","unsupported","action_unsupported","not_implemented","api_disabled","no_value","other"].contains(&class),
        "confirmation"=>["front_unknown","front_mismatch","order_unknown","order_conflict","order_unconfirmed","stability_deadline"].contains(&class),
        "focus_bridge"=>class=="verification_rejected" && bootstrap_reason(result)!="bootstrap_stage_not_verified",
        _=>false,
    };
    if !valid || (step!="focus_bridge" && value["reason_code"]!="bootstrap_activation_unconfirmed"){return None;}
    Some(json!({"step":step,"error_class":class}))
}
fn bootstrap_topology(response:&DaemonResponse,options:&Options,nonce:&str)->Result<(),&'static str> {
    let value=verified_result(response,options,TARGET,Some(nonce))?;
    if value["ax"]["overlays"].as_array().is_none_or(|values|!values.is_empty()){return Err("bootstrap_topology_unknown");}
    // Validate the actual bounded numeric evidence, not just diagnostic flags.
    let rows=value["cg_after"]["rows"].as_array().ok_or("bootstrap_topology_unknown")?;
    let mut ids=std::collections::HashSet::new();
    for (index,row) in rows.iter().enumerate() {
        let pid=row["pid"].as_i64().and_then(|n|i32::try_from(n).ok()).filter(|n|*n>0).ok_or("bootstrap_topology_unknown")?;
        let id=row["window_id"].as_u64().and_then(|n|u32::try_from(n).ok()).filter(|n|*n>0).ok_or("bootstrap_topology_unknown")?;
        if !ids.insert(id) || row["layer"].as_i64().and_then(|n|i32::try_from(n).ok()).is_none()
            || row["z_index"].as_u64()!=Some((rows.len()-index) as u64){return Err("bootstrap_topology_unknown");}
        let bounds=&row["bounds"];
        for key in ["x","y","width","height"] {
            let number=bounds[key].as_f64().filter(|n|n.is_finite() && n.abs()<=1e9).ok_or("bootstrap_topology_unknown")?;
            if matches!(key,"width"|"height") && number<=0.0{return Err("bootstrap_topology_unknown");}
        }
        let spaces=row["space_ids"].as_array().filter(|v|!v.is_empty() && v.len()<=32).ok_or("bootstrap_topology_unknown")?;
        let mut seen=std::collections::HashSet::new();
        for space in spaces {let id=space.as_u64().filter(|n|*n>0).ok_or("bootstrap_topology_unknown")?;if !seen.insert(id){return Err("bootstrap_topology_unknown");}}
        if !row["current_space_id"].as_u64().is_some_and(|id|seen.contains(&id)){return Err("bootstrap_topology_unknown");}
        // No row is a grant. The exact target checks in verified_result remain.
        let _=pid;
    }
    Ok(())
}
fn bootstrap(args:&[String])->Result<(),&'static str> {
    let task_mode=args.first().map(String::as_str)==Some("textedit-task-target-bootstrap");
    let (path,nonce)=bootstrap_options(args)?;
    if std::env::vars_os().any(|(key,value)|key.to_str().is_some_and(|key|!environment_allowed(key,value.to_str().unwrap_or("")))){return Err("readonly_environment_conflict");}
    let root=StateRoot::open(&path)?;let policy=root.path.join(POLICY);root.policy_path(&policy)?;
    if std::env::var_os("CUA_DRIVER_POLICY_FILE").is_some_and(|path|Path::new(&path)!=policy){return Err("readonly_policy_not_private");}
    if let Some(managed)=std::env::var_os("CUA_DRIVER_MANAGED_POLICY_FILE"){root.policy_path(Path::new(&managed))?;}
    std::env::set_var("CUA_DRIVER_POLICY_FILE",&policy);
    crate::configure_startup_permission_mode(Some("standard"),false,None,false,&[]).map_err(|_|"readonly_authorization_invalid")?;
    let _marker=root.create("bootstrap.once")?; // Fresh private root; no cleanup/unlink.
    let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_|"readonly_runtime_unavailable")?;
    let mut registry=ToolRegistry::new();
    if task_mode{platform_macos::tools::register_controlled_textedit_task_target(&mut registry);}
    else {platform_macos::tools::register_controlled_textedit_bootstrap(&mut registry);
        platform_macos::tools::register_target_topology_readonly(&mut registry);}
    let mut activation_requested=false;let mut activation_started=false;let mut stage="discovery";let mut ax_evidence=None;let mut cg_evidence=None;let mut comparison_evidence=None;let mut activation_evidence=None;
    let mut topology_evidence=json!({});
    let outcome=runtime.block_on(async {
        let read_args=json!({"bundle_id":"com.apple.TextEdit","document_title":BOOT_TITLE,"request_nonce":nonce});
        root.check()?;
        let candidate=serde_json::to_value(registry.invoke_from_trusted_adapter(BOOT_READ,read_args.clone()).await).map_err(|_|"bootstrap_response_invalid")?;
        ax_evidence=bootstrap_ax_diagnostic(&candidate);
        cg_evidence=bootstrap_cg_diagnostic(&candidate);
        comparison_evidence=bootstrap_comparison_diagnostic(&candidate,"discovery");
        let identity=bootstrap_stage(&candidate,&nonce,"candidate")?;
        let reference=candidate["structuredContent"]["candidate_ref"].as_str().and_then(|v|uuid::Uuid::parse_str(v).ok())
            .ok_or("bootstrap_ref_invalid")?.to_string();
        root.check()?;activation_requested=true;stage="activation";
        let activated=serde_json::to_value(registry.invoke_from_trusted_adapter(BOOT_WRITE,json!({"candidate_ref":reference,"request_nonce":nonce})).await)
            .map_err(|_|"bootstrap_response_invalid")?;
        activation_started=activated["structuredContent"]["activation_started"]==true;
        ax_evidence=bootstrap_ax_diagnostic(&activated);
        cg_evidence=bootstrap_cg_diagnostic(&activated);
        comparison_evidence=bootstrap_comparison_diagnostic(&activated,"activation");
        activation_evidence=bootstrap_activation_diagnostic(&activated,"activation");
        if bootstrap_stage(&activated,&nonce,"activated")?!=identity{return Err("bootstrap_identity_changed");}
        root.check()?;stage="topology";
        if task_mode {
            let caps=serde_json::to_value(registry.invoke_from_trusted_adapter(TASK_CAP,json!({})).await).map_err(|_|"bootstrap_response_invalid")?;
            if caps.get("isError").is_some_and(|v|v!=&json!(false)) || !task_contract(&caps["structuredContent"]){return Err("task_capability_invalid");}
            let probe=serde_json::to_value(registry.invoke_from_trusted_adapter(TASK_PROOF,json!({"candidate_ref":reference,"request_nonce":nonce})).await).map_err(|_|"bootstrap_response_invalid")?;
            let (evidence,verified)=task_evidence(&probe,&nonce,identity);topology_evidence=evidence;
            if !verified{return Err("task_target_not_verified");}
        }else{
        let options=Options {root:path.clone(),pid:identity.0,window_id:identity.1,call:None};
        let caps=DaemonResponse::ok(serde_json::to_value(registry.invoke_from_trusted_adapter(CAPABILITIES,json!({})).await).map_err(|_|"bootstrap_response_invalid")?);
        verified_result(&caps,&options,CAPABILITIES,None)?;
        let probe_nonce=uuid::Uuid::new_v4().to_string();
        let probe=DaemonResponse::ok(serde_json::to_value(registry.invoke_from_trusted_adapter(TARGET,
            json!({"pid":identity.0,"window_id":identity.1,"request_nonce":probe_nonce})).await).map_err(|_|"bootstrap_response_invalid")?);
        topology_evidence=safe_evidence(&probe,&options,TARGET,Some(&probe_nonce));
        bootstrap_topology(&probe,&options,&probe_nonce)?;
        }
        root.check()?;stage="finalize";
        let mut final_args=read_args;final_args["candidate_ref"]=json!(reference);
        let final_result=serde_json::to_value(registry.invoke_from_trusted_adapter(BOOT_READ,final_args).await).map_err(|_|"bootstrap_response_invalid")?;
        ax_evidence=bootstrap_ax_diagnostic(&final_result);
        cg_evidence=bootstrap_cg_diagnostic(&final_result);
        comparison_evidence=bootstrap_comparison_diagnostic(&final_result,"finalize");
        if bootstrap_stage(&final_result,&nonce,"finalized")?!=identity{return Err("bootstrap_identity_changed");}
        root.check()?;
        Ok::<_,&'static str>(identity)
    });
    // Outputs are rebuilt from fixed vocabulary and typed identities only.
    match outcome {
        Ok((pid,id))=>{println!("{}",json!({"status":"prepared_candidate","request_nonce":nonce,"pid":pid,"window_id":id,
            "activation_started":true,"fresh_admission_required":true,"input_authorized":false,"run_ref_issued":false,"topology":topology_evidence}));Ok(())},
        Err(reason)=>{println!("{}",json!({"status":"unknown","stage":stage,"reason_code":reason,"request_nonce":nonce,
            "activation_requested":activation_requested,"activation_started":activation_started,"activation_may_have_started":activation_requested,
            "input_authorized":false,"run_ref_issued":false,"topology":topology_evidence,"ax_diagnostic":ax_evidence,"cg_diagnostic":cg_evidence,"comparison_diagnostic":comparison_evidence,"activation_diagnostic":activation_evidence}));Err("bootstrap_not_prepared")},
    }
}

const SESSION_PREPARE:&str="prepare_textedit_new_window_observation";
const SESSION_OPEN:&str="open_textedit_new_window_session";
const SESSION_OBSERVE:&str="observe_textedit_window_session";
const SESSION_CLOSE:&str="close_textedit_window_session";
// Exact errors reachable through session Native::open/validate's shared CG and
// MatchedOrdinary relationship helpers. Never accept arbitrary prefixes or the
// unrelated old title-bootstrap/activation error namespace.
const SESSION_SHARED_REASONS:&[&str]=&[
    "identity_cg_failed","identity_cg_type","identity_cg_ambiguous","identity_cg_invalid","identity_cg_not_visible","identity_cg_identity_mismatch",
    "identity_attached_window","identity_child_role_unknown","bootstrap_target_relationship_children_missing","bootstrap_children_limit","bootstrap_parent_mismatch",
];
fn session_stage_projection(result:&Value,nonce:&str,tool:&str)->Result<Value,&'static str>{
    let stage=match tool{SESSION_PREPARE=>"prepare",SESSION_OPEN=>"open",SESSION_OBSERVE=>"observe",SESSION_CLOSE=>"close",_=>return Err("session_response_invalid")};
    let mut safe=session_projection(result,nonce)?;safe["stage"]=json!(stage);
    let reason=safe["reason_code"].as_str().unwrap_or("");
    if result["isError"]==true && safe["status"]=="unknown" && matches!(stage,"open"|"observe"){
        if let Some(diagnostic)=session_child_projection(&result["structuredContent"]["child_diagnostic"],reason){safe["child_diagnostic"]=diagnostic;}}
    Ok(safe)
}
fn session_child_projection(value:&Value,reason:&str)->Option<Value>{
    if value["phase"]!="target_relationships"{return None;}
    let role=value["role_class"].as_str()?;let sub=value["subrole_class"].as_str()?;
    if !["color_well","combo_box","legacy_control","attached","other"].contains(&role) || !["absent","unknown","attached","other"].contains(&sub){return None;}
    let valid=match reason{"identity_attached_window"=>role=="attached" || sub=="attached",
        "session_child_role_unknown"=>role!="attached" && sub!="attached" && (sub=="unknown" || role=="other"),_=>false};
    valid.then(||json!({"phase":"target_relationships","role_class":role,"subrole_class":sub}))
}
fn session_request(value:&Value)->Result<(&'static str,Value),&'static str>{
    let object=value.as_object().ok_or("session_request_invalid")?;
    let method=value["method"].as_str().ok_or("session_request_invalid")?;
    let tool=match method{"prepare"=>SESSION_PREPARE,"open"=>SESSION_OPEN,"observe"=>SESSION_OBSERVE,"close"=>SESSION_CLOSE,_=>return Err("session_request_invalid")};
    let prepare=method=="prepare";
    if object.len()!=if prepare{2}else{3} || !object.keys().all(|key|matches!(key.as_str(),"method"|"request_nonce") || (!prepare && key=="session_ref")){return Err("session_request_invalid");}
    let nonce=uuid::Uuid::parse_str(value["request_nonce"].as_str().ok_or("session_request_invalid")?).map_err(|_|"session_request_invalid")?.to_string();
    let args=if prepare{json!({"bundle_id":"com.apple.TextEdit","request_nonce":nonce})}else{
        let reference=uuid::Uuid::parse_str(value["session_ref"].as_str().ok_or("session_request_invalid")?).map_err(|_|"session_request_invalid")?.to_string();
        json!({"session_ref":reference,"request_nonce":nonce})};Ok((tool,args))
}
fn session_projection(result:&Value,nonce:&str)->Result<Value,&'static str>{
    let v=&result["structuredContent"];
    if v["schema_version"]!=1 || v["producer_version"]!="harness-textedit-window-session-v1"
        || v["scope"]!="com.apple.TextEdit-new-window-observation-session" || v["request_nonce"]!=nonce
        || v["input_authorized"]!=false || v["run_ref_issued"]!=false || v["global_topology_complete"]!=false || v["activation_started"]!=false{return Err("session_response_invalid");}
    let status=v["status"].as_str().ok_or("session_response_invalid")?;
    let mut safe=json!({"schema_version":1,"producer_version":"harness-textedit-window-session-v1","scope":"com.apple.TextEdit-new-window-observation-session",
        "status":status,"request_nonce":nonce,"input_authorized":false,"run_ref_issued":false,"global_topology_complete":false,"activation_started":false});
    if result["isError"]==true{
        if !matches!(status,"unknown"|"closing"){return Err("session_response_invalid");}
        let reason=v["reason_code"].as_str().unwrap_or("");
        const REASONS:&[&str]=&["session_arguments_invalid","session_task_not_authorized","session_state_unavailable","session_ref_invalid","session_closed","session_pending","session_worker_unavailable","session_pending_terminal",
            "session_request_expired","session_request_limit","session_nonce_consumed","session_prepare_consumed","session_open_consumed","session_ref_expired","session_baseline_unavailable","session_not_open","session_observation_limit",
            "session_accessibility_required","session_inventory_limit","session_application_unknown","session_identity_unknown","session_inventory_unknown","session_new_window_ambiguous","session_baseline_changed","session_identity_changed",
            "session_relationship_unknown","session_geometry_changed","session_viewport_invalid","session_pixel_limit","session_sc_inventory_invalid","session_sc_target_missing","session_sc_identity_changed","session_sc_inventory_unavailable",
            "session_screen_recording_required","session_capture_failed","session_image_invalid","session_viewport_changed","session_encode_failed","session_child_role_unknown"];
        safe["reason_code"]=json!(if REASONS.contains(&reason) || AX_REASONS.contains(&reason) || SESSION_SHARED_REASONS.contains(&reason){reason}else{"session_not_verified"});return Ok(safe);
    }
    if result.get("isError").is_some_and(|v|v!=&json!(false)) || !matches!(status,"prepared_baseline"|"open"|"observed"|"closing"|"closed"){return Err("session_response_invalid");}
    let reference=uuid::Uuid::parse_str(v["session_ref"].as_str().ok_or("session_response_invalid")?).map_err(|_|"session_response_invalid")?.to_string();safe["session_ref"]=json!(reference);
    if status=="prepared_baseline"{if v["ttl_ms"]!=30000 || v["gui_new_provenance_required"]!=true{return Err("session_response_invalid");}safe["ttl_ms"]=json!(30000);safe["gui_new_provenance_required"]=json!(true);}
    if matches!(status,"open"|"observed"){if v["generation"]!=1{return Err("session_response_invalid");}safe["generation"]=json!(1);}
    if status=="open"{if v["ttl_ms"]!=60000 || v["identity_evidence"]!="bounded_new_window" || v["creation_receipt_verified"]!=false{return Err("session_response_invalid");}
        safe["ttl_ms"]=json!(60000);safe["identity_evidence"]=json!("bounded_new_window");safe["creation_receipt_verified"]=json!(false);}
    if status=="observed"{
        let epoch=v["frame_epoch"].as_u64().filter(|n|matches!(*n,1|2)).ok_or("session_response_invalid")?;
        let viewport=&v["viewport"];let mut rect=json!({});
        for key in ["x","y","width","height"]{let n=viewport["content_rect"][key].as_f64().filter(|n|n.is_finite() && (!matches!(key,"width"|"height") || *n>0.0)).ok_or("session_viewport_invalid")?;rect[key]=json!(n);}
        let scale=viewport["point_pixel_scale"].as_f64().filter(|s|s.is_finite() && *s>0.0 && *s<=16.0).ok_or("session_viewport_invalid")?;
        let w=viewport["pixel_width"].as_u64().filter(|n|*n>0 && *n<=8192).ok_or("session_viewport_invalid")?;
        let h=viewport["pixel_height"].as_u64().filter(|n|*n>0 && *n<=8192).ok_or("session_viewport_invalid")?;
        let bytes=w.checked_mul(h).and_then(|n|n.checked_mul(4)).filter(|n|*n<=64*1024*1024).ok_or("session_pixel_limit")?;
        if (rect["width"].as_f64().unwrap()*scale).round()!=w as f64 || (rect["height"].as_f64().unwrap()*scale).round()!=h as f64 || viewport["rgba_bytes"]!=bytes{return Err("session_viewport_invalid");}
        safe["frame_epoch"]=json!(epoch);safe["viewport"]=json!({"content_rect":rect,"point_pixel_scale":scale,"pixel_width":w,"pixel_height":h,"rgba_bytes":bytes});
    }Ok(safe)
}
fn session_publish(result:&Value,safe:&mut Value,root:&StateRoot,publication:&platform_macos::tools::TexteditSessionPublication)->Result<(),&'static str>{
    use base64::{Engine,engine::general_purpose::STANDARD};
    let content=result["content"].as_array().filter(|v|v.len()==1).ok_or("session_image_invalid")?;
    if content[0]["type"]!="image" || content[0]["mimeType"]!="image/png"{return Err("session_image_invalid");}
    let encoded=content[0]["data"].as_str().filter(|s|s.len()<=90*1024*1024).ok_or("session_pixel_limit")?;
    let png=STANDARD.decode(encoded).map_err(|_|"session_image_invalid")?;
    if png.len()<33 || png.len()>64*1024*1024 || &png[..8]!=b"\x89PNG\r\n\x1a\n" || &png[12..16]!=b"IHDR"{return Err("session_image_invalid");}
    let w=u32::from_be_bytes(png[16..20].try_into().unwrap());let h=u32::from_be_bytes(png[20..24].try_into().unwrap());
    if safe["viewport"]["pixel_width"]!=w || safe["viewport"]["pixel_height"]!=h{return Err("session_image_invalid");}
    let epoch=safe["frame_epoch"].as_u64().ok_or("session_image_invalid")?;
    let reference=safe["session_ref"].as_str().ok_or("session_ref_invalid")?;let name=if epoch==1{"frame-1.png"}else{"frame-2.png"};
    let created=std::cell::Cell::new(false);
    let published=publication.publish(reference,epoch,||{root.check()?;let mut entry=root.create(name)?;created.set(true);
        entry.file.write_all(&png).map_err(|_|"session_artifact_failed")?;entry.file.sync_all().map_err(|_|"session_artifact_failed")?;root.check()});
    if let Err(reason)=published{return Err(if created.get(){"session_artifact_uncommitted_possible"}else{reason});}
    safe["artifact_path"]=json!(root.path.join(name));safe["png_bytes"]=json!(png.len());Ok(())
}
fn session_write(writer:&mut impl Write,value:&Value)->Result<(),&'static str>{
    writeln!(writer,"{value}").map_err(|_|"session_output_failed")?;writer.flush().map_err(|_|"session_output_failed")
}
fn session_output(value:&Value)->Result<(),&'static str>{session_write(&mut std::io::stdout().lock(),value)}
fn window_session(args:&[String])->Result<(),&'static str>{
    if args.len()!=3 || args[0]!="textedit-new-window-session" || args[1]!="--state-root"{return Err("session_arguments_invalid");}
    let root=StateRoot::open(Path::new(&args[2]))?;let policy=root.path.join(POLICY);root.policy_path(&policy)?;
    if std::env::vars_os().any(|(key,value)|key.to_str().is_some_and(|key|!environment_allowed(key,value.to_str().unwrap_or("")))){return Err("readonly_environment_conflict");}
    if std::env::var_os("CUA_DRIVER_POLICY_FILE").is_some_and(|p|Path::new(&p)!=policy){return Err("readonly_policy_not_private");}
    if let Some(managed)=std::env::var_os("CUA_DRIVER_MANAGED_POLICY_FILE"){root.policy_path(Path::new(&managed))?;}
    std::env::set_var("CUA_DRIVER_POLICY_FILE",&policy);
    crate::configure_startup_permission_mode(Some("standard"),false,None,false,&[]).map_err(|_|"readonly_authorization_invalid")?;
    let _marker=root.create("window-session.once")?;
    let mut registry=ToolRegistry::new();let publication=platform_macos::tools::register_textedit_new_window_session(&mut registry);
    let registry=std::sync::Arc::new(registry);
    let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_|"readonly_runtime_unavailable")?;
    let (sender,mut receiver)=tokio::sync::mpsc::channel(4);
    std::thread::spawn(move||{use std::io::Read;let mut stdin=std::io::stdin().lock();loop{
        let mut frame=Vec::new();loop{let mut byte=[0u8;1];match stdin.read(&mut byte){Ok(0)=>return,Ok(_)=>{if byte[0]==b'\n'{break;}frame.push(byte[0]);if frame.len()>MAX_FRAME{let _=sender.blocking_send(Err("session_frame_invalid"));return;}},Err(_)=>return}}
        let value=serde_json::from_slice::<Value>(&frame).map_err(|_|"session_frame_invalid");if sender.blocking_send(value).is_err(){return;}}});
    runtime.block_on(async {
        type Pending=std::pin::Pin<Box<dyn std::future::Future<Output=(&'static str,String,Value)>>>;
        let outcome=async {
        let mut pending:Option<Pending>=None;let mut reference:Option<String>=None;let mut eof=false;
        loop {
            if pending.is_none(){
                if eof{break;}
                let frame=match receiver.recv().await{Some(v)=>v,None=>{eof=true;continue;}}?;
                let (tool,payload)=session_request(&frame)?;root.check()?;
                if tool==SESSION_CLOSE{
                    let nonce=payload["request_nonce"].as_str().unwrap().to_owned();let result=serde_json::to_value(registry.invoke_from_trusted_adapter(tool,payload).await).map_err(|_|"session_response_invalid")?;
                    let safe=session_stage_projection(&result,&nonce,tool)?;session_output(&safe)?;
                    if safe["status"]=="closed"{break;}continue;
                }
                let registry=registry.clone();let nonce=payload["request_nonce"].as_str().unwrap().to_owned();
                pending=Some(Box::pin(async move{let result=registry.invoke_from_trusted_adapter(tool,payload).await;
                    (tool,nonce,serde_json::to_value(result).unwrap_or(Value::Null))}));
            }
            if let Some(work)=pending.as_mut(){tokio::select!{
                (tool,nonce,result)=work=>{pending=None;let mut safe=session_stage_projection(&result,&nonce,tool)?;
                    if safe["status"]=="observed"{session_publish(&result,&mut safe,&root,&publication)?;}
                    if let Some(r)=safe["session_ref"].as_str(){reference=Some(r.to_owned());}
                    if safe["status"]=="observed"{
                        publication.emit(safe["session_ref"].as_str().ok_or("session_ref_invalid")?,safe["frame_epoch"].as_u64().ok_or("session_image_invalid")?,||{
                            session_output(&safe)})?;
                    }else{session_output(&safe)?;}
                },
                frame=receiver.recv(),if !eof=>{match frame{
                    Some(value)=>{let (tool,payload)=session_request(&value?)?;
                        if tool==SESSION_CLOSE{let nonce=payload["request_nonce"].as_str().unwrap().to_owned();let result=serde_json::to_value(registry.invoke_from_trusted_adapter(tool,payload).await).map_err(|_|"session_response_invalid")?;
                            session_output(&session_stage_projection(&result,&nonce,tool)?)?;
                        }else{session_output(&json!({"status":"unknown","reason_code":"session_pending","input_authorized":false,"run_ref_issued":false}))?;}
                    },None=>{eof=true;if let Some(r)=&reference{let _=registry.invoke_from_trusted_adapter(SESSION_CLOSE,json!({"session_ref":r,"request_nonce":uuid::Uuid::new_v4().to_string()})).await;}}
                }}
            }}
        }
        Ok::<(),&'static str>(())
        }.await;
        publication.revoke();
        if !publication.terminal(){
            // Pending native callbacks are not interruptible. Never claim a
            // closed/released session until the actual actor terminal is seen.
            while !publication.terminal(){tokio::time::sleep(Duration::from_millis(50)).await;}}
        if outcome.is_ok(){session_output(&json!({"schema_version":1,"producer_version":"harness-textedit-window-session-v1","scope":"com.apple.TextEdit-new-window-observation-session",
            "status":"closed","terminal":true,"released":true,"input_authorized":false,"run_ref_issued":false,"global_topology_complete":false,"activation_started":false}))?;}
        outcome
    })
}
fn run(args: &[String]) -> Result<(), &'static str> {
    if args.first().map(String::as_str)==Some("textedit-new-window-session"){return window_session(args);}
    if matches!(args.first().map(String::as_str),Some("textedit-task-bootstrap"|"textedit-task-target-bootstrap")){return bootstrap(args);}
    if matches!(args.first().map(String::as_str),Some("textedit-identity-readonly"|"textedit-selected-identity-readonly")) { return discover(args); }
    let options = options(args)?;
    if std::env::vars_os().any(|(key, value)| key.to_str().is_some_and(|key| !environment_allowed(key, value.to_str().unwrap_or("")))) {
        return Err("readonly_environment_conflict");
    }
    let root = StateRoot::open(&options.root)?;
    if options.call.is_some() { return client(&root, &options); }
    let policy = root.path.join(POLICY);
    root.policy_path(&policy)?;
    if let Some(configured) = std::env::var_os("CUA_DRIVER_POLICY_FILE") {
        if Path::new(&configured) != policy { return Err("readonly_policy_not_private"); }
    }
    if let Some(managed) = std::env::var_os("CUA_DRIVER_MANAGED_POLICY_FILE") { root.policy_path(Path::new(&managed))?; }
    // Per-process trusted startup configuration only; HOME/PATH are untouched.
    std::env::set_var("CUA_DRIVER_POLICY_FILE", &policy);
    crate::configure_startup_permission_mode(Some("standard"), false, None, false, &[]).map_err(|_| "readonly_authorization_invalid")?;
    if !platform_macos::permissions::status::accessibility_granted() { return Err("readonly_accessibility_required"); }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| "readonly_runtime_unavailable")?;
    runtime.block_on(serve(&root, &options))
}

fn requested(args: &[String]) -> Result<bool, &'static str> {
    let is_mode = |s: &str| matches!(s, "topology-readonly" | "topology-readonly-call" | "textedit-identity-readonly" | "textedit-selected-identity-readonly" | "textedit-task-bootstrap" | "textedit-task-target-bootstrap" | "textedit-new-window-session");
    let count = args.iter().filter(|arg| is_mode(arg)).count();
    if count == 0 { return Ok(false); }
    if count != 1 || !args.first().is_some_and(|arg| is_mode(arg)) { return Err("readonly_arguments_invalid"); }
    Ok(true)
}

pub fn run_if_requested() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match requested(&args) { Ok(false) => return None, Ok(true) => {}, Err(code) => { eprintln!("{code}"); return Some(77); } }
    Some(match run(&args) { Ok(()) => 0, Err(code) => { eprintln!("{code}"); 77 } })
}

#[cfg(test)]
mod tests {
    #[test]fn new_window_session_child_diagnostic_is_closed_error_only_not_an_admission(){
        let nonce=uuid::Uuid::new_v4().to_string();let mut result=session_fixture(&nonce);result["isError"]=json!(true);result["structuredContent"]["status"]=json!("unknown");result["structuredContent"]["reason_code"]=json!("session_child_role_unknown");
        result["structuredContent"]["child_diagnostic"]=json!({"phase":"target_relationships","role_class":"combo_box","subrole_class":"unknown","title":"private","pid":99});
        for tool in [SESSION_OPEN,SESSION_OBSERVE]{let safe=session_stage_projection(&result,&nonce,tool).unwrap();assert_eq!(safe["child_diagnostic"]["role_class"],"combo_box");assert!(!safe.to_string().contains("private"));assert!(safe.get("artifact_path").is_none());}
        for tool in [SESSION_PREPARE,SESSION_CLOSE]{assert!(session_stage_projection(&result,&nonce,tool).unwrap().get("child_diagnostic").is_none());}
        for case in 0..5{let mut bad=result.clone();match case{0=>bad["structuredContent"]["child_diagnostic"]["phase"]=json!("private"),1=>bad["structuredContent"]["child_diagnostic"]["role_class"]=json!("private"),
            2=>bad["structuredContent"]["child_diagnostic"]["subrole_class"]=json!("private"),3=>bad["structuredContent"]["child_diagnostic"]["subrole_class"]=json!("absent"),_=>bad["structuredContent"]["reason_code"]=json!("session_geometry_changed")};
            assert!(session_stage_projection(&bad,&nonce,SESSION_OPEN).unwrap().get("child_diagnostic").is_none());}
        result["structuredContent"]["reason_code"]=json!("identity_attached_window");result["structuredContent"]["child_diagnostic"]["subrole_class"]=json!("attached");assert!(session_stage_projection(&result,&nonce,SESSION_OPEN).unwrap().get("child_diagnostic").is_some());
        result["isError"]=json!(false);assert!(session_stage_projection(&result,&nonce,SESSION_OPEN).is_err());assert!(session_stage_projection(&result,"wrong nonce",SESSION_OPEN).is_err());
    }
    #[test]fn new_window_session_shared_failure_projection_is_exact_current_and_private(){
        let nonce=uuid::Uuid::new_v4().to_string();let mut result=session_fixture(&nonce);result["isError"]=json!(true);result["structuredContent"]["status"]=json!("unknown");
        result["structuredContent"]["stage"]=json!("private native stage");result["structuredContent"]["pid"]=json!(99);
        for reason in SESSION_SHARED_REASONS{result["structuredContent"]["reason_code"]=json!(reason);let safe=session_stage_projection(&result,&nonce,SESSION_OPEN).unwrap();
            assert_eq!(safe["reason_code"],*reason);assert_eq!(safe["stage"],"open");assert!(safe.get("pid").is_none());assert!(safe.get("viewport").is_none());assert!(safe.get("artifact_path").is_none());assert!(!safe.to_string().contains("private"));}
        for (tool,stage) in [(SESSION_PREPARE,"prepare"),(SESSION_OPEN,"open"),(SESSION_OBSERVE,"observe"),(SESSION_CLOSE,"close")]{assert_eq!(session_stage_projection(&result,&nonce,tool).unwrap()["stage"],stage);}
        for reason in ["identity_cg_private","bootstrap_private","bootstrap_activation_unconfirmed","identity_attached_relationship_unknown","private raw error"]{
            result["structuredContent"]["reason_code"]=json!(reason);let safe=session_stage_projection(&result,&nonce,SESSION_OPEN).unwrap();assert_eq!(safe["reason_code"],"session_not_verified");assert!(!safe.to_string().contains(reason));}
        assert!(session_stage_projection(&result,&nonce,"private").is_err());
        assert!(session_stage_projection(&result,"different nonce",SESSION_OPEN).is_err());
        result["structuredContent"]["reason_code"]=json!(SESSION_SHARED_REASONS[0]);result["isError"]=json!(false);assert!(session_stage_projection(&result,&nonce,SESSION_OPEN).is_err());
        result["isError"]=json!(true);result["structuredContent"]["schema_version"]=json!(2);assert!(session_stage_projection(&result,&nonce,SESSION_OPEN).is_err());
        result["structuredContent"]["schema_version"]=json!(1);result["structuredContent"]["input_authorized"]=json!(true);assert!(session_stage_projection(&result,&nonce,SESSION_OPEN).is_err());
    }
    #[test]fn new_window_session_checked_output_error_does_not_panic(){
        struct Broken;impl Write for Broken{fn write(&mut self,_:&[u8])->std::io::Result<usize>{Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))}fn flush(&mut self)->std::io::Result<()>{Ok(())}}
        assert_eq!(session_write(&mut Broken,&json!({"status":"closed"})),Err("session_output_failed"));
        let mut bytes=Vec::new();session_write(&mut bytes,&json!({"status":"closed"})).unwrap();assert_eq!(bytes.last(),Some(&b'\n'));
    }
    #[test]fn new_window_session_host_request_is_fixed_without_pid_title_or_creation_claim(){
        let nonce=uuid::Uuid::new_v4().to_string();let reference=uuid::Uuid::new_v4().to_string();
        assert_eq!(session_request(&json!({"method":"prepare","request_nonce":nonce})).unwrap().0,SESSION_PREPARE);
        for method in ["open","observe","close"]{assert!(session_request(&json!({"method":method,"request_nonce":nonce,"session_ref":reference})).is_ok());}
        for key in ["pid","window_id","title","created","path","_session_id"]{let mut bad=json!({"method":"prepare","request_nonce":nonce});bad[key]=json!(true);assert!(session_request(&bad).is_err());}
        assert!(session_request(&json!({"method":"prepare","request_nonce":"bad"})).is_err());
        assert!(session_request(&json!({"method":"observe","request_nonce":nonce,"session_ref":"bad"})).is_err());
    }
    fn session_fixture(nonce:&str)->Value{json!({"structuredContent":{"schema_version":1,"producer_version":"harness-textedit-window-session-v1","scope":"com.apple.TextEdit-new-window-observation-session",
        "status":"observed","request_nonce":nonce,"session_ref":uuid::Uuid::new_v4().to_string(),"generation":1,"frame_epoch":1,"input_authorized":false,"run_ref_issued":false,"global_topology_complete":false,"activation_started":false,
        "viewport":{"content_rect":{"x":-2.0,"y":3.0,"width":10.0,"height":20.0},"point_pixel_scale":2.0,"pixel_width":20,"pixel_height":40,"rgba_bytes":3200},"title":"private","path":"private"}})}
    #[test]fn new_window_session_host_validates_actual_viewport_and_strips_private_payload(){
        let nonce=uuid::Uuid::new_v4().to_string();let fixture=session_fixture(&nonce);let safe=session_projection(&fixture,&nonce).unwrap();assert!(!safe.to_string().contains("private"));
        for case in 0..9{let mut bad=fixture.clone();match case{0=>bad["structuredContent"]["schema_version"]=json!(2),1=>bad["structuredContent"]["input_authorized"]=json!(true),
            2=>bad["structuredContent"]["viewport"]["pixel_width"]=json!(21),3=>bad["structuredContent"]["viewport"]["point_pixel_scale"]=json!(0),4=>bad["structuredContent"]["viewport"]["rgba_bytes"]=json!(1),
            5=>bad["structuredContent"]["frame_epoch"]=json!(3),6=>bad["structuredContent"]["generation"]=json!(2),7=>bad["structuredContent"]["viewport"]["content_rect"]["width"]=json!(-1),_=>bad["structuredContent"]["request_nonce"]=json!("bad")};assert!(session_projection(&bad,&nonce).is_err());}
    }
    #[test]fn new_window_session_host_unknown_is_not_an_image_or_success(){
        let nonce=uuid::Uuid::new_v4().to_string();let mut result=session_fixture(&nonce);result["isError"]=json!(true);result["structuredContent"]["status"]=json!("unknown");result["structuredContent"]["reason_code"]=json!("session_identity_changed");
        let safe=session_projection(&result,&nonce).unwrap();assert_eq!(safe["reason_code"],"session_identity_changed");assert!(safe.get("viewport").is_none());assert!(safe.get("artifact_path").is_none());
        result["structuredContent"]["reason_code"]=json!("private raw error");let safe=session_projection(&result,&nonce).unwrap();assert_eq!(safe["reason_code"],"session_not_verified");assert!(!safe.to_string().contains("private"));
    }
    fn intersection_fixture()->Value {json!({"phase":"before","public_row_count":4,"upper_row_count":2,
        "intersection_count":1,"typed_empty_row_count":2,"upper_typed_empty_row_count":1,"intersection_typed_empty_row_count":1,
        "buckets":[{"owner_relation":"other_pid","layer_relation":"above","space_state":"typed_empty","shape_relation":"partial","count":1,"private":"secret"}],"private":"secret"})}
    #[test]fn task_intersection_projection_rebuilds_closed_counts_and_rejects_bad_partitions(){
        let fixture=intersection_fixture();let safe=safe_task_intersections(&fixture).unwrap();assert!(!safe.to_string().contains("secret"));
        for case in 0..13 {let mut bad=fixture.clone();match case {
            0=>bad["buckets"][0]["count"]=json!(2),1=>{let item=bad["buckets"][0].clone();bad["buckets"].as_array_mut().unwrap().push(item);},
            2=>bad["intersection_count"]=json!(1.5),3=>bad["upper_row_count"]=json!(-1),
            4=>bad["buckets"][0]["owner_relation"]=json!("secret"),5=>bad["phase"]=json!("secret"),
            6=>bad["public_row_count"]=json!(4097),7=>bad["typed_empty_row_count"]=json!(3),
            8=>bad["upper_typed_empty_row_count"]=json!(0),9=>bad["intersection_typed_empty_row_count"]=json!(0),
            10=>bad["buckets"][0]["space_state"]=json!("verified"),11=>bad["buckets"][0]["count"]=json!(0),
            _=>{bad.as_object_mut().unwrap().remove("public_row_count");}
        }assert!(safe_task_intersections(&bad).is_none(),"case {case}");}
        let mut after=fixture;after["phase"]=json!("after");assert!(safe_task_intersections(&after).is_some());
    }
    #[test]fn task_intersection_host_requires_current_unknown_error_contract_reason_and_nonce(){
        let nonce=uuid::Uuid::new_v4().to_string();let mut result=task_fixture(&nonce);
        result["isError"]=json!(true);result["structuredContent"]["status"]=json!("unknown");
        result["structuredContent"]["reason_code"]=json!("task_upper_intersection");
        result["structuredContent"]["intersection_diagnostic"]=intersection_fixture();
        let (safe,verified)=task_evidence(&result,&nonce,(7,8));assert!(!verified);assert!(safe.get("intersection_diagnostic").is_some());
        assert!(!safe.to_string().contains("secret"));assert_eq!(safe["input_authorized"],false);
        for case in 0..5 {let mut bad=result.clone();match case {
            0=>bad["isError"]=json!(false),1=>bad["structuredContent"]["status"]=json!("verified"),
            2=>bad["structuredContent"]["reason_code"]=json!("task_public_invalid"),
            3=>bad["structuredContent"]["schema_version"]=json!(2),_=>bad["structuredContent"]["request_nonce"]=json!("wrong")
        }assert!(task_evidence(&bad,&nonce,(7,8)).0.get("intersection_diagnostic").is_none());}
    }
    fn task_fixture(nonce:&str)->Value {
        let row=|pid:u32,id:u32,z:u32,x:f64,space:Value|json!({"pid":pid,"window_id":id,"layer":0,"z_index":z,
            "bounds":{"x":x,"y":0.0,"width":10.0,"height":10.0},"space":space,"private":"secret-title"});
        let rows=json!([row(9,9,2,200.0,json!({"status":"not_proven","reason_code":"typed_empty"})),
            row(7,8,1,0.0,json!({"status":"verified","space_ids":[1],"current_space_id":1}))]);
        json!({"structuredContent":{"schema_version":1,"producer_version":"harness-controlled-textedit-task-target-v1",
            "source_commit":"d114f35fec05ecd37bf529e5587be86852205b64","scope":"com.apple.TextEdit-controlled-document-task-target",
            "read_only":true,"global_topology_complete":false,"input_authorized":false,"run_ref_issued":false,
            "identity_lifecycle":"actor-retained-bounded-observation","max_rows":4096,"max_nodes":2048,"max_elapsed_ms":6000,"max_queries":32768,
            "request_nonce":nonce,"target":{"pid":7,"window_id":8},"status":"verified","reason_code":"verified","elapsed_ms":1,
            "public_enumeration_complete":true,"target_space_complete":true,"target_ax_closure_complete":true,"retained_identity_verified":true,
            "upper_intersections_absent":true,"stable":true,"cg_before":rows,"cg_after":rows,
            "ax":{"root_role":"AXWindow","root_subrole":"AXStandardWindow","query_count":7,"node_count":1,"unassociated_menu_present":false,"overlays":[]},
            "private":"secret-body"}})
    }
    #[test]fn task_target_host_preserves_unknown_space_rows_and_rebuilds_no_private_values(){
        let nonce=uuid::Uuid::new_v4().to_string();let result=task_fixture(&nonce);
        let (safe,verified)=task_evidence(&result,&nonce,(7,8));assert!(verified);assert_eq!(safe["public_row_count"],2);
        assert_eq!(safe["space_not_proven_count"],1);assert_eq!(safe["input_authorized"],false);assert_eq!(safe["run_ref_issued"],false);
        assert!(!safe.to_string().contains("secret"));assert!(safe.get("cg_before").is_none());
        let mut failed=result;failed["isError"]=json!(true);failed["structuredContent"]["status"]=json!("unknown");
        failed["structuredContent"]["reason_code"]=json!("task_upper_intersection");
        let (safe,verified)=task_evidence(&failed,&nonce,(7,8));assert!(!verified);assert_eq!(safe["reason_code"],"task_upper_intersection");
        failed["structuredContent"]["reason_code"]=json!("secret-title");
        assert!(!task_evidence(&failed,&nonce,(7,8)).0.to_string().contains("secret"));
    }
    #[test]fn task_target_host_rejects_duplicate_target_empty_overlap_changed_and_malformed_evidence(){
        let nonce=uuid::Uuid::new_v4().to_string();let result=task_fixture(&nonce);
        for mutate in 0..11 {let mut bad=result.clone();let value=&mut bad["structuredContent"];
            match mutate {
                0=>value["cg_before"][0]["window_id"]=json!(8),
                1=>value["cg_before"][1]["space"]=json!({"status":"not_proven","reason_code":"typed_empty"}),
                2=>{value["cg_before"][0]["bounds"]["x"]=json!(5.0);value["cg_after"]=value["cg_before"].clone();},
                3=>value["cg_after"][0]["bounds"]["x"]=json!(201.0),
                4=>value["cg_before"][0]["space"]["reason_code"]=json!("unavailable"),
                5=>value["cg_before"][0]["pid"]=json!(0),
                6=>value["cg_before"][0]["z_index"]=json!(0),
                7=>value["cg_before"][1]["space"]["current_space_id"]=json!(2),
                8=>value["ax"]["overlays"]=json!([{}]),
                9=>value["retained_identity_verified"]=json!(false),
                _=>value["ax"]["root_subrole"]=json!("AXDialog"),
            }
            assert!(!task_evidence(&bad,&nonce,(7,8)).1,"case {mutate}");
        }
        assert!(!task_evidence(&result,"wrong-nonce",(7,8)).1);
        assert!(!task_evidence(&result,&nonce,(7,9)).1);
    }
    #[test]fn task_target_host_contract_and_entry_are_separate_from_legacy_v2(){
        let nonce=uuid::Uuid::new_v4().to_string();let result=task_fixture(&nonce);let value=&result["structuredContent"];
        assert!(!contract_matches(value));
        let options=Options{root:PathBuf::from("/private/tmp/private"),pid:7,window_id:8,call:None};
        assert!(verified_result(&DaemonResponse::ok(result.clone()),&options,TARGET,Some(&nonce)).is_err());
        let mut old=result.clone();old["structuredContent"]["schema_version"]=json!(2);old["structuredContent"]["producer_version"]=json!("harness-topology-v2");
        assert!(!task_evidence(&old,&nonce,(7,8)).1);
        let args=vec!["textedit-task-target-bootstrap".into(),"--state-root".into(),"/private/tmp/private".into(),"--request-nonce".into(),nonce];
        assert!(bootstrap_options(&args).is_ok());assert!(requested(&["--no-overlay".into(),args[0].clone()]).is_err());
    }
    #[test]
    fn topology_failure_count_projection_rejects_inconsistent_or_private_evidence() {
        let base=json!({"status":"error","reason_code":"invalid_rows","raw_count":20,"retained_count":18,"skipped_count":2,"duplicate_count":0,
            "row_failure_counts":[{"field":"space_item","error_class":"nonpositive","count":2,"private":"secret-title"}],"private":"secret-body"});
        let expected=json!([{"field":"space_item","error_class":"nonpositive","count":2}]);
        assert_eq!(safe_row_failure_counts(&base),Some(expected));
        for (field,value) in [("raw_count",json!(4097)),("retained_count",json!(19)),("skipped_count",json!(0)),("duplicate_count",json!(1)),("status",json!("success")),("reason_code",json!("deadline"))] {
            let mut bad=base.clone();bad[field]=value;assert!(safe_row_failure_counts(&bad).is_none());
        }
        for (field,value) in [("field",json!("private-PID")),("error_class",json!("private-error")),("count",json!(1)),("count",json!(0)),("count",json!(-1)),("count",json!(2.0)),("count",json!(4097))] {
            let mut bad=base.clone();bad["row_failure_counts"][0][field]=value;assert!(safe_row_failure_counts(&bad).is_none());
        }
        let mut duplicate=base.clone();duplicate["duplicate_count"]=json!(1);duplicate["row_failure_counts"]=json!([
            {"field":"identity","error_class":"duplicate","count":1},{"field":"pid","error_class":"floating","count":1}]);
        assert!(safe_row_failure_counts(&duplicate).is_some());
        duplicate["row_failure_counts"][1]=duplicate["row_failure_counts"][0].clone();assert!(safe_row_failure_counts(&duplicate).is_none());
        let mut too_many=base.clone();too_many["row_failure_counts"]=json!(vec![json!({"field":"pid","error_class":"missing","count":1});65]);assert!(safe_row_failure_counts(&too_many).is_none());
    }
    #[test]
    fn topology_failure_before_after_projection_is_error_only_independent_and_private_safe() {
        let options=Options {root:std::path::PathBuf::from("/private/tmp/private-state"),pid:7,window_id:8,call:None};
        let nonce=uuid::Uuid::new_v4().to_string();
        let sample=|field,class|json!({"status":"error","reason_code":"invalid_rows","raw_count":20,"retained_count":18,"skipped_count":2,"duplicate_count":0,
            "row_failure_counts":[{"field":field,"error_class":class,"count":2,"private":"secret-title"}]});
        let mut value=json!({"schema_version":2,"producer_version":"harness-topology-v2","source_commit":"d114f35fec05ecd37bf529e5587be86852205b64",
            "scope":"target-ax-closure-cg-all-layers-v1","read_only":true,"global_topology_complete":false,"identity_lifecycle":"bounded-observation",
            "max_rows":4096,"max_nodes":2048,"max_queries":32768,"max_elapsed_ms":6000,"target":{"pid":7,"window_id":8},"request_nonce":nonce,
            "status":"unknown","reason_code":"cg_unknown","cg_before":sample("space_set","empty"),"cg_after":sample("managed_display","null_result")});
        let response=|value:Value|DaemonResponse::ok(json!({"isError":true,"structuredContent":value}));
        let evidence=safe_evidence(&response(value.clone()),&options,TARGET,Some(&nonce));
        assert_eq!(evidence["cg_before"]["row_failure_counts"][0]["field"],"space_set");
        assert_eq!(evidence["cg_after"]["row_failure_counts"][0]["field"],"managed_display");assert!(!evidence.to_string().contains("secret"));
        value["cg_after"]["row_failure_counts"][0]["count"]=json!(1);
        let evidence=safe_evidence(&response(value.clone()),&options,TARGET,Some(&nonce));
        assert!(evidence["cg_before"]["row_failure_counts"].is_array());assert!(evidence["cg_after"]["row_failure_counts"].is_null());
        value["status"]=json!("verified");assert!(safe_evidence(&response(value.clone()),&options,TARGET,Some(&nonce))["cg_before"]["row_failure_counts"].is_null());
        assert_eq!(safe_evidence(&response(value),&options,TARGET,Some("other"))["contract_verified"],false);
    }
    #[test]
    fn bootstrap_activation_diagnostic_only_rebuilds_closed_actual_failure() {
        let base=json!({"isError":true,"structuredContent":{"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
            "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"unknown","reason_code":"bootstrap_activation_unconfirmed",
            "activation_diagnostic":{"step":"ax_raise","error_class":"action_unsupported","private":"secret"},"private":"secret"}});
        assert_eq!(bootstrap_activation_diagnostic(&base,"activation"),Some(json!({"step":"ax_raise","error_class":"action_unsupported"})));
        for stage in ["discovery","topology","finalize"]{assert!(bootstrap_activation_diagnostic(&base,stage).is_none());}
        for (step,class) in [("persistent_front","unavailable"),("exact_key_front","target_unresolved"),("exact_key_press","write_rejected"),("exact_key_release","write_rejected"),("ax_main","not_implemented"),("confirmation","front_unknown"),("confirmation","front_mismatch"),("confirmation","order_unknown"),("confirmation","order_conflict"),("confirmation","stability_deadline")] {
            let mut current=base.clone();current["structuredContent"]["activation_diagnostic"]=json!({"step":step,"error_class":class});
            assert!(bootstrap_activation_diagnostic(&current,"activation").is_some());
        }
        for (step,class) in [("ax_focused","failure"),("confirmation","private-return"),("ax_raise","write_rejected"),("exact_key_release","unavailable")] {
            let mut current=base.clone();current["structuredContent"]["activation_diagnostic"]=json!({"step":step,"error_class":class});
            assert!(bootstrap_activation_diagnostic(&current,"activation").is_none());
        }
        for (field,value) in [("status",json!("activated")),("reason_code",json!("private-reason")),("schema_version",json!(2)),("producer_version",json!("private"))] {
            let mut current=base.clone();current["structuredContent"][field]=value;assert!(bootstrap_activation_diagnostic(&current,"activation").is_none());
        }
        let mut success=base.clone();success["isError"]=json!(false);assert!(bootstrap_activation_diagnostic(&success,"activation").is_none());
        let mut focus=base;focus["structuredContent"]["reason_code"]=json!("bootstrap_focused_object_mismatch");
        focus["structuredContent"]["activation_diagnostic"]=json!({"step":"focus_bridge","error_class":"verification_rejected"});
        assert!(bootstrap_activation_diagnostic(&focus,"activation").is_some());
    }
    #[test]fn bootstrap_focused_bridge_reasons_are_closed_and_never_leak_target_values(){
        let mut value=json!({"isError":true,"structuredContent":{"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
            "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"unknown","privateTitle":"secret","rawPid":123,"activation_started":true}});
        for reason in ["bootstrap_focused_object_mismatch","bootstrap_focused_pid_mismatch","bootstrap_focused_window_id_mismatch",
            "bootstrap_focused_app_pid_mismatch","bootstrap_focused_window_missing","bootstrap_focused_hidden_missing",
            "bootstrap_focused_title_mismatch","bootstrap_focused_geometry_changed","bootstrap_focused_application_changed","bootstrap_target_parent_missing","bootstrap_target_relationship_children_missing"]{
            value["structuredContent"]["reason_code"]=json!(reason);assert_eq!(bootstrap_reason(&value),reason);
            assert!(bootstrap_stage(&value,"nonce","activated").is_err());assert!(!bootstrap_reason(&value).contains("secret"));
        }
        value["structuredContent"]["reason_code"]=json!("bootstrap_focused_private-title-pid");assert_eq!(bootstrap_reason(&value),"bootstrap_stage_not_verified");
        value["structuredContent"]["reason_code"]=json!("bootstrap_focused_object_mismatch");value["structuredContent"]["status"]=json!("candidate");
        assert_eq!(bootstrap_reason(&value),"bootstrap_stage_not_verified");
    }
    #[test]fn bootstrap_comparison_projection_requires_exact_stage_and_strips_private_values(){
        let base=json!({"isError":true,"structuredContent":{"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
            "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"unknown","reason_code":"bootstrap_identity_changed"}});
        for (stage,phase) in [("discovery","first_pair"),("activation","preactivate"),("activation","postactivate"),("finalize","finalize")] {
            for component in ["app_semantics","application_terminated","numeric_identity","cg_geometry","ax_identity","unclassified"] {
                let mut value=base.clone();value["structuredContent"]["comparison_diagnostic"]=json!({"phase":phase,"component":component,"raw":"secret-pid-title-geometry"});
                let evidence=bootstrap_comparison_diagnostic(&value,stage).unwrap();assert_eq!(evidence.as_object().unwrap().len(),2);assert!(!evidence.to_string().contains("secret"));
                assert!(bootstrap_comparison_diagnostic(&value,"other").is_none());
                for wrong_stage in ["discovery","activation","finalize"]{if wrong_stage!=stage{assert!(bootstrap_comparison_diagnostic(&value,wrong_stage).is_none());}}
                for (key,bad) in [("phase",json!("private")),("component",json!("private")),("component",json!(7))] {
                    let mut bad_value=value.clone();bad_value["structuredContent"]["comparison_diagnostic"][key]=bad;assert!(bootstrap_comparison_diagnostic(&bad_value,stage).is_none());
                }
                for (key,bad) in [("status",json!("candidate")),("reason_code",json!("ax_query_error")),("schema_version",json!(2)),("producer_version",json!("private"))] {
                    let mut bad_value=value.clone();bad_value["structuredContent"][key]=bad;assert!(bootstrap_comparison_diagnostic(&bad_value,stage).is_none());
                }
                value["isError"]=json!(false);assert!(bootstrap_comparison_diagnostic(&value,stage).is_none());
            }
        }
    }
    #[test]fn bootstrap_cg_evidence_is_closed_error_only_and_matches_reason_and_purpose(){
        let base=json!({"isError":true,"structuredContent":{"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
            "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"unknown","reason_code":"identity_cg_invalid",
            "cg_diagnostic":{"phase":"excluded_dialog_cg","field":"owner","error_class":"missing","raw":"secret-title-pid"}}});
        let safe=bootstrap_cg_diagnostic(&base).unwrap();assert_eq!(safe.as_object().unwrap().len(),3);assert!(!safe.to_string().contains("secret"));
        for (field,class,reason) in [("description","empty","identity_cg_ambiguous"),("description","multiple","identity_cg_ambiguous"),
            ("description","unavailable","identity_cg_failed"),("description","wrong_type","identity_cg_type"),
            ("width","out_of_range","identity_cg_invalid"),("id","mismatch","identity_cg_identity_mismatch"),("onscreen","wrong_type","identity_cg_invalid")] {
            let mut value=base.clone();value["structuredContent"]["reason_code"]=json!(reason);
            value["structuredContent"]["cg_diagnostic"]=json!({"phase":"target_cg","field":field,"error_class":class});
            assert!(bootstrap_cg_diagnostic(&value).is_some());
        }
        for (key,value) in [("phase",json!("private-stage")),("field",json!("private-key")),("error_class",json!("private-value")),
            ("field",json!(7)),("error_class",json!("multiple")),("error_class",json!("not_ordered_missing"))] {
            let mut bad=base.clone();bad["structuredContent"]["cg_diagnostic"][key]=value;assert!(bootstrap_cg_diagnostic(&bad).is_none());
        }
        for (key,value) in [("status",json!("candidate")),("schema_version",json!(2)),("producer_version",json!("private")),("reason_code",json!("identity_cg_type"))] {
            let mut bad=base.clone();bad["structuredContent"][key]=value;assert!(bootstrap_cg_diagnostic(&bad).is_none());
        }
        let mut bad=base.clone();bad["isError"]=json!(false);assert!(bootstrap_cg_diagnostic(&bad).is_none());
        let mut target=base;target["structuredContent"]["reason_code"]=json!("identity_cg_not_visible");
        for class in ["not_ordered_missing","not_ordered_false"] {
            target["structuredContent"]["cg_diagnostic"]=json!({"phase":"target_cg","field":"onscreen","error_class":class});
            assert!(bootstrap_cg_diagnostic(&target).is_some());target["structuredContent"]["cg_diagnostic"]["phase"]=json!("excluded_dialog_cg");
            assert!(bootstrap_cg_diagnostic(&target).is_none());
        }
    }
    #[test]fn controlled_bootstrap_is_strict_early_entry_and_never_legacy_fallback(){
        let nonce=uuid::Uuid::new_v4().to_string();
        let args=vec!["textedit-task-bootstrap".into(),"--state-root".into(),"/private/tmp/private".into(),"--request-nonce".into(),nonce.clone()];
        assert_eq!(bootstrap_options(&args).unwrap().1,nonce);assert!(requested(&args).unwrap());
        assert!(bootstrap_options(&[]).is_err());assert!(bootstrap_options(&["serve".into()]).is_err());
        let mut wrong=args.clone();wrong.extend(["--pid".into(),"1".into()]);assert!(bootstrap_options(&wrong).is_err());
        assert!(requested(&["--no-overlay".into(),"textedit-task-bootstrap".into()]).is_err());
        assert!(requested(&["textedit-task-bootstrap".into(),"textedit-selected-identity-readonly".into()]).is_err());
    }
    #[test]fn controlled_stage_and_closed_failure_reason_never_echo_private_content(){
        let nonce=uuid::Uuid::new_v4().to_string();
        let mut response=json!({"structuredContent":{"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
            "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"activated","request_nonce":nonce,"pid":7,"window_id":8,
            "activation_started":true,"input_authorized":false,"privateText":"secret","title":"private"}});
        assert_eq!(bootstrap_stage(&response,&nonce,"activated").unwrap(),(7,8));
        for (key,value) in [("pid",json!(0)),("window_id",json!(u64::from(u32::MAX)+1)),("request_nonce",json!("private")),("activation_started",json!(false)),("input_authorized",json!(true))] {
            let mut bad=response.clone();bad["structuredContent"][key]=value;assert!(bootstrap_stage(&bad,&nonce,"activated").is_err());
        }
        response["isError"]=json!(true);response["structuredContent"]["status"]=json!("unknown");
        response["structuredContent"]["reason_code"]=json!("bootstrap_document_ambiguous");
        assert_eq!(bootstrap_stage(&response,&nonce,"activated").unwrap_err(),"bootstrap_document_ambiguous");
        response["structuredContent"]["reason_code"]=json!("private-title-body");
        assert_eq!(bootstrap_reason(&response),"bootstrap_stage_not_verified");
    }
    #[test]fn controlled_identity_layer_reasons_are_closed_and_private_safe(){
        let mut response=json!({"isError":true,"structuredContent":{"schema_version":1,
            "producer_version":"harness-controlled-textedit-bootstrap-v1","scope":"com.apple.TextEdit-controlled-document-bootstrap",
            "status":"unknown","reason_code":"bootstrap_identity_kind_unsupported","title":"private","path":"private"}});
        for reason in ["bootstrap_identity_kind_unsupported","bootstrap_identity_title_unknown","bootstrap_matched_target_not_ordinary",
            "bootstrap_non_target_relationship_unknown","bootstrap_non_target_dialog_not_excludable","bootstrap_non_target_identity_changed"] {
            response["structuredContent"]["reason_code"]=json!(reason);assert_eq!(bootstrap_reason(&response),reason);
        }
        response["structuredContent"]["reason_code"]=json!("private-role-title");assert_eq!(bootstrap_reason(&response),"bootstrap_stage_not_verified");
    }
    #[test]fn controlled_root_diagnostics_are_closed_and_strip_private_values(){
        let mut response=json!({"isError":true,"structuredContent":{"schema_version":1,
            "producer_version":"harness-controlled-textedit-bootstrap-v1","scope":"com.apple.TextEdit-controlled-document-bootstrap",
            "status":"unknown","title":"private","pid":123,"path":"private","reason_code":"private"}});
        for reason in ["bootstrap_identity_pid_mismatch","bootstrap_identity_role_missing","bootstrap_identity_subrole_missing",
            "bootstrap_identity_title_missing","bootstrap_identity_parent_missing","bootstrap_identity_window_id_zero",
            "bootstrap_target_pid_mismatch","bootstrap_target_role_missing","bootstrap_target_subrole_missing",
            "bootstrap_target_title_missing","bootstrap_target_minimized_missing","bootstrap_target_modal_missing",
            "bootstrap_target_parent_missing","bootstrap_target_children_missing","bootstrap_target_sheets_missing"] {
            response["structuredContent"]["reason_code"]=json!(reason);assert_eq!(bootstrap_reason(&response),reason);
            assert!(!bootstrap_reason(&response).contains("private"));
        }
        response["structuredContent"]["reason_code"]=json!("AXTitle private-secret");assert_eq!(bootstrap_reason(&response),"bootstrap_stage_not_verified");
    }
    #[test]fn controlled_relationship_mode_diagnostics_never_echo_private_fields(){
        let mut response=json!({"isError":true,"structuredContent":{"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
            "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"unknown","reason_code":"private","title":"private","pid":123}});
        for reason in ["bootstrap_target_relationship_children_missing","bootstrap_excluded_dialog_children_missing"] {
            response["structuredContent"]["reason_code"]=json!(reason);assert_eq!(bootstrap_reason(&response),reason);
        }
        response["structuredContent"]["reason_code"]=json!("private-AXChildren");assert_eq!(bootstrap_reason(&response),"bootstrap_stage_not_verified");
    }
    #[test]fn controlled_ax_diagnostic_rebuilds_only_valid_unknown_fixed_combinations(){
        let response=json!({"isError":true,"structuredContent":{"schema_version":1,"producer_version":"harness-controlled-textedit-bootstrap-v1",
            "scope":"com.apple.TextEdit-controlled-document-bootstrap","status":"unknown","pid":123,"title":"private",
            "ax_diagnostic":{"phase":"identity","operation":"attribute_value","attribute":"parent","error_class":"cannot_complete","private":"secret"}}});
        assert_eq!(bootstrap_ax_diagnostic(&response),Some(json!({"phase":"identity","operation":"attribute_value","attribute":"parent","error_class":"cannot_complete"})));
        for (key,value) in [("phase",json!("private")),("operation",json!("private")),("attribute",json!("AXTitle private")),("error_class",json!(-25204)),("error_class",json!("private"))] {
            let mut bad=response.clone();bad["structuredContent"]["ax_diagnostic"][key]=value;assert!(bootstrap_ax_diagnostic(&bad).is_none());
        }
        for (key,value) in [("isError",json!(false)),("status",json!("candidate")),("producer_version",json!("private"))] {
            let mut bad=response.clone();if key=="isError"{bad[key]=value;}else{bad["structuredContent"][key]=value;}assert!(bootstrap_ax_diagnostic(&bad).is_none());
        }
        for (op,attribute,class) in [("pid","parent","failure"),("window_id","other","null_result"),("messaging_timeout","other","wrong_type"),("attribute_names","other","invalid_value")] {
            let mut bad=response.clone();bad["structuredContent"]["ax_diagnostic"]=json!({"phase":"identity","operation":op,"attribute":attribute,"error_class":class});assert!(bootstrap_ax_diagnostic(&bad).is_none());
        }
    }
    #[test]fn controlled_post_topology_rejects_overlay_malformed_numeric_and_unknown(){
        let o=options(&args()).unwrap();let nonce=uuid::Uuid::new_v4().to_string();
        let row=json!({"pid":o.pid,"window_id":o.window_id,"layer":0,"z_index":1,
            "bounds":{"x":1,"y":2,"width":100,"height":100},"space_ids":[1],"current_space_id":1});
        let sample=json!({"status":"success","raw_count":1,"retained_count":1,"skipped_count":0,"duplicate_count":0,"rows":[row]});
        let value=json!({"schema_version":2,"producer_version":"harness-topology-v2","source_commit":"d114f35fec05ecd37bf529e5587be86852205b64",
            "scope":"target-ax-closure-cg-all-layers-v1","read_only":true,"global_topology_complete":false,"identity_lifecycle":"bounded-observation",
            "max_rows":4096,"max_nodes":2048,"max_queries":32768,"max_elapsed_ms":6000,"target":{"pid":o.pid,"window_id":o.window_id},
            "request_nonce":nonce,"status":"verified","reason_code":"verified","stable":true,"cg_enumeration_complete":true,"target_closure_complete":true,
            "elapsed_ms":1,"sequence":1,"session_epoch":uuid::Uuid::new_v4().to_string(),"cg_before":sample,"cg_after":sample,
            "ax":{"status":"success","target_resolved":true,"closure_complete":true,"truncated":false,"skipped_count":0,"unassociated_menu_present":false,
                "root_role":"AXWindow","root_subrole":"AXStandardWindow","root_query_status":"success","root_classification":"ordinary",
                "target_identity_token":uuid::Uuid::new_v4().to_string(),"node_count":1,"query_count":1,"overlays":[]}});
        assert!(bootstrap_topology(&DaemonResponse::ok(json!({"structuredContent":value})),&o,&nonce).is_ok());
        for (pointer,replacement) in [("/ax/overlays",json!([{}])),("/status",json!("unknown")),("/ax/root_subrole",json!("AXDialog")),
            ("/cg_after/rows/0/pid",json!(-1)),("/cg_after/rows/0/bounds/width",json!(0)),("/cg_after/rows/0/space_ids",json!([1,1]))] {
            let mut bad=value.clone();*bad.pointer_mut(pointer).unwrap()=replacement;
            if pointer.starts_with("/cg_after") {bad["cg_before"]=bad["cg_after"].clone();}
            assert!(bootstrap_topology(&DaemonResponse::ok(json!({"structuredContent":bad})),&o,&nonce).is_err());
        }
    }
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn args() -> Vec<String> { ["topology-readonly", "--state-root", "/private/tmp/private-state", "--pid", "1", "--window-id", "4294967295"].iter().map(|s| s.to_string()).collect() }
    #[test] fn textedit_discovery_is_explicit_single_use_not_a_server() {
        let nonce=uuid::Uuid::new_v4().to_string();
        let a=vec!["textedit-identity-readonly".into(),"--state-root".into(),"/private/tmp/private-state".into(),"--bundle-id".into(),"com.apple.TextEdit".into(),"--request-nonce".into(),nonce.clone()];
        assert_eq!(discovery_options(&a).unwrap().nonce,nonce); assert!(requested(&a).unwrap());
        for (index,value) in [(4,"com.apple.Terminal"),(5,"--pid"),(6,"bad")] { let mut bad=a.clone(); bad[index]=value.into(); assert!(discovery_options(&bad).is_err()); }
        let mut extra=a.clone(); extra.extend(["--window-id".into(),"7".into()]); assert!(discovery_options(&extra).is_err());
        assert!(requested(&["--no-overlay".into(),"textedit-identity-readonly".into()]).is_err());
        assert!(requested(&["textedit-identity-readonly".into(),"topology-readonly".into()]).is_err());
    }
    #[test] fn discovery_does_not_expand_the_original_two_rpc_registry() {
        let mut old=ToolRegistry::new(); platform_macos::tools::register_target_topology_readonly(&mut old);
        let names=old.tools_list()["tools"].as_array().unwrap().iter().map(|t|t["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(names.len(),2); assert!(!names.iter().any(|name|name=="discover_textedit_window_identity"));
        let mut new=ToolRegistry::new(); platform_macos::tools::register_textedit_identity_readonly(&mut new);
        assert_eq!(new.tools_list()["tools"].as_array().unwrap().len(),1);
    }
    #[test] fn selected_mode_is_explicit_strict_and_cannot_fall_into_legacy_startup() {
        let nonce=uuid::Uuid::new_v4().to_string();
        let mut args=vec!["textedit-selected-identity-readonly".into(),"--state-root".into(),"/private/tmp/private-state".into(),
            "--bundle-id".into(),"com.apple.TextEdit".into(),"--request-nonce".into(),nonce];
        assert!(requested(&args).unwrap());assert!(discovery_options(&args).unwrap().selected);
        args[0]="textedit-identity-readonly".into();assert!(!discovery_options(&args).unwrap().selected);
        assert!(requested(&["--no-overlay".into(),"textedit-selected-identity-readonly".into()]).is_err());
        assert!(requested(&["textedit-selected-identity-readonly".into(),"textedit-identity-readonly".into()]).is_err());
        args[0]="textedit-selected-identity-readonly".into();args.extend(["--user-confirmed".into(),"true".into()]);assert!(discovery_options(&args).is_err());
    }
    #[test] fn selected_registry_is_only_the_independent_real_tool() {
        let mut selected=ToolRegistry::new();platform_macos::tools::register_textedit_selected_identity_readonly(&mut selected);
        let tools=selected.tools_list();let names=tools["tools"].as_array().unwrap();
        assert_eq!(names.len(),1);assert_eq!(names[0]["name"],"discover_user_selected_textedit_window_identity");
        assert_eq!(names[0]["inputSchema"]["properties"]["bundle_id"]["const"],"com.apple.TextEdit");
    }
    #[test] fn selected_contract_projection_does_not_accept_unique_or_private_payloads() {
        let nonce=uuid::Uuid::new_v4().to_string();
        let mut response=json!({"structuredContent":{"schema_version":1,"producer_version":"harness-textedit-selected-identity-v1",
            "source_commit":"d114f35fec05ecd37bf529e5587be86852205b64","scope":"com.apple.TextEdit-user-selected-foreground-window-identity",
            "read_only":true,"status":"verified","reason_code":"verified","bundle_id":"com.apple.TextEdit","pid":41,"window_id":7,
            "request_nonce":nonce,"sample_epoch":uuid::Uuid::new_v4().to_string(),"elapsed_ms":1,"candidate_only":true,
            "identity_lifecycle":"bounded-observation","privateText":"secret","title":"private"}});
        let (evidence,ok)=identity_evidence(&response,&nonce,true);assert!(ok);assert_eq!(evidence["pid"],41);
        assert!(!evidence.to_string().contains("secret"));assert!(evidence.get("title").is_none());assert!(evidence.get("run_ref").is_none());
        assert!(!discovery_evidence(&response,&nonce).1);
        let mut old=response.clone();old["structuredContent"]["producer_version"]=json!("harness-textedit-identity-v1");
        old["structuredContent"]["scope"]=json!("com.apple.TextEdit-ordinary-window-identity");assert!(!identity_evidence(&old,&nonce,true).1);
        for (key,value) in [("pid",json!(0)),("window_id",json!(u64::from(u32::MAX)+1)),("request_nonce",json!("private")),("status",json!("unknown"))] {
            let mut bad=response.clone();bad["structuredContent"][key]=value;assert!(!identity_evidence(&bad,&nonce,true).1);
        }
        response["isError"]=json!(true);response["structuredContent"]["status"]=json!("unknown");
        response["structuredContent"]["reason_code"]=json!("selected_identity_front_process_unverified");
        let (evidence,ok)=identity_evidence(&response,&nonce,true);assert!(!ok);assert_eq!(evidence["reason_code"],"selected_identity_front_process_unverified");
        assert!(evidence.get("pid").is_none());assert!(evidence.get("window_id").is_none());
    }
    #[test] fn selected_front_app_failure_classes_remain_unknown_without_private_identity() {
        let nonce=uuid::Uuid::new_v4().to_string();
        let mut response=json!({"isError":true,"structuredContent":{"schema_version":1,"producer_version":"harness-textedit-selected-identity-v1",
            "scope":"com.apple.TextEdit-user-selected-foreground-window-identity","read_only":true,"status":"unknown",
            "pid":41,"window_id":7,"actual_bundle":"secret","title":"private","sample_phase":"private"}});
        for reason in ["selected_identity_front_app_unknown","selected_identity_front_app_terminated","selected_identity_front_app_pid_invalid",
            "selected_identity_front_app_bundle_missing","selected_identity_front_app_bundle_mismatch"] {
            response["structuredContent"]["reason_code"]=json!(reason);
            let (evidence,verified)=identity_evidence(&response,&nonce,true);
            assert!(!verified);assert_eq!(evidence["status"],"unknown");assert_eq!(evidence["reason_code"],reason);
            for key in ["pid","window_id","actual_bundle","title","sample_phase"] {assert!(evidence.get(key).is_none());}
            assert!(!evidence.to_string().contains("secret"));assert!(!discovery_evidence(&response,&nonce).1);
        }
        response["structuredContent"]["reason_code"]=json!("selected_identity_front_app_private");
        assert!(identity_evidence(&response,&nonce,true).0.get("reason_code").is_none());
    }
    #[test] fn discovery_projection_is_numeric_only_and_unknown_is_not_success() {
        let nonce=uuid::Uuid::new_v4().to_string();
        let mut result=json!({"structuredContent":{"schema_version":1,"producer_version":"harness-textedit-identity-v1",
            "source_commit":"d114f35fec05ecd37bf529e5587be86852205b64","scope":"com.apple.TextEdit-ordinary-window-identity","read_only":true,
            "status":"verified","reason_code":"verified","request_nonce":nonce,"bundle_id":"com.apple.TextEdit","candidate_only":true,
            "identity_lifecycle":"bounded-observation","pid":41,"window_id":u32::MAX,"elapsed_ms":1,"sample_epoch":uuid::Uuid::new_v4().to_string(),"privateText":"secret"},"content":[{"text":"secret"}]});
        let (evidence,ok)=discovery_evidence(&result,&nonce); assert!(ok); assert_eq!(evidence["window_id"],u32::MAX); assert!(!evidence.to_string().contains("secret"));
        for (key,value) in [("pid",json!(0)),("window_id",json!(u64::from(u32::MAX)+1)),("sample_epoch",json!("private")),("status",json!("unknown")),("request_nonce",json!(uuid::Uuid::new_v4().to_string()))] {
            let mut bad=result.clone(); bad["structuredContent"][key]=value; assert!(!discovery_evidence(&bad,&nonce).1);
        }
        result["isError"]=json!(true); result["structuredContent"]["status"]=json!("unknown"); result["structuredContent"]["reason_code"]=json!("identity_attached_relationship_unknown");
        let (evidence,ok)=discovery_evidence(&result,&nonce); assert!(!ok); assert_eq!(evidence["reason_code"],"identity_attached_relationship_unknown"); assert!(evidence.get("pid").is_none());
        result["structuredContent"]["reason_code"]=json!("secret"); assert!(!discovery_evidence(&result,&nonce).0.to_string().contains("secret"));
    }
    #[test] fn instance_diagnostic_is_closed_unknown_without_candidate_identity() {
        let nonce=uuid::Uuid::new_v4().to_string();
        let mut response=json!({"isError":true,"structuredContent":{"schema_version":1,"producer_version":"harness-textedit-identity-v1",
            "scope":"com.apple.TextEdit-ordinary-window-identity","read_only":true,"status":"unknown","pid":41,"window_id":1,"privateText":"secret"}});
        for reason in ["identity_instance_first_not_found","identity_instance_first_multiple","identity_instance_second_not_found","identity_instance_second_multiple"] {
            response["structuredContent"]["reason_code"]=json!(reason);
            let (evidence,verified)=discovery_evidence(&response,&nonce);
            assert!(!verified); assert_eq!(evidence["status"],"unknown"); assert_eq!(evidence["reason_code"],reason);
            assert!(evidence.get("pid").is_none()); assert!(evidence.get("window_id").is_none()); assert!(!evidence.to_string().contains("secret"));
        }
        response["structuredContent"]["reason_code"]=json!("identity_instance_third_private");
        assert!(discovery_evidence(&response,&nonce).0.get("reason_code").is_none());
    }
    #[test] fn exact_public_arguments_only() {
        assert_eq!(options(&args()).unwrap().window_id, u32::MAX);
        for extra in ["--no-permissions-gate", "--dangerously-bypass-approvals", "--experimental-history", "--socket", "--grant"] {
            let mut a = args(); a.extend([extra.into(), "x".into()]); assert!(options(&a).is_err());
        }
        let mut a = args(); a.extend(["--pid".into(), "2".into()]); assert!(options(&a).is_err());
    }
    fn multiple_diagnostic()->Value {
        json!({"sample_phase":"first","count_class":"bounded_multiple","inspection_complete":true,
            "total_items":3,"positive_pid_items":2,"distinct_positive_pid_count":1,"duplicate_object_items":1,
            "terminated_items":2,"invalid_pid_items":1,"bundle_match_items":1,"bundle_mismatch_items":1,"bundle_missing_items":1,
            "privateText":"secret","pid_list":[41,42],"object_address":"private"})
    }
    #[test] fn multiple_projection_rebuilds_only_consistent_bounded_aggregates() {
        assert!(identity_instance_evidence("identity_instance_first_not_found",&json!({})).is_none());
        let good=multiple_diagnostic();
        let evidence=identity_instance_evidence("identity_instance_first_multiple",&good).unwrap();
        assert_eq!(evidence["total_items"],3); assert!(!evidence.to_string().contains("secret"));
        assert!(evidence.get("pid_list").is_none());assert!(evidence.get("object_address").is_none());
        for (key,value) in [("sample_phase",json!("second")),("inspection_complete",json!(false)),("total_items",json!(1)),
            ("total_items",json!(33)),("positive_pid_items",json!(3)),("invalid_pid_items",json!(-1)),
            ("positive_pid_items",json!(0)),("invalid_pid_items",json!(1.5)),("invalid_pid_items",json!(33)),
            ("bundle_match_items",json!(2)),("distinct_positive_pid_count",json!(3)),("distinct_positive_pid_count",json!(0)),
            ("duplicate_object_items",json!(3)),("terminated_items",json!(4)),("terminated_items",json!("private"))] {
            let mut bad=good.clone();bad[key]=value;
            assert!(identity_instance_evidence("identity_instance_first_multiple",&bad).is_none());
        }
        let mut missing=good.clone();missing.as_object_mut().unwrap().remove("invalid_pid_items");
        assert!(identity_instance_evidence("identity_instance_first_multiple",&missing).is_none());
        let over=json!({"sample_phase":"second","count_class":"over_limit","inspection_complete":false,"total_items":999,"privateText":"secret"});
        let evidence=identity_instance_evidence("identity_instance_second_multiple",&over).unwrap();
        assert_eq!(evidence.as_object().unwrap().len(),3);assert!(evidence.get("total_items").is_none());
    }
    #[test] fn aggregate_evidence_never_changes_unknown_into_verified_or_other_reason() {
        let nonce=uuid::Uuid::new_v4().to_string();
        let mut response=json!({"isError":true,"structuredContent":{"schema_version":1,"producer_version":"harness-textedit-identity-v1",
            "scope":"com.apple.TextEdit-ordinary-window-identity","read_only":true,"status":"unknown",
            "reason_code":"identity_instance_first_multiple","instance_diagnostic":multiple_diagnostic(),"pid":41,"window_id":7}});
        let (evidence,verified)=discovery_evidence(&response,&nonce);
        assert!(!verified);assert_eq!(evidence["instance_diagnostic"]["total_items"],3);assert!(evidence.get("pid").is_none());
        for (key,value) in [("status",json!("verified")),("reason_code",json!("identity_instance_first_not_found"))] {
            let mut bad=response.clone();bad["structuredContent"][key]=value;
            assert!(discovery_evidence(&bad,&nonce).0.get("instance_diagnostic").is_none());
        }
        response["isError"]=json!(false);assert!(discovery_evidence(&response,&nonce).0.get("instance_diagnostic").is_none());
    }
    #[test] fn workers_and_permissive_environment_are_rejected() {
        for key in ["CUA_DRIVER_SESSION_POLICY_APPROVED", "CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED", "CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS", "CUA_DRIVER_TELEMETRY_CLI_WORKER", "CUA_DRIVER_HOME", "CUA_DRIVER_RS_PERMISSIONS_GATE"] { assert!(!environment_allowed(key, "1")); }
        assert!(!environment_allowed("CUA_DRIVER_PERMISSION_MODE", "unrestricted"));
        assert!(!environment_allowed("CUA_DRIVER_RS_TELEMETRY_ENABLED", "true"));
        assert!(environment_allowed("CUA_DRIVER_PERMISSION_MODE", "standard"));
        assert!(environment_allowed("HOME", "/unchanged"));
    }
    #[test] fn methods_fields_and_target_are_closed_before_any_query() {
        let o = options(&args()).unwrap();
        assert!(checked_call(&o, TARGET, &json!({"pid":2,"window_id":u32::MAX,"request_nonce":uuid::Uuid::new_v4().to_string()})).is_err());
        assert!(checked_call(&o, TARGET, &json!({"pid":1,"window_id":u32::MAX,"request_nonce":"invalid"})).is_err());
        assert!(checked_call(&o, CAPABILITIES, &json!({"_session_id":"forged"})).is_err());
        for name in ["type_text", "get_window_state", "get_desktop_state", "list_windows", "browser_prepare"] { assert!(checked_call(&o, name, &json!({})).is_err()); }
        for method in ["shutdown", "status", "session_end", "trusted_session", "revoke_all"] { assert!(parse_request(&json!({"method":method})).is_err()); }
        assert!(parse_request(&json!({"method":"metadata","args":{}})).is_err());
        assert!(parse_request(&json!({"method":"call","name":CAPABILITIES,"args":{},"session_id":"foreign"})).is_err());
    }
    #[test] fn private_root_rejects_bad_paths_modes_and_symlinks() {
        let temporary = tempfile::tempdir_in("/private/tmp").unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(StateRoot::open(temporary.path()).is_ok());
        assert!(StateRoot::open(Path::new("relative")).is_err());
        assert!(StateRoot::open(Path::new("/")).is_err());
        let alias = temporary.path().join("alias"); std::os::unix::fs::symlink(temporary.path(), &alias).unwrap();
        assert!(StateRoot::open(&alias).is_err());
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(StateRoot::open(temporary.path()).is_err());
    }
    #[test] fn no_overwrite_or_replacement_cleanup() {
        let temporary = tempfile::tempdir_in("/private/tmp").unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = StateRoot::open(temporary.path()).unwrap();
        let original = root.create(PID).unwrap(); assert!(root.create(PID).is_err());
        fs::rename(temporary.path().join(PID), temporary.path().join("original")).unwrap();
        let replacement = root.create(PID).unwrap();
        drop(original); assert!(temporary.path().join(PID).exists());
        drop(replacement); assert!(temporary.path().join(PID).exists());
    }
    #[test] fn client_tool_and_nonce_do_not_accept_arbitrary_json() {
        let mut a = args(); a[0] = "topology-readonly-call".into();
        a.extend(["--tool".into(), TARGET.into(), "--request-nonce".into(), uuid::Uuid::new_v4().to_string()]);
        assert!(options(&a).is_ok());
        a[8] = "type_text".into(); assert!(options(&a).is_err());
    }
    #[test] fn misplaced_or_repeated_optin_never_falls_back_to_legacy() {
        assert!(requested(&["--no-overlay".into(), "topology-readonly".into()]).is_err());
        assert!(requested(&["topology-readonly".into(), "topology-readonly-call".into()]).is_err());
        assert!(!requested(&["serve".into()]).unwrap());
    }
    #[test] fn client_rejects_ordinary_or_different_target_daemon_before_call() {
        let temporary = tempfile::tempdir_in("/private/tmp").unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = StateRoot::open(temporary.path()).unwrap(); let o = options(&args()).unwrap();
        let correct = metadata(&root, &o);
        assert!(validate_metadata(&correct, &root, &o, std::process::id()).is_ok());
        let ordinary = serde_json::to_value(cua_driver_core::daemon::current_daemon_metadata()).unwrap();
        assert!(validate_metadata(&ordinary, &root, &o, std::process::id()).is_err());
        let mut other = correct; other["target"]["window_id"] = json!(1);
        assert!(validate_metadata(&other, &root, &o, std::process::id()).is_err());
    }
    #[tokio::test] async fn production_registry_dispatch_rejects_other_targets_and_tools_without_query() {
        let temporary = tempfile::tempdir_in("/private/tmp").unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = StateRoot::open(temporary.path()).unwrap(); let o = options(&args()).unwrap();
        let mut registry = ToolRegistry::new(); platform_macos::tools::register_target_topology_readonly(&mut registry);
        assert_eq!(registry.tools_list()["tools"].as_array().unwrap().len(), 2);
        for request in [json!({"method":"call","name":"type_text","args":{"text":"private"}}),
            json!({"method":"call","name":TARGET,"args":{"pid":2,"window_id":u32::MAX,"request_nonce":uuid::Uuid::new_v4().to_string()}}),
            json!({"method":"call","name":CAPABILITIES,"args":{"_session_id":"foreign"}})] {
            assert!(!dispatch(&registry, &root, &o, request).await.ok);
        }
        let response = dispatch(&registry, &root, &o, json!({"method":"call","name":CAPABILITIES,"args":{}})).await;
        assert!(response.ok); assert_eq!(response.result.unwrap()["structuredContent"]["schema_version"], 2);
    }
    #[tokio::test] async fn incomplete_and_oversize_frames_never_reach_dispatch() {
        let (mut writer, mut reader) = tokio::io::duplex(MAX_FRAME + 2);
        writer.write_all(&vec![b'x'; MAX_FRAME + 1]).await.unwrap();
        assert_eq!(read_frame(&mut reader).await.unwrap_err(), "readonly_frame_too_large");
        let (mut writer, mut reader) = tokio::io::duplex(32);
        writer.write_all(b"{\"method\":").await.unwrap(); drop(writer);
        assert_eq!(read_frame(&mut reader).await.unwrap_err(), "readonly_frame_invalid");
    }
    #[test] fn malformed_unknown_or_error_response_never_reports_success() {
        let o = options(&args()).unwrap();
        for response in [DaemonResponse::ok(Value::Null), DaemonResponse::ok(json!({})),
            DaemonResponse::ok(json!({"isError":true,"structuredContent":{"status":"verified"}})),
            DaemonResponse::ok(json!({"structuredContent":{"status":"unknown"}}))] {
            assert!(verified_result(&response, &o, TARGET, Some("nonce")).is_err());
        }
    }
    #[tokio::test] async fn safe_projection_strips_private_unknown_fields_and_keeps_native_unknown_failure() {
        let temporary = tempfile::tempdir_in("/private/tmp").unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = StateRoot::open(temporary.path()).unwrap(); let o = options(&args()).unwrap();
        let mut registry = ToolRegistry::new(); platform_macos::tools::register_target_topology_readonly(&mut registry);
        let mut response = dispatch(&registry,&root,&o,json!({"method":"call","name":CAPABILITIES,"args":{}})).await;
        assert!(verified_result(&response,&o,CAPABILITIES,None).is_ok());
        response.result.as_mut().unwrap()["structuredContent"]["privateText"] = json!("secret-page-body");
        assert!(!safe_evidence(&response,&o,CAPABILITIES,None).to_string().contains("secret-page-body"));
        let nonce = uuid::Uuid::new_v4().to_string();
        let value = &mut response.result.as_mut().unwrap()["structuredContent"];
        value["target"] = json!({"pid":o.pid,"window_id":o.window_id}); value["request_nonce"] = json!(nonce);
        value["status"] = json!("unknown"); value["reason_code"] = json!("ax_unknown");
        value["ax"] = json!({"status":"error","reason_code":"ax_root_dialog_unsupported","target_resolved":false,"closure_complete":false,"query_count":7,"privateText":"secret-page-body"});
        response.result.as_mut().unwrap()["isError"] = json!(true);
        assert!(verified_result(&response,&o,TARGET,Some(&nonce)).is_err());
        let safe = safe_evidence(&response,&o,TARGET,Some(&nonce));
        assert_eq!(safe["status"],"unknown"); assert_eq!(safe["ax"]["reason_code"],"ax_root_dialog_unsupported");
        assert!(!safe.to_string().contains("secret-page-body"));
        for reason in ["ax_unsupported","ax_query_error","ax_root_kind_unknown","ax_names_error","ax_timeout_unavailable","identity_cache_unavailable"] {
            response.result.as_mut().unwrap()["structuredContent"]["ax"]["reason_code"] = json!(reason);
            assert_eq!(safe_evidence(&response,&o,TARGET,Some(&nonce))["ax"]["reason_code"],reason);
        }
        response.result.as_mut().unwrap()["structuredContent"]["ax"]["reason_code"] = json!("private-reason-value");
        assert!(!safe_evidence(&response,&o,TARGET,Some(&nonce)).to_string().contains("private-reason-value"));
    }
    #[test] fn policy_ceiling_still_denies_omitted_or_explicitly_denied_tools() {
        let temporary = tempfile::tempdir_in("/private/tmp").unwrap();
        let path = temporary.path().join("policy.yaml");
        fs::write(&path, format!("allow:\n  tools: [{CAPABILITIES}, {TARGET}]\ndeny:\n  tools: [{TARGET}]\n")).unwrap();
        let policy = cua_driver_core::policy::PolicyEngine::load(&path).unwrap().unwrap();
        assert!(matches!(policy.evaluate(TARGET,&json!({})),cua_driver_core::policy::PolicyDecision::Deny(_)));
        assert!(matches!(policy.evaluate("type_text",&json!({})),cua_driver_core::policy::PolicyDecision::Deny(_)));
        assert!(matches!(policy.evaluate(CAPABILITIES,&json!({})),cua_driver_core::policy::PolicyDecision::Allow));
    }
}
