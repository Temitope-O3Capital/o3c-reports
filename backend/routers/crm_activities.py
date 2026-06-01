"""
crm_activities.py — Activity log (calls, visits, notes, emails, WhatsApp)
"""

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import text
from core.database import get_db_pg as get_pg
from core.auth import require_pages

router = APIRouter()
ACCESS = require_pages(["crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports"])


class ActivityCreate(BaseModel):
    contact_id:    int
    deal_id:       Optional[int]  = None
    type:          str            # call, email, visit, note, whatsapp, sms
    direction:     Optional[str]  = None   # inbound / outbound
    subject:       Optional[str]  = None
    body:          Optional[str]  = None
    outcome:       Optional[str]  = None
    duration_mins: Optional[int]  = None
    next_follow_up: Optional[str] = None
    completed:     bool           = True


def _row(r): return dict(r._mapping)


@router.get("/activities")
def list_activities(
    contact_id: Optional[int] = Query(None),
    type:       Optional[str] = Query(None),
    limit:      int = Query(100, le=500),
    offset:     int = Query(0),
    db=Depends(get_pg), _=Depends(ACCESS),
):
    filters = ["1=1"]
    params  = {"limit": limit, "offset": offset}
    if contact_id:
        filters.append("a.contact_id = :contact_id")
        params["contact_id"] = contact_id
    if type:
        filters.append("a.type = :type")
        params["type"] = type

    rows = db.execute(text(f"""
        SELECT a.*,
               u.full_name AS agent_name,
               c.first_name, c.last_name
        FROM crm_activities a
        LEFT JOIN o3c_users    u ON u.id = a.created_by
        LEFT JOIN crm_contacts c ON c.id = a.contact_id
        WHERE {" AND ".join(filters)}
        ORDER BY a.created_at DESC
        LIMIT :limit OFFSET :offset
    """), params).fetchall()
    return [_row(r) for r in rows]


@router.post("/activities", status_code=201)
def log_activity(body: ActivityCreate, db=Depends(get_pg), user=Depends(ACCESS)):
    row = db.execute(text("""
        INSERT INTO crm_activities
          (contact_id, deal_id, type, direction, subject, body,
           outcome, duration_mins, next_follow_up, completed,
           completed_at, created_by)
        VALUES
          (:contact_id, :deal_id, :type, :direction, :subject, :body,
           :outcome, :duration_mins, :next_follow_up, :completed,
           CASE WHEN :completed THEN NOW() ELSE NULL END,
           :created_by)
        RETURNING *
    """), {**body.dict(), "created_by": user.get("id")}).fetchone()
    db.commit()
    return _row(row)


@router.delete("/activities/{activity_id}", status_code=204)
def delete_activity(activity_id: int, db=Depends(get_pg), _=Depends(ACCESS)):
    db.execute(text("DELETE FROM crm_activities WHERE id = :id"), {"id": activity_id})
    db.commit()
