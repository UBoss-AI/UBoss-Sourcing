import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from '../.ppt-build/node_modules/docx/dist/index.mjs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not from the current directory. The guide has to be
// rebuilt every time a feature lands, so it must not matter whether the person
// rebuilding it is standing in the repository root or in scripts/ - a
// cwd-relative path there writes the document into the wrong folder, or fails,
// and the visible result is a guide that silently did not change.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(repoRoot, 'output/UBOSS_Sourcing_Feature_Guide.docx');
const C = { navy: '102A43', blue: '2563EB', teal: '059669', purple: '7C3AED', orange: 'D94801', ink: '1E293B', muted: '64748B', pale: 'F8FAFC', line: 'CBD5E1', white: 'FFFFFF' };
const children = [];

function title(text, subtitle) {
  children.push(new Paragraph({ text, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { before: 420, after: 120 }, run: { color: C.navy, bold: true, size: 40 } }));
  if (subtitle) children.push(new Paragraph({ text: subtitle, alignment: AlignmentType.CENTER, spacing: { after: 240 }, run: { color: C.muted, size: 22 } }));
}
function h1(text) {
  children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 280, after: 100 }, run: { color: C.navy, bold: true, size: 28 } }));
}
function h2(text) {
  children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 180, after: 80 }, run: { color: C.blue, bold: true, size: 20 } }));
}
function h3(text) {
  children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_3, spacing: { before: 120, after: 55 }, run: { color: C.teal, bold: true, size: 15 } }));
}
function p(text, options = {}) {
  children.push(new Paragraph({ text, alignment: options.align || AlignmentType.LEFT, spacing: { after: options.after ?? 85, line: 270 }, run: { color: options.color || C.ink, size: options.size || 10.5, bold: options.bold || false } }));
}
function bullets(items, level = 0) {
  for (const item of items) children.push(new Paragraph({ text: item, bullet: { level }, spacing: { after: 42, line: 250 }, indent: { left: 360 + level * 360, hanging: 180 }, run: { color: C.ink, size: 10.2 } }));
}
function note(label, text, color = C.blue) {
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: { style: BorderStyle.SINGLE, size: 6, color }, bottom: { style: BorderStyle.SINGLE, size: 6, color }, left: { style: BorderStyle.SINGLE, size: 6, color }, right: { style: BorderStyle.SINGLE, size: 6, color } },
    rows: [new TableRow({ children: [new TableCell({ shading: { type: ShadingType.CLEAR, color: 'F1F5F9' }, margins: { top: 90, bottom: 90, left: 120, right: 120 }, children: [
      new Paragraph({ children: [new TextRun({ text: label + ': ', bold: true, color }), new TextRun({ text, color: C.ink })], spacing: { after: 0 }, run: { size: 9.6 } }),
    ] })] })],
  }));
  children.push(new Paragraph({ text: '', spacing: { after: 65 } }));
}
function cell(text, options = {}) {
  return new TableCell({
    shading: options.header ? { type: ShadingType.CLEAR, color: options.color || C.navy } : undefined,
    margins: { top: 72, bottom: 72, left: 90, right: 90 },
    children: [new Paragraph({ text, spacing: { after: 0, line: 220 }, run: { size: options.header ? 8.8 : 8.7, bold: Boolean(options.header), color: options.header ? C.white : C.ink } })],
  });
}
function table(headers, rows, widths) {
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: widths,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: C.line },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: C.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: C.line },
      right: { style: BorderStyle.SINGLE, size: 4, color: C.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'E2E8F0' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'E2E8F0' },
    },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((x) => cell(x, { header: true })) }),
      ...rows.map((row, index) => new TableRow({ children: row.map((x) => cell(x, { color: index % 2 ? '334155' : C.navy })) })),
    ],
  }));
  children.push(new Paragraph({ text: '', spacing: { after: 90 } }));
}
function page() { children.push(new Paragraph({ children: [new PageBreak()] })); }

// Cover
title('UBOSS Sourcing', 'Simple Feature Guide — Customer Storefront, Admin Console, Warehouses, Orders and Automation');
p('Prepared from the current project implementation', { align: AlignmentType.CENTER, color: C.muted, size: 11 });
p('English edition • September 2026', { align: AlignmentType.CENTER, color: C.muted, size: 10 });
children.push(new Paragraph({ text: '', spacing: { before: 300, after: 60 } }));
note('Purpose', 'This document explains, in simple English, what customers, staff and the system can do. It describes implemented features and clearly marks features that depend on configuration.', C.blue);
h2('Quick answer');
p('UBOSS Sourcing is a business-to-business ordering system for medical and industrial supplies. Customers browse products, build a basket, choose delivery preferences, place orders and manage their account. Staff manage products, warehouses, stock, orders, payments, customers, reports, security and integrations.');
h2('How to use this guide');
bullets([
  'Read “Customer features” to understand what a buyer can do on the storefront.',
  'Read “Admin features” to understand the staff back office.',
  'Read “Warehouse and inventory” for the exact customer warehouse-choice and admin stock-management behaviour.',
  'Read “Optional features” to see what appears only when a feature flag or provider is enabled.',
]);
page();

// 1
h1('1. The Product in Simple Words');
p('The project has four working parts. They are separate so customers can shop safely while staff run the business without exposing internal tools to buyers.');
table(['Part', 'Who uses it', 'What it does'], [
  ['Customer storefront', 'Buyers, hospitals, clinics and business customers', 'Browse the catalogue, ask AI questions, make orders, manage delivery/account settings and repeat purchases.'],
  ['Admin console', 'Business owner and authorised staff', 'Manage the catalogue, warehouses, inventory, customers, orders, payments, reports, staff and settings.'],
  ['Backend API and database', 'The application itself', 'Applies business rules, permissions, prices, tax, stock reservations, audit history and secure integrations.'],
  ['Background worker', 'The application itself', 'Runs scheduled orders, sends emails/notifications, processes retries, exports and integration work.'],
], [2600, 2600, 5600]);
h2('Who uses the system');
table(['Role', 'Main purpose'], [
  ['Customer / Buyer', 'Find supplies, buy once or schedule repeat deliveries, manage payment and account information.'],
  ['Catalog Manager', 'Create and publish products, categories, variants, media, safety data and prices.'],
  ['Inventory Manager', 'Receive stock, correct stock counts, manage warehouses, reservations and low-stock information.'],
  ['Order Manager', 'Process orders, fulfil shipments, handle changes, cancellations and returns.'],
  ['Finance / Approver', 'Review payments, create payment links, process refunds and approve eligible orders.'],
  ['Business Owner / Super Admin', 'Manage all areas, including staff, roles, settings and integrations.'],
], [3600, 7200]);
note('B2B difference', 'Customers may have their own prices, tax treatment, purchasing limits, credit terms and minimum order quantities. This is not a simple consumer shopping site.', C.teal);
page();

// 2
h1('2. Customer Features — Entry, Account and Market');
h2('2.1 Browse first, sign in when buying');
bullets([
  'Visitors can open the home page, catalogue, categories, search results, product pages and AI Mode without signing in.',
  'An activated customer session is required before cart, checkout, payment, order history, schedules and account pages can be used.',
  'A customer who opens a protected link directly is checked again by the application; hiding a button is not the only protection.',
]);
h2('2.2 Account access');
table(['Feature', 'What the customer can do', 'Important detail'], [
  ['Sign in', 'Use email and password to access buying and account features.', 'The storefront has its own customer session, separate from staff session.'],
  ['Staff invitation / activation', 'Set a password from an invitation link.', 'Useful when customers are created by a supplier.'],
  ['Self-registration', 'Create an account where the organisation enables this feature.', 'It can require email confirmation and staff approval before ordering.'],
  ['Email verification', 'Confirm the mailbox used for a new account.', 'Stops a mistyped or unauthorised email becoming an active account.'],
  ['Forgot / reset password', 'Request a secure reset link and choose a new password.', 'The application avoids revealing whether an email address is registered.'],
  ['Terms acceptance', 'Read and accept business terms where required.', 'The same controlled consent is used across sign-in, registration and activation.'],
], [2500, 4200, 3600]);
h2('2.3 Language, country and currency');
bullets([
  'The storefront supports English, Dutch, French, German, Greek, Italian, Polish and Spanish.',
  'The buyer can choose language, country and currency in one simple market control and in Account → Region.',
  'Language changes words; currency changes prices. They are related on screen but are not the same thing.',
  'The system shows only markets that have real stored prices. It does not silently convert product prices at browse time.',
  'Changing market refreshes quoted prices and updates the current cart context so the buyer knows which market is being used.',
]);
note('Why real prices matter', 'A customer is shown a stored price for the selected market. This avoids showing one exchange-rate amount and charging another amount later.', C.blue);
page();

// 3
h1('3. Customer Features — Product Discovery and AI');
h2('3.1 Home page and catalogue');
table(['Customer action', 'What the system provides'], [
  ['Open the home page', 'Brand introduction, product search, product categories, latest / featured catalogue items, basket access and account access.'],
  ['Browse all products', 'A list of published products available for the selected market.'],
  ['Open a category', 'Only the products within that category, with normal catalogue tools.'],
  ['Search for a product', 'Search results for product names, identifiers and relevant catalogue content.'],
  ['Use filters and sort', 'Narrow the catalogue by the available catalogue facets and change ordering.'],
  ['Use voice search', 'Use supported browser voice input for a search query.'],
  ['Use image search', 'Upload a product image to match relevant products when the feature is available to the signed-in customer.'],
], [3500, 6800]);
p('Each department on the home page carries a picture of what is in it — a cannula beside IV Cannula, a glove beside Surgical Gloves — so a buyer can find the department they came for by shape before they finish reading the labels. A department the system does not recognise by name gets a plain shape instead of a wrong picture.');
h2('3.2 Product detail page');
bullets([
  'See product images, product name, SKU/reference, specifications and descriptions.',
  'Choose a variant where a product has more than one option.',
  'See quantity rules, including minimum order quantity and permitted quantity steps.',
  'Read product safety and medical-device information where the product requires it.',
  'View tax and market price context before adding to the basket.',
  'Add the item to the basket or save it for later where the relevant feature is available.',
]);
h2('3.3 Packaging, and ordering by the box or the carton');
p('Many products in this trade are sold by the box and the carton rather than one at a time. Where the business has recorded how a product is packed, the product page shows it and lets the buyer order in whichever unit suits them.');
table(['What the customer sees', 'What the customer can do'], [
  ['A short pack summary on every listing, such as “100 per box · 2,000 per carton”.', 'Decide from the list whether an item is sold in the size they buy in, before opening it.'],
  ['A Packaging and ordering section, with pieces per box, boxes per carton and pieces per carton set out separately.', 'Check the exact breakdown instead of working it out from a line of supplier text.'],
  ['The conversion written out in one line: “100 pieces × 20 boxes = 2,000 pieces”.', 'See the whole relationship at a glance.'],
  ['A ready-reckoner for 1, 2, 5 and 10 of the chosen unit.', 'Answer “if I order five cartons, how many is that?” without a calculator.'],
  ['A choice of ordering unit above the quantity box: Pieces, Box, or Carton.', 'Type “2” and mean two cartons, with the piece total shown underneath as they type.'],
  ['A Dimensions section with the primary pack, inner box and outer carton sizes.', 'Check what will arrive against the space they have.'],
]);
bullets([
  'The basket keeps the unit the buyer chose. A line added as two cartons is counted in cartons in the basket, on the order and on a repeating plan, with the piece total shown beside it.',
  'Only units the business has actually recorded a figure for are offered. A product whose carton quantity is not on file can only be ordered by the piece.',
  'A pack size is not a minimum order. Any minimum is a separate rule the business sets, and the page says so.',
]);
note('Sizes as recorded', 'Pack dimensions are shown exactly as the business recorded them. Where the source did not state whether a measurement is in millimetres or inches, the page says so rather than assuming one.', C.purple);
h2('3.4 AI Mode');
p('AI Mode is a full page, not a small floating chat window. A visitor can ask product questions before opening an account when guest access is allowed. A signed-in customer can keep a conversation history.');
bullets([
  'Ask natural-language questions such as “show sterile syringes” or “which item matches this need?”.',
  'Receive product-aware answers and product cards where results are available.',
  'Use the assistant as a discovery tool before buying.',
  'Staff can review AI-related customer enquiries in the Admin → Chat enquiries area.',
]);
note('Image search access', 'Image search is more expensive than text search because it uses an AI vision request. The storefront keeps this action behind the customer session.', C.purple);
page();

// 4
h1('4. Customer Features — Basket, Warehouse Choice and Checkout');
h2('4.1 Basket management');
bullets([
  'Add one product or multiple product variants to the basket.',
  'Increase or reduce quantity using the quantity control.',
  'Remove a line from the basket.',
  'Apply an eligible coupon code.',
  'Review product subtotal, tax, delivery context and estimated total.',
  'Move eligible items toward repeat purchase planning when recurring orders are enabled.',
  'Use the two purchase workspaces: Instant Buy cart and Schedule Cart.',
  'Change a line by the box or the carton where it was added that way, with the piece total updating beside it.',
]);
h2('4.2 Customer warehouse choice — exact behaviour');
p('Yes. Once a customer has basket items, the basket can show a “Where this can ship from” panel. It helps the buyer decide which eligible warehouse they prefer for the order.');
table(['What the customer sees', 'What the customer can do', 'What the system checks'], [
  ['Available warehouses', 'Choose a preferred shipping source based on location, delivery timing and fee information.', 'The warehouse must be active, able to operate today, in delivery range and not excluded for the customer country.'],
  ['Lead time and fee', 'Compare options such as “faster with a fee” versus “slower with a lower fee”.', 'The system only shows a promise that the business has configured; it does not invent delivery data.'],
  ['Soonest / cheapest markers', 'Quickly identify the quickest or lowest-fee offer.', 'Options are ordered by soonest delivery, but the buyer makes the final preference.'],
  ['Partial-stock warehouse', 'See that a nearby warehouse has only part of the basket.', 'The screen names shortages instead of pretending the whole basket can ship from that warehouse.'],
  ['No eligible warehouse', 'Understand that delivery is outside range or closed for the country.', 'The system does not reveal private operational reasons to the buyer.'],
], [2900, 3400, 3700]);
note('Important current behaviour', 'Choosing a warehouse records a delivery preference. The warehouse-specific delivery fee is not automatically used to recalculate the existing cart total or change fulfilment by itself. The screen makes this clear so it never promises one amount and charges another.', C.orange);
h2('4.3 Checkout');
bullets([
  'Select or add a delivery address and choose whether the billing address is the same.',
  'Choose a customer-friendly payment method, such as pay now, saved card, another card, debit card, UPI where offered, or a payment link.',
  'Review exact order totals before submitting.',
  'Place the order using an idempotency key, which prevents the same browser action from creating duplicate orders.',
  'Move to an order-specific payment page with the created order number.',
  'Use “pay securely now” or, where shown, use a later payment path.',
]);
page();

// 5
h1('5. Customer Features — Orders, Payments and Repeat Purchasing');
h2('5.1 What happens when an order is placed');
table(['Step', 'What the application does'], [
  ['Order creation', 'Creates one order number, freezes the product name/SKU/price/tax details used for that order, applies coupon and checks purchasing limits.'],
  ['Stock reservation', 'Reserves the required stock before the order is confirmed so the same stock is not promised twice.'],
  ['Approval route', 'Can send an order for approval when the business has enabled approval rules or the customer uses credit terms.'],
  ['Payment', 'Creates a payment step for the selected payment instrument. Card details stay with the payment provider, not the application.'],
  ['Payment confirmation', 'A verified payment-provider event/webhook confirms payment. A browser redirect alone is not treated as proof of payment.'],
  ['Order history', 'Customer can view the order timeline, payment context, invoice context and fulfilment status.'],
], [3000, 7300]);
h2('5.2 Order life cycle');
p('The normal order path is Draft → Pending Approval or Pending Payment → Confirmed → Processing → Shipped → Delivered. Cancellation, return and refund are controlled transitions with history and reason rules.');
h2('5.3 Buy Later and Subscribe & Reorder');
table(['Option', 'What the customer can do', 'Result'], [
  ['Buy Now', 'Pay for the basket now.', 'Creates a normal order.'],
  ['Buy Later', 'Select one future delivery date and review it before confirming.', 'Creates a one-time schedule.'],
  ['Subscribe & Reorder', 'Set a repeating delivery pattern, such as every 15 days, monthly, every 2/3/6 months or yearly.', 'Creates a recurring schedule with multiple future occurrences.'],
], [2500, 4400, 3400]);
bullets([
  'A customer can view schedules, open one schedule, check delivery history and payment arrangement, then pause, resume, edit, skip or cancel where the schedule status allows it.',
  'Each future occurrence is re-checked for stock, price, rules and payment before it is processed. A two-month-old plan is never assumed to remain valid without checking.',
  'The system can ask for customer action if a saved card needs authentication, a price changes beyond tolerance, stock is unavailable or an item has been withdrawn.',
  'AutoPay can be enabled only when the required payment provider and feature settings are enabled; the customer controls consent, card and limits.',
]);
note('Repeat-purchase safety', 'A failed automatic charge does not silently cancel a customer’s whole subscription. The plan can pause and ask the customer to fix the payment method.', C.purple);
page();

// 6
h1('6. Customer Features — Self-Service Account Area');
h2('6.1 Profile and company');
table(['Account page', 'What the customer can do'], [
  ['Profile', 'Edit personal details in separate panels, change password, view purchasing limits, request contact changes, view own data and deactivate/close account.'],
  ['Company', 'Maintain company name, department and delivery contact number.'],
  ['Addresses', 'Add, edit, select default and archive shipping/billing addresses.'],
  ['Region', 'Choose language, country and currency together.'],
  ['Payment methods', 'Manage saved cards where payment provider features are enabled.'],
  ['AutoPay', 'View and manage standing payment consent, card and spend limits.'],
  ['Billing', 'Maintain VAT/GST/billing information used during checkout and invoices.'],
], [2800, 7200]);
h2('6.2 Privacy and contact protection');
bullets([
  'Changing an email or telephone number uses a confirmation process instead of instantly overwriting the account identity.',
  'A requested new email receives a confirmation link; the old email receives a security warning.',
  'Confirming a new sign-in email revokes existing sessions because the sign-in identity has changed.',
  'A customer can request their data and can deactivate or close their account through the governed account flow.',
]);
h2('6.3 My stuff');
table(['Feature', 'Customer benefit'], [
  ['Coupons', 'See available coupon codes and code-use history.'],
  ['Wishlist', 'Save product lines without buying them immediately.'],
  ['Notifications', 'See account-related notifications and delivery messages.'],
  ['My orders', 'Open past orders and their detailed order history.'],
  ['Schedules', 'Manage Buy Later and Subscribe & Reorder plans.'],
], [3000, 6500]);
h2('6.4 Customer’s own ERP connection');
p('A customer can connect its own purchasing or business system to UBOSS through Account → Integrations → ERP. This is separate from the supplier/admin ERP connection.');
p('The setup runs as six short steps. Each one opens at the top of the page when the previous is finished, so a long step never leaves the next question somewhere above the screen.');
bullets([
  'Use a guided setup flow for supported named systems or a documented API.',
  'Configure connection details, mapping, health checks, activity logs and approvals.',
  'Keep customer-supplied credentials encrypted and protected.',
  'The application rejects unsafe outbound destinations in normal production configuration.',
]);
p('Some systems ask the customer to sign in rather than to type a password into UBOSS. For those, the connection screen shows a Connect button. The customer presses it, is taken to their own system, signs in there, and approves the list of permissions being asked for. Their system then sends them back to UBOSS, the connection is ready to test, and UBOSS is told which permissions were actually granted — so a customer whose administrator allowed less than was asked for is told straight away rather than at the first order that quietly fails.');
p('A customer who changes their mind and cancels on that screen is told nothing was connected, and can start again whenever they are ready. The same button later reads Sign in again, for when their system’s access is withdrawn or expires.');
p('A connection does not have to send anything. A customer whose own system is a product or price list, rather than a purchasing system, can switch every outgoing item off and use the connection only to read from their system. When they do, UBOSS asks them to match up only the information that connection actually uses — it does not ask a customer to describe a purchase order they have said they will never send.');
p('A Product matching screen answers the question customers ask first: do both systems hold the same products? Pressing Check now reads the full product list from their system and compares it with their catalogue in UBOSS. It changes nothing — it only looks. The answer is three counts: products found in both systems, products their system has that are not sold here, and products here that their system has never mentioned. That last group is the one worth acting on, because UBOSS will never receive figures for them.');
p('Products are matched on the product code, exactly as written on each side. Where nothing matches at all, the screen says so in plain words and explains the usual reason: the two systems use different codes for the same item. The customer can then either use the same code on both sides, or point the connection at whichever column of their system holds the code used here.');
p('When a connection reads a list from the customer’s system, the activity record reports how many records were read and how many were recorded against products in UBOSS. A record that matches nothing here is counted as read but not recorded, so the two numbers together say plainly how much of their list UBOSS recognised.');
p('Setting up a live connection to monday.com needs the store to have registered an application with monday.com first. Where the store has not, the setup wizard says so on its first step and offers a test connection instead, rather than letting the customer fill in every step and be refused at the end.');
page();

// 7
h1('7. Admin Features — Secure Access, Roles and Dashboard');
h2('7.1 Staff sign-in');
bullets([
  'Staff use a separate Admin Console from customers.',
  'The application can require a location reading before opening staff routes. The location is a security record, not a rule that decides whether a person is allowed.',
  'The sign-in location appears in the session/top bar and can create an admin notification, helping the business notice unexpected staff logins.',
  'New staff can receive a temporary password. They must choose their own password before they can use normal admin routes.',
  'Staff can use password recovery without exposing whether an email address exists.',
]);
h2('7.2 Permission roles');
table(['Staff role', 'Main abilities'], [
  ['Business Owner / Super Admin', 'All business areas, staff, roles, security, settings and integrations.'],
  ['Catalog Manager', 'Categories, products, media, variants, prices, imports and publication.'],
  ['Inventory Manager', 'Inventory receipts, adjustments, reservations, warehouses and stock alerts.'],
  ['Order Manager', 'Orders, fulfilment, shipment status, cancellation, return handling.'],
  ['Finance / Approver', 'Payment review, payment links, refunds and approval work.'],
], [3100, 6600]);
p('The page may hide controls a role cannot use, but the server also checks the permission on every protected request.');
h2('7.3 Dashboard and notification bell');
bullets([
  'See orders, gross sales, collected payments, net revenue, average order value, low-stock information and upcoming recurring orders.',
  'Change reporting period and refresh business totals.',
  'Open linked items from dashboard cards, order-status summaries and payment summaries.',
  'Use the notification bell for events such as staff sign-ins, customer activity, order/payment changes and operational alerts.',
]);
page();

// 8
h1('8. Admin Features — Catalogue, Product and Compliance Management');
h2('8.1 Categories and products');
table(['Admin feature', 'What staff can do'], [
  ['Categories', 'Create and maintain the product tree used by the customer catalogue.'],
  ['Product list', 'Search, filter, sort and open products for management.'],
  ['Product editor', 'Manage title, SKU, description, status, media, specifications, variants, prices, tax context and product availability.'],
  ['Variants', 'Add product options so buyers can choose the correct size, type, pack or configuration.'],
  ['Quantity rules', 'Set minimum order quantity and other order quantity constraints.'],
  ['Currency pricing', 'Set a real price per currency/market, or use a controlled bulk price process.'],
  ['Bulk import', 'Upload catalogue data from a spreadsheet into the product area.'],
  ['Availability', 'Mark a product as priced on request, or take it off sale while leaving the listing readable.'],
  ['Packaging', 'Review how each size is boxed, the figures read from the supplier sheet, and the text they were read from.'],
  ['Source record', 'See which file and row a product came from, with the licence, capacity and internal status columns that came with it.'],
], [3000, 7000]);
h2('8.2 Price on request, and taking something off sale');
p('Two switches decide whether a customer may buy a product. They are separate from publishing, which decides whether a customer may see it at all.');
table(['Setting', 'What the customer sees', 'When to use it'], [
  ['Price on request', 'The listing shows “Request a quote” where the price would be. Nothing can be added to a basket.', 'A range the business quotes per account, or per volume, rather than at a list price.'],
  ['Available to order (off)', 'The listing, the specifications and the packaging stay readable. A notice says it cannot be ordered, in the words the business chose.', 'A product that is made but held this month. Unpublishing would make the page disappear entirely.'],
], [2200, 4400, 3400]);
bullets([
  'A product priced on request can be published without a price, and without a photograph. Everything else still has to be complete.',
  'Both settings are enforced by the system on every basket change and again at checkout, so they cannot be worked around from a browser.',
  'A product with a real price still needs a photograph before it can be published.',
]);
h2('8.3 Loading a supplier product sheet');
p('A supplier catalogue usually arrives as a spreadsheet with several product categories stacked in one worksheet. The system can read that shape directly, rather than requiring somebody to flatten it by hand first.');
table(['What it does', 'Why it works this way'], [
  ['Reads each category band, the repeated headers under it, and the product rows between them.', 'A supplier sheet is not one clean table, and treating it as one loses the category of every row.'],
  ['Shows a full preview before anything is written.', 'The preview and the real run use the same checks, so what it promises is what happens.'],
  ['Never reads or changes a price, and never changes a photograph.', 'The price column on a supplier sheet is usually a retail figure from another market, not what this business charges.'],
  ['Never deletes. A product missing from the file is left alone.', 'Tidying a catalogue is a decision somebody takes, not a side effect of a shorter file.'],
  ['Never publishes on its own. Everything arrives as a draft.', 'Publishing is a separate, recorded decision, with its own checks.'],
  ['Can be run again on the same file without creating duplicates.', 'Supplier sheets get corrected and re-sent, and the second run should update the first, not double it.'],
]);
p('The system reads how each product is packed out of the supplier’s own wording, and reports what it could and could not understand.');
bullets([
  'Where the figures are complete and multiply out correctly, the product can be ordered by the box and by the carton.',
  'Where the sheet gives only a carton total, that total is recorded and nothing is guessed about what is inside it.',
  'Where the sheet’s own figures contradict each other, the product is flagged for review and can only be ordered by the piece until somebody confirms it.',
  'The supplier’s original wording is always kept beside whatever was understood from it.',
]);
p('Products whose internal status on the sheet is “Hold” or “Working on it” are created unavailable to order. Licence status, production capacity, launch date and internal status are stored for staff only and never appear on a customer page.');
note('Where duplicates go', 'Supplier sheets often reuse a product code or a barcode across genuinely different items. Those are imported as separate products and listed in the report for somebody to check, never merged together.', C.purple);
h2('8.4 Product photographs');
p('A supplier sheet carries no photographs. The system can take your own product photography — a folder of image files — resize it for the web and put each picture on the products it actually shows.');
table(['What it does', 'Why it works this way'], [
  ['Uses only your own photographs.', 'A stock picture of another company’s product presented as yours is a false record, and on a medical device that is worse than no picture at all.'],
  ['Shows a full preview before anything is attached.', 'You can see which departments would be covered and which would be left, before any of it happens.'],
  ['Never replaces a picture somebody has uploaded.', 'Your own upload always wins. Running it again does not stack a second picture on top of the first.'],
  ['Leaves a product with no matching photograph alone.', 'A nearly-right picture is the kind of wrong nobody reports. An insulin syringe and a plain syringe look alike and are not the same product.'],
  ['Reports what is still unphotographed, by department.', 'That list is the useful part: it tells you exactly what to photograph next.'],
]);
p('Products with no photograph keep the neutral placeholder the catalogue already shows, and they still list, search and sell normally.');
h2('8.5 Product safety and legal product information');
bullets([
  'Maintain product safety information for medical-device and regulatory needs.',
  'Record manufacturer/economic operator information for EU product-safety requirements.',
  'Maintain product specifications and product documents where provided.',
  'Keep product media and product safety details available to appropriate customer-facing views.',
]);
h2('8.6 Coupons and manufacturers');
bullets([
  'Create and manage coupons, code rules, validity periods and usage context.',
  'Maintain manufacturer/economic operator data used by catalogue and product compliance information.',
  'View coupon behaviour in cart/checkout while the server remains the authority for eligibility and final totals.',
]);
note('Market rule', 'A product only appears to a customer market when it is published and has a real stored price for that market. The platform does not make up an exchange-rate price at browse time.', C.teal);
page();

// 9
h1('9. Admin Features — Warehouses and Inventory');
h2('9.1 Warehouse management');
p('The Warehouses screen is where staff manage physical places that hold stock. Warehouses can be listed, searched, filtered and placed on a map.');
table(['Warehouse detail', 'What staff can manage'], [
  ['Identity and address', 'Unique warehouse code, warehouse name, address, country and timezone.'],
  ['Map location', 'Latitude/longitude, address lookup and map display when a map provider is configured.'],
  ['Operational state', 'Operational, limited, maintenance or suspended status.'],
  ['Active/default status', 'Retire a warehouse safely; maintain the default warehouse used when an incoming receipt has no location.'],
  ['Delivery promise', 'Delivery radius, lead-time range and delivery fee/currency for customer warehouse-choice information.'],
  ['Country exclusions', 'Countries that a warehouse must not offer delivery to.'],
  ['ERP reference', 'External ID, last sync state/message and inventory-integration status.'],
], [3100, 6600]);
h2('9.2 Inventory management');
bullets([
  'View stock per location/warehouse.',
  'Receive incoming stock into a warehouse.',
  'Make stock adjustments with controlled records.',
  'See stock movements, stock balances, reservations and low-stock thresholds.',
  'Open a warehouse’s inventory view to see the products held there, including zero-stock answers where relevant.',
  'Use stock information while processing orders and schedule occurrences.',
]);
h2('9.3 Important warehouse safeguards');
bullets([
  'A warehouse with history is not deleted; it is retired so past stock and order records remain correct.',
  'A warehouse cannot be retired while it still contains stock.',
  'There is always one active default warehouse.',
  'Warehouse codes are unique and are stamped on stock movements for traceability.',
  'Active and operational are separate: a warehouse can remain a valid record but be temporarily unable to ship.',
]);
note('Customer and warehouse link', 'Customers can see eligible shipping warehouses in the basket. Admin staff configure the warehouse delivery range, operating state, lead time and fee information that makes this possible.', C.orange);
page();

// 10
h1('10. Admin Features — Orders, Fulfilment, Payments and Recurring Plans');
h2('10.1 Order management');
table(['Screen/action', 'What staff can do'], [
  ['Orders list', 'Search and filter every order, then open its detail screen.'],
  ['Order detail', 'See order items, frozen price/tax data, customer, delivery context, payments, invoice/shipment information and history.'],
  ['Order status actions', 'Move orders through allowed states such as processing, shipped, delivered, cancelled, returned and refunded, with permission and reason rules.'],
  ['Fulfilment', 'Allocate/confirm stock work, manage shipment/delivery progress and respond to exceptions.'],
  ['Approval', 'Review orders requiring approval when approval rules or credit terms apply.'],
], [3000, 7000]);
h2('10.2 Payments and finance');
bullets([
  'Review payment status: created, pending, captured, failed or refunded.',
  'Create or monitor payment links.',
  'Process refunds where the staff role and order status allow it.',
  'See payment-provider activity while keeping sensitive card data outside the application.',
  'Review invoices and payment context attached to an order.',
]);
h2('10.3 Recurring schedules');
bullets([
  'See customer Buy Later and Subscribe & Reorder plans.',
  'Review next occurrences, plan status, payment issues and operational exceptions.',
  'Support customers when schedules pause, need authentication, run out of stock or cross a price-tolerance rule.',
  'Understand that each occurrence is independently checked before it becomes an order.',
]);
page();

// 11
h1('11. Admin Features — Customers, Service, Reports and Governance');
h2('11.1 Customer management');
table(['Admin area', 'What staff can do'], [
  ['Customers list', 'Find customer accounts, including accounts awaiting approval where self-registration approval is enabled.'],
  ['Customer detail', 'Review customer profile, company, addresses, orders, payment/credit context, prices and purchasing limits.'],
  ['Customer approval', 'Approve eligible self-registered customers after their email has been confirmed.'],
  ['Customer limit management', 'Apply purchasing/credit limits according to business policy.'],
  ['Customer support context', 'Use order and account history to help the customer without asking them to repeat information.'],
], [2900, 7100]);
h2('11.2 Chat enquiries');
p('Staff can open AI/chat enquiries to understand questions that originated from the customer assistant. This creates a better support hand-off from product discovery to human help.');
h2('11.3 Reports');
bullets([
  'Run sales, stock, tax and operational reports.',
  'Export report information where the user has permission.',
  'Use dashboard and report views to spot payment, stock, schedule and order issues.',
]);
h2('11.4 Audit log and data requests');
bullets([
  'Audit log records who changed what, when, from which IP and the before/after state where applicable.',
  'Data requests area supports governed privacy work such as access and erasure requests.',
  'The audit record is written with the change so a business action cannot quietly happen without a trace.',
]);
page();

// 12
h1('12. Admin Features — Staff, Settings and Integrations');
h2('12.1 Staff management');
bullets([
  'Create staff accounts and assign one of the fixed business roles.',
  'Issue a temporary password for a new staff member without exposing their permanent password to another employee.',
  'Resend an eligible temporary password and track required password change rules.',
  'Use role permissions to limit access to catalogue, inventory, orders, finance, reports, staff and settings functions.',
]);
h2('12.2 Business settings');
table(['Settings group', 'Examples of what it controls'], [
  ['Business profile', 'Business name, addresses and business identity used by the system.'],
  ['Tax and market settings', 'VAT/GST settings, countries, currencies, price and market configuration.'],
  ['Shipping and delivery policy', 'Delivery-related configuration and customer-facing policy information.'],
  ['Notifications', 'Email/notification settings and delivery behaviour.'],
  ['Appearance and policy links', 'Brand-facing configuration and links such as terms or privacy documents.'],
  ['Feature configuration', 'Which optional customer/admin capabilities appear in a specific deployment.'],
], [3000, 7000]);
h2('12.3 Integrations and ERP');
bullets([
  'Configure payment gateway connections and credentials in the integrations area.',
  'Configure the supplier/operator ERP connection in Settings → ERP: address, credential, endpoints, field mapping, tests, sync and activity.',
  'Monitor the customer’s own ERP connections separately, with support visibility designed not to expose their secrets.',
  'Use safe outbound HTTP rules, encrypted secrets and logged integration activity.',
]);
note('Two different ERP features', 'Admin ERP is the supplier’s warehouse/business system. Customer ERP is the buyer’s own purchasing system. They are deliberately separate so ownership, credentials and support access remain clear.', C.orange);
page();

// 13
h1('13. System Features — Automation, Notifications and Reliability');
h2('13.1 Background worker');
table(['Automatic job', 'What it does'], [
  ['Scheduled orders', 'Finds due Buy Later/Subscribe & Reorder occurrences, validates them, creates orders and starts the appropriate payment path.'],
  ['Notification outbox', 'Sends emails and notifications after the business event has been safely recorded.'],
  ['Payment link expiry', 'Monitors expiring links and records relevant outcomes.'],
  ['Exports and reports', 'Runs allowed background export/report work.'],
  ['Integration and ERP jobs', 'Runs retryable connection/sync/push work without blocking the user interface.'],
  ['Retries and dead-job follow-up', 'Retries temporary failures under controlled limits and surfaces unrecoverable work for staff follow-up.'],
], [3300, 6700]);
h2('13.2 Reliability controls');
bullets([
  'Queue jobs use leases so more than one worker cannot complete the same work at the same time.',
  'Order checkout uses idempotency keys to avoid duplicate orders after a double-click or retry.',
  'Payment webhooks use signature verification and unique provider-event IDs to avoid accepting a forged or repeated payment event.',
  'Order status transitions are centrally controlled; staff cannot write an arbitrary status directly.',
  'Money is stored/calculated using integer minor units rather than unsafe floating-point decimal arithmetic.',
]);
h2('13.3 Notifications');
bullets([
  'Customer notifications can include registration/activation, password reset, order, payment, schedule and contact-confirmation events.',
  'Staff notifications can include sign-ins, low stock, payment/order actions, customer approval and operational alerts.',
  'Notification work is queued after the business record is committed, reducing the risk of an email being sent for an order that was not saved.',
]);
page();

// 14
h1('14. Security, Accessibility and Quality Features');
h2('14.1 Security');
bullets([
  'Separate customer and admin sessions allow a buyer and staff user to be signed in at the same time without one replacing the other.',
  'Passwords use secure password hashing; reset/activation/contact tokens are time-limited and single-use.',
  'Permissions are enforced on the server for protected actions.',
  'Rate limits help protect login, API and expensive assistant actions.',
  'Provider credentials and integration secrets are encrypted.',
  'Customer-supplied integration addresses are checked to prevent unsafe internal/private network access in normal production use.',
  'Live payment keys are rejected in non-production environments.',
  'Configuration is checked at application start so an incomplete setup fails clearly instead of failing later during business work.',
]);
h2('14.2 Accessibility and responsive use');
bullets([
  'Customer and admin interfaces are responsive for desktop and smaller screens.',
  'The account sidebar becomes an accessible disclosure on smaller screens rather than disappearing.',
  'Controls, status indicators and forms use labelled accessible patterns.',
  'The system includes light/dark theme support and contrast checking.',
  'The storefront and admin panel are translated into eight languages.',
]);
h2('14.3 Data accuracy');
bullets([
  'Order lines retain snapshots of product name, price and tax used at purchase time.',
  'The product catalogue shows real market prices; no automatic browse-time currency conversion is used.',
  'Warehouse/inventory history is protected from unsafe deletion.',
  'Audit log and order history preserve traceability.',
]);
page();

// 15
h1('15. Optional Features and Configuration');
p('Some features are implemented but only appear when the organisation enables the relevant feature flag or connects the required external provider.');
table(['Optional capability', 'When it appears / what is required'], [
  ['Customer self-registration', 'Enabled by the customer-registration feature. It can still require staff approval after email confirmation.'],
  ['Order approvals', 'Enabled when the business wants certain orders to wait for an approver.'],
  ['Recurring and scheduled orders', 'Enabled when the business offers Buy Later and Subscribe & Reorder.'],
  ['Any-product scheduling', 'Controls whether all published products or only selected products may be repeated.'],
  ['AutoPay', 'Requires both AutoPay features and a compatible payment-provider configuration.'],
  ['Admin ERP', 'Requires ERP integration feature and configured connection.'],
  ['Customer ERP', 'Requires customer integration path/configuration and safe endpoint validation.'],
  ['Live monday.com connections', 'Requires the store to register an application with monday.com and hold its details in configuration. Without one, customers can still set up a monday.com test connection.'],
  ['Warehouse map provider', 'Works with configured Google Maps, vector-map or raster-tile settings; the screen still works without a map background.'],
  ['AI assistant / image search', 'Requires assistant configuration; guest AI access is separately configurable.'],
  ['Admin location gate', 'Can be enabled for staff sign-in; production deployment needs HTTPS for browser location access.'],
], [3500, 6500]);
note('Configuration rule', 'A feature being in the code does not mean it is always enabled in every customer installation. This guide describes the capability and clearly identifies when setup controls visibility.', C.orange);
page();

// 16
h1('16. Simple End-to-End Examples');
h2('Example A — Customer buys a product');
table(['Step', 'Customer action', 'System response'], [
  ['1', 'Opens home page and searches products.', 'Shows catalogue items available in the chosen country/currency.'],
  ['2', 'Opens a product, chooses variant and quantity.', 'Checks product/variant relationship and quantity rules.'],
  ['3', 'Adds item to basket.', 'Stores the basket line and recalculates server-owned totals.'],
  ['4', 'Reviews “Where this can ship from”.', 'Shows eligible warehouses, lead-time/fee information and any partial-stock warnings.'],
  ['5', 'Chooses a warehouse preference and continues.', 'Records preference; actual total remains the clearly shown checkout total.'],
  ['6', 'Selects address/payment choice and places order.', 'Creates one order, reserves stock, applies tax/coupon/limits and starts payment/approval path.'],
  ['7', 'Pays securely.', 'Payment provider event verifies payment; then order becomes confirmed and processing can begin.'],
  ['8', 'Checks My orders.', 'Shows order status, history, payment/invoice context and fulfilment progress.'],
], [800, 4100, 5200]);
h2('Example B — Inventory manager handles stock');
table(['Step', 'Staff action', 'System response'], [
  ['1', 'Signs in to Admin Console and completes required location check.', 'Creates staff session and records sign-in place for visibility.'],
  ['2', 'Opens Warehouses.', 'Shows searchable warehouse list/map and operational state.'],
  ['3', 'Opens one warehouse inventory.', 'Shows products, balances, reservations and stock context for that location.'],
  ['4', 'Receives stock or records an adjustment.', 'Creates controlled inventory movement history.'],
  ['5', 'Updates delivery/operational details when permitted.', 'Customer warehouse-choice information updates from configured warehouse data.'],
  ['6', 'Reviews low stock/dashboard alerts.', 'Helps staff decide what needs replenishment or operational follow-up.'],
], [800, 4300, 5000]);
h2('Example C — Business owner supervises the platform');
bullets([
  'Reviews dashboard orders, payments, sales, low stock and upcoming recurring work.',
  'Checks reports and audit history for decisions and traceability.',
  'Manages staff accounts and roles.',
  'Maintains tax, markets, notifications, business settings and policy links.',
  'Configures payment/integration/ERP settings with controlled credentials and tests.',
]);
note('Document status', 'This guide is based on the current UBOSS Sourcing codebase, including customer storefront routes, admin routes, warehouse rules, API business rules, background-worker behaviour and feature configuration.', C.teal);

const doc = new Document({
  creator: 'UBOSS Sourcing',
  title: 'UBOSS Sourcing Feature Guide',
  description: 'Simple English feature guide for UBOSS Sourcing.',
  styles: {
    default: { document: { run: { font: 'Aptos', size: 21, color: C.ink } } },
  },
  sections: [{
    properties: {
      page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } },
    },
    headers: { default: new Header({ children: [new Paragraph({ text: 'UBOSS SOURCING  |  FEATURE GUIDE', spacing: { after: 0 }, run: { size: 7.5, bold: true, color: C.muted } })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'UBOSS Sourcing • Page ', color: C.muted, size: 7 }), new TextRun({ children: [PageNumber.CURRENT], color: C.muted, size: 7 })] })] }) },
    children,
  }],
});

await writeFile(out, await Packer.toBuffer(doc));
console.log('Created ' + out);
