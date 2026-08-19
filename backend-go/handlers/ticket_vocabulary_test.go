package handlers

import (
	"database/sql"
	"os"
	"sort"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// The Go-side vocabulary lists must match the CHECK constraints on
// helpdesk_tickets exactly.
//
// When they drifted, the Zoho importer mapped Zoho's "escalated" to a status the
// column rejects and every such ticket was dropped on import — visible only as a
// warning line. This reads the constraints straight out of the database, so the
// two cannot diverge again without the build failing.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestTicketVocabularyMatchesConstraints -v
func TestTicketVocabularyMatchesConstraints(t *testing.T) {
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

	cases := []struct {
		constraint string
		got        []string
	}{
		{"helpdesk_tickets_status_check", ticketStatuses},
		{"helpdesk_tickets_priority_check", ticketPriorities},
		{"helpdesk_tickets_channel_check", ticketChannels},
	}

	for _, c := range cases {
		rows, err := db.PGQuery(t.Context(),
			`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
			  WHERE conrelid='app.helpdesk_tickets'::regclass AND conname=$1`, c.constraint)
		if err != nil || len(rows) == 0 {
			t.Errorf("%s: not found in the database", c.constraint)
			continue
		}
		def := str(rows[0]["def"])

		// Every value the Go list offers must be one the column accepts.
		for _, v := range c.got {
			if !strings.Contains(def, "'"+v+"'") {
				t.Errorf("%s rejects %q, but the importer can produce it — such a ticket "+
					"is dropped on import:\n  %s", c.constraint, v, def)
			}
		}

		// And the reverse: a value the column accepts but the list omits is a
		// mapping we silently downgrade to the fallback.
		var missing []string
		for _, v := range constraintValues(def) {
			found := false
			for _, g := range c.got {
				if g == v {
					found = true
				}
			}
			if !found {
				missing = append(missing, v)
			}
		}
		if len(missing) > 0 {
			sort.Strings(missing)
			t.Logf("%s also accepts %v — not offered by the importer (not an error, "+
				"but a value we will never write)", c.constraint, missing)
		}
	}
}

// constraintValues pulls the quoted literals out of a CHECK definition.
func constraintValues(def string) []string {
	var out []string
	for i := 0; i < len(def); i++ {
		if def[i] != '\'' {
			continue
		}
		j := strings.IndexByte(def[i+1:], '\'')
		if j < 0 {
			break
		}
		v := def[i+1 : i+1+j]
		if v != "" && !strings.Contains(v, "::") {
			out = append(out, v)
		}
		i += j + 1
	}
	return out
}
