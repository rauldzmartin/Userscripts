// ==UserScript==
// @name         Wallapop Hide Items
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  Hide specific items in Wallapop search results
// @author       rauldzmartin@gmail.com
// @match        https://*.wallapop.com/*
// @exclude      https://*.wallapop.com/app/favorites/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=wallapop.com
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const STORAGE_KEY = 'wallapop_hidden_items';
    const FALLBACK_CLASS = 'wallapop-hidden-fallback';
    const STYLES_ID = 'wallapop-hide-styles';
    const TOGGLE_BTN_ID = 'wallapop-toggle-hidden-btn';
    const GRID_SELECTOR = '[class*="ItemCardGrid"]';
    const LIST_SELECTOR = '[class*="ItemCardList"]';
    const ITEM_LINK_SELECTOR = 'a[href*="/item/"]';
    const TITLE_SELECTOR = '[class*="SearchPageResults__title"] h2';
    const SECTION_TITLE_CLASS = 'SearchPageResults__title';
    const ITEM_ID_RE = /-(\d+)(?:[/?#]|$)/;
    const HIDE_RULE = `{
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        clip-path: inset(100%) !important;
        pointer-events: none !important;
    }`;

    // User-facing texts adapt to the site language (es.wallapop.com vs rest)
    const T = location.hostname.startsWith('es.')
        ? {
            hiddenTitle: 'Todos los artículos de esta búsqueda están ocultos. Usa «Mostrar ocultos» para verlos.',
            show: 'Mostrar ocultos',
            hide: 'Ocultar bloqueados',
            blocked: 'Este artículo está bloqueado.',
            hideBtn: 'Ocultar este artículo',
        }
        : {
            hiddenTitle: 'All items in this search are hidden. Use "Show hidden" to view them.',
            show: 'Show hidden',
            hide: 'Hide blocked',
            blocked: 'This item is blocked.',
            hideBtn: 'Hide this item',
        };

    let isHidingDisabled = false;
    let lastPath = location.pathname;
    let titleModified = false;
    let allHiddenActive = false;
    const transientIds = new Set();

    const isFavorites = () => location.pathname.includes('/app/favorites');
    const gridCells = () => [...document.querySelectorAll(`${GRID_SELECTOR} > div`)];
    const extractId = href => href?.match(ITEM_ID_RE)?.[1] ?? null;
    const cardId = cell => extractId(cell.querySelector(ITEM_LINK_SELECTOR)?.href);

    function getHiddenItems() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        } catch {
            return [];
        }
    }

    // Cells after the LAST section title are the native "Similares" block:
    // never counted as results and never transiently hidden.
    function similaresCells() {
        const cells = gridCells();
        let last = -1, count = 0;
        cells.forEach((cell, i) => {
            if ((cell.className || '').includes(SECTION_TITLE_CLASS)) {
                last = i;
                count++;
            }
        });
        return count >= 2 ? cells.slice(last + 1) : [];
    }

    function computeAllHidden(hidden) {
        if (isHidingDisabled) return false;
        const similares = new Set(similaresCells());
        const cards = gridCells().filter(cell =>
            cell.querySelector(ITEM_LINK_SELECTOR) && !similares.has(cell));
        return cards.length > 0 && cards.every(cell =>
            cell.classList.contains(FALLBACK_CLASS) || hidden.has(cardId(cell)));
    }

    function injectStyles() {
        let style = document.getElementById(STYLES_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = STYLES_ID;
            (document.head || document.documentElement).appendChild(style);
        }
        const items = getHiddenItems();
        const rules = [`.${FALLBACK_CLASS} ${HIDE_RULE}`];
        if (items.length && !isFavorites()) {
            const selectors = items.flatMap(id => [
                `${GRID_SELECTOR} > div:has(a[href*="-${id}"])`,
                `${LIST_SELECTOR} > div:has(a[href*="-${id}"])`,
                `tsl-public-item-card:has(a[href*="-${id}"])`,
            ]);
            rules.push(`${selectors.join(', ')} ${HIDE_RULE}`);
        }
        style.textContent = rules.join('\n');
        style.disabled = isHidingDisabled;
    }

    function addHiddenItem(id) {
        if (!/^\d+$/.test(id)) return;
        const items = getHiddenItems();
        if (!items.includes(id)) {
            items.push(id);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
            injectStyles();
        }
    }

    function hideCard(link) {
        if (isHidingDisabled) return;
        const article = link.closest('article, tsl-public-item-card');
        if (!article) {
            (link.closest(`${LIST_SELECTOR}__item`) || link).classList.add(FALLBACK_CLASS);
            return;
        }
        article.parentElement?.classList.add(FALLBACK_CLASS);
    }

    function setBlockedState(btn) {
        btn.querySelector('svg')?.setAttribute('stroke', 'var(--chds-color-negative-mid, #ce3528)');
        btn.title = T.blocked;
    }

    const toggleBtnText = () => isHidingDisabled ? T.hide : T.show;

    function toggleHiddenItems() {
        isHidingDisabled = !isHidingDisabled;
        const style = document.getElementById(STYLES_ID);
        if (style) style.disabled = isHidingDisabled;
        document.getElementById(TOGGLE_BTN_ID)?.setAttribute('text', toggleBtnText());
        if (isHidingDisabled) setTimeout(fixHiddenCards, 50);
    }

    // Repair cards Wallapop initialized while hidden (collapsed carousel/title
    // links), force lazy images, and nudge scroll/measure to re-run observers.
    function fixHiddenCards() {
        document.querySelectorAll('img[loading="lazy"]').forEach(img => img.removeAttribute('loading'));
        const hidden = new Set(getHiddenItems());
        document.querySelectorAll(`${GRID_SELECTOR} > div, ${LIST_SELECTOR} > div`).forEach(cell => {
            const id = cardId(cell);
            if (!id || (!hidden.has(id) && !transientIds.has(id))) return;
            ['carousel__link', 'titleLink'].forEach(cls => {
                const el = cell.querySelector(`a[class*="${cls}"]`);
                if (el && getComputedStyle(el).display === 'none') el.style.removeProperty('display');
            });
        });
        window.dispatchEvent(new Event('resize', { bubbles: true }));
        window.scrollBy(0, 1);
        setTimeout(() => window.scrollBy(0, -1), 20);
    }

    function injectToggleButton() {
        const btn = document.getElementById(TOGGLE_BTN_ID);
        if (btn) {
            if (btn.getAttribute('text') !== toggleBtnText()) btn.setAttribute('text', toggleBtnText());
            return;
        }
        const container = document.querySelector('[class*="SearchPage__bubbles"] > .d-flex.flex-wrap');
        if (!container) return;
        const el = document.createElement('walla-button');
        el.id = TOGGLE_BTN_ID;
        el.setAttribute('button-type', 'link');
        el.setAttribute('size', 'large');
        el.setAttribute('text', toggleBtnText());
        el.addEventListener('click', toggleHiddenItems);
        container.appendChild(el);
    }

    function syncTitle(hidden, allHidden) {
        const title = document.querySelector(TITLE_SELECTOR);
        if (!title) return;
        if (!title.dataset.wallapopOrigTitle) title.dataset.wallapopOrigTitle = title.textContent;
        if (allHidden) allHiddenActive = true;
        // Latched: once everything is hidden, keep the informative title even
        // if new cards arrive (they get transiently hidden).
        if (!isHidingDisabled && allHiddenActive) {
            if (title.textContent !== T.hiddenTitle) title.textContent = T.hiddenTitle;
            titleModified = true;
        } else if (titleModified && title.textContent === T.hiddenTitle) {
            title.textContent = title.dataset.wallapopOrigTitle;
            titleModified = false;
        }
    }

    function syncTransient(hidden) {
        const transient = allHiddenActive && !isHidingDisabled;
        const similares = new Set(similaresCells());
        gridCells().forEach(cell => {
            const id = cardId(cell);
            if (!id) return;
            const fallback = cell.classList.contains(FALLBACK_CLASS);
            if (similares.has(cell)) {
                // Similares stay visible; drop transient classes unless the
                // user hid that exact item.
                if (!hidden.has(id) && (transient || transientIds.has(id))) {
                    cell.classList.remove(FALLBACK_CLASS);
                    transientIds.delete(id);
                }
            } else if (!hidden.has(id)) {
                if (transient && !fallback) {
                    cell.classList.add(FALLBACK_CLASS);
                    transientIds.add(id);
                } else if (!transient && fallback && transientIds.has(id)) {
                    cell.classList.remove(FALLBACK_CLASS);
                }
            }
        });
    }

    function processLinks(hidden) {
        document.querySelectorAll(ITEM_LINK_SELECTOR).forEach(link => {
            const id = extractId(link.href);
            if (!id) return;
            const inner = link.closest('[class*="RetrievalItemCard__image"]') || link.parentElement.parentElement;
            if (!inner || inner.dataset.hideProcessed === 'true') return;

            if (hidden.has(id)) {
                hideCard(link);
                inner.dataset.hideProcessed = 'true';
            }

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
            Object.assign(btn.style, {
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0',
            });
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--chds-color-content-high, #29363d)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="margin: auto; display: block;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

            if (hidden.has(id)) setBlockedState(btn);
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                addHiddenItem(id);
                hideCard(link);
                setBlockedState(btn);
            });

            let host = btn;
            if (favBtn.parentElement?.tagName === 'SPAN') {
                host = document.createElement('span');
                host.className = favBtn.parentElement.className;
                host.appendChild(btn);
            }

            if (target) {
                target.appendChild(host);
            } else {
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
            allHiddenActive = false;
            titleModified = false;
            transientIds.clear();
            injectStyles();
        }
        if (isFavorites()) return;

        const hidden = new Set(getHiddenItems());
        const allHidden = computeAllHidden(hidden);
        if (allHidden) allHiddenActive = true;
        syncTitle(hidden, allHidden);
        syncTransient(hidden);
        injectToggleButton();
        processLinks(hidden);
    }

    injectStyles();
    setInterval(processCards, 1000);
    window.addEventListener('load', processCards);
})();
