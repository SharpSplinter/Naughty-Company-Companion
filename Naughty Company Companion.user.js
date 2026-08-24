// ==UserScript==
// @name         Naughty Company Companion
// @namespace    naughty-company-companion
// @version      1.1.8
// @description  Company income, profit, efficiency, stock, rankings, and staffing companion for Torn.
// @author       Naughty
// @match        https://www.torn.com/companies.php*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM_notification
// @grant        GM.notification
// @connect      api.torn.com
// @connect      www.tornstats.com
// ==/UserScript==

(() => {
    "use strict";

    const VERSION = "1.1.8";
    const ROOT_ID = "ncc-root";
    const TORN_API = "https://api.torn.com/v2";
    const TORNSTATS_API = "https://www.tornstats.com/api/v2";
    const DAY = 86400000;
    const RANKING_TTL = 15 * 60 * 1000;
    const PROJECTION_TTL = 24 * 60 * 60 * 1000;
    const DAILY_TICK_HOUR_UTC = 18;
    const DAILY_ALERTS = Object.freeze({
        income: {
            minute: 0,
            notificationId: 6811,
            reminderNotificationId: 6813,
            title: "Naughty Company — Daily Tick",
            reminderText: "Company daily tick is due. Open Naughty Company Companion to refresh live Daily Income, Daily Profit, and Daily Customer Count."
        },
        employeeRisk: {
            minute: 10,
            notificationId: 6812,
            reminderNotificationId: 6814,
            title: "Naughty Company — Employee Effectiveness",
            reminderText: "Employee effectiveness check is due. Open Naughty Company Companion to refresh and review Addiction and Inactivity penalties below -12."
        }
    });
    const EFFECTIVENESS_ALERT_THRESHOLD = -12;
    const COMPACT_LAYOUT_MAX_WIDTH = 820;
    const PANEL_MARGIN = 14;
    const DIAGNOSTIC_PREFIX = "[Naughty Company Companion]";
    const STORE = {
        settings: "ncc:settings:v1",
        cache: "ncc:cache:v1",
        history: "ncc:history:v1",
        rankings: "ncc:rankings:v1",
        projections: "ncc:projections:v1",
        rankHistory: "ncc:rank-history:v1",
        starCohorts: "ncc:star-cohorts:v1",
        layout: "ncc:layout:v1",
        dailyAlerts: "ncc:daily-alerts:v1",
        dailyReminders: "ncc:daily-reminders:v1"
    };
    const STORE_KEYS = Object.values(STORE);
    const LEGACY_FALLBACK_KEY = "ncc:pda-fallback-keys:v1";
    const DEFAULT_SETTINGS = {
        tornKey: "",
        tornStatsKey: "",
        projectionConsent: false,
        includeStockCost: true,
        autoRefreshMinutes: 10,
        activeTab: "overview",
        assignments: {},
        lockedEmployees: {},
        positionCapacities: {},
        positionPriority: {}
    };
    const DEFAULT_LAYOUT = { x: null, y: 14, width: 940, height: 860, minimized: false };
    const state = {
        settings: { ...DEFAULT_SETTINGS },
        layout: { ...DEFAULT_LAYOUT },
        data: null,
        cache: null,
        history: {},
        rankings: {},
        projections: {},
        rankHistory: {},
        starCohorts: {},
        dailyAlerts: {},
        dailyReminders: {},
        loading: false,
        rankingLoading: false,
        projectionLoading: false,
        status: "Configure a Torn API key to begin.",
        error: "",
        selectedTab: "overview",
        sort: { team: { key: "total", dir: "desc" }, planner: { key: "name", dir: "asc" }, rankings: { key: "rank", dir: "asc" }, stock: { key: "sold_worth", dir: "desc" } },
        teamFilter: "",
        rankingsFilter: "",
        selectedTrendPeriod: null,
        selectedTrendChart: "income-profit",
        runtimeMode: "desktop",
        storageWarning: "",
        modal: null,
        autoRefreshId: null
    };
    const dailyAlertRuntime = {
        timerId: null,
        liveTimerId: null,
        inFlight: new Set(),
        reminderRefreshPromise: null
    };
    const storage = {
        cache: {},
        pda: null,
        mode: "legacy",
        initialized: false,
        fallbackKeys: new Set(),
        lastDiagnostic: ""
    };
    let resolveFlutterReady;
    const flutterReadyPromise = new Promise((resolve) => { resolveFlutterReady = resolve; });
    const nativeRuntime = {
        flutterReady: false,
        isTornPDA: false,
        confirmationComplete: false,
        confirmationPromise: null
    };

    const asNumber = (value, fallback = 0) => {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    };
    const asFinite = (value) => {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    };
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
    })[char]);
    const formatNumber = (value, maximumFractionDigits = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(asNumber(value));
    const formatOptionalNumber = (value, maximumFractionDigits = 0) => {
        const number = asFinite(value);
        return number === null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(number);
    };
    const preferredCurrentEfficiency = (tornTotal, tornStatsBase, nonWorkingDelta) => {
        const base = asFinite(tornStatsBase);
        return base === null ? asFinite(tornTotal) : base + asNumber(nonWorkingDelta);
    };
    const formatMoney = (value, compact = false) => {
        const number = asFinite(value);
        if (number === null) return "—";
        if (compact) {
            const units = [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]];
            const unit = units.find(([threshold]) => Math.abs(number) >= threshold);
            if (unit) return `$${(number / unit[0]).toFixed(Math.abs(number / unit[0]) >= 100 ? 0 : 1)}${unit[1]}`;
        }
        return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(number);
    };
    const formatPercent = (value, digits = 0) => {
        const number = asFinite(value);
        return number === null ? "—" : `${number.toFixed(digits)}%`;
    };
    const formatDateTime = (timestamp) => {
        const numeric = asFinite(timestamp);
        if (numeric === null) return "—";
        const date = new Date(numeric);
        return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
    };
    const timeAgo = (timestamp) => {
        const seconds = Math.max(0, Math.floor((Date.now() - asNumber(timestamp)) / 1000));
        if (seconds < 60) return "just now";
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    };
    const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
    const sortRows = (rows, { key, dir }) => [...rows].sort((left, right) => {
        const a = typeof key === "function" ? key(left) : left[key];
        const b = typeof key === "function" ? key(right) : right[key];
        const an = asFinite(a);
        const bn = asFinite(b);
        if (an !== null && bn !== null) return dir === "asc" ? an - bn : bn - an;
        return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true }) * (dir === "asc" ? 1 : -1);
    });
    const deepMergeSettings = (raw) => ({
        ...DEFAULT_SETTINGS,
        ...(isObject(raw) ? raw : {}),
        assignments: isObject(raw?.assignments) ? raw.assignments : {},
        lockedEmployees: isObject(raw?.lockedEmployees) ? raw.lockedEmployees : {},
        positionCapacities: isObject(raw?.positionCapacities) ? raw.positionCapacities : {},
        positionPriority: isObject(raw?.positionPriority) ? raw.positionPriority : {}
    });

    function safeRequestDescriptor(url, method = "GET") {
        const normalizedMethod = String(method || "GET").toUpperCase();
        try {
            const parsed = new URL(String(url));
            let path = parsed.pathname || "/";
            if (/tornstats\.com$/i.test(parsed.hostname)) path = path.replace(/^\/api\/v2\/[^/]+/, "/api/v2/[redacted]");
            return { method: normalizedMethod, host: parsed.host, path };
        } catch {
            const path = String(url ?? "").split(/[?#]/)[0] || "/";
            return { method: normalizedMethod, host: "unknown", path: path.startsWith("/") ? path : "/" };
        }
    }

    function safeDiagnosticError(error) {
        const message = String(error?.message || error || "Unknown error");
        return message
            .replace(/https?:\/\/[^\s'"<>]+/gi, (url) => {
                const request = safeRequestDescriptor(url);
                return `${request.host}${request.path}`;
            })
            .replace(/(\/api\/v2\/)[^/\s,;]+/gi, "$1[redacted]")
            .replace(/\b(ApiKey|Bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
            .replace(/\b(api[_-]?key|key|token|authorization)\s*([:=])\s*[^\s,;]+/gi, "$1$2[redacted]")
            .slice(0, 280);
    }

    function diagnostic(level, event, details = {}) {
        try {
            const logger = typeof console === "undefined" ? null : (console[level] || console.log);
            logger?.call(console, `${DIAGNOSTIC_PREFIX} ${event}`, details);
        } catch {
            // Diagnostics must never interfere with the companion.
        }
    }

    const debugLog = (event, details) => diagnostic("log", event, details);
    const warningLog = (event, details) => diagnostic("warn", event, details);
    const errorLog = (event, details) => diagnostic("error", event, details);

    function storageDiagnostic(event, details = {}) {
        const signature = `${event}:${JSON.stringify(details)}`;
        if (storage.lastDiagnostic === signature) return;
        storage.lastDiagnostic = signature;
        warningLog(event, details);
    }

    function getPageStorage() {
        try {
            return typeof localStorage === "undefined" ? null : localStorage;
        } catch {
            return null;
        }
    }

    function getPdaStorage() {
        try {
            const api = typeof PDA_storage !== "undefined" ? PDA_storage : (typeof window !== "undefined" ? window.PDA_storage : null);
            return api && typeof api.loadAll === "function" && typeof api.setMany === "function" && typeof api.delete === "function" ? api : null;
        } catch {
            return null;
        }
    }

    async function legacyGet(key, fallback) {
        try {
            if (typeof GM_getValue === "function") return await GM_getValue(key, fallback);
            if (typeof GM !== "undefined" && typeof GM.getValue === "function") return await GM.getValue(key, fallback);
            const pageStorage = getPageStorage();
            const raw = pageStorage?.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    }

    async function legacySet(key, value) {
        if (typeof GM_setValue === "function") return GM_setValue(key, value);
        if (typeof GM !== "undefined" && typeof GM.setValue === "function") return GM.setValue(key, value);
        const pageStorage = getPageStorage();
        if (!pageStorage) throw new Error("Local userscript storage is unavailable.");
        pageStorage.setItem(key, JSON.stringify(value));
    }

    async function legacySetMany(values) {
        await Promise.all(Object.entries(values).map(([key, value]) => legacySet(key, value)));
    }

    async function legacyDelete(key) {
        try {
            if (typeof GM_deleteValue === "function") return await GM_deleteValue(key);
            if (typeof GM !== "undefined" && typeof GM.deleteValue === "function") return await GM.deleteValue(key);
            getPageStorage()?.removeItem(key);
        } catch {
            return undefined;
        }
    }

    async function loadLegacyValues() {
        const entries = await Promise.all(STORE_KEYS.map(async (key) => {
            const missing = `__ncc_legacy_missing__${key}`;
            const value = await legacyGet(key, missing);
            return [key, value === missing ? undefined : value];
        }));
        return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
    }

    async function persistFallbackKeys() {
        const keys = [...storage.fallbackKeys];
        if (keys.length) await legacySet(LEGACY_FALLBACK_KEY, keys);
        else await legacyDelete(LEGACY_FALLBACK_KEY);
    }

    function showStorageWarning(error) {
        const quotaExceeded = error?.code === "QuotaExceeded";
        state.storageWarning = quotaExceeded
            ? "TornPDA storage is full; newer companion data is safely using compatible userscript storage."
            : "TornPDA storage is unavailable; compatible userscript storage is active.";
        storageDiagnostic("storage:fallback", { mode: "GM/local", reason: quotaExceeded ? "quota exceeded" : "native storage unavailable" });
    }

    async function writeLegacyFallback(values, error) {
        try {
            await legacySetMany(values);
            Object.keys(values).forEach((key) => storage.fallbackKeys.add(key));
            await persistFallbackKeys();
            showStorageWarning(error);
        } catch {
            state.storageWarning = "Companion storage is full or unavailable; the latest local change could not be saved.";
            storageDiagnostic("storage:write failure", { mode: "GM/local", reason: "write unavailable" });
        }
    }

    async function storeSetMany(values) {
        const entries = Object.entries(values).filter(([key]) => STORE_KEYS.includes(key));
        if (!entries.length) return;
        const next = Object.fromEntries(entries);
        Object.assign(storage.cache, next);
        if (storage.mode === "pda" && storage.pda) {
            try {
                await storage.pda.setMany(next);
                Object.keys(next).forEach((key) => storage.fallbackKeys.delete(key));
                await persistFallbackKeys();
                if (!storage.fallbackKeys.size) state.storageWarning = "";
                return;
            } catch (error) {
                await writeLegacyFallback(next, error);
                return;
            }
        }
        try {
            await legacySetMany(next);
        } catch {
            state.storageWarning = "Companion storage is unavailable; the latest local change could not be saved.";
            storageDiagnostic("storage:write failure", { mode: "GM/local", reason: "write unavailable" });
        }
    }

    async function storeSet(key, value) {
        await storeSetMany({ [key]: value });
    }

    async function storeDelete(key) {
        delete storage.cache[key];
        if (storage.pda) {
            try {
                await storage.pda.delete(key);
            } catch (error) {
                showStorageWarning(error);
            }
        }
        await legacyDelete(key);
        storage.fallbackKeys.delete(key);
        await persistFallbackKeys();
    }

    async function loadStoredValues() {
        const pda = getPdaStorage();
        if (!pda) {
            const legacyValues = await loadLegacyValues();
            storage.cache = legacyValues;
            storage.mode = "legacy";
            storage.initialized = true;
            storageDiagnostic("storage:startup fallback", { mode: "GM/local", reason: "PDA_storage not exposed" });
            return storage.cache;
        }
        try {
            const loaded = await pda.loadAll();
            const pdaValues = isObject(loaded) ? loaded : {};
            const legacyValues = await loadLegacyValues();
            const savedFallbackKeys = await legacyGet(LEGACY_FALLBACK_KEY, []);
            storage.fallbackKeys = new Set(Array.isArray(savedFallbackKeys) ? savedFallbackKeys.filter((key) => STORE_KEYS.includes(key)) : []);
            storage.cache = { ...pdaValues };
            const migrations = {};
            STORE_KEYS.forEach((key) => {
                const legacyHasValue = hasOwn(legacyValues, key);
                const favorFallback = storage.fallbackKeys.has(key) && legacyHasValue;
                if (favorFallback || !hasOwn(pdaValues, key)) {
                    if (legacyHasValue) {
                        storage.cache[key] = legacyValues[key];
                        migrations[key] = legacyValues[key];
                    }
                }
            });
            storage.pda = pda;
            storage.mode = "pda";
            storage.initialized = true;
            if (Object.keys(migrations).length) {
                try {
                    await pda.setMany(migrations);
                    Object.keys(migrations).forEach((key) => storage.fallbackKeys.delete(key));
                    await persistFallbackKeys();
                } catch (error) {
                    showStorageWarning(error);
                }
            }
            debugLog("storage:PDA_storage ready", { cachedKeys: Object.keys(pdaValues).length, migratedKeys: Object.keys(migrations).length });
            return storage.cache;
        } catch (error) {
            const legacyValues = await loadLegacyValues();
            storage.cache = legacyValues;
            storage.pda = null;
            storage.mode = "legacy";
            storage.initialized = true;
            showStorageWarning(error);
            return storage.cache;
        }
    }

    function getFlutterBridge() {
        try {
            const bridge = typeof window === "undefined" ? null : window.flutter_inappwebview;
            return bridge && typeof bridge.callHandler === "function" ? bridge : null;
        } catch {
            return null;
        }
    }

    function tornPdaUserAgent(userAgent = "") {
        return /tornpda/i.test(userAgent);
    }

    function currentUserAgent() {
        try {
            return typeof navigator === "undefined" ? "" : navigator.userAgent || "";
        } catch {
            return "";
        }
    }

    function refreshRuntimePresentation() {
        if (typeof document === "undefined" || !document.getElementById(ROOT_ID)) return;
        setTimeout(() => render(), 0);
    }

    async function confirmTornPDA({ retry = false } = {}) {
        if (!nativeRuntime.flutterReady) return false;
        if (nativeRuntime.confirmationComplete && !retry) return nativeRuntime.isTornPDA;
        if (nativeRuntime.confirmationPromise) return nativeRuntime.confirmationPromise;
        const bridge = getFlutterBridge();
        if (!bridge) return false;
        nativeRuntime.confirmationPromise = Promise.resolve(bridge.callHandler("isTornPDA"))
            .then((response) => {
                const previous = nativeRuntime.isTornPDA;
                nativeRuntime.isTornPDA = response?.isTornPDA === true;
                nativeRuntime.confirmationComplete = true;
                debugLog("runtime:bridge confirmed", { isTornPDA: nativeRuntime.isTornPDA, userAgentHint: tornPdaUserAgent(currentUserAgent()) });
                if (previous !== nativeRuntime.isTornPDA || tornPdaUserAgent(currentUserAgent())) refreshRuntimePresentation();
                if (nativeRuntime.isTornPDA) void refreshDailyTickReminders({ force: true });
                return nativeRuntime.isTornPDA;
            })
            .catch((error) => {
                nativeRuntime.confirmationComplete = false;
                warningLog("runtime:bridge confirmation failed", { reason: safeDiagnosticError(error) });
                return false;
            })
            .finally(() => {
                nativeRuntime.confirmationPromise = null;
            });
        return nativeRuntime.confirmationPromise;
    }

    function markFlutterReady() {
        if (!nativeRuntime.flutterReady) {
            nativeRuntime.flutterReady = true;
            resolveFlutterReady?.(true);
            debugLog("runtime:flutter bridge ready", { bridgePresent: Boolean(getFlutterBridge()) });
        }
        void confirmTornPDA({ retry: true });
    }

    function initializeNativeRuntime() {
        if (typeof window === "undefined") return;
        debugLog("runtime:startup", { bridgePresent: Boolean(getFlutterBridge()), userAgentHint: tornPdaUserAgent(currentUserAgent()) });
        window.addEventListener("flutterInAppWebViewPlatformReady", markFlutterReady);
        // document-idle scripts may start after the readiness event; a live bridge is then ready to confirm.
        if (getFlutterBridge()) markFlutterReady();
    }

    async function waitForFlutterReady(timeout = 900) {
        if (nativeRuntime.flutterReady) return true;
        let timer;
        const result = await Promise.race([
            flutterReadyPromise,
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeout); })
        ]);
        if (timer) clearTimeout(timer);
        return result === true || nativeRuntime.flutterReady;
    }

    async function nativeHttpGet(url, headers, timeout) {
        if (!await waitForFlutterReady(Math.min(timeout, 1200))) throw new Error("TornPDA is not ready for native HTTP.");
        if (!await confirmTornPDA()) throw new Error("Native TornPDA HTTP is unavailable.");
        const bridge = getFlutterBridge();
        if (!bridge) throw new Error("Native TornPDA HTTP is unavailable.");
        let timer;
        try {
            return await Promise.race([
                Promise.resolve(bridge.callHandler("PDA_httpGet", url, headers)),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Request timed out.")), timeout); })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function callConfirmedPdaHandler(handler, ...args) {
        if (!nativeRuntime.isTornPDA && !await confirmTornPDA()) return null;
        const bridge = getFlutterBridge();
        if (!bridge) return null;
        try {
            return await bridge.callHandler(handler, ...args);
        } catch (error) {
            warningLog("runtime:native handler failed", { handler, reason: safeDiagnosticError(error) });
            return null;
        }
    }

    function pdaHandlerSucceeded(response) {
        return response !== null && response !== undefined && response?.status !== "error";
    }

    function fallbackToastContainer() {
        if (typeof document === "undefined" || !document.body) return null;
        let container = document.getElementById("ncc-alert-toasts");
        if (container) return container;
        container = document.createElement("div");
        container.id = "ncc-alert-toasts";
        document.body.append(container);
        return container;
    }

    function showDesktopToast(text, tone = "good", seconds = 10) {
        const container = fallbackToastContainer();
        if (!container) return false;
        const toast = document.createElement("div");
        toast.className = `ncc-alert-toast ${tone}`;
        toast.setAttribute("role", "status");
        toast.textContent = text;
        toast.onclick = () => toast.remove();
        container.append(toast);
        setTimeout(() => toast.remove(), Math.max(3, seconds) * 1000);
        return true;
    }

    async function showDailyToast(text, tone = "good") {
        const colors = tone === "bad"
            ? { bgColor: { a: 255, r: 125, g: 35, b: 47 }, textColor: { a: 255, r: 255, g: 245, b: 245 } }
            : tone === "warn"
                ? { bgColor: { a: 255, r: 112, g: 79, b: 20 }, textColor: { a: 255, r: 255, g: 246, b: 222 } }
                : { bgColor: { a: 255, r: 18, g: 94, b: 74 }, textColor: { a: 255, r: 238, g: 255, b: 248 } };
        const nativeResponse = await callConfirmedPdaHandler("showToast", {
            text,
            clickClose: true,
            seconds: 10,
            ...colors
        });
        if (pdaHandlerSucceeded(nativeResponse)) return true;
        return showDesktopToast(text, tone, 10);
    }

    function companyPageUrl() {
        try {
            return `${window.location.origin}/companies.php`;
        } catch {
            return "https://www.torn.com/companies.php";
        }
    }

    async function showDesktopNotification(title, text) {
        const details = { title, text, timeout: 12000 };
        try {
            if (typeof GM_notification === "function") {
                await Promise.resolve(GM_notification(details));
                return true;
            }
            if (typeof GM !== "undefined" && typeof GM.notification === "function") {
                await Promise.resolve(GM.notification(details));
                return true;
            }
        } catch {
            // Try the browser API below when the userscript manager declines a notification.
        }
        try {
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                new Notification(title, { body: text });
                return true;
            }
        } catch {
            return false;
        }
        return false;
    }

    async function showDailyNotification(alert, text) {
        const nativeResponse = await callConfirmedPdaHandler("scheduleNotification", {
            title: alert.title,
            subtitle: text,
            id: alert.notificationId,
            timestamp: Date.now() + 1500,
            overwriteID: true,
            launchNativeToast: false,
            urlCallback: companyPageUrl()
        });
        if (pdaHandlerSucceeded(nativeResponse)) return true;
        return showDesktopNotification(alert.title, text);
    }

    function nextDailyReminderTimestamp(alert, timestamp = Date.now()) {
        const today = dailyAlertPhaseTime(timestamp, alert.minute);
        return today > timestamp + 1000 ? today : dailyAlertPhaseTime(timestamp + DAY, alert.minute);
    }

    function buildDailyTickReminder(kind, timestamp = Date.now()) {
        const alert = DAILY_ALERTS[kind];
        if (!alert) return null;
        return {
            title: alert.title,
            subtitle: alert.reminderText,
            id: alert.reminderNotificationId,
            timestamp: nextDailyReminderTimestamp(alert, timestamp),
            overwriteID: true,
            launchNativeToast: false,
            urlCallback: companyPageUrl()
        };
    }

    async function persistDailyReminders() {
        await storeSet(STORE.dailyReminders, state.dailyReminders);
    }

    async function scheduleDailyTickReminder(kind, { force = false } = {}) {
        const reminder = buildDailyTickReminder(kind);
        if (!reminder) return false;
        if (!force && state.dailyReminders?.[kind]?.timestamp === reminder.timestamp) return true;
        const response = await callConfirmedPdaHandler("scheduleNotification", reminder);
        if (!pdaHandlerSucceeded(response)) return false;
        state.dailyReminders = { ...state.dailyReminders, [kind]: { timestamp: reminder.timestamp, scheduledAt: Date.now() } };
        await persistDailyReminders();
        return true;
    }

    async function cancelDailyTickReminder(kind) {
        const alert = DAILY_ALERTS[kind];
        if (!alert) return false;
        const response = await callConfirmedPdaHandler("cancelNotification", { id: alert.reminderNotificationId });
        const reminders = { ...state.dailyReminders };
        delete reminders[kind];
        state.dailyReminders = reminders;
        await persistDailyReminders();
        return pdaHandlerSucceeded(response);
    }

    async function refreshDailyTickReminders({ force = false } = {}) {
        if (dailyAlertRuntime.reminderRefreshPromise) return dailyAlertRuntime.reminderRefreshPromise;
        dailyAlertRuntime.reminderRefreshPromise = (async () => {
            if (!nativeRuntime.isTornPDA && !await confirmTornPDA()) return false;
            const results = await Promise.all(Object.keys(DAILY_ALERTS).map((kind) => scheduleDailyTickReminder(kind, { force })));
            return results.every(Boolean);
        })();
        try {
            return await dailyAlertRuntime.reminderRefreshPromise;
        } finally {
            dailyAlertRuntime.reminderRefreshPromise = null;
        }
    }

    async function deliverDailyAlert(kind, payload) {
        const alert = DAILY_ALERTS[kind];
        if (!alert) return false;
        const native = nativeRuntime.isTornPDA || await confirmTornPDA();
        if (native) await cancelDailyTickReminder(kind);
        const tone = kind === "employeeRisk" && payload.risks?.length ? "bad" : payload.unavailable ? "warn" : "good";
        const results = await Promise.allSettled([
            showDailyToast(payload.text, tone),
            showDailyNotification(alert, payload.text)
        ]);
        if (native) await refreshDailyTickReminders();
        return results.some((result) => result.status === "fulfilled" && result.value === true);
    }

    function apiError(payload, source) {
        const error = payload?.error || payload?.errors;
        if (!error) return null;
        if (typeof error === "string") return `${source}: ${error}`;
        return `${source}: ${error.error || error.message || error.code || "request failed"}`;
    }

    function gmTextRequest({ url, headers = {}, method = "GET", timeout = 30000 }) {
        return new Promise((resolve, reject) => {
            const request = safeRequestDescriptor(url, method);
            const startedAt = Date.now();
            let settled = false;
            const durationMs = () => Math.max(0, Date.now() - startedAt);
            const fail = (error, transport, status = null) => {
                if (settled) return;
                settled = true;
                const failure = error instanceof Error ? error : new Error(safeDiagnosticError(error));
                errorLog("api:failure", { ...request, transport, status, durationMs: durationMs(), reason: safeDiagnosticError(failure) });
                reject(failure);
            };
            const onload = (response, transport) => {
                if (settled) return;
                const status = Number(response?.status ?? 200);
                if (status >= 200 && status < 300) {
                    const body = typeof response === "string" ? response : (response?.responseText ?? JSON.stringify(response?.body ?? response));
                    settled = true;
                    debugLog("api:success", { ...request, transport, status, durationMs: durationMs() });
                    resolve(body);
                    return;
                }
                fail(new Error(`Request failed (${status || "unknown status"}).`), transport, status || null);
            };
            const fetchFallback = (from = "") => {
                if (from) warningLog("api:transport fallback", { ...request, from, to: "fetch" });
                debugLog("api:request", { ...request, transport: "fetch" });
                fetch(url, { method, headers }).then(async (response) => {
                    if (!response.ok) {
                        const error = new Error(`Request failed (${response.status}).`);
                        error.status = response.status;
                        throw error;
                    }
                    return { status: response.status, responseText: await response.text() };
                }).then((response) => onload(response, "fetch")).catch((error) => fail(error, "fetch", error?.status || null));
            };
            if (typeof GM_xmlhttpRequest === "function") {
                debugLog("api:request", { ...request, transport: "GM_xmlhttpRequest" });
                try {
                    GM_xmlhttpRequest({
                        method,
                        url,
                        headers: { Accept: "application/json", ...headers },
                        timeout,
                        onload: (response) => onload(response, "GM_xmlhttpRequest"),
                        onerror: (error) => fail(error || new Error("Network request failed."), "GM_xmlhttpRequest"),
                        ontimeout: () => fail(new Error("Request timed out."), "GM_xmlhttpRequest")
                    });
                } catch (error) {
                    fail(error, "GM_xmlhttpRequest");
                }
                return;
            }
            if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
                debugLog("api:request", { ...request, transport: "GM.xmlHttpRequest" });
                try {
                    GM.xmlHttpRequest({
                        method,
                        url,
                        headers: { Accept: "application/json", ...headers },
                        timeout,
                        onload: (response) => onload(response, "GM.xmlHttpRequest"),
                        onerror: (error) => fail(error || new Error("Network request failed."), "GM.xmlHttpRequest"),
                        ontimeout: () => fail(new Error("Request timed out."), "GM.xmlHttpRequest")
                    });
                } catch (error) {
                    fail(error, "GM.xmlHttpRequest");
                }
                return;
            }
            if (String(method).toUpperCase() === "GET" && (getFlutterBridge() || nativeRuntime.isTornPDA || tornPdaUserAgent(currentUserAgent()))) {
                debugLog("api:request", { ...request, transport: "PDA_httpGet" });
                nativeHttpGet(url, { Accept: "application/json", ...headers }, timeout).then((response) => onload(response, "PDA_httpGet"), (error) => fetchFallback(`PDA_httpGet (${safeDiagnosticError(error)})`));
                return;
            }
            fetchFallback();
        });
    }

    async function jsonRequest(options, source) {
        const raw = await gmTextRequest(options);
        let payload;
        try {
            payload = JSON.parse(raw);
        } catch {
            const error = new Error(`${source}: Invalid JSON response.`);
            errorLog("api:payload failure", { ...safeRequestDescriptor(options?.url, options?.method), source, reason: safeDiagnosticError(error) });
            throw error;
        }
        const error = apiError(payload, source);
        if (error) {
            const failure = new Error(error);
            errorLog("api:payload failure", { ...safeRequestDescriptor(options?.url, options?.method), source, reason: safeDiagnosticError(failure) });
            throw failure;
        }
        return payload;
    }

    async function torn(path, query = {}) {
        const key = String(state.settings.tornKey || "").trim();
        if (!key) throw new Error("Add a Torn API key in Settings.");
        const params = new URLSearchParams();
        Object.entries(query).forEach(([name, value]) => {
            if (value !== undefined && value !== null && value !== "") params.set(name, String(value));
        });
        const suffix = params.toString() ? `?${params}` : "";
        return jsonRequest({
            url: `${TORN_API}${path}${suffix}`,
            headers: { Authorization: `ApiKey ${key}`, "X-Requested-With": "NaughtyCompanyCompanion" }
        }, "Torn API");
    }

    async function tornStatsEfficiency(stats) {
        const key = String(state.settings.tornStatsKey || "").trim();
        if (!key) throw new Error("Add a TornStats API key in Settings.");
        const params = new URLSearchParams({
            man: String(asNumber(stats.manual_labor)),
            int: String(asNumber(stats.intelligence)),
            end: String(asNumber(stats.endurance))
        });
        return jsonRequest({
            url: `${TORNSTATS_API}/${encodeURIComponent(key)}/efficiency?${params}`,
            headers: { "X-Requested-With": "NaughtyCompanyCompanion" }
        }, "TornStats API");
    }

    function unwrap(payload, key, fallback) {
        if (isObject(payload) && payload[key] !== undefined) return payload[key];
        return payload ?? fallback;
    }

    function reportingPeriod(timestamp = Date.now()) {
        const date = new Date(timestamp);
        let period = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 18, 10, 0, 0);
        if (timestamp < period) period -= DAY;
        return period;
    }

    function weekKey(timestamp = Date.now()) {
        const date = new Date(timestamp);
        const daysSinceSunday = (date.getUTCDay() + 7 - 0) % 7;
        let start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceSunday, 18, 10, 0, 0);
        if (timestamp < start) start -= 7 * DAY;
        return String(start);
    }

    function isPostSundayReset(timestamp = Date.now()) {
        const date = new Date(timestamp);
        return date.getUTCDay() === 0 && (date.getUTCHours() > 18 || (date.getUTCHours() === 18 && date.getUTCMinutes() >= 10));
    }

    function incomeOf(company, key = "weekly") {
        return asNumber(company?.income?.[key]);
    }

    function ratingOf(company) {
        return Math.floor(asNumber(company?.rating));
    }

    function weeklyRanked(companies) {
        return [...companies].sort((left, right) => incomeOf(right) - incomeOf(left));
    }

    function countStars(companies) {
        return companies.reduce((counts, company) => {
            const stars = ratingOf(company);
            if (stars > 0) counts[stars] = (counts[stars] || 0) + 1;
            return counts;
        }, {});
    }

    function calculateRankingMetrics(companies, profile, savedSlotCounts = null) {
        const ranked = weeklyRanked(companies);
        const ownId = String(profile?.id || "");
        const ownIndex = ranked.findIndex((company) => String(company?.id || "") === ownId);
        const currentStar = ratingOf(profile);
        const ownWeekly = incomeOf(profile);
        const slotCounts = isObject(savedSlotCounts) && Object.keys(savedSlotCounts).length ? savedSlotCounts : countStars(companies);
        const countAtOrAbove = (star) => Object.entries(slotCounts).reduce((total, [level, count]) => Number(level) >= star ? total + asNumber(count) : total, 0);
        const nextStar = currentStar + 1;
        const nextCutoff = countAtOrAbove(nextStar);
        const previousCutoff = countAtOrAbove(currentStar);
        const nextRequired = nextStar <= 10 && nextCutoff > 0 && ranked[nextCutoff - 1] ? incomeOf(ranked[nextCutoff - 1]) : null;
        const previousThreshold = currentStar > 1 && ranked[previousCutoff] ? incomeOf(ranked[previousCutoff]) : null;
        const rank = ownIndex < 0 ? null : ownIndex + 1;
        const total = ranked.length;
        const neighbors = rank === null ? [] : ranked.slice(Math.max(0, ownIndex - 5), Math.min(total, ownIndex + 6)).map((company, index) => ({ ...company, rank: Math.max(0, ownIndex - 5) + index + 1 }));
        return {
            ranked,
            rank,
            total,
            percentile: rank === null || !total ? null : Math.round(((total - rank + 1) / total) * 1000) / 10,
            currentStar,
            nextStar: nextRequired === null ? null : nextStar,
            previousStar: currentStar > 1 ? currentStar - 1 : null,
            nextRequired,
            nextGap: nextRequired === null ? null : Math.max(0, nextRequired - ownWeekly),
            previousThreshold,
            previousBuffer: previousThreshold === null ? null : Math.max(0, ownWeekly - previousThreshold),
            slotCounts,
            neighbors
        };
    }

    function financials(data = state.data) {
        const profile = data?.profile || {};
        const employees = Array.isArray(data?.employees) ? data.employees : [];
        const stock = Array.isArray(data?.stock) ? data.stock : [];
        const dailyIncome = asNumber(profile?.income?.daily);
        const weeklyIncome = asNumber(profile?.income?.weekly);
        const adBudget = asFinite(profile?.advertisement_budget);
        const expectedEmployees = asFinite(profile?.employees?.hired);
        const wagesAvailable = expectedEmployees === 0 || (employees.length > 0 && (expectedEmployees === null || employees.length >= expectedEmployees) && employees.every((employee) => asFinite(employee?.wage) !== null));
        const totalWages = wagesAvailable ? employees.reduce((sum, employee) => sum + asNumber(employee.wage), 0) : null;
        const stockCost = state.settings.includeStockCost
            ? stock.reduce((sum, item) => sum + asNumber(item?.cost) * asNumber(item?.sold_amount), 0)
            : 0;
        const baseProfitAvailable = adBudget !== null && totalWages !== null;
        const stockProfitAvailable = !state.settings.includeStockCost || data?.stockAvailable !== false;
        return {
            dailyIncome,
            weeklyIncome,
            adBudget,
            totalWages,
            stockCost,
            dailyProfit: baseProfitAvailable && stockProfitAvailable ? dailyIncome - stockCost - adBudget - totalWages : null,
            weeklyProfit: baseProfitAvailable ? weeklyIncome - 7 * (adBudget + totalWages) : null,
            canProfit: baseProfitAvailable && stockProfitAvailable,
            canProfitWeekly: baseProfitAvailable
        };
    }

    function utcDayKey(timestamp = Date.now()) {
        const date = new Date(timestamp);
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    }

    function dailyAlertPhaseTime(timestamp, minute) {
        const date = new Date(timestamp);
        return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), DAILY_TICK_HOUR_UTC, minute, 0, 0);
    }

    function isDailyAlertDue(timestamp, minute) {
        return timestamp >= dailyAlertPhaseTime(timestamp, minute);
    }

    function dailyAlertDataSource(data, phaseTimestamp) {
        const fetchedAt = asFinite(data?.fetchedAt);
        if (fetchedAt !== null && fetchedAt >= phaseTimestamp) return { fresh: true, label: "Live refresh" };
        if (fetchedAt === null) return { fresh: false, label: "CACHED — refresh time unavailable" };
        const date = new Date(fetchedAt);
        return { fresh: false, label: `CACHED — refreshed ${Number.isNaN(date.getTime()) ? "at an unknown time" : date.toISOString().replace(".000Z", "Z")}` };
    }

    function alertMoney(value) {
        return asFinite(value) === null ? "unavailable" : formatMoney(value);
    }

    function alertCount(value) {
        return asFinite(value) === null ? "unavailable" : formatNumber(value);
    }

    function buildDailyTickAlert(data, timestamp = Date.now()) {
        const profile = data?.profile || {};
        const financesNow = financials(data);
        const source = dailyAlertDataSource(data, dailyAlertPhaseTime(timestamp, DAILY_ALERTS.income.minute));
        return {
            title: DAILY_ALERTS.income.title,
            text: [
                `Daily Income: ${alertMoney(financesNow.dailyIncome)}`,
                `Daily Profit: ${alertMoney(financesNow.dailyProfit)}`,
                `Daily Customer Count: ${alertCount(profile?.customers?.daily)}`,
                source.label
            ].join("\n"),
            source
        };
    }

    function employeeEffectivenessRisks(employees, threshold = EFFECTIVENESS_ALERT_THRESHOLD) {
        return (Array.isArray(employees) ? employees : []).map((employee) => {
            const addiction = asFinite(employee?.effectiveness?.addiction);
            const inactivity = asFinite(employee?.effectiveness?.inactivity);
            const issues = [];
            if (addiction !== null && addiction < threshold) issues.push({ label: "Addiction", value: addiction });
            if (inactivity !== null && inactivity < threshold) issues.push({ label: "Inactivity", value: inactivity });
            return { id: String(employee?.id || ""), name: String(employee?.name || "Unknown"), addiction, inactivity, issues };
        }).filter((employee) => employee.issues.length > 0);
    }

    function formatEffectivenessAlertValue(value) {
        return `${value > 0 ? "+" : ""}${formatOptionalNumber(value, 1)}`;
    }

    function buildEmployeeRiskAlert(data, timestamp = Date.now()) {
        const risks = employeeEffectivenessRisks(data?.employees);
        const source = dailyAlertDataSource(data, dailyAlertPhaseTime(timestamp, DAILY_ALERTS.employeeRisk.minute));
        const hasEffectiveness = data?.employeesAvailable !== false && (Array.isArray(data?.employees) ? data.employees : []).some((employee) => isObject(employee?.effectiveness));
        const details = !hasEffectiveness
            ? "Employee effectiveness data is unavailable from Torn, so no risk assessment could be made."
            : risks.length
            ? risks.map((employee) => `${employee.name} (${employee.issues.map((issue) => `${issue.label} ${formatEffectivenessAlertValue(issue.value)}`).join(", ")})`).join("; ")
            : `No employees are below ${EFFECTIVENESS_ALERT_THRESHOLD} for Addiction or Inactivity effectiveness.`;
        return {
            title: DAILY_ALERTS.employeeRisk.title,
            text: [`Employees below ${EFFECTIVENESS_ALERT_THRESHOLD}: ${details}`, source.label].join("\n"),
            risks,
            unavailable: !hasEffectiveness,
            source
        };
    }

    function dailyAlertPayload(kind, data, timestamp = Date.now()) {
        return kind === "income" ? buildDailyTickAlert(data, timestamp) : buildEmployeeRiskAlert(data, timestamp);
    }

    function dailyAlertScope(data = state.data) {
        return String(data?.profile?.id || "");
    }

    function dailyAlertRecord(data = state.data) {
        const scope = dailyAlertScope(data);
        const record = state.dailyAlerts?.[scope];
        return isObject(record) ? record : {};
    }

    function dailyAlertInFlightKey(kind, data = state.data) {
        return `${dailyAlertScope(data)}:${kind}`;
    }

    function pendingDailyAlertKinds(timestamp = Date.now(), data = state.data) {
        const day = utcDayKey(timestamp);
        const record = dailyAlertRecord(data);
        return Object.entries(DAILY_ALERTS).filter(([kind, alert]) => isDailyAlertDue(timestamp, alert.minute) && record[kind] !== day && !dailyAlertRuntime.inFlight.has(dailyAlertInFlightKey(kind, data))).map(([kind]) => kind);
    }

    function nextDailyAlertTimestamp(timestamp = Date.now()) {
        const today = Object.values(DAILY_ALERTS).map((alert) => dailyAlertPhaseTime(timestamp, alert.minute));
        const tomorrow = timestamp + DAY;
        const nextDay = Object.values(DAILY_ALERTS).map((alert) => dailyAlertPhaseTime(tomorrow, alert.minute));
        return [...today, ...nextDay].sort((left, right) => left - right).find((candidate) => candidate > timestamp + 250) || nextDay[0];
    }

    function dailyAlertKindAt(timestamp) {
        return Object.entries(DAILY_ALERTS).find(([, alert]) => dailyAlertPhaseTime(timestamp, alert.minute) === timestamp)?.[0] || null;
    }

    function dailyAlertRefreshNeeded(kinds, timestamp = Date.now(), data = state.data) {
        if (!data?.profile) return true;
        return kinds.some((kind) => !dailyAlertDataSource(data, dailyAlertPhaseTime(timestamp, DAILY_ALERTS[kind].minute)).fresh);
    }

    async function markDailyAlertFired(kind, timestamp = Date.now()) {
        const scope = dailyAlertScope();
        if (!scope) return;
        state.dailyAlerts = { ...state.dailyAlerts, [scope]: { ...dailyAlertRecord(), [kind]: utcDayKey(timestamp) } };
        await storeSet(STORE.dailyAlerts, state.dailyAlerts);
    }

    async function runDailyTickAlerts({ refresh = false } = {}) {
        const now = Date.now();
        if (!String(state.settings.tornKey || "").trim()) return;
        let pending = pendingDailyAlertKinds(now);
        if (!pending.length) return;
        if (refresh && dailyAlertRefreshNeeded(pending, now)) {
            if (state.loading) return;
            await refreshCore({ silent: true, suppressDailyAlerts: true });
        }
        if (!state.data?.profile) return;
        const firedAt = Date.now();
        pending = pendingDailyAlertKinds(firedAt);
        for (const kind of pending) {
            const inFlightKey = dailyAlertInFlightKey(kind);
            dailyAlertRuntime.inFlight.add(inFlightKey);
            try {
                const payload = dailyAlertPayload(kind, state.data, firedAt);
                if (await deliverDailyAlert(kind, payload)) await markDailyAlertFired(kind, firedAt);
            } catch (error) {
                console.warn("[Naughty Company Companion] Daily alert could not be delivered.", error);
            } finally {
                dailyAlertRuntime.inFlight.delete(inFlightKey);
            }
        }
    }

    function scheduleDailyTickAlerts() {
        if (dailyAlertRuntime.timerId) clearTimeout(dailyAlertRuntime.timerId);
        if (dailyAlertRuntime.liveTimerId) clearTimeout(dailyAlertRuntime.liveTimerId);
        const target = nextDailyAlertTimestamp();
        const delay = Math.max(0, target - Date.now() - 1000);
        dailyAlertRuntime.timerId = setTimeout(async () => {
            const kind = dailyAlertKindAt(target);
            if (kind && nativeRuntime.isTornPDA) await cancelDailyTickReminder(kind);
            dailyAlertRuntime.liveTimerId = setTimeout(async () => {
                await runDailyTickAlerts({ refresh: true });
                scheduleDailyTickAlerts();
            }, Math.max(0, target - Date.now() + 300));
        }, delay);
    }

    function resetDailyTickAlerts() {
        scheduleDailyTickAlerts();
        void refreshDailyTickReminders();
        void runDailyTickAlerts({ refresh: true });
    }

    function companyHistory(companyId = state.data?.profile?.id) {
        return Array.isArray(state.history?.[String(companyId)]) ? state.history[String(companyId)] : [];
    }

    function monthMetrics(data = state.data) {
        const history = companyHistory(data?.profile?.id);
        const now = Date.now();
        const rows = history.filter((row) => row.period > now - 30 * DAY && row.period <= now);
        const financesNow = financials(data);
        const incomeRows = rows.filter((row) => asFinite(row.dailyIncome) !== null);
        const profitRows = rows.filter((row) => asFinite(row.dailyProfit) !== null);
        const trackedIncome = incomeRows.reduce((sum, row) => sum + asNumber(row.dailyIncome), 0);
        const trackedProfit = profitRows.reduce((sum, row) => sum + asNumber(row.dailyProfit), 0);
        return {
            coverage: incomeRows.length,
            profitCoverage: profitRows.length,
            trackedIncome,
            trackedProfit: profitRows.length ? trackedProfit : null,
            incomeForecast: financesNow.dailyIncome * 30,
            profitForecast: financesNow.dailyProfit === null ? null : financesNow.dailyProfit * 30,
            useTrackedIncome: incomeRows.length >= 25,
            useTrackedProfit: profitRows.length >= 25
        };
    }

    async function persistHistorySnapshot({ persist = true } = {}) {
        const profile = state.data?.profile;
        if (!profile?.id) return;
        const id = String(profile.id);
        const period = reportingPeriod();
        const financesNow = financials();
        const stockNow = stockMetrics();
        const rankingsNow = rankingMetrics();
        const stockAvailable = state.data?.stockAvailable === true;
        const efficiencyRows = employeeRows().map((employee) => employee.currentEfficiency).filter((value) => value !== null);
        const row = {
            period,
            capturedAt: Date.now(),
            dailyIncome: financesNow.dailyIncome,
            weeklyIncome: financesNow.weeklyIncome,
            dailyProfit: financesNow.dailyProfit,
            weeklyProfit: financesNow.weeklyProfit,
            funds: asFinite(profile.funds),
            rating: asFinite(profile.rating),
            stockQuantity: stockAvailable ? stockNow.inStock : null,
            stockValue: stockAvailable ? stockNow.saleValue : null,
            averageEmployeeEfficiency: efficiencyRows.length ? efficiencyRows.reduce((sum, value) => sum + asNumber(value), 0) / efficiencyRows.length : null,
            companyRank: trendNumber(rankingsNow?.rank),
            companyRankTotal: trendNumber(rankingsNow?.total),
            stock: Object.fromEntries((Array.isArray(state.data?.stock) ? state.data.stock : []).map((item) => [String(item.id), {
                inStock: asNumber(item.in_stock),
                onOrder: asNumber(item.on_order)
            }]))
        };
        const existing = companyHistory(id).filter((entry) => entry.period !== period && entry.period > period - 92 * DAY);
        state.history[id] = [...existing, row].sort((left, right) => left.period - right.period);
        if (persist) await storeSet(STORE.history, state.history);
        return state.history;
    }

    function statFingerprint(companyTypeId, stats) {
        return `${companyTypeId}:${asNumber(stats?.manual_labor)}:${asNumber(stats?.intelligence)}:${asNumber(stats?.endurance)}`;
    }

    function projectionBlock(response, typeId, typeName, knownPositions) {
        const exact = response?.[String(typeId)];
        if (isObject(exact) && exact.company) return exact;
        const candidates = Object.values(response || {}).filter((candidate) => isObject(candidate) && candidate.company);
        const byName = candidates.find((candidate) => String(candidate.company).trim().toLowerCase() === String(typeName || "").trim().toLowerCase());
        if (byName) return byName;
        const positions = new Set(knownPositions || []);
        return candidates.filter((candidate) => [...positions].every((position) => Object.prototype.hasOwnProperty.call(candidate, position))).sort((left, right) => Object.keys(left).length - Object.keys(right).length)[0] || null;
    }

    function currentCompanySettings() {
        const id = String(state.data?.profile?.id || "");
        return {
            id,
            assignments: isObject(state.settings.assignments?.[id]) ? state.settings.assignments[id] : {},
            locks: isObject(state.settings.lockedEmployees?.[id]) ? state.settings.lockedEmployees[id] : {},
            capacities: isObject(state.settings.positionCapacities?.[id]) ? state.settings.positionCapacities[id] : {},
            priority: Array.isArray(state.settings.positionPriority?.[id]) ? state.settings.positionPriority[id] : []
        };
    }

    function employeeRows() {
        const profile = state.data?.profile || {};
        const typeId = profile?.type?.id;
        const settings = currentCompanySettings();
        return (Array.isArray(state.data?.employees) ? state.data.employees : []).map((employee) => {
            const stats = isObject(employee.stats) ? employee.stats : {};
            const effectiveness = isObject(employee.effectiveness) ? employee.effectiveness : {};
            const fingerprint = statFingerprint(typeId, stats);
            const stored = state.projections?.[fingerprint];
            const projected = isObject(stored?.positions) ? stored.positions : {};
            const currentPosition = String(employee?.position?.name || employee?.position || "");
            const nonWorkingDelta = asNumber(effectiveness.total) - asNumber(effectiveness.working_stats);
            const positionEntries = Object.entries(projected).filter(([name]) => name !== "company").map(([name, value]) => [name, asNumber(value)]);
            const best = positionEntries.sort((left, right) => right[1] - left[1])[0] || ["", null];
            const employeeId = String(employee.id || "");
            const hasSavedAssignment = Object.prototype.hasOwnProperty.call(settings.assignments || {}, employeeId);
            const assignedPosition = String(hasSavedAssignment ? settings.assignments[employeeId] : (currentPosition || ""));
            const projectedCurrent = projected?.[currentPosition];
            const assignedBase = projected?.[assignedPosition];
            const assignedEfficiency = assignedBase === undefined ? null : asNumber(assignedBase) + nonWorkingDelta;
            return {
                id: employeeId,
                name: String(employee.name || "Unknown"),
                currentPosition,
                currentEfficiency: preferredCurrentEfficiency(effectiveness.total, projectedCurrent, nonWorkingDelta),
                currentEfficiencySource: projectedCurrent === undefined ? "Torn fallback" : "TornStats + effects",
                workingStats: asFinite(effectiveness.working_stats),
                projectedCurrent: projectedCurrent === undefined ? null : asNumber(projectedCurrent),
                projected,
                bestPosition: best[0],
                bestEfficiency: best[1] === null ? null : best[1] + nonWorkingDelta,
                assignedPosition,
                assignedEfficiency,
                nonWorkingDelta,
                addiction: asFinite(effectiveness.addiction),
                inactivity: asFinite(effectiveness.inactivity),
                settledIn: asFinite(effectiveness.settled_in),
                directorEducation: asFinite(effectiveness.director_education),
                management: asFinite(effectiveness.management),
                book: asFinite(effectiveness.book),
                merits: asFinite(effectiveness.merits),
                wrongGender: asFinite(effectiveness.wrong_gender),
                wage: asFinite(employee.wage),
                days: asFinite(employee.days_in_company),
                status: String(employee?.status?.description || employee?.status?.state || "Unknown"),
                lastAction: asFinite(employee?.last_action?.timestamp),
                locked: Boolean(settings.locks?.[String(employee.id)])
            };
        });
    }

    function projectionPositions() {
        const positions = new Set();
        employeeRows().forEach((row) => Object.keys(row.projected || {}).forEach((position) => positions.add(position)));
        employeeRows().forEach((row) => { if (row.currentPosition) positions.add(row.currentPosition); });
        return [...positions].sort((left, right) => left.localeCompare(right));
    }

    function assignProjectedRows(rows, positions, capacities = {}, totalCapacity = null, priority = [], lockedEmployeeIds = {}) {
        const ordered = [...priority.filter((position) => positions.includes(position)), ...positions.filter((position) => !priority.includes(position))];
        const assigned = {};
        const occupied = {};
        let total = 0;
        rows.forEach((row) => {
            if (!(row.locked || lockedEmployeeIds[row.id]) || !row.currentPosition) return;
            assigned[row.id] = row.currentPosition;
            occupied[row.currentPosition] = (occupied[row.currentPosition] || 0) + 1;
            total += 1;
        });
        ordered.forEach((position) => {
            if (totalCapacity !== null && total >= totalCapacity) return;
            const cap = asNumber(capacities[position]);
            const limit = cap > 0 ? cap : Infinity;
            let used = occupied[position] || 0;
            const candidates = rows.filter((row) => !assigned[row.id] && row.projected?.[position] !== undefined).sort((left, right) => asNumber(right.projected[position]) - asNumber(left.projected[position]));
            candidates.forEach((row) => {
                if (used >= limit || (totalCapacity !== null && total >= totalCapacity)) return;
                assigned[row.id] = position;
                used += 1;
                total += 1;
            });
            occupied[position] = used;
        });
        return { assigned, occupied, unassigned: rows.filter((row) => !assigned[row.id]), lockedOverages: Object.entries(occupied).filter(([position, used]) => asNumber(capacities[position]) > 0 && used > asNumber(capacities[position])) };
    }

    function calculateAssignments() {
        const profile = state.data?.profile || {};
        const rows = employeeRows();
        const positions = projectionPositions();
        if (!positions.length) throw new Error("Load TornStats projections before using automatic assignment.");
        const settings = currentCompanySettings();
        return assignProjectedRows(rows, positions, settings.capacities || {}, asFinite(profile?.employees?.capacity), settings.priority || [], settings.locks || {});
    }

    async function saveSettings(patch = {}) {
        state.settings = deepMergeSettings({ ...state.settings, ...patch });
        await storeSet(STORE.settings, state.settings);
    }

    async function loadPersistedState() {
        const stored = await loadStoredValues();
        const settings = stored[STORE.settings] ?? {};
        const layout = stored[STORE.layout] ?? DEFAULT_LAYOUT;
        const cache = stored[STORE.cache] ?? null;
        const history = stored[STORE.history] ?? {};
        const rankings = stored[STORE.rankings] ?? {};
        const projections = stored[STORE.projections] ?? {};
        const rankHistory = stored[STORE.rankHistory] ?? {};
        const starCohorts = stored[STORE.starCohorts] ?? {};
        const dailyAlerts = stored[STORE.dailyAlerts] ?? {};
        const dailyReminders = stored[STORE.dailyReminders] ?? {};
        state.settings = deepMergeSettings(settings);
        state.layout = { ...DEFAULT_LAYOUT, ...(isObject(layout) ? layout : {}) };
        state.cache = isObject(cache) ? cache : null;
        state.history = normalizeHistory(history);
        state.rankings = isObject(rankings) ? rankings : {};
        state.projections = isObject(projections) ? projections : {};
        state.rankHistory = isObject(rankHistory) ? rankHistory : {};
        state.starCohorts = isObject(starCohorts) ? starCohorts : {};
        state.dailyAlerts = isObject(dailyAlerts) ? dailyAlerts : {};
        state.dailyReminders = isObject(dailyReminders) ? dailyReminders : {};
        state.selectedTab = state.settings.activeTab || "overview";
        if (state.cache?.profile?.id) state.data = state.cache;
    }

    function normalizeHistory(history) {
        if (!isObject(history)) return {};
        return Object.fromEntries(Object.entries(history).map(([companyId, entries]) => [companyId, Array.isArray(entries) ? entries.map((entry) => {
            if (!isObject(entry)) return entry;
            const legacyDaily = entry[Object.keys(entry).find((key) => key.startsWith("daily") && key !== "dailyIncome" && key !== "dailyProfit")];
            const legacyWeekly = entry[Object.keys(entry).find((key) => key.startsWith("weekly") && key !== "weeklyIncome" && key !== "weeklyProfit")];
            return { ...entry, dailyIncome: entry.dailyIncome ?? legacyDaily, weeklyIncome: entry.weeklyIncome ?? legacyWeekly };
        }) : []]));
    }

    async function refreshCore({ silent = false, suppressDailyAlerts = false } = {}) {
        if (state.loading) return;
        if (!String(state.settings.tornKey || "").trim()) {
            state.error = "Add a Torn API key in Settings before refreshing.";
            render();
            return;
        }
        state.loading = true;
        state.error = "";
        state.status = "Refreshing company data…";
        render();
        const [profileResult, employeesResult, stockResult, newsResult, applicationsResult] = await Promise.allSettled([
            torn("/company/profile"),
            torn("/company/employees"),
            torn("/company/stock"),
            torn("/company/news", { cat: "funds", limit: 100, sort: "DESC" }),
            torn("/company/applications")
        ]);
        const messages = [];
        if (profileResult.status !== "fulfilled") {
            state.loading = false;
            state.error = profileResult.reason?.message || "Unable to load company profile.";
            state.status = "Refresh failed.";
            render();
            return;
        }
        const profile = unwrap(profileResult.value, "profile", {});
        if (!profile?.id) {
            state.loading = false;
            state.error = "Torn did not return a company profile for this key.";
            state.status = "Refresh failed.";
            render();
            return;
        }
        const resultValue = (result, key, fallback) => result.status === "fulfilled" ? unwrap(result.value, key, fallback) : fallback;
        if (employeesResult.status !== "fulfilled") messages.push("Employee details unavailable for this key.");
        if (stockResult.status !== "fulfilled") messages.push("Stock details require a Limited or higher Torn key.");
        if (newsResult.status !== "fulfilled") messages.push("Funds news unavailable for this key.");
        if (applicationsResult.status !== "fulfilled") messages.push("Applications unavailable for this key.");
        state.data = {
            profile,
            employees: Array.isArray(resultValue(employeesResult, "employees", [])) ? resultValue(employeesResult, "employees", []) : [],
            employeesAvailable: employeesResult.status === "fulfilled",
            stock: Array.isArray(resultValue(stockResult, "stock", [])) ? resultValue(stockResult, "stock", []) : [],
            stockAvailable: stockResult.status === "fulfilled",
            news: Array.isArray(resultValue(newsResult, "news", [])) ? resultValue(newsResult, "news", []) : [],
            applications: Array.isArray(resultValue(applicationsResult, "applications", [])) ? resultValue(applicationsResult, "applications", []) : [],
            fetchedAt: Date.now()
        };
        state.cache = state.data;
        await persistHistorySnapshot({ persist: false });
        await storeSetMany({ [STORE.cache]: state.cache, [STORE.history]: state.history });
        state.loading = false;
        state.status = `Updated ${timeAgo(state.data.fetchedAt)}.${messages.length ? ` ${messages.join(" ")}` : ""}`;
        render();
        void loadRankings();
        if (!suppressDailyAlerts) void runDailyTickAlerts({ refresh: false });
    }

    async function loadRankings({ force = false } = {}) {
        if (state.rankingLoading || !state.data?.profile?.type?.id) return;
        const profile = state.data.profile;
        const id = String(profile.id);
        const cached = state.rankings[id];
        if (!force && cached?.fetchedAt && Date.now() - cached.fetchedAt < RANKING_TTL && Array.isArray(cached.companies)) {
            state.status = `Rankings cached ${timeAgo(cached.fetchedAt)}.`;
            render();
            return;
        }
        state.rankingLoading = true;
        state.error = "";
        state.status = "Loading same-type company rankings…";
        render();
        try {
            const typeId = profile.type.id;
            const first = await torn(`/company/${typeId}/companies`, { limit: 100, offset: 0 });
            const companies = Array.isArray(first.companies) ? [...first.companies] : [];
            const total = Math.min(asNumber(first?._metadata?.total, companies.length), 5000);
            const offsets = [];
            for (let offset = 100; offset < total; offset += 100) offsets.push(offset);
            for (let index = 0; index < offsets.length; index += 4) {
                const batch = offsets.slice(index, index + 4);
                const pages = await Promise.all(batch.map((offset) => torn(`/company/${typeId}/companies`, { limit: 100, offset })));
                pages.forEach((page) => companies.push(...(Array.isArray(page.companies) ? page.companies : [])));
                state.status = `Loading rankings ${Math.min(total, index * 100 + 500)} / ${total}…`;
                render();
                if (index + 4 < offsets.length) await sleep(80);
            }
            const unique = [...new Map(companies.map((company) => [String(company.id), company])).values()];
            const now = Date.now();
            const currentWeek = weekKey(now);
            const savedCohort = state.starCohorts[id];
            if (!savedCohort || savedCohort.week !== currentWeek || isPostSundayReset(now)) {
                state.starCohorts[id] = { week: currentWeek, capturedAt: now, counts: countStars(unique), source: isPostSundayReset(now) ? "post-reset" : "first-observed" };
                await storeSet(STORE.starCohorts, state.starCohorts);
            }
            const metrics = calculateRankingMetrics(unique, profile, state.starCohorts[id]?.counts);
            const prior = state.rankHistory[id];
            state.rankings[id] = { fetchedAt: now, companies: unique, typeId, total: unique.length, previousRank: prior?.rank ?? null };
            state.rankHistory[id] = { rank: metrics.rank, timestamp: now };
            await persistHistorySnapshot({ persist: false });
            await storeSetMany({ [STORE.rankings]: state.rankings, [STORE.rankHistory]: state.rankHistory, [STORE.history]: state.history });
            state.status = `Ranked ${formatNumber(unique.length)} ${profile.type.name} companies.${prior?.rank && metrics.rank ? ` Rank ${prior.rank === metrics.rank ? "unchanged" : metrics.rank < prior.rank ? "improved" : "fell"}.` : ""}`;
        } catch (error) {
            state.error = error?.message || "Unable to load company rankings.";
            state.status = "Rankings unavailable.";
        } finally {
            state.rankingLoading = false;
            render();
        }
    }

    async function loadProjections() {
        if (state.projectionLoading) return;
        if (!state.settings.projectionConsent) {
            state.error = "Enable the TornStats employee-stat sharing consent in Settings before loading projections.";
            render();
            return;
        }
        if (!String(state.settings.tornStatsKey || "").trim()) {
            state.error = "Add a TornStats API key in Settings before loading projections.";
            render();
            return;
        }
        const profile = state.data?.profile;
        if (!profile?.type?.id) return;
        const employees = Array.isArray(state.data?.employees) ? state.data.employees : [];
        const pending = employees.filter((employee) => {
            const record = state.projections[statFingerprint(profile.type.id, employee.stats || {})];
            return !record || Date.now() - asNumber(record.fetchedAt) > PROJECTION_TTL;
        });
        if (!pending.length) {
            state.status = "All efficiency projections are already cached.";
            render();
            return;
        }
        state.projectionLoading = true;
        state.error = "";
        try {
            const knownPositions = new Set(employees.map((employee) => String(employee?.position?.name || employee?.position || "")).filter(Boolean));
            for (let index = 0; index < pending.length; index += 3) {
                const batch = pending.slice(index, index + 3);
                await Promise.all(batch.map(async (employee) => {
                    const response = await tornStatsEfficiency(employee.stats || {});
                    const block = projectionBlock(response, profile.type.id, profile.type.name, knownPositions);
                    if (!block) throw new Error(`TornStats did not return a ${profile.type.name} position block.`);
                    const positions = Object.fromEntries(Object.entries(block).filter(([name, value]) => name !== "company" && asFinite(value) !== null).map(([name, value]) => [name, asNumber(value)]));
                    state.projections[statFingerprint(profile.type.id, employee.stats || {})] = { fetchedAt: Date.now(), positions };
                }));
                state.status = `Loading efficiency projections ${Math.min(index + batch.length, pending.length)} / ${pending.length}…`;
                render();
                if (index + 3 < pending.length) await sleep(120);
            }
            const entries = Object.entries(state.projections).sort((left, right) => asNumber(right[1]?.fetchedAt) - asNumber(left[1]?.fetchedAt)).slice(0, 1200);
            state.projections = Object.fromEntries(entries);
            await storeSet(STORE.projections, state.projections);
            state.status = `Loaded ${formatNumber(pending.length)} TornStats efficiency projections.`;
        } catch (error) {
            state.error = error?.message || "Unable to load TornStats projections.";
        } finally {
            state.projectionLoading = false;
            render();
        }
    }

    function panel() {
        return document.getElementById("ncc-panel");
    }

    function content() {
        return document.getElementById("ncc-content");
    }

    function isCompactLayout({ containerWidth, viewportWidth, forceCompact = false } = {}) {
        const widths = [containerWidth, viewportWidth].map(Number).filter(Number.isFinite);
        return forceCompact || (widths.length > 0 && Math.min(...widths) <= COMPACT_LAYOUT_MAX_WIDTH);
    }

    function visibleViewport() {
        const visualViewport = window.visualViewport;
        const windowWidth = Math.max(1, asNumber(window.innerWidth, 1024));
        const windowHeight = Math.max(1, asNumber(window.innerHeight, 768));
        return {
            width: Math.max(1, Math.floor(Math.min(windowWidth, asNumber(visualViewport?.width, windowWidth)))),
            height: Math.max(1, Math.floor(Math.min(windowHeight, asNumber(visualViewport?.height, windowHeight))))
        };
    }

    function boundedPanelLayout(layout = DEFAULT_LAYOUT, { width = 1024, height = 768, margin = PANEL_MARGIN } = {}) {
        const viewportWidth = Math.max(1, asNumber(width, 1024));
        const viewportHeight = Math.max(1, asNumber(height, 768));
        const safeMargin = Math.max(0, Math.min(asNumber(margin, PANEL_MARGIN), Math.floor(Math.min(viewportWidth, viewportHeight) / 4)));
        const maxWidth = Math.max(1, viewportWidth - safeMargin * 2);
        const maxHeight = Math.max(1, viewportHeight - safeMargin * 2);
        const panelWidth = clamp(asNumber(layout?.width, DEFAULT_LAYOUT.width), Math.min(430, maxWidth), maxWidth);
        const panelHeight = clamp(asNumber(layout?.height, DEFAULT_LAYOUT.height), Math.min(420, maxHeight), maxHeight);
        const minX = Math.min(safeMargin, Math.max(0, viewportWidth - panelWidth));
        const minY = Math.min(safeMargin, Math.max(0, viewportHeight - panelHeight));
        return {
            width: panelWidth,
            height: panelHeight,
            x: layout?.x === null || layout?.x === undefined ? null : clamp(asNumber(layout.x), minX, Math.max(minX, viewportWidth - panelWidth - safeMargin)),
            y: clamp(asNumber(layout?.y, PANEL_MARGIN), minY, Math.max(minY, viewportHeight - panelHeight - safeMargin)),
            margin: safeMargin,
            minimized: Boolean(layout?.minimized)
        };
    }

    function applyCompactLayout(mode) {
        const root = document.getElementById(ROOT_ID);
        const el = panel();
        if (!root || !el) return false;
        const viewport = visibleViewport();
        const compact = isCompactLayout({ containerWidth: el.getBoundingClientRect().width, viewportWidth: viewport.width, forceCompact: mode === "mobile" });
        root.setAttribute("data-compact-layout", compact ? "true" : "false");
        return compact;
    }

    function isCompactViewport({ width = 1024, height = 768, scale = 1 } = {}) {
        return width <= 700 || height <= 520 || (scale > 1.1 && width <= 960);
    }

    function runtimeMode({ isTornPDA = false, userAgent = "", width = 1024, height = 768, scale = 1 } = {}) {
        const pdaRuntime = Boolean(isTornPDA) || tornPdaUserAgent(userAgent);
        return pdaRuntime || isCompactViewport({ width, height, scale }) ? "mobile" : "desktop";
    }

    function currentRuntimeMode() {
        const visualViewport = window.visualViewport;
        return runtimeMode({
            isTornPDA: nativeRuntime.isTornPDA,
            userAgent: currentUserAgent(),
            width: Math.min(window.innerWidth, visualViewport?.width || window.innerWidth),
            height: Math.min(window.innerHeight, visualViewport?.height || window.innerHeight),
            scale: visualViewport?.scale || 1
        });
    }

    function applyRuntimeMode() {
        const mode = currentRuntimeMode();
        state.runtimeMode = mode;
        document.getElementById(ROOT_ID)?.setAttribute("data-runtime", mode);
        return mode;
    }

    function applyLayout() {
        const el = panel();
        const launcher = document.getElementById("ncc-launcher");
        if (!el || !launcher) return;
        const mode = applyRuntimeMode();
        const layout = boundedPanelLayout(state.layout, visibleViewport());
        el.style.width = `${layout.width}px`;
        el.style.height = `${layout.height}px`;
        if (layout.x === null) {
            el.style.left = "auto";
            el.style.right = `${layout.margin}px`;
        } else {
            el.style.left = `${layout.x}px`;
            el.style.right = "auto";
        }
        el.style.top = `${layout.y}px`;
        el.classList.toggle("ncc-compact", mode === "mobile");
        launcher.classList.toggle("ncc-compact", mode === "mobile");
        el.classList.toggle("ncc-hidden", Boolean(layout.minimized));
        launcher.classList.toggle("ncc-hidden", !layout.minimized);
        applyCompactLayout(mode);
    }

    async function persistLayout() {
        const el = panel();
        if (!el) return;
        const rect = el.getBoundingClientRect();
        state.layout = {
            ...state.layout,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        };
        await storeSet(STORE.layout, state.layout);
    }

    function mountShell() {
        if (document.getElementById(ROOT_ID)) return;
        const root = document.createElement("div");
        root.id = ROOT_ID;
        root.innerHTML = `
            <style>
                #${ROOT_ID}, #${ROOT_ID} * { box-sizing: border-box; -ms-overflow-style:none; scrollbar-width:none; }
                #${ROOT_ID}::-webkit-scrollbar, #${ROOT_ID} *::-webkit-scrollbar { width:0; height:0; display:none; }
                #${ROOT_ID} { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
                #ncc-alert-toasts { position:fixed; z-index:2147483647; top:max(12px, env(safe-area-inset-top)); right:max(12px, env(safe-area-inset-right)); display:grid; gap:8px; width:min(460px,calc(100vw - 24px)); pointer-events:none; }
                .ncc-alert-toast { max-height:min(48vh,360px); overflow:auto; padding:11px 13px; border:1px solid #397866; border-radius:10px; background:#123e37; box-shadow:0 14px 36px #000a; color:#ecfff7; font-size:12px; font-weight:650; line-height:1.4; white-space:pre-wrap; pointer-events:auto; cursor:pointer; }
                .ncc-alert-toast.bad { border-color:#9d4651; background:#4b222b; color:#fff0f1; }
                .ncc-alert-toast.warn { border-color:#987229; background:#44361c; color:#fff3d1; }
                #ncc-launcher { position:fixed; right:18px; top:18px; z-index:2147483646; width:52px; height:52px; border:1px solid #54dfbd; border-radius:17px; background:linear-gradient(145deg,#123e45,#122639); color:#dffcf4; box-shadow:0 12px 34px #0009; font-size:24px; cursor:pointer; }
                #ncc-panel { position:fixed; z-index:2147483646; display:flex; flex-direction:column; overflow:hidden; min-width:430px; min-height:420px; max-width:calc(100vw - 8px); max-height:calc(100vh - 8px); border:1px solid #34516a; border-radius:16px; background:linear-gradient(150deg,#0d1a29 0%,#0a1421 60%,#101927 100%); color:#dbe7f4; box-shadow:0 18px 55px #000b; resize:none; }
                #ncc-panel.ncc-hidden, #ncc-launcher.ncc-hidden { display:none; }
                .ncc-resize-grip { position:absolute; z-index:4; bottom:0; width:24px; height:24px; margin:0; padding:0; border:0; background:transparent; touch-action:none; }
                .ncc-resize-grip::before { position:absolute; right:5px; bottom:5px; width:11px; height:11px; content:""; border-right:2px solid #5cbfaf; border-bottom:2px solid #5cbfaf; opacity:.9; }
                .ncc-resize-grip:hover::before, .ncc-resize-grip:focus-visible::before { border-color:#d9fff4; opacity:1; }
                .ncc-resize-grip-left { left:0; cursor:nesw-resize; transform:scaleX(-1); }
                .ncc-resize-grip-right { right:0; cursor:nwse-resize; }
                .ncc-head { display:flex; align-items:center; gap:10px; min-height:55px; padding:10px 12px 9px 15px; border-bottom:1px solid #294157; background:linear-gradient(90deg,#112b3b,#102234 70%,#112030); cursor:move; user-select:none; }
                .ncc-brand { min-width:0; flex:1; }
                .ncc-brand strong { display:block; color:#dffcf4; font-size:13px; letter-spacing:.03em; }
                .ncc-brand small { display:block; max-width:510px; overflow:hidden; color:#94a8ba; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-head-actions { display:flex; gap:6px; cursor:default; }
                .ncc-icon { width:29px; height:29px; border:1px solid #39546b; border-radius:8px; background:#132337; color:#bcd0df; cursor:pointer; font-size:14px; }
                .ncc-refresh-button { min-height:29px; padding:5px 8px; }
                .ncc-icon:hover, .ncc-tab.active, .ncc-primary:hover { border-color:#4ce0bd; color:#e5fff8; }
                .ncc-tabs { display:flex; gap:5px; overflow-x:auto; overflow-y:hidden; padding:8px 10px; border-bottom:1px solid #253d52; background:#0d1a28; }
                .ncc-tab { flex:0 0 auto; min-height:30px; padding:6px 10px; border:1px solid transparent; border-radius:7px; background:transparent; color:#8fa6b9; cursor:pointer; font-size:11px; font-weight:700; }
                .ncc-tab:hover { color:#e0eef7; background:#14283a; }
                .ncc-tab.active { background:#163a48; color:#dffcf4; }
                #ncc-content { min-width:0; min-height:0; flex:1; overflow-x:hidden; overflow-y:auto; padding:12px; }
                .ncc-section { margin-bottom:12px; border:1px solid #29465d; border-radius:11px; background:#0d1b2a; overflow:hidden; }
                .ncc-section-head { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px 11px; border-bottom:1px solid #243e54; background:#112235; }
                .ncc-section-head h2, .ncc-section-head h3 { margin:0; color:#e4f3fa; font-size:12px; letter-spacing:.01em; }
                .ncc-section-body { padding:10px; }
                .ncc-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
                .ncc-grid.ncc-grid-3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
                .ncc-grid.ncc-grid-2 { grid-template-columns:repeat(2,minmax(0,1fr)); }
                .ncc-card { min-width:0; min-height:89px; padding:10px; border:1px solid #294961; border-radius:10px; background:linear-gradient(145deg,#12283b,#0e2031); }
                .ncc-card.clickable { cursor:pointer; transition:transform .12s ease,border-color .12s ease; }
                .ncc-card.clickable:hover { transform:translateY(-1px); border-color:#55ddbc; }
                .ncc-label { display:block; overflow:hidden; color:#8ca4b7; font-size:10px; font-weight:700; letter-spacing:.04em; text-overflow:ellipsis; text-transform:uppercase; white-space:nowrap; }
                .ncc-value { display:block; overflow:hidden; margin-top:6px; color:#ecf8fc; font-size:19px; font-weight:790; letter-spacing:-.025em; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-sub { display:block; overflow:hidden; margin-top:4px; color:#91a8b9; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-good { color:#67e3b3 !important; }
                .ncc-bad { color:#ff8993 !important; }
                .ncc-warn { color:#ffd477 !important; }
                .ncc-muted { color:#849aad !important; }
                .ncc-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-bottom:10px; }
                .ncc-button { min-height:31px; padding:6px 10px; border:1px solid #3b5c73; border-radius:7px; background:#162b3f; color:#d9e8f2; cursor:pointer; font-size:11px; font-weight:700; }
                .ncc-button:hover { border-color:#56dfbd; background:#19384a; }
                .ncc-button:disabled { cursor:wait; opacity:.55; }
                .ncc-primary { border-color:#43c8a8; background:#135547; color:#dcfff5; }
                .ncc-danger { border-color:#a75560; color:#ffc5ca; }
                .ncc-input, .ncc-select { min-height:31px; max-width:100%; padding:6px 8px; border:1px solid #36556c; border-radius:7px; outline:none; background:#0b1724; color:#deebf4; font-size:11px; }
                .ncc-priority-control { display:inline-flex; align-items:center; gap:6px; }
                .ncc-priority-control .ncc-icon { width:25px; height:25px; border-radius:6px; font-size:13px; }
                .ncc-input:focus, .ncc-select:focus { border-color:#57dbbc; box-shadow:0 0 0 2px #3ad5ac22; }
                .ncc-input[type="search"] { min-width:170px; }
                .ncc-check { display:flex; align-items:flex-start; gap:8px; color:#afc1ce; font-size:11px; line-height:1.35; }
                .ncc-check input { margin:2px 0 0; accent-color:#48dcb9; }
                .ncc-table-wrap { overflow-x:auto; overflow-y:hidden; border:1px solid #29465d; border-radius:8px; }
                .ncc-table { width:100%; border-collapse:collapse; font-size:10.5px; white-space:nowrap; }
                .ncc-team-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:7px; }
                .ncc-team-list { display:flex; flex-direction:column; gap:8px; }
                .ncc-team-card { min-width:0; min-height:90px; padding:7px; border:1px solid #294961; border-radius:8px; background:#0b1927; }
                .ncc-team-card.ncc-misplaced { border-color:#8b6d32; background:#2a251b; }
                .ncc-team-list .ncc-team-card { min-height:0; padding:10px 12px; }
                .ncc-team-list .ncc-team-line { margin-top:6px; font-size:11px; line-height:1.3; }
                .ncc-team-list .ncc-team-name { font-size:12px; }
                .ncc-team-list .ncc-team-meta, .ncc-team-list .ncc-team-assigned, .ncc-team-list .ncc-team-effects { font-size:10px; }
                .ncc-team-list .ncc-team-select { width:min(340px,58%); min-height:29px; font-size:10px; }
                .ncc-team-top, .ncc-team-line { display:flex; align-items:center; min-width:0; gap:5px; }
                .ncc-team-top input { flex:0 0 auto; margin:0; accent-color:#48dcb9; }
                .ncc-team-name { overflow:hidden; flex:1; color:#e6f3fa; font-size:10px; font-weight:800; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-team-meta { overflow:hidden; color:#849aad; font-size:9px; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-team-line { margin-top:4px; color:#b5c8d5; font-size:9px; line-height:1.15; }
                .ncc-team-current { overflow:hidden; flex:1; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-team-select { min-width:0; width:56%; min-height:25px; padding:3px 5px; font-size:9px; }
                .ncc-team-assigned { overflow:hidden; flex:1; color:#dcebf3; font-size:9px; font-weight:700; text-align:right; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-team-effects { overflow:hidden; color:#93aabb; font-size:9px; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-table th { position:sticky; top:0; z-index:1; padding:8px 8px; border-bottom:1px solid #35556c; background:#142b3e; color:#a9c2d2; font-size:9px; letter-spacing:.04em; text-align:left; text-transform:uppercase; }
                .ncc-table th[data-sort] { cursor:pointer; }
                .ncc-table th[data-sort]:hover { color:#dffcf4; }
                .ncc-table td { padding:8px; border-bottom:1px solid #1c354a; color:#d8e6ef; vertical-align:middle; }
                .ncc-table tr:last-child td { border-bottom:0; }
                .ncc-table tbody tr:hover { background:#12273a; }
                .ncc-table .ncc-own-row td { background:#133e43; color:#e3fff8; font-weight:700; }
                .ncc-table .ncc-misplaced td { background:#453c203d; }
                .ncc-table .ncc-unhealthy td { background:#4b202a42; }
                .ncc-pill { display:inline-flex; max-width:145px; align-items:center; gap:4px; overflow:hidden; padding:3px 6px; border:1px solid #3a566b; border-radius:999px; background:#13293b; color:#bed2df; font-size:9px; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-pill.good { border-color:#2c806c; color:#7ce5bd; }
                .ncc-pill.warn { border-color:#8b6d32; color:#ffd57d; }
                .ncc-pill.bad { border-color:#85424d; color:#ffafb6; }
                .ncc-kv { display:grid; grid-template-columns:minmax(115px,1fr) minmax(90px,1fr); gap:8px; padding:7px 0; border-bottom:1px solid #1d3549; font-size:11px; }
                .ncc-kv:last-child { border-bottom:0; }
                .ncc-kv span:first-child { color:#90a7b9; }
                .ncc-kv span:last-child { overflow:hidden; color:#e2eef4; font-weight:700; text-align:right; text-overflow:ellipsis; white-space:nowrap; }
                .ncc-bars { display:grid; gap:8px; }
                .ncc-bar-row { display:grid; grid-template-columns:80px 1fr 35px; align-items:center; gap:7px; color:#a6bdca; font-size:10px; }
                .ncc-bar { height:7px; overflow:hidden; border-radius:99px; background:#152e41; }
                .ncc-bar i { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,#45d2b0,#87e3a9); }
                .ncc-note { margin-top:8px; color:#8ea5b6; font-size:10px; line-height:1.45; }
                .ncc-notice { padding:10px; border:1px solid #395e75; border-radius:8px; background:#11283a; color:#b6d1df; font-size:11px; line-height:1.45; }
                .ncc-notice.warn { border-color:#896c37; background:#352d1b; color:#ffdf9d; }
                .ncc-notice.error { border-color:#85444d; background:#351d27; color:#ffbac1; }
                .ncc-empty { display:grid; min-height:260px; place-items:center; padding:30px; border:1px dashed #38566d; border-radius:12px; color:#99afbd; font-size:12px; text-align:center; }
                .ncc-inline { display:flex; align-items:center; flex-wrap:wrap; gap:7px; }
                .ncc-right { margin-left:auto; }
                .ncc-help { color:#7f98a9; font-size:10px; line-height:1.45; }
                .ncc-summary-strip { display:grid; grid-template-columns:repeat(6,minmax(120px,1fr)); overflow-x:auto; overflow-y:hidden; border:1px solid #2c5861; border-radius:9px; background:#103538; }
                .ncc-summary-strip > div { min-width:120px; padding:9px; border-right:1px solid #286064; }
                .ncc-summary-strip > div:last-child { border-right:0; }
                .ncc-summary-strip b { display:block; color:#e2fff7; font-size:14px; }
                .ncc-summary-strip small { display:block; margin-top:3px; color:#a7d8d0; font-size:9px; }
                .ncc-chart { width:100%; min-height:175px; overflow:hidden; border:1px solid #29465d; border-radius:9px; background:#0a1724; }
                .ncc-chart svg { display:block; width:100%; height:230px; }
                .ncc-chart-point { cursor:pointer; stroke:#0c1a29; stroke-width:2px; transition:r .12s ease,stroke .12s ease; }
                .ncc-chart-point:hover, .ncc-chart-point.selected { stroke:#e3fff8; }
                .ncc-trend-detail { margin-top:10px; }
                .ncc-trend-detail .ncc-kv { min-width:0; }
                .ncc-modal-backdrop { position:fixed; z-index:2147483647; inset:0; display:grid; place-items:center; padding:16px; background:#000a; }
                .ncc-modal { width:min(720px,100%); max-height:min(700px,calc(100vh - 32px)); overflow:auto; border:1px solid #46718a; border-radius:14px; background:#0c1a29; box-shadow:0 24px 72px #000c; }
                .ncc-modal-head { display:flex; align-items:center; gap:8px; padding:12px; border-bottom:1px solid #29475e; background:#12283a; }
                .ncc-modal-head h2 { flex:1; margin:0; color:#e3f8f2; font-size:13px; }
                .ncc-modal-body { padding:12px; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-tabs { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); overflow:visible; padding:7px; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-tab { min-width:0; padding:6px 3px; white-space:normal; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-section-head { flex-wrap:wrap; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-section-head > * { min-width:0; max-width:100%; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-grid, #${ROOT_ID}[data-compact-layout="true"] .ncc-grid.ncc-grid-2, #${ROOT_ID}[data-compact-layout="true"] .ncc-grid.ncc-grid-3 { grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr)); }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-summary-strip { grid-template-columns:repeat(auto-fit,minmax(min(120px,100%),1fr)); overflow:visible; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-summary-strip > div { min-width:0; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-toolbar { max-width:100%; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-toolbar > .ncc-button, #${ROOT_ID}[data-compact-layout="true"] .ncc-toolbar > button { min-width:0; flex:1 1 calc(50% - 4px); overflow-wrap:anywhere; white-space:normal; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-toolbar > .ncc-input, #${ROOT_ID}[data-compact-layout="true"] .ncc-toolbar > label { min-width:0; max-width:100%; flex:1 1 100%; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-wrap { overflow:visible; border:0; border-radius:0; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table, #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table thead, #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table tbody { display:block; width:100%; white-space:normal; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table thead tr { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:8px; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table th { position:static; min-width:0; flex:1 1 92px; padding:6px; border:1px solid #35556c; border-radius:6px; background:#142b3e; line-height:1.2; white-space:normal; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table tbody tr { display:block; margin:0 0 8px; padding:7px 9px; border:1px solid #29465d; border-radius:8px; background:#0b1927; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table tbody tr:last-child { margin-bottom:0; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table td { display:grid; grid-template-columns:minmax(102px,.9fr) minmax(0,1.1fr); gap:8px; min-width:0; padding:5px 0; border-bottom:1px solid #1c354a; overflow-wrap:anywhere; text-align:right; white-space:normal; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table td::before { align-self:start; color:#8ca4b7; content:attr(data-label); font-size:9px; font-weight:700; letter-spacing:.04em; text-align:left; text-transform:uppercase; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-stack-table td:last-child { border-bottom:0; }
                #${ROOT_ID}[data-runtime="mobile"] #ncc-panel { inset:max(4px, env(safe-area-inset-top)) 4px max(4px, env(safe-area-inset-bottom)) 4px !important; width:auto !important; height:auto !important; min-width:0; min-height:0; border-radius:11px; resize:none; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-resize-grip { display:none; }
                #${ROOT_ID}[data-runtime="mobile"] #ncc-launcher { top:max(10px, env(safe-area-inset-top)); right:10px; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-head { min-height:54px; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-grid, #${ROOT_ID}[data-runtime="mobile"] .ncc-grid.ncc-grid-2 { grid-template-columns:1fr; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-card { min-height:73px; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-value { font-size:18px; }
                #${ROOT_ID}[data-runtime="mobile"] #ncc-content { padding:9px; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-table { white-space:normal; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-table th, #${ROOT_ID}[data-runtime="mobile"] .ncc-table td { padding:8px 6px; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-input[type="search"] { min-width:130px; flex:1; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-summary-strip { grid-template-columns:repeat(auto-fit,minmax(min(120px,100%),1fr)); }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-team-grid { grid-template-columns:1fr; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-team-card { min-height:96px; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-team-select { width:60%; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-refresh-button { width:29px; padding:0; }
                #${ROOT_ID}[data-runtime="mobile"] .ncc-refresh-label { display:none; }
                @media (max-width: 820px) { .ncc-grid, .ncc-grid.ncc-grid-3 { grid-template-columns:repeat(2,minmax(0,1fr)); } .ncc-summary-strip { grid-template-columns:repeat(3,minmax(120px,1fr)); } .ncc-team-grid { grid-template-columns:repeat(3,minmax(0,1fr)); } }
                @media (max-width: 680px) { #ncc-panel { inset:max(4px, env(safe-area-inset-top)) 4px max(4px, env(safe-area-inset-bottom)) 4px !important; width:auto !important; height:auto !important; min-width:0; min-height:0; border-radius:11px; resize:none; } #ncc-launcher { top:max(10px, env(safe-area-inset-top)); right:10px; } .ncc-resize-grip { display:none; } .ncc-head { min-height:54px; } .ncc-grid, .ncc-grid.ncc-grid-2 { grid-template-columns:1fr; } .ncc-card { min-height:73px; } .ncc-value { font-size:18px; } #ncc-content { padding:9px; } .ncc-table { white-space:normal; } .ncc-table th, .ncc-table td { padding:8px 6px; } .ncc-input[type="search"] { min-width:130px; flex:1; } .ncc-summary-strip { grid-template-columns:repeat(2,minmax(120px,1fr)); } .ncc-team-grid { grid-template-columns:1fr; } .ncc-team-card { min-height:96px; } .ncc-team-select { width:60%; } .ncc-refresh-button { width:29px; padding:0; } .ncc-refresh-label { display:none; } }
            </style>
            <button id="ncc-launcher" class="ncc-hidden" type="button" aria-label="Open Naughty Company Companion">♜</button>
            <section id="ncc-panel" aria-label="Naughty Company Companion">
                <header class="ncc-head" id="ncc-drag-handle">
                    <div class="ncc-brand"><strong>Naughty Company Companion</strong><small id="ncc-status">Loading…</small></div>
                    <div class="ncc-head-actions">
                        <button class="ncc-button ncc-primary ncc-refresh-button" type="button" data-action="refresh" title="Refreshes Torn company profile, employees, stock, funds news, and applications">↻ <span class="ncc-refresh-label">Refresh Torn data</span></button>
                        <button class="ncc-icon" type="button" data-action="minimize" title="Minimize">—</button>
                    </div>
                </header>
                <nav class="ncc-tabs" id="ncc-tabs"></nav>
                <main id="ncc-content"></main>
                <button class="ncc-resize-grip ncc-resize-grip-left" type="button" aria-label="Resize panel from the bottom left" title="Resize panel"></button>
                <button class="ncc-resize-grip ncc-resize-grip-right" type="button" aria-label="Resize panel from the bottom right" title="Resize panel"></button>
            </section>
            <aside id="ncc-alert-toasts" aria-live="polite" aria-label="Company alerts"></aside>`;
        document.body.append(root);
        document.getElementById("ncc-launcher").addEventListener("click", () => toggleMinimized(false));
        bindDragAndResize();
        applyLayout();
    }

    function metricCard(label, value, sub = "", tone = "", action = "") {
        return `<article class="ncc-card ${action ? "clickable" : ""}" ${action ? `data-action="${action}"` : ""}><span class="ncc-label">${escapeHtml(label)}</span><strong class="ncc-value ${tone}">${escapeHtml(value)}</strong><span class="ncc-sub">${escapeHtml(sub)}</span></article>`;
    }

    function section(title, body, actions = "") {
        return `<section class="ncc-section"><header class="ncc-section-head"><h2>${escapeHtml(title)}</h2>${actions}</header><div class="ncc-section-body">${body}</div></section>`;
    }

    function dataNotice() {
        if (state.error) return `<div class="ncc-notice error">${escapeHtml(state.error)}</div>`;
        return "";
    }

    function rankingMetrics() {
        const id = String(state.data?.profile?.id || "");
        const record = state.rankings?.[id];
        if (!record?.companies?.length || !state.data?.profile) return null;
        return calculateRankingMetrics(record.companies, state.data.profile, state.starCohorts?.[id]?.counts);
    }

    function companyRankSummary(metrics, profile) {
        const ownId = String(profile?.id || "");
        const starLevel = ratingOf(profile);
        const starCompanies = (metrics?.ranked || []).filter((company) => ratingOf(company) === starLevel);
        const starIndex = starCompanies.findIndex((company) => String(company?.id || "") === ownId);
        return [
            { rank: starIndex >= 0 ? starIndex + 1 : metrics?.rank ?? null, total: starCompanies.length, label: `Current rank in ${formatNumber(starLevel)}★ star level` },
            { rank: metrics?.rank ?? null, total: metrics?.total ?? 0, label: "Current rank among same-type companies" }
        ];
    }

    function renderOverview() {
        const profile = state.data?.profile || {};
        const financesNow = financials();
        const monthly = monthMetrics();
        const rankings = rankingMetrics();
        const employees = employeeRows();
        const conditions = [
            ["Popularity", asNumber(profile.popularity)],
            ["Efficiency", asNumber(profile.efficiency)],
            ["Environment", asNumber(profile.environment)]
        ];
        const averageEfficiency = employees.length ? employees.reduce((sum, row) => sum + asNumber(row.currentEfficiency), 0) / employees.length : null;
        const profitTone = financesNow.dailyProfit === null ? "ncc-muted" : financesNow.dailyProfit >= 0 ? "ncc-good" : "ncc-bad";
        const monthlyIncome = monthly.useTrackedIncome ? monthly.trackedIncome : monthly.incomeForecast;
        const monthlyProfit = monthly.useTrackedProfit ? monthly.trackedProfit : monthly.profitForecast;
        const healthValue = rankings?.percentile === null || !rankings ? "Load" : formatPercent(rankings.percentile, 1);
        const healthSub = rankings ? `Income rank ${formatNumber(rankings.rank)} / ${formatNumber(rankings.total)}` : "Same-type weekly-income rank";
        const applications = Array.isArray(state.data?.applications) ? state.data.applications : [];
        const grid = `
            <div class="ncc-grid">
                ${metricCard("Company", profile.name || "Unknown", `${profile.type?.name || "Unknown type"} · ${formatNumber(profile.rating)}★`)}
                ${metricCard("Daily income", formatMoney(financesNow.dailyIncome), `${formatMoney(financesNow.weeklyIncome)} weekly`, "ncc-good")}
                ${metricCard("Daily Profit", formatMoney(financesNow.dailyProfit), financesNow.canProfit ? `${formatMoney(financesNow.weeklyProfit)} weekly` : financesNow.canProfitWeekly ? `${formatMoney(financesNow.weeklyProfit)} weekly · stock unavailable` : "Needs full wages + ad budget", profitTone)}
                ${metricCard("Health score", healthValue, healthSub, rankings ? "ncc-good" : "ncc-muted", rankings ? "show-health" : "load-rankings")}
                ${metricCard("30-day income", formatMoney(monthlyIncome), monthly.useTrackedIncome ? `${monthly.coverage}/30 tracked days` : `${monthly.coverage}/30 tracked · forecast`, "ncc-good")}
                ${metricCard("30-day Profit", formatMoney(monthlyProfit), monthlyProfit === null ? "Needs profit access" : monthly.useTrackedProfit ? `${monthly.profitCoverage}/30 tracked days` : `${monthly.profitCoverage}/30 tracked · forecast`, monthlyProfit !== null && monthlyProfit >= 0 ? "ncc-good" : monthlyProfit === null ? "ncc-muted" : "ncc-bad")}
                ${metricCard("Workforce", `${formatNumber(profile.employees?.hired)} / ${formatNumber(profile.employees?.capacity)}`, averageEfficiency === null ? "Employee details unavailable" : `Avg effectiveness ${formatNumber(averageEfficiency, 1)}`)}
                ${metricCard("Company cash", formatMoney(profile.funds), `Value ${formatMoney(profile.value)}`)}
            </div>`;
        const rankBody = rankings ? `
            <div class="ncc-summary-strip">
                <div><b>${formatNumber(rankings.rank)}</b><small>Income rank / ${formatNumber(rankings.total)}</small></div>
                <div><b>${rankings.nextStar ? `${rankings.nextStar}★` : "—"}</b><small>Next star target</small></div>
                <div><b class="${rankings.nextGap === 0 ? "ncc-good" : "ncc-warn"}">${formatMoney(rankings.nextGap)}</b><small>Weekly gap to next star</small></div>
                <div><b>${rankings.previousStar ? `${rankings.previousStar}★` : "—"}</b><small>Previous star band</small></div>
                <div><b class="ncc-good">${formatMoney(rankings.previousBuffer)}</b><small>Weekly buffer to previous</small></div>
                <div><b>${formatPercent(rankings.percentile, 1)}</b><small>Health score / income percentile</small></div>
            </div>
            <p class="ncc-note">Star gaps are observed weekly-income cutoffs using the current star-slot distribution. They are a projection, not Torn’s published rating formula.</p>` : `<div class="ncc-notice">Load all ${escapeHtml(profile.type?.name || "same-type")} companies to calculate your weekly-income rank, health score, and observed star gaps.</div>`;
        const conditionBody = `
            <div class="ncc-bars">${conditions.map(([label, value]) => `<div class="ncc-bar-row"><span>${label}</span><div class="ncc-bar"><i style="width:${clamp(value, 0, 100)}%"></i></div><b>${formatNumber(value)}</b></div>`).join("")}</div>
            <div class="ncc-grid ncc-grid-3" style="margin-top:10px;">
                ${metricCard("Trains", formatNumber(profile.trains), "Available company trains")}
                ${metricCard("Ad budget", formatMoney(profile.advertisement_budget), "Daily operating cost")}
                ${metricCard("Applications", formatNumber(applications.length), applications.length ? "Pending applicants" : "No pending applications")}
            </div>`;
        const recentNews = (state.data?.news || []).slice(0, 4).map((item) => `<div class="ncc-kv"><span>${escapeHtml(formatDateTime(asNumber(item.timestamp) * 1000))}</span><span title="${escapeHtml(item.text || "")}">${escapeHtml(String(item.text || "No details").replace(/<[^>]*>/g, ""))}</span></div>`).join("") || `<span class="ncc-muted">Funds news requires a Limited or higher key.</span>`;
        return `${dataNotice()}${grid}${section("Income rank & star outlook", rankBody, `<button class="ncc-button ncc-primary" data-action="load-rankings" title="Loads every same-type company from Torn and recalculates rank, health score, and star-gap values" ${state.rankingLoading ? "disabled" : ""}>${state.rankingLoading ? "Loading same-type rankings…" : rankings ? "Refresh all same-type rankings" : "Load all same-type rankings"}</button>`)}<div class="ncc-grid ncc-grid-2">${section("Company condition", conditionBody)}${section("Recent funds news", recentNews)}</div><p class="ncc-note">Income is supplied by Torn. Profit is calculated as: daily income − sold stock cost − ads − wages; weekly profit excludes stock cost because Torn exposes sold stock as a daily value. Monthly values become tracked totals after enough local daily snapshots.</p>`;
    }

    function sortHeader(label, key, group) {
        const sort = state.sort[group];
        const marker = sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
        return `<th data-sort="${group}:${key}">${escapeHtml(label)}${marker}</th>`;
    }

    function stackCell(label, value, className = "") {
        return `<td data-label="${escapeHtml(label)}"${className ? ` class="${className}"` : ""}>${value}</td>`;
    }

    function renderTeam() {
        const positions = projectionPositions();
        const mode = currentRuntimeMode();
        const filter = state.teamFilter.trim().toLowerCase();
        let rows = employeeRows().filter((row) => !filter || `${row.name} ${row.currentPosition} ${row.status}`.toLowerCase().includes(filter));
        rows = sortRows(rows, { key: (row) => ({ total: row.currentEfficiency, assignedPosition: row.assignedPosition, assignedEfficiency: row.assignedEfficiency, wage: row.wage, name: row.name, days: row.days, addiction: row.addiction, inactivity: row.inactivity, position: row.currentPosition, best: row.bestPosition }[state.sort.team.key]), dir: state.sort.team.dir });
        const selectOptions = (row) => [...new Set([row.currentPosition, ...positions].filter(Boolean))].map((position) => `<option value="${escapeHtml(position)}" ${position === row.assignedPosition ? "selected" : ""}>${escapeHtml(position)}</option>`).join("");
        const table = rows.length ? `<div class="${mode === "desktop" ? "ncc-team-list" : "ncc-team-grid"}">${rows.map((row) => {
            const misplaced = row.assignedPosition && row.currentPosition && row.assignedPosition !== row.currentPosition;
            const lastAction = row.lastAction ? timeAgo(row.lastAction * 1000) : "—";
            return `<article class="ncc-team-card ${misplaced ? "ncc-misplaced" : ""}"><div class="ncc-team-top"><input type="checkbox" data-lock-employee="${row.id}" ${row.locked ? "checked" : ""} title="Lock: keep this employee in their current position during auto-assign"><b class="ncc-team-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</b><span class="ncc-team-meta">${escapeHtml(row.status)} · ${formatOptionalNumber(row.days)}d</span></div><div class="ncc-team-line"><span class="ncc-team-current" title="Current position and preferred TornStats total effectiveness"><b>Current:</b> ${escapeHtml(row.currentPosition || "—")} · ${formatOptionalNumber(row.currentEfficiency, 1)}</span><span class="ncc-team-meta">${escapeHtml(row.currentEfficiencySource)}</span></div><div class="ncc-team-line"><select class="ncc-select ncc-team-select" data-assignment="${row.id}" title="Assigned position for this local projection" ${positions.length ? "" : "disabled"}>${selectOptions(row) || "<option>Load projections</option>"}</select><span class="ncc-team-assigned" title="Assigned efficiency"><b>Assigned:</b> ${formatOptionalNumber(row.assignedEfficiency, 1)} · ${formatSignedNumber(row.nonWorkingDelta)}</span></div><div class="ncc-team-line ncc-team-effects"><span class="${asNumber(row.addiction) < 0 ? "ncc-bad" : ""}">Addiction ${formatSignedNumber(row.addiction)}</span><span class="${asNumber(row.inactivity) < 0 ? "ncc-bad" : ""}">Inactivity ${formatSignedNumber(row.inactivity)}</span><span title="Best-fit projected position">Best ${escapeHtml(row.bestPosition || "—")} ${formatOptionalNumber(row.bestEfficiency, 1)}</span></div><div class="ncc-team-line ncc-team-effects"><span>Wage ${formatMoney(row.wage, true)} · Last action ${escapeHtml(lastAction)}</span></div></article>`;
        }).join("")}</div>` : `<div class="ncc-notice">No employee rows match the filter, or employee details are not available for this API key.</div>`;
        const values = rows.map((row) => row.currentEfficiency).filter((value) => value !== null);
        const affected = rows.filter((row) => asNumber(row.addiction) < 0 || asNumber(row.inactivity) < 0).length;
        const runtimeLabel = nativeRuntime.isTornPDA
            ? "TornPDA (native confirmed) / compact cards"
            : tornPdaUserAgent(currentUserAgent())
                ? "TornPDA (awaiting native confirmation) / compact cards"
                : mode === "mobile" ? "Compact viewport cards" : "Desktop detailed list";
        return `${dataNotice()}<div class="ncc-toolbar"><input class="ncc-input" id="ncc-team-filter" type="search" value="${escapeHtml(state.teamFilter)}" placeholder="Filter employee or role"><button class="ncc-button ncc-primary" data-action="load-projections" title="Sends work-stat triplets to TornStats (only after consent) and refreshes each employee’s role efficiency options" ${state.projectionLoading ? "disabled" : ""}>${state.projectionLoading ? "Calculating role projections…" : "Calculate TornStats role projections"}</button><button class="ncc-button" data-tab="planner">Open capacity planner</button><span class="ncc-help">${runtimeLabel} · ${formatNumber(rows.length)} staff · ${formatNumber(state.data?.profile?.employees?.capacity)} capacity · Avg. ${values.length ? formatNumber(values.reduce((sum, value) => sum + asNumber(value), 0) / values.length, 1) : "—"} effectiveness · ${formatNumber(affected)} with penalties</span></div>${section("Employee efficiency", table)}<p class="ncc-note">Current Eff. and assigned efficiency use TornStats role base + Torn’s non-working-stat effect delta when available; Torn’s direct total is only the fallback before projections load.</p>`;
    }

    function formatSignedNumber(value, digits = 1) {
        const number = asFinite(value);
        if (number === null) return "—";
        return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`;
    }

    function renderPlanner() {
        const rows = employeeRows();
        const positions = projectionPositions();
        const settings = currentCompanySettings();
        const assignments = calculateAssignmentPreview(rows, settings);
        const orderedPositions = orderedPriorityPositions(positions, settings.priority);
        const maxQty = Math.max(1, Math.floor(asNumber(state.data?.profile?.employees?.capacity, rows.length || 1)));
        const capacityRows = positions.length ? `<div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr><th>Position</th><th>Max qty</th><th>Priority</th><th>Occupied</th></tr></thead><tbody>${orderedPositions.map((position, index) => `<tr>${stackCell("Position", `<b>${escapeHtml(position)}</b>`)}${stackCell("Max qty", `<select class="ncc-select" data-capacity="${escapeHtml(position)}"><option value="0" ${asNumber(settings.capacities[position]) === 0 ? "selected" : ""}>Uncapped</option>${Array.from({ length: maxQty }, (_, quantity) => quantity + 1).map((quantity) => `<option value="${quantity}" ${asNumber(settings.capacities[position]) === quantity ? "selected" : ""}>${quantity}</option>`).join("")}</select>`)}${stackCell("Priority", `<span class="ncc-priority-control"><button class="ncc-icon" data-action="priority-up" data-position="${escapeHtml(position)}" title="Move ${escapeHtml(position)} up" ${index === 0 ? "disabled" : ""}>↑</button><b>${index + 1}</b><button class="ncc-icon" data-action="priority-down" data-position="${escapeHtml(position)}" title="Move ${escapeHtml(position)} down" ${index === orderedPositions.length - 1 ? "disabled" : ""}>↓</button></span>`)}${stackCell("Occupied", formatNumber(assignments.occupied[position] || 0))}</tr>`).join("")}</tbody></table></div>` : `<div class="ncc-notice warn">Load per-employee TornStats projections first. Position names are intentionally discovered from the matching company-type response rather than hard-coded.</div>`;
        const previewRows = sortRows(rows.map((row) => {
            const hasSavedAssignment = Object.prototype.hasOwnProperty.call(settings.assignments || {}, row.id);
            const assigned = hasSavedAssignment ? settings.assignments[row.id] : row.currentPosition;
            const base = row.projected?.[assigned];
            const projected = base === undefined ? null : asNumber(base) + row.nonWorkingDelta;
            const change = projected === null || row.currentEfficiency === null ? null : projected - row.currentEfficiency;
            return { ...row, previewAssigned: assigned, previewEfficiency: projected, previewChange: change };
        }), { key: (row) => ({ name: row.name, current: row.currentPosition, assigned: row.previewAssigned, currentEfficiency: row.currentEfficiency, assignedEfficiency: row.previewEfficiency, change: row.previewChange, lock: row.locked ? 1 : 0 }[state.sort.planner.key]), dir: state.sort.planner.dir });
        const rowsTable = previewRows.length ? `<div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr>${sortHeader("Employee", "name", "planner")}${sortHeader("Current", "current", "planner")}${sortHeader("Assigned", "assigned", "planner")}${sortHeader("Current eff.", "currentEfficiency", "planner")}${sortHeader("Assigned eff.", "assignedEfficiency", "planner")}${sortHeader("Change", "change", "planner")}${sortHeader("Lock", "lock", "planner")}</tr></thead><tbody>${previewRows.map((row) => `<tr class="${row.previewAssigned !== row.currentPosition ? "ncc-misplaced" : ""}">${stackCell("Employee", `<b>${escapeHtml(row.name)}</b>`)}${stackCell("Current", escapeHtml(row.currentPosition || "—"))}${stackCell("Assigned", escapeHtml(row.previewAssigned || "Unassigned"))}${stackCell("Current eff.", formatOptionalNumber(row.currentEfficiency, 1))}${stackCell("Assigned eff.", formatOptionalNumber(row.previewEfficiency, 1), row.previewChange !== null && row.previewChange > 0 ? "ncc-good" : row.previewChange !== null && row.previewChange < 0 ? "ncc-bad" : "")}${stackCell("Change", formatSignedNumber(row.previewChange))}${stackCell("Lock", row.locked ? "Locked" : "Flexible")}</tr>`).join("")}</tbody></table></div>` : "";
        const warnings = assignments.lockedOverages.map(([position, used]) => `${formatNumber(used)} locked employees exceed ${escapeHtml(position)}’s maximum.`).join(" ");
        return `${dataNotice()}<div class="ncc-toolbar"><button class="ncc-button" data-action="save-planner" ${positions.length ? "" : "disabled"}>Save max quantities</button><button class="ncc-button ncc-primary" data-action="auto-assign" ${positions.length ? "" : "disabled"}>Auto-assign unlocked staff</button><button class="ncc-button" data-action="load-projections" title="Refreshes TornStats role-efficiency choices for every employee after consent" ${state.projectionLoading ? "disabled" : ""}>${state.projectionLoading ? "Calculating…" : "Refresh TornStats role projections"}</button><span class="ncc-help">Priority is saved immediately. The top role fills first; choose Uncapped or 1–${formatNumber(maxQty)} for Max Qty.</span></div>${section("Position capacity & priority", capacityRows)}${warnings ? `<div class="ncc-notice warn">${warnings}</div>` : ""}${section("Assignment preview", rowsTable)}<p class="ncc-note">Auto assignment keeps locked employees in their current seats, then greedily fills positions by priority with the highest remaining base efficiency while respecting configured role caps and total company capacity. It only saves a local plan.</p>`;
    }

    function orderedPriorityPositions(positions, priority = []) {
        return [...priority.filter((position) => positions.includes(position)), ...positions.filter((position) => !priority.includes(position))];
    }

    async function movePlannerPriority(position, direction) {
        const settings = currentCompanySettings();
        const ordered = orderedPriorityPositions(projectionPositions(), settings.priority);
        const index = ordered.indexOf(position);
        const next = index + direction;
        if (index < 0 || next < 0 || next >= ordered.length || !settings.id) return;
        [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
        state.settings.positionPriority[settings.id] = ordered;
        await saveSettings({ positionPriority: state.settings.positionPriority });
        state.status = "Position priority saved.";
        render();
    }

    function calculateAssignmentPreview(rows = employeeRows(), settings = currentCompanySettings()) {
        const assigned = {};
        const occupied = {};
        rows.forEach((row) => {
            const hasSavedAssignment = Object.prototype.hasOwnProperty.call(settings.assignments || {}, row.id);
            const position = hasSavedAssignment ? settings.assignments[row.id] : row.currentPosition;
            if (!position) return;
            assigned[row.id] = position;
            occupied[position] = (occupied[position] || 0) + 1;
        });
        const lockedOverages = Object.entries(occupied).filter(([position, used]) => asNumber(settings.capacities?.[position]) > 0 && used > asNumber(settings.capacities[position]));
        return { assigned, occupied, lockedOverages, unassigned: rows.filter((row) => !assigned[row.id]) };
    }

    function renderRankings() {
        const profile = state.data?.profile || {};
        const metrics = rankingMetrics();
        if (!metrics) {
            return `${dataNotice()}${section("Company rankings", `<div class="ncc-empty"><div><p>Load all ${escapeHtml(profile.type?.name || "same-type")} companies to see your weekly-income rank, health score, star thresholds, and nearest competitors.</p><button class="ncc-button ncc-primary" data-action="load-rankings" ${state.rankingLoading ? "disabled" : ""}>${state.rankingLoading ? "Loading rankings…" : "Load company rankings"}</button></div></div>`)}<p class="ncc-note">Torn returns at most 100 companies per request. The companion follows pagination, deduplicates rows, and then sorts locally by weekly income.</p>`;
        }
        const id = String(profile.id || "");
        const record = state.rankings[id];
        const priorRank = asFinite(record?.previousRank);
        const change = priorRank === null || metrics.rank === null ? "First observed" : priorRank === metrics.rank ? "No rank change" : metrics.rank < priorRank ? `▲ ${priorRank - metrics.rank} since prior check` : `▼ ${metrics.rank - priorRank} since prior check`;
        const filter = state.rankingsFilter.trim().toLowerCase();
        let rows = metrics.ranked.map((company, index) => ({ ...company, rank: index + 1, weekly: incomeOf(company), daily: incomeOf(company, "daily"), rating: ratingOf(company), own: String(company.id) === id }));
        rows = rows.filter((row) => !filter || `${row.name} ${row.rank} ${row.rating}`.toLowerCase().includes(filter));
        const keyMap = { rank: "rank", name: "name", rating: "rating", daily: "daily", weekly: "weekly" };
        rows = sortRows(rows, { key: keyMap[state.sort.rankings.key] || "rank", dir: state.sort.rankings.dir });
        const shown = rows.slice(0, 500);
        const slotSource = state.starCohorts?.[id]?.source === "post-reset" ? "Sunday post-reset slot snapshot" : "first observed this Torn week";
        const rankContext = companyRankSummary(metrics, profile).map((field) => `<div><b>${formatNumber(field.rank)} / ${formatNumber(field.total)}</b><small>${escapeHtml(field.label)}</small></div>`).join("");
        const strip = `<div class="ncc-summary-strip">${rankContext}<div><b>${formatMoney(incomeOf(profile))}</b><small>Weekly income</small></div><div><b class="${metrics.nextGap === 0 ? "ncc-good" : "ncc-warn"}">${formatMoney(metrics.nextGap)}</b><small>Gap to ${metrics.nextStar || "next"}★</small></div><div><b class="ncc-good">${formatMoney(metrics.previousBuffer)}</b><small>Buffer to ${metrics.previousStar || "previous"}★</small></div><div><b>${formatPercent(metrics.percentile, 1)}</b><small>Health score / income rank</small></div><div><b class="${change.startsWith("▲") ? "ncc-good" : change.startsWith("▼") ? "ncc-bad" : ""}">${escapeHtml(change.split(" ")[0])}</b><small>${escapeHtml(change)}</small></div></div>`;
        const table = `<div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr>${sortHeader("Rank", "rank", "rankings")}${sortHeader("Company", "name", "rankings")}${sortHeader("Rating", "rating", "rankings")}${sortHeader("Daily income", "daily", "rankings")}${sortHeader("Weekly income", "weekly", "rankings")}</tr></thead><tbody>${shown.map((row) => `<tr class="${row.own ? "ncc-own-row" : ""}">${stackCell("Rank", formatNumber(row.rank))}${stackCell("Company", `<b>${escapeHtml(row.name || "Unknown")}</b>${row.own ? " <span class=\"ncc-pill good\">Your company</span>" : ""}`)}${stackCell("Rating", `${formatNumber(row.rating)}★`)}${stackCell("Daily income", formatMoney(row.daily, true))}${stackCell("Weekly income", formatMoney(row.weekly, true))}</tr>`).join("")}</tbody></table></div>`;
        return `${dataNotice()}<div class="ncc-toolbar"><input class="ncc-input" id="ncc-rankings-filter" type="search" value="${escapeHtml(state.rankingsFilter)}" placeholder="Filter company or rank"><button class="ncc-button ncc-primary" data-action="load-rankings" title="Reloads all same-type Torn companies, then recalculates rank and star gaps" ${state.rankingLoading ? "disabled" : ""}>${state.rankingLoading ? "Loading same-type rankings…" : "Refresh all same-type rankings"}</button><button class="ncc-button" data-action="show-health">View rank neighbors</button><span class="ncc-help">Updated ${timeAgo(record.fetchedAt)} · ${formatNumber(metrics.total)} companies</span></div>${section("Your company", `${strip}<p class="ncc-note">Health score is your weekly-income percentile among the same company type. Star slots use a ${slotSource}; the income gaps are observed planning values, not official Torn thresholds.</p>`)}${section("Same-type companies", `${table}${rows.length > shown.length ? `<p class="ncc-note">Showing the first ${formatNumber(shown.length)} filtered companies.</p>` : ""}`)}`;
    }

    function stockMetrics() {
        const stock = Array.isArray(state.data?.stock) ? state.data.stock : [];
        return stock.reduce((totals, item) => {
            const inStock = asNumber(item.in_stock);
            const onOrder = asNumber(item.on_order);
            const cost = asNumber(item.cost);
            const price = asNumber(item.price);
            const sold = asNumber(item.sold_amount);
            const soldWorth = asNumber(item.sold_worth);
            totals.items += 1;
            totals.inStock += inStock;
            totals.onOrder += onOrder;
            totals.costValue += inStock * cost;
            totals.saleValue += inStock * price;
            totals.soldCost += sold * cost;
            totals.soldWorth += soldWorth;
            totals.margin += soldWorth - sold * cost;
            return totals;
        }, { items: 0, inStock: 0, onOrder: 0, costValue: 0, saleValue: 0, soldCost: 0, soldWorth: 0, margin: 0 });
    }

    function previousStockSnapshot(history = companyHistory(), period = reportingPeriod()) {
        return [...history]
            .filter((entry) => entry.period < period && isObject(entry.stock))
            .sort((left, right) => right.period - left.period)[0]?.stock || null;
    }

    function stockDifference(item, previous = previousStockSnapshot()) {
        const prior = previous?.[String(item?.id)];
        return prior ? asNumber(item?.in_stock) - asNumber(prior.inStock) : null;
    }

    function currentStockWorth(item) {
        return asNumber(item?.in_stock) * asNumber(item?.price);
    }

    function renderStock() {
        const totals = stockMetrics();
        const previous = previousStockSnapshot();
        let rows = Array.isArray(state.data?.stock) ? [...state.data.stock] : [];
        const sort = state.sort.stock;
        rows = sortRows(rows, { key: (item) => sort.key === "margin" ? asNumber(item.sold_worth) - asNumber(item.cost) * asNumber(item.sold_amount) : sort.key === "difference" ? stockDifference(item, previous) : sort.key === "current_worth" ? currentStockWorth(item) : item[sort.key], dir: sort.dir });
        const table = rows.length ? `<div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr>${sortHeader("Item", "name", "stock")}${sortHeader("In stock", "in_stock", "stock")}${sortHeader("Current stock worth", "current_worth", "stock")}${sortHeader("Stock difference", "difference", "stock")}${sortHeader("On order", "on_order", "stock")}${sortHeader("Cost", "cost", "stock")}${sortHeader("Price", "price", "stock")}${sortHeader("Sold", "sold_amount", "stock")}${sortHeader("Sold worth", "sold_worth", "stock")}${sortHeader("Gross margin", "margin", "stock")}</tr></thead><tbody>${rows.map((item) => {
            const margin = asNumber(item.sold_worth) - asNumber(item.cost) * asNumber(item.sold_amount);
            const difference = stockDifference(item, previous);
            return `<tr>${stackCell("Item", `<b>${escapeHtml(item.name || "Unknown")}</b><br><span class="ncc-muted">ID ${formatNumber(item.id)}</span>`)}${stackCell("In stock", formatNumber(item.in_stock))}${stackCell("Current stock worth", formatMoney(currentStockWorth(item)), "ncc-good")}${stackCell("Stock difference", difference === null ? "—" : formatSignedNumber(difference), difference === null ? "ncc-muted" : difference > 0 ? "ncc-good" : difference < 0 ? "ncc-bad" : "")}${stackCell("On order", formatNumber(item.on_order))}${stackCell("Cost", formatMoney(item.cost))}${stackCell("Price", formatMoney(item.price))}${stackCell("Sold", formatNumber(item.sold_amount))}${stackCell("Sold worth", formatMoney(item.sold_worth))}${stackCell("Gross margin", formatMoney(margin), margin >= 0 ? "ncc-good" : "ncc-bad")}</tr>`;
        }).join("")}</tbody></table></div>` : `<div class="ncc-notice warn">Stock details require a Limited or higher Torn API key.</div>`;
        return `${dataNotice()}<div class="ncc-grid ncc-grid-3">${metricCard("Stock items", formatNumber(totals.inStock), `${formatNumber(totals.onOrder)} on order`)}${metricCard("Stock value", formatMoney(totals.saleValue), `${formatMoney(totals.costValue)} at cost`, "ncc-good")}${metricCard("Reported gross margin", formatMoney(totals.margin), `${formatMoney(totals.soldWorth)} sold worth`, totals.margin >= 0 ? "ncc-good" : "ncc-bad")}</div>${section("Stock & sales", table)}<p class="ncc-note">Stock difference is today’s in-stock amount minus the last local Torn reporting-day snapshot. It appears after a prior daily snapshot exists. Reported gross margin = sold worth − (cost × sold amount).</p>`;
    }

    function trendNumber(value) {
        return value === null || value === undefined || value === "" ? null : asFinite(value);
    }

    function trendChartDefinition(type = "income-profit") {
        const charts = {
            "income-profit": {
                id: "income-profit",
                label: "Income & Profit",
                axisLabel: "Daily cash value",
                zeroBaseline: true,
                unavailable: "Daily Income is captured from Torn; Daily Profit is calculated locally from that reporting-day snapshot when its inputs are available.",
                series: [
                    { key: "dailyIncome", label: "Daily income", color: "#55ddb8", format: "money", tone: "good" },
                    { key: "dailyProfit", label: "Daily profit", color: "#69aef7", format: "money" }
                ]
            },
            stock: {
                id: "stock",
                label: "Stock",
                axisLabel: "Current stock worth",
                zeroBaseline: true,
                unavailable: "Stock worth is captured only when Torn stock details are available at the local reporting-day snapshot.",
                series: [
                    { key: "stockValue", label: "Current stock worth", color: "#f4bf63", format: "money", tone: "warn" }
                ],
                detail: (row) => [{ label: "In-stock quantity", value: trendNumber(row?.stockQuantity) === null ? "Unavailable" : formatNumber(row.stockQuantity) }]
            },
            effectiveness: {
                id: "effectiveness",
                label: "Average employee effectiveness",
                axisLabel: "Effectiveness",
                unavailable: "Average employee effectiveness is captured only when employee details are available at the local reporting-day snapshot.",
                series: [
                    { key: "averageEmployeeEfficiency", label: "Avg employee effectiveness", color: "#b18cff", format: "effectiveness" }
                ]
            },
            ranking: {
                id: "ranking",
                label: "Ranking history",
                axisLabel: "Company rank (1 is best)",
                invertY: true,
                unavailable: "Company rank is captured after same-type rankings finish loading. It is never inferred from a current ranking or an older ranking cache.",
                series: [
                    { key: "companyRank", label: "Company rank", color: "#ff8fb1", format: "rank" }
                ],
                detail: (row) => {
                    const total = trendNumber(row?.companyRankTotal);
                    return total === null ? [] : [{ label: "Same-type companies", value: formatNumber(total) }];
                }
            }
        };
        return charts[type] || charts["income-profit"];
    }

    function formatTrendValue(value, series) {
        const numeric = trendNumber(value);
        if (numeric === null) return "Unavailable";
        if (series.format === "money") return formatMoney(numeric, true);
        if (series.format === "effectiveness") return formatNumber(numeric, 1);
        if (series.format === "rank") return `#${formatNumber(numeric)}`;
        return formatNumber(numeric);
    }

    function trendPointTooltip(row, type = "income-profit") {
        const chart = trendChartDefinition(type);
        const lines = [formatDateTime(row?.period), ...chart.series.map((series) => `${series.label}: ${formatTrendValue(row?.[series.key], series)}`)];
        (chart.detail?.(row) || []).forEach((detail) => lines.push(`${detail.label}: ${detail.value}`));
        return lines.join("\n");
    }

    function trendChartAvailability(history, type = "income-profit") {
        const chart = trendChartDefinition(type);
        const rows = Array.isArray(history) ? history.slice(-30) : [];
        const series = chart.series.map((item) => ({ key: item.key, label: item.label, dataPoints: rows.filter((row) => trendNumber(row?.[item.key]) !== null).length }));
        return { id: chart.id, label: chart.label, rowCount: rows.length, dataRows: rows.filter((row) => chart.series.some((item) => trendNumber(row?.[item.key]) !== null)).length, series };
    }

    function trendPerformance(row, prior) {
        if (!prior) return { label: "Baseline", tone: "ncc-muted", detail: "First recorded day" };
        const checks = [[row.dailyIncome, prior.dailyIncome], [row.stockValue, prior.stockValue], [row.averageEmployeeEfficiency, prior.averageEmployeeEfficiency], [row.rating, prior.rating]];
        const score = checks.reduce((total, [current, previous]) => {
            const a = trendNumber(current);
            const b = trendNumber(previous);
            return a === null || b === null || a === b ? total : total + (a > b ? 1 : -1);
        }, 0);
        return score > 0 ? { label: "Improving", tone: "ncc-good", detail: `${score} positive daily signals` } : score < 0 ? { label: "Declining", tone: "ncc-bad", detail: `${Math.abs(score)} negative daily signals` } : { label: "Mixed / steady", tone: "ncc-warn", detail: "No net daily signal change" };
    }

    function trendDetail(row, prior) {
        const performance = trendPerformance(row, prior);
        const stockValue = trendNumber(row.stockValue);
        const stockQuantity = trendNumber(row.stockQuantity);
        const averageEfficiency = trendNumber(row.averageEmployeeEfficiency);
        const rank = trendNumber(row.companyRank);
        const rankTotal = trendNumber(row.companyRankTotal);
        const dailyProfit = trendNumber(row.dailyProfit);
        return `<div class="ncc-grid ncc-grid-3 ncc-trend-detail"><div class="ncc-kv"><span>Daily income</span><span>${trendNumber(row.dailyIncome) === null ? "—" : formatMoney(row.dailyIncome)}</span></div><div class="ncc-kv"><span>Stock</span><span>${stockValue === null ? "Unavailable" : `${formatMoney(stockValue, true)} · ${stockQuantity === null ? "—" : formatNumber(stockQuantity)} qty`}</span></div><div class="ncc-kv"><span>Avg employee eff.</span><span>${averageEfficiency === null ? "—" : formatNumber(averageEfficiency, 1)}</span></div><div class="ncc-kv"><span>Star level</span><span>${trendNumber(row.rating) === null ? "—" : `${formatNumber(row.rating)}★`}</span></div><div class="ncc-kv"><span>Daily profit</span><span class="${dailyProfit === null ? "ncc-muted" : dailyProfit >= 0 ? "ncc-good" : "ncc-bad"}">${dailyProfit === null ? "—" : formatMoney(dailyProfit)}</span></div><div class="ncc-kv"><span>Company rank</span><span>${rank === null ? "Unavailable" : `${formatNumber(rank)}${rankTotal === null ? "" : ` / ${formatNumber(rankTotal)}`}`}</span></div><div class="ncc-kv"><span>Performance vs previous day</span><span class="${performance.tone}">${performance.label}</span></div></div><p class="ncc-note">${escapeHtml(formatDateTime(row.period))} · ${escapeHtml(performance.detail)}. Hover any chart point for daily values, or select one to compare that day with its prior local snapshot.</p>`;
    }

    function trendLineSegments(rows, key, x, y) {
        const segments = [];
        let current = [];
        rows.forEach((row, index) => {
            const value = trendNumber(row?.[key]);
            if (value === null) {
                if (current.length) segments.push(current);
                current = [];
                return;
            }
            current.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`);
        });
        if (current.length) segments.push(current);
        return segments;
    }

    function trendSvg(history, type = state.selectedTrendChart) {
        const chart = trendChartDefinition(type);
        const rows = Array.isArray(history) ? history.slice(-30) : [];
        const availability = trendChartAvailability(rows, chart.id);
        if (availability.dataRows < 2) {
            const reason = availability.dataRows
                ? `Only ${formatNumber(availability.dataRows)} local snapshot with ${chart.label.toLowerCase()} data is available; at least two are required for a line.`
                : `No retained local snapshot contains ${chart.label.toLowerCase()} data yet.`;
            return `<div class="ncc-empty"><div><b>${escapeHtml(chart.label)} history is unavailable.</b><p>${escapeHtml(reason)} ${escapeHtml(chart.unavailable)}</p></div></div>`;
        }
        const hasValue = (row) => chart.series.some((series) => trendNumber(row?.[series.key]) !== null);
        const selectedCandidate = rows.find((row) => row.period === state.selectedTrendPeriod);
        const selected = selectedCandidate && hasValue(selectedCandidate) ? selectedCandidate : [...rows].reverse().find(hasValue);
        const selectedIndex = rows.findIndex((row) => row.period === selected.period);
        const prior = selectedIndex > 0 ? rows[selectedIndex - 1] : null;
        const values = rows.flatMap((row) => chart.series.map((series) => trendNumber(row?.[series.key]))).filter((value) => value !== null);
        const rawMin = Math.min(...values);
        const rawMax = Math.max(...values);
        const padding = Math.max(1, Math.abs(rawMax - rawMin) * 0.1, Math.abs(rawMax) * 0.02);
        const min = chart.zeroBaseline ? Math.min(0, rawMin) : chart.invertY ? Math.max(1, rawMin - padding) : rawMin - padding;
        const max = chart.zeroBaseline ? Math.max(1, rawMax) : rawMax + padding;
        const width = 700;
        const height = 230;
        const left = 68;
        const right = 16;
        const top = 14;
        const bottom = 34;
        const x = (index) => left + (index / Math.max(1, rows.length - 1)) * (width - left - right);
        const y = (value) => {
            const ratio = (value - min) / Math.max(1, max - min);
            return height - bottom - (chart.invertY ? 1 - ratio : ratio) * (height - top - bottom);
        };
        const ticks = Array.from({ length: 5 }, (_, index) => min + ((max - min) * index / 4));
        const dateIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
        const axisSeries = { format: chart.series[0].format };
        const grid = ticks.map((value) => `<g><line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="#2b4a61" stroke-dasharray="3 4"/><text x="${left - 7}" y="${y(value) + 3}" text-anchor="end" fill="#8ea5b6" font-size="9">${escapeHtml(formatTrendValue(value, axisSeries))}</text></g>`).join("");
        const labels = dateIndexes.map((index) => `<text x="${x(index)}" y="${height - 12}" text-anchor="middle" fill="#8ea5b6" font-size="9">${escapeHtml(new Date(rows[index].period).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</text>`).join("");
        const lines = chart.series.map((series) => trendLineSegments(rows, series.key, x, y).map((points) => `<polyline fill="none" stroke="${series.color}" stroke-width="3" stroke-linejoin="round" points="${points.join(" ")}"/>`).join("")).join("");
        const points = chart.series.map((series) => rows.map((row, index) => {
            const value = trendNumber(row?.[series.key]);
            if (value === null) return "";
            const tooltip = trendPointTooltip(row, chart.id);
            return `<circle class="ncc-chart-point ${row.period === selected.period ? "selected" : ""}" data-action="select-trend" data-period="${row.period}" cx="${x(index)}" cy="${y(value)}" r="${row.period === selected.period ? 5 : 3.5}" fill="${series.color}" aria-label="${escapeHtml(tooltip)}"><title>${escapeHtml(tooltip)}</title></circle>`;
        }).join("")).join("");
        const legend = chart.series.map((series) => {
            const count = availability.series.find((item) => item.key === series.key)?.dataPoints || 0;
            return `<span class="ncc-pill ${series.tone || ""}" style="border-color:${series.color}">● ${escapeHtml(series.label)}${count ? "" : " unavailable"}</span>`;
        }).join("");
        return `<div class="ncc-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.label)} trend; hover or select any data point for daily values"><text x="${left}" y="10" fill="#8ea5b6" font-size="9">${escapeHtml(chart.axisLabel)}</text><line x1="${left}" x2="${left}" y1="${top}" y2="${height - bottom}" stroke="#55748a"/><line x1="${left}" x2="${width - right}" y1="${height - bottom}" y2="${height - bottom}" stroke="#55748a"/>${grid}${lines}${points}${labels}</svg></div><div class="ncc-inline" style="margin-top:7px">${legend}<span class="ncc-help">Hover any point for daily values · select a point for details · ${formatDateTime(rows[0].period)} → ${formatDateTime(rows[rows.length - 1].period)}</span></div>${trendDetail(selected, prior)}`;
    }

    function renderTrends() {
        const history = companyHistory();
        const latest = [...history].reverse().slice(0, 30);
        const chart = trendChartDefinition(state.selectedTrendChart);
        const chartOptions = ["income-profit", "stock", "effectiveness", "ranking"].map((type) => {
            const item = trendChartDefinition(type);
            return `<option value="${item.id}" ${item.id === chart.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`;
        }).join("");
        const table = latest.length ? `<div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr><th>Reporting day</th><th>Daily income</th><th>Daily Profit</th><th>Weekly income</th><th>Weekly Profit</th><th>Rating</th><th>Funds</th></tr></thead><tbody>${latest.map((row) => `<tr>${stackCell("Reporting day", escapeHtml(formatDateTime(row.period)))}${stackCell("Daily income", trendNumber(row.dailyIncome) === null ? "—" : formatMoney(row.dailyIncome), "ncc-good")}${stackCell("Daily Profit", trendNumber(row.dailyProfit) === null ? "—" : formatMoney(row.dailyProfit), trendNumber(row.dailyProfit) === null ? "ncc-muted" : row.dailyProfit >= 0 ? "ncc-good" : "ncc-bad")}${stackCell("Weekly income", trendNumber(row.weeklyIncome) === null ? "—" : formatMoney(row.weeklyIncome))}${stackCell("Weekly Profit", trendNumber(row.weeklyProfit) === null ? "—" : formatMoney(row.weeklyProfit))}${stackCell("Rating", trendNumber(row.rating) === null ? "—" : `${formatNumber(row.rating)}★`)}${stackCell("Funds", trendNumber(row.funds) === null ? "—" : formatMoney(row.funds))}</tr>`).join("")}</tbody></table></div>` : `<div class="ncc-notice">The companion keeps one local snapshot per Torn reporting day (18:10 UTC). Refresh after installing to begin history.</div>`;
        return `${dataNotice()}<div class="ncc-toolbar"><label class="ncc-inline"><span class="ncc-label">Chart view</span><select id="ncc-trend-chart" class="ncc-select" title="Choose the local daily metric to chart">${chartOptions}</select></label><button class="ncc-button" data-action="export-history" ${history.length ? "" : "disabled"}>Export history CSV</button><button class="ncc-button ncc-danger" data-action="reset-history" ${history.length ? "" : "disabled"}>Clear local history</button><span class="ncc-help">${formatNumber(history.length)} retained daily snapshots · 92-day retention</span></div>${section(`${chart.label} trend`, trendSvg(history, chart.id))}${section("Local company history", table)}<p class="ncc-note">History stays in your userscript storage and is never uploaded by this companion. Income comes from daily Torn snapshots; Profit is calculated locally from the available daily inputs. Stock worth is recorded only when stock details are available; average employee effectiveness is the displayed current-effectiveness average; company rank is recorded only after same-type rankings load. Older snapshots can lack these newer metrics and remain unavailable rather than being inferred.</p>`;
    }

    function renderSettings() {
        const settings = state.settings;
        return `${dataNotice()}${section("API keys", `<div class="ncc-grid ncc-grid-2"><label><span class="ncc-label">Torn API key</span><input id="ncc-torn-key" class="ncc-input" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(settings.tornKey)}" placeholder="16-character Torn API key" style="width:100%;margin-top:6px"></label><label><span class="ncc-label">TornStats API key</span><input id="ncc-tornstats-key" class="ncc-input" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(settings.tornStatsKey)}" placeholder="Optional; required for projections" style="width:100%;margin-top:6px"></label></div><div class="ncc-inline" style="margin-top:10px"><button class="ncc-button ncc-primary" data-action="save-settings">Save settings only</button><button class="ncc-button" data-action="verify-refresh" title="Saves keys, then reloads Torn profile, employees, stock, funds news, and applications">Save keys & refresh Torn data</button></div><p class="ncc-note">Keys are stored only in your local userscript manager storage. They are not included in this repository, exports, or status messages.</p>`)}${section("TornStats projection consent", `<label class="ncc-check"><input id="ncc-projection-consent" type="checkbox" ${settings.projectionConsent ? "checked" : ""}><span><b>Allow per-employee efficiency projections.</b><br>TornStats will receive each employee’s Manual labor, Intelligence, and Endurance values with your TornStats key to calculate role efficiency. Enable this only if you are comfortable sending those work-stat triplets to TornStats.</span></label><div class="ncc-inline" style="margin-top:10px"><button class="ncc-button" data-action="save-settings">Save consent choice</button><button class="ncc-button ncc-primary" data-action="load-projections" title="Calls TornStats for each employee to rebuild selectable role-efficiency projections" ${state.projectionLoading ? "disabled" : ""}>${state.projectionLoading ? "Calculating role projections…" : "Calculate TornStats role projections"}</button></div>`)}${section("Calculation & refresh", `<div class="ncc-grid ncc-grid-2"><label class="ncc-check"><input id="ncc-stock-cost" type="checkbox" ${settings.includeStockCost ? "checked" : ""}><span><b>Include sold stock cost in daily net.</b><br>Daily net subtracts cost × sold amount; weekly net follows Torn Company Assistant’s wage/advertising formula because stock is reported as a daily value.</span></label><label><span class="ncc-label">Automatic core refresh</span><div class="ncc-inline" style="margin-top:6px"><input id="ncc-refresh-minutes" class="ncc-input" type="number" min="2" max="120" value="${clamp(asNumber(settings.autoRefreshMinutes, 10), 2, 120)}" style="width:85px"><span class="ncc-help">minutes while Torn is open</span></div></label></div><div class="ncc-inline" style="margin-top:10px"><button class="ncc-button ncc-primary" data-action="save-settings">Save preferences only</button><button class="ncc-button" data-action="reset-layout">Reset panel position</button></div>`)}${section("Local data", `<div class="ncc-inline"><button class="ncc-button" data-action="export-history" ${companyHistory().length ? "" : "disabled"}>Export history CSV</button><button class="ncc-button ncc-danger" data-action="clear-local-data">Clear companion data</button></div><p class="ncc-note">Clearing companion data deletes local cache, rankings, efficiency projections, history, assignments, and saved keys from this userscript. It cannot change Torn or TornStats data.</p>`)}<p class="ncc-note">Naughty Company Companion ${VERSION} · TornPDA/Tampermonkey compatible.</p>`;
    }

    function renderHealthModal() {
        const metrics = rankingMetrics();
        if (!metrics) return "";
        const rows = metrics.neighbors.map((company) => `<tr class="${company.rank === metrics.rank ? "ncc-own-row" : ""}">${stackCell("Rank", formatNumber(company.rank))}${stackCell("Company", `<b>${escapeHtml(company.name || "Unknown")}</b>`)}${stackCell("Rating", `${formatNumber(company.rating)}★`)}${stackCell("Daily income", formatMoney(incomeOf(company, "daily"), true))}${stackCell("Weekly income", formatMoney(incomeOf(company), true))}</tr>`).join("");
        return `<div class="ncc-modal-backdrop" data-action="close-modal"><section class="ncc-modal" role="dialog" aria-modal="true" aria-label="Health score neighbors"><header class="ncc-modal-head"><h2>Health score · income rank</h2><button class="ncc-icon" data-action="close-modal">×</button></header><div class="ncc-modal-body"><div class="ncc-grid ncc-grid-3">${metricCard("Health score", formatPercent(metrics.percentile, 1), "Weekly-income percentile", "ncc-good")}${metricCard("Your rank", `${formatNumber(metrics.rank)} / ${formatNumber(metrics.total)}`, "Same company type")}${metricCard("Weekly income", formatMoney(incomeOf(state.data?.profile)), "Current Torn value")}</div><p class="ncc-note">Health score is not a Torn API field or a hidden company-quality formula. It is the companion’s transparent weekly-income percentile: (companies − rank + 1) / companies.</p><div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr><th>Rank</th><th>Company</th><th>Rating</th><th>Daily income</th><th>Weekly income</th></tr></thead><tbody>${rows}</tbody></table></div></div></section></div>`;
    }

    function renderMain() {
        if (!state.data?.profile && state.selectedTab === "settings") return renderSettings();
        if (!state.data?.profile) return `${dataNotice()}<div class="ncc-empty"><div><p>Enter a Torn API key in Settings to load your company profile, team, stock, income, and rankings.</p><button class="ncc-button ncc-primary" data-tab="settings">Open settings</button></div></div>`;
        switch (state.selectedTab) {
            case "team": return renderTeam();
            case "planner": return renderPlanner();
            case "rankings": return renderRankings();
            case "stock": return renderStock();
            case "trends": return renderTrends();
            case "settings": return renderSettings();
            default: return renderOverview();
        }
    }

    function render() {
        mountShell();
        const tabs = [
            ["overview", "Overview"], ["team", "Team"], ["planner", "Planner"], ["rankings", "Rankings"], ["stock", "Stock"], ["trends", "Trends"], ["settings", "Settings"]
        ];
        const tabsEl = document.getElementById("ncc-tabs");
        tabsEl.innerHTML = tabs.map(([id, label]) => `<button class="ncc-tab ${state.selectedTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("");
        const activityStatus = state.loading ? "Refreshing company data…" : state.projectionLoading ? "Loading TornStats projections…" : state.rankingLoading ? state.status : state.status;
        document.getElementById("ncc-status").textContent = [activityStatus, state.storageWarning].filter(Boolean).join(" ");
        const contentEl = content();
        contentEl.innerHTML = renderMain();
        if (state.modal === "health") contentEl.insertAdjacentHTML("beforeend", renderHealthModal());
        bindContentEvents();
        applyLayout();
    }

    async function toggleMinimized(minimized) {
        state.layout.minimized = minimized;
        await storeSet(STORE.layout, state.layout);
        applyLayout();
    }

    async function setTab(tab) {
        if (!tab || tab === state.selectedTab) return;
        state.selectedTab = tab;
        await saveSettings({ activeTab: tab });
        render();
    }

    async function setEmployeeAssignment(employeeId, position) {
        const settings = currentCompanySettings();
        if (!settings.id) return;
        state.settings.assignments[settings.id] = { ...settings.assignments, [employeeId]: position };
        await saveSettings({ assignments: state.settings.assignments });
        state.status = "Local assignment plan saved.";
        render();
    }

    async function setEmployeeLock(employeeId, locked) {
        const settings = currentCompanySettings();
        if (!settings.id) return;
        state.settings.lockedEmployees[settings.id] = { ...settings.locks, [employeeId]: locked };
        await saveSettings({ lockedEmployees: state.settings.lockedEmployees });
        state.status = locked ? "Employee locked for planner assignments." : "Employee unlocked for planner assignments.";
        render();
    }

    async function savePlannerSettings() {
        const settings = currentCompanySettings();
        if (!settings.id) return;
        const capacities = {};
        document.querySelectorAll("[data-capacity]").forEach((input) => {
            const position = input.getAttribute("data-capacity");
            const capacity = asNumber(input.value);
            if (position && capacity > 0) capacities[position] = Math.floor(capacity);
        });
        state.settings.positionCapacities[settings.id] = capacities;
        await saveSettings({ positionCapacities: state.settings.positionCapacities, positionPriority: state.settings.positionPriority });
        state.status = "Position max quantities saved.";
        render();
    }

    async function autoAssign() {
        try {
            const result = calculateAssignments();
            const settings = currentCompanySettings();
            state.settings.assignments[settings.id] = Object.fromEntries(employeeRows().map((row) => [row.id, result.assigned[row.id] || ""]));
            await saveSettings({ assignments: state.settings.assignments });
            state.status = `${formatNumber(Object.keys(result.assigned).length)} local staffing recommendations saved.`;
        } catch (error) {
            state.error = error?.message || "Unable to create assignments.";
        }
        render();
    }

    async function saveSettingsFromForm() {
        const tornKey = document.getElementById("ncc-torn-key");
        const tornStatsKey = document.getElementById("ncc-tornstats-key");
        const consent = document.getElementById("ncc-projection-consent");
        const stockCost = document.getElementById("ncc-stock-cost");
        const refreshMinutes = document.getElementById("ncc-refresh-minutes");
        await saveSettings({
            tornKey: tornKey ? tornKey.value.trim() : state.settings.tornKey,
            tornStatsKey: tornStatsKey ? tornStatsKey.value.trim() : state.settings.tornStatsKey,
            projectionConsent: consent ? consent.checked : state.settings.projectionConsent,
            includeStockCost: stockCost ? stockCost.checked : state.settings.includeStockCost,
            autoRefreshMinutes: refreshMinutes ? clamp(asNumber(refreshMinutes.value, 10), 2, 120) : state.settings.autoRefreshMinutes
        });
        resetAutoRefresh();
        resetDailyTickAlerts();
        state.error = "";
        state.status = "Settings saved locally.";
        render();
    }

    async function exportHistory() {
        const profile = state.data?.profile;
        const rows = companyHistory(profile?.id);
        if (!rows.length) return;
        const headers = ["reporting_day_utc", "daily_income", "daily_net_profit", "weekly_income", "weekly_net_profit", "funds", "rating"];
        const esc = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
        const csv = [headers.join(","), ...rows.map((row) => [new Date(row.period).toISOString(), row.dailyIncome, row.dailyProfit, row.weeklyIncome, row.weeklyProfit, row.funds, row.rating].map(esc).join(","))].join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `naughty-company-history-${profile?.id || "export"}.csv`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        state.status = "Local history CSV exported.";
        render();
    }

    async function resetHistory() {
        const id = String(state.data?.profile?.id || "");
        if (!id || !window.confirm("Clear this company’s local income and profit history? This cannot be undone.")) return;
        state.history[id] = [];
        await storeSet(STORE.history, state.history);
        state.status = "Local company history cleared.";
        render();
    }

    async function clearLocalData() {
        if (!window.confirm("Clear all Naughty Company Companion local data, including saved keys, history, ranking cache, plans, and projections?")) return;
        if (nativeRuntime.isTornPDA || await confirmTornPDA()) await Promise.all(Object.keys(DAILY_ALERTS).map((kind) => cancelDailyTickReminder(kind)));
        await Promise.all(Object.values(STORE).map((key) => storeDelete(key)));
        state.settings = { ...DEFAULT_SETTINGS };
        state.layout = { ...DEFAULT_LAYOUT };
        state.data = null;
        state.cache = null;
        state.history = {};
        state.rankings = {};
        state.projections = {};
        state.rankHistory = {};
        state.starCohorts = {};
        state.dailyAlerts = {};
        state.dailyReminders = {};
        state.selectedTab = "overview";
        state.error = "";
        state.status = "All companion data was cleared from local userscript storage.";
        resetAutoRefresh();
        render();
    }

    function resetPanelLayout() {
        state.layout = { ...DEFAULT_LAYOUT };
        void storeSet(STORE.layout, state.layout);
        applyLayout();
        state.status = "Panel layout reset.";
        render();
    }

    function bindContentEvents() {
        const root = document.getElementById(ROOT_ID);
        if (!root) return;
        root.querySelectorAll("[data-tab]").forEach((button) => {
            button.onclick = () => setTab(button.getAttribute("data-tab"));
        });
        root.querySelectorAll("[data-sort]").forEach((header) => {
            header.onclick = () => {
                const [group, key] = String(header.getAttribute("data-sort") || "").split(":");
                if (!state.sort[group] || !key) return;
                state.sort[group] = state.sort[group].key === key ? { key, dir: state.sort[group].dir === "asc" ? "desc" : "asc" } : { key, dir: group === "rankings" && key === "rank" ? "asc" : "desc" };
                render();
            };
        });
        root.querySelectorAll("[data-assignment]").forEach((select) => {
            select.onchange = () => setEmployeeAssignment(select.getAttribute("data-assignment"), select.value);
        });
        root.querySelectorAll("[data-lock-employee]").forEach((input) => {
            input.onchange = () => setEmployeeLock(input.getAttribute("data-lock-employee"), input.checked);
        });
        const teamFilter = document.getElementById("ncc-team-filter");
        if (teamFilter) teamFilter.oninput = () => {
            state.teamFilter = teamFilter.value;
            render();
            const next = document.getElementById("ncc-team-filter");
            if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
        };
        const rankingsFilter = document.getElementById("ncc-rankings-filter");
        if (rankingsFilter) rankingsFilter.oninput = () => {
            state.rankingsFilter = rankingsFilter.value;
            render();
            const next = document.getElementById("ncc-rankings-filter");
            if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
        };
        const trendChart = document.getElementById("ncc-trend-chart");
        if (trendChart) trendChart.onchange = () => {
            state.selectedTrendChart = trendChartDefinition(trendChart.value).id;
            render();
        };
        root.querySelectorAll("[data-action]").forEach((element) => {
            element.onclick = async (event) => {
                const action = element.getAttribute("data-action");
                if (action === "close-modal" && element.classList.contains("ncc-modal-backdrop") && event.target !== element) return;
                switch (action) {
                    case "refresh": await refreshCore(); break;
                    case "minimize": await toggleMinimized(true); break;
                    case "load-rankings": await loadRankings({ force: true }); break;
                    case "load-projections": await loadProjections(); break;
                    case "show-health": state.modal = "health"; render(); break;
                    case "select-trend": state.selectedTrendPeriod = asNumber(element.getAttribute("data-period")); render(); break;
                    case "close-modal": state.modal = null; render(); break;
                    case "save-planner": await savePlannerSettings(); break;
                    case "priority-up": await movePlannerPriority(element.getAttribute("data-position"), -1); break;
                    case "priority-down": await movePlannerPriority(element.getAttribute("data-position"), 1); break;
                    case "auto-assign": await autoAssign(); break;
                    case "save-settings": await saveSettingsFromForm(); break;
                    case "verify-refresh": await saveSettingsFromForm(); await refreshCore(); break;
                    case "export-history": await exportHistory(); break;
                    case "reset-history": await resetHistory(); break;
                    case "clear-local-data": await clearLocalData(); break;
                    case "reset-layout": resetPanelLayout(); break;
                    default: break;
                }
            };
        });
    }

    function bindDragAndResize() {
        const handle = document.getElementById("ncc-drag-handle");
        const el = panel();
        if (!handle || !el) return;
        let drag = null;
        let resize = null;
        handle.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || event.target.closest("button")) return;
            const rect = el.getBoundingClientRect();
            drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
            handle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        handle.addEventListener("pointermove", (event) => {
            if (!drag) return;
            const rect = el.getBoundingClientRect();
            const viewport = visibleViewport();
            state.layout.x = clamp(Math.round(event.clientX - drag.dx), 0, Math.max(0, viewport.width - rect.width));
            state.layout.y = clamp(Math.round(event.clientY - drag.dy), 0, Math.max(0, viewport.height - 60));
            applyLayout();
        });
        const endDrag = async () => {
            if (!drag) return;
            drag = null;
            await persistLayout();
        };
        handle.addEventListener("pointerup", endDrag);
        handle.addEventListener("pointercancel", endDrag);
        [
            [".ncc-resize-grip-left", "left"],
            [".ncc-resize-grip-right", "right"]
        ].forEach(([selector, edge]) => {
            const grip = el.querySelector(selector);
            if (!grip) return;
            grip.addEventListener("pointerdown", (event) => {
                if (event.button !== 0 || currentRuntimeMode() !== "desktop") return;
                const rect = el.getBoundingClientRect();
                resize = { edge, x: event.clientX, y: event.clientY, left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
                grip.setPointerCapture?.(event.pointerId);
                event.preventDefault();
            });
            grip.addEventListener("pointermove", (event) => {
                if (!resize) return;
                const viewport = visibleViewport();
                const maxHeight = Math.max(1, viewport.height - resize.top - PANEL_MARGIN);
                const height = clamp(Math.round(resize.height + event.clientY - resize.y), Math.min(420, maxHeight), maxHeight);
                if (resize.edge === "left") {
                    const maxWidth = Math.max(1, resize.right - PANEL_MARGIN);
                    const width = clamp(Math.round(resize.width - (event.clientX - resize.x)), Math.min(430, maxWidth), maxWidth);
                    state.layout = { ...state.layout, x: Math.round(resize.right - width), y: Math.round(resize.top), width, height };
                } else {
                    const maxWidth = Math.max(1, viewport.width - resize.left - PANEL_MARGIN);
                    const width = clamp(Math.round(resize.width + event.clientX - resize.x), Math.min(430, maxWidth), maxWidth);
                    state.layout = { ...state.layout, x: Math.round(resize.left), y: Math.round(resize.top), width, height };
                }
                applyLayout();
            });
            const endResize = () => {
                if (!resize) return;
                resize = null;
                void persistLayout();
            };
            grip.addEventListener("pointerup", endResize);
            grip.addEventListener("pointercancel", endResize);
            grip.addEventListener("lostpointercapture", endResize);
        });
        el.addEventListener("pointerup", () => { void persistLayout(); });
        const handleRuntimeResize = () => {
            const priorMode = state.runtimeMode;
            applyLayout();
            if (priorMode !== state.runtimeMode) render();
        };
        window.addEventListener("resize", handleRuntimeResize);
        window.visualViewport?.addEventListener("resize", handleRuntimeResize);
    }

    function resetAutoRefresh() {
        if (state.autoRefreshId) clearInterval(state.autoRefreshId);
        state.autoRefreshId = null;
        if (!String(state.settings.tornKey || "").trim()) return;
        const minutes = clamp(asNumber(state.settings.autoRefreshMinutes, 10), 2, 120);
        state.autoRefreshId = setInterval(() => refreshCore({ silent: true }), minutes * 60 * 1000);
    }

    async function boot() {
        await loadPersistedState();
        mountShell();
        debugLog("startup:ready", {
            version: VERSION,
            runtimeMode: currentRuntimeMode(),
            confirmedTornPDA: nativeRuntime.isTornPDA,
            storageMode: storage.mode,
            tornKeyConfigured: Boolean(String(state.settings.tornKey || "").trim())
        });
        if (state.data?.fetchedAt) state.status = `Showing cached data from ${timeAgo(state.data.fetchedAt)}.`;
        else state.status = "Configure a Torn API key to begin.";
        resetAutoRefresh();
        resetDailyTickAlerts();
        render();
        if (String(state.settings.tornKey || "").trim()) void refreshCore({ silent: true });
        window.addEventListener("keydown", (event) => {
            if (event.altKey && event.key.toLowerCase() === "c") {
                event.preventDefault();
                toggleMinimized(!state.layout.minimized);
            }
            if (event.key === "Escape" && state.modal) {
                state.modal = null;
                render();
            }
        });
        window.addEventListener("beforeunload", () => { void persistLayout(); });
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) void runDailyTickAlerts({ refresh: true });
        });
    }

    const testApi = { reportingPeriod, weekKey, countStars, calculateRankingMetrics, companyRankSummary, financials, statFingerprint, projectionBlock, assignProjectedRows, stockDifference, previousStockSnapshot, currentStockWorth, preferredCurrentEfficiency, sortRows, orderedPriorityPositions, trendNumber, trendChartAvailability, trendPointTooltip, trendPerformance, isCompactViewport, isCompactLayout, boundedPanelLayout, runtimeMode, utcDayKey, dailyAlertPhaseTime, isDailyAlertDue, buildDailyTickAlert, employeeEffectivenessRisks, buildEmployeeRiskAlert, nextDailyAlertTimestamp, dailyAlertKindAt, nextDailyReminderTimestamp, buildDailyTickReminder, safeRequestDescriptor, safeDiagnosticError };
    if (typeof module !== "undefined" && module.exports) module.exports = testApi;
    if (typeof window !== "undefined") initializeNativeRuntime();
    if (typeof document !== "undefined" && typeof window !== "undefined") {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { void boot(); }, { once: true });
        else void boot();
    }
})();
