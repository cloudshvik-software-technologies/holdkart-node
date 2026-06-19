import nodemailer from 'nodemailer';
import 'dotenv/config';

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ─── Shared layout helpers ────────────────────────────────────────────────────

const header = () => `
  <tr>
    <td style="padding:28px 36px 24px;border-bottom:1px solid #f0f2f5;">
      <span style="font-size:1.3rem;font-weight:700;color:#1a1a2e;letter-spacing:-0.3px;">
        Hold<span style="color:#3b5bdb;">Kart</span>
      </span>
    </td>
  </tr>`;

const footer = () => `
  <tr>
    <td style="padding:20px 36px;background:#f7f8fc;border-top:1px solid #f0f2f5;">
      <p style="margin:0;font-size:0.74rem;color:#c4c9d4;line-height:1.6;">
        This email was sent by HoldKart. If you have questions, contact our support team.
      </p>
    </td>
  </tr>`;

const wrap = (bodyHtml) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f7f8fc;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fc;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:10px;border:1px solid #e8ebf0;overflow:hidden;">
          ${header()}
          ${bodyHtml}
          ${footer()}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

const btn = (href, label) => `
  <table cellpadding="0" cellspacing="0" style="margin-top:24px;">
    <tr>
      <td style="border-radius:8px;background:#3b5bdb;">
        <a href="${href}" style="display:inline-block;padding:13px 28px;font-size:0.9rem;font-weight:600;color:#ffffff;text-decoration:none;">
          ${label}
        </a>
      </td>
    </tr>
  </table>`;

const infoRow = (label, value) =>
  `<tr>
    <td style="padding:6px 0;font-size:0.82rem;color:#6b7280;width:150px;">${label}</td>
    <td style="padding:6px 0;font-size:0.82rem;color:#1a1a2e;font-weight:600;">${value}</td>
  </tr>`;

const infoTable = (rows) => `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border:1px solid #e8ebf0;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="padding:16px 20px;background:#f7f8fc;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${rows}
        </table>
      </td>
    </tr>
  </table>`;

const statusBadge = (label, color) =>
  `<span style="display:inline-block;padding:4px 12px;border-radius:20px;background:${color}20;color:${color};font-size:0.78rem;font-weight:700;letter-spacing:0.3px;">${label}</span>`;

// ─── sendEmail (generic plain text) ──────────────────────────────────────────

export const sendEmail = async (to, subject, text) => {
  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    text,
  });
};

// ─── 1. Account Created ───────────────────────────────────────────────────────

export const sendWelcomeEmail = async (to, name) => {
  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#3b5bdb15;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:2rem;">🎉</div>
      </div>
      <p style="margin:0 0 6px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">Welcome to HoldKart, ${name}!</p>
      <p style="margin:0 0 20px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        Your account has been created successfully. You're now part of the HoldKart community — 
        where you get the best deals on quality products.
      </p>
      <p style="margin:0 0 8px;font-size:0.875rem;color:#374151;font-weight:600;">Here's what you can do:</p>
      <ul style="margin:0 0 24px;padding-left:20px;font-size:0.875rem;color:#6b7280;line-height:2;">
        <li>Browse &amp; buy quality products</li>
        <li>Join group deals to unlock exclusive pricing</li>
        <li>Track your orders in real time</li>
      </ul>
      ${btn(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/products`, 'Start Shopping')}
    </td>
  </tr>`);

  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Welcome to HoldKart! 🎉',
    text: `Hi ${name},\n\nWelcome to HoldKart! Your account has been created successfully.\n\nShop quality products at exclusive group deal prices.\n\nTeam HoldKart`,
    html,
  });
};

// ─── 2. Password Changed Successfully ────────────────────────────────────────

export const sendPasswordChangedEmail = async (to, name) => {
  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#10b98115;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:2rem;">🔒</div>
      </div>
      <p style="margin:0 0 6px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">Password Changed Successfully</p>
      <p style="margin:0 0 20px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        Hi ${name}, your HoldKart account password was changed successfully on 
        <strong style="color:#374151;">${new Date().toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })}</strong>.
      </p>
      <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
        <p style="margin:0;font-size:0.83rem;color:#856404;line-height:1.6;">
          ⚠️ If you did not make this change, please <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/forgot" style="color:#856404;font-weight:700;">reset your password</a> immediately and contact our support team.
        </p>
      </div>
      <p style="margin:0;font-size:0.8rem;color:#9da3ae;line-height:1.6;">
        For your security, we recommend using a strong, unique password and not sharing it with anyone.
      </p>
    </td>
  </tr>`);

  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Your HoldKart password was changed',
    text: `Hi ${name},\n\nYour HoldKart password was changed successfully. If you didn't do this, please reset your password immediately.\n\nTeam HoldKart`,
    html,
  });
};

// ─── 3. Deal Joined (deposit paid) ───────────────────────────────────────────

export const sendDealJoinedEmail = async (to, { name, productName, quantity, depositAmount, campaignId, holdPrice, retailPrice }) => {
  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#3b5bdb15;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:2rem;">🤝</div>
      </div>
      <p style="margin:0 0 6px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">You're in the Group Deal!</p>
      <p style="margin:0 0 20px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        Hi ${name}, your deposit has been received. You've successfully joined the group deal for 
        <strong style="color:#374151;">${productName}</strong>.
        Once the target is reached, the product will be added to your cart at the locked deal price.
      </p>
      ${btn(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns`, 'Track Deal Progress')}
    </td>
  </tr>`);

  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: `You've joined the deal for ${productName}!`,
    text: `Hi ${name},\n\nYou've successfully joined the group deal for ${productName} (x${quantity}).\nDeposit paid: ₹${Number(depositAmount || 0).toLocaleString('en-IN')}\n\nOnce the target is reached, the product will appear in your cart.\n\nTeam HoldKart`,
    html,
  });
};

// ─── 4. Order Placed ──────────────────────────────────────────────────────────

export const sendOrderPlacedEmail = async (to, { name, orderNumber, productName, quantity, amount, address, paymentMethod }) => {
  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#10b98115;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:2rem;">✅</div>
      </div>
      <p style="margin:0 0 4px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">Order Placed Successfully!</p>
      <p style="margin:0 0 20px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        Hi ${name}, thank you for your order. We've received it and will keep you updated on its progress.
      </p>
      ${infoTable(`
        ${infoRow('Order ID', `#${orderNumber}`)}
        ${infoRow('Product', productName)}
        ${infoRow('Quantity', `${quantity} unit${quantity > 1 ? 's' : ''}`)}
        ${infoRow('Amount Paid', `₹${Number(amount).toLocaleString('en-IN')}`)}
        ${infoRow('Payment', paymentMethod || 'COD')}
        ${infoRow('Delivery Address', address)}
      `)}
      <div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:14px 18px;margin:20px 0 0;">
        <p style="margin:0;font-size:0.83rem;color:#2e7d32;line-height:1.6;">
          📦 You'll receive an email and notification when your order is shipped.
        </p>
      </div>
      ${btn(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/orders`, 'View My Orders')}
    </td>
  </tr>`);

  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Order Confirmed – #${orderNumber}`,
    text: `Hi ${name},\n\nYour order #${orderNumber} has been placed successfully.\n\nProduct: ${productName}\nQuantity: ${quantity}\nAmount: ₹${Number(amount).toLocaleString('en-IN')}\nPayment: ${paymentMethod || 'COD'}\nDelivery Address: ${address}\n\nTeam HoldKart`,
    html,
  });
};

// ─── 5. Invoice Email (PDF attachment, sent on delivery) ──────────────────────

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

/**
 * Generate an invoice PDF buffer using pdfkit, replicating the HoldKart
 * "Tax Invoice" layout used on the website's Invoice page (src/pages/Invoice.jsx):
 * seller/order meta, billing & shipping address, GST-split product table
 * (Product, HSN/SAC, Qty, Gross, Disc, Taxable, SGST, CGST, Total),
 * optional fee rows, grand total, and Payment Status: Paid.
 */
const generateInvoicePdf = async ({
  name, orderNumber, productName, quantity, amount, address, paymentMethod, orderDate,
  category, sellerName, sellerEmail, phFee, ppFee,
}) => {
  const PDFDocument = require('pdfkit');
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const navy  = '#1e3c72';
    const orange = '#FF6B00';
    const dark  = '#111111';
    const grey  = '#6b7280';
    const line  = '#d1d5db';
    const headerBg = '#f3f4f6';
    const totalBg  = '#eef2ff';

    const pageW = doc.page.width;
    const left  = doc.page.margins.left;
    const right = pageW - doc.page.margins.right;
    const fullW = right - left;

    const n2 = (v) => Number(v || 0).toFixed(2);
    const rupee = (v) => `Rs.${n2(v)}`;

    // ── Amounts & GST split (mirrors Invoice.jsx) ──
    const qty     = quantity || 1;
    const prodAmt = Number(amount) || 0;
    const ph      = (!isNaN(Number(phFee)) && Number(phFee) > 0) ? Number(phFee) : 10;
    const pp      = (!isNaN(Number(ppFee)) && Number(ppFee) > 0) ? Number(ppFee) : 9;
    const grandTotal = prodAmt + ph + pp;

    const split = (val) => {
      const base = +(val / 1.18).toFixed(2);
      const tax  = +(val - base).toFixed(2);
      const sgst = +(tax / 2).toFixed(2);
      const cgst = +(tax - sgst).toFixed(2);
      return { base, sgst, cgst };
    };
    const prod = split(prodAmt);
    const phS  = split(ph);
    const ppS  = split(pp);

    const totGross   = prodAmt + ph + pp;
    const totTaxable = prod.base + phS.base + ppS.base;
    const totSgst    = prod.sgst + phS.sgst + ppS.sgst;
    const totCgst    = prod.cgst + phS.cgst + ppS.cgst;

    const dateStr = orderDate || new Date().toLocaleDateString('en-IN');
    const invoiceNum = `INV-${orderNumber}`;

    // ── Title bar ──
    doc.font('Helvetica-Bold').fontSize(20).fillColor(navy).text('Hold', left, 36, { continued: true });
    doc.fillColor(orange).text('Kart');
    doc.font('Helvetica').fontSize(8).fillColor(grey).text("INDIA'S SMART SHOP", left, 58);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(dark).text('Tax Invoice', left, 72);
    doc.moveTo(left, 92).lineTo(right, 92).lineWidth(1.5).strokeColor(navy).stroke();

    // ── Seller + order meta ──
    let y = 102;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(dark).text(`Sold By: ${sellerName || 'HoldKart Seller'}`, left, y);
    doc.font('Helvetica').fontSize(8).fillColor('#555555')
      .text(sellerEmail || 'support@holdkart.in', left, y + 13)
      .text('India  |  GSTIN: 33AAAAA0000A1Z5', left, y + 25);

    const metaRows = [
      ['Order ID:', String(orderNumber)],
      ['Order Date:', dateStr],
      ['Invoice Date:', dateStr],
      ['Invoice #:', invoiceNum],
    ];
    metaRows.forEach(([k, v], i) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151').text(k, right - 220, y + i * 12, { width: 110, align: 'right' });
      doc.font('Helvetica').fontSize(8).fillColor(dark).text(v, right - 105, y + i * 12, { width: 105, align: 'right' });
    });

    // ── Billing / Shipping ──
    y = 160;
    const halfW = fullW / 2;
    doc.rect(left, y, fullW, 16).fillAndStroke(headerBg, line);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(dark)
      .text('Billing Address', left + 6, y + 4)
      .text('Shipping Address', left + halfW + 6, y + 4);
    doc.moveTo(left + halfW, y).lineTo(left + halfW, y + 16).strokeColor(line).stroke();

    const addrY = y + 16;
    const addrHeight = 56;
    doc.rect(left, addrY, fullW, addrHeight).strokeColor(line).stroke();
    doc.moveTo(left + halfW, addrY).lineTo(left + halfW, addrY + addrHeight).strokeColor(line).stroke();
    [left, left + halfW].forEach((x) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text(name, x + 6, addrY + 6);
      doc.font('Helvetica').fontSize(8).fillColor('#374151').text(address || '', x + 6, addrY + 18, { width: halfW - 12 });
    });

    // ── Product table ──
    const tableY = addrY + addrHeight + 6;
    const cols = [
      { label: 'Product',      w: fullW * 0.24, align: 'left' },
      { label: 'HSN/SAC',      w: fullW * 0.09, align: 'center' },
      { label: 'Qty',          w: fullW * 0.05, align: 'right' },
      { label: 'Gross Amt Rs', w: fullW * 0.11, align: 'right' },
      { label: 'Disc Rs',      w: fullW * 0.08, align: 'right' },
      { label: 'Taxable Rs',   w: fullW * 0.12, align: 'right' },
      { label: 'SGST Rs',      w: fullW * 0.11, align: 'right' },
      { label: 'CGST Rs',      w: fullW * 0.09, align: 'right' },
      { label: 'Total Rs',     w: fullW * 0.11, align: 'right' },
    ];
    const colX = [];
    let cx = left;
    cols.forEach(c => { colX.push(cx); cx += c.w; });

    const rowHeader = (yy, h, bg) => {
      doc.rect(left, yy, fullW, h).fillAndStroke(bg, line);
      colX.forEach((x) => doc.moveTo(x, yy).lineTo(x, yy + h).strokeColor(line).stroke());
      doc.moveTo(right, yy).lineTo(right, yy + h).strokeColor(line).stroke();
    };

    // header row
    rowHeader(tableY, 16, headerBg);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(dark);
    cols.forEach((c, i) => doc.text(c.label, colX[i] + 3, tableY + 5, { width: c.w - 6, align: c.align }));

    // product row
    let rowY = tableY + 16;
    const rowH1 = 36;
    rowHeader(rowY, rowH1, '#ffffff');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text(productName, colX[0] + 3, rowY + 4, { width: cols[0].w - 6 });
    doc.font('Helvetica').fontSize(6.5).fillColor(grey)
      .text(category || '', colX[0] + 3, rowY + 15, { width: cols[0].w - 6 })
      .text('Warranty: 1 Year', colX[0] + 3, rowY + 24, { width: cols[0].w - 6 });
    doc.font('Helvetica').fontSize(7).fillColor(dark);
    doc.text('85183019', colX[1] + 3, rowY + 4, { width: cols[1].w - 6, align: 'center' });
    doc.text(String(qty), colX[2] + 3, rowY + 4, { width: cols[2].w - 6, align: 'right' });
    doc.text(rupee(prodAmt), colX[3] + 3, rowY + 4, { width: cols[3].w - 6, align: 'right' });
    doc.text('0.00', colX[4] + 3, rowY + 4, { width: cols[4].w - 6, align: 'right' });
    doc.text(rupee(prod.base), colX[5] + 3, rowY + 4, { width: cols[5].w - 6, align: 'right' });
    doc.text(rupee(prod.sgst), colX[6] + 3, rowY + 4, { width: cols[6].w - 6, align: 'right' });
    doc.text(rupee(prod.cgst), colX[7] + 3, rowY + 4, { width: cols[7].w - 6, align: 'right' });
    doc.text(rupee(prodAmt), colX[8] + 3, rowY + 4, { width: cols[8].w - 6, align: 'right' });

    rowY += rowH1;

    const feeRow = (label, sac, fee, s) => {
      const rowH = 22;
      rowHeader(rowY, rowH, '#fafafa');
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(dark).text(label, colX[0] + 3, rowY + 4, { width: cols[0].w - 6 });
      doc.font('Helvetica').fontSize(6).fillColor(grey).text(sac, colX[0] + 3, rowY + 14, { width: cols[0].w - 6 });
      doc.font('Helvetica').fontSize(7).fillColor(dark);
      doc.text('—', colX[1] + 3, rowY + 6, { width: cols[1].w - 6, align: 'center' });
      doc.text('1', colX[2] + 3, rowY + 6, { width: cols[2].w - 6, align: 'right' });
      doc.text(rupee(fee), colX[3] + 3, rowY + 6, { width: cols[3].w - 6, align: 'right' });
      doc.text('0.00', colX[4] + 3, rowY + 6, { width: cols[4].w - 6, align: 'right' });
      doc.text(rupee(s.base), colX[5] + 3, rowY + 6, { width: cols[5].w - 6, align: 'right' });
      doc.text(rupee(s.sgst), colX[6] + 3, rowY + 6, { width: cols[6].w - 6, align: 'right' });
      doc.text(rupee(s.cgst), colX[7] + 3, rowY + 6, { width: cols[7].w - 6, align: 'right' });
      doc.text(rupee(fee), colX[8] + 3, rowY + 6, { width: cols[8].w - 6, align: 'right' });
      rowY += rowH;
    };
    if (ph > 0) feeRow('Payment Handling Charges', 'SAC: 998599 | IGST: 18.0%', ph, phS);
    if (pp > 0) feeRow('Protect Promise Fee', 'SAC: 998599 | SGST: 9.0% | CGST: 9.0%', pp, ppS);

    // total row
    const totRowH = 18;
    rowHeader(rowY, totRowH, totalBg);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(dark);
    doc.text('Total', colX[0] + 3, rowY + 5, { width: cols[0].w - 6 });
    doc.text('—', colX[1] + 3, rowY + 5, { width: cols[1].w - 6, align: 'center' });
    doc.text(String(qty), colX[2] + 3, rowY + 5, { width: cols[2].w - 6, align: 'right' });
    doc.text(rupee(totGross), colX[3] + 3, rowY + 5, { width: cols[3].w - 6, align: 'right' });
    doc.text('0.00', colX[4] + 3, rowY + 5, { width: cols[4].w - 6, align: 'right' });
    doc.text(rupee(totTaxable), colX[5] + 3, rowY + 5, { width: cols[5].w - 6, align: 'right' });
    doc.text(rupee(totSgst), colX[6] + 3, rowY + 5, { width: cols[6].w - 6, align: 'right' });
    doc.text(rupee(totCgst), colX[7] + 3, rowY + 5, { width: cols[7].w - 6, align: 'right' });
    doc.text(rupee(grandTotal), colX[8] + 3, rowY + 5, { width: cols[8].w - 6, align: 'right' });
    rowY += totRowH;

    // ── Returns policy + grand total / payment ──
    const blockY = rowY + 10;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text('Returns Policy:', left, blockY, { continued: true });
    doc.font('Helvetica').fontSize(8).fillColor('#555555')
      .text(' Please return item with the original brand box/price tag, original packing and invoice.', { width: fullW * 0.6 });
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#555555')
      .text('Goods sold are intended for end user consumption and not for re-sale.', left, blockY + 24, { width: fullW * 0.6 });

    const rightX = right - 180;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(dark).text(`Grand Total   ${rupee(grandTotal)}`, rightX, blockY, { width: 180, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#555555').text('Payment:', rightX, blockY + 16, { width: 90, align: 'left' });
    const pmLabel = (paymentMethod || '').toUpperCase().includes('COD') ? 'Cash On Delivery' : (paymentMethod || 'Online');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text(pmLabel, rightX, blockY + 16, { width: 180, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#555555').text('Status:', rightX, blockY + 30, { width: 90, align: 'left' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#16a34a').text('Paid', rightX, blockY + 30, { width: 180, align: 'right' });

    // ── Signature ──
    const sigY = blockY + 60;
    doc.moveTo(left, sigY).lineTo(right, sigY).strokeColor('#e5e7eb').stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(grey).text('System-generated invoice. Contact: support@holdkart.in', left, sigY + 8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(navy).text('Hold', right - 110, sigY + 8, { width: 55, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(orange).text('Kart', right - 55, sigY + 8, { width: 55, align: 'left' });
    doc.moveTo(right - 110, sigY + 36).lineTo(right, sigY + 36).strokeColor('#555555').stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor('#555555').text('Authorised Signatory', right - 110, sigY + 40, { width: 110, align: 'right' });

    doc.font('Helvetica').fontSize(7).fillColor('#9ca3af').text('E. & O.E.   page 1 of 1', left, sigY + 60, { width: fullW, align: 'right' });

    doc.end();
  });
};

export const sendInvoiceEmail = async (to, { name, orderNumber, productName, quantity, amount, address, paymentMethod, orderDate, category, sellerName, sellerEmail, phFee, ppFee }) => {
  let pdfBuffer;
  try {
    pdfBuffer = await generateInvoicePdf({ name, orderNumber, productName, quantity, amount, address, paymentMethod, orderDate, category, sellerName, sellerEmail, phFee, ppFee });
  } catch (e) {
    console.error('[sendInvoiceEmail] PDF generation failed:', e.message);
  }

  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#3b5bdb15;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:2rem;">🧾</div>
      </div>
      <p style="margin:0 0 6px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">Your Invoice is Ready</p>
      <p style="margin:0 0 20px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        Hi ${name}, your order <strong style="color:#1a1a2e;">#${orderNumber}</strong> has been delivered.
        Please find your invoice attached as a PDF — you can download and save it for your records.
      </p>
      <div style="background:#f0f4ff;border:1px solid #c7d2fe;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
        <p style="margin:0;font-size:0.83rem;color:#3730a3;line-height:1.6;">
          📎 Invoice <strong>#${orderNumber}</strong> is attached to this email as a PDF.
        </p>
      </div>
      ${btn((process.env.FRONTEND_URL || 'http://localhost:5173') + '/orders', 'View My Orders')}
    </td>
  </tr>`);

  const mailOptions = {
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Invoice for Order #${orderNumber} – HoldKart`,
    text: `Hi ${name},\n\nYour order #${orderNumber} has been delivered. Please find your invoice attached.\n\nProduct: ${productName} x${quantity}\nTotal Paid: Rs.${Number(amount).toLocaleString('en-IN')}\nPayment: ${paymentMethod || 'COD'}\n\nTeam HoldKart`,
    html,
    attachments: pdfBuffer ? [{
      filename: `HoldKart_Invoice_${orderNumber}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }] : [],
  };

  await transporter.sendMail(mailOptions);
};

// ─── 6. Deal Target Reached ───────────────────────────────────────────────────

export const sendDealTargetReachedEmail = async (to, { name, productName, holdPrice, quantity }) => {
  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#f59e0b15;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:2rem;">🎯</div>
      </div>
      <p style="margin:0 0 6px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">The Target Has Been Reached!</p>
      <p style="margin:0 0 20px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        Great news, ${name}! The group deal for <strong style="color:#374151;">${productName}</strong> has hit its target. 
        Your item${quantity > 1 ? 's have' : ' has'} been added to your cart at the locked deal price.
      </p>
      ${infoTable(`
        ${infoRow('Product', productName)}
        ${infoRow('Quantity', `${quantity} unit${quantity > 1 ? 's' : ''}`)}
        ${holdPrice ? infoRow('Your Deal Price', `₹${Number(holdPrice).toLocaleString('en-IN')}`) : ''}
      `)}
      <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:14px 18px;margin:20px 0 0;">
        <p style="margin:0;font-size:0.83rem;color:#7b5e00;line-height:1.6;">
          ⏰ Go to your cart and complete your order payment!
        </p>
      </div>
      ${btn(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/cart`, 'Go to Cart')}
    </td>
  </tr>`);

  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: `🎯 Deal Target Reached – ${productName} is yours!`,
    text: `Hi ${name},\n\nThe group deal target for ${productName} has been reached! Your item has been added to your cart.\n\nGo complete your order now!\n\nTeam HoldKart`,
    html,
  });
};

// ─── 7. Order Shipped ─────────────────────────────────────────────────────────

export const sendOrderShippedEmail = async (to, { name, orderNumber, productName, awbCode, trackingUrl, courierName }) => {
  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#3b5bdb15;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:2rem;">🚚</div>
      </div>
      <p style="margin:0 0 6px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">Your Order Has Been Shipped!</p>
      <p style="margin:0 0 20px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        Hi ${name}, great news! Your order for <strong style="color:#374151;">${productName}</strong> is on its way.
      </p>
      ${infoTable(`
        ${infoRow('Order ID', `#${orderNumber}`)}
        ${infoRow('Product', productName)}
        ${awbCode ? infoRow('Tracking / AWB', awbCode) : ''}
        ${courierName ? infoRow('Courier', courierName) : ''}
      `)}
      ${trackingUrl ? btn(trackingUrl, 'Track Your Package') : btn(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/orders`, 'View Order')}
    </td>
  </tr>`);

  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Your order #${orderNumber} has been shipped 🚚`,
    text: `Hi ${name},\n\nYour order #${orderNumber} (${productName}) has been shipped.\n${awbCode ? `AWB: ${awbCode}\n` : ''}${trackingUrl ? `Track: ${trackingUrl}\n` : ''}\nTeam HoldKart`,
    html,
  });
};

// ─── 8. Order Delivered ───────────────────────────────────────────────────────

export const sendOrderDeliveredEmail = async (to, { name, orderNumber, productName }) => {
  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#10b98115;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:2rem;">📦</div>
      </div>
      <p style="margin:0 0 6px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">Order Delivered!</p>
      <p style="margin:0 0 20px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        Hi ${name}, your order for <strong style="color:#374151;">${productName}</strong> has been delivered successfully. 
        We hope you love it!
      </p>
      ${infoTable(`
        ${infoRow('Order ID', `#${orderNumber}`)}
        ${infoRow('Product', productName)}
        ${infoRow('Delivered On', new Date().toLocaleDateString('en-IN', { dateStyle: 'long' }))}
      `)}
      <div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:14px 18px;margin:20px 0 0;">
        <p style="margin:0;font-size:0.83rem;color:#2e7d32;line-height:1.6;">
          ⭐ Enjoying your purchase? Leave a review and help other shoppers!
        </p>
      </div>
      ${btn(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/orders`, 'Write a Review')}
    </td>
  </tr>`);

  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Order #${orderNumber} Delivered – Thank you! 😊`,
    text: `Hi ${name},\n\nYour order #${orderNumber} (${productName}) has been delivered. We hope you love it!\n\nLeave a review to help others.\n\nTeam HoldKart`,
    html,
  });
};

// ─── 9. Refund Processed ─────────────────────────────────────────────────────

export const sendRefundProcessedEmail = async (to, { name, orderNumber, productName, refundAmount }) => {
  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:#10b98115;border-radius:50%;width:64px;height:64px;line-height:64px;font-size:2rem;">💰</div>
      </div>
      <p style="margin:0 0 6px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">Refund Processed</p>
      <p style="margin:0 0 20px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        Hi ${name}, your refund for order <strong style="color:#374151;">#${orderNumber}</strong> has been processed. 
        The amount will reflect in your original payment source within 5–7 business days.
      </p>
      ${infoTable(`
        ${infoRow('Order ID', `#${orderNumber}`)}
        ${infoRow('Product', productName)}
        ${refundAmount ? infoRow('Refund Amount', `₹${Number(refundAmount).toLocaleString('en-IN')}`) : ''}
        ${infoRow('Status', '✅ Processed')}
      `)}
      <p style="margin:20px 0 0;font-size:0.8rem;color:#9da3ae;line-height:1.6;">
        Refunds typically take 5–7 business days depending on your bank or payment provider. 
        If you have any concerns, contact our support team.
      </p>
      ${btn(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/orders`, 'View Orders')}
    </td>
  </tr>`);

  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Refund Processed – Order #${orderNumber}`,
    text: `Hi ${name},\n\nYour refund for order #${orderNumber} (${productName}) has been processed.\n${refundAmount ? `Amount: ₹${Number(refundAmount).toLocaleString('en-IN')}\n` : ''}It will reflect in your account within 5–7 business days.\n\nTeam HoldKart`,
    html,
  });
};

// ─── 10. Password Reset (existing) ────────────────────────────────────────────

export const sendPasswordResetEmail = async (to, resetLink) => {
  const html = wrap(`
  <tr>
    <td style="padding:36px 36px 28px;">
      <p style="margin:0 0 8px;font-size:1.05rem;font-weight:700;color:#1a1a2e;">
        Reset your password
      </p>
      <p style="margin:0 0 28px;font-size:0.875rem;color:#6b7280;line-height:1.7;">
        We received a request to reset the password for your HoldKart account.
        Click the button below to choose a new password. This link is valid for
        <strong style="color:#374151;">15 minutes</strong>.
      </p>
      ${btn(resetLink, 'Reset Password')}
      <p style="margin:28px 0 0;font-size:0.8rem;color:#9da3ae;line-height:1.6;">
        If the button doesn't work, copy and paste this link into your browser:
      </p>
      <p style="margin:6px 0 0;font-size:0.78rem;word-break:break-all;">
        <a href="${resetLink}" style="color:#3b5bdb;text-decoration:none;">${resetLink}</a>
      </p>
      <p style="margin:28px 0 0;font-size:0.8rem;color:#9da3ae;line-height:1.6;">
        If you did not request a password reset, you can safely ignore this email.
        Your password will not change.
      </p>
    </td>
  </tr>`);

  const text = `Reset your HoldKart password\n\nClick the link below to reset your password (valid 15 minutes):\n\n${resetLink}\n\nIf you did not request this, ignore this email.\n\nTeam HoldKart`;

  await transporter.sendMail({
    from: `"HoldKart" <${process.env.EMAIL_USER}>`,
    to,
    subject: 'Reset your HoldKart password',
    text,
    html,
  });
};