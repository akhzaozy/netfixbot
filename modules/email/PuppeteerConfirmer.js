/**
 * PuppeteerConfirmer.js
 * ===============================================================
 * Modul konfirmasi Netflix menggunakan Puppeteer (browser headless).
 *
 * Login menggunakan MAGIC LINK (bukan password):
 *  1. Puppeteer buka halaman login Netflix → masukkan email saja
 *  2. Klik "Kirim link masuk ke email"
 *  3. Netflix kirim email berisi magic link ke Gmail
 *  4. Bot baca Gmail via IMAP → ambil magic link
 *  5. Puppeteer kunjungi magic link → sudah login!
 *  6. Kunjungi URL konfirmasi → klik "Konfirmasi Pembaruan"
 *  7. Simpan session cookies → tutup browser
 *
 * .env yang dibutuhkan:
 *   NETFLIX_EMAIL=emailnetflix@gmail.com   ← email akun Netflix
 *   EMAIL_USER=...                          ← harus sama / bisa beda (Gmail yang dikirim magic link)
 * ===============================================================
 */

import puppeteer from 'puppeteer-core';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readFile, writeFile, access } from 'fs/promises';
import { constants } from 'fs';
import { createLogger } from '../logger.js';

const logger = createLogger('PuppeteerConfirmer');

const SESSION_FILE     = './netflix_session.json';
const NETFLIX_EMAIL    = process.env.NETFLIX_EMAIL;

// Gmail config (sama dengan email watcher utama)
const GMAIL_CONFIG = {
  host: process.env.EMAIL_HOST || 'imap.gmail.com',
  port: parseInt(process.env.EMAIL_PORT || '993', 10),
  user: process.env.EMAIL_USER,
  pass: process.env.EMAIL_PASS,
};

// Path Chromium di Linux/Ubuntu
const CHROMIUM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

// Timeout menunggu magic link email dari Netflix (detik)
const MAGIC_LINK_TIMEOUT_SEC = 60;

/**
 * Auto-konfirmasi Netflix dengan browser headless.
 * Login menggunakan magic link (no password).
 *
 * @param {string} confirmUrl - URL konfirmasi dari email Netflix
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function autoConfirmWithBrowser(confirmUrl) {
  logger.info('Membuka browser headless...');

  const executablePath = await _findChromium();
  if (!executablePath) {
    return {
      ok: false,
      message: 'Chromium tidak ditemukan. Install dengan: apt-get install -y chromium-browser',
    };
  }

  if (!NETFLIX_EMAIL) {
    return { ok: false, message: 'NETFLIX_EMAIL belum diisi di .env!' };
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36'
    );

    // Coba load session cookies tersimpan dulu
    await _loadSession(page);

    // Buka URL konfirmasi
    logger.info('Membuka URL konfirmasi...');
    await page.goto(confirmUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Jika perlu login
    if (_isLoginPage(page.url())) {
      logger.info('Session expired / belum login. Meminta magic link...');

      const loginOk = await _loginWithMagicLink(page, browser);
      if (!loginOk) {
        return { ok: false, message: 'Login via magic link gagal.' };
      }

      // Setelah login, kunjungi kembali URL konfirmasi
      logger.info('Login berhasil! Membuka URL konfirmasi...');
      await page.goto(confirmUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
    }

    // Klik tombol konfirmasi
    const confirmed = await _clickConfirmButton(page);
    await _saveSession(page);

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

/**
 * Login Netflix tanpa password menggunakan magic link yang dikirim ke email.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').Browser} browser
 * @returns {Promise<boolean>}
 */
async function _loginWithMagicLink(page, browser) {
  try {
    // Buka halaman login Netflix
    await page.goto('https://www.netflix.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30_000,
    });

    // Isi email
    await page.waitForSelector('input[name="userLoginId"], input[type="email"]', { timeout: 10_000 });
    await page.type('input[name="userLoginId"], input[type="email"]', NETFLIX_EMAIL, { delay: 40 });

    // Klik "Lanjutkan" atau "Continue"
    await page.click('[data-uia="login-submit-button"], button[type="submit"]').catch(() => {});
    await _sleep(2000);

    // Cari opsi "Kirim link ke email" / "Email me a link" / "Sign in with email"
    const magicLinkClicked = await page.evaluate(() => {
      const patterns = [
        'kirim link',
        'email me a link',
        'sign in with email',
        'masuk dengan email',
        'use a sign-in link',
        'send me a link',
      ];
      const allEls = Array.from(document.querySelectorAll('a, button, span, div'));
      for (const el of allEls) {
        const txt = el.textContent?.toLowerCase().trim() || '';
        if (patterns.some(p => txt.includes(p))) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (!magicLinkClicked) {
      logger.warn('Tombol "Kirim link" tidak ditemukan. Screenshot: debug_login.png');
      await page.screenshot({ path: './debug_login.png' }).catch(() => {});
      return false;
    }

    logger.info(`Magic link diminta → Menunggu email dari Netflix (max ${MAGIC_LINK_TIMEOUT_SEC}s)...`);

    // Tunggu magic link datang ke Gmail via IMAP
    const magicLink = await _waitForMagicLinkEmail(MAGIC_LINK_TIMEOUT_SEC);

    if (!magicLink) {
      logger.error('Magic link tidak diterima dalam batas waktu.');
      return false;
    }

    logger.info(`Magic link diterima! Membuka: ${magicLink.slice(0, 80)}...`);

    // Buka magic link di browser yang sama
    await page.goto(magicLink, { waitUntil: 'networkidle2', timeout: 30_000 });
    await _sleep(2000);

    // Pastikan sudah login
    if (_isLoginPage(page.url())) {
      logger.error('Setelah magic link, masih di halaman login.');
      return false;
    }

    logger.info(`Login berhasil! URL: ${page.url().slice(0, 80)}`);
    return true;

  } catch (err) {
    logger.error(`_loginWithMagicLink error: ${err.message}`);
    return false;
  }
}

/**
 * Tunggu email magic link dari Netflix masuk ke Gmail.
 * Membuat koneksi IMAP terpisah (one-shot), lakukan polling setiap 5 detik.
 *
 * @param {number} timeoutSec - Batas waktu tunggu dalam detik
 * @returns {Promise<string|null>} URL magic link atau null jika timeout
 */
async function _waitForMagicLinkEmail(timeoutSec) {
  const startTime = Date.now();
  const endTime = startTime + timeoutSec * 1000;

  // Catat waktu sebelum request magic link agar hanya ambil email baru
  const since = new Date(Date.now() - 30_000); // 30 detik lalu

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

      // Cari email Netflix yang baru masuk
      const uids = await client.search({
        since,
        from: '@netflix.com',
      });

      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg) continue;

        const parsed = await simpleParser(msg.source, {
          skipTextToHtml: true,
          skipImageLinks: true,
        });

        const subject = (parsed.subject || '').toLowerCase();
        // Hanya proses email yang bertema login/sign-in
        const isLoginEmail =
          subject.includes('sign in') ||
          subject.includes('masuk') ||
          subject.includes('login') ||
          subject.includes('link') ||
          subject.includes('verify');

        if (!isLoginEmail) continue;

        // Cari URL magic link dari email
        const magicUrl = _extractMagicLinkUrl(parsed);
        if (magicUrl) {
          await client.logout();
          return magicUrl;
        }
      }

      // Tunggu 5 detik sebelum cek ulang
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

/**
 * Ekstrak URL magic link dari email Netflix.
 * Magic link biasanya berupa URL panjang dengan token.
 */
function _extractMagicLinkUrl(parsedMail) {
  // Pola URL magic link Netflix
  const patterns = [
    /https:\/\/[^\s"<>]+netflix\.com[^\s"<>]+token[^\s"<>]+/gi,
    /https:\/\/[^\s"<>]+netflix\.com\/login[^\s"<>]+/gi,
    /https:\/\/[^\s"<>]+netflix\.com[^\s"<>]+magicLink[^\s"<>]+/gi,
    /https:\/\/[^\s"<>]+netflix\.com[^\s"<>]+sign-?in[^\s"<>]+/gi,
  ];

  // Cari di text plain
  const text = parsedMail.text || '';
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches?.length) return matches[0].replace(/[.,;)\]'"]+$/, '');
  }

  // Cari di HTML
  const html = parsedMail.html || '';
  for (const pattern of patterns) {
    const matches = html.match(pattern);
    if (matches?.length) return matches[0].replace(/[.,;)\]'">&]+$/, '');
  }

  return null;
}

// ---- Klik Tombol Konfirmasi ----

async function _clickConfirmButton(page) {
  const selectors = [
    '[data-uia="confirm-household-btn"]',
    '[data-uia="update-btn"]',
    'button[data-uia*="confirm"]',
    'button[data-uia*="update"]',
  ];

  const buttonTexts = [
    'Konfirmasi Pembaruan',
    'Confirm Update',
    'Ya, Itu Saya',
    'Yes, This Was Me',
    'Update Location',
    'Perbarui',
  ];

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3_000 });
      await page.click(selector);
      logger.info(`Tombol diklik: ${selector}`);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => {});
      return true;
    } catch { /* coba berikutnya */ }
  }

  for (const text of buttonTexts) {
    try {
      const clicked = await page.evaluate((t) => {
        const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const el = els.find(e => e.textContent?.trim().toLowerCase().includes(t.toLowerCase()));
        if (el) { el.click(); return true; }
        return false;
      }, text);

      if (clicked) {
        logger.info(`Tombol diklik via teks: "${text}"`);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => {});
        return true;
      }
    } catch { /* lanjut */ }
  }

  await page.screenshot({ path: './debug_screenshot.png' }).catch(() => {});
  logger.warn('Screenshot disimpan ke debug_screenshot.png');
  return false;
}

// ---- Session & Utilities ----

async function _loadSession(page) {
  try {
    await access(SESSION_FILE, constants.F_OK);
    const cookies = JSON.parse(await readFile(SESSION_FILE, 'utf-8'));
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      logger.info(`Session dimuat (${cookies.length} cookies).`);
    }
  } catch {
    logger.info('Tidak ada session tersimpan, akan login baru.');
  }
}

async function _saveSession(page) {
  try {
    const cookies = (await page.cookies()).filter(c => c.domain.includes('netflix.com'));
    await writeFile(SESSION_FILE, JSON.stringify(cookies, null, 2), 'utf-8');
    logger.info(`Session disimpan (${cookies.length} cookies).`);
  } catch (err) {
    logger.warn(`Gagal simpan session: ${err.message}`);
  }
}

async function _findChromium() {
  for (const p of CHROMIUM_PATHS) {
    try { await access(p, constants.F_OK); return p; } catch { /* skip */ }
  }
  logger.error('Chromium tidak ditemukan!');
  return null;
}

function _isLoginPage(url) {
  return url.includes('/login') || url.includes('/LoginHelp') || url.includes('signup');
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { autoConfirmWithBrowser };
