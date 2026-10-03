# Final term sheet phone verification

Run from the repository root with Node available on PATH. Use a private preview port;
the runner blocks network requests outside its own loopback origin. The generated
preview uses canonical negotiation test fixtures and real customer components,
styles and providers. Its API calls are intercepted fixtures.

```powershell
node verification-evidence/pass10/summary-browser-prepare.cjs (Get-Location).Path
$env:UBOSS_PHONE_PLAYWRIGHT_MODULE = 'path/to/playwright'
$env:UBOSS_PHONE_BROWSER = 'path/to/chrome.exe'
# Start customer Vite on 127.0.0.1:5197 with the usual customer configuration.
node verification-evidence/pass10/summary-browser.cjs (Get-Location).Path
```

`summary-browser-prepare.cjs` calls the existing phone-preview generator and
extracts its negotiation fixtures from `NegotiationPanel.test.tsx`. Preview files
and screenshots are written only under ignored `output/` paths. Relocate the
generated `apps/customer-web/output/phone-preview/main.tsx` to `.tsx.preview`
before complete lint checks; do not add a lint exclusion.

Two Chromium touch contexts (320×812 and 375×812) check 18 clauses, zero acceptance
calls on opening, viewport bounds, scroll access to export documents and exact
displayed version/hash submission. Screenshot capture waits for the native open
dialog to finish its entrance animation. Top and scrolled screenshots are captured
at viewport size. Results: `summary-browser-results.json`.

This is deterministic fixture software verification. Supported physical devices,
other browser engines and live backend/provider acceptance remain separate checks.
