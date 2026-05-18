/**
 * DataBanner — shows whether data is live from MSSQL or a Supabase snapshot
 *
 * Usage:
 *   <DataBanner source={dataSource} lastSync={lastSyncTime} />
 *
 * source: "mssql_live" | "supabase_snapshot" | null
 */
export default function DataBanner({ source, lastSync }) {
  if (!source) return null

  const isLive = source === "mssql_live"

  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 10px",
      borderRadius: 20,
      fontSize: 11,
      fontWeight: 600,
      background: isLive ? "#DCFCE7" : "#FEF3C7",
      color: isLive ? "#166534" : "#92400E",
      marginBottom: 16,
    }}>
      <span style={{
        width: 7, height: 7,
        borderRadius: "50%",
        background: isLive ? "#16a34a" : "#F59E0B",
        display: "inline-block",
        ...(isLive ? { animation: "pulse 2s infinite" } : {})
      }} />
      {isLive
        ? "Live data · MSSQL"
        : `Snapshot · Last synced ${lastSync ? new Date(lastSync).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "unknown"}`
      }
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}
