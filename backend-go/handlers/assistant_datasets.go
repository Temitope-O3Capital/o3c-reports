package handlers

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
)

// One tool over every dataset, instead of one tool per question.
//
// The coverage audit on 2026-10-22 found 21 tools reading 13 of the 386 tables in
// app, and the obvious fix -- write a tool per blind module -- has a cost that
// grows without limit. Measured after adding six: the tool SCHEMAS reached 2,773
// tokens against the system prompt's 1,774, for a 4,547-token prefix and ~97
// seconds of cold prefill. Another twenty tools would double it. Coverage bought
// that way makes the assistant slower every time it gets broader.
//
// THE WORKSPACE ALREADY HAS THE CATALOGUE. export_datasets.go declares 54
// datasets -- every one the Reports & BI module can emit as a file -- each with
// its FROM clause, its static predicate, its declared filters, its date column,
// its row cap and its PII masking. Card PANs and BVNs are already truncated
// there, and crm_contacts' encrypted ID number is not exposed at all.
//
// So this is two tools, not fifty-four. The schemas cost a few hundred tokens
// once and the breadth is the registry's, which means a dataset added for the
// Reports module is answerable by the assistant the same day, with no change
// here.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not widen who can see what. Both tools are gated on the `reports` page,
// the same single guard as the export engine, because O3 concentrated data
// extraction in that module on purpose. An assistant that answered from these
// datasets for someone without the reports page would be a hole in that decision.
//
// It counts and groups rather than dumping rows. Every token a tool returns is
// re-read by the model at ~47 tok/s, so a hundred rows is half a minute of
// latency before a word appears. Sample rows are capped at five and off by
// default.
//
// It reuses buildExportQuery and buildExportCountQuery rather than assembling
// SQL. The predicates, the parameter binding and the masking are the export
// engine's, tested there; a second SQL path would drift from it and the drift
// would be invisible until a report and an answer disagreed.

// assistantDatasetMatch resolves a dataset from what somebody typed.
//
// Exact key first, then every word of the query having to appear somewhere in the
// key, label, module or description -- the same token-containment rule used for
// officer names, and for the same reason: people do not type identifiers.
func assistantDatasetMatch(q string) (exportDataset, []exportDataset) {
	q = strings.TrimSpace(strings.ToLower(q))
	if q == "" {
		return exportDataset{}, nil
	}
	if d, ok := exportDatasetByKey(q); ok {
		return d, nil
	}

	words := strings.Fields(assistantNameTokens(q))
	var hits []exportDataset
	for _, d := range exportDatasets {
		hay := strings.ToLower(d.Key + " " + d.Label + " " + d.Module + " " + d.Desc)
		all := len(words) > 0
		for _, w := range words {
			if !strings.Contains(hay, w) {
				all = false
				break
			}
		}
		if all {
			hits = append(hits, d)
		}
	}
	if len(hits) == 1 {
		return hits[0], nil
	}
	return exportDataset{}, hits
}

func assistantDatasetTools() []assistantTool {
	return []assistantTool{
		{
			Name: "list_workspace_datasets",
			Description: "What data the workspace holds. Lists the datasets available to query — " +
				"their name, the module they belong to and what they contain. Call this when " +
				"you do not know whether we hold something, when the question is about a part " +
				"of the business no other tool covers, or when the person asks what you can " +
				"look up.",
			Params: map[string]any{"type": "object", "properties": map[string]any{
				"search": map[string]any{"type": "string",
					"description": "Narrow to datasets matching these words, e.g. 'loan', 'card dispute', 'leave'. Leave out to list every module."},
			}},
			Pages: []string{"reports"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				q := strings.ToLower(strings.TrimSpace(argStr(a, "search")))
				words := strings.Fields(assistantNameTokens(q))

				// Unsearched, this would be 54 rows of label and description, which is
				// most of a thousand tokens for a list nobody asked to read. Grouping
				// to module counts answers "what do you have" in a tenth of that, and
				// the model can search once it knows which module it wants.
				if len(words) == 0 {
					byModule := map[string]int{}
					for _, d := range exportDatasets {
						byModule[d.Module]++
					}
					var mods []map[string]any
					for m, n := range byModule {
						mods = append(mods, map[string]any{"module": m, "datasets": n})
					}
					return map[string]any{
						"modules": mods, "total_datasets": len(exportDatasets),
						"note": "These are the modules. Call this tool again with search set to " +
							"a word from the question to see the datasets inside one, then " +
							"query_workspace_data to count or group it.",
					}, nil
				}

				var out []map[string]any
				for _, d := range exportDatasets {
					hay := strings.ToLower(d.Key + " " + d.Label + " " + d.Module + " " + d.Desc)
					all := true
					for _, w := range words {
						if !strings.Contains(hay, w) {
							all = false
							break
						}
					}
					if !all {
						continue
					}
					out = append(out, map[string]any{
						"dataset": d.Key, "label": d.Label, "module": d.Module,
						"contains": d.Desc,
					})
					if len(out) >= 12 {
						break
					}
				}
				return map[string]any{"datasets": out, "count": len(out), "searched_for": q,
					"note": "Pass one of these 'dataset' values to query_workspace_data. If none " +
						"of them is what was asked about, say we do not hold it rather than " +
						"answering from the nearest one."}, nil
			},
		},
		{
			Name: "query_workspace_data",
			Description: "Count or break down any dataset in the workspace: how many records " +
				"match, grouped by a column, over a date range. Use this for questions no " +
				"other tool covers — disputes, uploads, leave, audit trail, applications, " +
				"anything. If you do not know the dataset name, call " +
				"list_workspace_datasets first.",
			Params: map[string]any{"type": "object", "properties": map[string]any{
				"dataset": map[string]any{"type": "string",
					"description": "Dataset name or key from list_workspace_datasets, e.g. 'card_disputes'. Plain words work too."},
				"group_by": map[string]any{"type": "string",
					"description": "Optional column to break the count down by, e.g. 'status'. The tool lists valid columns if this is wrong."},
				"days": map[string]any{"type": "integer",
					"description": "Only records from the last N days, 1 to 3650. Omitted means all time, where the dataset allows it."},
				"sample_rows": map[string]any{"type": "integer",
					"description": "Return up to this many example records, 0 to 5. Default 0. Use only when the person wants examples, not a count."},
			}},
			Pages: []string{"reports"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				name := argStr(a, "dataset")
				if name == "" {
					return nil, fmt.Errorf("a dataset is required; call list_workspace_datasets to find one")
				}
				d, near := assistantDatasetMatch(name)
				if d.Key == "" {
					var opts []map[string]any
					for i, c := range near {
						if i >= 8 {
							break
						}
						opts = append(opts, map[string]any{"dataset": c.Key, "label": c.Label, "module": c.Module})
					}
					return map[string]any{"searched_for": name, "found": false, "did_you_mean": opts,
						"note": "No single dataset matched. Pick one of these and call again, or say " +
							"we do not hold that if none fits."}, nil
				}

				req := exportRequest{Dataset: d.Key}
				days := argInt(a, "days", 0, 0, 3650)
				// A dataset marked DateRequired is one where an unbounded scan is an
				// outage rather than a report, so it gets a bounded window whether or
				// not one was asked for.
				if days == 0 && d.DateRequired {
					days = 90
				}
				if days > 0 && d.DateCol != "" {
					now := time.Now()
					req.DateFrom = now.AddDate(0, 0, -days).Format("2006-01-02")
					req.DateTo = now.Format("2006-01-02")
				}

				cq, cargs, _, err := buildExportCountQuery(d, req)
				if err != nil {
					return nil, err
				}
				total, err := db.PGQuery(ctx, cq, cargs...)
				if err != nil {
					return nil, err
				}

				out := map[string]any{
					"dataset": d.Key, "label": d.Label, "module": d.Module,
				}
				if len(total) > 0 {
					out["matching_records"] = total[0]["n"]
				}
				if req.DateFrom != "" {
					out["date_range"] = req.DateFrom + " to " + req.DateTo
					out["date_counted_on"] = d.DateLabel
				} else if days > 0 {
					out["date_range"] = "all time — this dataset has no date to filter on"
				}

				// Grouped breakdown. The column must be one the registry declares, so
				// this can never reach a column the export engine would not expose --
				// which is what keeps the masking rules intact.
				if g := argStr(a, "group_by"); g != "" {
					col, ok := d.colByKey(g)
					if !ok {
						var valid []string
						for i, c := range d.Cols {
							if i >= 14 {
								break
							}
							valid = append(valid, c.Key)
						}
						out["group_by_rejected"] = g
						out["groupable_columns"] = valid
						out["note"] = "That column is not in this dataset. Use one of groupable_columns, " +
							"or report the total on its own."
						return out, nil
					}
					// Expr defaults to Key when empty (see exportCol.sql), so using it raw
					// would emit "SELECT ()::text" for most columns.
					expr := col.Expr
					if expr == "" {
						expr = col.Key
					}
					where := ""
					if w := strings.TrimSpace(d.Where); w != "" {
						where = "WHERE " + w
					}
					// The date predicate is re-applied here rather than reused, because
					// buildExportQuery returns a full projection and this needs only the
					// grouping expression. Kept to the same column so the grouped counts
					// always add up to matching_records above.
					if req.DateFrom != "" {
						if where == "" {
							where = "WHERE "
						} else {
							where += " AND "
						}
						where += fmt.Sprintf("%s >= $1::date AND %s <= $2::date", d.DateCol, d.DateCol)
					}
					gq := fmt.Sprintf(
						"SELECT COALESCE(NULLIF((%s)::text, ''), '(blank)') AS value, COUNT(*) AS records\nFROM %s\n%s\nGROUP BY 1\nORDER BY records DESC\nLIMIT 12",
						expr, d.From, where)
					var gargs []any
					if req.DateFrom != "" {
						gargs = []any{req.DateFrom, req.DateTo}
					}
					rows, err := db.PGQuery(ctx, gq, gargs...)
					if err != nil {
						return nil, err
					}
					out["grouped_by"] = col.Key
					out["breakdown"] = rows
				}

				if n := argInt(a, "sample_rows", 0, 0, 5); n > 0 {
					q, args, _, err := buildExportQuery(d, req, n)
					if err != nil {
						return nil, err
					}
					rows, err := db.PGQuery(ctx, q, args...)
					if err != nil {
						return nil, err
					}
					out["sample_rows"] = rows
					out["sample_note"] = "Examples only, not a complete list. Card numbers and BVNs are " +
						"masked to their last four digits in this data."
				}

				if _, ok := out["note"]; !ok {
					out["note"] = "Counted from the Reports & BI dataset registry, so this is the same " +
						"figure the equivalent report would export. Say which dataset and date " +
						"range the number covers."
				}
				return out, nil
			},
		},
	}
}
