"""
recovery.py — Recovery router with dual-source pattern and CSV export
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
ACCESS = require_pages(["recovery"])

_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

def _vd(d, name):
    if d is None: return None
    if not _DATE_RE.match(d): raise HTTPException(400, f"Invalid {name} — YYYY-MM-DD required")
    return d


@router.get("/kpis")
def recovery_kpis(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)):
    kpis, sources = {}, []
    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = float(val) if val else 0
        sources.append(src)
    q("SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet",
      'SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet"', "total_recovered")
    q("SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.RecoveryMasterSheet WHERE [Legal Stage] IS NOT NULL",
      'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Recovery Master Sheet" WHERE "Legal Stage" IS NOT NULL', "accounts_in_legal")
    q("SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE MONTH([Recovery Date])=MONTH(GETDATE()) AND YEAR([Recovery Date])=YEAR(GETDATE())",
      'SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE DATE_TRUNC(\'month\',"Recovery Date")=DATE_TRUNC(\'month\',CURRENT_DATE)', "recovery_mtd")
    # Outstanding portfolio (all accounts in Recovery Master Sheet that haven't been fully recovered)
    q("SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.RecoveryMasterSheet WHERE [Status] IS NULL OR [Status] NOT IN ('Recovered','Paid','Closed')",
      'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Recovery Master Sheet" WHERE "Status" IS NULL OR "Status" NOT IN (\'Recovered\',\'Paid\',\'Closed\')',
      "open_cases")
    collected, _ = dual_scalar(db_mssql, db_pg,
        "SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog",
        'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log"')
    total = float(collected or 0) + kpis["total_recovered"]
    kpis["recovery_rate"] = round(kpis["total_recovered"] / total * 100, 1) if total > 0 else 0
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}


@router.get("/by-method")
def by_method(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT [Recovery Method], ISNULL(SUM([Recovery Amount]),0) AS total, COUNT(*) AS count FROM dbo.RecoveryMasterSheet GROUP BY [Recovery Method] ORDER BY total DESC",
        'SELECT "Recovery Method", COALESCE(SUM("Recovery Amount"),0) AS total, COUNT(*) AS count FROM "Recovery Master Sheet" GROUP BY "Recovery Method" ORDER BY total DESC')
    return {"data": data, "data_source": src}


@router.get("/monthly-trend")
def monthly_trend(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT FORMAT([Recovery Date],'MMM yyyy') AS month, DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1) AS month_sort, ISNULL(SUM([Recovery Amount]),0) AS total FROM dbo.RecoveryMasterSheet GROUP BY DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1), FORMAT([Recovery Date],'MMM yyyy') ORDER BY month_sort",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Recovery Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Recovery Date") AS month_sort, COALESCE(SUM("Recovery Amount"),0) AS total FROM "Recovery Master Sheet" GROUP BY DATE_TRUNC(\'month\',"Recovery Date") ORDER BY month_sort')
    return {"data": data, "data_source": src}


@router.get("/cases")
def cases(
    limit:     int           = Query(200, ge=1, le=1000),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    df_ms = f" AND CAST(r.[Recovery Date] AS DATE) BETWEEN '{date_from}' AND '{date_to}'" if date_from and date_to else ""
    df_pg = f' AND r."Recovery Date"::date BETWEEN \'{date_from}\' AND \'{date_to}\'' if date_from and date_to else ""
    data, src = dual_query(db_mssql, db_pg,
        f"SELECT TOP {limit} r.[CIF Number],a.[First Name],a.[Last Name],r.[Recovery Amount],r.[Recovery Method],r.[Legal Stage],r.Agent,r.Status,r.[Recovery Date] FROM dbo.RecoveryMasterSheet r LEFT JOIN dbo.Accounts a ON r.[CIF Number]=a.[CIF Number] WHERE 1=1{df_ms} ORDER BY r.[Recovery Date] DESC",
        f'SELECT r."CIF Number",a."First Name",a."Last Name",r."Recovery Amount",r."Recovery Method",r."Legal Stage",r."Agent",r."Status",r."Recovery Date" FROM "Recovery Master Sheet" r LEFT JOIN "Accounts" a ON r."CIF Number"=a."CIF Number" WHERE 1=1{df_pg} ORDER BY r."Recovery Date" DESC LIMIT {limit}')
    return {"data": data, "data_source": src}


@router.get("/export")
def export_csv(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    df_ms = f" AND CAST(r.[Recovery Date] AS DATE) BETWEEN '{date_from}' AND '{date_to}'" if date_from and date_to else ""
    df_pg = f' AND r."Recovery Date"::date BETWEEN \'{date_from}\' AND \'{date_to}\'' if date_from and date_to else ""
    data, _ = dual_query(db_mssql, db_pg,
        f"SELECT r.[CIF Number],a.[First Name],a.[Last Name],r.[Recovery Amount],r.[Recovery Method],r.[Legal Stage],r.Agent,r.Status,r.[Recovery Date] FROM dbo.RecoveryMasterSheet r LEFT JOIN dbo.Accounts a ON r.[CIF Number]=a.[CIF Number] WHERE 1=1{df_ms} ORDER BY r.[Recovery Date] DESC",
        f'SELECT r."CIF Number",a."First Name",a."Last Name",r."Recovery Amount",r."Recovery Method",r."Legal Stage",r."Agent",r."Status",r."Recovery Date" FROM "Recovery Master Sheet" r LEFT JOIN "Accounts" a ON r."CIF Number"=a."CIF Number" WHERE 1=1{df_pg} ORDER BY r."Recovery Date" DESC')

    def stream():
        buf = io.StringIO()
        if data:
            w = csv.DictWriter(buf, fieldnames=list(data[0].keys()))
            w.writeheader()
            for row in data:
                w.writerow({k: (str(v) if v is not None else '') for k, v in row.items()})
        yield buf.getvalue()

    fname = f"recovery_{date_from or 'all'}_{date_to or 'all'}.csv"
    return StreamingResponse(stream(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})
