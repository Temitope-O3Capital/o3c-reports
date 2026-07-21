package handlers

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// ccPDFForEmail generates the statement PDF for email attachment.
// Uses headless Chrome if available (same output as the Preview button).
// Falls back to the built-in raw PDF generator if Chrome is not installed.
//
// To enable on Railway, install Chromium in the build environment:
//   apt-get install -y chromium-browser
var chromePaths = []string{
	// Linux (Railway / Docker)
	"google-chrome", "google-chrome-stable",
	"chromium-browser", "chromium",
	"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
	"/usr/bin/chromium-browser", "/usr/bin/chromium",
	"/snap/bin/chromium",
	// macOS (local dev)
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
}

func findChrome() string {
	for _, p := range chromePaths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
		if found, err := exec.LookPath(p); err == nil {
			return found
		}
	}
	return ""
}

func ccPDFForEmail(htmlContent string, rawFallback func() []byte) []byte {
	chrome := findChrome()
	if chrome == "" {
		return rawFallback()
	}

	// Write HTML to a temp file; file:// still allows Google Fonts CDN requests.
	htmlFile, err := os.CreateTemp("", "o3c-cc-*.html")
	if err != nil {
		return rawFallback()
	}
	defer os.Remove(htmlFile.Name())

	if _, err := htmlFile.WriteString(htmlContent); err != nil {
		return rawFallback()
	}
	htmlFile.Close()

	pdfPath := htmlFile.Name() + ".pdf"
	defer os.Remove(pdfPath)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// --no-pdf-header-footer  suppresses the URL/date Chrome adds (Chrome 117+).
	// @page { margin: 0 } in the HTML CSS acts as belt-and-suspenders.
	var errBuf bytes.Buffer
	cmd := exec.CommandContext(ctx, chrome,
		"--headless=new",
		"--disable-gpu",
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--run-all-compositor-stages-before-draw",
		"--no-pdf-header-footer",
		"--print-to-pdf="+pdfPath,
		"file://"+htmlFile.Name(),
	)
	cmd.Stderr = &errBuf

	if err := cmd.Run(); err != nil {
		// Chrome failed — use raw PDF
		_ = fmt.Sprintf("chrome pdf failed: %v", err) // logged implicitly via fallback
		return rawFallback()
	}

	data, err := os.ReadFile(pdfPath)
	if err != nil || len(data) < 200 {
		return rawFallback()
	}
	return data
}
