# Authorization matrix

Who may see or change each kind of record, where the server enforces it, and
which test proves it. Hiding a button in the UI is never the control. Every
rule below is checked on the server, on every request.

Two layers apply to every request:

1. **The role check.** A staff route names one permission
   (`requireAdmin(Permission.X)`). A Seller Hub route names one seller
   permission (`requireSeller(SellerPermission.X)`). A storefront route needs a
   signed-in customer (`requireCustomer`).
2. **The ownership check.** The service then loads the record *through* the
   caller's own scope: their customer profile, their seller account, their
   agency membership or their logistics organisation. A record outside that
   scope is answered as "not found" (404). Changing an id in the URL or the
   body therefore finds nothing.

## Who can reach what

| Record | Buyer | Buyer-company member | Seller member | Inspection agency | Inspector | Logistics partner / driver | Staff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Order | Own orders only | Company orders, by company role | Only the part of the order it sells | No | No | Only shipments assigned to them | `order.read` |
| Invoice, receipt, trade document | Own orders only; one-use signed link | As above | Documents it issued | No | No | No | `invoice.read` |
| RFQ and quotes | Own requests only | Company requests, by company role | Only requests it was invited to | No | No | No | No |
| Inspection job | Timeline of own order | As above | Readiness and NCRs for its own order part | Jobs booked with that agency | Only jobs that name them | No | `inspection.read`, `inspection.manage` |
| Inspection evidence | Released findings of own order | As above | Its own uploads and its NCRs | Its agency's jobs | Jobs that name them | No | `inspection.read` |
| Settlements, ledger, payouts | No | No | Its own seller account, by `FINANCE_VIEWER` or owner | Its own invoices | No | No | Finance permissions only |
| KYB and identity documents | Own KYC | Own company | Its own seller account | Its own members | No | Own organisation | `customer.read`; decisions need `customer.status.write` |
| Privacy (data-subject) requests | Own requests | Own requests | Own requests | Own requests | Own requests | Own requests | `data_request.read` / `data_request.action` |

## Staff roles (least privilege)

| Role | Can | Cannot |
| --- | --- | --- |
| Business Owner | Everything, including roles and payment setup | — |
| Catalog Manager | Catalogue, media, coupons, reviews | Payments, refunds, orders |
| Inventory Manager | Stock and warehouses | Payments, refunds |
| Order Manager | Orders, fulfilment, cancellations, returns, disputes | Refunds, payment setup, roles |
| Finance / Approver | Payments, refunds, finance policy, invoices, conditional release | Roles, catalogue deletion |
| Support Agent | Read orders; answer support tickets and preorder chats; read disputes | Refund, cancel, fulfil, decide disputes, privacy requests, export, settings, staff |
| Compliance Officer | Seller, factory and business-buyer verification decisions; suspend accounts; privacy requests; audit log | Refunds, payments, finance policy, catalogue changes, invoices, settings, staff, roles |

Only the Business Owner holds `role.assign`, `staff.write` and
`feature_flag.write`. A role can be granted or removed only by somebody who
already holds every permission in it, so nobody can raise their own access.
The last Business Owner cannot remove their own role. Changing a seller team
member's role needs a recent password step-up, and a seller cannot change
their own role or that of somebody holding more than them. Every role change
writes an audit entry.

**Deactivation.** Deactivating a customer, staff member or seller member
revokes every session at once. The next request answers 401.

**Overrides.** Admin overrides (conditional inspection release, refunds,
dispute decisions) each need their own permission. The money-moving ones also
need a second person (maker-checker). All of them are written to the
append-only audit log.

## Tests that prove it

| Test | What it proves |
| --- | --- |
| `backend/tests/unit/staff-least-privilege.test.ts` | The role table: who holds role assignment, money, privacy and administration |
| `backend/tests/integration/authorization-matrix.test.ts` | Cross-buyer, cross-seller, cross-agency, unassigned inspector, staff scope, self-escalation, deactivation |
| `backend/tests/integration/session-isolation.test.ts` | Storefront, admin and Seller Hub sessions cannot be swapped |
| `backend/tests/integration/rfq-create.test.ts`, `rfq-responses.test.ts` | Another buyer's RFQ answers 404 for every verb; an uninvited seller cannot open it |
| `backend/tests/integration/logistics-tenant-isolation.test.ts` | One logistics partner never sees another's shipments |
| `backend/tests/integration/logistics-driver-location.test.ts` | A driver sees and updates only their own assigned deliveries |
| `backend/tests/integration/seller-team.test.ts` | Seller role changes, removal and the last-owner rule |
| `backend/tests/integration/anonymous-access.test.ts` | Every non-public route refuses an anonymous caller |
| `backend/tests/integration/inspection-http.test.ts` | Agency roles inside one job: only the named inspector records checks; QA signs |
