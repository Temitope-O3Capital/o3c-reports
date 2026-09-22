// Package cbssync spools the Udara360 core-banking book (products, loans, fixed
// deposits) into the workspace's read-only snapshot tables (cbs_products,
// cbs_loans, cbs_fixed_deposits) and reconciles those accounts against workspace
// records via cbs_links. Udara360 is the system of record; these tables are
// refreshed atomically per run and are never written by workspace workflows.
package cbssync

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/udara"
)

const (
	// defaultPageSize is large enough to return the entire loan/FD book in a single
	// page (the CBS honours large page sizes; its multi-page pagination is unstable).
	defaultPageSize = 500
	// buffer is headroom added when re-fetching a book larger than defaultPageSize.
	buffer = 100
)

// Result summarises one sync run.
type Result struct {
	Products         int
	Loans            int
	FDs              int
	Matched          int
	Unmatched        int
	CustomersCreated int
	OfficersAssigned int
	CustomerMaster   int // Udara customer-master records mirrored into cbs_customers
	ProfilesEnriched int // workspace profiles that gained contact detail from the master
	CustomersLinked  int // Udara customers given a workspace party + crosswalk link this run
}

// envelope is the standard Udara360 response wrapper: {"data":[...], "message":..., "status":...}.
// Only "data" is consumed; message/status vary in type across endpoints (status is a bool),
// so they are left out to keep unmarshalling tolerant.
type envelope struct {
	Data json.RawMessage `json:"data"`
}

// SyncAll runs a full spool + reconcile, recording an audit row in cbs_sync_runs.
// kind is "scheduled" or "manual"; triggeredBy is the user id for manual runs (or NULL).
func SyncAll(ctx context.Context, c *udara.Client, db *core.DB, kind string, triggeredBy sql.NullInt64) (Result, error) {
	var res Result
	if !c.IsConfigured() {
		return res, fmt.Errorf("cbs sync: udara client not configured")
	}

	var runID int64
	if err := db.PG.QueryRowContext(ctx,
		`INSERT INTO cbs_sync_runs (kind, status, triggered_by) VALUES ($1, 'running', $2) RETURNING id`,
		kind, triggeredBy).Scan(&runID); err != nil {
		return res, fmt.Errorf("cbs sync: open run: %w", err)
	}

	res, err := doSync(ctx, c, db)
	if err != nil {
		_, _ = db.PG.ExecContext(ctx,
			`UPDATE cbs_sync_runs SET finished_at = NOW(), status = 'error', error = $2 WHERE id = $1`,
			runID, err.Error())
		slog.Error("cbs sync failed", "run_id", runID, "err", err)
		return res, err
	}

	_, _ = db.PG.ExecContext(ctx,
		`UPDATE cbs_sync_runs SET finished_at = NOW(), status = 'ok',
		    products_n = $2, loans_n = $3, fds_n = $4, matched_n = $5, unmatched_n = $6
		 WHERE id = $1`,
		runID, res.Products, res.Loans, res.FDs, res.Matched, res.Unmatched)
	slog.Info("cbs sync ok", "run_id", runID, "products", res.Products, "loans", res.Loans,
		"fds", res.FDs, "matched", res.Matched, "unmatched", res.Unmatched)
	return res, nil
}

func doSync(ctx context.Context, c *udara.Client, db *core.DB) (Result, error) {
	var res Result

	// Products do NOT paginate (the endpoint rejects PageNumber/PageSize) -- fetch once.
	products, err := fetchList(ctx, c, "/api/Product/v1/SearchProducts", nil)
	if err != nil {
		return res, err
	}
	loans, err := fetchFullBook(ctx, c, "/api/LoanAccount/v1/Search")
	if err != nil {
		return res, err
	}
	fds, err := fetchFullBook(ctx, c, "/api/FixedDepositAccount/v1/Search")
	if err != nil {
		return res, err
	}

	// Atomic full-refresh of all three snapshot tables in one transaction.
	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return res, fmt.Errorf("cbs sync: begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if err := refreshProducts(ctx, tx, products); err != nil {
		return res, err
	}
	if err := refreshLoans(ctx, tx, loans); err != nil {
		return res, err
	}
	if err := refreshFDs(ctx, tx, fds); err != nil {
		return res, err
	}
	if err := tx.Commit(); err != nil {
		return res, fmt.Errorf("cbs sync: commit: %w", err)
	}

	// Rebuild the FD rollover lineage (migration 276). refreshFDs above DELETEs and
	// re-INSERTs cbs_fixed_deposits wholesale, so lineage cannot live in a column on that
	// table — it would be destroyed every three minutes. It lives in app.fd_rollover_links
	// and is recomputed here, right after the book it is derived from has landed.
	//
	// Deliberately NOT fatal: a failure here costs a stale rollover count on a reporting
	// view, and must never fail a sync that has already committed the loan and deposit
	// books. Logged at Error so it is visible rather than silently stale.
	if _, err := db.PG.ExecContext(ctx, `SELECT app.compute_fd_rollover_links()`); err != nil {
		slog.Error("cbs sync: FD rollover lineage rebuild failed — counts are stale", "err", err)
	}
	// Same for loan restructures (migration 277): refreshLoans clears cbs_loans the same
	// way, so which facility is an existing debt on new terms cannot be stored on it.
	if _, err := db.PG.ExecContext(ctx, `SELECT app.compute_loan_restructure_links()`); err != nil {
		slog.Error("cbs sync: loan restructure lineage rebuild failed — counts are stale", "err", err)
	}

	res.Products, res.Loans, res.FDs = len(products), len(loans), len(fds)

	// Spool the Udara customer MASTER (individual + corporate). The loan/FD feeds carry
	// only a name; these customer endpoints carry the full contact profile Udara holds —
	// phone, email, address, state/LGA, BVN/NIN, date of birth, gender, next-of-kin, and
	// (for corporates) contact-person + registration detail. Best-effort and outside the
	// atomic loan/FD refresh, so a customer-endpoint hiccup never breaks the money sync.
	if custRows, err := fetchCustomers(ctx, c); err != nil {
		slog.Warn("cbs customer master fetch failed", "err", err)
	} else if len(custRows) > 0 {
		if n, err := refreshCBSCustomers(ctx, db, custRows); err != nil {
			slog.Warn("cbs customer master upsert failed", "err", err)
		} else {
			res.CustomerMaster = n
			// Give every Udara customer a workspace party (CUST) + crosswalk link, so a
			// customer created directly in Udara is onboarded automatically rather than
			// waiting for a one-off migration. Merges into an existing party only on BVN
			// (see app.link_cbs_customers, migration 227).
			if linked, err := linkCBSCustomers(ctx, db); err != nil {
				slog.Warn("cbs customer linking failed", "err", err)
			} else if linked > 0 {
				res.CustomersLinked = linked
				slog.Info("cbs sync linked customers to parties", "count", linked)
			}
			// Backfill blank contact fields on the linked workspace profiles from the
			// master — routed through the cbs_links → party bridge, NEVER the colliding
			// cif join (Udara customerID and the card-feed cif are different namespaces).
			if enr, err := enrichCustomersFromCBS(ctx, db); err != nil {
				slog.Warn("cbs profile enrichment failed", "err", err)
			} else {
				res.ProfilesEnriched = enr
			}
		}
	}

	// Ensure every Udara customer has an identity profile. Udara-only borrowers and
	// depositors who hold no card never arrive via the card cust_file feed, so without
	// this they surface across collections/recovery/Customer-360 as a bare CIF. This is
	// insert-only (it never overwrites richer card-fed identity), so it is cheap to run
	// every sync; the party graph is only recomputed when the book actually gains a
	// customer.
	if created, err := upsertUdaraCustomers(ctx, db); err != nil {
		slog.Warn("cbs customer upsert failed", "err", err)
	} else if created > 0 {
		res.CustomersCreated = created
		if _, err := db.PG.ExecContext(ctx, `SELECT app.assign_parties()`); err != nil {
			slog.Warn("assign_parties after cbs customer upsert failed", "err", err)
		}
		slog.Info("cbs sync created customer profiles", "count", created)
	}

	// Assign each Udara customer their account officer (minting a no-login user for any
	// officer not already on the roster). Non-destructive and idempotent — an existing or
	// manual assignment is never overwritten — so this is safe to run every sync.
	if assigned, err := assignCBSOfficers(ctx, db); err != nil {
		slog.Warn("cbs officer assignment failed", "err", err)
	} else if assigned > 0 {
		res.OfficersAssigned = assigned
		slog.Info("cbs sync assigned account officers", "count", assigned)
	}

	// Loan repayment schedules — per-loan interest income (earned once the installment is
	// processed, expected/scheduled by payment_date). The loan Search feed returns
	// paymentSchedules null, so this pulls each non-closed loan's schedule separately.
	// Best-effort and self-contained: isolated from the atomic refresh above, so a
	// schedule-fetch failure never breaks the loan/FD sync.
	if n, err := syncLoanSchedules(ctx, c, db, loans); err != nil {
		// A fetch/DB hiccup stays best-effort, but a guard refusal is a data-integrity
		// event: it means this run would have destroyed the schedule book, and it must
		// surface as an 'error' run rather than a green 'ok'. Nothing was deleted — the
		// transaction rolled back — so the existing snapshot is intact.
		if errors.Is(err, errBookShrank) {
			return res, err
		}
		slog.Warn("cbs loan schedule sync failed", "err", err)
	} else {
		slog.Info("cbs loan schedules synced", "installments", n)
	}

	// Reconcile against workspace records (best-effort; unmatched are surfaced, not forced).
	matched, unmatched, err := Reconcile(ctx, db)
	if err != nil {
		slog.Warn("cbs reconcile failed", "err", err)
	}
	res.Matched, res.Unmatched = matched, unmatched
	return res, nil
}

// upsertUdaraCustomers creates a minimal identity profile in app.customers for every
// Udara customer that has none. It is keyed on party_id — the workspace Customer ID —
// through the app.cbs_links crosswalk, which covers every Udara customer and is the
// only correct bridge between the two systems.
//
// This mirrors migration 258 section 2 exactly, so the one-off migration and this
// recurring sync converge on the same rows instead of fighting.
//
//   - cif stays NULL. app.customers.cif is a CARDS (CCS/Sage) identifier, NOT a customer
//     id, and these customers hold no card. Writing the Udara customerID there is the
//     defect 258 closes: 269 of the 294 Udara ids already existed as mssql_baseline card
//     rows for unrelated people, so the old ON CONFLICT (cif) DO NOTHING silently did
//     nothing for them. uq_customers_cif is partial — it indexes only non-null, non-blank
//     cif — so any number of rows may carry NULL.
//   - contact_id is 'U' || LPAD(cbs_customer_id,15,'0') — 16 chars, matching the existing
//     width. Prefixes '0' (baseline), 'Z' (card feed) and 'W' are taken; 'U' is free.
//   - Only parties with NO profile at all are inserted. Where app.link_cbs_customers
//     merged a Udara customer into an existing card party on a unique BVN, that party
//     already holds a richer card-fed row and keeps it; enrichCustomersFromCBS fills that
//     row's blanks instead.
//   - DISTINCT ON guards two Udara customers linked to one party: the fuller name wins,
//     and the second is still reachable through cbs_links.
//
// Contact detail is deliberately NOT set here (an earlier comment claimed Udara exposes
// no phone/email — it does, and refreshCBSCustomers already stores both): identity
// backfill is enrichCustomersFromCBS's job, blank-only, so it never overwrites the card
// feed. The write is strictly additive and idempotent — it runs every sync.
func upsertUdaraCustomers(ctx context.Context, db *core.DB) (int, error) {
	res, err := db.PG.ExecContext(ctx, `
INSERT INTO app.customers
    (contact_id, cif, party_id, full_name, first_name, last_name,
     source, first_seen_at, created_at, last_seen)
SELECT DISTINCT ON (l.entity_id)
    'U' || LPAD(cc.cbs_customer_id, 15, '0'),
    NULL,
    l.entity_id,
    NULLIF(btrim(cc.name), ''),
    NULLIF(btrim(cc.first_name), ''),
    NULLIF(btrim(cc.last_name), ''),
    'udara_cbs', NOW(), NOW(), NOW()
  FROM app.cbs_links l
  JOIN app.cbs_customers cc ON cc.cbs_customer_id = l.cbs_customer_id
 WHERE l.entity_type = 'party'
   AND NOT EXISTS (SELECT 1 FROM app.customers c WHERE c.party_id = l.entity_id)
 ORDER BY l.entity_id, length(COALESCE(btrim(cc.name), '')) DESC
ON CONFLICT (contact_id) DO NOTHING`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// fetchCustomers pulls the Udara customer master — individuals and corporates via the
// two Search endpoints — tagging each record with its customer_type. Best-effort per
// endpoint: if one fails the other still returns, so a corporate-endpoint hiccup never
// loses the individuals. Records dedupe by the Udara record GUID; each carries the
// customerID that keys the loan/FD books (the SAME id namespace as cbs_customer_id).
func fetchCustomers(ctx context.Context, c *udara.Client) ([]map[string]any, error) {
	var all []map[string]any
	var firstErr error
	for _, ep := range []struct{ path, typ string }{
		{"/api/Account/v1/SearchIndividualCustomers", "Individual"},
		{"/api/Account/v1/SearchGroupCustomers", "Corporate"},
	} {
		items, err := fetchFullBook(ctx, c, ep.path)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for _, m := range items {
			if gstr(m, "customerType") == "" {
				m["customerType"] = ep.typ
			}
			all = append(all, m)
		}
	}
	if len(all) == 0 && firstErr != nil {
		return nil, firstErr
	}
	return all, nil
}

// refreshCBSCustomers upserts the customer master into cbs_customers, keyed by Udara's
// customerID. Upsert (not delete+insert): the master only grows, and we never want a
// transient partial fetch to drop a profile. Returns the number of rows written.
func refreshCBSCustomers(ctx context.Context, db *core.DB, rows []map[string]any) (int, error) {
	const q = `INSERT INTO cbs_customers (
	    cbs_customer_id, cbs_id, customer_type, name, title, first_name, last_name, other_names,
	    phone, email, address, city, state, lga, nationality, bvn, nin, tin, date_of_birth,
	    gender, marital_status, occupation, employer_name, employer_address, office_phone,
	    means_of_id, id_number, nok_name, nok_phone, nok_relationship,
	    business_phone, nature_of_business, industrial_sector, registration_number,
	    contact_person_name, contact_person_phone, state_of_operation, pep,
    religion, hometown, nok_gender, raw, synced_at)
	  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
	          $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$40,$41,$42,$39::jsonb, NOW())
	  ON CONFLICT (cbs_customer_id) DO UPDATE SET
	    cbs_id=EXCLUDED.cbs_id, customer_type=EXCLUDED.customer_type, name=EXCLUDED.name,
	    title=EXCLUDED.title, first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
	    other_names=EXCLUDED.other_names, phone=EXCLUDED.phone, email=EXCLUDED.email,
	    address=EXCLUDED.address, city=EXCLUDED.city, state=EXCLUDED.state, lga=EXCLUDED.lga,
	    nationality=EXCLUDED.nationality, bvn=EXCLUDED.bvn, nin=EXCLUDED.nin, tin=EXCLUDED.tin,
	    date_of_birth=EXCLUDED.date_of_birth, gender=EXCLUDED.gender,
	    marital_status=EXCLUDED.marital_status, occupation=EXCLUDED.occupation,
	    employer_name=EXCLUDED.employer_name, employer_address=EXCLUDED.employer_address,
	    office_phone=EXCLUDED.office_phone, means_of_id=EXCLUDED.means_of_id,
	    id_number=EXCLUDED.id_number, nok_name=EXCLUDED.nok_name, nok_phone=EXCLUDED.nok_phone,
	    nok_relationship=EXCLUDED.nok_relationship, business_phone=EXCLUDED.business_phone,
	    nature_of_business=EXCLUDED.nature_of_business, industrial_sector=EXCLUDED.industrial_sector,
	    registration_number=EXCLUDED.registration_number, contact_person_name=EXCLUDED.contact_person_name,
	    contact_person_phone=EXCLUDED.contact_person_phone, state_of_operation=EXCLUDED.state_of_operation,
	    pep=EXCLUDED.pep, religion=EXCLUDED.religion, hometown=EXCLUDED.hometown,
    nok_gender=EXCLUDED.nok_gender, raw=EXCLUDED.raw, synced_at=NOW()`
	n := 0
	for _, m := range rows {
		cif := strings.TrimSpace(gstr(m, "customerID"))
		if cif == "" {
			continue
		}
		if _, err := db.PG.ExecContext(ctx, q,
			cif, gstr(m, "id"), gstr(m, "customerType"), gstr(m, "name"), gstr(m, "title"),
			gstr(m, "firstName"), gstr(m, "lastName"), gstr(m, "otherNames"),
			// city takes Udara's city, NOT its hometown. This used to pass hometown
			// here, which made cbs_customers.city mean "place of origin" for every
			// row — and enrichCustomersFromCBS then copied it into
			// app.customers.city, where it reads as a residence. hometown now has
			// its own column (migration 233/235). Existing mislabelled city values
			// are left alone deliberately; correcting them is a separate, explicit
			// cleanup, not a side effect of a sync.
			gstr(m, "phoneNumber"), gstr(m, "email"), gstr(m, "address"), gstr(m, "city"),
			gstr(m, "state"), gstr(m, "lga"), gstr(m, "nationality"), gstr(m, "bvn"), gstr(m, "nin"), gstr(m, "tin"),
			gts(m, "dateOfBirth"), gstr(m, "gender"), gstr(m, "maritalStatus"), gstr(m, "occupation"),
			gstr(m, "employerName"), gstr(m, "employerAddress"), gstr(m, "officePhoneNumber"),
			gstr(m, "meansOfIdentification"), gstr(m, "idNumber"), gstr(m, "nokName"), gstr(m, "nokPhoneNumber"),
			gstr(m, "nokRelationship"), gstr(m, "businessPhoneNumber"), gstr(m, "natureOfBusiness"),
			gstr(m, "industrialSector"), gstr(m, "registrationNumber"), gstr(m, "contactPersonName"),
			gstr(m, "contactPersonPhoneNumber"), gstr(m, "stateOfOperation"), gbool(m, "pep"), rawOf(m),
			// $40-$42. Religion is special-category data under the NDPA — it is
			// stored because Udara already returns it and burying it in jsonb made it
			// unauditable, not because anything should score on it.
			gstr(m, "religion"), gstr(m, "hometown"), gstr(m, "nokGender"),
		); err != nil {
			return n, fmt.Errorf("cbs upsert customer %s: %w", cif, err)
		}
		n++
	}
	return n, nil
}

// enrichCustomersFromCBS fills BLANK identity/KYC fields on workspace profiles from the
// Udara customer master. It only ever fills empties — a value already on the profile
// (from the card feed, which is richer wherever it has data) is never overwritten.
// Crucially it joins through the cbs_links → party crosswalk, so a Udara customer's PII
// lands on the party that actually owns it, never on a card customer whose cif merely
// collides with the Udara customerID. Returns rows changed.
//
// The column list mirrors migration 258 section 3: the nine original contact fields plus
// the identity/KYC columns 258 adds (NIN, TIN, LGA, nationality, marital status,
// occupation, employer, office/business phone, means of ID, next-of-kin, corporate
// contact-person and registration detail, religion, hometown and the PEP flag). Names
// match cbs_customers one-for-one so the mapping stays obvious.
//
// pep is the one non-blank-only field: it is a risk flag, not contact detail, so once
// true it stays true and a NULL workspace value takes whatever the master says.
//
// NOTE: this requires migration 258. Until 258 is applied the statement errors on the
// unknown columns; the caller treats enrichment as best-effort and only warns, so the
// money sync is unaffected.
func enrichCustomersFromCBS(ctx context.Context, db *core.DB) (int, error) {
	res, err := db.PG.ExecContext(ctx, `
UPDATE app.customers cu SET
    phone                = COALESCE(NULLIF(btrim(cu.phone),''),                NULLIF(btrim(cc.phone),'')),
    email                = COALESCE(NULLIF(btrim(cu.email),''),                NULLIF(btrim(cc.email),'')),
    address_1            = COALESCE(NULLIF(btrim(cu.address_1),''),            NULLIF(btrim(cc.address),'')),
    full_address         = COALESCE(NULLIF(btrim(cu.full_address),''),         NULLIF(btrim(cc.address),'')),
    city                 = COALESCE(NULLIF(btrim(cu.city),''),                 NULLIF(btrim(cc.city),'')),
    state                = COALESCE(NULLIF(btrim(cu.state),''),                NULLIF(btrim(cc.state),'')),
    bvn                  = COALESCE(NULLIF(btrim(cu.bvn),''),                  NULLIF(btrim(cc.bvn),'')),
    birthday             = COALESCE(cu.birthday,                               cc.date_of_birth),
    gender               = COALESCE(NULLIF(btrim(cu.gender),''),               NULLIF(btrim(cc.gender),'')),
    nin                  = COALESCE(NULLIF(btrim(cu.nin),''),                  NULLIF(btrim(cc.nin),'')),
    tin                  = COALESCE(NULLIF(btrim(cu.tin),''),                  NULLIF(btrim(cc.tin),'')),
    lga                  = COALESCE(NULLIF(btrim(cu.lga),''),                  NULLIF(btrim(cc.lga),'')),
    nationality          = COALESCE(NULLIF(btrim(cu.nationality),''),          NULLIF(btrim(cc.nationality),'')),
    marital_status       = COALESCE(NULLIF(btrim(cu.marital_status),''),       NULLIF(btrim(cc.marital_status),'')),
    occupation           = COALESCE(NULLIF(btrim(cu.occupation),''),           NULLIF(btrim(cc.occupation),'')),
    employer_name        = COALESCE(NULLIF(btrim(cu.employer_name),''),        NULLIF(btrim(cc.employer_name),'')),
    employer_address     = COALESCE(NULLIF(btrim(cu.employer_address),''),     NULLIF(btrim(cc.employer_address),'')),
    office_phone         = COALESCE(NULLIF(btrim(cu.office_phone),''),         NULLIF(btrim(cc.office_phone),'')),
    means_of_id          = COALESCE(NULLIF(btrim(cu.means_of_id),''),          NULLIF(btrim(cc.means_of_id),'')),
    id_number            = COALESCE(NULLIF(btrim(cu.id_number),''),            NULLIF(btrim(cc.id_number),'')),
    nok_name             = COALESCE(NULLIF(btrim(cu.nok_name),''),             NULLIF(btrim(cc.nok_name),'')),
    nok_phone            = COALESCE(NULLIF(btrim(cu.nok_phone),''),            NULLIF(btrim(cc.nok_phone),'')),
    nok_relationship     = COALESCE(NULLIF(btrim(cu.nok_relationship),''),     NULLIF(btrim(cc.nok_relationship),'')),
    business_phone       = COALESCE(NULLIF(btrim(cu.business_phone),''),       NULLIF(btrim(cc.business_phone),'')),
    nature_of_business   = COALESCE(NULLIF(btrim(cu.nature_of_business),''),   NULLIF(btrim(cc.nature_of_business),'')),
    industrial_sector    = COALESCE(NULLIF(btrim(cu.industrial_sector),''),    NULLIF(btrim(cc.industrial_sector),'')),
    registration_number  = COALESCE(NULLIF(btrim(cu.registration_number),''),  NULLIF(btrim(cc.registration_number),'')),
    contact_person_name  = COALESCE(NULLIF(btrim(cu.contact_person_name),''),  NULLIF(btrim(cc.contact_person_name),'')),
    contact_person_phone = COALESCE(NULLIF(btrim(cu.contact_person_phone),''), NULLIF(btrim(cc.contact_person_phone),'')),
    state_of_operation   = COALESCE(NULLIF(btrim(cu.state_of_operation),''),   NULLIF(btrim(cc.state_of_operation),'')),
    religion             = COALESCE(NULLIF(btrim(cu.religion),''),             NULLIF(btrim(cc.religion),'')),
    hometown             = COALESCE(NULLIF(btrim(cu.hometown),''),             NULLIF(btrim(cc.hometown),'')),
    pep                  = COALESCE(cu.pep, FALSE) OR COALESCE(cc.pep, FALSE),
    last_seen            = NOW()
  FROM app.cbs_links l
  JOIN app.cbs_customers cc ON cc.cbs_customer_id = l.cbs_customer_id
 WHERE l.entity_type = 'party' AND cu.party_id = l.entity_id
   AND (
        (COALESCE(btrim(cu.phone),'')                = '' AND COALESCE(btrim(cc.phone),'')                <> '') OR
        (COALESCE(btrim(cu.email),'')                = '' AND COALESCE(btrim(cc.email),'')                <> '') OR
        (COALESCE(btrim(cu.address_1),'')            = '' AND COALESCE(btrim(cc.address),'')              <> '') OR
        (COALESCE(btrim(cu.full_address),'')         = '' AND COALESCE(btrim(cc.address),'')              <> '') OR
        (COALESCE(btrim(cu.city),'')                 = '' AND COALESCE(btrim(cc.city),'')                 <> '') OR
        (COALESCE(btrim(cu.state),'')                = '' AND COALESCE(btrim(cc.state),'')                <> '') OR
        (COALESCE(btrim(cu.bvn),'')                  = '' AND COALESCE(btrim(cc.bvn),'')                  <> '') OR
        (cu.birthday IS NULL AND cc.date_of_birth IS NOT NULL)                                               OR
        (COALESCE(btrim(cu.gender),'')               = '' AND COALESCE(btrim(cc.gender),'')               <> '') OR
        (COALESCE(btrim(cu.nin),'')                  = '' AND COALESCE(btrim(cc.nin),'')                  <> '') OR
        (COALESCE(btrim(cu.tin),'')                  = '' AND COALESCE(btrim(cc.tin),'')                  <> '') OR
        (COALESCE(btrim(cu.lga),'')                  = '' AND COALESCE(btrim(cc.lga),'')                  <> '') OR
        (COALESCE(btrim(cu.nationality),'')          = '' AND COALESCE(btrim(cc.nationality),'')          <> '') OR
        (COALESCE(btrim(cu.marital_status),'')       = '' AND COALESCE(btrim(cc.marital_status),'')       <> '') OR
        (COALESCE(btrim(cu.occupation),'')           = '' AND COALESCE(btrim(cc.occupation),'')           <> '') OR
        (COALESCE(btrim(cu.employer_name),'')        = '' AND COALESCE(btrim(cc.employer_name),'')        <> '') OR
        (COALESCE(btrim(cu.employer_address),'')     = '' AND COALESCE(btrim(cc.employer_address),'')     <> '') OR
        (COALESCE(btrim(cu.office_phone),'')         = '' AND COALESCE(btrim(cc.office_phone),'')         <> '') OR
        (COALESCE(btrim(cu.means_of_id),'')          = '' AND COALESCE(btrim(cc.means_of_id),'')          <> '') OR
        (COALESCE(btrim(cu.id_number),'')            = '' AND COALESCE(btrim(cc.id_number),'')            <> '') OR
        (COALESCE(btrim(cu.nok_name),'')             = '' AND COALESCE(btrim(cc.nok_name),'')             <> '') OR
        (COALESCE(btrim(cu.nok_phone),'')            = '' AND COALESCE(btrim(cc.nok_phone),'')            <> '') OR
        (COALESCE(btrim(cu.nok_relationship),'')     = '' AND COALESCE(btrim(cc.nok_relationship),'')     <> '') OR
        (COALESCE(btrim(cu.business_phone),'')       = '' AND COALESCE(btrim(cc.business_phone),'')       <> '') OR
        (COALESCE(btrim(cu.nature_of_business),'')   = '' AND COALESCE(btrim(cc.nature_of_business),'')   <> '') OR
        (COALESCE(btrim(cu.industrial_sector),'')    = '' AND COALESCE(btrim(cc.industrial_sector),'')    <> '') OR
        (COALESCE(btrim(cu.registration_number),'')  = '' AND COALESCE(btrim(cc.registration_number),'')  <> '') OR
        (COALESCE(btrim(cu.contact_person_name),'')  = '' AND COALESCE(btrim(cc.contact_person_name),'')  <> '') OR
        (COALESCE(btrim(cu.contact_person_phone),'') = '' AND COALESCE(btrim(cc.contact_person_phone),'') <> '') OR
        (COALESCE(btrim(cu.state_of_operation),'')   = '' AND COALESCE(btrim(cc.state_of_operation),'')   <> '') OR
        (COALESCE(btrim(cu.religion),'')             = '' AND COALESCE(btrim(cc.religion),'')             <> '') OR
        (COALESCE(btrim(cu.hometown),'')             = '' AND COALESCE(btrim(cc.hometown),'')             <> '') OR
        (COALESCE(cu.pep, FALSE) = FALSE AND COALESCE(cc.pep, FALSE) = TRUE)
   )`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// linkCBSCustomers ensures every Udara customer has a workspace party + crosswalk link.
// The logic lives in the SQL function app.link_cbs_customers() (migration 227): it creates
// a party for any master customer that lacks one and links it, merging into an existing
// party only on a unique BVN. Non-destructive and idempotent — a customer already linked is
// skipped — so it is safe to run every sync. Returns the number linked this run.
func linkCBSCustomers(ctx context.Context, db *core.DB) (int, error) {
	var n sql.NullInt64
	if err := db.PG.QueryRowContext(ctx, `SELECT app.link_cbs_customers()`).Scan(&n); err != nil {
		return 0, err
	}
	return int(n.Int64), nil
}

// assignCBSOfficers ensures every Udara customer has their account officer set as a
// relationship manager. The heavy lifting lives in the SQL function app.sync_cbs_officers()
// (migration 183): it mints a no-login user for any officer not already on the roster and
// assigns one officer per CIF, non-destructively (an existing/manual assignment is never
// overwritten). Returns the number of new assignments made this run.
func assignCBSOfficers(ctx context.Context, db *core.DB) (int, error) {
	var n sql.NullInt64
	if err := db.PG.QueryRowContext(ctx, `SELECT app.sync_cbs_officers()`).Scan(&n); err != nil {
		return 0, err
	}
	return int(n.Int64), nil
}

// ── fetching ─────────────────────────────────────────────────────────────────

// fetchList performs a single GET and returns the records under the "data" array.
func fetchList(ctx context.Context, c *udara.Client, path string, query url.Values) ([]map[string]any, error) {
	raw, code, err := c.Do(ctx, "GET", path, nil, query)
	if err != nil {
		return nil, fmt.Errorf("cbs fetch %s: %w", path, err)
	}
	if code < 200 || code >= 300 {
		return nil, fmt.Errorf("cbs fetch %s: HTTP %d: %s", path, code, truncate(raw, 300))
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("cbs fetch %s: parse envelope: %w", path, err)
	}
	items, err := extractItems(env.Data)
	if err != nil {
		return nil, fmt.Errorf("cbs fetch %s: parse data: %w; head=%s", path, err, truncate(env.Data, 240))
	}
	return items, nil
}

// Probe reports, per Search endpoint, the raw recordCount the CBS declares vs the
// number of items a page actually returns, plus whether page 2 (same large size)
// yields anything more. It answers "is 28 loans / 236 FDs the true total, or a
// capped/paginated view?" without writing anything.
func Probe(ctx context.Context, c *udara.Client) map[string]any {
	out := map[string]any{}
	for _, ep := range []struct{ name, path string }{
		{"loans", "/api/LoanAccount/v1/Search"},
		{"fixed_deposits", "/api/FixedDepositAccount/v1/Search"},
	} {
		r := map[string]any{}
		items1, total1, err1 := fetchOnePage(ctx, c, ep.path, 1, defaultPageSize)
		if err1 != nil {
			r["page1_error"] = err1.Error()
		} else {
			r["declared_recordCount"] = total1
			r["page1_items_returned"] = len(items1)
			r["requested_pagesize"] = defaultPageSize
			// If total > what page 1 returned, size a page to the total (what the
			// real sync does) and see if the whole book comes back.
			if total1 > len(items1) {
				full, _, ferr := fetchOnePage(ctx, c, ep.path, 1, total1+buffer)
				if ferr != nil {
					r["full_page_error"] = ferr.Error()
				} else {
					r["full_page_items"] = len(full)
				}
			}
			// Page 2 at the same large size: any items here mean recordCount understated.
			items2, _, err2 := fetchOnePage(ctx, c, ep.path, 2, defaultPageSize)
			if err2 != nil {
				r["page2_error"] = err2.Error()
			} else {
				r["page2_items_returned"] = len(items2)
			}
		}
		out[ep.name] = r
	}
	return out
}

// ProbeAll enumerates the Udara API surface: it hits a broad list of candidate
// core-banking Search endpoints and reports, per endpoint, the HTTP status, the
// declared recordCount, a small item sample, and the field names on the first
// record — plus a swagger/openapi discovery check. Read-only. This answers "what
// data can we actually get from Udara, and how much of each?"
func ProbeAll(ctx context.Context, c *udara.Client) map[string]any {
	endpoints := []string{
		"/api/Customer/v1/Search",
		"/api/CustomerAccount/v1/Search",
		"/api/Account/v1/Search",
		"/api/SavingsAccount/v1/Search",
		"/api/CurrentAccount/v1/Search",
		"/api/LoanAccount/v1/Search",
		"/api/FixedDepositAccount/v1/Search",
		"/api/TermDepositAccount/v1/Search",
		"/api/DepositAccount/v1/Search",
		"/api/Transaction/v1/Search",
		"/api/AccountTransaction/v1/Search",
		"/api/AccountStatement/v1/Search",
		"/api/Product/v1/SearchProducts",
		"/api/Branch/v1/Search",
		"/api/GLAccount/v1/Search",
		"/api/GeneralLedger/v1/Search",
		"/api/Teller/v1/Search",
		"/api/Loan/v1/Search",
		"/api/LoanRepayment/v1/Search",
		"/api/RepaymentSchedule/v1/Search",
		"/api/Collateral/v1/Search",
		"/api/Guarantor/v1/Search",
		"/api/User/v1/Search",
		"/api/Staff/v1/Search",
	}
	out := map[string]any{}
	for _, p := range endpoints {
		q := url.Values{}
		q.Set("PageNumber", "1")
		q.Set("PageSize", "3")
		raw, code, err := c.Do(ctx, "GET", p, nil, q)
		r := map[string]any{"http": code}
		switch {
		case err != nil:
			r["error"] = err.Error()
		case code >= 200 && code < 300:
			var env envelope
			if json.Unmarshal(raw, &env) == nil && len(env.Data) > 0 {
				items, _ := extractItems(env.Data)
				r["recordCount"] = recordCountOf(env.Data)
				r["items_in_sample"] = len(items)
				if len(items) > 0 {
					r["fields"] = sortedKeys(items[0])
				}
			} else {
				r["raw_head"] = truncate(raw, 200)
			}
		default:
			r["body_head"] = truncate(raw, 200)
		}
		out[p] = r
	}
	disc := map[string]any{}
	for _, p := range []string{"/swagger/v1/swagger.json", "/swagger.json", "/openapi.json", "/api-docs/v1/swagger.json"} {
		if _, code, err := c.Do(ctx, "GET", p, nil, nil); err != nil {
			disc[p] = err.Error()
		} else {
			disc[p] = code
		}
	}
	out["_discovery"] = disc
	return out
}

// ProbeDetail hunts for a per-account DETAIL endpoint. Core-banking Search lists
// return summaries (paymentSchedules came back null); the real installment schedule
// and richer per-account data usually live behind a Get/{id}-style endpoint. It
// self-fetches a sample loan + FD, tries the common detail patterns, and reports
// each response's shape — crucially, the length of any embedded schedule array.
func ProbeDetail(ctx context.Context, c *udara.Client) map[string]any {
	out := map[string]any{}
	var loanID, loanAcct, fdID string
	if items, _, _ := fetchOnePage(ctx, c, "/api/LoanAccount/v1/Search", 1, 1); len(items) > 0 {
		loanID = fmt.Sprint(items[0]["id"])
		loanAcct = fmt.Sprint(items[0]["accountNumber"])
	}
	if items, _, _ := fetchOnePage(ctx, c, "/api/FixedDepositAccount/v1/Search", 1, 1); len(items) > 0 {
		fdID = fmt.Sprint(items[0]["id"])
	}
	out["_sample"] = map[string]any{"loan_id": loanID, "loan_acct": loanAcct, "fd_id": fdID}

	type cand struct {
		path string
		q    url.Values
	}
	qOf := func(k, v string) url.Values { u := url.Values{}; u.Set(k, v); return u }
	cands := []cand{
		{"/api/LoanAccount/v1/Get", qOf("id", loanID)},
		{"/api/LoanAccount/v1/GetById", qOf("id", loanID)},
		{"/api/LoanAccount/v1/Get/" + loanID, nil},
		{"/api/LoanAccount/v1/" + loanID, nil},
		{"/api/LoanAccount/v1/Details", qOf("id", loanID)},
		{"/api/LoanAccount/v1/GetLoanAccount", qOf("id", loanID)},
		{"/api/LoanAccount/v1/Get", qOf("accountNumber", loanAcct)},
		{"/api/LoanAccount/v1/RepaymentSchedule", qOf("id", loanID)},
		{"/api/LoanAccount/v1/RepaymentSchedule", qOf("accountNumber", loanAcct)},
		{"/api/LoanAccount/v1/Schedule", qOf("id", loanID)},
		{"/api/LoanAccount/v1/PaymentSchedule", qOf("accountNumber", loanAcct)},
		{"/api/FixedDepositAccount/v1/Get", qOf("id", fdID)},
		{"/api/FixedDepositAccount/v1/GetById", qOf("id", fdID)},
		{"/api/FixedDepositAccount/v1/Details", qOf("id", fdID)},
	}
	res := map[string]any{}
	for _, cd := range cands {
		label := cd.path
		if len(cd.q) > 0 {
			label += "?" + cd.q.Encode()
		}
		raw, code, err := c.Do(ctx, "GET", cd.path, nil, cd.q)
		r := map[string]any{"http": code}
		switch {
		case err != nil:
			r["error"] = err.Error()
		case code >= 200 && code < 300:
			for k, v := range inspectDetail(raw) {
				r[k] = v
			}
		default:
			r["body_head"] = truncate(raw, 120)
		}
		res[label] = r
	}
	out["detail_probes"] = res
	return out
}

// inspectDetail reports the field names of a detail response's data object and the
// length of any array-typed field (e.g. paymentSchedules) — the tell for a real
// installment schedule.
func inspectDetail(raw json.RawMessage) map[string]any {
	var env envelope
	data := raw
	if json.Unmarshal(raw, &env) == nil && len(env.Data) > 0 {
		data = env.Data
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(data, &obj) != nil {
		return map[string]any{"data_shape": "not-an-object", "len": len(data)}
	}
	keys := make([]string, 0, len(obj))
	arrays := map[string]int{}
	for k, v := range obj {
		keys = append(keys, k)
		tv := bytesTrim(v)
		if len(tv) > 0 && tv[0] == '[' {
			var arr []json.RawMessage
			if json.Unmarshal(v, &arr) == nil {
				arrays[k] = len(arr)
			}
		}
	}
	sort.Strings(keys)
	return map[string]any{"field_count": len(keys), "array_fields": arrays, "fields": keys}
}

func bytesTrim(b []byte) []byte {
	i, j := 0, len(b)
	for i < j && (b[i] == ' ' || b[i] == '\n' || b[i] == '\t' || b[i] == '\r') {
		i++
	}
	return b[i:j]
}

func sortedKeys(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// fetchFullBook fetches every record for a Search endpoint in a single page.
// Udara360's multi-page pagination is unstable (records duplicate across adjacent
// pages while others are dropped), but a page sized to the reported recordCount
// returns the whole book atomically. We size the page to recordCount, then dedupe
// by CBS id as a final safety net.
func fetchFullBook(ctx context.Context, c *udara.Client, path string) ([]map[string]any, error) {
	items, total, err := fetchOnePage(ctx, c, path, 1, defaultPageSize)
	if err != nil {
		return nil, err
	}
	// If the book is bigger than our page, refetch with a page sized to the total.
	if total > len(items) {
		items, _, err = fetchOnePage(ctx, c, path, 1, total+buffer)
		if err != nil {
			return nil, err
		}
	}
	return dedupByID(items), nil
}

// fetchOnePage returns the record array and the CBS-reported recordCount for one page.
func fetchOnePage(ctx context.Context, c *udara.Client, path string, page, size int) ([]map[string]any, int, error) {
	q := url.Values{}
	q.Set("PageNumber", strconv.Itoa(page))
	q.Set("PageSize", strconv.Itoa(size))
	raw, code, err := c.Do(ctx, "GET", path, nil, q)
	if err != nil {
		return nil, 0, fmt.Errorf("cbs fetch %s: %w", path, err)
	}
	if code < 200 || code >= 300 {
		return nil, 0, fmt.Errorf("cbs fetch %s: HTTP %d: %s", path, code, truncate(raw, 300))
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, 0, fmt.Errorf("cbs fetch %s: parse envelope: %w", path, err)
	}
	items, err := extractItems(env.Data)
	if err != nil {
		return nil, 0, fmt.Errorf("cbs fetch %s: parse data: %w; head=%s", path, err, truncate(env.Data, 240))
	}
	return items, recordCountOf(env.Data), nil
}

// recordCountOf reads the total-record count the CBS embeds alongside the data array.
func recordCountOf(data json.RawMessage) int {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return 0
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(trimmed, &obj) != nil {
		return 0
	}
	for _, k := range []string{"recordCount", "totalCount", "totalRecords", "total", "count"} {
		if v, ok := obj[k]; ok {
			var n int
			if json.Unmarshal(v, &n) == nil {
				return n
			}
		}
	}
	return 0
}

func dedupByID(items []map[string]any) []map[string]any {
	seen := make(map[string]bool, len(items))
	out := make([]map[string]any, 0, len(items))
	for _, m := range items {
		k := recordKey(m)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, m)
	}
	return out
}

// recordKey identifies a CBS record for de-duplication (id GUID, else account number).
func recordKey(m map[string]any) string {
	if id := gstr(m, "id"); id != "" {
		return id
	}
	if a := gstr(m, "accountNumber"); a != "" {
		return "acct:" + a
	}
	return "raw:" + rawOf(m)
}

// ── destructive-refresh guard ────────────────────────────────────────────────
//
// Every snapshot book is refreshed DELETE-then-INSERT inside one transaction, so a fetch
// that returns nothing silently commits an empty book. That is not hypothetical: run 6538
// (2026-08-07 19:52) took loans 66 → 0 and fixed deposits 189 → 0 in a single run and
// stamped itself 'ok'; the book stayed wiped for 62h49m across 3,765 consecutive 'ok'
// runs, and the recovery then committed a one-loan and a one-FD snapshot as successful
// full refreshes. The cause is a silent empty fetch — extractItems returns (nil, nil) when
// `data` is null or carries no array, and recordCountOf returns 0 when the count key is
// missing — so fetchFullBook hands back an empty slice with err == nil.
//
// refreshCBSCustomers was already hardened against exactly this ("we never want a
// transient partial fetch to drop a profile"); the loan and deposit books — the money —
// were not. guardRefresh closes that asymmetry.

// errBookShrank marks a refusal to commit a destructive refresh. It is a distinct
// sentinel so callers that are otherwise best-effort (the schedule refresh) can still
// fail the run loudly instead of warning and reporting 'ok'.
var errBookShrank = errors.New("cbs refresh guard")

// Guard thresholds. A refresh is refused when the book shrinks by more than
// max(minShrinkRows, maxShrinkPct% of the current count) in one run.
//
// 25% / 2 rows is calibrated against this deployment's own history. Across every
// recorded run there have been exactly three shrink events per book: the two 100% wipes
// above, and one legitimate contraction (loans 66 → 63, -4.5%; FDs 189 → 184, -2.6%) when
// accounts were genuinely closed. 25% clears the real shrink by more than 5x and still
// refuses anything resembling a wipe. The absolute floor of 2 rows keeps a small book
// (cbs_products holds 8) from tripping on a one- or two-row change, where a percentage is
// meaningless. A full refresh runs every few minutes, and a book cannot plausibly lose a
// quarter of its accounts in that window.
//
// Overrides (all optional, read per run so they can be changed without a rebuild):
//
//	CBS_SYNC_MAX_SHRINK_PCT    percentage, default 25
//	CBS_SYNC_MIN_SHRINK_ROWS   absolute row floor, default 2
//	CBS_SYNC_ALLOW_SHRINK=1    escape hatch: permit ANY shrink, including to zero, for a
//	                           deliberate purge or re-baseline. Logged at WARN.
const (
	defaultMaxShrinkPct  = 25.0
	defaultMinShrinkRows = 2
)

// guardRefresh reports whether a DELETE+INSERT refresh of `table` with `incoming` rows is
// safe to commit. It must be called inside the refresh transaction, before the DELETE, so
// the count it reads is the count the refresh is about to destroy. Returning an error
// aborts the transaction (nothing is deleted) and propagates out of SyncAll, which records
// cbs_sync_runs.status = 'error' with this message.
//
// It never blocks growth, a steady book, or first population (0 → N).
func guardRefresh(ctx context.Context, tx *sql.Tx, book, table string, incoming int) error {
	var before int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM `+table).Scan(&before); err != nil {
		return fmt.Errorf("cbs refresh %s: count existing rows: %w", book, err)
	}
	if before == 0 || incoming >= before {
		return nil
	}
	if envBool("CBS_SYNC_ALLOW_SHRINK") {
		slog.Warn("cbs refresh shrink allowed by CBS_SYNC_ALLOW_SHRINK",
			"book", book, "before", before, "after", incoming)
		return nil
	}
	if incoming == 0 {
		return fmt.Errorf("%w: %s fetch returned 0 rows while the snapshot holds %d; "+
			"refusing to commit an empty book (set CBS_SYNC_ALLOW_SHRINK=1 to force)",
			errBookShrank, book, before)
	}
	allowed := shrinkAllowance(before)
	if drop := before - incoming; drop > allowed {
		return fmt.Errorf("%w: %s would shrink %d -> %d (-%d rows, %.1f%%), beyond the allowed "+
			"drop of %d; refusing to commit (tune CBS_SYNC_MAX_SHRINK_PCT / CBS_SYNC_MIN_SHRINK_ROWS, "+
			"or set CBS_SYNC_ALLOW_SHRINK=1 to force)",
			errBookShrank, book, before, incoming, drop, float64(drop)*100/float64(before), allowed)
	}
	return nil
}

// shrinkAllowance is the largest row drop tolerated for a book currently holding `before`
// rows: a percentage of the book, with an absolute floor so small books stay workable.
func shrinkAllowance(before int) int {
	byPct := int(float64(before) * envFloat("CBS_SYNC_MAX_SHRINK_PCT", defaultMaxShrinkPct) / 100)
	if floor := envInt("CBS_SYNC_MIN_SHRINK_ROWS", defaultMinShrinkRows); byPct < floor {
		return floor
	}
	return byPct
}

func envBool(key string) bool {
	b, err := strconv.ParseBool(strings.TrimSpace(os.Getenv(key)))
	return err == nil && b
}

func envFloat(key string, def float64) float64 {
	if f, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(key)), 64); err == nil && f >= 0 {
		return f
	}
	return def
}

func envInt(key string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key))); err == nil && n >= 0 {
		return n
	}
	return def
}

// countKeyed counts the distinct non-empty values of `key` across fetched records — i.e.
// the number of rows the refresh will actually insert, since records without a key are
// skipped and same-key records collapse on the unique index. Counting what lands (rather
// than len(rows)) keeps the guard honest when a fetch returns structurally empty records.
func countKeyed(rows []map[string]any, key string) int {
	seen := make(map[string]struct{}, len(rows))
	for _, m := range rows {
		if v := gstr(m, key); v != "" {
			seen[v] = struct{}{}
		}
	}
	return len(seen)
}

// ── table refreshers ─────────────────────────────────────────────────────────

func refreshProducts(ctx context.Context, tx *sql.Tx, rows []map[string]any) error {
	if err := guardRefresh(ctx, tx, "products", "cbs_products", countKeyed(rows, "code")); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM cbs_products`); err != nil {
		return fmt.Errorf("cbs refresh products: clear: %w", err)
	}
	const q = `INSERT INTO cbs_products
	    (code, name, type, category, interest_rate, tenure, status, raw, synced_at)
	    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, NOW())
	    ON CONFLICT (code) DO NOTHING`
	for _, m := range rows {
		code := gstr(m, "code")
		if code == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, q,
			code, gstr(m, "name"), gstr(m, "type"), gstr(m, "category"),
			gnum(m, "interestRate"), gint(m, "tenure"), gstr(m, "status"), rawOf(m),
		); err != nil {
			return fmt.Errorf("cbs refresh products: insert %s: %w", code, err)
		}
	}
	return nil
}

func refreshLoans(ctx context.Context, tx *sql.Tx, rows []map[string]any) error {
	if err := guardRefresh(ctx, tx, "loans", "cbs_loans", countKeyed(rows, "id")); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM cbs_loans`); err != nil {
		return fmt.Errorf("cbs refresh loans: clear: %w", err)
	}
	const q = `INSERT INTO cbs_loans
	    (cbs_id, cbs_account_number, cbs_customer_id, linked_account, product_code, product_name, status,
	     loan_amount_kobo, outstanding_principal_kobo, outstanding_interest_kobo, outstanding_fee_kobo,
	     interest_rate, tenor_days, start_date, maturity_date, officer_name,
	     economic_sector, branch_name, reference_number, installment_amount_kobo, approved_date, date_booked,
	     collateral_type, collateral_description, collateral_valuation_kobo, ledger_balance_kobo,
	     interest_frequency, lending_model, first_installment_date,
	     raw, synced_at)
	    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
	            $23,$24,$25,$26,$27,$28,$29,$30::jsonb, NOW())
	    ON CONFLICT (cbs_id) DO UPDATE SET
	        cbs_account_number = EXCLUDED.cbs_account_number,
	        cbs_customer_id = EXCLUDED.cbs_customer_id, linked_account = EXCLUDED.linked_account,
	        product_code = EXCLUDED.product_code, product_name = EXCLUDED.product_name, status = EXCLUDED.status,
	        loan_amount_kobo = EXCLUDED.loan_amount_kobo, outstanding_principal_kobo = EXCLUDED.outstanding_principal_kobo,
	        outstanding_interest_kobo = EXCLUDED.outstanding_interest_kobo, outstanding_fee_kobo = EXCLUDED.outstanding_fee_kobo,
	        interest_rate = EXCLUDED.interest_rate, tenor_days = EXCLUDED.tenor_days,
	        start_date = EXCLUDED.start_date, maturity_date = EXCLUDED.maturity_date,
	        officer_name = EXCLUDED.officer_name,
	        economic_sector = EXCLUDED.economic_sector, branch_name = EXCLUDED.branch_name,
	        reference_number = EXCLUDED.reference_number, installment_amount_kobo = EXCLUDED.installment_amount_kobo,
	        approved_date = EXCLUDED.approved_date, date_booked = EXCLUDED.date_booked,
	        collateral_type = EXCLUDED.collateral_type, collateral_description = EXCLUDED.collateral_description,
	        collateral_valuation_kobo = EXCLUDED.collateral_valuation_kobo, ledger_balance_kobo = EXCLUDED.ledger_balance_kobo,
	        interest_frequency = EXCLUDED.interest_frequency, lending_model = EXCLUDED.lending_model,
	        first_installment_date = EXCLUDED.first_installment_date,
	        raw = EXCLUDED.raw, synced_at = NOW()`
	for _, m := range rows {
		id := gstr(m, "id")
		if id == "" {
			continue
		}
		// date_booked = the genuine origination date. Udara's dateCreated is the
		// import timestamp, so use approvedDate (== startDate) and fall back to
		// startDate if approval is ever missing.
		booked := gts(m, "approvedDate")
		if !booked.Valid {
			booked = gts(m, "startDate")
		}
		if _, err := tx.ExecContext(ctx, q,
			id, gstr(m, "accountNumber"), gstr(m, "customerID"), gstr(m, "linkedNumber"),
			gstr(m, "productCode"), gstr(m, "productName"), gstr(m, "accountStatus"),
			gkobo(m, "loanAmount"), gkobo(m, "outstandingLoanPrincipal"),
			gkobo(m, "outstandingLoanInterest"), gkobo(m, "outstandingLoanFee"),
			gnum(m, "applicableInterestRate"), gint(m, "tenure"),
			gts(m, "startDate"), gts(m, "maturityDate"), gstr(m, "accountOfficerName"),
			gstr(m, "economicSector"), gstr(m, "branchName"), gstr(m, "referenceNumber"),
			gkobo(m, "installmentAmount"), gts(m, "approvedDate"), booked,
			gstr(m, "collateralType"), gstr(m, "collateralDescription"),
			gkobo(m, "collateralValuation"), gkobo(m, "ledgerBalance"),
			gstr(m, "interestFrequency"), gstr(m, "lendingModel"), gts(m, "firstInstallmentDate"),
			rawOf(m),
		); err != nil {
			return fmt.Errorf("cbs refresh loans: insert %s: %w", id, err)
		}
	}
	return nil
}

func refreshFDs(ctx context.Context, tx *sql.Tx, rows []map[string]any) error {
	if err := guardRefresh(ctx, tx, "fixed deposits", "cbs_fixed_deposits", countKeyed(rows, "id")); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM cbs_fixed_deposits`); err != nil {
		return fmt.Errorf("cbs refresh fds: clear: %w", err)
	}
	const q = `INSERT INTO cbs_fixed_deposits
	    (cbs_id, cbs_account_number, cbs_customer_id, product_code, product_name, status,
	     principal_kobo, accrued_interest_kobo, ledger_balance_kobo, interest_rate, tenor_days,
	     commencement_date, maturity_date, liquidation_account,
	     reference_number, branch_name, rollover_count, date_booked, officer_name,
	     raw, synced_at)
	    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb, NOW())
	    ON CONFLICT (cbs_id) DO UPDATE SET
	        cbs_account_number = EXCLUDED.cbs_account_number, cbs_customer_id = EXCLUDED.cbs_customer_id,
	        product_code = EXCLUDED.product_code, product_name = EXCLUDED.product_name, status = EXCLUDED.status,
	        principal_kobo = EXCLUDED.principal_kobo, accrued_interest_kobo = EXCLUDED.accrued_interest_kobo,
	        ledger_balance_kobo = EXCLUDED.ledger_balance_kobo, interest_rate = EXCLUDED.interest_rate,
	        tenor_days = EXCLUDED.tenor_days, commencement_date = EXCLUDED.commencement_date,
	        maturity_date = EXCLUDED.maturity_date, liquidation_account = EXCLUDED.liquidation_account,
	        reference_number = EXCLUDED.reference_number, branch_name = EXCLUDED.branch_name,
	        rollover_count = EXCLUDED.rollover_count, date_booked = EXCLUDED.date_booked,
	        officer_name = EXCLUDED.officer_name,
	        raw = EXCLUDED.raw, synced_at = NOW()`
	for _, m := range rows {
		id := gstr(m, "id")
		if id == "" {
			continue
		}
		// date_booked = commencementDate (when the deposit actually started), not
		// Udara's dateCreated (the import timestamp).
		if _, err := tx.ExecContext(ctx, q,
			id, gstr(m, "accountNumber"), gstr(m, "customerID"), gstr(m, "productCode"), gstr(m, "productName"),
			gstr(m, "accountStatus"), gkobo(m, "principalAmount"), gkobo(m, "accruedInterest"),
			gkobo(m, "ledgerBalance"), gnum(m, "applicableInterestRate"), gint(m, "tenure"),
			gts(m, "commencementDate"), gts(m, "maturityDate"), gstr(m, "liquidationAccount"),
			gstr(m, "referenceNumber"), gstr(m, "branchName"), gint(m, "rolloverCount"),
			gts(m, "commencementDate"),
			// Officer stored VERBATIM, exactly as cbs_loans.officer_name above: 7 of
			// the 21 app.cbs_officer_map rows carry a trailing space because Udara
			// sends them that way. btrim()-ing here would write names the map no
			// longer matches (173 of 380 deposits would silently lose attribution).
			// Consumers btrim BOTH sides of the join instead.
			gstr(m, "accountOfficerName"), rawOf(m),
		); err != nil {
			return fmt.Errorf("cbs refresh fds: insert %s: %w", id, err)
		}
	}
	return nil
}

// syncLoanSchedules pulls each non-closed loan's repayment schedule from
// GET /api/LoanAccount/v1/viewloanschedule (the loan Search feed returns
// paymentSchedules null — only this per-loan endpoint fills it) and snapshots the
// installments into app.cbs_loan_schedules. Per-installment `interest` is the loan-side
// revenue: earned once has_processed, expected/scheduled by payment_date otherwise.
// Amounts arrive already in kobo; payment_date is the installment value date.
func syncLoanSchedules(ctx context.Context, c *udara.Client, db *core.DB, loans []map[string]any) (int, error) {
	type inst struct {
		acct, cif, status, intID string
		payDate                  sql.NullTime
		prin, intk, fee          sql.NullInt64
		processed                bool
	}
	var rows []inst
	for _, l := range loans {
		acct := gstr(l, "accountNumber")
		status := gstr(l, "accountStatus")
		if acct == "" || status == "Closed" || status == "Revoked" {
			continue
		}
		q := url.Values{}
		q.Set("AccountNumber", acct)
		raw, code, err := c.Do(ctx, "GET", "/api/LoanAccount/v1/viewloanschedule", nil, q)
		if err != nil || code < 200 || code >= 300 {
			continue
		}
		var env envelope
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		var obj map[string]any
		if json.Unmarshal(env.Data, &obj) != nil {
			continue
		}
		cif := gstr(obj, "customerID")
		scheds, _ := obj["paymentSchedules"].([]any)
		for _, s := range scheds {
			sm, ok := s.(map[string]any)
			if !ok {
				continue
			}
			pd := gts(sm, "paymentDate_Date")
			if !pd.Valid {
				continue
			}
			processed, _ := sm["hasProcessed"].(bool)
			rows = append(rows, inst{
				acct: acct, cif: cif, status: gstr(sm, "paymentStatus"), intID: gstr(sm, "interestID"),
				payDate: pd, prin: gkobo(sm, "principal"), intk: gkobo(sm, "interest"), fee: gkobo(sm, "fee"),
				processed: processed,
			})
		}
	}

	// Atomic snapshot swap: clear + re-insert in one tx so readers never see a half-empty
	// schedule table.
	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() //nolint:errcheck
	// Same destructive-refresh guard as the loan/FD books: installments are the loan-side
	// revenue, and a run where every per-loan schedule fetch failed would otherwise clear
	// the table and report success. Rows collapse on (loan_account_number, payment_date),
	// so that pair is what the guard counts.
	incoming := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		incoming[r.acct+"|"+r.payDate.Time.Format(time.RFC3339)] = struct{}{}
	}
	if err := guardRefresh(ctx, tx, "loan schedules", "app.cbs_loan_schedules", len(incoming)); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM app.cbs_loan_schedules`); err != nil {
		return 0, err
	}
	for _, r := range rows {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO app.cbs_loan_schedules
			    (loan_account_number, cbs_customer_id, payment_date, principal_kobo, interest_kobo, fee_kobo,
			     payment_status, has_processed, interest_id, synced_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
			ON CONFLICT (loan_account_number, payment_date) DO UPDATE SET
			    cbs_customer_id = EXCLUDED.cbs_customer_id, principal_kobo = EXCLUDED.principal_kobo,
			    interest_kobo = EXCLUDED.interest_kobo, fee_kobo = EXCLUDED.fee_kobo,
			    payment_status = EXCLUDED.payment_status, has_processed = EXCLUDED.has_processed,
			    interest_id = EXCLUDED.interest_id, synced_at = NOW()`,
			r.acct, r.cif, r.payDate, r.prin, r.intk, r.fee, r.status, r.processed, r.intID); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(rows), nil
}

// ── field extraction helpers (Udara returns numbers as JSON floats or strings) ─

func gstr(m map[string]any, k string) string {
	v, ok := m[k]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// gkobo returns an integer minor-unit (kobo) amount.
func gkobo(m map[string]any, k string) sql.NullInt64 {
	v, ok := m[k]
	if !ok || v == nil {
		return sql.NullInt64{}
	}
	switch t := v.(type) {
	case float64:
		return sql.NullInt64{Int64: int64(t), Valid: true}
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return sql.NullInt64{}
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return sql.NullInt64{Int64: int64(f), Valid: true}
		}
	}
	return sql.NullInt64{}
}

// gbool returns a nullable boolean (e.g. the PEP flag).
func gbool(m map[string]any, k string) sql.NullBool {
	v, ok := m[k]
	if !ok || v == nil {
		return sql.NullBool{}
	}
	switch t := v.(type) {
	case bool:
		return sql.NullBool{Bool: t, Valid: true}
	case string:
		if b, err := strconv.ParseBool(strings.TrimSpace(t)); err == nil {
			return sql.NullBool{Bool: b, Valid: true}
		}
	}
	return sql.NullBool{}
}

// gnum returns a decimal (rates).
func gnum(m map[string]any, k string) sql.NullFloat64 {
	v, ok := m[k]
	if !ok || v == nil {
		return sql.NullFloat64{}
	}
	switch t := v.(type) {
	case float64:
		return sql.NullFloat64{Float64: t, Valid: true}
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return sql.NullFloat64{}
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return sql.NullFloat64{Float64: f, Valid: true}
		}
	}
	return sql.NullFloat64{}
}

// gint returns an integer (tenure/day counts).
func gint(m map[string]any, k string) sql.NullInt64 {
	v, ok := m[k]
	if !ok || v == nil {
		return sql.NullInt64{}
	}
	switch t := v.(type) {
	case float64:
		return sql.NullInt64{Int64: int64(t), Valid: true}
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return sql.NullInt64{}
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return sql.NullInt64{Int64: int64(f), Valid: true}
		}
	}
	return sql.NullInt64{}
}

// gts parses Udara timestamps, which come without a timezone (or empty).
func gts(m map[string]any, k string) sql.NullTime {
	s := strings.TrimSpace(gstr(m, k))
	if s == "" {
		return sql.NullTime{}
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02",
	} {
		if tt, err := time.Parse(layout, s); err == nil {
			return sql.NullTime{Time: tt, Valid: true}
		}
	}
	return sql.NullTime{}
}

// extractItems pulls the record array out of a Udara "data" value, which may be a
// bare array ([...]) or an object that wraps the array under a nested field
// ({"data":[...], "totalCount":N}). Returns nil (no error) when no array is found.
func extractItems(data json.RawMessage) ([]map[string]any, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}
	switch trimmed[0] {
	case '[':
		var items []map[string]any
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return nil, err
		}
		return items, nil
	case '{':
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &obj); err != nil {
			return nil, err
		}
		// Prefer conventionally-named collection fields.
		for _, k := range []string{"data", "items", "records", "result", "list"} {
			if v, ok := obj[k]; ok {
				if it, err := extractItems(v); err == nil && it != nil {
					return it, nil
				}
			}
		}
		// Otherwise take the first array-valued field.
		for _, v := range obj {
			tv := bytes.TrimSpace(v)
			if len(tv) > 0 && tv[0] == '[' {
				var items []map[string]any
				if err := json.Unmarshal(tv, &items); err == nil {
					return items, nil
				}
			}
		}
	}
	return nil, nil
}

func rawOf(m map[string]any) string {
	b, err := json.Marshal(m)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func truncate(b []byte, n int) string {
	s := string(b)
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}
