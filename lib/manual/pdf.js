const { execFileSync } = require('child_process');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { exposed } = require('../errors');

function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (found) return found;
    } catch {
      // try the next name
    }
  }
  return '';
}

let browserPromise;

async function launchBrowser() {
  const executablePath = findChrome();
  if (!executablePath) {
    throw exposed(503, 'PDF rendering is temporarily unavailable.', 'Chromium was not found. Set PUPPETEER_EXECUTABLE_PATH or install chromium.');
  }
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

async function renderPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdf);
  } catch (err) {
    if (err && err.expose) throw err;
    throw exposed(503, 'PDF rendering is temporarily unavailable.', 'PDF rendering failed');
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { renderPdf, findChrome };
