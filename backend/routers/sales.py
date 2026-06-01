from fastapi import APIRouter, Depends, Query
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()


# ── KPIs ──────────────────────────────────────────────────────────────────────

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

    # Total customers
    q(
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Accounts",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts"',
        "total_customers"
    )
    # New this month
    q(
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Accounts WHERE MONTH([Account Created Date])=MONTH(GETDATE()) AND YEAR([Account Created Date])=YEAR(GETDATE())",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Accounts\" WHERE DATE_TRUNC('month',\"Account Created Date\")=DATE_TRUNC('month',CURRENT_DATE)",
        "new_mtd"
    )
    # Previous month (for MoM)
    prev, _ = dual_scalar(db_mssql, db_pg,
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Accounts WHERE MONTH([Account Created Date])=MONTH(DATEADD(month,-1,GETDATE())) AND YEAR([Account Created Date])=YEAR(DATEADD(month,-1,GETDATE()))",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Accounts\" WHERE DATE_TRUNC('month',\"Account Created Date\")=DATE_TRUNC('month',CURRENT_DATE-INTERVAL '1 month')")
    prev = int(prev or 0)
    kpis["mom_growth"] = round((kpis["new_mtd"] - prev) / max(prev, 1) * 100, 1)
    kpis["prev_month"] = prev

    # YTD new accounts
    q(
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Accounts WHERE YEAR([Account Created Date])=YEAR(GETDATE())",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Accounts\" WHERE EXTRACT(year FROM \"Account Created Date\")=EXTRACT(year FROM CURRENT_DATE)",
        "ytd_new"
    )
    # Active cards (Account Status = Open)
    q(
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Products WHERE [Account Status]='Open'",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Products\" WHERE \"Account Status\"='Open'",
        "active_cards"
    )
    # Total cards issued
    q(
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Products",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products"',
        "total_cards"
    )
    kpis["activation_rate"] = round(kpis["active_cards"] / max(kpis["total_cards"], 1) * 100, 1)

    # Unique states reached
    q(
        "SELECT COUNT(DISTINCT State) AS val FROM dbo.Accounts WHERE State IS NOT NULL AND State != ''",
        "SELECT COUNT(DISTINCT \"State\") AS val FROM \"Accounts\" WHERE \"State\" IS NOT NULL AND \"State\" != ''",
        "states_reached"
    )

    src = "mssql_live" if "mssql_live" in sources else "supabase_snapshot"
    return {"data": kpis, "data_source": src}


# ── Lifecycle Funnel ───────────────────────────────────────────────────────────

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
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Accounts",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts"',
        "registered"
    )
    q(
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Products",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products"',
        "card_issued"
    )
    q(
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Products WHERE [Account Status]='Open'",
        "SELECT COUNT(DISTINCT \"CIF Number\") AS val FROM \"Products\" WHERE \"Account Status\"='Open'",
        "card_active"
    )
    q(
        "SELECT COUNT(DISTINCT [CIF Number]) AS val FROM dbo.Transactions",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Transactions"',
        "transacting"
    )

    src = "mssql_live" if "mssql_live" in sources else "supabase_snapshot"
    return {"data": stages, "data_source": src}


# ── Monthly Acquisition Trend ─────────────────────────────────────────────────

@router.get("/accounts-trend")
def accounts_trend(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        """
        SELECT FORMAT([Account Created Date],'MMM yyyy') AS month,
               DATEFROMPARTS(YEAR([Account Created Date]),MONTH([Account Created Date]),1) AS month_sort,
               COUNT(DISTINCT [CIF Number]) AS new_accounts
        FROM dbo.Accounts
        GROUP BY DATEFROMPARTS(YEAR([Account Created Date]),MONTH([Account Created Date]),1),
                 FORMAT([Account Created Date],'MMM yyyy')
        ORDER BY month_sort
        """,
        """
        SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
               DATE_TRUNC('month',"Account Created Date") AS month_sort,
               COUNT(DISTINCT "CIF Number") AS new_accounts
        FROM "Accounts"
        GROUP BY DATE_TRUNC('month',"Account Created Date")
        ORDER BY month_sort
        """
    )
    return {"data": data, "data_source": src}


# ── Geographic Breakdown ──────────────────────────────────────────────────────

@router.get("/by-state")
def by_state(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT State, COUNT(DISTINCT [CIF Number]) AS count FROM dbo.Accounts WHERE State IS NOT NULL AND State != '' GROUP BY State ORDER BY count DESC",
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
        "SELECT TOP 20 City, State, COUNT(DISTINCT [CIF Number]) AS count FROM dbo.Accounts WHERE City IS NOT NULL AND City != '' GROUP BY City, State ORDER BY count DESC",
        'SELECT "City", "State", COUNT(DISTINCT "CIF Number") AS count FROM "Accounts" WHERE "City" IS NOT NULL AND "City" != \'\' GROUP BY "City", "State" ORDER BY count DESC LIMIT 20'
    )
    return {"data": data, "data_source": src}


# ── Account Manager Performance ───────────────────────────────────────────────

@router.get("/manager-performance")
def manager_performance(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        """
        SELECT TOP 20
            [Account Manager],
            COUNT(*) AS total_accounts,
            SUM(CASE WHEN [Account Status] = 'Open' THEN 1 ELSE 0 END) AS active_accounts,
            ROUND(
                100.0 * SUM(CASE WHEN [Account Status] = 'Open' THEN 1 ELSE 0 END) / COUNT(*),
            1) AS activation_rate
        FROM dbo.Products
        WHERE [Account Manager] IS NOT NULL
          AND [Account Manager] NOT IN ('', 'Unassigned')
        GROUP BY [Account Manager]
        ORDER BY total_accounts DESC
        """,
        """
        SELECT
            "Account Manager",
            COUNT(*) AS total_accounts,
            SUM(CASE WHEN "Account Status" = 'Open' THEN 1 ELSE 0 END) AS active_accounts,
            ROUND(
                100.0 * SUM(CASE WHEN "Account Status" = 'Open' THEN 1 ELSE 0 END) / COUNT(*),
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


# ── Product Mix ────────────────────────────────────────────────────────────────

@router.get("/product-mix")
def product_mix(
    db_pg=Depends(get_db_pg),
    db_mssql=Depends(get_db_mssql),
    user=Depends(require_pages(["sales"]))
):
    data, src = dual_query(db_mssql, db_pg,
        """
        SELECT
            [Product Name],
            COUNT(*) AS total,
            SUM(CASE WHEN [Account Status] = 'Open' THEN 1 ELSE 0 END) AS active
        FROM dbo.Products
        WHERE [Product Name] IS NOT NULL
        GROUP BY [Product Name]
        ORDER BY total DESC
        """,
        """
        SELECT
            "Product Name",
            COUNT(*) AS total,
            SUM(CASE WHEN "Account Status" = 'Open' THEN 1 ELSE 0 END) AS active
        FROM "Products"
        WHERE "Product Name" IS NOT NULL
        GROUP BY "Product Name"
        ORDER BY total DESC
        """
    )
    return {"data": data, "data_source": src}


# ── Customer Directory ─────────────────────────────────────────────────────────

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
            a.[CIF Number],
            a.[First Name],
            a.[Last Name],
            a.[State],
            a.[City],
            a.[Job Title],
            a.[Account Created Date],
            p.[Product Name],
            p.[Account Status],
            p.[Account Manager]
        FROM dbo.Accounts a
        OUTER APPLY (
            SELECT TOP 1 [Product Name], [Account Status], [Account Manager]
            FROM dbo.Products
            WHERE [CIF Number] = a.[CIF Number]
            ORDER BY CASE WHEN [Account Status] = 'Open' THEN 0 ELSE 1 END
        ) p
        ORDER BY a.[Account Created Date] DESC
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
            ORDER BY CASE WHEN "Account Status" = 'Open' THEN 0 ELSE 1 END
            LIMIT 1
        ) p ON true
        ORDER BY a."Account Created Date" DESC
        LIMIT {limit}
        """
    )
    return {"data": data, "data_source": src}


