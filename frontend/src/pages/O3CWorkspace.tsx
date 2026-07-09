import { useState, useEffect, useRef, useCallback } from "react";

/* ============================================================
   O3 Capital Workspace — TypeScript/React conversion
   Single-file demo: sidebar, collections (page-level date filter,
   filter panel, sortable columns, pagination), mail, C360, ⌘K palette.
   ============================================================ */

/* ---- date helpers ---- */
const _dfPad = (n: number) => String(n).padStart(2, "0");
const _dfIso = (y: number, m: number, d: number) => `${y}-${_dfPad(m)}-${_dfPad(d)}`;
const _dfPrevYM = (y: number, m: number): [number, number] => m === 1 ? [y - 1, 12] : [y, m - 1];
const _dfNextYM = (y: number, m: number): [number, number] => m === 12 ? [y + 1, 1] : [y, m + 1];
const _dfMonthLabel = (y: number, m: number) =>
  new Date(y, m - 1, 1).toLocaleString("en-NG", { month: "long", year: "numeric" });
const _today = () => { const d = new Date(); return _dfIso(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
const _monthStart = (y: number, m: number) => _dfIso(y, m, 1);
const _monthEnd = (y: number, m: number) => { const d = new Date(y, m, 0); return _dfIso(y, m, d.getDate()); };
const _yearStart = (y: number) => _dfIso(y, 1, 1);
const _fmtDate = (iso: string) => {
  if (!iso) return "All time";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-NG", { day: "2-digit", month: "short", year: "numeric" });
};
const _dfThisQuarter = (): [string, string] => {
  const d = new Date(); const y = d.getFullYear(); const q = Math.floor(d.getMonth() / 3);
  return [_dfIso(y, q * 3 + 1, 1), _dfIso(y, q * 3 + 3, new Date(y, q * 3 + 3, 0).getDate())];
};
const _dfLastQuarter = (): [string, string] => {
  const d = new Date(); let y = d.getFullYear(); let q = Math.floor(d.getMonth() / 3) - 1;
  if (q < 0) { q = 3; y--; }
  return [_dfIso(y, q * 3 + 1, 1), _dfIso(y, q * 3 + 3, new Date(y, q * 3 + 3, 0).getDate())];
};
const _dfRelDay = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return _dfIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

/* ---------------- TYPES ---------------- */
interface Customer {
  name: string; branch: string; since: string; phone: string; rm: string;
  segment: string; risk: string;
  products: [string, string][];
  events: [string, string][];
}
interface QueueRow {
  cif: string; name: string; branch: string; product: string;
  amt: string; amtKobo: number; dpd: number;
  bucket: "b-30" | "b-60" | "b-90"; bucketLabel: string;
  ptpClass: "today" | "kept" | "broken" | ""; ptp: string; ptpDate: string;
}
interface MailItem { from: string; subj: string; prev: string; time: string; unread: boolean; body: string; }
interface MailStore { inbox: MailItem[]; sent: MailItem[]; drafts: MailItem[]; }
interface Notif { sev: string; title: string; sub: string; time: string; read: boolean; }
interface Approval { id: string; title: string; entity: string; amount: string; maker: string; status: null | "approved" | "rejected"; }
interface ParSeg { w: string; c: string; name: string; val: string; pct: string; }
type SortKey = "name" | "branch" | "amtKobo" | "dpd" | "bucket" | null;
type ActiveFilters = { branch: Set<string>; bucket: Set<string>; ptpClass: Set<string> };

/* ---------------- DATA ---------------- */
const CUSTOMERS: Record<string, Customer> = {
  "CIF-0048291": { name: "Adebayo Trading Ltd", branch: "Lagos Island", since: "2021", phone: "+234 803 445 2210", rm: "Nosa O.", segment: "SME", risk: "High",
    products: [["Business Loan LN-2214", "₦4,850,000.00"], ["Prepaid Card ····4471", "₦86,200.00"]],
    events: [["09:12", "NIP settlement ₦1.2M matched to LN-2214"], ["05 Jul", "PTP logged for today · ₦1.2M"], ["28 Jun", "Field visit — Lagos Island, contact made"]] },
  "CIF-0042663": { name: "Chiamaka Eze", branch: "Port Harcourt", since: "2022", phone: "+234 812 090 7734", rm: "Doris K.", segment: "Retail", risk: "Critical",
    products: [["Salary Loan LN-1187", "₦1,104,750.00"]],
    events: [["09:31", "PTP broken — ₦280K not received"], ["01 Jul", "PTP due date passed"], ["24 Jun", "Dunning letter #2 dispatched"]] },
  "CIF-0031877": { name: "Ngozi Okafor", branch: "Ikeja", since: "2023", phone: "+234 701 555 8102", rm: "Kehinde A.", segment: "Retail", risk: "Medium",
    products: [["Salary Loan LN-1902", "₦642,300.00"]],
    events: [["05 Jul", "PTP logged for today · ₦160K"], ["20 Jun", "Partial payment ₦95K received"]] },
  "CIF-0060118": { name: "Greenfield Pharma Ltd", branch: "Ibadan", since: "2020", phone: "+234 805 221 6640", rm: "Nosa O.", segment: "SME", risk: "Low",
    products: [["Business Loan LN-2401", "₦7,320,000.00"], ["Fixed Deposit FD-0092", "₦12,000,000.00"]],
    events: [["04 Jul", "Disbursement approval raised (Maker-Checker)"], ["30 Jun", "KYC refresh completed"]] },
  "CIF-0057204": { name: "Musa Ibrahim", branch: "Abuja", since: "2024", phone: "+234 902 118 3345", rm: "Doris K.", segment: "Retail", risk: "Low",
    products: [["Credit Card ····9982", "₦218,940.00"]],
    events: [["03 Jul", "PTP kept — ₦120K received"], ["15 Jun", "Card limit review passed"]] },
  "CIF-0033421": { name: "Emeka Nwosu", branch: "Enugu", since: "2022", phone: "+234 803 721 4490", rm: "Kehinde A.", segment: "SME", risk: "High",
    products: [["Business Loan LN-1988", "₦2,150,000.00"]],
    events: [["06 Jul", "PTP logged for today · ₦650K"], ["22 Jun", "Partial repayment ₦300K received"]] },
  "CIF-0019874": { name: "Fatima Al-Hassan", branch: "Kano", since: "2023", phone: "+234 802 334 7821", rm: "Nosa O.", segment: "Retail", risk: "Critical",
    products: [["Salary Loan LN-1441", "₦380,500.00"]],
    events: [["04 Jul", "PTP broken — amount not received"], ["28 Jun", "Dunning letter #3 dispatched"]] },
  "CIF-0044592": { name: "Sunrise Logistics Ltd", branch: "Lagos Island", since: "2019", phone: "+234 706 882 3301", rm: "Doris K.", segment: "SME", risk: "Low",
    products: [["Business Loan LN-2518", "₦11,200,000.00"]],
    events: [["05 Jul", "PTP kept — ₦4.8M received on schedule"], ["01 Jul", "Statement requested"]] },
  "CIF-0072311": { name: "Blessing Okonkwo", branch: "Lekki", since: "2024", phone: "+234 901 447 6612", rm: "Kehinde A.", segment: "Retail", risk: "Critical",
    products: [["Credit Card ····3398", "₦950,750.00"]],
    events: [["02 Jul", "PTP broken — contact unreachable"], ["25 Jun", "Field agent dispatched"]] },
};

const BUCKET_DISPLAY: Record<string, string> = { "b-30": "1–30 DPD", "b-60": "31–60 DPD", "b-90": "61–90+ DPD" };
const PTP_DISPLAY: Record<string, string> = { today: "Due today", kept: "Kept", broken: "Broken" };

const QUEUE: QueueRow[] = [
  { cif: "CIF-0048291", name: "Adebayo Trading Ltd", branch: "Lagos Island",   product: "Business Loan", amt: "₦4,850,000.00",  amtKobo: 485000000,  dpd: 74, bucket: "b-90", bucketLabel: "61–90", ptpClass: "today",  ptp: "Due today · ₦1.2M",  ptpDate: "2026-07-06" },
  { cif: "CIF-0031877", name: "Ngozi Okafor",        branch: "Ikeja",          product: "Salary Loan",   amt: "₦642,300.00",    amtKobo: 64230000,   dpd: 41, bucket: "b-60", bucketLabel: "31–60", ptpClass: "today",  ptp: "Due today · ₦160K",  ptpDate: "2026-07-06" },
  { cif: "CIF-0057204", name: "Musa Ibrahim",         branch: "Abuja",          product: "Credit Card",   amt: "₦218,940.00",    amtKobo: 21894000,   dpd: 18, bucket: "b-30", bucketLabel: "1–30",  ptpClass: "kept",   ptp: "Kept · 03 Jul",      ptpDate: "2026-07-03" },
  { cif: "CIF-0042663", name: "Chiamaka Eze",         branch: "Port Harcourt",  product: "Salary Loan",   amt: "₦1,104,750.00",  amtKobo: 110475000,  dpd: 92, bucket: "b-90", bucketLabel: "90+",   ptpClass: "broken", ptp: "Broken · 01 Jul",    ptpDate: "2026-07-01" },
  { cif: "CIF-0060118", name: "Greenfield Pharma Ltd",branch: "Ibadan",         product: "Business Loan", amt: "₦7,320,000.00",  amtKobo: 732000000,  dpd:  9, bucket: "b-30", bucketLabel: "1–30",  ptpClass: "today",  ptp: "Due today · ₦2.4M",  ptpDate: "2026-07-06" },
  { cif: "CIF-0033421", name: "Emeka Nwosu",          branch: "Enugu",          product: "Business Loan", amt: "₦2,150,000.00",  amtKobo: 215000000,  dpd: 55, bucket: "b-60", bucketLabel: "31–60", ptpClass: "today",  ptp: "Due today · ₦650K",  ptpDate: "2026-07-06" },
  { cif: "CIF-0019874", name: "Fatima Al-Hassan",     branch: "Kano",           product: "Salary Loan",   amt: "₦380,500.00",    amtKobo: 38050000,   dpd: 88, bucket: "b-90", bucketLabel: "61–90", ptpClass: "broken", ptp: "Broken · 04 Jul",    ptpDate: "2026-07-04" },
  { cif: "CIF-0044592", name: "Sunrise Logistics Ltd",branch: "Lagos Island",   product: "Business Loan", amt: "₦11,200,000.00", amtKobo: 1120000000, dpd:  6, bucket: "b-30", bucketLabel: "1–30",  ptpClass: "kept",   ptp: "Kept · 05 Jul",      ptpDate: "2026-07-05" },
  { cif: "CIF-0072311", name: "Blessing Okonkwo",     branch: "Lekki",          product: "Credit Card",   amt: "₦950,750.00",    amtKobo: 95075000,   dpd: 95, bucket: "b-90", bucketLabel: "90+",   ptpClass: "broken", ptp: "Broken · 02 Jul",    ptpDate: "2026-07-02" },
];

const BRANCH_OPTIONS = [...new Set(QUEUE.map(r => r.branch))].sort();
const BUCKET_OPTIONS = ["b-30", "b-60", "b-90"] as const;
const PTP_OPTIONS = ["today", "kept", "broken"] as const;
const branchCounts = Object.fromEntries(BRANCH_OPTIONS.map(b => [b, QUEUE.filter(r => r.branch === b).length]));
const bucketCounts = Object.fromEntries(BUCKET_OPTIONS.map(b => [b, QUEUE.filter(r => r.bucket === b).length]));
const ptpCounts    = Object.fromEntries(PTP_OPTIONS.map(p => [p, QUEUE.filter(r => r.ptpClass === p).length]));

const PAGE_SIZE = 4;

const INITIAL_MAIL: MailStore = {
  inbox: [
    { from: "Kemi Adeola",   subj: "June recon pack — sign-off needed",      prev: "Temitope, the June reconciliation pack is ready. Two items need your sign-off…", time: "09:20", unread: true,
      body: "Temitope,\n\nThe June reconciliation pack is ready. Two items need your sign-off before board pack freeze on Wednesday:\n\n1. Paystack fee variance of ₦412,300 (categorised, awaiting approval)\n2. Bevertec suspense account — 3 aged entries now matched\n\nCan you review before COB tomorrow?\n\nKemi" },
    { from: "Ibrahim Yusuf", subj: "PAR 90 escalation — Port Harcourt",       prev: "Flagging the Chiamaka Eze account for write-off committee review…",               time: "08:52", unread: true,
      body: "Flagging the Chiamaka Eze account (CIF-0042663) for write-off committee review.\n\nBroken PTP twice in 30 days, now at 92 DPD. Recommend moving to Recovery with legal pre-assessment.\n\nIbrahim" },
    { from: "Babatunde Oke", subj: "FAAN kiosk pilot — meeting Thursday",     prev: "FAAN partnerships team confirmed Thursday 11am for the travel card kiosk pilot…",  time: "Yesterday", unread: true,
      body: "FAAN partnerships team confirmed Thursday 11am for the travel card kiosk pilot review. They want updated 90-day volume projections — can BI have those ready?\n\nBabatunde" },
    { from: "Freddie N.",    subj: "Re: Rewards programme tier maths",         prev: "The self-funded acquirer fee model checks out. One question on the milestone bonus…",time: "Yesterday", unread: false,
      body: "The self-funded acquirer fee model checks out. One question on the milestone bonus accrual — do we recognise at earn or at redemption?\n\nFreddie" },
  ],
  sent: [
    { from: "To: Kemi Adeola",   subj: "Central Reporting — Q3 call center start", prev: "Confirming Call Center component starts Q3 2026 as agreed…", time: "04 Jul", unread: false,
      body: "Confirming Call Center component starts Q3 2026 as agreed; the other three components run concurrently.\n\nT." },
    { from: "To: MD; Head of IT", subj: "Workspace Wave 4 & 5 — deck attached",    prev: "Please find the 22-slide deck for Wave 4 and 5 approval…",    time: "02 Jul", unread: false,
      body: "Please find the 22-slide deck for Wave 4 and 5 approval ahead of the Monday steering review.\n\nT." },
  ],
  drafts: [
    { from: "Draft", subj: "BI weekly digest — wk 27",  prev: "PAR 30 at 6.8% (▲0.2pp). Recovered MTD ₦96.4M against ₦140M target…", time: "09:40", unread: false, body: "PAR 30 at 6.8% (▲0.2pp). Recovered MTD ₦96.4M against ₦140M target.\n\n[unfinished]" },
    { from: "Draft", subj: "(no subject)",               prev: "Ikechukwu — re the Cards Ops SLA breach…",                               time: "03 Jul", unread: false, body: "Ikechukwu — re the Cards Ops SLA breach…" },
  ],
};

const INITIAL_NOTIFS: Notif[] = [
  { sev: "red",   title: "PTP broken — Chiamaka Eze",    sub: "₦280,000 promised 01 Jul was not received. Account moved to 90+ bucket.", time: "09:31", read: false },
  { sev: "sky",   title: "NIP settlement received",       sub: "₦1,200,000 from Adebayo Trading Ltd matched to loan LN-2214.",           time: "09:12", read: false },
  { sev: "amber", title: "PAR 30 threshold breach — Ikeja", sub: "Branch PAR 30 crossed 7.5%. BI alert rule #14.",                       time: "08:47", read: false },
  { sev: "green", title: "Nightly recon completed",        sub: "Bevertec ↔ app DB ↔ Paystack: 0 unmatched entries.",                    time: "06:02", read: false },
];

const INITIAL_APPROVALS: Approval[] = [
  { id: "ap1", title: "Loan disbursement — Maker-Checker", entity: "Greenfield Pharma Ltd", amount: "₦7,320,000", maker: "Kehinde", status: null },
  { id: "ap2", title: "PAR 90 write-off recommendation",   entity: "Chiamaka Eze",          amount: "₦1,104,750", maker: "Doris",   status: null },
];

const PAR_SEGMENTS: ParSeg[] = [
  { w: "64%", c: "#0E2841", name: "Current",    val: "₦1.02B",  pct: "64%" },
  { w: "19%", c: "#0EA5E9", name: "1–30 DPD",   val: "₦248.1M", pct: "19%" },
  { w: "10%", c: "#B45309", name: "31–60 DPD",  val: "₦103.4M", pct: "10%" },
  { w: "7%",  c: "#C00000", name: "61–90+ DPD", val: "₦61.2M",  pct: "7%"  },
];

/* ---------------- ICONS ---------------- */
const I = {
  search:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>,
  plus:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M2 12h20"/></svg>,
  chart:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>,
  refresh:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 3v6h6"/></svg>,
  card:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>,
  users:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/></svg>,
  mail:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>,
  bars:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="6" width="4" height="15"/><rect x="17" y="3" width="4" height="18"/></svg>,
  bell:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>,
  check:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>,
  moon:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>,
  sun:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>,
  calendar: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>,
  tune:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 21V14M4 10V3M12 21V12M12 8V3M20 21V16M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>,
  x:        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>,
};

/* ---------------- CSS ---------------- */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=Roboto+Mono:wght@400;500;600&display=swap');

.o3c{
  --navy:#0E2841;--navy-2:#14324F;--navy-line:rgba(255,255,255,.08);
  --red:#C00000;--sky:#0EA5E9;--green:#0B8A4B;--amber:#B45309;
  --canvas:#FAFBFC;--surface:#FFFFFF;
  --ink:#101820;--ink-2:#5A6672;--ink-3:#8A95A1;
  --hair:#E4E8EC;--hover:#F2F6F9;--chip-bg:#FFFFFF;--veil:rgba(14,40,65,.4);
  --red-soft:rgba(192,0,0,.10);--sky-soft:rgba(14,165,233,.13);
  --amber-soft:rgba(180,83,9,.12);--cur-soft:#E8EDF2;--cur-ink:#0E2841;
}
.o3c[data-theme="dark"]{
  --navy:#0A1E33;--navy-2:#102A44;--navy-line:rgba(255,255,255,.07);
  --canvas:#0E1722;--surface:#131F2D;
  --ink:#E8EDF2;--ink-2:#9FB0C0;--ink-3:#64788C;
  --hair:#22303F;--hover:#182635;--chip-bg:#131F2D;--veil:rgba(0,0,0,.55);
  --red-soft:rgba(255,90,90,.14);--sky-soft:rgba(14,165,233,.18);
  --amber-soft:rgba(217,119,6,.16);--cur-soft:#1C2C3D;--cur-ink:#B9CBDC;
  --green:#2FB673;--amber:#E19A3C;--red:#F87171;
}
.o3c[data-theme="dark"] .b-90{color:#FCA5A5}
.o3c[data-theme="dark"] .b-60{color:#FCD34D}
.o3c[data-theme="dark"] .b-30{color:#7DD3FC}

.o3c *{margin:0;padding:0;box-sizing:border-box}
.o3c{
  font-family:'IBM Plex Sans',sans-serif;background:var(--canvas);color:var(--ink);
  font-size:13px;display:flex;overflow:hidden;height:100vh;width:100%;
  transition:background .15s,color .15s;
}
.o3c .num,.o3c .mono{font-family:'Roboto Mono',monospace;font-variant-numeric:tabular-nums}
.o3c button{font-family:inherit}

/* SIDEBAR */
.o3c aside{width:238px;min-width:238px;background:var(--navy);color:rgba(255,255,255,.72);display:flex;flex-direction:column;transition:width .18s ease,min-width .18s ease;overflow:hidden}
.o3c aside.rail{width:60px;min-width:60px}
.o3c .brand{display:flex;align-items:center;gap:10px;padding:16px 14px 14px;border-bottom:1px solid var(--navy-line)}
.o3c .brand-mark{width:28px;height:28px;min-width:28px;border-radius:4px;background:linear-gradient(135deg,#0EA5E9,#0369A1);display:flex;align-items:center;justify-content:center;font-family:'Sora',sans-serif;font-weight:700;font-size:13px;color:#fff}
.o3c .brand-name{font-family:'Sora',sans-serif;font-weight:600;font-size:13px;color:#fff;white-space:nowrap}
.o3c .brand-sub{font-size:10px;color:rgba(255,255,255,.45);letter-spacing:.04em;white-space:nowrap}
.o3c .collapse-btn{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.4);cursor:pointer;font-size:14px;padding:4px;border-radius:3px}
.o3c .collapse-btn:hover{color:#fff;background:var(--navy-2)}
.o3c .cmdk{margin:12px 12px 4px;display:flex;align-items:center;gap:8px;background:var(--navy-2);border:1px solid var(--navy-line);border-radius:4px;padding:7px 10px;color:rgba(255,255,255,.45);font-size:12px;cursor:pointer;white-space:nowrap}
.o3c .cmdk:hover{border-color:rgba(14,165,233,.5);color:rgba(255,255,255,.7)}
.o3c .cmdk kbd{margin-left:auto;font-family:'Roboto Mono',monospace;font-size:10px;border:1px solid var(--navy-line);border-radius:3px;padding:1px 5px;color:rgba(255,255,255,.4)}
.o3c nav{flex:1;overflow-y:auto;padding:8px 0;scrollbar-width:thin;scrollbar-color:var(--navy-2) transparent}
.o3c .nav-sec{padding:14px 14px 4px}
.o3c .nav-sec-label{font-family:'Sora',sans-serif;font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.32);white-space:nowrap}
.o3c .nav-item{display:flex;align-items:center;gap:10px;padding:8px 12px 8px 11px;border-left:3px solid transparent;cursor:pointer;font-size:12.5px;font-weight:500;color:rgba(255,255,255,.66);white-space:nowrap;user-select:none}
.o3c .nav-item:hover{color:#fff;background:rgba(255,255,255,.03)}
.o3c .nav-item.active{border-left-color:var(--sky);background:rgba(14,165,233,.10);color:#fff}
.o3c .nav-icon{width:16px;min-width:16px;height:16px;opacity:.85}
.o3c .nav-icon svg{width:100%;height:100%}
.o3c .nav-badge{margin-left:auto;font-family:'Roboto Mono',monospace;font-size:10px;font-weight:500;background:rgba(14,165,233,.18);color:#7DD3FC;border-radius:3px;padding:1px 6px}
.o3c .nav-badge.hot{background:rgba(192,0,0,.35);color:#FCA5A5}
.o3c .caret{margin-left:auto;font-size:9px;opacity:.5;transition:transform .15s}
.o3c .nav-item.open .caret{transform:rotate(90deg)}
.o3c .nav-item .nav-badge + .caret{margin-left:6px}
.o3c .sub{overflow:hidden;max-height:0;transition:max-height .18s ease}
.o3c .sub.open{max-height:220px}
.o3c .sub-item{display:flex;align-items:center;gap:8px;padding:6px 14px 6px 40px;font-size:12px;color:rgba(255,255,255,.5);cursor:pointer;white-space:nowrap;border-left:3px solid transparent}
.o3c .sub-item:hover{color:#fff}
.o3c .sub-item.active{color:#7DD3FC;border-left-color:var(--sky)}
.o3c .sub-badge{margin-left:auto;font-family:'Roboto Mono',monospace;font-size:10px;color:rgba(255,255,255,.4)}
.o3c aside.rail .brand-name,.o3c aside.rail .brand-sub,.o3c aside.rail .nav-sec-label,
.o3c aside.rail .nav-item span.lbl,.o3c aside.rail .nav-badge,.o3c aside.rail .cmdk,
.o3c aside.rail .caret,.o3c aside.rail .sub,.o3c aside.rail .user-meta,.o3c aside.rail .sync-strip{display:none}
.o3c aside.rail .nav-item{justify-content:center;padding:10px 0}
.o3c aside.rail .brand{justify-content:center;padding:16px 8px 14px}
.o3c aside.rail .collapse-btn{display:none}
.o3c .side-footer{border-top:1px solid var(--navy-line)}
.o3c .user-row{display:flex;align-items:center;gap:10px;padding:12px 14px}
.o3c .avatar{width:30px;height:30px;min-width:30px;border-radius:50%;background:var(--sky);color:#fff;display:flex;align-items:center;justify-content:center;font-family:'Sora',sans-serif;font-weight:600;font-size:12px}
.o3c .user-meta .u-name{font-size:12px;font-weight:600;color:#fff;white-space:nowrap}
.o3c .user-meta .u-role{font-size:10.5px;color:rgba(255,255,255,.45);white-space:nowrap}
.o3c .sync-strip{display:flex;align-items:center;gap:7px;padding:8px 14px;font-size:10.5px;background:rgba(0,0,0,.22);color:rgba(255,255,255,.5);white-space:nowrap;font-family:'Roboto Mono',monospace}
.o3c .dot{width:6px;height:6px;min-width:6px;border-radius:50%;background:#2FB673;box-shadow:0 0 0 3px rgba(47,182,115,.2)}

/* MAIN */
.o3c main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.o3c header{display:flex;align-items:center;gap:14px;padding:14px 24px;border-bottom:1px solid var(--hair)}
.o3c .head-titles h1{font-family:'Sora',sans-serif;font-size:16px;font-weight:600;letter-spacing:-.01em}
.o3c .crumb{font-size:11px;color:var(--ink-3)}
.o3c .c360-srch{display:flex;align-items:center;gap:8px;flex:1;max-width:380px;margin-left:16px;border:1px solid var(--hair);border-radius:4px;background:var(--surface);padding:7px 11px;color:var(--ink-3);font-size:12px;cursor:text;position:relative}
.o3c .c360-srch:focus-within{border-color:var(--sky)}
.o3c .c360-srch input{border:none;outline:none;background:none;flex:1;font-family:inherit;font-size:12.5px;color:var(--ink)}
.o3c .c360-results{position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--surface);border:1px solid var(--hair);border-radius:6px;box-shadow:0 12px 40px rgba(0,0,0,.18);z-index:30;overflow:hidden}
.o3c .c360-hit{display:flex;align-items:center;gap:10px;padding:9px 13px;cursor:pointer;font-size:12.5px;color:var(--ink)}
.o3c .c360-hit:hover{background:var(--hover)}
.o3c .c360-hit .cif-tag{margin-left:auto}
.o3c .header-right{margin-left:auto;display:flex;align-items:center;gap:6px}
.o3c .icon-btn{position:relative;width:34px;height:34px;border-radius:5px;border:1px solid var(--hair);background:var(--surface);color:var(--ink-2);cursor:pointer;display:flex;align-items:center;justify-content:center}
.o3c .icon-btn:hover{border-color:var(--ink-3);color:var(--ink)}
.o3c .icon-btn svg{width:16px;height:16px}
.o3c .pip{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;border-radius:8px;background:#C00000;color:#fff;font-family:'Roboto Mono',monospace;font-size:9.5px;font-weight:600;display:flex;align-items:center;justify-content:center;padding:0 4px}
.o3c .btn{font-size:12px;font-weight:600;border:1px solid var(--hair);background:var(--surface);color:var(--ink);border-radius:4px;padding:7px 13px;cursor:pointer}
.o3c .btn:hover{border-color:var(--ink-3)}
.o3c .btn.primary{background:#0E2841;border-color:#0E2841;color:#fff}
.o3c .btn.primary:hover{background:#16385A}
.o3c[data-theme="dark"] .btn.primary{background:var(--sky);border-color:var(--sky);color:#06202F}

/* dropdown panels */
.o3c .panel{position:absolute;top:44px;right:0;width:340px;background:var(--surface);border:1px solid var(--hair);border-radius:6px;box-shadow:0 16px 48px rgba(0,0,0,.2);z-index:40}
.o3c .panel-head{display:flex;align-items:center;padding:11px 14px;border-bottom:1px solid var(--hair)}
.o3c .panel-title{font-family:'Sora',sans-serif;font-size:12px;font-weight:600}
.o3c .panel-clear{margin-left:auto;font-size:11px;color:var(--sky);cursor:pointer;background:none;border:none;font-weight:600}
.o3c .notif{display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--hair);font-size:12px;cursor:pointer}
.o3c .notif:hover{background:var(--hover)}
.o3c .notif:last-child{border-bottom:none}
.o3c .n-dot{width:7px;height:7px;min-width:7px;border-radius:50%;margin-top:5px}
.o3c .n-body .n-t{font-weight:600;margin-bottom:2px}
.o3c .n-body .n-s{color:var(--ink-2);font-size:11.5px}
.o3c .n-body .n-time{color:var(--ink-3);font-size:10.5px;font-family:'Roboto Mono',monospace;margin-top:3px}
.o3c .appr{padding:11px 14px;border-bottom:1px solid var(--hair);font-size:12px}
.o3c .appr:last-child{border-bottom:none}
.o3c .appr .a-t{font-weight:600}
.o3c .appr .a-s{color:var(--ink-2);font-size:11.5px;margin:2px 0 8px}
.o3c .appr .a-s .amt2{color:var(--ink)}
.o3c .a-actions{display:flex;gap:6px}
.o3c .a-btn{font-size:11px;font-weight:600;border-radius:3px;padding:4px 12px;cursor:pointer;border:1px solid var(--hair);background:var(--surface);color:var(--ink)}
.o3c .a-btn.ok{background:var(--green);border-color:var(--green);color:#fff}
.o3c .a-btn:hover{filter:brightness(1.06)}
.o3c .a-done{font-size:11px;font-weight:600}

.o3c .scroll{flex:1;overflow-y:auto}

/* HERO */
.o3c .hero{display:flex;align-items:flex-end;gap:56px;padding:26px 28px 24px;border-bottom:1px solid var(--hair)}
.o3c .hero-label{font-family:'Sora',sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px}
.o3c .hero-figure{font-family:'Roboto Mono',monospace;font-weight:600;font-size:46px;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.o3c .hero-figure .naira{font-size:24px;color:var(--ink-2);font-weight:500;vertical-align:18px;margin-right:2px}
.o3c .hero-delta{font-size:12px;color:var(--red);font-weight:600;margin-top:8px}
.o3c .hero-secondary{display:flex;gap:40px;padding-bottom:4px;flex-wrap:wrap}
.o3c .metric .m-label{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-weight:600;margin-bottom:5px;font-family:'Sora',sans-serif}
.o3c .metric .m-value{font-family:'Roboto Mono',monospace;font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}
.o3c .metric .m-sub{font-size:11px;color:var(--ink-2);margin-top:3px}
.o3c .metric .m-value .unit{font-size:12px;color:var(--ink-2);font-weight:500}

/* PAR bar */
.o3c .par-section{padding:20px 28px 22px;border-bottom:1px solid var(--hair)}
.o3c .sec-head{display:flex;align-items:baseline;gap:12px;margin-bottom:14px}
.o3c .sec-title{font-family:'Sora',sans-serif;font-size:13px;font-weight:600}
.o3c .sec-note{font-size:11px;color:var(--ink-3)}
.o3c .par-bar{display:flex;height:34px;border-radius:3px;overflow:hidden}
.o3c .par-seg{transition:filter .12s}
.o3c .par-seg:hover{filter:brightness(1.12)}
.o3c .par-legend{display:flex;gap:28px;margin-top:12px;flex-wrap:wrap}
.o3c .leg{display:flex;align-items:baseline;gap:8px}
.o3c .leg .sw{width:9px;height:9px;border-radius:2px}
.o3c .leg .l-name{font-size:11px;color:var(--ink-2);font-weight:500}
.o3c .leg .l-val{font-family:'Roboto Mono',monospace;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}
.o3c .leg .l-pct{font-family:'Roboto Mono',monospace;font-size:11px;color:var(--ink-3)}

/* TABLE (base) */
.o3c table{width:100%;border-collapse:collapse}
.o3c thead th{position:sticky;top:0;background:var(--canvas);font-family:'Sora',sans-serif;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);text-align:left;padding:8px 14px;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);z-index:2;white-space:nowrap}
.o3c thead th.r,.o3c td.r{text-align:right}
.o3c thead th.sortable{cursor:pointer;user-select:none}
.o3c thead th.sortable:hover{color:var(--ink)}
.o3c .sort-arrow{color:var(--red);margin-left:4px;font-size:9px;font-family:'Roboto Mono',monospace}
.o3c tbody td{padding:0 14px;height:38px;border-bottom:1px solid var(--hair);font-size:12.5px;white-space:nowrap}
.o3c tbody tr{cursor:pointer}
.o3c tbody tr:hover td{background:var(--hover)}
.o3c td:first-child,.o3c th:first-child{padding-left:28px}
.o3c td:last-child,.o3c th:last-child{padding-right:28px}
.o3c .cif{font-family:'Roboto Mono',monospace;font-size:11.5px;color:var(--ink-2)}
.o3c .cust{font-weight:600}
.o3c .amt{font-family:'Roboto Mono',monospace;font-weight:500;font-variant-numeric:tabular-nums}
.o3c .dpd{font-family:'Roboto Mono',monospace;font-weight:600;font-variant-numeric:tabular-nums}
.o3c .bucket{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.05em;border-radius:3px;padding:2px 7px;font-family:'Sora',sans-serif}
.o3c .b-cur{background:var(--cur-soft);color:var(--cur-ink)}
.o3c .b-30{background:var(--sky-soft);color:#0369A1}
.o3c .b-60{background:var(--amber-soft);color:var(--amber)}
.o3c .b-90{background:var(--red-soft);color:var(--red)}
.o3c .ptp{font-size:11.5px;color:var(--ink-2)}
.o3c .ptp.today{color:var(--green);font-weight:600}
.o3c .ptp.broken{color:var(--red);font-weight:600}

/* PAGE-LEVEL DATE BAR */
.o3c .page-date-bar{display:flex;align-items:center;gap:10px;padding:10px 28px;border-bottom:1px solid var(--hair);position:relative;z-index:10}
.o3c .page-date-count{font-family:'Roboto Mono',monospace;font-size:11px;color:var(--ink-3)}

/* TOOLBAR (DataTable-style) */
.o3c .tbl-bar{display:flex;align-items:center;gap:8px;padding:12px 20px;border-bottom:1px solid var(--hair);flex-wrap:wrap}
.o3c .tbl-title{font-size:13px;font-weight:600;color:var(--ink);margin-right:4px;white-space:nowrap;font-family:'Sora',sans-serif}
.o3c .tbl-count-r{margin-left:auto;font-size:11.5px;color:var(--ink-2);font-family:'Roboto Mono',monospace;white-space:nowrap}
.o3c .srch{display:flex;align-items:center;gap:6px;border:1.5px solid var(--hair);border-radius:8px;padding:5px 10px;background:var(--surface);flex-shrink:0}
.o3c .srch:focus-within{border-color:var(--sky)}
.o3c .srch svg{width:14px;height:14px;color:var(--ink-3);flex-shrink:0}
.o3c .srch input{border:none;outline:none;background:none;font-family:inherit;font-size:12.5px;color:var(--ink);width:160px}
.o3c .flt-btn{display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:600;border:1.5px solid var(--hair);background:transparent;color:var(--ink-2);cursor:pointer;font-family:inherit;white-space:nowrap;position:relative}
.o3c .flt-btn:hover{border-color:var(--ink-3)}
.o3c .flt-btn.active{border-color:var(--red);color:var(--red)}
.o3c .flt-pip{position:absolute;top:-6px;right:-6px;width:16px;height:16px;border-radius:50%;background:var(--red);color:#fff;font-size:9px;font-weight:700;font-family:'Roboto Mono',monospace;display:flex;align-items:center;justify-content:center}

/* FILTER PANEL */
.o3c .flt-panel{border-bottom:1px solid var(--hair)}
.o3c .flt-grid{display:grid;grid-template-columns:repeat(3,1fr);padding:20px 20px 0}
.o3c .flt-col{padding:0 20px;border-right:1px solid var(--hair)}
.o3c .flt-col:first-child{padding-left:0}
.o3c .flt-col:last-child{border-right:none;padding-right:0}
.o3c .flt-col-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin-bottom:12px;font-family:'Roboto Mono',monospace}
.o3c .flt-row{display:flex;align-items:center;gap:9px;margin-bottom:9px;cursor:pointer}
.o3c .flt-row input[type="checkbox"]{accent-color:#0E2841;width:14px;height:14px;cursor:pointer;flex-shrink:0}
.o3c .f-label{font-size:12px;color:var(--ink)}
.o3c .f-count{margin-left:auto;font-size:11px;color:var(--ink-3);font-family:'Roboto Mono',monospace}
.o3c .flt-foot{padding:14px 20px;border-top:1px solid var(--hair);margin-top:16px;display:flex;align-items:center;gap:12px}
.o3c .flt-status{font-size:12px;color:var(--ink-3)}
.o3c .flt-done{padding:5px 16px;border-radius:7px;border:none;background:var(--red);color:#fff;font-size:12px;font-weight:600;cursor:pointer;margin-left:auto;font-family:inherit}
.o3c .flt-reset{padding:5px 12px;border-radius:7px;border:1.5px solid var(--hair);background:transparent;color:var(--ink-2);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}

/* ACTIVE CHIPS */
.o3c .chips-bar{padding:8px 20px;border-bottom:1px solid var(--hair);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.o3c .a-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:20px;font-size:11.5px;font-weight:600;background:var(--sky-soft);color:#0369A1}
.o3c[data-theme="dark"] .a-chip{color:#7DD3FC}
.o3c .a-chip-x{cursor:pointer;font-size:11px;line-height:1;margin-left:2px}
.o3c .clear-all{border:none;background:none;cursor:pointer;font-size:11.5px;font-weight:600;color:var(--ink-3);padding:0;font-family:inherit}

/* DATE FILTER */
.o3c .df-wrap{position:relative}
.o3c .df-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:7px;font-size:12.5px;font-weight:500;border:1.5px solid var(--hair);background:var(--surface);color:var(--ink);cursor:pointer;white-space:nowrap;font-family:inherit}
.o3c .df-btn:hover{border-color:var(--ink-3)}
.o3c .df-btn.open{border-color:#0E2841}
.o3c[data-theme="dark"] .df-btn.open{border-color:var(--sky)}
.o3c .df-btn svg{width:14px;height:14px;flex-shrink:0;color:var(--ink-3)}
.o3c .df-panel{position:absolute;top:calc(100% + 6px);left:0;z-index:50;background:var(--surface);border:1px solid var(--hair);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.16);display:flex;overflow:hidden}
.o3c .df-presets{width:136px;border-right:1px solid var(--hair);padding:10px 0;flex-shrink:0}
.o3c .df-sep{height:1px;background:var(--hair);margin:4px 0}
.o3c .df-pbtn{display:flex;align-items:center;gap:6px;width:100%;padding:6px 12px;background:transparent;border:none;cursor:pointer;font-size:12.5px;font-family:inherit;color:var(--ink);text-align:left;white-space:nowrap}
.o3c .df-pbtn:hover{background:var(--hover)}
.o3c .df-pbtn.on{font-weight:600;color:#0E2841}
.o3c[data-theme="dark"] .df-pbtn.on{color:var(--sky)}
.o3c .df-pbtn .chk{font-size:11px;color:#0E2841;opacity:0;flex-shrink:0}
.o3c .df-pbtn.on .chk{opacity:1}
.o3c[data-theme="dark"] .df-pbtn .chk{color:var(--sky)}
.o3c .df-cal{padding:14px 16px 12px}
.o3c .df-nav{display:flex;align-items:center;margin-bottom:12px}
.o3c .df-navbtn{width:28px;height:28px;border-radius:6px;border:1px solid var(--hair);background:var(--surface);cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--ink-2);font-size:14px}
.o3c .df-months{display:flex;gap:16px}
.o3c .df-div{width:1px;background:var(--hair)}
.o3c .df-mttl{text-align:center;font-size:12.5px;font-weight:700;color:var(--ink);margin-bottom:8px}
.o3c .df-g7{display:grid;grid-template-columns:repeat(7,30px)}
.o3c .df-wd{text-align:center;font-size:10px;font-weight:700;color:var(--ink-3);height:22px;line-height:22px;text-transform:uppercase}
.o3c .df-day{position:relative;height:30px;cursor:pointer;width:30px}
.o3c .df-strip{position:absolute;top:4px;bottom:4px;background:rgba(14,40,65,.09);z-index:0}
.o3c[data-theme="dark"] .df-strip{background:rgba(14,165,233,.15)}
.o3c .df-circle{position:relative;z-index:1;width:26px;height:26px;border-radius:50%;margin:2px auto;display:flex;align-items:center;justify-content:center;font-size:12px;transition:background .08s;box-sizing:border-box}
.o3c .df-foot{margin-top:12px;padding-top:10px;border-top:1px solid var(--hair);display:flex;align-items:center;gap:8px;min-height:34px}
.o3c .df-clr{padding:4px 10px;border-radius:6px;border:1px solid var(--hair);background:var(--surface);color:var(--ink-2);font-size:12px;cursor:pointer;font-weight:500;font-family:inherit}

/* PAGINATION */
.o3c .pagi{display:flex;align-items:center;justify-content:space-between;padding:10px 28px;border-top:1px solid var(--hair)}
.o3c .pagi-info{font-family:'Roboto Mono',monospace;font-size:11px;color:var(--ink-3)}
.o3c .pagi-btns{display:flex;align-items:center;gap:4px}
.o3c .pagi-btn{min-width:28px;height:28px;border-radius:3px;border:1px solid var(--hair);background:var(--surface);color:var(--ink-2);font-size:11.5px;cursor:pointer;font-family:'Roboto Mono',monospace;display:flex;align-items:center;justify-content:center;padding:0 8px}
.o3c .pagi-btn:hover:not(:disabled):not(.current){border-color:var(--ink-3);color:var(--ink)}
.o3c .pagi-btn.current{background:#0E2841;border-color:#0E2841;color:#fff;font-weight:600}
.o3c[data-theme="dark"] .pagi-btn.current{background:var(--sky);border-color:var(--sky);color:#06202F}
.o3c .pagi-btn:disabled{opacity:.38;cursor:default}

/* MAIL */
.o3c .mail-wrap{display:flex;height:100%;flex:1;min-height:0}
.o3c .mail-list{width:390px;min-width:300px;border-right:1px solid var(--hair);overflow-y:auto}
.o3c .mail-list-head{display:flex;align-items:center;padding:14px 18px 10px}
.o3c .mail-folder-title{font-family:'Sora',sans-serif;font-size:13px;font-weight:600}
.o3c .mail-count{margin-left:8px;font-family:'Roboto Mono',monospace;font-size:11px;color:var(--ink-3)}
.o3c .mail-item{padding:11px 18px;border-bottom:1px solid var(--hair);cursor:pointer}
.o3c .mail-item:hover{background:var(--hover)}
.o3c .mail-item.sel{background:var(--hover);box-shadow:inset 3px 0 0 var(--sky)}
.o3c .mail-item .m-row1{display:flex;align-items:baseline}
.o3c .mail-item .m-from{font-weight:600;font-size:12.5px}
.o3c .mail-item.unread .m-from::before{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--sky);margin-right:7px;vertical-align:1px}
.o3c .mail-item .m-time{margin-left:auto;font-family:'Roboto Mono',monospace;font-size:10.5px;color:var(--ink-3)}
.o3c .mail-item .m-subj{font-size:12px;margin-top:2px}
.o3c .mail-item.unread .m-subj{font-weight:600}
.o3c .mail-item .m-prev{font-size:11.5px;color:var(--ink-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.o3c .mail-read{flex:1;overflow-y:auto;padding:24px 32px;min-width:0}
.o3c .mail-read .r-subj{font-family:'Sora',sans-serif;font-size:16px;font-weight:600;margin-bottom:12px}
.o3c .mail-read .r-meta{display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px solid var(--hair);margin-bottom:18px;font-size:12px;color:var(--ink-2)}
.o3c .mail-read .r-body{font-size:13px;line-height:1.65;max-width:640px;white-space:pre-line}
.o3c .mail-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--ink-3);font-size:12.5px}

/* MODALS */
.o3c .modal-veil{position:fixed;inset:0;background:var(--veil);display:flex;align-items:center;justify-content:center;z-index:60}
.o3c .compose{width:560px;max-width:94vw;background:var(--surface);border-radius:6px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.35)}
.o3c .compose-head{display:flex;align-items:center;background:#0E2841;color:#fff;padding:11px 16px;font-family:'Sora',sans-serif;font-size:12.5px;font-weight:600}
.o3c .compose-head button{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.6);font-size:16px;cursor:pointer}
.o3c .compose input,.o3c .compose textarea{width:100%;border:none;outline:none;background:none;color:var(--ink);font-family:'IBM Plex Sans',sans-serif;font-size:13px;padding:11px 16px;border-bottom:1px solid var(--hair)}
.o3c .compose textarea{height:200px;resize:vertical;border-bottom:none}
.o3c .compose-foot{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--hair)}

/* CUSTOMER 360 */
.o3c .c360-veil{position:fixed;inset:0;background:var(--veil);z-index:55}
.o3c .c360-panel{position:fixed;top:0;right:0;width:440px;max-width:94vw;height:100%;background:var(--surface);border-left:1px solid var(--hair);z-index:56;display:flex;flex-direction:column;animation:o3cSlide .22s ease}
@keyframes o3cSlide{from{transform:translateX(100%)}to{transform:translateX(0)}}
.o3c .c3-head{padding:20px 24px 16px;border-bottom:1px solid var(--hair)}
.o3c .c3-close{float:right;background:none;border:none;font-size:18px;color:var(--ink-3);cursor:pointer}
.o3c .c3-name{font-family:'Sora',sans-serif;font-size:17px;font-weight:600}
.o3c .c3-cif{font-family:'Roboto Mono',monospace;font-size:11.5px;color:var(--ink-3);margin-top:3px}
.o3c .c3-tags{display:flex;gap:6px;margin-top:10px}
.o3c .c3-body{flex:1;overflow-y:auto}
.o3c .c3-sec{padding:16px 24px;border-bottom:1px solid var(--hair)}
.o3c .c3-sec-title{font-family:'Sora',sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);margin-bottom:12px}
.o3c .c3-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 20px}
.o3c .c3-kv .k{font-size:10.5px;color:var(--ink-3);margin-bottom:3px}
.o3c .c3-kv .v{font-size:13px;font-weight:600}
.o3c .c3-prod{display:flex;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--hair);font-size:12.5px}
.o3c .c3-prod:last-child{border-bottom:none}
.o3c .c3-prod .p-name{font-weight:600}
.o3c .c3-prod .p-amt{margin-left:auto;font-family:'Roboto Mono',monospace;font-weight:500;font-variant-numeric:tabular-nums}
.o3c .c3-ev{display:flex;gap:12px;padding:8px 0;font-size:12px}
.o3c .c3-ev .e-time{font-family:'Roboto Mono',monospace;font-size:10.5px;color:var(--ink-3);min-width:52px;padding-top:1px}
.o3c .c3-foot{padding:14px 24px;border-top:1px solid var(--hair);display:flex;gap:8px}

/* ⌘K PALETTE */
.o3c .palette-veil{position:fixed;inset:0;background:var(--veil);display:flex;align-items:flex-start;justify-content:center;padding-top:14vh;z-index:50;backdrop-filter:blur(2px)}
.o3c .palette{width:520px;max-width:92vw;background:var(--surface);border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden}
.o3c .palette input{width:100%;border:none;outline:none;background:none;color:var(--ink);font-size:14px;padding:15px 18px;border-bottom:1px solid var(--hair);font-family:'IBM Plex Sans',sans-serif}
.o3c .palette-list{max-height:300px;overflow-y:auto;padding:6px 0}
.o3c .p-group{font-family:'Sora',sans-serif;font-size:9.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);padding:8px 18px 4px}
.o3c .p-item{display:flex;align-items:center;gap:10px;padding:8px 18px;cursor:pointer;font-size:12.5px}
.o3c .p-item:hover{background:var(--hover)}
.o3c .p-item .p-kbd{margin-left:auto;font-family:'Roboto Mono',monospace;font-size:10px;color:var(--ink-3)}

@media (max-width:900px){
  .o3c .hero{flex-direction:column;align-items:flex-start;gap:22px}
  .o3c .c360-srch{display:none}
  .o3c .mail-list{width:100%}
  .o3c .mail-read,.o3c .mail-empty{display:none}
}
@media (prefers-reduced-motion:reduce){.o3c *{transition:none!important;animation:none!important}}
`;

/* ---------------- SMALL COMPONENTS ---------------- */
function Pip({ n }: { n: number }) {
  return n > 0 ? <span className="pip num">{n}</span> : null;
}

function useCountUp(target: number, duration = 900) {
  const [val, setVal] = useState(target);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setVal(target); return; }
    let raf: number;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - t0) / duration, 1);
      setVal(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

/* ---- Calendar month grid ---- */
const DF_WEEKDAYS = ["Mo","Tu","We","Th","Fr","Sa","Su"];
const DF_CELL = 30;

function DFMonthGrid({ year, month, lo, hi, pendingStart, onDay, onHover }: {
  year: number; month: number; lo: string; hi: string; pendingStart: string | null;
  onDay: (iso: string) => void; onHover: (iso: string | null) => void;
}) {
  const firstDow = new Date(year, month - 1, 1).getDay();
  const offset = firstDow === 0 ? 6 : firstDow - 1;
  const daysCount = new Date(year, month, 0).getDate();
  const t = _today();
  const cells: (number | null)[] = [...Array(offset).fill(null), ...Array.from({ length: daysCount }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  return (
    <div style={{ userSelect: "none" }}>
      <div className="df-mttl">{_dfMonthLabel(year, month)}</div>
      <div className="df-g7" style={{ marginBottom: 2 }}>
        {DF_WEEKDAYS.map(d => <div key={d} className="df-wd">{d}</div>)}
      </div>
      {Array.from({ length: cells.length / 7 }, (_, wi) => (
        <div key={wi} className="df-g7">
          {cells.slice(wi * 7, wi * 7 + 7).map((day, di) => {
            if (!day) return <div key={di} style={{ height: DF_CELL }} />;
            const iso = _dfIso(year, month, day);
            const isLo = !!lo && iso === lo;
            const isHi = !!hi && iso === hi && lo !== hi;
            const mid = !!lo && !!hi && lo !== hi && iso > lo && iso < hi;
            const single = !!lo && lo === hi && iso === lo;
            const filled = isLo || isHi || single;
            const hasBg = isLo || isHi || mid;
            const isToday = iso === t;
            const isPend = !!pendingStart && iso === pendingStart;
            return (
              <div key={di} className="df-day"
                onClick={() => onDay(iso)} onMouseEnter={() => onHover(iso)} onMouseLeave={() => onHover(null)}>
                {hasBg && <div className="df-strip" style={{ left: isLo ? "50%" : 0, right: isHi ? "50%" : 0 }} />}
                <div className="df-circle" style={{
                  background: filled ? "#0E2841" : isPend ? "rgba(14,40,65,.12)" : "transparent",
                  color: filled ? "#fff" : isToday ? "#0E2841" : "var(--ink)",
                  fontWeight: filled || isToday ? 700 : 400,
                  border: isToday && !filled ? "1.5px solid #0E2841" : "none",
                }}>{day}</div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---- Date filter (self-managing, position:absolute panel) ---- */
function DFDateFilter({ from, to, onChange }: { from: string; to: string; onChange: (f: string, t: string) => void }) {
  const now = new Date();
  const [open, setOpen] = useState(false);
  const [leftY, setLeftY] = useState(now.getFullYear());
  const [leftM, setLeftM] = useState(now.getMonth() + 1);
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [rightY, rightM] = _dfNextYM(leftY, leftM);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false); setPendingStart(null); setHover(null);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const effFrom = pendingStart ?? from;
  const effTo = pendingStart ? (hover ?? pendingStart) : to;
  const lo = effFrom && effTo ? (effFrom <= effTo ? effFrom : effTo) : (effFrom || effTo);
  const hi = effFrom && effTo ? (effFrom <= effTo ? effTo : effFrom) : (effFrom || effTo);

  function handleDay(iso: string) {
    if (!pendingStart) { setPendingStart(iso); }
    else {
      const [f, t] = iso >= pendingStart ? [pendingStart, iso] : [iso, pendingStart];
      onChange(f, t); setPendingStart(null); setHover(null); setOpen(false);
    }
  }
  function applyPreset(f: string, t: string) { onChange(f, t); setPendingStart(null); setHover(null); setOpen(false); }

  const btnLabel = !from && !to ? "All time" : from === to ? _fmtDate(from) : `${_fmtDate(from)} – ${_fmtDate(to)}`;

  const d = new Date();
  const PRESETS: [string, string, string][][] = [
    [["", "", "All time"]],
    [
      [_today(), _today(), "Today"],
      [_dfRelDay(6), _today(), "Last 7 days"],
      [_dfRelDay(29), _today(), "Last 30 days"],
      [_dfRelDay(89), _today(), "Last 90 days"],
    ],
    [
      [_monthStart(d.getFullYear(), d.getMonth() + 1), _today(), "This month"],
      (() => { const [py, pm] = _dfPrevYM(d.getFullYear(), d.getMonth() + 1); return [_monthStart(py, pm), _monthEnd(py, pm), "Last month"] as [string, string, string]; })(),
    ],
    [
      (() => { const [s, e] = _dfThisQuarter(); return [s, e, "This quarter"] as [string, string, string]; })(),
      (() => { const [s, e] = _dfLastQuarter(); return [s, e, "Last quarter"] as [string, string, string]; })(),
      [_yearStart(d.getFullYear()), _today(), "This year"],
    ],
  ];

  return (
    <div className="df-wrap" ref={ref}>
      <button className={`df-btn${open ? " open" : ""}`} onClick={() => setOpen(o => !o)}>
        <span style={{ width: 14, height: 14, display: "flex" }}>{I.calendar}</span>
        <span style={{ color: !from && !to ? "var(--ink-3)" : "var(--ink)" }}>{btnLabel}</span>
        <span style={{ fontSize: 10, color: "var(--ink-3)", marginLeft: 2 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="df-panel">
          <div className="df-presets">
            {PRESETS.map((group, gi) => (
              <div key={gi}>
                {gi > 0 && <div className="df-sep" />}
                {group.map(([f, t, label]) => (
                  <button key={label} className={`df-pbtn${f === from && t === to ? " on" : ""}`} onClick={() => applyPreset(f, t)}>
                    <span className="chk">✓</span>{label}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="df-cal">
            <div className="df-nav">
              <button className="df-navbtn" onClick={() => { const [y, m] = _dfPrevYM(leftY, leftM); setLeftY(y); setLeftM(m); }}>‹</button>
              <div style={{ flex: 1 }} />
              <button className="df-navbtn" onClick={() => { const [y, m] = _dfNextYM(leftY, leftM); setLeftY(y); setLeftM(m); }}>›</button>
            </div>
            <div className="df-months">
              <DFMonthGrid year={leftY} month={leftM} lo={lo} hi={hi} pendingStart={pendingStart} onDay={handleDay} onHover={setHover} />
              <div className="df-div" />
              <DFMonthGrid year={rightY} month={rightM} lo={lo} hi={hi} pendingStart={pendingStart} onDay={handleDay} onHover={setHover} />
            </div>
            <div className="df-foot">
              {pendingStart
                ? <span style={{ fontSize: 12, color: "var(--ink-3)", flex: 1 }}>Click a second day to complete the range</span>
                : (from || to)
                  ? <><span style={{ fontSize: 12.5, color: "var(--ink-2)", flex: 1 }}>
                      {from === to ? _fmtDate(from) : `${_fmtDate(from)} – ${_fmtDate(to)}`}
                    </span>
                    <button className="df-clr" onClick={() => applyPreset("", "")}>Clear</button></>
                  : <span style={{ fontSize: 12, color: "var(--ink-3)", flex: 1 }}>Click a day to start selecting a range</span>
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- MAIN APP ---------------- */
export default function O3CWorkspace() {
  /* theme / layout */
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [rail, setRail] = useState(false);
  const [subOpen, setSubOpen] = useState({ los: false, col: true, rec: false, mail: false });
  const [view, setView] = useState<"collections" | "mail">("collections");

  /* mail */
  const [folder, setFolder] = useState<"inbox" | "sent" | "drafts">("inbox");
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [mail, setMail] = useState<MailStore>(INITIAL_MAIL);

  /* notifications / approvals / panels */
  const [notifs, setNotifs] = useState<Notif[]>(INITIAL_NOTIFS);
  const [approvals, setApprovals] = useState<Approval[]>(INITIAL_APPROVALS);
  const [panel, setPanel] = useState<"notif" | "appr" | null>(null);

  /* customer 360 */
  const [c360, setC360] = useState<string | null>(null);
  const [c360Query, setC360Query] = useState("");
  const [c360Open, setC360Open] = useState(false);

  /* overlays */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [cmp, setCmp] = useState({ to: "", subj: "", body: "" });

  /* collections table controls */
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>({
    branch: new Set(), bucket: new Set(), ptpClass: new Set(),
  });
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  /* derived */
  const heroVal = useCountUp(412684210);
  const unreadCount = mail.inbox.filter(m => m.unread).length;
  const notifUnread = notifs.filter(n => !n.read).length;
  const apprPending = approvals.filter(a => !a.status).length;
  const activeCount = activeFilters.branch.size + activeFilters.bucket.size + activeFilters.ptpClass.size;

  /* filtered + sorted + paginated rows */
  let displayRows = QUEUE.filter(r => {
    if (dateFrom && r.ptpDate < dateFrom) return false;
    if (dateTo && r.ptpDate > dateTo) return false;
    return true;
  });
  if (search.trim()) {
    const q = search.toLowerCase();
    displayRows = displayRows.filter(r =>
      r.name.toLowerCase().includes(q) || r.cif.toLowerCase().includes(q) ||
      r.branch.toLowerCase().includes(q) || r.product.toLowerCase().includes(q)
    );
  }
  if (activeFilters.branch.size)   displayRows = displayRows.filter(r => activeFilters.branch.has(r.branch));
  if (activeFilters.bucket.size)   displayRows = displayRows.filter(r => activeFilters.bucket.has(r.bucket));
  if (activeFilters.ptpClass.size) displayRows = displayRows.filter(r => activeFilters.ptpClass.has(r.ptpClass));
  if (sortKey) {
    displayRows = [...displayRows].sort((a, b) => {
      let av: string | number = a[sortKey];
      let bv: string | number = b[sortKey];
      if (typeof av === "string") { av = av.toLowerCase(); bv = (bv as string).toLowerCase(); }
      return sortDir === "asc"
        ? av < bv ? -1 : av > bv ? 1 : 0
        : av > bv ? -1 : av < bv ? 1 : 0;
    });
  }
  const totalPages = Math.max(1, Math.ceil(displayRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = displayRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  /* helpers */
  const toggleSort = (key: SortKey) => {
    setPage(1);
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };
  const sortArrow = (key: SortKey) => (
    <span className="sort-arrow">{sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : "↕"}</span>
  );

  const toggleFilter = (group: keyof ActiveFilters, val: string) => {
    setPage(1);
    setActiveFilters(f => {
      const s = new Set(f[group]);
      s.has(val) ? s.delete(val) : s.add(val);
      return { ...f, [group]: s };
    });
  };
  const resetFilters = () => {
    setPage(1); setSearch(""); setDateFrom(""); setDateTo("");
    setActiveFilters({ branch: new Set(), bucket: new Set(), ptpClass: new Set() });
  };

  /* global keyboard */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen(o => !o); }
      if (e.key === "Escape") { setPaletteOpen(false); setC360(null); setComposeOpen(false); setPanel(null); setC360Open(false); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* outside-click closes panels / dropdowns */
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!t.closest(".panel") && !t.closest(".icon-btn")) setPanel(null);
      if (!t.closest(".c360-srch")) setC360Open(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const toggleSub = (k: keyof typeof subOpen) => setSubOpen(s => ({ ...s, [k]: !s[k] }));
  const openMailView = () => { setView("mail"); setSubOpen(s => ({ ...s, mail: true })); };
  const goFolder = (f: "inbox" | "sent" | "drafts") => { setView("mail"); setFolder(f); setSelIdx(null); };

  const readMail = (i: number) => {
    setSelIdx(i);
    if (folder === "inbox") setMail(m => ({ ...m, inbox: m.inbox.map((x, xi) => xi === i ? { ...x, unread: false } : x) }));
  };

  const sendMail = () => {
    setMail(m => ({ ...m, sent: [{ from: "To: " + (cmp.to || "—"), subj: cmp.subj || "(no subject)", prev: (cmp.body || "…").slice(0, 90), time: "Now", unread: false, body: cmp.body || "—" }, ...m.sent] }));
    setComposeOpen(false); setCmp({ to: "", subj: "", body: "" }); goFolder("sent");
  };
  const saveDraft = () => {
    setMail(m => ({ ...m, drafts: [{ from: "Draft", subj: cmp.subj || "(no subject)", prev: (cmp.body || "…").slice(0, 90), time: "Now", unread: false, body: cmp.body || "" }, ...m.drafts] }));
    setComposeOpen(false); setCmp({ to: "", subj: "", body: "" }); goFolder("drafts");
  };

  const act = (id: string, ok: boolean) =>
    setApprovals(a => a.map(x => x.id === id ? { ...x, status: ok ? "approved" : "rejected" } : x));

  const hits = Object.entries(CUSTOMERS).filter(([cif, c]) => {
    const q = c360Query.toLowerCase().trim();
    return !q || c.name.toLowerCase().includes(q) || cif.toLowerCase().includes(q);
  }).slice(0, 5);

  const openC360 = useCallback((cif: string) => {
    setC360(cif); setC360Open(false); setC360Query(""); setPaletteOpen(false);
  }, []);
  const startCustomerCall = useCallback((customer: Customer) => {
    window.dispatchEvent(new CustomEvent("o3c:dial", {
      detail: { phoneNumber: customer.phone, autoStart: true },
    }));
  }, []);

  const cust = c360 ? CUSTOMERS[c360] : null;
  const riskBucket = cust ? (cust.risk === "Low" ? "b-cur" : cust.risk === "Medium" ? "b-60" : "b-90") : "";
  const selMail = selIdx !== null ? mail[folder][selIdx] : null;

  /* active filter chips rendering */
  const filterChips: { group: keyof ActiveFilters; val: string; label: string }[] = [];
  activeFilters.branch.forEach(v => filterChips.push({ group: "branch", val: v, label: v }));
  activeFilters.bucket.forEach(v => filterChips.push({ group: "bucket", val: v, label: BUCKET_DISPLAY[v] }));
  activeFilters.ptpClass.forEach(v => filterChips.push({ group: "ptpClass", val: v, label: PTP_DISPLAY[v] }));

  return (
    <div className="o3c" data-theme={theme}>
      <style>{CSS}</style>

      {/* =============== SIDEBAR =============== */}
      <aside className={rail ? "rail" : ""}>
        <div className="brand">
          <div className="brand-mark">O3</div>
          <div><div className="brand-name">O3 Capital</div><div className="brand-sub">WORKSPACE</div></div>
          <button className="collapse-btn" onClick={() => setRail(r => !r)}>⟨⟩</button>
        </div>

        <div className="cmdk" onClick={() => setPaletteOpen(true)}>
          <span className="nav-icon">{I.search}</span> Jump to… <kbd>⌘K</kbd>
        </div>

        <nav>
          <div className="nav-sec"><div className="nav-sec-label">Lending</div></div>
          <div className={`nav-item ${subOpen.los ? "open" : ""}`} onClick={() => toggleSub("los")}>
            <span className="nav-icon">{I.plus}</span><span className="lbl">Loan Origination</span>
            <span className="nav-badge num">12</span><span className="caret">▶</span>
          </div>
          <div className={`sub ${subOpen.los ? "open" : ""}`}>
            <div className="sub-item">Applications<span className="sub-badge">8</span></div>
            <div className="sub-item">Underwriting<span className="sub-badge">3</span></div>
            <div className="sub-item">Disbursement<span className="sub-badge">1</span></div>
          </div>

          <div className={`nav-item ${view === "collections" ? "active" : ""} ${subOpen.col ? "open" : ""}`}
            onClick={() => { setView("collections"); toggleSub("col"); }}>
            <span className="nav-icon">{I.chart}</span><span className="lbl">Collections</span>
            <span className="nav-badge hot num">37</span><span className="caret">▶</span>
          </div>
          <div className={`sub ${subOpen.col ? "open" : ""}`}>
            <div className={`sub-item ${view === "collections" ? "active" : ""}`} onClick={() => setView("collections")}>
              PTP Queue<span className="sub-badge">37</span>
            </div>
            <div className="sub-item">Field Visits<span className="sub-badge">6</span></div>
            <div className="sub-item">Dunning Letters</div>
          </div>

          <div className={`nav-item ${subOpen.rec ? "open" : ""}`} onClick={() => toggleSub("rec")}>
            <span className="nav-icon">{I.refresh}</span><span className="lbl">Recovery</span><span className="caret">▶</span>
          </div>
          <div className={`sub ${subOpen.rec ? "open" : ""}`}>
            <div className="sub-item">Write-off Review</div>
            <div className="sub-item">Legal Cases<span className="sub-badge">2</span></div>
          </div>

          <div className="nav-sec"><div className="nav-sec-label">Operations</div></div>
          <div className="nav-item"><span className="nav-icon">{I.card}</span><span className="lbl">Cards Operations</span><span className="nav-badge num">4</span></div>
          <div className="nav-item"><span className="nav-icon">{I.users}</span><span className="lbl">CRM</span></div>

          <div className="nav-sec"><div className="nav-sec-label">Workspace</div></div>
          <div className={`nav-item ${view === "mail" ? "active" : ""} ${subOpen.mail ? "open" : ""}`} onClick={openMailView}>
            <span className="nav-icon">{I.mail}</span><span className="lbl">Mail</span>
            {unreadCount > 0 && <span className="nav-badge num">{unreadCount}</span>}<span className="caret">▶</span>
          </div>
          <div className={`sub ${subOpen.mail ? "open" : ""}`}>
            <div className={`sub-item ${view === "mail" && folder === "inbox" ? "active" : ""}`} onClick={() => goFolder("inbox")}>
              Inbox{unreadCount > 0 && <span className="sub-badge">{unreadCount}</span>}
            </div>
            <div className="sub-item" onClick={() => setComposeOpen(true)}>Compose</div>
            <div className={`sub-item ${view === "mail" && folder === "sent" ? "active" : ""}`} onClick={() => goFolder("sent")}>Sent Mail</div>
            <div className={`sub-item ${view === "mail" && folder === "drafts" ? "active" : ""}`} onClick={() => goFolder("drafts")}>
              Drafts<span className="sub-badge">{mail.drafts.length}</span>
            </div>
          </div>

          <div className="nav-sec"><div className="nav-sec-label">Intelligence</div></div>
          <div className="nav-item" onClick={() => setView("collections")}>
            <span className="nav-icon">{I.bars}</span><span className="lbl">BI &amp; Reports</span>
          </div>
        </nav>

        <div className="side-footer">
          <div className="user-row">
            <div className="avatar">TA</div>
            <div className="user-meta"><div className="u-name">Temitope A.</div><div className="u-role">Head, Strategy &amp; BI</div></div>
          </div>
          <div className="sync-strip"><span className="dot" /> MSSQL sync · 09:42 · recon OK</div>
        </div>
      </aside>

      {/* =============== MAIN =============== */}
      <main>
        <header>
          <div className="head-titles">
            <div className="crumb">{view === "mail" ? "Workspace / Mail" : "Lending / Collections"}</div>
            <h1>{view === "mail" ? "Mail" : "Collections"}</h1>
          </div>

          {/* Customer 360 search */}
          <div className="c360-srch">
            <span style={{ width: 14, height: 14, display: "flex" }}>{I.search}</span>
            <input
              placeholder="Customer 360 — search name or CIF…"
              value={c360Query}
              onChange={e => { setC360Query(e.target.value); setC360Open(true); }}
              onFocus={() => setC360Open(true)}
            />
            {c360Open && (
              <div className="c360-results">
                {hits.length ? hits.map(([cif, c]) => (
                  <div key={cif} className="c360-hit" onClick={() => openC360(cif)}>
                    <strong>{c.name}</strong>
                    <span style={{ color: "var(--ink-3)" }}>{c.branch}</span>
                    <span className="cif cif-tag">{cif}</span>
                  </div>
                )) : (
                  <div className="c360-hit" style={{ color: "var(--ink-3)", cursor: "default" }}>
                    No customers match "{c360Query}"
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="header-right">
            <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(t => t === "light" ? "dark" : "light")}>
              {theme === "light" ? I.moon : I.sun}
            </button>

            <div style={{ position: "relative" }}>
              <button className="icon-btn" title="Approvals" onClick={() => setPanel(p => p === "appr" ? null : "appr")}>
                {I.check}<Pip n={apprPending} />
              </button>
              {panel === "appr" && (
                <div className="panel">
                  <div className="panel-head"><span className="panel-title">Pending approvals</span></div>
                  {approvals.map(a => (
                    <div className="appr" key={a.id}>
                      <div className="a-t">{a.title}</div>
                      <div className="a-s">{a.entity} · <span className="amt2 num">{a.amount}</span> · raised by {a.maker}</div>
                      {!a.status ? (
                        <div className="a-actions">
                          <button className="a-btn ok" onClick={() => act(a.id, true)}>Approve</button>
                          <button className="a-btn" onClick={() => act(a.id, false)}>Reject</button>
                        </div>
                      ) : (
                        <div className="a-done" style={{ color: a.status === "approved" ? "var(--green)" : "var(--red)" }}>
                          {a.status === "approved" ? "✓ Approved" : "✕ Rejected"}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ position: "relative" }}>
              <button className="icon-btn" title="Notifications" onClick={() => setPanel(p => p === "notif" ? null : "notif")}>
                {I.bell}<Pip n={notifUnread} />
              </button>
              {panel === "notif" && (
                <div className="panel">
                  <div className="panel-head">
                    <span className="panel-title">Notifications</span>
                    <button className="panel-clear" onClick={() => setNotifs(ns => ns.map(n => ({ ...n, read: true })))}>Mark all read</button>
                  </div>
                  {notifs.map((n, i) => (
                    <div className="notif" key={i}>
                      <span className="n-dot" style={{ background: n.read ? "var(--ink-3)" : `var(--${n.sev})` }} />
                      <div className="n-body">
                        <div className="n-t">{n.title}</div>
                        <div className="n-s">{n.sub}</div>
                        <div className="n-time">{n.time}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button className="btn primary" onClick={() => setComposeOpen(true)}>Log PTP</button>
          </div>
        </header>

        {/* =========== COLLECTIONS VIEW =========== */}
        {view === "collections" && (
          <div className="scroll">

            {/* ---- PAGE-LEVEL DATE FILTER ---- */}
            <div className="page-date-bar">
              <span className="page-date-count">
                {dateFrom || dateTo ? `${displayRows.length} of ${QUEUE.length} accounts` : `${QUEUE.length} accounts`}
              </span>
              <div style={{ marginLeft: "auto" }}>
                <DFDateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); setPage(1); }} />
              </div>
            </div>

            {/* ---- HERO ---- */}
            <section className="hero">
              <div>
                <div className="hero-label">Portfolio at Risk · All Branches</div>
                <div className="hero-figure num"><span className="naira">₦</span>{heroVal.toLocaleString("en-NG")}</div>
                <div className="hero-delta">▲ 2.4% vs last week</div>
              </div>
              <div className="hero-secondary">
                {([
                  ["PAR 30",       <>6.8<span className="unit">%</span></>,   "target ≤ 5.0%"],
                  ["PTPs Today",   String(displayRows.filter(r => r.ptpClass === "today").length), "in selected range"],
                  ["Kept Rate",    <>71.3<span className="unit">%</span></>,   "30-day rolling"],
                  ["Recovered MTD",<>₦96.4<span className="unit">M</span></>, "of ₦140M target"],
                ] as const).map(([l, v, s], i) => (
                  <div className="metric" key={i}>
                    <div className="m-label">{l}</div>
                    <div className="m-value">{v}</div>
                    <div className="m-sub">{s}</div>
                  </div>
                ))}
              </div>
            </section>

            {/* ---- PAR BAR ---- */}
            <section className="par-section">
              <div className="sec-head">
                <div className="sec-title">Delinquency aging</div>
                <div className="sec-note">Outstanding principal by DPD bucket · as at 09:42 WAT</div>
              </div>
              <div className="par-bar">
                {PAR_SEGMENTS.map((s, i) => (
                  <div key={i} className="par-seg" style={{ width: s.w, background: s.c }} title={`${s.name} — ${s.val}`} />
                ))}
              </div>
              <div className="par-legend">
                {PAR_SEGMENTS.map((s, i) => (
                  <div className="leg" key={i}>
                    <span className="sw" style={{ background: s.c }} />
                    <span className="l-name">{s.name}</span>
                    <span className="l-val num">{s.val}</span>
                    <span className="l-pct">{s.pct}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* ---- TABLE SECTION ---- */}
            <section style={{ paddingBottom: 40 }}>

              {/* ── Toolbar (DataTable-style) ── */}
              <div className="tbl-bar">
                <span className="tbl-title">PTP queue</span>

                <div className="srch">
                  <span style={{ width: 14, height: 14, display: "flex" }}>{I.search}</span>
                  <input placeholder="Search name, CIF, branch…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
                </div>

                <button className={`flt-btn${activeCount > 0 ? " active" : ""}`} onClick={() => setFilterOpen(o => !o)}>
                  <span style={{ width: 14, height: 14, display: "flex" }}>{I.tune}</span>
                  Filters
                  {activeCount > 0 && <span className="flt-pip">{activeCount}</span>}
                </button>

                <span className="tbl-count-r">{displayRows.length} of {QUEUE.length}</span>
              </div>

              {/* ── Expandable filter panel ── */}
              {filterOpen && (
                <div className="flt-panel">
                  <div className="flt-grid">
                    <div className="flt-col">
                      <div className="flt-col-title">Branch</div>
                      {BRANCH_OPTIONS.map(b => (
                        <label key={b} className="flt-row">
                          <input type="checkbox" checked={activeFilters.branch.has(b)} onChange={() => toggleFilter("branch", b)} />
                          <span className="f-label">{b}</span><span className="f-count">{branchCounts[b]}</span>
                        </label>
                      ))}
                    </div>
                    <div className="flt-col">
                      <div className="flt-col-title">Bucket</div>
                      {BUCKET_OPTIONS.map(b => (
                        <label key={b} className="flt-row">
                          <input type="checkbox" checked={activeFilters.bucket.has(b)} onChange={() => toggleFilter("bucket", b)} />
                          <span className="f-label">{BUCKET_DISPLAY[b]}</span><span className="f-count">{bucketCounts[b]}</span>
                        </label>
                      ))}
                    </div>
                    <div className="flt-col">
                      <div className="flt-col-title">PTP Status</div>
                      {PTP_OPTIONS.map(p => (
                        <label key={p} className="flt-row">
                          <input type="checkbox" checked={activeFilters.ptpClass.has(p)} onChange={() => toggleFilter("ptpClass", p)} />
                          <span className="f-label">{PTP_DISPLAY[p]}</span><span className="f-count">{ptpCounts[p]}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="flt-foot">
                    <span className="flt-status">
                      {activeCount === 0 ? `No filters applied — showing all ${QUEUE.length} rows` : `${activeCount} filter${activeCount !== 1 ? "s" : ""} active`}
                    </span>
                    <button className="flt-reset" onClick={resetFilters}>Reset</button>
                    <button className="flt-done" onClick={() => setFilterOpen(false)}>Done · {displayRows.length} results</button>
                  </div>
                </div>
              )}

              {/* ── Active filter chips (table filters only) ── */}
              {!filterOpen && filterChips.length > 0 && (
                <div className="chips-bar">
                  {filterChips.map(fc => (
                    <span key={`${fc.group}-${fc.val}`} className="a-chip">
                      {fc.label}
                      <span className="a-chip-x" onClick={() => toggleFilter(fc.group, fc.val)}>✕</span>
                    </span>
                  ))}
                  <button className="clear-all" onClick={resetFilters}>Clear all</button>
                </div>
              )}

              {/* table */}
              <table>
                <thead>
                  <tr>
                    <th>CIF</th>
                    <th className="sortable" onClick={() => toggleSort("name")}>Customer {sortArrow("name")}</th>
                    <th className="sortable" onClick={() => toggleSort("branch")}>Branch {sortArrow("branch")}</th>
                    <th>Product</th>
                    <th className="r sortable" onClick={() => toggleSort("amtKobo")}>Outstanding {sortArrow("amtKobo")}</th>
                    <th className="r sortable" onClick={() => toggleSort("dpd")}>DPD {sortArrow("dpd")}</th>
                    <th className="sortable" onClick={() => toggleSort("bucket")}>Bucket {sortArrow("bucket")}</th>
                    <th>PTP status</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: "center", padding: "24px 0", color: "var(--ink-3)" }}>No accounts match the current filters</td></tr>
                  ) : pageRows.map(r => (
                    <tr key={r.cif} onClick={() => openC360(r.cif)}>
                      <td className="cif">{r.cif}</td>
                      <td className="cust">{r.name}</td>
                      <td>{r.branch}</td>
                      <td>{r.product}</td>
                      <td className="r amt">{r.amt}</td>
                      <td className="r dpd" style={{ color: r.bucket === "b-90" ? "var(--red)" : r.bucket === "b-60" ? "var(--amber)" : "inherit" }}>{r.dpd}</td>
                      <td><span className={`bucket ${r.bucket}`}>{r.bucketLabel}</span></td>
                      <td className={`ptp ${r.ptpClass}`}>{r.ptp}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* pagination */}
              {totalPages > 1 && (
                <div className="pagi">
                  <span className="pagi-info">
                    {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, displayRows.length)} of {displayRows.length}
                  </span>
                  <div className="pagi-btns">
                    <button className="pagi-btn" disabled={safePage === 1} onClick={() => setPage(p => p - 1)}>‹</button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                      <button key={p} className={`pagi-btn${p === safePage ? " current" : ""}`} onClick={() => setPage(p)}>{p}</button>
                    ))}
                    <button className="pagi-btn" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* =========== MAIL VIEW =========== */}
        {view === "mail" && (
          <div className="mail-wrap">
            <div className="mail-list">
              <div className="mail-list-head">
                <span className="mail-folder-title">{folder[0].toUpperCase() + folder.slice(1)}</span>
                <span className="mail-count num">
                  {mail[folder].length}{folder === "inbox" ? ` · ${unreadCount} unread` : ""}
                </span>
                <button className="btn primary" style={{ marginLeft: "auto", padding: "5px 11px" }} onClick={() => setComposeOpen(true)}>Compose</button>
              </div>
              {mail[folder].map((m, i) => (
                <div key={i} className={`mail-item${m.unread ? " unread" : ""}${i === selIdx ? " sel" : ""}`} onClick={() => readMail(i)}>
                  <div className="m-row1"><span className="m-from">{m.from}</span><span className="m-time num">{m.time}</span></div>
                  <div className="m-subj">{m.subj}</div>
                  <div className="m-prev">{m.prev}</div>
                </div>
              ))}
            </div>
            {selMail ? (
              <div className="mail-read">
                <div className="r-subj">{selMail.subj}</div>
                <div className="r-meta">
                  <div className="avatar" style={{ width: 26, height: 26, minWidth: 26, fontSize: 10 }}>
                    {selMail.from.replace("To: ", "").split(" ").map(w => w[0]).slice(0, 2).join("")}
                  </div>
                  <strong>{selMail.from}</strong> · <span className="num">{selMail.time}</span>
                </div>
                <div className="r-body">{selMail.body}</div>
                <div style={{ marginTop: 22, display: "flex", gap: 8 }}>
                  <button className="btn primary" onClick={() => { setCmp({ to: "", subj: "Re: " + selMail.subj, body: "" }); setComposeOpen(true); }}>Reply</button>
                  <button className="btn">Forward</button>
                </div>
              </div>
            ) : (
              <div className="mail-empty">Select a message to read</div>
            )}
          </div>
        )}
      </main>

      {/* =========== COMPOSE =========== */}
      {composeOpen && (
        <div className="modal-veil" onMouseDown={e => { if (e.target === e.currentTarget) setComposeOpen(false); }}>
          <div className="compose">
            <div className="compose-head">New message <button onClick={() => setComposeOpen(false)}>✕</button></div>
            <input placeholder="To" value={cmp.to} onChange={e => setCmp(c => ({ ...c, to: e.target.value }))} />
            <input placeholder="Subject" value={cmp.subj} onChange={e => setCmp(c => ({ ...c, subj: e.target.value }))} />
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" placeholder="Write your message…" value={cmp.body} onChange={e => setCmp(c => ({ ...c, body: e.target.value }))} />
            <div className="compose-foot">
              <button className="btn primary" onClick={sendMail}>Send</button>
              <button className="btn" onClick={saveDraft}>Save draft</button>
            </div>
          </div>
        </div>
      )}

      {/* =========== CUSTOMER 360 =========== */}
      {cust && (
        <>
          <div className="c360-veil" onClick={() => setC360(null)} />
          <div className="c360-panel">
            <div className="c3-head">
              <button className="c3-close" onClick={() => setC360(null)}>✕</button>
              <div className="c3-name">{cust.name}</div>
              <div className="c3-cif">{c360}</div>
              <div className="c3-tags">
                <span className="bucket b-30">{cust.segment}</span>
                <span className={`bucket ${riskBucket}`}>Risk: {cust.risk}</span>
              </div>
            </div>
            <div className="c3-body">
              <div className="c3-sec">
                <div className="c3-sec-title">Profile</div>
                <div className="c3-grid">
                  {([["Branch", cust.branch], ["Customer since", cust.since], ["Phone", cust.phone], ["Relationship mgr", cust.rm]] as const).map(([k, v]) => (
                    <div className="c3-kv" key={k}><div className="k">{k}</div><div className="v">{v}</div></div>
                  ))}
                </div>
              </div>
              <div className="c3-sec">
                <div className="c3-sec-title">Products &amp; exposure</div>
                {cust.products.map(([n, a]) => (
                  <div className="c3-prod" key={n}><span className="p-name">{n}</span><span className="p-amt">{a}</span></div>
                ))}
              </div>
              <div className="c3-sec">
                <div className="c3-sec-title">Recent activity</div>
                {cust.events.map(([t, ev], i) => (
                  <div className="c3-ev" key={i}><span className="e-time">{t}</span><span>{ev}</span></div>
                ))}
              </div>
            </div>
            <div className="c3-foot">
              <button className="btn primary">Log PTP</button>
              <button className="btn" onClick={() => startCustomerCall(cust)}>Call</button>
              <button className="btn">Full profile →</button>
            </div>
          </div>
        </>
      )}

      {/* =========== ⌘K PALETTE =========== */}
      {paletteOpen && (
        <div className="palette-veil" onMouseDown={e => { if (e.target === e.currentTarget) setPaletteOpen(false); }}>
          <div className="palette">
            <input autoFocus placeholder="Search modules, customers, CIF numbers…" />
            <div className="palette-list">
              <div className="p-group">Modules</div>
              <div className="p-item" onClick={() => { setPaletteOpen(false); setView("collections"); }}>
                Collections — today's queue <span className="p-kbd">G C</span>
              </div>
              <div className="p-item" onClick={() => { setPaletteOpen(false); openMailView(); }}>
                Mail — inbox <span className="p-kbd">G M</span>
              </div>
              <div className="p-group">Customers</div>
              {Object.entries(CUSTOMERS).slice(0, 4).map(([cif, c]) => (
                <div key={cif} className="p-item" onClick={() => openC360(cif)}>
                  <span className="cif">{cif}</span> {c.name}
                </div>
              ))}
              <div className="p-group">Actions</div>
              <div className="p-item" onClick={() => { setPaletteOpen(false); setComposeOpen(true); }}>Compose a message</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
