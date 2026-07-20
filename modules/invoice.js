const puppeteer = require('puppeteer');
const loadConfig = require('../handlers/config');
const path = require('path');
const fs = require('fs');

const settings = loadConfig('./config.toml');

class InvoiceGenerator {
  /**
   * Generate a PDF invoice for a given transaction
   * @param {Object} transaction - Prisma transaction object with parsed details
   * @param {Object} user - Prisma user object
   * @returns {Buffer} PDF buffer
   */
  async generateInvoice(transaction, user) {
    const details = typeof transaction.details === 'string'
      ? JSON.parse(transaction.details)
      : (transaction.details || {});

    const seller = settings.billing?.seller || {};
    const vatRate = settings.billing?.vat_rate ?? 20.0;
    const logo = settings.website?.logo || '';

    // Determine what was purchased and what the customer actually paid
    const { description, quantity, paidAmount, itemType } = this._getItemInfo(transaction, details);

    // The paid amount is the total including VAT (EU B2C norm)
    const total = paidAmount;
    const subtotal = vatRate > 0 ? total / (1 + vatRate / 100) : total;
    const vatAmount = total - subtotal;
    const unitPrice = quantity > 0 ? subtotal / quantity : 0;

    // Payment method
    const paymentMethod = details.payment_method || 'Carte bancaire';

    // User name
    const firstName = details.first_name || user.username || '';
    const lastName = details.last_name || '';

    // Invoice date = transaction creation date
    const invoiceDate = new Date(transaction.createdAt);
    const invoiceId = transaction.id.substring(0, 13).toUpperCase();

    // Format numbers
    const fmt = (n) => n.toFixed(2);

    const html = this._buildHtml({
      seller, logo, vatRate,
      firstName, lastName,
      email: user.email,
      invoiceId, invoiceDate,
      paymentMethod,
      description, quantity, unitPrice,
      subtotal, vatAmount, total,
      itemType, fmt
    });

    return await this._htmlToPdf(html);
  }

  _getItemInfo(transaction, details) {
    // Defaults
    let description = transaction.description || 'Purchase';
    let quantity = 1;
    let paidAmount = 0;
    let itemType = 'credit';

    if (details.package_amount) {
      // Coin purchase — details.price_usd is the total paid (incl. VAT)
      quantity = details.package_amount;
      paidAmount = details.price_usd;
      description = `Purchase of ${details.package_amount} Coins`;
      itemType = 'coins';
    } else if (details.amount_usd) {
      // Credit top-up — details.amount_usd is the total paid (incl. VAT)
      quantity = 1;
      paidAmount = details.amount_usd;
      description = `Credit Top-up ($${details.amount_usd})`;
      itemType = 'credit';
    } else if (details.resource) {
      // Store purchase with coins — no real money, no VAT
      quantity = details.amount || 1;
      paidAmount = 0;
      description = `Resource Purchase: ${details.resource} x${quantity}`;
      itemType = 'resource';
    } else if (details.bundle) {
      // Bundle purchase — price_usd is the total paid (incl. VAT)
      quantity = 1;
      paidAmount = details.price_usd || (Math.abs(transaction.amount) / 100);
      description = `Bundle ${details.name || details.bundle}`;
      itemType = 'bundle';
    } else {
      // Generic: use the transaction amount (in cents) as total paid (incl. VAT)
      paidAmount = Math.abs(transaction.amount) / 100;
      quantity = 1;
      description = transaction.description || 'Purchase';
    }

    return { description, quantity, paidAmount, itemType };
  }

  _buildHtml({ seller, logo, vatRate, firstName, lastName, email, invoiceId, invoiceDate, paymentMethod, description, quantity, unitPrice, subtotal, vatAmount, total, itemType, fmt }) {
    const dateStr = invoiceDate.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    background: #ffffff;
    color: #1a1a2e;
    padding: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .invoice-container {
    max-width: 800px;
    margin: 0 auto;
    padding: 48px;
    background: #ffffff;
    min-height: 100vh;
    position: relative;
  }
  /* Top bar */
  .top-bar {
    width: 100%;
    height: 4px;
    background: #1e3a5f;
    margin-bottom: 36px;
  }
  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 40px;
  }
  .logo-section {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .logo {
    width: 44px;
    height: 44px;
    border-radius: 8px;
    object-fit: contain;
  }
  .brand-name {
    font-size: 20px;
    font-weight: 700;
    color: #1a1a2e;
    letter-spacing: -0.3px;
  }
  .invoice-badge {
    display: inline-block;
    background: #1e3a5f;
    color: #ffffff;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 1.2px;
    padding: 5px 18px;
    text-align: center;
  }
  .invoice-id {
    font-size: 11px;
    color: #6b7280;
    letter-spacing: 0.3px;
    margin-top: 6px;
    text-align: right;
  }
  /* Info Grid */
  .info-grid {
    display: flex;
    gap: 40px;
    margin-bottom: 40px;
  }
  .info-block {
    flex: 1;
  }
  .info-block-title {
    font-size: 9px;
    font-weight: 700;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    margin-bottom: 8px;
  }
  .info-block p {
    font-size: 12.5px;
    line-height: 1.7;
    color: #374151;
  }
  .info-block .label {
    color: #9ca3af;
    font-size: 10px;
    display: block;
    margin-bottom: 1px;
  }
  .info-block .value {
    color: #1a1a2e;
    font-weight: 500;
  }
  /* Divider */
  .divider {
    height: 1px;
    background: #e5e7eb;
    margin-bottom: 28px;
  }
  /* Items table */
  .items-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 24px;
  }
  .items-table thead th {
    background: #f8f9fa;
    padding: 10px 14px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #6b7280;
    text-align: left;
    border-bottom: 1px solid #e5e7eb;
  }
  .items-table thead th:last-child { text-align: right; }
  .items-table thead th:nth-child(2) { text-align: center; }
  .items-table thead th:nth-child(3) { text-align: right; }
  .items-table tbody td {
    padding: 12px 14px;
    font-size: 13px;
    color: #374151;
    border-bottom: 1px solid #f3f4f6;
  }
  .items-table tbody tr:last-child td { border-bottom: none; }
  .items-table tbody td:last-child { text-align: right; font-weight: 600; color: #1a1a2e; }
  .items-table tbody td:nth-child(2) { text-align: center; color: #6b7280; }
  .items-table tbody td:nth-child(3) { text-align: right; }
  /* Totals */
  .totals {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 28px;
  }
  .totals-inner {
    width: 280px;
  }
  .total-row {
    display: flex;
    justify-content: space-between;
    padding: 5px 0;
    font-size: 13px;
    color: #6b7280;
  }
  .total-row.sub {
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: 8px;
    margin-bottom: 4px;
  }
  .total-row.grand {
    border-top: 1px solid #e5e7eb;
    margin-top: 4px;
    padding-top: 8px;
    font-size: 16px;
    font-weight: 700;
    color: #1a1a2e;
  }
  /* Payment info */
  .payment-info {
    display: flex;
    gap: 32px;
    padding: 14px 0;
    border-top: 1px solid #e5e7eb;
    margin-bottom: 28px;
  }
  .payment-info-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .payment-info-item .label {
    font-size: 9px;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 600;
  }
  .payment-info-item .value {
    font-size: 13px;
    color: #1a1a2e;
    font-weight: 500;
  }
  /* Footer */
  .footer {
    text-align: center;
    padding-top: 20px;
    border-top: 1px solid #e5e7eb;
    font-size: 10px;
    color: #9ca3af;
    line-height: 1.6;
  }
  @media print {
    body { background: #ffffff; }
    .invoice-container { box-shadow: none; }
  }
</style>
</head>
<body>
<div class="invoice-container">
  <div class="top-bar"></div>

  <!-- Header -->
  <div class="header">
    <div class="logo-section">
      ${logo ? `<img class="logo" src="${logo}" alt="Logo" />` : ''}
      <div>
        <div class="brand-name">${seller.business_name || settings.website?.name || 'Business'}</div>
      </div>
    </div>
    <div>
      <div class="invoice-badge">INVOICE</div>
      <div class="invoice-id">${invoiceId}</div>
    </div>
  </div>

  <!-- Info Grid -->
  <div class="info-grid">
    <div class="info-block">
      <div class="info-block-title">From</div>
      <p>
        <strong>${seller.business_name || ''}</strong><br>
        ${seller.address || ''}<br>
        ${seller.postal_code || ''} ${seller.city || ''}<br>
        ${seller.country || ''}<br>
        ${seller.phone ? `Tel: ${seller.phone}` : ''}
      </p>
      ${seller.vat_number ? `<p style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb"><span style="color:#6b7280">VAT:</span> ${seller.vat_number}</p>` : ''}
      ${seller.siret_number ? `<p><span style="color:#6b7280">SIRET:</span> ${seller.siret_number}</p>` : ''}
    </div>
    <div class="info-block">
      <div class="info-block-title">Bill To</div>
      <p>
        ${firstName || lastName ? `<strong>${firstName} ${lastName}</strong><br>` : ''}
        ${email}
      </p>
    </div>
    <div class="info-block" style="text-align:right">
      <div class="info-block-title">Invoice Details</div>
      <p>
        <span class="label">Invoice No.</span>
        <span class="value">${invoiceId}</span><br><br>
        <span class="label">Issue Date</span>
        <span class="value">${dateStr}</span>
      </p>
    </div>
  </div>

  <div class="divider"></div>

  <!-- Items Table -->
  <table class="items-table">
    <thead>
      <tr>
        <th>Description</th>
        <th>Qty</th>
        <th>Unit Price</th>
        <th>Total</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight:500">${description}</td>
        <td>${quantity}</td>
        <td>${fmt(unitPrice)} USD</td>
        <td>${fmt(subtotal)} USD</td>
      </tr>
    </tbody>
  </table>

  <!-- Totals -->
  <div class="totals">
    <div class="totals-inner">
      <div class="total-row sub">
        <span>Subtotal</span>
        <span>${fmt(subtotal)} USD</span>
      </div>
      <div class="total-row">
        <span>VAT (${vatRate}%)</span>
        <span>${fmt(vatAmount)} USD</span>
      </div>
      <div class="total-row grand">
        <span>Total (incl. VAT)</span>
        <span>${fmt(total)} USD</span>
      </div>
    </div>
  </div>

  <!-- Payment Info -->
  <div class="payment-info">
    <div class="payment-info-item">
      <span class="label">Payment Method</span>
      <span class="value">${paymentMethod}</span>
    </div>
    <div class="payment-info-item">
      <span class="label">Status</span>
      <span class="value" style="color:#059669">Paid</span>
    </div>
    <div class="payment-info-item">
      <span class="label">Type</span>
      <span class="value">${itemType === 'coins' ? 'Coin Purchase' : itemType === 'credit' ? 'Credit Top-up' : itemType === 'bundle' ? 'Bundle' : 'Purchase'}</span>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    ${seller.business_name || ''} &mdash; ${seller.address ? seller.address + ', ' : ''}${seller.postal_code || ''} ${seller.city || ''} ${seller.country || ''}<br>
    ${seller.vat_number ? `VAT: ${seller.vat_number}` : ''} ${seller.siret_number ? `&mdash; SIRET: ${seller.siret_number}` : ''}
  </div>
</div>
</body>
</html>`;
  }

  async _htmlToPdf(html) {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      await page.setViewport({ width: 800, height: 600 });

      const pdfBuffer = await page.pdf({
        format: 'A4',
        margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
        printBackground: true,
        displayHeaderFooter: false,
      });

      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
    }
  }
}

module.exports = InvoiceGenerator;
