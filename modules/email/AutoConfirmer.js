/**
 * AutoConfirmer.js
 * ===============================================================
 * Modul untuk mengkonfirmasi otomatis link Netflix dengan
 * melakukan HTTP GET request ke URL konfirmasi.
 *
 * Menggunakan built-in fetch dari Node.js 20+ (tanpa dependency tambahan).
 *
 * KEAMANAN:
 *  - Hanya memproses URL dari domain netflix.com
 *  - Tidak menyimpan cookie atau session
 *  - Timeout 30 detik agar tidak hang selamanya
 * ===============================================================
 */

import { createLogger } from '../logger.js';

const logger = createLogger('AutoConfirmer');

// Hanya izinkan URL dari domain Netflix yang sah
const ALLOWED_DOMAINS = ['netflix.com', 'www.netflix.com', 'account.netflix.com'];

/**
 * Mengkonfirmasi otomatis link Netflix dengan melakukan HTTP GET.
 *
 * @param {string} url - URL konfirmasi dari email Netflix
 * @returns {Promise<{ ok: boolean, status: number, finalUrl: string, message: string }>}
 */
async function autoConfirm(url) {
  // Validasi URL sebelum dikunjungi
  _validateUrl(url);

  logger.info(`Mengkonfirmasi otomatis: ${url.slice(0, 80)}...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        // Pura-pura sebagai browser mobile biasa agar Netflix tidak menolak request
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow', // Ikuti redirect otomatis
      signal: controller.signal,
    });

    const finalUrl = response.url;
    const status = response.status;

    // Cek apakah konfirmasi kemungkinan berhasil
    // Netflix biasanya redirect ke halaman browse/home setelah konfirmasi sukses
    const isSuccess =
      response.ok ||
      finalUrl.includes('/browse') ||
      finalUrl.includes('/YourAccount') ||
      finalUrl.includes('/changehousehold') ||
      status === 200 ||
      status === 302;

    if (isSuccess) {
      logger.info(`✅ Konfirmasi berhasil! Status: ${status} | Final URL: ${finalUrl.slice(0, 80)}`);
    } else {
      logger.warn(`⚠️ Status tidak terduga: ${status} | URL: ${finalUrl.slice(0, 80)}`);
    }

    return {
      ok: isSuccess,
      status,
      finalUrl,
      message: isSuccess
        ? `Konfirmasi terkirim (HTTP ${status})`
        : `Response tidak terduga (HTTP ${status})`,
    };

  } catch (err) {
    if (err.name === 'AbortError') {
      logger.error('Konfirmasi timeout (>30 detik) - Netflix tidak merespons');
      return { ok: false, status: 0, finalUrl: url, message: 'Timeout' };
    }
    logger.error(`Gagal konfirmasi: ${err.message}`);
    return { ok: false, status: 0, finalUrl: url, message: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Memvalidasi URL sebelum dikunjungi.
 * Hanya izinkan URL HTTPS dari domain Netflix yang diketahui.
 * @param {string} url
 */
function _validateUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('URL konfirmasi tidak valid atau kosong');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL tidak dapat di-parse: ${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`URL harus HTTPS, bukan ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isNetflix = ALLOWED_DOMAINS.some(
    (d) => hostname === d || hostname.endsWith(`.${d}`)
  );

  if (!isNetflix) {
    throw new Error(`URL bukan dari domain Netflix: ${hostname}`);
  }
}

export { autoConfirm };
