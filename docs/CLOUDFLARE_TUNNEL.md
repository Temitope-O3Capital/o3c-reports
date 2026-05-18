# Cloudflare Tunnel Setup — Office PC to Cloud

This connects your on-site MSSQL to Railway without opening firewall ports.
Run these commands on the **office PC where MSSQL is installed**.

---

## Install cloudflared

```powershell
# Windows (PowerShell as Administrator)
winget install Cloudflare.cloudflared

# Verify
cloudflared --version
```

---

## Authenticate

```powershell
cloudflared tunnel login
# Opens browser — log in with your Cloudflare account (free)
# If you don't have one: cloudflare.com → Sign up (free)
```

---

## Create the tunnel

```powershell
cloudflared tunnel create o3c-mssql
# Saves a credentials file — note the tunnel ID printed
```

---

## Create config file

Create `C:\Users\YOUR_USER\.cloudflared\config.yml`:

```yaml
tunnel: o3c-mssql
credentials-file: C:\Users\YOUR_USER\.cloudflared\TUNNEL_ID.json

ingress:
  - hostname: mssql.o3ccards.com
    service: tcp://localhost:1433
  - service: http_status:404
```

Replace:
- `YOUR_USER` with your Windows username
- `TUNNEL_ID` with the ID from the create step
- `mssql.o3ccards.com` with any subdomain you own on Cloudflare
  (if you don't have a domain, use `mssql-o3c.cfargotunnel.com`)

---

## Route DNS

```powershell
cloudflared tunnel route dns o3c-mssql mssql.o3ccards.com
```

---

## Run the tunnel

```powershell
cloudflared tunnel run o3c-mssql
```

Test it — from another machine:
```bash
curl telnet://mssql.o3ccards.com:1433
# Should see a connection (not "connection refused")
```

---

## Make it permanent (Windows Service)

```powershell
# Run as Administrator
cloudflared service install
# Now it starts automatically on boot, even without logging in
```

---

## Update Railway environment variables

Once tunnel is running, add to Railway:
```
MSSQL_SERVER   = mssql.o3ccards.com
MSSQL_DATABASE = YOUR_DATABASE_NAME
MSSQL_TRUSTED  = no
MSSQL_USER     = your_sql_username
MSSQL_PASSWORD = your_sql_password
```

Note: `MSSQL_TRUSTED = no` because Railway connects remotely (Windows auth won't work remotely — use SQL Server auth instead). Enable SQL Server authentication in SSMS if not already on:
- SSMS → Right-click server → Properties → Security → SQL Server and Windows Authentication mode

---

## Troubleshooting

**Tunnel disconnects frequently**
- Check office internet stability
- The sync engine still pushes to Supabase so dashboard stays up

**Can't connect from Railway**
- Check MSSQL is listening on port 1433: `netstat -an | findstr 1433`
- Check SQL Server Browser service is running
- Make sure TCP/IP is enabled in SQL Server Configuration Manager

**"Login failed for user"**
- Confirm SQL auth is enabled (see above)
- Test the credentials locally first in SSMS
