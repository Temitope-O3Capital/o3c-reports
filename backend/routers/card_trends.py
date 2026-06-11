"""
card_trends.py — Card creation, activation and deactivation trends
Submodule under Executive Overview. Filterable by product name and date range.
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

def _df_ms(date_from, date_to):
    if date_from and date_to:
        return f" AND CAST(Account_Created_Date AS DATE) BETWEEN '{date_from}' AND '{date_to}'"
    if date_from: return f" AND CAST(Account_Created_Date AS DATE) >= '{date_from}'"
    if date_to:   return f" AND CAST(Account_Created_Date AS DATE) <= '{date_to}'"
    return ""

def _df_pg(date_from, date_to):
    if date_from and date_to:
        return f' AND "Account Created Date"::date BETWEEN \'{date_from}\' AND \'{date_to}\''
    if date_from: return f' AND "Account Created Date"::date >= \'{date_from}\''
    if date_to:   return f' AND "Account Created Date"::date <= \'{date_to}\''
    return ""


@router.get("/kpis")
def card_trend_kpis(
    product:   Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from")
    date_to   = _vd(date_to,   "date_to")
    kpis, sources = {}, []
    pf_ms = f" AND Product_Name='{product}'" if product else ""
    pf_pg = f" AND \"Product Name\"='{product}'" if product else ""
    df_ms = _df_ms(date_from, date_to)
    df_pg = _df_pg(date_from, date_to)

    def q(ms, pg, key, cast=int):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = cast(val) if val is not None else 0
        sources.append(src)

    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1{pf_ms}{df_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE 1=1{pf_pg}{df_pg}",
      "total_issued")
    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active'){pf_ms}{df_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE \"Account Status\" IN ('Open','Active'){pf_pg}{df_pg}",
      "total_active")
    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status NOT IN ('Open','Active'){pf_ms}{df_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE \"Account Status\" NOT IN ('Open','Active'){pf_pg}{df_pg}",
      "total_deactivated")
    # MTD always uses current month, ignoring date range
    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE MONTH(Account_Created_Date)=MONTH(GETDATE()) AND YEAR(Account_Created_Date)=YEAR(GETDATE()){pf_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE DATE_TRUNC('month',\"Account Created Date\")=DATE_TRUNC('month',CURRENT_DATE){pf_pg}",
      "created_mtd")

    kpis["activation_rate"] = round(kpis["total_active"] / kpis["total_issued"] * 100, 1) if kpis["total_issued"] > 0 else 0
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}


@router.get("/creation-trend")
def creation_trend(
    product:   Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from")
    date_to   = _vd(date_to,   "date_to")
    pf_ms = f" AND Product_Name='{product}'" if product else ""
    pf_pg = f" AND \"Product Name\"='{product}'" if product else ""
    df_ms = _df_ms(date_from, date_to)
    df_pg = _df_pg(date_from, date_to)

    data, src = dual_query(db_mssql, db_pg,
        f"""SELECT FORMAT(Account_Created_Date,'MMM yyyy') AS month,
               DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS month_sort,
               COUNT(*) AS cards_created
            FROM dbo.Account
            WHERE Account_Created_Date IS NOT NULL{pf_ms}{df_ms}
            GROUP BY DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1),
                     FORMAT(Account_Created_Date,'MMM yyyy')
            ORDER BY month_sort""",
        f"""SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
               DATE_TRUNC('month',"Account Created Date") AS month_sort,
               COUNT(*) AS cards_created
            FROM "Products"
            WHERE "Account Created Date" IS NOT NULL{pf_pg}{df_pg}
            GROUP BY DATE_TRUNC('month',"Account Created Date")
            ORDER BY month_sort""")
    return {"data": data, "data_source": src}


@router.get("/status-by-cohort")
def status_by_cohort(
    product:   Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from")
    date_to   = _vd(date_to,   "date_to")
    pf_ms = f" AND Product_Name='{product}'" if product else ""
    pf_pg = f" AND \"Product Name\"='{product}'" if product else ""
    df_ms = _df_ms(date_from, date_to)
    df_pg = _df_pg(date_from, date_to)

    data, src = dual_query(db_mssql, db_pg,
        f"""SELECT FORMAT(Account_Created_Date,'MMM yyyy') AS month,
               DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS month_sort,
               SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS deactivated,
               COUNT(*) AS total
            FROM dbo.Account
            WHERE Account_Created_Date IS NOT NULL{pf_ms}{df_ms}
            GROUP BY DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1),
                     FORMAT(Account_Created_Date,'MMM yyyy')
            ORDER BY month_sort""",
        f"""SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
               DATE_TRUNC('month',"Account Created Date") AS month_sort,
               SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS deactivated,
               COUNT(*) AS total
            FROM "Products"
            WHERE "Account Created Date" IS NOT NULL{pf_pg}{df_pg}
            GROUP BY DATE_TRUNC('month',"Account Created Date")
            ORDER BY month_sort""")
    return {"data": data, "data_source": src}


@router.get("/by-product")
def breakdown_by_product(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from")
    date_to   = _vd(date_to,   "date_to")
    df_ms = _df_ms(date_from, date_to)
    df_pg = _df_pg(date_from, date_to)

    data, src = dual_query(db_mssql, db_pg,
        f"""SELECT Product_Name,
               COUNT(*) AS total,
               SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS deactivated,
               ROUND(100.0 * SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*), 1) AS activation_rate
            FROM dbo.Account
            WHERE Product_Name IS NOT NULL{df_ms}
            GROUP BY Product_Name
            ORDER BY total DESC""",
        f"""SELECT "Product Name",
               COUNT(*) AS total,
               SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS deactivated,
               ROUND(100.0 * SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*), 1) AS activation_rate
            FROM "Products"
            WHERE "Product Name" IS NOT NULL{df_pg}
            GROUP BY "Product Name"
            ORDER BY total DESC""")
    return {"data": data, "data_source": src}
