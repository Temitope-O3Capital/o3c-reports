"""
database.py — Dual database connection manager

Manages two database connections:
  1. MSSQL  — on-site via Cloudflare Tunnel (primary, live data)
  2. Supabase PostgreSQL — cloud (fallback, last synced snapshot)

Both connections use SQLAlchemy. MSSQL uses pyodbc driver.
"""

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.ext.declarative import declarative_base
from typing import Optional, Generator
import os
import logging

log = logging.getLogger("o3c.database")
Base = declarative_base()

# ── MSSQL (Primary) ───────────────────────────────────────────────────────────
MSSQL_SERVER   = os.getenv("MSSQL_SERVER", "")
MSSQL_DATABASE = os.getenv("MSSQL_DATABASE", "")
MSSQL_TRUSTED  = os.getenv("MSSQL_TRUSTED", "yes").lower() == "yes"
MSSQL_USER     = os.getenv("MSSQL_USER", "")
MSSQL_PASSWORD = os.getenv("MSSQL_PASSWORD", "")

def _build_mssql_url() -> Optional[str]:
    if not MSSQL_SERVER or not MSSQL_DATABASE:
        log.warning("MSSQL_SERVER or MSSQL_DATABASE not set — MSSQL disabled")
        return None
    if MSSQL_TRUSTED:
        conn_str = (
            f"mssql+pyodbc://{MSSQL_SERVER}/{MSSQL_DATABASE}"
            "?driver=ODBC+Driver+17+for+SQL+Server"
            "&trusted_connection=yes"
        )
    else:
        conn_str = (
            f"mssql+pyodbc://{MSSQL_USER}:{MSSQL_PASSWORD}"
            f"@{MSSQL_SERVER}/{MSSQL_DATABASE}"
            "?driver=ODBC+Driver+17+for+SQL+Server"
        )
    return conn_str

_mssql_url = _build_mssql_url()

if _mssql_url:
    try:
        mssql_engine = create_engine(
            _mssql_url,
            pool_pre_ping=True,
            pool_size=3,
            max_overflow=5,
            pool_timeout=5,       # fail fast — don't wait if tunnel is down
            connect_args={"timeout": 5},
        )
        MSSQLSession = sessionmaker(bind=mssql_engine, autocommit=False, autoflush=False)
        log.info("MSSQL engine created")
    except Exception as e:
        log.error(f"MSSQL engine creation failed: {e}")
        mssql_engine = None
        MSSQLSession = None
else:
    mssql_engine = None
    MSSQLSession = None

# ── Supabase PostgreSQL (Fallback) ────────────────────────────────────────────
SUPABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres"
)

pg_engine = create_engine(
    SUPABASE_URL,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)
PGSession = sessionmaker(bind=pg_engine, autocommit=False, autoflush=False)
log.info("Supabase PostgreSQL engine created")


# ── Dependency injectors ──────────────────────────────────────────────────────
def get_db_pg() -> Generator[Session, None, None]:
    """FastAPI dependency — Supabase PostgreSQL session."""
    db = PGSession()
    try:
        yield db
    finally:
        db.close()


def get_db_mssql() -> Generator[Optional[Session], None, None]:
    """
    FastAPI dependency — MSSQL session.
    Yields None if MSSQL is not configured or connection fails.
    Routers must handle None gracefully (dual_query does this automatically).
    """
    if MSSQLSession is None:
        yield None
        return
    db = MSSQLSession()
    try:
        # Quick health check — fail fast
        db.execute(text("SELECT 1"))
        yield db
    except Exception as e:
        log.warning(f"MSSQL session health check failed: {e}")
        db.close()
        yield None
        return
    finally:
        try:
            db.close()
        except Exception:
            pass


def check_mssql_health() -> dict:
    """Returns MSSQL connection status — used by /api/health endpoint."""
    if MSSQLSession is None:
        return {"status": "disabled", "reason": "Not configured"}
    db = MSSQLSession()
    try:
        db.execute(text("SELECT 1"))
        return {"status": "online"}
    except Exception as e:
        return {"status": "offline", "reason": str(e)}
    finally:
        db.close()


def check_pg_health() -> dict:
    """Returns Supabase connection status."""
    db = PGSession()
    try:
        db.execute(text("SELECT 1"))
        return {"status": "online"}
    except Exception as e:
        return {"status": "offline", "reason": str(e)}
    finally:
        db.close()
