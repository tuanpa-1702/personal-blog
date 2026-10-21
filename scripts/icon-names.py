#!/usr/bin/env python3
"""Prints the comma-separated Material Symbols ligature names the site uses.

Consumed by scripts/fetch-fonts.py to build the subsetted icon font. Scraping
the markup rather than keeping a hand-written list means adding an icon to a
page and re-running the fetch script is enough - there is no second place to
forget.

Two sources, because the pages build markup both ways:
  1. every `<span class="material-symbols-outlined ...">name</span>` literal, in
     the HTML and inside JS template literals alike;
  2. names that only ever reach the DOM through a variable - a ternary, a lookup
     table, or `textContent =`. Those cannot be scraped reliably, so they are
     listed explicitly below. ADD TO THIS LIST when introducing one.
"""
import glob
import re
import sys

LIGATURE = re.compile(r'material-symbols-outlined[^>]*>\s*([a-z][a-z0-9_]{1,30})\s*<')

# Set dynamically - see the docstring. Each is followed by where it comes from.
DYNAMIC = [
    'chat_bubble',                              # admin.js activityKind()
    'thumb_up', 'thumb_down',                   # admin.js activityKind()
    'shield_person', 'edit_note', 'visibility',  # admin.js USER_ROLE_ICON
    'visibility_off',                           # admin.js password reveal toggles
    'notifications_active', 'notifications_off',  # admin.js user row
    'public', 'mail',                           # admin.js sign-in method column
    'check_circle', 'warning',                  # admin.js setEmailBanner()
    'person', 'post_add', 'dashboard',          # api.js navMenuItem() calls
    'logout', 'login', 'person_add',            # api.js navMenuItem() calls
    # The whole paragraph toolbar. write.js builds it from the RT_TOOLBAR and
    # RT_MENUS tables, so every icon reaches the DOM as `${item.icon}` - there
    # is no literal for the regex above to find, and an icon left out of this
    # list renders as NOTHING rather than as a fallback glyph.
    'format_align_left', 'format_align_center',  # RT_TOOLBAR, alignment
    'format_align_right', 'format_align_justify',  # RT_TOOLBAR, alignment
    'keyboard_tab',                             # RT_TOOLBAR, first-line indent
    'format_indent_increase', 'format_indent_decrease',  # RT_TOOLBAR, whole-block indent
    'format_list_numbered', 'format_list_bulleted',  # RT_TOOLBAR, lists
    'ink_highlighter',                          # RT_TOOLBAR, highlighter
    'format_strikethrough',                     # RT_TOOLBAR, strikethrough
    'link',                                     # RT_TOOLBAR, hyperlink dialog
    'superscript', 'subscript',                 # RT_TOOLBAR, super/subscript
    'undo', 'redo', 'format_clear',             # RT_TOOLBAR, history + clear formatting
    'format_size', 'font_download',             # RT_MENUS triggers: size, font
    'format_line_spacing', 'density_medium',    # RT_MENUS triggers: leading, spacing
    'title',                                    # RT_MENUS trigger: heading level
    'image',                                    # RT_TOOLBAR: "Chèn ảnh" trigger
    'grid_view',                                # RT_TOOLBAR: "Bảng" table trigger
    'format_quote',                             # RT_TOOLBAR: block pull-quote ("Trích dẫn")
    'terminal',                                  # RT_TOOLBAR: terminal/code block ("Chèn khối lệnh")
    # The "Chèn ảnh" menu's three ways in. rtMenuOption() writes them as
    # `${opt.icon}`, so like the toolbar's own icons they are invisible to the
    # regex above. (The fourth icon that menu shows, 'link', is already listed.)
    'cloud_upload', 'perm_media',               # RT_MENUS.image options: upload, library
    # Media library folder shelf. media.js picks between these per card, so the icon
    # reaches the DOM as `${kids.length ? 'folder_open' : 'folder'}` and the regex
    # above finds no literal for either.
    'folder', 'folder_open',                    # media.js folderCardHtml()
    # The shelf's two VIEW cards and the move menu's "Chưa phân loại" option. Both
    # reach the DOM through a variable - folderViewCardHtml()'s `icon` argument and a
    # ternary in moveMenu() - and the literals that used to carry them went away when
    # the folder tree became a shelf, so without these two lines the icons would be
    # missing from the subset font and render as nothing at all.
    'photo_library', 'folder_off',              # media.js folderViewCardHtml(), moveMenu()
    # Both pagers - the media library's (media.js renderMediaPager) and the one on
    # viewall.html (viewall.js renderPager) - write their arrows as `${icon}`, so
    # neither name is a literal the regex above can find. They are in the subset
    # today only because other pages spell them out as text, which is exactly the
    # accident this list exists to remove.
    'arrow_back', 'arrow_forward',              # pager arrows: previous / next page
    # The Thông báo tab's kind badges. admin.js notificationKind() writes them as
    # `${icon}`, so neither is a literal the regex above can find: 'flag' is
    # spelled out in post.js's report button and in the tab's own filter chip, and
    # 'notifications' in the rail button - but a badge whose glyph depends on some
    # other markup staying exactly as it is, is the accident this list exists to
    # remove. ('chat_bubble', 'person_add', 'visibility', 'visibility_off' and
    # 'check_circle' are already listed above for their other call sites.)
    'flag', 'notifications',                    # admin.js NOTIF_KINDS, notificationKind()
]


def main() -> int:
    names = set(DYNAMIC)
    for path in sorted(glob.glob('public/*.html') + glob.glob('public/js/*.js')):
        if '.bak.' in path:
            continue  # dev leftovers, not served
        with open(path, encoding='utf8') as fh:
            names.update(LIGATURE.findall(fh.read()))
    names.discard('span')
    print(','.join(sorted(names)), end='')
    return 0


if __name__ == '__main__':
    sys.exit(main())
