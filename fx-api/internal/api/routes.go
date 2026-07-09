package api

import (
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"time"
)

func NewRouter(db *pgxpool.Pool, staleHours float64) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(30 * time.Second))

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`)) //nolint:errcheck
	})

	r.Route("/v1/fx", func(r chi.Router) {
		r.Use(apiKeyAuth(db))
		// 60 requests per minute per IP (API key holders are typically single servers)
		r.Use(httprate.LimitByIP(60, time.Minute))

		r.Get("/parallel-rates/latest", handleLatest(db, staleHours))
		r.Get("/parallel-rates/history", handleHistory(db))
	})

	return r
}
