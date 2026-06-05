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
    verified:          { ok: true,  mark: '✓', title: 'Verified — byte-for-byte identical to the registered original' },
    authentic:         { ok: true,  mark: '✓', title: 'Authentic — matches the registered original, signature valid' },
    possibly_modified: { ok: false, mark: '✗', title: 'Modified — close to a registered original but altered' },
    signature_invalid: { ok: false, mark: '✗', title: 'Signature invalid — hash matched but the creator signature failed' }
};

function makeBadge(status) {
    const info = BADGE_INFO[status] || BADGE_INFO.possibly_modified;
    const b = document.createElement('div');
    b.textContent = info.mark;
    b.setAttribute('title', info.title);
    Object.assign(b.style, {
        position: 'absolute', boxSizing: 'border-box',
        width: BADGE_SIZE + 'px', height: BADGE_SIZE + 'px',
        borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        font: '700 14px/1 sans-serif', color: '#fff',
        background: info.ok ? '#27ae60' : '#e74c3c',
        border: '2px solid #fff',
        // Verified (exact) gets an extra green ring to stand apart from perceptual matches.
        boxShadow: status === 'verified'
            ? '0 0 0 2px #27ae60, 0 1px 4px rgba(0,0,0,0.45)'
            : '0 1px 4px rgba(0,0,0,0.45)',
        pointerEvents: 'none'
    });
    return b;
}

function applyOverlay(imgEl, status) {
    imgEl.setAttribute(ATTR_STATUS, status);
    imgEl.setAttribute(ATTR_URL, toAbsoluteURL(imgEl.currentSrc || imgEl.src));

    const badge = makeBadge(status);
    ensureBadgeLayer().appendChild(badge);
    badges.push({ el: imgEl, badge });
}

function clearOverlays() {
    document.querySelectorAll(`img[${ATTR_STATUS}]`).forEach(img => {
        img.removeAttribute(ATTR_STATUS);
        img.removeAttribute(ATTR_URL);
    });
    badges.forEach(({ badge }) => badge.remove());
    badges = [];
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
            .map(r => [r.url, r.status])
    );

    if (matched.size === 0) return;

    document.querySelectorAll('img').forEach(img => {
        const url = toAbsoluteURL(img.currentSrc || img.src);
        if (!url) return;
        const status = matched.get(url);
        if (status) applyOverlay(img, status);
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
