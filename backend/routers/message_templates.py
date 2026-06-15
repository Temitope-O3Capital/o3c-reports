"""
message_templates.py — Reusable SMS and Email message templates

GET    /api/message-templates           list (filter by channel)
POST   /api/message-templates           create
GET    /api/message-templates/{id}      get by id
PUT    /api/message-templates/{id}      update
DELETE /api/message-templates/{id}      delete
"""
from datetime import datetime, timezone
from typing import Optional, List
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from core.auth import require_pages
from core.database import get_db_pg

router = APIRouter()
ACCESS = require_pages(["campaigns"])

CHANNELS    = ["sms", "email"]
CATEGORIES  = ["general", "collections", "marketing", "onboarding", "repayment_reminder"]


class TemplateCreate(BaseModel):
    name:            str
    channel:         str
    category:        str            = "general"
    sms_body:        Optional[str]  = None
    email_subject:   Optional[str]  = None
    email_body_html: Optional[str]  = None
    email_body_text: Optional[str]  = None
    merge_tags:      List[str]      = []


class TemplateUpdate(BaseModel):
    name:            Optional[str]       = None
    category:        Optional[str]       = None
    sms_body:        Optional[str]       = None
    email_subject:   Optional[str]       = None
    email_body_html: Optional[str]       = None
    email_body_text: Optional[str]       = None
    merge_tags:      Optional[List[str]] = None


def _row(r) -> dict:
    return {
        "id":              r.id,
        "name":            r.name,
        "channel":         r.channel,
        "category":        r.category,
        "sms_body":        r.sms_body,
        "email_subject":   r.email_subject,
        "email_body_html": r.email_body_html,
        "email_body_text": r.email_body_text,
        "merge_tags":      list(r.merge_tags) if r.merge_tags else [],
        "created_by":      r.created_by,
        "created_at":      r.created_at.isoformat() if r.created_at else None,
        "updated_at":      r.updated_at.isoformat() if r.updated_at else None,
    }


@router.get("")
def list_templates(
    channel:  Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    where = "WHERE 1=1"
    params: dict = {}
    if channel:  where += " AND channel=:channel";   params["channel"] = channel
    if category: where += " AND category=:category"; params["category"] = category
    rows = db.execute(text(f"""
        SELECT t.*, u.full_name AS created_by_name
        FROM message_templates t
        LEFT JOIN o3c_users u ON t.created_by=u.id
        {where} ORDER BY t.created_at DESC
    """), params).fetchall()
    result = []
    for r in rows:
        d = _row(r)
        d["created_by_name"] = r.created_by_name
        result.append(d)
    return result


@router.post("", status_code=201)
def create_template(
    body: TemplateCreate, db = Depends(get_db_pg), user = Depends(ACCESS)
):
    if body.channel not in CHANNELS:
        raise HTTPException(422, f"Invalid channel. Options: {CHANNELS}")
    if body.category not in CATEGORIES:
        raise HTTPException(422, f"Invalid category. Options: {CATEGORIES}")
    import json as _j
    row = db.execute(text("""
        INSERT INTO message_templates
            (name, channel, category, sms_body, email_subject, email_body_html,
             email_body_text, merge_tags, created_by)
        VALUES
            (:name, :ch, :cat, :sms, :subj, :html, :txt, :tags, :by)
        RETURNING *
    """), {
        "name": body.name, "ch": body.channel, "cat": body.category,
        "sms":  body.sms_body, "subj": body.email_subject,
        "html": body.email_body_html, "txt": body.email_body_text,
        "tags": body.merge_tags, "by": user["id"],
    }).fetchone()
    db.commit()
    return _row(row)


@router.get("/{tpl_id}")
def get_template(tpl_id: int, db = Depends(get_db_pg), user = Depends(ACCESS)):
    row = db.execute(text("SELECT * FROM message_templates WHERE id=:id"), {"id": tpl_id}).fetchone()
    if not row:
        raise HTTPException(404, "Template not found")
    return _row(row)


@router.put("/{tpl_id}")
def update_template(
    tpl_id: int, body: TemplateUpdate,
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    if not db.execute(text("SELECT 1 FROM message_templates WHERE id=:id"), {"id": tpl_id}).fetchone():
        raise HTTPException(404, "Template not found")
    updates = {"id": tpl_id, "updated_at": datetime.now(timezone.utc)}
    for f in ("name","category","sms_body","email_subject","email_body_html","email_body_text","merge_tags"):
        v = getattr(body, f)
        if v is not None:
            updates[f] = v
    sets = ", ".join(f"{k}=:{k}" for k in updates if k != "id")
    db.execute(text(f"UPDATE message_templates SET {sets} WHERE id=:id"), updates)
    db.commit()
    return get_template(tpl_id, db, user)


@router.delete("/{tpl_id}", status_code=204)
def delete_template(tpl_id: int, db = Depends(get_db_pg), user = Depends(ACCESS)):
    if not db.execute(text("SELECT 1 FROM message_templates WHERE id=:id"), {"id": tpl_id}).fetchone():
        raise HTTPException(404, "Template not found")
    db.execute(text("DELETE FROM message_templates WHERE id=:id"), {"id": tpl_id})
    db.commit()
