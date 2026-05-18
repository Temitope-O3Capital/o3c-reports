from fastapi import APIRouter, Depends
from core.database import get_db_pg, get_db_mssql
from core.auth import require_pages
from core.dual_query import dual_query, dual_scalar

router = APIRouter()

@router.get("/kpis")
def cards_kpis(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["cards"]))):
    kpis, sources = {}, []
    def q(ms, pg, key):
        val, src = dual_scalar(db_mssql, db_pg, ms, pg)
        kpis[key] = int(val) if val else 0
        sources.append(src)
    q("SELECT COUNT(*) AS val FROM dbo.Products", 'SELECT COUNT(*) AS val FROM "Products"', "total_issued")
    q("SELECT COUNT(*) AS val FROM dbo.Products WHERE [Account Status]='Open'", 'SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status"=\'Open\'', "active")
    for p in ["Prepaid","Credit","International"]:
        q(f"SELECT COUNT(*) AS val FROM dbo.Products WHERE [Product Name]='{p}'", f'SELECT COUNT(*) AS val FROM "Products" WHERE "Product Name"=\'{p}\'', p.lower())
    kpis["activation_rate"] = round(kpis["active"] / kpis["total_issued"] * 100, 1) if kpis["total_issued"] > 0 else 0
    return {"data": kpis, "data_source": "mssql_live" if "mssql_live" in sources else "supabase_snapshot"}

@router.get("/by-product")
def by_product(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["cards"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT [Product Name], COUNT(*) AS count FROM dbo.Products GROUP BY [Product Name] ORDER BY count DESC",
        'SELECT "Product Name", COUNT(*) AS count FROM "Products" GROUP BY "Product Name" ORDER BY count DESC')
    return {"data": data, "data_source": src}

@router.get("/by-status")
def by_status(db_pg=Depends(get_db_pg), db_mssql=Depends(get_db_mssql), user=Depends(require_pages(["cards"]))):
    data, src = dual_query(db_mssql, db_pg,
        "SELECT [Account Status], COUNT(*) AS count FROM dbo.Products GROUP BY [Account Status] ORDER BY count DESC",
        'SELECT "Account Status", COUNT(*) AS count FROM "Products" GROUP BY "Account Status" ORDER BY count DESC')
    return {"data": data, "data_source": src}
