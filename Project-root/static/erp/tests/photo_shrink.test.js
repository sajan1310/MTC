/**
 * Shrinking a photo before it is saved (2026-11-24: the inspection tablet's
 * camera "overloads or is slow and sometimes it crashes").
 *
 * A camera photo is 12-50 megapixels. It used to be read into a data: URL
 * and decoded whole on the main thread (48-190 MB) only to be drawn at
 * 800 px. Now its size comes from the JPEG header, the browser decodes it
 * straight to about 800 px (createImageBitmap with one side given, so the
 * proportions hold), and nothing the size of the original is kept. Both
 * apps: MApp.Util.resizeImageToBase64 and App.Utils.resizeImageFile.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  eval(code);
}

// jsdom's Blob has no arrayBuffer(); Chrome's has had it since 2019.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// The start of a baseline JPEG: SOI, a JFIF APP0, then the frame header
// (SOF0) naming its height and width, then filler.
function jpeg(width, height, filler = 2048) {
  const bytes = [
    0xFF, 0xD8,
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 0xFF, width >> 8, width & 0xFF,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
  ];
  return new File([new Uint8Array(bytes), new Uint8Array(filler)], 'photo.jpg', { type: 'image/jpeg' });
}

let drawn;
let readAsDataURL;
let bitmaps;

function installBrowserImaging({ bitmapFails = false } = {}) {
  drawn = [];
  bitmaps = [];
  global.createImageBitmap = jest.fn(async (file, options) => {
    if (bitmapFails) throw new Error('not supported here');
    // What the browser would hand back: the photo decoded to the side asked
    // for, its proportions kept (the test files are 4:3).
    let width = file.__w;
    let height = file.__h;
    if (options.resizeWidth) { height = Math.round(height * options.resizeWidth / width); width = options.resizeWidth; }
    if (options.resizeHeight) { width = Math.round(width * options.resizeHeight / height); height = options.resizeHeight; }
    const bitmap = { width, height, close: jest.fn() };
    bitmaps.push(bitmap);
    return bitmap;
  });
  HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    return {
      imageSmoothingQuality: 'low',
      drawImage(source, x, y, w, h) { drawn.push({ source, w, h, canvasW: canvas.width, canvasH: canvas.height, quality: this.imageSmoothingQuality }); }
    };
  };
  HTMLCanvasElement.prototype.toDataURL = jest.fn(() => 'data:image/jpeg;base64,SMALL');
  readAsDataURL = jest.spyOn(FileReader.prototype, 'readAsDataURL');
  global.URL.createObjectURL = jest.fn(() => 'blob:photo');
  global.URL.revokeObjectURL = jest.fn();
}

function photo(width, height) {
  const file = jpeg(width, height);
  file.__w = width;
  file.__h = height;
  return file;
}

afterEach(() => {
  jest.restoreAllMocks();
  delete global.createImageBitmap;
});

describe.each([
  ['phone', () => { loadAsGlobal('api.js', 'Api'); loadAsGlobal('mobile.js', 'MApp'); return (f, d) => MApp.Util.resizeImageToBase64(f, d); }],
  ['desktop', () => {
    global.escapeHtml = s => String(s ?? '');
    loadAsGlobal('core.js', 'App');
    return (f, d) => App.Utils.resizeImageFile(f, d);
  }]
])('shrinking a photo on the %s', (_label, load) => {
  let shrink;
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    shrink = load();
  });

  test('a landscape camera photo is decoded straight to 800 px wide, never read whole', async () => {
    installBrowserImaging();
    const out = await shrink(photo(4000, 3000), 800);

    expect(out).toBe('data:image/jpeg;base64,SMALL');
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(createImageBitmap.mock.calls[0][1]).toEqual({ imageOrientation: 'from-image', resizeQuality: 'high', resizeWidth: 800 });
    expect(drawn).toEqual([expect.objectContaining({ w: 800, h: 600, canvasW: 800, canvasH: 600, quality: 'high' })]);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
    expect(bitmaps[0].close).toHaveBeenCalled();
    expect(readAsDataURL).not.toHaveBeenCalled();
  });

  test('a portrait one by its height', async () => {
    installBrowserImaging();
    await shrink(photo(3000, 4000), 800);
    expect(createImageBitmap.mock.calls[0][1]).toEqual({ imageOrientation: 'from-image', resizeQuality: 'high', resizeHeight: 800 });
    expect(drawn[0]).toEqual(expect.objectContaining({ w: 600, h: 800 }));
  });

  test('a photo already small is decoded at its own size', async () => {
    installBrowserImaging();
    await shrink(photo(640, 480), 800);
    expect(createImageBitmap.mock.calls[0][1]).toEqual({ imageOrientation: 'from-image', resizeQuality: 'high' });
    expect(drawn[0]).toEqual(expect.objectContaining({ w: 640, h: 480 }));
  });

  test('turned by its EXIF orientation, it still fits 800 on its longest side', async () => {
    installBrowserImaging();
    // A sideways sensor frame the browser turns upright: asked for 800 wide,
    // it comes back 800 x 1067, and the canvas fits that.
    global.createImageBitmap = jest.fn(async () => {
      const bitmap = { width: 800, height: 1067, close: jest.fn() };
      bitmaps.push(bitmap);
      return bitmap;
    });
    await shrink(photo(4000, 3000), 800);
    expect(drawn[0]).toEqual(expect.objectContaining({ w: 600, h: 800 }));
    expect(bitmaps[0].close).toHaveBeenCalled();
  });

  test('where the browser cannot, an image of the file itself is used, never a data: URL of it', async () => {
    installBrowserImaging({ bitmapFails: true });
    class FakeImage {
      constructor() { this.naturalWidth = 1200; this.naturalHeight = 900; }
      set src(url) { this._src = url; setTimeout(() => this.onload && this.onload(), 0); }
      get src() { return this._src; }
    }
    global.Image = FakeImage;

    await shrink(photo(1200, 900), 800);

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(drawn[0]).toEqual(expect.objectContaining({ w: 800, h: 600 }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
    expect(readAsDataURL).not.toHaveBeenCalled();
  });

  test('a file that is not a picture is refused', async () => {
    installBrowserImaging();
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await expect(shrink(text, 800)).rejects.toThrow(/image/);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
