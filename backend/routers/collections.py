"""
collections.py — Collections router with dual-source pattern, date filter, CSV export
"""
import csv
import io
import re
from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import StreamingResponse
from typing import Optional
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()
ACCESS = require_pages(["collections"])

_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

def _vd(d: Optional[str], name: str) -> Optional[str]:
    if d is None: return None
    if not _DATE_RE.match(d): raise HTTPException(400, f"Invalid {name} — YYYY-MM-DD required")
    return d

def _df_ms(date_from, date_to):
    if date_from and date_to: return f" AND CAST([Date] AS DATE) BETWEEN '{date_from}' AND '{date_to}'"
    if date_from: return f" AND CAST([Date] AS DATE) >= '{date_from}'"
    if date_to:   return f" AND CAST([Date] AS DATE) <= '{date_to}'"
    return ""

def _df_pg(date_from, date_to):
    if date_from and date_to: return f' AND "Date"::date BETWEEN \'{date_from}\' AND \'{date_to}\''
    if date_from: return f' AND "Date"::date >= \'{date_from}\''
    if date_to:   return f' AND "Date"::date <= \'{date_to}\''
    return ""


@router.get("/kpis")
def collections_kpis(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    agent:     Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from")
    date_to   = _vd(date_to, "date_to")
    kpis, sources = {}, []
    df_ms = _df_ms(date_from, date_to)
    df_pg = _df_pg(date_from, date_to)
    ag_ms = f" AND Agent='{agent}'" if agent else ""
    ag_pg = f" AND \"Agent\"='{agent}'" if agent else ""

    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = float(val) if val else 0
        sources.append(src)

    q(f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog WHERE 1=1{df_ms}{ag_ms}",
      f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE 1=1{df_pg}{ag_pg}',
      "total_collected")
    q(f"SELECT COUNT(*) AS val FROM dbo.CollectionsLog WHERE 1=1{df_ms}{ag_ms}",
      f'SELECT COUNT(*) AS val FROM "Collections Log" WHERE 1=1{df_pg}{ag_pg}',
      "collection_count")
    q(f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog WHERE [Mode Of Payment]='NDD'{df_ms}{ag_ms}",
      f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment"=\'NDD\'{df_pg}{ag_pg}',
      "ndd_collections")
    q(f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog WHERE [Mode Of Payment]='TRANSFER'{df_ms}{ag_ms}",
      f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment"=\'TRANSFER\'{df_pg}{ag_pg}',
      "transfer_collections")
    q(f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog WHERE MONTH([Date])=MONTH(GETDATE()) AND YEAR([Date])=YEAR(GETDATE()){ag_ms}",
      f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE DATE_TRUNC(\'month\',"Date")=DATE_TRUNC(\'month\',CURRENT_DATE){ag_pg}',
      "collections_mtd")
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}


@router.get("/by-agent")
def by_agent(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    df_ms = _df_ms(date_from, date_to); df_pg = _df_pg(date_from, date_to)
    data, src = dual_query(db_mssql, db_pg,
        f"SELECT TOP 15 Agent, ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count FROM dbo.CollectionsLog WHERE Agent IS NOT NULL AND Agent!=''{df_ms} GROUP BY Agent ORDER BY total DESC",
        f'SELECT "Agent", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count FROM "Collections Log" WHERE "Agent" IS NOT NULL AND "Agent"!=\'\'{df_pg} GROUP BY "Agent" ORDER BY total DESC LIMIT 15')
    return {"data": data, "data_source": src}


@router.get("/by-mode")
def by_mode(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT [Mode Of Payment], ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count FROM dbo.CollectionsLog GROUP BY [Mode Of Payment] ORDER BY total DESC",
        'SELECT "Mode Of Payment", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count FROM "Collections Log" GROUP BY "Mode Of Payment" ORDER BY total DESC')
    return {"data": data, "data_source": src}


@router.get("/monthly-trend")
def monthly_trend(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT FORMAT([Date],'MMM yyyy') AS month, DATEFROMPARTS(YEAR([Date]),MONTH([Date]),1) AS month_sort, ISNULL(SUM(Amount),0) AS total FROM dbo.CollectionsLog GROUP BY DATEFROMPARTS(YEAR([Date]),MONTH([Date]),1), FORMAT([Date],'MMM yyyy') ORDER BY month_sort",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Date") AS month_sort, COALESCE(SUM("Amount"),0) AS total FROM "Collections Log" GROUP BY DATE_TRUNC(\'month\',"Date") ORDER BY month_sort')
    return {"data": data, "data_source": src}


@router.get("/log")
def log_entries(
    limit:     int           = Query(200, ge=1, le=1000),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    agent:     Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    df_ms = _df_ms(date_from, date_to); df_pg = _df_pg(date_from, date_to)
    ag_ms = f" AND cl.Agent='{agent}'" if agent else ""
    ag_pg = f' AND cl."Agent"=\'{agent}\'' if agent else ""
    data, src = dual_query(db_mssql, db_pg,
        f"SELECT TOP {limit} cl.[Date],cl.CIF,a.[First Name],a.[Last Name],cl.Agent,cl.Amount,cl.[Mode Of Payment],cl.[Payment Receipt] FROM dbo.CollectionsLog cl LEFT JOIN dbo.Accounts a ON cl.CIF=a.[CIF Number] WHERE 1=1{df_ms}{ag_ms} ORDER BY cl.[Date] DESC",
        f'SELECT cl."Date",cl."CIF",a."First Name",a."Last Name",cl."Agent",cl."Amount",cl."Mode Of Payment",cl."Payment Receipt" FROM "Collections Log" cl LEFT JOIN "Accounts" a ON cl."CIF"=a."CIF Number" WHERE 1=1{df_pg}{ag_pg} ORDER BY cl."Date" DESC LIMIT {limit}')
    return {"data": data, "data_source": src}


@router.get("/export")
def export_csv(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    agent:     Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    df_ms = _df_ms(date_from, date_to); df_pg = _df_pg(date_from, date_to)
    ag_ms = f" AND cl.Agent='{agent}'" if agent else ""
    ag_pg = f' AND cl."Agent"=\'{agent}\'' if agent else ""
    data, _ = dual_query(db_mssql, db_pg,
        f"SELECT cl.[Date],cl.CIF,a.[First Name],a.[Last Name],cl.Agent,cl.Amount,cl.[Mode Of Payment],cl.[Payment Receipt] FROM dbo.CollectionsLog cl LEFT JOIN dbo.Accounts a ON cl.CIF=a.[CIF Number] WHERE 1=1{df_ms}{ag_ms} ORDER BY cl.[Date] DESC",
        f'SELECT cl."Date",cl."CIF",a."First Name",a."Last Name",cl."Agent",cl."Amount",cl."Mode Of Payment",cl."Payment Receipt" FROM "Collections Log" cl LEFT JOIN "Accounts" a ON cl."CIF"=a."CIF Number" WHERE 1=1{df_pg}{ag_pg} ORDER BY cl."Date" DESC')

    def stream():
        buf = io.StringIO()
        if data:
            w = csv.DictWriter(buf, fieldnames=list(data[0].keys()))
            w.writeheader()
            for row in data:
                w.writerow({k: (str(v) if v is not None else '') for k, v in row.items()})
        yield buf.getvalue()

    fname = f"collections_{date_from or 'all'}_{date_to or 'all'}.csv"
    return StreamingResponse(stream(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})
