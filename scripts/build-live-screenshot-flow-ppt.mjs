import pptxgen from '../.ppt-build/node_modules/pptxgenjs/dist/pptxgen.es.js';
import { resolve } from 'node:path';

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'UBOSS Sourcing';
pptx.company = 'UBOSS Sourcing';
pptx.subject = 'Live localhost screenshot navigation flow';
pptx.title = 'UBOSS Sourcing — Live Screenshot Flow Map';
pptx.lang = 'en-IN';
pptx.theme = {
  headFontFace: 'Aptos Display',
  bodyFontFace: 'Aptos',
  lang: 'en-IN',
};
pptx.defineLayout({ name: 'CUSTOM_WIDE', width: 13.333, height: 7.5 });
pptx.layout = 'CUSTOM_WIDE';

const shots = (name) => resolve('output/live-sitemap-screenshots', name + '.png');
const out = resolve('output/UBOSS_Live_Screenshot_Flow_Map.pptx');
const C = {
  navy: '102A43', ink: '1E293B', muted: '64748B', pale: 'F8FAFC',
  blue: '2563EB', blueLight: 'EFF6FF', blueLine: 'BFDBFE',
  teal: '059669', tealLight: 'ECFDF5', tealLine: 'A7F3D0',
  purple: '7C3AED', purpleLight: 'F5F3FF', purpleLine: 'DDD6FE',
  orange: 'D94801', orangeLight: 'FFF7ED', orangeLine: 'FED7AA',
  border: 'CBD5E1', white: 'FFFFFF',
};

function addSlideTitle(slide, section, title, subtitle, color) {
  slide.background = { color: C.pale };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.13, fill: { color }, line: { color } });
  slide.addText(section, { x: 0.42, y: 0.28, w: 12.45, h: 0.18, fontFace: 'Aptos', fontSize: 7.5, bold: true, color, charSpace: 1.6, margin: 0 });
  slide.addText(title, { x: 0.42, y: 0.47, w: 12.45, h: 0.35, fontFace: 'Aptos Display', fontSize: 21, bold: true, color: C.navy, margin: 0 });
  slide.addText(subtitle, { x: 0.42, y: 0.88, w: 12.45, h: 0.22, fontSize: 8.5, color: C.muted, margin: 0 });
  slide.addText('LIVE LOCALHOST CAPTURE • CUSTOMER 5174 / ADMIN 5173', { x: 8.40, y: 0.29, w: 4.45, h: 0.15, fontSize: 6.3, bold: true, color: C.muted, align: 'right', charSpace: 0.7, margin: 0 });
  slide.addShape(pptx.ShapeType.line, { x: 0.42, y: 1.17, w: 12.48, h: 0, line: { color: C.border, width: 0.6 } });
}
function footer(slide, number) {
  slide.addShape(pptx.ShapeType.line, { x: 0.42, y: 7.12, w: 12.48, h: 0, line: { color: C.border, width: 0.5 } });
  slide.addText('UBOSS SOURCING • Real screenshot navigation map • September 2026', { x: 0.42, y: 7.22, w: 8.2, h: 0.13, fontSize: 6.2, color: C.muted, margin: 0 });
  slide.addText(String(number).padStart(2, '0'), { x: 12.18, y: 7.19, w: 0.7, h: 0.16, fontSize: 7, bold: true, color: C.navy, align: 'right', margin: 0 });
}
function arrow(slide, x, y, w, label, color) {
  slide.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color, width: 1.7, endArrowType: 'triangle' } });
  if (label) slide.addText(label, { x: x - 0.08, y: y - 0.26, w: w + 0.16, h: 0.16, fontSize: 6.2, bold: true, color, align: 'center', margin: 0, fit: 'shrink' });
}
function screen(slide, image, id, title, caption, x, y, w, h, color, tint) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: C.white }, line: { color: C.border, width: 0.7 }, shadow: { type: 'outer', color: '94A3B8', opacity: 0.12, blur: 1, angle: 45, distance: 1 } });
  slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.07, h, fill: { color }, line: { color } });
  slide.addText(id, { x: x + 0.14, y: y + 0.09, w: 0.45, h: 0.14, fontSize: 6.5, bold: true, color, margin: 0 });
  slide.addText(title, { x: x + 0.60, y: y + 0.07, w: w - 0.72, h: 0.18, fontSize: 8.5, bold: true, color: C.ink, margin: 0, fit: 'shrink' });
  slide.addImage({ path: shots(image), x: x + 0.10, y: y + 0.32, w: w - 0.20, h: h - 0.71 });
  slide.addShape(pptx.ShapeType.roundRect, { x: x + 0.10, y: y + h - 0.30, w: w - 0.20, h: 0.20, rectRadius: 0.04, fill: { color: tint }, line: { color: tint } });
  slide.addText(caption, { x: x + 0.16, y: y + h - 0.27, w: w - 0.32, h: 0.13, fontSize: 5.9, bold: true, color, align: 'center', margin: 0, fit: 'shrink' });
}
function flowPill(slide, text, x, y, w, color, fill) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.32, rectRadius: 0.06, fill: { color: fill }, line: { color } });
  slide.addText(text, { x: x + 0.08, y: y + 0.09, w: w - 0.16, h: 0.12, fontSize: 6.4, bold: true, color, align: 'center', margin: 0, fit: 'shrink' });
}

// 1 Cover / flow overview
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'UBOSS SOURCING • LIVE SCREEN FLOW', 'Customer-to-operations journey — captured from the running product', 'A visual guide: cards are real localhost screenshots; arrows label the meaningful user or staff action.', C.blue);
  screen(s, '01-customer-home', 'CUSTOMER', 'Browse storefront', 'Start: explore products & AI Mode', 0.45, 1.45, 3.75, 3.10, C.blue, C.blueLight);
  screen(s, '07-customer-cart', 'CHECKOUT', 'Purchase path', 'Cart → address → payment → confirmation', 4.79, 1.45, 3.75, 3.10, C.orange, C.orangeLight);
  screen(s, '13-admin-dashboard', 'ADMIN', 'Operate the business', 'Staff dashboard → catalogue → orders', 9.13, 1.45, 3.75, 3.10, C.teal, C.tealLight);
  arrow(s, 4.22, 2.96, 0.52, 'add to basket', C.blue);
  arrow(s, 8.55, 2.96, 0.52, 'order / alert', C.orange);
  flowPill(s, '01  CUSTOMER JOURNEY  Home → Catalogue → Product → Cart → Checkout → Payment', 0.45, 5.05, 12.42, C.blue, C.blueLight);
  flowPill(s, '02  ACCOUNT JOURNEY  Profile → Orders → Repeat-purchase schedule', 0.45, 5.48, 6.05, C.purple, C.purpleLight);
  flowPill(s, '03  STAFF JOURNEY  Sign-in & location → Dashboard → Catalogue / Inventory / Sales / Governance', 6.82, 5.48, 6.05, C.teal, C.tealLight);
  s.addText('Scope note: every captured page is a real response from the running local application. The deck focuses on complete primary flows and major operational routes; it does not use wireframes or generated mockups.', { x: 0.58, y: 6.15, w: 12.12, h: 0.38, fontSize: 8.2, color: C.ink, breakLine: false, valign: 'mid', align: 'center', margin: 0.08, fill: { color: 'FFFFFF' }, line: { color: C.border, width: 0.6 } });
  footer(s, 1);
}

// 2 Customer discovery
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'CUSTOMER FLOW 01', 'Discover & choose a product', 'Visitors can browse the catalogue without an account. Search, category and product detail are all real storefront routes.', C.blue);
  screen(s, '01-customer-home', 'C-01', 'Store home', 'Search • categories • featured products', 0.40, 1.48, 4.08, 4.72, C.blue, C.blueLight);
  screen(s, '02-customer-catalogue', 'C-02', 'Catalogue / search', 'Filters • sort • category • image / voice search', 4.63, 1.48, 4.08, 4.72, C.blue, C.blueLight);
  screen(s, '03-customer-product-detail', 'C-03', 'Product detail', 'Variant • specs • safety • quantity • Add to cart', 8.86, 1.48, 4.08, 4.72, C.blue, C.blueLight);
  arrow(s, 4.49, 3.77, 0.13, 'search / category', C.blue);
  arrow(s, 8.72, 3.77, 0.13, 'open product', C.blue);
  flowPill(s, 'On product detail: choose a variant, set quantity, then use “Add to cart”.', 1.61, 6.45, 10.10, C.blue, C.blueLight);
  footer(s, 2);
}

// 3 Sign-in and cart
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'CUSTOMER FLOW 02', 'Authenticate, add quantity and review cart', 'The purchase flow requires an activated customer. The application keeps browsing open and guards cart / checkout routes.', C.blue);
  screen(s, '04-customer-login', 'C-04', 'Customer sign-in', 'Email + password → customer session', 0.40, 1.48, 4.08, 4.72, C.blue, C.blueLight);
  screen(s, '05-customer-after-login', 'C-05', 'Signed-in home', 'Account, basket and sourcing actions are unlocked', 4.63, 1.48, 4.08, 4.72, C.blue, C.blueLight);
  screen(s, '07-customer-cart', 'C-06', 'Cart', 'Quantity + / − • coupon • totals • schedule option', 8.86, 1.48, 4.08, 4.72, C.orange, C.orangeLight);
  arrow(s, 4.49, 3.77, 0.13, 'sign in', C.blue);
  arrow(s, 8.72, 3.77, 0.13, 'search → quantity → Add to cart', C.blue);
  flowPill(s, 'Cart is the review point: quantities, coupon and totals are visible before proceeding to checkout.', 1.20, 6.45, 10.93, C.orange, C.orangeLight);
  footer(s, 3);
}

// 4 Checkout order payment
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'CUSTOMER FLOW 03', 'Checkout → place order → secure payment step', 'This is the live sequence created in the running application. The actual payment route has an order ID and a pending payment state.', C.orange);
  screen(s, '07-customer-cart', 'C-06', 'Cart', 'Click “Proceed to checkout”', 0.40, 1.48, 4.08, 4.72, C.orange, C.orangeLight);
  screen(s, '08-customer-checkout', 'C-07', 'Checkout', 'Address • bill-to • payment method • Place order', 4.63, 1.48, 4.08, 4.72, C.orange, C.orangeLight);
  screen(s, '29-customer-payment-step', 'C-08', 'Payment step', 'Order created → “Pay securely now” or “Pay later”', 8.86, 1.48, 4.08, 4.72, C.orange, C.orangeLight);
  arrow(s, 4.49, 3.77, 0.13, 'Proceed to checkout', C.orange);
  arrow(s, 8.72, 3.77, 0.13, 'Place order and pay', C.orange);
  flowPill(s, 'Important: payment is not treated as successful only because of browser navigation; the backend/payment event confirms the final state.', 0.70, 6.45, 11.95, C.orange, C.orangeLight);
  footer(s, 4);
}

// 5 Account & recurring
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'CUSTOMER FLOW 04', 'Account, order history & repeat-purchase area', 'Authenticated customers manage their details, check orders and open repeat-purchase scheduling from the same account experience.', C.purple);
  screen(s, '09-customer-profile', 'A-01', 'My profile', 'Contact, company and customer preferences', 0.40, 1.48, 4.08, 4.72, C.purple, C.purpleLight);
  screen(s, '10-customer-orders', 'A-02', 'My orders', 'Order history → order detail / payment context', 4.63, 1.48, 4.08, 4.72, C.purple, C.purpleLight);
  screen(s, '11-customer-schedule-builder', 'A-03', 'Repeat purchases', 'Schedule route; empty state guides user to browse eligible items', 8.86, 1.48, 4.08, 4.72, C.purple, C.purpleLight);
  arrow(s, 4.49, 3.77, 0.13, 'account navigation', C.purple);
  arrow(s, 8.72, 3.77, 0.13, 'repeat purchase', C.purple);
  flowPill(s, 'Account routes include Profile • Company • Addresses • Region • Payment methods • AutoPay • Billing • ERP • Coupons • Wishlist • Notifications.', 0.73, 6.45, 11.90, C.purple, C.purpleLight);
  footer(s, 5);
}

// 6 Admin entry
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'STAFF FLOW 01', 'Staff sign-in, location record & command dashboard', 'Admin pages are protected by staff session, location gate and effective permissions. These are live staff-console screens.', C.teal);
  screen(s, '12-admin-login', 'AD-01', 'Admin sign-in', 'Staff-only email and password entry', 0.70, 1.48, 5.75, 4.72, C.teal, C.tealLight);
  screen(s, '13-admin-dashboard', 'AD-02', 'Admin dashboard', 'Sales • orders • payments • low stock • recurring alerts', 6.88, 1.48, 5.75, 4.72, C.teal, C.tealLight);
  arrow(s, 6.47, 3.77, 0.36, 'sign in + location', C.teal);
  flowPill(s, 'Dashboard is the staff launchpad. Its cards and sidebar lead to the detailed management pages shown on the next slides.', 1.18, 6.45, 10.98, C.teal, C.tealLight);
  footer(s, 6);
}

// 7 Catalogue and inventory
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'STAFF FLOW 02', 'Catalogue & inventory administration', 'Side-nav destinations shown below are real staff workspace screens. Lists open their detail / action views.', C.teal);
  screen(s, '14-admin-categories', 'AD-03', 'Categories', 'Maintain product taxonomy', 0.40, 1.45, 3.00, 2.54, C.teal, C.tealLight);
  screen(s, '15-admin-products', 'AD-04', 'Products', 'Search, filter, edit and import catalogue items', 3.62, 1.45, 3.00, 2.54, C.teal, C.tealLight);
  screen(s, '16-admin-inventory', 'AD-05', 'Inventory', 'Balances, reservations, low-stock & movement operations', 6.84, 1.45, 3.00, 2.54, C.teal, C.tealLight);
  screen(s, '17-admin-warehouses', 'AD-06', 'Warehouses', 'Locations, map, warehouse detail & forms', 10.06, 1.45, 2.87, 2.54, C.teal, C.tealLight);
  arrow(s, 3.41, 2.72, 0.19, 'manage items', C.teal);
  arrow(s, 6.63, 2.72, 0.19, 'stock view', C.teal);
  arrow(s, 9.85, 2.72, 0.19, 'warehouse context', C.teal);
  flowPill(s, 'Category → product editor → stock / locations is the main operational information path.', 1.67, 4.30, 10.00, C.teal, C.tealLight);
  s.addShape(pptx.ShapeType.roundRect, { x: 1.10, y: 4.90, w: 11.15, h: 1.15, rectRadius: 0.08, fill: { color: 'F0FDF4' }, line: { color: C.tealLine, width: 0.7 } });
  s.addText('Operational actions', { x: 1.36, y: 5.12, w: 2.2, h: 0.18, fontSize: 10, bold: true, color: C.teal, margin: 0 });
  s.addText('• Product list opens product detail (variants, specifications, media, currency prices, translations and safety).   • Inventory routes to locations and stock adjustments.   • Warehouse detail maintains map location and fulfilment context.', { x: 3.23, y: 5.08, w: 8.70, h: 0.35, fontSize: 7.4, color: C.ink, breakLine: false, margin: 0.04, valign: 'mid' });
  footer(s, 7);
}

// 8 Sales, customers and support
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'STAFF FLOW 03', 'Sales operations, recurring orders & customer service', 'Orders are the shared operational spine: staff review order state, payment status, schedules and customer context.', C.teal);
  screen(s, '18-admin-orders', 'AD-07', 'Orders', 'Queue → detail → fulfilment action', 0.35, 1.43, 3.88, 2.38, C.teal, C.tealLight);
  screen(s, '19-admin-payments', 'AD-08', 'Payments', 'Captured, pending, failed, refunds and reconciliation', 4.72, 1.43, 3.88, 2.38, C.orange, C.orangeLight);
  screen(s, '20-admin-recurring', 'AD-09', 'Recurring', 'Schedule oversight and occurrences', 9.09, 1.43, 3.88, 2.38, C.teal, C.tealLight);
  arrow(s, 4.24, 2.63, 0.42, 'payment status', C.orange);
  arrow(s, 8.61, 2.63, 0.42, 'schedule / renewal', C.teal);
  screen(s, '21-admin-customers', 'AD-10', 'Customers', 'Customer profile, limits, approval & history', 1.78, 4.12, 3.88, 2.38, C.teal, C.tealLight);
  screen(s, '22-admin-chat-enquiries', 'AD-11', 'Chat enquiries', 'AI/customer messages and support follow-up', 7.67, 4.12, 3.88, 2.38, C.teal, C.tealLight);
  arrow(s, 5.79, 5.31, 1.78, 'customer ↔ service', C.teal);
  footer(s, 8);
}

// 9 Insights and governance
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'STAFF FLOW 04', 'Reports, integrations, staff & governance', 'These operational routes complete the admin side: observe, configure, control access and retain audit history.', C.teal);
  screen(s, '23-admin-reports', 'AD-12', 'Reports', 'Operational reporting and exports', 0.35, 1.40, 3.88, 2.28, C.teal, C.tealLight);
  screen(s, '24-admin-integrations', 'AD-13', 'Integrations', 'Payment gateways, connector settings & events', 4.72, 1.40, 3.88, 2.28, C.orange, C.orangeLight);
  screen(s, '25-admin-staff', 'AD-14', 'Staff', 'Roles, access and temporary-password lifecycle', 9.09, 1.40, 3.88, 2.28, C.teal, C.tealLight);
  screen(s, '26-admin-settings', 'AD-15', 'Settings', 'Business policy, tax, feature and storefront settings', 0.35, 4.10, 3.88, 2.28, C.teal, C.tealLight);
  screen(s, '27-admin-erp-settings', 'AD-16', 'ERP settings', 'Connection, mapping and integration policy', 4.72, 4.10, 3.88, 2.28, C.orange, C.orangeLight);
  screen(s, '28-admin-audit', 'AD-17', 'Audit log', 'Traceable activity record for governance', 9.09, 4.10, 3.88, 2.28, C.teal, C.tealLight);
  arrow(s, 4.24, 2.54, 0.42, 'configure', C.orange);
  arrow(s, 8.61, 2.54, 0.42, 'access', C.teal);
  arrow(s, 4.24, 5.23, 0.42, 'policy', C.teal);
  arrow(s, 8.61, 5.23, 0.42, 'audited events', C.orange);
  footer(s, 9);
}

// 10 end-to-end route map
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'END-TO-END MAP', 'How a real customer action becomes staff work', 'This final page connects the observed screens into one implementation-level flow.', C.navy);
  const blocks = [
    ['1', 'DISCOVER', 'Home → catalogue → product detail', 0.55, 1.60, C.blue, C.blueLight],
    ['2', 'BUY', 'Sign in → quantity → cart → checkout', 3.30, 1.60, C.orange, C.orangeLight],
    ['3', 'PAY', 'Order ID → secure payment / pay later', 6.05, 1.60, C.orange, C.orangeLight],
    ['4', 'OPERATE', 'Dashboard → orders → payments / inventory', 8.80, 1.60, C.teal, C.tealLight],
  ];
  for (const b of blocks) {
    s.addShape(pptx.ShapeType.roundRect, { x: b[3], y: b[4], w: 2.25, h: 1.55, rectRadius: 0.08, fill: { color: b[6] }, line: { color: b[5], width: 0.8 } });
    s.addShape(pptx.ShapeType.ellipse, { x: b[3] + 0.16, y: b[4] + 0.16, w: 0.36, h: 0.36, fill: { color: b[5] }, line: { color: b[5] } });
    s.addText(b[0], { x: b[3] + 0.16, y: b[4] + 0.25, w: 0.36, h: 0.10, fontSize: 7, bold: true, color: C.white, align: 'center', margin: 0 });
    s.addText(b[1], { x: b[3] + 0.16, y: b[4] + 0.64, w: 1.93, h: 0.16, fontSize: 9.5, bold: true, color: b[5], margin: 0 });
    s.addText(b[2], { x: b[3] + 0.16, y: b[4] + 0.94, w: 1.93, h: 0.30, fontSize: 7.1, color: C.ink, margin: 0, fit: 'shrink' });
  }
  arrow(s, 2.82, 2.38, 0.43, 'customer action', C.blue);
  arrow(s, 5.57, 2.38, 0.43, 'create order', C.orange);
  arrow(s, 8.32, 2.38, 0.43, 'event / alert', C.teal);
  s.addShape(pptx.ShapeType.roundRect, { x: 0.55, y: 3.75, w: 12.20, h: 1.23, rectRadius: 0.08, fill: { color: C.white }, line: { color: C.border, width: 0.8 } });
  s.addText('Navigation guarantees observed in the code and live screens', { x: 0.84, y: 4.00, w: 4.2, h: 0.18, fontSize: 10.2, bold: true, color: C.navy, margin: 0 });
  s.addText('• Guest can browse; protected customer routes redirect to sign-in.   • Checkout shows an address and payment method before the order action.   • Payment gets a dedicated order-specific route.   • Staff console shows a location record, a guarded sidebar and detailed operational routes.   • Lists are launch points for detail/action views.', { x: 0.84, y: 4.35, w: 11.55, h: 0.35, fontSize: 7.7, color: C.ink, breakLine: false, margin: 0.02, valign: 'mid' });
  s.addText('Deck contents: 45 real local capture references across storefront and admin portal. Screens were captured in a local authenticated test session; data shown is local development data.', { x: 1.08, y: 5.55, w: 11.18, h: 0.35, fontSize: 9, bold: true, color: C.navy, align: 'center', margin: 0 });
  flowPill(s, 'Deliverable: editable PowerPoint — screenshots, labels, arrows and flow annotations are all slide objects.', 1.37, 6.18, 10.60, C.navy, 'E2E8F0');
  footer(s, 10);
}

// 11 Customer access routes
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'CUSTOMER ROUTE ATLAS 01', 'Access, activation & recovery screens', 'These access routes are real live storefront screens. Their outcome continues to customer session and account routes.', C.blue);
  screen(s, '30-customer-register', 'C-A01', 'Register', 'Feature-controlled self-registration route', 0.40, 1.48, 4.08, 4.72, C.blue, C.blueLight);
  screen(s, '31-customer-activate', 'C-A02', 'Activation', 'Invitation acceptance / account activation', 4.63, 1.48, 4.08, 4.72, C.blue, C.blueLight);
  screen(s, '32-customer-forgot-password', 'C-A03', 'Password recovery', 'Forgot-password email request flow', 8.86, 1.48, 4.08, 4.72, C.blue, C.blueLight);
  arrow(s, 4.49, 3.77, 0.13, 'activate account', C.blue);
  arrow(s, 8.72, 3.77, 0.13, 'recover access', C.blue);
  flowPill(s, 'Related destinations: /login • /register • /activate • /verify-email • /forgot-password • /reset-password', 1.14, 6.45, 11.08, C.blue, C.blueLight);
  footer(s, 11);
}

// 12 Customer profile and regional preferences
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'CUSTOMER ROUTE ATLAS 02', 'Company, delivery and market preferences', 'Authenticated account pages share a common customer shell and sidebar.', C.purple);
  screen(s, '33-customer-company', 'A-04', 'Company', 'Organisation details and purchasing context', 0.40, 1.45, 3.00, 2.54, C.purple, C.purpleLight);
  screen(s, '34-customer-addresses', 'A-05', 'Addresses', 'Shipping / billing address management', 3.62, 1.45, 3.00, 2.54, C.purple, C.purpleLight);
  screen(s, '35-customer-region', 'A-06', 'Region', 'Language, country and currency choices', 6.84, 1.45, 3.00, 2.54, C.purple, C.purpleLight);
  screen(s, '36-customer-payment-methods', 'A-07', 'Payment methods', 'Saved payment method management', 10.06, 1.45, 2.87, 2.54, C.purple, C.purpleLight);
  arrow(s, 3.41, 2.72, 0.19, 'address choice', C.purple);
  arrow(s, 6.63, 2.72, 0.19, 'market choice', C.purple);
  arrow(s, 9.85, 2.72, 0.19, 'payment setup', C.purple);
  flowPill(s, 'Profile and company information feed checkout contact / delivery context; region selection controls served locale and market presentation.', 0.94, 4.30, 11.45, C.purple, C.purpleLight);
  s.addShape(pptx.ShapeType.roundRect, { x: 1.10, y: 4.90, w: 11.15, h: 1.15, rectRadius: 0.08, fill: { color: 'FAF5FF' }, line: { color: C.purpleLine, width: 0.7 } });
  s.addText('Account continuity', { x: 1.36, y: 5.12, w: 2.2, h: 0.18, fontSize: 10, bold: true, color: C.purple, margin: 0 });
  s.addText('All these pages are reached from account navigation and retain the signed-in customer context. Address and payment choices are directly reflected by the checkout screen.', { x: 3.23, y: 5.08, w: 8.70, h: 0.35, fontSize: 7.4, color: C.ink, breakLine: false, margin: 0.04, valign: 'mid' });
  footer(s, 12);
}

// 13 Customer payment, automation and preferences
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'CUSTOMER ROUTE ATLAS 03', 'Billing, AutoPay, ERP and customer tools', 'These account routes cover financial self-service, repeat-order controls and personal workspaces.', C.purple);
  screen(s, '37-customer-autopay', 'A-08', 'AutoPay', 'Standing payment authority controls', 0.35, 1.40, 3.88, 2.28, C.purple, C.purpleLight);
  screen(s, '38-customer-billing', 'A-09', 'Billing', 'Bills, invoices and payment context', 4.72, 1.40, 3.88, 2.28, C.purple, C.purpleLight);
  screen(s, '39-customer-erp', 'A-10', 'Customer ERP', 'Customer-specific integration hand-off', 9.09, 1.40, 3.88, 2.28, C.orange, C.orangeLight);
  screen(s, '40-customer-coupons', 'A-11', 'Coupons', 'Available promotions and redemption context', 0.35, 4.10, 3.88, 2.28, C.purple, C.purpleLight);
  screen(s, '41-customer-wishlist', 'A-12', 'Wishlist', 'Saved products for future purchase', 4.72, 4.10, 3.88, 2.28, C.purple, C.purpleLight);
  screen(s, '42-customer-notifications', 'A-13', 'Notifications', 'Customer preference / update controls', 9.09, 4.10, 3.88, 2.28, C.purple, C.purpleLight);
  arrow(s, 4.24, 2.54, 0.42, 'billing context', C.purple);
  arrow(s, 8.61, 2.54, 0.42, 'ERP hand-off', C.orange);
  arrow(s, 4.24, 5.23, 0.42, 'save for later', C.purple);
  arrow(s, 8.61, 5.23, 0.42, 'customer updates', C.purple);
  footer(s, 13);
}

// 14 Additional staff workspace routes
{
  const s = pptx.addSlide();
  addSlideTitle(s, 'STAFF ROUTE ATLAS 05', 'Promotions, manufacturers & data-governance requests', 'Additional staff screens captured from the same local admin session.', C.teal);
  screen(s, '43-admin-coupons', 'AD-18', 'Coupons', 'Create and manage promotion rules', 0.40, 1.48, 4.08, 4.72, C.teal, C.tealLight);
  screen(s, '44-admin-manufacturers', 'AD-19', 'Manufacturers', 'Supplier / brand catalogue context', 4.63, 1.48, 4.08, 4.72, C.teal, C.tealLight);
  screen(s, '45-admin-data-requests', 'AD-20', 'Data requests', 'Privacy and data-subject request workflow', 8.86, 1.48, 4.08, 4.72, C.teal, C.tealLight);
  arrow(s, 4.49, 3.77, 0.13, 'catalogue metadata', C.teal);
  arrow(s, 8.72, 3.77, 0.13, 'governed request', C.teal);
  flowPill(s, 'Staff workspace also includes roles, audit history, reports, ERP/integrations and security-sensitive governed actions.', 1.24, 6.45, 10.87, C.teal, C.tealLight);
  footer(s, 14);
}

await pptx.writeFile({ fileName: out });
console.log('Created ' + out);
