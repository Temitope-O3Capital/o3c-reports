// Ported verbatim from apps/portal/src/features/eye/pages/EyeReportPage.tsx so
// Veyonra's Eye decision tab explains every scorecard feature exactly the same
// way Portal's report does — same domain thresholds, same Nigerian credit
// context, same fallback for any feature key without an explicit entry.
import type { FeatureContribution } from "../eyeTypes";

export function titleCase(value?: string | null): string {
  if (!value) return "-";
  const acronyms: Record<string, string> = {
    bvn: "BVN", cac: "CAC", crc: "CRC", dscr: "DSCR", dti: "DTI", emi: "EMI",
    gsi: "GSI", lgbm: "LGBM", loc: "LOC", pd: "PD", tin: "TIN", xds: "XDS",
  };
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\bv(\d+(?:\.\d+)?)\b/gi, "v$1")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (/^v\d/.test(lower)) return lower;
      return acronyms[lower] ?? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

export function displaySource(source?: string | null): string {
  if (!source) return "-";
  return titleCase(source);
}

export function displayPersonName(value?: string | null): string {
  if (!value) return "-";
  const spaced = value.trim().replace(/\s+/g, " ");
  if (!spaced) return "-";
  if (/\s/.test(spaced)) return spaced.split(" ").map((part) => titleCase(part)).join(" ");
  if (/^[A-Z]{10,}$/.test(spaced)) {
    const split = spaced.replace(/(OLU)(VICTOR)$/i, " $1 $2").trim();
    if (split !== spaced) return split.split(" ").map((part) => titleCase(part)).join(" ");
  }
  return titleCase(spaced);
}

export function displayMetricValue(label: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (label.toLowerCase().includes("name")) return displayPersonName(trimmed);
  if (/^[a-z0-9_-]+$/i.test(trimmed) && /[_-]/.test(trimmed)) return titleCase(trimmed);
  if (/^[A-Z]{10,}$/.test(trimmed)) return displayPersonName(trimmed);
  return value;
}

const FEATURE_EXPLANATIONS: Record<string, string> = {
  // ── Bureau: delinquency & defaults ──────────────────────────────────────────
  worst_delinquency_days: "Historical worst days-past-due across all bureau accounts. Bands: 0 = clean; 1–30 = minor; 31–90 = moderate; 91–180 = severe; 180+ = write-off territory. A value of 999 is a sentinel indicating a historical charge-off or write-off with no recovery — the maximum penalty band.",
  bureau_worst_delinquency: "Historical worst days-past-due across all bureau accounts. Bands: 0 = clean; 1–30 = minor; 31–90 = moderate; 91–180 = severe; 180+ = write-off territory.",
  max_dpd_ever: "Highest days-past-due ever recorded on any bureau account. 0 = clean history; 1–30 = minor slip; 31–90 = moderate; 91–180 = severe; 180+ / 999 = charge-off. Even a single 91+ DPD record roughly doubles the delinquency penalty in Eye.",
  delinquent_accounts: "Count of bureau accounts with a current DPD above zero. Zero is ideal. Even one active delinquency carries a significant penalty. Three or more simultaneous delinquencies is treated as near-equivalent to a hard decline gate in conservative appetite settings.",
  bureau_delinquent_accounts: "Count of bureau accounts with a current DPD above zero. Zero is ideal. Even one active delinquency carries a significant penalty. Three or more simultaneous delinquencies is treated as near-equivalent to a hard decline gate in conservative appetite settings.",
  existing_credit_defaults: "Whether the applicant has an active default on this platform (no payment received past 90 DPD) or a confirmed bureau default. 'No' earns positive score contribution. 'Yes' is the strongest single negative flag after watchlist — it triggers a hard gate when Block Existing Defaults is enabled.",
  prior_default_count: "Number of previous platform loan defaults. Zero earns full positive credit. Even one prior default applies a significant lifetime penalty. Two or more is treated as systematic non-repayment risk, not a one-off event.",
  total_overdue: "Amount currently overdue across all bureau facilities. Any non-zero amount means active missed obligations exist right now — a direct negative signal regardless of score band.",

  // ── Bureau: score & payment history ─────────────────────────────────────────
  bureau_score: "Raw credit score from CRC, FirstCentral, or CreditRegistry (scale 300–850). Eye risk bands: A ≥ 750, B 670–749, C 580–669, D 500–579, E < 500. A score of 652 is band C — moderate risk. Missing scores are treated as band C unless the bureau explicitly returned 'no history'.",
  bureau_credit_score: "Bureau score mapped into the Eye 300–850 scale. Bands: A ≥ 750 (very low risk), B 670–749 (low), C 580–669 (moderate), D 500–579 (elevated), E < 500 (high risk). Scores below 580 trigger the minimum bureau score gate if configured.",
  bureau_payment_history_rate: "Fraction of all bureau-reported obligations paid on or before the due date: on-time payments ÷ total payments due. Above 0.90 earns maximum positive contribution. Below 0.80 incurs a significant penalty. Below 0.60 carries near-maximum penalty — a value of 0.45 means over half of historical obligations were late or missed.",
  bureau_payment_history: "Fraction of all bureau-reported obligations paid on or before the due date. Above 0.90 = strong positive. Below 0.80 = penalty. Below 0.60 = near-maximum penalty. This is the strongest predictive bureau signal for repeat borrowers.",
  payment_history_rate: "Share of bureau or platform repayment history recorded as on-time. Above 0.90 = strong positive. Below 0.80 = penalty. Below 0.60 = near-maximum penalty. This is the strongest predictive bureau signal for repeat borrowers.",
  existing_defaults: "Whether the applicant has an active default on this platform (no payment received past 90 DPD) or a confirmed bureau default. 'No' earns positive score contribution. 'Yes' is the strongest single negative flag after watchlist — it triggers a hard gate when Block Existing Defaults is enabled.",

  // ── Bureau: credit age, inquiries, tradelines ───────────────────────────────
  credit_history_age_months: "Age of the oldest active bureau account, in months. Below 12 months = thin file, no positive contribution. Premium begins at 24 months. Maximum premium at 36+ months. A value of 113 months (~9.4 years) earns full credit history premium.",
  bureau_credit_age: "Age of the oldest active bureau account, in months. Below 12 months = thin file, no positive contribution. Premium begins at 24 months. Maximum premium at 36+ months.",
  active_credit_lines: "Count of currently open and active credit facilities reported to the bureau (loans, credit cards, overdrafts). Zero = thin file. 1–5 is standard. Above 10 active lines introduces concentration risk. This count does not include fully repaid or closed accounts.",
  active_tradelines: "Total bureau tradelines treated as currently open after Eye removes closed, fully-repaid, or settlement-complete accounts. A moderate count with clean payment history is positive. High counts with any delinquency amplify those penalties.",
  bureau_active_tradelines: "Total bureau tradelines treated as currently open after Eye removes closed, fully-repaid, or settlement-complete accounts. A moderate count with clean payment history is positive. High counts with any delinquency amplify those penalties.",
  bureau_secured_tradelines: "Count of open bureau tradelines backed by collateral — mortgages, asset finance, secured overdrafts. Secured facilities carry lower default risk than unsecured ones, so a healthy mix with clean payment history is a mild positive.",
  bureau_unsecured_tradelines: "Count of open bureau tradelines with no collateral backing — credit cards, personal loans, unsecured overdrafts. A high unsecured count relative to income is a concentration-risk signal, since these are the facilities most often defaulted on first.",
  credit_inquiries_6m: "Hard-pull credit bureau enquiries in the past 6 months. 1–2 = normal. 3–4 = elevated. Above 4 is a loan-shopping signal — strong negative. A value of 17 indicates extreme multi-lender shopping, which is a near-maximum penalty. Soft pulls (identity checks, pre-approvals) are excluded.",
  bureau_inquiries_6m: "Hard-pull credit bureau enquiries in the past 6 months. 1–2 = normal. 3–4 = elevated. Above 4 is a loan-shopping signal — strong negative. Soft pulls (identity checks, pre-approvals) are excluded.",
  enquiries_3m: "Hard-pull bureau enquiries in the past 3 months. More than 2 in 3 months is a pressure signal. Above 5 in 3 months indicates acute financial stress or active loan-shopping.",
  enquiries_30d: "Hard-pull bureau enquiries in the past 30 days. More than 2 in 30 days strongly suggests active multi-lender shopping in response to financial pressure.",
  enquiries_12m: "Hard-pull bureau enquiries over the past 12 months. Above 6 per year is elevated. Above 10 per year is a strong negative. Persistent high enquiry rates suggest the borrower regularly requires emergency credit.",
  bureau_credit_utilization: "Total outstanding revolving balances ÷ total available revolving limit across all bureau tradelines. Below 30% = healthy headroom. 30–60% = moderate strain. Above 80% is treated as maxed-out — a strong negative signal that the borrower is already leaning heavily on existing credit.",
  bureau_bankruptcies: "Count of bankruptcy or formal insolvency filings on the bureau record. Zero is required for a clean file. Any filing, regardless of age, is one of the most severe negative signals in the scorecard — it indicates a prior formal inability to meet obligations.",
  bureau_judgments: "Count of court judgments for unpaid debt recorded against the applicant. Zero is ideal. Any judgment on file is a strong negative — it means a creditor already had to sue to recover money owed, independent of the applicant's current bureau score.",

  // ── Bureau: outstanding & utilisation ───────────────────────────────────────
  total_outstanding: "Sum of all outstanding bureau balances expressed as a multiple of monthly income (months-of-income to clear all debt). A ratio above 6× monthly income is strong negative territory. Zero means no outstanding obligations — maximum positive contribution for this signal.",
  bureau_total_outstanding: "Sum of all outstanding bureau balances expressed as a multiple of monthly income. A ratio above 6× monthly income is strong negative territory. Zero means no outstanding obligations — maximum positive contribution for this signal.",
  total_credit_turnover: "Total credit transactions posted through the account over the available lookup period. Used as a proxy for economic activity level and income verification. Very low turnover relative to declared income raises verification concerns.",
  total_debit_turnover: "Total debit transactions over the account lookup period. Cross-referenced with declared obligations to detect off-statement liabilities.",

  // ── Statement: income & cashflow ────────────────────────────────────────────
  avg_monthly_credits: "Average monthly credit inflow from the parsed bank statement. This is the primary income evidence used in DTI and DSCR calculations. Used to determine affordability: the monthly EMI must not exceed a comfortable fraction of this value.",
  avg_monthly_inflow: "Average monthly credit inflow from the parsed statement or open-banking summary. Drives affordability calculations. A higher inflow relative to the requested loan amount increases the maximum eligible amount.",
  avg_monthly_debits: "Average monthly debit outflow from the parsed statement. Compared against inflow to compute savings rate. Persistent debits above credits indicate a drawdown pattern — spending exceeds income.",
  avg_monthly_outflow: "Average monthly debit outflow from statement or open-banking data. Used alongside inflow to calculate the net savings rate. A ratio of outflow ÷ inflow above 0.95 (spending 95%+ of income) is flagged as a cashflow stress indicator.",
  average_balance: "Average daily account balance from the account lookup provider, expressed as a ratio to monthly inflow. Below 0.2× monthly income = near-zero cash buffer (maximum stress). Above 0.5× = healthy. Above 1.0× = strong reserve.",
  estimated_monthly_income: "Income estimate from account lookup data or derived from average statement credits. Used when declared income is unavailable or needs cross-validation. Significant divergence from declared income triggers a verification flag.",
  monthly_income: "Monthly income used by the scorecard. This may come from declared income, payroll detection, statement average credits, or account lookup — Eye uses the most reliable verified source available.",
  monthly_income_minor: "Monthly income in kobo used by the scorecard's affordability and DTI calculations. Divide by 100 for naira.",

  // ── Statement: debt service & DTI ───────────────────────────────────────────
  debt_service_coverage_ratio: "Net monthly cashflow ÷ total scheduled debt payments. Above 2.0 = strong (income more than covers obligations). 1.0–2.0 = adequate. Below 1.0 = cashflow cannot cover current debt service — new lending is unsustainable without refinancing. Very high values (e.g. 150+) indicate minimal detected loan repayments relative to income.",
  dscr: "Net monthly cashflow ÷ total scheduled debt payments. Above 2.0 = strong. 1.0–2.0 = adequate. Below 1.0 = income cannot cover obligations. Very high values typically indicate few or no detected loan repayments in the statement period.",
  ob_dscr: "Statement-derived DSCR: net inflows ÷ detected loan repayments plus declared obligations. Below 1.0 means observed income cannot cover existing debt service. Above 2.0 is comfortable. Very high values indicate minimal detected repayments.",
  debt_to_income_ratio: "Total monthly debt repayments ÷ gross monthly income. The CBN consumer protection threshold is 0.40 (40%). Eye stress threshold is 0.43. Above 0.70 is high-risk territory. A value of 0.25 is comfortably within the acceptable range.",
  dti_ratio: "Monthly obligations ÷ monthly income. Below 0.33 = comfortable. 0.33–0.43 = approaching threshold. Above 0.43 = stressed. Above 0.70 = maximum penalty band. Calculated from bureau-detected repayments plus declared obligations.",
  dti: "Monthly obligations ÷ monthly income. Below 0.33 = comfortable. 0.33–0.43 = approaching threshold. Above 0.43 = stressed. Above 0.70 = maximum penalty band.",

  // ── Statement: balance & trends ─────────────────────────────────────────────
  closing_balance_to_income_ratio: "End-of-statement closing balance ÷ average monthly inflow. Below 0.2 = the account holds less than 20% of one month's income — near-zero cash buffer, maximum stress penalty. Above 0.5 = healthy reserve. Above 1.0 = one month's income held in reserve — optimal.",
  balance_ratio: "Closing balance ÷ average monthly inflow. Below 0.2 = near-zero cash buffer. Above 0.5 = healthy reserve. Above 1.0 = one month's income held in reserve.",
  ob_balance_trend: "Direction and rate of change of month-end balances across the statement period (linear regression slope, expressed as kobo/month). A positive trend means savings are accumulating. A consistently declining trend suggests financial drawdown and spending pressure — penalised progressively.",
  ob_inflow_trend: "Month-over-month growth rate of monthly credit inflows across the statement period (linear regression slope in kobo/month). Positive slope = income growing. Flat = stable. Negative = declining income — penalised, particularly for consecutive declining months. Note: large raw values reflect minor-unit (kobo) amounts.",
  income_stability: "Coefficient of variation of monthly inflow amounts: standard deviation ÷ mean. Below 0.2 = very stable (likely regular salary). 0.2–0.4 = moderate variation. Above 0.6 = highly irregular income from gig work, trading, or seasonal activity — maximum stability penalty.",

  // ── Statement: risk signals ──────────────────────────────────────────────────
  gambling_ratio: "Betting and gambling debits as a share of total monthly debit volume. Detected by MCC codes and payee names (Bet9ja, Sportybet, 1xBet, BetKing, etc.). Above 5% is flagged. Above 15% triggers a hard penalty that overrides most positive signals.",
  ob_gambling_ratio: "Statement-detected gambling spend ÷ total debits. Above 5% = flagged. Above 15% = near-maximum penalty. Detected from merchant names and MCC codes across 40+ Nigerian betting operators.",
  bounce_count_mo: "Average failed, reversed, or returned transactions per month. Includes NSF returns, NIP reversal credits, and same-day merchant rejections. Even 1–2 per month indicates cashflow timing problems. Above 4/month is a strong negative regardless of average balance.",
  bounce_count_per_month: "Monthly average of failed debits, returned payments, or NSF events. 0 = clean. 1–2/month = minor pressure. Above 3/month = cashflow stress. Consistent bounces indicate the account regularly runs short even when the average balance appears adequate.",
  ob_bounce_count_per_month: "Open-banking bounce count: monthly average of failed payment attempts, NSF returns, and reversed debits. Even occasional bounces (1–2/month) signal timing risk. Above 4/month is treated as a hard cashflow pressure signal.",
  ob_bounce_count: "Open-banking bounce count: monthly average of failed payment attempts, NSF returns, and reversed debits. Even occasional bounces (1–2/month) signal timing risk. Above 4/month is treated as a hard cashflow pressure signal.",
  overdraft_frequency: "Fraction of calendar months in the statement period where the account balance went negative. Even 1 month in 6 triggers a penalty. Above 0.5 (overdrawn more than half the time) is treated as structural cashflow stress and carries maximum penalty for this signal.",
  ob_overdraft_frequency: "Share of observed months where the account entered overdraft or a negative balance. 0 = clean. Above 0.17 (1 in 6 months) = flagged. Above 0.5 = maximum stress penalty.",
  savings_rate: "(Total credits − total debits) ÷ total credits, averaged over the statement period. Negative = spending exceeds income — maximum stress. 0–10% = minimal savings. 10–20% = moderate. Above 20% earns a positive premium.",
  ob_savings_rate: "Statement-derived savings rate: (inflows − outflows) ÷ inflows. Negative means the account is being drawn down. Below 0% = maximum stress penalty. Above 20% earns a positive premium.",
  loan_repayment_detected: "Whether the statement shows recurring debits matching loan-repayment patterns: regular near-equal amounts to the same payee on the same calendar week, in at least 2 consecutive months. 'Yes' confirms existing loan obligations are being serviced — adds to the active obligations picture.",

  // ── Statement: positive signals ─────────────────────────────────────────────
  payroll_detected: "Whether a payroll or salary credit was detected: a credit within ±10% of the same amount from the same sender (or payroll narrative) on the same week of the month for 2+ consecutive months. The strongest income verification signal available from statement data.",
  ob_payroll_detected: "Whether a payroll or salary credit was detected in the statement: a credit within ±10% of the same amount from the same sender on the same week of the month for 2+ consecutive months. The strongest income verification signal available from statement data.",
  remittance_detected: "Whether inbound remittance transfers appear — identified by SWIFT sender codes, 'Remittance'/'Transfer from abroad' narratives, or known diaspora operators (Western Union, Sendwave, Flutterwave, etc.). Regular remittances count toward income stability.",
  ob_remittance_detected: "Whether inbound remittance transfers appear — identified by SWIFT sender codes, 'Remittance'/'Transfer from abroad' narratives, or known diaspora operators. Regular remittances count toward income stability.",
  ob_recurring_credits_count: "Count of distinct recurring credit sources — same sender appearing in 3 or more months. Multiple independent income sources (salary + rent + freelance) reduce income concentration risk. A value of 4 means four independent verified income streams.",
  mobile_money_transaction_ratio: "OPay, Kuda, Palmpay, and similar e-wallet transactions as a share of total transaction volume. Below 20% = normal. High ratios in high-value products may indicate informal-economy reliance, reducing predictive signal quality from other features.",
  ob_mobile_money_ratio: "OPay, Kuda, Palmpay, and similar e-wallet transactions as a share of total transaction volume. Below 20% = normal. High ratios may indicate informal-economy reliance, reducing predictive signal quality from other features.",
  ob_utility_payments_ratio: "Utility bill payments (electricity, water, cable, internet) as a share of total debit volume. Regular utility payments are a mild positive signal of residential stability and bill-paying discipline.",
  ob_max_single_credit: "The single largest credit transaction as a ratio of average monthly income. A very large one-off credit relative to income may indicate a loan disbursement, gift, or irregular income rather than sustainable earnings.",
  ob_credit_debit_ratio: "Total credits ÷ total debits over the statement period. Above 1.0 means more money is coming in than going out. Well below 1.0 indicates the account is a pass-through or the applicant draws from other sources.",
  account_inflow_coverage: "Six-month total inflow ÷ six-month total outflow. Above 1.0 = inflows cover outflows. Below 1.0 = the account is being drawn down over the period — a structural affordability concern.",

  // ── Identity & KYC ───────────────────────────────────────────────────────────
  identity_name_match: "Jaro-Winkler similarity between the BVN-registered name and the name on the bank statement, account lookup, or bureau report. 1.0 = exact match (full positive). ≥ 0.90 = high confidence match (partial positive). Below 0.85 = strong fraud flag — identity documents may belong to different people.",
  identity_name_match_score: "Name-match confidence between BVN identity and statement/bureau records. 1.0 = exact. ≥ 0.90 = high confidence. Below 0.85 = mismatch flag — triggers enhanced review of all identity documents.",
  bvn_verified: "Overall BVN verification status. Full credit = BVN matched with NIN and statement account name. Partial = BVN matched but name diverges slightly (fuzzy ≥ 90%). Zero = BVN blocked, NIN mismatch, or verification call failed. Unverified BVN is the highest-impact single identity penalty.",
  account_name: "Name on the bank account from the account lookup or statement parser, used for identity name-match verification. The score impact comes from comparing this name to the BVN-registered name — a close match earns positive contribution; divergence is a fraud flag.",
  identity_verified: "Whether biometric or government-ID identity verification passed. 'Yes' earns positive contribution and unlocks full scoring. 'No' is a significant identity-risk penalty, unless the applicant is an RC-only business owner where BVN identity doesn't apply.",
  identity_address_verified: "Whether the applicant's residential address was verified against a utility bill, bank statement, or address-verification provider. Verified address is a mild positive identity-continuity signal.",
  pep_flagged: "Whether the borrower was identified as a Politically Exposed Person (current or former government official, senior executive, close associate, or immediate family member). PEP status requires enhanced due diligence under CBN AML/CFT guidelines. When Block PEP is enabled, this triggers a hard decline.",
  watchlist_clear: "Whether OFAC sanctions, UNSC designations, EFCC watchlist, CBN blacklist, and internal fraud list checks all returned clear. 'Clear' = maximum positive contribution for this feature. Any confirmed match is the highest-weight single negative signal in the scorecard — triggers a hard decline gate.",
  watchlist_match: "Whether OFAC sanctions, UNSC designations, EFCC watchlist, CBN blacklist, or internal fraud list checks returned a match. 'No' = maximum positive contribution. Any confirmed match is the highest-weight single negative signal — triggers a hard decline gate.",
  gsi_flag: "Global Standing Instruction indicator. Detected from narrations matching CBN GSI mandate patterns or NIBSS garnishment codes. An active GSI means another lender has already authorised account-level recovery. Lending into active GSI recovery directly competes with that recovery.",
  gsi_recovery_flag: "Active GSI recovery flag. True when statement narrations or open-banking data confirm the account is under CBN NIBSS garnishment for another lender. Repayment collections from the same account are competed against the garnishment — high non-payment risk.",

  // ── Document integrity ───────────────────────────────────────────────────────
  document_tamper_risk: "Statement authenticity risk score (0.0–1.0) from the Eye document parser. Detects: PDF metadata anomalies (edited creation date), font substitution (text inserted in a different typeface), impossible transaction sequences (credits without matching debits), balance inconsistency (running balance doesn't sum from transactions), and editing tool traces (Acrobat Pro, Nitro PDF, iLovePDF). Above 0.4 = flagged. Above 0.7 = hard gate.",
  auth_risk_score: "Statement authenticity risk score (0.0–1.0) from the Eye document parser: PDF metadata anomalies, font substitution, impossible transaction sequences, balance inconsistency, and editing-tool traces. Above 0.4 = flagged. Above 0.7 = hard gate.",

  // ── Profile ──────────────────────────────────────────────────────────────────
  age: "Applicant age in years. Scoring bands: 18–25 = higher risk (limited history, employment instability); 26–45 = prime lending age; 46–60 = moderate (shortened income horizon for long-tenor products); 60+ = elevated for tenors beyond 5 years.",
  borrower_age_years: "Applicant age from verified date of birth. 18–25 = highest age-related risk. 26–45 = prime age band, maximum positive. 46–60 = modest reduction. 60+ = penalised on long-tenor products. Age alone has moderate weight — it mainly calibrates other income and employment signals.",
  employment_type: "Employment stability tier. Scoring order (strongest to weakest): Government/civil service → Salaried private sector → Self-employed / business owner → Contractor/freelancer → Student → Unemployed. Each tier carries a fixed scorecard offset — government employment adds roughly +250 pts relative to unemployed.",
  borrower_category: "The borrower segment selected at origination. Valid segments: individual (no formal employment), employed (salary), business_owner (CAC-registered). Determines which evidence slots and scoring rules apply. Business owners use the financial ratio and revenue signals; employed borrowers use the payroll and income stability signals.",
  borrower_dependents: "Number of financial dependents declared by the applicant. A higher dependent count is used only as a mild affordability adjustment — it does not directly gate approval, but calibrates how conservatively disposable income is estimated.",
  borrower_job_tenure_months: "Months in current employment or self-employment role. Below 6 months = early-tenure risk. 12+ months = stable. 36+ months earns maximum tenure premium — long job tenure is one of the strongest employment-stability signals.",

  // ── Platform history ─────────────────────────────────────────────────────────
  active_loan_count: "Number of currently active loans on this platform for the applicant. Zero = no existing exposure. 1–2 = moderate. Above 3 = concentration risk — the tenant's appetite rules may cap lending to heavily-leveraged existing customers.",
  platform_repayment_rate: "On-time repayment rate across all historical loans on this platform. The most predictive feature for returning borrowers — stronger than bureau score for loans under 18 months. Above 0.95 = maximum platform positive. Below 0.80 = significant penalty.",
  platform_tenure_months: "Months since first registration on this platform. Longer tenure is associated with lower default risk for returning customers. Below 3 months = new customer, no platform premium. Above 24 months earns maximum tenure bonus (premium capped at 24 months).",
  platform_history: "Combined view of active loans and prior defaults on this platform. Zero active loans and zero prior defaults is the ideal starting position for a first-time or clean-history borrower.",

  // ── Business ─────────────────────────────────────────────────────────────────
  business_age: "Years since CAC registration or declared operating start, whichever is earlier. Under 1 year = startup risk (maximum penalty). 1–3 years = early stage. 3–10 years = established (full premium begins at 3 years). The 3-year survival threshold is the key inflection point.",
  business_age_years: "Years since CAC registration or declared operating start, whichever is earlier. Under 1 year = startup risk (maximum penalty). 1–3 years = early stage. 3–10 years = established (full premium begins at 3 years). The 3-year survival threshold is the key inflection point.",
  business_cac_registered: "Whether an active CAC registration was confirmed via the CAC public register. 'Yes' earns positive contribution and unlocks business evidence verification. 'No' or 'Failed' indicates an unregistered informal business — higher operational risk, no formal governance.",
  business_tin_registered: "Whether an active TIN was confirmed via the FIRS database. TIN registration demonstrates formal economic participation, at least basic tax compliance, and provides a FIRS identity anchor for further KYB steps.",
  business_employee_count: "Declared or verified headcount. Scale tiers: micro (1–5), small (6–20), medium (21–100), large (100+). Headcount calibrates the revenue-per-employee reasonableness check — unusually high revenue for a micro business raises verification flags.",
  business_industry: "CAC or applicant-declared sector, mapped to Phoenix industry risk tiers. Low risk: FMCG, pharma, agriculture, education, healthcare. Neutral: manufacturing, logistics, professional services. High risk: entertainment venues, forex/crypto trading, gambling operations. High-risk sectors apply a flat penalty of approximately −120 pts.",
  business_industry_code: "CAC or applicant-declared sector, mapped to Phoenix industry risk tiers. Low risk: FMCG, pharma, agriculture, education, healthcare. Neutral: manufacturing, logistics, professional services. High risk: entertainment venues, forex/crypto trading, gambling operations.",
  business_revenue: "Average monthly business revenue (declared or from financial statements). The key check is coverage: revenue ÷ monthly EMI must exceed 1.5× for comfortable servicing. Revenue below the monthly obligation is an automatic stress signal.",
  business_revenue_monthly_minor: "Average monthly business revenue (declared or from financial statements) in kobo. The key check is coverage: revenue ÷ monthly EMI must exceed 1.5× for comfortable servicing. Revenue below the monthly obligation is an automatic stress signal.",
  business_years_filing_tax: "Consecutive years of confirmed tax filing with FIRS. More years filing indicates sustained formal compliance and a longer verifiable financial history for the business.",

  // ── Financial ratios ─────────────────────────────────────────────────────────
  financial_current_ratio: "Current assets ÷ current liabilities from the balance sheet. Below 1.0 = technically short-term insolvent (cannot cover obligations from liquid assets). The lending threshold is 1.2×. Below 0.8 is a hard stress indicator regardless of other signals.",
  fs_current_ratio: "Current assets ÷ current liabilities from the balance sheet. Below 1.0 = technically short-term insolvent. The lending threshold is 1.2×. Below 0.8 is a hard stress indicator regardless of other signals.",
  financial_debt_to_equity: "Total liabilities ÷ shareholders' equity. Measures financial leverage. Above 2.0 is considered high-leverage for most sectors. Service businesses should stay below 1.5. Asset-heavy industries (manufacturing, real estate) tolerate higher ratios. Very high values (above 5×) indicate insolvency risk.",
  fs_debt_to_equity: "Total liabilities ÷ shareholders' equity. Above 2.0 is high-leverage for most sectors. Service businesses should stay below 1.5. Very high values (above 5×) indicate insolvency risk.",
  financial_net_profit_margin: "Net profit after tax ÷ total revenue. Below 5% for retail or below 10% for services is penalised. Any negative margin = losses. Above 20% earns a premium. Benchmarked against the declared industry sector.",
  fs_net_profit_margin: "Net profit after tax ÷ total revenue. Below 5% for retail or below 10% for services is penalised. Any negative margin = losses. Above 20% earns a premium.",
  financial_op_cash_flow_monthly_minor: "Monthly operating cash flow (before financing and investment activities) in kobo. The key metric: cash flow ÷ monthly EMI must exceed 1.0× — below this, the business cannot service the debt from operations alone. Cash flow is harder to manipulate than reported profit.",
  fs_operating_cash_flow: "Monthly operating cash flow (before financing and investment activities). The key metric: cash flow ÷ monthly EMI must exceed 1.0× — below this, the business cannot service the debt from operations alone.",
  financial_return_on_assets: "Net income ÷ total assets. Measures how efficiently the business generates profit. Below 2% = poor asset utilisation. Above 10% = strong. Cross-checked against industry norms — high ROA in capital-intensive industries is exceptional.",
  fs_return_on_assets: "Net income ÷ total assets. Below 2% = poor asset utilisation. Above 10% = strong. Cross-checked against industry norms.",

  // ── Telco ────────────────────────────────────────────────────────────────────
  sim_age_months: "Age of the applicant's mobile number in months from telco records. Below 6 months = elevated synthetic identity fraud risk (new SIMs are common in layered-fraud schemes). 12+ months = normal. 36+ months earns a light positive contribution to identity continuity.",
  telco_sim_age_months: "Age of the applicant's mobile number in months from telco records. Below 6 months = elevated synthetic identity fraud risk. 12+ months = normal. 36+ months earns a light positive contribution to identity continuity.",
  telco_tenure_months: "Estimated SIM tenure from telco data. Below 6 months = fraud risk flag. Above 24 months = positive identity continuity signal. Most predictive when combined with BVN match and account name match.",
  airtime_consistency: "Regularity of airtime or data top-up purchases. Frequent regular top-ups (daily or near-daily) indicate an actively used primary SIM. Very low frequency (less than monthly) may mean the submitted number is not the applicant's primary SIM — a common fraud indicator.",
  telco_airtime_consistency: "Regularity of airtime recharges from telco records. Consistent daily-to-weekly top-ups = primary SIM in active use. Sparse top-ups = possibly not the applicant's primary number, weakening all telco-derived identity signals.",
  telco_airtime_top_up_frequency: "Regularity of airtime or data top-up purchases per month. Frequent regular top-ups indicate an actively used primary SIM. Very low frequency may mean the submitted number is not the applicant's primary SIM.",
  telco_avg_recharge: "Average airtime or data bundle recharge amount. Used as a light socioeconomic proxy — higher average recharge loosely correlates with higher-income segments. Low standalone weight; primarily adjusts confidence in other telco signals.",
  telco_data_tier: "Estimated monthly data consumption tier from telco records. Higher consumption correlates with smartphone usage and digital financial service adoption. Very low usage may indicate a feature phone or an inactive SIM.",
  telco_data_usage_gb: "Estimated monthly data consumption in GB from telco records. Higher consumption correlates with smartphone usage and digital financial service adoption. Very low usage may indicate a feature phone or an inactive SIM.",
  telco_network_provider: "Mobile network operator (MTN, Airtel, Glo, 9mobile). Nearly neutral for credit risk — network preference is not predictive. The primary use is as a data availability flag: Eye knows which telcos it can query and adjusts confidence accordingly.",
  telco_device_type: "Device type (smartphone, feature phone) inferred from telco/network data. Smartphone usage correlates with digital financial service adoption; feature-phone-only usage is a mild data-availability flag, not a risk penalty itself.",
  network_provider: "Telco provider for the submitted mobile number. Neutral for scoring. Used to determine which enrichment calls are possible and to flag if the number is cross-carrier inconsistent with other identity documents.",

  // ── Account lookup ───────────────────────────────────────────────────────────
  institution: "The financial institution linked to the verified account. Used to validate that the account name, BVN, and bank match. Unexpected institution mismatches (e.g., BVN registered to a different bank) are flagged for manual review.",
  account_type: "Account classification from the bank or account lookup provider (Savings, Current, Corporate, or Domiciliary). Current accounts provide richer transactional data and more OB signal features. Domiciliary accounts indicate foreign currency exposure. Savings-only accounts have fewer usable behavioural signals.",
  account_age_months: "Age of the linked bank account in months from account lookup data. Below 6 months = thin relationship, limited behavioural history. 24+ months = established relationship, maximum premium.",
  account_avg_balance: "Average account balance as a ratio to monthly income. Below 0.2× = near-zero cash buffer (maximum stress penalty). 0.2–0.5× = adequate. Above 0.5× = healthy reserve.",

  // ── CAC/TIN metadata ─────────────────────────────────────────────────────────
  cac_number: "CAC RC number supplied for verification. Used to query the Corporate Affairs Commission register and confirm active status, registration date, and legal name. Mismatches between the CAC name and the BVN name trigger a KYB review flag.",
  cac_name: "Legal business name from the CAC register, cross-checked against the BVN-registered name, bank account name, and TIN name. Close matches earn positive contribution; significant divergence is a KYB fraud flag.",
  cac_registration_date: "Date of CAC registration from the public register. Used to calculate business age — the primary determinant of the business maturity score.",
  cac_status: "CAC registration status: Active, Struck Off, Dissolved, or Suspended. Only 'Active' earns positive contribution. Any other status means the business has no legal standing — treated as unregistered.",
  tin_number: "Tax Identification Number supplied for FIRS verification. Used to confirm business identity and tax compliance. TIN mismatch with the CAC name or BVN is flagged as a KYB red flag.",
  tin_name: "Business or taxpayer name from FIRS records. Cross-checked against CAC name and BVN. Material divergence triggers a KYB identity review.",
  tin_status: "FIRS registration status for the supplied TIN. 'Active' earns positive contribution. Inactive or unregistered reduces the business risk score.",
  tax_office: "FIRS tax office responsible for the TIN holder. Informational — used to assess whether the tax registration is consistent with the declared business location.",

  // ── Corporate bureau (business owners) ──────────────────────────────────────
  corp_bureau_score: "Business credit score from CRC Corporate or equivalent commercial bureau. Same 300–850 scale and band thresholds as the individual bureau score, applied to the registered business entity rather than the director personally.",
  corp_delinquent_facilities: "Count of business credit facilities with an active delinquency at the enquiry date. Zero is ideal. Any active business-facility delinquency is a significant penalty, since it reflects the entity's own repayment behaviour rather than the director's.",
  corp_worst_delinquency_days: "Worst historical days-past-due recorded against any business credit facility. Same banding as individual bureau delinquency: 0 = clean; 1–30 = minor; 31–90 = moderate; 91+ = severe.",
  corp_worst_delinquency: "Worst historical days-past-due recorded against any business credit facility. Same banding as individual bureau delinquency: 0 = clean; 1–30 = minor; 31–90 = moderate; 91+ = severe.",
  corp_payment_history_rate: "Fraction of business bureau-reported obligations paid on or before the due date. Above 0.90 = strong positive. Below 0.80 = penalty. The commercial-entity equivalent of the individual payment history signal.",
  corp_payment_history: "Fraction of business bureau-reported obligations paid on or before the due date. Above 0.90 = strong positive. Below 0.80 = penalty. The commercial-entity equivalent of the individual payment history signal.",

  // ── Requested amount ─────────────────────────────────────────────────────────
  requested_amount: "The loan amount requested by the applicant in naira. Used in affordability checks (EMI ÷ income), DTI calculation (monthly obligation ÷ income), and maximum eligible amount comparison. Does not directly affect the credit score, but triggers appetite gates if above the configured maximum request threshold.",
  requested_amount_minor: "Requested loan amount in kobo. Divide by 100 for naira. Used in all affordability, DTI, and exposure gate calculations.",

  // ── Statement metadata ───────────────────────────────────────────────────────
  months_of_banking_data: "Months of transaction data in the parsed statement. 1–2 months = thin file; confidence-scaled down. 3 months = minimum viable. 6 months = standard. 12+ months = full picture, maximum signal confidence. All OB features are confidence-weighted based on this count.",
  months_of_data: "Usable months of statement data included in cashflow analysis. Shorter periods cap the maximum contribution from all OB-derived features (inflow trend, savings rate, bounce count, etc.).",
  ob_months_of_data: "Usable months of statement data included in cashflow analysis. Shorter periods cap the maximum contribution from all open-banking-derived features.",
  transactions: "Total parsed statement transactions used for cashflow analytics. Very low counts (below ~20/month) may indicate a dormant or secondary account — reduces confidence in all cashflow signals.",
};

export function featureExplanation(factor: FeatureContribution | string): string {
  const raw = typeof factor === "string" ? factor : factor.feature || factor.label || "";
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const explanation = FEATURE_EXPLANATIONS[key] ?? FEATURE_EXPLANATIONS[key.replace(/_last_6_months$/, "_6m")];
  if (explanation) return explanation;
  const label = displaySource(raw || "feature");
  return `${label} is shown as a scorecard input so reviewers can see the exact value Eye used for this decision.`;
}
