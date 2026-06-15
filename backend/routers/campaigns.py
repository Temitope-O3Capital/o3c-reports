"""
campaigns.py — Campaign management: bulk SMS and Email outreach

Campaigns target contact lists with SMS (Termii) or Email (SendGrid).
Dispatch runs in a background thread after start action.

POST   /api/campaigns                       create campaign
GET    /api/campaigns                       list campaigns
GET    /api/campaigns/{id}                  campaign detail + stats
PATCH  /api/campaigns/{id}                  update draft campaign
POST   /api/campaigns/{id}/start            start dispatch (SMS/Email)
POST   /api/campaigns/{id}/pause            pause active dispatch
POST   /api/campaigns/{id}/cancel           cancel campaign
GET    /api/campaigns/{id}/contacts         paginated contact list
POST   /api/campaigns/upload-image          upload image for email (Supabase Storage)
POST   /api/campaigns/sms-webhook           Termii delivery webhook (public)
POST   /api/campaigns/email-webhook         SendGrid event webhook (public)
"""
import csv
import io
import os
import re
import time
import logging
import threading
import requests as req_lib
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker
from core.auth import require_pages
from core.database import get_db_pg, pg_engine

router  = APIRouter()
ACCESS  = require_pages(["campaigns"])
log     = logging.getLogger("o3c.campaigns")

TERMII_API_KEY      = os.getenv("TERMII_API_KEY", "")
TERMII_SENDER_ID    = os.getenv("TERMII_SENDER_ID", "O3CCARDS")
SENDGRID_API_KEY    = os.getenv("SENDGRID_API_KEY", "")
SENDGRID_FROM_EMAIL = os.getenv("SENDGRID_FROM_EMAIL", "")
SENDGRID_FROM_NAME  = os.getenv("SENDGRID_FROM_NAME", "O3C Cards")
SUPABASE_URL        = os.getenv("DATABASE_URL", "")  # used for storage base URL derivation

CAMPAIGN_TYPES = ["sms", "email", "multi"]
CAMPAIGN_STATUSES = ["draft", "scheduled", "active", "paused", "completed", "cancelled"]


def _now():
    return datetime.now(timezone.utc)


# ── Merge tag renderer ────────────────────────────────────────────────────────

def _render(template: str, data: dict) -> str:
    if not template:
        return ""
    for k, v in (data or {}).items():
        template = template.replace("{{" + k + "}}", str(v))
    return re.sub(r'\{\{[^}]+\}\}', '', template)


# ── Provider senders ──────────────────────────────────────────────────────────

def _send_sms(phone: str, body: str) -> tuple[bool, str]:
    if not TERMII_API_KEY:
        return False, "TERMII_API_KEY not configured"
    try:
        r = req_lib.post("https://api.ng.termii.com/api/sms/send", json={
            "api_key": TERMII_API_KEY,
            "to": phone,
            "from": TERMII_SENDER_ID,
            "sms": body,
            "type": "plain",
            "channel": "generic",
        }, timeout=15)
        d = r.json()
        if r.status_code == 200 and d.get("code") == "ok":
            return True, str(d.get("message_id", ""))
        return False, str(d.get("message", r.text[:100]))
    except Exception as e:
        return False, str(e)


def _send_email(to_email: str, to_name: str, from_email: str, from_name: str,
                subject: str, html: str, text_body: str, contact_ref: str) -> tuple[bool, str]:
    if not SENDGRID_API_KEY:
        return False, "SENDGRID_API_KEY not configured"
    eff_from_email = from_email or SENDGRID_FROM_EMAIL
    eff_from_name  = from_name  or SENDGRID_FROM_NAME
    if not eff_from_email:
        return False, "SENDGRID_FROM_EMAIL not configured"
    try:
        r = req_lib.post(
            "https://api.sendgrid.com/v3/mail/send",
            headers={"Authorization": f"Bearer {SENDGRID_API_KEY}", "Content-Type": "application/json"},
            json={
                "personalizations": [{"to": [{"email": to_email, "name": to_name}]}],
                "from": {"email": eff_from_email, "name": eff_from_name},
                "subject": subject,
                "content": [
                    {"type": "text/html",  "value": html or "<p></p>"},
                    {"type": "text/plain", "value": text_body or "Please enable HTML to view this email."},
                ],
                "custom_args": {"o3c_contact_id": contact_ref},
                "tracking_settings": {
                    "click_tracking": {"enable": True, "enable_text": False},
                    "open_tracking":  {"enable": True},
                },
            },
            timeout=20,
        )
        if r.status_code in (200, 202):
            return True, r.headers.get("X-Message-Id", "")
        return False, r.text[:200]
    except Exception as e:
        return False, str(e)


# ── Background dispatch worker ────────────────────────────────────────────────

def _dispatch_worker(campaign_id: int):
    Session = sessionmaker(bind=pg_engine)
    db = Session()
    try:
        camp = db.execute(text("SELECT * FROM campaigns WHERE id=:id"), {"id": campaign_id}).fetchone()
        if not camp or camp.status not in ("active",):
            return

        is_sms   = camp.type in ("sms", "multi")
        is_email = camp.type in ("email", "multi")

        contacts = db.execute(text("""
            SELECT * FROM campaign_contacts
            WHERE campaign_id=:id
              AND ((:sms AND sms_status='pending') OR (:email AND email_status='pending'))
            ORDER BY position ASC
        """), {"id": campaign_id, "sms": is_sms, "email": is_email}).fetchall()

        for c in contacts:
            current = db.execute(text("SELECT status FROM campaigns WHERE id=:id"), {"id": campaign_id}).fetchone()
            if current and current.status == "paused":
                log.info(f"Campaign {campaign_id} paused — stopping dispatch")
                return

            merge = c.merge_data or {}
            name  = f"{c.first_name or ''} {c.last_name or ''}".strip() or "Customer"

            if is_sms and c.sms_status == "pending" and c.phone:
                body = _render(camp.sms_body or "", merge)
                ok, pid = _send_sms(c.phone, body)
                db.execute(text("""
                    UPDATE campaign_contacts
                    SET sms_status=:s, sms_provider_id=:p, sms_sent_at=NOW(), updated_at=NOW()
                    WHERE id=:id
                """), {"s": "sent" if ok else "failed", "p": pid, "id": c.id})
                col = "sms_sent" if ok else "sms_failed"
                db.execute(text(f"UPDATE campaigns SET {col}={col}+1, updated_at=NOW() WHERE id=:id"),
                           {"id": campaign_id})
                db.commit()
                log.debug(f"SMS {'sent' if ok else 'FAILED'} → {c.phone} ({pid})")

            if is_email and c.email_status == "pending" and c.email:
                html  = _render(camp.email_body_html or "", merge)
                plain = _render(camp.email_body_text or "", merge)
                ok, pid = _send_email(
                    c.email, name,
                    camp.from_email, camp.from_name,
                    _render(camp.email_subject or "", merge),
                    html, plain, str(c.id),
                )
                db.execute(text("""
                    UPDATE campaign_contacts
                    SET email_status=:s, email_provider_id=:p, email_sent_at=NOW(), updated_at=NOW()
                    WHERE id=:id
                """), {"s": "queued" if ok else "failed", "p": pid, "id": c.id})
                col = "emails_sent" if ok else "emails_bounced"
                db.execute(text(f"UPDATE campaigns SET {col}={col}+1, updated_at=NOW() WHERE id=:id"),
                           {"id": campaign_id})
                db.commit()
                log.debug(f"Email {'queued' if ok else 'FAILED'} → {c.email} ({pid})")

            time.sleep(0.1)

        db.execute(text("""
            UPDATE campaigns SET status='completed', completed_at=NOW(), updated_at=NOW()
            WHERE id=:id AND status='active'
        """), {"id": campaign_id})
        db.commit()
        log.info(f"Campaign {campaign_id} dispatch complete")

    except Exception as e:
        log.error(f"Campaign {campaign_id} dispatch error: {e}")
        try:
            db.execute(text("UPDATE campaigns SET status='paused', updated_at=NOW() WHERE id=:id"),
                       {"id": campaign_id})
            db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _start_dispatch(campaign_id: int):
    t = threading.Thread(target=_dispatch_worker, args=(campaign_id,), daemon=True)
    t.start()


# ── Pydantic models ───────────────────────────────────────────────────────────

class CampaignCreate(BaseModel):
    name:            str
    description:     Optional[str] = None
    type:            str           = "sms"
    list_id:         Optional[int] = None
    scheduled_at:    Optional[str] = None
    # Email fields
    email_subject:   Optional[str] = None
    email_body_html: Optional[str] = None
    email_body_text: Optional[str] = None
    from_name:       Optional[str] = None
    from_email:      Optional[str] = None
    # SMS field
    sms_body:        Optional[str] = None


class CampaignUpdate(BaseModel):
    name:            Optional[str] = None
    description:     Optional[str] = None
    email_subject:   Optional[str] = None
    email_body_html: Optional[str] = None
    email_body_text: Optional[str] = None
    from_name:       Optional[str] = None
    from_email:      Optional[str] = None
    sms_body:        Optional[str] = None
    scheduled_at:    Optional[str] = None
    list_id:         Optional[int] = None


def _campaign_row(row) -> dict:
    return {
        "id":               row.id,
        "name":             row.name,
        "description":      row.description,
        "type":             row.type,
        "status":           row.status,
        "list_id":          row.list_id,
        "email_subject":    row.email_subject,
        "email_body_html":  row.email_body_html,
        "email_body_text":  row.email_body_text,
        "from_name":        row.from_name,
        "from_email":       row.from_email,
        "sms_body":         row.sms_body,
        "total_contacts":   row.total_contacts,
        "sms_sent":         row.sms_sent,
        "sms_delivered":    row.sms_delivered,
        "sms_failed":       row.sms_failed,
        "emails_sent":      row.emails_sent,
        "emails_delivered": row.emails_delivered,
        "emails_opened":    row.emails_opened,
        "emails_clicked":   row.emails_clicked,
        "emails_bounced":   row.emails_bounced,
        "created_by":       row.created_by,
        "started_at":       row.started_at.isoformat()   if row.started_at   else None,
        "completed_at":     row.completed_at.isoformat() if row.completed_at else None,
        "scheduled_at":     row.scheduled_at.isoformat() if row.scheduled_at else None,
        "created_at":       row.created_at.isoformat()   if row.created_at   else None,
        "updated_at":       row.updated_at.isoformat()   if row.updated_at   else None,
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("")
def list_campaigns(
    type:   Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit:  int           = Query(100, ge=1, le=500),
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    where = "WHERE 1=1"
    params: dict = {"lim": limit}
    if type:   where += " AND c.type=:type";     params["type"] = type
    if status: where += " AND c.status=:status"; params["status"] = status

    rows = db.execute(text(f"""
        SELECT c.*, u.full_name AS created_by_name, cl.name AS list_name
        FROM campaigns c
        LEFT JOIN o3c_users u  ON c.created_by=u.id
        LEFT JOIN contact_lists cl ON c.list_id=cl.id
        {where} ORDER BY c.created_at DESC LIMIT :lim
    """), params).fetchall()

    result = []
    for row in rows:
        d = _campaign_row(row)
        d["created_by_name"] = row.created_by_name
        d["list_name"]       = row.list_name
        result.append(d)
    return result


@router.post("", status_code=201)
def create_campaign(
    body: CampaignCreate, db = Depends(get_db_pg), user = Depends(ACCESS)
):
    if body.type not in CAMPAIGN_TYPES:
        raise HTTPException(422, f"Invalid type. Options: {CAMPAIGN_TYPES}")

    # Snapshot contacts from list if provided
    total = 0
    if body.list_id:
        count_row = db.execute(text(
            "SELECT COUNT(*) AS n FROM contact_list_members WHERE list_id=:id AND status='active'"
        ), {"id": body.list_id}).fetchone()
        total = count_row.n if count_row else 0

    row = db.execute(text("""
        INSERT INTO campaigns
            (name, description, type, list_id, email_subject, email_body_html,
             email_body_text, from_name, from_email, sms_body,
             total_contacts, created_by)
        VALUES
            (:name, :desc, :type, :list_id, :subj, :html,
             :txt, :fname, :femail, :sms,
             :total, :by)
        RETURNING *
    """), {
        "name":    body.name,
        "desc":    body.description,
        "type":    body.type,
        "list_id": body.list_id,
        "subj":    body.email_subject,
        "html":    body.email_body_html,
        "txt":     body.email_body_text,
        "fname":   body.from_name,
        "femail":  body.from_email,
        "sms":     body.sms_body,
        "total":   total,
        "by":      user["id"],
    }).fetchone()
    db.commit()

    # Snapshot members into campaign_contacts
    if body.list_id and total > 0:
        db.execute(text("""
            INSERT INTO campaign_contacts
                (campaign_id, first_name, last_name, phone, email, cif_number, merge_data, position)
            SELECT :cid, first_name, last_name, phone, email, cif_number, merge_data,
                   ROW_NUMBER() OVER (ORDER BY id) - 1
            FROM contact_list_members WHERE list_id=:lid AND status='active'
        """), {"cid": row.id, "lid": body.list_id})
        db.commit()

    return _campaign_row(row)


@router.get("/{campaign_id}")
def get_campaign(
    campaign_id: int, db = Depends(get_db_pg), user = Depends(ACCESS)
):
    row = db.execute(text("""
        SELECT c.*, u.full_name AS created_by_name, cl.name AS list_name
        FROM campaigns c
        LEFT JOIN o3c_users u  ON c.created_by=u.id
        LEFT JOIN contact_lists cl ON c.list_id=cl.id
        WHERE c.id=:id
    """), {"id": campaign_id}).fetchone()
    if not row:
        raise HTTPException(404, "Campaign not found")
    d = _campaign_row(row)
    d["created_by_name"] = row.created_by_name
    d["list_name"]       = row.list_name
    return d


@router.patch("/{campaign_id}")
def update_campaign(
    campaign_id: int, body: CampaignUpdate,
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    row = db.execute(text("SELECT id, status FROM campaigns WHERE id=:id"), {"id": campaign_id}).fetchone()
    if not row:
        raise HTTPException(404, "Campaign not found")
    if row.status not in ("draft", "scheduled"):
        raise HTTPException(400, "Only draft or scheduled campaigns can be edited")

    updates = {"id": campaign_id, "updated_at": _now()}
    for field in ("name","description","email_subject","email_body_html","email_body_text",
                  "from_name","from_email","sms_body","scheduled_at","list_id"):
        v = getattr(body, field)
        if v is not None:
            updates[field] = v

    if body.list_id is not None:
        count_row = db.execute(text(
            "SELECT COUNT(*) AS n FROM contact_list_members WHERE list_id=:id AND status='active'"
        ), {"id": body.list_id}).fetchone()
        updates["total_contacts"] = count_row.n if count_row else 0

    sets = ", ".join(f"{k}=:{k}" for k in updates if k != "id")
    db.execute(text(f"UPDATE campaigns SET {sets} WHERE id=:id"), updates)
    db.commit()
    return get_campaign(campaign_id, db, user)


@router.post("/{campaign_id}/start")
def start_campaign(
    campaign_id: int, db = Depends(get_db_pg), user = Depends(ACCESS)
):
    row = db.execute(text("SELECT id, status, type, list_id FROM campaigns WHERE id=:id"),
                     {"id": campaign_id}).fetchone()
    if not row:
        raise HTTPException(404, "Campaign not found")
    if row.status not in ("draft", "scheduled", "paused"):
        raise HTTPException(400, f"Cannot start a campaign with status '{row.status}'")

    # If paused resume, otherwise snapshot contacts fresh
    if row.status in ("draft", "scheduled"):
        # Re-snapshot contacts
        db.execute(text("DELETE FROM campaign_contacts WHERE campaign_id=:id"), {"id": campaign_id})
        if row.list_id:
            db.execute(text("""
                INSERT INTO campaign_contacts
                    (campaign_id, first_name, last_name, phone, email, cif_number, merge_data, position)
                SELECT :cid, first_name, last_name, phone, email, cif_number, merge_data,
                       ROW_NUMBER() OVER (ORDER BY id) - 1
                FROM contact_list_members WHERE list_id=:lid AND status='active'
            """), {"cid": campaign_id, "lid": row.list_id})
        total = db.execute(text(
            "SELECT COUNT(*) AS n FROM campaign_contacts WHERE campaign_id=:id"
        ), {"id": campaign_id}).fetchone()
        db.execute(text("""
            UPDATE campaigns SET total_contacts=:t WHERE id=:id
        """), {"t": total.n if total else 0, "id": campaign_id})

    db.execute(text("""
        UPDATE campaigns SET status='active', started_at=NOW(), updated_at=NOW() WHERE id=:id
    """), {"id": campaign_id})
    db.commit()
    _start_dispatch(campaign_id)
    return {"status": "active", "campaign_id": campaign_id}


@router.post("/{campaign_id}/pause")
def pause_campaign(
    campaign_id: int, db = Depends(get_db_pg), user = Depends(ACCESS)
):
    row = db.execute(text("SELECT id, status FROM campaigns WHERE id=:id"), {"id": campaign_id}).fetchone()
    if not row:
        raise HTTPException(404, "Campaign not found")
    if row.status != "active":
        raise HTTPException(400, "Only active campaigns can be paused")
    db.execute(text("UPDATE campaigns SET status='paused', updated_at=NOW() WHERE id=:id"),
               {"id": campaign_id})
    db.commit()
    return {"status": "paused"}


@router.post("/{campaign_id}/cancel")
def cancel_campaign(
    campaign_id: int, db = Depends(get_db_pg), user = Depends(ACCESS)
):
    row = db.execute(text("SELECT id, status FROM campaigns WHERE id=:id"), {"id": campaign_id}).fetchone()
    if not row:
        raise HTTPException(404, "Campaign not found")
    if row.status in ("completed", "cancelled"):
        raise HTTPException(400, f"Campaign is already {row.status}")
    db.execute(text("UPDATE campaigns SET status='cancelled', updated_at=NOW() WHERE id=:id"),
               {"id": campaign_id})
    db.commit()
    return {"status": "cancelled"}


@router.get("/{campaign_id}/contacts")
def list_campaign_contacts(
    campaign_id: int,
    sms_status:   Optional[str] = Query(None),
    email_status: Optional[str] = Query(None),
    search:       Optional[str] = Query(None),
    limit:        int           = Query(100, ge=1, le=1000),
    offset:       int           = Query(0, ge=0),
    db = Depends(get_db_pg), user = Depends(ACCESS)
):
    where = "WHERE campaign_id=:cid"
    params: dict = {"cid": campaign_id, "lim": limit, "off": offset}
    if sms_status:   where += " AND sms_status=:sms";    params["sms"] = sms_status
    if email_status: where += " AND email_status=:email"; params["email"] = email_status
    if search:
        where += " AND (first_name ILIKE :q OR last_name ILIKE :q OR phone ILIKE :q OR email ILIKE :q)"
        params["q"] = f"%{search}%"

    total = db.execute(text(f"SELECT COUNT(*) AS n FROM campaign_contacts {where}"), params).fetchone()
    rows  = db.execute(text(f"""
        SELECT * FROM campaign_contacts {where} ORDER BY position ASC LIMIT :lim OFFSET :off
    """), params).fetchall()

    return {
        "total": total.n if total else 0,
        "contacts": [{
            "id":                r.id,
            "first_name":        r.first_name,
            "last_name":         r.last_name,
            "phone":             r.phone,
            "email":             r.email,
            "sms_status":        r.sms_status,
            "email_status":      r.email_status,
            "sms_sent_at":       r.sms_sent_at.isoformat()   if r.sms_sent_at   else None,
            "email_sent_at":     r.email_sent_at.isoformat() if r.email_sent_at else None,
            "email_opened_at":   r.email_opened_at.isoformat() if r.email_opened_at else None,
        } for r in rows]
    }


@router.post("/upload-image")
async def upload_image(
    file: UploadFile = File(...),
    user = Depends(ACCESS)
):
    """Upload an image for use in email campaigns. Returns a public URL."""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")
    supabase_url = os.getenv("SUPABASE_URL", "")
    service_key  = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not supabase_url or not service_key:
        raise HTTPException(503, "Image storage not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY missing)")

    ext = file.filename.rsplit(".", 1)[-1] if "." in file.filename else "jpg"
    path = f"campaign-images/{_now().strftime('%Y%m%d%H%M%S')}_{file.filename}"
    content = await file.read()

    r = req_lib.post(
        f"{supabase_url}/storage/v1/object/public/{path}",
        headers={
            "Authorization": f"Bearer {service_key}",
            "Content-Type":  file.content_type,
        },
        data=content,
        timeout=30,
    )
    if r.status_code not in (200, 201):
        raise HTTPException(500, f"Upload failed: {r.text[:200]}")

    public_url = f"{supabase_url}/storage/v1/object/public/{path}"
    return {"url": public_url}


# ── Public webhooks (no auth) ─────────────────────────────────────────────────

@router.post("/sms-webhook", include_in_schema=False)
async def sms_webhook(request: Request, db = Depends(get_db_pg)):
    """Termii delivery status webhook — updates campaign_contacts.sms_status."""
    try:
        data = await request.json()
        provider_id = data.get("id") or data.get("message_id", "")
        status_raw  = (data.get("status") or data.get("delivery_status", "")).lower()
        status_map  = {"delivered": "delivered", "failed": "failed", "undelivered": "failed",
                       "sent": "sent", "queued": "queued"}
        new_status  = status_map.get(status_raw)
        if provider_id and new_status:
            db.execute(text("""
                UPDATE campaign_contacts SET sms_status=:s, updated_at=NOW()
                WHERE sms_provider_id=:pid
            """), {"s": new_status, "pid": provider_id})
            if new_status == "delivered":
                sub = db.execute(text("""
                    SELECT campaign_id FROM campaign_contacts WHERE sms_provider_id=:pid LIMIT 1
                """), {"pid": provider_id}).fetchone()
                if sub:
                    db.execute(text("""
                        UPDATE campaigns SET sms_delivered=sms_delivered+1, updated_at=NOW()
                        WHERE id=:id
                    """), {"id": sub.campaign_id})
            db.commit()
    except Exception as e:
        log.warning(f"SMS webhook error: {e}")
    return JSONResponse({}, status_code=204)


@router.post("/email-webhook", include_in_schema=False)
async def email_webhook(request: Request, db = Depends(get_db_pg)):
    """SendGrid event webhook — updates email open/click/bounce stats."""
    try:
        events = await request.json()
        if not isinstance(events, list):
            events = [events]
        for ev in events:
            pid    = ev.get("sg_message_id", "").split(".")[0]
            event  = ev.get("event", "")
            if not pid:
                continue
            if event == "delivered":
                db.execute(text("""
                    UPDATE campaign_contacts SET email_status='delivered', updated_at=NOW()
                    WHERE email_provider_id=:pid
                """), {"pid": pid})
                sub = db.execute(text(
                    "SELECT campaign_id FROM campaign_contacts WHERE email_provider_id=:pid LIMIT 1"
                ), {"pid": pid}).fetchone()
                if sub:
                    db.execute(text(
                        "UPDATE campaigns SET emails_delivered=emails_delivered+1, updated_at=NOW() WHERE id=:id"
                    ), {"id": sub.campaign_id})
            elif event == "open":
                db.execute(text("""
                    UPDATE campaign_contacts
                    SET email_status='opened', email_opened_at=NOW(), updated_at=NOW()
                    WHERE email_provider_id=:pid AND email_status NOT IN ('clicked')
                """), {"pid": pid})
                sub = db.execute(text(
                    "SELECT campaign_id FROM campaign_contacts WHERE email_provider_id=:pid LIMIT 1"
                ), {"pid": pid}).fetchone()
                if sub:
                    db.execute(text(
                        "UPDATE campaigns SET emails_opened=emails_opened+1, updated_at=NOW() WHERE id=:id"
                    ), {"id": sub.campaign_id})
            elif event == "click":
                db.execute(text("""
                    UPDATE campaign_contacts SET email_status='clicked', updated_at=NOW()
                    WHERE email_provider_id=:pid
                """), {"pid": pid})
                sub = db.execute(text(
                    "SELECT campaign_id FROM campaign_contacts WHERE email_provider_id=:pid LIMIT 1"
                ), {"pid": pid}).fetchone()
                if sub:
                    db.execute(text(
                        "UPDATE campaigns SET emails_clicked=emails_clicked+1, updated_at=NOW() WHERE id=:id"
                    ), {"id": sub.campaign_id})
            elif event in ("bounce", "spamreport", "unsubscribe"):
                db.execute(text("""
                    UPDATE campaign_contacts SET email_status='bounced', updated_at=NOW()
                    WHERE email_provider_id=:pid
                """), {"pid": pid})
                sub = db.execute(text(
                    "SELECT campaign_id FROM campaign_contacts WHERE email_provider_id=:pid LIMIT 1"
                ), {"pid": pid}).fetchone()
                if sub:
                    db.execute(text(
                        "UPDATE campaigns SET emails_bounced=emails_bounced+1, updated_at=NOW() WHERE id=:id"
                    ), {"id": sub.campaign_id})
        db.commit()
    except Exception as e:
        log.warning(f"Email webhook error: {e}")
    return JSONResponse({}, status_code=204)
