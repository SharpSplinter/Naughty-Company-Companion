const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const companion = require("./Naughty Company Companion.user.js");
const source = fs.readFileSync(path.join(__dirname, "Naughty Company Companion.user.js"), "utf8");
const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
assert.match(source, /https:\/\/github\.com\/SharpSplinter\/Naughty-Company-Companion/);
assert.match(source, /https:\/\/raw\.githubusercontent\.com\/SharpSplinter\/Naughty-Company-Companion\/main/);
assert.match(source, /@license\s+MIT/);
assert.doesNotMatch(source + readme, /xf4k31tx/);

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
    assert.match(source, /reportedTotal !== null && reportedTotal > MAX_SAME_TYPE_COMPANIES/);
    assert.match(source, /if \(unique\.length < total\) throw new Error\("Torn returned an incomplete same-type rankings result/);
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

test("applications report their actual Pending, Accepted, and Withdrawn status counts", () => {
    assert.deepEqual(companion.applicationStatusSummary([
        { status: "accepted" },
        { status: "Accepted" },
        { status: "withdrawn" },
        { status: "withdrawn" },
        { status: "withdrawn" }
    ]), { pending: 0, accepted: 2, withdrawn: 3, other: 0, total: 5 });
    assert.deepEqual(companion.applicationStatusSummary([{ status: "pending" }, { status: "expired" }]), {
        pending: 1, accepted: 0, withdrawn: 0, other: 1, total: 2
    });
    assert.match(source, /applicationsAvailable: applicationsResult\.status === "fulfilled"/);
    assert.match(source, /\$\{formatNumber\(applicationSummary\.pending\)\} Pending/);
    assert.match(source, /\$\{formatNumber\(applicationSummary\.accepted\)\} Accepted/);
    assert.match(source, /\$\{formatNumber\(applicationSummary\.withdrawn\)\} Withdrawn/);
});

test("local Oil Rig calculator matches the verified Torn total-efficiency vectors", () => {
    const secretary = { intelligence: 56250, endurance: 112500 };
    const rnelody = {
        stats: { manual_labor: 58875, intelligence: 469504, endurance: 291939 },
        effectiveness: { working_stats: 114, total: 143 }
    };
    const mandy = {
        stats: { manual_labor: 45014, intelligence: 416284, endurance: 268105 },
        effectiveness: { working_stats: 112, total: 135 }
    };

    assert.equal(companion.roleStatEfficiency(469504, 56250), 61);
    assert.equal(companion.roleStatEfficiency(291939, 112500), 53);
    assert.equal(companion.calculateLocalRoleEfficiencies("Oil Rig", rnelody.stats).Secretary, 114);
    assert.equal(companion.calculateLocalRoleEfficiencies("Oil Rig", mandy.stats).Secretary, 112);
    assert.equal(companion.preferredCurrentEfficiency(rnelody.effectiveness.total, 114, 29), 143);
    assert.equal(companion.preferredCurrentEfficiency(mandy.effectiveness.total, 112, 23), 135);
    assert.doesNotMatch(source, /tornstats\.com|TORNSTATS_API|@connect\s+www\.tornstats\.com/i);
    assert.doesNotMatch(source, /function (?:tornStatsEfficiency|loadProjections)\b|state\.projections/);
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

test("company accounts remain isolated and the selector always offers Add company", () => {
    const accounts = companion.companyAccountMap({
        companyAccounts: {
            101: { id: 101, name: "Alpha", typeId: 4, typeName: "Oil Rig", key: "one" },
            202: { id: 202, name: "Bravo", typeId: 4, typeName: "Oil Rig", key: "two" }
        }
    });
    const options = companion.selectableCompanyOptions(accounts, "202");

    assert.deepEqual(Object.keys(accounts), ["101", "202"]);
    assert.equal(accounts["101"].name, "Alpha");
    assert.equal(accounts["202"].name, "Bravo");
    assert.deepEqual(options.filter((option) => option.value !== "__add__").map((option) => String(option.value)), ["101", "202"]);
    assert.deepEqual(options.find((option) => option.value === "__add__"), { value: "__add__", label: "Add company…", account: null });
    assert.equal(options.find((option) => option.value === "202").label, "Bravo (current)");
    assert.match(source, /async function validateDirectorKey\(/);
    assert.match(source, /\/company\/profile/);
    assert.match(source, /\/company\/employees/);
    assert.match(source, /async function addCompanyAccount\(/);
    assert.doesNotMatch(source, /value="\$\{escapeHtml\(settings\.(?:tornKey|tornStatsKey)\)\}"/);
});

test("all configured companies sync once at 18:05 and reuse a same-type ranking pull", () => {
    const tick = Date.UTC(2026, 7, 24, 18, 5, 0);
    const accounts = companion.companyAccountMap({
        companyAccounts: {
            101: { id: 101, name: "Alpha", typeId: 4, typeName: "Oil Rig", key: "one" },
            202: { id: 202, name: "Bravo", typeId: 4, typeName: "Oil Rig", key: "two" },
            303: { id: 303, name: "Charlie", typeId: 7, typeName: "Farm", key: "three" }
        }
    });
    const plan = companion.dailySyncPlan(accounts, {
        101: { day: "2026-08-23" },
        202: { day: "2026-08-24", completedAt: tick },
        303: {}
    }, tick);

    assert.deepEqual(plan.pending.map((account) => account.id), ["101", "303"]);
    assert.deepEqual(plan.rankingGroups.map((group) => ({ typeId: group.typeId, companyIds: group.companyIds })), [
        { typeId: "4", companyIds: ["101"] },
        { typeId: "7", companyIds: ["303"] }
    ]);

    const sharedType = companion.dailySyncPlan(accounts, {}, tick);
    assert.deepEqual(sharedType.rankingGroups.find((group) => group.typeId === "4").companyIds, ["101", "202"]);
});

test("alert delivery modes select no, all-combined, all-separate, or only active company data", () => {
    const accounts = [
        { id: 101, name: "Alpha" },
        { id: 202, name: "Bravo" }
    ];

    assert.deepEqual(companion.alertTargetsForMode("off", accounts, 202), []);
    assert.deepEqual(companion.alertTargetsForMode("combined", accounts, 202), [[101, 202]]);
    assert.deepEqual(companion.alertTargetsForMode("separate", accounts, 202), [[101], [202]]);
    assert.deepEqual(companion.alertTargetsForMode("selected", accounts, 202), [[202]]);
});

test("reporting day rolls over at 18:05 UTC", () => {
    const before = Date.UTC(2026, 7, 18, 18, 4, 59);
    const after = Date.UTC(2026, 7, 18, 18, 5, 0);

    assert.equal(companion.reportingPeriod(before), Date.UTC(2026, 7, 17, 18, 5, 0));
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

test("current effectiveness falls back to Torn total when no local role requirements exist", () => {
    assert.equal(companion.preferredCurrentEfficiency(130, 102, 26), 128);
    assert.equal(companion.preferredCurrentEfficiency(130, undefined, 26), 130);
});

test("average employee effectiveness keeps one decimal place", () => {
    assert.equal(companion.formatAverageEffectiveness(128.46), "128.5");
    assert.equal(companion.formatAverageEffectiveness(128), "128.0");
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
    assert.match(companion.trendPointTooltip({ ...history[0], averageEmployeeEfficiency: 100.46 }, "effectiveness"), /Avg employee effectiveness: 100.5/);
    assert.match(companion.trendPointTooltip(history[0], "ranking"), /Company rank: #3/);
    assert.equal(companion.trendNumber(null), null);
});

test("per-tab source freshness reports not updated, fresh, partial, and stale states", () => {
    const now = Date.UTC(2026, 7, 24, 18, 20, 0);

    assert.deepEqual(companion.sourceFreshness({}, now), { state: "Not updated", updatedAt: null, source: "—" });
    assert.deepEqual(companion.sourceFreshness({ employees: now - 5 * 60 * 1000, stock: now - 10 * 60 * 1000 }, now), {
        state: "Fresh",
        updatedAt: now - 5 * 60 * 1000,
        source: "employees, stock"
    });
    assert.equal(companion.sourceFreshness({ employees: now - 5 * 60 * 1000, rankings: now - 90 * 60 * 1000 }, now).state, "Partial");
    assert.equal(companion.sourceFreshness({ employees: now - 61 * 60 * 1000, rankings: now - 90 * 60 * 1000 }, now).state, "Stale");
    assert.deepEqual(companion.tabFreshnessSummary("overview", { profile: now - 5 * 60 * 1000 }, now), {
        state: "Partial",
        updatedAt: now - 5 * 60 * 1000,
        source: "profile; unavailable: employees"
    });
});

test("runtime kind is independent from measured responsive layout profile", () => {
    assert.equal(companion.runtimeMode({ userAgent: "TornPDA", width: 1200, height: 800 }), "tornpda");
    assert.equal(companion.runtimeMode({ isTornPDA: true, width: 1600, height: 1000 }), "tornpda");
    assert.equal(companion.runtimeMode({ width: 1200, height: 800, scale: 1 }), "desktop");
    assert.equal(companion.layoutProfile({ containerWidth: 360, viewportWidth: 390, viewportHeight: 844, scale: 1 }), "narrow");
    assert.equal(companion.layoutProfile({ containerWidth: 620, viewportWidth: 844, viewportHeight: 700, scale: 1 }), "compact");
    assert.equal(companion.layoutProfile({ containerWidth: 940, viewportWidth: 1440, viewportHeight: 900, scale: 1 }), "standard");
    assert.equal(companion.layoutProfile({ containerWidth: 1280, viewportWidth: 1920, viewportHeight: 1080, scale: 1 }), "wide");
    assert.equal(companion.layoutProfile({ containerWidth: 940, viewportWidth: 1440, viewportHeight: 900, scale: 1.3 }), "compact");
    assert.equal(companion.shouldUseCompactLayout({ profile: "standard", kind: "tornpda", viewportWidth: 834 }), true);
    assert.equal(companion.shouldUseCompactLayout({ profile: "standard", kind: "tornpda", viewportWidth: 1180 }), false);
    assert.equal(companion.shouldUseCompactLayout({ profile: "narrow", kind: "desktop", viewportWidth: 1180 }), true);
});

test("virtual keyboard guard preserves focused mobile panels without swallowing orientation changes", () => {
    const baseline = { width: 390, height: 844 };
    assert.equal(companion.isVirtualKeyboardViewportChange({
        focused: true,
        baseline,
        current: { width: 390, height: 420 },
        layoutHeight: 844
    }), true);
    assert.equal(companion.isVirtualKeyboardViewportChange({
        focused: true,
        baseline,
        current: { width: 844, height: 390 },
        layoutHeight: 390
    }), false);
    assert.equal(companion.isVirtualKeyboardViewportChange({
        focused: false,
        baseline,
        current: { width: 390, height: 420 },
        layoutHeight: 844
    }), false);
    assert.equal(companion.isVirtualKeyboardViewportChange({
        focused: true,
        baseline,
        current: { width: 390, height: 790 },
        layoutHeight: 844
    }), false);
    assert.match(source, /bindVirtualKeyboardViewportGuard\(\)/);
    assert.match(source, /navigator\.virtualKeyboard/);
    assert.match(source, /keyboard\.overlaysContent = true/);
    assert.match(source, /data-virtual-keyboard-open="true"/);
    assert.match(source, /max-height:none !important/);
});

test("daily Company work shares the 18:05 UTC reporting boundary", () => {
    const beforeTick = Date.UTC(2026, 7, 24, 18, 4, 59);
    const tick = Date.UTC(2026, 7, 24, 18, 5, 0);
    const nextTick = Date.UTC(2026, 7, 25, 18, 5, 0);

    assert.equal(companion.isDailyAlertDue(beforeTick, 5), false);
    assert.equal(companion.isDailyAlertDue(tick, 5), true);
    assert.equal(companion.dailyAlertPhaseTime(tick, 5), tick);
    assert.equal(companion.nextDailyAlertTimestamp(tick), nextTick);
    assert.equal(companion.dailySyncDay(beforeTick), "2026-08-23");
    assert.equal(companion.dailySyncDay(tick), "2026-08-24");
    assert.equal(companion.dailySyncNeedsRun({ day: "2026-08-23" }, tick), true);
    assert.equal(companion.dailySyncNeedsRun({ day: "2026-08-24", completedAt: tick }, nextTick - 1), false);
    assert.doesNotMatch(source, /18:00 UTC|18:10 UTC/);
    assert.match(source, /await runDailySync\(\{ scheduled: true, deliverAlerts: true \}\);[\s\S]*?finally \{[\s\S]*?scheduleDailyCompanySync\(\);/);
});

test("daily alerts require an explicit scope and independently opt-in delivery channels", () => {
    assert.deepEqual(companion.dailyAlertDeliveryChannels(), { toast: false, notification: false });
    assert.equal(companion.dailyTickAlertsEnabled(), false);
    assert.deepEqual(companion.dailyAlertDeliveryChannels({ dailyAlertMode: "combined", dailyTickToasts: true }), { toast: true, notification: false });
    assert.deepEqual(companion.dailyAlertDeliveryChannels({ dailyAlertMode: "separate", dailyTickNotifications: true }), { toast: false, notification: true });
    assert.equal(companion.dailyTickAlertsEnabled({ dailyAlertMode: "combined", dailyTickToasts: true }), true);
    assert.equal(companion.dailyTickAlertsEnabled({ dailyAlertMode: "off", dailyTickToasts: true }), false);

    const backup = companion.createCompanyBackupDocument({
        "ncc:settings:v1": { dailyAlertMode: "selected", dailyTickToasts: true, dailyTickNotifications: true }
    }, { includeApiKeys: false, timestamp: Date.UTC(2026, 7, 24), appVersion: "1.2.6" });
    const restored = companion.materializeCompanyBackupStores(backup, { currentSettings: {} });
    assert.equal(restored["ncc:settings:v1"].dailyAlertMode, "selected");
    assert.equal(restored["ncc:settings:v1"].dailyTickToasts, true);
    assert.equal(restored["ncc:settings:v1"].dailyTickNotifications, true);

    assert.match(source, /id="ncc-daily-alert-mode"/);
    assert.match(source, /Combined all-company alert/);
    assert.match(source, /Separate alert for every company/);
    assert.match(source, /Selected company only/);
    assert.match(source, /id="ncc-daily-tick-toasts"/);
    assert.match(source, /id="ncc-daily-tick-notifications"/);
    assert.match(source, /if \(!dailyAlertDeliveryChannels\(\)\.toast\) return false;/);
    assert.match(source, /if \(!dailyAlertDeliveryChannels\(\)\.notification\) return false;/);
    assert.match(source, /if \(!dailyTickAlertsEnabled\(\)\) return false;/);
    assert.match(source, /if \(!dailyTickAlertsEnabled\(\)\) return;/);
});

test("daily alert toasts keep full messages stacked instead of replacing one another", () => {
    const dailyToast = source.match(/async function showDailyToast[\s\S]*?\n    }\n\n    function companyPageUrl/);
    assert.ok(dailyToast);
    assert.match(dailyToast[0], /showDesktopToast\(text, tone, 10\)/);
    assert.match(dailyToast[0], /callConfirmedPdaHandler\("showToast"/);
    assert.doesNotMatch(source, /toastChain|toastVisibleUntil/);
});

test("daily tick alert reports full daily income, profit, customer, star, and stock-difference details", () => {
    const tick = Date.UTC(2026, 7, 24, 18, 5, 0);
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
    const tick = Date.UTC(2026, 7, 24, 18, 5, 0);
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

test("native background reminders use the unified 18:05 daily phase and generic text only", () => {
    const beforeTick = Date.UTC(2026, 7, 24, 17, 0, 0);
    const tick = Date.UTC(2026, 7, 24, 18, 5, 0);
    const tomorrowTick = Date.UTC(2026, 7, 25, 18, 5, 0);
    const income = companion.buildDailyTickReminder("income", beforeTick);
    const employee = companion.buildDailyTickReminder("employeeRisk", beforeTick);

    assert.equal(income.timestamp, tick);
    assert.equal(employee.timestamp, tick);
    assert.equal(income.id, 6813);
    assert.equal(employee.id, 6814);
    assert.match(income.subtitle, /Open Naughty Company Companion to refresh live Daily Income/);
    assert.doesNotMatch(income.subtitle, /Daily Income: \$/);
    assert.equal(companion.dailyAlertKindAt(tick), "income");
    assert.deepEqual(companion.dailyAlertKindsAt(tick), ["income", "employeeRisk"]);
    assert.equal(companion.dailyAlertKindAt(beforeTick), null);
    assert.equal(companion.nextDailyReminderTimestamp({ minute: 5 }, tick), tomorrowTick);
});

test("console diagnostic descriptors never expose API query or header secrets", () => {
    assert.deepEqual(
        companion.safeRequestDescriptor("https://api.torn.com/v2/company/profile?api_key=query-secret", "get"),
        { method: "GET", host: "api.torn.com", path: "/v2/company/profile" }
    );
    const message = companion.safeDiagnosticError(new Error("Failed https://api.torn.com/v2/company/profile?api_key=query-secret Authorization: ApiKey header-secret token=other-secret"));
    assert.match(message, /api\.torn\.com\/v2\/company\/profile/);
    assert.doesNotMatch(message, /query-secret|header-secret|other-secret/);
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

test("Company uses one touch-scrollable vertical pane and never falls back to horizontal scrolling", () => {
    assert.match(source, /#\$\{ROOT_ID\}, #\$\{ROOT_ID\} \* \{ box-sizing: border-box; -ms-overflow-style:none; scrollbar-width:none; \}/);
    assert.match(source, /#\$\{ROOT_ID\}::-webkit-scrollbar, #\$\{ROOT_ID\} \*::-webkit-scrollbar \{ width:0; height:0; display:none; \}/);
    assert.doesNotMatch(source, /\.ncc-table-wrap \{ overflow-x:auto/);
    assert.doesNotMatch(source, /\.ncc-tabs \{[^}]*overflow-x:auto/);
    assert.doesNotMatch(source, /\.ncc-summary-strip \{[^}]*overflow-x:auto/);
    assert.doesNotMatch(source, /\.ncc-table-wrap\s*\{[^}]*max-height:/);
    assert.doesNotMatch(source, /\.ncc-table-wrap\s*\{[^}]*overflow:auto/);
    assert.match(source, /#ncc-content \{[\s\S]*overflow-y:auto;[\s\S]*touch-action:pan-y pinch-zoom;[\s\S]*-webkit-overflow-scrolling:touch;/, "the main Company panel must support touch-driven vertical scrolling");
    assert.match(source, /ResizeObserver/);
    assert.match(source, /visualViewport/);
    assert.match(source, /data-layout-profile/);
    assert.match(source, /\[data-runtime="tornpda"\] #ncc-content \{[\s\S]*overflow-y:auto !important;[\s\S]*touch-action:pan-y pinch-zoom;/, "TornPDA must keep Company content vertically scrollable");
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

test("minimized launcher restores from any tap and persists its independently dragged position", () => {
    const bounds = companion.boundedLauncherLayout({ launcherX: 900, launcherY: 700 }, { width: 300, height: 200, margin: 10, size: 52 });
    assert.deepEqual(bounds, { x: 238, y: 138, margin: 10, size: 52 });
    assert.match(source, /DEFAULT_LAYOUT = \{ x: null, y: 14, width: 940, height: 860, minimized: false, launcherX: null, launcherY: null \}/);
    assert.match(source, /function bindLauncherInteractions\(\)/);
    assert.match(source, /await persistLauncherPosition\(\)/);
    assert.match(source, /launcher\.addEventListener\("click", \(event\) => \{[\s\S]*void toggleMinimized\(false\)/);
    assert.match(source, /state\.layout = \{ \.\.\.state\.layout, launcherX: launcherLayout\.x, launcherY: launcherLayout\.y \}/);
    assert.equal(companion.launcherTapActivates({ x: 40, y: 40 }, { x: 46, y: 45 }), true);
    assert.equal(companion.launcherTapActivates({ x: 40, y: 40 }, { x: 49, y: 40 }), false);
});

test("Company selector remains tappable while the rest of the header can still drag", () => {
    const selectTarget = { closest: (selector) => selector.includes("select") ? {} : null };
    const titleTarget = { closest: () => null };
    assert.equal(companion.canStartHeaderDrag(selectTarget, 0), false);
    assert.equal(companion.canStartHeaderDrag(titleTarget, 0), true);
    assert.equal(companion.canStartHeaderDrag(titleTarget, 2), false);
    assert.match(source, /#ncc-company-selector \{[^}]*touch-action:manipulation;/);
    assert.match(source, /if \(!canStartHeaderDrag\(event\.target, event\.button\)\) return;/);
});

test("compact Company tables stack into labeled cards and tabs wrap without horizontal scrolling", () => {
    assert.match(source, /data-compact-layout="true"\] \.ncc-tabs \{ display:grid; grid-template-columns:repeat\(4,minmax\(0,1fr\)\); overflow:visible;/);
    assert.match(source, /data-compact-layout="true"\] \.ncc-stack-wrap \{ overflow:visible;/);
    assert.match(source, /data-compact-layout="true"\] \.ncc-stack-table tbody tr \{ display:block;/);
    assert.match(source, /data-compact-layout="true"\] \.ncc-stack-table td::before .*content:attr\(data-label\)/);
    assert.match(source, /ncc-stack-table/);
    assert.match(source, /stackCell\("Current stock worth"/);
    assert.match(source, /stackCell\("Reporting day"/);
    assert.match(source, /min-width:0/);
    assert.match(source, /overflow-wrap:anywhere/);
    assert.match(source, /function shouldUseCompactLayout\([\s\S]*kind === "tornpda"[\s\S]*viewportWidth[^\n]*<= 960/);
    assert.match(source, /\.ncc-team-list \.ncc-team-name[\s\S]*overflow-wrap:anywhere;[\s\S]*text-overflow:clip;[\s\S]*white-space:normal;/);
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
    assert.match(source, /DAILY_SYNC_MINUTE_UTC = 5/);
    assert.match(source, /runDailySync\(/);
});

test("Company backup v2 isolates company keys and migrates legacy single-company state", () => {
    const backup = companion.createCompanyBackupDocument({
        "ncc:settings:v1": {
            activeCompanyId: "101",
            companyAccounts: {
                101: { id: 101, name: "Alpha", typeId: 4, key: "torn-secret-a" },
                202: { id: 202, name: "Bravo", typeId: 7, key: "torn-secret-b" }
            }
        },
        "ncc:history:v1": { company: [{ period: 1 }] },
        "ncc:cache:v1": { companies: { 101: { profile: { id: 101 } }, 202: { profile: { id: 202 } } } }
    }, { includeApiKeys: false, timestamp: Date.UTC(2026, 7, 24), appVersion: "1.3.0" });

    assert.equal(backup.schemaVersion, 2);
    assert.equal(backup.includesApiKeys, false);
    assert.equal(Object.hasOwn(backup.stores["ncc:settings:v1"], "tornKey"), false);
    assert.equal(Object.hasOwn(backup.stores["ncc:settings:v1"].companyAccounts[101], "key"), false);
    assert.equal(Object.hasOwn(backup.stores["ncc:settings:v1"].companyAccounts[202], "key"), false);
    assert.doesNotThrow(() => companion.validateCompanyBackupDocument(backup));

    const preserved = companion.materializeCompanyBackupStores(backup, {
        currentSettings: {
            companyAccounts: {
                101: { id: 101, key: "keep-a" },
                202: { id: 202, key: "keep-b" }
            }
        }
    });
    assert.equal(preserved["ncc:settings:v1"].companyAccounts[101].key, "keep-a");
    assert.equal(preserved["ncc:settings:v1"].companyAccounts[202].key, "keep-b");
    assert.equal(preserved["ncc:cache:v1"].companies[101].profile.id, 101);
    assert.equal(preserved["ncc:cache:v1"].companies[202].profile.id, 202);

    const keyBackup = companion.createCompanyBackupDocument({
        "ncc:settings:v1": {
            companyAccounts: {
                101: { id: 101, key: "replace-a" },
                202: { id: 202, key: "replace-b" }
            }
        }
    }, { includeApiKeys: true, timestamp: Date.UTC(2026, 7, 24), appVersion: "1.3.0" });
    const keylessRestore = companion.materializeCompanyBackupStores(keyBackup, {
        currentSettings: { companyAccounts: { 101: { id: 101, key: "keep-a" } } }
    });
    assert.equal(keylessRestore["ncc:settings:v1"].companyAccounts[101].key, "keep-a");
    assert.equal(Object.hasOwn(keylessRestore["ncc:settings:v1"].companyAccounts[202], "key"), false);
    const restored = companion.materializeCompanyBackupStores(keyBackup, {
        currentSettings: { companyAccounts: { 101: { id: 101, key: "keep-a" }, 202: { id: 202, key: "keep-b" } } },
        restoreApiKeys: true
    });
    assert.equal(restored["ncc:settings:v1"].companyAccounts[101].key, "replace-a");
    assert.equal(restored["ncc:settings:v1"].companyAccounts[202].key, "replace-b");

    const legacy = {
        format: "naughty-company-companion-backup",
        namespace: "naughty-company-companion",
        schemaVersion: 1,
        appVersion: "1.2.9",
        createdAt: "2026-08-24T18:05:00.000Z",
        includesApiKeys: true,
        stores: {
            "ncc:settings:v1": { tornKey: "legacy-key", tornStatsKey: "discard-me", projectionConsent: true },
            "ncc:cache:v1": { profile: { id: 303, name: "Legacy", company_type: { id: 4, name: "Oil Rig" } } },
            "ncc:history:v1": {},
            "ncc:rankings:v1": {},
            "ncc:projections:v1": {},
            "ncc:rank-history:v1": {},
            "ncc:star-cohorts:v1": {},
            "ncc:layout:v1": {},
            "ncc:daily-alerts:v1": {},
            "ncc:daily-reminders:v1": {}
        }
    };
    assert.doesNotThrow(() => companion.validateCompanyBackupDocument(legacy));
    const migrated = companion.materializeCompanyBackupStores(legacy, { currentSettings: {}, restoreApiKeys: true });
    assert.equal(migrated["ncc:settings:v1"].companyAccounts[303].key, "legacy-key");
    assert.equal(migrated["ncc:cache:v1"].companies[303].profile.name, "Legacy");
    assert.equal(Object.hasOwn(migrated["ncc:settings:v1"], "tornKey"), false);
    assert.equal(Object.hasOwn(migrated["ncc:settings:v1"], "tornStatsKey"), false);
    const unboundLegacy = companion.migrateLegacyCompanyStores({ "ncc:settings:v1": { tornKey: "cannot-be-bound" } });
    assert.equal(Object.hasOwn(unboundLegacy.settings, "tornKey"), false);
    assert.deepEqual(unboundLegacy.settings.companyAccounts, {});
    assert.doesNotMatch(source.match(/const activeTornApiKey[\s\S]*?;/)?.[0] || "", /state\.settings\.tornKey/);
    assert.throws(() => companion.validateCompanyBackupDocument({ ...backup, namespace: "other-companion" }), /wrong script namespace/);
    assert.match(source, /data-action="download-company-backup"/);
    assert.match(source, /case "confirm-backup-restore"/);
});

test("Company backup and CSV exports use the TornPDA share sheet with a local-download fallback", () => {
    assert.equal(companion.utf8Base64("Income,Profit\n1,2"), "SW5jb21lLFByb2ZpdAoxLDI=");
    assert.match(source, /async function shareTextWithTornPDA\(text, fileName\)/);
    assert.match(source, /bridge\.callHandler\("shareFile", \{ base64Data, fileName \}\)/);
    assert.match(source, /response\?\.status === "success"/);
    assert.match(source, /async function exportTextFile\(text, fileName, type\)/);
    assert.match(source, /exportInFlight: false/);
    assert.match(source, /const result = await exportTextFile\(JSON\.stringify\(backup, null, 2\), backupFileName\(\), "application\/json;charset=utf-8"\)/);
    assert.match(source, /Company backup opened in the TornPDA share sheet/);
    assert.match(source, /History CSV opened in the TornPDA share sheet/);
});
