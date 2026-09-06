# EU VAT and invoicing

How this software decides what VAT to charge, what it needs from you before it
can, and where its limits are.

> **Nothing here is tax advice, and none of it is switched on by default.**
> Until a business profile names a `vatCountry`, every order is taxed at its
> tax class's own flat percentage — exactly as this system behaved before EU
> VAT existed in it. That is deliberate: the same codebase runs an Indian GST
> shop and a Dutch one, and switching this on is a decision you make with your
> accountant, not a migration.

---

## 1. Turning it on

Four steps, in order. Do not skip step 3.

1. **Name the seller.** Settings → Business profile: set `vatCountry` (the
   member state you are established in for VAT) and `vatNumber`. `vatCountry`
   is the switch — while it is null, none of the rest of this document applies.

2. **Flag the VAT area.** `npm run db:reference` marks the twenty-seven member
   states `isEuVat` and seeds their standard and reduced rates. The flag is per
   country rather than a hard-coded list, because the EU VAT area is not the
   same set as the EU — the Canary Islands are Spain and outside it, Livigno is
   Italy and outside it, Monaco is not the EU and is inside it.

3. **Verify the rates.** The seeded figures are a starting point so a fresh
   deployment can price something on day one. They are not a live feed, and
   member states change rates with a few months' notice. Check every rate you
   sell at against the Commission's published table before your first invoice.
   Correct one by adding a period, never by editing — see §3.

4. **Band your tax classes.** A tax class with no `vatCategory` has no EU
   meaning and keeps using its flat rate wherever it is sold. Give each one a
   band (`STANDARD`, `REDUCED`, `SUPER_REDUCED`, `ZERO`, `EXEMPT`) and the rate
   becomes a lookup against the destination member state.

   A product whose class has no band, sold under an EU treatment, **blocks the
   line** with an explanation rather than quietly using the flat rate. That is
   intentional: a wrong-country rate is an undercharge that surfaces at an
   audit.

---

## 2. What gets charged, and why

`modules/tax/vat.service.ts`. Every order records which of these applied, and
`reason` explains it in a sentence the admin panel shows.

| Situation | Treatment | Rate | Invoice must say |
|---|---|---|---|
| No `vatCountry` configured | `FLAT_RATE` | The tax class's own | — |
| Delivered inside your own member state | `DOMESTIC` | Yours, for the product's band | — |
| Another member state, customer's VAT number **confirmed by VIES** | `INTRA_EU_REVERSE_CHARGE` | 0% | Arts. 138 and 196 |
| Another member state, number missing, refused, or **unchecked** | `INTRA_EU_B2C` | The **destination's**, for the band | — |
| Delivered outside the EU VAT area | `EXPORT` | 0% | Art. 146 |
| No delivery address yet (browsing) | `DOMESTIC` | Yours — a quote | — |

Four things worth knowing:

- **A domestic B2B sale is not reverse-charged.** The reverse charge is an
  intra-Community mechanism, not a business-customer discount. Selling to a
  Dutch hospital from the Netherlands is 21%, VAT number or no VAT number.

- **Unchecked is treated as invalid.** Art. 138(1)(b) puts the burden of the
  customer's status on the seller. A number nobody has confirmed is not
  evidence, so the sale is taxed. Being wrong that way costs the customer cash
  flow; being wrong the other way costs you the tax.

- **The delivery address decides, not the customer's stated country.** Art. 33
  follows the goods. Prices shown before checkout are a quote at your own
  rates, and the cart is repriced against the real address before any money
  moves.

- **The €10,000 distance-selling threshold is not implemented.** It is a
  whole-business annual figure across every member state, and this software
  sees only its own orders. Destination rates are charged from the first euro,
  which is never unlawful. If you are under the threshold and want to charge
  your own rate instead, that is a conversation with your accountant, not a
  setting.

### Tax-inclusive catalogues

If your prices include VAT, a cross-border sale converts the listed gross back
to net at **your** rate first, then applies the destination's rate (or none) on
top. A €121 listing in the Netherlands invoices a German wholesaler at €100 and
no tax.

Keeping the €121 and zeroing the tax line — the obvious shortcut — overcharges
the customer by 21% and hands you money that is not yours. Treating €121 as the
net overcharges by the same amount in the other direction. See `applyLineTax`.

---

## 3. Rates are periods, not values

A rate change is not an edit. Germany's standard rate was 16% for six months in
2020, and an invoice raised in that window is still correct at 16% forever.

So each `vat_rates` row carries a `validFrom`, the lookup takes the latest
period that has started, and correcting a rate means **adding a row with a
later start date**. `PATCH` can only close a period; the percentage itself is
immutable, because every invoice raised while it was in force states it. There
is no `DELETE`.

---

## 4. VAT number checking (VIES)

`VIES_CHECK_URL`, empty to switch it off.

VIES is the Commission's front door onto twenty-seven national registers. It
holds nothing itself — an enquiry about a German number is forwarded to
Germany, and answers only as well as Germany's system is answering that
afternoon.

- **Three outcomes, not two.** Valid, invalid, and *could not ask*. A timeout
  is not a "no". Only a confirmed number zero-rates a supply.
- **Answers are cached for a week**, failures for an hour. A number confirmed
  this morning is good enough this afternoon; one confirmed last year is not,
  because registrations get cancelled and you carry the liability.
- **Keep the consultation number.** Art. 31 of Regulation 904/2010 lets you
  rely on what VIES told you, and the reference it returns is the evidence you
  were told it. It is stored on the customer and on the audit trail.
- **Switching checking off is safe.** Every number then reads as unverified,
  and unverified is taxed rather than zero-rated.

Changing a customer's VAT number clears the previous verdict. It has to: the
new number has not been checked, and carrying the old confirmation forward
would zero-rate a supply on the strength of a different company's registration.

---

## 5. Invoices

`modules/invoicing/invoice.service.ts`. An invoice is not a view over an order.
Art. 226 lists what one must contain, national law requires it be kept for six
to ten years, and it must not change afterwards — so everything it says is
frozen into the row at issue and nothing here has an update path.

| Art. 226 | Where |
|---|---|
| (1) date of issue | `issuedAt` |
| (2) sequential number | `number`, from a locked counter — see below |
| (3) seller's VAT number | `sellerVatNumber` |
| (4) customer's VAT number | `buyerVatNumber` |
| (5) both parties' full name and address | `sellerJson`, `buyerJson` |
| (6) quantity and description | `linesJson` |
| (7) date of supply | `suppliedAt`, separate from the issue date |
| (8) taxable amount per rate | `vatBreakdownJson` |
| (9) rate applied | per line and per breakdown row |
| (10) VAT payable | `taxMinor`, and per breakdown row |
| (11) exemption reference where no VAT is charged | `exemptionNote` |

**The number comes from a locked counter, not a count.** `SELECT COUNT(*) + 1`
issues the same number twice under concurrency. Tax authorities read gaps as
deleted invoices, so the number is allocated inside the transaction that writes
the row and a rolled-back issue takes its number back with it.

**Corrections are credit notes.** There is no edit and no delete. The original
stands and a second document of equal and opposite value is issued against it,
in the same series.

**Issuing is idempotent by order.** Two numbers against one supply is a real
problem to unpick once both are in a VAT return.

---

## 6. The electronic invoice

`modules/invoicing/ubl.service.ts`. `GET /admin/invoices/:id/ubl` renders the
issued invoice as EN 16931 in UBL 2.1, in the Peppol BIS Billing 3.0
customisation:

```
CustomizationID  urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0
ProfileID        urn:fdc:peppol.eu:2017:poacc:billing:01:1.0
```

These are the bytes an access point, the Italian SdI or Chorus Pro expects to be
handed. The panel offers it as a download, and the same function is what an AP
integration would call — **transporting it is a separate step this software does
not perform** (see §7).

**Nothing is invented at render time.** The XML is built from the frozen
`Invoice` row, not from the order, so a document rendered a year later is byte-identical
to one rendered on the day it was issued.

### VAT category codes

The category code is what a receiver's validator reads to decide whether a zero
figure is legitimate, so it is derived from the treatment rather than from the
rate being zero (UNCL5305):

| Treatment | Code | Meaning |
|---|---|---|
| `DOMESTIC`, `INTRA_EU_B2C`, `FLAT_RATE` at a rate above zero | `S` | Standard rate |
| any of those at a zero rate | `Z` | Zero rated |
| `INTRA_EU_REVERSE_CHARGE` | `K` | Intra-Community supply |
| `EXPORT` | `G` | Export outside the EU |
| exempt with an exemption note | `E` | Exempt |

`K` and not `AE`: `AE` is a *domestic* reverse charge, a different transaction
that a validator will not accept an intra-Community supply under. Every zero
figure carries a `TaxExemptionReason`, because BR-E-10, BR-IC-10 and BR-Z-* all
reject a zero without one.

### The pre-send check

`GET /admin/invoices/:id/en16931-check` runs the business rules that can be
checked from our own data — BR-CO-9 (a VAT identifier must carry its country
prefix), BR-CO-13 and BR-CO-15 (the totals must add up), the exemption-reason
rules above — and returns each failure named by rule.

The panel fetches it alongside the invoice rather than behind a button: an
operator about to send a document electronically should not have to know to ask.
Every issue it reports is a missing value somebody can go and fill in, which is
a better place to find out than a rejection notice from a receiver's AP.

---

## 7. What this does not do

Named plainly, because a gap you know about is a plan and a gap you do not is a
liability.

- **No e-invoicing transport.** The document exists (§6); the network does not.
  Italy requires SdI today; Germany phases B2B e-invoicing in through
  2025-2028, France 2026-2027, and Poland and Belgium are on their own
  timetables. Closing this means a contract with a Peppol access point and a
  sender integration against it — and in Italy a clearance step, because there
  the invoice is not valid until SdI has accepted it. **If you sell into a
  member state with a live mandate, this is the gap to close first**, and it is
  now an integration rather than a build.
- **No archiving guarantee.** Several member states require an e-invoice be
  stored in a form that can be shown to be unaltered for six to ten years. The
  `Invoice` row does not change and the UBL is reproducible from it, which
  satisfies the substance; whether your storage satisfies the local form of the
  rule is a question for your accountant.
- **No OSS or Intrastat returns.** Orders carry `taxTreatment` and `taxCountry`
  so the figures can be extracted per member state, but filing is yours.
- **No PDF rendering.** The invoice is structured data; the panel and the
  storefront render it.
- **No distance-selling threshold.** See §2.
- **No proof-of-export capture.** An `EXPORT` order is zero-rated on the
  condition that you can show the goods left the Union. The software records
  the treatment; the evidence is your paperwork.
- **Razorpay is not an EEA acquirer.** Use Stripe for EU trade.
