from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import text
from core.database import get_db_pg, get_db_mssql
from core.auth import (verify_password, create_token, get_current_user,
                        require_pages, hash_password, ROLE_PAGES)
from core.dual_query import dual_query
from pydantic import BaseModel
from typing import Optional

router = APIRouter()


@router.post("/token")
def login(
    form: OAuth2PasswordRequestForm = Depends(),
    db_pg: Session = Depends(get_db_pg),
    db_mssql: Optional[Session] = Depends(get_db_mssql)
):
    try:
        rows, _ = dual_query(
            db_mssql, db_pg,
            mssql_query="SELECT * FROM dbo.o3c_users WHERE email = :email",
            pg_query='SELECT * FROM o3c_users WHERE email = :email',
            params={"email": form.username}
        )
    except Exception:
        raise HTTPException(status_code=503, detail="Database unavailable — please try again shortly")
    if not rows:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    user = rows[0]
    if not verify_password(form.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Update last_login (best-effort)
    try:
        db_pg.execute(text("UPDATE o3c_users SET last_login = NOW() WHERE id = :id"), {"id": user["id"]})
        db_pg.commit()
    except Exception:
        pass

    pages = ROLE_PAGES.get(user["role"], [])
    must_change = bool(user.get("must_change_password", False))
    token = create_token({
        "sub":        user["email"],
        "id":         user["id"],
        "role":       user["role"],
        "full_name":  user["full_name"],
        "department": user.get("department", ""),
        "pages":      pages,
    })
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id":                   user["id"],
            "email":                user["email"],
            "full_name":            user["full_name"],
            "role":                 user["role"],
            "department":           user.get("department", ""),
            "pages":                pages,
            "must_change_password": must_change,
        }
    }


@router.get("/me")
def get_me(user=Depends(get_current_user)):
    return user


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password:     str


@router.post("/change-password")
def change_password(
    body:    ChangePasswordBody,
    db_pg:   Session = Depends(get_db_pg),
    current: dict    = Depends(get_current_user),
):
    if len(body.new_password) < 8:
        raise HTTPException(status_code=422, detail="New password must be at least 8 characters")

    row = db_pg.execute(
        text("SELECT id, password_hash FROM o3c_users WHERE id = :id"),
        {"id": current["id"]}
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    if not verify_password(body.current_password, row.password_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    db_pg.execute(
        text("UPDATE o3c_users SET password_hash = :pw, must_change_password = FALSE WHERE id = :id"),
        {"pw": hash_password(body.new_password), "id": current["id"]}
    )
    db_pg.commit()
    return {"detail": "Password updated successfully"}
