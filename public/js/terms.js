// The terms page's own script: the footer year every page script opens with,
// and the clause editor an admin gets on /terms.html.
//
// Each clause body is a contenteditable region, and the formatting is NOT
// reimplemented here: this page loads js/write.js, the post writer's rich-text
// engine, whose docked toolbar acts on whichever `.rt-editor` holds the caret -
// so bold, lists, links, cỡ chữ, giãn dòng and the rest behave on the terms
// document exactly as they do when writing a new post. What lives here is only
// the clause list around those editors: add, reorder, delete, save.
//
// The editor is hidden in the markup and revealed only once /api/auth/me has
// confirmed the 'admin' role. The cached Auth user would do for a first paint,
// but a role can be revoked server-side while a stale localStorage copy still
// says admin - and one round-trip is a cheap price for not flashing an editor at
// somebody who no longer owns the document. The save is guarded and sanitised
// again server-side (PUT /api/admin/terms), so the reveal is politeness, not
// security.
(function () {
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---- the shipped page -> stored HTML --------------------------------------
  // Used once per editor open on a document nobody has saved yet: what the admin
  // edits has to be what the page shows, so the shipped sections are lifted
  // child-by-child rather than retyped. Two elements become the plain-text
  // tokens server/terms.js expands again on render - the contact paragraph and
  // the brand slot - because neither is markup a toolbar can produce, and
  // neither should reach the sanitizer as live marker attributes.
  function sectionToHtml(section) {
    const h2 = section.querySelector('h2');
    // The number is positional on the server side, so it is noise here.
    const heading = (h2 ? h2.textContent : '').replace(/^\s*\d+\.\s*/, '').trim();
    const parts = [];
    for (const el of section.children) {
      if (el.tagName === 'H2') continue;
      if (el.tagName === 'P' && el.hasAttribute('data-hide-if-empty')) {
        parts.push('<p>[contact]</p>');
        continue;
      }
      parts.push(
        el.outerHTML.replace(/<span data-brand-name(?:="[^"]*")?>[\s\S]*?<\/span>/g, '[brand]')
      );
    }
    return { heading, html: parts.join('\n') };
  }

  function clausesFromPage() {
    return Array.from(document.querySelectorAll('#terms-body > section')).map(sectionToHtml);
  }

  // The editor chrome (docked toolbar, menus, block shells) lives in
  // css/write.css, moved out of write.html's inline <style> so this page can
  // share it. Linked at reveal time, not in the markup: a reader who never sees
  // the editor never downloads 58 KB of toolbar CSS.
  function loadEditorCss() {
    const found = document.querySelector('link[href="/css/write.css"]');
    if (found) return cssReady(found);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/write.css';
    document.head.appendChild(link);
    return cssReady(link);
  }

  // The docked toolbar the engine parents to <body> is styled ONLY by this
  // stylesheet, so an .rt-editor that exists before the file arrives can build
  // an unstyled bar on the next caret move - the same row of bare buttons a
  // reader used to get. Rendering the clause list once the link has loaded (or
  // failed: an editor with no chrome still beats no editor) keeps the two in
  // step, and costs nothing because the clauses fetch runs in parallel.
  function cssReady(link) {
    if (link.sheet) return Promise.resolve();
    return new Promise((resolve) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
    });
  }

  // ---- the clause list -------------------------------------------------------
  const ICON_BTN =
    'flex items-center justify-center rounded-lg p-2.5 text-on-surface-variant hover:text-primary hover:bg-primary-container/10 transition-colors';

  function cardHtml(clause) {
    return `
<div class="glass-panel rounded-xl p-4 flex flex-col gap-3" data-clause>
<div class="flex items-center justify-between gap-2">
<p class="font-label-md text-label-md text-on-surface-variant" data-clause-index></p>
<div class="flex items-center gap-1">
<button type="button" data-clause-move="-1" title="Chuyển điều khoản lên" class="${ICON_BTN}"><span class="material-symbols-outlined text-[18px]">arrow_upward</span></button>
<button type="button" data-clause-move="1" title="Chuyển điều khoản xuống" class="${ICON_BTN}"><span class="material-symbols-outlined text-[18px]">arrow_downward</span></button>
<button type="button" data-clause-delete title="Xoá điều khoản" class="${ICON_BTN} text-error"><span class="material-symbols-outlined text-[18px]">delete</span></button>
</div>
</div>
<input type="text" data-clause-heading placeholder="Tiêu đề điều khoản" autocomplete="off" class="terms-field rounded-lg px-4 py-2.5 font-label-md text-label-md text-on-background w-full" value="${esc(clause.heading)}">
<div class="rt-editor rt-surface" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="Nội dung điều khoản…" data-clause-body>${clause.html || ''}</div>
</div>`;
  }

  function renumber(list) {
    Array.from(list.querySelectorAll('[data-clause]')).forEach((card, i) => {
      card.querySelector('[data-clause-index]').textContent = `Điều khoản ${i + 1}`;
    });
  }

  function render(list, clauses) {
    list.innerHTML = clauses.map(cardHtml).join('\n');
    renumber(list);
  }

  // What gets saved is what the post editor saves: the contenteditable's HTML
  // run through api.js's normalizeRichTextHtml() (indent <blockquote> becomes
  // div.rt-indent, dead <br>s go, and so on). The server sanitizes it again with
  // the same sanitize-html pass a post body gets.
  function clausesFromEditor(list) {
    return Array.from(list.querySelectorAll('[data-clause]')).map((card) => {
      const editor = card.querySelector('[data-clause-body]');
      const html = typeof normalizeRichTextHtml === 'function' ? normalizeRichTextHtml(editor.innerHTML) : editor.innerHTML;
      return { heading: card.querySelector('[data-clause-heading]').value, html };
    });
  }

  // Puts a saved document on the page without a reload: the sections the server
  // just rendered, the note paragraph kept (it is the page's, not a clause's),
  // and the date line the save stamped. The injected markup carries the same
  // markers the server fills on a fresh render - the mailto href, hide-if-empty,
  // the brand slot - and api.js's branding pass is the client half of that, so
  // it runs over the new DOM.
  function applySaved(saved) {
    const article = document.getElementById('terms-body');
    if (article) {
      const note = article.querySelector('.terms-note');
      article.innerHTML = saved.html;
      if (note) article.appendChild(note);
    }
    const dateEl = document.getElementById('terms-updated');
    if (dateEl) dateEl.textContent = saved.dateLine;
    if (typeof applySiteBranding === 'function') applySiteBranding();
  }

  function wire(list) {
    list.addEventListener('click', (e) => {
      const move = e.target.closest('[data-clause-move]');
      if (move) {
        const card = move.closest('[data-clause]');
        const up = Number(move.getAttribute('data-clause-move')) < 0;
        const neighbour = up ? card.previousElementSibling : card.nextElementSibling;
        if (!neighbour) return;
        if (up) list.insertBefore(card, neighbour);
        else list.insertBefore(neighbour, card);
        renumber(list);
        return;
      }
      const del = e.target.closest('[data-clause-delete]');
      if (del) {
        const card = del.closest('[data-clause]');
        // Deleting only removes the card; the clause is gone for readers once
        // the save lands, which is what the confirm says.
        if (window.confirm('Xoá điều khoản này khỏi bản lưu?')) {
          card.remove();
          renumber(list);
        }
      }
    });

    document.getElementById('terms-add-clause').addEventListener('click', () => {
      list.insertAdjacentHTML('beforeend', cardHtml({ heading: '', html: '' }));
      renumber(list);
      // A new card appears BELOW nine or ten existing ones - off screen, at the
      // bottom of a tall panel. Without this the button looks dead: it did add
      // the clause, somewhere under the fold.
      const editor = list.querySelector('[data-clause]:last-child [data-clause-body]');
      if (editor) {
        editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
        editor.focus();
      }
    });

    const saveBtn = document.getElementById('terms-save');
    const status = document.getElementById('terms-save-status');
    saveBtn.addEventListener('click', () => {
      const clauses = clausesFromEditor(list);
      status.textContent = 'Đang lưu…';
      saveBtn.disabled = true;
      API.adminSaveTerms({ clauses })
        .then((saved) => {
          applySaved(saved);
          const time = String(saved.updatedAt || '').slice(11, 16);
          status.textContent = `Đã lưu lúc ${time} - dòng "Cập nhật lần cuối" đầu trang đã đặt lại theo lúc này.`;
        })
        .catch((err) => {
          status.textContent = `Không lưu được: ${err && err.message ? err.message : err}`;
        })
        .then(() => {
          saveBtn.disabled = false;
        });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const year = document.getElementById('footer-year');
    if (year) year.textContent = new Date().getFullYear();

    if (!Auth.isAdmin()) return;
    API.me()
      .then((me) => {
        if (!me || !me.user || me.user.role !== 'admin') return null;
        Auth.setSession(Auth.getToken(), me.user);
        const editor = document.getElementById('terms-editor');
        if (!editor) return null;
        const chromeCss = loadEditorCss();
        editor.classList.remove('hidden');
        const list = document.getElementById('terms-editor-clauses');
        const open = (clauses) => {
          render(list, clauses);
          wire(list);
        };
        return API.getTerms()
          .then((data) => {
            const saved = data && Array.isArray(data.clauses) && data.clauses.length ? data.clauses : null;
            return chromeCss.then(() => open(saved || clausesFromPage()));
          })
          .catch(() => {
            // The editor still opens on the shipped clauses if the GET fails:
            // editing what is on screen beats an empty form.
            return chromeCss.then(() => open(clausesFromPage()));
          });
      })
      .catch(() => {
        // Signed out, or the session died: the editor stays hidden, which is
        // exactly what a reader should see.
      });
  });

  // The page->HTML half, exposed for the round-trip test (test-t21 runs it over
  // the real shipped page with linkedom).
  window.TermsEditor = { sectionToHtml, clausesFromPage };
})();
