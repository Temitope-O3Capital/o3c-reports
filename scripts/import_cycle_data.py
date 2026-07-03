#!/usr/bin/env python3
"""
import_cycle_data.py — imports O3 Capital card cycle report files into card_cycle_data.

Each month folder must contain 4 files:
  cyc_bal_rpt.*   — balance report
  cyc_chg_rpt.*   — charges report
  cyc_int_rpt.*   — interest report
  cyc_loc_rpt.*   — LOC (credit limit) report

Usage:
  python import_cycle_data.py <DATABASE_URL> <path_to_reports_folder>

  The reports folder can contain one month or multiple month sub-folders:
    reports/april/cyc_bal_rpt.20260415.105348
    reports/april/cyc_chg_rpt.20260415.115915
    ...
  OR the files can sit directly in the folder (single month import).

  DATABASE_URL format: postgresql://user:password@host:5432/dbname

Re-running is safe — uses INSERT ... ON CONFLICT DO UPDATE (upsert).
"""

import os
import re
import sys
import glob
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional, List

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
    sys.exit(1)


# ── Parsing helpers ────────────────────────────────────────────────────────────

# Data row pattern: starts with 3-digit product code
DATA_ROW = re.compile(r'^\s*(\d{3})\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)')
# Statement date in report header — two formats: DD/MM/YYYY or DDMMYYYY
CYCLE_DATE_SLASHED = re.compile(r'Statement Date\s*:?\s*(\d{2}/\d{2}/\d{4})', re.IGNORECASE)
CYCLE_DATE_COMPACT = re.compile(r'Statement Date\s*:?\s*(\d{8})\b', re.IGNORECASE)


def kobo(value: str) -> int:
    """Convert decimal string (e.g. '5758.87') to integer kobo (×100). Handles negatives."""
    try:
        return int(Decimal(value.strip().replace(',', '')) * 100)
    except (InvalidOperation, ValueError):
        return 0


def parse_date(raw: str) -> str:
    """Convert DD/MM/YYYY to YYYY-MM-DD."""
    return datetime.strptime(raw.strip(), '%d/%m/%Y').strftime('%Y-%m-%d')


def extract_cycle_date(filepath: str) -> Optional[str]:
    """Scan the first 30 lines of a report file for the statement date."""
    with open(filepath, encoding='utf-8', errors='replace') as f:
        for i, line in enumerate(f):
            if i > 30:
                break
            m = CYCLE_DATE_SLASHED.search(line)
            if m:
                return parse_date(m.group(1))
            m = CYCLE_DATE_COMPACT.search(line)
            if m:
                raw = m.group(1)  # DDMMYYYY
                return datetime.strptime(raw, '%d%m%Y').strftime('%Y-%m-%d')
    return None


def parse_bal(filepath: str) -> dict:
    """Parse cyc_bal_rpt. Returns dict keyed by (product_code, cif, account, currency)."""
    rows = {}
    with open(filepath, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = DATA_ROW.match(line)
            if not m:
                continue
            code, cif, account, currency = m.group(1), m.group(2), m.group(3), m.group(4)
            # backtick CIFs sometimes appear as `0000000`` — clean up
            cif = cif.strip('`')
            amounts = m.group(5).split()
            if len(amounts) < 6:
                continue
            key = (code, cif, account, currency)
            rows[key] = {
                'billed_balance_kobo':      kobo(amounts[0]),
                'current_balance_kobo':     kobo(amounts[1]),
                'outstanding_balance_kobo': kobo(amounts[2]),
                'overdue_amount_kobo':      kobo(amounts[3]),
                'minimum_payment_kobo':     kobo(amounts[4]),
                'total_payment_kobo':       kobo(amounts[5]),
            }
    return rows


def parse_chg(filepath: str) -> dict:
    """Parse cyc_chg_rpt."""
    rows = {}
    with open(filepath, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = DATA_ROW.match(line)
            if not m:
                continue
            code, cif, account, currency = m.group(1), m.group(2).strip('`'), m.group(3), m.group(4)
            amounts = m.group(5).split()
            if len(amounts) < 5:
                continue
            key = (code, cif, account, currency)
            rows[key] = {
                'fees_kobo':             kobo(amounts[0]),
                'interest_charged_kobo': kobo(amounts[1]),
                'penalty_kobo':          kobo(amounts[2]),
                'purchase_amount_kobo':  kobo(amounts[3]),
                'cash_advance_kobo':     kobo(amounts[4]),
            }
    return rows


def parse_int(filepath: str) -> dict:
    """Parse cyc_int_rpt."""
    rows = {}
    with open(filepath, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = DATA_ROW.match(line)
            if not m:
                continue
            code, cif, account, currency = m.group(1), m.group(2).strip('`'), m.group(3), m.group(4)
            amounts = m.group(5).split()
            if len(amounts) < 1:
                continue
            key = (code, cif, account, currency)
            rows[key] = {
                'total_interest_kobo': kobo(amounts[0]),
            }
    return rows


def parse_loc(filepath: str) -> dict:
    """Parse cyc_loc_rpt."""
    rows = {}
    with open(filepath, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = DATA_ROW.match(line)
            if not m:
                continue
            code, cif, account, currency = m.group(1), m.group(2).strip('`'), m.group(3), m.group(4)
            amounts = m.group(5).split()
            if len(amounts) < 3:
                continue
            key = (code, cif, account, currency)
            rows[key] = {
                'credit_limit_kobo': kobo(amounts[0]),
                'loc_change_kobo':   kobo(amounts[1]),
                'temp_loc_kobo':     kobo(amounts[2]),
            }
    return rows


# ── File discovery ─────────────────────────────────────────────────────────────

def find_report_files(folder: str) -> dict:
    """
    Given a folder, return a dict mapping report_type -> filepath.
    Handles both flat layout (files in folder) and nested layout (files in sub-folders).
    Returns None if any required type is missing.
    """
    types = {'bal': None, 'chg': None, 'int': None, 'loc': None}
    for f in Path(folder).iterdir():
        if f.is_file():
            name = f.name.lower()
            for t in types:
                if f'cyc_{t}_rpt' in name:
                    types[t] = str(f)
    return types if all(types.values()) else None


def collect_month_folders(root: str) -> List[str]:
    """
    Collect all folders containing a complete set of 4 cycle report files.
    Checks the root itself and all immediate sub-directories.
    """
    folders = []
    root_path = Path(root)

    # Check root itself
    if find_report_files(root):
        folders.append(root)

    # Check sub-directories
    for sub in sorted(root_path.iterdir()):
        if sub.is_dir() and find_report_files(str(sub)):
            folders.append(str(sub))

    return folders


# ── Main import ────────────────────────────────────────────────────────────────

UPSERT_SQL = """
INSERT INTO card_cycle_data (
  cycle_date, product_code, cif, account_number, currency,
  billed_balance_kobo, current_balance_kobo, outstanding_balance_kobo,
  overdue_amount_kobo, minimum_payment_kobo, total_payment_kobo,
  fees_kobo, interest_charged_kobo, penalty_kobo,
  purchase_amount_kobo, cash_advance_kobo,
  total_interest_kobo,
  credit_limit_kobo, loc_change_kobo, temp_loc_kobo
) VALUES %s
ON CONFLICT (cycle_date, account_number) DO UPDATE SET
  product_code             = EXCLUDED.product_code,
  cif                      = EXCLUDED.cif,
  currency                 = EXCLUDED.currency,
  billed_balance_kobo      = EXCLUDED.billed_balance_kobo,
  current_balance_kobo     = EXCLUDED.current_balance_kobo,
  outstanding_balance_kobo = EXCLUDED.outstanding_balance_kobo,
  overdue_amount_kobo      = EXCLUDED.overdue_amount_kobo,
  minimum_payment_kobo     = EXCLUDED.minimum_payment_kobo,
  total_payment_kobo       = EXCLUDED.total_payment_kobo,
  fees_kobo                = EXCLUDED.fees_kobo,
  interest_charged_kobo    = EXCLUDED.interest_charged_kobo,
  penalty_kobo             = EXCLUDED.penalty_kobo,
  purchase_amount_kobo     = EXCLUDED.purchase_amount_kobo,
  cash_advance_kobo        = EXCLUDED.cash_advance_kobo,
  total_interest_kobo      = EXCLUDED.total_interest_kobo,
  credit_limit_kobo        = EXCLUDED.credit_limit_kobo,
  loc_change_kobo          = EXCLUDED.loc_change_kobo,
  temp_loc_kobo            = EXCLUDED.temp_loc_kobo,
  imported_at              = NOW()
"""


def import_folder(conn, folder: str) -> int:
    """Parse and upsert one month's cycle data. Returns rows upserted."""
    files = find_report_files(folder)
    if not files:
        print(f"  SKIP {folder} — missing one or more report files")
        return 0

    # Extract cycle date from bal report (most reliable)
    cycle_date = extract_cycle_date(files['bal'])
    if not cycle_date:
        print(f"  SKIP {folder} — could not extract cycle date from bal report")
        return 0

    print(f"  Parsing {folder} (cycle {cycle_date}) …", end=' ', flush=True)

    bal = parse_bal(files['bal'])
    chg = parse_chg(files['chg'])
    int_ = parse_int(files['int'])
    loc = parse_loc(files['loc'])

    # Merge all four on common key
    all_keys = set(bal) | set(chg) | set(int_) | set(loc)
    records = []
    for key in all_keys:
        code, cif, account, currency = key
        row = (
            cycle_date, code, cif, account, currency,
            bal.get(key, {}).get('billed_balance_kobo', 0),
            bal.get(key, {}).get('current_balance_kobo', 0),
            bal.get(key, {}).get('outstanding_balance_kobo', 0),
            bal.get(key, {}).get('overdue_amount_kobo', 0),
            bal.get(key, {}).get('minimum_payment_kobo', 0),
            bal.get(key, {}).get('total_payment_kobo', 0),
            chg.get(key, {}).get('fees_kobo', 0),
            chg.get(key, {}).get('interest_charged_kobo', 0),
            chg.get(key, {}).get('penalty_kobo', 0),
            chg.get(key, {}).get('purchase_amount_kobo', 0),
            chg.get(key, {}).get('cash_advance_kobo', 0),
            int_.get(key, {}).get('total_interest_kobo', 0),
            loc.get(key, {}).get('credit_limit_kobo', 0),
            loc.get(key, {}).get('loc_change_kobo', 0),
            loc.get(key, {}).get('temp_loc_kobo', 0),
        )
        records.append(row)

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(cur, UPSERT_SQL, records, page_size=500)
    conn.commit()

    print(f"{len(records):,} rows upserted")
    return len(records)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    database_url = sys.argv[1]
    reports_root = sys.argv[2]

    if not Path(reports_root).exists():
        print(f"ERROR: folder not found: {reports_root}")
        sys.exit(1)

    print(f"Connecting to database …")
    try:
        conn = psycopg2.connect(database_url)
    except Exception as e:
        print(f"ERROR: could not connect: {e}")
        sys.exit(1)

    folders = collect_month_folders(reports_root)
    if not folders:
        print(f"ERROR: no complete cycle report sets found under {reports_root}")
        conn.close()
        sys.exit(1)

    print(f"Found {len(folders)} month folder(s) to import:\n")
    total = 0
    for folder in folders:
        total += import_folder(conn, folder)

    conn.close()
    print(f"\nDone. Total rows upserted: {total:,}")


if __name__ == '__main__':
    main()
