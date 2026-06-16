package core

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const tokenAudience = "o3c:api"
const tokenExpiry = 8 * time.Hour

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

func VerifyToken(raw string) (*Claims, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(raw, c, func(*jwt.Token) (any, error) {
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

func authErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"detail": msg}) //nolint:errcheck
}

// ── Role → page mapping ──────────────────────────────────────────────────────

var RolePages = map[string][]string{
	"md": {
		"overview", "transactions", "collections", "recovery", "sales",
		"cards", "cohort", "card_trends", "executive", "income", "eod",
		"uploads", "reconciliation", "call_center", "loans", "admin",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
	},
	"coo": {
		"overview", "transactions", "collections", "recovery", "cards", "cohort",
		"card_trends", "executive", "income", "eod", "uploads", "reconciliation",
		"call_center", "loans",
		"crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports",
		"campaigns", "contact_lists", "message_templates",
	},
	"cfo":              {"overview", "income", "collections", "recovery", "executive", "transactions", "eod", "uploads", "reconciliation", "loans"},
	"head_it":          {"overview", "transactions", "collections", "recovery", "sales", "cards", "cohort", "card_trends", "admin", "executive", "income", "eod", "uploads", "reconciliation", "call_center", "loans", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports", "campaigns", "contact_lists", "message_templates"},
	"head_hr":          {"overview", "sales", "uploads"},
	"cmo":              {"overview", "sales", "cohort", "executive", "uploads", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports", "campaigns", "contact_lists", "message_templates"},
	"head_ops":         {"overview", "transactions", "cards", "card_trends", "cohort", "executive", "income", "eod", "uploads", "reconciliation", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests"},
	"head_sales":       {"sales", "overview", "uploads", "executive", "loans", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports", "campaigns", "contact_lists", "message_templates"},
	"head_collections": {"collections", "recovery", "overview", "eod", "uploads", "executive", "reconciliation", "loans", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests"},
	"head_recovery":    {"recovery", "collections", "overview", "eod", "uploads", "executive", "loans", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests"},
	"admin":            {"overview", "transactions", "collections", "recovery", "sales", "cards", "card_trends", "cohort", "admin", "executive", "income", "eod", "uploads", "reconciliation", "call_center", "loans", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports", "campaigns", "contact_lists", "message_templates"},
	"management":       {"overview", "transactions", "collections", "recovery", "sales", "cards", "card_trends", "cohort", "executive", "income", "eod", "uploads", "reconciliation", "call_center", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports", "campaigns", "contact_lists", "message_templates"},
	"sales":            {"sales", "overview", "uploads", "loans", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests", "crm_reports", "campaigns", "contact_lists", "message_templates"},
	"collections":      {"collections", "recovery", "eod", "uploads", "reconciliation", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests"},
	"recovery":         {"recovery", "collections", "eod", "uploads", "loans", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_requests"},
	"cards_ops":        {"cards", "card_trends", "transactions", "overview", "eod", "uploads"},
	"call_centre":      {"overview", "transactions", "call_center", "crm_requests", "crm_contacts", "uploads"},
}
