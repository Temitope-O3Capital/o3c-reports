from fastapi import APIRouter, Depends, Query
from typing import Optional
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

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
    kpis, sources = {}, []

    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = int(val) if val else 0
        sources.append(src)

    ct_ms = f" AND [Product Name]='{card_type}'" if card_type else ""
    ct_pg = f" AND \"Product Name\"='{card_type}'" if card_type else ""

    q(f"SELECT COUNT(*) AS val FROM dbo.Products WHERE 1=1{ct_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE 1=1{ct_pg}",
      "total_issued")
    q(f"SELECT COUNT(*) AS val FROM dbo.Products WHERE [Account Status]='Open'{ct_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE \"Account Status\"='Open'{ct_pg}",
      "active")
    q(f"SELECT COUNT(*) AS val FROM dbo.Products WHERE [Account Status]!='Open'{ct_ms}",
      f"SELECT COUNT(*) AS val FROM \"Products\" WHERE \"Account Status\"!='Open'{ct_pg}",
      "inactive")

    for p in ["Prepaid", "Credit", "International"]:
        q(f"SELECT COUNT(*) AS val FROM dbo.Products WHERE [Product Name]='{p}'{ct_ms}",
          f"SELECT COUNT(*) AS val FROM \"Products\" WHERE \"Product Name\"='{p}'{ct_pg}",
          p.lower())

    kpis["activation_rate"] = round(kpis["active"] / kpis["total_issued"] * 100, 1) if kpis["total_issued"] > 0 else 0

    # Unique merchants filtered by date range (join Products → Transactions)
    dtf_ms = _date_filter_ms("t.[Transaction Date]", date_from, date_to)
    dtf_pg = _date_filter_pg('t."Transaction Date"', date_from, date_to)
    q(
        f"SELECT COUNT(DISTINCT t.Merchant_Name) AS val FROM dbo.Transactions t JOIN dbo.Products p ON t.[CIF Number]=p.[CIF Number] WHERE t.Merchant_Name IS NOT NULL AND t.Merchant_Name!=''{dtf_ms}{ct_ms.replace('[Product Name]','p.[Product Name]')}",
        f"SELECT COUNT(DISTINCT t.\"Merchant_Name\") AS val FROM \"Transactions\" t JOIN \"Products\" p ON t.\"CIF Number\"=p.\"CIF Number\" WHERE t.\"Merchant_Name\" IS NOT NULL AND t.\"Merchant_Name\"!=''{dtf_pg}{ct_pg.replace('\"Product Name\"','p.\"Product Name\"')}",
        "unique_merchants"
    )

    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}


@router.get("/by-product")
def by_product(
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT [Product Name], COUNT(*) AS count FROM dbo.Products GROUP BY [Product Name] ORDER BY count DESC",
        'SELECT "Product Name", COUNT(*) AS count FROM "Products" GROUP BY "Product Name" ORDER BY count DESC')
    return {"data": data, "data_source": src}


@router.get("/by-status")
def by_status(
    db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(ACCESS)
):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT [Account Status], COUNT(*) AS count FROM dbo.Products GROUP BY [Account Status] ORDER BY count DESC",
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
    dtf_ms = _date_filter_ms("t.[Transaction Date]", date_from, date_to)
    dtf_pg = _date_filter_pg('t."Transaction Date"', date_from, date_to)
    ct_ms  = f" AND p.[Product Name]='{card_type}'" if card_type else ""
    ct_pg  = f" AND p.\"Product Name\"='{card_type}'" if card_type else ""

    data, src = dual_query(db_mssql, db_pg,
        f"SELECT p.[Product Name], ISNULL(SUM(t.Amount),0) AS volume, COUNT(t.Amount) AS txn_count FROM dbo.Products p JOIN dbo.Transactions t ON p.[CIF Number]=t.[CIF Number] WHERE 1=1{dtf_ms}{ct_ms} GROUP BY p.[Product Name] ORDER BY volume DESC",
        f"SELECT p.\"Product Name\", COALESCE(SUM(t.\"Amount\"),0) AS volume, COUNT(t.\"Amount\") AS txn_count FROM \"Products\" p JOIN \"Transactions\" t ON p.\"CIF Number\"=t.\"CIF Number\" WHERE 1=1{dtf_pg}{ct_pg} GROUP BY p.\"Product Name\" ORDER BY volume DESC"
    )
    return {"data": data, "data_source": src}
