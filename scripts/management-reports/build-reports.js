'use strict';
// Builds and sends the O3 management, sales and custom reports.
//
//   node build-reports.js --run-id 42        build the run the workspace recorded, send it
//                                            to the recipients captured on that run, and
//                                            write the outcome and rendered body back
//   node build-reports.js --dry [key ...]    build locally, send nothing, save previews
//   node build-reports.js --check            report catalogue sections with no implementation
//
// A report is an ordered list of sections from sections.json, built for a cadence (daily,
// weekly or monthly). The six built-in reports are lists like any other; a report made in
// the workspace is just a different list. Every section computes only what it needs, and
// only the charts its sections use are attached.
//
// Sending only happens through a recorded run. The workspace creates the run -- the 09:00
// scheduler in the backend, or "Send now" on Reports > Management Reports -- so every
// email that reaches management can be seen, with its body, on that page.
const fs = require('fs');
const path = require('path');
const L = require('./lib.js');
const M = require('./metrics.js');

const DATES = L.q1(`
  SELECT current_date::text AS today,
    (SELECT max(d)::date FROM generate_series(current_date-7, current_date-1, '1 day') d
      WHERE extract(isodow from d) BETWEEN 1 AND 5)::text AS lastwork,
    (SELECT max(d)::date - 7 FROM generate_series(current_date-7, current_date-1, '1 day') d
      WHERE extract(isodow from d) BETWEEN 1 AND 5)::text AS lastwork_prev,
    -- The last COMPLETE Monday-to-Sunday week, never the one in progress.
    -- date_trunc('week') returns today when today is a Monday, so using it directly made
    -- the Monday report cover the week ahead: on 14 Sept it read "14 to 20 Sept".
    (date_trunc('week', current_date)::date - 7)::text AS wk_start,
    (date_trunc('week', current_date)::date - 1)::text AS wk_end,
    (date_trunc('week', current_date)::date - 14)::text AS pwk_start,
    (date_trunc('week', current_date)::date - 8)::text AS pwk_end,
    date_trunc('month', current_date)::date::text AS m_start,
    (date_trunc('month', current_date)::date - interval '1 month')::date::text AS pm_start,
    (date_trunc('month', current_date)::date - 1)::text AS pm_end,
    -- The month before last, so the monthly review can show movement rather than
    -- standing figures with nothing to compare against.
    (date_trunc('month', current_date)::date - interval '2 months')::date::text AS ppm_start,
    ((date_trunc('month', current_date)::date - interval '1 month')::date - 1)::text AS ppm_end,
    to_char(date_trunc('month', current_date) - interval '1 month', 'FMMonth YYYY') AS pm_label,
    to_char(current_date, 'FMMonth YYYY') AS m_label`);

const fmtDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDay = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const weekendIdx = (s) => s.map((r, i) => (['Sat', 'Sun'].includes(r.dow) ? i : -1)).filter((i) => i >= 0);

// ── Shared sections ─────────────────────────────────────────────────────────

/** Overview in money. Every business line on one screen, before any detail. */
function overview(from, to, prevFrom, prevTo, opts = {}) {
  const sp = M.spendTotal(from, to), bk = M.booked(from, to);
  const cash = M.collections(from, to), rec = M.recovery();
  const rk = M.risk(from, to), c = M.calls(from, to), f = M.funnel(from, to);
  const mk = M.purposeOf(c, 'marketing'), sup = M.purposeOf(c, 'support'), col = M.purposeOf(c, 'collections');
  const reg = M.registrations(from, to);
  const regPrev = prevFrom ? M.registrations(prevFrom, prevTo) : null;
  const beyond = opts.beyondFeed;
  return {
    sp, bk, cash, rec, rk, c, f, mk, sup, col, reg, regPrev,
    html: [
      L.section('Overview', '', 'Every line of the business, in money, for the period.'),
      L.rows([
        { k: 'Card spend', sub: beyond ? 'no data for this period' : `${L.n0(sp.txns)} transactions, ${L.n0(sp.cards)} cards`, v: beyond ? '&mdash;' : L.auto(sp.spend), tone: beyond ? L.BRASS : L.INK },
        { k: 'Card repayments received', v: beyond ? '&mdash;' : L.auto(sp.repayments) },
        { k: 'Fixed deposits booked', sub: `${bk.fd_n} deposits`, v: L.auto(bk.fd) },
        { k: 'Loans booked', sub: `${bk.loan_n} loans`, v: L.auto(bk.loan) },
        { k: 'Collections received', sub: `${cash.approved_n} approved`, v: L.auto(cash.approved) },
        { k: 'Collections awaiting approval', sub: `${cash.pending_n} payments`, v: L.auto(cash.pending), tone: cash.pending ? L.BRASS : L.INK },
        { k: 'Recovery book outstanding', sub: `${L.n0(rec.active)} active, ${L.n0(rec.legal)} legal`, v: L.auto(rec.outstanding) },
        { k: 'Recovered to date', v: L.auto(rec.recovered) },
        { k: 'Applications decided', sub: `${rk.approved} approved, ${rk.declined} declined`, v: L.n0(rk.submitted), tone: rk.undecided ? L.BRASS : L.INK },
        { k: 'New customers', sub: regPrev ? `against ${L.n0(regPrev.customers)} last period` : '', v: L.n0(reg.customers), note: regPrev ? L.delta(reg.customers, regPrev.customers).txt : '', noteTone: regPrev ? (L.delta(reg.customers, regPrev.customers).tone === 'up' ? L.UP : L.delta(reg.customers, regPrev.customers).tone === 'down' ? L.DOWN : L.FAINT) : L.FAINT },
        { k: 'New cards opened', sub: regPrev ? `against ${L.n0(regPrev.cards)} last period` : '', v: L.n0(reg.cards), note: regPrev ? L.delta(reg.cards, regPrev.cards).txt : '', noteTone: regPrev ? (L.delta(reg.cards, regPrev.cards).tone === 'up' ? L.UP : L.delta(reg.cards, regPrev.cards).tone === 'down' ? L.DOWN : L.FAINT) : L.FAINT },
        { k: 'Customers reached', sub: `marketing ${L.n0(mk.people)}, support ${L.n0(sup.people)}, collections ${L.n0(col.people)}`, v: L.n0(mk.people + sup.people + col.people) },
        { k: 'Leads converted', sub: `${L.n0(f.qualified)} ${M.leadWord().lower} from ${L.n0(f.contacted)} contacted`, v: L.n0(f.converted), tone: f.converted ? L.UP : L.DOWN },
      ]),
    ].join(''),
  };
}

/** Contact centre, split three ways. Never a blended total. */
function callsSection(c, f, fp) {
  const mk = M.purposeOf(c, 'marketing'), sup = M.purposeOf(c, 'support'), col = M.purposeOf(c, 'collections');
  return [
    L.section('Contact centre', '', 'Three different jobs, counted separately. People reached, not dials.'),
    L.rows([
      { k: 'Marketing', sub: `${L.n0(mk.legs)} calls, ${mk.people ? (mk.legs / mk.people).toFixed(1) : '0'} per person`, v: L.n0(mk.people), note: `${L.pct(mk.completed, mk.legs)} connect` },
      { k: 'Support', sub: `${L.n0(sup.legs)} calls`, v: L.n0(sup.people), note: `${L.pct(sup.completed, sup.legs)} connect` },
      { k: 'Collections', sub: `${L.n0(col.legs)} calls`, v: L.n0(col.people), note: `${L.pct(col.completed, col.legs)} connect`, tone: col.people < 50 ? L.DOWN : L.INK },
    ]),
    L.section('Lead funnel', '', 'Movement through the stages, ending in conversions.'),
    L.rows([
      { k: 'Contacted', v: L.n0(f.contacted), note: fp ? `vs ${L.n0(fp.contacted)}` : '' },
      { k: M.leadWord().title, v: L.n0(f.qualified), note: `${L.pct(f.qualified, f.qualified + f.disqualified)} of screened` },
      { k: 'Disqualified', v: L.n0(f.disqualified) },
      { k: 'Converted', v: L.n0(f.converted), tone: f.converted ? L.UP : L.DOWN },
    ]),
  ].join('');
}

/** Cards: total spend first, then product, then channel. */
function cardsSection(from, to, beyond) {
  const sp = M.spendTotal(from, to);
  const prods = M.cardProducts(from, to);
  const ch = M.spendByChannel(from, to);
  const cov = M.cardCoverage(from, to);
  return [
    L.section('Cards', beyond ? 'FEED STALE' : '', 'Total spend, then the products behind it, then the channels.'),
    L.rows([
      { k: 'Total card spend', sub: beyond ? 'no data for this period' : `${L.n0(sp.txns)} transactions`, v: beyond ? '&mdash;' : L.auto(sp.spend), tone: beyond ? L.BRASS : L.INK },
      { k: 'Cards used', sub: 'distinct cards transacting', v: beyond ? '&mdash;' : L.n0(sp.cards) },
      { k: 'Repayments received', v: beyond ? '&mdash;' : L.auto(sp.repayments) },
      { k: 'New cards sold', sub: 'credited to a person', v: L.n0(cov.total),
        note: cov.total ? `${L.n0(cov.credited)} credited &middot; ${L.pct(cov.credited, cov.total)}` : '',
        noteTone: cov.credited ? L.FAINT : L.BRASS },
    ]),
    L.section('By product', '', 'Credit, prepaid and Blink. "Transacting" is the reliable measure of an active card.'),
    L.rows(prods.map((p) => ({
      k: p.product,
      sub: `${L.n0(p.total)} issued, ${L.n0(p.live)} live`,
      v: L.auto(p.spend),
      note: `${L.n0(p.transacting)} transacting`,
      noteTone: p.transacting ? L.FAINT : L.DOWN,
    }))),
    L.section('Spend by channel', '', 'The total above, broken down.'),
    L.rows(M.CHANNELS.map((cc) => {
      const r = ch.find((x) => x.txn_code === cc.code) || { v: 0, n: 0 };
      return { k: cc.name, sub: `${L.n0(r.n)} txns`, v: L.auto(r.v) };
    })),
  ].join('');
}

/**
 * What stands out, assembled from figures already computed — never written prose.
 * Each entry is a fact with its own number beside it, so nothing is asserted that the
 * data does not carry. Ordered by how much it should worry or please the reader, and
 * capped so the section stays a highlight rather than a second report.
 */
function standoutsSection(items) {
  const top = items.filter(Boolean).slice(0, 5);
  if (!top.length) return '';
  return [
    L.section('What stands out', '', 'The few things worth a decision this period.'),
    L.rows(top),
  ].join('');
}

/** credit_card -> "Credit card". The product slugs are stored snake_cased. */
const productLabel = (p) => String(p || '')
  .replace(/_/g, ' ')
  .replace(/^\w/, (c) => c.toUpperCase());

/** Plain-text money for SVG labels, which cannot carry the HTML naira span. */
function plainMoney(v) {
  const a = Math.abs(Number(v) || 0);
  if (a === 0) return 'Nil';
  if (a >= 1e9) return '₦' + (v / 1e9).toFixed(2) + 'bn';
  if (a >= 1e6) return '₦' + (v / 1e6).toFixed(1) + 'm';
  return '₦' + Math.round(v).toLocaleString('en-NG');
}

/** The last day of the month a YYYY-MM-DD date falls in. */
function monthEndOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

const plural = (n, one, many = `${one}s`) => `${L.n0(n)} ${n === 1 ? one : many}`;

/**
 * The sales team rep by rep. Each person gets three lines of their own — fixed deposits,
 * loans and credit cards — each against that person's own target, so no figure hides in
 * another's sub-line. People with no target who brought business in follow on the same
 * three lines. Credit cards only: prepaid and Blink sales are not a sales target.
 */
function repsSection(c) {
  const people = M.peopleScorecard(c.period, c.salesStart, c.salesEnd);
  const cov = M.cardCoverage(c.salesStart, c.salesEnd);
  const against = (v, t, fmt) => (t ? `of ${fmt(t)} · ${L.pct(v, t)}` : 'no target set');
  const toneOf = (v, t) => (!t ? L.FAINT : v >= t ? L.UP : v === 0 ? L.DOWN : L.FAINT);
  const block = (p) => L.group(p.person, L.roleLabel(p.role), [
    { k: 'Fixed deposits', v: L.auto(p.fd_v), note: against(p.fd_v, p.fd_t, L.auto), noteTone: toneOf(p.fd_v, p.fd_t) },
    { k: 'Loans', v: L.auto(p.loan_v), note: against(p.loan_v, p.loan_t, L.auto), noteTone: toneOf(p.loan_v, p.loan_t) },
    { k: 'Credit cards', v: L.n0(p.credit_cards), note: against(p.credit_cards, p.card_t, L.n0), noteTone: toneOf(p.credit_cards, p.card_t) },
  ]);
  const withT = people.filter((p) => p.has_target);
  const without = people.filter((p) => !p.has_target && (p.fd_v > 0 || p.loan_v > 0 || p.credit_cards > 0));
  return [
    L.section('Sales team, rep by rep', c.salesLabel.toUpperCase(),
      `Fixed deposits, loans and credit cards for each person, against their own targets. Cards credited to a person: ${L.n0(cov.credited)} of ${L.n0(cov.total)}.`),
    withT.length ? withT.map(block).join('') : L.rows([{ k: 'No targets set for this period', v: '&mdash;' }]),
    without.length
      ? [L.section('Business brought in by others', '', 'People with no sales target who booked business in the period.'), without.map(block).join('')].join('')
      : '',
  ].join('');
}

/**
 * Collections: what was expected against what came in, one source at a time. The three
 * overlap — a loan in the collections book also has a core-banking instalment — so they
 * sit side by side and are never added into one total.
 */
function collectionsExpectedSection(c) {
  const monthEnd = c.kind === 'monthly' ? c.salesEnd : monthEndOf(c.salesStart);
  const monthWord = c.kind === 'monthly' ? DATES.pm_label : DATES.m_label;
  const soFar = c.kind === 'monthly' ? 'in the month' : 'so far this month';
  const li = M.loanInstalments(c.salesStart, monthEnd);
  const book = M.collectionsBook(c.salesStart, c.salesEnd);
  const blank = { accounts: 0, with_repayment: 0, expected: 0, outstanding: 0, received: 0, received_n: 0, pending: 0, pending_n: 0 };
  const loans = book.find((r) => r.product_type === 'loan') || blank;
  const cards = book.find((r) => r.product_type === 'card') || blank;
  const pending = loans.pending + cards.pending;
  const pendingN = loans.pending_n + cards.pending_n;
  const st = M.cardStatement();

  return [
    L.section('Collections: expected against received', monthWord.toUpperCase(),
      'Three sources, side by side. They overlap, so they are never added together.'),

    L.group('Loan instalments', `core banking &nbsp;&middot;&nbsp; ${plural(li.loans, 'loan')}`, li.due_n ? [
      { k: 'Due this month', sub: plural(li.due_n, 'instalment'), v: L.auto(li.due_v) },
      { k: 'Paid in full', sub: plural(li.paid_n, 'instalment'), v: L.auto(li.paid_v), tone: li.paid_n ? L.UP : L.INK },
      { k: 'Part paid', sub: `${plural(li.part_n, 'instalment')}, at the full amount due`, v: L.auto(li.part_v), tone: li.part_n ? L.BRASS : L.INK },
      { k: 'Due and unpaid', sub: plural(li.unpaid_n, 'instalment'), v: L.auto(li.unpaid_v), tone: li.unpaid_n ? L.DOWN : L.INK },
      ...(li.upcoming_n ? [{ k: 'Still to fall due', sub: `${plural(li.upcoming_n, 'instalment')} by ${shortDay(monthEnd)}`, v: L.auto(li.upcoming_v) }] : []),
    ] : [{ k: 'No instalments fall due this month', v: '&mdash;' }]),

    L.group('Collections book', `${plural(loans.accounts + cards.accounts, 'account')} under management`, [
      { k: 'Loan repayments due', sub: `${L.n0(loans.with_repayment)} of ${plural(loans.accounts, 'loan account')} have a repayment set`, v: L.auto(loans.expected) },
      { k: `Received on loan accounts ${soFar}`, sub: plural(loans.received_n, 'approved payment'), v: L.auto(loans.received),
        note: loans.expected ? `${L.pct(loans.received, loans.expected)} of due` : '',
        noteTone: loans.expected && loans.received >= loans.expected ? L.UP : L.FAINT },
      { k: `Received on card accounts ${soFar}`, sub: `${plural(cards.accounts, 'account')}, ${L.auto(cards.outstanding)} outstanding, no repayment amount recorded`, v: L.auto(cards.received) },
      ...(pendingN ? [{ k: 'Awaiting approval', sub: plural(pendingN, 'payment'), v: L.auto(pending), tone: L.BRASS }] : []),
    ]),

    st.cycle_date
      ? L.group('Credit-card statement',
        `cycle of ${shortDay(st.cycle_date)}${st.age_days > 35 ? ` &nbsp;&middot;&nbsp; ${st.age_days} days old, no newer cycle on file` : ''}`, [
          { k: 'Minimum payments due', sub: plural(st.due_n, 'account'), v: L.auto(st.min_due) },
          { k: 'Overdue on the statement', sub: plural(st.overdue_n, 'account'), v: L.auto(st.overdue), tone: st.overdue ? L.DOWN : L.INK },
        ])
      : L.group('Credit-card statement', '', [{ k: 'No statement cycle on file', v: '&mdash;' }]),
  ].join('');
}

/**
 * Recovery: the case book by status, and value recovered to date, with a donut so the
 * active/legal split reads in one glance. Split out of the two lines the business
 * overview carries, so Collections & Recovery can stand alone without the whole
 * overview section beside it.
 */
function recoverySection(c) {
  const rec = M.recovery();
  const total = rec.active + rec.legal;
  const svg = total ? L.doughnutSVG(
    [{ label: 'Active', v: rec.active, c: L.BRASS }, { label: 'Legal', v: rec.legal, c: L.SLICE_COLOURS[2] }],
    L.n0(total), 'cases',
  ) : null;
  if (svg) c.charts['c-recovery'] = svg;
  return [
    L.section('Recovery', '', 'The case book by status, and value recovered to date.'),
    L.rows([
      { k: 'Active cases', v: L.n0(rec.active) },
      { k: 'Legal cases', v: L.n0(rec.legal) },
      { k: 'Outstanding, active + legal', v: L.auto(rec.outstanding) },
      { k: 'Recovered to date', v: L.auto(rec.recovered), tone: rec.recovered ? L.UP : L.INK },
    ]),
    svg ? L.chartRow('c-recovery', 'Recovery cases, active vs legal.') : '',
  ].join('');
}

/**
 * Qualified leads: where they are waiting. By stage (the four stages after qualified,
 * added 14 Sept 2026), by how long, by who holds them, and what is missing from them —
 * the gaps that stop a qualified lead moving on.
 */
function qualifiedLeadsSection() {
  const leads = M.qualifiedWaiting();
  const word = M.leadWord();
  const title = `${word.title} leads: where they are waiting`;
  if (!leads.length) return [L.section(title, '', ''), L.rows([{ k: 'No qualified leads are waiting', v: '&mdash;' }])].join('');

  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  const days = (n) => plural(n, 'day');
  const buckets = [
    { k: 'Under a week', test: (d) => d < 7 },
    { k: '1 to 2 weeks', test: (d) => d >= 7 && d < 14 },
    { k: '2 weeks to a month', test: (d) => d >= 14 && d < 30 },
    { k: 'Over a month', test: (d) => d >= 30, warn: true },
  ];
  const owners = Object.entries(leads.reduce((acc, r) => ((acc[r.owner] = acc[r.owner] || []).push(r.days), acc), {}))
    .sort((a, b) => b[1].length - a[1].length);
  const top = owners.slice(0, 6), rest = owners.slice(6);
  const followUps = leads.filter((r) => r.has_follow_up).length;
  const products = leads.filter((r) => r.has_product).length;

  return [
    L.section(title, `${L.n0(leads.length)} OPEN`, `Every ${word.lower} lead not yet converted or disqualified.`),
    L.group('By stage', 'days counted from when the lead entered it', M.OPEN_AFTER_QUALIFIED.map((s) => {
      const d = leads.filter((r) => r.stage === s).map((r) => r.days);
      return {
        k: s === 'qualified' ? `${word.title}, not yet handed to sales` : M.LEAD_STAGE_LABELS[s],
        sub: d.length ? `median ${days(median(d))}, longest ${days(Math.max(...d))}` : 'none',
        v: L.n0(d.length), tone: d.length ? L.INK : L.FAINT,
      };
    })),
    L.group('By days waiting', '', buckets.map((b) => {
      const n = leads.filter((r) => b.test(r.days)).length;
      return { k: b.k, v: L.n0(n), note: L.pct(n, leads.length), tone: b.warn && n ? L.DOWN : L.INK };
    })),
    L.group('By who holds them', '', [
      ...top.map(([name, d]) => ({ k: L.esc(name), sub: `median ${days(median(d))} waiting`, v: L.n0(d.length) })),
      ...(rest.length ? [{ k: 'Everyone else', sub: plural(rest.length, 'person', 'people'), v: L.n0(rest.reduce((a, [, d]) => a + d.length, 0)) }] : []),
    ]),
    L.group('What is missing', 'recorded on the lead', [
      { k: 'Follow-up booked', v: L.n0(followUps), note: `of ${L.n0(leads.length)}`, tone: followUps ? L.INK : L.DOWN },
      { k: 'Product interest recorded', v: L.n0(products), note: `of ${L.n0(leads.length)}`, tone: products ? L.INK : L.DOWN },
    ]),
  ].join('');
}

function demographicsSection(from, to) {
  const geo = M.geography(), age = M.ageBands();
  const spLoc = M.spendByLocation(from, to), spAge = M.spendByAge(from, to);
  const spPA = M.spendByProductAge(from, to);
  return [
    L.section('Customers by location', '', 'Where the customer base sits.'),
    L.rows(geo.map((g) => ({ k: g.s, v: L.n0(g.n), note: 'customers' }))),
    L.section('Cardholders by age group', '', 'Age profile of the issued card base.'),
    L.rows(age.map((a) => ({ k: a.band, v: L.n0(a.cards), note: 'cards', tone: a.band === 'Not recorded' ? L.FAINT : L.INK }))),
    L.section('Spend by location', '', 'Where the money is actually being spent.'),
    L.rows(spLoc.map((r) => ({ k: r.label, sub: `${L.n0(r.cards)} cards`, v: L.auto(r.spend), tone: r.label === 'Not recorded' ? L.FAINT : L.INK }))),
    L.section('Spend by age group', '', 'Date of birth is held for a minority of cardholders, so the unrecorded share is shown rather than hidden.'),
    L.rows(spAge.map((r) => ({ k: r.label, sub: `${L.n0(r.cards)} cards`, v: L.auto(r.spend), tone: r.label === 'Not recorded' ? L.FAINT : L.INK }))),
    L.section('Spend by product and age group', '', ''),
    L.rows(spPA.map((r) => ({ k: r.product, sub: r.label, v: L.auto(r.spend), tone: r.label === 'Not recorded' ? L.FAINT : L.INK }))),
  ].join('');
}

function positionSection() {
  const mat = M.maturities(), lmat = M.loanMaturities(), bl = M.backlog();
  return [
    L.section('Deposits', '', 'Book, and what is coming due.'),
    L.rows([
      { k: 'Active book', sub: `${L.n0(mat.book_n)} deposits`, v: L.auto(mat.book) },
      { k: 'Past maturity, still open', sub: `${mat.od_n} deposits`, v: L.auto(mat.od_v), tone: mat.od_n ? L.DOWN : L.INK },
      { k: 'Maturing next 7 days', sub: `${mat.w_n} deposits`, v: L.auto(mat.w_v), tone: L.BRASS },
      { k: 'Maturing 8 to 30 days', sub: `${mat.m_n} deposits`, v: L.auto(mat.m_v) },
    ]),
    L.section('Lending', '', 'Book, and overdue exposure.'),
    L.rows([
      { k: 'Outstanding', v: L.auto(lmat.book) },
      { k: 'Past maturity', sub: `${lmat.od_n} loans`, v: L.auto(lmat.od_v), tone: lmat.od_n ? L.DOWN : L.INK },
      { k: 'Maturing next 30 days', sub: `${lmat.m_n} loans`, v: L.auto(lmat.m_v) },
    ]),
    L.section('Support', '', ''),
    L.rows([
      { k: 'Open backlog', sub: `${L.n0(bl.breached)} breaching SLA, ${L.n0(bl.old7)} over a week`, v: L.n0(bl.open), tone: L.DOWN },
    ]),
  ].join('');
}

// ── Catalogue ───────────────────────────────────────────────────────────────

// sections.json is the one list of sections, read by this generator and by the backend
// that serves the report editor, so the two cannot offer different things.
const CATALOGUE = JSON.parse(fs.readFileSync(path.join(__dirname, 'sections.json'), 'utf8'));
const CATALOGUE_BY_ID = Object.fromEntries(CATALOGUE.sections.map((s) => [s.id, s]));

// ── Report context ──────────────────────────────────────────────────────────

/**
 * The period a cadence covers, and every figure a section might need, each computed at
 * most once and only if some section asks for it. A report with three sections does not
 * pay for the other twenty.
 */
function makeContext(cadence) {
  if (!['daily', 'weekly', 'monthly'].includes(cadence)) throw new Error(`unknown cadence "${cadence}"`);
  const kind = cadence;
  const memo = new Map();
  const lazy = (key, fn) => () => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };
  const c = { kind, charts: {} };

  if (kind === 'daily') {
    c.from = c.to = DATES.lastwork; c.prevFrom = c.prevTo = DATES.lastwork_prev;
  } else if (kind === 'weekly') {
    c.from = DATES.wk_start; c.to = DATES.wk_end; c.prevFrom = DATES.pwk_start; c.prevTo = DATES.pwk_end;
  } else {
    c.from = DATES.pm_start; c.to = DATES.pm_end; c.prevFrom = DATES.ppm_start; c.prevTo = DATES.ppm_end;
  }

  // The sales position follows the report's OWN month. Hardcoding the current month
  // meant the August review would have shown September's attainment beside August's
  // business — two different months under one heading.
  c.salesStart = kind === 'monthly' ? DATES.pm_start : DATES.m_start;
  c.salesEnd = kind === 'monthly' ? DATES.pm_end : DATES.today;
  c.salesLabel = kind === 'monthly' ? DATES.pm_label : `${DATES.m_label} to date`;
  c.period = c.salesStart.slice(0, 7);

  c.feed = lazy('feed', () => M.feedState());
  c.beyond = lazy('beyond', () => c.from > c.feed().thru);
  c.o = lazy('o', () => overview(c.from, c.to, c.prevFrom, c.prevTo, { beyondFeed: c.beyond() }));
  c.fp = lazy('fp', () => (c.prevFrom ? M.funnel(c.prevFrom, c.prevTo) : null));
  c.cPrev = lazy('cPrev', () => (c.prevFrom ? M.calls(c.prevFrom, c.prevTo) : null));
  // A monthly review charts its own month, not a rolling 30 days ending today.
  c.series = lazy('series', () => (kind === 'monthly' ? M.seriesBetween(c.from, c.to) : M.series(14)));

  c.mtd = lazy('mtd', () => M.booked(c.salesStart, c.salesEnd));
  c.inPeriod = lazy('inPeriod', () => M.booked(c.from, c.to));
  c.tgt = lazy('tgt', () => M.targets(c.period));
  c.sb = lazy('sb', () => M.scoreboard(c.period, c.salesStart, c.salesEnd));
  c.fdAtt = lazy('fdAtt', () => c.sb().reduce((a, r) => a + r.fd_v, 0));
  c.loanAtt = lazy('loanAtt', () => c.sb().reduce((a, r) => a + r.loan_v, 0));
  c.fdGap = lazy('fdGap', () => Math.max(0, c.tgt().fd - c.fdAtt()));
  c.loanGap = lazy('loanGap', () => Math.max(0, c.tgt().loan - c.loanAtt()));
  c.teams = lazy('teams', () => M.teams(c.period, c.salesStart, c.salesEnd));
  c.contrib = lazy('contrib', () => M.contributors(c.salesStart, c.salesEnd));
  c.days = lazy('days', () => (kind === 'monthly' ? 0 : M.workDaysLeft()));
  return c;
}

// ── Sections ────────────────────────────────────────────────────────────────

/** Each takes the report context and returns email HTML; a chart section registers its chart. */
const SECTIONS = {
  headline: (c) => {
    const o = c.o(), feed = c.feed(), beyond = c.beyond(), cPrev = c.cPrev();
    // Compare like with like: the headline counts every purpose, so its movement must be
    // measured against every purpose too. It previously showed the all-purpose total with
    // a marketing-only percentage beside it.
    const reached = o.mk.people + o.sup.people + o.col.people;
    const reachedPrev = cPrev
      ? M.purposeOf(cPrev, 'marketing').people + M.purposeOf(cPrev, 'support').people + M.purposeOf(cPrev, 'collections').people
      : 0;
    return L.kpiRow([
      { label: 'CUSTOMERS REACHED', value: L.n0(reached), delta: reachedPrev ? L.delta(reached, reachedPrev).txt : 'all purposes', tone: reachedPrev ? L.delta(reached, reachedPrev).tone : 'flat' },
      // Neutral tone: the sub-line is a count of qualified leads, not a movement, and a
      // red down-arrow beside it read as "qualified fell".
      { label: 'CONVERSIONS', value: L.n0(o.f.converted), delta: `from ${L.n0(o.f.qualified)} ${M.leadWord().lower}`, tone: 'flat' },
      beyond
        ? { label: 'CARD SPEND', value: 'No data', tone: 'flat', delta: `feed stale ${feed.age} days` }
        : { label: 'CARD SPEND', value: L.auto(o.sp.spend), tone: 'flat', delta: `${L.n0(o.sp.txns)} txns` },
      { label: 'FD + LOANS BOOKED', value: L.auto(o.bk.fd + o.bk.loan), tone: 'flat', delta: `${o.bk.fd_n + o.bk.loan_n} deals` },
    ]);
  },

  standouts: (c) => {
    // Standouts, drawn only from figures already computed elsewhere in the report.
    const o = c.o(), mtd = c.mtd(), fdAtt = c.fdAtt();
    const mat = M.maturities(), lmat = M.loanMaturities(), bl = M.backlog();
    const prods = M.cardProducts(c.from, c.to);
    const liveCards = prods.reduce((a, p) => a + p.live, 0);
    const txnCards = prods.reduce((a, p) => a + p.transacting, 0);
    const outside = Math.max(0, mtd.fd - fdAtt);
    const repeats = o.rk.submitted - o.rk.applicants;
    return standoutsSection([
      mat.od_n ? { k: 'Fixed deposits past maturity and still open', sub: `${mat.od_n} deposits`, v: L.auto(mat.od_v), tone: L.DOWN } : null,
      lmat.od_n ? { k: 'Loans past maturity', sub: `${lmat.od_n} loans`, v: L.auto(lmat.od_v), tone: L.DOWN } : null,
      mat.w_v > o.bk.fd ? { k: 'Maturing in the next 7 days, against new deposits booked', sub: `${mat.w_n} deposits against ${L.auto(o.bk.fd)} booked`, v: L.auto(mat.w_v), tone: L.BRASS } : null,
      o.cash.pending_n ? { k: 'Collections cash awaiting approval', sub: `${o.cash.pending_n} payments`, v: L.auto(o.cash.pending), tone: L.BRASS } : null,
      outside > 0 ? { k: 'Deposits booked by people with no sales target', sub: `of ${L.auto(mtd.fd)} booked in ${c.salesLabel}`, v: L.auto(outside), tone: L.BRASS } : null,
      liveCards && txnCards / liveCards < 0.5 ? { k: 'Live cards not used in the period', sub: `${L.n0(txnCards)} of ${L.n0(liveCards)} live cards transacted`, v: L.n0(liveCards - txnCards), tone: L.DOWN } : null,
      o.col.people < 50 ? { k: 'People reached by collections', sub: `against ${L.auto(o.rec.outstanding)} outstanding`, v: L.n0(o.col.people), tone: L.DOWN } : null,
      !o.f.converted ? { k: 'Lead conversions recorded', sub: `from ${L.n0(o.f.qualified)} ${M.leadWord().lower}`, v: 'None', tone: L.DOWN } : null,
      repeats > 0 ? { k: 'Repeat applications from the same applicant', sub: `${L.n0(o.rk.submitted)} applications from ${L.n0(o.rk.applicants)} people`, v: L.n0(repeats), tone: L.BRASS } : null,
      bl.open > 1000 ? { k: 'Support tickets open', sub: `${L.n0(bl.breached)} breaching SLA`, v: L.n0(bl.open), tone: L.DOWN } : null,
    ]);
  },

  overview: (c) => c.o().html,

  sales_summary: (c) => {
    const mtd = c.mtd(), tgt = c.tgt(), fdAtt = c.fdAtt();
    return [
      L.section('Sales', c.salesLabel.toUpperCase(), 'Against target. Company total, then the sales team within it.'),
      L.rows([
        { k: 'Fixed deposits — company', sub: 'everything booked', v: L.auto(mtd.fd), note: `of ${L.auto(tgt.fd)} · ${L.pct(mtd.fd, tgt.fd)}`, tone: mtd.fd >= tgt.fd ? L.UP : L.DOWN },
        { k: 'of which, sales team', sub: `${tgt.officers} officers carry a target`, v: L.auto(fdAtt), note: `${L.pct(fdAtt, tgt.fd)} of target` },
        { k: 'booked outside sales', sub: 'no target held', v: L.auto(Math.max(0, mtd.fd - fdAtt)), noteTone: L.BRASS },
        { k: 'Loans — company', v: L.auto(mtd.loan), note: `of ${L.auto(tgt.loan)} · ${L.pct(mtd.loan, tgt.loan)}`, tone: mtd.loan >= tgt.loan ? L.UP : L.DOWN },
      ]),
    ].join('');
  },

  sales_people: (c) => repsSection(c),

  // A leaderboard, ranked by FD attainment — the table above has everyone's numbers;
  // this is where a reader sees who is ahead without reading all of them.
  chart_sales_leaderboard: (c) => {
    const items = c.sb()
      .filter((r) => r.fd_t > 0)
      .map((r) => ({ label: r.officer, frac: r.fd_v / r.fd_t, display: `${L.pct(r.fd_v, r.fd_t)} · ${plainMoney(r.fd_v)}` }))
      .sort((a, b) => b.frac - a.frac);
    const svg = L.rankBarsSVG(items);
    if (!svg) return '';
    c.charts['c-leaderboard'] = svg;
    return L.chartRow('c-leaderboard', 'Fixed deposits booked against target, by officer.');
  },

  collections_expected: (c) => collectionsExpectedSection(c),

  recovery: (c) => recoverySection(c),

  chart_pitched: (c) => {
    const s = c.series();
    c.charts['c-pitched'] = L.areaSVG({ values: s.map((r) => r.pitched), dates: s.map((r) => shortDay(r.day)), weekend: weekendIdx(s) });
    return L.chartRow('c-pitched', 'Customers pitched per day.');
  },

  contact_centre: (c) => {
    const o = c.o();
    return callsSection(o.c, o.f, c.fp());
  },

  qualified_leads: () => qualifiedLeadsSection(),

  // By stage, as a donut: the table right above already breaks it down by days and by
  // owner, so this reads as the shape of the queue rather than repeating its numbers.
  chart_lead_stages: (c) => {
    const leads = M.qualifiedWaiting();
    if (!leads.length) return '';
    const segs = M.OPEN_AFTER_QUALIFIED.map((s, i) => ({
      label: s === 'qualified' ? `${M.leadWord().title}, not handed to sales` : M.LEAD_STAGE_LABELS[s],
      v: leads.filter((r) => r.stage === s).length,
      c: L.SLICE_COLOURS[i % L.SLICE_COLOURS.length],
    }));
    const svg = L.doughnutSVG(segs, L.n0(leads.length), 'waiting');
    if (!svg) return '';
    c.charts['c-leadstage'] = svg;
    return L.chartRow('c-leadstage', `${M.leadWord().title} leads waiting, by stage.`);
  },

  cards: (c) => cardsSection(c.from, c.to, c.beyond()),

  // Channel mix as a doughnut: the split is the point, and a ring shows share far faster
  // than five rows of money do.
  chart_channel_mix: (c) => {
    const ch = M.spendByChannel(c.from, c.to);
    const segs = M.CHANNELS.map((cc, i) => {
      const r = ch.find((x) => x.txn_code === cc.code) || { v: 0 };
      return { label: cc.name, v: r.v, c: L.SLICE_COLOURS[i], display: plainMoney(r.v) };
    });
    const total = segs.reduce((a, x) => a + (Number(x.v) || 0), 0);
    if (!total) return '';
    c.charts['c-mix'] = L.doughnutSVG(segs, plainMoney(total), 'card spend');
    return L.chartRow('c-mix', 'Card spend split by channel.');
  },

  chart_card_spend: (c) => {
    const s = c.series(), feed = c.feed();
    const deadIdx = s.findIndex((r) => r.day > feed.thru);
    c.charts['c-spend'] = L.areaSVG({
      values: s.map((r) => r.spend), dates: s.map((r) => shortDay(r.day)), weekend: weekendIdx(s),
      deadFrom: deadIdx > 0 ? deadIdx : null, deadLabel: `no feed since ${shortDay(feed.thru)}`,
    });
    return L.chartRow('c-spend', 'Card spend per day.');
  },

  position: () => positionSection(),

  chart_fd_book: (c) => {
    const fds = M.fdSeries();
    if (fds.length <= 2) return '';
    c.charts['c-fd'] = L.areaSVG({ values: fds.map((r) => r.v), dates: fds.map((r) => shortDay(r.day)), zoom: true, accent: L.BRASS });
    return L.chartRow('c-fd', 'Fixed-deposit book, daily.');
  },

  applications: (c) => {
    const o = c.o();
    return [
      L.section('Applications &amp; risk', '', 'Origination flow, the products applied for, and why applications fail.'),
      L.rows([
        { k: 'Applications received', v: L.n0(o.rk.submitted) },
        { k: 'Unique applicants', sub: o.rk.submitted > o.rk.applicants ? `${L.n0(o.rk.submitted - o.rk.applicants)} repeat application${o.rk.submitted - o.rk.applicants > 1 ? 's' : ''}` : 'no repeats', v: L.n0(o.rk.applicants) },
        { k: 'Approved / declined', v: `${L.n0(o.rk.approved)} / ${L.n0(o.rk.declined)}` },
        { k: 'Undecided', v: L.n0(o.rk.undecided), tone: o.rk.undecided ? L.BRASS : L.INK },
        // The reason is a sentence, so it sits in the label column, where text wraps. In the
        // value column (nowrap, so figures never split) it forced that column to 234px and,
        // because the email is one table, widened the whole sheet past a 320px phone.
        (() => {
          const td = M.topDecline();
          return td.reason
            ? { k: 'Top decline reason', sub: `${L.esc(td.reason.replace('Auto-declined: ', ''))} &nbsp;&middot;&nbsp; all applications to date`, v: L.n0(td.n), note: td.n === 1 ? 'application' : 'applications' }
            : { k: 'Top decline reason', sub: 'no declines recorded', v: '&mdash;' };
        })(),
      ]),
    ].join('');
  },

  applied_products: (c) => {
    const bp = M.riskByProduct(c.from, c.to);
    return [
      L.section('Applied-for products', '', 'What people are asking for.'),
      L.rows(bp.length ? bp.map((p) => ({
        k: productLabel(p.product),
        sub: `${L.n0(p.applicants)} applicant${p.applicants === 1 ? '' : 's'} &nbsp;&middot;&nbsp; ${L.n0(p.approved)} approved, ${L.n0(p.declined)} declined`,
        v: L.n0(p.n),
        note: p.requested ? L.auto(p.requested) : '',
      })) : [{ k: 'No applications in this period', v: '&mdash;' }]),
    ].join('');
  },

  // Approved / declined / undecided as a donut, beside the two decision tables above.
  chart_risk_decisions: (c) => {
    const rk = c.o().rk;
    const total = rk.approved + rk.declined + rk.undecided;
    if (!total) return '';
    const svg = L.doughnutSVG([
      { label: 'Approved', v: rk.approved, c: L.SLICE_COLOURS[0] },
      { label: 'Declined', v: rk.declined, c: L.SLICE_COLOURS[2] },
      { label: 'Undecided', v: rk.undecided, c: L.SLICE_COLOURS[1] },
    ], L.n0(total), 'applications');
    if (!svg) return '';
    c.charts['c-risk'] = svg;
    return L.chartRow('c-risk', 'Applications by decision.');
  },

  demographics: (c) => demographicsSection(c.from, c.to),

  // Two donuts for the two distributions a table shows less quickly than a ring does:
  // where the customer base sits, and its age profile.
  chart_customers_location: (c) => {
    const geo = M.geography();
    const total = geo.reduce((a, g) => a + Number(g.n), 0);
    if (!total) return '';
    const segs = geo.map((g, i) => ({ label: g.s, v: g.n, c: L.SLICE_COLOURS[i % L.SLICE_COLOURS.length] }));
    const svg = L.doughnutSVG(segs, L.n0(total), 'customers');
    if (!svg) return '';
    c.charts['c-geo'] = svg;
    return L.chartRow('c-geo', 'Customers by location.');
  },

  chart_customers_age: (c) => {
    const age = M.ageBands();
    const total = age.reduce((a, x) => a + Number(x.cards), 0);
    if (!total) return '';
    const segs = age.map((a, i) => ({ label: a.band, v: a.cards, c: L.SLICE_COLOURS[i % L.SLICE_COLOURS.length] }));
    const svg = L.doughnutSVG(segs, L.n0(total), 'cards');
    if (!svg) return '';
    c.charts['c-age'] = svg;
    return L.chartRow('c-age', 'Cardholders by age group.');
  },

  registrations: (c) => {
    const r = M.registrations(c.from, c.to);
    return [
      L.section('Registrations', '', 'New customers and cards opened.'),
      L.rows([{ k: 'New customers', v: L.n0(r.customers) }, { k: 'Cards opened', v: L.n0(r.cards) }]),
    ].join('');
  },

  // ── Sales performance ──

  sales_headline: (c) => {
    const tgt = c.tgt(), fdAtt = c.fdAtt(), loanAtt = c.loanAtt(), fdGap = c.fdGap(), days = c.days();
    // Money in the overview, not just percentages.
    return L.kpiRow([
      { label: 'FD BOOKED', value: L.auto(fdAtt), delta: `of ${L.auto(tgt.fd)} · ${L.pct(fdAtt, tgt.fd)}`, tone: fdAtt >= tgt.fd ? 'up' : 'down' },
      { label: 'LOANS BOOKED', value: L.auto(loanAtt), delta: `of ${L.auto(tgt.loan)} · ${L.pct(loanAtt, tgt.loan)}`, tone: loanAtt >= tgt.loan ? 'up' : 'down' },
      { label: 'FD STILL TO FIND', value: L.auto(fdGap), delta: days ? `${days} working days left` : 'month closed', tone: fdGap ? 'down' : 'up' },
      { label: 'DAILY RUN-RATE', value: days ? L.auto(fdGap / days) : '&mdash;', delta: days ? 'FD per working day' : 'month closed', tone: 'flat' },
    ]);
  },

  sales_booked: (c) => {
    const inPeriod = c.inPeriod();
    return [
      L.section(c.kind === 'daily' ? 'Booked that day' : c.kind === 'weekly' ? 'Booked last week' : 'Booked in the month', '', 'New business written in the period.'),
      L.rows([
        { k: 'Fixed deposits', sub: `${inPeriod.fd_n} deposits`, v: L.auto(inPeriod.fd) },
        { k: 'Loans', sub: `${inPeriod.loan_n} loans`, v: L.auto(inPeriod.loan) },
        { k: 'Total new business', v: L.auto(inPeriod.fd + inPeriod.loan), tone: (inPeriod.fd + inPeriod.loan) ? L.UP : L.DOWN },
      ]),
    ].join('');
  },

  sales_fd_by_officer: (c) => [
    L.section('Fixed deposits by officer', c.kind === 'monthly' ? DATES.pm_label.toUpperCase() : DATES.m_label.toUpperCase(), 'Booked against target. Everyone sees everyone.'),
    L.rows(c.sb().map((r) => ({
      k: r.officer, sub: r.role === 'sales_head' ? 'head' : '',
      v: L.auto(r.fd_v),
      note: `of ${L.auto(r.fd_t)} · ${L.pct(r.fd_v, r.fd_t)}`,
      noteTone: r.fd_v >= r.fd_t ? L.UP : r.fd_v === 0 ? L.DOWN : L.FAINT,
    }))),
  ].join(''),

  sales_loans_by_officer: (c) => [
    L.section('Loans by officer', '', 'Booked against target.'),
    L.rows(c.sb().map((r) => ({
      k: r.officer, v: L.auto(r.loan_v),
      note: `of ${L.auto(r.loan_t)} · ${L.pct(r.loan_v, r.loan_t)}`,
      noteTone: r.loan_v >= r.loan_t ? L.UP : r.loan_v === 0 ? L.DOWN : L.FAINT,
    }))),
  ].join(''),

  sales_cards_by_officer: (c) => {
    const rows = M.creditCardsByOfficer(c.period, c.salesStart, c.salesEnd);
    return [
      L.section('Credit cards by officer', '', 'Credit cards each officer brought in, against their card target.'),
      L.rows(rows.length ? rows.map((r) => ({
        k: r.officer, v: L.n0(r.credit_cards),
        note: r.card_t ? `of ${L.n0(r.card_t)} · ${L.pct(r.credit_cards, r.card_t)}` : 'no target set',
        noteTone: r.card_t && r.credit_cards >= r.card_t ? L.UP : L.FAINT,
      })) : [{ k: 'No targets set for this period', v: '&mdash;' }]),
    ].join('');
  },

  sales_teams: (c) => {
    const tm = c.teams();
    return [
      L.section('Teams', '', 'Team totals against the targets of their assigned members.'),
      L.rows(tm.length ? tm.map((t) => ({
        k: t.team, sub: `${t.members} assigned`,
        v: L.auto(t.fd_v), note: t.fd_t ? `of ${L.auto(t.fd_t)} · ${L.pct(t.fd_v, t.fd_t)}` : 'no target set',
        noteTone: t.fd_t && t.fd_v >= t.fd_t ? L.UP : L.FAINT,
      })) : [{ k: 'No teams configured', v: '&mdash;' }]),
    ].join('');
  },

  sales_company: (c) => {
    const tgt = c.tgt(), mtd = c.mtd(), fdAtt = c.fdAtt(), loanAtt = c.loanAtt();
    const fdGap = c.fdGap(), loanGap = c.loanGap(), days = c.days();
    return [
      L.section('Company', '', 'Where the month stands.'),
      L.rows([
        { k: 'FD booked, sales team', v: L.auto(fdAtt), note: `of ${L.auto(tgt.fd)}`, tone: fdAtt >= tgt.fd ? L.UP : L.DOWN },
        { k: 'FD booked, all sources', sub: 'including business outside sales', v: L.auto(mtd.fd), note: `${L.pct(mtd.fd, tgt.fd)} of target` },
        { k: 'Loans booked, sales team', v: L.auto(loanAtt), note: `of ${L.auto(tgt.loan)}`, tone: loanAtt >= tgt.loan ? L.UP : L.DOWN },
        { k: 'FD gap', v: L.auto(fdGap), note: days ? `${L.auto(fdGap / days)} per working day` : '', noteTone: L.BRASS, tone: fdGap ? L.DOWN : L.UP },
        { k: 'Loan gap', v: L.auto(loanGap), note: days ? `${L.auto(loanGap / days)} per working day` : '', noteTone: L.BRASS, tone: loanGap ? L.DOWN : L.UP },
      ]),
    ].join('');
  },

  sales_outside: (c) => {
    const contrib = c.contrib();
    return [
      L.section('Business from outside sales', '', 'Booked by people who carry no target. Counted for the company, not for attainment.'),
      L.rows(contrib.length ? contrib.map((r) => ({ k: r.person, sub: r.role.replace(/_/g, ' '), v: L.auto(r.v), note: `${r.n} deposits${r.cards ? ` &middot; ${r.cards} cards` : ''}` }))
        : [{ k: 'None in this period', v: '&mdash;' }]),
    ].join('');
  },
};

// ── Frames: title, dateline, subject and plain text ─────────────────────────

function periodWords(c) {
  if (c.kind === 'daily') {
    return { dateline: `${fmtDay(c.from)} &nbsp;&middot;&nbsp; measured against ${fmtDay(c.prevFrom)}`, subjectPeriod: shortDay(c.from) };
  }
  if (c.kind === 'weekly') {
    return { dateline: `Week of ${fmtDay(c.from)} &nbsp;&middot;&nbsp; month to date, ${DATES.m_label}`, subjectPeriod: `${shortDay(c.from)} to ${shortDay(c.to)}` };
  }
  return { dateline: `${DATES.pm_label} &nbsp;&middot;&nbsp; closed`, subjectPeriod: DATES.pm_label };
}

const MANAGEMENT_TITLES = { daily: 'Daily Operations', weekly: 'Weekly Business Review', monthly: 'Monthly Review' };
const MANAGEMENT_SUBJECTS = { daily: 'Daily Business Report', weekly: 'Weekly Business Review', monthly: 'Monthly Review' };

// The built-in reports keep the titles and subjects management already knows; a report
// made from a template carries its own name.
function managementFrame(def, c) {
  const o = c.o(), beyond = c.beyond();
  const { dateline, subjectPeriod } = periodWords(c);
  const title = def.builtin ? MANAGEMENT_TITLES[c.kind] : def.name;
  return {
    title: def.builtin ? title : L.esc(title),
    dateline,
    subject: def.builtin ? `${MANAGEMENT_SUBJECTS[c.kind]} — ${subjectPeriod}` : `${def.name} — ${subjectPeriod}`,
    preheader: `Reached ${L.n0(o.mk.people + o.sup.people + o.col.people)} · converted ${L.n0(o.f.converted)} · FD ${L.auto(o.bk.fd).replace(/<[^>]+>/g, '').replace(/&#8358;|₦/g, 'N')} booked`,
    text: `O3 CAPITAL - ${title.toUpperCase()}\n${subjectPeriod}\n\n`
      + `Customers reached  ${L.n0(o.mk.people + o.sup.people + o.col.people)} (mkt ${L.n0(o.mk.people)}, sup ${L.n0(o.sup.people)}, coll ${L.n0(o.col.people)})\n`
      + `Conversions        ${L.n0(o.f.converted)} (${L.n0(o.f.qualified)} ${M.leadWord().lower})\n`
      + `Card spend         ${beyond ? 'no data' : 'N' + L.n0(o.sp.spend)}\n`
      + `FD booked          N${L.n0(o.bk.fd)}\nLoans booked       N${L.n0(o.bk.loan)}\n`
      + `Collections        N${L.n0(o.cash.approved)} approved, N${L.n0(o.cash.pending)} awaiting\n`
      + `Recovery book      N${L.n0(o.rec.outstanding)} outstanding\n`,
  };
}

function salesFrame(def, c) {
  const label = c.kind === 'daily' ? fmtDay(c.from) : c.kind === 'weekly' ? `Week of ${fmtDay(c.from)}` : DATES.pm_label;
  const tgt = c.tgt(), sb = c.sb(), fdAtt = c.fdAtt(), loanAtt = c.loanAtt(), fdGap = c.fdGap(), days = c.days();
  const cadenceWord = c.kind === 'daily' ? 'Daily' : c.kind === 'weekly' ? 'Weekly' : 'Monthly';
  return {
    title: def.builtin ? 'Sales Performance' : L.esc(def.name),
    dateline: `${label}${days ? ` &nbsp;&middot;&nbsp; ${days} working days left` : ''}`,
    subject: def.builtin
      ? `Sales Performance ${cadenceWord} — ${label} · FD ${L.pct(fdAtt, tgt.fd)}, loans ${L.pct(loanAtt, tgt.loan)}`
      : `${def.name} — ${label}`,
    preheader: `FD ${L.pct(fdAtt, tgt.fd)} · loans ${L.pct(loanAtt, tgt.loan)}${days ? ` · ${days} days left` : ''}`,
    text: `O3 CAPITAL - SALES PERFORMANCE (${c.kind})\n${label}\n\n`
      + `  FD    N${L.n0(fdAtt)} of N${L.n0(tgt.fd)}  (${L.pct(fdAtt, tgt.fd)})\n`
      + `  Loans N${L.n0(loanAtt)} of N${L.n0(tgt.loan)}  (${L.pct(loanAtt, tgt.loan)})\n`
      + (days ? `  Gap N${L.n0(fdGap)} over ${days} working days = N${L.n0(fdGap / days)}/day\n\n` : '\n')
      + `BY OFFICER (FD booked / target)\n`
      + sb.map((r) => `  ${r.officer.padEnd(22)} N${L.n0(r.fd_v)} / N${L.n0(r.fd_t)}`).join('\n') + '\n',
  };
}

// A report built from scratch has no headline figure it is obliged to lead with, so its
// subject is its name and period, and the plain-text part says what it contains.
function customFrame(def, c) {
  const { dateline, subjectPeriod } = periodWords(c);
  return {
    title: L.esc(def.name),
    dateline,
    subject: `${def.name} — ${subjectPeriod}`,
    preheader: def.description || `${def.name}, ${subjectPeriod}`,
    text: `O3 CAPITAL - ${def.name.toUpperCase()}\n${subjectPeriod}\n\nIn this report:\n`
      + def.sections.map((id) => `  ${(CATALOGUE_BY_ID[id] || { title: id }).title}`).join('\n')
      + '\n\nThe figures are in the HTML version of this email.\n',
  };
}

// ── Building ────────────────────────────────────────────────────────────────

/**
 * Build one report from its definition: { key, name, description, template, cadence,
 * sections, builtin, test }. Throws on an unknown section rather than quietly leaving it
 * out, so a report never goes out missing something its owner asked for.
 */
function buildReport(def) {
  const ids = Array.isArray(def.sections) ? def.sections : [];
  if (!ids.length) throw new Error(`"${def.name || def.key}" has no sections`);
  const unknown = ids.filter((id) => !SECTIONS[id]);
  if (unknown.length) throw new Error(`"${def.name || def.key}" asks for sections that do not exist: ${unknown.join(', ')}`);

  const c = makeContext(def.cadence);
  const body = ids.map((id) => SECTIONS[id](c)).join('');
  const frame = def.template === 'management' ? managementFrame(def, c)
    : def.template === 'sales' ? salesFrame(def, c)
    : customFrame(def, c);
  return {
    subject: (def.test ? '[Test] ' : '') + frame.subject,
    html: L.document_(L.shell(frame.title, frame.dateline, body), frame.preheader),
    text: frame.text,
    charts: c.charts,
  };
}

// Built before the reports table held its own sections (migration 243). Until then the
// six built-ins take their template's section list.
const BUILTIN = {
  daily: { template: 'management', cadence: 'daily', name: 'Daily Operations' },
  weekly: { template: 'management', cadence: 'weekly', name: 'Weekly Business Review' },
  monthly: { template: 'management', cadence: 'monthly', name: 'Monthly Review' },
  'sales-daily': { template: 'sales', cadence: 'daily', name: 'Sales Performance - Daily' },
  'sales-weekly': { template: 'sales', cadence: 'weekly', name: 'Sales Performance - Weekly' },
  'sales-monthly': { template: 'sales', cadence: 'monthly', name: 'Sales Performance - Monthly' },
};

const columnExists = (table, column) => !!L.q1(`
  SELECT 1 AS ok FROM information_schema.columns
   WHERE table_schema = 'app' AND table_name = '${table}' AND column_name = '${column}'`).ok;

/** A definition from a reports row or a run's saved config. */
function definitionFromRow(row) {
  const key = row.report_key || 'draft';
  const b = BUILTIN[key];
  const template = row.template || (b && b.template) || 'custom';
  const cadence = row.cadence || (b && b.cadence);
  let sections = Array.isArray(row.sections) ? row.sections : [];
  if (!sections.length && CATALOGUE.templates[template]) sections = CATALOGUE.templates[template][cadence] || [];
  return {
    key,
    name: row.name || (b && b.name) || key,
    description: row.description || '',
    template,
    cadence,
    sections,
    builtin: row.is_builtin === undefined || row.is_builtin === null ? !!b : !!row.is_builtin,
  };
}

function loadDefinition(key) {
  const builder = columnExists('management_reports', 'sections');
  const row = L.q1(`SELECT report_key, name, description, cadence${builder ? ', template, sections, is_builtin' : ''}
                      FROM app.management_reports WHERE report_key = ${L.lit(key)}`);
  if (!row.report_key) throw new Error(`there is no report "${key}"`);
  return definitionFromRow(row);
}

/**
 * The body with its charts inlined as data URIs, for the Reports page preview and the
 * --dry files. In the email itself the charts stay CID attachments, which is what
 * Outlook and Gmail need.
 */
function inlineCharts(html, pngs) {
  let out = html;
  for (const [cid, b64] of Object.entries(pngs)) out = out.split(`cid:${cid}`).join(`data:image/png;base64,${b64}`);
  return out;
}

/** Build, send and record one run the workspace created. True when delivered, or built for a preview. */
function runRecorded(runId) {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`--run-id needs a run number, got "${runId}"`);
  const withConfig = columnExists('management_report_runs', 'config');
  const run = L.q1(`SELECT id, report_key, run_trigger, status, recipients${withConfig ? ', config' : ''}
                      FROM app.management_report_runs WHERE id = ${id}`);
  if (!run.id) throw new Error(`run ${id} does not exist`);
  // Only a run still marked running is picked up, so a retried process can never resend
  // a report that was already delivered or given up on.
  if (run.status !== 'running') throw new Error(`run ${id} is already ${run.status}`);

  const finish = (fields) => L.exec(`UPDATE app.management_report_runs SET ${fields}, finished_at = NOW() WHERE id = ${id}`);
  try {
    // A preview of an edited or unsaved report carries its draft on the run; otherwise
    // the report is built as it is saved.
    const def = run.config && Array.isArray(run.config.sections)
      ? definitionFromRow({ ...run.config, report_key: run.report_key || run.config.report_key })
      : loadDefinition(run.report_key);
    if (run.run_trigger === 'test') def.test = true;

    const r = buildReport(def);
    const pngs = L.renderCharts(r.charts || {});
    const built = [
      `subject = ${L.lit(r.subject)}`,
      `chart_count = ${Object.keys(pngs).length}`,
      `body_kb = ${(Buffer.byteLength(r.html) / 1024).toFixed(1)}`,
      `preview_html = ${L.lit(inlineCharts(r.html, pngs))}`,
    ].join(', ');

    if (run.run_trigger === 'preview') {
      finish(`status = 'built', ${built}`);
      console.log(`run ${id}: ${def.key} built for preview`);
      return true;
    }

    const recipients = run.recipients || [];
    const res = L.send({ subject: r.subject, html: r.html, text: r.text, charts: pngs, recipients });
    finish(`status = '${res.ok ? 'sent' : 'failed'}', ${built}, `
      + `provider_message_id = ${L.lit(res.messageId || null)}, error = ${L.lit(res.ok ? null : res.error)}`);
    console.log(`run ${id}: ${def.key} ${res.ok ? 'sent' : 'FAILED'} to ${recipients.length} recipients`);
    return res.ok;
  } catch (e) {
    try {
      finish(`status = 'failed', error = ${L.lit(String((e && e.stack) || e).slice(0, 4000))}`);
    } catch (_) {
      // The database is the thing failing; the backend records the exit instead.
    }
    throw e;
  }
}

function main() {
  const args = process.argv.slice(2);

  const at = args.indexOf('--run-id');
  if (at !== -1) {
    // Exit 2 means built but not delivered; the outcome is already on the run.
    process.exitCode = runRecorded(args[at + 1]) ? 0 : 2;
    return;
  }

  if (args.includes('--check')) {
    const missing = CATALOGUE.sections.map((s) => s.id).filter((id) => !SECTIONS[id]);
    const extra = Object.keys(SECTIONS).filter((id) => !CATALOGUE_BY_ID[id]);
    const badTemplate = Object.entries(CATALOGUE.templates).flatMap(([t, spec]) =>
      ['daily', 'weekly', 'monthly'].flatMap((cad) => (spec[cad] || []).filter((id) => !CATALOGUE_BY_ID[id]).map((id) => `${t}.${cad}: ${id}`)));
    console.log(`catalogue sections without an implementation: ${missing.join(', ') || 'none'}`);
    console.log(`implementations missing from the catalogue: ${extra.join(', ') || 'none'}`);
    console.log(`template entries not in the catalogue: ${badTemplate.join(', ') || 'none'}`);
    process.exitCode = missing.length || extra.length || badTemplate.length ? 1 : 0;
    return;
  }

  if (!args.includes('--dry')) {
    console.error('Refusing to send outside a recorded run.\n'
      + '  Build locally:  node build-reports.js --dry [report ...]\n'
      + '  Send:           Reports > Management Reports > Send now');
    process.exitCode = 1;
    return;
  }

  const named = args.filter((a) => !a.startsWith('--'));
  const archived = columnExists('management_reports', 'archived_at') ? 'WHERE archived_at IS NULL' : '';
  const keys = named.length ? named : L.q(`SELECT report_key FROM app.management_reports ${archived} ORDER BY sort_order, report_key`).map((r) => r.report_key);
  console.log(`Dates: last working day ${DATES.lastwork}, week ${DATES.wk_start}..${DATES.wk_end}, prev month ${DATES.pm_label}\n`);
  for (const key of keys) {
    process.stdout.write(`${key}: building... `);
    const r = buildReport(loadDefinition(key));
    const pngs = L.renderCharts(r.charts || {});
    process.stdout.write(`${Object.keys(pngs).length} charts\n`);
    L.send({ subject: r.subject, html: r.html, text: r.text, charts: pngs, dryRun: true });
    fs.writeFileSync(path.join(__dirname, `preview-${key}.html`), inlineCharts(r.html, pngs), 'utf8');
  }
}

module.exports = { buildReport, definitionFromRow, loadDefinition, inlineCharts, makeContext, SECTIONS, CATALOGUE, DATES };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error((e && e.stack) || e);
    process.exitCode = 1;
  }
}
