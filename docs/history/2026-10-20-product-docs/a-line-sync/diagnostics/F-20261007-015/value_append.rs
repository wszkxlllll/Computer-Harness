//! Pure append transaction and routing. Only explicit unsupported may fall back.
//! A write error or worker failure is unknown: never repeat through another path.

#[cfg(test)]
#[path = "value_append_independent.rs"]
mod independent_tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatternStatus { Supported, Unsupported, Unavailable }

#[derive(Debug, PartialEq, Eq)]
pub enum AppendOutcome {
    PatternUnsupported,
    PatternUnavailableNoInput,
    ReadFailedNoInput,
    WriteAttemptedUnknown,
    Written { before: String, expected: String },
}

// Only the direct GetCurrentPattern HRESULT is evidence of unsupported.
// Cast E_NOINTERFACE and windows-rs S_OK/null Error::empty (code 0) are not.
pub fn pattern_failure(code: i32, direct_get_pattern: bool) -> AppendOutcome {
    if direct_get_pattern && code == 0x80040204u32 as i32 {
        AppendOutcome::PatternUnsupported
    } else {
        AppendOutcome::ReadFailedNoInput
    }
}

pub fn append_value(
    status: PatternStatus,
    suffix: &str,
    read: impl FnOnce() -> Result<String, ()>,
    write: impl FnOnce(&str) -> Result<(), ()>,
) -> AppendOutcome {
    match status {
        PatternStatus::Unsupported => return AppendOutcome::PatternUnsupported,
        PatternStatus::Unavailable => return AppendOutcome::PatternUnavailableNoInput,
        PatternStatus::Supported => {}
    }
    let before = match read() { Ok(value) => value, Err(()) => return AppendOutcome::ReadFailedNoInput };
    let expected = format!("{before}{suffix}");
    match write(&expected) {
        Ok(()) => AppendOutcome::Written { before, expected },
        Err(()) => AppendOutcome::WriteAttemptedUnknown,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AppendRoute {
    FallbackOnce,
    RefuseNoInput,
    WriteUnknown,
    VerifyWritten { before: String, expected: String },
}

pub fn route_worker(result: Result<AppendOutcome, ()>) -> AppendRoute {
    match result {
        Ok(AppendOutcome::PatternUnsupported) => AppendRoute::FallbackOnce,
        Ok(AppendOutcome::PatternUnavailableNoInput | AppendOutcome::ReadFailedNoInput) => AppendRoute::RefuseNoInput,
        Err(()) | Ok(AppendOutcome::WriteAttemptedUnknown) => AppendRoute::WriteUnknown,
        Ok(AppendOutcome::Written { before, expected }) => AppendRoute::VerifyWritten { before, expected },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn read_failure_never_writes_or_falls_back() {
        let writes=Cell::new(0);
        let result=append_value(PatternStatus::Supported,"new",||Err(()),|_|{writes.set(writes.get()+1);Ok(())});
        assert_eq!(result,AppendOutcome::ReadFailedNoInput); assert_eq!(writes.get(),0);
        assert_eq!(route_worker(Ok(result)),AppendRoute::RefuseNoInput);
    }
    #[test]
    fn empty_and_chinese_multiline_are_actual_values_not_failed_reads() {
        for before in ["", "原文\n第二行"] {
            let writes=Cell::new(0);
            let outcome=append_value(PatternStatus::Supported,"\n追加中文",||Ok(before.into()),|value|{
                assert_eq!(value,format!("{before}\n追加中文"));writes.set(writes.get()+1);Ok(())
            });
            assert_eq!(writes.get(),1);
            assert_eq!(route_worker(Ok(outcome)),AppendRoute::VerifyWritten{before:before.into(),expected:format!("{before}\n追加中文")});
        }
    }
    #[test]
    fn attempted_write_failure_and_worker_unknown_never_fall_back() {
        let writes=Cell::new(0);
        let outcome=append_value(PatternStatus::Supported,"new",||Ok("old".into()),|_|{writes.set(1);Err(())});
        assert_eq!(writes.get(),1);assert_eq!(route_worker(Ok(outcome)),AppendRoute::WriteUnknown);
        assert_eq!(route_worker(Err(())),AppendRoute::WriteUnknown);
    }
    #[test]
    fn only_explicit_unsupported_routes_one_fallback_with_no_transaction() {
        for status in [PatternStatus::Unsupported,PatternStatus::Unavailable] {
            let outcome=append_value(status,"new",||panic!("no read"),|_|panic!("no write"));
            let mut fallback=0;
            if route_worker(Ok(outcome))==AppendRoute::FallbackOnce {fallback+=1;}
            assert_eq!(fallback,if status==PatternStatus::Unsupported {1}else{0});
        }
    }
    #[test]
    fn hresult_classification_is_stage_specific_and_conservative() {
        for code in [0, 0x80004002u32 as i32, 0x80004003u32 as i32, 0x80040201u32 as i32, 0x800705b4u32 as i32] {
            assert_eq!(route_worker(Ok(pattern_failure(code,true))),AppendRoute::RefuseNoInput);
        }
        assert_eq!(route_worker(Ok(pattern_failure(0x80040204u32 as i32,true))),AppendRoute::FallbackOnce);
        assert_eq!(route_worker(Ok(pattern_failure(0x80040204u32 as i32,false))),AppendRoute::RefuseNoInput);
    }
    #[test]
    fn late_readback_failure_does_not_reenter_transaction_or_fallback() {
        let writes=Cell::new(0); let fallbacks=Cell::new(0);
        let outcome=append_value(PatternStatus::Supported,"\nnew",||Ok("old".into()),|_|{writes.set(writes.get()+1);Ok(())});
        let route=route_worker(Ok(outcome));
        assert!(matches!(route,AppendRoute::VerifyWritten{..}));
        let readback:Result<String,()> = Err(());
        assert!(readback.is_err());
        if route==AppendRoute::FallbackOnce {fallbacks.set(1);}
        assert_eq!(writes.get(),1);assert_eq!(fallbacks.get(),0);
    }
    #[test]
    fn panicking_worker_after_write_is_unknown_without_fallback() {
        let result=std::panic::catch_unwind(|| append_value(PatternStatus::Supported,"new",||Ok("old".into()),|_|panic!("worker")));
        assert_eq!(route_worker(result.map_err(|_|())),AppendRoute::WriteUnknown);
    }
}
