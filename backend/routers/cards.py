import re
from fastapi import APIRouter, Depends, Query, HTTPException
from typing import Optional
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

def _validate_date(d: Optional[str], name: str) -> Optional[str]:
    if d is None:
        return None
    if not _DATE_RE.match(d):
        raise HTTPException(400, f"Invalid {name} — must be YYYY-MM-DD")
    return d

router = APIRouter()
ACCESS = require_pages(["cards"])


def _date_filter_ms(col: str, date_from: Optional[str], date_to: Optional[str]) -> str:
    if date_from and date_to:
        return f" AND CAST({col} AS DATE) BETWEEN '{date_from}' AND '{date_to}'"
    if date_from:
        return f" AND CAST({col} AS DATE) >= '{date_from}'"
    if date_to:
        return f" AND CAST({col} AS DATE) <= '{date_to}'"
    return ""


def _date_filter_pg(col: str, date_from: Optional[str], date_to: Optional[str]) -> str:
    if date_from and date_to:
        return f" AND {col}::date BETWEEN '{date_from}' AND '{date_to}'"
    if date_from:
        return f" AND {col}::date >= '{date_from}'"
    if date_to:
        return f" AND {col}::date <= '{date_to}'"
    return ""


@router.get("/kpis")
def cards_kpis(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    card_type: Optional[str] = Query(None),
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(ACCESS),
):
    date_from = _validate_date(date_from, "date_from")
    date_to   = _validate_date(date_to,   "date_to")
    kpis, sources = {}, []

    ct_p  = {"card_type": card_type} if card_type else {}
    ct_ms = " AND Product_Name=:card_type"         if card_type else ""
    ct_pg = ' AND "Product Name"=:card_type'       if card_type else ""

    def q(ms, pg, key, extra_params=None):
        p = {**ct_p, **(extra_params or {})}
        val, src = dual_scalar(db_mssql, db_pg, ms, pg, params=p)
        kpis[key] = int(val) if val else 0
        sources.append(src)

    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1{ct_ms}",
      f'SELECT COUNT(*) AS val FROM "Products" WHERE 1=1{ct_pg}',
      "total_issued")
    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active'){ct_ms}",
      f'SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" IN (\'Open\',\'Active\'){ct_pg}',
      "active")
    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status NOT IN ('Open','Active'){ct_ms}",
      f'SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" NOT IN (\'Open\',\'Active\'){ct_pg}',
      "inactive")

    for p in ["PREP", "Amex Naira", "Amex USD", "Classic Accounts"]:
        q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Product_Name=:pname{ct_ms}",
          f'SELECT COUNT(*) AS val FROM "Products" WHERE "Product Name"=:pname{ct_pg}',
          p.lower().replace(" ", "_"), extra_params={"pname": p})

    kpis["activation_rate"] = round(kpis["active"] / kpis["total_issued"] * 100, 1) if kpis["total_issued"] > 0 else 0

    dtf_ms   = _date_filter_ms("t.Transaction_Date", date_from, date_to)
    dtf_pg   = _date_filter_pg('t."Transaction Date"', date_from, date_to)
    pn_ms    = " AND p.Product_Name=:card_type"       if card_type else ""
    pn_pg    = ' AND p."Product Name"=:card_type'     if card_type else ""
    merch_ms = (
        "SELECT COUNT(DISTINCT t.Merchant_Name) AS val"
        " FROM dbo.Transaction_Listing t JOIN dbo.Account p ON t.CIF=p.CIF_Number"
        " WHERE t.Merchant_Name IS NOT NULL AND t.Merchant_Name!=''"
        + dtf_ms + pn_ms
    )
    merch_pg = (
        'SELECT COUNT(DISTINCT t."Merchant_Name") AS val'
        ' FROM "Transactions" t JOIN "Products" p ON t."CIF Number"=p."CIF Number"'
        ' WHERE t."Merchant_Name" IS NOT NULL AND t."Merchant_Name"!=\'\''
        + dtf_pg + pn_pg
    )
    q(merch_ms, merch_pg, "unique_merchants", extra_params={"card_type": card_type} if card_type else {})

    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}


@router.get("/by-product")
def by_product(
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT Product_Name, COUNT(*) AS count FROM dbo.Account WHERE Product_Name IS NOT NULL GROUP BY Product_Name ORDER BY count DESC",
        'SELECT "Product Name", COUNT(*) AS count FROM "Products" WHERE "Product Name" IS NOT NULL GROUP BY "Product Name" ORDER BY count DESC')
    return {"data": data, "data_source": src}


@router.get("/by-status")
def by_status(
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT Status, COUNT(*) AS count FROM dbo.Account GROUP BY Status ORDER BY count DESC",
        'SELECT "Account Status", COUNT(*) AS count FROM "Products" GROUP BY "Account Status" ORDER BY count DESC')
    return {"data": data, "data_source": src}


@router.get("/volume-by-type")
def volume_by_type(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    card_type: Optional[str] = Query(None),
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(ACCESS),
):
    date_from = _validate_date(date_from, "date_from")
    date_to   = _validate_date(date_to,   "date_to")
    dtf_ms = _date_filter_ms("t.Transaction_Date", date_from, date_to)
    dtf_pg = _date_filter_pg('t."Transaction Date"', date_from, date_to)
    ct_ms  = " AND p.Product_Name=:card_type"      if card_type else ""
    ct_pg  = ' AND p."Product Name"=:card_type'    if card_type else ""
    ct_p   = {"card_type": card_type}               if card_type else {}

    vbt_ms = (
        "SELECT p.Product_Name, ISNULL(SUM(t.Amount),0) AS volume, COUNT(t.Amount) AS txn_count"
        " FROM dbo.Account p JOIN dbo.Transaction_Listing t ON p.CIF_Number=t.CIF"
        " WHERE 1=1" + dtf_ms + ct_ms +
        " GROUP BY p.Product_Name ORDER BY volume DESC"
    )
    vbt_pg = (
        'SELECT p."Product Name", COALESCE(SUM(t."Amount"),0) AS volume, COUNT(t."Amount") AS txn_count'
        ' FROM "Products" p JOIN "Transactions" t ON p."CIF Number"=t."CIF Number"'
        " WHERE 1=1" + dtf_pg + ct_pg +
        ' GROUP BY p."Product Name" ORDER BY volume DESC'
    )
    data, src = dual_query(db_mssql, db_pg, vbt_ms, vbt_pg, params=ct_p)
    return {"data": data, "data_source": src}
