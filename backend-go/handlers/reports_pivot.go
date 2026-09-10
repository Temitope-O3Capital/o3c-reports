package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
The pivot engine — the aggregating counterpart to the flat export.

It powers the drag-and-drop Report Builder: a supervisor drops fields into Rows,
Columns and Values and gets a grouped/aggregated result they can preview and
export. It reuses the export registry and its safety model wholesale:

  - Every row/column/value field is selected BY KEY from the same dataset
    registry the flat export uses; an unknown key is a 422, never interpolated.
  - Every aggregate is chosen from a fixed whitelist (sum/avg/min/max/count/
    count_distinct). SUM/AVG are refused on non-numeric columns.
  - The WHERE (static predicate + date range + declared filters) is the shared
    buildExportWhere, so a filter here is bound exactly as it is for a download.
  - The result is capped like every other query.

The output is LONG format (one row per group, dimensions + measures). The client
pivots it into the row×column matrix — keeping cross-tab logic out of SQL, where
a dynamic CROSSTAB would be both harder to make safe and harder to read.

The SQL construction lives in runPivot so it can be driven from three places with
identical guarantees: the live preview (exportPivot), a saved-report export, and
the scheduled-email worker. See reports_saved.go.
*/

type pivotValue struct {
	Column string `json:"column"` // dataset column key; "" allowed only with agg=count
	Agg    string `json:"agg"`    // sum|avg|min|max|count|count_distinct
}

type pivotRequest struct {
	DateFrom   string            `json:"date_from"`
	DateTo     string            `json:"date_to"`
	Filters    map[string]string `json:"filters"`
	ColFilters []colFilter       `json:"col_filters"`
	Rows       []string          `json:"rows"`             // column keys → row dimensions
	Cols       []string          `json:"cols"`             // column keys → column dimensions
	Values     []pivotValue      `json:"values"`           // measures
	Grains     map[string]string `json:"grains,omitempty"` // temporal dim key → date|time|datetime
	Limit      int               `json:"limit"`
}

// pivotSpec is the resolved shape runPivot executes. It is the request minus the
// transport: concrete dates, a filter map, dimensions and measures.
type pivotSpec struct {
	DateFrom   string
	DateTo     string
	Filters    map[string]string
	ColFilters []colFilter
	Rows       []string
	Cols       []string
	Values     []pivotValue
	Grains     map[string]string
	Limit      int
}

// pivotDimOut / pivotMeasOut are the column descriptors returned alongside the
// rows, so a caller (browser or file writer) knows each result key's label,
// role and display type.
type pivotDimOut struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Role  string `json:"role"` // "row" | "col"
	Type  string `json:"type"`
}

type pivotMeasOut struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Agg   string `json:"agg"`
	Type  string `json:"type"`
}

// pivotResult bundles everything a caller needs to render or write the report.
type pivotResult struct {
	Dims      []pivotDimOut
	Meas      []pivotMeasOut
	Rows      []core.Row
	Truncated bool
	Cap       int
}

// pivotAggWhitelist maps an allowed aggregate to whether it needs a numeric column.
var pivotAggWhitelist = map[string]bool{
	"sum": true, "avg": true, // numeric-only
	"min": false, "max": false, "count": false, "count_distinct": false,
}

const pivotMaxGroups = 5000

// pivotUserError marks a validation failure (unknown field, bad aggregate, empty
// selection) so callers can map it to a 4xx while treating everything else as a
// server error.
type pivotUserError struct{ msg string }

func (e pivotUserError) Error() string { return e.msg }

// runPivot validates a spec against a dataset, builds the aggregating SQL and
// executes it. A pivotUserError means "the request was bad" (422); any other
// error is an execution failure (500).
func runPivot(ctx context.Context, db *core.DB, d exportDataset, spec pivotSpec) (pivotResult, error) {
	dims := append(append([]string{}, spec.Rows...), spec.Cols...)
	if len(dims) == 0 && len(spec.Values) == 0 {
		return pivotResult{}, pivotUserError{"Add at least one field to Rows, Columns or Values"}
	}

	var (
		selects []string
		groupBy []string
		dimsOut []pivotDimOut
		seenDim = map[string]bool{}
		roleOf  = map[string]string{}
	)
	for _, k := range spec.Rows {
		roleOf[k] = "row"
	}
	for _, k := range spec.Cols {
		if roleOf[k] == "" {
			roleOf[k] = "col"
		}
	}
	for _, k := range dims {
		if seenDim[k] {
			continue
		}
		seenDim[k] = true
		c, ok := d.colByKey(k)
		if !ok {
			return pivotResult{}, pivotUserError{"Unknown field: " + k}
		}
		alias := "d_" + k
		expr := c.Expr
		outType := string(c.Type)
		// Temporal grain: normalise a date/timestamp dimension and group by the chosen
		// grain (date | time | timestamp), so a raw RFC3339 value never reaches the client
		// and the operator can, say, group by day-of vs by the minute. Casting through
		// ::timestamp resolves the value in the DB session zone (Africa/Lagos). A date
		// column defaults to date; a datetime column to a normalised timestamp.
		if c.Type == colDate || c.Type == colDateTime {
			grain := spec.Grains[k]
			if grain == "" {
				if c.Type == colDateTime {
					grain = "datetime"
				} else {
					grain = "date"
				}
			}
			switch grain {
			case "time":
				expr = fmt.Sprintf("to_char((%s)::timestamp, 'HH24:MI:SS')", c.Expr)
			case "datetime":
				expr = fmt.Sprintf("to_char((%s)::timestamp, 'YYYY-MM-DD HH24:MI')", c.Expr)
			default: // date
				expr = fmt.Sprintf("to_char((%s)::timestamp, 'YYYY-MM-DD')", c.Expr)
			}
			outType = "text"
		}
		selects = append(selects, fmt.Sprintf("%s AS %q", expr, alias))
		groupBy = append(groupBy, expr)
		dimsOut = append(dimsOut, pivotDimOut{Key: alias, Label: c.Label, Role: roleOf[k], Type: outType})
	}

	var measOuts []pivotMeasOut
	for i, v := range spec.Values {
		needNumeric, allowed := pivotAggWhitelist[v.Agg]
		if !allowed {
			return pivotResult{}, pivotUserError{"Unknown aggregate: " + v.Agg}
		}
		alias := fmt.Sprintf("m_%d", i)
		if v.Agg == "count" && strings.TrimSpace(v.Column) == "" {
			selects = append(selects, fmt.Sprintf("COUNT(*) AS %q", alias))
			measOuts = append(measOuts, pivotMeasOut{Key: alias, Label: "Count", Agg: v.Agg, Type: "int"})
			continue
		}
		c, ok := d.colByKey(v.Column)
		if !ok {
			return pivotResult{}, pivotUserError{"Unknown value field: " + v.Column}
		}
		if needNumeric && !exportNumeric(c.Type) {
			return pivotResult{}, pivotUserError{fmt.Sprintf("%s can only sum/average a numeric field, not %q", v.Agg, c.Label)}
		}
		var expr, outType string
		switch v.Agg {
		case "sum":
			expr, outType = fmt.Sprintf("SUM((%s)::numeric)", c.Expr), string(c.Type)
		case "avg":
			expr, outType = fmt.Sprintf("ROUND(AVG((%s)::numeric), 2)", c.Expr), string(c.Type)
		case "min":
			expr, outType = fmt.Sprintf("MIN(%s)", c.Expr), string(c.Type)
		case "max":
			expr, outType = fmt.Sprintf("MAX(%s)", c.Expr), string(c.Type)
		case "count_distinct":
			expr, outType = fmt.Sprintf("COUNT(DISTINCT %s)", c.Expr), "int"
		default:
			expr, outType = fmt.Sprintf("COUNT(%s)", c.Expr), "int"
		}
		selects = append(selects, fmt.Sprintf("%s AS %q", expr, alias))
		label := aggLabel(v.Agg) + " " + c.Label
		measOuts = append(measOuts, pivotMeasOut{Key: alias, Label: label, Agg: v.Agg, Type: outType})
	}
	// No forced Count. With dimensions and no measures the GROUP BY already returns the
	// DISTINCT combinations (the "uniques") — a plain list, not a count nobody asked for.
	// A count is available on demand: add a field to Values and pick Count / Unique.
	// (dims-and-values both empty is already rejected above, so the query is never blank.)

	exReq := exportRequest{Dataset: d.Key, DateFrom: spec.DateFrom, DateTo: spec.DateTo, Filters: spec.Filters, ColFilters: spec.ColFilters}
	where, args, err := buildExportWhere(d, exReq)
	if err != nil {
		return pivotResult{}, pivotUserError{err.Error()}
	}

	limit := pivotMaxGroups
	if spec.Limit > 0 && spec.Limit < pivotMaxGroups {
		limit = spec.Limit
	}

	q := "SELECT " + strings.Join(selects, ",\n       ") + "\nFROM " + d.From
	if len(where) > 0 {
		q += "\nWHERE " + strings.Join(where, "\n  AND ")
	}
	if len(groupBy) > 0 {
		q += "\nGROUP BY " + strings.Join(groupBy, ", ")
		q += "\nORDER BY " + strings.Join(groupBy, ", ")
	}
	q += fmt.Sprintf("\nLIMIT %d", limit+1)

	rows, err := db.PGQuery(ctx, q, args...)
	if err != nil {
		return pivotResult{}, err
	}
	truncated := false
	if len(rows) > limit {
		rows = rows[:limit]
		truncated = true
	}
	// Never hand back a nil slice — it serialises to `rows: null`, which the client's
	// matrix builder iterates and crashes on (a "not iterable"/`.map` error on an empty
	// result, which a column filter that matches nothing makes easy to hit).
	if rows == nil {
		rows = []core.Row{}
	}

	return pivotResult{Dims: dimsOut, Meas: measOuts, Rows: rows, Truncated: truncated, Cap: limit}, nil
}

func exportPivot(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		d, ok := exportDatasetByKey(key)
		if !ok {
			respondErr(w, 404, "Unknown dataset: "+key)
			return
		}

		var pr pivotRequest
		if r.Body != nil {
			if err := json.NewDecoder(r.Body).Decode(&pr); err != nil && err.Error() != "EOF" {
				respondErr(w, 400, "invalid JSON")
				return
			}
		}

		// Reuse the flat export's validation (date-required, from ≤ to, format).
		exReq := exportRequest{Dataset: key, DateFrom: pr.DateFrom, DateTo: pr.DateTo, Filters: pr.Filters}
		if err := validateExportRequest(d, exReq); err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		res, err := runPivot(r.Context(), db, d, pivotSpec{
			DateFrom: pr.DateFrom, DateTo: pr.DateTo, Filters: pr.Filters, ColFilters: pr.ColFilters,
			Rows: pr.Rows, Cols: pr.Cols, Values: pr.Values, Grains: pr.Grains, Limit: pr.Limit,
		})
		if err != nil {
			var ue pivotUserError
			if errors.As(err, &ue) {
				respondErr(w, 422, ue.Error())
			} else {
				respondErrLog(w, 500, "Could not run the report", err)
			}
			return
		}

		respond(w, map[string]any{
			"dataset":    key,
			"dimensions": res.Dims,
			"measures":   res.Meas,
			"rows":       res.Rows,
			"truncated":  res.Truncated,
			"group_cap":  res.Cap,
		}, "pg")
	}
}

func aggLabel(a string) string {
	switch a {
	case "sum":
		return "Sum of"
	case "avg":
		return "Avg"
	case "min":
		return "Min"
	case "max":
		return "Max"
	case "count_distinct":
		return "Distinct"
	default:
		return "Count of"
	}
}
