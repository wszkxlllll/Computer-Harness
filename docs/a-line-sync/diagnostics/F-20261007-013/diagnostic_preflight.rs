//! Private Harness diagnostic preflight. No service, UI, worker or request APIs.
//! Signature self-consistency is not publisher or TCC-principal authentication.

use serde::Serialize;
use std::{ffi::OsString, path::PathBuf};

const COMMAND: &str = "diagnostic-preflight-only";
const BUNDLE_NAME: &str = "HarnessF005Diagnostic.app";
const IDENTIFIER: &str = "org.computerharness.diagnostic.f005";
const EXECUTABLE: &str = "cua-driver-local";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Request {
    Ordinary,
    Preflight,
    Invalid,
}

fn classify_arguments(args: &[OsString]) -> Request {
    if !args.iter().any(|arg| arg == COMMAND) {
        return Request::Ordinary;
    }
    if args.len() == 1 && args[0] == COMMAND {
        Request::Preflight
    } else {
        Request::Invalid
    }
}

#[derive(Clone)]
struct IdentityEvidence {
    signature_valid: bool,
    signing_identifier: String,
    secured_plist_identifier: String,
    secured_plist_executable: String,
    secured_plist_package_type: String,
    unique_identity_present: bool,
    current_executable: PathBuf,
    signed_main_executable: PathBuf,
    signed_code_path: PathBuf,
}

fn validate_identity(value: &IdentityEvidence) -> bool {
    if !value.signature_valid
        || !value.unique_identity_present
        || value.signing_identifier != IDENTIFIER
        || value.secured_plist_identifier != IDENTIFIER
        || value.secured_plist_executable != EXECUTABLE
        || value.secured_plist_package_type != "APPL"
        || !value.current_executable.is_absolute()
        || value.current_executable.components().any(|part| {
            matches!(part, std::path::Component::ParentDir | std::path::Component::CurDir)
        })
        || value.current_executable != value.signed_main_executable
    {
        return false;
    }
    let Some(macos) = value.current_executable.parent() else { return false; };
    let Some(contents) = macos.parent() else { return false; };
    let Some(bundle) = contents.parent() else { return false; };
    bundle.file_name().is_some_and(|name| name == BUNDLE_NAME)
        && contents.file_name().is_some_and(|name| name == "Contents")
        && macos.file_name().is_some_and(|name| name == "MacOS")
        && value.current_executable.file_name().is_some_and(|name| name == EXECUTABLE)
        && value.signed_code_path == bundle
}

trait EvidenceSource {
    fn identity(&mut self) -> Result<IdentityEvidence, ()>;
    fn accessibility(&mut self) -> Result<bool, ()>;
    fn screen_capture(&mut self) -> Result<bool, ()>;
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema: &'static str,
    outcome: &'static str,
    self_identity_validated: bool,
    accessibility: Option<bool>,
    screen_capture: Option<bool>,
    principal_verified: bool,
    ready_for_dispatch: bool,
}

impl Report {
    fn refused(outcome: &'static str) -> Self {
        Self {
            schema: "harness.diagnostic_preflight.v1",
            outcome,
            self_identity_validated: false,
            accessibility: None,
            screen_capture: None,
            principal_verified: false,
            ready_for_dispatch: false,
        }
    }
}

fn evaluate(source: &mut impl EvidenceSource) -> Report {
    match source.identity() {
        Err(()) => return Report::refused("identity_unknown"),
        Ok(identity) if !validate_identity(&identity) => return Report::refused("identity_rejected"),
        Ok(_) => {}
    }
    // Exactly these two read-only probes, only after all self-identity checks pass.
    let accessibility = source.accessibility().ok();
    let screen_capture = source.screen_capture().ok();
    let outcome = match (accessibility, screen_capture) {
        (Some(true), Some(true)) => "observed_unverified",
        (Some(_), Some(_)) => "permissions_not_granted",
        _ => "permission_status_unknown",
    };
    Report {
        outcome,
        self_identity_validated: true,
        accessibility,
        screen_capture,
        ..Report::refused(outcome)
    }
}

fn evaluate_request(args: &[OsString], source: &mut impl EvidenceSource) -> Option<Report> {
    match classify_arguments(args) {
        Request::Ordinary => None,
        Request::Invalid => Some(Report::refused("invalid_arguments")),
        Request::Preflight => Some(evaluate(source)),
    }
}

#[cfg(target_os = "macos")]
pub fn run_if_requested() -> Option<i32> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let report = evaluate_request(&args, &mut native::SelfEvidence)?;
    // Every serialized field is fixed-size/enumerated/boolean. No raw path or error text.
    match serde_json::to_string(&report) {
        Ok(json) => println!("{json}"),
        Err(_) => {
            println!("{{\"schema\":\"harness.diagnostic_preflight.v1\",\"outcome\":\"report_unknown\",\"selfIdentityValidated\":false,\"accessibility\":null,\"screenCapture\":null,\"principalVerified\":false,\"readyForDispatch\":false}}");
            return Some(2);
        }
    }
    Some(match report.outcome {
        "invalid_arguments" => 64,
        "observed_unverified" => 0,
        _ => 2,
    })
}

#[cfg(target_os = "macos")]
mod native {
    use super::{EvidenceSource, IdentityEvidence, IDENTIFIER};
    use core_foundation::{
        base::{CFType, TCFType}, data::CFData, dictionary::{CFDictionary, CFDictionaryRef},
        string::{CFString, CFStringRef}, url::CFURL,
    };
    use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};
    use std::{ffi::c_void, path::PathBuf};

    // Already-locked Security/CF dependencies; no shell command or new dependency.
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecCodeCopySigningInformation(code: *const c_void, flags: u32, information: *mut CFDictionaryRef) -> i32;
        static kSecCodeInfoIdentifier: CFStringRef;
        static kSecCodeInfoMainExecutable: CFStringRef;
        static kSecCodeInfoPList: CFStringRef;
        static kSecCodeInfoUnique: CFStringRef;
    }

    pub(super) struct SelfEvidence;

    fn value(dict: &CFDictionary, key: CFStringRef) -> Result<CFType, ()> {
        if key.is_null() { return Err(()); }
        let raw = *dict.find(key.cast::<c_void>()).ok_or(())?;
        if raw.is_null() { return Err(()); }
        // Values are borrowed from the owned dictionary; get-rule retains them.
        Ok(unsafe { CFType::wrap_under_get_rule(raw) })
    }

    fn string_value(dict: &CFDictionary, key: &str) -> Result<String, ()> {
        let key = CFString::new(key);
        value(dict, key.as_concrete_TypeRef())?.downcast::<CFString>()
            .map(|text| text.to_string()).ok_or(())
    }

    fn canonical_url(value: CFType) -> Result<PathBuf, ()> {
        let url = value.downcast::<CFURL>().ok_or(())?;
        std::fs::canonicalize(url.to_path().ok_or(())?).map_err(|_| ())
    }

    impl EvidenceSource for SelfEvidence {
        fn identity(&mut self) -> Result<IdentityEvidence, ()> {
            let code = SecCode::for_self(Flags::NONE).map_err(|_| ())?;
            let requirement: SecRequirement = format!("identifier \"{IDENTIFIER}\"").parse().map_err(|_| ())?;
            let flags = Flags::STRICT_VALIDATE | Flags::NO_NETWORK_ACCESS;
            code.check_validity(flags, &requirement).map_err(|_| ())?;
            let mut raw: CFDictionaryRef = std::ptr::null();
            let status = unsafe { SecCodeCopySigningInformation(code.as_CFTypeRef(), 0, &mut raw) };
            // Error outputs have no documented ownership/type guarantee; never wrap them.
            if status != 0 { return Err(()); }
            if raw.is_null() { return Err(()); }
            // Successful create-rule output owns +1; downcast checks its CF type.
            let returned = unsafe { CFType::wrap_under_create_rule(raw.cast::<c_void>()) };
            let info = returned.downcast::<CFDictionary>().ok_or(())?;
            let signing_identifier = unsafe { value(&info, kSecCodeInfoIdentifier) }?
                .downcast::<CFString>().map(|text| text.to_string()).ok_or(())?;
            let plist = unsafe { value(&info, kSecCodeInfoPList) }?.downcast::<CFDictionary>().ok_or(())?;
            let signed_main_executable = canonical_url(unsafe { value(&info, kSecCodeInfoMainExecutable) }?)?;
            let unique = unsafe { value(&info, kSecCodeInfoUnique) }?.downcast::<CFData>().ok_or(())?;
            let signed_code_path = std::fs::canonicalize(code.path(Flags::NONE).map_err(|_| ())?.to_path().ok_or(())?)
                .map_err(|_| ())?;
            let current_executable = std::fs::canonicalize(std::env::current_exe().map_err(|_| ())?).map_err(|_| ())?;
            let identity = IdentityEvidence {
                signature_valid: true,
                signing_identifier,
                secured_plist_identifier: string_value(&plist, "CFBundleIdentifier")?,
                secured_plist_executable: string_value(&plist, "CFBundleExecutable")?,
                secured_plist_package_type: string_value(&plist, "CFBundlePackageType")?,
                unique_identity_present: !unique.bytes().is_empty() && unique.bytes().len() <= 64,
                current_executable,
                signed_main_executable,
                signed_code_path,
            };
            // Recheck after extracting disk-backed information before any TCC probe.
            code.check_validity(flags, &requirement).map_err(|_| ())?;
            Ok(identity)
        }

        fn accessibility(&mut self) -> Result<bool, ()> {
            Ok(crate::permissions::status::accessibility_granted())
        }

        fn screen_capture(&mut self) -> Result<bool, ()> {
            Ok(crate::permissions::status::screen_recording_granted())
        }
    }
}

#[cfg(test)]
#[path = "diagnostic_preflight_independent.rs"]
mod independent_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn good_identity() -> IdentityEvidence {
        let bundle = PathBuf::from("/private/tmp/fixture/HarnessF005Diagnostic.app");
        let exe = bundle.join("Contents/MacOS/cua-driver-local");
        IdentityEvidence {
            signature_valid: true,
            signing_identifier: IDENTIFIER.into(),
            secured_plist_identifier: IDENTIFIER.into(),
            secured_plist_executable: EXECUTABLE.into(),
            secured_plist_package_type: "APPL".into(),
            unique_identity_present: true,
            current_executable: exe.clone(), signed_main_executable: exe, signed_code_path: bundle,
        }
    }

    struct Fake {
        evidence: Result<IdentityEvidence, ()>,
        ax: Result<bool, ()>, screen: Result<bool, ()>, calls: Vec<&'static str>,
    }
    impl Fake {
        fn good() -> Self { Self { evidence: Ok(good_identity()), ax: Ok(true), screen: Ok(true), calls: vec![] } }
    }
    impl EvidenceSource for Fake {
        fn identity(&mut self) -> Result<IdentityEvidence, ()> { self.calls.push("identity"); self.evidence.clone() }
        fn accessibility(&mut self) -> Result<bool, ()> { self.calls.push("ax"); self.ax }
        fn screen_capture(&mut self) -> Result<bool, ()> { self.calls.push("screen"); self.screen }
    }

    #[test]
    fn ordinary_commands_are_untouched_and_extra_arguments_have_zero_identity_or_probes() {
        for args in [vec![], vec!["serve"], vec!["help"], vec!["version"]] {
            let mut fake = Fake::good();
            let args: Vec<OsString> = args.into_iter().map(OsString::from).collect();
            assert!(evaluate_request(&args, &mut fake).is_none()); assert!(fake.calls.is_empty());
        }
        for args in [vec![COMMAND, "--socket", "secret"], vec!["--flag", COMMAND], vec![COMMAND, COMMAND]] {
            let mut fake = Fake::good();
            let args: Vec<OsString> = args.into_iter().map(OsString::from).collect();
            assert_eq!(evaluate_request(&args, &mut fake).unwrap().outcome, "invalid_arguments");
            assert!(fake.calls.is_empty());
        }
    }

    #[test]
    fn wrong_signature_identifiers_plist_or_bundle_never_probe() {
        let mutations: Vec<Box<dyn Fn(&mut IdentityEvidence)>> = vec![
            Box::new(|v| v.signature_valid = false), Box::new(|v| v.unique_identity_present = false),
            Box::new(|v| v.signing_identifier = "com.trycua.driver.local".into()),
            Box::new(|v| v.secured_plist_identifier = "other".into()),
            Box::new(|v| v.secured_plist_executable = "other".into()),
            Box::new(|v| v.secured_plist_package_type = "BNDL".into()),
            Box::new(|v| v.current_executable = PathBuf::from("/private/tmp/cua-driver-local")),
            Box::new(|v| v.signed_main_executable = PathBuf::from("/private/tmp/wrong")),
            Box::new(|v| v.signed_code_path = PathBuf::from("/private/tmp/CuaDriverLocal.app")),
        ];
        for mutate in mutations {
            let mut fake = Fake::good(); mutate(fake.evidence.as_mut().unwrap());
            let report = evaluate(&mut fake);
            assert_eq!(report.outcome, "identity_rejected"); assert!(!report.self_identity_validated);
            assert_eq!(fake.calls, vec!["identity"]); assert_eq!(report.accessibility, None);
        }
    }

    #[test]
    fn bare_vendor_and_noncanonical_paths_fail_the_pure_identity_contract() {
        for bundle in ["CuaDriver.app", "CuaDriverLocal.app", "HarnessF005Diagnostic.app.other"] {
            let mut identity = good_identity();
            let path = PathBuf::from("/private/tmp/fixture").join(bundle);
            identity.signed_code_path = path.clone();
            identity.current_executable = path.join("Contents/MacOS/cua-driver-local");
            identity.signed_main_executable = identity.current_executable.clone();
            assert!(!validate_identity(&identity));
        }
        let mut identity = good_identity();
        identity.current_executable = PathBuf::from("/private/tmp/x/../HarnessF005Diagnostic.app/Contents/MacOS/cua-driver-local");
        identity.signed_main_executable = identity.current_executable.clone();
        assert!(!validate_identity(&identity));
    }

    #[test]
    fn identity_unknown_is_not_permission_unknown_and_never_probes() {
        let mut fake = Fake::good(); fake.evidence = Err(());
        assert_eq!(evaluate(&mut fake), Report::refused("identity_unknown"));
        assert_eq!(fake.calls, vec!["identity"]);
    }

    #[test]
    fn matching_fake_identity_invokes_each_read_only_probe_once_but_never_authenticates_principal() {
        let mut fake = Fake::good();
        let report = evaluate_request(&[OsString::from(COMMAND)], &mut fake).unwrap();
        assert_eq!(fake.calls, vec!["identity", "ax", "screen"]);
        assert_eq!(report.outcome, "observed_unverified"); assert!(report.self_identity_validated);
        assert_eq!(report.accessibility, Some(true)); assert_eq!(report.screen_capture, Some(true));
        assert!(!report.principal_verified); assert!(!report.ready_for_dispatch);
    }

    #[test]
    fn false_or_unknown_probes_never_become_a_ready_state() {
        for (ax, screen, outcome) in [
            (Ok(false), Ok(true), "permissions_not_granted"),
            (Ok(true), Ok(false), "permissions_not_granted"),
            (Err(()), Ok(true), "permission_status_unknown"),
            (Ok(true), Err(()), "permission_status_unknown"),
        ] {
            let mut fake = Fake::good(); fake.ax = ax; fake.screen = screen;
            let report = evaluate(&mut fake);
            assert_eq!(report.outcome, outcome); assert!(!report.ready_for_dispatch); assert!(!report.principal_verified);
            assert_eq!(fake.calls, vec!["identity", "ax", "screen"]);
        }
    }

    #[test]
    fn reports_are_bounded_and_do_not_contain_identity_paths_or_errors() {
        let mut fake = Fake::good();
        for report in [evaluate(&mut fake), Report::refused("identity_unknown"), Report::refused("invalid_arguments")] {
            let json = serde_json::to_string(&report).unwrap();
            assert!(json.len() < 512); assert!(!json.contains("/private/tmp"));
            assert!(!json.contains(IDENTIFIER)); assert!(!json.contains("CFBundle"));
            assert!(json.contains("\"principalVerified\":false")); assert!(json.contains("\"readyForDispatch\":false"));
        }
    }
}
