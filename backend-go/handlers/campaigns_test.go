package handlers

import "testing"

func TestCampaignContactMergeDataHandlesNullMergeData(t *testing.T) {
	cases := []struct {
		name      string
		mergeData any
	}{
		{name: "json null bytes", mergeData: []byte("null")},
		{name: "json null string", mergeData: "null"},
		{name: "empty", mergeData: nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data := campaignContactMergeData(map[string]any{
				"merge_data": tc.mergeData,
				"first_name": "Ada",
				"last_name":  "Lovelace",
				"email":      "ada@example.com",
			})

			if got := data["first_name"]; got != "Ada" {
				t.Fatalf("first_name = %v, want Ada", got)
			}
			if got := data["name"]; got != "Ada Lovelace" {
				t.Fatalf("name = %v, want Ada Lovelace", got)
			}
		})
	}
}

func TestCampaignContactMergeDataKeepsCustomValues(t *testing.T) {
	data := campaignContactMergeData(map[string]any{
		"merge_data": []byte(`{"custom_code":"A1"}`),
		"first_name": "Ada",
	})

	if got := data["custom_code"]; got != "A1" {
		t.Fatalf("custom_code = %v, want A1", got)
	}
}
