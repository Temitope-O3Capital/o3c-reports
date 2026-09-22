'use strict';
// Shared library for the four O3 reports: database access, chart rendering, email
// components and delivery. Figures are always computed in SQL here and passed to the
// template as finished values — nothing is recalculated while rendering.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PSQL = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ENV = 'C:\\Users\\tbabatunde\\o3c-reports\\backend-go\\.env';
const DIR = __dirname;

function envVal(key) {
  const line = fs.readFileSync(ENV, 'utf8').split(/\r?\n/).find((l) => l.startsWith(key + '='));
  if (!line) throw new Error(`${key} missing from .env`);
  return line.slice(key.length + 1).replace(/^"|"$/g, '').trim();
}
const DB_URL = envVal('DATABASE_URL');
const SG_KEY = envVal('SENDGRID_API_KEY');

/** Run a SELECT and return rows as objects. Wrapped in json_agg so types survive. */
function q(sql) {
  // PGCLIENTENCODING is pinned because Windows hands argv to psql in the console
  // codepage: an em-dash in a SQL literal arrived as CP1252 0x97 and the UTF-8
  // connection rejected the whole statement. Keep SQL ASCII-only as well.
  const out = execFileSync(PSQL, [DB_URL, '-tAqc', `SELECT coalesce(json_agg(t),'[]'::json) FROM (${sql}) t`],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
  return JSON.parse(out.trim() || '[]');
}
const q1 = (sql) => q(sql)[0] || {};

/**
 * Run a statement that changes data. The SQL goes through a temp file rather than argv:
 * a report body is 60-170KB and the Windows command line stops at 32K, and a file also
 * keeps the body out of the process list. Removed as soon as psql returns.
 */
function exec(sql) {
  const file = path.join(DIR, `_sql-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(file, sql, 'utf8');
  try {
    return execFileSync(PSQL, [DB_URL, '-v', 'ON_ERROR_STOP=1', '-tAq', '-f', file],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PGCLIENTENCODING: 'UTF8' } }).trim();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** A SQL literal for exec(): dollar-quoted, with a tag that cannot occur in the value. */
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v);
  let tag = 'v';
  while (s.includes(`$${tag}$`)) tag += 'x';
  return `$${tag}$${s}$${tag}$`;
}

// ── Formatting ───────────────────────────────────────────────────────────────
const n0 = (v) => Math.round(Number(v) || 0).toLocaleString('en-NG');
// Georgia has no naira sign, so it is set in a font that does. A class, not an inline
// style: a report can carry a hundred amounts, and the style block defines it once.
const NAIRA = `<span class="ng">&#8358;</span>`;
const money = (v) => NAIRA + n0(v);
const bn = (v) => NAIRA + ((Number(v) || 0) / 1e9).toFixed(2) + 'bn';
const mn = (v) => NAIRA + ((Number(v) || 0) / 1e6).toFixed(1) + 'm';
/** Chooses bn/m/plain by magnitude so a column of figures stays readable. */
// Zero prints as "Nil", never as the naira glyph followed by 0: at report sizes "₦0"
// reads as the word "No", so "Cash approved ₦0" scans as "Cash approved No". "Nil" also
// stays distinct from "—", which this report reserves for data we do not have.
const auto = (v) => {
  const a = Math.abs(Number(v) || 0);
  if (a === 0) return 'Nil';
  return a >= 1e9 ? bn(v) : a >= 1e6 ? mn(v) : money(v);
};
const pct = (a, b) => (!b ? '—' : (100 * Number(a) / Number(b)).toFixed(1) + '%');
const delta = (cur, prev) => {
  cur = Number(cur) || 0; prev = Number(prev) || 0;
  if (!prev) return { txt: 'no prior', tone: 'flat' };
  const d = (cur - prev) / prev * 100;
  if (Math.abs(d) < 0.5) return { txt: 'Unchanged', tone: 'flat' };
  return { txt: `${d > 0 ? 'Up' : 'Down'} ${Math.abs(d).toFixed(1)}%`, tone: d > 0 ? 'up' : 'down' };
};

// Role labels, mirroring frontend/src/lib/roles.ts so the reports name people exactly
// as the workspace UI does. Printing the raw slug put "exec_overview" beside the MD's
// name. Note the taxonomy already contains `md` — where a title looks wrong in a report
// it is the user's ROLE that needs correcting in Admin -> Users, not this map.
const ROLE_LABELS = {
  admin: 'Administrator', md: 'Managing Director', coo: 'Chief Operating Officer',
  cfo: 'Chief Financial Officer', cmo: 'Chief Marketing Officer',
  exec_overview: 'Executive (Overview)', it_admin: 'IT Administrator',
  bi_head: 'Head of Analytics', bi_analyst: 'Analytics Analyst',
  sales_officer: 'Sales Officer', sales_head: 'Head of Sales',
  bd_officer: 'BD Officer', bd_head: 'Head of Business Development',
  risk_officer: 'Risk Officer', risk_head: 'Head of Risk',
  collections_agent: 'Collections Agent', collections_head: 'Head of Collections',
  recovery_agent: 'Recovery Agent', recovery_head: 'Head of Recovery',
  cards_agent: 'Cards Agent', cards_head: 'Head of Cards',
  finance_officer: 'Finance Officer', finance_head: 'Head of Finance',
  settlement_officer: 'Settlement Officer', settlement_head: 'Head of Settlement & Reconciliation',
  call_center_agent: 'Call Center Agent', call_center_head: 'Head of Call Center',
  care_agent: 'Care Agent', care_head: 'Head of Care',
  compliance_officer: 'Compliance Officer', compliance_head: 'Head of Compliance',
  executive: 'Executive', management: 'Management', head_ops: 'Head of Operations',
  head_it: 'Head of IT', head_sales: 'Head of Sales',
};
const roleLabel = (r) => ROLE_LABELS[r] || String(r || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ── Palette ──────────────────────────────────────────────────────────────────
const INK = '#16171a', INK2 = '#5f6167', INK3 = '#8b8d93', FAINT = '#a9a7a2';
const HAIR = '#e6e4df', HAIR2 = '#f0eeea', BRASS = '#8c6a3f';
const UP = '#2f6b4f', DOWN = '#9b3232';
const SANS = 'Arial,Helvetica,sans-serif';
const SERIF = "Georgia,'Times New Roman',serif";

// ── Charts: SVG rendered to PNG by headless Chrome, shipped as CID ───────────
const CW = 600, CH = 136, PL = 64, PR = 16, PT = 16, PB = 22;
const PWi = CW - PL - PR, PHi = CH - PT - PB;

function fmtTick(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return '₦' + (v / 1e9).toFixed(2) + 'bn';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'm';
  if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

/**
 * Area chart. Straight segments between measured points: smoothing a series that drops
 * to zero at weekends would overshoot and draw values nobody recorded.
 */
function areaSVG(o) {
  const { values, dates, weekend = [], zoom = false, accent = INK, deadFrom = null, deadLabel = '' } = o;
  const liveN = deadFrom === null ? values.length : deadFrom;
  const live = values.slice(0, liveN).map(Number);
  if (live.length < 2) return null;
  const max = Math.max(...live, 1), min = Math.min(...live);
  const lo = zoom ? min - (max - min) * 0.35 : 0;
  const hi = zoom ? max + (max - min) * 0.15 : max * 1.12;
  const span = (hi - lo) || 1;
  const x = (i) => PL + (i / (values.length - 1)) * PWi;
  const y = (v) => PT + PHi - ((v - lo) / span) * PHi;
  let s = '';
  const bandW = PWi / (values.length - 1);
  for (const i of weekend) {
    const x0 = Math.max(PL, x(i) - bandW / 2);
    s += `<rect x="${x0.toFixed(1)}" y="${PT}" width="${Math.min(bandW, PL + PWi - x0).toFixed(1)}" height="${PHi}" fill="#f7f5f1"/>`;
  }
  for (const t of (zoom ? [min, (min + max) / 2, max] : [0, max / 2, max])) {
    const yy = y(t).toFixed(1);
    s += `<line x1="${PL}" y1="${yy}" x2="${PL + PWi}" y2="${yy}" stroke="#eceae5"/>`
      + `<text x="${PL - 7}" y="${(+yy + 3).toFixed(1)}" text-anchor="end" font-family="Arial" font-size="9" fill="${FAINT}">${fmtTick(t)}</text>`;
  }
  const pts = live.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  s += `<path d="M${x(0).toFixed(1)},${y(lo).toFixed(1)} L${pts.join(' L')} L${x(liveN - 1).toFixed(1)},${y(lo).toFixed(1)} Z" fill="url(#g)"/>`
    + `<polyline points="${pts.join(' ')}" fill="none" stroke="${accent}" stroke-width="1.6" stroke-linejoin="round"/>`;
  if (deadFrom !== null) {
    const x0 = x(deadFrom - 1), w = PL + PWi - x0;
    s += `<rect x="${x0.toFixed(1)}" y="${PT}" width="${w.toFixed(1)}" height="${PHi}" fill="url(#hatch)"/>`
      + `<line x1="${x0.toFixed(1)}" y1="${PT}" x2="${x0.toFixed(1)}" y2="${PT + PHi}" stroke="${BRASS}" stroke-dasharray="2,2"/>`
      + `<text x="${(x0 + w / 2).toFixed(1)}" y="${(PT + PHi / 2 + 3).toFixed(1)}" text-anchor="middle" font-family="Arial" font-size="9.5" fill="${BRASS}">${deadLabel}</text>`;
  }
  const li = liveN - 1;
  s += `<circle cx="${x(li).toFixed(1)}" cy="${y(live[li]).toFixed(1)}" r="3" fill="${accent}"/>`
    + `<text x="${(x(li) - (deadFrom !== null ? 14 : 6)).toFixed(1)}" y="${Math.max(PT + 10, y(live[li]) - 9).toFixed(1)}" text-anchor="end" font-family="Georgia" font-size="12" fill="${INK}">${fmtTick(live[li])}</text>`
    + `<line x1="${PL}" y1="${PT + PHi}" x2="${PL + PWi}" y2="${PT + PHi}" stroke="${HAIR}"/>`;
  for (const i of [0, Math.floor((values.length - 1) / 2), values.length - 1]) {
    s += `<text x="${x(i).toFixed(1)}" y="${PT + PHi + 14}" text-anchor="${i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle'}" font-family="Arial" font-size="9" fill="${FAINT}">${dates[i]}</text>`;
  }
  return wrapSVG(CW, CH, accent, s);
}

/**
 * Doughnut with a legend. Rendered to PNG like the other charts, so it displays in
 * Outlook where inline SVG does not.
 * @param {{label:string, v:number, c:string}[]} segs
 * @param {string} centre  text shown in the hole (usually the total)
 * @param {string} caption small line under the centre text
 */
function doughnutSVG(segs, centre, caption) {
  const W = CW, H = 188, cx = 96, cy = 94, R = 74, r = 45;
  const total = segs.reduce((a, s) => a + Math.max(0, Number(s.v) || 0), 0);
  if (!total) return null;
  const pt = (ang, rad) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
  let a0 = -Math.PI / 2, slices = '';
  const live = segs.filter((s) => Number(s.v) > 0);

  if (live.length === 1) {
    // A single slice cannot be drawn as an arc: start and end coincide and the path
    // collapses. Draw the ring as a stroked circle instead.
    slices = `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${live[0].c}" stroke-width="${R - r}"/>`;
  } else {
    for (const s of live) {
      const frac = Math.max(0, Number(s.v)) / total;
      const a1 = a0 + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R);
      const [x2, y2] = pt(a1, r), [x3, y3] = pt(a0, r);
      slices += `<path d="M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${large},1 ${x1.toFixed(2)},${y1.toFixed(2)}`
        + ` L${x2.toFixed(2)},${y2.toFixed(2)} A${r},${r} 0 ${large},0 ${x3.toFixed(2)},${y3.toFixed(2)} Z"`
        + ` fill="${s.c}"/>`;
      a0 = a1;
    }
  }

  let legend = '';
  live.forEach((s, i) => {
    const y = 26 + i * 26;
    const share = ((Math.max(0, Number(s.v)) / total) * 100).toFixed(1);
    legend += `<rect x="205" y="${y - 9}" width="10" height="10" fill="${s.c}"/>`
      + `<text x="223" y="${y}" font-family="Arial" font-size="11.5" fill="${INK2}">${esc(s.label)}</text>`
      + `<text x="${W - 12}" y="${y}" text-anchor="end" font-family="Georgia" font-size="12" fill="${INK}">${esc(s.display || '')} <tspan font-family="Arial" font-size="10.5" fill="${FAINT}">${share}%</tspan></text>`;
  });

  const inner = slices
    + `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-family="Georgia" font-size="17" fill="${INK}">${esc(centre)}</text>`
    + (caption ? `<text x="${cx}" y="${cy + 15}" text-anchor="middle" font-family="Arial" font-size="10" fill="${FAINT}">${esc(caption)}</text>` : '')
    + legend;
  return wrapSVG(W, H, BRASS, inner);
}

/** A restrained sequence for doughnut slices: one brass accent, the rest neutral. */
const SLICE_COLOURS = ['#8c6a3f', '#b8a07c', '#5f6167', '#c9c6c0', '#a9885a', '#dcd9d3'];

/** Horizontal stacked proportion bar with end labels. */
function stackSVG(segs, leftLabel, rightLabel) {
  const H = 40, pad = 1, total = segs.reduce((a, z) => a + Number(z.v), 0) || 1;
  let xx = pad, bars = '';
  for (const z of segs) {
    const w = (Number(z.v) / total) * (CW - pad * 2);
    bars += `<rect x="${xx.toFixed(1)}" y="6" width="${w.toFixed(1)}" height="11" fill="${z.c}"/>`;
    xx += w;
  }
  const s = bars
    + `<text x="${pad}" y="31" font-family="Arial" font-size="10" fill="${FAINT}">${leftLabel}</text>`
    + `<text x="${CW - pad}" y="31" text-anchor="end" font-family="Arial" font-size="10" fill="${FAINT}">${rightLabel}</text>`;
  return wrapSVG(CW, H, BRASS, s);
}

/**
 * Ranked horizontal bars — a leaderboard. Each row is a name, a bar filled to `frac`
 * (0..1, already capped by the caller) and a value on the right. Used where several
 * people or products are best read sorted and compared at a glance, not in a table.
 * @param {{label:string, frac:number, display:string, tone?:string}[]} items already sorted
 */
function rankBarsSVG(items, opts = {}) {
  const rows = opts.limit ? items.slice(0, opts.limit) : items;
  if (!rows.length) return null;
  // PAD keeps the name and the figure clear of the border; without it the first and last
  // columns sat hard against the frame on both edges.
  const PAD = 12;
  const rowH = 25, top = 12, labelW = 148, valueW = 92, barX = PAD + labelW + 6;
  const barW = CW - barX - valueW - PAD * 2;
  const H = top * 2 + rows.length * rowH;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  let s = '';
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const frac = Math.max(0, Math.min(1, Number(r.frac) || 0));
    const w = frac * barW;
    const barColour = r.tone || (frac >= 1 ? UP : frac === 0 ? '#d8d5cf' : BRASS);
    s += `<text x="${PAD}" y="${(y + 9).toFixed(1)}" font-family="Arial" font-size="11" fill="${INK2}">${esc(clip(String(r.label), 20))}</text>`
      + `<rect x="${barX}" y="${y}" width="${barW}" height="9" rx="2" fill="#f0eeea"/>`
      + `<rect x="${barX}" y="${y}" width="${w.toFixed(1)}" height="9" rx="2" fill="${barColour}"/>`
      + `<text x="${CW - PAD}" y="${(y + 9).toFixed(1)}" text-anchor="end" font-family="Georgia" font-size="11" fill="${INK}">${esc(String(r.display))}</text>`;
  });
  return wrapSVG(CW, H, BRASS, s);
}

/**
 * Month-on-month columns — one bar per month, the most recent one picked out in brass so
 * "where we are now" is obvious before any number is read. Written for the sales report,
 * where the readers are not analysts: the shape carries the message and the figures are
 * there to confirm it, not to be decoded.
 * @param {{label:string, v:number, display:string}[]} points oldest first
 */
function monthBarsSVG(points, opts = {}) {
  const pts = points.filter((p) => p && Number.isFinite(Number(p.v)));
  if (!pts.length || pts.every((p) => Number(p.v) === 0)) return null;
  const H = 168, top = 26, base = H - 26, PAD = 12;
  const max = Math.max(...pts.map((p) => Number(p.v)));
  const slot = (CW - PAD * 2) / pts.length;
  const bw = Math.min(46, slot * 0.56);
  let s = `<line x1="${PAD}" y1="${base}" x2="${CW - PAD}" y2="${base}" stroke="${HAIR}"/>`;
  pts.forEach((p, i) => {
    const v = Number(p.v);
    // A real but tiny month still gets a visible sliver; only a true zero shows nothing.
    const h = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * (base - top)) : 0;
    const x = PAD + i * slot + (slot - bw) / 2;
    const last = i === pts.length - 1;
    s += `<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${last ? (opts.accent || BRASS) : '#dcd9d3'}"/>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${(base - h - 7).toFixed(1)}" text-anchor="middle" font-family="Georgia" font-size="${last ? 11.5 : 10}" fill="${last ? INK : INK3}">${esc(String(p.display))}</text>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${base + 15}" text-anchor="middle" font-family="Arial" font-size="9.5" fill="${last ? INK2 : FAINT}">${esc(String(p.label))}</text>`;
  });
  return wrapSVG(CW, H, opts.accent || BRASS, s);
}

function wrapSVG(w, h, accent, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="${accent}" stop-opacity="0.20"/><stop offset="100%" stop-color="${accent}" stop-opacity="0.03"/></linearGradient>
<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<rect width="6" height="6" fill="#fdfaf4"/><line x1="0" y1="0" x2="0" y2="6" stroke="#e6d6bc" stroke-width="1.4"/></pattern></defs>
<rect width="${w}" height="${h}" fill="#fffffe"/>${inner}
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="${HAIR}"/></svg>`;
}

/** Rasterise a batch of SVGs at 2x. Returns { name: base64png }. */
function renderCharts(svgs) {
  const out = {};
  for (const [name, svg] of Object.entries(svgs)) {
    if (!svg) continue;
    const m = svg.match(/height="(\d+)"/);
    const h = m ? m[1] : CH;
    const htmlPath = path.join(DIR, `_c-${name}.html`);
    const pngPath = path.join(DIR, `_c-${name}.png`);
    fs.writeFileSync(htmlPath,
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fffffe;width:${CW}px;height:${h}px;overflow:hidden}svg{display:block}</style>${svg}`, 'utf8');
    try {
      execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--force-device-scale-factor=2', `--window-size=${CW},${h}`,
        `--screenshot=${pngPath}`, `file:///${htmlPath.replace(/\\/g, '/')}`], { stdio: 'ignore', timeout: 90000 });
      out[name] = fs.readFileSync(pngPath).toString('base64');
    } catch (e) {
      console.error(`chart ${name} failed to render:`, e.message);
    }
  }
  return out;
}

// ── Email components ─────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function section(title, kicker, sub) {
  return `<tr><td class="pad" style="padding:32px 40px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${HAIR};padding-top:22px">
      <p class="ink" style="margin:0 0 3px;font-family:${SERIF};font-size:17px;line-height:22px;mso-line-height-rule:exactly;color:${INK}">${title}${kicker ? ` <span style="font-family:${SANS};font-size:10.5px;letter-spacing:1.2px;color:${BRASS}">&nbsp;${kicker}</span>` : ''}</p>
      ${sub ? `<p class="mut" style="margin:0;font-family:${SANS};font-size:11.5px;line-height:17px;mso-line-height-rule:exactly;color:${INK3}">${sub}</p>` : ''}
    </td></tr></table></td></tr>`;
}

function chartRow(cid, alt) {
  return `<tr><td class="pad" style="padding:16px 40px 0">
    <img src="cid:${cid}" width="600" alt="${esc(alt)}" style="width:100%;max-width:600px;height:auto;display:block;border:0;font-family:${SANS};font-size:12px;color:${INK2}"></td></tr>`;
}

/** items: {k, sub, v, note, tone, noteTone} */
// Label and its qualifier stack on separate lines, and so do the value and its note.
// Previously a long qualifier ("marketing 7,509, support 452, collections 108") wrapped
// inside the left cell and pushed the figure onto a line of its own. Both cells are
// top-aligned and the value never wraps.
// The type for rows lives in classes (see document_), with only a tone colour inline:
// a row is ~150 bytes instead of ~700, which is what keeps a report that lists the whole
// sales team under Gmail's ~102KB clip.
function rowHtml(it, last, grouped) {
  const b = last ? '' : ' b';
  const tone = it.tone ? ` style="color:${it.tone}"` : '';
  const noteTone = it.noteTone ? ` style="color:${it.noteTone}"` : '';
  return `<tr><td valign="top" class="k${grouped ? ' gk' : ''} mut${b}">${it.k}${it.sub ? `<br><span class="s">${it.sub}</span>` : ''}</td>`
    + `<td valign="top" align="right" class="v${grouped ? ' gv' : ''} nw ${it.tone ? 'tone' : 'ink'}${b}"${tone}>${it.v}${it.note ? `<br><span class="n nw"${noteTone}>${it.note}</span>` : ''}</td></tr>`;
}

function rows(items) {
  const body = items.map((it, i) => rowHtml(it, i === items.length - 1, false)).join('');
  return `<tr><td class="pad" style="padding:0 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px">${body}</table></td></tr>`;
}

/**
 * A titled block of rows for one person: the name and role as a header, then that
 * person's lines. Used where several people each carry the same few figures, so every
 * figure gets a line of its own instead of hiding in a sub-line. Same columns, wrapping
 * and phone behaviour as rows().
 */
function group(title, sub, items) {
  const head = `<tr><td colspan="2" class="gh"><p class="gt ink">${title}</p>${sub ? `<p class="gs mut">${sub}</p>` : ''}</td></tr>`;
  const body = items.map((it, i) => rowHtml(it, i === items.length - 1, true)).join('');
  return `<tr><td class="pad" style="padding:0 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${head}${body}</table></td></tr>`;
}

function note(text) {
  return `<tr><td class="pad" style="padding:10px 40px 0"><p class="mut" style="margin:0;font-family:${SANS};font-size:11px;line-height:17px;mso-line-height-rule:exactly;color:${FAINT}">${text}</p></td></tr>`;
}

function kpiRow(cards) {
  const tone = (t) => (t === 'up' ? UP : t === 'down' ? DOWN : INK3);
  const arrow = (t) => (t === 'up' ? '&#9650;' : t === 'down' ? '&#9660;' : '&mdash;');
  const w = Math.floor(612 / Math.min(cards.length, 4));
  // The div is fluid with a max-width cap, so the media query can relax the cap and let
  // the cards reflow 2-up and then 1-up. The divider is a left border, which has to go
  // when they wrap or it lands mid-row.
  const cells = cards.map((c, i) => `${i ? `<!--[if mso]></td><td width="${w}" valign="top"><![endif]-->` : ''}
    <div class="kpi" style="display:inline-block;width:100%;max-width:${w}px;vertical-align:top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="${i === 0 ? '' : 'kpicell'}" style="padding:0 10px 20px ${i === 0 ? '6px' : '14px'};${i === 0 ? '' : `border-left:1px solid ${HAIR};`}">
        <p class="mut" style="margin:0 0 8px;font-family:${SANS};font-size:9px;line-height:12px;mso-line-height-rule:exactly;color:${INK3};letter-spacing:1.2px">${c.label}</p>
        <p class="ink kv" style="margin:0 0 6px;font-family:${SERIF};font-size:25px;line-height:28px;mso-line-height-rule:exactly;color:${INK}">${c.value}</p>
        <p class="nw" style="margin:0;font-family:${SANS};font-size:10.5px;line-height:14px;mso-line-height-rule:exactly;color:${tone(c.tone)}"><span aria-hidden="true">${arrow(c.tone)}</span>&nbsp;${c.delta}</p>
      </td></tr></table></div>`).join('');
  return `<tr><td class="kpipad" style="padding:28px 34px 0;font-size:0;line-height:0">
    <!--[if mso]><table role="presentation" width="612" cellpadding="0" cellspacing="0" border="0"><tr><td width="${w}" valign="top"><![endif]-->
    ${cells}<!--[if mso]></td></tr></table><![endif]--></td></tr>`;
}

/**
 * Filled progress bars against target. Built from nested tables with bgcolor rather than
 * an image or a CSS bar: it costs no attachment, stays crisp at any width, and is the one
 * form Outlook renders reliably.
 *
 * A bar never runs past its track — over-attainment fills it completely and is said in
 * the figures beside it, because a bar overflowing its own frame reads as a rendering
 * fault rather than as good news. `frac` of null means there is no target to measure
 * against, which draws an empty track and says so; that is the honest rendering for
 * cards, which carry no target in sales_targets.
 * @param {{label:string, value:string, frac:number|null, note?:string, right?:string}[]} items
 */
function progressBars(items) {
  const body = items.map((it) => {
    const has = it.frac !== null && it.frac !== undefined && Number.isFinite(Number(it.frac));
    const frac = has ? Math.max(0, Math.min(1, Number(it.frac))) : 0;
    const filled = Math.round(frac * 100);
    const colour = it.tone || (frac >= 1 ? UP : frac >= 0.6 ? BRASS : frac > 0 ? '#b8a07c' : '#d8d5cf');
    // A zero-width cell is dropped outright by some clients, so each side is emitted
    // only when it has width.
    const bar = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed"><tr>'
      + (filled ? `<td bgcolor="${colour}" width="${filled}%" style="width:${filled}%;background:${colour};font-size:1px;line-height:11px;height:11px">&#160;</td>` : '')
      + (filled < 100 ? `<td bgcolor="#f0eeea" width="${100 - filled}%" style="width:${100 - filled}%;background:#f0eeea;font-size:1px;line-height:11px;height:11px">&#160;</td>` : '')
      + '</tr></table>';
    return `<tr><td style="padding:0 0 18px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-family:${SANS};font-size:9.5px;line-height:14px;color:${INK3};letter-spacing:1.2px;padding:0 8px 6px 0">${it.label}</td>
        <td align="right" class="nw" style="font-family:${SERIF};font-size:17px;line-height:20px;color:${INK};padding:0 0 6px;white-space:nowrap">${it.value}</td>
      </tr></table>
      ${bar}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-family:${SANS};font-size:10.5px;line-height:15px;color:${FAINT};padding:6px 8px 0 0">${it.note || ''}</td>
        <td align="right" class="nw" style="font-family:${SANS};font-size:10.5px;line-height:15px;color:${it.rightTone || INK2};padding:6px 0 0;white-space:nowrap">${it.right || ''}</td>
      </tr></table></td></tr>`;
  }).join('');
  return `<tr><td class="pad" style="padding:22px 40px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table></td></tr>`;
}

/**
 * A real multi-column table, for lists where each row carries several facts that have to
 * line up down the page — client, amount, who booked it. rows() is a two-column key/value
 * layout and cannot show those side by side.
 *
 * Cells arrive already formatted and escaped by the caller, because most of them are
 * money strings that carry their own markup.
 * @param {{label:string, align?:string, width?:string}[]} cols
 * @param {string[][]} data
 */
function dataTable(cols, data) {
  const al = (j) => (cols[j] && cols[j].align) || 'left';
  const head = cols.map((c, j) => `<th align="${c.align || 'left'}"${c.width ? ` width="${c.width}"` : ''} class="th${j ? ' tp' : ''}">${c.label}</th>`).join('');
  const body = data.map((r, i) => `<tr${i === data.length - 1 ? ' class="tl"' : ''}>`
    + r.map((cell, j) => `<td align="${al(j)}" valign="top" class="tc${j ? ' tp' : ' t0'}">${cell}</td>`).join('')
    + '</tr>').join('');
  return `<tr><td class="pad" style="padding:0 40px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px">
    <tr>${head}</tr>${body}</table></td></tr>`;
}

/** The exceptions block. Empty list renders "No exceptions", which is the point. */
function exceptions(list) {
  const inner = list.length
    ? list.map((e) => `<tr><td style="padding:7px 0;border-bottom:1px solid ${HAIR2};font-family:${SANS};font-size:12.5px;line-height:18px;color:${INK2}">
         <span style="color:${DOWN};font-weight:bold">&#9679;</span> ${e.what}${e.owner ? ` <span style="color:${FAINT}">— ${e.owner}</span>` : ''}</td></tr>`).join('')
    : `<tr><td style="padding:7px 0;font-family:${SANS};font-size:12.5px;color:${UP}">No exceptions.</td></tr>`;
  return `<tr><td class="pad" style="padding:26px 40px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${list.length ? DOWN : HAIR};padding-top:11px">
      <p style="margin:0 0 4px;font-family:${SANS};font-size:9.5px;line-height:13px;color:${list.length ? DOWN : INK3};letter-spacing:1.6px">EXCEPTIONS</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${inner}</table>
    </td></tr></table></td></tr>`;
}

function shell(title, dateline, bodyRows) {
  // Centred two ways: align="center" on the sheet and its wrapper cell is what Outlook
  // desktop honours, margin:0 auto is what Gmail and Apple Mail honour. Without both the
  // 600px sheet sat against the left edge of a wide desktop window.
  return `<table role="presentation" class="sheet" align="center" bgcolor="#fffffe" width="680" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;width:100%;margin:0 auto;background:#fffffe">
  <tr><td style="background:${BRASS};font-size:1px;line-height:2px;height:2px">&#160;</td></tr>
  <tr><td class="pad" style="padding:32px 40px 0">
    <p class="mut" style="margin:0 0 20px;font-family:${SANS};font-size:10px;line-height:14px;color:${INK3};letter-spacing:2.4px">O 3 &nbsp; C A P I T A L</p>
    <p class="ink h1" style="margin:0 0 6px;font-family:${SERIF};font-size:29px;line-height:34px;mso-line-height-rule:exactly;color:${INK}">${title}</p>
    <p class="mut" style="margin:0;font-family:${SANS};font-size:12.5px;line-height:18px;color:${INK2}">${dateline}</p>
  </td></tr>
  ${bodyRows}
  <tr><td class="pad" style="padding:28px 40px 34px">
    <p class="mut" style="margin:0;font-family:${SANS};font-size:10.5px;line-height:16px;color:${FAINT}">
      Generated ${new Date().toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} WAT from the workspace database. Figures computed in SQL.
    </p></td></tr>
</table>`;
}

function document_(inner, preheader) {
  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="only light"><meta name="supported-color-schemes" content="light">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<style>
  :root{color-scheme:only light;supported-color-schemes:light}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;
    font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}
  [data-ogsc] .sheet,[data-ogsb] .sheet{background:#fffffe!important}
  [data-ogsc] .ink{color:${INK}!important}
  [data-ogsc] .mut{color:${INK2}!important}
  /* Row type as classes rather than inline styles, so a long report stays under Gmail's
     ~102KB clip. Alignment stays in HTML attributes: a client that drops this block
     still lines the figures up, in its own font. */
  .k{padding:11px 14px 11px 0;font-family:${SANS};font-size:12.5px;line-height:17px;color:${INK2}}
  .v{padding:11px 0;font-family:${SERIF};font-size:15px;line-height:17px;color:${INK};white-space:nowrap}
  .gk{padding:8px 14px 8px 12px}
  .gv{padding:8px 0;font-size:14.5px}
  .b{border-bottom:1px solid ${HAIR2}}
  .s{font-size:11px;line-height:15px;color:${FAINT}}
  .n{font-family:${SANS};font-size:11px;line-height:15px;color:${FAINT};white-space:nowrap}
  .gh{padding:18px 0 6px;border-bottom:1px solid ${HAIR}}
  .gt{margin:0;font-family:${SERIF};font-size:15.5px;line-height:20px;color:${INK}}
  .gs{margin:1px 0 0;font-family:${SANS};font-size:10.5px;line-height:14px;letter-spacing:.3px;color:${FAINT}}
  .ng{font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif}
  /* dataTable, as classes for the same reason as rows(): a month of named business is
     ~60 cells, and inline styles on each one cost ~20KB of the Gmail budget on their own. */
  .th{font-family:${SANS};font-size:9px;line-height:12px;color:${INK3};letter-spacing:1.1px;font-weight:normal;padding:0 0 7px;border-bottom:1px solid ${HAIR}}
  .tc{font-family:${SERIF};font-size:12px;line-height:17px;color:${INK};padding:7px 0;border-bottom:1px solid ${HAIR2}}
  .t0{font-family:${SANS};color:${INK2}}
  .tp{padding-left:10px}
  .tl td{border-bottom:0}
  .sub{font-family:${SANS};font-size:10px;line-height:14px;color:${FAINT}}
  .dim{color:${FAINT}}
  .good{color:${UP}}
  /* The sheet was fluid but everything inside it was not: 40px side padding on both
     edges leaves 280px of a 360px phone, and the KPI strip pinned every card to
     532/4 = 133px so four figures stayed four-across and crushed instead of stacking.
     Inline styles win over classes, so each override has to carry !important. */
  @media screen and (max-width:680px){
    .pad{padding-left:22px!important;padding-right:22px!important}
    .kpipad{padding-left:12px!important;padding-right:12px!important}
    .h1{font-size:23px!important;line-height:28px!important}
    .kpi{max-width:50%!important}
    .kpicell{border-left:0!important;padding-left:10px!important;padding-right:10px!important}
    .kv{font-size:21px!important;line-height:25px!important}
    .nw{white-space:normal!important}
  }
  @media screen and (max-width:420px){
    .pad{padding-left:15px!important;padding-right:15px!important}
    .kpi{max-width:100%!important}
    .kpicell{padding-left:6px!important;padding-right:6px!important}
    .h1{font-size:20px!important;line-height:25px!important}
  }
</style>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<style>table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#e8e6e1;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(preheader)}&#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e6e1">
  <tr><td align="center" valign="top" style="padding:24px 12px 40px">${inner}</td></tr>
</table>
</body></html>`;
}

/**
 * Deliver one report through SendGrid. Recipients come from the run the workspace
 * recorded -- they are edited on the Reports page, not here. Each address gets its own
 * personalization, so nobody on the list sees anyone else's.
 * Returns { ok, kb, messageId, error }.
 */
function send({ subject, html, text, charts, recipients, dryRun }) {
  const attachments = Object.entries(charts).map(([cid, content]) => ({
    content, filename: `${cid}.png`, type: 'image/png', disposition: 'inline', content_id: cid,
  }));
  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  if (dryRun) { console.log(`   [dry run] ${subject} — body ${kb}KB, ${attachments.length} charts`); return { ok: true, kb }; }

  const to = [...new Set((recipients || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (!to.length) return { ok: false, kb, error: 'No recipients are configured for this report.' };

  const payload = {
    personalizations: to.map((email) => ({ to: [{ email }] })),
    from: { email: 'no-reply@o3cards.com', name: 'O3 Capital Business Intelligence' },
    reply_to: { email: 'no-reply@o3cards.com', name: 'O3 Capital Business Intelligence' },
    subject,
    content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
    categories: ['digest'],
    tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
  };
  // SendGrid rejects an empty attachments array outright rather than ignoring it, so a
  // chartless report (sales) 400s if the key is present but empty. Only send the key
  // when there is something in it.
  if (attachments.length) payload.attachments = attachments;

  // The payload carries every recipient address and the whole report, so it is deleted
  // the moment SendGrid has answered, whatever the answer.
  const file = path.join(DIR, `_payload-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  try {
    // Read the response body on failure: SendGrid explains exactly which field it
    // rejected, and without it a 400 is just a guess.
    const ps = `$k='${SG_KEY}'; try { $r = Invoke-WebRequest -Uri 'https://api.sendgrid.com/v3/mail/send' -Method Post -Headers @{Authorization=("Bearer "+$k)} -ContentType 'application/json' -InFile '${file}' -UseBasicParsing -TimeoutSec 180; Write-Output ("HTTP " + $r.StatusCode + " " + $r.Headers['X-Message-Id']) } catch { $m=$_.Exception.Message; try { $sr=New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); $m=$m+" :: "+$sr.ReadToEnd() } catch {}; Write-Output ("FAIL " + $m) }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
    console.log(`   ${out}  — body ${kb}KB, ${attachments.length} charts`);
    const ok = out.startsWith('HTTP 202');
    return { ok, kb, messageId: ok ? (out.split(/\s+/)[2] || '') : '', error: ok ? '' : out };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

module.exports = {
  q, q1, exec, lit, n0, money, bn, mn, auto, pct, delta, NAIRA,
  INK, INK2, INK3, FAINT, HAIR, HAIR2, BRASS, UP, DOWN, SANS, SERIF,
  areaSVG, stackSVG, doughnutSVG, rankBarsSVG, monthBarsSVG, SLICE_COLOURS, renderCharts, roleLabel, ROLE_LABELS,
  section, chartRow, rows, group, note, kpiRow, progressBars, dataTable, exceptions, shell, document_, esc, send,
};
