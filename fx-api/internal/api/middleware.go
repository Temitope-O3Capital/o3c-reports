package api

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/o3c/fx-api/internal/store"
)

func apiKeyAuth(db *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.Header.Get("X-API-Key")
			if key == "" {
				writeErr(w, http.StatusUnauthorized, "X-API-Key header required")
				return
			}
			ok, err := store.ValidAPIKey(r.Context(), db, key)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal error")
				return
			}
			if !ok {
				writeErr(w, http.StatusUnauthorized, "invalid or revoked API key")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg}) //nolint:errcheck
}
