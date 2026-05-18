from fastapi import APIRouter, Depends
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()

@router.get("/kpis")
def sales_kpis(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["sales"]))):
    kpis, sources = {}, []
    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = int(val) if val else 0
        sources.append(src)
    q("SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Accounts", 'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts"', "total_customers")
    q("SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Accounts WHERE MONTH([Account Created Date])=MONTH(GETDATE()) AND YEAR([Account Created Date])=YEAR(GETDATE())", 'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts" WHERE DATE_TRUNC(\'month\',"Account Created Date")=DATE_TRUNC(\'month\',CURRENT_DATE)', "new_mtd")
    prev, _ = dual_scalar(db_mssql, db_pg,
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Accounts WHERE MONTH([Account Created Date])=MONTH(DATEADD(month,-1,GETDATE())) AND YEAR([Account Created Date])=YEAR(DATEADD(month,-1,GETDATE()))",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts" WHERE DATE_TRUNC(\'month\',"Account Created Date")=DATE_TRUNC(\'month\',CURRENT_DATE-INTERVAL\'1 month\')')
    kpis["mom_growth"] = round((kpis["new_mtd"] - int(prev or 0)) / int(prev or 1) * 100, 1)
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}

@router.get("/accounts-by-state")
def by_state(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["sales"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT State, COUNT(DISTINCT [CIF Number]) AS count FROM dbo.Accounts WHERE State IS NOT NULL GROUP BY State ORDER BY count DESC",
        'SELECT "State", COUNT(DISTINCT "CIF Number") AS count FROM "Accounts" WHERE "State" IS NOT NULL GROUP BY "State" ORDER BY count DESC')
    return {"data": data, "data_source": src}

@router.get("/accounts-trend")
def accounts_trend(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["sales"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT FORMAT([Account Created Date],'MMM yyyy') AS month, DATEFROMPARTS(YEAR([Account Created Date]),MONTH([Account Created Date]),1) AS month_sort, COUNT(DISTINCT [CIF Number]) AS new_accounts FROM dbo.Accounts GROUP BY DATEFROMPARTS(YEAR([Account Created Date]),MONTH([Account Created Date]),1), FORMAT([Account Created Date],'MMM yyyy') ORDER BY month_sort",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Account Created Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Account Created Date") AS month_sort, COUNT(DISTINCT "CIF Number") AS new_accounts FROM "Accounts" GROUP BY DATE_TRUNC(\'month\',"Account Created Date") ORDER BY month_sort')
    return {"data": data, "data_source": src}

@router.get("/by-account-manager")
def by_manager(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["sales"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT TOP 15 [Account Manager], COUNT(*) AS accounts FROM dbo.Products WHERE [Account Manager] IS NOT NULL AND [Account Manager]!='Unassigned' GROUP BY [Account Manager] ORDER BY accounts DESC",
        'SELECT "Account Manager", COUNT(*) AS accounts FROM "Products" WHERE "Account Manager" IS NOT NULL AND "Account Manager"!=\'Unassigned\' GROUP BY "Account Manager" ORDER BY accounts DESC LIMIT 15')
    return {"data": data, "data_source": src}
