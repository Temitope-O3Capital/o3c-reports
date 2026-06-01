"""
crm_tasks.py — Task management (follow-ups, reminders, to-dos)
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import text
from core.database import get_db_pg as get_pg
from core.auth import require_pages

router = APIRouter()
ACCESS = require_pages(["crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports"])


class TaskCreate(BaseModel):
    title:       str
    contact_id:  Optional[int] = None
    deal_id:     Optional[int] = None
    description: Optional[str] = None
    due_date:    Optional[str] = None
    priority:    Optional[str] = "medium"   # low, medium, high, urgent
    assigned_to: Optional[int] = None


class TaskUpdate(BaseModel):
    title:       Optional[str] = None
    description: Optional[str] = None
    due_date:    Optional[str] = None
    priority:    Optional[str] = None
    status:      Optional[str] = None       # open, in_progress, done, cancelled
    assigned_to: Optional[int] = None


def _row(r): return dict(r._mapping)


@router.get("/tasks")
def list_tasks(
    mine:       bool          = Query(False),
    status:     Optional[str] = Query(None),
    priority:   Optional[str] = Query(None),
    contact_id: Optional[int] = Query(None),
    overdue:    bool          = Query(False),
    limit:      int           = Query(200, le=500),
    db=Depends(get_pg), user=Depends(ACCESS),
):
    filters = ["1=1"]
    params  = {"limit": limit}

    if mine:
        filters.append("t.assigned_to = :me")
        params["me"] = user.get("id")
    if status:
        filters.append("t.status = :status")
        params["status"] = status
    if priority:
        filters.append("t.priority = :priority")
        params["priority"] = priority
    if contact_id:
        filters.append("t.contact_id = :contact_id")
        params["contact_id"] = contact_id
    if overdue:
        filters.append("t.due_date < NOW() AND t.status NOT IN ('done','cancelled')")

    rows = db.execute(text(f"""
        SELECT t.*,
               u.full_name  AS assigned_name,
               c.first_name, c.last_name,
               CASE WHEN t.due_date < NOW() AND t.status NOT IN ('done','cancelled')
                    THEN TRUE ELSE FALSE END AS is_overdue
        FROM crm_tasks t
        LEFT JOIN o3c_users    u ON u.id = t.assigned_to
        LEFT JOIN crm_contacts c ON c.id = t.contact_id
        WHERE {" AND ".join(filters)}
        ORDER BY
          CASE t.priority
            WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
            WHEN 'medium' THEN 3 ELSE 4
          END,
          t.due_date ASC NULLS LAST
        LIMIT :limit
    """), params).fetchall()
    return [_row(r) for r in rows]


@router.post("/tasks", status_code=201)
def create_task(body: TaskCreate, db=Depends(get_pg), user=Depends(ACCESS)):
    row = db.execute(text("""
        INSERT INTO crm_tasks
          (contact_id, deal_id, title, description, due_date,
           priority, assigned_to, created_by)
        VALUES
          (:contact_id, :deal_id, :title, :description, :due_date,
           :priority, :assigned_to, :created_by)
        RETURNING *
    """), {**body.dict(), "created_by": user.get("id")}).fetchone()
    db.commit()
    return _row(row)


@router.put("/tasks/{task_id}")
def update_task(task_id: int, body: TaskUpdate, db=Depends(get_pg), _=Depends(ACCESS)):
    updates = {k: v for k, v in body.dict().items() if v is not None}
    if not updates:
        raise HTTPException(422, "No fields to update")
    updates["id"] = task_id
    set_clause = ", ".join(f"{k} = :{k}" for k in updates if k != "id")
    set_clause += ", updated_at = NOW()"
    row = db.execute(text(f"""
        UPDATE crm_tasks SET {set_clause} WHERE id = :id RETURNING *
    """), updates).fetchone()
    if not row:
        raise HTTPException(404, "Task not found")
    db.commit()
    return _row(row)


@router.delete("/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, db=Depends(get_pg), _=Depends(ACCESS)):
    db.execute(text("DELETE FROM crm_tasks WHERE id = :id"), {"id": task_id})
    db.commit()
