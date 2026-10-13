import { useLayoutEffect, useRef, useState } from "react";

interface ResultPanelProps {
  reply?: string;
  outcome?: string;
  error?: string;
}

export function ResultPanel({ reply, outcome, error }: ResultPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const copyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const copy = copyRef.current;
    if (!copy) return;
    const updateExpansion = () => {
      if (expanded) {
        setCanExpand(true);
        return;
      }
      setCanExpand(copy.scrollHeight > copy.clientHeight + 1);
    };
    updateExpansion();
    window.addEventListener("resize", updateExpansion);
    return () => window.removeEventListener("resize", updateExpansion);
  }, [expanded, reply]);

  const hasReply = Boolean(reply?.trim());
  if (!hasReply && !outcome) return null;
  const outcomeLabel = outcome === "succeeded" ? "已完成"
    : outcome === "failed" ? "未完成"
      : outcome === "cancelled" ? "已停止"
        : outcome === "budget_exhausted" ? "已达到本次限制"
          : outcome === "outcome_unknown" ? "结果待确认" : "结果待核实";
  const emptyResultMessage = outcome === "failed" ? "任务没有完成。"
    : outcome === "cancelled" ? "任务已停止。"
      : outcome === "budget_exhausted" ? "任务未完成：已达到本次任务限制。"
        : outcome === "outcome_unknown" ? "还不能确认任务是否完成。"
          : outcome === "succeeded" ? "任务已完成，但电脑没有返回文字结果。"
            : "还不能确认任务是否完成。";
  return (
    <section className="result-panel" aria-labelledby="result-heading">
      {hasReply && <div className="section-kicker">电脑返回的内容</div>}
      <div className="result-heading-row">
        <h2 id="result-heading">任务结果</h2>
        <span className={`outcome-label outcome-${outcome ?? "unknown"}`}>{outcomeLabel}</span>
      </div>
      {hasReply
        ? <div id="run-result-copy" ref={copyRef} className={`result-copy${expanded ? " result-copy-expanded" : ""}`}>
          <p>{reply}</p>
        </div>
        : <p className="result-empty-message">{emptyResultMessage}</p>}
      {!hasReply && error?.trim() && (
        <details className="result-error-details">
          <summary>查看原因</summary>
          <p>{error}</p>
        </details>
      )}
      {hasReply && canExpand && (
        <button
          className="text-button"
          type="button"
          aria-expanded={expanded}
          aria-controls="run-result-copy"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起结果" : "查看完整结果"}
        </button>
      )}
    </section>
  );
}
