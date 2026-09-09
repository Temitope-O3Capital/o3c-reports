/* eslint-disable react-refresh/only-export-components -- methodLabel/attemptsReconciliation are small helpers tightly coupled to the two components below; splitting only trades a Fast Refresh nicety (dev-only) for extra module indirection. */
import { CheckCircle2, AlertTriangle } from "lucide-react";

// Extraction confidence is a separate signal from auth_risk_score —
// that's about whether the document was tampered with; this is about
// whether the cashflow numbers behind it were reliably extracted at all.
const METHOD_LABELS: Record<string, string> = {
  claude_llm: "Claude extraction",
  generic_pdf: "generic fallback",
  csv: "CSV import",
  xlsx: "spreadsheet import",
  mono: "Mono open banking",
};

export function methodLabel(method?: string | null): string {
  if (!method) return "extraction";
  if (METHOD_LABELS[method]) return METHOD_LABELS[method];
  if (method.startsWith("dedicated_")) return `${method.replace("dedicated_", "").replace(/_/g, " ")} parser`;
  return method.replace(/_/g, " ");
}

// CSV/XLSX/Mono never attempt balance reconciliation — golden_rule_passed is
// hardcoded false there regardless of data quality, so it carries no signal
// for those methods.
const RECONCILIATION_METHODS = new Set(["claude_llm", "generic_pdf"]);
export function attemptsReconciliation(method: string): boolean {
  return RECONCILIATION_METHODS.has(method) || method.startsWith("dedicated_");
}

export function ExtractionConfidenceLine({
  result,
}: {
  result: { parser_method?: string | null; golden_rule_passed?: boolean | null };
}) {
  if (!result.parser_method) return null;
  const label = methodLabel(result.parser_method);
  if (!attemptsReconciliation(result.parser_method)) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, font: "500 11.5px/1.4 var(--font)", color: "var(--ink-faint)" }}>
        Source: {label}
      </div>
    );
  }
  if (result.golden_rule_passed) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, font: "500 11.5px/1.4 var(--font)", color: "var(--good)" }}>
        <CheckCircle2 size={12} /> Balance reconciled · {label}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, font: "500 11.5px/1.4 var(--font)", color: "var(--warn)" }}>
      <AlertTriangle size={12} /> Unverified extraction · {label} · balance not reconciled — review manually
    </div>
  );
}

// Single-line tamper-risk signal for a previously-scored/persisted statement
// (no loading/error states — the parse already happened).
export function TamperRiskLine({ riskScore, flags }: { riskScore?: number | null; flags?: string[] }) {
  if (riskScore == null) return null;
  const pctLabel = `${(riskScore * 100).toFixed(0)}%`;
  if (riskScore < 0.40) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, font: "500 11.5px/1.4 var(--font)", color: "var(--good)" }}>
        <CheckCircle2 size={12} /> Tamper check passed · risk {pctLabel}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, font: "500 11.5px/1.4 var(--font)", color: "var(--warn)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <AlertTriangle size={12} /> Tamper risk flagged · {pctLabel}
      </div>
      {flags && flags.length > 0 && (
        <div style={{ color: "var(--ink-faint)", paddingLeft: 18 }}>{flags.join(" · ")}</div>
      )}
    </div>
  );
}
