/**
 * PuppeteerConfirmer.js
 * ===============================================================
 * Menggunakan Playwright (bukan Puppeteer) karena Playwright
 * menyertakan binary Chromium untuk ARM64 secara native.
 *
 * Login Netflix via magic link (tanpa password):
 *  1. Buka halaman login → masukkan email → klik "Kirim link"
 *  2. Tunggu magic link email dari Netflix (via IMAP)
 *  3. Buka magic link → sudah login
 *  4. Kunjungi URL konfirmasi → klik tombol konfirmasi
 *  5. Simpan session cookies → tutup browser
 * ===============================================================
 */

import { chromium } from 'playwright';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readFile, writeFile, access } from 'fs/promises';
import { constants } from 'fs';
import { createLogger } from '../logger.js';

const logger = createLogger('PuppeteerConfirmer');

const SESSION_FILE  = './netflix_session.json';
const NETFLIX_EMAIL = process.env.NETFLIX_EMAIL;

const GMAIL_CONFIG = {
  host: process.env.EMAIL_HOST || 'imap.gmail.com',
  port: parseInt(process.env.EMAIL_PORT || '993', 10),
  user: process.env.EMAIL_USER,
  pass: process.env.EMAIL_PASS,
};

const MAGIC_LINK_TIMEOUT_SEC = 60;

/**
 * Entry point utama: konfirmasi Netflix via browser headless.
 */
async function autoConfirmWithBrowser(confirmUrl) {
  if (!NETFLIX_EMAIL) {
    return { ok: false, message: 'NETFLIX_EMAIL belum diisi di .env!' };
  }

  logger.info('Membuka browser headless (Playwright)...');

  let browser = null;
  let context = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-zygote',
      ],
    });

    // Buat browser context dengan user agent mobile
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36',
      viewport: { width: 390, height: 844 },
    });

    // Load session cookies tersimpan
    await _loadSession(context);

    const page = await context.newPage();

    logger.info('Membuka URL konfirmasi...');
    await page.goto(confirmUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    const currentUrl = page.url();
    logger.info(`URL saat ini: ${currentUrl.slice(0, 80)}`);

    // Perlu login?
    if (_isLoginPage(currentUrl)) {
      logger.info('Session expired / belum login. Meminta magic link...');
      const loginOk = await _loginWithMagicLink(page, context);
      if (!loginOk) {
        return { ok: false, message: 'Login via magic link gagal.' };
      }

      logger.info('Login berhasil! Kembali ke URL konfirmasi...');
      await page.goto(confirmUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    }

    // Klik tombol konfirmasi
    const confirmed = await _clickConfirmButton(page);
    await _saveSession(context);

    if (confirmed) {
      logger.info('✅ Konfirmasi berhasil!');
      return { ok: true, message: 'Berhasil dikonfirmasi via browser headless' };
    }

    return { ok: false, message: 'Tombol konfirmasi tidak ditemukan. Cek debug_screenshot.png' };

  } catch (err) {
    logger.error(`Browser error: ${err.message}`);
    return { ok: false, message: err.message };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      logger.info('Browser ditutup, RAM dibebaskan.');
    }
  }
}

// ---- Login via Magic Link ----

async function _loginWithMagicLink(page, context) {
  try {
    await page.goto('https://www.netflix.com/login', {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });

    // Isi email
    await page.waitForSelector('input[name="userLoginId"], input[type="email"]', { timeout: 10_000 });
    await page.fill('input[name="userLoginId"], input[type="email"]', NETFLIX_EMAIL);

    // Klik Continue
    await page.click('[data-uia="login-submit-button"], button[type="submit"]').catch(() => {});
    await _sleep(2000);

    // Cari dan klik tombol "Kirim link ke email"
    const magicLinkTexts = [
      'kirim link',
      'email me a link',
      'sign in with email',
      'masuk dengan email',
      'use a sign-in link',
      'send me a link',
      'send a link',
    ];

    let clicked = false;
    for (const text of magicLinkTexts) {
      try {
        // Playwright punya getByText yang lebih reliable
        const el = page.getByText(new RegExp(text, 'i')).first();
        const count = await el.count();
        if (count > 0) {
          await el.click();
          clicked = true;
          logger.info(`Tombol magic link diklik: "${text}"`);
          break;
        }
      } catch { /* coba teks berikutnya */ }
    }

    if (!clicked) {
      logger.warn('Tombol "Kirim link" tidak ditemukan. Screenshot: debug_login.png');
      await page.screenshot({ path: './debug_login.png' }).catch(() => {});
      return false;
    }

    logger.info(`Menunggu magic link email dari Netflix (max ${MAGIC_LINK_TIMEOUT_SEC}s)...`);

    const magicLink = await _waitForMagicLinkEmail(MAGIC_LINK_TIMEOUT_SEC);
    if (!magicLink) {
      logger.error('Magic link tidak diterima dalam batas waktu.');
      return false;
    }

    logger.info(`Magic link diterima! Membuka...`);
    await page.goto(magicLink, { waitUntil: 'networkidle', timeout: 30_000 });
    await _sleep(2000);

    if (_isLoginPage(page.url())) {
      logger.error('Masih di halaman login setelah magic link.');
      return false;
    }

    logger.info(`Login berhasil!`);
    return true;

  } catch (err) {
    logger.error(`_loginWithMagicLink error: ${err.message}`);
    return false;
  }
}

// ---- Klik Tombol Konfirmasi ----

async function _clickConfirmButton(page) {
  const buttonTexts = [
    'Konfirmasi Pembaruan',
    'Confirm Update',
    'Ya, Itu Saya',
    'Yes, This Was Me',
    'Update Location',
    'Perbarui',
  ];

  const selectors = [
    '[data-uia="confirm-household-btn"]',
    '[data-uia="update-btn"]',
    'button[data-uia*="confirm"]',
    'button[data-uia*="update"]',
  ];

  // Coba via selector data-uia
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3_000 });
      await page.click(selector);
      logger.info(`Tombol diklik: ${selector}`);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      return true;
    } catch { /* coba berikutnya */ }
  }

  // Coba via teks
  for (const text of buttonTexts) {
    try {
      const el = page.getByText(new RegExp(`^${text}$`, 'i')).first();
      if (await el.count() > 0) {
        await el.click();
        logger.info(`Tombol diklik via teks: "${text}"`);
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        return true;
      }
    } catch { /* lanjut */ }
  }

  await page.screenshot({ path: './debug_screenshot.png' }).catch(() => {});
  logger.warn('Screenshot disimpan ke debug_screenshot.png');
  return false;
}

// ---- Tunggu Magic Link Email via IMAP ----

async function _waitForMagicLinkEmail(timeoutSec) {
  const endTime = Date.now() + timeoutSec * 1000;
  const since = new Date(Date.now() - 30_000);

  logger.info('Menghubungkan ke Gmail untuk menunggu magic link...');

  const client = new ImapFlow({
    host: GMAIL_CONFIG.host,
    port: GMAIL_CONFIG.port,
    secure: true,
    auth: { user: GMAIL_CONFIG.user, pass: GMAIL_CONFIG.pass },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    while (Date.now() < endTime) {
      const remaining = Math.round((endTime - Date.now()) / 1000);
      logger.info(`Mencari magic link email... (${remaining}s tersisa)`);

      const uids = await client.search({ since, from: '@netflix.com' });

      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg) continue;

        const parsed = await simpleParser(msg.source, {
          skipTextToHtml: true,
          skipImageLinks: true,
        });

        const subject = (parsed.subject || '').toLowerCase();
        const isLoginEmail =
          subject.includes('sign in') || subject.includes('masuk') ||
          subject.includes('login') || subject.includes('link') ||
          subject.includes('verify');

        if (!isLoginEmail) continue;

        const magicUrl = _extractMagicLinkUrl(parsed);
        if (magicUrl) {
          await client.logout();
          return magicUrl;
        }
      }

      await _sleep(5000);
    }

    await client.logout();
    return null;
  } catch (err) {
    logger.error(`IMAP magic link error: ${err.message}`);
    try { await client.logout(); } catch { /* ignore */ }
    return null;
  }
}

function _extractMagicLinkUrl(parsedMail) {
  const patterns = [
    /https:\/\/[^\s"<>]+netflix\.com[^\s"<>]+token[^\s"<>]+/gi,
    /https:\/\/[^\s"<>]+netflix\.com\/login[^\s"<>]+/gi,
    /https:\/\/[^\s"<>]+netflix\.com[^\s"<>]+magicLink[^\s"<>]+/gi,
    /https:\/\/[^\s"<>]+netflix\.com[^\s"<>]+sign-?in[^\s"<>]+/gi,
  ];

  const text = parsedMail.text || '';
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.length) return m[0].replace(/[.,;)\]'"]+$/, '');
  }

  const html = parsedMail.html || '';
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.length) return m[0].replace(/[.,;)\]'">&]+$/, '');
  }
  return null;
}

// ---- Session (Cookies) ----

async function _loadSession(context) {
  try {
    await access(SESSION_FILE, constants.F_OK);
    const cookies = JSON.parse(await readFile(SESSION_FILE, 'utf-8'));
    if (cookies.length > 0) {
      await context.addCookies(cookies);
      logger.info(`Session dimuat (${cookies.length} cookies).`);
    }
  } catch {
    logger.info('Tidak ada session tersimpan, akan login baru.');
  }
}

async function _saveSession(context) {
  try {
    const cookies = (await context.cookies()).filter(c => c.domain.includes('netflix.com'));
    await writeFile(SESSION_FILE, JSON.stringify(cookies, null, 2), 'utf-8');
    logger.info(`Session disimpan (${cookies.length} cookies).`);
  } catch (err) {
    logger.warn(`Gagal simpan session: ${err.message}`);
  }
}

function _isLoginPage(url) {
  return url.includes('/login') || url.includes('/LoginHelp') || url.includes('signup');
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export { autoConfirmWithBrowser };
