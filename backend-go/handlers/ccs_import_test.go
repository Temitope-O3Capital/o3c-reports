package handlers

import (
	"bufio"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// TestLoadCCSDir parses a directory of raw CCS EODTXN files (Report 620) and loads
// them into ccs_transactions. Gated behind CCS_LOAD_TEST=1.
//
//	CCS_LOAD_TEST=1 CCS_DIR=/path/to/EODTXN go test ./handlers -run TestLoadCCSDir -v
func TestLoadCCSDir(t *testing.T) {
	if os.Getenv("CCS_LOAD_TEST") != "1" {
		t.Skip("set CCS_LOAD_TEST=1 to load CCS EODTXN files")
	}
	dir := os.Getenv("CCS_DIR")
	if dir == "" {
		t.Fatal("set CCS_DIR")
	}
	env := readEnvFile(t, "../.env")

	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	ctx := context.Background()

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}

	total, inserted, files := 0, 0, 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "EODTXN") {
			continue
		}
		f, err := os.Open(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		txns, _ := parseEODTXN(f, e.Name())
		f.Close()
		files++
		total += len(txns)

		for _, tx := range txns {
			res, err := db.PG.ExecContext(ctx, `
				INSERT INTO ccs_transactions
				  (trace_num, auth_num, card_num, txn_code, txn_date, merchant_id,
				   amount_kobo, sign, currency, merchant_name, description,
				   account_no, cif, product_code, product_name, branch_code, branch_name)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
				ON CONFLICT DO NOTHING`,
				tx.TraceNum, tx.AuthNum, tx.CardNum, tx.TxnCode, tx.TxnDate, tx.MerchantID,
				tx.AmountKobo, tx.Sign, tx.Currency, tx.MerchantName, tx.Description,
				tx.AccountNo, tx.CIF, tx.ProductCode, tx.ProductName, tx.BranchCode, tx.BranchName)
			if err != nil {
				t.Fatalf("insert: %v", err)
			}
			if n, _ := res.RowsAffected(); n > 0 {
				inserted++
			}
		}
	}
	t.Logf("files=%d parsed=%d inserted=%d", files, total, inserted)
	if total == 0 {
		t.Fatal("parsed nothing")
	}
}

func readEnvFile(t *testing.T, path string) map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return out
}
