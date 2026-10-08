# HTTP smoke against local API 127.0.0.1:4000 (2026-09-29 ~02:10 IST)
- Every response: Helmet headers; API CSP default-src 'none'; frame-ancestors 'none'; X-Content-Type-Options nosniff; Referrer-Policy no-referrer; COOP same-origin.
- Errors: JSON {error:{code,message,details,correlationId}} + x-correlation-id header (e.g. GET /api/v1/does-not-exist -> 404 NOT_FOUND, correlationId present).
- GET /api/v1/admin/orders without session -> 401 UNAUTHENTICATED.
- OPTIONS preflight with Origin https://evil.example -> no Access-Control-Allow-Origin returned.
