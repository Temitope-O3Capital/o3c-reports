"""
auth.py — JWT authentication and role-based access control

Roles and their page access are defined in ROLE_PAGES.
Keep this in sync with frontend/src/hooks/useAuth.js
"""

from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
import bcrypt
from datetime import datetime, timedelta, timezone
from typing import Optional
import os

SECRET_KEY = os.getenv("SECRET_KEY", "")
if not SECRET_KEY or SECRET_KEY == "change-this-in-production":
    raise RuntimeError(
        "SECRET_KEY environment variable must be set to a secure random value. "
        "Generate one with: openssl rand -hex 32"
    )
ALGORITHM  = "HS256"
TOKEN_EXPIRE_MINUTES = 480  # 8 hours

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")

# ── Role → allowed pages mapping ─────────────────────────────────────────────
# Keep in sync with frontend/src/hooks/useAuth.js
_CRM        = ["crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests"]
_CRM_REPORT = ["crm_reports"]
_CAMPAIGNS  = ["campaigns", "contact_lists", "message_templates"]

ROLE_PAGES = {
    # Executive / senior titles
    "md":          ["overview","transactions","collections","recovery","sales","cards","cohort","card_trends","executive","income","eod","uploads","reconciliation","call_center","loans"] + _CRM + _CRM_REPORT + _CAMPAIGNS,
    "coo":         ["overview","transactions","collections","recovery","cards","cohort","card_trends","executive","income","eod","uploads","reconciliation","call_center","loans"]         + _CRM + _CRM_REPORT + _CAMPAIGNS,
    "cfo":         ["overview","income","collections","recovery","executive","transactions","eod","uploads","reconciliation","loans"],
    "head_it":     ["overview","transactions","collections","recovery","sales","cards","cohort","card_trends","admin","executive","income","eod","uploads","reconciliation","call_center","loans"] + _CRM + _CRM_REPORT + _CAMPAIGNS,
    "head_hr":     ["overview","sales","uploads"],
    "cmo":              ["overview","sales","cohort","executive","uploads"]                                                              + _CRM + _CRM_REPORT + _CAMPAIGNS,
    "head_ops":         ["overview","transactions","cards","card_trends","cohort","executive","income","eod","uploads","reconciliation"] + _CRM,
    "head_sales":       ["sales","overview","uploads","executive","loans"]                                                              + _CRM + _CRM_REPORT + _CAMPAIGNS,
    "head_collections": ["collections","recovery","overview","eod","uploads","executive","reconciliation","loans"]                      + _CRM,
    "head_recovery":    ["recovery","collections","overview","eod","uploads","executive","loans"]                                       + _CRM,
    # Functional roles
    "admin":       ["overview","transactions","collections","recovery","sales","cards","card_trends","cohort","admin","executive","income","eod","uploads","reconciliation","call_center","loans"] + _CRM + _CRM_REPORT + _CAMPAIGNS,
    "management":  ["overview","transactions","collections","recovery","sales","cards","card_trends","cohort","executive","income","eod","uploads","reconciliation","call_center"]                 + _CRM + _CRM_REPORT + _CAMPAIGNS,
    "sales":       ["sales","overview","uploads","loans"]                                                                                                                + _CRM + _CRM_REPORT + _CAMPAIGNS,
    "collections": ["collections","recovery","eod","uploads","reconciliation"]                                                                                          + _CRM,
    "recovery":    ["recovery","collections","eod","uploads","loans"]                                                                                                   + _CRM,
    "cards_ops":   ["cards","card_trends","transactions","overview","eod","uploads"],
    "call_centre": ["overview","transactions","call_center","crm_requests","crm_contacts","uploads"],
}


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def create_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_EXPIRE_MINUTES)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str = Depends(oauth2_scheme)) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def get_current_user(payload: dict = Depends(decode_token)) -> dict:
    return payload


def require_pages(pages: list):
    """
    Dependency factory — raises 403 if the user's role
    doesn't have access to any of the specified pages.

    Checks static ROLE_PAGES first, then falls back to JWT-embedded
    pages (used for custom roles created via the Admin panel).
    """
    def checker(user: dict = Depends(get_current_user)):
        allowed = set(ROLE_PAGES.get(user.get("role", ""), []))
        # Custom roles have their pages embedded in the JWT at login time
        allowed |= set(user.get("pages", []))
        if not any(p in allowed for p in pages):
            raise HTTPException(
                status_code=403,
                detail=f"Your role '{user.get('role')}' cannot access this resource"
            )
        return user
    return checker
