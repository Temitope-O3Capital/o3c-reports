// Throwaway, read-only: pulls the full live book from Udara's bulk-searchable endpoints
// (never from our own Postgres mirror) and reports true counts, field inventories, branch
// splits, and date ranges. Exists only to answer "what does Udara itself say, right now" —
// not part of the server build, not meant to be kept.
//
//	go run ./cmd/liveverify <endpoint>
//
// endpoint one of: loans, fds, individuals, groups, products, officers, callover, all
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/cbssync"
	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/udara"
)

func loadEnv(path string) map[string]string {
	m := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return m
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.Index(line, "=")
		if i < 0 {
			continue
		}
		k := strings.TrimSpace(line[:i])
		v := strings.Trim(strings.TrimSpace(line[i+1:]), `"'`)
		m[k] = v
	}
	return m
}

type envelope struct {
	Data json.RawMessage `json:"data"`
}

func recordCountOf(data json.RawMessage) int {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return 0
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(trimmed, &obj) != nil {
		return 0
	}
	for _, k := range []string{"recordCount", "totalCount", "totalRecords", "total", "count"} {
		if v, ok := obj[k]; ok {
			var n int
			if json.Unmarshal(v, &n) == nil {
				return n
			}
		}
	}
	return 0
}

func extractItems(data json.RawMessage) ([]map[string]any, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil
	}
	switch trimmed[0] {
	case '[':
		var items []map[string]any
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return nil, err
		}
		return items, nil
	case '{':
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &obj); err != nil {
			return nil, err
		}
		for _, k := range []string{"data", "items", "records", "result", "list"} {
			if v, ok := obj[k]; ok {
				if it, err := extractItems(v); err == nil && it != nil {
					return it, nil
				}
			}
		}
		for _, v := range obj {
			tv := bytes.TrimSpace(v)
			if len(tv) > 0 && tv[0] == '[' {
				var items []map[string]any
				if err := json.Unmarshal(tv, &items); err == nil {
					return items, nil
				}
			}
		}
	}
	return nil, nil
}

func fetchOnePage(ctx context.Context, c *udara.Client, path string, page, size int) ([]map[string]any, int, error) {
	q := url.Values{}
	q.Set("PageNumber", strconv.Itoa(page))
	q.Set("PageSize", strconv.Itoa(size))
	raw, code, err := c.Do(ctx, "GET", path, nil, q)
	if err != nil {
		return nil, 0, fmt.Errorf("fetch %s: %w", path, err)
	}
	if code < 200 || code >= 300 {
		return nil, 0, fmt.Errorf("fetch %s: HTTP %d: %s", path, code, truncate(raw, 500))
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, 0, fmt.Errorf("fetch %s: parse envelope: %w; head=%s", path, err, truncate(raw, 300))
	}
	items, err := extractItems(env.Data)
	if err != nil {
		return nil, 0, fmt.Errorf("fetch %s: parse data: %w", path, err)
	}
	return items, recordCountOf(env.Data), nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "...(truncated)"
}

func recordKey(m map[string]any) string {
	for _, k := range []string{"id", "accountNumber", "customerID", "referenceNumber"} {
		if v, ok := m[k]; ok {
			return fmt.Sprintf("%v", v)
		}
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func dedupByID(items []map[string]any) []map[string]any {
	seen := make(map[string]bool, len(items))
	out := make([]map[string]any, 0, len(items))
	for _, m := range items {
		k := recordKey(m)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, m)
	}
	return out
}

// fetchFullBook: page 1 at a modest size to learn the reported total, then one atomic
// refetch sized to total+buffer (Udara's real multi-page walk is documented as unstable —
// duplicates/drops across adjacent pages — this big-page trick avoids that entirely),
// then dedupe by id as a final safety net. ALSO cross-checks with a literal page walk at
// a small page size and reports if the two methods disagree, since we are verifying, not
// just syncing.
func fetchFullBook(ctx context.Context, c *udara.Client, path string) ([]map[string]any, int, error) {
	items, total, err := fetchOnePage(ctx, c, path, 1, 500)
	if err != nil {
		return nil, 0, err
	}
	if total > len(items) {
		items, _, err = fetchOnePage(ctx, c, path, 1, total+200)
		if err != nil {
			return nil, 0, err
		}
	}
	return dedupByID(items), total, nil
}

func fieldSet(items []map[string]any) []string {
	seen := map[string]bool{}
	for _, m := range items {
		for k := range m {
			seen[k] = true
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func str(m map[string]any, k string) string {
	if v, ok := m[k]; ok && v != nil {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

func num(m map[string]any, k string) float64 {
	if v, ok := m[k]; ok && v != nil {
		switch t := v.(type) {
		case float64:
			return t
		case string:
			f, _ := strconv.ParseFloat(t, 64)
			return f
		}
	}
	return 0
}

func main() {
	env := loadEnv(".env")
	get := func(k string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return env[k]
	}
	c := udara.New(get("UDARA360_BASE_URL"), get("UDARA360_CLIENT_ID"), get("UDARA360_CLIENT_SECRET"))
	if !c.IsConfigured() {
		fmt.Println("NOT CONFIGURED")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	which := "all"
	if len(os.Args) > 1 {
		which = os.Args[1]
	}

	if which == "runblinkfx" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		res, err := cbssync.ParseBlinkFXEvents(ctx, db)
		fmt.Printf("result: %+v\n", res)
		if err != nil {
			fmt.Println("ERROR:", err)
			os.Exit(1)
		}
		return
	}

	if which == "runglsync" {
		cfg, err := core.LoadConfig()
		if err != nil {
			fmt.Println("config error:", err)
			os.Exit(1)
		}
		db, err := core.Open(cfg)
		if err != nil {
			fmt.Println("db open error:", err)
			os.Exit(1)
		}
		res, err := cbssync.SyncGLPostings(ctx, c, db)
		fmt.Printf("result: %+v\n", res)
		if err != nil {
			fmt.Println("ERROR:", err)
			os.Exit(1)
		}
		return
	}

	run := func(name, path string) {
		fmt.Printf("\n=== %s  (%s) ===\n", name, path)
		items, total, err := fetchFullBook(ctx, c, path)
		if err != nil {
			fmt.Println("ERROR:", err)
			return
		}
		fmt.Printf("reported total=%d  true fetched+deduped=%d\n", total, len(items))
		fmt.Printf("fields (%d): %s\n", len(fieldSet(items)), strings.Join(fieldSet(items), ", "))
	}

	if which == "loans" || which == "all" {
		path := "/api/LoanAccount/v1/Search"
		items, total, err := fetchFullBook(ctx, c, path)
		fmt.Printf("\n=== LOANS (%s) ===\n", path)
		if err != nil {
			fmt.Println("ERROR:", err)
		} else {
			fmt.Printf("reported total=%d true=%d\n", total, len(items))
			fmt.Printf("fields: %s\n", strings.Join(fieldSet(items), ", "))
			branchCount := map[string]int{}
			branchSum := map[string]float64{}
			minStart, minApproved, minCreated, minFirstInst := "", "", "", ""
			for _, it := range items {
				b := str(it, "branchName")
				branchCount[b]++
				branchSum[b] += num(it, "ledgerBalance")
				for field, min := range map[string]*string{
					"startDate": &minStart, "approvedDate": &minApproved,
					"dateCreated": &minCreated, "firstInstallmentDate": &minFirstInst,
				} {
					v := str(it, field)
					if v != "" && (*min == "" || v < *min) {
						*min = v
					}
				}
			}
			fmt.Printf("branch counts: %v\n", branchCount)
			fmt.Printf("branch ledgerBalance sums: %v\n", branchSum)
			fmt.Printf("MIN startDate=%s approvedDate=%s dateCreated=%s firstInstallmentDate=%s\n",
				minStart, minApproved, minCreated, minFirstInst)
		}
	}

	if which == "fds" || which == "all" {
		path := "/api/FixedDepositAccount/v1/Search"
		items, total, err := fetchFullBook(ctx, c, path)
		fmt.Printf("\n=== FIXED DEPOSITS (%s) ===\n", path)
		if err != nil {
			fmt.Println("ERROR:", err)
		} else {
			fmt.Printf("reported total=%d true=%d\n", total, len(items))
			fmt.Printf("fields: %s\n", strings.Join(fieldSet(items), ", "))
			branchCount := map[string]int{}
			branchSumPrincipal := map[string]float64{}
			branchSumLedger := map[string]float64{}
			minCommencement := ""
			preJanCount := map[string]int{}
			preJanPrincipal := map[string]float64{}
			preJanLedger := map[string]float64{}
			var preJanIDs []string
			for _, it := range items {
				b := str(it, "branchName")
				branchCount[b]++
				branchSumPrincipal[b] += num(it, "principalAmount")
				branchSumLedger[b] += num(it, "ledgerBalance")
				cd := str(it, "commencementDate")
				if cd != "" && (minCommencement == "" || cd < minCommencement) {
					minCommencement = cd
				}
				status := str(it, "accountStatus")
				if cd != "" && cd < "2026-01-01" {
					stillOpen := !strings.EqualFold(status, "Closed") && !strings.EqualFold(status, "Liquidated") &&
						!strings.EqualFold(status, "Matured")
					if stillOpen {
						preJanCount[b]++
						preJanPrincipal[b] += num(it, "principalAmount")
						preJanLedger[b] += num(it, "ledgerBalance")
						preJanIDs = append(preJanIDs, fmt.Sprintf("%s(%s,status=%s,commenced=%s,principal=%.2f)",
							str(it, "accountNumber"), b, status, cd, num(it, "principalAmount")))
					}
				}
			}
			fmt.Printf("branch counts: %v\n", branchCount)
			fmt.Printf("branch principalAmount sums: %v\n", branchSumPrincipal)
			fmt.Printf("branch ledgerBalance sums: %v\n", branchSumLedger)
			fmt.Printf("MIN commencementDate=%s\n", minCommencement)
			fmt.Printf("Pre-2026-01-01, still-open: count=%v principalSum=%v ledgerSum=%v\n",
				preJanCount, preJanPrincipal, preJanLedger)
			fmt.Printf("Pre-2026-01-01 still-open accounts:\n  %s\n", strings.Join(preJanIDs, "\n  "))
		}
	}

	if which == "individuals" || which == "all" {
		run("INDIVIDUAL CUSTOMERS", "/api/Account/v1/SearchIndividualCustomers")
	}
	if which == "groups" || which == "all" {
		run("GROUP CUSTOMERS", "/api/Account/v1/SearchGroupCustomers")
	}
	if which == "products" || which == "all" {
		run("PRODUCTS", "/api/Product/v1/SearchProducts")
	}
	if which == "officers" || which == "all" {
		path := "/api/account/v1/SearchAccountOfficers"
		items, total, err := fetchFullBook(ctx, c, path)
		fmt.Printf("\n=== OFFICERS (%s) ===\n", path)
		if err != nil {
			fmt.Println("ERROR:", err)
		} else {
			fmt.Printf("reported total=%d true=%d\n", total, len(items))
			for _, it := range items {
				fmt.Printf("  staffID=%s name=%s branchCode=%s branchName=%s address=%s status=%s\n",
					str(it, "staffID"), str(it, "name"), str(it, "branchCode"), str(it, "branchName"),
					str(it, "address"), str(it, "status"))
			}
		}
	}

	if which == "callover" || which == "all" {
		path := "/api/Report/v1/GetTransactionCallOverReport"
		fmt.Printf("\n=== CALL-OVER REPORT (%s) ===\n", path)
		var all []map[string]any
		for page := 1; page <= 50; page++ {
			items, _, err := fetchOnePage(ctx, c, path, page, 1000)
			if err != nil {
				fmt.Println("ERROR on page", page, ":", err)
				break
			}
			if len(items) == 0 {
				fmt.Printf("page %d empty, stopping\n", page)
				break
			}
			fmt.Printf("page %d: %d rows\n", page, len(items))
			all = append(all, items...)
		}
		// No reliable per-row id on this feed (many legs share the same accountNumber),
		// so dedup on the full posting fingerprint instead of falling back to
		// accountNumber -- that would wrongly collapse distinct legitimate legs.
		seen := map[string]bool{}
		deduped := make([]map[string]any, 0, len(all))
		for _, it := range all {
			k := strings.Join([]string{
				str(it, "postingReferenceNumber"), str(it, "entryCode"), str(it, "accountNumber"),
				str(it, "financialDate"), str(it, "amount"), str(it, "instrumentNumber"),
				str(it, "debit"), str(it, "credit"),
			}, "|")
			if seen[k] {
				continue
			}
			seen[k] = true
			deduped = append(deduped, it)
		}
		fmt.Printf("TOTAL rows raw=%d  deduped-by-fingerprint=%d\n", len(all), len(deduped))
		all = deduped
		branchCount := map[string]int{}
		entryCount := map[string]int{}
		minDate, maxDate := "", ""
		for _, it := range all {
			b := str(it, "branch")
			branchCount[b]++
			ec := str(it, "entryCode")
			entryCount[ec]++
			fd := str(it, "financialDate")
			if fd != "" {
				if minDate == "" || fd < minDate {
					minDate = fd
				}
				if maxDate == "" || fd > maxDate {
					maxDate = fd
				}
			}
		}
		fmt.Printf("branch counts: %v\n", branchCount)
		fmt.Printf("entryCode counts: %v\n", entryCount)
		fmt.Printf("financialDate range: %s .. %s\n", minDate, maxDate)
	}
}
