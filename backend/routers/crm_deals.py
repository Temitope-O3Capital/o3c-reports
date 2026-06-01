"""
crm_deals.py — Deal pipeline management
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import text
from core.database import get_db_pg as get_pg
from core.auth import require_pages

router  = APIRouter()
ACCESS  = require_pages(["crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports"])


class DealCreate(BaseModel):
    contact_id:          int
    title:               str
    stage_id:            Optional[int]  = None
    product:             Optional[str]  = None
    expected_value:      Optional[float] = None
    probability:         Optional[int]  = 50
    expected_close_date: Optional[str]  = None
    assigned_to:         Optional[int]  = None


class DealUpdate(BaseModel):
    title:               Optional[str]   = None
    stage_id:            Optional[int]   = None
    product:             Optional[str]   = None
    expected_value:      Optional[float] = None
    probability:         Optional[int]   = None
    expected_close_date: Optional[str]   = None
    lost_reason:         Optional[str]   = None
    assigned_to:         Optional[int]   = None


def _row(r): return dict(r._mapping)


@router.get("/stages")
def list_stages(db=Depends(get_pg), _=Depends(ACCESS)):
    rows = db.execute(text("SELECT * FROM crm_pipeline_stages ORDER BY order_index")).fetchall()
    return [_row(r) for r in rows]


@router.get("/pipeline")
def get_pipeline(db=Depends(get_pg), _=Depends(ACCESS)):
    """Returns all deals grouped by stage — used for Kanban board."""
    stages = db.execute(text(
        "SELECT * FROM crm_pipeline_stages ORDER BY order_index"
    )).fetchall()

    deals = db.execute(text("""
        SELECT d.*,
               s.name  AS stage_name,
               s.color AS stage_color,
               s.is_won, s.is_lost,
               c.first_name, c.last_name, c.phone, c.status AS contact_status,
               u.full_name AS assigned_name
        FROM crm_deals d
        JOIN  crm_pipeline_stages s ON s.id = d.stage_id
        JOIN  crm_contacts        c ON c.id = d.contact_id
        LEFT JOIN o3c_users       u ON u.id = d.assigned_to
        ORDER BY d.updated_at DESC
    """)).fetchall()

    by_stage = {s.id: [] for s in stages}
    for d in deals:
        row = _row(d)
        by_stage.setdefault(row["stage_id"], []).append(row)

    return {
        "stages": [_row(s) for s in stages],
        "deals":  by_stage,
    }


@router.get("/deals")
def list_deals(
    contact_id: Optional[int] = Query(None),
    stage_id:   Optional[int] = Query(None),
    limit:      int = Query(200, le=500),
    db=Depends(get_pg), _=Depends(ACCESS),
):
    filters = ["1=1"]
    params  = {"limit": limit}
    if contact_id:
        filters.append("d.contact_id = :contact_id")
        params["contact_id"] = contact_id
    if stage_id:
        filters.append("d.stage_id = :stage_id")
        params["stage_id"] = stage_id

    rows = db.execute(text(f"""
        SELECT d.*,
               s.name AS stage_name, s.color AS stage_color,
               c.first_name, c.last_name,
               u.full_name AS assigned_name
        FROM crm_deals d
        LEFT JOIN crm_pipeline_stages s ON s.id = d.stage_id
        LEFT JOIN crm_contacts        c ON c.id = d.contact_id
        LEFT JOIN o3c_users           u ON u.id = d.assigned_to
        WHERE {" AND ".join(filters)}
        ORDER BY d.updated_at DESC
        LIMIT :limit
    """), params).fetchall()
    return [_row(r) for r in rows]


@router.post("/deals", status_code=201)
def create_deal(body: DealCreate, db=Depends(get_pg), user=Depends(ACCESS)):
    # Default to first non-won/non-lost stage if none provided
    if not body.stage_id:
        first = db.execute(text(
            "SELECT id FROM crm_pipeline_stages WHERE is_won=FALSE AND is_lost=FALSE ORDER BY order_index LIMIT 1"
        )).scalar()
        body.stage_id = first

    row = db.execute(text("""
        INSERT INTO crm_deals
          (contact_id, title, stage_id, product, expected_value,
           probability, expected_close_date, assigned_to, created_by)
        VALUES
          (:contact_id, :title, :stage_id, :product, :expected_value,
           :probability, :expected_close_date, :assigned_to, :created_by)
        RETURNING *
    """), {**body.dict(), "created_by": user.get("id")}).fetchone()
    db.commit()
    return _row(row)


@router.put("/deals/{deal_id}")
def update_deal(deal_id: int, body: DealUpdate, db=Depends(get_pg), _=Depends(ACCESS)):
    updates = {k: v for k, v in body.dict().items() if v is not None}
    if not updates:
        raise HTTPException(422, "No fields to update")
    updates["id"] = deal_id
    set_clause = ", ".join(f"{k} = :{k}" for k in updates if k != "id")
    set_clause += ", updated_at = NOW()"
    row = db.execute(text(f"""
        UPDATE crm_deals SET {set_clause} WHERE id = :id RETURNING *
    """), updates).fetchone()
    if not row:
        raise HTTPException(404, "Deal not found")
    db.commit()
    return _row(row)


@router.delete("/deals/{deal_id}", status_code=204)
def delete_deal(deal_id: int, db=Depends(get_pg), _=Depends(ACCESS)):
    db.execute(text("DELETE FROM crm_deals WHERE id = :id"), {"id": deal_id})
    db.commit()
