/* =====================================================================
 * 13_save.js — Save: serialize / deserialize the whole world to a compact JSON string, localStorage slots.
 * OWNER: Sim+Save agent. API: docs/CONTRACT.md §3 Save.  DOM-free (storage is injectable: Save.storage = {getItem,setItem,removeItem}).
 *
 * Format (version 1) — one JSON object:
 *   { v:1, game:'godsim', savedAt, w, h, seed, tick, rng, nextId, nextLogId,
 *     layers: { tile, elev, res, amt, owner, bld, fire, region? }  each {t:'u8'|'i32', n, e:'raw'|'rle', c:checksum, d:base64},
 *     units/cities/kingdoms/buildings/armies/wars/regions?: { k:[keys], r:[[values...], ...] }   (column-table: keys once, one array per entity),
 *     (stage 2: `region` layer + `regions` table are optional — a stage-1 save without them loads and Regions.afterLoad builds them)
 *     rels:[[key,relation]...], cultures:[...], log:[last 100], eff:{...}, mod:{...}, stats:{...}, perf:{thinkEvery,lod} }
 *  - typed arrays: run-length coded (varint) when that is smaller, then base64 (own encoder, chunked String.fromCharCode, no btoa/atob).
 *  - entities keep the iteration order of their Maps, so a loaded world iterates (and therefore simulates) exactly like the original.
 *  - everything is parsed and validated into local structures first; the live state is only touched after that, and restored from a
 *    backup of the old references if anything goes wrong while applying (load() never leaves a half-loaded game).
 * Storage keys: godsim.v1.<slot> (data) and godsim.v1.<slot>.meta (small header for the load menu: Save.info).
 * ===================================================================== */

const Save = (() => {
  const PREFIX = 'godsim.v1.';
  const SLOTS = ['auto', '1', '2', '3'];
  const LAYER_NAMES = ['tile', 'elev', 'res', 'amt', 'owner', 'bld', 'fire'];
  const LAYER_TYPE = { tile: 'u8', elev: 'u8', res: 'u8', amt: 'u8', owner: 'i32', bld: 'i32', fire: 'u8', region: 'i32' };
  const TABLES = ['units', 'cities', 'kingdoms', 'buildings', 'armies', 'wars'];
  const LOG_KEEP = 100;
  const MAX_DIM = 512;

  let injected = null;
  let clock = () => Date.now();
  let lastError = null;          // last save/load failure (string), for diagnostics
  let lastLoad = null;           // info about the last successful load {repaired:n}
  let compress = true;           // pack slot data (UTF-8 + LZ + 15 bit chars); Save.serialize() itself always returns plain JSON

  // ------------------------------------------------------------------ storage
  function getStorage() {
    if (injected) return injected;
    try { if (typeof window !== 'undefined' && window && window.localStorage) return window.localStorage; } catch (e) { /* blocked (private mode / cookies) */ }
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* none */ }
    return null;
  }
  function keyOf(slot) {
    const s = String(slot === undefined || slot === null ? 'auto' : slot);
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(s)) return null;
    return PREFIX + s;
  }

  // ------------------------------------------------------------------ base64 (own implementation: works in node + Safari, any size)
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const ENC = new Uint8Array(64);
  const DEC = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) { ENC[i] = B64.charCodeAt(i); DEC[ENC[i]] = i; }
  const CHUNK_BYTES = 12288;                                  // multiple of 3; 16384 chars per String.fromCharCode.apply call
  const codeBuf = new Uint16Array(CHUNK_BYTES / 3 * 4);

  function bytesToB64(bytes) {
    const n = bytes.length;
    const parts = [];
    for (let p = 0; p < n; p += CHUNK_BYTES) {
      const end = Math.min(n, p + CHUNK_BYTES);
      let o = 0, i = p;
      for (; i + 2 < end; i += 3) {
        const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        codeBuf[o++] = ENC[v >> 18]; codeBuf[o++] = ENC[(v >> 12) & 63]; codeBuf[o++] = ENC[(v >> 6) & 63]; codeBuf[o++] = ENC[v & 63];
      }
      const rem = end - i;
      if (rem === 1) {
        const v = bytes[i] << 16;
        codeBuf[o++] = ENC[v >> 18]; codeBuf[o++] = ENC[(v >> 12) & 63]; codeBuf[o++] = 61; codeBuf[o++] = 61;
      } else if (rem === 2) {
        const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
        codeBuf[o++] = ENC[v >> 18]; codeBuf[o++] = ENC[(v >> 12) & 63]; codeBuf[o++] = ENC[(v >> 6) & 63]; codeBuf[o++] = 61;
      }
      parts.push(String.fromCharCode.apply(null, o === codeBuf.length ? codeBuf : codeBuf.subarray(0, o)));
    }
    return parts.join('');
  }

  function b64ToBytes(str) {
    if (typeof str !== 'string') throw new Error('base64: not a string');
    const n = str.length;
    if (n % 4 !== 0) throw new Error('base64: bad length');
    let pad = 0;
    if (n > 0 && str.charCodeAt(n - 1) === 61) pad++;
    if (n > 1 && str.charCodeAt(n - 2) === 61) pad++;
    const out = new Uint8Array((n >> 2) * 3 - pad);
    let o = 0;
    const last = n - 4;
    for (let i = 0; i < n; i += 4) {
      const c0 = str.charCodeAt(i), c1 = str.charCodeAt(i + 1), c2 = str.charCodeAt(i + 2), c3 = str.charCodeAt(i + 3);
      const a = c0 < 128 ? DEC[c0] : -1, b = c1 < 128 ? DEC[c1] : -1;
      let c, d;
      if (i === last && pad) {
        c = pad === 2 ? (c2 === 61 ? 0 : -1) : (c2 < 128 ? DEC[c2] : -1);
        d = c3 === 61 ? 0 : -1;
        if (pad === 1 && d < 0) throw new Error('base64: bad padding');
      } else {
        c = c2 < 128 ? DEC[c2] : -1; d = c3 < 128 ? DEC[c3] : -1;
      }
      if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('base64: bad character');
      const v = (a << 18) | (b << 12) | (c << 6) | d;
      out[o++] = v >> 16; out[o++] = (v >> 8) & 255; out[o++] = v & 255;     // writes past the end are ignored by typed arrays
    }
    return out;
  }

  // ------------------------------------------------------------------ typed layers: checksum + varint RLE + base64
  function checksum(arr) {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < arr.length; i++) h = Math.imul(h ^ arr[i], 16777619);
    return h >>> 0;
  }
  function varLen(v) { let n = 1; while (v >= 128) { v = Math.floor(v / 128); n++; } return n; }
  function zig(v) { return ((v << 1) ^ (v >> 31)) >>> 0; }
  function unzig(z) { return (z >>> 1) ^ -(z & 1); }

  function encodeLayer(arr, type) {
    const n = arr.length;
    const i32 = type === 'i32';
    // pass 1: size of the RLE stream
    let rleBytes = 0;
    for (let i = 0; i < n;) {
      const v = arr[i];
      let j = i + 1;
      while (j < n && arr[j] === v) j++;
      rleBytes += (i32 ? varLen(zig(v)) : 1) + varLen(j - i);
      i = j;
    }
    const rawBytes = i32 ? n * 4 : n;
    let bytes, enc;
    if (rleBytes < rawBytes * 0.9) {
      enc = 'rle';
      bytes = new Uint8Array(rleBytes);
      let o = 0;
      for (let i = 0; i < n;) {
        const v = arr[i];
        let j = i + 1;
        while (j < n && arr[j] === v) j++;
        if (i32) { let z = zig(v); while (z >= 128) { bytes[o++] = (z % 128) | 128; z = Math.floor(z / 128); } bytes[o++] = z; } else bytes[o++] = v;
        let c = j - i;
        while (c >= 128) { bytes[o++] = (c % 128) | 128; c = Math.floor(c / 128); }
        bytes[o++] = c;
        i = j;
      }
    } else {
      enc = 'raw';
      if (i32) {
        bytes = new Uint8Array(n * 4);
        for (let i = 0, o = 0; i < n; i++) { const v = arr[i]; bytes[o++] = v & 255; bytes[o++] = (v >> 8) & 255; bytes[o++] = (v >> 16) & 255; bytes[o++] = (v >> 24) & 255; }
      } else bytes = arr;
    }
    return { t: type, n, e: enc, c: checksum(arr), d: bytesToB64(bytes) };
  }

  /** returns a fresh typed array of exactly `expect` elements or throws */
  function decodeLayer(spec, expect, name) {
    if (!spec || typeof spec !== 'object') throw new Error('layer ' + name + ' missing');
    const i32 = spec.t === 'i32';
    if (!i32 && spec.t !== 'u8') throw new Error('layer ' + name + ' bad type');
    if (spec.n !== expect) throw new Error('layer ' + name + ' size mismatch');
    const bytes = b64ToBytes(spec.d);
    const out = i32 ? new Int32Array(expect) : new Uint8Array(expect);
    if (spec.e === 'raw') {
      if (i32) {
        if (bytes.length !== expect * 4) throw new Error('layer ' + name + ' raw length');
        for (let i = 0, o = 0; i < expect; i++, o += 4) out[i] = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
      } else {
        if (bytes.length !== expect) throw new Error('layer ' + name + ' raw length');
        out.set(bytes);
      }
    } else if (spec.e === 'rle') {
      let p = 0, i = 0;
      const nb = bytes.length;
      while (p < nb) {
        let v;
        if (i32) {
          let z = 0, mul = 1, k = 0, b;
          do { if (p >= nb || k++ > 5) throw new Error('layer ' + name + ' rle value'); b = bytes[p++]; z += (b & 127) * mul; mul *= 128; } while (b & 128);
          v = unzig(z);
        } else v = bytes[p++];
        let c = 0, mul = 1, k = 0, b;
        do { if (p >= nb || k++ > 5) throw new Error('layer ' + name + ' rle count'); b = bytes[p++]; c += (b & 127) * mul; mul *= 128; } while (b & 128);
        if (c <= 0 || i + c > expect) throw new Error('layer ' + name + ' rle overflow');
        if (c === 1) out[i] = v; else out.fill(v, i, i + c);
        i += c;
      }
      if (i !== expect) throw new Error('layer ' + name + ' rle underflow');
    } else throw new Error('layer ' + name + ' bad encoding');
    if (checksum(out) !== spec.c) throw new Error('layer ' + name + ' checksum');
    return out;
  }

  // ------------------------------------------------------------------ storage packing: UTF-8 -> LZ4-style block -> 15 bits per UTF-16 char
  // localStorage quotas count characters (Safari: ~2.5M per origin), so the JSON text is squeezed before it is stored:
  // stored = 'GZ1:<rawBytes>:<fnv32 hex>:<payload>', payload chars are 15-bit values offset by 32 (never surrogates / controls).
  const PACK_TAG = 'GZ1:';

  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const n = str.length;
    let size = 0;
    for (let i = 0; i < n; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) size++; else if (c < 0x800) size += 2;
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < n && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { size += 4; i++; } else size += 3;
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (let i = 0; i < n; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out[o++] = c;
      else if (c < 0x800) { out[o++] = 0xc0 | (c >> 6); out[o++] = 0x80 | (c & 63); }
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < n && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        c = 0x10000 + ((c & 0x3ff) << 10) + (str.charCodeAt(++i) & 0x3ff);
        out[o++] = 0xf0 | (c >> 18); out[o++] = 0x80 | ((c >> 12) & 63); out[o++] = 0x80 | ((c >> 6) & 63); out[o++] = 0x80 | (c & 63);
      } else { out[o++] = 0xe0 | (c >> 12); out[o++] = 0x80 | ((c >> 6) & 63); out[o++] = 0x80 | (c & 63); }
    }
    return out;
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parts = [];
    const n = bytes.length;
    let buf = [];
    for (let i = 0; i < n;) {
      const b = bytes[i++];
      let c;
      if (b < 0x80) c = b;
      else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
      else if (b < 0xf0) { c = ((b & 15) << 12) | ((bytes[i] & 63) << 6) | (bytes[i + 1] & 63); i += 2; }
      else { c = ((b & 7) << 18) | ((bytes[i] & 63) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
      if (c >= 0x10000) { c -= 0x10000; buf.push(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff)); } else buf.push(c);
      if (buf.length >= 8000) { parts.push(String.fromCharCode.apply(null, buf)); buf = []; }
    }
    if (buf.length) parts.push(String.fromCharCode.apply(null, buf));
    return parts.join('');
  }

  const LZ_HASH_BITS = 16, LZ_MIN = 4, LZ_WINDOW = 65535;
  /** LZ4 block format (greedy, single-candidate hash table). Returns a Uint8Array. */
  function lzCompress(src) {
    const n = src.length;
    const out = new Uint8Array(n + (n >> 8) + 32);
    const table = new Int32Array(1 << LZ_HASH_BITS).fill(-1);
    let o = 0, anchor = 0, i = 0;
    const limit = n - 8;                                    // last bytes are always literals
    while (i < limit) {
      const v = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);
      const h = Math.imul(v, 2654435761) >>> (32 - LZ_HASH_BITS);
      const cand = table[h];
      table[h] = i;
      if (cand >= 0 && i - cand <= LZ_WINDOW && (src[cand] | (src[cand + 1] << 8) | (src[cand + 2] << 16) | (src[cand + 3] << 24)) === v) {
        let len = LZ_MIN;
        const maxLen = n - 5 - i;
        while (len < maxLen && src[cand + len] === src[i + len]) len++;
        // token
        const lit = i - anchor, ml = len - LZ_MIN;
        out[o++] = ((lit < 15 ? lit : 15) << 4) | (ml < 15 ? ml : 15);
        if (lit >= 15) { let r = lit - 15; while (r >= 255) { out[o++] = 255; r -= 255; } out[o++] = r; }
        out.set(src.subarray(anchor, i), o); o += lit;
        const off = i - cand;
        out[o++] = off & 255; out[o++] = off >> 8;
        if (ml >= 15) { let r = ml - 15; while (r >= 255) { out[o++] = 255; r -= 255; } out[o++] = r; }
        // index a couple of positions inside the match so following repeats are found
        const end = i + len;
        if (end < limit) { for (let j = i + 1; j < end && j < limit; j += 2) { table[Math.imul(src[j] | (src[j + 1] << 8) | (src[j + 2] << 16) | (src[j + 3] << 24), 2654435761) >>> (32 - LZ_HASH_BITS)] = j; } }
        i = end; anchor = i;
      } else i++;
    }
    const lit = n - anchor;
    out[o++] = (lit < 15 ? lit : 15) << 4;
    if (lit >= 15) { let r = lit - 15; while (r >= 255) { out[o++] = 255; r -= 255; } out[o++] = r; }
    out.set(src.subarray(anchor, n), o); o += lit;
    return out.subarray(0, o);
  }
  function lzDecompress(src, rawLen) {
    const out = new Uint8Array(rawLen);
    const n = src.length;
    let p = 0, o = 0;
    while (p < n) {
      const tok = src[p++];
      let lit = tok >> 4;
      if (lit === 15) { let b; do { if (p >= n) throw new Error('lz: truncated'); b = src[p++]; lit += b; } while (b === 255); }
      if (p + lit > n || o + lit > rawLen) throw new Error('lz: literal overflow');
      out.set(src.subarray(p, p + lit), o); p += lit; o += lit;
      if (p >= n) break;
      if (p + 2 > n) throw new Error('lz: truncated');
      const off = src[p] | (src[p + 1] << 8); p += 2;
      let ml = tok & 15;
      if (ml === 15) { let b; do { if (p >= n) throw new Error('lz: truncated'); b = src[p++]; ml += b; } while (b === 255); }
      ml += LZ_MIN;
      if (off === 0 || off > o || o + ml > rawLen) throw new Error('lz: bad match');
      for (let k = 0, s = o - off; k < ml; k++) out[o++] = out[s++];
    }
    if (o !== rawLen) throw new Error('lz: length mismatch');
    return out;
  }

  function bytesTo15(bytes) {
    const n = bytes.length;
    const parts = [];
    const buf = new Uint16Array(8192);
    let bi = 0, acc = 0, bits = 0;
    for (let i = 0; i < n; i++) {
      acc = (acc << 8) | bytes[i]; bits += 8;
      if (bits >= 15) {
        bits -= 15;
        buf[bi++] = ((acc >> bits) & 0x7fff) + 32;
        acc &= (1 << bits) - 1;
        if (bi === 8192) { parts.push(String.fromCharCode.apply(null, buf)); bi = 0; }
      }
    }
    if (bits > 0) buf[bi++] = ((acc << (15 - bits)) & 0x7fff) + 32;
    if (bi) parts.push(String.fromCharCode.apply(null, bi === 8192 ? buf : buf.subarray(0, bi)));
    return parts.join('');
  }
  function bytesFrom15(str, from, outLen) {
    const out = new Uint8Array(outLen);
    const n = str.length;
    let o = 0, acc = 0, bits = 0;
    for (let i = from; i < n && o < outLen; i++) {
      const v = str.charCodeAt(i) - 32;
      if (v < 0 || v > 0x7fff) throw new Error('pack: bad character');
      acc = (acc << 15) | v; bits += 15;
      while (bits >= 8 && o < outLen) { bits -= 8; out[o++] = (acc >> bits) & 255; }
      acc &= (1 << bits) - 1;
    }
    if (o !== outLen) throw new Error('pack: truncated');
    return out;
  }

  /** JSON text -> compact storage string */
  function pack(json) {
    const raw = utf8Encode(json);
    const lz = lzCompress(raw);
    return PACK_TAG + lz.length + ':' + raw.length + ':' + checksum(raw).toString(36) + ':' + bytesTo15(lz);
  }
  /** storage string (packed or plain JSON) -> JSON text; throws on any damage */
  function unpack(str) {
    if (typeof str !== 'string') throw new Error('not a string');
    if (str.charCodeAt(0) === 123) return str;                                      // '{' plain JSON
    if (!str.startsWith(PACK_TAG)) throw new Error('unknown format');
    const a = str.indexOf(':', 4), b = str.indexOf(':', a + 1), c = str.indexOf(':', b + 1);
    if (a < 0 || b < 0 || c < 0) throw new Error('pack: bad header');
    const lzLen = parseInt(str.slice(4, a), 10), rawLen = parseInt(str.slice(a + 1, b), 10);
    const sum = parseInt(str.slice(b + 1, c), 36);
    if (!(lzLen > 0) || !(rawLen > 0) || rawLen > 64 * 1024 * 1024 || lzLen > rawLen + (rawLen >> 6) + 64 || rawLen > lzLen * 260) throw new Error('pack: bad sizes');
    if (str.length - (c + 1) !== Math.ceil(lzLen * 8 / 15)) throw new Error('pack: bad payload length');
    const lz = bytesFrom15(str, c + 1, lzLen);
    const raw = lzDecompress(lz, rawLen);
    if (checksum(raw) !== sum) throw new Error('pack: checksum');
    return utf8Decode(raw);
  }

  // ------------------------------------------------------------------ entity tables (keys once, rows as arrays)
  const MISSING = { $u: 1 };            // value of a key that an entity does not have (null is a legal value)
  const BAD_KEYS = Object.create(null);
  BAD_KEYS['__proto__'] = 1; BAD_KEYS['constructor'] = 1; BAD_KEYS['prototype'] = 1;

  function packTable(list) {
    const keys = [], idx = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      for (const k in e) if (idx[k] === undefined) { idx[k] = keys.length; keys.push(k); }
    }
    let ragged = false;
    const rows = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const row = new Array(keys.length);
      for (let j = 0; j < keys.length; j++) { const v = e[keys[j]]; if (v === undefined) { row[j] = MISSING; ragged = true; } else row[j] = v; }
      rows[i] = row;
    }
    const t = { k: keys, r: rows };
    if (ragged) t.m = 1;
    return t;
  }
  const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  /**
   * Entities must be rebuilt as OBJECT LITERALS: objects grown key by key with `o[key] = v` (45+ properties) fall into V8's dictionary mode
   * and made Units.step 3.5x slower after a load. A generated literal gives them fast in-object properties like freshly spawned units.
   */
  function makeBuilder(keys) {
    try {
      let src = 'return function(r){return {';
      for (let j = 0; j < keys.length; j++) {
        if (!IDENT.test(keys[j])) return null;
        src += (j ? ',' : '') + keys[j] + ':r[' + j + ']';
      }
      src += '};}';
      return new Function(src)();
    } catch (e) { return null; }
  }
  function unpackTable(tbl, name) {
    if (!tbl || !Array.isArray(tbl.k) || !Array.isArray(tbl.r)) throw new Error('table ' + name + ' malformed');
    const keys = tbl.k, nk = keys.length;
    const seen = Object.create(null);
    for (let j = 0; j < nk; j++) {
      const key = keys[j];
      if (typeof key !== 'string' || BAD_KEYS[key] === 1 || seen[key] === 1) throw new Error('table ' + name + ' bad key');
      seen[key] = 1;
    }
    const rows = tbl.r;
    const out = new Array(rows.length);
    const build = tbl.m ? null : makeBuilder(keys);
    for (let i = 0; i < out.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || row.length !== nk) throw new Error('table ' + name + ' bad row');
      if (build) { out[i] = build(row); continue; }
      const e = {};
      for (let j = 0; j < nk; j++) {
        const v = row[j];
        if (v !== null && typeof v === 'object' && v.$u === 1 && !Array.isArray(v)) continue;
        e[keys[j]] = v;
      }
      out[i] = e;
    }
    return out;
  }

  // ------------------------------------------------------------------ serialize
  function finite(v) { return typeof v === 'number' && isFinite(v); }

  function unitsForSave(opts) {
    const out = [];
    let skipped = 0;
    for (const u of S.units.values()) {
      if (!finite(u.x) || !finite(u.y) || !finite(u.id)) { skipped++; continue; }    // never write a unit that could not be loaded again
      if (opts.stripPaths && u.st && u.st.path) {
        const st = Object.assign({}, u.st);
        delete st.path; delete st.pi; delete st.pgx; delete st.pgy;
        out.push(Object.assign({}, u, { st }));
      } else out.push(u);
    }
    if (skipped && typeof console !== 'undefined' && console.warn) console.warn('[Save] skipped ' + skipped + ' unit(s) with invalid position');
    return out;
  }

  function popTotals() {
    const pop = [0, 0, 0];
    for (const u of S.units.values()) if (u.race >= 0 && u.race < 3) pop[u.race]++;
    return pop;
  }

  function makeMeta(bytes) {
    const pop = popTotals();
    let kingdoms = 0;
    for (const k of S.kingdoms.values()) if (k.alive !== false) kingdoms++;
    return { v: Const.SAVE_VERSION, savedAt: clock(), year: Util.year(), tick: S.tick, pop: pop[0] + pop[1] + pop[2], popRace: pop, kingdoms, cities: S.cities.size, w: S.w, h: S.h, seed: S.seed, bytes: bytes | 0 };
  }

  /** whole world -> JSON string. opts: {stripPaths:false, savedAt} */
  function serialize(opts) {
    opts = opts || {};
    if (!S.tile || !S.w || !S.h) throw new Error('no world');
    try { Sim.stats(); } catch (e) { /* stats are only a cache */ }
    const layers = {};
    for (const name of LAYER_NAMES) layers[name] = encodeLayer(S[name], LAYER_TYPE[name]);
    const hasRegions = !!(S.region && S.region.length === S.w * S.h && S.regions);
    if (hasRegions) layers.region = encodeLayer(S.region, LAYER_TYPE.region);
    const data = {
      v: Const.SAVE_VERSION, game: 'godsim', savedAt: opts.savedAt !== undefined ? opts.savedAt : clock(),
      w: S.w, h: S.h, seed: S.seed, tick: S.tick, rng: R.getState(), nextId: S.nextId, nextLogId: S.nextLogId,
      layers,
      units: packTable(unitsForSave(opts)),
      cities: packTable(Array.from(S.cities.values())),
      kingdoms: packTable(Array.from(S.kingdoms.values())),
      buildings: packTable(Array.from(S.buildings.values())),
      armies: packTable(Array.from(S.armies.values())),
      wars: packTable(Array.from(S.wars.values())),
      regions: hasRegions ? packTable(Array.from(S.regions.values())) : undefined,
      rels: Array.from(S.rels.entries()),
      cultures: S.cultures,
      log: S.log.length > LOG_KEEP ? S.log.slice(S.log.length - LOG_KEEP) : S.log,
      eff: S.eff, mod: S.mod, stats: S.stats,
      perf: { thinkEvery: S.perf.thinkEvery, lod: S.perf.lod },
    };
    return JSON.stringify(data);
  }

  // ------------------------------------------------------------------ validation (everything is checked / repaired BEFORE the live state is touched)
  function fail(msg) { throw new Error(msg); }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function num(v, d) { return finite(v) ? v : d; }

  function validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('not an object');
    if (data.game !== 'godsim') fail('not a godsim save');
    if (data.v !== Const.SAVE_VERSION) fail('unsupported version ' + data.v);
    const w = data.w, h = data.h;
    if (!isInt(w) || !isInt(h) || w < 16 || h < 16 || w > MAX_DIM || h > MAX_DIM) fail('bad world size');
    if (!isInt(data.seed) || !isInt(data.tick) || data.tick < 0 || !isInt(data.rng)) fail('bad header');
    if (!isInt(data.nextId) || data.nextId < 1 || !isInt(data.nextLogId) || data.nextLogId < 1) fail('bad counters');
    const n = w * h;
    const out = { w, h, seed: data.seed, tick: data.tick, rng: data.rng | 0, nextId: data.nextId, nextLogId: data.nextLogId, repaired: 0 };

    // layers
    if (!data.layers || typeof data.layers !== 'object') fail('layers missing');
    out.layers = {};
    for (const name of LAYER_NAMES) out.layers[name] = decodeLayer(data.layers[name], n, name);
    // stage 2 (optional): region layer + table. Both or none; a stage-1 save has neither and Regions.afterLoad builds them.
    out.regions = null; out.layers.region = null;
    if (data.layers.region && data.regions) {
      const rlayer = decodeLayer(data.layers.region, n, 'region');
      const rtab = unpackTable(data.regions, 'regions');
      const rseen = new Set();
      for (const r of rtab) {
        if (!isInt(r.id) || r.id < 1 || rseen.has(r.id)) fail('region bad id');
        rseen.add(r.id);
        if (!Array.isArray(r.cityIds)) r.cityIds = [];
        if (!Array.isArray(r.nb)) r.nb = [];
        if (!Array.isArray(r.fd)) r.fd = [];
        if (!Array.isArray(r.claims)) r.claims = [];
        if (!Array.isArray(r.cores)) r.cores = [];
        if (!r.terrain || typeof r.terrain !== 'object' || Array.isArray(r.terrain)) r.terrain = { forest: 0, hill: 0, mountain: 0, sand: 0, snow: 0 };
        r.ownerId = isInt(r.ownerId) ? r.ownerId : 0; r.controllerId = isInt(r.controllerId) ? r.controllerId : 0;
        r.cx = num(r.cx, 0); r.cy = num(r.cy, 0); r.tiles = num(r.tiles, 0); r.value = num(r.value, 0);
        r.since = num(r.since, 0); r.occSince = num(r.occSince, 0);
        if (typeof r.name !== 'string') r.name = 'Регион ' + r.id;
      }
      let bad = 0;
      for (let i = 0; i < n; i++) if (rlayer[i] !== 0 && !rseen.has(rlayer[i])) { rlayer[i] = 0; bad++; }
      out.repaired += bad;
      out.layers.region = rlayer; out.regions = rtab;
    }
    const tile = out.layers.tile, res = out.layers.res;
    for (let i = 0; i < n; i++) { if (tile[i] >= Const.TILE_COUNT) fail('bad tile id'); if (res[i] > 6) fail('bad resource id'); }

    // entity tables
    const tables = {};
    for (const name of TABLES) tables[name] = unpackTable(data[name], name);
    const seen = new Set();
    let maxId = 0;
    const checkId = (e, what) => {
      if (!isInt(e.id) || e.id < 1) fail(what + ' bad id');
      if (seen.has(e.id)) fail(what + ' duplicate id ' + e.id);
      seen.add(e.id);
      if (e.id > maxId) maxId = e.id;
    };

    const nRace = Const.RACE_COUNT, nTrait = Traits.list.length;
    const stateOk = {};
    for (const s of Const.STATES) stateOk[s] = true;
    for (const u of tables.units) {
      checkId(u, 'unit');
      if (!isInt(u.race) || u.race < 0 || u.race >= nRace) fail('unit bad race');
      if (u.sex !== 0 && u.sex !== 1) fail('unit bad sex');
      if (!finite(u.x) || !finite(u.y)) fail('unit bad position');
      if (u.x < 0) u.x = 0; else if (u.x > w - 0.001) u.x = w - 0.001;
      if (u.y < 0) u.y = 0; else if (u.y > h - 0.001) u.y = h - 0.001;
      u.px = num(u.px, u.x); u.py = num(u.py, u.y);
      if (!finite(u.born)) { u.born = data.tick - 20 * Const.TICKS_PER_YEAR; out.repaired++; }
      if (!finite(u.maxHp) || u.maxHp <= 0) { u.maxHp = 20; out.repaired++; }
      if (!finite(u.hp)) { u.hp = u.maxHp; out.repaired++; }
      u.hunger = num(u.hunger, 0); u.energy = num(u.energy, 100);
      if (!isInt(u.level) || u.level < 1) u.level = 1;
      u.xp = num(u.xp, 0); u.kills = num(u.kills, 0);
      u.nextThink = num(u.nextThink, 0); u.birthCd = num(u.birthCd, 0);
      u.sick = num(u.sick, 0); u.buffUntil = num(u.buffUntil, 0); u.burning = num(u.burning, 0);
      if (typeof u.state !== 'string' || !stateOk[u.state]) { u.state = 'idle'; u.st = {}; u.job = null; out.repaired++; }
      if (!u.st || typeof u.st !== 'object' || Array.isArray(u.st)) u.st = {};
      if (!Array.isArray(u.traits)) u.traits = [];
      else { const tr = u.traits.filter(t => isInt(t) && t >= 0 && t < nTrait); if (tr.length !== u.traits.length) { u.traits = tr; out.repaired++; } }
      if (u.hist !== undefined && !Array.isArray(u.hist)) u.hist = [];
      u.weapon = isInt(u.weapon) && u.weapon >= 0 && u.weapon <= 3 ? u.weapon : 0;
      u.armor = isInt(u.armor) && u.armor >= 0 && u.armor <= 3 ? u.armor : 0;
    }
    for (const c of tables.cities) {
      checkId(c, 'city');
      if (!isInt(c.race) || c.race < 0 || c.race >= nRace) fail('city bad race');
      if (!isInt(c.x) || !isInt(c.y) || c.x < 0 || c.y < 0 || c.x >= w || c.y >= h) fail('city bad position');
      if (!Array.isArray(c.members)) fail('city bad members');
      if (!Array.isArray(c.buildings)) fail('city bad buildings');
      if (!c.stock || typeof c.stock !== 'object' || Array.isArray(c.stock)) fail('city bad stock');
      for (const g of Const.GOODS) c.stock[g] = num(c.stock[g], 0);
      if (!finite(c.radius) || c.radius < 1) c.radius = 6;
      if (!isInt(c.level) || c.level < 1) c.level = 1;
      if (!finite(c.pop)) c.pop = c.members.length;
      if (!c.mod || typeof c.mod !== 'object') c.mod = {};
      if (!Array.isArray(c.hist)) c.hist = [];
    }
    for (const k of tables.kingdoms) {
      checkId(k, 'kingdom');
      if (!Array.isArray(k.cities)) fail('kingdom bad cities');
      if (typeof k.color !== 'string') { k.color = '#888888'; out.repaired++; }
      if (!k.flag || typeof k.flag !== 'object' || Array.isArray(k.flag)) { k.flag = { pattern: 0, symbol: 0, c1: k.color, c2: '#ffffff', c3: '#222222' }; out.repaired++; }
      if (!isInt(k.race) || k.race < 0 || k.race >= nRace) { k.race = 0; out.repaired++; }
      if (!Array.isArray(k.hist)) k.hist = [];
    }
    for (const b of tables.buildings) {
      checkId(b, 'building');
      if (!isInt(b.type) || Const.BUILDING_TYPES.indexOf(b.type) < 0) fail('building bad type');
      if (!isInt(b.x) || !isInt(b.y) || b.x < 0 || b.y < 0 || b.x >= w || b.y >= h) fail('building bad position');
      if (!b.data || typeof b.data !== 'object') b.data = {};
    }
    for (const a of tables.armies) { checkId(a, 'army'); if (!Array.isArray(a.members)) fail('army bad members'); }
    for (const wr of tables.wars) { checkId(wr, 'war'); if (!Array.isArray(wr.attackers) || !Array.isArray(wr.defenders)) fail('war bad sides'); }
    if (maxId >= out.nextId) out.nextId = maxId + 1;       // never hand out an id that is already in use

    // references from the terrain layers: only existing cities / buildings (derived data, safe to repair)
    const cityIds = new Set(tables.cities.map(c => c.id)), bldIds = new Set(tables.buildings.map(b => b.id));
    const owner = out.layers.owner, bld = out.layers.bld;
    for (let i = 0; i < n; i++) {
      if (owner[i] !== 0 && !cityIds.has(owner[i])) { owner[i] = 0; out.repaired++; }
      if (bld[i] !== 0 && !bldIds.has(bld[i])) { bld[i] = 0; out.repaired++; }
    }
    // units that point to a city that does not exist are homeless
    for (const u of tables.units) {
      if (u.cityId && !cityIds.has(u.cityId)) { u.cityId = 0; u.kingdomId = 0; out.repaired++; }
    }

    // rels
    if (!Array.isArray(data.rels)) fail('rels malformed');
    out.rels = [];
    for (const e of data.rels) {
      if (!Array.isArray(e) || e.length !== 2 || (typeof e[0] !== 'string' && typeof e[0] !== 'number') || !e[1] || typeof e[1] !== 'object') fail('rel malformed');
      out.rels.push(e);
    }
    out.cultures = Array.isArray(data.cultures) ? data.cultures : fail('cultures malformed');
    out.log = Array.isArray(data.log) ? data.log.filter(e => e && typeof e === 'object' && typeof e.msg === 'string') : [];
    const eff = data.eff && typeof data.eff === 'object' ? data.eff : {};
    out.eff = {
      meteors: Array.isArray(eff.meteors) ? eff.meteors : [], tornados: Array.isArray(eff.tornados) ? eff.tornados : [],
      rains: Array.isArray(eff.rains) ? eff.rains : [], quakes: Array.isArray(eff.quakes) ? eff.quakes : [],
    };
    for (const k of Object.keys(eff)) if (out.eff[k] === undefined && Array.isArray(eff[k])) out.eff[k] = eff[k].filter(e => e && typeof e === 'object');   // plugin powers keep their persistent effects in S.eff.<name> (CONTRACT section 10)
    out.mod = data.mod && typeof data.mod === 'object' && !Array.isArray(data.mod) ? data.mod : {};
    const st = data.stats && typeof data.stats === 'object' ? data.stats : {};
    out.stats = Object.assign({ year: Const.START_YEAR, pop: [0, 0, 0], popTotal: 0, kingdoms: 0, cities: 0, wars: 0, buildings: 0 }, st);
    if (!Array.isArray(out.stats.pop) || out.stats.pop.length !== nRace) out.stats.pop = [0, 0, 0];
    const pf = data.perf && typeof data.perf === 'object' ? data.perf : {};
    out.thinkEvery = isInt(pf.thinkEvery) && pf.thinkEvery >= 1 && pf.thinkEvery <= 12 ? pf.thinkEvery : 3;
    out.lod = isInt(pf.lod) && pf.lod >= 0 && pf.lod <= 3 ? pf.lod : 0;
    out.tables = tables;
    return out;
  }

  // ------------------------------------------------------------------ apply with rollback
  const SNAP_KEYS = ['w', 'h', 'seed', 'tick', 'tile', 'elev', 'res', 'amt', 'owner', 'bld', 'fire', 'dirty', 'dirtyList', 'allDirty', 'ownerVer', 'landDirty',
    'units', 'cities', 'kingdoms', 'buildings', 'armies', 'wars', 'rels', 'cultures', 'nextId', 'nextLogId', 'log', 'eff', 'mod', 'stats', 'perf',
    'region', 'regions', 'regionVer'];

  function snapshot() {
    const snap = { rng: R.getState(), fx: Fx.list.slice(), perfCopy: Object.assign({}, S.perf) };
    for (const k of SNAP_KEYS) snap[k] = S[k];
    return snap;
  }
  function restore(snap) {
    for (const k of SNAP_KEYS) S[k] = snap[k];
    Object.assign(S.perf, snap.perfCopy);
    R.setState(snap.rng);
    Fx.list.length = 0;
    for (let i = 0; i < snap.fx.length; i++) Fx.list.push(snap.fx[i]);
  }

  function apply(v) {
    S.reset(v.w, v.h, v.seed);
    S.tick = v.tick;
    for (const name of LAYER_NAMES) S[name] = v.layers[name];
    if (v.layers.region && v.regions) { S.region = v.layers.region; for (const r of v.regions) S.regions.set(r.id, r); }
    const T = v.tables;
    for (const u of T.units) S.units.set(u.id, u);
    for (const c of T.cities) S.cities.set(c.id, c);
    for (const k of T.kingdoms) S.kingdoms.set(k.id, k);
    for (const b of T.buildings) S.buildings.set(b.id, b);
    for (const a of T.armies) S.armies.set(a.id, a);
    for (const wr of T.wars) S.wars.set(wr.id, wr);
    for (const e of v.rels) S.rels.set(e[0], e[1]);
    S.cultures = v.cultures;
    S.nextId = v.nextId; S.nextLogId = v.nextLogId;
    S.log = v.log;
    S.eff = v.eff; S.mod = v.mod; S.stats = v.stats;
    S.perf.thinkEvery = v.thinkEvery; S.perf.lod = v.lod;
    S.allDirty = true; S.landDirty = true; S.ownerVer = 1; S.regionVer = 1;
    R.setState(v.rng);
    Sim.afterLoad();
    S.perf.thinkEvery = v.thinkEvery; S.perf.lod = v.lod;      // afterLoad resets the adaptive perf state; the saved hint is what the original run used
    R.setState(v.rng);                                         // module afterLoad hooks must not shift the random stream
  }

  function deserialize(str) {
    lastError = null; lastLoad = null;
    let v;
    try {
      if (typeof str !== 'string' || str.length < 20) fail('empty save');
      let json;
      try { json = unpack(str); } catch (e) { fail('damaged data (' + (e && e.message ? e.message : e) + ')'); }
      let data;
      try { data = JSON.parse(json); } catch (e) { fail('invalid JSON'); }
      v = validate(data);
    } catch (e) {
      lastError = 'invalid save: ' + (e && e.message ? e.message : e);
      return false;
    }
    const snap = snapshot();
    try {
      apply(v);
    } catch (e) {
      lastError = 'apply failed: ' + (e && e.message ? e.message : e);
      try {
        restore(snap);
        Sim.afterLoad();
        Object.assign(S.perf, snap.perfCopy);
        R.setState(snap.rng);
      } catch (e2) { /* nothing more we can do */ }
      return false;
    }
    lastLoad = { repaired: v.repaired, units: S.units.size };
    return true;
  }

  // ------------------------------------------------------------------ slots
  function save(slot) {
    lastError = null;
    const st = getStorage(), key = keyOf(slot);
    if (!st || !key) { lastError = !st ? 'no storage' : 'bad slot'; return false; }
    let str;
    try { str = serialize(); if (compress) str = pack(str); } catch (e) { lastError = 'serialize failed: ' + (e && e.message ? e.message : e); if (typeof console !== 'undefined' && !(e && e.message === 'no world')) console.error('[Save]', e); return false; }
    try { st.setItem(key, str); } catch (e) { lastError = 'storage: ' + (e && e.name ? e.name : e); return false; }
    try { st.setItem(key + '.meta', JSON.stringify(makeMeta(str.length))); } catch (e) { try { st.removeItem(key + '.meta'); } catch (e2) { /* ignore */ } }
    return true;
  }

  function load(slot) {
    lastError = null;
    const st = getStorage(), key = keyOf(slot);
    if (!st || !key) { lastError = !st ? 'no storage' : 'bad slot'; return false; }
    let str = null;
    try { str = st.getItem(key); } catch (e) { lastError = 'storage: ' + (e && e.name ? e.name : e); return false; }
    if (str === null || str === undefined) { lastError = 'empty slot'; return false; }
    return deserialize(str);
  }

  function exists(slot) {
    const st = getStorage(), key = keyOf(slot);
    if (!st || !key) return false;
    try { return st.getItem(key) !== null; } catch (e) { return false; }
  }

  function info(slot) {
    const st = getStorage(), key = keyOf(slot);
    if (!st || !key) return null;
    try {
      const m = st.getItem(key + '.meta');
      if (m) {
        let o = null;
        try { o = JSON.parse(m); } catch (e) { o = null; }
        if (o && typeof o === 'object' && finite(o.year) && finite(o.pop)) return o;
      }
      // meta missing / damaged: rebuild from the data once (rare)
      const d = st.getItem(key);
      if (d === null || d === undefined) return null;
      const data = JSON.parse(unpack(d));
      if (!data || data.game !== 'godsim' || data.v !== Const.SAVE_VERSION) return null;
      const pop = [0, 0, 0];
      const tbl = data.units;
      let ri = tbl && tbl.k ? tbl.k.indexOf('race') : -1;
      if (ri >= 0) for (const row of tbl.r) { const r = row[ri]; if (r >= 0 && r < 3) pop[r]++; }
      const meta = {
        v: data.v, savedAt: finite(data.savedAt) ? data.savedAt : 0, year: Const.START_YEAR + Math.floor(data.tick / Const.TICKS_PER_YEAR), tick: data.tick,
        pop: pop[0] + pop[1] + pop[2], popRace: pop, kingdoms: data.kingdoms && data.kingdoms.r ? data.kingdoms.r.length : 0,
        cities: data.cities && data.cities.r ? data.cities.r.length : 0, w: data.w, h: data.h, seed: data.seed, bytes: d.length,
      };
      try { st.setItem(key + '.meta', JSON.stringify(meta)); } catch (e) { /* ignore */ }
      return meta;
    } catch (e) { return null; }
  }

  function remove(slot) {
    const st = getStorage(), key = keyOf(slot);
    if (!st || !key) return false;
    try { st.removeItem(key); st.removeItem(key + '.meta'); return true; } catch (e) { return false; }
  }

  return {
    save, load, exists, info, remove, serialize, deserialize,
    get storage() { return getStorage(); },
    set storage(s) { injected = s || null; },
    // extras
    slots: SLOTS,
    get lastError() { return lastError; },
    get lastLoad() { return lastLoad; },
    get compress() { return compress; },
    set compress(v) { compress = !!v; },
    pack, unpack, lzCompress, lzDecompress,
    set clock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); },
    get clock() { return clock; },
    bytesToB64, b64ToBytes, encodeLayer, decodeLayer, packTable, unpackTable,
  };
})();
