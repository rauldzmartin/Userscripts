# Wallapop Hide Items (Synced)

Multi-device synchronized userscript for hiding items in Wallapop search results.

## Features

- Hide specific items from Wallapop search results
- Multi-device synchronization via GitHub Gist
- Toggle visibility of hidden items
- Automatic detection of "all hidden" state
- Offline-first with localStorage fallback
- Auto-update from GitHub repository

## Installation

### Requirements

- Browser extension: Tampermonkey, Violentmonkey, or Greasemonkey
- GitHub account (for sync functionality)

### Steps

1. Install Tampermonkey extension for your browser
2. Open Tampermonkey Dashboard → Utilities → Install from URL
3. Paste: `https://raw.githubusercontent.com/rauldzmartin/Userscripts/main/wallapop-hide-items.user.js`
4. Click Install

## Configuration

### First Run (per device)

On first execution, the script will prompt for:

1. **GitHub Gist ID**
   - Example: `95636bead4acf24062071058dcf9ea14`
   - Get it from your Gist URL: `gist.github.com/username/{GIST_ID}`

2. **GitHub Personal Access Token**
   - Generate at: GitHub Settings → Developer Settings → Personal Access Tokens → Tokens (classic)
   - Required scope: `gist`
   - The token grants write access to all your Gists

### Setup GitHub Gist

1. Go to https://gist.github.com/
2. Create a new **secret** Gist (not public)
3. Filename: `wallapop-blocked-items.json`
4. Initial content:
   ```json
   {
     "blocked": [],
     "updated_at": "2026-08-04T00:00:00Z",
     "version": 1
   }
   ```
5. Save and copy the Gist ID from the URL

### Reconfiguration

To change Gist ID or Token:

1. Open Tampermonkey Dashboard
2. Select the script → Storage tab
3. Delete key: `wallapop_gist_cfg`
4. Reload Wallapop → prompts will appear again

## Usage

### Hide Items

1. Browse Wallapop search results
2. Each item card displays an eye-off icon button
3. Click the button to hide the item
4. Item is hidden locally immediately
5. After 2 seconds, the change syncs to GitHub Gist
6. Other devices fetch changes within 30 seconds

### Show Hidden Items

Click the "Show hidden" / "Mostrar ocultos" button in the search filters to temporarily display hidden items.

### Favorites Page

The script is automatically disabled on `/app/favorites/*`, both on direct load and during SPA navigation into favorites. Hidden items therefore remain visible in your favorites grid; hiding resumes when you navigate back to search results.

### Sync Behavior

- **Fetch interval:** Every 30 seconds
- **Push debounce:** 2 seconds after last hide action
- **Merge strategy:** Union of local and remote sets (no items are lost)
- **Offline mode:** Changes saved locally, synced when connection restored
- **Conflict resolution:** Automatic merge (union of all blocked items)

## Architecture

### Data Flow

```
Device A: Hide item
  ↓ localStorage (immediate)
  ↓ 2s debounce
  ↓ PATCH to GitHub Gist
  
Device B: (30s later)
  ↓ GET from GitHub Gist
  ↓ Merge with local data
  ↓ Update localStorage + UI
```

### Storage

- **localStorage:** Local cache and offline fallback
  - Key: `wallapop_hidden_items`
  - Format: `["123456789", "987654321", ...]`

- **Tampermonkey Storage:** Configuration persistence
  - Key: `wallapop_gist_cfg`
  - Format: `{id: "...", token: "..."}`

- **GitHub Gist:** Source of truth for sync
  - File: `wallapop-blocked-items.json`
  - Format:
    ```json
    {
      "blocked": ["123456789", "987654321"],
      "updated_at": "2026-08-04T12:30:45.123Z",
      "version": 1
    }
    ```

### Code Structure

- **Header:** Metadata and grants for Tampermonkey
- **Constants:** Selectors, intervals, storage keys
- **Sync Module:** GitHub Gist integration
  - `req()`: Promisified GM_xmlhttpRequest wrapper
  - `sync.cfg()`: Config loader with prompts
  - `sync.fetch()`: Pull remote changes
  - `sync.push()`: Push local changes
  - `sync.schedule()`: Debounced push scheduler
  - `sync.init()`: Initialization and first fetch
- **Core Logic:** Item hiding, UI manipulation, card processing
- **Initialization:** Setup and interval loops

## Error Handling

| Error | Behavior |
|-------|----------|
| No connection | Offline mode, retry on next interval |
| Rate limit (429) | Exponential backoff (60s retry) |
| Invalid token | Offline mode, warning in console |
| Gist not found | Warning in console |
| Parse error | Fallback to empty array |

## Performance

- **Script size:** ~320 lines (~12KB uncompressed)
- **Memory footprint:** Minimal (arrays of item IDs only)
- **Network:** 2 requests per minute max (1 fetch + potential push)
- **UI impact:** Non-blocking (async operations)

## Limitations

- **No unblock sync:** Removing items from the list is not synchronized (local-only operation)
- **Token security:** GitHub token grants access to all your Gists (use dedicated account if concerned)
- **Rate limits:** 5000 requests/hour per token (sufficient for normal usage)
- **Sync delay:** Up to 32 seconds (2s debounce + 30s interval)

## Browser Compatibility

Tested on:
- Chrome/Chromium + Tampermonkey
- Firefox + Tampermonkey
- Edge + Tampermonkey

## Privacy

- **Item IDs:** Only numeric IDs are synced (no personal data)
- **Gist visibility:** Secret Gists are not indexed but publicly accessible via URL
- **Token storage:** Stored in Tampermonkey's secure storage (not in page context)

## Troubleshooting

### Prompts not appearing

- Check Tampermonkey is enabled for wallapop.com
- Check browser allows prompts (not blocked)
- Open browser console for error messages

### Sync not working

1. Open browser console (F12)
2. Look for `[Sync]` messages
3. Common issues:
   - Invalid Gist ID or Token → reconfigure
   - Network blocked → check firewall/proxy
   - Rate limited → wait 60 seconds

### Items not hiding

- Check if "Show hidden" toggle is enabled
- Verify localStorage has items: `localStorage.getItem('wallapop_hidden_items')`
- Check browser console for errors

### Script not updating

1. Tampermonkey Dashboard → Settings
2. Verify "Check for userscript updates" is enabled
3. Manually check: Dashboard → script → Update

## Contributing

Hosted at: https://github.com/rauldzmartin/Userscripts

## License

No license specified. Personal use script.

## Changelog

### v1.1.4 (2026-08-13)
- Script disabled on the favorites page (`/app/favorites/*`), including SPA navigation
- Injected hide styles are disabled on favorites so hidden items stay visible in the favorites grid

### v1.0.0 (2026-08-04)
- Multi-device synchronization via GitHub Gist
- Promisified request handling
- Debounced push operations
- Automatic merge on conflict
- Auto-update from GitHub

### v0.3 (Previous)
- Local-only version
- Basic hide functionality
- Toggle visibility
