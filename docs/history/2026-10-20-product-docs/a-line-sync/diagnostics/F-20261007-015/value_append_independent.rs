//! Pure std independent tests; no Windows, COM, GUI, or service imports.
use super::*;
use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[test]
fn read_error_has_one_read_zero_write_zero_fallback() {
    let reads=Cell::new(0); let writes=Cell::new(0);
    let out=append_value(PatternStatus::Supported,"suffix",||{reads.set(reads.get()+1);Err(())},|_|{writes.set(writes.get()+1);Ok(())});
    assert_eq!(reads.get(),1); assert_eq!(writes.get(),0); assert_eq!(route_worker(Ok(out)),AppendRoute::RefuseNoInput);
}
#[test]
fn true_empty_old_value_is_not_read_failure() {
    let seen=RefCell::new(Vec::new());
    let out=append_value(PatternStatus::Supported,"中文\n",||Ok(String::new()),|v|{seen.borrow_mut().push(v.to_owned());Ok(())});
    assert_eq!(*seen.borrow(),vec!["中文\n"]); assert_eq!(route_worker(Ok(out)),AppendRoute::VerifyWritten{before:String::new(),expected:"中文\n".into()});
}
#[test]
fn unicode_crlf_and_existing_content_are_byte_exactly_preserved() {
    let old="已有中文\r\n😀e\u{301}"; let suffix="\n追加𠮷\r\n"; let seen=RefCell::new(Vec::new());
    let out=append_value(PatternStatus::Supported,suffix,||Ok(old.into()),|v|{seen.borrow_mut().push(v.as_bytes().to_vec());Ok(())});
    assert_eq!(*seen.borrow(),vec![format!("{old}{suffix}").into_bytes()]); assert_eq!(route_worker(Ok(out)),AppendRoute::VerifyWritten{before:old.into(),expected:format!("{old}{suffix}")});
}
#[test]
fn write_failure_is_single_attempt_and_unknown_not_fallback() {
    let count=Cell::new(0); let out=append_value(PatternStatus::Supported,"追加",||Ok("原文".into()),|v|{assert_eq!(v,"原文追加");count.set(count.get()+1);Err(())});
    assert_eq!(count.get(),1); assert_eq!(route_worker(Ok(out)),AppendRoute::WriteUnknown);
}
#[test]
fn explicit_unsupported_skips_transaction_and_routes_only_one_original_fallback() {
    let out=append_value(PatternStatus::Unsupported,"x",||panic!("read forbidden"),|_|panic!("write forbidden"));
    let fallback=Cell::new(0); if route_worker(Ok(out))==AppendRoute::FallbackOnce { fallback.set(fallback.get()+1); }
    assert_eq!(fallback.get(),1);
}
#[test]
fn unavailable_target_skips_transaction_and_refuses_fallback() {
    let out=append_value(PatternStatus::Unavailable,"x",||panic!("read forbidden"),|_|panic!("write forbidden")); assert_eq!(route_worker(Ok(out)),AppendRoute::RefuseNoInput);
}
#[test]
fn only_direct_not_supported_hresult_enables_fallback() {
    assert_eq!(route_worker(Ok(pattern_failure(0x80040204u32 as i32,true))),AppendRoute::FallbackOnce);
    assert_eq!(route_worker(Ok(pattern_failure(0x80040204u32 as i32,false))),AppendRoute::RefuseNoInput);
}
#[test]
fn stale_timeout_null_cast_and_generic_hresult_never_enable_fallback() {
    for code in [0,1,-1,0x80004002u32 as i32,0x80004003u32 as i32,0x80004005u32 as i32,0x80040200u32 as i32,0x80040201u32 as i32,0x80131505u32 as i32,0x80131509u32 as i32] {
        for direct in [false,true] { assert_eq!(route_worker(Ok(pattern_failure(code,direct))),AppendRoute::RefuseNoInput); }
    }
}
#[test]
fn worker_error_or_cancellation_is_unknown_not_no_input_or_retry() {
    assert_eq!(route_worker(Err(())),AppendRoute::WriteUnknown);
}
#[test]
fn read_panic_locks_unknown_and_never_calls_write() {
    let writes=Cell::new(0); let result=catch_unwind(AssertUnwindSafe(||append_value(PatternStatus::Supported,"x",||panic!("fake read panic"),|_|{writes.set(1);Ok(())})));
    assert_eq!(writes.get(),0); assert_eq!(route_worker(result.map_err(|_|())),AppendRoute::WriteUnknown);
}
#[test]
fn write_panic_after_attempt_locks_unknown_and_cannot_replay() {
    let writes=Cell::new(0); let result=catch_unwind(AssertUnwindSafe(||append_value(PatternStatus::Supported,"x",||Ok("old".into()),|_|{writes.set(writes.get()+1);panic!("fake write panic")})));
    assert_eq!(writes.get(),1); assert_eq!(route_worker(result.map_err(|_|())),AppendRoute::WriteUnknown);
}
#[test]
fn written_route_retains_both_values_and_is_not_fallback() {
    let route=route_worker(Ok(AppendOutcome::Written{before:"old".into(),expected:"oldnew".into()}));
    assert_eq!(route,AppendRoute::VerifyWritten{before:"old".into(),expected:"oldnew".into()}); assert_ne!(route,AppendRoute::FallbackOnce);
}
#[test]
fn all_nonwritten_outcomes_have_conservative_routes() {
    assert_eq!(route_worker(Ok(AppendOutcome::PatternUnavailableNoInput)),AppendRoute::RefuseNoInput);
    assert_eq!(route_worker(Ok(AppendOutcome::ReadFailedNoInput)),AppendRoute::RefuseNoInput);
    assert_eq!(route_worker(Ok(AppendOutcome::WriteAttemptedUnknown)),AppendRoute::WriteUnknown);
}
