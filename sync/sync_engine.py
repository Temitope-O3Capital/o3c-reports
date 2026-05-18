"""
sync_engine.py — O3C Cards MSSQL → Supabase sync engine

Runs on the office PC (Windows). Syncs all tables daily Mon–Fri at 18:00.
Also exposes a Flask API on port 5001 for manual/remote trigger.

Start: python sync_engine.py
"""

import os
import logging
import schedule
import time
import threading
from datetime import datetime
from flask import Flask, jsonify
from dotenv import load_dotenv

import pyodbc
import psycopg2
import psycopg2.extras

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s"
)
log = logging.getLogger("o3c.sync")

# ── Config ─────────────────────────────────────────────────────────────────────
MSSQL_SERVER   = os.getenv("MSSQL_SERVER", "")
MSSQL_DB       = os.getenv("MSSQL_DB", "")
MSSQL_USER     = os.getenv("MSSQL_USER", "")
MSSQL_PASSWORD = os.getenv("MSSQL_PASSWORD", "")
MSSQL_TRUSTED  = os.getenv("MSSQL_TRUSTED", "no").lower() == "yes"

SUPABASE_URL   = os.getenv("SUPABASE_URL", "")

# Table mapping: MSSQL source → Supabase target
TABLES = [
    {"mssql": "dbo.Accounts",            "pg": '"Accounts"'},
    {"mssql": "dbo.Products",            "pg": '"Products"'},
    {"mssql": "dbo.Transactions",        "pg": '"Transactions"'},
    {"mssql": "dbo.MonthlyActivity",     "pg": '"Monthly Activity"'},
    {"mssql": "dbo.CollectionsLog",      "pg": '"Collections Log"'},
    {"mssql": "dbo.CIFTable",            "pg": '"CIF Table"'},
    {"mssql": "dbo.RecoveryMasterSheet", "pg": '"Recovery Master Sheet"'},
]

# ── MSSQL connection ───────────────────────────────────────────────────────────
def get_mssql_conn():
    if MSSQL_TRUSTED:
        conn_str = (
            f"DRIVER={{ODBC Driver 17 for SQL Server}};"
            f"SERVER={MSSQL_SERVER};DATABASE={MSSQL_DB};"
            "Trusted_Connection=yes;"
        )
    else:
        conn_str = (
            f"DRIVER={{ODBC Driver 17 for SQL Server}};"
            f"SERVER={MSSQL_SERVER};DATABASE={MSSQL_DB};"
            f"UID={MSSQL_USER};PWD={MSSQL_PASSWORD};"
        )
    return pyodbc.connect(conn_str, timeout=10)


def get_pg_conn():
    return psycopg2.connect(SUPABASE_URL)


# ── Sync a single table ────────────────────────────────────────────────────────
def sync_table(ms_conn, pg_conn, mssql_table: str, pg_table: str) -> int:
    log.info(f"Syncing {mssql_table} → {pg_table}")
    ms_cur = ms_conn.cursor()
    pg_cur = pg_conn.cursor()

    ms_cur.execute(f"SELECT * FROM {mssql_table}")
    cols = [desc[0] for desc in ms_cur.description]
    rows = ms_cur.fetchall()

    pg_cols = ", ".join(f'"{c}"' for c in cols)
    placeholders = ", ".join(["%s"] * len(cols))

    pg_cur.execute(f'TRUNCATE TABLE {pg_table}')

    if rows:
        data = [tuple(row) for row in rows]
        insert_sql = f'INSERT INTO {pg_table} ({pg_cols}) VALUES ({placeholders})'
        psycopg2.extras.execute_batch(pg_cur, insert_sql, data, page_size=500)

    pg_conn.commit()
    log.info(f"  → {len(rows):,} rows synced to {pg_table}")
    return len(rows)


# ── Full sync ──────────────────────────────────────────────────────────────────
def run_sync():
    log.info("=== Starting full sync ===")
    results = {}
    errors  = {}

    try:
        ms_conn = get_mssql_conn()
        pg_conn = get_pg_conn()
    except Exception as e:
        log.error(f"Connection failed: {e}")
        return {"status": "error", "detail": str(e)}

    for table in TABLES:
        try:
            count = sync_table(ms_conn, pg_conn, table["mssql"], table["pg"])
            results[table["mssql"]] = count
        except Exception as e:
            log.error(f"Failed to sync {table['mssql']}: {e}")
            errors[table["mssql"]] = str(e)

    try:
        ms_conn.close()
        pg_conn.close()
    except Exception:
        pass

    status = "partial" if errors else "ok"
    log.info(f"=== Sync complete — status: {status} ===")
    return {
        "status": status,
        "synced_at": datetime.utcnow().isoformat() + "Z",
        "tables": results,
        "errors": errors,
    }


# ── Scheduler ──────────────────────────────────────────────────────────────────
def start_scheduler():
    schedule.every().monday.at("18:00").do(run_sync)
    schedule.every().tuesday.at("18:00").do(run_sync)
    schedule.every().wednesday.at("18:00").do(run_sync)
    schedule.every().thursday.at("18:00").do(run_sync)
    schedule.every().friday.at("18:00").do(run_sync)

    log.info("Scheduler started — will sync Mon–Fri at 18:00")
    while True:
        schedule.run_pending()
        time.sleep(30)


# ── Flask API ──────────────────────────────────────────────────────────────────
app = Flask(__name__)

@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "o3c-sync-engine"})

@app.route("/sync", methods=["POST"])
def trigger_sync():
    log.info("Manual sync triggered via API")
    result = run_sync()
    code = 200 if result.get("status") in ("ok", "partial") else 500
    return jsonify({
        "message": f"Sync {result['status']}. Tables: {len(result.get('tables', {}))} synced, {len(result.get('errors', {}))} errors.",
        **result
    }), code

@app.route("/status")
def status():
    return jsonify({
        "mssql_server": MSSQL_SERVER,
        "mssql_db": MSSQL_DB,
        "tables": [t["mssql"] for t in TABLES],
        "schedule": "Mon–Fri 18:00",
    })


# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not MSSQL_SERVER or not SUPABASE_URL:
        log.error("MSSQL_SERVER and SUPABASE_URL must be set in .env")
        raise SystemExit(1)

    scheduler_thread = threading.Thread(target=start_scheduler, daemon=True)
    scheduler_thread.start()

    log.info("Sync engine API starting on port 5001")
    app.run(host="0.0.0.0", port=5001)
