"""
admin.py — User management endpoints (admin role only)

GET    /api/admin/users         list all users
POST   /api/admin/users         create user
PUT    /api/admin/users/{id}    update user (role, department, name, email, password)
DELETE /api/admin/users/{id}    delete user
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from typing import Optional
from sqlalchemy import text

from core.auth import require_pages, hash_password
from core.database import get_pg

router = APIRouter(prefix="/api/admin", tags=["admin"])


class UserCreate(BaseModel):
    full_name:  str
    email:      EmailStr
    password:   str
    role:       str = "call_centre"
    department: Optional[str] = None


class UserUpdate(BaseModel):
    full_name:  Optional[str]       = None
    email:      Optional[EmailStr]  = None
    password:   Optional[str]       = None
    role:       Optional[str]       = None
    department: Optional[str]       = None


VALID_ROLES = {"admin","management","collections","sales","cards_ops","recovery","call_centre"}


def _row_to_dict(row) -> dict:
    return {
        "id":         row.id,
        "email":      row.email,
        "full_name":  row.full_name,
        "role":       row.role,
        "department": row.department,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.get("/users")
def list_users(
    db_pg=Depends(get_pg),
    _user=Depends(require_pages(["admin"])),
):
    rows = db_pg.execute(
        text("SELECT id, email, full_name, role, department, created_at FROM o3c_users ORDER BY created_at DESC")
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


@router.post("/users", status_code=201)
def create_user(
    body: UserCreate,
    db_pg=Depends(get_pg),
    _user=Depends(require_pages(["admin"])),
):
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"Invalid role: {body.role}")

    existing = db_pg.execute(
        text("SELECT id FROM o3c_users WHERE email = :email"),
        {"email": body.email}
    ).fetchone()
    if existing:
        raise HTTPException(status_code=409, detail="A user with this email already exists.")

    hashed = hash_password(body.password)
    db_pg.execute(
        text("""
            INSERT INTO o3c_users (email, password_hash, full_name, role, department)
            VALUES (:email, :pw, :name, :role, :dept)
        """),
        {"email": body.email, "pw": hashed, "name": body.full_name,
         "role": body.role, "dept": body.department},
    )
    db_pg.commit()
    row = db_pg.execute(
        text("SELECT id, email, full_name, role, department, created_at FROM o3c_users WHERE email = :email"),
        {"email": body.email}
    ).fetchone()
    return _row_to_dict(row)


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    body: UserUpdate,
    db_pg=Depends(get_pg),
    current=Depends(require_pages(["admin"])),
):
    if body.role and body.role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"Invalid role: {body.role}")

    row = db_pg.execute(
        text("SELECT id FROM o3c_users WHERE id = :id"), {"id": user_id}
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    updates = {}
    if body.full_name  is not None: updates["full_name"]  = body.full_name
    if body.email      is not None: updates["email"]      = body.email
    if body.role       is not None: updates["role"]       = body.role
    if body.department is not None: updates["department"] = body.department
    if body.password:               updates["password_hash"] = hash_password(body.password)

    if not updates:
        raise HTTPException(status_code=422, detail="No fields to update")

    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["id"] = user_id
    db_pg.execute(text(f"UPDATE o3c_users SET {set_clause} WHERE id = :id"), updates)
    db_pg.commit()

    updated = db_pg.execute(
        text("SELECT id, email, full_name, role, department, created_at FROM o3c_users WHERE id = :id"),
        {"id": user_id}
    ).fetchone()
    return _row_to_dict(updated)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    db_pg=Depends(get_pg),
    current=Depends(require_pages(["admin"])),
):
    # Prevent self-deletion
    if current.get("sub") and str(user_id) == str(current.get("id")):
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    row = db_pg.execute(
        text("SELECT id FROM o3c_users WHERE id = :id"), {"id": user_id}
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    db_pg.execute(text("DELETE FROM o3c_users WHERE id = :id"), {"id": user_id})
    db_pg.commit()
