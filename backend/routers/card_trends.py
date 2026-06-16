"""
card_trends.py — Card portfolio analytics
Endpoints for the Card Portfolio Report: issuance trend, active/inactive
portfolio health, card program (BLINK) breakdown, status distribution.
"""
import re
from fastapi import APIRouter, Depends, Query, HTTPException
from typing import Optional
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()
ACCESS = require_pages(["card_trends"])

_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

def _vd(d, name):
    if d is None: return None
    if not _DATE_RE.match(d): raise HTTPException(400, f"Invalid {name} — YYYY-MM-DD required")
    return d

# Date filter on Account_Created_Date
def _df_ms(df, dt):
    if df and dt: return f" AND CAST(Account_Created_Date AS DATE) BETWEEN '{df}' AND '{dt}'"
    if df:        return f" AND CAST(Account_Created_Date AS DATE) >= '{df}'"
    if dt:        return f" AND CAST(Account_Created_Date AS DATE) <= '{dt}'"
    return ""

def _df_pg(df, dt):
    if df and dt: return f' AND "Account Created Date"::date BETWEEN \'{df}\' AND \'{dt}\''
    if df:        return f' AND "Account Created Date"::date >= \'{df}\''
    if dt:        return f' AND "Account Created Date"::date <= \'{dt}\''
    return ""

def _filters(product, card_program, df, dt):
    ms = _df_ms(df, dt)
    pg = _df_pg(df, dt)
    params: dict = {}
    if product:
        ms += " AND Product_Name=:product"
        pg += ' AND "Product Name"=:product'
        params["product"] = product
    if card_program:
        ms += " AND Card_Product=:card_program"
        pg += ' AND "Card Product"=:card_program'
        params["card_program"] = card_program
    return ms, pg, params


# ── Portfolio KPIs ────────────────────────────────────────────────────────────

@router.get("/kpis")
def kpis(
    product:      Optional[str] = Query(None),
    card_program: Optional[str] = Query(None),
    date_from:    Optional[str] = Query(None),
    date_to:      Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    fms, fpg, fp = _filters(product, card_program, date_from, date_to)
    k, s = {}, []

    def q(ms, pg, key, cast=int):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg, params=fp)
        k[key] = cast(val) if val is not None else 0
        s.append(src)

    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1{fms}",
      f'SELECT COUNT(*) AS val FROM "Products" WHERE 1=1{fpg}', "total_issued")

    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active'){fms}",
      f'SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" IN (\'Open\',\'Active\'){fpg}', "active")

    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status NOT IN ('Open','Active'){fms}",
      f'SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" NOT IN (\'Open\',\'Active\'){fpg}', "inactive")

    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status='TERMINATED'{fms}",
      f'SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status"=\'TERMINATED\'{fpg}', "terminated")

    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('LEGAL ACTI','SUSPENDED'){fms}",
      f'SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" IN (\'LEGAL ACTI\',\'SUSPENDED\'){fpg}', "legal_suspended")

    # MTD always uses current month regardless of date filter
    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE MONTH(Account_Created_Date)=MONTH(GETDATE()) AND YEAR(Account_Created_Date)=YEAR(GETDATE())",
      f'SELECT COUNT(*) AS val FROM "Products" WHERE DATE_TRUNC(\'month\',"Account Created Date")=DATE_TRUNC(\'month\',CURRENT_DATE)', "issued_mtd")

    k["activation_rate"] = round(k["active"] / k["total_issued"] * 100, 1) if k["total_issued"] > 0 else 0
    return {"data": k, "data_source": "mssql_live" if "mssql_live" in s else "supabase_snapshot"}


# ── Monthly issuance trend ────────────────────────────────────────────────────

@router.get("/issuance-trend")
def issuance_trend(
    product:      Optional[str] = Query(None),
    card_program: Optional[str] = Query(None),
    date_from:    Optional[str] = Query(None),
    date_to:      Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    fms, fpg, fp = _filters(product, card_program, date_from, date_to)
    data, src = dual_query(db_mssql, db_pg,
        f"""SELECT FORMAT(Account_Created_Date,'MMM yyyy') AS month,
               DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS month_sort,
               COUNT(*) AS issued
            FROM dbo.Account WHERE Account_Created_Date IS NOT NULL{fms}
            GROUP BY DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1),
                     FORMAT(Account_Created_Date,'MMM yyyy')
            ORDER BY month_sort""",
        f"""SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
               DATE_TRUNC('month',"Account Created Date") AS month_sort,
               COUNT(*) AS issued
            FROM "Products" WHERE "Account Created Date" IS NOT NULL{fpg}
            GROUP BY DATE_TRUNC('month',"Account Created Date") ORDER BY month_sort""",
        params=fp)
    return {"data": data, "data_source": src}


# ── Active/Inactive portfolio health by issuance cohort ──────────────────────

@router.get("/portfolio-health")
def portfolio_health(
    product:      Optional[str] = Query(None),
    card_program: Optional[str] = Query(None),
    date_from:    Optional[str] = Query(None),
    date_to:      Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    """Monthly cohort view: of cards issued each month, how many are active vs inactive today."""
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    fms, fpg, fp = _filters(product, card_program, date_from, date_to)
    data, src = dual_query(db_mssql, db_pg,
        f"""SELECT FORMAT(Account_Created_Date,'MMM yyyy') AS month,
               DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS month_sort,
               SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
               COUNT(*) AS total
            FROM dbo.Account WHERE Account_Created_Date IS NOT NULL{fms}
            GROUP BY DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1),
                     FORMAT(Account_Created_Date,'MMM yyyy')
            ORDER BY month_sort""",
        f"""SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
               DATE_TRUNC('month',"Account Created Date") AS month_sort,
               SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
               COUNT(*) AS total
            FROM "Products" WHERE "Account Created Date" IS NOT NULL{fpg}
            GROUP BY DATE_TRUNC('month',"Account Created Date") ORDER BY month_sort""",
        params=fp)
    return {"data": data, "data_source": src}


# ── Status distribution (donut data) ─────────────────────────────────────────

@router.get("/status-distribution")
def status_distribution(
    product:      Optional[str] = Query(None),
    card_program: Optional[str] = Query(None),
    date_from:    Optional[str] = Query(None),
    date_to:      Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    fms, fpg, fp = _filters(product, card_program, date_from, date_to)
    data, src = dual_query(db_mssql, db_pg,
        f"SELECT Status AS status, COUNT(*) AS count FROM dbo.Account WHERE 1=1{fms} GROUP BY Status ORDER BY count DESC",
        f'SELECT "Account Status" AS status, COUNT(*) AS count FROM "Products" WHERE 1=1{fpg} GROUP BY "Account Status" ORDER BY count DESC',
        params=fp)
    return {"data": data, "data_source": src}


# ── Card Program (BLINK) breakdown ────────────────────────────────────────────

@router.get("/by-program")
def by_program(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    fms, fpg, fp = _filters(None, None, date_from, date_to)
    try:
        data, src = dual_query(db_mssql, db_pg,
            f"""SELECT Card_Product AS program,
                   COUNT(*) AS total,
                   SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
                   SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
                   ROUND(100.0 * SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*), 1) AS activation_rate
                FROM dbo.Account WHERE Card_Product IS NOT NULL AND Card_Product != ''{fms}
                GROUP BY Card_Product ORDER BY total DESC""",
            f"""SELECT "Card Product" AS program,
                   COUNT(*) AS total,
                   SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
                   SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
                   ROUND(100.0 * SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*), 1) AS activation_rate
                FROM "Products" WHERE "Card Product" IS NOT NULL AND "Card Product" != ''{fpg}
                GROUP BY "Card Product" ORDER BY total DESC""",
            params=fp)
        return {"data": data, "data_source": src}
    except Exception:
        return {"data": [], "data_source": "supabase_snapshot"}


# ── Product breakdown ─────────────────────────────────────────────────────────

@router.get("/by-product")
def by_product(
    card_program: Optional[str] = Query(None),
    date_from:    Optional[str] = Query(None),
    date_to:      Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    fms, fpg, fp = _filters(None, card_program, date_from, date_to)
    data, src = dual_query(db_mssql, db_pg,
        f"""SELECT Product_Name,
               COUNT(*) AS total,
               SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
               ROUND(100.0 * SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*), 1) AS activation_rate
            FROM dbo.Account WHERE Product_Name IS NOT NULL{fms}
            GROUP BY Product_Name ORDER BY total DESC""",
        f"""SELECT "Product Name",
               COUNT(*) AS total,
               SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS inactive,
               ROUND(100.0 * SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*), 1) AS activation_rate
            FROM "Products" WHERE "Product Name" IS NOT NULL{fpg}
            GROUP BY "Product Name" ORDER BY total DESC""",
        params=fp)
    return {"data": data, "data_source": src}


# ── List distinct card programs (for filter dropdown) ────────────────────────

@router.get("/programs")
def list_programs(
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    try:
        data, src = dual_query(db_mssql, db_pg,
            "SELECT DISTINCT Card_Product AS program FROM dbo.Account WHERE Card_Product IS NOT NULL AND Card_Product != '' ORDER BY Card_Product",
            'SELECT DISTINCT "Card Product" AS program FROM "Products" WHERE "Card Product" IS NOT NULL AND "Card Product" != \'\' ORDER BY "Card Product"')
        return {"data": [r["program"] for r in data], "data_source": src}
    except Exception:
        return {"data": [], "data_source": "supabase_snapshot"}
