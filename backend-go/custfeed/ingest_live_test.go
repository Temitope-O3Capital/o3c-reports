package custfeed

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// TestLiveIngest runs a real ingest against the feed folder and the workspace
// database. It is idempotent by design: a second run should read zero new files,
// which is asserted, because the whole correctness story of the feed rests on a file
// never being applied twice.
//
//	CUSTFEED_LIVE_TEST=1 DATA_FEED_DIR="..." DATABASE_URL="..." \
//	  go test ./custfeed -run TestLiveIngest -v
func TestLiveIngest(t *testing.T) {
	if os.Getenv("CUSTFEED_LIVE_TEST") != "1" {
		t.Skip("set CUSTFEED_LIVE_TEST=1 to run against the live feed and database")
	}
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Fatal("DATABASE_URL is not set")
	}

	pg, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close() //nolint:errcheck
	if err := pg.Ping(); err != nil {
		t.Fatalf("ping: %v", err)
	}
	db := &core.DB{PG: pg}

	ctx := context.Background()

	first, err := Run(ctx, db, "manual", sql.NullInt64{})
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	t.Logf("run 1: seen=%d read=%d empty=%d failed=%d rows=%d rejected=%d inserted=%d updated=%d",
		first.FilesSeen, first.FilesRead, first.FilesEmpty, first.FilesFail,
		first.Rows, first.Rejected, first.Inserted, first.Updated)

	second, err := Run(ctx, db, "manual", sql.NullInt64{})
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	t.Logf("run 2: seen=%d read=%d empty=%d rows=%d inserted=%d updated=%d",
		second.FilesSeen, second.FilesRead, second.FilesEmpty, second.Rows,
		second.Inserted, second.Updated)

	if second.FilesRead != 0 || second.FilesEmpty != 0 {
		t.Errorf("re-run processed %d non-empty and %d empty files; ingest is not idempotent",
			second.FilesRead, second.FilesEmpty)
	}
	if second.Inserted != 0 || second.Updated != 0 {
		t.Errorf("re-run wrote %d inserts and %d updates; expected none",
			second.Inserted, second.Updated)
	}
}
