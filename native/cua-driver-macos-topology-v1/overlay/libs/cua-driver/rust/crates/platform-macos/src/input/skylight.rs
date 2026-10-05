//! SkyLight SPI bridge — Rust port of Swift's `SkyLightEventPost`.
//!
//! Two-layer story (matches Swift reference exactly):
//!
//! 1. **Post path** — `SLEventPostToPid` goes through `SLEventPostToPSN` →
//!    `CGSTickleActivityMonitor` → `SLSUpdateSystemActivityWithLocation` →
//!    `IOHIDPostEvent`. The public `CGEventPostToPid` skips the activity-monitor
//!    tickle so Chromium/Catalyst targets don't accept those events as live input.
//!
//! 2. **Authentication** (keyboard only) — on macOS 14+, WindowServer gates
//!    synthetic keyboard events on Chromium-like targets on an attached
//!    `SLSEventAuthenticationMessage`. We build one via the ObjC factory and
//!    attach it with `SLEventSetAuthenticationMessage` before posting.
//!
//! All symbols are resolved once at first use via `dlopen` + `dlsym`.
//! If anything fails to resolve the functions return `false` and callers
//! fall back to the public `CGEvent::post_to_pid`.

use libc::pid_t;
use std::ffi::{c_void, CStr};
use std::os::raw::{c_char, c_int, c_uint};
use std::sync::OnceLock;

// ── Function-pointer typedefs ──────────────────────────────────────────────

/// `void SLEventPostToPid(pid_t, CGEventRef)`
type PostToPidFn = unsafe extern "C" fn(pid_t, *mut c_void);

/// `void SLEventSetAuthenticationMessage(CGEventRef, id)`
type SetAuthMsgFn = unsafe extern "C" fn(*mut c_void, *mut c_void);

/// `void CGEventSetWindowLocation(CGEventRef, double x, double y)`
///
/// NOTE: CGPoint on 64-bit ARM/x86 is two f64 values packed consecutively.
/// We pass them as two separate f64 arguments which has identical ABI.
type SetWindowLocFn = unsafe extern "C" fn(*mut c_void, f64, f64);

/// `void SLEventSetIntegerValueField(CGEventRef, uint32_t field, int64_t value)`
type SetIntFieldFn = unsafe extern "C" fn(*mut c_void, u32, i64);

/// `uint32_t CGSMainConnectionID(void)`
type ConnectionIDFn = unsafe extern "C" fn() -> u32;

/// `uint64_t CGSGetActiveSpace(uint32_t cid)`
type GetActiveSpaceFn = unsafe extern "C" fn(u32) -> u64;

/// `CFArrayRef SLSCopySpacesForWindows(uint32_t cid, int selector, CFArrayRef windowIDs)`
type CopySpacesForWindowsFn = unsafe extern "C" fn(u32, i32, *const c_void) -> *mut c_void;

/// `CFStringRef SLSCopyManagedDisplayForWindow(uint32_t cid, uint32_t wid)`
type CopyManagedDisplayForWindowFn = unsafe extern "C" fn(u32, u32) -> *mut c_void;

/// `uint64_t SLSManagedDisplayGetCurrentSpace(uint32_t cid, CFStringRef display)`
type ManagedDisplayGetCurrentSpaceFn = unsafe extern "C" fn(u32, *const c_void) -> u64;

// ── NSMenu shortcut activation SPIs ──────────────────────────────────────────

/// `OSStatus SLPSSetFrontProcessWithOptions(const void *psn, uint32_t windowID, uint32_t options)`
type SetFrontProcessFn = unsafe extern "C" fn(*const c_void, u32, u32) -> i32;

/// `OSStatus SLSGetWindowOwner(uint32_t cid, uint32_t wid, uint32_t *out_cid)`
type GetWindowOwnerFn = unsafe extern "C" fn(u32, u32, *mut u32) -> i32;

/// `OSStatus SLSGetConnectionPSN(uint32_t cid, void *psn)`
type GetConnectionPSNFn = unsafe extern "C" fn(u32, *mut c_void) -> i32;

// ── Focus-without-raise SPIs ──────────────────────────────────────────────────

/// `OSStatus SLPSPostEventRecordTo(const void *psn, const uint8_t *bytes)`
/// Posts a 248-byte synthetic event record into the target process's Carbon
/// event queue. Build the buffer with bytes[0x04]=0xf8, bytes[0x08]=0x0d,
/// target window id at bytes 0x3c–0x3f (little-endian), focus/defocus marker
/// at bytes[0x8a] (0x01 = focus, 0x02 = defocus), all other bytes zero.
type PostEventRecordToFn = unsafe extern "C" fn(*const c_void, *const u8) -> i32;

/// `OSStatus _SLPSGetFrontProcess(void *psn)`
/// Writes the current frontmost process's 8-byte PSN into `psn`.
type GetFrontProcessFn = unsafe extern "C" fn(*mut c_void) -> i32;

/// `OSStatus GetProcessForPID(pid_t, void *psn)`
/// Deprecated but still resolves. Writes the target pid's 8-byte PSN.
type GetProcessForPIDFn = unsafe extern "C" fn(pid_t, *mut c_void) -> i32;

/// Factory: `+[SLSEventAuthenticationMessage messageWithEventRecord:pid:version:]`
/// ObjC send: `(id self, SEL _cmd, void* record, int32 pid, uint32 version) -> id`
type FactoryMsgSendFn = unsafe extern "C" fn(
    *mut c_void, // Class (receiver)
    *mut c_void, // SEL
    *mut c_void, // SLSEventRecord*
    c_int,       // pid
    c_uint,      // version
) -> *mut c_void;

// ── Symbol resolution ──────────────────────────────────────────────────────

/// Load SkyLight once so all dlsym lookups via RTLD_DEFAULT find it.
fn ensure_skylight_loaded() {
    static LOADED: OnceLock<()> = OnceLock::new();
    LOADED.get_or_init(|| {
        let path = b"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight\0";
        unsafe {
            libc::dlopen(
                path.as_ptr() as *const c_char,
                libc::RTLD_LAZY | libc::RTLD_GLOBAL,
            );
        }
    });
}

/// Look up a symbol by name via RTLD_DEFAULT (after loading SkyLight).
/// Returns `None` when the symbol doesn't resolve.
fn find_sym(name: &[u8]) -> Option<*mut c_void> {
    ensure_skylight_loaded();
    let ptr = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr() as *const c_char) };
    if ptr.is_null() {
        None
    } else {
        Some(ptr)
    }
}

/// Reinterpret a raw symbol pointer as a function pointer of type `T`.
/// Safety: caller guarantees T matches the symbol's actual signature.
unsafe fn as_fn<T: Copy>(ptr: *mut c_void) -> T {
    std::mem::transmute_copy::<*mut c_void, T>(&ptr)
}

// ── Lazily-resolved handles ────────────────────────────────────────────────

fn post_to_pid_fn() -> Option<PostToPidFn> {
    static SYM: OnceLock<Option<PostToPidFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLEventPostToPid\0").map(|p| unsafe { as_fn(p) }))
}

fn set_auth_msg_fn() -> Option<SetAuthMsgFn> {
    static SYM: OnceLock<Option<SetAuthMsgFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLEventSetAuthenticationMessage\0").map(|p| unsafe { as_fn(p) }))
}

fn set_window_loc_fn() -> Option<SetWindowLocFn> {
    static SYM: OnceLock<Option<SetWindowLocFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"CGEventSetWindowLocation\0").map(|p| unsafe { as_fn(p) }))
}

fn set_int_field_fn() -> Option<SetIntFieldFn> {
    static SYM: OnceLock<Option<SetIntFieldFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLEventSetIntegerValueField\0").map(|p| unsafe { as_fn(p) }))
}

fn connection_id_fn() -> Option<ConnectionIDFn> {
    static SYM: OnceLock<Option<ConnectionIDFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"CGSMainConnectionID\0").map(|p| unsafe { as_fn(p) }))
}

fn get_active_space_fn() -> Option<GetActiveSpaceFn> {
    static SYM: OnceLock<Option<GetActiveSpaceFn>> = OnceLock::new();
    *SYM.get_or_init(|| {
        find_sym(b"SLSGetActiveSpace\0")
            .or_else(|| find_sym(b"CGSGetActiveSpace\0"))
            .map(|p| unsafe { as_fn(p) })
    })
}

fn copy_spaces_for_windows_fn() -> Option<CopySpacesForWindowsFn> {
    static SYM: OnceLock<Option<CopySpacesForWindowsFn>> = OnceLock::new();
    *SYM.get_or_init(|| {
        find_sym(b"SLSCopySpacesForWindows\0")
            .or_else(|| find_sym(b"CGSCopySpacesForWindows\0"))
            .map(|p| unsafe { as_fn(p) })
    })
}

fn copy_managed_display_for_window_fn() -> Option<CopyManagedDisplayForWindowFn> {
    static SYM: OnceLock<Option<CopyManagedDisplayForWindowFn>> = OnceLock::new();
    *SYM.get_or_init(|| {
        find_sym(b"SLSCopyManagedDisplayForWindow\0")
            .or_else(|| find_sym(b"CGSCopyManagedDisplayForWindow\0"))
            .map(|p| unsafe { as_fn(p) })
    })
}

fn managed_display_get_current_space_fn() -> Option<ManagedDisplayGetCurrentSpaceFn> {
    static SYM: OnceLock<Option<ManagedDisplayGetCurrentSpaceFn>> = OnceLock::new();
    *SYM.get_or_init(|| {
        find_sym(b"SLSManagedDisplayGetCurrentSpace\0")
            .or_else(|| find_sym(b"CGSManagedDisplayGetCurrentSpace\0"))
            .map(|p| unsafe { as_fn(p) })
    })
}

fn factory_msg_send_fn() -> Option<FactoryMsgSendFn> {
    static SYM: OnceLock<Option<FactoryMsgSendFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"objc_msgSend\0").map(|p| unsafe { as_fn(p) }))
}

fn set_front_process_fn() -> Option<SetFrontProcessFn> {
    static SYM: OnceLock<Option<SetFrontProcessFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLPSSetFrontProcessWithOptions\0").map(|p| unsafe { as_fn(p) }))
}

fn get_window_owner_fn() -> Option<GetWindowOwnerFn> {
    static SYM: OnceLock<Option<GetWindowOwnerFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLSGetWindowOwner\0").map(|p| unsafe { as_fn(p) }))
}

fn get_connection_psn_fn() -> Option<GetConnectionPSNFn> {
    static SYM: OnceLock<Option<GetConnectionPSNFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLSGetConnectionPSN\0").map(|p| unsafe { as_fn(p) }))
}

fn post_event_record_to_fn() -> Option<PostEventRecordToFn> {
    static SYM: OnceLock<Option<PostEventRecordToFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLPSPostEventRecordTo\0").map(|p| unsafe { as_fn(p) }))
}

fn get_front_process_fn() -> Option<GetFrontProcessFn> {
    static SYM: OnceLock<Option<GetFrontProcessFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"_SLPSGetFrontProcess\0").map(|p| unsafe { as_fn(p) }))
}

fn get_process_for_pid_fn() -> Option<GetProcessForPIDFn> {
    static SYM: OnceLock<Option<GetProcessForPIDFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"GetProcessForPID\0").map(|p| unsafe { as_fn(p) }))
}

/// `true` when `SLEventPostToPid` resolved.
pub fn is_available() -> bool {
    post_to_pid_fn().is_some()
}

/// `true` when the focus-without-raise SPIs resolved, including either the
/// modern window-owner PSN lookup or the deprecated pid fallback.
pub fn is_focus_without_raise_available() -> bool {
    let has_psn_lookup = (connection_id_fn().is_some()
        && get_window_owner_fn().is_some()
        && get_connection_psn_fn().is_some())
        || get_process_for_pid_fn().is_some();
    get_front_process_fn().is_some() && has_psn_lookup && post_event_record_to_fn().is_some()
}

// ── ObjC runtime helpers ───────────────────────────────────────────────────

/// Look up an ObjC class by C-string name via `objc_getClass`.
fn objc_class(name: &CStr) -> *mut c_void {
    type GetClassFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
    static SYM: OnceLock<Option<GetClassFn>> = OnceLock::new();
    let f = *SYM.get_or_init(|| find_sym(b"objc_getClass\0").map(|p| unsafe { as_fn(p) }));
    match f {
        Some(f) => unsafe { f(name.as_ptr()) },
        None => std::ptr::null_mut(),
    }
}

/// Register / look up an ObjC selector by C-string name via `sel_registerName`.
fn sel_register(name: &CStr) -> *mut c_void {
    type SelRegFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
    static SYM: OnceLock<Option<SelRegFn>> = OnceLock::new();
    let f = *SYM.get_or_init(|| find_sym(b"sel_registerName\0").map(|p| unsafe { as_fn(p) }));
    match f {
        Some(f) => unsafe { f(name.as_ptr()) },
        None => std::ptr::null_mut(),
    }
}

/// Whether `cls` actually implements `sel`, via `class_respondsToSelector`.
///
/// macOS 14 (Sonoma) compatibility guard: `SLSEventAuthenticationMessage`
/// exists on macOS 14, but `messageWithEventRecord:pid:version:` was only
/// added in macOS 15 (Sequoia). `sel_registerName` always succeeds (it just
/// interns the string), so a `!sel.is_null()` check is not enough — we must
/// confirm the class responds before calling `objc_msgSend`, or the runtime
/// raises `NSInvalidArgumentException: unrecognized selector`. See #1503.
fn class_responds_to_selector(cls: *mut c_void, sel: *mut c_void) -> bool {
    if cls.is_null() || sel.is_null() {
        return false;
    }
    type RespondsToFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool;
    static SYM: OnceLock<Option<RespondsToFn>> = OnceLock::new();
    let f =
        *SYM.get_or_init(|| find_sym(b"class_respondsToSelector\0").map(|p| unsafe { as_fn(p) }));
    match f {
        Some(f) => unsafe { f(cls, sel) },
        None => false,
    }
}

// ── SLSEventRecord extraction ──────────────────────────────────────────────

/// Extract the embedded `SLSEventRecord *` from a `CGEvent`.
///
/// Layout of `__CGEvent` (SkyLight ObjC type encodings):
///   `{CFRuntimeBase, uint32_t, SLSEventRecord *}`
/// On 64-bit: CFRuntimeBase=16, uint32=4, 4 bytes pad → record pointer at offset 24.
/// We probe offsets 24, 32, 16 for resilience across OS versions (same as Swift).
unsafe fn extract_event_record(event_ptr: *mut c_void) -> *mut c_void {
    for &offset in &[24usize, 32, 16] {
        let slot = (event_ptr as *const u8).add(offset).cast::<*mut c_void>();
        let p = std::ptr::read_unaligned(slot);
        if !p.is_null() {
            return p;
        }
    }
    std::ptr::null_mut()
}

// ── Public entry points ────────────────────────────────────────────────────

/// Post `event_ptr` (raw `CGEventRef`) to `pid` via `SLEventPostToPid`.
///
/// `attach_auth_message`: pass `true` for keyboard events (Chromium path),
/// `false` for mouse events (see Swift doc comment on `postToPid`).
///
/// Returns `true` when `SLEventPostToPid` resolved and the post was attempted.
/// Returns `false` when the SPI is absent — caller falls back to `CGEvent::post_to_pid`.
pub(super) fn post_to_pid(pid: pid_t, event_ptr: *mut c_void, attach_auth_message: bool) -> bool {
    let post_fn = match post_to_pid_fn() {
        Some(f) => f,
        None => return false,
    };

    if attach_auth_message {
        // Build and attach SLSEventAuthenticationMessage.
        //
        // macOS 14 (Sonoma) compatibility: the class exists on macOS 14 but
        // `messageWithEventRecord:pid:version:` was added in macOS 15. Guard
        // with `class_respondsToSelector` (a `!sel.is_null()` check is not
        // enough — `sel_registerName` interns any name); when the selector is
        // absent we skip the auth envelope and fall through to the plain
        // `SLEventPostToPid` below. Chromium-class targets may not receive the
        // event on macOS 14, but the daemon no longer crashes. See #1503.
        let cls = objc_class(c"SLSEventAuthenticationMessage");
        let sel = sel_register(c"messageWithEventRecord:pid:version:");
        let factory = factory_msg_send_fn();

        if class_responds_to_selector(cls, sel) {
            if let Some(factory_fn) = factory {
                let record = unsafe { extract_event_record(event_ptr) };
                if !record.is_null() {
                    let msg = unsafe { factory_fn(cls, sel, record, pid as c_int, 0u32) };
                    if !msg.is_null() {
                        if let Some(set_auth) = set_auth_msg_fn() {
                            unsafe { set_auth(event_ptr, msg) };
                        }
                    }
                }
            }
        }
    }

    unsafe { post_fn(pid, event_ptr) };
    true
}

/// Stamp a window-local `(x, y)` point onto `event_ptr` via the private
/// `CGEventSetWindowLocation` SPI. Returns `true` when the SPI resolved.
pub(super) fn set_window_location(event_ptr: *mut c_void, x: f64, y: f64) -> bool {
    match set_window_loc_fn() {
        Some(f) => {
            unsafe { f(event_ptr, x, y) };
            true
        }
        None => false,
    }
}

/// Stamp `value` onto `event_ptr` at raw SkyLight field index `field` via
/// `SLEventSetIntegerValueField`. Returns `false` when SPI absent.
pub(super) fn set_integer_field(event_ptr: *mut c_void, field: u32, value: i64) -> bool {
    match set_int_field_fn() {
        Some(f) => {
            unsafe { f(event_ptr, field, value) };
            true
        }
        None => false,
    }
}

/// Return the Skylight main connection ID for the current process.
pub fn main_connection_id() -> Option<u32> {
    connection_id_fn().map(|f| unsafe { f() })
}

/// Return the current active macOS Space (desktop) ID.
///
/// Uses the private `CGSGetActiveSpace` SPI from SkyLight.  Returns `None`
/// when the symbol is unavailable (future macOS version that removes it).
pub fn get_active_space() -> Option<u64> {
    let cid = main_connection_id()?;
    nonzero_space_id(get_active_space_fn().map(|f| unsafe { f(cid) }))
}

fn nonzero_space_id(space_id: Option<u64>) -> Option<u64> {
    space_id.filter(|id| *id != 0)
}

// Shared by the actual Space and topology decoders. Integer-valued floats are
// still floats; CFNumberGetValue failure is never a usable truncated value.
pub(crate) fn strict_integer_value(is_number: bool, is_float: impl FnOnce() -> bool, convert: impl FnOnce() -> Option<i64>) -> Option<i64> {
    strict_integer_result(is_number,is_float,convert).ok()
}
pub(crate) fn strict_integer_result(is_number:bool,is_float:impl FnOnce()->bool,convert:impl FnOnce()->Option<i64>)->Result<i64,&'static str> {
    if !is_number{return Err("wrong_type");}if is_float(){return Err("floating");}convert().ok_or("conversion")
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub(crate) struct EvidenceFailure {pub(crate) field:&'static str,pub(crate) class:&'static str}
pub(crate) fn evidence_failure(field:&'static str,class:&'static str)->EvidenceFailure {EvidenceFailure {field,class}}

fn owned_cf_type(is_null: bool, actual: impl FnOnce() -> usize, expected: usize, release: impl FnOnce()) -> bool {
    owned_cf_result(is_null,actual,expected,release).is_ok()
}
fn owned_cf_result(is_null:bool,actual:impl FnOnce()->usize,expected:usize,release:impl FnOnce())->Result<(),&'static str> {
    if is_null{return Err("null_result");}if actual()!=expected{release();return Err("wrong_type");}Ok(())
}

fn managed_display_space(char_len: isize, read: impl FnOnce()->u64) -> Option<u64> {
    managed_display_space_result(char_len,read).ok()
}
fn managed_display_space_result(char_len:isize,read:impl FnOnce()->u64)->Result<u64,EvidenceFailure> {
    if char_len<=0{return Err(evidence_failure("managed_display","empty"));}
    nonzero_space_id(Some(read())).ok_or(evidence_failure("current_space","nonpositive"))
}

fn complete_space_ids(count: isize, mut read: impl FnMut(usize) -> Option<i64>) -> Option<Vec<u64>> {
    complete_space_ids_result(count,|index|read(index).ok_or(evidence_failure("space_item","unavailable"))).ok()
}
fn complete_space_ids_result(count:isize,mut read:impl FnMut(usize)->Result<i64,EvidenceFailure>)->Result<Vec<u64>,EvidenceFailure> {
    if count<=0{return Err(evidence_failure("space_set","empty"));}if count>32{return Err(evidence_failure("space_set","limit"));}
    let mut ids = Vec::with_capacity(count as usize);
    for index in 0..count as usize {
        let id = u64::try_from(read(index)?).ok().filter(|id|*id>0).ok_or(evidence_failure("space_item","nonpositive"))?;
        if ids.contains(&id){return Err(evidence_failure("space_item","duplicate"));}
        ids.push(id);
    }
    Ok(ids)
}
fn task_space_count(count:isize)->Result<(),EvidenceFailure>{
    if count<0{Err(evidence_failure("space_set","invalid_count"))}else{Ok(())}
}

/// A consistent WindowServer connection and active-Space snapshot for one
/// enumeration. Space membership must be queried one window at a time:
/// `SLSCopySpacesForWindows` returns the set union for its input window list,
/// not a positionally aligned result.
pub(crate) struct SpaceQuery {
    connection_id: u32,
    current_space_id: Option<u64>,
    copy_spaces_for_windows: Option<CopySpacesForWindowsFn>,
    copy_managed_display_for_window: Option<CopyManagedDisplayForWindowFn>,
    managed_display_get_current_space: Option<ManagedDisplayGetCurrentSpaceFn>,
}

impl SpaceQuery {
    pub(crate) fn new() -> Option<Self> {
        let connection_id = main_connection_id()?;
        let current_space_id =
            nonzero_space_id(get_active_space_fn().map(|f| unsafe { f(connection_id) }));
        Some(Self {
            connection_id,
            current_space_id,
            copy_spaces_for_windows: copy_spaces_for_windows_fn(),
            copy_managed_display_for_window: copy_managed_display_for_window_fn(),
            managed_display_get_current_space: managed_display_get_current_space_fn(),
        })
    }

    pub(crate) fn current_space_id(&self) -> Option<u64> {
        self.current_space_id
    }

    /// Return every Space containing `window_id`.
    pub(crate) fn window_space_ids(&self, window_id: u32) -> Option<Vec<u64>> {
        self.window_space_ids_result(window_id).ok()
    }
    pub(crate) fn window_space_ids_result(&self,window_id:u32)->Result<Vec<u64>,EvidenceFailure> {
        self.window_space_ids_mode(window_id,false)
    }
    pub(crate) fn task_window_space_ids_result(&self,window_id:u32)->Result<Vec<u64>,EvidenceFailure> {
        self.window_space_ids_mode(window_id,true)
    }
    fn window_space_ids_mode(&self,window_id:u32,exact_empty:bool)->Result<Vec<u64>,EvidenceFailure> {
        use core_foundation::{
            array::CFArray,
            base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType},
            number::{CFNumber, CFNumberIsFloatType},
        };

        let copy_spaces = self.copy_spaces_for_windows.ok_or(evidence_failure("space_set","unavailable"))?;
        let window_number = CFNumber::from(window_id as i64);
        let window_ref = window_number.as_concrete_TypeRef() as *const c_void;
        let windows = CFArray::<CFTypeRef>::from_copyable(&[window_ref]);
        let result_ptr = unsafe {
            copy_spaces(
                self.connection_id,
                0x7,
                windows.as_concrete_TypeRef() as *const c_void,
            )
        };
        owned_cf_result(result_ptr.is_null(), || unsafe { CFGetTypeID(result_ptr as CFTypeRef) as usize }, CFArray::<CFTypeRef>::type_id() as usize, || unsafe { CFRelease(result_ptr as CFTypeRef) })
            .map_err(|class|evidence_failure("space_set",class))?;

        let result: CFArray<CFTypeRef> =
            unsafe { CFArray::wrap_under_create_rule(result_ptr as _) };
        let count=result.len() as isize;
        if exact_empty{task_space_count(count)?;}
        complete_space_ids_result(count, |index| {
            let item = *result.get(index as _).ok_or(evidence_failure("space_item","unavailable"))?;
            strict_integer_result(!item.is_null() && unsafe { CFGetTypeID(item) } == CFNumber::type_id(),
                || unsafe { CFNumberIsFloatType(item as _) != 0 },
                || unsafe { CFNumber::wrap_under_get_rule(item as _).to_i64() }).map_err(|class|evidence_failure("space_item",class))
        })
    }

    /// Return the active Space on the display WindowServer associates with
    /// `window_id`. This avoids comparing every window against the main
    /// display's active Space when displays use independent Spaces.
    pub(crate) fn current_space_for_window(&self, window_id: u32) -> Option<u64> {
        self.current_space_for_window_result(window_id).ok()
    }
    pub(crate) fn current_space_for_window_result(&self,window_id:u32)->Result<u64,EvidenceFailure> {
        use core_foundation::{base::{CFGetTypeID, CFRelease, CFTypeRef, TCFType}, string::CFString};

        let copy_display = self.copy_managed_display_for_window.ok_or(evidence_failure("managed_display","unavailable"))?;
        let get_current_space = self.managed_display_get_current_space.ok_or(evidence_failure("current_space","unavailable"))?;
        let display_ptr = unsafe { copy_display(self.connection_id, window_id) };
        owned_cf_result(display_ptr.is_null(), || unsafe { CFGetTypeID(display_ptr as CFTypeRef) as usize }, CFString::type_id() as usize, || unsafe { CFRelease(display_ptr as CFTypeRef) })
            .map_err(|class|evidence_failure("managed_display",class))?;
        let display = unsafe { CFString::wrap_under_create_rule(display_ptr as _) };
        managed_display_space_result(display.char_len() as isize, || unsafe {
            get_current_space(
                self.connection_id,
                display.as_concrete_TypeRef() as *const c_void,
            )
        })
    }
}

// ── Focus-without-raise ───────────────────────────────────────────────────────

/// Activate `target_pid`'s window `target_wid` without raising any windows
/// or triggering Space-follow. Ported from yabai's
/// `window_manager_focus_window_without_raise`.
///
/// Recipe:
/// 1. `_SLPSGetFrontProcess` → capture current front PSN.
/// 2. `SLSGetWindowOwner + SLSGetConnectionPSN` → target PSN, with
///    `GetProcessForPID(target_pid)` as an older-system fallback.
/// 3. Post 248-byte defocus record to front PSN (`bytes[0x8a] = 0x02`).
/// 4. Post 248-byte focus record to target PSN (`bytes[0x8a] = 0x01`,
///    `bytes[0x3c..0x3f]` = `target_wid` little-endian).
///
/// Deliberately skips `SLPSSetFrontProcessWithOptions` — see the Swift
/// reference `FocusWithoutRaise.swift` for why omitting it keeps
/// Chromium's user-activation gate open.
///
/// Returns `true` when all SPIs resolved and both posts succeeded.
pub fn activate_without_raise(target_pid: pid_t, target_wid: u32) -> bool {
    let post_fn = match post_event_record_to_fn() {
        Some(f) => f,
        None => return false,
    };
    let get_front = match get_front_process_fn() {
        Some(f) => f,
        None => return false,
    };
    // 8-byte PSN buffers (two UInt32s).
    let mut prev_psn = [0u8; 8];
    let mut target_psn = [0u8; 8];

    let ok_prev = unsafe { get_front(prev_psn.as_mut_ptr() as *mut c_void) } == 0;
    if !ok_prev {
        return false;
    }

    if !get_process_psn_for_window(target_wid, target_pid, &mut target_psn) {
        return false;
    }

    // Build the 248-byte event buffer.
    let mut buf = [0u8; 0xF8];
    buf[0x04] = 0xF8;
    buf[0x08] = 0x0D;
    // Stamp target window id in little-endian at bytes 0x3c–0x3f.
    buf[0x3C] = (target_wid & 0xFF) as u8;
    buf[0x3D] = ((target_wid >> 8) & 0xFF) as u8;
    buf[0x3E] = ((target_wid >> 16) & 0xFF) as u8;
    buf[0x3F] = ((target_wid >> 24) & 0xFF) as u8;

    // Step 3: defocus previous front.
    buf[0x8A] = 0x02;
    let defocus_ok = unsafe { post_fn(prev_psn.as_ptr() as *const c_void, buf.as_ptr()) == 0 };

    // Step 4: focus target.
    buf[0x8A] = 0x01;
    let focus_ok = unsafe { post_fn(target_psn.as_ptr() as *const c_void, buf.as_ptr()) == 0 };

    defocus_ok && focus_ok
}

// ── NSMenu shortcut activation ────────────────────────────────────────────────

/// Gets the PSN for the process that owns `window_id`.
/// Uses `CGSMainConnectionID` + `SLSGetWindowOwner` + `SLSGetConnectionPSN`.
/// Falls back to `GetProcessForPID(pid)` when the SkyLight path fails.
pub fn get_process_psn_for_window(window_id: u32, pid: libc::pid_t, out_psn: &mut [u8; 8]) -> bool {
    // Try modern path: CGSMainConnectionID → SLSGetWindowOwner → SLSGetConnectionPSN
    if let (Some(get_owner), Some(get_psn), Some(conn_id_fn)) = (
        get_window_owner_fn(),
        get_connection_psn_fn(),
        connection_id_fn(),
    ) {
        let main_cid = unsafe { conn_id_fn() };
        let mut owner_cid: u32 = 0;
        let ok = unsafe { get_owner(main_cid, window_id, &mut owner_cid) } == 0;
        if ok && owner_cid != 0 {
            let psn_ok = unsafe { get_psn(owner_cid, out_psn.as_mut_ptr() as *mut c_void) } == 0;
            if psn_ok {
                return true;
            }
        }
    }
    // Fallback: GetProcessForPID
    if let Some(get_pid_psn) = get_process_for_pid_fn() {
        return unsafe { get_pid_psn(pid, out_psn.as_mut_ptr() as *mut c_void) } == 0;
    }
    false
}

/// Return whether WindowServer currently considers the exact window's process
/// frontmost. Unlike `NSWorkspace.frontmostApplication`, this query does not
/// depend on the caller's AppKit run loop processing an activation update.
pub fn front_process_matches(target_pid: libc::pid_t, target_wid: u32) -> Option<bool> {
    let get_front = get_front_process_fn()?;
    let mut front_psn = [0u8; 8];
    if unsafe { get_front(front_psn.as_mut_ptr() as *mut c_void) } != 0 {
        return None;
    }
    let mut target_psn = [0u8; 8];
    if !get_process_psn_for_window(target_wid, target_pid, &mut target_psn) {
        return None;
    }
    Some(front_psn == target_psn)
}

/// Make `target_pid` and `target_wid` WindowServer-frontmost and leave them
/// there. Unlike [`with_foreground_assist`], this deliberately does not save or
/// restore the previous process. It is the persistent counterpart required by
/// focus-proxy surfaces whose input channel is armed only while genuinely
/// frontmost.
///
/// Returns `true` only when the target PSN resolved and WindowServer accepted
/// `SLPSSetFrontProcessWithOptions`.
pub fn set_front_process_persistently(target_pid: libc::pid_t, target_wid: u32) -> bool {
    set_front_process_persistently_guarded(target_pid,target_wid,||Ok::<(),std::convert::Infallible>(()))
        .unwrap_or(false)
}

pub fn set_front_process_persistently_guarded<E>(target_pid:libc::pid_t,target_wid:u32,
    before_write:impl FnMut()->Result<(),E>)->Result<bool,E> {
    set_front_process_persistently_diagnostic(target_pid,target_wid,before_write,|_,_|{})
}
pub(crate) fn set_front_process_persistently_diagnostic<E>(target_pid:libc::pid_t,target_wid:u32,
    mut before_write:impl FnMut()->Result<(),E>,mut failure:impl FnMut(&'static str,&'static str))->Result<bool,E> {
    let Some(set_front) = set_front_process_fn() else {
        failure("persistent_front","unavailable");
        return Ok(false);
    };
    let mut target_psn = [0u8; 8];
    if !get_process_psn_for_window(target_wid, target_pid, &mut target_psn) {
        failure("persistent_front","target_unresolved");
        return Ok(false);
    }

    // kCPSNoWindows = 0x400. Supplying the exact target window still makes
    // that window's process frontmost while avoiding a broad all-window raise.
    before_write()?;
    let accepted=unsafe { set_front(target_psn.as_ptr() as *const c_void, target_wid, 0x400) == 0 };
    if !accepted{failure("persistent_front","write_rejected");}Ok(accepted)
}

fn make_key_window_record(window_id: u32, event_kind: u8) -> [u8; 0xF8] {
    let mut record = [0u8; 0xF8];
    record[0x04] = 0xF8;
    record[0x08] = event_kind;
    record[0x3A] = 0x10;
    record[0x3C..0x40].copy_from_slice(&window_id.to_le_bytes());
    record[0x20..0x30].fill(0xFF);
    record
}

/// Make one exact application window native-key and frontmost.
///
/// Accessibility's `AXFocusedWindow` can change without AppKit making the
/// corresponding `NSWindow` key. Native menu validation observes the latter,
/// so focus-sensitive commands remain disabled in that split state. This is
/// the bounded exact-window sequence used by established macOS window tools:
/// mark the front-process request as user generated, synthesize the paired
/// make-key records for the requested WindowServer id, then let the caller
/// raise the matching AX window. No other application window is addressed.
pub fn make_exact_window_key(target_pid: libc::pid_t, target_wid: u32) -> bool {
    make_exact_window_key_guarded(target_pid, target_wid, || Ok::<(), std::convert::Infallible>(()))
        .unwrap_or(false)
}

/// Check the caller's cancellation/deadline immediately before every OS write.
/// An already-running synchronous write cannot be interrupted by this guard.
pub fn make_exact_window_key_guarded<E>(
    target_pid: libc::pid_t,
    target_wid: u32,
    before_write: impl FnMut() -> Result<(), E>,
) -> Result<bool, E> {
    make_exact_window_key_diagnostic(target_pid,target_wid,before_write,|_,_|{})
}
pub(crate) fn make_exact_window_key_diagnostic<E>(target_pid:libc::pid_t,target_wid:u32,
    before_write:impl FnMut()->Result<(),E>,mut failure:impl FnMut(&'static str,&'static str))->Result<bool,E> {
    let Some(set_front) = set_front_process_fn() else {
        failure("exact_key_front","unavailable");
        return Ok(false);
    };
    let Some(post) = post_event_record_to_fn() else {
        failure("exact_key_press","unavailable");
        return Ok(false);
    };
    let mut target_psn = [0u8; 8];
    if !get_process_psn_for_window(target_wid, target_pid, &mut target_psn) {
        failure("exact_key_front","target_unresolved");
        return Ok(false);
    }

    // kCPSUserGenerated = 0x200. Unlike kCPSNoWindows, this permits AppKit to
    // establish the requested native key window before it validates NSMenu.
    exact_key_write_diagnostic(before_write, |step| {
        if step == 0 {
            unsafe { set_front(target_psn.as_ptr() as *const c_void, target_wid, 0x200) == 0 }
        } else {
            let record = make_key_window_record(target_wid, step);
            unsafe { post(target_psn.as_ptr() as *const c_void, record.as_ptr()) == 0 }
        }
    },failure)
}
pub(crate) fn exact_key_step(step:u8)->&'static str {match step {0=>"exact_key_front",1=>"exact_key_press",_=>"exact_key_release"}}
fn exact_key_write_diagnostic<E>(before_write:impl FnMut()->Result<(),E>,mut write:impl FnMut(u8)->bool,
    mut failure:impl FnMut(&'static str,&'static str))->Result<bool,E> {
    exact_key_write_sequence(before_write,|step|{let accepted=write(step);if !accepted{failure(exact_key_step(step),"write_rejected");}accepted})
}

pub(crate) fn exact_key_write_sequence<E>(
    mut before_write: impl FnMut() -> Result<(), E>,
    mut write: impl FnMut(u8) -> bool,
) -> Result<bool, E> {
    for step in [0, 1, 2] {
        before_write()?;
        if !write(step) { return Ok(false); }
    }
    Ok(true)
}

/// Tool-agnostic foreground-assist: briefly front `window_id`, wait for the
/// activation to actually land, run `body` (which posts the synthetic input),
/// then restore the prior frontmost process.
///
/// This is the `delivery_mode:"foreground"` rung of the best-effort-background
/// ladder, shared by `type_text` and `click`. Reached only when the agent has
/// seen the background rungs fail (clicks) or the field is unverifiable +
/// focus-sensitive (Catalyst typing).
///
/// ## Why this does not delegate to [`with_menu_shortcut_activation`]
///
/// It used to. That helper posts `set_front` and calls `action` immediately,
/// which is correct for its own purpose: NSMenu key dispatch only needs the key
/// event *enqueued* in the target's run-loop queue, so first-responder identity
/// is irrelevant and the sub-millisecond front → act → restore is a feature.
///
/// Input delivery has the opposite requirement. `set_front` is asynchronous, so
/// running the body straight away means the body's `AXFocused` write races
/// AppKit's own activation. AppKit wins: when activation completes it installs
/// the window's remembered first responder and clobbers the write. The
/// keystrokes then land wherever the app chose — for a Catalyst app such as
/// WhatsApp, the message list rather than the composer, which silently scrolls
/// the transcript instead of typing.
///
/// So this waits for the activation to be observable before running `body`, the
/// same ordering [`with_foreground_hid_activation`] already relies on. The wait
/// is a bounded poll rather than a fixed sleep: an app that activates in 10 ms
/// pays 10 ms, and a slow Catalyst/RDP surface still gets its full budget.
///
/// Returns `Ok(true)` when the brief activation happened, `Ok(false)` when the
/// fronting SPIs are unavailable (the body still ran, just without a front).
pub fn with_foreground_assist(
    target_pid: libc::pid_t,
    target_wid: u32,
    body: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<bool> {
    let set_front = match set_front_process_fn() {
        Some(f) => f,
        None => {
            // SPIs unavailable — run body anyway without activation.
            body()?;
            return Ok(false);
        }
    };

    let mut prev_psn = [0u8; 8];
    let prev_ok = get_front_process_fn()
        .map(|f| unsafe { f(prev_psn.as_mut_ptr() as *mut c_void) } == 0)
        .unwrap_or(false);

    let mut target_psn = [0u8; 8];
    if !get_process_psn_for_window(target_wid, target_pid, &mut target_psn) {
        body()?;
        return Ok(false);
    }

    unsafe { set_front(target_psn.as_ptr() as *const c_void, target_wid, 0x400) };
    // `set_front` moves WindowServer's front process but does not make the
    // target's NSWindow key, and AppKit installs a first responder only for a
    // key window. Without this the app is "frontmost" to WindowServer while
    // remaining, from AppKit's point of view, unfocused — so the AXFocused
    // write in the body has no responder chain to attach to.
    make_exact_window_key(target_pid, target_wid);
    await_window_focused(target_pid, target_wid);

    let result = body();

    if prev_ok {
        unsafe { set_front(prev_psn.as_ptr() as *const c_void, 0, 0x400) };
    }

    result?;
    Ok(true)
}

/// Upper bound on how long [`with_foreground_assist`] waits for a requested
/// activation to become observable. Chosen to cover a Catalyst app's activation
/// plus key-window install; past this the caller proceeds anyway so a stubborn
/// target degrades to the old behavior instead of hanging.
const ACTIVATION_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(400);

/// Poll interval for [`await_window_focused`]. Short enough that a fast native
/// app pays roughly one tick, long enough not to spin on the WindowServer.
const ACTIVATION_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);

/// Block until `target_wid` is the application's focused AX window, or the
/// timeout expires. Returns whether that state was observed.
///
/// The predicate is deliberately `AXFocusedWindow` and not
/// `NSWorkspace.frontmostApplication`. The latter does not observe a
/// SkyLight-level front-process change at all: polling it every 15ms across a
/// full foreground `type_text` against WhatsApp showed zero transitions while
/// the target was demonstrably being fronted, so a frontmost-based wait always
/// burns its whole timeout and never actually gates on anything. `AXFocusedWindow`
/// is the same proof [`preserves_exact_existing_focus`] already trusts to decide
/// whether a window is focused.
///
/// A `false` return is not fatal: the caller proceeds with delivery regardless,
/// because a target that never reports focus is exactly the case the pre-existing
/// best-effort contract already covered.
fn await_window_focused(pid: libc::pid_t, window_id: u32) -> bool {
    let deadline = std::time::Instant::now() + ACTIVATION_WAIT_TIMEOUT;
    loop {
        if crate::ax::bindings::focused_window_id_of_pid(pid) == Some(window_id) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(ACTIVATION_POLL_INTERVAL);
    }
}

/// Activate an exact target window for a global HID keyboard action.
///
/// Unlike [`with_menu_shortcut_activation`], this helper must not run `action`
/// when the private foreground SPI is unavailable: a global HID event has no
/// pid addressing and would otherwise land in whichever application is
/// currently frontmost. The short settles keep the target frontmost until
/// WindowServer has routed both sides of the key chord, then restore the prior
/// process even when the action fails.
pub fn with_foreground_hid_activation(
    target_pid: libc::pid_t,
    target_wid: u32,
    action: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let set_front = set_front_process_fn()
        .ok_or_else(|| anyhow::anyhow!("foreground HID delivery is unavailable"))?;

    let mut prev_psn = [0u8; 8];
    let prev_ok = get_front_process_fn()
        .map(|f| unsafe { f(prev_psn.as_mut_ptr() as *mut c_void) } == 0)
        .unwrap_or(false);

    let mut target_psn = [0u8; 8];
    if !get_process_psn_for_window(target_wid, target_pid, &mut target_psn) {
        anyhow::bail!("could not resolve target window for foreground HID delivery");
    }

    let focused_window_id = crate::ax::bindings::focused_window_id_of_pid(target_pid);
    if preserves_exact_existing_focus(prev_ok, prev_psn, target_psn, focused_window_id, target_wid)
    {
        // Re-activating an already key exact window can clear Chromium's
        // renderer focus even though WindowServer keeps the app frontmost.
        // The AX window proof lets us deliver directly without weakening the
        // exact-window guard or disturbing the current key target.
        return action();
    }

    let activated = unsafe { set_front(target_psn.as_ptr() as *const c_void, target_wid, 0x400) };
    if activated != 0 {
        anyhow::bail!("WindowServer rejected foreground HID activation");
    }

    make_exact_window_key(target_pid, target_wid);
    if !await_window_focused(target_pid, target_wid) {
        if prev_ok {
            unsafe { set_front(prev_psn.as_ptr() as *const c_void, 0, 0x400) };
        }
        anyhow::bail!("exact target window did not become focused for foreground HID delivery");
    }

    let result = action();
    std::thread::sleep(std::time::Duration::from_millis(40));

    if prev_ok {
        unsafe { set_front(prev_psn.as_ptr() as *const c_void, 0, 0x400) };
    }

    result
}

fn preserves_exact_existing_focus(
    previous_process_known: bool,
    previous_psn: [u8; 8],
    target_psn: [u8; 8],
    focused_window_id: Option<u32>,
    target_window_id: u32,
) -> bool {
    previous_process_known
        && previous_psn == target_psn
        && focused_window_id == Some(target_window_id)
}

/// Activate `target_pid`'s window `target_wid` for NSMenu key dispatch, run `action`,
/// then immediately restore the prior frontmost process.
///
/// The entire activate → action → restore sequence is < 1 ms — a 5 ms UX monitor
/// never observes the intermediate frontmost state. NSMenu still fires because the
/// key event is already enqueued in the target's run-loop queue before we restore.
///
/// Returns `Ok(true)` when activation succeeded, `Ok(false)` when SPIs unavailable.
pub fn with_menu_shortcut_activation(
    target_pid: libc::pid_t,
    target_wid: u32,
    action: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<bool> {
    let set_front = match set_front_process_fn() {
        Some(f) => f,
        None => {
            // SPIs unavailable — run action anyway without activation.
            action()?;
            return Ok(false);
        }
    };

    // Capture prior frontmost PSN.
    let mut prev_psn = [0u8; 8];
    let prev_ok = get_front_process_fn()
        .map(|f| unsafe { f(prev_psn.as_mut_ptr() as *mut c_void) } == 0)
        .unwrap_or(false);

    // Resolve target PSN.
    let mut target_psn = [0u8; 8];
    let target_ok = get_process_psn_for_window(target_wid, target_pid, &mut target_psn);
    if !target_ok {
        action()?;
        return Ok(false);
    }

    // Make target WindowServer-frontmost (kCPSNoWindows = 0x400).
    unsafe { set_front(target_psn.as_ptr() as *const c_void, target_wid, 0x400) };

    // Run action then restore — even if action fails.
    let result = action();

    // Restore prior frontmost (windowID=0, options=0x400).
    if prev_ok {
        unsafe { set_front(prev_psn.as_ptr() as *const c_void, 0, 0x400) };
    }

    result?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    #[test]fn task_space_empty_provenance_rejects_negative_count_without_changing_legacy_refusal(){
        assert_eq!(super::task_space_count(-1),Err(super::evidence_failure("space_set","invalid_count")));
        assert!(super::task_space_count(0).is_ok());assert!(super::task_space_count(1).is_ok());
        assert_eq!(super::complete_space_ids_result(-1,|_|panic!("negative accessed item")),Err(super::evidence_failure("space_set","empty")));
        assert_eq!(super::complete_space_ids_result(0,|_|panic!("empty accessed item")),Err(super::evidence_failure("space_set","empty")));
    }
    use super::{exact_key_write_sequence, make_key_window_record, preserves_exact_existing_focus};
    use std::cell::{Cell,RefCell};

    #[test]
    fn space_detailed_decoder_reports_first_real_gate_without_filtering_or_extra_access() {
        use super::{complete_space_ids_result,evidence_failure,strict_integer_result};
        for (number,float,converted,class) in [(false,false,Some(7),"wrong_type"),(true,true,Some(7),"floating"),(true,false,None,"conversion")] {
            assert_eq!(strict_integer_result(number,||float,||converted),Err(class));
            let calls=Cell::new(0);
            assert_eq!(complete_space_ids_result(2,|_|{calls.set(calls.get()+1);strict_integer_result(number,||float,||converted).map_err(|class|evidence_failure("space_item",class))}),Err(evidence_failure("space_item",class)));
            assert_eq!(calls.get(),1);
        }
        for (values,class) in [([0,7],"nonpositive"),([-1,7],"nonpositive"),([7,7],"duplicate")] {
            assert_eq!(complete_space_ids_result(2,|i|Ok(values[i])),Err(evidence_failure("space_item",class)));
        }
        for (count,class) in [(0,"empty"),(33,"limit")] {
            assert_eq!(complete_space_ids_result(count,|_|panic!("invalid count accessed items")),Err(evidence_failure("space_set",class)));
        }
        assert_eq!(complete_space_ids_result(2,|i|Ok([7,9][i])).ok(),super::complete_space_ids(2,|i|Some([7,9][i])));
    }
    #[test]
    fn space_owned_and_managed_detailed_failures_keep_release_and_spi_short_circuit() {
        let releases=Cell::new(0);
        assert_eq!(super::owned_cf_result(true,||panic!("null type"),1,||panic!("null release")),Err("null_result"));
        assert_eq!(super::owned_cf_result(false,||2,1,||releases.set(releases.get()+1)),Err("wrong_type"));assert_eq!(releases.get(),1);
        assert_eq!(super::owned_cf_result(false,||1,1,||panic!("RAII value manually released")),Ok(()));
        assert_eq!(super::managed_display_space_result(0,||panic!("empty display SPI")),Err(super::evidence_failure("managed_display","empty")));
        assert_eq!(super::managed_display_space_result(1,||0),Err(super::evidence_failure("current_space","nonpositive")));
        assert_eq!(super::managed_display_space_result(1,||7).ok(),super::managed_display_space(1,||7));
    }

    #[test]
    fn exact_key_diagnostic_records_only_actual_first_failed_write_and_no_guard_failure() {
        for failed in [0,1,2] {
            let mut writes=Vec::new();let mut failures=Vec::new();
            assert_eq!(super::exact_key_write_diagnostic(||Ok::<(),()>(()),|step|{writes.push(step);step!=failed},
                |step,class|failures.push((step,class))),Ok(false));
            assert_eq!(writes,(0..=failed).collect::<Vec<_>>());
            assert_eq!(failures,vec![(super::exact_key_step(failed),"write_rejected")]);
        }
        assert_eq!(super::exact_key_write_diagnostic(||Err("cancelled"),|_|panic!("guard bypass"),|_,_|panic!("invented failure")),Err("cancelled"));
        assert_eq!(super::exact_key_write_diagnostic(||Ok::<(),()>(()),|_|true,|_,_|panic!("success diagnostic")),Ok(true));
    }

    #[test]
    fn space_managed_display_empty_never_queries_current_space() {
        for count in [-1,0] {
            assert_eq!(super::managed_display_space(count,||panic!("empty display queried")),None);
        }
        let calls=Cell::new(0);
        assert_eq!(super::managed_display_space(1,||{calls.set(calls.get()+1);7}),Some(7));
        assert_eq!(calls.get(),1);
        assert_eq!(super::managed_display_space(1,||{calls.set(calls.get()+1);0}),None);
        assert_eq!(calls.get(),2);
    }

    #[test]
    fn space_decoder_rejects_entire_invalid_set_and_preserves_valid_members() {
        use super::complete_space_ids;
        assert_eq!(complete_space_ids(2, |i| Some([7,9][i])), Some(vec![7,9]));
        for values in [vec![Some(0),Some(7)], vec![Some(7),Some(0)], vec![Some(-1),Some(7)], vec![Some(7),Some(7)], vec![None,Some(7)]] {
            assert_eq!(complete_space_ids(values.len() as isize, |i| values[i]), None);
        }
        assert_eq!(complete_space_ids(32, |i| Some(i as i64 + 1)), Some((1..=32).collect()));
    }

    #[test]
    fn space_decoder_checks_limit_before_any_item_access() {
        for count in [-1,0,33,isize::MAX] {
            let calls=Cell::new(0);
            assert_eq!(super::complete_space_ids(count, |_| {calls.set(calls.get()+1);Some(7)}),None);
            assert_eq!(calls.get(),0);
        }
    }

    #[test]
    fn space_and_topology_integer_decoder_never_converts_float_or_bad_type() {
        for (number,float) in [(false,false),(true,true)] {
            let calls=Cell::new(0);
            assert_eq!(super::strict_integer_value(number,||float,||{calls.set(calls.get()+1);Some(7)}),None);
            assert_eq!(calls.get(),0);
        }
        assert_eq!(super::strict_integer_value(true,||false,||None),None);
        assert_eq!(super::strict_integer_value(true,||false,||Some(7)),Some(7));
        assert_eq!(super::complete_space_ids(2, |_| super::strict_integer_value(true,||true,||Some(7))),None);
    }

    #[test]
    fn space_owned_outer_type_releases_wrong_type_once_without_consuming_it() {
        let released=Cell::new(0);
        assert!(!super::owned_cf_type(true,||panic!("null type queried"),1,||panic!("null released")));
        assert!(!super::owned_cf_type(false,||2,1,||released.set(released.get()+1)));
        assert_eq!(released.get(),1);
        assert!(super::owned_cf_type(false,||1,1,||released.set(released.get()+1)));
        assert_eq!(released.get(),1); // accepted owned value is released by its existing RAII wrapper.
    }

    #[test]
    fn exact_key_guard_cancel_or_deadline_inside_write_stops_unstarted_events() {
        for stop_after in [0,1] {
            for reason in ["cancelled","deadline","reply_closed"] {
                let stopped=Cell::new(false);let started=Cell::new(false);let writes=RefCell::new(Vec::new());
                let result=exact_key_write_sequence(|| {
                    if stopped.get(){return Err(reason);}
                    started.set(true);Ok(())
                },|step|{writes.borrow_mut().push(step);if step==stop_after{stopped.set(true);}true});
                assert_eq!(result,Err(reason));assert!(started.get());
                assert_eq!(*writes.borrow(),(0..=stop_after).collect::<Vec<_>>());
            }
        }
    }

    #[test]
    fn exact_key_guard_before_first_write_preserves_not_started() {
        let started=Cell::new(false);let writes=Cell::new(0);
        let result=exact_key_write_sequence(|| {
            let blocked=true;if blocked{return Err("cancelled");}started.set(true);Ok(())
        },|_|{writes.set(writes.get()+1);true});
        assert_eq!(result,Err("cancelled"));assert!(!started.get());assert_eq!(writes.get(),0);
    }

    #[test]
    fn exact_key_guard_normal_order_and_os_failure_never_continue() {
        for fail_at in [None,Some(0),Some(1),Some(2)] {
            let writes=RefCell::new(Vec::new());let started=Cell::new(false);let guards=Cell::new(0);
            let result=exact_key_write_sequence(|| {guards.set(guards.get()+1);started.set(true);Ok::<(),()>(())},
                |step|{writes.borrow_mut().push(step);Some(step)!=fail_at});
            let length=fail_at.map(|n|n+1).unwrap_or(3) as usize;
            assert_eq!(result,Ok(fail_at.is_none()));assert!(started.get());
            assert_eq!(*writes.borrow(),(0..length as u8).collect::<Vec<_>>());assert_eq!(guards.get(),length);
        }
    }

    #[test]
    fn make_key_records_address_only_the_exact_window() {
        let press = make_key_window_record(0x7856_3412, 0x01);
        let release = make_key_window_record(0x7856_3412, 0x02);
        assert_eq!(press.len(), 0xF8);
        assert_eq!(press[0x04], 0xF8);
        assert_eq!(press[0x08], 0x01);
        assert_eq!(release[0x08], 0x02);
        assert_eq!(&press[0x3C..0x40], &[0x12, 0x34, 0x56, 0x78]);
        assert_eq!(press[0x3A], 0x10);
        assert!(press[0x20..0x30].iter().all(|byte| *byte == 0xFF));
    }

    #[test]
    fn exact_existing_focus_avoids_reactivation() {
        let psn = [1, 2, 3, 4, 5, 6, 7, 8];
        assert!(preserves_exact_existing_focus(true, psn, psn, Some(42), 42));
    }

    #[test]
    fn process_or_window_uncertainty_requires_guarded_activation() {
        let target = [1, 2, 3, 4, 5, 6, 7, 8];
        let other = [8, 7, 6, 5, 4, 3, 2, 1];
        assert!(!preserves_exact_existing_focus(
            false,
            target,
            target,
            Some(42),
            42
        ));
        assert!(!preserves_exact_existing_focus(
            true,
            other,
            target,
            Some(42),
            42
        ));
        assert!(!preserves_exact_existing_focus(
            true,
            target,
            target,
            Some(41),
            42
        ));
        assert!(!preserves_exact_existing_focus(
            true, target, target, None, 42
        ));
    }
}
