package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The allocation is the whole tool, so it is tested rather than trusted. Each case
// uses a temporary directory, because the real migrations/ directory is shared with
// other sessions and a test that wrote into it would be the hazard it is preventing.

func write(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("-- x\n"), 0o644); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
}

func TestClaimTakesTheNextFreeNumber(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "365_one.sql")
	write(t, dir, "366_two.sql")

	_, highest, err := claimedNumbers(dir)
	if err != nil {
		t.Fatalf("claimedNumbers: %v", err)
	}
	if highest != 366 {
		t.Fatalf("highest = %d, want 366", highest)
	}

	n, path, err := claim(dir, "a_thing", highest+1)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if n != 367 {
		t.Errorf("claimed %d, want 367", n)
	}
	if filepath.Base(path) != "367_a_thing.sql.draft" {
		t.Errorf("created %s, want 367_a_thing.sql.draft", filepath.Base(path))
	}
}

// The bug this tool exists for. A number claimed by somebody else's DRAFT is not free,
// even though no .sql holds it yet — that minutes-long window is exactly where 358 and
// 364 were lost.
func TestADraftClaimIsRespected(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "366_two.sql")
	write(t, dir, "367_someone_elses_work_in_progress.sql.draft")

	taken, highest, err := claimedNumbers(dir)
	if err != nil {
		t.Fatalf("claimedNumbers: %v", err)
	}
	if _, ok := taken[367]; !ok {
		t.Error("367 is held by a draft and must count as taken; this is the collision window")
	}
	if highest != 367 {
		t.Errorf("highest = %d, want 367 — a draft raises the high-water mark", highest)
	}

	n, _, err := claim(dir, "mine", highest+1)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if n != 368 {
		t.Errorf("claimed %d, want 368 — it stepped over the peer's draft", n)
	}
}

// Two claims in a row must never return the same number, which is what O_EXCL buys.
func TestTwoClaimsNeverCollide(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "100_base.sql")

	seen := map[int]bool{}
	for i := 0; i < 5; i++ {
		_, highest, err := claimedNumbers(dir)
		if err != nil {
			t.Fatalf("claimedNumbers: %v", err)
		}
		n, _, err := claim(dir, "x", highest+1)
		if err != nil {
			t.Fatalf("claim %d: %v", i, err)
		}
		if seen[n] {
			t.Fatalf("number %d handed out twice", n)
		}
		seen[n] = true
	}
	if len(seen) != 5 {
		t.Errorf("got %d distinct numbers from 5 claims", len(seen))
	}
}

// A claim that starts at an already-taken number still lands somewhere free, which is
// the O_EXCL fallback: the listing can be stale by the time the file is created.
func TestClaimStepsOverAStaleListing(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "200_taken.sql")
	write(t, dir, "201_also_taken.sql.draft")

	n, _, err := claim(dir, "mine", 200) // deliberately starting on a taken number
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if n != 202 {
		t.Errorf("claimed %d, want 202", n)
	}
}

func TestPromoteMakesTheDraftLive(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "300_thing.sql.draft")

	final, err := promote(dir, 300)
	if err != nil {
		t.Fatalf("promote: %v", err)
	}
	if final != "300_thing.sql" {
		t.Errorf("promoted to %s, want 300_thing.sql", final)
	}
	if _, err := os.Stat(filepath.Join(dir, "300_thing.sql")); err != nil {
		t.Errorf("the live file is not there: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "300_thing.sql.draft")); !os.IsNotExist(err) {
		t.Error("the draft is still there; promote should rename, not copy")
	}
}

// Promotion must refuse rather than create the collision the tool prevents. A peer can
// land a .sql on your number while your draft sits unfinished.
func TestPromoteRefusesToCreateACollision(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "301_mine.sql.draft")
	write(t, dir, "301_theirs_landed_first.sql")

	if _, err := promote(dir, 301); err == nil {
		t.Fatal("promote succeeded and created a duplicate 301; it must refuse")
	}
	if _, err := os.Stat(filepath.Join(dir, "301_mine.sql.draft")); err != nil {
		t.Error("the draft was consumed by a failed promote; it must be left alone")
	}
}

// The suffix is load-bearing: .sql.draft must not end in .sql, because both the
// //go:embed pattern and migrate.Apply select on that suffix. If this ever changed, a
// claimed-but-unfinished migration would be applied by the next deploy.
func TestDraftSuffixIsInvisibleToTheMigrator(t *testing.T) {
	if filepath.Ext(draftSuffix) == ".sql" {
		t.Fatal("the draft suffix now ends in .sql, so drafts would be embedded and applied")
	}
	name := "368_x" + draftSuffix
	if len(name) > 4 && name[len(name)-4:] == ".sql" {
		t.Fatal("a draft filename ends in .sql; the migrator would pick it up")
	}
}
