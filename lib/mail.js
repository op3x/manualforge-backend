const nodemailer = require('nodemailer');

const DEFAULT_FROM = 'support@manualos.com';

function smtpPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 587;
  return port;
}

function createSmtpMailer(env) {
  const host = String(env.SMTP_HOST || '').trim();
  if (!host) return null;
  const from = String(env.SMTP_FROM || '').trim() || DEFAULT_FROM;
  const port = smtpPort(env.SMTP_PORT);
  const user = String(env.SMTP_USER || '').trim();
  const pass = env.SMTP_PASS == null ? '' : String(env.SMTP_PASS);
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
  return {
    async sendMail({ to, subject, text, html, from: fromOverride }) {
      await transport.sendMail({
        from: fromOverride || from,
        to,
        subject: String(subject || '').slice(0, 200),
        text: String(text || '').slice(0, 4000),
        html: html ? String(html).slice(0, 8000) : undefined,
      });
    },
  };
}

module.exports = { createSmtpMailer, DEFAULT_FROM, smtpPort };
