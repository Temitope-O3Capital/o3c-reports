"""
contact_lists.py — Reusable audience lists for campaigns

GET    /api/contact-lists                        list all contact lists
POST   /api/contact-lists                        create list
GET    /api/contact-lists/{id}                   detail + members (paginated)
PUT    /api/contact-lists/{id}                   update name/description
DELETE /api/contact-lists/{id}                   delete list + members
POST   /api/contact-lists/{id}/members           add single member
POST   /api/contact-lists/{id}/upload            upload CSV (bulk add)
DELETE /api/contact-lists/{id}/members/{mid}     remove member
"""
import csv
import io
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy import text
from core.auth import require_pages
from core.database import get_db_pg

router = APIRouter()
ACCESS = require_pages(["campaigns"])


def _now():
    return datetime.now(timezone.utc)


class ListCreate(BaseModel):
    name:        str
    description: Optional[str] = None


class MemberCreate(BaseModel):
    first_name: Optional[str] = None
    last_name:  Optional[str] = None
    phone:      Optional[str] = None
    email:      Optional[str] = None
    cif_number: Optional[str] = None
    merge_data: dict          = {}


def _list_row(row) -> dict:
    return {
        "id":           row.id,
        "name":         row.name,
        "description":  row.description,
        "source":       row.source,
        "member_count": row.member_count,
        "created_by":   row.created_by,
        "created_at":   row.created_at.isoformat() if row.created_at else None,
        "updated_at":   row.updated_at.isoformat() if row.updated_at else None,
    }


def _member_row(row) -> dict:
    return {
        "id":         row.id,
        "list_id":    row.list_id,
        "first_name": row.first_name,
        "last_name":  row.last_name,
        "phone":      row.phone,
        "email":      row.email,
        "cif_number": row.cif_number,
        "merge_data": row.merge_data or {},
        "status":     row.status,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _sync_count(db, list_id: int):
    row = db.execute(text(
        "SELECT COUNT(*) AS n FROM contact_list_members WHERE list_id=:id AND status='active'"
    ), {"id": list_id}).fetchone()
    db.execute(text("UPDATE contact_lists SET member_count=:n, updated_at=NOW() WHERE id=:id"),
               {"n": row.n if row else 0, "id": list_id})


# ── Lists ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_contact_lists(
    limit: int = Query(100, ge=1, le=500),
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    rows = db.execute(text("""
        SELECT cl.*, u.full_name AS created_by_name
        FROM contact_lists cl
        LEFT JOIN o3c_users u ON cl.created_by=u.id
        ORDER BY cl.created_at DESC LIMIT :lim
    """), {"lim": limit}).fetchall()
    result = []
    for row in rows:
        d = _list_row(row)
        d["created_by_name"] = row.created_by_name
        result.append(d)
    return result


@router.post("", status_code=201)
def create_list(
    body: ListCreate, db = Depends(get_db_pg), user = Depends(ACCESS)
):
    row = db.execute(text("""
        INSERT INTO contact_lists (name, description, created_by)
        VALUES (:name, :desc, :by) RETURNING *
    """), {"name": body.name, "desc": body.description, "by": user["id"]}).fetchone()
    db.commit()
    return _list_row(row)


@router.get("/{list_id}")
def get_list(
    list_id: int,
    limit:  int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    search: Optional[str] = Query(None),
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    lst = db.execute(text("SELECT * FROM contact_lists WHERE id=:id"), {"id": list_id}).fetchone()
    if not lst:
        raise HTTPException(404, "List not found")

    where = "WHERE list_id=:id AND status='active'"
    params = {"id": list_id, "lim": limit, "off": offset}
    if search:
        where += " AND (first_name ILIKE :q OR last_name ILIKE :q OR phone ILIKE :q OR email ILIKE :q)"
        params["q"] = f"%{search}%"

    total = db.execute(text(f"SELECT COUNT(*) AS n FROM contact_list_members {where}"), params).fetchone()
    members = db.execute(text(f"""
        SELECT * FROM contact_list_members {where} ORDER BY id ASC LIMIT :lim OFFSET :off
    """), params).fetchall()

    d = _list_row(lst)
    d["total_members"] = total.n if total else 0
    d["members"]       = [_member_row(m) for m in members]
    return d


@router.put("/{list_id}")
def update_list(
    list_id: int, body: ListCreate,
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    if not db.execute(text("SELECT 1 FROM contact_lists WHERE id=:id"), {"id": list_id}).fetchone():
        raise HTTPException(404, "List not found")
    db.execute(text("""
        UPDATE contact_lists SET name=:name, description=:desc, updated_at=NOW() WHERE id=:id
    """), {"name": body.name, "desc": body.description, "id": list_id})
    db.commit()
    row = db.execute(text("SELECT * FROM contact_lists WHERE id=:id"), {"id": list_id}).fetchone()
    return _list_row(row)


@router.delete("/{list_id}", status_code=204)
def delete_list(
    list_id: int, db = Depends(get_db_pg), user = Depends(ACCESS)
):
    if not db.execute(text("SELECT 1 FROM contact_lists WHERE id=:id"), {"id": list_id}).fetchone():
        raise HTTPException(404, "List not found")
    db.execute(text("DELETE FROM contact_list_members WHERE list_id=:id"), {"id": list_id})
    db.execute(text("DELETE FROM contact_lists WHERE id=:id"), {"id": list_id})
    db.commit()


# ── Members ───────────────────────────────────────────────────────────────────

@router.post("/{list_id}/members", status_code=201)
def add_member(
    list_id: int, body: MemberCreate,
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    if not db.execute(text("SELECT 1 FROM contact_lists WHERE id=:id"), {"id": list_id}).fetchone():
        raise HTTPException(404, "List not found")
    import json as _json
    row = db.execute(text("""
        INSERT INTO contact_list_members
            (list_id, first_name, last_name, phone, email, cif_number, merge_data)
        VALUES (:lid, :fn, :ln, :phone, :email, :cif, :md::jsonb)
        RETURNING *
    """), {
        "lid":   list_id,
        "fn":    body.first_name,
        "ln":    body.last_name,
        "phone": body.phone,
        "email": body.email,
        "cif":   body.cif_number,
        "md":    _json.dumps(body.merge_data),
    }).fetchone()
    _sync_count(db, list_id)
    db.commit()
    return _member_row(row)


@router.post("/{list_id}/upload")
async def upload_csv(
    list_id: int,
    file: UploadFile = File(...),
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    """
    Upload a CSV to bulk-add contacts to a list.

    Required columns (at least one of phone/email):
      first_name, last_name, phone, email, cif_number

    Any extra columns are stored in merge_data (e.g. amount, due_date).
    """
    if not db.execute(text("SELECT 1 FROM contact_lists WHERE id=:id"), {"id": list_id}).fetchone():
        raise HTTPException(404, "List not found")
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "File must be a CSV")

    import json as _json
    content = await file.read()
    text_content = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text_content))

    KNOWN = {"first_name","last_name","phone","email","cif_number"}
    inserted = 0
    errors   = []

    for i, row in enumerate(reader, 1):
        row = {k.strip().lower().replace(" ", "_"): (v.strip() if v else "") for k, v in row.items()}
        phone = row.get("phone", "") or None
        email = row.get("email", "") or None
        if not phone and not email:
            errors.append(f"Row {i}: no phone or email — skipped")
            continue
        merge = {k: v for k, v in row.items() if k not in KNOWN and v}
        try:
            db.execute(text("""
                INSERT INTO contact_list_members
                    (list_id, first_name, last_name, phone, email, cif_number, merge_data)
                VALUES (:lid, :fn, :ln, :phone, :email, :cif, :md::jsonb)
            """), {
                "lid":   list_id,
                "fn":    row.get("first_name") or None,
                "ln":    row.get("last_name")  or None,
                "phone": phone,
                "email": email,
                "cif":   row.get("cif_number") or None,
                "md":    _json.dumps(merge),
            })
            inserted += 1
        except Exception as e:
            errors.append(f"Row {i}: {str(e)[:80]}")

    _sync_count(db, list_id)
    db.execute(text(
        "UPDATE contact_lists SET source='csv', updated_at=NOW() WHERE id=:id"
    ), {"id": list_id})
    db.commit()
    return {"inserted": inserted, "errors": errors[:20]}


@router.delete("/{list_id}/members/{member_id}", status_code=204)
def remove_member(
    list_id: int, member_id: int,
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    if not db.execute(
        text("SELECT 1 FROM contact_list_members WHERE id=:id AND list_id=:lid"),
        {"id": member_id, "lid": list_id}
    ).fetchone():
        raise HTTPException(404, "Member not found")
    db.execute(text("DELETE FROM contact_list_members WHERE id=:id"), {"id": member_id})
    _sync_count(db, list_id)
    db.commit()
