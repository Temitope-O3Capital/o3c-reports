"""
transactions.py — Transactions router with date filter and CSV export
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
ACCESS = require_pages(["transactions"])

_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

def _vd(d, name):
    if d is None: return None
    if not _DATE_RE.match(d): raise HTTPException(400, f"Invalid {name} — YYYY-MM-DD required")
    return d

def _df_ms(date_from, date_to):
    if date_from and date_to:
        return f" AND CAST(Transaction_Date AS DATE) BETWEEN '{date_from}' AND '{date_to}'"
    if date_from: return f" AND CAST(Transaction_Date AS DATE) >= '{date_from}'"
    if date_to:   return f" AND CAST(Transaction_Date AS DATE) <= '{date_to}'"
    return ""

def _df_pg(date_from, date_to):
    if date_from and date_to:
        return f' AND "Transaction Date"::date BETWEEN \'{date_from}\' AND \'{date_to}\''
    if date_from: return f' AND "Transaction Date"::date >= \'{date_from}\''
    if date_to:   return f' AND "Transaction Date"::date <= \'{date_to}\''
    return ""


@router.get("/kpis")
def txn_kpis(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    df_ms = _df_ms(date_from, date_to); df_pg = _df_pg(date_from, date_to)
    kpis, sources = {}, []
    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = float(val) if val else 0
        sources.append(src)
    q(f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE 1=1{df_ms}",
      f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE 1=1{df_pg}', "total_volume")
    q(f"SELECT COUNT(*) AS val FROM dbo.Transaction_Listing WHERE 1=1{df_ms}",
      f'SELECT COUNT(*) AS val FROM "Transactions" WHERE 1=1{df_pg}', "transaction_count")
    q("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE MONTH(Transaction_Date)=MONTH(GETDATE()) AND YEAR(Transaction_Date)=YEAR(GETDATE())",
      'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE DATE_TRUNC(\'month\',"Transaction Date")=DATE_TRUNC(\'month\',CURRENT_DATE)', "volume_mtd")
    q(f"SELECT COUNT(DISTINCT Merchant_Name) AS val FROM dbo.Transaction_Listing WHERE 1=1{df_ms}",
      f'SELECT COUNT(DISTINCT "Merchant_Name") AS val FROM "Transactions" WHERE 1=1{df_pg}', "unique_merchants")
    cnt = kpis["transaction_count"]
    kpis["avg_txn_value"] = round(kpis["total_volume"] / cnt, 2) if cnt > 0 else 0
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}


@router.get("/monthly-trend")
def monthly_trend(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT FORMAT(Transaction_Date,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS month_sort, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS count FROM dbo.Transaction_Listing WHERE Transaction_Date IS NOT NULL GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1), FORMAT(Transaction_Date,'MMM yyyy') ORDER BY month_sort",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Transaction Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Transaction Date") AS month_sort, COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS count FROM "Transactions" WHERE "Transaction Date" IS NOT NULL GROUP BY DATE_TRUNC(\'month\',"Transaction Date") ORDER BY month_sort')
    return {"data": data, "data_source": src}


@router.get("/top-merchants")
def top_merchants(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    df_ms = _df_ms(date_from, date_to); df_pg = _df_pg(date_from, date_to)
    data, src = dual_query(db_mssql, db_pg,
        f"SELECT TOP 10 Merchant_Name, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS count FROM dbo.Transaction_Listing WHERE Merchant_Name IS NOT NULL AND Merchant_Name!=''{df_ms} GROUP BY Merchant_Name ORDER BY volume DESC",
        f'SELECT "Merchant_Name", COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS count FROM "Transactions" WHERE "Merchant_Name" IS NOT NULL AND "Merchant_Name"!=\'\'{df_pg} GROUP BY "Merchant_Name" ORDER BY volume DESC LIMIT 10')
    return {"data": data, "data_source": src}


@router.get("/by-type")
def by_type(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    df_ms = _df_ms(date_from, date_to); df_pg = _df_pg(date_from, date_to)
    data, src = dual_query(db_mssql, db_pg,
        f"SELECT Description, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS count FROM dbo.Transaction_Listing WHERE Description IS NOT NULL{df_ms} GROUP BY Description ORDER BY volume DESC",
        f'SELECT "Description", COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS count FROM "Transactions" WHERE "Description" IS NOT NULL{df_pg} GROUP BY "Description" ORDER BY volume DESC')
    return {"data": data, "data_source": src}


@router.get("/export")
def export_csv(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    date_from = _vd(date_from, "date_from"); date_to = _vd(date_to, "date_to")
    df_ms = _df_ms(date_from, date_to); df_pg = _df_pg(date_from, date_to)
    data, _ = dual_query(db_mssql, db_pg,
        f"SELECT TOP 5000 Transaction_Date,CIF,Merchant_Name,Description,Amount FROM dbo.Transaction_Listing WHERE 1=1{df_ms} ORDER BY Transaction_Date DESC",
        f'SELECT "Transaction Date","CIF Number","Merchant_Name","Description","Amount" FROM "Transactions" WHERE 1=1{df_pg} ORDER BY "Transaction Date" DESC LIMIT 5000')

    def stream():
        buf = io.StringIO()
        if data:
            w = csv.DictWriter(buf, fieldnames=list(data[0].keys()))
            w.writeheader()
            for row in data:
                w.writerow({k: (str(v) if v is not None else '') for k, v in row.items()})
        yield buf.getvalue()

    fname = f"transactions_{date_from or 'all'}_{date_to or 'all'}.csv"
    return StreamingResponse(stream(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{fname}"'})
