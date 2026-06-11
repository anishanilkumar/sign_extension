'use strict';

let activeTabId = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function formatTime(iso) {
    if (!iso) return 'never';
    try {
        return new Date(iso).toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch { return iso; }
}

// Full date + time with seconds, e.g. "19/05/2026, 11:18:21 am"
function formatDateTime(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString('en-GB', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: true
        });
    } catch { return iso; }
}

function filenameFromURL(url) {
    try {
        const p = new URL(url).pathname;
        const name = p.split('/').pop();
        return name ? decodeURIComponent(name) : url;
    } catch { return url; }
}

function shortFingerprint(fp) {
    if (!fp || fp.length <= 16) return fp || '';
    return fp.slice(0, 8) + '...' + fp.slice(-8);
}

// DOM builders — used instead of innerHTML so untrusted DB/URL values can never
// be interpreted as markup (and to satisfy the AMO "unsafe innerHTML" lint).
function makeEl(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
}

// Build a labelled detail row. `value` is a string, a Node, or an array of Nodes.
function row(label, value) {
    const r = makeEl('div', 'detail-row');
    r.appendChild(makeEl('span', 'detail-label', label));
    const v = makeEl('span', 'detail-value');
    if (typeof value === 'string') v.textContent = value;
    else if (Array.isArray(value)) value.forEach(n => v.appendChild(n));
    else v.appendChild(value);
    r.appendChild(v);
    return r;
}

// ── DB Status ─────────────────────────────────────────────────────────────────

function renderDbStatus({ status, count, fetchedAt, error }) {
    const dot  = el('db-dot');
    const text = el('db-status-text');
    const meta = el('db-meta');
    const btn  = el('refresh-btn');

    dot.className = 'status-dot';
    btn.classList.remove('spinning');
    btn.disabled = false;
    meta.classList.add('hidden');

    switch (status) {
        case 'ready':
            dot.classList.add('dot-ready');
            text.textContent = 'Database ready';
            meta.classList.remove('hidden');
            el('db-count').textContent = `${count ?? 0} entries`;
            el('db-time').textContent  = `Updated: ${formatTime(fetchedAt)}`;
            break;
        case 'updating':
            dot.classList.add('dot-updating');
            text.textContent = 'Updating database...';
            btn.classList.add('spinning');
            btn.disabled = true;
            break;
        case 'error':
            dot.classList.add('dot-error');
            text.textContent = `Error: ${error || 'Unknown'}`;
            break;
        default:
            dot.classList.add('dot-unknown');
            text.textContent = 'Checking...';
    }
}

// ── Results ───────────────────────────────────────────────────────────────────

const OK_STATUSES  = ['verified', 'authentic'];
const BAD_STATUSES = ['possibly_modified', 'signature_invalid'];

function scrollToImageOnPage(url) {
    if (activeTabId === null) return;
    browser.tabs.sendMessage(activeTabId, { type: 'scrollToImage', url }).catch(() => {});
}

function renderResults(results) {
    const list = el('results-list');

    const matched = (results || []).filter(
        r => OK_STATUSES.includes(r.status) || BAD_STATUSES.includes(r.status)
    );
    const okCount  = matched.filter(r => OK_STATUSES.includes(r.status)).length;
    const badCount = matched.filter(r => BAD_STATUSES.includes(r.status)).length;

    const noMatches = el('no-matches');

    if (matched.length === 0) {
        el('badge-authentic').classList.add('hidden');
        el('badge-modified').classList.add('hidden');
        noMatches.classList.remove('hidden');
        list.innerHTML = '';
        return;
    }

    noMatches.classList.add('hidden');

    if (okCount > 0) {
        el('badge-authentic').classList.remove('hidden');
        el('count-authentic').textContent = okCount;
    } else {
        el('badge-authentic').classList.add('hidden');
    }

    if (badCount > 0) {
        el('badge-modified').classList.remove('hidden');
        el('count-modified').textContent = badCount;
    } else {
        el('badge-modified').classList.add('hidden');
    }

    list.innerHTML = '';

    matched.forEach(result => {
        const status = result.status;
        const isOk = OK_STATUSES.includes(status);
        const isExact = status === 'verified';
        const entry = result.entry || {};
        const filename = entry.title || filenameFromURL(result.url);

        const bits = result.bits || 64;
        const distance = result.distance ?? 0;
        const similarity = ((bits - distance) / bits * 100).toFixed(1);

        const badgeLabel = {
            verified: 'Verified',
            authentic: 'Authentic',
            possibly_modified: 'Modified',
            signature_invalid: 'Signature ✗'
        }[status] || status;

        const subtitle = {
            verified: 'Byte-for-byte identical to the registered original.',
            authentic: 'Matches the registered original.',
            possibly_modified: 'Closely matches a registered original — possibly edited.',
            signature_invalid: 'Hash matched, but the creator signature failed to verify.'
        }[status] || '';

        const item = makeEl('div', 'result-item');

        // Header: indicator dot · filename · status badge
        const header = makeEl('div', 'result-header');
        header.appendChild(makeEl('span', `result-indicator ${isOk ? 'ind-green' : 'ind-red'}`));
        const fname = makeEl('span', 'result-filename', filename);
        fname.title = result.url;
        header.appendChild(fname);
        const badgeClass = isExact ? 'rb-verified'
            : isOk ? 'rb-authentic'
            : status === 'signature_invalid' ? 'rb-siginvalid'
            : 'rb-modified';
        header.appendChild(makeEl('span', `result-badge ${badgeClass}`, badgeLabel));
        header.appendChild(makeEl('span', 'result-chevron', '▸'));
        item.appendChild(header);

        // Collapsible body — hidden until this row is expanded.
        const body = makeEl('div', 'result-body');

        // Thumbnail of the page image; clicking it locates the image on the page.
        const thumbWrap = makeEl('div', 'result-thumb-wrap');
        const thumb = document.createElement('img');
        thumb.className = 'result-thumb';
        thumb.alt = filename;
        thumb.loading = 'lazy';
        thumb.title = 'Click to locate this image on the page';
        thumb.addEventListener('error', () => thumbWrap.classList.add('hidden'));
        thumb.addEventListener('click', (e) => {
            e.stopPropagation();
            scrollToImageOnPage(result.url);
        });
        thumb.src = result.url;
        thumbWrap.appendChild(thumb);
        body.appendChild(thumbWrap);

        body.appendChild(makeEl('div', 'result-subtitle', subtitle));

        const details = makeEl('div', 'result-details');

        if (entry.creator_name) {
            const parts = [document.createTextNode(entry.creator_name)];
            if (entry.creator_handle) {
                parts.push(document.createTextNode(' '),
                    makeEl('span', 'handle', '@' + entry.creator_handle.replace(/^@/, '')));
            }
            details.appendChild(row('Creator', parts));
        }
        if (entry.title) {
            details.appendChild(row('Title', entry.title));
        }
        if (entry.registered_at) {
            details.appendChild(row('Registered', formatDateTime(entry.registered_at)));
        }

        // Match: exact = byte-for-byte; perceptual = similarity + bits + which hash.
        if (isExact) {
            details.appendChild(row('Match', [
                makeEl('span', 'sim-full', '100% — byte-for-byte identical')
            ]));
        } else {
            const matchType = result.matchType === 'perceptual256' ? '256-bit'
                : result.matchType === 'perceptual64' ? '64-bit' : 'perceptual';
            details.appendChild(row('Match', [
                makeEl('span', isOk ? 'sim-full' : 'sim-partial', `${similarity}% match`),
                makeEl('span', 'bits', ` · ${distance}/${bits} bits differ · ${matchType}`)
            ]));
        }

        if (entry.creator_fingerprint) {
            // A changed image is not the signed original, so only exact/authentic
            // matches read as Valid; anything modified is Invalid.
            let sig;
            if (result.signatureValid === null || result.signatureValid === undefined) {
                sig = makeEl('span', 'sig-unknown', '— Not checked');
            } else if (result.signatureValid === true && isOk) {
                sig = makeEl('span', 'sig-valid', '✓ Valid');
            } else {
                sig = makeEl('span', 'sig-invalid', '✗ Invalid');
            }
            const fp = makeEl('span', 'fingerprint', shortFingerprint(entry.creator_fingerprint));
            fp.title = entry.creator_fingerprint;
            details.appendChild(row('Signature', [sig, fp]));
        }

        body.appendChild(details);
        item.appendChild(body);

        // Header click → accordion: open this row and collapse any other.
        header.addEventListener('click', () => {
            const willOpen = !item.classList.contains('expanded');
            list.querySelectorAll('.result-item.expanded')
                .forEach(other => other.classList.remove('expanded'));
            if (willOpen) item.classList.add('expanded');
        });

        list.appendChild(item);
    });

    // A lone match has nothing to choose between — open it by default.
    if (matched.length === 1) {
        list.querySelector('.result-item')?.classList.add('expanded');
    }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function loadDbInfo() {
    try {
        const info = await browser.runtime.sendMessage({ type: 'getDbInfo' });
        renderDbStatus(info);
    } catch {
        renderDbStatus({ status: 'error', error: 'Background unavailable' });
    }
}

async function loadResults() {
    if (activeTabId === null) return;
    try {
        const { results } = await browser.runtime.sendMessage({
            type: 'getCachedResults',
            tabId: activeTabId
        });
        renderResults(results);
    } catch {
        renderResults(null);
    }
}

async function triggerRefresh() {
    const btn = el('refresh-btn');
    btn.classList.add('spinning');
    btn.disabled = true;
    renderDbStatus({ status: 'updating' });
    try {
        await browser.runtime.sendMessage({ type: 'manualRefresh' });
    } finally {
        await loadDbInfo();
        await loadResults();
    }
}

// ── Settings ──────────────────────────────────────────────────────────────────

el('settings-toggle').addEventListener('click', async () => {
    const form = el('settings-form');
    const isHidden = form.classList.contains('hidden');
    form.classList.toggle('hidden');
    if (isHidden) {
        const { serverUrl } = await browser.runtime.sendMessage({ type: 'getSettings' });
        el('server-url-input').value = serverUrl;
    }
});

el('save-settings-btn').addEventListener('click', async () => {
    const url = el('server-url-input').value.trim();
    if (!url) return;
    await browser.runtime.sendMessage({ type: 'saveSettings', serverUrl: url });
    el('settings-form').classList.add('hidden');
    await triggerRefresh();
});

// ── Refresh button ────────────────────────────────────────────────────────────

el('refresh-btn').addEventListener('click', triggerRefresh);

// ── Background event listener (DB status push) ────────────────────────────────

browser.runtime.onMessage.addListener(async (msg) => {
    if (msg.type === 'dbStatus') {
        renderDbStatus(msg);
        if (msg.status === 'ready') {
            await loadResults();
        }
    } else if (msg.type === 'scanResults' && msg.tabId === activeTabId) {
        renderResults(msg.results);
    }
});

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    await Promise.all([loadDbInfo(), loadResults()]);
})();
