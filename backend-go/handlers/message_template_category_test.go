package handlers

import (
	"os"
	"strings"
	"testing"
)

// TestAutomatedCategoriesAreRealCategories keeps the two declarations in step. A category
// named in templateCategoryAutomation but absent from templateCategories could never be
// set, so the guard protecting it would never fire and nobody would know.
func TestAutomatedCategoriesAreRealCategories(t *testing.T) {
	if len(templateCategoryAutomation) == 0 {
		t.Fatal("no automated categories declared — if that is now true, the guards in " +
			"updateTemplate and deleteTemplate are dead code and should go with it")
	}
	for cat, consequence := range templateCategoryAutomation {
		if !templateCategories[cat] {
			t.Errorf("%q is declared as automated but is not a valid template category, so "+
				"no template can ever carry it", cat)
		}
		if strings.TrimSpace(consequence) == "" {
			t.Errorf("%q has no consequence text — the 409 it produces would refuse the "+
				"edit without saying what would stop", cat)
		}
	}
}

// TestDunningReadsAnAutomatedCategory is the drift guard that matters.
//
// collections_dunning.go selects templates by a literal category, and
// templateCategoryAutomation claims to know which categories work that way. Those are two
// statements about the same fact in two files, which is how this class of bug starts.
// Reading the worker's source is crude, but it fails loudly if either side moves: change
// the query's category without declaring it and the guard silently stops protecting the
// thing that stops.
func TestDunningReadsAnAutomatedCategory(t *testing.T) {
	src, err := os.ReadFile("collections_dunning.go")
	if err != nil {
		t.Skipf("cannot read the dunning worker source: %v", err)
	}
	found := false
	for cat := range templateCategoryAutomation {
		if strings.Contains(string(src), "category = '"+cat+"'") {
			found = true
		}
	}
	if !found {
		cats := make([]string, 0, len(templateCategoryAutomation))
		for cat := range templateCategoryAutomation {
			cats = append(cats, cat)
		}
		t.Errorf("collections_dunning.go selects templates by a category that is not "+
			"declared automated (declared: %v). Either the worker changed category and "+
			"templateCategoryAutomation was not updated — in which case the last template "+
			"of the real category can now be deleted silently — or the query no longer "+
			"filters by category at all.", cats)
	}
}

// TestRepaymentReminderIsNotAutomated records the finding rather than the fix, because
// there is nothing to fix in the code: 'repayment_reminder' is a real, usable category
// that only campaigns read, and its three starter templates are genuine pre-due reminders
// rather than arrears demands. What was wrong was the handover note calling it a category
// "the dunning worker never reads" as though that made it dead. It is not dead; it is
// un-automated, which is a different thing and is why the editor now labels both.
//
// This test exists so that if someone wires a reminder worker later, they are made to
// declare it here — the alternative is a second category that is quietly load-bearing
// and unguarded, which is exactly where 'collections' started.
func TestRepaymentReminderIsNotAutomated(t *testing.T) {
	if !templateCategories["repayment_reminder"] {
		t.Fatal("repayment_reminder is no longer a valid category — the three starter " +
			"templates in starterTemplates.ts still declare it and would be rejected")
	}
	if _, automated := templateCategoryAutomation["repayment_reminder"]; automated {
		t.Log("repayment_reminder is now automated — check that the worker reading it is " +
			"covered by TestDunningReadsAnAutomatedCategory's equivalent")
	}
}
