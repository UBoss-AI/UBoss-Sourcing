# legal/

The operator's own policy texts, kept beside the code that shows them.

| Path | What it holds | In git? |
|---|---|---|
| `drafts/gloviaa-mart/*.en.txt` | Gloviaa Mart's Terms of Use, Seller Terms and Conditions, Seller Platform Services Agreement, B2B Buyer Terms and Conditions, B2B Buyer Platform Services Agreement, B2C Consumer Terms and Conditions, Privacy Policy, Logistics Partner Terms, Staff Console Terms and Audit Console Terms — **all DRAFT** | Yes |
| `drafts/gloviaa-mart/CHANGE-TABLE.md` | What each source section became, and the open business and legal decisions | Yes |
| `source/` | The two source files the drafts were adapted from, and the operator's Word files the seller, B2B buyer and B2C consumer documents were taken from word for word, all byte-for-byte unchanged | **No** — gitignored |

`source/` is gitignored on purpose: it is a third party's copyrighted text, and
this repository is a product other companies buy and run. It must never ship
in it. Keep the originals there locally; the change table records their
SHA-256 so a copy can be checked.

**Nothing here is legal advice or approved.** The drafts were produced by
automated drafting and stay drafts until the operator's legal counsel signs
them off. See `drafts/gloviaa-mart/CHANGE-TABLE.md`.

## File format

Each file is a small header, a line of three dashes, then the body:

```
kind: PRIVACY_POLICY
version: 2026-10-draft-1
locale: en
title: Gloviaa Mart Privacy Policy
---
<body>
```

The body is the same plain text a legal document is stored as: a line starting
with `## ` is a heading, a line starting with `- ` is a bullet, a blank line
ends a paragraph. No HTML, no links, no emphasis.

`[[DECISION: ...]]` marks something only the business or its lawyers can
decide (the registered company, governing law, contacts, periods). Publishing
refuses any document whose body still contains `[[`, a `____` fill-in line
or the words "For approval before implementation or signature", so a draft
with an open decision cannot go live by accident.

## Loading the drafts into a database

```powershell
cd backend; npm run legal:import-drafts -- ../legal/drafts/gloviaa-mart
```

This creates (or updates) **DRAFT** rows in Administration → Legal documents.
It never publishes. Publishing is done by a person in the console, after the
text has been approved and every `[[DECISION]]` resolved.
