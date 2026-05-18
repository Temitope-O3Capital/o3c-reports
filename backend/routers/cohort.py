from fastapi import APIRouter, Depends
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()

@router.get("/kpis")
def cohort_kpis(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["cohort"]))):
    kpis, sources = {}, []
    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = int(val) if val else 0
        sources.append(src)
    q("SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.CIFTable", 'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "CIF Table"', "cohort_size")
    q("SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.MonthlyActivity WHERE TxnCount>0", 'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Monthly Activity" WHERE "TxnCount">0', "activated_cohort")
    q("SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.MonthlyActivity WHERE TxnCount>=5", 'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Monthly Activity" WHERE "TxnCount">=5', "power_users")
    kpis["activation_rate"] = round(kpis["activated_cohort"] / kpis["cohort_size"] * 100, 1) if kpis["cohort_size"] > 0 else 0
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}

@router.get("/heatmap")
def heatmap(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["cohort"]))):
    rows, src = dual_query(db_mssql, db_pg,
        """SELECT ct.[Cohort Label],
               DATEDIFF(month, ct.[Cohort Date], ma.ActivityMonth) AS age_months,
               COUNT(DISTINCT ma.[CIF Number]) AS active_users,
               COUNT(DISTINCT ct.[CIF Number]) AS cohort_size
           FROM dbo.CIFTable ct
           LEFT JOIN dbo.MonthlyActivity ma ON ct.[CIF Number]=ma.[CIF Number] AND ma.TxnCount>0 AND ma.ActivityMonth>=ct.[Cohort Date]
           WHERE ct.[Cohort Label] IS NOT NULL
           GROUP BY ct.[Cohort Label], DATEDIFF(month, ct.[Cohort Date], ma.ActivityMonth)
           ORDER BY ct.[Cohort Label], age_months""",
        """SELECT ct."Cohort Label",
               DATE_PART('year',AGE(ma."ActivityMonth",ct."Cohort Date"))*12+DATE_PART('month',AGE(ma."ActivityMonth",ct."Cohort Date")) AS age_months,
               COUNT(DISTINCT ma."CIF Number") AS active_users,
               COUNT(DISTINCT ct."CIF Number") AS cohort_size
           FROM "CIF Table" ct
           LEFT JOIN "Monthly Activity" ma ON ct."CIF Number"=ma."CIF Number" AND ma."TxnCount">0 AND ma."ActivityMonth">=ct."Cohort Date"
           WHERE ct."Cohort Label" IS NOT NULL
           GROUP BY ct."Cohort Label",age_months ORDER BY ct."Cohort Label",age_months""")
    pivot = {}
    for row in rows:
        label = row["Cohort Label"] if "Cohort Label" in row else row.get("cohort_label","")
        age = int(row.get("age_months") or 0)
        rate = round(row["active_users"] / row["cohort_size"] * 100, 1) if row.get("cohort_size",0) > 0 else 0
        if label not in pivot: pivot[label] = {}
        pivot[label][age] = rate
    return {"data": pivot, "data_source": src}

@router.get("/monthly-activity")
def monthly_activity(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["cohort"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT FORMAT(ActivityMonth,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(ActivityMonth),MONTH(ActivityMonth),1) AS month_sort, COUNT(DISTINCT [CIF Number]) AS active_users, ISNULL(SUM(TotalSpend),0) AS total_spend, ISNULL(AVG(TotalSpend),0) AS avg_spend FROM dbo.MonthlyActivity WHERE TxnCount>0 GROUP BY DATEFROMPARTS(YEAR(ActivityMonth),MONTH(ActivityMonth),1), FORMAT(ActivityMonth,'MMM yyyy') ORDER BY month_sort",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"ActivityMonth"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"ActivityMonth") AS month_sort, COUNT(DISTINCT "CIF Number") AS active_users, COALESCE(SUM("TotalSpend"),0) AS total_spend, COALESCE(AVG("TotalSpend"),0) AS avg_spend FROM "Monthly Activity" WHERE "TxnCount">0 GROUP BY DATE_TRUNC(\'month\',"ActivityMonth") ORDER BY month_sort')
    return {"data": data, "data_source": src}
