package handlers

import (
	"database/sql"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

/*
MASKING, ENFORCED RATHER THAN REMEMBERED.

The registry went from 30 data sources to 52 in one pass on 2026-10-09, and the tables
added carry values that must not leave the building intact:

  - app.card_issuance_requests.card_pan — a card number, masked to its last 4.
  - app.watch_list_entries.id_value     — whatever identity document a screener recorded.

And three that must not leave it AT ALL:

  - app.sars.subject_name_encrypted / subject_id_encrypted / summary_encrypted. A SAR
    subject in a spreadsheet is a tipping-off risk, not an inconvenience.

maskedPAN and maskedBVN already existed and were applied correctly, but nothing stopped
the next dataset forgetting. "Remember to mask it" is not a control — it is a hope with a
code review in front of it. These tests are the control.

THE THREE CHECKS, AND WHY EACH ONE EARNS ITS PLACE:

  - TestEveryDatasetMasksWhatItMustMask reads the DECLARED SQL, so it fails in CI on the
    commit that introduces an unmasked column, with no database and no data needed. It
    was verified to bite: pointing the issuance PAN column at the raw ci.card_pan makes
    it fail with the column named.
  - TestDeclaredMasksActuallyMaskLive reads the VALUES THAT COME BACK for columns
    declared as masked, so a mask that silently stops applying is caught. See the long
    note above it for the broader pattern-scan that was tried, measured and rejected.
  - TestTheSARDatasetNamesNobody is a named guard on the one case where the right answer
    is "omit", not "mask".
*/

// sensitiveColumnRE matches a column reference that must be masked or omitted.
//
// Matched on the column name as it appears in SQL, so it fires on `ci.card_pan` and
// `wl.id_value` alike. Deliberately broad: a false positive costs one line in
// maskedExemptExprs with a reason, while a false negative ships a card number.
var sensitiveColumnRE = regexp.MustCompile(
	`\b[a-z0-9_]*\.?(card_pan|pan_full|cvv|cvv2|bvn|nin|tin|id_value|id_number|` +
		`passport|account_pin|password|password_hash|api_key|api_secret|secret|` +
		`private_key|token|otp)\b`)

// encryptedColumnRE matches a column that is stored encrypted. These are never exposed,
// masked or otherwise: a masked ciphertext is useless to the reader and still a leak of
// the fact that a record exists.
var encryptedColumnRE = regexp.MustCompile(`\b[a-z0-9_]*\.?[a-z0-9_]*(_encrypted|_enc|_hmac)\b`)

// maskMarkers are the fingerprints a masking expression leaves in the compiled SQL.
// Masks are declared as Go constants (maskedPAN, maskedBVN, maskedWatchID,
// maskedIssuancePAN), so by the time a test reads exportCol.Expr it holds the whole CASE
// expression — which means this checks the SQL that will actually run, not the name of
// the constant someone meant to use.
var maskMarkers = []string{`'****'`, `'*******'`, `repeat('*'`}

// maskedExemptExprs are expressions that trip the pattern but are safe, each with the
// reason. Keep this short and specific — it is the list a reviewer should be suspicious
// of.
var maskedExemptExprs = map[string]string{
	// A masked BVN is still a bvn reference; the mask is the point.
	"bvn_masked": "goes through maskedBVN",
	// An ID *type* is "Passport" or "NIN", not an identifier.
	"id_type": "names the document type, carries no identifier",
	// subject_id_type likewise: "BVN", not a BVN.
	"subject_id_type": "names the document type on a SAR, carries no identifier",
}

func TestEveryDatasetMasksWhatItMustMask(t *testing.T) {
	for _, d := range exportDatasets {
		for _, c := range d.Cols {
			expr := c.Expr
			if reason, ok := maskedExemptExprs[c.Key]; ok {
				t.Logf("%s.%s exempt: %s", d.Key, c.Key, reason)
				continue
			}

			// An encrypted column must not be exposed at all.
			if m := encryptedColumnRE.FindString(expr); m != "" {
				t.Errorf("dataset %q column %q exposes the encrypted value %q.\n"+
					"Encrypted columns are never exported, masked or otherwise — drop the "+
					"column and read the record through the module that decrypts it against "+
					"a named reader.", d.Key, c.Key, m)
				continue
			}

			// A sensitive column must go through a mask.
			if m := sensitiveColumnRE.FindString(expr); m != "" {
				masked := false
				for _, marker := range maskMarkers {
					if strings.Contains(expr, marker) {
						masked = true
						break
					}
				}
				if !masked {
					t.Errorf("dataset %q column %q references the sensitive value %q with "+
						"no mask.\nWrap it in a masking constant beside maskedPAN in "+
						"export_datasets.go (the mask must leave at most the last 4 "+
						"characters), or remove the column. If it is genuinely harmless, add "+
						"its key to maskedExemptExprs WITH a reason.",
						d.Key, c.Key, m)
				}
			}
		}
	}
}

// ── What actually comes back ──────────────────────────────────────────────────
//
// WHY THERE IS NO PATTERN-SCAN FOR CARD NUMBERS HERE, HAVING TRIED ONE.
//
// The first version of this test scanned every returned string for a 13-19 digit run
// that passes the Luhn check, on the theory that it would catch a PAN pasted into a
// notes or reference field — the case the static test above cannot see.
//
// It was removed after being measured, for two independent reasons:
//
//  1. IT WAS NOT SPECIFIC. Roughly one in ten arbitrary digit runs passes Luhn by
//     chance, and this platform is full of long digit strings that are not card
//     numbers. On one run it fired on loan account numbers, card transaction ids,
//     customer phone numbers, collections CIFs, helpdesk ticket refs and a merchant
//     name — forty-plus failures, none of them a card. A test that cries wolf on every
//     account number gets switched off, and then it protects nothing.
//
//  2. IT WAS HUNTING SOMETHING THIS DATABASE DOES NOT HOLD. app.accounts.card_pan is
//     TEN digits, not sixteen: measured 2026-10-09, 19,957 rows on the Verve BIN 5061
//     and 919 on 3793, every one of them 10 characters. There is no full PAN in the
//     card book to leak. Masking it to the last 4 is still right, and still enforced
//     above — but a 16-digit-PAN detector has nothing to find.
//
// Silencing it would have meant listing fifteen innocent columns as exemptions, which
// is precisely the "list of things everyone agreed to stop looking at" this file warns
// about. So the live check below is narrow and literal instead: for the columns that
// ARE declared as masked, assert the output is actually masked. That tests the masks
// rather than guessing at the data.

func TestDeclaredMasksActuallyMaskLive(t *testing.T) {
	if os.Getenv("EXPORT_LIVE_TEST") != "1" {
		t.Skip("set EXPORT_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	ctx := t.Context()

	checked := 0
	for _, d := range exportDatasets {
		// Only the columns whose declared expression is a mask.
		masked := []exportCol{}
		for _, c := range d.Cols {
			for _, m := range maskMarkers {
				if strings.Contains(c.Expr, m) {
					masked = append(masked, c)
					break
				}
			}
		}
		if len(masked) == 0 {
			continue
		}

		t.Run(d.Key, func(t *testing.T) {
			req := exportRequest{}
			if d.DateRequired {
				req.DateFrom, req.DateTo = "2020-01-01", "2030-01-01"
			}
			q, args, _, err := buildExportQuery(d, req, 200)
			if err != nil {
				t.Fatalf("build: %v", err)
			}
			rows, err := db.PGQuery(ctx, q, args...)
			if err != nil {
				t.Fatalf("query: %v", err)
			}
			if len(rows) == 0 {
				t.Skipf("%s holds no rows yet", d.Key)
			}
			for _, c := range masked {
				sawValue, sawMask := false, false
				for _, r := range rows {
					s, ok := r[c.Key].(string)
					if !ok || s == "" {
						continue
					}
					sawValue = true
					if strings.Contains(s, "*") {
						sawMask = true
						continue
					}
					t.Errorf("%s.%s is declared as masked but returned %q with no masking "+
						"character in it. Either the mask stopped applying, or the column is "+
						"reading a different value than it used to.", d.Key, c.Key, s)
				}
				if sawValue && sawMask {
					checked++
				}
			}
		})
	}
	t.Logf("verified %d masked column(s) against live values", checked)
}

// TestTheSARDatasetNamesNobody is a named regression guard for the single highest-stakes
// case in the registry, kept separate so it reads as a decision rather than a pattern
// match. If someone adds the subject back, this is the test that should make them stop
// and go and ask Compliance first.
func TestTheSARDatasetNamesNobody(t *testing.T) {
	d, ok := exportDatasetByKey("sars")
	if !ok {
		t.Skip("sars dataset not registered")
	}
	for _, c := range d.Cols {
		low := strings.ToLower(c.Key + " " + c.Expr)
		for _, banned := range []string{"subject_name", "subject_id_enc", "summary"} {
			if strings.Contains(low, banned) {
				t.Errorf("the SAR dataset exposes %q via column %q. A SAR subject must not "+
					"leave in a spreadsheet — the register carries references, amounts and "+
					"status only. Read the subject through the Compliance module, which "+
					"decrypts per record against a named reader.", banned, c.Key)
			}
		}
	}
	if len(d.Cols) == 0 {
		t.Error("the SAR dataset has no columns at all, which is not the intended fix")
	}
}

func TestMaskMarkersActuallyAppearInTheMasks(t *testing.T) {
	// If a mask is rewritten without one of the markers, every masking check above
	// silently stops recognising it and starts passing for the wrong reason. This is the
	// test that notices.
	for name, expr := range map[string]string{
		"maskedPAN":         maskedPAN,
		"maskedBVN":         maskedBVN,
		"maskedWatchID":     maskedWatchID,
		"maskedIssuancePAN": maskedIssuancePAN,
	} {
		found := false
		for _, m := range maskMarkers {
			if strings.Contains(expr, m) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s no longer contains any marker in maskMarkers, so the masking "+
				"tests can no longer tell it apart from an unmasked column. Either keep a "+
				"marker, or add the new one to maskMarkers.", name)
		}
		if !strings.Contains(expr, "RIGHT(") {
			t.Errorf("%s does not keep a trailing fragment via RIGHT(...), so it is either "+
				"not a mask or it reveals the wrong end of the value: %s",
				name, fmt.Sprintf("%.60s", expr))
		}
	}
}
