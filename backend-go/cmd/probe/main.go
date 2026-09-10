// One-off, read-only Udara probe: enumerates the CBS API surface (ProbeAll) or hunts
// for the per-loan detail/schedule endpoint (ProbeDetail), using the same credentials
// the sync worker uses. Not part of the server build (the deploy exe builds from `.`).
//
//	go run ./cmd/probe          # ProbeAll  — endpoint surface + record counts + fields
//	go run ./cmd/probe detail   # ProbeDetail — per-account detail / repayment schedule
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/o3c/workspace/cbssync"
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
		fmt.Println("NOT CONFIGURED — missing UDARA360_BASE_URL/CLIENT_ID/CLIENT_SECRET")
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// get <path> [rawquery] — authenticated GET against an arbitrary Udara path, so we
	// can test the REAL endpoint names discovered in the API docs (viewloanschedule,
	// Report/*) rather than the guessed ones ProbeAll/Detail tried.
	if len(os.Args) > 2 && os.Args[1] == "get" {
		path := os.Args[2]
		var q url.Values
		if len(os.Args) > 3 {
			q, _ = url.ParseQuery(os.Args[3])
		}
		raw, code, err := c.Do(ctx, "GET", path, nil, q)
		fmt.Printf("HTTP %d  %s?%s\n", code, path, q.Encode())
		if err != nil {
			fmt.Println("error:", err)
		}
		fmt.Println(string(raw))
		return
	}

	var res map[string]any
	if len(os.Args) > 1 && os.Args[1] == "detail" {
		res = cbssync.ProbeDetail(ctx, c)
	} else {
		res = cbssync.ProbeAll(ctx, c)
	}
	b, _ := json.MarshalIndent(res, "", "  ")
	fmt.Println(string(b))
}
