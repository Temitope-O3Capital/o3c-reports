package handlers

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Charts are built HERE, from the tool's own rows, and never by the model.
//
// The obvious design is to ask the model to emit a chart spec. That would be a
// mistake: it misquotes figures it can see in front of it (it read 137 as 1,370
// while writing a summary), so letting it author the numbers a chart draws would
// put a wrong picture in front of staff with no way to notice. The extractor
// below takes the same rows the tool already returned and hands them to the UI
// untouched, so a chart cannot disagree with the answer beside it.

// assistantChart is what the UI needs to render one chart: a set of rows, which
// key is the x axis, and which keys are numeric series.
type assistantChart struct {
	Title  string           `json:"title"`
	Kind   string           `json:"kind"` // "line" for a dated series, "bar" otherwise
	XKey   string           `json:"x_key"`
	Series []assistantSerie `json:"series"`
	Rows   []map[string]any `json:"rows"`
}

type assistantSerie struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

// assistantChartMaxRows keeps a chart legible and the payload small. A 90-day
// question is already bucketed to weeks by the tool, so this only bites on
// genuinely long breakdowns, where the tail is noise anyway.
const assistantChartMaxRows = 40

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)

// labelKeys are checked in order, so a dated column wins over a categorical one
// when a row carries both.
var labelKeys = []string{
	"date", "period", "day", "month", "week",
	"status", "stage", "bucket", "category", "reason", "product_name", "agent", "agent_name", "name",
}

// assistantChartFrom looks for one plottable series in a tool result. It returns
// nil whenever the shape is not obviously a chart — a scalar summary, a single
// row, a customer lookup — because a chart nobody asked for is clutter.
func assistantChartFrom(toolName string, result any) *assistantChart {
	res, ok := result.(map[string]any)
	if !ok {
		return nil
	}
	for _, field := range chartCandidateFields(res) {
		rows := toRowSlice(res[field])
		// One row is a summary, not a trend. Two is the minimum worth drawing.
		if len(rows) < 2 {
			continue
		}
		xKey := pickLabelKey(rows)
		if xKey == "" {
			continue
		}
		// No single column identifies a row uniquely: get_revenue_summary returns
		// (category, product_name) pairs, so "Prestige Accounts" appears once as
		// interest and once as fee. Charted on either column alone, two different
		// bars land on one label. Combine them instead.
		rows, xKey = ensureUniqueLabels(rows, xKey)
		series := pickNumericKeys(rows[0], xKey)
		series = dropIncomparableScales(rows, series)
		if len(series) == 0 {
			continue
		}
		if len(rows) > assistantChartMaxRows {
			rows = rows[:assistantChartMaxRows]
		}
		kind := "bar"
		if s, ok := rows[0][xKey].(string); ok && isoDate.MatchString(s) {
			kind = "line"
		}
		return &assistantChart{
			Title:  chartTitle(toolName, field),
			Kind:   kind,
			XKey:   xKey,
			Series: series,
			Rows:   rows,
		}
	}
	return nil
}

// chartCandidateFields returns the keys worth inspecting, most likely first, so
// a result carrying both a breakdown and a totals object never charts the total.
func chartCandidateFields(res map[string]any) []string {
	preferred := []string{"series", "by_day", "daily", "by_status", "by_stage", "by_category", "by_agent", "agents", "buckets"}
	seen := map[string]bool{}
	out := make([]string, 0, len(res))
	for _, k := range preferred {
		if _, ok := res[k]; ok {
			out = append(out, k)
			seen[k] = true
		}
	}
	for k := range res {
		if !seen[k] && k != "totals" && k != "summary" && k != "note" {
			out = append(out, k)
		}
	}
	return out
}

func toRowSlice(v any) []map[string]any {
	switch t := v.(type) {
	case []map[string]any:
		// core.Row is an alias for map[string]any, so this also covers []core.Row.
		return t
	case []any:
		out := make([]map[string]any, 0, len(t))
		for _, r := range t {
			m, ok := r.(map[string]any)
			if !ok {
				return nil
			}
			out = append(out, m)
		}
		return out
	}
	return nil
}

// pickLabelKey needs every row, not just the first, because the right label is
// the one that is DISTINCT down the column. get_revenue_summary returns
// (category, product_name) pairs: keyed on category, twelve rows collapse onto
// two labels and the chart is meaningless. Preferring a column whose values do
// not repeat picks product_name instead, with no per-tool special-casing.
func pickLabelKey(rows []map[string]any) string {
	distinct := func(k string) int {
		seen := map[string]bool{}
		for _, r := range rows {
			v, ok := r[k]
			if !ok || v == nil {
				return 0
			}
			if _, isNum := asFloat(v); isNum {
				return 0
			}
			seen[fmt.Sprint(v)] = true
		}
		return len(seen)
	}
	best, bestN := "", 0
	for _, k := range labelKeys {
		if n := distinct(k); n > bestN {
			best, bestN = k, n
		}
		// Every row has its own label: nothing will beat this.
		if bestN == len(rows) {
			return best
		}
	}
	if best != "" {
		return best
	}
	for k := range rows[0] {
		if n := distinct(k); n > bestN {
			best, bestN = k, n
		}
	}
	return best
}

// notAMetric lists columns that parse as numbers but mean nothing plotted.
// Without it a customer search charted CIF and phone number as if they were
// quantities — a chart that is not merely useless but actively misleading, since
// a tall bar would read as a large value.
var notAMetric = map[string]bool{
	"cif": true, "phone": true, "id": true, "account_id": true, "account_no": true,
	"customer_id": true, "bvn": true, "bvn_masked": true, "pan": true, "pan_number": true,
	"trace": true, "mcc": true, "days": true, "lead_id": true, "agent_id": true,
	"ticket_id": true, "case_id": true, "txn_id": true, "year": true,
}

func pickNumericKeys(row map[string]any, skip string) []assistantSerie {
	keys := make([]string, 0, len(row))
	for k, v := range row {
		if k == skip || notAMetric[k] {
			continue
		}
		if _, ok := asFloat(v); ok {
			keys = append(keys, k)
		}
	}
	// Deterministic order: the chart must not reshuffle between identical asks.
	sort.Strings(keys)
	out := make([]assistantSerie, 0, len(keys))
	for _, k := range keys {
		out = append(out, assistantSerie{Key: k, Name: humanise(k)})
	}
	return out
}

// assistantChartLabelKey is the synthetic column ensureUniqueLabels writes when
// no real column identifies a row on its own.
const assistantChartLabelKey = "label"

// ensureUniqueLabels guarantees one bar per row.
//
// If the chosen x column repeats a value, the rows are folded into a combined
// label built from a second non-numeric column ("interest - Prestige Accounts").
// Returning duplicate labels would draw two different values at the same tick,
// which either overlaps them or silently drops one — the reader has no way to
// tell that a bar is missing. If nothing makes the rows unique, the caller gets
// the rows back unchanged and the duplicate-label test will say so.
func ensureUniqueLabels(rows []map[string]any, xKey string) ([]map[string]any, string) {
	seen := map[string]bool{}
	dup := false
	for _, r := range rows {
		v := fmt.Sprint(r[xKey])
		if seen[v] {
			dup = true
			break
		}
		seen[v] = true
	}
	if !dup {
		return rows, xKey
	}
	for _, k := range labelKeys {
		if k == xKey {
			continue
		}
		if _, ok := rows[0][k]; !ok {
			continue
		}
		combined := make([]map[string]any, 0, len(rows))
		uniq := map[string]bool{}
		ok := true
		for _, r := range rows {
			label := fmt.Sprintf("%v - %v", r[k], r[xKey])
			if uniq[label] {
				ok = false
				break
			}
			uniq[label] = true
			c := make(map[string]any, len(r)+1)
			for kk, vv := range r {
				c[kk] = vv
			}
			c[assistantChartLabelKey] = label
			combined = append(combined, c)
		}
		if ok {
			return combined, assistantChartLabelKey
		}
	}
	return rows, xKey
}

// dropIncomparableScales keeps only the series that can share one y axis.
//
// get_collections_summary returns cases (hundreds) beside outstanding_ngn
// (billions). Drawn together on one axis the money bar fills the chart and the
// case count is a flat line at zero — a reader would conclude there were no
// cases. Keeping the largest scale and dropping anything more than 50x smaller
// gives a chart that reads correctly; the dropped figures are still in the
// written answer beside it, which is where the detail belongs anyway.
func dropIncomparableScales(rows []map[string]any, series []assistantSerie) []assistantSerie {
	if len(series) < 2 {
		return series
	}
	maxOf := make(map[string]float64, len(series))
	var biggest float64
	for _, s := range series {
		for _, r := range rows {
			if f, ok := asFloat(r[s.Key]); ok {
				if f < 0 {
					f = -f
				}
				if f > maxOf[s.Key] {
					maxOf[s.Key] = f
				}
			}
		}
		if maxOf[s.Key] > biggest {
			biggest = maxOf[s.Key]
		}
	}
	if biggest == 0 {
		return series
	}
	out := make([]assistantSerie, 0, len(series))
	for _, s := range series {
		if maxOf[s.Key]*50 >= biggest {
			out = append(out, s)
		}
	}
	return out
}

// asFloat accepts the string-formatted numerics pgx hands back for NUMERIC
// columns as well as real numbers, which is why a naive type switch on float64
// would find no series at all on most of these tools.
func asFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int32:
		return float64(t), true
	case int64:
		return float64(t), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

func humanise(k string) string {
	k = strings.TrimSuffix(k, "_ngn")
	k = strings.ReplaceAll(k, "_", " ")
	if k == "" {
		return k
	}
	return strings.ToUpper(k[:1]) + k[1:]
}

func chartTitle(toolName, field string) string {
	name := strings.TrimPrefix(toolName, "get_")
	name = strings.ReplaceAll(name, "_", " ")
	if field != "series" && field != "daily" {
		return fmt.Sprintf("%s: %s", humanise(name), strings.ReplaceAll(strings.TrimPrefix(field, "by_"), "_", " "))
	}
	return humanise(name)
}
