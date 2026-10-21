"""Verifies the subsetted icon font actually contains the ligatures the pages use.

An icon here is a LIGATURE: the markup contains the literal word ("perm_media") and
the font maps that character sequence to one glyph. fonts.css declares the face
display:block, so an icon whose ligature is absent renders as NOTHING - or, worse,
the browser falls back and draws the WORD. Either way it looks like a broken page.

Run after `npm run fetch:fonts`. Exits non-zero if anything the markup asks for is
missing from the subset.
"""
import glob
import re
import subprocess
import sys

from fontTools.ttLib import TTFont

# The font file the pages actually reference, read from the markup rather than
# hardcoded - the name carries a content hash and changes on every rebuild.
html = open('public/admin.html', encoding='utf-8').read()
match = re.search(r'material-symbols-subset\.[0-9a-f]+\.woff2', html)
if not match:
    sys.exit('no icon font reference found in public/admin.html')
path = 'public/fonts/' + match.group(0)
print('font:', path)

font = TTFont(path)
present = set()
gsub = font.get('GSUB')
if gsub and gsub.table.LookupList:
    for lookup in gsub.table.LookupList.Lookup:
        for st in lookup.SubTable:
            st = getattr(st, 'ExtSubTable', st)  # type 7 wraps the real subtable
            for first, entries in (getattr(st, 'ligatures', None) or {}).items():
                for lig in entries:
                    seq = [first] + list(lig.Component)
                    present.add(''.join('_' if g == 'underscore' else g for g in seq))

# The same list the build uses, so this cannot drift from what was requested.
wanted = subprocess.run([sys.executable, 'scripts/icon-names.py'],
                        capture_output=True, text=True, check=True).stdout.strip()
wanted = [n for n in wanted.split(',') if n]

missing = sorted(set(wanted) - present)
print(f'requested: {len(wanted)}   in font: {len(present)}   missing: {len(missing)}')

# Every file that references the font must reference the SAME hash, or a page loads a
# subset built for a different icon set.
refs = {}
for page in sorted(glob.glob('public/*.html')) + ['public/css/fonts.css']:
    body = open(page, encoding='utf-8').read()
    for ref in set(re.findall(r'material-symbols-subset\.[0-9a-f]+\.woff2', body)):
        refs.setdefault(ref, []).append(page)
if len(refs) > 1:
    print('MISMATCHED font references:')
    for ref, pages in refs.items():
        print(f'  {ref}: {", ".join(pages)}')
    sys.exit(1)
print('all pages reference one font file:', next(iter(refs)))

if missing:
    print('MISSING ligatures:', ' '.join(missing))
    sys.exit(1)
print('OK - every icon the markup uses is in the subset')
