// ==UserScript==
// @name         Wallapop Hide Items (Synced)
// @namespace    http://tampermonkey.net/
// @version      1.5.0
// @description  Hide specific items in Wallapop search results with multi-device sync
// @author       rauldzmartin@gmail.com
// @match        https://*.wallapop.com/*
// @exclude      https://*.wallapop.com/app/favorites/*
// @noframes
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
          RESERVED_KEY = 'wallapop_hide_reserved',
          RESERVED_CLASS = 'wallapop-hide-reserved',
          RESERVED_STYLES_ID = 'wallapop-reserved-styles',
          RESERVED_ROW_ID = 'wallapop-reserved-toggle-row',
          RESERVED_INPUT_ID = 'wallapop-hide-reserved-input',
          RESERVED_BADGE = 'wallapop-badge[badge-type="reserved"]',
          GRID = '[class*="ItemCardGrid"]',
          LIST = '[class*="ItemCardList"]',
          LINK = 'a[href*="/item/"]',
          TITLE = '[class*="SearchPageResults__title"] h2',
          SECTION = 'SearchPageResults__title',
          ID_RE = /-(\d+)(?:[/?#]|$)/,
          HIDE = `{position:absolute!important;clip-path:inset(100%)!important;pointer-events:none!important}`,
          ICON_COLOR = 'var(--chds-color-content-high, #29363d)',
          BLOCK_STROKE = 'var(--chds-color-negative-mid, #ce3528)',
          SYNC_INTERVAL = 30000, WRITE_DEBOUNCE = 2000,
          MUTATION_DELAY = 250, POLL_INTERVAL = 5000,
          GIST_CFG = 'wallapop_gist_cfg', GIST_FILE = 'wallapop-blocked-items.json',
          LAST_SYNCED_KEY = 'wallapop_last_synced_state', GIST_PROMPTED_KEY = 'wallapop_gist_prompted',
          TS_KEY = 'wallapop_hidden_ts', SEEN_KEY = 'wallapop_last_seen',
          CAP = 5000, MIN_KEEP = 50, SEEN_WINDOW = 60 * 86400000, DAY = 86400000;

    let cardsTimer = null, stateDirty = false;
    let tsMap = {}, seenMap = {}, seenDirty = false;
    try { tsMap = JSON.parse(localStorage.getItem(TS_KEY) || '{}'); } catch {}
    try { seenMap = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch {}

    const T = location.hostname.startsWith('es.') ? {
        hiddenTitle: 'Todos los artículos de esta búsqueda están ocultos. Usa «Mostrar ocultos» para verlos.',
        show: 'Mostrar ocultos', hide: 'Ocultar bloqueados',
        blocked: 'Este artículo está bloqueado.', hideBtn: 'Ocultar este artículo',
        reserved: 'Reservados', reservedDesc: 'Ocultar anuncios reservados'
    } : {
        hiddenTitle: 'All items in this search are hidden. Use "Show hidden" to view them.',
        show: 'Show hidden', hide: 'Hide blocked',
        blocked: 'This item is blocked.', hideBtn: 'Hide this item',
        reserved: 'Reserved', reservedDesc: 'Hide reserved items'
    };

    let disabled = (() => { try { return localStorage.getItem(TOGGLE_KEY) === '1'; } catch { return false; }})(),
        hideReserved = (() => { try { return localStorage.getItem(RESERVED_KEY) !== '0'; } catch { return true; }})(),
        lastPath = location.pathname, titleModified = false, allHidden = false,
        origTitle = null, titleUrl = '';
    
    const transient = new Set(),
          extractId = href => href?.match(ID_RE)?.[1] ?? null,
          cardId = c => extractId(c.querySelector(LINK)?.href),
          getHidden = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }},
          gridCells = () => [...document.querySelectorAll(`${GRID}>div`)];

    const key = arr => JSON.stringify([...(arr || [])].sort()),
          equal = (a, b) => key(a) === key(b),
          sanitize = arr => (Array.isArray(arr) ? arr : []).map(String).filter(x => /^\d+$/.test(x)),
          persistTs = () => { try { localStorage.setItem(TS_KEY, JSON.stringify(tsMap)); } catch {} },
          persistSeen = () => { if (seenDirty) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(seenMap)); } catch {} seenDirty = false; } },
          reconcileMeta = ids => {
              const set = new Set(ids), now = Date.now();
              ids.forEach(id => { if (!tsMap[id]) tsMap[id] = now; });
              for (const id of Object.keys(tsMap)) if (!set.has(id)) delete tsMap[id];
              for (const id of Object.keys(seenMap)) if (!set.has(id)) { delete seenMap[id]; seenDirty = true; }
              persistTs();
          },
          saveHidden = ids => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch {} reconcileMeta(ids); stateDirty = true; },
          persistSynced = () => { try { localStorage.setItem(LAST_SYNCED_KEY, JSON.stringify(sync.lastSyncedIds)); } catch {} },
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
          applyRemote = (remote, current, prev) => {
              if (prev === null) return [...new Set([...current, ...remote])];
              const prevSet = new Set(prev), curSet = new Set(current),
                    removed = new Set(prev.filter(id => !curSet.has(id)));
              return [...new Set([...remote, ...current.filter(id => !prevSet.has(id))])].filter(id => !removed.has(id));
          },
          markSeen = id => {
              const d = Math.floor(Date.now() / DAY);
              if (seenMap[id] === d) return;
              seenMap[id] = d; seenDirty = true;
          },
          prune = () => {
              const list = getHidden();
              if (!list.length) return;
              const now = Date.now(), remove = new Set();
              const ref = id => Math.max((seenMap[id] || 0) * DAY, tsMap[id] || 0);
              for (const id of list) if (now - ref(id) > SEEN_WINDOW && list.length - remove.size > MIN_KEEP) remove.add(id);
              if (list.length - remove.size > CAP) {
                  const byRef = list.filter(id => !remove.has(id)).sort((a, b) => ref(a) - ref(b));
                  for (const id of byRef) { if (list.length - remove.size <= CAP) break; remove.add(id); }
              }
              if (remove.size) {
                  saveHidden(list.filter(id => !remove.has(id)));
                  injectStyles();
                  console.log(`[wallapop_hide_items] Pruned ${remove.size} stale items (${list.length - remove.size} remaining)`);
              }
              persistSeen();
          };

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

    class GistSync {
        constructor() {
            this.pushTimer = null;
            this.queue = Promise.resolve();
            try { this.lastSyncedIds = JSON.parse(localStorage.getItem(LAST_SYNCED_KEY) || 'null'); } catch { this.lastSyncedIds = null; }
        }

        serial(fn) { const run = this.queue.then(fn); this.queue = run.catch(() => {}); return run; }

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
        }

        fetch() {
            const conf = this.cfg();
            if (!conf) return;
            this.serial(() => req('GET', `gists/${conf.id}`)
                .then(r => {
                    const remote = parseGist(r);
                    if (!remote || equal(remote.blocked, this.lastSyncedIds)) return;
                    const current = getHidden();
                    const merged = applyRemote(remote.blocked, current, this.lastSyncedIds);
                    if (!equal(merged, current)) {
                        saveHidden(merged);
                        injectStyles();
                        console.log(`[wallapop_hide_items] Synced ${merged.length} items from Gist`);
                    }
                    this.lastSyncedIds = remote.blocked;
                    persistSynced();
                    if (!equal(merged, remote.blocked)) this.schedule();
                })
                .catch(e => console.warn('[wallapop_hide_items] Fetch failed:', e.status || e)));
        }

        push() {
            const conf = this.cfg();
            if (!conf) return;
            this.serial(() => req('GET', `gists/${conf.id}`)
                .then(r => {
                    const remote = parseGist(r);
                    if (remote && !equal(remote.blocked, this.lastSyncedIds)) {
                        const current = getHidden();
                        const merged = applyRemote(remote.blocked, current, this.lastSyncedIds);
                        if (!equal(merged, current)) {
                            saveHidden(merged);
                            injectStyles();
                        }
                        this.lastSyncedIds = remote.blocked;
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
                        this.lastSyncedIds = local;
                        persistSynced();
                        console.log(`[wallapop_hide_items] Pushed ${local.length} items to Gist`);
                    });
                })
                .catch(e => {
                    if (e.status === 429) setTimeout(() => this.push(), 60000);
                    else console.warn('[wallapop_hide_items] Push failed:', e.status || e);
                }));
        }

        schedule() {
            clearTimeout(this.pushTimer);
            this.pushTimer = setTimeout(() => this.push(), WRITE_DEBOUNCE);
        }

        init() {
            if (this.cfg()) this.fetch();
        }
    }

    const sync = new GistSync();

    const similares = cells => {
        let last = -1, count = 0;
        cells.forEach((c, i) => { if ((c.className || '').includes(SECTION)) { last = i; count++; }});
        return count >= 2 ? new Set(cells.slice(last + 1)) : new Set();
    };

    const computeAll = (cells, hidden, sim, reserved) => {
        if (disabled) return false;
        const cards = cells.filter(c => c.querySelector(LINK) && !sim.has(c) && !reserved.has(c));
        return cards.length > 0 && cards.every(c => c.classList.contains(FALLBACK_CLASS) || hidden.has(cardId(c)));
    };

    const eyeIcon = (size = 16, center = true) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${ICON_COLOR}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="${center ? 'margin:auto;' : ''}display:block"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`,
          setBlockedState = (btn, blocked) => {
              btn.querySelector('svg')?.setAttribute('stroke', blocked ? BLOCK_STROKE : ICON_COLOR);
              btn.title = blocked ? T.blocked : T.hideBtn;
          };

    function injectStyles() {
        let s = document.getElementById(STYLES_ID);
        if (!s) { s = document.createElement('style'); s.id = STYLES_ID; (document.head || document.documentElement).appendChild(s); }
        const items = getHidden(),
              rules = [`.${FALLBACK_CLASS} ${HIDE}`];
        if (items.length) {
            // Boundary-safe: match only the full id (end of href or followed by a
            // URL separator) so short ids can't false-positive on longer ones.
            const byId = id => [
                `a[href$="-${id}"]`, `a[href*="-${id}/"]`, `a[href*="-${id}?"]`, `a[href*="-${id}#"]`
            ].join(',');
            const sel = items.flatMap(id => [
                `${GRID}>div:has(${byId(id)})`, `${LIST}>div:has(${byId(id)})`, `tsl-public-item-card:has(${byId(id)})`
            ]);
            rules.push(`${sel.join(',')} ${HIDE}`);
        }
        s.textContent = rules.join('\n');
        s.disabled = disabled;
    }

    const addHidden = id => {
        if (!/^\d+$/.test(id)) return;
        const items = getHidden();
        if (!items.includes(id)) {
            items.push(id); saveHidden(items); injectStyles(); sync.schedule();
            if (items.length > CAP) prune();
        }
    };

    const removeHidden = id => {
        if (!/^\d+$/.test(id)) return;
        const items = getHidden();
        const idx = items.indexOf(id);
        if (idx !== -1) { items.splice(idx, 1); saveHidden(items); injectStyles(); sync.schedule(); }
    };

    const hideCard = link => { if (!disabled) link.closest('article, tsl-public-item-card')?.parentElement?.classList.add(FALLBACK_CLASS); };

    const showCard = link => { link.closest('article, tsl-public-item-card')?.parentElement?.classList.remove(FALLBACK_CLASS); };

    const toggleHidden = (id, btn, link) => {
        const items = getHidden();
        if (items.includes(id)) {
            removeHidden(id); allHidden = false;
            if (link) showCard(link);
            setBlockedState(btn, false);
            console.log(`[wallapop_hide_items] Item ${id} unhidden`);
        } else {
            addHidden(id);
            if (link) hideCard(link);
            setBlockedState(btn, true);
            console.log(`[wallapop_hide_items] Item ${id} hidden`);
        }
    };

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
                setBlockedState(btn, true);
            } else {
                setBlockedState(btn, false);
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
                    setBlockedState(detailBtn, hidden.has(id));
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
        const url = location.pathname + location.search;
        if (url !== titleUrl) { titleUrl = url; origTitle = null; }
        if (origTitle === null) origTitle = title.textContent;
        // Latched: keep the informative title even if new cards arrive.
        if (!disabled && allHidden) {
            if (title.textContent !== T.hiddenTitle) title.textContent = T.hiddenTitle;
            titleModified = true;
        } else if (titleModified && title.textContent === T.hiddenTitle) {
            title.textContent = origTitle;
            titleModified = false;
        }
    }

    function injectReservedStyles() {
        let s = document.getElementById(RESERVED_STYLES_ID);
        if (!s) { s = document.createElement('style'); s.id = RESERVED_STYLES_ID; (document.head || document.documentElement).appendChild(s); }
        s.textContent = [
            `html.${RESERVED_CLASS} ${GRID}>div:has(${RESERVED_BADGE})`,
            `html.${RESERVED_CLASS} ${LIST}>div:has(${RESERVED_BADGE})`,
            `html.${RESERVED_CLASS} tsl-public-item-card:has(${RESERVED_BADGE})`
        ].join(',') + ` ${HIDE}`;
        s.disabled = false;
    }

    function toggleReserved() {
        hideReserved = !hideReserved;
        console.log(`[wallapop_hide_items] ${hideReserved ? 'Hiding' : 'Showing'} reserved items`);
        try { localStorage.setItem(RESERVED_KEY, hideReserved ? '1' : '0'); } catch {}
        document.documentElement.classList.toggle(RESERVED_CLASS, hideReserved);
        const input = document.getElementById(RESERVED_INPUT_ID);
        if (input) input.checked = hideReserved;
    }

    // Mirrors the "Shipping options" toggle row (wallapop-toggle + title +
    // description). The row classes/layout are cloned from the native one, but
    // the wallapop-toggle itself is created fresh: cloning a hydrated Stencil
    // component and mutating its props makes it re-render its template on top
    // of the copied DOM, producing duplicated toggles.
    function injectReservedToggle() {
        let row = document.getElementById(RESERVED_ROW_ID);
        if (row) {
            // Sanitize rows injected by older versions (duplicated toggle containers).
            let ok = true;
            row.querySelectorAll('wallapop-toggle').forEach(t => {
                if (t.querySelectorAll(':scope > .wallapop-toggle__container').length > 1) ok = false;
            });
            if (ok) return;
            row.remove();
        }
        const src = document.querySelector('[class*="SidebarFilter__container"]:has(wallapop-toggle)');
        if (!src) return;
        row = src.cloneNode(true);
        row.id = RESERVED_ROW_ID;
        const title = row.querySelector('[class*="ToggleSidebar__title"]');
        if (title) title.textContent = T.reserved;
        const desc = row.querySelector('.d-flex.flex-column span:not([class])');
        if (desc) desc.textContent = T.reservedDesc;
        row.querySelector('wallapop-toggle')?.replaceWith(document.createElement('wallapop-toggle'));
        const toggle = row.querySelector('wallapop-toggle');
        if (toggle) {
            toggle.setAttribute('input-id', RESERVED_INPUT_ID);
            toggle.setAttribute('aria-label', T.reservedDesc);
        }
        src.after(row);
    }

    // Wires the fresh wallapop-toggle once its hydration renders the input,
    // and keeps its checked state in sync every tick.
    function wireReservedToggle() {
        const row = document.getElementById(RESERVED_ROW_ID);
        if (!row) return;
        const input = row.querySelector('wallapop-toggle input');
        if (input) {
            if (!input.dataset.wallapopWired) {
                input.dataset.wallapopWired = '1';
                input.addEventListener('change', () => { if (input.checked !== hideReserved) toggleReserved(); });
            }
            input.checked = hideReserved;
        }
        const btn = row.querySelector('.d-flex[role="button"]');
        if (btn && !btn.dataset.wallapopWired) {
            btn.dataset.wallapopWired = '1';
            btn.addEventListener('click', toggleReserved);
            btn.addEventListener('keydown', e => {
                if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleReserved(); }
            });
        }
    }

    function syncTransient(hidden, cells, sim, reserved) {
        const tr = allHidden && !disabled;
        cells.forEach(cell => {
            if (reserved.has(cell)) return;
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
            btn.innerHTML = eyeIcon();

            if (hidden.has(id)) setBlockedState(btn, true);
            btn.addEventListener('click', e => {
                e.preventDefault(); e.stopPropagation();
                toggleHidden(id, btn, link);
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
        btn.innerHTML = eyeIcon(24, false);

        // Anchor to top-right, mirroring the favorite's bottom:20px / right:20px
        btn.style.position = 'absolute';
        btn.style.top = '20px';
        btn.style.right = '20px';
        btn.style.zIndex = '2';

        const hidden = getHidden();
        if (hidden.includes(id)) setBlockedState(btn, true);

        btn.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            toggleHidden(id, btn);
        });

        container.appendChild(btn);
        container.dataset.hideDetailProcessed = 'true';
    }

    function processCards() {
        if (location.pathname.includes('/app/favorites')) {
            const s = document.getElementById(STYLES_ID);
            if (s && !s.disabled) s.disabled = true;
            const rs = document.getElementById(RESERVED_STYLES_ID);
            if (rs && !rs.disabled) rs.disabled = true;
            return;
        }

        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            allHidden = false; titleModified = false; transient.clear();
            document.querySelectorAll('[data-hide-detail-processed="true"]')
                .forEach(el => el.removeAttribute('data-hide-detail-processed'));
            injectStyles();
            injectReservedStyles();
        }

        const hidden = new Set(getHidden()),
              cells = gridCells(),
              sim = similares(cells),
              reserved = new Set(cells.filter(c => c.querySelector(RESERVED_BADGE)));
        cells.forEach(c => { const id = cardId(c); if (id && hidden.has(id)) markSeen(id); });
        if (computeAll(cells, hidden, sim, reserved)) allHidden = true;
        if (stateDirty) { stateDirty = false; updateButtonsState(); }
        syncTitle();
        syncTransient(hidden, cells, sim, reserved);
        injectToggle();
        injectReservedToggle();
        wireReservedToggle();
        processLinks(hidden);
        processItemDetail();
    }

    function scheduleCards() {
        if (cardsTimer) return;
        cardsTimer = setTimeout(() => { cardsTimer = null; processCards(); }, MUTATION_DELAY);
    }

    document.documentElement.classList.toggle(RESERVED_CLASS, hideReserved);
    injectReservedStyles();
    injectStyles();
    prune();
    sync.init();
    new MutationObserver(scheduleCards).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(processCards, POLL_INTERVAL);
    setInterval(() => sync.fetch(), SYNC_INTERVAL);
    setInterval(persistSeen, 30000);
    setInterval(prune, DAY);
})();
