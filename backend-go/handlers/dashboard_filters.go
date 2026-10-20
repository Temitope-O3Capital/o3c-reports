package handlers

/*
Filtering a whole dashboard at once.

WHAT A SLICER IS HERE, AND WHAT IT IS NOT. Power BI filters a model: visuals share a star
schema, so one selection propagates along relationships. This dashboard has no model —
each tile is an independent report over its own dataset, and the datasets are not joined
to one another. Inventing a model to make slicers work would mean inferring joins, which
this codebase already decided against on evidence (see export_joins.go).

So a slicer is matched BY FILTER KEY. Each dataset declares its own filters
(exportDataset.Filters, each with a Key like "state" or "officer_name"). A dashboard
slicer on "state" applies to every tile whose dataset declares a filter named "state",
and is IGNORED by a tile whose dataset has no such thing. The tile reports which filters
it honoured, so a board filtered to Lagos does not quietly imply that the tile showing
card settlements — which knows nothing about states — answered the same question.

That is a weaker promise than Power BI's, and it is the true one. A tile that cannot
answer says so instead of looking like it did.

WHY THE SELECTION IS NOT STORED. app.dashboards.config holds which slicers a board
OFFERS; the current selection travels in the request and lives in the viewer's page. On a
shared dashboard a stored selection would mean one person narrowing the board and
reframing a colleague's figures without either of them knowing — the fastest route to two
people quoting different numbers off the same screen.
*/

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/o3c/workspace/core"
)

// dashFilterParamPrefix marks a dashboard slicer in the tile-data query string:
// ?f_state=Lagos. Prefixed so it can never collide with a real parameter (win, from, to)
// as more are added.
const dashFilterParamPrefix = "f_"

// dashMaxSlicers bounds what a board may offer. A filter bar longer than this is a form,
// and every slicer is another thing each tile has to be re-run for.
const dashMaxSlicers = 8

// dashSlicerSelection is what the viewer has chosen, read off the request.
type dashSlicerSelection struct {
	// Values by dataset filter key. A blank value is dropped rather than sent as an
	// empty filter — exports.go skips blank filter values, so an empty slicer would be
	// a no-op that still forced a re-run.
	Values map[string]string
	// Period override for the whole board. Empty Win means "leave each tile's own".
	Win  string
	From string
	To   string
}

// dashReadSelection pulls the slicer selection out of a tile-data request.
func dashReadSelection(r *http.Request) dashSlicerSelection {
	sel := dashSlicerSelection{Values: map[string]string{}}
	q := r.URL.Query()
	for k, vs := range q {
		if !strings.HasPrefix(k, dashFilterParamPrefix) || len(vs) == 0 {
			continue
		}
		key := strings.TrimPrefix(k, dashFilterParamPrefix)
		val := strings.TrimSpace(vs[0])
		if key == "" || val == "" {
			continue
		}
		sel.Values[key] = val
	}
	sel.Win = strings.TrimSpace(q.Get("win"))
	sel.From = strings.TrimSpace(q.Get("from"))
	sel.To = strings.TrimSpace(q.Get("to"))
	return sel
}

// dashApplySelection folds a board's selection into one tile's report config.
//
// It returns which keys were applied and which were ignored, so the tile can say. The
// config is taken by value and returned modified: the caller's copy, and the saved
// report, are untouched.
//
// A slicer only applies if the dataset DECLARES a filter of that key. That is the whole
// safety property: the value is bound into the dataset's own filter expression, exactly
// as the Report Builder would bind it, so a slicer can reach nothing a report could not
// already filter on.
func dashApplySelection(
	d exportDataset, cfg savedPivotConfig, sel dashSlicerSelection,
) (savedPivotConfig, []string, []string) {
	declared := make(map[string]bool, len(d.Filters))
	for _, f := range d.Filters {
		declared[f.Key] = true
	}

	var applied, ignored []string
	if len(sel.Values) > 0 {
		// Copy the map before writing: savedPivotConfig came from unmarshalling the
		// saved report, and mutating it in place would leak a viewer's selection into
		// whatever else holds that config.
		next := make(map[string]string, len(cfg.Filters)+len(sel.Values))
		for k, v := range cfg.Filters {
			next[k] = v
		}
		for key, val := range sel.Values {
			if !declared[key] {
				ignored = append(ignored, key)
				continue
			}
			// The board's selection wins over the report's own saved value for that
			// key. A tile built with state=Lagos, on a board filtered to FCT, must show
			// FCT or say it could not — showing Lagos under an FCT heading is the one
			// outcome that misleads.
			next[key] = val
			applied = append(applied, key)
		}
		cfg.Filters = next
	}

	// The period applies to any dataset that has a date column at all, which is the same
	// condition the Report Builder uses to offer its own window control.
	if sel.Win != "" && d.DateCol != "" {
		cfg.DateWindow = sel.Win
		if sel.Win == "custom" {
			cfg.DateFrom, cfg.DateTo = sel.From, sel.To
		} else {
			// resolveReportWindow recomputes the dates from the named window, so stale
			// explicit dates must not be left behind to override it.
			cfg.DateFrom, cfg.DateTo = "", ""
		}
		applied = append(applied, "period")
	} else if sel.Win != "" {
		ignored = append(ignored, "period")
	}

	sort.Strings(applied)
	sort.Strings(ignored)
	return cfg, applied, ignored
}

// dashAvailableSlicers lists the filter keys a board could offer, from the datasets its
// own tiles read — so the UI cannot offer a slicer that would apply to nothing.
//
// Only tiles THIS VIEWER can read contribute. A key that exists solely on a tile they are
// refused would otherwise leak the shape of data they cannot see.
func dashAvailableSlicers(u *core.Claims, tiles []core.Row) []core.Row {
	type slicer struct {
		key, label, kind string
		options          []string
		tiles            int
	}
	found := map[string]*slicer{}
	readable := 0

	for _, t := range tiles {
		if ok, _ := t["readable"].(bool); !ok {
			continue
		}
		ds := str(t["dataset"])
		if ds == "" {
			continue // a saved-query tile declares no dataset filters
		}
		d, exists := exportDatasetByKey(ds)
		if !exists {
			continue
		}
		var relErr error
		// Related columns bring their own filters, and the relation is re-checked
		// against this viewer, so the slicer list matches what they can actually run.
		if cfgRaw := str(t["report_config"]); cfgRaw != "" {
			var c savedPivotConfig
			// A config that will not parse is a broken tile, not a reason to drop the
			// base dataset's filters: fall through with the unexpanded dataset.
			if err := json.Unmarshal([]byte(cfgRaw), &c); err == nil && len(c.Relations) > 0 {
				d, relErr = datasetWithRelations(d, c.Relations, u)
				if relErr != nil {
					continue
				}
			}
		}
		readable++
		for _, f := range d.Filters {
			s, seen := found[f.Key]
			if !seen {
				s = &slicer{key: f.Key, label: f.Label, kind: string(f.Kind), options: f.Options}
				found[f.Key] = s
			}
			s.tiles++
		}
	}

	out := make([]core.Row, 0, len(found))
	for _, s := range found {
		out = append(out, core.Row{
			"key": s.key, "label": s.label, "kind": s.kind,
			"options": s.options,
			// How many of the board's tiles this slicer would reach. The UI sorts by it,
			// because a slicer touching one tile of twelve is rarely the useful one.
			"tiles": s.tiles, "of_tiles": readable,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		ti, tj := toInt64(out[i]["tiles"]), toInt64(out[j]["tiles"])
		if ti != tj {
			return ti > tj
		}
		return str(out[i]["label"]) < str(out[j]["label"])
	})
	return out
}
