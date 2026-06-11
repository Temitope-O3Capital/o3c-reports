from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import Optional
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()


@router.get("/kpis")
def overview_kpis(
    db_pg: Session = Depends(get_db_pg),
    db_mssql: Optional[Session] = Depends(get_db_mssql),
    user=Depends(require_pages(["overview"]))
):
    kpis = {}
    sources = []

    def q(mssql_q, pg_q, key, col="val"):
        val, src = dual_scalar(db_mssql, db_pg, mssql_q, pg_q, column=col)
        kpis[key] = val
        sources.append(src)

    q(
        "SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts"',
        "total_cardholders"
    )
    q(
        "SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account WHERE Status IN ('Open','Active')",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products" WHERE "Account Status" IN (\'Open\',\'Active\')',
        "active_accounts"
    )
    q(
        "SELECT COUNT(*) AS val FROM dbo.Account",
        'SELECT COUNT(*) AS val FROM "Products"',
        "total_cards_issued"
    )
    q(
        "SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing",
        'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions"',
        "total_txn_volume"
    )
    q(
        "SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Contact WHERE MONTH(Account_Created)=MONTH(GETDATE()) AND YEAR(Account_Created)=YEAR(GETDATE())",
        'SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Accounts" WHERE DATE_TRUNC(\'month\',"Account Created Date")=DATE_TRUNC(\'month\',CURRENT_DATE)',
        "new_accounts_mtd"
    )
    q(
        "SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment",
        'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log"',
        "total_collected"
    )
    q(
        "SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE MONTH(Repayment_Date)=MONTH(GETDATE()) AND YEAR(Repayment_Date)=YEAR(GETDATE())",
        'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE DATE_TRUNC(\'month\',"Date")=DATE_TRUNC(\'month\',CURRENT_DATE)',
        "collections_mtd"
    )
    q(
        "SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet",
        'SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet"',
        "total_recovered"
    )

    total = float(kpis["total_collected"] or 0) + float(kpis["total_recovered"] or 0)
    kpis["recovery_rate"] = round(float(kpis["total_recovered"] or 0) / total * 100, 1) if total > 0 else 0

    source = "mssql_live" if "mssql_live" in sources else "supabase_snapshot"
    return {"data": kpis, "data_source": source}


@router.get("/monthly-volume")
def monthly_volume(
    db_pg: Session = Depends(get_db_pg),
    db_mssql: Optional[Session] = Depends(get_db_mssql),
    user=Depends(require_pages(["overview"]))
):
    data, source = dual_query(
        db_mssql, db_pg,
        mssql_query="""
            SELECT FORMAT(Transaction_Date,'MMM yyyy') AS month,
                   DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS month_sort,
                   ISNULL(SUM(Amount),0) AS volume,
                   COUNT(*) AS txn_count
            FROM dbo.Transaction_Listing
            GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1),
                     FORMAT(Transaction_Date,'MMM yyyy')
            ORDER BY month_sort
        """,
        pg_query="""
            SELECT TO_CHAR(DATE_TRUNC('month',"Transaction Date"),'Mon YYYY') AS month,
                   DATE_TRUNC('month',"Transaction Date") AS month_sort,
                   COALESCE(SUM("Amount"),0) AS volume,
                   COUNT(*) AS txn_count
            FROM "Transactions"
            GROUP BY DATE_TRUNC('month',"Transaction Date")
            ORDER BY month_sort
        """
    )
    return {"data": data, "data_source": source}


@router.get("/new-accounts-trend")
def new_accounts_trend(
    db_pg: Session = Depends(get_db_pg),
    db_mssql: Optional[Session] = Depends(get_db_mssql),
    user=Depends(require_pages(["overview"]))
):
    data, source = dual_query(
        db_mssql, db_pg,
        mssql_query="""
            SELECT FORMAT(Account_Created,'MMM yyyy') AS month,
                   DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1) AS month_sort,
                   COUNT(DISTINCT CIF) AS new_accounts
            FROM dbo.Contact
            WHERE Account_Created IS NOT NULL
            GROUP BY DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1),
                     FORMAT(Account_Created,'MMM yyyy')
            ORDER BY month_sort
        """,
        pg_query="""
            SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month,
                   DATE_TRUNC('month',"Account Created Date") AS month_sort,
                   COUNT(DISTINCT "CIF Number") AS new_accounts
            FROM "Accounts"
            WHERE "Account Created Date" IS NOT NULL
            GROUP BY DATE_TRUNC('month',"Account Created Date")
            ORDER BY month_sort
        """
    )
    return {"data": data, "data_source": source}


@router.get("/cards-by-product")
def cards_by_product(
    db_pg: Session = Depends(get_db_pg),
    db_mssql: Optional[Session] = Depends(get_db_mssql),
    user=Depends(require_pages(["overview"]))
):
    data, source = dual_query(
        db_mssql, db_pg,
        mssql_query="SELECT Product_Name, COUNT(*) AS count FROM dbo.Account WHERE Product_Name IS NOT NULL GROUP BY Product_Name ORDER BY count DESC",
        pg_query='SELECT "Product Name", COUNT(*) AS count FROM "Products" WHERE "Product Name" IS NOT NULL GROUP BY "Product Name" ORDER BY count DESC'
    )
    return {"data": data, "data_source": source}


@router.get("/txn-by-type")
def txn_by_type(
    db_pg: Session = Depends(get_db_pg),
    db_mssql: Optional[Session] = Depends(get_db_mssql),
    user=Depends(require_pages(["overview"]))
):
    data, source = dual_query(
        db_mssql, db_pg,
        mssql_query="SELECT TOP 10 Description, COUNT(*) AS count, ISNULL(SUM(Amount),0) AS volume FROM dbo.Transaction_Listing WHERE Description IS NOT NULL GROUP BY Description ORDER BY count DESC",
        pg_query='SELECT "Description", COUNT(*) AS count, COALESCE(SUM("Amount"),0) AS volume FROM "Transactions" WHERE "Description" IS NOT NULL GROUP BY "Description" ORDER BY count DESC LIMIT 10'
    )
    return {"data": data, "data_source": source}
