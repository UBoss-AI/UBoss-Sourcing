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
title('Glovia', 'Simple Feature Guide — Customer Storefront, Admin Console, Warehouses, Orders and Automation');
p('Prepared from the current project implementation', { align: AlignmentType.CENTER, color: C.muted, size: 11 });
p('English edition • September 2026', { align: AlignmentType.CENTER, color: C.muted, size: 10 });
children.push(new Paragraph({ text: '', spacing: { before: 300, after: 60 } }));
note('Purpose', 'This document explains, in simple English, what customers, staff and the system can do. It describes implemented features and clearly marks features that depend on configuration.', C.blue);
h2('Quick answer');
p('Glovia is a business-to-business ordering system for medical and industrial supplies. Customers browse products, build a cart, choose delivery preferences, place orders and manage their account. Staff manage products, warehouses, stock, orders, payments, customers, reports, security and integrations.');
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
h2('1.0 What the product is called');
p('The product is called Glovia, and its tagline is The Way to the World. Wherever the Glovia name appears in the top-left corner, the tagline sits directly underneath it. The name and the tagline are both written in the same flowing script lettering, so together they read as a logo rather than as ordinary text. That lettering is built into the software, so they look exactly the same on a Windows computer, a Mac, an iPhone or an Android phone, and in the shop, the admin console and the logistics portal alike.');
p('The welcome screen of the shop opens with the Glovia name in that script, the tagline The Way to the World underneath it, and below that a line that gently alternates between Source with Intelligence and Deliver with Confidence, in the customer\'s own language.');
p('UBOSS is the company behind the product. That is shown as small print: Powered by UBOSS appears once at the bottom of every shop page, and at the foot of the sign-in screens for staff and delivery companies.');
p('If your business has its own name, your shop shows your name at the top in the normal lettering, on its own. The Glovia tagline and typeface are only used when the shop is called Glovia, so the software never puts its own slogan under your name.');
p('The product used to be called UBOSS Sourcing. That name is no longer shown to anybody using the system. Apart from the small Powered by UBOSS line, no screen, message or email calls the marketplace UBOSS.');
p('The name of your own business is separate again, and it is yours. Whatever you type into Settings as your display name is what your customers see at the top of your shop, on your invoices, in your emails and on the payment screen they pay through. Glovia is the name of the software you are running; it never replaces the name of the business running it.');
p('Your name is also used wherever the system has to say who runs the marketplace. A seller choosing who handles their deliveries sees your name on the choice, for example "Self + Northwind". A delivery company is told to contact "Northwind operations". Your staff and delivery companies see your name in their authenticator app. This works in all eight languages. Records that are kept for later, such as the history of a delivery, say "Marketplace operations" instead, so they stay correct if you ever change your name.');
p('Some names inside the system were left exactly as they were on purpose: folder names, database names, addresses, file names and settings that other systems already point at. Changing those would break working connections and would change nothing anybody sees.');
h2('1.1 The four working parts');
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
  'Visitors can open the home page, catalogue, categories, search results and product pages without signing in. AI Mode opens for anybody too, but answers only account holders unless the business has chosen to let visitors ask as well.',
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
  'The system shows only markets that have real stored prices. It does not silently convert product prices at browse time, unless the business has deliberately turned that on.',
  'Changing market refreshes quoted prices and updates the current cart context so the buyer knows which market is being used.',
  'Prices are written the way the buyer’s own language writes them. A Polish reader sees “12 345,67 zł”, a German reader “1.234,50 €”. The language decides the way the number is written; the market decides which currency it is in, and the two stay separate.',
]);
note('Why real prices matter', 'A customer is shown a stored price for the selected market. This avoids showing one exchange-rate amount and charging another amount later.', C.blue);

h2('2.3a Prices in a currency nobody has typed one in');
p('A business can, if it chooses, let the shop work out a price in a currency it has not filled in by hand. It is switched off to begin with, because opening a new market is a business decision rather than something that should happen by itself.');
p('When it is switched on, the order is always the same:');
bullets([
  'A price somebody typed in for that currency is used. Always. Turning this on can never change a price a person set.',
  'Failing that, the price is worked out from the business’s own main currency at the exchange rate of the day — and it is labelled as approximate wherever the buyer sees it.',
  'Failing that, the product still is not sold in that currency, exactly as before.',
]);
p('The rates come from a published daily rate list — the European Central Bank’s, if the business chooses it. That list is published once each working day for information. It is not a bank’s rate and not what a card company will settle at, and the shop never pretends otherwise: a worked-out price is always marked as approximate, and a search engine is shown no price at all for it rather than one the shop has not committed to.');
table(['Situation', 'What the buyer sees'], [
  ['The rates are up to date', 'An approximate price, and they can buy at it.'],
  ['The rates are a few days old', 'An approximate price to look at, but the purchase is refused with a short message asking them to try again shortly or change currency. This is deliberate: a card should not be charged against a rate nobody can reconcile afterwards.'],
  ['The rate list has stopped arriving altogether', 'The product goes back to not being sold in that currency, and the business is warned well before that happens.'],
  ['The rate moves after an order is placed', 'Nothing at all. The order keeps the price, the rate and the date it was placed with, for ever. A refund is worked out from those, never from today’s rate.'],
], [3400, 6600]);
note('An order can always be explained', 'Every order that involved a conversion records the rate used, the published rate it came from, any adjustment the business applies, who published it and on what date. Months later, the arithmetic behind the total can still be shown to whoever asks.', C.blue);
page();

// 3
h1('3. Customer Features — Product Discovery and AI');
h2('3.1 Home page and catalogue');
table(['Customer action', 'What the system provides'], [
  ['Open the home page', 'The business name with a changing word beside it and a one-line introduction, a large search bar, a sideways row of department cards, latest / featured catalogue items, cart access and account access.'],
  ['Press a department card', 'A panel naming everything inside that department with a count beside each one, and a button into the department itself.'],
  ['Browse all products', 'A list of published products available for the selected market, with a row of every department across the top.'],
  ['Press a department in the row', 'That department opens as its own page, the row stays where it is with that department marked, and what is filed inside it is shown as large picture cards.'],
  ['Open a category', 'Only the products within that category, with normal catalogue tools. What is filed inside it is shown as large picture cards above the results.'],
  ['Search for a product', 'Search results for product names, identifiers and relevant catalogue content.'],
  ['Use filters and sort', 'Narrow the catalogue by the available catalogue facets and change ordering.'],
  ['Use voice search', 'Use supported browser voice input for a search query.'],
  ['Use image search', 'Upload a product image to match relevant products when the feature is available to the signed-in customer.'],
], [3500, 6800]);
p('The home page opens with the business\'s own name in large type, and beside it a single word that changes every few seconds — sourcing, then intelligence, then optimism, then innovation — so the name reads as a different phrase each time. Under it sits one short line about what the business does. If the business name already ends in one of those four words, the system does not print it twice: the name gives its last word to the changing one, so a business called \"Acme Sourcing\" opens reading exactly that and then moves on to \"Acme Intelligence\". Anyone whose computer or phone is set to reduce animation sees one word, standing still, and anyone using a screen reader hears the business name once rather than a heading that rewrites itself.');
p('The search sits on the home page as one large search bar, ready to type into. Above it is a row of three places to go — Home, which is the page the buyer is already on and is marked as such, AI Assistant, which opens the assistant page, and Products, which opens the full catalogue. Pressing any of the three goes straight there. Around the bar are the camera for searching by photograph, the microphone for speaking a search, a Search button, and the note about the assistant. Typing a few words and pressing Search — or simply pressing Enter — opens the full product list with that search already applied, so the usual filters and sorting are there to narrow it further. Leaving the box empty and pressing Search opens the whole catalogue.');

p('The departments sit on the home page as a row of large picture cards that scrolls sideways, with arrows underneath for anybody who would rather press than swipe. Each card carries a photograph of the kind of thing in that department, the department\'s name, how many products are behind it and how many shelves they are filed on. Every count is for the whole department including everything beneath it, because that is what pressing the card will show.');
p('Pressing a card opens a panel over the page listing the shelves inside that department, each with its own count, and a button into the department itself. A buyer who knows roughly what they want reaches the right shelf in two presses without reading a single price. The panel closes on the Escape key or its own close button, and it closes by itself the moment the buyer follows a link out of it.');
p('The pictures are chosen by the system from the department\'s name, not uploaded by the business, so a shop that has supplied nothing still opens looking finished. A department the system does not recognise by name is drawn instead — its own mark on a coloured panel — rather than being given a photograph of the wrong thing. The same drawing appears if a photograph cannot be fetched, so a shop on a company network with no access to the outside world keeps every card, every name and every count.');
p('Anyone whose computer or phone is set to reduce animation gets the same row without the movement. Anyone using a keyboard can reach every card, open it, read the panel and leave it again, and anyone using a screen reader hears each department named once.');
p('The top of the home page carries a moving three-dimensional graphic: a slowly turning picture of the earth, with trade routes arcing between real trading cities and a light travelling along each one, three paths circling the planet, and four cards riding around it for the four things a buyer can do beyond ordinary ordering — ask the assistant, schedule a repeat delivery, set up automatic payment, and connect their own business system. The cards are real buttons, not decoration, and each one either opens the screen behind it or explains why it cannot.');
p('The picture of the earth is supplied with the software rather than fetched from anywhere, so the home page looks the same on a company network with no access to the outside world as it does anywhere else, and nothing on the page waits for it. The whole planet is evenly lit, so no part of the mark is ever in shadow as it turns. A slower or smaller device is given a simpler version automatically, and a device that cannot show it at all is given a still drawing instead, with the same four cards. Anyone whose computer or phone is set to reduce animation sees the graphic standing still.');
p('A business that has not uploaded its own logo gets a small version of the same earth as the mark beside its name at the top of every page, turning gently. A business that has uploaded a logo sees its own logo there, unchanged. Where the small earth cannot be shown — an older browser, or a visitor who has asked for less animation — the first letter of the business name is shown in its place, exactly as before.');
p('The graphic is built to be polite about what it costs. It stops completely as soon as it is scrolled out of view or the tab is put in the background, it shows a still picture instead of moving for anyone whose device is set to reduce motion, and on a phone or a computer that would struggle with it the page falls back to a plain drawn version that looks finished in its own right. It is also downloaded separately from the rest of the shop, so a buyer who only wants to search for a product never waits for it.');
p('The product list and every department page carry a row of departments across the top, under the page title. Every department the business has is in it, each shown as a small drawing with its name underneath, and the first entry is All products. The department being read is marked with a line under it and a tinted panel behind its drawing, so a buyer always knows where they are. The row scrolls sideways: a finger swipes it, a mouse wheel moves it along, and arrows appear at whichever end still has more to show. Pressing an entry opens that department as a real page with its own web address, so a buyer can bookmark it or send it to a colleague.');
p('Departments with nothing on their shelves this week are still shown. A row that quietly dropped them would make a buyer think the business had stopped selling that kind of thing, and a business that has just installed the software would open to an empty row.');
p('Inside a department, what is filed in it is shown as large square picture cards: one card faces the buyer with its name and a button carrying the number of products behind it, and the others sit tipped back on either side. Pressing one of those brings it to the front; arrows underneath step through them and a counter says how far along the buyer is. Every shelf in the department is on it, stocked or not, and each card states its own count, so an empty shelf says so rather than hiding.');
p('Those cards move with a sideways swipe on a touchpad as well as with the arrows. Scrolling the page up or down never moves them, even when the pointer is over them, so passing the cards on the way down the page leaves them exactly as they were. Resting the pointer on a card behind the one at the front brings it half way forward, brightens its picture and outlines it, so it is clear it can be pressed.');
p('Moving to another department always starts its cards at the first one, whatever card the buyer had reached in the department before.');
p('The pictures on those cards are chosen by the system from the shelf\'s name, exactly as the home page chooses department pictures, so a business that has uploaded nothing still opens looking finished. A shelf the system does not recognise is drawn instead — its own mark on a coloured panel — rather than being given a picture of the wrong thing, and the same drawing appears if a picture cannot be fetched.');
p('Anyone whose computer or phone is set to reduce animation gets the same cards without the tipping or the sliding. Anyone using a keyboard can reach the department row and every card, and the card at the front is the only one offering a link, so tabbing through does not walk past two dozen invisible ones.');

h2('3.2 Product detail page');
bullets([
  'See product images, product name, SKU/reference, specifications and descriptions.',
  'Choose a variant where a product has more than one option.',
  'See quantity rules, including minimum order quantity and permitted quantity steps.',
  'Read product safety and medical-device information where the product requires it.',
  'View tax and market price context before adding to the cart.',
  'See the price of one piece, however the product is sold, so two suppliers can be compared without doing arithmetic.',
  'Watch the total cost change as the quantity changes.',
  'Write special instructions for this product, which travel with it all the way to whoever packs it.',
  'Press a photograph to open it full screen and make it larger.',
  'Add the item to the cart or save it for later where the relevant feature is available.',
]);
h2('3.2b What a customer reads about a product');
p('Below the price and the buttons, everything about the product is laid out in the same order on every product page, so a buyer learns where to look. A part appears only when the seller has filled it in; nothing is made up to fill a gap.');
table(['Part', 'What the customer sees'], [
  ['Product highlights', 'The handful of facts the seller marked as most important, such as the model, the capacity or the material, plus the minimum order and how many pieces are in a carton when those matter. Six show first; View all highlights shows the rest.'],
  ['Product description', 'The seller’s description, in short sections with headings and, where the seller chose one, a picture. Line breaks are kept as the seller wrote them.'],
  ['Specifications', 'The product’s facts in groups such as General, Technical specifications and Dimensions and weight, each fact on its own row with its label on the left and its value on the right. On a phone the label sits above the value. A long list shows the first eight facts; View all specifications shows the rest and Show less folds it again, without the page jumping.'],
  ['Packaging and bulk ordering', 'How the product is packed and what a carton or container holds, followed by the box sizes.'],
  ['Compliance and certifications', 'Certificates and standards the product meets, and medical-device details where they apply.'],
  ['Warranty', 'What the warranty covers, in the seller’s words.'],
  ['Manufacturer and seller information', 'Who makes it, who sells it, where it comes from, and the product-safety contact details the law asks for.'],
], [3000, 7000]);
bullets([
  'Choosing another size, colour or other option updates the facts to that option’s own, such as a bigger capacity. The previous option’s values never stay on the screen.',
  'The group headings are in the customer’s own language. The facts themselves are shown as the seller wrote them.',
  'Whatever a seller types is shown as plain text. Formatting, links and anything that could run in a browser are removed when the seller saves it.',
]);
h2('3.2c Looking at a photograph properly');
p('Pressing a product photograph opens it on its own, filling the screen. It can then be made larger with the buttons, with a scroll wheel, by double-tapping it, or with the plus and minus keys, and it can be dragged around once it is larger than the screen. Arrow keys move between a product’s photographs when it is not zoomed in, and move the picture when it is. Pressing Escape, or anywhere outside the picture, closes it again.');
p('The picture that opens is the original photograph, not a smaller copy blown up, so what is on screen is as sharp as the file that was uploaded. It stops enlarging at six times the size it starts at — far enough to read a moulded part number or a thread size off a good photograph, and short of the point where it simply looks broken.');
p('The background behind it is a pale grey rather than near-black. Most product photography is taken on white, and a white object against a very dark background reads as a silhouette with a glow around it — the eye follows the edge of the photograph instead of the thing in it, and judging a finish or a shade becomes impossible.');
p('Pressing a photograph on a card in a list does not do this. There, pressing anywhere on the card opens the product, which is what pressing a product in a shop has always meant. The larger view belongs on the product’s own page, where there is nowhere else the press could be taking anybody.');
h2('3.2d What one costs, and what the whole lot costs');
p('Under the quantity box the page states three things, and each answers a question buyers ask out loud.');
table(['What the customer sees', 'What it answers'], [
  ['Price per piece', 'What one costs, stated the same way on every product whether it is sold by the carton or one at a time. A buyer comparing two suppliers is comparing the price of one piece.'],
  ['Pieces', 'How many pieces the quantity typed comes to. Shown only where it is not simply the number already in the box.'],
  ['Total cost', 'What the goods come to, changing as the quantity changes.'],
], [3500, 6500]);
p('The total is the price of the goods and says so underneath itself, in words: before tax, before delivery, and before any discount the account carries. The final figure is worked out in the basket, and only there, because that is where tax, delivery, coupons and account terms are brought together — two places working out what an order costs eventually disagree, and the customer is the one who finds out. What this line saves the buyer is the multiplication they would otherwise do on a calculator beside the screen, and sometimes get wrong.');
p('A product whose price is agreed per account shows none of the three. There is no figure to multiply, and inventing one would quote something nobody agreed to charge.');
h2('3.2e Special instructions, for one product');
p('Every product has a Special instructions box beside its quantity, and it is optional. It is for the things a trade buyer needs to say about that particular item: the 316 grade rather than 304, mark the boxes with our order number, engrave both ends, pack these separately from the rest.');
p('An order already has a notes box for the delivery as a whole — a gate code, a time to call. That is the wrong place for an instruction about one product. On an order of nine lines from four different sellers, a note saying “the blue one” reaches every seller and identifies nothing, and the person picking the third line has no reason to read something written about the first.');
p('So the instruction travels with the line. It is kept on the basket, where it can be read back and changed right up until the order is placed, and it is frozen onto the order when the order is placed, so emptying the basket cannot take it away. From there it is shown on the customer’s own order, at the checkout review before they agree, to the warehouse on the order screen, and to the seller on the panel telling them what to send.');
bullets([
  'One box covers the whole addition, even when several sizes of the same product are added at once. A hospital buying two sizes of syringe is giving one instruction about one product; the same words go on both lines.',
  'Adding the same product again without typing anything leaves the instruction already there alone. Adding it again with something typed replaces it.',
  'In the basket, a line with no instruction offers a quiet way to add one; a line with an instruction shows the words, so nobody agrees to an order carrying something they cannot see.',
  'An instruction never changes what anything costs. It is something to be done, not something that is charged for.',
]);
h2('3.2f Telling a seller what you need, without buying anything');
p('The box above only exists once the product is in a basket, and it only reaches a seller if that basket becomes an order. Most of what a trade buyer wants to say is said before either of those. Do you do this in 8 mm? Can you supply it with a certificate? We need four hundred a month — would you hold stock? Every one of those decides whether there is an order at all, and until now there was nowhere on the product to put them.');
p('So there is an Add instructions button on the product page, in the same row as Add to cart and Set up a repeat purchase. A customer writes what they need, and whoever sells that product reads it in their own hub, whether or not the customer ever orders. Nothing has to be bought, and nothing has to be put in a basket first.');
p('It sits beside the two buying buttons rather than below them because it is another thing to do with the product, not something to do after deciding to buy. The customer reading that part of the page has the full description in front of them, and what is stopping them is usually a question — which they will only ask if asking is offered in the place where they are making the decision. It is drawn as the quietest of the three buttons, so it is plainly there without looking like a third way to buy.');
bullets([
  'A customer has one standing instruction per product. Writing again replaces what they said rather than adding another message, and clearing the box takes it back.',
  'They have to be signed in. There is no payment and no order — an account is asked for so the seller can tell whether three requests came from three businesses or from one, and so the same person cannot fill a seller’s list with anonymous messages.',
  'Somebody who is not signed in still sees the button. Pressing it takes them to sign in and then straight back to where they were.',
  'It is private. Only the customer who wrote it and the sellers who list that product can read it — it is never shown on the shop to other customers.',
  'The customer can see it again, change it, or take it away at any time, and it is included in the copy of their data they can ask for.',
]);
note('Why this is not a comment section', 'A public thread under a product is a different thing with different problems, and it is not what this is. This is one buyer telling one set of sellers what they need, in private, so the honest answer — "yes, we can do 8 mm" — comes back as a real conversation about an order rather than as a post.', C.teal);

h2('3.2a Choosing between forms of the same product');
p('Many things are sold in more than one form. A safety shoe comes in two colours and six sizes. A bag of seeds comes as a single packet or as a pack of ten. A cable comes in three thicknesses and two lengths. Each of those is a separate thing to pick, weigh and ship, with its own reference number and often its own price — so the page has to let a buyer get to the exact one they want, and stop them asking for one that does not exist.');
p('There are two ways of choosing, and the product decides which one a buyer sees. A hospital ordering syringes usually wants several sizes at once, so those products keep a list where every size can be switched on and given its own quantity. A buyer choosing a shoe wants one shoe, so those products narrow the choice down instead: pick a colour, then pick a size, with anything the business does not stock switched off as you go.');
table(['What the customer sees', 'What the customer can do'], [
  ['Buttons for each choice — colours, sizes, pack sizes — with the one they have picked named beside the heading.', 'See at a glance what they have chosen so far, without hunting for a highlighted button.'],
  ['Sizes in size order: 6, 7, 8, 9, 10. Clothing in the order a rail hangs: XS, S, M, L, XL, 2XL.', 'Read a size run the way they expect to read one.'],
  ['Three different answers, not two: available, out of stock, and not sold in this combination.', 'Tell the difference between something worth coming back for and something that will never exist.'],
  ['A line through anything they cannot pick, and words to match — never colour on its own.', 'Use the page whether or not they can tell one shade of grey from another.'],
  ['The price, the reference number, the delivery information and the photographs all change as the choice changes.', 'See exactly what they are about to buy before they buy it.'],
  ['A price range before anything is chosen, where the forms differ in price.', 'Know roughly what this will cost before working through the choices.'],
  ['The choice kept in the web address.', 'Send somebody a link to the exact black size 8, and get back to it after a refresh.'],
], [5000, 5000]);
bullets([
  'Where a product comes in only one form, no choosing is offered at all. Asking somebody to pick between one option is not a choice.',
  'Add to Cart stays available while the choice is unfinished. Pressing it says what is still missing — “Choose a size to continue” — and moves the cursor to the size buttons, rather than sitting there greyed out with no explanation.',
  'Nothing can be added to a cart unless it is a real, complete combination the business actually sells. The system checks this again on its own side, so it cannot be worked around from a browser.',
  'Where a choice depends on another — a shoe size only means something once the sizing system is known — the second choice waits until the first is made.',
  'Everything in this section is for products whose form was described by whoever listed them. Products listed without one keep the list they have always had, and nothing about them changed.',
  'Products listed the older way show it too. On those, the list of options now crosses out anything that is out of stock and says so in words, and it cannot be chosen. A product sold as a single item with none left cannot be added to a cart at all. Whether something is in stock is the only stock fact the shop states publicly - how many there are is never shown to a customer.',
]);
h2('3.2b Packs, and how many of them');
p('A “pack of ten” is one thing the warehouse picks up, weighs and sends. It has its own reference number and its own price. How many of those packs somebody wants is a separate number, typed into the quantity box — and confusing the two is how a person meaning to buy three packets is sent thirty.');
p('So the page states both, in words, before anything is added to a cart.');
table(['What the customer sees', 'What it means'], [
  ['“500 g · Pack of 10”', 'One packet holds 500 g, and ten packets are supplied together as one item.'],
  ['“Each pack contains 5000 g in total.”', 'The arithmetic, done for them rather than left to them.'],
  ['“2 packs is 20 units, 10000 g in total.”', 'What the whole line comes to, once they have said how many packs they want.'],
  ['A price per kilogram or per 100 g, where the figures allow it.', 'Compare two listings that are packed differently.'],
], [4200, 5800]);
bullets([
  'The amount a unit price is quoted against is always stated — per kilogram, or per 100 g — because the two are a factor of ten apart and a buyer comparing listings has to be able to see which is which.',
  'Where whoever listed the product did not state what is in the box, nothing is shown. A figure is never invented to fill the space.',
]);

h2('3.3 What a buyer counts in: cartons and pieces');
p('There are two ways something is sold here, and which one applies depends on the product. Some of what the shop sells goes out by the carton — a box of five hundred syringes is packed and shipped that way, so the buyer types a number of cartons and every price they have been shown is the price of one carton. Most other things are bought one at a time: a cordless drill, a laptop, a pair of boots. What an outside seller sells is always sold by the piece, at that seller’s own price for one piece.');
p('This used to be decided for the whole shop at once, and that was wrong as soon as the shop sold more than one kind of thing. Every product the business owned was treated as a carton of five hundred, so a three thousand rupee drill appeared at over sixteen lakh with “one carton has 500 pieces” printed underneath it. How many pieces are in a carton is now recorded against each product, and a product with no carton is priced, counted and sold as a single item.');
p('The buyer never has to work out which is which. Every product says it, in plain words, under its name and above its quantity box, and the price beside those words is the price of the thing named.');
table(['What the customer sees', 'What the customer can do'], [
  ['A line under every product in the list: either “One carton has 500 pieces” or “Sold by the piece”, with the matching price beside it — taken from that product, not from a single setting for the whole shop.', 'Compare prices down a page knowing exactly what each figure is the price of.'],
  ['The same sentence above the quantity box on the product page: “Ordered by the carton · one carton has 500 pieces”, or “Sold by the piece” with the seller’s smallest order and any step beside it.', 'Know what the number they are about to type is counting, and what they are allowed to type, before they type it.'],
  ['Under the price, what that price is the price of: “per carton of 500 pieces”, with the price of one piece beside it.', 'Read what a carton costs straight off the page, and check the arithmetic behind it if they want to.'],
  ['A Packaging and ordering section stating the carton, with a ready-reckoner for 1, 2, 5 and 10 cartons. On something sold one at a time the section is not shown at all unless the supplier recorded how it is packed, because a heading over “sold by the piece” repeated twice tells a buyer nothing.', 'Answer “if I order five cartons, how many is that?” without a calculator — and not be shown a conversion table, or a heading, that does not apply.'],
  ['A running line under the quantity box on a cartoned product: “That comes to 1,000 pieces.” It is not shown on something sold one at a time, where it would only repeat the number just typed.', 'See the number the warehouse will pick before committing to it.'],
  ['A Dimensions section with the box sizes as the supplier recorded them.', 'Check what will arrive against the space they have.'],
]);
bullets([
  'The cart counts cartons and prints the piece total under them, and so does a repeating plan. A line sold by the piece is counted in pieces, and the cart says so under the quantity.',
  'An order shows both: how many cartons were ordered, and the pieces those came to. The invoice names the packing in the line description, such as “Disposable Syringe 5ml (2 cartons of 500)”. A line bought by the piece is shown and invoiced in pieces, with no mention of a carton.',
  'One cart can hold both at once — cartons from the shop and pieces from two different sellers — and each line keeps its own unit, its own quantity and its own price. Nothing is converted between them.',
  'A carton is not a minimum order. Any minimum is a separate rule the business sets, and the page says so.',
  'A seller sets their own smallest order and their own step, in pieces. A buyer asking for fewer than the smallest is moved up to it, and a quantity between two steps is moved up to the next one.',
  'The price of a carton is the price of one piece multiplied by 500. The price of a piece is simply the price of a piece. Neither is a total: tax, discounts and how many were ordered are still worked out at the cart and the checkout.',
]);
note('How many is in a carton', 'It is recorded against the product, so a business that packs one line in five hundreds and another in twenties can say so, and a line it does not pack in cartons at all is simply sold one at a time. Every price, every quantity box and every page that says “one carton has 500 pieces” follows what that product says. The old single setting for the whole shop is still there as the figure used for a product whose supplier said it came in cartons without saying how many.', C.purple);
note('Why an outside seller’s goods are not sold by the carton', 'The carton belongs to the business running this shop — it is how they pack and ship their own product. An outside seller packs their own way, and their price is the price of one item. Applying the shop’s carton to their listing would have shown a ten-rupee item at five thousand rupees, and charged it. So what a line is counted in is decided by who is selling it, worked out by the system before any quantity or price is calculated, and never guessed from the name of the product or the department it sits in.', C.orange);
note('Searching by price when both appear together', 'A price range is matched on what one piece costs, for everything, so that “cheapest first” genuinely orders a page rather than putting every by-the-piece listing below every carton. The search panel says this under the boxes, because a range typed in carton money will also bring back by-the-piece listings at the matching piece price.', C.blue);
h2('3.3b Buying by the carton, the pallet or the container');
p('A hospital group buying gloves does not buy forty-eight hundred of them. They buy four pallets. Until now the only way to say so was to type 4,800 into a box meant for single items, and hope the seller worked out by hand whether that came to a whole number of pallets. Half the time it did not, and half a pallet is not something a warehouse can pick up.');
p('A seller can now say how their goods are actually packed, and the buyer chooses a package instead of a number of units. An “Order by” choice appears on the product page with only the packages that seller offers: a carton, a UK pallet, a US pallet, a shipping container, or any mixture of those.');
table(['What the customer sees', 'What it means'], [
  ['A row of choices — Carton, UK pallet, US pallet, Container — showing only what this seller offers.', 'Buy in the unit the goods actually ship in, rather than converting in their head.'],
  ['The whole breakdown, written out: “2 UK pallets × 50 cartons × 24 units = 2,400 units”.', 'Check the number they are about to be charged for, rather than trusting it.'],
  ['The price of one package, and beside it the price that works out to per unit.', 'Compare a pallet price against what they pay their current supplier per glove.'],
  ['How many complete packages are available right now, rounded down.', 'Know they can have two pallets before they try, instead of finding out at the checkout.'],
  ['The size and the loaded weight of one package.', 'Check the lorry, the door and the forklift before ordering.'],
  ['How many working days before it is ready to send.', 'A pallet is not next-day, and the page says so before the order is placed.'],
  ['Any cheaper price for taking more — “take 4 or more and the price falls”.', 'See the better price before committing, not after.'],
], [4200, 5800]);
bullets([
  'Both ways of buying stay available. A seller who ships pallets still sells a single box, and a buyer who wanted one is not turned away.',
  'Whichever package is chosen, what the warehouse picks and what the invoice counts is still the number of individual units — 2,400, not 2. The package count is shown beside it, never instead of it.',
  'Where the packaging is half set up, the choice is simply not offered. A buyer is never shown a pallet whose size nobody has stated.',
  'Where there is stock for one complete pallet and two were asked for, the page says so and names the figure: “Only 1 complete UK pallet is available right now.”',
]);
note('Why the pallet in the basket does not change', 'What goes into one pallet is frozen onto the line at the moment it is put in the basket. If the seller changes their packing next week, an order placed today keeps describing the pallet that was actually bought, and a basket still holding one is told the two no longer match rather than being quietly changed. An order from last quarter reads correctly for ever.', C.purple);
note('Pallet sizes, and what a container figure really is', 'The two pallet sizes are a floor measurement and nothing more — 1200 by 1000 mm for the UK one, and 1219 by 1016 mm (48 by 40 inches) for the US one. Everything else about the pallet is the seller’s to state, because a pallet of gauze and a pallet of saline have the floor in common and nothing else. Container figures are shown as guidance only. What fits in a container varies by the container, by the shipping line and by the age of the box, so the seller states their own figure and that is the one used.', C.blue);
note('Delivery for a pallet or a container is quoted, not priced instantly', 'A parcel company prices a box a courier can lift. A pallet goes on a lorry and a container goes on a ship, and asking a parcel company’s system to price one of those either fails — or, far worse, answers with a price for something nobody will ever come to collect. So where the delivery cannot honestly be priced on the spot, the goods can still be ordered and the delivery cost is quoted by a person before anything is despatched. The page says so plainly. No delivery price is ever invented.', C.orange);

h2('3.3a A catalogue to look at on the first day');
p('A business that has just installed this software has an empty shop. There is nothing to click, nothing to filter, nothing to put in a basket and nothing to show a colleague — which makes it hard to decide whether the software does what is wanted. So a demonstration catalogue can be planted with a single command, and it fills every department and every shelf the business has.');
table(['What is planted', 'What it looks like'], [
  ['At least three products on every shelf', 'Every department and every sub-category the business has, so no part of the shop is empty when somebody is shown around.'],
  ['Real names and real descriptions', 'An “18 V Brushless Cordless Drill Driver Kit”, not a “Sample Product 4”. A short line for the list, a longer one for the page, and a specification table.'],
  ['Proper choices, priced separately', 'The drill comes in two voltages, three battery sizes and three kit contents; each combination has its own code, its own price and its own stock, exactly as a real listing would.'],
  ['Working prices, stock and photographs', 'Everything can be filtered, searched, added to a basket and ordered, so the whole shop can be walked through end to end.'],
]);
bullets([
  'It can never touch a product somebody typed in. The system keeps a separate record of what it planted, and anything not on that record is invisible to it.',
  'Running it again changes nothing. Prices and stock are worked out from the product itself rather than picked at random, so a second run leaves the catalogue exactly as it was.',
  'Nothing in it claims anything that cannot be backed up. No certificates, no approvals, no “best seller” and no “number one” — a check refuses the whole set if any of those appear. The brands in it are invented, and no barcode or book number is ever made up.',
  'One setting takes the whole demonstration catalogue off the shop front at once, without deleting anything, for the day the business goes live with its own range. It is off by default on a live installation, and the command refuses to run there unless it is deliberately switched on.',
]);
note('About the photographs', 'With an account at the photograph service configured, the system finds a picture for each individual product and records the photographer so they can be credited. Without one it uses the pictures the software already ships with for its department headings — which are pictures of the right trade rather than of the exact product — and reports every one of them as needing a look. It never invents a picture address, and it would rather show a plain placeholder than a photograph of the wrong thing.', C.teal);

h2('3.4 AI Mode');
p('AI Mode is a full page, not a small floating chat window. A signed-in customer can ask product questions and keep a conversation history. Whether somebody without an account can ask at all is a setting, and it starts switched off — every answer costs the business money with its AI supplier, and a page anybody on the internet can open is not where that spending should begin by default. Switched on, a visitor can ask before opening an account; left off, the page invites them to sign in and keeps the question they typed so they do not lose it.');
bullets([
  'Ask questions in ordinary words, such as “what do you have in safety footwear?” or “which of these two is cheaper?”.',
  'Receive product-aware answers and product cards where results are available.',
  'Use the assistant as a discovery tool before buying.',
  'Staff can review AI-related customer enquiries in the Admin → Chat enquiries area.',
]);
p('Where a visitor without an account is allowed to ask, they get a set number of questions — five unless the business changes it — and then the page asks them to sign in or open an account before going further. The number of questions left is shown quietly under the box from the first answer onwards, so the end is in view well before it arrives rather than being sprung on them, and when they run out the conversation they have already had stays on the screen to read. Anyone who signs in carries straight on, with the question they were typing still in the box.');
p('The business sets two separate limits for visitors and wants both. One limits how fast a single visitor can ask, so nobody can run up a bill with a script; waiting a few minutes lifts it. The other limits how much of the assistant somebody gets before being asked to open an account, and waiting does not lift it. The second is a decision about when to ask for an account, not a protection against misuse — it counts within one conversation in one browser tab, so somebody determined to start again can, exactly as they can with any free preview on the web. The first limit is the one that actually bounds the spending.');
p('The assistant knows the whole shop, and it knows it as the shop is right now. Before every answer it is given a fresh description of everything on sale: each department and how much is in it, then each product with its page, its price, what that price buys, and — where an outside seller is the one selling — that seller’s name. It covers the business’s own stock and every outside seller’s listing together, because a buyer asking what is available means all of it. Nothing in the assistant is set up for one trade: a shop selling bolts and a shop selling gloves each get an assistant that describes what that shop actually has, with nothing to write and nothing to switch on.');
p('The description is rebuilt the moment anything changes. Publish a product, approve an outside seller’s listing, change a price or take something off sale, and the very next question is answered from the new position — there is no waiting period, nothing to restart, and no way for the assistant to quote a price the shop has stopped charging.');
p('It also answers the questions that are not about a product at all, and answers them from the business’s own records rather than from anything written down separately. Who the buyer is dealing with — the legal name, the registered address, the tax numbers, the support contacts and the published policies. What delivery is offered at checkout, what each option costs and what order value makes it free. Which countries the shop serves and what a buyer in each of them is quoted in, and which currencies prices are held in. Because all of that is read from the same screens the business fills in, switching a country off in the admin panel stops the assistant offering it — there is no separate list of answers to remember to update, and therefore none to go out of date.');
p('Where the business has not filled something in, the assistant is not told there is a blank. It simply does not have that fact, and says so plainly and points at the support contact — rather than offering to look it up, guessing at a format, or reassuring somebody that a number exists.');
p('Two things it will not do. It will not quote a figure the shop has not published: a product priced on application, or one whose sellers have all paused it, is described honestly and the buyer is pointed at the support contact. And it describes products rather than advising on their use — for whether something is suitable, safe or approved for a particular job, patient or site, it says the decision belongs to the qualified person responsible for it.');
p('The opening screen greets the buyer by the time of day and by their first name — “Good morning, Priya” — and asks how it can help, rather than simply saying hello. The time is read from the buyer’s own clock, so somebody ordering from another country is greeted for the day they are actually having; between ten at night and five in the morning it says a plain “Hello” instead, because a cheerful “Good evening” at three in the morning is the kind of mistake a night shift notices. A visitor without an account is greeted too, just without a name, and a name is never guessed from an email address.');
p('The assistant itself is courteous in the same way. It greets somebody who greets it, thanks somebody who thanks it, and where it cannot help it says so kindly and says who can. It still answers in a sentence or two rather than a speech — the shop’s buyers are at work — but short is not the same as curt.');
p('Under the greeting the screen shows the size of the shop and its three largest departments, with a question ready for each one. Those come from the catalogue itself, so they are true on the day they are read and change as the shop changes.');
p('When a question is sent in AI Mode, the words the buyer typed break apart and blow away out of the box, so it is obvious the question has gone. The message itself is not affected by this: if the AI supplier cannot be reached, or the sign-in has expired while the buyer was typing, the question is still in the box afterwards, ready to send again. Anyone whose computer or phone is set to reduce animation sees the box simply clear.');

note('Image search access', 'Image search is more expensive than text search because it uses an AI vision request. The storefront keeps this action behind the customer session.', C.purple);
page();

// 4
h1('4. Customer Features — Cart, Warehouse Choice and Checkout');
h2('4.1 Cart management');
bullets([
  'Add one product or multiple product variants to the cart.',
  'Increase or reduce quantity using the quantity control.',
  'Remove a line from the cart.',
  'Apply an eligible coupon code.',
  'Review product subtotal, tax, delivery context and estimated total.',
  'Move eligible items toward repeat purchase planning when recurring orders are enabled.',
  'Use the two purchase workspaces: Instant Buy cart and Schedule Cart.',
  'Change a line by the carton, with the piece total updating beside it.',
  'Add, change or remove the special instructions on any line, right up until the order is placed.',
]);
h2('4.2 Customer warehouse choice — exact behaviour');
p('Yes. Once a customer has cart items, the cart can show a “Where this can ship from” panel. It helps the buyer decide which eligible warehouse they prefer for the order.');
table(['What the customer sees', 'What the customer can do', 'What the system checks'], [
  ['Available warehouses', 'Choose a preferred shipping source based on location, delivery timing and fee information.', 'The warehouse must be active, able to operate today, in delivery range and not excluded for the customer country.'],
  ['Lead time and fee', 'Compare options such as “faster with a fee” versus “slower with a lower fee”.', 'The system only shows a promise that the business has configured; it does not invent delivery data.'],
  ['Soonest / cheapest markers', 'Quickly identify the quickest or lowest-fee offer.', 'Options are ordered by soonest delivery, but the buyer makes the final preference.'],
  ['Partial-stock warehouse', 'See that a nearby warehouse has only part of the cart.', 'The screen names shortages instead of pretending the whole cart can ship from that warehouse.'],
  ['No eligible warehouse', 'Understand that delivery is outside range or closed for the country.', 'The system does not reveal private operational reasons to the buyer.'],
], [2900, 3400, 3700]);
note('Important current behaviour', 'Choosing a warehouse records a delivery preference. The warehouse-specific delivery fee is not automatically used to recalculate the existing cart total or change fulfilment by itself. The screen makes this clear so it never promises one amount and charges another.', C.orange);
h2('4.3 Checkout');
bullets([
  'Select or add a delivery address and choose whether the billing address is the same.',
  'Choose a customer-friendly payment method, such as pay now, saved card, another card, debit card, UPI where offered, or a payment link.',
  'Review exact order totals before submitting.',
  'Where a seller has priced delivery in stages, see what delivery from that seller costs — stage by stage, or as one delivery line, as the business prefers. If a stage has no price for the chosen address, the order waits until that seller has one, rather than being charged a guess.',
  'If a delivery price changes while the buyer is checking out, the order is not placed; the buyer is shown the new figure and asked to review it.',
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
  ['Payment', 'Creates a payment step for the selected payment instrument. Card details stay with the payment provider, not the application. With Stripe, the customer pays on Stripe’s own page (see 5.1a).'],
  ['Payment confirmation', 'A verified payment-provider event/webhook confirms payment, or the system asking the payment company itself. A customer arriving back from the payment page is not treated as proof of payment.'],
  ['Handing it to a carrier', 'Once the payment is confirmed, the delivery is raised for whoever has to send it — the business for its own goods, and each outside seller for theirs — and goes into the queue waiting for a haulage company to be put on it. Only where the business uses haulage companies at all.'],
  ['Order history', 'Customer can view the order timeline, payment context, invoice context and fulfilment status.'],
], [3000, 7300]);
p('An order made up of goods from two places arrives as two deliveries, and the order page says so: each one names who sent it, who is carrying it and its tracking number. Until a haulage company has been put on a delivery the order simply does not name one yet; nothing invents a carrier.');
p('Each delivery also shows where it has got to, in plain words: waiting for the seller to confirm, awaiting a carrier, carrier assigned, pickup scheduled, picked up, in transit, out for delivery, delivered. Underneath is the list of updates written for the buyer. The buyer is not told which delivery company turned a parcel down, who the driver is, or anything the carrier writes for its own staff. The buyer is also emailed when a delivery is on its way, out for delivery and delivered.');
h2('5.1a Paying by card');
p('When the business takes cards through Stripe, a card payment company, the customer never types a card number into the shop. The payment page shows what they are paying for, and one press sends them to Stripe’s own secure payment page. Stripe then sends them back to the shop.');
table(['Step', 'What the customer does', 'What the system does back'], [
  ['1', 'Opens the payment page for their order.', 'Shows the order number, how many items, the subtotal, any discount, delivery, tax, the amount due and the currency it will be charged in, and the billing address. The amount comes from the order that was placed. Nothing on this page can change it.'],
  ['2', 'Presses “Pay securely now”.', 'The button greys out at once and says “Opening secure payment…”, so pressing twice cannot start two payments. The same goods stay set aside for the customer while they pay.'],
  ['3', 'Pays on Stripe’s page.', 'Stripe’s page shows the business’s name and the one amount due. The customer types a card, or picks a card they saved before. If their bank wants an extra security check, it happens there.'],
  ['4', 'Comes back to the shop.', 'A page says “Confirming payment…” and waits until the shop has heard from Stripe. Coming back is not taken as proof of payment.'],
  ['5', 'Sees the answer.', '“Payment successful”, with the order number, the amount, when it was paid and the card used, such as “Visa ending in 4242”, and buttons to view the order or keep shopping. Or a clear reason if it did not go through, with a button to try again on the same order.'],
], [800, 3000, 6500]);
bullets([
  'The order is placed once. Trying again, from the same tab, a second tab or after a failed card, always pays for that same order and never makes a second one.',
  'If the customer presses Cancel on Stripe’s page, they come back to “Payment cancelled — nothing was charged”, and the order waits to be paid. Stripe’s page is closed behind them, so a tab left open cannot take money later.',
  'If the answer is slow, the page says so after a minute and offers “Check again”, which asks Stripe directly. It never starts a new payment.',
  'Some bank payments take time to settle. The page then says “Payment processing”, and the order is confirmed when the money arrives.',
  'If the goods were no longer available when the customer pressed Pay, the payment page refuses rather than taking money for goods that are not there.',
]);
note('Saving a card for next time', 'Stripe’s page has its own box for saving the card. It is never ticked for the customer. A card saved this way is offered again the next time they pay, on Stripe’s page, and they can still choose a different card. It is only ever used when the customer is there and paying themselves. Automatic payments for repeat orders need their own separate permission, given on the AutoPay page, and saving a card at checkout does not give it.', C.purple);
p('The business collects every card payment into its own single account. Paying part of each payment straight on to outside sellers is not built. For a business registered in India, Stripe does not offer the kind of account that would split payments between sellers.');
h2('5.1b A record of exactly what was bought');
p('The moment an order is created, the system keeps a copy of how each product was described at that moment: its description, its specifications (with the chosen size’s or colour’s own values), how it was packed, the minimum order, how many pieces fit in a carton or a container, the options chosen and any special instructions. That copy never changes. If the seller later edits the listing, takes it off sale or removes it, the order still says exactly what the customer bought.');
p('The customer can open this record on their own order page, under Ordered product information.');
h2('5.2 Order life cycle');
p('The normal order path is Draft → Pending Approval or Pending Payment → Confirmed → Processing → Shipped → Delivered. Cancellation, return and refund are controlled transitions with history and reason rules.');
h2('5.3 Buy Later and Subscribe & Reorder');
table(['Option', 'What the customer can do', 'Result'], [
  ['Buy Now', 'Pay for the cart now.', 'Creates a normal order.'],
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

h2('5.4 Preorder: asking a seller to make a large quantity');
p('Add to Cart buys what is on the shelf. Buy Later and Subscribe & Reorder buy it later, or again. Preorder is for something different: a quantity so large that the seller has to make it — forty thousand gloves for December, twelve pallets for a new clinic. It asks the seller whether they can, by when, and at what price, and nothing is ordered until both sides agree.');
table(['Step', 'What the customer does', 'What the system does back'], [
  ['1', 'Presses Preorder on the product page, beside Add to Cart.', 'The first time, it first shows a short note: preorder is for large quantities, this product’s minimum, that the seller confirms quantity, price and date, and that nothing is charged yet. The customer ticks “I understand the minimum quantity and preorder process.” and presses Agree and continue. After that it goes straight to the request form, already filled in with the quantity the customer typed on the product page (raised to the seller’s minimum or next allowed step if needed). If the customer is not signed in, it signs them in first and brings them straight back to the same product and option, with the form open.'],
  ['2', 'Chooses how many (in pieces, cartons, pallets or containers), where it goes, and the date they need it by.', 'Shows the number of pieces, the seller’s minimum and step, the earliest date that can be asked for, the price per piece from the seller’s own price bands, and an estimated total. The figures come from the system, not from the page.'],
  ['3', 'Adds a purchase order number and any notes, ticks the box to say they understand this is a request, and sends it.', 'Sends the request to the seller and emails the customer a copy. Nothing is charged and no stock is set aside.'],
  ['4', 'Waits for the seller’s answer, which arrives by email and in My preorders.', 'Shows the seller’s terms in full: pieces, price per piece, delivery charge, the date the seller commits to, and any split into several deliveries.'],
  ['5', 'Confirms those terms, or declines and asks the seller to look again, or cancels.', 'Confirming creates one order waiting for payment and holds the seller’s capacity for that period. Declining sends it back to the seller.'],
  ['6', 'Pays for the order in the usual way.', 'Confirms the preorder only when the payment provider confirms the payment, and tells the seller to start.'],
  ['7', 'Follows progress: production started, ready for dispatch, then the delivery on the order.', 'Warns both sides if the committed date is close and the goods are not ready.'],
], [700, 4000, 5300]);
bullets([
  'Every product can be preordered. Where the seller has not set their own preorder terms, standard terms apply: a minimum of 1,000 pieces (the business can change this figure, and a product that already needs more keeps its own), the product’s own price, and the seller still answers every request. Products the shop sells itself are preordered from the shop, and the shop’s staff answer.',
  'A small round “i” button sits inside the right end of the Preorder button. Pressing it shows the same note at any time: the minimum for this product, in the unit the seller set it in, and how a preorder works. On a computer it opens next to the button; on a phone it slides up from the bottom of the screen.',
  'When the customer raises the quantity on the product page to the preorder minimum, the page asks once, “Ordering in bulk?”, and offers Start preorder. Continue with regular order is offered too, but only where the product can be bought in the basket at that quantity. It does not keep asking as the number goes up, and it asks again only in a new visit or if the minimum changes. If another window is already open, such as the bulk offers, it waits until that one is closed.',
  'The customer confirms the note once. The system remembers it for their account, so they are not asked every time. If the business changes how preorders work, it can ask every customer to read the note again. Confirming the note only says the customer has read it: it does not accept any terms, does not place an order and does not charge anything. A request cannot be sent without it.',
  'A seller can switch preorders off for a listing; the button then stays visible and greyed out, and says why. The business can also limit preorders to listings whose seller has set terms.',
  'Preorders are for business accounts. An account without a company name is told so, with a link to add one.',
  'A request is refused with a specific reason the customer can act on: “Minimum preorder quantity is 1,000 pieces.”, “Preorders must be placed in multiples of 100 pieces.”, “The earliest available delivery date is 15 December 2026.”',
  'The earliest date is the latest of three things: the shop’s usual notice (normally seven days, and never today), the seller’s production time, and the time to get the goods to that address. It is worked out on the customer’s own calendar.',
  'If the seller changes their terms while the customer is looking at them, pressing Confirm is refused and the new terms are shown. A customer can only ever agree to terms they have actually seen.',
  'A request nobody answers in time expires, and the customer is told. An agreed preorder that is not paid for in time is cancelled, and the seller’s capacity is released.',
]);
h3('Ordering by the container');
p('A customer who ships by sea can ask for whole containers instead of counting pieces. In the preorder form, “Order in” offers Pieces, 20-ft Container and 40-ft Container, and then any cartons or pallets the seller already offers.');
bullets([
  'Choosing a container changes the box to “Number of containers”, which takes whole numbers only. The form then says what that means in pieces, for example “1 × 20-ft Container = 12,000 pieces” and “2 × 20-ft Container = 24,000 pieces in total”.',
  'The number of pieces in a container is the seller’s own figure for that exact version of the product, which the seller has checked. A different size or pack has its own figure, and changing the version on the page updates it.',
  'The summary shows the number of containers, the pieces in each, the total pieces, the price per piece, the product subtotal and an estimated total. Delivery says “To be confirmed”: the seller quotes it in their answer.',
  'If the seller has not given a checked figure for a container size, that size is shown greyed out as “not available”, and the form says why. Pieces can still be ordered. The customer is never shown a guess.',
  'Containers are not offered on products the shop sells itself.',
  'The system works out every figure itself from the number of containers the customer chose. A later change by the seller does not change a request that was already sent.',
]);
h3('When the customer asks for more than the seller has');
p('Sometimes a customer asks for 40,000 pieces and the seller has 15,000 ready today. The system works out how many the seller could send now, and tells the customer honestly.');
table(['Step', 'What the customer does', 'What the system does back'], [
  ['1', 'Sends a preorder for more than the seller has ready.', 'Says “The complete requested quantity is not currently available.”, with how many were asked for, how many are available for a first delivery, and how many remain. It says the seller will propose a later date or a split delivery. Nothing is set aside yet.'],
  ['2', 'Waits for the seller’s proposal, which arrives by email.', 'Shows the proposal in full: the delivery dates and how many pieces come on each, the same in containers, the price, tax, delivery, the total, when the offer expires and the seller’s note.'],
  ['3', 'Presses Accept offer, Reject offer, or Request a change with a message.', 'Accept checks everything again and, if the stock is still there, sets it aside for this customer and creates the order waiting for payment. Reject ends the preorder. Request a change sends the message back to the seller, who can make a new proposal; every earlier proposal is kept.'],
  ['4', 'Pays for the order in the usual way.', 'Nothing is charged before this point.'],
], [700, 4000, 5300]);
bullets([
  'If the stock has gone by the time the customer accepts — another buyer took it, for example — nothing is set aside and nothing is charged. The customer is told “Stock changed; seller revision required”, and the seller is asked to make a new proposal. The page also warns the customer before they press Accept if it can already see the stock has gone.',
  'Two customers accepting against the same stock at the same moment cannot both get it.',
  'An offer that has expired cannot be accepted.',
  'The customer never sees which warehouse the stock is in.',
  'Anything set aside for the customer is given back if the preorder is cancelled, expires or is rejected, or if its order is cancelled.',
]);
h2('5.4b Asking the team about a preorder');
p('Right beside the Preorder button on every product page there is a small chat icon: a pair of speech bubbles, the same height as Preorder. Pointing at it, or moving to it with the keyboard, shows a short hint that names the business running the marketplace — for example “Ask Northwind about this preorder”. Screen readers call it “Chat with Northwind”. On a phone a single tap opens the chat. It lets a customer ask that business’s own team a question before they decide: how many fit in a container, whether a date is possible, what a bulk price might be. The seller of the product is not part of this conversation and does not see it.');
table(['Step', 'What the customer does', 'What the system does back'], [
  ['1', 'Presses the chat icon beside Preorder.', 'Opens a chat panel on the right of the screen (the whole screen on a phone). At the top it shows the product: its picture, name, seller, code, option and minimum preorder quantity. A customer who is not signed in can still read the automatic answers described below; to write to the team or ask for a person, they are asked to sign in and are brought straight back to the same product with the chat open.'],
  ['2', 'Says what they need: pieces, a 20-ft container or a 40-ft container, how many, and a date if they have one.', 'Shows how many pieces that comes to, using the seller’s own checked figures for a container. Nothing is saved yet — simply opening the chat does not start a conversation.'],
  ['3', 'Writes a message and presses Enter or the round blue Send button with the arrow. Shift+Enter starts a new line; on a phone, Enter starts a new line and the Send button sends.', 'Sends it only once, however the key is pressed. The button stays grey while the box is empty, shows a small spinner while the message is on its way, and a red mark if it could not be sent — the words stay, with Retry. Saves the message, starts the conversation and sends it straight to the team, together with any automatic answers the customer read first. The message shows Sent, then Delivered, then Read.'],
  ['4', 'Waits for the reply, with the chat open or closed.', 'Shows the reply the moment the team sends it. If the customer has closed the page, it sends an email a few minutes later saying a reply is waiting — the email never contains the reply itself.'],
  ['5', 'Reads a proposal the team sends, if they reach an agreement.', 'Shows a card with the quantity, pieces, an estimated price, a date and how long the proposal is open. Review proposal opens the normal preorder form already filled in; the customer checks it and sends the preorder request themselves.'],
], [700, 4000, 5300]);
bullets([
  'When the team has replied and the customer has not read it yet, a small red number sits on the chat icon. It counts only the replies about that product. It updates by itself every minute, and as soon as the customer reads the replies. A customer who is not signed in sees no number.',
  'The chat says honestly whether somebody from the team is online right now, and shows the business’s usual response time.',
  'A short safety note asks the customer to keep product and preorder talk inside the marketplace, for their security and a correct order record, and never to share passwords, one-time codes, card details, bank logins or access keys in the chat.',
  'Nothing typed in the chat is an order or a promise. Writing “yes” does not accept anything. Only a preorder request, answered by the supplier and confirmed by the customer, commits anybody.',
  'Asking about the same product again continues the same conversation. When the team marks a conversation as answered, writing again reopens it. A closed conversation can still be read, and a new question starts a new one.',
  'All of a customer’s conversations are under Account → Messages, with a count of unread replies. The list sits beside the open conversation, which says clearly that the customer is talking to the marketplace’s team — the seller is named only as the maker of the product. A strip under the heading shows the product, what was asked for and the latest proposal, marked as a record of the request and never as a price quote. The screen fits the window: only the messages scroll, and the box to write in always stays in view, even above a phone’s keyboard.',
  'The conversation opens at the first unread reply. While the customer reads older messages, a new reply does not pull them away; a “new messages” button appears instead.',
  'If the connection drops, the chat says so, keeps what the customer was typing, reconnects by itself and fetches anything it missed. A message that did not send can be sent again without it arriving twice.',
  'Where the business allows it, the customer can attach a PDF or a picture. Each file is checked for viruses before it is kept, and only the people in the conversation can open it.',
]);

h3('Automatic answers, and asking for a person');
p('Before anyone writes, the chat shows the marketplace’s preorder assistant. It is clearly marked “Automated” and never pretends to be a person. It greets a signed-in customer by first name, names the product, and lists twelve common questions as a card of rows the customer can tap: the minimum quantity, bulk prices, how many pieces fit in a 20-ft or a 40-ft container, whether the quantity they want is in stock, what happens when stock is short, the delivery date, delivery in several shipments, customisation, payment, how delivery and tracking work, and changing or cancelling. Six show at first; View all questions shows the rest.');
table(['What the customer does', 'What the system does back'], [
  ['Taps a question.', 'Answers it straight away from this product’s own information: the seller’s preorder terms, the container loading the seller has checked, the stock on the listing and the dates the preorder form would allow. Prices are called estimates, and stock is never promised.'],
  ['Asks something the product’s information does not cover.', 'Says honestly that the preorder team needs to confirm it, marks the answer “Needs confirmation” and offers a person. It never makes up a quantity, price, date or promise.'],
  ['Answers “Was this helpful?” with Yes, or picks Ask another question.', 'Thanks them, or shows the questions again.'],
  ['Presses Connect with a human agent — after an answer, or at any time from the top of the chat.', 'Asks a guest to sign in first and keeps their answers. Then opens the conversation for this product (or continues the one they already have), puts the questions and answers they read into it, and tells the team. The customer is told the request has been sent and that a person will reply here as soon as possible — it never claims someone is online.'],
  ['Waits.', 'When a member of the team replies, the chat shows “A member of the team has joined the conversation” and the conversation carries on as usual.'],
], [4000, 6000]);
bullets([
  'Closing and reopening the chat does not start the greeting again: the answers already read are still there.',
  'The questions, their order and which ones always need a person are one list the business can change, and each answer is recorded with the version of the rules that produced it.',
]);
h2('5.4a Paying less per piece for more');
p('Many sellers charge less per piece when a customer buys more — for example 10.00 each, 9.50 each from 100 pieces, 9.20 each from 500. The product page shows this as the customer chooses a quantity, and the basket charges it.');
bullets([
  'Under the quantity box, a small card says how many more pieces reach the next price (“Add 20 more pieces to pay 9.20 each”), and how much the chosen quantity already saves. One press sets the quantity to reach it.',
  'The card also shows what one piece costs if bought loose, by the carton, by the pallet or by the container, so the customer can see which is cheaper without doing the sums.',
  'If the customer asks for more than the seller has in stock, the card says so and offers a preorder instead.',
  'The price the card shows is exactly the price the basket and the order charge. The basket line says which price applied and how many more pieces would reach the next one.',
  'Some prices are only for business accounts, only for deliveries to certain countries, or only for a limited time. A customer only sees the prices that apply to them.',
  'A price shown in another currency is marked as approximate; the customer pays in the seller’s currency.',
  'Every time the customer raises the quantity, a small spinning galaxy appears under the quantity box for about a second while the new price is worked out, then turns into the card: the saving if there is one, or otherwise the price per piece and the total, with a note that this product has no bulk discount yet. Lowering the quantity goes straight to the figures.',
  'The store’s own products get the same card once the store turns on quantity discounts (see “Quantity discounts” in the admin section). Raising the quantity on any of them then says, for example, “Add 6 more pieces to pay 97.00 each, saving 3.00 per piece”, and the basket charges that price.',
  'The card can be hidden, and stays hidden for that product until the customer closes the browser tab. It moves gently into view, and nothing moves at all for people who have asked their device to reduce motion.',
]);
h3('Seeing every bulk offer at once');
p('The small card shows one price at a time. A buyer comparing prices wants to see them all together, so when a product has real bulk prices a link appears under the quantity box: “View all bulk offers”, with how many there are.');
table(['Step', 'What the customer does', 'What the system does back'], [
  ['1', 'Presses “View all bulk offers”, or raises the quantity on a product that has bulk prices.', 'Opens a “Bulk offers” window with every price side by side. Each one says “Buy N or more”, the price per piece next to the usual price crossed out, the saving per piece and in per cent, the total for that many pieces and the total saving, whether it is available from stock, and when the offer ends.'],
  ['2', 'Reads the labels.', 'Marks the price that applies to the quantity chosen now (“Your quantity”), the next price that would lower the cost (“Next saving”), the cheapest per piece (“Best value”) and prices only for business accounts. A line says how many more pieces reach the next price. Prices kept only for preorders are listed separately.'],
  ['3', 'Presses “Select N” on one of them.', 'Sets the quantity to that number, closes the window and shows the new price.'],
], [700, 4000, 5300]);
bullets([
  'Only real offers are shown. A price that is not lower than the usual price is never presented as an offer. A customer only sees the prices that apply to them, exactly as the basket would.',
  'The window opens by itself only the first time the customer raises the quantity on that product, in that visit. If they close it without choosing, it does not open by itself again for that product in that visit. The link always opens it. It opens again by itself only if the prices on offer change, for example when another version of the product is chosen.',
  'Nothing is held or promised by the window. The basket and checkout work out every price again.',
  'The offers slide in one after another and lift slightly under the mouse. For people who have asked their device to reduce motion, they simply appear. The window works fully with the keyboard and with screen readers, and it is in all eight languages.',
]);
h3('Asking for more than is in stock');
p('Where the seller takes preorders, raising the quantity past what is in stock opens a short message: “More than is in stock”. It shows how many were asked for, how many are available now, how many are short, and the seller’s smallest preorder.');
bullets([
  'Continue with preorder takes the customer into the normal preorder steps: the short note first if they have not read it yet, then the request form, already filled in with the quantity and version they chose.',
  'Change quantity closes the message and puts the customer back in the quantity box.',
  'It works the same however the quantity is changed: the plus and minus buttons, typing, pasting, the arrow keys, or picking a bulk offer.',
  'While the customer is typing, the system waits. The quantity counts when they press Enter, click away, or stop typing for a moment. So typing 1000 when 500 are in stock is judged once, on 1000, and not on 1, 10 and 100 along the way.',
  'It appears only at the moment the quantity goes past the stock, not on every change after that. If the customer comes back down to the stock or below and then goes over again, it appears again. Asking for exactly what is in stock is fine.',
  'Choosing another version of the product checks the quantity again against that version’s stock.',
  'Only one window is ever open at a time. If the customer picks a bulk offer that is larger than the stock, the offers window closes first, then this message opens. A message about the stock always comes before the bulk offers, and it replaces the “Ordering in bulk?” message, because it shows the smallest preorder too.',
  'The message only helps the customer decide. When anything is sent, the system checks the stock and every preorder and basket rule again.',
]);
h3('Typing a quantity safely');
p('Every quantity box in the shop, the basket included, accepts only whole pieces: 1 or more, up to 100,000,000.');
bullets([
  'A number pasted in is read the way the customer’s language writes numbers. “1.000” means a thousand in German and one in English.',
  'Anything else is refused, with a short message under the box in the customer’s language: a negative number, zero, a part of a piece, letters or symbols, or a number that is too large.',
  'If the customer clicks away while the box holds something it cannot accept, the last good quantity comes back. Nothing wrong is ever sent or priced.',
]);

h2('5.5 Invoices from the seller');
p('On the marketplace, each seller sells their own goods, so each seller gives the customer their own tax invoice. It appears on the order page, under Invoices, as soon as the seller packs the goods.');
bullets([
  'The customer can download each invoice as a PDF. The download link works once and only for the person who asked for it.',
  'An order sent in two loads has two invoices, and together they add up to exactly what the customer paid.',
  'If an order is cancelled, returned or refunded after the invoice was issued, the seller issues a credit note. The customer sees both: the original invoice, marked as cancelled, and the credit note.',
  'The customer does not see the packing list — that is for the delivery company. They see how many packages to expect.',
]);
h3('Checking that a document is genuine');
p('Every invoice and packing list has a QR code. Anyone holding the paper — a receiving clerk, a customs officer, a driver — can scan it and see who issued it, when, and whether it still stands. The check shows nothing about the customer or the price.');
p('This is a check for this marketplace’s own documents. It is not the government’s e-invoice system, and the document says so.');

note('Nothing is charged until the customer says yes', 'A seller accepting a preorder is an offer, not a sale. The customer is charged only after they have confirmed the seller’s terms and paid for the order — and the order is confirmed only when the payment provider says the payment went through, never because a page was reached.', C.orange);
page();

// 6
h1('6. Customer Features — Self-Service Account Area');
h2('6.0 The dashboard');
p('Opening the account area lands on a dashboard. It answers the question a buyer has not yet thought to ask: is anything waiting on me? It answers it as a picture, and there is nothing underneath it: one ring, and beside it a short written summary of what the ring shows.');
bullets([
  'A ring shows every order placed in the chosen period, split into five groups: waiting on you, being prepared, on the way, delivered, and cancelled or returned.',
  'Choosing a group singles it out. The screen says which group it is showing and offers a way back, and the written summary beside the ring is then about that group rather than the whole period. Choosing it again clears it, and there is a button to clear it as well.',
  'The exact counts and percentages are listed beside the ring, and “View as a table” shows the same figures as a table, so nothing can only be read by looking at the picture.',
  'The period can be today, the last seven days, the last thirty days, or any two dates the buyer picks.',
  'The period and the chosen group are both part of the web address, so a buyer can send a colleague exactly the view they are looking at, and going back returns to it.',
]);
p('There are no tiles and no lists under the ring. Spend against the period before, what is promised in the next seven days, repeat orders that cannot run without the cardholder, orders waiting for payment or an approval, and whether the buyer’s own business system is still exchanging messages were all shown here once, and each of them belongs to a screen of its own: My orders, Payments, Scheduled orders, ERP connections. A shorter copy of a screen is a copy that goes out of date.');
p('None of that information became unavailable. The dashboard still fetches all of it, and the written summary beside the ring is worked out from the whole of it — so it can still say that three orders are waiting for payment, or that a repeat order needs a card, even though no tile shows it. Orders waiting for payment or an approval are counted however old they are, not only the ones inside the chosen period, because an unpaid order from six weeks ago needs more attention than one from this morning.');
h2('6.1 Profile and company');
table(['Account page', 'What the customer can do'], [
  ['Profile', 'Edit personal details in separate panels, change password, view purchasing limits, request contact changes, view own data and deactivate/close account.'],
  ['Company', 'Maintain company name, department and delivery contact number.'],
  ['Addresses', 'Add, edit, select default and archive shipping/billing addresses.'],
  ['Region', 'Choose language, country and currency together.'],
  ['Payment methods', 'Manage saved cards where payment provider features are enabled. A card saved on Stripe’s payment page is marked “Checkout only”. A card that AutoPay is using cannot be removed until AutoPay stops using it; the page says why.'],
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
p('A customer can connect its own purchasing or business system to Glovia through Account → Integrations → ERP. This is separate from the supplier/admin ERP connection.');
p('The setup runs as six short steps. Each one opens at the top of the page when the previous is finished, so a long step never leaves the next question somewhere above the screen.');
bullets([
  'Use a guided setup flow for supported named systems or a documented API.',
  'Configure connection details, mapping, health checks, activity logs and approvals.',
  'Keep customer-supplied credentials encrypted and protected.',
  'The application rejects unsafe outbound destinations in normal production configuration.',
]);
p('Some systems ask the customer to sign in rather than to type a password into Glovia. For those, the connection screen shows a Connect button. The customer presses it, is taken to their own system, signs in there, and approves the list of permissions being asked for. Their system then sends them back to UBOSS, the connection is ready to test, and UBOSS is told which permissions were actually granted — so a customer whose administrator allowed less than was asked for is told straight away rather than at the first order that quietly fails.');
p('A customer who changes their mind and cancels on that screen is told nothing was connected, and can start again whenever they are ready. The same button later reads Sign in again, for when their system’s access is withdrawn or expires.');
p('A connection does not have to send anything. A customer whose own system is a product or price list, rather than a purchasing system, can switch every outgoing item off and use the connection only to read from their system. When they do, UBOSS asks them to match up only the information that connection actually uses — it does not ask a customer to describe a purchase order they have said they will never send.');
p('A Product matching screen answers the question customers ask first: do both systems hold the same products? Pressing Check now reads the full product list from their system and compares it with their catalogue in UBOSS. It changes nothing — it only looks. The answer is three counts: products found in both systems, products their system has that are not sold here, and products here that their system has never mentioned. That last group is the one worth acting on, because UBOSS will never receive figures for them.');
p('Products are matched on the product code, exactly as written on each side. Where nothing matches at all, the screen says so in plain words and explains the usual reason: the two systems use different codes for the same item.');
p('When that happens, and it is common, the same screen is where the customer fixes it. They can tell Glovia which product in this catalogue each of their own codes means. Rather than pairing them one at a time, they paste two columns straight out of a spreadsheet — their code, then the code used here — separated by a comma, semicolon or tab, so a file exported by any spreadsheet is accepted as it is. A heading row is ignored.');
p('Any line that names a product this catalogue does not have is reported back with its line number and the reason, and everything else is still saved. A long list will usually contain a few codes that have since been retired, and refusing the whole file because of three of them would leave the customer with nothing.');
p('Once a code is paired, every sync from then on uses that pairing, and the matching screen counts that product as found in both systems. A pairing the customer has made is always preferred over two codes that merely happen to look the same. Nothing is ever guessed: UBOSS will not decide that two codes probably mean the same product, because a wrong pairing quietly attaches real stock figures to the wrong item and is believed for months.');
p('When a connection reads a list from the customer’s system, the activity record reports how many records were read and how many were recorded against products in Glovia. A record that matches nothing here is counted as read but not recorded, so the two numbers together say plainly how much of their list UBOSS recognised.');
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
  ['4', 'Works through the application.', 'Saves each step on its own, and keeps every word typed even before that, so the person can stop and come back for as long as it takes to gather documents.'],
  ['5', 'Sends the application for review.', 'Refuses to send it while a required step is unfinished, and names each one that is.'],
], [700, 4400, 5000]);

note('The Seller Hub has its own password', 'Buying and selling share one account, and the selling side has a second password of its own, chosen the first time the Hub is opened. It has to be different from the shop password. Entering it is remembered for that browser only, so signing in on a new machine asks again, and changing it closes the Hub on every other machine while leaving the shop signed in. A button in the Hub closes it without signing out of the shop, for anybody handing their computer to somebody else.', C.blue);
note('An open Seller Hub closes itself when nobody uses it', 'If nobody has done anything in the Seller Hub for an hour, it closes and asks for the Seller Hub password again. Doing something means clicking, typing, saving or opening a page. A tab left in the background, or the mouse moving over the screen, does not count. Five minutes before the end, the Hub asks "Are you still there?" and counts down. Stay signed in keeps it open for another hour. Sign out closes the Hub straight away. If the time runs out, the Hub shows a message that the session expired and asks for the password again; anything typed but not saved on that page is lost. Only the Hub closes: the person stays signed in to the shop, with their basket and orders. Several open tabs agree with each other, so one tab never warns about a Hub another tab is still using. The business running the marketplace can change the hour and the five minutes. The Hub also no longer closes by itself several times an hour while somebody is working in it, which it used to do.', C.blue);

h2('6a.2 What the application asks for');
p('There are eight steps. What each one demands depends on the country the business is registered in and on whether it manufactures, distributes, wholesales or resells — so a German seller is asked for a VAT number, an Indian seller for a GSTIN, an Australian seller for an ABN, and a distributor for written authorisation from the manufacturer instead of a declaration it cannot sign.');
p('Tax numbers are asked for by the name they are known by in the seller’s own country. There is a name and a format for India, the United Kingdom, the United States, Canada, Australia, New Zealand, Singapore, Japan, Switzerland, the United Arab Emirates, Saudi Arabia, South Africa and thirteen countries in the European Union. A seller somewhere else is asked for a “GSTIN / VAT registration number”, and for a “PAN / unique taxpayer reference” if their country issues a second number. Both are named twice on purpose, so a business anywhere in the world can tell which of its numbers belongs where.');
p('The second number is never insisted on unless the seller’s own country issues one, because a box that cannot be filled in is a business that can never finish applying. A number typed in the wrong shape is not thrown away either: the step stays unfinished and says which number it is waiting for, so the seller can go and find the right one and come back to everything else still there.');
table(['Step', 'What it covers'], [
  ['Contact verification', 'The email address and mobile number the marketplace will reach the business on.'],
  ['Business identity', 'Registered name, country, company registration number, tax registration, and the registered address in full.'],
  ['Identity and documents', 'Who is authorised to act for the business, the tax number that identifies it to its own revenue authority, and the documents that prove the business exists.'],
  ['Store details', 'The name buyers see, a description of the business, and how buyers reach its support desk.'],
  ['Pickup and returns', 'The addresses orders are sent from and returns come back to, with each one’s cut-off time and how long picking takes.'],
  ['Payout account', 'Where money earned is sent.'],
  ['Compliance', 'Any certificates or declarations the things being sold actually need.'],
  ['Agreements', 'The marketplace agreement, commission schedule, returns policy, privacy policy and a declaration that the seller is entitled to sell what it lists.'],
], [3000, 7000]);
note('The registered address is asked for in parts', 'The address a business is registered at is asked for as six separate boxes rather than as one: the street, an optional second line, the city or district, the state, province or region, the PIN, ZIP or postal code, and the country. That is not tidiness. The country decides which registrations the business is asked for at all, the postal code is what a reviewer checks a certificate against, and the region is what several tax authorities charge on — and none of those can be pulled back out of a sentence reliably. The country is chosen from a searchable list and the state is chosen from a list too wherever the country has one people actually write down, including all of India’s states and union territories; where a country has no such list, the box is simply typed into. The postal code is checked against the rules of the country chosen — six digits for India, five for the United States — and against a sensible general rule everywhere else, because insisting on six digits worldwide would make the box impossible to fill in for most of the world. Changing the country never quietly throws away a state already chosen: the screen says it no longer fits and offers to clear it.', C.blue);
note('An address entered before the boxes existed is kept exactly as it was', 'Sellers who applied earlier gave their address as one line of writing. Nothing is guessed out of it — working out which word is the state is how a business ends up approved against the wrong tax authority — so it is shown back to them word for word, and they are asked to fill in the separate boxes when they next open the step. Saving anything else on that step never blanks it.', C.blue);
note('Working through it', 'The application opens at its first step, contact verification, for anybody who has not filled any of it in yet, and at whichever step was last saved for anybody coming back to it. Each step has Back and Continue underneath it, and the list of steps down the side jumps straight to any of them. Moving to another step puts the page back at the top, so the new step is read from its heading down rather than from the middle.', C.blue);
note('The application saves itself as it is filled in', 'Nothing typed into an application has to be saved by hand to be safe. Every word is kept in the seller’s own browser the moment it is typed, and the whole step is sent to the marketplace a couple of seconds after typing stops. If the sign-in runs out while somebody is away fetching a certificate, if a tab is closed, if the internet drops, or if the marketplace cannot accept an answer yet because it is only half typed, the work is still there. A line under the Save button says which is true at that moment — saved with the marketplace, or kept on this device and not sent yet — and in the rare case of a browser that refuses to keep anything at all, it says that too rather than promising something it is not doing.', C.blue);
note('Coming back to a half-filled step', 'A step reopened with work that never reached the marketplace shows it back in the boxes and says where it came from and when it was typed, with one button to throw it away and see what is actually stored instead. It is never put back silently, because boxes that quietly disagree with what the marketplace holds are how somebody sends in an answer they thought they had changed. What is kept belongs to that seller business alone, so two people sharing a computer never see each other’s half-finished paperwork. It is cleared as soon as the marketplace has the answers, cleared for every step once the application is sent in, and forgotten after a fortnight.', C.blue);
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
p('A seller adds one listing at a time through a four-step flow: choose the category, choose the brand, fill in the product details, then say whether it comes in more than one version. The order matters — which details a product needs depends on its category, and the brand decides whether the seller is allowed to list it at all.');
table(['Step', 'What the seller does', 'What the system does'], [
  ['Choose a category', 'Searches or browses to the right category.', 'Creates a saved draft straight away, so closing the tab loses nothing.'],
  ['Choose a brand', 'Picks an approved brand, or asks for one that is missing.', 'Offers brands already used by this seller first. A requested brand can be used on a draft while it is decided, but not on anything on sale.'],
  ['Add product details', 'Fills in five sections: photos, price and stock, description, extra information, and compliance.', 'Counts each section as it is filled in, shows what is missing, and puts every problem beside the field that caused it.'],
  ['Set the price and how it is sold', 'Enters the price per piece, the stock in pieces at each address, the smallest order, any step, and any per-order limit.', 'Labels every one of those boxes in pieces, refuses a smallest order or a step below one, and refuses a limit that no allowed quantity could reach.'],
  ['Set up versions', 'Says whether the product comes in sizes, colours, capacities or pack sizes, and lists the ones actually stocked.', 'Suggests the choices that department is normally sold by, works out every combination, and gives each one its own code, price and stock.'],
], [1800, 4100, 4100]);
note('There is a department for whatever they sell', 'A new business starts with twenty-five departments already in place — medical, laboratory, industrial supplies, tools, electrical, electronics, IT, phones, office, packaging, safety, cleaning, building, automotive, agriculture, catering, furniture, home, clothing, beauty, sports, toys, books, chemicals and energy — each with sections underneath. A seller therefore always has somewhere sensible to file a product, whatever it is, from the first day the shop opens.', C.teal);
note('The questions fit the product', 'A seller listing a bolt is asked for a thread size, a length and a grade. A seller listing a power supply is asked for voltage and whether it ships with a battery. A seller listing a medical instrument is asked for a device class and a UDI. Nobody is asked for somebody else’s fields.', C.teal);
note('Photographs', 'Every listing needs a front view and a picture of the packaging. A category that asks for a barcode or UDI also asks for a readable photograph of that label, and one that asks about sterility asks for a photograph of the seal.', C.blue);
note('A seller prices one piece', 'Everything on the price and stock step is counted in pieces, and every label says so: price per piece, stock in pieces, smallest order, and step. That is what a buyer will see and what the seller will be paid on. Nothing a seller lists is shown to buyers as a carton, and the shop’s own carton of 500 never appears on a seller’s listing.', C.teal);

h2('6a.5b Writing the description and specifications');
p('In the product details step there is a card called Description and specifications. It is where the seller writes what buyers will read below the product.');
table(['What the seller does', 'What the system does back'], [
  ['Adds description sections, each with a heading and some text, and optionally picks one of the listing’s own photographs for a section.', 'Keeps the line breaks the seller typed and removes any formatting or links. A picture needs a short description for people who cannot see it; if the seller leaves it blank, the heading is used.'],
  ['Adds specification groups — General, Technical specifications, Dimensions and weight, Warranty and so on — and rows of label, value and unit in each.', 'Offers the units as a list, so the same measurement is always written the same way. Refuses the same label twice on one product, an empty value, and a unit it does not know, and shows the reason under the field.'],
  ['Ticks Show in highlights on the most important facts.', 'Puts those facts at the top of the product information. Twelve at most.'],
  ['Gives one version its own value where it differs, for example a larger size with a higher capacity.', 'Shows that value to buyers who choose that version, and the product’s own value to everyone else.'],
  ['Moves items up or down, removes them, and presses Preview.', 'Shows the text exactly as the product page will, before anything is saved.'],
  ['Presses Save, then sends the listing for review.', 'Keeps it on the listing. The marketplace reviewer sees it with the rest of the listing, and when the listing is approved it appears on the product page.'],
], [4600, 5400]);
bullets([
  'While the listing is with the reviewer it cannot be changed, so the reviewer approves what they read.',
  'Once a listing is on sale, the seller who first described the product can still change its description and specifications, and the change shows at once. A seller who added their stock to a product page somebody else wrote cannot change that page, because other sellers sell it too.',
  'No seller can see or change another seller’s listing.',
]);
h2('6a.5a Selling one thing in several versions');
p('Most things are sold in more than one form. A T-shirt comes in sizes and colours; a shoe comes in sizes and widths; a laptop comes with different memory and storage; seeds come in a 500 gram packet or a kilo, singly or in a box of ten. Each of those is a separate thing to price, count and pack, and each needs its own code — but they are all one product as far as a buyer is concerned, and they belong on one page with a chooser rather than on a dozen separate pages.');
p('After the product details, the seller is asked one question: does this come in more than one version? Answering no finishes the listing — the price and stock already entered cover it, and buyers see no chooser. Answering yes opens the version builder.');
table(['What the seller does', 'What the system does'], [
  ['Picks which things a buyer chooses between — size, colour, capacity, length, pack size and so on.', 'Offers the choices that department is normally sold by, as suggestions. Nothing is switched on until the seller switches it on.'],
  ['Lists the values actually stocked — for example only sizes 8 and 9, not the whole size run.', 'Accepts the suggestions as one-tap choices and lets the seller type anything else. Two spellings of the same value count as one.'],
  ['Checks how many combinations that makes.', 'Shows the total before anything is built, warns when the table is getting large, and refuses one too big to fill in honestly.'],
  ['Builds the table.', 'Creates one row per combination, each with a suggested code, ready for a price and a stock figure.'],
  ['Removes the combinations they do not make.', 'Treats what is left as the full list. A combination that was removed is shown to buyers as not offered, which is different from out of stock.'],
  ['Fills in each row — code, price, previous price, stock and whether it is on sale.', 'Can set a price or a stock figure across every row at once, and can fill in any missing codes automatically.'],
  ['Adds another colour later.', 'Keeps every code, price and stock figure already entered and adds only the new combinations.'],
], [4600, 5400]);
note('Nothing is invented on the seller’s behalf', 'The suggestions are a starting point, never a claim. A shoe department offers sizes 5 to 12; it does not say the seller has them. A seller who stocks two sizes ends up with two versions, and the sizes they never picked are genuinely not offered rather than quietly shown as sold out. Only the seller knows which is true, so only the seller decides.', C.teal);
note('Not offered, and out of stock, are different answers', 'A buyer choosing black and then looking for size 8 is told one of two things. If the seller never listed black in 8, it says not offered — nobody makes it. If they listed it and have none, it says out of stock — it exists and will come back. Blurring the two sends a buyer away from something they could have waited for, or waiting for something that will never arrive.', C.blue);
note('Every version is counted and packed separately', 'Each combination has its own code, its own price where it differs, and its own stock at each address. Black in medium can be sold out while black in large is not. Adding one to a basket picks that exact version, and the order records which one was bought, so what is packed is what was chosen.', C.teal);
note('A pack of ten is not a quantity of ten', 'Where a seller offers a 500 gram packet and a box of ten of them, the box is one version with ten packets in it. A buyer ordering two boxes has ordered twenty packets. The pack size belongs to the version; how many of them somebody wants belongs to the basket. Keeping them apart is what stops an order for two boxes being packed as two packets.', C.orange);
note('Departments without suggestions still work', 'Some departments have no suggested list — medical devices, and anything a business has added itself. There the seller names the choices and types the values, and everything else behaves the same way. A shop cannot be stopped from selling something just because nobody anticipated it.', C.blue);
p('When staff approve the listing, every combination the seller marked as on sale becomes a real item in the catalogue with its own code, its own price and its own stock at each address. Combinations switched off are not created at all. From that point the product page shows a chooser, and picking a version updates the price, the picture and whether it can be bought.');

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
note('Whose price a buyer sees', 'Where several sellers offer the same thing, the shop shows the lowest price anyone is currently selling it at, and the cart buys from that seller. Prices are never converted between currencies to make that comparison — a seller who prices in rupees is compared with other rupee prices and with nothing else.', C.purple);

h2('6a.8 Running the shop');
table(['Area', 'What the seller can do'], [
  ['Home', 'See new orders, orders that need dispatching, anything past its dispatch time, sales and earnings for a chosen period, open returns, listings needing attention, and stock running low — all from live figures.'],
  ['Listings', 'See everything on sale and everything still being written, filter by status and stock, pause or resume a listing, change a price, edit versions and their stock, and duplicate one as the basis for another.'],
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
note('Putting an address on the map', 'Adding an address offers the real places matching what is being typed, and choosing one fills the town, the postal code, the country and the map position together. A map under the form shows the pin before anything is saved, and the list of addresses shows all of them together, so a place put in the wrong town is seen rather than discovered later. An address with no position still works exactly like the rest — it simply says it is not on the map yet.', C.teal);
note('A shipment can be recorded at any point', 'Marking an order as being picked and then ready to go is there for sellers who want it. A seller who accepts, packs and hands the parcel to a courier can record the shipment straight away — what makes an order shipped is a carrier and a tracking number, not a box being ticked first.', C.purple);
note('If a figure cannot be worked out', 'Each number on the seller’s home screen is worked out separately. If one of them fails, the screen says so instead of showing a zero — because a seller who reads "no new orders" and goes home is worse off than one who is told the figure is unavailable.', C.purple);
note('The seller’s own name over their own shop', 'The seller’s workspace is headed by their company logo and trading name, not by the marketplace’s. A business that has not uploaded a logo yet sees its own initial instead — never somebody else’s mark over its name. The logo is uploaded and replaced on the Profile screen.', C.blue);
note('A brand new seller is not shown a screen of zeroes', 'Until a business has listed something, its home screen does not draw the figures at all. It shows the three things to do first — finish the account, add the first product, get ready for orders — with how far through setting up it is underneath. Twenty numbers all reading nought say nothing, and no sales on the day somebody joined is not news.', C.teal);

h2('6a.8a Adding versions to something already on sale');
p('Most sellers have listings that were created before versions existed: one product, one code, one price, with a rack of four sizes behind it and no way to say so. Deleting the listing and creating it again would throw away its code, its sales history and its link to past orders, so the versions are added to the listing that is already there.');
table(['What the seller does', 'What the system does'], [
  ['Opens a listing from their listings table.', 'Shows every version they currently sell of that product. A listing with none says so plainly.'],
  ['Pauses it.', 'Required before versions can be added, because it changes what a buyer is choosing between on a page somebody may have open. Orders already placed are not affected.'],
  ['Picks the options and lists the values they stock.', 'Suggests what that department is normally sold by, with nothing chosen for them.'],
  ['Builds and prices the table.', 'Suggests a code for each combination and starts each at the listing’s existing price, which the seller can change.'],
  ['Saves.', 'Creates each version alongside the original listing, which keeps its code and its history. New versions are created off sale.'],
  ['Switches each new version on when its stock is real.', 'Only then does it appear to buyers, at that version’s own price.'],
], [4400, 5600]);
note('Nothing is guessed from the old listing', 'A product called "Raymond, Suits & Clothing" is obviously a suit, and a suit is usually sold in sizes 38 to 44 — and offering those as a ready-made table would save the seller a minute while putting four sizes on a product page that nobody has confirmed anyone can send. The department suggests the options; the seller says which sizes they actually have.', C.teal);
note('The original listing is never destroyed', 'It keeps its code, its price and every order that refers to it, and it appears in the table as "no particular version". Whether to archive it, pause it or leave it selling is the seller’s decision afterwards — it is the row their past orders point at, and nothing here can know which they intended.', C.blue);
note('Saving twice adds nothing twice', 'Versions are matched by the combination they describe, so one that is already listed is skipped rather than created again or overwritten. A seller adding one more size to a range of six does not have to re-enter the prices of the six.', C.teal);

p('The reviewer also sees the seller’s description and specifications exactly as they will appear on the product page, and can send the listing back with a note if something in them is wrong.');
h2('6a.8b Changing a listing that is already selling');
p('Every part of a listing can be changed after it has been approved, without deleting it and starting again. Edit opens it already filled in — its photographs, what it costs, the quantities it is sold in, and every version it comes in with that version’s own code, price, stock and picture.');
table(['What the seller does', 'What the system does'], [
  ['Presses Edit on a listing.', 'Opens it with everything already filled in, so nothing has to be typed a second time. A listing that is on sale is asked about first — see below.'],
  ['Changes a price, a stock figure or an order rule.', 'Accepts it while the listing is still on sale. These change often and a buyer looking at the page simply sees the new figure.'],
  ['Adds or removes an option or a version.', 'Asks for the listing to be paused first, because it changes what a buyer is choosing between on a page somebody may have open.'],
  ['Changes prices or stock for many versions at once.', 'Offers one box that sets the same figure across every row, and a way to fill in any missing product codes without touching the ones already typed.'],
  ['Adds or removes a photograph.', 'Saves it straight away rather than waiting for the rest of the form, and chooses which one buyers see first.'],
  ['Finishes with Save as paused, or Save and resume sale.', 'Saves either way. Resuming checks the listing is fit to be seen again first, and says the one thing to fix if it is not.'],
], [4400, 5600]);
note('Pause and Edit says what it does before it does it', 'Pressing Edit on something that is on sale asks first: the listing will disappear from search and cannot be added to a basket, but orders already placed are not affected at all, and the stock, the product codes and the sales history are all kept. Who paused it and when are written down, so a colleague finding it paused a few days later is told it was somebody editing it rather than a problem with the listing.', C.blue);
note('Adding a size does not disturb the sizes already there', 'Versions are recognised by the combination they describe, never by their position in the table. A seller who sells sizes 7, 8 and 9 and adds size 10 keeps all three of the originals exactly as they were — same codes, same stock, same link to past orders — and gains one new row. Nothing is re-created and no stock figure is reset.', C.teal);
note('Stopping selling something does not erase what was sold', 'Removing a version that somebody has already bought keeps it on their order, where it is still needed to say what was in the box. It simply stops being offered to anybody new. Nothing an order refers to is ever deleted.', C.teal);
note('Not offered and out of stock are different things', 'Unticking a version says the seller does not sell that combination at all. A stock of zero says they do sell it and currently have none. Buyers are shown the two differently, and a newly created combination starts unticked so that a suggestion is never mistaken for a promise.', C.orange);
note('Some things belong to the catalogue, not to one seller', 'The product’s name, department and description are shared by every seller offering it, so changing them goes through the marketplace rather than through one seller’s edit screen. Photographs can be changed by the seller who described the product in the first place; a seller who matched their stock to a page somebody else wrote is told why they cannot.', C.purple);
note('Work in progress is not lost quietly', 'Leaving the screen with unsaved changes asks first. If somebody else has changed the same listing in the meantime, the save is refused with a request to reload rather than overwriting their work, and the Save buttons are disabled while a save is being sent so it cannot be submitted twice.', C.blue);

h2('6a.8c Taking something off sale to change it');
p('A seller who needs to change something on a listing that is already selling does not have to delete it and start again — doing that would throw away its code, its history and its link to past orders. Instead they pause it, make the change, and put it back on sale.');
table(['What the seller does', 'What the system does'], [
  ['Presses Pause on a listing that is on sale.', 'Asks them to confirm, and says plainly what will happen and what will not.'],
  ['Optionally writes down why.', 'Keeps the note for the seller’s own team. Buyers never see it. It shows beside the listing so somebody looking at it weeks later knows whether it is waiting for stock or has been withdrawn.'],
  ['Changes whatever needs changing.', 'Everything stays editable while it is paused — title, pictures, description, price, versions, stock and compliance details.'],
  ['Presses Put on sale.', 'Checks the listing is fit to sell again before letting it back, and if it is not, says the one thing that needs fixing.'],
], [4200, 5800]);
note('What pausing does, and what it does not', 'A paused listing disappears from search and cannot be added to a basket, and anybody who already had it in their basket is told it is unavailable. Orders already placed are not affected at all — they still have to be packed and sent, and the delivery carries on exactly as before. Stock, codes and sales history are all kept.', C.blue);
note('Putting it back on sale is checked, not assumed', 'Pausing is what a seller does in order to change things, so the state it was paused in is not the state it is coming back in. Before it goes live again the system checks it still has a code, a price, a previous price that is not lower than the price, stock that is not negative, and a product and version that are both still active. A listing paused to fix a price and put back with the price box empty would otherwise go on sale at nothing.', C.orange);
note('Some listings cannot simply be resumed', 'Where the marketplace has stopped a listing itself — an expired certificate, a brand that was withdrawn — there is no Put on sale button, and the system refuses it as well. That state exists to stop something being sold, and a button that overrode it would make it meaningless. The seller fixes the thing that is wrong and the listing becomes resumable.', C.orange);
note('Archiving is not pausing', 'A listing that is finished with is archived rather than deleted. It is kept so that past orders still make sense, hidden from selling, and never removed while an order refers to it.', C.teal);

h2('6a.8d What buyers asked for and did not buy');
p('This is the only thing in the hub that comes from somebody who did not place an order. Orders tell a seller what sold. Stock tells them what is left. This tells them why the rest of the people who looked went away, which nothing else on any of their screens can answer.');
p('When a customer uses Add instructions on a product — see section 3.2f — it arrives here. The seller sees it in two places, because they are two different questions. On a listing, it answers "why is nobody buying this one?". On its own page, under Buyer requests, it answers "what are people asking me for?", which is the question that changes what a business decides to stock. On that page the requests are grouped by product, so six people asking for the same size is obvious at a glance instead of being spread across six listings.');
table(['What the seller sees', 'What the system does'], [
  ['A page listing every request across everything they sell.', 'Groups them by product, newest first, with the products that were asked about most recently at the top.'],
  ['The same requests on the listing they belong to.', 'Shows them at the foot of that listing, so somebody already changing a product sees what was asked about it.'],
  ['Who asked, and the business they work for.', 'Gives a name and a company and no contact details. A seller who wants to reply does so through an order, where there is a relationship.'],
  ['The request itself, exactly as it was written.', 'Shows it as plain words. The seller cannot change it — it is the buyer’s own account of what they needed.'],
], [4400, 5600]);
bullets([
  'A seller sees requests only on products they actually list. Somebody else’s products are not shown, and not reachable.',
  'A listing that is paused still shows them. The seller whose listing is off sale is exactly the one who needs to know why nobody was buying it.',
  'A product several businesses sell shows its requests to all of them. A customer asking whether something comes in 8 mm is asking the marketplace, not a company whose name they have never seen.',
]);

h2('6a.8e Seeing exactly what a customer ordered');
p('On each order, every product the seller has to send has a panel called Ordered product information. It shows the product as the customer saw it when they ordered, in four tabs.');
table(['Tab', 'What it shows'], [
  ['Description', 'The product description as it was at the time of the order.'],
  ['Specifications', 'The specifications at the time of the order, including the values for the size, colour or other option that was chosen.'],
  ['Packaging', 'The unit it was ordered in, how many of them, how many pieces that comes to, the minimum order, and the carton and container figures.'],
  ['Order selections', 'The options the customer chose and any special instructions they wrote.'],
], [2600, 7400]);
bullets([
  'Nothing in the panel can be changed. To change the product itself, the seller uses View current listing, which opens the listing separately.',
  'Changing the listing afterwards does not change what an order says. The invoice and packing list describe the product the same way as this panel.',
  'For an order placed before this was kept, the panel shows the listing as it is now and says so clearly at the top.',
  'A seller only ever sees their own part of an order. When one order includes products from several sellers, each sees only their own products.',
]);
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
h2('6a.11 Choosing how your orders get delivered');
p('Every seller has to say how the things they sell will reach the people who buy them. It is one of the steps in the application, it can be answered in a single click, and it can be changed at any time afterwards from the Delivery screen in the Seller Hub.');
p('There are four ways, and a seller can use more than one at a time.');
table(['Way of delivering', 'What it means'], [
  ['Your own carrier account', 'The seller already has an account with DHL, FedEx or India Post and wants to use it. The seller packs the goods; the carrier collects and delivers them.'],
  ['Your own delivery team', 'The seller delivers with their own people, vans and drivers.'],
  ['A delivery company you work with', 'A courier firm the seller already works with, which delivers for that seller and manages its own drivers.'],
  ['Marketplace delivery', 'The marketplace arranges a delivery company. Nothing to set up. This is how the system worked before the other three existed, and it is the answer for a seller who has not decided yet.'],
]);
note('Why there is always an answer', 'Marketplace delivery needs nothing configured by anybody, so no seller can ever be stuck on this step waiting for somebody else. That is what makes it safe to insist on an answer before an application is sent in.', C.blue);

h2('6a.11a Drivers, and who they belong to');
p('When a seller delivers with their own team, or through a courier firm that works for them, drivers and vehicles are managed inside the system — added, given their qualifications, put on a delivery, taken off it again.');
p('When a seller uses DHL, FedEx or India Post, none of that appears. Those drivers work for the carrier, not for the seller and not for the marketplace, and there is no screen anywhere offering to choose one. A seller sees the name and a partly hidden phone number of whoever is bringing their own consignment, and nothing else about anybody’s staff.');

h2('6a.11b Connecting a carrier account the seller already has');
p('The seller enters their account number and the key their carrier gave them. The key is stored on the marketplace’s own server, encrypted, and is never shown again — not to the seller, not to the marketplace’s staff, not on any screen or report. The seller can replace it at any time, and can delete it, which disconnects the account.');
p('Before anything real is sent that way, two separate things have to happen, in this order:');
bullets([
  'The system calls the carrier for real, using the key that was entered, and the carrier answers. Saving the form is not enough — a key with a typo in it looks exactly like a correct one until somebody actually tries it.',
  'A person at the seller then says they want live orders sent this way. A test that passed proves the key works; it does not prove anybody meant to start shipping.',
]);
p('Until both have happened the screen says so plainly, and the button that switches it on cannot be pressed. Replacing the key puts it back behind both, because a new key that was mistyped must not inherit the old one’s tick.');
note('Nothing is ever pretended', 'If the carrier refuses, the screen shows what the carrier said and the account stays switched off. There is no state anywhere in this system that reports a working connection on the strength of a saved form.', C.teal);

h2('6a.11b-i Sending with DHL, FedEx or India Post without an account');
p('Most sellers have no DHL, FedEx or India Post account connected to the marketplace, and they do not need one to send with those carriers. On a confirmed order the seller chooses the carrier, books the parcel with it themselves — on the carrier’s own website or at its counter — and then writes down here what the carrier gave them.');
bullets([
  'The carrier’s own tracking number. Nothing about the parcel’s journey can be recorded until it is entered, and it cannot be changed once the carrier has collected the parcel.',
  'The service chosen, the pickup reference, the expected pickup and delivery dates, and, if the seller wants, what it cost.',
  'Photographs or screenshots of the paperwork: the label the carrier issued, customs forms, a proof of delivery.',
  'Each step as the carrier reports it: picked up, in transit, delayed, out for delivery, delivered. The buyer sees these updates.',
]);
note('What the marketplace never pretends', 'Nothing is booked with the carrier, no label is printed, no price is quoted and no tracking number is made up. The delivery is marked “Manual booking” everywhere it appears, and until the tracking number is in, it also says “Tracking number pending” and the seller is reminded to book it. Marking it delivered needs a proof of delivery to be attached first.', C.orange);
p('Each carrier’s own setup screen now shows only that carrier: its name, its account-number box, the keys it uses and the steps to get them. A carrier with no connection says so — “API account not connected” — and explains that it can still be used by booking by hand. The setup screen can be closed at any time, and the reminder to finish setting up stays until the connection has genuinely been tested and switched on.');

h2('6a.11c India Post');
p('India Post is offered, and the system is straightforward about what it can and cannot do with it. There is no published way for software like this to book, price, label or automatically follow an India Post parcel, so none of that is claimed.');
p('What a seller gets is real and useful: the consignment is recorded here, they enter the article number India Post gave them, its shape is checked, and the tracking link goes to India Post’s own page. Anyone authorised can add tracking updates by hand, and every one of them is shown as having been entered by a person.');
p('There is no test button on the India Post screen, because there is nothing to test, and no part of the system will ever describe it as connected.');

h2('6a.11d Sending different things different ways');
p('A seller who sells several kinds of thing rarely wants all of them going the same way. The system lets them say so, and works through the instructions from the most specific to the least:');
bullets([
  'A rule about one particular listing.',
  'A rule about everything leaving one particular place.',
  'A rule about everything going to a particular country, or to a range of postcodes inside it.',
  'The seller’s usual choice, and then the one they named as a backup.',
]);
p('A rule only chooses between ways of delivering the seller has already had approved; it cannot grant permission for anything. Every rule is re-checked at the moment an order is ready, so a seller who pauses one way of delivering keeps trading — the next one down is used instead, rather than orders quietly stopping.');
p('If nothing at all can carry a particular order, the order is not sent by something unsuitable and it is not lost either. It waits, marked for a person to look at, with a note saying which ways were tried and what stopped each one.');
p('Whichever way was chosen is written onto that delivery and never recalculated. A seller who changes carrier in March will still see last month’s deliveries showing what actually carried them.');

h2('6a.11e Setting up your own delivery operation');
p('A seller who delivers with their own people describes the operation — the name buyers will see, the registered name, the country and an operations contact — and names one person to run it. That person receives their own invitation to the delivery portal, where drivers, vehicles and daily rounds are managed.');
note('Two jobs, two sign-ins', 'Running a shop and running a fleet are different jobs with different records behind them, so they are separate accounts with separate sign-ins. The person who runs the deliveries needs an email address that is not already used on the marketplace. This is deliberate: driver licences, addresses and live locations are a different kind of information from a product catalogue, and the system does not hand one out with the other.', C.blue);
p('The marketplace reviews a seller’s own delivery operation before it carries anything. What is being reviewed is what the seller says it can do — carry goods that must stay cold, handle a particular area, take dangerous goods — because those claims decide which orders the marketplace lets them accept. Anything not yet approved simply is not offered: an operation approved for nothing carries nothing special, rather than everything.');

h2('6a.11e-i Telling the system where you collect from, where you go, and what you charge');
p('Once the marketplace has approved a seller’s own delivery operation, the seller fills in four things about it. Each is a separate screen, and none of them appears for DHL, FedEx or India Post, because those companies decide their own coverage and their own prices. None appears for a courier working for the seller either — that firm sets its own in its own portal.');
bullets([
  'Where goods are collected from. For each of the seller’s buildings: which days the van calls, the window it calls in, how many parcels that door can send out in a day, and what the driver needs to know to find the loading bay.',
  'Where it delivers to. Whole countries, states, cities, or ranges of postcodes — and the places it does not go. A place left out always wins over a larger area that covers it, so "the whole country except the islands" is two lines rather than a long list.',
  'What it is allowed to carry. Goods that must stay cold, sterile handling, oversized items and so on. The seller asks; the marketplace decides. Nothing in this software lets a seller approve their own, and only something that has been approved is ever matched to an order needing it.',
  'What it charges. A price list, saved as a version. Publishing it again makes a new version and keeps the old one, because an order priced last month has to stay explainable if somebody queries the delivery charge.',
]);
note('Why the old price list is kept', 'A delivery charge queried six weeks later has to be shown as it stood on the day, not as it stands now. A price list edited in place makes that impossible, and that is how a business ends up unable to explain a number it charged.', C.teal);

h2('6a.11e-ii Handing the parcel over, and booking the van');
p('When a paid order becomes a consignment, the system works out which of the seller’s delivery methods carries it. As soon as the seller confirms the order, where that method is a delivery company on this marketplace, the consignment is offered to that company automatically. The seller already decided by setting the rules; being asked to hand each order over by hand afterwards would make those rules pointless. Nothing is offered before the seller confirms, because a company should not be asked to collect an order the seller may still turn down.');
p('Where no rule chose anybody, the seller is told to assign one. On the order they press “Assign Logistics Partner” and see the consignment’s route, load, packages and any special handling; every delivery company they work with, with the ones that cannot take this consignment greyed out and the reason given (not approved, does not serve this route, does not take pallets, does not take containers, account inactive); and DHL, FedEx and India Post as carriers they can book by hand. The seller can change their choice, with a reason, until the parcel is collected — after that only the carrier and the marketplace can move it. The company that loses the work is told why.');
p('It is still an offer, and still the company’s to accept, even when the seller owns the fleet. That company has its own screens and its own staff, and accepting is how somebody there says they have seen it.');
p('Collecting the goods is then arranged in one of two ways. If the seller uses their own account with a carrier, the collection is booked with that carrier under the seller’s own contract and the reference the carrier gives back is kept — that is the number a seller reads out on the telephone when the van has not arrived. If a delivery company on this marketplace is carrying it, nothing is called: the request appears on that company’s own board for somebody there to schedule.');
bullets([
  'One collection at a time for one parcel. Asking for a second while one is still coming is refused, and the refusal names the one already booked so it can be cancelled first.',
  'Cancelling twice does nothing the second time. The van was already called off, so nothing is charged again and the record of when it was cancelled does not move.',
  'A collection that already happened cannot be cancelled.',
  'The warehouse can say the goods are ready. Nobody is called — it is written down, and whoever collects sees it.',
]);
note('Why two vans matter more than one missed van', 'A second booking costs money, it is the one nobody remembers to cancel, and a warehouse that hands the same boxes to two drivers has lost them. A missed van can be rebooked.', C.blue);

h2('6a.11e-iii Asking what a delivery costs, and paying for it');
p('A seller using their own carrier account can ask that carrier what a particular consignment would cost, see the services it offers side by side with prices and rough delivery times, choose one, and book it. Every figure comes from the carrier; nothing here works out a price on the carrier’s behalf.');
p('Pressing the button twice does not book two parcels. The second press is recognised as the same request, nothing further is charged, and the screen says it was already booked rather than pretending a second parcel is on its way.');

h2('6a.11f Asking another delivery company to work with you');
p('A seller can also bring in a courier firm they already use. Either they pick one already working with this marketplace, or they invite one that is not here yet.');
p('Inviting does not create the company. The seller describes it and gives a business email address; the firm receives a single-use link, and decides for itself whether to accept. If it does, it enters its own details and chooses its own password. The seller never sees or sets it.');
note('Why the seller cannot set that password', 'Anybody who could would be able to sign in as the delivery company and read every consignment it carries — including, once it works for a second seller, somebody else’s. The invitation exists so that the company speaks for itself.', C.teal);
p('A company accepting still does not mean it can start work. That is two parties agreeing, and the marketplace is the third; it reviews the arrangement before anything is handed over. Every step — invited, accepted, approved, suspended, restored — is kept, in order, with the reason. Restoring a suspended arrangement does not erase the suspension.');
p('The seller can withdraw an invitation nobody has taken up, and can see exactly where each one stands.');

h2('6a.11g What the marketplace can see');
p('Staff have one screen listing every way anything is delivered on the whole marketplace: which delivery companies are active, which sellers use which carriers, what is waiting for a decision, and which connections are failing. For each seller’s carrier account they can see whether it is working, when it last worked, and what the carrier said when it did not.');
p('They cannot see the key. A marketplace holding its sellers’ carrier keys is exactly what storing them per seller is meant to prevent, and there is no screen, report or export anywhere that would show one.');
p('Delivery companies see only themselves — their own coverage, their own drivers, their own consignments and the health of their own connection. One delivery company can never see another’s.');
h2('6a.11h Who is answerable when something goes wrong');
p('The way a seller delivers decides more than which van arrives. It decides who the customer’s complaint actually lands on. This is the same information in every direction, set out once.');
table(['', 'Own carrier account', 'Own delivery team', 'A company you work with', 'Marketplace delivery'], [
  ['Who books the journey', 'The seller, with their carrier', 'Nobody — it is their own van', 'The company, by accepting the job', 'The marketplace'],
  ['Who pays for the journey', 'The seller, on their carrier bill', 'The seller', 'Whatever the two of them agreed privately', 'The marketplace'],
  ['Whose staff the driver is', 'The carrier’s', 'The seller’s', 'That company’s', 'The delivery company the marketplace uses'],
  ['Who updates where the parcel is', 'The carrier, automatically', 'The driver, on their own screen', 'The driver, on their own screen', 'The driver, on their own screen'],
  ['Who sorts out a failed delivery', 'The carrier, in their own process', 'The seller’s team', 'That company', 'The marketplace'],
  ['Who handles a return', 'The seller', 'The seller', 'The seller', 'The seller'],
  ['Whose name the customer sees', 'The carrier’s', 'The seller’s delivery team', 'That company’s', 'The delivery company'],
]);
note('A return is always the seller’s', 'The goods belong to the seller and so does the refund. A return here is a request against the order, which is looked at and the stock put back; no carrier is asked for a return label, because none of these carriers is being asked to take that on. A marketplace that quietly promised otherwise would be promising something nothing in this system does.', C.orange);

h2('6a.10a Saying how your goods are packed');
p('A seller who ships by the pallet can say so, per listing, and buyers then order pallets instead of counting units. It is set up on the listing itself, under Bulk packaging, and each kind of package is switched on separately — a seller who only ships cartons never sees the container form.');
table(['What the seller does', 'What the system does'], [
  ['Says how many units are in one carton.', 'Uses that everywhere below. It is the figure the whole chain is built from.'],
  ['Says how many cartons sit on a layer, and how many layers high the pallet is.', 'Works out the cartons on a pallet and the units on a pallet, and shows both as they type.'],
  ['Corrects the figure where the real pallet is not a tidy multiple.', 'Keeps both numbers — theirs and the one the layout works out to — and shows both, so the difference can always be explained.'],
  ['Gives the size, the loaded weight and the safe load.', 'Shows them to the buyer, and carries them onto the delivery paperwork.'],
  ['Sets the smallest order and the step, in packages.', 'Holds buyers to it, and moves a quantity up to the nearest allowed one rather than refusing it.'],
  ['Prices a package — or says it is quoted on request.', 'Shows the package price and the price that works out to per unit. A quoted package is ordered without an instant delivery price.'],
  ['Adds cheaper prices for larger quantities.', 'Shows the buyer the better price before they commit, and applies it automatically.'],
]);
bullets([
  'Packaging is set per listing, because two sellers pack the same product differently and one seller packs the small size differently from the large one.',
  'A package that is switched on but not finished is kept, and simply not offered to buyers, with the missing field named on the seller’s own screen. Nothing is lost and nobody is shown a half-filled pallet.',
  'Container figures offered on the form are guidance. What actually fits varies by the container and the shipping line, so the seller’s own figure is the one used.',
]);
note('Why a package price has to divide evenly', 'Every order line is charged as a price per unit multiplied by the number of units. So a package price has to divide exactly by what is inside the package, or the price per unit has a fraction of a paisa left over with nowhere honest to go — and the total would stop adding up. A pallet of 1,200 is therefore priced in whole paise per unit. The form says so, and suggests the nearest figures that work.', C.purple);

h2('6a.10b When no carrier can price the delivery');
p('A pallet is not a parcel and a container is not a big parcel. Where nothing on the seller’s account can carry the load, the system says so instead of asking a parcel company for a price it cannot honestly give.');
bullets([
  'The order still goes through. It is the delivery that is quoted, not the goods.',
  'A request appears on the seller’s orders screen describing the load — how many pallets, how heavy, from where to which country — and a person enters a real price, a service and the dates.',
  'Nothing is estimated. A delivery figure on the screen is always one a person put there or one a carrier actually quoted.',
  'A mixed order takes the heavier answer: one pallet among forty loose items is a pallet delivery, because the pallet still has to go on a lorry.',
]);


h2('6a.10c Answering a preorder');
p('A preorder is a buyer asking whether the seller can make a large quantity by a date. It arrives in Seller Hub under Orders → Preorders, and it stays at the top of the list until the seller answers, because a request nobody answers expires and the buyer goes elsewhere.');
table(['The seller can', 'What happens'], [
  ['Accept it as asked', 'The seller states the delivery charge (and the price per piece, if their prices are quoted per request). The buyer is asked to confirm.'],
  ['Send a counter-offer', 'A different quantity, price per piece, committed date, or a split into several deliveries on different dates. The buyer is asked to confirm or decline.'],
  ['Reject it', 'With a reason the buyer is shown. Nothing is charged.'],
  ['Mark production started, then ready', 'Once the buyer has confirmed and paid. The buyer is told at each step.'],
  ['Accept the order when the goods are in stock', 'The preorder is handed over to ordinary order fulfilment — packing, delivery and the rest work exactly as for any order.'],
], [3200, 6800]);
bullets([
  'Beside every request the seller sees their own production capacity for that period, with this request included, drawn as a bar. A request that would go over it is refused before the seller can promise it.',
  'None of the seller’s answers charges the buyer. The buyer confirms the terms and then pays.',
  'Once the buyer has confirmed, the terms cannot be changed by either side. A change after that is a new request.',
]);
h3('Setting preorder terms');
p('On every listing there is a Preorder terms panel. The seller can set terms for one version only, for every version of the product, or as their default for everything they sell. The most specific one that exists is the one that applies, and the panel says which one applies today and what a buyer is held to in pieces.');
bullets([
  'Minimum quantity — in pieces or in cartons, pallets or containers — the step after it, and a maximum.',
  'Production capacity per day, week or month, the production lead time, and how far ahead a delivery may be booked.',
  'Which countries preorders are delivered to, whether partial or split deliveries are allowed, and how long each side has to answer.',
  'Fixed price bands (“from 10,000 pieces, ₹80 per piece”) or “quoted per request”. A larger quantity can never be priced higher per piece than a smaller one.',
  'Cancellation terms and instructions for buyers.',
  'A minimum set in pallets is converted to pieces using that listing’s own pallet size, and the panel shows the piece figure buyers will see.',
  'If the seller sets no terms at all, buyers can still preorder on standard terms — a minimum of 1,000 pieces (or the listing’s own minimum, if higher) and the listing’s own price — and the panel says so. The seller still accepts, counters or refuses every request. To stop preorders on a listing, the seller switches them off.',
  'Stock kept back from preorders: a number of pieces the seller never promises to a preorder, so ordinary basket orders are not left short.',
]);
h3('Saying how many fit in a container');
p('Before buyers can preorder by the container, the seller says how many pieces fit. This is on the listing, in a card called “Container loading for preorders”, just below Bulk packaging. Each version of a product has its own figure.');
table(['What the seller does', 'What the system does'], [
  ['Describes the carton: pieces in it, its length, width and height, and its weight when full. Any common unit can be used.', 'Uses the carton as the building block for everything below.'],
  ['Says how high cartons may be stacked, if there is a limit, and whether they are loaded loose or on pallets.', 'Takes both into account.'],
  ['For a 20-ft and a 40-ft container, says whether it is offered and how many cartons go in.', 'Works out the pieces per container, the weight of the load against what the container may carry, and how much of the space is used.'],
  ['Presses “Use the estimate”, if they want a starting point.', 'Fills in the best fit it can work out from the carton’s size, the stacking limit and the weight — never from space alone.'],
  ['Ticks “I have loaded or checked this figure”.', 'Only then offers that container size to buyers. A figure nobody has checked is never shown to a buyer.'],
]);
bullets([
  'Changing the carton or a count without ticking again takes that size off sale until the seller checks it again.',
  'An impossible figure is refused with the reason: a load heavier than the container may carry, cartons that take more room than the container has, a carton that fits no way round, or a missing number. The heaviest load allowed is a setting the business can change.',
  'Every change is kept in the seller’s activity log with the figures before and after.',
  'A request a buyer already sent keeps the figure it was made with. A later change does not alter it.',
]);
h3('When a buyer asks for more than you have');
p('The system works out how many pieces the seller could promise today: the stock at the locations that serve preorders, less paid orders the seller has not accepted yet, less the stock kept back from preorders. Stock that is still being made or is on its way is not counted, because the system has no checked record of it.');
bullets([
  'A request for more than that is marked “More than available” in the preorder list, and the seller’s alert says how many are available. The seller sees how the figure was worked out; the buyer does not see warehouse details.',
  'The seller presses “Propose a delivery schedule” and chooses one of two answers.',
  'The complete quantity on a later date: one date the seller commits to, the choice to set aside the pieces available now for this buyer when they accept, the price per piece, the delivery charge, how long the offer stays open, and a note.',
  'A split delivery: two or more deliveries on later and later dates. The first comes from stock on hand and cannot be more than is available; the rest come from later supply. Together they must add up exactly to what the buyer asked for. The buyer’s quantity is never changed or rounded.',
  'Before sending, the seller sees a preview: each delivery in pieces and in containers (a part-filled container is shown as such), the stock that will be set aside, and the full price with tax and delivery. Any problem is listed, and leaving a changed proposal asks “Discard this proposal?”.',
  'Nothing is set aside when the seller sends the proposal. Stock is set aside only when the buyer accepts. If it has gone by then, the buyer is not charged and the seller is asked to propose again.',
  'When the seller accepts the order, the stock set aside for the buyer becomes the order’s own stock, so nothing is counted twice. In a split delivery, each later delivery needs its own stock before it can be sent.',
  'If the stock covers the whole request, nothing changes: the seller accepts, counters or rejects as usual.',
]);

h2('6a.10c-i Quantity prices');
p('On each listing, under Quantity prices, the seller can charge less per piece for larger quantities. These prices are what buyers are charged in the basket, and what the product page shows them.');
table(['The seller sets', 'What it does'], [
  ['From, and optionally up to, a number of pieces', 'The quantities the price applies to.'],
  ['A price per piece', 'Must be lower than the listing’s normal price, or it would never apply.'],
  ['A start and end time', 'For a promotion that runs for a limited time.'],
  ['Active or paused', 'Stops a price for now without deleting it.'],
  ['Business accounts only', 'Only buyers with a company account get this price.'],
  ['Delivery countries', 'Only deliveries to these countries get this price.'],
  ['Preorders only', 'The price applies only when a buyer asks the seller to make the quantity with a preorder, never in the basket.'],
], [4200, 5800]);
bullets([
  'All the prices on a listing are checked together when the seller saves them. A larger quantity can never cost more per piece than a smaller one, and two prices cannot cover the same quantities. Each problem is shown beside the price it belongs to.',
  'A price applies to pieces bought loose. Cartons, pallets and containers keep the package price the seller set for them.',
  'Every order remembers the price that applied, so changing prices later never changes what an earlier order says it cost.',
]);

h2('6a.10d Packing, and the invoice and packing list');
p('When a seller packs an order, the system makes the two documents that travel with it: the seller’s own tax invoice, and a packing list. Both are made for each load that leaves, not for the whole order, so a seller who sends one order in two lorries gets two of each.');
table(['The seller does', 'What the system does'], [
  ['Lists the packages: cartons, pallets or containers, their size and weight, and what is in each, with batch and expiry', 'Counts every item and shows, as the seller types, how many are packed against how many the load carries.'],
  ['Splits the order into two loads, if it is leaving in more than one', 'Creates a second load with the pieces the seller moved. Each load gets its own documents.'],
  ['Presses Check', 'Shows the invoice and packing list as they would be, with a list of anything missing — for example “Your GSTIN is not valid” or “Nitrile gloves has no HSN code” — each saying what to fix. A draft PDF can be opened, marked DRAFT.'],
  ['Presses Mark as packed', 'Issues the invoice and the packing list, gives each its number, and marks the load packed — all together. If anything is missing, or the PDF cannot be made, nothing is issued, no number is used, and the load stays unpacked.'],
  ['Downloads the documents', 'One at a time, or all of an order’s documents together in one ZIP file.'],
], [4200, 5800]);
bullets([
  'The invoice is issued in the seller’s own legal name, under their own tax number, with their own numbering — for example INV/26-27/00001, starting again at 1 each financial year.',
  'For India, the system works out the tax the way GST requires: CGST and SGST when the goods stay in the seller’s state, IGST when they cross a state border, and an export declaration when they leave India. The tax on the invoices always adds up to the tax the customer paid.',
  'An issued invoice can never be changed. To correct one, the seller issues a credit note, which has its own number and cancels the original in full; the seller can then issue a new invoice.',
  'If an order is cancelled, returned or refunded after its invoice was issued, the seller is told that a credit note is needed.',
  'A packing list can be replaced if the packages change. The old one is kept on record, marked as replaced, and the new one gets a new number.',
  'The packing list shows no prices. It goes to the delivery company; the invoice does not.',
]);
h3('Invoicing settings and trade codes');
p('In Seller Hub, under Invoicing, the seller sets how their invoices are numbered (the letters at the start, and when their financial year begins), who signs them, and — for exporters — their Letter of Undertaking. Their legal name and tax number are shown from their business profile, with a warning if the tax number is not valid.');
p('On each listing, the seller gives the product’s HSN code and country of origin. Both are printed on every invoice and packing list, and an Indian tax invoice cannot be issued without the HSN code.');

h2('6a.12 Sending your sales into TallyPrime');
p('A seller who keeps their books in TallyPrime can have their orders appear there automatically, instead of being typed in again at the end of the month. It is set up in the Seller Hub under ERP integrations, and it is switched on by the marketplace — a seller who does not see it should ask whether their marketplace offers it.');
p('TallyPrime runs on a computer in the seller’s own office. Nothing in this system ever connects to that computer. Instead a small program — the Glovia Tally Bridge — runs on the same machine as Tally, and it connects outwards to fetch whatever is waiting to be sent. The seller’s books are never exposed to the internet.');
table(['What the seller does', 'What the system does'], [
  ['Installs the bridge on the machine that runs TallyPrime.', 'Nothing yet. The bridge has no permission until it is paired.'],
  ['Generates a pairing code in the Seller Hub.', 'Shows a short code, once, that is good for fifteen minutes and can be used one time.'],
  ['Pastes the code into the bridge.', 'Trusts that one machine from then on, and shows it in the list of paired machines.'],
  ['Chooses which Tally company to post into.', 'Offers only the companies TallyPrime actually reported as open. A name cannot be typed in.'],
  ['Presses Test.', 'Asks the bridge to check, and reports what it found — with the time it found it.'],
  ['Matches their ledgers, stock items and voucher types to what is in Tally.', 'Refuses to post anything until every match a sync needs has been confirmed.'],
  ['Chooses what should be posted.', 'Posts only that. Everything that moves money starts switched off.'],
  ['Runs the first sync.', 'Queues the orders, sends them as the bridge collects them, and reports what each one did.'],
]);
note('“Connected” means it was actually checked', 'The word is only shown when four things are true at once: the bridge checked in within the last few minutes, a test passed within the last quarter of an hour, the right company is open in Tally, and every match has been made. Each of those is shown with the time it was last true, so it can be checked rather than believed. There is no state meaning “probably fine”.', C.teal);
note('Told exactly what is wrong, not just that something is', 'A machine switched off, TallyPrime closed, and the wrong company open in Tally look identical from a distance and are three completely different things to go and do. Each has its own message. The commonest one by far is the third: Tally is running perfectly and the company this connection posts into simply is not the one open on screen.', C.blue);
bullets([
  'An order confirmed at two in the morning, while the office computer is off, is not lost. It waits, and it posts when the machine is next switched on.',
  'Placing an order and earning the money from it are two different things in a set of books, so they are two separate switches. A seller who invoices on despatch and one who invoices on payment are both normal.',
  'Glovia will not create a ledger or a stock item in the seller’s books unless they explicitly allow it. Creating something in somebody’s accounts is a change to a financial record, not a convenience.',
  'If a machine is lost or replaced, pressing Revoke stops it working on its very next attempt. There is no waiting period.',
]);
note('A pallet order arrives in Tally as units, with the pallets written beside it', 'Somebody orders two pallets, each holding fifty cartons of twenty-four. The voucher records 2,400 — because 2,400 is what leaves the warehouse and what the stock has to reconcile to. Recording “2” would tell Tally that two items left the building. The pallets are not thrown away to achieve that: the line and the narration both read “2 UK pallets × 50 cartons × 24 units = 2,400 units”, so the figure can be checked by anybody reading the voucher.', C.purple);
note('The same order never appears twice', 'A duplicate sales invoice is not a small problem — it is a tax return that does not add up, found weeks later. Three separate things prevent it, and the last of them is Tally itself refusing a second copy. An entry that has already been posted cannot be re-sent; the system refuses, rather than quietly making a second one.', C.orange);
note('A reply that says “success” is not taken at its word', 'TallyPrime answers a rejected request the same way it answers an accepted one. So a sending is only counted as done when Tally’s own figures say something was actually written and nothing was refused. If a ledger is missing, the entry is kept, the seller is told which ledger, and it can be sent again once it exists.', C.orange);
p('Everything that goes wrong is shown in plain words with what Tally itself said, minus anything that came from the seller’s own computer. Entries that could not be sent are kept and can be tried again; nothing is silently dropped.');

h2('6a.11i What each carrier can and cannot do');
p('Carriers do not all offer the same things, and the ones they do not offer are not missing features here. A seller sees only what their carrier can genuinely do, so nothing on screen fails when it is pressed.');
table(['', 'DHL', 'FedEx', 'India Post'], [
  ['Tell you the price', 'Yes', 'Yes', 'No live prices'],
  ['Create the consignment', 'Yes', 'Yes', 'No'],
  ['Cancel one afterwards', 'No', 'Yes', 'No'],
  ['Book the van to collect', 'Yes', 'No', 'No'],
  ['Follow the parcel automatically', 'Yes', 'Yes', 'No'],
  ['Check the address', 'Yes', 'Yes', 'Basic checks only'],
  ['Send the label a second time', 'No', 'No', 'No'],
  ['Give a signed proof of delivery', 'No', 'No', 'No'],
]);
bullets([
  'The label arrives once, at the moment the consignment is made, and neither carrier will send it again. So it is kept from that moment, and can be printed as often as needed.',
  'DHL will not cancel a consignment this way, so a seller who needs one stopped is told to telephone DHL — which is what they would have had to do anyway — instead of being shown a button that fails.',
  'FedEx will not book the collection this way, so a seller on FedEx arranges the van through their own FedEx account.',
  'Neither carrier hands back a signature, so the record of delivery is the carrier’s own status and the time it happened.',
]);
p('A seller delivering with their own team, or through a company that works for them, is not in this table at all, because nothing is being asked of an outside carrier. The job appears on that company’s own screen and their driver moves it along.');

h2('6a.11j Splitting a long delivery into four stages');
p('A seller who sends goods abroad rarely has one delivery. The goods go from the factory to a port, across the sea or by air, inland at the other end, and finally to the buyer’s door, and a different company often carries each part. On the Logistics screen in the Seller Hub, a seller can split the journey into four stages, say who looks after each one, and set what each one costs. The buyer then pays for all four at checkout.');
table(['Stage', 'From', 'To'], [
  ['1 — First mile', 'The seller’s factory or warehouse', 'The port or airport the goods leave from'],
  ['2 — International', 'That port or airport', 'The port or airport in the buyer’s country'],
  ['3 — Inland at the other end', 'The arrival port', 'A warehouse in the buyer’s country'],
  ['4 — Last mile', 'That warehouse', 'The buyer'],
], [2600, 3700, 3700]);
p('The seller chooses one of three ways of working:');
table(['Choice', 'What it means'], [
  ['Self Ship', 'The seller looks after all four stages: they choose the carrier and set the price for each.'],
  ['The marketplace', 'The seller looks after the first stage. The marketplace chooses the carrier and sets the price for the other three, and the seller can see them.'],
  ['Self and the marketplace', 'The seller looks after the first stage and ticks which of the other three they will also look after. The marketplace looks after the rest. At least one of the three has to stay with the marketplace — otherwise it is simply “Self Ship”.'],
], [3000, 7000]);
bullets([
  'The first stage is always the seller’s, whichever choice they make. The goods start in their building.',
  'Only the seller decides who looks after which stage. Marketplace staff can price and carry the stages they are given, but cannot change the seller’s choice.',
  'Changes are saved as a draft first, and buyers see nothing until the seller publishes. Changing who looks after a stage that is already live asks the seller to confirm, and orders already placed keep the arrangement they were placed under.',
  'Each stage has its own prices: from where to where, for what size and weight of load, by road, air, sea, rail or post, with which carrier, and how many days it takes. A seller can have different prices for different destinations.',
  'A blank price is never treated as free. A stage is only free when the seller marks it free and confirms it.',
  'A live price is never changed in place. Changing one makes a new version that replaces it when published, so a charge a buyer queries later can be shown as it stood.',
  'Before a carrier can be used, the seller switches it on: DHL, FedEx, India Post, or a forwarder they book themselves. Without an account connected, the seller books the carrier on its own website and types in the tracking number. Each carrier is only offered for what it can really do — DHL and FedEx by road or air, India Post by post, and a container by sea through a forwarder.',
  'A seller who never publishes any of this is not affected at all. Their delivery works exactly as it did before.',
]);
note('A missing price stops the sale, it is never guessed', 'If any stage has no price for the buyer’s address, the buyer is told that delivery from this seller needs a quote, and the order cannot be placed yet. Nothing is charged at zero, and nothing is borrowed from another route. Whoever looks after that stage is reminded until a price is published.', C.orange);
p('Once the seller accepts a paid order, the four stages appear on the order and are carried one after another. The first stage is the seller’s turn straight away; each later stage becomes ready when the one before it has been handed over, and whoever looks after it is told. Each stage already carries the carrier named on the price the buyer paid, so nobody has to choose it again; if that carrier can no longer be used, the stage waits for one to be chosen. On their own stages the seller can change the carrier (saying why); they type in the carrier’s own tracking number before the goods move, and record each handover. The stages the marketplace looks after are shown to the seller too, so they can follow the whole journey, but only the marketplace can change them. A delivery company given a stage accepts or refuses it and records its progress in its own portal.');

h2('6a.11k What you are paid after the marketplace fee');
p('The marketplace keeps a fee from what each seller sells. The buyer never pays this fee — it comes out of the seller’s share. The fee, what it is charged on, and any tax on it are set by the marketplace’s finance team, never by the seller.');
p('On the Logistics screen the seller can see a settlement preview. They type in a sale amount and the delivery they would charge on their own stages, choose the buyer’s country and, if they like, one of their own products. The fee can be different for different countries and kinds of product, so the system then works out, with today’s rules and exactly as it would for a real order, what they would be paid:');
bullets([
  'What the goods sold for',
  'plus the delivery money for the stages the seller looks after',
  'minus the marketplace fee',
  'minus the tax on that fee',
  'minus any refunds and adjustments',
  'equals what the seller can expect to be paid.',
]);
note('Delivery the marketplace carries is never the seller’s', 'Money for the stages the marketplace looks after goes to the marketplace, so it is never counted in the seller’s share and the fee is never charged on it. Depending on the marketplace’s rules, the fee is charged either on the goods alone or on the goods plus the seller’s own delivery money.', C.teal);
p('The preview cannot change anything. The real figure for an order is worked out once, when the order is confirmed, and kept with the version of the rules it used, so a change to the fee next month does not change what the seller was owed this month.');
p('When the buyer gets money back, the seller’s figure goes down once the payment company confirms the refund — not when it is only asked for, and never twice for the same refund. If the whole order is refunded, each seller gives back what they were owed for it. If only part of an order from one seller is refunded, that seller gives back their fair share of it, but not the tax or the marketplace’s delivery. If only part of an order shared by several sellers is refunded, the system cannot tell whose goods it was for, so it changes no seller’s figure and leaves it to the finance team. The marketplace fee is not given back on a refund.');

page();


// 7
h1('7. Admin Features — Secure Access, Roles and Dashboard');
h2('7.1 Staff sign-in');
p('Staff, customers and delivery partners sign in through what is visibly the same screen. The three surfaces are three different programs with three different jobs, but the page somebody lands on reads the same way on all of them: the language chooser, then one panel holding the title, a line saying who the screen is for, and the form, then a line explaining what to do if you have no account. Only that last line differs, because the answers genuinely differ — a customer can often create an account themselves, a member of staff is invited by an administrator, and a delivery partner is created by the marketplace.');
p('Getting this wrong is cheap to do and expensive to notice: before it was made one screen, the staff sign-in carried a badge above its title that the shop front did not, its links were a different blue, its button was a size smaller, and the "forgot your password?" link sat in a different place. Nobody reports a page like that as broken. They simply trust it slightly less.');
bullets([
  'Staff use a separate Admin Console from customers.',
  'Every member of staff signs in twice: once with their password, and once with a six-digit code from an authenticator app on their phone. It cannot be skipped. Until the code is given, the console does not open.',
  'Setting that up is a scan. The first time somebody reaches the step, the screen shows a square code to point a phone camera at. Beside it the same setting is printed as text, for a phone that cannot scan, and under both are ten one-time recovery codes for the day the phone is lost. Those ten are shown once and never again.',
  'The square code is drawn on the person\u2019s own screen rather than fetched as a picture from somewhere else, because it carries the secret that is the second factor.',
  'Leaving or reloading that page issues a new square code and the one already scanned stops working, so the page asks the person to finish in one go.',
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
p('The console opens on the work waiting for the team this morning, and on nothing else: one ring, and beside it a short written summary of what the ring shows. The month’s trading figures used to sit underneath and were moved out, because they are read once a week and a queue nobody has looked at is a seller waiting four days for a decision. Every one of those figures is on the screen that owns it — Reports, Orders, Payments, Inventory, Recurring — all still in the menu.');
bullets([
  'A ring shows everything waiting, in five groups: approvals, payments, stock, deliveries and the platform itself.',
  'Choosing a group singles it out, and the written summary beside the ring is then about that group. The screens where that work is decided are in the menu on the left.',
  'A member of staff only ever sees the queues they are allowed to act on. A queue somebody cannot act on is absent from their chart rather than shown as an empty one, so the chart never reveals that a queue exists to somebody who may not see it.',
  'Work somebody has already taken on, or already finished, is not counted as waiting. A number nobody can clear is a number everybody learns to ignore.',
  'The reporting period can be today, the last seven days, the last thirty days, or any two dates.',
]);
h2('7.3a The trading figures, and the bell');
p('The month’s figures are not on the dashboard. They are on Reports, which is where somebody goes to read them properly: orders, gross sales, collected payments, net revenue, average order value, low stock and upcoming repeat orders, each against the period before it and each showing the shape of the days behind it, so a total that arrived in one afternoon does not look like a steady month. Where the period before holds nothing to compare against, the figure says so rather than showing a rise out of nothing.');
bullets([
  'Change reporting period and refresh business totals.',
  'Use the notification bell for events such as staff sign-ins, customer activity, order/payment changes, certificates a seller has sent in, and operational alerts.',
]);
p('The bell keeps two kinds of message apart, because they finish in opposite ways. Something that simply happened — a customer placed an order, a colleague signed in — is finished when the person looking at it has read it, and reading it changes nothing for anybody else. Something that has gone wrong — a delivery that failed, goods that got too warm, a data protection request with a legal deadline running, a certificate nobody has decided — stays on the bell until the problem itself is dealt with, for everybody, however many people have looked at it.');
bullets([
  'Reading a warning does not make it go away. It goes away when the thing behind it is put right, and the system does that itself at the moment the work is completed.',
  'A member of staff can hide a warning from their own bell without touching anybody else’s, which is for the case where it is a colleague’s job. That never makes the problem look solved.',
  'There is no button that lets someone close a warning about money, goods, compliance or stock by hand. Those close when the work is finished. The one thing a member of staff may close by hand is a delivery that no carrier has picked up, because arranging collection over the telephone leaves no other record — and that needs a written reason, which is kept.',
  'Nothing is deleted. A “Resolved” view keeps every warning that has been dealt with, together with who closed it, when, and the reason they gave.',
  'If the same problem comes back, the bell raises it again as a fresh warning and marks which time round it is, so the earlier record of what was done is not overwritten.',
  'A warning nobody has resolved is never cleared away by age, however old it gets.',
]);
p('The list of screens down the side of the console also says what is waiting. Any entry with a queue behind it carries a number when there is something in it: listings sent for quality review, brands asked for, orders held for approval, sign-ups waiting to be let in, data protection requests, deliveries that have gone wrong, and seller applications together with the certificates attached to them.');
bullets([
  'The bell says what has happened lately and what is still wrong, one message at a time, each linking to the screen that deals with it. These numbers count the same queues from the other end.',
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
h2('8.1a Building the forms a product comes in');
p('A product that comes in several forms needs one entry per form, each with its own reference number, price and stock. Typing forty of those by hand is slow and it is where mistakes get made, so staff are given a builder instead.');
p('Every section of the catalogue carries a suggested list of the ways things on that shelf are normally sold. Cables are normally sold by number of cores, thickness and length. Clothing is normally sold by size and colour. Twenty-four departments and a hundred and twelve sections each carry their own list, so a member of staff listing a cable is asked about cable things and a member of staff listing a lipstick is asked about lipstick things.');
table(['Step', 'What staff do'], [
  ['1. Choose what this product varies by', 'Switch on only the ways this product really differs. The suggested list is advice, not a form to fill in: a product that comes in one colour has nothing switched on for colour.'],
  ['2. Enter the values', 'Pick from the suggestions with one tap, or type values of their own. Values can be reordered, because the order is the order a buyer sees.'],
  ['3. Look at the table', 'Every combination is listed, with the reference number it would be given and whether it already exists. Nothing is saved yet.'],
  ['4. Save', 'Only the new rows are created. Anything that already exists is left exactly as it is.'],
], [3200, 6800]);
bullets([
  'Generating never deletes anything and never overwrites anything. A form that already exists keeps its price, its stock and any reference number staff typed themselves, so the builder is safe to use twice — and people do use it twice.',
  'Reference numbers are suggested, not imposed. The same combination always gets the same suggestion, so running the builder again does not change numbers already printed on labels, and any of them can be edited in the table before saving.',
  'The builder warns above a hundred combinations and refuses above five hundred. Neither is a technical limit; both are the point past which nobody reads the table before saving it.',
  'Two forms of one product can never describe themselves the same way. “Black” and “black” are one colour, and the system refuses the second rather than leaving two identical rows a buyer could be given either of.',
  'Switching off one of the ways a product varies is not destructive. Forms that already carry a value for it keep it and keep selling; it simply stops being offered as a choice. Staff are told how many are affected before saving.',
  'Each form can carry its own price, its own “was” price, its own barcode, its own smallest order and step, its own lead time, its own pack make-up, its own shipping weight and box size, and its own photographs. Anything left blank uses the product’s own figure.',
  'A “was” price below the price it is being compared against is refused. A saving that is not a saving is worse than no saving shown.',
  'Sections of the catalogue with no suggested list — including medical devices — keep the simpler editor they have always had, where staff describe each form in their own words.',
]);
note('What is not one of the ways a product varies', 'Country of origin, warranty wording and installation notes describe the product but do not change what leaves the warehouse — they are specifications. A smallest order of ten boxes is a term of trade, told to the buyer rather than chosen by them. A batch number and an expiry date belong to the stock sitting in a warehouse: a 500 g packet is the same product whichever delivery it came out of, and treating a batch as a form of the product would give the catalogue a new reference number every week.', C.purple);

h2('8.2 Price on request, and taking something off sale');
p('Two switches decide whether a customer may buy a product. They are separate from publishing, which decides whether a customer may see it at all.');
table(['Setting', 'What the customer sees', 'When to use it'], [
  ['Price on request', 'The listing shows “Request a quote” where the price would be. Pressing it opens an email to the business’s support address naming the product, or calls its support number. Nothing can be added to a cart.', 'A range the business quotes per account, or per volume, rather than at a list price.'],
  ['Available to order (off)', 'The listing, the specifications and the packaging stay readable. A notice says it cannot be ordered, in the words the business chose.', 'A product that is made but held this month. Unpublishing would make the page disappear entirely.'],
], [2200, 4400, 3400]);
bullets([
  'A product priced on request can be published without a price, and without a photograph. Everything else still has to be complete.',
  'Both settings are enforced by the system on every cart change and again at checkout, so they cannot be worked around from a browser.',
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
  'A product with a placeholder behaves like any other: it can be added to a cart, bought, and put on a repeating plan.',
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
  ['That seller’s prices', 'Every figure — in the list, on the product, in the cart — is the seller’s own. The marketplace’s price is never shown there.'],
  ['That seller’s name and contact details', 'The shop is branded to them, and questions go to them rather than to the marketplace.'],
  ['Category counts that match the shelf', 'A category saying four means four, not the number the marketplace as a whole has.'],
], [3200, 6800]);
note('Their own logo on it', 'A seller can upload their own mark from their profile page, and it appears at the top of their shop beside their name. Until they do, the shop shows the first letter of their name — never the marketplace’s own logo, which would tell a buyer they are somewhere they are not. Replacing one removes the old file; removing it puts the letter back.', C.blue);
note('Only real pictures are accepted', 'What a file actually is decides whether it can be used, not what it is called. A drawing format that can carry instructions is refused however it is named, because the shop serves it on the seller’s own web address to their own buyers.', C.orange);

note('The address decides the seller', 'Nothing a visitor can change decides whose shop they are in — only the web address they came to. That is what makes it impossible to be shown one seller’s price and charged another’s.', C.orange);
note('An address that belongs to nobody', 'A made-up name in front of the domain shows “no shop here” rather than quietly showing the marketplace’s own shop under somebody else’s name. A seller who has been suspended has no shop either.', C.purple);
note('Off unless it is set up', 'A business that sells everything itself never sees any of this. Seller addresses only exist once the business configures the domain they hang off.', C.teal);

note('Buying from a seller', 'Goods bought from a seller leave that seller’s own building, so the buyer is never asked to choose one of the marketplace’s warehouses for them. Checkout says who is sending the order instead, and the seller confirms the dispatch date when they accept it. A cart holding both — something from the marketplace and something from a seller — asks the warehouse question only about the part the marketplace is sending, and says plainly that the rest comes separately and may arrive on a different day.', C.blue);
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

h2('8.10a Quantity discounts');
p('Staff can offer “buy more, save more” on every product the store sells itself, with one short list of rules — for example 3% off from 10 pieces, and 5% off from 50. Buyers see the offer the moment they raise the quantity, and the basket charges it.');
table(['Staff do', 'What the system does'], [
  ['Add a rule: from how many pieces, and how much off', 'Shows straight away what that means on an item priced 1,000 — the new price per piece and the saving — and the sentence a buyer will read, such as “Add 9 more pieces and save 30.00 per piece”.'],
  ['Pause a rule', 'Stops that discount without deleting it, so it can be switched back on later.'],
  ['Save', 'Checks all the rules together. A rule must start at 2 pieces or more, take off between 0.01% and 90%, and a larger quantity can never save less than a smaller one. Each problem is shown under its rule. Every save is recorded in the audit log.'],
], [4200, 5800]);
bullets([
  'It covers every product the store sells itself, in every currency. There is nothing to set per product.',
  'It never changes a marketplace seller’s product. A seller is paid what their product sells for, so sellers set their own quantity prices instead.',
  'Nothing is discounted until staff add a rule. With no rules, every quantity pays the normal price.',
  'The saving is rounded down to the smallest coin, so a buyer promised 5% off is never charged more than 95% of the price.',
  'Repeat orders get the same discount as the basket for the same quantity.',
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
  ['Address suggestions', 'Start typing the address and choose the right place from a list. The town, region, postal code, country and map position are all filled in together, and the map beside the form shows the pin straight away so it can be checked before saving. A part the lookup does not know is left exactly as typed.'],
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
note('Customer and warehouse link', 'Customers can see eligible shipping warehouses in the cart. Admin staff configure the warehouse delivery range, operating state, lead time and fee information that makes this possible.', C.orange);
h2('9.4 Seeing where sellers dispatch from');
p('On a marketplace, a growing share of what a buyer orders never passes through a building the business owns. It ships from a seller’s own depot. The Warehouses screen therefore offers three views, chosen by a control under the title: the business’s own warehouses, one seller company’s dispatch places, or every seller’s at once.');
bullets([
  'Search the approved seller companies by name or code, and pick one. Suggestions appear as the name is typed and can be moved through with the keyboard.',
  'See that seller’s dispatch places on the same map and in the same table as the business’s own, with the owning company named on every row.',
  'See, for each place, where it is, whether it can dispatch today and the seller’s own reason if it cannot, what it is equipped to handle, how much stock is held there, and when those figures last agreed with the seller’s own system.',
  'Filter by country, include places the seller has closed, and clear the choice to go back.',
  'Switch to every seller at once to compare where the whole marketplace can ship from.',
]);
bullets([
  'Only businesses whose seller application has been approved and whose account is still live can be chosen. An application still being decided, one that was refused, and a seller who has been stopped are all absent — and the rule is applied to the information itself, not only to the search box, so there is no way round it.',
  'The view is read-only. A seller’s places are theirs to maintain in their own workspace; anything that needs changing is asked of them.',
  'Both the warehouse screen and the ability to look a company up are needed to use it. Staff who count stock but do not deal with companies simply do not see the control.',
  'A place whose position has never been looked up still appears in the table, marked, so nothing is quietly missing from the list because it is missing from the map.',
  'Nothing about the business’s own warehouse view changed. It is the same screen it always was, and it is what opens by default.',
]);
note('What is deliberately not shown', 'A seller’s connection details to their own system — addresses, keys, credentials — never appear here. What is shown is when the stock figures last agreed, which is what a member of staff needs in order to trust the number beside it.', C.blue);
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
  'Review payment status: created, pending, captured, failed or refunded — and, for card payments, whether the customer has opened Stripe’s payment page, whether it was partly or fully refunded, and whether the customer’s bank has disputed it. The card brand and last four digits are shown.',
  'When a customer’s bank disputes a card payment, the payment is marked, finance is alerted, and the order keeps its status until somebody decides what to do.',
  'If money arrives for a payment the shop had already given up on, or for an order that was already paid, it is still recorded and finance is alerted, so nothing is lost or taken twice without anybody knowing.',
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

h2('10.4 Preorders');
bullets([
  'See every bulk preorder between buyers and sellers, filtered by status, under Sales → Preorders.',
  'Open one to see what was asked, every set of terms the seller proposed with its reference, what the buyer agreed to, the order it became and the full history.',
  'On a seller’s preorder, staff cannot answer for either side or change its terms. It is a negotiation between the buyer and the seller, and the screen is for support and audit.',
  'On a product the shop sells itself, the shop is the supplier: staff with permission to fulfil orders answer the preorder here — accept, counter, refuse, then mark production started and ready. A new request rings the bell, and the buyer is told the shop’s name, not the staff member’s.',
  'When the buyer has paid and the goods are ready, staff start fulfilling the order as usual, which hands the preorder over to delivery.',
  'A filter shows only the preorders the shop answers itself.',
  'When a seller proposes a later date or a split delivery, staff see the proposal, its delivery dates and any stock set aside, but cannot change it. Staff answering the shop’s own products cannot yet make this kind of proposal themselves, and the shop’s own products do not offer containers or set stock aside for a preorder.',
]);

h2('10.5 Sellers’ invoices and packing lists');
bullets([
  'On any order, staff with permission to read invoices can see and download every invoice, credit note and packing list the sellers issued for it.',
  'Staff cannot change, cancel or reissue a seller’s invoice. It is the seller’s legal document, and only the seller can correct it, with a credit note.',
  'The business’s own invoice for its own sales is separate, and works as before.',
]);

h2('10.6 Delivery stages the marketplace looks after for sellers');
p('When a seller gives the marketplace some of the four delivery stages (see 6a.11j), staff price and carry those stages. Two screens under Logistics carry this.');
table(['Screen', 'What staff can do', 'What the system does'], [
  ['Delivery levels', 'See every seller who has published their delivery stages, who looks after each stage, and which stages still have no price. Filter to the sellers waiting on a marketplace price. Open a seller to add, publish or switch off the marketplace’s prices for their stages, and see every change made to the seller’s arrangement.', 'Refuses a price on a stage the seller looks after. Tells the seller when the marketplace publishes a new price, and records every change in both the business’s and the seller’s history.'],
  ['Delivery legs', 'See every stage of every confirmed order, filtered by who looks after it, how far it has got, or only the ones still waiting for a carrier. Each stage already shows the carrier on the price the buyer paid. Change the carrier for a stage the marketplace looks after, enter its tracking number and dates, and record it starting and being handed over.', 'Only lets the marketplace give its stages, and name on its prices, a delivery company it works with directly, never a seller’s own fleet. Makes the next stage ready when one is handed over, and tells the seller at each step.'],
], [1900, 4300, 3800]);
p('On the same Delivery levels screen, the business chooses whether buyers see a price for each stage or one delivery line. The order keeps every stage’s price either way.');
note('Different staff, different keys', 'Seeing all of this, pricing the marketplace’s stages, and putting a carrier on a stage are three separate permissions, so the person who agrees prices is not automatically the person who dispatches.', C.blue);

h2('10.7 Platform fees');
p('The finance team sets what the marketplace keeps from each seller’s sales, under Finance → Platform fees. Other administrators do not see this screen, and cannot change it.');
bullets([
  'A fee can be a percentage, a fixed amount, or both, with an optional lowest and highest amount.',
  'It can apply to the whole marketplace, to one country, to one category of products, or to one seller. The most specific one wins: a seller’s own terms, then the category, then the country, then the marketplace as a whole. A seller with an agreed commission rate keeps that rate unless a fee is set for that seller specifically.',
  'Each fee says what it is charged on: the goods alone, or the goods plus the delivery money for the stages the seller looks after. It is never charged on stages the marketplace carries.',
  'A tax can be set on the fee. It is shown as a configured rate until somebody with the authority to do so records that it is the correct legal rule. Only then is it called by its tax name, such as GST.',
  'Fees are drafted, then published. A published fee is never changed; publishing a new one replaces it, and every order already settled keeps the version it was settled on. Staff can see which orders were settled on each version.',
  'A preview shows what a chosen seller would be paid on a given sale under today’s fees, without saving anything.',
  'Nothing is set out of the box. Until the finance team publishes a fee, sellers are charged the marketplace commission exactly as before.',
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
h2('11.1a Preorder Chats — answering customers live');
p('Customers’ questions from the product page arrive in Preorder Chats in the admin menu. The menu item shows how many customers are waiting for an answer, and the number changes the moment somebody writes.');
table(['Staff member does', 'The system does back'], [
  ['Opens Preorder Chats.', 'Shows the queue: who is asking, about which product and seller, the last message, how long they have waited, who is handling it, its status and priority. The wait turns amber when it nears the business’s target time and red when it passes it, with words as well as colour. It can be filtered (unassigned, assigned to me, unread, high priority, waiting for the customer, resolved and more), searched and sorted — for example the oldest unanswered first.'],
  ['Opens a conversation where the customer asked for a person.', 'Shows it in the “Human requested” view with a “Human assistance requested” label and the question they were on. The questions the customer picked and the automatic answers they read come first, marked “Automated”, so staff know exactly what the customer was already told. The staff member’s first reply tells the customer that a person has joined.'],
  ['Opens a conversation.', 'Shows the messages, and beside them the product as the customer saw it when they asked and a link to the product as it is now, the customer, the seller and any linked preorder.'],
  ['Replies, pressing Enter to send or Shift+Enter to start a new line.', 'Sends the reply to the customer at once, only once however the key is pressed. The first reply puts the conversation in that staff member’s name.'],
  ['Scrolls back to read older messages.', 'Keeps their place when the customer writes again, and shows a “new messages” button instead of jumping. Pressing it goes to the newest message.'],
  ['Takes, hands over or releases a conversation.', 'Moves it between staff. Handing it to a colleague sends them an email. Only people allowed to assign can give a conversation to someone else.'],
  ['Marks it waiting for the customer, waiting on a colleague, resolved or closed.', 'Tells the customer where it stands, in simple words. A closed conversation stays readable.'],
  ['Writes an internal note.', 'Keeps it for staff only, on its own tab, in a different colour. Customers never see it. A note is saved with its button (or Ctrl+Enter), never by Enter alone, so it cannot be sent by accident.'],
  ['Sends a preorder proposal.', 'Works out the pieces from the seller’s checked figures and sends the customer a card they can turn into a preorder request. A new version replaces the old one.'],
  ['Removes a message that should not be there, or blocks an abusive customer.', 'Keeps a record of who did it and why. Removing a message keeps a secure fingerprint of it, not the words. A blocked customer cannot start new chats on any product.'],
], [4200, 5800]);
bullets([
  'Who can do what is decided by role. By default the business owner can do everything; the order desk can read and reply; finance can read. Giving conversations to others, removing messages, blocking and downloading a transcript are separate permissions.',
  'If a customer waits longer than the business’s target time, the notification bell raises an alert that only a reply clears.',
  'Staff can switch on desktop alerts. They say that a customer has written, never what they wrote.',
  'Everything that is decided about a conversation is recorded in its activity list and the audit log.',
]);

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
note('Off unless it is turned on', 'Until the business enables the logistics portal, a carrier cannot use it: every carrier screen refuses, and messages from carriers’ own systems are turned away. The Logistics section of the business’s own console is still there, so staff can set carriers up in advance and switch the portal on when they are ready.', C.orange);

h2('12a.0 Where a delivery comes from');
p('Nobody types a delivery in. As soon as an order is paid for, the system raises one for each place the goods have to leave from, and it is waiting in the list before anybody looks at it. Goods the business sells itself leave the warehouse the order was priced against. Goods an outside seller sells leave that seller’s own place. An order with both raises one of each, because two lots of goods in two buildings cannot be collected as one.');
table(['Situation', 'What the system does'], [
  ['The business’s own goods', 'Raises one delivery, collected from the warehouse the order was priced against.'],
  ['An outside seller with one place to collect from', 'Raises one delivery, collected from that place, as soon as the order is paid for.'],
  ['An outside seller with several places', 'Waits. The seller says which of their places it leaves from when they accept the order, and the delivery is raised at that moment. Nobody else’s delivery waits with it.'],
  ['The same payment confirmed twice', 'Nothing new. A delivery already raised is not raised again.'],
], [3400, 6600]);
note('A delivery is never given to a haulage company automatically', 'It is raised with nobody carrying it, and somebody chooses who takes it. A delivery that arrived already allocated would carry no record of who chose the company, and that is the first question asked when something goes wrong.', C.orange);

h2('12a.0a A seller choosing who carries their own goods');
p('A seller who sends goods from their own place can choose the haulage company that collects them, instead of waiting for the marketplace to choose one. They choose from their own list, and only from their own list.');
p('The two jobs are kept apart, and this is the whole idea of it:');
bullets([
  'The SELLER chooses the haulage COMPANY for their own paid delivery.',
  'The haulage company chooses the DRIVER for the deliveries it has accepted.',
]);
p('A seller never sees, adds, edits or chooses a driver. Who drives for a haulage company is that company’s own business — their staff, their rota, their problem when somebody calls in sick — and a seller who could put a name on a van could leave one stranded. Equally, a haulage company never sees a seller’s other deliveries.');
table(['What the seller does', 'What the system does'], [
  ['Asks to use a haulage company', 'The request goes to the marketplace. A seller cannot approve their own, so nothing happens until somebody at the business agrees to it.'],
  ['Waits for an answer', 'The seller can see, on their own carriers page, whether the request was agreed, refused, paused or ended, and the reason. Somebody who cannot see that their request was refused three weeks ago simply asks again.'],
  ['Opens a paid delivery', 'The seller sees which of their haulage companies can take this particular delivery, and which cannot with the reason why.'],
  ['Chooses one', 'The delivery is offered to that company, exactly as it would be if the business had chosen them. They accept or refuse it in the usual way.'],
  ['Changes their mind', 'The first company is told they no longer have it, and a written reason is required. Both are kept in the record.'],
], [3400, 6600]);
note('Until somebody sets this up, nobody can do it', 'A business that has never agreed any of these arrangements has none, and no seller can offer work to anybody. That is the intended starting point, not something missing: the business’s own way of allocating deliveries carries on exactly as before.', C.blue);
p('Three screens carry this. In the seller’s own area, **Carriers** lists every arrangement they have — including the ones that were refused, paused or ended, with the reason each time, because a seller who cannot see that their request was turned down three weeks ago will simply ask again. On a paid order, the delivery itself carries the chooser. And in the business’s own console, **Carrier arrangements** is the queue where somebody decides.');
p('The chooser on a delivery lists the haulage companies that cannot take it as well as the ones that can. The ones that cannot are greyed out with the reason beside them, because a seller looking at an empty box cannot tell whether they have no companies at all, their one company is paused, or it does not go where this parcel is going — and those are three different things to do next.');
note('A seller asks for a company by its reference', 'Not from a list of everybody the business works with. Who the business has haulage agreements with is its own commercial information, and showing it to every seller on the platform would be handing that out to anyone who signs up. The seller is given a reference by the business or by the haulage company, and types it.', C.blue);

h2('12a.0b What the seller hears back');
p('Handing a delivery to a haulage company used to be the end of what the seller could see. They were not told when it was accepted, when it was turned down, or when the offer simply ran out unanswered — the parcel sat somewhere only the business could look. Four notices close that gap.');
table(['What happened', 'What the seller sees'], [
  ['The business decided their request to use a company', 'A notice saying yes or no, with the reason. Read once and done.'],
  ['The haulage company took the job', 'A notice naming them. Read once and done.'],
  ['The haulage company turned it down', 'A WARNING that stays until the delivery is given to somebody else, with the reason they gave.'],
  ['The offer ran out with no answer', 'A WARNING that stays until the delivery is given to somebody else.'],
], [3600, 6400]);
note('The last two cannot be cleared by reading them', 'Because reading them does not change anything: the parcel still has nobody carrying it. They stop counting against the seller only when the delivery is actually handed to another company. The first two are ordinary notices and clear when read, per person — a seller with twelve staff does not need twelve copies.', C.orange);
bullets([
  'Nothing is ever deleted. A notice that stops needing attention is kept, with the date it stopped and what it was that fixed it — that is the record somebody reads after a bad week, and a notice that vanished when the problem was solved would erase it.',
  'Two companies turning down the same delivery is two entries, because the seller needs both reasons. It is still one problem, so handing the parcel to a third company clears both at once.',
  'The same thing is never announced twice. If a message about one event arrives repeatedly — which happens, because systems retry — the seller is told once.',
]);
p('An arrangement is checked again every single time it is used, not only when it is agreed. It has to still be agreed, still be inside its dates, not be paused, belong to a haulage company that is itself still working, cover both the place the goods leave from and the place they are going, and cover any special handling the goods need — refrigeration, for instance. The seller is told which one of those failed, because “you have no haulage companies”, “yours is paused” and “yours does not go to Portugal” need three completely different responses.');
bullets([
  'An arrangement can only narrow what a haulage company already does. A seller cannot give one the ability to reach a country it does not serve, or to carry something it is not approved to carry.',
  'Where the goods leave from is checked as well as where they are going. A company agreed for Poland has not agreed to carry from Poland to Portugal.',
  'Paused and ended are different. A paused arrangement finishes the parcels already on a van and takes no new ones; ending it the other way would strand them.',
  'A seller asking about somebody else’s delivery is told it does not exist. They are not told that it exists and is not theirs.',
  'Naming a haulage company the seller has no arrangement with is refused in exactly the same words as naming one that does not exist, so the list of who the marketplace works with cannot be discovered a guess at a time.',
]);
note('If it cannot be raised yet', 'Nothing is lost and the order is never affected — it is paid for and confirmed either way. The Consignments screen has a button to raise it by hand, and the system says what it is waiting for, such as a seller who has not yet said which of their places the goods leave from.', C.blue);

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
  ['How many boxes, how heavy, and what kind of goods they are', 'The seller’s tax invoice, and every price on it'],
  ['The seller’s packing list, once the seller issues it: what is in each box, batch numbers, weights — with no prices', 'The product names and quantities before the seller has packed and issued that list'],
  ['Handling requirements — refrigerated, sterile, fragile, dangerous', 'Any payment detail, and any other company’s credentials'],
  ['Their own documents and their own proof of delivery', 'Anything at all belonging to a different haulage company'],
], [5000, 5000]);
note('Telephone numbers are hidden by default', 'A contact number is shown with most of it replaced. It is revealed in full to exactly two people: the driver whose round that stop is on today, and whoever is dealing with an open problem on that delivery.', C.blue);

h2('12a.4 The carrier’s own screens');
table(['Screen', 'What it is for'], [
  ['Dashboard', 'One ring showing the whole workload split into the eight stages a dispatcher does something about, and beside it a short written summary of what the ring shows. Nothing else — see below.'],
  ['Consignments', 'The full list, with filters, search, saved filters and a spreadsheet export of whatever is on screen. It can be narrowed to one driver, or to only the deliveries with a problem open on them.'],
  ['One consignment', 'The route, everything that has happened to it, the boxes, the contacts and the documents — where the status is changed, and who is driving it, including everyone who has driven it before and why it moved.'],
  ['Collections', 'What has to be picked up, and confirming that it was.'],
  ['Dispatch', 'Building a load and handing it over.'],
  ['Problems', 'What has gone wrong, and recording what was done about it.'],
  ['Companies', 'The businesses this carrier collects from and delivers to.'],
  ['Drivers and vehicles', 'The fleet. Add somebody by typing their name, add the vans and trucks, and see who is free.'],
  ['My Profile', 'The company’s full profile: its details, contacts, where it works, what it can do, its compliance documents, how its connections are doing, and its account security. See below.'],
  ['My company', 'Their own details, their people and their invitations.'],
  ['My round', 'A driver’s stops for the day, made for a phone.'],
], [2600, 7400]);
note('No pretend tracking', 'Where nothing has reported a position, the map says so plainly or shows the last place the parcel was actually seen and when. Nothing animates a van along a route it might be taking. Beside every map is the same journey written out as a list of places and times, so it can be read without seeing the map at all.', C.orange);
note('What the buyer sees when the haulage company moves it', 'The moment a carrier records that they have collected a parcel, the buyer’s own order page moves on with it — to “being prepared” and then “on its way”, each with a line saying a carrier now has it. The buyer is never shown the word consignment, and never has to go looking somewhere else to find out where their order has got to. When the carrier confirms the delivery, and every parcel on the order has arrived, the order says delivered. An order that has already been cancelled is left alone.', C.teal);

h2('12a.4a The dashboard ring');
p('The dispatcher’s whole dashboard is a ring of everything assigned to their company, split into the eight stages somebody actually does something about — waiting for your answer, accepted, collected, in transit, out for delivery, delivered, a problem, and going back or cancelled — with a short written summary of it beside. There is nothing underneath: the counters, the service figures, the problems, the pickups and the day’s deliveries each have a screen of their own, all still in the menu.');
bullets([
  'Choosing a stage singles it out, and the written summary beside the ring is then about that stage. The same set can be opened in full on the Consignments screen.',
  'The exact counts and percentages are listed beside the ring, and the same figures can be shown as a table, so nothing has to be read off the picture.',
  'A failed delivery is never shown the same way as a completed one. A parcel going back is shown as work with a different destination rather than as something that has gone wrong.',
  'The period can be today, the last seven days, the last thirty days, or any two dates.',
]);
p('Choosing one driver narrows every figure on the screen, not just the list. A count of problems shown beside one driver’s work would otherwise be a figure about somebody else. The choice is part of the web address, so a dispatcher can send a colleague exactly the view they are looking at.');
p('Where an order was split into several parcels, each keeps its own place in the ring and its own tracking. Two parcels of one order are never rolled together into a single history, because they can be in two different places on two different days.');

h2('12a.4b My Profile: the carrier’s own company profile');
p('A haulage company keeps everything the marketplace knows about it on one page. The owner and the partner administrator can change it. Dispatchers, operations staff and people who only follow deliveries can read it. Drivers do not see it. A company only ever sees its own profile.');
p('The top of the page shows the company’s logo, its names, its partner ID with a button to copy it, whether the account is active, whether the company has been verified, and whether a change is waiting for review. A ring shows how complete the profile is, and a list says what is still missing.');
table(['Tab', 'What the company finds there'], [
  ['Overview', 'A summary of the whole profile and what is still to add.'],
  ['Company details', 'Its names, registration and tax numbers, addresses, website and a short description.'],
  ['Authorised contacts', 'The main contact, an emergency contact, support, and billing.'],
  ['Service coverage', 'The regions the marketplace has approved, and the company’s own hubs and warehouses.'],
  ['Logistics capabilities', 'What the marketplace has approved it to carry, what its fleet shows, the kinds of transport it says it offers, its time zone and its opening hours for each day.'],
  ['Compliance and documents', 'Its licence, insurance and permit documents, and whether each one has been accepted.'],
  ['Integration status', 'Whether its DHL, FedEx, India Post, GPS and tracking connections are working.'],
  ['Account and security', 'The person’s own role, their two-step sign-in, and — for people allowed to see it — a history of changes to the profile.'],
], [2800, 7200]);
table(['What the company changes', 'What the system does'], [
  ['Contacts, website, description, working address, opening hours, time zone, hubs, and the kinds of transport it offers', 'Saves the change straight away.'],
  ['Legal name, trading name, registration number, tax number, country, registered address, or transport licence', 'Does not change the live record. It sends one change request to the marketplace. The old details stay in use until a member of staff approves. The company can withdraw the request, and a newer request replaces an older one.'],
  ['Uploads a document', 'Checks it really is a PDF or a picture, whatever its name says, and that it is no bigger than 10 MB. Scans it for viruses, then keeps it privately. A newer file of the same kind takes the place of the older one, which is kept.'],
  ['Downloads a document', 'Gives a link that works once, for a few minutes, and only for that person.'],
  ['Changes its logo', 'Accepts a normal picture file, checks it and scans it.'],
], [3600, 6400]);
bullets([
  'Changes are kept in one draft across every tab. A bar at the bottom counts them and offers to save or discard. Leaving the page with unsaved changes asks first.',
  'The business licence, insurance certificate and transport permit are required. Each one shows as missing, waiting for review, verified, not accepted, or expired.',
  'Fleet size, cold vehicles, delivery levels and the transport it is priced for are worked out from the company’s real vehicles, drivers and prices. Nobody types them in.',
  'A connection only says “Connected” once it has really worked. Passwords and keys are never shown.',
  'Some things only the marketplace can change: the account status, the contract, the approved regions and capabilities, and whether the company is verified. A company cannot widen its own regions or capabilities.',
  'There are no bank details, because the system does not pay carriers.',
]);

h2('12a.5 Drivers, and who is carrying what');
p('Each haulage company keeps its own list of the people who drive for it and the vehicles they drive. A driver is simply a name on that list. Nobody needs an account, an invitation or an email to be added — somebody types their name, and they can be sent out that afternoon. That matters because a haulage company employs people who will never use this software at all: an agency driver covering a round, a subcontractor, somebody who started this morning.');
table(['What a dispatcher can do', 'What the system does'], [
  ['Add a driver', 'The owner types their name. A telephone number, an email address, a staff number, a licence and its expiry date, and what they are trained and licensed to carry can all be added, and all of them are optional. Nothing here creates an account or sends anybody an email.'],
  ['Give a driver the phone app as well', 'Where the driver is also somebody who signs in to the haulage company’s own screens, their account can be linked to their driver record. That is what gives them their round on a phone, the barcode scanner, and the ability to capture proof of delivery. It is optional, and most of a fleet does not have it.'],
  ['Add a vehicle', 'A registration and a type. A refrigerated vehicle also records the coldest and warmest it holds, which is how the system knows whether it can take a temperature-controlled delivery. The maximum load is entered in kilograms.'],
  ['Search and filter the list', 'Find somebody by name or staff number, or show only those currently on the rota.'],
  ['See who is busy', 'Every driver shows how many deliveries they are holding right now, so the next one goes to somebody who can take it.'],
  ['Put a driver on a delivery', 'The delivery becomes theirs and appears on their round. A vehicle can be named at the same time, and does not have to be. Only one driver holds a delivery at a time.'],
  ['Send it on the way', 'One button on the driver’s card moves the delivery to its next step — collection booked, collected, on its way, out for delivery — offering only the step that actually comes next. It is the same action as the status form beside it, in one press.'],
  ['Move a delivery to somebody else', 'A written reason is required. The previous driver stays in the record, with the reason, so who carried what is never lost.'],
  ['Take a driver off without replacing them', 'For the case where somebody has called in sick and nobody has been found yet.'],
  ['Stand a driver down', 'They stop being offered work. Nobody with delivery history is ever deleted, because their past deliveries would stop making sense. If they are still holding deliveries, the system says how many and asks before doing it.'],
], [3200, 6800]);
note('The business running the marketplace can do all of this too', 'Adding a driver or a vehicle, putting somebody on a delivery, moving it to someone else, taking them off and sending it on the way are all available to the marketplace’s own operations desk as well as to the haulage company. This is for the times the haulage company cannot do it themselves — their screens are down, or they are a small firm who work from a phone and ring in. It is the same list, not a separate copy: a driver added by the operations desk appears on the haulage company’s own screen straight away. The desk can only ever use the fleet of the company that already has that delivery, and everything it does is written into that company’s own record of who did what, marked as having been done by the marketplace.', C.blue);
bullets([
  'A driver is put on a DELIVERY, not on an order. One order can be split between sellers and buildings, and those parts can travel with different haulage companies on different days — so each part gets its own driver.',
  'Two people in the same office pressing “assign” at the same moment cannot put one delivery on two vans. One of them succeeds and the other is told to look again.',
  'A delivery is refused to a driver who is not on the rota, who belongs to another company, who is not cleared for what is being carried, or whose licence has run out — and to any delivery that has already finished.',
  'Nobody can put one haulage company’s driver on another company’s delivery. The system works out whose fleet to use from the delivery itself; it is never something anybody chooses.',
  'When a delivery is completed, returned, lost or cancelled, it comes off that driver’s list automatically.',
  'Everyone who has carried a delivery is kept, in order, with who put them on it and why it moved. This is what gets read when a delivery has gone wrong.',
]);

h2('12a.6 What the business sees');
table(['Screen', 'What it is for'], [
  ['Consignments', 'Every delivery, whoever is carrying it — including the ones nobody is carrying yet, and which person at the haulage company is driving each one.'],
  ['One consignment', 'Offer it to a carrier, take it back, correct a status that was recorded wrongly, and read the whole history — including every driver who has held it and why it changed hands. From here the operations desk can also put one of the carrier’s drivers on it, name the vehicle, move it to somebody else, take them off, and send it on the way.'],
  ['Delivery problems', 'The queue across every carrier, worst first and then oldest first.'],
  ['Carriers', 'Add a haulage company, invite its first person, and see how much each one has on.'],
  ['One carrier', 'Its registration and contract, where it operates, what it is approved to carry, the delivery times it has promised, its people — and its fleet, where a driver or a vehicle can be added on their behalf. It is also where staff check the company’s profile changes and documents.'],
  ['Carrier connections', 'Whether each haulage company’s computer system is actually connected, and what its status codes mean here.'],
], [2600, 7400]);
p('When a delivery is offered to a carrier, the system scores every candidate: does it cover both ends of the journey, is it approved for what has to be carried, does it have room, and how often does it deliver on time. The reasons are written out beside each company. A company the score rules out can still be chosen — the person arranging it sometimes knows something the score does not — but the reason is on the screen while they choose.');
note('Suspending a carrier', 'Stops any new work reaching them. Work they have already accepted stays theirs to finish; work they have not answered yet can be taken back in the same action so somebody else can be found, and the system says how much that is before it does it.', C.orange);

h2('12a.7 Approving what a carrier may carry');
p('Refrigerated goods, sterile goods and dangerous goods are only ever offered to a haulage company the business has approved for them. Approval is a decision somebody makes on the carrier’s record, with the certificate or licence number they checked and the date it runs out recorded beside it. A decision can be left as asked for, or later suspended or refused, and the haulage company reads the result in their own portal without being able to change it.');
table(['What gets approved', 'Why it matters'], [
  ['Cold chain and temperature ranges', 'A delivery that must stay between two temperatures is never offered to a company that cannot hold them.'],
  ['Sterile handling', 'Goods that must stay sterile are only offered to companies equipped for it.'],
  ['Dangerous goods', 'Carrying these is regulated, and the approval records the evidence.'],
  ['Same day, next day, international, customs clearance', 'Decides what kind of work a company is offered at all.'],
], [3600, 6400]);

h2('12a.7a Checking a carrier’s profile and documents');
p('On each carrier’s page, marketplace staff see a profile verification panel. Anyone who can look at carriers can read it. Only staff who can manage carriers can decide.');
table(['What staff can do', 'What the system does'], [
  ['Read a waiting change', 'Shows each field, what it says now, and what the company asked for.'],
  ['Approve and apply it', 'Puts the new details on the live record and marks the company as verified.'],
  ['Reject it', 'Needs a reason, which the company sees. The live record stays as it was.'],
  ['Download a document', 'Gives a link that works once, for a few minutes, and only for that member of staff.'],
  ['Verify or reject a document', 'Records the decision. A rejection needs a reason, which the company sees.'],
  ['Mark the company as verified, or ask it to verify again', 'Asking again needs a reason, which the company sees.'],
], [3600, 6400]);
p('Every change, request, withdrawal, decision, upload and download is written into the company’s own record of who did what. Decisions by staff are also written into the marketplace’s main record. Companies that were on the system before this panel existed start as not verified, because nobody has checked them yet.');

h2('12a.8 The delivery promise, and what counts as proof');
p('For each carrier the business sets how many hours they have to collect and how many to deliver, how early to start warning that a delivery is going to be late, and how many delivery attempts are allowed. Every delivery is then measured against the promise that applies to it and shows as on track, at risk or missed.');
p('The same settings decide what a driver has to capture before a delivery can be marked as done: the recipient’s name, a signature, a photograph, a one-time code read out by the recipient, or the recipient’s job title. Until everything required has been captured, the driver cannot mark it delivered.');
note('Signatures are not public', 'A signature or a delivery photograph is only reachable through a link that the system issues for the person asking and that stops working after a few minutes. There is no address anybody can guess.', C.blue);

h2('12a.9 Working with a carrier’s own computer system');
p('A haulage company can be used in one of two ways, and both are complete.');
table(['Way', 'What it means'], [
  ['Their staff record it', 'The company’s own people type every status into their portal. Nothing has to be connected, and this is how the system works out of the box.'],
  ['Their system reports it', 'The haulage company’s computer system sends updates automatically, and the business only has to check they are arriving.'],
], [2800, 7200]);
note('It never claims to be connected when it is not', 'A connection with no credentials is shown as not configured, names exactly what is missing, and reports a connection test as a failure. There is no state in which a tick appears because nothing was tried.', C.orange);
p('Every haulage company has its own words for what has happened to a parcel. The business maps each of their codes onto the status it means here, once, and the system remembers. A code nobody has mapped yet is never thrown away and never guessed at: it is kept exactly as it arrived, flagged for somebody to look at, and the original is always shown beside whatever it was mapped to.');
note('The same update twice changes nothing twice', 'If a haulage company sends the same update five times, or somebody presses the same button twice, one thing is recorded. This is not a precaution bolted on afterwards; it is how the record is built.', C.blue);

h2('12a.10 Putting a status right');
p('A carrier can move a delivery forward through the stages it actually goes through, and cannot skip to the end. A carrier can never reverse a delivery that has been recorded as delivered, returned, lost or cancelled.');
p('The business can, through one route: a correction, which demands a written explanation and records it. Anybody reading that delivery months later sees that it was corrected, by whom, and why — rather than seeing a parcel that appears to have gone backwards for no reason.');

h2('12a.11 Where drivers and vehicles are');
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
  'On-screen warnings about something going wrong close themselves at the moment the work that fixes them is completed, rather than waiting for anybody to tidy them up. They are kept afterwards, with who closed them and why.',
]);
page();

// 14
h2('13.6 Live chat that does not lose messages');
bullets([
  'Every chat message is saved before anybody is told about it, so what appears on a screen is always something the system has kept.',
  'Messages are numbered by the system in the order they arrived, so two people writing at the same moment always see the same order.',
  'A screen that lost its connection catches up by itself when it comes back, and never shows a message twice.',
  'A business that runs the system on more than one server can switch on a setting so that a message sent through one reaches people connected to another.',
  'Every minute the system emails customers about replies they have not read, raises the alert for customers waiting too long, and closes proposals that have run out of time.',
]);

h1('14. Security, Accessibility and Quality Features');
h2('14.1 Security');
bullets([
  'Separate customer and admin sessions allow a buyer and staff user to be signed in at the same time without one replacing the other.',
  'How long a sign-in lasts while nothing is happening is set by the business running the marketplace, and the shop and the admin console are set separately. Out of the box the shop, the Seller Hub and the driver app allow an hour, because a seller filling in an application works from paperwork and is often away from the screen; the admin console allows fifteen minutes, because that is the account that can refund an order and read a customer’s address, and it is the one left open on a shared desk. Lengthening one never lengthens the other. A browser that is being used stays signed in without anybody noticing either number.',
  'An open Seller Hub closes after an hour with nobody using it, and asks for its own password again. The server keeps that clock, not the page, so a page left open cannot keep the Hub open by itself. Updates the page fetches on its own, such as the notification counts, do not keep it open. The shop sign-in is not affected. Closing the Hub or signing out still ends it at once, and opening, closing, staying signed in and expiring are each recorded in the audit history.',
  'Passwords use secure password hashing; reset/activation/contact tokens are time-limited and single-use.',
  'Every staff session is challenged for a code from an authenticator app, and recovery codes are issued once for a lost phone.',
  'Permissions are enforced on the server for protected actions.',
  'Preorder chats: a customer can only ever open their own conversations, sellers cannot see them at all, staff need the right role, and a signed-out or disabled account loses the live connection within seconds. Messages are shown as plain text, so nothing a person types can run as code.',
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
  'The shop, the admin panel and the carrier portal all use the same side menu: a narrow strip of symbols that widens into full labels when you point at it or reach it with the keyboard, and gives the rest of the width back to the page when you move away.',
  'On a phone or a small tablet that side menu becomes a panel you open from a button and close with a tap, the Escape key or the button it came from, rather than disappearing.',
  'Controls, status indicators and forms use labelled accessible patterns.',
  'The system includes light/dark theme support and contrast checking.',
  'The shop, the admin panel and the carrier portal are each translated into eight languages, and every page of all three changes when the reader picks a language.',
  'The language picker is on every page, including the sign-in and password pages, so somebody who cannot read the interface does not have to navigate to a settings page first.',
  'Each of the three keeps its own language choice, so choosing Greek in one does not change the other two for the same person.',
  'On a wide screen, the sign-in and create-account pages of all three put the form on one side and a slowly turning picture of the earth on the other, with a marker on each of fifteen shipping ports around the world. It is a picture and nothing more: it holds no wording and nothing to press, screen readers skip it, and everything a person has to read or fill in is in the column beside it.',
  'That picture is left out on a narrow screen, on a computer that cannot draw it, and for anybody whose device is set to reduce movement, who is shown a still one instead. In every one of those cases the page is complete, and the form itself is unchanged.',
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
  ['Preorder chat', 'On by default and can be switched off. Attachments appear only when a virus scanner is connected. A business running more than one server switches on shared live updates so every server delivers every message. The business’s own team can work under its own name — for example a shop called Glovia whose customers are told “the UBoss team is available” and whose sellers choose “Self”, “UBoss” or “Self + UBoss” for each delivery level — without renaming the shop.'],
  ['Order approvals', 'Enabled when the business wants certain orders to wait for an approver.'],
  ['Recurring and scheduled orders', 'Enabled when the business offers Buy Later and Subscribe & Reorder.'],
  ['Any-product scheduling', 'Controls whether all published products or only selected products may be repeated.'],
  ['Card payment on Stripe’s own page', 'Appears once the business connects its Stripe account. Until then the payment page says card payment is not set up on this store yet. The business also sets, in its Stripe account, which ways to pay are offered and the name, logo and colours shown on Stripe’s page.'],
  ['AutoPay', 'Requires both AutoPay features and a compatible payment-provider configuration.'],
  ['Admin ERP', 'Requires ERP integration feature and configured connection.'],
  ['Customer ERP', 'Requires customer integration path/configuration and safe endpoint validation.'],
  ['Live monday.com connections', 'Requires the store to register an application with monday.com and hold its details in configuration. Without one, customers can still set up a monday.com test connection.'],
  ['Warehouse map provider', 'Works with configured Google Maps, vector-map or raster-tile settings; the screen still works without a map background.'],
  ['Satellite view', 'Appears once the business points the system at a satellite imagery service. With a map already configured the two are combined: the photograph underneath, and the roads, borders and place names drawn on top so the map can still be read. Without it the map looks exactly as it did.'],
  ['Address suggestions', 'Appear once the business points the system at an address lookup service, which it does out of the box. Typing an address offers the real places matching it, and choosing one fills the rest of the address and the map position together. Without the service every address field is an ordinary box that still works.'],
  ['AI assistant / image search', 'Requires assistant configuration. Asking without an account is a separate setting and starts switched off.'],
  ['Dashboard insights panel', 'Present on all three dashboards whether or not an AI provider is configured, and it is half of what a dashboard is: the chart, and this. With a provider, the summary is written by the provider. Without one — which is how the software arrives — the panel builds the same summary from the figures itself and says so on screen. See 15.1.'],
  ['Admin location gate', 'Can be enabled for staff sign-in; production deployment needs HTTPS for browser location access.'],
  ['Seller shop fronts', 'Each seller gets a web address of their own once the business configures the domain to hang them off. Without it every visitor is on the business’s own shop, exactly as before.'],
  ['Marketplace commission', 'A standard percentage set once by the business, with an agreed rate per seller where one has been negotiated. Both start at nothing, so a business that has not decided what it charges charges nothing. Once the finance team publishes a platform fee (see 10.7), that fee is used instead for the sellers, countries or categories it covers — except that a seller with an agreed rate keeps it unless a fee is set for that seller specifically.'],
  ['Certificates a seller must supply', 'Nothing is demanded out of the box. The business running the marketplace decides, per country and per kind of seller, which certificates and documents are required — and a step only has to be answered once something on it has been marked required.'],
  ['Opening a document nobody has checked for viruses', 'Uploaded documents are scanned with ClamAV before storage. A clean result is required before staff or sellers can open one; an infected or failed scan is refused. Production will not start without the scanner, and the live host still needs an operational scan test.'],
  ['Sign-in details printed on the sign-in page', 'For a demonstration only. Where the business has listed demonstration accounts for a site, that site’s sign-in page shows them, so anybody given the address can look around without being sent a password first. Nothing is listed unless the business lists it, and nothing is listed by default, so an ordinary installation shows an ordinary sign-in page. A site set up this way is open to everybody who has the address, so it must hold made-up information and its passwords must be changed to ones used nowhere else.'],
  ['Logistics partner portal', 'Turned on by the logistics feature. Gives haulage companies their own place to work and the business its own view of every delivery. Off, and none of chapter 12a exists. On, it works straight away with carriers whose staff record each status themselves; connecting a haulage company’s computer system needs that company’s own credentials, and until they are in place the system says so rather than pretending.'],
  ['Trying the shop without a payment company', 'For testing only, and switched off. A business setting the system up for the first time may not have a payment company connected yet, and nothing after a payment can be looked at until one is. With this on, the payment page says so plainly and offers a button that marks the order paid, and everything that follows a real payment then happens exactly as it would: the order is confirmed, the confirmation email goes out, the warehouse sees it, and the invoice is produced. Every record it creates is marked as a test, so it can never be mistaken for money that was taken. The system refuses to start with it switched on for a live shop, or alongside any real payment details.'],
], [3500, 6500]);
h2('15.1 The insights panel on each dashboard');
p('Beside the chart on every dashboard is a panel that explains the figures in plain words and answers a typed question about them. It is there to help somebody read the screen. It cannot do anything.');
p('It is deliberately small: a short paragraph, one line saying when it was written and by which provider, and a box to type a question in. It is a note about the chart, not a second screen beside it, and the questions worth asking appear one at a time in the box itself.');
bullets([
  'It only ever talks about figures the person is already allowed to see. A buyer’s panel is built from that buyer’s own orders, a haulage company’s from its own deliveries, and a member of staff’s from the queues they are allowed to act on.',
  'Nothing that names anybody is sent to the provider. Counts and totals only — no order numbers, no company names, no addresses, no card details.',
  'Every statement it makes has to point at a figure the system worked out itself. Anything it says that does not point at one of those figures is removed before the answer reaches the screen.',
  'It never invents a number. The figures are worked out by the system before the question is asked, and the provider is only asked to explain and prioritise them.',
  'It cannot approve a seller, take a payment, assign a driver, change a delivery status or close a problem. There is nothing to press on it but “explain” and “ask”; that work is done by a person, on the screen that owns it.',
  'Where no provider is configured, the panel builds the same summary itself from the same figures, marks clearly that it did so, and carries on working. The software arrives this way.',
  'The same honest fallback covers a provider that is too busy, out of quota, or slow to answer, so the panel can never stop a dashboard from loading.',
  'Nobody can reach it without signing in, and there is a limit on how often it can be asked.',
]);
note('Not advice about products', 'The panel is about orders, deliveries and queues. It does not comment on whether a product is suitable for a patient or a procedure, and is instructed not to.', C.orange);

note('Configuration rule', 'A feature being in the code does not mean it is always enabled in every customer installation. This guide describes the capability and clearly identifies when setup controls visibility.', C.orange);
page();

// 16
h1('16. Simple End-to-End Examples');
h2('Example A — Customer buys a product');
table(['Step', 'Customer action', 'System response'], [
  ['1', 'Opens home page and searches products.', 'Shows catalogue items available in the chosen country/currency.'],
  ['2', 'Opens a product, chooses variant and how many — cartons where the shop is selling it, pieces where an outside seller is.', 'Checks product/variant relationship and quantity rules, and shows what the choice comes to in pieces.'],
  ['3', 'Adds item to cart.', 'Works out who is selling the line first, then turns the chosen quantity into pieces — by its own carton size for the shop’s own goods, and one for one for a seller’s. Stores the cart line and recalculates server-owned totals.'],
  ['4', 'Reviews “Where this can ship from”.', 'Shows eligible warehouses, lead-time/fee information and any partial-stock warnings.'],
  ['5', 'Chooses a warehouse preference and continues.', 'Records preference; actual total remains the clearly shown checkout total.'],
  ['6', 'Selects address/payment choice and places order.', 'Creates one order, reserves stock, applies tax/coupon/limits and starts payment/approval path.'],
  ['7', 'Presses “Pay securely now” and pays on Stripe’s own secure page, choosing a saved card or typing a new one.', 'Comes back to “Confirming payment…”. When the payment company confirms the payment, the order becomes confirmed, the page says “Payment successful” with the card used, and processing can begin.'],
  ['8', 'Checks My orders.', 'Shows order status, history, payment/invoice context and fulfilment progress.'],
], [800, 4100, 5200]);
h2('Example A2 — A customer asks about a container before preordering');
table(['Step', 'Who', 'What happens'], [
  ['1', 'Customer', 'On a product page, presses the chat icon beside Preorder and taps “How many pieces fit in a 40-ft container?”'],
  ['2', 'System', 'The automatic assistant answers from the seller’s checked loading — or, if the seller has not checked it, says the team must confirm and offers a person.'],
  ['3', 'Customer', 'Presses Connect with a human agent and adds: “Can you deliver two by March?”'],
  ['4', 'System', 'Puts the question, the automatic answer and the message in front of the team at once, marks it “Human assistance requested” and raises the Preorder Chats count.'],
  ['5', 'Order desk', 'Takes the conversation, checks with the warehouse (writing an internal note the customer cannot see), and replies.'],
  ['6', 'Customer', 'Agrees in the chat.'],
  ['7', 'Order desk', 'Sends a preorder proposal: two 40-ft containers, the pieces that makes, an estimated price and a date.'],
  ['8', 'Customer', 'Presses Review proposal, checks the preorder form it fills in, accepts the preorder terms and sends the request.'],
  ['9', 'System', 'Links the request to the conversation and sends it to the supplier, who answers with final terms that the customer confirms and pays for as with any preorder.'],
], [800, 1600, 7600]);

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

h2('Example C2 — A seller hands an order to a carrier');
p('Only where the logistics portal is switched on.');
table(['Step', 'Who does it', 'What happens'], [
  ['1', 'The buyer', 'Pays for an order that includes this seller’s goods. The seller is told there is a new order.'],
  ['2', 'The seller', 'Confirms the order and says which of their buildings it leaves from. Until they do, nobody can be asked to carry it.'],
  ['3', 'The seller', 'Presses “Assign Logistics Partner” and chooses who carries it: a delivery company they work with, or DHL, FedEx or India Post booked by hand.'],
  ['4a', 'The delivery company', 'Accepts or turns it down in its own portal. The seller is told either way. If it accepts, it is reminded to put one of its own drivers on it, and the driver is told.'],
  ['4b', 'The seller, for a hand booking', 'Books it with DHL, FedEx or India Post, enters the tracking number the carrier gave, and records each step as the carrier reports it.'],
  ['5', 'Everybody', 'The seller, the delivery company, the marketplace and the buyer each see the same stage — picked up, in transit, out for delivery, delivered — with only the detail each of them is entitled to.'],
  ['6', 'The system', 'Tells the marketplace if a confirmed order has sat with nobody carrying it for too long.'],
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
  ['5', 'A buyer', 'Opens that category, sees the product, and adds it to their cart.'],
  ['6', 'The system', 'Attaches that seller to the cart line, so the price shown is the price charged, the order reaches the seller who has to pack it, and the commission is worked out against the right agreement.'],
  ['7', 'The seller', 'Pauses the listing later — to restock, or because it is withdrawn.'],
  ['8', 'The system', 'Takes it out of every category at once. A buyer cannot find or order something nobody is selling.'],
], [700, 2300, 7000]);


h2('Example H — A hospital group preorders forty thousand gloves');
table(['Step', 'Who acts', 'What happens'], [
  ['1', 'A buyer', 'Presses Preorder on a glove listing, asks for 40,000 pieces for 15 December, and sends the request with their purchase order number.'],
  ['2', 'The system', 'Checks the seller’s minimum, step and earliest date, shows the price per piece from the seller’s price bands, and sends the request to the seller. Nothing is charged.'],
  ['3', 'The seller', 'Sees the request with their December capacity beside it, and sends a counter-offer: 40,000 pieces in two deliveries, 20,000 on 1 December and 20,000 on 15 December, at a slightly lower price.'],
  ['4', 'The buyer', 'Reads the counter-offer and confirms it.'],
  ['5', 'The system', 'Creates one order waiting for payment and holds 40,000 pieces of the seller’s December capacity, so nobody else can be promised the same capacity.'],
  ['6', 'The buyer', 'Pays for the order.'],
  ['7', 'The system', 'Confirms the preorder when the payment provider confirms the payment, and tells the seller.'],
  ['8', 'The seller', 'Marks production started and, when the gloves are made and booked into stock, ready — then accepts the order, which hands it to ordinary delivery.'],
], [700, 2300, 7000]);

h2('Example H2 — A distributor asks for two containers and the seller has one ready');
table(['Step', 'Who acts', 'What happens'], [
  ['1', 'The seller', 'Has already said, on the listing, that 12,000 pieces of these gloves fit in a 20-ft container, and ticked that they have checked the figure.'],
  ['2', 'A buyer', 'Opens Preorder, chooses “20-ft Container” and asks for 2. The form shows “2 × 20-ft Container = 24,000 pieces in total”, and sends the request.'],
  ['3', 'The system', 'Works out that the seller could send 12,000 pieces now. It tells the buyer the full quantity is not currently available — 24,000 asked for, 12,000 available for a first delivery, 12,000 remaining — and that the seller will propose a schedule. Nothing is set aside. The seller’s list marks the request “More than available”.'],
  ['4', 'The seller', 'Proposes a split delivery: 12,000 pieces from stock on 10 November and 12,000 from new production on 15 December. The preview shows one full container in each delivery and the full price with tax and delivery. The seller sends it.'],
  ['5', 'The buyer', 'Is emailed, reads the schedule and the total on their preorder page, and presses Accept offer.'],
  ['6', 'The system', 'Checks the stock again, sets the 12,000 pieces aside for this buyer, holds the seller’s capacity for the other 12,000, and creates one order waiting for payment. Had another buyer taken the stock first, nothing would have been charged and the seller would have been asked to propose again.'],
  ['7', 'The buyer', 'Pays for the order in the usual way.'],
  ['8', 'The seller', 'Accepts the order. The first container goes from the stock set aside; the second can only be sent once the new stock is in.'],
], [700, 2300, 7000]);

h2('Example K — A hospital preorders a product the shop makes itself');
table(['Step', 'Who acts', 'What happens'], [
  ['1', 'A hospital buyer', 'Presses Preorder on the shop’s own gauze and asks for 20,000 pieces in six weeks.'],
  ['2', 'The system', 'Accepts the request on standard terms, shows the shop’s price per piece, and rings the bell in the admin panel.'],
  ['3', 'A member of staff', 'Opens the preorder, accepts it with a delivery charge, and the buyer is emailed the shop’s terms.'],
  ['4', 'The buyer', 'Confirms and pays. The preorder is confirmed when the payment provider confirms the payment.'],
  ['5', 'Staff', 'Mark production started, then ready, and start fulfilling the order, which hands it over to delivery.'],
], [700, 2300, 7000]);

h2('Example J — A clinic buys enough to reach a lower price');
table(['Step', 'Who acts', 'What happens'], [
  ['1', 'A seller', 'Sets quantity prices on silicone tubing: 10.00 each, 9.50 from 100 pieces, 9.20 from 500.'],
  ['2', 'A clinic buyer', 'Types 480 pieces on the product page.'],
  ['3', 'The system', 'Shows that 480 pieces already cost 9.50 each, and that 20 more would bring every piece down to 9.20.'],
  ['4', 'The system', 'Because the buyer raised the quantity, opens the Bulk offers window once: 9.50 from 100 pieces is marked “Your quantity”, and 9.20 from 500 is marked “Next saving” and “Best value”, with the total for 500 pieces and the total saving.'],
  ['5', 'The buyer', 'Presses “Select 500” in the window (or the suggestion under the quantity box). The quantity becomes 500.'],
  ['6', 'The system', 'Works the price out again in the basket and at checkout, charges 9.20 a piece, and the order records that the 500-piece price applied.'],
], [700, 2300, 7000]);

h2('Example I — A seller packs an order and sends it in two lorries');
table(['Step', 'Who acts', 'What happens'], [
  ['1', 'A seller', 'Opens a paid order for 100 cartons of gloves, and splits it: 60 cartons now, 40 cartons on a second lorry tomorrow.'],
  ['2', 'The seller', 'Lists the pallets on the first load, what is on each, and the batch numbers, then presses Check.'],
  ['3', 'The system', 'Says one product has no HSN code. The seller adds it to the listing and checks again — everything is ready.'],
  ['4', 'The seller', 'Presses Mark as packed.'],
  ['5', 'The system', 'Issues invoice INV/26-27/00041 and packing list PL-2026-000318 together, and marks the load packed.'],
  ['6', 'The delivery company', 'Sees the packing list on the load in its own portal — boxes, contents and weights, no prices.'],
  ['7', 'The customer', 'Finds the invoice on their order page and downloads it. The next day a second invoice appears for the second lorry; the two add up to exactly what they paid.'],
  ['8', 'A receiving clerk', 'Scans the QR code on the packing list and sees that it is genuine and who issued it.'],
], [700, 2300, 7000]);

h2('Example L — A seller in India sends gloves to a buyer in Rotterdam in four stages');
table(['Step', 'Who acts', 'What happens'], [
  ['1', 'The seller', 'Opens Logistics in the Seller Hub, switches on the forwarder they book by hand, and chooses “Self and the marketplace”: they will look after stages 1 and 2, the marketplace stages 3 and 4.'],
  ['2', 'The seller', 'Prices stage 1 (their warehouse to Mumbai port, by road) and stage 2 (Mumbai to Rotterdam, by sea, through their forwarder), then publishes.'],
  ['3', 'The system', 'Tells marketplace staff that stages 3 and 4 for this seller have no price yet. Until they do, a buyer in the Netherlands is told delivery from this seller needs a quote.'],
  ['4', 'Marketplace staff', 'Open Delivery levels, price stage 3 (Rotterdam port to a Dutch warehouse) and stage 4 (to the buyer), and publish. The seller is told.'],
  ['5', 'The buyer', 'Sees delivery from this seller priced at checkout, pays, and the order records exactly what each stage cost.'],
  ['6', 'The seller', 'Accepts the order. Stage 1 is their turn and already carries the carrier from their price; they type in its tracking number and record the handover at the port. Stage 2 becomes their turn next, and they do the same.'],
  ['7', 'Marketplace staff', 'Are told stage 3 is ready, already with the delivery company from their price (they can change it, saying why), and that company accepts it and records its progress. Stage 4 follows the same way, ending at the buyer’s door.'],
  ['8', 'The system', 'Works out, when the order is confirmed, what the seller is owed: the goods plus the delivery for stages 1 and 2, minus the marketplace fee and the tax on it. The money for stages 3 and 4 is the marketplace’s.'],
], [700, 2300, 7000]);

note('Document status', 'This guide is based on the current Glovia codebase, including customer storefront routes, admin routes, warehouse rules, API business rules, background-worker behaviour and feature configuration.', C.teal);

const doc = new Document({
  creator: 'Glovia',
  title: 'Glovia Feature Guide',
  description: 'Simple English feature guide for Glovia.',
  styles: {
    default: { document: { run: { font: 'Aptos', size: 21, color: C.ink } } },
  },
  sections: [{
    properties: {
      page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } },
    },
    headers: { default: new Header({ children: [new Paragraph({ text: 'GLOVIA  |  FEATURE GUIDE', spacing: { after: 0 }, run: { size: 7.5, bold: true, color: C.muted } })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Glovia • Page ', color: C.muted, size: 7 }), new TextRun({ children: [PageNumber.CURRENT], color: C.muted, size: 7 })] })] }) },
    children,
  }],
});

await writeFile(out, await Packer.toBuffer(doc));
console.log('Created ' + out);
