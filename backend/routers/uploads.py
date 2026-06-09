"""
uploads.py — Upload audit log endpoint

GET /api/uploads/audit   list recent upload events (all roles)
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text

from core.database import get_db_pg as get_pg
from core.auth import require_pages

router = APIRouter()
ACCESS = require_pages(["uploads"])


@router.get("/audit")
def audit_log(
    limit:       int = Query(200, le=1000),
    report_type: str = Query(None),
    db           = Depends(get_pg),
    _            = Depends(ACCESS),
):
    filters = []
    params  = {"limit": limit}
    if report_type:
        filters.append("a.report_type = :report_type")
        params["report_type"] = report_type

    where = ("WHERE " + " AND ".join(filters)) if filters else ""

    rows = db.execute(text(f"""
        SELECT
            a.id,
            a.report_type,
            a.file_names,
            a.cycle_label,
            a.row_counts,
            a.status,
            a.error_msg,
            a.uploaded_at,
            u.full_name   AS uploaded_by_name,
            u.email       AS uploaded_by_email
        FROM upload_audit_log a
        LEFT JOIN o3c_users u ON u.id = a.uploaded_by
        {where}
        ORDER BY a.uploaded_at DESC
        LIMIT :limit
    """), params).fetchall()

    return [dict(r._mapping) for r in rows]
