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
  ['Open a category', 'Only the products within that category, with normal catalogue tools. Anything filed inside it is shown as cards above the results.'],
  ['Search for a product', 'Search results for product names, identifiers and relevant catalogue content.'],
  ['Use filters and sort', 'Narrow the catalogue by the available catalogue facets and change ordering.'],
  ['Use voice search', 'Use supported browser voice input for a search query.'],
  ['Use image search', 'Upload a product image to match relevant products when the feature is available to the signed-in customer.'],
], [3500, 6800]);
p('Each department on the home page carries a picture of what is in it — a cannula beside IV Cannula, a glove beside Surgical Gloves — so a buyer can find the department they came for by shape before they finish reading the labels. A department the system does not recognise by name gets a plain shape instead of a wrong picture.');
p('The top of the home page carries a moving three-dimensional graphic: a slowly turning globe of the world, with three paths circling it and small lights travelling along them, and four cards riding around it for the four things a buyer can do beyond ordinary ordering — ask the assistant, schedule a repeat delivery, set up automatic payment, and connect their own business system. The cards are real buttons, not decoration, and each one either opens the screen behind it or explains why it cannot.');
p('The globe is drawn by the software itself rather than downloaded as a picture, so it looks the same on a company network with no access to the outside world as it does anywhere else, and nothing on the page waits for it. A slower or smaller device is given a simpler version automatically, and a device that cannot show it at all is given a still picture instead, with the same four cards. Anyone whose computer or phone is set to reduce animation sees the graphic standing still.');
p('The graphic is built to be polite about what it costs. It stops completely as soon as it is scrolled out of view or the tab is put in the background, it shows a still picture instead of moving for anyone whose device is set to reduce motion, and on a phone or a computer that would struggle with it the page falls back to a plain drawn version that looks finished in its own right. It is also downloaded separately from the rest of the shop, so a buyer who only wants to search for a product never waits for it.');
h2('3.2 Product detail page');
bullets([
  'See product images, product name, SKU/reference, specifications and descriptions.',
  'Choose a variant where a product has more than one option.',
  'See quantity rules, including minimum order quantity and permitted quantity steps.',
  'Read product safety and medical-device information where the product requires it.',
  'View tax and market price context before adding to the basket.',
  'Add the item to the basket or save it for later where the relevant feature is available.',
]);
h2('3.3 What a buyer counts in: cartons and pieces');
p('There are two ways something is sold here, and which one applies depends on who is selling it. What the shop itself sells is sold by the carton, and one carton holds 500 pieces: the buyer types a number of cartons, and every price they have been shown is the price of one carton. What an outside seller sells is sold by the piece, at that seller’s own price for one piece.');
p('The buyer never has to work out which is which. Every product says it, in plain words, under its name and above its quantity box, and the price beside those words is the price of the thing named.');
table(['What the customer sees', 'What the customer can do'], [
  ['A line under every product in the list: either “One carton has 500 pieces” or “Sold by the piece”, with the matching price beside it.', 'Compare prices down a page knowing exactly what each figure is the price of.'],
  ['The same sentence above the quantity box on the product page: “Ordered by the carton · one carton has 500 pieces”, or “Sold by the piece” with the seller’s smallest order and any step beside it.', 'Know what the number they are about to type is counting, and what they are allowed to type, before they type it.'],
  ['Under the price, what that price is the price of: “per carton of 500 pieces”, with the price of one piece beside it.', 'Read what a carton costs straight off the page, and check the arithmetic behind it if they want to.'],
  ['A Packaging and ordering section stating the carton, with a ready-reckoner for 1, 2, 5 and 10 cartons. On something sold by the piece the section simply says so, because one piece is one piece and there is nothing to convert.', 'Answer “if I order five cartons, how many is that?” without a calculator — and not be shown a conversion table that does not apply.'],
  ['A running line under the quantity box: “That comes to 1,000 pieces.”', 'See the number the warehouse will pick before committing to it.'],
  ['A Dimensions section with the box sizes as the supplier recorded them.', 'Check what will arrive against the space they have.'],
]);
bullets([
  'The basket counts cartons and prints the piece total under them, and so does a repeating plan. A line sold by the piece is counted in pieces, and the basket says so under the quantity.',
  'An order shows both: how many cartons were ordered, and the pieces those came to. The invoice names the packing in the line description, such as “Disposable Syringe 5ml (2 cartons of 500)”. A line bought by the piece is shown and invoiced in pieces, with no mention of a carton.',
  'One basket can hold both at once — cartons from the shop and pieces from two different sellers — and each line keeps its own unit, its own quantity and its own price. Nothing is converted between them.',
  'A carton is not a minimum order. Any minimum is a separate rule the business sets, and the page says so.',
  'A seller sets their own smallest order and their own step, in pieces. A buyer asking for fewer than the smallest is moved up to it, and a quantity between two steps is moved up to the next one.',
  'The price of a carton is the price of one piece multiplied by 500. The price of a piece is simply the price of a piece. Neither is a total: tax, discounts and how many were ordered are still worked out at the basket and the checkout.',
]);
note('How many is in a carton', 'Five hundred is a setting, not a fixed part of the software. A business that packs its own product differently changes one number, and every price, every quantity box and every page that says “one carton has 500 pieces” follows it.', C.purple);
note('Why an outside seller’s goods are not sold by the carton', 'The carton belongs to the business running this shop — it is how they pack and ship their own product. An outside seller packs their own way, and their price is the price of one item. Applying the shop’s carton to their listing would have shown a ten-rupee item at five thousand rupees, and charged it. So what a line is counted in is decided by who is selling it, worked out by the system before any quantity or price is calculated, and never guessed from the name of the product or the department it sits in.', C.orange);
note('Searching by price when both appear together', 'A price range is matched on what one piece costs, for everything, so that “cheapest first” genuinely orders a page rather than putting every by-the-piece listing below every carton. The search panel says this under the boxes, because a range typed in carton money will also bring back by-the-piece listings at the matching piece price.', C.blue);
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
  'Change a line by the carton, with the piece total updating beside it.',
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
p('Products are matched on the product code, exactly as written on each side. Where nothing matches at all, the screen says so in plain words and explains the usual reason: the two systems use different codes for the same item.');
p('When that happens, and it is common, the same screen is where the customer fixes it. They can tell UBOSS which product in this catalogue each of their own codes means. Rather than pairing them one at a time, they paste two columns straight out of a spreadsheet — their code, then the code used here — separated by a comma, semicolon or tab, so a file exported by any spreadsheet is accepted as it is. A heading row is ignored.');
p('Any line that names a product this catalogue does not have is reported back with its line number and the reason, and everything else is still saved. A long list will usually contain a few codes that have since been retired, and refusing the whole file because of three of them would leave the customer with nothing.');
p('Once a code is paired, every sync from then on uses that pairing, and the matching screen counts that product as found in both systems. A pairing the customer has made is always preferred over two codes that merely happen to look the same. Nothing is ever guessed: UBOSS will not decide that two codes probably mean the same product, because a wrong pairing quietly attaches real stock figures to the wrong item and is believed for months.');
p('When a connection reads a list from the customer’s system, the activity record reports how many records were read and how many were recorded against products in UBOSS. A record that matches nothing here is counted as read but not recorded, so the two numbers together say plainly how much of their list UBOSS recognised.');
p('Setting up a live connection to monday.com needs the store to have registered an application with monday.com first. Where the store has not, the setup wizard says so on its first step and offers a test connection instead, rather than letting the customer fill in every step and be refused at the end.');
p('Checking a connection never switches it off. A customer can press Test at any time, including on a connection that is switched on and carrying their orders, and it is left exactly as it was — switched on if it was switched on, paused if it was paused. Only the result changes: the screen shows whether the check succeeded, when it ran and what the customer’s system said. A connection is taken out of service by repeated real failures, never by a single check.');
page();

// 6a
h1('6a. Seller Features — Selling on the Marketplace');
p('Any business can apply to sell here. It is not limited to one kind of product: a seller may list fasteners, cables, packaging, safety equipment, electronics or medical devices, and the questions they are asked change with the product category rather than being the same for everyone.');
note('Same account, two modes', 'A customer who already buys here becomes a seller using the same sign-in. Nobody is asked to keep a second password for the same business.', C.blue);

h2('6a.1 Becoming a seller');
table(['Step', 'What the person does', 'What the system does'], [
  ['1', 'Presses "Become a seller" in the top bar of the shop.', 'Opens a public page that explains what selling here involves, before any account is needed.'],
  ['2', 'Signs in, or creates an account.', 'Uses the ordinary customer sign-in. Selling does not need a second account or a second email address.'],
  ['3', 'Gives the registered business name, the shop name buyers will see, the country of registration and the kind of seller.', 'Checks the shop name is free as it is typed, then creates the seller business and makes this person its owner.'],
  ['4', 'Works through the application.', 'Saves each step on its own so the person can stop and come back, for as long as it takes to gather documents.'],
  ['5', 'Sends the application for review.', 'Refuses to send it while a required step is unfinished, and names each one that is.'],
], [700, 4400, 5000]);

note('The Seller Hub has its own password', 'Buying and selling share one account, and the selling side has a second password of its own, chosen the first time the Hub is opened. It has to be different from the shop password. Entering it is remembered for that browser only, so signing in on a new machine asks again, and changing it closes the Hub on every other machine while leaving the shop signed in. A button in the Hub closes it without signing out of the shop, for anybody handing their computer to somebody else.', C.blue);

h2('6a.2 What the application asks for');
p('There are eight steps. What each one demands depends on the country the business is registered in and on whether it manufactures, distributes, wholesales or resells — so a German seller is asked for a VAT number, an Indian seller for a GSTIN, and a distributor for written authorisation from the manufacturer instead of a declaration it cannot sign.');
table(['Step', 'What it covers'], [
  ['Contact verification', 'The email address and mobile number the marketplace will reach the business on.'],
  ['Business identity', 'Registered name, country, company registration number and tax registration.'],
  ['Identity and documents', 'Who is authorised to act for the business, and the documents that prove the business exists.'],
  ['Store details', 'The name buyers see, a description of the business, and how buyers reach its support desk.'],
  ['Pickup and returns', 'The addresses orders are sent from and returns come back to, with each one’s cut-off time and how long picking takes.'],
  ['Payout account', 'Where money earned is sent.'],
  ['Compliance', 'Any certificates or declarations the things being sold actually need.'],
  ['Agreements', 'The marketplace agreement, commission schedule, returns policy, privacy policy and a declaration that the seller is entitled to sell what it lists.'],
], [3000, 7000]);
note('Working through it', 'The application opens at its first step, contact verification, for anybody who has not filled any of it in yet, and at whichever step was last saved for anybody coming back to it. Each step has Back and Continue underneath it, and the list of steps down the side jumps straight to any of them. Moving to another step puts the page back at the top, so the new step is read from its heading down rather than from the middle.', C.blue);
note('Being told what is still missing', 'Where a step needs more than one thing — store details needs both a description of the business and a support email address — saving it says which of them is still outstanding, in words, on the step itself. Filling in one thing never clears another that was entered earlier.', C.blue);
note('Payout does not block the application', 'A seller is never held up from sending their application in because the marketplace has not finished setting up payments.', C.orange);
note('Compliance only asks for what the marketplace decides it needs', 'Nothing on the compliance step is required unless the marketplace has said so for that country and that kind of seller. A seller of ordinary goods is not asked for certificates that do not exist for what they sell. Where the marketplace does regulate a trade, it marks what it needs, and the step then has to be answered before the application can be sent in.', C.orange);

h2('6a.2a Sending in certificates and licences');
p('Both steps that ask for paperwork — identity and documents, and compliance — let the seller attach files. A CE certificate, a Declaration of Conformity, a quality certificate, an import or manufacturing licence, a registration document, proof of identity or address: each one is uploaded, stored privately, and checked by the marketplace before it counts for anything.');
table(['What the seller does', 'What the system does back'], [
  ['Chooses what the document is, attaches a PDF or a photograph, and can give the date it was issued and the date it runs out', 'Checks the file really is a PDF or a picture — from the file itself, not from what the browser claims — refuses anything else, and stores it where nobody can reach it by guessing an address.'],
  ['Sends it', 'Marks it "being checked", tells the marketplace at once, and shows the step as waiting rather than finished.'],
  ['Comes back later', 'Shows every document sent, what the marketplace decided about each, and the reason in full for anything not accepted.'],
  ['Sends a better copy of the same document', 'Uses the new one from then on and keeps the old one, so it stays clear what was accepted and when.'],
  ['Wants to remove one', 'Allowed while nobody has decided it. Once the marketplace has accepted a document, the way to change it is to send a newer one.'],
], [4200, 5800]);
note('Uploading is not approving', 'A certificate counts for nothing until somebody at the marketplace accepts it. A step waiting on a decision says "being checked" rather than showing a tick — and waiting never stops the seller sending the application in, because the marketplace looks at the documents as part of reviewing the application.', C.blue);
note('A certificate that has run out is not a certificate', 'If a document was given an expiry date and that date has passed, it stops counting and the step says so. The seller finds out from their own checklist rather than from a refusal weeks later.', C.purple);
note('Checking files for viruses', 'No virus checker is installed with this software. Every uploaded file therefore says plainly that nothing has checked it, rather than claiming to be safe, and that wording is shown to the seller and to staff alike. Whether an unchecked file may be opened is a setting the business running the marketplace decides.', C.orange);
note('About the signature', 'The application records a typed name, a tick, the version of each document, the time, the address and the browser. This is a record of consent. It is not an electronic signature tied to a verified identity, and the system never describes it as one.', C.orange);

h2('6a.3 What the marketplace sees, and how a seller is approved');
p('Everything the applicant supplies appears in the admin console so that staff can check it before allowing the business to sell. Nothing goes on sale on the strength of an application alone.');
table(['What staff see', 'Why it is there'], [
  ['A queue of applications, oldest first', 'So the business that has waited longest is dealt with first rather than last.'],
  ['How far through the application each one is', 'Lets staff see at a glance which applications are ready to decide and which are still being filled in.'],
  ['The registered and trading names, country and seller type', 'The basic question of who this business claims to be.'],
  ['Company registration number, tax registration, and any country-specific identifiers', 'The numbers staff check against a public register.'],
  ['The authorised representative, their role and contact details', 'Who signs for the business, and who to contact about a problem.'],
  ['Every document uploaded, with its scan state and any expiry date', 'Evidence, and whether it has been checked for viruses. An unchecked file is shown as unchecked rather than as safe.'],
  ['A button to open each document, and buttons to accept it or send it back', 'This is where a certificate is actually decided. Opening one gives a link that works for a few minutes and once only; sending one back needs a reason, which the seller reads word for word.'],
  ['Every address the seller would ship from or take returns at', 'A seller with no address that can dispatch cannot fulfil an order.'],
  ['Every agreement accepted, with its version, the time and the address it came from', 'What exactly the business has agreed to, and when.'],
  ['Step-by-step application progress', 'Which parts are finished, which need attention, and any note the system attached.'],
  ['Payout account state', 'Whether money can actually be sent, and what the provider is still waiting for.'],
  ['Private staff notes', 'Staff assessments that the seller must never see, kept in their own panel and clearly marked.'],
], [4200, 5800]);

h2('6a.4 The decision');
table(['Decision', 'What happens'], [
  ['Take it on', 'Marks the application as being reviewed, so two members of staff do not work on it at once.'],
  ['Approve', 'The business may start creating listings immediately. Nothing it lists goes on sale until that listing has separately passed quality review.'],
  ['Send back', 'Returns the application to the seller with a written reason they can act on. They fix it and send it again.'],
  ['Reject', 'Refuses the application with a reason. Staff choose whether the business may apply again.'],
  ['Suspend', 'Stops an already approved seller. New listings and new orders stop at once; orders they have already accepted still have to be fulfilled and money already owed is still owed.'],
], [2200, 7800]);
note('Reasons are written for the seller', 'Every refusal needs a reason, and that reason appears on the seller’s own screen. A separate box holds private staff notes, which are never sent to the seller. The two are kept apart on purpose.', C.blue);
note('Two people, one application', 'A decision is recorded against the version of the application the reviewer was looking at. If somebody else decided it in the meantime, the second decision is refused rather than quietly overwriting the first.', C.purple);

h2('6a.5 Listing a product');
p('A seller adds one listing at a time through a three-step flow: choose the category, choose the brand, then fill in the product details. The order matters — which details a product needs depends on its category, and the brand decides whether the seller is allowed to list it at all.');
table(['Step', 'What the seller does', 'What the system does'], [
  ['Choose a category', 'Searches or browses to the right category.', 'Creates a saved draft straight away, so closing the tab loses nothing.'],
  ['Choose a brand', 'Picks an approved brand, or asks for one that is missing.', 'Offers brands already used by this seller first. A requested brand can be used on a draft while it is decided, but not on anything on sale.'],
  ['Add product details', 'Fills in five sections: photos, price and stock, description, extra information, and compliance.', 'Counts each section as it is filled in, shows what is missing, and puts every problem beside the field that caused it.'],
  ['Set the price and how it is sold', 'Enters the price per piece, the stock in pieces at each address, the smallest order, any step, and any per-order limit.', 'Labels every one of those boxes in pieces, refuses a smallest order or a step below one, and refuses a limit that no allowed quantity could reach.'],
], [1800, 4100, 4100]);
note('There is a department for whatever they sell', 'A new business starts with twenty-five departments already in place — medical, laboratory, industrial supplies, tools, electrical, electronics, IT, phones, office, packaging, safety, cleaning, building, automotive, agriculture, catering, furniture, home, clothing, beauty, sports, toys, books, chemicals and energy — each with sections underneath. A seller therefore always has somewhere sensible to file a product, whatever it is, from the first day the shop opens.', C.teal);
note('The questions fit the product', 'A seller listing a bolt is asked for a thread size, a length and a grade. A seller listing a power supply is asked for voltage and whether it ships with a battery. A seller listing a medical instrument is asked for a device class and a UDI. Nobody is asked for somebody else’s fields.', C.teal);
note('Photographs', 'Every listing needs a front view and a picture of the packaging. A category that asks for a barcode or UDI also asks for a readable photograph of that label, and one that asks about sterility asks for a photograph of the seal.', C.blue);
note('A seller prices one piece', 'Everything on the price and stock step is counted in pieces, and every label says so: price per piece, stock in pieces, smallest order, and step. That is what a buyer will see and what the seller will be paid on. Nothing a seller lists is shown to buyers as a carton, and the shop’s own carton of 500 never appears on a seller’s listing.', C.teal);

h2('6a.6 Photographs and videos');
p('A seller uploads real photographs and real videos against a listing. Photographs go into named slots so that everybody knows which picture is which; videos are a separate strip, because a video either exists or it does not.');
table(['What the seller can do', 'What the system does'], [
  ['Drag a file onto a slot, or click to choose one', 'Accepts JPEG, PNG, WebP and GIF pictures, and MP4, WebM and MOV videos.'],
  ['Upload a video of the product', 'Holds videos to their own, larger size limit — a photograph limit sized for a video would let anybody upload enormous pictures.'],
  ['Choose which picture is the main one', 'Keeps exactly one main picture at all times, and never lets it be a video, because a search result and an order confirmation cannot play one.'],
  ['Remove a picture or video', 'Promotes the next picture to main if the one removed was it, so a listing is never left with pictures and no main one.'],
  ['Describe each picture, and each video', 'Uses the description for buyers using a screen reader. For a video it is shown as visible text beside the player.'],
], [4200, 5800]);
note('Why the file itself decides', 'The system reads the first few bytes of every upload rather than trusting what the browser says it is. A file renamed to look like a picture is refused — including drawings that can carry scripts, which are never accepted.', C.orange);
note('Videos and captions', 'A video uploaded by a seller has no subtitle file and nothing here can create one. Instead the seller is asked to write what the video shows, and that description is displayed beside it — so somebody who cannot hear it still learns what it contains.', C.blue);
note('What happens on approval', 'When staff approve a listing, its photographs are carried onto the catalogue product automatically. Without that step a seller could upload a dozen pictures and the product would still appear with none.', C.teal);

h2('6a.6 The product title');
p('Product titles are built automatically from the details the seller fills in, in a fixed order. Sellers cannot type their own unless the marketplace turns that on.');
bullets([
  'The title is what a buyer searches and compares, so it has to mean the same thing across every seller.',
  'The "Preview title" button becomes available only once every detail the title needs is filled in and valid.',
  'The preview shows which field produced each part of the title, so a seller who thinks the title is wrong knows which field to change.',
  'Where sellers cannot edit the title, they can ask the marketplace to correct it.',
]);

h2('6a.7 Sending a listing for review');
bullets([
  'A listing can only be sent for review once every required section passes. The button says what is stopping it.',
  'Sending it for review never puts it on sale. A listing becomes a real catalogue entry only when a member of staff approves it.',
  'An approved listing is created switched off, so the seller chooses when it goes on sale rather than it appearing at an unexpected hour with no stock.',
  'A listing sent back arrives with comments attached to the individual fields that need changing.',
  'A listing still waiting to be checked can be taken back at any time, changed, and sent again. Nothing is lost by doing so — it only loses its place in the queue.',
  'A listing that is with the marketplace cannot be edited while it is being read. Sending a changed version means sending a new one, so the person reading it is never looking at something that is quietly changing underneath them.',
  'Nobody has to be online at the same time. A seller can send a listing in and sign out; staff can decide it hours or days later; and the decision, the reason and any comments are waiting in the seller’s account the next time they sign in.',
]);
note('The decision applies to the version that was read', 'If a seller sends in a newer version while a member of staff has the older one open, or if a colleague has already decided it, the decision is refused and the screen says which of the two happened. Approving a version nobody read is the mistake this prevents, and it is worth preventing because the record would afterwards show that person approving it.', C.orange);
note('Putting it on sale is what buyers see', 'The moment a seller switches an approved listing on, it appears in its category, in search and in the filter counts of the shop, at the seller’s own price. Pausing it takes it straight back out again. That is the whole meaning of the on-sale switch: the shop shows what somebody is actually selling right now, not everything that has ever been approved.', C.teal);
note('Whose price a buyer sees', 'Where several sellers offer the same thing, the shop shows the lowest price anyone is currently selling it at, and the basket buys from that seller. Prices are never converted between currencies to make that comparison — a seller who prices in rupees is compared with other rupee prices and with nothing else.', C.purple);

h2('6a.8 Running the shop');
table(['Area', 'What the seller can do'], [
  ['Home', 'See new orders, orders that need dispatching, anything past its dispatch time, sales and earnings for a chosen period, open returns, listings needing attention, and stock running low — all from live figures.'],
  ['Listings', 'See everything on sale and everything still being written, filter by status and stock, pause or resume a listing, change a price, and duplicate one as the basis for another.'],
  ['Inventory', 'See what is held at each address, set a reorder level, record stock received, and correct a count — with a reason, which is kept on the record.'],
  ['Orders', 'Accept or reject an order, choose which address it ships from, and mark it picked, ready and shipped. Opening one shows what to pack, where to send it, what it earns after commission, and a form for recording a shipment with its carrier and tracking number — including a part shipment, where the quantities are itemised.'],
  ['Payments', 'Read every statement line by line — sales, commission, processing, refunds and adjustments — and see the payouts made against them.'],
  ['Brands', 'See every brand name asked for, whether it was approved, refused or is still being looked at, the reason given, and take back a request nobody has decided yet.'],
  ['Notifications', 'Read every decision the marketplace has made about the business, and mark each one read. Read marks are per person, so one colleague reading something does not hide it from the rest.'],
  ['Activity', 'A record of everything that has happened to the account, its listings and its orders. Marketplace actions appear as a role rather than as a named member of staff.'],
  ['Profile', 'Review the business details, add and correct the addresses shipped from, close one that is no longer used, and manage who else can use the seller account — including removing somebody.'],
], [1800, 8200]);
note('Where the money goes is not everybody’s business', 'Only the owner, an admin and a finance viewer can see the payout account — the bank, the last four digits, and what the provider is still waiting for. Somebody who reads orders to answer buyers, or counts stock, cannot, on the screen or anywhere behind it.', C.orange);
note('Payouts are not set up on this installation', 'No payment provider is connected, so nothing can be sent yet and the screens say exactly that, naming the setting the operator has to fill in. Nothing pretends an account has been verified. Everything a seller earns is still recorded in full — statements begin once the marketplace connects a provider and closes its first settlement period.', C.purple);
note('One order, split by seller', 'A buyer places a single order. Each seller sees only their own part of it, with its own number and its own dispatch deadline. Sellers are not shown the buyer’s email address, phone number or payment details, and never see another seller’s lines.', C.teal);
note('Accepting puts the stock aside', 'When a seller accepts an order they say which of their addresses it ships from, and the goods for it are set aside at that address straight away. Nobody else can be sold those units afterwards, and the seller’s own stock figures drop to match everywhere they appear. If there is not enough on the shelf the order cannot be accepted, which is a better answer than accepting one that can never be sent. Cancelling puts the goods back; recording a shipment takes them out for good.', C.teal);
note('The dispatch deadline comes from the address', 'It is worked out from that address’s own working days, its daily cut-off time and how long it takes to pack — on the local clock there, not the buyer’s. An order accepted after the cut-off starts counting from the next working day, so nobody is marked late for a van that had already gone.', C.blue);
note('A shipment can be recorded at any point', 'Marking an order as being picked and then ready to go is there for sellers who want it. A seller who accepts, packs and hands the parcel to a courier can record the shipment straight away — what makes an order shipped is a carrier and a tracking number, not a box being ticked first.', C.purple);
note('If a figure cannot be worked out', 'Each number on the seller’s home screen is worked out separately. If one of them fails, the screen says so instead of showing a zero — because a seller who reads "no new orders" and goes home is worse off than one who is told the figure is unavailable.', C.purple);
note('The seller’s own name over their own shop', 'The seller’s workspace is headed by their company logo and trading name, not by the marketplace’s. A business that has not uploaded a logo yet sees its own initial instead — never somebody else’s mark over its name. The logo is uploaded and replaced on the Profile screen.', C.blue);
note('A brand new seller is not shown a screen of zeroes', 'Until a business has listed something, its home screen does not draw the figures at all. It shows the three things to do first — finish the account, add the first product, get ready for orders — with how far through setting up it is underneath. Twenty numbers all reading nought say nothing, and no sales on the day somebody joined is not news.', C.teal);

h2('6a.9 Who can do what inside a seller business');
table(['Role', 'What they can do'], [
  ['Seller Owner', 'Everything, including accepting the marketplace agreements. The owner cannot be removed or have their role changed from inside the business.'],
  ['Seller Admin', 'Runs the business day to day. Cannot accept agreements on its behalf.'],
  ['Catalogue Manager', 'Listings, brands, product photographs and prices.'],
  ['Inventory Manager', 'Stock, addresses and reorder levels.'],
  ['Order Manager', 'Orders, dispatch, shipments and returns.'],
  ['Finance Viewer', 'Statements and payouts. Read-only.'],
  ['Support Member', 'Reads orders and returns to answer a buyer. Changes nothing.'],
], [2600, 7400]);
note('Nobody can promote themselves', 'A person can only give somebody else a role that carries no more than their own. Only the owner can accept agreements, and only the owner or an admin can change who is in the business. Removing somebody stops their access immediately and changes nothing about what they already did — that stays on the record with their name on it.', C.orange);

h2('6a.10 Brands');
p('A brand name belongs to the whole marketplace. Being allowed to sell under one belongs to a single business. Those are two different things and the system keeps them apart.');
bullets([
  'There is one entry per brand, however many sellers offer that manufacturer’s goods, so a buyer filtering by brand sees it once and finds everything under it.',
  'When a seller picks a brand for a listing, they see the brands their own business has been approved for, and nobody else’s. A brand approved for a competitor is not offered — a name in a list reads as permission, and permission is exactly what has not been given yet.',
  'A brand the seller has asked for and is still waiting on is shown too, so they can attach it and finish the rest of the listing while they wait. It still cannot go on sale until the answer comes.',
  'A seller who cannot find the brand they need asks for it and says why they are entitled to sell it. If the name already exists, the request attaches to the existing entry rather than creating a second one.',
  'The seller is warned about names that will be corrected — trademark symbols, words like "original" or "best" — but the request is still accepted, because a warning must never silently refuse a real business name.',
  'Staff can approve a request under a corrected spelling.',
  'The seller has their own screen listing every name they have asked for, what was decided and why — because otherwise the only sign that anything happened is a listing quietly refusing to go on sale.',
  'A request nobody has decided yet can be taken back by the seller. One that has been decided stays on the list with its reason, because that is something worth keeping rather than tidying away.',
]);
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
  'See how each of those figures compares with the period before it, and the shape of the days behind it, so a total that arrived in one afternoon does not look like a steady month.',
  'Where the period before holds nothing to compare against, the figure says so rather than showing a rise out of nothing.',
  'See where every order in the period sits, as one bar running from the earliest stage to delivered, with the exact counts listed beside it and in the table underneath.',
  'Change reporting period and refresh business totals.',
  'Open linked items from dashboard cards, order-status summaries and payment summaries.',
  'Use the notification bell for events such as staff sign-ins, customer activity, order/payment changes, certificates a seller has sent in, and operational alerts.',
]);
p('The list of screens down the side of the console also says what is waiting. Any entry with a queue behind it carries a number when there is something in it: listings sent for quality review, brands asked for, orders held for approval, sign-ups waiting to be let in, data protection requests, deliveries that have gone wrong, and seller applications together with the certificates attached to them.');
bullets([
  'The bell says what has happened lately and clears when it is read. These numbers say what is still sitting there, and only a decision clears one.',
  'A number rather than a dot, because whether it is one listing or forty decides what gets opened first.',
  'Each number is only shown to staff whose role lets them act on it. A member of staff who cannot act on something is not shown a count of it at all — not even a zero, because "none waiting" is itself a piece of information.',
]);
p('Beside the bell there is a refresh button, and the seller’s own workspace has the same one. Both screens remember what they last loaded so that moving around is instant, which is right nearly always and wrong in one everyday case: two people working the same queue, or a seller and a member of staff looking at the same decision from opposite sides. Pressing it re-reads what is on screen without losing the page position or anything half typed into it.');
page();

// 8
h1('8. Admin Features — Catalogue, Product and Compliance Management');
h2('8.1 Categories and products');
p('A new business does not start with an empty product tree. Twenty-five departments are already in place, covering the trades a general marketplace serves, each with a set of sections underneath. That is what lets a seller file a product on the first day, and it is what a shop front is built on later.');
bullets([
  'The departments are a starting point, not a rule. Staff can rename, move, archive or delete any of them, and add as many of their own as they like.',
  'A business that already has a department of its own with that name keeps it exactly as it is, together with everything filed inside it.',
  'A department switched off, renamed or reordered by staff stays that way. Reinstalling the starting data never puts the original back.',
  'A department nobody has listed anything in yet does not appear on the shop front. It is visible to a seller choosing where to file a product, and to staff, and to nobody else.',
]);
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
p('The system reads how each product is packed out of the supplier’s own wording, and reports what it could and could not understand. This is a record of what the supplier said, and staff can read it in full; it does not decide what anything is sold in. Everything is sold in the shop’s own carton of 500 — see 3.3.');
bullets([
  'Where the figures are complete and multiply out correctly, they are recorded as read.',
  'Where the sheet gives only a carton total, that total is recorded and nothing is guessed about what is inside it.',
  'Where the sheet’s own figures contradict each other, the product is flagged for somebody to check.',
  'The supplier’s original wording is always kept beside whatever was understood from it.',
  'None of these figures reach a customer page. A supplier’s “2,000 per carton” printed next to the shop’s carton of 500 would leave a buyer working out which one their order was priced at.',
]);
p('Products whose internal status on the sheet is “Hold” or “Working on it” are created unavailable to order. Licence status, production capacity, launch date and internal status are stored for staff only and never appear on a customer page.');
note('Where duplicates go', 'Supplier sheets often reuse a product code or a barcode across genuinely different items. Those are imported as separate products and listed in the report for somebody to check, never merged together.', C.purple);
h2('8.4 Placeholder prices');
p('A catalogue loaded from a supplier sheet usually arrives with no prices. Until the real figures are agreed, the system can put a placeholder on every unpriced product so the shop can be opened, shown to people and tested all the way through checkout.');
bullets([
  'A product with a placeholder behaves like any other: it can be added to a basket, bought, and put on a repeating plan.',
  'Where the supplier sheet listed its own figure, that is used. Everything else gets one flat, obviously temporary amount.',
  'Every placeholder is marked as one, and the product page in the Admin Panel says so plainly.',
  'Typing a real price clears the mark by itself — there is nothing separate to remember to untick.',
  'One command lists everything still on a placeholder, grouped by department, so the list can be worked through and only ever gets shorter.',
]);
note('Why the mark matters', 'A placeholder and a real price look identical once saved, and a customer can order at either. The mark is what makes “which of these did we make up?” a question with an answer months later.', C.purple);
h2('8.5 Grouping the catalogue under one department');
p('When a supplier sheet is loaded, every category band in it becomes a department of its own. A business that sells one kind of thing then has a shop front listing two dozen departments named after individual products, which reads as a parts list rather than a shop.');
p('Staff can choose one name for the whole catalogue and file every existing department underneath it in a single step.');
table(['What it does', 'Why it works this way'], [
  ['Creates the department under the name you give it, and moves every other department inside it.', 'Nothing is renamed, nothing is deleted, and no product moves — each one stays where it was filed, one level further in.'],
  ['The shop front then shows that one department.', 'A buyer arriving at a shop front wants to know what kind of supplier this is first, and which shelf second.'],
  ['Opening it shows every product in the catalogue, and the old departments appear on that page as their own cards above the results.', 'Nothing became harder to find. The shelves are one click in instead of being the whole front page, and they are still shown as pictures rather than buried in a list.'],
  ['Shows a full preview before anything is moved.', 'You can see exactly which departments would move, and how much is in each, before any of it happens.'],
  ['Can be run again after the next supplier sheet.', 'A new sheet introduces new departments. Running it again sweeps those in and leaves everything already inside alone.'],
]);
bullets([
  'The name is yours to choose. Nothing in the system assumes what this business sells.',
  'The number on a department card counts everything beneath it, not only what is filed directly in it, and counts only products a customer can actually open.',
  'A department a customer cannot see keeps its contents hidden with it, exactly as before.',
]);
h2('8.6 Product photographs');
p('A supplier sheet carries no photographs. The system can take your own product photography — a folder of image files — resize it for the web and put each picture on the products it actually shows.');
table(['What it does', 'Why it works this way'], [
  ['Uses only your own photographs.', 'A stock picture of another company’s product presented as yours is a false record, and on a medical device that is worse than no picture at all.'],
  ['Shows a full preview before anything is attached.', 'You can see which departments would be covered and which would be left, before any of it happens.'],
  ['Never replaces a picture somebody has uploaded.', 'Your own upload always wins. Running it again does not stack a second picture on top of the first.'],
  ['Leaves a product with no matching photograph alone.', 'A nearly-right picture is the kind of wrong nobody reports. An insulin syringe and a plain syringe look alike and are not the same product.'],
  ['Reports what is still unphotographed, by department.', 'That list is the useful part: it tells you exactly what to photograph next.'],
]);
p('Products with no photograph keep the neutral placeholder the catalogue already shows, and they still list, search and sell normally.');
h2('8.7 Product safety and legal product information');
bullets([
  'Maintain product safety information for medical-device and regulatory needs.',
  'Record manufacturer/economic operator information for EU product-safety requirements.',
  'Maintain product specifications and product documents where provided.',
  'Keep product media and product safety details available to appropriate customer-facing views.',
]);
h2('8.8 Checking what sellers want to sell');
p('Nothing a seller lists goes on sale until staff have looked at it. Submitted listings sit in a queue, oldest first, so whoever has waited longest is dealt with first. Each one shows who sent it, what it is, which brand it claims and how many problems it already has — enough to decide what to pick up next without opening anything.');
p('The decision itself is made on the listing, never from the queue, because approving something from a list is approving a product nobody has looked at. The listing screen shows exactly what the seller sent: every photograph against the slot it was asked for, every answer they typed, the price, the stock, how it is packed, and anything already flagged.');
table(['What staff can do', 'What the system does'], [
  ['Leave a note beside a single field or photograph', 'Sends that note to the seller attached to that exact field, so it appears beside it on their own screen rather than as one vague paragraph.'],
  ['Approve the listing', 'Creates the product and the seller’s offer. It does not put anything on sale — that stays the seller’s own decision, because somebody who has waited days for a check may not want it live overnight with no stock behind it.'],
  ['Send it back for changes', 'Returns it to the seller with the comment and every field note. They can fix it and send it again.'],
  ['Reject it', 'Records the reason on the seller’s screen. Nothing under that listing can be sold.'],
], [3400, 6600]);
note('Staff never edit a seller’s listing', 'They say what is wrong and send it back. Correcting somebody else’s description would leave the seller answering for words they did not write.', C.orange);
note('A refusal always carries a reason', 'Rejecting a listing or sending it back both require staff to write something, because both land on the seller’s own screen. Approving does not — the listing appearing is the message.', C.teal);
note('Nothing is decided in silence', 'Every decision — on an application, a listing or a brand — is also put in front of the seller inside their own account. An email can go unopened and a screen can go unvisited; the notice waiting for them when they next sign in does not.', C.blue);

h2('8.9 Deciding brand requests');
p('When a seller cannot find their brand while listing, the name they ask for comes to staff. It sits on its own screen, oldest request first, so whoever has waited longest is dealt with first. Nothing can be sold under a name until it is approved, so every request sitting here is at least one listing that cannot be bought.');
table(['What staff can do', 'What the system does'], [
  ['Read why the seller says they may sell the brand', 'Shows what they wrote in full, together with the manufacturer they named and a link to the website they gave.'],
  ['Approve the name', 'Adds it to the catalogue at once. Every listing that was held up behind it can then be sent for quality review. Approving does not publish anything on its own.'],
  ['Approve it under a corrected spelling', 'Adds the name as staff typed it, and keeps what the seller originally asked for on the record.'],
  ['Ask the seller for more', 'Sends the question to the seller and marks the request as waiting on them, so nobody asks the same thing twice.'],
  ['Refuse the name', 'Records the reason on the seller’s own screen. Their drafts carrying the name stay unpublishable.'],
], [3200, 6800]);
h2('6a.11 A seller’s own shop front');
p('A seller can be given a web address of their own — their name in front of the marketplace’s, such as northwind.example.com. Opening it shows their shop and nobody else’s: their products, their prices, their name at the top and their support details at the bottom. Somebody buying there is buying from them.');
table(['What a buyer sees there', 'How it differs from the marketplace’s own shop'], [
  ['Only that seller’s products', 'Anything the seller does not sell is simply not in the shop, even if the marketplace sells it. Opening a link to one says the page cannot be found.'],
  ['That seller’s prices', 'Every figure — in the list, on the product, in the basket — is the seller’s own. The marketplace’s price is never shown there.'],
  ['That seller’s name and contact details', 'The shop is branded to them, and questions go to them rather than to the marketplace.'],
  ['Category counts that match the shelf', 'A category saying four means four, not the number the marketplace as a whole has.'],
], [3200, 6800]);
note('Their own logo on it', 'A seller can upload their own mark from their profile page, and it appears at the top of their shop beside their name. Until they do, the shop shows the first letter of their name — never the marketplace’s own logo, which would tell a buyer they are somewhere they are not. Replacing one removes the old file; removing it puts the letter back.', C.blue);
note('Only real pictures are accepted', 'What a file actually is decides whether it can be used, not what it is called. A drawing format that can carry instructions is refused however it is named, because the shop serves it on the seller’s own web address to their own buyers.', C.orange);

note('The address decides the seller', 'Nothing a visitor can change decides whose shop they are in — only the web address they came to. That is what makes it impossible to be shown one seller’s price and charged another’s.', C.orange);
note('An address that belongs to nobody', 'A made-up name in front of the domain shows “no shop here” rather than quietly showing the marketplace’s own shop under somebody else’s name. A seller who has been suspended has no shop either.', C.purple);
note('Off unless it is set up', 'A business that sells everything itself never sees any of this. Seller addresses only exist once the business configures the domain they hang off.', C.teal);

note('Buying from a seller', 'Goods bought from a seller leave that seller’s own building, so the buyer is never asked to choose one of the marketplace’s warehouses for them. Checkout says who is sending the order instead, and the seller confirms the dispatch date when they accept it. A basket holding both — something from the marketplace and something from a seller — asks the warehouse question only about the part the marketplace is sending, and says plainly that the rest comes separately and may arrive on a different day.', C.blue);
note('The order follows the seller', 'On an order nobody at the marketplace packs, the buyer’s order still moves through “being prepared”, “on its way” and “delivered” as the seller works through it. It only says on its way once every seller involved has dispatched — one of three sending a parcel is not an order that has shipped. The buyer’s tracking list names who sent each parcel, so two boxes arriving on two days can be told apart.', C.teal);
note('When a seller is paid', 'An order a seller is part of is split the moment it is paid for, not when it is placed — an unpaid order is not work anybody should start. Each seller then gets their own copy of it with its own number, its own status and its own money: what the goods came to, what the marketplace kept, and what is left for them. The rate used is stored with the figure, so a statement can always be checked afterwards.', C.blue);
note('What the marketplace keeps', 'A percentage of the goods only. Never of the tax, which is money passing through the seller to a tax authority, and never of the delivery charge, which is recovery of a cost rather than earnings. A seller on an agreed rate of their own keeps it when the standard rate changes.', C.teal);
note('Where the rate is set', 'Settings carries the standard rate every seller is charged unless they have been given one of their own, and a seller’s own page carries theirs. Both are typed as a percentage. Changing either applies to orders confirmed from then on: each seller’s share of an order keeps the rate that applied when it was confirmed, so nothing already invoiced or paid can move.', C.blue);
note('“Standard” and “nothing” are different answers', 'A seller left on the standard rate follows it wherever it goes — put it up next year and they go up with it. A seller deliberately set to zero stays at zero. The screen asks which of the two is meant rather than leaving it to an empty box, and the seller is told either way, with the figure.', C.teal);
note('Paid twice, split once', 'Payment providers routinely tell a shop about the same payment more than once. A second message never creates a second copy of the order for the seller, and never a second order number on paperwork they may already have printed.', C.purple);

note('One brand, not one per seller', 'Several sellers of the same manufacturer’s goods share a single brand. The screen names the other sellers waiting on it, because approving decides the name for all of them — and refusing one seller does not clear it, since the others are still waiting.', C.orange);
note('How much a request is costing', 'Each request shows how many of that seller’s listings are held up behind the name, and the page totals them. It is the figure that says which request to pick up first.', C.blue);
note('A reason is required to refuse or to ask', 'Both land on the seller’s own screen. An approval needs none — the brand appearing is the message.', C.teal);

h2('8.10 Coupons and manufacturers');
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
h2('11.2 Companies — one business, all of its accounts');
p('The same business can reach the marketplace in three ways at once. It can buy from the shop, it can sell its own products here, and it can carry parcels for the marketplace. Each of those is a separate account, and until now nothing told staff that the three belonged together.');
p('The Companies screen groups them. Each business is one card, marked with what it does here — buys, sells, carries, or more than one of those. Opening a card shows each of its accounts with the figures that matter for it, and below them the people who work for that business. A person carries a mark for every account they belong to, so staff can see at a glance that the owner of a selling business is the same person who placed last week’s order from the buying side.');
table(['On the Companies screen', 'What staff see'], [
  ['One card per business', 'The business name, and marks saying whether it buys, sells, carries, or does more than one of those.'],
  ['Its selling account', 'How many products are on sale, how many are waiting to be checked, how many are unfinished, and how many orders it has received.'],
  ['Its buying accounts', 'How many accounts its staff hold, and how many orders they have placed between them.'],
  ['Its carrier account', 'How many parcels it is holding now, how many people it has, and the state of its contract.'],
  ['Its people', 'Each person once, with every role they hold across the business’s accounts, and whether their sign-in is active.'],
  ['How a selling business is doing', 'Products on sale, waiting to be checked, unfinished and needing changes; orders all time and over the last thirty days; how many units of stock it holds and how many products have run out; what it has sold and what is left after the marketplace’s commission.'],
  ['Where it ships from', 'Every address it sends orders from, drawn on a map and listed beside it in words, with what each one is used for.'],
  ['Buyers with no business named', 'Counted together at the foot of the page. Anybody may open an account and buy, so most of these are individuals rather than companies.'],
], [3200, 6800]);
note('Money is never added across currencies', 'A business trading in two currencies is shown two figures, not one total. Adding rupees to euros produces a number that is wrong in both.', C.blue);
note('An address nobody has placed is said so', 'A seller puts an address on the map from their own profile, with a button that looks it up. It is optional: where no map service is set up, where it does not answer in time, or where it simply finds nothing, the address is still saved and the marketplace shows it as not placed. It is never guessed at, because a guessed position is a van sent to the wrong town.', C.orange);
note('Nothing is changed from this screen', 'Companies is for looking. Approving a seller, pausing a carrier or editing a customer each happens on that account’s own screen, where the decision is recorded. Every panel on a company card is a link to the right place.', C.teal);
note('Businesses are matched by name', 'Accounts are grouped by the business name, ignoring capital letters, punctuation and the usual company endings such as Ltd, GmbH or B.V. It is a helpful suggestion rather than a legal statement: a buyer types their employer’s name themselves and is never asked for a registration number, so every account keeps its own registered name and country on screen where two similarly named businesses could be confused.', C.orange);
h2('11.3 Chat enquiries');
p('Staff can open AI/chat enquiries to understand questions that originated from the customer assistant. This creates a better support hand-off from product discovery to human help.');
h2('11.4 Reports');
bullets([
  'Run sales, stock, tax and operational reports.',
  'Export report information where the user has permission.',
  'Use dashboard and report views to spot payment, stock, schedule and order issues.',
]);
h2('11.5 Audit log and data requests');
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
  'Test a connection at any time, including one that is switched on and carrying orders. A successful test leaves it exactly as it was; only a failed test takes it out of service, so the problem is visible on the connection list.',
]);
note('Two different ERP features', 'Admin ERP is the supplier’s warehouse/business system. Customer ERP is the buyer’s own purchasing system. They are deliberately separate so ownership, credentials and support access remain clear.', C.orange);
page();

// 13
h1('12a. Logistics Features — Carriers, Consignments and Delivery Tracking');
p('This chapter is about the companies that actually carry the goods. It is an optional part of the product: a business that arranges its own delivery never switches it on, and then nothing in this chapter exists for them. A business that uses haulage companies switches it on, and each of those companies gets its own place to work.');
note('Off unless it is turned on', 'Until the business enables the logistics portal there is no carrier sign-in, no carrier can be created, and the Logistics section is absent from the admin console.', C.orange);

h2('12a.1 How a carrier gets an account');
p('No haulage company can sign itself up. Every one of them exists because somebody at the business created it and invited the person who will run it.');
table(['Step', 'What the person does', 'What the system does'], [
  ['1', 'Opens Logistics, then Carriers, and adds a haulage company.', 'Records the registered name, trading name, country, company number, contract reference and contact details, and gives the company its own short code.'],
  ['2', 'Types the name and email of the person who will run that company.', 'Emails them a link that works once and expires. No password is created, and none is sent.'],
  ['3', 'Marks the haulage company as active, once the business’s own checks are done.', 'Until this is done nobody at that company can use the portal. They can still set their password from the link; the portal then tells them the account has not been activated yet instead of letting them in.'],
  ['4', 'That person opens the link.', 'Lets them choose their own password, then walks them through setting up a second factor before they can reach any screen.'],
  ['5', 'They invite the rest of their own team.', 'Each person gets their own one-time link and their own role.'],
], [700, 4400, 5000]);
note('Nobody is ever emailed a password', 'Not a temporary one, not a first one. The only thing that goes out is a link that stops working once it has been used and again when it expires.', C.blue);
p('Creating a haulage company and signing in as one are two different things. The person who set the company up is not signed into its portal and cannot be: only somebody that company invited, using their own password, can open it. There is no way for the business to look at the portal as one of its carriers.');
p('The portal shows one haulage company at a time — the one whose account is signed in on that browser. Somebody who opens it while a different haulage company is still signed in there is told so by name, and offered two choices: carry on as that company, or sign out and use another account. It never switches quietly, and nothing typed into the address bar can make it show a company the signed-in account does not belong to.');
note('Why the portal says who is signed in', 'Because one that simply opened whichever account the browser was still holding looked, to somebody who had just created a new haulage company, exactly like the portal choosing the wrong one.', C.blue);

h2('12a.2 What each person at a carrier may do');
table(['Role', 'What it is for'], [
  ['Owner', 'Runs the company. Invites people, accepts work, sees everything the carrier is allowed to see.'],
  ['Administrator', 'The same, except changing the owner.'],
  ['Dispatcher', 'Accepts offered work, books collections, builds loads and puts drivers on them.'],
  ['Driver', 'Their own round for the day, on a phone. Status updates, proof of delivery, reporting a problem.'],
  ['Operations agent', 'Works through problems and talks to the business about them.'],
  ['Tracking only', 'Can look. Cannot change anything.'],
], [2600, 7400]);
note('Second factor is compulsory at the top', 'Owners and administrators must set up a second factor before they can do anything at all. It is offered to everybody else.', C.blue);

h2('12a.3 What a carrier can see, and what it cannot');
p('A carrier sees what it needs to move the goods and nothing beyond it.');
table(['Shown to the carrier', 'Never shown to the carrier'], [
  ['The reference, the tracking number and the current status', 'What the order was worth, and what anything in it cost'],
  ['Both addresses, and the dates that were promised', 'What the business charges, and what the seller is paid'],
  ['How many boxes, how heavy, and what kind of goods they are', 'The product names and how many of each'],
  ['Handling requirements — refrigerated, sterile, fragile, dangerous', 'Any payment detail, and any other company’s credentials'],
  ['Their own documents and their own proof of delivery', 'Anything at all belonging to a different haulage company'],
], [5000, 5000]);
note('Telephone numbers are hidden by default', 'A contact number is shown with most of it replaced. It is revealed in full to exactly two people: the driver whose round that stop is on today, and whoever is dealing with an open problem on that delivery.', C.blue);

h2('12a.4 The carrier’s own screens');
table(['Screen', 'What it is for'], [
  ['Dashboard', 'What is waiting, what is moving, what has gone wrong, and how the company is doing against the times it promised. One bar across the top of it shows how the whole workload is split between those four, so a dispatcher can see at a glance whether the day is mostly still to collect or mostly already out.'],
  ['Consignments', 'The full list, with filters, search, saved filters and a spreadsheet export of whatever is on screen.'],
  ['One consignment', 'The route, everything that has happened to it, the boxes, the contacts and the documents — and where the status is changed.'],
  ['Collections', 'What has to be picked up, and confirming that it was.'],
  ['Dispatch', 'Building a load and handing it over.'],
  ['Problems', 'What has gone wrong, and recording what was done about it.'],
  ['Companies', 'The businesses this carrier collects from and delivers to.'],
  ['Drivers and vehicles', 'Who and what is available.'],
  ['My company', 'Their own details, their people and their invitations.'],
  ['My round', 'A driver’s stops for the day, made for a phone.'],
], [2600, 7400]);
note('No pretend tracking', 'Where nothing has reported a position, the map says so plainly or shows the last place the parcel was actually seen and when. Nothing animates a van along a route it might be taking. Beside every map is the same journey written out as a list of places and times, so it can be read without seeing the map at all.', C.orange);

h2('12a.5 What the business sees');
table(['Screen', 'What it is for'], [
  ['Consignments', 'Every delivery, whoever is carrying it — including the ones nobody is carrying yet.'],
  ['One consignment', 'Offer it to a carrier, take it back, correct a status that was recorded wrongly, and read the whole history.'],
  ['Delivery problems', 'The queue across every carrier, worst first and then oldest first.'],
  ['Carriers', 'Add a haulage company, invite its first person, and see how much each one has on.'],
  ['One carrier', 'Its registration and contract, where it operates, what it is approved to carry, the delivery times it has promised, and its people.'],
  ['Carrier connections', 'Whether each haulage company’s computer system is actually connected, and what its status codes mean here.'],
], [2600, 7400]);
p('When a delivery is offered to a carrier, the system scores every candidate: does it cover both ends of the journey, is it approved for what has to be carried, does it have room, and how often does it deliver on time. The reasons are written out beside each company. A company the score rules out can still be chosen — the person arranging it sometimes knows something the score does not — but the reason is on the screen while they choose.');
note('Suspending a carrier', 'Stops any new work reaching them. Work they have already accepted stays theirs to finish; work they have not answered yet can be taken back in the same action so somebody else can be found, and the system says how much that is before it does it.', C.orange);

h2('12a.6 Approving what a carrier may carry');
p('Refrigerated goods, sterile goods and dangerous goods are only ever offered to a haulage company the business has approved for them. Approval is a decision somebody makes on the carrier’s record, with the certificate or licence number they checked and the date it runs out recorded beside it. A decision can be left as asked for, or later suspended or refused, and the haulage company reads the result in their own portal without being able to change it.');
table(['What gets approved', 'Why it matters'], [
  ['Cold chain and temperature ranges', 'A delivery that must stay between two temperatures is never offered to a company that cannot hold them.'],
  ['Sterile handling', 'Goods that must stay sterile are only offered to companies equipped for it.'],
  ['Dangerous goods', 'Carrying these is regulated, and the approval records the evidence.'],
  ['Same day, next day, international, customs clearance', 'Decides what kind of work a company is offered at all.'],
], [3600, 6400]);

h2('12a.7 The delivery promise, and what counts as proof');
p('For each carrier the business sets how many hours they have to collect and how many to deliver, how early to start warning that a delivery is going to be late, and how many delivery attempts are allowed. Every delivery is then measured against the promise that applies to it and shows as on track, at risk or missed.');
p('The same settings decide what a driver has to capture before a delivery can be marked as done: the recipient’s name, a signature, a photograph, a one-time code read out by the recipient, or the recipient’s job title. Until everything required has been captured, the driver cannot mark it delivered.');
note('Signatures are not public', 'A signature or a delivery photograph is only reachable through a link that the system issues for the person asking and that stops working after a few minutes. There is no address anybody can guess.', C.blue);

h2('12a.8 Working with a carrier’s own computer system');
p('A haulage company can be used in one of two ways, and both are complete.');
table(['Way', 'What it means'], [
  ['Their staff record it', 'The company’s own people type every status into their portal. Nothing has to be connected, and this is how the system works out of the box.'],
  ['Their system reports it', 'The haulage company’s computer system sends updates automatically, and the business only has to check they are arriving.'],
], [2800, 7200]);
note('It never claims to be connected when it is not', 'A connection with no credentials is shown as not configured, names exactly what is missing, and reports a connection test as a failure. There is no state in which a tick appears because nothing was tried.', C.orange);
p('Every haulage company has its own words for what has happened to a parcel. The business maps each of their codes onto the status it means here, once, and the system remembers. A code nobody has mapped yet is never thrown away and never guessed at: it is kept exactly as it arrived, flagged for somebody to look at, and the original is always shown beside whatever it was mapped to.');
note('The same update twice changes nothing twice', 'If a haulage company sends the same update five times, or somebody presses the same button twice, one thing is recorded. This is not a precaution bolted on afterwards; it is how the record is built.', C.blue);

h2('12a.9 Putting a status right');
p('A carrier can move a delivery forward through the stages it actually goes through, and cannot skip to the end. A carrier can never reverse a delivery that has been recorded as delivered, returned, lost or cancelled.');
p('The business can, through one route: a correction, which demands a written explanation and records it. Anybody reading that delivery months later sees that it was corrected, by whom, and why — rather than seeing a parcel that appears to have gone backwards for no reason.');

h2('12a.10 Where drivers and vehicles are');
note('Live vehicle tracking is not part of this release', 'The system does not follow vehicles in real time, and nothing in it suggests otherwise. Where a driver’s device has reported a position, the last one is shown with the time it was recorded. Positions are kept for a limited period and then deleted, only the people who need them can see them, and nothing is ever recorded outside a driver’s working hours.', C.orange);
page();

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
h2('13.3 Updates and backups');
p('New versions are installed without taking the shop offline. The new version is built and checked first, and only then are the parts serving customers replaced one at a time — each one proved working before the next is touched — so somebody browsing or checking out during an update does not notice one happening. If anything fails while the new version is being prepared, nothing is replaced at all and the shop carries on as it was. A version that turns out to be wrong can be put back to the previous one.');
p('A backup runs every night without anyone starting it. It copies the whole database, the uploaded product pictures and documents, and the system settings. Everything it writes is locked with a password before it is stored, including the copy of the database — that copy is every customer, address, order and invoice in the business, and it should not be readable by anyone who simply picks up the file. Each night’s copy is checked for the two faults that otherwise go unnoticed for months: a copy that stopped halfway, and a copy of an empty database. Two weeks of nightly copies are kept.');
p('The copy is then sent to storage somewhere else, and the system checks that it arrived rather than assuming it. A copy kept on the same machine protects against a mistake and against nothing else — not against the machine failing, and not against it being taken. If the copy cannot be sent, the night’s run reports a failure instead of quietly reporting success.');
p('Between those nightly copies the system saves its changes as they happen and sends them away every fifteen minutes. This is what decides how much work is lost in the worst case. With it, losing the machine outright costs about a quarter of an hour of orders; without it, everything taken since the previous night. A recovery can be brought forward to a chosen moment — for example, to just before a mistake was made — rather than only back to last night.');
p('Two things are still left to the operator, because only they can decide them. Where the off-site copies go — it should be a different supplier or at least a different account, since a copy the same stolen password can delete is not really a second copy. And a backup nobody has ever restored is a hope rather than a plan, so a practice restore belongs in the regular operating routine.');
h2('13.4 The system checking itself');
p('A shop can look perfectly healthy from outside while the part that does the background work has quietly stopped — and the payments for repeat orders are handled by that part. Nobody notices until a customer asks why their card was never charged.');
p('So the system checks itself every five minutes and looks at the things that cannot be seen from outside: whether each copy of the software is answering, whether the background worker is running, whether work is piling up, whether the oldest waiting task has been waiting too long, whether any task has given up after all its retries, how old the newest backup is, how much room is left on the disk, and how long the security certificate has before it expires.');
p('When something is wrong it says so, and the operator decides where that message goes — an email, a chat channel, a paging service. It also reports when a security update needs the machine restarted, so that restart is something somebody schedules rather than something that happens in the middle of a working day.');
note('What this deliberately does not replace', 'These checks run on the same machine as the shop, so the one problem they can never report is that machine being gone. A check from somewhere else on the internet is still needed, and that is the operator’s to set up.', C.blue);
h2('13.5 Notifications');
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
  'The address a request appears to come from is taken from the shop’s own front door, not from anything the caller can set — so neither the rate limits nor the lock-out after repeated failed sign-ins can be side-stepped by a caller claiming to be somebody else each time.',
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
  'The shop, the admin panel and the carrier portal are each translated into eight languages, and every page of all three changes when the reader picks a language.',
  'The language picker is on every page, including the sign-in and password pages, so somebody who cannot read the interface does not have to navigate to a settings page first.',
  'Each of the three keeps its own language choice, so choosing Greek in one does not change the other two for the same person.',
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
  ['Seller shop fronts', 'Each seller gets a web address of their own once the business configures the domain to hang them off. Without it every visitor is on the business’s own shop, exactly as before.'],
  ['Marketplace commission', 'A standard percentage set once by the business, with an agreed rate per seller where one has been negotiated. Both start at nothing, so a business that has not decided what it charges charges nothing.'],
  ['Certificates a seller must supply', 'Nothing is demanded out of the box. The business running the marketplace decides, per country and per kind of seller, which certificates and documents are required — and a step only has to be answered once something on it has been marked required.'],
  ['Opening a document nobody has checked for viruses', 'No virus checker is installed with this software, so every uploaded file says plainly that nothing has checked it. Whether staff and sellers may still open one is a setting. It is on to begin with, because somebody who cannot open a certificate cannot decide an application; turn it off once a virus checker is connected.'],
  ['Logistics partner portal', 'Turned on by the logistics feature. Gives haulage companies their own place to work and the business its own view of every delivery. Off, and none of chapter 12a exists. On, it works straight away with carriers whose staff record each status themselves; connecting a haulage company’s computer system needs that company’s own credentials, and until they are in place the system says so rather than pretending.'],
], [3500, 6500]);
note('Configuration rule', 'A feature being in the code does not mean it is always enabled in every customer installation. This guide describes the capability and clearly identifies when setup controls visibility.', C.orange);
page();

// 16
h1('16. Simple End-to-End Examples');
h2('Example A — Customer buys a product');
table(['Step', 'Customer action', 'System response'], [
  ['1', 'Opens home page and searches products.', 'Shows catalogue items available in the chosen country/currency.'],
  ['2', 'Opens a product, chooses variant and how many — cartons where the shop is selling it, pieces where an outside seller is.', 'Checks product/variant relationship and quantity rules, and shows what the choice comes to in pieces.'],
  ['3', 'Adds item to basket.', 'Works out who is selling the line first, then turns the chosen quantity into pieces — by its own carton size for the shop’s own goods, and one for one for a seller’s. Stores the basket line and recalculates server-owned totals.'],
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
h2('Example C — A delivery is given to a haulage company');
p('Only where the logistics portal is switched on.');
table(['Step', 'Who does it', 'What happens'], [
  ['1', 'The business', 'Opens the delivery and asks who could carry it. The system scores every carrier on where it operates, what it is approved to carry, how much it already has on, and how often it delivers on time.'],
  ['2', 'The business', 'Offers it to one of them. The carrier is told, and has an agreed number of hours to answer.'],
  ['3', 'The carrier', 'Accepts it. From that moment their staff can see the delivery, and nobody else’s can.'],
  ['4', 'The carrier', 'Books the collection, loads it, and puts a driver on it.'],
  ['5', 'The driver', 'Works through their round on a phone, recording each stop as it happens.'],
  ['6', 'The driver', 'Captures whatever that delivery needs as proof — a name, a signature, a photograph — and marks it delivered. Without all of it, they cannot.'],
  ['7', 'The system', 'Moves the order on, and tells the business straight away if anything went wrong instead.'],
], [700, 2300, 7000]);

h2('Example D — Staff work out who a business is');
table(['Step', 'Staff action', 'System response'], [
  ['1', 'Opens Companies and types part of the business’s name.', 'Lists every business whose name matches, whether it buys, sells, carries, or does more than one of those.'],
  ['2', 'Opens the card.', 'Shows each of that business’s accounts side by side — what it has on sale, how many of its staff buy here, how many parcels it is carrying — and the people who work for it.'],
  ['3', 'Reads the list of people.', 'Each person appears once, marked with every role they hold. The same name can be the owner of the selling side and a buyer on the buying side, and the screen says so.'],
  ['4', 'Clicks the account they need.', 'Opens that account’s own screen, where the decision can be made and recorded — the application, the carrier’s contract, or the customer’s record.'],
], [800, 4100, 5200]);

h2('Example E — Business owner supervises the platform');
bullets([
  'Reviews dashboard orders, payments, sales, low stock and upcoming recurring work.',
  'Checks reports and audit history for decisions and traceability.',
  'Manages staff accounts and roles.',
  'Maintains tax, markets, notifications, business settings and policy links.',
  'Configures payment/integration/ERP settings with controlled credentials and tests.',
]);
h2('Example F — A seller sends in a CE certificate and is approved to sell a brand');
table(['Step', 'Who acts', 'What happens'], [
  ['1', 'The seller', 'Opens the compliance step of their application, chooses "CE certificate", attaches the PDF and gives the date it runs out.'],
  ['2', 'The system', 'Checks the file really is a PDF, stores it where nobody can reach it by guessing an address, marks it "being checked", and shows the step as waiting rather than finished.'],
  ['3', 'The system', 'Tells the marketplace at once — the bell rings, and the Sellers entry in the list of screens shows one more thing waiting.'],
  ['4', 'The seller', 'Carries on. Waiting on the marketplace does not stop them sending the application in, because the marketplace looks at the documents while reviewing it.'],
  ['5', 'A member of staff', 'Opens the seller’s screen, opens the document, and accepts it. A link that works for a few minutes and once only is used to read it, and who opened it is written down.'],
  ['6', 'The system', 'Tells the seller, marks the step finished, and takes the waiting count back down.'],
  ['7', 'The seller', 'Starts a listing and looks for their brand. They have not been approved for any yet, so the list is empty and the screen says so.'],
  ['8', 'The seller', 'Asks for the brand on their product and says why they are entitled to sell it. If the name is already in the catalogue, the request attaches to the existing entry.'],
  ['9', 'A member of staff', 'Reads the reason and approves it. From then on that brand appears in this seller’s list — and only in theirs — and the listing can go on sale once it has passed quality review.'],
], [700, 2300, 7000]);

h2('Example G — A seller puts a listing on sale and a buyer finds it');
table(['Step', 'Who acts', 'What happens'], [
  ['1', 'The seller', 'Finishes a listing and sends it for quality review.'],
  ['2', 'A member of staff', 'Approves it. A catalogue entry now exists, switched off — nothing is on sale yet.'],
  ['3', 'The seller', 'Sets their price and stock and switches the listing on.'],
  ['4', 'The system', 'Puts the product on the shop’s shelf at that seller’s price, in the same moment — so it appears in its category, in search and in the filter counts straight away.'],
  ['5', 'A buyer', 'Opens that category, sees the product, and adds it to their basket.'],
  ['6', 'The system', 'Attaches that seller to the basket line, so the price shown is the price charged, the order reaches the seller who has to pack it, and the commission is worked out against the right agreement.'],
  ['7', 'The seller', 'Pauses the listing later — to restock, or because it is withdrawn.'],
  ['8', 'The system', 'Takes it out of every category at once. A buyer cannot find or order something nobody is selling.'],
], [700, 2300, 7000]);

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
