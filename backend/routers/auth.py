from fastapi import APIRouter, Depends
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
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
    rows, _ = dual_query(
        db_mssql, db_pg,
        mssql_query="SELECT * FROM dbo.o3c_users WHERE email = :email",
        pg_query='SELECT * FROM o3c_users WHERE email = :email',
        params={"email": form.username}
    )
    if not rows:
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Invalid credentials")
    user = rows[0]
    if not verify_password(form.password, user["password_hash"]):
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Invalid credentials")

    pages = ROLE_PAGES.get(user["role"], [])
    token = create_token({
        "sub":        user["email"],
        "role":       user["role"],
        "full_name":  user["full_name"],
        "department": user.get("department", ""),
        "pages":      pages,
    })
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "email":      user["email"],
            "full_name":  user["full_name"],
            "role":       user["role"],
            "department": user.get("department", ""),
            "pages":      pages,
        }
    }


@router.get("/me")
def get_me(user=Depends(get_current_user)):
    return user
