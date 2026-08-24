const assert = require("node:assert/strict");
const test = require("node:test");
const companion = require("./Naughty Company Companion.user.js");

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
