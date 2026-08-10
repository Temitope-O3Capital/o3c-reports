package handlers

import "testing"

// taskActionURL decides where a task notification lands. Getting it wrong is silent —
// the notification still arrives and still clicks through, it just goes somewhere
// useless — so the routing table is asserted rather than trusted. The previous
// implementation sent every task to "/crm/tasks", which is not a route in this app.
func TestTaskActionURL(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   taskContext
		want string
	}{
		{
			"explicit customer link uses the CIF",
			taskContext{ID: 7, LinkedType: "customer", ContactCIF: "00031245"},
			"/sales/book/00031245?task=7",
		},
		{
			"customer link without a CIF pads linked_id to eight digits",
			taskContext{ID: 7, LinkedType: "customer", LinkedID: 31245},
			"/sales/book/00031245?task=7",
		},
		{
			"application link goes to the application",
			taskContext{ID: 8, LinkedType: "loan_application", LinkedID: 42},
			"/sales/applications/42?task=8",
		},
		{
			"linked_type is matched case-insensitively",
			taskContext{ID: 8, LinkedType: "Loan_Application", LinkedID: 42},
			"/sales/applications/42?task=8",
		},
		{
			"a converted lead routes to the book, not back to the lead queue",
			taskContext{ID: 9, ContactID: 500, ContactCIF: "00012345"},
			"/sales/book/00012345?task=9",
		},
		{
			"an unconverted lead routes to the lead queue",
			taskContext{ID: 10, ContactID: 500},
			"/sales/leads?task=10",
		},
		{
			"a deal routes to the pipeline",
			taskContext{ID: 11, DealID: 3},
			"/sales/crm?task=11",
		},
		{
			"a deal beats a bare contact when both are set",
			taskContext{ID: 12, ContactID: 500, DealID: 3},
			"/sales/crm?task=12",
		},
		{
			"nothing to anchor to falls back to the task list",
			taskContext{ID: 13},
			"/sales/tasks?task=13",
		},
		{
			"an unrecognised linked_type falls through to the inferred route",
			taskContext{ID: 14, LinkedType: "something_else", ContactID: 500},
			"/sales/leads?task=14",
		},
		{
			"a customer linked_type with neither CIF nor id does not emit an empty path",
			taskContext{ID: 15, LinkedType: "customer"},
			"/sales/tasks?task=15",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := taskActionURL(&tc.in); got != tc.want {
				t.Errorf("taskActionURL() = %q, want %q", got, tc.want)
			}
		})
	}
}
