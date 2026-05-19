"""
O3C Cards Reporting API
FastAPI backend — dual source (MSSQL live + Supabase fallback)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from core.database import check_mssql_health, check_pg_health, pg_engine, Base
from routers import auth, overview, transactions, collections, recovery, sales, cards, cohort
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s — %(message)s")

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        Base.metadata.create_all(bind=pg_engine)
    except Exception as e:
        logging.getLogger("o3c.startup").warning(f"DB schema sync skipped (Supabase unreachable): {e}")
    yield

app = FastAPI(
    title="O3C Cards Reporting API",
    version="2.0.0",
    description="Dual-source reporting API: MSSQL (live) with Supabase fallback",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth.router,         prefix="/api/auth",         tags=["Auth"])
app.include_router(overview.router,     prefix="/api/overview",     tags=["Overview"])
app.include_router(transactions.router, prefix="/api/transactions",  tags=["Transactions"])
app.include_router(collections.router,  prefix="/api/collections",  tags=["Collections"])
app.include_router(recovery.router,     prefix="/api/recovery",     tags=["Recovery"])
app.include_router(sales.router,        prefix="/api/sales",        tags=["Sales"])
app.include_router(cards.router,        prefix="/api/cards",        tags=["Cards"])
app.include_router(cohort.router,       prefix="/api/cohort",       tags=["Cohort"])

# ── Health endpoint ───────────────────────────────────────────────────────────
@app.get("/api/health", tags=["Health"])
def health():
    mssql = check_mssql_health()
    pg    = check_pg_health()
    active_source = "mssql_live" if mssql["status"] == "online" else "supabase_snapshot"
    return {
        "api": "ok",
        "mssql":  mssql,
        "supabase": pg,
        "active_source": active_source,
    }
