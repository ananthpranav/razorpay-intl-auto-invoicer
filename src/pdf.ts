import PDFDocument from 'pdfkit';
import type { InvoiceView } from './view.ts';

const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const LEFT = MARGIN;
const RIGHT = PAGE_WIDTH - MARGIN;
const WIDTH = RIGHT - LEFT;
const META_X = 335;
const PAD = 8;

const COLUMNS = {
  description: { x: LEFT, w: 255 },
  quantity: { x: LEFT + 255, w: 50 },
  unitPrice: { x: LEFT + 305, w: 90 },
  amount: { x: LEFT + 395, w: WIDTH - 395 },
};

const INK = '#1f2328';
const MUTED = '#59636e';
const RULE = '#d1d9e0';
const SHADE = '#f6f8fa';

export interface PdfOptions {
  /** Optional TTF/OTF font for names outside the Latin-1 range of the built-in Helvetica. */
  fontPath?: string;
}

export function renderInvoicePdf(view: InvoiceView, options: PdfOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: { Title: `Invoice ${view.number}`, Author: view.seller.name, Subject: `Invoice for ${view.period}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.registerFont('body', options.fontPath ?? 'Helvetica');
      doc.registerFont('bold', options.fontPath ?? 'Helvetica-Bold');
      new InvoiceLayout(doc, view).draw();
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

class InvoiceLayout {
  private doc: PDFKit.PDFDocument;
  private view: InvoiceView;
  private y = MARGIN;
  private style: Style = { size: 10 };

  constructor(doc: PDFKit.PDFDocument, view: InvoiceView) {
    this.doc = doc;
    this.view = view;
  }

  draw(): void {
    if (this.view.stamp) {
      this.watermark();
      // pdfkit can add a page in the middle of a text() call: put the text style back after the stamp.
      this.doc.on('pageAdded', () => {
        this.watermark();
        this.applyStyle(this.style);
      });
    }
    this.header();
    this.billTo();
    this.table();
    this.payment();
    this.footer();
  }

  private get bottom(): number {
    return this.doc.page.height - MARGIN;
  }

  /** Starts a new page when `height` more points would not fit. */
  private ensureRoom(height: number): void {
    if (this.y + height > this.bottom) {
      this.doc.addPage();
      this.y = MARGIN;
    }
  }

  private applyStyle(style: Style): void {
    this.style = style;
    this.doc.font(style.bold ? 'bold' : 'body').fontSize(style.size).fillColor(style.color ?? INK);
  }

  private text(value: string, x: number, y: number, width: number, style: Style): number {
    this.applyStyle(style);
    this.doc.text(value, x, y, { width, align: style.align ?? 'left' });
    return this.doc.y;
  }

  private measure(value: string, width: number, style: Style): number {
    this.applyStyle(style);
    return this.doc.heightOfString(value, { width });
  }

  private watermark(): void {
    const { label, color } = this.view.stamp === 'paid'
      ? { label: 'PAID', color: '#1a7f37' }
      : { label: 'PREVIEW - NOT ISSUED', color: '#cf222e' };
    const { width, height } = this.doc.page;
    this.doc.save();
    this.doc.rotate(-30, { origin: [width / 2, height / 2] });
    this.doc.font('bold').fontSize(10);
    const size = Math.min(110, (10 * width * 0.85) / this.doc.widthOfString(label));
    this.doc.fontSize(size).fillColor(color).fillOpacity(0.12);
    this.doc.text(label, 0, height / 2 - size / 2, { width, align: 'center', lineBreak: false });
    this.doc.restore();
    this.doc.fillOpacity(1);
  }

  private header(): void {
    const { seller } = this.view;
    let top = MARGIN;
    if (seller.logo) {
      this.doc.image(seller.logo, LEFT, MARGIN, { fit: [140, 48] });
      top += 58;
    }
    let left = this.text(seller.name, LEFT, top, META_X - LEFT - 20, { size: 16, bold: true }) + 4;
    for (const line of seller.lines) {
      left = this.text(line, LEFT, left, META_X - LEFT - 20, { size: 9, color: MUTED }) + 1;
    }

    const metaWidth = RIGHT - META_X;
    let right = this.text('INVOICE', META_X, MARGIN, metaWidth, { size: 24, bold: true, align: 'right' }) + 8;
    const meta: Array<[string, string]> = [
      ['Invoice no.', this.view.number],
      ['Issue date', this.view.issueDate],
      ...(this.view.dueDate ? [['Due date', this.view.dueDate] as [string, string]] : []),
      ['Period', this.view.period],
    ];
    for (const [label, value] of meta) {
      this.text(label, META_X, right, 70, { size: 9, color: MUTED });
      right = Math.max(right + 14, this.text(value, META_X + 70, right, metaWidth - 70, { size: 9, bold: true, align: 'right' }) + 3);
    }
    if (this.view.razorpayId) {
      right = this.text(`Razorpay ref: ${this.view.razorpayId}`, META_X, right + 2, metaWidth, { size: 7.5, color: MUTED, align: 'right' });
    }
    this.y = Math.max(left, right) + 28;
  }

  private billTo(): void {
    const { billTo } = this.view;
    this.y = this.text('BILL TO', LEFT, this.y, 300, { size: 8, bold: true, color: MUTED }) + 4;
    if (billTo.name) this.y = this.text(billTo.name, LEFT, this.y, 300, { size: 11, bold: true }) + 2;
    for (const line of [...billTo.addressLines, ...(billTo.email ? [billTo.email] : [])]) {
      this.y = this.text(line, LEFT, this.y, 300, { size: 9 }) + 1;
    }
    this.y += 24;
  }

  private tableHeader(): void {
    const top = this.y;
    this.doc.rect(LEFT, top, WIDTH, 22).fill(SHADE);
    const style: Style = { size: 8, bold: true, color: MUTED };
    this.text('DESCRIPTION', COLUMNS.description.x + PAD, top + 7, COLUMNS.description.w - PAD, style);
    this.text('QTY', COLUMNS.quantity.x, top + 7, COLUMNS.quantity.w, { ...style, align: 'right' });
    this.text('UNIT PRICE', COLUMNS.unitPrice.x, top + 7, COLUMNS.unitPrice.w, { ...style, align: 'right' });
    this.text('AMOUNT', COLUMNS.amount.x, top + 7, COLUMNS.amount.w - PAD, { ...style, align: 'right' });
    this.y = top + 22;
  }

  private table(): void {
    this.ensureRoom(80);
    this.tableHeader();
    const textWidth = COLUMNS.description.w - PAD * 2;
    for (const row of this.view.rows) {
      const nameHeight = this.measure(row.name, textWidth, { size: 10, bold: true });
      const descriptionHeight = row.description ? this.measure(row.description, textWidth, { size: 8.5 }) + 2 : 0;
      const rowHeight = nameHeight + descriptionHeight + 16;
      if (this.y + rowHeight > this.bottom) {
        this.doc.addPage();
        this.y = MARGIN;
        this.tableHeader();
      }
      const top = this.y + 8;
      this.text(row.name, COLUMNS.description.x + PAD, top, textWidth, { size: 10, bold: true });
      if (row.description) {
        this.text(row.description, COLUMNS.description.x + PAD, top + nameHeight + 2, textWidth, { size: 8.5, color: MUTED });
      }
      this.text(row.quantity, COLUMNS.quantity.x, top, COLUMNS.quantity.w, { size: 10, align: 'right' });
      this.text(row.unitPrice, COLUMNS.unitPrice.x, top, COLUMNS.unitPrice.w, { size: 10, align: 'right' });
      this.text(row.amount, COLUMNS.amount.x, top, COLUMNS.amount.w - PAD, { size: 10, align: 'right' });
      this.y += rowHeight;
      this.doc.moveTo(LEFT, this.y).lineTo(RIGHT, this.y).lineWidth(0.5).strokeColor(RULE).stroke();
    }

    this.ensureRoom(40);
    const top = this.y + 12;
    const label = this.view.stamp === 'paid' ? 'Total paid' : 'Total due';
    this.text(label, COLUMNS.quantity.x, top, COLUMNS.quantity.w + COLUMNS.unitPrice.w, { size: 11, bold: true, align: 'right' });
    this.text(this.view.total, COLUMNS.amount.x, top, COLUMNS.amount.w - PAD, { size: 11, bold: true, align: 'right' });
    this.y = top + 40;
  }

  private payment(): void {
    const { payment } = this.view;
    const inner = WIDTH - 32;
    const labelWidth = 140;
    const valueWidth = inner - labelWidth;
    const rows: Array<[string, string]> = [
      ...payment.fields.map((field): [string, string] => [field.label, field.value]),
      ['Payment reference', payment.reference],
    ];
    const rowHeights = rows.map(([label, value]) =>
      Math.max(this.measure(label, labelWidth - 8, { size: 9 }), this.measure(value, valueWidth, { size: 9.5, bold: true })) + 5);
    const titleHeight = this.measure(payment.title, inner, { size: 11, bold: true });
    const noteHeight = payment.note ? this.measure(payment.note, inner, { size: 8.5 }) + 8 : 0;
    const height = 16 + titleHeight + 10 + rowHeights.reduce((sum, h) => sum + h, 0) + noteHeight + 12;

    this.ensureRoom(height);
    const top = this.y;
    this.doc.roundedRect(LEFT, top, WIDTH, height, 6).lineWidth(0.8).strokeColor(RULE).stroke();
    let y = this.text(payment.title, LEFT + 16, top + 16, inner, { size: 11, bold: true }) + 10;
    rows.forEach(([label, value], index) => {
      this.text(label, LEFT + 16, y, labelWidth - 8, { size: 9, color: MUTED });
      this.text(value, LEFT + 16 + labelWidth, y, valueWidth, { size: 9.5, bold: true });
      y += rowHeights[index] ?? 0;
    });
    if (payment.note) this.text(payment.note, LEFT + 16, y + 4, inner, { size: 8.5, color: MUTED });
    this.y = top + height + 20;
  }

  private footer(): void {
    for (const line of this.view.footerLines) {
      const height = this.measure(line, WIDTH, { size: 8.5 });
      this.ensureRoom(height + 2);
      this.y = this.text(line, LEFT, this.y, WIDTH, { size: 8.5, color: MUTED }) + 2;
    }
  }
}

interface Style {
  size: number;
  bold?: boolean;
  color?: string;
  align?: 'left' | 'right' | 'center';
}
