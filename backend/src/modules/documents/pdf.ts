/**
 * A small A4 layout toolkit over PDFKit, for the documents this server issues.
 *
 * Four properties every issued document needs, and the reason this is its own
 * module rather than PDFKit calls scattered through two templates:
 *
 *   - **Deterministic.** The same data renders the same bytes. The document's
 *     creation date is the ISSUE date passed in, never the wall clock, and
 *     nothing random reaches the file - so the SHA-256 stored at issue can be
 *     re-derived and a copy shown to be the issued one.
 *   - **No clipped rows.** A table row is measured before it is drawn; one
 *     that would not fit starts a new page, and the header row is repeated at
 *     the top of every page the table continues onto.
 *   - **"Page X of Y" on every page.** Pages are buffered and numbered at the
 *     end, when Y is known.
 *   - **Every script this deployment sells in.** PDFKit's built-in fonts are
 *     WinAnsi and have no ₹, no Greek, no Polish ł. DejaVu Sans (Bitstream Vera
 *     licence, redistributable) has all of them.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import PDFDocument from 'pdfkit';

const require = createRequire(import.meta.url);
const FONT_DIR = join(dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');

export const FONTS = Object.freeze({
  body: join(FONT_DIR, 'DejaVuSans.ttf'),
  bold: join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  mono: join(FONT_DIR, 'DejaVuSansMono.ttf'),
});

const PAGE = { width: 595.28, height: 841.89 } as const;
const MARGIN = 36;
const FOOTER_SPACE = 34;

const INK = '#1E293B';
const MUTED = '#64748B';
const RULE = '#CBD5E1';
const SHADE = '#F1F5F9';
const BRAND = '#102A43';

export interface Column {
  header: string;
  /** Share of the table width. The shares need not add to one. */
  weight: number;
  align?: 'left' | 'right' | 'center';
}

export interface PdfMeta {
  title: string;
  /** Becomes the PDF CreationDate and ModDate. The issue time, never "now". */
  issuedAt: Date;
  author: string;
  subject: string;
  /** Printed in every footer beside the page number. */
  reference: string;
  /** Drawn across every page of a preview. Null on an issued document. */
  watermark: string | null;
}

export class PdfBuilder {
  readonly doc: PDFKit.PDFDocument;
  private readonly chunks: Buffer[] = [];
  private readonly finished: Promise<Buffer>;
  private readonly meta: PdfMeta;

  constructor(meta: PdfMeta) {
    this.meta = meta;
    this.doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN, bottom: MARGIN + FOOTER_SPACE, left: MARGIN, right: MARGIN },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: meta.title,
        Author: meta.author,
        Subject: meta.subject,
        Creator: 'Glovia',
        Producer: 'Glovia',
        CreationDate: meta.issuedAt,
        ModDate: meta.issuedAt,
      },
    });
    this.doc.registerFont('Body', FONTS.body);
    this.doc.registerFont('Bold', FONTS.bold);
    this.doc.registerFont('Mono', FONTS.mono);
    this.doc.font('Body').fontSize(8.5).fillColor(INK);

    this.finished = new Promise((resolve, reject) => {
      this.doc.on('data', (chunk: Buffer) => this.chunks.push(chunk));
      this.doc.on('end', () => {
        resolve(Buffer.concat(this.chunks));
      });
      this.doc.on('error', reject);
    });

    this.doc.on('pageAdded', () => {
      this.drawWatermark();
    });
    this.drawWatermark();
  }

  get contentWidth(): number {
    return PAGE.width - MARGIN * 2;
  }

  private get bottom(): number {
    return PAGE.height - MARGIN - FOOTER_SPACE;
  }

  private drawWatermark(): void {
    if (this.meta.watermark === null) return;
    const { doc } = this;
    doc.save();
    doc.font('Bold').fontSize(46).fillColor('#DC2626').opacity(0.1);
    doc.rotate(-35, { origin: [PAGE.width / 2, PAGE.height / 2] });
    doc.text(this.meta.watermark, 40, PAGE.height / 2 - 30, {
      width: PAGE.width - 80,
      align: 'center',
    });
    doc.restore();
    doc.opacity(1).font('Body').fontSize(8.5).fillColor(INK);
  }

  /** Start a new page when fewer than `height` points remain. */
  ensureSpace(height: number): void {
    if (this.doc.y + height > this.bottom) this.doc.addPage();
  }

  title(text: string, subtitle: string | null, marker: string | null): void {
    const { doc } = this;
    const top = doc.y;
    doc
      .font('Bold')
      .fontSize(16)
      .fillColor(BRAND)
      .text(text, MARGIN, top, { width: this.contentWidth * 0.65 });
    if (subtitle !== null)
      doc
        .font('Body')
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(subtitle, { width: this.contentWidth * 0.65 });
    const afterTitle = doc.y;
    if (marker !== null) {
      doc
        .font('Bold')
        .fontSize(8)
        .fillColor(MUTED)
        .text(marker, MARGIN + this.contentWidth * 0.6, top + 4, {
          width: this.contentWidth * 0.4,
          align: 'right',
        });
    }
    doc.y = Math.max(afterTitle, doc.y) + 6;
    this.rule();
  }

  rule(): void {
    const { doc } = this;
    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + this.contentWidth, doc.y)
      .lineWidth(0.6)
      .strokeColor(RULE)
      .stroke();
    doc.y += 6;
    doc.fillColor(INK);
  }

  /**
   * Side-by-side boxes of labelled lines - supplier and buyer, shipper and
   * consignee. Each box is as tall as its tallest neighbour.
   */
  boxes(boxes: { heading: string; lines: string[] }[]): void {
    const { doc } = this;
    const gap = 8;
    const width = (this.contentWidth - gap * (boxes.length - 1)) / boxes.length;
    const pad = 6;

    doc.font('Body').fontSize(8);
    const heights = boxes.map(
      (box) =>
        14 +
        box.lines.reduce(
          (sum, line) =>
            sum + doc.heightOfString(line === '' ? ' ' : line, { width: width - pad * 2 }) + 1,
          0,
        ) +
        pad,
    );
    const height = Math.max(...heights);
    this.ensureSpace(height + 4);

    const top = doc.y;
    boxes.forEach((box, index) => {
      const left = MARGIN + index * (width + gap);
      doc.roundedRect(left, top, width, height, 3).lineWidth(0.6).strokeColor(RULE).stroke();
      doc
        .font('Bold')
        .fontSize(7)
        .fillColor(MUTED)
        .text(box.heading.toUpperCase(), left + pad, top + pad, { width: width - pad * 2 });
      let y = top + pad + 11;
      doc.font('Body').fontSize(8).fillColor(INK);
      box.lines.forEach((line, lineIndex) => {
        doc.font(lineIndex === 0 ? 'Bold' : 'Body');
        doc.text(line === '' ? ' ' : line, left + pad, y, { width: width - pad * 2 });
        y = doc.y + 1;
      });
    });
    doc.font('Body').fillColor(INK);
    doc.x = MARGIN;
    doc.y = top + height + 8;
  }

  /** Label: value pairs, flowing across `columns` columns. */
  facts(items: [string, string][], columns = 3): void {
    const { doc } = this;
    const width = this.contentWidth / columns;
    const rows = Math.ceil(items.length / columns);
    for (let row = 0; row < rows; row += 1) {
      const slice = items.slice(row * columns, row * columns + columns);
      doc.font('Body').fontSize(8);
      const height =
        Math.max(
          ...slice.map(([, value]) =>
            doc.heightOfString(value === '' ? '—' : value, { width: width - 6 }),
          ),
        ) + 11;
      this.ensureSpace(height);
      const top = doc.y;
      slice.forEach(([label, value], index) => {
        const left = MARGIN + index * width;
        doc
          .font('Bold')
          .fontSize(6.5)
          .fillColor(MUTED)
          .text(label.toUpperCase(), left, top, { width: width - 6 });
        doc
          .font('Body')
          .fontSize(8)
          .fillColor(INK)
          .text(value === '' ? '—' : value, left, top + 9, { width: width - 6 });
      });
      doc.x = MARGIN;
      doc.y = top + height + 2;
    }
    doc.y += 4;
  }

  /**
   * A table that never clips a row and repeats its header on every page.
   * Cells are strings; the caller formats money and quantities.
   */
  table(
    columns: Column[],
    rows: string[][],
    options: { fontSize?: number; boldLastRow?: boolean } = {},
  ): void {
    const { doc } = this;
    const fontSize = options.fontSize ?? 7.5;
    const pad = 3;
    const total = columns.reduce((sum, column) => sum + column.weight, 0);
    const widths = columns.map((column) => (column.weight / total) * this.contentWidth);

    const measure = (cells: string[], font: 'Body' | 'Bold'): number => {
      doc.font(font).fontSize(fontSize);
      return (
        Math.max(
          ...cells.map((cell, index) =>
            doc.heightOfString(cell === '' ? ' ' : cell, {
              width: (widths[index] ?? 20) - pad * 2,
            }),
          ),
        ) +
        pad * 2
      );
    };

    const drawRow = (cells: string[], font: 'Body' | 'Bold', shaded: boolean): void => {
      const height = measure(cells, font);
      const top = doc.y;
      if (shaded) doc.rect(MARGIN, top, this.contentWidth, height).fillColor(SHADE).fill();
      let left = MARGIN;
      cells.forEach((cell, index) => {
        const width = widths[index] ?? 20;
        doc
          .font(font)
          .fontSize(fontSize)
          .fillColor(INK)
          .text(cell === '' ? ' ' : cell, left + pad, top + pad, {
            width: width - pad * 2,
            align: columns[index]?.align ?? 'left',
          });
        left += width;
      });
      doc
        .moveTo(MARGIN, top + height)
        .lineTo(MARGIN + this.contentWidth, top + height)
        .lineWidth(0.4)
        .strokeColor(RULE)
        .stroke();
      doc.x = MARGIN;
      doc.y = top + height;
    };

    const header = columns.map((column) => column.header);
    const headerHeight = measure(header, 'Bold');

    // The header must never be the last thing on a page.
    this.ensureSpace(headerHeight + measure(rows[0] ?? header, 'Body'));
    drawRow(header, 'Bold', true);

    rows.forEach((row, index) => {
      const isLast = index === rows.length - 1;
      const font = options.boldLastRow === true && isLast ? 'Bold' : 'Body';
      const height = measure(row, font);
      if (doc.y + height > this.bottom) {
        doc.addPage();
        drawRow(header, 'Bold', true);
      }
      drawRow(row, font, false);
    });

    doc.y += 8;
  }

  /** Right-aligned label / amount pairs under a table. */
  totals(rows: { label: string; value: string; strong?: boolean }[]): void {
    const { doc } = this;
    const width = this.contentWidth * 0.45;
    const left = MARGIN + this.contentWidth - width;
    this.ensureSpace(rows.length * 13 + 6);
    for (const row of rows) {
      const top = doc.y;
      doc
        .font(row.strong === true ? 'Bold' : 'Body')
        .fontSize(row.strong === true ? 9 : 8)
        .fillColor(INK);
      doc.text(row.label, left, top, { width: width * 0.6 });
      doc.text(row.value, left + width * 0.6, top, { width: width * 0.4, align: 'right' });
      doc.y = Math.max(doc.y, top + 12);
    }
    doc.x = MARGIN;
    doc.y += 6;
  }

  paragraph(text: string, options: { bold?: boolean; muted?: boolean; size?: number } = {}): void {
    const { doc } = this;
    doc
      .font(options.bold === true ? 'Bold' : 'Body')
      .fontSize(options.size ?? 8)
      .fillColor(options.muted === true ? MUTED : INK);
    this.ensureSpace(doc.heightOfString(text, { width: this.contentWidth }) + 4);
    doc.text(text, MARGIN, doc.y, { width: this.contentWidth });
    doc.fillColor(INK);
    doc.y += 4;
  }

  /**
   * The closing block: a QR on the left, signature boxes on the right. Kept
   * together on one page.
   */
  closing(input: {
    qrPng: Buffer | null;
    qrCaption: string | null;
    signatures: { heading: string; lines: string[] }[];
  }): void {
    const { doc } = this;
    const height = 96;
    this.ensureSpace(height + 8);
    const top = doc.y;

    let left = MARGIN;
    if (input.qrPng !== null) {
      doc.image(input.qrPng, MARGIN, top, { width: 78, height: 78 });
      if (input.qrCaption !== null) {
        doc
          .font('Mono')
          .fontSize(6)
          .fillColor(MUTED)
          .text(input.qrCaption, MARGIN, top + 80, { width: 110 });
      }
      left = MARGIN + 120;
    }

    const count = Math.max(1, input.signatures.length);
    const width = (MARGIN + this.contentWidth - left - 8 * (count - 1)) / count;
    input.signatures.forEach((signature, index) => {
      const x = left + index * (width + 8);
      doc
        .roundedRect(x, top, width, height - 6, 3)
        .lineWidth(0.6)
        .strokeColor(RULE)
        .stroke();
      doc
        .font('Bold')
        .fontSize(7)
        .fillColor(MUTED)
        .text(signature.heading.toUpperCase(), x + 6, top + 6, { width: width - 12 });
      let y = top + 18;
      doc.font('Body').fontSize(7.5).fillColor(INK);
      for (const line of signature.lines) {
        doc.text(line, x + 6, y, { width: width - 12 });
        y = doc.y + 2;
      }
      doc
        .moveTo(x + 6, top + height - 22)
        .lineTo(x + width - 6, top + height - 22)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      doc
        .font('Body')
        .fontSize(6.5)
        .fillColor(MUTED)
        .text('Signature', x + 6, top + height - 19, { width: width - 12 });
    });
    doc.x = MARGIN;
    doc.y = top + height + 4;
    doc.fillColor(INK);
  }

  /** Number the pages, close the file, and hand back its bytes. */
  async finish(): Promise<{ bytes: Buffer; pageCount: number }> {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    const count = range.count;
    for (let index = 0; index < count; index += 1) {
      doc.switchToPage(range.start + index);
      // Writing inside the bottom margin would otherwise make PDFKit start a
      // new page; take the margin away for the footer line only.
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .font('Body')
        .fontSize(7)
        .fillColor(MUTED)
        .text(this.meta.reference, MARGIN, PAGE.height - MARGIN - 12, {
          width: this.contentWidth / 2,
          lineBreak: false,
        })
        .text(
          `Page ${String(index + 1)} of ${String(count)}`,
          MARGIN + this.contentWidth / 2,
          PAGE.height - MARGIN - 12,
          {
            width: this.contentWidth / 2,
            align: 'right',
            lineBreak: false,
          },
        );
      doc.page.margins.bottom = margin;
    }
    doc.end();
    return { bytes: await this.finished, pageCount: count };
  }
}
