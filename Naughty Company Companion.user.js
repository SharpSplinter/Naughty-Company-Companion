// ==UserScript==
// @name         Naughty Company Companion
// @namespace    https://github.com/SharpSplinter/Naughty-Company-Companion
// @version      1.3.4
// @description  Company income, profit, efficiency, stock, rankings, and staffing companion for Torn.
// @author       SharpSplinter [315311]
// @license      MIT
// @match        https://www.torn.com/companies.php*
// @run-at       document-start
// @source       https://raw.githubusercontent.com/SharpSplinter/Naughty-Company-Companion/main/Naughty%20Company%20Companion.user.js
// @updateURL    https://raw.githubusercontent.com/SharpSplinter/Naughty-Company-Companion/main/Naughty%20Company%20Companion.user.js
// @downloadURL  https://raw.githubusercontent.com/SharpSplinter/Naughty-Company-Companion/main/Naughty%20Company%20Companion.user.js
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
// ==/UserScript==

(() => {
    "use strict";

    const Version = (typeof GM_info !== 'undefined' && GM_info.script) ? GM_info.script.version : "1.0.0";
    console.log('Running script version: ${VERSION}');

    const ROOT_ID = "ncc-root";
    const TORN_API = "https://api.torn.com/v2";
    const PDA_INJECTED_TORN_KEY = "_###PDA-APIKEY###_";
    const DAY = 86400000;
    const DAILY_TICK_HOUR_UTC = 18;
    const DAILY_SYNC_MINUTE_UTC = 10;
    const DAILY_ALERTS = Object.freeze({
        income: {
            minute: DAILY_SYNC_MINUTE_UTC,
            notificationId: 6811,
            reminderNotificationId: 6813,
            title: "Naughty Company — Daily Tick",
            reminderText: "Company daily tick is due. Open Naughty Company Companion to refresh live Daily Income, Daily Profit, and Daily Customer Count."
        },
        employeeRisk: {
            minute: DAILY_SYNC_MINUTE_UTC,
            notificationId: 6812,
            reminderNotificationId: 6814,
            title: "Naughty Company — Employee Effectiveness",
            reminderText: "Employee effectiveness check is due. Open Naughty Company Companion to refresh and review Addiction and Inactivity penalties below -12."
        }
    });
    const EFFECTIVENESS_ALERT_THRESHOLD = -12;
    const COMPACT_LAYOUT_MAX_WIDTH = 820;
    const PANEL_MARGIN = 14;
    const VIRTUAL_KEYBOARD_MIN_HEIGHT_DELTA = 120;
    const VIRTUAL_KEYBOARD_WIDTH_TOLERANCE = 0.12;
    const STORAGE_WRITE_DEBOUNCE_MS = 120;
    const BACKUP_FORMAT = "naughty-company-companion-backup";
    const BACKUP_NAMESPACE = "naughty-company-companion";
    const BACKUP_SCHEMA_VERSION = 2;
    const BACKUP_MAX_BYTES = 8 * 1024 * 1024;
    const MAX_SAME_TYPE_COMPANIES = 5000;
    const DIAGNOSTIC_PREFIX = "[Naughty Company Companion]";
    const STORE = {
        settings: "ncc:settings:v1",
        cache: "ncc:cache:v1",
        history: "ncc:history:v1",
        rankings: "ncc:rankings:v1",
        rankHistory: "ncc:rank-history:v1",
        starCohorts: "ncc:star-cohorts:v1",
        layout: "ncc:layout:v1",
        dailyAlerts: "ncc:daily-alerts:v1",
        dailyReminders: "ncc:daily-reminders:v1",
        dailySync: "ncc:daily-sync:v1"
    };
    const STORE_KEYS = Object.values(STORE);
    const LEGACY_PROJECTION_STORE = "ncc:projections:v1";
    const BACKUP_STORE_KEYS = STORE_KEYS;
    const LEGACY_BACKUP_STORE_KEYS = [...STORE_KEYS.filter((key) => key !== STORE.dailySync), LEGACY_PROJECTION_STORE];
    const LEGACY_FALLBACK_KEY = "ncc:pda-fallback-keys:v1";
    const DEFAULT_SETTINGS = {
        companyAccounts: {},
        activeCompanyId: "",
        dailyAlertMode: "off",
        sourceTimes: {},
        includeStockCost: true,
        dailyTickToasts: false,
        dailyTickNotifications: false,
        useLegacyGMStorage: false,
        autoRefreshMinutes: 10,
        activeTab: "overview",
        assignments: {},
        lockedEmployees: {},
        positionCapacities: {},
        positionPriority: {}
    };
    const DEFAULT_LAYOUT = { x: null, y: 14, width: 940, height: 860, minimized: false, launcherX: null, launcherY: null };
    const LAUNCHER_SIZE = 52;
    const state = {
        settings: { ...DEFAULT_SETTINGS },
        layout: { ...DEFAULT_LAYOUT },
        data: null,
        cache: null,
        cacheByCompany: {},
        history: {},
        rankings: {},
        rankHistory: {},
        starCohorts: {},
        dailyAlerts: {},
        dailyReminders: {},
        loading: false,
        rankingLoading: false,
        exportInFlight: false,
        status: "Add a Limited-access Director key to begin.",
        error: "",
        selectedTab: "overview",
        sort: { team: { key: "total", dir: "desc" }, planner: { key: "name", dir: "asc" }, rankings: { key: "rank", dir: "asc" }, stock: { key: "sold_worth", dir: "desc" } },
        teamFilter: "",
        rankingsFilter: "",
        selectedTrendPeriod: null,
        selectedTrendChart: "income-profit",
        runtimeMode: "desktop",
        runtimeKind: "desktop",
        layoutProfile: "standard",
        storageWarning: "",
        modal: null,
        pendingRestore: null,
        autoRefreshId: null,
        dailySync: {}
    };
    const dailyAlertRuntime = {
        timerId: null,
        liveTimerId: null,
        inFlight: new Set(),
        reminderRefreshPromise: null
    };
    const dailySyncRuntime = {
        timerId: null,
        inFlight: null
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
    const keyboardViewportRuntime = {
        active: false,
        baseline: null,
        panelHeight: null,
        releaseTimer: null
    };
    const responsiveLayoutRuntime = { observer: null, frame: null };
    // Static role requirements; local calculations never transmit employee statistics.
    // Source data verified 2026-08-25 against Torn's public company position reference.
    const POSITION_REQUIREMENTS_B64 = "eyJIYWlyIFNhbG9uIjp7IlN0eWxpc3QiOlsxNTAwLDAsNzUwXSwiQ29sb3Jpc3QiOlsyMDAwLDAsMTAwMF0sIk5haWwgVGVjaG5pY2lhbiI6Wzc1MCwwLDE1MDBdLCJBcHByZW50aWNlIjpbNTAwLDAsMjUwXSwiU2hhbXBvb2lzdCI6WzEwMDAsMCw1MDBdLCJTZW5pb3IgU3R5bGlzdCI6WzMwMDAsMCwxNTAwXSwiUmVjZXB0aW9uaXN0IjpbMCwxMjUwLDI1MDBdLCJUcmFpbmVyIjpbMCw0NTAwLDIyNTBdLCJBZXN0aGV0aWNpYW4iOlswLDQ1MDAsMjI1MF19LCJMYXcgRmlybSI6eyJDbGVhbmVyIjpbNTUwMCwwLDI3NTBdLCJNYXJrZXRlciI6WzAsMjIwMDAsMTEwMDBdLCJDb25zdWx0YW50IjpbMCwzMzAwMCwxNjUwMF0sIlNlY3JldGFyeSI6WzAsODI1MCwxNjUwMF0sIkFzc2lzdGFudCI6WzAsMjc1MCw1NTAwXSwiQXR0b3JuZXkiOlswLDExMDAwLDU1MDBdfSwiRmxvd2VyIFNob3AiOnsiRmxvcmlzdCI6WzUwMCwwLDEwMDBdLCJBcnJhbmdlciI6WzUwMCwxMDAwLDBdLCJBcHByZW50aWNlIjpbMjUwLDAsNTAwXSwiQ2xlYW5lciI6WzUwMCwwLDI1MF0sIk1hbmFnZXIiOlswLDEwMDAsMjAwMF0sIk1hcmtldGVyIjpbMCwyMDAwLDEwMDBdLCJBY2NvdW50YW50IjpbMCw3NTAsMTUwMF19LCJDYXIgRGVhbGVyc2hpcCI6eyJUcmFpbmluZyBBZHZpc2VyIjpbMCw2MzAwMCwzMTUwMF0sIk1hbmFnZXIiOlswLDIxMDAwLDQyMDAwXSwiV2VibWFzdGVyIjpbMCw0MjAwMCwyMTAwMF0sIlJlY2VwdGlvbmlzdCI6WzAsMTU3NTAsMzE1MDBdLCJNZWNoYW5pYyI6WzI2NTAwLDAsMTMyNTBdLCJTYWxlcyBFeGVjdXRpdmUiOlswLDIxMDAwLDEwNTAwXSwiQ2xlYW5lciI6WzEwNTAwLDAsNTI1MF0sIlNhbGVzIEFwcHJlbnRpY2UiOlswLDU1MDAsMjc1MF19LCJDbG90aGluZyBTdG9yZSI6eyJMaW5lIE1hbmFnZXIiOlswLDYwMDAsMzAwMF0sIlN0b3JlIE1hbmFnZXIiOlswLDIwMDAsNDAwMF0sIk1hcmtldGluZyBNYW5hZ2VyIjpbMCw0MDAwLDIwMDBdLCJBY2NvdW50YW50IjpbMCwxNTAwLDMwMDBdLCJTZWN1cml0eSBHdWFyZCI6WzMwMDAsMCwxNTAwXSwiU2FsZXNwZXJzb24iOlswLDIwMDAsMTAwMF0sIkNhc2hpZXIiOls3NTAsMCwxNTAwXSwiQ2xlYW5lciI6WzEwMDAsMCw1MDBdLCJTYWxlcyBUcmFpbmVlIjpbMCw1MDAsMjUwXX0sIkd1biBTaG9wIjp7IkNsZXJrIjpbMzc1MCwwLDc1MDBdLCJHdW5zbWl0aCI6WzE1MDAwLDc1MDAsMF0sIkNsZWFuZXIiOls0MDAwLDAsMjAwMF0sIk1hbmFnZXIiOlswLDc1MDAsMTUwMDBdLCJCb29ra2VlcGVyIjpbMCw1NzUwLDExNTAwXSwiTWFya2V0ZXIiOlswLDE1MDAwLDc1MDBdLCJJbnN0cnVjdG9yIjpbMCwyMjUwMCwxMTI1MF19LCJHYW1lIFNob3AiOnsiQ2xlcmsiOlsxNTAwLDAsMzAwMF0sIkdhbWUgQWR2aXNvciI6WzAsNDUwMCwyMjUwXSwiQ2xlYW5lciI6WzE1MDAsMCw3NTBdLCJTdG9yZSBNYW5hZ2VyIjpbMCwzMDAwLDYwMDBdLCJBY2NvdW50YW50IjpbMCwyMjUwLDQ1MDBdLCJNYXJrZXRlciI6WzAsNjAwMCwzMDAwXX0sIkNhbmRsZSBTaG9wIjp7IkNoYW5kbGVyIjpbNDUwMCwyMjUwLDBdLCJUcmFpbmVyIjpbMCw0NTAwLDIyNTBdLCJRdWFsaXR5IENvbnRyb2wiOlswLDE1MDAsMzAwMF0sIkJvb2trZWVwZXIiOlswLDEyNTAsMjUwMF0sIlNhbGVzcGVyc29uIjpbMCw3NTAsMTUwMF0sIkNsZWFuZXIiOlsxMDAwLDAsNTAwXX0sIlRveSBTaG9wIjp7IlNhbGVzIEFzc2lzdGFudCI6WzI1MDAsMCw1MDAwXSwiQ2xlYW5lciI6WzI1MDAsMCwxMjUwXSwiU3RvcmUgTWFuYWdlciI6WzAsNTAwMCwxMDAwMF0sIk9mZmljZSBDbGVyayI6WzAsMzc1MCw3NTAwXSwiTWFya2V0aW5nIEV4ZWN1dGl2ZSI6WzAsMTAwMDAsNTAwMF0sIlRyYWluaW5nIEFkdmlzb3IiOlswLDE1MDAwLDc1MDBdLCJTdG9jayBDbGVyayI6WzQwMDAsMCwyMDAwXX0sIkFkdWx0IE5vdmVsdGllcyI6eyJIdW1hbiBSZXNvdXJjZXMiOlswLDEyMDAwLDYwMDBdLCJTZXhwZXJ0IjpbMCwxMDAwMCw1MDAwXSwiU3RvcmUgTWFuYWdlciI6WzAsNDAwMCw4MDAwXSwiTWFya2V0aW5nIE1hbmFnZXIiOlswLDgwMDAsNDAwMF0sIlJlY2VwdGlvbmlzdCI6WzAsMzAwMCw2MDAwXSwiU2FsZXMgQXNzaXN0YW50IjpbMjAwMCwwLDQwMDBdLCJDbGVhbmVyIjpbMjAwMCwwLDEwMDBdfSwiQ3liZXIgQ2FmZSI6eyJDYXNoaWVyIjpbMCw1MDAwLDEwMDAwXSwiQ2xlYW5lciI6WzUwMDAsMCwyNTAwXSwiTWFuYWdlciI6WzAsMTAwMDAsMjAwMDBdLCJSZWNlcHRpb25pc3QiOlswLDc1MDAsMTUwMDBdLCJNYXJrZXRlciI6WzAsMjAwMDAsMTAwMDBdLCJUZWFjaGVyIjpbMCwzMDAwMCwxNTAwMF0sIkFkbWluaXN0cmF0b3IiOlswLDIwMDAwLDEwMDAwXSwiVGVjaG5pY2lhbiI6Wzg3NTAsMTc1MDAsMF19LCJHcm9jZXJ5IFN0b3JlIjp7IkNhc2hpZXIiOlszMDAwLDAsNjAwMF0sIlN0b2NrIENsZXJrIjpbNDUwMCwwLDIyNTBdLCJDbGVhbmVyIjpbMzAwMCwwLDE1MDBdLCJNYW5hZ2VyIjpbMCw2MDAwLDEyMDAwXSwiQWNjb3VudGFudCI6WzAsNDUwMCw5MDAwXSwiTWFya2V0ZXIiOlswLDEyMDAwLDYwMDBdLCJUcmFpbmVyIjpbMCwxODAwMCw5MDAwXSwiRGVsaXZlcnkgRHJpdmVyIjpbNzUwMCwwLDM3NTBdLCJDYXJ0IEF0dGVuZGFudCI6WzMwMDAsMCwxNTAwXX0sIlRoZWF0ZXIiOnsiVGlja2V0aW5nIEFnZW50IjpbMCwxMDAwMCwyMDAwMF0sIlRlY2huaWNpYW4iOls2MDAwMCwzMDAwMCwwXSwiUHJvZ3JhbW1lciI6WzAsNTAwMDAsMjUwMDBdLCJKYW5pdG9yIjpbMjAwMDAsMCwxMDAwMF0sIk1hbmFnZXIiOlswLDQwMDAwLDgwMDAwXSwiQWNjb3VudGFudCI6WzAsMzAwMDAsNjAwMDBdLCJNYXJrZXRpbmcgTWFuYWdlciI6WzAsODAwMDAsNDAwMDBdLCJVc2hlciI6WzEwMDAwLDAsMjAwMDBdfSwiU3dlZXQgU2hvcCI6eyJDb25mZWN0aW9uaXN0IjpbMCwyNTAwLDEyNTBdLCJQYWNrYWdlciI6Wzc1MCwwLDE1MDBdLCJDbGVhbmVyIjpbMTAwMCwwLDUwMF0sIk1hbmFnZXIiOlswLDIwMDAsNDAwMF0sIkJvb2trZWVwZXIiOlswLDE1MDAsMzAwMF0sIk1hcmtldGVyIjpbMCw0MDAwLDIwMDBdLCJDbGVyayI6WzEwMDAsMCwyMDAwXX0sIkNydWlzZSBMaW5lIjp7IkNhcHRhaW4iOlswLDE1NDUwMCw3NzI1MF0sIkZpcnN0IE9mZmljZXIiOlswLDEwNTAwMCw1MjUwMF0sIkRvY3RvciI6WzAsMTAzMDAwLDUxNTAwXSwiU3BlY2lhbGlzdCI6WzAsOTAwMDAsNDUwMDBdLCJCb3N1biI6WzAsMzcwMDAsNzQwMDBdLCJNYXJrZXRlciI6WzAsNzIwMDAsMzYwMDBdLCJDaGVmIjpbMCw2NDUwMCwzMjI1MF0sIkVuZ2luZWVyIjpbNTQ1MDAsMjcyNTAsMF0sIlJlY2VwdGlvbmlzdCI6WzAsMjEwMDAsNDIwMDBdLCJTdGV3YXJkIjpbMCwyMDc1MCw0MTUwMF0sIkJhcnRlbmRlciI6WzE5MjUwLDAsMzg1MDBdLCJEZWNraGFuZCI6WzI2MDAwLDAsMTMwMDBdLCJUaWNrZXQgQWdlbnQiOlswLDEzMDAwLDI2MDAwXX0sIlRlbGV2aXNpb24gTmV0d29yayI6eyJQcm9kdWNlciI6WzAsOTkwMDAsNDk1MDBdLCJQcm9ncmFtbWVyIjpbMCw2NjAwMCwzMzAwMF0sIkNhbWVyYSBPcGVyYXRvciI6WzI0NzUwLDQ5NTAwLDBdLCJTYWxlcyBFeGVjdXRpdmUiOlswLDI0NzUwLDQ5NTAwXSwiQ2xlYW5lciI6WzMzMDAwLDAsMTY1MDBdLCJBdHRvcm5leSI6WzAsMTMyMDAwLDY2MDAwXSwiU2VjcmV0YXJ5IjpbMCw0OTUwMCw5OTAwMF0sIk1hcmtldGVyIjpbMCwxMzIwMDAsNjYwMDBdLCJXcml0ZXIiOlswLDExNTUwMCw1Nzc1MF0sIlN0YWdlaGFuZCI6WzMzMDAwLDAsMTY1MDBdLCJBbmNob3IiOlswLDEzMjAwMCw2NjAwMF0sIlJlcG9ydGVyIjpbMCw4MjUwMCw0MTI1MF19LCJab28iOnsiWm9vIEtlZXBlciI6WzU4MDAwLDAsMjkwMDBdLCJBbmltYWwgVHJhaW5lciI6WzM2MjUwLDcyNTAwLDBdLCJBcXVhcmlzdCI6WzAsMjkwMDAsNTgwMDBdLCJJbnRlcm4iOlsxNDUwMCwwLDcyNTBdLCJNYW5hZ2VyIjpbMCw1ODAwMCwxMTYwMDBdLCJCb29ra2VlcGVyIjpbMCw0MzUwMCw4NzAwMF0sIlBob3RvZ3JhcGhlciI6WzAsMTE2MDAwLDU4MDAwXSwiQ29uc3VsdGFudCI6WzAsMTc0MDAwLDg3MDAwXSwiVmV0ZXJpbmFyaWFuIjpbNTgwMDAsMTE2MDAwLDBdLCJDYXNoaWVyIjpbMCwxNDUwMCwyOTAwMF19LCJBbXVzZW1lbnQgUGFyayI6eyJJbnNwZWN0b3IiOlswLDEzNTAwMCw2NzUwMF0sIk1hbmFnZXIiOlswLDQ1MDAwLDkwMDAwXSwiTWFya2V0ZXIiOlswLDkwMDAwLDQ1MDAwXSwiU2VjdXJpdHkgR3VhcmQiOls3OTAwMCwwLDM5NTAwXSwiTWVjaGFuaWMiOls2NzUwMCwzMzc1MCwwXSwiQWNjb3VudGFudCI6WzAsMzM3NTAsNjc1MDBdLCJSaWRlIEF0dGVuZGFudCI6WzAsMjI1MDAsNDUwMDBdLCJFbnRlcnRhaW5lciI6WzM0MDAwLDAsMTcwMDBdLCJUaWNrZXQgQWdlbnQiOlswLDExMjUwLDIyNTAwXSwiSmFuaXRvciI6WzIyNTAwLDAsMTEyNTBdfSwiRnVybml0dXJlIFN0b3JlIjp7IlNhbGVzIENsZXJrIjpbMCwzMjUwLDY1MDBdLCJEZWxpdmVyeSBEcml2ZXIiOls4MDAwLDAsNDAwMF0sIkFwcHJlbnRpY2UiOlswLDc1MCwxNTAwXSwiQ2xlYW5lciI6WzM1MDAsMCwxNzUwXSwiTWFuYWdlciI6WzAsNjUwMCwxMzAwMF0sIlJlY2VwdGlvbmlzdCI6WzAsNTAwMCwxMDAwMF0sIk1hcmtldGVyIjpbMCwxMzAwMCw2NTAwXSwiVHJhaW5lciI6WzAsMTk1MDAsOTc1MF19LCJHYXMgU3RhdGlvbiI6eyJBdHRlbmRhbnQiOlswLDEzMDAwLDI2MDAwXSwiQ2xlYW5lciI6WzE3NTAwLDAsODc1MF0sIk1hbmFnZXIiOlswLDMwMDAwLDYwMDAwXSwiTWFya2V0ZXIiOlswLDQwMDAwLDIwMDAwXSwiVHJhaW5lciI6WzAsNzA1MDAsMzUyNTBdfSwiTXVzaWMgU3RvcmUiOnsiU2FsZXMgQXNzaXN0YW50IjpbMCwxNzUwLDM1MDBdLCJNdXNpY2lhbiI6WzQ1MDAsOTAwMCwwXSwiU2FsZXMgQXBwcmVudGljZSI6WzAsNTAwLDEwMDBdLCJDbGVhbmVyIjpbMjAwMCwwLDEwMDBdLCJTdXBlcnZpc29yIjpbMCwzNTAwLDcwMDBdLCJCb29ra2VlcGVyIjpbMCwyNzUwLDU1MDBdLCJUcmFpbmVyIjpbMCwxMDUwMCw1MjUwXX0sIk5pZ2h0Y2x1YiI6eyJCYXJ0ZW5kZXIiOlsxMzUwMCwwLDI3MDAwXSwiQm91bmNlciI6WzQ4MDAwLDAsMjQwMDBdLCJCYXJiYWNrIjpbMTAyNTAsMCwyMDUwMF0sIkNsZWFuZXIiOlsxMzUwMCwwLDY3NTBdLCJNYW5hZ2VyIjpbMCwyNzAwMCw1NDAwMF0sIlBlcnNvbmFsIEFzc2lzdGFudCI6WzAsMjAyNTAsNDA1MDBdLCJQcm9tb3RlciI6WzAsNTQwMDAsMjcwMDBdLCJUcmFpbmVyIjpbMCw4MTAwMCw0MDUwMF0sIkRpc2stam9ja2V5IjpbMCw0MDUwMCwyMDI1MF19LCJQdWIiOnsiQmFydGVuZGVyIjpbMTUwMCwwLDMwMDBdLCJCb3VuY2VyIjpbNjAwMCwwLDMwMDBdLCJXYWl0ZXIiOlsxNTAwLDAsMzAwMF0sIkNsZWFuZXIiOlsxNTAwLDAsNzUwXSwiTWFuYWdlciI6WzAsMzAwMCw2MDAwXSwiQm9va2tlZXBlciI6WzAsMjI1MCw0NTAwXSwiVHJhaW5lciI6WzAsOTAwMCw0NTAwXSwiUHJvbW90ZXIiOlswLDYwMDAsMzAwMF19LCJSZXN0YXVyYW50Ijp7IldhaXRlciI6WzEyNTAsMCwyNTAwXSwiU291cyBDaGVmIjpbMCw0MDAwLDIwMDBdLCJIZWFkIENoZWYiOlswLDI1MDAsNTAwMF0sIktpdGNoZW4gQXNzaXN0YW50IjpbMTUwMCwwLDc1MF0sIkhlYWQgV2FpdGVyIjpbMCwyMDAwLDQwMDBdLCJMaW5lIENvb2siOlsxMjUwLDI1MDAsMF0sIkNoZWYiOlsxNTAwLDMwMDAsMF0sIkFwcHJlbnRpY2UgQ2hlZiI6Wzc1MCwxNTAwLDBdLCJEaXNod2FzaGVyIjpbMTUwMCwwLDc1MF19LCJTb2Z0d2FyZSBDb3Jwb3JhdGlvbiI6eyJEZXZlbG9wZXIiOlswLDI0MDAwLDEyMDAwXSwiVGVzdGVyIjpbMCwxMjAwMCw2MDAwXSwiR3JhcGhpYyBEZXNpZ25lciI6WzAsMTgwMDAsOTAwMF0sIkFwcHJlbnRpY2UiOlswLDYwMDAsMzAwMF0sIkNsZWFuZXIiOlsxMjAwMCwwLDYwMDBdLCJMZWFkIERldmVsb3BlciI6WzAsMjQwMDAsNDgwMDBdLCJBbmFseXN0IjpbMCwxODAwMCwzNjAwMF0sIk1hcmtldGVyIjpbMCw0ODAwMCwyNDAwMF0sIkNvbnN1bHRhbnQiOlswLDcyMDAwLDM2MDAwXX0sIk1lY2hhbmljIFNob3AiOnsiVGVjaG5pY2lhbiI6Wzg1MDAsMCw0MjUwXSwiQXBwcmVudGljZSBUZWNobmljaWFuIjpbMjAwMCwwLDEwMDBdLCJDbGVhbmVyIjpbNDUwMCwwLDIyNTBdLCJNYW5hZ2VyIjpbMCw4NTAwLDE3MDAwXSwiUmVjZXB0aW9uaXN0IjpbMCw2NTAwLDEzMDAwXSwiVHJhaW5lciI6WzAsMjU1MDAsMTI3NTBdfSwiRml0bmVzcyBDZW50ZXIiOnsiUGVyc29uYWwgVHJhaW5lciI6WzMxMDAwLDAsMTU1MDBdLCJTd2ltbWluZyBJbnN0cnVjdG9yIjpbMjMyNTAsMCw0NjUwMF0sIkxpZmVndWFyZCI6WzE5NTAwLDAsMzkwMDBdLCJDbGVhbmVyIjpbMTU1MDAsMCw3NzUwXSwiTWFuYWdlciI6WzAsMzEwMDAsNjIwMDBdLCJSZWNlcHRpb25pc3QiOlswLDUwMDAsMTAwMDBdLCJNYXJrZXRlciI6WzAsNjIwMDAsMzEwMDBdLCJIdW1hbiBSZXNvdXJjZXMiOlswLDIzMjUwLDQ2NTAwXSwiTnV0cml0aW9uaXN0IjpbMjcyNTAsNTQ1MDAsMF0sIkZpdG5lc3MgSW5zdHJ1Y3RvciI6WzQ2NTAwLDAsMjMyNTBdfSwiTGluZ2VyaWUgU3RvcmUiOnsiU2FsZXNwZXJzb24iOlswLDIyNTAsNDUwMF0sIkNsZWFuZXIiOlsyNTAwLDAsMTI1MF0sIlN0b3JlIE1hbmFnZXIiOlswLDQ1MDAsOTAwMF0sIkxpbmdlcmllIE1vZGVsIjpbMCw5MDAwLDQ1MDBdLCJIdW1hbiBSZXNvdXJjZXMiOlswLDEzNTAwLDY3NTBdLCJUcmFpbmVlIjpbMCw1MDAsMTAwMF19LCJGYXJtIjp7IkhhcnZlc3RlciI6WzE0MDAwLDAsNzAwMF0sIkRlbGl2ZXJ5IERyaXZlciI6WzIzMDAwLDAsMTE1MDBdLCJIZXJkc3BlcnNvbiI6WzE4NTAwLDAsOTI1MF0sIkZhcm0gTWFuYWdlciI6WzAsMTg1MDAsMzcwMDBdLCJCb29ra2VlcGVyIjpbMCwxNDAwMCwyODAwMF0sIkNvbnN1bHRhbnQiOlswLDU1NTAwLDI3NzUwXSwiUmV0YWlsZXIiOlswLDE4NTAwLDkyNTBdLCJEYWlyeSBGYXJtZXIiOlsyMzAwMCwwLDExNTAwXSwiUG91bHRyeSBGYXJtZXIiOlsxODUwMCwwLDkyNTBdfSwiTWluaW5nIENvcnBvcmF0aW9uIjp7IlNhbGVzIEV4ZWN1dGl2ZSI6WzAsODMwMDAsNDE1MDBdLCJNaWxsIE9wZXJhdG9yIjpbNzUwMDAsMCwzNzUwMF0sIlByb2R1Y3Rpb24gRm9yZW1hbiI6WzM5NTAwLDAsNzkwMDBdLCJNaW5lIEVuZ2luZWVyIjpbMCw4MTAwMCw0MDUwMF0sIkVsZWN0cmljaWFuIjpbMzkwMDAsMCw3ODAwMF0sIlNhZmV0eSBJbnNwZWN0b3IiOls0NzUwMCw5NTAwMCwwXSwiU2l0ZSBNYW5hZ2VyIjpbMCw5NzAwMCw0ODc1MF0sIlNlY3JldGFyeSI6WzAsMzkwMDAsNzgwMDBdfSwiT2lsIFJpZyI6eyJEcmlsbGVyIjpbMTUwMDAwLDc1MDAwLDBdLCJSb3VnaG5lY2siOls3NTAwMCwwLDM3NTAwXSwiRGVycmljayBIYW5kIjpbOTQwMDAsMCw0NzAwMF0sIlNlY3JldGFyeSI6WzAsNTYyNTAsMTEyNTAwXSwiSW5zcGVjdG9yIjpbMCwyMjUwMDAsMTEyNTAwXSwiU2FsZXMgRXhlY3V0aXZlIjpbMCwxMzE1MDAsNjU3NTBdLCJNb3RvciBIYW5kIjpbMTEyNTAwLDU2MjUwLDBdfSwiUHJvcGVydHkgQnJva2VyIjp7IlByb3BlcnR5IEJyb2tlciI6WzAsNzUwLDE1MDBdLCJWYWx1YXRpb24gU3BlY2lhbGlzdCI6WzAsMzAwMCwxNTAwXSwiQXNzb2NpYXRlIEJyb2tlciI6WzAsMjUwLDUwMF0sIkNsZWFuZXIiOlsxMDAwLDAsNTAwXSwiVGVhbSBNYW5hZ2VyIjpbMCwxNTAwLDMwMDBdLCJSZWNlcHRpb25pc3QiOlswLDEyNTAsMjUwMF0sIkdyYXBoaWMgRGVzaWduZXIiOlswLDMwMDAsMTUwMF0sIkJyb2tlciBTdXBwb3J0IjpbMCw0NTAwLDIyNTBdfSwiUHJpdmF0ZSBTZWN1cml0eSBGaXJtIjp7IlNlY3VyaXR5IENvbnRyYWN0b3IiOls3MDAwMCwwLDM1MDAwXSwiVGVhbSBMZWFkZXIiOlsxMTAwMDAsMCw1NTAwMF0sIkRlZmVuY2UgQ29uc3VsdGFudCI6WzAsMTM1MDAwLDY3NTAwXSwiU3Bva2VzcGVyc29uIjpbMCw4MDAwMCw0MDAwMF0sIkNvbXBhbnkgTGlhaXNvbiI6WzAsNTc1MDAsMTE1MDAwXSwiQ2hpZWYgU3RyYXRlZ2lzdCI6WzAsMTY1MDAwLDgyNTAwXSwiUmVjb25uYWlzc2FuY2UiOls4MDAwMCw0MDAwMCwwXSwiRGlzcG9zYWwgRW5naW5lZXIiOlswLDg1MDAwLDQyNTAwXSwiQXJtb3VyZXIiOls0MDAwMCwwLDgwMDAwXSwiTWVkaWMiOlswLDkwMDAwLDQ1MDAwXSwiQ29tbXMgRW5naW5lZXIiOlswLDg1MDAwLDQyNTAwXX0sIkRldGVjdGl2ZSBBZ2VuY3kiOnsiUHJpdmF0ZSBJbnZlc3RpZ2F0b3IiOlsyMjUwMCw0NTUwMCwwXSwiVHJhaW5lZSBJbnZlc3RpZ2F0b3IiOlsxNDAwMCwyODAwMCwwXSwiU2VjcmV0YXJ5IjpbMTI1MDAsMCwyNTAwMF0sIkludGVsbGlnZW5jZSBBbmFseXN0IjpbMCw1ODAwMCwyOTAwMF0sIlN1cnZlaWxsYW5jZSI6WzI2MDAwLDUyMDAwLDBdLCJDaGllZiBJbnZlc3RpZ2F0b3IiOls0MDAwMCw4MDAwMCwwXSwiQ2xpZW50IExpYWlzb24iOlswLDYyMDAwLDMxMDAwXX0sIkZpcmV3b3JrIFN0YW5kIjp7IlNhbGVzcGVyc29uIjpbMCw1MDAsMTAwMF0sIlB5cm90ZWNobmljaWFuIjpbMzAwMCwxNTAwLDBdLCJQaWNrZXIgIFBhY2tlciI6WzUwMCwwLDI1MF0sIk1hbmFnZXIiOlswLDEwMDAsMjAwMF0sIkJvb2trZWVwZXIiOlswLDc1MCwxNTAwXSwiQWR2ZXJ0aXNpbmcgTWFuYWdlciI6WzAsMjAwMCwxMDAwXSwiVHJhaW5lciI6WzAsMzAwMCwxNTAwXX0sIk1lYXQgV2FyZWhvdXNlIjp7IlF1YWxpdHkgQ29udHJvbGxlciI6WzEyNTAwLDI1MDAwLDBdLCJQYWNrZXIiOls5NTAwLDAsNDc1MF0sIkFwcHJlbnRpY2UgQnV0Y2hlciI6WzMwMDAsMCwxNTAwXSwiQ2xlYW5lciI6WzY1MDAsMCwzMjUwXSwiTWFuYWdlciI6WzAsMTI1MDAsMjUwMDBdLCJBc3Npc3RhbnQiOlswLDk1MDAsMTkwMDBdLCJTdXBlcnZpc29yIjpbMCwzNzUwMCwxODc1MF0sIkJ1dGNoZXIiOlsxMjUwMCwwLDYyNTBdLCJSZXRhaWxlciI6WzAsMTI1MDAsNjI1MF19LCJMb2dpc3RpY3MgTWFuYWdlbWVudCI6eyJMdW1wZXIiOls0NTAwMCwwLDIyNTAwXSwiRHJpdmVyIjpbMjg3NTAsMCw1NzUwMF0sIkZvcmtsaWZ0IE9wZXJhdG9yIjpbMzAwMDAsMCw2MDAwMF0sIlRyYW5zcG9ydCBDb29yZGluYXRvciI6WzAsODUwMDAsNDI1MDBdLCJXYXJlaG91c2UgTWFuYWdlciI6WzAsMTE1MDAwLDU3NTAwXSwiU2hpZnQgTWFuYWdlciI6WzAsOTAwMDAsNDUwMDBdLCJTdXBwbHkgQ2hhaW4gTWFuYWdlciI6WzAsMTI1MDAwLDYyNTAwXSwiUHJvY3VyZW1lbnQgTWFuYWdlciI6WzAsMTQwMDAwLDcwMDAwXX0sIkdlbnRzIFN0cmlwIENsdWIiOnsiU3RyaXBwZXIiOls3MjUwLDAsMTQ1MDBdLCJTZWN1cml0eSI6WzI5MDAwLDAsMTQ1MDBdLCJDbGVhbmVyIjpbNzUwMCwwLDM3NTBdLCJNYW5hZ2VyIjpbMCwxNDUwMCwyOTAwMF0sIkJvb2trZWVwZXIiOlswLDExMDAwLDIyMDAwXSwiUGhvdG9ncmFwaGVyIjpbMCwyOTAwMCwxNDUwMF19fQ==";
    const decodeBase64Text = (value) => {
        if (typeof atob === "function") return atob(value);
        if (typeof Buffer !== "undefined") return Buffer.from(value, "base64").toString("utf8");
        return "";
    };
    const POSITION_REQUIREMENTS = (() => {
        try {
            return Object.freeze(JSON.parse(decodeBase64Text(POSITION_REQUIREMENTS_B64)));
        } catch {
            return Object.freeze({});
        }
    })();

    const asNumber = (value, fallback = 0) => {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    };
    const asFinite = (value) => {
        if (value === null || value === undefined || value === "") return null;
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
    const formatAverageEffectiveness = (value) => {
        const number = asFinite(value);
        return number === null ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(number);
    };
    const preferredCurrentEfficiency = (tornTotal, calculatedWorkingStats, nonWorkingDelta) => {
        const base = asFinite(calculatedWorkingStats);
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
    const documentIsHidden = () => {
        try {
            return typeof document !== "undefined" && document.hidden === true;
        } catch {
            return false;
        }
    };
    const injectedTornApiKey = () => {
        const key = String(PDA_INJECTED_TORN_KEY || "").trim();
        return key.includes("###PDA-APIKEY###") ? "" : key;
    };
    const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
    const canonicalName = (value) => String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const positionRequirementsFor = (companyType, position) => {
        const typeName = Object.keys(POSITION_REQUIREMENTS).find((name) => canonicalName(name) === canonicalName(companyType));
        const roles = typeName ? POSITION_REQUIREMENTS[typeName] : null;
        if (!roles) return null;
        const roleName = Object.keys(roles).find((name) => canonicalName(name) === canonicalName(position));
        const requirements = roleName ? roles[roleName] : null;
        return Array.isArray(requirements) && requirements.length === 3 ? requirements : null;
    };
    const roleStatEfficiency = (stat, requirement) => {
        const actual = asFinite(stat);
        const needed = asFinite(requirement);
        if (actual === null || needed === null || needed <= 0) return null;
        const ratio = Math.max(0, actual) * 1.2 / needed;
        return Math.floor(Math.min(45, 45 * ratio) + Math.max(0, 5 * Math.log2(ratio)));
    };
    const calculateLocalRoleEfficiencies = (companyType, stats) => {
        const typeName = Object.keys(POSITION_REQUIREMENTS).find((name) => canonicalName(name) === canonicalName(companyType));
        const roles = typeName ? POSITION_REQUIREMENTS[typeName] : null;
        if (!roles || !isObject(stats)) return {};
        const statValues = [stats.manual_labor, stats.intelligence, stats.endurance];
        return Object.fromEntries(Object.entries(roles).map(([role, requirements]) => {
            const parts = requirements
                .map((required, index) => required > 0 ? roleStatEfficiency(statValues[index], required) : 0);
            return [role, parts.some((part) => part === null) ? null : Math.trunc(parts.reduce((sum, part) => sum + part, 0))];
        }));
    };
    const localRoleTotalEfficiency = (employee, companyType, position) => {
        const base = calculateLocalRoleEfficiencies(companyType, employee?.stats || {})[position];
        const effectiveness = isObject(employee?.effectiveness) ? employee.effectiveness : {};
        const nonWorkingDelta = asNumber(effectiveness.total) - asNumber(effectiveness.working_stats);
        return preferredCurrentEfficiency(effectiveness.total, base, nonWorkingDelta);
    };
    const normalizeCompanyId = (value) => {
        const numeric = asFinite(value);
        return numeric === null || numeric <= 0 ? "" : String(Math.trunc(numeric));
    };
    const normalizeAccount = (raw, idHint = "") => {
        if (!isObject(raw)) return null;
        const id = normalizeCompanyId(raw.id ?? idHint);
        if (!id) return null;
        return {
            id,
            name: String(raw.name || raw.companyName || "Company").trim() || "Company",
            typeId: normalizeCompanyId(raw.typeId ?? raw.companyTypeId),
            typeName: String(raw.typeName || raw.companyTypeName || "").trim(),
            key: String(raw.key || raw.apiKey || "").trim(),
            source: raw.source === "pda" ? "pda" : "saved",
            addedAt: asNumber(raw.addedAt),
            verifiedAt: asNumber(raw.verifiedAt),
            lastAttemptAt: asNumber(raw.lastAttemptAt),
            lastSuccessAt: asNumber(raw.lastSuccessAt),
            lastError: String(raw.lastError || "").slice(0, 280)
        };
    };
    const companyAccountMap = (settings = {}, legacyProfile = null) => {
        const rawAccounts = isObject(settings?.companyAccounts) ? settings.companyAccounts : {};
        const accounts = Object.entries(rawAccounts).reduce((next, [id, account]) => {
            const normalized = normalizeAccount(account, id);
            if (normalized) next[normalized.id] = normalized;
            return next;
        }, {});
        const legacyId = normalizeCompanyId(legacyProfile?.id);
        const legacyKey = String(settings?.tornKey || "").trim();
        if (legacyId && legacyKey && !accounts[legacyId]) {
            accounts[legacyId] = normalizeAccount({
                id: legacyId,
                name: legacyProfile?.name,
                typeId: legacyProfile?.company_type?.id ?? legacyProfile?.type?.id,
                typeName: legacyProfile?.company_type?.name ?? legacyProfile?.type?.name,
                key: legacyKey,
                source: "saved",
                addedAt: Date.now()
            }, legacyId);
        }
        return accounts;
    };
    const activeCompanyId = () => normalizeCompanyId(state.settings.activeCompanyId)
        || normalizeCompanyId(state.data?.profile?.id)
        || Object.keys(state.cacheByCompany)[0]
        || Object.keys(companyAccountMap(state.settings))[0]
        || "";
    const accountForCompany = (companyId = activeCompanyId()) => companyAccountMap(state.settings)[normalizeCompanyId(companyId)] || null;
    const accountKey = (account) => account?.source === "pda" ? injectedTornApiKey() : String(account?.key || "").trim();
    const activeTornApiKey = () => accountKey(accountForCompany()) || injectedTornApiKey();
    const hasTornApiKey = () => Boolean(activeTornApiKey());
    const selectableCompanyOptions = (accounts, activeId = "", transientProfile = null) => {
        const normalized = Object.values(accounts || {}).map((account) => normalizeAccount(account)).filter(Boolean);
        const transientId = normalizeCompanyId(transientProfile?.id);
        if (transientId && !normalized.some((account) => account.id === transientId)) {
            normalized.push(normalizeAccount({
                id: transientId,
                name: transientProfile?.name,
                typeId: transientProfile?.company_type?.id ?? transientProfile?.type?.id,
                typeName: transientProfile?.company_type?.name ?? transientProfile?.type?.name,
                source: "pda"
            }, transientId));
        }
        return normalized
            .sort((left, right) => left.name.localeCompare(right.name) || Number(left.id) - Number(right.id))
            .map((account) => ({ value: account.id, label: account.id === String(activeId) ? `${account.name} (current)` : account.name, account }))
            .concat({ value: "__add__", label: "Add company…", account: null });
    };
    const sortRows = (rows, { key, dir }) => [...rows].sort((left, right) => {
        const a = typeof key === "function" ? key(left) : left[key];
        const b = typeof key === "function" ? key(right) : right[key];
        const an = asFinite(a);
        const bn = asFinite(b);
        if (an !== null && bn !== null) return dir === "asc" ? an - bn : bn - an;
        return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true }) * (dir === "asc" ? 1 : -1);
    });
    const deepMergeSettings = (raw) => {
        const merged = {
            ...DEFAULT_SETTINGS,
            ...(isObject(raw) ? raw : {}),
            companyAccounts: companyAccountMap(raw),
            activeCompanyId: normalizeCompanyId(raw?.activeCompanyId),
            dailyAlertMode: ["off", "combined", "separate", "selected"].includes(raw?.dailyAlertMode) ? raw.dailyAlertMode : "off",
            sourceTimes: isObject(raw?.sourceTimes) ? raw.sourceTimes : {},
            assignments: isObject(raw?.assignments) ? raw.assignments : {},
            lockedEmployees: isObject(raw?.lockedEmployees) ? raw.lockedEmployees : {},
            positionCapacities: isObject(raw?.positionCapacities) ? raw.positionCapacities : {},
            positionPriority: isObject(raw?.positionPriority) ? raw.positionPriority : {}
        };
        // Legacy flat keys are only read once while building a validated Company-ID account.
        delete merged.tornKey;
        delete merged.tornStatsKey;
        delete merged.projectionConsent;
        return merged;
    };

    function jsonBackupClone(value, fallback = null) {
        try {
            const serialized = JSON.stringify(value);
            return serialized === undefined ? fallback : JSON.parse(serialized);
        } catch {
            return fallback;
        }
    }

    function createCompanyBackupDocument(values, { includeApiKeys = false, timestamp = Date.now(), appVersion = VERSION } = {}) {
        const source = isObject(values) ? values : {};
        const stores = Object.fromEntries(BACKUP_STORE_KEYS.map((key) => [key, jsonBackupClone(source[key], key === STORE.cache ? null : {})]));
        stores[STORE.settings] = isObject(stores[STORE.settings]) ? stores[STORE.settings] : {};
        delete stores[STORE.settings].tornKey;
        delete stores[STORE.settings].tornStatsKey;
        delete stores[STORE.settings].projectionConsent;
        if (!includeApiKeys) {
            if (isObject(stores[STORE.settings].companyAccounts)) {
                Object.values(stores[STORE.settings].companyAccounts).forEach((account) => {
                    if (isObject(account)) delete account.key;
                });
            }
        }
        return {
            format: BACKUP_FORMAT,
            namespace: BACKUP_NAMESPACE,
            schemaVersion: BACKUP_SCHEMA_VERSION,
            appVersion: String(appVersion),
            createdAt: new Date(timestamp).toISOString(),
            includesApiKeys: Boolean(includeApiKeys),
            stores
        };
    }

    function backupValidationError(message) {
        throw new Error(`Backup is invalid: ${message}.`);
    }

    function validateCompanyBackupDocument(raw) {
        if (!isObject(raw)) backupValidationError("expected a JSON object");
        const allowedTopLevel = new Set(["format", "namespace", "schemaVersion", "appVersion", "createdAt", "includesApiKeys", "stores"]);
        if (Object.keys(raw).some((key) => !allowedTopLevel.has(key))) backupValidationError("contains unsupported top-level fields");
        if (raw.format !== BACKUP_FORMAT) backupValidationError("wrong backup format");
        if (raw.namespace !== BACKUP_NAMESPACE) backupValidationError("wrong script namespace");
        if (![1, BACKUP_SCHEMA_VERSION].includes(raw.schemaVersion)) backupValidationError("unsupported schema version");
        if (typeof raw.appVersion !== "string" || !raw.appVersion.trim()) backupValidationError("missing application version");
        if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) backupValidationError("invalid creation time");
        if (typeof raw.includesApiKeys !== "boolean") backupValidationError("invalid API-key inclusion flag");
        if (!isObject(raw.stores)) backupValidationError("missing store payload");
        const storeNames = Object.keys(raw.stores);
        const expectedStoreKeys = raw.schemaVersion === 1 ? LEGACY_BACKUP_STORE_KEYS : BACKUP_STORE_KEYS;
        if (storeNames.length !== expectedStoreKeys.length || expectedStoreKeys.some((key) => !hasOwn(raw.stores, key)) || storeNames.some((key) => !expectedStoreKeys.includes(key))) backupValidationError("store namespace does not match this companion");
        if (!isObject(raw.stores[STORE.settings])) backupValidationError("invalid settings payload");
        if (raw.stores[STORE.cache] !== null && !isObject(raw.stores[STORE.cache])) backupValidationError("invalid cached snapshot payload");
        expectedStoreKeys.filter((key) => key !== STORE.settings && key !== STORE.cache).forEach((key) => {
            if (!isObject(raw.stores[key])) backupValidationError(`invalid ${key} payload`);
        });
        const settings = raw.stores[STORE.settings];
        const allowedSettings = new Set([...Object.keys(DEFAULT_SETTINGS), "tornKey", "tornStatsKey", "projectionConsent"]);
        if (Object.keys(settings).some((key) => !allowedSettings.has(key))) backupValidationError("settings payload contains unsupported fields");
        ["projectionConsent", "includeStockCost", "dailyTickToasts", "dailyTickNotifications", "useLegacyGMStorage"].forEach((key) => {
            if (hasOwn(settings, key) && typeof settings[key] !== "boolean") backupValidationError(`invalid ${key} setting`);
        });
        if (hasOwn(settings, "autoRefreshMinutes") && (!Number.isFinite(Number(settings.autoRefreshMinutes)) || Number(settings.autoRefreshMinutes) < 2 || Number(settings.autoRefreshMinutes) > 120)) backupValidationError("invalid automatic refresh setting");
        if (hasOwn(settings, "activeTab") && typeof settings.activeTab !== "string") backupValidationError("invalid active-tab setting");
        ["assignments", "lockedEmployees", "positionCapacities", "positionPriority", "companyAccounts", "sourceTimes"].forEach((key) => {
            if (hasOwn(settings, key) && !isObject(settings[key])) backupValidationError(`invalid ${key} setting`);
        });
        if (hasOwn(settings, "activeCompanyId") && typeof settings.activeCompanyId !== "string") backupValidationError("invalid active-company setting");
        if (hasOwn(settings, "dailyAlertMode") && !["off", "combined", "separate", "selected"].includes(settings.dailyAlertMode)) backupValidationError("invalid alert-mode setting");
        const accounts = isObject(settings.companyAccounts) ? settings.companyAccounts : {};
        const nestedKeyPresent = Object.values(accounts).some((account) => isObject(account) && typeof account.key === "string" && account.key.length > 0);
        if (!raw.includesApiKeys && (hasOwn(settings, "tornKey") || hasOwn(settings, "tornStatsKey") || nestedKeyPresent)) {
            backupValidationError("non-key backup contains API-key fields");
        }
        return jsonBackupClone(raw);
    }

    function materializeCompanyBackupStores(backup, { currentSettings = state.settings, restoreApiKeys = false } = {}) {
        const validated = validateCompanyBackupDocument(backup);
        const current = deepMergeSettings(currentSettings);
        const migrated = migrateLegacyCompanyStores(validated.stores);
        const restoredSettings = migrated.settings;
        const restoreKeys = Boolean(restoreApiKeys) && validated.includesApiKeys;
        if (!restoreKeys) {
            const restoredAccounts = companyAccountMap(restoredSettings);
            const currentAccounts = companyAccountMap(current);
            Object.keys(restoredAccounts).forEach((id) => {
                if (currentAccounts[id]?.key) restoredAccounts[id].key = currentAccounts[id].key;
                else delete restoredAccounts[id].key;
            });
            restoredSettings.companyAccounts = restoredAccounts;
            delete restoredSettings.tornKey;
        }
        restoredSettings.useLegacyGMStorage = current.useLegacyGMStorage;
        delete restoredSettings.tornStatsKey;
        delete restoredSettings.projectionConsent;
        return {
            [STORE.settings]: restoredSettings,
            [STORE.cache]: migrated.cache,
            [STORE.history]: validated.stores[STORE.history],
            [STORE.rankings]: validated.stores[STORE.rankings],
            [STORE.rankHistory]: validated.stores[STORE.rankHistory],
            [STORE.starCohorts]: validated.stores[STORE.starCohorts],
            [STORE.layout]: { ...DEFAULT_LAYOUT, ...validated.stores[STORE.layout] },
            [STORE.dailyAlerts]: validated.stores[STORE.dailyAlerts],
            [STORE.dailyReminders]: validated.stores[STORE.dailyReminders],
            [STORE.dailySync]: isObject(validated.stores[STORE.dailySync]) ? validated.stores[STORE.dailySync] : {}
        };
    }

    function safeRequestDescriptor(url, method = "GET") {
        const normalizedMethod = String(method || "GET").toUpperCase();
        try {
            const parsed = new URL(String(url));
            let path = parsed.pathname || "/";
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

    function hasLegacyStoragePreference(values) {
        return hasOwn(values?.[STORE.settings], "useLegacyGMStorage");
    }

    function storageMethodLabel({ mode = storage.mode, useLegacyGMStorage = state.settings.useLegacyGMStorage } = {}) {
        if (useLegacyGMStorage) return "Legacy GM storage (selected)";
        if (mode === "pda") return "TornPDA PDA_storage (primary)";
        return "Compatible GM/local fallback";
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

    function createStorageAdapter({
        keys = STORE_KEYS,
        getNative = () => null,
        legacy = {},
        preferNative = () => true,
        writeMany = null,
        debounceMs = STORAGE_WRITE_DEBOUNCE_MS,
        setTimer = setTimeout,
        clearTimer = clearTimeout
    } = {}) {
        const allowed = new Set(keys);
        let queue = {};
        let timer = null;
        let flushing = null;
        let waiters = [];
        const known = (values) => Object.fromEntries(Object.entries(values || {}).filter(([key]) => allowed.has(key)));
        const resolveWaiters = (list, error = null) => list.forEach(({ resolve, reject }) => error ? reject(error) : resolve());
        const loadLegacy = async () => {
            const values = await legacy.loadAll?.();
            return isObject(values) ? values : {};
        };
        const nativePreferred = () => preferNative() && getNative()?.loadAll && getNative()?.setMany;

        async function load() {
            const legacyValues = await loadLegacy();
            const native = nativePreferred() ? getNative() : null;
            if (!native) return { values: legacyValues, mode: "legacy", migrated: {} };
            try {
                const loaded = await native.loadAll();
                const nativeValues = isObject(loaded) ? loaded : {};
                const migrated = Object.fromEntries([...allowed].filter((key) => !hasOwn(nativeValues, key) && hasOwn(legacyValues, key)).map((key) => [key, legacyValues[key]]));
                if (Object.keys(migrated).length) await native.setMany(migrated);
                return { values: { ...legacyValues, ...nativeValues }, mode: "pda", migrated };
            } catch (error) {
                return { values: legacyValues, mode: "legacy", migrated: {}, error };
            }
        }

        async function writeNow(values) {
            if (typeof writeMany === "function") return writeMany(values);
            const native = nativePreferred() ? getNative() : null;
            if (native) {
                try {
                    await native.setMany(values);
                    return { mode: "pda", fallback: false };
                } catch (error) {
                    if (typeof legacy.setMany !== "function") throw error;
                    await legacy.setMany(values);
                    return { mode: "legacy", fallback: true, error };
                }
            }
            if (typeof legacy.setMany !== "function") throw new Error("No compatible storage writer is available.");
            await legacy.setMany(values);
            return { mode: "legacy", fallback: false };
        }

        function flush() {
            if (flushing) return flushing;
            if (timer) {
                clearTimer(timer);
                timer = null;
            }
            const pending = queue;
            const pendingWaiters = waiters;
            queue = {};
            waiters = [];
            if (!Object.keys(pending).length) {
                resolveWaiters(pendingWaiters);
                return Promise.resolve();
            }
            flushing = Promise.resolve(writeNow(pending))
                .then(() => resolveWaiters(pendingWaiters), (error) => resolveWaiters(pendingWaiters, error))
                .finally(() => {
                    flushing = null;
                    if (Object.keys(queue).length) void flush();
                });
            return flushing;
        }

        function setMany(values, { immediate = false } = {}) {
            const next = known(values);
            if (!Object.keys(next).length) return Promise.resolve();
            return new Promise((resolve, reject) => {
                Object.assign(queue, next);
                waiters.push({ resolve, reject });
                if (immediate || flushing) {
                    void flush();
                    return;
                }
                if (timer) clearTimer(timer);
                timer = setTimer(() => { void flush(); }, debounceMs);
            });
        }

        async function deleteKey(key) {
            delete queue[key];
            if (timer && !Object.keys(queue).length) void flush();
            const native = getNative();
            let nativeError = null;
            if (native?.delete) {
                try {
                    await native.delete(key);
                } catch (error) {
                    nativeError = error;
                }
            }
            if (typeof legacy.delete === "function") await legacy.delete(key);
            if (nativeError && typeof legacy.delete !== "function") throw nativeError;
            return { nativeDeleted: Boolean(native?.delete) && !nativeError, fallbackDeleted: typeof legacy.delete === "function" };
        }

        return { load, setMany, flush, delete: deleteKey, pending: () => ({ ...queue }) };
    }

    async function writeStoreSetMany(values) {
        const entries = Object.entries(values).filter(([key]) => STORE_KEYS.includes(key));
        if (!entries.length) return;
        const next = Object.fromEntries(entries);
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

    const storageWriter = createStorageAdapter({
        keys: STORE_KEYS,
        getNative: () => storage.pda || getPdaStorage(),
        legacy: { delete: legacyDelete },
        writeMany: writeStoreSetMany
    });

    function flushStorageWrites() {
        return storageWriter.flush();
    }

    function storeSetMany(values, { immediate = false } = {}) {
        const entries = Object.entries(values).filter(([key]) => STORE_KEYS.includes(key));
        if (!entries.length) return Promise.resolve();
        const next = Object.fromEntries(entries);
        Object.assign(storage.cache, next);
        return storageWriter.setMany(next, { immediate });
    }

    function storeSet(key, value, options = {}) {
        return storeSetMany({ [key]: value }, options);
    }

    async function storeDelete(key) {
        delete storage.cache[key];
        const result = await storageWriter.delete(key);
        if (!result.nativeDeleted && getPdaStorage()) showStorageWarning(new Error("PDA_storage delete failed."));
        storage.fallbackKeys.delete(key);
        await persistFallbackKeys();
    }

    async function removeLegacyProjectionStore() {
        const pda = storage.pda || getPdaStorage();
        try {
            if (typeof pda?.delete === "function") await pda.delete(LEGACY_PROJECTION_STORE);
        } catch (error) {
            warningLog("storage:legacy projection cleanup failed", { reason: safeDiagnosticError(error) });
        }
        await legacyDelete(LEGACY_PROJECTION_STORE);
    }

    async function switchStoragePreference(useLegacyGMStorage) {
        const snapshot = Object.fromEntries(STORE_KEYS.filter((key) => hasOwn(storage.cache, key)).map((key) => [key, storage.cache[key]]));
        snapshot[STORE.settings] = state.settings;
        if (useLegacyGMStorage) {
            try {
                const pda = storage.pda || getPdaStorage();
                if (pda) {
                    try {
                        await pda.setMany({ [STORE.settings]: state.settings });
                    } catch (error) {
                        warningLog("storage:legacy preference native mirror failed", { reason: safeDiagnosticError(error) });
                    }
                }
                await legacySetMany(snapshot);
                Object.assign(storage.cache, snapshot);
                storage.pda = null;
                storage.mode = "legacy";
                storage.fallbackKeys.clear();
                await persistFallbackKeys();
                state.storageWarning = "";
                debugLog("storage:legacy selected", { cachedKeys: Object.keys(snapshot).length });
                return true;
            } catch (error) {
                state.storageWarning = "Unable to switch to legacy GM storage; the current storage method remains active.";
                storageDiagnostic("storage:legacy selection failed", { reason: safeDiagnosticError(error) });
                return false;
            }
        }
        const pda = getPdaStorage();
        if (!pda) {
            try {
                await legacySetMany(snapshot);
                Object.assign(storage.cache, snapshot);
                storage.pda = null;
                storage.mode = "legacy";
                storageDiagnostic("storage:PDA_storage unavailable", { mode: "GM/local", reason: "legacy preference cleared" });
                return true;
            } catch (error) {
                showStorageWarning(error);
                return false;
            }
        }
        try {
            await legacySet(STORE.settings, state.settings);
            await pda.setMany(snapshot);
            Object.assign(storage.cache, snapshot);
            storage.pda = pda;
            storage.mode = "pda";
            Object.keys(snapshot).forEach((key) => storage.fallbackKeys.delete(key));
            await persistFallbackKeys();
            state.storageWarning = "";
            debugLog("storage:PDA_storage selected", { cachedKeys: Object.keys(snapshot).length });
            return true;
        } catch (error) {
            try {
                await legacySetMany(snapshot);
                Object.assign(storage.cache, snapshot);
                storage.pda = null;
                storage.mode = "legacy";
                showStorageWarning(error);
                return true;
            } catch {
                // The warning below tells the user the requested storage switch could not be completed.
            }
            storage.pda = null;
            storage.mode = "legacy";
            showStorageWarning(error);
            return false;
        }
    }

    async function loadStoredValues() {
        const pda = getPdaStorage();
        const legacyValues = await loadLegacyValues();
        if (!pda) {
            storage.cache = legacyValues;
            storage.pda = null;
            storage.mode = "legacy";
            storage.initialized = true;
            storageDiagnostic("storage:startup fallback", { mode: "GM/local", reason: "PDA_storage not exposed" });
            return storage.cache;
        }
        try {
            const loaded = await pda.loadAll();
            const pdaValues = isObject(loaded) ? loaded : {};
            const legacySettings = deepMergeSettings(legacyValues[STORE.settings]);
            const pdaSettings = deepMergeSettings(pdaValues[STORE.settings]);
            const legacyPreferenceIsExplicit = hasLegacyStoragePreference(legacyValues);
            if (legacySettings.useLegacyGMStorage || (!legacyPreferenceIsExplicit && pdaSettings.useLegacyGMStorage)) {
                const migratingFromPda = !legacyPreferenceIsExplicit && pdaSettings.useLegacyGMStorage;
                const mergedValues = migratingFromPda ? { ...legacyValues, ...pdaValues } : legacyValues;
                if (migratingFromPda) await legacySetMany(mergedValues);
                storage.cache = mergedValues;
                storage.pda = null;
                storage.mode = "legacy";
                storage.initialized = true;
                debugLog("storage:legacy selected", { migratedFromPda, cachedKeys: Object.keys(mergedValues).length });
                return storage.cache;
            }
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

    async function showFeedbackToast(text, tone = "good", seconds = 8) {
        const colors = tone === "bad"
            ? { bgColor: { a: 255, r: 125, g: 35, b: 47 }, textColor: { a: 255, r: 255, g: 245, b: 245 } }
            : tone === "warn"
                ? { bgColor: { a: 255, r: 112, g: 79, b: 20 }, textColor: { a: 255, r: 255, g: 246, b: 222 } }
                : { bgColor: { a: 255, r: 18, g: 94, b: 74 }, textColor: { a: 255, r: 238, g: 255, b: 248 } };
        const nativeResponse = await callConfirmedPdaHandler("showToast", {
            text,
            clickClose: true,
            seconds,
            ...colors
        });
        if (pdaHandlerSucceeded(nativeResponse)) return true;
        return showDesktopToast(text, tone, seconds);
    }

    function dailyAlertDeliveryChannels(settings = state.settings) {
        const source = isObject(settings) ? settings : {};
        return {
            toast: source.dailyTickToasts === true,
            notification: source.dailyTickNotifications === true
        };
    }

    function dailyTickAlertsEnabled(settings = state.settings) {
        const channels = dailyAlertDeliveryChannels(settings);
        return (channels.toast || channels.notification) && String(settings?.dailyAlertMode || "off") !== "off";
    }

    function alertTargetsForMode(mode, accounts, selectedId = "") {
        const entries = (Array.isArray(accounts) ? accounts : Object.values(accounts || {}))
            .map((account) => ({ id: account?.id, normalizedId: normalizeCompanyId(account?.id) }))
            .filter((entry) => entry.normalizedId);
        if (mode === "combined") return entries.length ? [entries.map((entry) => entry.id)] : [];
        if (mode === "separate") return entries.map((entry) => [entry.id]);
        if (mode === "selected") {
            const selected = entries.find((entry) => entry.normalizedId === normalizeCompanyId(selectedId));
            return selected ? [[selected.id]] : [];
        }
        return [];
    }

    function notificationIdForCompany(kind, companyId = "") {
        const base = asNumber(DAILY_ALERTS[kind]?.notificationId, 6800);
        const text = `${kind}:${normalizeCompanyId(companyId)}`;
        const hash = [...text].reduce((value, char) => ((value * 31) + char.charCodeAt(0)) >>> 0, 7);
        return base * 100000 + (hash % 99991);
    }

    async function showDailyToast(text, tone = "good") {
        if (!dailyAlertDeliveryChannels().toast) return false;
        const stacked = showDesktopToast(text, tone, 10);
        const colors = tone === "bad"
            ? { bgColor: { a: 255, r: 125, g: 35, b: 47 }, textColor: { a: 255, r: 255, g: 245, b: 245 } }
            : tone === "warn"
                ? { bgColor: { a: 255, r: 112, g: 79, b: 20 }, textColor: { a: 255, r: 255, g: 246, b: 222 } }
                : { bgColor: { a: 255, r: 18, g: 94, b: 74 }, textColor: { a: 255, r: 238, g: 255, b: 248 } };
        const nativeResponse = await callConfirmedPdaHandler("showToast", { text, clickClose: true, seconds: 10, ...colors });
        return stacked || pdaHandlerSucceeded(nativeResponse);
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

    async function showDailyNotification(alert, text, notificationId = alert?.notificationId) {
        if (!dailyAlertDeliveryChannels().notification) return false;
        const nativeResponse = await callConfirmedPdaHandler("scheduleNotification", {
            title: alert.title,
            subtitle: text,
            id: notificationId,
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
        const alert = kind === "sync" ? {
            title: "Naughty Company — Daily Sync",
            reminderText: "Open Naughty Company Companion to update every saved company after the daily tick.",
            reminderNotificationId: 6813,
            minute: DAILY_SYNC_MINUTE_UTC
        } : DAILY_ALERTS[kind];
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
        await storeSet(STORE.dailyReminders, state.dailyReminders, { immediate: true });
    }

    async function scheduleDailyTickReminder(kind, { force = false } = {}) {
        if (!dailyTickAlertsEnabled() || !dailyAlertDeliveryChannels().notification) return false;
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
        const alert = kind === "sync" ? { reminderNotificationId: 6813 } : DAILY_ALERTS[kind];
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
            if (!dailyTickAlertsEnabled() || !dailyAlertDeliveryChannels().notification) {
                const scheduledKinds = Object.keys(state.dailyReminders || {});
                if (!scheduledKinds.length) return true;
                const results = await Promise.all(scheduledKinds.map((kind) => cancelDailyTickReminder(kind)));
                return results.every(Boolean);
            }
            const results = await Promise.all([scheduleDailyTickReminder("sync", { force })]);
            return results.every(Boolean);
        })();
        try {
            return await dailyAlertRuntime.reminderRefreshPromise;
        } finally {
            dailyAlertRuntime.reminderRefreshPromise = null;
        }
    }

    async function deliverDailyAlert(kind, payload, { companyIds = [] } = {}) {
        const alert = DAILY_ALERTS[kind];
        const channels = dailyAlertDeliveryChannels();
        if (!alert || !channels.toast && !channels.notification) return false;
        const native = nativeRuntime.isTornPDA || await confirmTornPDA();
        if (native) await cancelDailyTickReminder("sync");
        const tone = kind === "employeeRisk" && payload.risks?.length ? "bad" : payload.unavailable ? "warn" : "good";
        const deliveries = [];
        if (channels.toast) deliveries.push(showDailyToast(payload.text, tone));
        if (channels.notification) deliveries.push(showDailyNotification(alert, payload.text, notificationIdForCompany(kind, companyIds.join(",") || "combined")));
        const results = await Promise.allSettled(deliveries);
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

    async function tornWithKey(key, path, query = {}) {
        if (!key) throw new Error("Add a Limited-access Director key in Settings.");
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

    async function torn(path, query = {}) {
        return tornWithKey(activeTornApiKey(), path, query);
    }

    function unwrap(payload, key, fallback) {
        if (isObject(payload) && payload[key] !== undefined) return payload[key];
        return payload ?? fallback;
    }

    function reportingPeriod(timestamp = Date.now()) {
        const date = new Date(timestamp);
        let period = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), DAILY_TICK_HOUR_UTC, DAILY_SYNC_MINUTE_UTC, 0, 0);
        if (timestamp < period) period -= DAY;
        return period;
    }

    function weekKey(timestamp = Date.now()) {
        const date = new Date(timestamp);
        const daysSinceSunday = (date.getUTCDay() + 7 - 0) % 7;
        let start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceSunday, DAILY_TICK_HOUR_UTC, DAILY_SYNC_MINUTE_UTC, 0, 0);
        if (timestamp < start) start -= 7 * DAY;
        return String(start);
    }

    function isPostSundayReset(timestamp = Date.now()) {
        const date = new Date(timestamp);
        return date.getUTCDay() === 0 && (date.getUTCHours() > DAILY_TICK_HOUR_UTC || (date.getUTCHours() === DAILY_TICK_HOUR_UTC && date.getUTCMinutes() >= DAILY_SYNC_MINUTE_UTC));
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

    function dailySyncDay(timestamp = Date.now()) {
        return utcDayKey(timestamp < dailyAlertPhaseTime(timestamp, DAILY_SYNC_MINUTE_UTC) ? timestamp - DAY : timestamp);
    }

    function dailySyncNeedsRun(record, timestamp = Date.now()) {
        return String(record?.day || "") !== dailySyncDay(timestamp);
    }

    function dailySyncPlan(accounts, syncById = {}, timestamp = Date.now()) {
        const entries = Array.isArray(accounts) ? accounts : Object.values(accounts || {});
        const pending = entries.filter((account) => {
            const normalized = normalizeAccount(account);
            return normalized && accountKey(normalized) && dailySyncNeedsRun(syncById?.[normalized.id], timestamp);
        }).map((account) => normalizeAccount(account));
        const byType = pending.reduce((groups, account) => {
            const typeId = account.typeId || canonicalName(account.typeName) || `company:${account.id}`;
            if (!groups[typeId]) groups[typeId] = { typeId, typeName: account.typeName, accounts: [], companyIds: [] };
            groups[typeId].accounts.push(account);
            groups[typeId].companyIds.push(account.id);
            return groups;
        }, {});
        return { pending, rankingGroups: Object.values(byType) };
    }

    function rankingRefreshDay(timestamp = Date.now()) {
        return dailySyncDay(timestamp);
    }

    function isDailyRankingRefreshDue(timestamp = Date.now()) {
        return timestamp >= dailyAlertPhaseTime(timestamp, DAILY_SYNC_MINUTE_UTC);
    }

    function rankingRefreshedForDailyTick(record, timestamp = Date.now()) {
        return String(record?.dailyRefreshDay || "") === rankingRefreshDay(timestamp);
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

    function alertSignedCount(value) {
        const number = asFinite(value);
        return number === null ? "unavailable" : `${number > 0 ? "+" : ""}${formatNumber(number)}`;
    }

    function totalStockDifference(data = state.data, previous = previousStockSnapshot(companyHistory(data?.profile?.id))) {
        if (data?.stockAvailable === false || !isObject(previous)) return null;
        const current = Object.fromEntries((Array.isArray(data?.stock) ? data.stock : []).map((item) => [String(item?.id), asNumber(item?.in_stock)]));
        const ids = new Set([...Object.keys(previous), ...Object.keys(current)]);
        return [...ids].reduce((total, id) => total + asNumber(current[id]) - asNumber(previous?.[id]?.inStock), 0);
    }

    function dailyTickStockDifference(data) {
        const prior = previousStockSnapshot(companyHistory(data?.profile?.id));
        return totalStockDifference(data, prior);
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
                `Star Level: ${formatNumber(ratingOf(profile))}★`,
                `Stock Difference vs prior day: ${alertSignedCount(dailyTickStockDifference(data))}`,
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
        return `${value > 0 ? "+" : ""}${formatOptionalNumber(value)}`;
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

    function dailyAlertKindsAt(timestamp) {
        return Object.entries(DAILY_ALERTS)
            .filter(([, alert]) => dailyAlertPhaseTime(timestamp, alert.minute) === timestamp)
            .map(([kind]) => kind);
    }

    function dailyAlertRefreshNeeded(kinds, timestamp = Date.now(), data = state.data) {
        if (!data?.profile) return true;
        return kinds.some((kind) => !dailyAlertDataSource(data, dailyAlertPhaseTime(timestamp, DAILY_ALERTS[kind].minute)).fresh);
    }

    async function markDailyAlertFired(kind, timestamp = Date.now()) {
        const scope = dailyAlertScope();
        if (!scope) return;
        state.dailyAlerts = { ...state.dailyAlerts, [scope]: { ...dailyAlertRecord(), [kind]: utcDayKey(timestamp) } };
        await storeSet(STORE.dailyAlerts, state.dailyAlerts, { immediate: true });
    }

    async function runDailyTickAlerts({ refresh = false, scheduled = false } = {}) {
        if (!dailyTickAlertsEnabled()) return;
        return runDailySync({ scheduled, force: refresh, deliverAlerts: true });
    }

    function configuredCompanyAccounts() {
        const accounts = companyAccountMap(state.settings);
        const activeId = activeCompanyId();
        if (!Object.keys(accounts).length && activeId && activeTornApiKey()) {
            const profile = state.cacheByCompany?.[activeId]?.profile || state.data?.profile;
            if (profile) accounts[activeId] = accountFromProfile(profile, activeTornApiKey(), activeTornApiKey() === injectedTornApiKey() ? "pda" : "saved");
        }
        return accounts;
    }

    async function markDailyAlertFiredForCompanies(kind, companyIds, timestamp = Date.now()) {
        const day = dailySyncDay(timestamp);
        companyIds.forEach((companyId) => {
            const id = normalizeCompanyId(companyId);
            if (id) state.dailyAlerts[id] = { ...(state.dailyAlerts[id] || {}), [kind]: day };
        });
    }

    function buildCombinedDailyAlert(kind, records, timestamp = Date.now()) {
        const payloads = records.map(({ id, data }) => ({ id, profile: data?.profile || {}, payload: dailyAlertPayload(kind, data, timestamp) }));
        const detail = payloads.map(({ profile, payload }) => `${profile.name || "Company"}\n${payload.text}`).join("\n\n");
        return {
            title: kind === "income" ? "Naughty Company — Daily Tick" : "Naughty Company — Employee Effectiveness",
            text: detail,
            risks: payloads.flatMap(({ payload }) => payload.risks || []),
            unavailable: payloads.some(({ payload }) => payload.unavailable)
        };
    }

    async function deliverDailyCompanyAlerts(companyIds, timestamp = Date.now()) {
        if (!dailyTickAlertsEnabled()) return false;
        const accounts = configuredCompanyAccounts();
        const eligible = companyIds.map((id) => normalizeCompanyId(id)).filter((id) => accounts[id] && state.cacheByCompany[id]);
        if (!eligible.length) return false;
        let delivered = false;
        for (const kind of Object.keys(DAILY_ALERTS)) {
            if (!isDailyAlertDue(timestamp, DAILY_ALERTS[kind].minute)) continue;
            const pending = eligible.filter((id) => state.dailyAlerts?.[id]?.[kind] !== dailySyncDay(timestamp));
            if (!pending.length) continue;
            const targets = alertTargetsForMode(state.settings.dailyAlertMode, pending.map((id) => accounts[id]), activeCompanyId());
            for (const ids of targets) {
                const records = ids.map((id) => ({ id, data: state.cacheByCompany[id] })).filter((record) => record.data?.profile);
                if (!records.length) continue;
                const payload = records.length === 1
                    ? { ...dailyAlertPayload(kind, records[0].data, timestamp), text: `${records[0].data.profile.name || "Company"}\n${dailyAlertPayload(kind, records[0].data, timestamp).text}` }
                    : buildCombinedDailyAlert(kind, records, timestamp);
                const key = `${ids.join(",")}:${kind}`;
                if (dailyAlertRuntime.inFlight.has(key)) continue;
                dailyAlertRuntime.inFlight.add(key);
                try {
                    if (await deliverDailyAlert(kind, payload, { companyIds: ids })) {
                        await markDailyAlertFiredForCompanies(kind, ids, timestamp);
                        delivered = true;
                    }
                } catch (error) {
                    warningLog("daily alert:delivery failed", { kind, companyIds: ids, reason: safeDiagnosticError(error) });
                } finally {
                    dailyAlertRuntime.inFlight.delete(key);
                    // Native toast overlays have no ids. Yielding preserves visible stacked messages.
                    await sleep(180);
                }
            }
        }
        if (delivered) await storeSet(STORE.dailyAlerts, state.dailyAlerts, { immediate: true });
        return delivered;
    }

    async function runDailySync({ scheduled = false, force = false, deliverAlerts = true } = {}) {
        if (scheduled && documentIsHidden()) {
            debugLog("refresh:paused", { source: "all-company daily sync", reason: "document hidden" });
            return false;
        }
        const now = Date.now();
        if (!force && !isDailyRankingRefreshDue(now)) return false;
        if (dailySyncRuntime.inFlight) return dailySyncRuntime.inFlight;
        dailySyncRuntime.inFlight = (async () => {
            const accounts = configuredCompanyAccounts();
            const plan = dailySyncPlan(accounts, state.dailySync, now);
            if (!plan.pending.length) {
                if (deliverAlerts) await deliverDailyCompanyAlerts(Object.keys(accounts), now);
                return { skipped: true, refreshed: [] };
            }
            debugLog("daily-sync:start", { companies: plan.pending.length, day: dailySyncDay(now) });
            const refreshed = [];
            let cursor = 0;
            const worker = async () => {
                while (cursor < plan.pending.length) {
                    const account = plan.pending[cursor++];
                    const result = await refreshCore({ accountId: account.id, silent: true, suppressDailyAlerts: true, scheduled, background: true, persist: false });
                    if (result?.data?.profile && result.data.employeesAvailable) refreshed.push({ account: result.account, data: result.data });
                }
            };
            await Promise.all(Array.from({ length: Math.min(2, plan.pending.length) }, worker));
            const grouped = dailySyncPlan(refreshed.map(({ account, data }) => ({
                ...account,
                typeId: normalizeCompanyId(companyType(data.profile).id),
                typeName: companyType(data.profile).name
            })), {}, now).rankingGroups;
            const completed = new Set();
            for (const group of grouped) {
                const first = group.accounts[0];
                try {
                    const companies = await fetchSameTypeCompanies(first.typeId, accountKey(first));
                    for (const companyId of group.companyIds) {
                        try {
                            applyRankingsForCompany(companyId, companies, now);
                            await persistHistorySnapshot({ data: state.cacheByCompany[companyId], persist: false });
                            completed.add(companyId);
                        } catch (error) {
                            warningLog("daily-sync:company ranking incomplete", { companyId, typeId: group.typeId, reason: safeDiagnosticError(error) });
                        }
                    }
                } catch (error) {
                    warningLog("daily-sync:rankings failed", { typeId: group.typeId, reason: safeDiagnosticError(error) });
                }
            }
            completed.forEach((id) => { state.dailySync[id] = { day: dailySyncDay(now), completedAt: Date.now() }; });
            await storeSetMany({
                [STORE.settings]: state.settings,
                [STORE.cache]: cacheEnvelope(),
                [STORE.history]: state.history,
                [STORE.rankings]: state.rankings,
                [STORE.rankHistory]: state.rankHistory,
                [STORE.starCohorts]: state.starCohorts,
                [STORE.dailySync]: state.dailySync
            }, { immediate: true });
            if (deliverAlerts) await deliverDailyCompanyAlerts([...completed], Date.now());
            state.status = completed.size
                ? `Daily sync updated ${formatNumber(completed.size)} configured compan${completed.size === 1 ? "y" : "ies"} at 18:10 UTC.`
                : "Daily sync is waiting for a successful Company and rankings response.";
            debugLog("daily-sync:complete", { refreshed: refreshed.length, completed: completed.size, rankingGroups: grouped.length });
            render();
            return { refreshed, completed: [...completed] };
        })();
        try {
            return await dailySyncRuntime.inFlight;
        } finally {
            dailySyncRuntime.inFlight = null;
        }
    }

    function nextDailySyncTimestamp(timestamp = Date.now()) {
        const today = dailyAlertPhaseTime(timestamp, DAILY_SYNC_MINUTE_UTC);
        return today > timestamp + 250 ? today : dailyAlertPhaseTime(timestamp + DAY, DAILY_SYNC_MINUTE_UTC);
    }

    function scheduleDailyCompanySync() {
        if (dailySyncRuntime.timerId) clearTimeout(dailySyncRuntime.timerId);
        dailySyncRuntime.timerId = null;
        if (documentIsHidden()) return;
        const target = nextDailySyncTimestamp();
        dailySyncRuntime.timerId = setTimeout(async () => {
            try {
                await runDailySync({ scheduled: true, deliverAlerts: true });
            } catch (error) {
                warningLog("daily-sync:scheduled failure", { reason: safeDiagnosticError(error) });
            } finally {
                // A transient storage/native failure must never disable tomorrow's 18:10 sync.
                scheduleDailyCompanySync();
            }
        }, Math.max(0, target - Date.now() + 300));
    }

    function scheduleDailyTickAlerts() {
        scheduleDailyCompanySync();
    }

    function resetDailyTickAlerts() {
        scheduleDailyCompanySync();
        void refreshDailyTickReminders();
        if (!documentIsHidden() && isDailyRankingRefreshDue()) void runDailySync({ scheduled: true, deliverAlerts: true });
    }

    function resetDailyRankingRefresh() {
        scheduleDailyCompanySync();
    }

    function companyHistory(companyId = state.data?.profile?.id) {
        return Array.isArray(state.history?.[String(companyId)]) ? state.history[String(companyId)] : [];
    }

    function historySnapshotDay(entry, fallbackTimestamp = Date.now()) {
        if (!isObject(entry)) return "";
        const explicit = String(entry.reportingDay ?? entry.snapshotDay ?? "").trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
        const period = asFinite(entry.period);
        if (period !== null) {
            const periodDate = new Date(period);
            if (periodDate.getUTCHours() === DAILY_TICK_HOUR_UTC && (periodDate.getUTCMinutes() === 5 || periodDate.getUTCMinutes() === DAILY_SYNC_MINUTE_UTC)) {
                return utcDayKey(period);
            }
        }
        const capturedAt = asFinite(entry.capturedAt);
        const timestamp = capturedAt ?? period ?? asFinite(fallbackTimestamp);
        return timestamp === null ? "" : dailySyncDay(timestamp);
    }

    function historySnapshotTimestamp(entry) {
        return asFinite(entry?.capturedAt) ?? asFinite(entry?.period) ?? 0;
    }

    function mergeHistorySnapshot(existing, incoming) {
        if (!isObject(existing)) return incoming;
        const value = (current, previous) => current === null || current === undefined ? previous ?? null : current;
        const incomingStockAvailable = incoming?.stockAvailable !== false && isObject(incoming?.stock);
        return {
            ...existing,
            ...incoming,
            reportingDay: incoming.reportingDay || historySnapshotDay(existing),
            capturedAt: asFinite(existing.capturedAt) ?? incoming.capturedAt,
            updatedAt: incoming.updatedAt ?? incoming.capturedAt ?? existing.updatedAt,
            dailyIncome: value(incoming.dailyIncome, existing.dailyIncome),
            weeklyIncome: value(incoming.weeklyIncome, existing.weeklyIncome),
            dailyProfit: value(incoming.dailyProfit, existing.dailyProfit),
            weeklyProfit: value(incoming.weeklyProfit, existing.weeklyProfit),
            funds: value(incoming.funds, existing.funds),
            rating: value(incoming.rating, existing.rating),
            stockQuantity: incomingStockAvailable ? value(incoming.stockQuantity, existing.stockQuantity) : existing.stockQuantity ?? null,
            stockValue: incomingStockAvailable ? value(incoming.stockValue, existing.stockValue) : existing.stockValue ?? null,
            averageEmployeeEfficiency: value(incoming.averageEmployeeEfficiency, existing.averageEmployeeEfficiency),
            companyRank: value(incoming.companyRank, existing.companyRank),
            companyRankTotal: value(incoming.companyRankTotal, existing.companyRankTotal),
            stock: incomingStockAvailable ? incoming.stock : existing.stock ?? {}
        };
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

    async function persistHistorySnapshot({ persist = true, data = state.data } = {}) {
        const profile = data?.profile;
        if (!profile?.id) return;
        const id = String(profile.id);
        const period = reportingPeriod();
        const reportingDay = dailySyncDay();
        const capturedAt = Date.now();
        const history = companyHistory(id);
        const priorSnapshots = history.filter((entry) => historySnapshotDay(entry, period) === reportingDay);
        const existingSnapshot = priorSnapshots.sort((left, right) => historySnapshotTimestamp(left) - historySnapshotTimestamp(right)).reduce((merged, entry) => merged ? mergeHistorySnapshot(merged, entry) : entry, null);
        const financesNow = financials(data);
        const stock = Array.isArray(data?.stock) ? data.stock : [];
        const stockAvailable = data?.stockAvailable === true;
        const stockNow = {
            inStock: stock.reduce((sum, item) => sum + asNumber(item?.in_stock), 0),
            saleValue: stock.reduce((sum, item) => sum + asNumber(item?.in_stock) * asNumber(item?.price), 0)
        };
        const rankingRecord = state.rankings?.[id];
        const rankingsNow = rankingRecord?.companies?.length ? calculateRankingMetrics(rankingRecord.companies, profile, state.starCohorts?.[id]?.counts) : null;
        const efficiencyRows = (Array.isArray(data?.employees) ? data.employees : []).map((employee) => asFinite(employee?.effectiveness?.total)).filter((value) => value !== null);
        const row = {
            period,
            reportingDay,
            capturedAt,
            updatedAt: capturedAt,
            dailyIncome: financesNow.dailyIncome,
            weeklyIncome: financesNow.weeklyIncome,
            dailyProfit: financesNow.dailyProfit,
            weeklyProfit: financesNow.weeklyProfit,
            funds: asFinite(profile.funds),
            rating: asFinite(profile.rating),
            stockQuantity: stockAvailable ? stockNow.inStock : null,
            stockValue: stockAvailable ? stockNow.saleValue : null,
            stockAvailable,
            averageEmployeeEfficiency: efficiencyRows.length ? efficiencyRows.reduce((sum, value) => sum + asNumber(value), 0) / efficiencyRows.length : null,
            companyRank: trendNumber(rankingsNow?.rank),
            companyRankTotal: trendNumber(rankingsNow?.total),
            stock: Object.fromEntries(stock.map((item) => [String(item.id), {
                inStock: asNumber(item.in_stock),
                onOrder: asNumber(item.on_order)
            }]))
        };
        const retained = history.filter((entry) => historySnapshotDay(entry, period) !== reportingDay && entry.period > period - 92 * DAY);
        state.history[id] = [...retained, mergeHistorySnapshot(existingSnapshot, row)].sort((left, right) => left.period - right.period);
        if (persist) await storeSet(STORE.history, state.history);
        return state.history;
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
        const typeName = profile?.type?.name || profile?.company_type?.name || "";
        const settings = currentCompanySettings();
        return (Array.isArray(state.data?.employees) ? state.data.employees : []).map((employee) => {
            const stats = isObject(employee.stats) ? employee.stats : {};
            const effectiveness = isObject(employee.effectiveness) ? employee.effectiveness : {};
            const projected = calculateLocalRoleEfficiencies(typeName, stats);
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
                currentEfficiencySource: projectedCurrent === undefined ? "Torn total" : "Local role calculation + Torn effects",
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
        if (!positions.length) throw new Error("Local role requirements are unavailable for this company type.");
        const settings = currentCompanySettings();
        return assignProjectedRows(rows, positions, settings.capacities || {}, asFinite(profile?.employees?.capacity), settings.priority || [], settings.locks || {});
    }

    async function saveSettings(patch = {}) {
        const previous = state.settings;
        state.settings = deepMergeSettings({ ...state.settings, ...patch });
        if (hasOwn(patch, "useLegacyGMStorage") && Boolean(previous.useLegacyGMStorage) !== Boolean(state.settings.useLegacyGMStorage)) {
            const switched = await switchStoragePreference(state.settings.useLegacyGMStorage);
            if (!switched) {
                state.settings = previous;
                await storeSet(STORE.settings, state.settings, { immediate: true });
            }
            return;
        }
        await storeSet(STORE.settings, state.settings, { immediate: true });
    }

    function normalizeCacheByCompany(cache) {
        const candidates = isObject(cache?.companies) ? cache.companies : isObject(cache?.profile) ? { [normalizeCompanyId(cache.profile.id)]: cache } : {};
        return Object.entries(candidates).reduce((next, [id, snapshot]) => {
            const companyId = normalizeCompanyId(snapshot?.profile?.id ?? id);
            if (companyId && isObject(snapshot?.profile)) next[companyId] = snapshot;
            return next;
        }, {});
    }

    function cacheEnvelope(cacheByCompany = state.cacheByCompany) {
        return { schemaVersion: 2, companies: normalizeCacheByCompany({ companies: cacheByCompany }) };
    }

    function activateCompanySnapshot(companyId, cacheByCompany = state.cacheByCompany) {
        const id = normalizeCompanyId(companyId);
        const snapshot = cacheByCompany?.[id] || null;
        if (!snapshot?.profile?.id) return null;
        state.settings.activeCompanyId = id;
        state.cache = snapshot;
        state.data = snapshot;
        return snapshot;
    }

    function migrateLegacyCompanyStores(stores, { currentSettings = null } = {}) {
        const source = isObject(stores) ? stores : {};
        const cacheByCompany = normalizeCacheByCompany(source[STORE.cache]);
        const activeId = normalizeCompanyId(source[STORE.settings]?.activeCompanyId)
            || Object.keys(cacheByCompany)[0]
            || "";
        const legacyProfile = cacheByCompany[activeId]?.profile || Object.values(cacheByCompany)[0]?.profile || null;
        const settingsRaw = { ...(isObject(source[STORE.settings]) ? source[STORE.settings] : {}) };
        const accounts = companyAccountMap(settingsRaw, legacyProfile);
        const settings = deepMergeSettings({ ...settingsRaw, companyAccounts: accounts, activeCompanyId: activeId || settingsRaw.activeCompanyId });
        // A flat legacy key is either moved into the validated Company-ID account above or discarded.
        delete settings.tornKey;
        delete settings.tornStatsKey;
        delete settings.projectionConsent;
        if (currentSettings && !Object.keys(accounts).length) {
            const current = deepMergeSettings(currentSettings);
            settings.companyAccounts = current.companyAccounts;
            settings.activeCompanyId = current.activeCompanyId;
        }
        return {
            settings,
            cache: cacheEnvelope(cacheByCompany),
            cacheByCompany,
            activeId
        };
    }

    async function loadPersistedState() {
        const stored = await loadStoredValues();
        const migrated = migrateLegacyCompanyStores(stored);
        const layout = stored[STORE.layout] ?? DEFAULT_LAYOUT;
        const history = stored[STORE.history] ?? {};
        const rankings = stored[STORE.rankings] ?? {};
        const rankHistory = stored[STORE.rankHistory] ?? {};
        const starCohorts = stored[STORE.starCohorts] ?? {};
        const dailyAlerts = stored[STORE.dailyAlerts] ?? {};
        const dailyReminders = stored[STORE.dailyReminders] ?? {};
        const dailySync = stored[STORE.dailySync] ?? {};
        state.settings = migrated.settings;
        state.layout = { ...DEFAULT_LAYOUT, ...(isObject(layout) ? layout : {}) };
        state.cacheByCompany = migrated.cacheByCompany;
        state.cache = null;
        const normalizedHistory = normalizeHistory(history);
        state.history = normalizedHistory;
        state.rankings = isObject(rankings) ? rankings : {};
        state.rankHistory = isObject(rankHistory) ? rankHistory : {};
        state.starCohorts = isObject(starCohorts) ? starCohorts : {};
        state.dailyAlerts = isObject(dailyAlerts) ? dailyAlerts : {};
        state.dailyReminders = isObject(dailyReminders) ? dailyReminders : {};
        state.dailySync = isObject(dailySync) ? dailySync : {};
        state.selectedTab = state.settings.activeTab || "overview";
        const firstId = migrated.activeId || Object.keys(state.cacheByCompany)[0] || Object.keys(state.settings.companyAccounts)[0];
        if (firstId) activateCompanySnapshot(firstId);
        const settingsChanged = isObject(stored[STORE.settings]) && JSON.stringify(stored[STORE.settings]) !== JSON.stringify(state.settings);
        const cacheChanged = stored[STORE.cache] !== undefined && JSON.stringify(stored[STORE.cache]) !== JSON.stringify(migrated.cache);
        const historyChanged = JSON.stringify(history) !== JSON.stringify(normalizedHistory);
        if (settingsChanged || cacheChanged || historyChanged) {
            const updates = {};
            if (settingsChanged) updates[STORE.settings] = state.settings;
            if (cacheChanged) updates[STORE.cache] = migrated.cache;
            if (historyChanged) updates[STORE.history] = normalizedHistory;
            await storeSetMany(updates, { immediate: true });
        }
        await removeLegacyProjectionStore();
    }

    function normalizeHistory(history) {
        if (!isObject(history)) return {};
        return Object.fromEntries(Object.entries(history).map(([companyId, entries]) => {
            const byReportingDay = new Map();
            (Array.isArray(entries) ? entries : []).filter(isObject).map((entry) => {
                const legacyDaily = entry[Object.keys(entry).find((key) => key.startsWith("daily") && key !== "dailyIncome" && key !== "dailyProfit")];
                const legacyWeekly = entry[Object.keys(entry).find((key) => key.startsWith("weekly") && key !== "weeklyIncome" && key !== "weeklyProfit")];
                const reportingDay = historySnapshotDay(entry);
                return { ...entry, reportingDay, dailyIncome: entry.dailyIncome ?? legacyDaily, weeklyIncome: entry.weeklyIncome ?? legacyWeekly };
            }).sort((left, right) => historySnapshotTimestamp(left) - historySnapshotTimestamp(right)).forEach((entry) => {
                const key = entry.reportingDay || `legacy:${entry.period}:${entry.capturedAt}`;
                byReportingDay.set(key, mergeHistorySnapshot(byReportingDay.get(key), entry));
            });
            return [companyId, [...byReportingDay.values()].sort((left, right) => asNumber(left.period) - asNumber(right.period))];
        }));
    }

    function sourceFreshness(sourceTimeMap, now = Date.now()) {
        const entries = Object.entries(sourceTimeMap || {}).map(([source, value]) => ({
            source,
            timestamp: asFinite(isObject(value) ? value.at ?? value.timestamp : value)
        })).filter((entry) => entry.timestamp !== null);
        if (!entries.length) return { state: "Not updated", updatedAt: null, source: "—" };
        const newest = Math.max(...entries.map((entry) => entry.timestamp));
        const ages = entries.map((entry) => Math.max(0, now - entry.timestamp));
        const fresh = ages.filter((age) => age <= 15 * 60 * 1000).length;
        const stale = ages.filter((age) => age > 60 * 60 * 1000).length;
        return {
            state: fresh === entries.length ? "Fresh" : stale === entries.length ? "Stale" : "Partial",
            updatedAt: newest,
            source: entries.map((entry) => entry.source).join(", ")
        };
    }

    function tabFreshnessSummary(tab, sourceTimeMap, now = Date.now()) {
        const needed = {
            overview: ["profile", "employees"],
            team: ["employees"],
            planner: ["employees"],
            stock: ["stock"],
            rankings: ["rankings"],
            trends: ["history"],
            settings: ["settings"]
        }[tab] || ["profile"];
        const available = Object.fromEntries(needed.map((key) => [key, sourceTimeMap?.[key]]).filter(([, value]) => asFinite(value) !== null));
        const missing = needed.filter((key) => !Object.prototype.hasOwnProperty.call(available, key));
        const freshness = sourceFreshness(available, now);
        if (!missing.length || freshness.state === "Not updated") return freshness;
        return {
            ...freshness,
            state: freshness.state === "Stale" ? "Stale" : "Partial",
            source: `${freshness.source}; unavailable: ${missing.join(", ")}`
        };
    }

    function accountFromProfile(profile, key, source = "saved", previous = null) {
        const type = profile?.type || profile?.company_type || {};
        return normalizeAccount({
            ...previous,
            id: profile?.id,
            name: profile?.name,
            typeId: type?.id,
            typeName: type?.name,
            key: source === "pda" ? "" : key,
            source,
            addedAt: previous?.addedAt || Date.now(),
            verifiedAt: Date.now(),
            lastAttemptAt: Date.now(),
            lastSuccessAt: Date.now(),
            lastError: ""
        }, profile?.id);
    }

    async function fetchCompanySnapshot(account) {
        const key = accountKey(account) || String(account?.key || "").trim();
        if (!key) throw new Error("Add a Limited-access Director key before refreshing this company.");
        const [profileResult, employeesResult, stockResult, newsResult, applicationsResult] = await Promise.allSettled([
            tornWithKey(key, "/company/profile"),
            tornWithKey(key, "/company/employees"),
            tornWithKey(key, "/company/stock"),
            tornWithKey(key, "/company/news", { cat: "funds", limit: 100, sort: "DESC" }),
            tornWithKey(key, "/company/applications")
        ]);
        if (profileResult.status !== "fulfilled") throw new Error(profileResult.reason?.message || "Unable to load company profile.");
        const profile = unwrap(profileResult.value, "profile", {});
        const id = normalizeCompanyId(profile?.id);
        if (!id) throw new Error("Torn did not return a company profile for this Director key.");
        if (account?.id && normalizeCompanyId(account.id) !== id) throw new Error("This Director key resolves to a different company and was not saved.");
        const resultValue = (result, property, fallback) => result.status === "fulfilled" ? unwrap(result.value, property, fallback) : fallback;
        const now = Date.now();
        const messages = [];
        if (employeesResult.status !== "fulfilled") messages.push("Employee details unavailable for this key.");
        if (stockResult.status !== "fulfilled") messages.push("Stock details require a Limited or higher Torn key.");
        if (newsResult.status !== "fulfilled") messages.push("Funds news unavailable for this key.");
        if (applicationsResult.status !== "fulfilled") messages.push("Applications unavailable for this key.");
        return {
            id,
            account: accountFromProfile(profile, key, account?.source || (key === injectedTornApiKey() ? "pda" : "saved"), account),
            data: {
                profile,
                employees: Array.isArray(resultValue(employeesResult, "employees", [])) ? resultValue(employeesResult, "employees", []) : [],
                employeesAvailable: employeesResult.status === "fulfilled",
                stock: Array.isArray(resultValue(stockResult, "stock", [])) ? resultValue(stockResult, "stock", []) : [],
                stockAvailable: stockResult.status === "fulfilled",
                news: Array.isArray(resultValue(newsResult, "news", [])) ? resultValue(newsResult, "news", []) : [],
                applications: Array.isArray(resultValue(applicationsResult, "applications", [])) ? resultValue(applicationsResult, "applications", []) : [],
                applicationsAvailable: applicationsResult.status === "fulfilled",
                fetchedAt: now
            },
            messages,
            sourceTimes: {
                profile: now,
                ...(employeesResult.status === "fulfilled" ? { employees: now } : {}),
                ...(stockResult.status === "fulfilled" ? { stock: now } : {}),
                ...(newsResult.status === "fulfilled" ? { news: now } : {}),
                ...(applicationsResult.status === "fulfilled" ? { applications: now } : {})
            },
            unavailableSources: [
                ...(employeesResult.status === "fulfilled" ? [] : ["employees"]),
                ...(stockResult.status === "fulfilled" ? [] : ["stock"]),
                ...(newsResult.status === "fulfilled" ? [] : ["news"]),
                ...(applicationsResult.status === "fulfilled" ? [] : ["applications"])
            ]
        };
    }

    async function commitCompanySnapshot(snapshot, { persist = true } = {}) {
        const id = snapshot.id;
        const accounts = companyAccountMap(state.settings);
        accounts[id] = snapshot.account;
        state.settings = deepMergeSettings({ ...state.settings, companyAccounts: accounts, activeCompanyId: state.settings.activeCompanyId || id });
        const companySourceTimes = { ...(state.settings.sourceTimes?.[id] || {}), ...snapshot.sourceTimes };
        snapshot.unavailableSources?.forEach((source) => { delete companySourceTimes[source]; });
        state.settings.sourceTimes = {
            ...state.settings.sourceTimes,
            [id]: { ...companySourceTimes, settings: Date.now() }
        };
        state.cacheByCompany[id] = snapshot.data;
        if (normalizeCompanyId(state.settings.activeCompanyId) === id || !state.data?.profile?.id) activateCompanySnapshot(id);
        await persistHistorySnapshot({ data: snapshot.data, persist: false });
        state.settings.sourceTimes[id].history = Date.now();
        if (persist) await storeSetMany({ [STORE.settings]: state.settings, [STORE.cache]: cacheEnvelope(), [STORE.history]: state.history });
        return snapshot.data;
    }

    async function refreshCore({ silent = false, suppressDailyAlerts = false, scheduled = false, accountId = activeCompanyId(), background = false, persist = true } = {}) {
        if (scheduled && documentIsHidden()) {
            debugLog("refresh:paused", { source: "scheduled core refresh", reason: "document hidden" });
            return false;
        }
        if (state.loading && !background) return false;
        const known = accountForCompany(accountId);
        const key = accountKey(known) || (normalizeCompanyId(accountId) === activeCompanyId() ? activeTornApiKey() : "");
        if (!key) {
            if (!background) {
                state.error = "Add a Limited-access Director key before refreshing.";
                render();
            }
            return false;
        }
        const account = known || { id: normalizeCompanyId(accountId), key, source: key === injectedTornApiKey() ? "pda" : "saved" };
        if (!background) {
            state.loading = true;
            state.error = "";
            state.status = "Refreshing company data…";
            render();
        }
        try {
            const snapshot = await fetchCompanySnapshot(account);
            if (!known && account.source !== "pda" && !snapshot.data.employeesAvailable) {
                throw new Error("This key does not provide the required Company Employees data and was not saved.");
            }
            const data = await commitCompanySnapshot(snapshot, { persist });
            if (!background) {
                state.status = `Updated ${timeAgo(data.fetchedAt)}.${snapshot.messages.length ? ` ${snapshot.messages.join(" ")}` : ""}`;
                if (!silent) void showFeedbackToast("Company data refreshed.", snapshot.messages.length ? "warn" : "good", 5);
            }
            return { ...snapshot, data };
        } catch (error) {
            const message = error?.message || "Unable to refresh company data.";
            if (known?.id) {
                const accounts = companyAccountMap(state.settings);
                accounts[known.id] = { ...known, lastAttemptAt: Date.now(), lastError: safeDiagnosticError(error) };
                state.settings = deepMergeSettings({ ...state.settings, companyAccounts: accounts });
                if (persist) await storeSet(STORE.settings, state.settings);
            }
            if (!background) {
                state.error = message;
                state.status = "Refresh failed.";
            }
            warningLog("refresh:failed", { companyId: normalizeCompanyId(account?.id), reason: safeDiagnosticError(error) });
            return false;
        } finally {
            if (!background) {
                state.loading = false;
                render();
            }
            if (!suppressDailyAlerts && !background) void runDailyTickAlerts({ refresh: false, scheduled });
        }
    }

    const companyType = (profile) => profile?.type || profile?.company_type || {};

    async function fetchSameTypeCompanies(typeId, key, onProgress = null) {
        const first = await tornWithKey(key, `/company/${typeId}/companies`, { limit: 100, offset: 0 });
        const companies = Array.isArray(first.companies) ? [...first.companies] : [];
        const reportedTotal = asFinite(first?._metadata?.total);
        if (reportedTotal !== null && reportedTotal > MAX_SAME_TYPE_COMPANIES) {
            throw new Error(`Same-type rankings contain more than ${formatNumber(MAX_SAME_TYPE_COMPANIES)} companies and were not saved.`);
        }
        const total = Math.max(companies.length, reportedTotal === null ? companies.length : reportedTotal);
        const offsets = [];
        for (let offset = 100; offset < total; offset += 100) offsets.push(offset);
        for (let index = 0; index < offsets.length; index += 4) {
            const batch = offsets.slice(index, index + 4);
            const pages = await Promise.all(batch.map((offset) => tornWithKey(key, `/company/${typeId}/companies`, { limit: 100, offset })));
            pages.forEach((page) => companies.push(...(Array.isArray(page.companies) ? page.companies : [])));
            onProgress?.(Math.min(total, index * 100 + 500), total);
            if (index + 4 < offsets.length) await sleep(80);
        }
        const unique = [...new Map(companies.map((company) => [String(company.id), company])).values()];
        if (unique.length < total) throw new Error("Torn returned an incomplete same-type rankings result; it was not saved as today’s refresh.");
        return unique;
    }

    function applyRankingsForCompany(companyId, companies, timestamp = Date.now()) {
        const id = normalizeCompanyId(companyId);
        const data = state.cacheByCompany[id];
        const profile = data?.profile;
        if (!profile || !companies.some((company) => normalizeCompanyId(company?.id) === id)) throw new Error("Torn returned an incomplete same-type rankings result; it was not saved as today’s refresh.");
        const type = companyType(profile);
        const currentWeek = weekKey(timestamp);
        const savedCohort = state.starCohorts[id];
        if (!savedCohort || savedCohort.week !== currentWeek || isPostSundayReset(timestamp)) {
            state.starCohorts[id] = { week: currentWeek, capturedAt: timestamp, counts: countStars(companies), source: isPostSundayReset(timestamp) ? "post-reset" : "first-observed" };
        }
        const metrics = calculateRankingMetrics(companies, profile, state.starCohorts[id]?.counts);
        const prior = state.rankHistory[id];
        state.rankings[id] = {
            fetchedAt: timestamp,
            companies,
            typeId: normalizeCompanyId(type.id),
            typeName: String(type.name || ""),
            total: companies.length,
            previousRank: prior?.rank ?? null,
            dailyRefreshDay: rankingRefreshDay(timestamp),
            dailyRefreshAt: timestamp
        };
        state.rankHistory[id] = { rank: metrics.rank, timestamp };
        state.settings.sourceTimes = {
            ...state.settings.sourceTimes,
            [id]: { ...(state.settings.sourceTimes?.[id] || {}), rankings: timestamp, history: timestamp }
        };
        return metrics;
    }

    async function loadRankings({ force = false, scheduled = false, companyId = activeCompanyId(), sharedCompanies = null, key = null, background = false } = {}) {
        const id = normalizeCompanyId(companyId);
        const data = state.cacheByCompany[id] || (id === activeCompanyId() ? state.data : null);
        const profile = data?.profile;
        const type = companyType(profile);
        if (!profile || !type?.id) return false;
        if (scheduled && documentIsHidden()) {
            debugLog("refresh:paused", { source: "scheduled rankings refresh", reason: "document hidden" });
            return false;
        }
        const cached = state.rankings[id];
        if (!sharedCompanies && rankingRefreshedForDailyTick(cached)) {
            if (!background && id === activeCompanyId()) {
                state.status = "Same-type rankings already refreshed for this Torn daily tick.";
                render();
                if (!scheduled) void showFeedbackToast("Rankings already refreshed for this Torn daily tick.", "warn", 5);
            }
            return { skipped: true, companies: cached.companies };
        }
        const account = accountForCompany(id);
        const requestKey = key || accountKey(account) || (id === activeCompanyId() ? activeTornApiKey() : "");
        if (!requestKey) return false;
        if (!background && id === activeCompanyId()) {
            state.rankingLoading = true;
            state.error = "";
            state.status = "Loading same-type company rankings…";
            render();
        }
        try {
            const companies = sharedCompanies || await fetchSameTypeCompanies(type.id, requestKey, (loaded, total) => {
                if (!background && id === activeCompanyId()) {
                    state.status = `Loading rankings ${formatNumber(loaded)} / ${formatNumber(total)}…`;
                    render();
                }
            });
            const metrics = applyRankingsForCompany(id, companies);
            await persistHistorySnapshot({ data, persist: false });
            await storeSetMany({ [STORE.settings]: state.settings, [STORE.rankings]: state.rankings, [STORE.rankHistory]: state.rankHistory, [STORE.starCohorts]: state.starCohorts, [STORE.history]: state.history }, { immediate: true });
            if (!background && id === activeCompanyId()) {
                const prior = cached?.previousRank;
                state.status = `Ranked ${formatNumber(companies.length)} ${type.name} companies.${prior && metrics.rank ? ` Rank ${prior === metrics.rank ? "unchanged" : metrics.rank < prior ? "improved" : "fell"}.` : ""}`;
                if (!scheduled) void showFeedbackToast("Same-type rankings refreshed for this Torn daily tick.", "good", 5);
            }
            return { companies, metrics };
        } catch (error) {
            if (!background && id === activeCompanyId()) {
                state.error = error?.message || "Unable to load company rankings.";
                state.status = "Rankings unavailable.";
                if (!scheduled) void showFeedbackToast("Same-type rankings could not be refreshed.", "bad", 6);
            }
            warningLog("rankings:failed", { companyId: id, reason: safeDiagnosticError(error) });
            return false;
        } finally {
            if (!background && id === activeCompanyId()) {
                state.rankingLoading = false;
                render();
            }
        }
    }

    async function recalculateLocalRoles() {
        const positions = projectionPositions();
        state.error = positions.length ? "" : "Local role requirements are not yet available for this company type.";
        state.status = positions.length
            ? `Calculated local role projections for ${formatNumber(employeeRows().length)} employees.`
            : "Local role projections are unavailable.";
        render();
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

    function isVirtualKeyboardViewportChange({ focused = false, baseline, current, layoutHeight = 0 } = {}) {
        const baselineWidth = asNumber(baseline?.width);
        const baselineHeight = asNumber(baseline?.height);
        const currentWidth = asNumber(current?.width);
        const currentHeight = asNumber(current?.height);
        if (!focused || !baselineWidth || !baselineHeight || !currentWidth || !currentHeight) return false;
        const widthTolerance = Math.max(48, Math.round(baselineWidth * VIRTUAL_KEYBOARD_WIDTH_TOLERANCE));
        if (Math.abs(currentWidth - baselineWidth) > widthTolerance) return false;
        const heightLoss = baselineHeight - currentHeight;
        const layoutGap = Math.max(0, asNumber(layoutHeight) - currentHeight);
        return heightLoss >= Math.max(VIRTUAL_KEYBOARD_MIN_HEIGHT_DELTA, Math.round(baselineHeight * 0.18))
            || layoutGap >= VIRTUAL_KEYBOARD_MIN_HEIGHT_DELTA;
    }

    function isMobileKeyboardRuntime() {
        const userAgent = currentUserAgent();
        return nativeRuntime.isTornPDA || tornPdaUserAgent(userAgent) || /Android|iP(?:hone|ad|od)|Mobile/i.test(userAgent);
    }

    function enableNativeKeyboardOverlay() {
        if (!isMobileKeyboardRuntime()) return false;
        try {
            const keyboard = typeof navigator === "undefined" ? null : navigator.virtualKeyboard;
            if (!keyboard) return false;
            keyboard.overlaysContent = true;
            return keyboard.overlaysContent === true;
        } catch {
            return false;
        }
    }

    function isCompanionTextEntry(element) {
        const root = document.getElementById(ROOT_ID);
        if (!root || !element || !root.contains(element) || element.disabled || element.readOnly) return false;
        const tagName = String(element.tagName || "").toLowerCase();
        if (tagName === "textarea" || element.isContentEditable) return true;
        if (tagName !== "input") return false;
        return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(String(element.type || "text").toLowerCase());
    }

    function activeCompanionTextEntry() {
        return isCompanionTextEntry(document.activeElement) ? document.activeElement : null;
    }

    function rememberStableViewport(viewport = visibleViewport()) {
        if (keyboardViewportRuntime.active) return;
        keyboardViewportRuntime.baseline = { width: asNumber(viewport.width), height: asNumber(viewport.height) };
        const panelHeight = asNumber(panel()?.getBoundingClientRect().height);
        if (panelHeight > 0) keyboardViewportRuntime.panelHeight = Math.round(panelHeight);
    }

    function lockKeyboardViewportOverlay() {
        const root = document.getElementById(ROOT_ID);
        const el = panel();
        if (!root || !el) return;
        const rect = el.getBoundingClientRect();
        const fallbackHeight = Math.max(1, asNumber(keyboardViewportRuntime.baseline?.height) - 8);
        const frozenHeight = asNumber(keyboardViewportRuntime.panelHeight) || Math.round(rect.height) || fallbackHeight;
        root.style.setProperty("--ncc-keyboard-panel-height", String(Math.max(1, frozenHeight)) + "px");
        root.setAttribute("data-virtual-keyboard-open", "true");
        keyboardViewportRuntime.active = true;
    }

    function releaseKeyboardViewportOverlay() {
        const root = document.getElementById(ROOT_ID);
        root?.removeAttribute("data-virtual-keyboard-open");
        root?.style.removeProperty("--ncc-keyboard-panel-height");
        keyboardViewportRuntime.active = false;
    }

    function handleVirtualKeyboardFocus(event) {
        if (!isMobileKeyboardRuntime() || !isCompanionTextEntry(event.target)) return;
        if (keyboardViewportRuntime.releaseTimer) {
            window.clearTimeout(keyboardViewportRuntime.releaseTimer);
            keyboardViewportRuntime.releaseTimer = null;
        }
        if (!keyboardViewportRuntime.baseline) rememberStableViewport();
    }

    function handleVirtualKeyboardFocusOut() {
        if (!isMobileKeyboardRuntime()) return;
        if (keyboardViewportRuntime.releaseTimer) window.clearTimeout(keyboardViewportRuntime.releaseTimer);
        keyboardViewportRuntime.releaseTimer = window.setTimeout(() => {
            keyboardViewportRuntime.releaseTimer = null;
            if (activeCompanionTextEntry()) return;
            const priorMode = state.runtimeMode;
            const wasActive = keyboardViewportRuntime.active;
            releaseKeyboardViewportOverlay();
            rememberStableViewport();
            if (wasActive) {
                applyLayout();
                if (priorMode !== state.runtimeMode) render();
            }
        }, 160);
    }

    function bindVirtualKeyboardViewportGuard() {
        const root = document.getElementById(ROOT_ID);
        if (!root) return;
        enableNativeKeyboardOverlay();
        root.addEventListener("focusin", handleVirtualKeyboardFocus);
        root.addEventListener("focusout", handleVirtualKeyboardFocusOut);
        rememberStableViewport();
    }

    function bindResponsiveLayoutObserver() {
        const el = panel();
        if (!el || typeof ResizeObserver === "undefined" || responsiveLayoutRuntime.observer) return;
        const update = () => {
            if (responsiveLayoutRuntime.frame) return;
            responsiveLayoutRuntime.frame = requestAnimationFrame(() => {
                responsiveLayoutRuntime.frame = null;
                applyLayout();
            });
        };
        responsiveLayoutRuntime.observer = new ResizeObserver(update);
        responsiveLayoutRuntime.observer.observe(el);
        window.visualViewport?.addEventListener("resize", update, { passive: true });
        window.visualViewport?.addEventListener("scroll", update, { passive: true });
    }

    function handleRuntimeViewportChange() {
        const priorMode = state.runtimeMode;
        const viewport = visibleViewport();
        const focused = activeCompanionTextEntry();
        const baseline = keyboardViewportRuntime.baseline || viewport;
        const widthTolerance = Math.max(48, Math.round(asNumber(baseline.width) * VIRTUAL_KEYBOARD_WIDTH_TOLERANCE));
        const widthChanged = Math.abs(asNumber(viewport.width) - asNumber(baseline.width)) > widthTolerance;
        if (isMobileKeyboardRuntime() && isVirtualKeyboardViewportChange({
            focused: Boolean(focused),
            baseline,
            current: viewport,
            layoutHeight: window.innerHeight
        })) {
            lockKeyboardViewportOverlay();
            return;
        }
        const wasActive = keyboardViewportRuntime.active;
        if (wasActive) releaseKeyboardViewportOverlay();
        if (!focused || wasActive || widthChanged) rememberStableViewport(viewport);
        applyLayout();
        if (priorMode !== state.runtimeMode) render();
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

    function boundedLauncherLayout(layout = DEFAULT_LAYOUT, { width = 1024, height = 768, margin = PANEL_MARGIN, size = LAUNCHER_SIZE } = {}) {
        const viewportWidth = Math.max(1, asNumber(width, 1024));
        const viewportHeight = Math.max(1, asNumber(height, 768));
        const launcherSize = Math.max(1, Math.min(asNumber(size, LAUNCHER_SIZE), viewportWidth, viewportHeight));
        const safeMargin = Math.max(0, Math.min(asNumber(margin, PANEL_MARGIN), Math.floor(Math.min(viewportWidth, viewportHeight) / 4)));
        const maxX = Math.max(safeMargin, viewportWidth - launcherSize - safeMargin);
        const maxY = Math.max(safeMargin, viewportHeight - launcherSize - safeMargin);
        return {
            x: layout?.launcherX === null || layout?.launcherX === undefined ? null : clamp(Math.round(asNumber(layout.launcherX)), safeMargin, maxX),
            y: layout?.launcherY === null || layout?.launcherY === undefined ? null : clamp(Math.round(asNumber(layout.launcherY)), safeMargin, maxY),
            margin: safeMargin,
            size: launcherSize
        };
    }

    function shouldUseCompactLayout({ profile = "standard", kind = "desktop", viewportWidth = 1024 } = {}) {
        // TornPDA portrait and compact tablet widths use labelled rows before a wide table can clip.
        return profile === "narrow" || profile === "compact" || (kind === "tornpda" && asNumber(viewportWidth, 1024) <= 960);
    }

    function applyCompactLayout(profile, kind = currentRuntimeMode(), viewport = visibleViewport()) {
        const root = document.getElementById(ROOT_ID);
        const el = panel();
        if (!root || !el) return false;
        const compact = shouldUseCompactLayout({ profile, kind, viewportWidth: viewport.width });
        root.setAttribute("data-compact-layout", compact ? "true" : "false");
        return compact;
    }

    function isCompactViewport({ width = 1024, height = 768, scale = 1 } = {}) {
        return width <= 700 || height <= 520 || (scale > 1.1 && width <= 960);
    }

    function layoutProfile({ containerWidth = 0, viewportWidth = 1024, viewportHeight = 768, width = 0, height = 0, scale = 1 } = {}) {
        const availableWidth = Math.max(1, asNumber(containerWidth) || asNumber(width) || asNumber(viewportWidth));
        const visibleHeight = Math.max(1, asNumber(height) || asNumber(viewportHeight));
        if (availableWidth <= 440 || visibleHeight <= 390) return "narrow";
        if (availableWidth <= 760 || (asNumber(scale, 1) > 1.1 && availableWidth <= 1040)) return "compact";
        if (availableWidth >= 1160) return "wide";
        return "standard";
    }

    function runtimeKind({ isTornPDA = false, userAgent = "" } = {}) {
        return Boolean(isTornPDA) || tornPdaUserAgent(userAgent) ? "tornpda" : "desktop";
    }

    function runtimeMode(options = {}) {
        return runtimeKind(options);
    }

    function currentRuntimeMode() {
        return runtimeKind({
            isTornPDA: nativeRuntime.isTornPDA,
            userAgent: currentUserAgent()
        });
    }

    function currentLayoutProfile() {
        const viewport = visibleViewport();
        const rect = panel()?.getBoundingClientRect();
        return layoutProfile({
            containerWidth: rect?.width,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            scale: window.visualViewport?.scale || 1
        });
    }

    function applyRuntimeMode() {
        const kind = currentRuntimeMode();
        const profile = currentLayoutProfile();
        state.runtimeMode = kind;
        state.runtimeKind = kind;
        state.layoutProfile = profile;
        if (kind === "tornpda") enableNativeKeyboardOverlay();
        const root = document.getElementById(ROOT_ID);
        root?.setAttribute("data-runtime", kind);
        root?.setAttribute("data-layout-profile", profile);
        return { kind, profile };
    }

    function applyLayout() {
        const el = panel();
        const launcher = document.getElementById("ncc-launcher");
        if (!el || !launcher) return;
        if (keyboardViewportRuntime.active && !state.layout.minimized) return;
        const { kind, profile } = applyRuntimeMode();
        const viewport = visibleViewport();
        const layout = boundedPanelLayout(state.layout, viewport);
        const launcherLayout = boundedLauncherLayout(state.layout, { ...viewport, margin: kind === "tornpda" ? 10 : 18 });
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
        if (launcherLayout.x === null) {
            launcher.style.left = "auto";
            launcher.style.right = `${launcherLayout.margin}px`;
        } else {
            launcher.style.left = `${launcherLayout.x}px`;
            launcher.style.right = "auto";
        }
        launcher.style.top = `${launcherLayout.y === null ? launcherLayout.margin : launcherLayout.y}px`;
        el.classList.toggle("ncc-compact", profile === "narrow" || profile === "compact");
        launcher.classList.toggle("ncc-compact", profile === "narrow" || profile === "compact");
        el.classList.toggle("ncc-hidden", Boolean(layout.minimized));
        launcher.classList.toggle("ncc-hidden", !layout.minimized);
        applyCompactLayout(profile, kind, viewport);
        rememberStableViewport(viewport);
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
        await storeSet(STORE.layout, state.layout, { immediate: true });
    }

    async function persistLauncherPosition() {
        const launcher = document.getElementById("ncc-launcher");
        if (!launcher) return;
        const rect = launcher.getBoundingClientRect();
        const mode = currentRuntimeMode();
        const launcherLayout = boundedLauncherLayout({ ...state.layout, launcherX: rect.left, launcherY: rect.top }, {
            ...visibleViewport(),
            margin: mode === "tornpda" ? 10 : 18,
            size: Math.max(rect.width, rect.height, LAUNCHER_SIZE)
        });
        state.layout = { ...state.layout, launcherX: launcherLayout.x, launcherY: launcherLayout.y };
        await storeSet(STORE.layout, state.layout, { immediate: true });
    }

    function launcherTapActivates(start = {}, end = start, threshold = 8) {
        const startX = asNumber(start.clientX ?? start.x);
        const startY = asNumber(start.clientY ?? start.y);
        const endX = asNumber(end.clientX ?? end.x);
        const endY = asNumber(end.clientY ?? end.y);
        return Math.hypot(endX - startX, endY - startY) <= Math.max(0, asNumber(threshold, 8));
    }

    function bindLauncherInteractions() {
        const launcher = document.getElementById("ncc-launcher");
        if (!launcher || launcher.dataset.bound) return;
        launcher.dataset.bound = "true";
        let drag = null;
        let suppressClickUntil = 0;
        const finishDrag = async () => {
            if (!drag) return;
            const moved = drag.moved;
            drag = null;
            if (!moved) return;
            suppressClickUntil = Date.now() + 500;
            await persistLauncherPosition();
        };
        launcher.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            const rect = launcher.getBoundingClientRect();
            drag = {
                startX: event.clientX,
                startY: event.clientY,
                dx: event.clientX - rect.left,
                dy: event.clientY - rect.top,
                moved: false
            };
            launcher.setPointerCapture?.(event.pointerId);
        });
        launcher.addEventListener("pointermove", (event) => {
            if (!drag) return;
            const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
            if (!drag.moved && distance < 8) return;
            drag.moved = true;
            const mode = currentRuntimeMode();
            const launcherLayout = boundedLauncherLayout({
                ...state.layout,
                launcherX: Math.round(event.clientX - drag.dx),
                launcherY: Math.round(event.clientY - drag.dy)
            }, {
                ...visibleViewport(),
                margin: mode === "tornpda" ? 10 : 18,
                size: Math.max(launcher.getBoundingClientRect().width, launcher.getBoundingClientRect().height, LAUNCHER_SIZE)
            });
            state.layout = { ...state.layout, launcherX: launcherLayout.x, launcherY: launcherLayout.y };
            applyLayout();
            event.preventDefault();
        });
        launcher.addEventListener("pointerup", (event) => {
            const wasTap = drag && launcherTapActivates({ x: drag.startX, y: drag.startY }, event);
            void finishDrag();
            if (wasTap) {
                suppressClickUntil = Date.now() + 500;
                void toggleMinimized(false);
            }
        });
        launcher.addEventListener("pointercancel", () => { void finishDrag(); });
        launcher.addEventListener("lostpointercapture", () => { void finishDrag(); });
        launcher.addEventListener("click", (event) => {
            if (Date.now() < suppressClickUntil) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            void toggleMinimized(false);
        });
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
                #ncc-launcher { position:fixed; right:18px; top:18px; z-index:2147483646; width:52px; height:52px; border:1px solid #54dfbd; border-radius:17px; background:linear-gradient(145deg,#123e45,#122639); color:#dffcf4; box-shadow:0 12px 34px #0009; font-size:24px; cursor:grab; touch-action:none; user-select:none; }
                #ncc-launcher:active { cursor:grabbing; }
                #ncc-panel { position:fixed; z-index:2147483646; display:flex; flex-direction:column; overflow:hidden; min-width:0; min-height:0; max-width:calc(100vw - 8px); max-height:calc(100vh - 8px); border:1px solid #34516a; border-radius:16px; background:linear-gradient(150deg,#0d1a29 0%,#0a1421 60%,#101927 100%); color:#dbe7f4; box-shadow:0 18px 55px #000b; resize:none; }
                #ncc-panel.ncc-hidden, #ncc-launcher.ncc-hidden { display:none; }
                .ncc-resize-grip { position:absolute; z-index:4; bottom:0; width:24px; height:24px; margin:0; padding:0; border:0; background:transparent; touch-action:none; }
                .ncc-resize-grip::before { position:absolute; right:5px; bottom:5px; width:11px; height:11px; content:""; border-right:2px solid #5cbfaf; border-bottom:2px solid #5cbfaf; opacity:.9; }
                .ncc-resize-grip:hover::before, .ncc-resize-grip:focus-visible::before { border-color:#d9fff4; opacity:1; }
                .ncc-resize-grip-left { left:0; cursor:nesw-resize; transform:scaleX(-1); }
                .ncc-resize-grip-right { right:0; cursor:nwse-resize; }
                .ncc-head { display:flex; align-items:center; gap:10px; min-height:55px; padding:10px 12px 9px 15px; border-bottom:1px solid #294157; background:linear-gradient(90deg,#112b3b,#102234 70%,#112030); cursor:move; user-select:none; }
                .ncc-brand { min-width:0; flex:1; }
                .ncc-brand strong { display:block; color:#dffcf4; font-size:13px; letter-spacing:.03em; }
                .ncc-brand small { display:block; max-width:510px; overflow-wrap:anywhere; color:#94a8ba; font-size:10px; }
                .ncc-head-actions { display:flex; gap:6px; cursor:default; }
                #ncc-company-selector { width:min(260px,100%); margin-top:5px; min-height:27px; cursor:pointer; touch-action:manipulation; user-select:auto; -webkit-user-select:auto; font-size:10px; }
                .ncc-icon { width:29px; height:29px; border:1px solid #39546b; border-radius:8px; background:#132337; color:#bcd0df; cursor:pointer; font-size:14px; }
                .ncc-refresh-button { min-height:29px; padding:5px 8px; }
                .ncc-icon:hover, .ncc-tab.active, .ncc-primary:hover { border-color:#4ce0bd; color:#e5fff8; }
                .ncc-tabs { display:flex; flex-wrap:wrap; gap:5px; min-width:0; padding:8px 10px; border-bottom:1px solid #253d52; background:#0d1a28; }
                .ncc-tab { flex:1 1 72px; min-width:0; min-height:30px; padding:6px 10px; border:1px solid transparent; border-radius:7px; background:transparent; color:#8fa6b9; cursor:pointer; font-size:11px; font-weight:700; overflow-wrap:anywhere; }
                .ncc-tab:hover { color:#e0eef7; background:#14283a; }
                .ncc-tab.active { background:#163a48; color:#dffcf4; }
                #ncc-content { min-width:0; min-height:0; flex:1; overflow-x:hidden; overflow-y:auto; padding:12px; overscroll-behavior:contain; touch-action:pan-y pinch-zoom; -webkit-overflow-scrolling:touch; }
                .ncc-tab-status { display:flex; flex-wrap:wrap; gap:5px 10px; align-items:center; margin:0 0 10px; padding:7px 9px; border:1px solid #29465d; border-radius:8px; background:#102235; color:#9eb4c4; font-size:10px; overflow-wrap:anywhere; }
                .ncc-tab-status b { color:#7fe3bd; }
                .ncc-tab-status.ncc-partial b { color:#ffd477; }
                .ncc-tab-status.ncc-stale b, .ncc-tab-status.ncc-not-updated b { color:#ff9ca4; }
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
                .ncc-label { display:block; color:#8ca4b7; font-size:10px; font-weight:700; letter-spacing:.04em; overflow-wrap:anywhere; text-transform:uppercase; }
                .ncc-value { display:block; margin-top:6px; color:#ecf8fc; font-size:19px; font-weight:790; letter-spacing:-.025em; overflow-wrap:anywhere; }
                .ncc-sub { display:block; margin-top:4px; color:#91a8b9; font-size:10px; overflow-wrap:anywhere; }
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
                .ncc-table-wrap { max-width:100%; overflow:visible; border:1px solid #29465d; border-radius:8px; }
                .ncc-table { width:100%; max-width:100%; table-layout:fixed; border-collapse:collapse; font-size:10.5px; white-space:normal; }
                .ncc-team-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:7px; }
                .ncc-team-list { display:flex; flex-direction:column; gap:8px; }
                .ncc-team-card { min-width:0; min-height:90px; padding:7px; border:1px solid #294961; border-radius:8px; background:#0b1927; }
                .ncc-team-card.ncc-misplaced { border-color:#8b6d32; background:#2a251b; }
                .ncc-team-list .ncc-team-card { min-height:0; padding:10px 12px; }
                .ncc-team-list .ncc-team-line { margin-top:6px; font-size:11px; line-height:1.3; }
                .ncc-team-list .ncc-team-name { font-size:12px; }
                .ncc-team-list .ncc-team-meta, .ncc-team-list .ncc-team-assigned, .ncc-team-list .ncc-team-effects { font-size:10px; }
                .ncc-team-list .ncc-team-select { width:min(340px,58%); min-height:29px; font-size:10px; }
                .ncc-team-list .ncc-team-top, .ncc-team-list .ncc-team-line { align-items:flex-start; flex-wrap:wrap; }
                .ncc-team-list .ncc-team-name, .ncc-team-list .ncc-team-meta, .ncc-team-list .ncc-team-current, .ncc-team-list .ncc-team-assigned, .ncc-team-list .ncc-team-effects { overflow:visible; overflow-wrap:anywhere; text-overflow:clip; white-space:normal; }
                .ncc-team-list .ncc-team-current, .ncc-team-list .ncc-team-assigned { flex:1 1 260px; text-align:left; }
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
                .ncc-kv { display:grid; grid-template-columns:minmax(115px,1fr) minmax(90px,1fr); gap:8px; min-width:0; padding:7px 0; border-bottom:1px solid #1d3549; font-size:11px; }
                .ncc-kv span { min-width:0; }
                .ncc-kv:last-child { border-bottom:0; }
                .ncc-kv span:first-child { color:#90a7b9; }
                .ncc-kv span:last-child { overflow-wrap:anywhere; color:#e2eef4; font-weight:700; text-align:right; }
                .ncc-news-list { min-width:0; }
                .ncc-news-list .ncc-kv { grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr); }
                .ncc-news-list .ncc-kv span:last-child { overflow-wrap:anywhere; }
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
                .ncc-summary-strip { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr)); max-width:100%; border:1px solid #2c5861; border-radius:9px; background:#103538; }
                .ncc-summary-strip > div { min-width:0; padding:9px; border-right:1px solid #286064; overflow-wrap:anywhere; }
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
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list-wrap { overflow:visible; border:0; border-radius:0; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list, #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list tbody { display:block; width:100%; white-space:normal; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list thead { display:none; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list tbody tr { display:grid; grid-template-columns:34px minmax(0,1fr) auto; column-gap:7px; row-gap:3px; margin:0 0 6px; padding:7px 8px; border:1px solid #29465d; border-radius:8px; background:#0b1927; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list tbody tr:last-child { margin-bottom:0; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list td { display:none; min-width:0; padding:0; border:0; overflow:hidden; text-align:left; text-overflow:ellipsis; white-space:nowrap; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list td::before { display:none; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list td:nth-child(1) { display:block; color:#8ca4b7; font-weight:700; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list td:nth-child(2) { display:block; min-width:0; overflow:visible; overflow-wrap:anywhere; text-overflow:clip; white-space:normal; }
                #${ROOT_ID}[data-layout-profile="compact"] .ncc-tabs, #${ROOT_ID}[data-layout-profile="narrow"] .ncc-tabs { display:grid; grid-template-columns:repeat(auto-fit,minmax(68px,1fr)); }
                #${ROOT_ID}[data-layout-profile="compact"] .ncc-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
                #${ROOT_ID}[data-layout-profile="compact"] .ncc-team-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
                #${ROOT_ID}[data-layout-profile="narrow"] .ncc-grid, #${ROOT_ID}[data-layout-profile="narrow"] .ncc-grid.ncc-grid-2, #${ROOT_ID}[data-layout-profile="narrow"] .ncc-grid.ncc-grid-3 { grid-template-columns:1fr; }
                #${ROOT_ID}[data-layout-profile="narrow"] .ncc-team-grid { grid-template-columns:1fr; }
                #${ROOT_ID}[data-layout-profile="narrow"] .ncc-head { align-items:flex-start; flex-wrap:wrap; }
                #${ROOT_ID}[data-layout-profile="narrow"] .ncc-head-actions { width:100%; justify-content:space-between; }
                #${ROOT_ID}[data-layout-profile="narrow"] .ncc-section-head, #${ROOT_ID}[data-layout-profile="narrow"] .ncc-kv { align-items:flex-start; grid-template-columns:1fr; }
                #${ROOT_ID}[data-layout-profile="narrow"] .ncc-kv span:last-child { text-align:left; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list td:nth-child(3) { display:block; color:#a8c9d9; text-align:right; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-rank-list td:nth-child(5) { display:block; grid-column:2 / 4; color:#75dfbc; font-size:10px; font-weight:700; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-news-list .ncc-kv { grid-template-columns:minmax(0,1fr); gap:3px; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-news-list .ncc-kv span:last-child { display:block; overflow:visible; overflow-wrap:anywhere; text-align:left; white-space:normal; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-trend-detail { grid-template-columns:minmax(0,1fr); }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-trend-detail .ncc-kv { grid-template-columns:minmax(0,1fr); gap:3px; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-trend-detail .ncc-kv span:last-child { overflow-wrap:anywhere; text-align:left; white-space:normal; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-team-top, #${ROOT_ID}[data-compact-layout="true"] .ncc-team-line { align-items:flex-start; flex-wrap:wrap; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-team-name, #${ROOT_ID}[data-compact-layout="true"] .ncc-team-meta, #${ROOT_ID}[data-compact-layout="true"] .ncc-team-current, #${ROOT_ID}[data-compact-layout="true"] .ncc-team-assigned, #${ROOT_ID}[data-compact-layout="true"] .ncc-team-effects { overflow:visible; overflow-wrap:anywhere; text-overflow:clip; white-space:normal; }
                #${ROOT_ID}[data-compact-layout="true"] .ncc-team-select { width:100%; }
                #${ROOT_ID}[data-runtime="tornpda"] #ncc-panel { inset:max(4px, env(safe-area-inset-top)) 4px max(4px, env(safe-area-inset-bottom)) 4px !important; width:auto !important; height:auto !important; min-width:0; min-height:0; border-radius:11px; resize:none; }
                #${ROOT_ID}[data-runtime="tornpda"][data-virtual-keyboard-open="true"] #ncc-panel { inset:max(4px, env(safe-area-inset-top)) 4px auto 4px !important; height:var(--ncc-keyboard-panel-height) !important; max-height:none !important; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-resize-grip { display:none; }
                #${ROOT_ID}[data-runtime="tornpda"] #ncc-launcher { top:max(10px, env(safe-area-inset-top)); right:10px; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-head { min-height:54px; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-grid, #${ROOT_ID}[data-runtime="tornpda"] .ncc-grid.ncc-grid-2 { grid-template-columns:1fr; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-card { min-height:73px; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-value { font-size:18px; }
                #${ROOT_ID}[data-runtime="tornpda"] #ncc-content { padding:9px; overflow-x:hidden !important; overflow-y:auto !important; overscroll-behavior:contain; touch-action:pan-y pinch-zoom; -webkit-overflow-scrolling:touch; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-table { white-space:normal; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-table th, #${ROOT_ID}[data-runtime="tornpda"] .ncc-table td { padding:8px 6px; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-input[type="search"] { min-width:130px; flex:1; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-summary-strip { grid-template-columns:repeat(auto-fit,minmax(min(120px,100%),1fr)); }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-team-grid { grid-template-columns:1fr; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-team-card { min-height:96px; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-team-select { width:60%; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-refresh-button { width:29px; padding:0; }
                #${ROOT_ID}[data-runtime="tornpda"] .ncc-refresh-label { display:none; }
            </style>
            <button id="ncc-launcher" class="ncc-hidden" type="button" aria-label="Open Naughty Company Companion" title="Tap to open. Drag to move.">♜</button>
            <section id="ncc-panel" aria-label="Naughty Company Companion">
                <header class="ncc-head" id="ncc-drag-handle">
                    <div class="ncc-brand"><strong>Naughty Company Companion</strong><small id="ncc-status">Loading…</small><select id="ncc-company-selector" class="ncc-select" aria-label="Select company"></select></div>
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
        bindLauncherInteractions();
        bindVirtualKeyboardViewportGuard();
        bindDragAndResize();
        bindResponsiveLayoutObserver();
        applyLayout();
    }

    function metricCard(label, value, sub = "", tone = "", action = "") {
        return `<article class="ncc-card ${action ? "clickable" : ""}" ${action ? `data-action="${action}"` : ""}><span class="ncc-label">${escapeHtml(label)}</span><strong class="ncc-value ${tone}">${escapeHtml(value)}</strong><span class="ncc-sub">${escapeHtml(sub)}</span></article>`;
    }

    function applicationStatusSummary(applications) {
        const summary = { pending: 0, accepted: 0, withdrawn: 0, other: 0, total: 0 };
        (Array.isArray(applications) ? applications : []).forEach((application) => {
            summary.total += 1;
            const status = String(application?.status || "").trim().toLowerCase();
            if (status === "pending" || status === "accepted" || status === "withdrawn") summary[status] += 1;
            else summary.other += 1;
        });
        return summary;
    }

    function canStartHeaderDrag(target, button = 0) {
        if (button !== 0) return false;
        return !target?.closest?.("button, select, input, textarea, label, a, [contenteditable='true']");
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
        const applicationSummary = applicationStatusSummary(applications);
        const applicationsAvailable = state.data?.applicationsAvailable !== false;
        const applicationValue = applicationsAvailable ? `${formatNumber(applicationSummary.pending)} Pending` : "Unavailable";
        const applicationDetail = applicationsAvailable
            ? [`${formatNumber(applicationSummary.accepted)} Accepted`, `${formatNumber(applicationSummary.withdrawn)} Withdrawn`, applicationSummary.other ? `${formatNumber(applicationSummary.other)} Other` : ""].filter(Boolean).join(" · ")
            : "Applications require a Limited or higher key";
        const grid = `
            <div class="ncc-grid">
                ${metricCard("Company", profile.name || "Unknown", `${profile.type?.name || "Unknown type"} · ${formatNumber(profile.rating)}★`)}
                ${metricCard("Daily income", formatMoney(financesNow.dailyIncome), `${formatMoney(financesNow.weeklyIncome)} weekly`, "ncc-good")}
                ${metricCard("Daily Profit", formatMoney(financesNow.dailyProfit), financesNow.canProfit ? `${formatMoney(financesNow.weeklyProfit)} weekly` : financesNow.canProfitWeekly ? `${formatMoney(financesNow.weeklyProfit)} weekly · stock unavailable` : "Needs full wages + ad budget", profitTone)}
                ${metricCard("Health score", healthValue, healthSub, rankings ? "ncc-good" : "ncc-muted", rankings ? "show-health" : "load-rankings")}
                ${metricCard("30-day income", formatMoney(monthlyIncome), monthly.useTrackedIncome ? `${monthly.coverage}/30 tracked days` : `${monthly.coverage}/30 tracked · forecast`, "ncc-good")}
                ${metricCard("30-day Profit", formatMoney(monthlyProfit), monthlyProfit === null ? "Needs profit access" : monthly.useTrackedProfit ? `${monthly.profitCoverage}/30 tracked days` : `${monthly.profitCoverage}/30 tracked · forecast`, monthlyProfit !== null && monthlyProfit >= 0 ? "ncc-good" : monthlyProfit === null ? "ncc-muted" : "ncc-bad")}
                ${metricCard("Workforce", `${formatNumber(profile.employees?.hired)} / ${formatNumber(profile.employees?.capacity)}`, averageEfficiency === null ? "Employee details unavailable" : `Avg effectiveness ${formatAverageEffectiveness(averageEfficiency)}`)}
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
                ${metricCard("Applications", applicationValue, applicationDetail, applicationsAvailable ? "" : "ncc-muted")}
            </div>`;
        const newsRows = (state.data?.news || []).slice(0, 4).map((item) => `<div class="ncc-kv"><span>${escapeHtml(formatDateTime(asNumber(item.timestamp) * 1000))}</span><span title="${escapeHtml(item.text || "")}">${escapeHtml(String(item.text || "No details").replace(/<[^>]*>/g, ""))}</span></div>`).join("");
        const recentNews = newsRows ? `<div class="ncc-news-list">${newsRows}</div>` : `<span class="ncc-muted">Funds news requires a Limited or higher key.</span>`;
        return `${dataNotice()}${grid}${section("Income rank & star outlook", rankBody, `<button class="ncc-button ncc-primary" data-action="load-rankings" title="Checks whether same-type rankings have completed this Torn daily tick; only loads Torn pages when the current tick still needs a successful ranking pull" ${state.rankingLoading ? "disabled" : ""}>${state.rankingLoading ? "Loading same-type rankings…" : rankings ? "Check daily rankings refresh" : "Load daily rankings"}</button>`)}<div class="ncc-grid ncc-grid-2">${section("Company condition", conditionBody)}${section("Recent funds news", recentNews)}</div><p class="ncc-note">Income is supplied by Torn. Profit is calculated as: daily income − sold stock cost − ads − wages; weekly profit excludes stock cost because Torn exposes sold stock as a daily value. Monthly values become tracked totals after enough local daily snapshots.</p>`;
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
            return `<article class="ncc-team-card ${misplaced ? "ncc-misplaced" : ""}"><div class="ncc-team-top"><input type="checkbox" data-lock-employee="${row.id}" ${row.locked ? "checked" : ""} title="Lock: keep this employee in their current position during auto-assign"><b class="ncc-team-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</b><span class="ncc-team-meta">${escapeHtml(row.status)} · ${formatOptionalNumber(row.days)}d</span></div><div class="ncc-team-line"><span class="ncc-team-current" title="Current position and total effectiveness"><b>Current:</b> ${escapeHtml(row.currentPosition || "—")} · ${formatOptionalNumber(row.currentEfficiency)}</span><span class="ncc-team-meta">${escapeHtml(row.currentEfficiencySource)}</span></div><div class="ncc-team-line"><select class="ncc-select ncc-team-select" data-assignment="${row.id}" title="Assigned position for this local projection" ${positions.length ? "" : "disabled"}>${selectOptions(row) || "<option>Unavailable</option>"}</select><span class="ncc-team-assigned" title="Assigned efficiency"><b>Assigned:</b> ${formatOptionalNumber(row.assignedEfficiency)} · ${formatSignedNumber(row.nonWorkingDelta)}</span></div><div class="ncc-team-line ncc-team-effects"><span class="${asNumber(row.addiction) < 0 ? "ncc-bad" : ""}">Addiction ${formatSignedNumber(row.addiction)}</span><span class="${asNumber(row.inactivity) < 0 ? "ncc-bad" : ""}">Inactivity ${formatSignedNumber(row.inactivity)}</span><span title="Best-fit projected position">Best ${escapeHtml(row.bestPosition || "—")} ${formatOptionalNumber(row.bestEfficiency)}</span></div><div class="ncc-team-line ncc-team-effects"><span>Wage ${formatMoney(row.wage, true)} · Last action ${escapeHtml(lastAction)}</span></div></article>`;
        }).join("")}</div>` : `<div class="ncc-notice">No employee rows match the filter, or employee details are not available for this API key.</div>`;
        const values = rows.map((row) => row.currentEfficiency).filter((value) => value !== null);
        const affected = rows.filter((row) => asNumber(row.addiction) < 0 || asNumber(row.inactivity) < 0).length;
        const runtimeLabel = nativeRuntime.isTornPDA
            ? "TornPDA (native confirmed) / compact cards"
            : tornPdaUserAgent(currentUserAgent())
                ? "TornPDA (awaiting native confirmation) / compact cards"
                : mode === "tornpda" ? "TornPDA touch cards" : "Desktop detailed list";
        return `${dataNotice()}<div class="ncc-toolbar"><input class="ncc-input" id="ncc-team-filter" type="search" value="${escapeHtml(state.teamFilter)}" placeholder="Filter employee or role"><button class="ncc-button ncc-primary" data-action="recalculate-local-roles" title="Recalculates local role projections from the employee work stats already supplied by Torn">Recalculate local roles</button><button class="ncc-button" data-tab="planner">Open capacity planner</button><span class="ncc-help">${runtimeLabel} · ${formatNumber(rows.length)} staff · ${formatNumber(state.data?.profile?.employees?.capacity)} capacity · Avg. ${values.length ? formatAverageEffectiveness(values.reduce((sum, value) => sum + asNumber(value), 0) / values.length) : "—"} effectiveness · ${formatNumber(affected)} with penalties</span></div>${section("Employee efficiency", table)}<p class="ncc-note">Current Eff. is Torn’s total effectiveness. Assigned and best-fit values use the local role calculator plus the same Torn non-working-stat effect delta.</p>`;
    }

    function formatSignedNumber(value, digits = 0) {
        const number = asFinite(value);
        if (number === null) return "—";
        return `${number > 0 ? "+" : ""}${formatNumber(number, digits)}`;
    }

    function renderPositionConfigModal() {
        const rows = employeeRows();
        const positions = projectionPositions();
        const settings = currentCompanySettings();
        const assignments = calculateAssignmentPreview(rows, settings);
        const orderedPositions = orderedPriorityPositions(positions, settings.priority);
        const maxQty = Math.max(1, Math.floor(asNumber(state.data?.profile?.employees?.capacity, rows.length || 1)));
        const capacityRows = positions.length ? `<div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr><th>Position</th><th>Max qty</th><th>Priority</th><th>Occupied</th></tr></thead><tbody>${orderedPositions.map((position, index) => `<tr>${stackCell("Position", `<b>${escapeHtml(position)}</b>`)}${stackCell("Max qty", `<select class="ncc-select" data-capacity="${escapeHtml(position)}"><option value="0" ${asNumber(settings.capacities[position]) === 0 ? "selected" : ""}>Uncapped</option>${Array.from({ length: maxQty }, (_, quantity) => quantity + 1).map((quantity) => `<option value="${quantity}" ${asNumber(settings.capacities[position]) === quantity ? "selected" : ""}>${quantity}</option>`).join("")}</select>`)}${stackCell("Priority", `<span class="ncc-priority-control"><button class="ncc-icon" data-action="priority-up" data-position="${escapeHtml(position)}" title="Move ${escapeHtml(position)} up" ${index === 0 ? "disabled" : ""}>↑</button><b>${index + 1}</b><button class="ncc-icon" data-action="priority-down" data-position="${escapeHtml(position)}" title="Move ${escapeHtml(position)} down" ${index === orderedPositions.length - 1 ? "disabled" : ""}>↓</button></span>`)}${stackCell("Occupied", formatNumber(assignments.occupied[position] || 0))}</tr>`).join("")}</tbody></table></div>` : `<div class="ncc-notice warn">Local role requirements are not yet available for this company type.</div>`;
        return `<div class="ncc-modal-backdrop" data-action="close-modal"><section class="ncc-modal" role="dialog" aria-modal="true" aria-label="Position capacity and priority"><header class="ncc-modal-head"><h2>Position capacity & priority</h2><button class="ncc-icon" data-action="close-modal" title="Close position config">×</button></header><div class="ncc-modal-body">${capacityRows}<p class="ncc-note">Priority is saved immediately. The top role fills first; choose Uncapped or 1–${formatNumber(maxQty)} for Max Qty.</p><div class="ncc-inline" style="margin-top:10px"><button class="ncc-button ncc-primary" data-action="save-planner" ${positions.length ? "" : "disabled"}>Save position config</button><button class="ncc-button" data-action="close-modal">Close</button></div></div></section></div>`;
    }

    function renderPlanner() {
        const rows = employeeRows();
        const positions = projectionPositions();
        const settings = currentCompanySettings();
        const assignments = calculateAssignmentPreview(rows, settings);
        const previewRows = sortRows(rows.map((row) => {
            const hasSavedAssignment = Object.prototype.hasOwnProperty.call(settings.assignments || {}, row.id);
            const assigned = hasSavedAssignment ? settings.assignments[row.id] : row.currentPosition;
            const base = row.projected?.[assigned];
            const projected = base === undefined ? null : asNumber(base) + row.nonWorkingDelta;
            const change = projected === null || row.currentEfficiency === null ? null : projected - row.currentEfficiency;
            return { ...row, previewAssigned: assigned, previewEfficiency: projected, previewChange: change };
        }), { key: (row) => ({ name: row.name, current: row.currentPosition, assigned: row.previewAssigned, currentEfficiency: row.currentEfficiency, assignedEfficiency: row.previewEfficiency, change: row.previewChange, lock: row.locked ? 1 : 0 }[state.sort.planner.key]), dir: state.sort.planner.dir });
        const rowsTable = previewRows.length ? `<div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr>${sortHeader("Employee", "name", "planner")}${sortHeader("Current", "current", "planner")}${sortHeader("Assigned", "assigned", "planner")}${sortHeader("Current eff.", "currentEfficiency", "planner")}${sortHeader("Assigned eff.", "assignedEfficiency", "planner")}${sortHeader("Change", "change", "planner")}${sortHeader("Lock", "lock", "planner")}</tr></thead><tbody>${previewRows.map((row) => `<tr class="${row.previewAssigned !== row.currentPosition ? "ncc-misplaced" : ""}">${stackCell("Employee", `<b>${escapeHtml(row.name)}</b>`)}${stackCell("Current", escapeHtml(row.currentPosition || "—"))}${stackCell("Assigned", escapeHtml(row.previewAssigned || "Unassigned"))}${stackCell("Current eff.", formatOptionalNumber(row.currentEfficiency))}${stackCell("Assigned eff.", formatOptionalNumber(row.previewEfficiency), row.previewChange !== null && row.previewChange > 0 ? "ncc-good" : row.previewChange !== null && row.previewChange < 0 ? "ncc-bad" : "")}${stackCell("Change", formatSignedNumber(row.previewChange))}${stackCell("Lock", row.locked ? "Locked" : "Flexible")}</tr>`).join("")}</tbody></table></div>` : "";
        const warnings = assignments.lockedOverages.map(([position, used]) => `${formatNumber(used)} locked employees exceed ${escapeHtml(position)}’s maximum.`).join(" ");
        return `${dataNotice()}<div class="ncc-toolbar"><button class="ncc-button" data-action="open-position-config" ${positions.length ? "" : "disabled"}>Position config</button><button class="ncc-button ncc-primary" data-action="auto-assign" ${positions.length ? "" : "disabled"}>Auto-assign unlocked staff</button><button class="ncc-button" data-action="recalculate-local-roles" title="Recalculates local role efficiencies from Torn employee work stats">Recalculate local roles</button><span class="ncc-help">Configure position maximums and priority in Position config. The top role fills first.</span></div>${warnings ? `<div class="ncc-notice warn">${warnings}</div>` : ""}${section("Assignment preview", rowsTable)}<p class="ncc-note">Auto assignment keeps locked employees in their current seats, then greedily fills positions by priority with the highest remaining local role effectiveness while respecting configured role caps and total company capacity. It only saves a local plan.</p>`;
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
            return `${dataNotice()}${section("Company rankings", `<div class="ncc-empty"><div><p>Load all ${escapeHtml(profile.type?.name || "same-type")} companies to see your weekly-income rank, health score, star thresholds, and nearest competitors.</p><button class="ncc-button ncc-primary" data-action="load-rankings" ${state.rankingLoading ? "disabled" : ""}>${state.rankingLoading ? "Loading rankings…" : "Check daily rankings refresh"}</button></div></div>`)}<p class="ncc-note">Torn returns at most 100 companies per request. The companion follows pagination, deduplicates rows, and then sorts locally by weekly income. A successful Torn-day pull is not repeated by the manual control.</p>`;
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
        const table = `<div class="ncc-table-wrap ncc-rank-list-wrap"><table class="ncc-table ncc-rank-list"><thead><tr>${sortHeader("Rank", "rank", "rankings")}${sortHeader("Company", "name", "rankings")}${sortHeader("Rating", "rating", "rankings")}${sortHeader("Daily income", "daily", "rankings")}${sortHeader("Weekly income", "weekly", "rankings")}</tr></thead><tbody>${shown.map((row) => `<tr class="${row.own ? "ncc-own-row" : ""}">${stackCell("Rank", formatNumber(row.rank))}${stackCell("Company", `<b>${escapeHtml(row.name || "Unknown")}</b>${row.own ? " <span class=\"ncc-pill good\">Your company</span>" : ""}`)}${stackCell("Rating", `${formatNumber(row.rating)}★`)}${stackCell("Daily income", formatMoney(row.daily, true))}${stackCell("Weekly income", formatMoney(row.weekly, true))}</tr>`).join("")}</tbody></table></div>`;
        return `${dataNotice()}<div class="ncc-toolbar"><input class="ncc-input" id="ncc-rankings-filter" type="search" value="${escapeHtml(state.rankingsFilter)}" placeholder="Filter company or rank"><button class="ncc-button ncc-primary" data-action="load-rankings" title="Checks the current Torn-day success record before loading same-type rankings" ${state.rankingLoading ? "disabled" : ""}>${state.rankingLoading ? "Loading same-type rankings…" : "Check daily rankings refresh"}</button><button class="ncc-button" data-action="show-health">View rank neighbors</button><span class="ncc-help">Updated ${timeAgo(record.fetchedAt)} · ${formatNumber(metrics.total)} companies</span></div>${section("Your company", `${strip}<p class="ncc-note">Health score is your weekly-income percentile among the same company type. Star slots use a ${slotSource}; the income gaps are observed planning values, not official Torn thresholds.</p>`)}${section("Same-type companies", `${table}${rows.length > shown.length ? `<p class="ncc-note">Showing the first ${formatNumber(shown.length)} filtered companies.</p>` : ""}`)}`;
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
        const stockChart = trendSvg(companyHistory(), "stock");
        let rows = Array.isArray(state.data?.stock) ? [...state.data.stock] : [];
        const sort = state.sort.stock;
        rows = sortRows(rows, { key: (item) => sort.key === "margin" ? asNumber(item.sold_worth) - asNumber(item.cost) * asNumber(item.sold_amount) : sort.key === "difference" ? stockDifference(item, previous) : sort.key === "current_worth" ? currentStockWorth(item) : item[sort.key], dir: sort.dir });
        const table = rows.length ? `<div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr>${sortHeader("Item", "name", "stock")}${sortHeader("In stock", "in_stock", "stock")}${sortHeader("Current stock worth", "current_worth", "stock")}${sortHeader("Stock difference", "difference", "stock")}${sortHeader("On order", "on_order", "stock")}${sortHeader("Cost", "cost", "stock")}${sortHeader("Price", "price", "stock")}${sortHeader("Sold", "sold_amount", "stock")}${sortHeader("Sold worth", "sold_worth", "stock")}${sortHeader("Gross margin", "margin", "stock")}</tr></thead><tbody>${rows.map((item) => {
            const margin = asNumber(item.sold_worth) - asNumber(item.cost) * asNumber(item.sold_amount);
            const difference = stockDifference(item, previous);
            return `<tr>${stackCell("Item", `<b>${escapeHtml(item.name || "Unknown")}</b><br><span class="ncc-muted">ID ${formatNumber(item.id)}</span>`)}${stackCell("In stock", formatNumber(item.in_stock))}${stackCell("Current stock worth", formatMoney(currentStockWorth(item)), "ncc-good")}${stackCell("Stock difference", difference === null ? "—" : formatSignedNumber(difference), difference === null ? "ncc-muted" : difference > 0 ? "ncc-good" : difference < 0 ? "ncc-bad" : "")}${stackCell("On order", formatNumber(item.on_order))}${stackCell("Cost", formatMoney(item.cost))}${stackCell("Price", formatMoney(item.price))}${stackCell("Sold", formatNumber(item.sold_amount))}${stackCell("Sold worth", formatMoney(item.sold_worth))}${stackCell("Gross margin", formatMoney(margin), margin >= 0 ? "ncc-good" : "ncc-bad")}</tr>`;
        }).join("")}</tbody></table></div>` : `<div class="ncc-notice warn">Stock details require a Limited or higher Director key.</div>`;
        return `${dataNotice()}${section("Stock trend", stockChart)}<div class="ncc-grid ncc-grid-3">${metricCard("Stock items", formatNumber(totals.inStock), `${formatNumber(totals.onOrder)} on order`)}${metricCard("Stock value", formatMoney(totals.saleValue), `${formatMoney(totals.costValue)} at cost`, "ncc-good")}${metricCard("Reported gross margin", formatMoney(totals.margin), `${formatMoney(totals.soldWorth)} sold worth`, totals.margin >= 0 ? "ncc-good" : "ncc-bad")}</div>${section("Stock & sales", table)}<p class="ncc-note">Stock difference is today’s in-stock amount minus the last local Torn reporting-day snapshot. It appears after a prior daily snapshot exists. Reported gross margin = sold worth − (cost × sold amount).</p>`;
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
        if (series.format === "effectiveness") return formatAverageEffectiveness(numeric);
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
        return `<div class="ncc-grid ncc-grid-3 ncc-trend-detail"><div class="ncc-kv"><span>Daily income</span><span>${trendNumber(row.dailyIncome) === null ? "—" : formatMoney(row.dailyIncome)}</span></div><div class="ncc-kv"><span>Stock</span><span>${stockValue === null ? "Unavailable" : `${formatMoney(stockValue, true)} · ${stockQuantity === null ? "—" : formatNumber(stockQuantity)} qty`}</span></div><div class="ncc-kv"><span>Avg employee eff.</span><span>${averageEfficiency === null ? "—" : formatAverageEffectiveness(averageEfficiency)}</span></div><div class="ncc-kv"><span>Star level</span><span>${trendNumber(row.rating) === null ? "—" : `${formatNumber(row.rating)}★`}</span></div><div class="ncc-kv"><span>Daily profit</span><span class="${dailyProfit === null ? "ncc-muted" : dailyProfit >= 0 ? "ncc-good" : "ncc-bad"}">${dailyProfit === null ? "—" : formatMoney(dailyProfit)}</span></div><div class="ncc-kv"><span>Company rank</span><span>${rank === null ? "Unavailable" : `${formatNumber(rank)}${rankTotal === null ? "" : ` / ${formatNumber(rankTotal)}`}`}</span></div><div class="ncc-kv"><span>Performance vs previous day</span><span class="${performance.tone}">${performance.label}</span></div></div><p class="ncc-note">${escapeHtml(formatDateTime(row.period))} · ${escapeHtml(performance.detail)}. Hover any chart point for daily values, or select one to compare that day with its prior local snapshot.</p>`;
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
        const trendTypes = ["income-profit", "effectiveness", "ranking"];
        const chart = trendChartDefinition(trendTypes.includes(state.selectedTrendChart) ? state.selectedTrendChart : "income-profit");
        const chartOptions = trendTypes.map((type) => {
            const item = trendChartDefinition(type);
            return `<option value="${item.id}" ${item.id === chart.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`;
        }).join("");
        const table = latest.length ? `<div class="ncc-table-wrap ncc-stack-wrap"><table class="ncc-table ncc-stack-table"><thead><tr><th>Reporting day</th><th>Daily income</th><th>Daily Profit</th><th>Weekly income</th><th>Weekly Profit</th><th>Rating</th><th>Funds</th></tr></thead><tbody>${latest.map((row) => `<tr>${stackCell("Reporting day", escapeHtml(formatDateTime(row.period)))}${stackCell("Daily income", trendNumber(row.dailyIncome) === null ? "—" : formatMoney(row.dailyIncome), "ncc-good")}${stackCell("Daily Profit", trendNumber(row.dailyProfit) === null ? "—" : formatMoney(row.dailyProfit), trendNumber(row.dailyProfit) === null ? "ncc-muted" : row.dailyProfit >= 0 ? "ncc-good" : "ncc-bad")}${stackCell("Weekly income", trendNumber(row.weeklyIncome) === null ? "—" : formatMoney(row.weeklyIncome))}${stackCell("Weekly Profit", trendNumber(row.weeklyProfit) === null ? "—" : formatMoney(row.weeklyProfit))}${stackCell("Rating", trendNumber(row.rating) === null ? "—" : `${formatNumber(row.rating)}★`)}${stackCell("Funds", trendNumber(row.funds) === null ? "—" : formatMoney(row.funds))}</tr>`).join("")}</tbody></table></div>` : `<div class="ncc-notice">The companion keeps one de-duplicated local snapshot per Torn reporting day (18:10 UTC). Refresh after installing to begin history.</div>`;
        return `${dataNotice()}<div class="ncc-toolbar"><label class="ncc-inline"><span class="ncc-label">Chart view</span><select id="ncc-trend-chart" class="ncc-select" title="Choose the local daily metric to chart">${chartOptions}</select></label><button class="ncc-button" data-action="export-history" ${history.length ? "" : "disabled"}>Export history CSV</button><button class="ncc-button ncc-danger" data-action="reset-history" ${history.length ? "" : "disabled"}>Clear local history</button><span class="ncc-help">${formatNumber(history.length)} retained daily snapshots · 92-day retention</span></div>${section(`${chart.label} trend`, trendSvg(history, chart.id))}${section("Local company history", table)}<p class="ncc-note">History stays in your userscript storage and is never uploaded by this companion. Income comes from one de-duplicated daily Torn snapshot per 18:10 UTC reporting day; Profit is calculated locally from the available daily inputs. Stock worth is recorded only when stock details are available; average employee effectiveness is the displayed current-effectiveness average; company rank is recorded only after same-type rankings load. Older snapshots can lack these newer metrics and remain unavailable rather than being inferred.</p>`;
    }

    function renderBackupRestoreModal() {
        const pending = state.pendingRestore;
        if (!pending?.backup) return "";
        const backup = pending.backup;
        const keyChoice = backup.includesApiKeys
            ? `<label class="ncc-check"><input id="ncc-restore-backup-keys" type="checkbox"><span><b>Restore API keys from this backup</b><br>Unchecked preserves the API keys already stored on this device. Key values are never shown.</span></label>`
            : `<div class="ncc-notice">This backup does not contain API keys. Existing local API keys will be preserved.</div>`;
        return `<div class="ncc-modal-backdrop" data-action="close-modal"><section class="ncc-modal" role="dialog" aria-modal="true" aria-label="Restore Company backup"><header class="ncc-modal-head"><h2>Restore local Company backup</h2><button class="ncc-icon" data-action="close-modal" title="Cancel backup restore">×</button></header><div class="ncc-modal-body"><div class="ncc-grid ncc-grid-2"><div class="ncc-kv"><span>Backup file</span><span title="${escapeHtml(pending.fileName)}">${escapeHtml(pending.fileName)}</span></div><div class="ncc-kv"><span>Created</span><span>${escapeHtml(formatDateTime(Date.parse(backup.createdAt)))}</span></div><div class="ncc-kv"><span>Schema</span><span>v${formatNumber(backup.schemaVersion)} · App ${escapeHtml(backup.appVersion)}</span></div><div class="ncc-kv"><span>API keys included</span><span>${backup.includesApiKeys ? "Yes — restore remains opt-in" : "No"}</span></div></div><p class="ncc-note">This replaces this companion’s separate local snapshots, history, rankings, planner, layout, alert state, daily-sync state, and settings. It cannot alter Torn data. The currently selected storage method stays in use.</p>${keyChoice}<label class="ncc-check" style="margin-top:10px"><input id="ncc-confirm-backup-restore" type="checkbox"><span><b>I understand this replaces my current local Company companion data.</b><br>The backup was validated before this confirmation step.</span></label><div class="ncc-inline" style="margin-top:12px"><button class="ncc-button ncc-danger" data-action="confirm-backup-restore">Restore and replace local data</button><button class="ncc-button" data-action="close-modal">Cancel</button></div></div></section></div>`;
    }

    function renderSettings() {
        const settings = state.settings;
        const accounts = companyAccountMap(settings);
        const viewport = visibleViewport();
        const panelRect = panel()?.getBoundingClientRect();
        const runtime = nativeRuntime.isTornPDA ? "TornPDA (native confirmed)" : tornPdaUserAgent(currentUserAgent()) ? "TornPDA (native confirmation pending)" : "Desktop / Tampermonkey";
        const screenSize = `${formatNumber(viewport.width)} × ${formatNumber(viewport.height)} visible${panelRect ? ` · panel ${formatNumber(Math.round(panelRect.width))} × ${formatNumber(Math.round(panelRect.height))}` : ""}`;
        const accountRows = Object.values(accounts).sort((left, right) => left.name.localeCompare(right.name)).map((account) => {
            const keyState = account.source === "pda" ? "TornPDA injected" : accountKey(account) ? "Director key saved" : "Director key missing — add again";
            return `<div class="ncc-kv"><span><b>${escapeHtml(account.name)}</b><br><small>${escapeHtml(account.typeName || "Company")} · ID ${formatNumber(account.id)}</small></span><span>${account.id === activeCompanyId() ? "Current · " : ""}${keyState}<br><button class="ncc-button" data-action="select-company" data-company-id="${escapeHtml(account.id)}">Open</button> <button class="ncc-button ncc-danger" data-action="remove-company" data-company-id="${escapeHtml(account.id)}">Remove</button></span></div>`;
        }).join("") || `<div class="ncc-notice">No saved Director-key company profile yet. Add one below, or refresh with TornPDA’s injected key.</div>`;
        const accountsSection = section("Company Director keys", `${accountRows}<div class="ncc-inline" style="margin-top:10px"><button class="ncc-button ncc-primary" data-action="open-company-account">Add company…</button><button class="ncc-button" data-action="refresh-all-companies">Sync saved companies now</button></div><p class="ncc-note">Each Limited-access Director key is validated against its own Company ID before it is saved. Saved keys are never rendered, logged, exported by default, or stored in TornPDA injected-key form.</p>`);
        const runtimeStorage = section("Runtime & storage", `<div class="ncc-kv"><span>Runtime</span><span>${escapeHtml(runtime)} · ${escapeHtml(state.runtimeKind)}</span></div><div class="ncc-kv"><span>Layout profile</span><span>${escapeHtml(state.layoutProfile)}</span></div><div class="ncc-kv"><span>Current screen size</span><span>${escapeHtml(screenSize)}</span></div><div class="ncc-kv"><span>Storage method</span><span>${escapeHtml(storageMethodLabel())}</span></div><label class="ncc-check" style="margin-top:10px"><input id="ncc-use-legacy-gm-storage" type="checkbox" ${settings.useLegacyGMStorage ? "checked" : ""}><span><b>Use legacy GM storage</b><br>Unchecked keeps TornPDA <code>PDA_storage</code> primary when available, with compatible GM/local fallback.</span></label>`);
        const alertModeOptions = [["off", "Off"], ["combined", "Combined all-company alert"], ["separate", "Separate alert for every company"], ["selected", "Selected company only"]].map(([value, label]) => `<option value="${value}" ${settings.dailyAlertMode === value ? "selected" : ""}>${label}</option>`).join("");
        const dailyAlertSettings = section("Daily Company alerts", `<label><span class="ncc-label">Alert scope at 18:10 UTC</span><select id="ncc-daily-alert-mode" class="ncc-select" style="width:100%;margin-top:6px">${alertModeOptions}</select></label><div class="ncc-grid ncc-grid-2" style="margin-top:10px"><label class="ncc-check"><input id="ncc-daily-tick-toasts" type="checkbox" ${settings.dailyTickToasts ? "checked" : ""}><span><b>Show daily-tick toasts</b><br>Daily Income, Daily Profit, Customer Count, Star Level, stock change, and employee-risk details remain fully visible.</span></label><label class="ncc-check"><input id="ncc-daily-tick-notifications" type="checkbox" ${settings.dailyTickNotifications ? "checked" : ""}><span><b>Show daily-tick notifications</b><br>TornPDA receives one native 18:10 reminder to open the Companion for its all-company sync.</span></label></div><div class="ncc-inline" style="margin-top:10px"><button class="ncc-button ncc-primary" data-action="save-settings">Save daily alert choices</button></div>`);
        const backupRestore = section("Backup & restore", `<label class="ncc-check"><input id="ncc-backup-include-keys" type="checkbox"><span><b>Include saved Director keys in this backup</b><br>Unchecked by default. Keys are never displayed, logged, or included unless selected for this single download.</span></label><div class="ncc-inline" style="margin-top:10px"><button class="ncc-button ncc-primary" data-action="download-company-backup">Download local Company backup</button><button class="ncc-button" data-action="choose-company-backup">Choose backup JSON to restore</button><input id="ncc-company-backup-file" type="file" accept="application/json,.json" style="display:none"></div><p class="ncc-note">Backups include separate company snapshots, history, rankings, planner data, layout, settings, daily-sync state, and alerts. API keys stay out unless you opt in both when creating and restoring a key-containing backup.</p>`);
        return `${dataNotice()}${accountsSection}${section("Local calculation & refresh", `<div class="ncc-grid ncc-grid-2"><label class="ncc-check"><input id="ncc-stock-cost" type="checkbox" ${settings.includeStockCost ? "checked" : ""}><span><b>Include sold stock cost in daily Profit.</b><br>Daily Profit subtracts sold stock cost, ads, and wages when all required data is available.</span></label><label><span class="ncc-label">Automatic foreground refresh</span><div class="ncc-inline" style="margin-top:6px"><input id="ncc-refresh-minutes" class="ncc-input" type="number" min="2" max="120" value="${clamp(asNumber(settings.autoRefreshMinutes, 10), 2, 120)}" style="width:85px"><span class="ncc-help">minutes while the page is active</span></div></label></div><p class="ncc-note">Role projections use the bundled local calculator. Employee work stats never leave Torn for an efficiency lookup.</p><div class="ncc-inline" style="margin-top:10px"><button class="ncc-button ncc-primary" data-action="save-settings">Save preferences only</button><button class="ncc-button" data-action="reset-layout">Reset panel position</button></div>`)}${dailyAlertSettings}${runtimeStorage}${backupRestore}${section("Local data", `<div class="ncc-inline"><button class="ncc-button" data-action="export-history" ${companyHistory().length ? "" : "disabled"}>Export history CSV</button><button class="ncc-button ncc-danger" data-action="clear-local-data">Clear companion data</button></div><p class="ncc-note">Clearing Companion data deletes local company snapshots, rankings, plans, history, daily-sync records, and saved Director keys. It cannot change Torn data.</p>`)}<p class="ncc-note">Naughty Company Companion ${VERSION} · TornPDA/Tampermonkey compatible.</p>`;
    }

    function renderCompanyAccountModal() {
        return `<div class="ncc-modal-backdrop" data-action="close-modal"><section class="ncc-modal" role="dialog" aria-modal="true" aria-label="Add Director-key company"><header class="ncc-modal-head"><h2>Add company</h2><button class="ncc-icon" data-action="close-modal" title="Cancel">×</button></header><div class="ncc-modal-body"><label><span class="ncc-label">Limited-access Director key</span><input id="ncc-company-director-key" class="ncc-input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste a Limited-access Director key" style="width:100%;margin-top:6px"></label><p class="ncc-note">The key is validated against Company Profile and Employees before the profile is saved. It will never be rendered again after this dialog closes.</p><div class="ncc-inline"><button class="ncc-button ncc-primary" data-action="save-company-account">Validate and add company</button><button class="ncc-button" data-action="close-modal">Cancel</button></div></div></section></div>`;
    }

    async function validateDirectorKey(key) {
        const candidate = String(key || "").trim();
        if (!candidate) throw new Error("Enter a Limited-access Director key.");
        const snapshot = await fetchCompanySnapshot({ id: "", key: candidate, source: "saved" });
        if (!snapshot.data.employeesAvailable || !Array.isArray(snapshot.data.employees)) throw new Error("That key does not provide the required Company Employees data.");
        return snapshot;
    }

    async function addCompanyAccount(key) {
        const snapshot = await validateDirectorKey(key);
        await commitCompanySnapshot(snapshot);
        activateCompanySnapshot(snapshot.id);
        await saveSettings({ activeCompanyId: snapshot.id });
        state.modal = null;
        state.error = "";
        state.status = `${snapshot.account.name} was validated and added.`;
        resetAutoRefresh();
        resetDailyTickAlerts();
        render();
        return snapshot.account;
    }

    async function selectCompany(companyId) {
        const id = normalizeCompanyId(companyId);
        if (!id) return;
        if (!state.cacheByCompany[id] && !accountForCompany(id)) return;
        if (state.cacheByCompany[id]) activateCompanySnapshot(id);
        else { state.data = null; state.cache = null; }
        await saveSettings({ activeCompanyId: id });
        state.status = state.data?.fetchedAt ? `Showing ${state.data.profile?.name || "company"} data from ${timeAgo(state.data.fetchedAt)}.` : "Company selected; refreshing data…";
        resetAutoRefresh();
        render();
        if (!state.cacheByCompany[id]) void refreshCore({ accountId: id, silent: true });
    }

    async function removeCompanyAccount(companyId) {
        const id = normalizeCompanyId(companyId);
        const accounts = companyAccountMap(state.settings);
        if (!accounts[id]) return;
        if (!window.confirm(`Remove the saved Director key for ${accounts[id].name}? Local snapshots remain available.`)) return;
        delete accounts[id];
        const nextId = activeCompanyId() === id ? Object.keys(accounts)[0] || Object.keys(state.cacheByCompany)[0] || "" : activeCompanyId();
        await saveSettings({ companyAccounts: accounts, activeCompanyId: nextId });
        if (nextId && state.cacheByCompany[nextId]) activateCompanySnapshot(nextId);
        else { state.data = null; state.cache = null; }
        state.status = "Saved Director key removed. Local snapshots were retained.";
        resetAutoRefresh();
        render();
    }

    function renderHealthModal() {
        const metrics = rankingMetrics();
        if (!metrics) return "";
        const rows = metrics.neighbors.map((company) => `<tr class="${company.rank === metrics.rank ? "ncc-own-row" : ""}">${stackCell("Rank", formatNumber(company.rank))}${stackCell("Company", `<b>${escapeHtml(company.name || "Unknown")}</b>`)}${stackCell("Rating", `${formatNumber(company.rating)}★`)}${stackCell("Daily income", formatMoney(incomeOf(company, "daily"), true))}${stackCell("Weekly income", formatMoney(incomeOf(company), true))}</tr>`).join("");
        return `<div class="ncc-modal-backdrop" data-action="close-modal"><section class="ncc-modal" role="dialog" aria-modal="true" aria-label="Health score neighbors"><header class="ncc-modal-head"><h2>Health score · income rank</h2><button class="ncc-icon" data-action="close-modal">×</button></header><div class="ncc-modal-body"><div class="ncc-grid ncc-grid-3">${metricCard("Health score", formatPercent(metrics.percentile, 1), "Weekly-income percentile", "ncc-good")}${metricCard("Your rank", `${formatNumber(metrics.rank)} / ${formatNumber(metrics.total)}`, "Same company type")}${metricCard("Weekly income", formatMoney(incomeOf(state.data?.profile)), "Current Torn value")}</div><p class="ncc-note">Health score is not a Torn API field or a hidden company-quality formula. It is the companion’s transparent weekly-income percentile: (companies − rank + 1) / companies.</p><div class="ncc-table-wrap ncc-rank-list-wrap"><table class="ncc-table ncc-rank-list"><thead><tr><th>Rank</th><th>Company</th><th>Rating</th><th>Daily income</th><th>Weekly income</th></tr></thead><tbody>${rows}</tbody></table></div></div></section></div>`;
    }

    function sourceTimeMapForCompany(companyId = activeCompanyId()) {
        return isObject(state.settings.sourceTimes?.[normalizeCompanyId(companyId)]) ? state.settings.sourceTimes[normalizeCompanyId(companyId)] : {};
    }

    function tabStatusRow(tab = state.selectedTab) {
        const freshness = tabFreshnessSummary(tab, sourceTimeMapForCompany());
        const exact = freshness.updatedAt === null ? "No source time" : new Date(freshness.updatedAt).toISOString().replace(".000Z", "Z");
        const relative = freshness.updatedAt === null ? "—" : timeAgo(freshness.updatedAt);
        return `<div class="ncc-tab-status ncc-${freshness.state.toLowerCase().replace(/\s+/g, "-")}"><b>${escapeHtml(freshness.state)}</b><span>${escapeHtml(exact)}</span><span>${escapeHtml(relative)}</span><span>${escapeHtml(freshness.source)}</span></div>`;
    }

    function refreshCompanySelector() {
        const select = document.getElementById("ncc-company-selector");
        if (!select) return;
        const options = selectableCompanyOptions(companyAccountMap(state.settings), activeCompanyId(), state.data?.profile);
        select.innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === activeCompanyId() ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
        select.onchange = () => {
            if (select.value === "__add__") {
                state.modal = "company-account";
                render();
                return;
            }
            void selectCompany(select.value);
        };
    }

    function renderMain() {
        const status = tabStatusRow();
        if (!state.data?.profile && state.selectedTab === "settings") return `${status}${renderSettings()}`;
        if (!state.data?.profile) {
            const activeAccount = accountForCompany(activeCompanyId());
            const message = activeAccount
                ? activeAccount.source === "pda" ? "Refreshing the current company from TornPDA’s injected key…" : "Refreshing this saved company from its Director key…"
                : "Add a Limited-access Director key in Settings to load your company profile, team, stock, income, and rankings.";
            return `${status}${dataNotice()}<div class="ncc-empty"><div><p>${escapeHtml(message)}</p><button class="ncc-button ncc-primary" data-tab="settings">Open settings</button></div></div>`;
        }
        let body;
        switch (state.selectedTab) {
            case "team": body = renderTeam(); break;
            case "planner": body = renderPlanner(); break;
            case "rankings": body = renderRankings(); break;
            case "stock": body = renderStock(); break;
            case "trends": body = renderTrends(); break;
            case "settings": body = renderSettings(); break;
            default: body = renderOverview(); break;
        }
        return `${status}${body}`;
    }

    function render() {
        mountShell();
        const tabs = [
            ["overview", "Overview"], ["team", "Team"], ["planner", "Planner"], ["rankings", "Rankings"], ["stock", "Stock"], ["trends", "Trends"], ["settings", "Settings"]
        ];
        const tabsEl = document.getElementById("ncc-tabs");
        tabsEl.innerHTML = tabs.map(([id, label]) => `<button class="ncc-tab ${state.selectedTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("");
        const activityStatus = state.loading ? "Refreshing company data…" : state.rankingLoading ? state.status : state.status;
        document.getElementById("ncc-status").textContent = [activityStatus, state.storageWarning].filter(Boolean).join(" ");
        refreshCompanySelector();
        const contentEl = content();
        contentEl.innerHTML = renderMain();
        if (state.modal === "health") contentEl.insertAdjacentHTML("beforeend", renderHealthModal());
        if (state.modal === "position-config") contentEl.insertAdjacentHTML("beforeend", renderPositionConfigModal());
        if (state.modal === "restore-backup") contentEl.insertAdjacentHTML("beforeend", renderBackupRestoreModal());
        if (state.modal === "company-account") contentEl.insertAdjacentHTML("beforeend", renderCompanyAccountModal());
        bindContentEvents();
        applyLayout();
    }

    async function toggleMinimized(minimized) {
        state.layout.minimized = minimized;
        await storeSet(STORE.layout, state.layout, { immediate: true });
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
        state.modal = null;
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
        const stockCost = document.getElementById("ncc-stock-cost");
        const dailyTickToasts = document.getElementById("ncc-daily-tick-toasts");
        const dailyTickNotifications = document.getElementById("ncc-daily-tick-notifications");
        const dailyAlertMode = document.getElementById("ncc-daily-alert-mode");
        const useLegacyGMStorage = document.getElementById("ncc-use-legacy-gm-storage");
        const refreshMinutes = document.getElementById("ncc-refresh-minutes");
        await saveSettings({
            includeStockCost: stockCost ? stockCost.checked : state.settings.includeStockCost,
            dailyTickToasts: dailyTickToasts ? dailyTickToasts.checked : state.settings.dailyTickToasts,
            dailyTickNotifications: dailyTickNotifications ? dailyTickNotifications.checked : state.settings.dailyTickNotifications,
            dailyAlertMode: dailyAlertMode ? dailyAlertMode.value : state.settings.dailyAlertMode,
            useLegacyGMStorage: useLegacyGMStorage ? useLegacyGMStorage.checked : state.settings.useLegacyGMStorage,
            autoRefreshMinutes: refreshMinutes ? clamp(asNumber(refreshMinutes.value, 10), 2, 120) : state.settings.autoRefreshMinutes
        });
        const id = activeCompanyId();
        if (id) {
            state.settings.sourceTimes = { ...state.settings.sourceTimes, [id]: { ...(state.settings.sourceTimes?.[id] || {}), settings: Date.now() } };
            await storeSet(STORE.settings, state.settings);
        }
        resetAutoRefresh();
        resetDailyTickAlerts();
        state.error = "";
        state.status = "Settings saved locally.";
        render();
        void showFeedbackToast("Company settings saved.", "good", 4);
    }

    function currentCompanyBackupStores() {
        return {
            [STORE.settings]: state.settings,
            [STORE.cache]: cacheEnvelope(),
            [STORE.history]: state.history,
            [STORE.rankings]: state.rankings,
            [STORE.rankHistory]: state.rankHistory,
            [STORE.starCohorts]: state.starCohorts,
            [STORE.layout]: state.layout,
            [STORE.dailyAlerts]: state.dailyAlerts,
            [STORE.dailyReminders]: state.dailyReminders,
            [STORE.dailySync]: state.dailySync
        };
    }

    function backupFileName(timestamp = Date.now()) {
        return `naughty-company-backup-${new Date(timestamp).toISOString().replace(/[:.]/g, "-")}.json`;
    }

    function downloadLocalTextFile(text, fileName, type) {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    function utf8Base64(text) {
        if (typeof TextEncoder === "undefined" || typeof btoa !== "function") return "";
        const bytes = new TextEncoder().encode(String(text));
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
    }

    async function shareTextWithTornPDA(text, fileName) {
        let bridge = getFlutterBridge();
        if (!bridge && tornPdaUserAgent(currentUserAgent())) {
            await waitForFlutterReady();
            bridge = getFlutterBridge();
        }
        if (!bridge) return { native: false, shared: false };
        if (!nativeRuntime.flutterReady) markFlutterReady();
        if (!nativeRuntime.isTornPDA && !await confirmTornPDA()) return { native: false, shared: false };
        const base64Data = utf8Base64(text);
        if (!base64Data) return { native: true, shared: false, message: "This runtime could not encode the export." };
        try {
            const response = await bridge.callHandler("shareFile", { base64Data, fileName });
            if (response?.status === "success") return { native: true, shared: true };
            return { native: true, shared: false, message: String(response?.message || "TornPDA could not open its share sheet.") };
        } catch (error) {
            warningLog("export:native share failed", { reason: safeDiagnosticError(error) });
            return { native: true, shared: false, message: "TornPDA could not open its share sheet." };
        }
    }

    async function exportTextFile(text, fileName, type) {
        const native = await shareTextWithTornPDA(text, fileName);
        if (native.shared) return { transport: "share" };
        if (native.native) return { transport: "failed", message: native.message };
        downloadLocalTextFile(text, fileName, type);
        return { transport: "download" };
    }

    async function shareCsvWithTornPDA(csv, fileName) {
        return (await shareTextWithTornPDA(csv, fileName)).shared;
    }

    async function downloadCompanyBackup() {
        if (state.exportInFlight) return false;
        const includeKeys = document.getElementById("ncc-backup-include-keys")?.checked === true;
        state.exportInFlight = true;
        render();
        try {
            const backup = createCompanyBackupDocument(currentCompanyBackupStores(), { includeApiKeys: includeKeys });
            const result = await exportTextFile(JSON.stringify(backup, null, 2), backupFileName(), "application/json;charset=utf-8");
            if (result.transport === "failed") {
                state.error = result.message || "TornPDA could not open the native share sheet. No backup was exported.";
                state.status = "Company backup was not exported.";
                render();
                void showFeedbackToast(state.error, "bad", 6);
                return false;
            }
            const detail = includeKeys ? "with opted-in API keys." : "without API keys.";
            state.status = result.transport === "share" ? "Company backup opened in the TornPDA share sheet " + detail : "Local Company backup downloaded " + detail;
            render();
            void showFeedbackToast(state.status, "good", 6);
            return true;
        } finally {
            state.exportInFlight = false;
            render();
        }
    }

    function readBackupFileText(file) {
        if (typeof file?.text === "function") return file.text();
        return new Promise((resolve, reject) => {
            if (typeof FileReader === "undefined") {
                reject(new Error("This runtime cannot read local backup files."));
                return;
            }
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("Unable to read the selected backup file."));
            reader.readAsText(file);
        });
    }

    async function stageCompanyBackupRestore(file) {
        if (!file) return;
        if (asNumber(file.size) > BACKUP_MAX_BYTES) {
            state.error = `Backup files must be ${formatNumber(BACKUP_MAX_BYTES / (1024 * 1024))} MB or smaller.`;
            render();
            return;
        }
        try {
            const raw = JSON.parse(await readBackupFileText(file));
            const backup = validateCompanyBackupDocument(raw);
            state.pendingRestore = { backup, fileName: String(file.name || "backup.json").slice(0, 160) };
            state.modal = "restore-backup";
            state.error = "";
            state.status = "Backup validated. Review and confirm the restore.";
            render();
        } catch (error) {
            state.pendingRestore = null;
            state.error = error?.message || "Unable to read this backup file.";
            state.status = "Backup was not restored.";
            render();
            void showFeedbackToast("Company backup could not be validated.", "bad", 6);
        }
    }

    function applyRestoredCompanyState(stores) {
        const migrated = migrateLegacyCompanyStores(stores);
        state.settings = migrated.settings;
        state.layout = { ...DEFAULT_LAYOUT, ...(isObject(stores[STORE.layout]) ? stores[STORE.layout] : {}) };
        state.cacheByCompany = migrated.cacheByCompany;
        state.cache = null;
        state.history = normalizeHistory(stores[STORE.history]);
        state.rankings = isObject(stores[STORE.rankings]) ? stores[STORE.rankings] : {};
        state.rankHistory = isObject(stores[STORE.rankHistory]) ? stores[STORE.rankHistory] : {};
        state.starCohorts = isObject(stores[STORE.starCohorts]) ? stores[STORE.starCohorts] : {};
        state.dailyAlerts = isObject(stores[STORE.dailyAlerts]) ? stores[STORE.dailyAlerts] : {};
        state.dailyReminders = isObject(stores[STORE.dailyReminders]) ? stores[STORE.dailyReminders] : {};
        state.dailySync = isObject(stores[STORE.dailySync]) ? stores[STORE.dailySync] : {};
        state.selectedTab = state.settings.activeTab || "overview";
        const id = state.settings.activeCompanyId || Object.keys(state.cacheByCompany)[0] || "";
        if (id) activateCompanySnapshot(id);
        else state.data = null;
    }

    async function restoreCompanyBackup(backup, { restoreApiKeys = false } = {}) {
        const stores = materializeCompanyBackupStores(backup, { currentSettings: state.settings, restoreApiKeys });
        await flushStorageWrites();
        await storeSetMany(stores, { immediate: true });
        applyRestoredCompanyState(stores);
        state.pendingRestore = null;
        state.modal = null;
        state.error = "";
        state.status = restoreApiKeys && backup.includesApiKeys
            ? "Local Company backup restored, including opted-in API keys."
            : "Local Company backup restored; existing API keys were preserved.";
        resetAutoRefresh();
        resetDailyTickAlerts();
        render();
        void showFeedbackToast(restoreApiKeys && backup.includesApiKeys ? "Company backup restored with opted-in API keys." : "Company backup restored.", "good", 6);
    }

    async function confirmCompanyBackupRestore() {
        const pending = state.pendingRestore;
        if (!pending?.backup) return;
        const confirmed = document.getElementById("ncc-confirm-backup-restore")?.checked === true;
        if (!confirmed) {
            state.error = "Confirm that the restore will replace current local Company data before continuing.";
            render();
            return;
        }
        const restoreApiKeys = pending.backup.includesApiKeys && document.getElementById("ncc-restore-backup-keys")?.checked === true;
        if (!window.confirm("Replace this companion’s local Company data with the validated backup? Existing local snapshots, plans, rankings, and history will be replaced.")) return;
        try {
            await restoreCompanyBackup(pending.backup, { restoreApiKeys });
        } catch (error) {
            state.error = error?.message || "Unable to restore this backup.";
            state.status = "Backup restore failed.";
            render();
            void showFeedbackToast("Company backup restore failed.", "bad", 6);
        }
    }

    async function exportHistory() {
        if (state.exportInFlight) return false;
        const profile = state.data?.profile;
        const rows = companyHistory(profile?.id);
        if (!rows.length) return;
        state.exportInFlight = true;
        render();
        try {
            const headers = ["reporting_day_utc", "daily_income", "daily_net_profit", "weekly_income", "weekly_net_profit", "funds", "rating"];
            const esc = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
            const csv = [headers.join(","), ...rows.map((row) => [new Date(row.period).toISOString(), row.dailyIncome, row.dailyProfit, row.weeklyIncome, row.weeklyProfit, row.funds, row.rating].map(esc).join(","))].join("\n");
            const fileName = `naughty-company-history-${profile?.id || "export"}.csv`;
            const result = await exportTextFile(csv, fileName, "text/csv;charset=utf-8");
            if (result.transport === "failed") {
                state.error = result.message || "TornPDA could not open the native share sheet. No CSV was exported.";
                state.status = "History CSV was not exported.";
                render();
                void showFeedbackToast(state.error, "bad", 6);
                return false;
            }
            state.status = result.transport === "share" ? "History CSV opened in the TornPDA share sheet." : "Local history CSV exported.";
            render();
            return true;
        } finally {
            state.exportInFlight = false;
            render();
        }
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
        if (!window.confirm("Clear all Naughty Company Companion local data, including saved Director keys, history, ranking cache, plans, and daily sync state?")) return;
        if (nativeRuntime.isTornPDA || await confirmTornPDA()) await cancelDailyTickReminder("sync");
        await Promise.all(Object.values(STORE).map((key) => storeDelete(key)));
        await removeLegacyProjectionStore();
        state.settings = { ...DEFAULT_SETTINGS };
        state.layout = { ...DEFAULT_LAYOUT };
        state.data = null;
        state.cache = null;
        state.cacheByCompany = {};
        state.history = {};
        state.rankings = {};
        state.rankHistory = {};
        state.starCohorts = {};
        state.dailyAlerts = {};
        state.dailyReminders = {};
        state.dailySync = {};
        state.selectedTab = "overview";
        state.error = "";
        state.status = "All companion data was cleared from local userscript storage.";
        resetAutoRefresh();
        render();
    }

    function resetPanelLayout() {
        state.layout = { ...DEFAULT_LAYOUT };
        void storeSet(STORE.layout, state.layout, { immediate: true });
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
        const backupFileInput = document.getElementById("ncc-company-backup-file");
        if (backupFileInput) backupFileInput.onchange = () => {
            const file = backupFileInput.files?.[0];
            backupFileInput.value = "";
            if (file) void stageCompanyBackupRestore(file);
        };
        root.querySelectorAll("[data-action]").forEach((element) => {
            element.onclick = async (event) => {
                const action = element.getAttribute("data-action");
                if (action === "close-modal" && element.classList.contains("ncc-modal-backdrop") && event.target !== element) return;
                switch (action) {
                    case "refresh": await refreshCore(); break;
                    case "minimize": await toggleMinimized(true); break;
                    case "load-rankings": await loadRankings({ force: true }); break;
                    case "recalculate-local-roles": await recalculateLocalRoles(); break;
                    case "open-company-account": state.modal = "company-account"; render(); break;
                    case "save-company-account":
                        try { await addCompanyAccount(document.getElementById("ncc-company-director-key")?.value); }
                        catch (error) { state.error = error?.message || "Unable to validate this Director key."; state.status = "Company was not added."; render(); }
                        break;
                    case "select-company": await selectCompany(element.getAttribute("data-company-id")); break;
                    case "remove-company": await removeCompanyAccount(element.getAttribute("data-company-id")); break;
                    case "refresh-all-companies": await runDailySync({ force: true, deliverAlerts: false }); break;
                    case "show-health": state.modal = "health"; render(); break;
                    case "open-position-config": state.modal = "position-config"; render(); break;
                    case "select-trend": state.selectedTrendPeriod = asNumber(element.getAttribute("data-period")); render(); break;
                    case "close-modal": state.modal = null; state.pendingRestore = null; render(); break;
                    case "save-planner": await savePlannerSettings(); break;
                    case "priority-up": await movePlannerPriority(element.getAttribute("data-position"), -1); break;
                    case "priority-down": await movePlannerPriority(element.getAttribute("data-position"), 1); break;
                    case "auto-assign": await autoAssign(); break;
                    case "save-settings": await saveSettingsFromForm(); break;
                    case "verify-refresh": await saveSettingsFromForm(); await refreshCore(); break;
                    case "download-company-backup": await downloadCompanyBackup(); break;
                    case "choose-company-backup": document.getElementById("ncc-company-backup-file")?.click(); break;
                    case "confirm-backup-restore": await confirmCompanyBackupRestore(); break;
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
            if (!canStartHeaderDrag(event.target, event.button)) return;
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
        window.addEventListener("resize", handleRuntimeViewportChange);
        window.visualViewport?.addEventListener("resize", handleRuntimeViewportChange);
    }

    function resetAutoRefresh() {
        if (state.autoRefreshId) clearInterval(state.autoRefreshId);
        state.autoRefreshId = null;
        if (!hasTornApiKey() || documentIsHidden()) return;
        const minutes = clamp(asNumber(state.settings.autoRefreshMinutes, 10), 2, 120);
        state.autoRefreshId = setInterval(() => { void refreshCore({ silent: true, scheduled: true }); }, minutes * 60 * 1000);
    }

    async function boot() {
        await loadPersistedState();
        mountShell();
        const activeAccount = accountForCompany();
        debugLog("startup:ready", {
            version: VERSION,
            runtimeMode: currentRuntimeMode(),
            confirmedTornPDA: nativeRuntime.isTornPDA,
            storageMode: storage.mode,
            tornKeyConfigured: hasTornApiKey(),
            tornKeySource: activeAccount?.source === "pda" ? "TornPDA injected" : accountKey(activeAccount) ? "saved Director profile" : injectedTornApiKey() ? "TornPDA injected" : "none"
        });
        if (state.data?.fetchedAt) state.status = `Showing cached data from ${timeAgo(state.data.fetchedAt)}.`;
        else state.status = hasTornApiKey() ? "Ready to refresh company data." : "Add a Limited-access Director key to begin.";
        resetAutoRefresh();
        resetDailyTickAlerts();
        resetDailyRankingRefresh();
        render();
        if (hasTornApiKey()) void refreshCore({ silent: true, scheduled: true });
        window.addEventListener("keydown", (event) => {
            if (event.altKey && event.key.toLowerCase() === "c") {
                event.preventDefault();
                toggleMinimized(!state.layout.minimized);
            }
            if (event.key === "Escape" && state.modal) {
                state.modal = null;
                state.pendingRestore = null;
                render();
            }
        });
        window.addEventListener("beforeunload", () => { void persistLayout(); void flushStorageWrites(); });
        document.addEventListener("visibilitychange", () => {
            if (documentIsHidden()) {
                resetAutoRefresh();
                resetDailyTickAlerts();
                resetDailyRankingRefresh();
                return;
            }
            debugLog("refresh:resumed", { source: "visibility restore" });
            resetAutoRefresh();
            resetDailyTickAlerts();
            resetDailyRankingRefresh();
        });
    }

    const testApi = {
        reportingPeriod, weekKey, countStars, calculateRankingMetrics, companyRankSummary, financials,
        roleStatEfficiency, calculateLocalRoleEfficiencies, localRoleTotalEfficiency, applicationStatusSummary,
        companyAccountMap, selectableCompanyOptions, normalizeCacheByCompany, cacheEnvelope, migrateLegacyCompanyStores,
        dailySyncDay, dailySyncNeedsRun, dailySyncPlan, historySnapshotDay, mergeHistorySnapshot, normalizeHistory, alertTargetsForMode, sourceFreshness, tabFreshnessSummary,
        layoutProfile, runtimeKind, runtimeMode, launcherTapActivates, canStartHeaderDrag,
        assignProjectedRows, stockDifference, previousStockSnapshot,
        totalStockDifference, dailyTickStockDifference, currentStockWorth, preferredCurrentEfficiency,
        formatAverageEffectiveness, sortRows, orderedPriorityPositions, trendNumber,
        trendChartAvailability, trendPointTooltip, trendPerformance, isCompactViewport,
        isCompactLayout, shouldUseCompactLayout, boundedPanelLayout, boundedLauncherLayout, isVirtualKeyboardViewportChange,
        utcDayKey, dailyAlertPhaseTime, isDailyAlertDue, rankingRefreshDay,
        isDailyRankingRefreshDue, rankingRefreshedForDailyTick, buildDailyTickAlert,
        employeeEffectivenessRisks, buildEmployeeRiskAlert, nextDailyAlertTimestamp,
        dailyAlertKindAt, dailyAlertKindsAt, nextDailyReminderTimestamp, buildDailyTickReminder,
        dailyAlertDeliveryChannels, dailyTickAlertsEnabled, safeRequestDescriptor, safeDiagnosticError,
        createStorageAdapter, createCompanyBackupDocument, validateCompanyBackupDocument,
        materializeCompanyBackupStores, utf8Base64
    };
    if (typeof module !== "undefined" && module.exports) module.exports = testApi;
    if (typeof window !== "undefined") initializeNativeRuntime();
    if (typeof document !== "undefined" && typeof window !== "undefined") {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { void boot(); }, { once: true });
        else void boot();
    }
})();
