package handlers

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

/*
A Summary report drawn as a matrix: row fields down the side, then one column per
measure — or, when fields sit in Columns, one column per combination of their values
(and per measure, when there is more than one).

The Report Builder draws the same matrix in the browser from the same pivot rows
(frontend/src/pages/reports/builder/model.ts, buildMatrix). Column ids, default names,
column order and sort here must match that function exactly: a renamed, hidden or
sorted column is saved by id, and has to mean the same column in a file or email as it
did on screen.

  - A row field's column is  r:<field key>.
  - A measure's column is    m:<index>                       (no fields in Columns)
                        or   c:<value>\x1f<value>…|m:<index>  (fields in Columns).
  - An empty value is "" in an id and "(blank)" in a name.
  - Combinations of Column values are ordered by their id text.
  - With no measures at all, every field is a row field: the report is a list of the
    distinct combinations, and there is nothing to spread across columns.
*/

// matrixCol is one column of a Summary matrix.
type matrixCol struct {
	ID    string
	Label string
	Type  exportColType
	Dim   bool
}

type pivotMatrix struct {
	Cols []matrixCol
	Rows [][]any
}

const matrixTupleSep = "\x1f"

// matrixBlankLabel is how an empty value reads in a column name or a row field.
const matrixBlankLabel = "(blank)"

func matrixValueKey(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func buildPivotMatrix(res pivotResult, labels map[string]string, hidden []string, sorts []reportSort) pivotMatrix {
	var rowDims, colDims []pivotDimOut
	for _, dm := range res.Dims {
		if dm.Role == "col" && len(res.Meas) > 0 {
			colDims = append(colDims, dm)
		} else {
			rowDims = append(rowDims, dm)
		}
	}

	tuple := func(r map[string]any, dims []pivotDimOut) (string, []string) {
		keys := make([]string, len(dims))
		names := make([]string, len(dims))
		for i, dm := range dims {
			k := matrixValueKey(r[dm.Key])
			keys[i] = k
			names[i] = k
			if k == "" {
				names[i] = matrixBlankLabel
			}
		}
		return strings.Join(keys, matrixTupleSep), names
	}

	type rowAcc struct {
		names []string
		cells map[string]map[string]any
	}
	var rowOrder []string
	rowsByKey := map[string]*rowAcc{}
	colNames := map[string][]string{}
	var colKeys []string
	for _, r := range res.Rows {
		rk, rnames := tuple(r, rowDims)
		ck, cnames := tuple(r, colDims)
		acc := rowsByKey[rk]
		if acc == nil {
			acc = &rowAcc{names: rnames, cells: map[string]map[string]any{}}
			rowsByKey[rk] = acc
			rowOrder = append(rowOrder, rk)
		}
		acc.cells[ck] = r
		if len(colDims) > 0 {
			if _, seen := colNames[ck]; !seen {
				colNames[ck] = cnames
				colKeys = append(colKeys, ck)
			}
		}
	}
	sort.Strings(colKeys)

	var cols []matrixCol
	for _, dm := range rowDims {
		cols = append(cols, matrixCol{ID: "r:" + strings.TrimPrefix(dm.Key, "d_"), Label: dm.Label, Type: colText, Dim: true})
	}
	type cellRef struct{ colKey, measKey string }
	var refs []cellRef
	if len(colDims) == 0 {
		for i, ms := range res.Meas {
			cols = append(cols, matrixCol{ID: "m:" + strconv.Itoa(i), Label: ms.Label, Type: exportColType(ms.Type)})
			refs = append(refs, cellRef{"", ms.Key})
		}
	} else {
		for _, ck := range colKeys {
			for i, ms := range res.Meas {
				label := strings.Join(colNames[ck], " · ")
				if len(res.Meas) > 1 {
					label += " · " + ms.Label
				}
				cols = append(cols, matrixCol{ID: "c:" + ck + "|m:" + strconv.Itoa(i), Label: label, Type: exportColType(ms.Type)})
				refs = append(refs, cellRef{ck, ms.Key})
			}
		}
	}

	rows := make([][]any, 0, len(rowOrder))
	for _, rk := range rowOrder {
		acc := rowsByKey[rk]
		line := make([]any, 0, len(cols))
		for _, n := range acc.names {
			line = append(line, n)
		}
		for _, ref := range refs {
			if cell := acc.cells[ref.colKey]; cell != nil {
				line = append(line, cell[ref.measKey])
			} else {
				line = append(line, nil)
			}
		}
		rows = append(rows, line)
	}

	for i, c := range cols {
		if l := strings.TrimSpace(labels[c.ID]); l != "" {
			cols[i].Label = l
		}
	}

	if len(sorts) > 0 {
		idx := -1
		for i, c := range cols {
			if c.ID == sorts[0].Key {
				idx = i
				break
			}
		}
		if idx >= 0 {
			numeric := !cols[idx].Dim && exportNumeric(cols[idx].Type)
			desc := sorts[0].Dir == "desc"
			sort.SliceStable(rows, func(a, b int) bool {
				return matrixLess(rows[a][idx], rows[b][idx], numeric, desc)
			})
		}
	}

	if len(hidden) > 0 {
		hide := map[string]bool{}
		for _, h := range hidden {
			hide[h] = true
		}
		var keep []int
		for i, c := range cols {
			if !hide[c.ID] {
				keep = append(keep, i)
			}
		}
		if len(keep) < len(cols) {
			visible := make([]matrixCol, len(keep))
			for j, i := range keep {
				visible[j] = cols[i]
			}
			for ri, line := range rows {
				projected := make([]any, len(keep))
				for j, i := range keep {
					projected[j] = line[i]
				}
				rows[ri] = projected
			}
			cols = visible
		}
	}

	return pivotMatrix{Cols: cols, Rows: rows}
}

// matrixLess orders two cells. Empty cells go last in either direction, so sorting a
// measure high-to-low never opens with a page of blanks.
func matrixLess(x, y any, numeric, desc bool) bool {
	xb, yb := matrixCellBlank(x), matrixCellBlank(y)
	if xb || yb {
		return !xb && yb
	}
	c := 0
	if numeric {
		fx, fy := toFloat(x), toFloat(y)
		if fx < fy {
			c = -1
		} else if fx > fy {
			c = 1
		}
	} else {
		sx, sy := fmt.Sprint(x), fmt.Sprint(y)
		if sx < sy {
			c = -1
		} else if sx > sy {
			c = 1
		}
	}
	if desc {
		return c > 0
	}
	return c < 0
}

func matrixCellBlank(v any) bool {
	return v == nil || v == ""
}

// exportRows turns the matrix into the column/row shape the file writers take.
func (m pivotMatrix) exportRows() ([]exportCol, []map[string]any) {
	cols := make([]exportCol, len(m.Cols))
	for i, c := range m.Cols {
		cols[i] = exportCol{Key: "c" + strconv.Itoa(i), Label: c.Label, Type: c.Type}
	}
	rows := make([]map[string]any, len(m.Rows))
	for ri, line := range m.Rows {
		row := make(map[string]any, len(line))
		for i, v := range line {
			row[cols[i].Key] = v
		}
		rows[ri] = row
	}
	return cols, rows
}
