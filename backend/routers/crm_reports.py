"""
crm_reports.py — CRM analytics: pipeline health, agent performance, conversion, SLA
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional
from sqlalchemy import text
from core.database import get_db_pg as get_pg
from core.auth import require_pages

router = APIRouter()
ACCESS = require_pages(["crm_reports"])


def _row(r): return dict(r._mapping)


@router.get("/reports/overview")
def crm_overview(db=Depends(get_pg), _=Depends(ACCESS)):
    """Top-line CRM KPIs."""
    r = db.execute(text("""
        SELECT
          (SELECT COUNT(*) FROM crm_contacts)                                         AS total_contacts,
          (SELECT COUNT(*) FROM crm_contacts WHERE status = 'lead')                   AS total_leads,
          (SELECT COUNT(*) FROM crm_contacts WHERE status = 'customer')               AS total_customers,
          (SELECT COUNT(*) FROM crm_deals)                                            AS total_deals,
          (SELECT COUNT(*) FROM crm_deals d JOIN crm_pipeline_stages s ON s.id = d.stage_id WHERE s.is_won) AS won_deals,
          (SELECT COUNT(*) FROM crm_deals d JOIN crm_pipeline_stages s ON s.id = d.stage_id WHERE s.is_lost) AS lost_deals,
          (SELECT COUNT(*) FROM crm_activities WHERE created_at >= NOW() - INTERVAL '30 days') AS activities_30d,
          (SELECT COUNT(*) FROM crm_tasks WHERE status = 'open')                      AS open_tasks,
          (SELECT COUNT(*) FROM crm_tasks WHERE status NOT IN ('done','cancelled') AND due_date < NOW()) AS overdue_tasks,
          (SELECT COUNT(*) FROM crm_requests WHERE status = 'open')                   AS open_requests,
          (SELECT COUNT(*) FROM crm_requests WHERE status NOT IN ('resolved','closed')
            AND created_at + (sla_hours || ' hours')::INTERVAL < NOW())               AS sla_breached,
          (SELECT ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600)::NUMERIC, 1)
            FROM crm_requests WHERE resolved_at IS NOT NULL)                          AS avg_resolution_hrs
    """)).fetchone()
    return _row(r)


@router.get("/reports/pipeline")
def pipeline_report(db=Depends(get_pg), _=Depends(ACCESS)):
    """Deals count and value by stage."""
    rows = db.execute(text("""
        SELECT s.name, s.color, s.order_index, s.is_won, s.is_lost,
               COUNT(d.id)                    AS deal_count,
               COALESCE(SUM(d.expected_value), 0) AS pipeline_value,
               ROUND(AVG(d.probability)::NUMERIC, 1) AS avg_probability
        FROM crm_pipeline_stages s
        LEFT JOIN crm_deals d ON d.stage_id = s.id
        GROUP BY s.id, s.name, s.color, s.order_index, s.is_won, s.is_lost
        ORDER BY s.order_index
    """)).fetchall()
    return [_row(r) for r in rows]


@router.get("/reports/conversion")
def conversion_report(db=Depends(get_pg), _=Depends(ACCESS)):
    """Stage-by-stage conversion funnel — how many contacts at each stage."""
    rows = db.execute(text("""
        SELECT s.name, s.order_index, s.color,
               COUNT(DISTINCT d.contact_id) AS contacts
        FROM crm_pipeline_stages s
        LEFT JOIN crm_deals d ON d.stage_id = s.id
        GROUP BY s.id, s.name, s.order_index, s.color
        ORDER BY s.order_index
    """)).fetchall()
    return [_row(r) for r in rows]


@router.get("/reports/agent-performance")
def agent_performance(
    days: int = Query(30, le=365),
    db=Depends(get_pg), _=Depends(ACCESS),
):
    """Activity volume, deals owned, and tasks completed per agent."""
    rows = db.execute(text("""
        SELECT u.id, u.full_name, u.role,
               COUNT(DISTINCT a.id)   FILTER (WHERE a.created_at >= NOW() - (:days || ' days')::INTERVAL) AS activities,
               COUNT(DISTINCT d.id)   AS deals_owned,
               COUNT(DISTINCT d.id)   FILTER (WHERE s.is_won)  AS deals_won,
               COUNT(DISTINCT t.id)   AS tasks_assigned,
               COUNT(DISTINCT t.id)   FILTER (WHERE t.status = 'done') AS tasks_done,
               COUNT(DISTINCT c.id)   AS contacts_owned
        FROM o3c_users u
        LEFT JOIN crm_activities a ON a.created_by  = u.id
        LEFT JOIN crm_deals      d ON d.assigned_to = u.id
        LEFT JOIN crm_pipeline_stages s ON s.id = d.stage_id
        LEFT JOIN crm_tasks      t ON t.assigned_to = u.id
        LEFT JOIN crm_contacts   c ON c.assigned_to = u.id
        WHERE u.role IN ('sales','management','admin','collections','call_centre')
        GROUP BY u.id, u.full_name, u.role
        ORDER BY activities DESC NULLS LAST
    """), {"days": days}).fetchall()
    return [_row(r) for r in rows]


@router.get("/reports/activity-trend")
def activity_trend(
    days: int = Query(30, le=180),
    db=Depends(get_pg), _=Depends(ACCESS),
):
    """Daily activity count for the last N days."""
    rows = db.execute(text("""
        SELECT DATE(created_at) AS day,
               type,
               COUNT(*) AS count
        FROM crm_activities
        WHERE created_at >= NOW() - (:days || ' days')::INTERVAL
        GROUP BY DATE(created_at), type
        ORDER BY day
    """), {"days": days}).fetchall()
    return [_row(r) for r in rows]


@router.get("/reports/contacts-by-source")
def contacts_by_source(db=Depends(get_pg), _=Depends(ACCESS)):
    rows = db.execute(text("""
        SELECT source,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'customer') AS converted
        FROM crm_contacts
        GROUP BY source
        ORDER BY total DESC
    """)).fetchall()
    return [_row(r) for r in rows]


@router.get("/reports/requests-sla")
def requests_sla(db=Depends(get_pg), _=Depends(ACCESS)):
    """SLA compliance by request type."""
    rows = db.execute(text("""
        SELECT request_type,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status IN ('resolved','closed')) AS resolved,
               COUNT(*) FILTER (WHERE
                 status NOT IN ('resolved','closed')
                 AND created_at + (sla_hours || ' hours')::INTERVAL < NOW()
               ) AS sla_breached,
               ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600)
                 FILTER (WHERE resolved_at IS NOT NULL)::NUMERIC, 1) AS avg_resolution_hrs
        FROM crm_requests
        GROUP BY request_type
        ORDER BY total DESC
    """)).fetchall()
    return [_row(r) for r in rows]


@router.get("/reports/new-contacts-trend")
def new_contacts_trend(db=Depends(get_pg), _=Depends(ACCESS)):
    """Monthly new contacts and conversions."""
    rows = db.execute(text("""
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') AS month,
               COUNT(*) AS new_contacts,
               COUNT(*) FILTER (WHERE status = 'customer') AS converted
        FROM crm_contacts
        WHERE created_at >= NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at)
    """)).fetchall()
    return [_row(r) for r in rows]
