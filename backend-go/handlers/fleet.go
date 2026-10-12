package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
FLEET — company vehicles: what they cost, how far they went, what was done to them.

THE SPEND IS ALREADY CAPTURED. The fuel cards are O3-issued, so every purchase is
already a row in app.ccs_transactions — dated, priced and merchant-verified. This
module adds no spend capture, no claim form and no receipt workflow. It adds the
REGISTER (what vehicles exist, which card belongs to which) and the two things the
card feed cannot know: distance travelled, and work done.

SCOPE IS DEFINED BY CARD, NEVER BY MERCHANT. Classifying fuel from merchant_name
does not work in this market — the string is frequently the payment processor, not
the filling station. The largest merchants on O3's own fuel cards are OPAY DIGITAL
SERVICES, PAYCOM NIGERIA, PALMPAY and ZEST PAYMENTS, any of which is what a petrol
station's POS terminal reports. So a mapped card's whole debit stream is that
vehicle's spend, and the merchant mix is REPORTED so anyone can see whether a card
is being used for what its name claims. That last part is a control the business
does not currently have: on the live cards, spend at anything identifiable as a
filling station runs between 0.3% and 24%.

COVERAGE CAVEAT, surfaced not buried. ccs_transactions stops at 2025-12-31, so
fleet spend from January 2026 is invisible for exactly the same reason the
settlement reconciliation has feed gaps. Every money figure here carries the window
it was computed over so a small number is never mistaken for a cheap vehicle.
*/

func RegisterFleet(r chi.Router, db *core.DB) {
	read := core.RequirePages("fleet")
	// Maintaining the register is the narrower grant: re-pointing a fuel card at a
	// different vehicle silently restates that vehicle's entire cost history.
	write := core.RequirePages("fleet_admin")

	r.With(read).Get("/overview", fleetOverview(db))
	r.With(read).Get("/vehicles", fleetVehicleList(db))
	r.With(read).Get("/vehicles/{id}", fleetVehicleDetail(db))
	r.With(write).Post("/vehicles", fleetVehicleCreate(db))
	r.With(write).Put("/vehicles/{id}", fleetVehicleUpdate(db))

	// The setup accelerator: the fleet-looking cards that exist in the card book,
	// with whether each is already mapped. Without it, populating the register means
	// knowing 22 CIFs by heart.
	r.With(read).Get("/cards/available", fleetCardsAvailable(db))
	r.With(write).Post("/vehicles/{id}/cards", fleetCardAttach(db))
	r.With(write).Post("/cards/{cardID}/close", fleetCardClose(db))

	r.With(read).Get("/vehicles/{id}/odometer", fleetOdometerList(db))
	r.With(write).Post("/vehicles/{id}/odometer", fleetOdometerAdd(db))

	r.With(read).Get("/maintenance", fleetMaintenanceList(db))
	r.With(write).Post("/maintenance", fleetMaintenanceAdd(db))

	r.With(read).Get("/incidents", fleetIncidentList(db))
	r.With(write).Post("/incidents", fleetIncidentAdd(db))
}

// fleetJSON writes a bare JSON object with an explicit status.
//
// Not respond(), which nests the whole payload under a "data" key — these pages read
// top-level sections (vehicles, spend, by_vehicle, due) and double-wrapping them
// would make every field path in the frontend a lie. Status is a parameter rather
// than a separate WriteHeader call because a header set after WriteHeader is
// silently dropped, which is how a 201 ends up with no Content-Type.
func fleetJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	if status != 0 && status != http.StatusOK {
		w.WriteHeader(status)
	}
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// fleetPeriod resolves the window every money figure is computed over. An absent or
// partial range means "everything", and the caller reports the window alongside the
// figures so a thin number is read as a short window rather than a cheap vehicle.
func fleetPeriod(r *http.Request) (string, string) {
	from, _ := validDate(r, "date_from")
	to, _ := validDate(r, "date_to")
	if from == "" || to == "" {
		return "", ""
	}
	return from, to
}

/* ── Overview ───────────────────────────────────────────────────────────────── */

func fleetOverview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		from, to := fleetPeriod(r)
		out := map[string]any{}

		// Window clause shared by every money figure below.
		where := "1=1"
		var args []any
		if from != "" && to != "" {
			where = "s.txn_date BETWEEN $1::date AND $2::date"
			args = append(args, from, to)
		}

		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*)                                        AS vehicles,
			       COUNT(*) FILTER (WHERE status = 'active')       AS active,
			       COUNT(*) FILTER (WHERE status = 'workshop')     AS in_workshop,
			       COUNT(*) FILTER (WHERE status = 'disposed')     AS disposed,
			       COALESCE(SUM(acquisition_cost_kobo),0)          AS fleet_cost_kobo
			FROM app.fleet_vehicles`); len(rows) > 0 {
			out["vehicles"] = rows[0]
		}

		// Card coverage. A vehicle with no card has no spend, and that is a register
		// gap rather than a cheap vehicle — the distinction the page has to make.
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) FILTER (WHERE c.vehicle_id IS NOT NULL) AS with_card,
			       COUNT(*) FILTER (WHERE c.vehicle_id IS NULL)     AS without_card
			FROM app.fleet_vehicles v
			LEFT JOIN (SELECT DISTINCT vehicle_id FROM app.fleet_cards WHERE valid_to IS NULL) c
			       ON c.vehicle_id = v.id
			WHERE v.status <> 'disposed'`); len(rows) > 0 {
			out["card_coverage"] = rows[0]
		}

		if rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COUNT(*) AS txns,
			       COALESCE(SUM(s.amount_kobo),0) AS spend_kobo,
			       COUNT(DISTINCT s.vehicle_id)   AS vehicles_spending,
			       MIN(s.txn_date)                AS first_txn,
			       MAX(s.txn_date)                AS last_txn
			FROM app.fleet_spend s WHERE %s`, where), args...); len(rows) > 0 {
			out["spend"] = rows[0]
		}

		// Spend by vehicle, with distance and cost per km where it can be measured.
		byVehicle, _ := db.PGQuery(ctx, fmt.Sprintf(`
			WITH sp AS (
			  SELECT s.vehicle_id, SUM(s.amount_kobo) AS spend_kobo, COUNT(*) AS txns
			  FROM app.fleet_spend s WHERE %s GROUP BY 1
			), dist AS (
			  SELECT d.vehicle_id,
			         MAX(d.reading_km) - MIN(d.reading_km) AS km,
			         COUNT(*)                              AS readings
			  FROM app.fleet_distance d
			  %s
			  GROUP BY 1
			)
			SELECT v.id AS vehicle_id, v.reg_no, v.make, v.model, v.status,
			       COALESCE(sp.spend_kobo,0) AS spend_kobo,
			       COALESCE(sp.txns,0)       AS txns,
			       COALESCE(dist.km,0)       AS km,
			       COALESCE(dist.readings,0) AS readings,
			       -- Only stated when distance was actually measured. A vehicle with
			       -- one reading or none has no span to divide by, and inventing one
			       -- would make the cheapest-looking car the one nobody logs.
			       CASE WHEN COALESCE(dist.km,0) > 0
			            THEN ROUND(COALESCE(sp.spend_kobo,0)::numeric / dist.km)
			       END AS kobo_per_km
			FROM app.fleet_vehicles v
			LEFT JOIN sp   ON sp.vehicle_id = v.id
			LEFT JOIN dist ON dist.vehicle_id = v.id
			WHERE v.status <> 'disposed'
			ORDER BY COALESCE(sp.spend_kobo,0) DESC`,
			where,
			map[bool]string{true: "WHERE d.read_on BETWEEN $1::date AND $2::date", false: ""}[from != "" && to != ""],
		), args...)
		if byVehicle == nil {
			byVehicle = []core.Row{}
		}
		out["by_vehicle"] = byVehicle

		// THE CONTROL PANEL. Where fleet-card money actually goes, by transaction
		// code. A fuel card showing web transfers out is not a fuel purchase under any
		// reading, and nothing in the business currently surfaces that.
		mix, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COALESCE(NULLIF(s.txn_code,''),'unknown') AS txn_code,
			       COALESCE(cc.description, 'Unmapped code')  AS code_label,
			       COUNT(*)                                   AS txns,
			       COALESCE(SUM(s.amount_kobo),0)             AS spend_kobo
			FROM app.fleet_spend s
			LEFT JOIN app.card_txn_codes cc ON cc.code = s.txn_code
			WHERE %s
			GROUP BY 1,2 ORDER BY spend_kobo DESC`, where), args...)
		if mix == nil {
			mix = []core.Row{}
		}
		out["spend_by_code"] = mix

		topMerchants, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COALESCE(NULLIF(btrim(s.merchant_name),''),'(blank)') AS merchant,
			       COUNT(*) AS txns, COALESCE(SUM(s.amount_kobo),0) AS spend_kobo
			FROM app.fleet_spend s WHERE %s
			GROUP BY 1 ORDER BY spend_kobo DESC LIMIT 15`, where), args...)
		if topMerchants == nil {
			topMerchants = []core.Row{}
		}
		out["top_merchants"] = topMerchants

		// Maintenance and incidents are captured here, so they are simply summed.
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS jobs, COALESCE(SUM(cost_kobo),0) AS cost_kobo
			FROM app.fleet_maintenance`); len(rows) > 0 {
			out["maintenance"] = rows[0]
		}
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS incidents,
			       COUNT(*) FILTER (WHERE resolved_on IS NULL) AS open_incidents,
			       COALESCE(SUM(cost_kobo),0) AS cost_kobo
			FROM app.fleet_incidents`); len(rows) > 0 {
			out["incidents"] = rows[0]
		}

		// Work falling due, by date or by distance. Both, because a vehicle sitting
		// idle comes due by date and one in heavy use by kilometres.
		due, _ := db.PGQuery(ctx, `
			WITH latest AS (
			  SELECT vehicle_id, MAX(reading_km) AS current_km FROM app.fleet_odometer GROUP BY 1
			)
			SELECT m.id, m.vehicle_id, v.reg_no, m.kind, m.next_due_on, m.next_due_km,
			       l.current_km,
			       CASE WHEN m.next_due_on IS NOT NULL THEN m.next_due_on - CURRENT_DATE END AS days_to_due,
			       CASE WHEN m.next_due_km IS NOT NULL AND l.current_km IS NOT NULL
			            THEN m.next_due_km - l.current_km END AS km_to_due
			FROM app.fleet_maintenance m
			JOIN app.fleet_vehicles v ON v.id = m.vehicle_id
			LEFT JOIN latest l ON l.vehicle_id = m.vehicle_id
			WHERE v.status <> 'disposed'
			  AND (m.next_due_on IS NOT NULL OR m.next_due_km IS NOT NULL)
			  AND (m.next_due_on IS NULL OR m.next_due_on <= CURRENT_DATE + 60)
			ORDER BY m.next_due_on NULLS LAST LIMIT 40`)
		if due == nil {
			due = []core.Row{}
		}
		out["due"] = due

		// How far the card feed reaches, so a thin month is read as a feed gap rather
		// than as thrift. Same root cause as the settlement feed gaps.
		if rows, _ := db.PGQuery(ctx, `
			SELECT MAX(txn_date) AS card_feed_last_day FROM app.ccs_transactions`); len(rows) > 0 {
			out["feed"] = rows[0]
		}

		out["period"] = map[string]string{"from": from, "to": to}
		fleetJSON(w, 200, out)
	}
}

/* ── Vehicles ───────────────────────────────────────────────────────────────── */

func fleetVehicleList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		where := "1=1"
		var args []any
		if status != "" {
			where += " AND v.status = $1"
			args = append(args, status)
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT v.id, v.reg_no, v.make, v.model, v.model_year, v.colour, v.status,
			       v.acquired_on, v.acquisition_cost_kobo,
			       v.department_id, d.name AS department,
			       v.assigned_to, COALESCE(u.full_name, v.assigned_driver_name, '') AS driver,
			       (SELECT COUNT(*) FROM app.fleet_cards c
			         WHERE c.vehicle_id = v.id AND c.valid_to IS NULL) AS live_cards,
			       (SELECT MAX(reading_km) FROM app.fleet_odometer o WHERE o.vehicle_id = v.id) AS current_km,
			       (SELECT MAX(read_on) FROM app.fleet_odometer o WHERE o.vehicle_id = v.id) AS last_reading_on
			FROM app.fleet_vehicles v
			LEFT JOIN app.departments d ON d.id = v.department_id
			LEFT JOIN app.o3c_users u ON u.id = v.assigned_to
			WHERE %s
			ORDER BY v.status, upper(v.reg_no)`, where), args...)
		if err != nil {
			respondErrLog(w, 500, "Could not load the vehicle register", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		fleetJSON(w, 200, map[string]any{"data": rows})
	}
}

func fleetVehicleDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ctx := r.Context()

		veh, err := db.PGQuery(ctx, `
			SELECT v.*, d.name AS department,
			       COALESCE(u.full_name, v.assigned_driver_name, '') AS driver
			FROM app.fleet_vehicles v
			LEFT JOIN app.departments d ON d.id = v.department_id
			LEFT JOIN app.o3c_users u ON u.id = v.assigned_to
			WHERE v.id = $1`, id)
		if err != nil || len(veh) == 0 {
			respondErr(w, 404, "Vehicle not found")
			return
		}

		cards, _ := db.PGQuery(ctx, `
			SELECT c.id, c.cif, c.card_label, c.valid_from, c.valid_to,
			       (SELECT COUNT(*) FROM app.ccs_transactions t
			         WHERE t.cif = c.cif AND t.sign = 'DR'
			           AND t.txn_date >= c.valid_from
			           AND (c.valid_to IS NULL OR t.txn_date <= c.valid_to)) AS txns
			FROM app.fleet_cards c WHERE c.vehicle_id = $1
			ORDER BY c.valid_to NULLS FIRST, c.valid_from DESC`, id)
		if cards == nil {
			cards = []core.Row{}
		}

		spend, _ := db.PGQuery(ctx, `
			SELECT txn_date, amount_kobo, txn_code, merchant_name, description, card_label
			FROM app.fleet_spend WHERE vehicle_id = $1
			ORDER BY txn_date DESC LIMIT 300`, id)
		if spend == nil {
			spend = []core.Row{}
		}

		monthly, _ := db.PGQuery(ctx, `
			SELECT to_char(date_trunc('month', txn_date), 'YYYY-MM') AS month,
			       COUNT(*) AS txns, COALESCE(SUM(amount_kobo),0) AS spend_kobo
			FROM app.fleet_spend WHERE vehicle_id = $1
			GROUP BY 1 ORDER BY 1`, id)
		if monthly == nil {
			monthly = []core.Row{}
		}

		odo, _ := db.PGQuery(ctx, `
			SELECT id, read_on, reading_km, km_since, days_since, litres,
			       filled_to_full, litres_per_100km, source
			FROM app.fleet_distance WHERE vehicle_id = $1
			ORDER BY read_on DESC, reading_km DESC LIMIT 100`, id)
		if odo == nil {
			odo = []core.Row{}
		}

		maint, _ := db.PGQuery(ctx, `
			SELECT id, kind, performed_on, vendor, cost_kobo, odometer_km,
			       next_due_on, next_due_km, description, invoice_ref
			FROM app.fleet_maintenance WHERE vehicle_id = $1
			ORDER BY performed_on DESC`, id)
		if maint == nil {
			maint = []core.Row{}
		}

		inc, _ := db.PGQuery(ctx, `
			SELECT i.id, i.occurred_on, i.kind, i.description, i.cost_kobo, i.resolved_on,
			       COALESCE(u.full_name,'') AS reported_by_name
			FROM app.fleet_incidents i
			LEFT JOIN app.o3c_users u ON u.id = i.reported_by
			WHERE i.vehicle_id = $1 ORDER BY i.occurred_on DESC`, id)
		if inc == nil {
			inc = []core.Row{}
		}

		fleetJSON(w, 200, map[string]any{
			"vehicle":     veh[0],
			"cards":       cards,
			"spend":       spend,
			"monthly":     monthly,
			"odometer":    odo,
			"maintenance": maint,
			"incidents":   inc,
		})
	}
}

func fleetVehicleCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			RegNo               string  `json:"reg_no"`
			Make                string  `json:"make"`
			Model               string  `json:"model"`
			ModelYear           *int    `json:"model_year"`
			VIN                 string  `json:"vin"`
			Colour              string  `json:"colour"`
			AcquiredOn          *string `json:"acquired_on"`
			AcquisitionCostKobo int64   `json:"acquisition_cost_kobo"`
			Status              string  `json:"status"`
			DepartmentID        *int    `json:"department_id"`
			AssignedTo          *int64  `json:"assigned_to"`
			AssignedDriverName  string  `json:"assigned_driver_name"`
			Notes               string  `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.RegNo) == "" {
			respondErr(w, 422, "A registration number is required — it is how the vehicle is identified everywhere else")
			return
		}
		if b.Status == "" {
			b.Status = "active"
		}
		var by *int64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			by = &u.ID
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.fleet_vehicles
			  (reg_no, make, model, model_year, vin, colour, acquired_on,
			   acquisition_cost_kobo, status, department_id, assigned_to,
			   assigned_driver_name, notes, created_by)
			VALUES (btrim($1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
			RETURNING id, reg_no`,
			b.RegNo, b.Make, b.Model, b.ModelYear, b.VIN, b.Colour, b.AcquiredOn,
			b.AcquisitionCostKobo, b.Status, b.DepartmentID, b.AssignedTo,
			b.AssignedDriverName, b.Notes, by)
		if err != nil {
			if strings.Contains(err.Error(), "uq_fleet_vehicles_reg_active") {
				respondErr(w, 409, "A vehicle with that registration number is already on the register")
				return
			}
			respondErrLog(w, 500, "Could not add the vehicle", err)
			return
		}
		fleetJSON(w, 201, rows[0])
	}
}

func fleetVehicleUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			Make                *string `json:"make"`
			Model               *string `json:"model"`
			ModelYear           *int    `json:"model_year"`
			Colour              *string `json:"colour"`
			Status              *string `json:"status"`
			DepartmentID        *int    `json:"department_id"`
			AssignedTo          *int64  `json:"assigned_to"`
			AssignedDriverName  *string `json:"assigned_driver_name"`
			Notes               *string `json:"notes"`
			DisposedOn          *string `json:"disposed_on"`
			DisposalProceedsKobo *int64 `json:"disposal_proceeds_kobo"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// COALESCE on every field so a partial update leaves the rest alone, rather
		// than blanking whatever the form did not send.
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.fleet_vehicles SET
			  make = COALESCE($2, make),
			  model = COALESCE($3, model),
			  model_year = COALESCE($4, model_year),
			  colour = COALESCE($5, colour),
			  status = COALESCE($6, status),
			  department_id = COALESCE($7, department_id),
			  assigned_to = COALESCE($8, assigned_to),
			  assigned_driver_name = COALESCE($9, assigned_driver_name),
			  notes = COALESCE($10, notes),
			  disposed_on = COALESCE($11::date, disposed_on),
			  disposal_proceeds_kobo = COALESCE($12, disposal_proceeds_kobo),
			  updated_at = now()
			WHERE id = $1 RETURNING id`,
			id, b.Make, b.Model, b.ModelYear, b.Colour, b.Status, b.DepartmentID,
			b.AssignedTo, b.AssignedDriverName, b.Notes, b.DisposedOn, b.DisposalProceedsKobo)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Vehicle not found")
			return
		}
		fleetJSON(w, 200, map[string]string{"status": "updated"})
	}
}

/* ── Cards ──────────────────────────────────────────────────────────────────── */

// fleetCardsAvailable lists the cards in the card book that look like fleet cards,
// with whether each is already mapped.
//
// This exists so populating the register does not require knowing 22 CIFs by
// heart. The match is on name_on_card, which is how these cards are actually
// distinguishable: O3C FUEL CARD 2..11, ABUJA FUEL CARD 1..2, O3 CARD FUEL 5,
// CAR MAINTENANCE 1, ZONE PETROLEUM. Deliberately a SUGGESTION and not a filter —
// any CIF can be mapped by hand, because a name is a convention and conventions
// get broken.
func fleetCardsAvailable(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT cb.cif,
			       MAX(cb.name_on_card)  AS name_on_card,
			       MAX(cb.product_name)  AS product_name,
			       MIN(cb.opened_date)   AS opened_date,
			       (SELECT COUNT(*) FROM app.ccs_transactions t
			         WHERE t.cif = cb.cif AND t.sign = 'DR')            AS lifetime_txns,
			       (SELECT COALESCE(SUM(t.amount_kobo),0) FROM app.ccs_transactions t
			         WHERE t.cif = cb.cif AND t.sign = 'DR')            AS lifetime_spend_kobo,
			       (SELECT MAX(t.txn_date) FROM app.ccs_transactions t
			         WHERE t.cif = cb.cif AND t.sign = 'DR')            AS last_txn,
			       fc.vehicle_id,
			       v.reg_no AS mapped_to
			FROM app.card_book cb
			LEFT JOIN app.fleet_cards fc ON fc.cif = cb.cif AND fc.valid_to IS NULL
			LEFT JOIN app.fleet_vehicles v ON v.id = fc.vehicle_id
			WHERE cb.name_on_card ~* 'fuel|petrol|diesel|car maintenance|zone petroleum'
			GROUP BY cb.cif, fc.vehicle_id, v.reg_no
			ORDER BY lifetime_spend_kobo DESC`)
		if err != nil {
			respondErrLog(w, 500, "Could not load candidate cards", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		fleetJSON(w, 200, map[string]any{"data": rows})
	}
}

func fleetCardAttach(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		vehicleID := chi.URLParam(r, "id")
		var b struct {
			CIF       string  `json:"cif"`
			CardLabel string  `json:"card_label"`
			ValidFrom *string `json:"valid_from"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.CIF) == "" {
			respondErr(w, 422, "A card CIF is required")
			return
		}
		var by *int64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			by = &u.ID
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.fleet_cards (vehicle_id, cif, card_label, valid_from, created_by)
			VALUES ($1, btrim($2), NULLIF(btrim($3),''), COALESCE($4::date, CURRENT_DATE), $5)
			RETURNING id`, vehicleID, b.CIF, b.CardLabel, b.ValidFrom, by)
		if err != nil {
			if strings.Contains(err.Error(), "uq_fleet_cards_cif_open") {
				respondErr(w, 409,
					"That card is already mapped to a vehicle. Close the existing mapping first, "+
						"so the earlier vehicle keeps the spend it actually incurred.")
				return
			}
			respondErrLog(w, 500, "Could not attach the card", err)
			return
		}
		fleetJSON(w, 201, rows[0])
	}
}

// fleetCardClose ends a mapping's validity window rather than deleting the row.
//
// Deleting would silently remove every past transaction from the vehicle that
// actually incurred them. Closing the window keeps the history attributed where it
// belongs and frees the card for reassignment.
func fleetCardClose(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cardID := chi.URLParam(r, "cardID")
		var b struct {
			ValidTo *string `json:"valid_to"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.fleet_cards
			SET valid_to = COALESCE($2::date, CURRENT_DATE)
			WHERE id = $1 AND valid_to IS NULL
			RETURNING id, valid_to`, cardID, b.ValidTo)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Card mapping not found, or already closed")
			return
		}
		fleetJSON(w, 200, rows[0])
	}
}

/* ── Odometer ───────────────────────────────────────────────────────────────── */

func fleetOdometerList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT id, read_on, reading_km, km_since, days_since, litres,
			       filled_to_full, litres_per_100km, source
			FROM app.fleet_distance WHERE vehicle_id = $1
			ORDER BY read_on DESC, reading_km DESC LIMIT 200`, chi.URLParam(r, "id"))
		if rows == nil {
			rows = []core.Row{}
		}
		fleetJSON(w, 200, map[string]any{"data": rows})
	}
}

func fleetOdometerAdd(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		vehicleID := chi.URLParam(r, "id")
		var b struct {
			ReadingKM    int64    `json:"reading_km"`
			ReadOn       string   `json:"read_on"`
			Litres       *float64 `json:"litres"`
			FilledToFull *bool    `json:"filled_to_full"`
			Source       string   `json:"source"`
			CCSTxnID     *int64   `json:"ccs_txn_id"`
			Note         string   `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ReadingKM <= 0 || b.ReadOn == "" {
			respondErr(w, 422, "A reading in kilometres and the date it was taken are both required")
			return
		}
		if b.Source == "" {
			b.Source = "refuel"
		}
		full := true
		if b.FilledToFull != nil {
			full = *b.FilledToFull
		}

		// An odometer only counts up. A reading below the last one is a typo, a
		// replaced instrument cluster, or the wrong vehicle — all of which need a
		// human, and none of which should silently produce negative distance and a
		// nonsensical cost per km.
		if prev, _ := db.PGQuery(r.Context(), `
			SELECT MAX(reading_km) AS last_km FROM app.fleet_odometer
			WHERE vehicle_id = $1 AND read_on <= $2::date`, vehicleID, b.ReadOn); len(prev) > 0 {
			if last := toInt64(prev[0]["last_km"]); last > 0 && b.ReadingKM < last {
				respondErr(w, 422, fmt.Sprintf(
					"That reading (%d km) is below the last one recorded on or before this date (%d km). "+
						"An odometer only counts up — check the figure, or record it as a 'manual' "+
						"correction with a note if the cluster was replaced.", b.ReadingKM, last))
				return
			}
		}

		var by *int64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			by = &u.ID
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.fleet_odometer
			  (vehicle_id, reading_km, read_on, litres, filled_to_full, source, ccs_txn_id, note, created_by)
			VALUES ($1,$2,$3::date,$4,$5,$6,$7,NULLIF(btrim($8),''),$9)
			RETURNING id`,
			vehicleID, b.ReadingKM, b.ReadOn, b.Litres, full, b.Source, b.CCSTxnID, b.Note, by)
		if err != nil {
			respondErrLog(w, 500, "Could not record the reading", err)
			return
		}
		fleetJSON(w, 201, rows[0])
	}
}

/* ── Maintenance ────────────────────────────────────────────────────────────── */

func fleetMaintenanceList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "1=1"
		var args []any
		if v := qstr(r, "vehicle_id"); v != "" {
			where += " AND m.vehicle_id = $1"
			args = append(args, v)
		}
		rows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT m.id, m.vehicle_id, v.reg_no, m.kind, m.performed_on, m.vendor,
			       m.cost_kobo, m.odometer_km, m.next_due_on, m.next_due_km,
			       m.description, m.invoice_ref
			FROM app.fleet_maintenance m
			JOIN app.fleet_vehicles v ON v.id = m.vehicle_id
			WHERE %s ORDER BY m.performed_on DESC LIMIT 500`, where), args...)
		if rows == nil {
			rows = []core.Row{}
		}
		fleetJSON(w, 200, map[string]any{"data": rows})
	}
}

func fleetMaintenanceAdd(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			VehicleID   int64   `json:"vehicle_id"`
			Kind        string  `json:"kind"`
			PerformedOn string  `json:"performed_on"`
			Vendor      string  `json:"vendor"`
			CostKobo    int64   `json:"cost_kobo"`
			OdometerKM  *int64  `json:"odometer_km"`
			NextDueOn   *string `json:"next_due_on"`
			NextDueKM   *int64  `json:"next_due_km"`
			Description string  `json:"description"`
			InvoiceRef  string  `json:"invoice_ref"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.VehicleID == 0 || b.Kind == "" || b.PerformedOn == "" {
			respondErr(w, 422, "vehicle, kind of work and the date it was done are all required")
			return
		}
		var by *int64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			by = &u.ID
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.fleet_maintenance
			  (vehicle_id, kind, performed_on, vendor, cost_kobo, odometer_km,
			   next_due_on, next_due_km, description, invoice_ref, created_by)
			VALUES ($1,$2,$3::date,NULLIF(btrim($4),''),$5,$6,$7::date,$8,
			        NULLIF(btrim($9),''),NULLIF(btrim($10),''),$11)
			RETURNING id`,
			b.VehicleID, b.Kind, b.PerformedOn, b.Vendor, b.CostKobo, b.OdometerKM,
			b.NextDueOn, b.NextDueKM, b.Description, b.InvoiceRef, by)
		if err != nil {
			if strings.Contains(err.Error(), "fleet_maintenance_kind_check") {
				respondErr(w, 422, "That kind of work is not one the register recognises")
				return
			}
			respondErrLog(w, 500, "Could not record the work", err)
			return
		}

		// A service records the odometer, and that reading is worth as much to the
		// distance series as a refuel reading. Captured once, used twice.
		if b.OdometerKM != nil && *b.OdometerKM > 0 {
			if _, err := db.PGExec(r.Context(), `
				INSERT INTO app.fleet_odometer (vehicle_id, reading_km, read_on, source, note, created_by)
				VALUES ($1,$2,$3::date,'service','Recorded with maintenance',$4)`,
				b.VehicleID, *b.OdometerKM, b.PerformedOn, by); err != nil {
				// Not fatal: the work order is the record that matters here.
				fleetJSON(w, 200, map[string]any{"id": rows[0]["id"], "odometer_recorded": false})
				return
			}
		}
		fleetJSON(w, 201, map[string]any{"id": rows[0]["id"], "odometer_recorded": b.OdometerKM != nil})
	}
}

/* ── Incidents ──────────────────────────────────────────────────────────────── */

func fleetIncidentList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT i.id, i.vehicle_id, v.reg_no, i.occurred_on, i.kind, i.description,
			       i.cost_kobo, i.resolved_on, COALESCE(u.full_name,'') AS reported_by_name
			FROM app.fleet_incidents i
			JOIN app.fleet_vehicles v ON v.id = i.vehicle_id
			LEFT JOIN app.o3c_users u ON u.id = i.reported_by
			ORDER BY i.occurred_on DESC LIMIT 300`)
		if rows == nil {
			rows = []core.Row{}
		}
		fleetJSON(w, 200, map[string]any{"data": rows})
	}
}

func fleetIncidentAdd(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			VehicleID   int64   `json:"vehicle_id"`
			OccurredOn  string  `json:"occurred_on"`
			Kind        string  `json:"kind"`
			Description string  `json:"description"`
			CostKobo    int64   `json:"cost_kobo"`
			ResolvedOn  *string `json:"resolved_on"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.VehicleID == 0 || b.OccurredOn == "" || b.Kind == "" {
			respondErr(w, 422, "vehicle, date and kind of incident are all required")
			return
		}
		var by *int64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			by = &u.ID
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.fleet_incidents
			  (vehicle_id, occurred_on, kind, description, cost_kobo, reported_by, resolved_on)
			VALUES ($1,$2::date,$3,NULLIF(btrim($4),''),$5,$6,$7::date)
			RETURNING id`,
			b.VehicleID, b.OccurredOn, b.Kind, b.Description, b.CostKobo, by, b.ResolvedOn)
		if err != nil {
			if strings.Contains(err.Error(), "fleet_incidents_kind_check") {
				respondErr(w, 422, "That kind of incident is not one the register recognises")
				return
			}
			respondErrLog(w, 500, "Could not record the incident", err)
			return
		}
		fleetJSON(w, 201, rows[0])
	}
}
