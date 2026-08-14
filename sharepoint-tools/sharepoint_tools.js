// ==UserScript==
// @name         SharePoint Tools
// @namespace    http://tampermonkey.net/
// @version      2.9
// @description
// @match        https://*.sharepoint.com/sites/*/*
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /**
   * OData/system keys returned by the SP REST API that carry no business value.
   * Filtered out of every item before serialisation.
   */
  const SKIP_KEYS = new Set([
    "odata.type",
    "odata.id",
    "odata.etag",
    "odata.editLink",
    "FileSystemObjectType",
    "ServerRedirectedEmbedUri",
    "ServerRedirectedEmbedUrl",
    "ContentTypeId",
    "ComplianceAssetId",
    "OData__UIVersionString",
    "OData__ColorTag",
    "OData__ComplianceFlags",
    "OData__ComplianceTag",
    "OData__ComplianceTagWrittenTime",
    "OData__ComplianceTagUserId",
    "OData__IsRecord",
    "Attachments",
    "GUID",
    "ID",
  ]);

  /**
   * Internal field names that survive the `Hidden eq false` filter but still
   * represent SP infrastructure rather than user-defined schema.
   */
  const SKIP_INTERNAL = new Set([
    "_ModerationComments",
    "File_x0020_Type",
    "Edit",
    "LinkTitleNoMenu",
    "LinkTitle",
    "LinkTitle2",
    "DocIcon",
    "SelectTitle",
    "SelectFilename",
    "HTMLFileType",
    "_HasCopyDestinations",
    "_CopySource",
    "owshiddenversion",
    "WorkflowVersion",
    "_UIVersion",
    "_UIVersionString",
    "InstanceID",
    "Order0",
    "GUID",
    "WorkflowInstanceID",
    "ParentVersionString",
    "ParentLeafName",
    "_ColorTag",
    "ComplianceAssetId",
    "ItemChildCount",
    "FolderChildCount",
    "_ComplianceFlags",
    "_ComplianceTag",
    "_ComplianceTagWrittenTime",
    "_ComplianceTagUserId",
    "_IsRecord",
    "AppAuthor",
    "AppEditor",
  ]);

  /** Human-readable labels for the most common SP base template IDs. */
  const BASE_TEMPLATE_LABELS = {
    100: "Custom List",
    101: "Document Library",
    106: "Events",
    107: "Tasks",
    108: "Discussion Board",
    109: "Survey",
    119: "Site Pages",
    171: "Tasks (modern)",
    850: "Pages",
    3100: "External List",
  };

  /** Visual config for each toast severity level. */
  const TOAST_CONFIG = {
    success: { bg: "#107c10", icon: "✅" },
    error: { bg: "#a4262c", icon: "❌" },
    loading: { bg: "#0078d4", icon: "⏳" },
    info: { bg: "#605e5c", icon: "ℹ️" },
  };

  /** Menu action configuration (enabled/disabled depending on page). */
  const MENU_ACTIONS = {
    list: {
      label: "Copy list",
      helper: "Metadata + samples to clipboard",
      title: "Copy active list metadata (Alt+C)",
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
               <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
               <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
             </svg>`,
    },
    "site-contents": {
      label: "Export site",
      helper: "Full site structure as JSON",
      title: "Export site structure (Alt+C)",
      icon: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
               <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
               <polyline points="7 10 12 15 17 10"/>
               <line x1="12" y1="15" x2="12" y2="3"/>
             </svg>`,
    },
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Sends an authenticated GET request to the SP REST API and returns the
   * parsed JSON body. Uses `odata=nometadata` to minimise response noise.
   *
   * @param {string} url - Fully qualified REST endpoint.
   * @returns {Promise<object>}
   */
  const apiFetch = (url) =>
    fetch(url, { headers: { Accept: "application/json;odata=nometadata" } }).then((r) => r.json());

  /**
   * Returns a copy of a list item with all infrastructure keys removed.
   * Also strips any `*StringId` shadow keys generated for lookup columns.
   *
   * @param {object} record - Raw item from the SP REST response.
   * @returns {object}
   */
  const cleanItem = (record) =>
    Object.fromEntries(
      Object.entries(record).filter(
        ([k]) =>
          !SKIP_KEYS.has(k) &&
          !k.endsWith("StringId") &&
          !k.startsWith("OData_") &&
          !k.includes("MediaService"),
      ),
    );

  /**
   * Fetches ALL items from a list using automatic pagination.
   * SharePoint REST API has a max of 5000 items per request and returns
   * `odata.nextLink` when there are more results.
   *
   * @param {string} baseUrl - Base URL for the list items endpoint.
   * @param {number} [retryCount=0] - Internal retry counter for throttling.
   * @returns {Promise<Array>} All items with cleanItem() applied.
   */
  async function fetchAllItems(baseUrl, retryCount = 0) {
    const items = [];
    let nextUrl = `${baseUrl}?$top=5000`;

    while (nextUrl) {
      try {
        const response = await fetch(nextUrl, {
          headers: { Accept: "application/json;odata=verbose" },
        }).then((r) => {
          if (r.status === 429) {
            // Throttling - throw to trigger retry
            throw new Error("THROTTLED");
          }
          return r.json();
        });

        const batch = response.d?.results ?? response.value ?? [];
        items.push(...batch.map(cleanItem));

        // Check for next page (odata.nextLink or __next)
        nextUrl = response["odata.nextLink"] || response.d?.__next || null;
      } catch (err) {
        if (err.message === "THROTTLED" && retryCount < 5) {
          // Exponential backoff: 200ms, 400ms, 800ms, 1600ms, 3200ms
          const delay = 200 * Math.pow(2, retryCount);
          await new Promise((resolve) => setTimeout(resolve, delay));
          return fetchAllItems(baseUrl, retryCount + 1);
        }
        throw err;
      }
    }

    return items;
  }

  /**
   * Updates an existing toast element with current progress.
   *
   * @param {HTMLElement} toastEl - The toast element to update.
   * @param {number} current - Current list index (1-based).
   * @param {number} total - Total number of lists.
   * @param {string} listTitle - Title of the current list being processed.
   */
  function updateProgressToast(toastEl, current, total, listTitle) {
    if (!toastEl) return;
    const percent = Math.round((current / total) * 100);
    toastEl.innerText = `⏳  Procesando lista ${current}/${total} (${percent}%): ${listTitle}...`;
  }

  /**
   * Returns the operational mode for the current page:
   *   'list'          — an active SP list or library is in context
   *   'site-contents' — the Site Contents overview page (_layouts/15/viewlsts.aspx)
   *   null            — neither; no button should be shown
   *
   * @returns {'list'|'site-contents'|null}
   */
  function detectPageType() {
    if (location.pathname.toLowerCase().includes("viewlsts.aspx")) return "site-contents";
    if (_spPageContextInfo?.listTitle) return "list";
    return null;
  }

  /**
   * Builds a zero-padded ddmmyyHHMMSS timestamp string from a Date object.
   *
   * @param {Date} d
   * @returns {string} e.g. "130426150842"
   */
  function formatTimestamp(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${pad(d.getDate())}${pad(d.getMonth() + 1)}${String(d.getFullYear()).slice(2)}` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
  }

  /**
   * Triggers a file download in the browser using a Blob object URL.
   *
   * @param {string} filename - Suggested file name including extension.
   * @param {string} content  - File content as a UTF-8 string.
   * @param {string} [mime]   - MIME type (defaults to application/json).
   */
  function downloadFile(filename, content, mime = "application/json") {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // Toast notifications
  // ---------------------------------------------------------------------------

  /**
   * Displays a transient notification in the bottom-right corner of the page.
   * Loading toasts persist until explicitly removed; all others auto-dismiss
   * after the given duration.
   *
   * @param {string} message  - Text to display.
   * @param {'success'|'error'|'loading'|'info'} type - Controls colour and icon.
   * @param {number} [duration=3000] - Auto-dismiss delay in ms (ignored for loading).
   * @returns {HTMLElement} The toast element (useful for manual removal).
   */
  function showToast(message, type = "success", duration = 3000) {
    document.getElementById("sp-inspector-toast")?.remove();

    const { bg, icon } = TOAST_CONFIG[type];
    const el = Object.assign(document.createElement("div"), {
      id: "sp-inspector-toast",
      innerText: `${icon}  ${message}`,
    });

    Object.assign(el.style, {
      position: "fixed",
      bottom: "90px",
      right: "24px",
      background: bg,
      color: "white",
      padding: "10px 18px",
      borderRadius: "6px",
      fontSize: "13px",
      fontFamily: '-apple-system, "Segoe UI", sans-serif',
      fontWeight: "500",
      boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
      zIndex: "9999999",
      pointerEvents: "none",
      opacity: "0",
      transform: "translateY(6px)",
      transition: "opacity 200ms ease, transform 200ms ease",
      whiteSpace: "nowrap",
      maxWidth: "320px",
    });

    document.body.appendChild(el);

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      }),
    );

    if (type !== "loading") {
      setTimeout(() => {
        el.style.opacity = "0";
        el.style.transform = "translateY(6px)";
        setTimeout(() => el.remove(), 250);
      }, duration);
    }

    return el;
  }

  /**
   * Replaces the current toast with a new one, preserving visual continuity.
   * Useful for multi-step operations where the loading toast transitions
   * directly into a success or error state.
   *
   * @param {HTMLElement|null} previous - The toast element to remove immediately.
   * @param {string} message
   * @param {'success'|'error'|'info'} type
   * @param {number} [duration]
   */
  function transitionToast(previous, message, type, duration) {
    previous?.remove();
    return showToast(message, type, duration);
  }

  // ---------------------------------------------------------------------------
  // Floating action overlay (menu)
  // ---------------------------------------------------------------------------

  /**
   * Creates or updates the FAB according to the current page type.
   * Removes the button when the page has no inspectable context.
   * Safe to call multiple times — idempotent when nothing has changed.
   */
  function createFAB() {
    const pageType = detectPageType();
    const existing = document.getElementById("sp-inspector-fab");

    if (!pageType) {
      if (existing?.__outsideHandler)
        document.removeEventListener("click", existing.__outsideHandler);
      existing?.remove();
      return;
    }
    if (existing?.dataset.mode === pageType) return;

    if (existing?.__outsideHandler)
      document.removeEventListener("click", existing.__outsideHandler);
    existing?.remove();

    const root = document.createElement("div");
    root.id = "sp-inspector-fab";
    root.dataset.mode = pageType;
    root.setAttribute("aria-live", "polite");

    Object.assign(root.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "9999998",
      fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
    });

    const trigger = document.createElement("button");
    trigger.id = "sp-inspector-trigger";
    trigger.type = "button";
    trigger.title = "SP List Inspector — Click to open actions";
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = `<span style="font-size:28px;">🛠️</span>`;

    Object.assign(trigger.style, {
      width: "56px",
      height: "56px",
      padding: "0",
      borderRadius: "50%",
      border: "1px solid rgba(203, 213, 225, 0.5)",
      color: "#475569",
      background: "rgba(248, 250, 252, 0.85)",
      boxShadow: "0 4px 12px rgba(15, 23, 42, 0.08)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transition:
        "transform 200ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 200ms ease, background 200ms ease",
      backdropFilter: "blur(8px)",
    });

    const panel = document.createElement("div");
    panel.id = "sp-inspector-panel";
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", "Inspector actions");

    Object.assign(panel.style, {
      position: "absolute",
      bottom: "70px",
      right: "0",
      minWidth: "260px",
      padding: "12px",
      borderRadius: "16px",
      background: "rgba(248, 250, 252, 0.95)",
      color: "#334155",
      border: "1px solid rgba(203, 213, 225, 0.6)",
      boxShadow: "0 12px 40px rgba(15, 23, 42, 0.12)",
      transform: "translateY(10px)",
      opacity: "0",
      pointerEvents: "none",
      transition: "opacity 160ms ease, transform 160ms ease",
      backdropFilter: "blur(12px)",
    });

    const actions = document.createElement("div");
    actions.id = "sp-inspector-actions";
    Object.assign(actions.style, { display: "grid", gap: "8px" });

    const buildAction = (mode, enabled) => {
      const cfg = MENU_ACTIONS[mode];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.action = mode;
      btn.title = cfg.title;
      btn.disabled = !enabled;
      btn.innerHTML = `
        <span style="display:flex; align-items:center; gap:10px;">
          <span style="width:34px; height:34px; border-radius:10px; display:inline-flex; align-items:center; justify-content:center; background:rgba(148, 163, 184, 0.15); color:#475569;">
            ${cfg.icon}
          </span>
          <span style="display:flex; flex-direction:column; align-items:flex-start;">
            <span style="font-size:14px; font-weight:600;">${cfg.label}</span>
            <span style="font-size:11px; opacity:0.7;">${cfg.helper}</span>
          </span>
        </span>`;

      Object.assign(btn.style, {
        width: "100%",
        border: "1px solid rgba(203, 213, 225, 0.4)",
        background: "rgba(255, 255, 255, 0.5)",
        color: "inherit",
        padding: "10px",
        borderRadius: "12px",
        textAlign: "left",
        cursor: enabled ? "pointer" : "not-allowed",
        opacity: enabled ? "1" : "0.45",
        transition: "transform 140ms ease, border 140ms ease, background 140ms ease",
      });

      if (enabled) {
        btn.addEventListener("mouseenter", () => {
          btn.style.background = "rgba(241, 245, 249, 0.9)";
          btn.style.border = "1px solid rgba(148, 163, 184, 0.5)";
          btn.style.transform = "translateY(-1px)";
        });
        btn.addEventListener("mouseleave", () => {
          btn.style.background = "rgba(255, 255, 255, 0.5)";
          btn.style.border = "1px solid rgba(203, 213, 225, 0.4)";
          btn.style.transform = "translateY(0)";
        });
      }

      if (enabled) {
        btn.addEventListener("click", () => {
          setMenuOpen(false);
          if (mode === "list") runListExport();
          if (mode === "site-contents") runSiteExport();
        });
      }

      return btn;
    };

    actions.appendChild(buildAction("list", pageType === "list"));
    actions.appendChild(buildAction("site-contents", pageType === "site-contents"));

    panel.appendChild(actions);

    const setMenuOpen = (open) => {
      panel.style.opacity = open ? "1" : "0";
      panel.style.transform = open ? "translateY(0)" : "translateY(10px)";
      panel.style.pointerEvents = open ? "auto" : "none";
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
    };

    const setBusy = (busy) => {
      trigger.style.pointerEvents = busy ? "none" : "auto";
      trigger.style.opacity = busy ? "0.6" : "1";
      trigger.style.transform = busy ? "scale(0.9) rotate(180deg)" : "scale(1)";
    };

    trigger.addEventListener("mouseenter", () => {
      trigger.style.transform = "scale(1.08)";
      trigger.style.background = "rgba(241, 245, 249, 0.95)";
      trigger.style.boxShadow = "0 8px 20px rgba(15, 23, 42, 0.12)";
    });
    trigger.addEventListener("mouseleave", () => {
      trigger.style.transform = "scale(1)";
      trigger.style.background = "rgba(248, 250, 252, 0.85)";
      trigger.style.boxShadow = "0 4px 12px rgba(15, 23, 42, 0.08)";
    });
    trigger.addEventListener("click", () => {
      const isOpen = trigger.getAttribute("aria-expanded") === "true";
      setMenuOpen(!isOpen);
    });

    const handleOutside = (e) => {
      if (!root.contains(e.target)) setMenuOpen(false);
    };

    document.addEventListener("click", handleOutside);

    root.appendChild(panel);
    root.appendChild(trigger);
    document.body.appendChild(root);

    root.__setMenuOpen = setMenuOpen;
    root.__setBusy = setBusy;
    root.__outsideHandler = handleOutside;
  }

  // ---------------------------------------------------------------------------
  // Initialisation & SPA navigation awareness
  // ---------------------------------------------------------------------------

  document.addEventListener("keydown", (e) => {
    if (!e.altKey || (e.key !== "c" && e.key !== "C")) return;
    const pageType = detectPageType();
    if (pageType === "list") runListExport();
    if (pageType === "site-contents") runSiteExport();
  });

  /**
   * SharePoint Modern navigates via the History API without triggering a full
   * page reload. Wrapping `pushState` and listening to `popstate` ensures the
   * FAB is re-evaluated on every client-side navigation.
   *
   * The 800ms delay accounts for SP's internal `_spPageContextInfo` update
   * cycle, which completes roughly 500ms after a route change.
   */
  const _nativePushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    _nativePushState(...args);
    setTimeout(createFAB, 800);
  };
  window.addEventListener("popstate", () => setTimeout(createFAB, 800));

  document.body ? createFAB() : document.addEventListener("DOMContentLoaded", createFAB);

  // ---------------------------------------------------------------------------
  // Extract — visible rows from DOM
  // ---------------------------------------------------------------------------

  /**
   * Extracts IDs of visible rows from the SharePoint Modern list view DOM.
   * Returns an array of item IDs that are currently visible in the view.
   *
   * @returns {Array<number>} Array of item IDs.
   */
  function extractVisibleItemIds() {
    const ids = [];

    // Try multiple selectors for SharePoint Modern list rows
    let rowElements = document.querySelectorAll('[role="row"][data-list-index]');

    if (rowElements.length === 0) {
      rowElements = document.querySelectorAll('[role="row"][data-automationid^="ListRow-"]');
    }

    if (rowElements.length === 0) {
      rowElements = document.querySelectorAll('[role="row"].ms-List-row');
    }

    if (rowElements.length === 0) {
      // Fallback: get all rows inside a grid/table and filter out header
      const allRows = document.querySelectorAll(
        '[role="grid"] [role="row"], [role="table"] [role="row"]',
      );
      rowElements = Array.from(allRows).filter((row) => {
        const hasColumnHeader = row.querySelector('[role="columnheader"]');
        return !hasColumnHeader && row.querySelector('[role="gridcell"], [role="cell"]');
      });
    }

    if (rowElements.length === 0) {
      throw new Error(
        "No visible rows found in the current view. Make sure there are items visible in the list view.",
      );
    }

    // Extract item IDs from each visible row
    rowElements.forEach((row) => {
      // Try multiple strategies to get the item ID
      let itemId = null;

      // 1. Check data attributes
      itemId = row.getAttribute("data-item-id") || row.getAttribute("data-list-item-id");

      // 2. Try aria-rowindex (sometimes corresponds to ID + 1 or just index)
      if (!itemId) {
        const rowIndex = row.getAttribute("aria-rowindex");
        if (rowIndex) {
          // This is often just the visual row number, not the actual ID
          // We'll use it as fallback but it's not reliable
          itemId = parseInt(rowIndex, 10);
        }
      }

      // 3. Try to find ID in cell content (first cell often contains ID)
      if (!itemId) {
        const cells = row.querySelectorAll('[role="gridcell"], [role="cell"]');
        if (cells.length > 0) {
          const firstCell = cells[0];
          const cellText = firstCell.textContent?.trim();
          // Check if first cell is numeric (might be ID)
          if (cellText && /^\d+$/.test(cellText)) {
            itemId = parseInt(cellText, 10);
          }
        }
      }

      // 4. Try data-automationid which sometimes contains the ID
      if (!itemId) {
        const automationId = row.getAttribute("data-automationid");
        if (automationId) {
          const match = automationId.match(/(\d+)$/);
          if (match) {
            itemId = parseInt(match[1], 10);
          }
        }
      }

      if (itemId && !isNaN(itemId)) {
        ids.push(itemId);
      }
    });

    if (ids.length === 0) {
      throw new Error(
        "Could not extract item IDs from visible rows. The DOM structure may have changed.",
      );
    }

    return ids;
  }

  // ---------------------------------------------------------------------------
  // Run — list mode
  // ---------------------------------------------------------------------------

  /**
   * Entry point for list mode. Extracts visible row IDs from DOM, then fetches
   * complete item data from the REST API with all fields, plus list structure.
   */
  async function runListExport() {
    const root = document.getElementById("sp-inspector-fab");
    const listTitle = _spPageContextInfo?.listTitle ?? "list";
    const siteUrl = _spPageContextInfo?.webAbsoluteUrl ?? location.origin;

    if (root?.__setBusy) root.__setBusy(true);
    if (root?.__setMenuOpen) root.__setMenuOpen(false);

    const loader = showToast(`Extracting visible item IDs from "${listTitle}"…`, "loading");

    try {
      // Step 1: Extract IDs from visible rows
      const visibleIds = extractVisibleItemIds();

      transitionToast(
        loader,
        `Fetching ${visibleIds.length} records + list structure from API…`,
        "loading",
      );

      // Step 2: Fetch complete items AND list structure from REST API in parallel
      const base = `${siteUrl}/_api/web/lists/getbytitle('${encodeURIComponent(listTitle)}')`;

      // Build filter query for visible IDs
      const idFilter = visibleIds.map((id) => `Id eq ${id}`).join(" or ");
      const itemsUrl = `${base}/items?$filter=${idFilter}&$top=${visibleIds.length}`;

      // Fetch items and fields in parallel
      const [itemsData, fieldsData] = await Promise.all([
        apiFetch(itemsUrl),
        apiFetch(
          `${base}/fields?$filter=Hidden eq false` +
            `&$select=Id,Title,InternalName,TypeAsString,TypeDisplayName,Required,` +
            `ReadOnlyField,Indexed,EnforceUniqueValues,DefaultValue,Description,` +
            `Choices,FillInChoice,LookupList,LookupField,AllowMultipleValues,MaxLength,Group`,
        ),
      ]);

      const items = (itemsData.value ?? []).map(cleanItem);

      // Sort items to match the visual order
      const itemsMap = new Map(items.map((item) => [item.Id, item]));
      const sortedItems = visibleIds
        .map((id) => itemsMap.get(id))
        .filter((item) => item !== undefined);

      // Process fields/columns
      const allFields = fieldsData.value ?? [];
      const columns = allFields
        .filter((f) => !SKIP_INTERNAL.has(f.InternalName) && f.Group !== "_Hidden")
        .map((f) => ({
          displayName: f.Title,
          internalName: f.InternalName,
          type: f.TypeAsString,
          typeDisplay: f.TypeDisplayName,
          group: f.Group || null,
          required: f.Required,
          readOnly: f.ReadOnlyField,
          indexed: f.Indexed,
          enforceUniqueValues: f.EnforceUniqueValues,
          defaultValue: f.DefaultValue || null,
          description: f.Description || null,
          ...(f.Choices?.length && { choices: f.Choices, fillInChoice: f.FillInChoice }),
          ...(f.LookupList && {
            lookupListId: f.LookupList,
            lookupField: f.LookupField,
            allowMultipleValues: f.AllowMultipleValues,
          }),
          ...(f.MaxLength && { maxLength: f.MaxLength }),
        }));

      const payload = {
        _meta: {
          tool: "SP List Inspector v2.9",
          mode: "visible-rows-full",
          extractedAt: new Date().toISOString(),
          siteUrl,
          pageUrl: location.href,
          listTitle: listTitle,
        },
        structure: {
          totalColumns: columns.length,
          columns: columns,
        },
        data: {
          rowCount: sortedItems.length,
          rows: sortedItems,
        },
      };

      const json = JSON.stringify(payload, null, 2);

      transitionToast(loader, "Copying to clipboard…", "info", 1200);
      GM_setClipboard(json, "text");

      setTimeout(
        () =>
          showToast(
            `${sortedItems.length} records + ${columns.length} columns copied to clipboard`,
            "success",
          ),
        1300,
      );
    } catch (err) {
      transitionToast(loader, `Error: ${err.message}`, "error", 5000);
      console.error("[SP Inspector — list]", err);
    }

    if (root?.__setBusy) root.__setBusy(false);
  }

  // ---------------------------------------------------------------------------
  // Run — site-contents mode
  // ---------------------------------------------------------------------------

  /**
   * Entry point for site-contents mode. Fetches the site structure, then
   * downloads a named JSON file and simultaneously copies the payload to
   * the clipboard.
   *
   * Filename format: sp_{siteSegment}_{ddmmyyHHMMSS}.json
   * Example:         sp_PR014GestindeFacturas_130426150842.json
   */
  async function runSiteExport() {
    const root = document.getElementById("sp-inspector-fab");
    const siteTitle = _spPageContextInfo?.webTitle ?? "site";

    if (root?.__setBusy) root.__setBusy(true);
    if (root?.__setMenuOpen) root.__setMenuOpen(false);

    const loader = showToast(`Extracting full site structure from "${siteTitle}"…`, "loading");

    try {
      const result = await extractSiteStructure(loader);
      const siteUrl = _spPageContextInfo?.webAbsoluteUrl ?? "";
      const siteSegment = siteUrl.split("/sites/")[1] ?? "site"; // → "PR014GestindeFacturas"
      const timestamp = formatTimestamp(new Date());
      const filename = `sp_${siteSegment}_${timestamp}.json`;

      const stats = result.stats;
      transitionToast(
        loader,
        `Guardando ${stats.totalItems} registros de ${stats.totalLists} listas…`,
        "info",
        1500,
      );
      downloadFile(filename, result.json);
      GM_setClipboard(result.json, "text");

      setTimeout(
        () =>
          showToast(
            `Exportado: ${stats.totalLists} listas, ${stats.totalFields} campos, ${stats.totalItems} registros`,
            "success",
            5000,
          ),
        1600,
      );
    } catch (err) {
      transitionToast(loader, `Error: ${err.message}`, "error", 5000);
      console.error("[SP Inspector — site]", err);
    }

    if (root?.__setBusy) root.__setBusy(false);
  }

  // ---------------------------------------------------------------------------
  // Extract — list metadata
  // ---------------------------------------------------------------------------

  /**
   * Orchestrates parallel rounds of SP REST API calls and assembles
   * the final JSON payload for the active list:
   *
   *   Round 0 — List metadata to determine item count
   *   Round 1 — Fields, items (up to 100 if total <= 100), content types, views
   *   Round 2 — View field sets, lookup list resolution          (parallel)
   *   Round 3 — Expanded lookup sample (skipped if no lookups)
   *
   * @returns {Promise<string>} Pretty-printed JSON string.
   */
  async function extractList() {
    const siteUrl =
      _spPageContextInfo?.webAbsoluteUrl ??
      (() => {
        throw new Error("_spPageContextInfo is unavailable");
      })();
    const listTitle =
      _spPageContextInfo?.listTitle ??
      (() => {
        throw new Error("No active list found on this page");
      })();

    const base = `${siteUrl}/_api/web/lists/getbytitle('${encodeURIComponent(listTitle)}')`;

    // -- Round 0: get list metadata to determine item count ------------------
    const listData = await apiFetch(
      `${base}?$select=Id,Title,Description,ItemCount,Created,LastItemModifiedDate,` +
        `EntityTypeName,ListItemEntityTypeFullName,BaseTemplate,ParentWebUrl,` +
        `EnableVersioning,MajorVersionLimit`,
    );

    const itemCount = listData.ItemCount || 0;
    const itemsToFetch = itemCount <= 100 ? itemCount : 20;

    // -- Round 1: fields, items, content types, views -------------------------
    const [fieldsData, itemsData, ctData, viewsData] = await Promise.all([
      apiFetch(
        `${base}/fields?$filter=Hidden eq false` +
          `&$select=Id,Title,InternalName,TypeAsString,TypeDisplayName,Required,` +
          `ReadOnlyField,Indexed,EnforceUniqueValues,DefaultValue,Description,` +
          `Choices,FillInChoice,LookupList,LookupField,AllowMultipleValues,MaxLength,Group`,
      ),
      apiFetch(`${base}/items?$top=${itemsToFetch}`),
      apiFetch(`${base}/contenttypes?$select=Id,Name,Description,Group,Hidden,Order`),
      apiFetch(`${base}/views?$select=Id,Title,DefaultView,RowLimit,ViewType,Paged,ViewQuery`),
    ]);

    const allFields = fieldsData.value ?? [];
    const lookupFields = allFields.filter(
      (f) => (f.TypeAsString === "Lookup" || f.TypeAsString === "LookupMulti") && f.LookupList,
    );

    // -- Round 2: view fields + lookup list titles ----------------------------
    const [views, lookupMeta] = await Promise.all([
      Promise.all(
        (viewsData.value ?? []).map(async (v) => {
          const r = await apiFetch(`${base}/views('${v.Id}')/viewfields`).catch(() => ({}));
          return {
            id: v.Id,
            title: v.Title,
            defaultView: v.DefaultView,
            rowLimit: v.RowLimit,
            viewType: v.ViewType || "HTML",
            paged: v.Paged,
            fields: r.Items ?? [], // SP returns Items[], not value[]
            camlQuery: v.ViewQuery || null,
          };
        }),
      ),

      (async () => {
        const map = {};
        await Promise.all(
          lookupFields.map(async (f) => {
            const id = f.LookupList.replace(/[{}]/g, "");
            const d = await apiFetch(
              `${siteUrl}/_api/web/lists('${id}')?$select=Title,DefaultViewUrl`,
            ).catch(() => ({}));
            map[f.InternalName] = {
              listId: id,
              title: d.Title ?? null,
              viewUrl: d.DefaultViewUrl ?? null,
            };
          }),
        );
        return map;
      })(),
    ]);

    // -- Round 3: expanded lookup sample (optional) ---------------------------
    let lookupSamples = null;
    if (lookupFields.length) {
      const expand = lookupFields.map((f) => f.InternalName).join(",");
      const select = lookupFields
        .map((f) => `${f.InternalName}/ID,${f.InternalName}/Title`)
        .join(",");
      lookupSamples = await apiFetch(
        `${base}/items?$top=5&$expand=${expand}&$select=ID,Title,${select}`,
      )
        .then((d) => d.value)
        .catch((e) => ({ error: e.message }));
    }

    // -- Shape columns --------------------------------------------------------
    const columns = allFields
      .filter((f) => !SKIP_INTERNAL.has(f.InternalName) && f.Group !== "_Hidden")
      .map((f) => ({
        displayName: f.Title,
        internalName: f.InternalName,
        type: f.TypeAsString,
        typeDisplay: f.TypeDisplayName,
        group: f.Group || null,
        required: f.Required,
        readOnly: f.ReadOnlyField,
        indexed: f.Indexed,
        enforceUniqueValues: f.EnforceUniqueValues,
        defaultValue: f.DefaultValue || null,
        description: f.Description || null,
        ...(f.Choices?.length && { choices: f.Choices, fillInChoice: f.FillInChoice }),
        ...(f.LookupList && {
          lookup: {
            ...lookupMeta[f.InternalName],
            field: f.LookupField,
            multiValue: f.AllowMultipleValues,
          },
        }),
        ...(f.MaxLength && { maxLength: f.MaxLength }),
      }));

    // -- Overview section: business fields + clean sample records -------------

    const editableColumns = columns.filter((c) => !c.readOnly && c.type !== "Attachments");
    const calculatedColumns = columns.filter((c) => c.type === "Calculated");

    const businessFieldKeys = new Set([
      ...editableColumns.map((c) => c.internalName),
      ...calculatedColumns.map((c) => c.internalName),
    ]);

    /**
     * SP appends an `*Id` numeric key for every Lookup/User column alongside
     * the expanded object. Include these so sample records remain self-contained.
     */
    const lookupIdKeys = new Set(
      editableColumns
        .filter((c) => c.type === "Lookup" || c.type === "LookupMulti" || c.type === "User")
        .map((c) => `${c.internalName}Id`),
    );

    const fieldIndex = Object.fromEntries(
      columns
        .filter((c) => businessFieldKeys.has(c.internalName))
        .map((c) => [c.internalName, c.displayName]),
    );

    const schema = editableColumns.map(
      ({
        displayName,
        internalName,
        typeDisplay,
        required,
        choices,
        fillInChoice,
        lookup,
        defaultValue,
      }) => ({
        name: displayName,
        field: internalName,
        type: typeDisplay,
        ...(required && { required: true }),
        ...(choices?.length && { choices, fillInChoice }),
        ...(lookup?.title && { lookupList: lookup.title, lookupField: lookup.field }),
        ...(lookup?.multiValue && { multiValue: true }),
        ...(defaultValue && { defaultValue }),
      }),
    );

    const lookupDependencies = Object.values(lookupMeta).reduce((acc, v) => {
      if (v.title && !acc.find((x) => x.listId === v.listId)) acc.push(v);
      return acc;
    }, []);

    const sampleRecords = (itemsData.value ?? [])
      .map((record) => {
        const clean = cleanItem(record);
        return Object.fromEntries(
          Object.entries(clean).filter(
            ([k]) => k === "Id" || businessFieldKeys.has(k) || lookupIdKeys.has(k),
          ),
        );
      })
      .filter((rec) => {
        // Filtrar registros que solo tienen Id o valores por defecto
        const meaningfulKeys = Object.keys(rec).filter((k) => {
          if (k === "Id") return false;
          const val = rec[k];
          // Excluir null/undefined
          if (val == null) return false;
          // Excluir false (valor por defecto común en Yes/No)
          if (val === false) return false;
          return true;
        });
        return meaningfulKeys.length > 0;
      });

    // -- Assemble final payload -----------------------------------------------
    return JSON.stringify(
      {
        _meta: {
          tool: "SP List Inspector v2.9",
          mode: "list",
          extractedAt: new Date().toISOString(),
          siteUrl,
          pageUrl: location.href,
        },
        list: {
          id: listData.Id,
          title: listData.Title,
          description: listData.Description || null,
          itemCount: listData.ItemCount,
          created: listData.Created,
          lastModified: listData.LastItemModifiedDate,
          entityTypeName: listData.EntityTypeName,
          listItemEntityTypeFullName: listData.ListItemEntityTypeFullName,
          baseTemplate: listData.BaseTemplate,
          parentWebUrl: listData.ParentWebUrl,
          versioningEnabled: listData.EnableVersioning,
          majorVersionLimit: listData.MajorVersionLimit,
        },
        overview: {
          description: `List "${listData.Title}" — ${listData.ItemCount} total records`,
          schema,
          calculatedFields: calculatedColumns.map(({ displayName, internalName }) => ({
            name: displayName,
            field: internalName,
          })),
          fieldIndex,
          lookupDependencies,
          sampleRecords,
          sampleQuality: {
            totalFetched: itemsData.value?.length ?? 0,
            withData: sampleRecords.length,
            emptyRecords: (itemsData.value?.length ?? 0) - sampleRecords.length,
          },
        },
        contentTypes: (ctData.value ?? [])
          .filter((ct) => !ct.Hidden)
          .map(({ Id, Name, Group, Description, Order }) => ({
            id: Id?.StringValue ?? Id,
            name: Name,
            group: Group,
            description: Description || null,
            order: Order,
          })),
        columns,
        views,
        sampleItems: (itemsData.value ?? []).map(cleanItem).filter((item) => {
          // Filtrar items que solo tienen metadatos o valores por defecto
          const meaningfulKeys = Object.keys(item).filter((k) => {
            // Excluir metadatos del sistema
            if (["Id", "Created", "Modified", "AuthorId", "EditorId", "CheckoutUserId"].includes(k))
              return false;
            const val = item[k];
            // Excluir null/undefined
            if (val == null) return false;
            // Excluir false (valor por defecto común en Yes/No)
            if (val === false) return false;
            return true;
          });
          return meaningfulKeys.length > 0;
        }),
        ...(lookupSamples && { lookupSamples }),
      },
      null,
      2,
    );
  }

  // ---------------------------------------------------------------------------
  // Extract — site structure
  // ---------------------------------------------------------------------------

  /**
   * Fetches web-level metadata and the full list of non-hidden lists/libraries.
   * NOW INCLUDES: All fields and ALL items from every list.
   *
   * @param {HTMLElement} [progressToast] - Optional toast element to update with progress.
   * @returns {Promise<{json: string, stats: object}>} JSON string and extraction stats.
   */
  async function extractSiteStructure(progressToast = null) {
    const startTime = Date.now();
    const siteUrl =
      _spPageContextInfo?.webAbsoluteUrl ??
      (() => {
        throw new Error("_spPageContextInfo is unavailable");
      })();

    const [webData, listsData] = await Promise.all([
      apiFetch(
        `${siteUrl}/_api/web` +
          `?$select=Title,Description,Url,Created,LastItemModifiedDate,WebTemplate,Language`,
      ),
      apiFetch(
        `${siteUrl}/_api/web/lists` +
          `?$filter=Hidden eq false` +
          `&$orderby=BaseTemplate asc,Title asc` +
          `&$select=Id,Title,Description,ItemCount,Created,LastItemModifiedDate,` +
          `BaseTemplate,DefaultViewUrl,EntityTypeName,IsPrivate`,
      ),
    ]);

    const allLists = listsData.value ?? [];
    let totalFieldsExtracted = 0;
    let totalItemsExtracted = 0;

    /**
     * Normalises a raw SP list entry and fetches its fields and ALL items.
     *
     * @param {object} l - Raw list object from the REST response.
     * @param {number} index - Current index (for progress tracking).
     * @returns {Promise<object>}
     */
    const shapeList = async (l, index) => {
      updateProgressToast(progressToast, index + 1, allLists.length, l.Title);

      const listBase = `${siteUrl}/_api/web/lists(guid'${l.Id}')`;
      let fields = [];
      let items = [];
      let error = null;

      try {
        // Fetch fields for this list
        const fieldsData = await apiFetch(
          `${listBase}/fields?$filter=Hidden eq false` +
            `&$select=Id,Title,InternalName,TypeAsString,TypeDisplayName,Required,` +
            `ReadOnlyField,Indexed,EnforceUniqueValues,DefaultValue,Description,` +
            `Choices,FillInChoice,LookupList,LookupField,AllowMultipleValues,MaxLength,Group`,
        );

        const allFields = fieldsData.value ?? [];
        fields = allFields
          .filter((f) => !SKIP_INTERNAL.has(f.InternalName) && f.Group !== "_Hidden")
          .map((f) => ({
            displayName: f.Title,
            internalName: f.InternalName,
            type: f.TypeAsString,
            typeDisplay: f.TypeDisplayName,
            group: f.Group || null,
            required: f.Required,
            readOnly: f.ReadOnlyField,
            indexed: f.Indexed,
            enforceUniqueValues: f.EnforceUniqueValues,
            defaultValue: f.DefaultValue || null,
            description: f.Description || null,
            ...(f.Choices?.length && { choices: f.Choices, fillInChoice: f.FillInChoice }),
            ...(f.LookupList && {
              lookupListId: f.LookupList,
              lookupField: f.LookupField,
              allowMultipleValues: f.AllowMultipleValues,
            }),
            ...(f.MaxLength && { maxLength: f.MaxLength }),
          }));

        totalFieldsExtracted += fields.length;

        // Fetch ALL items for this list using pagination helper
        items = await fetchAllItems(`${listBase}/items`);
        totalItemsExtracted += items.length;
      } catch (err) {
        error = err.message;
        console.error(`[SP Inspector] Error processing list "${l.Title}":`, err);
      }

      return {
        id: l.Id,
        title: l.Title,
        description: l.Description || null,
        itemCount: l.ItemCount,
        baseTemplate: l.BaseTemplate,
        templateLabel: BASE_TEMPLATE_LABELS[l.BaseTemplate] ?? `Template ${l.BaseTemplate}`,
        defaultViewUrl: l.DefaultViewUrl || null,
        entityTypeName: l.EntityTypeName,
        isPrivate: l.IsPrivate,
        created: l.Created,
        lastModified: l.LastItemModifiedDate,
        fieldsCount: fields.length,
        itemsCount: items.length,
        fields,
        items,
        ...(error && { error }),
      };
    };

    // Process all lists sequentially to avoid throttling
    const processedLists = [];
    for (let i = 0; i < allLists.length; i++) {
      processedLists.push(await shapeList(allLists[i], i));
    }

    const documentLibraries = processedLists.filter((l) => l.baseTemplate === 101);
    const customLists = processedLists.filter((l) => l.baseTemplate === 100);
    const other = processedLists.filter((l) => l.baseTemplate !== 100 && l.baseTemplate !== 101);

    const extractionDurationMs = Date.now() - startTime;

    const json = JSON.stringify(
      {
        _meta: {
          tool: "SP List Inspector v2.9",
          mode: "site-structure-full",
          extractedAt: new Date().toISOString(),
          siteUrl,
          pageUrl: location.href,
          totalListsProcessed: allLists.length,
          totalFieldsExtracted,
          totalItemsExtracted,
          extractionDurationMs,
        },
        site: {
          title: webData.Title,
          description: webData.Description || null,
          url: webData.Url,
          webTemplate: webData.WebTemplate,
          language: webData.Language,
          created: webData.Created,
          lastModified: webData.LastItemModifiedDate,
        },
        summary: {
          total: allLists.length,
          documentLibraries: documentLibraries.length,
          customLists: customLists.length,
          other: other.length,
          totalFields: totalFieldsExtracted,
          totalItems: totalItemsExtracted,
        },
        documentLibraries,
        customLists,
        other,
      },
      null,
      2,
    );

    return {
      json,
      stats: {
        totalLists: allLists.length,
        totalFields: totalFieldsExtracted,
        totalItems: totalItemsExtracted,
        durationMs: extractionDurationMs,
      },
    };
  }
})();
