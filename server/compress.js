// gzip / brotli for text responses.
//
// Written against Node's built-in zlib rather than the `compression` package on
// purpose: node_modules on this project is installed ON THE UBUNTU SERVER (its
// better-sqlite3 binary is an ELF .node), and the tree is edited over a Samba
// mount from Windows. Running npm install from the Windows side to add one
// dependency would re-resolve better-sqlite3 and swap that ELF binary for a
// win32 prebuild, which takes the server down. A zero-dependency middleware
// avoids the whole question.
//
// Why it matters here: common.css + tailwind.css are render-blocking, and the
// JS is what fills every page's content in. Measured on this project's own
// assets, gzip removes 72% of those bytes and brotli 76% - the CSS the first
// paint waits on drops from 75 KB to about 15 KB.
//
// Deliberately BUFFERING rather than streaming. Every compressible response
// this app produces is a whole file or a whole JSON document, the largest being
// admin.html at 66 KB, so holding it in memory to compress it once is simpler
// and cannot get the chunk/flush interleaving wrong. Anything not compressible -
// uploaded images above all - is handed straight back to the original write/end
// on the first chunk and never buffered at all.
const zlib = require('zlib');

// Text formats only. Images and fonts are already compressed: running deflate
// over a woff2 or a JPEG costs CPU and gives back nothing (often a few bytes
// more). woff2's own container is brotli-compressed internally.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;

// Below roughly one MTU the compressed copy plus its header can be larger than
// the original, and never arrives in fewer packets.
const THRESHOLD = 1024;

// Brotli defaults to quality 11, which is a build-time setting - hundreds of ms
// on a 60 KB file. 5 is the usual on-the-fly choice: it still beats gzip -9 on
// text while costing a couple of ms.
const BROTLI_QUALITY = 5;

function pickEncoding(header) {
  const accept = String(header || '').toLowerCase();
  // No q-value parsing: this only ever has to answer "does the client take br,
  // or gzip". A client that sends `br;q=0` is not a real browser.
  if (/(?:^|,)\s*br\b/.test(accept)) return 'br';
  if (/(?:^|,)\s*gzip\b/.test(accept)) return 'gzip';
  return null;
}

function compressBody(body, encoding) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(body, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
  }
  return zlib.gzipSync(body);
}

function compress() {
  return function compressMiddleware(req, res, next) {
    const encoding = pickEncoding(req.headers['accept-encoding']);
    // HEAD must keep its headers but has no body to compress, and a request
    // whose client takes neither encoding is left completely alone.
    if (!encoding || req.method === 'HEAD') return next();

    const rawWrite = res.write;
    const rawEnd = res.end;
    const chunks = [];
    let buffering = null; // null = not decided yet

    // Runs at the first write/end, by which point the route has set its
    // Content-Type. Returns whether to collect this response for compression.
    function shouldBuffer() {
      if (buffering !== null) return buffering;

      const status = res.statusCode;
      const bodyless = status < 200 || status === 204 || status === 304;
      const alreadyEncoded = !!res.getHeader('Content-Encoding');
      const type = res.getHeader('Content-Type');

      if (res.headersSent || bodyless || alreadyEncoded || !COMPRESSIBLE.test(String(type || ''))) {
        buffering = false;
        return false;
      }

      // Set on every compressible response, including one that ends up under the
      // threshold: the body varies by request header either way, and a shared
      // cache that missed this would serve a gzipped copy to a client that
      // cannot read it.
      res.setHeader('Vary', 'Accept-Encoding');
      // The length of the compressed body is not known until the end, and a
      // stale Content-Length truncates the response.
      res.removeHeader('Content-Length');
      buffering = true;
      return true;
    }

    res.write = function write(chunk, enc, cb) {
      if (!shouldBuffer()) return rawWrite.call(res, chunk, enc, cb);
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };

    res.end = function end(chunk, enc, cb) {
      // end(cb) and end(chunk, cb) are both legal.
      if (typeof chunk === 'function') { cb = chunk; chunk = null; enc = null; }
      else if (typeof enc === 'function') { cb = enc; enc = null; }

      if (!shouldBuffer()) return rawEnd.call(res, chunk, enc, cb);

      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8'));
      const body = Buffer.concat(chunks);

      // Too small to be worth it: send the original bytes, with the
      // Content-Length that was removed above put back.
      if (body.length < THRESHOLD) {
        res.setHeader('Content-Length', String(body.length));
        return rawEnd.call(res, body, cb);
      }

      let out;
      try {
        out = compressBody(body, encoding);
      } catch (e) {
        // A compression failure must not cost the reader the page.
        res.setHeader('Content-Length', String(body.length));
        return rawEnd.call(res, body, cb);
      }

      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', String(out.length));
      return rawEnd.call(res, out, cb);
    };

    next();
  };
}

module.exports = { compress };
