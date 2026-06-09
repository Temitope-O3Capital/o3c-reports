"""
auth.py — JWT authentication and role-based access control

Roles and their page access are defined in ROLE_PAGES.
Keep this in sync with frontend/src/hooks/useAuth.js
"""

from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
import bcrypt
from datetime import datetime, timedelta
from typing import Optional
import os

SECRET_KEY = os.getenv("SECRET_KEY", "change-this-in-production")
ALGORITHM  = "HS256"
TOKEN_EXPIRE_MINUTES = 480  # 8 hours

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")

# ── Role → allowed pages mapping ─────────────────────────────────────────────
# Keep in sync with frontend/src/hooks/useAuth.js
_CRM        = ["crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests"]
_CRM_REPORT = ["crm_reports"]

ROLE_PAGES = {
    "admin":       ["overview","transactions","collections","recovery","sales","cards","cohort","admin","executive","income","uploads"] + _CRM + _CRM_REPORT,
    "management":  ["overview","transactions","collections","recovery","sales","cards","cohort","executive","income","uploads"]         + _CRM + _CRM_REPORT,
    "sales":       ["sales","overview","uploads"]                                                                              + _CRM + _CRM_REPORT,
    "collections": ["collections","recovery","uploads"]                                                                        + _CRM,
    "recovery":    ["recovery","collections","uploads"]                                                                        + _CRM,
    "cards_ops":   ["cards","transactions","overview","uploads"],
    "call_centre": ["overview","transactions","crm_requests","uploads"],
}


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def create_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE_MINUTES)
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

    Usage:
        @router.get("/kpis")
        def get_kpis(user=Depends(require_pages(["collections"]))):
            ...
    """
    def checker(user: dict = Depends(get_current_user)):
        allowed = ROLE_PAGES.get(user.get("role", ""), [])
        if not any(p in allowed for p in pages):
            raise HTTPException(
                status_code=403,
                detail=f"Your role '{user.get('role')}' cannot access this resource"
            )
        return user
    return checker
