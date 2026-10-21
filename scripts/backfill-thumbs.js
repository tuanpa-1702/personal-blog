#!/usr/bin/env node
// Superseded by scripts/gen-derivatives.js.
//
//     node scripts/backfill-thumbs.js   ->   node scripts/gen-derivatives.js
//
// The old script backfilled one derivative (the 480px tile) for the rows in the
// media table. The public pages now serve a second derivative (1280px) too, and
// post covers uploaded through /api/upload are not always media rows, so the
// replacement walks EVERY file in public/uploads and makes both kinds. Kept as
// a pointer so an old runbook line still does the right thing.

require('./gen-derivatives');
