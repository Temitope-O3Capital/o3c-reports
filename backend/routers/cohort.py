"""
cohort.py — Cohort analysis derived from Account (card creation) + Transaction_Listing.
No separate CIFTable or MonthlyActivity tables exist; we derive everything inline.
"""
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

    q("SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account WHERE Account_Created_Date IS NOT NULL",
      'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products" WHERE "Account Created Date" IS NOT NULL',
      "cohort_size")
    q("SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Transaction_Listing WHERE CIF IS NOT NULL",
      'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Transactions" WHERE "CIF Number" IS NOT NULL',
      "activated_cohort")
    q("SELECT COUNT(*) AS val FROM (SELECT CIF FROM dbo.Transaction_Listing WHERE CIF IS NOT NULL GROUP BY CIF HAVING COUNT(*) >= 5) x",
      'SELECT COUNT(*) AS val FROM (SELECT "CIF Number" FROM "Transactions" WHERE "CIF Number" IS NOT NULL GROUP BY "CIF Number" HAVING COUNT(*) >= 5) x',
      "power_users")

    kpis["activation_rate"] = round(kpis["activated_cohort"] / kpis["cohort_size"] * 100, 1) if kpis["cohort_size"] > 0 else 0
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}


@router.get("/heatmap")
def heatmap(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["cohort"]))):
    rows, src = dual_query(db_mssql, db_pg,
        """
        WITH Cohorts AS (
            SELECT CIF_Number,
                   DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS Cohort_Date,
                   FORMAT(Account_Created_Date,'MMM yyyy') AS Cohort_Label
            FROM dbo.Account
            WHERE Account_Created_Date IS NOT NULL
              AND Account_Created_Date >= DATEADD(year,-2,GETDATE())
        ),
        MonthlyAct AS (
            SELECT CIF,
                   DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS ActivityMonth,
                   COUNT(*) AS TxnCount
            FROM dbo.Transaction_Listing
            WHERE Transaction_Date IS NOT NULL
            GROUP BY CIF, DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1)
        )
        SELECT c.Cohort_Label,
               DATEDIFF(month, c.Cohort_Date, ma.ActivityMonth) AS age_months,
               COUNT(DISTINCT ma.CIF) AS active_users,
               COUNT(DISTINCT c.CIF_Number) AS cohort_size
        FROM Cohorts c
        LEFT JOIN MonthlyAct ma ON c.CIF_Number=ma.CIF AND ma.TxnCount>0 AND ma.ActivityMonth>=c.Cohort_Date
        WHERE c.Cohort_Label IS NOT NULL
        GROUP BY c.Cohort_Label, DATEDIFF(month, c.Cohort_Date, ma.ActivityMonth)
        ORDER BY c.Cohort_Label, age_months
        """,
        """
        WITH cohorts AS (
            SELECT "CIF Number",
                   DATE_TRUNC('month',"Account Created Date") AS cohort_date,
                   TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS cohort_label
            FROM "Products"
            WHERE "Account Created Date" IS NOT NULL
              AND "Account Created Date" >= CURRENT_DATE - INTERVAL '2 years'
        ),
        monthly_act AS (
            SELECT "CIF Number",
                   DATE_TRUNC('month',"Transaction Date") AS activity_month,
                   COUNT(*) AS txn_count
            FROM "Transactions"
            WHERE "Transaction Date" IS NOT NULL
            GROUP BY "CIF Number", DATE_TRUNC('month',"Transaction Date")
        )
        SELECT c.cohort_label,
               DATE_PART('year',AGE(ma.activity_month,c.cohort_date))*12
               + DATE_PART('month',AGE(ma.activity_month,c.cohort_date)) AS age_months,
               COUNT(DISTINCT ma."CIF Number") AS active_users,
               COUNT(DISTINCT c."CIF Number") AS cohort_size
        FROM cohorts c
        LEFT JOIN monthly_act ma ON c."CIF Number"=ma."CIF Number"
            AND ma.txn_count>0 AND ma.activity_month>=c.cohort_date
        WHERE c.cohort_label IS NOT NULL
        GROUP BY c.cohort_label, age_months
        ORDER BY c.cohort_label, age_months
        """)
    pivot = {}
    for row in rows:
        label = row.get("Cohort_Label") or row.get("cohort_label", "")
        age = int(row.get("age_months") or 0)
        rate = round(row["active_users"] / row["cohort_size"] * 100, 1) if row.get("cohort_size", 0) > 0 else 0
        if label not in pivot:
            pivot[label] = {}
        pivot[label][age] = rate
    return {"data": pivot, "data_source": src}


@router.get("/monthly-activity")
def monthly_activity(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["cohort"]))):
    data, src = dual_query(db_mssql, db_pg,
        """
        SELECT FORMAT(Transaction_Date,'MMM yyyy') AS month,
               DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS month_sort,
               COUNT(DISTINCT CIF) AS active_users,
               ISNULL(SUM(Amount),0) AS total_spend,
               ISNULL(AVG(CAST(Amount AS FLOAT)),0) AS avg_spend
        FROM dbo.Transaction_Listing
        WHERE Transaction_Date IS NOT NULL
        GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1),
                 FORMAT(Transaction_Date,'MMM yyyy')
        ORDER BY month_sort
        """,
        """
        SELECT TO_CHAR(DATE_TRUNC('month',"Transaction Date"),'Mon YYYY') AS month,
               DATE_TRUNC('month',"Transaction Date") AS month_sort,
               COUNT(DISTINCT "CIF Number") AS active_users,
               COALESCE(SUM("Amount"),0) AS total_spend,
               COALESCE(AVG("Amount"),0) AS avg_spend
        FROM "Transactions"
        WHERE "Transaction Date" IS NOT NULL
        GROUP BY DATE_TRUNC('month',"Transaction Date")
        ORDER BY month_sort
        """)
    return {"data": data, "data_source": src}
