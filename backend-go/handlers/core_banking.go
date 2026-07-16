package handlers

import (
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/udara"
)

// RegisterCoreBanking mounts all Udara360 CBS proxy endpoints under /api/cbs.
// Every endpoint requires an authenticated O3C session (enforced by the caller).
// If the CBS client is not configured (missing credentials), endpoints return 503.
func RegisterCoreBanking(r chi.Router, u *udara.Client) {
	r.Get("/status", cbsStatus(u))

	// ── Account ──────────────────────────────────────────────────────────────
	r.Route("/account", func(r chi.Router) {
		r.Post("/create-customer", cbsProxy(u, "POST", "/api/account/v1/createcustomeraccount", false, true))
		r.Post("/create-virtual", cbsProxy(u, "POST", "/api/account/v1/createvirtualaccount", false, true))
		r.Post("/create", cbsProxy(u, "POST", "/api/account/v1/createaccount", false, true))
		r.Get("/search", cbsProxy(u, "GET", "/api/account/v1/SearchAccount", true, false))
		r.Get("/by-phone", cbsProxy(u, "GET", "/api/account/v1/GetAccountsByPhoneNumber", true, false))
		r.Get("/balance", cbsProxy(u, "GET", "/api/account/v1/getaccountbalancebyaccountnumber", true, false))
		r.Get("/balance-extended", cbsProxy(u, "GET", "/api/account/v1/GetExtendedBalanceByAccountNumber", true, false))
		r.Get("/detail", cbsProxy(u, "GET", "/api/account/v1/getbyaccountnumber", true, false))
		r.Put("/update-customer", cbsProxy(u, "PUT", "/api/account/v1/updatecustomeraccount", false, true))
		r.Put("/update-customer-info", cbsProxy(u, "PUT", "/api/account/v1/UpdateCustomerInformation", false, true))
		r.Put("/activate", cbsProxy(u, "PUT", "/api/account/v1/activate", false, true))
		r.Put("/deactivate", cbsProxy(u, "PUT", "/api/account/v1/deactivate", false, true))
		r.Put("/freeze", cbsProxy(u, "PUT", "/api/account/v1/freeze", false, true))
		r.Put("/unfreeze", cbsProxy(u, "PUT", "/api/account/v1/unfreeze", false, true))
		r.Put("/place-pnd", cbsProxy(u, "PUT", "/api/account/v1/placepnd", false, true))
		r.Put("/remove-pnd", cbsProxy(u, "PUT", "/api/account/v1/removepnd", false, true))
		r.Put("/place-pnc", cbsProxy(u, "PUT", "/api/account/v1/placepnc", false, true))
		r.Put("/remove-pnc", cbsProxy(u, "PUT", "/api/account/v1/removepnc", false, true))
		r.Get("/search-customers", cbsProxy(u, "GET", "/api/Account/v1/SearchIndividualCustomers", true, false))
		r.Get("/search-groups", cbsProxy(u, "GET", "/api/Account/v1/SearchGroupCustomers", true, false))
		r.Post("/create-group", cbsProxy(u, "POST", "/api/Account/v1/CreateGroupCustomerInformation", false, true))
		r.Put("/update-group", cbsProxy(u, "PUT", "/api/Account/v1/UpdateGroupCustomerInformation", false, true))
		r.Get("/search-officers", cbsProxy(u, "GET", "/api/account/v1/SearchAccountOfficers", true, false))
	})

	// ── Overdraft ─────────────────────────────────────────────────────────────
	r.Route("/overdraft", func(r chi.Router) {
		r.Post("/add", cbsProxy(u, "POST", "/api/accountoverdraft/v1/add", false, true))
		r.Put("/update", cbsProxy(u, "PUT", "/api/accountoverdraft/v1/update", false, true))
		r.Put("/activate", cbsProxy(u, "PUT", "/api/accountoverdraft/v1/activate", false, true))
		r.Put("/deactivate", cbsProxy(u, "PUT", "/api/accountoverdraft/v1/deactivate", false, true))
		r.Get("/search", cbsProxy(u, "GET", "/api/AccountOverdraft/v1/Search", true, false))
	})

	// ── Lien ──────────────────────────────────────────────────────────────────
	r.Route("/lien", func(r chi.Router) {
		r.Post("/place", cbsProxy(u, "POST", "/api/accountlien/v1/placelien", false, true))
		r.Post("/update", cbsProxy(u, "POST", "/api/accountlien/v1/updatelien", false, true))
		r.Post("/remove", cbsProxy(u, "POST", "/api/accountlien/v1/unplacelien", false, true))
	})

	// ── KYC ───────────────────────────────────────────────────────────────────
	r.Route("/kyc", func(r chi.Router) {
		r.Post("/validate-bvn", cbsProxy(u, "POST", "/api/Operations/v1/KYC/ValidateBVN", false, true))
		r.Post("/validate-nin", cbsProxy(u, "POST", "/api/Operations/v1/KYC/ValidateNIN", false, true))
		r.Post("/validate-tin", cbsProxy(u, "POST", "/api/Operations/v1/KYC/ValidateTIN", false, true))
		r.Post("/validate-cac", cbsProxy(u, "POST", "/api/Operations/v1/KYC/ValidateCAC", false, true))
	})

	// ── Operations ────────────────────────────────────────────────────────────
	r.Route("/operations", func(r chi.Router) {
		r.Get("/till-accounts", cbsProxy(u, "GET", "/api/Operations/v1/SearchTillAccounts", true, false))
		r.Get("/till-balance", cbsProxy(u, "GET", "/api/Operations/v1/GetTillBalanceByAccountNumber", true, false))
		r.Post("/send-sms", cbsProxy(u, "POST", "/api/Operations/v1/SendSMS", false, true))
		r.Post("/send-email", cbsProxy(u, "POST", "/api/Operations/v1/SendEmail", false, true))
	})

	// ── Fixed Deposit ─────────────────────────────────────────────────────────
	r.Route("/fd", func(r chi.Router) {
		r.Post("/add", cbsProxy(u, "POST", "/api/fixeddepositaccount/v1/add", false, true))
		r.Post("/top-up", cbsProxy(u, "POST", "/api/fixeddepositaccount/v1/topup", false, true))
		r.Post("/liquidate", cbsProxy(u, "POST", "/api/fixeddepositaccount/v1/liquidate", false, true))
		r.Put("/update", cbsProxy(u, "PUT", "/api/fixeddepositaccount/v1/update", false, true))
		r.Get("/search", cbsProxy(u, "GET", "/api/FixedDepositAccount/v1/Search", true, false))
	})

	// ── Savings ───────────────────────────────────────────────────────────────
	r.Route("/savings", func(r chi.Router) {
		r.Post("/add", cbsProxy(u, "POST", "/api/savingsaccount/v1/frequentsavings/add", false, true))
		r.Post("/top-up", cbsProxy(u, "POST", "/api/savingsaccount/v1/frequentsavings/topup", false, true))
		r.Post("/liquidate", cbsProxy(u, "POST", "/api/savingsaccount/v1/frequentsavings/liquidate", false, true))
		r.Put("/update", cbsProxy(u, "PUT", "/api/savingsaccount/v1/frequentsavings/update", false, true))
		r.Get("/search", cbsProxy(u, "GET", "/api/Savingsaccount/v1/FrequentSavings/Search", true, false))
	})

	// ── Loan Account ──────────────────────────────────────────────────────────
	r.Route("/loan", func(r chi.Router) {
		r.Post("/add", cbsProxy(u, "POST", "/api/loanaccount/v1/add", false, true))
		r.Post("/disburse", cbsProxy(u, "POST", "/api/loanaccount/v1/disburseloan", false, true))
		r.Post("/repay", cbsProxy(u, "POST", "/api/loanaccount/v1/repayloan", false, true))
		r.Post("/early-repay", cbsProxy(u, "POST", "/api/loanaccount/v1/EarlyRepaymentLoan", false, true))
		r.Put("/update", cbsProxy(u, "PUT", "/api/loanaccount/v1/update", false, true))
		r.Get("/search", cbsProxy(u, "GET", "/api/LoanAccount/v1/Search", true, false))
		r.Get("/schedule", cbsProxy(u, "GET", "/api/LoanAccount/v1/viewloanschedule", true, false))
	})

	// ── Bills Payments ────────────────────────────────────────────────────────
	r.Route("/bills", func(r chi.Router) {
		r.Get("/billers", cbsProxy(u, "GET", "/api/Bills/v1/Billers", false, false))
		r.Get("/customer-info", cbsProxy(u, "GET", "/api/Bills/v1/GetCustomerInformation", true, false))
		r.Get("/token", cbsProxy(u, "GET", "/api/Bills/v1/GetToken", true, false))
		r.Get("/search", cbsProxy(u, "GET", "/api/Bills/v1/Search", true, false))
		r.Post("/vend", cbsProxy(u, "POST", "/api/bills/v1/vend", false, true))
		r.Post("/tsq", cbsProxy(u, "POST", "/api/bills/v1/TSQ", false, true))
	})

	// ── Postings ──────────────────────────────────────────────────────────────
	r.Route("/postings", func(r chi.Router) {
		r.Post("/post-transaction", cbsProxy(u, "POST", "/api/postings/v1/posttransaction", false, true))
		r.Post("/post", cbsProxy(u, "POST", "/api/postings/v1/post", false, true))
		r.Post("/reverse", cbsProxy(u, "POST", "/api/postings/v1/reversetransaction", false, true))
		r.Post("/close-account", cbsProxy(u, "POST", "/api/postings/v1/closeaccount", false, true))
	})

	// ── Transfer ──────────────────────────────────────────────────────────────
	r.Route("/transfer", func(r chi.Router) {
		r.Get("/name-enquiry", cbsProxy(u, "GET", "/api/transfer/v1/NameEnquiry", true, false))
		r.Get("/banks", cbsProxy(u, "GET", "/api/Transfer/v1/Banks", false, false))
		r.Get("/tsq", cbsProxy(u, "GET", "/api/Transfer/v1/TSQ", true, false))
		r.Get("/tsq-local", cbsProxy(u, "GET", "/api/Transfer/v1/TSQ/Local", true, false))
		r.Get("/settlement-details", cbsProxy(u, "GET", "/api/Transfer/v1/GetSettlementAccountDetails", true, false))
		r.Post("/local", cbsProxy(u, "POST", "/api/transfer/v1/localfundtransfer", false, true))
		r.Post("/outward", cbsProxy(u, "POST", "/api/transfer/v1/outwardtransfer", false, true))
	})

	// ── Reports ───────────────────────────────────────────────────────────────
	r.Route("/reports", func(r chi.Router) {
		r.Get("/statement", cbsProxy(u, "GET", "/api/Report/v1/RequestCustomerAccountStatement", true, false))
		r.Get("/export-statement", cbsProxy(u, "GET", "/api/Report/v1/ExportCustomerStatement", true, false))
		r.Get("/receipt", cbsProxy(u, "GET", "/api/Report/v1/GetTransactionReceipt", true, false))
		r.Get("/account-history", cbsProxy(u, "GET", "/api/Report/v1/RequestCustomerAccountHistoryReport", true, false))
		r.Get("/call-over", cbsProxy(u, "GET", "/api/Report/v1/GetTransactionCallOverReport", true, false))
		r.Get("/loan-expectation", cbsProxy(u, "GET", "/api/Report/v1/GetLoanExpectationReport", false, false))
		r.Get("/loan-tracking", cbsProxy(u, "GET", "/api/Report/v1/GetLoanTrackingReport", true, false))
		r.Get("/savings-accrual", cbsProxy(u, "GET", "/api/Report/v1/GetSavingsAccrualHistory", true, false))
	})

	// ── Products ──────────────────────────────────────────────────────────────
	r.Get("/products", cbsProxy(u, "GET", "/api/Product/v1/SearchProducts", true, false))

	// ── Limits ────────────────────────────────────────────────────────────────
	r.Route("/limit", func(r chi.Router) {
		r.Put("/account", cbsProxy(u, "PUT", "/api/Limit/v1/AddUpdateAccountLimit", false, true))
		r.Get("/account", cbsProxy(u, "GET", "/api/Limit/v1/GetAccountLimit", true, false))
		r.Post("/card", cbsProxy(u, "POST", "/api/Limit/v1/AddCardLimit", false, true))
		r.Put("/card", cbsProxy(u, "PUT", "/api/Limit/v1/UpdateCardLimit", false, true))
		r.Get("/card-configured", cbsProxy(u, "GET", "/api/Limit/v1/GetConfiguredCardLimitByCardId", true, false))
		r.Get("/card-current", cbsProxy(u, "GET", "/api/Limit/v1/GetCurrentCardTransactionLimitByCardId", true, false))
	})

	// ── Cards — Interswitch ────────────────────────────────────────────────────
	r.Route("/cards/interswitch", func(r chi.Router) {
		r.Post("/link-instant", cbsProxy(u, "POST", "/api/Card/v1/Interswitch/LinkInstantCard", false, true))
		r.Post("/issue", cbsProxy(u, "POST", "/api/Card/v1/Interswitch/IssueCard", false, true))
		r.Put("/unlink-instant", cbsProxy(u, "PUT", "/api/Card/v1/Interswitch/UnlinkInstantCard", false, true))
		r.Put("/status", cbsProxy(u, "PUT", "/api/Card/v1/Interswitch/UpdateCardStatus", false, true))
		r.Put("/channel-access", cbsProxy(u, "PUT", "/api/Card/v1/Interswitch/UpdateCardChannelAccess", false, true))
		r.Get("/single", cbsProxy(u, "GET", "/api/Card/v1/Interswitch/GetSingleCard", true, false))
		r.Get("/search", cbsProxy(u, "GET", "/api/Card/v1/Interswitch/Search", true, false))
		r.Get("/search-account", cbsProxy(u, "GET", "/api/Card/v1/Interswitch/SearchCardAccount", true, false))
		r.Get("/by-customer", cbsProxy(u, "GET", "/api/Card/v1/Interswitch/GetCardAccountByCustomerId", true, false))
	})

	// ── Cards — Providus ──────────────────────────────────────────────────────
	r.Route("/cards/providus", func(r chi.Router) {
		r.Get("/search", cbsProxy(u, "GET", "/api/Card/v1/Providus/SearchCards", true, false))
		r.Put("/pin", cbsProxy(u, "PUT", "/api/Card/v1/Providus/SetCardPIN", false, true))
		r.Put("/block", cbsProxy(u, "PUT", "/api/Card/v1/Providus/BlockUnblockCard", false, true))
		r.Post("/instant", cbsProxy(u, "POST", "/api/Card/v1/Providus/RequestInstantCard", false, true))
		r.Post("/virtual", cbsProxy(u, "POST", "/api/Card/v1/Providus/RequestVirtualCard", false, true))
	})

	// ── POS Instant Settlement ────────────────────────────────────────────────
	r.Route("/pos", func(r chi.Router) {
		r.Post("/create", cbsProxy(u, "POST", "/api/terminal/v1/Create", false, true))
		r.Post("/create-bulk", cbsProxy(u, "POST", "/api/terminal/v1/create-bulk", false, true))
		r.Post("/settle", cbsProxy(u, "POST", "/api/terminal/v1/settle", false, true))
		r.Put("/update", cbsProxy(u, "PUT", "/api/terminal/v1/Update", false, true))
		r.Put("/update-status", cbsProxy(u, "PUT", "/api/terminal/v1/update-status", false, true))
		r.Put("/update-settlement", cbsProxy(u, "PUT", "/api/terminal/v1/update-settlement-account", false, true))
		r.Get("/link-history", cbsProxy(u, "GET", "/api/terminal/v1/link-history", true, false))
		r.Get("/stock-report", cbsProxy(u, "GET", "/api/terminal/v1/stock-report", true, false))
		r.Get("/search", cbsProxy(u, "GET", "/api/terminal/v1/Search", true, false))
	})
}

// cbsStatus returns connection health and configuration status.
func cbsStatus(u *udara.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !u.IsConfigured() {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]any{
				"configured": false,
				"message":    "Set UDARA360_CLIENT_ID, UDARA360_CLIENT_SECRET, and UDARA360_BASE_URL to enable CBS integration",
			})
			return
		}
		// Probe the CBS with a lightweight auth ping.
		_, statusCode, err := u.Do(r.Context(), "GET", "/api/Transfer/v1/Banks", nil, nil)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]any{"configured": true, "connected": false, "error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"configured": true,
			"connected":  statusCode < 500,
		})
	}
}

// cbsProxy creates a handler that transparently proxies a request to Udara360.
//
//   - passQuery: forward the incoming URL query string to Udara360 (used for GET endpoints).
//   - passBody: decode and forward the incoming JSON body (used for POST/PUT endpoints).
func cbsProxy(u *udara.Client, method, udaraPath string, passQuery, passBody bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !u.IsConfigured() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"error":"CBS not configured","hint":"Set UDARA360_CLIENT_ID, UDARA360_CLIENT_SECRET, and UDARA360_BASE_URL"}`)) //nolint:errcheck
			return
		}

		var body any
		if passBody && r.Body != nil {
			var raw json.RawMessage
			if err := json.NewDecoder(r.Body).Decode(&raw); err == nil && len(raw) > 0 {
				body = raw
			}
		}

		var query url.Values
		if passQuery {
			query = r.URL.Query()
		}

		data, statusCode, err := u.Do(r.Context(), method, udaraPath, body, query)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()}) //nolint:errcheck
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		w.Write(data) //nolint:errcheck
	}
}
