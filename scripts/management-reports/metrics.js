'use strict';
// Metric queries shared by all reports. Every one encodes something learned by checking
// the data rather than assuming it.
const L = require('./lib.js');

const SPEND_CODES = `'200','202','300','303','423'`;
const CHANNELS = [
  { code: '423', name: 'Web transfer out' },
  { code: '202', name: 'Foreign purchase' },
  { code: '303', name: 'Utility payment' },
  { code: '200', name: 'Purchase / POS' },
  { code: '300', name: 'ATM cash advance' },
];

// Calls split by purpose. A collections call and a marketing call are different jobs;
// 97% of volume is marketing, so a blended "calls" figure is a marketing number wearing
// a contact-centre label. Legs are deduped and people counted distinctly per day.
// Customers are counted unique PER DAY and summed across the period: reaching the same
// person on Monday and again on Wednesday is two contacts, not one. Counting distinct
// over the whole window understated August marketing at 7,509 against a true 11,051.
const calls = (from, to) => L.q(`
  WITH d AS (
    SELECT coalesce(NULLIF(purpose,''),'unspecified') AS purpose,
           started_at::date AS day,
           count(DISTINCT customer_phone) AS people,
           count(*) AS legs,
           count(*) FILTER (WHERE outcome='completed') AS completed
    FROM app.helpdesk_calls
    WHERE started_at::date BETWEEN '${from}' AND '${to}'
      AND merged_into_call_id IS NULL AND voided_at IS NULL
    GROUP BY 1,2)
  SELECT purpose, sum(people)::int AS people, sum(legs)::int AS legs,
         sum(completed)::int AS completed
  FROM d GROUP BY 1 ORDER BY 3 DESC`);

const purposeOf = (rows, p) => rows.find((r) => r.purpose === p) || { people: 0, legs: 0, completed: 0, avg_sec: 0 };

// Funnel including conversion. Only 7 conversion EVENTS exist in the whole database and
// converted_at is 100% NULL, so the 1,454 contacts sitting at lead_stage='converted' are
// an undatable bulk backfill and cannot be attributed to any period. We report the events.
// Moves into each stage in the window. The re-grade of 14 Sept 2026 (migration 248) is a
// correction, not activity, so its events are left out; and a move into 'qualified' that
// the re-grade later reversed is not counted as a lead that became interested.
const funnel = (from, to) => L.q1(`
  SELECT count(*) FILTER (WHERE e.to_stage='contacted')::int AS contacted,
         count(*) FILTER (WHERE e.to_stage='qualified'
                            AND NOT EXISTS (SELECT 1 FROM app.crm_lead_events r
                                             WHERE r.contact_id = e.contact_id AND r.event = 'stage_regraded'
                                               AND r.created_at > e.created_at))::int AS qualified,
         count(*) FILTER (WHERE e.to_stage='disqualified')::int AS disqualified,
         count(*) FILTER (WHERE e.to_stage='converted')::int AS converted
  FROM app.crm_lead_events e
  WHERE e.created_at::date BETWEEN '${from}' AND '${to}' AND e.event <> 'stage_regraded'`);

// What the reports call the 'qualified' stage. Until migration 248 has run, 'qualified'
// still includes everyone the call centre reached, and calling that "interested" would
// be untrue; from then on only an interested call puts a lead there. Checked once per run.
let leadWordMemo = null;
const leadWord = () => {
  if (!leadWordMemo) {
    const live = !!L.q1(`SELECT EXISTS (SELECT 1 FROM app.schema_migrations WHERE filename LIKE '248%') AS live`).live;
    leadWordMemo = live ? { title: 'Interested', lower: 'interested' } : { title: 'Qualified', lower: 'qualified' };
  }
  return leadWordMemo;
};

// Total customer-facing card spend. Bank postings (interest, adjustments) are excluded:
// in August they were N169.6m of N391.3m of debits and would read as customer spending.
const spendTotal = (from, to) => L.q1(`
  SELECT coalesce(sum(amount_debit) FILTER (WHERE txn_code IN (${SPEND_CODES})),0)::float AS spend,
         count(*) FILTER (WHERE txn_code IN (${SPEND_CODES}))::int AS txns,
         count(DISTINCT account_id) FILTER (WHERE txn_code IN (${SPEND_CODES}))::int AS cards,
         coalesce(sum(amount_credit) FILTER (WHERE channel='collection'),0)::float AS repayments,
         coalesce(sum(amount_debit),0)::float AS all_debits
  FROM app.transactions
  WHERE post_date BETWEEN '${from}' AND '${to}' AND post_date <= current_date`);

const spendByChannel = (from, to) => L.q(`
  SELECT txn_code, coalesce(sum(amount_debit),0)::float AS v, count(*)::int AS n
  FROM app.transactions
  WHERE post_date BETWEEN '${from}' AND '${to}' AND post_date <= current_date
    AND txn_code IN (${SPEND_CODES}) AND amount_debit > 0
  GROUP BY 1`);

// Card products, per the card_products table (100% join coverage on system_name).
// Blink is the virtual prepaid line, identified by its notes field.
//
// "Transacting" is the honest measure of an active card, NOT expiry: 525 cards with a
// past card_expiry_date transacted in the last 90 days, so the expiry field appears to
// hold the original issue expiry and survives reissue. Expiry is reported separately
// and labelled, never used to claim a card is unusable.
const cardProducts = (from, to) => L.q(`
  WITH u AS (
    SELECT account_id, sum(amount_debit) AS spend, count(*) AS n
    FROM app.transactions
    WHERE post_date BETWEEN '${from}' AND '${to}' AND post_date <= current_date
      AND amount_debit > 0 AND txn_code IN (${SPEND_CODES})
    GROUP BY 1)
  SELECT CASE WHEN cp.notes ILIKE '%blink%' THEN 'Blink'
              WHEN cp.category='credit' THEN 'Credit card'
              WHEN cp.category='prepaid' THEN 'Prepaid card'
              ELSE coalesce(cp.category,'Other') END AS product,
         count(*)::int AS total,
         count(*) FILTER (WHERE a.status IN ('Active','Open'))::int AS live,
         count(*) FILTER (WHERE a.card_expiry_date >= current_date)::int AS unexpired,
         count(u.account_id)::int AS transacting,
         coalesce(sum(u.spend),0)::float AS spend
  FROM app.accounts a
  JOIN app.card_products cp ON cp.system_name = a.product_name
  LEFT JOIN u ON u.account_id = a.account_id
  WHERE a.product_line IN ('card','prepaid')
  GROUP BY 1 ORDER BY 6 DESC`);

const collections = (from, to) => L.q1(`
  SELECT coalesce(sum(amount_kobo) FILTER (WHERE status='approved'),0)/100.0 AS approved,
         count(*) FILTER (WHERE status='approved')::int AS approved_n,
         coalesce(sum(amount_kobo) FILTER (WHERE status<>'approved'),0)/100.0 AS pending,
         count(*) FILTER (WHERE status<>'approved')::int AS pending_n
  FROM app.collection_payments WHERE payment_date BETWEEN '${from}' AND '${to}'`);

// Recovery is reported as stock and value recovered, never as "cases opened": 1,585 cases
// were opened in one week of August by bulk import, which would read as a cliff afterwards.
const recovery = () => L.q1(`
  SELECT count(*) FILTER (WHERE status='active')::int AS active,
         count(*) FILTER (WHERE status='legal')::int AS legal,
         coalesce(sum(outstanding_kobo) FILTER (WHERE status IN ('active','legal')),0)/100.0 AS outstanding,
         coalesce(sum(recovered_kobo),0)/100.0 AS recovered
  FROM app.recovery_cases`);

// An applicant can apply more than once: of 5 applications on file, one person appears
// twice, so 5 applications are 4 people.
//
// Identity deliberately does NOT use CIF. Applications arrive from the workspace through
// Phoenix and the applicant may be neither a cardholder nor a fully registered customer,
// so a CIF often does not exist yet — it is empty on every application on file. Phone,
// then email, then name is the honest ladder.
const APPLICANT_KEY = `coalesce(NULLIF(btrim(applicant_phone),''), NULLIF(btrim(phone),''),
                                lower(NULLIF(btrim(applicant_email),'')), lower(NULLIF(btrim(email),'')),
                                lower(btrim(applicant_name)))`;

const risk = (from, to) => L.q1(`
  SELECT count(*)::int AS submitted,
         count(DISTINCT ${APPLICANT_KEY})::int AS applicants,
         count(*) FILTER (WHERE decision='approve')::int AS approved,
         count(*) FILTER (WHERE decision='decline')::int AS declined,
         count(*) FILTER (WHERE decision IS NULL)::int AS undecided
  FROM app.loan_applications WHERE created_at::date BETWEEN '${from}' AND '${to}'`);

// What people are actually applying for. product_type is the only populated product
// field; loan_product and loan_type are empty on every row.
const riskByProduct = (from, to) => L.q(`
  SELECT coalesce(NULLIF(btrim(product_type),''),'Unspecified') AS product,
         count(*)::int AS n,
         count(DISTINCT ${APPLICANT_KEY})::int AS applicants,
         count(*) FILTER (WHERE decision='approve')::int AS approved,
         count(*) FILTER (WHERE decision='decline')::int AS declined,
         coalesce(sum(amount_requested_kobo),0)/100.0 AS requested
  FROM app.loan_applications
  WHERE created_at::date BETWEEN '${from}' AND '${to}'
  GROUP BY 1 ORDER BY 2 DESC`);

const topDecline = () => L.q1(`
  SELECT coalesce(decline_reason,'-') AS reason, count(*)::int AS n
  FROM app.loan_applications WHERE decline_reason IS NOT NULL AND decline_reason<>''
  GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);

// Geography is the only demographic with usable coverage (72%). Age is on 44% of
// cardholders. Gender is deliberately absent: 795 of 21,309 customers (3.7%), with
// values including "0" and "1" - not reportable.
const geography = () => L.q(`
  SELECT CASE WHEN upper(btrim(state)) IN ('FCT','ABUJA','FCT ABUJA','FEDERAL CAPITAL TERRITORY')
              THEN 'FCT / Abuja' ELSE initcap(lower(btrim(state))) END AS s,
         count(*)::int AS n
  FROM app.customers
  WHERE state IS NOT NULL AND btrim(state) <> '' AND btrim(state) !~ '^[0-9]+$'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 6`);

const ageBands = () => L.q(`
  SELECT CASE WHEN c.birthday IS NULL THEN 'Not recorded'
              WHEN age(c.birthday) < interval '35 years' THEN 'Under 35'
              WHEN age(c.birthday) < interval '45 years' THEN '35 to 44'
              WHEN age(c.birthday) < interval '55 years' THEN '45 to 54'
              ELSE '55 and over' END AS band,
         count(DISTINCT a.account_id)::int AS cards
  FROM app.accounts a JOIN app.customers c ON c.cif = a.cif
  WHERE a.product_line IN ('card','prepaid')
  GROUP BY 1 ORDER BY 2 DESC`);

const booked = (from, to) => L.q1(`
  SELECT (SELECT coalesce(sum(principal_kobo),0)/100.0 FROM app.cbs_fixed_deposits
            WHERE date_booked::date BETWEEN '${from}' AND '${to}')::float AS fd,
         (SELECT count(*) FROM app.cbs_fixed_deposits
            WHERE date_booked::date BETWEEN '${from}' AND '${to}')::int AS fd_n,
         (SELECT coalesce(sum(loan_amount_kobo),0)/100.0 FROM app.cbs_loans
            WHERE start_date::date BETWEEN '${from}' AND '${to}' AND start_date::date <= current_date)::float AS loan,
         (SELECT count(*) FROM app.cbs_loans
            WHERE start_date::date BETWEEN '${from}' AND '${to}' AND start_date::date <= current_date)::int AS loan_n`);

const targets = (period) => L.q1(`
  SELECT count(*)::int AS officers, coalesce(sum(fd_amount_kobo),0)/100.0 AS fd,
         coalesce(sum(disbursement_kobo),0)/100.0 AS loan
  FROM app.sales_targets WHERE period='${period}'`);

// Deposits attribute through the account officer on the customer record (237 of 237
// covered); loans through the Udara officer map, which resolves every producer including
// the misspelled and trailing-space variants.
const scoreboard = (period, from, to) => L.q(`
  WITH tgt AS (SELECT user_id, fd_amount_kobo/100.0 AS fd_t, disbursement_kobo/100.0 AS loan_t
               FROM app.sales_targets WHERE period='${period}'),
  fd AS (SELECT co.officer_id AS uid, sum(f.principal_kobo)/100.0 AS v, count(*) AS n
         FROM app.cbs_fixed_deposits f JOIN app.customer_officers co ON co.cif=f.cbs_customer_id
         WHERE f.date_booked::date BETWEEN '${from}' AND '${to}' GROUP BY 1),
  ln AS (SELECT m.officer_user_id AS uid, sum(l.loan_amount_kobo)/100.0 AS v, count(*) AS n
         FROM app.cbs_loans l JOIN app.cbs_officer_map m ON btrim(m.udara_name)=btrim(l.officer_name)
         WHERE l.start_date::date BETWEEN '${from}' AND '${to}' AND l.start_date::date <= current_date GROUP BY 1)
  SELECT u.id::int AS uid, u.full_name AS officer, u.role,
         coalesce(t.fd_t,0)::float AS fd_t, coalesce(fd.v,0)::float AS fd_v, coalesce(fd.n,0)::int AS fd_n,
         coalesce(t.loan_t,0)::float AS loan_t, coalesce(ln.v,0)::float AS loan_v, coalesce(ln.n,0)::int AS loan_n
  FROM tgt t JOIN app.o3c_users u ON u.id=t.user_id
  LEFT JOIN fd ON fd.uid=u.id LEFT JOIN ln ON ln.uid=u.id
  ORDER BY coalesce(fd.v,0) DESC`);

// A team's roster is its members PLUS its head. Counting only sales_team_members dropped
// the head's own production: Team Jennifer showed N24.6m in August while Jennifer Igwilo
// personally booked N682.6m, because she is the team head and not listed as a member.
const teams = (period, from, to) => L.q(`
  WITH roster AS (
    SELECT st.id AS team_id, st.name, stm.user_id
    FROM app.sales_teams st JOIN app.sales_team_members stm ON stm.team_id=st.id
    WHERE st.is_active
    UNION
    SELECT st.id, st.name, st.head_user_id
    FROM app.sales_teams st WHERE st.is_active AND st.head_user_id IS NOT NULL),
  fd AS (SELECT co.officer_id AS uid, sum(f.principal_kobo)/100.0 AS v
         FROM app.cbs_fixed_deposits f JOIN app.customer_officers co ON co.cif=f.cbs_customer_id
         WHERE f.date_booked::date BETWEEN '${from}' AND '${to}' GROUP BY 1),
  ln AS (SELECT m.officer_user_id AS uid, sum(l.loan_amount_kobo)/100.0 AS v
         FROM app.cbs_loans l JOIN app.cbs_officer_map m ON btrim(m.udara_name)=btrim(l.officer_name)
         WHERE l.start_date::date BETWEEN '${from}' AND '${to}' AND l.start_date::date <= current_date GROUP BY 1)
  SELECT r.name AS team, count(DISTINCT r.user_id)::int AS members,
         coalesce(sum(fd.v),0)::float AS fd_v, coalesce(sum(ln.v),0)::float AS loan_v,
         coalesce(sum(t.fd_amount_kobo)/100.0,0)::float AS fd_t,
         coalesce(sum(t.disbursement_kobo)/100.0,0)::float AS loan_t
  FROM roster r
  LEFT JOIN app.sales_targets t ON t.user_id=r.user_id AND t.period='${period}'
  LEFT JOIN fd ON fd.uid=r.user_id LEFT JOIN ln ON ln.uid=r.user_id
  GROUP BY 1 ORDER BY 3 DESC`);

// Business written by people who carry no target - nearly half the deposit book.
// People who carry no sales target but still brought business in. Cards count here as
// well as deposits: someone in ops or service who sells a card is exactly the person
// this section exists to surface, and crediting only deposits made them invisible.
const contributors = (from, to) => L.q(`
  WITH fd AS (
    SELECT co.officer_id AS uid, sum(f.principal_kobo)/100.0 AS v, count(*)::int AS n
    FROM app.cbs_fixed_deposits f
    JOIN app.customer_officers co ON co.cif=f.cbs_customer_id
    WHERE f.date_booked::date BETWEEN '${from}' AND '${to}'
    GROUP BY 1),
  cd AS (
    SELECT v.officer_id AS uid, count(*)::int AS cards
    FROM app.v_card_sale_officer v
    WHERE v.officer_id IS NOT NULL
      AND v.opened_date BETWEEN '${from}' AND '${to}'
    GROUP BY 1),
  ids AS (SELECT uid FROM fd UNION SELECT uid FROM cd)
  SELECT u.full_name AS person, u.role,
         coalesce(fd.v,0)::float AS v, coalesce(fd.n,0)::int AS n,
         coalesce(cd.cards,0)::int AS cards
  FROM ids i
  JOIN app.o3c_users u ON u.id=i.uid AND u.deleted_at IS NULL
  LEFT JOIN fd ON fd.uid=i.uid
  LEFT JOIN cd ON cd.uid=i.uid
  WHERE NOT EXISTS (SELECT 1 FROM app.sales_targets t WHERE t.user_id=u.id)
  ORDER BY coalesce(fd.v,0) DESC, coalesce(cd.cards,0) DESC LIMIT 6`);

// How many of the period's card sales have a person against them. Reported next to the
// card numbers because "0 cards" and "0 cards credited" look identical in a report and
// mean opposite things -- the first says nobody sold, the second says nobody recorded it.
const cardCoverage = (from, to) => L.q1(`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE officer_id IS NOT NULL)::int AS credited,
         count(*) FILTER (WHERE officer_id IS NULL)::int AS uncredited
  FROM app.v_card_sale_officer
  WHERE opened_date BETWEEN '${from}' AND '${to}'`);

const maturities = () => L.q1(`
  SELECT count(*) FILTER (WHERE maturity_date::date < current_date)::int AS od_n,
         coalesce(sum(principal_kobo) FILTER (WHERE maturity_date::date < current_date),0)/100.0 AS od_v,
         count(*) FILTER (WHERE maturity_date::date BETWEEN current_date AND current_date+7)::int AS w_n,
         coalesce(sum(principal_kobo) FILTER (WHERE maturity_date::date BETWEEN current_date AND current_date+7),0)/100.0 AS w_v,
         count(*) FILTER (WHERE maturity_date::date BETWEEN current_date+8 AND current_date+30)::int AS m_n,
         coalesce(sum(principal_kobo) FILTER (WHERE maturity_date::date BETWEEN current_date+8 AND current_date+30),0)/100.0 AS m_v,
         coalesce(sum(principal_kobo),0)/100.0 AS book, count(*)::int AS book_n
  FROM app.cbs_fixed_deposits WHERE status='Active'`);

const loanMaturities = () => L.q1(`
  SELECT count(*) FILTER (WHERE maturity_date::date < current_date)::int AS od_n,
         coalesce(sum(outstanding_principal_kobo+outstanding_interest_kobo) FILTER (WHERE maturity_date::date < current_date),0)/100.0 AS od_v,
         count(*) FILTER (WHERE maturity_date::date BETWEEN current_date AND current_date+30)::int AS m_n,
         coalesce(sum(outstanding_principal_kobo+outstanding_interest_kobo) FILTER (WHERE maturity_date::date BETWEEN current_date AND current_date+30),0)/100.0 AS m_v,
         coalesce(sum(outstanding_principal_kobo+outstanding_interest_kobo),0)/100.0 AS book
  FROM app.cbs_loans WHERE status IN ('Active','Defaulting','Expired')`);

const tickets = (from, to) => L.q1(`
  SELECT count(*) FILTER (WHERE created_at::date BETWEEN '${from}' AND '${to}')::int AS opened,
         count(*) FILTER (WHERE status='resolved' AND updated_at::date BETWEEN '${from}' AND '${to}')::int AS closed
  FROM app.helpdesk_tickets WHERE deleted_at IS NULL`);

const backlog = () => L.q1(`
  SELECT count(*)::int AS open, count(*) FILTER (WHERE sla_breached)::int AS breached,
         count(*) FILTER (WHERE created_at < now()-interval '7 days')::int AS old7
  FROM app.helpdesk_tickets WHERE status NOT IN ('closed') AND deleted_at IS NULL`);

const registrations = (from, to) => L.q1(`
  SELECT (SELECT count(*) FROM app.customers WHERE created_at::date BETWEEN '${from}' AND '${to}')::int AS customers,
         (SELECT count(*) FROM app.accounts WHERE opened_date BETWEEN '${from}' AND '${to}')::int AS cards`);

const feedState = () => L.q1(`
  SELECT max(post_date)::text AS thru, (current_date - max(post_date))::int AS age
  FROM app.transactions WHERE source='feed'`);

const workDaysLeft = () => L.q1(`
  SELECT count(*)::int AS n FROM generate_series(current_date+1,
    (date_trunc('month',current_date) + interval '1 month' - interval '1 day')::date,'1 day') d
  WHERE extract(isodow from d) BETWEEN 1 AND 5`).n;

// Explicit window, so a report about August charts August rather than the last 30 days.
const seriesBetween = (from, to) => L.q(`
  WITH d AS (SELECT generate_series(date '${from}', LEAST(date '${to}', current_date-1), '1 day')::date AS day)
  SELECT d.day::text AS day, to_char(d.day,'Dy') AS dow,
    (SELECT count(DISTINCT customer_phone) FROM app.helpdesk_calls h
       WHERE h.started_at::date=d.day AND h.purpose='marketing'
         AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL)::int AS pitched,
    (SELECT count(*) FROM app.crm_lead_events e WHERE e.created_at::date=d.day AND e.to_stage='qualified')::int AS qualified,
    (SELECT coalesce(sum(t.amount_debit),0) FROM app.transactions t
       WHERE t.post_date=d.day AND t.txn_code IN (${SPEND_CODES}))::float AS spend
  FROM d ORDER BY d.day`);

const series = (days) => L.q(`
  WITH d AS (SELECT generate_series(current_date-${days}, current_date-1, '1 day')::date AS day)
  SELECT d.day::text AS day, to_char(d.day,'Dy') AS dow,
    (SELECT count(DISTINCT customer_phone) FROM app.helpdesk_calls h
       WHERE h.started_at::date=d.day AND h.purpose='marketing'
         AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL)::int AS pitched,
    (SELECT count(*) FROM app.crm_lead_events e WHERE e.created_at::date=d.day AND e.to_stage='qualified')::int AS qualified,
    (SELECT coalesce(sum(t.amount_debit),0) FROM app.transactions t
       WHERE t.post_date=d.day AND t.txn_code IN (${SPEND_CODES}))::float AS spend
  FROM d ORDER BY d.day`);

const fdSeries = () => L.q(`
  SELECT snapshot_date::text AS day, (fd_principal_kobo/100.0)::float AS v
  FROM app.cbs_portfolio_snapshot WHERE snapshot_date >= current_date-13 ORDER BY snapshot_date`);

const AGE_BAND = `CASE WHEN c.birthday IS NULL THEN 'Not recorded'
       WHEN age(c.birthday) < interval '35 years' THEN 'Under 35'
       WHEN age(c.birthday) < interval '45 years' THEN '35 to 44'
       WHEN age(c.birthday) < interval '55 years' THEN '45 to 54'
       ELSE '55 and over' END`;

const LOCATION = `CASE WHEN c.state IS NULL OR btrim(c.state)='' OR btrim(c.state) ~ '^[0-9]+$' THEN 'Not recorded'
       WHEN upper(btrim(c.state)) IN ('FCT','ABUJA','FCT ABUJA','FEDERAL CAPITAL TERRITORY') THEN 'FCT / Abuja'
       ELSE initcap(lower(btrim(c.state))) END`;

const SPEND_JOIN = `FROM app.transactions t
  JOIN app.accounts a ON a.account_id = t.account_id
  LEFT JOIN app.customers c ON c.cif = a.cif`;

const spendByLocation = (from, to) => L.q(`
  SELECT ${LOCATION} AS label, count(DISTINCT t.account_id)::int AS cards,
         coalesce(sum(t.amount_debit),0)::float AS spend
  ${SPEND_JOIN}
  WHERE t.post_date BETWEEN '${from}' AND '${to}' AND t.post_date <= current_date
    AND t.amount_debit > 0 AND t.txn_code IN (${SPEND_CODES})
  GROUP BY 1 ORDER BY 3 DESC LIMIT 6`);

const spendByAge = (from, to) => L.q(`
  SELECT ${AGE_BAND} AS label, count(DISTINCT t.account_id)::int AS cards,
         coalesce(sum(t.amount_debit),0)::float AS spend
  ${SPEND_JOIN}
  WHERE t.post_date BETWEEN '${from}' AND '${to}' AND t.post_date <= current_date
    AND t.amount_debit > 0 AND t.txn_code IN (${SPEND_CODES})
  GROUP BY 1 ORDER BY 3 DESC`);

const spendByProductAge = (from, to) => L.q(`
  SELECT CASE WHEN cp.notes ILIKE '%blink%' THEN 'Blink'
              WHEN cp.category='credit' THEN 'Credit card'
              WHEN cp.category='prepaid' THEN 'Prepaid card' ELSE 'Other' END AS product,
         ${AGE_BAND} AS label,
         coalesce(sum(t.amount_debit),0)::float AS spend
  ${SPEND_JOIN}
  JOIN app.card_products cp ON cp.system_name = a.product_name
  WHERE t.post_date BETWEEN '${from}' AND '${to}' AND t.post_date <= current_date
    AND t.amount_debit > 0 AND t.txn_code IN (${SPEND_CODES})
  GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`);

// Everyone who either carries a target or actually brought business in, with all three
// lines side by side. Card targets are carried but are zero in every period set so far.
const peopleScorecard = (period, from, to) => L.q(`
  WITH tgt AS (SELECT user_id, fd_amount_kobo/100.0 AS fd_t, disbursement_kobo/100.0 AS loan_t,
                      card_count AS card_t
               FROM app.sales_targets WHERE period='${period}'),
  fd AS (SELECT co.officer_id AS uid, sum(f.principal_kobo)/100.0 AS v, count(*) AS n
         FROM app.cbs_fixed_deposits f JOIN app.customer_officers co ON co.cif=f.cbs_customer_id
         WHERE f.date_booked::date BETWEEN '${from}' AND '${to}' GROUP BY 1),
  ln AS (SELECT m.officer_user_id AS uid, sum(l.loan_amount_kobo)/100.0 AS v, count(*) AS n
         FROM app.cbs_loans l JOIN app.cbs_officer_map m ON btrim(m.udara_name)=btrim(l.officer_name)
         WHERE l.start_date::date BETWEEN '${from}' AND '${to}' AND l.start_date::date <= current_date
         GROUP BY 1),
  -- Cards BROUGHT IN during the period, on the same basis as deposits and loans.
  -- Not the stock of cards an officer's customers happen to hold: that rewards an old
  -- book rather than this period's work.
  -- v_card_sale_officer (migration 241) resolves the seller once, for the workspace and
  -- the reports alike: an explicit attribution beats the issuance record, which beats the
  -- legacy CIF book. Reading it here rather than joining customer_officers directly is
  -- what moves this off 0 cards credited -- cards are not in CBS and the account feed
  -- carries no officer, so the CIF book matched none of this year's 486 card accounts.
  cd AS (SELECT v.officer_id AS uid, count(*) AS cards,
                count(*) FILTER (WHERE v.product_line = 'card') AS credit_cards,
                count(*) FILTER (WHERE v.status IN ('Active','Open')) AS live
         FROM app.v_card_sale_officer v
         WHERE v.officer_id IS NOT NULL
           AND v.opened_date BETWEEN '${from}' AND '${to}'
         GROUP BY 1),
  ids AS (SELECT user_id AS uid FROM tgt
          UNION SELECT uid FROM fd UNION SELECT uid FROM ln UNION SELECT uid FROM cd)
  SELECT u.full_name AS person, u.role,
         (t.user_id IS NOT NULL) AS has_target,
         coalesce(t.fd_t,0)::float AS fd_t, coalesce(fd.v,0)::float AS fd_v, coalesce(fd.n,0)::int AS fd_n,
         coalesce(t.loan_t,0)::float AS loan_t, coalesce(ln.v,0)::float AS loan_v, coalesce(ln.n,0)::int AS loan_n,
         coalesce(cd.cards,0)::int AS cards, coalesce(cd.live,0)::int AS cards_live,
         coalesce(cd.credit_cards,0)::int AS credit_cards,
         coalesce(t.card_t,0)::int AS card_t
  FROM ids i
  JOIN app.o3c_users u ON u.id = i.uid AND u.deleted_at IS NULL
  LEFT JOIN tgt t ON t.user_id = i.uid
  LEFT JOIN fd ON fd.uid = i.uid
  LEFT JOIN ln ON ln.uid = i.uid
  LEFT JOIN cd ON cd.uid = i.uid
  ORDER BY (coalesce(fd.v,0) + coalesce(ln.v,0)) DESC, u.full_name`);

// ── Collections expected ─────────────────────────────────────────────────────
// Three sources, reported side by side and never summed: a loan in the collections book
// also has a core-banking instalment, so a single total would count it twice.

const instalmentAmount = 'principal_kobo + interest_kobo + fee_kobo';

/** Core-banking loan instalments falling due in a window, by where each one stands now. */
const loanInstalments = (from, to) => L.q1(`
  SELECT count(*)::int AS due_n,
         count(DISTINCT loan_account_number)::int AS loans,
         coalesce(sum(${instalmentAmount}), 0) / 100.0 AS due_v,
         count(*) FILTER (WHERE payment_status = 'FullyPaid')::int AS paid_n,
         coalesce(sum(${instalmentAmount}) FILTER (WHERE payment_status = 'FullyPaid'), 0) / 100.0 AS paid_v,
         count(*) FILTER (WHERE payment_status = 'PartiallyPaid')::int AS part_n,
         coalesce(sum(${instalmentAmount}) FILTER (WHERE payment_status = 'PartiallyPaid'), 0) / 100.0 AS part_v,
         count(*) FILTER (WHERE payment_status = 'DueAndUnpaid')::int AS unpaid_n,
         coalesce(sum(${instalmentAmount}) FILTER (WHERE payment_status = 'DueAndUnpaid'), 0) / 100.0 AS unpaid_v,
         count(*) FILTER (WHERE payment_status = 'NotYetDue')::int AS upcoming_n,
         coalesce(sum(${instalmentAmount}) FILTER (WHERE payment_status = 'NotYetDue'), 0) / 100.0 AS upcoming_v
    FROM app.cbs_loan_schedules
   WHERE payment_date::date BETWEEN '${from}' AND '${to}'`);

/**
 * The collections book by product: what the accounts under management are due to repay,
 * and what came in on those same accounts, so received-against-due compares like with
 * like. Card accounts carry no repayment amount, so their "due" is honestly zero.
 */
const collectionsBook = (from, to) => L.q(`
  SELECT a.product_type,
         count(*)::int AS accounts,
         count(*) FILTER (WHERE a.repayment_kobo > 0)::int AS with_repayment,
         coalesce(sum(a.repayment_kobo), 0) / 100.0 AS expected,
         coalesce(sum(a.outstanding_kobo), 0) / 100.0 AS outstanding,
         coalesce(sum(p.received), 0) / 100.0 AS received,
         coalesce(sum(p.received_n), 0)::int AS received_n,
         coalesce(sum(p.pending), 0) / 100.0 AS pending,
         coalesce(sum(p.pending_n), 0)::int AS pending_n
    FROM app.collection_assignments a
    LEFT JOIN (SELECT assignment_id,
                      sum(amount_kobo) FILTER (WHERE status = 'approved') AS received,
                      count(*) FILTER (WHERE status = 'approved') AS received_n,
                      sum(amount_kobo) FILTER (WHERE status <> 'approved' AND status NOT LIKE 'reject%') AS pending,
                      count(*) FILTER (WHERE status <> 'approved' AND status NOT LIKE 'reject%') AS pending_n
                 FROM app.collection_payments
                WHERE payment_date BETWEEN '${from}' AND '${to}'
                GROUP BY 1) p ON p.assignment_id = a.id
   WHERE a.superseded_by_id IS NULL AND a.status = 'active'
   GROUP BY 1 ORDER BY 1`);

/** The latest credit-card statement cycle on file, with its age so a stale one says so. */
const cardStatement = () => L.q1(`
  SELECT cycle_date::text AS cycle_date,
         (current_date - cycle_date)::int AS age_days,
         count(*) FILTER (WHERE minimum_payment_kobo > 0)::int AS due_n,
         coalesce(sum(minimum_payment_kobo), 0) / 100.0 AS min_due,
         count(*) FILTER (WHERE overdue_amount_kobo > 0)::int AS overdue_n,
         coalesce(sum(overdue_amount_kobo), 0) / 100.0 AS overdue
    FROM app.card_cycle_data
   WHERE cycle_date = (SELECT max(cycle_date) FROM app.card_cycle_data)
   GROUP BY cycle_date`);

// ── Leads after qualification ────────────────────────────────────────────────

const OPEN_AFTER_QUALIFIED = ['qualified', 'handed_to_sales', 'documents_requested', 'application_submitted', 'approved'];
const LEAD_STAGE_LABELS = {
  qualified: 'Qualified, not yet handed on',
  handed_to_sales: 'Handed to sales',
  documents_requested: 'Documents requested',
  application_submitted: 'Application submitted',
  approved: 'Approved, not yet converted',
};

/**
 * Every qualified lead still open, one row each: its stage, who holds it, and how many
 * days since it entered that stage. Entry comes from the event that moved it there,
 * falling back to the record's own dates, so this works before and after migration 246.
 */
const qualifiedWaiting = () => L.q(`
  WITH open AS (
    SELECT c.id, c.lead_stage, coalesce(c.lead_owner_id, c.assigned_to) AS owner_id,
           c.next_action_at, NULLIF(btrim(coalesce(c.product_interest, '')), '') AS product,
           coalesce((SELECT max(e.created_at) FROM app.crm_lead_events e
                      WHERE e.contact_id = c.id AND e.to_stage = c.lead_stage),
                    c.qualified_at, c.updated_at, c.created_at) AS entered_at
      FROM app.crm_contacts c
     WHERE c.lead_stage IN (${OPEN_AFTER_QUALIFIED.map((s) => `'${s}'`).join(',')}))
  SELECT o.lead_stage AS stage, coalesce(u.full_name, 'No one') AS owner,
         greatest(0, floor(extract(epoch FROM now() - o.entered_at) / 86400))::int AS days,
         (o.next_action_at IS NOT NULL) AS has_follow_up,
         (o.product IS NOT NULL) AS has_product
    FROM open o LEFT JOIN app.o3c_users u ON u.id = o.owner_id`);

/** Credit cards each target-holding officer brought in, against their card target. */
const creditCardsByOfficer = (period, from, to) => L.q(`
  SELECT u.full_name AS officer, u.role, coalesce(t.card_count, 0)::int AS card_t,
         count(v.account_no) FILTER (WHERE v.product_line = 'card')::int AS credit_cards
    FROM app.sales_targets t
    JOIN app.o3c_users u ON u.id = t.user_id
    LEFT JOIN app.v_card_sale_officer v
           ON v.officer_id = t.user_id AND v.opened_date BETWEEN '${from}' AND '${to}'
   WHERE t.period = '${period}'
   GROUP BY u.full_name, u.role, t.card_count
   ORDER BY credit_cards DESC, u.full_name`);

module.exports = {
  loanInstalments, collectionsBook, cardStatement, qualifiedWaiting, creditCardsByOfficer,
  OPEN_AFTER_QUALIFIED, LEAD_STAGE_LABELS, leadWord,
  SPEND_CODES, CHANNELS, calls, purposeOf, funnel, spendTotal, spendByChannel, cardProducts,
  spendByLocation, spendByAge, spendByProductAge, peopleScorecard, cardCoverage,
  collections, recovery, risk, riskByProduct, topDecline, geography, ageBands, booked, targets, scoreboard,
  teams, contributors, maturities, loanMaturities, tickets, backlog, registrations,
  feedState, workDaysLeft, series, seriesBetween, fdSeries,
};
