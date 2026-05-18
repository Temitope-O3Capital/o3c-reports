"""
dual_query.py — Primary/Fallback query pattern for O3C Reports

Every API endpoint calls dual_query() which:
1. Tries MSSQL first (live data via Cloudflare Tunnel)
2. Falls back to Supabase (last synced snapshot) if MSSQL fails
3. Returns (data, source) where source is "mssql_live" or "supabase_snapshot"
"""

import logging
from typing import Optional
from sqlalchemy.orm import Session
from sqlalchemy import text

log = logging.getLogger("o3c.dual_query")


def execute(db: Session, query: str, params: dict = {}) -> list[dict]:
    """Execute a query and return list of dicts."""
    result = db.execute(text(query), params)
    cols = list(result.keys())
    return [dict(zip(cols, row)) for row in result.fetchall()]


def dual_query(
    db_mssql: Optional[Session],
    db_pg: Session,
    mssql_query: str,
    pg_query: str,
    params: dict = {}
) -> tuple[list[dict], str]:
    """
    Try MSSQL first, fall back to Supabase PostgreSQL.

    Returns:
        (data, source) where source is "mssql_live" or "supabase_snapshot"

    Usage:
        data, source = dual_query(
            db_mssql, db_pg,
            mssql_query="SELECT TOP 100 * FROM dbo.Accounts",
            pg_query='SELECT * FROM "Accounts" LIMIT 100'
        )
        return {"data": data, "data_source": source}
    """
    # Try MSSQL first
    if db_mssql is not None:
        try:
            data = execute(db_mssql, mssql_query, params)
            log.debug(f"MSSQL query succeeded: {len(data)} rows")
            return data, "mssql_live"
        except Exception as e:
            log.warning(f"MSSQL query failed, falling back to Supabase: {e}")

    # Fall back to Supabase
    try:
        data = execute(db_pg, pg_query, params)
        log.info(f"Supabase fallback used: {len(data)} rows")
        return data, "supabase_snapshot"
    except Exception as e:
        log.error(f"Both MSSQL and Supabase failed: {e}")
        raise


def dual_scalar(
    db_mssql: Optional[Session],
    db_pg: Session,
    mssql_query: str,
    pg_query: str,
    params: dict = {},
    column: str = "val"
) -> tuple[any, str]:
    """
    Same as dual_query but returns a single scalar value.
    Useful for KPI counts and sums.
    """
    rows, source = dual_query(db_mssql, db_pg, mssql_query, pg_query, params)
    val = rows[0][column] if rows else 0
    return val, source
