const nodemailer = require('nodemailer');

function createSmtpMailer(env) {
  const host = String(env.SMTP_HOST || '').trim();
  const from = String(env.SMTP_FROM || '').trim();
  if (!host || !from) return null;
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
    async sendMail({ to, subject, text }) {
      await transport.sendMail({
        from,
        to,
        subject: String(subject || '').slice(0, 200),
        text: String(text || '').slice(0, 2000),
      });
    },
  };
}

function smtpPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 587;
  return port;
}

module.exports = { createSmtpMailer };
