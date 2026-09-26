import { useLayoutEffect, useRef, useState } from "react";

interface ResultPanelProps {
  reply?: string;
  outcome?: string;
}

export function ResultPanel({ reply, outcome }: ResultPanelProps) {
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

  if (!reply) return null;

  const outcomeLabel = outcome === "succeeded" ? "已完成" : outcome === "failed" ? "未完成" : "结果待核实";
  return (
    <section className="result-panel" aria-labelledby="result-heading">
      <div className="section-kicker">电脑返回的内容</div>
      <div className="result-heading-row">
        <h2 id="result-heading">任务结果</h2>
        <span className={`outcome-label outcome-${outcome ?? "unknown"}`}>{outcomeLabel}</span>
      </div>
      <div ref={copyRef} className={`result-copy${expanded ? " result-copy-expanded" : ""}`}>
        <p>{reply}</p>
      </div>
      {canExpand && (
        <button
          className="text-button"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起结果" : "查看完整结果"}
        </button>
      )}
    </section>
  );
}
