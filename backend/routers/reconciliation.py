"""
reconciliation.py — Reconciliation module

Endpoints for matching card transactions against bank/processor settlement files.
Data sources TBC — stub endpoints return empty payloads until source is confirmed.
"""

from fastapi import APIRouter, Depends
from core.auth import require_pages

router = APIRouter()
ACCESS = require_pages(["reconciliation"])


@router.get("/summary")
def recon_summary(user=Depends(ACCESS)):
    return {
        "data": {},
        "data_source": "pending",
        "message": "Reconciliation data source not yet configured"
    }


@router.get("/items")
def recon_items(user=Depends(ACCESS)):
    return {
        "data": [],
        "data_source": "pending",
        "message": "Reconciliation data source not yet configured"
    }
