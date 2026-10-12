# legal/

The operator's own policy texts, kept beside the code that shows them.

| Path | What it holds | In git? |
|---|---|---|
| `drafts/gloviaa-mart/*.en.txt` | Gloviaa Mart's Terms of Use, Seller Terms and Conditions, Seller Platform Services Agreement, B2B Buyer Terms and Conditions, B2B Buyer Platform Services Agreement, B2C Consumer Terms and Conditions, B2C Platform Services Agreement, Privacy Policy, Delivery, Returns, Refunds and Disputes Policy, Logistics Partner Terms, Staff Console Terms and Audit Console Terms — **finalised text, version 1.0, effective 12 October 2026, with sample company details** | Yes |
| `drafts/gloviaa-mart/CHANGE-TABLE.md` | What each source section became, the decisions taken, and the sample values to replace before going live | Yes |
| `source/` | The two source files the texts were adapted from, and the operator's Word files the seller, B2B buyer and B2C consumer documents were taken from, all byte-for-byte unchanged | **No** — gitignored |

`source/` is gitignored on purpose: it is a third party's copyrighted text, and
this repository is a product other companies buy and run. It must never ship
in it. Keep the originals there locally; the change table records their
SHA-256 so a copy can be checked.

## Status

On 12 October 2026, at the owner's request, every document here was finalised:
the draft notices, the approval lines, the `[[DECISION: ...]]` markers and the
`______` fill-in blanks were removed, and each file became version 1.0,
effective 12 October 2026. Open decisions were settled with standard Indian
defaults (listed in the change table).

**Two things this does not mean.**

- **The company details are samples.** The registered office, CIN, GSTIN,
  grievance officer, contact names and email addresses were invented so the
  text reads as complete. They are written as if real, with no marker in the
  text. Replace every one of them before going live - the change table lists
  each value and what it stands for. The sample CIN `U62099HR2024PTC118452` is
  how the software recognises them (`SAMPLE_LEGAL_MARKER`): Settings → Master
  data flags any published document that still contains it.
- **Nothing here has been reviewed by counsel.** The text was written by
  automated drafting. It is not legal advice and not legal approval. The
  operator's own lawyer should review it before real customers rely on it.

The five documents the operator supplied as Word files (seller terms, seller
services agreement, B2B buyer terms, B2B buyer services agreement, B2C
consumer terms) were filled in the same way. They keep their headings, but they
are no longer word-for-word copies of the Word files.

## File format

Each file is a small header, a line of three dashes, then the body:

```
kind: PRIVACY_POLICY
version: 1.0
locale: en
title: Gloviaa Mart Privacy Policy
---
<body>
```

The body is the same plain text a legal document is stored as: a line starting
with `## ` is a heading, a line starting with `- ` is a bullet, a blank line
ends a paragraph. No HTML, no links, no emphasis.

Publishing still refuses any document whose body contains `[[`, a `____`
fill-in line or the words "For approval before implementation or signature",
so an operator's own unfinished text cannot go live by accident. The files here
contain none of these.

## Where they are used

**Development seed.** `npm run db:seed` (development only) publishes each
document here for every kind that has nothing published, or only text a seed
published. It replaces the old "DEVELOPMENT PLACEHOLDER" rows. It never
replaces an operator's own published text.

**Loading them into a real database.**

```powershell
cd backend; npm run legal:import-drafts -- ../legal/drafts/gloviaa-mart
```

This creates (or updates) **DRAFT** rows in Administration → Legal documents.
It never publishes. Publishing is done by a person in the console, after the
sample company details have been replaced with the operator's own and the text
has been reviewed.
