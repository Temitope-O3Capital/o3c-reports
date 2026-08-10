package custfeed

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/o3c/reports/core"
)

// Dir returns the cust_file directory. DATA_FEED_DIR points at the drop root; the
// customer stream is one subdirectory of it.
func Dir() string {
	root := os.Getenv("DATA_FEED_DIR")
	if root == "" {
		return ""
	}
	return filepath.Join(root, "cust_file")
}

// Configured reports whether a feed directory has been set and exists. Callers use
// this to disable the schedule cleanly rather than logging an error every 15 minutes
// on a machine that has no feed mounted.
func Configured() bool {
	d := Dir()
	if d == "" {
		return false
	}
	st, err := os.Stat(d)
	return err == nil && st.IsDir()
}

// Result summarises one ingest run.
type Result struct {
	RunID      int64
	FilesSeen  int
	FilesRead  int
	FilesEmpty int
	FilesFail  int
	Rows       int
	Rejected   int
	Inserted   int
	Updated    int
}

// Run ingests every cust_file not yet recorded in customer_feed_files.
//
// Files are applied oldest-first so that when the same CIF appears in several drops,
// the most recent one wins. Each file is committed in its own transaction together
// with its customer_feed_files row: a crash mid-run leaves earlier files durably
// applied and un-reprocessed, and the file that was in flight simply gets picked up
// next time.
func Run(ctx context.Context, db *core.DB, kind string, triggeredBy sql.NullInt64) (Result, error) {
	var res Result

	dir := Dir()
	if dir == "" {
		return res, fmt.Errorf("custfeed: DATA_FEED_DIR is not set")
	}

	if err := db.PG.QueryRowContext(ctx,
		`INSERT INTO customer_feed_runs (kind, status, triggered_by)
		 VALUES ($1, 'running', $2) RETURNING id`, kind, triggeredBy).Scan(&res.RunID); err != nil {
		return res, fmt.Errorf("custfeed: open run: %w", err)
	}

	err := ingest(ctx, db, dir, &res)
	if err != nil {
		_, _ = db.PG.ExecContext(ctx,
			`UPDATE customer_feed_runs SET finished_at=NOW(), status='error', error=$2 WHERE id=$1`,
			res.RunID, err.Error())
		slog.Error("custfeed run failed", "run_id", res.RunID, "err", err)
		return res, err
	}

	// Link any newly-arrived customers to a person (party_id). A CIF is a card, not
	// a person, so new cards for an existing customer join their party and genuinely
	// new people get a new party. Idempotent + stable; only run when rows changed.
	if res.Inserted > 0 || res.Updated > 0 {
		if _, err := db.PG.ExecContext(ctx, `SELECT app.assign_parties()`); err != nil {
			slog.Warn("custfeed: party assignment failed (customers ingested, parties stale)", "run_id", res.RunID, "err", err)
		}
	}

	_, _ = db.PG.ExecContext(ctx, `
		UPDATE customer_feed_runs
		   SET finished_at=NOW(), status='ok',
		       files_seen=$2, files_parsed=$3, files_empty=$4, files_failed=$5,
		       rows_read=$6, rows_rejected=$7,
		       customers_inserted=$8, customers_updated=$9
		 WHERE id=$1`,
		res.RunID, res.FilesSeen, res.FilesRead, res.FilesEmpty, res.FilesFail,
		res.Rows, res.Rejected, res.Inserted, res.Updated)

	slog.Info("custfeed run ok", "run_id", res.RunID,
		"files", res.FilesRead, "empty", res.FilesEmpty, "failed", res.FilesFail,
		"inserted", res.Inserted, "updated", res.Updated, "rejected", res.Rejected)
	return res, nil
}

func ingest(ctx context.Context, db *core.DB, dir string, res *Result) error {
	paths, err := filepath.Glob(filepath.Join(dir, "cust_file.*.csv"))
	if err != nil {
		return fmt.Errorf("custfeed: scan %s: %w", dir, err)
	}

	done, err := processedFiles(ctx, db)
	if err != nil {
		return err
	}

	type job struct {
		path string
		meta FileMeta
	}
	var jobs []job
	for _, p := range paths {
		meta, err := ParseFileName(p)
		if err != nil {
			slog.Warn("custfeed: skipping unrecognised filename", "path", p, "err", err)
			continue
		}
		res.FilesSeen++
		if done[meta.Name] {
			continue
		}
		jobs = append(jobs, job{p, meta})
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].meta.Less(jobs[j].meta) })

	for _, j := range jobs {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := applyFile(ctx, db, j.path, j.meta, res); err != nil {
			// One malformed file must not abort the run — record it and continue, so a
			// single bad drop cannot block every later customer indefinitely.
			res.FilesFail++
			slog.Warn("custfeed: file failed", "file", j.meta.Name, "err", err)
			_, _ = db.PG.ExecContext(ctx, `
				INSERT INTO customer_feed_files (filename, feed_date, seq, status, error, run_id)
				VALUES ($1,$2,$3,'failed',$4,$5) ON CONFLICT (filename) DO NOTHING`,
				j.meta.Name, j.meta.Date, j.meta.Seq, err.Error(), res.RunID)
		}
	}
	return nil
}

func processedFiles(ctx context.Context, db *core.DB) (map[string]bool, error) {
	rows, err := db.PG.QueryContext(ctx, `SELECT filename FROM customer_feed_files`)
	if err != nil {
		return nil, fmt.Errorf("custfeed: read processed files: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	done := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		done[n] = true
	}
	return done, rows.Err()
}

// upsertSQL writes one feed row into the customer master.
//
// Two rules matter:
//
//   - A blank field in a delta means "no change", not "clear it". Every text column is
//     therefore COALESCE(NULLIF(new,”), old) so an empty column in one drop cannot
//     erase a value an earlier drop supplied.
//   - `source` and `first_seen_at` are insert-only. source records where a customer
//     ORIGINATED (mssql_baseline vs feed) and must not be rewritten by a later touch;
//     last_seen and source_file carry the recency story instead.
//
// contact_id is minted as 'Z' + the zero-padded CIF. Existing keys are 16-character
// hex from the old card system, so a 'Z' prefix cannot collide, and deriving it from
// the CIF keeps it stable if a row is ever re-inserted.
const upsertSQL = `
INSERT INTO app.customers (
    contact_id, cif, first_name, last_name, full_name, email, phone,
    address_1, address_2, full_address, city, state, country,
    source, source_file, last_seen, first_seen_at, created_at, email_was_malformed
) VALUES (
    'Z' || LPAD($1, 15, '0'), $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10, $11, $12,
    'feed', $13, NOW(), NOW(), NOW(), $14
)
ON CONFLICT (cif) WHERE cif IS NOT NULL AND cif <> ''
DO UPDATE SET
    first_name          = COALESCE(NULLIF(EXCLUDED.first_name, ''),   app.customers.first_name),
    last_name           = COALESCE(NULLIF(EXCLUDED.last_name, ''),    app.customers.last_name),
    full_name           = COALESCE(NULLIF(EXCLUDED.full_name, ''),    app.customers.full_name),
    email               = COALESCE(NULLIF(EXCLUDED.email, ''),        app.customers.email),
    phone               = COALESCE(NULLIF(EXCLUDED.phone, ''),        app.customers.phone),
    address_1           = COALESCE(NULLIF(EXCLUDED.address_1, ''),    app.customers.address_1),
    address_2           = COALESCE(NULLIF(EXCLUDED.address_2, ''),    app.customers.address_2),
    full_address        = COALESCE(NULLIF(EXCLUDED.full_address, ''), app.customers.full_address),
    city                = COALESCE(NULLIF(EXCLUDED.city, ''),         app.customers.city),
    state               = COALESCE(NULLIF(EXCLUDED.state, ''),        app.customers.state),
    country             = COALESCE(NULLIF(EXCLUDED.country, ''),      app.customers.country),
    email_was_malformed = EXCLUDED.email_was_malformed,
    source_file         = EXCLUDED.source_file,
    last_seen           = EXCLUDED.last_seen
RETURNING (xmax = 0) AS inserted`

func applyFile(ctx context.Context, db *core.DB, path string, meta FileMeta, res *Result) error {
	st, err := os.Stat(path)
	if err != nil {
		return err
	}

	// A 0-byte file means "nothing changed in that 15-minute window" — the normal case
	// for customers, which move far less than accounts or transactions. Record it so it
	// is never re-read, and move on.
	if st.Size() == 0 {
		res.FilesEmpty++
		_, err = db.PG.ExecContext(ctx, `
			INSERT INTO customer_feed_files (filename, feed_date, seq, size_bytes, status, run_id)
			VALUES ($1,$2,$3,0,'empty',$4) ON CONFLICT (filename) DO NOTHING`,
			meta.Name, meta.Date, meta.Seq, res.RunID)
		return err
	}

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck

	var custs []Customer
	var rejected int
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		c, err := ParseLine(line)
		if err != nil {
			rejected++
			continue
		}
		custs = append(custs, c)
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("read %s: %w", meta.Name, err)
	}

	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	var inserted, updated int
	for _, c := range custs {
		var isNew bool
		err := tx.QueryRowContext(ctx, upsertSQL,
			c.CIF, c.FirstName, c.LastName, c.FullName(), c.Email, c.Phone,
			c.Address1, c.Address2, c.FullAddress(), c.City, c.State, c.Country,
			meta.Name, c.EmailLooksMalformed(),
		).Scan(&isNew)
		if err != nil {
			return fmt.Errorf("upsert cif %s: %w", c.CIF, err)
		}
		if isNew {
			inserted++
		} else {
			updated++
		}
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO customer_feed_files
		    (filename, feed_date, seq, size_bytes, rows_read, rows_rejected, status, run_id)
		VALUES ($1,$2,$3,$4,$5,$6,'ok',$7)
		ON CONFLICT (filename) DO NOTHING`,
		meta.Name, meta.Date, meta.Seq, st.Size(), len(custs), rejected, res.RunID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	res.FilesRead++
	res.Rows += len(custs)
	res.Rejected += rejected
	res.Inserted += inserted
	res.Updated += updated
	return nil
}
