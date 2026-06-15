"""
loan_applications.py — Sales & Risk loan document workflow

Sales creates applications, assigns them, tracks documents.
Risk reviews docs and advances the pipeline stage.
Both roles can leave comments. All actions are logged.

Stages: new → submitted → doc_collection → under_review →
        finance_review → approved → rejected | on_hold
"""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import text
from core.auth import require_pages, get_current_user
from core.database import get_db_pg as get_pg

router = APIRouter()

ACCESS = require_pages(["loans"])

LOAN_TYPES = ["Personal Loan", "Business Loan", "Asset Finance", "Salary Advance", "Other"]
DOC_TYPES  = [
    "Valid Government ID",
    "Utility Bill (Proof of Address)",
    "Bank Statement (3-6 months)",
    "Pay Slip / Proof of Income",
    "Employment Letter",
    "Guarantor Form",
    "Business Registration (CAC)",
    "BVN Verification",
    "Credit Bureau Report",
    "Other",
]
STAGES = [
    "new", "submitted", "doc_collection",
    "under_review", "finance_review",
    "approved", "rejected", "on_hold",
]
# Legacy status field kept for backward compat
STATUSES = ["pending", "under_review", "approved", "rejected"]


def _now():
    return datetime.now(timezone.utc)


def _ref_no(db) -> str:
    year = _now().year
    row = db.execute(text(
        "SELECT COUNT(*)+1 AS n FROM loan_applications WHERE EXTRACT(year FROM created_at)=:y"
    ), {"y": year}).fetchone()
    n = row.n if row else 1
    return f"LA-{year}-{n:04d}"


def _log(db, app_id: int, user_id: int, user_name: str, action: str,
         old_value: str = None, new_value: str = None, note: str = None):
    db.execute(text("""
        INSERT INTO loan_activity_log
            (application_id, user_id, user_name, action, old_value, new_value, note)
        VALUES (:aid, :uid, :uname, :action, :old, :new, :note)
    """), {
        "aid": app_id, "uid": user_id, "uname": user_name,
        "action": action, "old": old_value, "new": new_value, "note": note,
    })


def _app_row(row) -> dict:
    return {
        "id":          row.id,
        "ref_no":      row.ref_no,
        "cif":         row.cif,
        "first_name":  row.first_name,
        "last_name":   row.last_name,
        "phone":       row.phone,
        "email":       row.email,
        "loan_type":   row.loan_type,
        "loan_amount": float(row.loan_amount) if row.loan_amount else None,
        "purpose":     row.purpose,
        "status":      row.status,
        "stage":       getattr(row, "stage", "new"),
        "notes":       row.notes,
        "assigned_to": getattr(row, "assigned_to", None),
        "created_by":  row.created_by,
        "reviewed_by": row.reviewed_by,
        "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at else None,
        "created_at":  row.created_at.isoformat() if row.created_at else None,
        "updated_at":  row.updated_at.isoformat() if row.updated_at else None,
    }


def _doc_row(row) -> dict:
    return {
        "id":             row.id,
        "application_id": row.application_id,
        "doc_type":       row.doc_type,
        "filename":       row.filename,
        "notes":          row.notes,
        "status":         row.status,
        "confirmed_by":   row.confirmed_by,
        "confirmed_at":   row.confirmed_at.isoformat() if row.confirmed_at else None,
        "created_at":     row.created_at.isoformat() if row.created_at else None,
    }


# ── Pydantic models ───────────────────────────────────────────────────────────

class AppCreate(BaseModel):
    first_name:  str
    last_name:   str
    cif:         Optional[str]   = None
    phone:       Optional[str]   = None
    email:       Optional[str]   = None
    loan_type:   str             = "Personal Loan"
    loan_amount: Optional[float] = None
    purpose:     Optional[str]   = None
    assigned_to: Optional[int]   = None
    stage:       str             = "new"


class AppUpdate(BaseModel):
    status:      Optional[str] = None
    stage:       Optional[str] = None
    notes:       Optional[str] = None
    assigned_to: Optional[int] = None


class DocCreate(BaseModel):
    doc_type: str
    filename: Optional[str] = None
    notes:    Optional[str] = None


class DocUpdate(BaseModel):
    status: str
    notes:  Optional[str] = None


class CommentCreate(BaseModel):
    body: str


# ── Applications ──────────────────────────────────────────────────────────────

@router.get("/applications")
def list_applications(
    status:      Optional[str] = Query(None),
    stage:       Optional[str] = Query(None),
    assigned_to: Optional[int] = Query(None),
    limit:       int           = Query(200, ge=1, le=500),
    db = Depends(get_pg), user = Depends(ACCESS)
):
    where = "WHERE 1=1"
    params: dict = {"lim": limit}
    if status:
        where += " AND a.status=:status"; params["status"] = status
    if stage:
        where += " AND a.stage=:stage"; params["stage"] = stage
    if assigned_to:
        where += " AND a.assigned_to=:assigned_to"; params["assigned_to"] = assigned_to

    rows = db.execute(text(f"""
        SELECT a.*,
               c.full_name  AS created_by_name,
               r.full_name  AS reviewed_by_name,
               ax.full_name AS assigned_to_name,
               (SELECT COUNT(*) FROM loan_documents d WHERE d.application_id=a.id) AS doc_count,
               (SELECT COUNT(*) FROM loan_documents d WHERE d.application_id=a.id AND d.status='confirmed') AS confirmed_count
        FROM loan_applications a
        LEFT JOIN o3c_users c  ON a.created_by=c.id
        LEFT JOIN o3c_users r  ON a.reviewed_by=r.id
        LEFT JOIN o3c_users ax ON a.assigned_to=ax.id
        {where}
        ORDER BY a.created_at DESC
        LIMIT :lim
    """), params).fetchall()

    result = []
    for row in rows:
        d = _app_row(row)
        d["created_by_name"]  = row.created_by_name
        d["reviewed_by_name"] = row.reviewed_by_name
        d["assigned_to_name"] = row.assigned_to_name
        d["doc_count"]        = row.doc_count
        d["confirmed_count"]  = row.confirmed_count
        result.append(d)
    return result


@router.post("/applications", status_code=201)
def create_application(
    body: AppCreate, db = Depends(get_pg), user = Depends(ACCESS)
):
    if body.loan_type not in LOAN_TYPES:
        raise HTTPException(422, f"Invalid loan_type. Options: {LOAN_TYPES}")
    if body.stage not in STAGES:
        raise HTTPException(422, f"Invalid stage. Options: {STAGES}")
    ref = _ref_no(db)
    row = db.execute(text("""
        INSERT INTO loan_applications
            (ref_no, cif, first_name, last_name, phone, email,
             loan_type, loan_amount, purpose, created_by, assigned_to, stage)
        VALUES
            (:ref, :cif, :fn, :ln, :phone, :email,
             :ltype, :amt, :purpose, :by, :assigned_to, :stage)
        RETURNING *
    """), {
        "ref":  ref,
        "cif":  body.cif or None,
        "fn":   body.first_name,
        "ln":   body.last_name,
        "phone": body.phone or None,
        "email": body.email or None,
        "ltype": body.loan_type,
        "amt":   body.loan_amount,
        "purpose": body.purpose or None,
        "by":  user["id"],
        "assigned_to": body.assigned_to,
        "stage": body.stage,
    }).fetchone()
    _log(db, row.id, user["id"], user.get("name", ""), "created",
         new_value=ref, note=f"{body.loan_type} — {body.first_name} {body.last_name}")
    db.commit()
    result = _app_row(row)
    result["created_by_name"] = user.get("name", "")
    return result


@router.get("/applications/{app_id}")
def get_application(
    app_id: int, db = Depends(get_pg), user = Depends(ACCESS)
):
    row = db.execute(text("""
        SELECT a.*,
               c.full_name  AS created_by_name,
               r.full_name  AS reviewed_by_name,
               ax.full_name AS assigned_to_name
        FROM loan_applications a
        LEFT JOIN o3c_users c  ON a.created_by=c.id
        LEFT JOIN o3c_users r  ON a.reviewed_by=r.id
        LEFT JOIN o3c_users ax ON a.assigned_to=ax.id
        WHERE a.id=:id
    """), {"id": app_id}).fetchone()
    if not row:
        raise HTTPException(404, "Application not found")

    docs = db.execute(text("""
        SELECT d.*, u.full_name AS confirmed_by_name
        FROM loan_documents d
        LEFT JOIN o3c_users u ON d.confirmed_by=u.id
        WHERE d.application_id=:id ORDER BY d.created_at ASC
    """), {"id": app_id}).fetchall()

    activity = db.execute(text("""
        SELECT * FROM loan_activity_log
        WHERE application_id=:id ORDER BY created_at ASC
    """), {"id": app_id}).fetchall()

    comments = db.execute(text("""
        SELECT * FROM loan_comments
        WHERE application_id=:id ORDER BY created_at ASC
    """), {"id": app_id}).fetchall()

    result = _app_row(row)
    result["created_by_name"]  = row.created_by_name
    result["reviewed_by_name"] = row.reviewed_by_name
    result["assigned_to_name"] = row.assigned_to_name
    result["documents"] = [{**_doc_row(d), "confirmed_by_name": d.confirmed_by_name} for d in docs]
    result["activity"]  = [{
        "id":        a.id,
        "user_name": a.user_name,
        "action":    a.action,
        "old_value": a.old_value,
        "new_value": a.new_value,
        "note":      a.note,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    } for a in activity]
    result["comments"] = [{
        "id":         c.id,
        "user_id":    c.user_id,
        "user_name":  c.user_name,
        "body":       c.body,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    } for c in comments]
    return result


@router.patch("/applications/{app_id}")
def update_application(
    app_id: int, body: AppUpdate,
    db = Depends(get_pg), user = Depends(ACCESS)
):
    row = db.execute(
        text("SELECT id, status, stage, assigned_to FROM loan_applications WHERE id=:id"),
        {"id": app_id}
    ).fetchone()
    if not row:
        raise HTTPException(404, "Application not found")
    if body.status and body.status not in STATUSES:
        raise HTTPException(422, f"Invalid status. Options: {STATUSES}")
    if body.stage and body.stage not in STAGES:
        raise HTTPException(422, f"Invalid stage. Options: {STAGES}")

    updates = {"id": app_id, "updated_at": _now()}
    user_name = user.get("name", "")

    if body.stage and body.stage != row.stage:
        updates["stage"] = body.stage
        updates["reviewed_by"] = user["id"]
        updates["reviewed_at"] = _now()
        # Mirror terminal stages to status field
        if body.stage == "approved":
            updates["status"] = "approved"
        elif body.stage == "rejected":
            updates["status"] = "rejected"
        elif body.stage in ("under_review", "finance_review"):
            updates["status"] = "under_review"
        _log(db, app_id, user["id"], user_name, "stage_changed",
             old_value=row.stage, new_value=body.stage)

    if body.status and body.status != row.status and "status" not in updates:
        updates["status"] = body.status
        updates["reviewed_by"] = user["id"]
        updates["reviewed_at"] = _now()
        _log(db, app_id, user["id"], user_name, "status_changed",
             old_value=row.status, new_value=body.status)

    if body.assigned_to is not None and body.assigned_to != row.assigned_to:
        updates["assigned_to"] = body.assigned_to
        assignee = db.execute(text("SELECT full_name FROM o3c_users WHERE id=:id"),
                              {"id": body.assigned_to}).fetchone()
        _log(db, app_id, user["id"], user_name, "assigned",
             new_value=assignee.full_name if assignee else str(body.assigned_to))

    if body.notes is not None:
        updates["notes"] = body.notes
        _log(db, app_id, user["id"], user_name, "note_added", note=body.notes[:120])

    sets = ", ".join(f"{k}=:{k}" for k in updates if k != "id")
    db.execute(text(f"UPDATE loan_applications SET {sets} WHERE id=:id"), updates)
    db.commit()
    updated = db.execute(text("SELECT * FROM loan_applications WHERE id=:id"), {"id": app_id}).fetchone()
    return _app_row(updated)


# ── Comments ──────────────────────────────────────────────────────────────────

@router.post("/applications/{app_id}/comments", status_code=201)
def add_comment(
    app_id: int, body: CommentCreate,
    db = Depends(get_pg), user = Depends(ACCESS)
):
    if not db.execute(text("SELECT 1 FROM loan_applications WHERE id=:id"), {"id": app_id}).fetchone():
        raise HTTPException(404, "Application not found")
    if not body.body.strip():
        raise HTTPException(422, "Comment body cannot be empty")
    row = db.execute(text("""
        INSERT INTO loan_comments (application_id, user_id, user_name, body)
        VALUES (:aid, :uid, :uname, :body) RETURNING *
    """), {"aid": app_id, "uid": user["id"], "uname": user.get("name",""), "body": body.body.strip()}).fetchone()
    _log(db, app_id, user["id"], user.get("name",""), "comment_added")
    db.commit()
    return {
        "id": row.id, "user_id": row.user_id, "user_name": row.user_name,
        "body": row.body, "created_at": row.created_at.isoformat() if row.created_at else None,
    }


# ── Documents ─────────────────────────────────────────────────────────────────

@router.post("/applications/{app_id}/documents", status_code=201)
def add_document(
    app_id: int, body: DocCreate,
    db = Depends(get_pg), user = Depends(ACCESS)
):
    if not db.execute(text("SELECT 1 FROM loan_applications WHERE id=:id"), {"id": app_id}).fetchone():
        raise HTTPException(404, "Application not found")
    row = db.execute(text("""
        INSERT INTO loan_documents (application_id, doc_type, filename, notes)
        VALUES (:aid, :dtype, :fname, :notes) RETURNING *
    """), {"aid": app_id, "dtype": body.doc_type, "fname": body.filename, "notes": body.notes}).fetchone()
    _log(db, app_id, user["id"], user.get("name",""), "doc_added",
         new_value=body.doc_type, note=body.filename)
    db.commit()
    return _doc_row(row)


@router.patch("/applications/{app_id}/documents/{doc_id}")
def update_document(
    app_id: int, doc_id: int, body: DocUpdate,
    db = Depends(get_pg), user = Depends(ACCESS)
):
    doc = db.execute(
        text("SELECT * FROM loan_documents WHERE id=:id AND application_id=:aid"),
        {"id": doc_id, "aid": app_id}
    ).fetchone()
    if not doc:
        raise HTTPException(404, "Document not found")
    if body.status not in ("confirmed", "rejected", "submitted"):
        raise HTTPException(422, "status must be: confirmed, rejected, or submitted")

    updates = {
        "id":           doc_id,
        "status":       body.status,
        "confirmed_by": user["id"] if body.status == "confirmed" else None,
        "confirmed_at": _now()      if body.status == "confirmed" else None,
    }
    if body.notes is not None:
        updates["notes"] = body.notes

    sets = ", ".join(f"{k}=:{k}" for k in updates if k != "id")
    db.execute(text(f"UPDATE loan_documents SET {sets} WHERE id=:id"), updates)
    action = "doc_confirmed" if body.status == "confirmed" else \
             "doc_rejected"  if body.status == "rejected"  else "doc_resubmitted"
    _log(db, app_id, user["id"], user.get("name",""), action,
         old_value=doc.status, new_value=body.status, note=doc.doc_type)
    db.commit()
    updated = db.execute(text("SELECT * FROM loan_documents WHERE id=:id"), {"id": doc_id}).fetchone()
    return _doc_row(updated)


@router.delete("/applications/{app_id}/documents/{doc_id}", status_code=204)
def delete_document(
    app_id: int, doc_id: int,
    db = Depends(get_pg), user = Depends(ACCESS)
):
    doc = db.execute(
        text("SELECT * FROM loan_documents WHERE id=:id AND application_id=:aid"),
        {"id": doc_id, "aid": app_id}
    ).fetchone()
    if not doc:
        raise HTTPException(404, "Document not found")
    db.execute(text("DELETE FROM loan_documents WHERE id=:id"), {"id": doc_id})
    _log(db, app_id, user["id"], user.get("name",""), "doc_removed", old_value=doc.doc_type)
    db.commit()


# ── Users list (for assign-to dropdown) ──────────────────────────────────────

@router.get("/users")
def list_users(db = Depends(get_pg), _=Depends(ACCESS)):
    rows = db.execute(text("""
        SELECT id, full_name, role, department
        FROM o3c_users
        WHERE is_active=TRUE AND deleted_at IS NULL
        ORDER BY full_name ASC
    """)).fetchall()
    return [{"id": r.id, "full_name": r.full_name, "role": r.role, "department": r.department} for r in rows]


# ── Meta ──────────────────────────────────────────────────────────────────────

@router.get("/meta")
def meta(_=Depends(ACCESS)):
    return {"loan_types": LOAN_TYPES, "doc_types": DOC_TYPES, "statuses": STATUSES, "stages": STAGES}
