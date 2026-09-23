package handlers

import (
	"encoding/json"
	"os"
	"testing"
)

// Preview harness for the house sheet: writes the staff mail shells to disk so the
// rendered design can be screenshotted or posted into a real inbox. Skipped unless
// MAIL_PREVIEW_DIR is set, so it costs a normal test run nothing.
//
// The names and figures below are invented. Nothing here reads the database.
func TestWriteMailPreviews(t *testing.T) {
	dir := os.Getenv("MAIL_PREVIEW_DIR")
	if dir == "" {
		t.Skip("set MAIL_PREVIEW_DIR to render previews")
	}

	type sample struct {
		File    string `json:"file"`
		Subject string `json:"subject"`
		Text    string `json:"text"`
	}
	var manifest []sample

	write := func(name, subject, text, html string) {
		if err := os.WriteFile(dir+"/"+name, []byte(html), 0o644); err != nil {
			t.Fatal(err)
		}
		manifest = append(manifest, sample{File: name, Subject: subject, Text: text})
		t.Logf("%-28s %5.1fKB  %s", name, float64(len(html))/1024, subject)
	}

	// 1. A sales alert: the shape an account manager sees most often.
	write("preview-notification.html",
		"FD Maturing in 3 Days: Adebayo Okonkwo",
		"The fixed deposit for Adebayo Okonkwo (CIF 0041882, a/c 1002847113) matures on 26 September. "+
			"That is N50,000,000 in principal and interest. Get the instruction in writing today.",
		buildNotifEmail(
			"FD Maturing in 3 Days: Adebayo Okonkwo",
			"The fixed deposit for Adebayo Okonkwo (CIF 0041882, a/c 1002847113) matures on 26 September. "+
				"That is &#8358;50,000,000 in principal and interest. Get the instruction in writing today.",
			"/sales/accounts?cif=0041882", ""))

	// 2. A grouped digest: no single record to land on, so no button.
	write("preview-digest.html",
		"142 Unassigned Tickets",
		"142 tickets on the floor have nobody working them. The oldest has been waiting six days.",
		buildNotifEmail(
			"142 Unassigned Tickets",
			"142 tickets on the floor have nobody working them. The oldest has been waiting six days.",
			"", ""))

	// 3. An approval request.
	write("preview-approval.html",
		"Write-Off Awaiting Your Approval",
		"A N4,820,000 write-off request needs Head of Recovery sign-off.",
		buildNotifEmail(
			"Write-Off Awaiting Your Approval",
			"A &#8358;4,820,000 write-off request needs Head of Recovery sign-off.",
			"/recovery/write-offs", ""))

	// 4. Login details.
	write("preview-password.html",
		"Your O3 Capital Workspace Login",
		"Hello Chinedu,\n\nSign in with the temporary password below. The workspace will ask you to choose "+
			"your own password straight away.\n\nTemporary password: 7f3a9c21d8e40b56",
		wrapBrandedEmail("Your O3 Capital Workspace login is ready",
			o3Headline("Your O3 Capital Workspace Login")+
				o3Para("Hello Chinedu,")+
				o3Para("Sign in with the temporary password below. The workspace will ask you to choose your own password straight away.")+
				o3Highlight("Temporary Password", "7f3a9c21d8e40b56")+
				o3Button("Sign in to the workspace", "https://crm.o3cards.pri:8443")+
				`<p class="fine">If you were not expecting this email, tell your administrator.</p>`))

	// 5. Access request acknowledgement.
	write("preview-access.html",
		"Access Request Received",
		"Hi Ngozi,\n\nWe have your request for access to the O3 Capital Workspace. An administrator will "+
			"review it and switch your account on.",
		wrapBrandedEmail("An administrator will review your access request",
			o3Headline("Access Request Received")+
				o3Para("Hi Ngozi,")+
				o3Para("We have your request for access to the <strong>O3 Capital Workspace</strong>. An administrator will review it and switch your account on.")+
				o3Para("They will send your login details to this address once they do.")))

	// 6. The CSAT ask. Customer-facing, so it carries the mark.
	write("preview-csat.html",
		"How did we do on TKT-20841?",
		"Hi Mrs Adeyemi,\n\nWe have closed your support request TKT-20841. Tell us how it went, "+
			"1 for poor and 5 for excellent.",
		wrapCustomerEmail("One tap tells us how your support request went.",
			o3Headline("How did we do?")+
				o3Para("Hi Mrs Adeyemi,")+
				o3Para("We have closed your support request <strong>TKT-20841</strong>. One tap below tells us how it went, and the number you pick is recorded straight away.")+
				hdCSATScaleHTML("https://crm.o3cards.pri:8443/csat/abc123")+
				o3Para("The Customer Care team<br>O3 Capital"),
			`O3 Capital Nigeria Limited &middot; You deserve more.`))

	// 7. A customer-facing support reply: same sheet, a footer that invites the reply.
	write("preview-support.html",
		"Re: Disputed POS charges [TKT-20841]",
		"Good afternoon Mrs Adeyemi,\n\nWe have raised the dispute on the two POS charges of N18,500 you "+
			"reported yesterday. The provisional credit reaches your account within three working days.",
		wrapSupportEmail("We have raised your dispute and the provisional credit is on its way.",
			o3Para("Good afternoon Mrs Adeyemi,")+
				o3Para("We have raised the dispute on the two POS charges of &#8358;18,500 you reported yesterday. The provisional credit reaches your account within three working days while the merchant is queried.")+
				o3Para("Your reference is <strong>TKT-20841</strong>.")+
				o3Para("Folake Adeniyi<br>Customer Care, O3 Capital")))

	b, _ := json.MarshalIndent(manifest, "", " ")
	if err := os.WriteFile(dir+"/manifest.json", b, 0o644); err != nil {
		t.Fatal(err)
	}
}
