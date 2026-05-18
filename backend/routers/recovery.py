from fastapi import APIRouter, Depends
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()

@router.get("/kpis")
def recovery_kpis(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["recovery"]))):
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
    collected, _ = dual_scalar(db_mssql, db_pg,
        "SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.CollectionsLog",
        'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log"')
    total = float(collected or 0) + kpis["total_recovered"]
    kpis["recovery_rate"] = round(kpis["total_recovered"] / total * 100, 1) if total > 0 else 0
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}

@router.get("/by-method")
def by_method(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["recovery"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT [Recovery Method], ISNULL(SUM([Recovery Amount]),0) AS total, COUNT(*) AS count FROM dbo.RecoveryMasterSheet GROUP BY [Recovery Method] ORDER BY total DESC",
        'SELECT "Recovery Method", COALESCE(SUM("Recovery Amount"),0) AS total, COUNT(*) AS count FROM "Recovery Master Sheet" GROUP BY "Recovery Method" ORDER BY total DESC')
    return {"data": data, "data_source": src}

@router.get("/monthly-trend")
def monthly_trend(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["recovery"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT FORMAT([Recovery Date],'MMM yyyy') AS month, DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1) AS month_sort, ISNULL(SUM([Recovery Amount]),0) AS total FROM dbo.RecoveryMasterSheet GROUP BY DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1), FORMAT([Recovery Date],'MMM yyyy') ORDER BY month_sort",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Recovery Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Recovery Date") AS month_sort, COALESCE(SUM("Recovery Amount"),0) AS total FROM "Recovery Master Sheet" GROUP BY DATE_TRUNC(\'month\',"Recovery Date") ORDER BY month_sort')
    return {"data": data, "data_source": src}

@router.get("/cases")
def cases(limit: int = 100, db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["recovery"]))):
    data, src = dual_query(db_mssql, db_pg,
        f"SELECT TOP {limit} r.[CIF Number],a.[First Name],a.[Last Name],r.[Recovery Amount],r.[Recovery Method],r.[Legal Stage],r.Agent,r.Status,r.[Recovery Date] FROM dbo.RecoveryMasterSheet r LEFT JOIN dbo.Accounts a ON r.[CIF Number]=a.[CIF Number] ORDER BY r.[Recovery Date] DESC",
        f'SELECT r."CIF Number",a."First Name",a."Last Name",r."Recovery Amount",r."Recovery Method",r."Legal Stage",r."Agent",r."Status",r."Recovery Date" FROM "Recovery Master Sheet" r LEFT JOIN "Accounts" a ON r."CIF Number"=a."CIF Number" ORDER BY r."Recovery Date" DESC LIMIT {limit}')
    return {"data": data, "data_source": src}
