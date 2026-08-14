# SharePoint Tools (SP List Inspector) v2.9

Tampermonkey userscript for inspecting and exporting **SharePoint Modern** lists through the REST API.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the raw script: `https://raw.githubusercontent.com/rauldzmartin/Userscripts/main/sharepoint-tools/sharepoint_tools.js`
3. Tampermonkey will offer to install it — accept.

## Usage

Once loaded, a floating 🛠️ button appears in the bottom-right corner. Its behavior depends on the page:

| Mode | Where it appears | Action |
|---|---|---|
| **Copy list** | On any list or library view (active `listTitle`) | Copies the full list structure (columns, types, views, content types) + the records currently visible on screen to the clipboard |
| **Export site** | On the *Site Contents* page (`viewlsts.aspx`) | Exports a JSON with every list/library of the site, including all fields and **all records** (with automatic pagination), and downloads the file `sp_{site}_{timestamp}.json` |

You can also press **Alt+C** to run the action for the current page.

### Example output (list mode)

```json
{
  "_meta": { "tool": "SP List Inspector v2.9", "mode": "visible-rows-full", "...": "..." },
  "structure": { "totalColumns": 12, "columns": [...] },
  "data": { "rowCount": 25, "rows": [...] }
}
```

## Technical details

- Uses `_spPageContextInfo` to detect the context (active list or site).
- Filters out internal OData/SharePoint keys (`odata.*`, `FileSystemObjectType`, lookup `*Id`, etc.) so the JSON only contains business data.
- `fetchAllItems()` pages the API automatically (`$top=5000` + `odata.nextLink`) and retries with exponential backoff on throttling (429).
- Reacts to SharePoint Modern SPA navigation (wrapper on `history.pushState` + `popstate`).
- Lookup fields are resolved against their source list (title and view URL).
- Sample records are cleaned of default values (`null`, `false`, only `Id`) so they are representative.

## Requirements

- `@grant GM_setClipboard` (clipboard access)
- `@match https://*.sharepoint.com/sites/*/*`

## Changelog

| Version | Changes |
|---|---|
| 2.9 | Current version in the reorganized repo structure |