import { useEffect, useRef, useState } from "react";

interface StopRunControlProps {
  disabled: boolean;
  onConfirm: () => Promise<void>;
}

// Mount with the Run ID as its key so a confirmation cannot follow navigation.
export function StopRunControl({ disabled, onConfirm }: StopRunControlProps) {
  const [asking, setAsking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const stopRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const busy = disabled || submitting;

  useEffect(() => {
    if (busy) return;
    if (asking) cancelRef.current?.focus();
    else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      if (document.activeElement === document.body) stopRef.current?.focus();
    }
  }, [asking, busy]);

  useEffect(() => {
    const onBlur = () => { restoreFocusRef.current = false; };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  function cancel() {
    if (submittingRef.current) return;
    restoreFocusRef.current = confirmationRef.current?.contains(document.activeElement) === true;
    setAsking(false);
  }

  async function confirm() {
    if (disabled || submittingRef.current) return;
    submittingRef.current = true;
    restoreFocusRef.current = confirmationRef.current?.contains(document.activeElement) === true;
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      setAsking(false);
    }
  }

  return (
    <>
      <button ref={stopRef} className="button button-danger-outline button-large" type="button" disabled={busy} aria-expanded={asking} onClick={() => setAsking(true)}>停止任务</button>
      {asking && (
        <div ref={confirmationRef} className="notice notice-warning" role="group" aria-label="确认停止任务">
          <p>停止当前任务？已经完成的电脑操作无法撤销。任务仍会继续执行，直到电脑收到停止请求。</p>
          <div className="control-actions">
            <button ref={cancelRef} className="button button-secondary" type="button" disabled={busy} onClick={cancel}>取消</button>
            <button className="button button-danger-outline" type="button" disabled={busy} onClick={() => void confirm()}>确认停止</button>
          </div>
        </div>
      )}
    </>
  );
}
