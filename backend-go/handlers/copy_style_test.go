package handlers

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The counterpart to the frontend's copyStyle.test.ts, for the copy that originates
// here: notification titles and bodies, and activity-log subjects. 21 em-dash
// connectors were removed from them on 2026-10-12 and nothing stopped them coming
// back.
//
// SCOPED TO COPY, WHICH IS THE WHOLE DIFFICULTY. backend-go holds 352 string literals
// containing an em dash and nearly all are diagnostics — "voice: AT inbound —
// customer lookup failed". Those are written for whoever is reading the log, exactly
// like a code comment, and sweeping them would be noise with a real risk of breaking
// a format string. So this does not grep the package: it PARSES it, and looks only at
// struct fields that carry copy a person reads.
//
// Replacement guidance, since the test cannot choose for you: a label joined to its
// value takes a colon ("Card issuance raised: Virtual"). Two clauses take a full
// stop. Where the middle term can itself contain a comma, parentheses read best
// ("Jane Doe (Lagos, Ikeja) is now with the Sales team").
var copyBearingFields = map[string]bool{
	"Subject": true,
	"Title":   true,
	"Body":    true,
	"Message": true,
}

func TestNotificationCopyHasNoEmDashConnector(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the handlers package: %v", err)
	}

	checked, offences := 0, 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		fset := token.NewFileSet()
		// Comments are dropped by not requesting them, so the repo's own prose — which
		// uses em dashes correctly and heavily — is never considered.
		file, err := parser.ParseFile(fset, filepath.Clean(name), nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		checked++

		ast.Inspect(file, func(n ast.Node) bool {
			kv, ok := n.(*ast.KeyValueExpr)
			if !ok {
				return true
			}
			key, ok := kv.Key.(*ast.Ident)
			if !ok || !copyBearingFields[key.Name] {
				return true
			}
			// The value may be a lone literal or a concatenation; either way, every
			// string literal inside it is copy.
			ast.Inspect(kv.Value, func(v ast.Node) bool {
				lit, ok := v.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					return true
				}
				if strings.Contains(lit.Value, " — ") {
					offences++
					t.Errorf("%s: %s copy uses an em dash as a connector: %s\n"+
						"    a label joined to its value takes a colon; two clauses take a full stop",
						name, key.Name, lit.Value)
				}
				return true
			})
			return true
		})
	}

	if checked == 0 {
		t.Fatal("parsed no handler files, so this test proves nothing")
	}
	if offences == 0 {
		t.Logf("%d handler files parsed, no em-dash connector in notification copy", checked)
	}
}

// The separator literal itself. `x + " — " + y` is always copy glue rather than a
// diagnostic, whatever field it ends up in, so it is worth catching on its own —
// seven of the 21 were this shape and sat in local variables, not struct fields.
func TestNoEmDashSeparatorLiteral(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the handlers package: %v", err)
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, filepath.Clean(name), nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", name, err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			if lit.Value == `" — "` || lit.Value == "\" — \"" {
				t.Errorf("%s joins two values with \" — \" — use \": \" for a label and "+
					"its value, or restructure the sentence", name)
			}
			return true
		})
	}
}
