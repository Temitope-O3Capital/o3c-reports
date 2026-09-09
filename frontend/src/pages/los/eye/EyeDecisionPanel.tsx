/* eslint-disable react-refresh/only-export-components -- OUTCOME_TONE is a small, tightly-coupled lookup for this component; splitting only trades a Fast Refresh nicety (dev-only) for extra module indirection. */
import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  AlertTriangle, CheckCircle2, Gauge, XCircle,
  FileText, Landmark, Zap, CheckCircle, TrendingUp, TrendingDown,
  ShieldAlert, Activity, Clock, Minus, Printer, RefreshCw, Send, Shield, Tag,
  Wallet, CornerDownRight, Building2, FlaskConical,
} from "lucide-react";
import { toast } from "sonner";
import { Modal, FieldLabel } from "./vendor/Modal";
import { EmptyState } from "./vendor/EmptyState";
import { SkeletonText } from "./vendor/Loading";
import BankLogo, { getBankName } from "./vendor/banks/BankLogo";
import { ScoreGauge } from "./vendor/ScoreGauge";
import { HoverHint } from "./vendor/HoverHint";
import { ExtractionConfidenceLine, TamperRiskLine } from "./vendor/ExtractionConfidenceLine";
import { featureExplanation, displayMetricValue } from "./vendor/featureExplanations";
import { formatMoney } from "./vendor/format";
import { getScores, sendDecisionReport, overrideDecision, rescoreDecision, recordOutcome } from "./eyeActions";
import type { EyeDecisionDetail, EyeDecisionStatement, EyeScoreItem, FeatureContribution, SendDecisionBody, ShadowScoreResult } from "./eyeActions";
import { useDecisionExplain, useShadowScore, useRecordDecisionExport } from "./eyeActions";
import type { DecisionOutcome } from "./eyeTypes";
import { exportCreditDecisionReport } from "./eyeActions";

export const OUTCOME_TONE: Record<DecisionOutcome, string> = {
  APPROVE: "good", DECLINE: "bad", REFER: "warn", REQUEST_MORE_INFORMATION: "warn", ERROR: "bad",
};

type Tab = "summary" | "risk" | "bureau" | "statement" | "limit" | "ews" | "policy";
type EwsSignal = {
  id: string; title: string; description: string;
  severity: "High" | "Medium" | "Low"; status: "Pending" | "Open";
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(v: number | null | undefined, d = 1) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(d)}%`;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v.replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}
function text(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function cleanKey(k: string) { return k.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function deepFind(root: unknown, keys: string[], depth = 0): unknown {
  if (root == null || depth > 10) return undefined;
  const wanted = new Set(keys.map(cleanKey));
  if (Array.isArray(root)) { for (const item of root) { const f = deepFind(item, keys, depth + 1); if (f != null) return f; } return undefined; }
  if (typeof root !== "object") return undefined;
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) { if (wanted.has(cleanKey(k)) && v != null && v !== "") return v; }
  for (const v of Object.values(root as Record<string, unknown>)) { const f = deepFind(v, keys, depth + 1); if (f != null) return f; }
  return undefined;
}
function formatDate(v?: string | null) {
  if (!v) return "—";
  const d = new Date(v); if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric" });
}
function formatDateTime(v?: string | null) {
  if (!v) return "—";
  const d = new Date(v); if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-NG", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function titleCase(s: string) { return s.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function displaySource(s: string | null | undefined) { return s ? titleCase(s) : "—"; }
function hardGateDisplay(scoring: EyeDecisionDetail["scoring_record"] | null | undefined) {
  if (!scoring?.hard_gate_triggered) return null;
  return scoring.hard_gate_label ?? scoring.hard_gate_reason ?? "Policy gate triggered";
}
function relativeDate(v: string | null | undefined) {
  if (!v) return "Not pulled";
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
  return d === 0 ? "Today" : d === 1 ? "Yesterday" : `${d}d ago`;
}
function contributionTone(f: FeatureContribution): "positive" | "negative" {
  return f.points >= 0 || f.direction === "positive" ? "positive" : "negative";
}
// A decision's reasons are, by definition, the reasons *for that outcome* —
// every reason on an APPROVE decision is a positive factor, every reason on a
// DECLINE is a negative one, even when the wording itself contains a
// risk-sounding word ("credit risk acceptable" contains "risk", but is the
// opposite of a risk flag). Keyword-matching the text alone got this backwards
// for exactly that phrase. REFER/REQUEST_MORE_INFORMATION reasons are the one
// case genuinely mixed rather than uniformly for/against, so those still fall
// back to the keyword heuristic.
export function reasonTone(r: string, outcome?: DecisionOutcome): "pos" | "neg" {
  if (outcome === "APPROVE") return "pos";
  if (outcome === "DECLINE") return "neg";
  return /thin|dti|declin|risk|adverse|overdue|default/i.test(r) ? "neg" : "pos";
}
function ageFromDOB(v: string | null | undefined): number | null {
  if (!v) return null;
  const d = new Date(v); if (isNaN(d.getTime())) return null;
  const t = new Date(); let age = t.getFullYear() - d.getFullYear();
  if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) age--;
  return age;
}
function parseProviderDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const trimmed = v.trim();
  // Every Nigerian bureau (CRC, XDS, FirstCentral) reports purely-numeric
  // dates day-first (DD-MM-YYYY / DD/MM/YYYY). A plain `new Date(v)` silently
  // parses that as the US month-first convention whenever the day is <=12
  // (so ambiguous with a month) — e.g. "07-08-2017" (7 Aug 2017) came back
  // as 7 Jul 2017, silently wrong rather than throwing — so this day-first
  // reading must be tried FIRST, not as a fallback after a native parse that
  // "succeeds" with the wrong date. Dates where the day is >12 happened to
  // still come out right (unambiguous), which is what made this look like a
  // sort inconsistency rather than a parsing bug: with a large facility
  // history, roughly the 1st-12th of every month silently landed on the
  // wrong date while the 13th-31st didn't.
  const numeric = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (numeric) {
    const [, day, month, year] = numeric;
    const d = new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
    if (!isNaN(d.getTime())) return d;
  }
  // Anything else — ISO ("2024-06-06"), textual-month ("06-Jun-2024") — is
  // unambiguous and native Date() already parses it correctly.
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d;
  return null;
}
function facilityOpenedAt(f: Record<string, unknown>): Date | null {
  return parseProviderDate(text(deepFind(f, ["date_opened", "opened_at", "opened_date", "start_date", "facility_date"])));
}
function facilityClosedAt(f: Record<string, unknown>): Date | null {
  return parseProviderDate(text(deepFind(f, ["closed_date", "closed_at", "closure_date", "date_closed", "end_date"])));
}
function facilitySchedule(f: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(f.repayment_schedule ?? f.payment_schedule ?? f.payments).map(asRecord);
}
function facilityPaymentRate(f: Record<string, unknown>) {
  const schedule = facilitySchedule(f);
  const paidCount = schedule.filter(s => ["paid", "ok"].includes(String(s.status ?? "").toLowerCase())).length;
  const totalCount = schedule.filter(s => { const st = String(s.status ?? "").toLowerCase(); return st !== "nd" && st !== "pending"; }).length;
  const rate = totalCount > 0 ? Math.round((paidCount / totalCount) * 100) : null;
  return { paidCount, totalCount, rate };
}
function facilityActualStatus(f: Record<string, unknown>): "Active" | "Delinquent" | "Closed" {
  const status = (text(f.status ?? f.loan_status) ?? "").toLowerCase();
  const performance = (text(f.performance_status) ?? "").toLowerCase();
  const isClosed = status.includes("close") || !!facilityClosedAt(f);
  const isNpa = /non.performing|substandard|doubtful|lost|delinquent|default/.test(performance);
  const { rate, totalCount } = facilityPaymentRate(f);
  const fullyRepaid = rate === 100 && totalCount > 0;
  if (isNpa) return "Delinquent";
  if (isClosed || fullyRepaid) return "Closed";
  return "Active";
}
function facilityOutstanding(f: Record<string, unknown>): number {
  return num(f.current_balance ?? f.actual_account_balance ?? f.account_balance ?? f.outstanding ?? f.outstanding_balance ?? f.balance) ?? 0;
}
// Bureau amounts (CRC / XDS) are in naira, not kobo — use this instead of formatMoney.
function bureauMoney(v: unknown, currency: string): string {
  const n = num(v);
  return n != null ? new Intl.NumberFormat("en-NG", { style: "currency", currency, maximumFractionDigits: 0 }).format(n) : "—";
}
function pickName(obj: Record<string, unknown>): string | undefined {
  return text(deepFind(obj, ["full_name","customer_name","name","applicant_name","surname_and_forenames"]));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Chip({ label, tone = "neutral" }: { label: string; tone?: "success" | "danger" | "warn" | "info" | "neutral" }) {
  const bg = tone === "success" ? "var(--good-wash)" : tone === "danger" ? "var(--bad-wash)" : tone === "warn" ? "var(--warn-wash)" : tone === "info" ? "var(--accent-wash)" : "var(--rule-soft)";
  const color = tone === "success" ? "var(--good)" : tone === "danger" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : tone === "info" ? "var(--accent-ink)" : "var(--ink-soft)";
  return <span style={{ padding: "3px 8px", borderRadius: "var(--r-pill)", background: bg, color, font: "650 11px/1 var(--font)", whiteSpace: "nowrap", flexShrink: 0 }}>{label}</span>;
}

function Kicker({ children }: { children: ReactNode }) {
  return <div style={{ font: "650 10px/1 var(--font)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent-ink)", marginBottom: 14 }}>{children}</div>;
}

function Card({ children, style, noPad }: { children: ReactNode; style?: React.CSSProperties; noPad?: boolean }) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-sm)", overflow: "hidden", ...(noPad ? {} : { padding: "18px 20px" }), position: "relative", ...style }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, var(--accent-2) 0%, transparent 60%)" }} />
      {children}
    </div>
  );
}

function MetricCard({ label, value, valueColor, sub }: { label: string; value: string; valueColor?: string; sub?: string }) {
  return (
    <div style={{ padding: "14px 16px", borderRadius: "var(--r-lg)", background: "var(--panel)", boxShadow: "var(--shadow-sm)", border: "1px solid var(--rule)", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, var(--accent-2), transparent)" }} />
      <div style={{ font: "650 10px/1 var(--font)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent-ink)", marginBottom: 9 }}>{label}</div>
      <div style={{ color: valueColor ?? "var(--ink)", font: "700 22px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ color: "var(--ink-faint)", font: "500 11.5px/1.3 var(--font)", marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, padding: "10px 0", borderBottom: "1px solid var(--rule-soft)" }}>
      <span style={{ flexShrink: 0, color: "var(--ink-faint)", font: "500 12.5px/1.3 var(--font)" }}>{label}</span>
      <span style={{ minWidth: 0, color: "var(--ink)", font: "600 12.5px/1.35 var(--font)", textAlign: "right", overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

const SIZE_BUCKET_LABELS: Record<string, string> = {
  "<10000": "Under ₦10K",
  "10000-100000": "₦10K–100K",
  "100000-500000": "₦100K–500K",
  "500000-1000000": "₦500K–1M",
  ">1000000": "Over ₦1M",
};
const SIZE_BUCKET_ORDER = ["<10000", "10000-100000", "100000-500000", "500000-1000000", ">1000000"];

// Converts one of Periculum's plain-naira-float fields to minor units (kobo)
// so it can go through the same formatMoney() path as our own fields.
function periculumMinor(value: unknown): number | undefined {
  const n = num(value);
  return n == null ? undefined : Math.round(n * 100);
}

// Small "also seen by Periculum" annotation shown inside an existing tile —
// this is the unification: one tile, one metric, both providers' numbers
// side by side, instead of two separate panels repeating the same ground.
function PericulumAside({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--rule)", display: "flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ font: "700 9px/1 var(--font)", letterSpacing: "0.04em", padding: "2px 5px", borderRadius: 4, background: "var(--accent-2)", color: "#fff" }}>P</span>
      <span style={{ font: "600 11px/1.4 var(--font)", color: "var(--ink-faint)" }}>{children}</span>
    </div>
  );
}

type CashFlowPoint = { key: string; inflow: number; outflow: number };

function buildCashFlowPoints<K extends string>(inflow: Record<string, unknown>[], outflow: Record<string, unknown>[], keyField: K): CashFlowPoint[] {
  const keyOf = (r: Record<string, unknown>) => text(r[keyField]) ?? "";
  const keys = Array.from(new Set([...inflow.map(keyOf), ...outflow.map(keyOf)])).filter(Boolean).sort();
  return keys.map(k => ({
    key: k,
    inflow: num(inflow.find(r => keyOf(r) === k)?.amount_minor) ?? 0,
    outflow: num(outflow.find(r => keyOf(r) === k)?.amount_minor) ?? 0,
  }));
}

// Purpose-built rather than reusing the shared HoverHint: that component's
// 260ms open delay and plain-string hint are right for text explanations
// elsewhere, but a chart tooltip needs to appear instantly and show
// inflow/outflow as two aligned rows, not one run-on sentence.
function CashFlowBarTooltip({ point, max, currency }: { point: CashFlowPoint; max: number; currency: string }) {
  const [hover, setHover] = useState(false);
  const row = (label: string, value: number, color: string) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: "rgba(255,255,255,0.7)" }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} /> {label}
      </span>
      <span style={{ color: "#fff", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatMoney(value, currency)}</span>
    </div>
  );
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: "relative", flex: 1, display: "flex", alignItems: "flex-end", gap: 1, height: "100%" }}
    >
      <div style={{ flex: 1, height: `${Math.max(4, (point.inflow / max) * 100)}%`, background: "var(--good)", borderRadius: "2px 2px 0 0" }} />
      <div style={{ flex: 1, height: `${Math.max(4, (point.outflow / max) * 100)}%`, background: "var(--ink-faint)", borderRadius: "2px 2px 0 0" }} />
      {hover && (
        <div
          role="tooltip"
          style={{
            position: "absolute", left: "50%", bottom: "calc(100% + 8px)", transform: "translateX(-50%)",
            zIndex: 20, minWidth: 152, padding: "9px 11px", borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.14)", background: "#1F1C19", boxShadow: "0 10px 24px rgba(0,0,0,0.18)",
            pointerEvents: "none", animation: "rise-sm var(--dur-fast) var(--ease) both",
          }}
        >
          <div style={{ color: "#fff", font: "700 11.5px/1 var(--font)", marginBottom: 7 }}>{point.key}</div>
          <div style={{ display: "grid", gap: 4, font: "500 11px/1 var(--font)" }}>
            {row("Inflow", point.inflow, "var(--good)")}
            {row("Outflow", point.outflow, "var(--ink-faint)")}
          </div>
        </div>
      )}
    </div>
  );
}

// Monthly and weekly cash flow used to be two separate, near-identical bar
// charts stacked on top of each other. One chart with a period toggle shows
// the same two series without making the reader compare two different bar
// scales to see the same trend.
function CashFlowTrendChart({ monthlyInflow, monthlyOutflow, weeklyInflow, weeklyOutflow, currency }: {
  monthlyInflow: Record<string, unknown>[]; monthlyOutflow: Record<string, unknown>[];
  weeklyInflow: Record<string, unknown>[]; weeklyOutflow: Record<string, unknown>[];
  currency: string;
}) {
  const monthly = buildCashFlowPoints(monthlyInflow, monthlyOutflow, "month");
  const weekly = buildCashFlowPoints(weeklyInflow, weeklyOutflow, "week");
  const [period, setPeriod] = useState<"month" | "week">(monthly.length > 0 ? "month" : "week");
  if (monthly.length === 0 && weekly.length === 0) return null;

  const points = period === "month" ? monthly : weekly;
  const max = Math.max(1, ...points.flatMap(p => [p.inflow, p.outflow]));

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Cash flow trend
        </div>
        {monthly.length > 0 && weekly.length > 0 && (
          <div style={{ display: "flex", gap: 2, padding: 2, borderRadius: "var(--r-pill)", background: "var(--rule-soft)" }}>
            {(["month", "week"] as const).map(p => (
              <button key={p} onClick={() => setPeriod(p)}
                style={{ padding: "3px 10px", borderRadius: "var(--r-pill)", border: "none", cursor: "pointer",
                  background: period === p ? "var(--accent)" : "transparent",
                  color: period === p ? "#fff" : "var(--ink-faint)", font: "650 10.5px/1 var(--font)", textTransform: "capitalize" }}>
                {p}ly
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 56 }}>
        {points.map(p => (
          <CashFlowBarTooltip key={p.key} point={p} max={max} currency={currency} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, font: "500 11px/1 var(--font)", color: "var(--ink-faint)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--good)" }} /> Inflow
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, font: "500 11px/1 var(--font)", color: "var(--ink-faint)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--ink-faint)" }} /> Outflow
        </span>
      </div>
    </div>
  );
}

function StatementInsightsPanel({ statement, currency, periculum }: { statement: EyeDecisionStatement; currency: string; periculum?: Record<string, any> }) {
  const signals = statement.signals ?? [];
  const spendByCategory = statement.spend_by_category ?? {};
  const categoryEntries = Object.entries(spendByCategory)
    .map(([cat, v]) => ({ cat, total: v?.total_minor ?? 0 }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
  const maxCategoryTotal = Math.max(1, ...categoryEntries.map((c) => c.total));
  const txnDist = statement.transaction_size_distribution ?? {};
  const balDist = statement.balance_size_distribution ?? {};
  const incomeByChannel = statement.income_by_channel ?? {};
  const weeklyInflow = statement.weekly_inflow ?? [];
  const weeklyOutflow = statement.weekly_outflow ?? [];
  const monthlyInflow = statement.monthly_inflow ?? [];
  const monthlyOutflow = statement.monthly_outflow ?? [];
  const selfTransferCount = statement.self_transfer_count ?? 0;

  const hasOtherIncome = statement.has_other_income === true;
  const loanDisbursementCount = statement.loan_disbursement_count ?? 0;
  const loanRepaymentCount = statement.loan_repayment_count ?? 0;
  const mostFrequentCreditCounterparty = statement.most_frequent_credit_counterparty ?? "";
  const mostFrequentDebitCounterparty = statement.most_frequent_debit_counterparty ?? "";
  const mostRecurringExpenseDescription = statement.most_recurring_expense_description ?? "";
  const totalCreditTurnover = statement.total_credit_turnover_minor;

  const hasAnything =
    statement.predicted_average_salary_minor != null ||
    signals.length > 0 ||
    categoryEntries.length > 0 ||
    selfTransferCount > 0 ||
    Object.keys(txnDist).length > 0 ||
    Object.keys(incomeByChannel).length > 0 ||
    weeklyInflow.length > 0 ||
    monthlyInflow.length > 0 ||
    hasOtherIncome ||
    loanDisbursementCount > 0 ||
    loanRepaymentCount > 0 ||
    !!mostFrequentCreditCounterparty ||
    !!mostFrequentDebitCounterparty ||
    !!mostRecurringExpenseDescription ||
    totalCreditTurnover != null;

  if (!hasAnything) return null;

  // Periculum equivalents, mapped onto the same tiles above (see the
  // comparison this was built from: scratchpad/periculum-comparison.html).
  // Naira floats are converted to minor units via periculumMinor() so they
  // go through the same formatMoney() call as our own fields.
  const pIncome = asRecord(periculum?.incomeAnalysis);
  const pCashFlow = asRecord(periculum?.cashFlowAnalysis);
  const pBehavioral = asRecord(periculum?.behavioralAnalysis);
  const pTxnPattern = asRecord(periculum?.transactionPatternAnalysis);
  const pSpend = asRecord(periculum?.spendAnalysis);

  const pPredictedSalary = periculumMinor(pIncome.averagePredictedSalary);
  const pSalaryCount = num(pIncome.numberOfSalaryPayments);

  const pSelfTransferCount = (num(pTxnPattern.noOfSelfTransferInflows) ?? 0) + (num(pTxnPattern.noOfSelfTransferOutflows) ?? 0);
  const pSelfTransferInflow = periculumMinor(pTxnPattern.selfTransferInflowAmount);
  const pSelfTransferOutflow = periculumMinor(pTxnPattern.selfTransferOutflowAmount);

  const pAccountSweep = text(pBehavioral.accountSweep)?.toLowerCase() === "yes";

  const pHasOtherIncome = text(pIncome.hasOtherIncome)?.toLowerCase() === "yes";
  const pOtherIncomeAvg = num(pIncome.averageOtherIncome);
  const pOtherIncomeCount = num(pIncome.numberOfOtherIncomePayments);
  const pOtherIncomeTotal = pOtherIncomeAvg != null && pOtherIncomeCount != null ? Math.round(pOtherIncomeAvg * pOtherIncomeCount * 100) : undefined;

  const pLoanDisbursementCount = num(pBehavioral.numberLoanTransactions);
  const pLoanRepaymentCount = num(pBehavioral.numberRepaymentTransactions);
  const pTotalLoanDisbursement = periculumMinor(pBehavioral.totalLoanAmount);
  const pTotalLoanRepayment = periculumMinor(pBehavioral.totalLoanRepaymentAmount);

  const pMostFrequentCredit = text(pTxnPattern.mostFrequentCreditTransfer);
  const pMostFrequentDebit = text(pTxnPattern.mostFrequentDebitTransfer);

  const pMostRecurringExpenseDesc = text(pSpend.mostRecurringExpense);
  const pTotalRecurringExpense = periculumMinor(pSpend.totalRecurringExpense);

  const pTotalCreditTurnover = periculumMinor(pCashFlow.totalCreditTurnover);
  const pTotalDebitTurnover = periculumMinor(pCashFlow.totalDebitTurnOver);

  // Fields Periculum reports that have no tile of their own on our side —
  // kept as a compact footer rather than dropped, so nothing that was
  // visible before is lost by folding the two panels into one.
  const periculumOnlyRows: { label: string; value: string }[] = [];
  const pNetEarning = periculumMinor(pIncome.netAverageMonthlyEarning);
  if (pNetEarning != null) periculumOnlyRows.push({ label: "Net average monthly earning", value: formatMoney(pNetEarning, currency) });
  if (pCashFlow.numberOfTransactingMonths != null) periculumOnlyRows.push({ label: "Transacting months", value: String(pCashFlow.numberOfTransactingMonths) });
  if (pBehavioral.gamblingStatus) periculumOnlyRows.push({ label: "Gambling status", value: String(pBehavioral.gamblingStatus) });
  if (pBehavioral.accountActivity != null) periculumOnlyRows.push({ label: "Account activity", value: pct(num(pBehavioral.accountActivity)) });
  if (pSpend.mostFrequentSpendCategory) periculumOnlyRows.push({ label: "Most frequent spend category", value: String(pSpend.mostFrequentSpendCategory).replace(/_/g, " ") });
  const pHighestSpend = periculumMinor(pSpend.highestSpend);
  if (pHighestSpend != null && pSpend.monthWithHighestSpend) periculumOnlyRows.push({ label: `Highest-spend month (${pSpend.monthWithHighestSpend})`, value: formatMoney(pHighestSpend, currency) });
  if (periculum?.confidenceOnParsing != null) periculumOnlyRows.push({ label: "Periculum parsing confidence", value: pct(num(periculum.confidenceOnParsing)) });

  return (
    <Card>
      <Kicker>Statement insights</Kicker>
      {periculum && (
        <p style={{ margin: "0 0 16px", color: "var(--ink-faint)", font: "400 12px/1.5 var(--font)" }}>
          Tiles marked <span style={{ font: "700 9px/1 var(--font)", padding: "2px 5px", borderRadius: 4, background: "var(--accent-2)", color: "#fff" }}>P</span> include a Periculum cross-check alongside our own parse.
        </p>
      )}

      {signals.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          {signals.map((s) => (
            <span key={s} style={{ padding: "4px 10px", borderRadius: "var(--r-pill)", background: "var(--paper)", border: "1px solid var(--rule)", font: "600 11px/1 var(--font)", color: "var(--ink-soft)", textTransform: "capitalize" }}>
              {s.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 18 }}>
        {statement.predicted_average_salary_minor != null && (
          <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
              <Wallet size={12} /> Predicted salary
            </div>
            <div style={{ color: "var(--ink)", font: "700 17px/1.2 var(--font-mono)" }}>
              {formatMoney(statement.predicted_average_salary_minor, currency)}
              <span style={{ font: "500 11px/1 var(--font)", color: "var(--ink-faint)" }}>/mo</span>
            </div>
            <div style={{ marginTop: 6, color: "var(--ink-faint)", font: "500 11.5px/1.4 var(--font)" }}>
              {statement.salary_payment_count ?? 0} payment{statement.salary_payment_count === 1 ? "" : "s"}
              {statement.expected_salary_payment_day != null && <> · around day {statement.expected_salary_payment_day}</>}
              {statement.salary_payment_coverage_pct != null && <> · {pct(statement.salary_payment_coverage_pct, 0)} coverage</>}
            </div>
            {pPredictedSalary != null && (
              <PericulumAside>{formatMoney(pPredictedSalary, currency)}/mo · {pSalaryCount ?? 0} payment{pSalaryCount === 1 ? "" : "s"}</PericulumAside>
            )}
          </div>
        )}

        {selfTransferCount > 0 && (
          <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
              <CornerDownRight size={12} /> Self-transfers
            </div>
            <div style={{ color: "var(--ink)", font: "700 17px/1.2 var(--font-mono)" }}>
              {selfTransferCount} txn{selfTransferCount === 1 ? "" : "s"}
            </div>
            <div style={{ marginTop: 6, color: "var(--ink-faint)", font: "500 11.5px/1.4 var(--font)" }}>
              {formatMoney(statement.self_transfer_outflow_minor ?? 0, currency)} out · {formatMoney(statement.self_transfer_inflow_minor ?? 0, currency)} back in
            </div>
            {pSelfTransferCount > 0 && (
              <PericulumAside>{pSelfTransferCount} txns · {formatMoney(pSelfTransferOutflow ?? 0, currency)} out · {formatMoney(pSelfTransferInflow ?? 0, currency)} in</PericulumAside>
            )}
          </div>
        )}

        {statement.account_sweep_detected && (
          <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--warn)", font: "700 12px/1 var(--font)" }}>
              <AlertTriangle size={13} /> Account sweep pattern
            </div>
            <div style={{ marginTop: 6, color: "var(--ink-faint)", font: "500 11.5px/1.4 var(--font)" }}>
              Balance regularly drained to near-zero right after each credit.
            </div>
            {text(pBehavioral.accountSweep) != null && (
              <PericulumAside>{pAccountSweep ? "Agrees — sweep detected" : "Disagrees — no sweep detected"}</PericulumAside>
            )}
          </div>
        )}

        {hasOtherIncome && (
          <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
              <Wallet size={12} /> Other recurring income
            </div>
            <div style={{ color: "var(--ink)", font: "700 17px/1.2 var(--font-mono)" }}>
              {formatMoney(statement.other_income_total_minor ?? 0, currency)}
            </div>
            <div style={{ marginTop: 6, color: "var(--ink-faint)", font: "500 11.5px/1.4 var(--font)" }}>
              A second recurring stream alongside the primary salary · {statement.other_income_count ?? 0} payment{statement.other_income_count === 1 ? "" : "s"}
            </div>
            {(pHasOtherIncome || pOtherIncomeTotal != null) && (
              <PericulumAside>{formatMoney(pOtherIncomeTotal ?? 0, currency)} · {pOtherIncomeCount ?? 0} payment{pOtherIncomeCount === 1 ? "" : "s"}</PericulumAside>
            )}
          </div>
        )}

        {(loanDisbursementCount > 0 || loanRepaymentCount > 0) && (
          <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
              <Landmark size={12} /> Loan activity
            </div>
            <div style={{ color: "var(--ink)", font: "700 17px/1.2 var(--font-mono)" }}>
              {formatMoney(statement.total_loan_repayment_minor ?? 0, currency)} repaid
            </div>
            <div style={{ marginTop: 6, color: "var(--ink-faint)", font: "500 11.5px/1.4 var(--font)" }}>
              {loanDisbursementCount} disbursement{loanDisbursementCount === 1 ? "" : "s"} ({formatMoney(statement.total_loan_disbursement_minor ?? 0, currency)}) · {loanRepaymentCount} repayment{loanRepaymentCount === 1 ? "" : "s"}
            </div>
            {(pTotalLoanDisbursement != null || pTotalLoanRepayment != null) && (
              <PericulumAside>{formatMoney(pTotalLoanRepayment ?? 0, currency)} repaid · {pLoanDisbursementCount ?? 0} disbursement{pLoanDisbursementCount === 1 ? "" : "s"} ({formatMoney(pTotalLoanDisbursement ?? 0, currency)}) · {pLoanRepaymentCount ?? 0} repayment{pLoanRepaymentCount === 1 ? "" : "s"}</PericulumAside>
            )}
          </div>
        )}

        {(mostFrequentCreditCounterparty || mostFrequentDebitCounterparty) && (
          <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
              <Building2 size={12} /> Most frequent counterparty
            </div>
            {mostFrequentCreditCounterparty && (
              <div style={{ color: "var(--ink)", font: "600 12.5px/1.4 var(--font)", overflowWrap: "anywhere" }} title={mostFrequentCreditCounterparty}>
                In: {mostFrequentCreditCounterparty}
              </div>
            )}
            {mostFrequentDebitCounterparty && (
              <div style={{ marginTop: 4, color: "var(--ink-faint)", font: "500 11.5px/1.4 var(--font)", overflowWrap: "anywhere" }} title={mostFrequentDebitCounterparty}>
                Out: {mostFrequentDebitCounterparty}
              </div>
            )}
            {(pMostFrequentCredit || pMostFrequentDebit) && (
              <PericulumAside>In: {pMostFrequentCredit || "—"} · Out: {pMostFrequentDebit || "—"}</PericulumAside>
            )}
          </div>
        )}

        {mostRecurringExpenseDescription && (
          <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
              <Tag size={12} /> Most recurring expense
            </div>
            <div style={{ color: "var(--ink)", font: "700 17px/1.2 var(--font-mono)" }}>
              {formatMoney(statement.total_recurring_expense_minor ?? 0, currency)}
            </div>
            <div style={{ marginTop: 6, color: "var(--ink-faint)", font: "500 11.5px/1.4 var(--font)", overflowWrap: "anywhere" }} title={mostRecurringExpenseDescription}>
              {mostRecurringExpenseDescription}
            </div>
            {pMostRecurringExpenseDesc && (
              <PericulumAside>{formatMoney(pTotalRecurringExpense ?? 0, currency)} · {pMostRecurringExpenseDesc.replace(/_/g, " ")}</PericulumAside>
            )}
          </div>
        )}

        {totalCreditTurnover != null && (
          <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
              <TrendingUp size={12} /> Lifetime turnover
            </div>
            <div style={{ color: "var(--ink)", font: "700 17px/1.2 var(--font-mono)" }}>
              {formatMoney(totalCreditTurnover, currency)}
            </div>
            <div style={{ marginTop: 6, color: "var(--ink-faint)", font: "500 11.5px/1.4 var(--font)" }}>
              in · {formatMoney(statement.total_debit_turnover_minor ?? 0, currency)} out, across the full statement period
            </div>
            {pTotalCreditTurnover != null && (
              <PericulumAside>{formatMoney(pTotalCreditTurnover, currency)} in · {formatMoney(pTotalDebitTurnover ?? 0, currency)} out</PericulumAside>
            )}
          </div>
        )}
      </div>

      {categoryEntries.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
            Spend by category
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {categoryEntries.map(({ cat, total }) => (
              <div key={cat} style={{ display: "grid", gridTemplateColumns: "130px 1fr auto", alignItems: "center", gap: 10 }}>
                <span style={{ font: "500 12px/1 var(--font)", color: "var(--ink-soft)", textTransform: "capitalize" }}>{cat.replace(/_/g, " ").toLowerCase()}</span>
                <div style={{ height: 6, borderRadius: "var(--r-pill)", background: "var(--rule)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(total / maxCategoryTotal) * 100}%`, background: "var(--accent-2)", borderRadius: "var(--r-pill)" }} />
                </div>
                <span style={{ font: "600 12px/1 var(--font-mono)", color: "var(--ink)", textAlign: "right" }}>{formatMoney(total, currency)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <CashFlowTrendChart monthlyInflow={monthlyInflow} monthlyOutflow={monthlyOutflow} weeklyInflow={weeklyInflow} weeklyOutflow={weeklyOutflow} currency={currency} />

      {(Object.keys(txnDist).length > 0 || Object.keys(balDist).length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 18 }}>
          {Object.keys(txnDist).length > 0 && (
            <div>
              <div style={{ color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
                Transaction size
              </div>
              {SIZE_BUCKET_ORDER.filter((b) => txnDist[b] != null).map((b) => (
                <div key={b} style={{ display: "grid", gridTemplateColumns: "90px 1fr 36px", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ font: "500 11px/1 var(--font)", color: "var(--ink-faint)" }}>{SIZE_BUCKET_LABELS[b] ?? b}</span>
                  <div style={{ height: 5, borderRadius: "var(--r-pill)", background: "var(--rule)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(txnDist[b] ?? 0) * 100}%`, background: "var(--ink-faint)", borderRadius: "var(--r-pill)" }} />
                  </div>
                  <span style={{ font: "600 11px/1 var(--font-mono)", color: "var(--ink-soft)", textAlign: "right" }}>{((txnDist[b] ?? 0) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
          {Object.keys(balDist).length > 0 && (
            <div>
              <div style={{ color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
                Balance distribution
              </div>
              {SIZE_BUCKET_ORDER.filter((b) => balDist[b] != null).map((b) => (
                <div key={b} style={{ display: "grid", gridTemplateColumns: "90px 1fr 36px", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ font: "500 11px/1 var(--font)", color: "var(--ink-faint)" }}>{SIZE_BUCKET_LABELS[b] ?? b}</span>
                  <div style={{ height: 5, borderRadius: "var(--r-pill)", background: "var(--rule)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(balDist[b] ?? 0) * 100}%`, background: "var(--accent-2)", borderRadius: "var(--r-pill)" }} />
                  </div>
                  <span style={{ font: "600 11px/1 var(--font-mono)", color: "var(--ink-soft)", textAlign: "right" }}>{((balDist[b] ?? 0) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {Object.keys(incomeByChannel).length > 0 && (
        <div>
          <div style={{ color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
            Income by channel
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {Object.entries(incomeByChannel).map(([ch, v]) => (
              <div key={ch} style={{ padding: "8px 12px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
                <div style={{ font: "600 11px/1 var(--font)", color: "var(--ink-soft)", textTransform: "capitalize" }}>{ch.replace(/_/g, " ")}</div>
                <div style={{ font: "700 13px/1.4 var(--font-mono)", color: "var(--ink)", marginTop: 2 }}>
                  {formatMoney(v?.total_minor ?? 0, currency)} <span style={{ font: "500 11px/1 var(--font)", color: "var(--ink-faint)" }}>· {v?.count ?? 0}x</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {periculumOnlyRows.length > 0 && (
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--rule)" }}>
          <div style={{ color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
            Also from Periculum
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px 20px" }}>
            {periculumOnlyRows.map((r) => (
              <div key={r.label}>
                <div style={{ font: "500 11px/1.4 var(--font)", color: "var(--ink-faint)" }}>{r.label}</div>
                <div style={{ font: "600 13px/1.4 var(--font)", color: "var(--ink)" }}>{r.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function TonedStat({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const c = tone === "good" ? "var(--good)" : tone === "warn" ? "var(--warn)" : tone === "bad" ? "var(--bad)" : "var(--ink)";
  return (
    <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
      <div style={{ font: "650 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 7 }}>{label}</div>
      <div style={{ font: "700 16px/1 var(--font-mono)", color: c, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function PolicyCheck({ label, value, pass }: { label: string; value: string; pass?: boolean }) {
  const iconBg = pass === true ? "var(--good)" : pass === false ? "var(--bad)" : "var(--paper-deep)";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: "1px solid var(--rule-soft)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 24, height: 24, borderRadius: "50%", background: iconBg, display: "grid", placeItems: "center", flexShrink: 0, boxShadow: pass === true ? "0 2px 6px -2px rgba(34,122,91,0.5)" : pass === false ? "0 2px 6px -2px rgba(176,59,51,0.5)" : "none" }}>
          {pass === true ? <CheckCircle2 size={13} color="#fff" />
            : pass === false ? <XCircle size={13} color="#fff" />
            : <Minus size={12} color="var(--ink-faint)" />}
        </div>
        <span style={{ font: "500 13px/1.3 var(--font)", color: "var(--ink-soft)" }}>{label}</span>
      </div>
      <span style={{ font: "600 12px/1 var(--font-mono)", color: pass === false ? "var(--bad)" : pass === true ? "var(--good)" : "var(--ink-faint)" }}>{value}</span>
    </div>
  );
}

function TimelineItem({ icon, title, body, at, last }: { icon: ReactNode; title: string; body: string; at: string; last?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "32px 1fr auto", gap: 14, paddingBottom: last ? 0 : 22, position: "relative" }}>
      {!last && <div style={{ position: "absolute", left: 15, top: 36, bottom: 6, width: 2, background: "linear-gradient(180deg, var(--rule), transparent)", borderRadius: 2 }} />}
      <div style={{ width: 32, height: 32, borderRadius: "50%", display: "grid", placeItems: "center", background: "var(--accent-wash)", color: "var(--accent-ink)", boxShadow: "0 0 0 4px var(--panel)", zIndex: 1 }}>{icon}</div>
      <div>
        <div style={{ color: "var(--ink)", font: "700 13.5px/1.25 var(--font)" }}>{title}</div>
        <div style={{ color: "var(--ink-faint)", font: "500 12.5px/1.45 var(--font)", marginTop: 4 }}>{body}</div>
      </div>
      <div style={{ color: "var(--ink-faint)", font: "600 12px/1.25 var(--font)", whiteSpace: "nowrap" }}>{at}</div>
    </div>
  );
}

function ContributionBar({ factor, max }: { factor: FeatureContribution; max: number }) {
  const positive = contributionTone(factor) === "positive";
  const halfPct = max > 0 ? Math.min(46, (Math.abs(factor.points) / max) * 46) : 0;
  const displayVal = factor.value || (factor.raw_value != null ? String(displayMetricValue(factor.label, factor.raw_value)) : "—");
  return (
    <HoverHint hint={featureExplanation(factor)} style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) 1fr", gap: 14, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--rule-soft)" }}>
      <div>
        <div style={{ color: "var(--ink)", font: "600 12.5px/1.3 var(--font)" }}>{factor.label}</div>
        <div style={{ color: "var(--ink-faint)", font: "500 11px/1.3 var(--font-mono)", marginTop: 2 }}>{displayVal}</div>
      </div>
      <div style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}>
        <div style={{ position: "absolute", left: "50%", top: 6, bottom: 6, width: 1, background: "var(--rule)" }} />
        {factor.points !== 0 && (
          <div style={{ position: "absolute", left: positive ? "50%" : `calc(50% - ${halfPct}%)`, width: `${halfPct}%`, height: 12, borderRadius: "var(--r-pill)", background: positive ? "var(--good)" : "var(--bad)", opacity: 0.85 }} />
        )}
        <span style={{ position: "absolute", left: positive ? `calc(50% + ${Math.min(halfPct, 44)}% + 4px)` : `calc(50% - ${Math.min(halfPct, 44)}% - 4px)`, transform: positive ? "none" : "translateX(-100%)", font: "650 11px/1 var(--font-mono)", color: factor.points === 0 ? "var(--ink-faint)" : positive ? "var(--good)" : "var(--bad)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {factor.points === 0 ? "0" : `${positive ? "+" : ""}${factor.points.toFixed(0)}`}
        </span>
      </div>
    </HoverHint>
  );
}

function SignalRow({ f, barColor, maxPts }: { f: FeatureContribution; barColor: string; maxPts: number }) {
  const pos = contributionTone(f) === "positive";
  const displayVal = f.value || (f.raw_value != null ? String(displayMetricValue(f.label, f.raw_value)) : "—");
  const barW = maxPts > 0 ? Math.min(100, (Math.abs(f.points) / maxPts) * 100) : 0;
  return (
    <HoverHint hint={featureExplanation(f)} style={{ padding: "9px 0", borderBottom: "1px solid var(--rule-soft)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ color: "var(--ink)", font: "600 12.5px/1.3 var(--font)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.label}>{f.label}</span>
        <span style={{ color: pos ? "var(--good)" : "var(--bad)", font: "700 12px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          {f.points === 0 ? "0" : `${pos ? "+" : ""}${f.points.toFixed(0)}`}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
        <span style={{ color: "var(--ink-faint)", font: "500 11px/1 var(--font-mono)", flexShrink: 0, minWidth: 60 }}>{displayVal}</span>
        <div style={{ flex: 1, height: 4, background: "var(--rule)", borderRadius: "var(--r-pill)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${barW}%`, background: barColor, borderRadius: "var(--r-pill)", transition: "width var(--dur-slow) var(--ease)" }} />
        </div>
      </div>
    </HoverHint>
  );
}

function RiskDistribution({ pd }: { pd?: number | null }) {
  const marker = Math.max(0, Math.min(100, ((pd ?? 0) / 1) * 100));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <Kicker>Risk distribution</Kicker>
        <span style={{ font: "600 12px/1 var(--font-mono)", color: "var(--ink-faint)" }}>PD {pct(pd)}</span>
      </div>
      <div style={{ position: "relative", height: 44 }}>
        <div style={{ display: "grid", gridTemplateColumns: "5% 7% 10% 18% 20% 40%", height: 28, borderRadius: "var(--r-md)", overflow: "hidden", color: "#fff", font: "700 10px/28px var(--font)", textAlign: "center", boxShadow: "var(--shadow-sm)" }}>
          {[["A+", "#227A5B"], ["A", "#2E9E77"], ["B+", "#D6A758"], ["B", "#A8792E"], ["C", "#C94F45"], ["D", "#B03B33"]].map(([l, c]) => (
            <span key={l} style={{ background: c }}>{l}</span>
          ))}
        </div>
        {pd != null && (
          <div style={{ position: "absolute", top: -4, left: `${marker}%`, transform: "translateX(-50%)", width: 3, height: 36, borderRadius: 3, background: "var(--ink)", boxShadow: "0 0 0 2px var(--panel)" }} />
        )}
        <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-faint)", font: "600 10.5px/1 var(--font-mono)", marginTop: 8 }}>
          {["0%", "25%", "50%", "75%", "100%"].map(l => <span key={l}>{l}</span>)}
        </div>
      </div>
    </div>
  );
}

function BureauSelectorCard({ name, score, enq30d, openLoans, defaults, quality, selected, onClick }: {
  name: string; score?: number | null; enq30d?: number | null; openLoans?: number | null; defaults?: number | null;
  quality: "clean" | "has-defaults" | "thin"; selected: boolean; onClick: () => void;
}) {
  const chipTone = quality === "has-defaults" ? "danger" : quality === "clean" ? "success" : "warn";
  const chipLabel = quality === "has-defaults" ? "Has defaults" : quality === "clean" ? "Clean" : "Thin file";
  return (
    <button onClick={onClick} style={{ display: "block", width: "100%", textAlign: "left", border: `2px solid ${selected ? "var(--accent)" : "var(--rule)"}`, borderRadius: "var(--r-lg)", padding: "16px 18px", background: selected ? "var(--accent-wash)" : "var(--panel)", cursor: "pointer", transition: "all var(--dur-fast) var(--ease)", boxShadow: selected ? "var(--shadow-accent)" : "var(--shadow-sm)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <span style={{ font: "700 13.5px/1.3 var(--font)", color: selected ? "var(--accent-ink)" : "var(--ink)" }}>{name}</span>
        <Chip label={chipLabel} tone={chipTone} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        {[
          { label: "Score", value: score != null ? String(score) : "—", danger: false },
          { label: "Enq 30d", value: enq30d != null ? String(enq30d) : "—", danger: false },
          { label: "Open", value: openLoans != null ? String(openLoans) : "—", danger: false },
          { label: "Defaults", value: defaults != null ? String(defaults) : "—", danger: (defaults ?? 0) > 0 },
        ].map(s => (
          <div key={s.label}>
            <div style={{ color: "var(--ink-faint)", font: "600 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{s.label}</div>
            <div style={{ font: "700 20px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: s.danger ? "var(--bad)" : selected ? "var(--accent-ink)" : "var(--ink)" }}>{s.value}</div>
          </div>
        ))}
      </div>
    </button>
  );
}

// ─── PaymentTimeline ─────────────────────────────────────────────────────────

function PaymentTimeline({ schedule }: { schedule: Array<{ month?: string; status: string }> }) {
  const colorOf: Record<string, string> = {
    paid: "#10B981", ok: "#10B981",
    overdue: "#DC2626", missed: "#DC2626",
    late: "#F59E0B",
    pending: "var(--rule)", nd: "var(--rule)",
  };
  const labelOf: Record<string, string> = {
    paid: "Paid", ok: "Paid", overdue: "Overdue", missed: "Missed",
    late: "Late", pending: "Pending", nd: "No data",
  };
  if (!schedule.length) return null;
  const now = new Date();
  const monthLabel = (i: number): string => {
    const raw = schedule[i].month;
    if (raw) {
      const yrMon = raw.match(/^(\d{4})\s+([A-Za-z]{3,})$/);
      if (yrMon) return yrMon[2].charAt(0).toUpperCase() + yrMon[2].slice(1, 3).toLowerCase() + " " + yrMon[1].slice(2);
      if (/[A-Za-z]/.test(raw)) return raw.length > 6 ? raw.slice(0, 6) : raw;
    }
    const monthsBack = schedule.length - 1 - i;
    const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    return d.toLocaleDateString("en-NG", { month: "short", year: "2-digit" });
  };
  return (
    <div style={{ padding: "14px 18px", borderTop: "1px solid var(--rule-soft)", background: "rgba(0,0,0,0.02)" }}>
      <div style={{ font: "700 10px/1 var(--font)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 10 }}>
        Payment history
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {schedule.map((s, i) => {
          const key = (s.status ?? "nd").toLowerCase();
          const color = colorOf[key] ?? colorOf.nd;
          const statusLabel = labelOf[key] ?? s.status;
          const ml = monthLabel(i);
          return (
            <div key={i} title={`${ml} · ${statusLabel}`} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <span style={{ width: 13, height: 13, borderRadius: 3, background: color, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.1)", display: "block" }} />
              <span style={{ font: "500 8px/1 var(--font)", color: "var(--ink-faint)" }}>{ml}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 10, font: "500 11px/1 var(--font)", color: "var(--ink-faint)", flexWrap: "wrap" }}>
        {([["Paid", "#10B981"], ["Late", "#F59E0B"], ["Overdue", "#DC2626"], ["No data", "var(--rule)"]] as [string, string][]).map(([label, c]) => (
          <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: c, display: "block" }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── FacilityCard ─────────────────────────────────────────────────────────────

function FacilityCard({ item, currency, bureauName = "Bureau" }: { item: Record<string, unknown>; currency: string; bureauName?: string }) {
  const [open, setOpen] = useState(false);
  const actualStatus = facilityActualStatus(item);
  const isClosed = actualStatus === "Closed";
  const isNpa = /non.performing|substandard|doubtful|lost/.test((text(item.performance_status) ?? "").toLowerCase());
  const accentColor = isNpa ? "#DC2626" : isClosed ? "var(--good)" : "var(--accent)";
  const schedule = facilitySchedule(item);
  const { paidCount, totalCount, rate } = facilityPaymentRate(item);
  const rateColor = rate == null ? "var(--ink-faint)" : rate >= 90 ? "var(--good)" : rate >= 70 ? "var(--warn)" : "var(--bad)";
  const chipTone: "info" | "danger" | "neutral" = actualStatus === "Active" ? "info" : actualStatus === "Delinquent" ? "danger" : "neutral";
  const outstanding = facilityOutstanding(item);
  const overdue = num(item.overdue_amount ?? item.amount_overdue) ?? 0;
  const daysArrears = num(item.days_in_arrears ?? item.max_overdue_days ?? item.days_past_due) ?? 0;

  return (
    <div style={{ border: "1px solid var(--rule)", borderLeft: `4px solid ${accentColor}`, borderRadius: "var(--r-lg)", background: "var(--panel)", overflow: "hidden" }}>
      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--ink)", font: "600 14px/1.3 var(--font)" }}>
              {text(item.institution ?? item.lender ?? item.bank) ?? "Credit facility"}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
              {text(item.performance_status) && (
                <Chip label={`${bureauName}: ${text(item.performance_status)}`} tone={isNpa ? "danger" : "success"} />
              )}
              <Chip label={`Actual: ${actualStatus}`} tone={chipTone} />
              {text(item.account_type ?? item.type ?? item.facility_type) && (
                <Chip label={text(item.account_type ?? item.type ?? item.facility_type)!} tone="neutral" />
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 7, font: "500 11px/1 var(--font)", color: "var(--ink-faint)" }}>
              {facilityOpenedAt(item) && <span>Opened {formatDate(text(deepFind(item, ["date_opened", "opened_at", "opened_date", "start_date", "facility_date"])))}</span>}
              {facilityClosedAt(item) && <span>Closed {formatDate(text(deepFind(item, ["closed_date", "closed_at", "closure_date", "date_closed", "end_date"])))}</span>}
              {rate != null && <span style={{ color: rateColor, fontWeight: 600 }}>{paidCount}/{totalCount} payments · {rate}%</span>}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ color: "var(--ink)", font: "700 16px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
              {outstanding > 0 ? bureauMoney(outstanding, currency) : "—"}
            </div>
            {overdue > 0 && (
              <div style={{ color: "var(--bad)", font: "600 11px/1.4 var(--font)", marginTop: 3 }}>
                {bureauMoney(overdue, currency)} overdue
              </div>
            )}
            {daysArrears > 0 && (
              <div style={{ color: "var(--bad)", font: "600 11px/1.4 var(--font)", marginTop: 2 }}>
                {daysArrears}d in arrears
              </div>
            )}
            {schedule.length > 0 && (
              <button onClick={() => setOpen(!open)} style={{ marginTop: 7, border: "1px solid var(--rule)", color: "var(--accent)", background: "transparent", borderRadius: 4, padding: "3px 8px", font: "600 11px/1 var(--font)", cursor: "pointer" }}>
                {open ? "▲ Hide" : "▼ Payments"}
              </button>
            )}
          </div>
        </div>
      </div>
      {open && schedule.length > 0 && (
        <PaymentTimeline schedule={schedule.map(s => ({ month: text(s.month) ?? undefined, status: text(s.status) ?? "nd" }))} />
      )}
    </div>
  );
}

// ─── Action modals ────────────────────────────────────────────────────────────

const CHANNELS = [
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
] as const;

function SendModal({ decisionId, onClose }: { decisionId: string; onClose: () => void }) {
  const [channel, setChannel] = useState<SendDecisionBody["channel"]>("email");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await sendDecisionReport(decisionId, { channel, recipient: recipient.trim() || undefined, message: message.trim() || undefined });
      toast.success("Decision report sent to borrower");
      onClose();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Send failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Send to borrower" subtitle="Deliver the credit decision report directly to the applicant." onClose={onClose}>
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <FieldLabel>Channel</FieldLabel>
          <div style={{ display: "flex", gap: 8 }}>
            {CHANNELS.map(c => (
              <button key={c.value} onClick={() => setChannel(c.value)}
                style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1.5px solid ${channel === c.value ? "var(--accent)" : "var(--rule)"}`, background: channel === c.value ? "var(--accent-wash)" : "var(--panel)", font: `${channel === c.value ? "700" : "500"} 12.5px/1 var(--font)`, color: channel === c.value ? "var(--accent)" : "var(--ink-soft)", cursor: "pointer" }}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <FieldLabel>Recipient {channel === "email" ? "(email address)" : "(phone number)"}</FieldLabel>
          <input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder={channel === "email" ? "applicant@example.com" : "0801 234 5678"} style={{ width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid var(--rule)", background: "var(--paper)", font: "500 13px/1 var(--font)", color: "var(--ink)", boxSizing: "border-box" }} />
        </div>
        <div>
          <FieldLabel>Note to borrower (optional)</FieldLabel>
          <textarea rows={3} value={message} onChange={e => setMessage(e.target.value)} placeholder="Please find attached your credit decision report…" style={{ width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid var(--rule)", background: "var(--paper)", font: "400 13px/1.5 var(--font)", color: "var(--ink)", resize: "vertical", boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? "Sending…" : "Send report"}</button>
        </div>
      </div>
    </Modal>
  );
}

function OverrideModal({ decisionId, currentOutcome, onClose, onDone }: { decisionId: string; currentOutcome: string; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState<"APPROVE" | "DECLINE" | "REFER">(
    currentOutcome === "APPROVE" ? "APPROVE" : currentOutcome === "DECLINE" ? "DECLINE" : "REFER"
  );
  const [reason, setReason] = useState("");
  const [limitStr, setLimitStr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!reason.trim()) { toast.error("A documented reason is required for any override"); return; }
    const limitMinor = limitStr ? Math.round(parseFloat(limitStr.replace(/[^0-9.]/g, "")) * 100) : undefined;
    setBusy(true);
    try {
      await overrideDecision(decisionId, { outcome, reason: reason.trim(), max_loan_amount_minor: limitMinor });
      toast.success(`Decision overridden to ${outcome}`);
      onDone();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Override failed");
    } finally {
      setBusy(false);
    }
  };

  const OUTCOMES = [
    { value: "APPROVE" as const, label: "Approve", color: "var(--good)" },
    { value: "REFER" as const, label: "Refer", color: "var(--warn)" },
    { value: "DECLINE" as const, label: "Decline", color: "var(--bad)" },
  ];

  return (
    <Modal title="Override decision" subtitle="Manually change the model outcome. A documented reason is mandatory and forms part of the audit trail." onClose={onClose}>
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <FieldLabel>New outcome</FieldLabel>
          <div style={{ display: "flex", gap: 8 }}>
            {OUTCOMES.map(o => (
              <button key={o.value} onClick={() => setOutcome(o.value)}
                style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1.5px solid ${outcome === o.value ? o.color : "var(--rule)"}`, background: outcome === o.value ? `color-mix(in srgb, ${o.color} 12%, transparent)` : "var(--panel)", font: `${outcome === o.value ? "700" : "500"} 12.5px/1 var(--font)`, color: outcome === o.value ? o.color : "var(--ink-soft)", cursor: "pointer" }}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        {outcome === "APPROVE" && (
          <div>
            <FieldLabel>Approved limit (optional)</FieldLabel>
            <input value={limitStr} onChange={e => setLimitStr(e.target.value)} placeholder="e.g. 500,000" style={{ width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid var(--rule)", background: "var(--paper)", font: "500 13px/1 var(--font)", color: "var(--ink)", boxSizing: "border-box" }} />
          </div>
        )}
        <div>
          <FieldLabel>Reason for override *</FieldLabel>
          <textarea rows={4} value={reason} onChange={e => setReason(e.target.value)} placeholder="Document the specific basis for overriding the model decision — e.g. additional collateral, verified income not captured in statement, policy exception approved by credit committee…" style={{ width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid var(--rule)", background: "var(--paper)", font: "400 13px/1.5 var(--font)", color: "var(--ink)", resize: "vertical", boxSizing: "border-box" }} />
        </div>
        <div style={{ padding: "8px 12px", background: "var(--warn-wash)", border: "1px solid var(--warn)", borderRadius: 8, font: "400 12px/1.45 var(--font)", color: "var(--ink)" }}>
          Override is permanent and logged. The original model decision is preserved in the audit trail.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !reason.trim()} onClick={submit}>{busy ? "Overriding…" : "Confirm override"}</button>
        </div>
      </div>
    </Modal>
  );
}

function OutcomeModal({ scoreId, onClose, onDone }: { scoreId: string; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState<"paid" | "defaulted" | "written_off" | "prepaid">("paid");
  const [busy, setBusy] = useState(false);

  const OUTCOMES = [
    { value: "paid" as const, label: "Paid", description: "Loan was fully repaid on schedule" },
    { value: "prepaid" as const, label: "Prepaid", description: "Loan repaid early" },
    { value: "defaulted" as const, label: "Defaulted", description: "Customer defaulted on repayment" },
    { value: "written_off" as const, label: "Written off", description: "Balance written off as unrecoverable" },
  ];

  const submit = async () => {
    setBusy(true);
    try {
      await recordOutcome(scoreId, outcome);
      toast.success("Outcome recorded");
      onDone();
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to record outcome");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Record outcome" subtitle="Link the actual loan result to this scoring record — improves future model accuracy." onClose={onClose}>
      <div style={{ display: "grid", gap: 12 }}>
        {OUTCOMES.map(o => (
          <label key={o.value} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: 8, border: `1.5px solid ${outcome === o.value ? "var(--accent)" : "var(--rule)"}`, background: outcome === o.value ? "var(--accent-wash)" : "var(--panel)", cursor: "pointer" }}>
            <input type="radio" name="outcome" value={o.value} checked={outcome === o.value} onChange={() => setOutcome(o.value)} style={{ marginTop: 2, accentColor: "var(--accent)" }} />
            <div>
              <div style={{ font: "600 13px/1.2 var(--font)", color: "var(--ink)", marginBottom: 3 }}>{o.label}</div>
              <div style={{ font: "400 12px/1.4 var(--font)", color: "var(--ink-faint)" }}>{o.description}</div>
            </div>
          </label>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? "Recording…" : "Record outcome"}</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function EyeDecisionPanel({ decisionDetail, loading = false, onRefresh }: { decisionDetail: EyeDecisionDetail | undefined; loading?: boolean; onRefresh?: () => void }) {
  const [tab, setTab] = useState<Tab>("summary");
  const [bureauTab, setBureauTab] = useState<"crc" | "firstcentral">("crc");
  const [showAllFacilities, setShowAllFacilities] = useState(false);
  const [scoreHistory, setScoreHistory] = useState<EyeScoreItem[]>([]);
  const [signalFilter, setSignalFilter] = useState<"all" | "positive" | "risk" | "missing">("all");
  const [activeCat, setActiveCat] = useState<string>("bureau");

  const [showSend, setShowSend] = useState(false);
  const [showOverride, setShowOverride] = useState(false);
  const [showOutcome, setShowOutcome] = useState(false);
  const [rescoring, setRescoring] = useState(false);
  const [txCategoryFilter, setTxCategoryFilter] = useState("all");
  const [txVisibleCount, setTxVisibleCount] = useState(50);
  const [shadowResult, setShadowResult] = useState<ShadowScoreResult | null>(null);

  // Live SHAP cross-check + challenger model comparison + export audit trail —
  // called unconditionally (before the early returns below) per Rules of Hooks.
  const { data: explanation } = useDecisionExplain(decisionDetail?.id);
  const shadowScoreMut = useShadowScore();
  const recordExportMut = useRecordDecisionExport();

  const customerId = decisionDetail?.scoring_record?.customer_id ?? decisionDetail?.bureau_query?.customer_id ?? null;

  useEffect(() => {
    if (!customerId) return;
    getScores({ customer_id: customerId, per_page: 12 }).then(res => {
      setScoreHistory(res.items.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()));
    }).catch(() => {});
  }, [customerId]);

  // Hoisted above the early returns and memoized on the statement object
  // itself: deepFind() is an unmemoized brute-force search, and stmtTransactions
  // can be thousands of rows — recomputing both on every unrelated re-render
  // (e.g. switching bureau tabs) is what made opening the Statement tab feel
  // like it had frozen.
  const statementForMemo = decisionDetail?.statement;
  const stmtAny = statementForMemo as unknown as Record<string, unknown> | undefined;
  const monthlyBreakdown = useMemo(() => stmtAny ? asArray(deepFind(stmtAny, ["monthly_breakdown"])).map(asRecord) : [], [stmtAny]);
  const stmtTransactions = useMemo(() => stmtAny ? asArray(deepFind(stmtAny, ["transactions", "transaction_rows", "transaction_list"])).map(asRecord) : [], [stmtAny]);
  const txCategories = useMemo(() => {
    const set = new Set<string>();
    stmtTransactions.forEach(tx => { const c = text(tx.category ?? tx.transaction_type); if (c) set.add(c); });
    return Array.from(set).sort();
  }, [stmtTransactions]);
  const filteredTransactions = useMemo(
    () => txCategoryFilter === "all" ? stmtTransactions : stmtTransactions.filter(tx => (text(tx.category ?? tx.transaction_type) ?? "") === txCategoryFilter),
    [stmtTransactions, txCategoryFilter],
  );

  // A still-loading detail query is not the same claim as "no decision exists".
  // Without this branch the panel asserted the applicant had never been scored
  // for the whole duration of the fetch, then flipped to a full report.
  if (loading && !decisionDetail) {
    return (
      <div className="panel">
        <div className="panel-head"><h2>Eye decision</h2></div>
        <div style={{ padding: 24 }}>
          <SkeletonText lines={5} />
        </div>
      </div>
    );
  }

  if (!decisionDetail) {
    return (
      <div className="panel">
        <div className="panel-head"><h2>Eye decision</h2></div>
        <EmptyState icon={<Gauge size={24} />} title="No decision on record" description="This applicant hasn't been evaluated by Eye yet." />
      </div>
    );
  }

  const scoring = decisionDetail.scoring_record;
  const bureau = decisionDetail.bureau_query;
  const statement = decisionDetail.statement;
  const outcome = decisionDetail.outcome as DecisionOutcome;
  const currency = decisionDetail.currency ?? statement?.currency ?? "NGN";

  // Contributions
  const allContribs = scoring?.feature_contributions ?? [];
  const meaningful = allContribs.filter(f => Math.abs(f.points) > 0).sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const maxPts = meaningful.length ? Math.max(1, ...meaningful.map(f => Math.abs(f.points))) : 1;
  const positives = meaningful.filter(f => contributionTone(f) === "positive");
  const negatives = meaningful.filter(f => contributionTone(f) === "negative");
  const coveredSignals = allContribs.filter(f => f.raw_value !== null && f.raw_value !== undefined).length;
  const totalSignals = allContribs.length || 71;
  const coveragePct = totalSignals > 0 ? Math.round((coveredSignals / totalSignals) * 100) : 0;

  // Derived values
  const fcVal = (feature: string) => allContribs.find(f => f.feature === feature)?.raw_value;
  const maxLoanMinor = scoring?.max_loan_amount_minor ?? decisionDetail.recommended_limit_minor;
  // Uncapped affordability ceiling — what the applicant could qualify for on a
  // larger ask, distinct from maxLoanMinor which is capped at what was requested.
  const eligibleCeilingMinor = num(scoring?.metadata?.eligible_ceiling_minor);
  // ML shadow model's own limit prediction (LightGBM, runs alongside the
  // scorecard for comparison) — distinct from maxLoanMinor/eligibleCeilingMinor,
  // which are always the scorecard's numbers. null when the limit model wasn't
  // loaded or didn't return a prediction for this score.
  const mlLimitMinor = num(scoring?.metadata?.ml_limit_minor);
  // Behavioral fraud shield — separate from credit risk. high/critical forces
  // manual review server-side (never auto-approves); surfaced here so the
  // reviewer can see why, since it's otherwise invisible.
  const behavioralRisk = scoring?.metadata?.behavioral_risk as
    | { risk_score: number; risk_level: "low" | "medium" | "high" | "critical"; triggered_rules: Array<{ code: string; label: string; weight: number }> }
    | undefined;
  const showFraudWarning = behavioralRisk && (behavioralRisk.risk_level === "high" || behavioralRisk.risk_level === "critical");
  const pd = scoring?.probability_of_default;
  const tenureMonths = num(fcVal("loan_tenure_months") ?? fcVal("tenure_months"));
  const incomeMinor = num(fcVal("monthly_income_minor") ?? fcVal("monthly_income"));
  const emi = maxLoanMinor != null && tenureMonths != null && tenureMonths > 0 ? Math.round(maxLoanMinor / tenureMonths) : null;
  const dsr = emi != null && incomeMinor != null && incomeMinor > 0 ? emi / incomeMinor : null;

  // Bureau extraction
  const bureauJson = asRecord(bureau?.bureau_json);
  const crcPayload = asRecord(deepFind(bureauJson, ["crc", "summary"]) ?? deepFind(bureauJson, ["crc_corporate"]) ?? bureauJson);
  const bureauScore = num(deepFind(crcPayload, ["credit_score", "bureau_score", "score", "crc_score"]));
  const delinquentAccounts = num(deepFind(crcPayload, ["delinquent_accounts", "delinquent_facilities"])) ?? 0;
  const activeLoans = num(deepFind(crcPayload, ["active_accounts", "active_facilities", "active_loans"])) ?? 0;
  const enquiries3m = num(deepFind(crcPayload, ["inquiries_3m", "enquiries_3m", "enquiries3m"]));
  const enquiries30d = num(deepFind(crcPayload, ["inquiries_30d", "enquiries_30d", "enquiries30d"]));
  const identityJson = asRecord(bureau?.identity_json);
  const accountSummary = asRecord(bureau?.account_summary_json);
const profileName = text(deepFind(identityJson, ["full_name", "customer_name", "name", "applicant_name"]));
  const profileBvn = text(deepFind(identityJson, ["bvn", "bvn_confirmed"]));
  const profileDob = text(deepFind(identityJson, ["date_of_birth", "dob", "birth_date"]));
  const profileGender = text(deepFind(identityJson, ["gender", "sex"]));
  const profilePhone = text(deepFind(identityJson, ["phone", "phone_number", "mobile"]));

  // FirstCentral / XDS extraction
  const fcEmbedded = asRecord(deepFind(bureauJson, ["xds", "firstcentral", "first_central", "fc_data", "firstcentral_data"]));
  const fcPayload = Object.keys(fcEmbedded).length ? fcEmbedded : {};
  const fcScore = num(deepFind(fcPayload, ["bureau_score", "xds_score", "firstcentral_score", "fc_score", "fallback_score"]));
  const fcEnq30d = num(deepFind(fcPayload, ["inquiries_30d", "fc_enquiries_30d", "enquiries30d", "fc_enquiries"]));
  const fcOpen = num(deepFind(fcPayload, ["active_facilities", "active_loans", "fc_active_loans", "firstcentral_active_loans"]));
  const fcDef = num(deepFind(fcPayload, ["delinquent_facilities", "delinquent_accounts", "fc_defaults", "firstcentral_defaults"]));
  const fcHasReport = deepFind(fcPayload, ["has_report"]) === true || fcScore != null || asArray(deepFind(fcPayload, ["facilities", "credit_facilities", "loans"])).length > 0;
  const fcStatus = text(deepFind(fcPayload, ["provider_status", "status"]));
  const fcError = text(deepFind(fcPayload, ["provider_error", "error"]));
  const firstCentralEmptyBody = fcStatus === "no_hit"
    ? "FirstCentral returned no bureau file for this applicant. CRC was used as the primary bureau record."
    : (fcStatus === "not_enabled" || fcStatus === "provider_unavailable" || fcStatus === "unavailable")
      ? "FirstCentral/XDS was attempted through Mono, but Mono did not return a usable XDS report. CRC was used as the primary bureau record."
      : fcStatus === "timeout"
        ? "FirstCentral/XDS lookup timed out during this score. CRC was used as the primary bureau record."
        : fcError
          ? `FirstCentral/XDS lookup did not complete (${displaySource(fcError)}). CRC was used as the primary bureau record.`
          : "FirstCentral data was not captured separately for this score. CRC was the primary bureau used.";

  // CRC failure detection.
  //
  // A failed CRC call still stores a payload — {"raw":{"ErrorResponse":…}} — so
  // crcPayload is non-empty and the tab rendered "populated but blank": every field
  // dashed, no score, and nothing saying why. That is indistinguishable from an
  // applicant who genuinely has no bureau file, which is the opposite conclusion.
  // The lookup is billed either way, so the distinction matters.
  const crcErrored = deepFind(crcPayload, ["ErrorResponse"]) != null;
  const crcHasReport = !crcErrored && (
    bureauScore != null ||
    asArray(deepFind(crcPayload, ["facilities", "credit_facilities", "loan_history"])).length > 0 ||
    activeLoans > 0 || delinquentAccounts > 0
  );
  const crcEmptyBody = crcErrored
    ? "The CRC lookup failed, so no bureau record came back. This is a provider error — not a finding that the applicant has no credit file. Check the provider connection's last error for the CRC response code."
    : "CRC returned no bureau file for this applicant.";

  // Open on a bureau that actually has something to show. Defaulting hard to CRC
  // meant a failed CRC lookup presented as an empty report even when the other
  // bureau held a full record one tab away. Applies only until the user picks a
  // tab themselves — after that their choice stands.
  const bureauTabTouched = useRef(false);
  useEffect(() => {
    if (bureauTabTouched.current) return;
    if (!crcHasReport && fcHasReport) setBureauTab("firstcentral");
  }, [crcHasReport, fcHasReport]);

  // Active bureau selection (depends on bureauTab state)
  const activePayload = bureauTab === "crc" ? crcPayload : fcPayload;
  const activeName = bureauTab === "crc" ? "CRC" : "FirstCentral";
  const activeScore = bureauTab === "crc" ? bureauScore : fcScore;
  const hasActiveFull = bureauTab === "crc" ? crcHasReport : (Object.keys(fcEmbedded).length > 0 && fcHasReport);

  // Profile from active bureau
  const activeProviderProfile = asRecord(deepFind(activePayload, ["profile", "consumer", "customer", "subject", "identity", "bio_data"]) ?? {});
  const activeIdentity = { ...activeProviderProfile, ...identityJson };
  const activeIdText = (...keys: string[]) => text(deepFind({ p: activeProviderProfile, i: identityJson, b: activePayload }, keys));
  const addressHistory = asArray(deepFind(activePayload, ["address_history", "previous_addresses", "addresses"]))
    .map(a => {
      if (typeof a === "string") return a;
      const r = asRecord(a);
      // CRC raw AddressHistory uses uppercase ADDRESS; XDS uses lowercase address
      const addrVal = Object.entries(r).find(([k]) => k.toLowerCase() === "address")?.[1];
      return text(addrVal ?? r.value) ?? "";
    }).filter(Boolean) as string[];

  // Active facilities for bureau tab
  const activeFacilities = asArray(deepFind(activePayload, ["facilities", "credit_facilities", "loans"])).map(asRecord)
    .sort((a, b) => (facilityOpenedAt(b)?.getTime() ?? 0) - (facilityOpenedAt(a)?.getTime() ?? 0));
  const activeCount = activeFacilities.filter(f => facilityActualStatus(f) === "Active").length;
  const delinqCount = activeFacilities.filter(f => facilityActualStatus(f) === "Delinquent").length;
  const outstandingSum = activeFacilities.filter(f => facilityActualStatus(f) !== "Closed").reduce((s, f) => s + facilityOutstanding(f), 0);

  // Performance by institution
  const rawInstitutions = asArray(deepFind(activePayload, ["performance_summary", "institutions", "performance_by_institution", "lenders"])).map(asRecord);
  const institutionRows = activeFacilities.length
    ? Object.values(activeFacilities.reduce<Record<string, { institution: string; fac: number; pf: number; npl: number; outstanding: number }>>((acc, item) => {
        const institution = text(item.institution ?? item.lender ?? item.bank) ?? "Unknown";
        const key = institution.toLowerCase();
        const row = acc[key] ?? { institution, fac: 0, pf: 0, npl: 0, outstanding: 0 };
        const st = facilityActualStatus(item); row.fac++;
        if (st === "Delinquent") row.npl++; else row.pf++;
        if (st !== "Closed") row.outstanding += facilityOutstanding(item);
        acc[key] = row; return acc;
      }, {})).sort((a, b) => b.outstanding - a.outstanding || b.fac - a.fac)
    : rawInstitutions.map(item => ({
        institution: text(item.institution ?? item.name ?? item.lender) ?? "-",
        fac: num(item.total ?? item.count) ?? 0, pf: num(item.performing ?? item.open ?? item.active) ?? 0,
        npl: num(item.non_performing ?? item.delinquent ?? item.defaults) ?? 0,
        outstanding: num(item.actual_account_balance ?? item.account_balance ?? item.outstanding) ?? 0,
      }));

  // Contacts, cohort, enquiry history from active payload
  const activeContacts = asArray(deepFind(activePayload, ["contact_history", "contacts", "contact_details", "phone_numbers"]));
  const cohortData = asArray(deepFind(activePayload, ["cohort_comparison", "cohort_data", "peer_comparison"])).map(asRecord);
  const bvnInquiryHistory = asArray(deepFind(activePayload, ["inquiry_history", "inquiries", "enquiry_history", "enquiries_detail"])).map(asRecord)
    .sort((a, b) => {
      const bdat = parseProviderDate(text(asRecord(b).date ?? asRecord(b).inquiry_date ?? asRecord(b).enquiry_date))?.getTime() ?? 0;
      const adat = parseProviderDate(text(asRecord(a).date ?? asRecord(a).inquiry_date ?? asRecord(a).enquiry_date))?.getTime() ?? 0;
      return bdat - adat;
    });

  // CIR and report date
  const cirNumber = text(deepFind(activePayload, ["cir_number", "cir", "report_id", "reference"])) ?? bureau?.id ?? "—";
  const reportDate = (() => { const rd = text(deepFind(activePayload, ["report_date"])); return rd ? formatDate(rd) : formatDate(bureau?.fetched_at); })();

  // CRC corporate section
  const crcCorporate = asRecord(deepFind(bureauJson, ["crc_corporate"]));
  const hasCrcCorporate = crcCorporate.has_report === true;

  // Statement monthly breakdown (monthlyBreakdown/stmtTransactions are computed
  // above, memoized, before the early returns)
  const chartMax = monthlyBreakdown.length ? Math.max(1, ...monthlyBreakdown.map(m => Math.max(num(m.credits_minor) ?? 0, num(m.debits_minor) ?? 0))) : 1;
  const chartMonths = monthlyBreakdown.map((_, i) => {
    if (!statement?.period_start) return `M${i + 1}`;
    const d = new Date(statement.period_start); d.setMonth(d.getMonth() + i);
    return d.toLocaleDateString("en-NG", { month: "short" });
  });

  // Policy
  const dtiRaw = num(allContribs.find(f => f.label?.toLowerCase().includes("dti") || f.label?.toLowerCase().includes("debt-to-income"))?.raw_value);
  const bureauFetched = bureau?.fetched_at;
  // eslint-disable-next-line react-hooks/purity -- Date.now() during render; React Compiler isn't enabled in this app
  const bureauDaysAgo = bureauFetched ? Math.floor((Date.now() - new Date(bureauFetched).getTime()) / 86400000) : null;
  const bureauFresh = bureauDaysAgo != null && bureauDaysAgo <= 30;
  const pepFlagged = !!allContribs.find(f => f.feature === "pep_flagged")?.raw_value;
  const watchlistHit = !!allContribs.find(f => f.feature === "watchlist_match")?.raw_value;
  const gateActive = scoring?.hard_gate_triggered ?? false;
  // institution_name is a raw bank code (e.g. "zenith_bank") wherever it comes
  // straight from the parser — run it through the same bank-name lookup Quick
  // Score's upload step already uses instead of displaying it verbatim.
  const bankName = statement?.institution_name ? getBankName(statement.institution_name) : null;
  const incomeSource = statement
    ? `${bankName ?? "Bank"} · ${statement.transaction_count ?? "—"} txns`
    : Object.keys(accountSummary).length > 0 ? "Account summary" : "Declared";

  // EWS signals
  const ewsSignals: EwsSignal[] = [];
  let _ec = 1;
  const eid = () => `EWS-${900 + _ec++}`;
  if (gateActive) ewsSignals.push({ id: eid(), severity: "High", status: "Pending", title: hardGateDisplay(scoring) ?? "Policy gate triggered", description: "Score hard gate blocked approval. Manual review required before proceeding." });
  if (delinquentAccounts > 0) ewsSignals.push({ id: eid(), severity: "High", status: "Pending", title: `Delinquent accounts — ${delinquentAccounts} on bureau`, description: `Bureau report shows ${delinquentAccounts} delinquent account${delinquentAccounts > 1 ? "s" : ""}. Outstanding overdue balance detected.` });
  if (statement?.bounce_count_per_month && statement.bounce_count_per_month >= 1) {
    const c = Math.round(statement.bounce_count_per_month);
    ewsSignals.push({ id: eid(), severity: statement.bounce_count_per_month >= 3 ? "High" : "Medium", status: "Pending", title: `Bounce frequency — ~${c} per month`, description: `Statement shows ~${c} returned debit${c > 1 ? "s" : ""} per month. Possible insufficient funds pattern.` });
  }
  if (statement?.gambling_ratio && statement.gambling_ratio > 0.05) {
    const gp = (statement.gambling_ratio * 100).toFixed(1);
    ewsSignals.push({ id: eid(), severity: statement.gambling_ratio >= 0.15 ? "High" : "Medium", status: "Pending", title: `Gambling transactions — ${gp}% of debits`, description: `${gp}% of debit transactions matched gambling merchant patterns.` });
  }
  if ((enquiries3m ?? 0) >= 2) ewsSignals.push({ id: eid(), severity: (enquiries3m ?? 0) >= 4 ? "Medium" : "Low", status: "Open", title: `Multiple bureau enquiries — ${enquiries3m} in 3 months`, description: `${enquiries3m} bureau enquiries in the last 3 months. May indicate credit-seeking activity.` });
  if (pepFlagged || watchlistHit) ewsSignals.push({ id: eid(), severity: "High", status: "Pending", title: "PEP / watchlist flag detected", description: "Applicant matched a politically exposed person or sanctions watchlist entry. Compliance review required." });
  const ewsHighCount = ewsSignals.filter(s => s.severity === "High").length;

  function ewsSevColor(sev: string) { return sev === "High" ? "var(--bad)" : sev === "Medium" ? "var(--warn)" : "var(--accent)"; }
  function ewsSevBg(sev: string) { return sev === "High" ? "var(--bad-wash)" : sev === "Medium" ? "var(--warn-wash)" : "var(--accent-wash)"; }

  // Outcome config
  const outcomeConf = {
    APPROVE:  { bg: "var(--good-wash)",  border: "color-mix(in srgb, var(--good) 22%, transparent)",  text: "var(--good)",  dot: "var(--good)",  label: "Approved" },
    DECLINE:  { bg: "var(--bad-wash)",   border: "color-mix(in srgb, var(--bad) 22%, transparent)",   text: "var(--bad)",   dot: "var(--bad)",   label: "Declined" },
    REFER:    { bg: "var(--warn-wash)",  border: "color-mix(in srgb, var(--warn) 26%, transparent)",  text: "var(--warn)",  dot: "var(--warn)",  label: "Referred" },
    REQUEST_MORE_INFORMATION: { bg: "var(--warn-wash)", border: "color-mix(in srgb, var(--warn) 26%, transparent)", text: "var(--warn)", dot: "var(--warn)", label: "More info needed" },
    ERROR: { bg: "var(--bad-wash)", border: "color-mix(in srgb, var(--bad) 22%, transparent)", text: "var(--bad)", dot: "var(--bad)", label: "Could not be scored" },
  };
  const oc = outcomeConf[outcome];

  const tabs: [Tab, string, number?][] = [
    ["summary",   "Summary"],
    ["risk",      "Risk factors", meaningful.length || undefined],
    ["bureau",    "Bureau"],
    ["statement", "Statement"],
    ["limit",     "Credit limit"],
    ["ews",       "EWS", gateActive ? 1 : undefined],
    ["policy",    "Policy & audit"],
  ];

  const downloadReport = async () => {
    if (!decisionDetail) return;
    try {
      exportCreditDecisionReport(decisionDetail);
      await recordExportMut.mutateAsync({ id: decisionDetail.id, format: "pdf" });
    } catch (e) {
      toast.error((e as Error)?.message ?? "Report export unavailable");
    }
  };

  const runShadowScore = async () => {
    if (!scoring?.score_id) return;
    try {
      const result = await shadowScoreMut.mutateAsync(scoring.score_id);
      setShadowResult(result);
      toast.success("Challenger score computed");
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      toast.error(msg.toLowerCase().includes("challenger") ? "Challenger model not configured for this tenant" : "Challenger score unavailable");
    }
  };

  return (
    <div style={{ display: "grid", gap: 14, marginTop: 16 }}>
      <style>{`@media print { .eye-no-print { display: none !important; } .eye-print-break { page-break-before: always; } }`}</style>

      {/* Modals */}
      {showSend && decisionDetail && <SendModal decisionId={decisionDetail.id} onClose={() => setShowSend(false)} />}
      {showOverride && decisionDetail && (
        <OverrideModal decisionId={decisionDetail.id} currentOutcome={decisionDetail.outcome}
          onClose={() => setShowOverride(false)} onDone={() => { setShowOverride(false); onRefresh?.(); }} />
      )}
      {showOutcome && decisionDetail?.scoring_record?.id && (
        <OutcomeModal scoreId={decisionDetail.scoring_record.id}
          onClose={() => setShowOutcome(false)} onDone={() => { setShowOutcome(false); onRefresh?.(); }} />
      )}

      {/* ── Hero banner ──────────────────────────────────────────────────────── */}
      <div style={{ background: "linear-gradient(165deg, #0B3330 0%, #061A18 75%)", borderRadius: "var(--r-xl)", overflow: "hidden", position: "relative" }}>
        {/* Grid texture */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)", backgroundSize: "44px 44px", WebkitMaskImage: "radial-gradient(900px 400px at 90% 0%, #000 0%, transparent 70%)", maskImage: "radial-gradient(900deg 400px at 90% 0%, #000 0%, transparent 70%)" }} />
        {/* Teal glow */}
        <div style={{ position: "absolute", top: -80, left: -40, width: 320, height: 320, background: "radial-gradient(closest-side, rgba(10,126,118,0.35), transparent 70%)", filter: "blur(8px)" }} />

        <div style={{ position: "relative", padding: "24px 28px 0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 24, alignItems: "start" }}>
            {/* ScoreGauge with dark-theme CSS var override */}
            <div style={{ "--ink": "#E9EAF5", "--rule": "rgba(255,255,255,0.14)" } as React.CSSProperties}>
              {scoring
                ? <ScoreGauge score={scoring.score} label={scoring.band} size={170} />
                : <div style={{ width: 170, height: 110, display: "grid", placeItems: "center", color: "rgba(255,255,255,0.4)", fontSize: 13 }}>No score on file</div>
              }
            </div>
            {/* Right: outcome chip + mini-stats grid */}
            <div style={{ paddingTop: 8 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: oc.bg, border: `1px solid ${oc.border}`, borderRadius: "var(--r-pill)", padding: "7px 14px 7px 10px", marginBottom: 18 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: oc.dot, boxShadow: `0 0 0 3px ${oc.border}` }} />
                <span style={{ font: "700 13px/1 var(--font)", color: oc.text }}>{oc.label}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                {[
                  { label: "PD", value: scoring ? pct(scoring.probability_of_default) : "—" },
                  { label: "Model", value: scoring?.model_version ?? "—" },
                  { label: "Band", value: scoring?.band ?? decisionDetail.risk_band ?? "—" },
                  { label: "Scored", value: formatDate(scoring?.scored_at) },
                ].map(s => (
                  <div key={s.label}>
                    <div style={{ color: "rgba(255,255,255,0.38)", font: "650 10px/1 var(--font)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>{s.label}</div>
                    <div style={{ color: "#E9EAF5", font: "650 13.5px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{s.value}</div>
                  </div>
                ))}
              </div>
              {maxLoanMinor != null && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <div style={{ color: "rgba(255,255,255,0.38)", font: "650 10px/1 var(--font)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>Approved limit</div>
                  <div style={{ color: "var(--gold-2)", font: "750 18px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{formatMoney(maxLoanMinor, currency)}</div>
                  {eligibleCeilingMinor != null && eligibleCeilingMinor > maxLoanMinor && (
                    <div style={{ marginTop: 6, color: "rgba(255,255,255,0.5)", font: "500 11.5px/1.4 var(--font)" }}>
                      Eligible for up to <span style={{ color: "#E9EAF5", fontVariantNumeric: "tabular-nums" }}>{formatMoney(eligibleCeilingMinor, currency)}</span> on a larger request
                    </div>
                  )}
                  {mlLimitMinor != null && (
                    <div style={{ marginTop: 6, color: "rgba(255,255,255,0.5)", font: "500 11.5px/1.4 var(--font)" }}>
                      ML model prediction: <span style={{ color: "#E9EAF5", fontVariantNumeric: "tabular-nums" }}>{formatMoney(mlLimitMinor, currency)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Reasons row */}
        {decisionDetail.reasons.length > 0 && (
          <div style={{ padding: "14px 28px 20px", borderTop: "1px solid rgba(255,255,255,0.07)", marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ color: "rgba(255,255,255,0.35)", font: "600 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", flexShrink: 0 }}>Reasons</span>
            {decisionDetail.reasons.map((r, i) => {
              const pos = reasonTone(r, outcome) === "pos";
              return (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: "var(--r-pill)", background: pos ? "rgba(46,158,119,0.18)" : "rgba(201,79,69,0.18)", border: `1px solid ${pos ? "rgba(46,158,119,0.28)" : "rgba(201,79,69,0.28)"}`, color: pos ? "#6BBF95" : "#DB9184", font: "500 12px/1.3 var(--font)" }}>
                  {pos ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                  {r}
                </span>
              );
            })}
          </div>
        )}

        {/* Hard gate warning */}
        {gateActive && (
          <div style={{ margin: "0 28px 20px", padding: "10px 14px", background: "rgba(176,59,51,0.18)", border: "1px solid rgba(176,59,51,0.28)", borderRadius: "var(--r-md)", display: "flex", gap: 8, alignItems: "center" }}>
            <AlertTriangle size={14} style={{ color: "#DB9184", flexShrink: 0 }} />
            <span style={{ font: "500 12.5px/1.4 var(--font)", color: "#E8ACA1" }}>Hard gate: {scoring?.hard_gate_reason ?? "Declined by policy"}</span>
          </div>
        )}

        {/* Behavioral fraud shield warning — separate from credit risk; this is
            not a hard gate, it's advisory, but high/critical forces manual
            review server-side rather than auto-approving unseen. */}
        {showFraudWarning && behavioralRisk && (
          <div style={{ margin: "0 28px 20px", padding: "10px 14px", background: "rgba(176,59,51,0.18)", border: "1px solid rgba(176,59,51,0.28)", borderRadius: "var(--r-md)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: behavioralRisk.triggered_rules.length ? 6 : 0 }}>
              <AlertTriangle size={14} style={{ color: "#DB9184", flexShrink: 0 }} />
              <span style={{ font: "500 12.5px/1.4 var(--font)", color: "#E8ACA1" }}>
                Behavioral fraud shield: {behavioralRisk.risk_level} risk ({Math.round(behavioralRisk.risk_score * 100)}%) — forced to manual review
              </span>
            </div>
            {behavioralRisk.triggered_rules.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 22 }}>
                {behavioralRisk.triggered_rules.map(r => (
                  <span key={r.code} style={{ padding: "3px 9px", borderRadius: "var(--r-pill)", background: "rgba(176,59,51,0.15)", border: "1px solid rgba(176,59,51,0.25)", color: "#E8ACA1", font: "500 11px/1.3 var(--font)" }}>
                    {r.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Action footer */}
        <div className="eye-no-print" style={{ padding: "10px 28px 14px", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button onClick={downloadReport} disabled={recordExportMut.isPending}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: "var(--r-lg)", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.72)", font: "600 12px/1 var(--font)", cursor: "pointer", opacity: recordExportMut.isPending ? 0.6 : 1 }}>
            <Printer size={13} /> Export PDF
          </button>
          <button disabled={rescoring} onClick={async () => {
            if (!decisionDetail) return;
            setRescoring(true);
            try {
              await rescoreDecision(decisionDetail.id);
              toast.success("Rescore triggered — refresh to see updated result");
              onRefresh?.();
            } catch (e) { toast.error((e as Error)?.message ?? "Rescore failed"); }
            finally { setRescoring(false); }
          }} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: "var(--r-lg)", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.72)", font: "600 12px/1 var(--font)", cursor: rescoring ? "default" : "pointer", opacity: rescoring ? 0.5 : 1 }}>
            <RefreshCw size={13} /> {rescoring ? "Rescoring…" : "Rescore"}
          </button>
          <button onClick={() => setShowOverride(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: "var(--r-lg)", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.72)", font: "600 12px/1 var(--font)", cursor: "pointer" }}>
            <Shield size={13} /> Override
          </button>
          <button onClick={() => setShowOutcome(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: "var(--r-lg)", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.72)", font: "600 12px/1 var(--font)", cursor: "pointer" }}>
            <Tag size={13} /> Outcome
          </button>
          {scoring?.score_id && (
            <button onClick={runShadowScore} disabled={shadowScoreMut.isPending} title="Run challenger model and compare against champion PD"
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: "var(--r-lg)", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.72)", font: "600 12px/1 var(--font)", cursor: shadowScoreMut.isPending ? "default" : "pointer", opacity: shadowScoreMut.isPending ? 0.5 : 1 }}>
              <FlaskConical size={13} /> {shadowScoreMut.isPending ? "Running…" : "Challenger"}
            </button>
          )}
          <button onClick={() => setShowSend(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: "var(--r-lg)", border: "1px solid rgba(10,126,118,0.45)", background: "rgba(10,126,118,0.22)", color: "#92D9D4", font: "700 12px/1 var(--font)", cursor: "pointer", marginLeft: "auto" }}>
            <Send size={13} /> Send to borrower
          </button>
        </div>
      </div>

      {/* Challenger model result — champion vs challenger PD comparison */}
      {shadowResult && (
        <Card style={{ borderColor: "var(--accent)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
            <MetricCard label="Champion PD" value={pct(shadowResult.champion_pd, 2)} />
            <MetricCard label="Challenger PD" value={pct(shadowResult.challenger_pd, 2)} />
            <MetricCard label="Delta" value={`${shadowResult.pd_delta >= 0 ? "+" : ""}${pct(shadowResult.pd_delta, 2)}`} />
            <MetricCard label="Method" value={shadowResult.challenger_method} />
          </div>
        </Card>
      )}

      {/* ── Tabs + content panel ─────────────────────────────────────────────── */}
      <div className="panel" style={{ borderRadius: "var(--r-xl)" }}>

        {/* Pill tab bar */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--rule)", display: "flex", gap: 4, flexWrap: "wrap", background: "var(--paper)" }}>
          {tabs.map(([key, label, count]) => {
            const active = tab === key;
            return (
              <button key={key} onClick={() => setTab(key)} style={{ padding: "7px 15px", borderRadius: "var(--r-pill)", font: "600 13px/1 var(--font)", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, transition: "all var(--dur-fast) var(--ease)", background: active ? "var(--accent)" : "transparent", color: active ? "#fff" : "var(--ink-soft)", boxShadow: active ? "var(--shadow-accent)" : "none" }}>
                {label}
                {count ? <span style={{ padding: "2px 6px", borderRadius: "var(--r-pill)", background: active ? "rgba(255,255,255,0.22)" : "var(--rule)", color: active ? "#fff" : "var(--ink-faint)", font: "700 10px/1 var(--font)" }}>{count}</span> : null}
              </button>
            );
          })}
        </div>

        <div style={{ padding: "22px 22px 28px" }}>

          {/* ══ SUMMARY ══════════════════════════════════════════════════════════ */}
          {tab === "summary" && (
            <div style={{ display: "grid", gap: 16 }}>

              {/* Applicant identity */}
              {(profileName || profileBvn || profileDob || profileGender) && (
                <Card>
                  <Kicker>Applicant identity</Kicker>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
                    <div style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0, display: "grid", placeItems: "center", background: "linear-gradient(135deg, var(--accent-2), var(--accent))", color: "#fff", font: "750 15px/1 var(--font)" }}>
                      {(profileName ?? "A").split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()}
                    </div>
                    <div>
                      <div style={{ color: "var(--ink)", font: "760 15px/1.2 var(--font)" }}>{profileName ?? "Applicant"}</div>
                      {profileBvn && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                          <span style={{ color: "var(--ink-faint)", font: "500 11.5px/1 var(--font-mono)" }}>BVN {profileBvn}</span>
                          {text(deepFind(crcPayload, ["bvn_confirmed"]))
                            ? <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 7px", borderRadius: "var(--r-pill)", background: "var(--good-wash)", color: "var(--good)", font: "650 10px/1 var(--font)" }}><CheckCircle2 size={10} /> Confirmed</span>
                            : <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 7px", borderRadius: "var(--r-pill)", background: "var(--warn-wash)", color: "var(--warn)", font: "650 10px/1 var(--font)" }}><AlertTriangle size={10} /> Unconfirmed</span>
                          }
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "0 24px" }}>
                    {[
                      { label: "Gender", value: profileGender ? titleCase(profileGender) : "—" },
                      { label: "Date of birth", value: (() => { if (!profileDob) return "—"; const age = ageFromDOB(profileDob); return age != null ? `${formatDate(profileDob)} (${age} yrs)` : formatDate(profileDob); })() },
                      { label: "Phone", value: profilePhone ?? "—" },
                    ].map(f => (
                      <div key={f.label} style={{ padding: "8px 0", borderBottom: "1px solid var(--rule-soft)" }}>
                        <div style={{ color: "var(--ink-faint)", font: "600 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{f.label}</div>
                        <div style={{ color: "var(--ink)", font: "600 13px/1.35 var(--font)" }}>{f.value}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Why strip */}
              <div style={{ background: oc.bg, border: `1px solid ${oc.border}`, borderLeft: `3px solid ${oc.text}`, borderRadius: "var(--r-lg)", padding: "18px 20px" }}>
                <Kicker>{outcome === "APPROVE" ? "Why this was approved" : outcome === "DECLINE" ? "Why this was declined" : "Why this was referred"}</Kicker>
                <div style={{ display: "grid", gap: 10 }}>
                  {(outcome === "DECLINE" ? negatives : positives).slice(0, 4).map((f, i) => {
                    const pos = contributionTone(f) === "positive";
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--panel)", border: "1px solid var(--rule)", boxShadow: "var(--shadow-sm)" }}>
                        <div style={{ width: 28, height: 28, borderRadius: "50%", display: "grid", placeItems: "center", background: pos ? "var(--good)" : "var(--bad)", color: "#fff", font: "800 13px/1 var(--font)", flexShrink: 0 }}>
                          {pos ? "+" : "−"}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: "var(--ink)", font: "700 13px/1.25 var(--font)" }}>{f.label}</div>
                          {f.value && <div style={{ color: "var(--ink-faint)", font: "400 12px/1.35 var(--font)", marginTop: 2 }}>{f.value}</div>}
                        </div>
                        <span style={{ color: pos ? "var(--good)" : "var(--bad)", font: "750 13px/1 var(--font-mono)", flexShrink: 0 }}>{pos ? "+" : "−"}{Math.abs(f.points).toFixed(0)}</span>
                      </div>
                    );
                  })}
                  {meaningful.length === 0 && (
                    <p style={{ margin: 0, color: "var(--ink-soft)", font: "500 13px/1.55 var(--font)" }}>{decisionDetail.reasons.join(" ") || "Decision generated from Eye scoring evidence."}</p>
                  )}
                </div>
              </div>

              {/* Risk distribution */}
              <Card><RiskDistribution pd={pd} /></Card>

              {/* Signal coverage */}
              {allContribs.length > 0 && (
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <Kicker>Signal coverage</Kicker>
                    <span style={{ font: "600 12px/1 var(--font-mono)", color: coveragePct >= 70 ? "var(--good)" : coveragePct >= 40 ? "var(--warn)" : "var(--bad)" }}>{coveredSignals}/{totalSignals} ({coveragePct}%)</span>
                  </div>
                  <div style={{ height: 8, background: "var(--rule)", borderRadius: "var(--r-pill)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${coveragePct}%`, background: coveragePct >= 70 ? "var(--good)" : coveragePct >= 40 ? "var(--warn)" : "var(--bad)", borderRadius: "var(--r-pill)", boxShadow: coveragePct >= 70 ? "0 0 10px -2px rgba(34,122,91,0.5)" : "none", transition: "width var(--dur-slow) var(--ease)" }} />
                  </div>
                </Card>
              )}

              {/* Score history trend */}
              {scoreHistory.length > 1 && (
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <Kicker>Score history ({scoreHistory.length} scores)</Kicker>
                    <span style={{ font: "600 12px/1 var(--font-mono)", color: "var(--ink-faint)" }}>
                      {scoreHistory[0].score} → {scoreHistory[scoreHistory.length - 1].score}
                      {scoreHistory[scoreHistory.length - 1].score > scoreHistory[0].score
                        ? <TrendingUp size={13} style={{ display: "inline", marginLeft: 4, color: "var(--good)" }} />
                        : <TrendingDown size={13} style={{ display: "inline", marginLeft: 4, color: "var(--bad)" }} />
                      }
                    </span>
                  </div>
                  {(() => {
                    const minS = Math.min(...scoreHistory.map(s => s.score));
                    const maxS = Math.max(...scoreHistory.map(s => s.score));
                    const range = Math.max(1, maxS - minS);
                    const W = 100, H = 56;
                    const xStep = scoreHistory.length > 1 ? W / (scoreHistory.length - 1) : W;
                    const points = scoreHistory.map((s, i) => {
                      const x = i * xStep;
                      const y = H - ((s.score - minS) / range) * (H - 8) - 4;
                      return `${x},${y}`;
                    }).join(" ");
                    const current = scoreHistory[scoreHistory.length - 1];
                    const cx = (scoreHistory.length - 1) * xStep;
                    const cy = H - ((current.score - minS) / range) * (H - 8) - 4;
                    return (
                      <div>
                        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 72, overflow: "visible" }}>
                          <defs>
                            <linearGradient id="sgFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
                              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <polygon points={`0,${H} ${points} ${(scoreHistory.length - 1) * xStep},${H}`} fill="url(#sgFill)" />
                          <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          {scoreHistory.map((s, i) => {
                            const x = i * xStep;
                            const y = H - ((s.score - minS) / range) * (H - 8) - 4;
                            const isLast = i === scoreHistory.length - 1;
                            return (
                              <circle key={i} cx={x} cy={y} r={isLast ? 3.5 : 2}
                                fill={isLast ? "var(--accent)" : "var(--panel)"}
                                stroke="var(--accent)" strokeWidth={isLast ? 0 : 1.5}>
                                <title>{`${formatDate(s.created_at)}: ${s.score} (${s.band})`}</title>
                              </circle>
                            );
                          })}
                          <text x={cx} y={cy - 7} textAnchor="middle" fill="var(--accent)" fontSize="9" fontWeight="700" fontFamily="var(--font-mono)">{current.score}</text>
                        </svg>
                        <div style={{ display: "flex", justifyContent: "space-between", font: "500 11px/1 var(--font-mono)", color: "var(--ink-faint)", marginTop: 4 }}>
                          <span>{formatDate(scoreHistory[0].created_at)}</span>
                          <span>{formatDate(scoreHistory[scoreHistory.length - 1].created_at)}</span>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                          {scoreHistory.slice(-6).map((s, i) => (
                            <div key={i} style={{ padding: "5px 9px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)", textAlign: "center" }}>
                              <div style={{ font: "700 13px/1 var(--font-mono)", color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{s.score}</div>
                              <div style={{ font: "500 10px/1 var(--font)", color: "var(--ink-faint)", marginTop: 3 }}>{s.band}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </Card>
              )}

              {/* Two-column: contributions + terms */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <Kicker>Feature contributions</Kicker>
                    <div style={{ display: "flex", gap: 10, font: "600 11.5px/1 var(--font)" }}>
                      <span style={{ color: "var(--good)" }}>+{positives.length}</span>
                      <span style={{ color: "var(--bad)" }}>−{negatives.length}</span>
                    </div>
                  </div>
                  {meaningful.length > 0
                    ? meaningful.slice(0, 8).map((f, i) => <ContributionBar key={f.feature ?? i} factor={f} max={maxPts} />)
                    : <p style={{ margin: 0, color: "var(--ink-faint)", font: "400 12.5px/1.5 var(--font)" }}>No feature contributions on record.</p>
                  }
                </Card>
                <div>
                  <Kicker>Recommended terms</Kicker>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <MetricCard label="Limit" value={maxLoanMinor != null ? formatMoney(maxLoanMinor, currency) : "—"} />
                    <MetricCard label="PD" value={pd != null ? pct(pd) : "—"} valueColor={pd != null && pd > 0.3 ? "var(--bad)" : undefined} />
                    <MetricCard label="Tenor" value={tenureMonths != null ? `${tenureMonths}mo` : "—"} />
                    <MetricCard label="EMI" value={emi != null ? formatMoney(emi, currency) : "—"} />
                    <MetricCard label="DSR" value={dsr != null ? pct(dsr) : "—"} valueColor={dsr != null && dsr > 0.5 ? "var(--warn)" : undefined} />
                    <MetricCard label="Band" value={scoring?.band ?? decisionDetail.risk_band ?? "—"} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ══ RISK FACTORS ══════════════════════════════════════════════════════ */}
          {tab === "risk" && (
            <div style={{ display: "grid", gap: 16 }}>
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
                  <div>
                    <Kicker>Feature contributions</Kicker>
                    <p style={{ margin: 0, color: "var(--ink-faint)", font: "400 12.5px/1.5 var(--font)" }}>Green bars improve the score; red bars increase risk.</p>
                  </div>
                  <div style={{ display: "flex", gap: 12, font: "600 12px/1 var(--font)", flexShrink: 0 }}>
                    <span style={{ color: "var(--good)" }}>+{positives.length} approve</span>
                    <span style={{ color: "var(--bad)" }}>−{negatives.length} risk</span>
                  </div>
                </div>
                {meaningful.length > 0
                  ? meaningful.map((f, i) => <ContributionBar key={f.feature ?? i} factor={f} max={maxPts} />)
                  : <EmptyState icon={<Gauge size={22} />} title="No contributions" description="The backend stored a score but no non-zero contribution rows." />
                }
              </Card>

              {/* Live SHAP cross-check — a separate live call to the intelligence
                  service's explainer, distinct from the scorecard's own stored
                  feature_contributions above. */}
              {explanation && explanation.hard_gate_triggered && (
                <Card>
                  <Kicker>ML attribution (SHAP) — live cross-check</Kicker>
                  <p style={{ margin: 0, color: "var(--ink-faint)", font: "400 13px/1.5 var(--font)" }}>
                    This application was declined by a hard gate
                    {decisionDetail.reasons.length > 0 ? ` (${decisionDetail.reasons.join(", ")})` : ""} before
                    reaching the scoring model — bureau, statement, and telco signals were never evaluated,
                    so there are no meaningful feature contributions to show.
                  </p>
                </Card>
              )}
              {explanation && !explanation.hard_gate_triggered && explanation.top_factors.length > 0 && (() => {
                const shapMax = Math.max(1, ...explanation.top_factors.map(f => Math.abs(f.contribution)));
                return (
                  <Card>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
                      <div>
                        <Kicker>ML attribution (SHAP) — live cross-check</Kicker>
                        <p style={{ margin: 0, color: "var(--ink-faint)", font: "400 12.5px/1.5 var(--font)" }}>Live explanation from the intelligence service's own model — separate from the scorecard weights above.</p>
                      </div>
                      <span style={{ font: "500 11px/1 var(--font)", color: "var(--ink-faint)", background: "var(--paper)", padding: "3px 8px", borderRadius: 4, flexShrink: 0 }}>
                        top {explanation.top_factors.length}
                      </span>
                    </div>
                    {explanation.top_factors.map((f, i) => (
                      <ContributionBar
                        key={i}
                        factor={{
                          feature: f.feature,
                          label: titleCase(f.feature),
                          value: `${f.contribution >= 0 ? "+" : ""}${f.contribution.toFixed(3)}`,
                          direction: f.direction,
                          points: f.contribution,
                        } as FeatureContribution}
                        max={shapMax}
                      />
                    ))}
                    <p style={{ margin: "10px 0 0", font: "400 11px/1.4 var(--font)", color: "var(--ink-faint)" }}>
                      Top {explanation.top_factors.length} of {explanation.total_features} features · live SHAP attribution
                    </p>
                  </Card>
                );
              })()}

              <Card>
                <Kicker>Policy checks</Kicker>
                <PolicyCheck label="DTI (gate ≤ 70%)" value={dtiRaw != null ? `${(dtiRaw * 100).toFixed(1)}%` : "Not available"} pass={dtiRaw != null ? dtiRaw <= 0.70 : undefined} />
                <PolicyCheck label="Bureau pulled within 30d" value={bureauFetched ? `${bureauDaysAgo}d ago` : "Not pulled"} pass={bureauDaysAgo != null ? bureauDaysAgo <= 30 : undefined} />
                <PolicyCheck label="No active delinquencies" value={delinquentAccounts > 0 ? `${delinquentAccounts} delinquent` : "Confirmed"} pass={delinquentAccounts === 0} />
                <PolicyCheck label="Active loans (gate ≤ 5)" value={activeLoans > 0 ? String(activeLoans) : "None on bureau"} pass={activeLoans <= 5} />
                <PolicyCheck label="PEP / sanctions clear" value={pepFlagged || watchlistHit ? "Flagged — review required" : "Clear"} pass={!pepFlagged && !watchlistHit} />
                <PolicyCheck label="Hard gate" value={gateActive ? (scoring?.hard_gate_reason ?? "Triggered") : "Passed"} pass={!gateActive} />
              </Card>

              {/* All signals — categorised tab-panel */}
              {allContribs.length > 0 && (() => {
                function catOf(f: FeatureContribution): string {
                  const k = ((f.feature ?? "") + " " + f.label).toLowerCase();
                  if (/bureau|credit.?score|delinquent|enquir|inquiry|payment.?hist|dpd|days.?past|crc|xds|first.?central|open.?loan|active.?loan|account.?age/.test(k)) return "bureau";
                  if (/income|salary|regularity|inflow|earning|monthly.?credit|wage|employment/.test(k)) return "income";
                  if (/gambl|bounce|dscr|saving|statement|outflow|transaction|avg.?monthly|cashflow|overdraft/.test(k)) return "statement";
                  if (/dti|debt.to.income|obligation|outstanding|loan.?amount|emi|tenure|leverage|repayment/.test(k)) return "debt";
                  if (/age|gender|bvn|pep|watchlist|kyc|identity|nationality|education|marital/.test(k)) return "identity";
                  if (/business|revenue|cac|rc.?number|employee|industry|profit|turnover/.test(k)) return "business";
                  return "other";
                }

                const CAT_META: Record<string, { label: string; icon: ReactNode; color: string }> = {
                  bureau:    { label: "Bureau Health",         icon: <Landmark size={13} />,    color: "#4F6EF7" },
                  income:    { label: "Income & Capacity",    icon: <TrendingUp size={13} />,   color: "var(--good)" },
                  statement: { label: "Statement Analytics",  icon: <FileText size={13} />,     color: "#8B5CF6" },
                  debt:      { label: "Debt & Leverage",      icon: <Activity size={13} />,     color: "var(--warn)" },
                  identity:  { label: "Identity & Compliance",icon: <ShieldAlert size={13} />,  color: "#64748B" },
                  business:  { label: "Business Profile",     icon: <Zap size={13} />,          color: "#0EA5E9" },
                  other:     { label: "Other Signals",        icon: <Minus size={13} />,        color: "var(--ink-faint)" },
                };
                const CAT_ORDER = ["bureau", "income", "statement", "debt", "identity", "business", "other"];

                const grouped = allContribs.reduce<Record<string, FeatureContribution[]>>((acc, f) => {
                  const cat = catOf(f); (acc[cat] ??= []).push(f); return acc;
                }, {});

                const presentCats = CAT_ORDER.filter(c => grouped[c]?.length);
                const currentCat = presentCats.includes(activeCat) ? activeCat : presentCats[0] ?? "other";
                const panelSignals = grouped[currentCat] ?? [];

                const totalPosPts = meaningful.filter(f => contributionTone(f) === "positive").reduce((s, f) => s + f.points, 0);
                const totalRiskPts = meaningful.filter(f => contributionTone(f) === "negative").reduce((s, f) => s + Math.abs(f.points), 0);
                const grandTotal = totalPosPts + totalRiskPts || 1;
                const missingCount = allContribs.filter(f => f.raw_value === null || f.raw_value === undefined).length;

                const visibleSignals = signalFilter === "positive" ? panelSignals.filter(f => contributionTone(f) === "positive" && f.points !== 0)
                  : signalFilter === "risk"    ? panelSignals.filter(f => contributionTone(f) === "negative" && f.points !== 0)
                  : signalFilter === "missing" ? panelSignals.filter(f => f.raw_value === null || f.raw_value === undefined)
                  : panelSignals;

                const FILTERS = [
                  { key: "all",     label: "All",      col: "var(--accent)", bg: "var(--accent-wash)", txt: "var(--accent-ink)" },
                  { key: "positive",label: "Positive", col: "var(--good)",   bg: "var(--good-wash)",   txt: "var(--good)" },
                  { key: "risk",    label: "Risk",     col: "var(--bad)",    bg: "var(--bad-wash)",    txt: "var(--bad)" },
                  { key: "missing", label: "Missing",  col: "var(--warn)",   bg: "var(--warn-wash)",   txt: "var(--warn)" },
                ] as const;

                return (
                  <Card noPad>
                    {/* ── Toolbar ── */}
                    <div style={{ padding: "14px 18px 12px", borderBottom: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <Kicker>All signals</Kicker>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ color: "var(--good)", font: "700 11.5px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>+{totalPosPts.toFixed(0)}</span>
                          <div style={{ width: 100, height: 5, borderRadius: "var(--r-pill)", overflow: "hidden", background: "var(--rule)", display: "flex" }}>
                            <div style={{ height: "100%", width: `${(totalPosPts / grandTotal) * 100}%`, background: "var(--good)" }} />
                            <div style={{ height: "100%", width: `${(totalRiskPts / grandTotal) * 100}%`, background: "var(--bad)" }} />
                          </div>
                          <span style={{ color: "var(--bad)", font: "700 11.5px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>−{totalRiskPts.toFixed(0)}</span>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 4 }}>
                        {FILTERS.map(({ key, label, col, bg, txt }) => {
                          const active = signalFilter === key;
                          return (
                            <button key={key} onClick={() => setSignalFilter(key as typeof signalFilter)} style={{ padding: "4px 11px", borderRadius: "var(--r-pill)", border: `1px solid ${active ? col : "var(--rule)"}`, background: active ? bg : "transparent", color: active ? txt : "var(--ink-soft)", font: "600 11px/1 var(--font)", cursor: "pointer", transition: "all var(--dur-fast) var(--ease)" }}>
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* ── Tab-panel body ── */}
                    <div style={{ display: "grid", gridTemplateColumns: "188px 1fr", minHeight: 300 }}>

                      {/* Left: vertical category tabs */}
                      <div style={{ borderRight: "1px solid var(--rule)", padding: "8px 0" }}>
                        {presentCats.map(cat => {
                          const meta = CAT_META[cat];
                          const sigs = grouped[cat];
                          const catPosPts = sigs.filter(f => contributionTone(f) === "positive").reduce((s, f) => s + f.points, 0);
                          const catNegPts = sigs.filter(f => contributionTone(f) === "negative").reduce((s, f) => s + Math.abs(f.points), 0);
                          const catNet = catPosPts - catNegPts;
                          const catTotal = catPosPts + catNegPts || 1;
                          const catMissing = sigs.filter(f => f.raw_value === null || f.raw_value === undefined).length;
                          const isActive = cat === currentCat;

                          return (
                            <button key={cat} onClick={() => setActiveCat(cat)} style={{ width: "100%", display: "block", textAlign: "left", padding: "10px 14px", background: isActive ? "var(--accent-wash)" : "transparent", borderLeft: `3px solid ${isActive ? meta.color : "transparent"}`, border: "none", borderLeftStyle: "solid", borderLeftWidth: 3, borderLeftColor: isActive ? meta.color : "transparent", cursor: "pointer", transition: "background var(--dur-fast) var(--ease)" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                                <span style={{ width: 22, height: 22, borderRadius: "var(--r-sm)", background: isActive ? `color-mix(in srgb, ${meta.color} 18%, transparent)` : "var(--paper)", color: isActive ? meta.color : "var(--ink-faint)", display: "grid", placeItems: "center", flexShrink: 0, border: `1px solid ${isActive ? `color-mix(in srgb, ${meta.color} 28%, transparent)` : "var(--rule)"}` }}>
                                  {meta.icon}
                                </span>
                                <span style={{ font: `${isActive ? "700" : "600"} 12px/1.25 var(--font)`, color: isActive ? "var(--ink)" : "var(--ink-soft)", lineHeight: 1.25 }}>{meta.label}</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 29 }}>
                                <div style={{ flex: 1, height: 3, borderRadius: "var(--r-pill)", overflow: "hidden", background: "var(--rule)", display: "flex" }}>
                                  <div style={{ height: "100%", width: `${(catPosPts / catTotal) * 100}%`, background: "var(--good)" }} />
                                  <div style={{ height: "100%", width: `${(catNegPts / catTotal) * 100}%`, background: "var(--bad)" }} />
                                </div>
                                <span style={{ font: "700 10.5px/1 var(--font-mono)", color: catNet > 0 ? "var(--good)" : catNet < 0 ? "var(--bad)" : "var(--ink-faint)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                                  {catNet > 0 ? "+" : ""}{catNet.toFixed(0)}
                                </span>
                                {catMissing > 0 && (
                                  <span style={{ padding: "1px 5px", borderRadius: "var(--r-pill)", background: "var(--warn-wash)", color: "var(--warn)", font: "600 9px/1 var(--font)", flexShrink: 0 }}>{catMissing}</span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Right: signals panel */}
                      <div style={{ padding: "6px 18px 14px", overflowY: "auto", maxHeight: 480 }}>
                        {/* Panel header */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0 4px", marginBottom: 2 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                            <span style={{ color: CAT_META[currentCat]?.color, display: "grid", placeItems: "center" }}>{CAT_META[currentCat]?.icon}</span>
                            <span style={{ font: "700 12.5px/1 var(--font)", color: "var(--ink)" }}>{CAT_META[currentCat]?.label}</span>
                            <span style={{ padding: "2px 7px", borderRadius: "var(--r-pill)", background: "var(--rule)", color: "var(--ink-faint)", font: "600 10px/1 var(--font)" }}>{panelSignals.length} signals</span>
                          </div>
                        </div>

                        {visibleSignals.length > 0
                          ? visibleSignals.map((f, i) =>
                              signalFilter === "missing"
                                ? (
                                  <div key={f.feature ?? i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--rule-soft)", opacity: 0.6 }}>
                                    <span style={{ color: "var(--ink-soft)", font: "600 12px/1 var(--font)" }}>{f.label}</span>
                                    <span style={{ color: "var(--ink-faint)", font: "500 11px/1 var(--font-mono)" }}>No data</span>
                                  </div>
                                )
                                : <SignalRow key={f.feature ?? i} f={f} barColor={contributionTone(f) === "positive" ? "var(--good)" : "var(--bad)"} maxPts={maxPts} />
                            )
                          : (
                            <div style={{ padding: "32px 0", textAlign: "center", color: "var(--ink-faint)", font: "400 12.5px/1.5 var(--font)" }}>
                              No {signalFilter === "all" ? "" : signalFilter + " "}signals in this category.
                            </div>
                          )
                        }
                      </div>
                    </div>

                    {/* ── Footer ── */}
                    <div style={{ padding: "9px 18px", borderTop: "1px solid var(--rule)", background: "var(--paper)" }}>
                      <span style={{ font: "500 11.5px/1 var(--font)", color: "var(--ink-faint)" }}>
                        {allContribs.length} signals · {coveredSignals} with data · {missingCount} missing
                      </span>
                    </div>
                  </Card>
                );
              })()}
            </div>
          )}

          {/* ══ BUREAU REPORT ═════════════════════════════════════════════════════ */}
          {tab === "bureau" && (
            <div style={{ display: "grid", gap: 16 }}>
              {!bureau && Object.keys(crcPayload).length === 0
                ? <EmptyState icon={<Gauge size={22} />} title="No bureau pull" description="No bureau query was triggered for this decision." />
                : <>
                    {/* Dual-bureau selector */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <BureauSelectorCard
                        name="CRC Credit Bureau"
                        score={bureauScore}
                        enq30d={enquiries30d}
                        openLoans={activeLoans}
                        defaults={delinquentAccounts}
                        quality={delinquentAccounts > 0 ? "has-defaults" : bureauScore != null ? "clean" : "thin"}
                        selected={bureauTab === "crc"}
                        onClick={() => { bureauTabTouched.current = true; setBureauTab("crc"); }}
                      />
                      <BureauSelectorCard
                        name="FirstCentral (XDS)"
                        score={fcScore}
                        enq30d={fcEnq30d}
                        openLoans={fcOpen}
                        defaults={fcDef}
                        quality={(fcDef ?? 0) > 0 ? "has-defaults" : fcHasReport ? "clean" : "thin"}
                        selected={bureauTab === "firstcentral"}
                        onClick={() => { bureauTabTouched.current = true; setBureauTab("firstcentral"); }}
                      />
                    </div>

                    {/* CRC empty state — separates a FAILED lookup from a genuine
                        no-file result. Both previously rendered as a silently blank
                        tab, which reads as "this applicant has no credit history"
                        when the truth may be "the bureau call errored". */}
                    {!hasActiveFull && bureauTab === "crc" && (
                      <EmptyState
                        title={crcErrored ? "CRC lookup failed" : "No CRC data"}
                        description={crcEmptyBody}
                      />
                    )}

                    {/* FC empty state */}
                    {!hasActiveFull && bureauTab === "firstcentral" && (
                      <EmptyState title="No FirstCentral data" description={firstCentralEmptyBody} />
                    )}

                    {/* Bureau content */}
                    {hasActiveFull && (
                      <>
                        {/* Staleness warning */}
                        {!bureauFresh && bureauDaysAgo != null && (
                          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: "var(--r-lg)", background: "var(--warn-wash)", border: "1px solid color-mix(in srgb, var(--warn) 28%, transparent)" }}>
                            <AlertTriangle size={15} style={{ color: "var(--warn)", flexShrink: 0 }} />
                            <span style={{ font: "500 12.5px/1.4 var(--font)", color: "var(--ink)" }}>
                              Bureau data is <strong>{bureauDaysAgo} days old</strong> — consider refreshing before a final credit decision.
                            </span>
                          </div>
                        )}

                        {/* Profile */}
                        <Card>
                          <Kicker>Profile (as reported by {activeName})</Kicker>
                          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid var(--rule)" }}>
                            <div style={{ width: 46, height: 46, borderRadius: "50%", flexShrink: 0, display: "grid", placeItems: "center", background: "linear-gradient(135deg, var(--accent-2), var(--accent))", color: "#fff", font: "750 16px/1 var(--font)", boxShadow: "var(--shadow-accent)" }}>
                              {(pickName(activeIdentity) ?? "A").split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()}
                            </div>
                            <div>
                              <div style={{ color: "var(--ink)", font: "760 16px/1.2 var(--font)" }}>{pickName(activeIdentity) ?? "Applicant"}</div>
                              {activeIdText("bvn", "bvn_confirmed") && (
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                                  <span style={{ color: "var(--ink-faint)", font: "500 12px/1.4 var(--font-mono)" }}>BVN {activeIdText("bvn", "bvn_confirmed")}</span>
                                  {text(deepFind(crcPayload, ["bvn_confirmed"]))
                                    ? <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 7px", borderRadius: "var(--r-pill)", background: "var(--good-wash)", color: "var(--good)", font: "650 10px/1 var(--font)" }}><CheckCircle2 size={10} /> Confirmed</span>
                                    : <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 7px", borderRadius: "var(--r-pill)", background: "var(--warn-wash)", color: "var(--warn)", font: "650 10px/1 var(--font)" }}><AlertTriangle size={10} /> Unconfirmed</span>
                                  }
                                </div>
                              )}
                            </div>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0 24px" }}>
                            {[
                              { label: "Gender", value: activeIdText("gender", "sex", "gender_code") ? titleCase(activeIdText("gender", "sex", "gender_code")!) : "—" },
                              { label: "Date of birth", value: (() => { const dob = activeIdText("date_of_birth", "dob", "birth_date", "birthdate", "dateofbirth"); if (!dob) return "—"; const age = ageFromDOB(dob); return age != null ? `${formatDate(dob)} (${age} yrs)` : formatDate(dob); })() },
                              { label: "Nationality", value: activeIdText("nationality", "country", "country_of_birth", "resident_country") ? titleCase(activeIdText("nationality", "country", "country_of_birth", "resident_country")!) : "—" },
                              { label: "Phone", value: activeIdText("phone", "phone_number", "mobile", "mobile_number", "telephone", "gsm", "msisdn") ?? "—" },
                              { label: "Email", value: activeIdText("email", "email_address") ?? "—" },
                            ].map(f => (
                              <div key={f.label} style={{ padding: "10px 0", borderBottom: "1px solid var(--rule-soft)" }}>
                                <div style={{ color: "var(--ink-faint)", font: "600 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5 }}>{f.label}</div>
                                <div style={{ color: "var(--ink)", font: "600 13px/1.35 var(--font)" }}>{f.value}</div>
                              </div>
                            ))}
                          </div>
                          {addressHistory.length > 0 && (
                            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--rule-soft)" }}>
                              <div style={{ color: "var(--ink-faint)", font: "600 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Address history</div>
                              {addressHistory.slice(0, 3).map((addr, i) => (
                                <div key={i} style={{ color: i === 0 ? "var(--ink)" : "var(--ink-soft)", font: `${i === 0 ? "600" : "500"} 12.5px/1.4 var(--font)`, marginBottom: 4 }}>
                                  {i === 0 ? "● " : "○ "}{addr}
                                </div>
                              ))}
                            </div>
                          )}
                        </Card>

                        {/* Bureau score */}
                        {activeScore != null && (
                          <Card>
                            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                              <span style={{ font: "800 58px/0.9 var(--font-mono)", color: "var(--ink)", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>{activeScore}</span>
                              <span style={{ font: "600 15px/1 var(--font)", color: "var(--ink-faint)", marginBottom: 6 }}>/ 850</span>
                              <Chip
                                label={activeScore >= 740 ? "Excellent" : activeScore >= 680 ? "Good" : activeScore >= 580 ? "Fair" : "Poor"}
                                tone={activeScore >= 680 ? "success" : activeScore >= 580 ? "warn" : "danger"}
                              />
                            </div>
                            {(() => {
                              const rating = text(deepFind(activePayload, ["credit_rating", "rating", "bureau_rating"]));
                              const desc = activeScore >= 740 ? "Excellent credit history with a strong repayment record and low default risk."
                                : activeScore >= 680 ? "Good credit profile — above-average band, minor risk indicators may be present."
                                : activeScore >= 580 ? "Fair file with moderate risk indicators. Requires closer review of bureau data."
                                : "Poor credit history — significant risk factors detected. Consider declining or referring.";
                              return (
                                <div style={{ marginBottom: 14, padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--paper)", border: "1px solid var(--rule)" }}>
                                  {rating && <div style={{ font: "700 12.5px/1 var(--font)", color: "var(--ink)", marginBottom: 4 }}>{titleCase(rating)}</div>}
                                  <div style={{ font: "400 12.5px/1.5 var(--font)", color: "var(--ink-faint)" }}>{desc}</div>
                                </div>
                              );
                            })()}
                            <div style={{ position: "relative", height: 14, borderRadius: "var(--r-pill)", background: "linear-gradient(90deg, #d63b3b 0%, #ef8a35 22%, #dec23d 44%, #92c83e 64%, #5dbb82 80%, #3d8f7b 100%)", marginBottom: 4, boxShadow: "0 2px 8px -2px rgba(0,0,0,0.15)" }}>
                              <span style={{ position: "absolute", left: `${Math.max(0, Math.min(100, ((activeScore - 300) / 550) * 100))}%`, top: -6, width: 4, height: 26, borderRadius: 4, background: "var(--ink)", transform: "translateX(-2px)", boxShadow: "0 0 0 3px var(--panel), 0 2px 8px rgba(0,0,0,0.25)" }} />
                            </div>
                            <div style={{ position: "relative", height: 16, color: "var(--ink-faint)", font: "600 11px/1 var(--font-mono)" }}>
                              {[300, 580, 680, 740, 850].map(n => {
                                const pct = ((n - 300) / 550) * 100;
                                return (
                                  <span key={n} style={{ position: "absolute", left: `${pct}%`, transform: n === 300 ? "none" : n === 850 ? "translateX(-100%)" : "translateX(-50%)" }}>{n}</span>
                                );
                              })}
                            </div>
                          </Card>
                        )}

                        {/* Stats grid */}
                        <Card>
                          <div style={{ color: "var(--ink-faint)", font: "600 11px/1 var(--font-mono)", marginBottom: 14 }}>
                            CIR: {cirNumber} · Report date {reportDate}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
                            {/* Accounts */}
                            <div>
                              <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Accounts</div>
                              <div style={{ font: "760 22px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                                {text(deepFind(activePayload, ["accounts", "total_accounts", "total_facilities"])) ?? (activeFacilities.length ? String(activeFacilities.length) : "—")}
                              </div>
                            </div>
                            {/* Active — dual sub-columns */}
                            <div>
                              <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Active</div>
                              <div style={{ display: "flex", gap: 20, alignItems: "flex-end" }}>
                                <div>
                                  <div style={{ color: "var(--ink-faint)", font: "600 10px/1 var(--font)", letterSpacing: "0.06em", marginBottom: 4 }}>{bureauTab === "crc" ? "CRC" : "XDS"}</div>
                                  <div style={{ font: "760 22px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                                    {activeFacilities.length ? String(activeCount) : text(deepFind(activePayload, ["active", "active_facilities", "open_loans"])) ?? "—"}
                                  </div>
                                </div>
                                <div>
                                  <div style={{ color: "var(--ink-faint)", font: "600 10px/1 var(--font)", letterSpacing: "0.06em", marginBottom: 4 }}>ACTUAL</div>
                                  <div style={{ font: "760 22px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                                    {activeFacilities.length ? String(activeCount) : text(deepFind(activePayload, ["actual_active", "actual_open_loans"])) ?? "—"}
                                  </div>
                                </div>
                              </div>
                            </div>
                            {/* Delinquent */}
                            <div>
                              <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Delinquent</div>
                              <div style={{ font: "760 22px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: delinqCount > 0 ? "var(--bad)" : "var(--ink)" }}>
                                {activeFacilities.length ? String(delinqCount) : text(deepFind(activePayload, ["delinquent", "delinquent_accounts", "defaults"])) ?? "—"}
                              </div>
                            </div>
                            {/* Outstanding — dual sub-columns */}
                            <div>
                              <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Outstanding</div>
                              <div style={{ display: "flex", gap: 20, alignItems: "flex-end" }}>
                                <div>
                                  <div style={{ color: "var(--ink-faint)", font: "600 10px/1 var(--font)", letterSpacing: "0.06em", marginBottom: 4 }}>{bureauTab === "crc" ? "CRC" : "XDS"}</div>
                                  <div style={{ font: "760 16px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                                    {activeFacilities.length ? bureauMoney(outstandingSum, currency) : bureauMoney(deepFind(activePayload, ["actual_outstanding", "actual_balance", "outstanding", "total_outstanding", "total_debt"]), currency)}
                                  </div>
                                </div>
                                <div>
                                  <div style={{ color: "var(--ink-faint)", font: "600 10px/1 var(--font)", letterSpacing: "0.06em", marginBottom: 4 }}>ACTUAL</div>
                                  <div style={{ font: "760 16px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                                    {activeFacilities.length ? bureauMoney(outstandingSum, currency) : bureauMoney(deepFind(activePayload, ["actual_outstanding", "actual_balance"]), currency)}
                                  </div>
                                </div>
                              </div>
                            </div>
                            {/* Overdue */}
                            <div>
                              <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Overdue</div>
                              <div style={{ font: "760 16px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--bad)" }}>
                                {bureauMoney(deepFind(activePayload, ["overdue", "overdue_amount", "total_overdue"]), currency)}
                              </div>
                            </div>
                            {/* Enquiries 30d */}
                            <div>
                              <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Enquiries 30d</div>
                              <div style={{ font: "760 22px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                                {text(deepFind(activePayload, ["inquiries_30d", "enquiries30d", "enquiries_30d"])) ?? "—"}
                              </div>
                            </div>
                            {/* Enquiries 3m */}
                            <div>
                              <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Enquiries 3m</div>
                              <div style={{ font: "760 22px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                                {text(deepFind(activePayload, ["inquiries_3m", "enquiries_3months", "enquiries3m"])) ?? "—"}
                              </div>
                            </div>
                            {/* Enquiries 12m */}
                            <div>
                              <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Enquiries 12m</div>
                              <div style={{ font: "760 22px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>
                                {text(deepFind(activePayload, ["inquiries_12m", "enquiries_12months", "enquiries12m"])) ?? "—"}
                              </div>
                            </div>
                            {/* Max DPD */}
                            <div>
                              <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Max DPD (ever)</div>
                              <div style={{ font: "760 22px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", color: (num(deepFind(activePayload, ["max_overdue_days","max_dpd","max_days_past_due","highest_dpd"])) ?? 0) > 0 ? "var(--bad)" : "var(--ink)" }}>
                                {text(deepFind(activePayload, ["max_overdue_days","max_dpd","max_days_past_due","highest_dpd"])) != null ? `${text(deepFind(activePayload, ["max_overdue_days","max_dpd","max_days_past_due","highest_dpd"]))}d` : "—"}
                              </div>
                            </div>
                          </div>
                        </Card>

                        {/* Performance by institution */}
                        {institutionRows.length > 0 && (
                          <Card noPad>
                            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                              <Kicker>Performance by institution</Kicker>
                            </div>
                            <div style={{ overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", font: "500 12.5px/1.35 var(--font)", minWidth: 480 }}>
                                <thead>
                                  <tr style={{ background: "var(--paper)" }}>
                                    {["Institution", "Fac.", "PF", "NPL", "Outstanding"].map(h => (
                                      <th key={h} style={{ textAlign: "left", padding: "9px 16px", borderBottom: "1px solid var(--rule)", color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {institutionRows.map((row, i) => (
                                    <tr key={i} style={{ borderBottom: "1px solid var(--rule-soft)" }}>
                                      <td style={{ padding: "10px 16px", color: "var(--ink)", fontWeight: 600, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.institution}</td>
                                      <td style={{ padding: "10px 16px", color: "var(--ink-soft)" }}>{row.fac || "—"}</td>
                                      <td style={{ padding: "10px 16px", color: "var(--good)", fontWeight: 600 }}>{row.pf || "—"}</td>
                                      <td style={{ padding: "10px 16px", color: row.npl > 0 ? "var(--bad)" : "var(--ink-soft)", fontWeight: row.npl > 0 ? 700 : 400 }}>{row.npl || "—"}</td>
                                      <td style={{ padding: "10px 16px", color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{row.outstanding > 0 ? bureauMoney(row.outstanding, currency) : "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div style={{ padding: "8px 16px 12px", color: "var(--ink-faint)", font: "500 11px/1.4 var(--font)", display: "flex", gap: 14, flexWrap: "wrap" }}>
                              <span><strong style={{ color: "var(--ink-soft)" }}>Fac.</strong> = Total facilities</span>
                              <span><strong style={{ color: "var(--ink-soft)" }}>PF</strong> = Performing facilities</span>
                              <span><strong style={{ color: "var(--ink-soft)" }}>NPL</strong> = Non-performing loan</span>
                            </div>
                          </Card>
                        )}

                        {/* Aggregate payment rate */}
                        {activeFacilities.length > 0 && (() => {
                          const totPaid = activeFacilities.reduce((s, f) => s + facilityPaymentRate(f).paidCount, 0);
                          const totCount = activeFacilities.reduce((s, f) => s + facilityPaymentRate(f).totalCount, 0);
                          if (totCount === 0) return null;
                          const aggRate = Math.round((totPaid / totCount) * 100);
                          const rateCol = aggRate >= 90 ? "var(--good)" : aggRate >= 70 ? "var(--warn)" : "var(--bad)";
                          return (
                            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 16, alignItems: "center", padding: "14px 18px", background: "var(--panel)", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)" }}>
                              <div>
                                <div style={{ color: "var(--ink-faint)", font: "600 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Overall repayment rate</div>
                                <div style={{ font: "700 26px/1 var(--font-mono)", color: rateCol, fontVariantNumeric: "tabular-nums" }}>{aggRate}%</div>
                              </div>
                              <div style={{ height: 10, background: "var(--rule)", borderRadius: "var(--r-pill)", overflow: "hidden" }}>
                                <div style={{ height: "100%", width: `${aggRate}%`, background: rateCol, borderRadius: "var(--r-pill)", transition: "width var(--dur-slow) var(--ease)" }} />
                              </div>
                              <div style={{ color: "var(--ink-faint)", font: "500 12px/1.3 var(--font)", textAlign: "right" }}>
                                {totPaid} / {totCount}<br />payments
                              </div>
                            </div>
                          );
                        })()}

                        {/* Credit facilities */}
                        {activeFacilities.length > 0 && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
                              <Kicker>Credit facilities ({activeFacilities.length})</Kicker>
                              <span style={{ color: "var(--ink-faint)", font: "500 11px/1 var(--font)" }}>Click ▼ Payments to see history</span>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {(showAllFacilities ? activeFacilities : activeFacilities.slice(0, 8)).map((f, i) => (
                                <FacilityCard key={i} item={f} currency={currency} bureauName={activeName} />
                              ))}
                            </div>
                            {activeFacilities.length > 8 && (
                              <button
                                onClick={() => setShowAllFacilities(v => !v)}
                                style={{ marginTop: 10, border: "1px solid var(--rule)", background: "var(--panel)", color: "var(--accent)", borderRadius: "var(--r-lg)", padding: "9px 16px", font: "600 13px/1 var(--font)", cursor: "pointer", width: "100%" }}
                              >
                                {showAllFacilities ? "Show fewer" : `Show all ${activeFacilities.length} facilities`}
                              </button>
                            )}
                          </div>
                        )}

                        {/* Reported contact details */}
                        {activeContacts.length > 0 && (() => {
                          const seen = new Set<string>();
                          const deduped = [...activeContacts].sort((a, b) => {
                            const ar = asRecord(a), br = asRecord(b);
                            return (parseProviderDate(text(asRecord(br).date_reported ?? asRecord(br).reported_at ?? asRecord(br).date))?.getTime() ?? 0)
                              - (parseProviderDate(text(asRecord(ar).date_reported ?? asRecord(ar).reported_at ?? asRecord(ar).date))?.getTime() ?? 0);
                          }).slice(0, 40).flatMap(item => {
                            const rec = asRecord(item);
                            const rawType = (text(rec.type ?? rec.channel) ?? "").toUpperCase();
                            const type = rawType.includes("EMAIL") ? "EMAIL" : rawType.includes("MOBILE") ? "MOBILE" : "PHONE";
                            const value = text(rec.value ?? rec.number ?? rec.email) ?? text(item) ?? "";
                            if (!value || value === "<nil>") return [];
                            const norm = value.replace(/\D/g, "").replace(/^234/, "0").slice(-10);
                            const key = type + ":" + (norm || value.toLowerCase());
                            if (seen.has(key)) return [];
                            seen.add(key);
                            const display = type !== "EMAIL"
                              ? value.replace(/^0(\d{3})(\d{3})(\d{4})$/, "+234 $1 $2 $3")
                                     .replace(/^(\+234)(\d{3})(\d{3})(\d{4})$/, "$1 $2 $3 $4")
                                     .replace(/^(234)(\d{3})(\d{3})(\d{4})$/, "+$1 $2 $3 $4")
                              : value.toLowerCase();
                            const dateStr = formatDate(text(rec.date_reported ?? rec.reported_at ?? rec.date));
                            return [{ type, display, date: dateStr === "—" ? "" : dateStr }];
                          });
                          return (
                            <Card noPad>
                              <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--rule)" }}>
                                <Kicker>Reported contact details ({deduped.length})</Kicker>
                              </div>
                              <div style={{ padding: "0 18px" }}>
                                {deduped.map((c, i) => (
                                  <div key={i} style={{ display: "grid", gridTemplateColumns: "52px 1fr auto", gap: "0 10px", alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--rule-soft)" }}>
                                    <span style={{ font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-faint)" }}>{c.type}</span>
                                    <span style={{ font: "600 13px/1.3 var(--font)", color: "var(--ink)", overflowWrap: "anywhere" }}>{c.display}</span>
                                    {c.date && <span style={{ font: "500 11px/1 var(--font-mono)", color: "var(--ink-faint)", whiteSpace: "nowrap" }}>{c.date}</span>}
                                  </div>
                                ))}
                              </div>
                            </Card>
                          );
                        })()}

                        {/* Cohort comparison */}
                        {cohortData.length > 0 && (
                          <Card noPad>
                            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--rule)" }}>
                              <Kicker>Cohort comparison</Kicker>
                            </div>
                            <div style={{ overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", font: "500 12.5px/1.35 var(--font)", minWidth: 400 }}>
                                <thead>
                                  <tr style={{ background: "var(--paper)" }}>
                                    {["Feature", "This customer", "Cohort median", "Cohort P90"].map(h => (
                                      <th key={h} style={{ textAlign: "left", padding: "9px 14px", borderBottom: "1px solid var(--rule)", color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {cohortData.map((row, i) => (
                                    <tr key={i} style={{ borderBottom: "1px solid var(--rule-soft)" }}>
                                      <td style={{ padding: "9px 14px", color: "var(--ink)", fontWeight: 600 }}>{text(row.feature ?? row.name ?? row.metric) ?? "—"}</td>
                                      <td style={{ padding: "9px 14px", color: "var(--accent-ink)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{text(row.value ?? row.customer_value) ?? "—"}</td>
                                      <td style={{ padding: "9px 14px", color: "var(--ink-soft)", fontVariantNumeric: "tabular-nums" }}>{text(row.median ?? row.cohort_median) ?? "—"}</td>
                                      <td style={{ padding: "9px 14px", color: "var(--ink-soft)", fontVariantNumeric: "tabular-nums" }}>{text(row.p90 ?? row.cohort_p90) ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </Card>
                        )}

                        {/* BVN enquiry history */}
                        {bvnInquiryHistory.length > 0 && (
                          <Card noPad>
                            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--rule)" }}>
                              <Kicker>BVN enquiry history ({bvnInquiryHistory.length})</Kicker>
                            </div>
                            <div style={{ overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", font: "500 12.5px/1.35 var(--font)", minWidth: 440 }}>
                                <thead>
                                  <tr style={{ background: "var(--paper)" }}>
                                    {["Date", "Institution", "Type", "Facility"].map(h => (
                                      <th key={h} style={{ textAlign: "left", padding: "9px 14px", borderBottom: "1px solid var(--rule)", color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {bvnInquiryHistory.slice(0, 20).map((inq, i) => (
                                    <tr key={i} style={{ borderBottom: "1px solid var(--rule-soft)" }}>
                                      <td style={{ padding: "9px 14px", color: "var(--ink-faint)", whiteSpace: "nowrap" }}>{formatDate(text(inq.date ?? inq.inquiry_date ?? inq.enquiry_date))}</td>
                                      <td style={{ padding: "9px 14px", color: "var(--ink)", fontWeight: 600 }}>{text(inq.institution ?? inq.institution_name ?? inq.lender) ?? "—"}</td>
                                      <td style={{ padding: "9px 14px", color: "var(--ink-soft)" }}>{text(inq.institution_type ?? inq.type) ?? "—"}</td>
                                      <td style={{ padding: "9px 14px", color: "var(--ink-soft)" }}>{text(inq.facility_type ?? inq.product ?? inq.loan_type) ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </Card>
                        )}

                        {/* CRC Corporate (shown only on CRC tab when has_report = true) */}
                        {bureauTab === "crc" && hasCrcCorporate && (
                          <Card>
                            <Kicker>CRC Corporate</Kicker>
                            <div style={{ display: "grid", gap: 0 }}>
                              {[
                                ["RC number", text(deepFind(crcCorporate, ["rc_number", "rc"]))],
                                ["Company name", text(deepFind(crcCorporate, ["company_name", "name"]))],
                                ["Status", text(deepFind(crcCorporate, ["status", "company_status"]))],
                                ["Outstanding (corporate)", bureauMoney(deepFind(crcCorporate, ["outstanding", "total_outstanding"]), currency)],
                              ].map(([label, value]) => value ? <InfoRow key={label as string} label={label as string} value={value as string} /> : null)}
                            </div>
                          </Card>
                        )}

                        {/* Query metadata */}
                        {bureau && (
                          <Card>
                            <Kicker>Query metadata</Kicker>
                            <InfoRow label="Query type" value={bureau.query_type} />
                            <InfoRow label="Fetched" value={formatDateTime(bureau.fetched_at)} />
                            <InfoRow label="Bureau charged" value={bureau.charged ? "Yes" : "No"} />
                            <InfoRow label="Data age" value={relativeDate(bureauFetched)} />
                          </Card>
                        )}
                      </>
                    )}
                  </>
              }
            </div>
          )}

          {/* ══ ACCOUNT STATEMENT ═════════════════════════════════════════════════ */}
          {tab === "statement" && (
            <div style={{ display: "grid", gap: 16 }}>
              {!statement
                ? <EmptyState icon={<Gauge size={22} />} title="No bank statement" description="No statement is linked — scored on bureau and declared data only." />
                : <>
                    {/* Flagged patterns */}
                    {(() => {
                      const s = statement!;
                      type Flag = { icon: ReactNode; label: string; value: string; tone: "good" | "bad" | "warn" };
                      const flags: Flag[] = [];

                      // ── Positive signals ──────────────────────────────────
                      if (s.salary_regularity_score != null && s.salary_regularity_score > 0.3)
                        flags.push({ icon: <CheckCircle2 size={14} />, label: "Salary detected", value: `${pct(s.salary_regularity_score)} regularity`, tone: "good" });
                      if (s.loan_repayment_detected)
                        flags.push({ icon: <Landmark size={14} />, label: "Loan repayments", value: "Detected in transactions", tone: "good" });
                      if (s.savings_rate != null && s.savings_rate > 0.15)
                        flags.push({ icon: <TrendingUp size={14} />, label: "Consistent saver", value: `${pct(s.savings_rate)} savings rate`, tone: "good" });

                      // ── Risk signals ──────────────────────────────────────
                      if (s.bounce_count_per_month != null && s.bounce_count_per_month >= 1)
                        flags.push({ icon: <AlertTriangle size={14} />, label: "Returned debits", value: `~${s.bounce_count_per_month.toFixed(1)} / month`, tone: "bad" });
                      if (s.gambling_ratio != null && s.gambling_ratio > 0.05)
                        flags.push({ icon: <AlertTriangle size={14} />, label: "Gambling spend", value: `${pct(s.gambling_ratio)} of debits`, tone: "bad" });
                      if (s.avg_monthly_credits_minor != null && s.avg_monthly_debits_minor != null && s.avg_monthly_debits_minor > s.avg_monthly_credits_minor)
                        flags.push({ icon: <TrendingDown size={14} />, label: "Spending exceeds income", value: `outflow ${pct(s.avg_monthly_credits_minor > 0 ? s.avg_monthly_debits_minor / s.avg_monthly_credits_minor - 1 : 1)} above inflow`, tone: "bad" });
                      if (s.dscr != null && s.dscr < 1.0)
                        flags.push({ icon: <XCircle size={14} />, label: "DSCR below 1.0", value: `${pct(s.dscr)} — income may not cover debt`, tone: "bad" });
                      if (s.closing_balance_minor != null && s.closing_balance_minor < 0)
                        flags.push({ icon: <XCircle size={14} />, label: "Account overdrawn", value: `${formatMoney(Math.abs(s.closing_balance_minor), currency)} deficit at close`, tone: "bad" });

                      // ── Data quality ──────────────────────────────────────
                      if (s.months_of_data != null && s.months_of_data < 3)
                        flags.push({ icon: <Clock size={14} />, label: "Thin statement", value: `Only ${s.months_of_data} month${s.months_of_data === 1 ? "" : "s"} of data`, tone: "warn" });

                      if (flags.length === 0) return null;

                      const bgOf  = (t: Flag["tone"]) => t === "good" ? "var(--good-wash)"  : t === "bad" ? "var(--bad-wash)"  : "var(--warn-wash)";
                      const colOf = (t: Flag["tone"]) => t === "good" ? "var(--good)"        : t === "bad" ? "var(--bad)"        : "var(--warn)";
                      const bdrOf = (t: Flag["tone"]) => `color-mix(in srgb, ${colOf(t)} 22%, transparent)`;

                      return (
                        <Card>
                          <Kicker>Flagged patterns</Kicker>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))", gap: 10 }}>
                            {flags.map((f, i) => (
                              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderRadius: "var(--r-md)", background: bgOf(f.tone), border: `1px solid ${bdrOf(f.tone)}` }}>
                                <span style={{ color: colOf(f.tone), flexShrink: 0, marginTop: 1 }}>{f.icon}</span>
                                <div>
                                  <div style={{ font: "700 12px/1 var(--font)", color: colOf(f.tone) }}>{f.label}</div>
                                  <div style={{ font: "500 11.5px/1.35 var(--font)", color: "var(--ink-soft)", marginTop: 3 }}>{f.value}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </Card>
                      );
                    })()}

                    {/* Header card */}
                    <Card>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ color: "var(--ink-faint)", font: "700 10px/1 var(--font)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>{displaySource(statement.source)}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                            {statement.institution_name && <BankLogo bankKey={statement.institution_name} size={28} />}
                            <div style={{ color: "var(--ink)", font: "750 16px/1.25 var(--font)" }}>{bankName ?? "Bank"}</div>
                          </div>
                          {statement.account_name && <div style={{ color: "var(--ink-soft)", font: "500 13px/1.45 var(--font)", marginTop: 3 }}>{statement.account_name}</div>}
                          {statement.account_number && <div style={{ color: "var(--ink-faint)", font: "600 12px/1.4 var(--font-mono)", marginTop: 2 }}>{statement.account_number}</div>}
                          {statement.parser_method && (
                            <div style={{ marginTop: 8 }}>
                              <ExtractionConfidenceLine result={statement} />
                            </div>
                          )}
                          {statement.auth_risk_score != null && (
                            <div style={{ marginTop: 6 }}>
                              <TamperRiskLine riskScore={statement.auth_risk_score} flags={statement.auth_flags} />
                            </div>
                          )}
                        </div>
                        <div style={{ textAlign: "right", color: "var(--ink-faint)", font: "600 12px/1.45 var(--font)" }}>
                          {statement.period_start && statement.period_end ? `${formatDate(statement.period_start)} → ${formatDate(statement.period_end)}` : "Statement summary"}
                          <div style={{ marginTop: 2, font: "500 11.5px/1.4 var(--font)" }}>parsed at scoring time</div>
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, paddingTop: 16, borderTop: "1px solid var(--rule)" }}>
                        <TonedStat label="Avg monthly inflow" value={statement.avg_monthly_credits_minor != null ? formatMoney(statement.avg_monthly_credits_minor, currency) : "—"} tone="good" />
                        <TonedStat label="Avg monthly outflow" value={statement.avg_monthly_debits_minor != null ? formatMoney(statement.avg_monthly_debits_minor, currency) : "—"} />
                        <TonedStat label="Avg balance" value={statement.closing_balance_minor != null ? formatMoney(statement.closing_balance_minor, currency) : "—"} />
                        <TonedStat label="Salary" value={statement.salary_regularity_score != null && statement.salary_regularity_score > 0.3 ? "Detected" : "—"} tone={statement.salary_regularity_score != null && statement.salary_regularity_score > 0.3 ? "good" : undefined} />
                        <TonedStat label="Income stability" value={statement.salary_regularity_score != null ? pct(statement.salary_regularity_score) : "—"} tone={statement.salary_regularity_score != null ? (statement.salary_regularity_score >= 0.7 ? "good" : statement.salary_regularity_score >= 0.4 ? "warn" : "bad") : undefined} />
                        <TonedStat label="Months overdrawn" value={statement.bounce_count_per_month != null && statement.bounce_count_per_month > 0 ? String(Math.round(statement.bounce_count_per_month)) : "None"} tone={statement.bounce_count_per_month != null && statement.bounce_count_per_month > 0 ? "warn" : "good"} />
                      </div>
                    </Card>

                    {/* Monthly cash flow chart — per-month bars if monthly_breakdown available, else horizontal summary */}
                    {monthlyBreakdown.length > 0 ? (
                      <Card>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18 }}>
                          <Kicker>Monthly cash flow</Kicker>
                          <span style={{ color: "var(--ink-faint)", font: "500 12.5px/1 var(--font)" }}>{bankName ?? "Bank"}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 120, padding: "8px 0" }}>
                          {chartMonths.map((m, i) => {
                            const mb = monthlyBreakdown[i];
                            const mIn = num(mb?.credits_minor) ?? 0;
                            const mOut = num(mb?.debits_minor) ?? 0;
                            return (
                              <div key={m} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 92, width: "100%", justifyContent: "center" }}>
                                  <div style={{ width: 14, height: `${Math.max(8, (mIn / chartMax) * 92)}px`, background: "var(--good)", borderRadius: "3px 3px 0 0" }} />
                                  <div style={{ width: 14, height: `${Math.max(8, (mOut / chartMax) * 92)}px`, background: "var(--bad)", borderRadius: "3px 3px 0 0" }} />
                                </div>
                                <span style={{ font: "500 11px/1 var(--font-mono)", color: "var(--ink-faint)" }}>{m}</span>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 8, font: "500 11px/1 var(--font)", color: "var(--ink-faint)" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                            <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--good)", display: "inline-block" }} /> Inflow
                          </span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                            <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--bad)", display: "inline-block" }} /> Outflow
                          </span>
                        </div>
                      </Card>
                    ) : statement.avg_monthly_credits_minor != null && statement.avg_monthly_debits_minor != null ? (
                      <Card>
                        <Kicker>Cashflow summary</Kicker>
                        <div style={{ display: "grid", gap: 14 }}>
                          {[
                            { label: "Avg monthly inflow", value: statement.avg_monthly_credits_minor, color: "var(--good)", glow: "rgba(34,122,91,0.35)" },
                            { label: "Avg monthly outflow", value: statement.avg_monthly_debits_minor, color: "var(--bad)", glow: "rgba(176,59,51,0.35)" },
                            ...(statement.closing_balance_minor != null ? [{ label: "Closing balance", value: statement.closing_balance_minor, color: "var(--accent)", glow: "rgba(69,82,160,0.35)" }] : []),
                          ].map(bar => {
                            const maxVal = Math.max(1, statement.avg_monthly_credits_minor!, statement.avg_monthly_debits_minor!, statement.closing_balance_minor ?? 0);
                            return (
                              <div key={bar.label} style={{ display: "grid", gridTemplateColumns: "150px 1fr auto", gap: 14, alignItems: "center" }}>
                                <span style={{ color: "var(--ink-faint)", font: "500 12.5px/1 var(--font)" }}>{bar.label}</span>
                                <div style={{ height: 12, background: "var(--rule)", borderRadius: "var(--r-pill)", overflow: "hidden" }}>
                                  <div style={{ height: "100%", width: `${Math.max(2, (bar.value / maxVal) * 100)}%`, background: bar.color, borderRadius: "var(--r-pill)", boxShadow: `0 0 10px -2px ${bar.glow}` }} />
                                </div>
                                <span style={{ color: bar.color, font: "700 13.5px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatMoney(bar.value, currency)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </Card>
                    ) : null}

                    {/* Metrics grid */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 12 }}>
                      <MetricCard label="DSCR" value={statement.dscr != null ? pct(statement.dscr) : "—"} />
                      <MetricCard label="Savings rate" value={statement.savings_rate != null ? pct(statement.savings_rate) : "—"} />
                      <MetricCard label="Gambling ratio" value={statement.gambling_ratio != null ? pct(statement.gambling_ratio) : "—"} valueColor={statement.gambling_ratio != null && statement.gambling_ratio > 0.05 ? "var(--bad)" : undefined} />
                      <MetricCard label="Transactions" value={statement.transaction_count != null ? String(statement.transaction_count) : "—"} />
                      <MetricCard label="Months of data" value={statement.months_of_data != null ? String(statement.months_of_data) : "—"} />
                      <MetricCard label="Bounces / mo" value={statement.bounce_count_per_month != null ? statement.bounce_count_per_month.toFixed(1) : "—"} valueColor={statement.bounce_count_per_month != null && statement.bounce_count_per_month >= 1 ? "var(--warn)" : undefined} />
                    </div>

                    {/* Detail rows */}
                    <Card>
                      <Kicker>Statement details</Kicker>
                      <InfoRow label="Period" value={`${formatDate(statement.period_start)} — ${formatDate(statement.period_end)}`} />
                      <InfoRow label="Source" value={displaySource(statement.source)} />
                      <InfoRow label="Loan repayment detected" value={statement.loan_repayment_detected != null ? (statement.loan_repayment_detected ? "Yes" : "No") : "—"} />
                      {statement.salary_regularity_score != null && <InfoRow label="Income stability score" value={pct(statement.salary_regularity_score)} />}
                      {statement.savings_rate != null && <InfoRow label="Savings rate" value={pct(statement.savings_rate)} />}
                      {statement.gambling_ratio != null && <InfoRow label="Gambling ratio" value={pct(statement.gambling_ratio)} />}
                      {statement.dscr != null && <InfoRow label="DSCR" value={pct(statement.dscr)} />}
                      {statement.bounce_count_per_month != null && <InfoRow label="Returned debits / month" value={`${statement.bounce_count_per_month.toFixed(1)}`} />}
                    </Card>

                    <StatementInsightsPanel statement={statement} currency={currency} periculum={statement.periculum} />

                    {/* Transaction table — filtered rows are paginated in slices of 50;
                        rendering all of a multi-thousand-row statement into the DOM at
                        once on first mount was the other half of the tab feeling frozen. */}
                    {stmtTransactions.length > 0 && (
                      <Card noPad>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid var(--rule)", gap: 12, flexWrap: "wrap" }}>
                          <Kicker>
                            Transactions ({filteredTransactions.length}{filteredTransactions.length !== stmtTransactions.length ? ` of ${stmtTransactions.length}` : ""})
                          </Kicker>
                          {txCategories.length > 1 && (
                            <select
                              value={txCategoryFilter}
                              onChange={e => setTxCategoryFilter(e.target.value)}
                              aria-label="Filter transactions by category"
                              style={{ padding: "5px 10px", borderRadius: "var(--r-sm)", border: "1px solid var(--rule)", background: "var(--paper)", font: "600 12px/1 var(--font)", color: "var(--ink-soft)" }}
                            >
                              <option value="all">All categories</option>
                              {txCategories.map(c => <option key={c} value={c}>{displaySource(c)}</option>)}
                            </select>
                          )}
                        </div>
                        <div style={{ maxHeight: 400, overflowY: "auto", overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", font: "500 12.5px/1.35 var(--font)", minWidth: 600 }}>
                            <thead style={{ position: "sticky", top: 0, background: "var(--paper)", zIndex: 1 }}>
                              <tr>
                                {["Date", "Narration", "Category", "Amount", "Balance"].map((h, ii) => (
                                  <th key={h} style={{ textAlign: ii >= 3 ? "right" : "left", padding: "9px 14px", borderBottom: "1px solid var(--rule)", color: "var(--ink-faint)", font: "700 10px/1 var(--font)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {filteredTransactions.slice(0, txVisibleCount).map((tx, i) => {
                                const isCredit = text(tx.direction) ? text(tx.direction)!.toLowerCase() === "credit" : (num(tx.amount_minor) ?? 0) > 0;
                                const amount = Math.abs(num(tx.amount_minor ?? tx.amount) ?? 0);
                                return (
                                  <tr key={i} style={{ height: 40, borderBottom: "1px solid var(--rule-soft)" }}>
                                    <td style={{ padding: "0 14px", color: "var(--ink-faint)", whiteSpace: "nowrap" }}>{formatDate(text(tx.date ?? tx.transaction_date))}</td>
                                    <td style={{ padding: "0 14px", color: "var(--ink)", fontWeight: 600, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={text(tx.narration ?? tx.description) ?? ""}>{text(tx.narration ?? tx.description) || "—"}</td>
                                    <td style={{ padding: "0 14px" }}><Chip label={displaySource(text(tx.category ?? tx.transaction_type)) || "—"} tone="neutral" /></td>
                                    <td style={{ padding: "0 14px", textAlign: "right", color: isCredit ? "var(--good)" : "var(--bad)", fontWeight: 760, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{isCredit ? "▲" : "▼"} {formatMoney(amount, currency)}</td>
                                    <td style={{ padding: "0 14px", textAlign: "right", color: "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>{num(tx.balance_minor ?? tx.balance) != null ? formatMoney(num(tx.balance_minor ?? tx.balance)!, currency) : "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {filteredTransactions.length > txVisibleCount && (
                          <div style={{ textAlign: "center", padding: "10px 0", borderTop: "1px solid var(--rule)" }}>
                            <button className="btn" onClick={() => setTxVisibleCount(c => c + 50)}>
                              Load {Math.min(50, filteredTransactions.length - txVisibleCount)} more
                            </button>
                          </div>
                        )}
                      </Card>
                    )}
                  </>
              }
            </div>
          )}

          {/* ══ CREDIT LIMIT ══════════════════════════════════════════════════════ */}
          {tab === "limit" && (
            <div style={{ display: "grid", gap: 16 }}>
              {/* Dark hero */}
              <div style={{ background: "linear-gradient(165deg, #191D38 0%, #0F1226 75%)", borderRadius: "var(--r-xl)", padding: "28px 32px", position: "relative", overflow: "hidden", boxShadow: "var(--shadow-lg)" }}>
                <div style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)", backgroundSize: "44px 44px", WebkitMaskImage: "radial-gradient(800px 400px at 80% 0%, #000, transparent 60%)", maskImage: "radial-gradient(800px 400px at 80% 0%, #000, transparent 60%)" }} />
                <div style={{ position: "absolute", top: -80, right: -40, width: 320, height: 320, background: "radial-gradient(closest-side, rgba(214,167,88,0.22), transparent 70%)", filter: "blur(12px)" }} />
                <div style={{ position: "relative" }}>
                  <div style={{ color: "rgba(255,255,255,0.38)", font: "650 10px/1 var(--font)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>Approved credit limit</div>
                  <div style={{ color: "var(--gold-2)", font: "820 44px/0.95 var(--font-mono)", fontVariantNumeric: "tabular-nums", textShadow: "0 0 40px rgba(214,167,88,0.35)" }}>
                    {maxLoanMinor != null ? formatMoney(maxLoanMinor, currency) : "—"}
                  </div>
                  <div style={{ color: "rgba(255,255,255,0.5)", font: "500 13px/1.4 var(--font)", marginTop: 8 }}>
                    Band {scoring?.band ?? decisionDetail.risk_band ?? "—"} · {displaySource(scoring?.scoring_method ?? "Eye scoring")}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", marginTop: 24, paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                    {[
                      { label: "PD", value: pd != null ? pct(pd) : "—" },
                      { label: "Tenor", value: tenureMonths != null ? `${tenureMonths}mo` : "—" },
                      { label: "Scored", value: formatDate(scoring?.scored_at) },
                    ].map(s => (
                      <div key={s.label}>
                        <div style={{ color: "rgba(255,255,255,0.38)", font: "650 10px/1 var(--font)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 7 }}>{s.label}</div>
                        <div style={{ color: "#E9EAF5", font: "700 15px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{s.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <Card>
                <Kicker>Recommended terms</Kicker>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
                  <MetricCard label="Limit" value={maxLoanMinor != null ? formatMoney(maxLoanMinor, currency) : "—"} />
                  <MetricCard label="PD" value={pd != null ? pct(pd) : "—"} valueColor={pd != null && pd > 0.3 ? "var(--bad)" : undefined} />
                  <MetricCard label="Tenor" value={tenureMonths != null ? `${tenureMonths} months` : "—"} />
                  <MetricCard label="EMI" value={emi != null ? formatMoney(emi, currency) : "—"} />
                  <MetricCard label="DSR" value={dsr != null ? pct(dsr) : "—"} valueColor={dsr != null && dsr > 0.5 ? "var(--warn)" : undefined} />
                  <MetricCard label="Risk band" value={scoring?.band ?? decisionDetail.risk_band ?? "—"} />
                </div>
              </Card>

              {(incomeMinor != null || emi != null) && (
                <Card>
                  <Kicker>Income vs. obligations</Kicker>
                  {(() => {
                    const remaining = incomeMinor != null && emi != null ? incomeMinor - emi : null;
                    const maxVal = Math.max(1, incomeMinor ?? 0, emi ?? 0, Math.abs(remaining ?? 0));
                    const steps: Array<{ label: string; value: number; color: string }> = [
                      ...(incomeMinor != null ? [{ label: "Monthly income", value: incomeMinor, color: "var(--good)" }] : []),
                      ...(emi != null ? [{ label: "Proposed EMI", value: emi, color: "var(--bad)" }] : []),
                      ...(remaining != null ? [{ label: "Remaining income", value: remaining, color: remaining >= 0 ? "var(--accent)" : "var(--bad)" }] : []),
                    ];
                    return (
                      <div style={{ display: "grid", gap: 10 }}>
                        {steps.map((s, i) => (
                          <div key={i} style={{ display: "grid", gridTemplateColumns: "160px 1fr 110px", gap: 12, alignItems: "center" }}>
                            <span style={{ color: "var(--ink-faint)", font: "500 12.5px/1.3 var(--font)" }}>{s.label}</span>
                            <div style={{ height: 10, background: "var(--rule)", borderRadius: "var(--r-pill)", overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${Math.max(2, Math.min(100, (Math.abs(s.value) / maxVal) * 100))}%`, background: s.color, borderRadius: "var(--r-pill)" }} />
                            </div>
                            <span style={{ color: s.color, font: "700 13px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                              {formatMoney(Math.abs(s.value), currency)}
                            </span>
                          </div>
                        ))}
                        {dsr != null && (
                          <div style={{ marginTop: 4, padding: "10px 14px", borderRadius: "var(--r-md)", background: dsr <= 0.5 ? "var(--good-wash)" : "var(--bad-wash)", border: `1px solid color-mix(in srgb, ${dsr <= 0.5 ? "var(--good)" : "var(--bad)"} 22%, transparent)` }}>
                            <span style={{ font: "600 13px/1 var(--font)", color: dsr <= 0.5 ? "var(--good)" : "var(--bad)" }}>
                              DSR: {pct(dsr)} — {dsr <= 0.5 ? "within policy (≤50%)" : "exceeds 50% threshold"}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </Card>
              )}

              <Card>
                <Kicker>Limit policy compliance</Kicker>
                <PolicyCheck label="Hard gate clear" value={gateActive ? (scoring?.hard_gate_reason ?? "Triggered") : "Passed"} pass={!gateActive} />
                <PolicyCheck label="DSR within policy (≤ 50%)" value={dsr != null ? pct(dsr) : "Not computed"} pass={dsr != null ? dsr <= 0.5 : undefined} />
                <PolicyCheck label="PD within band (≤ 40%)" value={pd != null ? pct(pd) : "—"} pass={pd != null ? pd <= 0.4 : undefined} />
                <PolicyCheck label="No active delinquencies" value={delinquentAccounts > 0 ? `${delinquentAccounts} on bureau` : "Confirmed"} pass={delinquentAccounts === 0} />
              </Card>
            </div>
          )}

          {/* ══ EWS ALERTS ════════════════════════════════════════════════════════ */}
          {tab === "ews" && (
            <div style={{ display: "grid", gap: 16 }}>
              {/* Stat cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 }}>
                {[
                  { label: "Active signals", value: String(ewsSignals.length), sub: ewsHighCount > 0 ? `${ewsHighCount} high severity` : ewsSignals.length > 0 ? "None critical" : "All clear", icon: <ShieldAlert size={16} />, danger: ewsHighCount > 0 },
                  { label: "Cleared (30d)", value: "—", sub: "No 30-day history", icon: <Activity size={16} />, danger: false },
                  { label: "PD at scoring", value: pd != null ? pct(pd) : "—", sub: pd != null ? (pd <= 0.25 ? "Low risk" : pd <= 0.4 ? "Moderate risk" : "High risk") : undefined, icon: <Clock size={16} />, danger: pd != null && pd > 0.4 },
                ].map(s => (
                  <div key={s.label} style={{ padding: "16px 18px", border: "1px solid var(--rule)", borderRadius: "var(--r-lg)", background: "var(--panel)", boxShadow: "var(--shadow-sm)", position: "relative", overflow: "hidden" }}>
                    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: s.danger ? "linear-gradient(90deg, var(--bad), transparent)" : "linear-gradient(90deg, var(--accent-2), transparent)" }} />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                      <div style={{ color: "var(--ink-faint)", font: "650 10px/1 var(--font)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{s.label}</div>
                      <div style={{ width: 30, height: 30, borderRadius: "var(--r-sm)", background: s.danger ? "var(--bad-wash)" : "var(--accent-wash)", color: s.danger ? "var(--bad)" : "var(--accent-ink)", display: "grid", placeItems: "center" }}>{s.icon}</div>
                    </div>
                    <div style={{ color: s.danger ? "var(--bad)" : "var(--ink)", font: "700 26px/1 var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{s.value}</div>
                    {s.sub && <div style={{ color: "var(--ink-faint)", font: "500 12px/1.35 var(--font)", marginTop: 6 }}>{s.sub}</div>}
                  </div>
                ))}
              </div>

              {/* Signal cards */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                  <Kicker>Signal stream</Kicker>
                  <span style={{ color: "var(--ink-faint)", font: "500 12.5px/1 var(--font)" }}>{ewsSignals.length} signal{ewsSignals.length !== 1 ? "s" : ""} · last 90 days</span>
                </div>
                {ewsSignals.length > 0 ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    {ewsSignals.map(signal => (
                      <div key={signal.id} style={{ borderRadius: "var(--r-lg)", background: "var(--panel)", boxShadow: "var(--shadow-sm)", border: "1px solid var(--rule)", borderTop: `2px solid ${ewsSevColor(signal.severity)}`, padding: "16px 18px" }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                          <div style={{ width: 34, height: 34, borderRadius: "var(--r-sm)", background: ewsSevBg(signal.severity), color: ewsSevColor(signal.severity), display: "grid", placeItems: "center", flexShrink: 0, boxShadow: `0 2px 8px -3px ${ewsSevColor(signal.severity)}` }}>
                            <AlertTriangle size={15} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7, flexWrap: "wrap" }}>
                              <Chip label={signal.severity} tone={signal.severity === "High" ? "danger" : signal.severity === "Medium" ? "warn" : "info"} />
                              <Chip label={signal.status} tone={signal.status === "Pending" ? "danger" : "warn"} />
                              <span style={{ font: "500 12px/1 var(--font-mono)", color: "var(--ink-faint)", marginLeft: "auto" }}>{signal.id}</span>
                            </div>
                            <div style={{ color: "var(--ink)", font: "650 13.5px/1.3 var(--font)" }}>{signal.title}</div>
                            <div style={{ color: "var(--ink-faint)", font: "400 12.5px/1.5 var(--font)", marginTop: 5 }}>{signal.description}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Card>
                    <EmptyState icon={<CheckCircle size={22} />} title="No active EWS signals" description="No hard gate, bounce, delinquency, or high-risk behavioural signal was detected for this score." />
                  </Card>
                )}
              </div>
            </div>
          )}

          {/* ══ POLICY & AUDIT ════════════════════════════════════════════════════ */}
          {tab === "policy" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start" }}>
              <Card>
                <Kicker>Policy checks</Kicker>
                <PolicyCheck label="DTI (gate ≤ 70%)" value={dtiRaw != null ? `${(dtiRaw * 100).toFixed(1)}%` : "Not available"} pass={dtiRaw != null ? dtiRaw <= 0.70 : undefined} />
                <PolicyCheck label="Income verification" value={incomeSource} pass={!!(statement || Object.keys(accountSummary).length > 0)} />
                <PolicyCheck label="Bureau pulled within 30d" value={bureauFetched ? relativeDate(bureauFetched) : "Not pulled"} pass={bureauFresh} />
                <PolicyCheck label="No active defaults" value={delinquentAccounts > 0 ? `${delinquentAccounts} delinquent` : "Confirmed"} pass={delinquentAccounts === 0} />
                <PolicyCheck label="Active loans (gate ≤ 5)" value={activeLoans > 0 ? String(activeLoans) : "None on bureau"} pass={activeLoans <= 5} />
                <PolicyCheck label="Bureau enquiries 3m" value={(enquiries3m ?? 0) > 0 ? String(enquiries3m) : "None"} />
                <PolicyCheck label="PEP / sanctions" value={pepFlagged || watchlistHit ? "Flagged — review required" : "Clear"} pass={!pepFlagged && !watchlistHit} />
                <PolicyCheck label="Hard gate" value={gateActive ? (scoring?.hard_gate_reason ?? "Triggered") : "Passed"} pass={!gateActive} />
              </Card>

              <Card>
                <Kicker>Decision audit trail</Kicker>
                <TimelineItem icon={<FileText size={14} />} title="Application received" body={displaySource(scoring?.scoring_method ?? "credit request")} at={formatDateTime(decisionDetail.created_at)} />
                {bureau && <TimelineItem icon={<Landmark size={14} />} title="Bureau enquiries triggered" body={`CRC · ${bureau.query_type}`} at={formatDateTime(bureau.fetched_at)} />}
                {scoring && <TimelineItem icon={<Zap size={14} />} title="Eye scored" body={`${displaySource(scoring.model_version ?? "model")} · score ${scoring.score}`} at={formatDateTime(scoring.scored_at)} />}
                <TimelineItem icon={<CheckCircle size={14} />} title={`Decision: ${titleCase(decisionDetail.outcome)}`} body={(decisionDetail.reasons ?? []).join(" · ") || "Automatic — within decisioning corridor."} at={formatDateTime(decisionDetail.created_at)} last />
              </Card>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
