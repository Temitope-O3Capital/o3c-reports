"""
admin.py — User management + custom roles + activity log

GET    /api/admin/users                       list all users
POST   /api/admin/users                       create user
PUT    /api/admin/users/{id}                  update user
DELETE /api/admin/users/{id}                  delete user
POST   /api/admin/users/{id}/reset-password   reset password
GET    /api/admin/roles                       list custom roles
POST   /api/admin/roles                       create custom role
DELETE /api/admin/roles/{name}                delete custom role
GET    /api/admin/activity                    staff activity log
POST   /api/admin/activity                    log a user action
"""

import secrets
import string
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr
from typing import Optional, List
from sqlalchemy import text
import json

from core.auth import require_pages, hash_password
from core.database import get_db_pg as get_pg

router = APIRouter(prefix="/api/admin", tags=["admin"])

ADMIN_ACCESS = require_pages(["admin"])

STATIC_ROLES = {
    "md", "coo", "cfo", "head_it", "head_hr",
    "cmo", "head_ops", "head_sales", "head_collections", "head_recovery",
    "admin", "management", "collections", "sales",
    "cards_ops", "recovery", "call_centre",
}


def _valid_role(role: str, db) -> bool:
    if role in STATIC_ROLES:
        return True
    row = db.execute(text("SELECT 1 FROM o3c_custom_roles WHERE name = :n"), {"n": role}).fetchone()
    return row is not None


def _default_password() -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%"
    return ''.join(secrets.choice(alphabet) for _ in range(16))


def _row_to_dict(row) -> dict:
    return {
        "id":                   row.id,
        "email":                row.email,
        "full_name":            row.full_name,
        "role":                 row.role,
        "department":           row.department,
        "created_at":           row.created_at.isoformat() if row.created_at else None,
        "must_change_password": bool(row.must_change_password) if row.must_change_password is not None else True,
        "last_login":           row.last_login.isoformat() if getattr(row, "last_login", None) else None,
        "is_active":            bool(row.is_active) if getattr(row, "is_active", None) is not None else True,
        "deleted_at":           row.deleted_at.isoformat() if getattr(row, "deleted_at", None) else None,
    }


class UserCreate(BaseModel):
    full_name:  str
    email:      EmailStr
    role:       str = "call_centre"
    department: Optional[str] = None


class UserUpdate(BaseModel):
    full_name:  Optional[str]       = None
    email:      Optional[EmailStr]  = None
    password:   Optional[str]       = None
    role:       Optional[str]       = None
    department: Optional[str]       = None


@router.get("/users")
def list_users(
    include_removed: bool = False,
    db_pg=Depends(get_pg), _=Depends(ADMIN_ACCESS)
):
    where = "" if include_removed else "WHERE deleted_at IS NULL"
    rows = db_pg.execute(text(f"""
        SELECT id, email, full_name, role, department, created_at,
               must_change_password, last_login, is_active, deleted_at
        FROM o3c_users
        {where}
        ORDER BY created_at DESC
    """)).fetchall()
    return [_row_to_dict(r) for r in rows]


@router.post("/users", status_code=201)
def create_user(
    body:  UserCreate,
    db_pg  = Depends(get_pg),
    _      = Depends(ADMIN_ACCESS),
):
    if not _valid_role(body.role, db_pg):
        raise HTTPException(status_code=422, detail=f"Unknown role: {body.role}")

    existing = db_pg.execute(
        text("SELECT id FROM o3c_users WHERE email = :email"),
        {"email": body.email}
    ).fetchone()
    if existing:
        raise HTTPException(status_code=409, detail="A user with this email already exists.")

    temp_pw = _default_password()
    hashed  = hash_password(temp_pw)

    row = db_pg.execute(text("""
        INSERT INTO o3c_users
            (email, password_hash, full_name, role, department, must_change_password)
        VALUES (:email, :pw, :name, :role, :dept, TRUE)
        RETURNING id, email, full_name, role, department, created_at,
                  must_change_password, last_login
    """), {
        "email": body.email, "pw": hashed,
        "name": body.full_name, "role": body.role, "dept": body.department,
    }).fetchone()
    db_pg.commit()

    result = _row_to_dict(row)
    result["temp_password"] = temp_pw   # returned once only
    return result


@router.put("/users/{user_id}")
def update_user(
    user_id: int,
    body:    UserUpdate,
    db_pg    = Depends(get_pg),
    current  = Depends(ADMIN_ACCESS),
):
    if body.role and not _valid_role(body.role, db_pg):
        raise HTTPException(status_code=422, detail=f"Unknown role: {body.role}")

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

    updated = db_pg.execute(text("""
        SELECT id, email, full_name, role, department, created_at,
               must_change_password, last_login
        FROM o3c_users WHERE id = :id
    """), {"id": user_id}).fetchone()
    return _row_to_dict(updated)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    db_pg    = Depends(get_pg),
    current  = Depends(ADMIN_ACCESS),
):
    """Soft-delete — preserves audit trail. Use /remove for the same effect via PATCH."""
    if current.get("id") and int(current["id"]) == user_id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    row = db_pg.execute(
        text("SELECT id FROM o3c_users WHERE id = :id AND deleted_at IS NULL"), {"id": user_id}
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    db_pg.execute(
        text("UPDATE o3c_users SET is_active=FALSE, deleted_at=NOW() WHERE id=:id"),
        {"id": user_id}
    )
    db_pg.commit()


@router.patch("/users/{user_id}/deactivate")
def deactivate_user(
    user_id: int,
    db_pg    = Depends(get_pg),
    current  = Depends(ADMIN_ACCESS),
):
    if current.get("id") and int(current["id"]) == user_id:
        raise HTTPException(400, "Cannot deactivate your own account")
    row = db_pg.execute(text("SELECT id FROM o3c_users WHERE id=:id AND deleted_at IS NULL"), {"id": user_id}).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    db_pg.execute(text("UPDATE o3c_users SET is_active=FALSE WHERE id=:id"), {"id": user_id})
    db_pg.commit()
    return {"detail": "User deactivated"}


@router.patch("/users/{user_id}/reactivate")
def reactivate_user(
    user_id: int,
    db_pg    = Depends(get_pg),
    _        = Depends(ADMIN_ACCESS),
):
    db_pg.execute(text("UPDATE o3c_users SET is_active=TRUE WHERE id=:id"), {"id": user_id})
    db_pg.commit()
    return {"detail": "User reactivated"}


@router.patch("/users/{user_id}/remove")
def remove_user(
    user_id: int,
    db_pg    = Depends(get_pg),
    current  = Depends(ADMIN_ACCESS),
):
    """Soft-delete a staff member. They cannot log in but their name is preserved
    in all audit logs and historical reports."""
    if current.get("id") and int(current["id"]) == user_id:
        raise HTTPException(400, "Cannot remove your own account")
    row = db_pg.execute(text("SELECT id FROM o3c_users WHERE id=:id"), {"id": user_id}).fetchone()
    if not row:
        raise HTTPException(404, "User not found")
    db_pg.execute(
        text("UPDATE o3c_users SET is_active=FALSE, deleted_at=NOW() WHERE id=:id"),
        {"id": user_id}
    )
    db_pg.commit()
    return {"detail": "User removed from system"}


@router.post("/users/{user_id}/reset-password")
def reset_password(
    user_id: int,
    db_pg    = Depends(get_pg),
    _        = Depends(ADMIN_ACCESS),
):
    row = db_pg.execute(
        text("SELECT id FROM o3c_users WHERE id = :id"), {"id": user_id}
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")

    temp_pw = _default_password()
    db_pg.execute(text("""
        UPDATE o3c_users
        SET password_hash = :pw, must_change_password = TRUE
        WHERE id = :id
    """), {"pw": hash_password(temp_pw), "id": user_id})
    db_pg.commit()
    return {"temp_password": temp_pw}


# ── Custom roles ──────────────────────────────────────────────────────────────

class RoleCreate(BaseModel):
    name:  str
    label: str
    pages: List[str] = []


@router.get("/roles")
def list_custom_roles(db_pg=Depends(get_pg), _=Depends(ADMIN_ACCESS)):
    rows = db_pg.execute(text(
        "SELECT id, name, label, pages, created_at FROM o3c_custom_roles ORDER BY created_at DESC"
    )).fetchall()
    result = []
    for r in rows:
        pages = r.pages if isinstance(r.pages, list) else json.loads(r.pages or "[]")
        result.append({"id": r.id, "name": r.name, "label": r.label, "pages": pages})
    return result


@router.post("/roles", status_code=201)
def create_custom_role(body: RoleCreate, db_pg=Depends(get_pg), _=Depends(ADMIN_ACCESS)):
    slug = body.name.strip().lower().replace(" ", "_")
    if not slug:
        raise HTTPException(422, "Role name is required")
    if slug in STATIC_ROLES:
        raise HTTPException(409, f"'{slug}' is a built-in role name")
    existing = db_pg.execute(text("SELECT 1 FROM o3c_custom_roles WHERE name = :n"), {"n": slug}).fetchone()
    if existing:
        raise HTTPException(409, f"Role '{slug}' already exists")
    db_pg.execute(text(
        "INSERT INTO o3c_custom_roles (name, label, pages) VALUES (:n, :l, :p)"
    ), {"n": slug, "l": body.label.strip(), "p": json.dumps(body.pages)})
    db_pg.commit()
    return {"name": slug, "label": body.label.strip(), "pages": body.pages}


@router.delete("/roles/{role_name}", status_code=204)
def delete_custom_role(role_name: str, db_pg=Depends(get_pg), _=Depends(ADMIN_ACCESS)):
    db_pg.execute(text("DELETE FROM o3c_custom_roles WHERE name = :n"), {"n": role_name})
    db_pg.commit()


# ── Staff activity log ────────────────────────────────────────────────────────

class ActivityCreate(BaseModel):
    page:   str
    action: str = "view"
    detail: Optional[str] = None


@router.post("/activity", status_code=204)
def log_activity(
    body:    ActivityCreate,
    request: Request,
    db_pg    = Depends(get_pg),
    user     = Depends(require_pages(["overview"])),   # any authenticated user
):
    # Use rightmost X-Forwarded-For — Railway appends the real IP last; leftmost is attacker-controlled
    fwd = request.headers.get("X-Forwarded-For", "")
    ip  = fwd.split(",")[-1].strip() if fwd else (request.client.host if request.client else None)
    try:
        db_pg.execute(text("""
            INSERT INTO o3c_activity_log (user_id, page, action, detail, ip)
            VALUES (:uid, :page, :action, :detail, :ip)
        """), {"uid": user.get("id"), "page": body.page, "action": body.action,
               "detail": body.detail, "ip": ip})
        db_pg.commit()
    except Exception:
        pass   # activity logging must never fail a user request


@router.get("/activity")
def get_activity(
    limit:   int = 200,
    user_id: Optional[int] = None,
    page:    Optional[str] = None,
    db_pg    = Depends(get_pg),
    _        = Depends(ADMIN_ACCESS),
):
    filters = []
    params  = {"limit": min(limit, 1000)}
    if user_id: filters.append("a.user_id = :uid");  params["uid"]  = user_id
    if page:    filters.append("a.page = :page");     params["page"] = page
    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    rows = db_pg.execute(text(f"""
        SELECT a.id, a.page, a.action, a.detail, a.ip, a.ts,
               u.full_name, u.email, u.role
        FROM o3c_activity_log a
        LEFT JOIN o3c_users u ON u.id = a.user_id
        {where}
        ORDER BY a.ts DESC
        LIMIT :limit
    """), params).fetchall()
    return [dict(r._mapping) for r in rows]
