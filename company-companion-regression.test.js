const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const companion = require("./Naughty Company Companion.user.js");
const source = fs.readFileSync(path.join(__dirname, "Naughty Company Companion.user.js"), "utf8");

const company = (id, weekly, rating, daily = weekly / 7) => ({
    id,
    name: `Company ${id}`,
    rating,
    income: { daily, weekly }
});

test("ranking uses star-slot cutoffs instead of adjacent live ratings", () => {
    const companies = [
        company(1, 1000, 10),
        company(2, 950, 9),
        company("own", 850, 9),
        company(4, 800, 10),
        company(5, 700, 9),
        company(6, 600, 8),
        company(7, 500, 8)
    ];
    const metrics = companion.calculateRankingMetrics(companies, company("own", 850, 9), { 10: 2, 9: 3, 8: 2 });

    assert.equal(metrics.rank, 3);
    assert.equal(metrics.nextStar, 10);
    assert.equal(metrics.nextRequired, 950);
    assert.equal(metrics.nextGap, 100);
    assert.equal(metrics.previousStar, 8);
    assert.equal(metrics.previousBuffer, 250);
    assert.equal(metrics.percentile, 71.4);
});

test("company rank summary has only same-star and same-type rank fields", () => {
    const profile = company("own", 850, 9);
    const metrics = companion.calculateRankingMetrics([
        company(1, 1000, 10),
        company(2, 950, 9),
        profile,
        company(4, 800, 10),
        company(5, 700, 9),
        company(6, 600, 8)
    ], profile, { 10: 2, 9: 3, 8: 1 });

    assert.deepEqual(companion.companyRankSummary(metrics, profile), [
        { rank: 2, total: 3, label: "Current rank in 9★ star level" },
        { rank: 3, total: 6, label: "Current rank among same-type companies" }
    ]);
});

test("daily and weekly net profits mirror company profit rules", () => {
    const result = companion.financials({
        profile: {
            income: { daily: 1000, weekly: 7000 },
            advertisement_budget: 100,
            employees: { hired: 2 }
        },
        employees: [{ wage: 120 }, { wage: 80 }],
        stock: [{ cost: 30, sold_amount: 10 }]
    });

    assert.equal(result.dailyProfit, 400);
    assert.equal(result.weeklyProfit, 4900);
});

test("daily net remains unavailable when required stock cost is unavailable", () => {
    const result = companion.financials({
        profile: {
            income: { daily: 1000, weekly: 7000 },
            advertisement_budget: 100,
            employees: { hired: 1 }
        },
        employees: [{ wage: 200 }],
        stock: [],
        stockAvailable: false
    });

    assert.equal(result.dailyProfit, null);
    assert.equal(result.weeklyProfit, 4900);
});

test("TornStats company block prefers the authoritative Torn type id", () => {
    const response = {
        12: { company: "Oil Company", Director: 101 },
        99: { company: "Oil Rig", Director: 999 }
    };

    assert.deepEqual(companion.projectionBlock(response, 12, "Oil Rig", ["Director"]), response[12]);
});

test("planner locks current seats then obeys position caps and priority", () => {
    const result = companion.assignProjectedRows(
        [
            { id: "1", currentPosition: "Director", projected: { Director: 40, Trainer: 120 } },
            { id: "2", currentPosition: "Trainer", projected: { Director: 110, Trainer: 90 } },
            { id: "3", currentPosition: "Trainer", projected: { Director: 100, Trainer: 80 } }
        ],
        ["Director", "Trainer"],
        { Director: 1, Trainer: 2 },
        3,
        ["Director", "Trainer"],
        { 1: true }
    );

    assert.deepEqual(result.assigned, { 1: "Director", 2: "Trainer", 3: "Trainer" });
    assert.deepEqual(result.unassigned, []);
});

test("planner order keeps saved priorities first and includes new positions", () => {
    assert.deepEqual(companion.orderedPriorityPositions(["Director", "Trainer", "Sales"], ["Sales", "Director"]), ["Sales", "Director", "Trainer"]);
});

test("reporting day rolls over at 18:10 UTC", () => {
    const before = Date.UTC(2026, 7, 18, 18, 9, 59);
    const after = Date.UTC(2026, 7, 18, 18, 10, 0);

    assert.equal(companion.reportingPeriod(before), Date.UTC(2026, 7, 17, 18, 10, 0));
    assert.equal(companion.reportingPeriod(after), after);
});

test("stock difference compares current stock to the prior reporting-day snapshot", () => {
    const item = { id: 42, in_stock: 125 };
    const history = [
        { period: 100, stock: { 42: { inStock: 95, onOrder: 0 } } },
        { period: 200, stock: { 42: { inStock: 110, onOrder: 0 } } }
    ];

    assert.equal(companion.stockDifference(item, companion.previousStockSnapshot(history, 300)), 15);
    assert.equal(companion.stockDifference(item, companion.previousStockSnapshot([], 300)), null);
});

test("current stock worth uses current quantity and sale price", () => {
    assert.equal(companion.currentStockWorth({ in_stock: 125, price: 42 }), 5250);
});

test("current effectiveness combines TornStats role base with Torn non-working effects", () => {
    assert.equal(companion.preferredCurrentEfficiency(130, 102, 26), 128);
    assert.equal(companion.preferredCurrentEfficiency(130, undefined, 26), 130);
});

test("assignment preview values sort through the shared table sorter", () => {
    const rows = [
        { name: "B", current: 130, assigned: 128, change: -2, lock: 0 },
        { name: "A", current: 128, assigned: 131, change: 3, lock: 1 }
    ];

    assert.deepEqual(companion.sortRows(rows, { key: "change", dir: "asc" }).map((row) => row.name), ["B", "A"]);
    assert.deepEqual(companion.sortRows(rows, { key: "name", dir: "asc" }).map((row) => row.name), ["A", "B"]);
});

test("trend performance compares available daily signals with the prior day", () => {
    const result = companion.trendPerformance(
        { dailyIncome: 110, stockValue: 90, averageEmployeeEfficiency: 101, rating: 5 },
        { dailyIncome: 100, stockValue: 100, averageEmployeeEfficiency: 100, rating: 5 }
    );
    assert.equal(result.label, "Improving");
});

test("trend selector uses only local metrics and includes Profit in point tooltips", () => {
    const history = [
        { period: 100, dailyIncome: 100, dailyProfit: 25, stockValue: 900, stockQuantity: 9, averageEmployeeEfficiency: 100, companyRank: 3, companyRankTotal: 20 },
        { period: 200, dailyIncome: 120, dailyProfit: null, stockValue: null, stockQuantity: null, averageEmployeeEfficiency: null, companyRank: null }
    ];

    assert.deepEqual(companion.trendChartAvailability(history, "stock"), {
        id: "stock",
        label: "Stock",
        rowCount: 2,
        dataRows: 1,
        series: [{ key: "stockValue", label: "Current stock worth", dataPoints: 1 }]
    });
    assert.match(companion.trendPointTooltip(history[0], "income-profit"), /Daily income: \$100\nDaily profit: \$25/);
    assert.match(companion.trendPointTooltip(history[0], "stock"), /In-stock quantity: 9/);
    assert.match(companion.trendPointTooltip(history[0], "effectiveness"), /Avg employee effectiveness: 100/);
    assert.match(companion.trendPointTooltip(history[0], "ranking"), /Company rank: #3/);
    assert.equal(companion.trendNumber(null), null);
});

test("runtime mode separates native TornPDA confirmation from compact viewport detection", () => {
    assert.equal(companion.runtimeMode({ userAgent: "TornPDA", width: 1200, height: 800 }), "mobile");
    assert.equal(companion.runtimeMode({ isTornPDA: true, width: 1600, height: 1000 }), "mobile");
    assert.equal(companion.isCompactViewport({ width: 760, height: 700, scale: 1.25 }), true);
    assert.equal(companion.runtimeMode({ width: 760, height: 700, scale: 1.25 }), "mobile");
    assert.equal(companion.isCompactViewport({ width: 1200, height: 800, scale: 1 }), false);
    assert.equal(companion.runtimeMode({ width: 1200, height: 800, scale: 1 }), "desktop");
});

test("daily tick alerts use independent 18:00 and 18:10 UTC phases", () => {
    const beforeTick = Date.UTC(2026, 7, 24, 17, 59, 59);
    const incomeTick = Date.UTC(2026, 7, 24, 18, 0, 0);
    const employeeTick = Date.UTC(2026, 7, 24, 18, 10, 0);

    assert.equal(companion.isDailyAlertDue(beforeTick, 0), false);
    assert.equal(companion.isDailyAlertDue(incomeTick, 0), true);
    assert.equal(companion.isDailyAlertDue(incomeTick, 10), false);
    assert.equal(companion.isDailyAlertDue(employeeTick, 10), true);
    assert.equal(companion.dailyAlertPhaseTime(employeeTick, 10), employeeTick);
    assert.equal(companion.nextDailyAlertTimestamp(incomeTick), employeeTick);
});

test("daily alert toasts keep full messages stacked instead of replacing one another", () => {
    const dailyToast = source.match(/async function showDailyToast[\s\S]*?\n    }\n\n    function companyPageUrl/);
    assert.ok(dailyToast);
    assert.match(dailyToast[0], /showDesktopToast\(text, tone, 10\)/);
    assert.match(dailyToast[0], /callConfirmedPdaHandler\("showToast"/);
    assert.doesNotMatch(source, /toastChain|toastVisibleUntil/);
});

test("same-type rankings use one persisted Torn-tick refresh date and a 18:05 UTC due time", () => {
    const before = Date.UTC(2026, 7, 24, 18, 4, 59);
    const due = Date.UTC(2026, 7, 24, 18, 5, 0);
    const nextMorning = Date.UTC(2026, 7, 25, 10, 0, 0);

    assert.equal(companion.isDailyRankingRefreshDue(before), false);
    assert.equal(companion.isDailyRankingRefreshDue(due), true);
    assert.equal(companion.rankingRefreshDay(before), "2026-08-23");
    assert.equal(companion.rankingRefreshDay(due), "2026-08-24");
    assert.equal(companion.rankingRefreshedForDailyTick({ dailyRefreshDay: "2026-08-24" }, nextMorning), true);
    assert.equal(companion.rankingRefreshedForDailyTick({ dailyRefreshDay: "2026-08-23" }, due), false);
    assert.match(source, /Same-type rankings already refreshed for this Torn daily tick\./);
    assert.match(source, /dailyRefreshDay: rankingRefreshDay\(now\)/);
});

test("daily tick alert reports full daily income, profit, customer, star, and stock-difference details", () => {
    const tick = Date.UTC(2026, 7, 24, 18, 0, 0);
    const alert = companion.buildDailyTickAlert({
        fetchedAt: tick + 1000,
        profile: {
            income: { daily: 1000, weekly: 7000 },
            customers: { daily: 88 },
            rating: 7,
            advertisement_budget: 100,
            employees: { hired: 1 }
        },
        employees: [{ wage: 100 }],
        stock: [],
        stockAvailable: true
    }, tick + 1000);

    assert.match(alert.text, /Daily Income: \$1,000/);
    assert.match(alert.text, /Daily Profit: \$800/);
    assert.match(alert.text, /Daily Customer Count: 88/);
    assert.match(alert.text, /Star Level: 7★/);
    assert.match(alert.text, /Stock Difference vs prior day: unavailable/);
    assert.equal(alert.source.fresh, true);
});

test("daily stock difference totals all current and prior stock items as an integer", () => {
    const data = {
        stockAvailable: true,
        stock: [{ id: 1, in_stock: 120 }, { id: 3, in_stock: 5 }]
    };
    const prior = {
        1: { inStock: 95 },
        2: { inStock: 8 }
    };

    assert.equal(companion.totalStockDifference(data, prior), 22);
    assert.equal(companion.totalStockDifference({ stockAvailable: false, stock: [] }, prior), null);
});

test("employee effectiveness alert lists every addiction or inactivity penalty below -12", () => {
    const tick = Date.UTC(2026, 7, 24, 18, 10, 0);
    const data = {
        fetchedAt: tick + 1000,
        employees: [
            { id: 1, name: "Addicted", effectiveness: { addiction: -13, inactivity: -12 } },
            { id: 2, name: "Inactive", effectiveness: { addiction: -8, inactivity: -14 } },
            { id: 3, name: "Okay", effectiveness: { addiction: -12, inactivity: -12 } }
        ]
    };
    const risks = companion.employeeEffectivenessRisks(data.employees);
    const alert = companion.buildEmployeeRiskAlert(data, tick + 1000);

    assert.deepEqual(risks.map((risk) => [risk.name, risk.issues.map((issue) => issue.label)]), [["Addicted", ["Addiction"]], ["Inactive", ["Inactivity"]]]);
    assert.match(alert.text, /Addicted \(Addiction -13\)/);
    assert.match(alert.text, /Inactive \(Inactivity -14\)/);
    assert.equal(alert.source.fresh, true);
});

test("native background reminders use the next tick phase and generic text only", () => {
    const beforeTick = Date.UTC(2026, 7, 24, 17, 0, 0);
    const incomeTick = Date.UTC(2026, 7, 24, 18, 0, 0);
    const employeeTick = Date.UTC(2026, 7, 24, 18, 10, 0);
    const tomorrowIncomeTick = Date.UTC(2026, 7, 25, 18, 0, 0);
    const income = companion.buildDailyTickReminder("income", beforeTick);
    const employee = companion.buildDailyTickReminder("employeeRisk", beforeTick);

    assert.equal(income.timestamp, incomeTick);
    assert.equal(employee.timestamp, employeeTick);
    assert.equal(income.id, 6813);
    assert.equal(employee.id, 6814);
    assert.match(income.subtitle, /Open Naughty Company Companion to refresh live Daily Income/);
    assert.doesNotMatch(income.subtitle, /Daily Income: \$/);
    assert.equal(companion.dailyAlertKindAt(incomeTick), "income");
    assert.equal(companion.dailyAlertKindAt(employeeTick), "employeeRisk");
    assert.equal(companion.dailyAlertKindAt(beforeTick), null);
    assert.equal(companion.nextDailyReminderTimestamp({ minute: 0 }, incomeTick), tomorrowIncomeTick);
});

test("console diagnostic descriptors never expose API query, header, or TornStats path secrets", () => {
    assert.deepEqual(
        companion.safeRequestDescriptor("https://api.torn.com/v2/company/profile?api_key=query-secret", "get"),
        { method: "GET", host: "api.torn.com", path: "/v2/company/profile" }
    );
    assert.deepEqual(
        companion.safeRequestDescriptor("https://www.tornstats.com/api/v2/tornstats-secret/efficiency?man=10", "GET"),
        { method: "GET", host: "www.tornstats.com", path: "/api/v2/[redacted]/efficiency" }
    );
    const message = companion.safeDiagnosticError(new Error("Failed https://www.tornstats.com/api/v2/tornstats-secret/efficiency?token=query-secret Authorization: ApiKey header-secret token=other-secret"));
    const barePathMessage = companion.safeDiagnosticError(new Error("Native request failed at /api/v2/tornstats-secret/efficiency"));

    assert.match(message, /www\.tornstats\.com\/api\/v2\/\[redacted\]\/efficiency/);
    assert.doesNotMatch(message, /tornstats-secret|query-secret|header-secret|other-secret/);
    assert.doesNotMatch(barePathMessage, /tornstats-secret/);
});

test("storage adapter prefers PDA storage, migrates legacy-only values once, and batches writes", async () => {
    const nativeData = { settings: { source: "native" } };
    const legacyData = { settings: { source: "legacy" }, history: { one: true } };
    const nativeWrites = [];
    const scheduled = [];
    const adapter = companion.createStorageAdapter({
        keys: ["settings", "history", "cache"],
        getNative: () => ({
            loadAll: async () => nativeData,
            setMany: async (values) => { nativeWrites.push(values); Object.assign(nativeData, values); },
            delete: async () => {}
        }),
        legacy: {
            loadAll: async () => legacyData,
            setMany: async () => {},
            delete: async () => {}
        },
        setTimer: (callback) => { scheduled.push(callback); return callback; },
        clearTimer: () => {}
    });

    const first = await adapter.load();
    const second = await adapter.load();
    assert.equal(first.mode, "pda");
    assert.deepEqual(first.values, { settings: { source: "native" }, history: { one: true } });
    assert.deepEqual(first.migrated, { history: { one: true } });
    assert.deepEqual(second.migrated, {});
    assert.deepEqual(nativeWrites, [{ history: { one: true } }]);

    const one = adapter.setMany({ settings: { source: "updated" } });
    const two = adapter.setMany({ cache: { at: 1 } });
    scheduled.at(-1)();
    await Promise.all([one, two]);
    assert.deepEqual(nativeWrites.at(-1), { settings: { source: "updated" }, cache: { at: 1 } });
});

test("storage adapter falls back after a native quota failure and deletes through native plus legacy storage", async () => {
    const nativeDeletes = [];
    const legacyWrites = [];
    const legacyDeletes = [];
    const quota = Object.assign(new Error("quota"), { code: "QuotaExceeded" });
    const adapter = companion.createStorageAdapter({
        keys: ["cache"],
        getNative: () => ({
            loadAll: async () => ({}),
            setMany: async () => { throw quota; },
            delete: async (key) => { nativeDeletes.push(key); }
        }),
        legacy: {
            loadAll: async () => ({}),
            setMany: async (values) => { legacyWrites.push(values); },
            delete: async (key) => { legacyDeletes.push(key); }
        }
    });

    await adapter.setMany({ cache: { retained: true } }, { immediate: true });
    const deleted = await adapter.delete("cache");
    assert.deepEqual(legacyWrites, [{ cache: { retained: true } }]);
    assert.deepEqual(nativeDeletes, ["cache"]);
    assert.deepEqual(legacyDeletes, ["cache"]);
    assert.equal(deleted.nativeDeleted, true);
    assert.equal(deleted.fallbackDeleted, true);
});

test("storage adapter removes queued writes before delete so stale data cannot be persisted", async () => {
    const writes = [];
    const adapter = companion.createStorageAdapter({
        keys: ["cache"],
        writeMany: async (values) => { writes.push(values); },
        legacy: { delete: async () => {} },
        setTimer: () => 1,
        clearTimer: () => {}
    });

    const queued = adapter.setMany({ cache: { stale: true } });
    await adapter.delete("cache");
    await queued;
    assert.deepEqual(writes, []);
});

test("rankings flow through the main panel while all Company scroll regions stay trackless", () => {
    assert.match(source, /#\$\{ROOT_ID\}, #\$\{ROOT_ID\} \* \{ box-sizing: border-box; -ms-overflow-style:none; scrollbar-width:none; \}/);
    assert.match(source, /#\$\{ROOT_ID\}::-webkit-scrollbar, #\$\{ROOT_ID\} \*::-webkit-scrollbar \{ width:0; height:0; display:none; \}/);
    assert.match(source, /\.ncc-table-wrap \{ overflow-x:auto; overflow-y:hidden;/);
    assert.match(source, /\.ncc-tabs \{ display:flex; gap:5px; overflow-x:auto; overflow-y:hidden;/);
    assert.match(source, /\.ncc-summary-strip \{ display:grid; grid-template-columns:repeat\(6,minmax\(120px,1fr\)\); overflow-x:auto; overflow-y:hidden;/);
    assert.doesNotMatch(source, /\.ncc-table-wrap\s*\{[^}]*max-height:/);
    assert.doesNotMatch(source, /\.ncc-table-wrap\s*\{[^}]*overflow:auto/);
});

test("compact responsive layout uses actual panel width and keeps bounds inside the visible viewport", () => {
    assert.equal(companion.isCompactLayout({ containerWidth: 760, viewportWidth: 1440 }), true);
    assert.equal(companion.isCompactLayout({ containerWidth: 940, viewportWidth: 1440 }), false);
    assert.equal(companion.isCompactLayout({ containerWidth: 940, viewportWidth: 1440, forceCompact: true }), true);

    const bounds = companion.boundedPanelLayout({ x: 900, y: 700, width: 940, height: 860 }, { width: 800, height: 600 });
    assert.equal(bounds.width, 772);
    assert.equal(bounds.height, 572);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 800);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600);
});

test("compact Company tables stack into labeled cards and tabs wrap without horizontal scrolling", () => {
    assert.match(source, /data-compact-layout="true"\] \.ncc-tabs \{ display:grid; grid-template-columns:repeat\(4,minmax\(0,1fr\)\); overflow:visible;/);
    assert.match(source, /data-compact-layout="true"\] \.ncc-stack-wrap \{ overflow:visible;/);
    assert.match(source, /data-compact-layout="true"\] \.ncc-stack-table tbody tr \{ display:block;/);
    assert.match(source, /data-compact-layout="true"\] \.ncc-stack-table td::before .*content:attr\(data-label\)/);
    assert.match(source, /ncc-stack-table/);
    assert.match(source, /stackCell\("Current stock worth"/);
    assert.match(source, /stackCell\("Reporting day"/);
});

test("Company keeps Stock trend in Stock, retains compact rank lists, and exposes safe storage diagnostics", () => {
    assert.match(source, /section\("Stock trend", stockChart\)/);
    assert.match(source, /const trendTypes = \["income-profit", "effectiveness", "ranking"\]/);
    assert.match(source, /data-action="open-position-config"/);
    assert.match(source, /Position capacity & priority/);
    assert.match(source, /ncc-rank-list/);
    assert.match(source, /Use legacy GM storage/);
    assert.match(source, /PDA_INJECTED_TORN_KEY/);
    assert.match(source, /documentIsHidden\(\)/);
    assert.match(source, /data-compact-layout="true"\] \.ncc-trend-detail \{ grid-template-columns:minmax\(0,1fr\);/);
    assert.match(source, /DAILY_RANKINGS_REFRESH_MINUTE = 5/);
    assert.match(source, /resetDailyRankingRefresh\(\)/);
});

test("Company backups validate their namespace and preserve API keys unless restore is explicitly enabled", () => {
    const backup = companion.createCompanyBackupDocument({
        "ncc:settings:v1": { tornKey: "torn-secret", tornStatsKey: "stats-secret", projectionConsent: true },
        "ncc:history:v1": { company: [{ period: 1 }] },
        "ncc:cache:v1": { profile: { id: 1 } }
    }, { includeApiKeys: false, timestamp: Date.UTC(2026, 7, 24), appVersion: "1.2.0" });

    assert.equal(backup.includesApiKeys, false);
    assert.equal(Object.hasOwn(backup.stores["ncc:settings:v1"], "tornKey"), false);
    assert.equal(Object.hasOwn(backup.stores["ncc:settings:v1"], "tornStatsKey"), false);
    assert.doesNotThrow(() => companion.validateCompanyBackupDocument(backup));

    const preserved = companion.materializeCompanyBackupStores(backup, {
        currentSettings: { tornKey: "keep-torn", tornStatsKey: "keep-stats" }
    });
    assert.equal(preserved["ncc:settings:v1"].tornKey, "keep-torn");
    assert.equal(preserved["ncc:settings:v1"].tornStatsKey, "keep-stats");

    const keyBackup = companion.createCompanyBackupDocument({
        "ncc:settings:v1": { tornKey: "replace-torn", tornStatsKey: "replace-stats" }
    }, { includeApiKeys: true, timestamp: Date.UTC(2026, 7, 24), appVersion: "1.2.0" });
    const restored = companion.materializeCompanyBackupStores(keyBackup, {
        currentSettings: { tornKey: "keep-torn", tornStatsKey: "keep-stats" },
        restoreApiKeys: true
    });
    assert.equal(restored["ncc:settings:v1"].tornKey, "replace-torn");
    assert.equal(restored["ncc:settings:v1"].tornStatsKey, "replace-stats");
    assert.throws(() => companion.validateCompanyBackupDocument({ ...backup, namespace: "other-companion" }), /wrong script namespace/);
    assert.match(source, /data-action="download-company-backup"/);
    assert.match(source, /case "confirm-backup-restore"/);
});
