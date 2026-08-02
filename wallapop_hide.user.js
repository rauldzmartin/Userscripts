// ==UserScript==
// @name         Wallapop Hide Items
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Hide specific items in Wallapop search results
// @author       Antigravity
// @match        https://es.wallapop.com/*
// @match        https://wallapop.com/*
// @exclude      https://es.wallapop.com/app/favorites/*
// @exclude      https://wallapop.com/app/favorites/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=wallapop.com
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'wallapop_hidden_items';
    const HIDDEN_TITLE_TEXT = 'Todos los artículos de esta búsqueda están ocultos. Usa «Mostrar ocultos» para verlos.';
    // State variable for toggling (resets on F5)
    let isHidingDisabled = false;
    // Last processed pathname, to react to SPA navigation
    let lastProcessedPath = window.location.pathname;
    // Whether we replaced the grid title with our informative text
    let titleModified = false;
    // Transient hiding of new cards while ALL visible cards are hidden
    let allHiddenActive = false;
    const transientIds = new Set();

    function isFavoritesPage() {
        return window.location.pathname.includes('/app/favorites');
    }

    function getHiddenItems() {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    }

    function injectStyles() {
        let styleElement = document.getElementById('wallapop-hide-styles');
        if (!styleElement) {
            styleElement = document.createElement('style');
            styleElement.id = 'wallapop-hide-styles';
            const parent = document.head || document.documentElement;
            if (parent) parent.appendChild(styleElement);
        }
        
        const items = getHiddenItems();
        let cssRules = `.wallapop-hidden-fallback { 
            position: absolute !important; 
            top: 0 !important; 
            left: 0 !important; 
            clip-path: inset(100%) !important; 
            pointer-events: none !important; 
        }`;
        
        if (items.length > 0 && !isFavoritesPage()) {
            const rules = items.map(id => {
                const href = `a[href*="-${id}"]`;
                return `[class*="ItemCardGrid"] > div:has(${href}), [class*="ItemCardList"] > div:has(${href}), tsl-public-item-card:has(${href})`;
            }).join(', ');
            
            cssRules += `\n${rules} { 
                position: absolute !important; 
                top: 0 !important; 
                left: 0 !important; 
                clip-path: inset(100%) !important; 
                pointer-events: none !important; 
            }`;
        }
        
        styleElement.textContent = cssRules;
        styleElement.disabled = isHidingDisabled;
    }

    function addHiddenItem(id) {
        const items = getHiddenItems();
        if (!items.includes(id)) {
            items.push(id);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
            injectStyles(); // Update CSS rules immediately
        }
    }

    // Inject styles as soon as possible
    injectStyles();

    function extractItemId(href) {
        if (!href) return null;
        const match = href.match(/-(\d+)(?:[/?#]|$)/);
        return match ? match[1] : null;
    }

    function hideCard(card) {
        if (isHidingDisabled) return;
        
        const article = card.closest('article, tsl-public-item-card');
        if (article) {
            const gridCell = article.parentElement;
            if (gridCell) {
                gridCell.classList.add('wallapop-hidden-fallback');
            }
        } else {
            const container = card.closest('[class*="ItemCardList__item"]') || card;
            container.classList.add('wallapop-hidden-fallback');
        }
    }

    function setBlockedState(btn) {
        const svg = btn.querySelector('svg');
        if (svg) svg.setAttribute('stroke', 'var(--chds-color-negative-mid, #ce3528)');
        btn.title = 'Este artículo está bloqueado.';
    }

    function toggleHiddenItems() {
        isHidingDisabled = !isHidingDisabled;
        
        const styleElement = document.getElementById('wallapop-hide-styles');
        if (styleElement) {
            styleElement.disabled = isHidingDisabled;
        }

        const btn = document.getElementById('wallapop-toggle-hidden-btn');
        if (btn) {
            btn.setAttribute('text', isHidingDisabled ? 'Ocultar bloqueados' : 'Mostrar ocultos (' + getHiddenItems().length + ')');
        }

        // Fix React lazy loading glitches when unhiding
        if (isHidingDisabled) {
            setTimeout(() => {
                // 1. Force native lazy images to load instantly
                document.querySelectorAll('img[loading="lazy"]').forEach(img => {
                    img.removeAttribute('loading');
                });

                // 2. Repair cards that Wallapop initialized while hidden: it collapsed
                //    the carousel link and title link to display:none permanently.
                //    Restore them so image and title render correctly.
                const hidden = getHiddenItems();
                document.querySelectorAll('[class*="ItemCardGrid"] > div, [class*="ItemCardList"] > div').forEach(cell => {
                    const link = cell.querySelector('a[href*="/item/"]');
                    if (!link) return;
                    const itemId = extractItemId(link.href);
                    if (!itemId || (!hidden.includes(itemId) && !transientIds.has(itemId))) return;
                    const carLink = cell.querySelector('a[class*="carousel__link"]');
                    const titleLink = cell.querySelector('a[class*="titleLink"]');
                    if (carLink && getComputedStyle(carLink).display === 'none') {
                        carLink.style.removeProperty('display');
                    }
                    if (titleLink && getComputedStyle(titleLink).display === 'none') {
                        titleLink.style.removeProperty('display');
                    }
                });

                // 3. Dispatch a resize event which forces most text-truncation and carousel scripts to remeasure
                window.dispatchEvent(new Event('resize', { bubbles: true }));
                
                // 4. Jiggle the scroll position to trigger IntersectionObservers
                window.scrollBy(0, 1);
                setTimeout(() => window.scrollBy(0, -1), 20);
            }, 50);
        }
    }

    function injectToggleButton() {
        if (document.getElementById('wallapop-toggle-hidden-btn')) {
            // Update count if needed
            const btn = document.getElementById('wallapop-toggle-hidden-btn');
            const expectedText = isHidingDisabled ? 'Ocultar bloqueados' : 'Mostrar ocultos (' + getHiddenItems().length + ')';
            if (btn.getAttribute('text') !== expectedText) {
                btn.setAttribute('text', expectedText);
            }
            return;
        }
        
        const bubblesContainer = document.querySelector('[class*="SearchPage__bubbles"] > .d-flex.flex-wrap');
        if (bubblesContainer) {
            const btn = document.createElement('walla-button');
            btn.id = 'wallapop-toggle-hidden-btn';
            btn.setAttribute('button-type', 'link');
            btn.setAttribute('size', 'large');
            btn.setAttribute('text', isHidingDisabled ? 'Ocultar bloqueados' : 'Mostrar ocultos (' + getHiddenItems().length + ')');
            btn.addEventListener('click', toggleHiddenItems);
            
            bubblesContainer.appendChild(btn);
        }
    }

    function isCardHidden(cell, hiddenItems) {
        return cell.classList.contains('wallapop-hidden-fallback') ||
            hiddenItems.some(id => cell.querySelector('a[href*="-' + id + '"]'));
    }

    // Cells located AFTER the last section title in the grid belong to the
    // native "Similares a tu búsqueda" block (recommendations). They must stay
    // visible: only the search results count for the all-hidden state.
    function isSimilaresCell(cell) {
        const grid = document.querySelector('[class*="ItemCardGrid"]');
        if (!grid || !cell) return false;
        const titles = [...grid.querySelectorAll(':scope > [class*="SearchPageResults__title"]')];
        if (titles.length < 2) return false;
        const lastTitle = titles[titles.length - 1];
        return !!(lastTitle.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    function computeAllHidden() {
        if (isHidingDisabled) return false;
        const hidden = getHiddenItems();
        const cells = [...document.querySelectorAll('[class*="ItemCardGrid"] > div')];
        const cards = cells.filter(cell => cell.querySelector('a[href*="/item/"]') && !isSimilaresCell(cell));
        if (cards.length === 0) return false;
        const hiddenCount = cards.filter(cell => isCardHidden(cell, hidden)).length;
        return hiddenCount === cards.length;
    }

    function updateResultsTitle() {
        if (isFavoritesPage()) return;
        // Find the results grid title by class (works in any language)
        const title = document.querySelector('[class*="SearchPageResults__title"] h2');
        if (!title) return;
        if (!title.dataset.wallapopOrigTitle) {
            title.dataset.wallapopOrigTitle = title.textContent;
        }

        const allHidden = computeAllHidden();
        if (allHidden) {
            allHiddenActive = true;
        }

        // Latched state: once all cards are hidden, keep the informative title
        // even if new cards arrive afterwards (they get hidden transiently).
        const showInformative = !isHidingDisabled && allHiddenActive;

        if (showInformative) {
            if (title.textContent !== HIDDEN_TITLE_TEXT) {
                title.textContent = HIDDEN_TITLE_TEXT;
            }
            titleModified = true;
        } else if (titleModified && title.textContent === HIDDEN_TITLE_TEXT) {
            // Only restore if we actually changed it, so React re-renders are respected
            title.textContent = title.dataset.wallapopOrigTitle;
            titleModified = false;
        }
    }

    function processCards() {
        if (window.location.pathname !== lastProcessedPath) {
            lastProcessedPath = window.location.pathname;
            allHiddenActive = false;
            titleModified = false;
            transientIds.clear();
            injectStyles();
        }

        if (isFavoritesPage()) return;

        updateResultsTitle();

        if (computeAllHidden()) {
            allHiddenActive = true;
        }

        // While the all-hidden state is latched, transiently hide any card that
        // is not in the hidden list (native "load more" pagination keeps loading
        // new cards), so the all-hidden state persists.
        if (allHiddenActive && !isHidingDisabled) {
            const hidden = getHiddenItems();
            document.querySelectorAll('[class*="ItemCardGrid"] > div').forEach(cell => {
                const link = cell.querySelector('a[href*="/item/"]');
                if (!link) return;
                const id = extractItemId(link.href);

                if (isSimilaresCell(cell)) {
                    // Similares block cards stay visible; drop any transiently
                    // applied hidden class (unless the user hid them explicitly).
                    if (id && !hidden.includes(id)) {
                        cell.classList.remove('wallapop-hidden-fallback');
                        transientIds.delete(id);
                    }
                    return;
                }

                if (!id || hidden.includes(id)) return;
                if (!cell.classList.contains('wallapop-hidden-fallback')) {
                    cell.classList.add('wallapop-hidden-fallback');
                    transientIds.add(id);
                }
            });
        } else if (isHidingDisabled && transientIds.size > 0) {
            // Toggle "Mostrar ocultos" ON: reveal transiently hidden cards
            const hidden = getHiddenItems();
            document.querySelectorAll('[class*="ItemCardGrid"] > div').forEach(cell => {
                const link = cell.querySelector('a[href*="/item/"]');
                if (!link) return;
                const id = extractItemId(link.href);
                if (id && transientIds.has(id) && !hidden.includes(id)) {
                    cell.classList.remove('wallapop-hidden-fallback');
                }
            });
        }

        injectToggleButton();

        const hiddenItems = getHiddenItems();
        const links = document.querySelectorAll('a[href*="/item/"]');
        
        links.forEach(link => {
            const itemId = extractItemId(link.href);
            if (!itemId) return;

            const cardInner = link.closest('[class*="RetrievalItemCard__image"]') || link.parentElement.parentElement;
            if (!cardInner || cardInner.dataset.hideProcessed === 'true') return;

            if (hiddenItems.includes(itemId)) {
                hideCard(link);
                // We still tag it as processed so we don't process it multiple times, 
                // but we also attach the hide button just in case we are showing hidden items
                cardInner.dataset.hideProcessed = 'true';
                
                // We can continue to inject the button, but we shouldn't return here if we want the button injected!
                // Wait, if it's hidden, we DO want the button injected so they can see it when unhidden.
            }

            const favBtn = cardInner.querySelector('button[aria-label="Save as favorite"], button [icon^="heart"]');
            
            if (favBtn) {
                const topOverlay = cardInner.querySelector('[class*="overlay--top"]');
                let targetSlot = null;
                
                if (topOverlay) {
                    const slots = topOverlay.querySelectorAll('[class*="overlaySlot"]');
                    if (slots.length > 1) {
                        targetSlot = slots[1];
                    } else if (slots.length > 0) {
                        targetSlot = slots[0];
                    }
                }

                const hideBtn = document.createElement('button');
                hideBtn.type = 'button';
                hideBtn.className = favBtn.className;
                hideBtn.setAttribute('aria-label', 'Hide item');
                hideBtn.title = 'Ocultar este artículo';
                
                hideBtn.style.width = '32px';
                hideBtn.style.height = '32px';
                hideBtn.style.display = 'flex';
                hideBtn.style.alignItems = 'center';
                hideBtn.style.justifyContent = 'center';
                hideBtn.style.padding = '0';
                
                hideBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--chds-color-content-high, #29363d)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="margin: auto; display: block;"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
                
                // If item is already hidden but we are in "show hidden" mode, change the style to indicate it's blocked
                if (hiddenItems.includes(itemId)) {
                    setBlockedState(hideBtn);
                }

                hideBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    addHiddenItem(itemId);
                    hideCard(link);
                    // If we are showing hidden items, reflect the new blocked state right away
                    setBlockedState(hideBtn);
                });

                let elementToInject = hideBtn;
                if (favBtn.parentElement && favBtn.parentElement.tagName === 'SPAN') {
                    const span = document.createElement('span');
                    span.className = favBtn.parentElement.className;
                    span.appendChild(hideBtn);
                    elementToInject = span;
                }

                if (targetSlot) {
                    targetSlot.appendChild(elementToInject);
                } else {
                    const hideContainer = document.createElement('div');
                    hideContainer.style.position = 'absolute';
                    hideContainer.style.top = '8px';
                    hideContainer.style.right = '8px';
                    hideContainer.style.zIndex = '10';
                    hideContainer.appendChild(elementToInject);
                    cardInner.style.position = 'relative';
                    cardInner.appendChild(hideContainer);
                }
                
                cardInner.dataset.hideProcessed = 'true';
            }
        });
    }

    setInterval(processCards, 1000);
    window.addEventListener('load', processCards);
})();
