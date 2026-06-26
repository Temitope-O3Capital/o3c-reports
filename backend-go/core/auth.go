package core

import (
	"context"
	"encoding/json"
	"fmt"
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

// Claims is the JWT payload.
type Claims struct {
	Sub        string   `json:"sub"`
	ID         int64    `json:"id"`
	Role       string   `json:"role"`
	FullName   string   `json:"full_name"`
	Department string   `json:"department"`
	Pages      []string `json:"pages"`
	jwt.RegisteredClaims
}

type ctxKey struct{}

// UserFromCtx retrieves the authenticated user from a request context.
func UserFromCtx(ctx context.Context) *Claims {
	c, _ := ctx.Value(ctxKey{}).(*Claims)
	return c
}

var secretKey string

// InitAuth must be called once at startup with the SECRET_KEY value.
func InitAuth(key string) { secretKey = key }

func CreateToken(c *Claims) (string, error) {
	c.RegisteredClaims = jwt.RegisteredClaims{
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(tokenExpiry)),
		Audience:  jwt.ClaimStrings{tokenAudience},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secretKey))
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

// AuthMiddleware validates the Bearer token and populates the request context.
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			authErr(w, 401, "Unauthorized")
			return
		}
		claims, err := VerifyToken(strings.TrimPrefix(header, "Bearer "))
		if err != nil {
			authErr(w, 401, "Invalid or expired token")
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
		"overview", "executive", "transactions", "income", "eod", "uploads",
		"reconciliation", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "call_center", "loans", "credit_portfolio", "fixed_deposit", "settlement", "mobile_app", "blink_card",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
		"los", "los_all", "los_assign", "customer360",
		"hr_employees", "hr_leave", "hr_performance", "hr_disciplinary", "hr_payroll", "hr_training",
		"compliance_all", "compliance_checklists", "cbn_reports", "audit_trail", "audit_export",
		"sars", "watch_list", "audit_findings",
		"kpi_dashboard", "reports", "admin_users", "settings", "sync_status",
	},
	"coo": {
		"overview", "executive", "transactions", "income", "eod", "uploads",
		"reconciliation", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "call_center", "loans", "credit_portfolio", "fixed_deposit", "settlement", "mobile_app", "blink_card",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
		"los", "los_all", "customer360",
		"kpi_dashboard", "reports",
	},
	"cfo": {
		"overview", "executive", "income", "eod", "uploads", "reconciliation",
		"collections", "recovery", "transactions", "loans", "credit_portfolio",
		"fixed_deposit", "settlement",
		"los_finance", "customer360",
		"cbn_reports", "audit_trail", "audit_export",
		"kpi_dashboard", "reports",
	},
	"executive": {
		"overview", "executive", "kpi_dashboard", "reports",
	},

	// ── Sales ──────────────────────────────────────────────────────────────────
	"sales_officer": {
		"overview", "sales", "uploads", "loans", "credit_portfolio",
		"los", "customer360",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
	},
	"sales_head": {
		"overview", "sales", "executive", "uploads", "loans", "credit_portfolio",
		"los", "los_all", "los_assign", "customer360",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
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
		"credit_portfolio", "loans", "kpi_dashboard",
	},

	// ── Finance ────────────────────────────────────────────────────────────────
	"finance_officer": {
		"overview", "income", "eod", "transactions", "reconciliation",
		"collections_payment", "credit_portfolio", "fixed_deposit", "settlement",
		"los_finance", "customer360",
	},
	"finance_head": {
		"overview", "income", "eod", "transactions", "uploads", "reconciliation",
		"collections_payment", "collections_payment_approve",
		"credit_portfolio", "fixed_deposit", "settlement",
		"los_finance", "los_finance_approve", "customer360",
		"kpi_dashboard", "reports",
	},

	// ── Cards Ops ──────────────────────────────────────────────────────────────
	"cards_ops_officer": {
		"overview", "cards", "card_trends", "eod", "uploads",
		"los_booking", "customer360",
	},
	"cards_ops_head": {
		"overview", "cards", "card_trends", "eod", "uploads",
		"los_booking", "los_assign", "customer360",
		"kpi_dashboard",
	},

	// ── Collections ────────────────────────────────────────────────────────────
	"collections_agent": {
		"overview", "collections", "customer360", "eod", "uploads",
		"crm_contacts",
	},
	"collections_head": {
		"overview", "collections", "collections_assign", "customer360",
		"eod", "uploads", "reconciliation", "loans", "credit_portfolio",
		"crm_contacts", "kpi_dashboard",
	},

	// ── Recovery ───────────────────────────────────────────────────────────────
	"recovery_agent": {
		"overview", "recovery", "customer360", "eod", "uploads",
	},
	"recovery_head": {
		"overview", "recovery", "recovery_assign", "recovery_write_off",
		"customer360", "eod", "uploads", "loans", "credit_portfolio",
		"kpi_dashboard",
	},

	// ── Call Center ────────────────────────────────────────────────────────────
	"call_center_agent": {
		"overview", "call_center", "customer360", "transactions",
		"crm_contacts", "uploads",
	},
	"call_center_head": {
		"overview", "call_center", "customer360", "transactions",
		"crm_contacts", "uploads", "kpi_dashboard",
	},

	// ── HR ─────────────────────────────────────────────────────────────────────
	"hr_officer": {
		"overview", "hr_employees", "hr_leave", "hr_training", "uploads",
	},
	"hr_manager": {
		"overview", "hr_employees", "hr_leave", "hr_performance",
		"hr_training", "hr_disciplinary", "hr_payroll", "uploads",
		"kpi_dashboard",
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
		"cbn_reports", "kpi_dashboard", "reports",
	},

	// ── IT Admin ───────────────────────────────────────────────────────────────
	"it_admin": {
		"overview", "transactions", "collections", "recovery", "sales",
		"cards", "card_trends", "cohort", "admin_users", "executive", "income", "eod",
		"uploads", "reconciliation", "call_center", "loans", "credit_portfolio",
		"fixed_deposit", "settlement", "los", "los_all", "customer360",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
		"hr_employees", "hr_leave", "hr_performance", "hr_disciplinary",
		"compliance_checklists", "audit_trail", "watch_list",
		"kpi_dashboard", "reports", "settings", "sync_status",
	},

	// ── Legacy roles (keep for backwards compatibility) ──────────────────────
	"admin": {
		"overview", "executive", "transactions", "income", "eod", "uploads",
		"reconciliation", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "call_center", "customer_service", "loans", "credit_portfolio",
		"fixed_deposit", "settlement", "mobile_app", "blink_card",
		"risk_all", "risk_officer", "risk_head",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
		"los", "los_all", "los_assign", "customer360",
		"hr_employees", "hr_leave", "hr_performance", "hr_disciplinary", "hr_payroll", "hr_training",
		"compliance_all", "compliance_checklists", "cbn_reports", "audit_trail", "audit_export",
		"sars", "watch_list", "audit_findings",
		"collections_assign", "collections_payment", "collections_payment_approve",
		"recovery_assign", "recovery_write_off",
		"kpi_dashboard", "reports", "admin_users", "admin_api_keys", "settings", "sync_status",
	},
	"management": {
		"overview", "executive", "transactions", "income", "eod", "uploads",
		"reconciliation", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "call_center", "customer_service", "loans", "credit_portfolio",
		"fixed_deposit", "settlement", "mobile_app", "blink_card",
		"risk_all", "risk_officer", "risk_head",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
		"collections_assign", "recovery_assign", "recovery_write_off",
		"kpi_dashboard", "reports",
	},
	"head_ops": {
		"overview", "executive", "transactions", "income", "eod", "uploads",
		"reconciliation", "collections", "recovery", "cards", "card_trends",
		"cohort", "call_center", "customer_service", "loans", "credit_portfolio",
		"fixed_deposit", "settlement",
		"risk_all", "risk_officer", "risk_head",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"collections_assign", "recovery_assign", "recovery_write_off",
		"kpi_dashboard", "reports",
	},
	"head_it": {
		"overview", "transactions", "collections", "recovery", "sales", "cards", "card_trends",
		"cohort", "admin_users", "admin_api_keys", "executive", "income", "eod", "uploads",
		"reconciliation", "call_center", "customer_service", "loans", "credit_portfolio",
		"fixed_deposit", "settlement", "risk_all",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
		"hr_employees", "hr_leave", "compliance_checklists", "audit_trail", "watch_list",
		"kpi_dashboard", "reports", "settings", "sync_status", "los", "los_all", "customer360",
	},
	"head_of_reconciliation": {
		"overview", "income", "eod", "transactions", "uploads", "reconciliation",
		"collections_payment", "collections_payment_approve",
		"credit_portfolio", "fixed_deposit", "settlement",
		"los_finance", "los_finance_approve", "customer360",
		"kpi_dashboard", "reports",
	},
	"sales":            {"sales", "overview", "uploads", "loans", "credit_portfolio", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports", "campaigns", "contact_lists", "message_templates"},
	"collections":      {"collections", "recovery", "eod", "uploads", "reconciliation", "crm_pipeline", "crm_contacts", "crm_tasks"},
	"recovery":         {"recovery", "collections", "eod", "uploads", "loans", "crm_pipeline", "crm_contacts", "crm_tasks"},
	"cards_ops":        {"cards", "card_trends", "transactions", "overview", "eod", "uploads"},
	"call_centre":      {"overview", "transactions", "call_center", "customer_service", "crm_contacts", "uploads"},
	"head_hr":          {"overview", "hr_employees", "hr_leave", "hr_performance", "hr_disciplinary", "hr_payroll", "hr_training", "uploads", "kpi_dashboard"},
	"cmo":              {"overview", "sales", "cohort", "executive", "uploads", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports", "campaigns", "contact_lists", "message_templates"},
	"head_sales":       {"sales", "overview", "uploads", "executive", "loans", "credit_portfolio", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports", "campaigns", "contact_lists", "message_templates"},
	"head_collections": {"collections", "recovery", "overview", "eod", "uploads", "executive", "reconciliation", "loans", "credit_portfolio", "crm_pipeline", "crm_contacts", "crm_tasks"},
	"head_recovery":    {"recovery", "collections", "overview", "eod", "uploads", "executive", "loans", "credit_portfolio", "crm_pipeline", "crm_contacts", "crm_tasks"},
}
