package core

import "testing"

// The HR role exists to monitor two things: the company's KPIs and its people. The
// whole point of the role is how NARROW it is — it is the one role in the taxonomy
// that carries oversight without carrying sight of the book. A role matrix drifts by
// accretion (someone needs one more page, just this once), so the shape is asserted
// here rather than left to review.

func TestHRRoleExists(t *testing.T) {
	pages, ok := RolePages["hr"]
	if !ok {
		t.Fatal("RolePages has no \"hr\" entry")
	}
	if len(pages) == 0 {
		t.Fatal("hr holds no pages, so an HR account would sign in and see nothing")
	}
}

// Every page key a role names must exist in the catalog. A typo here is silent: the
// role simply never grants the page, and nobody finds out until the person it was
// created for says a screen is missing.
func TestHRPagesAllExistInTheCatalog(t *testing.T) {
	catalog := map[string]bool{}
	for _, p := range AllCatalogPages() {
		catalog[p] = true
	}
	for _, p := range RolePages["hr"] {
		if !catalog[p] {
			t.Errorf("hr is granted %q, which is not a page in catalog.go", p)
		}
	}
}

// What HR must NOT hold. Each of these is a deliberate exclusion recorded in
// buildRolePages, and each would be an easy, plausible-sounding addition later.
func TestHRHoldsNoCustomerLendingOrMoneyPages(t *testing.T) {
	forbidden := map[string]string{
		"customer360":      "a customer's whole financial life; HR has no reason to open one",
		"admin_users":      "the page that grants roles and resets passwords, not a monitoring page",
		"admin_api_keys":   "system administration",
		"settings":         "system administration",
		"reports":          "the bulk export engine, which is BI-only by O3's 2026-08-17 decision",
		"loans":            "the loan book",
		"credit_portfolio": "the loan book",
		"cards":            "the card book",
		"finance":          "company money",
		"income":           "company money",
		"transactions":     "customer transactions",
		"statements":       "customer statements",
		"executive":        "the executive cockpit; HR is not a management role",
		"collections":      "customers in arrears",
		"recovery":         "customers in recovery",
		"crm_contacts":     "the customer contact book",
		"uploads":          "bulk data import, a write",
	}
	for _, p := range RolePages["hr"] {
		if why, bad := forbidden[p]; bad {
			t.Errorf("hr is granted %q — excluded because it is %s", p, why)
		}
	}
}

// HR is not management. managementRoles is what opens the General Overview and the
// executive dashboards, and it is also what /api/overview is mounted behind. HR
// monitoring headcount and KPIs is not the same thing as HR reading the book.
func TestHRIsNotAManagementRole(t *testing.T) {
	if IsManagement("hr") {
		t.Error("hr is in managementRoles, which would open the executive dashboards to it")
	}
}

// DataScopeForRole gives ScopeAll to anything ending in "_head" or starting with
// "head_". "hr" does neither, so it is ScopeOwn — which is the right default, and is
// also why the People Directory does its own thing: the staff register is HR's own
// subject matter, so people.go deliberately does not row-scope it, while every
// OTHER module HR might later be granted would still scope it to its own rows.
//
// This is pinned because renaming the role to "hr_head" would silently widen it
// across every module in the product.
func TestHRRoleNameDoesNotGrantSeeAllRows(t *testing.T) {
	if SeesAllRows("hr") {
		t.Error("the role name \"hr\" now matches the _head/head_ rule in DataScopeForRole, " +
			"which widens row visibility in every module it is ever granted")
	}
}

// The People Directory is a read page and must not be confused with the User
// Management page that writes the same table.
func TestPeopleDirectoryIsItsOwnPageKey(t *testing.T) {
	catalog := map[string]bool{}
	for _, p := range AllCatalogPages() {
		catalog[p] = true
	}
	if !catalog["people_directory"] {
		t.Fatal("people_directory is not in the page catalog")
	}
	if !catalog["admin_users"] {
		t.Fatal("admin_users vanished from the catalog, so this test no longer proves the split")
	}

	held := map[string]bool{}
	for _, p := range RolePages["hr"] {
		held[p] = true
	}
	if !held["people_directory"] {
		t.Error("hr does not hold people_directory, which is the role's reason to exist")
	}
}
