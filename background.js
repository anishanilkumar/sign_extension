'use strict';

const DEFAULT_SERVER_URL = 'https://sign.authentiverse.net';
const ALARM_NAME = 'authenticity-db-refresh';
const REFRESH_INTERVAL_MINUTES = 60;

// In-memory cache of scan results per tab (cleared when tab closes or background restarts)
const tabResultsCache = new Map();

// ── Lifecycle ─────────────────────────────────────────────────────────────────

browser.runtime.onInstalled.addListener(async () => {
    await browser.alarms.create(ALARM_NAME, {
        delayInMinutes: 0.1,
        periodInMinutes: REFRESH_INTERVAL_MINUTES
    });
});

browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
        await fetchAndStoreDB();
    }
});

browser.tabs.onRemoved.addListener((tabId) => {
    tabResultsCache.delete(tabId);
});

// ── DB Fetching ───────────────────────────────────────────────────────────────

async function fetchAndStoreDB() {
    await setDbStatus('updating');

    try {
        const { serverUrl } = await browser.storage.local.get('serverUrl');
        const base = (serverUrl || DEFAULT_SERVER_URL).replace(/\/$/, '');

        const response = await fetch(`${base}/api/db/export`, {
            headers: { Accept: 'application/json' },
            cache: 'no-cache'
        });

        if (!response.ok) {
            throw new Error(`Server returned HTTP ${response.status}`);
        }

        const db = await response.json();
        const fetchedAt = new Date().toISOString();

        await browser.storage.local.set({
            db,
            dbStatus: 'ready',
            dbFetchedAt: fetchedAt,
            dbError: null
        });

        broadcast({ type: 'dbStatus', status: 'ready', count: db.count, fetchedAt });
    } catch (err) {
        await browser.storage.local.set({
            dbStatus: 'error',
            dbError: err.message
        });
        broadcast({ type: 'dbStatus', status: 'error', error: err.message });
    }
}

async function setDbStatus(status) {
    await browser.storage.local.set({ dbStatus: status });
    broadcast({ type: 'dbStatus', status });
}

function broadcast(message) {
    // Notify popup if open; ignore errors when popup is closed
    browser.runtime.sendMessage(message).catch(() => {});
}

// ── Message Router ────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {

        case 'scanImages':
            handleScan(msg.urls, sender.tab.id)
                .then(results => sendResponse({ ok: true, results }))
                .catch(err => sendResponse({ ok: false, error: err.message }));
            return true; // async

        case 'getCachedResults': {
            const cached = tabResultsCache.get(msg.tabId);
            if (cached === undefined) {
                // Background restarted and lost its cache; ask the content script to re-scan.
                browser.tabs.sendMessage(msg.tabId, { type: 'triggerScan' }).catch(() => {});
            }
            sendResponse({ results: cached ?? null });
            return false;
        }

        case 'manualRefresh':
            fetchAndStoreDB()
                .then(() => sendResponse({ ok: true }))
                .catch(err => sendResponse({ ok: false, error: err.message }));
            return true;

        case 'getDbInfo':
            browser.storage.local.get(['dbStatus', 'dbFetchedAt', 'dbError', 'db'])
                .then(({ dbStatus, dbFetchedAt, dbError, db }) => sendResponse({
                    status: dbStatus || 'unknown',
                    fetchedAt: dbFetchedAt || null,
                    error: dbError || null,
                    count: db?.count ?? 0
                }))
                .catch(err => sendResponse({ status: 'error', error: err.message }));
            return true;

        case 'getSettings':
            browser.storage.local.get('serverUrl')
                .then(({ serverUrl }) => sendResponse({
                    serverUrl: serverUrl || DEFAULT_SERVER_URL
                }))
                .catch(err => sendResponse({ error: err.message }));
            return true;

        case 'saveSettings':
            browser.storage.local.set({ serverUrl: msg.serverUrl })
                .then(() => sendResponse({ ok: true }))
                .catch(err => sendResponse({ ok: false, error: err.message }));
            return true;
    }
});

// ── Image Scanning ────────────────────────────────────────────────────────────

async function handleScan(urls, tabId) {
    const { db } = await browser.storage.local.get('db');

    const results = await Promise.allSettled(
        urls.map(url => hashAndMatch(url, db))
    );

    const scanResults = results.map((r, i) =>
        r.status === 'fulfilled'
            ? r.value
            : { url: urls[i], status: 'error', reason: r.reason?.message }
    );

    tabResultsCache.set(tabId, scanResults);
    updateBadge(tabId, scanResults);
    broadcast({ type: 'scanResults', tabId, results: scanResults });
    return scanResults;
}

async function hashAndMatch(url, db) {
    const hashes = await computeHashesFromURL(url);
    if (!hashes) return { url, status: 'hash_failed' };

    const match = db ? findBestMatch(hashes, db) : null;
    if (!match) return { url, status: 'not_found', hashes };

    // Verify the creator's OpenPGP signature and confirm the hash we matched on
    // is the one inside the signed assertion (defeats a tampered DB export).
    const sig = await verifyEntrySignature(match);
    const status = sig.valid === false ? 'signature_invalid' : match.status;

    return {
        url,
        status,
        matchType: match.matchType,
        distance: match.distance,
        bits: match.bits,
        entry: match.entry,
        signatureValid: sig.valid,        // true | false | null (no signature data)
        signatureReason: sig.reason,
        hashes
    };
}

// SHA-256 of an ArrayBuffer → lowercase hex string.
async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Verify the matched entry's OpenPGP clearsigned assertion against the creator's
// public key, and cross-check that the hash we matched on appears in the signed
// payload. Returns { valid, reason } where valid is true/false, or null when the
// entry carries no signature material (legacy export).
async function verifyEntrySignature(match) {
    const e = match.entry;
    if (!e.signed_assertion || !e.creator_public_key) {
        return { valid: null, reason: 'no_signature_data' };
    }
    try {
        const [pubKey, msg] = await Promise.all([
            openpgp.readKey({ armoredKey: e.creator_public_key }),
            openpgp.readCleartextMessage({ cleartextMessage: e.signed_assertion })
        ]);
        const result = await openpgp.verify({ message: msg, verificationKeys: pubKey });
        const ok = await result.signatures[0].verified.then(() => true).catch(() => false);
        if (!ok) return { valid: false, reason: 'bad_signature' };

        // The hash we matched on must be the one the creator actually signed.
        const assertion = JSON.parse(result.data);
        const matchedHash =
            match.matchType === 'exact'         ? e.sha256   :
            match.matchType === 'perceptual256' ? e.phash256  :
                                                  e.phash;
        const signedHash =
            match.matchType === 'exact'         ? assertion.sha256   :
            match.matchType === 'perceptual256' ? assertion.phash256 :
                                                  assertion.fingerprint;
        if (!signedHash || signedHash !== matchedHash) {
            return { valid: false, reason: 'hash_not_in_assertion' };
        }
        return { valid: true, reason: 'ok' };
    } catch (err) {
        return { valid: false, reason: 'verify_error: ' + (err?.message || err) };
    }
}

// Fetch an image URL via the extension's cross-origin fetch and compute all
// fingerprints: exact SHA-256 of the bytes plus 64-bit and 256-bit pHashes from
// the decoded pixels. Returns { sha256, phash64, phash256 } or null on failure.
async function computeHashesFromURL(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null;

    let blob;
    try {
        // Try CORS fetch first, fall back to a plain fetch.
        const resp = await fetch(url, { mode: 'cors' });
        if (!resp.ok) throw new Error('non-2xx');
        blob = await resp.blob();
    } catch {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('non-2xx');
            blob = await resp.blob();
        } catch {
            return null;
        }
    }

    if (!blob.type.startsWith('image/')) return null;

    // Exact byte hash from the fetched bytes (codec-independent: both the server
    // and the extension hash the same file bytes).
    let sha256 = null;
    try {
        sha256 = await sha256Hex(await blob.arrayBuffer());
    } catch { /* leave null */ }

    // Perceptual hashes from decoded pixels.
    const perceptual = await new Promise((resolve) => {
        const objectURL = URL.createObjectURL(blob);
        const img = new Image();

        img.onload = () => {
            URL.revokeObjectURL(objectURL);

            // Skip tiny images (icons, spacers, tracking pixels)
            if (img.naturalWidth < 50 || img.naturalHeight < 50) {
                resolve(null);
                return;
            }

            try {
                // Draw at native resolution (1:1, no canvas resampling) so the
                // JS pipeline matches the server's PIL grayscale + LANCZOS exactly.
                const w = img.naturalWidth;
                const h = img.naturalHeight;
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                const data = ctx.getImageData(0, 0, w, h).data;
                resolve({
                    phash64:  computePHashFromRGBA(data, w, h),
                    phash256: computePHashFromRGBA(data, w, h, { size: 64, hashSize: 16 })
                });
            } catch {
                resolve(null);
            }
        };

        img.onerror = () => {
            URL.revokeObjectURL(objectURL);
            resolve(null);
        };

        img.src = objectURL;
    });

    if (!sha256 && !perceptual) return null;
    return {
        sha256,
        phash64:  perceptual?.phash64  || null,
        phash256: perceptual?.phash256 || null
    };
}

// ── Badge ─────────────────────────────────────────────────────────────────────

function updateBadge(tabId, results) {
    // Green: byte-for-byte verified or perceptually authentic.
    // Red:   possibly modified or a failed signature.
    const ok = (s) => s === 'verified' || s === 'authentic';
    const bad = (s) => s === 'possibly_modified' || s === 'signature_invalid';
    const authentic = results.filter(r => ok(r.status)).length;
    const modified  = results.filter(r => bad(r.status)).length;
    const total     = authentic + modified;

    if (total === 0) {
        browser.browserAction.setBadgeText({ text: '', tabId });
        return;
    }

    browser.browserAction.setBadgeText({ text: String(total), tabId });
    browser.browserAction.setBadgeBackgroundColor({
        color: modified > 0 ? '#e74c3c' : '#27ae60',
        tabId
    });
}
