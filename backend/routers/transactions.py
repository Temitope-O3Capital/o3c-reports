from fastapi import APIRouter, Depends
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()

@router.get("/kpis")
def txn_kpis(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["transactions"]))):
    kpis, sources = {}, []
    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = float(val) if val else 0
        sources.append(src)
    q("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transactions", 'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions"', "total_volume")
    q("SELECT COUNT(*) AS val FROM dbo.Transactions", 'SELECT COUNT(*) AS val FROM "Transactions"', "transaction_count")
    q("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transactions WHERE MONTH([Transaction Date])=MONTH(GETDATE()) AND YEAR([Transaction Date])=YEAR(GETDATE())", 'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE DATE_TRUNC(\'month\',"Transaction Date")=DATE_TRUNC(\'month\',CURRENT_DATE)', "volume_mtd")
    q("SELECT COUNT(DISTINCT Merchant_Name) AS val FROM dbo.Transactions", 'SELECT COUNT(DISTINCT "Merchant_Name") AS val FROM "Transactions"', "unique_merchants")
    cnt = kpis["transaction_count"]
    kpis["avg_txn_value"] = round(kpis["total_volume"] / cnt, 2) if cnt > 0 else 0
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}

@router.get("/monthly-trend")
def monthly_trend(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["transactions"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT FORMAT([Transaction Date],'MMM yyyy') AS month, DATEFROMPARTS(YEAR([Transaction Date]),MONTH([Transaction Date]),1) AS month_sort, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS count FROM dbo.Transactions GROUP BY DATEFROMPARTS(YEAR([Transaction Date]),MONTH([Transaction Date]),1), FORMAT([Transaction Date],'MMM yyyy') ORDER BY month_sort",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Transaction Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Transaction Date") AS month_sort, COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS count FROM "Transactions" GROUP BY DATE_TRUNC(\'month\',"Transaction Date") ORDER BY month_sort')
    return {"data": data, "data_source": src}

@router.get("/top-merchants")
def top_merchants(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["transactions"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT TOP 10 Merchant_Name, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS count FROM dbo.Transactions WHERE Merchant_Name IS NOT NULL AND Merchant_Name!='' GROUP BY Merchant_Name ORDER BY volume DESC",
        'SELECT "Merchant_Name", COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS count FROM "Transactions" WHERE "Merchant_Name" IS NOT NULL AND "Merchant_Name"!=\'\' GROUP BY "Merchant_Name" ORDER BY volume DESC LIMIT 10')
    return {"data": data, "data_source": src}

@router.get("/by-type")
def by_type(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["transactions"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT Description, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS count FROM dbo.Transactions GROUP BY Description ORDER BY volume DESC",
        'SELECT "Description", COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS count FROM "Transactions" GROUP BY "Description" ORDER BY volume DESC')
    return {"data": data, "data_source": src}
