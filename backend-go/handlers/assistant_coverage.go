package handlers

import (
	"context"

	"github.com/o3c/workspace/core"
)

// The modules the assistant could not see.
//
// Audited 2026-10-22: 21 tools read about 13 of the 386 tables in app, and seven
// of the sixteen modules in the page catalogue had no tool at all. Asked anything
// about a campaign, an email, a Paystack payment, a customer's lifecycle stage,
// the exchange rate or a public holiday, the assistant had nothing to call and
// said so -- which reads to staff as "it does not know", and is really "nobody
// gave it the table".
//
// Each tool here is deliberately a SUMMARY, not a row dump. Every token a tool
// returns is read back into the model on the next round at ~47 tok/s, so a tool
// that returns 800 tokens adds about 17 seconds to the answer. Counts, totals and
// a handful of rows beat a page of detail on a CPU-only box.

func assistantCoverageTools() []assistantTool {
	return []assistantTool{
		{
			Name: "get_fx_rates",
			Description: "The naira exchange rate we track: buy and sell for each currency, " +
				"and when it was last scraped. Use for 'what is the dollar rate', 'how much " +
				"is the pound today'. These are PARALLEL MARKET rates, not the CBN official " +
				"rate.",
			Params: map[string]any{"type": "object", "properties": map[string]any{
				"currency": map[string]any{"type": "string",
					"description": "Optional currency code, e.g. USD, GBP, EUR. Leave out for all of them."},
			}},
			// No page key: an exchange rate is public market information and every
			// desk asks for it. Nothing here is customer data.
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				cur := argStr(a, "currency")
				// One row per currency, the most recently scraped. DISTINCT ON is the
				// point: the table keeps history, and an unfiltered average of it would
				// quote a rate that was never offered on any day.
				rows, err := db.PGQuery(ctx, `
					SELECT DISTINCT ON (currency)
					       currency, buy, sell, source,
					       scraped_at::timestamp(0)::text AS scraped_at
					FROM fx_parallel_rates
					WHERE ($1 = '' OR currency ILIKE '%' || $1 || '%')
					ORDER BY currency, scraped_at DESC
					LIMIT 12`, cur)
				if err != nil {
					return nil, err
				}
				return map[string]any{
					"rates": rows, "count": len(rows),
					// Said every time, because quoting a parallel rate as the official
					// one in a bank is a materially wrong answer, not a loose one. The
					// CFA note is here because the scraper stores those per 1,000 and an
					// answer of "0.9 naira to the CFA" would look like a bug.
					"note": "PARALLEL MARKET rates (Aboki Forex), NOT the CBN official rate — say " +
						"so when quoting them, and give the scrape time. CFA francs are quoted " +
						"per 1,000. We do not hold the CBN official rate; say that plainly if " +
						"asked for it.",
				}, nil
			},
		},
		{
			Name: "get_campaign_performance",
			Description: "How our marketing campaigns did: how many contacts, sent, delivered, " +
				"opened, clicked and bounced, per campaign. Use for 'how did the last campaign " +
				"go', 'what is our open rate', 'which campaign performed best'.",
			Params: map[string]any{"type": "object", "properties": map[string]any{
				"limit": map[string]any{"type": "integer", "description": "How many recent campaigns, 1 to 15. Default 6."},
			}},
			Pages: []string{"campaigns"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				n := argInt(a, "limit", 6, 1, 15)
				// The counters on campaigns are maintained by the dispatcher, so this
				// needs no scan of the 43,889-row contact table.
				rows, err := db.PGQuery(ctx, `
					SELECT name, status, type, total_contacts,
					       sent_count, delivered_count, open_count, click_count, bounce_count,
					       COALESCE(started_at::date::text, scheduled_at::date::text, 'not scheduled') AS started
					FROM campaigns
					ORDER BY COALESCE(started_at, scheduled_at, created_at) DESC NULLS LAST
					LIMIT $1`, n)
				if err != nil {
					return nil, err
				}
				return map[string]any{"campaigns": rows, "count": len(rows),
					"note": "Counts are per campaign as the dispatcher recorded them. An open or " +
						"click count of zero on an SMS campaign is expected — only email is " +
						"tracked that way. Rates are not stored; work them out from these " +
						"counts and say which two numbers you divided."}, nil
			},
		},
		{
			Name: "get_email_activity",
			Description: "Email we have sent: how many queued, delivered, opened, bounced or " +
				"failed over a period, by kind. Use for 'did the statements go out', 'how many " +
				"emails bounced this week', 'is anything stuck'.",
			Params: map[string]any{"type": "object", "properties": map[string]any{
				"days": map[string]any{"type": "integer", "description": "How many days back, 1 to 365. Default 7."},
			}},
			Pages: []string{"mail"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 7, 1, 365)
				// ONE AXIS PER BREAKDOWN. kind x status repeated "queued" down the
				// status column, and the chart builder takes the first text column as
				// its x axis and would have silently merged those rows into one bar --
				// caught by TestChartExtraction, which checks for exactly that. Two
				// lists also cost fewer tokens than one grid.
				byStatus, err := db.PGQuery(ctx, `
					SELECT status, COUNT(*) AS messages,
					       COUNT(*) FILTER (WHERE opened_at IS NOT NULL)  AS opened,
					       COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced
					FROM mail_messages
					WHERE created_at >= now() - make_interval(days => $1)
					GROUP BY 1
					ORDER BY messages DESC
					LIMIT 8`, days)
				if err != nil {
					return nil, err
				}
				byKind, err := db.PGQuery(ctx, `
					SELECT kind, COUNT(*) AS messages
					FROM mail_messages
					WHERE created_at >= now() - make_interval(days => $1)
					GROUP BY 1
					ORDER BY messages DESC
					LIMIT 8`, days)
				if err != nil {
					return nil, err
				}
				// Anything that has been sending or queued for over a day is wedged,
				// not in flight. Surfaced separately because it is the one thing in
				// this tool somebody has to act on, and inside a status count it looks
				// like normal traffic.
				stuck, err := db.PGQuery(ctx, `
					SELECT COUNT(*) AS stuck_messages,
					       MIN(created_at)::date::text AS oldest
					FROM mail_messages
					WHERE status IN ('sending', 'queued')
					  AND created_at < now() - interval '1 day'`)
				if err != nil {
					return nil, err
				}
				out := map[string]any{"by_status": byStatus, "by_kind": byKind, "days": days,
					"note": "Counts of messages we recorded sending. 'opened' is only tracked for " +
						"email and only when the recipient loads images, so it is a floor."}
				if len(stuck) > 0 {
					out["wedged"] = stuck[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_payment_gateway_activity",
			Description: "Money through the payment gateway: how many card and transfer payments " +
				"succeeded or failed, the amounts and the fees, by channel. Use for 'how much " +
				"did we collect online', 'are payments failing', 'what are we paying in gateway " +
				"fees'.",
			Params: map[string]any{"type": "object", "properties": map[string]any{
				"days": map[string]any{"type": "integer", "description": "How many days back, 1 to 365. Default 30."},
			}},
			Pages: []string{"payments"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 30, 1, 365)
				// Split for the same reason as the email tool: status x channel repeated
				// "abandoned" down the status column and a chart would have merged those
				// bars into one.
				byStatus, err := db.PGQuery(ctx, `
					SELECT status,
					       COUNT(*)                         AS payments,
					       ROUND(SUM(amount_kobo)/100.0, 2) AS amount_ngn,
					       ROUND(SUM(fees_kobo)/100.0, 2)   AS fees_ngn
					FROM paystack_transactions
					WHERE COALESCE(paid_at, created_at_ps) >= now() - make_interval(days => $1)
					GROUP BY 1
					ORDER BY payments DESC
					LIMIT 8`, days)
				if err != nil {
					return nil, err
				}
				byChannel, err := db.PGQuery(ctx, `
					SELECT COALESCE(NULLIF(channel, ''), 'unknown') AS channel,
					       COUNT(*)                                 AS payments,
					       ROUND(SUM(amount_kobo)/100.0, 2)         AS amount_ngn
					FROM paystack_transactions
					WHERE COALESCE(paid_at, created_at_ps) >= now() - make_interval(days => $1)
					GROUP BY 1
					ORDER BY payments DESC
					LIMIT 8`, days)
				if err != nil {
					return nil, err
				}
				return map[string]any{"by_status": byStatus, "by_channel": byChannel, "days": days,
					"note": "Paystack only — this is not every payment the bank takes, and must not " +
						"be described as total collections. Amounts are what the customer was " +
						"charged; fees are what the gateway kept. Only the success rows are " +
						"money we received."}, nil
			},
		},
		{
			Name: "get_customer_lifecycle",
			Description: "Where our customers sit in their lifecycle: how many are active, " +
				"dormant or lapsed, their value tier, and how long since they last " +
				"transacted. Use for 'how many dormant customers do we have', 'what is our " +
				"retention looking like', 'how many high value customers are going quiet'.",
			Params: map[string]any{"type": "object", "properties": map[string]any{}},
			Pages:  []string{"retention"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				// TWO SMALL BREAKDOWNS, NOT ONE CROSS-TAB. bucket x value_tier is
				// twenty rows and cost ~575 tokens, about 12 seconds of re-prefill on
				// this box, to answer a question that is almost always about one axis:
				// "how many dormant customers" wants the bucket total, not dormant-and-
				// silver. Two lists of five beat one grid of twenty.
				byBucket, err := db.PGQuery(ctx, `
					SELECT bucket,
					       COUNT(*)                                 AS customers,
					       ROUND(AVG(days_since_txn))               AS avg_days_since_txn,
					       ROUND(SUM(lifetime_value_kobo)/100.0, 2) AS lifetime_value_ngn,
					       COUNT(*) FILTER (WHERE contactable)      AS contactable
					FROM customer_lifecycle
					WHERE measured
					GROUP BY 1
					ORDER BY customers DESC
					LIMIT 8`)
				if err != nil {
					return nil, err
				}
				byTier, err := db.PGQuery(ctx, `
					SELECT value_tier, COUNT(*) AS customers
					FROM customer_lifecycle
					WHERE measured
					GROUP BY 1
					ORDER BY customers DESC
					LIMIT 8`)
				if err != nil {
					return nil, err
				}
				cover, err := db.PGQuery(ctx, `
					SELECT COUNT(*)                                  AS parties_scored,
					       COUNT(*) FILTER (WHERE measured)          AS placed_in_a_bucket,
					       MAX(computed_at)::timestamp(0)::text      AS last_computed
					FROM customer_lifecycle`)
				if err != nil {
					return nil, err
				}
				out := map[string]any{"by_bucket": byBucket, "by_value_tier": byTier,
					"note": "Only parties the scorer could place are in the breakdowns; the rest " +
						"have too little history. Give the placed figure, not the scored one, " +
						"as the customer count. 'contactable' means we hold a usable phone or " +
						"email, NOT that they consented to marketing — we hold no marketing " +
						"consent, so never present these as a sendable audience."}
				if len(cover) > 0 {
					out["coverage"] = cover[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_public_holidays",
			Description: "Public holidays: which days the bank is closed, and what is coming up. " +
				"Use for 'when is the next public holiday', 'is Monday a working day', 'how " +
				"many holidays are left this year'.",
			Params: map[string]any{"type": "object", "properties": map[string]any{
				"days": map[string]any{"type": "integer", "description": "Look ahead this many days, 1 to 400. Default 90."},
			}},
			// No page key: the working calendar applies to everybody.
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 90, 1, 400)
				rows, err := db.PGQuery(ctx, `
					SELECT name, date::text AS date,
					       to_char(date, 'Day') AS weekday,
					       (date - current_date) AS days_away,
					       is_estimated
					FROM public_holidays
					WHERE date >= current_date
					  AND date <= current_date + make_interval(days => $1)
					ORDER BY date
					LIMIT 15`, days)
				if err != nil {
					return nil, err
				}
				return map[string]any{"holidays": rows, "count": len(rows), "looked_ahead_days": days,
					"note": "A holiday marked is_estimated is not yet gazetted — Islamic dates " +
						"move with the moon and are only confirmed close to the day. Say when " +
						"a date is estimated rather than stating it as fixed. The feed holds " +
						"no Islamic dates beyond 2031."}, nil
			},
		},
	}
}
