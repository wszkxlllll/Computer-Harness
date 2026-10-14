//! Independent fake-only tests; never constructs native::SelfEvidence.
use super::*;
use std::os::unix::ffi::OsStringExt;

fn fixture_identity() -> IdentityEvidence {
    let bundle = PathBuf::from("/private/tmp/synthetic/HarnessF005Diagnostic.app");
    let exe = bundle.join("Contents/MacOS/cua-driver-local");
    IdentityEvidence {
        signature_valid: true, signing_identifier: IDENTIFIER.into(),
        secured_plist_identifier: IDENTIFIER.into(), secured_plist_executable: EXECUTABLE.into(),
        secured_plist_package_type: "APPL".into(), unique_identity_present: true,
        current_executable: exe.clone(), signed_main_executable: exe, signed_code_path: bundle,
    }
}
struct Fixture {
    identity: Result<IdentityEvidence, ()>, ax: Result<bool, ()>, cg: Result<bool, ()>, calls: Vec<&'static str>,
}
impl Fixture {
    fn new() -> Self { Self { identity: Ok(fixture_identity()), ax: Ok(true), cg: Ok(true), calls: vec![] } }
}
impl EvidenceSource for Fixture {
    fn identity(&mut self) -> Result<IdentityEvidence, ()> { self.calls.push("identity"); self.identity.clone() }
    fn accessibility(&mut self) -> Result<bool, ()> { self.calls.push("ax"); self.ax }
    fn screen_capture(&mut self) -> Result<bool, ()> { self.calls.push("cg"); self.cg }
}
fn rejection(mutate: impl FnOnce(&mut IdentityEvidence)) {
    let mut fixture = Fixture::new(); mutate(fixture.identity.as_mut().unwrap());
    let report = evaluate_request(&[COMMAND.into()], &mut fixture).unwrap();
    assert_eq!(report.outcome, "identity_rejected"); assert!(!report.self_identity_validated);
    assert!(!report.principal_verified); assert!(!report.ready_for_dispatch);
    assert_eq!((report.accessibility, report.screen_capture), (None, None));
    assert_eq!(fixture.calls, vec!["identity"]);
}

#[test]
fn sentinel_mixed_with_ordinary_commands_always_hard_refuses_without_evidence() {
    for args in [vec!["serve", COMMAND], vec![COMMAND, "serve"], vec!["history-purge", COMMAND], vec!["--help", COMMAND], vec![COMMAND, "Invalid"], vec![COMMAND, COMMAND]] {
        let args: Vec<OsString> = args.into_iter().map(Into::into).collect(); let mut fixture = Fixture::new();
        assert_eq!(evaluate_request(&args, &mut fixture), Some(Report::refused("invalid_arguments")));
        assert!(fixture.calls.is_empty());
    }
}
#[test]
fn non_unicode_extra_is_rejected_without_lossy_conversion_or_probe() {
    for args in [vec![COMMAND.into(), OsString::from_vec(vec![0xff])], vec![OsString::from_vec(vec![0xff]), COMMAND.into()]] {
        let mut fixture = Fixture::new(); assert_eq!(evaluate_request(&args, &mut fixture), Some(Report::refused("invalid_arguments"))); assert!(fixture.calls.is_empty());
    }
}
#[test]
fn near_sentinel_and_non_unicode_without_exact_sentinel_preserve_ordinary_route() {
    for args in [vec![OsString::from("--diagnostic-preflight-only")], vec![OsString::from("diagnostic-preflight-only ")], vec![OsString::from_vec(vec![0xff])], vec![]] {
        let mut fixture = Fixture::new(); assert!(evaluate_request(&args, &mut fixture).is_none()); assert!(fixture.calls.is_empty());
    }
}
#[test]
fn invalid_signature_and_missing_unique_identity_never_probe() {
    rejection(|v| v.signature_valid = false); rejection(|v| v.unique_identity_present = false);
}
#[test]
fn empty_secured_fields_never_probe() {
    rejection(|v| v.signing_identifier.clear()); rejection(|v| v.secured_plist_identifier.clear());
    rejection(|v| v.secured_plist_executable.clear()); rejection(|v| v.secured_plist_package_type.clear());
}
#[test]
fn valid_signature_with_vendor_or_mismatched_identifiers_never_probe() {
    rejection(|v| v.signing_identifier = "com.trycua.driver".into());
    rejection(|v| v.secured_plist_identifier = "org.computerharness.diagnostic.f005.extra".into());
}
#[test]
fn executable_and_package_type_are_exact_not_casefolded() {
    rejection(|v| v.secured_plist_executable = "Cua-driver-local".into());
    rejection(|v| v.secured_plist_package_type = "appl".into());
}
#[test]
fn equivalent_looking_noncanonical_relative_path_is_rejected() {
    rejection(|v| { v.current_executable = PathBuf::from("HarnessF005Diagnostic.app/Contents/MacOS/cua-driver-local"); v.signed_main_executable = v.current_executable.clone(); v.signed_code_path = PathBuf::from("HarnessF005Diagnostic.app"); });
    rejection(|v| { v.current_executable = PathBuf::from("/private/tmp/other/../HarnessF005Diagnostic.app/Contents/MacOS/cua-driver-local"); v.signed_main_executable = v.current_executable.clone(); });
}
#[test]
fn all_consistent_but_wrong_bundle_layout_is_rejected() {
    for suffix in ["HarnessF005Diagnostic.app.other/Contents/MacOS/cua-driver-local", "HarnessF005Diagnostic.app/contents/MacOS/cua-driver-local", "HarnessF005Diagnostic.app/Contents/Resources/cua-driver-local", "HarnessF005Diagnostic.app/Contents/MacOS/cua-driver"] {
        rejection(|v| { v.current_executable = PathBuf::from("/private/tmp/synthetic").join(suffix); v.signed_main_executable = v.current_executable.clone(); v.signed_code_path = v.current_executable.parent().unwrap().parent().unwrap().parent().unwrap().to_path_buf(); });
    }
}
#[test]
fn signed_main_and_signed_code_path_must_both_bind_same_current_bundle() {
    rejection(|v| v.signed_main_executable = PathBuf::from("/private/tmp/other/HarnessF005Diagnostic.app/Contents/MacOS/cua-driver-local"));
    rejection(|v| v.signed_code_path = PathBuf::from("/private/tmp/other/HarnessF005Diagnostic.app"));
}
#[test]
fn unknown_identity_stops_before_any_probe() {
    let mut fixture = Fixture::new(); fixture.identity = Err(());
    assert_eq!(evaluate_request(&[COMMAND.into()], &mut fixture), Some(Report::refused("identity_unknown"))); assert_eq!(fixture.calls, vec!["identity"]);
}
#[test]
fn all_nine_permission_combinations_remain_unverified_and_probe_exactly_once() {
    for ax in [Ok(true), Ok(false), Err(())] { for cg in [Ok(true), Ok(false), Err(())] {
        let mut fixture = Fixture::new(); fixture.ax = ax; fixture.cg = cg;
        let report = evaluate_request(&[COMMAND.into()], &mut fixture).unwrap(); assert!(report.self_identity_validated);
        assert_eq!((report.accessibility, report.screen_capture), (ax.ok(), cg.ok())); assert_eq!(fixture.calls, vec!["identity", "ax", "cg"]);
        assert!(!report.principal_verified); assert!(!report.ready_for_dispatch);
        let expected = if ax.is_err() || cg.is_err() { "permission_status_unknown" } else if ax == Ok(true) && cg == Ok(true) { "observed_unverified" } else { "permissions_not_granted" };
        assert_eq!(report.outcome, expected);
    } }
}
#[test]
fn public_report_cannot_serialize_raw_identity_material() {
    let mut fixture = Fixture::new(); let report = evaluate(&mut fixture); let json = serde_json::to_string(&report).unwrap();
    assert!(json.len() < 512); assert!(!json.contains("/private/tmp")); assert!(!json.contains(IDENTIFIER)); assert!(!json.contains(EXECUTABLE));
    let value: serde_json::Value = serde_json::from_str(&json).unwrap(); assert_eq!(value.as_object().unwrap().len(), 7);
    assert_eq!(value["principalVerified"], false); assert_eq!(value["readyForDispatch"], false);
}
