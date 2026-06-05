'use strict';

// DCT-II (Type 2, unnormalized) — matches scipy.fft.dct(x, type=2, norm=None)
// Formula: y[k] = 2 * sum_{n=0}^{N-1} x[n] * cos(pi*k*(2n+1) / (2N))
function _dct1d(input) {
    const N = input.length;
    const output = new Float64Array(N);
    for (let k = 0; k < N; k++) {
        let sum = 0.0;
        for (let n = 0; n < N; n++) {
            sum += input[n] * Math.cos(Math.PI * k * (2 * n + 1) / (2 * N));
        }
        output[k] = 2.0 * sum;
    }
    return output;
}

// 2D DCT via separable 1D DCTs: apply to rows, then columns
function _dct2d(matrix, N) {
    const temp = new Float64Array(N * N);
    const result = new Float64Array(N * N);

    for (let row = 0; row < N; row++) {
        const rowData = new Float64Array(N);
        for (let col = 0; col < N; col++) {
            rowData[col] = matrix[row * N + col];
        }
        const dctRow = _dct1d(rowData);
        for (let col = 0; col < N; col++) {
            temp[row * N + col] = dctRow[col];
        }
    }

    for (let col = 0; col < N; col++) {
        const colData = new Float64Array(N);
        for (let row = 0; row < N; row++) {
            colData[row] = temp[row * N + col];
        }
        const dctCol = _dct1d(colData);
        for (let row = 0; row < N; row++) {
            result[row * N + col] = dctCol[row];
        }
    }

    return result;
}

// ── LANCZOS resampling (byte-for-byte match to PIL Image.resize) ───────────────
// PIL converts to grayscale at full resolution, then resizes with a Lanczos
// (a=3) separable filter, clipping to uint8 after each pass. Canvas bilinear
// scaling does NOT match this, which is why originals came back a few bits off.

const _LANCZOS_SUPPORT = 3.0;

function _sinc(x) {
    if (x === 0.0) return 1.0;
    x *= Math.PI;
    return Math.sin(x) / x;
}

function _lanczos(x) {
    if (-3.0 <= x && x < 3.0) {
        return _sinc(x) * _sinc(x / 3.0);
    }
    return 0.0;
}

// Round-then-clamp to uint8, matching PIL's clip8: (int)(v + 0.5) bounded to [0,255].
function _clip8(v) {
    if (v <= 0.0) return 0;
    if (v >= 255.0) return 255;
    return Math.floor(v + 0.5);
}

// Port of PIL Resample.c precompute_coeffs for the full-image box [0, inSize].
function _precomputeCoeffs(inSize, outSize) {
    const scale = inSize / outSize;
    const filterscale = scale < 1.0 ? 1.0 : scale;
    const support = _LANCZOS_SUPPORT * filterscale;
    const ksize = Math.ceil(support) * 2 + 1;
    const bounds = new Int32Array(outSize * 2);
    const kk = new Float64Array(outSize * ksize);

    for (let xx = 0; xx < outSize; xx++) {
        const center = (xx + 0.5) * scale;
        const ss = 1.0 / filterscale;
        let xmin = Math.trunc(center - support + 0.5);
        if (xmin < 0) xmin = 0;
        let xmax = Math.trunc(center + support + 0.5);
        if (xmax > inSize) xmax = inSize;
        xmax -= xmin;

        const base = xx * ksize;
        let ww = 0.0;
        for (let x = 0; x < xmax; x++) {
            const w = _lanczos((x + xmin - center + 0.5) * ss);
            kk[base + x] = w;
            ww += w;
        }
        for (let x = 0; x < xmax; x++) {
            if (ww !== 0.0) kk[base + x] /= ww;
        }
        bounds[xx * 2] = xmin;
        bounds[xx * 2 + 1] = xmax;
    }
    return { bounds, kk, ksize };
}

function _resampleHorizontal(src, inW, inH, outW) {
    const { bounds, kk, ksize } = _precomputeCoeffs(inW, outW);
    const out = new Float64Array(inH * outW);
    for (let yy = 0; yy < inH; yy++) {
        const rowIn = yy * inW;
        const rowOut = yy * outW;
        for (let xx = 0; xx < outW; xx++) {
            const xmin = bounds[xx * 2];
            const xmax = bounds[xx * 2 + 1];
            const base = xx * ksize;
            let ss = 0.0;
            for (let x = 0; x < xmax; x++) {
                ss += src[rowIn + xmin + x] * kk[base + x];
            }
            out[rowOut + xx] = _clip8(ss);
        }
    }
    return out;
}

function _resampleVertical(src, inW, inH, outH) {
    const { bounds, kk, ksize } = _precomputeCoeffs(inH, outH);
    const out = new Float64Array(outH * inW);
    for (let yy = 0; yy < outH; yy++) {
        const ymin = bounds[yy * 2];
        const ymax = bounds[yy * 2 + 1];
        const base = yy * ksize;
        const rowOut = yy * inW;
        for (let xx = 0; xx < inW; xx++) {
            let ss = 0.0;
            for (let y = 0; y < ymax; y++) {
                ss += src[(ymin + y) * inW + xx] * kk[base + y];
            }
            out[rowOut + xx] = _clip8(ss);
        }
    }
    return out;
}

// Resize a grayscale (Float, 0–255) image to outW×outH. Horizontal pass first,
// then vertical, matching PIL's pass order and intermediate uint8 clipping.
function _lanczosResizeGray(gray, inW, inH, outW, outH) {
    let img = gray, w = inW, h = inH;
    if (w !== outW) { img = _resampleHorizontal(img, w, h, outW); w = outW; }
    if (h !== outH) { img = _resampleVertical(img, w, h, outH); h = outH; }
    return img;
}

// PIL "L" conversion: L = (R*19595 + G*38470 + B*7471 + 0x8000) >> 16
function _toGrayPIL(rgba, w, h) {
    const gray = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
        gray[i] = (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;
    }
    return gray;
}

// Core hashing on a (size×size) grayscale Float array → hex string.
// Matches imagehash.phash(img, hash_size=hashSize, highfreq_factor=size/hashSize):
// take the top-left hashSize×hashSize DCT block, compare each to the median,
// pack MSB-first into a (hashSize²)-bit value → (hashSize²/4)-char hex.
function _hashFromGray(gray, size, hashSize) {
    const dct = _dct2d(gray, size);

    const n = hashSize * hashSize;
    const lowFreq = new Float64Array(n);
    for (let row = 0; row < hashSize; row++) {
        for (let col = 0; col < hashSize; col++) {
            lowFreq[row * hashSize + col] = dct[row * size + col];
        }
    }

    // Median — matches numpy.median for even-length arrays (avg of two middle).
    const sorted = Array.from(lowFreq).sort((a, b) => a - b);
    const mid = sorted.length / 2;
    const median = (sorted[mid - 1] + sorted[mid]) / 2;

    let hash = 0n;
    for (let i = 0; i < n; i++) {
        if (lowFreq[i] > median) {
            hash |= 1n << BigInt(n - 1 - i);
        }
    }

    return hash.toString(16).padStart(n / 4, '0');
}

// Compute pHash from full-resolution RGBA pixels.
// Mirrors imagehash.phash exactly: convert("L") → resize size×size LANCZOS → DCT.
// Defaults to the 64-bit hash (size 32, hashSize 8); pass {size:64,hashSize:16}
// for the 256-bit high-resolution hash.
function computePHashFromRGBA(rgba, width, height, { size = 32, hashSize = 8 } = {}) {
    const gray = _toGrayPIL(rgba, width, height);
    const small = _lanczosResizeGray(gray, width, height, size, size);
    return _hashFromGray(small, size, hashSize);
}

// Legacy entry point: pHash from a pre-resized 32×32 ImageData (canvas-scaled).
// Kept for compatibility; computePHashFromRGBA is the accurate path.
function computePHashFromImageData(imageData) {
    const SIZE = 32;
    const gray = new Float64Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
        gray[i] =
            0.299 * imageData.data[i * 4] +
            0.587 * imageData.data[i * 4 + 1] +
            0.114 * imageData.data[i * 4 + 2];
    }
    return _hashFromGray(gray, SIZE, 8);
}

// Count differing bits between two 16-char hex hash strings.
function hammingDistance(hex1, hex2) {
    try {
        let xor = BigInt('0x' + hex1) ^ BigInt('0x' + hex2);
        let count = 0;
        while (xor > 0n) {
            if (xor & 1n) count++;
            xor >>= 1n;
        }
        return count;
    } catch {
        return Infinity;
    }
}

// Match thresholds (bits of Hamming distance).
//  64-bit  pHash: ≤ 9 of 64  ≈ 85.9% similar (legacy entries without phash256).
//  256-bit pHash: ≤ 24 of 256 ≈ 90.6% similar (tighter — finer-grained hash).
const MATCH_MAX_DISTANCE_64  = 9;
const MATCH_MAX_DISTANCE_256 = 24;

// Tiered match for a target { sha256, phash64, phash256 } against the DB.
// Strongest tier wins:
//   1. exact sha256        → { status:'verified',  matchType:'exact',  bits:0 }
//   2. 256-bit pHash       → authentic / possibly_modified (matchType:'perceptual256')
//   3. legacy 64-bit pHash → authentic / possibly_modified (matchType:'perceptual64')
// Returns { entry, distance, bits, status, matchType } or null if nothing matches.
// Signature verification is layered on later (background.js); this is hash-only.
function findBestMatch(target, db) {
    if (!db || !Array.isArray(db.entries) || db.entries.length === 0) return null;
    const { sha256, phash64, phash256 } = target;

    // Tier 1 — exact byte-for-byte.
    if (sha256) {
        const exact = db.entries.find(e => e.sha256 && e.sha256 === sha256);
        if (exact) {
            return { entry: exact, distance: 0, bits: 256, status: 'verified', matchType: 'exact' };
        }
    }

    // Tier 2 — 256-bit perceptual (only entries that carry phash256).
    if (phash256) {
        let best = null, bestDist = Infinity;
        for (const e of db.entries) {
            if (!e.phash256) continue;
            const d = hammingDistance(phash256, e.phash256);
            if (d < bestDist) { bestDist = d; best = e; }
        }
        if (best && bestDist <= MATCH_MAX_DISTANCE_256) {
            return {
                entry: best, distance: bestDist, bits: 256,
                status: bestDist === 0 ? 'authentic' : 'possibly_modified',
                matchType: 'perceptual256'
            };
        }
    }

    // Tier 3 — legacy 64-bit perceptual (entries without a 256-bit hash).
    if (phash64) {
        let best = null, bestDist = Infinity;
        for (const e of db.entries) {
            if (!e.phash || e.phash256) continue; // 256-bit entries handled above
            const d = hammingDistance(phash64, e.phash);
            if (d < bestDist) { bestDist = d; best = e; }
        }
        if (best && bestDist <= MATCH_MAX_DISTANCE_64) {
            return {
                entry: best, distance: bestDist, bits: 64,
                status: bestDist === 0 ? 'authentic' : 'possibly_modified',
                matchType: 'perceptual64'
            };
        }
    }

    return null;
}
