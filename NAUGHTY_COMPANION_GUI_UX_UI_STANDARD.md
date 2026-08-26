# Naughty Companion GUI/UX/UI Standard

> This is the canonical shared interface contract for Naughty Company Companion, Naughty Faction Companion, Naughty Inventory Companion, and Naughty Awards Tracker. It is deliberately product-neutral. Requirements that apply to only one script are isolated in the appendices and must not be copied into another script unless the user explicitly requests that feature.

## 1. How to use this standard

### 1.1 Scope labels

- **Shared** requirements apply to every active standalone Naughty Companion script.
- **Script-specific** requirements apply only to the named script and are collected in its appendix.
- A new companion must follow every Shared requirement and add its own named appendix before it receives domain-only controls, data, alerts, or tabs.
- A script must not inherit a Company selector, stock chart, planner, rankings, FFScouter behavior, inventory export, awards search, or any other feature merely because it is described in another script's appendix.

### 1.2 Normative words

- **Must** and **must not** are release requirements.
- **Should** is required unless a user-approved, documented exception exists.
- A UI-affecting update must be checked against the Shared sections and its own appendix before merge or publication.

### 1.3 Active scope

This standard covers the visible product: window presentation, navigation, responsive layout, touch, scrolling, feedback, status/freshness, settings, storage/export/backup surfaces, formatting, and script-specific user flows. It does not make API, calculation, or storage implementation details visible unless they affect user behavior or security.

## 2. Shared visual and interaction language

### 2.1 Appearance

- Use the Naughty Companion visual language: a polished, compact, high-contrast navy/slate dark interface with restrained blue borders; teal for active/positive states; amber for attention; and red for errors/negative states.
- Cards, lists, tables, tabs, dialogs, controls, and notices must share consistent spacing, radii, typography, borders, focus states, and hover/pressed feedback.
- The active tab must be clear. Loading, disabled, fresh, partial, stale, empty, and error states must be visually distinct and use plain language.
- Critical text must wrap or reflow before it is clipped. Do not use an ellipsis to hide essential values, status details, notification contents, labels, or actionable control text.
- Cards, rows, controls, charts, dialog content, and tab panels must remain in normal layout flow. They must never overlap, collide, or obscure one another at supported viewport sizes.

### 2.2 Shared window shell

- The header must show the script name, concise status, a clear named refresh action, and minimize control. A context selector belongs in the header only when the script has multiple contexts/profiles.
- Refresh controls must state their exact scope, such as **Refresh faction data**, **Refresh inventory**, or **Refresh Torn data**. An icon may supplement but never replace the explanatory label.
- Interactive header elements (buttons, selects, inputs, labels, links, and equivalent controls) must receive their own click/tap events and must not accidentally begin panel dragging.
- On desktop, the panel is draggable from a non-interactive header region and resizable from both lower corners. Its position and size persist.
- When minimized, a click/tap anywhere on the launcher restores the panel. Dragging past the movement threshold instead repositions the launcher, and its location persists. Keyboard activation remains supported.

### 2.3 Navigation

- Each script presents only the tabs it needs, in a stable order. The selected tab persists.
- Tabs must remain fully reachable at every size: a row where it fits and a wrapped/grid layout where it does not. Tabs must never require horizontal page/panel scrolling.
- Domain tabs may differ by script, but tab selection, active-state feedback, status disclosure, scrolling rules, and responsive behavior must remain equivalent.

## 3. Shared runtime and responsive-layout contract

### 3.1 Runtime is not layout

- Runtime reports **Desktop** or **TornPDA** only from the TornPDA native bridge and/or reliable TornPDA user-agent evidence. Do not infer runtime solely from touch capability, width, or orientation.
- Layout is separately measured from available panel width, visual viewport, zoom, orientation, and safe-area constraints. Use the shared profiles **narrow**, **compact**, **standard**, and **wide**.
- Settings must show Runtime, Screen/Panel Size, Layout Profile, and active Storage Method so users can understand the active presentation.
- `ResizeObserver`, visual-viewport events, and orientation changes must update layout without resetting the selected tab, context/profile selection, form values, scroll position, dialog state, or in-progress interaction.

### 3.2 Horizontal-fit requirement

- Every script must stay horizontally viewable with **zero horizontal scrolling** in portrait, landscape, small TornPDA panels, narrowed desktop panels, and common desktop zoom levels.
- Hiding horizontal overflow is not a valid substitute for a fitting layout. Use `min-width: 0`, bounded widths, wrapping, responsive grids/flex flow, and layout-profile adaptations.
- Tables that cannot remain readable must transform into labeled list/card rows in narrow or compact layouts. Desktop may retain dense tables/lists when they actually fit.
- Long names, status messages, data values, buttons, and news/descriptions must wrap, stack, or grow rather than force overlap or clipping.

### 3.3 Vertical scrolling and touch

- Use one primary vertical panel/content scroller with visually hidden scrollbars. Mouse wheel, keyboard, trackpad, TornPDA touch drag, and native/inertial touch scrolling must continue to work.
- Avoid nested vertical scrollers. A necessary special-purpose inner region must hide its scrollbar, size correctly within the parent, and never prevent the main panel from scrolling.
- TornPDA uses a safe-area-aware full-viewport presentation. Vertical scrolling is allowed and expected; horizontal scrolling is prohibited.
- Touch behavior must support vertical pan and pinch. Taps on controls must not be interpreted as panel or launcher drags.
- The mobile virtual keyboard must overlay above the script and keep the focused input usable. It must not crash, collapse, or make the panel unusable.

### 3.4 Content adaptation

- Desktop retains detailed lists/tables where the measured layout can show them cleanly.
- TornPDA/mobile and narrow layouts use compact labeled cards/lists when they improve readability and eliminate horizontal movement.
- Equivalent data, controls, and actions must remain available after reflow. A responsive conversion must not silently remove functionality.

## 4. Shared feedback, status, and accessibility

- Every tab must show a compact status row at its top containing source time in exact UTC, relative age, source, and one of **Fresh**, **Partial**, **Stale**, or **Not updated**.
- Status must reflect the selected context/profile and meaningful source for that tab; it must not present an unrelated global timestamp as fresh data.
- Refresh, save, import, export, backup, restore, management, and notification actions must report loading, success, cancellation, partial result, or error feedback.
- Toasts and notifications stack. A newer notification must not overwrite or prematurely dismiss another one that is still relevant.
- Toast/notification bodies must present their required details in full, rather than a shortened line ending in `…`.
- Errors must explain the failure in plain language and offer a safe next action where possible. Console diagnostics may aid support, but must never expose API keys or other secrets.
- Controls require readable labels/tooltips, accessible names, sufficient contrast, visible keyboard focus, and keyboard activation where applicable.

## 5. Shared formatting and truthfulness

- All ordinary numeric values display as comma-separated integers.
- IDs are raw digits with no thousands separator, for example `ID 8317`, never `ID 8,317`.
- Currency, percentages, and dates/timestamps use their appropriate formats. A script-specific exception such as a measured average may define its decimal precision in that script's appendix.
- Unknown, unavailable, untracked, loading, or not-yet-calculated values must use an explicit state such as `—`, **Unavailable**, or **Not updated**. Never fabricate zero or a confident-looking value.
- User-visible wording must use the approved domain language. A script-specific terminology rule belongs in that script's appendix.

## 6. Shared settings, storage, export, and backup UX

- Every script has a Settings tab that clearly groups runtime/layout/storage status, refresh behavior, notification choices where applicable, backup/restore, and any advanced/legacy storage option.
- Native TornPDA storage is preferred. A persisted **Use legacy GM storage** checkbox is unchecked by default and exists as an explicit fallback.
- Storage writes must be batched/debounced. A native quota or availability failure must fail over safely; delete operations must remove stale queued writes as well as persisted values.
- Do not render saved API keys into input values or DOM attributes, write them to normal logs, include them in normal exports, or include them in ordinary backups. Do not claim cryptographic at-rest encryption unless it actually exists.
- Backups/restores must preserve a script's state without corrupting or overwriting independent profiles/contexts. Normal backup excludes keys; an explicit key-inclusive backup, if a script offers one, is opt-in and clearly labeled.
- On TornPDA, export/backup sharing uses the native `shareFile` handler and system share sheet when available. Desktop uses a normal local-download fallback. The UI reports success, error, or cancellation.
- Native reminders, native toasts, injected API keys, and similar TornPDA capabilities are used when available, with safe browser behavior when they are not.

## 7. Shared verification gate

Before publishing any UI-affecting change, verify:

- Desktop at a normal panel size, a narrowed/resized panel, and browser zoom.
- TornPDA/phone portrait and landscape, including safe areas, rotation, and small/large usable sizes.
- Every tab with realistic long content, populated lists/tables, empty data, loading, partial/error data, and stale data.
- No horizontal scrolling, clipped critical copy, card/table/control overlap, broken dialog bounds, or unusable inner scrollbar.
- Mouse, keyboard, touch scrolling, tap selection, drag/resize, minimized-launcher restoration, and mobile virtual-keyboard input.
- Accurate per-tab source time/state, stacked feedback, secret-safe diagnostics, storage fallback behavior, and export/backup restore flow.
- Existing automated regression tests plus tests covering the changed behavior.

An unverified layout/collision/touch regression blocks a final-release claim for the affected script.

## Appendix A — Naughty Company Companion only

These requirements apply only to Naughty Company Companion. They are not requirements for Faction, Inventory, Awards, or future companions.

### A.1 Company header, profiles, and cadence

- The header includes a Company selector that always opens on click/tap and lists the current Company, every saved Company profile, and **Add company…**.
- Company data is isolated by returned Company ID. Each profile owns its Director key, cache/current data, history, planner configuration, rankings, freshness records, and alerts. A key/company mismatch must fail safely and never merge profiles.
- The selected profile determines displayed data. Every configured profile, selected or not, participates in the daily all-company update.
- Scheduled Company work uses **18:10 UTC**: all-company refresh, one de-duplicated daily snapshot per reporting day, rankings, reporting-day/week boundaries, and Company alert phases. A bounded, mutexed all-company queue reuses same-type ranking pulls.
- Inactive pages pause foreground auto-refresh. When active again, one eligible missed daily all-company catch-up runs. The optional foreground interval remains separate.
- A successful daily rank pull is never repeated. A manual ranking refresh checks the persisted successful 18:10 UTC tick and reports that the data is already current; failed/incomplete pulls stay eligible for retry.

### A.2 Company navigation and Overview

Company tab order is **Overview**, **Team**, **Planner**, **Rankings**, **Stock**, **Trends**, and **Settings**.

- Overview presents Company identity/star level, financial/condition/workforce summary, rank/star outlook, and source state in responsive cards.
- Daily/weekly/30-day Income and Profit, health score, cash/value, trains/ad budget/company condition, and recent meaningful source state appear when their source data supports them.
- User-visible financial wording is **Income** and **Profit**; do not use **Revenue** or **Estimate** for these outcomes.
- Applications report **Pending**, **Accepted**, and **Withdrawn** separately. Never label the application total as Pending. Example: `0 Pending` and `2 Accepted · 3 Withdrawn`.
- Recent funds news wraps and fits inside its card in desktop portrait and TornPDA/mobile portrait.

### A.3 Company Team

- Team displays current position, current total effectiveness, assigned position/effectiveness, addiction effect, inactivity effect, best-fit position/effectiveness, wage, and recent activity where available.
- Current effectiveness uses Torn-reported **total** effectiveness. Local assignments/best fit use the bundled local role calculator plus relevant non-working effect delta. No TornStats efficiency endpoint, key, cache, consent, or metadata grant is used.
- Average employee effectiveness displays one decimal place.
- Assigned-position controls render real selectable positions, persist immediately, and update projections. Team retains its relevant sort/filter/lock behavior.
- Desktop uses a detailed top-to-bottom employee list where it fits; TornPDA/narrow layouts use compact labeled cards/lists without horizontal movement.

### A.4 Company Planner

- Planner includes named controls to save, auto-assign unlocked staff, refresh local role projections, and open **Position config**.
- **Position config** opens a modal/popup rather than permanently consuming Planner space. It remains vertically scrollable with hidden scrollbars in compact layouts.
- Each role shows Max Qty as a dropdown, occupied quantity, and persistent click/tap up/down priority controls. Manual numeric priority entry is not used.
- Roles display and persist top-to-bottom by priority. Auto-assignment honors locks and capacity, then fills roles by priority/projected effectiveness.
- Assignment preview has sortable Employee, Current, Assigned, Current Eff., Assigned Eff., Change, and Lock columns.

### A.5 Company Rankings

- Rankings shows exactly two Company ranking facts: current rank out of all companies at the current star level/type (`x / z`) and current rank out of all same-type companies (`x / y`). Do not duplicate these facts in redundant cards/rows.
- Same-type Companies and Ranked Neighbors remain compact list-only/table presentations, not decorative cards. They correctly size within the main panel and do not expose a broken/maxed inner scrollbar.
- Search/filter and clearly named refresh actions remain reachable in every layout.

### A.6 Company Stock and Trends

- The Stock tab begins with the Stock trend chart, above Stock Items, Stock Value, Reported Gross Margin, and Stock & sales.
- Stock uses the Trends visual language: axes, hover/selectable points, tooltips, and readable daily details. Detail fields reflow into labeled rows/cards in portrait/compact layouts.
- Stock & sales includes stock, sales, gross margin, **Current stock worth** (in-stock quantity × sale price), and daily **Stock difference** once a prior snapshot exists.
- Trends contains selectable Income, Profit, average employee effectiveness, and ranking-history charts. Stock trend belongs only to Stock.
- Every chart has true axes, hover tooltips, selectable/clickable daily points, and selected-day details. Income and Profit expose daily values on hover; selected points compare with a prior local snapshot when available.

### A.7 Company alerts and settings

- Company alert mode persists one of **Off**, **Combined all-company alert**, **Separate alert for every company**, or **Selected company only**.
- Company toast/notification delivery is optional in Settings and uses native TornPDA feedback/reminders where available.
- Daily tick alerts include Daily Income, Daily Profit, Daily Customer Count, Star Level, and integer Stock Difference versus the prior day. Employee-effectiveness alerts list each employee with addiction or inactivity below -12. Simultaneous alerts stack.
- Company Settings exposes profile management and profile-safe backup/restore in addition to the Shared settings requirements.

## Appendix B — Naughty Faction Companion only

These requirements apply only to Naughty Faction Companion.

- Faction General cards, including Chain and Respect, must stay in normal responsive flow and never overlap.
- Faction tab content must remain vertically touch-scrollable on TornPDA.
- In FFScouter compact/TornPDA layouts, War Targets parameters and the enemy list stack vertically rather than sit side by side.
- All hospital-alert controls, including enable/disable, selected FF/BS-range behavior, time threshold, and reset, live in Faction Settings. The settings view fits horizontally, scrolls vertically with a hidden scrollbar, and remains readable on TornPDA.
- FFScouter alerts only notify enemies that satisfy the currently selected FF/BS parameters; with no filter selected, eligible enemy players may be considered. First enable asks for the persisted 1, 3, or 5 minute threshold, with reset in Settings.

## Appendix C — Naughty Inventory Companion only

These requirements apply only to Naughty Inventory Companion.

- The main Inventory window and its item list coordinate vertical scroll so TornPDA users can move through more than one item naturally; an inner list must not trap touch scrolling.
- Inventory offers **Save as CSV** and **Save as Spreadsheet** exports. The output is cleanly readable and does not need an import flow.

## Appendix D — Naughty Awards Tracker only

These requirements apply only to Naughty Awards Tracker.

- Awards Tracker must preserve the shared compact responsive presentation without horizontal scrolling or clipped/overlapping cards.
- Honors and Medals provide search controls appropriate to their visible collections.

## Appendix E — Adding a new Naughty Companion

For every new companion, first adopt Sections 2–7 unchanged. Then create one explicitly named appendix containing only that script's domain data, tab order, special controls, special notifications, precision/terminology exceptions, export formats, and validation cases. Do not add a domain feature to the Shared sections unless it is truly required across every active companion.
