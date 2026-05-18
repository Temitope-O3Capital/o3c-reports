"""
collections.py — Collections router with dual-source pattern
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import Optional
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()

@router.get("/kpis")
def collections_kpis(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["collections"]))):
    kpis, sources = {}, []
    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = float(val) if val else 0
        sources.append(src)
    q("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog",
      'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log"', "total_collected")
    q("SELECT COUNT(*) AS val FROM dbo.CollectionsLog",
      'SELECT COUNT(*) AS val FROM "Collections Log"', "collection_count")
    q("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog WHERE [Mode Of Payment]='NDD'",
      'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment"=\'NDD\'', "ndd_collections")
    q("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog WHERE [Mode Of Payment]='TRANSFER'",
      'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment"=\'TRANSFER\'', "transfer_collections")
    q("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog WHERE MONTH([Date])=MONTH(GETDATE()) AND YEAR([Date])=YEAR(GETDATE())",
      'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE DATE_TRUNC(\'month\',"Date")=DATE_TRUNC(\'month\',CURRENT_DATE)', "collections_mtd")
    source = "mssql_live" if "mssql_live" in sources else "supabase_snapshot"
    return {"data": kpis, "data_source": source}

@router.get("/by-agent")
def by_agent(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["collections"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT TOP 15 Agent, ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count FROM dbo.CollectionsLog WHERE Agent IS NOT NULL AND Agent!='' GROUP BY Agent ORDER BY total DESC",
        'SELECT "Agent", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count FROM "Collections Log" WHERE "Agent" IS NOT NULL AND "Agent"!=\'\' GROUP BY "Agent" ORDER BY total DESC LIMIT 15')
    return {"data": data, "data_source": src}

@router.get("/by-mode")
def by_mode(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["collections"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT [Mode Of Payment], ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count FROM dbo.CollectionsLog GROUP BY [Mode Of Payment] ORDER BY total DESC",
        'SELECT "Mode Of Payment", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count FROM "Collections Log" GROUP BY "Mode Of Payment" ORDER BY total DESC')
    return {"data": data, "data_source": src}

@router.get("/monthly-trend")
def monthly_trend(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["collections"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT FORMAT([Date],'MMM yyyy') AS month, DATEFROMPARTS(YEAR([Date]),MONTH([Date]),1) AS month_sort, ISNULL(SUM(Amount),0) AS total FROM dbo.CollectionsLog GROUP BY DATEFROMPARTS(YEAR([Date]),MONTH([Date]),1), FORMAT([Date],'MMM yyyy') ORDER BY month_sort",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Date") AS month_sort, COALESCE(SUM("Amount"),0) AS total FROM "Collections Log" GROUP BY DATE_TRUNC(\'month\',"Date") ORDER BY month_sort')
    return {"data": data, "data_source": src}

@router.get("/log")
def log_entries(limit: int = 100, db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["collections"]))):
    data, src = dual_query(db_mssql, db_pg,
        f"SELECT TOP {limit} cl.[Date],cl.CIF,a.[First Name],a.[Last Name],cl.Agent,cl.Amount,cl.[Mode Of Payment],cl.[Payment Receipt] FROM dbo.CollectionsLog cl LEFT JOIN dbo.Accounts a ON cl.CIF=a.[CIF Number] ORDER BY cl.[Date] DESC",
        f'SELECT cl."Date",cl."CIF",a."First Name",a."Last Name",cl."Agent",cl."Amount",cl."Mode Of Payment",cl."Payment Receipt" FROM "Collections Log" cl LEFT JOIN "Accounts" a ON cl."CIF"=a."CIF Number" ORDER BY cl."Date" DESC LIMIT {limit}')
    return {"data": data, "data_source": src}
