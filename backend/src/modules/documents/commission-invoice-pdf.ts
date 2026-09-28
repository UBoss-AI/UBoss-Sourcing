/**
 * The commission invoice and its credit note, as an ISO A6 PDF.
 *
 * Designed for A6 (105 x 148 mm, 297.64 x 419.53 pt) rather than shrunk from
 * A4: a strong outer border, compact supplier and seller blocks side by side,
 * heavy rules between sections, the metadata as a tight grid, a full-width
 * vector barcode of the number, a narrow service table, a totals block with
 * the grand total on a dark band, and the verification QR with the legal
 * footer underneath. Every page carries the border, the document number and
 * "1/2"-style page numbering; the table header repeats on every page the
 * table continues onto.
 *
 * Properties every issued document here needs, shared with `pdf.ts`:
 *
 *   - **Deterministic.** The same document renders the same bytes: the PDF's
 *     dates are the issue time passed in, never the wall clock, and nothing
 *     random reaches the file. So the SHA-256 recorded at issue can be
 *     re-derived.
 *   - **Real text.** DejaVu Sans is embedded (subset) so every name and
 *     address prints - ₹, Devanagari transliterations aside, Polish, Greek -
 *     and the text stays selectable and searchable.
 *   - **Never clipped.** Every block is measured before it is drawn, and one
 *     that would not fit starts a new page.
 *
 * The renderer only lays out strings: every amount and date arrives already
 * formatted by the service, from bigint minor units. It decides nothing.
 */
import PDFDocument from 'pdfkit';

import QRCode from 'qrcode';

import { code128Widths } from './code128.js';
import { FONTS } from './pdf.js';

export const COMMISSION_TEMPLATE_VERSION = 'a6-commission-1';

/** ISO 216 A6, in points (1 mm = 72 / 25.4 pt). */
export const A6 = Object.freeze({ width: (105 * 72) / 25.4, height: (148 * 72) / 25.4 });

const BORDER_INSET = 7;
const MARGIN = 13;
const FOOTER_HEIGHT = 13;
const CONTENT_WIDTH = A6.width - MARGIN * 2;
const TOP = MARGIN;
const BOTTOM = A6.height - BORDER_INSET - FOOTER_HEIGHT - 2;

/** Print-safe colours: dark navy, blue and black on white. */
const INK = '#0B1220';
const NAVY = '#0B2545';
const BLUE = '#1D4ED8';
const MUTED = '#475569';
const RULE = '#0B1220';
const HAIRLINE = '#94A3B8';
const SHADE = '#E8EEF7';

/** The smallest type on the page. 6 pt is about 2.1 mm cap height - readable at arm's length. */
export const MIN_FONT_SIZE = 6;

export interface PdfParty {
  heading: string;
  name: string;
  lines: string[];
}

export interface PdfLine {
  description: string;
  detail: string | null;
  code: string;
  orderReference: string;
  taxable: string;
  rate: string;
  tax: string;
  total: string;
}

export interface PdfTotal {
  label: string;
  value: string;
  strong?: boolean;
}

export interface CommissionPdfDocument {
  /** "TAX INVOICE", "INVOICE", "BILL OF SUPPLY" or "CREDIT NOTE". */
  title: string;
  subtitle: string;
  draft: boolean;
  /** Null on a draft. */
  number: string | null;
  /** The issue time - or, for a draft, the time it was last built. Becomes the PDF's dates. */
  issuedAt: Date;
  supplier: PdfParty;
  recipient: PdfParty;
  facts: [string, string][];
  /** The currency code, printed in the table header. */
  currency: string;
  /** The service-code column's heading: "SAC" in India, as configured elsewhere. */
  codeHeader: string;
  lines: PdfLine[];
  totals: PdfTotal[];
  amountInWords: string;
  /** "Amount payable by seller to …" and its figure. */
  collection: { label: string; value: string; note: string | null } | null;
  declarations: string[];
  /** The verification link the QR carries. Null on a draft. */
  /** The verification link, drawn as a vector QR code. */
  qr: { url: string; caption: string } | null;
  footerLines: string[];
  /**
   * The name the operator trades under, printed in the header and footer.
   * Every buyer of this software issues these under their own name, so it
   * comes from the business profile, never a literal.
   */
  brand: string;
  metadata: { title: string; subject: string; author: string; keywords: string };
}

interface TextStyle {
  font?: 'Body' | 'Bold' | 'Mono';
  size?: number;
  color?: string;
  align?: 'left' | 'right' | 'center';
}

class A6Builder {
  readonly doc: PDFKit.PDFDocument;
  y = TOP;
  private readonly chunks: Buffer[] = [];
  private readonly finished: Promise<Buffer>;

  constructor(private readonly input: CommissionPdfDocument) {
    this.doc = new PDFDocument({
      size: [A6.width, A6.height],
      // Zero margins: every position is placed by hand, so PDFKit never adds a
      // page on its own in the middle of a block.
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: input.metadata.title,
        Author: input.metadata.author,
        Subject: input.metadata.subject,
        Keywords: input.metadata.keywords,
        Creator: input.brand,
        // The software that wrote the file, as the footer already says.
        Producer: 'UBOSS',
        CreationDate: input.issuedAt,
        ModDate: input.issuedAt,
      },
    });
    this.doc.registerFont('Body', FONTS.body);
    this.doc.registerFont('Bold', FONTS.bold);
    this.doc.registerFont('Mono', FONTS.mono);
    this.finished = new Promise((resolve, reject) => {
      this.doc.on('data', (chunk: Buffer) => this.chunks.push(chunk));
      this.doc.on('end', () => {
        resolve(Buffer.concat(this.chunks));
      });
      this.doc.on('error', reject);
    });
    this.watermark();
  }

  private watermark(): void {
    if (!this.input.draft) return;
    const { doc } = this;
    doc.save();
    doc.font('Bold').fontSize(40).fillColor('#DC2626').opacity(0.1);
    doc.rotate(-38, { origin: [A6.width / 2, A6.height / 2] });
    doc.text('DRAFT', 0, A6.height / 2 - 24, { width: A6.width, align: 'center', lineBreak: false });
    doc.restore();
    doc.opacity(1);
  }

  private style(style: TextStyle): void {
    this.doc
      .font(style.font ?? 'Body')
      .fontSize(Math.max(MIN_FONT_SIZE, style.size ?? 6.5))
      .fillColor(style.color ?? INK);
  }

  measure(text: string, width: number, style: TextStyle = {}): number {
    this.style(style);
    return this.doc.heightOfString(text === '' ? ' ' : text, { width, lineGap: 0.4 });
  }

  write(text: string, x: number, y: number, width: number, style: TextStyle = {}): number {
    this.style(style);
    const height = this.doc.heightOfString(text === '' ? ' ' : text, { width, lineGap: 0.4 });
    this.doc.text(text === '' ? ' ' : text, x, y, { width, lineGap: 0.4, align: style.align ?? 'left' });
    return height;
  }

  newPage(): void {
    this.doc.addPage({ size: [A6.width, A6.height], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    this.watermark();
    this.y = TOP + 2;
    this.continuationHeader();
  }

  /** On a continuation page, say whose document it is before anything else. */
  private continuationHeader(): void {
    const label = `${this.input.title} · ${this.input.number ?? 'DRAFT'} (continued)`;
    this.y += this.write(label, MARGIN, this.y, CONTENT_WIDTH, { font: 'Bold', size: 6.5, color: NAVY });
    this.y += 2;
    this.rule(0.8);
  }

  /** Start a new page when fewer than `height` points remain. */
  ensure(height: number): boolean {
    if (this.y + height > BOTTOM) {
      this.newPage();
      return true;
    }
    return false;
  }

  /** A section rule, edge to edge inside the border, like a label's dividers. */
  rule(weight = 0.9): void {
    this.doc
      .moveTo(BORDER_INSET, this.y)
      .lineTo(A6.width - BORDER_INSET, this.y)
      .lineWidth(weight)
      .strokeColor(RULE)
      .stroke();
    this.y += 4;
  }

  // --- Sections --------------------------------------------------------------

  header(): void {
    const { doc } = this;
    const top = this.y;
    // The mark: a globe, drawn - so it is sharp at any print resolution and
    // carries no raster to vary between renders.
    const cx = MARGIN + 10;
    const cy = top + 10;
    doc.save();
    doc.circle(cx, cy, 9.5).fillColor(NAVY).fill();
    doc.lineWidth(0.6).strokeColor('#FFFFFF');
    doc.ellipse(cx, cy, 4.2, 9.5).stroke();
    doc.moveTo(cx, cy - 9.5).lineTo(cx, cy + 9.5).stroke();
    doc.moveTo(cx - 9.5, cy).lineTo(cx + 9.5, cy).stroke();
    doc.moveTo(cx - 8.2, cy - 4.8).lineTo(cx + 8.2, cy - 4.8).stroke();
    doc.moveTo(cx - 8.2, cy + 4.8).lineTo(cx + 8.2, cy + 4.8).stroke();
    doc.restore();

    const brandX = MARGIN + 24;
    this.write(this.input.brand, brandX, top + 1, 110, { font: 'Bold', size: 10.5, color: NAVY });
    this.write('Powered by UBOSS', brandX, top + 13.5, 110, { font: 'Body', size: 6, color: BLUE });

    const titleWidth = 128;
    const titleX = MARGIN + CONTENT_WIDTH - titleWidth;
    let titleY = top;
    titleY += this.write(this.input.title, titleX, titleY, titleWidth, { font: 'Bold', size: 11, color: INK, align: 'right' });
    titleY += this.write(this.input.subtitle, titleX, titleY, titleWidth, { font: 'Bold', size: 6.5, color: BLUE, align: 'right' });
    if (this.input.draft) {
      titleY += this.write('DRAFT - NOT A VALID DOCUMENT', titleX, titleY + 0.5, titleWidth, {
        font: 'Bold',
        size: 6,
        color: '#B91C1C',
        align: 'right',
      });
    }
    this.y = Math.max(top + 22, titleY) + 3;
    this.rule(1.2);
  }

  parties(): void {
    const gap = 8;
    const width = (CONTENT_WIDTH - gap) / 2;
    const blocks = [this.input.supplier, this.input.recipient];
    const heights = blocks.map((block) => this.partyHeight(block, width));
    this.ensure(Math.max(...heights) + 4);
    const top = this.y;
    blocks.forEach((block, index) => {
      const x = MARGIN + index * (width + gap);
      let y = top;
      y += this.write(block.heading.toUpperCase(), x, y, width, { font: 'Bold', size: 6, color: BLUE });
      y += 0.5;
      y += this.write(block.name, x, y, width, { font: 'Bold', size: 6.8, color: INK });
      for (const line of block.lines) y += this.write(line, x, y, width, { size: 6 });
    });
    // The column rule between the two parties.
    this.doc
      .moveTo(MARGIN + width + gap / 2, top - 1)
      .lineTo(MARGIN + width + gap / 2, top + Math.max(...heights))
      .lineWidth(0.5)
      .strokeColor(HAIRLINE)
      .stroke();
    this.y = top + Math.max(...heights) + 3;
    this.rule();
  }

  private partyHeight(block: PdfParty, width: number): number {
    return (
      this.measure(block.heading.toUpperCase(), width, { font: 'Bold', size: 6 }) +
      0.5 +
      this.measure(block.name, width, { font: 'Bold', size: 6.8 }) +
      block.lines.reduce((sum, line) => sum + this.measure(line, width, { size: 6 }), 0)
    );
  }

  facts(): void {
    const columns = 3;
    const width = CONTENT_WIDTH / columns;
    const items = this.input.facts;
    for (let row = 0; row < Math.ceil(items.length / columns); row += 1) {
      const slice = items.slice(row * columns, row * columns + columns);
      const height =
        Math.max(
          ...slice.map(
            ([label, value]) =>
              this.measure(label.toUpperCase(), width - 4, { font: 'Bold', size: 6 }) +
              this.measure(value === '' ? '-' : value, width - 4, { size: 6.5 }),
          ),
        ) + 2;
      this.ensure(height);
      const top = this.y;
      slice.forEach(([label, value], index) => {
        const x = MARGIN + index * width;
        const labelHeight = this.write(label.toUpperCase(), x, top, width - 4, { font: 'Bold', size: 6, color: MUTED });
        this.write(value === '' ? '-' : value, x, top + labelHeight, width - 4, { font: 'Body', size: 6.5 });
      });
      this.y = top + height;
    }
    this.y += 1;
    this.rule();
  }

  /**
   * The document's identity, machine-readable: the number as a barcode on the
   * left, the verification QR on the right - the way a shipping label pairs
   * its barcodes with the blocks they belong to.
   */
  identification(text: string, label: string): void {
    const widths = code128Widths(text);
    const modules = widths.reduce((sum, width) => sum + width, 0);
    const qr = this.input.qr;
    const qrSize = 42;
    const qrColumn = qr === null ? 0 : 70;
    const barcodeWidth = CONTENT_WIDTH - qrColumn - (qr === null ? 0 : 8);
    // Ten modules of quiet zone each side, and never narrower than 0.6 pt a
    // module (0.21 mm) - comfortably above what a laser or a 203 dpi thermal
    // printer resolves.
    const module = Math.min(1.1, Math.max(0.6, barcodeWidth / (modules + 20)));
    const symbolWidth = modules * module;
    const barHeight = 22;
    const barcodeHeight = 8 + barHeight + 10;
    const qrHeight = qr === null ? 0 : qrSize + this.measure('VERIFY THIS DOCUMENT', qrColumn, { font: 'Bold', size: 6 }) + 1;
    const height = Math.max(barcodeHeight, qrHeight);
    this.ensure(height + 4);
    const top = this.y;

    this.write(label.toUpperCase(), MARGIN, top, barcodeWidth, { font: 'Bold', size: 6, color: MUTED, align: 'center' });
    const barsTop = top + 8 + (height - barcodeHeight) / 2;
    let x = MARGIN + (barcodeWidth - symbolWidth) / 2;
    this.doc.save().fillColor('#000000');
    widths.forEach((width, index) => {
      if (index % 2 === 0) this.doc.rect(x, barsTop, width * module, barHeight).fill();
      x += width * module;
    });
    this.doc.restore();
    this.write(text, MARGIN, barsTop + barHeight + 1.5, barcodeWidth, { font: 'Mono', size: 7, align: 'center' });

    if (qr !== null) {
      const qrX = MARGIN + CONTENT_WIDTH - qrColumn;
      this.doc
        .moveTo(qrX - 4, top - 1)
        .lineTo(qrX - 4, top + height)
        .lineWidth(0.5)
        .strokeColor(HAIRLINE)
        .stroke();
      this.qrCode(qr.url, qrX + (qrColumn - qrSize) / 2, top, qrSize);
      this.write('VERIFY THIS DOCUMENT', qrX, top + qrSize + 1, qrColumn, { font: 'Bold', size: 6, color: NAVY, align: 'center' });
    }
    this.y = top + height + 2;
    this.rule();
  }

  /**
   * A QR code as filled squares. Vector, like the barcode: sharp at any print
   * resolution, and the same bytes on every render. Error correction M, one
   * module of quiet zone inside the square it is given.
   */
  private qrCode(text: string, x: number, y: number, size: number): void {
    const code = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const count = code.modules.size;
    const cell = size / (count + 2);
    this.doc.save().fillColor('#000000');
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (code.modules.get(row, column) === 1) this.doc.rect(x + (column + 1) * cell, y + (row + 1) * cell, cell, cell).fill();
      }
    }
    this.doc.restore();
  }

  /**
   * The service lines. Each takes two rows - the description across the full
   * width, then its figures - because seven columns side by side on 105 mm
   * leave room for neither a sentence nor a lakh-grouped amount.
   */
  table(): void {
    const columns: { header: string; weight: number; align: 'left' | 'right' | 'center' }[] = [
      { header: this.input.codeHeader, weight: 34, align: 'left' },
      { header: 'Order Ref', weight: 55, align: 'left' },
      { header: `Taxable (${this.input.currency})`, weight: 54, align: 'right' },
      { header: 'Rate', weight: 24, align: 'right' },
      { header: 'Tax', weight: 50, align: 'right' },
      { header: 'Total', weight: 54, align: 'right' },
    ];
    const total = columns.reduce((sum, column) => sum + column.weight, 0);
    const widths = columns.map((column) => (column.weight / total) * CONTENT_WIDTH);
    const pad = 1.8;
    const headerCells = columns.map((column) => column.header);
    const descriptionHeader = 'Description of service';
    const headerHeight =
      this.measure(descriptionHeader, CONTENT_WIDTH - pad * 2, { font: 'Bold', size: 6 }) +
      Math.max(...headerCells.map((cell, index) => this.measure(cell, (widths[index] ?? 20) - pad * 2, { font: 'Bold', size: 6 }))) +
      pad * 3;

    const drawHeader = (): void => {
      const top = this.y;
      this.doc.rect(MARGIN, top, CONTENT_WIDTH, headerHeight).fillColor(SHADE).fill();
      const first = this.write(descriptionHeader, MARGIN + pad, top + pad, CONTENT_WIDTH - pad * 2, { font: 'Bold', size: 6, color: NAVY });
      let x = MARGIN;
      headerCells.forEach((cell, index) => {
        const width = widths[index] ?? 20;
        this.write(cell, x + pad, top + pad * 2 + first, width - pad * 2, { font: 'Bold', size: 6, color: NAVY, align: columns[index]?.align ?? 'left' });
        x += width;
      });
      this.doc.moveTo(MARGIN, top).lineTo(MARGIN + CONTENT_WIDTH, top).lineWidth(0.8).strokeColor(RULE).stroke();
      this.doc
        .moveTo(MARGIN, top + headerHeight)
        .lineTo(MARGIN + CONTENT_WIDTH, top + headerHeight)
        .lineWidth(0.6)
        .strokeColor(RULE)
        .stroke();
      this.y = top + headerHeight;
    };

    const figuresOf = (line: PdfLine): string[] => [line.code, line.orderReference, line.taxable, line.rate, line.tax, line.total];
    const descriptionHeight = (line: PdfLine): number =>
      this.measure(line.description, CONTENT_WIDTH - pad * 2, { size: 6.3 }) +
      (line.detail === null ? 0 : this.measure(line.detail, CONTENT_WIDTH - pad * 2, { size: 6, color: MUTED }));
    const figuresHeight = (line: PdfLine): number =>
      Math.max(...figuresOf(line).map((cell, index) => this.measure(cell, (widths[index] ?? 20) - pad * 2, { size: 6.3 })));
    const rowHeight = (line: PdfLine): number => descriptionHeight(line) + figuresHeight(line) + pad * 3;

    const first = this.input.lines[0];
    // The header is never the last thing on a page.
    this.ensure(headerHeight + (first === undefined ? 12 : rowHeight(first)));
    drawHeader();

    for (const line of this.input.lines) {
      const height = rowHeight(line);
      if (this.y + height > BOTTOM) {
        this.newPage();
        drawHeader();
      }
      const top = this.y;
      let y = top + pad;
      y += this.write(line.description, MARGIN + pad, y, CONTENT_WIDTH - pad * 2, { size: 6.3 });
      if (line.detail !== null) y += this.write(line.detail, MARGIN + pad, y, CONTENT_WIDTH - pad * 2, { size: 6, color: MUTED });
      y += pad;
      let x = MARGIN;
      figuresOf(line).forEach((cell, index) => {
        const width = widths[index] ?? 20;
        this.write(cell, x + pad, y, width - pad * 2, { size: 6.3, align: columns[index]?.align ?? 'left' });
        x += width;
      });
      this.doc
        .moveTo(MARGIN, top + height)
        .lineTo(MARGIN + CONTENT_WIDTH, top + height)
        .lineWidth(0.4)
        .strokeColor(HAIRLINE)
        .stroke();
      this.y = top + height;
    }
    this.y += 3;
  }

  totals(): void {
    const leftWidth = CONTENT_WIDTH * 0.44;
    const rightWidth = CONTENT_WIDTH - leftWidth - 8;
    const rightX = MARGIN + leftWidth + 8;
    const rows = this.input.totals;
    const rowHeights = rows.map((row) =>
      Math.max(
        this.measure(row.label, rightWidth * 0.58, { font: row.strong === true ? 'Bold' : 'Body', size: row.strong === true ? 7.5 : 6.3 }),
        this.measure(row.value, rightWidth * 0.42, { font: row.strong === true ? 'Bold' : 'Body', size: row.strong === true ? 7.5 : 6.3 }),
      ) + (row.strong === true ? 3.6 : 0.5),
    );
    const rightHeight = rowHeights.reduce((sum, height) => sum + height, 0);

    const collection = this.input.collection;
    const leftHeight =
      this.measure('AMOUNT IN WORDS', leftWidth, { font: 'Bold', size: 6 }) +
      this.measure(this.input.amountInWords, leftWidth, { size: 6.2 }) +
      (collection === null
        ? 0
        : 6 +
          this.measure(collection.label, leftWidth - 6, { font: 'Bold', size: 6.2 }) +
          this.measure(collection.value, leftWidth - 6, { font: 'Bold', size: 7.5 }) +
          (collection.note === null ? 0 : this.measure(collection.note, leftWidth - 6, { size: 6 })) +
          6);

    this.ensure(Math.max(rightHeight, leftHeight) + 4);
    const top = this.y;

    // Right: the figures, the grand total on a navy band.
    let y = top;
    rows.forEach((row, index) => {
      const height = rowHeights[index] ?? 8;
      if (row.strong === true) {
        this.doc.rect(rightX - 2, y, rightWidth + 2, height).fillColor(NAVY).fill();
        this.write(row.label, rightX + 1, y + 2, rightWidth * 0.58, { font: 'Bold', size: 7.5, color: '#FFFFFF' });
        this.write(row.value, rightX + rightWidth * 0.58, y + 2, rightWidth * 0.42 - 2, { font: 'Bold', size: 7.5, color: '#FFFFFF', align: 'right' });
      } else {
        this.write(row.label, rightX, y + 0.6, rightWidth * 0.58, { size: 6.3, color: MUTED });
        this.write(row.value, rightX + rightWidth * 0.58, y + 0.6, rightWidth * 0.42, { size: 6.3, align: 'right' });
      }
      y += height;
    });

    // Left: the amount in words, then what the seller has to do about it.
    let left = top;
    left += this.write('AMOUNT IN WORDS', MARGIN, left, leftWidth, { font: 'Bold', size: 6, color: MUTED });
    left += this.write(this.input.amountInWords, MARGIN, left, leftWidth, { size: 6.2 });
    if (collection !== null) {
      left += 3;
      const boxTop = left;
      let inner = boxTop + 3;
      inner += this.write(collection.label, MARGIN + 3, inner, leftWidth - 6, { font: 'Bold', size: 6.2, color: NAVY });
      inner += this.write(collection.value, MARGIN + 3, inner, leftWidth - 6, { font: 'Bold', size: 7.5 });
      if (collection.note !== null) inner += this.write(collection.note, MARGIN + 3, inner, leftWidth - 6, { size: 6, color: MUTED });
      this.doc.rect(MARGIN, boxTop, leftWidth, inner - boxTop + 3).lineWidth(0.9).strokeColor(RULE).stroke();
      left = inner + 3;
    }

    this.y = Math.max(y, left) + 3;
    this.rule(1.2);
  }

  /** Declarations, the verification note and the legal footer, flowed paragraph by paragraph. */
  closing(): void {
    const paragraphs: { text: string; style: TextStyle }[] = [
      ...this.input.declarations.map((text) => ({ text, style: { font: 'Bold', size: 6 } })),
      ...(this.input.qr === null ? [] : [{ text: this.input.qr.caption, style: { size: 6, color: MUTED } as TextStyle }]),
      ...this.input.footerLines.map((text) => ({ text, style: { size: 6 } })),
    ];
    for (const paragraph of paragraphs) {
      const height = this.measure(paragraph.text, CONTENT_WIDTH, paragraph.style) + 1;
      this.ensure(height);
      this.write(paragraph.text, MARGIN, this.y, CONTENT_WIDTH, paragraph.style);
      this.y += height;
    }
  }

  /** Border, footer and "1/2" on every page; close the file. */
  async finish(): Promise<{ bytes: Buffer; pageCount: number }> {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    const count = range.count;
    for (let index = 0; index < count; index += 1) {
      doc.switchToPage(range.start + index);
      doc
        .rect(BORDER_INSET, BORDER_INSET, A6.width - BORDER_INSET * 2, A6.height - BORDER_INSET * 2)
        .lineWidth(1.6)
        .strokeColor(RULE)
        .stroke();
      const footerTop = A6.height - BORDER_INSET - FOOTER_HEIGHT;
      doc
        .moveTo(BORDER_INSET, footerTop)
        .lineTo(A6.width - BORDER_INSET, footerTop)
        .lineWidth(0.9)
        .strokeColor(RULE)
        .stroke();
      const textY = footerTop + 3.5;
      const third = CONTENT_WIDTH / 3;
      doc.font('Mono').fontSize(6).fillColor(MUTED);
      doc.text(this.input.number ?? 'DRAFT', MARGIN, textY, { width: third + 20, lineBreak: false });
      doc.font('Bold').fontSize(7).fillColor(INK);
      doc.text(`${String(index + 1)}/${String(count)}`, MARGIN + third, textY - 0.5, { width: third, align: 'center', lineBreak: false });
      doc.font('Body').fontSize(6).fillColor(MUTED);
      doc.text(this.input.brand, MARGIN + third * 2, textY, { width: third, align: 'right', lineBreak: false });
    }
    doc.end();
    return { bytes: await this.finished, pageCount: count };
  }
}

/** Render a commission invoice or credit note. Deterministic for a given document. */
export async function renderCommissionDocument(input: CommissionPdfDocument): Promise<{ bytes: Buffer; pageCount: number }> {
  const builder = new A6Builder(input);
  builder.header();
  builder.parties();
  builder.facts();
  // A draft has no number, so nothing to encode: it gets no barcode and no QR.
  if (input.number !== null && !input.draft) builder.identification(input.number, `${input.title === 'CREDIT NOTE' ? 'Credit note' : 'Invoice'} No.`);
  builder.table();
  builder.totals();
  builder.closing();
  return builder.finish();
}
