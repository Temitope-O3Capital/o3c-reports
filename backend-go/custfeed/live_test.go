package custfeed

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestLiveParse parses every non-empty cust_file in the real drop folder and reports
// what decoded. It asserts nothing about counts — the point is to prove the column map
// holds against production data rather than only against the documented sample.
//
// Gated behind CUSTFEED_LIVE_TEST=1; DATA_FEED_DIR points at the drop root.
//
//	CUSTFEED_LIVE_TEST=1 DATA_FEED_DIR="/c/Users/tbabatunde/Desktop/Data Dump" \
//	  go test ./custfeed -run TestLiveParse -v
func TestLiveParse(t *testing.T) {
	if os.Getenv("CUSTFEED_LIVE_TEST") != "1" {
		t.Skip("set CUSTFEED_LIVE_TEST=1 to run against the live feed folder")
	}
	dir := Dir()
	if dir == "" {
		t.Fatal("DATA_FEED_DIR is not set")
	}

	paths, err := filepath.Glob(filepath.Join(dir, "cust_file.*.csv"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(paths) == 0 {
		t.Fatalf("no cust_file.*.csv under %s", dir)
	}

	var metas []FileMeta
	byName := map[string]string{}
	for _, p := range paths {
		m, err := ParseFileName(p)
		if err != nil {
			t.Errorf("unparseable filename: %v", err)
			continue
		}
		metas = append(metas, m)
		byName[m.Name] = p
	}
	sort.Slice(metas, func(i, j int) bool { return metas[i].Less(metas[j]) })

	var empty, nonEmpty, rows, rejected int
	cifs := map[string]int{}
	fieldWidths := map[int]int{}
	var samples []string

	for _, m := range metas {
		p := byName[m.Name]
		st, err := os.Stat(p)
		if err != nil {
			t.Errorf("stat %s: %v", m.Name, err)
			continue
		}
		if st.Size() == 0 {
			empty++
			continue
		}
		nonEmpty++

		f, err := os.Open(p)
		if err != nil {
			t.Errorf("open %s: %v", m.Name, err)
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			fieldWidths[len(strings.Split(line, ","))]++
			c, err := ParseLine(line)
			if err != nil {
				rejected++
				if len(samples) < 5 {
					samples = append(samples, m.Name+": "+err.Error())
				}
				continue
			}
			rows++
			cifs[c.CIF]++
		}
		f.Close() //nolint:errcheck
	}

	t.Logf("files: %d total, %d non-empty, %d empty", len(metas), nonEmpty, empty)
	t.Logf("rows: %d parsed, %d rejected", rows, rejected)
	t.Logf("distinct CIFs: %d", len(cifs))
	t.Logf("field-count distribution: %v", fieldWidths)
	for _, s := range samples {
		t.Logf("reject sample: %s", s)
	}

	if rows == 0 {
		t.Error("no rows parsed from any non-empty file — the column map is wrong")
	}
	// A handful of junk rows is expected in a feed this old; a majority is a decode bug.
	if rejected > rows {
		t.Errorf("more rejects (%d) than parsed rows (%d)", rejected, rows)
	}
}
