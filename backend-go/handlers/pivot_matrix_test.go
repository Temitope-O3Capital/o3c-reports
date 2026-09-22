package handlers

import (
	"reflect"
	"testing"

	"github.com/o3c/workspace/core"
)

// The browser draws the same matrix (pages/reports/builder/model.ts, buildMatrix). These
// pin the ids, names, order and sort that a saved rename, hide or sort refers to.

func callsByAgentAndDisposition() pivotResult {
	return pivotResult{
		Dims: []pivotDimOut{
			{Key: "d_agent_name", Label: "Agent", Role: "row", Type: "text"},
			{Key: "d_disposition", Label: "Disposition", Role: "col", Type: "text"},
		},
		Meas: []pivotMeasOut{{Key: "m_0", Label: "Count", Agg: "count", Type: "int"}},
		Rows: []core.Row{
			{"d_agent_name": "Bola", "d_disposition": "Not Interested", "m_0": int64(4)},
			{"d_agent_name": "Bola", "d_disposition": nil, "m_0": int64(9)},
			{"d_agent_name": "Ade", "d_disposition": "Interested", "m_0": int64(2)},
		},
	}
}

func matrixIDs(m pivotMatrix) []string {
	out := make([]string, len(m.Cols))
	for i, c := range m.Cols {
		out[i] = c.ID
	}
	return out
}

func matrixLabels(m pivotMatrix) []string {
	out := make([]string, len(m.Cols))
	for i, c := range m.Cols {
		out[i] = c.Label
	}
	return out
}

func TestPivotMatrixSpreadsColumnValuesInIDOrder(t *testing.T) {
	m := buildPivotMatrix(callsByAgentAndDisposition(), nil, nil, nil)
	wantIDs := []string{"r:agent_name", "c:|m:0", "c:Interested|m:0", "c:Not Interested|m:0"}
	if got := matrixIDs(m); !reflect.DeepEqual(got, wantIDs) {
		t.Fatalf("ids = %q, want %q", got, wantIDs)
	}
	// One measure: a spread column is named by its value alone.
	wantLabels := []string{"Agent", "(blank)", "Interested", "Not Interested"}
	if got := matrixLabels(m); !reflect.DeepEqual(got, wantLabels) {
		t.Fatalf("labels = %q, want %q", got, wantLabels)
	}
	wantRows := [][]any{
		{"Bola", int64(9), nil, int64(4)},
		{"Ade", nil, int64(2), nil},
	}
	if !reflect.DeepEqual(m.Rows, wantRows) {
		t.Fatalf("rows = %v, want %v", m.Rows, wantRows)
	}
}

func TestPivotMatrixNamesSpreadColumnsByMeasureWhenThereAreSeveral(t *testing.T) {
	res := callsByAgentAndDisposition()
	res.Meas = append(res.Meas, pivotMeasOut{Key: "m_1", Label: "Sum of Duration", Agg: "sum", Type: "int"})
	m := buildPivotMatrix(res, nil, nil, nil)
	if got := m.Cols[3]; got.ID != "c:Interested|m:0" || got.Label != "Interested · Count" {
		t.Fatalf("column 3 = %+v, want Interested · Count", got)
	}
	if got := m.Cols[4]; got.ID != "c:Interested|m:1" || got.Label != "Interested · Sum of Duration" {
		t.Fatalf("column 4 = %+v, want Interested · Sum of Duration", got)
	}
}

func TestPivotMatrixAppliesRenamesHidesAndSorts(t *testing.T) {
	m := buildPivotMatrix(callsByAgentAndDisposition(),
		map[string]string{"c:Interested|m:0": "Interested calls", "r:agent_name": "Sales officer"},
		[]string{"c:|m:0"},
		[]reportSort{{Key: "r:agent_name", Dir: "asc"}})
	if got, want := matrixLabels(m), []string{"Sales officer", "Interested calls", "Not Interested"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("labels = %q, want %q", got, want)
	}
	if m.Rows[0][0] != "Ade" || m.Rows[1][0] != "Bola" {
		t.Fatalf("rows not sorted by Sales officer: %v", m.Rows)
	}
	if len(m.Rows[0]) != 3 {
		t.Fatalf("hidden column still present: %v", m.Rows[0])
	}
}

// A blank cell sorts last whichever way the column is sorted, so high-to-low never
// opens with a page of empty cells.
func TestPivotMatrixSortsBlanksLastInBothDirections(t *testing.T) {
	for _, dir := range []string{"asc", "desc"} {
		m := buildPivotMatrix(callsByAgentAndDisposition(), nil, nil, []reportSort{{Key: "c:|m:0", Dir: dir}})
		if m.Rows[0][0] != "Bola" || m.Rows[1][1] != nil {
			t.Fatalf("%s: blank did not sort last: %v", dir, m.Rows)
		}
	}
	m := buildPivotMatrix(callsByAgentAndDisposition(), nil, nil, []reportSort{{Key: "c:Not Interested|m:0", Dir: "desc"}})
	if m.Rows[0][0] != "Bola" {
		t.Fatalf("numeric desc sort wrong: %v", m.Rows)
	}
}

// With no measures a Summary is a list of distinct combinations: there is nothing to
// spread across columns, so a field in Columns becomes another row field instead of
// silently disappearing.
func TestPivotMatrixWithoutMeasuresListsEveryField(t *testing.T) {
	res := callsByAgentAndDisposition()
	res.Meas = nil
	m := buildPivotMatrix(res, nil, nil, nil)
	if got, want := matrixIDs(m), []string{"r:agent_name", "r:disposition"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids = %q, want %q", got, want)
	}
	if len(m.Rows) != 3 || m.Rows[1][1] != matrixBlankLabel {
		t.Fatalf("rows = %v", m.Rows)
	}
}

func TestPivotMatrixExportRowsKeepColumnTypes(t *testing.T) {
	cols, rows := buildPivotMatrix(callsByAgentAndDisposition(), nil, nil, nil).exportRows()
	if cols[0].Type != colText || cols[1].Type != colInt {
		t.Fatalf("types = %v / %v", cols[0].Type, cols[1].Type)
	}
	if rows[0][cols[0].Key] != "Bola" || rows[0][cols[3].Key] != int64(4) {
		t.Fatalf("row = %v", rows[0])
	}
}
