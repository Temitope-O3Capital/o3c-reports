package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterSettlement(r chi.Router, db *core.DB) {
	access := core.RequirePages("settlement")
	r.With(access).Get("/summary", stubHandler("settlement"))
}

func RegisterMobileApp(r chi.Router, db *core.DB) {
	access := core.RequirePages("mobile_app")
	r.With(access).Get("/summary", stubHandler("mobile_app"))
}

func RegisterBlinkCard(r chi.Router, db *core.DB) {
	access := core.RequirePages("blink_card")
	r.With(access).Get("/summary", stubHandler("blink_card"))
}

func stubHandler(module string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"module":      module,
			"status":      "coming_soon",
			"data_source": "pending",
		})
	}
}
