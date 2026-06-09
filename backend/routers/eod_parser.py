"""
eod_parser.py — Parser for EODTXN (Daily Financial Card Account Transactions)

File naming: EODTXN.YYYYMMDD.HHMMSS

Format: fixed-width report with two branches (0001 Default Branch, 4009 Sales Agency)
and multiple card products per branch.
"""

import re
from datetime import date, datetime
from typing import Optional


# ── Known description strings (order matters — longer/more-specific first) ───
DESCRIPTIONS = [
    'Cash Payment Bank Reversal',
    'Cash Payment Bank',
    'Cash Advance Reversal',
    'Cash Advance',
    'Purchase Reversal',
    'Purchase',
    'Utility Payment Reversal',
    'Utility Payment',
    'Web Transfer Out Reversal',
    'Web Transfer Out',
    'Web Transfer In Reversal',
    'Web Transfer In',
    'Re-Issue Fee',
    'Joining Fee Reversal',
    'Joining Fee',
    'Account Maintenance Fee Reversal',
    'Account Maintenance Fee',
    'Membership Fee',
]

# ── Transaction code → category ───────────────────────────────────────────────
TXN_CATEGORY = {
    # Purchases
    '200': 'Purchase',              '201': 'Purchase',
    '250': 'Purchase Reversal',     '251': 'Purchase Reversal',
    # Cash Advances
    '300': 'Cash Advance',          '301': 'Cash Advance',
    '350': 'Cash Advance Reversal', '351': 'Cash Advance Reversal',
    # Utility / Bill payments
    '303': 'Utility Payment',       '353': 'Utility Payment Reversal',
    # Bank payments (cash in)
    '402': 'Bank Payment',          '452': 'Bank Payment Reversal',
    # Web / interbank transfers
    '422': 'Transfer In',           '423': 'Transfer Out',
    '472': 'Transfer In Reversal',  '473': 'Transfer Out Reversal',
    # Account fees
    '100': 'Account Fee',
    '104': 'Account Fee',           '105': 'Account Fee',
    '155': 'Account Fee Reversal',  '158': 'Account Fee Reversal',
}

# ── Canonical product names (prevents branch context corrupting product names) ─
# The EODTXN file repeats "Account Product Number : 001 (Default Branch)" inside
# each branch section. Hardcoding ensures we always use the real product name.
PRODUCT_NAMES = {
    '001': 'Amex Naira',
    '002': 'Amex USD',
    '003': 'PREP Temporary Virtual',
    '100': 'Classic Accounts',
    '105': 'Platinum Accounts',
    '110': 'Prestige Accounts',
    '120': 'BB Classic Account',
    '160': 'Business Accounts',
    '205': 'PREP',
    '405': 'Financial Inclusion Account',
}

# ── Compiled patterns ─────────────────────────────────────────────────────────
REPORT_DATE_RE = re.compile(r'Report Date\s*:\s*(\d{2}/\d{2}/\d{4})')
BRANCH_RE      = re.compile(r'BRANCH Number\s*:\s*(\w+)\s*-\s*(.+)')
PRODUCT_RE     = re.compile(r'Account Product Number\s*:\s*(\w+)\s*\((.+?)\)')
ACCOUNT_RE     = re.compile(
    r'Account No\.\s*:\s*(\S+)'
    r'\s+CIF\s*:\s*(\S+)'
    r'\s+Arrears\s*:\s*([\d,.-]+)'
    r'\s+LOC\s*:\s*([\d,.-]+)'
    r'\s+Bal\.\s*:\s*([\d,.-]+)'
    r'\s+(.*)'
)
AMOUNT_SIGN_CCY_RE = re.compile(r'([\d,]+\.\d{2})\s+(DR|CR)\s+(NGN|USD)')
TXN_CODE_DATE_RE   = re.compile(r'(\d{3})\s+(\d{2}/\d{2}/\d{4})')
IS_TXN_RE          = re.compile(r'^\s*\d+.*\b(DR|CR)\s+(NGN|USD)\b')


def _parse_amount(s: str) -> float:
    return float(s.replace(',', ''))


def _parse_date_dmy(s: str) -> date:
    return datetime.strptime(s, '%d/%m/%Y').date()


def _extract_merchant_desc(after_ccy: str) -> tuple[str, str]:
    """Split 'MERCHANT NAME     Description' into (merchant, description)."""
    text = after_ccy.lstrip()
    for desc in DESCRIPTIONS:
        idx = text.rfind(desc)
        if idx >= 0:
            merchant = text[:idx].strip()
            return merchant, desc
    # Fallback: no known description found
    return '', text.strip()


def _parse_txn_line(line: str) -> Optional[dict]:
    """Parse a single transaction line. Returns None if not a transaction."""
    if not IS_TXN_RE.match(line):
        return None

    # Find amount / sign / currency anchor
    m_asc = AMOUNT_SIGN_CCY_RE.search(line)
    if not m_asc:
        return None

    amount   = _parse_amount(m_asc.group(1))
    sign     = m_asc.group(2)
    currency = m_asc.group(3)

    # Find txn_code + date before the amount
    before_amount = line[:m_asc.start()]
    m_cd = TXN_CODE_DATE_RE.search(before_amount)
    if not m_cd:
        return None

    txn_code = m_cd.group(1)
    txn_date = _parse_date_dmy(m_cd.group(2))

    # Parse trace / auth / card from the segment before txn_code
    pre = before_amount[:m_cd.start()].strip()
    tokens = pre.split()
    trace_num = tokens[0] if tokens else ''
    auth_num  = ''
    card_num  = ''
    for tok in tokens[1:]:
        if re.match(r'^[0-9]{6}[0-9*]+[0-9]{4}$', tok):
            card_num = tok
        elif tok.isdigit() and not auth_num:
            auth_num = tok

    # Merchant ID = text between date end and amount start
    merchant_id = before_amount[m_cd.end():].strip()

    # Merchant name + description = text after currency
    merchant_name, description = _extract_merchant_desc(line[m_asc.end():])

    return {
        'trace_num':    trace_num,
        'auth_num':     auth_num,
        'card_num':     card_num,
        'txn_code':     txn_code,
        'txn_category': TXN_CATEGORY.get(txn_code, 'Other'),
        'txn_date':     txn_date,
        'merchant_id':  merchant_id,
        'amount':       amount,
        'sign':         sign,      # DR or CR
        'currency':     currency,
        'merchant_name': merchant_name,
        'description':  description,
    }


def parse_eod_file(content: str, filename: str = '') -> tuple[list[dict], date]:
    """
    Parse a full EODTXN file.

    Returns (rows, txn_date) where each row is a flat dict containing
    all transaction fields plus branch / product / account context.
    """
    rows: list[dict] = []

    # Extract date from report header (DD/MM/YYYY format)
    txn_date = date.today()
    m_date = REPORT_DATE_RE.search(content)
    if m_date:
        try:
            txn_date = _parse_date_dmy(m_date.group(1))
        except ValueError:
            pass

    # Current context
    branch_code  = ''
    branch_name  = ''
    product_code = ''
    product_name = ''
    account_no   = ''
    cif          = ''
    customer     = ''
    arrears      = 0.0
    loc          = 0.0
    balance      = 0.0

    for line in content.splitlines():
        # Branch header
        mb = BRANCH_RE.search(line)
        if mb:
            branch_code = mb.group(1).strip()
            branch_name = mb.group(2).strip()
            continue

        # Product header — use canonical name to avoid branch context corruption
        mp = PRODUCT_RE.search(line)
        if mp:
            product_code = mp.group(1).strip()
            raw_name     = mp.group(2).strip()
            product_name = PRODUCT_NAMES.get(product_code, raw_name)
            continue

        # Account header
        ma = ACCOUNT_RE.search(line)
        if ma:
            account_no = ma.group(1).strip()
            cif        = ma.group(2).strip().lstrip('0') or '0'
            arrears    = _parse_amount(ma.group(3))
            loc        = _parse_amount(ma.group(4))
            balance    = _parse_amount(ma.group(5))
            customer   = ma.group(6).strip()
            continue

        # Transaction line
        txn = _parse_txn_line(line)
        if not txn:
            continue

        rows.append({
            **txn,
            'branch_code':  branch_code,
            'branch_name':  branch_name,
            'product_code': product_code,
            'product_name': product_name,
            'account_no':   account_no,
            'cif':          cif,
            'customer':     customer,
            'arrears':      arrears,
            'loc':          loc,
            'balance':      balance,
        })

    return rows, txn_date


def eod_date_from_filename(filename: str) -> Optional[date]:
    """Extract date from filename like EODTXN.20251218.225907"""
    m = re.search(r'\.(\d{8})\.', filename)
    if m:
        s = m.group(1)
        try:
            return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        except ValueError:
            pass
    return None
