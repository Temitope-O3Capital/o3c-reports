"""
card_trends.py — Card creation, activation and deactivation trends
Submodule under Executive Overview. Filterable by product name.
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


@router.get("/kpis")
def card_trend_kpis(
    product: Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    kpis, sources = {}, []
    pf_ms = f" AND Product_Name='{product}'" if product else ""
    pf_pg = f" AND \"Product Name\"='{product}'" if product else ""

    def q(ms, pg, key, cast=int):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = cast(val) if val is not None else 0
        sources.append(src)

    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1{pf_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE 1=1{pf_pg}",
      "total_issued")
    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active'){pf_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE \"Account Status\" IN ('Open','Active'){pf_pg}",
      "total_active")
    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status NOT IN ('Open','Active'){pf_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE \"Account Status\" NOT IN ('Open','Active'){pf_pg}",
      "total_deactivated")
    q(f"SELECT COUNT(*) AS val FROM dbo.Account WHERE MONTH(Account_Created_Date)=MONTH(GETDATE()) AND YEAR(Account_Created_Date)=YEAR(GETDATE()){pf_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE DATE_TRUNC('month',\"Account Created Date\")=DATE_TRUNC('month',CURRENT_DATE){pf_pg}",
      "created_mtd")

    kpis["activation_rate"] = round(kpis["total_active"] / kpis["total_issued"] * 100, 1) if kpis["total_issued"] > 0 else 0
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}


@router.get("/creation-trend")
def creation_trend(
    product: Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    pf_ms = f" AND Product_Name='{product}'" if product else ""
    pf_pg = f" AND \"Product Name\"='{product}'" if product else ""
    data, src = dual_query(db_mssql, db_pg,
        f"""SELECT FORMAT(Account_Created_Date,'MMM yyyy') AS month,
               DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS month_sort,
               COUNT(*) AS cards_created
            FROM dbo.Account
            WHERE Account_Created_Date IS NOT NULL{pf_ms}
            GROUP BY DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1),
                     FORMAT(Account_Created_Date,'MMM yyyy')
            ORDER BY month_sort""",
        f"""SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
               DATE_TRUNC('month',"Account Created Date") AS month_sort,
               COUNT(*) AS cards_created
            FROM "Products"
            WHERE "Account Created Date" IS NOT NULL{pf_pg}
            GROUP BY DATE_TRUNC('month',"Account Created Date")
            ORDER BY month_sort""")
    return {"data": data, "data_source": src}


@router.get("/status-by-cohort")
def status_by_cohort(
    product: Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    pf_ms = f" AND Product_Name='{product}'" if product else ""
    pf_pg = f" AND \"Product Name\"='{product}'" if product else ""
    data, src = dual_query(db_mssql, db_pg,
        f"""SELECT FORMAT(Account_Created_Date,'MMM yyyy') AS month,
               DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS month_sort,
               SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS deactivated,
               COUNT(*) AS total
            FROM dbo.Account
            WHERE Account_Created_Date IS NOT NULL{pf_ms}
            GROUP BY DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1),
                     FORMAT(Account_Created_Date,'MMM yyyy')
            ORDER BY month_sort""",
        f"""SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
               DATE_TRUNC('month',"Account Created Date") AS month_sort,
               SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS deactivated,
               COUNT(*) AS total
            FROM "Products"
            WHERE "Account Created Date" IS NOT NULL{pf_pg}
            GROUP BY DATE_TRUNC('month',"Account Created Date")
            ORDER BY month_sort""")
    return {"data": data, "data_source": src}


@router.get("/by-product")
def breakdown_by_product(
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    data, src = dual_query(db_mssql, db_pg,
        """SELECT Product_Name,
               COUNT(*) AS total,
               SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN Status NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS deactivated,
               ROUND(100.0 * SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*), 1) AS activation_rate
            FROM dbo.Account
            WHERE Product_Name IS NOT NULL
            GROUP BY Product_Name
            ORDER BY total DESC""",
        """SELECT "Product Name",
               COUNT(*) AS total,
               SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN "Account Status" NOT IN ('Open','Active') THEN 1 ELSE 0 END) AS deactivated,
               ROUND(100.0 * SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*), 1) AS activation_rate
            FROM "Products"
            WHERE "Product Name" IS NOT NULL
            GROUP BY "Product Name"
            ORDER BY total DESC""")
    return {"data": data, "data_source": src}
