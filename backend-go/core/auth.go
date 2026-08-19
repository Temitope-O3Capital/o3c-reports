package core

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
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
const tokenExpiry = 30 * time.Minute

const sseTokenAudience = "o3c:sse"
const sseTokenExpiry = 2 * time.Minute

const mfaTokenAudience = "o3c:mfa"
const mfaTokenExpiry = 10 * time.Minute

// Claims is the JWT payload.
type Claims struct {
	Sub        string   `json:"sub"`
	ID         int64    `json:"id"`
	Role       string   `json:"role"`
	ExtraRoles []string `json:"extra_roles,omitempty"` // secondary team roles (multi-team staff)
	FullName   string   `json:"full_name"`
	Department string   `json:"department"`
	Pages      []string `json:"pages"`
	JTI        string   `json:"jti,omitempty"`
	// Remember marks a refresh token issued under "keep me signed in". It must survive
	// rotation: refreshHandler reissues with the same flag, otherwise a 30-day session
	// silently collapses to 7 days the first time it refreshes and the user is thrown
	// back to the login screen a week later for no visible reason.
	Remember bool `json:"rem,omitempty"`
	jwt.RegisteredClaims
}

// AllRoles returns the user's primary role plus any secondary (multi-team) roles.
func (c *Claims) AllRoles() []string {
	if len(c.ExtraRoles) == 0 {
		return []string{c.Role}
	}
	return append([]string{c.Role}, c.ExtraRoles...)
}

type ctxKey struct{}

// UserFromCtx retrieves the authenticated user from a request context.
func UserFromCtx(ctx context.Context) *Claims {
	c, _ := ctx.Value(ctxKey{}).(*Claims)
	return c
}

type ctxKeyNonce struct{}

// WithCSPNonce stores a CSP nonce in ctx for use by HTML handlers.
func WithCSPNonce(ctx context.Context, nonce string) context.Context {
	return context.WithValue(ctx, ctxKeyNonce{}, nonce)
}

// CSPNonceFromCtx retrieves the CSP nonce from ctx (empty string if not set).
func CSPNonceFromCtx(ctx context.Context) string {
	s, _ := ctx.Value(ctxKeyNonce{}).(string)
	return s
}

// HasPage reports whether the user has been granted the given page permission,
// via any of their roles' built-in page lists or the resolved page set on the token.
func (c *Claims) HasPage(page string) bool {
	// admin is the super-user (app builder): unconditional access to every page.
	if c.Role == "admin" {
		return true
	}
	for _, role := range c.AllRoles() {
		for _, p := range RolePages[role] {
			if p == page {
				return true
			}
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
		// IssuedAt is what makes revocation work. tokenPredatesInvalidation compares it
		// against the user's tokens_valid_from watermark and returns false when it is
		// nil — so without this, InvalidateUserTokens silently revokes nothing and a
		// password change or forgot-password reset leaves every existing session alive.
		IssuedAt: jwt.NewNumericDate(time.Now()),
		Audience: jwt.ClaimStrings{tokenAudience},
		ID:       c.JTI,
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

// InvalidateUserTokens revokes ALL of a user's outstanding access + refresh tokens
// by advancing their tokens_valid_from watermark. Any token issued before that
// moment is rejected by AuthMiddleware and the refresh handler — so a password
// reset/change actually kills existing sessions (not just deletes a log row).
func InvalidateUserTokens(ctx context.Context, userID int64) {
	if authDB == nil {
		return
	}
	if _, err := authDB.PGExec(ctx, `UPDATE o3c_users SET tokens_valid_from = NOW() WHERE id=$1`, userID); err != nil {
		slog.Warn("InvalidateUserTokens failed", "user", userID, "err", err)
	}
}

// tokenPredatesInvalidation reports whether a token was issued before the user's
// tokens_valid_from watermark (i.e. revoked by a password change). Fails OPEN on
// any DB/parse error so a transient DB issue can never lock everyone out. A 1s
// grace absorbs clock skew between token mint and the watermark write.
func tokenPredatesInvalidation(ctx context.Context, claims *Claims) bool {
	if authDB == nil || claims == nil || claims.IssuedAt == nil {
		return false
	}
	rows, err := authDB.PGQuery(ctx, `SELECT tokens_valid_from FROM o3c_users WHERE id=$1`, claims.ID)
	if err != nil || len(rows) == 0 {
		return false
	}
	vf, ok := rows[0]["tokens_valid_from"].(time.Time)
	if !ok {
		return false
	}
	return claims.IssuedAt.Time.Before(vf.Add(-1 * time.Second))
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
	return CreateMFATokenRemember(userID, false)
}

// CreateMFATokenRemember carries the "keep me signed in" choice through the MFA
// challenge. The user ticks the box at the password step, but the refresh token is not
// issued until the TOTP code is verified — so the preference has to survive the round
// trip. Putting it in the signed challenge token means the client cannot alter it
// between the two steps.
func CreateMFATokenRemember(userID int64, remember bool) (string, error) {
	c := &Claims{
		ID:       userID,
		Remember: remember,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(mfaTokenExpiry)),
			Audience:  jwt.ClaimStrings{mfaTokenAudience},
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secretKey))
}

// VerifyMFATokenClaims validates an MFA challenge token and returns its claims, so the
// caller can read both the user ID and the remembered flag.
func VerifyMFATokenClaims(raw string) (*Claims, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(raw, c, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secretKey), nil
	}, jwt.WithAudience(mfaTokenAudience))
	if err != nil {
		return nil, err
	}
	return c, nil
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

const refreshTokenAudience = "o3c:refresh"
const refreshTokenExpiry = 7 * 24 * time.Hour

// rememberTokenExpiry applies when the user ticks "keep me signed in". 30 days is a
// deliberate ceiling rather than an indefinite session: this workspace holds customer
// bank details and the card book, so a stolen laptop must eventually stop being a way
// in. Logout and a password change still revoke immediately regardless of this value.
const rememberTokenExpiry = 30 * 24 * time.Hour

// CreateRefreshToken issues a long-lived (7-day) refresh token for the given user.
func CreateRefreshToken(userID int64) (string, error) {
	return CreateRefreshTokenRemember(userID, false)
}

// RefreshTokenTTL is how long a refresh token lives, and therefore how long a user can
// go without re-entering a password. Exported so the cookie MaxAge is derived from the
// same value the token is signed with — the two drifting apart is what produces a
// cookie the browser still sends but the server rejects.
func RefreshTokenTTL(remember bool) time.Duration {
	if remember {
		return rememberTokenExpiry
	}
	return refreshTokenExpiry
}

// CreateRefreshTokenRemember issues a refresh token whose lifetime depends on whether
// the user asked to stay signed in. The flag is carried in the claims so rotation can
// preserve it.
func CreateRefreshTokenRemember(userID int64, remember bool) (string, error) {
	jti := newJTI()
	c := &Claims{
		ID:       userID,
		JTI:      jti,
		Remember: remember,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(RefreshTokenTTL(remember))),
			// Required for revocation — see the note in CreateToken. It matters more
			// here: a refresh token now lives up to 30 days, so an unrevocable one is a
			// month-long way back into the account.
			IssuedAt: jwt.NewNumericDate(time.Now()),
			Audience: jwt.ClaimStrings{refreshTokenAudience},
			ID:       jti,
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secretKey))
}

// VerifyRefreshToken validates a token issued by CreateRefreshToken and returns its claims.
func VerifyRefreshToken(raw string) (*Claims, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(raw, c, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secretKey), nil
	}, jwt.WithAudience(refreshTokenAudience))
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

// DummyHashCheck runs a bcrypt comparison against a pre-generated dummy hash so
// that callers can equalise timing when the requested email address does not exist.
// Without this the absence of a bcrypt call leaks whether an email is registered.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("dummy-password-for-timing-eq"), 12)

func DummyHashCheck(password string) {
	bcrypt.CompareHashAndPassword(dummyHash, []byte(password)) //nolint:errcheck
}

// IsTokenRevoked is the public wrapper around isTokenRevoked used by the
// refresh handler to validate refresh tokens against the denylist.
func IsTokenRevoked(ctx context.Context, jti string) bool {
	return isTokenRevoked(ctx, jti)
}

// TokenPredatesInvalidation is the exported wrapper used by the refresh handler to
// reject refresh tokens issued before the user's last password change.
func TokenPredatesInvalidation(ctx context.Context, claims *Claims) bool {
	return tokenPredatesInvalidation(ctx, claims)
}

// AuthMiddleware validates the Bearer token (or o3c_token HttpOnly cookie as fallback)
// and populates the request context. Also checks the JTI denylist.
// Cookie-authenticated mutation requests (POST/PUT/PATCH/DELETE) are validated against
// the X-CSRF-Token header using the double-submit cookie pattern.
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fromCookie := false
		raw := ""
		if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
			raw = strings.TrimPrefix(header, "Bearer ")
		} else if cookie, err := r.Cookie("o3c_token"); err == nil {
			raw = cookie.Value
			fromCookie = true
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
		// C2: reject tokens minted before the user's last password change/reset.
		if tokenPredatesInvalidation(r.Context(), claims) {
			authErr(w, 401, "Session expired — please sign in again")
			return
		}
		// CSRF double-submit check for cookie-authenticated state-changing requests.
		// Bearer-authenticated requests (mobile app, API clients) are exempt.
		if fromCookie {
			m := r.Method
			if m == http.MethodPost || m == http.MethodPut || m == http.MethodPatch || m == http.MethodDelete {
				csrfCookie, cookieErr := r.Cookie("o3c_csrf")
				csrfHeader := r.Header.Get("X-CSRF-Token")
				if cookieErr != nil || csrfHeader == "" || subtle.ConstantTimeCompare([]byte(csrfCookie.Value), []byte(csrfHeader)) != 1 {
					authErr(w, 403, "CSRF token invalid")
					return
				}
			}
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
			// admin is the super-user (app builder): bypass all page gating.
			if user.Role == "admin" {
				next.ServeHTTP(w, r)
				return
			}
			allowed := make(map[string]bool)
			for _, role := range user.AllRoles() {
				for _, p := range RolePages[role] {
					allowed[p] = true
				}
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

// RequireManagement gates a route to the executive/management tier only
// (mirrors the frontend '/' General-Overview gate). No page fallback.
func RequireManagement(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := UserFromCtx(r.Context())
		if user == nil {
			authErr(w, 401, "Unauthorized")
			return
		}
		if IsManagement(user.Role) {
			next.ServeHTTP(w, r)
			return
		}
		authErr(w, 403, "This dashboard is restricted to management.")
	})
}

// RequireManagementOrPage allows the management tier OR any user holding the
// given page permission — mirroring the frontend RequireAccess (MGMT bypass or
// page grant). Used for executive drill-downs that a department head may hold.
func RequireManagementOrPage(page string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user := UserFromCtx(r.Context())
			if user == nil {
				authErr(w, 401, "Unauthorized")
				return
			}
			if IsManagement(user.Role) || user.HasPage(page) {
				next.ServeHTTP(w, r)
				return
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

// RolePages is composed from labeled building blocks so grants stay consistent
// and drift-free. Two kinds of page-key: VIEW keys gate nav + read APIs; ACTION
// keys (los_assign, los_finance_approve, collections_assign/payment*,
// recovery_assign/write_off, call_center_stats, admin_api_keys) gate head-only
// write APIs. Every key here exists in the page catalog (catalog.go).
//
// Clean taxonomy: one Head + one Agent/Officer per operating module, a lean
// C-suite tier, a clean IT role (system only) and a clean BI role (analytics
// only). Legacy duplicates (head_*, management, bare module roles, cards_ops_*)
// were retired — migration 141 remaps any users still on them.
var RolePages = buildRolePages()

func buildRolePages() map[string][]string {
	union := func(sets ...[]string) []string {
		seen := map[string]bool{}
		out := []string{}
		for _, s := range sets {
			for _, p := range s {
				if !seen[p] {
					seen[p] = true
					out = append(out, p)
				}
			}
		}
		return out
	}
	util := []string{"overview", "customer360", "uploads"}

	// Per-module page sets: agent (day-to-day) + head extras (oversight/actions).
	salesAgent := []string{"sales", "loans", "los", "crm_pipeline", "crm_contacts", "crm_tasks", "crm_reports", "cohort", "mail"}
	salesHead := []string{"los_all", "los_assign", "campaigns", "contact_lists", "message_templates", "kpi_dashboard", "statements", "executive"}
	bdAgent := []string{"bd", "bd_employers", "bd_pipeline", "crm_contacts", "mail"}
	bdHead := []string{"campaigns", "contact_lists", "message_templates", "kpi_dashboard", "executive"}
	collAgent := []string{"collections", "eod", "crm_contacts"}
	// collHead includes "recovery" so collections leads can open the Recovery Approvals
	// hand-off screen (route /collections/recovery-approvals gates on the recovery page);
	// the Recovery *module* itself stays gated to recovery roles via the sidebar vis list.
	collHead := []string{"collections_assign", "collections_payment", "collections_payment_approve", "recovery", "loans", "credit_portfolio", "kpi_dashboard", "statements", "executive"}
	recAgent := []string{"recovery", "eod"}
	recHead := []string{"recovery_assign", "recovery_write_off", "loans", "credit_portfolio", "kpi_dashboard", "statements", "executive"}
	cardsAgent := []string{"cards", "card_trends", "los_booking", "blink_card", "eod"}
	cardsHead := []string{"los_assign", "mobile_app", "kpi_dashboard", "statements", "executive"}
	finAgent := []string{"income", "finance", "transactions", "fixed_deposit", "fx_rates", "eod", "settlement", "reconciliation", "core-banking", "credit_portfolio", "los_finance"}
	finHead := []string{"los_finance_approve", "payroll", "kpi_dashboard", "statements", "executive"}
	// Settlement & Reconciliation is its OWN Operations module (not a Finance
	// sub-team): the clearing/recon surface only, no P&L / payroll / FD desk. The
	// officer does the daily matching; the head runs the desk with the oversight pages.
	settleAgent := []string{"settlement", "reconciliation", "eod", "transactions", "credit_portfolio"}
	settleHead := []string{"kpi_dashboard", "statements", "executive"}
	ccAgent := []string{"call_center", "helpdesk", "helpdesk_canned", "helpdesk_kb", "transactions", "crm_contacts"}
	ccHead := []string{"call_center_stats", "helpdesk_stats", "campaigns", "contact_lists", "message_templates", "kpi_dashboard", "statements", "executive"}
	// Care (customer email) is a separate team from Call Center (phone) — its own
	// module + roles, so a call-center agent no longer sees Care and vice-versa. Care
	// still uses the shared helpdesk ticket engine (email-channel tickets), hence the
	// helpdesk/canned/kb keys; the "care" key + sidebar gate the module itself.
	careAgent := []string{"care", "helpdesk", "helpdesk_canned", "helpdesk_kb", "crm_contacts"}
	careHead := []string{"helpdesk_stats", "message_templates", "kpi_dashboard", "statements", "executive"}
	// "los" is the base page guard on every /api/los route. Without it a risk officer
	// could open App Review, see the queue, and then 403 on Advance AND Decline — the
	// two actions the page exists for. los_risk_review only authorises the specific
	// risk_review→risk_head_review transition; it does not get you through the door.
	riskAgent := []string{"credit_portfolio", "loans", "los", "los_risk_review", "risk_officer"}
	riskHead := []string{"los_risk_head", "los_assign", "risk_head", "risk_all", "active_loan_book", "kpi_dashboard", "statements", "executive"}
	compAgent := []string{"compliance_checklists", "audit_findings", "watch_list"}
	compHead := []string{"compliance_all", "cbn_reports", "sars", "audit_trail", "audit_export", "kpi_dashboard", "executive"}
	// ticketWorker is the minimum needed to RESOLVE a ticket someone hands you:
	// the queue itself, canned responses and the knowledge base. Deliberately does
	// NOT include "call_center" (the outbound dialler/queue) or the *_stats
	// oversight pages — an ops specialist works tickets, they don't run the floor.
	//
	// Granted to the operational roles outside the contact centre because a
	// settlement or card issue has to be able to reach the person who can actually
	// fix it. Before this, assigning such a ticket to Settlements or Finance
	// succeeded, sent them a notification, and then 403'd them on the link.
	ticketWorker := []string{"helpdesk", "helpdesk_canned", "helpdesk_kb"}

	itAdmin := []string{"admin_users", "admin_api_keys", "settings", "sync_status"}
	// The "reports" page is the Reports & BI module AND the export engine — every
	// file the workspace emits is produced there and nowhere else. O3's decision
	// (2026-08-17) is that data extraction is concentrated in BI: only the BI
	// roles and admin hold this page.
	//
	// The heads who used to hold it (sales, collections, recovery, finance,
	// compliance) and the C-suite keep "kpi_dashboard", "executive" and
	// "statements", so their dashboards and statements are unaffected — what they
	// lose is the ability to pull raw data files themselves.
	biAnalyst := []string{"reports", "kpi_dashboard", "cohort"}
	biHead := []string{"executive", "statements"}

	m := map[string][]string{
		// ── System & Analytics ──
		"it_admin":   union(util, itAdmin),
		"bi_analyst": union([]string{"overview"}, biAnalyst),
		"bi_head":    union([]string{"overview"}, biAnalyst, biHead),
		// ── Sales & BD ──
		"sales_officer": union(util, salesAgent),
		"sales_head":    union(util, salesAgent, salesHead),
		"bd_officer":    union(util, bdAgent),
		"bd_head":       union(util, bdAgent, bdHead),
		// ── Collections & Recovery ──
		"collections_agent": union(util, collAgent),
		"collections_head":  union(util, collAgent, collHead),
		"recovery_agent":    union(util, recAgent),
		"recovery_head":     union(util, recAgent, recHead),
		// ── Cards ──
		// Card disputes and chargebacks arrive as tickets, so the cards team needs
		// to be able to work them rather than only read the card book.
		"cards_agent": union(util, cardsAgent, ticketWorker),
		"cards_head":  union(util, cardsAgent, cardsHead, ticketWorker),
		// ── Finance ──
		"finance_officer": union(util, finAgent, ticketWorker),
		"finance_head":    union(util, finAgent, finHead, ticketWorker),
		// ── Settlement & Reconciliation (own Operations module) ──
		"settlement_officer": union(util, ticketWorker, settleAgent),
		"settlement_head":    union(util, ticketWorker, settleAgent, settleHead),
		// ── Contact Centre ──
		"call_center_agent": union(util, ccAgent),
		"call_center_head":  union(util, ccAgent, ccHead),
		"care_agent":        union(util, careAgent),
		"care_head":         union(util, careAgent, careHead),
		// ── Risk ──
		"risk_officer": union(util, riskAgent),
		"risk_head":    union(util, riskAgent, riskHead),
		// ── Compliance ──
		"compliance_officer": union(util, compAgent),
		"compliance_head":    union(util, compAgent, compHead),
	}

	// ── Executive / C-suite ──
	m["admin"] = AllCatalogPages() // super-user (also bypasses gating)
	m["md"] = AllCatalogPages()
	m["coo"] = union(util, collAgent, collHead, recAgent, recHead, cardsAgent, cardsHead,
		finAgent, finHead, ccAgent, ccHead, riskAgent, riskHead,
		[]string{"kpi_dashboard", "statements", "executive", "approvals", "active_loan_book", "payroll"})
	m["cfo"] = union(util, finAgent, finHead,
		[]string{"collections_payment", "collections_payment_approve", "kpi_dashboard", "statements", "executive", "approvals"})
	m["cmo"] = union(util, salesAgent, bdAgent,
		[]string{"campaigns", "contact_lists", "message_templates", "kpi_dashboard", "executive"})

	return m
}
