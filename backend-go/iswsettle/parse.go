// Package iswsettle parses Interswitch settlement reports into settlement legs.
//
// Interswitch emits one row per SETTLEMENT LEG, not per transaction: a single
// purchase arrives as an Amount_Payable row plus one or more fee rows, with
// Tran_Amount_Req repeated identically on each. Summing the amount column is the
// classic way to double-count an Interswitch report, so legs are stored as they
// arrive and collapsed by the interswitch_transactions view.
//
// Parsing is HEADER-DRIVEN, never positional. The reports share a common core but
// column count varies 28–38 across channels (POS and WEB add merchant discount
// fields, ATM and Quickteller add card brand and beneficiary, Agency adds a sink
// node), and casing is inconsistent between families — `Currency_Name` in one file
// is `currency_name` in the next. Mapping by normalised header name absorbs all of
// that; a positional parser would silently mis-assign columns.
package iswsettle

import (
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

// Leg is one settlement leg, ready to insert.
type Leg struct {
	ReportFamily         string
	Session              string
	SourceFile           string
	SettlementDate       *time.Time
	LocalDatetime        *time.Time
	STAN                 string
	RRN                  string
	TranID               string
	AuthID               string
	PAN                  string
	CardBrand            string
	TerminalID           string
	MerchantID           string
	MerchantName         string
	FromAccount          string
	ToAccount            string
	BeneficiaryAccount   string
	AmountReqKobo        int64
	AmountRspKobo        int64
	SurchargeKobo        int64
	SettlementImpactKobo int64
	SettlementImpactDesc string
	MerchantDiscountKobo int64
	MerchantReceivKobo   int64
	Currency             string
	TranTypeDesc         string
	ResponseDesc         string
	TxnStatus            string
	TrxnCategory         string
	Region               string
	MessageType          string
	RowHash              string
}

// ParseFile parses one Interswitch CSV. Files whose header carries no recognisable
// transaction columns (global summaries, NIBSS advices) are skipped rather than
// forced — they are aggregates, not transactions, and belong in a different table.
func ParseFile(r io.Reader, filename string) ([]Leg, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1 // column count varies across families
	cr.LazyQuotes = true

	header, err := cr.Read()
	if err != nil {
		return nil, fmt.Errorf("%s: read header: %w", filename, err)
	}

	idx := map[string]int{}
	for i, h := range header {
		idx[normalise(h)] = i
	}
	// A transaction-level report must carry a retrieval reference; that is what
	// makes a row reconcilable back to CCS.
	if _, ok := idx["retrievalreferencenr"]; !ok {
		if _, ok2 := idx["retrievalreferencenumber"]; !ok2 {
			return nil, nil // not a transaction report — skip quietly
		}
	}

	family, session := classify(filename)

	var legs []Leg
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue // tolerate a malformed line rather than losing the file
		}
		get := func(names ...string) string {
			for _, n := range names {
				if i, ok := idx[n]; ok && i < len(rec) {
					return strings.TrimSpace(rec[i])
				}
			}
			return ""
		}

		rrn := get("retrievalreferencenr", "retrievalreferencenumber")
		if rrn == "" {
			continue
		}

		leg := Leg{
			ReportFamily:         family,
			Session:              session,
			SourceFile:           filename,
			SettlementDate:       parseTime(get("datetime", "settlementdate", "hostbusinessdate")),
			LocalDatetime:        parseTime(get("localdatetime", "transactiondate", "transactiondatetime")),
			STAN:                 get("stan"),
			RRN:                  rrn,
			TranID:               get("tranid", "transactionid"),
			AuthID:               get("authid"),
			PAN:                  get("pan"),
			CardBrand:            get("bankcardbrand"),
			TerminalID:           get("terminalid"),
			MerchantID:           get("merchantid"),
			MerchantName:         get("merchantnamelocation", "merchantaccountname"),
			FromAccount:          get("fromaccountid"),
			ToAccount:            get("toaccountid"),
			BeneficiaryAccount:   get("beneficiaryaccount"),
			AmountReqKobo:        toKobo(get("tranamountreq", "transactionamount", "amount")),
			AmountRspKobo:        toKobo(get("tranamountrsp")),
			SurchargeKobo:        toKobo(get("surcharge")),
			SettlementImpactKobo: toKobo(get("settlementimpact")),
			SettlementImpactDesc: get("settlementimpactdesc"),
			MerchantDiscountKobo: toKobo(get("merchantdiscount")),
			MerchantReceivKobo:   toKobo(get("merchantreceivable")),
			Currency:             get("currencyname", "currency"),
			TranTypeDesc:         get("trantypedescription"),
			ResponseDesc:         get("responsecodedescription", "responsedescription"),
			TxnStatus:            get("transactionstatus", "transactionstatus1"),
			TrxnCategory:         get("trxncategory"),
			Region:               get("region"),
			MessageType:          get("messagetype"),
		}

		// The hash makes re-uploading a file idempotent. It spans the whole record
		// plus the family, because the same transaction legitimately appears in both
		// the DR and PR session files and those are distinct settlement facts.
		h := sha256.Sum256([]byte(family + "|" + session + "|" + strings.Join(rec, "\x1f")))
		leg.RowHash = hex.EncodeToString(h[:])

		legs = append(legs, leg)
	}
	return legs, nil
}

// normalise strips case, spaces and underscores so `Currency_Name`,
// `currency_name` and `Currency Name` all resolve to one key.
//
// The BOM strip is load-bearing: these files are UTF-8 with a byte-order mark, so
// the FIRST header cell arrives as "DateTime". Without stripping it, every
// report whose first column is DateTime (POS, ATM, WEB, QT, Agency — i.e. all the
// channel reports) silently loses its settlement date, while IPG and
// Transfer_Service_Core parse fine because their date lives in a later column.
func normalise(s string) string {
	s = strings.TrimPrefix(s, string([]byte{0xEF, 0xBB, 0xBF}))
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "_", "")
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "-", "")
	return s
}

// classify derives the channel family and settlement session from the filename.
// Names drift between years (`O3C_POS_Report_DR_…` in 2025,
// `CAP_Web_Banks_(2026_06_27)_PR_…` in 2026), so matching is on substrings.
func classify(filename string) (family, session string) {
	f := strings.ToUpper(filename)

	switch {
	case strings.Contains(f, "POS_REPORT"), strings.Contains(f, "POS_ACQUIRED"):
		family = "POS"
	case strings.Contains(f, "ATM_WITHDRAWAL"):
		family = "ATM_WITHDRAWAL"
	case strings.Contains(f, "ATM_TRANSFERS"):
		family = "ATM_TRANSFERS"
	case strings.Contains(f, "QT_TRANSFERS"), strings.Contains(f, "QUICKTELLER"):
		family = "QT_TRANSFERS"
	case strings.Contains(f, "WEB_REPORT"), strings.Contains(f, "WEB_BANKS"):
		family = "WEB"
	case strings.Contains(f, "AGENCY_BANKING"):
		family = "AGENCY_BANKING"
	case strings.Contains(f, "BILLPAYMENT"):
		family = "BILLPAYMENT"
	case strings.Contains(f, "TRANSFER_SERVICE_CORE"):
		family = "TRANSFER_SERVICE_CORE"
	case strings.Contains(f, "IPG"):
		family = "IPG"
	case strings.Contains(f, "PREPAID_CARD_LOAD"):
		family = "PREPAID_CARD_LOAD"
	case strings.Contains(f, "NIBSS"):
		family = "NIBSS"
	default:
		family = "OTHER"
	}

	switch {
	case strings.Contains(f, "_DR_"), strings.Contains(f, ")_DR"):
		session = "DR"
	case strings.Contains(f, "_PR_"), strings.Contains(f, ")_PR"):
		session = "PR"
	case strings.Contains(f, "REVERSAL"):
		session = "REVERSAL"
	case strings.Contains(f, "FAILED"):
		session = "FAILED"
	}
	return family, session
}

// toKobo converts an Interswitch decimal ("5650.000000", "-53.75") to kobo.
func toKobo(s string) int64 {
	s = strings.TrimSpace(strings.ReplaceAll(s, ",", ""))
	if s == "" {
		return 0
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return int64(math.Round(f * 100))
}

// parseTime handles the several stamp formats these reports mix.
func parseTime(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	for _, layout := range []string{
		"1/2/2006 3:04:05 PM",
		"1/2/2006 15:04:05",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"1/2/2006",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return &t
		}
	}
	return nil
}
