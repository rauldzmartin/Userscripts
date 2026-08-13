// ==UserScript==
// @name         Wallapop Hide Items (Synced)
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Hide specific items in Wallapop search results with multi-device sync
// @author       rauldzmartin@gmail.com
// @match        https://*.wallapop.com/*
// @exclude      https://*.wallapop.com/app/favorites/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=wallapop.com
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @updateURL    https://raw.githubusercontent.com/rauldzmartin/Userscripts/main/wallapop-hide-items.user.js
// @downloadURL  https://raw.githubusercontent.com/rauldzmartin/Userscripts/main/wallapop-hide-items.user.js
// ==/UserScript==

(() => {
    'use strict';

    if (location.pathname.includes('/app/favorites')) return;

    const STORAGE_KEY = 'wallapop_hidden_items',
          TOGGLE_KEY = 'wallapop_hide_toggle',
          FALLBACK_CLASS = 'wallapop-hidden-fallback',
          STYLES_ID = 'wallapop-hide-styles',
          TOGGLE_BTN_ID = 'wallapop-toggle-hidden-btn',
          GRID = '[class*="ItemCardGrid"]',
          LIST = '[class*="ItemCardList"]',
          LINK = 'a[href*="/item/"]',
          TITLE = '[class*="SearchPageResults__title"] h2',
          SECTION = 'SearchPageResults__title',
          ID_RE = /-(\d+)(?:[/?#]|$)/,
          HIDE = `{position:absolute!important;clip-path:inset(100%)!important;pointer-events:none!important}`,
          EYE_OFF = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--chds-color-content-high, #29363d)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="margin:auto;display:block"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`,
          BLOCK_STROKE = 'var(--chds-color-negative-mid, #ce3528)',
          SYNC_INTERVAL = 30000, WRITE_DEBOUNCE = 2000,
          GIST_CFG = 'wallapop_gist_cfg', GIST_FILE = 'wallapop-blocked-items.json',
          LAST_SYNCED_KEY = 'wallapop_last_synced_state', GIST_PROMPTED_KEY = 'wallapop_gist_prompted';

    let pushTimer = null, syncQueue = Promise.resolve(), lastSyncedIds = null;
    try { lastSyncedIds = JSON.parse(localStorage.getItem(LAST_SYNCED_KEY) || 'null'); } catch {}

    const T = location.hostname.startsWith('es.') ? {
        hiddenTitle: 'Todos los artículos de esta búsqueda están ocultos. Usa «Mostrar ocultos» para verlos.',
        show: 'Mostrar ocultos', hide: 'Ocultar bloqueados',
        blocked: 'Este artículo está bloqueado.', hideBtn: 'Ocultar este artículo'
    } : {
        hiddenTitle: 'All items in this search are hidden. Use "Show hidden" to view them.',
        show: 'Show hidden', hide: 'Hide blocked',
        blocked: 'This item is blocked.', hideBtn: 'Hide this item'
    };

    let disabled = (() => { try { return localStorage.getItem(TOGGLE_KEY) === '1'; } catch { return false; }})(),
        lastPath = location.pathname, titleModified = false, allHidden = false;
    
    const transient = new Set(),
          extractId = href => href?.match(ID_RE)?.[1] ?? null,
          cardId = c => extractId(c.querySelector(LINK)?.href),
          getHidden = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }},
          gridCells = () => [...document.querySelectorAll(`${GRID}>div`)];

    const key = arr => JSON.stringify([...(arr || [])].sort()),
          equal = (a, b) => key(a) === key(b),
          sanitize = arr => (Array.isArray(arr) ? arr : []).map(String).filter(x => /^\d+$/.test(x)),
          saveHidden = ids => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch {} },
          persistSynced = () => { try { localStorage.setItem(LAST_SYNCED_KEY, JSON.stringify(lastSyncedIds)); } catch {} },
          parseGist = r => {
              try {
                  const data = JSON.parse(r.responseText);
                  const content = data.files?.[GIST_FILE]?.content;
                  if (!content) return null;
                  const parsed = JSON.parse(content);
                  if (!Array.isArray(parsed.blocked)) return null;
                  return { blocked: sanitize(parsed.blocked) };
              } catch { return null; }
          },
          applyRemote = (remote, current) => {
              if (lastSyncedIds === null) return [...new Set([...current, ...remote])];
              const prevSet = new Set(lastSyncedIds), curSet = new Set(current),
                    removed = new Set(lastSyncedIds.filter(id => !curSet.has(id)));
              return [...new Set([...remote, ...current.filter(id => !prevSet.has(id))])].filter(id => !removed.has(id));
          },
          serial = fn => { const run = syncQueue.then(fn); syncQueue = run.catch(() => {}); return run; };

    const req = (method, path, data) => new Promise((ok, err) => {
        const cfg = GM_getValue(GIST_CFG);
        if (!cfg) return err('No config');
        GM_xmlhttpRequest({
            method, data,
            url: `https://api.github.com/${path}`,
            headers: {
                'Authorization': `token ${cfg.token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github.v3+json'
            },
            onload: r => r.status < 300 ? ok(r) : err(r),
            onerror: err
        });
    });

    const sync = {
        cfg() {
            const conf = GM_getValue(GIST_CFG);
            if (conf) return conf;
            if (GM_getValue(GIST_PROMPTED_KEY)) return null;
            GM_setValue(GIST_PROMPTED_KEY, 1);
            const id = prompt('GitHub Gist ID:\n\nExample: 95636bead4acf24062071058dcf9ea14');
            if (!id) return null;
            const token = prompt('GitHub Personal Access Token:\n\nGenerate at: Settings → Developer Settings → Tokens\nScope: gist');
            if (!token) return null;
            const conf2 = {id: id.trim(), token: token.trim()};
            GM_setValue(GIST_CFG, conf2);
            return conf2;
        },

        fetch() {
            const conf = this.cfg();
            if (!conf) return;
            serial(() => req('GET', `gists/${conf.id}`)
                .then(r => {
                    const remote = parseGist(r);
                    if (!remote || equal(remote.blocked, lastSyncedIds)) return;
                    const current = getHidden();
                    const merged = applyRemote(remote.blocked, current);
                    if (!equal(merged, current)) {
                        saveHidden(merged);
                        injectStyles();
                        console.log(`[wallapop_hide_items] Synced ${merged.length} items from Gist`);
                    }
                    lastSyncedIds = remote.blocked;
                    persistSynced();
                    if (!equal(merged, remote.blocked)) this.schedule();
                })
                .catch(e => console.warn('[wallapop_hide_items] Fetch failed:', e.status || e)));
        },

        push() {
            const conf = this.cfg();
            if (!conf) return;
            serial(() => req('GET', `gists/${conf.id}`)
                .then(r => {
                    const remote = parseGist(r);
                    if (remote && !equal(remote.blocked, lastSyncedIds)) {
                        const current = getHidden();
                        const merged = applyRemote(remote.blocked, current);
                        if (!equal(merged, current)) {
                            saveHidden(merged);
                            injectStyles();
                        }
                        lastSyncedIds = remote.blocked;
                        persistSynced();
                        if (equal(getHidden(), remote.blocked)) return null;
                    }
                    const local = getHidden();
                    if (remote && equal(local, remote.blocked)) return null;
                    const payload = JSON.stringify({
                        files: {
                            [GIST_FILE]: {
                                content: JSON.stringify({
                                    blocked: local,
                                    updated_at: new Date().toISOString(),
                                    version: 1
                                }, null, 2)
                            }
                        }
                    });
                    return req('PATCH', `gists/${conf.id}`, payload).then(() => {
                        lastSyncedIds = local;
                        persistSynced();
                        console.log(`[wallapop_hide_items] Pushed ${local.length} items to Gist`);
                    });
                })
                .catch(e => {
                    if (e.status === 429) setTimeout(() => this.push(), 60000);
                    else console.warn('[wallapop_hide_items] Push failed:', e.status || e);
                }));
        },

        schedule() {
            clearTimeout(pushTimer);
            pushTimer = setTimeout(() => this.push(), WRITE_DEBOUNCE);
        },

        init() {
            if (this.cfg()) this.fetch();
        }
    };

    const similares = cells => {
        let last = -1, count = 0;
        cells.forEach((c, i) => { if ((c.className || '').includes(SECTION)) { last = i; count++; }});
        return count >= 2 ? new Set(cells.slice(last + 1)) : new Set();
    };

    const computeAll = (cells, hidden, sim) => {
        if (disabled) return false;
        const cards = cells.filter(c => c.querySelector(LINK) && !sim.has(c));
        return cards.length > 0 && cards.every(c => c.classList.contains(FALLBACK_CLASS) || hidden.has(cardId(c)));
    };

    const block = (btn, blocked = true) => { btn.querySelector('svg')?.setAttribute('stroke', BLOCK_STROKE); if (blocked) btn.title = T.blocked; };

    function injectStyles() {
        let s = document.getElementById(STYLES_ID);
        if (!s) { s = document.createElement('style'); s.id = STYLES_ID; (document.head || document.documentElement).appendChild(s); }
        const items = getHidden(),
              rules = [`.${FALLBACK_CLASS} ${HIDE}`];
        if (items.length) {
            const sel = items.flatMap(id => [
                `${GRID}>div:has(a[href*="-${id}"])`, `${LIST}>div:has(a[href*="-${id}"])`, `tsl-public-item-card:has(a[href*="-${id}"])`
            ]);
            rules.push(`${sel.join(',')} ${HIDE}`);
        }
        s.textContent = rules.join('\n');
        s.disabled = disabled;
    }

    const addHidden = id => {
        if (!/^\d+$/.test(id)) return;
        const items = getHidden();
        if (!items.includes(id)) { items.push(id); saveHidden(items); injectStyles(); sync.schedule(); }
    };

    const removeHidden = id => {
        if (!/^\d+$/.test(id)) return;
        const items = getHidden();
        const idx = items.indexOf(id);
        if (idx !== -1) { items.splice(idx, 1); saveHidden(items); injectStyles(); sync.schedule(); }
    };

    const hideCard = link => { if (!disabled) link.closest('article, tsl-public-item-card')?.parentElement?.classList.add(FALLBACK_CLASS); };

    const showCard = link => { link.closest('article, tsl-public-item-card')?.parentElement?.classList.remove(FALLBACK_CLASS); };

    const btnText = () => disabled ? T.hide : T.show;

    function updateButtonsState() {
        const hidden = new Set(getHidden());
        document.querySelectorAll('button[aria-label="Hide item"]').forEach(btn => {
            const card = btn.closest('[data-hide-processed="true"]');
            if (!card) return;
            const link = card.querySelector(LINK);
            if (!link) return;
            const id = extractId(link.href);
            if (!id) return;
            if (hidden.has(id)) {
                block(btn);
            } else {
                btn.querySelector('svg')?.setAttribute('stroke', 'var(--chds-color-content-high, #29363d)');
                btn.title = T.hideBtn;
            }
        });

        // Update detail page button state
        const detailContainer = document.querySelector('[data-hide-detail-processed="true"]');
        if (detailContainer) {
            const detailBtn = detailContainer.querySelector('button[aria-label="Hide item"]');
            if (detailBtn) {
                const match = location.pathname.match(/\/item\/[^/]+-(\d+)/);
                if (match) {
                    const id = match[1];
                    if (hidden.has(id)) {
                        block(detailBtn);
                    } else {
                        detailBtn.querySelector('svg')?.setAttribute('stroke', 'var(--chds-color-content-high, #29363d)');
                        detailBtn.title = T.hideBtn;
                    }
                }
            }
        }
    }

    function toggle() {
        disabled = !disabled;
        console.log(`[wallapop_hide_items] ${disabled ? 'Showing' : 'Hiding'} hidden items`);
        try { localStorage.setItem(TOGGLE_KEY, disabled ? '1' : '0'); } catch {}
        const s = document.getElementById(STYLES_ID);
        if (s) s.disabled = disabled;
        document.getElementById(TOGGLE_BTN_ID)?.setAttribute('text', btnText());
        if (disabled) setTimeout(fixCards, 50);
        updateButtonsState();
    }

    function fixCards() {
        document.querySelectorAll('img[loading="lazy"]').forEach(img => img.removeAttribute('loading'));
        const hidden = new Set(getHidden());
        document.querySelectorAll(`${GRID}>div, ${LIST}>div`).forEach(cell => {
            const id = cardId(cell);
            if (!id || (!hidden.has(id) && !transient.has(id))) return;
            ['carousel__link', 'titleLink'].forEach(cls => {
                const el = cell.querySelector(`a[class*="${cls}"]`);
                if (el && getComputedStyle(el).display === 'none') el.style.removeProperty('display');
            });
        });
        window.dispatchEvent(new Event('resize', { bubbles: true }));
        window.scrollBy(0, 1);
        setTimeout(() => window.scrollBy(0, -1), 20);
    }

    function injectToggle() {
        const btn = document.getElementById(TOGGLE_BTN_ID);
        if (btn) { if (btn.getAttribute('text') !== btnText()) btn.setAttribute('text', btnText()); return; }
        const container = document.querySelector('[class*="SearchPage__bubbles"] > .d-flex.flex-wrap');
        if (!container) return;
        const el = document.createElement('walla-button');
        el.id = TOGGLE_BTN_ID;
        el.setAttribute('button-type', 'link');
        el.setAttribute('size', 'large');
        el.setAttribute('text', btnText());
        el.addEventListener('click', toggle);
        container.appendChild(el);
    }

    function syncTitle() {
        const title = document.querySelector(TITLE);
        if (!title) return;
        if (!title.dataset.wallapopOrigTitle) title.dataset.wallapopOrigTitle = title.textContent;
        // Latched: keep the informative title even if new cards arrive.
        if (!disabled && allHidden) {
            if (title.textContent !== T.hiddenTitle) title.textContent = T.hiddenTitle;
            titleModified = true;
        } else if (titleModified && title.textContent === T.hiddenTitle) {
            title.textContent = title.dataset.wallapopOrigTitle;
            titleModified = false;
        }
    }

    function syncTransient(hidden, cells, sim) {
        const tr = allHidden && !disabled;
        cells.forEach(cell => {
            const id = cardId(cell);
            if (!id) return;
            const fb = cell.classList.contains(FALLBACK_CLASS);
            if (sim.has(cell)) {
                if (!hidden.has(id) && (tr || transient.has(id))) { cell.classList.remove(FALLBACK_CLASS); transient.delete(id); }
            } else if (!hidden.has(id)) {
                if (tr && !fb) { cell.classList.add(FALLBACK_CLASS); transient.add(id); }
                else if (!tr && fb && transient.has(id)) cell.classList.remove(FALLBACK_CLASS);
            }
        });
    }

    function processLinks(hidden) {
        document.querySelectorAll(LINK).forEach(link => {
            const id = extractId(link.href);
            if (!id) return;
            const inner = link.closest('[class*="RetrievalItemCard__image"]') || link.parentElement.parentElement;
            if (!inner || inner.dataset.hideProcessed === 'true') return;

            if (hidden.has(id)) hideCard(link);

            const favBtn = inner.querySelector('button[aria-label="Save as favorite"], button [icon^="heart"]');
            if (!favBtn) return;

            const overlay = inner.querySelector('[class*="overlay--top"]');
            const slots = overlay?.querySelectorAll('[class*="overlaySlot"]') || [];
            const target = slots[slots.length > 1 ? 1 : 0];

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = favBtn.className;
            btn.setAttribute('aria-label', 'Hide item');
            btn.title = T.hideBtn;
            Object.assign(btn.style, { width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0' });
            btn.innerHTML = EYE_OFF;

            if (hidden.has(id)) block(btn);
            btn.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                const items = getHidden();
                if (items.includes(id)) {
                    removeHidden(id); showCard(link);
                    console.log(`[wallapop_hide_items] Item ${id} unhidden`);
                    btn.querySelector('svg')?.setAttribute('stroke', 'var(--chds-color-content-high, #29363d)');
                    btn.title = T.hideBtn;
                } else {
                    addHidden(id); hideCard(link); block(btn);
                    console.log(`[wallapop_hide_items] Item ${id} hidden`);
                }
            });

            let host = btn;
            if (favBtn.parentElement?.tagName === 'SPAN') {
                host = document.createElement('span');
                host.className = favBtn.parentElement.className;
                host.appendChild(btn);
            }

            if (target) target.appendChild(host);
            else {
                const box = document.createElement('div');
                Object.assign(box.style, { position: 'absolute', top: '8px', right: '8px', zIndex: '10' });
                box.appendChild(host);
                inner.style.position = 'relative';
                inner.appendChild(box);
            }
            inner.dataset.hideProcessed = 'true';
        });
    }

    const EYE_OFF_DETAIL = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--chds-color-content-high, #29363d)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="display:block"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

    function processItemDetail() {
        const match = location.pathname.match(/\/item\/[^/]+-(\d+)/);
        if (!match) return;

        const id = match[1];
        const carousel = document.querySelector('[role="region"][aria-roledescription="carousel"]');
        if (!carousel) return;

        // Find the position:relative container that wraps the carousel
        const container = carousel.closest('section.position-relative');
        if (!container || container.dataset.hideDetailProcessed === 'true') return;

        // Clone the real favorite button so we inherit its exact classes and look.
        // It lives inside a WALLA-TOOLTIP in a zero-height DIV, not in the section,
        // so search globally. If not found yet, retry on the next tick.
        const favBtn = document.querySelector('button[aria-label="Save as favorite"]');
        if (!favBtn) return;
        const btn = favBtn.cloneNode(true);

        btn.removeAttribute('aria-pressed');
        btn.removeAttribute('slot');
        btn.setAttribute('aria-label', 'Hide item');
        btn.title = T.hideBtn;

        // Replace the native heart icon + counter with our eye-off icon (24px, native size)
        btn.querySelectorAll('span.ms-1').forEach(s => s.remove());
        const wallaIcon = btn.querySelector('walla-icon');
        if (wallaIcon) wallaIcon.remove();
        btn.innerHTML = EYE_OFF_DETAIL;

        // Anchor to top-right, mirroring the favorite's bottom:20px / right:20px
        btn.style.position = 'absolute';
        btn.style.top = '20px';
        btn.style.right = '20px';
        btn.style.zIndex = '2';

        const hidden = getHidden();
        if (hidden.includes(id)) block(btn);

        btn.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            const items = getHidden();
            if (items.includes(id)) {
                removeHidden(id);
                console.log(`[wallapop_hide_items] Item ${id} unhidden`);
                btn.querySelector('svg')?.setAttribute('stroke', 'var(--chds-color-content-high, #29363d)');
                btn.title = T.hideBtn;
            } else {
                addHidden(id);
                block(btn);
                console.log(`[wallapop_hide_items] Item ${id} hidden`);
            }
        });

        container.appendChild(btn);
        container.dataset.hideDetailProcessed = 'true';
    }

    function processCards() {
        if (location.pathname.includes('/app/favorites')) {
            const s = document.getElementById(STYLES_ID);
            if (s && !s.disabled) s.disabled = true;
            return;
        }

        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            allHidden = false; titleModified = false; transient.clear();
            document.querySelectorAll('[data-hide-detail-processed="true"]')
                .forEach(el => el.removeAttribute('data-hide-detail-processed'));
            injectStyles();
        }

        const hidden = new Set(getHidden()),
              cells = gridCells(),
              sim = similares(cells);
        if (computeAll(cells, hidden, sim)) allHidden = true;
        syncTitle();
        syncTransient(hidden, cells, sim);
        injectToggle();
        processLinks(hidden);
        processItemDetail();
    }

    injectStyles();
    sync.init();
    setInterval(processCards, 1000);
    setInterval(() => sync.fetch(), SYNC_INTERVAL);
})();
