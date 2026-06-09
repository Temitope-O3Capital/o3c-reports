"""
eod.py — End-of-Day Transaction Report

POST   /api/eod/upload              upload one or more EODTXN files
GET    /api/eod/uploads             list all loaded days
DELETE /api/eod/uploads/{id}        delete a day and all its transactions
GET    /api/eod/summary             KPI totals for a day
GET    /api/eod/by-product          volume breakdown by product
GET    /api/eod/by-type             volume breakdown by transaction category
GET    /api/eod/by-branch           volume breakdown by branch
GET    /api/eod/trend               daily totals across all loaded days
GET    /api/eod/transactions        paginated transaction table
GET    /api/eod/transactions/export CSV export (respects all filters)
"""

import csv
import io
import json
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from core.database import get_db_pg as get_pg
from core.auth import require_pages
from routers.eod_parser import parse_eod_file, eod_date_from_filename

router = APIRouter()
ACCESS = require_pages(["eod"])

BULK = 500


def _bulk_insert(db, rows: list[dict], upload_id: int):
    if not rows:
        return
    cols = [
        'upload_id', 'txn_date', 'branch_code', 'branch_name',
        'product_code', 'product_name', 'account_no', 'cif', 'customer',
        'arrears', 'loc', 'balance',
        'trace_num', 'auth_num', 'card_num', 'txn_code', 'txn_category',
        'amount', 'sign', 'currency', 'merchant_id', 'merchant_name', 'description',
    ]
    for i in range(0, len(rows), BULK):
        batch = rows[i:i + BULK]
        placeholders, params = [], {}
        for j, r in enumerate(batch):
            ph = ', '.join(f':{c}_{j}' for c in cols)
            placeholders.append(f'({ph})')
            params[f'upload_id_{j}']     = upload_id
            params[f'txn_date_{j}']      = r['txn_date']
            params[f'branch_code_{j}']   = r['branch_code']
            params[f'branch_name_{j}']   = r['branch_name']
            params[f'product_code_{j}']  = r['product_code']
            params[f'product_name_{j}']  = r['product_name']
            params[f'account_no_{j}']    = r['account_no']
            params[f'cif_{j}']           = r['cif']
            params[f'customer_{j}']      = r['customer']
            params[f'arrears_{j}']       = r['arrears']
            params[f'loc_{j}']           = r['loc']
            params[f'balance_{j}']       = r['balance']
            params[f'trace_num_{j}']     = r['trace_num']
            params[f'auth_num_{j}']      = r['auth_num']
            params[f'card_num_{j}']      = r['card_num']
            params[f'txn_code_{j}']      = r['txn_code']
            params[f'txn_category_{j}']  = r['txn_category']
            params[f'amount_{j}']        = r['amount']
            params[f'sign_{j}']          = r['sign']
            params[f'currency_{j}']      = r['currency']
            params[f'merchant_id_{j}']   = r['merchant_id']
            params[f'merchant_name_{j}'] = r['merchant_name']
            params[f'description_{j}']   = r['description']

        col_str = ', '.join(cols)
        sql = f'INSERT INTO eod_transactions ({col_str}) VALUES {", ".join(placeholders)}'
        db.execute(text(sql), params)


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post('/upload')
async def upload_eod(
    files: list[UploadFile] = File(...),
    db    = Depends(get_pg),
    user  = Depends(ACCESS),
):
    if not files:
        raise HTTPException(400, 'No files provided')

    results = []

    for f in files:
        raw     = await f.read()
        content = raw.decode('utf-8', errors='replace')
        fname   = f.filename or ''

        # Only accept EODTXN files
        if 'EODTXN' not in fname.upper() and not fname.upper().startswith('EODTXN'):
            continue

        rows, txn_date = parse_eod_file(content, fname)

        # Use filename date if parser returned today as fallback
        fname_date = eod_date_from_filename(fname)
        if fname_date and fname_date != date.today():
            txn_date = fname_date

        if not rows:
            continue

        label = txn_date.strftime('%d %b %Y')

        # Upsert upload record
        existing = db.execute(
            text('SELECT id FROM eod_uploads WHERE txn_date = :d'),
            {'d': txn_date}
        ).fetchone()

        if existing:
            upload_id = existing.id
            db.execute(text('DELETE FROM eod_transactions WHERE upload_id = :id'), {'id': upload_id})
            db.execute(
                text('UPDATE eod_uploads SET filename=:fn, txn_count=:tc, uploaded_at=NOW(), uploaded_by=:u WHERE id=:id'),
                {'fn': fname, 'tc': len(rows), 'u': user.get('id'), 'id': upload_id}
            )
        else:
            row = db.execute(text("""
                INSERT INTO eod_uploads (txn_date, filename, txn_count, uploaded_by)
                VALUES (:d, :fn, :tc, :u)
                RETURNING id
            """), {'d': txn_date, 'fn': fname, 'tc': len(rows), 'u': user.get('id')}).fetchone()
            upload_id = row.id

        _bulk_insert(db, rows, upload_id)
        db.commit()

        # Audit log
        try:
            dr  = sum(r['amount'] for r in rows if r['sign'] == 'DR')
            cr  = sum(r['amount'] for r in rows if r['sign'] == 'CR')
            db.execute(text("""
                INSERT INTO upload_audit_log
                    (uploaded_by, report_type, file_names, cycle_label, row_counts, status)
                VALUES (:uid, 'eod', :fn, :label, :counts, 'success')
            """), {
                'uid': user.get('id'), 'fn': fname, 'label': label,
                'counts': json.dumps({'transactions': len(rows), 'dr': round(dr, 2), 'cr': round(cr, 2)}),
            })
            db.commit()
        except Exception:
            pass

        results.append({'date': str(txn_date), 'label': label, 'txn_count': len(rows), 'upload_id': upload_id})

    if not results:
        raise HTTPException(422, 'No valid EODTXN files found. Filename must contain "EODTXN".')

    return results


# ── Uploads list ──────────────────────────────────────────────────────────────

@router.get('/uploads')
def list_uploads(db=Depends(get_pg), _=Depends(ACCESS)):
    rows = db.execute(text("""
        SELECT u.id, u.txn_date, u.filename, u.txn_count, u.uploaded_at,
               usr.full_name AS uploaded_by_name
        FROM eod_uploads u
        LEFT JOIN o3c_users usr ON usr.id = u.uploaded_by
        ORDER BY u.txn_date DESC
    """)).fetchall()
    return [dict(r._mapping) for r in rows]


@router.delete('/uploads/{upload_id}', status_code=204)
def delete_upload(upload_id: int, db=Depends(get_pg), _=Depends(ACCESS)):
    db.execute(text('DELETE FROM eod_uploads WHERE id = :id'), {'id': upload_id})
    db.commit()


# ── Shared filter helper ──────────────────────────────────────────────────────

def _build_where(upload_id: int, branch: str, product: str,
                 txn_type: str, sign: str, q: str) -> tuple[str, dict]:
    filters = ['upload_id = :uid']
    params  = {'uid': upload_id}
    if branch:   filters.append('branch_code = :branch');   params['branch']   = branch
    if product:  filters.append('product_code = :product'); params['product']  = product
    if txn_type: filters.append('txn_category = :ttype');   params['ttype']    = txn_type
    if sign:     filters.append('sign = :sign');             params['sign']     = sign
    if q:
        filters.append(
            '(cif ILIKE :q OR customer ILIKE :q OR account_no ILIKE :q '
            'OR merchant_name ILIKE :q OR trace_num = :qtrace)'
        )
        params['q']      = f'%{q}%'
        params['qtrace'] = q.strip()
    return ' AND '.join(filters), params


# ── Summary KPIs ──────────────────────────────────────────────────────────────

@router.get('/summary')
def summary(
    upload_id: int           = Query(...),
    branch:    Optional[str] = Query(None),
    product:   Optional[str] = Query(None),
    txn_type:  Optional[str] = Query(None),
    sign:      Optional[str] = Query(None),
    q:         Optional[str] = Query(None),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    where, params = _build_where(upload_id, branch, product, txn_type, sign, q)

    row = db.execute(text(f"""
        SELECT
            COUNT(*)                                           AS txn_count,
            COUNT(DISTINCT account_no)                        AS active_accounts,
            COUNT(DISTINCT cif)                               AS active_cifs,
            COALESCE(SUM(CASE WHEN sign='DR' THEN amount END),0) AS total_dr,
            COALESCE(SUM(CASE WHEN sign='CR' THEN amount END),0) AS total_cr,
            COALESCE(SUM(amount), 0)                          AS total_volume,
            COALESCE(AVG(amount), 0)                          AS avg_txn_value
        FROM eod_transactions
        WHERE {where}
    """), params).fetchone()

    d = dict(row._mapping)
    d['net_movement'] = float(d['total_cr']) - float(d['total_dr'])

    # Available filter options
    branches = [r[0] for r in db.execute(text(
        f'SELECT DISTINCT branch_code FROM eod_transactions WHERE {where} ORDER BY 1'
    ), params).fetchall()]
    products = [r[0] for r in db.execute(text(
        f'SELECT DISTINCT product_code FROM eod_transactions WHERE {where} ORDER BY 1'
    ), params).fetchall()]
    branch_names = dict(db.execute(text(
        f'SELECT DISTINCT branch_code, branch_name FROM eod_transactions WHERE {where}'
    ), params).fetchall())
    product_names = dict(db.execute(text(
        f'SELECT DISTINCT product_code, product_name FROM eod_transactions WHERE {where}'
    ), params).fetchall())

    d['branches']      = [{'code': b, 'name': branch_names.get(b, b)} for b in branches]
    d['products']      = [{'code': p, 'name': product_names.get(p, p)} for p in products]
    return d


# ── By-product breakdown ──────────────────────────────────────────────────────

@router.get('/by-product')
def by_product(
    upload_id: int           = Query(...),
    branch:    Optional[str] = Query(None),
    sign:      Optional[str] = Query(None),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    where, params = _build_where(upload_id, branch, '', '', sign, '')
    rows = db.execute(text(f"""
        SELECT
            product_code, product_name,
            COUNT(*)                                              AS txn_count,
            COALESCE(SUM(CASE WHEN sign='DR' THEN amount END),0) AS total_dr,
            COALESCE(SUM(CASE WHEN sign='CR' THEN amount END),0) AS total_cr,
            COALESCE(SUM(amount),0)                              AS total_volume
        FROM eod_transactions
        WHERE {where}
        GROUP BY product_code, product_name
        ORDER BY total_volume DESC
    """), params).fetchall()
    return [dict(r._mapping) for r in rows]


# ── By-type breakdown ─────────────────────────────────────────────────────────

@router.get('/by-type')
def by_type(
    upload_id: int           = Query(...),
    branch:    Optional[str] = Query(None),
    product:   Optional[str] = Query(None),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    where, params = _build_where(upload_id, branch, product, '', '', '')
    rows = db.execute(text(f"""
        SELECT
            txn_category,
            COUNT(*)                                              AS txn_count,
            COALESCE(SUM(CASE WHEN sign='DR' THEN amount END),0) AS total_dr,
            COALESCE(SUM(CASE WHEN sign='CR' THEN amount END),0) AS total_cr,
            COALESCE(SUM(amount),0)                              AS total_volume
        FROM eod_transactions
        WHERE {where}
        GROUP BY txn_category
        ORDER BY total_volume DESC
    """), params).fetchall()
    return [dict(r._mapping) for r in rows]


# ── By-branch breakdown ───────────────────────────────────────────────────────

@router.get('/by-branch')
def by_branch(
    upload_id: int           = Query(...),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    rows = db.execute(text("""
        SELECT
            branch_code, branch_name,
            COUNT(*)                                              AS txn_count,
            COUNT(DISTINCT account_no)                           AS accounts,
            COALESCE(SUM(CASE WHEN sign='DR' THEN amount END),0) AS total_dr,
            COALESCE(SUM(CASE WHEN sign='CR' THEN amount END),0) AS total_cr
        FROM eod_transactions
        WHERE upload_id = :uid
        GROUP BY branch_code, branch_name
        ORDER BY total_dr DESC
    """), {'uid': upload_id}).fetchall()
    return [dict(r._mapping) for r in rows]


# ── Trend (all loaded days) ───────────────────────────────────────────────────

@router.get('/trend')
def trend(db=Depends(get_pg), _=Depends(ACCESS)):
    rows = db.execute(text("""
        SELECT
            u.txn_date,
            TO_CHAR(u.txn_date, 'DD Mon') AS label,
            COUNT(t.id)                                              AS txn_count,
            COALESCE(SUM(CASE WHEN t.sign='DR' THEN t.amount END),0) AS total_dr,
            COALESCE(SUM(CASE WHEN t.sign='CR' THEN t.amount END),0) AS total_cr,
            COALESCE(SUM(t.amount),0)                                AS total_volume
        FROM eod_uploads u
        LEFT JOIN eod_transactions t ON t.upload_id = u.id
        GROUP BY u.txn_date
        ORDER BY u.txn_date
    """)).fetchall()
    return [dict(r._mapping) for r in rows]


# ── Transaction table ─────────────────────────────────────────────────────────

@router.get('/transactions')
def transactions(
    upload_id: int           = Query(...),
    branch:    Optional[str] = Query(None),
    product:   Optional[str] = Query(None),
    txn_type:  Optional[str] = Query(None),
    sign:      Optional[str] = Query(None),
    q:         Optional[str] = Query(None),
    limit:     int           = Query(200, le=2000),
    offset:    int           = Query(0),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    where, params = _build_where(upload_id, branch, product, txn_type, sign, q)
    params['limit']  = limit
    params['offset'] = offset

    rows = db.execute(text(f"""
        SELECT
            id, txn_date, branch_code, branch_name,
            product_code, product_name,
            account_no, cif, customer, balance, arrears, loc,
            trace_num, auth_num, card_num,
            txn_code, txn_category, amount, sign, currency,
            merchant_id, merchant_name, description
        FROM eod_transactions
        WHERE {where}
        ORDER BY amount DESC, id
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    total = db.execute(
        text(f'SELECT COUNT(*) FROM eod_transactions WHERE {where}'), params
    ).scalar() or 0

    return {'data': [dict(r._mapping) for r in rows], 'total': total}


# ── CSV Export ────────────────────────────────────────────────────────────────

@router.get('/transactions/export')
def export_csv(
    upload_id: int           = Query(...),
    branch:    Optional[str] = Query(None),
    product:   Optional[str] = Query(None),
    txn_type:  Optional[str] = Query(None),
    sign:      Optional[str] = Query(None),
    q:         Optional[str] = Query(None),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    where, params = _build_where(upload_id, branch, product, txn_type, sign, q)

    rows = db.execute(text(f"""
        SELECT txn_date, branch_name, product_name, account_no, cif, customer,
               trace_num, auth_num, card_num, txn_code, txn_category,
               amount, sign, currency, merchant_name, description, balance, arrears
        FROM eod_transactions
        WHERE {where}
        ORDER BY amount DESC
    """), params).fetchall()

    up = db.execute(
        text('SELECT txn_date FROM eod_uploads WHERE id = :id'), {'id': upload_id}
    ).fetchone()
    label = up.txn_date.strftime('%Y-%m-%d') if up else str(upload_id)

    buf = io.StringIO()
    w   = csv.writer(buf)
    w.writerow([
        'Date', 'Branch', 'Product', 'Account No', 'CIF', 'Customer',
        'Trace #', 'Auth #', 'Card', 'Txn Code', 'Category',
        'Amount', 'DR/CR', 'Currency', 'Merchant', 'Description', 'Balance', 'Arrears'
    ])
    for r in rows:
        m = dict(r._mapping)
        w.writerow([
            m['txn_date'], m['branch_name'], m['product_name'],
            m['account_no'], m['cif'], m['customer'],
            m['trace_num'], m['auth_num'], m['card_num'],
            m['txn_code'], m['txn_category'],
            m['amount'], m['sign'], m['currency'],
            m['merchant_name'], m['description'],
            m['balance'], m['arrears'],
        ])

    buf.seek(0)
    return StreamingResponse(
        io.BytesIO(buf.getvalue().encode()),
        media_type='text/csv',
        headers={'Content-Disposition': f'attachment; filename="eod_{label}.csv"'}
    )
