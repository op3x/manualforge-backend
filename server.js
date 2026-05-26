require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Stripe webhook needs raw body
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'manualos-backend' }));

// Create Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
    try {
          const { email } = req.body;
          const session = await stripe.checkout.sessions.create({
                  payment_method_types: ['card'],
                  mode: 'subscription',
                  line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
                  customer_email: email,
                  success_url: process.env.FRONTEND_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
                  cancel_url: process.env.FRONTEND_URL + '/cancel',
          });
          res.json({ url: session.url });
    } catch (err) {
          console.error('Checkout error:', err);
          res.status(500).json({ error: err.message });
    }
});

// Verify session after payment
app.get('/verify-session', async (req, res) => {
    try {
          const { session_id } = req.query;
          const session = await stripe.checkout.sessions.retrieve(session_id, {
                  expand: ['subscription', 'customer'],
          });
          res.json({
                  paid: session.payment_status === 'paid',
                  customer: session.customer_details,
                  subscription: session.subscription,
          });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

// Helper: calculate code reference percentage
// Counts how many distinct PLC identifiers/keywords from plcContent appear in the generated manual
function calculateCodeReferencePercentage(plcContent, manualText) {
    if (!plcContent || !manualText) return 0;

  // Extract meaningful tokens from PLC content (variable names, function names, labels)
  const tokenRegex = /\b([A-Za-z_][A-Za-z0-9_]{2,})\b/g;
    const plcTokens = new Set();
    let match;
    while ((match = tokenRegex.exec(plcContent)) !== null) {
          const token = match[1].toLowerCase();
          // Skip very common programming keywords
      const skip = new Set(['var', 'end', 'for', 'the', 'and', 'not', 'int', 'bool', 'true', 'false', 'then', 'else', 'begin', 'function', 'program', 'type', 'struct', 'array', 'real', 'word', 'byte', 'string']);
          if (!skip.has(token)) {
                  plcTokens.add(token);
          }
    }

  if (plcTokens.size === 0) return 0;

  const manualLower = manualText.toLowerCase();
    let referenced = 0;
    for (const token of plcTokens) {
          if (manualLower.includes(token)) {
                  referenced++;
          }
    }

  const percentage = Math.round((referenced / plcTokens.size) * 100);
    return Math.min(percentage, 100);
}

// Helper: generate PDF buffer from manual text + metadata
function generatePDF(manualText, brand, codeRefPercentage) {
    return new Promise((resolve, reject) => {
          const doc = new PDFDocument({ margin: 50 });
          const buffers = [];

                           doc.on('data', (chunk) => buffers.push(chunk));
          doc.on('end', () => resolve(Buffer.concat(buffers)));
          doc.on('error', reject);

                           // --- Header ---
                           doc.fontSize(20).font('Helvetica-Bold').text('ManualOS', { align: 'center' });
          doc.fontSize(14).font('Helvetica').text('AI-Generated Operator Manual', { align: 'center' });
          doc.moveDown(0.5);

                           if (brand) {
                                   doc.fontSize(12).text(`Brand / Manufacturer: ${brand}`, { align: 'center' });
                           }

                           doc.moveDown(0.5);

                           // --- Code Reference Scale ---
                           const barWidth = 400;
          const barHeight = 18;
          const barX = (doc.page.width - barWidth) / 2;
          const barY = doc.y;

                           // Label
                           doc.fontSize(11).font('Helvetica-Bold').text('Code Coverage Referenced in This Report:', barX, barY, { lineBreak: false });
          doc.moveDown(0.3);

                           const labelY = doc.y;

                           // Background bar (grey)
                           doc.rect(barX, labelY, barWidth, barHeight).fillAndStroke('#e0e0e0', '#aaaaaa');

                           // Filled bar (green gradient approximation)
                           const fillWidth = Math.round((codeRefPercentage / 100) * barWidth);
          if (fillWidth > 0) {
                  doc.rect(barX, labelY, fillWidth, barHeight).fillAndStroke('#2ecc71', '#27ae60');
          }

                           // Percentage text centered on bar
                           doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000')
            .text(`${codeRefPercentage}%`, barX, labelY + 4, { width: barWidth, align: 'center', lineBreak: false });

                           doc.moveDown(0.2);
          doc.y = labelY + barHeight + 8;

                           // Scale labels: 0% ... 50% ... 100%
                           doc.fontSize(8).font('Helvetica').fillColor('#555555')
            .text('0%', barX, doc.y, { lineBreak: false })
            .text('50%', barX + barWidth / 2 - 10, doc.y, { lineBreak: false })
            .text('100%', barX + barWidth - 22, doc.y);

                           doc.moveDown(1);
          doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke('#cccccc');
          doc.moveDown(1);

                           // --- Manual Content ---
                           doc.fontSize(11).font('Helvetica').fillColor('#000000');
          const lines = manualText.split('\n');
          for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('#')) {
                            // Markdown-style headings
                    const level = (trimmed.match(/^#+/) || [''])[0].length;
                            const headingText = trimmed.replace(/^#+\s*/, '');
                            const fontSize = level === 1 ? 16 : level === 2 ? 13 : 11;
                            doc.moveDown(0.5);
                            doc.fontSize(fontSize).font('Helvetica-Bold').text(headingText);
                            doc.font('Helvetica').fontSize(11);
                  } else if (trimmed === '') {
                            doc.moveDown(0.4);
                  } else {
                            doc.text(line);
                  }
          }

                           // Footer
                           doc.moveDown(2);
          doc.fontSize(8).fillColor('#888888').text(
                  `Generated by ManualOS | ${new Date().toLocaleDateString()}`,
            { align: 'center' }
                );

                           doc.end();
    });
}

// Generate manual via Claude - returns PDF
app.post('/generate-manual', async (req, res) => {
    try {
          const { plcContent, brand, sections } = req.body;
          if (!plcContent) return res.status(400).json({ error: 'plcContent is required' });

      const prompt = `You are an expert industrial automation engineer. Generate a comprehensive operator manual for the following PLC program.

      Brand/Manufacturer: ${brand || 'Unknown'}
      Sections requested: ${sections ? sections.join(', ') : 'All standard sections'}

      PLC Program Content:
      ${plcContent}

      Generate a professional, detailed operator manual with clear sections, safety warnings, and operational procedures.`;

      const message = await anthropic.messages.create({
              model: 'claude-opus-4-5',
              max_tokens: 4096,
              messages: [{ role: 'user', content: prompt }],
      });

      const manualText = message.content[0].text;

      // Calculate how much of the PLC code was referenced in the manual
      const codeRefPercentage = calculateCodeReferencePercentage(plcContent, manualText);

      // Generate PDF with code reference scale at the top
      const pdfBuffer = await generatePDF(manualText, brand, codeRefPercentage);

      res.set({
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="matrix-manual-report.pdf"',
              'Content-Length': pdfBuffer.length,
      });
          res.send(pdfBuffer);
    } catch (err) {
          console.error('Manual generation error:', err);
          res.status(500).json({ error: err.message });
    }
});

// Stripe Webhook
app.post('/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
          event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
          return res.status(400).send('Webhook signature verification failed');
    }

           switch (event.type) {
             case 'checkout.session.completed':
                     console.log('ManualOS - Payment completed:', event.data.object.customer_email);
                     break;
             case 'customer.subscription.created':
                     console.log('ManualOS - Subscription created:', event.data.object);
                     break;
             case 'customer.subscription.deleted':
                     console.log('ManualOS - Subscription cancelled:', event.data.object);
                     break;
             case 'invoice.payment_failed':
                     console.log('ManualOS - Payment failed:', event.data.object.customer_email);
                     break;
             default:
                     console.log('Unhandled event:', event.type);
           }

           res.json({ received: true });
});

app.listen(PORT, () => console.log('ManualOS backend running on port ' + PORT));
