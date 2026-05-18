"""
auth.py — JWT authentication and role-based access control

Roles and their page access are defined in ROLE_PAGES.
Keep this in sync with frontend/src/hooks/useAuth.js
"""

from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from datetime import datetime, timedelta
from typing import Optional
import os

SECRET_KEY = os.getenv("SECRET_KEY", "change-this-in-production")
ALGORITHM  = "HS256"
TOKEN_EXPIRE_MINUTES = 480  # 8 hours

pwd_context   = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")

# ── Role → allowed pages mapping ─────────────────────────────────────────────
# Keep in sync with frontend/src/hooks/useAuth.js
ROLE_PAGES = {
    "admin":       ["overview","transactions","collections","recovery","sales","cards","cohort"],
    "management":  ["overview","transactions","collections","recovery","sales","cards","cohort"],
    "collections": ["collections","recovery"],
    "sales":       ["sales","overview"],
    "cards_ops":   ["cards","transactions","overview"],
    "recovery":    ["recovery","collections"],
    "call_centre": ["overview","transactions"],
}


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


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
