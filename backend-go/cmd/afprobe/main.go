// One-off AppsFlyer sync probe: loads .env, opens the DB, and runs a single
// scheduled-style SyncAll so the mirror can be verified end-to-end before the
// server is redeployed. Not part of the server build.
//
//	go run ./cmd/afprobe          # 30-day window (default)
//	go run ./cmd/afprobe 90       # custom window in days
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/o3c/workspace/appsflyer"
	"github.com/o3c/workspace/appsflyersync"
	"github.com/o3c/workspace/core"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	cfg, err := core.LoadConfig()
	if err != nil {
		fmt.Println("config:", err)
		os.Exit(1)
	}
	db, err := core.Open(cfg)
	if err != nil {
		fmt.Println("db open:", err)
		os.Exit(1)
	}

	window := 30
	if len(os.Args) > 1 {
		if n, e := strconv.Atoi(os.Args[1]); e == nil && n > 0 {
			window = n
		}
	}

	token := os.Getenv("APPSFLYER_API_TOKEN")
	ios := env("APPSFLYER_IOS_APP_ID", appsflyer.DefaultIOSAppID)
	android := env("APPSFLYER_ANDROID_APP_ID", appsflyer.DefaultAndroidAppID)
	apps := []appsflyer.App{{AppID: ios, Platform: "ios"}, {AppID: android, Platform: "android"}}

	fmt.Printf("AppsFlyer probe: window=%dd apps=%v configured=%v\n", window, []string{ios, android}, token != "")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	client := appsflyer.New(token)
	res, err := appsflyersync.SyncAll(ctx, db, client, apps, "manual", window, sql.NullInt64{})
	if err != nil {
		fmt.Println("SYNC ERROR:", err)
		os.Exit(1)
	}
	fmt.Printf("OK: apps=%d daily_rows=%d event_rows=%d from=%s to=%s\n",
		res.Apps, res.DailyRows, res.EventRows, res.From, res.To)
}
