package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"
	"github.com/o3c/reports/core"
	"github.com/o3c/reports/handlers"
)

func main() {
	// Use structured JSON logging in production (Railway sets RAILWAY_ENVIRONMENT).
	// JSON is parseable by log aggregators; text is friendlier for local dev.
	var logHandler slog.Handler
	if os.Getenv("RAILWAY_ENVIRONMENT") != "" {
		logHandler = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	} else {
		logHandler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	}
	slog.SetDefault(slog.New(logHandler))

	cfg, err := core.LoadConfig()
	if err != nil {
		slog.Error("Config error", "err", err)
		os.Exit(1)
	}

	db, err := core.Open(cfg)
	if err != nil {
		slog.Error("Database connection failed", "err", err)
		os.Exit(1)
	}

	core.InitAuth(cfg.SecretKey)
	core.InitAuthDB(db)

	// Run any pending SQL migrations before serving traffic.
	if err := runMigrations(db); err != nil {
		slog.Error("Migration failed", "err", err)
		os.Exit(1)
	}

	// Shutdown context — cancelled on SIGTERM/SIGINT so the batch loop exits cleanly.
	shutdownCtx, shutdownCancel := context.WithCancel(context.Background())
	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
		<-quit
		shutdownCancel()
	}()
	handlers.RunBatchNightly(shutdownCtx, db)

	// Resume any campaigns that were mid-dispatch when the pod last restarted.
	handlers.ResumeInterruptedCampaigns(db)
	handlers.ResumeStatementRuns(db)

	// Auto-launch any campaigns whose scheduled_at has passed.
	go handlers.ScheduledCampaignTicker(db)
	go handlers.ScheduleCampaignAutoResume(db)

	// Push due-soon / overdue task notifications hourly.
	go handlers.ScheduleTaskNotifications(db)

	// Birthday worker — fires daily at 08:00.
	go handlers.ScheduleBirthdayWorker(db)

	// Activity log worker pool — 3 goroutines drain a 1000-entry buffered channel.
	activityCh := make(chan activityLogEntry, 1000)
	startActivityWorkers(db, activityCh, 3)

	r := chi.NewRouter()

	// ── Global middleware ──────────────────────────────────────────────────────
	r.Use(middleware.RealIP)
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware(cfg.AllowedOrigins))
	r.Use(securityHeaders)
	r.Use(bodySizeLimit(8 << 20)) // 8 MB cap on request bodies
	// P9-01: /api/v1/* is the versioned alias — rewrite to /api/* before routing.
	r.Use(apiVersionRewrite)
	// 5A: Prometheus request metrics
	r.Use(handlers.PrometheusMiddleware)
	// Use rightmost X-Forwarded-For IP as the rate-limit key (Railway appends the real IP last).
	r.Use(httprate.Limit(300, time.Minute, httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
		return rightmostIP(r), nil
	})))

	// ── Public endpoints ───────────────────────────────────────────────────────
	r.Get("/api/health", healthHandler(db))
	r.Get("/metrics", handlers.MetricsHandler().ServeHTTP) // Prometheus scrape endpoint

	// P9-07: OpenAPI developer reference (no auth — internal developer tool)
	r.Get("/api/docs", handlers.APIDocs())
	r.Get("/api/docs/spec", handlers.APISpec())

	// Mount auth routes (token is public, me/change-password require auth)
	r.Route("/api/auth", func(r chi.Router) {
		r.With(httprate.Limit(5, time.Minute, httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
			return rightmostIP(r), nil
		}))).Post("/token", loginPublic(db))
		r.Post("/bootstrap", handlers.BootstrapHandler(db))
		r.Post("/refresh", RefreshPublic(db))
		if cfg.EnableResetAdmin {
			r.Post("/reset-admin", handlers.ResetAdminHandler(db, cfg.ResetAdminSecret))
		}
		r.Group(func(r chi.Router) {
			r.Use(core.AuthMiddleware)
			r.Get("/me", mePublic())
			r.With(httprate.Limit(3, time.Minute, httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
				return rightmostIP(r), nil
			}))).Post("/change-password", changePasswordPublic(db))
			r.Post("/logout", logoutHandler())
			r.Route("/totp", func(r chi.Router) {
				handlers.RegisterMFA(r, db)
			})
		})
	})

	// TOTP MFA challenge (public — called after password step, before full auth token)
	r.With(httprate.Limit(10, time.Minute, httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
		return rightmostIP(r), nil
	}))).Post("/api/auth/totp/challenge", MFAChallengePublic(db))

	// Public campaign webhooks (Termii / SendGrid — no JWT)
	r.Route("/api/campaign-webhooks", func(r chi.Router) {
		handlers.RegisterCampaignWebhooks(r, db)
	})

	// Email open-pixel and click-redirect tracking (embedded in campaign emails — no JWT)
	r.Get("/t/o/{tracking_id}", handlers.TrackOpen(db))
	r.Get("/t/c/{tracking_id}", handlers.TrackClick(db))

	// Uploaded campaign images served as static files.
	r.Handle("/uploads/*", http.StripPrefix("/uploads/", http.FileServer(http.Dir(handlers.UploadRoot()))))

	// Helpdesk: public webhooks/CSAT on the same prefix as authenticated routes
	r.Route("/api/helpdesk", func(r chi.Router) {
		handlers.RegisterHelpdeskPublic(r, db)
		r.Group(func(r chi.Router) {
			r.Use(core.AuthMiddleware)
			r.Use(activityLogger(activityCh))
			handlers.RegisterHelpdesk(r, db)
		})
	})

	// WhatsApp inbound webhook (Meta Cloud API — no JWT)
	r.Route("/api/whatsapp", func(r chi.Router) {
		handlers.RegisterWhatsAppPublic(r, db)
	})

	// Zoho Voice routes (call initiation, voice log import)
	r.Route("/api/zoho", func(r chi.Router) {
		// Admin-secret protected import routes (no JWT needed)
		handlers.RegisterZohoAdmin(r, db, cfg.ResetAdminSecret)
		r.Group(func(r chi.Router) {
			r.Use(core.AuthMiddleware)
			r.Use(activityLogger(activityCh))
			handlers.RegisterZoho(r, db)
		})
	})

	// Predictive dialer — webhook is unauthenticated (Zoho Voice fires it)
	r.Get("/api/dialer/webhook", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	r.Post("/api/dialer/webhook", handlers.RegisterDialerWebhookOnly(db))
	r.Route("/api/dialer", func(r chi.Router) {
		r.Group(func(r chi.Router) {
			r.Use(core.AuthMiddleware)
			r.Use(activityLogger(activityCh))
			handlers.RegisterDialer(r, db)
		})
	})

	// Zoho Voice per-user OAuth
	r.Get("/api/voice/callback", handlers.VoiceOAuthCallback(db))
	r.Group(func(r chi.Router) {
		r.Use(core.AuthMiddleware)
		r.Get("/api/voice/status", handlers.VoiceStatus(db))
		r.Get("/api/voice/connect", handlers.VoiceConnect(db))
		r.Delete("/api/voice/disconnect", handlers.VoiceDisconnect(db))
	})
	r.Route("/api/mail", func(r chi.Router) {
		handlers.RegisterMailPublic(r, db)
		r.Group(func(r chi.Router) {
			r.Use(core.AuthMiddleware)
			r.Use(activityLogger(activityCh))
			handlers.RegisterMail(r, db)
		})
	})

	// SSE stream — no JWT header (EventSource can't set headers); uses short-lived ticket
	r.Route("/api/notifications", func(r chi.Router) {
		handlers.RegisterNotificationsSSE(r, db)
		r.Group(func(r chi.Router) {
			r.Use(core.AuthMiddleware)
			r.Use(activityLogger(activityCh))
			handlers.RegisterNotifications(r, db)
		})
	})

	// ── Protected routes (all require valid JWT) ───────────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(core.AuthMiddleware)
		r.Use(activityLogger(activityCh))

		r.Route("/api/overview", func(r chi.Router) {
			handlers.RegisterOverview(r, db)
		})
		r.Route("/api/transactions", func(r chi.Router) {
			handlers.RegisterTransactions(r, db)
		})
		r.Route("/api/collections", func(r chi.Router) {
			handlers.RegisterCollections(r, db)
		})
		r.Route("/api/recovery", func(r chi.Router) {
			handlers.RegisterRecovery(r, db)
		})
		r.Route("/api/sales", func(r chi.Router) {
			handlers.RegisterSales(r, db)
		})
		r.Route("/api/cards", func(r chi.Router) {
			handlers.RegisterCards(r, db)
		})
		r.Route("/api/card-trends", func(r chi.Router) {
			handlers.RegisterCardTrends(r, db)
		})
		r.Route("/api/loans", func(r chi.Router) {
			handlers.RegisterLoans(r, db)
		})
		r.Route("/api/admin", func(r chi.Router) {
			handlers.RegisterAdmin(r, db)
			handlers.RegisterNotificationSettings(r, db)
			handlers.RegisterEmailSenders(r, db)
		})
		r.Route("/api", func(r chi.Router) {
			handlers.RegisterRecipientSuggest(r, db)
		})
		r.Route("/api/user", func(r chi.Router) {
			handlers.RegisterNotificationPrefs(r, db)
		})
		r.Route("/api/crm", func(r chi.Router) {
			handlers.RegisterCRM(r, db)
		})
		r.Route("/api/cohort", func(r chi.Router) {
			handlers.RegisterCohort(r, db)
		})
		r.Route("/api/executive", func(r chi.Router) {
			handlers.RegisterExecutive(r, db)
		})
		r.Route("/api/call-center", func(r chi.Router) {
			handlers.RegisterCallCenter(r, db)
		})
		r.Route("/api/campaigns", func(r chi.Router) {
			handlers.RegisterCampaigns(r, db)
			// Analytics, per-campaign reports, image upload — same /api/campaigns prefix
			handlers.RegisterCampaignAnalytics(r, db)
		})
		r.Route("/api/contact-lists", func(r chi.Router) {
			handlers.RegisterContactLists(r, db)
		})
		r.Route("/api/message-templates", func(r chi.Router) {
			handlers.RegisterMessageTemplates(r, db)
		})
		r.Route("/api/reconciliation/paystack", func(r chi.Router) {
			handlers.RegisterPaystackRecon(r, db)
		})
		r.Route("/api/reconciliation/interswitch", func(r chi.Router) {
			handlers.RegisterInterspwitchRecon(r, db)
		})
		r.Route("/api/uploads", func(r chi.Router) {
			handlers.RegisterUploads(r, db)
		})
		r.Route("/api/income", func(r chi.Router) {
			handlers.RegisterIncome(r, db)
		})
		r.Route("/api/eod", func(r chi.Router) {
			handlers.RegisterEOD(r, db)
		})
		r.Route("/api/credit-portfolio", func(r chi.Router) {
			handlers.RegisterCreditPortfolio(r, db)
		})
		r.Route("/api/fixed-deposit", func(r chi.Router) {
			handlers.RegisterFixedDeposit(r, db)
		})
		r.Route("/api/finance", func(r chi.Router) {
			handlers.RegisterFinance(r, db)
		})
		r.Route("/api/settlement", func(r chi.Router) {
			handlers.RegisterSettlement(r, db)
		})
		r.Route("/api/settlements", func(r chi.Router) {
			handlers.RegisterSettlementOps(r, db)
		})
		r.Route("/api/mobile-app", func(r chi.Router) {
			handlers.RegisterMobileApp(r, db)
		})
		r.Route("/api/blink-card", func(r chi.Router) {
			handlers.RegisterBlinkCard(r, db)
		})
		// Activity log — any authenticated user (not just admins)
		handlers.RegisterActivityLog(r, db)

		// ── New platform modules ────────────────────────────────────────────────
		r.Route("/api/los", func(r chi.Router) {
			handlers.RegisterLOS(r, db)
		})
		r.Route("/api/customer360", func(r chi.Router) {
			handlers.RegisterCustomer360(r, db)
		})
		r.Route("/api/hr", func(r chi.Router) {
			handlers.RegisterHR(r, db)
		})
		r.Route("/api/compliance", func(r chi.Router) {
			handlers.RegisterCompliance(r, db)
		})
		r.Route("/api/settings", func(r chi.Router) {
			handlers.RegisterSettings(r, db)
		})
		r.Route("/api/kpi", func(r chi.Router) {
			handlers.RegisterKPI(r, db)
		})
		r.Route("/api/reports", func(r chi.Router) {
			handlers.RegisterReports(r, db)
		})
		r.Route("/api/statements", func(r chi.Router) {
			handlers.RegisterStatements(r, db)
		})
		r.Route("/api/batch", func(r chi.Router) {
			handlers.RegisterBatch(r, db)
		})
		r.Route("/api/collections-ops", func(r chi.Router) {
			handlers.RegisterCollectionsOps(r, db)
		})
		r.Route("/api/recovery-ops", func(r chi.Router) {
			handlers.RegisterRecoveryOps(r, db)
		})
		r.Route("/api/approvals", func(r chi.Router) {
			handlers.RegisterApprovals(r, db)
		})
		r.Route("/api/risk", func(r chi.Router) {
			handlers.RegisterRisk(r, db)
		})
		r.Route("/api/customer-service", func(r chi.Router) {
			handlers.RegisterCustomerService(r, db)
		})
		r.Route("/api/telemarketing", func(r chi.Router) {
			handlers.RegisterTelemarketing(r, db)
		})
		r.Route("/api/active-loans", func(r chi.Router) {
			handlers.RegisterActiveLoanBook(r, db)
		})
		r.Route("/api/bd", func(r chi.Router) {
			handlers.RegisterBusinessDev(r, db)
		})
		r.Route("/api/payroll", func(r chi.Router) {
			handlers.RegisterPayroll(r, db)
		})
		r.Get("/api/search", handlers.GlobalSearch(db))
		r.Route("/api/bi", func(r chi.Router) {
			handlers.RegisterBI(r, db)
		})

	})

	// ── Server ─────────────────────────────────────────────────────────────────
	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second, // allow time for large CSV exports
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	go func() {
		quit := make(chan os.Signal, 1)
		signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
		<-quit
		slog.Info("Shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		srv.Shutdown(ctx) //nolint:errcheck
	}()

	slog.Info("O3 Capital Workspace API starting", "port", cfg.Port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("Server error", "err", err)
		os.Exit(1)
	}
}

// ── Activity logger middleware ────────────────────────────────────────────────
// Logs every non-GET authenticated request to o3c_activity_log.
// Uses a bounded worker pool (buffered channel + 3 goroutines) instead of
// spawning a new goroutine per request, preventing goroutine accumulation
// under DB slowdowns.

type activityLogEntry struct {
	userID int64
	page, action, ip, resource, method string
}

// startActivityWorkers drains activityCh and writes each entry to the DB.
// Runs until the channel is closed (on graceful shutdown).
func startActivityWorkers(db *core.DB, ch <-chan activityLogEntry, n int) {
	for i := 0; i < n; i++ {
		go func() {
			for e := range ch {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				db.PGExec(ctx, //nolint:errcheck
					`INSERT INTO o3c_activity_log (user_id, page, action, detail, ip, resource, method)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					e.userID, e.page, e.action, "", e.ip, e.resource, e.method)
				cancel()
			}
		}()
	}
}

func activityLogger(ch chan<- activityLogEntry) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r)
			if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
				return
			}
			user := core.UserFromCtx(r.Context())
			if user == nil {
				return
			}
			ip := ""
			if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
				parts := strings.Split(fwd, ",")
				ip = strings.TrimSpace(parts[len(parts)-1])
			}
			if ip == "" {
				ip = r.RemoteAddr
			}
			path := r.URL.Path
			action := r.Method + " " + path
			page := ""
			for _, seg := range []string{
				"transactions", "collections", "recovery", "sales", "cards",
				"loans", "los", "admin", "crm", "hr", "compliance", "reports",
				"credit-portfolio", "fixed-deposit", "settlement", "uploads",
				"reconciliation", "kpi", "batch", "collections-ops", "recovery-ops",
				"approvals", "customer360", "customer-service", "risk",
			} {
				if strings.Contains(path, "/api/"+seg) {
					page = seg
					break
				}
			}
			select {
			case ch <- activityLogEntry{userID: user.ID, page: page, action: action, ip: ip, resource: path, method: r.Method}:
			default:
				// Channel full — drop log entry rather than blocking the request handler.
				slog.Warn("activity log channel full; dropping entry", "path", path)
			}
		})
	}
}

// ── CORS ──────────────────────────────────────────────────────────────────────

func corsMiddleware(allowed []string) func(http.Handler) http.Handler {
	set := make(map[string]bool, len(allowed))
	for _, o := range allowed {
		set[o] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if set[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-CSRF-Token")
				w.Header().Set("Vary", "Origin")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ── API versioning ─────────────────────────────────────────────────────────────
// P9-01: /api/v1/* is transparently rewritten to /api/* before route matching.
// Clients on v1 receive an API-Version response header for introspection.
func apiVersionRewrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/") {
			r.URL.Path = "/api/" + r.URL.Path[len("/api/v1/"):]
			if r.URL.RawPath != "" {
				r.URL.RawPath = "/api/" + r.URL.RawPath[len("/api/v1/"):]
			}
			w.Header().Set("API-Version", "v1")
		}
		next.ServeHTTP(w, r)
	})
}

// ── Security headers ──────────────────────────────────────────────────────────

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; "+
				"script-src 'self'; "+
				"connect-src 'self'; "+
				"img-src 'self' data:; "+
				"style-src 'self' 'unsafe-inline'; "+
				"font-src 'self' data:; "+
				"frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// bodySizeLimit caps request body at maxBytes to prevent memory exhaustion.
func bodySizeLimit(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// ── Health ─────────────────────────────────────────────────────────────────────

func healthHandler(_ *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"}) //nolint:errcheck
	}
}

// ── Inline auth handlers (avoid circular import with handlers package) ────────
// These delegate to the same logic as handlers/auth.go but are wired here
// so the public /token route doesn't accidentally get auth middleware applied.

func loginPublic(db *core.DB) http.HandlerFunc {
	// Re-use the registered handler directly — same function, just mounted without auth middleware.
	// We need a temporary router to extract the handler.
	sub := chi.NewRouter()
	handlers.RegisterAuth(sub, db)

	return func(w http.ResponseWriter, r *http.Request) {
		// Rewrite the path to match what RegisterAuth expects (/token → /token)
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/token"
		sub.ServeHTTP(w, r2)
	}
}

// RefreshPublic exposes the /refresh endpoint without auth middleware — the cookie is the credential.
func RefreshPublic(db *core.DB) http.HandlerFunc {
	sub := chi.NewRouter()
	handlers.RegisterAuth(sub, db)
	return func(w http.ResponseWriter, r *http.Request) {
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/refresh"
		sub.ServeHTTP(w, r2)
	}
}

// MFAChallengePublic exposes the TOTP challenge endpoint — it accepts an MFA token, not a full JWT.
func MFAChallengePublic(db *core.DB) http.HandlerFunc {
	sub := chi.NewRouter()
	handlers.RegisterMFA(sub, db)
	return func(w http.ResponseWriter, r *http.Request) {
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/challenge"
		sub.ServeHTTP(w, r2)
	}
}

func mePublic() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(user) //nolint:errcheck
	}
}

func changePasswordPublic(db *core.DB) http.HandlerFunc {
	sub := chi.NewRouter()
	handlers.RegisterAuth(sub, db)
	return func(w http.ResponseWriter, r *http.Request) {
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/change-password"
		sub.ServeHTTP(w, r2)
	}
}

func logoutHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		claims := core.UserFromCtx(ctx)
		if claims != nil && claims.JTI != "" && claims.ExpiresAt != nil {
			if err := core.RevokeToken(ctx, claims.JTI, claims.ID, claims.ExpiresAt.Time); err != nil {
				slog.Warn("logout: access token denylist insert failed", "err", err)
			}
		}
		// Revoke the refresh token so it cannot be replayed after logout.
		if cookie, err := r.Cookie("o3c_refresh"); err == nil {
			if rc, verr := core.VerifyRefreshToken(cookie.Value); verr == nil && rc.JTI != "" && rc.ExpiresAt != nil {
				if err := core.RevokeToken(ctx, rc.JTI, rc.ID, rc.ExpiresAt.Time); err != nil {
					slog.Warn("logout: refresh token denylist insert failed", "err", err)
				}
			}
		}
		handlers.ClearAuthCookies(w, r)
		w.WriteHeader(204)
	}
}

// rightmostIP extracts the real client IP — Railway appends it last in X-Forwarded-For.
func rightmostIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		parts := strings.Split(fwd, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return ""
}
