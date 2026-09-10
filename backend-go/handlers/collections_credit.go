package handlers

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// Collections credit dossier — everything about the credit behind one account.
//
// The old /accounts/{cif} snapshot answered "how delinquent is this CIF?" with a
// single aggregated number. That hid the two things a collections officer actually
// needs: WHICH facilities make up the exposure (a person can hold many cards and
// several loans — ABIMBOLA PINHEIRO carries 21 CIFs), and, for each one, the
// repayment schedule with how much of every instalment has actually been paid.
//
// It also disagreed with Customer 360 about who the customer even is: the
// collections book carries its own uploaded name ("ONAH KENECHUKWU") while the
// customer master holds the canonical one ("Kenechukwu Onah", party 11537). This
// endpoint resolves identity through the SAME party layer C360 uses, so the two
// pages cannot disagree, and then reports every facility that person holds — not
// only the one CIF the assignment happens to be filed under.
//
// UNITS: everything leaving here is KOBO. The card book (app.accounts) and
// core.transaction are NAIRA numerics and are converted on the way out;
// app.card_cycle_data, cbs_loans and collection_payments are already kobo.
// ─────────────────────────────────────────────────────────────────────────────

// schedRow is one instalment / billing period on a facility.
type schedRow struct {
	N          int     `json:"n"`
	DueDate    string  `json:"due_date"`
	Label      string  `json:"label"`
	PrincipalK int64   `json:"principal_kobo"`
	InterestK  int64   `json:"interest_kobo"`
	FeeK       int64   `json:"fee_kobo"`
	DueK       int64   `json:"due_kobo"`
	PaidK      int64   `json:"paid_kobo"`
	PaidPct    float64 `json:"paid_pct"`
	// Days from today to the due date: positive = still to come, negative = past due,
	// 0 = due today. Null-safe via DaysKnown, since cycle rows have no contractual date.
	DaysToDue  int     `json:"days_to_due"`
	DaysKnown  bool    `json:"days_known"`
	Status     string  `json:"status"` // paid | partial | overdue | due | upcoming
	Source     string  `json:"source"` // udara | derived | cycle
}

// facility is one credit line (a card or a loan) held by the customer.
type facility struct {
	Key       string `json:"key"`
	Kind      string `json:"kind"`   // card | loan
	Origin    string `json:"origin"` // CCS | Udara | Uploaded
	CIF       string `json:"cif"`
	Ref       string `json:"ref"`
	Product   string `json:"product"`
	Status    string `json:"status"`
	IsSubject bool   `json:"is_subject"` // belongs to the CIF this page was opened on

	LimitK       int64   `json:"limit_kobo"`
	PrincipalK   int64   `json:"principal_kobo"`
	OutstandingK int64   `json:"outstanding_kobo"`
	MinPaymentK  int64   `json:"min_payment_kobo"`
	InstalmentK  int64   `json:"instalment_kobo"`
	Utilisation  float64 `json:"utilisation"`
	DPD          int     `json:"dpd"`

	Rate      string `json:"rate"`
	Tenor     string `json:"tenor"`
	DebitDay  string `json:"debit_day"`
	Officer   string `json:"officer_name"`
	Guarantor string `json:"guarantor_name"`

	OpenedDate    string `json:"opened_date"`
	MaturityDate  string `json:"maturity_date"`
	NextDueDate   string `json:"next_due_date"`
	LastPaymentAt string `json:"last_payment_date"`
	LastPaymentK  int64  `json:"last_payment_kobo"`

	// Card extras
	PANMasked string `json:"pan_masked"`
	Expiry    string `json:"expiry_date"`
	CycleBalK int64  `json:"cycle_balance_kobo"`

	// Loan extras
	CollateralType string `json:"collateral_type"`
	CollateralK    int64  `json:"collateral_valuation_kobo"`
	Sector         string `json:"economic_sector"`
	Branch         string `json:"branch_name"`
	AlsoInUdara    bool   `json:"also_in_udara"` // uploaded mirror of a core-banking loan

	ScheduledK   int64      `json:"scheduled_kobo"` // total of the schedule
	ExpectedK    int64      `json:"expected_kobo"`  // scheduled and already due
	PaidK        int64      `json:"paid_kobo"`      // matched against the schedule
	PaidPct      float64    `json:"paid_pct"`       // paid / scheduled
	ArrearsK     int64      `json:"arrears_kobo"`   // expected − paid, floored at 0
	Schedule     []schedRow `json:"schedule"`
	ScheduleNote string     `json:"schedule_note"`
}

// repayment is one money-in event, from any source.
type repayment struct {
	Date        string `json:"date"`
	AmountK     int64  `json:"amount_kobo"`
	Channel     string `json:"channel"`
	Reference   string `json:"reference"`
	Source      string `json:"source"` // collections | card
	FacilityKey string `json:"facility_key"`
	ReceivedBy  string `json:"received_by"`
	Status      string `json:"status"`
}

func cdNairaKobo(v any) int64 {
	f := toFloat64(v)
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return int64(math.Round(f * 100))
}

func cdDate(v any) string {
	s := str(v)
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}

func cdPct(num, den int64) float64 {
	if den <= 0 {
		return 0
	}
	return math.Round(float64(num)/float64(den)*10000) / 100
}

// collectionsCreditDossier is the whole credit file behind one collections account.
func collectionsCreditDossier(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		cif := strings.TrimSpace(chi.URLParam(r, "cif"))
		if cif == "" {
			respondErr(w, 400, "CIF is required")
			return
		}

		// ── 1. Identity, resolved exactly the way Customer 360 resolves it ──────
		// The party layer is the join: every id (card CIF or workspace id) belonging
		// to the same person. Falls back to the bare CIF when the account has no
		// customer-master row at all (7 collections accounts are in that state).
		// NOTE: select only columns that exist. This query silently returned NOTHING
		// for weeks because it asked for c.employer (the column is job_title), which
		// left every Credit File without a party, a name or contact details — the
		// "W…" id and blank customer block both traced back to here.
		idRows, err := db.PGQuery(ctx, `
			WITH me AS (
			    SELECT party_id FROM app.customers
			     WHERE COALESCE(NULLIF(cif,''), contact_id) = $1 LIMIT 1
			)
			SELECT COALESCE(NULLIF(c.cif,''), c.contact_id) AS id,
			       c.cif AS card_cif, c.party_id, c.full_name, c.phone, c.email,
			       c.bvn, c.full_address, c.address_1, c.city, c.state, c.country,
			       c.job_title AS employer, c.birthday::text AS date_of_birth, c.gender,
			       c.account_status
			  FROM app.customers c, me
			 WHERE me.party_id IS NOT NULL AND c.party_id = me.party_id
			UNION ALL
			SELECT COALESCE(NULLIF(c.cif,''), c.contact_id), c.cif, c.party_id, c.full_name,
			       c.phone, c.email, c.bvn, c.full_address, c.address_1, c.city, c.state, c.country,
			       c.job_title AS employer, c.birthday::text AS date_of_birth, c.gender,
			       c.account_status
			  FROM app.customers c
			 WHERE COALESCE(NULLIF(c.cif,''), c.contact_id) = $1
			   AND c.party_id IS NULL`, cif)
		if err != nil {
			respondErrLog(w, 500, "Could not resolve the customer", err)
			return
		}

		ids := map[string]bool{cif: true}
		cardCIFs := map[string]bool{}
		var partyID int64
		var name, phone, email, bvn, address, addr1, city, state, country string
		var employer, dob, gender, acctStatus string
		for _, row := range idRows {
			if id := str(row["id"]); id != "" {
				ids[id] = true
			}
			if cc := str(row["card_cif"]); cc != "" {
				cardCIFs[cc] = true
			}
			if partyID == 0 {
				partyID = toInt64(row["party_id"])
			}
			cdFill(&name, row["full_name"])
			cdFill(&phone, row["phone"])
			cdFill(&email, row["email"])
			cdFill(&bvn, row["bvn"])
			cdFill(&address, row["full_address"])
			cdFill(&addr1, row["address_1"])
			cdFill(&city, row["city"])
			cdFill(&state, row["state"])
			cdFill(&country, row["country"])
			cdFill(&employer, row["employer"])
			cdFill(&dob, row["date_of_birth"])
			cdFill(&gender, row["gender"])
			cdFill(&acctStatus, row["account_status"])
		}
		idList := make([]string, 0, len(ids))
		for k := range ids {
			idList = append(idList, k)
		}
		sort.Strings(idList)

		// Fall back to the collections book's own name only when the customer master
		// has none — never in preference to it, so this page and C360 always render
		// the same person under the same name.
		if name == "" {
			if nr, _ := db.PGQuery(ctx, `
				SELECT MAX(customer_name) AS n FROM collection_assignments
				 WHERE account_cif = ANY($1)`, idList); len(nr) > 0 {
				name = str(nr[0]["n"])
			}
		}
		if name == "" {
			name = cif
		}
		// The Customer ID is the canonical id. When the party layer cannot resolve one,
		// fall back to the account key only if that key is a REAL cif — never to a W…/Z…
		// internal handle, which must not be presented as an identifier.
		customerID := ""
		switch {
		case partyID > 0:
			customerID = fmt.Sprintf("CUST-%06d", partyID)
		case !isSyntheticID(cif):
			customerID = cif
		}
		// Only three identifiers are ever shown: the Customer ID, the card CIFs, and
		// the Udara customer/loan ids. The W…/Z… handles in account_cif are internal
		// keys minted for borrowers with no card — they are not CIFs and must never be
		// printed as one. hasCIF says whether this customer holds a card at all.
		visibleCIFs := make([]string, 0, len(cardCIFs))
		for k := range cardCIFs {
			if !isSyntheticID(k) {
				visibleCIFs = append(visibleCIFs, k)
			}
		}
		sort.Strings(visibleCIFs)

		udaraCustomers := make([]string, 0)
		udaraAccounts := make([]string, 0)
		if ur, _ := db.PGQuery(ctx, `
			SELECT DISTINCT cl.cbs_customer_id, cl.cbs_account_number
			  FROM cbs_loans cl
			 WHERE cl.cbs_customer_id IN (
			     SELECT k.cbs_customer_id FROM app.cbs_links k
			      WHERE k.entity_type = 'party' AND k.entity_id = $1)
			   AND cl.status NOT IN ('Closed','Revoked')
			 ORDER BY 1, 2`, partyID); ur != nil {
			seen := map[string]bool{}
			for _, row := range ur {
				if v := str(row["cbs_customer_id"]); v != "" && !seen[v] {
					seen[v] = true
					udaraCustomers = append(udaraCustomers, v)
				}
				if v := str(row["cbs_account_number"]); v != "" {
					udaraAccounts = append(udaraAccounts, v)
				}
			}
		}

		// ── 2. Repayments — every money-in event across all the person's ids ────
		// CIF-keyed, deliberately: 1,721 of the 1,798 collection_payments rows carry
		// no assignment_id (the historical and CRM imports), and the assignment-keyed
		// payments list this page used to show could not see a single one of them.
		payRows, _ := db.PGQuery(ctx, `
			SELECT p.id, p.account_cif, p.amount_kobo, p.payment_date::text AS payment_date,
			       COALESCE(p.channel,'')   AS channel,
			       COALESCE(p.reference,'') AS reference,
			       COALESCE(p.status,'')    AS status,
			       COALESCE(u.full_name,'') AS received_by
			  FROM collection_payments p
			  LEFT JOIN o3c_users u ON u.id = p.received_by
			 WHERE p.account_cif = ANY($1)
			 ORDER BY p.payment_date DESC, p.id DESC`, idList)

		repayments := make([]repayment, 0, len(payRows))
		byCIFPays := map[string][]repayment{}
		for _, p := range payRows {
			rp := repayment{
				Date:       cdDate(p["payment_date"]),
				AmountK:    toInt64(p["amount_kobo"]),
				Channel:    str(p["channel"]),
				Reference:  str(p["reference"]),
				Source:     "collections",
				ReceivedBy: str(p["received_by"]),
				Status:     str(p["status"]),
			}
			repayments = append(repayments, rp)
			c := str(p["account_cif"])
			byCIFPays[c] = append(byCIFPays[c], rp)
		}

		// Card repayments straight off the card ledger (money_in credits). These are
		// what the customer actually paid the card, independent of what collections
		// logged, so both stories are visible side by side.
		cardPayRows, _ := db.PGQuery(ctx, `
			SELECT t.cif, t.account_id, t.txn_date::text AS txn_date, t.amount_credit,
			       COALESCE(t.description,'') AS description, COALESCE(t.txn_code,'') AS txn_code
			  FROM core.transaction t
			 WHERE t.cif = ANY($1) AND t.money_in = true AND COALESCE(t.amount_credit,0) > 0
			 ORDER BY t.txn_date DESC
			 LIMIT 500`, idList)
		for _, t := range cardPayRows {
			repayments = append(repayments, repayment{
				Date:        cdDate(t["txn_date"]),
				AmountK:     cdNairaKobo(t["amount_credit"]),
				Channel:     str(t["description"]),
				Reference:   str(t["txn_code"]),
				Source:      "card",
				FacilityKey: "card:" + str(t["account_id"]),
				Status:      "posted",
			})
		}
		sort.SliceStable(repayments, func(i, j int) bool { return repayments[i].Date > repayments[j].Date })

		facilities := make([]facility, 0, 8)

		// ── 3a. Cards ──────────────────────────────────────────────────────────
		cardRows, _ := db.PGQuery(ctx, `
			SELECT a.account_id, a.account_no, a.cif, COALESCE(a.card_pan,'') AS card_pan,
			       COALESCE(NULLIF(a.product_name,''), 'Card') AS product_name,
			       COALESCE(a.status,'') AS status, a.card_limit, a.current_dr_balance,
			       a.cycle_balance, a.card_utilisation, a.min_payment_due, a.last_amount_paid,
			       a.opened_date::text        AS opened_date,
			       a.last_payment_date::text  AS last_payment_date,
			       a.payment_due_date::text   AS payment_due_date,
			       a.card_expiry_date::text   AS card_expiry_date,
			       COALESCE(a.days_overdue,0) AS days_overdue
			  FROM app.accounts a
			 WHERE a.cif = ANY($1)
			 ORDER BY COALESCE(a.current_dr_balance,0) DESC`, idList)

		for _, c := range cardRows {
			ccif := str(c["cif"])
			f := facility{
				Key:           "card:" + str(c["account_id"]),
				Kind:          "card",
				Origin:        "CCS",
				CIF:           ccif,
				Ref:           str(c["account_no"]),
				Product:       str(c["product_name"]),
				Status:        str(c["status"]),
				IsSubject:     ccif == cif,
				LimitK:        cdNairaKobo(c["card_limit"]),
				OutstandingK:  cdNairaKobo(c["current_dr_balance"]),
				CycleBalK:     cdNairaKobo(c["cycle_balance"]),
				MinPaymentK:   cdNairaKobo(c["min_payment_due"]),
				Utilisation:   toFloat64(c["card_utilisation"]),
				DPD:           int(toInt64(c["days_overdue"])),
				OpenedDate:    cdDate(c["opened_date"]),
				NextDueDate:   cdDate(c["payment_due_date"]),
				LastPaymentAt: cdDate(c["last_payment_date"]),
				LastPaymentK:  cdNairaKobo(c["last_amount_paid"]),
				PANMasked:     cdMaskPAN(str(c["card_pan"])),
				Expiry:        cdDate(c["card_expiry_date"]),
			}
			f.PrincipalK = f.LimitK
			f.Schedule, f.ScheduleNote = cardCycleSchedule(ctx, db, ccif, str(c["account_id"]))
			rollUpFacility(&f)
			facilities = append(facilities, f)
		}

		// ── 3b. Udara (core-banking) loans ─────────────────────────────────────
		loanRows, _ := db.PGQuery(ctx, `
			SELECT cl.cbs_account_number, cl.cbs_customer_id,
			       COALESCE(NULLIF(cl.product_name,''),'Loan') AS product_name,
			       COALESCE(cl.status,'') AS status,
			       COALESCE(cl.loan_amount_kobo,0) AS loan_amount_kobo,
			       (COALESCE(cl.outstanding_principal_kobo,0)
			      + COALESCE(cl.outstanding_interest_kobo,0)
			      + COALESCE(cl.outstanding_fee_kobo,0)) AS outstanding_kobo,
			       COALESCE(cl.interest_rate::text,'')   AS interest_rate,
			       COALESCE(cl.tenor_days::text,'')      AS tenor_days,
			       cl.start_date::text    AS start_date,
			       cl.maturity_date::text AS maturity_date,
			       COALESCE(cl.installment_amount_kobo,0)   AS installment_amount_kobo,
			       COALESCE(cl.officer_name,'')             AS officer_name,
			       COALESCE(cl.collateral_type,'')          AS collateral_type,
			       COALESCE(cl.collateral_valuation_kobo,0) AS collateral_valuation_kobo,
			       COALESCE(cl.economic_sector,'')          AS economic_sector,
			       COALESCE(cl.branch_name,'')              AS branch_name
			  FROM cbs_loans cl
			 -- Udara customer ids live in their OWN namespace and COLLIDE with card CIFs
			 -- (Udara 00000424 is FINTRAK; card CIF 00000424 is Adetunji Taiwo). They must
			 -- be resolved through the curated party crosswalk, never by matching
			 -- cbs_customer_id to an account key — 22 collections accounts would otherwise
			 -- inherit a stranger's loan.
			 WHERE cl.cbs_customer_id IN (
			     SELECT k.cbs_customer_id FROM app.cbs_links k
			      WHERE k.entity_type = 'party' AND k.entity_id = $2)
			 ORDER BY cl.start_date DESC NULLS LAST`, idList, partyID)

		for _, l := range loanRows {
			lcif := str(l["cbs_customer_id"])
			acct := str(l["cbs_account_number"])
			f := facility{
				Key:            "loan:" + acct,
				Kind:           "loan",
				Origin:         "Udara",
				CIF:            lcif,
				Ref:            acct,
				Product:        str(l["product_name"]),
				Status:         str(l["status"]),
				IsSubject:      lcif == cif,
				PrincipalK:     toInt64(l["loan_amount_kobo"]),
				OutstandingK:   toInt64(l["outstanding_kobo"]),
				InstalmentK:    toInt64(l["installment_amount_kobo"]),
				Rate:           str(l["interest_rate"]),
				Tenor:          cdTenorLabel(str(l["tenor_days"])),
				Officer:        str(l["officer_name"]),
				OpenedDate:     cdDate(l["start_date"]),
				MaturityDate:   cdDate(l["maturity_date"]),
				CollateralType: str(l["collateral_type"]),
				CollateralK:    toInt64(l["collateral_valuation_kobo"]),
				Sector:         str(l["economic_sector"]),
				Branch:         str(l["branch_name"]),
			}
			f.Schedule, f.ScheduleNote = udaraSchedule(ctx, db, acct)
			rollUpFacility(&f)
			facilities = append(facilities, f)
		}

		// ── 3c. Uploaded loans (the collections book's own manual facilities) ──
		upRows, _ := db.PGQuery(ctx, `
			SELECT ca.id, ca.account_cif, COALESCE(ca.loan_ref,'') AS loan_ref,
			       COALESCE(ca.status,'') AS status,
			       COALESCE(ca.outstanding_kobo,0)   AS outstanding_kobo,
			       COALESCE(ca.target_amount_kobo,0) AS target_amount_kobo,
			       COALESCE(ca.repayment_kobo,0)     AS repayment_kobo,
			       COALESCE(ca.loan_tenor,'')     AS loan_tenor,
			       COALESCE(ca.loan_rate,'')      AS loan_rate,
			       COALESCE(ca.debit_day,'')      AS debit_day,
			       ca.disbursement_date::text     AS disbursement_date,
			       ca.maturity_date::text         AS maturity_date,
			       COALESCE(ca.officer_name,'')   AS officer_name,
			       COALESCE(ca.guarantor_name,'') AS guarantor_name,
			       ca.superseded_by_id,
			       -- outstanding_kobo is NET of receipts since migration 222; the loan's
			       -- own size is the approved amount, and that is what the waterfall
			       -- draws against.
			       COALESCE(ca.target_amount_kobo, ca.original_outstanding_kobo, ca.outstanding_kobo, 0) AS approved_kobo
			  FROM collection_assignments ca
			 WHERE ca.account_cif = ANY($1)
			   AND ca.data_source = 'manual' AND ca.product_type = 'loan'
			   -- Closed loans are shown too: a settled facility is part of the credit
			   -- history an officer needs on a call, and it carries zero outstanding so
			   -- it cannot inflate the exposure.
			 -- OLDEST first: this is the order receipts are run down the customer's
			 -- loans below, and the Credit Portfolio allocates in the same order so the
			 -- two pages report the same paydown. Display order is set later.
			 ORDER BY ca.disbursement_date ASC NULLS LAST, ca.id ASC`, idList)

		// Several uploaded loans can sit on one CIF. Settle them in book order and
		// let each consume from the shared payment pool once, so the same naira is
		// never counted against two loans.
		poolByCIF := map[string][]int64{}
		for c, ps := range byCIFPays {
			sort.SliceStable(ps, func(i, j int) bool { return ps[i].Date < ps[j].Date })
			amts := make([]int64, 0, len(ps))
			for _, p := range ps {
				amts = append(amts, p.AmountK)
			}
			poolByCIF[c] = amts
		}

		// What the derived schedules were given to settle, so any surplus can be
		// reported rather than silently dropped (a CIF that has repaid more than its
		// uploaded schedule is a restructure or a mis-stated tenor — the officer
		// needs to see that money, not lose it).
		derivedPool := map[string]int64{}

		for _, l := range upRows {
			lcif := str(l["account_cif"])
			ref := str(l["loan_ref"])
			if ref == "" {
				ref = "Uploaded loan #" + str(l["id"])
			}
			f := facility{
				Key:          "uploaded:" + str(l["id"]),
				Kind:         "loan",
				Origin:       "Uploaded",
				CIF:          lcif,
				Ref:          ref,
				Product:      "Loan (uploaded)",
				Status:       str(l["status"]),
				IsSubject:    lcif == cif,
				PrincipalK:   toInt64(l["approved_kobo"]),
				OutstandingK: toInt64(l["outstanding_kobo"]),
				InstalmentK:  toInt64(l["repayment_kobo"]),
				Rate:         str(l["loan_rate"]),
				Tenor:        str(l["loan_tenor"]),
				DebitDay:     str(l["debit_day"]),
				Officer:      str(l["officer_name"]),
				Guarantor:    str(l["guarantor_name"]),
				OpenedDate:   cdDate(l["disbursement_date"]),
				MaturityDate: cdDate(l["maturity_date"]),
			}
			if _, seen := derivedPool[lcif]; !seen {
				for _, a := range poolByCIF[lcif] {
					derivedPool[lcif] += a
				}
			}
			f.Schedule, f.ScheduleNote, poolByCIF[lcif] = derivedLoanSchedule(f, poolByCIF[lcif])
			// A superseded row still draws its own receipts out of the pool — otherwise
			// its successor would be credited with money that repaid the OLD loan — but
			// it is history, not a second facility, so it is not shown.
			if toInt64(l["superseded_by_id"]) > 0 {
				continue
			}
			rollUpFacility(&f)
			facilities = append(facilities, f)
		}

		// An uploaded loan whose debt is also booked in Udara is a mirror of the core
		// record, not extra exposure. Flag it here exactly as the Credit Portfolio does.
		udaraCIF := map[string]bool{}
		for _, f := range facilities {
			if f.Origin == "Udara" {
				udaraCIF[f.CIF] = true
			}
		}
		for i := range facilities {
			if facilities[i].Origin == "Uploaded" && udaraCIF[facilities[i].CIF] {
				facilities[i].AlsoInUdara = true
			}
		}

		// The subject CIF's own facilities lead; then by exposure.
		sort.SliceStable(facilities, func(i, j int) bool {
			if facilities[i].IsSubject != facilities[j].IsSubject {
				return facilities[i].IsSubject
			}
			return facilities[i].OutstandingK > facilities[j].OutstandingK
		})

		// ── 4. Totals ──────────────────────────────────────────────────────────
		var exposure, scheduled, expected, schedPaid, limit int64
		var nextDue string
		var nextDueK int64
		today := time.Now().Format("2006-01-02")
		for _, f := range facilities {
			exposure += f.OutstandingK
			scheduled += f.ScheduledK
			expected += f.ExpectedK
			schedPaid += f.PaidK
			limit += f.LimitK
			for _, s := range f.Schedule {
				if s.DueDate >= today && s.Status != "paid" && (nextDue == "" || s.DueDate < nextDue) {
					nextDue, nextDueK = s.DueDate, s.DueK-s.PaidK
				}
			}
		}
		var totalPaid int64
		for _, rp := range repayments {
			if rp.Source == "collections" {
				totalPaid += rp.AmountK
			}
		}
		arrears := expected - schedPaid
		if arrears < 0 {
			arrears = 0
		}

		// Money received on a CIF that its uploaded schedules could not absorb.
		var unallocated int64
		for c, pooled := range derivedPool {
			var absorbed int64
			for _, f := range facilities {
				if f.CIF == c && f.Origin == "Uploaded" {
					absorbed += f.PaidK
				}
			}
			if d := pooled - absorbed; d > 0 {
				unallocated += d
			}
		}

		// ── 4b. Every way to reach this customer ───────────────────────────────
		// One person can hold several card records, each carrying its own phone,
		// email and address — and the one on the account being worked is often the
		// stale one. Collect the distinct contact points across all of their ids so an
		// officer has every number on the file, newest record first.
		contactPoints := make([]core.Row, 0)
		if cp, _ := db.PGQuery(ctx, `
			SELECT DISTINCT ON (COALESCE(NULLIF(c.phone,''), NULLIF(c.email,''), c.contact_id))
			       COALESCE(NULLIF(c.cif,''), c.contact_id) AS source_id,
			       COALESCE(c.phone,'') AS phone,
			       COALESCE(c.email,'') AS email,
			       COALESCE(NULLIF(c.full_address,''),
			                NULLIF(TRIM(CONCAT_WS(', ', NULLIF(c.address_1,''), NULLIF(c.address_2,''),
			                                      NULLIF(c.city,''), NULLIF(c.state,''))),'')) AS address,
			       COALESCE(c.phone_was_fake, false)      AS phone_suspect,
			       COALESCE(c.email_was_malformed, false) AS email_suspect,
			       c.last_seen
			  FROM app.customers c
			 WHERE COALESCE(NULLIF(c.cif,''), c.contact_id) = ANY($1)
			   AND (NULLIF(c.phone,'') IS NOT NULL OR NULLIF(c.email,'') IS NOT NULL
			        OR NULLIF(c.full_address,'') IS NOT NULL)
			 ORDER BY COALESCE(NULLIF(c.phone,''), NULLIF(c.email,''), c.contact_id),
			          c.last_seen DESC NULLS LAST`, idList); cp != nil {
			contactPoints = cp
		}

		// ── 5. Case context an officer must not be missing on a call ───────────
		// A recovery case means this debt has left collections; a restructure means the
		// schedule above has been superseded. Both were absent from this page entirely.
		recovery := map[string]any{}
		if rc, _ := db.PGQuery(ctx, `
			SELECT r.id, r.case_ref, r.status, r.legal_stage,
			       COALESCE(r.outstanding_kobo, r.total_outstanding_kobo, 0) AS outstanding_kobo,
			       COALESCE(r.recovered_kobo, r.total_recovered_kobo, 0)     AS recovered_kobo,
			       COALESCE(r.write_off_amount_kobo,0) AS write_off_amount_kobo,
			       COALESCE(r.write_off_status,'')     AS write_off_status,
			       r.opened_at, COALESCE(u.full_name,'') AS agent_name,
			       COALESCE(r.solicitor,'') AS solicitor
			  FROM recovery_cases r
			  LEFT JOIN o3c_users u ON u.id = COALESCE(r.assigned_agent_id, r.assigned_to_user_id)
			 WHERE (COALESCE(NULLIF(r.account_cif,''), r.cif_number) = ANY($1))
			   AND r.status <> 'closed'
			 ORDER BY r.opened_at DESC NULLS LAST, r.id DESC LIMIT 1`, idList); len(rc) > 0 {
			recovery = rc[0]
		}

		accommodations := make([]core.Row, 0)
		if ar, _ := db.PGQuery(ctx, `
			SELECT a.id, a.kind, COALESCE(a.concession_type,'') AS concession_type,
			       COALESCE(a.amount_kobo,0) AS amount_kobo, a.new_tenor_months,
			       a.new_rate_bps, COALESCE(a.new_installment_kobo,0) AS new_installment_kobo,
			       a.new_maturity_date::text AS new_maturity_date,
			       COALESCE(a.status,'') AS status, COALESCE(a.reason,'') AS reason,
			       a.decided_at, COALESCE(a.account_ref,'') AS account_ref
			  FROM app.credit_accommodations a
			 WHERE a.cif = ANY($1)
			 ORDER BY a.created_at DESC LIMIT 20`, idList); ar != nil {
			accommodations = ar
		}

		respond(w, map[string]any{
			"recovery_case":  recovery,
			"accommodations": accommodations,
			"customer": map[string]any{
				"cif":         cif,
				"customer_id": customerID,
				"party_id":    partyID,
				"name":        name,
				"phone":       phone,
				"email":       email,
				"bvn":            bvn,
				"address":        address,
				"address_line":   addr1,
				"city":           city,
				"state":          state,
				"country":        country,
				"employer":       employer,
				"date_of_birth":  dob,
				"gender":         gender,
				"account_status": acctStatus,
				// Everyone else on the file an officer may need to reach.
				"contacts": contactPoints,
				"cifs":            visibleCIFs,
				"udara_customers": udaraCustomers,
				"udara_accounts":  udaraAccounts,
				// True when the account this page was opened on is an internal handle
				// rather than a card CIF, so the UI can label it honestly.
				"cif_is_internal": isSyntheticID(cif),
				"has_card":        len(visibleCIFs) > 0,
				"linked_ids":      idList,
				"c360_path":       "/customers/" + cif,
			},
			"facilities": facilities,
			"repayments": repayments,
			"totals": map[string]any{
				"facility_count":     len(facilities),
				"exposure_kobo":      exposure,
				"limit_kobo":         limit,
				"scheduled_kobo":     scheduled,
				"expected_kobo":      expected,
				"schedule_paid_kobo": schedPaid,
				"arrears_kobo":       arrears,
				"paid_kobo":          totalPaid,
				"unallocated_kobo":   unallocated,
				"paid_pct":           cdPct(schedPaid, scheduled),
				"next_due_date":      nextDue,
				"next_due_kobo":      nextDueK,
			},
		}, "pg")
	}
}

func cdFill(dst *string, v any) {
	if *dst == "" {
		*dst = str(v)
	}
}

// setDueDistance fills in how many days sit between today and an instalment's due
// date — the "due in 7 days" / "12 days past due" an officer prioritises by. Billing
// periods carry no contractual due date, so they are left unknown rather than guessed.
func setDueDistance(rows []schedRow) {
	today := time.Now().Truncate(24 * time.Hour)
	for i := range rows {
		if rows[i].Source == "cycle" || rows[i].DueDate == "" {
			continue
		}
		d, err := time.Parse("2006-01-02", rows[i].DueDate)
		if err != nil {
			continue
		}
		rows[i].DaysToDue = int(d.Sub(today).Hours() / 24)
		rows[i].DaysKnown = true
	}
}

// rollUpFacility computes a facility's schedule totals once its rows are built.
func rollUpFacility(f *facility) {
	if f.Schedule == nil {
		f.Schedule = []schedRow{}
	}
	today := time.Now().Format("2006-01-02")
	for _, s := range f.Schedule {
		f.ScheduledK += s.DueK
		f.PaidK += s.PaidK
		if s.DueDate != "" && s.DueDate <= today {
			f.ExpectedK += s.DueK
		}
	}
	f.PaidPct = cdPct(f.PaidK, f.ScheduledK)
	if a := f.ExpectedK - f.PaidK; a > 0 {
		f.ArrearsK = a
	}
}

// udaraSchedule reads the real amortisation schedule Udara returns per loan.
// payment_status is authoritative here — has_processed stays false even on
// instalments Udara has marked FullyPaid, so it is deliberately not used.
func udaraSchedule(ctx context.Context, db *core.DB, acct string) ([]schedRow, string) {
	rows, _ := db.PGQuery(ctx, `
		SELECT payment_date::text AS payment_date, principal_kobo, interest_kobo, fee_kobo,
		       COALESCE(payment_status,'') AS payment_status
		  FROM app.cbs_loan_schedules WHERE loan_account_number = $1
		 ORDER BY payment_date`, acct)
	if len(rows) == 0 {
		return []schedRow{}, "No schedule has been synced from Udara for this loan yet."
	}
	today := time.Now().Format("2006-01-02")
	out := make([]schedRow, 0, len(rows))
	for i, r := range rows {
		p, in, fe := toInt64(r["principal_kobo"]), toInt64(r["interest_kobo"]), toInt64(r["fee_kobo"])
		due := p + in + fe
		st := strings.ToLower(strings.ReplaceAll(str(r["payment_status"]), " ", ""))
		d := cdDate(r["payment_date"])
		row := schedRow{
			N: i + 1, DueDate: d, Label: cdInstalmentLabel(i+1, len(rows)),
			PrincipalK: p, InterestK: in, FeeK: fe, DueK: due, Source: "udara",
		}
		switch {
		case st == "fullypaid":
			row.PaidK, row.Status = due, "paid"
		case st == "partiallypaid":
			row.Status = "partial"
		case d < today:
			row.Status = "overdue"
		case d == today:
			row.Status = "due"
		default:
			row.Status = "upcoming"
		}
		row.PaidPct = cdPct(row.PaidK, row.DueK)
		out = append(out, row)
	}
	setDueDistance(out)
	return out, "Amortisation schedule as held by Udara core banking."
}

// derivedLoanSchedule builds the instalment plan for an uploaded loan from its own
// terms (disbursement date + tenor + monthly repayment + debit day), then settles
// the customer's received payments against it oldest-first — standard waterfall
// allocation, so the percentage on each instalment reflects money actually received.
// Returns what is left of the pool afterwards — including the unspent remainder of a
// payment this loan only partly consumed — so a second loan on the same CIF starts
// where this one stopped rather than spending the same naira twice.
func derivedLoanSchedule(f facility, pool []int64) ([]schedRow, string, []int64) {
	months, _ := strconv.Atoi(strings.TrimSpace(f.Tenor))
	if months <= 0 || f.OpenedDate == "" || f.InstalmentK <= 0 {
		return []schedRow{}, "No schedule: this uploaded loan has no disbursement date, tenor or monthly repayment on file.", pool
	}
	if months > 360 {
		months = 360
	}
	t0, err := time.Parse("2006-01-02", f.OpenedDate)
	if err != nil {
		return []schedRow{}, "No schedule: the disbursement date on this loan could not be read.", pool
	}
	day := t0.Day()
	if d, e := strconv.Atoi(strings.TrimSpace(f.DebitDay)); e == nil && d >= 1 && d <= 31 {
		day = d
	}

	pi := 0
	var carry int64
	if len(pool) > 0 {
		carry = pool[0]
	}
	today := time.Now().Format("2006-01-02")
	out := make([]schedRow, 0, months)
	for i := 1; i <= months; i++ {
		ds := cdAddMonths(t0, i, day).Format("2006-01-02")
		due := f.InstalmentK
		row := schedRow{
			N: i, DueDate: ds, Label: cdInstalmentLabel(i, months),
			PrincipalK: due, DueK: due, Source: "derived",
		}
		need := due
		for need > 0 && pi < len(pool) {
			if carry <= 0 {
				pi++
				if pi >= len(pool) {
					break
				}
				carry = pool[pi]
				continue
			}
			take := carry
			if take > need {
				take = need
			}
			row.PaidK += take
			carry -= take
			need -= take
		}
		switch {
		case row.PaidK >= due:
			row.Status = "paid"
		case row.PaidK > 0:
			row.Status = "partial"
		case ds < today:
			row.Status = "overdue"
		case ds == today:
			row.Status = "due"
		default:
			row.Status = "upcoming"
		}
		row.PaidPct = cdPct(row.PaidK, row.DueK)
		out = append(out, row)
	}
	// carry is the unspent balance of pool[pi]; pool[pi+1:] is untouched. Hand both
	// on, so a payment this loan only partly used is not spent twice.
	remaining := []int64{}
	if pi < len(pool) {
		if carry > 0 {
			remaining = append(remaining, carry)
		}
		remaining = append(remaining, pool[pi+1:]...)
	}
	setDueDistance(out)
	return out, "Derived from the loan's own terms (disbursement date, tenor, monthly repayment) and settled against payments received, oldest first.", remaining
}

// cardCycleSchedule reports a card's billing periods. A revolving card has no
// amortisation schedule, so the period view is the honest equivalent: what was
// billed in each month against what was repaid in it. Where the cycle feed holds a
// statement snapshot, that cycle's stated minimum is quoted in the note.
func cardCycleSchedule(ctx context.Context, db *core.DB, cardCIF, accountID string) ([]schedRow, string) {
	rows, _ := db.PGQuery(ctx, `
		SELECT TO_CHAR(DATE_TRUNC('month', t.txn_date), 'YYYY-MM-DD') AS period,
		       SUM(CASE WHEN t.money_in THEN 0 ELSE COALESCE(t.amount_debit,0) END)  AS billed,
		       SUM(CASE WHEN t.money_in THEN COALESCE(t.amount_credit,0) ELSE 0 END) AS paid
		  FROM core.transaction t
		 WHERE t.account_id = $1 AND t.txn_date IS NOT NULL
		 GROUP BY 1
		HAVING SUM(COALESCE(t.amount_debit,0)) + SUM(COALESCE(t.amount_credit,0)) > 0
		 ORDER BY 1 DESC LIMIT 24`, accountID)
	if len(rows) == 0 {
		return []schedRow{}, "No billing activity recorded on this card yet."
	}
	out := make([]schedRow, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- { // oldest first, so numbering reads forward
		r := rows[i]
		billed, paid := cdNairaKobo(r["billed"]), cdNairaKobo(r["paid"])
		d := cdDate(r["period"])
		row := schedRow{
			N: len(rows) - i, DueDate: d, Label: cdMonthLabel(d),
			PrincipalK: billed, DueK: billed, PaidK: paid, Source: "cycle",
		}
		switch {
		case billed == 0 && paid > 0:
			row.Status = "paid"
		case billed > 0 && paid >= billed:
			row.Status = "paid"
		case paid > 0:
			row.Status = "partial"
		default:
			row.Status = "overdue"
		}
		row.PaidPct = cdPct(row.PaidK, row.DueK)
		out = append(out, row)
	}
	note := "Billing periods from the card ledger: spend billed in the month against repayments received in it."
	if cr, _ := db.PGQuery(ctx, `
		SELECT cycle_date::text AS cycle_date, COALESCE(minimum_payment_kobo,0) AS minimum_payment_kobo,
		       COALESCE(billed_balance_kobo,0) AS billed_balance_kobo,
		       COALESCE(total_payment_kobo,0)  AS total_payment_kobo
		  FROM app.card_cycle_data WHERE cif = $1 ORDER BY cycle_date DESC LIMIT 1`, cardCIF); len(cr) > 0 {
		note += fmt.Sprintf(" Latest statement cycle %s — minimum due %s, billed %s, paid %s.",
			cdDate(cr[0]["cycle_date"]),
			cdNairaText(toInt64(cr[0]["minimum_payment_kobo"])),
			cdNairaText(toInt64(cr[0]["billed_balance_kobo"])),
			cdNairaText(toInt64(cr[0]["total_payment_kobo"])))
	}
	return out, note
}

func cdAddMonths(t0 time.Time, n, day int) time.Time {
	y, m := t0.Year(), int(t0.Month())+n
	for m > 12 {
		m -= 12
		y++
	}
	last := time.Date(y, time.Month(m)+1, 0, 0, 0, 0, 0, t0.Location()).Day()
	if day > last {
		day = last
	}
	return time.Date(y, time.Month(m), day, 0, 0, 0, 0, t0.Location())
}

func cdInstalmentLabel(n, total int) string { return fmt.Sprintf("Instalment %d of %d", n, total) }

func cdMonthLabel(d string) string {
	if t, err := time.Parse("2006-01-02", d); err == nil {
		return t.Format("Jan 2006")
	}
	return d
}

func cdTenorLabel(days string) string {
	d, err := strconv.Atoi(strings.TrimSpace(days))
	if err != nil || d <= 0 {
		return ""
	}
	if d%30 == 0 {
		return strconv.Itoa(d/30) + " months"
	}
	return days + " days"
}

// maskPAN leaves a card number identifiable without exposing it. Feed PANs already
// arrive masked; anything else is masked here rather than trusted.
func cdMaskPAN(pan string) string {
	p := strings.TrimSpace(pan)
	if len(p) < 10 {
		return ""
	}
	if strings.Contains(p, "*") {
		return p
	}
	return p[:6] + strings.Repeat("*", len(p)-10) + p[len(p)-4:]
}

func cdNairaText(kobo int64) string {
	return "NGN " + strconv.FormatFloat(float64(kobo)/100, 'f', 2, 64)
}
