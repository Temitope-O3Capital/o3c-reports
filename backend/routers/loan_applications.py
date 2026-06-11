"""
loan_applications.py — Sales & Risk loan document workflow

Sales creates an application and attaches documents.
Risk reviews documents and approves/rejects the application.

POST   /api/loans/applications                           create application (sales)
GET    /api/loans/applications                           list all applications
GET    /api/loans/applications/{id}                      get with documents
PATCH  /api/loans/applications/{id}                      update status/notes (risk)
POST   /api/loans/applications/{id}/documents            add document (sales)
PATCH  /api/loans/applications/{id}/documents/{did}      confirm/reject document (risk)
DELETE /api/loans/applications/{id}/documents/{did}      remove document (sales)
"""
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import text
from core.auth import require_pages, get_current_user
from core.database import get_db_pg as get_pg

router = APIRouter()

SALES_ACCESS = require_pages(["loans"])
RISK_ACCESS  = require_pages(["loans"])  # both roles have loans page

LOAN_TYPES   = ["Personal Loan", "Business Loan", "Asset Finance", "Salary Advance", "Other"]
DOC_TYPES    = [
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
        "notes":       row.notes,
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


class AppCreate(BaseModel):
    first_name:  str
    last_name:   str
    cif:         Optional[str]  = None
    phone:       Optional[str]  = None
    email:       Optional[str]  = None
    loan_type:   str            = "Personal Loan"
    loan_amount: Optional[float] = None
    purpose:     Optional[str]  = None


class AppUpdate(BaseModel):
    status:      Optional[str] = None
    notes:       Optional[str] = None


class DocCreate(BaseModel):
    doc_type: str
    filename: Optional[str] = None
    notes:    Optional[str] = None


class DocUpdate(BaseModel):
    status: str   # confirmed | rejected
    notes:  Optional[str] = None


# ── Applications ──────────────────────────────────────────────────────────────

@router.get("/applications")
def list_applications(
    status:  Optional[str] = Query(None),
    limit:   int           = Query(100, ge=1, le=500),
    db = Depends(get_pg), user = Depends(SALES_ACCESS)
):
    where = "WHERE 1=1"
    params: dict = {"lim": limit}
    if status:
        where += " AND a.status = :status"
        params["status"] = status

    rows = db.execute(text(f"""
        SELECT a.*,
               c.full_name AS created_by_name,
               r.full_name AS reviewed_by_name,
               (SELECT COUNT(*) FROM loan_documents d WHERE d.application_id=a.id) AS doc_count,
               (SELECT COUNT(*) FROM loan_documents d WHERE d.application_id=a.id AND d.status='confirmed') AS confirmed_count
        FROM loan_applications a
        LEFT JOIN o3c_users c ON a.created_by=c.id
        LEFT JOIN o3c_users r ON a.reviewed_by=r.id
        {where}
        ORDER BY a.created_at DESC
        LIMIT :lim
    """), params).fetchall()

    result = []
    for row in rows:
        d = _app_row(row)
        d["created_by_name"]  = row.created_by_name
        d["reviewed_by_name"] = row.reviewed_by_name
        d["doc_count"]        = row.doc_count
        d["confirmed_count"]  = row.confirmed_count
        result.append(d)
    return result


@router.post("/applications", status_code=201)
def create_application(
    body: AppCreate, db = Depends(get_pg), user = Depends(SALES_ACCESS)
):
    if body.loan_type not in LOAN_TYPES:
        raise HTTPException(422, f"Invalid loan_type. Options: {LOAN_TYPES}")
    ref = _ref_no(db)
    row = db.execute(text("""
        INSERT INTO loan_applications
            (ref_no, cif, first_name, last_name, phone, email,
             loan_type, loan_amount, purpose, created_by)
        VALUES
            (:ref, :cif, :fn, :ln, :phone, :email,
             :ltype, :amt, :purpose, :by)
        RETURNING *
    """), {
        "ref": ref, "cif": body.cif, "fn": body.first_name, "ln": body.last_name,
        "phone": body.phone, "email": body.email, "ltype": body.loan_type,
        "amt": body.loan_amount, "purpose": body.purpose, "by": user["sub"],
    }).fetchone()
    db.commit()
    return _app_row(row)


@router.get("/applications/{app_id}")
def get_application(
    app_id: int, db = Depends(get_pg), user = Depends(SALES_ACCESS)
):
    row = db.execute(text("""
        SELECT a.*, c.full_name AS created_by_name, r.full_name AS reviewed_by_name
        FROM loan_applications a
        LEFT JOIN o3c_users c ON a.created_by=c.id
        LEFT JOIN o3c_users r ON a.reviewed_by=r.id
        WHERE a.id=:id
    """), {"id": app_id}).fetchone()
    if not row:
        raise HTTPException(404, "Application not found")
    docs = db.execute(text("""
        SELECT d.*, u.full_name AS confirmed_by_name
        FROM loan_documents d
        LEFT JOIN o3c_users u ON d.confirmed_by=u.id
        WHERE d.application_id=:id
        ORDER BY d.created_at ASC
    """), {"id": app_id}).fetchall()
    result = _app_row(row)
    result["created_by_name"]  = row.created_by_name
    result["reviewed_by_name"] = row.reviewed_by_name
    result["documents"] = [{**_doc_row(d), "confirmed_by_name": d.confirmed_by_name} for d in docs]
    return result


@router.patch("/applications/{app_id}")
def update_application(
    app_id: int, body: AppUpdate,
    db = Depends(get_pg), user = Depends(RISK_ACCESS)
):
    row = db.execute(text("SELECT id, status FROM loan_applications WHERE id=:id"), {"id": app_id}).fetchone()
    if not row:
        raise HTTPException(404, "Application not found")
    if body.status and body.status not in STATUSES:
        raise HTTPException(422, f"Invalid status. Options: {STATUSES}")

    updates = {"id": app_id, "updated_at": _now()}
    if body.status:
        updates["status"] = body.status
        updates["reviewed_by"] = user["sub"]
        updates["reviewed_at"] = _now()
    if body.notes is not None:
        updates["notes"] = body.notes

    sets = ", ".join(f"{k}=:{k}" for k in updates if k != "id")
    db.execute(text(f"UPDATE loan_applications SET {sets} WHERE id=:id"), updates)
    db.commit()

    updated = db.execute(text("SELECT * FROM loan_applications WHERE id=:id"), {"id": app_id}).fetchone()
    return _app_row(updated)


# ── Documents ─────────────────────────────────────────────────────────────────

@router.post("/applications/{app_id}/documents", status_code=201)
def add_document(
    app_id: int, body: DocCreate,
    db = Depends(get_pg), user = Depends(SALES_ACCESS)
):
    if not db.execute(text("SELECT 1 FROM loan_applications WHERE id=:id"), {"id": app_id}).fetchone():
        raise HTTPException(404, "Application not found")
    row = db.execute(text("""
        INSERT INTO loan_documents (application_id, doc_type, filename, notes)
        VALUES (:aid, :dtype, :fname, :notes) RETURNING *
    """), {"aid": app_id, "dtype": body.doc_type, "fname": body.filename, "notes": body.notes}).fetchone()
    db.commit()
    return _doc_row(row)


@router.patch("/applications/{app_id}/documents/{doc_id}")
def update_document(
    app_id: int, doc_id: int, body: DocUpdate,
    db = Depends(get_pg), user = Depends(RISK_ACCESS)
):
    row = db.execute(
        text("SELECT 1 FROM loan_documents WHERE id=:id AND application_id=:aid"),
        {"id": doc_id, "aid": app_id}
    ).fetchone()
    if not row:
        raise HTTPException(404, "Document not found")
    if body.status not in ("confirmed", "rejected", "submitted"):
        raise HTTPException(422, "status must be: confirmed, rejected, or submitted")

    updates = {
        "id":           doc_id,
        "status":       body.status,
        "confirmed_by": user["sub"] if body.status == "confirmed" else None,
        "confirmed_at": _now()      if body.status == "confirmed" else None,
    }
    if body.notes is not None:
        updates["notes"] = body.notes

    sets = ", ".join(f"{k}=:{k}" for k in updates if k != "id")
    db.execute(text(f"UPDATE loan_documents SET {sets} WHERE id=:id"), updates)
    db.commit()
    updated = db.execute(text("SELECT * FROM loan_documents WHERE id=:id"), {"id": doc_id}).fetchone()
    return _doc_row(updated)


@router.delete("/applications/{app_id}/documents/{doc_id}", status_code=204)
def delete_document(
    app_id: int, doc_id: int,
    db = Depends(get_pg), user = Depends(SALES_ACCESS)
):
    row = db.execute(
        text("SELECT 1 FROM loan_documents WHERE id=:id AND application_id=:aid"),
        {"id": doc_id, "aid": app_id}
    ).fetchone()
    if not row:
        raise HTTPException(404, "Document not found")
    db.execute(text("DELETE FROM loan_documents WHERE id=:id"), {"id": doc_id})
    db.commit()


# ── Meta ──────────────────────────────────────────────────────────────────────

@router.get("/meta")
def meta(_=Depends(SALES_ACCESS)):
    return {"loan_types": LOAN_TYPES, "doc_types": DOC_TYPES, "statuses": STATUSES}
