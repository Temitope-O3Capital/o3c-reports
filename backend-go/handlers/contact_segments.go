package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// Saved contact segments — a reusable, refreshable audience definition over the
// loan book. A segment stores its filter criteria (segmentCriteria) as JSONB and
// can be materialised into a contact list on demand, keeping the list current
// without re-entering the filters. See migration 114_marketing_enhancements.sql.

type segmentSaveReq struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Criteria    segmentCriteria `json:"criteria"`
	// Keep itself current. Opt-in per segment: a refresh refills the linked list in
	// place, so a campaign already pointed at it would see its audience change.
	AutoRefresh          bool `json:"auto_refresh"`
	RefreshIntervalHours int  `json:"refresh_interval_hours"`
}

// refreshIntervalOrDefault clamps to what the CHECK constraint allows, so a bad number
// from a client is corrected rather than becoming a 500 from the database.
func refreshIntervalOrDefault(h int) int {
	switch {
	case h <= 0:
		return 24
	case h < 1:
		return 1
	case h > 720:
		return 720
	default:
		return h
	}
}

func listSegments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT s.id, s.name, s.description, s.criteria, s.last_count,
			       s.last_list_id, s.last_refreshed_at, s.created_at, s.updated_at,
			       s.auto_refresh, s.refresh_interval_hours, s.last_auto_refresh_at,
			       s.last_refresh_error,
			       u.full_name AS created_by_name,
			       cl.name AS list_name, cl.member_count AS list_member_count,
			       cl.consent_basis AS list_consent_basis
			FROM contact_segments s
			LEFT JOIN o3c_users u ON s.created_by = u.id
			LEFT JOIN contact_lists cl ON s.last_list_id = cl.id
			ORDER BY s.updated_at DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}

func getSegment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, name, description, criteria, last_count, last_list_id,
			        last_refreshed_at, created_at, updated_at
			 FROM contact_segments WHERE id=$1`, sid)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Segment not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func createSegment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b segmentSaveReq
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		if problem := segmentCriteriaProblem(b.Criteria); problem != "" {
			respondErr(w, 422, problem)
			return
		}
		user := core.UserFromCtx(r.Context())
		critJSON, _ := json.Marshal(b.Criteria)
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO contact_segments
			    (name, description, criteria, created_by, auto_refresh, refresh_interval_hours)
			VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING *`,
			b.Name, b.Description, string(critJSON), user.ID,
			b.AutoRefresh, refreshIntervalOrDefault(b.RefreshIntervalHours))
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateSegment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		var b segmentSaveReq
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		if problem := segmentCriteriaProblem(b.Criteria); problem != "" {
			respondErr(w, 422, problem)
			return
		}
		critJSON, _ := json.Marshal(b.Criteria)
		rows, err := db.PGQuery(r.Context(), `
			UPDATE contact_segments
			SET name=$1, description=$2, criteria=$3::jsonb,
			    auto_refresh=$4, refresh_interval_hours=$5,
			    -- Editing the criteria clears a stale failure: the next run decides again.
			    last_refresh_error=NULL, updated_at=NOW()
			WHERE id=$6 RETURNING *`,
			b.Name, b.Description, string(critJSON),
			b.AutoRefresh, refreshIntervalOrDefault(b.RefreshIntervalHours), sid)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Segment not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteSegment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		db.PGExec(r.Context(), "DELETE FROM contact_segments WHERE id=$1", sid) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// segmentCriteriaOf decodes the stored criteria, which arrives as a string or as bytes
// depending on the driver path.
func segmentCriteriaOf(seg core.Row) segmentCriteria {
	var c segmentCriteria
	switch raw := seg["criteria"].(type) {
	case string:
		json.Unmarshal([]byte(raw), &c) //nolint:errcheck
	case []byte:
		json.Unmarshal(raw, &c) //nolint:errcheck
	}
	c.Name = str(seg["name"])
	return c
}

// refreshSegment rebuilds one segment's contact list and records the outcome against the
// segment row. Shared by the manual endpoint and the auto-refresh worker on purpose: two
// copies of "what refreshing means" would drift, and the worker's copy is the one nobody
// would be watching when it did.
//
// The existing list is reused and refilled IN PLACE when it still exists, so a campaign
// already pointed at that list_id keeps working. That is also why auto-refresh is opt-in:
// refilling in place is exactly what makes a live campaign's audience change underneath it.
func refreshSegment(ctx context.Context, db *core.DB, segID int64, actorID int64) (segmentOutcome, int64, error) {
	var out segmentOutcome
	rows, err := db.PGQuery(ctx,
		`SELECT id, name, criteria, last_list_id FROM contact_segments WHERE id=$1`, segID)
	if err != nil {
		return out, 0, err
	}
	if len(rows) == 0 {
		return out, 0, errSegmentNotFound
	}
	seg := rows[0]
	c := segmentCriteriaOf(seg)
	// A segment saved before a rule tightened must not quietly build the wrong audience.
	if problem := segmentCriteriaProblem(c); problem != "" {
		return out, 0, errors.New(problem)
	}

	var listID int64
	if existing := toInt64(seg["last_list_id"]); existing > 0 {
		chk, _ := db.PGQuery(ctx, "SELECT id FROM contact_lists WHERE id=$1", existing)
		if len(chk) > 0 {
			listID = existing
			db.PGExec(ctx, "DELETE FROM contact_list_members WHERE list_id=$1", listID) //nolint:errcheck
		}
	}
	if listID == 0 {
		lr, err := db.PGQuery(ctx,
			`INSERT INTO contact_lists (name, description, created_by, created_at, updated_at)
			 VALUES ($1,$2,$3,NOW(),NOW()) RETURNING id`,
			str(seg["name"]), "Segment: "+str(seg["name"]), nullableInt64(actorID))
		if err != nil || len(lr) == 0 {
			return out, 0, fmt.Errorf("create list for segment %d: %w", segID, err)
		}
		listID = toInt64(lr[0]["id"])
	}

	out, err = materializeSegmentToList(ctx, db, listID, c)
	if err != nil {
		return out, listID, err
	}
	db.PGExec(ctx, `
		UPDATE contact_segments
		SET last_count=$1, last_list_id=$2, last_refreshed_at=NOW(),
		    last_refresh_error=NULL, updated_at=NOW()
		WHERE id=$3`, out.Imported, listID, segID) //nolint:errcheck
	return out, listID, nil
}

var errSegmentNotFound = errors.New("segment not found")

// materializeSegmentHandler builds (or refreshes) the segment's contact list on demand.
func materializeSegmentHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		segID := toInt64(chi.URLParam(r, "sid"))
		user := core.UserFromCtx(ctx)
		out, listID, err := refreshSegment(ctx, db, segID, user.ID)
		switch {
		case errors.Is(err, errSegmentNotFound):
			respondErr(w, 404, "Segment not found")
			return
		case err != nil:
			// The message is the officer's, not the log's: a refusal here is usually a
			// saved segment whose filters no longer make sense for its audience.
			respondErrLog(w, 422, err.Error(), err)
			return
		}
		respond(w, map[string]any{
			"segment_id":   segID,
			"list_id":      listID,
			"imported":     out.Imported,
			"no_contact":   out.NoContact,
			"mailable":     out.Mailable,
			"textable":     out.Textable,
			"known_people": out.KnownPeople,
			"collided":     out.Collided,
			"truncated":    out.Truncated,
		}, "pg")
	}
}

// contactDataQuality is the checker: which stored emails and phones cannot be used, and
// who they belong to.
//
// WHY. A reachability count is not actionable; a list of broken records is. On 2026-10-06,
// 6,673 active customers had a phone number in the field that cannot be dialled —
// 08012345678 alone against 4,073 of them — and 85 had an unusable email, "00" among them.
// None of that was visible anywhere, and every count elsewhere in the platform that said
// "has a phone" was counting those rows.
//
// Grouped by the offending VALUE, because that is the shape of the fix: one bad default in
// whatever form or import produced 4,073 identical numbers, not 4,073 separate mistakes.
func contactDataQuality(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		activeOnly := qstr(r, "scope") != "all"

		out := map[string]any{"scope": map[bool]string{true: "active", false: "all"}[activeOnly]}
		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*)                                             AS people,
			       COUNT(email)                                         AS emailable,
			       COUNT(phone)                                         AS dialable,
			       COUNT(*) FILTER (WHERE email_unusable)                AS email_unusable,
			       COUNT(*) FILTER (WHERE phone_unusable)                AS phone_unusable,
			       COUNT(*) FILTER (WHERE email_raw IS NULL)             AS email_missing,
			       COUNT(*) FILTER (WHERE phone_raw IS NULL)             AS phone_missing,
			       COUNT(*) FILTER (WHERE email IS NULL AND phone IS NULL) AS unreachable
			  FROM app.v_customer_contactability
			 WHERE (NOT $1::boolean OR open_products > 0)`, activeOnly); err == nil && len(rows) > 0 {
			out["totals"] = rows[0]
		} else if err != nil {
			respondErrLog(w, 500, "Could not read contact data quality", err)
			return
		}

		// The repeated offenders, which is where the fix actually is.
		if rows, _ := db.PGQuery(ctx, `
			SELECT phone_raw AS value, COUNT(*) AS people
			  FROM app.v_customer_contactability
			 WHERE phone_unusable AND (NOT $1::boolean OR open_products > 0)
			 GROUP BY phone_raw ORDER BY COUNT(*) DESC, phone_raw LIMIT 20`,
			activeOnly); rows != nil {
			out["phone_offenders"] = rows
		}
		if rows, _ := db.PGQuery(ctx, `
			SELECT email_raw AS value, COUNT(*) AS people
			  FROM app.v_customer_contactability
			 WHERE email_unusable AND (NOT $1::boolean OR open_products > 0)
			 GROUP BY email_raw ORDER BY COUNT(*) DESC, email_raw LIMIT 20`,
			activeOnly); rows != nil {
			out["email_offenders"] = rows
		}
		respond(w, out, "pg")
	}
}

// segmentConsentStatus answers "could this segment legally be marketed to, and to how
// many of them", which is the question the Campaigns page cannot answer for itself.
func segmentConsentStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		segID := toInt64(chi.URLParam(r, "sid"))
		seg, err := db.PGQuery(ctx,
			`SELECT id, last_list_id FROM contact_segments WHERE id=$1`, segID)
		if err != nil || len(seg) == 0 {
			respondErr(w, 404, "Segment not found")
			return
		}
		listID := toInt64(seg[0]["last_list_id"])
		if listID == 0 {
			respond(w, map[string]any{"built": false}, "pg")
			return
		}
		rows, err := db.PGQuery(ctx, `
			SELECT ch.channel,
			       COUNT(*)                                            AS members,
			       COUNT(m.party_id)                                   AS known_customers,
			       COUNT(*) FILTER (WHERE c.state = 'granted'
			                          AND (c.expires_at IS NULL OR c.expires_at > NOW()))
			                                                            AS marketing_granted,
			       COUNT(*) FILTER (WHERE c.state = 'withdrawn')        AS withdrawn,
			       COUNT(*) FILTER (WHERE m.party_id IS NOT NULL AND c.party_id IS NULL)
			                                                            AS never_asked
			  FROM contact_list_members m
			  CROSS JOIN (VALUES ('email'),('sms'),('whatsapp')) AS ch(channel)
			  LEFT JOIN app.party_contact_consent c
			         ON c.party_id = m.party_id AND c.channel = ch.channel
			        AND c.purpose = 'marketing'
			 -- status='active' because that is the population a campaign actually sends to
			 -- (campaigns.go snapshots the same filter). Counting unsubscribed members here
			 -- would report consent for people no campaign will ever contact.
			 WHERE m.list_id = $1 AND m.status = 'active'
			 GROUP BY ch.channel ORDER BY ch.channel`, listID)
		if err != nil {
			respondErrLog(w, 500, "Could not read consent for this segment", err)
			return
		}
		respond(w, map[string]any{"built": true, "list_id": listID, "channels": rows}, "pg")
	}
}

// segmentRecordConsent applies ONE consent decision to everybody in a segment's list.
//
// WHY THIS EXISTS, and what it is not. Marketing consent stood at zero, so the gate added
// alongside it refuses every known customer — correctly, and permanently, because the only
// way to grant consent was one party at a time or by assembling a list of party_ids by
// hand. 10,896 of those is not a thing anybody does, so "no consent" was effectively
// unfixable through the app.
//
// This is NOT a way around the gate. It is the same compliance act app.party_contact_consent
// already models, applied to a population somebody has defined and can see: it reuses
// consentValidate (marketing demands a basis AND evidence), it keeps the typed confirmation
// that bulk grants require, it records WHO decided against every row, and it refuses to
// invent a party — only members already tied to a real customer are touched. Prospects with
// no party_id cannot be granted anything here; their basis belongs on the list itself.
func segmentRecordConsent(db *core.DB) http.HandlerFunc {
	type body struct {
		Channels []string `json:"channels"`
		Purpose  string   `json:"purpose"`
		State    string   `json:"state"`
		Basis    string   `json:"basis"`
		Evidence string   `json:"evidence"`
		Confirm  string   `json:"confirm"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		segID := toInt64(chi.URLParam(r, "sid"))
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.Purpose = strings.ToLower(strings.TrimSpace(b.Purpose))
		b.State = strings.ToLower(strings.TrimSpace(b.State))
		b.Basis, b.Evidence = strings.TrimSpace(b.Basis), strings.TrimSpace(b.Evidence)
		if len(b.Channels) == 0 {
			respondErr(w, 422, "Say which channels this decision covers.")
			return
		}
		for _, ch := range b.Channels {
			if !audienceChannels[strings.ToLower(strings.TrimSpace(ch))] {
				respondErr(w, 422, "\""+ch+"\" is not a channel.")
				return
			}
		}

		seg, err := db.PGQuery(ctx,
			`SELECT id, name, last_list_id FROM contact_segments WHERE id=$1`, segID)
		if err != nil || len(seg) == 0 {
			respondErr(w, 404, "Segment not found")
			return
		}
		listID := toInt64(seg[0]["last_list_id"])
		if listID == 0 {
			respondErr(w, 409, "Build the segment first — there is no list to apply this to.")
			return
		}
		ids, err := db.PGQuery(ctx, `
			SELECT DISTINCT m.party_id
			  FROM contact_list_members m
			  JOIN app.parties p ON p.party_id = m.party_id
			 WHERE m.list_id = $1 AND m.party_id IS NOT NULL
			   AND m.status = 'active'`, listID)
		if err != nil {
			respondErrLog(w, 500, "Could not read the segment's members", err)
			return
		}
		if len(ids) == 0 {
			respondErr(w, 409, "Nobody in this segment is a known customer, so there is no "+
				"consent record to write. For a prospect list, record the basis on the list itself.")
			return
		}
		partyIDs := make([]int64, 0, len(ids))
		for _, row := range ids {
			partyIDs = append(partyIDs, toInt64(row["party_id"]))
		}

		// Same validation and same friction as recording it one customer at a time.
		if msg := consentValidate(partyIDs[0], strings.ToLower(strings.TrimSpace(b.Channels[0])),
			b.Purpose, b.State, b.Basis, b.Evidence); msg != "" {
			respondErr(w, 422, msg)
			return
		}
		if b.State == "granted" && b.Purpose == purposeMarketing &&
			strings.TrimSpace(b.Confirm) != "I HAVE THE EVIDENCE" {
			respondErr(w, 428, fmt.Sprintf("Recording marketing consent for %d customers is "+
				"a compliance act. Confirm you hold the evidence.", len(partyIDs)))
			return
		}

		user := core.UserFromCtx(ctx)
		written := 0
		for _, ch := range b.Channels {
			ch = strings.ToLower(strings.TrimSpace(ch))
			res, err := db.PGExec(ctx, `
				INSERT INTO app.party_contact_consent
				    (party_id, channel, purpose, state, basis, evidence, recorded_by, recorded_at)
				SELECT UNNEST($1::bigint[]), $2, $3, $4, NULLIF($5,''), NULLIF($6,''), $7, NOW()
				ON CONFLICT (party_id, channel, purpose) DO UPDATE
				  SET state = EXCLUDED.state, basis = EXCLUDED.basis,
				      evidence = EXCLUDED.evidence, recorded_by = EXCLUDED.recorded_by,
				      recorded_at = NOW()`,
				partyIDs, ch, b.Purpose, b.State, b.Basis, b.Evidence, nullableInt64(user.ID))
			if err != nil {
				respondErrLog(w, 500, "Could not record the decision", err)
				return
			}
			if n, e := res.RowsAffected(); e == nil {
				written += int(n)
			}
		}

		aid, aname, ateam := actorOf(user)
		//nolint:errcheck // the decision is already recorded; a failed log must not undo it
		LogActivity(ctx, db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Source: "manual",
			Subject: "Consent " + b.State + " for segment " + str(seg[0]["name"]),
			Body: fmt.Sprintf("%s consent recorded as %q for %d customers in segment %q "+
				"on %s. Basis: %s. Evidence: %s.",
				b.Purpose, b.State, len(partyIDs),
				str(seg[0]["name"]), strings.Join(b.Channels, ", "),
				orDash(b.Basis), orDash(b.Evidence)),
			EntityType: "contact_segment", EntityID: fmt.Sprintf("%d", segID),
		})

		respond(w, map[string]any{
			"segment_id": segID, "customers": len(partyIDs),
			"rows_written": written, "channels": b.Channels,
		}, "pg")
	}
}

const contactSegmentWorkerKey = "contact_segments"

// StartContactSegmentWorker keeps opted-in segments current.
//
// WHY A WORKER. A segment was a stored query plus a manual snapshot, so "customers who
// have not transacted in 90 days" was only true as at whenever somebody last pressed
// Refresh. That is the wrong shape for a moving population: the list ages silently, and a
// stale copy of a dormancy audience messages people who have since come back.
//
// Ticks every 15 minutes and only acts on segments whose own interval has elapsed, so the
// cadence is the segment's choice rather than the worker's. The floor is an hour because
// app.customer_lifecycle is itself only recomputed nightly by retention_lifecycle at
// 03:30 — refreshing faster than that cannot make the answer fresher.
func StartContactSegmentWorker(db *core.DB) {
	for {
		runContactSegmentRefresh(db)
		time.Sleep(15 * time.Minute)
	}
}

func runContactSegmentRefresh(db *core.DB) {
	// Guard the CYCLE, not the goroutine: one bad segment must not kill the worker for
	// the life of the process while the hub still reports it as running.
	defer recoverPanic(contactSegmentWorkerKey)

	ctx := context.Background()
	due, err := db.PGQuery(ctx, `
		SELECT id, name FROM contact_segments
		 WHERE auto_refresh
		   AND (last_auto_refresh_at IS NULL
		        OR last_auto_refresh_at < NOW() - make_interval(hours => refresh_interval_hours))
		 ORDER BY last_auto_refresh_at NULLS FIRST
		 LIMIT 25`)
	if err != nil {
		WorkerBeat(ctx, db, contactSegmentWorkerKey, "error", "", err.Error())
		return
	}
	if len(due) == 0 {
		// Idle is the normal state and is reported as such, so an operator can tell
		// "nothing was due" apart from "the worker is not running".
		WorkerBeat(ctx, db, contactSegmentWorkerKey, "idle", "no segment due a refresh", "")
		return
	}
	WorkerBeat(ctx, db, contactSegmentWorkerKey, "running", "", "")

	var refreshed, failed, members int
	for _, s := range due {
		segID := toInt64(s["id"])
		// Stamped before the attempt, so a segment that fails every time still waits its
		// interval instead of being retried every 15 minutes for ever.
		db.PGExec(ctx, //nolint:errcheck
			"UPDATE contact_segments SET last_auto_refresh_at = NOW() WHERE id=$1", segID)

		out, _, err := refreshSegment(ctx, db, segID, 0)
		if err != nil {
			failed++
			slog.Error("contact segment auto-refresh failed",
				"segment", segID, "name", str(s["name"]), "err", err)
			// Recorded on the row, not only in the log: a segment that has quietly
			// stopped updating looks identical to one that is up to date.
			db.PGExec(ctx, //nolint:errcheck
				"UPDATE contact_segments SET last_refresh_error=$1 WHERE id=$2", err.Error(), segID)
			continue
		}
		refreshed++
		members += out.Imported
	}

	detail := fmt.Sprintf("%d segment(s) refreshed, %d members", refreshed, members)
	if failed > 0 {
		detail = fmt.Sprintf("%s, %d FAILED", detail, failed)
	}
	WorkerBeat(ctx, db, contactSegmentWorkerKey, "ok", detail, "")
}
