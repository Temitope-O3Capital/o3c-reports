// Package cardfeed tracks the 15-minute cardfam_file drops.
//
// cardfam_file is the card-family/programme reference stream (docs/DATA_FEED_INGESTION.md
// §3.4). It has never produced a non-empty file, so its column layout is undecoded. This
// loader therefore does the safe thing: it records every (0-byte) drop so the folder is
// kept swept, and if a non-empty file ever appears it quarantines the rows (counts them
// as rejected, never guesses a mapping) so they surface for decoding rather than being
// written blind. Wire in the real parser here once the first non-empty file arrives.
package cardfeed

import (
	"context"
	"database/sql"
	"log/slog"

	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/feedcore"
)

// Stream is the cardfam_file feed.
var Stream = feedcore.Stream{Name: "cardfam", SubDir: "cardfam_file", Prefix: "cardfam_file"}

// Configured reports whether the cardfam_file folder is mounted.
func Configured() bool { return Stream.Configured() }

// Run tracks every cardfam_file not yet processed.
func Run(ctx context.Context, db *core.DB, kind string, triggeredBy sql.NullInt64) (feedcore.Result, error) {
	return feedcore.Run(ctx, db, Stream, kind, triggeredBy, apply)
}

// apply quarantines any non-empty content. feedcore only calls this for non-0-byte
// files, so reaching it at all means the layout finally needs decoding.
func apply(_ context.Context, _ *sql.Tx, lines []string, meta feedcore.FileMeta) (inserted, updated, rejected int, err error) {
	if len(lines) > 0 {
		slog.Warn("cardfeed: non-empty cardfam_file — layout undecoded, quarantining rows",
			"file", meta.Name, "rows", len(lines))
	}
	return 0, 0, len(lines), nil
}
