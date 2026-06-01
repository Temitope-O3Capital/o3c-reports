"""
crm_contacts.py — Contact management + Customer 360
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import text
from core.database import get_db_pg as get_pg
from core.auth import require_pages

router = APIRouter()
CRM_PAGES = ["crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports"]
ACCESS = require_pages(CRM_PAGES)


class ContactCreate(BaseModel):
    first_name:    str
    last_name:     str
    phone:         Optional[str] = None
    email:         Optional[str] = None
    state:         Optional[str] = None
    city:          Optional[str] = None
    address:       Optional[str] = None
    date_of_birth: Optional[str] = None
    gender:        Optional[str] = None
    occupation:    Optional[str] = None
    employer:      Optional[str] = None
    income_range:  Optional[str] = None
    id_type:       Optional[str] = None
    id_number:     Optional[str] = None
    source:        Optional[str] = "walk_in"
    cif_number:    Optional[str] = None
    status:        Optional[str] = "lead"
    assigned_to:   Optional[int] = None
    tags:          Optional[str] = None
    notes:         Optional[str] = None


class ContactUpdate(BaseModel):
    first_name:    Optional[str] = None
    last_name:     Optional[str] = None
    phone:         Optional[str] = None
    email:         Optional[str] = None
    state:         Optional[str] = None
    city:          Optional[str] = None
    address:       Optional[str] = None
    date_of_birth: Optional[str] = None
    gender:        Optional[str] = None
    occupation:    Optional[str] = None
    employer:      Optional[str] = None
    income_range:  Optional[str] = None
    id_type:       Optional[str] = None
    id_number:     Optional[str] = None
    source:        Optional[str] = None
    cif_number:    Optional[str] = None
    status:        Optional[str] = None
    assigned_to:   Optional[int] = None
    tags:          Optional[str] = None
    notes:         Optional[str] = None


def _row(r) -> dict:
    return dict(r._mapping)


@router.get("/contacts")
def list_contacts(
    q:          Optional[str] = Query(None),
    status:     Optional[str] = Query(None),
    assigned_to: Optional[int] = Query(None),
    source:     Optional[str] = Query(None),
    limit:      int = Query(100, le=500),
    offset:     int = Query(0),
    db=Depends(get_pg),
    _=Depends(ACCESS),
):
    filters = ["1=1"]
    params  = {"limit": limit, "offset": offset}

    if q:
        filters.append("""(
            c.first_name ILIKE :q OR c.last_name ILIKE :q OR
            c.phone ILIKE :q OR c.email ILIKE :q OR c.cif_number ILIKE :q
        )""")
        params["q"] = f"%{q}%"
    if status:
        filters.append("c.status = :status")
        params["status"] = status
    if assigned_to:
        filters.append("c.assigned_to = :assigned_to")
        params["assigned_to"] = assigned_to
    if source:
        filters.append("c.source = :source")
        params["source"] = source

    where = " AND ".join(filters)
    rows = db.execute(text(f"""
        SELECT c.*,
               u.full_name  AS assigned_name,
               cb.full_name AS created_by_name,
               (SELECT COUNT(*) FROM crm_deals d WHERE d.contact_id = c.id)     AS deal_count,
               (SELECT COUNT(*) FROM crm_activities a WHERE a.contact_id = c.id) AS activity_count,
               (SELECT COUNT(*) FROM crm_tasks t WHERE t.contact_id = c.id AND t.status = 'open') AS open_tasks
        FROM crm_contacts c
        LEFT JOIN o3c_users u  ON u.id  = c.assigned_to
        LEFT JOIN o3c_users cb ON cb.id = c.created_by
        WHERE {where}
        ORDER BY c.updated_at DESC
        LIMIT :limit OFFSET :offset
    """), params).fetchall()

    total = db.execute(text(f"""
        SELECT COUNT(*) FROM crm_contacts c WHERE {where}
    """), {k: v for k, v in params.items() if k not in ("limit", "offset")}).scalar()

    return {"data": [_row(r) for r in rows], "total": total}


@router.post("/contacts", status_code=201)
def create_contact(body: ContactCreate, db=Depends(get_pg), user=Depends(ACCESS)):
    row = db.execute(text("""
        INSERT INTO crm_contacts
          (first_name, last_name, phone, email, state, city, address,
           date_of_birth, gender, occupation, employer, income_range,
           id_type, id_number, source, cif_number, status,
           assigned_to, tags, notes, created_by)
        VALUES
          (:first_name, :last_name, :phone, :email, :state, :city, :address,
           :dob, :gender, :occupation, :employer, :income_range,
           :id_type, :id_number, :source, :cif_number, :status,
           :assigned_to, :tags, :notes, :created_by)
        RETURNING *
    """), {
        **body.dict(exclude={"date_of_birth"}),
        "dob": body.date_of_birth or None,
        "created_by": user.get("id"),
    }).fetchone()
    db.commit()
    return _row(row)


@router.get("/contacts/{contact_id}")
def get_contact(contact_id: int, db=Depends(get_pg), _=Depends(ACCESS)):
    row = db.execute(text("""
        SELECT c.*,
               u.full_name  AS assigned_name,
               cb.full_name AS created_by_name
        FROM crm_contacts c
        LEFT JOIN o3c_users u  ON u.id  = c.assigned_to
        LEFT JOIN o3c_users cb ON cb.id = c.created_by
        WHERE c.id = :id
    """), {"id": contact_id}).fetchone()
    if not row:
        raise HTTPException(404, "Contact not found")
    return _row(row)


@router.put("/contacts/{contact_id}")
def update_contact(contact_id: int, body: ContactUpdate, db=Depends(get_pg), _=Depends(ACCESS)):
    updates = {k: v for k, v in body.dict().items() if v is not None}
    if "date_of_birth" in updates:
        updates["date_of_birth"] = updates["date_of_birth"] or None
    if not updates:
        raise HTTPException(422, "No fields to update")
    updates["id"] = contact_id
    updates["now"] = "NOW()"
    set_clause = ", ".join(f"{k} = :{k}" for k in updates if k not in ("id", "now"))
    set_clause += ", updated_at = NOW()"
    row = db.execute(text(f"""
        UPDATE crm_contacts SET {set_clause} WHERE id = :id RETURNING *
    """), updates).fetchone()
    if not row:
        raise HTTPException(404, "Contact not found")
    db.commit()
    return _row(row)


@router.delete("/contacts/{contact_id}", status_code=204)
def delete_contact(contact_id: int, db=Depends(get_pg), _=Depends(ACCESS)):
    db.execute(text("DELETE FROM crm_contacts WHERE id = :id"), {"id": contact_id})
    db.commit()


@router.get("/contacts/{contact_id}/360")
def customer_360(contact_id: int, db=Depends(get_pg), _=Depends(ACCESS)):
    """Full customer view: CRM data + reporting data joined via CIF Number."""
    contact = db.execute(text("""
        SELECT c.*, u.full_name AS assigned_name
        FROM crm_contacts c
        LEFT JOIN o3c_users u ON u.id = c.assigned_to
        WHERE c.id = :id
    """), {"id": contact_id}).fetchone()
    if not contact:
        raise HTTPException(404, "Contact not found")

    c = _row(contact)
    cif = c.get("cif_number")

    activities = db.execute(text("""
        SELECT a.*, u.full_name AS agent_name
        FROM crm_activities a
        LEFT JOIN o3c_users u ON u.id = a.created_by
        WHERE a.contact_id = :id
        ORDER BY a.created_at DESC LIMIT 50
    """), {"id": contact_id}).fetchall()

    deals = db.execute(text("""
        SELECT d.*, s.name AS stage_name, s.color AS stage_color,
               u.full_name AS assigned_name
        FROM crm_deals d
        LEFT JOIN crm_pipeline_stages s ON s.id = d.stage_id
        LEFT JOIN o3c_users u ON u.id = d.assigned_to
        WHERE d.contact_id = :id
        ORDER BY d.updated_at DESC
    """), {"id": contact_id}).fetchall()

    tasks = db.execute(text("""
        SELECT t.*, u.full_name AS assigned_name
        FROM crm_tasks t
        LEFT JOIN o3c_users u ON u.id = t.assigned_to
        WHERE t.contact_id = :id
        ORDER BY t.due_date ASC NULLS LAST
    """), {"id": contact_id}).fetchall()

    requests = db.execute(text("""
        SELECT r.*, u.full_name AS assigned_name
        FROM crm_requests r
        LEFT JOIN o3c_users u ON u.id = r.assigned_to
        WHERE r.contact_id = :id
        ORDER BY r.created_at DESC
    """), {"id": contact_id}).fetchall()

    # Reporting data (from Accounts/Transactions/Collections via CIF)
    transactions, collections_history, account_info = [], [], None
    if cif:
        account_info = db.execute(text("""
            SELECT a.*, p."Product Name", p."Account Status", p."Account Manager"
            FROM "Accounts" a
            LEFT JOIN "Products" p ON p."CIF Number" = a."CIF Number"
            WHERE a."CIF Number" = :cif LIMIT 1
        """), {"cif": cif}).fetchone()

        transactions = db.execute(text("""
            SELECT "Transaction Date", "Amount", "Description", "Merchant_Name"
            FROM "Transactions"
            WHERE "CIF Number" = :cif
            ORDER BY "Transaction Date" DESC LIMIT 30
        """), {"cif": cif}).fetchall()

        collections_history = db.execute(text("""
            SELECT "Date", "Amount", "Mode Of Payment", "Agent", "Payment Receipt"
            FROM "Collections Log"
            WHERE "CIF" = :cif
            ORDER BY "Date" DESC LIMIT 20
        """), {"cif": cif}).fetchall()

    return {
        "contact":      c,
        "account_info": _row(account_info) if account_info else None,
        "deals":        [_row(r) for r in deals],
        "activities":   [_row(r) for r in activities],
        "tasks":        [_row(r) for r in tasks],
        "requests":     [_row(r) for r in requests],
        "transactions": [_row(r) for r in transactions],
        "collections":  [_row(r) for r in collections_history],
    }
