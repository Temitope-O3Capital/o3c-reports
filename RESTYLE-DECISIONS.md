# O3 Capital Workspace — Restyle Decisions

Branch: `restyle/workspace-design`  
Source of truth: `frontend/src/pages/WorkspaceDemo.tsx` + migrated Collections module  
Date: 2026-07-07

---

## PAGE INVENTORY (total: 120+ pages across 28 modules)

### ALREADY DONE (carry-in)
- `collections/` — Overview, Queue, Promises, RepaymentPlans, WriteoffQueue ✓
- `collections-ops/` — AgentDashboard ✓

### THIS SESSION — 6 modules (ordered simplest → complex)

| # | Module | Pages | Primary violations |
|---|--------|-------|--------------------|
| 0 | **Shared components** | UI.tsx, NotificationBell.tsx | KpiCard/SectionCard box-shadow; literal font strings in UI.tsx |
| 1 | **Statements** | Statements.tsx (1) | SectionCard shadow; minor font |
| 2 | **Risk** | AppReview, PortfolioHealth, VintageAnalysis, EyeScore, CreditFile (5) | KpiCard 4-grid → hero; shadow; Recharts hex |
| 3 | **Recovery** | Overview, Cases, Legal, TPA, DebtSale (5) | Literal `"'Sora', sans-serif"` in input styles; SectionCard shadow |
| 4 | **BD** | Overview, Pipeline, Employers, Analytics (4) | KpiCard grid; literal font in export buttons |
| 5 | **Settlements** | Overview, Batches, NIP, NIPReconciliation, FailedTransactions, ManualPostings, SettlementBatches (7) | Literal Sora in textareas; `fontFamily: 'inherit'` on buttons |
| 6 | **Admin** | Users, Roles, ApiKeys, AuditLog, SyncStatus, Overview (6) | SectionCard shadow; minor |

### DEFERRED (not in this session — too complex or too many unknown mappings)
- LOS, Helpdesk, Cards, Finance, Sales/CRM, HR, Payroll, Telemarketing, Compliance, Campaigns, Mail, BI/Reports, Marketing, Overview (exec dashboard), Login, Settings, Approvals

---

## DECISIONS

| File | Question | Chose | Why |
|------|----------|-------|-----|
| `UI.tsx` — KpiCard | Shadow removal only vs full hero conversion | Shadow removed, radius 12→8, otherwise kept. Hero conversion done per-module where dominant metric is clear from data interface | Safest conservative interpretation; KpiCard still renders with flat design |
| `UI.tsx` — SectionCard | Same | Shadow removed, radius 12→8 | Same rationale |
| `UI.tsx` — font literals | `"'Sora', sans-serif"` string literals inside component | Replace with `SORA` constant, add import | Typography law; safe mechanical replacement |
| `NotificationBell.tsx` — font literals | Same | Replace with `SORA` | Same |
| Recovery/Settlements — textarea fonts | `fontFamily: "'Sora', sans-serif"` in textareas | Replace with `SORA` | Typography law; requires adding `SORA` to import if not present |
| Export buttons — `fontFamily: 'inherit'` | `inherit` is not a design constant | Leave as `inherit` — it inherits from parent which uses SORA. Not a violation | Conservative: `inherit` defers to parent, which is correct |
| `EmailBlockEditor.tsx` — `fontFamily: 'Roboto, Arial, sans-serif'` | Email preview pane uses its own fonts | SKIP — this renders an email preview that deliberately uses email-safe fonts. Changing it would break email fidelity | Not a UI font; email rendering context |
| KpiCard hero conversion — Risk module | Which metric is "dominant"? | Chose the largest/most operationally significant metric per page. Logged per-page below. | Design law: asymmetric hero with one dominant mono figure |
| Recharts hex colors | Design law says no hex in components | ALLOWED exception as specified. Read token values from JS at render time using hex from `NAVY`, `RED`, `GREEN`, `AMBER` design constants | Recharts SVG prop exception explicitly stated in design law |
| `WorkspaceDemo.tsx` | Has font literals and hex in DEMO_CSS | NOT touched — it is a reference/demo file, not a live page | Out of scope |

### Per-page hero decisions (Risk module):
- `AppReview` — dominant: total applications count (most operationally visible)
- `PortfolioHealth` — dominant: total portfolio outstanding kobo (primary financial metric)
- `VintageAnalysis` — dominant: avg PAR30 at 6 months (core vintage health signal)
- `EyeScore` — dominant: scored today count (daily operational pulse)
- `CreditFile` — SKIP hero conversion: single-customer profile, no KPI strip present

---

## SKIPPED

| Screen | Blocker |
|--------|---------|
| `EmailBlockEditor.tsx` font | Intentional email-preview font; changing would break rendered output fidelity |
| `WorkspaceDemo.tsx` | Reference/demo file — not a live page |
| `Login.tsx` | Auth page; uses standalone layout without the app shell; literal Sora strings noted but Login is not in the 6-module scope |
| `Settings.tsx` | `fontFamily: 'monospace'` used on OTP/2FA input fields — this is intentional for digit alignment; not a typography violation in context |

---

## BUGS-FOUND

| File | Bug |
|------|-----|
| `frontend/src/pages/admin/WorkflowTemplates.tsx` | Has `fontFamily: "'Sora', sans-serif"` in several places — not in scope but noted |
| `frontend/src/pages/campaigns/TemplateEditor.tsx` | Same |
| `frontend/src/pages/finance/Income.tsx` | Same |

---

## END-OF-RUN REPORT

*(appended after all modules complete)*
