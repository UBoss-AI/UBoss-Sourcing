# Product safety, AI transparency and third-party recipients

Four EU obligations that share one property: they are all satisfied by what a
person can **see**, not by what the database knows.

> Nothing here is switched on by default. A deployment selling outside the
> Union has no GPSR obligation, and blocking its catalogue on one would be this
> software inventing law. `gpsrEnforced` and `mdrEnforced` are the switches;
> the checks run either way and report themselves as warnings until you turn
> them on, so you can see the size of the work before committing to it.

---

## 1. GPSR (Regulation (EU) 2023/988)

Applicable since **13 December 2024**. Article 19 governs what a listing must
carry before the product is offered online:

| Art. 19 | Field | Where staff set it |
|---|---|---|
| (a) manufacturer's name, postal and **electronic** address | `manufacturerId` → `economic_operators` | Catalogue → Manufacturers |
| (b) EU responsible person, where the manufacturer is outside the Union | `euResponsibleId` → `economic_operators` | same |
| (c) product identifiers | `gtin`, `modelIdentifier` | Product → Safety |
| (c) product picture | existing product media | Product → Images |
| (d) warnings and safety information | `safetyWarnings`, `safetyInstructions` | Product → Safety |

### Turning it on

1. Enter your manufacturers under **Catalogue → Manufacturers**. The electronic
   address is required, and it is not your own support address — the point of
   the field is that a buyer can reach the manufacturer directly.
2. Where a manufacturer is established outside the Union, add their EU
   responsible person (GPSR Art. 16 / Reg. 2019/1020 Art. 4) and link it.
3. Fill in each product's identifier and warnings.
4. Set `gpsrEnforced` on the business profile.

Until step 4, `GET /admin/products/:id/safety` reports every gap without
blocking anything. That is what lets you cost the work before it stops your
catalogue.

### Two things worth knowing

**The EU representative is conditional.** It is required only where the
manufacturer is established outside the EU VAT area — determined from
`economic_operators.countryCode` against the `isEuVat` flag on `countries`. A
validator that demanded a German manufacturer name their own EU representative
would be switched off within a week, and rightly.

**Warnings are translated; addresses are not.** Art. 19(d) asks for a language
"which can be easily understood by consumers", so `safetyWarnings` lives on
`product_translations` and follows the reader's language, falling back to the
base row. A registered company name and a postal address are transcribed, not
translated, so they do not.

`missingWarningLanguages` on the assessment names the storefront languages a
warning has not reached. It never blocks publication — requiring eight
translations before a product could go live would stop a catalogue existing at
all — but it is the thing an auditor asks about.

### What this does not do

- **No pictograms.** Annex-style hazard symbols are not modelled. Where a
  product needs one, put it in the product images.
- **GPSR is the floor, not the ceiling.** A medical device is also subject to
  Regulation (EU) 2017/745, which asks for more. See §2.
- **No batch or serial capture.** `modelIdentifier` is a per-SKU designation.
  Per-unit batch and serial numbers travel with the physical goods and would
  need to hang off shipments, which they do not.
- **No Safety Gate reporting.** Art. 20 requires a producer or distributor who
  learns a product is dangerous to notify authorities through Safety Business
  Gateway. That is a procedure, not a screen.

---

## 2. MDR (Regulation (EU) 2017/745)

`modules/catalog/mdr.service.ts`, `product_device_info`.

**Read this first: this is not MDR compliance.** The MDR is a quality
management system, a clinical evaluation, post-market surveillance and
vigilance reporting. A catalogue holds none of that, and no software that sells
things can. What a catalogue holds — and all this models — is the part a buyer
and a market surveillance authority read off the listing. If you manufacture
devices, this screen is the last five per cent of your obligations, not the
first ninety-five.

### Turning it on

`business_profile.mdrEnforced`. Off by default, and off means the assessment
still runs and still reports its gaps — it simply does not block publication.
That is deliberate: an operator needs to see the size of the work before
committing to it, and a flag that hides the problem until you flip it teaches
you nothing.

Marking a product a device is per product (`PUT /admin/products/:id/device`).
Most of a catalogue is not one, and the answer for those is `notADevice` rather
than a pass — a product this regulation never reaches has not satisfied
anything, and a green tick there would be a lie.

### What is required, and when

| Field | Art. | Required when |
|---|---|---|
| `deviceClass` | Annex VIII | Always, once marked a device |
| `notifiedBodyNumber` | 52 | Any class above plain Class I |
| `udiDi` | 27, Annex VI Part C | Always |
| `basicUdiDi` | 27, Annex VI Part C | Always |
| `intendedPurpose` | 10(11) | Always |
| `declarationOfConformityUrl` | 14(2)(a), 19(1) | Always |
| `eudamedSrn` (on the manufacturer) | 31 | Always — reported as a gap, never a blocker |

**Basic UDI-DI and UDI-DI are not the same identifier and one does not derive
from the other.** The UDI-DI identifies a packaging configuration and is the one
printed on the label. The Basic UDI-DI identifies the device *group*, appears on
no label, and is what the declaration of conformity and the Eudamed entry are
filed against. Modelling one field would have made the Eudamed reference
unreachable, so there are two.

**Sterility and measurement change the class, so they are checked against it.**
A plain Class I device is self-certified; a Class I device supplied sterile or
carrying a measuring function is not, because a notified body certifies that
aspect. A record that ticks `isSterile` while declaring `CLASS_I` is therefore
refused with `STERILE_CLASS_I` rather than quietly accepted — it is the single
most common way a device listing is wrong.

**The notified body number is four digits** (`0123`), the number beside the CE
marking, not the certificate number. A malformed one reports
`NOTIFIED_BODY_MALFORMED`, because a plausible-looking wrong number is worse
than a blank.

**Intended purpose is translated.** It decides the classification and it is what
a buyer reads, so it lives on `product_translations` alongside the safety
warning and reports `missingPurposeLanguages` the same way — and, the same way,
never blocks publication.

### What this does not do

- **No Eudamed filing.** Art. 31 registration is something you do with the
  authorities. The number it returns is held — `economic_operators.eudamedSrn`,
  on the manufacturer, because one SRN covers every device that company puts on
  the market — and a device whose manufacturer has none reports
  `EUDAMED_SRN_MISSING`. Nothing here talks to Eudamed, and nothing verifies
  that the number you typed is the one you were issued.
- **No vigilance or incident reporting.** Arts. 87-92 are a procedure with
  deadlines, not a screen.
- **No implant card, no IFU hosting.** An electronic instructions-for-use
  portal has its own availability and versioning obligations that a product
  page does not meet. Link to yours from the declaration field.
- **No reprocessing controls.** `isSingleUse` records the manufacturer's
  statement. Art. 17 restricts what may then be done with the device; enforcing
  that is not a catalogue's job.
- **No IVDR.** In-vitro diagnostics fall under Regulation (EU) 2017/746, which
  classifies differently. Nothing here models it.

---

## 3. AI Act Art. 50 — the chat widget

Article 50(1) of Regulation (EU) 2024/1689 obliges the deployer of an AI system
that interacts with people to inform them they are dealing with a machine,
unless it is obvious. A chat bubble is not obvious.

The storefront config carries an `assistant` block — `available`, `isAi`,
`model`, `vendor` — and the widget renders the disclosure in **two** places:
above the first field of the capture form, and in the panel header. The second
is not redundant: somebody who opened the panel yesterday and returns to it
today never saw the form.

The vendor is **named**, not described as "a third-party AI provider". They
receive whatever the visitor types, which puts them in your privacy notice
under GDPR Art. 13(1)(e), and a notice that names nobody has not disclosed
anything.

The capture form also carries a GDPR Art. 13 notice at the point of collection.
It asks a stranger with no account for a name, a mobile number and an email;
that notice belongs on the form, not only in a policy page they have not
opened.

**To switch the whole thing off**, unset `ANTHROPIC_API_KEY` and
`GEMINI_API_KEY`. The widget then never mounts.

### Risk classification

The assistant answers catalogue questions. It is not an Art. 6 high-risk
system, does not do emotion recognition or biometric categorisation, and makes
no decision about any person — so Art. 50(1) transparency is the operative
obligation and the rest of the Act's high-risk machinery does not attach.
`<DECIDE>` — satisfy yourself of that before you rely on it, and re-check if
you ever wire the assistant into a decision about a customer.

Art. 4 (AI literacy) applies to you as deployer from 2 February 2025: staff who
work with the system need enough training to understand what it does. That is a
people obligation, not a software one.

---

## 4. Who else sees the data

**Admin → Settings → Processors**, or `GET /admin/settings/processors`.

Art. 30(1)(d) asks a controller to record the categories of recipient their
data goes to. That record is normally a list somebody typed into a document
eighteen months ago — and the trouble with it is that it is a claim about
configuration, kept somewhere configuration cannot reach. Somebody sets
`GEMINI_API_KEY` to try the chat widget, visitors' questions start going to
Google, and the register still says the only processor is the payment gateway.

So this report reads the environment instead. Every entry says which setting
switches it on, what actually leaves the building, and whether the recipient is
outside the EEA. **Inactive entries are reported too** — the point is that you
can diff the output against your register.

Two limits, stated rather than hidden:

- It knows only about integrations this codebase makes itself. A reverse proxy
  that logs, a managed database, a backup target, an error tracker — all
  recipients, none visible from here.
- "Where" is where the company is established, which is not always where the
  data is processed. An EEA region on a US-owned provider is still a US
  company's infrastructure, and whether that matters is a question for a
  lawyer, not for a boolean.

The exchange-rate feed is the one entry that carries no personal data, and says
so. It is on the list for completeness, and excluded from the transfer count —
a list padded with harmless entries is a list people learn to skim.

---

## 5. Not covered by any of this

Named so that a gap you know about stays a plan rather than becoming a
liability.

- **Consumer Rights Directive.** This is a B2B catalogue and the 14-day
  withdrawal right does not apply between traders. If you enable
  `FEATURE_CUSTOMER_SELF_REGISTRATION` and consumers can buy, that changes —
  and nothing in this codebase implements a withdrawal flow.
- **Omnibus price-reduction rules.** `compareAtPriceMinor` renders a
  strike-through price. Directive 2019/2161 requires a reduction to be
  announced against the lowest price of the previous 30 days. The catalogue
  keeps no price history, so it cannot compute that figure and does not claim
  to.
- **Geo-blocking (Reg. 2018/302).** Country and currency availability are
  configuration. Nothing checks whether your configuration amounts to
  unjustified discrimination between member states.
- **WEEE, packaging, battery regulations.** Producer-responsibility
  registration numbers are not modelled.
