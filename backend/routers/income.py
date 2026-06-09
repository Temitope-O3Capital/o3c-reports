"""
income.py — Income Report module

Endpoints:
  POST /api/income/upload            upload cycle files (multi-file)
  GET  /api/income/cycles            list all loaded cycles
  DELETE /api/income/cycles/{id}     delete a cycle and all its data
  GET  /api/income/summary           KPI totals for a cycle
  GET  /api/income/by-product        interest + charges grouped by product
  GET  /api/income/accounts          joined account table with filters
  GET  /api/income/accounts/export   same table as CSV stream
"""

import csv
import io
from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from core.database import get_db_pg as get_pg
from core.auth import require_pages
from routers.income_parser import (
    detect_file_type, parse_cycle_report, parse_customer_file, _cycle_date_from_name
)

router = APIRouter()
ACCESS = require_pages(["income"])

BULK = 500   # rows per INSERT batch


def _bulk_insert(db, table: str, cols: list[str], rows: list[dict], cycle_id: int):
    if not rows:
        return
    extra = {"cycle_id": cycle_id}
    all_cols = ["cycle_id"] + cols
    for i in range(0, len(rows), BULK):
        batch = rows[i:i + BULK]
        placeholders = []
        params = {}
        for j, r in enumerate(batch):
            ph = ", ".join(f":{c}_{j}" for c in all_cols)
            placeholders.append(f"({ph})")
            params[f"cycle_id_{j}"] = cycle_id
            for c in cols:
                params[f"{c}_{j}"] = r.get(c)
        col_str = ", ".join(all_cols)
        sql = f'INSERT INTO {table} ({col_str}) VALUES {", ".join(placeholders)}'
        db.execute(text(sql), params)


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_cycle(
    files:        list[UploadFile] = File(...),
    cycle_label:  str              = Form(""),
    db            = Depends(get_pg),
    user          = Depends(ACCESS),
):
    if not files:
        raise HTTPException(400, "No files provided")

    parsed       = {}      # file_type → (rows, cycle_date)
    detected_date = None

    for f in files:
        raw     = await f.read()
        content = raw.decode("utf-8", errors="replace")
        ftype   = detect_file_type(f.filename or "")

        if ftype == "unknown":
            continue

        if ftype == "customers":
            rows = parse_customer_file(content)
            parsed["customers"] = (rows, date.today())
        else:
            rows, cdate = parse_cycle_report(content, ftype)
            parsed[ftype] = (rows, cdate)
            if cdate:
                detected_date = cdate

    if not parsed:
        raise HTTPException(422, "No recognised cycle files found. "
                            "Expected filenames containing: cyc_int_rpt, cyc_chg_rpt, cyc_bal_rpt, cyc_loc_rpt, cust_file")

    cycle_date = detected_date or date.today()
    label      = cycle_label.strip() or cycle_date.strftime("%B %Y")

    # Upsert cycle record
    existing = db.execute(
        text("SELECT id FROM income_cycles WHERE cycle_date = :d"),
        {"d": cycle_date}
    ).fetchone()

    if existing:
        # Replace: delete old data, keep cycle row, update label
        cycle_id = existing.id
        for tbl in ("income_customers","income_interest","income_charges","income_balances","income_loc"):
            db.execute(text(f"DELETE FROM {tbl} WHERE cycle_id = :id"), {"id": cycle_id})
        db.execute(text("UPDATE income_cycles SET label=:l, loaded_at=NOW(), loaded_by=:u WHERE id=:id"),
                   {"l": label, "u": user.get("id"), "id": cycle_id})
    else:
        row = db.execute(
            text("INSERT INTO income_cycles (cycle_date, label, loaded_by) VALUES (:d,:l,:u) RETURNING id"),
            {"d": cycle_date, "l": label, "u": user.get("id")}
        ).fetchone()
        cycle_id = row.id

    # Insert parsed data
    if "customers" in parsed:
        rows, _ = parsed["customers"]
        _bulk_insert(db, "income_customers",
                     ["cif","first_name","last_name","address","state","city","phone","email","mobile"],
                     rows, cycle_id)

    if "interest" in parsed:
        rows, _ = parsed["interest"]
        _bulk_insert(db, "income_interest",
                     ["apnum","cif","account","currency","product_code","product_name","interest"],
                     rows, cycle_id)

    if "charges" in parsed:
        rows, _ = parsed["charges"]
        _bulk_insert(db, "income_charges",
                     ["apnum","cif","account","currency","product_code","product_name",
                      "fees","interest","penalty","purchase","cash_advance"],
                     rows, cycle_id)

    if "balances" in parsed:
        rows, _ = parsed["balances"]
        _bulk_insert(db, "income_balances",
                     ["apnum","cif","account","currency","product_code","product_name",
                      "billed_bal","current_bal","outstanding_bal","overdue","min_payment"],
                     rows, cycle_id)

    if "loc" in parsed:
        rows, _ = parsed["loc"]
        _bulk_insert(db, "income_loc",
                     ["apnum","cif","account","currency","product_code","product_name",
                      "current_loc","loc_change","temp_loc"],
                     rows, cycle_id)

    db.commit()

    counts = {k: len(v[0]) for k, v in parsed.items()}
    return {"cycle_id": cycle_id, "cycle_date": str(cycle_date), "label": label, "loaded": counts}


# ── Cycles list ───────────────────────────────────────────────────────────────

@router.get("/cycles")
def list_cycles(db=Depends(get_pg), _=Depends(ACCESS)):
    rows = db.execute(text("""
        SELECT c.id, c.cycle_date, c.label, c.loaded_at,
               u.full_name AS loaded_by_name,
               (SELECT COUNT(*) FROM income_interest WHERE cycle_id=c.id) AS interest_rows,
               (SELECT COUNT(*) FROM income_charges  WHERE cycle_id=c.id) AS charge_rows
        FROM income_cycles c
        LEFT JOIN o3c_users u ON u.id = c.loaded_by
        ORDER BY c.cycle_date DESC
    """)).fetchall()
    return [dict(r._mapping) for r in rows]


@router.delete("/cycles/{cycle_id}", status_code=204)
def delete_cycle(cycle_id: int, db=Depends(get_pg), _=Depends(ACCESS)):
    db.execute(text("DELETE FROM income_cycles WHERE id = :id"), {"id": cycle_id})
    db.commit()


# ── Shared filtered query ─────────────────────────────────────────────────────

def _account_query(cycle_id: int, product: str, currency: str,
                   has_overdue: bool, has_interest: bool, q: str) -> tuple[str, dict]:
    filters = ["ii.cycle_id = :cycle_id"]
    params  = {"cycle_id": cycle_id}

    if product:
        filters.append("ii.product_name = :product")
        params["product"] = product
    if currency:
        filters.append("ii.currency = :currency")
        params["currency"] = currency
    if has_overdue:
        filters.append("COALESCE(ib.overdue, 0) > 0")
    if has_interest:
        filters.append("COALESCE(ii.interest, 0) > 0")
    if q:
        filters.append("(ii.cif ILIKE :q OR ic.first_name ILIKE :q OR ic.last_name ILIKE :q "
                       "OR a.\"First Name\" ILIKE :q OR a.\"Last Name\" ILIKE :q)")
        params["q"] = f"%{q}%"

    where = " AND ".join(filters)
    sql = f"""
        SELECT
            ii.cif,
            COALESCE(a."First Name", ic.first_name, '')   AS first_name,
            COALESCE(a."Last Name",  ic.last_name,  '')   AS last_name,
            ii.account,
            ii.product_code,
            ii.product_name,
            ii.currency,
            COALESCE(ii.interest,           0) AS interest,
            COALESCE(ich.fees,              0) AS fees,
            COALESCE(ich.interest,          0) AS charge_interest,
            COALESCE(ich.penalty,           0) AS penalty,
            COALESCE(ich.purchase,          0) AS purchase,
            COALESCE(ich.cash_advance,      0) AS cash_advance,
            COALESCE(ib.billed_bal,         0) AS billed_bal,
            COALESCE(ib.current_bal,        0) AS current_bal,
            COALESCE(ib.outstanding_bal,    0) AS outstanding_bal,
            COALESCE(ib.overdue,            0) AS overdue,
            COALESCE(ib.min_payment,        0) AS min_payment,
            COALESCE(il.current_loc,        0) AS current_loc,
            COALESCE(il.loc_change,         0) AS loc_change
        FROM income_interest ii
        LEFT JOIN income_charges  ich ON ich.cif=ii.cif AND ich.cycle_id=ii.cycle_id AND ich.account=ii.account
        LEFT JOIN income_balances ib  ON ib.cif =ii.cif AND ib.cycle_id =ii.cycle_id AND ib.account =ii.account
        LEFT JOIN income_loc      il  ON il.cif =ii.cif AND il.cycle_id =ii.cycle_id AND il.account =ii.account
        LEFT JOIN income_customers ic ON ic.cif =ii.cif AND ic.cycle_id =ii.cycle_id
        LEFT JOIN "Accounts"       a  ON a."CIF Number" = ii.cif
        WHERE {where}
    """
    return sql, params


# ── KPI Summary ───────────────────────────────────────────────────────────────

@router.get("/summary")
def income_summary(
    cycle_id: int           = Query(...),
    product:  Optional[str] = Query(None),
    currency: Optional[str] = Query(None),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    filters  = ["cycle_id = :cid"]
    params   = {"cid": cycle_id}
    if product:  filters.append("product_name = :product"); params["product"] = product
    if currency: filters.append("currency = :currency");    params["currency"] = currency
    w = " AND ".join(filters)

    def s(tbl, col):
        return db.execute(text(f'SELECT COALESCE(SUM("{col}"),0) AS v FROM {tbl} WHERE {w}'), params).scalar() or 0

    interest   = float(db.execute(text(f'SELECT COALESCE(SUM(interest),0) AS v FROM income_interest WHERE {w}'), params).scalar() or 0)
    fees       = float(db.execute(text(f'SELECT COALESCE(SUM(fees),0) AS v FROM income_charges WHERE {w}'), params).scalar() or 0)
    c_interest = float(db.execute(text(f'SELECT COALESCE(SUM(interest),0) AS v FROM income_charges WHERE {w}'), params).scalar() or 0)
    penalty    = float(db.execute(text(f'SELECT COALESCE(SUM(penalty),0) AS v FROM income_charges WHERE {w}'), params).scalar() or 0)
    purchase   = float(db.execute(text(f'SELECT COALESCE(SUM(purchase),0) AS v FROM income_charges WHERE {w}'), params).scalar() or 0)
    cash_adv   = float(db.execute(text(f'SELECT COALESCE(SUM(cash_advance),0) AS v FROM income_charges WHERE {w}'), params).scalar() or 0)
    outstanding= float(db.execute(text(f'SELECT COALESCE(SUM(outstanding_bal),0) AS v FROM income_balances WHERE {w}'), params).scalar() or 0)
    overdue    = float(db.execute(text(f'SELECT COALESCE(SUM(overdue),0) AS v FROM income_balances WHERE {w}'), params).scalar() or 0)
    loc_total  = float(db.execute(text(f'SELECT COALESCE(SUM(current_loc),0) AS v FROM income_loc WHERE {w}'), params).scalar() or 0)

    overdue_accts = int(db.execute(text(f'SELECT COUNT(*) FROM income_balances WHERE {w} AND overdue > 0'), params).scalar() or 0)
    total_accts   = int(db.execute(text(f'SELECT COUNT(*) FROM income_interest WHERE {w}'), params).scalar() or 0)
    products_list = [r[0] for r in db.execute(text(f'SELECT DISTINCT product_name FROM income_interest WHERE {w} ORDER BY 1'), params).fetchall()]

    return {
        "interest":       interest,
        "fees":           fees,
        "charge_interest": c_interest,
        "penalty":        penalty,
        "purchase":       purchase,
        "cash_advance":   cash_adv,
        "total_charges":  fees + c_interest + penalty + purchase + cash_adv,
        "outstanding_bal": outstanding,
        "overdue":        overdue,
        "overdue_accounts": overdue_accts,
        "total_accounts": total_accts,
        "loc_total":      loc_total,
        "loc_utilisation": round((outstanding / loc_total * 100), 1) if loc_total > 0 else 0,
        "products":       products_list,
    }


# ── Product breakdown ─────────────────────────────────────────────────────────

@router.get("/by-product")
def by_product(
    cycle_id: int           = Query(...),
    currency: Optional[str] = Query(None),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    filters = ["ii.cycle_id = :cid"]
    params  = {"cid": cycle_id}
    if currency: filters.append("ii.currency = :currency"); params["currency"] = currency
    w = " AND ".join(filters)

    rows = db.execute(text(f"""
        SELECT
            ii.product_name,
            ii.product_code,
            COUNT(DISTINCT ii.cif)              AS accounts,
            COALESCE(SUM(ii.interest),      0)  AS interest,
            COALESCE(SUM(ich.fees),         0)  AS fees,
            COALESCE(SUM(ich.cash_advance), 0)  AS cash_advance,
            COALESCE(SUM(ich.purchase),     0)  AS purchase,
            COALESCE(SUM(ib.outstanding_bal),0) AS outstanding_bal,
            COALESCE(SUM(ib.overdue),       0)  AS overdue,
            COALESCE(SUM(il.current_loc),   0)  AS current_loc
        FROM income_interest ii
        LEFT JOIN income_charges  ich ON ich.cif=ii.cif AND ich.cycle_id=ii.cycle_id AND ich.account=ii.account
        LEFT JOIN income_balances ib  ON ib.cif =ii.cif AND ib.cycle_id =ii.cycle_id AND ib.account =ii.account
        LEFT JOIN income_loc      il  ON il.cif =ii.cif AND il.cycle_id =ii.cycle_id AND il.account =ii.account
        WHERE {w}
        GROUP BY ii.product_name, ii.product_code
        ORDER BY interest DESC NULLS LAST
    """), params).fetchall()
    return [dict(r._mapping) for r in rows]


# ── Account table ─────────────────────────────────────────────────────────────

@router.get("/accounts")
def accounts(
    cycle_id:     int           = Query(...),
    product:      Optional[str] = Query(None),
    currency:     Optional[str] = Query(None),
    has_overdue:  bool          = Query(False),
    has_interest: bool          = Query(False),
    q:            Optional[str] = Query(None),
    limit:        int           = Query(200, le=2000),
    offset:       int           = Query(0),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    sql, params = _account_query(cycle_id, product, currency, has_overdue, has_interest, q)
    params["limit"]  = limit
    params["offset"] = offset

    rows  = db.execute(text(sql + " ORDER BY interest DESC NULLS LAST LIMIT :limit OFFSET :offset"), params).fetchall()
    total = db.execute(text(f"SELECT COUNT(*) FROM ({sql}) sub"), params).scalar() or 0
    return {"data": [dict(r._mapping) for r in rows], "total": total}


# ── CSV Export ────────────────────────────────────────────────────────────────

@router.get("/accounts/export")
def export_csv(
    cycle_id:     int           = Query(...),
    product:      Optional[str] = Query(None),
    currency:     Optional[str] = Query(None),
    has_overdue:  bool          = Query(False),
    has_interest: bool          = Query(False),
    q:            Optional[str] = Query(None),
    db = Depends(get_pg), _ = Depends(ACCESS),
):
    sql, params = _account_query(cycle_id, product, currency, has_overdue, has_interest, q)
    rows = db.execute(text(sql + " ORDER BY interest DESC NULLS LAST"), params).fetchall()

    # Get cycle label for filename
    cyc = db.execute(text("SELECT label FROM income_cycles WHERE id=:id"), {"id": cycle_id}).fetchone()
    label = (cyc.label if cyc else "income").replace(" ", "_")

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "CIF", "First Name", "Last Name", "Account", "Product Code", "Product",
        "Currency", "Interest", "Fees", "Charge Interest", "Penalty",
        "Purchase", "Cash Advance", "Billed Balance", "Current Balance",
        "Outstanding Balance", "Overdue", "Min Payment", "Current LOC", "LOC Change"
    ])
    for r in rows:
        m = dict(r._mapping)
        writer.writerow([
            m["cif"], m["first_name"], m["last_name"], m["account"],
            m["product_code"], m["product_name"], m["currency"],
            m["interest"], m["fees"], m["charge_interest"], m["penalty"],
            m["purchase"], m["cash_advance"], m["billed_bal"], m["current_bal"],
            m["outstanding_bal"], m["overdue"], m["min_payment"],
            m["current_loc"], m["loc_change"],
        ])

    buf.seek(0)
    return StreamingResponse(
        io.BytesIO(buf.getvalue().encode()),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="income_{label}.csv"'}
    )


# ── Trend (month-over-month across loaded cycles) ─────────────────────────────

@router.get("/trend")
def income_trend(db=Depends(get_pg), _=Depends(ACCESS)):
    rows = db.execute(text("""
        SELECT
            c.label,
            c.cycle_date,
            COALESCE(SUM(i.interest),          0) AS interest,
            COALESCE(SUM(ch.fees),              0) AS fees,
            COALESCE(SUM(ch.cash_advance),      0) AS cash_advance,
            COALESCE(SUM(b.outstanding_bal),    0) AS outstanding_bal,
            COALESCE(SUM(b.overdue),            0) AS overdue
        FROM income_cycles c
        LEFT JOIN income_interest i  ON i.cycle_id  = c.id
        LEFT JOIN income_charges  ch ON ch.cycle_id = c.id AND ch.cif=i.cif AND ch.account=i.account
        LEFT JOIN income_balances b  ON b.cycle_id  = c.id AND b.cif=i.cif AND b.account=i.account
        GROUP BY c.id, c.label, c.cycle_date
        ORDER BY c.cycle_date
    """)).fetchall()
    return [dict(r._mapping) for r in rows]
