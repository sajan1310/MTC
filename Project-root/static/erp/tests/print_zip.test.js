'use strict';
// Byte-level checks on App.Print.zipStore, the store-only ZIP writer used by
// the bulk-export "zip" delivery mode.
//
// A hand-written container format is only worth having if it is actually
// well-formed, so these assert the real structure -- signatures, CRC-32,
// sizes, the central directory and its offsets -- rather than round-tripping
// through the same code that wrote it. The authoritative cross-check is in
// the Playwright run, which opens the output with Python's zipfile module.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextEncoder } = require('node:util');
const { Blob } = require('node:buffer');
const zlib = require('zlib');

function loadPrintModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'print.js'), 'utf8');
  const sandbox = {
    App: { Utils: { showToast: () => {} } },
    document, window, console, setTimeout, Blob, TextEncoder, URL,
    // the test realm's Date, so jest fake timers apply inside the sandbox
    Date,
    requestAnimationFrame: cb => setTimeout(cb, 0),
    loadScript: () => Promise.resolve(),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.App.Print;
}

let Print;
beforeEach(() => {
  Print = loadPrintModule();
});

async function zipBytes(files) {
  const blob = await Print.zipStore(files);
  return Buffer.from(await blob.arrayBuffer());
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

describe('CRC-32', () => {
  // zlib.crc32 is the reference implementation; ours must agree exactly.
  // Byte values are written as escapes rather than literals so this source
  // file stays plain ASCII -- an embedded NUL makes Git treat the whole file
  // as binary and stop producing reviewable diffs.
  it('matches zlib for known inputs', () => {
    if (!zlib.crc32) return; // older node without zlib.crc32
    const cases = [
      '',
      'a',
      'hello world',
      'The quick brown fox',
      String.fromCharCode(0, 255, 127, 128), // boundary bytes, incl. NUL
      'PO_2026-0417_GuptaCycleIndustries.pdf',
    ];
    for (const s of cases) {
      const buf = Buffer.from(s, 'binary');
      expect(Print._crc32(new Uint8Array(buf))).toBe(zlib.crc32(buf) >>> 0);
    }
  });

  it('agrees with zlib on a large binary-ish payload', () => {
    if (!zlib.crc32) return;
    const buf = Buffer.alloc(50000);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 0xff;
    expect(Print._crc32(new Uint8Array(buf))).toBe(zlib.crc32(buf) >>> 0);
  });

  it('returns 0 for empty input', () => {
    expect(Print._crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('zipStore structure', () => {
  it('starts with a local file header signature', async () => {
    const buf = await zipBytes([{ name: 'a.pdf', blob: new Blob(['hello']) }]);
    expect(buf.readUInt32LE(0)).toBe(LOCAL);
  });

  it('ends with an end-of-central-directory record', async () => {
    const buf = await zipBytes([{ name: 'a.pdf', blob: new Blob(['hello']) }]);
    expect(buf.readUInt32LE(buf.length - 22)).toBe(EOCD);
  });

  it('records the entry count in both EOCD fields', async () => {
    const buf = await zipBytes([
      { name: 'a.pdf', blob: new Blob(['a']) },
      { name: 'b.pdf', blob: new Blob(['bb']) },
      { name: 'c.pdf', blob: new Blob(['ccc']) },
    ]);
    const eocd = buf.length - 22;
    expect(buf.readUInt16LE(eocd + 8)).toBe(3);
    expect(buf.readUInt16LE(eocd + 10)).toBe(3);
  });

  it('points the EOCD at a real central directory', async () => {
    const buf = await zipBytes([{ name: 'a.pdf', blob: new Blob(['hello']) }]);
    const eocd = buf.length - 22;
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const cdSize = buf.readUInt32LE(eocd + 12);
    expect(buf.readUInt32LE(cdOffset)).toBe(CENTRAL);
    expect(cdOffset + cdSize).toBe(eocd);
  });

  it('stores rather than compresses, with matching sizes and CRC', async () => {
    const body = 'some pdf bytes here';
    const buf = await zipBytes([{ name: 'a.pdf', blob: new Blob([body]) }]);
    expect(buf.readUInt16LE(8)).toBe(0); // method 0 = stored
    expect(buf.readUInt32LE(18)).toBe(body.length); // compressed size
    expect(buf.readUInt32LE(22)).toBe(body.length); // uncompressed size
    const expectedCrc = Print._crc32(new Uint8Array(Buffer.from(body)));
    expect(buf.readUInt32LE(14)).toBe(expectedCrc);
  });

  it('writes the payload verbatim after the header and name', async () => {
    const body = 'PDF-1.7 payload';
    const name = 'PO_1_Acme.pdf';
    const buf = await zipBytes([{ name, blob: new Blob([body]) }]);
    const nameLen = buf.readUInt16LE(26);
    expect(nameLen).toBe(Buffer.byteLength(name));
    expect(buf.slice(30, 30 + nameLen).toString()).toBe(name);
    expect(buf.slice(30 + nameLen, 30 + nameLen + body.length).toString()).toBe(body);
  });

  it('sets the UTF-8 flag so non-ASCII names survive', async () => {
    const buf = await zipBytes([{ name: 'Vendor_Ledger_ਗੁਪਤਾ.pdf', blob: new Blob(['x']) }]);
    expect(buf.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it('encodes a non-ASCII name as UTF-8 bytes, not UTF-16', async () => {
    const name = 'ਗੁਪਤਾ.pdf';
    const buf = await zipBytes([{ name, blob: new Blob(['x']) }]);
    const nameLen = buf.readUInt16LE(26);
    expect(nameLen).toBe(Buffer.byteLength(name, 'utf8'));
    expect(buf.slice(30, 30 + nameLen).toString('utf8')).toBe(name);
  });

  it('gives each entry a central-directory record at the right offset', async () => {
    const files = [
      { name: 'a.pdf', blob: new Blob(['aaaa']) },
      { name: 'bb.pdf', blob: new Blob(['bb']) },
    ];
    const buf = await zipBytes(files);
    const eocd = buf.length - 22;
    let p = buf.readUInt32LE(eocd + 16);
    for (const f of files) {
      expect(buf.readUInt32LE(p)).toBe(CENTRAL);
      const localOffset = buf.readUInt32LE(p + 42);
      // The offset must point at that entry's own local header.
      expect(buf.readUInt32LE(localOffset)).toBe(LOCAL);
      const nameLen = buf.readUInt16LE(p + 28);
      expect(buf.slice(p + 46, p + 46 + nameLen).toString()).toBe(f.name);
      p += 46 + nameLen;
    }
    expect(p).toBe(eocd);
  });

  it('handles an empty file list', async () => {
    const buf = await zipBytes([]);
    expect(buf.length).toBe(22);
    expect(buf.readUInt32LE(0)).toBe(EOCD);
    expect(buf.readUInt16LE(10)).toBe(0);
  });

  it('produces an application/zip blob', async () => {
    const blob = await Print.zipStore([{ name: 'a.pdf', blob: new Blob(['x']) }]);
    expect(blob.type).toBe('application/zip');
  });
});

describe('bulkZipName', () => {
  it('is <prefix>_<ddmmyy>.zip', () => {
    const name = Print.bulkZipName('Purchase_Orders');
    expect(name).toMatch(/^Purchase_Orders_\d{6}\.zip$/);
  });

  it('zero-pads day and month', () => {
    jest.useFakeTimers().setSystemTime(new Date(2026, 0, 5)); // 5 Jan 2026
    try {
      // Reload inside the fake-timer window: the sandbox captures whatever
      // Date is global at load time, and beforeEach ran before the fake.
      const faked = loadPrintModule();
      expect(faked.bulkZipName('X')).toBe('X_050126.zip');
    } finally {
      jest.useRealTimers();
    }
  });
});
