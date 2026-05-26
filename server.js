require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Stripe webhook needs raw body
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'manualforge-backend' }));

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

// Generate manual via Claude
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

    res.json({ manual: message.content[0].text });
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
      console.log('Payment completed:', event.data.object.customer_email);
      break;
    case 'customer.subscription.created':
      console.log('Subscription created:', event.data.object.id);
      break;
    case 'customer.subscription.deleted':
      console.log('Subscription cancelled:', event.data.object.id);
      break;
    case 'invoice.payment_failed':
      console.log('Payment failed:', event.data.object.customer_email);
      break;
    default:
      console.log('Unhandled event:', event.type);
  }

  res.json({ received: true });
});

app.listen(PORT, () => console.log('ManualForge backend running on port ' + PORT));
