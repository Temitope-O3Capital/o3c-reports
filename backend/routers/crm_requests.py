"""
crm_requests.py — Service requests, complaints, disputes with SLA tracking
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import text
from core.database import get_db_pg as get_pg
from core.auth import require_pages

router = APIRouter()
ACCESS = require_pages(["crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports"])

REQUEST_TYPES = [
    "card_issue", "card_replacement", "card_upgrade",
    "dispute", "complaint", "limit_increase",
    "pin_reset", "statement_request", "account_info",
    "fraud_report", "general",
]


class RequestCreate(BaseModel):
    request_type: str
    subject:      str
    description:  Optional[str] = None
    contact_id:   Optional[int] = None
    cif_number:   Optional[str] = None
    priority:     Optional[str] = "medium"  # low, medium, high, urgent
    sla_hours:    Optional[int] = 24
    assigned_to:  Optional[int] = None


class RequestUpdate(BaseModel):
    subject:      Optional[str] = None
    description:  Optional[str] = None
    priority:     Optional[str] = None
    status:       Optional[str] = None      # open, in_progress, resolved, closed, escalated
    resolution:   Optional[str] = None
    assigned_to:  Optional[int] = None
    escalated_to: Optional[int] = None


def _row(r): return dict(r._mapping)


@router.get("/requests")
def list_requests(
    status:       Optional[str] = Query(None),
    request_type: Optional[str] = Query(None),
    priority:     Optional[str] = Query(None),
    contact_id:   Optional[int] = Query(None),
    sla_breached: bool          = Query(False),
    limit:        int           = Query(200, le=500),
    offset:       int           = Query(0),
    db=Depends(get_pg), _=Depends(ACCESS),
):
    filters = ["1=1"]
    params  = {"limit": limit, "offset": offset}

    if status:
        filters.append("r.status = :status")
        params["status"] = status
    if request_type:
        filters.append("r.request_type = :request_type")
        params["request_type"] = request_type
    if priority:
        filters.append("r.priority = :priority")
        params["priority"] = priority
    if contact_id:
        filters.append("r.contact_id = :contact_id")
        params["contact_id"] = contact_id
    if sla_breached:
        filters.append("""
            r.status NOT IN ('resolved','closed')
            AND r.created_at + (r.sla_hours || ' hours')::INTERVAL < NOW()
        """)

    rows = db.execute(text(f"""
        SELECT r.*,
               u.full_name  AS assigned_name,
               e.full_name  AS escalated_name,
               c.first_name, c.last_name, c.phone,
               cb.full_name AS created_by_name,
               -- SLA fields
               (r.created_at + (r.sla_hours || ' hours')::INTERVAL)  AS sla_deadline,
               CASE
                 WHEN r.status IN ('resolved','closed') THEN FALSE
                 WHEN r.created_at + (r.sla_hours || ' hours')::INTERVAL < NOW() THEN TRUE
                 ELSE FALSE
               END AS sla_breached,
               EXTRACT(EPOCH FROM (
                 LEAST(COALESCE(r.resolved_at, NOW()),
                       r.created_at + (r.sla_hours || ' hours')::INTERVAL)
                 - r.created_at
               )) / 3600 AS hours_elapsed
        FROM crm_requests r
        LEFT JOIN o3c_users    u  ON u.id  = r.assigned_to
        LEFT JOIN o3c_users    e  ON e.id  = r.escalated_to
        LEFT JOIN o3c_users    cb ON cb.id = r.created_by
        LEFT JOIN crm_contacts c  ON c.id  = r.contact_id
        WHERE {" AND ".join(filters)}
        ORDER BY
          CASE r.priority
            WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
            WHEN 'medium' THEN 3 ELSE 4
          END,
          r.created_at DESC
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    total = db.execute(text(f"""
        SELECT COUNT(*) FROM crm_requests r
        LEFT JOIN crm_contacts c ON c.id = r.contact_id
        WHERE {" AND ".join(filters)}
    """), {k: v for k, v in params.items() if k not in ("limit", "offset")}).scalar()

    return {"data": [_row(r) for r in rows], "total": total}


@router.post("/requests", status_code=201)
def create_request(body: RequestCreate, db=Depends(get_pg), user=Depends(ACCESS)):
    if body.request_type not in REQUEST_TYPES:
        body.request_type = "general"
    row = db.execute(text("""
        INSERT INTO crm_requests
          (contact_id, cif_number, request_type, subject, description,
           priority, sla_hours, assigned_to, created_by)
        VALUES
          (:contact_id, :cif_number, :request_type, :subject, :description,
           :priority, :sla_hours, :assigned_to, :created_by)
        RETURNING *
    """), {**body.dict(), "created_by": user.get("id")}).fetchone()
    db.commit()
    return _row(row)


@router.put("/requests/{req_id}")
def update_request(req_id: int, body: RequestUpdate, db=Depends(get_pg), _=Depends(ACCESS)):
    updates = {k: v for k, v in body.dict().items() if v is not None}
    if not updates:
        raise HTTPException(422, "No fields to update")
    # Auto-set resolved_at when status moves to resolved/closed
    if updates.get("status") in ("resolved", "closed"):
        updates["resolved_at"] = "NOW()"
    updates["id"] = req_id
    set_clause = ", ".join(
        f"{k} = NOW()" if v == "NOW()" else f"{k} = :{k}"
        for k, v in updates.items() if k != "id"
    )
    set_clause += ", updated_at = NOW()"
    row = db.execute(text(f"""
        UPDATE crm_requests SET {set_clause} WHERE id = :id RETURNING *
    """), {k: v for k, v in updates.items() if v != "NOW()"}).fetchone()
    if not row:
        raise HTTPException(404, "Request not found")
    db.commit()
    return _row(row)


@router.get("/requests/types")
def get_request_types(_=Depends(ACCESS)):
    return REQUEST_TYPES
