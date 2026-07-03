# O3 Capital Workspace — Document Map

All reference documents for the platform are in this folder or `frontend/`.
Start here to know what to read and in what order.

---

## Document Hierarchy

```
1. O3C_MASTER_AUDIT_FULL          ← WHY: what was broken and what needs fixing
        ↓
2. O3C_IMPLEMENTATION_PLAN        ← WHAT: phases 0–12 of what to build / fix
        ↓
3. O3C_WORKSPACE_MASTER_SPEC      ← THE SPEC: full product, roles, workflows, business rules
        ↓
4. frontend/BUILD_GUIDE           ← HOW TO BUILD: sidebar, page specs, architecture rules
   frontend/DESIGN_SYSTEM         ← HOW IT LOOKS: tokens, components, chart rules, patterns
```

**For day-to-day development:** read `BUILD_GUIDE` and `DESIGN_SYSTEM`.  
**For product questions:** read `O3C_WORKSPACE_MASTER_SPEC`.  
**For understanding why something was decided:** read `O3C_IMPLEMENTATION_PLAN` or the audit.

---

## Active Reference Documents

### Product & Build

| Document | Path | Purpose |
|---|---|---|
| **Build Guide** | `frontend/BUILD_GUIDE.md` | Primary daily reference — sidebar structure, every page spec (74 pages), architecture principles, build order, role visibility, pitfalls. Read this before touching any frontend code. |
| **Design System** | `frontend/DESIGN_SYSTEM.md` | CSS token usage, typography rules (Sora + Inter), component patterns, chart rules, table patterns, badge usage. Use for every component. |
| **Master Product Spec** | `docs/O3C_WORKSPACE_MASTER_SPEC.md` | Full product specification — all 14 departments, all modules, all roles, business flows, phase 1–12 roadmap. Reference for product/business questions. |
| **Implementation Plan** | `docs/O3C_IMPLEMENTATION_PLAN.md` | Phases 0–12 broken into tasks with file locations, effort estimates, and dependencies. Use to understand execution sequence and what each phase delivers. |

### Infrastructure & Ops

| Document | Path | Purpose |
|---|---|---|
| **Deployment** | `docs/DEPLOYMENT.md` | Railway + Cloudflare Pages deploy steps |
| **Cloudflare Tunnel** | `docs/CLOUDFLARE_TUNNEL.md` | MSSQL on-site card data access via Cloudflare Tunnel |
| **Supabase Setup** | `docs/SUPABASE_SETUP.md` | Database provisioning and connection setup |
| **Mail Deliverability** | `docs/MAIL_DELIVERABILITY.md` | SendGrid + Microsoft Graph email config |
| **IT Presentation** | `docs/DECK_BRIEF_MD_IT_PRESENTATION.md` | Deck brief for IT/management presentations |

---

## Archived Documents (do not use for new work)

Located in `docs/archived/`:

| Document | Why Archived |
|---|---|
| `O3C_MASTER_AUDIT_FULL.md` | Source audit from 11 specialists (Jun 2026). Historical context. Superseded by the Implementation Plan and Master Spec. |
| `O3C_MASTER_AUDIT.md` | Platform audit snapshot (2026-06-21). Earlier version of the full audit. |
| `DESIGN_SYSTEM_V1_DM_SANS.md` | Original design system using DM Sans + DM Mono typography. **Superseded** by Editorial B (Sora + Inter). Do not use these font or colour choices. |
| `DESIGN_BRIEF.md` | Original design brief (DM Sans era). **Superseded**. |
| `schema_credit_fd_original.sql` | One-off SQL script run directly in Supabase. Superseded by numbered migration files in `backend-go/migrations/`. |

---

## How the Documents Relate

**The audit** found everything wrong with the platform as it stood. **The implementation plan**
turned those findings into a sequenced list of phases and tasks. **The master spec** is the
comprehensive product document — what every module should do, what every role can see,
what the complete workflows are. **The build guide** is the developer execution document
derived from the master spec — it tells you exactly what to build on each page, in what order,
following what patterns. **The design system** is the visual rulebook — how every element
must look regardless of which page it appears on.

When there is a conflict between documents, the **Build Guide takes precedence** for
frontend implementation. If the Build Guide is silent on something, consult the Master Spec.
If both are silent, ask before inventing.

---

## Organisational Context

O3 Capital has **14 departments**. Every sidebar section, every page, and every role maps
to one of these departments. See `frontend/BUILD_GUIDE.md` Part 1 for the full mapping.

| Dept | Name | Sidebar Section |
|---|---|---|
| 1 | Call Centre / Telemarketing | Contact Centre |
| 2 | Customer Service | Contact Centre |
| 3 | Cards | Cards |
| 4 | Collections | Operations |
| 5 | Settlement & Reconciliation | Operations |
| 6 | Recovery | Operations |
| 7 | Finance | Finance |
| 8 | Sales | Sales & BD |
| 9 | Business Development | Sales & BD |
| 10 | BI | Intelligence |
| 11 | HR | People |
| 12 | IT | Admin |
| 13 | Compliance | Compliance |
| 14 | Risk | Operations |
