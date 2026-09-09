// Types ported verbatim from Phoenix (apps/veyonra/src/features/eye/api.ts) so the
// workspace renders the identical credit report. Only the TYPES are ported: Phoenix's
// runtime api functions call /v1/portal/* which rejects the workspace's machine key
// (401). The workspace fetches the same payload from /api/los/:id/eye-decision, which
// proxies Phoenix's machine-auth twin of the portal route.
//
// Keep this file in step with Phoenix's api.ts. If the two drift, the report silently
// renders stale or missing fields rather than failing loudly.

export type DecisionOutcome = "APPROVE" | "DECLINE" | "REFER" | "REQUEST_MORE_INFORMATION" | "ERROR";

export interface FeatureContribution {
  feature?: string;
  label: string;
  value: string;
  direction: string;
  points: number;
  raw_value?: unknown;
}

export interface BehavioralRiskSignal {
  code: string;
  label: string;
  weight: number;
}

export interface BehavioralRisk {
  risk_score: number;
  risk_level: "low" | "medium" | "high" | "critical";
  triggered_rules: BehavioralRiskSignal[];
  pass_through: boolean;
}

export interface ScoringRecord {
  id: string;
  tenant_id: string;
  customer_id: string;
  credit_request_id?: string | null;
  decision_record_id?: string | null;
  source: string;
  score_id: string;
  score: number;
  band: string;
  outcome?: string | null;
  probability_of_default: number;
  max_loan_amount_minor: number;
  hard_gate_triggered: boolean;
  hard_gate_reason?: string | null;
  hard_gate_label?: string | null;
  scoring_method?: string | null;
  model_version: string;
  feature_contributions: FeatureContribution[];
  scored_at: string;
  created_at: string;
  // eligible_ceiling_minor (uncapped affordability ceiling) lives in here —
  // see IntelligenceScoreResult for the same field on live scoring results.
  metadata?: Record<string, unknown>;
}

export interface BureauQuery {
  id: string;
  customer_id?: string | null;
  bvn_hash: string;
  identity_json?: Record<string, unknown>;
  bureau_json?: Record<string, unknown>;
  account_summary_json?: Record<string, unknown>;
  query_type: string;
  charged: boolean;
  fetched_at: string;
}

export interface EyeDecisionStatement {
  id: string;
  source: string;
  currency: string;
  account_name?: string;
  account_number?: string;
  institution_name?: string;
  period_start: string;
  period_end: string;
  avg_monthly_credits_minor?: number | null;
  avg_monthly_debits_minor?: number | null;
  closing_balance_minor?: number | null;
  transaction_count?: number | null;
  salary_regularity_score?: number | null;
  loan_repayment_detected?: boolean | null;
  gambling_ratio?: number | null;
  bounce_count_per_month?: number | null;
  dscr?: number | null;
  savings_rate?: number | null;
  months_of_data?: number | null;
  // Extraction confidence — which parser stage produced this data and
  // whether the balance reconciled. Absent on legacy records parsed before
  // these fields were tracked.
  parser_method?: string | null;
  confidence?: number | null;
  golden_rule_passed?: boolean | null;
  warnings?: string[];
  // Tamper-detection result from the Eye document authenticator.
  auth_risk_score?: number | null;
  auth_flags?: string[];
  // Periculum's raw supplementary-analytics response, attached asynchronously
  // after the initial parse — absent until that background enrichment
  // completes (or if the tenant hasn't configured Periculum in Console).
  periculum?: Record<string, any>;
  signals?: string[];
  extraction_confidence?: number | null;
  categorisation_coverage_pct?: number | null;

  spend_by_category?: Record<string, { avg_monthly_minor: number; total_minor: number }>;
  most_frequent_spend_category?: string | null;

  transaction_size_distribution?: Record<string, number>;
  balance_size_distribution?: Record<string, number>;
  most_frequent_transaction_range?: string | null;
  most_frequent_balance_range?: string | null;

  weekly_inflow?: { week: string; amount_minor: number }[];
  weekly_outflow?: { week: string; amount_minor: number }[];
  monthly_highest_balance?: { month: string; amount_minor: number }[];
  monthly_lowest_balance?: { month: string; amount_minor: number }[];
  transacting_months_weighted?: number | null;

  self_transfer_inflow_minor?: number | null;
  self_transfer_outflow_minor?: number | null;
  self_transfer_count?: number | null;

  account_sweep_detected?: boolean | null;
  inflow_irregularity_pct?: number | null;
  account_activity_pct?: number | null;

  income_by_channel?: Record<string, { total_minor: number; count: number; pct_of_credits?: number }>;

  predicted_average_salary_minor?: number | null;
  salary_payment_count?: number | null;
  expected_salary_payment_day?: number | null;
  salary_payment_coverage_pct?: number | null;

  // Other (secondary) recurring income — a second qualifying stream alongside
  // the primary salary (e.g. a main salary plus a separate allowance).
  has_other_income?: boolean | null;
  other_income_total_minor?: number | null;
  other_income_count?: number | null;
  other_income_avg_minor?: number | null;

  // Salary series extremes
  lowest_salary_amount_minor?: number | null;
  lowest_salary_date?: string | null;
  most_recent_salary_amount_minor?: number | null;
  most_recent_salary_date?: string | null;

  // Cash-flow totals (lifetime, not monthly average)
  total_credit_turnover_minor?: number | null;
  total_debit_turnover_minor?: number | null;
  avg_weekly_credits_minor?: number | null;
  avg_weekly_debits_minor?: number | null;
  avg_balance_minor?: number | null;
  percent_debit_transactions?: number | null;
  percent_credit_transactions?: number | null;

  // Monthly cash flow (flow totals — distinct from monthly_highest/lowest_balance above)
  monthly_inflow?: { month: string; amount_minor: number }[];
  monthly_outflow?: { month: string; amount_minor: number }[];
  month_with_highest_spend?: string | null;
  highest_spend_minor?: number | null;

  // Counterparty detection (best-effort)
  most_frequent_credit_counterparty?: string | null;
  most_frequent_debit_counterparty?: string | null;

  // Recurring expense detection (debit-side mirror of salary detection)
  most_recurring_expense_description?: string | null;
  total_recurring_expense_minor?: number | null;

  number_of_betting_transactions?: number | null;

  // Loan disbursement / repayment tallies
  total_loan_disbursement_minor?: number | null;
  total_loan_repayment_minor?: number | null;
  loan_disbursement_count?: number | null;
  loan_repayment_count?: number | null;
  avg_monthly_loan_disbursement_minor?: number | null;
  avg_monthly_loan_repayment_minor?: number | null;
  loan_to_inflow_rate?: number | null;
  latest_loan_disbursement?: { date: string; amount_minor: number } | null;
  latest_loan_repayment?: { date: string; amount_minor: number } | null;
}

export interface EyeDecisionDetail {
  id: string;
  tenant_id: string;
  credit_request_id: string;
  outcome: string;
  risk_band: string | null;
  recommended_amount_minor: number | null;
  recommended_limit_minor: number | null;
  currency: string | null;
  reasons: string[];
  policy_version: string;
  created_at: string;
  // Present on the real Go response (PortalEyeDecisionDetail embeds
  // core.DecisionRecord, which has NoticeSentAt) but previously missing from
  // this hand-typed interface — deep-linked decisions with no list row to
  // fall back on showed a generic "Applicant" name instead of the real one.
  notice_sent_at?: string | null;
  credit_request?: {
    id: string;
    status: string;
    currency: string;
    requested_amount_minor?: number | null;
    requested_limit_minor?: number | null;
    tenor_months?: number | null;
    // creditReportExport.ts also reads product/interest_rate_bps off this —
    // not on core.CreditRequest's real Go fields as of this writing, but the
    // index signature keeps that pre-existing (loosely-typed) usage working
    // rather than fighting it here; not this fix's job to audit that file.
    [key: string]: unknown;
  };
  customer?: {
    id: string;
    full_name: string;
    phone?: string | null;
    email?: string | null;
  };
  scoring_record?: ScoringRecord;
  bureau_query?: BureauQuery;
  statement?: EyeDecisionStatement;
}

export interface EyeScoreItem {
  id: string;
  tenant_id: string;
  credit_request_id: string | null;
  customer_id: string;
  customer_name: string;
  applicant_name?: string;
  borrower_category?: string;
  score_id: string;
  score: number;
  band: string;
  outcome: string | null;
  probability_of_default: number;
  max_loan_amount_minor: number;
  eligible_ceiling_minor?: number;
  source: string;
  model_version: string;
  scoring_method?: string;
  hard_gate_triggered: boolean;
  hard_gate_reason: string | null;
  hard_gate_label?: string | null;
  report_path?: string;
  created_at: string;
}

export interface ShadowScoreResult {
  score_id: string;
  champion_pd: number;
  challenger_pd: number;
  pd_delta: number;
  challenger_method: string;
  computed_at: string;
}

export type ShapFactor = { feature: string; contribution: number; direction: "positive" | "negative" };
export type SendDecisionBody = { channel?: "email" | "sms" | "whatsapp"; recipient?: string; message?: string };

// Live SHAP attribution from the intelligence service. The panel treats this as
// optional — not every deployment configures an explainer — so it is typed as
// possibly-undefined rather than omitted.
export interface DecisionExplanation {
  scoring_record_id: string;
  top_factors: ShapFactor[];
  total_features: number;
  hard_gate_triggered?: boolean;
  hard_gate_reason?: string | null;
}
