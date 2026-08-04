// ==UserScript==
// @name         Wallapop Hide Items (Synced)
// @namespace    http://tampermonkey.net/
// @version      1.0.1
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
          GIST_CFG = 'wallapop_gist_cfg', GIST_FILE = 'wallapop-blocked-items.json';

    let pushTimer = null, syncing = false;

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
            let c = GM_getValue(GIST_CFG);
            if (!c) {
                const id = prompt('GitHub Gist ID:\n\nExample: 95636bead4acf24062071058dcf9ea14');
                if (!id) return null;
                const token = prompt('GitHub Personal Access Token:\n\nGenerate at: Settings → Developer Settings → Tokens\nScope: gist');
                if (!token) return null;
                c = {id: id.trim(), token: token.trim()};
                GM_setValue(GIST_CFG, c);
            }
            return c;
        },

        fetch() {
            if (syncing || !this.cfg()) return;
            syncing = true;
            req('GET', `gists/${this.cfg().id}`)
                .then(r => {
                    const content = JSON.parse(r.responseText).files[GIST_FILE]?.content;
                    if (!content) return;
                    const remote = JSON.parse(content).blocked || [];
                    const local = getHidden();
                    const merged = [...new Set([...local, ...remote])];
                    if (merged.length > local.length) {
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
                        injectStyles();
                        console.log(`[wallapop_hide_items] Synced ${merged.length - local.length} new items from Gist`);
                    } else if (remote.length > 0) {
                        console.log(`[wallapop_hide_items] Fetched ${remote.length} items, already in sync`);
                    }
                })
                .catch(e => console.warn('[wallapop_hide_items] Fetch failed:', e.status || e))
                .finally(() => syncing = false);
        },

        push() {
            if (!this.cfg()) return;
            const payload = JSON.stringify({
                files: {
                    [GIST_FILE]: {
                        content: JSON.stringify({
                            blocked: getHidden(),
                            updated_at: new Date().toISOString(),
                            version: 1
                        }, null, 2)
                    }
                }
            });
            req('PATCH', `gists/${this.cfg().id}`, payload)
                .then(() => console.log(`[wallapop_hide_items] Pushed ${getHidden().length} items to Gist`))
                .catch(e => {
                    if (e.status === 429) setTimeout(() => this.push(), 60000);
                    else console.warn('[wallapop_hide_items] Push failed:', e.status || e);
                });
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
        if (!items.includes(id)) { items.push(id); localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); injectStyles(); sync.schedule(); }
    };

    const removeHidden = id => {
        if (!/^\d+$/.test(id)) return;
        const items = getHidden();
        const idx = items.indexOf(id);
        if (idx !== -1) { items.splice(idx, 1); localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); injectStyles(); sync.schedule(); }
    };

    const hideCard = link => { if (!disabled) link.closest('article, tsl-public-item-card')?.parentElement?.classList.add(FALLBACK_CLASS); };

    const showCard = link => { link.closest('article, tsl-public-item-card')?.parentElement?.classList.remove(FALLBACK_CLASS); };

    const btnText = () => disabled ? T.hide : T.show;

    function toggle() {
        disabled = !disabled;
        console.log(`[wallapop_hide_items] ${disabled ? 'Showing' : 'Hiding'} hidden items`);
        try { localStorage.setItem(TOGGLE_KEY, disabled ? '1' : '0'); } catch {}
        const s = document.getElementById(STYLES_ID);
        if (s) s.disabled = disabled;
        document.getElementById(TOGGLE_BTN_ID)?.setAttribute('text', btnText());
        document.querySelectorAll('[data-hide-processed="true"]').forEach(el => el.removeAttribute('data-hide-processed'));
        if (disabled) setTimeout(() => { fixCards(); processCards(); }, 50);
        else processCards();
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
                    btn.querySelector('svg')?.setAttribute('stroke', 'var(--chds-color-content-high, #29363d)');
                    btn.title = T.hideBtn;
                } else {
                    addHidden(id); hideCard(link); block(btn);
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

    function processCards() {
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            allHidden = false; titleModified = false; transient.clear();
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
    }

    injectStyles();
    sync.init();
    setInterval(processCards, 1000);
    setInterval(() => sync.fetch(), SYNC_INTERVAL);
})();
