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
  http.post(u('/api/auth/change-password'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/auth/logout'),        () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/auth/refresh'),       () => ok({ access_token: 'mock', token_type: 'bearer' })),
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
    leads: 2140, applications: 892, approved: 634, disbursed: 521,
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
    new_contacts_mtd: 142, deals_closed_mtd: 38, revenue_mtd_kobo: 284_000_000_00,
    conversion_rate_pct: 26.8, avg_deal_size_kobo: 74_700_000_00,
  })),
  http.get(u('/api/crm/reports/pipeline'), () => ok([
    { stage:'Prospecting', count: 42, value_kobo: 840_000_000_00 },
    { stage:'Qualification', count: 28, value_kobo: 560_000_000_00 },
    { stage:'Proposal', count: 18, value_kobo: 432_000_000_00 },
    { stage:'Negotiation', count: 9, value_kobo: 270_000_000_00 },
  ])),
  http.get(u('/api/crm/reports/contacts-by-source'), () => ok([
    { source:'Referral', count: 180 }, { source:'Walk-in', count: 142 },
    { source:'Online', count: 98 }, { source:'Campaign', count: 74 }, { source:'BD', count: 46 },
  ])),
  http.get(u('/api/crm/reports/agent-performance'), () => ok(
    Array.from({ length: 8 }, () => ({ agent_name: name(), contacts_added: rng(20,80),
      deals_closed: rng(5,25), revenue_kobo: rng(20,120)*1_000_000_00, conversion_rate_pct: rng(15,40) }))
  )),
  http.get(u('/api/crm/reports/new-contacts-trend'), () => ok(
    MONTHS_ISO.map(m => ({ month: m, count: rng(80,200) }))
  )),
]

// ── LOS ───────────────────────────────────────────────────────────────────────

const LOS_ROWS = Array.from({ length: 28 }, (_, i) => ({
  id: i+1, reference: `LA-2026-${String(i+100).padStart(4,'0')}`,
  applicant_name: name(), product_type: pick(LOS_PRODUCTS),
  amount_requested_kobo: rng(5,80)*1_000_000_00,
  stage: pick(LOS_STAGES), status: pick(['pending','in_review','approved','rejected']),
  assigned_officer_name: name(), submitted_at: isoDate(rng(1,21)),
  updated_at: isoDate(rng(0,3)), created_at: isoDate(rng(2,30)),
}))

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
    id: params.id, reference: `LA-2026-${params.id}`, applicant_name: name(),
    product_type: 'Payday Loan', amount_requested_kobo: 25_000_000_00,
    stage: 'risk_review', status: 'in_review', assigned_officer_name: name(),
    submitted_at: isoDate(5), updated_at: isoDate(1), created_at: isoDate(7),
    bvn: '22345678901', nin: '12345678901', employer: 'Shell Nigeria',
    monthly_income_kobo: 45_000_000_00, monthly_obligations_kobo: 12_000_000_00, loan_term_months: 6,
    documents: [
      { id:1, doc_type:'ID', filename:'national_id.pdf', url:'#' },
      { id:2, doc_type:'Payslip', filename:'payslip_may.pdf', url:'#' },
    ],
    notes: [], timeline: [],
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
      agent_name: pick([name(), null]), dpd_bucket: pick(['1-30','31-60','61-90','90+']),
      outstanding_kobo: rng(10,100)*1_000_000_00, current_stage: pick(['initial_call','follow_up','escalated',null]),
      notes: null, last_contact_at: pick([isoDate(rng(1,14)), null]),
    }))
  )),
  http.get(u('/api/collections-ops/promises'), () => wd(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, account_cif: `CIF${String(i+100000).padStart(7,'0')}`,
      customer_name: name(), outstanding_kobo: rng(50,500)*100_000,
      promise_amount_kobo: rng(5,50)*100_000, promise_date: dateStr(rng(-5,14)),
      status: pick(['pending','kept','broken']), officer_name: name(), created_at: isoDate(rng(1,10)),
    }))
  )),
  http.get(u('/api/collections-ops/repayment-plans'), () => wd(
    Array.from({ length: 15 }, (_, i) => ({
      id: i+1, account_cif: `CIF${String(i+100000).padStart(7,'0')}`, customer_name: name(),
      plan_ref: `RP-2026-${i+100}`, installment_kobo: rng(10,100)*100_000,
      frequency: pick(['monthly','weekly','bi_weekly']), status: pick(['active','completed','defaulted']),
      start_date: dateStr(rng(1,90)), next_payment_date: dateStr(rng(-5,30)),
      installments_paid: rng(0,12), total_installments: 12,
    }))
  )),
  http.get(u('/api/collections-ops/repayment-plans/:id/instalments'), () => wd(
    Array.from({ length: 12 }, (_, i) => ({
      id: i+1, due_date: dateStr(-(i*30)), amount_kobo: 50_000_00,
      status: i < 3 ? 'paid' : 'due', paid_at: i < 3 ? isoDate(i*30) : null,
    }))
  )),
  http.get(u('/api/collections-ops/writeoffs'), () => wd(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, account_cif: `CIF${String(i+100000).padStart(7,'0')}`, customer_name: name(),
      outstanding_kobo: rng(20,200)*1_000_000_00, dpd: rng(90,365),
      status: pick(['pending','approved','rejected']), requested_by: name(), requested_at: isoDate(rng(1,14)),
    }))
  )),
  http.post(u('/api/collections-ops/writeoffs/bulk-approve'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/collections-ops/promises'), () => ok({ id: 99 })),
  http.put(u('/api/collections-ops/promises/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/collections-ops/queue/bulk-assign'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/collections/promise-kpis'), () => wd({ total: 247, kept: 138, broken: 64, amount_promised_kobo: 8_420_000_000_00 })),
  http.get(u('/api/collections/repayment-kpis'), () => wd({ active: 86, on_track: 61, behind: 25, monthly_due_kobo: 1_240_000_000_00 })),
  http.get(u('/api/collections/writeoff-kpis'), () => wd({ total: 42, amount_kobo: 3_200_000_000_00, recovery_rate_pct: 18.4, pending: 8 })),
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
    Array.from({ length: 8 }, () => ({ agent_name: name(), recovered_kobo: rng(5,40)*1_000_000_00, cases: rng(5,30) }))
  )),
  http.get(u('/api/recovery/tpa-agencies'), () => wd(
    Array.from({ length: 6 }, (_, i) => ({
      id: i+1, name: pick(['DebtBusters NG','Swift Recovery','Eagle Collections','Apex Debt']),
      status: 'active', cases_assigned: rng(10,40), recovered_kobo: rng(5,30)*1_000_000_00,
      commission_pct: pick([8,10,12,15]), contact_name: name(), phone: `080${rng(10000000,99999999)}`,
    }))
  )),
  http.post(u('/api/recovery/tpa-agencies'), () => ok({ id: 99 })),
  http.put(u('/api/recovery/tpa-agencies/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/recovery/tpa-agencies/:id/accounts'),    () => wd([])),
  http.get(u('/api/recovery/tpa-agencies/:id/performance'), () => wd({ recovered_kobo: 12_000_000_00, cases: 18, rate_pct: 42 })),
  http.get(u('/api/recovery/legal'), () => wd(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, case_ref: `LE-2026-${i+100}`, customer_name: name(),
      outstanding_kobo: rng(50,500)*1_000_000_00, account_cif: `CIF${i+100000}`,
      court: pick(['Lagos High Court','FCT High Court']),
      status: pick(['pending','active','judgment','closed']),
      lawyer: name(), hearing_date: dateStr(rng(-30,60)), filed_date: dateStr(rng(30,180)),
    }))
  )),
  http.get(u('/api/recovery/cases/:id/legal-milestones'), () => wd([])),
  http.get(u('/api/recovery/legal-kpis'), () => wd({
    total_cases: 38, active: 24, won: 7, total_debt_recovered_kobo: 142_500_000_00,
  })),
  http.get(u('/api/recovery/debt-sales'), () => ok([])),
  // recovery-ops cases
  http.get(u('/api/recovery-ops/cases'), () => wd(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, case_ref: `RC-2026-${String(i+100).padStart(4,'0')}`,
      account_cif: `CIF${String(i+100000).padStart(7,'0')}`,
      assigned_agent_id: rng(1,8), agent_name: name(),
      legal_stage: pick(['initial_call','field_visit','legal',null]),
      outstanding_kobo: rng(10,100)*1_000_000_00, recovered_kobo: rng(0,20)*1_000_000_00,
      dpd: rng(90,400), last_contact_at: pick([isoDate(rng(0,14)), null]),
      status: pick(['active','closed','legal']),
    }))
  )),
  http.get(u('/api/recovery-ops/cases/:id'), () => ok({
    id: 1, case_ref: 'RC-2026-0001', account_cif: 'CIF1000001', agent_name: name(),
    outstanding_kobo: 25_000_000_00, recovered_kobo: 4_000_000_00, dpd: 120,
    notes: [], visits: [], calls: [],
  })),
  http.post(u('/api/recovery-ops/cases'), () => ok({ id: 99 })),
  http.put(u('/api/recovery-ops/cases/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/recovery-ops/cases/:id/notes'), () => ok({ id: 1 })),
  http.post(u('/api/recovery-ops/cases/bulk-assign'), () => new HttpResponse(null, { status: 204 })),
]

// ── Cards ─────────────────────────────────────────────────────────────────────
// Overview endpoints return direct types (no { data } wrapper)

const CARDS = [
  http.get(u('/api/cards/kpis'), () => ok({
    total_cards: 16246, active_cards: 14820, suspended: 842, blocked: 584,
    disputes_open: 14, chargebacks_mtd: 7, total_outstanding_kobo: 248_610_000_00,
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
      customer: name(), amount: rng(5,200)*100_000, dr_cr: pick(['DR','CR']),
      narration: pick(['Salary Credit','Loan Repayment','Card Payment','Transfer']),
      product_code: pick(['GRN','GLD','PLT','PRP','CRD']),
    })),
    total: 18420,
  })),

  // Fixed Deposit
  http.get(u('/api/fixed-deposit/summary'), () => ok(FD_SUMMARY)),
  http.get(u('/api/fixed-deposit/trend'), () => ok(
    MONTHS_ISO.map(m => ({ month: m, total_book_kobo: rng(900,1400)*1_000_000_00, new_fds: rng(15,40), matured: rng(5,20) }))
  )),
  http.get(u('/api/fixed-deposit/transactions'), () => wd(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, reference: `FD-2026-${String(i+100).padStart(4,'0')}`, customer_name: name(),
      principal_kobo: rng(50,500)*1_000_000_00, tenor_days: pick([30,60,90,180,365]),
      rate_pct: pick([8.5,9.0,10.0,11.5,12.0]),
      status: pick(['active','matured','liquidated','pending']),
      start_date: dateStr(rng(0,180)), maturity_date: dateStr(rng(-30,185)),
      bank: pick(BANKS), interest_kobo: rng(2,50)*1_000_000_00,
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
    total_income_kobo: 184_000_000_00, interest_income_kobo: 142_000_000_00,
    fee_income_kobo: 28_000_000_00, card_income_kobo: 14_000_000_00,
  })),
  http.get(u('/api/finance/income/chart'), () => ok(
    MONTHS_ISO.map(m => ({ month: m, income_kobo: rng(60,140)*1_000_000_00, expense_kobo: rng(30,80)*1_000_000_00 }))
  )),
  http.get(u('/api/finance/income/loans'), () => ok(
    MONTHS_ISO.map(m => ({ month: m, interest_income_kobo: rng(40,90)*1_000_000_00, fee_income_kobo: rng(5,20)*1_000_000_00 }))
  )),
  http.get(u('/api/finance/income/fee-types'), () => ok({
    data: [
      { fee_type: 'Origination Fee', amount_kobo: 18_000_000_00 },
      { fee_type: 'Late Payment Fee', amount_kobo: 6_400_000_00 },
      { fee_type: 'Management Fee', amount_kobo: 3_600_000_00 },
    ],
  })),
  http.get(u('/api/finance/pnl'), () => ok({
    revenue_kobo: 184_000_000_00, expenses_kobo: 112_000_000_00, net_profit_kobo: 72_000_000_00,
    rows: MONTHS_ISO.map(m => ({ month: m, revenue_kobo: rng(20,40)*1_000_000_00, expenses_kobo: rng(10,25)*1_000_000_00 })),
  })),
]

// ── Risk ──────────────────────────────────────────────────────────────────────

const RISK = [
  http.get(u('/api/risk/portfolio-kpis'), () => wd({
    par30_pct: 5.0, par60_pct: 2.0, par90_pct: 0.9, npl_pct: 1.4,
    coverage_ratio_pct: 142.0, total_outstanding_kobo: 4_820_000_000_00, provision_kobo: 67_500_000_00,
  })),
  http.get(u('/api/risk/par-trend'), () => wd(
    MONTHS_ISO.map(m => ({ month: m, par30: rng(4,8), par60: rng(1,4), par90: rng(0,2) }))
  )),
  http.get(u('/api/risk/band-distribution'), () => wd([
    { band:'Current (0 DPD)',  count: 3837, outstanding_kobo: 4_340_000_000_00 },
    { band:'1–30 DPD',         count: 241,  outstanding_kobo: 241_000_000_00 },
    { band:'31–60 DPD',        count: 98,   outstanding_kobo: 98_000_000_00 },
    { band:'61–90 DPD',        count: 42,   outstanding_kobo: 42_000_000_00 },
    { band:'91+ DPD',          count: 28,   outstanding_kobo: 99_000_000_00 },
  ])),
  http.get(u('/api/risk/sector-concentration'), () => wd([
    { sector:'Salary Earners', outstanding_kobo: 2_840_000_000_00, count: 2814 },
    { sector:'SME',            outstanding_kobo: 980_000_000_00,  count: 612 },
    { sector:'Civil Servants', outstanding_kobo: 640_000_000_00,  count: 492 },
    { sector:'Pensioners',     outstanding_kobo: 360_000_000_00,  count: 300 },
  ])),
  http.get(u('/api/risk/top-employers'), () => wd(
    Array.from({ length: 10 }, () => ({
      employer: pick(['Shell Nigeria','MTN Nigeria','Dangote Group','Access Bank','NNPC','NLNG']),
      outstanding_kobo: rng(50,500)*1_000_000_00, accounts: rng(20,200), avg_score: rng(620,780),
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
      id: i+1, cif: `CIF${String(i+100000).padStart(7,'0')}`, customer_name: name(),
      score: rng(400,850), band: pick(['low','medium','high']), scored_at: isoDate(rng(0,30)),
    })),
    total: 100,
  })),
  http.get(u('/api/risk/vintage-kpis'), () => wd({
    avg_par30_pct: 4.8, avg_par90_pct: 1.2, best_vintage: '2025-Q3', worst_vintage: '2025-Q1',
  })),
  http.get(u('/api/risk/vintage'), () => wd(
    ['2025-Q1','2025-Q2','2025-Q3','2026-Q1','2026-Q2'].map(v => ({
      vintage: v, disbursed_kobo: rng(200,600)*1_000_000_00, par30_pct: rng(2,10), par90_pct: rng(0,3),
    }))
  )),
  http.get(u('/api/risk/credit-file/:cif'), () => ok({
    cif: 'CIF1000001', full_name: name(), score: 682, band: 'medium',
    income_kobo: 45_000_000_00, dti_pct: 28.4, employer: 'Shell Nigeria',
    loans: [], flags: [],
  })),
  http.get(u('/api/risk/app-review'), () => ok({ data: [], total: 0 })),
]

// ── HR ────────────────────────────────────────────────────────────────────────
// All return direct arrays

const HR_EMPLOYEES = Array.from({ length: 42 }, (_, i) => {
  const fn = pick(FIRST), ln = pick(LAST)
  return {
    id: i+1, staff_id: `O3-${String(i+100).padStart(4,'0')}`,
    first_name: fn, last_name: ln, email: email(`${fn} ${ln}`),
    phone: `080${rng(10000000,99999999)}`, department: pick(DEPTS),
    job_title: pick(['Officer','Senior Officer','Head','Manager','Analyst']),
    grade_level: pick(['GL1','GL2','GL3','GL4','GL5','GL6']),
    status: Math.random() > 0.1 ? 'active' : 'inactive',
    date_of_birth: dateStr(rng(8000,12000)), gender: pick(['Male','Female']),
    salary_kobo: rng(20,120)*1_000_000_00, bank_name: pick(BANKS),
    account_number: String(rng(1000000000,9999999999)), contract_type: pick(['Full-Time','Contract']),
    hire_date: dateStr(rng(180,1800)),
  }
})

const HR = [
  http.get(u('/api/hr/employees'), () => ok(HR_EMPLOYEES)),
  http.get(u('/api/hr/employees/:id'), ({ params }) => ok({ ...HR_EMPLOYEES[Number(params.id) % HR_EMPLOYEES.length] })),
  http.get(u('/api/hr/employees/:id/leave-balance'), () => ok([])),
  http.post(u('/api/hr/employees'), () => ok({ id: 99, staff_id: 'O3-0199' })),
  http.put(u('/api/hr/employees/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/hr/employees/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/hr/departments'), () => ok(
    DEPTS.map((n, i) => ({ id: i+1, name: n, head_name: name(), staff_count: rng(3,18) }))
  )),
  http.get(u('/api/hr/grade-levels'), () => ok(
    ['GL1','GL2','GL3','GL4','GL5','GL6'].map((g, i) => ({
      id: i+1, name: g, min_salary_kobo: (i+1)*20_000_000_00, max_salary_kobo: (i+2)*30_000_000_00,
    }))
  )),
  http.get(u('/api/hr/leave'), () => ok(
    Array.from({ length: 14 }, (_, i) => ({
      id: i+1, employee_name: name(), leave_type: pick(['Annual','Sick','Maternity','Casual']),
      start_date: dateStr(rng(-10,60)), end_date: dateStr(rng(61,75)), days: rng(2,21),
      status: pick(['pending','approved','rejected']), approved_by: name(), applied_at: isoDate(rng(1,14)),
    }))
  )),
  http.post(u('/api/hr/leave'), () => ok({ id: 99, status: 'pending' })),
  http.put(u('/api/hr/leave/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/hr/leave-types'), () => ok(
    ['Annual','Sick','Maternity','Paternity','Casual','Study'].map((t, i) => ({ id: i+1, name: t, default_days: pick([5,10,14,21,30]) }))
  )),
  http.get(u('/api/hr/appraisals'), () => ok(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, employee_name: name(), period: '2026 H1', score: rng(60,100),
      rating: pick(['Outstanding','Exceeds Expectations','Meets Expectations','Below Expectations']),
      reviewer_name: name(), status: pick(['pending','submitted','approved']),
    }))
  )),
  http.post(u('/api/hr/appraisals'), () => ok({ id: 99 })),
  http.get(u('/api/hr/review-cycles'), () => ok([
    { id: 1, name: '2026 H1', start_date: '2026-01-01', end_date: '2026-06-30', status: 'active' },
    { id: 2, name: '2025 H2', start_date: '2025-07-01', end_date: '2025-12-31', status: 'completed' },
  ])),
  http.get(u('/api/hr/training'), () => ok(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, title: pick(['AML/CFT Training','Data Protection','Leadership Workshop','Risk Management']),
      facilitator: name(), start_date: dateStr(rng(-30,60)), end_date: dateStr(rng(61,75)),
      attendees: rng(5,25), status: pick(['scheduled','ongoing','completed']),
    }))
  )),
  http.post(u('/api/hr/training'), () => ok({ id: 99 })),
  http.get(u('/api/hr/disciplinary'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, employee_name: name(), case_type: pick(['Query','Warning','Suspension']),
      description: 'Policy violation', status: pick(['open','closed']),
      raised_by: name(), raised_at: isoDate(rng(1,90)), resolved_at: null,
    }))
  )),
  http.get(u('/api/hr/disciplinary/:id'), ({ params }) => ok({
    id: params.id, employee_name: name(), case_type: 'Query', description: 'Policy violation',
    status: 'open', raised_by: name(), raised_at: isoDate(5), resolved_at: null, notes: [],
  })),
  http.post(u('/api/hr/disciplinary'), () => ok({ id: 99 })),
  http.put(u('/api/hr/disciplinary/:id'), () => new HttpResponse(null, { status: 204 })),
]

// ── Payroll ───────────────────────────────────────────────────────────────────

const PAYROLL_RUNS = Array.from({ length: 6 }, (_, i) => ({
  id: i+1, period_year: 2026, period_month: 7 - i,
  status: i === 0 ? 'draft' : 'paid',
  total_gross_kobo: rng(80,95)*1_000_000_00, headcount: 42,
  processed_at: isoDate(rng(1,30) + i*30),
}))

const PAYROLL = [
  http.get(u('/api/payroll/summary'), () => ok({
    runs: PAYROLL_RUNS, active_employees: 42,
  })),
  http.get(u('/api/payroll/runs'), () => ok(PAYROLL_RUNS)),
  http.post(u('/api/payroll/runs'), () => ok({ id: 99, status: 'draft', period_year: 2026, period_month: 8 })),
  http.get(u('/api/payroll/runs/:id'), ({ params }) => ok(PAYROLL_RUNS[Number(params.id) % PAYROLL_RUNS.length] ?? PAYROLL_RUNS[0])),
  http.get(u('/api/payroll/runs/:id/items'), () => ok(
    HR_EMPLOYEES.slice(0,20).map(e => ({
      id: e.id, employee_id: e.id, employee_name: `${e.first_name} ${e.last_name}`,
      staff_id: e.staff_id, department: e.department, grade_level: e.grade_level,
      gross_kobo: e.salary_kobo, net_kobo: Math.floor(e.salary_kobo*0.82),
      tax_kobo: Math.floor(e.salary_kobo*0.12), pension_kobo: Math.floor(e.salary_kobo*0.06),
      bank_name: e.bank_name, account_number: e.account_number,
    }))
  )),
  http.post(u('/api/payroll/runs/:id/process'), () => new HttpResponse(null, { status: 204 })),
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

const TICKETS = Array.from({ length: 48 }, (_, i) => ({
  id: i+1, ticket_ref: `TKT-2026-${String(i+1000).padStart(5,'0')}`,
  subject: pick(TICKET_SUBJECTS), status: pick(['open','in_progress','pending_customer','resolved','closed']),
  priority: pick(['low','medium','high','urgent']), channel: pick(['email','phone','walk_in','web']),
  ticket_type: pick(['complaint','enquiry','request','feedback']),
  customer_name: name(), customer_phone: `080${rng(10000000,99999999)}`,
  assigned_to_name: name(), sla_breached: Math.random() < 0.12,
  created_at: isoDate(rng(0,14)), updated_at: isoDate(rng(0,3)),
}))

const HELPDESK = [
  http.get(u('/api/helpdesk/tickets'), () => ok({ tickets: TICKETS, total: TICKETS.length })),
  http.get(u('/api/helpdesk/tickets/:id'), ({ params }) => ok({
    ...TICKETS[Number(params.id) % TICKETS.length],
    messages: [
      { id:1, body:'Thank you for contacting us.', sender_name:'Support Agent', direction:'outbound', created_at:isoDate(1) },
      { id:2, body:'Please provide your account number.', sender_name:'Customer', direction:'inbound', created_at:isoDate(0) },
    ],
    timeline: [],
  })),
  http.get(u('/api/helpdesk/tickets/:id/context'), () => ok({ customer: null, loans: [], cards: [] })),
  http.post(u('/api/helpdesk/tickets'), () => ok({ id: 99, ticket_ref: 'TKT-2026-01099' })),
  http.patch(u('/api/helpdesk/tickets/:id'), () => new HttpResponse(null, { status: 204 })),
  http.put(u('/api/helpdesk/tickets/:id'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/helpdesk/tickets/:id/reply'), () => ok({ id: 99, body: 'Reply sent' })),
  http.post(u('/api/helpdesk/tickets/bulk-assign'), () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/helpdesk/tickets/bulk-close'),  () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/tickets/search'), () => ok([])),
  http.get(u('/api/helpdesk/stats'), () => ok({
    open: 48, sla_breached: 7, avg_first_response_hours: 0.28, avg_csat: 4.3,
    agents: Array.from({ length: 6 }, () => ({
      agent_name: name(), open_tickets: rng(2,8), resolved_today: rng(3,10),
      avg_csat: rng(38,50)/10, avg_handle_time_min: rng(8,25), escalations: rng(0,2),
    })),
    by_channel: [
      { channel:'email', count: 18 }, { channel:'phone', count: 14 },
      { channel:'walk_in', count: 8 }, { channel:'web', count: 6 },
    ],
    by_type: [
      { type:'complaint', count: 24 }, { type:'enquiry', count: 16 },
      { type:'request', count: 6 }, { type:'feedback', count: 2 },
    ],
  })),
  http.get(u('/api/helpdesk/agents'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, full_name: name(), open_tickets: rng(2,12), resolved_today: rng(3,10),
      avg_handle_mins: rng(8,25), status: pick(['available','busy','offline']),
    }))
  )),
  http.put(u('/api/helpdesk/agents/:id/status'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/supervisor'), () => ok({
    totals: { open: 48, sla_breached: 7, unassigned: 12, active_agents: 6 },
    agents: Array.from({ length: 6 }, (_, i) => ({
      id: i+1, full_name: name(), open_tickets: rng(2,8), sla_breached: rng(0,2),
      last_reply: isoDate(rng(0,1)),
      current_ticket_ref: `TKT-${rng(1000,9999)}`,
      helpdesk_status: pick(['available','on_call','busy','offline']),
    })),
    queues: [
      { queue: 'General', open: 18, sla_breached: 3, unassigned: 5 },
      { queue: 'Cards', open: 12, sla_breached: 2, unassigned: 4 },
      { queue: 'Loans', open: 10, sla_breached: 1, unassigned: 2 },
      { queue: 'Compliance', open: 8, sla_breached: 1, unassigned: 1 },
    ],
    recent_breaches: Array.from({ length: 5 }, (_, i) => ({
      id: i+1, ticket_ref: `TKT-${rng(1000,9999)}`,
      subject: pick(['Card blocked without reason','Loan repayment not reflected','Account locked']),
      priority: pick(['high','critical','medium']),
      sla_due_at: isoDate(0),
      assigned_to_name: name(),
    })),
    by_type: [
      { ticket_type: 'complaint', count: 24 }, { ticket_type: 'enquiry', count: 16 },
      { ticket_type: 'request', count: 6 }, { ticket_type: 'feedback', count: 2 },
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
  http.get(u('/api/helpdesk/routing-rules'), () => ok([])),
  http.delete(u('/api/helpdesk/routing-rules/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/helpdesk/calls'), () => ok([])),
  // Stats sub-endpoints
  http.get(u('/api/helpdesk/csat-trend'), () => wd(MONTHS_ISO.map(m => ({ month: m, avg_csat: rng(38,50)/10 })))),
  http.get(u('/api/helpdesk/handle-time-by-type'), () => wd([
    { type:'complaint', avg_mins: 18 }, { type:'enquiry', avg_mins: 9 }, { type:'request', avg_mins: 12 },
  ])),
  http.get(u('/api/helpdesk/resolution-by-agent'), () => wd(
    Array.from({ length: 6 }, () => ({ agent_name: name(), resolved: rng(10,40), avg_mins: rng(8,25) }))
  )),
  http.get(u('/api/helpdesk/type-distribution'), () => wd([
    { type:'complaint', count: 24 }, { type:'enquiry', count: 16 }, { type:'request', count: 8 },
  ])),
  http.get(u('/api/helpdesk/stats/leaderboard'), () => wd(
    Array.from({ length: 6 }, () => ({ agent_name: name(), resolved: rng(20,60), csat: rng(40,50)/10 }))
  )),
  http.get(u('/api/helpdesk/stats/sla-by-agent'), () => wd(
    Array.from({ length: 6 }, () => ({ agent_name: name(), sla_met: rng(80,100), breached: rng(0,10) }))
  )),
  http.get(u('/api/helpdesk/stats/busiest-hours'), () => wd(
    Array.from({ length: 10 }, (_, h) => ({ hour: h + 8, count: rng(5,30) }))
  )),
  http.get(u('/api/helpdesk/stats/channel-breakdown'), () => wd([
    { channel:'email', count: 18 }, { channel:'phone', count: 14 },
    { channel:'walk_in', count: 8 }, { channel:'web', count: 6 },
  ])),
]

// ── BD ────────────────────────────────────────────────────────────────────────

const BD_EMPLOYERS = Array.from({ length: 20 }, (_, i) => ({
  id: i+1, name: pick(['Shell Nigeria','MTN','Dangote','First Bank','NNPC','Unilever','Guinness','NB Plc']),
  sector: pick(['Oil & Gas','Telecoms','FMCG','Banking','Manufacturing']),
  staff_count: rng(50,5000), active_loans: rng(10,200),
  loan_book_kobo: rng(20,400)*1_000_000_00,
  mou_status: pick(['signed','pending','expired','none']),
  mou_signed_date: dateStr(rng(60,365)), mou_expiry_date: dateStr(rng(-30,180)),
  contact_name: name(), contact_email: `bd${i}@employer.ng`, state: pick(STATES),
  joined_date: dateStr(rng(100,900)),
}))

const BD_LEADS = Array.from({ length: 20 }, (_, i) => ({
  id: i+1,
  company_name: pick(['Flour Mills Nigeria','Nestle Nigeria','7-Up Bottling','Cadbury Nigeria','PZ Cussons','TOTAL Energies']),
  contact_name: name(), contact_phone: `080${rng(10000000,99999999)}`,
  sector: pick(['FMCG','Manufacturing','Healthcare','Education','Logistics']),
  lead_type: pick(['corporate','sme','government']),
  stage: pick(['prospecting','presentation','proposal','negotiation','won','lost']),
  employee_count: rng(50,2000), potential_value_kobo: rng(50,500)*1_000_000_00,
  assigned_name: name(), updated_at: isoDate(rng(0,14)), created_at: isoDate(rng(1,60)),
}))

const BD = [
  http.get(u('/api/bd/stats'), () => ok({
    pipeline: [
      { stage:'prospecting',  count: 42, total_value_kobo: 420_000_000_00 },
      { stage:'presentation', count: 28, total_value_kobo: 280_000_000_00 },
      { stage:'proposal',     count: 18, total_value_kobo: 180_000_000_00 },
      { stage:'negotiation',  count: 9,  total_value_kobo: 90_000_000_00 },
      { stage:'won',          count: 14, total_value_kobo: 140_000_000_00 },
      { stage:'lost',         count: 6,  total_value_kobo: 60_000_000_00 },
    ],
    employers: { active: 84, mou_signed: 61, mou_expiring: 8 },
  })),
  http.get(u('/api/bd/employers'), () => ok(BD_EMPLOYERS)),
  http.post(u('/api/bd/employers'), () => ok({ id: 99 })),
  http.put(u('/api/bd/employers/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/bd/leads'), () => ok(BD_LEADS)),
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
  http.get(u('/api/campaigns/analytics'), () => ok({ delivered: 4200, opened: 1800, clicked: 420, bounced: 38 })),
  http.get(u('/api/campaigns/:id/analytics'), () => ok({ delivered: 4200, opened: 1800, clicked: 420, bounced: 38 })),

  http.get(u('/api/contact-lists'), () => ok(
    Array.from({ length: 6 }, (_, i) => ({
      id: i+1, name: pick(['All Salary Earners','Delinquent Customers','High-Value Borrowers','New Applicants']),
      member_count: rng(200,5000),
    }))
  )),
  http.post(u('/api/contact-lists'), () => ok({ id: 99 })),
  http.delete(u('/api/contact-lists/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(u('/api/message-templates'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, name: pick(['Loan Offer','Payment Reminder','Welcome','Card Upgrade']),
      channel: pick(['email','sms']), subject: 'Your O3 Capital Update',
      body: 'Dear {{name}}, ...', created_by: name(), updated_at: isoDate(rng(0,30)),
    }))
  )),
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
  http.get(u('/api/dialer/sessions/me'), () => ok(null)),
  http.post(u('/api/dialer/sessions'), () => ok({ id: 1, agent_id: 1, status: 'active' })),
  http.delete(u('/api/dialer/sessions'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/dialer/campaigns'), () => ok([])),
  http.post(u('/api/dialer/campaigns'), () => ok({ id: 99 })),
  http.put(u('/api/dialer/campaigns/:id'), () => new HttpResponse(null, { status: 204 })),
  http.delete(u('/api/dialer/campaigns/:id'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/dialer/campaigns/:id/stats'), () => ok({ total: 0, called: 0, converted: 0 })),
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
    { id: 1, email: 'noreply@o3capital.com', name: 'O3 Capital', is_default: true, status: 'verified' },
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
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, from: email(name()), to: 'support@o3capital.com',
      subject: pick(['Re: Loan application','Statement request','Account query','Card issue']),
      preview: 'Hi, I am writing to enquire about...',
      read: Math.random() > 0.4, received_at: isoDate(rng(0,7)), thread_count: rng(1,4),
      has_attachment: Math.random() > 0.7,
    }))
  )),
  http.get(u('/api/mail/messages'), () => ok([])),
  http.get(u('/api/mail/messages/:id'), () => ok({
    id: 1, from: email(name()), to: 'support@o3capital.com', subject: 'Re: Loan application query',
    body: '<p>Dear O3 Capital,</p><p>I would like to enquire about the status of my loan application.</p>',
    received_at: isoDate(1), attachments: [], thread: [],
  })),
  http.get(u('/api/mail/drafts'), () => ok([])),
  http.get(u('/api/mail/drafts/:id'), () => ok({ id: 1, subject: '', body: '', to: '' })),
  http.post(u('/api/mail/send'), () => ok({ id: 99, status: 'sent' })),
  http.get(u('/api/mail/signature'), () => ok({ html: '<p>Best regards,<br>O3 Capital Support</p>' })),
  http.put(u('/api/mail/signature'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/mail/metrics'), () => ok({
    delivered: 4820, opened: 2140, clicked: 482, bounced: 38,
    open_rate_pct: 44.4, click_rate_pct: 10.0, bounce_rate_pct: 0.8,
  })),
  http.get(u('/api/mail/deliverability'), () => ok({
    spam_rate_pct: 0.2, reputation_score: 98, dkim_pass: true, spf_pass: true, dmarc_pass: true,
  })),
  http.get(u('/api/mail/suppressions'), () => ok([])),
  http.post(u('/api/mail/test'), () => ok({ status: 'sent' })),
]

// ── Settlements ───────────────────────────────────────────────────────────────

const SETTLEMENTS = [
  http.get(u('/api/settlements/kpis'), () => wd({
    pending_kobo: 42_000_000_00, settled_mtd_kobo: 312_000_000_00, failed_count: 3, avg_settlement_hrs: 1.8,
  })),
  http.get(u('/api/settlements'), () => wd(
    Array.from({ length: 10 }, (_, i) => ({
      id: i+1, reference: `SET-2026-${i+100}`, amount_kobo: rng(10,100)*1_000_000_00,
      status: pick(['pending','settled','failed']), bank: pick(BANKS),
      initiated_by: name(), created_at: isoDate(rng(0,14)),
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
    Array.from({ length: 6 }, (_, i) => ({
      id: i+1, period: MONTHS_ISO[6-i] ?? '2026-01',
      status: i === 0 ? 'pending' : 'sent',
      total_sent: rng(800,1400), failed: rng(0,20),
      triggered_by: name(), triggered_at: isoDate(rng(0,30) + i*30),
    }))
  )),
  http.post(u('/api/statements/send'), () => ok({ status: 'queued', count: 1 })),
  http.post(u('/api/statements/bulk-send'), () => ok({ status: 'queued', count: 1247, eligible: 1247 })),
  http.post(u('/api/statements/runs/:id/retry'),  () => new HttpResponse(null, { status: 204 })),
  http.post(u('/api/statements/runs/:id/cancel'), () => new HttpResponse(null, { status: 204 })),
  http.get(u('/api/statements/emails'), () => ok([])),

  // Customer 360
  http.get(u('/api/customer360/search'), () => ok({
    data: Array.from({ length: 3 }, (_, i) => ({
      id: i+1, cif: `CIF${String(i+100000).padStart(7,'0')}`, full_name: name(),
      phone: `080${rng(10000000,99999999)}`, status: 'active',
    })),
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
  ...HR,
  ...PAYROLL,
  ...COMPLIANCE,
  ...HELPDESK,
  ...BD,
  ...CAMPAIGNS,
  ...ADMIN,
  ...SETTINGS,
  ...MAIL,
  ...SETTLEMENTS,
  ...REPORTS,
  ...CATCH_ALL,
]
