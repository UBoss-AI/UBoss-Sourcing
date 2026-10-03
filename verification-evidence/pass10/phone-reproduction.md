# Seller phone operations: ENH-029

These runners render the existing five seller operation components with the real customer CSS/providers and canonical test fixtures. They use fixture fetch responses and block browser requests outside the private loopback preview. They do not prove hardware, other browsers, live APIs or a complete storefront navigation session.

From the repository root:

1. Run `node verification-evidence/pass10/phone-preview.cjs <absolute-repository-root>`.
2. Start the existing customer Vite development server on `127.0.0.1:5197`, with strict port selection. For an isolated checkout using dependency junctions, use the private customer config that allows the checkout and the existing shared world-atlas dependency.
3. Set `UBOSS_PHONE_PLAYWRIGHT_MODULE` to an installed Playwright module path if it is not resolvable normally; set `UBOSS_PHONE_BROWSER` to the installed Chromium executable if a Playwright browser cache is unavailable.
4. Run `node verification-evidence/pass10/phone-geometry.cjs <absolute-repository-root>`, then `node verification-evidence/pass10/phone-interactions.cjs <absolute-repository-root>`.
5. Inspect the ignored `output/pass10-phone` screenshots and JSON results. Stop only the private preview you started. Move the generated `apps/customer-web/output/phone-preview/main.tsx` outside the app TypeScript scan before running package lint/build; regenerate it for another preview run. No lint exclusions are required.

The checks cover five flows at 320×812 and 375×812 with touch enabled: RFQ reply, milestone recording, inspection readiness, trade-document upload and notification read. Geometry assertions prohibit document overflow and clipped visible controls. Interaction assertions preserve existing validation and payloads, including the full long PDF filename. The upload fixture is synthetic and makes no provider request.

Batch 7 stores the final measurements in `phone-results.json`. Physical-device and browser-matrix requirement DOD-043 remains open. Screenshots were visually reviewed locally; absolute workstation screenshot paths are omitted from committed results.
