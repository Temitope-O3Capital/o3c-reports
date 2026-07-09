package scraper

import "context"

type RateResult struct {
	Currency string
	Buy      float64
	Sell     float64
}

type Source interface {
	Name() string
	Fetch(ctx context.Context) ([]RateResult, error)
}

// Currencies defines the set of currencies to track. Adding a new currency
// here is the only code change required — no parser changes needed.
var Currencies = []string{"USD", "EUR", "GBP"}
