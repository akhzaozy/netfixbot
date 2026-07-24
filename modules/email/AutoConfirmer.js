/**
 * AutoConfirmer.js
 * ===============================================================
 * Modul untuk mengkonfirmasi otomatis permintaan Update Rumah Netflix.
 *
 * Netflix menggunakan konfirmasi DUA LANGKAH:
 *  Langkah 1: Kunjungi link dari email → mendapat halaman konfirmasi
 *  Langkah 2: Submit form "Konfirmasi Pembaruan" di halaman tersebut
 *
 * Modul ini menangani kedua langkah secara otomatis.
 *
 * Menggunakan built-in fetch dari Node.js 20+ (tanpa dependency tambahan).
 * ===============================================================
 */

import { JSDOM } from 'jsdom';
import { createLogger } from '../logger.js';

const logger = createLogger('AutoConfirmer');

// Hanya izinkan URL dari domain Netflix yang sah
const ALLOWED_DOMAINS = ['netflix.com', 'www.netflix.com', 'account.netflix.com'];

// Header browser agar Netflix tidak menolak request
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Auto-konfirmasi link Netflix dengan menangani alur dua langkah:
 *  1. GET link dari email → dapatkan halaman konfirmasi
 *  2. Parse halaman → temukan form/action → POST untuk konfirmasi final
 *
 * @param {string} url - URL konfirmasi dari email Netflix
 * @returns {Promise<{ ok: boolean, step: number, message: string }>}
 */
async function autoConfirm(url) {
  _validateUrl(url);
  logger.info(`Memulai auto-konfirmasi...`);
  logger.info(`URL: ${url.slice(0, 100)}...`);

  // ---- LANGKAH 1: Kunjungi link dari email ----
  const step1 = await _fetchPage(url);
  if (!step1.ok) {
    return { ok: false, step: 1, message: `Langkah 1 gagal: ${step1.message}` };
  }

  logger.info(`Langkah 1 OK (HTTP ${step1.status}) → ${step1.finalUrl.slice(0, 80)}`);

  // Jika langsung redirect ke halaman sukses, selesai
  if (_isSuccessUrl(step1.finalUrl)) {
    logger.info('✅ Konfirmasi selesai di langkah 1 (redirect langsung)!');
    return { ok: true, step: 1, message: `Berhasil (redirect langsung ke ${step1.finalUrl})` };
  }

  // ---- LANGKAH 2: Parse halaman dan submit form konfirmasi ----
  logger.info('Halaman konfirmasi ditemukan, mencari tombol "Konfirmasi Pembaruan"...');

  const confirmAction = _extractConfirmAction(step1.html, step1.finalUrl);

  if (!confirmAction) {
    // Jika tidak bisa parse form, coba endpoint standar Netflix
    logger.warn('Tidak bisa menemukan form di halaman. Mencoba endpoint fallback...');
    const fallbackResult = await _tryFallbackConfirm(step1.finalUrl, step1.cookies);
    return fallbackResult;
  }

  logger.info(`Form ditemukan → ${confirmAction.method.toUpperCase()} ${confirmAction.action.slice(0, 80)}`);

  // Submit form konfirmasi
  const step2 = await _submitForm(confirmAction, step1.cookies);
  if (step2.ok) {
    logger.info(`✅ Konfirmasi BERHASIL! (HTTP ${step2.status})`);
    return { ok: true, step: 2, message: `Berhasil setelah submit form (HTTP ${step2.status})` };
  }

  logger.error(`❌ Langkah 2 gagal: ${step2.message}`);
  return { ok: false, step: 2, message: step2.message };
}

// ---- Private Helpers ----

/**
 * Melakukan HTTP GET ke URL dan mengembalikan HTML + cookies.
 */
async function _fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    const html = await response.text();

    // Ambil cookies dari Set-Cookie header untuk digunakan di langkah 2
    const cookies = response.headers.get('set-cookie') || '';

    return {
      ok: true,
      status: response.status,
      finalUrl: response.url,
      html,
      cookies,
      message: `HTTP ${response.status}`,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 0, html: '', cookies: '', finalUrl: url, message: 'Timeout 30s' };
    }
    return { ok: false, status: 0, html: '', cookies: '', finalUrl: url, message: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Mengekstrak action URL dan data form dari HTML halaman konfirmasi Netflix.
 * Mencari elemen <form> atau tombol dengan teks konfirmasi.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @returns {{ method: string, action: string, fields: object }|null}
 */
function _extractConfirmAction(html, baseUrl) {
  if (!html) return null;

  let dom;
  try {
    dom = new JSDOM(html, { url: baseUrl });
  } catch {
    return null;
  }

  const document = dom.window.document;

  // Cari form yang mengandung tombol konfirmasi
  const forms = Array.from(document.querySelectorAll('form'));

  for (const form of forms) {
    const formText = form.textContent?.toLowerCase() || '';
    const isConfirmForm =
      formText.includes('konfirmasi') ||
      formText.includes('confirm') ||
      formText.includes('perbarui') ||
      formText.includes('update');

    if (!isConfirmForm) continue;

    const action = form.action || baseUrl;
    const method = form.method?.toLowerCase() || 'post';

    // Ambil semua field tersembunyi (token CSRF, dll)
    const fields = {};
    for (const input of form.querySelectorAll('input')) {
      const name = input.name;
      const value = input.value;
      if (name) fields[name] = value;
    }

    // Tambahkan nilai submit button jika ada
    const submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn?.name) {
      fields[submitBtn.name] = submitBtn.value || 'confirm';
    }

    return { method, action, fields };
  }

  // Fallback: cari link/button dengan teks konfirmasi
  const allLinks = Array.from(document.querySelectorAll('a, button'));
  for (const el of allLinks) {
    const text = el.textContent?.toLowerCase() || '';
    if (
      text.includes('konfirmasi') ||
      text.includes('confirm') ||
      text.includes('ya, itu saya') ||
      text.includes('yes, this was me')
    ) {
      const href = el.href || el.getAttribute('data-href') || '';
      if (href && href.includes('netflix.com')) {
        return { method: 'get', action: href, fields: {} };
      }
    }
  }

  return null;
}

/**
 * Submit form konfirmasi dengan method dan fields yang sudah diekstrak.
 */
async function _submitForm({ method, action, fields }, cookies) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const headers = {
      ...BROWSER_HEADERS,
      'Cookie': cookies,
    };

    let response;
    if (method === 'post') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const body = new URLSearchParams(fields).toString();
      response = await fetch(action, {
        method: 'POST',
        headers,
        body,
        redirect: 'follow',
        signal: controller.signal,
      });
    } else {
      const urlWithParams = new URL(action);
      for (const [k, v] of Object.entries(fields)) {
        urlWithParams.searchParams.set(k, v);
      }
      response = await fetch(urlWithParams.toString(), {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
    }

    const finalUrl = response.url;
    const ok = response.ok || _isSuccessUrl(finalUrl);
    return {
      ok,
      status: response.status,
      finalUrl,
      message: ok ? `HTTP ${response.status}` : `HTTP ${response.status} - ${finalUrl.slice(0, 80)}`,
    };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, status: 0, message: 'Timeout 30s' };
    return { ok: false, status: 0, message: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fallback: coba endpoint konfirmasi Netflix yang umum digunakan.
 * Netflix terkadang menggunakan pola URL tertentu untuk konfirmasi household.
 */
async function _tryFallbackConfirm(currentUrl, cookies) {
  logger.info('Mencoba fallback POST ke halaman saat ini...');

  const result = await _submitForm(
    { method: 'post', action: currentUrl, fields: { confirm: 'true', action: 'confirm' } },
    cookies
  );

  if (result.ok) {
    logger.info(`✅ Fallback berhasil! (HTTP ${result.status})`);
    return { ok: true, step: 2, message: `Fallback berhasil (HTTP ${result.status})` };
  }

  logger.warn('Fallback gagal. Kemungkinan Netflix memerlukan sesi login yang aktif.');
  return {
    ok: false,
    step: 2,
    message: 'Tidak bisa konfirmasi otomatis - Netflix memerlukan sesi login aktif.',
  };
}

/**
 * Mengecek apakah URL final menandakan konfirmasi berhasil.
 */
function _isSuccessUrl(url) {
  return (
    url.includes('/browse') ||
    url.includes('/YourAccount') ||
    url.includes('/success') ||
    url.includes('/confirmed')
  );
}

/**
 * Validasi URL sebelum dikunjungi.
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
