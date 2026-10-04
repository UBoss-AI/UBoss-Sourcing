# Checks only a person can do

This file lists every **unticked box** left in `UBoss_Gloviaa_Mart_Detailed_Screen_Checklist_V2.docx`, all in one place. Each one says how to check it by hand.

The checklist has 34 unticked rows. All of them are below. The template rows in section 8 are a blank form you fill in for each screen, so they appear once, in part H, as instructions.

**How to use this file**
1. Do the steps.
2. If the result matches **✅ Pass when**, tick the box in this file.
3. Tick the same box in the Word checklist.

Unless a step says otherwise:
- **Your computer:** use `http://localhost:5174` for the shop, `http://localhost:5173/admin/` for the admin panel and `http://localhost:5175` for the carrier portal.
- **The live server:** once it is set up, use `https://shop.…`, `https://admin.…` and `https://carriers.…` instead.

---

## A. Screens to check

### ☐ A1. Help, policy and legal pages (inventory row 9; footer, section 20)
1. In the admin panel, open **Legal documents**. Write and **publish** each of these:
   - Terms
   - Privacy
   - Returns
   - Inspection policy
   - Prohibited items
   - Buyer protection
   - Seller terms
   - Staff terms
2. Open the shop. Scroll to the **footer**. Click every link: Help, each policy, support and company information.
3. Change the language at the top of the page, and click the links again.

✅ **Pass when:** every link opens real text (not a template or placeholder), in every language you sell in.

### ☐ A2. Seller application and business checks (inventory row 12; section 17.2)
1. In the shop, apply as a new seller with a **test** company. Fill in everything:
   - PAN, GST, CIN, Udyam and IEC numbers
   - bank details
   - the owner and a contact person
   - factory proof and export documents
2. Try a GST number that is wrong, for example change one digit. The form should refuse it.
3. In the admin panel, open the seller applications queue. Check the documents. Approve it.
4. Try to list a product **before** approval, then try again **after** approval.

✅ **Pass when:**
- wrong numbers are refused
- the admin can see every document
- the seller can only sell after approval
- the sanctions and restriction check your policy needs has been done, and recorded

### ☐ A3. A clear main button on every screen (Definition of Done, UX)
1. Open each main screen: home, product, cart, checkout, the seller pages, the admin queues and the carrier jobs.
2. Ask a person who has never seen the app: *"What would you do next on this page?"*

✅ **Pass when:** on every screen, they point at the right button within about 3 seconds.

---

## B. Devices, browsers and speed

### ☐ B1. Works on real devices and browsers (Definition of Done QA; Product & UX)
Test on each of these:
- Chrome and Edge on Windows
- Safari on an iPhone
- Chrome on an Android phone
- an iPad, or any tablet

On each device:
1. Open all three sites.
2. Sign in.
3. Search for a product.
4. Add it to the cart.
5. Go through checkout, with Stripe in **test mode**.
6. Turn the phone sideways.

✅ **Pass when:** nothing overlaps, nothing is cut off, and you never have to scroll sideways.

### ☐ B2. Speed (Definition of Done QA)
1. Run the load test from your computer against the server: see `scripts/load/k6-storefront.js`.
2. On a phone using **4G (not Wi-Fi)**, open the home page and a product page.

✅ **Pass when:**
- the k6 thresholds pass (green ticks at the end of its output)
- the pages load in under about 3 seconds on 4G

### ☐ B3. Loading, empty and error messages (Product & UX)
1. Search for nonsense, for example `zzzzqq`. A friendly "no results" message should appear.
2. Turn off your Wi-Fi, then click a button. A clear error message should appear, not a frozen page.
3. Open an empty cart and an empty order list.

✅ **Pass when:**
- every case shows a helpful message
- the policy links from A1 are live

---

## C. Security

### ☐ C1. Penetration test (Security & Compliance)
1. Hire an outside security company. Give them the three site addresses, and a test account for each role.
2. They report problems ranked Critical, High, Medium and Low.
3. Fix them, then ask them to re-test.

✅ **Pass when:** no Critical or High problem is left open.

### ☐ C2. Backup, restore and incident response (section 12; Security & Compliance)
1. On the server, run a backup by hand: `systemctl start uboss-backup`.
2. Check that the file appears in your Backblaze **backups** bucket.
3. Restore that backup into a **test** database, and open it. The data should be there.
4. Do a practice drill. Pretend the site is down, and time how long it takes you to bring it back.
5. Write down who gets alerts, and who to call at night.

✅ **Pass when:**
- the restore works
- it took under the target (4 hours for the whole server, 1 hour for the database only)
- the names are written down

### ☐ C3. Who has admin access (Security & Compliance)
1. In the admin panel, open **Staff**.
2. Check every person and their role.
3. Remove anyone who has left, or who doesn't need that level of access.

✅ **Pass when:** every admin is a real, current person with the smallest role they need. Put a date in your calendar to repeat this every 3 months.

### ☐ C4. Keys replaced and watched (Integrations)
1. Make **new** keys for:
   - Stripe
   - Razorpay
   - email (SMTP)
   - Gemini and DeepL
   - Backblaze
   - the app's own secrets
2. Put the new keys into the server's settings file.
3. Disable the old keys at each provider.

✅ **Pass when:**
- no key used during development still works
- the site still works with the new keys

---

## D. Connected services

### ☐ D1. Each service tested on the live server (Integrations)
Test each one on the live server:

| Service | How to check |
|---|---|
| **Payment** | Place a real small order, for example ₹10, then refund it |
| **Seller payouts** | Check that a seller receives the money through Stripe Connect |
| **Delivery** | Create a shipment; the carrier portal shows it |
| **Email and SMS** | You receive the order and sign-up messages |
| **File storage** | Upload a product picture; it is still there after a server restart |
| **Inspection** | Go through one inspection from start to finish |

✅ **Pass when:** all of them work with real accounts.

### ☐ D2. Webhook retries and outages (Integrations)
1. In the Stripe dashboard, open **Developers → Webhooks**, find a delivered event, and click **Resend**. The order must not be created twice.
2. Stop the API for 2 minutes (`systemctl stop uboss-api@4000 uboss-api@4001 uboss-api@4002`), and pay during that time. Start it again. Stripe re-sends the event, and the order is confirmed.
3. Compare the day's Stripe payouts with the app's order totals.

✅ **Pass when:** no order is missing, no order is duplicated, and the totals match.

---

## E. Data

### ☐ E1. Master data loaded and approved (Data & Analytics)
1. In the admin panel, open **Settings → Master data → Go-live check**.
2. Check currencies, countries, taxes and categories.

✅ **Pass when:** the check is green, and the owner has signed it off.

### ☐ E2. Reports match the real transactions (Data & Analytics)
1. Place 5 test orders. Cancel one and refund one.
2. Compare the admin dashboard numbers with the order list and with Stripe.

✅ **Pass when:** the counts and totals are exactly the same everywhere.

---

## F. Business processes (people, not software)

### ☐ F1. Written procedures in use (Operations)
Write a short step-by-step procedure for each of these:
- seller verification
- inspection
- disputes
- money reconciliation

Have the person responsible do each one **once**, using a test case.

✅ **Pass when:** each one has been done once, start to finish.

### ☐ F2. Response times and owners (Operations)
For each admin queue (seller applications, disputes, returns, support tickets), write down two things:
- how fast it must be answered, for example within 24 hours
- who is responsible, and who to escalate to

✅ **Pass when:** every queue has a time and a named owner.

### ☐ F3. Support team trained (Operations)
Run the team through real test cases: an order, a return, a dispute and a password reset.

✅ **Pass when:** each team member has handled each case once, without help.

### ☐ F4. Legal approval (Security & Compliance)
Send every policy from A1 to a qualified lawyer, for each country you sell in.

✅ **Pass when:** you have their written approval.

---

## G. Release sign-off (section 15)

Each person checks their part of this file, then signs:

| Role | Checks first | Decision |
|---|---|---|
| Product Owner | A, B | ☐ Approve ☐ Hold |
| Engineering Lead | B2, C, D | ☐ Approve ☐ Hold |
| QA / UAT Lead | A, B, H | ☐ Approve ☐ Hold |
| Operations | F1–F3 | ☐ Approve ☐ Hold |
| Finance | D1, D2, E2 | ☐ Approve ☐ Hold |
| Inspection / Quality | F1 (inspection procedure) | ☐ Approve ☐ Hold |
| Information Security | C1–C4 | ☐ Approve ☐ Hold |
| Compliance / Legal | F4, A2 | ☐ Approve ☐ Hold |
| **Management** | **Everything above is Approve** | ☐ **Go Live** ☐ Hold |

---

## H. For every screen: the 4 test results (template, section 8)

For **each** screen, do these 4 tests and record **Pass**, **Fail** or **N/A**:

1. **☐ Normal use:** do the main task the right way. It works.
2. **☐ Wrong use and permissions:** enter bad data, then try the screen with a user who should **not** have access. You get a clear refusal, and nothing is saved.
3. **☐ Records match:** after the action, the same numbers appear on the other screens and in Stripe or the carrier's system.
4. **☐ Speed and security:** the page loads quickly. Copying an address from one user and opening it as another user shows nothing private.

✅ **Pass when:** every main (P0) screen has 4 Pass results, or N/A with a reason.

---

## I. After going live

These are checked on the **live server**, right after launch. A few repeat on a schedule.
In the **Who** column, **Claude** means I can run the check for you; **You** means it needs a person.

### On launch day

| # | Check | How | ✅ Pass when | Who |
|---|---|---|---|---|
| ☐ I1 | Every address uses https | Open each site with `http://` in front | It switches to `https://` and shows a padlock | Claude |
| ☐ I2 | Security headers are present | Run `curl -I https://shop.YOURDOMAIN.COM` | The output shows `strict-transport-security` and `content-security-policy` | Claude |
| ☐ I3 | No secrets in the websites | Search the built site files for `sk_live`, `AIza` and `key=` | Nothing is found | Claude |
| ☐ I4 | The database port is closed | From your PC, run `Test-NetConnection YOUR_VPS_IP -Port 3306` | It reports a failure | Claude |
| ☐ I5 | Server readiness check | Open `https://shop.YOURDOMAIN.COM/health/ready` | It reports ready | Claude |
| ☐ I6 | Sign-in works in all four places | Sign in to the shop, Seller Hub, the admin panel and the carrier portal | All of them work, and the sign-in cookie is marked `Secure` | You |
| ☐ I7 | A real order goes through | Place a small order and pay for it | The order is confirmed (by the Stripe webhook), and the confirmation email arrives | You |
| ☐ I8 | Chat works between people | Open a pre-order chat as a buyer in one browser and as staff in another | Messages appear instantly on both sides | You |
| ☐ I9 | Uploads survive a restart | Upload a picture, then run `systemctl restart uboss-api@4000 uboss-api@4001 uboss-api@4002` | The picture is still there | Claude |
| ☐ I10 | Background jobs run once | Trigger one email, for example a password reset | Exactly one email arrives, not two | You |
| ☐ I11 | The server recovers by itself | Run `reboot`, then wait 2 minutes | All three sites come back on their own | Claude |
| ☐ I12 | Logs hold no private data | Run `journalctl -u uboss-api@4000 -n 200` | No passwords, card numbers or keys appear in it | Claude |
| ☐ I13 | The uptime alert works | Stop the API for 3 minutes | UptimeRobot emails you | You |
| ☐ I14 | A broken update undoes itself | Release a deliberately broken version | The old version comes back automatically | Claude |

### Every day, for the first week

| # | Check | ✅ Pass when | Who |
|---|---|---|---|
| ☐ I15 | Last night's backup is in the Backblaze **backups** bucket | A file with today's date is there | Claude |
| ☐ I16 | Error log | No repeating errors | Claude |
| ☐ I17 | Stripe payments vs app orders | They match | You |
| ☐ I18 | Disk, memory and CPU (run `df -h`, then `free -h`) | Disk is under 70% full, and memory is not full | Claude |

### On a schedule

| # | Check | How often | Who |
|---|---|---|---|
| ☐ I19 | Restore a backup into a test database | Monthly | Claude |
| ☐ I20 | Certificates renew themselves (`certbot renew --dry-run`) | Monthly | Claude |
| ☐ I21 | Review who has admin access (C3) | Every 3 months | You |
| ☐ I22 | Install security updates and check nothing broke | Monthly | Claude |
| ☐ I23 | Replace keys (C4) | Yearly, or right away if one may have leaked | You |
| ☐ I24 | Re-run the load test (B2) | Before big sales or launches | Claude |

---

## Summary: what is left

| Group | Total | Only a person (You) | Claude can do |
|---|---|---|---|
| A–F, before launch | 18 | 11 | 7 (4 of them shared with you) |
| G, sign-offs | 9 | 9 | 0 |
| H, tests for each screen | 4 | 0 | 4 |
| I, after going live | 24 | 8 | 16 |
| **Total** | **55** | **28** | **27** |

All 55 are still open. Every check marked Claude needs the live server first.
