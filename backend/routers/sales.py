from fastapi import APIRouter, Depends, Query
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()


@router.get("/kpis")
def sales_kpis(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    kpis, sources = {}, []

    def q(ms, pg, key, cast=int):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = cast(val) if val is not None else 0
        sources.append(src)

    q(
        "SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts"',
        "total_customers"
    )
    q(
        "SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact WHERE MONTH(Account_Created)=MONTH(GETDATE()) AND YEAR(Account_Created)=YEAR(GETDATE())",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Accounts\" WHERE DATE_TRUNC('month',\"Account Created Date\")=DATE_TRUNC('month',CURRENT_DATE)",
        "new_mtd"
    )
    prev, _ = dual_scalar(db_mssql, db_pg,
        "SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact WHERE MONTH(Account_Created)=MONTH(DATEADD(month,-1,GETDATE())) AND YEAR(Account_Created)=YEAR(DATEADD(month,-1,GETDATE()))",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Accounts\" WHERE DATE_TRUNC('month',\"Account Created Date\")=DATE_TRUNC('month',CURRENT_DATE-INTERVAL '1 month')")
    prev = int(prev or 0)
    kpis["mom_growth"] = round((kpis["new_mtd"] - prev) / max(prev, 1) * 100, 1)
    kpis["prev_month"] = prev

    q(
        "SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact WHERE YEAR(Account_Created)=YEAR(GETDATE())",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Accounts\" WHERE EXTRACT(year FROM \"Account Created Date\")=EXTRACT(year FROM CURRENT_DATE)",
        "ytd_new"
    )
    q(
        "SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account WHERE Status IN ('Open','Active')",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Products\" WHERE \"Account Status\" IN ('Open','Active')",
        "active_cards"
    )
    q(
        "SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products"',
        "total_cards"
    )
    kpis["activation_rate"] = round(kpis["active_cards"] / max(kpis["total_cards"], 1) * 100, 1)

    q(
        "SELECT COUNT(DISTINCT State_) AS val FROM dbo.Contact WHERE State_ IS NOT NULL AND State_ != ''",
        "SELECT COUNT(DISTINCT \"State\") AS val FROM \"Accounts\" WHERE \"State\" IS NOT NULL AND \"State\" != ''",
        "states_reached"
    )

    src = "mssql_live" if "mssql_live" in sources else "supabase_snapshot"
    return {"data": kpis, "data_source": src}


@router.get("/funnel")
def funnel(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    stages = {}
    sources = []

    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        stages[key] = int(val or 0)
        sources.append(src)

    q(
        "SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts"',
        "registered"
    )
    q(
        "SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products"',
        "card_issued"
    )
    q(
        "SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account WHERE Status IN ('Open','Active')",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Products\" WHERE \"Account Status\" IN ('Open','Active')",
        "card_active"
    )
    q(
        "SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Transaction_Listing",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Transactions"',
        "transacting"
    )

    src = "mssql_live" if "mssql_live" in sources else "supabase_snapshot"
    return {"data": stages, "data_source": src}


@router.get("/accounts-trend")
def accounts_trend(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        """
        SELECT FORMAT(Account_Created,'MMM yyyy') AS month,
               DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1) AS month_sort,
               COUNT(DISTINCT CIF) AS new_accounts
        FROM dbo.Contact
        WHERE Account_Created IS NOT NULL
        GROUP BY DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1),
                 FORMAT(Account_Created,'MMM yyyy')
        ORDER BY month_sort
        """,
        """
        SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
               DATE_TRUNC('month',"Account Created Date") AS month_sort,
               COUNT(DISTINCT "CIF Number") AS new_accounts
        FROM "Accounts"
        WHERE "Account Created Date" IS NOT NULL
        GROUP BY DATE_TRUNC('month',"Account Created Date")
        ORDER BY month_sort
        """
    )
    return {"data": data, "data_source": src}


@router.get("/by-state")
def by_state(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT State_, COUNT(DISTINCT CIF) AS count FROM dbo.Contact WHERE State_ IS NOT NULL AND State_ != '' GROUP BY State_ ORDER BY count DESC",
        'SELECT "State", COUNT(DISTINCT "CIF Number") AS count FROM "Accounts" WHERE "State" IS NOT NULL AND "State" != \'\' GROUP BY "State" ORDER BY count DESC'
    )
    return {"data": data, "data_source": src}


@router.get("/by-city")
def by_city(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT TOP 20 City, State_, COUNT(DISTINCT CIF) AS count FROM dbo.Contact WHERE City IS NOT NULL AND City != '' GROUP BY City, State_ ORDER BY count DESC",
        'SELECT "City", "State", COUNT(DISTINCT "CIF Number") AS count FROM "Accounts" WHERE "City" IS NOT NULL AND "City" != \'\' GROUP BY "City", "State" ORDER BY count DESC LIMIT 20'
    )
    return {"data": data, "data_source": src}


@router.get("/manager-performance")
def manager_performance(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        """
        SELECT TOP 20
            Account_Manager_txt AS [Account Manager],
            COUNT(*) AS total_accounts,
            SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active_accounts,
            ROUND(
                100.0 * SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*),
            1) AS activation_rate
        FROM dbo.Account
        WHERE Account_Manager_txt IS NOT NULL
          AND Account_Manager_txt NOT IN ('', 'Unassigned')
        GROUP BY Account_Manager_txt
        ORDER BY total_accounts DESC
        """,
        """
        SELECT
            "Account Manager",
            COUNT(*) AS total_accounts,
            SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active_accounts,
            ROUND(
                100.0 * SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) / COUNT(*),
            1) AS activation_rate
        FROM "Products"
        WHERE "Account Manager" IS NOT NULL
          AND "Account Manager" NOT IN ('', 'Unassigned')
        GROUP BY "Account Manager"
        ORDER BY total_accounts DESC
        LIMIT 20
        """
    )
    return {"data": data, "data_source": src}


@router.get("/product-mix")
def product_mix(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        """
        SELECT
            Product_Name,
            COUNT(*) AS total,
            SUM(CASE WHEN Status IN ('Open','Active') THEN 1 ELSE 0 END) AS active
        FROM dbo.Account
        WHERE Product_Name IS NOT NULL
        GROUP BY Product_Name
        ORDER BY total DESC
        """,
        """
        SELECT
            "Product Name",
            COUNT(*) AS total,
            SUM(CASE WHEN "Account Status" IN ('Open','Active') THEN 1 ELSE 0 END) AS active
        FROM "Products"
        WHERE "Product Name" IS NOT NULL
        GROUP BY "Product Name"
        ORDER BY total DESC
        """
    )
    return {"data": data, "data_source": src}


@router.get("/customers")
def customers(
    limit: int = Query(default=200, le=500),
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        f"""
        SELECT TOP {limit}
            c.CIF AS [CIF Number],
            c.First_Name AS [First Name],
            c.Last_Name AS [Last Name],
            c.State_ AS [State],
            c.City,
            c.Job_Title AS [Job Title],
            c.Account_Created AS [Account Created Date],
            p.Product_Name AS [Product Name],
            p.Status AS [Account Status],
            p.Account_Manager_txt AS [Account Manager]
        FROM dbo.Contact c
        OUTER APPLY (
            SELECT TOP 1 Product_Name, Status, Account_Manager_txt
            FROM dbo.Account
            WHERE CIF_Number = c.CIF
            ORDER BY CASE WHEN Status IN ('Open','Active') THEN 0 ELSE 1 END
        ) p
        ORDER BY c.Account_Created DESC
        """,
        f"""
        SELECT
            a."CIF Number",
            a."First Name",
            a."Last Name",
            a."State",
            a."City",
            a."Job Title",
            a."Account Created Date",
            p."Product Name",
            p."Account Status",
            p."Account Manager"
        FROM "Accounts" a
        LEFT JOIN LATERAL (
            SELECT "Product Name", "Account Status", "Account Manager"
            FROM "Products"
            WHERE "CIF Number" = a."CIF Number"
            ORDER BY CASE WHEN "Account Status" IN ('Open','Active') THEN 0 ELSE 1 END
            LIMIT 1
        ) p ON true
        ORDER BY a."Account Created Date" DESC
        LIMIT {limit}
        """
    )
    return {"data": data, "data_source": src}
