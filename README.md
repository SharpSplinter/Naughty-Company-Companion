# Naughty Company Companion

Naughty Company Companion is a Tampermonkey and TornPDA dashboard for Torn company directors and managers. It brings income, profit, staffing efficiency, TornStats-based role planning, same-type income ranking, stock, and local trends into one local-first panel.

## Features

### Overview and income

- Torn-reported daily and weekly income.
- Daily and weekly profit plus 30-day tracked or forecast income/profit figures.
- Company condition, funds, ad budget, trains, applications, and recent funds news when the API key can access them.
- Same-type income rank, transparent health score, observed next-star gap, and previous-star buffer.

### Team and planner

- Compact employee cards showing current role, current total effectiveness, local assigned role, assigned effectiveness, addiction and inactivity effects, best fit, wage, and recent activity.
- Current and assigned effectiveness prefer **TornStats role base plus Torn non-working effects**. Torn’s direct total is used only before a matching TornStats projection exists.
- Per-employee role selector, lock control, and local-only assignment plan.
- Dynamic roles discovered from the matching TornStats company-type block; no hard-coded position list.
- A dedicated **Position config** modal holds per-role max-quantity dropdowns and persistent click-up/click-down priority controls. Auto-assignment locks current seats first, then fills top-to-bottom by priority and projected efficiency within company capacity.
- Sortable Assignment preview columns: Employee, Current, Assigned, Current Eff., Assigned Eff., Change, and Lock.

### Rankings, stock, and trends

- Same-type company ranking is refreshed through Torn pagination once per Torn day at **18:05 UTC**, then sorted locally by weekly income. A manual refresh checks the persisted successful Torn-tick date and will not duplicate a completed daily ranking pull; a missed or failed pull remains eligible.
- Health score defined transparently as weekly-income percentile among same company type.
- Observed weekly-income gaps to the next and previous star bands; these are planning values, not an official Torn formula.
- Stock, sales, gross margin, per-item **Current stock worth** (in-stock quantity × sale price), and a daily **Stock difference** once a prior local reporting-day snapshot exists.
- Local daily history retained for 92 days, axis-labeled interactive charts with selectable day points and daily details, and CSV export. The stock-value trend lives at the top of the Stock tab; Trends contains income/profit, effectiveness, and ranking charts.
- Your-company ranking context for both the current star level and the same company type.

### Interface

- Overview, Team, Planner, Rankings, Stock, Trends, and Settings tabs.
- Explicit refresh labels explaining which data will be loaded.
- Persistent panel position, size, selected tab, plans, capacities, priorities, and local history.
- Explicit TornPDA/user-agent and effective viewport/scale detection. The mobile runtime activates at an effective width ≤700px, effective height ≤520px, or scale >1.1 at ≤960px; responsive reflow also activates whenever the actual panel/visible viewport is ≤820px. Team uses a detailed top-to-bottom list on desktop and compact cards in TornPDA or compact mode.
- Desktop drag/resize/minimize controls and a safe mobile TornPDA layout.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or use TornPDA’s userscript support.
2. Open the [raw userscript](https://raw.githubusercontent.com/xf4k31tx/Naughty-Company-Companion/main/Naughty%20Company%20Companion.user.js) and install it.
3. Reload Torn and open the panel from the chess-piece launcher, or press <kbd>Alt</kbd>+<kbd>C</kbd>.
4. In **Settings**, save a Torn API key, then select **Save keys & refresh Torn data**.
5. Optionally save a TornStats API key and enable the explicit projection-consent toggle before selecting **Calculate TornStats role projections**.

## API access and refresh behavior

A Torn API key is required for company data. A Limited or director/manager-capable key exposes more fields, including stock, employee wages, applications, and funds news. Missing fields remain unavailable rather than being treated as zero.

The top **Refresh Torn data** action loads company profile, employees, stock, funds news, and applications. Same-type rankings are loaded separately because they require paging through every company of your type; automatic rank pulls run only at 18:05 UTC and a manual button never repeats a successful current-Torn-day pull. TornStats efficiency projections are loaded separately and cached for 24 hours per employee work-stat triplet.

## TornStats consent and privacy

Role projections are optional. When enabled, the script sends each employee’s Manual labor, Intelligence, and Endurance values to TornStats with your TornStats API key to calculate role efficiencies. This is disclosed in Settings and is never performed until you opt in.

All keys, cached data, staffing plans, rankings, and history stay in local per-script storage. The companion requests Torn data directly from `api.torn.com` and uses `www.tornstats.com` only for consented role projections. It does not upload history or plans elsewhere.

Treat API keys as secrets. Revoke and replace a key if it may have been exposed.

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

On TornPDA, the companion prefers the native per-script `PDA_storage` store. It loads the local namespace once at startup and safely batches ordinary writes (critical settings, layout, and alert/reminder state flush immediately). Existing Tampermonkey/GM values are copied into `PDA_storage` only when the corresponding native value is missing, so an established native value is not overwritten. Settings shows the active runtime, visible/panel screen size, and storage method, with an unchecked-by-default **Use legacy GM storage** switch that safely migrates local companion state when selected. If native storage is unavailable or full, the companion keeps working through its compatible GM/local-storage fallback and displays a storage warning rather than discarding the change.

Native runtime identity and compact presentation are deliberately separate. A TornPDA runtime is confirmed only after the `flutterInAppWebViewPlatformReady` bridge can answer `isTornPDA`; a user-agent hint or small screen alone does not claim native status. Confirmed TornPDA and compact desktop viewports use the touch-friendly, safe-area-aware card layout, while regular desktop uses the detailed layout. Network requests use the declared Tampermonkey grants when available and can use TornPDA's native `PDA_httpGet` only after that bridge has been confirmed. When TornPDA injects its documented API-key placeholder, the companion uses it automatically without showing or logging the value; an explicitly saved local Torn key takes precedence.

Settings includes a **Backup & restore** section. It downloads a versioned Company-only JSON snapshot of local cache, history, rankings, projections, planner state, layout, settings, and alert state. API keys are excluded by default; including them on download and restoring them later both require separate explicit checkboxes. Loading validates the format, namespace, schema, and stored values before a second confirmation replaces current local Company data. Restoring never changes Torn or TornStats data, and the currently selected storage adapter remains in use.

The daily-tick assistant runs while the Company page/userscript remains active. It produces an 18:00 UTC alert with full Daily Income, Daily Profit, Daily Customer Count, Star Level, and integer Stock Difference versus the prior day, then an employee addiction/inactivity-risk alert at 18:10 UTC. When the current snapshot predates that tick, it silently refreshes first; otherwise the message labels the data as cached or unavailable. TornPDA receives native toast and notification delivery; the companion also keeps detailed in-panel toast cards stacked so one alert does not replace another. Desktop uses the userscript/browser-notification fallback. User-triggered save/refresh/export feedback also prefers the native toast handler with a desktop in-panel fallback.

Confirmed TornPDA installs also keep one generic native background reminder for each next phase (18:00 and 18:10 UTC), with a callback to the Company page. These reminders never claim live figures: they tell you to open the companion and refresh. When the Company page is active, the script cancels that phase's generic reminder immediately before the tick, sends the detailed live alert, and establishes the following day's generic reminder. The schedules are refreshed on native startup/confirmation and removed when local companion data is cleared. Desktop deliberately has no simulated background-reminder capability. Scheduled page work and automatic core refreshes pause while the document is hidden, then timers and due-day checks resume safely when it becomes visible.

## Console diagnostics

The browser/TornPDA console shows `[Naughty Company Companion]` startup/runtime, storage, and API transport diagnostics by default. Request logs contain only method, host, path, status, transport, and duration. Query strings, headers, Torn API keys, and the TornStats key path segment are redacted; response bodies are never logged.

## Scrolling

The main panel owns vertical page flow, including the full Same-type companies ranking table. Table, tab, summary, toast, and modal scrollbars are visually hidden while mouse-wheel, keyboard, and TornPDA touch scrolling remain available. At an actual panel or visible viewport width of 820px or less (and throughout TornPDA), tabs wrap and summary/cards reflow with no horizontal table scroll. Planner, Stock, and history use labeled stacked cards; Same-type companies and rank neighbors retain compact list rows; wider desktop panels retain detailed tables. Selected stock-chart daily details reflow into labeled single-column rows in portrait layouts.

## Updating and verification

Reopen the raw userscript URL in your userscript manager to update.

```powershell
node --check "Naughty Company Companion.user.js"
node --test company-companion-regression.test.js
```

## Data sources

- [Torn API documentation](https://www.torn.com/api.html)
- [TornStats API documentation](https://www.tornstats.com/api)
