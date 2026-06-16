"""
collections.py — Collections router (source: dbo.o3_loan_Repayment)
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

# MSSQL date filter on Repayment_Date
def _df_ms(date_from, date_to):
    if date_from and date_to: return f" AND CAST(Repayment_Date AS DATE) BETWEEN '{date_from}' AND '{date_to}'"
    if date_from: return f" AND CAST(Repayment_Date AS DATE) >= '{date_from}'"
    if date_to:   return f" AND CAST(Repayment_Date AS DATE) <= '{date_to}'"
    return ""

# PG date filter on "Date" (synced alias)
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
    ag_ms = " AND Rn_Create_User=:agent" if agent else ""
    ag_pg = ' AND "Agent"=:agent'        if agent else ""
    ag_p  = {"agent": agent}             if agent else {}

    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg, params=ag_p)
        kpis[key] = float(val) if val else 0
        sources.append(src)

    q(f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE 1=1{df_ms}{ag_ms}",
      f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE 1=1{df_pg}{ag_pg}',
      "total_collected")
    q(f"SELECT COUNT(*) AS val FROM dbo.o3_loan_Repayment WHERE 1=1{df_ms}{ag_ms}",
      f'SELECT COUNT(*) AS val FROM "Collections Log" WHERE 1=1{df_pg}{ag_pg}',
      "collection_count")
    q(f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE Paid=1{df_ms}{ag_ms}",
      f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment" IS NOT NULL{df_pg}{ag_pg}',
      "paid_collections")
    q(f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE (Paid IS NULL OR Paid=0){df_ms}{ag_ms}",
      f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment" IS NULL{df_pg}{ag_pg}',
      "pending_collections")
    q(f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE MONTH(Repayment_Date)=MONTH(GETDATE()) AND YEAR(Repayment_Date)=YEAR(GETDATE()){ag_ms}",
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
        f"SELECT TOP 15 Rn_Create_User AS Agent, ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count FROM dbo.o3_loan_Repayment WHERE Rn_Create_User IS NOT NULL AND Rn_Create_User!=''{df_ms} GROUP BY Rn_Create_User ORDER BY total DESC",
        f'SELECT "Agent", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count FROM "Collections Log" WHERE "Agent" IS NOT NULL AND "Agent"!=\'\'{df_pg} GROUP BY "Agent" ORDER BY total DESC LIMIT 15')
    return {"data": data, "data_source": src}


@router.get("/by-mode")
def by_mode(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT CASE WHEN Paid=1 THEN 'Paid' ELSE 'Pending' END AS payment_status, ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count FROM dbo.o3_loan_Repayment GROUP BY Paid ORDER BY total DESC",
        'SELECT COALESCE("Mode Of Payment",\'Pending\') AS payment_status, COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count FROM "Collections Log" GROUP BY "Mode Of Payment" ORDER BY total DESC')
    return {"data": data, "data_source": src}


@router.get("/monthly-trend")
def monthly_trend(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT FORMAT(Repayment_Date,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1) AS month_sort, ISNULL(SUM(Amount),0) AS total FROM dbo.o3_loan_Repayment WHERE Repayment_Date IS NOT NULL GROUP BY DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1), FORMAT(Repayment_Date,'MMM yyyy') ORDER BY month_sort",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Date") AS month_sort, COALESCE(SUM("Amount"),0) AS total FROM "Collections Log" WHERE "Date" IS NOT NULL GROUP BY DATE_TRUNC(\'month\',"Date") ORDER BY month_sort')
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
    ag_ms = " AND r.Rn_Create_User=:agent" if agent else ""
    ag_pg = ' AND cl."Agent"=:agent'       if agent else ""
    ag_p  = {"agent": agent}               if agent else {}
    data, src = dual_query(db_mssql, db_pg,
        f"SELECT TOP {limit} r.Repayment_Date AS [Date], a.CIF_Number AS CIF, c.First_Name AS [First Name], c.Last_Name AS [Last Name], r.Rn_Create_User AS Agent, r.Amount, NULL AS [Mode Of Payment], r.Comments AS [Payment Receipt] FROM dbo.o3_loan_Repayment r LEFT JOIN dbo.Account a ON r.Loan_Account=a.Account_Id LEFT JOIN dbo.Contact c ON a.CIF_Number=c.CIF WHERE 1=1{df_ms}{ag_ms} ORDER BY r.Repayment_Date DESC",
        f'SELECT cl."Date",cl."CIF",a."First Name",a."Last Name",cl."Agent",cl."Amount",cl."Mode Of Payment",cl."Payment Receipt" FROM "Collections Log" cl LEFT JOIN "Accounts" a ON cl."CIF"=a."CIF Number" WHERE 1=1{df_pg}{ag_pg} ORDER BY cl."Date" DESC LIMIT {limit}',
        params=ag_p)
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
    ag_ms = " AND r.Rn_Create_User=:agent" if agent else ""
    ag_pg = ' AND cl."Agent"=:agent'       if agent else ""
    ag_p  = {"agent": agent}               if agent else {}
    data, _ = dual_query(db_mssql, db_pg,
        f"SELECT r.Repayment_Date AS [Date], a.CIF_Number AS CIF, c.First_Name AS [First Name], c.Last_Name AS [Last Name], r.Rn_Create_User AS Agent, r.Amount, r.Comments AS Notes FROM dbo.o3_loan_Repayment r LEFT JOIN dbo.Account a ON r.Loan_Account=a.Account_Id LEFT JOIN dbo.Contact c ON a.CIF_Number=c.CIF WHERE 1=1{df_ms}{ag_ms} ORDER BY r.Repayment_Date DESC",
        f'SELECT cl."Date",cl."CIF",a."First Name",a."Last Name",cl."Agent",cl."Amount",cl."Payment Receipt" FROM "Collections Log" cl LEFT JOIN "Accounts" a ON cl."CIF"=a."CIF Number" WHERE 1=1{df_pg}{ag_pg} ORDER BY cl."Date" DESC',
        params=ag_p)

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
