import { http, HttpResponse } from 'msw'

const API = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:8000'
const u = (path: string) => `${API}${path}`

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok  = (data: unknown) => HttpResponse.json(data as any)
// { data: X } wrapper — what most overview/collections/recovery/risk/sales endpoints return
const wd  = (data: unknown) => ok({ data })

function rng(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min }
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }
function isoDate(daysAgo = 0) { const d = new Date(); d.setDate(d.getDate() - daysAgo); return d.toISOString() }
function dateStr(daysAgo = 0) { return isoDate(daysAgo).slice(0, 10) }

const MONTHS_ISO = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(); d.setMonth(d.getMonth() - (6 - i)); return d.toISOString().slice(0, 7)
})

const FIRST = ['Adaeze','Babatunde','Chukwuemeka','Damilola','Funke','Gbenga','Halima','Ifeoma',
               'Jide','Kemi','Lanre','Musa','Ngozi','Obiora','Pelumi','Rashida','Seun','Temitope',
               'Uche','Victor','Wunmi','Yemi','Zainab','Amaka','Bolu','Chiamaka','Felix']
const LAST  = ['Adeyemi','Okonkwo','Eze','Olawale','Ibrahim','Adeleke','Nwosu','Okafor','Bello',
               'Ajayi','Obi','Lawal','Dike','Adeola','Chukwu','Musa','Osei','Garba','Abubakar']
const BANKS = ['Access Bank','GTBank','FirstBank','Zenith Bank','UBA','Stanbic IBTC','Fidelity Bank']
const STATES = ['Lagos','Abuja','Rivers','Ogun','Kano','Delta','Anambra','Oyo','Kaduna']
const DEPTS  = ['Sales','Collections','Recovery','Finance','Cards Ops','Risk','HR','Compliance',
                'IT','Call Centre','Business Development','Telemarketing']
const LOS_STAGES = ['draft','submitted','document_collection','risk_review','risk_head_review',
                    'pending_conditions','finance_approval','booking']
const LOS_PRODUCTS = ['Payday Loan','Salary Advance','Business Loan','Education Loan','Auto Loan']

const name  = () => `${pick(FIRST)} ${pick(LAST)}`
const email = (n: string) => `${n.toLowerCase().replace(' ', '.')}@o3capital.com`

// ── Auth ──────────────────────────────────────────────────────────────────────

const MOCK_USER = {
  user: { id: 1, name: 'Temitope Posi', email: 'admin@o3capital.com', role: 'md', pages: [], must_change_password: false },
}

const AUTH = [
  // Accept any credentials in mock mode
  http.post(u('/api/auth/token'), () => ok(MOCK_USER)),
  http.post(u('/api/auth/login'), () => ok(MOCK_USER)),
  http.get(u('/api/auth/me'), () => ok({ id: 1, sub: 'admin@o3capital.com', role: 'md',
    full_name: 'Temitope Posi', department: 'Executive', pages: [] })),
  http.get(u('/api/auth/totp/status'), () => ok({ totp_enabled: false })),
  http.post(u('/api/auth/totp/setup'),    () => ok({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/O3%20Capital' })),
  http.post(u('/api/auth/totp/verify'),   () => ok({ message: 'Two-factor authentication enabled' })),
  http.post(u('/api/auth/totp/disable'),  () => ok({ message: 'Disabled' })),
  http.post(u('/api/auth/change-password'),  () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/voice/status'), () => ok({ configured: false })),
  http.post(u('/api/auth/forgot-password'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/auth/logout'),          () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/auth/refresh'),         () => ok({ access_token: 'mock', token_type: 'bearer' })),
]

// ── Notifications & Approvals ─────────────────────────────────────────────────

const APPROVALS_DATA = [
  { id: 1, module: 'los',         title: 'Loan disbursement — Maker-Checker',   entity_name: 'Greenfield Pharma Ltd',       amount_kobo: 732_000_000, maker_name: 'Kehinde Adebayo', url: '/los',                     created_at: isoDate(0.3) },
  { id: 2, module: 'collections', title: 'PAR 90 write-off recommendation',     entity_name: 'Chiamaka Eze',                amount_kobo: 110_475_000, maker_name: 'Doris Nwosu',      url: '/collections',             created_at: isoDate(1.1) },
  { id: 3, module: 'finance',     title: 'Manual GL posting approval',           entity_name: 'EOD interbank settlement',    amount_kobo: 250_000_000, maker_name: 'Emeka Obi',         url: '/finance/manual-postings', created_at: isoDate(0.8) },
]

const NOTIF_ITEMS = [
  { id: 1, type: 'risk',       severity: 'red',   title: 'PTP broken — Chiamaka Eze',        body: '₦280,000 promised 01 Jul was not received. Account moved to 90+ bucket.', link: '/collections/promises',         read_at: null,                          created_at: new Date(Date.now() - 3_600_000).toISOString() },
  { id: 2, type: 'settlement', severity: 'blue',  title: 'NIP settlement received',           body: '₦1,200,000 from Adebayo Trading Ltd matched to loan LN-2214.',            link: '/settlements/nip',              read_at: null,                          created_at: new Date(Date.now() - 4_800_000).toISOString() },
  { id: 3, type: 'threshold',  severity: 'amber', title: 'PAR 30 threshold breach — Ikeja',  body: 'Branch PAR 30 crossed 7.5%. BI alert rule #14.',                           link: '/reports/kpi',                  read_at: null,                          created_at: new Date(Date.now() - 7_200_000).toISOString() },
  { id: 4, type: 'system',     severity: 'green', title: 'Nightly recon completed',           body: 'Bevertec ↔ app DB ↔ Paystack: 0 unmatched entries.',                       link: '/settlements/reconciliation',   read_at: new Date().toISOString(),      created_at: new Date(Date.now() - 21_600_000).toISOString() },
]

const NOTIF_APPROVALS = [
  http.get(u('/api/notifications'), () => ok({ items: NOTIF_ITEMS, unread_count: 3 })),
  http.post(u('/api/notifications/sse-ticket'), () => ok({ ticket: 'mock-ticket' })),
  http.post(u('/api/notifications/read-all'),   () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/approvals/pending'),  () => ok(APPROVALS_DATA)),
  http.get(u('/api/approvals/summary'),  () => ok({ total: APPROVALS_DATA.length, items: APPROVALS_DATA })),
  http.post(u('/api/approvals/:id/approve'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/approvals/:id/reject'),  () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/approvals/batch'),       () => new HttpResponse(null, { status: 204 })),
]

// ── Overview (Executive dashboard) ────────────────────────────────────────────
// All endpoints return { data: X }

const OVERVIEW = [
  http.get(u('/api/overview/kpis'), () => wd({
    portfolio_outstanding_kobo: 4_820_000_000_00, collections_rate_pct: 91.4,
    disbursements_mtd_kobo: 267_000_000_00, active_customers: 1247,
    portfolio_change_pct: 8.3, collections_change_pct: 1.2,
    disbursements_change_pct: 14.6, customers_change_pct: 5.4,
  })),
  http.get(u('/api/overview/fd-summary'), () => wd({
    total_fd_book_kobo: 1_240_000_000_00, active_fd_count: 184, maturing_30d: 12, new_this_month: 23,
  })),
  http.get(u('/api/overview/contact-center'), () => wd({
    open_tickets: 48, in_queue: 11, avg_first_response_mins: 4.2,
    sla_compliance_pct: 92.1, resolved_today: 37, escalations_open: 3,
  })),
  http.get(u('/api/overview/cards-summary'), () => wd({
    disputes_open: 14,
    green_count: 4120, green_outstanding_kobo: 82_400_000_00,
    gold_count: 2087, gold_outstanding_kobo: 62_610_000_00,
    platinum_count: 843, platinum_outstanding_kobo: 67_440_000_00,
    prepaid_ngn_count: 9210, prepaid_ngn_balance_kobo: 46_050_000_00,
    prepaid_usd_count: 312, prepaid_usd_balance_cents: 187_200_00,
    credit_ngn_count: 1840, credit_ngn_balance_kobo: 36_800_000_00,
  })),
  http.get(u('/api/overview/los-stages'), () => wd({
    draft: 12, submitted: 34, document_collection: 28, risk_review: 19,
    risk_head_review: 8, pending_conditions: 11, finance_approval: 6, booking: 4, active_count: 122,
  })),
  http.get(u('/api/overview/cc-stages'), () => wd({
    application: 41, doc_review: 27, credit_check: 18, risk_review: 9,
    approved: 14, issuance: 7, active: 3820,
  })),
  http.get(u('/api/overview/acquisition-funnel'), () => wd({
    leads: 2140, applications: 892, approved: 634, disbursed: 521,
  })),
  // /api/overview/monthly-volume, product-mix, dpd-trend, top-performers (period-aware)
  http.get(u('/api/overview/monthly-volume'), () => wd(
    MONTHS_ISO.map(m => ({ month: m, disbursements_kobo: rng(180, 380) * 1_000_000_00 }))
  )),
  http.get(u('/api/overview/product-mix'), () => wd(
    ['Green Card','Gold Card','Platinum Card','Prepaid NGN','Credit NGN'].map(p => ({
      product: p, count: rng(200, 2000), volume_kobo: rng(20, 200) * 1_000_000_00,
    }))
  )),
  http.get(u('/api/overview/dpd-trend'), () => wd(
    MONTHS_ISO.map(m => ({ month: m, par30: rng(5,12), par60: rng(2,7), par90: rng(1,4) }))
  )),
  http.get(u('/api/overview/top-performers'), () => wd(
    Array.from({ length: 8 }, () => ({ name: name(), dept: pick(['Sales','BD']), amount_kobo: rng(20,120)*1_000_000_00, count: rng(8,40) }))
  )),
]

// ── Sales ─────────────────────────────────────────────────────────────────────
// All return { data: X }

const SALES = [
  http.get(u('/api/sales/loan-kpis'), () => wd({
    disbursements_mtd_kobo: 267_000_000_00, disbursements_ytd_kobo: 1_840_000_000_00,
    active_loans: 4218, avg_loan_kobo: 62_500_00, npl_rate_pct: 4.2,
  })),
  http.get(u('/api/sales/contact-kpis'), () => wd({
    total: 842, active_this_month: 156, new_this_month: 23, conversion_rate_pct: 18.4,
  })),
  http.get(u('/api/sales/task-kpis'), () => wd({
    total: 214, open: 87, overdue: 12, completed_this_month: 45,
  })),
  http.get(u('/api/sales/monthly-disbursements'), () => wd(
    MONTHS_ISO.map(m => ({ month: m, disbursements_kobo: rng(180, 380) * 1_000_000_00 }))
  )),
  http.get(u('/api/sales/top-performers'), () => wd(
    Array.from({ length: 8 }, () => ({ name: name(), dept: 'Sales', amount_kobo: rng(20,120)*1_000_000_00, count: rng(8,40) }))
  )),
  http.get(u('/api/sales/recent-applications'), () => wd(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1, reference: `LA-2026-${String(i+100).padStart(4,'0')}`, applicant_name: name(),
      product_type: pick(LOS_PRODUCTS), amount_requested_kobo: rng(5,50)*1_000_000_00,
      stage: pick(LOS_STAGES), status: pick(['pending','in_review','approved']),
      submitted_at: isoDate(rng(0,14)), updated_at: isoDate(rng(0,3)),
    }))
  )),
  http.get(u('/api/sales/accounts-trend'), () => wd(
    MONTHS_ISO.map(m => ({ month: m, new_accounts: rng(80,200), closed_accounts: rng(10,40) }))
  )),
  http.get(u('/api/sales/funnel'), () => wd({
    registered: 8420, card_issued: 6830, card_active: 5940, transacting: 4210,
  })),
]

// ── CRM ───────────────────────────────────────────────────────────────────────
// /api/crm/contacts → { data: [], total } ; deals/users/tasks/pipeline → direct

const CRM_CONTACTS = Array.from({ length: 40 }, (_, i) => ({
  id: i+1, full_name: name(), phone: `080${rng(10000000,99999999)}`,
  email: `contact${i}@example.ng`, company: pick(['Shell Nigeria','MTN','Dangote',null]),
  source: pick(['Referral','Walk-in','Online','Campaign','BD']),
  status: pick(['lead','prospect','customer','churned']),
  assigned_to: name(), created_at: isoDate(rng(0,180)), last_activity: isoDate(rng(0,30)),
  tags: [] as string[],
}))

const CRM_DEALS = Array.from({ length: 20 }, (_, i) => ({
  id: i+1, title: `${pick(['Business Loan','Payroll Loan','Fleet Loan'])} — ${pick(LAST)} Co.`,
  contact_id: rng(1,40), contact_name: name(),
  stage: pick(['Prospecting','Qualification','Proposal','Negotiation','Closed Won','Closed Lost']),
  expected_value_kobo: rng(5,200)*1_000_000_00, probability: rng(10,90),
  expected_close: dateStr(rng(-30,90)), assigned_to: name(), created_at: isoDate(rng(0,60)),
}))

const CRM = [
  http.get(u('/api/crm/contacts'), () => ok({ data: CRM_CONTACTS, total: CRM_CONTACTS.length })),
  http.post(u('/api/crm/contacts'), () => ok({ id: 99 })),
  http.put(u('/api/crm/contacts/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/crm/contacts/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/crm/deals'), () => ok(CRM_DEALS)),
  http.post(u('/api/crm/deals'), () => ok({ id: 99, stage: 'Prospecting' })),
  http.put(u('/api/crm/deals/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/crm/pipeline'), () => ok({
    stages: ['Prospecting','Qualification','Proposal','Negotiation'].map(s => ({
      stage: s, count: rng(3,12), value_kobo: rng(20,200)*1_000_000_00,
    })),
  })),

  http.get(u('/api/crm/users'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({ id: i+1, full_name: name(), role: pick(['sales_officer','bd_officer','sales_head']) }))
  )),

  http.get(u('/api/crm/tasks'), () => ok(
    Array.from({ length: 18 }, (_, i) => ({
      id: i+1, title: pick(['Follow-up call','Send proposal','Collect documents','Check credit']),
      assigned_to: name(), contact_name: name(), due_date: dateStr(rng(-3,14)),
      priority: pick(['low','medium','high']), status: pick(['pending','in_progress','done','overdue']),
      created_at: isoDate(rng(0,14)),
    }))
  )),
  http.post(u('/api/crm/tasks'), () => ok({ id: 99 })),
  http.put(u('/api/crm/tasks/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/crm/reports/overview'), () => ok({
    total_contacts: 1420, total_leads: 380, total_customers: 290,
    total_deals: 84, won_deals: 38, lost_deals: 12,
    activities_30d: 247, open_tasks: 33, overdue_tasks: 5, open_requests: 8,
  })),
  http.get(u('/api/crm/reports/pipeline'), () => ok([
    { name:'Prospecting',  deal_count: 42, pipeline_value: 840_000_000_00, avg_probability: 20 },
    { name:'Qualification', deal_count: 28, pipeline_value: 560_000_000_00, avg_probability: 40 },
    { name:'Proposal',     deal_count: 18, pipeline_value: 432_000_000_00, avg_probability: 60 },
    { name:'Negotiation',  deal_count: 9,  pipeline_value: 270_000_000_00, avg_probability: 80 },
  ])),
  http.get(u('/api/crm/reports/contacts-by-source'), () => ok([
    { source:'Referral', total: 180, converted: 54 }, { source:'Walk-in', total: 142, converted: 38 },
    { source:'Online',   total: 98,  converted: 22 }, { source:'Campaign', total: 74, converted: 18 },
    { source:'BD',       total: 46,  converted: 14 },
  ])),
  http.get(u('/api/crm/reports/agent-performance'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, full_name: name(), role: pick(['loan_officer','relationship_manager','bd_executive']),
      activities: rng(20,80), deals_owned: rng(5,25), deals_won: rng(2,15),
      tasks_assigned: rng(10,30), tasks_done: rng(5,25), contacts_owned: rng(30,100),
    }))
  )),
  http.get(u('/api/crm/reports/new-contacts-trend'), () => ok(
    MONTHS_ISO.map(m => ({ month: m, new_contacts: rng(80,200), converted: rng(20,60) }))
  )),
]

// ── LOS ───────────────────────────────────────────────────────────────────────

const LOS_ROWS = Array.from({ length: 28 }, (_, i) => {
  const stage = pick(LOS_STAGES)
  const disbursed = stage === 'active'
  return {
    id: i+1, reference: `LA-2026-${String(i+100).padStart(4,'0')}`,
    applicant_name: name(), product_type: pick(LOS_PRODUCTS),
    amount_requested_kobo: rng(5,80)*1_000_000_00,
    stage, status: pick(['pending','in_review','approved','rejected']),
    assigned_officer_name: name(), submitted_at: isoDate(rng(1,21)),
    disbursed_at: disbursed ? isoDate(rng(1,14)) : null,
    updated_at: isoDate(rng(0,3)), created_at: isoDate(rng(2,30)),
  }
})

const LOS = [
  http.get(u('/api/los/queue'), () => wd(LOS_ROWS)),
  http.get(u('/api/los/stats'), () => wd({
    by_stage: LOS_STAGES.map(s => ({ stage: s, count: rng(4,30) })),
    by_status: [
      { status:'pending', count: 42 }, { status:'in_review', count: 28 },
      { status:'approved', count: 18 }, { status:'rejected', count: 6 },
    ],
    total_pipeline_kobo: 420_000_000_00, total_disbursed_kobo: 1_840_000_000_00,
    open_count: 94, avg_days_to_close: 4.7,
  })),
  http.get(u('/api/los/:id'), ({ params }) => wd({
    application: {
      id: Number(params.id), reference: `LA-2026-${params.id}`, applicant_name: name(),
      applicant_email: 'applicant@example.com', applicant_phone: '08012345678',
      applicant_cif: `CIF${String(params.id).padStart(7, '0')}`,
      product_type: 'Payday Loan',
      amount_requested_kobo: 25_000_000_00, amount_approved_kobo: 0,
      tenor_months: 6, interest_rate_bps: 300,
      purpose: 'Working capital', employer: 'Shell Nigeria',
      monthly_income_kobo: 45_000_000_00, monthly_obligation_kobo: 12_000_000_00,
      status: 'in_review', stage: pick(['document_collection', 'credit_check', 'risk_review', 'risk_head_review', 'finance_approval', 'booking']),
      decline_reason: null, sales_officer_id: null, assigned_to_user_id: null,
      submitted_at: isoDate(5), finance_approved_at: null, booked_at: null,
      created_at: isoDate(7), updated_at: isoDate(1),
      eye_score: rng(550, 750), eye_rating: pick(['A', 'B', 'C', null]),
      bureau_summary: null, dti_pct: 28.4,
    },
    events: [
      { id: 1, application_id: Number(params.id), event_type: 'stage_change', from_stage: null, to_stage: 'document_collection', actor_user_id: 1, actor_name: name(), notes: 'Application submitted', created_at: isoDate(7) },
      { id: 2, application_id: Number(params.id), event_type: 'stage_change', from_stage: 'document_collection', to_stage: 'credit_check', actor_user_id: 2, actor_name: name(), notes: 'Documents verified', created_at: isoDate(5) },
    ],
    notes: [
      { id: 1, author_id: 1, body: 'Customer profile looks good. Income verified.', is_internal: true, created_at: isoDate(4) },
    ],
    conditions: [
      { id: 1, condition_text: 'Provide last 3 months bank statement', is_met: true, met_by: 1, met_at: isoDate(5), created_at: isoDate(7) },
      { id: 2, condition_text: 'Employment letter required', is_met: false, met_by: null, met_at: null, created_at: isoDate(7) },
    ],
  })),
  http.post(u('/api/los'), () => ok({ id: 99, reference: 'LA-2026-0199', stage: 'draft' })),
  http.put(u('/api/los/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/los/:id/advance'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/los/:id/reject'),  () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/los/:id/notes'),   () => ok({ id: 1, note: 'Noted', created_at: isoDate() })),
]

// ── Collections ───────────────────────────────────────────────────────────────

const COLLECTIONS = [
  http.get(u('/api/collections/portfolio-kpis'), () => wd({
    par30_kobo: 241_000_000_00, par60_kobo: 98_000_000_00, par90_kobo: 42_000_000_00,
    total_outstanding_kobo: 4_820_000_000_00, total_accounts: 4218,
    delinquent_accounts: 381, current_rate_pct: 91.0,
  })),
  http.get(u('/api/collections/dpd-trend'), () => wd(
    MONTHS_ISO.map(m => ({
      month: m, par30_kobo: rng(180,280)*1_000_000_00,
      par60_kobo: rng(80,140)*1_000_000_00, par90_kobo: rng(30,70)*1_000_000_00,
    }))
  )),
  http.get(u('/api/collections/by-agent'), () => wd(
    Array.from({ length: 10 }, () => ({ Agent: name(), total: rng(20,80)*1_000_000_00, count: rng(15,60) }))
  )),
  http.get(u('/api/collections/roll-rate'), () => wd({
    current_distribution: [
      { dpd_bucket:'0',    account_count: 3837, outstanding_kobo: 4_340_000_000_00 },
      { dpd_bucket:'1-30', account_count: 241,  outstanding_kobo: 241_000_000_00 },
      { dpd_bucket:'31-60',account_count: 98,   outstanding_kobo: 98_000_000_00 },
      { dpd_bucket:'61-90',account_count: 42,   outstanding_kobo: 42_000_000_00 },
      { dpd_bucket:'90+',  account_count: 28,   outstanding_kobo: 99_000_000_00 },
    ],
  })),
  // collections-ops sub-paths
  http.get(u('/api/collections-ops/queue'), () => wd(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, account_cif: `CIF${String(i+100000).padStart(7,'0')}`,
      agent_name: pick([name(), null]), dpd_bucket: pick(['1-30','31-60','61-90','91-180','181-360','360+']),
      outstanding_kobo: rng(10,100)*1_000_000_00, current_stage: pick(['initial_call','follow_up','escalated',null]),
      notes: null, last_contact_at: pick([isoDate(rng(1,14)), null]),
      assignment_date: isoDate(rng(7,90)),
    }))
  )),
  http.get(u('/api/collections-ops/promises'), () => wd(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, account_cif: `CIF${String(i+100000).padStart(7,'0')}`,
      customer_name: name(), outstanding_kobo: rng(50,500)*100_000,
      promise_amount_kobo: rng(5,50)*100_000, promise_date: dateStr(rng(-5,14)),
      status: pick(['Pending','Kept','Broken']), agent_name: name(), created_at: isoDate(rng(1,10)),
    }))
  )),
  http.get(u('/api/collections-ops/repayment-plans'), () => wd(
    Array.from({ length: 15 }, (_, i) => {
      const instalment_count = 12
      const paid_count = rng(0, instalment_count)
      const instalment_kobo = rng(10,100)*100_000
      return {
        id: i+1, account_cif: `CIF${String(i+100000).padStart(7,'0')}`, customer_name: name(),
        total_kobo: instalment_kobo * instalment_count,
        paid_kobo:  instalment_kobo * paid_count,
        instalment_count, paid_count,
        status: pick(['Active','Completed','Defaulted']),
        next_payment_date: dateStr(rng(-5,30)),
        agent_name: name(),
      }
    })
  )),
  http.get(u('/api/collections-ops/repayment-plans/:id/instalments'), () => wd(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1, instalment_number: i+1, due_date: dateStr(-(i*30)), amount_kobo: 50_000_00,
      status: i < 3 ? 'Paid' : i === 3 ? 'Missed' : 'Scheduled',
    }))
  )),
  http.get(u('/api/collections-ops/writeoffs'), () => wd(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, account_cif: `CIF${String(i+100000).padStart(7,'0')}`, customer_name: name(),
      outstanding_kobo: rng(20,200)*1_000_000_00, dpd: rng(90,900),
      last_payment_date: pick([dateStr(rng(30,180)), null]),
      recovery_attempts: rng(2,15),
      recommended_by: name(),
    }))
  )),
  http.post(u('/api/collections-ops/repayment-plans'), () => ok({ id: rng(100, 999) })),
  http.post(u('/api/collections-ops/writeoffs/bulk-approve'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/collections-ops/promises'), () => ok({ id: 99 })),
  http.put(u('/api/collections-ops/promises/:id'),        () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/collections-ops/promises/:id/kept'),   () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/collections-ops/promises/:id/broken'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/collections/promises'), () => ok({ id: 99 })),
  http.post(u('/api/collections-ops/queue/bulk-assign'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/collections/promise-kpis'), () => wd({ total: 247, kept: 138, broken: 64, amount_promised_kobo: 8_420_000_000_00 })),
  http.get(u('/api/collections/repayment-kpis'), () => wd({ active: 86, on_track: 61, behind: 25, monthly_due_kobo: 1_240_000_000_00 })),
  http.get(u('/api/collections/writeoff-kpis'), () => wd({ total: 42, amount_kobo: 3_200_000_000_00, recovery_rate_pct: 18.4, pending: 8 })),
  // Portfolio page
  http.get(u('/api/collections/portfolio'), () => wd(
    Array.from({ length: 30 }, (_, i) => {
      const dpd_lower = pick([0, 1, 15, 32, 45, 61, 78, 91, 120, 150])
      const bucket = dpd_lower === 0 ? null : dpd_lower < 31 ? '1-30' : dpd_lower < 61 ? '31-60' : dpd_lower < 91 ? '61-90' : dpd_lower < 181 ? '91-180' : '181-360'
      const has_wl = i % 5 === 0
      return {
        loan_id: i + 1,
        applicant_cif: `CIF${String(i + 100000).padStart(7, '0')}`,
        loan_status: pick(['active', 'delinquent', 'in_recovery']),
        dpd_bucket: bucket,
        dpd_lower,
        outstanding_kobo: rng(5, 150) * 1_000_000_00,
        current_stage: pick(['initial_call', 'follow_up', 'escalated', null]),
        agent_name: pick([name(), null]),
        watchlist_id: has_wl ? rng(1, 50) : null,
        watchlist_scenario: has_wl ? pick(['unreachable', 'legal_threat', 'dispute', 'employer_terminated']) : null,
      }
    })
  )),
  http.get(u('/api/collections/watchlist'), () => wd(
    Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      account_cif: `CIF${String(i + 100000).padStart(7, '0')}`,
      scenario: pick(['unreachable', 'legal_threat', 'dispute', 'employer_terminated', 'property_risk']),
      notes: i % 2 === 0 ? 'Multiple contact attempts failed' : null,
      dpd_at_flag: rng(30, 90),
      outstanding_kobo: rng(10, 80) * 1_000_000_00,
      status: 'active',
      created_at: isoDate(rng(7, 60)),
      flagged_by_name: name(),
      resolved_at: null,
      resolution_notes: null,
    }))
  )),
  http.post(u('/api/collections/watchlist'), () => ok({ id: rng(100, 999) })),
  http.put(u('/api/collections/watchlist/:id/resolve'), () => new HttpResponse(null, { status: 204 })),
  // Write-off requests
  http.get(u('/api/collections-ops/writeoff-requests'), () => wd(
    Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      account_cif: `CIF${String(i + 100000).padStart(7, '0')}`,
      writeoff_type: pick(['full', 'partial_amount', 'percentage', 'principal_only']),
      reason: pick(['bad_debt', 'deceased', 'fraud', 'natural_disaster', 'regulatory', 'other']),
      reason_notes: i % 3 === 0 ? 'Customer confirmed deceased by family member' : null,
      amount_kobo: i % 4 === 1 ? rng(5, 50) * 1_000_000_00 : null,
      percentage: i % 4 === 2 ? rng(20, 80) : null,
      outstanding_kobo: rng(10, 200) * 1_000_000_00,
      status: pick(['pending', 'approved', 'rejected']),
      review_notes: i < 3 ? null : 'Reviewed and approved per policy',
      reviewed_at: i < 3 ? null : isoDate(rng(1, 7)),
      created_at: isoDate(rng(1, 30)),
      requested_by_name: name(),
      reviewed_by_name: i < 3 ? null : name(),
    }))
  )),
  http.post(u('/api/collections-ops/writeoff-requests'), () => ok({ id: rng(100, 999) })),
  http.put(u('/api/collections-ops/writeoff-requests/:id/approve'), () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/collections-ops/writeoff-requests/:id/reject'),  () => new HttpResponse(null, { status: 204 })),
]

// ── Recovery ──────────────────────────────────────────────────────────────────

const RECOVERY = [
  http.get(u('/api/recovery/kpis'), () => wd({
    total_in_recovery_kobo: 1_420_000_000_00, recovered_mtd_kobo: 48_200_000_00,
    success_rate_pct: 34.2, avg_days_in_recovery: 87,
  })),
  http.get(u('/api/recovery/monthly-trend'), () => wd(
    MONTHS_ISO.map(m => ({ month: m, amount_kobo: rng(30,80)*1_000_000_00 }))
  )),
  http.get(u('/api/recovery/by-channel'), () => wd([
    { channel:'Direct Call', amount_kobo: 18_400_000_00, pct: 38 },
    { channel:'Field Visit',  amount_kobo: 12_600_000_00, pct: 26 },
    { channel:'Legal Action', amount_kobo: 9_800_000_00,  pct: 20 },
    { channel:'TPA',          amount_kobo: 7_400_000_00,  pct: 15 },
  ])),
  http.get(u('/api/recovery/by-agent'), () => wd(
    Array.from({ length: 8 }, () => ({
      agent_name: name(), recovered_kobo: rng(5,40)*1_000_000_00,
      case_count: rng(5,30), success_rate_pct: rng(20,80),
    }))
  )),
  http.get(u('/api/recovery/tpa-agencies'), () => wd(
    Array.from({ length: 6 }, (_, i) => ({
      id: i+1,
      name: ['DebtBusters NG','Swift Recovery Ltd','Eagle Collections','Apex Debt Management','First Recovery Partners','Capital Collections'][i],
      licence_number: `CBN/TPA/${String(2024000 + i * 117).padStart(7,'0')}`,
      address: `${rng(1,80)} Broad Street, Lagos Island`,
      commission_pct: pick([8,10,12,15]),
      contact_name: name(),
      contact_phone: `080${rng(10000000,99999999)}`,
      accounts_assigned: rng(10,40),
      recovered_kobo: rng(5,30)*1_000_000_00,
      commission_accrued_kobo: rng(1,8)*1_000_000_00,
      active: i < 5,
    }))
  )),
  http.post(u('/api/recovery/tpa-agencies'), () => ok({ id: 99 })),
  http.put(u('/api/recovery/tpa-agencies/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/recovery/tpa-agencies/:id/accounts'), () => wd(
    Array.from({ length: 10 }, (_, i) => ({
      account_cif: `CIF${String(i+100000).padStart(7,'0')}`,
      outstanding_kobo: rng(5,80)*1_000_000_00,
      stage: pick(['initial_contact','field_visit','negotiation','promise_to_pay']),
      days_assigned: rng(7,90),
    }))
  )),
  http.get(u('/api/recovery/tpa-agencies/:id/performance'), () => wd({
    total_recovered_kobo: 18_400_000_00,
    success_rate_pct: 42.6,
    monthly: ['Jan','Feb','Mar','Apr','May','Jun'].map((m, i) => ({
      month: m, amount_kobo: rng(2,8)*1_000_000_00,
    })),
  })),
  http.get(u('/api/recovery/legal'), () => wd(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1,
      case_id: rng(100,999),
      account_cif: `CIF${String(i+100000).padStart(7,'0')}`,
      customer_name: name(),
      outstanding_kobo: rng(50,500)*1_000_000_00,
      current_milestone: pick(['Demand Letter','Pre-Litigation','Court Filing','Hearing','Judgment','Enforcement']),
      solicitor: name(),
      next_court_date: dateStr(rng(-30,60)),
      days_in_legal: rng(30,360),
    }))
  )),
  http.get(u('/api/recovery/cases/:id/legal-milestones'), () => wd(
    Array.from({ length: 4 }, (_, i) => ({
      id: i+1,
      milestone_type: ['Demand Letter','Pre-Litigation','Court Filing','Hearing'][i],
      milestone_date: dateStr(-(i * 30)),
      notes: i === 0 ? 'Demand letter sent via registered post' : i === 1 ? 'Pre-litigation meeting scheduled' : null,
      completed: i < 2,
    }))
  )),
  http.get(u('/api/recovery/legal-kpis'), () => wd({
    total_cases: 38, active: 24, won: 7, total_debt_recovered_kobo: 142_500_000_00,
  })),
  http.get(u('/api/recovery/debt-sales'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1,
      buyer_name: pick(['AXA Mansard Debt Fund','Cardinal Stone Partners','FBN Capital','Meristem Wealth']),
      sale_date: dateStr(rng(10, 180)),
      account_count: rng(15, 200),
      face_value_kobo: rng(100,500)*1_000_000_00,
      sale_price_kobo: rng(10,40)*1_000_000_00,
      recovery_post_sale_kobo: rng(0,15)*1_000_000_00,
      notes: i % 3 === 0 ? 'Negotiated below market rate due to portfolio age' : '',
      created_at: isoDate(rng(10, 180)),
    }))
  )),
  // recovery-ops cases
  http.get(u('/api/recovery-ops/cases'), () => wd(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, case_ref: `RC-2026-${String(i+100).padStart(4,'0')}`,
      account_cif: `CIF${String(i+100000).padStart(7,'0')}`,
      assigned_agent_id: rng(1,8), agent_name: name(),
      legal_stage: pick(['initial_call','field_visit','legal',null]),
      outstanding_kobo: rng(10,100)*1_000_000_00,
      recovered_kobo: rng(0,20)*1_000_000_00,
      write_off_amount_kobo: 0,
      status: pick(['active','closed','legal']),
      opened_at: isoDate(rng(30,180)),
      updated_at: isoDate(rng(0,14)),
    }))
  )),
  http.get(u('/api/recovery-ops/cases/:id'), () => wd({
    case: {
      id: 1, case_ref: 'RC-2026-0001', account_cif: 'CIF1000001',
      assigned_agent_id: 2, agent_name: 'Chidi Okeke',
      legal_stage: 'field_visit', outstanding_kobo: 25_000_000_00,
      recovered_kobo: 4_000_000_00, write_off_amount_kobo: 0,
      status: 'active', opened_at: isoDate(90), updated_at: isoDate(2),
    },
    payments: [
      { id: 1, amount_kobo: 2_000_000_00, payment_date: dateStr(30), channel: 'bank_transfer', reference: 'TRF/20260524/001' },
      { id: 2, amount_kobo: 2_000_000_00, payment_date: dateStr(10), channel: 'pos', reference: null },
    ],
    visits: [
      { id: 1, visit_date: dateStr(20), visit_type: 'field_visit', outcome: 'Promise to pay ₦2m by end of month', notes: 'Debtor was present — agreed to instalment plan', agent_name: 'Chidi Okeke' },
      { id: 2, visit_date: dateStr(5),  visit_type: 'phone_call',  outcome: 'Reached — confirmed payment plan', agent_name: 'Chidi Okeke' },
    ],
    proceedings: [
      { id: 1, proceeding_type: 'Demand Letter', court_name: null, filing_date: dateStr(60), status: 'sent' },
    ],
    write_off_approval: null,
  })),
  http.post(u('/api/recovery-ops/cases'), () => ok({ id: 99 })),
  http.put(u('/api/recovery-ops/cases/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/recovery-ops/cases/:id/notes'), () => ok({ id: 1 })),
  http.post(u('/api/recovery-ops/cases/bulk-assign'), () => new HttpResponse(null, { status: 204 })),
  // Pending payment approvals (RecoveryPaymentApprovals page)
  http.get(u('/api/recovery-ops/payments/pending'), () => wd(
    Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      case_id: rng(1, 20),
      account_cif: `CIF${String(i + 100000).padStart(7, '0')}`,
      amount_kobo: rng(5, 100) * 1_000_000_00,
      payment_date: dateStr(rng(0, 7)),
      channel: pick(['bank_transfer', 'pos', 'cash', 'mobile_money']),
      reference: i % 2 === 0 ? `TRF/2026${String(rng(10000, 99999))}` : null,
      status: 'pending',
      created_at: isoDate(rng(0, 5)),
      posted_by_name: name(),
    }))
  )),
  http.put(u('/api/recovery-ops/payments/:id/approve'), () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/recovery-ops/payments/:id/reject'),  () => new HttpResponse(null, { status: 204 })),
]

// ── Cards ─────────────────────────────────────────────────────────────────────
// Overview endpoints return direct types (no { data } wrapper)

const CARDS = [
  http.get(u('/api/cards/kpis'), () => ok({
    total_issued: 16246, active: 14820, inactive: 1426, activation_rate: 91.2, unique_merchants: 847,
  })),
  http.get(u('/api/cards/by-product'), () => ok(
    ['Green Card','Gold Card','Platinum Card','Prepaid NGN','Prepaid USD','Credit NGN'].map(p => ({
      product: p, count: rng(200,5000), outstanding_kobo: rng(10,120)*1_000_000_00, active: rng(180,4800),
    }))
  )),
  http.get(u('/api/cards/by-status'), () => ok([
    { status:'active', count: 14820 }, { status:'suspended', count: 842 }, { status:'blocked', count: 584 },
  ])),
  http.get(u('/api/cards/volume-by-type'), () => ok(
    MONTHS_ISO.map(m => ({ month: m, credit_kobo: rng(40,120)*1_000_000_00, prepaid_kobo: rng(20,60)*1_000_000_00 }))
  )),
  http.get(u('/api/cards/cycle-summary'), () => {
    const PRODUCTS = [
      { product_code:'CC-NGN-GRN', product_name:'Green Card', category:'credit', card_type:'Mastercard' },
      { product_code:'CC-NGN-GLD', product_name:'Gold Card', category:'credit', card_type:'Visa' },
      { product_code:'PP-NGN-STD', product_name:'Standard Prepaid', category:'prepaid', card_type:'Verve' },
    ]
    const CYCLE_DATES = ['2026-06-25','2026-05-25','2026-04-25']
    return ok(CYCLE_DATES.flatMap(d => PRODUCTS.map(p => ({
      cycle_date: d, ...p,
      account_count: rng(1200,3000),
      overdue_accounts: rng(50,200),
      total_outstanding_kobo: rng(800,2000)*1_000_000_00,
      total_overdue_kobo: rng(50,200)*1_000_000_00,
      total_interest_kobo: rng(20,80)*1_000_000_00,
      total_fees_kobo: rng(5,20)*1_000_000_00,
      total_penalty_kobo: rng(2,10)*1_000_000_00,
      total_credit_limit_kobo: rng(2000,5000)*1_000_000_00,
    }))))
  }),
  http.get(u('/api/cards/cycle-data'), () => ok({
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i+1,
      account_number: `ACC${String(i+100000).padStart(9,'0')}`,
      cif: `CIF${String(i+200000).padStart(7,'0')}`,
      currency: 'NGN',
      outstanding_balance_kobo: rng(50,500)*100_000,
      overdue_amount_kobo: pick([0, 0, rng(5,50)*100_000]),
      interest_charged_kobo: rng(1,10)*100_000,
      fees_kobo: rng(0,5)*100_000,
      credit_limit_kobo: rng(200,1000)*100_000,
    })),
    total: 1500,
  })),
  http.get(u('/api/cards/credit-limits'), () => ok(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, customer_name: name(), credit_limit_kobo: rng(50,500)*1_000_00,
      utilisation_pct: rng(10,95), product: 'Credit NGN', last_reviewed: dateStr(rng(0,90)),
    }))
  )),
  http.post(u('/api/cards/credit-limits'), () => ok({ id: 99 })),
  http.put(u('/api/cards/credit-limits/:id/decide'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/cards/disputes'), () => ok(
    Array.from({ length: 14 }, (_, i) => ({
      id: i+1, reference: `DSP-2026-${i+100}`, customer_name: name(),
      amount_kobo: rng(5,50)*100_000, reason: pick(['Unauthorised transaction','Double charge','Merchant error']),
      status: pick(['open','in_review','resolved','rejected']), channel: pick(['Web','POS','ATM']),
      created_at: isoDate(rng(0,14)), card_last4: String(rng(1000,9999)),
    }))
  )),
  http.post(u('/api/cards/disputes'), () => ok({ id: 99 })),
  http.put(u('/api/cards/disputes/:id/status'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/cards/issuance'), () => ok(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, customer_name: name(), product: pick(['Green Card','Gold Card','Prepaid NGN']),
      status: pick(['pending','approved','issued','rejected']),
      requested_at: isoDate(rng(0,30)), branch: pick(STATES),
    }))
  )),
  http.post(u('/api/cards/issuance'), () => ok({ id: 99 })),
  http.put(u('/api/cards/issuance/:id/status'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/cards/cycle-dates'), () => ok(
    Array.from({ length: 12 }, (_, i) => ({ id: i+1, cycle_date: `2026-${String(i+1).padStart(2,'0')}-25` }))
  )),
  http.get(u('/api/cards/cardholders'), () => ok({
    data: Array.from({ length: 20 }, (_, i) => ({
      cif_number: `CIF${String(i+100000).padStart(7,'0')}`, full_name: name(),
      product: pick(['Green Card','Gold Card','Prepaid NGN']),
      status: pick(['active','suspended','blocked']), last4: String(rng(1000,9999)),
    })),
    total: 5000,
  })),
  http.post(u('/api/cards/cardholders/:cif/block'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/cards/cardholders/:cif/unblock'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/cards/cardholders/:cif/block-log'), () => ok({ data: [] })),
]

// ── Finance / EOD ─────────────────────────────────────────────────────────────

const EOD_SUMMARY = {
  txn_count: 18420, days_covered: 30, active_accounts: 9840, active_cifs: 6210,
  total_dr: 2_840_000_000_00, total_cr: 3_120_000_000_00, total_volume: 5_960_000_000_00,
  avg_txn_value: 323_000_00,
}

const FD_SUMMARY = {
  net_position: 1_240_000_000_00, total_principal: 1_180_000_000_00,
  total_interest: 60_000_000_00, total_inflow_ngn: 840_000_000_00, total_liquidated: 120_000_000_00,
  inflow_count: 84, liquidation_count: 22, total_inflow_usd: 0, total_transactions: 106,
}

const FINANCE = [
  // EOD
  http.get(u('/api/eod/summary'), () => ok(EOD_SUMMARY)),
  http.get(u('/api/eod/uploads'), () => ok(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, upload_date: dateStr(i), filename: `eod_${dateStr(i)}.csv`,
      loaded_at: isoDate(i), loaded_by_name: name(), row_count: rng(800,2400),
      status: pick(['loaded','pending','error']),
    }))
  )),
  http.post(u('/api/eod/upload'), () => ok({ id: 99, status: 'pending', row_count: 1842 })),
  http.get(u('/api/eod/by-product'), () => ok(
    ['GRN','GLD','PLT','PRP','CRD'].map((code, i) => ({
      product_code: code,
      product_name: ['Green Card','Gold Card','Platinum Card','Prepaid NGN','Credit NGN'][i],
      volume: rng(20,200)*1_000_000_00, count: rng(200,2000), dr: rng(10,100)*1_000_000_00, cr: rng(10,100)*1_000_000_00,
    }))
  )),
  http.get(u('/api/eod/by-branch'), () => ok(
    STATES.slice(0,6).map((s, i) => ({
      branch_code: `BR${String(i+1).padStart(3,'0')}`, branch_name: `${s} Branch`,
      volume: rng(50,300)*1_000_000_00, count: rng(500,3000), active_accounts: rng(200,1000),
    }))
  )),
  http.get(u('/api/eod/trend'), () => ok(
    MONTHS_ISO.map(m => ({ month: m, volume: rng(200,600)*1_000_000_00, count: rng(800,2400) }))
  )),
  http.get(u('/api/eod/transactions'), () => ok({
    data: Array.from({ length: 30 }, (_, i) => ({
      id: i+1, txn_date: dateStr(rng(0,7)), account_no: String(rng(1000000000,9999999999)),
      customer: name(), amount: rng(5,200)*100_000,
      sign: pick(['DR','CR']),
      description: pick(['Salary Credit','Loan Repayment','Card Payment','Transfer','FD Placement']),
      txn_category: pick(['Transfer','Credit','Loan Repayment','Card Payment','FD']),
      product_code: pick(['GRN','GLD','PLT','PRP','CRD']),
      balance: rng(10,2000)*100_000,
      branch_name: pick(['Lagos Island','Victoria Island','Abuja Main','Port Harcourt','Kano']),
    })),
    total: 18420,
  })),

  // Fixed Deposit
  http.get(u('/api/fixed-deposit/summary'), () => ok(FD_SUMMARY)),
  http.get(u('/api/fixed-deposit/trend'), () => ok(
    MONTHS_ISO.map(m => ({ month: m, inflow: rng(80,200)*1_000_000_00, liquidation: rng(20,80)*1_000_000_00 }))
  )),
  http.get(u('/api/fixed-deposit/transactions'), () => wd(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, reference: `FD-2026-${String(i+100).padStart(4,'0')}`, customer_name: name(),
      principal: rng(50,500)*1_000_000_00,
      ngn_amount: rng(50,500)*1_000_000_00, usd_amount: 0,
      currency: pick(['NGN','NGN','NGN','USD']),
      interest_paid: rng(2,50)*1_000_000_00,
      gross_amount: rng(52,550)*1_000_000_00,
      tenor_days: pick([30,60,90,180,365]),
      rate: pick([8.5,9.0,10.0,11.5,12.0]),
      status: pick(['active','matured','liquidated','pending']),
      transaction_date: dateStr(rng(0,180)), maturity_date: dateStr(rng(-30,185)),
      bank: pick(BANKS),
      location: pick(['Lagos Island','Victoria Island','Abuja','Port Harcourt']),
      account_officer: name(), notes: '',
      transaction_type: pick(['inflow','outflow']),
    }))
  )),
  http.post(u('/api/fixed-deposit/transactions/:id/liquidate'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/fixed-deposit/transactions/:id/rollover'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/fixed-deposit/transactions'), () => ok({ id: 99 })),
  http.get(u('/api/fixed-deposit/maturity'), () => wd([])),
  http.get(u('/api/finance/transaction-kpis'), () => wd({ total_count: 18420, total_credits_kobo: 3_120_000_000_00, total_debits_kobo: 2_840_000_000_00, net_position_kobo: 280_000_000_00 })),
  http.get(u('/api/finance/fd-kpis'), () => wd({ total_fds: 84, total_principal_kobo: 1_180_000_000_00, avg_rate_pct: 10.2, maturing_this_month: 11 })),

  // Finance GL / postings / income / treasury
  http.get(u('/api/finance/gl-accounts'), () => ok(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, code: String(1000+i),
      name: pick(['Loan Portfolio','Interest Receivable','Card Suspense','Deposit Liabilities','Fee Income','Salaries Payable']),
      type: pick(['asset','liability','income','expense']), balance_kobo: rng(100,5000)*1_000_000_00,
    }))
  )),
  http.post(u('/api/finance/gl-accounts'), () => ok({ id: 99 })),
  http.put(u('/api/finance/gl-accounts/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/finance/manual-postings'), () => ok({
    data: Array.from({ length: 8 }, (_, i) => ({
      id: i+1, reference: `MP-2026-${i+100}`, debit_account: `GL-${1000+i}`,
      credit_account: `GL-${2000+i}`, amount_kobo: rng(5,50)*1_000_000_00,
      narration: 'Manual adjustment', posted_by: name(), posted_at: isoDate(rng(0,14)),
      status: pick(['posted','pending_approval']),
    })),
    total: 8,
  })),
  http.post(u('/api/finance/manual-postings'), () => ok({ id: 99 })),
  http.patch(u('/api/finance/manual-postings/:id/approve'), () => new HttpResponse(null, { status: 204 })),
  http.patch(u('/api/finance/manual-postings/:id/reject'),  () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/finance/treasury'), () => ok({
    cash_position: 2_840_000_000_00, fd_liabilities: 1_240_000_000_00, net_liquidity: 1_600_000_000_00,
  })),
  http.get(u('/api/finance/costs'), () => ok(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1, category: pick(['Salaries','Technology','Marketing','Operations','Facilities']),
      amount_kobo: rng(5,80)*1_000_000_00, budget_kobo: rng(60,100)*1_000_000_00,
      month: MONTHS_ISO[i % 7] ?? MONTHS_ISO[0], status: pick(['approved','pending']),
    }))
  )),
  http.post(u('/api/finance/costs'), () => ok({ id: 99 })),
  http.get(u('/api/finance/budget'), () => ok(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, category: pick(['Salaries','Technology','Marketing','Operations']),
      budgeted_kobo: rng(80,200)*1_000_000_00, actual_kobo: rng(60,190)*1_000_000_00,
      variance_kobo: rng(-20,20)*1_000_000_00, period: '2026',
    }))
  )),
  http.get(u('/api/finance/income/summary'), () => ok({
    loan_disbursed_kobo: 1_840_000_000_00, active_loans: 3214,
    fee_type_income_kobo: 28_000_000_00,
    card_interest_ngn: 8_200_000_00, card_fees_ngn: 3_400_000_00,
    card_penalty_ngn: 800_000_00, card_outstanding_ngn: 142_000_000_00,
    card_billed_ngn: 28_000_000_00, card_credit_limit_ngn: 320_000_000_00,
    card_purchases_ngn: 62_000_000_00, card_cash_advance_ngn: 14_000_000_00,
    card_accounts_ngn: 1840,
    card_interest_usd: 0, card_fees_usd: 0, card_penalty_usd: 0,
    card_outstanding_usd: 0, card_billed_usd: 0, card_credit_limit_usd: 0,
    card_purchases_usd: 0, card_cash_advance_usd: 0, card_accounts_usd: 0,
  })),
  http.get(u('/api/finance/income/chart'), () => ok([
    { type:'Interest',    current: 142_000_000_00, previous: 118_000_000_00 },
    { type:'Origination', current: 18_000_000_00,  previous: 14_000_000_00  },
    { type:'Late Fees',   current: 6_400_000_00,   previous: 5_200_000_00   },
    { type:'Card',        current: 12_400_000_00,  previous: 9_800_000_00   },
    { type:'Management',  current: 3_600_000_00,   previous: 3_100_000_00   },
  ])),
  http.get(u('/api/finance/income/loans'), () => ok(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1,
      loan_ref: `LA-2026-${String(i+100).padStart(4,'0')}`,
      applicant_name: name(),
      product: pick(['Payday Loan','Personal Loan','SME Loan','Salary Advance']),
      disbursed_amount_kobo: rng(5,80)*1_000_000_00,
      rate_pct: pick([24, 28, 30, 36]),
      disbursed_at: dateStr(rng(0,180)),
      maturity_date: dateStr(rng(-30,365)),
      status: pick(['active','closed','overdue']),
      days_active: rng(1,360),
      interest_earned_kobo: rng(1,20)*1_000_000_00,
      maturity_status: pick(['current','matured','overdue']),
    }))
  )),
  http.get(u('/api/finance/income/fee-types'), () => ok({
    summary: [
      { fee_type: 'Origination Fee', amount_kobo: 18_000_000_00, count: 284 },
      { fee_type: 'Late Payment Fee', amount_kobo: 6_400_000_00, count: 142 },
      { fee_type: 'Management Fee', amount_kobo: 3_600_000_00, count: 198 },
    ],
    detail: [
      { fee_type: 'Origination Fee', loan_ref: 'LA-2026-0100', amount_kobo: 62_500_00, date: dateStr(3) },
      { fee_type: 'Late Payment Fee', loan_ref: 'LA-2026-0101', amount_kobo: 45_000_00, date: dateStr(1) },
      { fee_type: 'Management Fee', loan_ref: 'LA-2026-0102', amount_kobo: 18_000_00, date: dateStr(0) },
    ],
  })),
  http.get(u('/api/finance/pnl'), () => ok({
    lines: [
      { product:'Loans',    total_revenue: 142_000_000_00, total_cost: 68_000_000_00, net_income: 74_000_000_00 },
      { product:'Cards',    total_revenue: 12_400_000_00,  total_cost: 4_200_000_00,  net_income: 8_200_000_00  },
      { product:'Deposits', total_revenue: 18_000_000_00,  total_cost: 12_000_000_00, net_income: 6_000_000_00  },
      { product:'Other',    total_revenue: 11_600_000_00,  total_cost: 3_800_000_00,  net_income: 7_800_000_00  },
    ],
    total_revenue: 184_000_000_00, total_cost: 88_000_000_00, net_income: 96_000_000_00,
    data_available: true,
  })),
]

// ── Risk ──────────────────────────────────────────────────────────────────────

const RISK = [
  http.get(u('/api/risk/portfolio-kpis'), () => wd({
    par30_rate_pct: 5.0, par60_pct: 2.0, par90_pct: 0.9, npl_ratio_pct: 1.4,
    coverage_ratio_pct: 142.0, total_outstanding_kobo: 4_820_000_000_00, provision_kobo: 67_500_000_00,
    avg_credit_score: 672, top_employer_exposure_kobo: 480_000_000_00,
  })),
  http.get(u('/api/risk/par-trend'), () => wd(
    MONTHS_ISO.map(m => ({ month: m, par30_kobo: rng(4,8)*1_000_000_00, par60_kobo: rng(1,4)*1_000_000_00, par90_kobo: rng(0,2)*1_000_000_00 }))
  )),
  http.get(u('/api/risk/band-distribution'), () => wd([
    { band:'Prime',       count: 2184, pct: 52.1 },
    { band:'Near-Prime',  count: 1241, pct: 29.6 },
    { band:'Sub-Prime',   count: 583,  pct: 13.9 },
    { band:'High-Risk',   count: 188,  pct: 4.4  },
  ])),
  http.get(u('/api/risk/sector-concentration'), () => wd([
    { sector:'Salary Earners', outstanding_kobo: 2_840_000_000_00, count: 2814, book_pct: 58.9 },
    { sector:'SME',            outstanding_kobo: 980_000_000_00,   count: 612,  book_pct: 20.3 },
    { sector:'Civil Servants', outstanding_kobo: 640_000_000_00,   count: 492,  book_pct: 13.3 },
    { sector:'Pensioners',     outstanding_kobo: 360_000_000_00,   count: 300,  book_pct: 7.5  },
  ])),
  http.get(u('/api/risk/top-employers'), () => wd(
    Array.from({ length: 10 }, (_, i) => ({
      company: pick(['Shell Nigeria','MTN Nigeria','Dangote Group','Access Bank','NNPC','NLNG']),
      book_kobo: rng(50,500)*1_000_000_00,
      staff_loans_count: rng(20,200),
      pct_of_total: rng(2,12),
      par30_count: rng(0,15),
    }))
  )),
  http.get(u('/api/risk/eye-kpis'), () => wd({
    scored_today: 42, avg_score_month: 682, high_risk_count: 124, requests_month: 847,
  })),
  http.get(u('/api/risk/review-kpis'), () => wd({
    reviewed: 184, approved: 127, declined: 42, pending: 15,
  })),
  http.get(u('/api/risk/eye-scores'), () => ok({
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i+1, application_id: 1000+i, applicant_name: name(),
      product_type: pick(LOS_PRODUCTS),
      score: rng(400,850), band: pick(['Prime','Near-Prime','Sub-Prime','High-Risk']),
      top_factor: pick(['DTI too high','Low bureau score','Short employment tenure',null]),
      dti_pct: rng(15,55), scored_at: isoDate(rng(0,30)),
    })),
    total: 100,
  })),
  http.get(u('/api/risk/vintage-kpis'), () => wd({
    avg_par30_6m: 4.8, avg_par30_12m: 6.2,
  })),
  http.get(u('/api/risk/vintage'), () => wd(
    ['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06',
     '2025-07','2025-08','2025-09','2025-10','2025-11','2026-01'].map(m => ({
      booking_month: m, cohort_count: rng(80,300),
      par30_1m: rng(1,5), par30_3m: rng(2,8), par30_6m: rng(3,12),
      par30_12m: m < '2025-07' ? rng(4,15) : null,
    }))
  )),
  http.get(u('/api/risk/credit-file/:cif'), () => ok({
    cif: 'CIF1000001', customer_name: name(), phone: `0801${rng(1000000,9999999)}`,
    eye_score: 682, eye_band: 'Near-Prime', bureau_score: 651,
    total_loan_count: 3, active_loan_count: 1,
    total_outstanding_kobo: 85_000_000_00, worst_dpd: 14,
    dti_pct: 28.4, kyc_status: 'verified', bvn: `2234${rng(10000000,99999999)}`,
    loans: Array.from({ length: 3 }, (_, i) => ({
      id: i+1, ref: `LN${rng(10000,99999)}`,
      product: pick(LOS_PRODUCTS), principal_kobo: rng(10,150)*1_000_000_00,
      outstanding_kobo: i === 0 ? 85_000_000_00 : 0,
      dpd: i === 0 ? 14 : 0, status: i === 0 ? 'active' : 'closed',
      disbursed_at: isoDate(rng(30, 730)),
    })),
  })),
  http.get(u('/api/risk/applications'), () => ok({
    data: Array.from({ length: 15 }, (_, i) => ({
      id: i+1, reference: `APP${rng(10000,99999)}`,
      applicant_name: name(), employer_name: pick(['Shell Nigeria','MTN','NNPC','Access Bank',null]),
      eye_score: rng(400,850), risk_band: pick(['Prime','Near-Prime','Sub-Prime','High-Risk']),
      monthly_income_kobo: rng(15,80)*1_000_000_00, dti_pct: rng(15,55),
      amount_requested_kobo: rng(10,200)*1_000_000_00,
      product_type: pick(LOS_PRODUCTS), submitted_at: isoDate(rng(0,14)),
    })),
    total: 15,
  })),
  http.get(u('/api/risk/applications/export'), () => new HttpResponse(new Blob(['ref,applicant\n'], { type: 'text/csv' }))),
]

// ── Compliance ────────────────────────────────────────────────────────────────
// All return direct arrays

const COMPLIANCE = [
  http.get(u('/api/compliance/checklists'), () => ok(
    Array.from({ length: 15 }, (_, i) => ({
      id: i+1, title: pick(['Monthly AML Review','KYC Refresh','Transaction Monitoring','STR Filing','CBN Returns']),
      category: pick(['AML/CFT','KYC','Regulatory','Reporting']),
      due_date: dateStr(rng(-5,30)), status: pick(['pending','completed','overdue']),
      assigned_to: name(), completion_pct: rng(0,100),
    }))
  )),
  http.get(u('/api/compliance/checklists/:id'), ({ params }) => ok({
    id: params.id, title: 'Monthly AML Review', category: 'AML/CFT',
    due_date: dateStr(14), status: 'pending', assigned_to: name(), completion_pct: 40, items: [],
  })),
  http.post(u('/api/compliance/checklists'), () => ok({ id: 99 })),
  http.put(u('/api/compliance/checklists/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/compliance/findings'), () => ok(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1, finding_ref: `AUD-2026-${String(i+100).padStart(4,'0')}`,
      title: pick(['Incomplete KYC documentation','Late STR filing','Inadequate transaction monitoring']),
      severity: pick(['critical','high','medium','low']), status: pick(['open','in_progress','closed']),
      raised_by: name(), raised_date: dateStr(rng(0,90)), due_date: dateStr(rng(0,60)),
      owner: name(), department: pick(DEPTS),
    }))
  )),
  http.get(u('/api/compliance/findings/:id'), ({ params }) => ok({
    id: params.id, finding_ref: `AUD-2026-${params.id}`, title: 'Incomplete KYC documentation',
    severity: 'high', status: 'open', raised_by: name(), raised_date: dateStr(10),
    due_date: dateStr(20), owner: name(), department: 'Compliance', notes: [],
  })),
  http.post(u('/api/compliance/findings'), () => ok({ id: 99, finding_ref: 'AUD-2026-0199' })),
  http.put(u('/api/compliance/findings/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/compliance/cbn-reports'), () => ok(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, report_name: pick(['BSS Return','Sectoral Analysis','AMCON Levy','Credit Bureau Submission']),
      regulatory_body: pick(['CBN','NDIC','FIRS','CAC']),
      due_date: dateStr(rng(-5,60)), status: pick(['pending','submitted','overdue']),
      owner_name: name(), notes: '',
    }))
  )),
  http.post(u('/api/compliance/cbn-reports'), () => ok({ id: 99 })),
  http.put(u('/api/compliance/cbn-reports/:id'), () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/compliance/cbn-reports/:id/submit'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/compliance/watch-list'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, full_name: name(), bvn: `22${rng(100000000,999999999)}`,
      reason: pick(['PEP','Sanction','Adverse Media','Court Order']),
      added_by: name(), added_at: isoDate(rng(1,180)), status: 'active',
    }))
  )),
  http.post(u('/api/compliance/watch-list'), () => ok({ id: 99 })),
  http.put(u('/api/compliance/watch-list/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/compliance/aml-rules'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, name: pick(['Cash Transaction Report','STR Threshold','PEP Screening','Sanctions Check']),
      threshold_kobo: pick([5_000_000_00, 1_000_000_00, null]), is_active: Math.random() > 0.2,
      updated_at: isoDate(rng(0,90)),
    }))
  )),
  http.post(u('/api/compliance/aml-rules'), () => ok({ id: 99 })),
  http.put(u('/api/compliance/aml-rules/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/compliance/kyc-expiry'), () => ok(
    Array.from({ length: 15 }, (_, i) => ({
      id: i+1, cif: `CIF${String(i+100000).padStart(7,'0')}`, customer_name: name(),
      kyc_tier: pick(['tier1','tier2','tier3']), expiry_date: dateStr(rng(-10,90)),
      days_to_expiry: rng(-10,90), status: pick(['expiring','expired','current']),
    }))
  )),
  http.get(u('/api/compliance/audit-log'), () => ok({
    logs: Array.from({ length: 20 }, (_, i) => ({
      id: i+1, user_name: name(), action: pick(['Create','Update','Delete','View']),
      module: pick(['LOS','Collections','Finance','HR']), detail: 'Record modified',
      ip: `102.${rng(0,255)}.${rng(0,255)}.${rng(0,255)}`, created_at: isoDate(rng(0,14)),
    })),
    total: 200,
  })),
]

// ── Helpdesk ──────────────────────────────────────────────────────────────────

const TICKET_SUBJECTS = [
  'Card not working at POS','Interest charged incorrectly','Unable to login to app',
  'Loan disbursement delayed','Card declined at ATM','Statement request',
  'Account freeze enquiry','Complaint about recovery agent',
]

const TICKETS = Array.from({ length: 48 }, (_, i) => {
  const slaHours = pick([1, 2, 4, 8, 24])
  const slaBreached = Math.random() < 0.12
  const slaDue = new Date(Date.now() + (slaBreached ? -1 : 1) * slaHours * 3_600_000).toISOString()
  const cif = Math.random() > 0.3 ? `CIF${String(i+100000).padStart(7,'0')}` : undefined
  const n = name()
  return {
    id: i+1,
    ticket_ref: `TKT-2026-${String(i+1000).padStart(5,'0')}`,
    subject: pick(TICKET_SUBJECTS),
    status: pick(['open','in_progress','pending_customer','resolved','closed']),
    priority: pick(['low','medium','high','urgent']),
    channel: pick(['email','phone','walk_in','web']),
    ticket_type: pick(['complaint','enquiry','request','feedback']),
    customer_name: n,
    customer_email: `${n.toLowerCase().replace(' ','.')}@example.ng`,
    customer_phone: `080${rng(10000000,99999999)}`,
    customer_cif: cif,
    assigned_to: i % 8 + 1,
    assigned_to_name: name(),
    sla_breached: slaBreached,
    sla_due_at: slaDue,
    created_at: isoDate(rng(0,14)),
    updated_at: isoDate(rng(0,3)),
  }
})

const HELPDESK_AGENTS = Array.from({ length: 8 }, (_, i) => ({
  id: i+1,
  full_name: name(),
  open_tickets: rng(2,12),
  resolved_today: rng(3,10),
  sla_breached: rng(0,3),
  avg_handle_mins: rng(8,25),
  last_reply: isoDate(rng(0,1)),
  current_ticket_ref: Math.random() > 0.4 ? `TKT-${rng(1000,9999)}` : undefined,
  helpdesk_status: pick(['available','on_call','busy','offline']),
}))

const HELPDESK = [
  http.get(u('/api/helpdesk/tickets'), () => ok({ tickets: TICKETS, total: TICKETS.length })),
  // Ticket detail — MUST be `{ ticket, messages, events }` (both Tickets.tsx TicketPanel and TicketDetail.tsx destructure this shape)
  http.get(u('/api/helpdesk/tickets/:id'), ({ params }) => {
    const t = TICKETS[(Number(params.id) - 1) % TICKETS.length] ?? TICKETS[0]
    return ok({
      ticket: t,
      messages: [
        { id:1, direction:'outbound', channel: t.channel, author_name:'Support Agent', author_user_name:'support@o3capital.com',
          body_text:'Thank you for contacting O3 Capital. How can we assist you today?', is_internal_note:false, created_at:isoDate(2) },
        { id:2, direction:'inbound',  channel: t.channel, author_name: t.customer_name,
          body_text:'I have been trying to use my card at the ATM and it keeps declining. Please help.', is_internal_note:false, created_at:isoDate(1) },
        { id:3, direction:'outbound', channel: t.channel, author_name:'Support Agent', author_user_name:'support@o3capital.com',
          body_text:'We have escalated this to our cards team. You should receive a resolution within 2 hours.', is_internal_note:false, created_at:isoDate(0) },
        { id:4, direction:'outbound', channel:'internal',  author_name:'Support Agent', author_user_name:'support@o3capital.com',
          body_text:'Checked CBS — card status is Active. Likely a POS terminal issue. Monitoring.', is_internal_note:true, created_at:isoDate(0) },
      ],
      events: [],
    })
  }),
  // Enriched context — shape matches EnrichedContext interface in TicketDetail.tsx
  http.get(u('/api/helpdesk/tickets/:id/context'), ({ params }) => {
    const t = TICKETS[(Number(params.id) - 1) % TICKETS.length] ?? TICKETS[0]
    if (!t.customer_cif) return ok({})
    return ok({
      cif: t.customer_cif,
      customer_name: t.customer_name,
      customer_email: t.customer_email,
      customer_phone: t.customer_phone,
      other_open_tickets: rng(0,3),
      loans: Array.from({ length: rng(0,2) }, () => ({
        loan_ref: `LN${rng(100000,999999)}`,
        product_type: pick(LOS_PRODUCTS),
        status: pick(['active','delinquent']),
        amount_approved_kobo: rng(20,150)*1_000_000_00,
        total_outstanding_kobo: rng(5,100)*1_000_000_00,
        dpd: pick([0,0,15,45]),
        next_repayment_date: dateStr(-rng(1,14)),
      })),
      fixed_deposits: Array.from({ length: rng(0,1) }, () => ({
        principal_kobo: rng(50,500)*1_000_000_00,
        interest_rate: rng(8,14),
        tenor_days: pick([90,180,365]),
        maturity_date: dateStr(-rng(30,180)),
        status: 'active',
      })),
      recent_transactions: Array.from({ length: 5 }, (_, i) => ({
        transaction_date: isoDate(i),
        description: pick(['POS Purchase','ATM Withdrawal','Transfer In','Loan Repayment']),
        amount_kobo: rng(1,50)*1_000_000_00,
        transaction_type: pick(['debit','credit']),
      })),
      collections_history: Array.from({ length: rng(0,2) }, () => ({
        promise_date: dateStr(rng(1,7)),
        promise_amount_kobo: rng(10,80)*1_000_000_00,
        ptp_status: pick(['pending','kept','broken']),
        created_at: isoDate(rng(1,14)),
      })),
      cards: Array.from({ length: rng(0,1) }, () => ({
        product_name: pick(['Visa Prepaid','Mastercard Credit','Verve Debit']),
        account_status: pick(['active','blocked']),
        name_on_card: t.customer_name,
        account_manager: name(),
      })),
    })
  }),
  http.post(u('/api/helpdesk/tickets'), () => ok({ id: 99, ticket_ref: 'TKT-2026-01099' })),
  http.patch(u('/api/helpdesk/tickets/:id'), () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/helpdesk/tickets/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/helpdesk/tickets/:id/messages'), () => ok({ id: rng(10,999), body_text: 'Message sent', direction: 'outbound', created_at: isoDate(0) })),
  http.post(u('/api/helpdesk/tickets/:id/reply'),    () => ok({ id: 99, body_text: 'Reply sent' })),
  http.post(u('/api/helpdesk/tickets/:id/merge'),    () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/helpdesk/tickets/:id/escalate'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/helpdesk/tickets/:id/ptp'),      () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/helpdesk/tickets/:id/statement-email'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/helpdesk/tickets/bulk-assign'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/helpdesk/tickets/bulk-close'),  () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/tickets/search'), ({ request }) => {
    const q = new URL(request.url).searchParams.get('q')?.toLowerCase() ?? ''
    return ok(TICKETS.filter(t => t.subject.toLowerCase().includes(q) || t.ticket_ref.includes(q)).slice(0,6)
      .map(t => ({ id: t.id, ticket_ref: t.ticket_ref, subject: t.subject, status: t.status })))
  }),
  http.get(u('/api/helpdesk/stats'), () => ok({
    open: 48, sla_breached: 7, avg_first_response_hours: 0.28, avg_csat: 4.3,
    agents: HELPDESK_AGENTS.map(a => ({
      agent_name: a.full_name, open_tickets: a.open_tickets, resolved_today: a.resolved_today,
      avg_csat: rng(38,50)/10, avg_handle_time_min: a.avg_handle_mins, escalations: rng(0,2),
    })),
  })),
  // Agents list — shape matches both AgentRow (Supervisor) and AgentItem (TicketDetail/Tickets assign dropdowns)
  http.get(u('/api/helpdesk/agents'), () => ok(HELPDESK_AGENTS)),
  http.put(u('/api/helpdesk/agents/:id/status'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/supervisor'), () => ok({
    totals: { open: 48, sla_breached: 7, unassigned: 12, active_agents: 6 },
    agents: HELPDESK_AGENTS,
    queues: [
      { queue: 'General',    open: 18, sla_breached: 3, unassigned: 5 },
      { queue: 'Cards',      open: 12, sla_breached: 2, unassigned: 4 },
      { queue: 'Loans',      open: 10, sla_breached: 1, unassigned: 2 },
      { queue: 'Compliance', open:  8, sla_breached: 1, unassigned: 1 },
    ],
    recent_breaches: Array.from({ length: 5 }, (_, i) => ({
      id: i+1, ticket_ref: `TKT-${rng(1000,9999)}`,
      subject: pick(['Card blocked without reason','Loan repayment not reflected','Account locked']),
      priority: pick(['high','urgent','medium']),
      sla_due_at: new Date(Date.now() - rng(10,120) * 60_000).toISOString(),
      assigned_to_name: name(),
    })),
    by_type: [
      { ticket_type: 'complaint', count: 24 }, { ticket_type: 'enquiry', count: 16 },
      { ticket_type: 'request',   count:  6 }, { ticket_type: 'feedback', count: 2 },
    ],
    hourly_queue: Array.from({ length: 10 }, (_, h) => ({ hour: String(h+8), count: rng(2,15) })),
  })),
  http.get(u('/api/helpdesk/kb'), () => ok(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1,
      title: pick(['How to unblock your card','Understanding your statement','Loan repayment process','Card limit increase request','How to dispute a transaction']),
      category: pick(['Cards','Loans','Account','Compliance','General']),
      status: pick(['Live','Live','Draft','Pending Approval']),
      helpful_pct: rng(60,98),
      helpful_count: rng(10,80),
      not_helpful_count: rng(1,10),
      body: 'To complete this process, please follow the steps below. First, ensure your account is active. Then, navigate to the relevant section in the app or visit any O3 Capital branch. A representative will assist you within 24 hours.',
      last_updated: dateStr(rng(0,30)),
      created_by: name(),
    }))
  )),
  http.get(u('/api/helpdesk/kb/search'), () => ok([])),
  http.post(u('/api/helpdesk/kb'), () => ok({ id: 99 })),
  http.put(u('/api/helpdesk/kb/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/canned-responses'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, title: pick(['Greeting','Escalation Notice','Resolution Confirmation']),
      body: 'Dear {{customer_name}}, Thank you for contacting O3 Capital.',
      category: pick(['General','Cards','Loans']),
    }))
  )),
  http.post(u('/api/helpdesk/canned-responses'), () => ok({ id: 99 })),
  http.put(u('/api/helpdesk/canned-responses/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/helpdesk/canned-responses/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/sla-policies'), () => ok([
    { id: 1, priority: 'low',      first_response_hours: 24, resolution_hours: 72 },
    { id: 2, priority: 'medium',   first_response_hours: 8,  resolution_hours: 24 },
    { id: 3, priority: 'high',     first_response_hours: 2,  resolution_hours: 8  },
    { id: 4, priority: 'critical', first_response_hours: 1,  resolution_hours: 4  },
  ])),
  http.put(u('/api/helpdesk/sla-policies/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/call-scripts'), () => ok([
    { id: 1, ticket_type: 'card_dispute', name: 'Card Dispute Script', is_active: true, steps: [
      { order: 1, prompt: 'Verify customer identity (name, account number, last 4 digits of card)', options: [] },
      { order: 2, prompt: 'Confirm the disputed transaction amount and date' },
      { order: 3, prompt: 'Advise customer of investigation timeline (3–5 business days)' },
    ]},
    { id: 2, ticket_type: 'loan_inquiry', name: 'Loan Inquiry Script', is_active: true, steps: [
      { order: 1, prompt: 'Verify customer identity and confirm account number' },
      { order: 2, prompt: 'Ask about loan type: personal, business, or top-up?' },
      { order: 3, prompt: 'Collect required documents checklist and send via email' },
    ]},
  ])),
  http.get(u('/api/helpdesk/call-scripts/by-type'), () => ok({
    id: 1, ticket_type: 'card_dispute', name: 'Card Dispute Script', is_active: true,
    steps: [
      { order: 1, prompt: 'Verify customer identity (name, account number, last 4 digits of card)', options: [] },
      { order: 2, prompt: 'Confirm the disputed transaction amount and date' },
      { order: 3, prompt: 'Advise customer of investigation timeline (3–5 business days)' },
    ],
  })),
  http.post(u('/api/helpdesk/call-scripts'), () => ok({ id: 99 })),
  http.put(u('/api/helpdesk/call-scripts/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/helpdesk/call-scripts/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/routing-rules'), () => ok([])),
  http.delete(u('/api/helpdesk/routing-rules/:id'), () => new HttpResponse(null, { status: 204 })),
  // Calls log — matches CallLog interface: agent_name, customer_name, phone, direction, duration_seconds, outcome, ticket_id, ticket_ref, called_at
  http.get(u('/api/helpdesk/calls'), () => ok(
    Array.from({ length: 80 }, (_, i) => {
      const hasTicket = Math.random() > 0.45
      const tid = hasTicket ? rng(1, 48) : null
      return {
        id: i+1,
        agent_name: pick(['Amaka Osei','Tunde Bello','Chisom Eze','Fatima Musa','Emeka Okafor','Sola Adeyemi']),
        customer_name: Math.random() > 0.15 ? name() : null,
        phone: `080${rng(10000000,99999999)}`,
        call_to: Math.random() > 0.6 ? `070${rng(10000000,99999999)}` : null,
        direction: pick(['Inbound','Inbound','Inbound','Outbound']),
        duration_seconds: Math.random() > 0.15 ? rng(20, 720) : 0,
        outcome: pick(['completed','completed','completed','completed','missed','missed','transferred','escalated']),
        ticket_id: tid,
        ticket_ref: tid ? `TKT-2026-${String(tid+1000).padStart(4,'0')}` : null,
        called_at: new Date(Date.now() - rng(0, 14) * 86400000 - rng(0, 86400) * 1000).toISOString(),
        notes: Math.random() > 0.6 ? pick(['Customer confirmed payment', 'Sent to collections team', 'Will call back tomorrow', 'Requested account statement']) : null,
      }
    })
  )),
  http.post(u('/api/helpdesk/calls'), () => ok({ id: 99 })),
  // Stats sub-endpoints — field names match interfaces in Stats.tsx
  // CsatPoint: { date, csat_score, ticket_count }
  http.get(u('/api/helpdesk/csat-trend'), () => wd(MONTHS_ISO.map(m => ({
    date: m, csat_score: rng(38,50)/10, ticket_count: rng(30,120),
  })))),
  // HandlePoint: { ticket_type, avg_minutes }
  http.get(u('/api/helpdesk/handle-time-by-type'), () => wd([
    { ticket_type:'complaint', avg_minutes: 18 },
    { ticket_type:'enquiry',   avg_minutes:  9 },
    { ticket_type:'request',   avg_minutes: 12 },
    { ticket_type:'feedback',  avg_minutes:  6 },
  ])),
  // ResolutionPoint: { agent_name, resolution_pct }
  http.get(u('/api/helpdesk/resolution-by-agent'), () => wd(
    HELPDESK_AGENTS.map(a => ({ agent_name: a.full_name, resolution_pct: rng(65,98) }))
  )),
  // TypeDistPoint: { ticket_type, count }
  http.get(u('/api/helpdesk/type-distribution'), () => wd([
    { ticket_type:'complaint', count: 24 }, { ticket_type:'enquiry', count: 16 },
    { ticket_type:'request',   count:  8 }, { ticket_type:'feedback', count: 4 },
  ])),
  // LeaderRow: { agent_name, tickets_handled, tickets_resolved, avg_csat, avg_handle_min, sla_breaches }
  http.get(u('/api/helpdesk/stats/leaderboard'), () => wd(
    HELPDESK_AGENTS.map(a => ({
      agent_name: a.full_name,
      tickets_handled:  a.open_tickets + a.resolved_today,
      tickets_resolved: a.resolved_today,
      avg_csat:        rng(38,50)/10,
      avg_handle_min:  a.avg_handle_mins,
      sla_breaches:    a.sla_breached,
    }))
  )),
  // SLAByAgentRow: { agent_name, total, breached, breach_pct }
  http.get(u('/api/helpdesk/stats/sla-by-agent'), () => wd(
    HELPDESK_AGENTS.map(a => {
      const total = a.open_tickets + a.resolved_today
      return {
        agent_name:  a.full_name,
        total,
        breached:    a.sla_breached,
        breach_pct:  total > 0 ? Math.round((a.sla_breached / total) * 100) : 0,
      }
    })
  )),
  // BusyHourRow: { hour, ticket_count }
  http.get(u('/api/helpdesk/stats/busiest-hours'), () => wd(
    Array.from({ length: 10 }, (_, h) => ({ hour: h + 8, ticket_count: rng(5,30) }))
  )),
  // ChannelRow: { channel, count } — already correct
  http.get(u('/api/helpdesk/stats/channel-breakdown'), () => wd([
    { channel:'email', count: 18 }, { channel:'phone', count: 14 },
    { channel:'walk_in', count: 8 }, { channel:'web', count: 6 },
  ])),
]

// ── BD ────────────────────────────────────────────────────────────────────────

const BD_EMPLOYER_NAMES = ['Shell Nigeria','MTN Nigeria','Dangote Group','First Bank','NNPC Ltd','Unilever Nigeria','Guinness Nigeria','NB Plc','Nestle Nigeria','GTBank','Zenith Bank','Flour Mills Nigeria','PZ Cussons','Lafarge Africa','Julius Berger']
const BD_EMPLOYERS = Array.from({ length: 20 }, (_, i) => ({
  id: i+1,
  name: BD_EMPLOYER_NAMES[i % BD_EMPLOYER_NAMES.length],
  rc_number: `RC${(100000 + i * 7231).toString()}`,
  sector: pick(['Oil & Gas','Telecoms','FMCG','Banking','Manufacturing','Construction']),
  staff_count: rng(50,5000),
  active_loans: rng(10,200),
  loan_book_kobo: rng(20,400)*1_000_000_00,
  mou_status: pick(['signed','pending','expired','none']),
  mou_signed_date: dateStr(rng(60,365)),
  mou_expiry_date: dateStr(rng(-30,180)),
  contact_name: name(),
  contact_email: `bd${i}@employer.ng`,
  contact_phone: `080${rng(10000000,99999999)}`,
  address: `${rng(1,200)} Broad Street, Lagos Island`,
  state: pick(STATES),
  joined_date: dateStr(rng(100,900)),
  created_at: isoDate(rng(100,900)),
}))

const BD_LEAD_COMPANIES = ['Flour Mills Nigeria','Nestle Nigeria','7-Up Bottling','Cadbury Nigeria','PZ Cussons','TOTAL Energies','Dangote Cement','GTBank Staff','Zenith Bank Staff','UBA Employees','Access Bank','MTN Staff']
const BD_LEADS = Array.from({ length: 20 }, (_, i) => ({
  id: i+1,
  title: pick(['Salary Earner Loan Scheme','Corporate Payroll Finance','Working Capital Credit','Asset Finance Deal','SME Business Loan']),
  entity_type: pick(['company','individual_at_company','individual']),
  company_name: BD_LEAD_COMPANIES[i % BD_LEAD_COMPANIES.length],
  employer_name: BD_EMPLOYER_NAMES[i % BD_EMPLOYER_NAMES.length],
  contact_name: name(),
  contact_phone: `080${rng(10000000,99999999)}`,
  contact_email: `lead${i}@company.ng`,
  sector: pick(['FMCG','Manufacturing','Healthcare','Education','Logistics','Banking']),
  lead_type: pick(['corporate','sme','government']),
  stage: pick(['prospect','qualified','proposal','negotiation','won','lost']),
  lead_score: rng(40,95),
  employee_count: rng(50,2000),
  potential_value_kobo: rng(50,500)*1_000_000_00,
  assigned_name: name(),
  notes: i % 3 === 0 ? 'Follow-up scheduled for end of month' : null,
  updated_at: isoDate(rng(0,14)),
  created_at: isoDate(rng(1,180)),
}))

const BD = [
  http.get(u('/api/bd/stats'), () => wd({
    pipeline: [
      { stage:'prospect',    count: 42, total_value_kobo: 420_000_000_00 },
      { stage:'qualified',   count: 28, total_value_kobo: 280_000_000_00 },
      { stage:'proposal',    count: 18, total_value_kobo: 180_000_000_00 },
      { stage:'negotiation', count: 9,  total_value_kobo: 90_000_000_00 },
      { stage:'won',         count: 14, total_value_kobo: 140_000_000_00 },
      { stage:'lost',        count: 6,  total_value_kobo: 60_000_000_00 },
    ],
    employers: { active: 84, mou_signed: 61, mou_expiring: 8 },
  })),
  http.get(u('/api/bd/employers'), () => wd(BD_EMPLOYERS)),
  http.post(u('/api/bd/employers'), () => ok({ id: 99 })),
  http.put(u('/api/bd/employers/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/bd/leads'), () => wd(BD_LEADS)),
  http.post(u('/api/bd/leads'), () => ok({ id: 99 })),
  http.put(u('/api/bd/leads/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/bd/pipeline-kpis'), () => wd({ total_leads: 117, this_month: 24, conversion_rate_pct: 11.97, avg_deal_kobo: 148_000_000_00 })),
]

// ── Campaigns / Telemarketing ─────────────────────────────────────────────────

const CAMPAIGNS_LIST = Array.from({ length: 12 }, (_, i) => ({
  id: i+1, name: pick(['June Loan Drive','Salary Earner Push','Card Upgrade Campaign','Q3 Retention']),
  description: 'Campaign targeting salary earners',
  type: pick(['email','sms','multi']), status: pick(['draft','active','scheduled','completed']),
  list_id: rng(1,6), created_by: name(), scheduled_at: isoDate(rng(-14,30)),
}))

const CAMPAIGNS = [
  http.get(u('/api/campaigns'), () => ok({ total: CAMPAIGNS_LIST.length, campaigns: CAMPAIGNS_LIST })),
  http.post(u('/api/campaigns'), () => ok({ id: 99, status: 'draft' })),
  http.post(u('/api/campaigns/:id/start'),  () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/campaigns/:id/pause'),  () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/campaigns/:id/cancel'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/campaigns/analytics'), () => ok({
    summary: {
      total_campaigns: 12, total_sent: 48200, total_delivered: 44100,
      total_opened: 19600, total_clicked: 4400, total_bounced: 380, total_unsubscribed: 92,
      avg_open_rate: 44.4, avg_click_rate: 10.0, avg_bounce_rate: 0.8, avg_delivery_rate: 91.5,
    },
    by_channel: [
      { channel: 'email', sent: 32000, delivered: 29600, open_rate: 46.2, click_rate: 11.2, delivery_rate: 92.5 },
      { channel: 'sms',   sent: 16200, delivered: 14500, open_rate: 0,    click_rate: 0,    delivery_rate: 89.5 },
    ],
    monthly_volume: MONTHS_ISO.map(m => ({ month: m, email: rng(3000,7000), sms: rng(1000,3000) })),
    channel_split: [
      { channel: 'email', count: 8 },
      { channel: 'sms',   count: 4 },
    ],
    top_campaigns: Array.from({ length: 5 }, (_, i) => ({
      id: i+1, name: pick(['June Loan Drive','Salary Earner Push','Card Upgrade Campaign','Q3 Retention','Welcome Series']),
      channel: pick(['email','sms']), sent: rng(3000,12000),
      open_rate: rng(30,60), click_rate: rng(5,20), delivered_pct: rng(85,98),
    })),
  })),
  http.get(u('/api/campaigns/:id/analytics'), () => ok({
    campaign: { id: 1, name: 'June Loan Drive', channel: 'email', status: 'completed', contact_count: 5000, sent_at: isoDate(7), completed_at: isoDate(6) },
    metrics: {
      total_contacts: 5000, sent: 4820, sent_pct: 96.4, delivered: 4410, delivery_rate: 91.5,
      opened: 1960, open_rate: 44.4, clicked: 441, click_rate: 10.0,
      bounced: 38, bounce_rate: 0.8, spam: 4, unsubscribed: 9, failed: 42,
    },
    timeline: Array.from({ length: 12 }, (_, i) => ({
      hour: new Date(Date.now() - (11-i) * 3_600_000).toISOString(),
      delivered: rng(100,600), opened: rng(50,300), clicked: rng(5,60),
    })),
    top_links: [
      { url: 'https://o3capital.ng/apply', clicks: 220 },
      { url: 'https://o3capital.ng/loan', clicks: 140 },
      { url: 'https://o3capital.ng/card', clicks: 81 },
    ],
    contact_stats: { pending: 0, sent: 4820, delivered: 4410, opened: 1960, clicked: 441, bounced: 38, failed: 42 },
  })),

  http.get(u('/api/contact-lists'), () => ok(
    Array.from({ length: 6 }, (_, i) => ({
      id: i+1, name: pick(['All Salary Earners','Delinquent Customers','High-Value Borrowers','New Applicants']),
      member_count: rng(200,5000),
    }))
  )),
  http.post(u('/api/contact-lists'), () => ok({ id: 99 })),
  http.delete(u('/api/contact-lists/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/message-templates'), () => ok([
    { id:1, name:'Loan Offer', channel:'sms', category:'promotional',
      sms_body:'Dear {{first_name}}, you have a pre-approved loan offer from O3 Capital. Visit o3capital.ng/apply or call 01 330 1070. Reply STOP to opt out.',
      email_subject:null, email_blocks:null, created_by:name(), updated_at:isoDate(2) },
    { id:2, name:'Payment Reminder', channel:'sms', category:'transactional',
      sms_body:'Dear {{first_name}}, your loan repayment of ₦{{amount}} is due on {{due_date}}. Pay via the app or call us. O3 Capital.',
      email_subject:null, email_blocks:null, created_by:name(), updated_at:isoDate(5) },
    { id:3, name:'Welcome Email', channel:'email', category:'transactional',
      sms_body:null,
      email_subject:'Welcome to O3 Capital, {{first_name}}!',
      email_blocks:null, created_by:name(), updated_at:isoDate(10) },
    { id:4, name:'Card Upgrade', channel:'email', category:'promotional',
      sms_body:null,
      email_subject:'Upgrade your O3 Capital card today, {{first_name}} {{last_name}}',
      email_blocks:null, created_by:name(), updated_at:isoDate(8) },
    { id:5, name:'Delinquency Notice', channel:'sms', category:'transactional',
      sms_body:'Dear {{first_name}}, your O3 Capital account (CIF: {{cif_number}}) is {{days_overdue}} days overdue. Please contact us immediately. O3 Capital.',
      email_subject:null, email_blocks:null, created_by:name(), updated_at:isoDate(1) },
    { id:6, name:'Loan Approval', channel:'email', category:'transactional',
      sms_body:null,
      email_subject:'Your loan has been approved, {{first_name}}!',
      email_blocks:null, created_by:name(), updated_at:isoDate(3) },
    { id:7, name:'Savings Promo', channel:'sms', category:'promotional',
      sms_body:'Hi {{first_name}}, earn up to 12% p.a. on your savings with O3 Capital Fixed Deposit. Visit o3capital.ng or call 01 330 1070. O3 Capital.',
      email_subject:null, email_blocks:null, created_by:name(), updated_at:isoDate(7) },
    { id:8, name:'Account Alert', channel:'email', category:'notification',
      sms_body:null,
      email_subject:'Important account update for {{first_name}}',
      email_blocks:null, created_by:name(), updated_at:isoDate(0) },
  ])),
  http.get(u('/api/message-templates/:id'), ({ params }) => {
    const templates = [
      { id:1, name:'Loan Offer', channel:'sms', category:'promotional',
        sms_body:'Dear {{first_name}}, you have a pre-approved loan offer from O3 Capital. Visit o3capital.ng/apply or call 01 330 1070. Reply STOP to opt out.',
        email_subject:null, email_blocks:null },
      { id:2, name:'Payment Reminder', channel:'sms', category:'transactional',
        sms_body:'Dear {{first_name}}, your loan repayment of ₦{{amount}} is due on {{due_date}}. Pay via the app or call us. O3 Capital.',
        email_subject:null, email_blocks:null },
      { id:3, name:'Welcome Email', channel:'email', category:'transactional',
        sms_body:null, email_subject:'Welcome to O3 Capital, {{first_name}}!', email_blocks:null },
    ]
    const t = templates[(Number(params.id)-1) % templates.length] ?? templates[0]
    return ok({ ...t, id:Number(params.id), created_by:name(), updated_at:isoDate(rng(0,30)) })
  }),
  http.post(u('/api/message-templates'), () => ok({ id: 99 })),
  http.put(u('/api/message-templates/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/message-templates/:id'), () => new HttpResponse(null, { status: 204 })),

  // Telemarketing
  http.get(u('/api/telemarketing/campaigns'), () => ok(
    Array.from({ length: 5 }, (_, i) => ({
      id: i+1, name: `TM Campaign ${i+1}`, status: pick(['active','paused','completed']),
      total_leads: rng(200,2000), called: rng(100,1800), converted: rng(20,200),
    }))
  )),
  http.post(u('/api/telemarketing/campaigns'), () => ok({ id: 99 })),
  http.put(u('/api/telemarketing/campaigns/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/telemarketing/campaigns/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/telemarketing/campaigns/:id/stats'), () => ok({
    total_leads: 500, called: 342, converted: 48, pending: 158, conversion_rate_pct: 14.0,
  })),
  http.get(u('/api/telemarketing/leads'), () => ok(
    Array.from({ length: 30 }, (_, i) => ({
      id: i+1, customer_name: name(), phone: `080${rng(10000000,99999999)}`,
      product: pick(['Payday Loan','Salary Advance']), amount_kobo: rng(5,50)*1_000_000_00,
      attempts: rng(0,3), status: pick(['pending','called','converted','skipped']),
      assigned_to: name(), last_call: pick([null, isoDate(rng(1,14))]),
      campaign_id: rng(1,5),
    }))
  )),
  http.post(u('/api/telemarketing/leads'), () => ok({ id: 99 })),
  http.post(u('/api/telemarketing/leads/:id/call'), () => ok({ status: 'called' })),
  http.post(u('/api/telemarketing/leads/:id/skip'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/telemarketing/queue'), () => wd(
    Array.from({ length: 30 }, (_, i) => ({
      id: i+1, customer_name: name(), phone: `080${rng(10000000,99999999)}`,
      outstanding_kobo: rng(5,50)*1_000_000_00, dpd: rng(1,120),
      last_call: pick([null, isoDate(rng(1,14))]), attempts: rng(0,3),
      status: pick(['pending','called','skipped','converted']), assigned_to: name(),
    }))
  )),
  http.post(u('/api/telemarketing/queue/bulk-skip'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/telemarketing/queue/:id/call'), () => ok({ status: 'called' })),
  http.post(u('/api/telemarketing/queue/:id/skip'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/telemarketing/dnc'), () => wd(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1, phone: `080${rng(10000000,99999999)}`, reason: pick(['Customer Request','Complaint','Legal']),
      added_by: name(), added_at: isoDate(rng(0,180)),
    }))
  )),
  http.post(u('/api/telemarketing/dnc'), () => ok({ id: 99 })),
  http.post(u('/api/telemarketing/dnc/bulk-remove'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/telemarketing/dnc-kpis'), () => wd({
    total_dnc: 1842, added_this_month: 47, bulk_removes: 8,
  })),
  http.get(u('/api/telemarketing/performance-kpis'), () => wd({
    total_calls: rng(200,400), connected: rng(140,280), ptp_count: rng(30,80), conversion_rate_pct: rng(10,25),
  })),
  http.get(u('/api/telemarketing/by-disposition'), () => wd([
    { disposition:'converted', count: 312 }, { disposition:'not_interested', count: 840 },
    { disposition:'callback', count: 420 }, { disposition:'no_answer', count: 980 }, { disposition:'skipped', count: 288 },
  ])),
  http.get(u('/api/telemarketing/hourly-volume'), () => wd(
    Array.from({ length: 10 }, (_, h) => ({ hour: h + 8, count: rng(10,80) }))
  )),
  http.get(u('/api/telemarketing/agent-performance'), () => wd(
    Array.from({ length: 6 }, () => ({
      agent_name: name(), calls: rng(20,80), connected: rng(12,60), ptp_count: rng(3,20),
      conversion_pct: rng(8,25), avg_handle_seconds: rng(120,420),
    }))
  )),

  // Dialer
  http.get(u('/api/dialer/sessions/me'), () => ok({
    id: 1, campaign_id: 1, campaign_name: 'October Loan Renewal Drive',
    status: 'ready', calls_made: 14, calls_answered: 9,
    joined_at: new Date(Date.now() - 3_600_000).toISOString(),
    active_call_id: null, active_call_phone: null,
  })),
  http.post(u('/api/dialer/sessions'), () => ok({
    id: 1, campaign_id: 1, campaign_name: 'October Loan Renewal Drive',
    status: 'ready', calls_made: 0, calls_answered: 0,
    joined_at: new Date().toISOString(),
    active_call_id: null, active_call_phone: null,
  })),
  http.delete(u('/api/dialer/sessions'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/dialer/campaigns'), () => ok([
    { id: 1, name: 'October Loan Renewal Drive', description: 'Outbound renewal calls to expiring loans', status: 'active',
      dial_ratio: 1.5, max_abandonment_pct: 3.0, caller_id: '+2348000000000',
      max_attempts: 3, retry_delay_minutes: 60, schedule_start: '08:00', schedule_end: '17:00',
      created_at: new Date(Date.now() - 7*86400000).toISOString(),
      updated_at: new Date(Date.now() - 86400000).toISOString() },
    { id: 2, name: 'Overdue Collections Q3', description: 'Collections calls for 30+ DPD accounts', status: 'paused',
      dial_ratio: 2.0, max_abandonment_pct: 2.5, caller_id: '+2348000000001',
      max_attempts: 5, retry_delay_minutes: 120, schedule_start: '09:00', schedule_end: '16:00',
      created_at: new Date(Date.now() - 14*86400000).toISOString(),
      updated_at: new Date(Date.now() - 2*86400000).toISOString() },
    { id: 3, name: 'Card Activation Drive', description: 'Activate dormant card holders', status: 'draft',
      dial_ratio: 1.0, max_abandonment_pct: 3.0, caller_id: '+2348000000002',
      max_attempts: 2, retry_delay_minutes: 30, schedule_start: null, schedule_end: null,
      created_at: new Date(Date.now() - 2*86400000).toISOString(),
      updated_at: new Date(Date.now() - 86400000).toISOString() },
  ])),
  http.post(u('/api/dialer/campaigns'), () => ok({ id: 99 })),
  http.put(u('/api/dialer/campaigns/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/dialer/campaigns/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/dialer/campaigns/:id/contacts'), () => ok({ inserted: 284, total: 300 })),
  http.get(u('/api/dialer/campaigns/:id/stats'), () => ok({
    queue:    [{ status: 'pending', cnt: 412 }, { status: 'called', cnt: 187 }, { status: 'converted', cnt: 38 }],
    calls:    [{ answered: 163, abandoned: 4, total: 187, avg_duration_sec: 142 }],
    sessions: [{ status: 'ready', cnt: 4 }, { status: 'on_call', cnt: 2 }, { status: 'paused', cnt: 1 }],
    abandon_pct: 2.1, cbn_limit_pct: 3.0,
  })),
]

// ── Admin ─────────────────────────────────────────────────────────────────────
// All return direct arrays/objects

const ADMIN_USERS = Array.from({ length: 24 }, (_, i) => ({
  id: i+1, email: email(name()), full_name: name(),
  role: pick(['md','cfo','sales_officer','collections_agent','hr_officer','compliance_officer','finance_officer']),
  department: pick(DEPTS), is_active: Math.random() > 0.1,
  last_login: pick([isoDate(rng(0,14)), null]), created_at: isoDate(rng(90,600)),
  must_change_password: false,
}))

const ADMIN = [
  http.get(u('/api/admin/users'), () => ok(ADMIN_USERS)),
  http.post(u('/api/admin/users'), () => ok({ id: 99, must_change_password: true })),
  http.put(u('/api/admin/users/:id'), () => new HttpResponse(null, { status: 204 })),
  http.patch(u('/api/admin/users/:id/deactivate'), () => new HttpResponse(null, { status: 204 })),
  http.patch(u('/api/admin/users/:id/activate'),   () => new HttpResponse(null, { status: 204 })),
  http.patch(u('/api/admin/users/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/admin/users/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/admin/users/:id/reset-password'), () => ok({ temporary_password: 'TempPass123!' })),

  http.get(u('/api/admin/roles'), () => ok([
    { name:'md', label:'MD/CEO', description:'Full access', page_count: 60, user_count: 1 },
    { name:'cfo', label:'CFO', description:'Finance access', page_count: 18, user_count: 2 },
    { name:'sales_officer', label:'Sales Officer', description:'Sales access', page_count: 10, user_count: 6 },
    { name:'collections_agent', label:'Collections Agent', description:'Collections access', page_count: 5, user_count: 8 },
    { name:'hr_officer', label:'HR Officer', description:'HR access', page_count: 4, user_count: 3 },
  ])),
  http.post(u('/api/admin/roles'), () => ok({ name: 'custom_role' })),
  http.put(u('/api/admin/roles/:name'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/admin/roles/:name'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/admin/api-keys'), () => ok(
    Array.from({ length: 4 }, (_, i) => ({
      key_name: pick(['Production Key','Test Key','Integration Key','Staging Key']),
      description: 'API access key', category: pick(['internal','external']), is_active: Math.random() > 0.2,
    }))
  )),
  http.post(u('/api/admin/api-keys'), () => ok({ key_name: 'New Key', raw_key: 'o3k_XXXXXXXXXXXXXXXX' })),
  http.delete(u('/api/admin/api-keys/:name'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/admin/api-keys/:name/test'), () => ok({ status: 'ok', detail: 'Connection successful' })),

  http.get(u('/api/admin/activity'), () => ok(
    Array.from({ length: 30 }, (_, i) => ({
      id: i+1, user_name: name(), action: pick(['POST /api/loans','PUT /api/admin/users','DELETE /api/crm/contacts']),
      ip: `102.${rng(0,255)}.${rng(0,255)}.${rng(0,255)}`, created_at: isoDate(rng(0,7)),
      method: pick(['POST','PUT','DELETE']), page: pick(['loans','admin','crm','collections']),
    }))
  )),

  http.get(u('/api/admin/email-senders'), () => ok([
    { id: 1, address: 'care@o3capital.com', name: 'O3 Capital Care', label: 'Default Sender', purpose: 'general', is_default: true, is_active: true, created_at: dateStr(90) },
    { id: 2, address: 'noreply@o3capital.com', name: 'O3 Capital', label: 'No-reply', purpose: 'notification', is_default: false, is_active: true, created_at: dateStr(60) },
  ])),
  http.post(u('/api/admin/email-senders'), () => ok({ id: 99 })),
  http.put(u('/api/admin/email-senders/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/admin/email-senders/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/admin/email-senders/:id/set-default'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/admin/notification-settings'), () => ok({ email_enabled: true, sms_enabled: false, push_enabled: true })),
  http.put(u('/api/admin/notification-settings'), () => new HttpResponse(null, { status: 204 })),

  // Workflow templates
  http.get(u('/api/admin/workflow-templates'), () => ok([
    { id: 1, name: 'Treasury Standard', description: 'Routine settlement shortfall and fee adjustments — Finance Head approves, Settlement Officer posts', notify_roles: ['finance_head','treasury_officer'], approver_roles: ['finance_head','treasury_officer'], poster_roles: ['settlement_officer'], created_at: isoDate(30) },
    { id: 2, name: 'CFO Approval', description: 'High-value or exceptional postings requiring CFO sign-off before posting', notify_roles: ['cfo','finance_head'], approver_roles: ['cfo'], poster_roles: ['settlement_officer','treasury_officer'], created_at: isoDate(25) },
    { id: 3, name: 'Quick Post', description: 'Low-risk minor adjustments — Finance Officer approves and posts directly', notify_roles: ['finance_officer'], approver_roles: ['finance_officer'], poster_roles: ['finance_officer'], created_at: isoDate(10) },
  ])),
  http.post(u('/api/admin/workflow-templates'), () => ok({ id: 99 })),
  http.put(u('/api/admin/workflow-templates/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/admin/workflow-templates/:id'), () => new HttpResponse(null, { status: 204 })),
]

// ── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS = [
  http.get(u('/api/settings'), () => ok([
    { key: 'company_name', value: 'O3 Capital Limited', has_value: true, updated_at: dateStr(30) },
    { key: 'support_email', value: 'support@o3capital.com', has_value: true, updated_at: dateStr(30) },
    { key: 'support_phone', value: '+234 800 OCAPITAL', has_value: true, updated_at: dateStr(60) },
    { key: 'default_currency', value: 'NGN', has_value: true, updated_at: dateStr(90) },
  ])),
  http.put(u('/api/settings/:key'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/settings/sync-status'), () => ok(
    Array.from({ length: 5 }, (_, i) => ({
      id: i+1, started_at: isoDate(i*3), finished_at: isoDate(i*3 - 0.1),
      status: i === 0 ? 'running' : 'success', rows_synced: rng(800,2400), error_msg: undefined,
    }))
  )),
  http.post(u('/api/settings/sync-status'), () => ok({ id: 99, status: 'running' })),
]

// ── Mail ──────────────────────────────────────────────────────────────────────

const MAIL = [
  http.get(u('/api/mail/inbox'), () => ok(
    Array.from({ length: 20 }, (_, i) => {
      const n = name()
      return {
        id: i+1, from_email: email(n), from_name: n, to_email: 'support@o3capital.com',
        subject: pick(['Re: Loan application','Statement request','Account query','Card issue']),
        body_text: 'Hi, I am writing to enquire about my account. Please advise on next steps.',
        body_html: null, is_read: Math.random() > 0.4, received_at: isoDate(rng(0,7)),
      }
    })
  )),
  http.get(u('/api/mail/messages'), () => ok([])),
  http.get(u('/api/mail/messages/:id'), () => ok({
    id: 1, kind: 'outbound', related_type: null, related_id: null,
    subject: 'Re: Loan application query',
    from_email: 'support@o3capital.com', from_name: 'O3 Capital Support',
    recipients: { to: [{ email: 'customer@example.ng', name: 'Customer' }] },
    status: 'delivered', provider_message_id: 'mock-123',
    queued_at: isoDate(1), delivered_at: isoDate(1), opened_at: isoDate(0),
    clicked_at: null, bounced_at: null, last_error: null,
    created_at: isoDate(1), updated_at: isoDate(0),
    html_body: '<p>Dear Customer,</p><p>Thank you for contacting O3 Capital. We have reviewed your loan application.</p>',
    text_body: 'Dear Customer,\n\nThank you for contacting O3 Capital.',
  })),
  http.get(u('/api/mail/messages/:id/replies'), () => ok([])),
  http.get(u('/api/mail/messages/:id/events'), () => ok([])),
  http.post(u('/api/mail/messages/:id/reply'), () => ok({ id: 99 })),
  http.put(u('/api/mail/inbox/:id/read'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/mail/drafts'), () => ok([])),
  http.get(u('/api/mail/drafts/:id'), () => ok({ id: 1, subject: 'Draft subject', to_addrs: [], from_email: null, from_name: null, html_body: null, text_body: '' })),
  http.post(u('/api/mail/drafts'), () => ok({ id: rng(10, 999) })),
  http.delete(u('/api/mail/drafts/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/mail/send'), () => ok({ id: 99, status: 'sent' })),
  http.get(u('/api/mail/signature'), () => ok({ signature_html: '<p>Best regards,<br/><strong>O3 Capital</strong></p>', signature_text: 'Best regards,\nO3 Capital' })),
  http.put(u('/api/mail/signature'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/mail/metrics'), () => ok({
    total_sent: 5280,
    total_delivered: 4820,
    total_opened: 2140,
    total_clicked: 482,
    total_bounced: 38,
    total_spam: 3,
    delivery_rate: 91.3,
    open_rate: 44.4,
    bounce_rate: 0.7,
  })),
  http.get(u('/api/mail/deliverability'), () => ok({
    domain: 'o3capital.com',
    checks: [
      { key: 'from_email',     label: 'SendGrid from email',       ok: true,  detail: 'care@o3capital.com' },
      { key: 'sendgrid_key',   label: 'SendGrid API key',          ok: true,  detail: 'Required for all outbound mail' },
      { key: 'signed_webhook', label: 'Signed SendGrid webhook',   ok: false, detail: 'Set SENDGRID_WEBHOOK_PUBLIC_KEY after enabling signed Event Webhook' },
      { key: 'graph',          label: 'Microsoft Graph mailbox',   ok: false, detail: 'Optional — enables real Sent Items in staff mailboxes' },
      { key: 'spf',            label: 'SPF includes SendGrid',     ok: true,  detail: 'v=spf1 include:sendgrid.net ~all' },
      { key: 'dmarc',          label: 'DMARC record exists',       ok: true,  detail: 'v=DMARC1; p=none; rua=mailto:dmarc@o3capital.com' },
      { key: 'dkim',           label: 'DKIM/domain authentication',ok: true,  detail: 's1/s2 DKIM CNAMEs point to SendGrid' },
      { key: 'suppressions',   label: 'Suppression list',          ok: true,  detail: '0 active suppressed recipients' },
    ],
  })),
  http.get(u('/api/mail/suppressions'), () => ok([
    { email: 'bounced@example.ng', reason: 'bounced', source: 'sendgrid_event', updated_at: new Date(Date.now() - 86400000).toISOString() },
    { email: 'spam@example.ng',    reason: 'spam_report', source: 'sendgrid_event', updated_at: new Date(Date.now() - 172800000).toISOString() },
  ])),
  http.post(u('/api/mail/test'), () => ok({ status: 'sent' })),
]

// ── Settlements ───────────────────────────────────────────────────────────────

const SETTLEMENTS = [
  http.get(u('/api/settlements/kpis'), () => wd({
    pending_kobo: 42_000_000_00, settled_mtd_kobo: 312_000_000_00, failed_count: 3, avg_settlement_hrs: 1.8,
  })),
  http.get(u('/api/settlements'), () => wd(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, batch_ref: `BATCH-2026-${String(i+100).padStart(4,'0')}`,
      batch_date: dateStr(rng(0,14)),
      txn_count: rng(10,150),
      total_amount_kobo: rng(50,500)*1_000_000_00,
      status: pick(['completed','pending','failed']),
    }))
  )),
  http.get(u('/api/settlements/batches'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, batch_ref: `BATCH-2026-${i+100}`, amount_kobo: rng(50,500)*1_000_000_00,
      count: rng(10,100), status: pick(['pending','processed','failed']),
      created_at: isoDate(rng(0,14)),
    }))
  )),
  http.get(u('/api/settlements/:id/transactions'), () => wd([])),
  http.get(u('/api/settlements/manual-postings'), () => wd(
    [
      { id:1, ref:'MP-SET-001', workflow_template_id:1, workflow_template_name:'Treasury Standard', type:'Debit', amount_kobo:25_000_000_00, account:'0123456789', description:'EOD interbank settlement shortfall', initiated_by:'Emeka Obi', stage:'pending_approval', approver_roles:['finance_head','treasury_officer'], poster_roles:['settlement_officer'], approved_by:null, approved_at:null, posted_by:null, posted_at:null, rejected_by:null, rejected_at:null, rejection_reason:null, created_at:isoDate(0.2) },
      { id:2, ref:'MP-SET-002', workflow_template_id:2, workflow_template_name:'CFO Approval', type:'Credit', amount_kobo:8_500_000_00, account:'0987654321', description:'Reversal of duplicate debit', initiated_by:'Adaeze Nwosu', stage:'approved', approver_roles:['cfo'], poster_roles:['settlement_officer','treasury_officer'], approved_by:'Olumide Akin', approved_at:isoDate(0.1), posted_by:null, posted_at:null, rejected_by:null, rejected_at:null, rejection_reason:null, created_at:isoDate(1) },
      { id:3, ref:'MP-SET-003', workflow_template_id:1, workflow_template_name:'Treasury Standard', type:'Debit', amount_kobo:3_000_000_00, account:'0123456789', description:'Charge-back settlement', initiated_by:'Tunde Posi', stage:'posted', approver_roles:['finance_head','treasury_officer'], poster_roles:['settlement_officer'], approved_by:'Olumide Akin', approved_at:isoDate(2.1), posted_by:'Ngozi Eze', posted_at:isoDate(2), rejected_by:null, rejected_at:null, rejection_reason:null, created_at:isoDate(2.5) },
      { id:4, ref:'MP-SET-004', workflow_template_id:2, workflow_template_name:'CFO Approval', type:'Credit', amount_kobo:12_750_000_00, account:'0246813579', description:'Interswitch fees reconciliation credit', initiated_by:'Emeka Obi', stage:'rejected', approver_roles:['cfo'], poster_roles:['settlement_officer','treasury_officer'], approved_by:null, approved_at:null, posted_by:null, posted_at:null, rejected_by:'Olumide Akin', rejected_at:isoDate(3.2), rejection_reason:'Supporting document missing — request re-raised', created_at:isoDate(3.5) },
      { id:5, ref:'MP-SET-005', workflow_template_id:1, workflow_template_name:'Treasury Standard', type:'Debit', amount_kobo:500_000_00, account:'0135792468', description:'Bank charges adjustment', initiated_by:'Adaeze Nwosu', stage:'pending_approval', approver_roles:['finance_head','treasury_officer'], poster_roles:['settlement_officer'], approved_by:null, approved_at:null, posted_by:null, posted_at:null, rejected_by:null, rejected_at:null, rejection_reason:null, created_at:isoDate(0.5) },
    ]
  )),
  http.post(u('/api/settlements/manual-postings'), () => ok({ id: 99 })),
  http.put(u('/api/settlements/manual-postings/:id/approve'), () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/settlements/manual-postings/:id/reject'),  () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/settlements/manual-postings/:id/post'),    () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/settlements/manual-postings/:id/return'),  () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/settlements/failed'), () => wd(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1,
      txn_ref: `TXN-${String(2026070000+i).padStart(12,'0')}`,
      amount_kobo: rng(5,500)*100_000,
      customer_name: name(),
      channel: pick(['NIP','CARD','USSD','Web']),
      failure_reason: pick(['Insufficient funds','Invalid account','Bank timeout','Duplicate transaction','Card blocked']),
      failed_at: isoDate(rng(0,14)),
      retry_count: rng(0,3),
    }))
  )),
  http.get(u('/api/settlements/failed/kpis'), () => ok(
    { total_failed: 127, total_amount_kobo: 45_000_000_00, retry_success_rate_pct: 34.2, top_reason: 'Insufficient funds' }
  )),
  http.post(u('/api/settlements/failed/:id/retry'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/settlements/nip'), () => wd(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, session_id: `NIP${rng(100000000,999999999)}`, amount_kobo: rng(1,50)*1_000_000_00,
      status: pick(['processed','pending','failed','reversed']),
      sender_bank: pick(BANKS), receiver_bank: pick(BANKS),
      created_at: isoDate(rng(0,7)),
    }))
  )),
  http.put(u('/api/settlements/nip/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/settlements/nip/bulk-resolve'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/settlements/nip-recon'), () => ok({
    batches: Array.from({ length: 8 }, (_, i) => ({
      id: i+1, batch_date: isoDate(i), batch_ref: `NIP-BATCH-${2025_07_00+i}`,
      batch_type: pick(['incoming','outgoing']), txn_count: rng(80,400),
      total_credits: rng(50,500)*1_000_000_00, total_debits: rng(10,100)*1_000_000_00,
      exception_count: rng(0,5), status: pick(['reconciled','pending','exceptions']),
    })),
    exceptions: Array.from({ length: 12 }, (_, i) => ({
      id: i+1, batch_id: rng(1,8), txn_date: isoDate(rng(0,5)),
      txn_ref: `TXN${rng(10000000,99999999)}`,
      batch_ref: `NIP-BATCH-${2025_07_00+rng(0,7)}`,
      amount_kobo: rng(1,20)*1_000_000_00,
      exception_type: pick(['UNMATCHED_CREDIT','DUPLICATE_POSTING','AMOUNT_MISMATCH','MISSING_CIF']),
      description: 'Core banking credit not found for inbound NIP transfer',
      status: pick(['open','open','open','resolved']),
      resolved_by_name: '', resolved_at: '', resolution_note: '',
    })),
  })),
  http.post(u('/api/settlements/nip-recon'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/settlements/nip-recon/exceptions/:id/resolve'), () => new HttpResponse(null, { status: 204 })),

  // Settlements overview
  http.get(u('/api/settlements/overview'), () => ok({
    settled_today_kobo: 1_240_000_000_00,
    pending_kobo:         32_500_000_00,
    failed_count: 4,
    success_rate_pct: 98.7,
    nip: {
      total: 1847,
      matched: 1832,
      unmatched: 8,
      exception_count: 7,
      exception_value_kobo: 14_250_000_00,
      reconciliation_rate_pct: 99.2,
    },
    paystack: {
      configured: true,
      wallet_balance_kobo: 87_300_000_00,
      last_sync_at: new Date(Date.now() - 12*60*1000).toISOString(),
      open_disputes: 2,
    },
    interswitch: { configured: false },
  })),

  // Paystack reconciliation endpoints
  http.get(u('/api/reconciliation/paystack/summary'), () => ok({
    configured: true,
    paystack: {
      configured: true,
      total_count: 3241,
      success: 3198,
      failed: 43,
      total_volume_kobo: 2_847_650_000_00,
    },
    eod: {
      txn_count: 3199,
      total_vol_kobo: 2_846_980_000_00,
    },
  })),
  http.get(u('/api/reconciliation/paystack/balance'), () => ok({
    data: [{ balance: 87_300_000_00, closing_balance: 87_300_000_00 }],
    meta: { total: 1, page: 1, perPage: 50 },
  })),
  http.get(u('/api/reconciliation/paystack/transactions'), () => ok({
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i+1, reference: `TRF${rng(10000000,99999999)}`,
      amount: rng(5,500)*1_000_00, fees: rng(5,50)*100,
      status: pick(['success','success','success','failed','abandoned']),
      channel: pick(['card','bank_transfer','ussd','mobile_money']),
      currency: 'NGN',
      customer: { email: `customer${i}@email.com`, first_name: name().split(' ')[0], last_name: name().split(' ')[1] },
      authorization: { last4: String(rng(1000,9999)), card_type: pick(['Visa','Mastercard','Verve']), bank: pick(BANKS) },
      created_at: isoDate(rng(0,30)), paid_at: isoDate(rng(0,30)),
    })),
    meta: { total: 3241, page: 1, perPage: 50 },
  })),
  http.get(u('/api/reconciliation/paystack/settlements'), () => ok({
    data: Array.from({ length: 15 }, (_, i) => ({
      id: i+1, settlement_date: isoDate(i),
      status: pick(['success','success','pending']),
      total_processed: rng(50,500)*1_000_000_00,
      total_fees: rng(1,20)*1_000_000_00,
      effective_amount: rng(45,490)*1_000_000_00,
    })),
    meta: { total: 15, page: 1, perPage: 50 },
  })),
  http.get(u('/api/reconciliation/paystack/transfers'), () => ok({
    data: Array.from({ length: 10 }, (_, i) => ({
      id: i+1, reference: `TRF-OUT-${rng(10000,99999)}`,
      amount: rng(100,5000)*1_000_00, fee_charged: 0,
      status: pick(['success','success','pending','failed']),
      reason: pick(['Salary disbursement','Vendor payment','Refund','Loan disbursement']),
      transferred_at: isoDate(rng(0,14)),
      transfer_code: `TRF_${Math.random().toString(36).slice(2,18)}`,
      source: 'balance', source_details: null,
      recipient: { name: name(), type: 'nuban', details: { account_name: name(), bank_name: pick(BANKS), account_number: String(rng(1000000000,9999999999)) } },
      o3c_initiator: pick([
        { loan_ref: `LN-2026-${String(rng(1000,9999))}`, applicant_name: name(), applicant_cif: `CIF${rng(100000,999999)}`, source_type: 'loan_disbursement' },
        { loan_ref: `LN-2026-${String(rng(1000,9999))}`, applicant_name: name(), applicant_cif: `CIF${rng(100000,999999)}`, source_type: 'loan_disbursement' },
        null, // non-loan transfer (salary, vendor, etc.) — no internal customer link
      ]),
    })),
    meta: { total: 10, page: 1, perPage: 50 },
  })),
  http.get(u('/api/reconciliation/paystack/ledger'), () => ok({
    data: Array.from({ length: 30 }, (_, i) => ({
      id: i+1, model_responsible: pick(['Transfer','Transfer_Charge','Transfer_Stamp_Duty_Charge','Settlement']),
      reason: pick(['Monthly salary transfer','Stamp duty charge','Settlement payout','Transfer fee']),
      difference: pick([1,1,-1,-1])*rng(5,500)*1_000_00,
      balance: 87_300_000_00 - i*500_000_00,
      closing_balance: 87_300_000_00 - i*500_000_00,
      createdAt: isoDate(rng(0,30)), created_at: isoDate(rng(0,30)),
    })),
    meta: { total: 300, page: 1, perPage: 50 },
  })),
  http.get(u('/api/reconciliation/paystack/refunds'), () => ok({
    data: Array.from({ length: 5 }, (_, i) => ({
      id: i+1, amount: rng(5,200)*1_000_00,
      status: pick(['processed','pending']),
      customer: { email: `refund${i}@email.com`, first_name: name().split(' ')[0], last_name: name().split(' ')[1] },
      transaction_reference: `TRF${rng(10000000,99999999)}`,
      refunded_at: isoDate(rng(0,14)),
    })),
    meta: { total: 5, page: 1, perPage: 50 },
  })),
  http.get(u('/api/reconciliation/paystack/disputes'), () => ok({
    data: Array.from({ length: 3 }, (_, i) => ({
      id: i+1,
      transaction_reference: `TRF${rng(10000000,99999999)}`,
      customer: { email: `dispute${i}@email.com` },
      refund_amount: rng(10,500)*1_000_00,
      category: pick(['chargeback','retrieval','fraud']),
      status: pick(['pending','awaiting-merchant-feedback','resolved']),
      resolution: pick(['merchant-accepted','declined','']),
      dueAt: isoDate(-rng(1,5)), resolvedAt: i === 0 ? isoDate(0) : '',
    })),
    meta: { total: 3, page: 1, perPage: 50 },
  })),
]

// ── Reports / Statements / KPI ────────────────────────────────────────────────

const REPORTS = [
  http.get(u('/api/reports/export-log'), () => wd(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, report_name: 'Monthly Loan Book', generated_by: name(),
      generated_at: isoDate(rng(0,14)), format: 'excel', rows: rng(200,5000),
    }))
  )),
  http.post(u('/api/reports/run'), () => ok({ id: 99, status: 'queued' })),
  http.get(u('/api/reports/kpis'), () => wd({
    portfolio_outstanding_kobo: 4_820_000_000_00, disbursements_mtd_kobo: 267_000_000_00,
    collections_rate_pct: 91.4, npl_rate_pct: 1.4, active_customers: 1247,
    cards_active: 14820, fd_book_kobo: 1_240_000_000_00, open_tickets: 48,
  })),
  http.get(u('/api/reports/kpi-history'), () => wd(
    MONTHS_ISO.map(m => ({
      month: m, portfolio_outstanding_kobo: rng(4000,5500)*1_000_000_00,
      disbursements_kobo: rng(180,380)*1_000_000_00, collections_rate_pct: rng(88,94),
    }))
  )),
  http.get(u('/api/statements/runs'), () => ok(
    Array.from({ length: 6 }, (_, i) => {
      const total = rng(900, 1400)
      const sent  = i === 0 ? rng(200, 400) : total - rng(0, 15)
      const failed = i === 0 ? rng(2, 8) : rng(0, 12)
      return {
        id: i+1,
        status: i === 0 ? 'active' : 'completed',
        date_from: isoDate(35 + i*30), date_to: isoDate(5 + i*30),
        total_recipients: total, sent_count: sent, failed_count: failed,
        created_at: isoDate(i*30),
      }
    })
  )),
  http.get(u('/api/statements/preview'), ({ request }) => {
    const url   = new URL(request.url)
    const cif   = url.searchParams.get('cif')  || '00039657'
    const dfrom = url.searchParams.get('from') || '2026-04-15'
    const dto   = url.searchParams.get('to')   || '2026-05-14'
    const type  = url.searchParams.get('type') || 'account'

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const fmtD = (s: string) => { const p = s.split('-'); return `${parseInt(p[2])} ${MONTHS[parseInt(p[1])-1]} ${p[0]}` }
    const fmt  = (n: number) => '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const genTime = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    const stmtRef = 'STMT-' + new Date().getFullYear() + '-' + String(Math.floor(Math.random() * 9000) + 1000)

    const CSS = '*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:11px;color:#111;background:#fff;max-width:920px;margin:0 auto}.hd{background:#0E2841;color:#fff;padding:24px 40px;display:flex;justify-content:space-between;align-items:flex-start}.logo{font-size:22px;font-weight:800;letter-spacing:-.3px}.dot{color:#C00000}.tagline{font-size:7.5px;letter-spacing:2.5px;text-transform:uppercase;opacity:.5;margin-top:3px}.addr{text-align:right;font-size:9px;line-height:1.9;opacity:.8}.tb{border-bottom:3px solid #0E2841;padding:12px 40px;display:flex;justify-content:space-between;align-items:center;background:#f8f9fa}.tb h1{font-size:15px;font-weight:700;color:#0E2841;letter-spacing:-.2px}.tb .meta{font-size:9.5px;color:#777;text-align:right;line-height:1.7}.sref{font-family:"Courier New",Courier,monospace;font-size:8.5px;background:#0E2841;color:#fff;padding:2px 7px;border-radius:3px;letter-spacing:.5px;display:inline-block;margin-top:4px}.info{display:flex;justify-content:space-between;padding:18px 40px;border-bottom:1px solid #e8eaed;gap:40px}.cname{font-size:14px;font-weight:700;color:#0E2841;margin-bottom:4px}.il{font-size:10px;color:#555;line-height:1.9}.lbl{font-size:7.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#aaa;display:block;margin-top:7px}.ar{text-align:right;min-width:210px}.actbadge{display:inline-block;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:2px 9px;border-radius:20px;background:#dcfce7;color:#15803d;margin-top:3px}.sum{display:grid;margin:20px 40px;border:1px solid #dde1e7;border-radius:6px;overflow:hidden}.sc{padding:14px 18px;border-right:1px solid #dde1e7}.sc:last-child{border-right:none}.sc.nv{background:#0E2841}.sc-lbl{font-size:7.5px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#aaa;margin-bottom:5px}.sc.nv .sc-lbl{color:rgba(255,255,255,.5)}.sc-val{font-family:"Courier New",Courier,monospace;font-size:16px;font-weight:700;color:#0E2841}.sc.nv .sc-val{color:#fff}.sc.red .sc-val{color:#C00000}.sc.grn .sc-val{color:#15803d}.th{display:flex;justify-content:space-between;align-items:center;padding:0 40px;margin:16px 0 0}.th-lbl{font-size:10px;font-weight:700;color:#0E2841;text-transform:uppercase;letter-spacing:.6px}.th-ct{font-size:9.5px;color:#999}table{width:calc(100% - 80px);margin:8px 40px 0;border-collapse:collapse}thead tr{background:#0E2841}thead th{padding:9px 10px;text-align:left;color:rgba(255,255,255,.85);font-size:8px;text-transform:uppercase;letter-spacing:.7px;font-weight:700;white-space:nowrap}th.r{text-align:right}tbody tr{border-bottom:1px solid #f0f2f5}tbody tr:nth-child(even){background:#fafbfc}td{padding:8px 10px;color:#333;vertical-align:middle}td.dt{color:#888;white-space:nowrap;font-size:9.5px;font-family:"Courier New",Courier,monospace}td.rf{font-family:"Courier New",Courier,monospace;font-size:8.5px;color:#999;white-space:nowrap}td.ds{font-size:10.5px;max-width:200px}td.am{text-align:right;font-family:"Courier New",Courier,monospace;font-size:10.5px;white-space:nowrap}td.am.dr{color:#C00000}td.am.cr{color:#15803d}td.am.em{color:#ddd}td.bal{text-align:right;font-family:"Courier New",Courier,monospace;font-size:10.5px;font-weight:600;color:#0E2841;white-space:nowrap}.bdr{display:inline-block;font-size:7.5px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:.3px;margin-left:5px}.bdr.dr{background:rgba(192,0,0,.1);color:#C00000}.bdr.cr{background:rgba(21,128,61,.1);color:#15803d}tr.op td{background:#f8f9fa;color:#888;font-size:10px}tr.op td.bal{color:#0E2841;font-weight:700}tr.tot{background:#0E2841 !important}tr.tot td{color:#fff;font-weight:700;padding:10px;font-family:"Courier New",Courier,monospace;font-size:10.5px}tr.tot td.am.dr{color:#ffb3b3}tr.tot td.am.cr{color:#86efac}tr.tot td.bal{color:rgba(255,255,255,.6);font-size:9px}.ft{margin:24px 40px 0;padding:14px 0 0;border-top:2px solid #0E2841;padding-bottom:32px}.comp{text-align:center;font-size:7.5px;color:#aaa;letter-spacing:1.2px;text-transform:uppercase;padding:10px 0;border-bottom:1px solid #eee;margin-bottom:14px}.fg{display:grid;grid-template-columns:1fr 1fr;gap:20px}.ft-h{font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#0E2841;margin-bottom:5px}.ft-p{font-size:8.5px;color:#888;line-height:1.75;padding:0}.ft-p li{margin-left:14px;list-style:disc}.ft-b{margin-top:16px;padding-top:10px;border-top:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center}.gen{font-size:7.5px;color:#ccc;font-family:"Courier New",Courier,monospace}.flogo{font-size:12px;font-weight:800;color:#0E2841}.util-wrap{margin:0 40px;padding:12px 0 16px;border-bottom:1px solid #e5e7eb}.util-lbl{font-size:8.5px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;display:flex;justify-content:space-between}.util-track{height:7px;background:#f0f0f0;border-radius:4px;overflow:hidden}.util-fill{height:100%;border-radius:4px}.alert{margin:14px 40px 0;background:#fff8e1;border:1.5px solid #f59e0b;border-radius:8px;padding:11px 15px;display:flex;align-items:flex-start;gap:9px;font-size:9.5px;color:#92400e;line-height:1.6}.alert-icon{color:#f59e0b;font-size:13px;font-weight:700;flex-shrink:0}.chg-box{margin:14px 40px 0;padding:11px 15px;background:#f5f7fa;border-radius:6px;font-size:8.5px;color:#666;line-height:1.8}@media print{body{max-width:none}@page{size:A4;margin:10mm}html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}'

    const HEADER = '<div class="hd"><div><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 120" width="72" height="39" style="display:block"><circle cx="78" cy="60" r="52" fill="#C00000"/><circle cx="142" cy="60" r="52" fill="#3C3C3C"/><circle cx="110" cy="60" r="52" fill="#8DAAB7"/></svg><div class="tagline" style="margin-top:6px">credible · accessible · reliable</div></div><div class="addr">7th Floor Churchgate Tower 1<br>Plot 30, Churchgate Street<br>Victoria Island, Lagos 101001<br>www.o3cards.com &nbsp;|&nbsp; care@o3cards.com<br>+234 201 330 1070</div></div>'

    const FOOTER = `<div class="ft"><div class="comp">This is a computer generated statement &mdash; it does not require a signature or stamp</div><div class="fg"><div><div class="ft-h">Important Notice</div><p class="ft-p">This statement is confidential and intended solely for the named account holder. Transactions reflect activity within the stated period only. For disputes, contact us within 30 days of statement date.</p></div><div><div class="ft-h">Disputes &amp; Enquiries</div><ul class="ft-p"><li>Email: care@o3cards.com</li><li>Call: +234 201 330 1070</li><li>O3 Cards mobile app</li></ul></div></div><div class="ft-b"><span class="gen">Generated ${genTime} &nbsp;|&nbsp; Ref: ${stmtRef} &nbsp;|&nbsp; Period: ${fmtD(dfrom)} to ${fmtD(dto)}</span><span class="flogo">O3<span style="color:#C00000"> Capital</span></span></div></div>`

    let html: string

    if (type === 'credit_card') {
      const txns = [
        { date: '2026-04-16', ref: 'POS/SHRTE/260416/001', desc: 'SHOPRITE LEKKI PHASE 1',    cat: 'Retail',        isDebit: true,  amount: 487520  },
        { date: '2026-04-18', ref: 'POS/UBRN/260418/001',  desc: 'UBER NIGERIA',               cat: 'Transport',     isDebit: true,  amount: 76400   },
        { date: '2026-04-19', ref: 'WEB/JMIA/260419/001',  desc: 'JUMIA ONLINE SHOPPING',      cat: 'E-Commerce',    isDebit: true,  amount: 195000  },
        { date: '2026-04-21', ref: 'PMT/INWD/260421/001',  desc: 'PAYMENT — THANK YOU',   cat: '',              isDebit: false, amount: 1500000 },
        { date: '2026-04-24', ref: 'POS/DMNZ/260424/001',  desc: 'DOMINOS PIZZA VI',           cat: 'Food & Dining', isDebit: true,  amount: 62500   },
        { date: '2026-04-25', ref: 'WEB/NFLX/260425/001',  desc: 'NETFLIX INTERNATIONAL',      cat: 'Subscriptions', isDebit: true,  amount: 45750   },
        { date: '2026-04-28', ref: 'ATM/ZNTH/260428/001',  desc: 'ZENITH BANK ATM WITHDRAWAL', cat: 'Cash Advance',  isDebit: true,  amount: 500000  },
        { date: '2026-04-30', ref: 'POS/TOTL/260430/001',  desc: 'TOTAL ENERGIES VI',          cat: 'Fuel',          isDebit: true,  amount: 132000  },
        { date: '2026-05-02', ref: 'POS/IKJM/260502/001',  desc: 'IKEJA CITY MALL',            cat: 'Retail',        isDebit: true,  amount: 284300  },
        { date: '2026-05-05', ref: 'POS/SMTH/260505/001',  desc: 'SMOOTHIE FACTORY VGC',       cat: 'Food & Dining', isDebit: true,  amount: 18500   },
        { date: '2026-05-07', ref: 'PMT/INWD/260507/001',  desc: 'PAYMENT — THANK YOU',   cat: '',              isDebit: false, amount: 800000  },
        { date: '2026-05-09', ref: 'WEB/AWSS/260509/001',  desc: 'AMAZON WEB SERVICES',        cat: 'Subscriptions', isDebit: true,  amount: 231840  },
        { date: '2026-05-12', ref: 'POS/NNPC/260512/001',  desc: 'NNPC FILLING STATION VGC',   cat: 'Fuel',          isDebit: true,  amount: 97200   },
        { date: '2026-05-14', ref: 'POS/CKRP/260514/001',  desc: 'CHICKEN REPUBLIC VGC',       cat: 'Food & Dining', isDebit: true,  amount: 24600   },
      ]
      const openBal     = 2_840_500   // kobo = ₦28,405.00
      const creditLimit = 5_000_000   // kobo = ₦50,000.00
      const finCharge   = 14_225      // kobo = ₦142.25

      let bal = openBal
      const ccRows = txns.map(t => {
        if (t.isDebit) bal += t.amount; else bal -= t.amount
        const badge   = t.isDebit ? '<span class="bdr dr">DR</span>' : '<span class="bdr cr">CR</span>'
        const amtCell = t.isDebit
          ? `<td class="am dr">${fmt(t.amount/100)}</td><td class="am em">&mdash;</td>`
          : `<td class="am em">&mdash;</td><td class="am cr">${fmt(t.amount/100)}</td>`
        return `<tr><td class="dt">${fmtD(t.date)}</td><td class="rf">${t.ref}</td><td class="ds">${t.desc}${badge}</td><td style="font-size:9.5px;color:#999">${t.cat}</td>${amtCell}<td class="bal">${fmt(bal/100)}</td></tr>`
      }).join('')

      bal += finCharge
      const fcRef  = 'CHG/FINC/' + dto.replace(/-/g,'').slice(2) + '/001'
      const fcRow  = `<tr style="background:#fffbeb"><td class="dt">${fmtD(dto)}</td><td class="rf">${fcRef}</td><td class="ds">FINANCE CHARGE<span class="bdr dr">DR</span></td><td style="font-size:9.5px;color:#999">Finance</td><td class="am dr">${fmt(finCharge/100)}</td><td class="am em">&mdash;</td><td class="bal">${fmt(bal/100)}</td></tr>`

      const closingBal = bal
      const purchases  = txns.filter(t => t.isDebit && t.cat !== 'Cash Advance').reduce((s,t) => s+t.amount, 0)
      const cashAdv    = txns.filter(t => t.cat === 'Cash Advance').reduce((s,t) => s+t.amount, 0)
      const payments   = txns.filter(t => !t.isDebit).reduce((s,t) => s+t.amount, 0)
      const availCredit = creditLimit - closingBal
      const minPayment  = Math.round(Math.max(500_000, closingBal * 0.05))
      const utilPct     = Math.round((closingBal / creditLimit) * 100)
      const utilColor   = utilPct > 80 ? '#C00000' : utilPct > 60 ? '#f59e0b' : '#15803d'

      html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>O3 Capital — Credit Card Statement</title>
<style>${CSS}.sum{grid-template-columns:repeat(5,1fr)}</style></head>
<body>${HEADER}
<div class="tb"><h1>Credit Card Statement</h1><div class="meta">Period: ${fmtD(dfrom)} to ${fmtD(dto)}<br>Generated: ${genTime}<br><span class="sref">${stmtRef}</span></div></div>
<div class="info">
  <div><div class="cname">TEMITOPE BABATUNDE</div><div class="il">Victoria Island, Lagos</div><span class="lbl">CIF Number</span><div class="il">${cif}</div><span class="lbl">Email</span><div class="il">babatundeopemiposi@gmail.com</div></div>
  <div class="ar">
    <span class="lbl">Card Number</span><div class="il" style="font-family:'Courier New',monospace;letter-spacing:2px;font-weight:600">&bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; 4821</div>
    <span class="lbl">Card Type</span><div class="il" style="font-weight:600">O3 Classic Naira Card</div>
    <span class="lbl">Payment Due Date</span><div class="il" style="font-weight:700;color:#C00000">1 Jun 2026</div>
    <span class="lbl">Minimum Payment</span><div class="il" style="font-weight:700;color:#C00000">${fmt(minPayment/100)}</div>
    <span class="lbl">Status</span><div><span class="actbadge">Active</span></div>
  </div>
</div>
<div class="sum">
  <div class="sc"><div class="sc-lbl">Opening Balance</div><div class="sc-val">${fmt(openBal/100)}</div></div>
  <div class="sc red"><div class="sc-lbl">Purchases</div><div class="sc-val">${fmt(purchases/100)}</div></div>
  <div class="sc red"><div class="sc-lbl">Cash Advances</div><div class="sc-val">${fmt(cashAdv/100)}</div></div>
  <div class="sc grn"><div class="sc-lbl">Payments</div><div class="sc-val">${fmt(payments/100)}</div></div>
  <div class="sc nv"><div class="sc-lbl">Closing Balance</div><div class="sc-val">${fmt(closingBal/100)}</div></div>
</div>
<div class="util-wrap">
  <div class="util-lbl"><span>Credit Utilisation &mdash; ${utilPct}% of ${fmt(creditLimit/100)} limit</span><span style="color:${utilColor}">${fmt(availCredit/100)} available</span></div>
  <div class="util-track"><div class="util-fill" style="width:${utilPct}%;background:${utilColor}"></div></div>
</div>
${utilPct > 70 ? `<div class="alert"><span class="alert-icon">!</span>Your credit utilisation is above 70%. High utilisation may affect your credit profile. Consider paying more than the minimum payment of ${fmt(minPayment/100)}.</div>` : ''}
<div class="th" style="margin-top:16px"><span class="th-lbl">Transactions</span><span class="th-ct">${txns.length + 1} transactions in period</span></div>
<table>
  <thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>Category</th><th class="r">Charge (&#8358;)</th><th class="r">Payment (&#8358;)</th><th class="r">Balance (&#8358;)</th></tr></thead>
  <tbody>
    <tr class="op"><td class="dt">${fmtD(dfrom)}</td><td class="rf"></td><td class="ds">Opening Balance</td><td></td><td class="am em">&mdash;</td><td class="am em">&mdash;</td><td class="bal">${fmt(openBal/100)}</td></tr>
    ${ccRows}${fcRow}
    <tr class="tot"><td colspan="4">Period Totals</td><td class="am dr">${fmt((purchases+cashAdv+finCharge)/100)}</td><td class="am cr">${fmt(payments/100)}</td><td class="bal">Closing: ${fmt(closingBal/100)}</td></tr>
  </tbody>
</table>
<div class="chg-box"><strong style="color:#0E2841">Finance Charges:</strong>&nbsp; Cash advance fee: ${fmt(finCharge/100)} (3% p.m. on ${fmt(cashAdv/100)}) &nbsp;|&nbsp; Purchase APR: 2.5%/month &nbsp;|&nbsp; Cash advance APR: 3.0%/month &nbsp;|&nbsp; Late payment fee: &#8358;2,500</div>
${FOOTER}</body></html>`
    } else {
      const txns = [
        { date: '2026-04-15', ref: 'NIP/INWD/260415/001',  desc: 'TRANSFER FROM ZENITH BANK',        isDebit: false, amount: 5_000_000  },
        { date: '2026-04-17', ref: 'POS/SHRTE/260417/001', desc: 'SHOPRITE LEKKI PHASE 1',            isDebit: true,  amount: 1_245_000  },
        { date: '2026-04-18', ref: 'NIP/O3CTB/260418/001', desc: 'TRANSFER TO GTB ACCOUNT',           isDebit: true,  amount: 2_500_000  },
        { date: '2026-04-21', ref: 'WEB/O3CTB/260421/001', desc: 'AIRTIME RECHARGE — MTN',       isDebit: true,  amount: 500_000    },
        { date: '2026-04-22', ref: 'NIP/INWD/260422/001',  desc: 'TRANSFER FROM UBA BANK',            isDebit: false, amount: 10_000_000 },
        { date: '2026-04-24', ref: 'POS/DMNZ/260424/001',  desc: 'DOMINOS PIZZA VI',                  isDebit: true,  amount: 725_000    },
        { date: '2026-04-28', ref: 'NIP/O3CTB/260428/001', desc: 'TRANSFER TO ACCESS BANK',           isDebit: true,  amount: 8_000_000  },
        { date: '2026-04-30', ref: 'CHG/O3CTB/260430/001', desc: 'MONTHLY MAINTENANCE FEE',           isDebit: true,  amount: 50_000     },
        { date: '2026-05-02', ref: 'POS/TOTL/260502/001',  desc: 'TOTAL ENERGIES VI',                 isDebit: true,  amount: 1_500_000  },
        { date: '2026-05-05', ref: 'NIP/INWD/260505/001',  desc: 'SALARY PAYMENT — O3 CAPITAL',  isDebit: false, amount: 35_000_000 },
        { date: '2026-05-07', ref: 'NIP/O3CTB/260507/001', desc: 'TRANSFER TO KUDA BANK',             isDebit: true,  amount: 5_000_000  },
        { date: '2026-05-09', ref: 'WEB/O3CTB/260509/001', desc: 'ELECTRICITY BILL — IKEDC',     isDebit: true,  amount: 1_850_000  },
        { date: '2026-05-12', ref: 'POS/IKJM/260512/001',  desc: 'IKEJA CITY MALL',                   isDebit: true,  amount: 2_200_000  },
        { date: '2026-05-14', ref: 'NIP/O3CTB/260514/001', desc: 'TRANSFER TO FIRST BANK',            isDebit: true,  amount: 4_000_000  },
      ]
      const openBal = 24_580_000 // kobo = ₦245,800.00

      let bal = openBal
      const rows = txns.map(t => {
        if (t.isDebit) bal -= t.amount; else bal += t.amount
        const badge   = t.isDebit ? '<span class="bdr dr">DR</span>' : '<span class="bdr cr">CR</span>'
        const amtCell = t.isDebit
          ? `<td class="am dr">${fmt(t.amount/100)}</td><td class="am em">&mdash;</td>`
          : `<td class="am em">&mdash;</td><td class="am cr">${fmt(t.amount/100)}</td>`
        return `<tr><td class="dt">${fmtD(t.date)}</td><td class="rf">${t.ref}</td><td class="ds">${t.desc}${badge}</td>${amtCell}<td class="bal">${fmt(bal/100)}</td></tr>`
      }).join('')

      const totalDebits  = txns.filter(t => t.isDebit).reduce((s,t) => s+t.amount, 0)
      const totalCredits = txns.filter(t => !t.isDebit).reduce((s,t) => s+t.amount, 0)
      const closingBal   = bal

      html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>O3 Capital — Account Statement</title>
<style>${CSS}.sum{grid-template-columns:repeat(4,1fr)}</style></head>
<body>${HEADER}
<div class="tb"><h1>Account Statement</h1><div class="meta">Period: ${fmtD(dfrom)} to ${fmtD(dto)}<br>Generated: ${genTime}<br><span class="sref">${stmtRef}</span></div></div>
<div class="info">
  <div><div class="cname">TEMITOPE BABATUNDE</div><div class="il">Victoria Island, Lagos</div><span class="lbl">CIF Number</span><div class="il">${cif}</div><span class="lbl">Email</span><div class="il">babatundeopemiposi@gmail.com</div></div>
  <div class="ar">
    <span class="lbl">Account Number</span><div class="il" style="font-family:'Courier New',monospace;font-weight:600;letter-spacing:.5px">0123456789</div>
    <span class="lbl">Account Name</span><div class="il" style="font-weight:600">TEMITOPE BABATUNDE</div>
    <span class="lbl">Product</span><div class="il">O3 Cards Savings Account</div>
    <span class="lbl">Currency</span><div class="il">Nigerian Naira (NGN)</div>
    <span class="lbl">Status</span><div><span class="actbadge">Active</span></div>
  </div>
</div>
<div class="sum">
  <div class="sc"><div class="sc-lbl">Opening Balance</div><div class="sc-val">${fmt(openBal/100)}</div></div>
  <div class="sc red"><div class="sc-lbl">Total Debits</div><div class="sc-val">${fmt(totalDebits/100)}</div></div>
  <div class="sc grn"><div class="sc-lbl">Total Credits</div><div class="sc-val">${fmt(totalCredits/100)}</div></div>
  <div class="sc nv"><div class="sc-lbl">Closing Balance</div><div class="sc-val">${fmt(closingBal/100)}</div></div>
</div>
<div class="th"><span class="th-lbl">Transactions</span><span class="th-ct">${txns.length} transactions in period</span></div>
<table>
  <thead><tr><th>Date</th><th>Reference</th><th>Description</th><th class="r">Debit (&#8358;)</th><th class="r">Credit (&#8358;)</th><th class="r">Balance (&#8358;)</th></tr></thead>
  <tbody>
    <tr class="op"><td class="dt">${fmtD(dfrom)}</td><td class="rf"></td><td class="ds">Opening Balance</td><td class="am em">&mdash;</td><td class="am em">&mdash;</td><td class="bal">${fmt(openBal/100)}</td></tr>
    ${rows}
    <tr class="tot"><td colspan="3">Period Totals</td><td class="am dr">${fmt(totalDebits/100)}</td><td class="am cr">${fmt(totalCredits/100)}</td><td class="bal">Closing: ${fmt(closingBal/100)}</td></tr>
  </tbody>
</table>
${FOOTER}</body></html>`
    }

    return new HttpResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }),
  http.post(u('/api/statements/send'), () => ok({ status: 'queued', count: 1 })),
  http.post(u('/api/statements/bulk-send'), ({ request }) =>
    request.json().then((body: any) =>
      body?.dry_run
        ? ok({ count: 1247, eligible: 1310, sample: [
            { cif_number: 'CIF000100', name: 'Aisha Musa',   email: 'aisha.musa@example.ng'   },
            { cif_number: 'CIF000101', name: 'Emeka Obi',    email: 'emeka.obi@example.ng'    },
            { cif_number: 'CIF000102', name: 'Bola James',   email: 'bola.james@example.ng'   },
            { cif_number: 'CIF000103', name: 'Yemi Adeyemi', email: 'yemi.adeyemi@example.ng' },
            { cif_number: 'CIF000104', name: 'Chinwe Nwosu', email: 'chinwe.nwosu@example.ng' },
          ] })
        : ok({ total: 1247, eligible: 1310, status: 'queued' })
    )
  ),
  http.post(u('/api/statements/runs/:id/pause'),  () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/statements/runs/:id/resume'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/statements/runs/:id/retry'),  () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/statements/runs/:id/cancel'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/statements/emails'), () => ok(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1, cif_number: `CIF${String(1000+i).padStart(6,'0')}`,
      customer_name: pick(['Aisha Musa','Emeka Obi','Bola James','Yemi Adeyemi','Chinwe Nwosu','Tunde Bello']),
      recipient_email: `customer${i+1}@example.com`,
      date_from: isoDate(35), date_to: isoDate(5),
      subject: 'Account Statement — June 2026',
      status: pick(['delivered','delivered','delivered','opened','bounced']),
      delivered_at: isoDate(rng(1,5)), sent_by_name: pick(['System','Amaka Obi','Tunde Bello']),
      created_at: isoDate(rng(1,10)),
    }))
  )),

  // Customer 360
  http.get(u('/api/customer360/search'), () => ok({
    data: Array.from({ length: 3 }, (_, i) => {
      const n = name()
      return {
        id: i+1, cif: `CIF${String(i+100000).padStart(7,'0')}`,
        name: n, full_name: n,
        phone: `080${rng(10000000,99999999)}`,
        email: `customer${i}@example.ng`, status: 'active',
      }
    }),
  })),
  http.get(u('/api/customer360'), () => ok({ data: [], total: 0 })),
  http.get(u('/api/customer360/:id'), ({ params }) => ok({
    id: params.id, cif: `CIF${params.id}000`, full_name: name(),
    phone: `080${rng(10000000,99999999)}`, email: `customer${params.id}@example.ng`,
    bvn: `22${rng(100000000,999999999)}`, nin: `NIN${rng(10000000000,99999999999)}`,
    status: 'active', state: pick(STATES), address: `${rng(1,100)} ${pick(STATES)} Street`,
    employer: pick(['Shell Nigeria','MTN','Dangote']), monthly_income_kobo: rng(30,120)*1_000_000_00,
    loans: [], cards: [], transactions: [],
  })),
]

// ── BI / Report Builder ───────────────────────────────────────────────────────

const BI_REPORTS_DATA = Array.from({ length: 6 }, (_, i) => ({
  id: i+1,
  name: ['Loan Book Summary','PAR Trend Report','Collections Performance','Fee Income Breakdown','HR Headcount','Disbursements MTD'][i],
  description: pick([null, 'Monthly snapshot of portfolio health', 'Revenue analysis by fee type']),
  module: ['los','risk','collections','finance','hr','los'][i],
  date_range: pick(['mtd','last_30','last_90','ytd']),
  is_public: i < 3,
  run_count: rng(1,50),
  last_run_at: pick([isoDate(rng(0,14)), null]),
  created_at: isoDate(rng(10,90)),
  created_by_name: name(),
}))

const BI = [
  http.get(u('/api/bi/reports'),  () => ok(BI_REPORTS_DATA)),
  http.post(u('/api/bi/reports'), () => ok({ id: 99 })),
  http.put(u('/api/bi/reports/:id'),    () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/bi/reports/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/bi/reports/:id/run'), () => ok({
    rows: Array.from({ length: 15 }, (_, i) => ({
      month: MONTHS_ISO[i % 7] ?? MONTHS_ISO[0], value: rng(50, 5000), count: rng(10, 500),
    })),
  })),
  http.post(u('/api/bi/reports/:id/schedule'), () => ok({ id: 99 })),
  http.get(u('/api/bi/runs'), () => ok(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, report_id: rng(1,6), report_name: pick(['Loan Book Summary','PAR Trend Report','Collections Performance']),
      status: pick(['completed','completed','completed','failed']),
      row_count: pick([rng(50,5000), null]), error_message: null,
      started_at: isoDate(rng(0,14)), finished_at: isoDate(rng(0,14)), run_by_name: name(),
    }))
  )),
  http.get(u('/api/bi/scheduled'), () => ok(
    Array.from({ length: 4 }, (_, i) => ({
      id: i+1, report_id: i+1, report_name: BI_REPORTS_DATA[i]?.name ?? 'Report',
      module: ['los','risk','collections','finance'][i],
      cron_expr: pick(['0 8 1 * *','0 7 * * 1','0 9 * * *']),
      recipients: [`user${i}@o3capital.com`],
      format: pick(['pdf','excel','csv']), is_active: Math.random() > 0.2,
      last_run_at: pick([isoDate(rng(0,30)), null]),
      next_run_at: isoDate(-rng(1,7)), created_at: isoDate(rng(10,60)), created_by_name: name(),
    }))
  )),
  http.delete(u('/api/bi/scheduled/:id'), () => new HttpResponse(null, { status: 204 })),
]

// ── Admin — Integrations ──────────────────────────────────────────────────────

const ADMIN_EXTRA = [
  http.get(u('/api/admin/integrations'), () => ok([
    { id:1, name:'Paystack', type:'payment_gateway', status:'active', health_url:'https://api.paystack.co', last_ping: isoDate(0), last_status_code: 200, key_expiry: dateStr(-60), owner:'Finance', notes:'' },
    { id:2, name:'Interswitch', type:'payment_gateway', status:'degraded', health_url:'https://passport.interswitch.com', last_ping: isoDate(0), last_status_code: 503, key_expiry: null, owner:'Finance', notes:'Intermittent issues' },
    { id:3, name:'SendGrid', type:'email', status:'active', health_url:'https://api.sendgrid.com', last_ping: isoDate(0), last_status_code: 200, key_expiry: null, owner:'IT', notes:'' },
    { id:4, name:'Zoho Desk', type:'crm', status:'active', health_url:'https://desk.zoho.com', last_ping: isoDate(0), last_status_code: 200, key_expiry: dateStr(-30), owner:'Customer Service', notes:'' },
    { id:5, name:'Cloudflare Tunnel', type:'network', status:'active', health_url:'', last_ping: isoDate(0), last_status_code: 200, key_expiry: null, owner:'IT', notes:'MSSQL bridge' },
  ])),
  http.post(u('/api/admin/integrations'), () => ok({ id: 99 })),
  http.post(u('/api/admin/integrations/:id/test'), () => ok({ status: 'ok', status_code: 200, note: 'Connection successful' })),
  http.post(u('/api/helpdesk/routing-rules'), () => ok({ id: 99 })),
  http.put(u('/api/helpdesk/routing-rules/:id'), () => new HttpResponse(null, { status: 204 })),
]

// ── Collections-ops — Agent Dashboard ────────────────────────────────────────

const COLLECTIONS_EXTRA = [
  http.get(u('/api/collections-ops/agent-dashboard'), () => wd(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1,
      full_name: name(),
      assigned: rng(15,60),
      contacts_today: rng(0,20),
      ptps_today: rng(0,8),
      ptps_honoured_today: rng(0,5),
      portfolio_kobo: rng(20,120)*1_000_000_00,
    }))
  )),
  http.post(u('/api/collections-ops/log-call'), () => new HttpResponse(null, { status: 204 })),
]

// ── Compliance — New Pages ────────────────────────────────────────────────────

const COMPLIANCE_EXTRA = [
  http.get(u('/api/compliance/concentration-risk'), () => ok({
    total_loan_book_kobo: 4_820_000_000_00,
    cbn_single_obligor_limit_pct: 20,
    top_obligors: Array.from({ length: 8 }, (_, i) => ({
      obligor: `CIF${String(i+100000).padStart(7,'0')}`,
      name: pick(['Shell Nigeria','MTN Nigeria','Dangote Group','Access Bank','NNPC','NLNG','Flour Mills','Nestlé']),
      exposure_kobo: rng(20,250)*1_000_000_00, exposure_pct: rng(1,15), loan_count: rng(1,5),
    })),
    by_loan_type: [
      { loan_type:'Payday Loan',   exposure_kobo: 1_840_000_000_00, exposure_pct: 38.2, count: 1842 },
      { loan_type:'Salary Advance',exposure_kobo: 1_200_000_000_00, exposure_pct: 24.9, count: 984  },
      { loan_type:'Business Loan', exposure_kobo: 980_000_000_00,   exposure_pct: 20.3, count: 312  },
      { loan_type:'Education Loan',exposure_kobo: 480_000_000_00,   exposure_pct: 10.0, count: 240  },
      { loan_type:'Auto Loan',     exposure_kobo: 320_000_000_00,   exposure_pct: 6.6,  count: 84   },
    ],
    by_employer: Array.from({ length: 8 }, () => ({
      employer: pick(['Shell Nigeria','MTN','Dangote','NNPC','Access Bank','FirstBank','NLNG','Flour Mills']),
      exposure_kobo: rng(50,500)*1_000_000_00, exposure_pct: rng(1,12), borrower_count: rng(10,200),
    })),
  })),
  http.get(u('/api/compliance/dpa-register'), () => ok(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, processing_name: pick(['Loan Application Processing','Credit Bureau Query','Staff Payroll','Customer KYC','Marketing SMS']),
      purpose: pick(['Loan origination','Credit assessment','Payroll management','Identity verification']),
      legal_basis: pick(['Consent','Legitimate Interest','Legal Obligation','Contract Performance']),
      data_categories: pick([['Name','BVN','NIN'],['Phone','Email'],['Bank Details','Salary']]),
      data_subjects: pick(['Loan customers','Employees','Card holders']),
      recipients: pick(['Credit Bureau','Regulators','Payment Processors', null]),
      third_country_transfers: Math.random() < 0.2,
      retention_period: pick(['7 years','5 years','Until account closure']),
      security_measures: 'AES-256 encryption, access control', created_at: isoDate(rng(10,180)),
    }))
  )),
  http.post(u('/api/compliance/dpa-register'), () => ok({ id: 99 })),
  http.delete(u('/api/compliance/dpa-register/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/compliance/data-subject-requests'), () => ok(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1,
      subject_cif: `CIF${String(i+100000).padStart(7,'0')}`, subject_name: name(),
      subject_email: `subject${i}@example.ng`,
      request_type: pick(['access','erasure','rectification','portability','objection']),
      status: pick(['pending','in_progress','resolved']),
      notes: null, assigned_to_name: name(),
      created_at: isoDate(rng(0,30)), resolved_at: pick([isoDate(rng(0,5)), null]),
    }))
  )),
  http.post(u('/api/compliance/data-subject-requests'), () => ok({ id: 99 })),
  http.delete(u('/api/compliance/data-subject-requests/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/compliance/pentests'), () => ok({ data: Array.from({ length: 5 }, (_, i) => ({
    id: i+1, title: `${['Web App Pentest','API Security Assessment','Infrastructure Audit','Mobile App Test','Social Engineering'][i]} 2026`,
    vendor_name: pick(['SecureWorks NG','CyberShield Africa','Qualys','NCC Group']),
    engagement_type: pick(['black_box','grey_box','white_box']),
    start_date: dateStr(rng(-60,0)), end_date: dateStr(rng(0,30)),
    status: pick(['active','completed','scheduled','report_received']),
    scope_notes: 'In scope: production environment', rules_of_engagement: 'No DoS',
    report_url: null, report_received_at: pick([isoDate(rng(0,20)), null]),
    retest_deadline: pick([dateStr(rng(0,60)), null]), retest_completed_at: null,
    engagement_cost_kobo: pick([5_000_000_00, 12_000_000_00, null]),
    created_by_name: name(),
  }))})),
  http.post(u('/api/compliance/pentests'), () => ok({ id: 99 })),
  http.put(u('/api/compliance/pentests/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/compliance/pentest-findings'), () => ok({ data: Array.from({ length: 14 }, (_, i) => ({
    id: i+1, engagement_id: rng(1,5),
    engagement_title: 'Web App Pentest 2026', vendor_name: 'SecureWorks NG',
    finding_ref: `PENTEST-2026-${String(i+1).padStart(3,'0')}`,
    title: pick(['SQL Injection in loan API','Missing rate limiting','Insecure CORS policy','Weak session tokens','Open redirect','Missing HSTS','Verbose error messages']),
    severity: pick(['critical','high','high','medium','low']),
    cvss_score: pick([9.8,8.1,7.2,5.5,3.2,null]),
    affected_component: pick(['api/auth','api/los','frontend','admin panel']),
    description: 'Detailed technical description of the vulnerability.',
    business_impact: 'Could allow unauthorized access to customer data.',
    recommendation: 'Apply parameterized queries and input validation.',
    status: pick(['open','in_progress','resolved','risk_accepted']),
    assigned_to_name: name(),
    sla_deadline: dateStr(rng(-5,30)), created_at: isoDate(rng(1,60)),
  }))})),
  http.put(u('/api/compliance/pentest-findings/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/compliance/pentest-findings/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/compliance/prudential-ratios'), () => ok({
    npl_kobo: 67_500_000_00, total_loan_book_kobo: 4_820_000_000_00,
    npl_ratio_pct: 1.4, par30_pct: 5.0, par60_pct: 2.0, par90_pct: 0.9,
    total_fd_liabilities_kobo: 1_240_000_000_00,
    total_disbursed_kobo: 6_240_000_000_00, active_loans: 4218,
    cbn_thresholds: { npl_max_pct: 5.0, single_obligor_pct: 20, liquidity_ratio_min: 30 },
  })),

  http.get(u('/api/compliance/soc2/overview'), () => ok({ data: {
    by_criteria: [
      { trust_criteria:'Security',       total: 42, done: 38 },
      { trust_criteria:'Availability',   total: 18, done: 14 },
      { trust_criteria:'Confidentiality',total: 12, done: 10 },
      { trust_criteria:'Processing Integrity', total: 8, done: 6 },
      { trust_criteria:'Privacy',        total: 10, done: 7 },
    ],
    totals: { trust_criteria: 'All', total: 90, done: 75 },
    policies: { total: 24, approved: 18, pending: 6 },
    findings: { open_critical: 2, open_high: 5, overdue: 3 },
  }})),
  http.get(u('/api/compliance/soc2/controls'), () => ok({ data: Array.from({ length: 20 }, (_, i) => ({
    id: i+1,
    criteria_code: ['CC1','CC2','CC3','CC6','CC7','A1','C1','PI1','P1'][i % 9],
    criteria_group: pick(['CC','A','C','PI','P']),
    trust_criteria: pick(['Security','Availability','Confidentiality','Processing Integrity','Privacy']),
    title: pick(['Access Control Policy','Change Management','Incident Response','Encryption at Rest','Penetration Testing']),
    description: 'Control ensures adequate safeguards are in place.',
    status: pick(['implemented','in_progress','not_started','not_applicable']),
    control_type: pick(['preventive','detective','corrective']),
    frequency: pick(['continuous','monthly','quarterly','annual']),
    owner_name: pick([name(), null]),
  }))})),
  http.post(u('/api/compliance/soc2/controls'), () => ok({ id: rng(100,999) })),
  http.put(u('/api/compliance/soc2/controls'), () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/compliance/soc2/controls/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/compliance/soc2/policies'), () => ok({ data: Array.from({ length: 12 }, (_, i) => ({
    id: i+1,
    name: pick(['Information Security Policy','Access Control Policy','Incident Response Plan','Business Continuity Plan','Data Retention Policy','Acceptable Use Policy']),
    category: pick(['Security','Operational','Privacy','Compliance']),
    status: pick(['approved','approved','draft','pending_review']),
    owner_id: rng(1,10), owner_name: name(),
    approved_by: rng(1,5), approved_by_name: name(),
    approved_at: pick([isoDate(rng(30,180)), null]),
    next_review_date: pick([dateStr(rng(-10,180)), null]),
  }))})),
  http.put(u('/api/compliance/soc2/policies/:id'), () => new HttpResponse(null, { status: 204 })),
]


// ── Sales — New Endpoints ─────────────────────────────────────────────────────

const SALES_EXTRA = [
  http.get(u('/api/sales/targets'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, user_id: i+1, full_name: name(), email: `officer${i}@o3capital.com`,
      period: '2026-07',
      loan_count: rng(20,60), disbursement_kobo: rng(50,200)*1_000_000_00, notes: '',
    }))
  )),
  http.post(u('/api/sales/targets'), () => ok({ id: 99 })),
  http.get(u('/api/sales/targets/actuals'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      user_id: i+1, full_name: name(),
      target_loans: rng(20,60), target_kobo: rng(50,200)*1_000_000_00,
      actual_loans: rng(10,55), actual_kobo: rng(30,190)*1_000_000_00,
    }))
  )),
  http.get(u('/api/sales/by-lead-source'), () => ok([
    { lead_source:'Referral',    total_applications: 420, approved: 310, disbursement_kobo: 620_000_000_00 },
    { lead_source:'Walk-in',     total_applications: 312, approved: 214, disbursement_kobo: 428_000_000_00 },
    { lead_source:'Online',      total_applications: 280, approved: 184, disbursement_kobo: 368_000_000_00 },
    { lead_source:'Campaign',    total_applications: 198, approved: 124, disbursement_kobo: 248_000_000_00 },
    { lead_source:'BD',          total_applications: 142, approved:  98, disbursement_kobo: 196_000_000_00 },
    { lead_source:'Telemarketing',total_applications: 88, approved:  52, disbursement_kobo: 104_000_000_00 },
  ])),
  http.get(u('/api/sales/campaign-attribution'), () => ok(
    Array.from({ length: 6 }, (_, i) => ({
      campaign_id: i+1,
      campaign_name: pick(['June Loan Drive','Salary Earner Push','Card Upgrade Campaign','Q3 Retention','Payroll Advance Push','New Customer Drive']),
      campaign_type: pick(['email','sms','multi']),
      contacts_reached: rng(500,5000), applications: rng(50,500),
      loans_disbursed: rng(20,300), disbursement_kobo: rng(40,600)*1_000_000_00,
    }))
  )),
]

// ── Reports — Extra Mutations ─────────────────────────────────────────────────

const REPORTS_EXTRA = [
  http.post(u('/api/reports/export'),    () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/reports/saved'),     () => ok({ id: 99 })),
  http.post(u('/api/reports/schedules'), () => ok({ id: 99 })),
]

// ── Dialer — Extra ────────────────────────────────────────────────────────────

const DIALER_EXTRA = [
  http.get(u('/api/dialer/live'), () => ok(
    Array.from({ length: 2 }, (_, i) => ({
      id: i+1, name: `Live Campaign ${i+1}`, status: 'active',
      dial_ratio: pick([1.2, 1.5, 2.0]), agents_ready: rng(2,6), agents_on_call: rng(1,4),
      calls_in_flight: rng(1,8), queue_pending: rng(20,120),
    }))
  )),
  http.post(u('/api/dialer/campaigns/:id/start'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/dialer/campaigns/:id/pause'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/dialer/campaigns/:id/stop'),  () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/dialer/sessions/status'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/dialer/calls/:id/disposition'), () => new HttpResponse(null, { status: 204 })),
]

// ── Telemarketing — Extra ─────────────────────────────────────────────────────

const TELEMARKETING_EXTRA = [
  http.get(u('/api/telemarketing/contacts/:id/calls'), () => ok({ data: Array.from({ length: 5 }, (_, i) => ({
    id: i+1, contacted_at: isoDate(rng(0,14)),
    outcome: pick(['reached','not_reached','ptp','broken_ptp']),
    notes: pick(['Called twice, no answer','Promised to pay Friday','Wrong number']),
    duration_seconds: pick([null, rng(60,600)]),
    officer_name: name(),
  }))})),
  http.post(u('/api/telemarketing/contacts/:id/log-call'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/telemarketing/queue/export'), () => new HttpResponse(null, { status: 204 })),
]

// ── Marketing — Extra ─────────────────────────────────────────────────────────

const MARKETING_EXTRA = [
  http.get(u('/api/los/overview'), () => ok({
    by_stage: LOS_STAGES.map(s => ({ stage: s, count: rng(4,30) })),
  })),
]

// ── User Preferences & Misc ───────────────────────────────────────────────────

const USER_MISC = [
  http.get(u('/api/user/notification-preferences'), () => ok([
    { event_type:'loan_approved',     channel:'email', label:'Loan Approved',         description:'When a loan application is approved',   user_enabled: true,  has_override: false },
    { event_type:'loan_approved',     channel:'push',  label:'Loan Approved',         description:'Push notification when loan approved',   user_enabled: true,  has_override: false },
    { event_type:'ptp_broken',        channel:'email', label:'PTP Broken',            description:'When a promise to pay is broken',        user_enabled: true,  has_override: true  },
    { event_type:'sla_breach',        channel:'email', label:'SLA Breach',            description:'When a ticket breaches SLA',             user_enabled: true,  has_override: false },
    { event_type:'settlement_failed', channel:'email', label:'Settlement Failed',     description:'When a settlement transaction fails',    user_enabled: false, has_override: false },
    { event_type:'par_threshold',     channel:'email', label:'PAR Threshold Crossed', description:'When PAR crosses configured threshold',  user_enabled: true,  has_override: false },
  ])),
  http.put(u('/api/user/notification-preferences'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/zoho/voice/call'), () => ok({ call_id: 'mock_call_001', status: 'initiated' })),
]

// ── Unified Contact Profile ───────────────────────────────────────────────────

const CONTACTS_EXTRA = [
  // Aggregated contact profile (all lifecycle data in one call)
  http.get(u('/api/contacts/:cif'), ({ params }) => {
    const cif = String(params.cif)
    const n = name()
    const dpd = pick([0, 0, 15, 45, 92])
    const hasLoan = Math.random() > 0.2
    const hasCard = Math.random() > 0.4
    const hasDelinquent = dpd > 0
    const hasRecovery = dpd >= 90
    const hasApp = Math.random() > 0.4

    return ok({
      cif,
      name: n,
      phone: `080${rng(10000000,99999999)}`,
      email: `${n.toLowerCase().replace(' ','.')}@example.ng`,
      bvn: `22${rng(100000000,999999999)}`,
      nin: `NIN${rng(10000000000,99999999999)}`,
      address: `${rng(1,100)} ${pick(STATES)} Close, ${pick(STATES)}`,
      state: pick(STATES),
      employer: pick(['MTN Nigeria','Shell Nigeria','Dangote Group','NNPC','First Bank','GTBank','Zenith Bank']),
      monthly_income_kobo: rng(15,80) * 1_000_000_00,
      date_of_birth: dateStr(rng(8000,15000)),
      gender: pick(['Male','Female']),

      is_prospect: Math.random() > 0.5,
      is_applicant: hasApp,
      is_active_customer: hasLoan,
      is_card_holder: hasCard,
      is_delinquent: hasDelinquent,
      is_in_recovery: hasRecovery,
      is_written_off: false,

      crm: {
        contact_id: rng(1,100),
        status: pick(['prospect','qualified','customer']),
        assigned_to: name(),
        created_at: isoDate(rng(30,180)),
        deals: hasApp ? [{ id: 1, title: `${pick(['Salary Loan','Business Loan'])} — ${n}`, value_kobo: rng(20,150)*1_000_000_00, stage: pick(['Proposal','Negotiation','Closed Won']) }] : [],
        activities: Array.from({ length: 3 }, (_, i) => ({
          id: i+1, type: pick(['call','email','meeting']),
          note: pick(['Discussed loan requirements','Sent proposal','Completed KYC','Follow-up scheduled']),
          created_at: isoDate(rng(1,30)),
          user: name(),
        })),
      },

      applications: hasApp ? Array.from({ length: rng(1,2) }, (_, i) => ({
        id: i+100, ref: `APP${rng(10000,99999)}`,
        product_type: pick(LOS_PRODUCTS),
        amount_requested_kobo: rng(10,200)*1_000_000_00,
        stage: pick(LOS_STAGES), created_at: isoDate(rng(0,60)),
      })) : [],

      active_loans: hasLoan ? [
        { id: rng(1,9999), ref: `LN${rng(100000,999999)}`,
          product_type: pick(LOS_PRODUCTS),
          outstanding_kobo: rng(10,200)*1_000_000_00,
          disbursed_kobo:   rng(20,300)*1_000_000_00,
          dpd, status: dpd > 0 ? 'delinquent' : 'active',
          next_payment_date: dateStr(-rng(1,30)),
        },
      ] : [],

      cards: hasCard ? [
        { id: rng(1,999), card_number_masked: `****${rng(1000,9999)}`,
          scheme: pick(['Visa','Mastercard','Verve']),
          status: pick(['active','active','blocked']),
          balance_kobo: rng(0,500)*1_000_000_00,
          issued_at: isoDate(rng(90,730)),
        },
      ] : [],

      collections: hasDelinquent ? {
        dpd, dpd_bucket: dpd >= 90 ? '90+' : dpd >= 60 ? '61-90' : dpd >= 30 ? '31-60' : '1-30',
        outstanding_kobo: rng(10,200)*1_000_000_00,
        last_contact_at: pick([isoDate(rng(1,14)), null]),
        agent_name: pick([name(), null]),
        ptp_date: pick([dateStr(-rng(1,14)), null]),
        current_stage: pick(['field_collection','legal_notice','out_of_court',null]),
      } : undefined,

      recovery_case: hasRecovery ? {
        id: rng(1,999), case_ref: `RC${rng(10000,99999)}`,
        status: pick(['open','legal','settlement']),
        outstanding_kobo: rng(50,300)*1_000_000_00,
        recovered_kobo:   rng(5,50)*1_000_000_00,
        write_off_amount_kobo: 0,
        legal_stage: pick([null, 'demand_letter','court_filing','judgment']),
        agent_name: pick([name(), null]),
        opened_at: isoDate(rng(30,180)),
      } : undefined,

      helpdesk_tickets: Array.from({ length: rng(0,3) }, (_, i) => ({
        id: i+200, ticket_ref: `TKT${rng(10000,99999)}`,
        subject: pick(['Card declined','Loan repayment query','Account statement request','KYC update','Balance enquiry']),
        status: pick(['open','in_progress','resolved','closed']),
        priority: pick(['low','medium','high']),
        created_at: isoDate(rng(1,90)),
      })),

      activity_log: Array.from({ length: 6 }, (_, i) => ({
        id: i+1,
        type: pick(['call','note','status_change','payment','application']),
        description: pick([
          'Loan application submitted', 'KYC documents verified', 'Payment recorded',
          'Collections call logged — reached', 'Promise to pay set', 'Ticket raised — balance query',
          'Card issued', 'Account activated', 'DPD bucket updated to 31-60',
        ]),
        created_by: name(),
        created_at: isoDate(rng(0,90)),
        module: pick(['crm','los','collections','helpdesk','cards','recovery']),
      })).sort((a,b) => b.created_at.localeCompare(a.created_at)),
    })
  }),

  // CRM contact 360 — used by existing ContactDetail page
  http.get(u('/api/crm/contacts/:id/360'), ({ params }) => {
    const n = name()
    const [fn, ln] = n.split(' ')
    return ok({
      contact: {
        id: Number(params.id),
        first_name: fn ?? 'Adaeze',
        last_name:  ln ?? 'Okonkwo',
        phone:  `080${rng(10000000, 99999999)}`,
        email:  `${(fn ?? 'a').toLowerCase()}.${(ln ?? 'o').toLowerCase()}@example.ng`,
        state:  pick(['Lagos','Abuja','Rivers','Kano','Ogun']),
        city:   pick(['Victoria Island','Garki','Port Harcourt','Kano City','Sagamu']),
        address: pick(['12 Broad Street', '4 Adetokunbo Ademola', '8 Rumuola Road', null]),
        gender:       pick(['male','female']),
        occupation:   pick(['Civil Servant','Banker','Teacher','Entrepreneur','Engineer']),
        employer:     pick(['MTN Nigeria','Dangote Group','Shell Nigeria','FirstBank','NNPC',null]),
        income_range: pick(['100k–250k','250k–500k','500k–1M','1M+']),
        id_type:      pick(['NIN','BVN','Passport','Drivers License']),
        source:       pick(['referral','walk-in','bd_campaign','online']),
        cif_number:   rng(1,2) === 1 ? `000${rng(10000,99999)}` : null,
        status:       pick(['prospect','qualified','customer','inactive']),
        tags:         pick(['salary_earner','repeat_customer','high_value',null]),
        notes:        pick(['Interested in salary loan product','Already has an active loan','Needs follow-up on docs',null]),
        assigned_name:   name(),
        created_by_name: name(),
        created_at: isoDate(rng(30, 365)),
        updated_at: isoDate(rng(0, 14)),
      },
      deals: Array.from({ length: rng(1, 3) }, (_, i) => ({
        id: i + 1,
        title:  `${pick(['Salary Advance','Business Loan','Credit Card','Overdraft Facility'])} — ${fn}`,
        value_kobo:  rng(5, 150) * 1_000_000_00,
        probability: pick([20, 40, 60, 75, 90]),
        stage_name:  pick(['Prospecting','Proposal Sent','Negotiation','Won']),
        stage_color: pick(['#6B7280','#3B82F6','#F59E0B','#22C55E']),
        assigned_name: name(),
        expected_close_date: dateStr(rng(-10, 30)),
        status: pick(['open','won','lost']),
        updated_at: isoDate(rng(0, 14)),
      })),
      activities: Array.from({ length: rng(3, 6) }, (_, i) => ({
        id: i + 1,
        type:    pick(['call','email','meeting','note','sms']),
        subject: pick(['Follow-up call','Loan offer email','Product presentation','KYC reminder','Welcome call']),
        body:    pick(['Discussed loan terms','Sent offer letter','Met at HQ to review documents','Requested NIN and BVN','Introduced salary loan product']),
        outcome: pick(['interested','not_interested','needs_follow_up','converted',null]),
        completed: i < 3,
        duration_mins: pick([5, 10, 20, 30, null]),
        next_follow_up: i === 0 ? dateStr(rng(1, 14)) : null,
        agent_name: name(),
        created_at: isoDate(rng(i, i + 15)),
      })),
      tasks: Array.from({ length: rng(1, 3) }, (_, i) => ({
        id: i + 1,
        title:    pick(['Send loan offer letter','Follow up on submitted docs','Schedule credit assessment','Book site visit','Confirm employment details']),
        due_date: dateStr(rng(-2, 14)),
        priority: pick(['low','normal','high','urgent']),
        status:   pick(['pending','in_progress','completed']),
        assigned_name: name(),
      })),
    })
  }),
  http.post(u('/api/crm/activities'), () => new HttpResponse(null, { status: 204 })),

  // CRM accounts (My Accounts page)
  http.get(u('/api/crm/accounts'), () => ok({
    data: Array.from({ length: 30 }, (_, i) => {
      const fn = pick(['Emeka','Fatima','Adunola','Taiwo','Ngozi','Blessing','Kemi','Chidi','Amina','David','Tunde','Yetunde','Musa','Grace','Solomon'])
      const ln = pick(['Obi','Musa','Bello','Ade','Eze','Okafor','Mensah','Okeke','Abubakar','Johnson','Nwachukwu','Adeyemi','Ojo','Ibrahim','Okonkwo'])
      const dpd = [0,0,0,0,0,0,5,15,31,62,91,0,0,3,45,0,0,7,0,0,0,0,8,0,0,90,35,0,0,2][i]
      return {
        id: i + 1,
        first_name: fn, last_name: ln,
        phone:  `080${rng(10000000, 99999999)}`,
        email:  `${fn.toLowerCase()}.${ln.toLowerCase()}@example.ng`,
        cif_number:   `000${String(27000 + i).padStart(5, '0')}`,
        source:       pick(['referral','bd_campaign','walk-in','online']),
        source_type:  pick(['bd_assigned','direct','campaign']),
        employer_name: pick(['Shell Nigeria','MTN','Dangote','First Bank','NNPC','Unilever',null]),
        account_manager_id:   (i % 5) + 10,
        account_manager_name: ['Adebayo Okon','Funmi Adesanya','Emeka Eze','Tolu Bello','Ngozi Okafor'][i % 5],
        updated_at:   isoDate(rng(0, 14)),
        created_at:   isoDate(rng(30, 365)),
        loan_count:   rng(1, 5),
        active_loans: rng(0, 2),
        outstanding_kobo: rng(5, 80) * 1_000_000_00,
        max_dpd:      dpd,
        open_deals:   rng(0, 3),
        activity_count: rng(2, 20),
      }
    }),
  })),
]

// ── Campaigns — missing endpoints ────────────────────────────────────────────
// Note: /api/campaigns/preflight must come before /api/campaigns/:id so that
// the static segment beats the parameterized one.

const CAMPAIGNS_DETAIL = [
  http.get(u('/api/campaigns/preflight'), ({ request }) => {
    const url = new URL(request.url)
    const listId = url.searchParams.get('list_id')
    const total = listId ? rng(1200, 5000) : 0
    const suppressed = Math.floor(total * 0.03)
    const duplicates  = Math.floor(total * 0.008)
    const invalid     = Math.floor(total * 0.015)
    const usable      = Math.max(0, total - suppressed - duplicates - invalid)
    return ok({
      total, usable, suppressed, duplicates, invalid,
      with_email: Math.floor(usable * 0.88),
      with_phone: usable,
      warnings: listId ? [] : ['No contact list selected — select a list before starting'],
    })
  }),
  http.get(u('/api/campaigns/:id'), ({ params }) => {
    const i = (Number(params.id) - 1) % CAMPAIGNS_LIST.length
    const base = CAMPAIGNS_LIST[Math.max(0, i)] ?? CAMPAIGNS_LIST[0]
    const isSMS   = base.type === 'sms'
    const isEmail = base.type === 'email'
    const isMulti = base.type === 'multi'
    const isActive    = ['active','paused','completed'].includes(base.status)
    const isDone      = base.status === 'completed'
    return ok({
      ...base,
      list_id: 1,
      sms_body: (isSMS || isMulti)
        ? 'Dear {{first_name}}, you have a pre-approved loan offer from O3 Capital. Visit o3capital.ng/apply or call 01 330 1070. Reply STOP to opt out.'
        : null,
      email_subject: (isEmail || isMulti) ? 'Exclusive offer for {{first_name}} {{last_name}} — O3 Capital' : null,
      email_body_html: (isEmail || isMulti)
        ? '<p>Dear {{first_name}},</p><p>You have a pre-approved loan offer waiting. Click the button below to apply online in minutes.</p><p>Best regards,<br/>O3 Capital</p>'
        : null,
      email_body_text: (isEmail || isMulti)
        ? 'Dear {{first_name}}, You have a pre-approved loan offer waiting. Apply online at o3capital.ng/apply. Best regards, O3 Capital'
        : null,
      email_blocks_json: null,
      from_name: 'O3 Capital',
      from_email: 'care@o3capital.com',
      scheduled_at: base.status === 'scheduled' ? new Date(Date.now() + 86400000*2).toISOString() : null,
      started_at:   isActive ? isoDate(7) : null,
      completed_at: isDone   ? isoDate(6) : null,
      contact_count: isActive ? rng(800, 5000) : 0,
      sent_count:    isDone   ? rng(700, 4800) : base.status === 'active' ? rng(100, 800) : 0,
      delivered_count: isDone ? rng(600, 4500) : base.status === 'active' ? rng(80, 700)  : 0,
      pause_reason: base.status === 'paused' ? 'Rate limit reached — will resume automatically' : null,
      created_by: 'Temitope Posi',
      created_at: isoDate(14),
      updated_at: isoDate(1),
    })
  }),
  http.patch(u('/api/campaigns/:id'),  () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/campaigns/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/campaigns/:id/contacts'), () => ok({
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i+1,
      first_name: FIRST[i % FIRST.length],
      last_name:  LAST[i % LAST.length],
      email: `contact${i+1}@example.ng`,
      phone: `080${rng(10000000,99999999)}`,
      sms_status:   pick(['sent','delivered','delivered','failed','pending']),
      email_status: pick(['sent','delivered','opened','clicked','failed','pending']),
    })),
    total: 4820,
  })),
  http.post(u('/api/campaigns/:id/resume'),    () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/campaigns/:id/duplicate'), ({ params }) => ok({ id: rng(200, 999), name: `Copy of Campaign ${params.id}` })),
  http.post(u('/api/campaigns/:id/restart'),   () => ok({ status: 'draft' })),
]

// ── Contact Lists — missing endpoints ─────────────────────────────────────────

const CONTACT_LISTS_DETAIL = [
  http.get(u('/api/contact-lists/:id'), ({ params }) => {
    const names = ['All Salary Earners','Delinquent Customers','High-Value Borrowers','New Applicants','Card Holders','Dormant Accounts']
    const total = rng(500, 5000)
    return ok({
      id: Number(params.id),
      name: names[Number(params.id) % names.length] ?? names[0],
      member_count: total, total,
      description: null,
      created_at: isoDate(rng(10, 90)),
      created_by: 'Temitope Posi',
    })
  }),
  http.get(u('/api/contact-lists/:id/members'), () => ok({
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i+1, cif: `CIF${String(i+100000).padStart(7,'0')}`,
      first_name: FIRST[i % FIRST.length],
      last_name:  LAST[i % LAST.length],
      email: `contact${i}@example.ng`,
      phone: `080${rng(10000000,99999999)}`,
      status: pick(['active','active','active','suppressed']),
      added_at: isoDate(rng(0, 30)),
    })),
    total: 3247,
  })),
  http.post(u('/api/contact-lists/:id/import'),         () => ok({ imported: 847, skipped: 12, total: 859 })),
  http.post(u('/api/contact-lists/:id/contacts'),       () => ok({ id: 99 })),
  http.delete(u('/api/contact-lists/:id/contacts/:cid'), () => new HttpResponse(null, { status: 204 })),
]

// ── Gap fill — endpoints identified in second sweep ───────────────────────────

const GAP_FILL = [

  // ── Global search ────────────────────────────────────────────────────────────
  http.get(u('/api/search'), ({ request }) => {
    const q = new URL(request.url).searchParams.get('q') ?? ''
    return ok({
      customers: q ? [
        { cif: 'CIF0100042', name: 'Adewale Ogundimu', phone: '08031234567', type: 'customer' },
        { cif: 'CIF0100081', name: 'Ngozi Eze',         phone: '08054321987', type: 'customer' },
      ] : [],
      loans: q ? [
        { id: 12, ref: 'LA-2026-0012', customer: 'Adewale Ogundimu', amount_kobo: 50_000_000_00, status: 'active' },
      ] : [],
      tickets: q ? [
        { id: 4, ref: 'TKT-2026-01004', subject: 'Card not working at POS', status: 'open' },
      ] : [],
    })
  }),

  // ── CC Statements (credit card statements) ───────────────────────────────────
  // Static paths must come before /:id
  http.get(u('/api/cc-statements/from-db'), () => ok(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, cif: `CIF${String(i+100000).padStart(7,'0')}`,
      customer_name: name(), account_number: `4000${String(rng(10000000,99999999))}`,
      statement_date: dateStr(rng(0,30)), closing_balance_kobo: rng(5,200)*100_00,
      status: pick(['ready','sent','pending']),
    }))
  )),
  http.post(u('/api/cc-statements/bulk'), () => ok({ queued: 847, already_sent: 12 })),
  http.post(u('/api/cc-statements/upload'), () => ok({ processed: 120, skipped: 3 })),
  http.get(u('/api/cc-statements'), () => ok({
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i+1, cif: `CIF${String(i+100000).padStart(7,'0')}`,
      customer_name: name(), account_number: `4000${String(rng(10000000,99999999))}`,
      statement_period: `${2026}-${String((i % 12)+1).padStart(2,'0')}`,
      opening_balance_kobo: rng(10,100)*100_00,
      closing_balance_kobo: rng(10,100)*100_00,
      total_spend_kobo: rng(5,80)*100_00,
      total_payments_kobo: rng(5,60)*100_00,
      status: pick(['ready','sent','pending']),
      sent_at: Math.random() > 0.4 ? isoDate(rng(0,14)) : null,
    })),
    total: 1840,
  })),
  http.get(u('/api/cc-statements/:id'), ({ params }) => ok({
    id: Number(params.id), cif: 'CIF0100042', customer_name: 'Adewale Ogundimu',
    account_number: '4000123456789012',
    statement_period: '2026-06',
    opening_balance_kobo: 24_500_00, closing_balance_kobo: 18_200_00,
    credit_limit_kobo: 200_000_00,
    total_spend_kobo: 62_300_00, total_payments_kobo: 68_600_00,
    minimum_payment_kobo: 5_000_00, payment_due_date: dateStr(14),
    transactions: Array.from({ length: 15 }, (_, j) => ({
      id: j+1, date: dateStr(rng(0,30)),
      description: pick(['POS Purchase - Shoprite','ATM Withdrawal - GTBank','Online - Netflix','Fuel Station','Restaurant']),
      amount_kobo: rng(1,50)*1_000_00,
      type: pick(['debit','credit']),
      balance_kobo: rng(10,200)*100_00,
    })),
    status: 'ready', sent_at: null,
  })),
  http.post(u('/api/cc-statements/:id/send'), () => new HttpResponse(null, { status: 204 })),

  // ── Core banking status ───────────────────────────────────────────────────────
  http.get(u('/api/cbs/status'), () => ok({
    connected: true, provider: 'Udara360', latency_ms: 142,
    last_sync_at: isoDate(0), environment: 'production',
    services: {
      accounts: 'healthy', loans: 'healthy', transfers: 'healthy',
      cards: 'healthy', kyc: 'healthy',
    },
  })),

  // ── Admin modules ─────────────────────────────────────────────────────────────
  http.get(u('/api/admin/modules'), () => ok([
    { id: 'loans',       name: 'Loan Origination',  enabled: true,  roles: ['admin','los_officer','credit_analyst'] },
    { id: 'cards',       name: 'Cards',              enabled: true,  roles: ['admin','cards_ops'] },
    { id: 'collections', name: 'Collections',        enabled: true,  roles: ['admin','collections_officer'] },
    { id: 'recovery',    name: 'Recovery',           enabled: true,  roles: ['admin','recovery_agent'] },
    { id: 'compliance',  name: 'Compliance',         enabled: true,  roles: ['admin','compliance_officer'] },
    { id: 'hr',          name: 'HR & Payroll',       enabled: true,  roles: ['admin','hr_manager'] },
    { id: 'finance',     name: 'Finance',            enabled: true,  roles: ['admin','finance_manager'] },
    { id: 'campaigns',   name: 'Campaigns',          enabled: true,  roles: ['admin','marketing_officer'] },
    { id: 'helpdesk',    name: 'Helpdesk',           enabled: true,  roles: ['admin','helpdesk_agent'] },
    { id: 'risk',        name: 'Risk',               enabled: true,  roles: ['admin','risk_officer'] },
  ])),

  // ── Settings — Zoho Voice ─────────────────────────────────────────────────────
  http.get(u('/api/settings/zoho-voice'), () => ok({
    enabled: true, account_id: 'ZV-O3-0001', department_id: 'DEPT-002',
    api_domain: 'voice.zoho.com', click_to_call: true,
    call_recording: true, transcription: false,
    connected_at: isoDate(120),
  })),
  http.put(u('/api/settings/zoho-voice'), () => new HttpResponse(null, { status: 204 })),

  // ── Finance — FX Rates ────────────────────────────────────────────────────────
  // Static paths first
  http.get(u('/api/finance/fx-rates/history'), ({ request }) => {
    const url = new URL(request.url)
    const pair = url.searchParams.get('pair') ?? 'USD/NGN'
    return ok(Array.from({ length: 30 }, (_, i) => ({
      date: dateStr(30 - i),
      rate: pair === 'USD/NGN' ? 1580 + rng(-40, 60) :
            pair === 'GBP/NGN' ? 2020 + rng(-50, 70) :
                                  1680 + rng(-40, 60),
    })))
  }),
  http.post(u('/api/finance/fx-rates/refresh'), () => ok({ updated: 6, as_of: new Date().toISOString() })),
  http.get(u('/api/finance/fx-rates/latest'), () => ok([
    { pair: 'USD/NGN', rate: 1612.50, bid: 1610.00, ask: 1615.00, change_pct: 0.3, source: 'CBN', as_of: new Date().toISOString() },
    { pair: 'GBP/NGN', rate: 2048.75, bid: 2045.00, ask: 2052.50, change_pct: -0.1, source: 'CBN', as_of: new Date().toISOString() },
    { pair: 'EUR/NGN', rate: 1748.20, bid: 1744.00, ask: 1752.40, change_pct:  0.5, source: 'CBN', as_of: new Date().toISOString() },
    { pair: 'USD/EUR', rate:    0.92, bid:    0.919, ask:    0.921, change_pct: -0.2, source: 'ECB', as_of: new Date().toISOString() },
    { pair: 'USD/GBP', rate:    0.79, bid:    0.789, ask:    0.791, change_pct:  0.1, source: 'BOE', as_of: new Date().toISOString() },
    { pair: 'XAU/USD', rate: 2418.00, bid: 2416.00, ask: 2420.00, change_pct:  0.8, source: 'LBMA', as_of: new Date().toISOString() },
  ])),

  // ── Campaigns — push to telemarketing ─────────────────────────────────────────
  http.post(u('/api/campaigns/:id/push-to-telemarketing'), () => ok({ queued: rng(80, 400) })),

  // ── Collections-ops — per-case actions ───────────────────────────────────────
  http.post(u('/api/collections-ops/:id/send-to-recovery'), () => ok({ case_ref: `RC-2026-${String(rng(100,999)).padStart(4,'0')}` })),
  http.post(u('/api/collections-ops/:id/contact'),          () => ok({ id: rng(100, 999) })),
  http.post(u('/api/collections-ops/:id/promise'),          () => ok({ id: rng(100, 999) })),
  http.post(u('/api/collections-ops/:id/payment'),          () => ok({ id: rng(100, 999) })),
  http.get(u('/api/collections-ops/:id/contacts'), () => wd(
    Array.from({ length: 5 }, (_, i) => ({
      id: i+1,
      contact_type: pick(['call','sms','email','visit']),
      outcome: pick(['reached','not_reached','ptp','broken_ptp']),
      notes: i % 2 === 0 ? 'Promised to pay by end of week' : null,
      created_at: isoDate(rng(1,14)),
      agent_name: name(),
    }))
  )),
  http.get(u('/api/collections-ops/:id/payments'), () => wd(
    Array.from({ length: 3 }, (_, i) => ({
      id: i+1,
      amount_kobo: rng(5,50)*100_000,
      payment_date: dateStr(rng(1,30)),
      payment_method: pick(['bank_transfer','pos','cash',null]),
      reference: i % 2 === 0 ? `TRF/2026${String(rng(1000,9999))}` : null,
      received_by_name: name(),
    }))
  )),
  http.post(u('/api/collections-ops/writeoffs/:id/approve'),          () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/collections-ops/writeoffs/:id/return-recovery'),  () => new HttpResponse(null, { status: 204 })),

  // ── Recovery-ops — per-case actions ──────────────────────────────────────────
  http.post(u('/api/recovery-ops/cases/:id/legal'),     () => ok({ id: rng(100,999) })),
  http.post(u('/api/recovery-ops/cases/:id/payment'),   () => ok({ id: rng(100,999) })),
  http.post(u('/api/recovery-ops/cases/:id/visit'),     () => ok({ id: rng(100,999) })),
  http.post(u('/api/recovery-ops/cases/:id/write-off'), () => new HttpResponse(null, { status: 204 })),

  // ── Recovery — legal milestone ────────────────────────────────────────────────
  http.post(u('/api/recovery/cases/:id/legal-milestone'), () => ok({ id: rng(100,999) })),

  // ── Compliance — action endpoints ─────────────────────────────────────────────
  http.post(u('/api/compliance/checklists/:id/respond'),  () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/compliance/findings/:id/response'),   () => ok({ id: rng(100,999) })),
  http.get(u('/api/compliance/pentests/:id/findings'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1,
      title: pick(['SQL Injection in loan endpoint','Insecure direct object reference','Missing rate limit','Weak session token','XSS in dashboard','IDOR on card account','Unencrypted PII in logs','Missing HSTS header']),
      severity: pick(['critical','high','medium','low']),
      cvss: pick([9.1, 8.4, 7.2, 6.5, 4.3, 3.1]),
      status: pick(['open','remediated','accepted','in_progress']),
      affected_endpoint: pick(['/api/loans','POST /api/cards','/api/admin/users','GET /api/search']),
      reported_at: dateStr(rng(5,60)), remediated_at: Math.random() > 0.5 ? dateStr(rng(0,30)) : null,
    }))
  )),
  http.get(u('/api/compliance/soc2/controls/:id/evidence'), () => ok(
    Array.from({ length: 5 }, (_, i) => ({
      id: i+1, control_id: 1, filename: `evidence_${i+1}.pdf`,
      description: pick(['System access log export','Quarterly security review report','Penetration test certificate','DR test results','Vendor assessment']),
      uploaded_by: name(), uploaded_at: isoDate(rng(0,60)), file_size_bytes: rng(40000, 800000),
    }))
  )),
  http.post(u('/api/compliance/soc2/controls/:id/evidence'), () => ok({
    id: rng(100,999), control_id: 1, filename: 'new_evidence.pdf',
    description: 'Uploaded evidence', uploaded_by: 'Temitope Posi',
    uploaded_at: isoDate(0), file_size_bytes: rng(40000, 800000),
  })),
  http.delete(u('/api/compliance/soc2/evidence/:id'), () => new HttpResponse(null, { status: 204 })),

  // ── Helpdesk — additional actions ────────────────────────────────────────────
  http.post(u('/api/helpdesk/tickets/:id/claim'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/helpdesk/kb/:id/feedback'),   () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/reports/cbn-consumer-protection'), ({ request }) => {
    const url    = new URL(request.url)
    const month  = url.searchParams.get('month')  ?? '2026-06'
    const period = month.length === 7 ? month : '2026-06'
    return ok({
      period,
      total_complaints: 284, resolved: 241, pending: 28, escalated: 15,
      avg_resolution_days: 2.4, sla_compliance_pct: 91.2,
      by_category: [
        { category: 'Card Disputes',     count: 92, resolved: 81 },
        { category: 'Loan Complaints',   count: 74, resolved: 62 },
        { category: 'Account Issues',    count: 58, resolved: 52 },
        { category: 'Recovery Conduct',  count: 36, resolved: 28 },
        { category: 'Interest/Charges',  count: 24, resolved: 18 },
      ],
      repeat_complainants: 12, csat_avg: 3.8,
    })
  }),

  // ── Telemarketing — agents, lead disposition, bulk-assign ────────────────────
  http.get(u('/api/telemarketing/agents'), () => ok(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1, name: name(), status: pick(['online','offline','on_call']),
      leads_assigned: rng(5,30), leads_converted: rng(0,8),
      calls_today: rng(10,60), avg_call_min: rng(3,12),
      last_active: isoDate(0),
    }))
  )),
  http.put(u('/api/telemarketing/leads/:id/disposition'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/telemarketing/leads/bulk-assign'),    () => ok({ assigned: rng(10,200) })),

  // ── LOS — missing action endpoints ───────────────────────────────────────────
  http.put(u('/api/los/:id/credit-assessment'), () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/los/:id/decline'),           () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/los/:id/request-info'),      () => new HttpResponse(null, { status: 204 })),

  // ── Admin — module toggle ─────────────────────────────────────────────────────
  http.put(u('/api/admin/modules/:key'), () => new HttpResponse(null, { status: 204 })),

  // ── Collections-ops — individual assign + repayment instalment ───────────────
  http.put(u('/api/collections-ops/:id/assign'),                          () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/collections-ops/repayment-plans/instalments/:id/paid'), () => new HttpResponse(null, { status: 204 })),

  // ── Compliance — close finding + deactivate watchlist ────────────────────────
  http.post(u('/api/compliance/findings/:id/close'),          () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/compliance/watch-list/:id/deactivate'),    () => new HttpResponse(null, { status: 204 })),

  // ── Helpdesk KB — approve + status toggle ────────────────────────────────────
  http.put(u('/api/helpdesk/kb/:id/approve'), () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/helpdesk/kb/:id/status'),  () => new HttpResponse(null, { status: 204 })),

  // ── HR — close disciplinary + onboarding/offboarding checklist items ─────────

  // ── Recovery — delete debt sale ───────────────────────────────────────────────
  http.delete(u('/api/recovery/debt-sales/:id'), () => new HttpResponse(null, { status: 204 })),

  // ── Settlements — escalate failed + resolve NIP + resolve failed ─────────────
  http.post(u('/api/settlements/failed/:id/escalate'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/settlements/failed/:id/resolve'),  () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/settlements/nip/:id/resolve'),     () => new HttpResponse(null, { status: 204 })),

  // ── HR — leave approve / decline ─────────────────────────────────────────────

  // ── Recovery-ops — individual case assign ─────────────────────────────────────
  http.put(u('/api/recovery-ops/cases/:id/assign'), () => new HttpResponse(null, { status: 204 })),

  // ── Contact-list members — add / edit / remove ───────────────────────────────
  http.post(u('/api/contact-lists/:id/members'),           () => ok({ id: rng(1,9999) })),
  http.put(u('/api/contact-lists/:id/members/:memberId'),   () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/contact-lists/:id/members/:memberId'), () => new HttpResponse(null, { status: 204 })),

  // ── Me dashboard ─────────────────────────────────────────────────────────────
  http.get(u('/api/me/dashboard'), () => wd({
    user_id: 1, full_name: 'Temitope Posi', role: 'admin',
    kpi: { open_tickets: 7, my_applications: 12, my_leads: 5, my_queue: 18 },
    tickets: Array.from({ length: 5 }, (_, i) => ({
      id: i+1, ref: `TKT-2026-0${1000+i}`, subject: pick(['Card blocked at POS','Statement not received','Loan query','Interest dispute','Account freeze']),
      status: pick(['open','pending','open']), priority: pick(['high','medium','low']), created_at: isoDate(rng(0,7)),
    })),
    applications: Array.from({ length: 5 }, (_, i) => ({
      id: i+1, reference: `LN-2026-${1000+i}`, applicant_name: name(), stage: pick(['document_review','credit_assessment','offer_letter','disbursement']),
      status: 'pending', amount_requested_kobo: rng(10,200)*1_000_000_00, created_at: isoDate(rng(0,14)),
    })),
    leads: Array.from({ length: 5 }, (_, i) => ({
      id: i+1, title: `Lead — ${name()}`, stage: pick(['qualified','proposal','negotiation']),
      potential_value_kobo: rng(5,50)*1_000_000_00, created_at: isoDate(rng(0,30)),
    })),
    collections: Array.from({ length: 5 }, (_, i) => ({
      id: i+1, account_cif: `CIF${String(i+100000).padStart(7,'0')}`, customer_name: name(),
      dpd: rng(1,90), status: pick(['pending','in_contact','promise_to_pay']),
    })),
    activity: Array.from({ length: 8 }, (_, i) => ({
      page: pick(['/los', '/helpdesk', '/collections-ops']), action: pick(['viewed','updated','assigned']),
      detail: `Record #${rng(1,200)}`, ts: isoDate(rng(0,3)),
    })),
  })),

  // ── Dialer — next contact for agent session ───────────────────────────────────
  http.get(u('/api/dialer/sessions/me/next-contact'), () => ok({
    contact: {
      id: rng(1,9999), phone: `0801${rng(1000000,9999999)}`,
      customer_name: name(), cif: `CIF${String(rng(100000,999999)).padStart(7,'0')}`,
      metadata: { dpd: rng(1,90) }, priority: rng(1,5), attempts: rng(0,3),
    },
  })),

  // ── Zoho sync status ──────────────────────────────────────────────────────────
  http.get(u('/api/zoho/sync-status'), () => ok({
    configured: true, last_sync_at: isoDate(0), total_imported: 1842,
  })),

  // ── Sales cohort matrix + detail ──────────────────────────────────────────────
  http.get(u('/api/sales/cohort-matrix'), () => ok({
    data: ['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06',
           '2025-07','2025-08','2025-09','2025-10','2025-11','2026-01'].map(m => ({
      cohort_month: m, cohort_size: rng(50,300),
      ret_1m: rng(70,95), ret_3m: rng(60,88), ret_6m: rng(50,82),
      ret_9m: m < '2025-07' ? rng(45,78) : null,
      ret_12m: m < '2025-04' ? rng(40,74) : null,
      par30_current: rng(2,12),
    })),
  })),
  http.get(u('/api/sales/cohort-detail'), ({ request }) => {
    const cohort = new URL(request.url).searchParams.get('cohort') ?? '2025-06'
    return ok({
      data: {
        cohort, count: 142, total_outstanding: 213_000_000_00, par30_count: 14,
        data: Array.from({ length: 20 }, (_, i) => ({
          id: i+1, reference: `LN-2025-${1000+i}`, applicant_name: name(),
          product_type: pick(LOS_PRODUCTS), employer: pick(['Shell Nigeria','MTN','NNPC','Access Bank','Civil Service']),
          amount_requested_kobo: rng(10,150)*1_000_000_00, outstanding_kobo: rng(0,100)*1_000_000_00,
          dpd: rng(0,60), status: pick(['active','active','active','closed','delinquent']),
          stage: pick(['disbursed','completed','cancelled']), created_at: isoDate(rng(30,180)),
        })),
      },
    })
  }),

  // ── Contact list segment builder ──────────────────────────────────────────────
  http.post(u('/api/contact-lists/segment/preview'), () => ok({ data: { count: rng(200, 4000) } })),
  http.post(u('/api/contact-lists/segment/create'),  () => ok({ data: { list_id: rng(10,99), imported: rng(200, 4000) } })),

  // ── Campaign progress + test-send ─────────────────────────────────────────────
  http.get(u('/api/campaigns/:id/progress'), () => ok({
    sent: rng(100,500), delivered: rng(80,400), bounced: rng(0,30), progress_pct: rng(40,95),
  })),
  http.post(u('/api/campaigns/:id/test-send'), () => ok({ sent: 1, warnings: [] })),

  // ── Auth — force change password ──────────────────────────────────────────────
  http.post(u('/api/auth/force-change-password'), () => new HttpResponse(null, { status: 204 })),

  // ── Modules — enabled module keys for sidebar visibility ─────────────────────
  http.get(u('/api/modules'), () => ok({
    enabled: ['root','sales','contact','cards','lending','finance','compliance','people','analytics'],
  })),

  // ── Voice — Africa's Talking token ───────────────────────────────────────────
  http.get(u('/api/voice/at-token'), () => ok({ token: 'mock-at-voice-token-for-demo' })),
]

// ── Catch-all ─────────────────────────────────────────────────────────────────

const CATCH_ALL = [
  http.all(`${API}/*`, ({ request }) => {
    console.warn(`[MSW] No mock: ${request.method} ${request.url}`)
    return new HttpResponse(
      JSON.stringify({ detail: `No mock for ${request.method} ${new URL(request.url).pathname}` }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    )
  }),
]

// ── Export ────────────────────────────────────────────────────────────────────

// ── Gap-fill: 20 endpoints missing from original handlers ─────────────────────

const MOCK_GAPS = [

  // Auth edge cases
  http.post(u('/api/auth/totp/challenge'), () => wd({ challenge_id: 'chal_mock_001', expires_in: 300 })),
  http.post(u('/api/auth/register'), async ({ request }) => {
    const b = await request.json() as Record<string, unknown>
    return wd({ id: 'usr_mock_new', email: b.email ?? 'user@example.com', message: 'Registration pending approval' })
  }),

  // Settings — DELETE zoho-voice
  http.delete(u('/api/settings/zoho-voice'), () => wd({ message: 'Zoho Voice disconnected' })),

  // BD — leads bulk import
  http.post(u('/api/bd/leads/import'), () => wd({ imported: 42, skipped: 3, errors: [] })),

  // BD — assignments
  http.get(u('/api/bd/assignments'), () => ok(
    Array.from({ length: 18 }, (_, i) => ({
      id: i + 1,
      employer_id: (i % 10) + 1,
      employer_name: ['Shell Nigeria','MTN','Dangote','First Bank','NNPC','Unilever','Guinness','NB Plc','Nestle Nigeria','Flour Mills'][i % 10],
      bd_officer_id: (i % 5) + 10,
      bd_officer_name: ['Adebayo Okon','Funmi Adesanya','Emeka Eze','Tolu Bello','Ngozi Okafor'][i % 5],
      sales_agent_id: (i % 6) + 20,
      sales_agent_name: ['Chidi Okeke','Amina Bello','Kemi Ade','Taiwo Ojo','David Mensah','Fatima Musa'][i % 6],
      assignment_type: i % 3 === 0 ? 'specific_staff' : 'full_company',
      status: ['assigned','in_progress','in_progress','converted','assigned','lost','in_progress','assigned','converted','in_progress','assigned','in_progress','converted','assigned','in_progress','lost','assigned','in_progress'][i],
      staff_count_at_assignment: rng(50, 3000),
      notes: i % 4 === 0 ? 'Follow up scheduled for end of month' : null,
      assigned_at: isoDate(rng(10, 120)),
      updated_at: isoDate(rng(0, 10)),
      contacts_total: rng(20, 300),
      contacts_converted: rng(5, 80),
      deals_open: rng(1, 12),
    }))
  )),
  http.patch(u('/api/bd/assignments/:id'), () => new HttpResponse(null, { status: 204 })),

  // BD — employer staff drill-down
  http.get(u('/api/bd/employers/:id/staff'), () => ok(
    Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      employer_id: 1,
      full_name: name(),
      job_title: pick(['Analyst','Manager','Engineer','Accountant','Officer','Coordinator']),
      department: ['Finance','HR','Operations','Sales','Technology','Legal'][i % 6],
      phone: `080${rng(10000000, 99999999)}`,
      email: `staff${i}@employer.ng`,
      created_at: isoDate(rng(10, 180)),
    }))
  )),
  http.post(u('/api/bd/employers/:id/staff'), () => ok({
    id: rng(100, 999), employer_id: 1, full_name: 'New Staff',
    job_title: null, department: null, phone: null, email: null,
    created_at: new Date().toISOString(),
  })),
  http.delete(u('/api/bd/employers/:id/staff/:staff_id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/bd/employers/:id/staff/import'), () => ok({ imported: rng(20, 200), skipped: rng(0, 5) })),
  http.post(u('/api/bd/employers/:id/assign'), () => ok({
    assignment_id: rng(10, 99),
    contacts_created: rng(10, 150),
    staff_count: rng(20, 300),
  })),
  http.get(u('/api/bd/assignments/:id'), ({ params }) => wd({
    assignment: {
      id: Number(params.id),
      employer_id: 1, employer_name: 'Shell Nigeria',
      bd_officer_id: 10, sales_agent_id: 20,
      sales_agent_name: 'Adebayo Okon',
      assignment_type: 'full_company',
      status: 'in_progress',
      staff_count_at_assignment: 342,
      notes: 'Priority employer — follow up weekly',
      assigned_at: isoDate(30),
    },
    contacts: Array.from({ length: 8 }, (_, i) => {
      const fn = pick(['Emeka','Fatima','Taiwo','Ngozi','Kemi'])
      const ln = pick(['Obi','Musa','Ade','Eze','Okafor'])
      return {
        id: i + 1, first_name: fn, last_name: ln,
        phone: `080${rng(10000000, 99999999)}`,
        email: `${fn.toLowerCase()}@employer.ng`,
        status: pick(['lead','qualified','customer']),
        assigned_name: 'Adebayo Okon',
        open_deals: rng(0, 2),
      }
    }),
  })),

  // Compliance — board pack
  http.get(u('/api/compliance/board-pack'), () => wd({
    month: '2025-06',
    sections: [
      { title: 'Executive Summary',      status: 'ready',   pages: 4  },
      { title: 'Portfolio Health',       status: 'ready',   pages: 8  },
      { title: 'Collections Report',     status: 'ready',   pages: 6  },
      { title: 'Regulatory Compliance',  status: 'draft',   pages: 5  },
      { title: 'Risk Dashboard',         status: 'ready',   pages: 7  },
      { title: 'HR & People Analytics',  status: 'pending', pages: 3  },
    ],
    generated_at: new Date().toISOString(),
    download_url: '#',
  })),

  // Compliance — bureau submissions
  http.get(u('/api/compliance/bureau-submissions'), () => wd([
    { id: 1, bureau: 'CRC',   period: 'Jun 2025', submitted_at: '2025-07-01T09:00:00Z', status: 'accepted',  records: 2_841, errors: 0   },
    { id: 2, bureau: 'CRC',   period: 'May 2025', submitted_at: '2025-06-01T08:30:00Z', status: 'accepted',  records: 2_718, errors: 0   },
    { id: 3, bureau: 'FIRSTCENTRAL', period: 'Jun 2025', submitted_at: '2025-07-01T10:15:00Z', status: 'pending', records: 2_841, errors: 12 },
    { id: 4, bureau: 'FIRSTCENTRAL', period: 'May 2025', submitted_at: '2025-06-01T09:00:00Z', status: 'accepted', records: 2_718, errors: 0 },
  ])),

  // Compliance — credit bureau CSV export (returns blob)
  http.get(u('/api/compliance/credit-bureau-export'), () =>
    new Response('bureau_ref,customer_cif,product,outstanding_kobo,dpd,status\nBUR-001,00027554,CREDIT_CARD,3478433538,0,PERFORMING\n', {
      headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="bureau-export.csv"' },
    })
  ),

  // Compliance — breach incidents
  http.get(u('/api/compliance/breach-incidents'), () => wd([
    { id: 1, title: 'Suspected phishing attempt — staff email', severity: 'low',    status: 'closed',      reported_at: '2025-05-14T10:22:00Z', affected_count: 0, root_cause: 'Phishing link not clicked; isolated by IT', remediation: 'Refreshed security awareness training' },
    { id: 2, title: 'Unauthorised login attempt — admin portal', severity: 'medium', status: 'resolved',   reported_at: '2025-06-02T14:05:00Z', affected_count: 0, root_cause: 'Credential stuffing from known botnet IPs', remediation: 'IP block + forced MFA reset for all admin accounts' },
    { id: 3, title: 'CRC submission file misrouted', severity: 'medium', status: 'investigating', reported_at: '2025-07-10T09:00:00Z', affected_count: 18, root_cause: 'Pending investigation', remediation: 'Pending' },
  ])),

  // Compliance — DSAR stats
  http.get(u('/api/compliance/dsar-stats'), () => wd({
    total: 47, open: 8, overdue: 2, avg_resolution_days: 12.4,
    by_type: [
      { type: 'Access Request',     count: 28 },
      { type: 'Erasure Request',    count: 11 },
      { type: 'Rectification',      count: 5  },
      { type: 'Portability',        count: 3  },
    ],
  })),

  // Compliance — DSAR PATCH (update status)
  http.patch(u('/api/compliance/data-subject-requests/:id'), async ({ request }) => {
    const b = await request.json() as Record<string, unknown>
    return wd({ id: 1, status: b.status ?? 'in_progress', updated_at: new Date().toISOString() })
  }),

  // Compliance — AML rules DELETE
  http.delete(u('/api/compliance/aml-rules/:id'), () => wd({ message: 'Rule deleted' })),

  // Compliance — SOC2 export (CSV)
  http.get(u('/api/compliance/soc2/export'), () =>
    new Response('control_id,title,status,last_tested,evidence_count\nCC6.1,Logical Access Controls,implemented,2025-06-30,12\nCC7.1,System Operations,implemented,2025-06-15,8\n', {
      headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="soc2-controls.csv"' },
    })
  ),

  // Compliance — pentest findings POST (add finding to engagement)
  http.post(u('/api/compliance/pentests/:id/findings'), async ({ request }) => {
    const b = await request.json() as Record<string, unknown>
    return wd({ id: Math.floor(Math.random() * 9000) + 1000, ...b, created_at: new Date().toISOString() })
  }),

  // Admin — integrations PATCH (update) + DELETE
  http.patch(u('/api/admin/integrations/:id'), async ({ request }) => {
    const b = await request.json() as Record<string, unknown>
    return wd({ id: 1, ...b, updated_at: new Date().toISOString() })
  }),
  http.delete(u('/api/admin/integrations/:id'), () => wd({ message: 'Integration removed' })),

  // Helpdesk — CSAT public survey (no auth, raw token in URL)
  http.get(u('/api/helpdesk/csat/:token'), () => wd({
    token: 'mock_token',
    ticket_ref: 'TKT-2025-0042',
    agent_name: 'Adunola Bello',
    resolved_at: '2025-07-20T14:30:00Z',
    already_submitted: false,
  })),
  http.post(u('/api/helpdesk/csat/:token'), () => wd({ message: 'Thank you for your feedback' })),

  // Finance — EOD transactions CSV export
  http.get(u('/api/eod/transactions/export'), () =>
    new Response('date,product,channel,amount_kobo,count\n2025-07-20,CREDIT_CARD,POS,184200000,312\n2025-07-20,PREPAID,ATM,42000000,87\n', {
      headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="eod-transactions.csv"' },
    })
  ),

  // BI / Report Builder — preview run
  http.post(u('/api/bi/reports/preview'), () => wd({
    rows: [
      { month: 'Jan 2025', revenue_kobo: 2_840_000_000, cost_kobo: 1_520_000_000, net_kobo: 1_320_000_000 },
      { month: 'Feb 2025', revenue_kobo: 3_120_000_000, cost_kobo: 1_640_000_000, net_kobo: 1_480_000_000 },
      { month: 'Mar 2025', revenue_kobo: 2_980_000_000, cost_kobo: 1_580_000_000, net_kobo: 1_400_000_000 },
    ],
    columns: ['month', 'revenue_kobo', 'cost_kobo', 'net_kobo'],
    row_count: 3,
  })),

  // CC Statements — render HTML (returns HTML string)
  http.get(u('/api/cc-statements/:id/render'), () =>
    new Response('<html><body><h1>CC Statement</h1><p>Mock rendered statement for demo.</p></body></html>', {
      headers: { 'Content-Type': 'text/html' },
    })
  ),
]

// ── Executive department drill-down endpoints ─────────────────────────────────

const EXECUTIVE_DEPT = [
  http.get(u('/api/executive/cards'), () => wd({
    total_cards: 1842, active_cards: 1654, activation_rate_pct: 89.8,
    credit_book_kobo: 2_184_500_000, prepaid_ngn_balance_kobo: 847_200_000, prepaid_usd_balance_cents: 124_800,
    disputes_open: 12, disputes_resolved_mtd: 48,
    txn_volume_kobo: 477_189_230_00, txn_count: 28_419, txn_change_pct: 8.4,
    channel_mix: [
      { channel: 'ATM',      volume_kobo: 820_400_000,    count: 1_640  },
      { channel: 'POS',      volume_kobo: 8_475_560_859,  count: 5_318  },
      { channel: 'WEB',      volume_kobo: 23_693_391_624, count: 12_047 },
      { channel: 'TRANSFER', volume_kobo: 82_243_507_903, count: 9_414  },
    ],
    monthly_trend: ['Jan','Feb','Mar','Apr','May','Jun'].map((m,i) => ({
      month: m,
      atm:      [168_500_000, 172_200_000, 115_400_000, 125_200_000, 123_300_000, 115_800_000][i],
      pos:      [2_094_254_691, 1_142_586_698, 1_435_062_160, 1_164_520_084, 1_141_592_869, 1_497_544_357][i],
      web:      [5_507_397_656, 4_336_613_728, 2_825_917_248, 3_775_154_082, 3_923_585_065, 3_324_723_845][i],
      transfer: [5_515_403_000, 6_371_468_692, 8_441_525_120, 9_533_611_655, 42_530_445_160, 9_851_054_276][i],
    })),
    top_merchants: [
      { name: 'QUICKTELLER BILL', volume_kobo: 4_218_400_000, count: 3_241 },
      { name: 'TRANSFERBANK',     volume_kobo: 3_947_200_000, count: 2_187 },
      { name: 'GTBank ATM',       volume_kobo: 1_824_500_000, count: 1_543 },
      { name: 'TISCO PLAZA ATM1', volume_kobo: 1_204_700_000, count: 987  },
      { name: 'OANDO AWOLOWO',    volume_kobo: 874_300_000,   count: 654  },
    ],
  })),

  http.get(u('/api/executive/finance'), () => wd({
    total_revenue_kobo: 184_500_000_00, revenue_change_pct: 12.4,
    total_cost_kobo: 98_200_000_00, cost_change_pct: 6.8,
    net_income_kobo: 86_300_000_00, net_margin_pct: 46.8,
    fd_book_kobo: 2_840_000_000_00, fd_count: 247, fd_maturing_30d: 18,
    settlement_balance_kobo: 124_800_000_00, paystack_wallet_kobo: 48_200_000_00,
    monthly_pnl: ['Jan','Feb','Mar','Apr','May','Jun'].map((m,i) => ({
      month: m,
      revenue: [2_840_000_000, 3_120_000_000, 2_980_000_000, 3_240_000_000, 3_480_000_000, 3_140_000_000][i],
      cost:    [1_520_000_000, 1_640_000_000, 1_580_000_000, 1_720_000_000, 1_840_000_000, 1_660_000_000][i],
      net:     [1_320_000_000, 1_480_000_000, 1_400_000_000, 1_520_000_000, 1_640_000_000, 1_480_000_000][i],
    })),
    revenue_breakdown: [
      { source: 'Interest Income', amount_kobo: 98_400_000_00 },
      { source: 'Card Fees',       amount_kobo: 42_100_000_00 },
      { source: 'FD Interest',     amount_kobo: 28_700_000_00 },
      { source: 'FX Revenue',      amount_kobo: 15_300_000_00 },
    ],
  })),

  http.get(u('/api/executive/sales'), () => wd({
    pipeline_value_kobo: 847_200_000_00, pipeline_count: 124,
    conversions_mtd: 18, conversion_rate_pct: 14.5,
    calls_made_mtd: 312, meetings_held_mtd: 87,
    targets_achieved_pct: 72.4,
    monthly_trend: ['Jan','Feb','Mar','Apr','May','Jun'].map((m,i) => ({
      month: m,
      calls:       [48,52,61,55,72,87][i],
      conversions: [8,11,14,12,16,18][i],
      value_kobo:  [124_000_000_00,148_000_000_00,184_000_000_00,162_000_000_00,218_000_000_00,247_000_000_00][i],
    })),
    top_performers: [
      { name: 'Adebayo Osei',     conversions: 7,  value_kobo: 84_200_000_00 },
      { name: 'Fatima Musa',      conversions: 5,  value_kobo: 61_400_000_00 },
      { name: 'Chukwuemeka Eze',  conversions: 4,  value_kobo: 52_800_000_00 },
      { name: 'Ngozi Okafor',     conversions: 3,  value_kobo: 38_100_000_00 },
    ],
    pipeline_stages: [
      { stage: 'Prospect',  count: 58, value_kobo: 124_000_000_00 },
      { stage: 'Engaged',   count: 34, value_kobo: 284_000_000_00 },
      { stage: 'Proposal',  count: 22, value_kobo: 318_000_000_00 },
      { stage: 'Won',       count: 10, value_kobo: 121_200_000_00 },
    ],
  })),

  http.get(u('/api/executive/collections'), () => wd({
    collected_mtd_kobo: 184_720_000_00, collected_change_pct: 9.2,
    collection_rate_pct: 87.4, promise_rate_pct: 64.2,
    par30_count: 142, par60_count: 87, par90_count: 54,
    par30_value_kobo: 284_000_000_00, par60_value_kobo: 148_000_000_00, par90_value_kobo: 98_400_000_00,
    writeoff_mtd_kobo: 12_400_000_00, recovery_rate_pct: 72.8,
    monthly_trend: ['Jan','Feb','Mar','Apr','May','Jun'].map((m,i) => ({
      month: m,
      collected: [162_000_000_00, 174_000_000_00, 158_000_000_00, 186_000_000_00, 194_000_000_00, 184_720_000_00][i],
      target:    [180_000_000_00, 180_000_000_00, 180_000_000_00, 180_000_000_00, 180_000_000_00, 180_000_000_00][i],
      rate:      [90.0, 96.7, 87.8, 103.3, 107.8, 102.6][i],
    })),
    dpd_breakdown: [
      { bucket: 'Current',  count: 2841, value_kobo: 4_218_400_000_00 },
      { bucket: '1–30d',    count: 142,  value_kobo: 284_000_000_00 },
      { bucket: '31–60d',   count: 87,   value_kobo: 148_000_000_00 },
      { bucket: '61–90d',   count: 54,   value_kobo: 98_400_000_00 },
      { bucket: '90d+',     count: 38,   value_kobo: 74_200_000_00 },
    ],
    top_agents: [
      { name: 'Adunola Bello',    collected_kobo: 28_400_000_00, count: 142 },
      { name: 'Emeka Okafor',     collected_kobo: 24_100_000_00, count: 121 },
      { name: 'Blessing Adeyemi', collected_kobo: 21_800_000_00, count: 109 },
      { name: 'Taiwo Afolabi',    collected_kobo: 18_700_000_00, count: 94  },
    ],
  })),

  http.get(u('/api/executive/risk'), () => wd({
    portfolio_outstanding_kobo: 4_218_400_000_00, npl_rate_pct: 8.2,
    concentration_top10_pct: 34.7, avg_loan_size_kobo: 148_400_000,
    new_accounts_mtd: 47, churn_rate_pct: 2.4,
    dpd_trend: ['Jan','Feb','Mar','Apr','May','Jun'].map((m,i) => ({
      month: m,
      par30: [128,134,142,138,147,142][i],
      par60: [84,88,91,86,90,87][i],
      par90: [52,56,58,53,57,54][i],
    })),
    product_concentration: [
      { product: 'Credit Card',     outstanding_kobo: 2_184_500_000_00, count: 847 },
      { product: 'Business Loan',   outstanding_kobo: 1_248_000_000_00, count: 312 },
      { product: 'Salary Advance',  outstanding_kobo: 524_000_000_00,   count: 618 },
      { product: 'Mortgage',        outstanding_kobo: 261_900_000_00,   count: 65  },
    ],
    vintage_performance: [
      { vintage: 'Q1 2024', par30_rate: 4.2, par90_rate: 1.8 },
      { vintage: 'Q2 2024', par30_rate: 5.1, par90_rate: 2.4 },
      { vintage: 'Q3 2024', par30_rate: 6.8, par90_rate: 3.1 },
      { vintage: 'Q4 2024', par30_rate: 7.4, par90_rate: 2.9 },
      { vintage: 'Q1 2025', par30_rate: 8.2, par90_rate: 1.4 },
    ],
  })),

  http.get(u('/api/executive/hr'), () => wd({
    headcount: 84, headcount_change: 3,
    new_hires_mtd: 4, departures_mtd: 1, attrition_rate_pct: 14.3,
    leaves_pending: 7, leaves_active: 12,
    payroll_cost_kobo: 148_400_000_00, payroll_change_pct: 4.2,
    dept_breakdown: [
      { dept: 'Cards Operations', count: 18 },
      { dept: 'Collections',      count: 14 },
      { dept: 'Sales & BD',       count: 12 },
      { dept: 'Technology',       count: 11 },
      { dept: 'Finance',          count: 8  },
      { dept: 'Risk',             count: 7  },
      { dept: 'Compliance',       count: 6  },
      { dept: 'HR & Admin',       count: 5  },
      { dept: 'Customer Service', count: 3  },
    ],
    headcount_trend: ['Jan','Feb','Mar','Apr','May','Jun'].map((m,i) => ({
      month: m, count: [78,79,80,81,82,84][i],
    })),
  })),

  http.get(u('/api/executive/settlements'), () => wd({
    paystack_wallet_kobo: 48_200_000_00, nip_success_rate_pct: 98.4,
    settled_today_kobo: 8_420_000_00, pending_kobo: 1_240_000_00,
    failed_count: 14, recon_rate_pct: 97.8,
    open_exceptions: 8, exception_value_kobo: 384_000_00,
    channel_volumes: [
      { channel: 'Paystack',    volume_kobo: 82_400_000_00,  count: 1_847, success_rate_pct: 99.2 },
      { channel: 'NIP/NIBSS',   volume_kobo: 147_800_000_00, count: 4_218, success_rate_pct: 98.4 },
      { channel: 'Interswitch', volume_kobo: 214_600_000_00, count: 8_412, success_rate_pct: 97.1 },
    ],
    daily_trend: Array.from({ length: 14 }, (_, i) => ({
      date: `Jul ${i + 9}`,
      settled: Math.round(6_000_000_00 + Math.random() * 4_000_000_00),
      failed:  Math.round(100_000_00  + Math.random() * 300_000_00),
    })),
  })),

  // Real H1 2026 figures sourced from the half-year transaction report
  // MTD = Jul 1-24 (24/30 of Jun); L30d ≈ Jun; L90d ≈ Q2; YTD = full H1 2026
  http.get(u('/api/cards/interswitch/summary'), ({ request }) => {
    const period = new URL(request.url).searchParams.get('period') ?? 'mtd'
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun']
    // Monthly channel volumes in kobo (real H1 2026 data)
    const MO: { atm: number; pos: number; web: number; transfer: number }[] = [
      { atm: 168_500_000, pos: 2_094_254_691, web: 5_507_397_656, transfer: 5_515_403_000 }, // Jan
      { atm: 172_200_000, pos: 1_142_586_698, web: 4_336_613_728, transfer: 6_371_468_692 }, // Feb
      { atm: 115_400_000, pos: 1_435_062_160, web: 2_825_917_248, transfer: 8_441_525_120 }, // Mar
      { atm: 125_200_000, pos: 1_164_520_084, web: 3_775_154_082, transfer: 9_533_611_655 }, // Apr
      { atm: 123_300_000, pos: 1_141_592_869, web: 3_923_585_065, transfer: 42_530_445_160 }, // May (large transfer spike)
      { atm: 115_800_000, pos: 1_497_544_357, web: 3_324_723_845, transfer: 9_851_054_276 }, // Jun
    ]
    // Pick range based on period
    const range = period === 'ytd' ? MO
      : period === 'l90d' ? MO.slice(3)           // Q2 (Apr-Jun)
      : period === 'l30d' ? MO.slice(5)            // Jun
      : [{ atm: Math.round(MO[5].atm * 24/30), pos: Math.round(MO[5].pos * 24/30), web: Math.round(MO[5].web * 24/30), transfer: Math.round(MO[5].transfer * 24/30) }] // MTD Jul

    const atm      = range.reduce((s, m) => s + m.atm,      0)
    const pos      = range.reduce((s, m) => s + m.pos,      0)
    const web      = range.reduce((s, m) => s + m.web,      0)
    const transfer = range.reduce((s, m) => s + m.transfer, 0)
    const total    = atm + pos + web + transfer

    // Transaction count estimates (avg txn size: ATM ₦5k, POS ₦5k, WEB ₦10k, Transfer ₦50k)
    const atmCt  = Math.round(atm      / 500_000)
    const posCt  = Math.round(pos      / 500_000)
    const webCt  = Math.round(web      / 1_000_000)
    const trCt   = Math.round(transfer / 5_000_000)
    const totalCt = atmCt + posCt + webCt + trCt

    // Daily trend: use the selected months (or days if MTD)
    const daily_trend = period === 'mtd'
      ? Array.from({ length: 24 }, (_, i) => ({
          date: `Jul ${i + 1}`,
          atm:      Math.round(MO[5].atm      / 30 * (0.85 + Math.random() * 0.3)),
          pos:      Math.round(MO[5].pos      / 30 * (0.85 + Math.random() * 0.3)),
          web:      Math.round(MO[5].web      / 30 * (0.85 + Math.random() * 0.3)),
          transfer: Math.round(MO[5].transfer / 30 * (0.85 + Math.random() * 0.3)),
        }))
      : (period === 'l30d' ? [MO[5]] : range).map((m, i) => ({
          date: period === 'ytd' ? MONTHS[i] : period === 'l90d' ? MONTHS[3 + i] : MONTHS[5],
          atm: m.atm, pos: m.pos, web: m.web, transfer: m.transfer,
        }))

    return wd({
      report_date: period === 'ytd' ? '2026-06-30' : period === 'l30d' ? '2026-06-30' : '2026-07-24',
      total_volume_kobo: total, total_count: totalCt,
      channel_breakdown: [
        { channel: 'ATM',      volume_kobo: atm,      count: atmCt, pct: parseFloat((atm / total * 100).toFixed(2)) },
        { channel: 'POS',      volume_kobo: pos,      count: posCt, pct: parseFloat((pos / total * 100).toFixed(2)) },
        { channel: 'WEB',      volume_kobo: web,      count: webCt, pct: parseFloat((web / total * 100).toFixed(2)) },
        { channel: 'TRANSFER', volume_kobo: transfer, count: trCt,  pct: parseFloat((transfer / total * 100).toFixed(2)) },
      ],
      product_breakdown: [
        { product: 'Classic (100)',  volume_kobo: Math.round(total * 0.42), count: Math.round(totalCt * 0.55) },
        { product: 'Prestige (110)', volume_kobo: Math.round(total * 0.22), count: Math.round(totalCt * 0.14) },
        { product: 'PREP (205)',     volume_kobo: Math.round(total * 0.20), count: Math.round(totalCt * 0.20) },
        { product: 'Platinum (105)', volume_kobo: Math.round(total * 0.08), count: Math.round(totalCt * 0.04) },
        { product: 'Business (160)', volume_kobo: Math.round(total * 0.05), count: Math.round(totalCt * 0.03) },
        { product: 'Amex Naira (001)',volume_kobo: Math.round(total * 0.03),count: Math.round(totalCt * 0.04) },
      ],
      txn_type_breakdown: [
        { type: 'Utility Payment',  count: Math.round(totalCt * 0.62), volume_kobo: Math.round(total * 0.55) },
        { type: 'Web Transfer Out', count: Math.round(totalCt * 0.13), volume_kobo: Math.round(total * 0.28) },
        { type: 'Purchase',         count: Math.round(totalCt * 0.14), volume_kobo: Math.round(total * 0.10) },
        { type: 'Cash Advance',     count: Math.round(totalCt * 0.05), volume_kobo: Math.round(total * 0.04) },
        { type: 'Cash Payment',     count: Math.round(totalCt * 0.05), volume_kobo: Math.round(total * 0.02) },
        { type: 'Cash Advance Fee', count: Math.round(totalCt * 0.01), volume_kobo: Math.round(total * 0.001) },
      ],
      daily_trend,
      top_merchants: [
        { name: 'QUICKTELLERBILL',          volume_kobo: Math.round(total * 0.34), count: Math.round(totalCt * 0.20) },
        { name: 'PALMPAY LIMITED',          volume_kobo: Math.round(total * 0.12), count: Math.round(totalCt * 0.14) },
        { name: 'OPAY DIGITAL SERVICES',   volume_kobo: Math.round(total * 0.09), count: Math.round(totalCt * 0.11) },
        { name: 'LUX (VFD)',               volume_kobo: Math.round(total * 0.06), count: Math.round(totalCt * 0.04) },
        { name: 'MONIEPOINT POS',          volume_kobo: Math.round(total * 0.05), count: Math.round(totalCt * 0.08) },
        { name: 'KUDA BANK TRANSFER',      volume_kobo: Math.round(total * 0.04), count: Math.round(totalCt * 0.05) },
        { name: 'GTBank ATM',              volume_kobo: Math.round(total * 0.03), count: Math.round(totalCt * 0.06) },
        { name: 'TISCO PLAZA ATM1',        volume_kobo: Math.round(total * 0.02), count: Math.round(totalCt * 0.04) },
        { name: '3LINE CARD MANAGEMENT',   volume_kobo: Math.round(total * 0.02), count: Math.round(totalCt * 0.03) },
        { name: 'PAYFORCE POS',            volume_kobo: Math.round(total * 0.01), count: Math.round(totalCt * 0.05) },
      ],
    })
  }),

  // Half-year report — real H1 2026 figures from the transaction report
  http.get(u('/api/cards/interswitch/half-year'), () => wd({
    period: 'H1 2026', generated_at: '2026-07-01',
    months: [
      { month: 'January',  atm: 168_500_000,   pos: 2_094_254_691,  web: 5_507_397_656,  transfer: 5_515_403_000,  total: 13_285_555_347 },
      { month: 'February', atm: 172_200_000,   pos: 1_142_586_698,  web: 4_336_613_728,  transfer: 6_371_468_692,  total: 12_022_869_118 },
      { month: 'March',    atm: 115_400_000,   pos: 1_435_062_160,  web: 2_825_917_248,  transfer: 8_441_525_120,  total: 12_817_904_528 },
      { month: 'April',    atm: 125_200_000,   pos: 1_164_520_084,  web: 3_775_154_082,  transfer: 9_533_611_655,  total: 14_598_485_821 },
      { month: 'May',      atm: 123_300_000,   pos: 1_141_592_869,  web: 3_923_585_065,  transfer: 42_530_445_160, total: 47_718_923_094 },
      { month: 'June',     atm: 115_800_000,   pos: 1_497_544_357,  web: 3_324_723_845,  transfer: 9_851_054_276,  total: 14_789_122_478 },
    ],
    totals: {
      atm: 820_400_000, pos: 8_475_560_859, web: 23_693_391_624, transfer: 82_243_507_903, total: 115_232_860_386,
      atm_pct: 0.71, pos_pct: 7.36, web_pct: 20.56, transfer_pct: 71.37,
      atm_avg: 136_733_333, pos_avg: 1_412_593_477, web_avg: 3_948_898_604, transfer_avg: 13_707_251_317,
    },
  })),

  // EODTXN import endpoint
  http.post(u('/api/cards/interswitch/import'), async ({ request }) => {
    const form = await request.formData()
    const files = form.getAll('files')
    const fileCount = files.length || 1
    return wd({
      files_processed: fileCount,
      transactions_imported: Math.round(74 * fileCount),
      total_volume_kobo: Math.round(1_985_223_25 * fileCount),
      branches: [
        { branch: '0001 - Default Branch', txn_count: Math.round(33 * fileCount), volume_kobo: Math.round(6_106_901 * fileCount) },
        { branch: '4009 - Sales Agency',   txn_count: Math.round(41 * fileCount), volume_kobo: Math.round(192_415_424 * fileCount) },
      ],
      products: [
        { product: 'Classic (100)',   txn_count: Math.round(41 * fileCount) },
        { product: 'PREP (205)',      txn_count: Math.round(15 * fileCount) },
        { product: 'Prestige (110)', txn_count: Math.round(10 * fileCount) },
        { product: 'Platinum (105)', txn_count: Math.round(3 * fileCount)  },
        { product: 'Business (160)', txn_count: Math.round(2 * fileCount)  },
        { product: 'Amex Naira (001)',txn_count: Math.round(2 * fileCount) },
        { product: 'BB Classic (120)',txn_count: Math.round(1 * fileCount) },
      ],
      errors: [],
    })
  }),

  // Recovery agent dashboard
  http.get(u('/api/recovery-ops/agent-dashboard'), () => wd({
    assigned_cases: 24, cases_closed_mtd: 8, calls_made_mtd: 142, amount_collected_mtd_kobo: 18_400_000_00,
    cases: Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, case_ref: `REC-2025-${String(i + 1).padStart(4, '0')}`,
      debtor_name: ['Chukwuemeka Obi','Fatima Bello','Adewale Johnson','Ngozi Eze','Emeka Nwosu','Blessing Adeyemi','Taiwo Okafor','Amina Garba','David Mensah','Chioma Eze','Ola Adeyemi','Kemi Balogun'][i],
      outstanding_kobo: Math.round(200_000_00 + Math.random() * 5_000_000_00),
      dpd: [0, 15, 32, 65, 91, 120, 45, 78, 22, 95, 38, 180][i],
      next_action: ['Call debtor', 'Field visit', 'Demand letter', 'Legal referral', 'Promise follow-up', 'Payment plan review'][i % 6],
      next_action_date: new Date(Date.now() + (i - 3) * 86_400_000).toISOString(),
      status: ['active', 'promise', 'legal', 'ptp', 'active', 'promise'][i % 6],
    })),
    recent_visits: Array.from({ length: 6 }, (_, i) => ({
      id: i + 1, case_ref: `REC-2025-${String(i + 1).padStart(4, '0')}`,
      debtor_name: ['Chukwuemeka Obi','Fatima Bello','Adewale Johnson','Ngozi Eze','Emeka Nwosu','Blessing Adeyemi'][i],
      outcome: ['Promise to pay', 'Not at home', 'Partial payment', 'Dispute raised', 'Promise to pay', 'Referred to legal'][i],
      visited_at: new Date(Date.now() - i * 86_400_000).toISOString(),
      amount_promised_kobo: [500_000_00, 0, 150_000_00, 0, 250_000_00, 0][i],
    })),
    monthly_trend: ['Jan','Feb','Mar','Apr','May','Jun'].map((m, i) => ({
      month: m,
      collected: [12_000_000_00, 14_200_000_00, 11_800_000_00, 16_400_000_00, 15_200_000_00, 18_400_000_00][i],
      calls: [98, 112, 104, 128, 118, 142][i],
    })),
  })),

  // Sales agent dashboard
  http.get(u('/api/sales/my-dashboard'), () => wd({
    my_leads: 42, won_mtd: 6, conversion_rate_pct: 14.3,
    target_kobo: 50_000_000_00, achieved_kobo: 38_400_000_00, target_pct: 76.8,
    pipeline: [
      { stage: 'Prospect',    count: 14, value_kobo: 8_400_000_00  },
      { stage: 'Qualified',   count: 11, value_kobo: 14_200_000_00 },
      { stage: 'Proposal',    count: 9,  value_kobo: 18_400_000_00 },
      { stage: 'Negotiation', count: 5,  value_kobo: 22_100_000_00 },
      { stage: 'Won',         count: 3,  value_kobo: 38_400_000_00 },
    ],
    recent_leads: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      company_name: ['Dangote Industries','Access Bank Staff','GTBank Employees','UBA Staff','Zenith Bank','First Bank','Stanbic IBTC','FCMB Staff','Sterling Bank','Fidelity Bank'][i],
      contact_name: ['Emeka Obi','Fatima Musa','Adunola Bello','Taiwo Ade','Ngozi Eze','Blessing Obi','Kemi Ade','Chidi Okafor','Amina Bello','David Mensah'][i],
      stage: ['prospect','qualified','proposal','negotiation','won','prospect','qualified','proposal','won','prospect'][i],
      potential_value_kobo: Math.round(2_000_000_00 + Math.random() * 20_000_000_00),
      updated_at: new Date(Date.now() - i * 86_400_000 * 2).toISOString(),
      lead_score: Math.round(40 + Math.random() * 55),
    })),
    monthly_trend: ['Jan','Feb','Mar','Apr','May','Jun'].map((m, i) => ({
      month: m, leads: [6,8,7,9,10,42][i], won: [1,2,1,2,3,6][i],
    })),
  })),

  // Helpdesk agent dashboard
  http.get(u('/api/helpdesk/my-dashboard'), () => wd({
    open_tickets: 18, resolved_today: 7, avg_handle_time_mins: 12.4, csat_score: 4.6,
    sla_compliance_pct: 94.2, escalations: 2,
    my_tickets: Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      ticket_ref: `TKT-2025-${String(1000 + i).padStart(4, '0')}`,
      subject: ['Card PIN reset','Transaction dispute','Balance enquiry','Card blocked','Statement request','Credit limit query','Transfer failed','Card delivery status','Account verification','Mobile app issue','Payment not reflecting','Card expiry'][i],
      customer_name: ['Emeka Obi','Fatima Musa','Adunola Bello','Taiwo Ade','Ngozi Eze','Blessing Obi','Kemi Ade','Chidi Okafor','Amina Bello','David Mensah','Ola Adeyemi','Chioma Eze'][i],
      priority: ['high','medium','low','high','medium','low','high','medium','low','medium','high','low'][i],
      status: ['open','open','in_progress','open','in_progress','resolved','open','in_progress','open','open','escalated','in_progress'][i],
      created_at: new Date(Date.now() - i * 3_600_000 * 4).toISOString(),
      sla_breach_at: i < 4 ? new Date(Date.now() + (i + 1) * 3_600_000).toISOString() : null,
    })),
    csat_trend: Array.from({ length: 14 }, (_, i) => ({
      date: new Date(Date.now() - (13 - i) * 86_400_000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
      score: +(3.8 + Math.random() * 1.2).toFixed(1),
    })),
    handle_time_by_type: [
      { type: 'Card Issues',      avg_mins: 8.2  },
      { type: 'Transactions',     avg_mins: 14.7 },
      { type: 'Account Queries',  avg_mins: 6.1  },
      { type: 'Disputes',         avg_mins: 22.4 },
      { type: 'Statements',       avg_mins: 4.8  },
    ],
  })),

  // BD — my dashboard (BD officer view)
  http.get(u('/api/bd/my-dashboard'), () => ok({
    my_dashboard: {
      kpis: {
        employers_managed: 12, mou_signed: 9, mou_expiring_soon: 2,
        staff_referred_mtd: 48, staff_referred_lm: 61,
        conversions_mtd: 7,  conversions_lm: 11,
        calls_made_mtd: 87,  calls_lm: 94,
        meetings_mtd: 14,    meetings_lm: 18,
      },
      funnel_all: { staff_referred: 340, crm_contacts: 284, applications: 116, converted: 78 },
      funnel_mtd: { staff_referred: 48,  crm_contacts: 39,  applications: 14,  converted: 7  },
      urgency: {
        mou_expiring: [
          { id: 3, name: 'GTBank', sector: 'Banking', mou_expiry: dateStr(12), days_to_expiry: 12, contact_name: 'Tayo Bello', contact_email: 'tayo.bello@gtbank.ng' },
          { id: 7, name: 'Unilever Nigeria', sector: 'FMCG', mou_expiry: dateStr(28), days_to_expiry: 28, contact_name: 'Ngozi Eze', contact_email: 'ngozi.eze@unilever.ng' },
        ],
        stale_assignments: [
          { id: 5, employer_name: 'Flour Mills Nigeria', staff_count_at_assignment: 820, assigned_at: isoDate(45), days_stale: 45, sales_agent_name: 'Kemi Ade', sales_agent_email: 'kemi.ade@o3capital.ng' },
        ],
        dormant: [
          { id: 11, name: 'NB Plc', sector: 'FMCG', mou_date: dateStr(180), days_since_signed: 180, contact_name: 'Chidi Okafor', contact_email: 'chidi.okafor@nbplc.ng' },
        ],
      },
      employers: Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        name: ['Dangote Group','Access Bank','GTBank','UBA','Zenith Bank','First Bank','Unilever Nigeria','Shell Nigeria'][i],
        sector: ['Manufacturing','Banking','Banking','Banking','Banking','Banking','FMCG','Oil & Gas'][i],
        staff_count: [12000, 4800, 6200, 9100, 7400, 11000, 3200, 2500][i],
        mou_status: ['signed','signed','pending','signed','expired','pending','signed','signed'][i],
        mou_expiry: [dateStr(180), dateStr(90), null, dateStr(270), dateStr(-30), null, dateStr(60), dateStr(365)][i],
        assignments_count: rng(1, 8),
        staff_referred: rng(10, 200),
        contacts_created: rng(8, 160),
        converted: rng(2, 40),
      })),
      recent_assignments: Array.from({ length: 6 }, (_, i) => ({
        id: i + 1,
        employer_name: ['Dangote Group','Access Bank','GTBank','UBA','Zenith Bank','Flour Mills'][i],
        assignment_type: i % 2 === 0 ? 'full_company' : 'specific_staff',
        status: ['in_progress','converted','assigned','in_progress','lost','in_progress'][i],
        staff_count_at_assignment: rng(50, 2000),
        assigned_at: isoDate(rng(5, 90)),
        sales_agent_name: ['Chidi Okeke','Amina Bello','Kemi Ade','Taiwo Ojo','David Mensah','Fatima Musa'][i],
        contacts_created: rng(5, 120),
        converted: rng(0, 30),
      })),
    },
  })),

  // BD — single employer detail (for employer drawer)
  http.get(u('/api/bd/employers/:id'), ({ params }) => ok({
    employer: {
      id: Number(params.id),
      name: pick(['Shell Nigeria','MTN Nigeria','Dangote Group','First Bank','NNPC Ltd','Unilever Nigeria']),
      sector: pick(['Oil & Gas','Telecoms','Manufacturing','Banking','FMCG']),
      staff_count: rng(500, 12000),
      monthly_payroll_kobo: rng(200, 1200) * 1_000_000_00,
      credit_limit_kobo: rng(100, 500) * 1_000_000_00,
      mou_status: pick(['signed','pending','expired']),
      mou_date: dateStr(rng(90, 400)),
      mou_expiry: dateStr(rng(-30, 300)),
      contact_name: name(),
      contact_phone: `080${rng(10000000,99999999)}`,
      contact_email: `bd@employer.ng`,
      address: `${rng(1, 200)} Marina Street, Lagos Island, Lagos`,
      notes: 'Priority partnership — large eligible staff base with strong payroll history.',
      is_active: true,
    },
    outcomes: {
      total_assignments: rng(3, 12),
      total_staff_referred: rng(50, 500),
      total_crm_contacts: rng(40, 400),
      total_converted: rng(10, 100),
    },
    recent_assignments: Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      assignment_type: i % 2 === 0 ? 'full_company' : 'specific_staff',
      status: ['in_progress','converted','assigned','lost'][i],
      staff_count_at_assignment: rng(50, 800),
      assigned_at: isoDate(rng(10, 120)),
      sales_agent_name: ['Chidi Okeke','Amina Bello','Kemi Ade','Taiwo Ojo'][i],
      contacts_created: rng(10, 150),
      converted: rng(2, 40),
    })),
  })),

  // Cards ops agent queue
  http.get(u('/api/cards/my-queue'), () => wd({
    issuance_assigned: 14, disputes_assigned: 8, processed_today: 11, avg_processing_time_hrs: 3.2,
    issuance_queue: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      request_ref: `ISS-2025-${String(1000 + i).padStart(4, '0')}`,
      customer_name: ['Emeka Obi','Fatima Musa','Adunola Bello','Taiwo Ade','Ngozi Eze','Blessing Obi','Kemi Ade','Chidi Okafor','Amina Bello','David Mensah'][i],
      cif: `000${String(27000 + i).padStart(5, '0')}`,
      card_type: ['Credit — Green','Credit — Gold','Prepaid NGN','Prepaid USD','Credit — Platinum','Credit — Green','Prepaid NGN','Credit — Gold','Credit — Green','Prepaid USD'][i],
      requested_at: new Date(Date.now() - i * 3_600_000 * 6).toISOString(),
      status: ['pending','in_review','approved','pending','in_review','pending','approved','pending','in_review','pending'][i],
      priority: ['normal','high','normal','urgent','normal','high','normal','normal','urgent','normal'][i],
    })),
    disputes_queue: Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      dispute_ref: `DIS-2025-${String(500 + i).padStart(4, '0')}`,
      customer_name: ['Emeka Obi','Fatima Musa','Adunola Bello','Taiwo Ade','Ngozi Eze','Blessing Obi','Kemi Ade'][i],
      cif: `000${String(27000 + i).padStart(5, '0')}`,
      amount_kobo: Math.round(50_000_00 + Math.random() * 500_000_00),
      dispute_type: ['Unauthorized transaction','Merchant dispute','ATM withdrawal','POS double charge','Web fraud','Card skimming','Subscription charge'][i],
      raised_at: new Date(Date.now() - i * 86_400_000).toISOString(),
      status: ['open','investigating','open','pending_merchant','open','escalated','open'][i],
    })),
  })),
]

export const handlers = [
  ...AUTH,
  ...NOTIF_APPROVALS,
  ...OVERVIEW,
  ...SALES,
  ...CRM,
  ...LOS,
  ...COLLECTIONS,
  ...RECOVERY,
  ...CARDS,
  ...FINANCE,
  ...RISK,
  ...COMPLIANCE,
  ...HELPDESK,
  ...BD,
  ...CAMPAIGNS,
  ...ADMIN,
  ...SETTINGS,
  ...MAIL,
  ...SETTLEMENTS,
  ...REPORTS,
  ...BI,
  ...ADMIN_EXTRA,
  ...COLLECTIONS_EXTRA,
  ...COMPLIANCE_EXTRA,
  ...SALES_EXTRA,
  ...REPORTS_EXTRA,
  ...DIALER_EXTRA,
  ...TELEMARKETING_EXTRA,
  ...MARKETING_EXTRA,
  ...USER_MISC,
  ...CONTACTS_EXTRA,
  ...CAMPAIGNS_DETAIL,
  ...CONTACT_LISTS_DETAIL,
  ...GAP_FILL,
  ...EXECUTIVE_DEPT,
  ...MOCK_GAPS,
  ...CATCH_ALL,
]
