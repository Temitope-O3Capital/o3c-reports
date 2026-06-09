"""
income_parser.py — Parsers for O3C cycle report files

File types detected by name prefix:
  cyc_int_rpt.*   → interest per account
  cyc_chg_rpt.*   → fees/interest/penalty/purchase/cash_advance
  cyc_bal_rpt.*   → outstanding balances / overdue / min payment
  cyc_loc_rpt.*   → lines of credit
  cust_file.*     → customer master (CSV, no header)
"""

import re
import csv
import io
from datetime import date
from typing import Optional

# ── Patterns ─────────────────────────────────────────────────────────────────
PRODUCT_RE = re.compile(r'Account Product \[(\d+)\]\s*:\s*(.+)')
# Leading spaces are optional — data lines start at column 0 in these reports
DATA_RE     = re.compile(r'^\s*(\d{1,6})\s+(\d{4,})\s+(\d{6,})\s+(NGN|USD)\s+(.+)$')


def _nums(tail: str) -> list[float]:
    """Extract all numeric values from the tail of a data line."""
    return [float(x.replace(',', '')) for x in re.findall(r'-?[\d,]+\.?\d*', tail)]


def _cycle_date_from_name(filename: str) -> Optional[date]:
    """Extract date from filename like cyc_int_rpt.20260514.234258"""
    m = re.search(r'\.(\d{8})\.', filename)
    if m:
        s = m.group(1)
        try:
            return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        except ValueError:
            pass
    return date.today()


def detect_file_type(filename: str) -> str:
    name = filename.lower()
    if 'cyc_int'  in name: return 'interest'
    if 'cyc_chg'  in name: return 'charges'
    if 'cyc_bal'  in name: return 'balances'
    if 'cyc_loc'  in name: return 'loc'
    if 'cust_file' in name: return 'customers'
    return 'unknown'


# ── Fixed-width cycle report parser ──────────────────────────────────────────

def parse_cycle_report(content: str, file_type: str) -> tuple[list[dict], date]:
    """
    Parse a fixed-width cycle report. Returns (rows, cycle_date).
    cycle_date is embedded in the report header.
    """
    rows         = []
    product_code = None
    product_name = None
    cycle_date   = date.today()

    # Extract cycle date from report header line — reports use DDMMYYYY format
    header_date_m = re.search(r'Report Date\s*:\s*(\d{8})', content)
    if header_date_m:
        s = header_date_m.group(1)
        for y, m, d in [
            (int(s[4:8]), int(s[2:4]), int(s[:2])),   # DDMMYYYY (actual format)
            (int(s[:4]),  int(s[4:6]), int(s[6:8])),   # YYYYMMDD (fallback)
        ]:
            try:
                cycle_date = date(y, m, d)
                break
            except ValueError:
                pass

    for line in content.splitlines():
        # Detect product section
        pm = PRODUCT_RE.search(line)
        if pm:
            product_code = pm.group(1).strip()
            product_name = pm.group(2).strip()
            continue

        # Detect data line
        dm = DATA_RE.match(line)
        if not dm:
            continue

        apnum    = dm.group(1)
        cif      = dm.group(2).strip().lstrip('0') or '0'
        cif_pad  = dm.group(2).strip()        # keep zero-padded original
        account  = dm.group(3).strip()
        currency = dm.group(4)
        nums     = _nums(dm.group(5))

        base = {
            "apnum":        apnum,
            "cif":          cif_pad,           # zero-padded e.g. 00000123
            "account":      account,
            "currency":     currency,
            "product_code": product_code,
            "product_name": product_name,
        }

        if file_type == 'interest':
            row = {**base, "interest": nums[0] if nums else 0}

        elif file_type == 'charges':
            row = {
                **base,
                "fees":         nums[0] if len(nums) > 0 else 0,
                "interest":     nums[1] if len(nums) > 1 else 0,
                "penalty":      nums[2] if len(nums) > 2 else 0,
                "purchase":     nums[3] if len(nums) > 3 else 0,
                "cash_advance": nums[4] if len(nums) > 4 else 0,
            }

        elif file_type == 'balances':
            # Skip the overflowing Total Pymt column (index 5)
            row = {
                **base,
                "billed_bal":     nums[0] if len(nums) > 0 else 0,
                "current_bal":    nums[1] if len(nums) > 1 else 0,
                "outstanding_bal": nums[2] if len(nums) > 2 else 0,
                "overdue":        nums[3] if len(nums) > 3 else 0,
                "min_payment":    nums[4] if len(nums) > 4 else 0,
            }

        elif file_type == 'loc':
            row = {
                **base,
                "current_loc": nums[0] if len(nums) > 0 else 0,
                "loc_change":  nums[1] if len(nums) > 1 else 0,
                "temp_loc":    nums[2] if len(nums) > 2 else 0,
            }
        else:
            continue

        rows.append(row)

    return rows, cycle_date


# ── Customer file parser ──────────────────────────────────────────────────────
# Format (no header): FIRSTNAME,LASTNAME,ADDR1,ADDR2,ADDR3,COUNTRY,PHONE,EMAIL,STATE,CITY,MOBILE,CIF

def parse_customer_file(content: str) -> list[dict]:
    rows = []
    reader = csv.reader(io.StringIO(content))
    for parts in reader:
        if len(parts) < 12:
            continue
        cif = parts[11].strip()
        if not cif or not re.match(r'^\d+$', cif):
            continue
        rows.append({
            "cif":        cif,
            "first_name": parts[0].strip().title(),
            "last_name":  parts[1].strip().title(),
            "address":    ', '.join(p.strip() for p in parts[2:5] if p.strip()),
            "country":    parts[5].strip(),
            "phone":      parts[6].strip(),
            "email":      parts[7].strip().lower(),
            "state":      parts[8].strip().title(),
            "city":       parts[9].strip().title(),
            "mobile":     parts[10].strip(),
        })
    return rows


# ── Summary statistics ────────────────────────────────────────────────────────

def product_totals(rows: list[dict], value_key: str) -> dict[str, float]:
    """Aggregate a value by product_name."""
    totals: dict[str, float] = {}
    for r in rows:
        prod = r.get("product_name") or "Unknown"
        totals[prod] = totals.get(prod, 0) + float(r.get(value_key, 0) or 0)
    return totals
