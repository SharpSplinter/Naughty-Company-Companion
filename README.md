# Naughty Company Companion

Tampermonkey and TornPDA userscript for Torn company directors.

## Included

- Daily, weekly, and 30-day tracked/forecast revenue and net estimates
- Employee effectiveness, addiction and inactivity impact, and local staffing planner
- Opt-in TornStats role-efficiency projections with per-position caps, priority, and locks
- Same-type income rank, transparent income-percentile health score, and observed star gaps
- Stock, gross-margin, company-condition, funds-news, and local trend views
- Persistent panel position/size, mobile-safe layout, CSV export, and local-only history

## Install

1. Add [Naughty Company Companion.user.js](./Naughty%20Company%20Companion.user.js) to Tampermonkey or TornPDA.
2. Open the panel with the chess-piece launcher (or <kbd>Alt</kbd>+<kbd>C</kbd>).
3. In **Settings**, save a Torn API key. A Limited/director key enables stock, wages, funds news, and richer estimates.
4. Optionally add a TornStats API key. Enable the explicit consent toggle before requesting per-employee projections; this sends employee M/I/E work-stat triplets to TornStats.

## Calculation notes

Revenue is supplied by Torn. Daily net estimate is:

```text
daily revenue − sold stock cost − advertising budget − total wages
```

Weekly net follows Torn Company Assistant’s observed formula:

```text
weekly revenue − 7 × (advertising budget + total wages)
```

The health score is a transparent same-type weekly-income percentile, not an unpublished Torn score. Star gaps use observed weekly-income rank cutoffs and are explicitly estimates.

## Data sources

- [Torn API v2 documentation](https://www.torn.com/api.html)
- [TornStats API documentation](https://www.tornstats.com/api)

## Verify

```powershell
node --check "Naughty Company Companion.user.js"
node --test company-companion-regression.test.js
```
