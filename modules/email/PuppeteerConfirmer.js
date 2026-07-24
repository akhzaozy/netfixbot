/**
 * PuppeteerConfirmer.js
 * ===============================================================
 * Modul konfirmasi Netflix menggunakan Puppeteer (browser headless).
 *
 * Alur kerja:
 *  1. Buka browser headless (tidak terlihat)
 *  2. Load cookies sesi Netflix jika ada (dari netflix_session.json)
 *  3. Kunjungi URL konfirmasi dari email
 *  4. Jika belum login → login otomatis dengan kredensial dari .env
 *  5. Klik tombol "Konfirmasi Pembaruan"
 *  6. Simpan cookies untuk dipakai lagi besok
 *  7. Tutup browser → RAM dibebaskan
 *
 * Kredensial Netflix disimpan di .env:
 *   NETFLIX_EMAIL=email@gmail.com
 *   NETFLIX_PASSWORD=passwordnetflix
 * ===============================================================
 */

import puppeteer from 'puppeteer-core';
import { readFile, writeFile, access } from 'fs/promises';
import { constants } from 'fs';
import { createLogger } from '../logger.js';

const logger = createLogger('PuppeteerConfirmer');

const SESSION_FILE = './netflix_session.json';
const NETFLIX_EMAIL    = process.env.NETFLIX_EMAIL;
const NETFLIX_PASSWORD = process.env.NETFLIX_PASSWORD;

// Chromium path — akan dicari otomatis di berbagai lokasi umum Ubuntu/Linux
const CHROMIUM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

/**
 * Konfirmasi otomatis Netflix dengan browser headless.
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
      message: 'Chromium tidak ditemukan. Jalankan: apt-get install -y chromium-browser',
    };
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: [
        '--no-sandbox',           // Wajib di server/Docker
        '--disable-setuid-sandbox',
        '--disable-gpu',          // Hemat resource di server tanpa GPU
        '--disable-dev-shm-usage',// Hindari crash di RAM kecil
        '--no-first-run',
        '--no-zygote',
      ],
    });

    const page = await browser.newPage();

    // Set viewport & user agent seperti mobile biasa
    await page.setViewport({ width: 390, height: 844 });
    await page.setUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36'
    );

    // Load session cookies yang tersimpan (jika ada)
    await _loadSession(page);

    logger.info('Membuka URL konfirmasi...');
    await page.goto(confirmUrl, { waitUntil: 'networkidle2', timeout: 30_000 });

    const currentUrl = page.url();
    logger.info(`Halaman saat ini: ${currentUrl.slice(0, 80)}`);

    // Cek apakah perlu login
    if (_isLoginPage(currentUrl)) {
      logger.info('Perlu login Netflix terlebih dahulu...');
      const loginOk = await _doLogin(page);
      if (!loginOk) {
        return { ok: false, message: 'Login Netflix gagal. Cek NETFLIX_EMAIL dan NETFLIX_PASSWORD di .env' };
      }

      // Setelah login, kunjungi kembali URL konfirmasi
      logger.info('Login berhasil! Kembali ke halaman konfirmasi...');
      await page.goto(confirmUrl, { waitUntil: 'networkidle2', timeout: 30_000 });
    }

    // Klik tombol konfirmasi
    const confirmed = await _clickConfirmButton(page);

    // Simpan session cookies untuk dipakai berikutnya
    await _saveSession(page);

    if (confirmed) {
      logger.info('✅ Konfirmasi berhasil!');
      return { ok: true, message: 'Konfirmasi berhasil via browser headless' };
    } else {
      return { ok: false, message: 'Tombol konfirmasi tidak ditemukan di halaman' };
    }

  } catch (err) {
    logger.error(`Browser error: ${err.message}`);
    return { ok: false, message: err.message };
  } finally {
    // SELALU tutup browser agar RAM dibebaskan
    if (browser) {
      await browser.close().catch(() => {});
      logger.info('Browser ditutup.');
    }
  }
}

// ---- Private Helpers ----

/**
 * Mencari path Chromium yang terinstall di sistem.
 */
async function _findChromium() {
  for (const path of CHROMIUM_PATHS) {
    try {
      await access(path, constants.F_OK);
      logger.info(`Chromium ditemukan: ${path}`);
      return path;
    } catch {
      // Tidak ada di path ini, coba berikutnya
    }
  }
  logger.error('Chromium tidak ditemukan di path manapun!');
  return null;
}

/**
 * Load session cookies Netflix dari file lokal.
 * Ini memungkinkan bot tidak perlu login ulang setiap kali.
 */
async function _loadSession(page) {
  try {
    await access(SESSION_FILE, constants.F_OK);
    const raw = await readFile(SESSION_FILE, 'utf-8');
    const cookies = JSON.parse(raw);
    await page.setCookie(...cookies);
    logger.info(`Session dimuat (${cookies.length} cookies).`);
  } catch {
    logger.info('Tidak ada session tersimpan, akan login baru.');
  }
}

/**
 * Simpan session cookies Netflix ke file lokal untuk dipakai berikutnya.
 */
async function _saveSession(page) {
  try {
    const cookies = await page.cookies();
    // Hanya simpan cookies dari netflix.com
    const netflixCookies = cookies.filter(c => c.domain.includes('netflix.com'));
    await writeFile(SESSION_FILE, JSON.stringify(netflixCookies, null, 2), 'utf-8');
    logger.info(`Session disimpan (${netflixCookies.length} cookies).`);
  } catch (err) {
    logger.warn(`Gagal simpan session: ${err.message}`);
  }
}

/**
 * Melakukan login Netflix dengan kredensial dari .env.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>}
 */
async function _doLogin(page) {
  if (!NETFLIX_EMAIL || !NETFLIX_PASSWORD) {
    logger.error('NETFLIX_EMAIL atau NETFLIX_PASSWORD belum diisi di .env!');
    return false;
  }

  try {
    await page.goto('https://www.netflix.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30_000,
    });

    // Isi email
    await page.waitForSelector('input[name="userLoginId"], input[type="email"]', { timeout: 10_000 });
    await page.type('input[name="userLoginId"], input[type="email"]', NETFLIX_EMAIL, { delay: 50 });

    // Isi password
    await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 5_000 });
    await page.type('input[name="password"], input[type="password"]', NETFLIX_PASSWORD, { delay: 50 });

    // Klik Sign In
    await page.click('[data-uia="login-submit-button"], button[type="submit"]');

    // Tunggu navigasi selesai
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20_000 });

    const afterUrl = page.url();
    if (_isLoginPage(afterUrl)) {
      logger.error('Login gagal — masih di halaman login setelah submit.');
      return false;
    }

    logger.info('Login Netflix berhasil!');
    return true;
  } catch (err) {
    logger.error(`Login error: ${err.message}`);
    return false;
  }
}

/**
 * Mencari dan mengklik tombol konfirmasi di halaman Netflix.
 * Mencoba berbagai selector yang mungkin digunakan Netflix.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<boolean>}
 */
async function _clickConfirmButton(page) {
  // Daftar selector tombol konfirmasi Netflix (bisa berubah sewaktu-waktu)
  const selectors = [
    '[data-uia="confirm-household-btn"]',
    '[data-uia="update-btn"]',
    'button[data-uia*="confirm"]',
    'button[data-uia*="update"]',
  ];

  // Juga cari berdasarkan teks tombol
  const buttonTexts = [
    'Konfirmasi Pembaruan',
    'Confirm Update',
    'Ya, Itu Saya',
    'Yes, This Was Me',
    'Update Location',
    'Perbarui',
  ];

  // Coba selector data-uia dulu (lebih reliable)
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3_000 });
      await page.click(selector);
      logger.info(`Tombol diklik via selector: ${selector}`);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => {});
      return true;
    } catch {
      // Selector tidak ditemukan, coba berikutnya
    }
  }

  // Cari berdasarkan teks tombol
  for (const text of buttonTexts) {
    try {
      const clicked = await page.evaluate((btnText) => {
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const target = buttons.find(b =>
          b.textContent?.trim().toLowerCase().includes(btnText.toLowerCase())
        );
        if (target) {
          target.click();
          return true;
        }
        return false;
      }, text);

      if (clicked) {
        logger.info(`Tombol diklik via teks: "${text}"`);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15_000 }).catch(() => {});
        return true;
      }
    } catch {
      // Lanjut
    }
  }

  // Screenshot untuk debug jika gagal (simpan ke disk)
  try {
    await page.screenshot({ path: './debug_screenshot.png' });
    logger.warn('Screenshot disimpan ke debug_screenshot.png untuk inspeksi manual.');
  } catch { /* ignore */ }

  return false;
}

/**
 * Mengecek apakah URL saat ini adalah halaman login Netflix.
 */
function _isLoginPage(url) {
  return url.includes('/login') || url.includes('/LoginHelp') || url.includes('signup');
}

export { autoConfirmWithBrowser };
