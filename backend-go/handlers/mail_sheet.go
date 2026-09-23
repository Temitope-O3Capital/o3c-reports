package handlers

import (
	"fmt"
	"time"
)

// The O3 Capital house style for email, shared with the management reports so a
// notification, a password mail and the Monday sales report read as one family.
// The reference implementation is scripts/management-reports/lib.js; these values
// are copied from it deliberately rather than derived, because the two runtimes
// (Go and Node) render different mail and only the palette has to agree.
//
// The masthead carries a typographic wordmark rather than the logo image. Most
// corporate clients block remote and inline images by default, and the old navy
// header then rendered as an empty navy block with no brand on it at all. Letter
// spaced caps always render.
const (
	shInk   = "#16171a" // body copy and figures
	shInk2  = "#5f6167" // secondary copy
	shInk3  = "#8b8d93" // labels
	shFaint = "#a9a7a2" // footnotes
	shHair  = "#e6e4df" // section rules
	shHair2 = "#f0eeea" // row rules
	shBrass = "#8c6a3f" // the one accent
	shDown  = "#9b3232"
	shSans  = "Arial,Helvetica,sans-serif"
	shSerif = "Georgia,'Times New Roman',serif"
	shPage  = "#e8e6e1" // the ground the sheet sits on
	shPaper = "#fffffe" // the sheet itself
)

// o3SheetCSS is the shared style block. Row type lives in classes rather than
// inline styles for the same reason the reports do it: Gmail clips a message near
// 102KB and inline styles on every cell spend that budget on nothing.
func o3SheetCSS() string {
	return `
  :root{color-scheme:only light;supported-color-schemes:light}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;
    font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}
  [data-ogsc] .sheet,[data-ogsb] .sheet{background:` + shPaper + `!important}
  [data-ogsc] .ink{color:` + shInk + `!important}
  [data-ogsc] .mut{color:` + shInk2 + `!important}
  .p{margin:0 0 14px;font-family:` + shSans + `;font-size:13.5px;line-height:21px;color:` + shInk2 + `}
  .p:last-child{margin-bottom:0}
  .lead{margin:0 0 16px;font-family:` + shSerif + `;font-size:16px;line-height:24px;color:` + shInk + `}
  .fine{margin:14px 0 0;font-family:` + shSans + `;font-size:11px;line-height:17px;color:` + shFaint + `}
  .ng{font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif}
  @media screen and (max-width:680px){
    .pad{padding-left:22px!important;padding-right:22px!important}
    .h1{font-size:23px!important;line-height:28px!important}
  }
  @media screen and (max-width:420px){
    .pad{padding-left:15px!important;padding-right:15px!important}
    .h1{font-size:20px!important;line-height:25px!important}
  }`
}

// o3Sheet renders the full document: the paper sheet on its ground, a brass hair
// rule, the wordmark, then whatever the caller puts in the body, then the footer.
// title and dateline may be empty, in which case the caller's own body supplies
// the headline (this is how the support and transactional mails work).
func o3Sheet(preheader, title, dateline, bodyHTML, footerHTML string) string {
	return o3SheetLogo(preheader, title, dateline, bodyHTML, footerHTML, "")
}

// o3SheetLogo is o3Sheet with an optional logo above the wordmark. Admin → Mail
// lets someone upload a logo (stored as EMAIL_LOGO_URL), and that upload has to
// keep working; the wordmark stays underneath so a client that blocks the image
// still shows the brand.
func o3SheetLogo(preheader, title, dateline, bodyHTML, footerHTML, logoURL string) string {
	mark := ""
	if logoURL != "" {
		// 34px, not smaller: below that the white rings separating the three circles
		// go muddy and the mark stops reading as three circles.
		mark = `<img src="` + logoURL + `" alt="O3 Capital" height="34" style="display:block;border:0;height:34px;width:auto;margin:0 0 16px">`
	}
	head := ""
	if title != "" {
		head = `<p class="ink h1" style="margin:0 0 6px;font-family:` + shSerif +
			`;font-size:29px;line-height:34px;mso-line-height-rule:exactly;color:` + shInk + `">` + title + `</p>`
	}
	if dateline != "" {
		head += `<p class="mut" style="margin:0;font-family:` + shSans +
			`;font-size:12.5px;line-height:18px;color:` + shInk2 + `">` + dateline + `</p>`
	}

	return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="only light"><meta name="supported-color-schemes" content="light">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<style>` + o3SheetCSS() + `</style>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<style>table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:` + shPage + `;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">` + preheader + `&#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:` + shPage + `">
  <tr><td align="center" valign="top" style="padding:24px 12px 40px">
<table role="presentation" class="sheet" align="center" bgcolor="` + shPaper + `" width="680" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;width:100%;margin:0 auto;background:` + shPaper + `">
  <tr><td style="background:` + shBrass + `;font-size:1px;line-height:2px;height:2px">&#160;</td></tr>
  <tr><td class="pad" style="padding:32px 40px 0">
    ` + mark + `
    <p class="mut" style="margin:0 0 20px;font-family:` + shSans + `;font-size:10px;line-height:14px;color:` + shInk3 + `;letter-spacing:2.4px">O 3 &nbsp; C A P I T A L</p>
    ` + head + `
  </td></tr>
  <tr><td class="pad" style="padding:` + bodyTopPad(title) + ` 40px 0">` + bodyHTML + `</td></tr>
  <tr><td class="pad" style="padding:28px 40px 34px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ` + shHair + `;padding-top:14px">
    <p class="mut" style="margin:0;font-family:` + shSans + `;font-size:10.5px;line-height:16px;color:` + shFaint + `">` + footerHTML + `</p>
    </td></tr></table></td></tr>
</table>
  </td></tr>
</table>
</body></html>`
}

// bodyTopPad closes the gap under the wordmark when there is no masthead title,
// so a mail whose headline lives in its own body does not open with dead space.
func bodyTopPad(title string) string {
	if title == "" {
		return "6px"
	}
	return "26px"
}

// sheetDateline is the line the reports carry under their headline. Lagos has no
// DST, so a fixed +1 offset is correct all year.
func sheetDateline() string {
	return time.Now().UTC().Add(time.Hour).Format("Monday 2 January 2006, 15:04") + " WAT"
}

// o3Button is the house call to action: a solid ink block, not a coloured pill.
// Table markup so Outlook renders the background.
func o3Button(text, url string) string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px"><tr>` +
		`<td bgcolor="` + shInk + `" style="background:` + shInk + `;border-radius:2px">` +
		`<a href="` + url + `" target="_blank" style="display:inline-block;padding:13px 28px;color:#ffffff;` +
		`text-decoration:none;font-family:` + shSans + `;font-size:11.5px;letter-spacing:1.4px;text-transform:uppercase">` +
		text + `</a></td></tr></table>`
}

// o3Highlight sets one value apart: a brass rule, a small letterspaced label and
// the value itself. Monospace, because the only thing shown this way so far is a
// temporary password and the reader has to copy it character by character.
func o3Highlight(label, value string) string {
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0"><tr>` +
		`<td style="border-left:2px solid ` + shBrass + `;padding:14px 0 14px 18px">` +
		`<div style="font-family:` + shSans + `;font-size:9px;line-height:12px;letter-spacing:1.1px;text-transform:uppercase;color:` + shInk3 + `">` + label + `</div>` +
		`<div style="font-family:Consolas,Menlo,monospace;font-size:21px;line-height:28px;color:` + shInk + `;letter-spacing:1px;margin-top:5px">` + value + `</div>` +
		`</td></tr></table>`
}

// o3SheetFooter is the standing footer for staff workspace mail.
const o3SheetFooter = `O3 Capital Workspace &middot; Sent from <strong>no-reply@o3cards.com</strong>, which does not take replies.`

// wrapBrandedEmail wraps staff-facing transactional mail (login details, access
// requests) in the house sheet. The caller supplies its own headline.
func wrapBrandedEmail(preheader, innerHTML string) string {
	return o3Sheet(preheader, "", "", innerHTML, o3SheetFooter)
}

// customerLogoCID is the inline logo reference. Customer mail carries the mark and
// staff mail does not (Temitope, 2026-09-23): a customer reading about a disputed
// charge needs to recognise the sender at a glance, and an email with no mark at all
// is what a phishing attempt looks like. Staff sign into the workspace daily and have
// no such problem, so their mail stays typographic and the red stays off the page.
// The mark sits above the wordmark, so a client that blocks images loses nothing.
const customerLogoCID = "cid:o3logo"

// wrapCustomerEmail wraps mail going to a customer: the house sheet, the mark, and a
// footer naming the company rather than the workspace. Callers MUST attach
// brandedLogoAttachment().
func wrapCustomerEmail(preheader, innerHTML, footer string) string {
	return o3SheetLogo(preheader, "", "", innerHTML, footer, customerLogoCID)
}

// wrapSupportEmail wraps a reply to a customer on a support ticket. This thread is a
// conversation and the customer replying to it is how the next message reaches the
// agent, so it must not carry the do-not-reply line that staff mail carries.
func wrapSupportEmail(preheader, innerHTML string) string {
	return wrapCustomerEmail(preheader, innerHTML,
		`O3 Capital Nigeria Limited &middot; Reply to this email and it reaches the agent handling your ticket.`)
}

// notifEmailHTML renders one notification on the house sheet.
func notifEmailHTML(title, body, actionURL, logoURL string) string {
	appURL := workspaceURL()

	inner := `<p class="lead">` + body + `</p>`
	if actionURL != "" {
		inner += o3Button("Open in the workspace", appURL+actionURL)
	}

	footer := `You are getting this because you work at O3 Capital. ` +
		`<a href="` + appURL + `/settings/notifications" style="color:` + shBrass + `">Change which notifications reach you</a>.`

	return o3SheetLogo(title, title, sheetDateline(), inner, footer, logoURL)
}

// buildNotifEmail is the name notify.go calls.
func buildNotifEmail(title, body, actionURL, logoURL string) string {
	return notifEmailHTML(title, body, actionURL, logoURL)
}

// hdCSATScaleHTML renders a one-to-five rating scale the customer can answer from
// inside the email. Each number is its own link, so the tap is recorded the moment
// they land. Table markup with real borders rather than emoji stars: stars render
// at a different size in every client and several show them as tofu.
func hdCSATScaleHTML(baseURL string) string {
	cells := ""
	for n := 1; n <= 5; n++ {
		cells += fmt.Sprintf(
			`<td width="54" style="padding:0 8px 0 0">`+
				`<a href="%s?score=%d" target="_blank" style="display:block;text-align:center;padding:13px 0;`+
				`border:1px solid %s;border-radius:2px;text-decoration:none;font-family:%s;font-size:19px;color:%s">%d</a>`+
				`</td>`,
			baseURL, n, shHair, shSerif, shInk, n)
	}
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 22px"><tr>` +
		cells + `</tr><tr>` +
		`<td colspan="2" style="padding-top:7px;font-family:` + shSans + `;font-size:10px;letter-spacing:.6px;color:` + shFaint + `">POOR</td>` +
		`<td colspan="3" align="right" style="padding-top:7px;padding-right:8px;font-family:` + shSans + `;font-size:10px;letter-spacing:.6px;color:` + shFaint + `">EXCELLENT</td>` +
		`</tr></table>`
}

// o3Para is a body paragraph in the house style, for callers assembling inner HTML.
func o3Para(html string) string { return `<p class="p">` + html + `</p>` }

// o3Headline is the sheet headline for a mail whose title lives in its body.
func o3Headline(text string) string {
	return fmt.Sprintf(`<p class="ink h1" style="margin:0 0 16px;font-family:%s;font-size:29px;line-height:34px;mso-line-height-rule:exactly;color:%s">%s</p>`,
		shSerif, shInk, text)
}
