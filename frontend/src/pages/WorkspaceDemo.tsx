import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

// ═══════════════════════════════════════════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════════════════════════════════════════

interface Customer {
  name: string; branch: string; since: string; phone: string; rm: string
  segment: string; risk: 'Low' | 'Medium' | 'High' | 'Critical'
  products: [string, string][]
  events: [string, string][]
}

const CUSTOMERS: Record<string, Customer> = {
  'CIF-0048291': { name: 'Adebayo Trading Ltd', branch: 'Lagos Island', since: '2021', phone: '+234 803 445 2210', rm: 'Nosa O.', segment: 'SME', risk: 'High',
    products: [['Business Loan LN-2214', '₦4,850,000.00'], ['Prepaid Card ····4471', '₦86,200.00']],
    events: [['09:12', 'NIP settlement ₦1.2M matched to LN-2214'], ['05 Jul', 'PTP logged for today · ₦1.2M'], ['28 Jun', 'Field visit — Lagos Island, contact made']] },
  'CIF-0042663': { name: 'Chiamaka Eze', branch: 'Port Harcourt', since: '2022', phone: '+234 812 090 7734', rm: 'Doris K.', segment: 'Retail', risk: 'Critical',
    products: [['Salary Loan LN-1187', '₦1,104,750.00']],
    events: [['09:31', 'PTP broken — ₦280K not received'], ['01 Jul', 'PTP due date passed'], ['24 Jun', 'Dunning letter #2 dispatched']] },
  'CIF-0031877': { name: 'Ngozi Okafor', branch: 'Ikeja', since: '2023', phone: '+234 701 555 8102', rm: 'Kehinde A.', segment: 'Retail', risk: 'Medium',
    products: [['Salary Loan LN-1902', '₦642,300.00']],
    events: [['05 Jul', 'PTP logged for today · ₦160K'], ['20 Jun', 'Partial payment ₦95K received']] },
  'CIF-0060118': { name: 'Greenfield Pharma Ltd', branch: 'Ibadan', since: '2020', phone: '+234 805 221 6640', rm: 'Nosa O.', segment: 'SME', risk: 'Low',
    products: [['Business Loan LN-2401', '₦7,320,000.00'], ['Fixed Deposit FD-0092', '₦12,000,000.00']],
    events: [['04 Jul', 'Disbursement approval raised (Maker-Checker)'], ['30 Jun', 'KYC refresh completed']] },
  'CIF-0057204': { name: 'Musa Ibrahim', branch: 'Abuja', since: '2024', phone: '+234 902 118 3345', rm: 'Doris K.', segment: 'Retail', risk: 'Low',
    products: [['Credit Card ····9982', '₦218,940.00']],
    events: [['03 Jul', 'PTP kept — ₦120K received'], ['15 Jun', 'Card limit review passed']] },
}

const QUEUE = [
  { cif: 'CIF-0048291', name: 'Adebayo Trading Ltd', branch: 'Lagos Island', product: 'Business Loan', outstanding: '₦4,850,000.00', outstandingKobo: 485_000_000, dpd: 74, bucket: 'b-90', bucketLabel: '61–90', ptpStatus: 'today', ptpLabel: 'Due today · ₦1.2M', ptpDate: '2026-07-06' },
  { cif: 'CIF-0031877', name: 'Ngozi Okafor', branch: 'Ikeja', product: 'Salary Loan', outstanding: '₦642,300.00', outstandingKobo: 64_230_000, dpd: 41, bucket: 'b-60', bucketLabel: '31–60', ptpStatus: 'today', ptpLabel: 'Due today · ₦160K', ptpDate: '2026-07-06' },
  { cif: 'CIF-0057204', name: 'Musa Ibrahim', branch: 'Abuja', product: 'Credit Card', outstanding: '₦218,940.00', outstandingKobo: 21_894_000, dpd: 18, bucket: 'b-30', bucketLabel: '1–30', ptpStatus: 'kept', ptpLabel: 'Kept · 03 Jul', ptpDate: '2026-07-03' },
  { cif: 'CIF-0042663', name: 'Chiamaka Eze', branch: 'Port Harcourt', product: 'Salary Loan', outstanding: '₦1,104,750.00', outstandingKobo: 110_475_000, dpd: 92, bucket: 'b-90', bucketLabel: '90+', ptpStatus: 'broken', ptpLabel: 'Broken · 01 Jul', ptpDate: '2026-07-01' },
  { cif: 'CIF-0060118', name: 'Greenfield Pharma Ltd', branch: 'Ibadan', product: 'Business Loan', outstanding: '₦7,320,000.00', outstandingKobo: 732_000_000, dpd: 9, bucket: 'b-30', bucketLabel: '1–30', ptpStatus: 'today', ptpLabel: 'Due today · ₦2.4M', ptpDate: '2026-07-06' },
]

interface MailItem { from: string; subj: string; prev: string; time: string; unread: boolean; body: string }
type MailFolder = { inbox: MailItem[]; sent: MailItem[]; drafts: MailItem[] }

function makeInitialMail(): MailFolder {
  return {
    inbox: [
      { from: 'Kemi Adeola', subj: 'June recon pack — sign-off needed', prev: 'Temitope, the June reconciliation pack is ready. Two items need your sign-off before board pack freeze on Wednesday…', time: '09:20', unread: true, body: 'Temitope,\n\nThe June reconciliation pack is ready. Two items need your sign-off before board pack freeze on Wednesday:\n\n1. Paystack fee variance of ₦412,300 (categorised, awaiting approval)\n2. Bevertec suspense account — 3 aged entries now matched\n\nCan you review before COB tomorrow?\n\nKemi' },
      { from: 'Ibrahim Yusuf', subj: 'PAR 90 escalation — Port Harcourt', prev: 'Flagging the Chiamaka Eze account for write-off committee review. Broken PTP twice in 30 days…', time: '08:52', unread: true, body: 'Flagging the Chiamaka Eze account (CIF-0042663) for write-off committee review.\n\nBroken PTP twice in 30 days, now at 92 DPD. Recommend moving to Recovery with legal pre-assessment.\n\nIbrahim' },
      { from: 'Babatunde Oke', subj: 'FAAN kiosk pilot — meeting Thursday', prev: 'FAAN partnerships team confirmed Thursday 11am for the travel card kiosk pilot review…', time: 'Yesterday', unread: true, body: 'FAAN partnerships team confirmed Thursday 11am for the travel card kiosk pilot review. They want updated 90-day volume projections — can BI have those ready?\n\nBabatunde' },
      { from: 'Freddie N.', subj: 'Re: Rewards programme tier maths', prev: 'The self-funded acquirer fee model checks out. One question on the milestone bonus accrual…', time: 'Yesterday', unread: false, body: 'The self-funded acquirer fee model checks out. One question on the milestone bonus accrual — do we recognise at earn or at redemption?\n\nFreddie' },
    ],
    sent: [
      { from: 'To: Kemi Adeola', subj: 'Central Reporting — Q3 call center start', prev: 'Confirming Call Center component starts Q3 2026 as agreed; other three components run concurrently…', time: '04 Jul', unread: false, body: 'Confirming Call Center component starts Q3 2026 as agreed; the other three components run concurrently.\n\nT.' },
      { from: 'To: MD; Head of IT', subj: 'Workspace Wave 4 & 5 — deck attached', prev: 'Please find the 22-slide deck for Wave 4 and 5 approval ahead of the Monday steering review…', time: '02 Jul', unread: false, body: 'Please find the 22-slide deck for Wave 4 and 5 approval ahead of the Monday steering review.\n\nT.' },
    ],
    drafts: [
      { from: 'Draft', subj: 'BI weekly digest — wk 27', prev: 'PAR 30 at 6.8% (▲0.2pp). Recovered MTD ₦96.4M against ₦140M target…', time: '09:40', unread: false, body: 'PAR 30 at 6.8% (▲0.2pp). Recovered MTD ₦96.4M against ₦140M target.\n\n[unfinished]' },
      { from: 'Draft', subj: '(no subject)', prev: 'Ikechukwu — re the Cards Ops SLA breach…', time: '03 Jul', unread: false, body: 'Ikechukwu — re the Cards Ops SLA breach…' },
    ],
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSS (injected as scoped style)
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_CSS = `
#wd { --navy:#0E2841; --navy2:#14324F; --navy-line:rgba(255,255,255,.08); --red:#C00000; --sky:#0EA5E9; --green:#0B8A4B; --amber:#B45309;
  --canvas:#FAFBFC; --surface:#FFFFFF; --ink:#101820; --ink2:#5A6672; --ink3:#8A95A1; --hair:#E4E8EC; --hover:#F2F6F9;
  --veil:rgba(14,40,65,.4); --red-soft:rgba(192,0,0,.10); --sky-soft:rgba(14,165,233,.13); --amber-soft:rgba(180,83,9,.12);
  --cur-soft:#E8EDF2; --cur-ink:#0E2841; }
#wd[data-theme="dark"] { --navy:#0A1E33; --navy2:#102A44; --navy-line:rgba(255,255,255,.07);
  --canvas:#0E1722; --surface:#131F2D; --ink:#E8EDF2; --ink2:#9FB0C0; --ink3:#64788C; --hair:#22303F; --hover:#182635;
  --veil:rgba(0,0,0,.55); --red-soft:rgba(255,90,90,.14); --sky-soft:rgba(14,165,233,.18); --amber-soft:rgba(217,119,6,.16);
  --cur-soft:#1C2C3D; --cur-ink:#B9CBDC; --green:#2FB673; --amber:#E19A3C; --red:#F87171; }

#wd { display:flex; height:100%; overflow:hidden; font-family:'Sora',sans-serif; font-size:13px;
  background:var(--canvas); color:var(--ink); transition:background .15s,color .15s; }

/* ── Sidebar ── */
#wd aside { width:238px; min-width:238px; background:var(--navy); color:rgba(255,255,255,.72);
  display:flex; flex-direction:column; transition:width .18s ease,min-width .18s ease; overflow:hidden; flex-shrink:0; }
#wd aside.rail { width:60px; min-width:60px; }
#wd .brand { display:flex; align-items:center; gap:10px; padding:16px 14px 14px; border-bottom:1px solid var(--navy-line); }
#wd .brand-mark { width:28px; height:28px; min-width:28px; border-radius:4px;
  background:linear-gradient(135deg,#0EA5E9,#0369A1);
  display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; color:#fff; }
#wd .brand-name { font-weight:600; font-size:13px; color:#fff; white-space:nowrap; }
#wd .brand-sub { font-size:10px; color:rgba(255,255,255,.45); letter-spacing:.04em; white-space:nowrap; }
#wd .collapse-btn { margin-left:auto; background:none; border:none; color:rgba(255,255,255,.4); cursor:pointer;
  font-size:14px; padding:4px 6px; border-radius:3px; line-height:1; font-family:monospace; }
#wd .collapse-btn:hover { color:#fff; background:var(--navy2); }

#wd .cmdk { margin:12px 12px 4px; display:flex; align-items:center; gap:8px; background:var(--navy2);
  border:1px solid var(--navy-line); border-radius:4px; padding:7px 10px; color:rgba(255,255,255,.45);
  font-size:12px; cursor:pointer; white-space:nowrap; font-family:'Sora',sans-serif; }
#wd .cmdk:hover { border-color:rgba(14,165,233,.5); color:rgba(255,255,255,.7); }
#wd .cmdk kbd { margin-left:auto; font-family:'Roboto Mono',monospace; font-size:10px;
  border:1px solid var(--navy-line); border-radius:3px; padding:1px 5px; color:rgba(255,255,255,.4); }
#wd .cmdk svg { width:14px; height:14px; opacity:.6; flex-shrink:0; }

#wd nav { flex:1; overflow-y:auto; padding:8px 0; scrollbar-width:thin; scrollbar-color:var(--navy2) transparent; }
#wd .nav-sec { padding:14px 14px 4px; }
#wd .nav-sec-label { font-size:10px; font-weight:600; letter-spacing:.12em; text-transform:uppercase;
  color:rgba(255,255,255,.32); white-space:nowrap; }
#wd .nav-item { display:flex; align-items:center; gap:10px; padding:8px 12px 8px 11px;
  border-left:3px solid transparent; cursor:pointer; font-size:12.5px; font-weight:500;
  color:rgba(255,255,255,.66); white-space:nowrap; user-select:none; transition:background .12s,color .12s; }
#wd .nav-item:hover { color:#fff; background:rgba(255,255,255,.03); }
#wd .nav-item.active { border-left-color:var(--sky); background:rgba(14,165,233,.10); color:#fff; }
#wd .nav-icon { width:16px; min-width:16px; height:16px; opacity:.85; flex-shrink:0; }
#wd .nav-badge { margin-left:auto; font-family:'Roboto Mono',monospace; font-size:10px; font-weight:500;
  background:rgba(14,165,233,.18); color:#7DD3FC; border-radius:3px; padding:1px 6px; }
#wd .nav-badge.hot { background:rgba(192,0,0,.35); color:#FCA5A5; }
#wd .caret { margin-left:auto; font-size:9px; opacity:.5; transition:transform .15s; line-height:1; }
#wd .nav-item.open .caret { transform:rotate(90deg); }
#wd .nav-item .nav-badge + .caret { margin-left:6px; }
#wd .sub { overflow:hidden; max-height:0; transition:max-height .18s ease; }
#wd .sub.open { max-height:220px; }
#wd .sub-item { display:flex; align-items:center; gap:8px; padding:6px 14px 6px 40px;
  font-size:12px; color:rgba(255,255,255,.5); cursor:pointer; white-space:nowrap;
  border-left:3px solid transparent; transition:color .12s; }
#wd .sub-item:hover { color:#fff; }
#wd .sub-item.active { color:#7DD3FC; border-left-color:var(--sky); }
#wd .sub-badge { margin-left:auto; font-family:'Roboto Mono',monospace; font-size:10px; color:rgba(255,255,255,.4); }

#wd aside.rail .brand-name,#wd aside.rail .brand-sub,#wd aside.rail .nav-sec-label,
#wd aside.rail .lbl,#wd aside.rail .nav-badge,#wd aside.rail .cmdk,
#wd aside.rail .caret,#wd aside.rail .sub,#wd aside.rail .user-meta,#wd aside.rail .sync-strip { display:none; }
#wd aside.rail .nav-item { justify-content:center; padding:10px 0; }
#wd aside.rail .brand { justify-content:center; padding:16px 8px 14px; }

#wd .side-footer { border-top:1px solid var(--navy-line); }
#wd .user-row { display:flex; align-items:center; gap:10px; padding:12px 14px; }
#wd .avatar { width:30px; height:30px; min-width:30px; border-radius:50%; background:var(--sky); color:#fff;
  display:flex; align-items:center; justify-content:center; font-weight:600; font-size:12px; }
#wd .user-meta .u-name { font-size:12px; font-weight:600; color:#fff; white-space:nowrap; }
#wd .user-meta .u-role { font-size:10.5px; color:rgba(255,255,255,.45); white-space:nowrap; }
#wd .sync-strip { display:flex; align-items:center; gap:7px; padding:8px 14px;
  font-size:10.5px; background:rgba(0,0,0,.22); color:rgba(255,255,255,.5); white-space:nowrap;
  font-family:'Roboto Mono',monospace; }
#wd .sync-dot { width:6px; height:6px; min-width:6px; border-radius:50%; background:#2FB673; box-shadow:0 0 0 3px rgba(47,182,115,.2); }

/* ── Main ── */
#wd main { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }
#wd header { display:flex; align-items:center; gap:14px; padding:14px 24px; border-bottom:1px solid var(--hair);
  background:var(--surface); flex-shrink:0; }
#wd .head-titles h1 { font-size:16px; font-weight:600; letter-spacing:-.01em; color:var(--ink); }
#wd .crumb { font-size:11px; color:var(--ink3); margin-bottom:2px; }
#wd .c360-bar { display:flex; align-items:center; gap:8px; flex:1; max-width:380px; margin-left:16px;
  border:1px solid var(--hair); border-radius:4px; background:var(--surface);
  padding:7px 11px; color:var(--ink3); font-size:12px; cursor:text; position:relative;
  transition:border-color .12s; }
#wd .c360-bar:focus-within { border-color:var(--sky); }
#wd .c360-bar svg { width:14px; height:14px; flex-shrink:0; }
#wd .c360-bar input { border:none; outline:none; background:none; flex:1;
  font-family:'Sora',sans-serif; font-size:12.5px; color:var(--ink); min-width:0; }
#wd .c360-results { position:absolute; top:calc(100% + 6px); left:0; right:0; background:var(--surface);
  border:1px solid var(--hair); border-radius:6px; box-shadow:0 12px 40px rgba(0,0,0,.18);
  z-index:30; overflow:hidden; }
#wd .c360-hit { display:flex; align-items:center; gap:10px; padding:9px 13px;
  cursor:pointer; font-size:12.5px; color:var(--ink); }
#wd .c360-hit:hover { background:var(--hover); }
#wd .c360-hit .cif { margin-left:auto; font-family:'Roboto Mono',monospace; font-size:11px; color:var(--ink3); }
#wd .header-right { margin-left:auto; display:flex; align-items:center; gap:6px; flex-shrink:0; }
#wd .icon-btn { position:relative; width:34px; height:34px; border-radius:5px;
  border:1px solid var(--hair); background:var(--surface); color:var(--ink2); cursor:pointer;
  display:flex; align-items:center; justify-content:center; transition:border-color .12s,color .12s; }
#wd .icon-btn:hover { border-color:var(--ink3); color:var(--ink); }
#wd .icon-btn svg { width:16px; height:16px; }
#wd .pip { position:absolute; top:-5px; right:-5px; min-width:16px; height:16px; border-radius:8px;
  background:var(--red); color:#fff; font-family:'Roboto Mono',monospace; font-size:9.5px; font-weight:600;
  display:flex; align-items:center; justify-content:center; padding:0 4px; }

/* ── Buttons ── */
#wd .btn { font-family:'Sora',sans-serif; font-size:12px; font-weight:600;
  border:1px solid var(--hair); background:var(--surface); color:var(--ink);
  border-radius:4px; padding:7px 13px; cursor:pointer; transition:border-color .12s; }
#wd .btn:hover { border-color:var(--ink3); }
#wd .btn.primary { background:var(--navy); border-color:var(--navy); color:#fff; }
#wd .btn.primary:hover { background:#16385A; border-color:#16385A; }
#wd[data-theme="dark"] .btn.primary { background:var(--sky); border-color:var(--sky); color:#06202F; }
#wd[data-theme="dark"] .btn.primary:hover { filter:brightness(1.1); }

/* ── Dropdown panels ── */
#wd .panel-wrap { position:relative; }
#wd .panel { position:absolute; top:44px; right:0; width:340px; background:var(--surface);
  border:1px solid var(--hair); border-radius:6px; box-shadow:0 16px 48px rgba(0,0,0,.2);
  z-index:40; overflow:hidden; }
#wd .panel-head { display:flex; align-items:center; padding:11px 14px; border-bottom:1px solid var(--hair); }
#wd .panel-title { font-size:12px; font-weight:600; color:var(--ink); }
#wd .panel-clear { margin-left:auto; font-size:11px; color:var(--sky); cursor:pointer;
  background:none; border:none; font-weight:600; font-family:'Sora',sans-serif; }
#wd .notif { display:flex; gap:10px; padding:11px 14px; border-bottom:1px solid var(--hair);
  font-size:12px; cursor:pointer; transition:background .1s; }
#wd .notif:hover { background:var(--hover); }
#wd .notif:last-child { border-bottom:none; }
#wd .n-dot { width:7px; height:7px; min-width:7px; border-radius:50%; margin-top:4px; flex-shrink:0; }
#wd .n-t { font-weight:600; margin-bottom:2px; color:var(--ink); }
#wd .n-s { color:var(--ink2); font-size:11.5px; }
#wd .n-time { color:var(--ink3); font-size:10.5px; font-family:'Roboto Mono',monospace; margin-top:3px; }
#wd .appr { padding:11px 14px; border-bottom:1px solid var(--hair); font-size:12px; }
#wd .appr:last-child { border-bottom:none; }
#wd .a-t { font-weight:600; color:var(--ink); margin-bottom:2px; }
#wd .a-s { color:var(--ink2); font-size:11.5px; margin-bottom:8px; }
#wd .a-s .amt { color:var(--ink); font-family:'Roboto Mono',monospace; }
#wd .a-actions { display:flex; gap:6px; }
#wd .a-btn { font-size:11px; font-weight:600; border-radius:3px; padding:4px 12px; cursor:pointer;
  border:1px solid var(--hair); background:var(--surface); color:var(--ink); font-family:'Sora',sans-serif; }
#wd .a-btn:hover { filter:brightness(.97); }
#wd .a-btn.ok { background:var(--green); border-color:var(--green); color:#fff; }
#wd .a-btn.ok:hover { filter:brightness(1.08); }
#wd .a-done { font-size:11px; font-weight:600; }

/* ── Scroll area ── */
#wd .scroll { flex:1; overflow-y:auto; }

/* ── Hero ── */
#wd .hero { display:flex; align-items:flex-end; gap:56px; padding:26px 28px 24px; border-bottom:1px solid var(--hair); flex-wrap:wrap; }
#wd .hero-label { font-size:10.5px; font-weight:600; letter-spacing:.12em; text-transform:uppercase; color:var(--ink3); margin-bottom:8px; }
#wd .hero-figure { font-family:'Roboto Mono',monospace; font-weight:600; font-size:46px; line-height:1;
  letter-spacing:-.02em; font-variant-numeric:tabular-nums; color:var(--ink); }
#wd .hero-figure .naira { font-size:24px; color:var(--ink2); font-weight:500; vertical-align:18px; margin-right:2px; }
#wd .hero-delta { font-size:12px; color:var(--red); font-weight:600; margin-top:8px; }
#wd .hero-secondary { display:flex; gap:40px; padding-bottom:4px; flex-wrap:wrap; }
#wd .m-label { font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink3); font-weight:600; margin-bottom:5px; }
#wd .m-value { font-family:'Roboto Mono',monospace; font-size:19px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--ink); }
#wd .m-sub { font-size:11px; color:var(--ink2); margin-top:3px; }
#wd .unit { font-size:12px; color:var(--ink2); font-weight:500; }

/* ── PAR bar ── */
#wd .par-section { padding:20px 28px 22px; border-bottom:1px solid var(--hair); }
#wd .sec-head { display:flex; align-items:baseline; gap:12px; margin-bottom:14px; }
#wd .sec-title { font-size:13px; font-weight:600; color:var(--ink); }
#wd .sec-note { font-size:11px; color:var(--ink3); }
#wd .par-bar { display:flex; height:34px; border-radius:3px; overflow:hidden; }
#wd .par-seg { transition:filter .12s; }
#wd .par-seg:hover { filter:brightness(1.12); }
#wd .par-legend { display:flex; gap:28px; margin-top:12px; flex-wrap:wrap; }
#wd .leg { display:flex; align-items:baseline; gap:8px; }
#wd .sw { width:9px; height:9px; border-radius:2px; }
#wd .l-name { font-size:11px; color:var(--ink2); font-weight:500; }
#wd .l-val { font-family:'Roboto Mono',monospace; font-size:12.5px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--ink); }
#wd .l-pct { font-family:'Roboto Mono',monospace; font-size:11px; color:var(--ink3); }

/* ── Table ── */
#wd .table-toolbar { display:flex; align-items:center; gap:10px; padding:16px 28px 12px; flex-wrap:wrap; }
#wd .table-title { font-size:13px; font-weight:600; color:var(--ink); }
#wd .chip-row { display:flex; gap:6px; margin-left:14px; }
#wd .chip { font-size:11px; font-weight:600; color:var(--ink2); border:1px solid var(--hair);
  border-radius:99px; padding:3px 10px; cursor:pointer; background:var(--surface); font-family:'Sora',sans-serif; }
#wd .chip.on { background:var(--navy); border-color:var(--navy); color:#fff; }
#wd .chip:hover:not(.on) { border-color:var(--ink3); }
#wd[data-theme="dark"] .chip.on { background:var(--sky); border-color:var(--sky); color:#06202F; }
#wd .tbl-count { margin-left:auto; font-family:'Roboto Mono',monospace; font-size:11px; color:var(--ink3); }
#wd table { width:100%; border-collapse:collapse; }
#wd thead th { position:sticky; top:0; background:var(--canvas); font-size:10px; font-weight:600;
  letter-spacing:.1em; text-transform:uppercase; color:var(--ink3); text-align:left;
  padding:8px 14px; border-top:1px solid var(--hair); border-bottom:1px solid var(--hair); z-index:2; white-space:nowrap; }
#wd thead th.r,#wd td.r { text-align:right; }
#wd tbody td { padding:0 14px; height:38px; border-bottom:1px solid var(--hair); font-size:12.5px; white-space:nowrap; }
#wd tbody tr { cursor:pointer; }
#wd tbody tr:hover td { background:var(--hover); }
#wd td:first-child,#wd th:first-child { padding-left:28px; }
#wd td:last-child,#wd th:last-child { padding-right:28px; }
#wd .cif-col { font-family:'Roboto Mono',monospace; font-size:11.5px; color:var(--ink2); }
#wd .cust-name { font-weight:600; color:var(--ink); }
#wd .amt-col { font-family:'Roboto Mono',monospace; font-weight:500; font-variant-numeric:tabular-nums; }
#wd .dpd-col { font-family:'Roboto Mono',monospace; font-weight:600; font-variant-numeric:tabular-nums; }
#wd .bucket { display:inline-block; font-size:10px; font-weight:700; letter-spacing:.05em;
  border-radius:3px; padding:2px 7px; }
#wd .b-cur { background:var(--cur-soft); color:var(--cur-ink); }
#wd .b-30 { background:var(--sky-soft); color:#0369A1; }
#wd .b-60 { background:var(--amber-soft); color:var(--amber); }
#wd .b-90 { background:var(--red-soft); color:var(--red); }
#wd[data-theme="dark"] .b-30 { color:#7DD3FC; }
#wd[data-theme="dark"] .b-60 { color:#FCD34D; }
#wd[data-theme="dark"] .b-90 { color:#FCA5A5; }
#wd .ptp-cell { font-size:11.5px; color:var(--ink2); }
#wd .ptp-cell.today { color:var(--green); font-weight:600; }
#wd .ptp-cell.broken { color:var(--red); font-weight:600; }

/* ── Mail ── */
#wd .mail-wrap { display:flex; height:100%; }
#wd .mail-list { width:390px; min-width:300px; border-right:1px solid var(--hair); overflow-y:auto; flex-shrink:0; }
#wd .mail-list-head { display:flex; align-items:center; padding:14px 18px 10px; gap:8px; }
#wd .mail-folder-title { font-size:13px; font-weight:600; color:var(--ink); }
#wd .mail-count { font-family:'Roboto Mono',monospace; font-size:11px; color:var(--ink3); }
#wd .mail-item { padding:11px 18px; border-bottom:1px solid var(--hair); cursor:pointer; transition:background .1s; }
#wd .mail-item:hover { background:var(--hover); }
#wd .mail-item.sel { background:var(--hover); box-shadow:inset 3px 0 0 var(--sky); }
#wd .m-row1 { display:flex; align-items:baseline; }
#wd .m-from { font-weight:600; font-size:12.5px; color:var(--ink); }
#wd .mail-item.unread .m-from::before { content:''; display:inline-block; width:7px; height:7px;
  border-radius:50%; background:var(--sky); margin-right:7px; vertical-align:1px; }
#wd .m-time { margin-left:auto; font-family:'Roboto Mono',monospace; font-size:10.5px; color:var(--ink3); }
#wd .m-subj { font-size:12px; margin-top:2px; color:var(--ink); }
#wd .mail-item.unread .m-subj { font-weight:600; }
#wd .m-prev { font-size:11.5px; color:var(--ink3); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#wd .mail-read { flex:1; overflow-y:auto; padding:24px 32px; min-width:0; }
#wd .r-subj { font-size:16px; font-weight:600; margin-bottom:12px; color:var(--ink); }
#wd .r-meta { display:flex; align-items:center; gap:10px; padding-bottom:14px;
  border-bottom:1px solid var(--hair); margin-bottom:18px; font-size:12px; color:var(--ink2); }
#wd .r-body { font-size:13px; line-height:1.65; max-width:640px; white-space:pre-line; color:var(--ink); }
#wd .mail-empty { flex:1; display:flex; align-items:center; justify-content:center; color:var(--ink3); font-size:12.5px; }
#wd .mail-sm-avatar { width:26px; height:26px; min-width:26px; border-radius:50%; background:var(--sky);
  color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; }

/* ── Compose modal ── */
#wd .modal-veil { position:fixed; inset:0; background:var(--veil); display:flex;
  align-items:center; justify-content:center; z-index:60; }
#wd .compose { width:560px; max-width:94vw; background:var(--surface); border-radius:6px;
  overflow:hidden; box-shadow:0 24px 70px rgba(0,0,0,.35); }
#wd .compose-head { display:flex; align-items:center; background:#0E2841; color:#fff;
  padding:11px 16px; font-size:12.5px; font-weight:600; }
#wd .compose-head button { margin-left:auto; background:none; border:none; color:rgba(255,255,255,.6);
  font-size:16px; cursor:pointer; }
#wd .compose input, #wd .compose textarea { width:100%; border:none; outline:none; background:none;
  color:var(--ink); font-family:'Sora',sans-serif; font-size:13px;
  padding:11px 16px; border-bottom:1px solid var(--hair); }
#wd .compose textarea { height:200px; resize:vertical; border-bottom:none; }
#wd .compose-foot { display:flex; gap:8px; padding:12px 16px; border-top:1px solid var(--hair); }

/* ── C360 slide-over ── */
#wd .c360-veil { position:fixed; inset:0; background:var(--veil); z-index:55; }
#wd .c360-panel { position:fixed; top:0; right:-460px; width:440px; max-width:94vw; height:100%;
  background:var(--surface); border-left:1px solid var(--hair); z-index:56;
  transition:right .22s ease; display:flex; flex-direction:column; }
#wd .c360-panel.open { right:0; }
#wd .c3-head { padding:20px 24px 16px; border-bottom:1px solid var(--hair); }
#wd .c3-close { float:right; background:none; border:none; font-size:18px; color:var(--ink3); cursor:pointer; }
#wd .c3-name { font-size:17px; font-weight:600; color:var(--ink); }
#wd .c3-cif { font-family:'Roboto Mono',monospace; font-size:11.5px; color:var(--ink3); margin-top:3px; }
#wd .c3-tags { display:flex; gap:6px; margin-top:10px; flex-wrap:wrap; }
#wd .c3-body { flex:1; overflow-y:auto; }
#wd .c3-sec { padding:16px 24px; border-bottom:1px solid var(--hair); }
#wd .c3-sec-title { font-size:10.5px; font-weight:600; letter-spacing:.1em; text-transform:uppercase;
  color:var(--ink3); margin-bottom:12px; }
#wd .c3-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px 20px; }
#wd .c3-kv .k { font-size:10.5px; color:var(--ink3); margin-bottom:3px; }
#wd .c3-kv .v { font-size:13px; font-weight:600; color:var(--ink); }
#wd .c3-prod { display:flex; align-items:baseline; padding:9px 0; border-bottom:1px solid var(--hair); font-size:12.5px; }
#wd .c3-prod:last-child { border-bottom:none; }
#wd .p-name { font-weight:600; color:var(--ink); }
#wd .p-amt { margin-left:auto; font-family:'Roboto Mono',monospace; font-weight:500;
  font-variant-numeric:tabular-nums; color:var(--ink2); }
#wd .c3-ev { display:flex; gap:12px; padding:8px 0; font-size:12px; color:var(--ink); }
#wd .e-time { font-family:'Roboto Mono',monospace; font-size:10.5px; color:var(--ink3); min-width:52px; padding-top:1px; }
#wd .c3-foot { padding:14px 24px; border-top:1px solid var(--hair); display:flex; gap:8px; flex-shrink:0; }

/* ── Command palette ── */
#wd .palette-veil { position:fixed; inset:0; background:var(--veil); display:flex;
  align-items:flex-start; justify-content:center; padding-top:14vh; z-index:50;
  backdrop-filter:blur(2px); }
#wd .palette { width:520px; max-width:92vw; background:var(--surface); border-radius:6px;
  box-shadow:0 20px 60px rgba(0,0,0,.35); overflow:hidden; }
#wd .palette input { width:100%; border:none; outline:none; background:none; color:var(--ink);
  font-family:'Sora',sans-serif; font-size:14px; padding:15px 18px; border-bottom:1px solid var(--hair); }
#wd .palette-list { max-height:300px; overflow-y:auto; padding:6px 0; }
#wd .p-group { font-size:9.5px; font-weight:600; letter-spacing:.12em; text-transform:uppercase;
  color:var(--ink3); padding:8px 18px 4px; }
#wd .p-item { display:flex; align-items:center; gap:10px; padding:8px 18px; cursor:pointer; font-size:12.5px; color:var(--ink); }
#wd .p-item:hover { background:var(--hover); }
#wd .p-kbd { margin-left:auto; font-family:'Roboto Mono',monospace; font-size:10px; color:var(--ink3); }

@media (prefers-reduced-motion:reduce) { #wd * { transition:none !important; animation:none !important; } }

/* ── Filter / sort toolbar (DataTable-style) ── */
#wd .tbl-bar { display:flex; align-items:center; gap:8px; padding:12px 18px; border-bottom:1px solid var(--hair); flex-wrap:wrap; }
#wd .tbl-title { font-size:14px; font-weight:600; color:var(--ink); margin-right:4px; white-space:nowrap; }
#wd .srch { display:flex; align-items:center; gap:6px; border:1.5px solid var(--hair); border-radius:8px; padding:5px 10px; background:var(--surface); flex-shrink:0; }
#wd .srch:focus-within { border-color:var(--sky); }
#wd .srch svg { width:14px; height:14px; color:var(--ink3); flex-shrink:0; }
#wd .srch input { border:none; outline:none; background:none; font-family:'Sora',sans-serif; font-size:12.5px; color:var(--ink); width:160px; }
#wd .flt-btn { display:flex; align-items:center; gap:6px; padding:6px 12px; border-radius:8px; font-size:12.5px; font-weight:600; border:1.5px solid var(--hair); background:transparent; color:var(--ink2); cursor:pointer; font-family:'Sora',sans-serif; white-space:nowrap; position:relative; }
#wd .flt-btn:hover { border-color:var(--ink3); }
#wd .flt-btn.active { border-color:var(--red); color:var(--red); }
#wd .flt-pip { position:absolute; top:-6px; right:-6px; width:16px; height:16px; border-radius:50%; background:var(--red); color:#fff; font-size:9px; font-weight:700; font-family:'Roboto Mono',monospace; display:flex; align-items:center; justify-content:center; }
#wd .tbl-count-r { margin-left:auto; font-size:12px; color:var(--ink2); font-family:'Roboto Mono',monospace; white-space:nowrap; }

/* filter panel */
#wd .flt-panel { border-bottom:1px solid var(--hair); }
#wd .flt-grid { display:grid; grid-template-columns:repeat(3,1fr); padding:20px 20px 0; }
#wd .flt-col { padding:0 20px; border-right:1px solid var(--hair); }
#wd .flt-col:first-child { padding-left:0; }
#wd .flt-col:last-child { border-right:none; padding-right:0; }
#wd .flt-col-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--ink3); margin-bottom:12px; font-family:'Roboto Mono',monospace; }
#wd .flt-row { display:flex; align-items:center; gap:9px; margin-bottom:9px; cursor:pointer; }
#wd .flt-row input[type="checkbox"] { accent-color:#0E2841; width:14px; height:14px; cursor:pointer; flex-shrink:0; }
#wd .f-label { font-size:12px; color:var(--ink); }
#wd .f-count { margin-left:auto; font-size:11px; color:var(--ink3); font-family:'Roboto Mono',monospace; }
#wd .flt-foot { padding:14px 20px; border-top:1px solid var(--hair); margin-top:16px; display:flex; align-items:center; gap:12px; }
#wd .flt-status { font-size:12px; color:var(--ink3); }
#wd .flt-done { padding:5px 16px; border-radius:7px; border:none; background:var(--red); color:#fff; font-size:12px; font-weight:600; cursor:pointer; margin-left:auto; font-family:'Sora',sans-serif; }
#wd .flt-reset { padding:5px 12px; border-radius:7px; border:1.5px solid var(--hair); background:transparent; color:var(--ink2); font-size:12px; font-weight:600; cursor:pointer; font-family:'Sora',sans-serif; }
/* active chips */
#wd .chips-bar { padding:8px 18px; border-bottom:1px solid var(--hair); display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
#wd .a-chip { display:inline-flex; align-items:center; gap:4px; padding:3px 8px; border-radius:20px; font-size:11.5px; font-weight:600; background:var(--sky-soft); color:#0369A1; }
#wd[data-theme="dark"] .a-chip { color:#7DD3FC; }
#wd .a-chip-x { cursor:pointer; font-size:11px; line-height:1; margin-left:2px; }
#wd .clear-all { border:none; background:none; cursor:pointer; font-size:11.5px; font-weight:600; color:var(--ink3); padding:0; font-family:'Sora',sans-serif; }

/* sortable thead */
#wd thead th { cursor:pointer; }
#wd thead th.nosort { cursor:default; }
#wd .sort-ico { color:var(--red); opacity:.3; font-size:10px; margin-left:3px; vertical-align:middle; }
#wd .sort-ico.on { opacity:1; }

/* ── Date filter ── */
#wd .df-wrap { position:relative; }
#wd .df-btn { display:inline-flex; align-items:center; gap:6px; padding:5px 10px; border-radius:7px; font-size:12.5px; font-weight:500; border:1.5px solid var(--hair); background:var(--surface); color:var(--ink); cursor:pointer; white-space:nowrap; font-family:'Sora',sans-serif; transition:border-color .12s; }
#wd .df-btn.open { border-color:#0E2841; }
#wd[data-theme="dark"] .df-btn.open { border-color:var(--sky); }
#wd .df-btn svg { width:14px; height:14px; flex-shrink:0; color:var(--ink3); }
#wd .df-panel { position:absolute; top:calc(100% + 6px); left:0; z-index:50; background:var(--surface); border:1px solid var(--hair); border-radius:12px; box-shadow:0 8px 32px rgba(0,0,0,.16); display:flex; overflow:hidden; }
#wd .df-presets { width:136px; border-right:1px solid var(--hair); padding:10px 0; flex-shrink:0; }
#wd .df-sep { height:1px; background:var(--hair); margin:4px 0; }
#wd .df-pbtn { display:flex; align-items:center; gap:6px; width:100%; padding:6px 12px; background:transparent; border:none; cursor:pointer; font-size:12.5px; font-family:'Sora',sans-serif; color:var(--ink); text-align:left; white-space:nowrap; }
#wd .df-pbtn:hover { background:var(--hover); }
#wd .df-pbtn.on { font-weight:600; color:#0E2841; }
#wd[data-theme="dark"] .df-pbtn.on { color:var(--sky); }
#wd .df-pbtn .chk { font-size:11px; color:#0E2841; opacity:0; flex-shrink:0; }
#wd .df-pbtn.on .chk { opacity:1; }
#wd[data-theme="dark"] .df-pbtn .chk { color:var(--sky); }
#wd .df-cal { padding:14px 16px 12px; }
#wd .df-nav { display:flex; align-items:center; margin-bottom:12px; }
#wd .df-navbtn { width:28px; height:28px; border-radius:6px; border:1px solid var(--hair); background:var(--surface); cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--ink2); font-size:14px; }
#wd .df-months { display:flex; gap:16px; }
#wd .df-div { width:1px; background:var(--hair); }
#wd .df-mttl { text-align:center; font-size:12.5px; font-weight:700; color:var(--ink); margin-bottom:8px; }
#wd .df-g7 { display:grid; grid-template-columns:repeat(7,30px); }
#wd .df-wd { text-align:center; font-size:10px; font-weight:700; color:var(--ink3); height:22px; line-height:22px; text-transform:uppercase; }
#wd .df-day { position:relative; height:30px; cursor:pointer; }
#wd .df-strip { position:absolute; top:4px; bottom:4px; background:rgba(14,40,65,.09); z-index:0; }
#wd[data-theme="dark"] .df-strip { background:rgba(14,165,233,.15); }
#wd .df-circle { position:relative; z-index:1; width:26px; height:26px; border-radius:50%; margin:2px auto; display:flex; align-items:center; justify-content:center; font-size:12px; transition:background .08s; }
#wd .df-foot { margin-top:12px; padding-top:10px; border-top:1px solid var(--hair); display:flex; align-items:center; gap:8px; min-height:34px; }
#wd .df-clr { padding:4px 10px; border-radius:6px; border:1px solid var(--hair); background:var(--surface); color:var(--ink2); font-size:12px; cursor:pointer; font-weight:500; font-family:'Sora',sans-serif; }
`

// ═══════════════════════════════════════════════════════════════════════════════
// ICONS (inline SVG to avoid CDN dependency)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// DATE HELPERS (self-contained; mirrors lib/fmt + UI.tsx DateFilter internals)
// ═══════════════════════════════════════════════════════════════════════════════

function _dfPad(n: number) { return String(n).padStart(2, '0') }
function _dfIso(y: number, m: number, d: number) { return `${y}-${_dfPad(m)}-${_dfPad(d)}` }
function _dfPrevYM(ym: string) { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${_dfPad(m - 1)}` }
function _dfNextYM(ym: string) { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${_dfPad(m + 1)}` }
function _dfMonthLabel(ym: string) { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' }) }
function _dfRelDay(offset: number) { const d = new Date(); d.setDate(d.getDate() + offset); return _dfIso(d.getFullYear(), d.getMonth() + 1, d.getDate()) }
function _today() { const d = new Date(); return _dfIso(d.getFullYear(), d.getMonth() + 1, d.getDate()) }
function _monthStart() { const d = new Date(); return _dfIso(d.getFullYear(), d.getMonth() + 1, 1) }
function _yearStart()  { return _dfIso(new Date().getFullYear(), 1, 1) }
function _fmtDate(iso: string) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
function _dfThisQuarter(): [string, string] {
  const d = new Date(), y = d.getFullYear(), q = Math.floor(d.getMonth() / 3)
  return [_dfIso(y, q * 3 + 1, 1), _today()]
}
function _dfLastQuarter(): [string, string] {
  const d = new Date(); let y = d.getFullYear(), q = Math.floor(d.getMonth() / 3) - 1
  if (q < 0) { q = 3; y -= 1 }
  const sm = q * 3 + 1, em = sm + 2
  return [_dfIso(y, sm, 1), _dfIso(y, em, new Date(y, em, 0).getDate())]
}

const DF_PRESETS: { label: string; get: () => [string, string] }[][] = [
  [{ label: 'All time',     get: () => ['', ''] }],
  [
    { label: 'Today',        get: () => { const t = _today(); return [t, t] } },
    { label: 'Last 7 days',  get: () => [_dfRelDay(-6), _today()] },
    { label: 'Last 30 days', get: () => [_dfRelDay(-29), _today()] },
    { label: 'Last 90 days', get: () => [_dfRelDay(-89), _today()] },
  ],
  [
    { label: 'This week', get: () => { const d = new Date(), dow = d.getDay(); const mon = new Date(d); mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1)); return [_dfIso(mon.getFullYear(), mon.getMonth() + 1, mon.getDate()), _today()] } },
    { label: 'This month',   get: () => [_monthStart(), _today()] },
    { label: 'Last month',   get: () => { const d = new Date(); const pm = d.getMonth() === 0 ? 12 : d.getMonth(); const py = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear(); return [_dfIso(py, pm, 1), _dfIso(py, pm, new Date(d.getFullYear(), d.getMonth(), 0).getDate())] } },
  ],
  [
    { label: 'This quarter', get: _dfThisQuarter },
    { label: 'Last quarter', get: _dfLastQuarter },
    { label: 'This year',    get: () => [_yearStart(), _today()] },
  ],
]

const DF_WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const DF_CELL = 30

function DFMonthGrid({ ym, lo, hi, pendingStart, onDay, onHover }: {
  ym: string; lo: string; hi: string; pendingStart: string | null
  onDay: (iso: string) => void; onHover: (iso: string | null) => void
}) {
  const [y, m] = ym.split('-').map(Number)
  const firstDow = new Date(y, m - 1, 1).getDay()
  const offset   = firstDow === 0 ? 6 : firstDow - 1
  const daysCount = new Date(y, m, 0).getDate()
  const t = _today()

  const cells: (number | null)[] = [...Array(offset).fill(null), ...Array.from({ length: daysCount }, (_, i) => i + 1)]
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <div style={{ userSelect: 'none' }}>
      <div className="df-mttl">{_dfMonthLabel(ym)}</div>
      <div className="df-g7" style={{ marginBottom: 2 }}>
        {DF_WEEKDAYS.map(d => <div key={d} className="df-wd">{d}</div>)}
      </div>
      {Array.from({ length: cells.length / 7 }, (_, wi) => (
        <div key={wi} className="df-g7">
          {cells.slice(wi * 7, wi * 7 + 7).map((day, di) => {
            if (!day) return <div key={di} style={{ height: DF_CELL }} />
            const iso    = _dfIso(y, m, day)
            const isLo   = !!lo && iso === lo
            const isHi   = !!hi && iso === hi && lo !== hi
            const mid    = !!lo && !!hi && lo !== hi && iso > lo && iso < hi
            const single = !!lo && lo === hi && iso === lo
            const filled = isLo || isHi || single
            const hasBg  = isLo || isHi || mid
            const isToday = iso === t
            const isPend  = !!pendingStart && iso === pendingStart && !lo
            return (
              <div key={di} className="df-day" style={{ width: DF_CELL }}
                onClick={() => onDay(iso)} onMouseEnter={() => onHover(iso)} onMouseLeave={() => onHover(null)}>
                {hasBg && <div className="df-strip" style={{ left: isLo ? '50%' : 0, right: isHi ? '50%' : 0 }} />}
                <div className="df-circle" style={{
                  background: filled ? '#0E2841' : isPend ? 'rgba(14,40,65,.12)' : 'transparent',
                  color: filled ? '#fff' : isToday ? '#0E2841' : 'var(--ink)',
                  fontWeight: filled || isToday ? 700 : 400,
                  border: isToday && !filled ? '1.5px solid #0E2841' : 'none',
                  boxSizing: 'border-box',
                }}>{day}</div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function DFDateFilter({ from, to, onChange }: { from: string; to: string; onChange: (f: string, t: string) => void }) {
  const now = new Date()
  const initYM = from ? from.slice(0, 7) : `${now.getFullYear()}-${_dfPad(now.getMonth() + 1)}`
  const [open,         setOpen]         = useState(false)
  const [viewYM,       setViewYM]       = useState(initYM)
  const [pendingStart, setPendingStart] = useState<string | null>(null)
  const [hover,        setHover]        = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setPendingStart(null); setHover(null) }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => { if (from && open) setViewYM(from.slice(0, 7)) }, [from, open])

  const effFrom = pendingStart ?? from
  const effTo   = pendingStart ? (hover ?? pendingStart) : to
  const lo = effFrom && effTo ? (effFrom <= effTo ? effFrom : effTo) : (effFrom || effTo)
  const hi = effFrom && effTo ? (effFrom <= effTo ? effTo   : effFrom) : (effFrom || effTo)

  function handleDayClick(iso: string) {
    if (!pendingStart) { setPendingStart(iso) }
    else { const [f, t] = iso >= pendingStart ? [pendingStart, iso] : [iso, pendingStart]; onChange(f, t); setPendingStart(null); setHover(null); setOpen(false) }
  }
  function applyPreset(f: string, t: string) { onChange(f, t); setPendingStart(null); setHover(null); setOpen(false) }

  const month2   = _dfNextYM(viewYM)
  const btnLabel = !from && !to ? 'All time' : from === to ? _fmtDate(from) : `${_fmtDate(from)} – ${_fmtDate(to)}`

  return (
    <div className="df-wrap" ref={ref}>
      <button className={`df-btn${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)}>
        <IcoCalendar />
        <span style={{ color: !from && !to ? 'var(--ink3)' : 'var(--ink)' }}>{btnLabel}</span>
        <span style={{ fontSize: 10, color: 'var(--ink3)', marginLeft: 2 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="df-panel">
          <div className="df-presets">
            {DF_PRESETS.map((group, gi) => (
              <div key={gi}>
                {gi > 0 && <div className="df-sep" />}
                {group.map(p => {
                  const [f, t] = p.get()
                  const active = f === from && t === to
                  return (
                    <button key={p.label} className={`df-pbtn${active ? ' on' : ''}`} onClick={() => applyPreset(f, t)}>
                      <span className="chk">✓</span>{p.label}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="df-cal">
            <div className="df-nav">
              <button className="df-navbtn" onClick={() => setViewYM(_dfPrevYM(viewYM))}>‹</button>
              <div style={{ flex: 1 }} />
              <button className="df-navbtn" onClick={() => setViewYM(_dfNextYM(viewYM))}>›</button>
            </div>
            <div className="df-months">
              <DFMonthGrid ym={viewYM} lo={lo} hi={hi} pendingStart={pendingStart} onDay={handleDayClick} onHover={setHover} />
              <div className="df-div" />
              <DFMonthGrid ym={month2} lo={lo} hi={hi} pendingStart={pendingStart} onDay={handleDayClick} onHover={setHover} />
            </div>
            <div className="df-foot">
              {pendingStart
                ? <span style={{ fontSize: 12, color: 'var(--ink3)', flex: 1 }}>Click a second day to complete the range</span>
                : (from || to)
                  ? <><span style={{ fontSize: 12.5, color: 'var(--ink2)', flex: 1 }}>{from === to ? _fmtDate(from) : `${_fmtDate(from)} – ${_fmtDate(to)}`}</span>
                      <button className="df-clr" onClick={() => applyPreset('', '')}>Clear</button></>
                  : <span style={{ fontSize: 12, color: 'var(--ink3)', flex: 1 }}>Click a day to start selecting a range</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// ICONS
// ═══════════════════════════════════════════════════════════════════════════════

type SvgProps = React.SVGProps<SVGSVGElement>
const IcoSearch  = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>
const IcoLoan    = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20"/></svg>
const IcoCol     = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>
const IcoRec     = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 3v6h6"/></svg>
const IcoCard    = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
const IcoCRM     = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/></svg>
const IcoMail    = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>
const IcoBI      = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="6" width="4" height="15"/><rect x="17" y="3" width="4" height="18"/></svg>
const IcoMoon    = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
const IcoSun     = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
const IcoApprove = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>
const IcoBell    = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
const IcoCalendar = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
const IcoTune    = (p: SvgProps) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M8 12h8M11 18h2"/></svg>

function initials(name: string) {
  return name.replace('To: ', '').split(' ').map((w: string) => w[0] ?? '').slice(0, 2).join('').toUpperCase()
}

function riskBucket(risk: Customer['risk']) {
  if (risk === 'Critical' || risk === 'High') return 'b-90'
  if (risk === 'Medium') return 'b-60'
  return 'b-cur'
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar({ view, onViewChange, onPalette }: { view: string; onViewChange: (v: string) => void; onPalette: () => void }) {
  const [rail, setRail] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set(['col', 'mail']))

  function toggle(key: string) {
    setOpen(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  return (
    <aside className={rail ? 'rail' : ''}>
      {/* Brand */}
      <div className="brand">
        <div className="brand-mark">O3</div>
        {!rail && <div>
          <div className="brand-name">O3 Capital</div>
          <div className="brand-sub">WORKSPACE</div>
        </div>}
        {!rail && <button className="collapse-btn" onClick={() => setRail(true)} title="Collapse">⟨⟩</button>}
      </div>
      {rail && <button onClick={() => setRail(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.4)', cursor: 'pointer', padding: '8px', display: 'flex', justifyContent: 'center', fontSize: 14, fontFamily: 'monospace' }}>⟩</button>}

      {/* ⌘K bar */}
      <div className="cmdk" onClick={onPalette}>
        <IcoSearch /><span className="lbl">Jump to…</span><kbd>⌘K</kbd>
      </div>

      <nav>
        {/* LENDING */}
        <div className="nav-sec"><div className="nav-sec-label">Lending</div></div>

        <div className={`nav-item${open.has('los') ? ' open' : ''}`} onClick={() => toggle('los')}>
          <IcoLoan className="nav-icon" /><span className="lbl">Loan Origination</span>
          <span className="nav-badge">12</span><span className="caret">▶</span>
        </div>
        <div className={`sub${open.has('los') ? ' open' : ''}`}>
          <div className="sub-item">Applications<span className="sub-badge">8</span></div>
          <div className="sub-item">Underwriting<span className="sub-badge">3</span></div>
          <div className="sub-item">Disbursement<span className="sub-badge">1</span></div>
        </div>

        <div className={`nav-item${view === 'collections' ? ' active' : ''}${open.has('col') ? ' open' : ''}`} onClick={() => { toggle('col'); onViewChange('collections') }}>
          <IcoCol className="nav-icon" /><span className="lbl">Collections</span>
          <span className="nav-badge hot">37</span><span className="caret">▶</span>
        </div>
        <div className={`sub${open.has('col') ? ' open' : ''}`}>
          <div className={`sub-item${view === 'collections' ? ' active' : ''}`} onClick={() => onViewChange('collections')}>PTP Queue<span className="sub-badge">37</span></div>
          <div className="sub-item">Field Visits<span className="sub-badge">6</span></div>
          <div className="sub-item">Dunning Letters</div>
        </div>

        <div className={`nav-item${open.has('rec') ? ' open' : ''}`} onClick={() => toggle('rec')}>
          <IcoRec className="nav-icon" /><span className="lbl">Recovery</span><span className="caret">▶</span>
        </div>
        <div className={`sub${open.has('rec') ? ' open' : ''}`}>
          <div className="sub-item">Write-off Review</div>
          <div className="sub-item">Legal Cases<span className="sub-badge">2</span></div>
        </div>

        {/* OPERATIONS */}
        <div className="nav-sec"><div className="nav-sec-label">Operations</div></div>
        <div className="nav-item"><IcoCard className="nav-icon" /><span className="lbl">Cards Operations</span><span className="nav-badge">4</span></div>
        <div className="nav-item"><IcoCRM className="nav-icon" /><span className="lbl">CRM</span></div>

        {/* WORKSPACE */}
        <div className="nav-sec"><div className="nav-sec-label">Workspace</div></div>
        <div className={`nav-item${view === 'mail' ? ' active' : ''}${open.has('mail') ? ' open' : ''}`} onClick={() => { toggle('mail'); onViewChange('mail') }}>
          <IcoMail className="nav-icon" /><span className="lbl">Mail</span>
          <span className="nav-badge">3</span><span className="caret">▶</span>
        </div>
        <div className={`sub${open.has('mail') ? ' open' : ''}`}>
          <div className={`sub-item${view === 'mail' ? ' active' : ''}`} onClick={() => onViewChange('mail')}>Inbox<span className="sub-badge">3</span></div>
          <div className="sub-item">Compose</div>
          <div className="sub-item">Sent Mail</div>
          <div className="sub-item">Drafts<span className="sub-badge">2</span></div>
        </div>

        {/* INTELLIGENCE */}
        <div className="nav-sec"><div className="nav-sec-label">Intelligence</div></div>
        <div className="nav-item" onClick={() => onViewChange('collections')}><IcoBI className="nav-icon" /><span className="lbl">BI &amp; Reports</span></div>
      </nav>

      <div className="side-footer">
        <div className="user-row">
          <div className="avatar">TA</div>
          {!rail && <div className="user-meta">
            <div className="u-name">Temitope A.</div>
            <div className="u-role">Head, Strategy &amp; BI</div>
          </div>}
        </div>
        {!rail && <div className="sync-strip"><span className="sync-dot" />MSSQL sync · 09:42 · recon OK</div>}
      </div>
    </aside>
  )
}

// ── Notifications panel ───────────────────────────────────────────────────────
function NotifsPanel({ dark }: { dark: boolean }) {
  const NOTIFS = [
    { color: '#C00000', t: 'PTP broken — Chiamaka Eze', s: '₦280,000 promised 01 Jul was not received. Account moved to 90+ bucket.', time: '09:31' },
    { color: '#0EA5E9', t: 'NIP settlement received',  s: '₦1,200,000 from Adebayo Trading Ltd matched to loan LN-2214.', time: '09:12' },
    { color: '#B45309', t: 'PAR 30 threshold breach — Ikeja', s: 'Branch PAR 30 crossed 7.5%. BI alert rule #14.', time: '08:47' },
    { color: dark ? '#2FB673' : '#0B8A4B', t: 'Nightly recon completed', s: 'Bevertec ↔ app DB ↔ Paystack: 0 unmatched entries.', time: '06:02' },
  ]
  const [unread, setUnread] = useState(4)
  return (
    <div>
      <div className="panel-head">
        <span className="panel-title">Notifications</span>
        {unread > 0 && <button className="panel-clear" onClick={() => setUnread(0)}>Mark all read</button>}
      </div>
      {NOTIFS.map((n, i) => (
        <div key={i} className="notif">
          <span className="n-dot" style={{ background: n.color }} />
          <div><div className="n-t">{n.t}</div><div className="n-s">{n.s}</div><div className="n-time">{n.time}</div></div>
        </div>
      ))}
    </div>
  )
}

// ── Approvals panel ───────────────────────────────────────────────────────────
function ApprovalsPanel({ dark }: { dark: boolean }) {
  const [acted, setActed] = useState<Record<number, 'approved' | 'rejected'>>({})
  const ITEMS = [
    { id: 1, t: 'Loan disbursement — Maker-Checker', s: 'Greenfield Pharma Ltd · ', amt: '₦7,320,000', by: 'raised by Kehinde' },
    { id: 2, t: 'PAR 90 write-off recommendation',   s: 'Chiamaka Eze · ',           amt: '₦1,104,750', by: 'raised by Doris' },
  ]
  const pending = ITEMS.filter(i => !acted[i.id]).length
  return (
    <div>
      <div className="panel-head">
        <span className="panel-title">Pending approvals {pending > 0 && `(${pending})`}</span>
      </div>
      {ITEMS.map(item => (
        <div key={item.id} className="appr">
          {acted[item.id] ? (
            <div className="a-done" style={{ color: acted[item.id] === 'approved' ? (dark ? '#2FB673' : '#0B8A4B') : (dark ? '#F87171' : '#C00000') }}>
              {acted[item.id] === 'approved' ? '✓ Approved' : '✕ Rejected'} — {item.t}
            </div>
          ) : (
            <>
              <div className="a-t">{item.t}</div>
              <div className="a-s">{item.s}<span className="amt">{item.amt}</span> · {item.by}</div>
              <div className="a-actions">
                <button className="a-btn ok" onClick={() => setActed(a => ({ ...a, [item.id]: 'approved' }))}>Approve</button>
                <button className="a-btn" onClick={() => setActed(a => ({ ...a, [item.id]: 'rejected' }))}>Reject</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────────────────────
function Header({ view, dark, onToggleDark, onC360, onPalette, onCompose }: {
  view: string; dark: boolean; onToggleDark: () => void
  onC360: (cif: string) => void; onPalette: () => void; onCompose: (subj?: string) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<[string, Customer][]>([])
  const [showResults, setShowResults] = useState(false)
  const [openPanel, setOpenPanel] = useState<'notif' | 'approvals' | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  function search(val: string) {
    setQ(val)
    const term = val.toLowerCase().trim()
    const hits = Object.entries(CUSTOMERS).filter(([cif, c]) => !term || c.name.toLowerCase().includes(term) || cif.toLowerCase().includes(term)).slice(0, 5)
    setResults(hits)
    setShowResults(true)
  }

  function pickC360(cif: string) { setQ(''); setShowResults(false); onC360(cif) }

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpenPanel(null)
      if (!(e.target as HTMLElement).closest?.('.c360-bar')) setShowResults(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const titles: Record<string, { crumb: string; h1: string }> = {
    collections: { crumb: 'Lending / Collections', h1: 'Collections' },
    mail:        { crumb: 'Workspace / Mail',       h1: 'Mail' },
  }
  const { crumb, h1 } = titles[view] ?? { crumb: 'Workspace', h1: 'Workspace' }

  return (
    <header>
      <div className="head-titles">
        <div className="crumb">{crumb}</div>
        <h1>{h1}</h1>
      </div>

      {/* C360 search */}
      <div className="c360-bar">
        <IcoSearch />
        <input placeholder="Customer 360 — search name or CIF…" value={q}
          onChange={e => search(e.target.value)} onFocus={() => search(q)} />
        {showResults && results.length > 0 && (
          <div className="c360-results">
            {results.map(([cif, c]) => (
              <div key={cif} className="c360-hit" onClick={() => pickC360(cif)}>
                <strong>{c.name}</strong>
                <span style={{ color: 'var(--ink3)', fontSize: 11 }}>{c.branch}</span>
                <span className="cif">{cif}</span>
              </div>
            ))}
          </div>
        )}
        {showResults && results.length === 0 && q.length > 0 && (
          <div className="c360-results">
            <div className="c360-hit" style={{ color: 'var(--ink3)', cursor: 'default' }}>No customers match &ldquo;{q}&rdquo;</div>
          </div>
        )}
      </div>

      <div className="header-right" ref={panelRef}>
        {/* Theme toggle */}
        <button className="icon-btn" onClick={onToggleDark} title="Toggle theme">
          {dark ? <IcoSun /> : <IcoMoon />}
        </button>

        {/* Approvals */}
        <div className="panel-wrap">
          <button className="icon-btn" onClick={() => setOpenPanel(p => p === 'approvals' ? null : 'approvals')} title="Approvals">
            <IcoApprove /><span className="pip">2</span>
          </button>
          {openPanel === 'approvals' && <div className="panel"><ApprovalsPanel dark={dark} /></div>}
        </div>

        {/* Notifications */}
        <div className="panel-wrap">
          <button className="icon-btn" onClick={() => setOpenPanel(p => p === 'notif' ? null : 'notif')} title="Notifications">
            <IcoBell /><span className="pip">4</span>
          </button>
          {openPanel === 'notif' && <div className="panel"><NotifsPanel dark={dark} /></div>}
        </div>

        <button className="btn primary" onClick={() => onCompose()}>Log PTP</button>
      </div>
    </header>
  )
}

// ── Collections view ──────────────────────────────────────────────────────────
type FilterSets = { branch: Set<string>; bucket: Set<string>; ptpStatus: Set<string> }

function CollectionsView({ onC360 }: { onC360: (cif: string) => void }) {
  const [heroVal,     setHeroVal]     = useState(0)
  const target = 412_684_210

  // Table state
  const [search,      setSearch]      = useState('')
  const [sortKey,     setSortKey]     = useState<string | null>(null)
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('asc')
  const [filterOpen,  setFilterOpen]  = useState(false)
  const [active,      setActive]      = useState<FilterSets>({ branch: new Set(), bucket: new Set(), ptpStatus: new Set() })
  const [dateFrom,    setDateFrom]    = useState('')
  const [dateTo,      setDateTo]      = useState('')

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  function toggleFilter(col: keyof FilterSets, val: string) {
    setActive(prev => {
      const next = new Set(prev[col]); next.has(val) ? next.delete(val) : next.add(val)
      return { ...prev, [col]: next }
    })
  }

  function resetFilters() { setSearch(''); setActive({ branch: new Set(), bucket: new Set(), ptpStatus: new Set() }); setDateFrom(''); setDateTo('') }

  const activeCount = active.branch.size + active.bucket.size + active.ptpStatus.size + (dateFrom || dateTo ? 1 : 0)

  // Filter + sort pipeline
  const filtered = (() => {
    let rows = [...QUEUE]
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter(r => r.name.toLowerCase().includes(q) || r.cif.toLowerCase().includes(q) || r.branch.toLowerCase().includes(q))
    }
    if (active.branch.size)    rows = rows.filter(r => active.branch.has(r.branch))
    if (active.bucket.size)    rows = rows.filter(r => active.bucket.has(r.bucketLabel))
    if (active.ptpStatus.size) rows = rows.filter(r => {
      const label = r.ptpStatus === 'today' ? 'Due today' : r.ptpStatus === 'broken' ? 'Broken' : 'Kept'
      return active.ptpStatus.has(label)
    })
    if (dateFrom) rows = rows.filter(r => r.ptpDate >= dateFrom)
    if (dateTo)   rows = rows.filter(r => r.ptpDate <= dateTo)
    if (sortKey) rows.sort((a, b) => {
      const va = (a as Record<string, unknown>)[sortKey] ?? '', vb = (b as Record<string, unknown>)[sortKey] ?? ''
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return rows
  })()

  // Chip labels for active filter display
  type ChipEntry = { col: keyof FilterSets; val: string; label: string }
  const chips: ChipEntry[] = [
    ...[...active.branch].map(v => ({ col: 'branch' as const, val: v, label: v })),
    ...[...active.bucket].map(v => ({ col: 'bucket' as const, val: v, label: `Bucket: ${v}` })),
    ...[...active.ptpStatus].map(v => ({ col: 'ptpStatus' as const, val: v, label: v })),
  ]

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) { setHeroVal(target); return }
    const dur = 900; const t0 = performance.now(); let raf: number
    function tick(now: number) {
      const p = Math.min((now - t0) / dur, 1); const ease = 1 - Math.pow(1 - p, 3)
      setHeroVal(Math.round(target * ease)); if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Helper: count of base QUEUE rows matching a filter value
  function branchCount(v: string)  { return QUEUE.filter(r => r.branch === v).length }
  function bucketCount(v: string)  { return QUEUE.filter(r => r.bucketLabel === v).length }
  function statusCount(v: string)  {
    return QUEUE.filter(r => {
      const lbl = r.ptpStatus === 'today' ? 'Due today' : r.ptpStatus === 'broken' ? 'Broken' : 'Kept'
      return lbl === v
    }).length
  }

  function SortIco({ k }: { k: string }) {
    if (sortKey !== k) return <span className="sort-ico">↕</span>
    return <span className="sort-ico on">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  return (
    <div className="scroll">
      {/* Hero */}
      <section className="hero">
        <div>
          <div className="hero-label">Portfolio at Risk · All Branches</div>
          <div className="hero-figure"><span className="naira">₦</span>{heroVal.toLocaleString('en-NG')}</div>
          <div className="hero-delta">▲ 2.4% vs last week</div>
        </div>
        <div className="hero-secondary">
          {[['PAR 30','6.8','%','target ≤ 5.0%'],['PTPs Today','37','','₦18.2M expected'],
            ['Kept Rate','71.3','%','30-day rolling'],['Recovered MTD','₦96.4','M','of ₦140M target']].map(([lbl,val,unit,sub]) => (
            <div className="metric" key={lbl}>
              <div className="m-label">{lbl}</div>
              <div className="m-value">{val}<span className="unit">{unit}</span></div>
              <div className="m-sub">{sub}</div>
            </div>
          ))}
        </div>
      </section>

      {/* PAR bar */}
      <section className="par-section">
        <div className="sec-head">
          <div className="sec-title">Delinquency aging</div>
          <div className="sec-note">Outstanding principal by DPD bucket · as at 09:42 WAT</div>
        </div>
        <div className="par-bar">
          <div className="par-seg" style={{ width: '64%', background: '#0E2841' }} title="Current — ₦1.02B" />
          <div className="par-seg" style={{ width: '19%', background: '#0EA5E9' }} title="1–30 DPD — ₦248M" />
          <div className="par-seg" style={{ width: '10%', background: '#B45309' }} title="31–60 DPD — ₦103M" />
          <div className="par-seg" style={{ width:  '7%', background: '#C00000' }} title="61–90+ DPD — ₦61M" />
        </div>
        <div className="par-legend">
          {[['#0E2841','Current','₦1.02B','64%'],['#0EA5E9','1–30 DPD','₦248.1M','19%'],
            ['#B45309','31–60 DPD','₦103.4M','10%'],['#C00000','61–90+ DPD','₦61.2M','7%']].map(([bg,n,v,p]) => (
            <div className="leg" key={n}>
              <span className="sw" style={{ background: bg }} />
              <span className="l-name">{n}</span><span className="l-val">{v}</span><span className="l-pct">{p}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Table section */}
      <section style={{ paddingBottom: 40 }}>

        {/* ── Toolbar (DataTable-style) ── */}
        <div className="tbl-bar">
          <span className="tbl-title">PTP queue</span>

          {/* Search */}
          <div className="srch">
            <IcoSearch style={{ width: 14, height: 14 }} />
            <input placeholder="Search name, CIF, branch…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          {/* Filters button */}
          <button className={`flt-btn${activeCount > 0 ? ' active' : ''}`} onClick={() => setFilterOpen(o => !o)}>
            <IcoTune style={{ width: 14, height: 14 }} />
            Filters
            {activeCount > 0 && <span className="flt-pip">{activeCount}</span>}
          </button>

          {/* Date filter */}
          <DFDateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />

          <span className="tbl-count-r">{filtered.length} of {QUEUE.length}</span>
        </div>

        {/* ── Expandable filter panel ── */}
        {filterOpen && (
          <div className="flt-panel">
            <div className="flt-grid">
              <div className="flt-col">
                <div className="flt-col-title">Branch</div>
                {['Lagos Island','Ikeja','Abuja','Port Harcourt','Ibadan'].map(v => (
                  <label key={v} className="flt-row">
                    <input type="checkbox" checked={active.branch.has(v)} onChange={() => toggleFilter('branch', v)} />
                    <span className="f-label">{v}</span><span className="f-count">{branchCount(v)}</span>
                  </label>
                ))}
              </div>
              <div className="flt-col">
                <div className="flt-col-title">Bucket</div>
                {['1–30','31–60','61–90','90+'].map(v => (
                  <label key={v} className="flt-row">
                    <input type="checkbox" checked={active.bucket.has(v)} onChange={() => toggleFilter('bucket', v)} />
                    <span className="f-label">{v} DPD</span><span className="f-count">{bucketCount(v)}</span>
                  </label>
                ))}
              </div>
              <div className="flt-col">
                <div className="flt-col-title">PTP Status</div>
                {['Due today','Broken','Kept'].map(v => (
                  <label key={v} className="flt-row">
                    <input type="checkbox" checked={active.ptpStatus.has(v)} onChange={() => toggleFilter('ptpStatus', v)} />
                    <span className="f-label">{v}</span><span className="f-count">{statusCount(v)}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flt-foot">
              <span className="flt-status">
                {activeCount === 0 ? `No filters applied — showing all ${QUEUE.length} rows` : `${activeCount} filter${activeCount !== 1 ? 's' : ''} active`}
              </span>
              <button className="flt-reset" onClick={resetFilters}>Reset</button>
              <button className="flt-done" onClick={() => setFilterOpen(false)}>Done · {filtered.length} results</button>
            </div>
          </div>
        )}

        {/* ── Active filter chips ── */}
        {!filterOpen && chips.length > 0 && (
          <div className="chips-bar">
            {chips.map(c => (
              <span key={`${c.col}:${c.val}`} className="a-chip">
                {c.label}
                <span className="a-chip-x" onClick={() => toggleFilter(c.col, c.val)}>✕</span>
              </span>
            ))}
            {(dateFrom || dateTo) && (
              <span className="a-chip">
                {dateFrom === dateTo ? _fmtDate(dateFrom) : `${_fmtDate(dateFrom)} – ${_fmtDate(dateTo)}`}
                <span className="a-chip-x" onClick={() => { setDateFrom(''); setDateTo('') }}>✕</span>
              </span>
            )}
            <button className="clear-all" onClick={resetFilters}>Clear all</button>
          </div>
        )}

        {/* ── Table ── */}
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr>
              <th onClick={() => toggleSort('cif')}>CIF <SortIco k="cif" /></th>
              <th onClick={() => toggleSort('name')}>Customer <SortIco k="name" /></th>
              <th onClick={() => toggleSort('branch')}>Branch <SortIco k="branch" /></th>
              <th onClick={() => toggleSort('product')}>Product <SortIco k="product" /></th>
              <th className="r" onClick={() => toggleSort('outstandingKobo')}>Outstanding <SortIco k="outstandingKobo" /></th>
              <th className="r" onClick={() => toggleSort('dpd')}>DPD <SortIco k="dpd" /></th>
              <th className="nosort">Bucket</th>
              <th className="nosort">PTP status</th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: '32px', color: 'var(--ink3)', fontSize: 12.5 }}>No records match the current filters</td></tr>
              ) : filtered.map(r => (
                <tr key={r.cif} onClick={() => onC360(r.cif)}>
                  <td className="cif-col">{r.cif}</td>
                  <td className="cust-name">{r.name}</td>
                  <td>{r.branch}</td>
                  <td>{r.product}</td>
                  <td className="r amt-col">{r.outstanding}</td>
                  <td className="r dpd-col" style={{ color: r.bucket === 'b-90' ? 'var(--red)' : r.bucket === 'b-60' ? 'var(--amber)' : 'inherit' }}>{r.dpd}</td>
                  <td><span className={`bucket ${r.bucket}`}>{r.bucketLabel}</span></td>
                  <td className={`ptp-cell${r.ptpStatus === 'today' ? ' today' : r.ptpStatus === 'broken' ? ' broken' : ''}`}>{r.ptpLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

// ── Mail view ─────────────────────────────────────────────────────────────────
function MailView({ onCompose }: { onCompose: (subj?: string) => void }) {
  const [mail, setMail] = useState<MailFolder>(makeInitialMail)
  const [folder, setFolder] = useState<'inbox' | 'sent' | 'drafts'>('inbox')
  const [selIdx, setSelIdx] = useState<number | null>(null)

  function readMail(i: number) {
    setSelIdx(i)
    if (folder === 'inbox') {
      setMail(prev => ({ ...prev, inbox: prev.inbox.map((m, idx) => idx === i ? { ...m, unread: false } : m) }))
    }
  }

  const items = mail[folder]
  const unreadCount = mail.inbox.filter(m => m.unread).length
  const folderTitle = folder[0].toUpperCase() + folder.slice(1)
  const folderCount = folder === 'inbox' ? `${items.length} · ${unreadCount} unread` : String(items.length)

  const sel = selIdx !== null ? items[selIdx] : null

  return (
    <div className="scroll" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="mail-wrap" style={{ flex: 1, minHeight: 0 }}>
        {/* List pane */}
        <div className="mail-list">
          <div className="mail-list-head">
            <span className="mail-folder-title">{folderTitle}</span>
            <span className="mail-count">{folderCount}</span>
            <button className="btn primary" style={{ marginLeft: 'auto', padding: '5px 11px' }} onClick={() => onCompose()}>Compose</button>
          </div>
          {/* Folder tabs */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--hair)', padding: '0 18px' }}>
            {(['inbox','sent','drafts'] as const).map(f => (
              <button key={f} onClick={() => { setFolder(f); setSelIdx(null) }} style={{
                border: 'none', background: 'none', padding: '8px 12px 7px',
                fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                color: folder === f ? 'var(--sky)' : 'var(--ink3)',
                borderBottom: folder === f ? '2px solid var(--sky)' : '2px solid transparent',
                textTransform: 'capitalize',
              }}>
                {f} {f === 'inbox' && unreadCount > 0 && `(${unreadCount})`}
              </button>
            ))}
          </div>
          {items.map((m, i) => (
            <div key={i} className={`mail-item${m.unread ? ' unread' : ''}${i === selIdx ? ' sel' : ''}`} onClick={() => readMail(i)}>
              <div className="m-row1"><span className="m-from">{m.from}</span><span className="m-time">{m.time}</span></div>
              <div className="m-subj">{m.subj}</div>
              <div className="m-prev">{m.prev}</div>
            </div>
          ))}
        </div>

        {/* Reader pane */}
        {sel ? (
          <div className="mail-read">
            <div className="r-subj">{sel.subj}</div>
            <div className="r-meta">
              <div className="mail-sm-avatar">{initials(sel.from)}</div>
              <strong>{sel.from}</strong> · <span style={{ fontFamily: 'monospace' }}>{sel.time}</span>
            </div>
            <div className="r-body">{sel.body}</div>
            <div style={{ marginTop: 22, display: 'flex', gap: 8 }}>
              <button className="btn primary" onClick={() => onCompose(`Re: ${sel.subj}`)}>Reply</button>
              <button className="btn">Forward</button>
            </div>
          </div>
        ) : (
          <div className="mail-empty">Select a message to read</div>
        )}
      </div>
    </div>
  )
}

// ── Compose modal ─────────────────────────────────────────────────────────────
function ComposeModal({ open, onClose, initialSubj }: { open: boolean; onClose: () => void; initialSubj?: string }) {
  const [to,   setTo]   = useState('')
  const [subj, setSubj] = useState(initialSubj ?? '')
  const [body, setBody] = useState('')

  useEffect(() => { if (open) setSubj(initialSubj ?? '') }, [open, initialSubj])

  if (!open) return null
  return (
    <div className="modal-veil" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="compose">
        <div className="compose-head">New message <button onClick={onClose}>✕</button></div>
        <input placeholder="To" value={to} onChange={e => setTo(e.target.value)} />
        <input placeholder="Subject" value={subj} onChange={e => setSubj(e.target.value)} />
        <textarea placeholder="Write your message…" value={body} onChange={e => setBody(e.target.value)} />
        <div className="compose-foot">
          <button className="btn primary" onClick={onClose}>Send</button>
          <button className="btn" onClick={onClose}>Save draft</button>
        </div>
      </div>
    </div>
  )
}

// ── Customer 360 slide-over ───────────────────────────────────────────────────
function C360Panel({ cif, onClose }: { cif: string | null; onClose: () => void }) {
  const c = cif ? CUSTOMERS[cif] : null
  const open = !!c

  if (!cif && !open) return null
  return (
    <>
      {open && <div className="c360-veil" onClick={onClose} />}
      <div className={`c360-panel${open ? ' open' : ''}`}>
        {c && <>
          <div className="c3-head">
            <button className="c3-close" onClick={onClose}>✕</button>
            <div className="c3-name">{c.name}</div>
            <div className="c3-cif">{cif}</div>
            <div className="c3-tags">
              <span className="bucket b-30">{c.segment}</span>
              <span className={`bucket ${riskBucket(c.risk)}`}>Risk: {c.risk}</span>
            </div>
          </div>
          <div className="c3-body">
            <div className="c3-sec">
              <div className="c3-sec-title">Profile</div>
              <div className="c3-grid">
                {[['Branch', c.branch], ['Customer since', c.since], ['Phone', c.phone], ['Relationship mgr', c.rm]].map(([k, v]) => (
                  <div key={k} className="c3-kv"><div className="k">{k}</div><div className="v">{v}</div></div>
                ))}
              </div>
            </div>
            <div className="c3-sec">
              <div className="c3-sec-title">Products &amp; exposure</div>
              {c.products.map(([name, amt]) => (
                <div key={name} className="c3-prod"><span className="p-name">{name}</span><span className="p-amt">{amt}</span></div>
              ))}
            </div>
            <div className="c3-sec">
              <div className="c3-sec-title">Recent activity</div>
              {c.events.map(([time, ev]) => (
                <div key={time + ev} className="c3-ev"><span className="e-time">{time}</span><span>{ev}</span></div>
              ))}
            </div>
          </div>
          <div className="c3-foot">
            <button className="btn primary">Log PTP</button>
            <button className="btn">Call</button>
            <button className="btn">Full profile →</button>
          </div>
        </>}
      </div>
    </>
  )
}

// ── Command palette ───────────────────────────────────────────────────────────
function CommandPalette({ open, onClose, onView, onC360, onCompose }: {
  open: boolean; onClose: () => void
  onView: (v: string) => void; onC360: (cif: string) => void; onCompose: () => void
}) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 50) } }, [open])

  const filtered = Object.entries(CUSTOMERS).filter(([cif, c]) =>
    !q || c.name.toLowerCase().includes(q.toLowerCase()) || cif.toLowerCase().includes(q.toLowerCase())
  ).slice(0, 4)

  if (!open) return null
  return (
    <div className="palette-veil" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" onClick={e => e.stopPropagation()}>
        <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search modules, customers, CIF numbers…" onKeyDown={e => e.key === 'Escape' && onClose()} />
        <div className="palette-list">
          <div className="p-group">Modules</div>
          <div className="p-item" onClick={() => { onClose(); onView('collections') }}>Collections — today's queue<span className="p-kbd">G C</span></div>
          <div className="p-item" onClick={() => { onClose(); onView('mail') }}>Mail — inbox<span className="p-kbd">G M</span></div>
          <div className="p-group">Customers</div>
          {filtered.map(([cif, c]) => (
            <div key={cif} className="p-item" onClick={() => { onClose(); onC360(cif) }}>
              <span className="cif-col" style={{ fontSize: 11 }}>{cif}</span>{c.name}
            </div>
          ))}
          <div className="p-group">Actions</div>
          <div className="p-item" onClick={() => { onClose(); onCompose() }}>Compose a message</div>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

export default function WorkspaceDemo() {
  const navigate  = useNavigate()
  const [view,    setView]    = useState('collections')
  const [dark,    setDark]    = useState(false)
  const [c360Cif, setC360Cif] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  const [compose, setCompose] = useState(false)
  const [composeSubj, setComposeSubj] = useState<string | undefined>(undefined)

  function openCompose(subj?: string) { setComposeSubj(subj); setCompose(true) }

  // ⌘K and Esc keyboard handler
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setPalette(p => !p)
      }
      if (e.key === 'Escape') {
        setPalette(false); setC360Cif(null); setCompose(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div id="wd" data-theme={dark ? 'dark' : 'light'} style={{ position: 'fixed', inset: 0, zIndex: 100 }}>
      <style>{DEMO_CSS}</style>

      {/* Back to app link */}
      <button onClick={() => navigate('/')} style={{
        position: 'absolute', top: 6, right: 6, zIndex: 200,
        fontSize: 10, padding: '3px 8px', borderRadius: 4,
        border: '1px solid rgba(255,255,255,.2)', background: 'rgba(0,0,0,.3)',
        color: 'rgba(255,255,255,.7)', cursor: 'pointer', fontFamily: 'monospace',
      }}>← app</button>

      <Sidebar view={view} onViewChange={setView} onPalette={() => setPalette(true)} />

      <main>
        <Header
          view={view} dark={dark}
          onToggleDark={() => setDark(d => !d)}
          onC360={cif => setC360Cif(cif)}
          onPalette={() => setPalette(true)}
          onCompose={openCompose}
        />

        {view === 'collections' && <CollectionsView onC360={cif => setC360Cif(cif)} />}
        {view === 'mail'        && <MailView onCompose={openCompose} />}
      </main>

      <ComposeModal open={compose} onClose={() => setCompose(false)} initialSubj={composeSubj} />
      <C360Panel cif={c360Cif} onClose={() => setC360Cif(null)} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} onView={setView} onC360={cif => { setC360Cif(cif) }} onCompose={() => openCompose()} />
    </div>
  )
}
