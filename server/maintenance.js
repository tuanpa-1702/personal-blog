// Maintenance mode: one flag file turns the whole site into the notice page.
//
//   touch data/maintenance-on     # every request but the notice's own assets -> 503 + page
//   rm    data/maintenance-on     # back to normal, no restart needed
//
// The flag is stat'ed per request rather than cached: a maintenance window is
// opened and closed by hand, in a hurry, and a cached "off" that outlives the
// `rm` would keep the site shut after the work is done. One stat on a local
// disk per request is nothing at this site's traffic.
//
// The same page is also what a reader sees when a request DIES in a 5xx (see
// the error handler in server.js), and what api.js paints over a page whose own
// fetches start failing - three doors, one notice, one copy.
const fs = require('fs');
const path = require('path');

const FLAG = path.join(__dirname, '..', 'data', 'maintenance-on');
const PAGE = path.join(__dirname, '..', 'public', 'maintenance.html');

// What the notice itself needs to render: its two stylesheets, the theme switch
// and the faces they name. Everything else - every page, every endpoint - is
// the thing being maintained.
const ASSET = /^\/(css|js|fonts|uploads)\//;
function isAsset(reqPath) {
  return reqPath === '/maintenance.html' || ASSET.test(reqPath);
}

function isEnabled() {
  try {
    fs.statSync(FLAG);
    return true;
  } catch {
    return false;
  }
}

// 503, not 200: a maintenance page that answers 200 is a page a CDN will cache
// and keep serving after the flag is gone, and a page a search engine will
// index as the site's new home. Retry-After is a hint, not a promise.
function sendPage(res, status = 503) {
  fs.readFile(PAGE, (err, buf) => {
    if (err) {
      // The notice missing is itself an emergency; say so in plain text rather
      // than throwing from inside the error path.
      res.status(status).type('text/plain; charset=utf-8').send('Website đang được bảo trì. Vui lòng quay lại sau ít phút.');
      return;
    }
    res
      .status(status)
      .set('Cache-Control', 'no-cache, must-revalidate')
      .set('Retry-After', '600')
      .type('text/html; charset=utf-8')
      .send(buf);
  });
}

function middleware(req, res, next) {
  if (!isEnabled() || isAsset(req.path)) return next();
  sendPage(res);
}

module.exports = { isEnabled, isAsset, middleware, sendPage, FLAG, PAGE };
