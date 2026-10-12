package handlers

import "testing"

// fmtKoboGo writes the amount a person reads in an approval alert, so it is worth
// pinning: the grouping loop and the sign are both easy to get subtly wrong, and a
// notification saying NGN 24,000 about a NGN 2,400,000 correction is worse than no
// notification at all.
//
// The sign sits before the currency, matching fmt.ts's fmtWhole — which had exactly
// this bug once and rendered a negative balance as "₦-1,447,246".
func TestManualPostingAmountReadsLikeMoney(t *testing.T) {
	cases := []struct {
		kobo int64
		want string
	}{
		{0, "NGN 0"},
		{100, "NGN 1"},
		{99900, "NGN 999"},
		{100000, "NGN 1,000"},
		{240000000, "NGN 2,400,000"},
		{123456789, "NGN 1,234,568"},     // rounds at the half-naira
		{123456749, "NGN 1,234,567"},     // and does not round below it
		{-240000000, "-NGN 2,400,000"},   // sign before the currency, never inside
		{-100000, "-NGN 1,000"},
	}
	for _, c := range cases {
		if got := fmtKoboGo(c.kobo); got != c.want {
			t.Errorf("fmtKoboGo(%d) = %q, want %q", c.kobo, got, c.want)
		}
	}
}
