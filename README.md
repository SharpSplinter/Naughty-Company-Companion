# Naughty Company Companion

Naughty Company Companion is a Tampermonkey and TornPDA dashboard for Torn company directors and managers. It brings income, profit, local staffing-efficiency planning, same-type income ranking, stock, and local trends into one local-first panel.

> Release status: **Pre-release / still in production.**

## Project description

**A local-first Tampermonkey and TornPDA companion for Torn company directors and managers, with income and profit insight, staffing-efficiency planning, stock tracking, rankings, and local trend history.**

The project is an independent community userscript. It is not affiliated with Torn, Tampermonkey, or TornPDA.

## Canonical UI/UX baseline

Every active Naughty companion follows the [Naughty Companion GUI/UX/UI Standard](NAUGHTY_COMPANION_GUI_UX_UI_STANDARD.md). Its Shared sections apply everywhere; Company-only behavior is explicitly isolated in Appendix A so other scripts never inherit unnecessary Company features.

## Features

### Overview and income

- Torn-reported daily and weekly income.
- Daily and weekly profit plus 30-day tracked or forecast income/profit figures.
- Company condition, funds, ad budget, trains, application status counts (Pending, Accepted, and Withdrawn), and recent funds news when the API key can access them.
- Same-type income rank, transparent health score, observed next-star gap, and previous-star buffer.

### Team and planner

- Compact employee cards showing current role, current total effectiveness, local assigned role, assigned effectiveness, addiction and inactivity effects, best fit, wage, and recent activity.
- Current effectiveness uses Torn’s reported **total** effectiveness. Assigned and best-fit roles use the bundled local role calculator plus the same non-working effectiveness delta from Torn (settling in, merits, education, management, book, gender, addiction, and inactivity effects).
- Average employee effectiveness is shown to one decimal place across the workforce summary and effectiveness trend details.
- Per-employee role selector, lock control, and local-only assignment plan.
- Bundled static role requirements for every supported company type; employee work stats never leave Torn for an efficiency lookup.
- A dedicated **Position config** modal holds per-role max-quantity dropdowns and persistent click-up/click-down priority controls. Auto-assignment locks current seats first, then fills top-to-bottom by priority and projected efficiency within company capacity.
- Sortable Assignment preview columns: Employee, Current, Assigned, Current Eff., Assigned Eff., Change, and Lock.

### Rankings, stock, and trends

- Same-type company ranking is refreshed through verified Torn pagination once per Torn day at **18:10 UTC**, then sorted locally by weekly income. A manual refresh checks the persisted successful Torn-tick date and will not duplicate a completed daily ranking pull; a missed, failed, or incomplete pull remains eligible rather than saving an inaccurate rank.
- Health score defined transparently as weekly-income percentile among same company type.
- Observed weekly-income gaps to the next and previous star bands; these are planning values, not an official Torn formula.
- Stock, sales, gross margin, per-item **Current stock worth** (in-stock quantity × sale price), and a daily **Stock difference** once a prior local reporting-day snapshot exists.
- Local daily history retained for 92 days, axis-labeled interactive charts with selectable day points and daily details, and CSV export. The stock-value trend lives at the top of the Stock tab; Trends contains income/profit, effectiveness, and ranking charts.
- Your-company ranking context for both the current star level and the same company type.
- Multiple company profiles, each isolated by returned Company ID with its own Director key, cache, history, rankings, planner state, and alert records. The header selector always includes the current company and **Add company…**.

### Interface

- Overview, Team, Planner, Rankings, Stock, Trends, and Settings tabs.
- Explicit refresh labels explaining which data will be loaded.
- Persistent panel position, size, selected tab, plans, capacities, priorities, and local history.
- Separate runtime and layout detection. TornPDA/Desktop is detected from the native bridge or runtime identity; `narrow`, `compact`, `standard`, and `wide` layouts are measured from the visual viewport, zoom, orientation, and actual panel width. Team uses a detailed top-to-bottom list on desktop and compact cards on TornPDA.
- Desktop drag/resize/minimize controls and a safe mobile TornPDA layout. The minimized launcher opens from any tap/click and can be dragged to a remembered position without changing the expanded panel’s placement.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or use TornPDA’s userscript support.
2. Open the [raw userscript](https://raw.githubusercontent.com/SharpSplinter/Naughty-Company-Companion/main/Naughty%20Company%20Companion.user.js) and install it.
3. Reload Torn and open the panel from the chess-piece launcher, or press <kbd>Alt</kbd>+<kbd>C</kbd>.
4. In **Settings**, select **Add company…**, paste a Limited-access Director key, and select **Validate and add company**.
5. Use the header selector to switch companies. On TornPDA, a documented injected Torn API key is used transiently for the current company when available.

## API access and refresh behavior

A Limited-access Director key is required for a saved company profile. It is validated against Company Profile and Company Employees before being saved, and each key must resolve to its own returned Company ID. A director/manager-capable key exposes more fields, including stock, employee wages, applications, and funds news. Missing fields remain unavailable rather than being treated as zero.

The top **Refresh Torn data** action refreshes the selected company’s profile, employees, stock, funds news, and applications. The daily 18:10 UTC coordinator refreshes every configured company—even unselected ones—through a bounded queue, captures or updates one de-duplicated reporting-day snapshot, and makes one ranking pull per shared company type. Same-type rankings run once per successful Torn reporting day; a manual ranking button checks that persisted completion first and never duplicates a completed daily pull.

## Local efficiency calculation and privacy

The companion does not call TornStats and does not need a TornStats key. For each required employee stat, the bundled calculator uses the same verified local role-efficiency formula, then applies Torn’s current non-working-stat effectiveness delta. Torn’s reported total remains the displayed current effectiveness value.

All saved Director keys, cached data, staffing plans, rankings, and history stay in local per-script storage. The companion requests data directly from `api.torn.com`; it does not upload history, plans, or employee work stats elsewhere. Keys are never rendered after entry, logged, included in normal exports, or included in normal backups. TornPDA-injected keys are transient and are never saved as a Director key.

Userscript storage is not a cryptographic vault. Treat API keys as secrets and revoke/replace a key if it may have been exposed.

## Calculation notes

Daily Profit:

```text
daily income − sold stock cost − advertising budget − total wages
```

Weekly Profit:

```text
weekly income − 7 × (advertising budget + total wages)
```

Weekly profit omits sold stock cost because Torn exposes stock sales as a daily value. The health score is a visible weekly-income percentile, not a hidden company-quality value. Star thresholds and gaps are observed rank cutoffs, so use them as guidance rather than a guarantee.

## TornPDA compatibility, storage, backup, and daily alerts

On TornPDA, the companion prefers the native per-script `PDA_storage` store. It loads the local namespace once at startup and safely batches ordinary writes (critical settings, layout, and alert/reminder state flush immediately). Existing Tampermonkey/GM values are copied into `PDA_storage` only when the corresponding native value is missing, so an established native value is not overwritten. Legacy single-company cache/key data migrates once into the Company-ID profile model; a legacy flat key with no cached Company ID is deliberately discarded instead of being retained as an unbound fallback. The unused historical TornStats projection store is removed. Settings shows the active runtime, layout profile, visible/panel screen size, and storage method, with an unchecked-by-default **Use legacy GM storage** switch that safely migrates local companion state when selected. If native storage is unavailable or full, the companion keeps working through its compatible GM/local-storage fallback and displays a storage warning rather than discarding the change.

Native runtime identity and presentation are deliberately separate. A TornPDA runtime is confirmed only after the `flutterInAppWebViewPlatformReady` bridge can answer `isTornPDA`; a user-agent hint or small screen alone does not claim native status. `ResizeObserver` and visual-viewport events update the measured layout profile without rerendering the tab or losing scroll position during resize, rotation, zoom, or keyboard use. TornPDA portrait uses safe-area-aware full viewport sizing, one hidden-scrollbar vertical touch scroller, wrapping tab controls, and labelled list rows instead of horizontal table overflow. Desktop keeps its detailed Team list and draggable/resizable panel. Network requests use the declared Tampermonkey grants when available and can use TornPDA's native `PDA_httpGet` after the bridge is confirmed. When TornPDA injects its documented API-key placeholder, the companion uses it automatically without showing or logging the value.

On mobile and TornPDA, the companion opts into the browser’s native virtual-keyboard overlay API when available. Its visual-viewport fallback freezes the panel’s pre-keyboard height while an editable field is focused, so the native keyboard overlays the panel instead of collapsing or repositioning it. Closing the keyboard and genuine orientation changes resume the normal responsive layout; the desktop layout is unchanged.

Settings includes a **Backup & restore** section. It downloads a versioned Company-only JSON snapshot of every isolated company cache, history, rankings, planner state, layout, settings, alerts, and daily-sync state. API keys are excluded by default; including them on download and restoring them later both require separate explicit checkboxes. Version 1 single-company backups migrate to the version 2 profile model while discarding obsolete TornStats data. A keyless restore preserves matching keys already held locally; a key-containing backup replaces them only after its second explicit checkbox is selected. Loading validates the format, namespace, schema, and stored values before a second confirmation replaces current local Company data. Restoring never changes Torn data, and the currently selected storage adapter remains in use. User-initiated JSON backup and history CSV exports call TornPDA’s native `shareFile({ base64Data, fileName })` handler, which opens the system share sheet; desktop falls back to a normal local download. On Android and iOS, choose Files or another destination from that system sheet—it is not a browser save-location picker. The companion waits for a confirmed native result, reports a native share failure rather than falsely claiming a download, and prevents overlapping share requests.

The daily coordinator runs at **18:10 UTC** while the Company page/userscript is active. It refreshes each pending saved company, captures or updates one de-duplicated reporting-day snapshot, updates same-type rankings, and only then delivers optional alerts. Alert mode is persisted as **Off**, **Combined all-company alert**, **Separate alert for every company**, or **Selected company only**. Toasts and notifications remain independent opt-ins and default to off. The income message includes full Daily Income, Daily Profit, Daily Customer Count, Star Level, and integer Stock Difference versus the prior day; the employee message names every staff member below −12 Addiction or Inactivity effectiveness. Detailed in-panel toast cards stack instead of replacing one another. Desktop uses the userscript/browser-notification fallback; TornPDA uses native toast and notification handlers when available.

When daily-tick notifications are enabled under a non-**Off** alert mode, confirmed TornPDA installs keep one generic native 18:10 UTC reminder with a callback to the Company page. It never claims live figures; it tells the user to open the companion so TornPDA can run the all-company sync. The reminder is refreshed on native startup/confirmation and removed when notifications are disabled or local companion data is cleared. Desktop deliberately has no simulated background-reminder capability. Scheduled page work and automatic foreground refreshes pause while the document is hidden; after a page becomes visible, a missed 18:10 all-company sync runs once for only the incomplete profiles.

## Console diagnostics

The browser/TornPDA console shows `[Naughty Company Companion]` startup/runtime, storage, daily-sync, and API transport diagnostics by default. Request logs contain only method, host, path, status, transport, and duration. Query strings, headers, and Torn API keys are redacted; response bodies are never logged.

## Scrolling

The main panel owns vertical page flow, including the full Same-type companies ranking table. Table, tab, summary, toast, and modal scrollbars are visually hidden while mouse-wheel, keyboard, and TornPDA touch scrolling remain available. At an actual panel or visible viewport width of 820px or less on desktop, and across TornPDA portrait/compact-tablet widths through 960px, tabs wrap and summary/cards reflow with no horizontal table scroll. Planner, Stock, and history use labeled stacked cards; Same-type companies and rank neighbors retain compact list rows; sufficiently wide displays retain detailed tables. Selected stock-chart daily details reflow into labeled single-column rows in portrait layouts.

## Updating and verification

Reopen the raw userscript URL in your userscript manager to update.

```powershell
node --check "Naughty Company Companion.user.js"
node --test company-companion-regression.test.js
```

## Data sources

- [Torn API documentation](https://www.torn.com/api.html)

## Community and governance

- [Contributing guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [MIT License](LICENSE)
- [Report a bug or request a feature](https://github.com/SharpSplinter/Naughty-Company-Companion/issues)
- [Pull request template](.github/pull_request_template.md)
