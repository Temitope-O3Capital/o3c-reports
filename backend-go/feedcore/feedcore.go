// Package feedcore is the shared ingest driver for the positional 15-minute feed
// drops (docs/DATA_FEED_INGESTION.md). Each stream (accounts, transactions,
// card-families) supplies a small Applier that parses its file and upserts its rows;
// feedcore owns the parts every stream shares: scanning the drop folder, skipping
// files already recorded in feed_files, applying oldest-first (so the newest drop
// wins an upsert), per-file transactions, and run/file bookkeeping.
//
// It mirrors the custfeed package (which predates it and stays on its own
// customer_feed_* tables); the difference is feedcore is stream-generic and records
// into the shared feed_runs / feed_files tables tagged by stream.
package feedcore

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/o3c/workspace/core"
)

// Stream describes one feed folder and its filename prefix.
type Stream struct {
	Name   string // logical stream name recorded in feed_runs/feed_files: accounts|transactions|cardfam
	SubDir string // folder under DATA_FEED_DIR, e.g. "acct_file"
	Prefix string // filename prefix, e.g. "acct_file" or "txnlist_file"
}

// FileMeta is the date and sequence encoded in a feed filename.
type FileMeta struct {
	Name string
	Date time.Time
	Seq  int
}

// Less orders two files chronologically: drop date, then sequence within the day.
func (a FileMeta) Less(b FileMeta) bool {
	if !a.Date.Equal(b.Date) {
		return a.Date.Before(b.Date)
	}
	return a.Seq < b.Seq
}

// Applier parses the non-empty lines of one file and writes them inside tx. It returns
// per-file counts. It must not commit or roll back — feedcore owns the transaction.
type Applier func(ctx context.Context, tx *sql.Tx, lines []string, meta FileMeta) (inserted, updated, rejected int, err error)

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

// Root returns DATA_FEED_DIR, the drop root (or "" if unset).
func Root() string { return os.Getenv("DATA_FEED_DIR") }

// Dir returns the stream's folder, e.g. <root>/acct_file.
func (s Stream) Dir() string {
	root := Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, s.SubDir)
}

// Configured reports whether the stream's folder is set and exists.
func (s Stream) Configured() bool {
	d := s.Dir()
	if d == "" {
		return false
	}
	st, err := os.Stat(d)
	return err == nil && st.IsDir()
}

// parseName pulls the DDMMYYYY date and sequence out of "<prefix>.DDMMYYYY.SEQ.csv".
func (s Stream) parseName(path string) (FileMeta, error) {
	re := regexp.MustCompile(`^` + regexp.QuoteMeta(s.Prefix) + `\.(\d{8})\.(\d+)\.csv$`)
	base := filepath.Base(path)
	m := re.FindStringSubmatch(base)
	if m == nil {
		return FileMeta{}, fmt.Errorf("unrecognised feed filename: %s", base)
	}
	d, err := time.Parse("02012006", m[1]) // DD MM YYYY, never ISO
	if err != nil {
		return FileMeta{}, fmt.Errorf("bad date in %s: %w", base, err)
	}
	seq, err := strconv.Atoi(m[2])
	if err != nil {
		return FileMeta{}, fmt.Errorf("bad sequence in %s: %w", base, err)
	}
	return FileMeta{Name: base, Date: d, Seq: seq}, nil
}

// Run ingests every file in the stream not yet recorded in feed_files, oldest-first.
func Run(ctx context.Context, db *core.DB, s Stream, kind string, triggeredBy sql.NullInt64, apply Applier) (Result, error) {
	var res Result
	dir := s.Dir()
	if dir == "" {
		return res, fmt.Errorf("feedcore: DATA_FEED_DIR is not set")
	}

	if err := db.PG.QueryRowContext(ctx,
		`INSERT INTO feed_runs (stream, kind, status, triggered_by) VALUES ($1,$2,'running',$3) RETURNING id`,
		s.Name, kind, triggeredBy).Scan(&res.RunID); err != nil {
		return res, fmt.Errorf("feedcore: open run: %w", err)
	}

	err := ingest(ctx, db, s, apply, &res)
	if err != nil {
		_, _ = db.PG.ExecContext(ctx,
			`UPDATE feed_runs SET finished_at=NOW(), status='error', error=$2 WHERE id=$1`,
			res.RunID, err.Error())
		slog.Error("feed run failed", "stream", s.Name, "run_id", res.RunID, "err", err)
		return res, err
	}

	_, _ = db.PG.ExecContext(ctx, `
		UPDATE feed_runs SET finished_at=NOW(), status='ok',
		    files_seen=$2, files_parsed=$3, files_empty=$4, files_failed=$5,
		    rows_read=$6, rows_rejected=$7, rows_inserted=$8, rows_updated=$9
		 WHERE id=$1`,
		res.RunID, res.FilesSeen, res.FilesRead, res.FilesEmpty, res.FilesFail,
		res.Rows, res.Rejected, res.Inserted, res.Updated)

	slog.Info("feed run ok", "stream", s.Name, "run_id", res.RunID,
		"files", res.FilesRead, "empty", res.FilesEmpty, "failed", res.FilesFail,
		"inserted", res.Inserted, "updated", res.Updated, "rejected", res.Rejected)
	return res, nil
}

func ingest(ctx context.Context, db *core.DB, s Stream, apply Applier, res *Result) error {
	paths, err := filepath.Glob(filepath.Join(s.Dir(), s.Prefix+".*.csv"))
	if err != nil {
		return fmt.Errorf("feedcore: scan %s: %w", s.Dir(), err)
	}

	done, err := processedFiles(ctx, db, s.Name)
	if err != nil {
		return err
	}

	type job struct {
		path string
		meta FileMeta
	}
	var jobs []job
	for _, p := range paths {
		meta, err := s.parseName(p)
		if err != nil {
			slog.Warn("feedcore: skipping unrecognised filename", "stream", s.Name, "path", p, "err", err)
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
		if err := applyFile(ctx, db, s, apply, j.path, j.meta, res); err != nil {
			// One malformed file must not abort the run — record it and continue.
			res.FilesFail++
			slog.Warn("feedcore: file failed", "stream", s.Name, "file", j.meta.Name, "err", err)
			_, _ = db.PG.ExecContext(ctx, `
				INSERT INTO feed_files (stream, filename, feed_date, seq, status, error, run_id)
				VALUES ($1,$2,$3,$4,'failed',$5,$6) ON CONFLICT (stream, filename) DO NOTHING`,
				s.Name, j.meta.Name, j.meta.Date, j.meta.Seq, truncErr(err), res.RunID)
		}
	}
	return nil
}

func processedFiles(ctx context.Context, db *core.DB, stream string) (map[string]bool, error) {
	rows, err := db.PG.QueryContext(ctx, `SELECT filename FROM feed_files WHERE stream=$1`, stream)
	if err != nil {
		return nil, fmt.Errorf("feedcore: read processed files: %w", err)
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

func applyFile(ctx context.Context, db *core.DB, s Stream, apply Applier, path string, meta FileMeta, res *Result) error {
	st, err := os.Stat(path)
	if err != nil {
		return err
	}

	// A 0-byte file means "no change in that window" — record it so it is never
	// re-read, and move on.
	if st.Size() == 0 {
		res.FilesEmpty++
		_, err = db.PG.ExecContext(ctx, `
			INSERT INTO feed_files (stream, filename, feed_date, seq, size_bytes, status, run_id)
			VALUES ($1,$2,$3,$4,0,'empty',$5) ON CONFLICT (stream, filename) DO NOTHING`,
			s.Name, meta.Name, meta.Date, meta.Seq, res.RunID)
		return err
	}

	lines, err := readLines(path)
	if err != nil {
		return err
	}

	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	inserted, updated, rejected, err := apply(ctx, tx, lines, meta)
	if err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO feed_files (stream, filename, feed_date, seq, size_bytes, rows_read, rows_rejected, status, run_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,'ok',$8) ON CONFLICT (stream, filename) DO NOTHING`,
		s.Name, meta.Name, meta.Date, meta.Seq, st.Size(), len(lines), rejected, res.RunID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	res.FilesRead++
	res.Rows += len(lines)
	res.Rejected += rejected
	res.Inserted += inserted
	res.Updated += updated
	return nil
}

// readLines returns the file's non-empty, whitespace-trimmed lines, transcoding any
// Windows-1252/Latin-1 bytes (accented names, 0xA0 non-breaking spaces the Sage export
// emits) to valid UTF-8 so Postgres does not reject the row. bufio with a large buffer
// handles long rows.
func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close() //nolint:errcheck

	var out []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(ToUTF8(sc.Bytes()))
		if line != "" {
			out = append(out, line)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	return out, nil
}

// ToUTF8 converts a byte slice that may be Windows-1252 to a valid UTF-8 string. If the
// bytes are already valid UTF-8 they are returned unchanged; otherwise each byte is
// mapped through the Windows-1252 → Unicode table. Bytes 0x00-0x7F are ASCII and
// 0xA0-0xFF match Latin-1 (code point == byte), so a non-breaking space (0xA0) or "á"
// (0xE1) maps directly; only the 0x80-0x9F band needs the cp1252 punctuation table.
// This keeps the Sage export's Latin-1 bytes from being rejected as invalid UTF-8.
// Exported so custfeed (which has its own ingest loop) can share the same transcoder.
func ToUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b) + 8)
	for _, c := range b {
		switch {
		case c < 0x80 || c >= 0xA0:
			sb.WriteRune(rune(c)) // ASCII and Latin-1 high range map 1:1
		default:
			if r, ok := cp1252Hi[c]; ok {
				sb.WriteRune(r)
			} else {
				sb.WriteRune('�') // undefined cp1252 slot
			}
		}
	}
	return sb.String()
}

// cp1252Hi maps the Windows-1252-specific 0x80-0x9F band (curly quotes, dashes, etc.)
// to their Unicode code points. Undefined slots (0x81/0x8D/0x8F/0x90/0x9D) are absent.
var cp1252Hi = map[byte]rune{
	0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
	0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž',
	0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
	0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ',
}

func truncErr(err error) string {
	s := err.Error()
	if len(s) > 400 {
		return s[:400]
	}
	return s
}
