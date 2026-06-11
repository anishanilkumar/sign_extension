'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toAbsoluteURL(src) {
    if (!src) return null;
    if (/^https?:\/\//.test(src)) return src;
    if (src.startsWith('//')) return location.protocol + src;
    try { return new URL(src, location.href).href; } catch { return null; }
}

function collectImages() {
    const seen = new Set();
    const imgs = [];

    document.querySelectorAll('img').forEach(img => {
        const src = toAbsoluteURL(img.currentSrc || img.src);
        if (!src || seen.has(src)) return;
        seen.add(src);
        imgs.push({ url: src, el: img });
    });

    return imgs;
}

// ── Overlay management ────────────────────────────────────────────────────────

const ATTR_STATUS = 'data-auth-status';
const ATTR_URL    = 'data-auth-url';
const BADGE_LAYER_ID = 'auth-badge-layer';
const BADGE_SIZE = 22;
const BADGE_MARGIN = 6;

// A single fixed-position layer holds all corner badges. Anchoring badges to
// each image's viewport rect (rather than outlining the <img>) survives the
// clipped/overflow-hidden, object-fit containers used by feeds like Facebook.
let badgeLayer = null;
let badges = [];           // { el, badge }
let repositionScheduled = false;

function ensureBadgeLayer() {
    if (badgeLayer && document.documentElement.contains(badgeLayer)) return badgeLayer;
    badgeLayer = document.createElement('div');
    badgeLayer.id = BADGE_LAYER_ID;
    Object.assign(badgeLayer.style, {
        position: 'fixed', top: '0', left: '0', width: '0', height: '0',
        margin: '0', padding: '0', border: 'none',
        pointerEvents: 'none', zIndex: '2147483647'
    });
    document.documentElement.appendChild(badgeLayer);
    return badgeLayer;
}

const BADGE_INFO = {
    verified:          { ok: true,  mark: '✓', label: 'Verified',          desc: 'Byte-for-byte identical to the registered original.' },
    authentic:         { ok: true,  mark: '✓', label: 'Authentic',         desc: 'Matches the registered original.' },
    possibly_modified: { ok: false, mark: '✗', label: 'Possibly modified', desc: 'Close to a registered original but altered.' },
    signature_invalid: { ok: false, mark: '✗', label: 'Signature invalid', desc: 'Hash matched, but the creator signature failed to verify.' }
};

// Badge appearance + tooltip styling live in an injected stylesheet (a <style>
// element is CSP-safe; the failed-signature badge needs a keyframe animation that
// inline styles can't express).
let stylesInjected = false;
function ensureBadgeStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'auth-badge-styles';
    style.textContent = `
#${BADGE_LAYER_ID} .auth-badge {
    position: absolute; box-sizing: border-box;
    width: ${BADGE_SIZE}px; height: ${BADGE_SIZE}px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font: 700 14px/1 sans-serif; color: #fff; border: 2px solid #fff;
    pointer-events: auto; cursor: help; transform-origin: top right;
}
#${BADGE_LAYER_ID} .auth-badge--ok       { background: #27ae60; box-shadow: 0 1px 4px rgba(0,0,0,0.45); }
#${BADGE_LAYER_ID} .auth-badge--bad      { background: #e74c3c; box-shadow: 0 1px 4px rgba(0,0,0,0.45); }
#${BADGE_LAYER_ID} .auth-badge--verified { box-shadow: 0 0 0 2px #27ae60, 0 1px 4px rgba(0,0,0,0.45); }
/* A failed signature is the most alarming state — make it bigger, ringed and pulsing
   so it can't be mistaken for a plain "possibly modified" cross. */
#${BADGE_LAYER_ID} .auth-badge--siginvalid {
    background: #c0392b; border-color: #ffe08a; font-size: 16px;
    transform: scale(1.3);
    animation: authBadgePulse 1.1s ease-in-out infinite;
}
@keyframes authBadgePulse {
    0%, 100% { box-shadow: 0 0 0 2px rgba(192,57,43,0.95), 0 0 7px 2px rgba(231,76,60,0.6),  0 1px 4px rgba(0,0,0,0.5); }
    50%      { box-shadow: 0 0 0 4px rgba(192,57,43,0.55), 0 0 16px 6px rgba(231,76,60,0.9), 0 1px 4px rgba(0,0,0,0.5); }
}
#auth-badge-tooltip {
    position: fixed; z-index: 2147483647; pointer-events: none;
    max-width: 290px; padding: 9px 11px; border-radius: 8px;
    background: rgba(20,20,31,0.97); color: #e6e6f2; border: 1px solid #2c2c48;
    box-shadow: 0 6px 22px rgba(0,0,0,0.55);
    font: 12px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    opacity: 0; transition: opacity 0.1s; display: none;
}
#auth-badge-tooltip .tt-title { font-weight: 700; font-size: 12px; }
#auth-badge-tooltip .tt-title.ok  { color: #2ecc71; }
#auth-badge-tooltip .tt-title.bad { color: #ff6b5e; }
#auth-badge-tooltip .tt-desc { color: #9a9ab4; margin: 3px 0 6px; }
#auth-badge-tooltip .tt-row { display: flex; gap: 6px; margin-top: 3px; }
#auth-badge-tooltip .tt-k { color: #7a7a96; flex-shrink: 0; min-width: 62px; text-transform: uppercase; font-size: 9px; letter-spacing: 0.5px; padding-top: 2px; }
#auth-badge-tooltip .tt-v { color: #c8c8e0; word-break: break-word; }
#auth-badge-tooltip .tt-v .ok    { color: #2ecc71; font-weight: 600; }
#auth-badge-tooltip .tt-v .bad   { color: #ff6b5e; font-weight: 600; }
#auth-badge-tooltip .tt-v .muted { color: #7a7a96; }
#auth-badge-tooltip .tt-v .mono  { font-family: 'SF Mono','Fira Mono',monospace; font-size: 10px; }
`;
    (document.head || document.documentElement).appendChild(style);
}

function makeBadge(status, result) {
    ensureBadgeStyles();
    const info = BADGE_INFO[status] || BADGE_INFO.possibly_modified;
    const b = document.createElement('div');
    b.className = 'auth-badge ' + (info.ok ? 'auth-badge--ok' : 'auth-badge--bad');
    if (status === 'verified')          b.classList.add('auth-badge--verified');
    if (status === 'signature_invalid') b.classList.add('auth-badge--siginvalid');
    b.textContent = info.mark;
    b.setAttribute('aria-label', info.label);
    b.addEventListener('mouseenter', () => showTooltip(b, status, result));
    b.addEventListener('mouseleave', hideTooltip);
    return b;
}

function applyOverlay(imgEl, status, result) {
    imgEl.setAttribute(ATTR_STATUS, status);
    imgEl.setAttribute(ATTR_URL, toAbsoluteURL(imgEl.currentSrc || imgEl.src));

    const badge = makeBadge(status, result);
    ensureBadgeLayer().appendChild(badge);
    badges.push({ el: imgEl, badge });
}

function clearOverlays() {
    hideTooltip();
    document.querySelectorAll(`img[${ATTR_STATUS}]`).forEach(img => {
        img.removeAttribute(ATTR_STATUS);
        img.removeAttribute(ATTR_URL);
    });
    badges.forEach(({ badge }) => badge.remove());
    badges = [];
}

// ── Hover tooltip (signature details) ──────────────────────────────────────────

let tooltipEl = null;

function ensureTooltip() {
    if (tooltipEl && document.documentElement.contains(tooltipEl)) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'auth-badge-tooltip';
    document.documentElement.appendChild(tooltipEl);
    return tooltipEl;
}

function ttShortFp(fp) {
    if (!fp) return '';
    return fp.length <= 16 ? fp : fp.slice(0, 8) + '…' + fp.slice(-8);
}

function ttDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString(undefined, {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch { return iso; }
}

function ttSpan(cls, text) {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    return s;
}

function ttRow(parent, key, value) {
    const r = document.createElement('div');
    r.className = 'tt-row';
    r.appendChild(ttSpan('tt-k', key));
    const v = ttSpan('tt-v');
    if (typeof value === 'string') v.textContent = value;
    else value.forEach(n => v.appendChild(n));
    r.appendChild(v);
    parent.appendChild(r);
}

// Build the tooltip body from the per-image scan result (carries entry + signature
// data forwarded from the background's scanImages response). DOM is built with
// textContent only — never innerHTML — so DB/page values can't inject markup.
function buildTooltip(status, result) {
    const info = BADGE_INFO[status] || BADGE_INFO.possibly_modified;
    const tip = ensureTooltip();
    tip.textContent = '';

    const title = ttSpan('tt-title ' + (info.ok ? 'ok' : 'bad'), info.mark + ' ' + info.label);
    title.style.display = 'block';
    tip.appendChild(title);
    tip.appendChild(ttSpan('tt-desc', info.desc)).style.display = 'block';

    const entry = (result && result.entry) || {};

    if (entry.creator_name) {
        const nodes = [ttSpan(null, entry.creator_name)];
        if (entry.creator_handle) {
            nodes.push(ttSpan('muted', ' @' + String(entry.creator_handle).replace(/^@/, '')));
        }
        ttRow(tip, 'Creator', nodes);
    }
    if (entry.title) ttRow(tip, 'Title', entry.title);

    if (result && result.matchType === 'exact') {
        ttRow(tip, 'Match', [ttSpan('ok', '100% — byte-for-byte identical')]);
    } else if (result && typeof result.distance === 'number' && result.bits) {
        const sim = ((result.bits - result.distance) / result.bits * 100).toFixed(1);
        const kind = result.matchType === 'perceptual256' ? '256-bit'
            : result.matchType === 'perceptual64' ? '64-bit' : 'perceptual';
        ttRow(tip, 'Match', [
            ttSpan(info.ok ? 'ok' : 'bad', sim + '% match'),
            ttSpan('muted', ` · ${result.distance}/${result.bits} bits · ${kind}`)
        ]);
    }

    // The signature covers the registered original. A changed image is not that
    // original, so only an exact/authentic match counts as Valid — anything
    // modified is reported Invalid.
    let sigNode;
    if (!result || result.signatureValid === null || result.signatureValid === undefined) {
        sigNode = ttSpan('muted', '— Not checked');
    } else if (result.signatureValid === true && info.ok) {
        sigNode = ttSpan('ok', '✓ Valid');
    } else {
        const reason = result.signatureReason && result.signatureReason !== 'ok'
            ? ` (${result.signatureReason})` : '';
        sigNode = ttSpan('bad', '✗ Invalid' + reason);
    }
    ttRow(tip, 'Signature', [sigNode]);

    if (entry.creator_fingerprint) ttRow(tip, 'Key', [ttSpan('mono', ttShortFp(entry.creator_fingerprint))]);
    if (entry.registered_at)       ttRow(tip, 'Registered', ttDate(entry.registered_at));

    return tip;
}

function showTooltip(badge, status, result) {
    const tip = buildTooltip(status, result);
    tip.style.display = 'block';
    // Measure, then anchor to the badge and clamp inside the viewport.
    const br = badge.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const margin = 8;
    let left = br.right - tr.width;        // right-align to the badge
    let top  = br.bottom + 6;              // below the badge by default
    if (top + tr.height > window.innerHeight - margin) {
        top = br.top - tr.height - 6;      // flip above if it would overflow
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - tr.width - margin));
    top  = Math.max(margin, top);
    tip.style.left = left + 'px';
    tip.style.top  = top + 'px';
    requestAnimationFrame(() => { tip.style.opacity = '1'; });
}

function hideTooltip() {
    if (!tooltipEl) return;
    tooltipEl.style.opacity = '0';
    tooltipEl.style.display = 'none';
}

function reposition() {
    repositionScheduled = false;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (const { el, badge } of badges) {
        const rect = el.getBoundingClientRect();
        // Hide for off-screen, detached, or too-small images
        if (rect.width < 2 * BADGE_SIZE || rect.height < 2 * BADGE_SIZE ||
            rect.bottom <= 0 || rect.top >= vh ||
            rect.right <= 0 || rect.left >= vw) {
            badge.style.display = 'none';
            continue;
        }
        badge.style.display = 'flex';
        badge.style.left = (rect.right - BADGE_SIZE - BADGE_MARGIN) + 'px';
        badge.style.top  = (rect.top + BADGE_MARGIN) + 'px';
    }
}

function scheduleReposition() {
    // The tooltip is anchored to a badge's old position; drop it as things move.
    hideTooltip();
    if (repositionScheduled) return;
    repositionScheduled = true;
    requestAnimationFrame(reposition);
}

function applyResults(results) {
    clearOverlays();

    const BADGE_STATUSES = ['verified', 'authentic', 'possibly_modified', 'signature_invalid'];
    const matched = new Map(
        results
            .filter(r => BADGE_STATUSES.includes(r.status))
            .map(r => [r.url, r])
    );

    if (matched.size === 0) return;

    document.querySelectorAll('img').forEach(img => {
        const url = toAbsoluteURL(img.currentSrc || img.src);
        if (!url) return;
        const result = matched.get(url);
        if (result) applyOverlay(img, result.status, result);
    });

    reposition();
}

// Keep badges glued to their images as the page scrolls or resizes.
// Capture phase catches scrolling inside nested containers (e.g. feeds).
window.addEventListener('scroll', scheduleReposition, true);
window.addEventListener('resize', scheduleReposition);

function scrollToAndHighlight(url) {
    const img = document.querySelector(`img[${ATTR_URL}="${CSS.escape(url)}"]`);
    if (!img) return;

    img.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const saved = img.style.outline;
    img.style.transition = 'outline 0.15s ease';
    img.style.outline    = '5px solid #f1c40f';
    setTimeout(() => {
        img.style.outline    = saved;
        img.style.transition = '';
    }, 900);
}

// ── Scanning ──────────────────────────────────────────────────────────────────

let lastScanUrls = null;

async function scan() {
    const images = collectImages();
    if (images.length === 0) return;

    const urls = images.map(i => i.url);

    // Skip if the set of image URLs hasn't changed since the last scan
    const urlKey = urls.join('\n');
    if (urlKey === lastScanUrls) return;
    lastScanUrls = urlKey;

    try {
        const resp = await browser.runtime.sendMessage({ type: 'scanImages', urls });
        if (resp?.ok) applyResults(resp.results);
    } catch {
        // Background not ready yet; a retry via MutationObserver will follow
    }
}

// ── Init + dynamic page support ───────────────────────────────────────────────

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
} else {
    scan();
}

// Debounced MutationObserver to catch dynamically inserted images (SPAs, lazy loading)
let debounceTimer = null;

const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, 1500);
});

if (document.body) {
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributeFilter: ['src']
    });
}

// ── Message listener ──────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'scrollToImage') {
        scrollToAndHighlight(msg.url);
    } else if (msg.type === 'triggerScan') {
        lastScanUrls = null;
        scan();
    }
});
