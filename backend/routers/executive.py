"""
executive.py — Combined executive dashboard for COO / CFO / MD

Single endpoint returns all KPIs, trends, and breakdowns for the selected period.
Supports: month | quarter | year | custom (start + end dates)
All metrics include vs-previous-period comparison.
"""

from fastapi import APIRouter, Depends, Query, HTTPException
from typing import Optional
from datetime import date, timedelta
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()
ACCESS = require_pages(["executive"])


# ── Period helpers ────────────────────────────────────────────────────────────

def get_period_dates(period: str, start: str, end: str):
    today = date.today()

    if period == "month":
        cs = today.replace(day=1)
        ce = today
        ps = (cs - timedelta(days=1)).replace(day=1)
        pe = ps + timedelta(days=(ce - cs).days)

    elif period == "quarter":
        q  = (today.month - 1) // 3
        cs = date(today.year, q * 3 + 1, 1)
        ce = today
        # Prior quarter: same day-count offset into the previous quarter
        if q == 0:
            ps = date(today.year - 1, 10, 1)
        else:
            ps = date(today.year, (q - 1) * 3 + 1, 1)
        # Limit prior period to the same number of days as current period
        days_into_quarter = (ce - cs).days
        pe = ps + timedelta(days=days_into_quarter)

    elif period == "year":
        cs = date(today.year, 1, 1)
        ce = today
        ps = date(today.year - 1, 1, 1)
        pe = ps + timedelta(days=(ce - cs).days)

    elif period == "custom":
        if not start or not end:
            raise HTTPException(400, "start and end required for custom period")
        try:
            cs = date.fromisoformat(start)
            ce = date.fromisoformat(end)
        except ValueError:
            raise HTTPException(400, "Invalid date format — use YYYY-MM-DD")
        if ce < cs:
            raise HTTPException(400, "end must be >= start")
        delta = (ce - cs).days + 1
        pe = cs - timedelta(days=1)
        ps = pe - timedelta(days=delta - 1)
    else:
        raise HTTPException(400, f"Unknown period: {period}")

    return cs, ce, ps, pe


def label_for(period: str, cs: date, ce: date) -> str:
    if period == "month":
        return cs.strftime("%B %Y")
    if period == "quarter":
        q = (cs.month - 1) // 3 + 1
        return f"Q{q} {cs.year}"
    if period == "year":
        return str(cs.year)
    return f"{cs.isoformat()} – {ce.isoformat()}"


def pct_change(curr, prev) -> Optional[float]:
    if prev is None or prev == 0:
        return None
    return round(((curr - prev) / abs(prev)) * 100, 1)


def s(d: date) -> str:
    """ISO date string for SQL literals."""
    return d.isoformat()


# ── Scalar helper (returns float, 0 on None) ──────────────────────────────────

def scalar(db_ms, db_pg, ms_q, pg_q) -> tuple[float, str]:
    val, src = dual_scalar(db_ms, db_pg, ms_q, pg_q)
    return float(val or 0), src


# ── Main endpoint ─────────────────────────────────────────────────────────────

@router.get("/summary")
def executive_summary(
    period: str           = Query("month", regex="^(month|quarter|year|custom)$"),
    start:  Optional[str] = Query(None),
    end:    Optional[str] = Query(None),
    db_pg   = Depends(get_db_pg),
    db_ms   = Depends(get_db_mssql),
    _       = Depends(ACCESS),
):
    cs, ce, ps, pe = get_period_dates(period, start, end)

    sources = []
    def S(ms, pg):
        v, src = scalar(db_ms, db_pg, ms, pg)
        sources.append(src)
        return v

    def Q(ms, pg):
        data, src = dual_query(db_ms, db_pg, ms, pg)
        sources.append(src)
        return data

    # ── Collections ──────────────────────────────────────────────────────────
    coll_curr = S(
        f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '{s(cs)}' AND '{s(ce)}'",
        f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Date" BETWEEN \'{s(cs)}\' AND \'{s(ce)}\''
    )
    coll_prev = S(
        f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '{s(ps)}' AND '{s(pe)}'",
        f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Date" BETWEEN \'{s(ps)}\' AND \'{s(pe)}\''
    )
    coll_count_curr = S(
        f"SELECT COUNT(*) AS val FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '{s(cs)}' AND '{s(ce)}'",
        f'SELECT COUNT(*) AS val FROM "Collections Log" WHERE "Date" BETWEEN \'{s(cs)}\' AND \'{s(ce)}\''
    )

    # ── Recovery ─────────────────────────────────────────────────────────────
    rec_curr = S(
        f"SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE [Recovery Date] BETWEEN '{s(cs)}' AND '{s(ce)}'",
        f'SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE "Recovery Date" BETWEEN \'{s(cs)}\' AND \'{s(ce)}\''
    )
    rec_prev = S(
        f"SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE [Recovery Date] BETWEEN '{s(ps)}' AND '{s(pe)}'",
        f'SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE "Recovery Date" BETWEEN \'{s(ps)}\' AND \'{s(pe)}\''
    )

    # ── Transactions ─────────────────────────────────────────────────────────
    txn_vol_curr = S(
        f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '{s(cs)}' AND '{s(ce)}'",
        f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN \'{s(cs)}\' AND \'{s(ce)}\''
    )
    txn_vol_prev = S(
        f"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '{s(ps)}' AND '{s(pe)}'",
        f'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN \'{s(ps)}\' AND \'{s(pe)}\''
    )
    txn_cnt_curr = S(
        f"SELECT COUNT(*) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '{s(cs)}' AND '{s(ce)}'",
        f'SELECT COUNT(*) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN \'{s(cs)}\' AND \'{s(ce)}\''
    )
    txn_cnt_prev = S(
        f"SELECT COUNT(*) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '{s(ps)}' AND '{s(pe)}'",
        f'SELECT COUNT(*) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN \'{s(ps)}\' AND \'{s(pe)}\''
    )
    avg_txn = round(txn_vol_curr / txn_cnt_curr, 2) if txn_cnt_curr > 0 else 0

    # ── Customer Acquisition ─────────────────────────────────────────────────
    new_curr = S(
        f"SELECT COUNT(*) AS val FROM dbo.Contact WHERE Account_Created BETWEEN '{s(cs)}' AND '{s(ce)}'",
        f'SELECT COUNT(*) AS val FROM "Accounts" WHERE "Account Created Date" BETWEEN \'{s(cs)}\' AND \'{s(ce)}\''
    )
    new_prev = S(
        f"SELECT COUNT(*) AS val FROM dbo.Contact WHERE Account_Created BETWEEN '{s(ps)}' AND '{s(pe)}'",
        f'SELECT COUNT(*) AS val FROM "Accounts" WHERE "Account Created Date" BETWEEN \'{s(ps)}\' AND \'{s(pe)}\''
    )
    total_customers = S(
        "SELECT COUNT(*) AS val FROM dbo.Contact",
        'SELECT COUNT(*) AS val FROM "Accounts"'
    )
    active_cards = S(
        "SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active')",
        'SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" IN (\'Open\',\'Active\')'
    )
    total_cards = S(
        "SELECT COUNT(*) AS val FROM dbo.Account",
        'SELECT COUNT(*) AS val FROM "Products"'
    )
    activation_rate = round((active_cards / total_cards) * 100, 1) if total_cards > 0 else 0

    # ── Recovery rate (all-time) ──────────────────────────────────────────────
    total_recovered_all = S(
        "SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet",
        'SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet"'
    )
    total_collected_all = S(
        'SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment',
        'SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log"'
    )
    recovery_rate_pct = round((total_recovered_all / total_collected_all) * 100, 1) if total_collected_all > 0 else 0

    # ── States covered ───────────────────────────────────────────────────────
    states_count = S(
        "SELECT COUNT(DISTINCT State_) AS val FROM dbo.Contact WHERE State_ IS NOT NULL AND State_!=''",
        'SELECT COUNT(DISTINCT "State") AS val FROM "Accounts" WHERE "State" IS NOT NULL AND "State"!=\'\''
    )

    # ── Collections monthly trend (last 12 months) ────────────────────────────
    coll_trend = Q(
        "SELECT FORMAT(Repayment_Date,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1) AS sort_key, ISNULL(SUM(Amount),0) AS collections, COUNT(*) AS count FROM dbo.o3_loan_Repayment WHERE Repayment_Date >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1), FORMAT(Repayment_Date,'MMM yyyy') ORDER BY sort_key",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Date") AS sort_key, COALESCE(SUM("Amount"),0) AS collections, COUNT(*) AS count FROM "Collections Log" WHERE "Date" >= DATE_TRUNC(\'month\',CURRENT_DATE) - INTERVAL \'11 months\' GROUP BY DATE_TRUNC(\'month\',"Date") ORDER BY sort_key'
    )

    # ── Recovery monthly trend (last 12 months) ───────────────────────────────
    rec_trend = Q(
        "SELECT FORMAT([Recovery Date],'MMM yyyy') AS month, DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1) AS sort_key, ISNULL(SUM([Recovery Amount]),0) AS recovery FROM dbo.RecoveryMasterSheet WHERE [Recovery Date] >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1), FORMAT([Recovery Date],'MMM yyyy') ORDER BY sort_key",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Recovery Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Recovery Date") AS sort_key, COALESCE(SUM("Recovery Amount"),0) AS recovery FROM "Recovery Master Sheet" WHERE "Recovery Date" >= DATE_TRUNC(\'month\',CURRENT_DATE) - INTERVAL \'11 months\' GROUP BY DATE_TRUNC(\'month\',"Recovery Date") ORDER BY sort_key'
    )

    # ── Txn volume monthly trend (last 12 months) ────────────────────────────
    txn_trend = Q(
        "SELECT FORMAT(Transaction_Date,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS sort_key, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS txn_count FROM dbo.Transaction_Listing WHERE Transaction_Date >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1), FORMAT(Transaction_Date,'MMM yyyy') ORDER BY sort_key",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Transaction Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Transaction Date") AS sort_key, COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS txn_count FROM "Transactions" WHERE "Transaction Date" >= DATE_TRUNC(\'month\',CURRENT_DATE) - INTERVAL \'11 months\' GROUP BY DATE_TRUNC(\'month\',"Transaction Date") ORDER BY sort_key'
    )

    # ── New accounts monthly trend (last 12 months) ───────────────────────────
    acq_trend = Q(
        "SELECT FORMAT(Account_Created,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1) AS sort_key, COUNT(*) AS new_accounts FROM dbo.Contact WHERE Account_Created >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1), FORMAT(Account_Created,'MMM yyyy') ORDER BY sort_key",
        'SELECT TO_CHAR(DATE_TRUNC(\'month\',"Account Created Date"),\'Mon YYYY\') AS month, DATE_TRUNC(\'month\',"Account Created Date") AS sort_key, COUNT(*) AS new_accounts FROM "Accounts" WHERE "Account Created Date" >= DATE_TRUNC(\'month\',CURRENT_DATE) - INTERVAL \'11 months\' GROUP BY DATE_TRUNC(\'month\',"Account Created Date") ORDER BY sort_key'
    )

    # ── Top states ────────────────────────────────────────────────────────────
    top_states = Q(
        "SELECT TOP 10 State_, COUNT(*) AS count FROM dbo.Contact WHERE State_ IS NOT NULL AND State_!='' GROUP BY State_ ORDER BY count DESC",
        'SELECT "State", COUNT(*) AS count FROM "Accounts" WHERE "State" IS NOT NULL AND "State"!=\'\' GROUP BY "State" ORDER BY count DESC LIMIT 10'
    )

    # ── Product mix ───────────────────────────────────────────────────────────
    product_mix = Q(
        "SELECT Product_Name, COUNT(*) AS count FROM dbo.Account WHERE Product_Name IS NOT NULL GROUP BY Product_Name ORDER BY count DESC",
        'SELECT "Product Name", COUNT(*) AS count FROM "Products" WHERE "Product Name" IS NOT NULL GROUP BY "Product Name" ORDER BY count DESC'
    )

    # ── Top collections agents (period) ───────────────────────────────────────
    top_agents = Q(
        f"SELECT TOP 10 Rn_Create_User AS Agent, ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '{s(cs)}' AND '{s(ce)}' AND Rn_Create_User IS NOT NULL AND Rn_Create_User!='' GROUP BY Rn_Create_User ORDER BY total DESC",
        f'SELECT "Agent", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count FROM "Collections Log" WHERE "Date" BETWEEN \'{s(cs)}\' AND \'{s(ce)}\' AND "Agent" IS NOT NULL AND "Agent"!=\'\' GROUP BY "Agent" ORDER BY total DESC LIMIT 10'
    )

    # ── Merge collection + recovery trends by month ───────────────────────────
    coll_by_month = {r["month"]: r for r in coll_trend}
    rec_by_month  = {r["month"]: r for r in rec_trend}
    txn_by_month  = {r["month"]: r for r in txn_trend}
    all_months    = sorted(set(list(coll_by_month) + list(rec_by_month) + list(txn_by_month)),
                           key=lambda m: list(coll_by_month.get(m, rec_by_month.get(m, txn_by_month.get(m, {}))).values()))
    merged_trend  = []
    for m in all_months:
        merged_trend.append({
            "month":       m,
            "collections": float(coll_by_month.get(m, {}).get("collections", 0) or 0),
            "recovery":    float(rec_by_month.get(m,  {}).get("recovery", 0)    or 0),
            "volume":      float(txn_by_month.get(m,  {}).get("volume", 0)      or 0),
            "txn_count":   int(txn_by_month.get(m,    {}).get("txn_count", 0)   or 0),
        })

    overall_source = "mssql_live" if "mssql_live" in sources else "supabase_snapshot"

    return {
        "data_source": overall_source,
        "period": {
            "type":  period,
            "label": label_for(period, cs, ce),
            "start": s(cs),
            "end":   s(ce),
            "prev_start": s(ps),
            "prev_end":   s(pe),
        },
        "financial": {
            "collections":        coll_curr,
            "collections_prev":   coll_prev,
            "collections_change": pct_change(coll_curr, coll_prev),
            "collections_count":  int(coll_count_curr),
            "recovery":           rec_curr,
            "recovery_prev":      rec_prev,
            "recovery_change":    pct_change(rec_curr, rec_prev),
            "txn_volume":         txn_vol_curr,
            "txn_volume_prev":    txn_vol_prev,
            "txn_volume_change":  pct_change(txn_vol_curr, txn_vol_prev),
            "txn_count":          int(txn_cnt_curr),
            "txn_count_prev":     int(txn_cnt_prev),
            "txn_count_change":   pct_change(txn_cnt_curr, txn_cnt_prev),
            "avg_txn_value":      avg_txn,
            "recovery_rate":      recovery_rate_pct,
            "total_collected_all": total_collected_all,
            "total_recovered_all": total_recovered_all,
        },
        "growth": {
            "new_customers":       int(new_curr),
            "new_customers_prev":  int(new_prev),
            "new_customers_change": pct_change(new_curr, new_prev),
            "total_customers":     int(total_customers),
            "active_cards":        int(active_cards),
            "total_cards":         int(total_cards),
            "activation_rate":     activation_rate,
            "states_covered":      int(states_count),
        },
        "trends": {
            "monthly":    merged_trend,
            "acquisition": [{"month": r["month"], "new_accounts": int(r.get("new_accounts", 0) or 0)} for r in acq_trend],
        },
        "breakdowns": {
            "top_states":   top_states,
            "product_mix":  product_mix,
            "top_agents":   top_agents,
        },
    }
