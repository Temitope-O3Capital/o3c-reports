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
	Column string `json:"column"`          // dataset column key; "" allowed only with agg=count
	Agg    string `json:"agg"`             // sum|avg|min|max|count|count_distinct
	Label  string `json:"label,omitempty"` // display override; "" falls back to the auto-generated label
}

// pivotTopN keeps the N biggest groups by one measure (its index in Values).
type pivotTopN struct {
	Measure int `json:"measure"`
	N       int `json:"n"`
}

type pivotRequest struct {
	TopN       *pivotTopN        `json:"top_n,omitempty"`
	DateFrom   string            `json:"date_from"`
	DateTo     string            `json:"date_to"`
	Filters    map[string]string `json:"filters"`
	ColFilters []colFilter       `json:"col_filters"`
	Rows       []string          `json:"rows"`                 // column keys → row dimensions
	Cols       []string          `json:"cols"`                 // column keys → column dimensions
	Values     []pivotValue      `json:"values"`               // measures
	Grains     map[string]string `json:"grains,omitempty"`     // temporal dim key → date|time|datetime
	DimLabels  map[string]string `json:"dim_labels,omitempty"` // row/col column key → display override
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
	DimLabels  map[string]string
	Limit      int
	TopN       *pivotTopN
	// CountRecords also counts the matching records before grouping. Only the live
	// preview shows that figure, so files and emails skip the extra scan.
	CountRecords bool
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
	// RawCount is the number of underlying (pre-aggregation) rows matched by the
	// same WHERE, so a caller can tell when grouping is merging distinct records
	// into one line (e.g. "5,391 groups from 8,244 rows") instead of assuming one
	// row per group.
	RawCount int64
	// GroupTotal is how many groups there were in all when the result was cut at the
	// cap or narrowed by Top N, so the page can say exactly what was left out.
	GroupTotal int64
	TopN       bool
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
		selects    []string
		groupBy    []string
		dimsOut    []pivotDimOut
		seenDim    = map[string]bool{}
		roleOf     = map[string]string{}
		rowExprs   []string // row-field group expressions, for ranking Top N
		rowAliases []string
		colExprs   []string
		colAliases []string
		measExprs  []string // each measure's aggregate SQL, by index
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
		label := c.Label
		if override := strings.TrimSpace(spec.DimLabels[k]); override != "" {
			label = override
		}
		selects = append(selects, fmt.Sprintf("%s AS %q", expr, alias))
		groupBy = append(groupBy, expr)
		if roleOf[k] == "row" {
			rowExprs, rowAliases = append(rowExprs, expr), append(rowAliases, alias)
		} else {
			colExprs, colAliases = append(colExprs, expr), append(colAliases, alias)
		}
		dimsOut = append(dimsOut, pivotDimOut{Key: alias, Label: label, Role: roleOf[k], Type: outType})
	}

	var measOuts []pivotMeasOut
	for i, v := range spec.Values {
		needNumeric, allowed := pivotAggWhitelist[v.Agg]
		if !allowed {
			return pivotResult{}, pivotUserError{"Unknown aggregate: " + v.Agg}
		}
		alias := fmt.Sprintf("m_%d", i)
		if v.Agg == "count" && strings.TrimSpace(v.Column) == "" {
			label := "Count"
			if override := strings.TrimSpace(v.Label); override != "" {
				label = override
			}
			selects = append(selects, fmt.Sprintf("COUNT(*) AS %q", alias))
			measExprs = append(measExprs, "COUNT(*)")
			measOuts = append(measOuts, pivotMeasOut{Key: alias, Label: label, Agg: v.Agg, Type: "int"})
			continue
		}
		c, ok := d.colByKey(v.Column)
		if !ok {
			return pivotResult{}, pivotUserError{"Unknown value field: " + v.Column}
		}
		if needNumeric && !exportNumeric(c.Type) {
			return pivotResult{}, pivotUserError{fmt.Sprintf("%s can only sum/average a numeric field, not %q", v.Agg, c.Label)}
		}
		if (v.Agg == "min" || v.Agg == "max") && c.Type == colBool {
			return pivotResult{}, pivotUserError{fmt.Sprintf("Min and Max aren't available for a yes/no field like %q. Use Count or Unique Count.", c.Label)}
		}
		if v.Agg == "sum" && c.Type == colPct {
			return pivotResult{}, pivotUserError{fmt.Sprintf("Percentages can't be added up. Use Average, Min or Max of %q.", c.Label)}
		}
		var expr, outType string
		switch v.Agg {
		case "sum":
			expr, outType = fmt.Sprintf("SUM((%s)::numeric)", c.Expr), string(c.Type)
		case "avg":
			// An average of whole numbers has decimals, so it is written as a decimal value.
			expr, outType = fmt.Sprintf("ROUND(AVG((%s)::numeric), 2)", c.Expr), string(c.Type)
			if c.Type == colInt {
				outType = string(colMoney)
			}
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
		measExprs = append(measExprs, expr)
		label := aggLabel(v.Agg) + " " + c.Label
		if override := strings.TrimSpace(v.Label); override != "" {
			label = override
		}
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

	// Raw (pre-aggregation) row count against the same WHERE, so a caller can tell
	// when grouping is folding several underlying rows into one line — e.g. two
	// calls to the same customer on the same day with the same outcome collapse
	// into a single group, and without this a viewer has no way to notice.
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = "\nWHERE " + strings.Join(where, "\n  AND ")
	}

	var rawCount int64
	if spec.CountRecords && len(groupBy) > 0 {
		cq := "SELECT COUNT(*) AS c FROM " + d.From + whereSQL
		if crows, cerr := db.PGQuery(ctx, cq, args...); cerr == nil && len(crows) > 0 {
			rawCount = toInt64(crows[0]["c"])
		}
	}

	limit := pivotMaxGroups
	if spec.Limit > 0 && spec.Limit < pivotMaxGroups {
		limit = spec.Limit
	}

	base := "SELECT " + strings.Join(selects, ",\n       ") + "\nFROM " + d.From + whereSQL
	if len(groupBy) > 0 {
		base += "\nGROUP BY " + strings.Join(groupBy, ", ")
	}

	// Top N keeps the N biggest groups by one measure, instead of the cap keeping
	// whichever groups happen to sort first. With fields in both Rows and Columns the
	// ranking is over the row groups, so every kept row keeps all of its columns.
	rankExprs, rankAliases := rowExprs, rowAliases
	if len(rankExprs) == 0 {
		rankExprs, rankAliases = colExprs, colAliases
	}
	topN := spec.TopN != nil && spec.TopN.N > 0 && spec.TopN.Measure >= 0 &&
		spec.TopN.Measure < len(measExprs) && len(rankExprs) > 0
	var q string
	switch {
	case topN && len(rankExprs) == len(groupBy):
		if spec.TopN.N < limit {
			limit = spec.TopN.N
		}
		q = base + fmt.Sprintf("\nORDER BY %q DESC NULLS LAST, %s\nLIMIT %d",
			measOuts[spec.TopN.Measure].Key, strings.Join(groupBy, ", "), limit)
	case topN:
		rankSel := make([]string, len(rankExprs))
		join := make([]string, len(rankExprs))
		for i, e := range rankExprs {
			rankSel[i] = fmt.Sprintf("%s AS %q", e, rankAliases[i])
			join[i] = fmt.Sprintf("g.%q IS NOT DISTINCT FROM t.%q", rankAliases[i], rankAliases[i])
		}
		colOrder := make([]string, len(colAliases))
		for i, a := range colAliases {
			colOrder[i] = fmt.Sprintf("g.%q", a)
		}
		top := "SELECT " + strings.Join(rankSel, ", ") +
			// The group fields break ties, so the preview and the emailed file keep the same groups.
			fmt.Sprintf(", ROW_NUMBER() OVER (ORDER BY %s DESC NULLS LAST, %s) AS rn", measExprs[spec.TopN.Measure], strings.Join(rankExprs, ", ")) +
			"\nFROM " + d.From + whereSQL +
			"\nGROUP BY " + strings.Join(rankExprs, ", ") +
			fmt.Sprintf("\nORDER BY rn\nLIMIT %d", spec.TopN.N)
		q = "SELECT g.* FROM (" + base + ") g\nJOIN (" + top + ") t ON " + strings.Join(join, " AND ") +
			"\nORDER BY t.rn, " + strings.Join(colOrder, ", ") +
			fmt.Sprintf("\nLIMIT %d", limit+1)
	default:
		q = base
		if len(groupBy) > 0 {
			q += "\nORDER BY " + strings.Join(groupBy, ", ")
		}
		q += fmt.Sprintf("\nLIMIT %d", limit+1)
	}

	rows, err := db.PGQuery(ctx, q, args...)
	if err != nil {
		return pivotResult{}, err
	}
	truncated := false
	if len(rows) > limit {
		rows = rows[:limit]
		truncated = true
	}
	// How many groups there were in all, so a cut or a Top N can say what it left out.
	var groupTotal int64
	if (truncated || topN) && len(groupBy) > 0 {
		over := groupBy
		if topN {
			over = rankExprs
		}
		gq := "SELECT COUNT(*) AS c FROM (SELECT 1 FROM " + d.From + whereSQL +
			"\nGROUP BY " + strings.Join(over, ", ") + ") x"
		if grows, gerr := db.PGQuery(ctx, gq, args...); gerr == nil && len(grows) > 0 {
			groupTotal = toInt64(grows[0]["c"])
		}
	}
	// Never hand back a nil slice — it serialises to `rows: null`, which the client's
	// matrix builder iterates and crashes on (a "not iterable"/`.map` error on an empty
	// result, which a column filter that matches nothing makes easy to hit).
	if rows == nil {
		rows = []core.Row{}
	}

	return pivotResult{Dims: dimsOut, Meas: measOuts, Rows: rows, Truncated: truncated, Cap: limit,
		RawCount: rawCount, GroupTotal: groupTotal, TopN: topN}, nil
}

func exportPivot(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		d, ok := exportDatasetByKey(key)
		if !ok {
			respondErr(w, 404, "Unknown dataset: "+key)
			return
		}
		if !reportDatasetAllowed(core.UserFromCtx(r.Context()), key) {
			respondErr(w, 403, reportDatasetDenied)
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
			Rows: pr.Rows, Cols: pr.Cols, Values: pr.Values, Grains: pr.Grains, DimLabels: pr.DimLabels, Limit: pr.Limit,
			TopN: pr.TopN, CountRecords: true,
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
			"raw_count":  res.RawCount,
			// Set when the result was cut at the cap or narrowed by Top N.
			"group_total":   res.GroupTotal,
			"top_n_applied": res.TopN,
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
