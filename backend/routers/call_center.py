"""
call_center.py — Call Center module

Reporting endpoints for call centre operations: ticket volumes, agent activity,
resolution times. Data sources TBC — stub endpoints until source is confirmed.
"""

from fastapi import APIRouter, Depends
from core.auth import require_pages

router = APIRouter()
ACCESS = require_pages(["call_center"])


@router.get("/summary")
def call_center_summary(user=Depends(ACCESS)):
    return {
        "data": {},
        "data_source": "pending",
        "message": "Call Center data source not yet configured"
    }


@router.get("/tickets")
def call_center_tickets(user=Depends(ACCESS)):
    return {
        "data": [],
        "data_source": "pending",
        "message": "Call Center data source not yet configured"
    }
