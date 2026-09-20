package txnfeed

import "testing"

// A chunk must never be able to exceed PostgreSQL's parameter limit. Twelve
// monthly bulk drops (3,700-4,800 rows each) failed on exactly this between 2021
// and 2023 and were never retried, so the invariant is locked down here rather
// than left to be rediscovered.
func TestBatchStaysInsideParameterLimit(t *testing.T) {
	if txnBatchRows*perRow > maxStatementParams {
		t.Fatalf("a full chunk binds %d parameters, over the %d limit",
			txnBatchRows*perRow, maxStatementParams)
	}
	// A chunk so small it makes a bulk drop pathologically slow is also wrong.
	if txnBatchRows < 500 {
		t.Errorf("txnBatchRows = %d, unreasonably small", txnBatchRows)
	}
}

func TestChunkRanges(t *testing.T) {
	cases := []struct {
		total, size int
		want        [][2]int
	}{
		{0, 2000, nil},
		{1, 2000, [][2]int{{0, 1}}},
		{2000, 2000, [][2]int{{0, 2000}}},
		{2001, 2000, [][2]int{{0, 2000}, {2000, 2001}}},
		// The shape that used to fail outright: one file, 4,817 rows.
		{4817, 2000, [][2]int{{0, 2000}, {2000, 4000}, {4000, 4817}}},
	}
	for _, c := range cases {
		got := chunkRanges(c.total, c.size)
		if len(got) != len(c.want) {
			t.Errorf("chunkRanges(%d,%d) = %v, want %v", c.total, c.size, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("chunkRanges(%d,%d)[%d] = %v, want %v", c.total, c.size, i, got[i], c.want[i])
			}
		}
	}
}

// Every row must be covered exactly once, with no gap and no overlap — a silent
// gap here would drop transactions from a file that reported success.
func TestChunkRangesCoverEveryRow(t *testing.T) {
	const total = 4817
	next := 0
	for _, c := range chunkRanges(total, 2000) {
		if c[0] != next {
			t.Fatalf("gap or overlap: chunk starts at %d, expected %d", c[0], next)
		}
		if c[1] <= c[0] {
			t.Fatalf("empty chunk %v", c)
		}
		next = c[1]
	}
	if next != total {
		t.Fatalf("chunks covered %d rows, want %d", next, total)
	}
}
