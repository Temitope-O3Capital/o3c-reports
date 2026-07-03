package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const tokenAudience = "o3c:api"
const tokenExpiry = 8 * time.Hour

const sseTokenAudience = "o3c:sse"
const sseTokenExpiry = 2 * time.Minute

const mfaTokenAudience = "o3c:mfa"
const mfaTokenExpiry = 10 * time.Minute

// Claims is the JWT payload.
type Claims struct {
	Sub        string   `json:"sub"`
	ID         int64    `json:"id"`
	Role       string   `json:"role"`
	FullName   string   `json:"full_name"`
	Department string   `json:"department"`
	Pages      []string `json:"pages"`
	JTI        string   `json:"jti,omitempty"`
	jwt.RegisteredClaims
}

type ctxKey struct{}

// UserFromCtx retrieves the authenticated user from a request context.
func UserFromCtx(ctx context.Context) *Claims {
	c, _ := ctx.Value(ctxKey{}).(*Claims)
	return c
}

// HasPage reports whether the user has been granted the given page permission,
// either via their role's built-in page list or their per-user page overrides.
func (c *Claims) HasPage(page string) bool {
	for _, p := range RolePages[c.Role] {
		if p == page {
			return true
		}
	}
	for _, p := range c.Pages {
		if p == page {
			return true
		}
	}
	return false
}

var secretKey string
var authDB *DB // set by InitAuthDB; used for JTI denylist checks

// InitAuth must be called once at startup with the SECRET_KEY value.
func InitAuth(key string) { secretKey = key }

// InitAuthDB wires in the database so AuthMiddleware can check the token denylist.
func InitAuthDB(d *DB) { authDB = d }

func newJTI() string {
	b := make([]byte, 16)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}

func CreateToken(c *Claims) (string, error) {
	c.JTI = newJTI()
	c.RegisteredClaims = jwt.RegisteredClaims{
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(tokenExpiry)),
		Audience:  jwt.ClaimStrings{tokenAudience},
		ID:        c.JTI,
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secretKey))
}

// RevokeToken inserts a JTI into the denylist, invalidating that token immediately.
func RevokeToken(ctx context.Context, jti string, userID int64, expiresAt time.Time) error {
	if authDB == nil {
		return fmt.Errorf("authDB not initialised")
	}
	_, err := authDB.PGExec(ctx,
		`INSERT INTO token_denylists (jti, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		jti, userID, expiresAt)
	return err
}

// isTokenRevoked returns true when the JTI is in the denylist.
func isTokenRevoked(ctx context.Context, jti string) bool {
	if authDB == nil || jti == "" {
		return false
	}
	rows, err := authDB.PGQuery(ctx, `SELECT 1 FROM token_denylists WHERE jti=$1 LIMIT 1`, jti)
	if err != nil {
		slog.Warn("denylist check failed", "err", err)
		return false // fail open to avoid locking out all users on DB hiccup
	}
	return len(rows) > 0
}

// CreateSSEToken issues a short-lived (2 min) token for the SSE endpoint.
// EventSource cannot set headers, so the token is passed as a query param;
// using a short-lived ticket limits log-exposure risk.
func CreateSSEToken(userID int64) (string, error) {
	c := &Claims{
		ID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(sseTokenExpiry)),
			Audience:  jwt.ClaimStrings{sseTokenAudience},
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secretKey))
}

// CreateMFAToken issues a short-lived (10 min) challenge token after a successful
// password check when the user has TOTP enabled. The token only contains the user
// ID; it must be exchanged for a full access token via POST /api/auth/totp/challenge.
func CreateMFAToken(userID int64) (string, error) {
	c := &Claims{
		ID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(mfaTokenExpiry)),
			Audience:  jwt.ClaimStrings{mfaTokenAudience},
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secretKey))
}

// VerifyMFAToken validates a token issued by CreateMFAToken and returns the user ID.
func VerifyMFAToken(raw string) (int64, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(raw, c, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secretKey), nil
	}, jwt.WithAudience(mfaTokenAudience))
	if err != nil {
		return 0, err
	}
	return c.ID, nil
}

// VerifySSEToken validates a ticket issued by CreateSSEToken.
func VerifySSEToken(raw string) (*Claims, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(raw, c, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secretKey), nil
	}, jwt.WithAudience(sseTokenAudience))
	if err != nil {
		return nil, err
	}
	return c, nil
}

func VerifyToken(raw string) (*Claims, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(raw, c, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secretKey), nil
	}, jwt.WithAudience(tokenAudience))
	if err != nil {
		return nil, err
	}
	return c, nil
}

func HashPassword(pw string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(pw), 12)
	return string(h), err
}

func CheckPassword(plain, hashed string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hashed), []byte(plain)) == nil
}

// AuthMiddleware validates the Bearer token (or o3c_token HttpOnly cookie as fallback)
// and populates the request context. Also checks the JTI denylist.
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := ""
		if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
			raw = strings.TrimPrefix(header, "Bearer ")
		} else if cookie, err := r.Cookie("o3c_token"); err == nil {
			raw = cookie.Value
		}
		if raw == "" {
			authErr(w, 401, "Unauthorized")
			return
		}
		claims, err := VerifyToken(raw)
		if err != nil {
			authErr(w, 401, "Invalid or expired token")
			return
		}
		if isTokenRevoked(r.Context(), claims.JTI) {
			authErr(w, 401, "Token has been revoked")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, claims)))
	})
}

// RequirePages returns middleware that gates access by page permission.
func RequirePages(pages ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := UserFromCtx(r.Context())
			if user == nil {
				authErr(w, 401, "Unauthorized")
				return
			}
			allowed := make(map[string]bool)
			for _, p := range RolePages[user.Role] {
				allowed[p] = true
			}
			for _, p := range user.Pages {
				allowed[p] = true
			}
			for _, p := range pages {
				if allowed[p] {
					next.ServeHTTP(w, r)
					return
				}
			}
			authErr(w, 403, fmt.Sprintf("Role '%s' cannot access this resource", user.Role))
		})
	}
}

// ParsePages normalizes role page payloads returned from Postgres JSON/JSONB,
// array columns, or decoded request bodies into a clean string slice.
func ParsePages(raw any) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(v string) {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			return
		}
		seen[v] = true
		out = append(out, v)
	}

	switch v := raw.(type) {
	case nil:
	case []string:
		for _, item := range v {
			add(item)
		}
	case []any:
		for _, item := range v {
			add(fmt.Sprint(item))
		}
	case []byte:
		var arr []string
		if err := json.Unmarshal(v, &arr); err == nil {
			for _, item := range arr {
				add(item)
			}
			break
		}
		var anyArr []any
		if err := json.Unmarshal(v, &anyArr); err == nil {
			for _, item := range anyArr {
				add(fmt.Sprint(item))
			}
		}
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			break
		}
		var arr []string
		if err := json.Unmarshal([]byte(s), &arr); err == nil {
			for _, item := range arr {
				add(item)
			}
			break
		}
		var anyArr []any
		if err := json.Unmarshal([]byte(s), &anyArr); err == nil {
			for _, item := range anyArr {
				add(fmt.Sprint(item))
			}
			break
		}
		add(s)
	default:
		add(fmt.Sprint(v))
	}
	return out
}

func BuiltinRoleNames() []string {
	names := make([]string, 0, len(RolePages))
	for name := range RolePages {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func authErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"detail": msg}) //nolint:errcheck
}

// ── Role → page mapping ──────────────────────────────────────────────────────

var RolePages = map[string][]string{
	// ── Executive ──────────────────────────────────────────────────────────────
	"md": {
		"overview", "executive", "transactions", "income", "finance", "eod", "uploads",
		"reconciliation", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "call_center", "loans", "credit_portfolio", "fixed_deposit", "settlement", "mobile_app", "blink_card",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates", "statements",
		"los", "los_all", "los_assign", "customer360",
		"hr_employees", "hr_leave", "hr_performance", "hr_disciplinary", "hr_payroll", "hr_training",
		"compliance_all", "compliance_checklists", "cbn_reports", "audit_trail", "audit_export",
		"sars", "watch_list", "audit_findings",
		"kpi_dashboard", "reports", "approvals", "statements", "admin_users", "settings", "sync_status",
		"active_loan_book", "telemarketing", "telemarketing_stats", "bd", "bd_employers", "bd_pipeline",
		"helpdesk_kb",
	},
	"coo": {
		"overview", "executive", "transactions", "income", "finance", "eod", "uploads",
		"reconciliation", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "call_center", "loans", "credit_portfolio", "fixed_deposit", "settlement", "mobile_app", "blink_card",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates", "statements",
		"los", "los_all", "customer360",
		"kpi_dashboard", "reports", "statements",
	},
	"cfo": {
		"overview", "executive", "income", "finance", "eod", "uploads", "reconciliation",
		"collections", "recovery", "transactions", "loans", "credit_portfolio",
		"fixed_deposit", "settlement",
		"los_finance", "customer360",
		"cbn_reports", "audit_trail", "audit_export",
		"kpi_dashboard", "reports", "statements",
		"payroll", "payroll_manager",
	},
	"executive": {
		"overview", "executive", "kpi_dashboard", "reports", "statements",
	},

	// ── Sales ──────────────────────────────────────────────────────────────────
	"sales_officer": {
		"overview", "sales", "uploads", "loans", "credit_portfolio",
		"los", "customer360",
		"bd", "bd_employers", "bd_pipeline",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates", "statements",
	},
	"sales_head": {
		"overview", "sales", "executive", "uploads", "loans", "credit_portfolio",
		"los", "los_all", "los_assign", "customer360",
		"bd", "bd_employers", "bd_pipeline",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates", "statements",
		"kpi_dashboard",
	},

	// ── Risk ───────────────────────────────────────────────────────────────────
	"risk_officer": {
		"overview", "customer360",
		"los_risk_review", "credit_portfolio", "loans",
	},
	"risk_head": {
		"overview", "customer360", "executive",
		"los_risk_review", "los_risk_head", "los_assign",
		"credit_portfolio", "loans", "kpi_dashboard", "statements",
	},

	// ── Finance ────────────────────────────────────────────────────────────────
	"finance_officer": {
		"overview", "income", "finance", "eod", "transactions", "reconciliation",
		"collections_payment", "credit_portfolio", "fixed_deposit", "settlement",
		"los_finance", "customer360",
	},
	"finance_head": {
		"overview", "income", "finance", "eod", "transactions", "uploads", "reconciliation",
		"collections_payment", "collections_payment_approve",
		"credit_portfolio", "fixed_deposit", "settlement",
		"los_finance", "los_finance_approve", "customer360",
		"kpi_dashboard", "reports", "statements",
	},

	// ── Cards Ops ──────────────────────────────────────────────────────────────
	"cards_ops_officer": {
		"overview", "cards", "card_trends", "eod", "uploads",
		"los_booking", "customer360",
	},
	"cards_ops_head": {
		"overview", "cards", "card_trends", "eod", "uploads",
		"los_booking", "los_assign", "customer360",
		"kpi_dashboard", "statements",
	},

	// ── Collections ────────────────────────────────────────────────────────────
	"collections_agent": {
		"overview", "collections", "customer360", "eod", "uploads",
		"crm_contacts",
	},
	"collections_head": {
		"overview", "collections", "collections_assign", "customer360",
		"eod", "uploads", "reconciliation", "loans", "credit_portfolio",
		"crm_contacts", "kpi_dashboard", "statements",
	},

	// ── Recovery ───────────────────────────────────────────────────────────────
	"recovery_agent": {
		"overview", "recovery", "customer360", "eod", "uploads",
	},
	"recovery_head": {
		"overview", "recovery", "recovery_assign", "recovery_write_off",
		"customer360", "eod", "uploads", "loans", "credit_portfolio",
		"kpi_dashboard", "statements",
	},

	// ── Call Center ────────────────────────────────────────────────────────────
	"call_center_agent": {
		"overview", "call_center", "customer360", "transactions",
		"crm_contacts", "uploads",
	},
	"call_center_head": {
		"overview", "call_center", "customer360", "transactions",
		"crm_contacts", "uploads", "kpi_dashboard", "statements", "helpdesk_kb",
	},

	// ── HR ─────────────────────────────────────────────────────────────────────
	"hr_officer": {
		"overview", "hr_employees", "hr_leave", "hr_training", "uploads",
	},
	"hr_manager": {
		"overview", "hr_employees", "hr_leave", "hr_performance",
		"hr_training", "hr_disciplinary", "hr_payroll", "uploads",
		"kpi_dashboard", "statements",
	},

	// ── Compliance ─────────────────────────────────────────────────────────────
	"compliance_officer": {
		"overview", "compliance_checklists", "audit_findings", "watch_list",
	},
	"compliance_head": {
		"overview", "compliance_all", "compliance_checklists", "cbn_reports",
		"sars", "audit_trail", "audit_export", "watch_list", "audit_findings",
		"kpi_dashboard",
	},

	// ── Internal Control ───────────────────────────────────────────────────────
	"internal_control_head": {
		"overview", "audit_trail", "audit_export", "audit_findings",
		"cbn_reports", "kpi_dashboard", "reports", "statements",
	},

	// ── IT Admin ───────────────────────────────────────────────────────────────
	"it_admin": {
		"overview", "transactions", "collections", "recovery", "sales",
		"cards", "card_trends", "cohort", "admin_users", "executive", "income", "finance", "eod",
		"uploads", "reconciliation", "call_center", "loans", "credit_portfolio",
		"fixed_deposit", "settlement", "los", "los_all", "customer360",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates", "statements",
		"hr_employees", "hr_leave", "hr_performance", "hr_disciplinary",
		"compliance_checklists", "audit_trail", "watch_list",
		"kpi_dashboard", "reports", "statements", "settings", "sync_status",
	},

	// ── Legacy roles (keep for backwards compatibility) ──────────────────────
	"admin": {
		"overview", "executive", "transactions", "income", "finance", "eod", "uploads",
		"reconciliation", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "call_center", "customer_service", "loans", "credit_portfolio",
		"fixed_deposit", "settlement", "mobile_app", "blink_card",
		"risk_all", "risk_officer", "risk_head",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates", "statements",
		"los", "los_all", "los_assign", "customer360",
		"hr_employees", "hr_leave", "hr_performance", "hr_disciplinary", "hr_payroll", "hr_training",
		"compliance_all", "compliance_checklists", "cbn_reports", "audit_trail", "audit_export",
		"sars", "watch_list", "audit_findings",
		"collections_assign", "collections_payment", "collections_payment_approve",
		"recovery_assign", "recovery_write_off",
		"kpi_dashboard", "reports", "statements", "admin_users", "admin_api_keys", "settings", "sync_status",
		"active_loan_book", "telemarketing", "telemarketing_stats", "bd", "bd_employers", "bd_pipeline",
		"helpdesk_kb", "payroll", "payroll_manager",
	},
	"management": {
		"overview", "executive", "transactions", "income", "eod", "uploads",
		"reconciliation", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "call_center", "customer_service", "loans", "credit_portfolio",
		"fixed_deposit", "settlement", "mobile_app", "blink_card",
		"risk_all", "risk_officer", "risk_head",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates", "statements",
		"collections_assign", "recovery_assign", "recovery_write_off",
		"kpi_dashboard", "reports", "statements",
	},
	"head_ops": {
		"overview", "executive", "transactions", "income", "eod", "uploads",
		"reconciliation", "collections", "recovery", "cards", "card_trends",
		"cohort", "call_center", "customer_service", "loans", "credit_portfolio",
		"fixed_deposit", "settlement",
		"risk_all", "risk_officer", "risk_head",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"collections_assign", "recovery_assign", "recovery_write_off",
		"kpi_dashboard", "reports", "statements",
	},
	"head_it": {
		"overview", "transactions", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "admin_users", "admin_api_keys", "executive", "income", "eod", "uploads",
		"reconciliation", "call_center", "customer_service", "loans", "credit_portfolio",
		"fixed_deposit", "settlement", "risk_all",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates", "statements",
		"hr_employees", "hr_leave", "compliance_checklists", "audit_trail", "watch_list",
		"kpi_dashboard", "reports", "statements", "settings", "sync_status", "los", "los_all", "customer360",
	},
	"head_of_reconciliation": {
		"overview", "income", "eod", "transactions", "uploads", "reconciliation",
		"collections_payment", "collections_payment_approve",
		"credit_portfolio", "fixed_deposit", "settlement",
		"los_finance", "los_finance_approve", "customer360",
		"kpi_dashboard", "reports", "statements",
	},
	"sales":            {"sales", "overview", "uploads", "loans", "credit_portfolio", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports", "campaigns", "contact_lists", "message_templates", "statements"},
	"collections":      {"collections", "recovery", "eod", "uploads", "reconciliation", "crm_pipeline", "crm_contacts", "crm_tasks"},
	"recovery":         {"recovery", "collections", "eod", "uploads", "loans", "crm_pipeline", "crm_contacts", "crm_tasks"},
	"cards_ops":        {"cards", "card_trends", "transactions", "overview", "eod", "uploads"},
	"call_centre":      {"overview", "transactions", "call_center", "customer_service", "crm_contacts", "uploads"},
	"head_hr":          {"overview", "hr_employees", "hr_leave", "hr_performance", "hr_disciplinary", "hr_payroll", "hr_training", "uploads", "kpi_dashboard"},
	"cmo":              {"overview", "sales", "cohort", "executive", "uploads", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports", "campaigns", "contact_lists", "message_templates", "statements"},
	"head_sales":       {"sales", "overview", "uploads", "executive", "loans", "credit_portfolio", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports", "campaigns", "contact_lists", "message_templates", "statements"},
	"head_collections": {"collections", "recovery", "overview", "eod", "uploads", "executive", "reconciliation", "loans", "credit_portfolio", "crm_pipeline", "crm_contacts", "crm_tasks"},
	"head_recovery":    {"recovery", "collections", "overview", "eod", "uploads", "executive", "loans", "credit_portfolio", "crm_pipeline", "crm_contacts", "crm_tasks"},

	// ── Telemarketing ─────────────────────────────────────────────────────────
	"telemarketing_agent": {
		"overview", "telemarketing", "customer360",
	},
	"telemarketing_head": {
		"overview", "telemarketing", "telemarketing_stats", "customer360",
		"kpi_dashboard",
	},

	// ── Business Development ──────────────────────────────────────────────────
	"bd_officer": {
		"overview", "bd", "bd_employers", "bd_pipeline", "customer360",
		"crm_contacts",
	},
	"bd_head": {
		"overview", "bd", "bd_employers", "bd_pipeline", "customer360",
		"crm_contacts", "kpi_dashboard", "statements",
	},

	// ── Payroll ───────────────────────────────────────────────────────────────
	"payroll_officer": {
		"overview", "payroll",
	},
	"payroll_manager": {
		"overview", "payroll", "payroll_manager", "hr_employees", "kpi_dashboard",
	},
}
