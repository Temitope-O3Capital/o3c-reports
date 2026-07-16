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
  http.post(u('/api/collections/promises'), () => ok({ id: 99 })),
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
    MONTHS_ISO.map(m => ({ month: m, par30: rng(4,8), par60: rng(1,4), par90: rng(0,2) }))
  )),
  http.get(u('/api/risk/band-distribution'), () => wd([
    { band:'Current (0 DPD)',  count: 3837, outstanding_kobo: 4_340_000_000_00, pct: 88.4 },
    { band:'1–30 DPD',         count: 241,  outstanding_kobo: 241_000_000_00,   pct: 5.0  },
    { band:'31–60 DPD',        count: 98,   outstanding_kobo: 98_000_000_00,    pct: 2.0  },
    { band:'61–90 DPD',        count: 42,   outstanding_kobo: 42_000_000_00,    pct: 0.9  },
    { band:'91+ DPD',          count: 28,   outstanding_kobo: 99_000_000_00,    pct: 2.1  },
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
  headcount: 42,
  total_gross_kobo: rng(80,95)*1_000_000_00,
  total_net_kobo: rng(65,78)*1_000_000_00,
  total_paye_kobo: rng(8,12)*1_000_000_00,
  total_pension_kobo: rng(4,6)*1_000_000_00,
  created_at: isoDate(rng(1,30) + i*30),
  paid_at: i === 0 ? null : isoDate(rng(1,10) + i*30),
}))

const PAYROLL = [
  http.get(u('/api/payroll/summary'), () => ok({
    runs: PAYROLL_RUNS, active_employees: 42,
  })),
  http.get(u('/api/payroll/runs'), () => ok(PAYROLL_RUNS)),
  http.post(u('/api/payroll/runs'), () => ok({ id: 99, status: 'draft', period_year: 2026, period_month: 8 })),
  http.get(u('/api/payroll/runs/:id'), ({ params }) => ok(PAYROLL_RUNS[Number(params.id) % PAYROLL_RUNS.length] ?? PAYROLL_RUNS[0])),
  http.get(u('/api/payroll/runs/:id/items'), () => ok(
    HR_EMPLOYEES.slice(0,20).map((e, i) => ({
      id: e.id, employee_id: e.id, employee_name: `${e.first_name} ${e.last_name}`,
      staff_id: e.staff_id, department: e.department, grade_level: e.grade_level,
      gross_kobo: e.salary_kobo, net_kobo: Math.floor(e.salary_kobo*0.78),
      paye_kobo: Math.floor(e.salary_kobo*0.12),
      employee_pension_kobo: Math.floor(e.salary_kobo*0.06),
      nhf_kobo: Math.floor(e.salary_kobo*0.025),
      loan_deduction_kobo: i % 3 === 0 ? Math.floor(e.salary_kobo*0.05) : 0,
      other_deduction_kobo: 0,
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
  http.get(u('/api/collections-ops/agent-dashboard'), () => ok({
    agent_name: 'Temitope Posi',
    queue_count: 24, ptps_due_today: 8, broken_ptps: 3, calls_today: 12, calls_target: 30,
    dpd_distribution: [
      { band:'1-30', count: 8 }, { band:'31-60', count: 7 },
      { band:'61-90', count: 5 }, { band:'90+', count: 4 },
    ],
    my_accounts: Array.from({ length: 12 }, (_, i) => ({
      id: i+1, customer_name: name(), phone: `080${rng(10000000,99999999)}`,
      outstanding_kobo: rng(10,100)*1_000_000_00, dpd: rng(1,120),
      last_contact: pick([isoDate(rng(1,14)), null]), next_action: pick(['Follow-up call','Send reminder','Escalate', null]),
    })),
  })),
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

// ── HR — New Pages ────────────────────────────────────────────────────────────

const HR_EXTRA = [
  http.get(u('/api/hr/org-chart'), () => ok([
    { id:1, full_name:'Temitope Posi', title:'Managing Director', department:'Executive', manager_id: null },
    { id:2, full_name: name(), title:'Chief Finance Officer', department:'Finance', manager_id: 1 },
    { id:3, full_name: name(), title:'Head of Sales', department:'Sales', manager_id: 1 },
    { id:4, full_name: name(), title:'Head of Collections', department:'Collections', manager_id: 1 },
    { id:5, full_name: name(), title:'Head of Risk', department:'Risk', manager_id: 1 },
    { id:6, full_name: name(), title:'Finance Officer', department:'Finance', manager_id: 2 },
    { id:7, full_name: name(), title:'Finance Officer', department:'Finance', manager_id: 2 },
    { id:8, full_name: name(), title:'Sales Officer', department:'Sales', manager_id: 3 },
    { id:9, full_name: name(), title:'Sales Officer', department:'Sales', manager_id: 3 },
    { id:10, full_name: name(), title:'Collections Agent', department:'Collections', manager_id: 4 },
    { id:11, full_name: name(), title:'Collections Agent', department:'Collections', manager_id: 4 },
    { id:12, full_name: name(), title:'Risk Analyst', department:'Risk', manager_id: 5 },
  ])),

  http.get(u('/api/hr/jobs'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, title: pick(['Sales Officer','Collections Agent','Risk Analyst','Finance Officer','IT Support','Compliance Officer','HR Officer','Recovery Officer']),
      department: pick(DEPTS), location: pick(STATES.slice(0,3)), job_type: pick(['Full-Time','Contract']),
      status: pick(['open','open','open','closed','filled']),
      description: 'We are looking for a motivated professional to join our team.',
      applicant_count: rng(3,25), target_date: pick([dateStr(rng(7,60)), null]),
      created_at: isoDate(rng(1,60)),
    }))
  )),
  http.post(u('/api/hr/jobs'), () => ok({ id: 99 })),

  http.get(u('/api/hr/applicants'), () => ok(
    Array.from({ length: 20 }, (_, i) => ({
      id: i+1, job_id: rng(1,8), job_title: pick(['Sales Officer','Risk Analyst','Finance Officer']),
      full_name: name(), email: `applicant${i}@email.com`,
      phone: `080${rng(10000000,99999999)}`,
      source: pick(['LinkedIn','Referral','Walk-in','Job Board']),
      stage: pick(['applied','screening','interview','offer','hired','rejected']),
      notes: '', interview_date: pick([dateStr(rng(1,14)), null]),
      created_at: isoDate(rng(1,30)),
    }))
  )),
  http.post(u('/api/hr/applicants'), () => ok({ id: 99 })),

  http.get(u('/api/hr/employees/:id/onboarding'), () => ok(
    Array.from({ length: 8 }, (_, i) => ({
      id: i+1, employee_id: 1,
      category: pick(['Documentation','IT Setup','Training','Orientation']),
      task: ['Sign employment contract','Set up email account','Complete AML/CFT training','Tour the office','Meet the team','Set up laptop','ID card issuance','Benefits enrollment'][i],
      status: i < 4 ? 'done' : 'pending',
      due_date: pick([dateStr(rng(0,14)), null]), completed_at: i < 4 ? isoDate(rng(1,7)) : null,
      notes: '', sort_order: i+1,
    }))
  )),
  http.get(u('/api/hr/employees/:id/offboarding'), () => ok(
    Array.from({ length: 6 }, (_, i) => ({
      id: i+1, employee_id: 1,
      category: pick(['Documentation','IT','Finance','Handover']),
      task: ['Collect resignation letter','Revoke system access','Process final salary','Retrieve company assets','Exit interview','Knowledge transfer'][i],
      status: i < 2 ? 'done' : 'pending',
      due_date: pick([dateStr(rng(0,14)), null]), completed_at: i < 2 ? isoDate(rng(1,5)) : null,
      notes: '', sort_order: i+1,
    }))
  )),
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
    return ok({
      id: Number(params.id), name: n, full_name: n,
      phone: `080${rng(10000000,99999999)}`,
      email: `${n.toLowerCase().replace(' ','.')}@example.ng`,
      status: pick(['prospect','qualified','customer']),
      assigned_to: name(),
      company: pick(['MTN Nigeria','Dangote Group','Shell Nigeria','FirstBank',null]),
      created_at: isoDate(rng(30,180)),
      notes: pick(['Interested in salary loan product', 'Already has an active loan', null]),
      deals: Array.from({ length: rng(0,2) }, (_, i) => ({
        id: i+1, title: `${pick(['Salary Loan','Business Loan'])} — ${n}`,
        stage: pick(['Prospecting','Proposal','Negotiation']),
        expected_value_kobo: rng(20,150)*1_000_000_00,
        expected_close: dateStr(-rng(1,30)),
      })),
      activities: Array.from({ length: 4 }, (_, i) => ({
        id: i+1, type: pick(['call','email','meeting','note']),
        note: pick(['Follow-up call completed','Email sent with loan details','Meeting scheduled','KYC docs requested']),
        created_at: isoDate(rng(1,30)), user: name(),
      })),
      tasks: Array.from({ length: rng(1,3) }, (_, i) => ({
        id: i+1, title: pick(['Send loan offer','Follow up on docs','Schedule site visit']),
        due_date: dateStr(-rng(1,7)),
        status: pick(['pending','completed']),
        assigned_to: name(),
      })),
    })
  }),
  http.post(u('/api/crm/activities'), () => new HttpResponse(null, { status: 204 })),
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
  ...BI,
  ...ADMIN_EXTRA,
  ...COLLECTIONS_EXTRA,
  ...COMPLIANCE_EXTRA,
  ...HR_EXTRA,
  ...SALES_EXTRA,
  ...REPORTS_EXTRA,
  ...DIALER_EXTRA,
  ...TELEMARKETING_EXTRA,
  ...MARKETING_EXTRA,
  ...USER_MISC,
  ...CONTACTS_EXTRA,
  ...CATCH_ALL,
]
