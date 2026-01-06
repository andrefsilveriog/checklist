/* Couple Checklist - Firebase sync + local fallback (no passwords) */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { initializeFirestore, doc, getDoc, getDocFromServer, setDoc, onSnapshot, runTransaction } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

(() => {
  // ---------- room / viewer / theme ----------
  const makeId = (len = 16) => {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  };

  const url = new URL(window.location.href);
  // In installed PWAs (Android/iOS home screen), the app often launches using manifest.start_url
  // (without query params). To avoid creating a new room every launch, we persist the last room id.
  const LAST_ROOM_KEY = "coupleChecklist_lastRoomId";
  let ROOM_ID = url.searchParams.get("room") || localStorage.getItem(LAST_ROOM_KEY);
  if (!ROOM_ID) ROOM_ID = makeId(12);
  localStorage.setItem(LAST_ROOM_KEY, ROOM_ID);
  if (url.searchParams.get("room") !== ROOM_ID) {
    url.searchParams.set("room", ROOM_ID);
    history.replaceState({}, "", url);
  }
  const VIEWER_KEY  = `coupleChecklist_viewer_${ROOM_ID}`;
  const THEME_KEY   = `coupleChecklist_theme_${ROOM_ID}`;
  const CLIENT_ID_KEY = "coupleChecklist_clientId";
  const CLIENT_ID = localStorage.getItem(CLIENT_ID_KEY) || (() => { const v = makeId(20); localStorage.setItem(CLIENT_ID_KEY, v); return v; })();

  // Firebase (same room shared by both phones)
  const firebaseConfig = {
    apiKey: "AIzaSyBIEUVrlFCjJHv-9psfYTCnddmeNP77oM8",
    authDomain: "couple-s-checklist.firebaseapp.com",
    projectId: "couple-s-checklist",
    storageBucket: "couple-s-checklist.firebasestorage.app",
    messagingSenderId: "152078510212",
    appId: "1:152078510212:web:927746bceaf6591f10fad1",
    measurementId: "G-LSYZ2K48JG"
  };

  // IMPORTANT:
  // We version the cloud *document id* (but keep the same collection) to avoid older cached
  // clients overwriting the room with a different schema (a common cause of "it reverts after reload").
  // Using the same collection avoids requiring any Firebase rules changes.
  const CLOUD_COLLECTION = 'rooms';
  const CLOUD_DOC_ID = `v6_${ROOM_ID}`;

  const cloud = {
    enabled: false,
    roomRef: null,
    db: null,

    // Canonical server revision we've applied
    lastRev: 0,

    // Realtime health / fallback pulls
    lastSnapshotAt: 0,
    watchdogTimer: null,

    // If remote updates arrive while we have unsent local edits
    remoteWhileDirty: null,
    warnedRemoteWhileDirty: false
  };

  const el = (id) => document.getElementById(id);

  const ui = {
    datePicker: el("datePicker"),
    dateTitle: el("dateTitle"),
    nowClock: el("nowClock"),
    addBtn: el("addBtn"),
    sendBtn: el("sendBtn"),
    userBtn: el("userBtn"),
    themeToggle: el("themeToggle"),
    listAndre: el("list-andre"),
    listJessica: el("list-jessica"),

    addOverlay: el("addModalOverlay"),
    addModalTitle: el("addModalTitle"),
    saveTaskBtn: el("saveTaskBtn"),
    closeAddModal: el("closeAddModal"),
    cancelAdd: el("cancelAdd"),
    addForm: el("addForm"),
    taskTitle: el("taskTitle"),
    taskTime: el("taskTime"),
    taskFreq: el("taskFreq"),
    weekdayField: el("weekdayField"),
    taskWeekday: el("taskWeekday"),
    taskOwner: el("taskOwner"),
    taskVisibility: el("taskVisibility"),
    startDateHelp: el("startDateHelp"),

    scopeOverlay: el("scopeModalOverlay"),
    scopeDayBtn: el("scopeDayBtn"),
    scopeAlwaysBtn: el("scopeAlwaysBtn"),
    closeScopeModal: el("closeScopeModal"),
    scopeModalDesc: el("scopeModalDesc"),

    deleteOverlay: el("deleteModalOverlay"),
    deleteTodayBtn: el("deleteTodayBtn"),
    deleteForeverBtn: el("deleteForeverBtn"),
    closeDeleteModal: el("closeDeleteModal"),
    whoOverlay: el("whoOverlay"),
    whoAndre: el("whoAndre"),
    whoJessica: el("whoJessica"),
    whoBoth: el("whoBoth"),
    closeWho: el("closeWho"),
    copyRoomLink: el("copyRoomLink"),
    installBtn: el("installBtn"),

    installHelpOverlay: el("installHelpOverlay"),
    closeInstallHelp: el("closeInstallHelp"),
    installHelpOk: el("installHelpOk"),

    toast: el("toast")
  };

  // ---------- viewer / theme / install ----------
  let currentViewer = localStorage.getItem(VIEWER_KEY) || "";

  const openWhoOverlay = () => {
    ui.whoOverlay.classList.remove("hidden");
    ui.whoOverlay.setAttribute("aria-hidden", "false");
  };
  const closeWhoOverlay = () => {
    ui.whoOverlay.classList.add("hidden");
    ui.whoOverlay.setAttribute("aria-hidden", "true");
  };

  const setViewer = (v) => {
    currentViewer = v;
    localStorage.setItem(VIEWER_KEY, v);
    closeWhoOverlay();
    render();
  };

  // Theme toggle (manual overrides prefers-color-scheme)
  const applyTheme = (theme) => {
    document.body.classList.remove("theme-light", "theme-dark");
    if (theme === "light") document.body.classList.add("theme-light");
    else if (theme === "dark") document.body.classList.add("theme-dark");
  };
  let currentTheme = localStorage.getItem(THEME_KEY) || "";
  if (currentTheme) applyTheme(currentTheme);

  ui.themeToggle.addEventListener("click", () => {
    if (!currentTheme){
      // if following system, infer current look from media query
      currentTheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    currentTheme = (currentTheme === "light") ? "dark" : "light";
    localStorage.setItem(THEME_KEY, currentTheme);
    applyTheme(currentTheme);
  });

  ui.userBtn.addEventListener("click", () => openWhoOverlay());
  ui.closeWho.addEventListener("click", () => closeWhoOverlay());
  ui.whoAndre.addEventListener("click", () => setViewer("andre"));
  ui.whoJessica.addEventListener("click", () => setViewer("jessica"));
  ui.whoBoth.addEventListener("click", () => setViewer("both"));

  ui.copyRoomLink.addEventListener("click", async () => {
    try{
      await navigator.clipboard.writeText(window.location.href);
      showToast("Room link copied");
    } catch{
      showToast("Couldn’t copy — copy the URL manually");
    }
  });

  // Add-to-home-screen
  let deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const openInstallHelp = () => {
    ui.installHelpOverlay.classList.remove("hidden");
    ui.installHelpOverlay.setAttribute("aria-hidden", "false");
  };
  const closeInstallHelp = () => {
    ui.installHelpOverlay.classList.add("hidden");
    ui.installHelpOverlay.setAttribute("aria-hidden", "true");
  };
  ui.closeInstallHelp.addEventListener("click", closeInstallHelp);
  ui.installHelpOk.addEventListener("click", closeInstallHelp);

  ui.installBtn.addEventListener("click", async () => {
    if (deferredInstallPrompt){
      deferredInstallPrompt.prompt();
      try{ await deferredInstallPrompt.userChoice; } catch{}
      deferredInstallPrompt = null;
      showToast("If accepted, it will appear on your home screen");
      return;
    }
    if (isIOS()) return openInstallHelp();
    showToast("Use your browser menu → Install / Add to Home Screen");
  });

  // ---------- utils ----------
  const pad2 = (n) => String(n).padStart(2, "0");

  const toISODate = (d) => {
    const yr = d.getFullYear();
    const mo = pad2(d.getMonth() + 1);
    const da = pad2(d.getDate());
    return `${yr}-${mo}-${da}`;
  };

  const parseISODate = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  };

  const addDays = (date, days) => {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  };

  const formatHeaderDate = (iso) => {
    const d = parseISODate(iso);
    const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(d);
    const date = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
    const cap = weekday ? (weekday.charAt(0).toUpperCase() + weekday.slice(1)) : "";
    return `${cap} • ${date}`;
  };

  const formatNowTime = (d) => {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(d);
  };

  const weekdayName = (idx) => {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return names[idx] ?? "";
  };

  const fullWeekdayName = (idx) => {
    const names = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    return names[idx] ?? "";
  };

  const safeUUID = () => {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return "t_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  };

  const showToast = (msg) => {
    ui.toast.textContent = msg;
    ui.toast.classList.add("show");
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => ui.toast.classList.remove("show"), 1800);
  };

  // ---------- storage ----------
  const defaultState = () => ({
    version: 2,
    series: {}, // {id: TaskSeries}
    perDate: {} // {isoDate: { completed: {}, status: {}, overrides: {}, order: {andre:[], jessica:[]} } }
  });

  const normalizeLoadedState = (parsed) => {
    if (!parsed || typeof parsed !== "object") return defaultState();
    parsed.series = parsed.series || {};
    parsed.perDate = parsed.perDate || {};

    // Backward-compat: older saves didn't have visibility. Default to public.
    for (const t of Object.values(parsed.series)) {
      if (!t || typeof t !== "object") continue;
      if (!t.visibility) t.visibility = "public";
      if (!t.createdAt) t.createdAt = Date.now();
    }

    for (const [iso, day] of Object.entries(parsed.perDate)) {
      if (!day || typeof day !== "object") {
        parsed.perDate[iso] = { completed: {}, status: {}, overrides: {}, order: { andre: [], jessica: [] } };
        continue;
      }
      day.completed ||= {};
      day.overrides ||= {};
      day.status ||= {};

      // Migration: older saves stored completion as booleans in day.completed.
      // New format stores per-instance status objects in day.status.
      if (day.completed && Object.keys(day.completed).length > 0 && Object.keys(day.status).length === 0) {
        for (const [k, v] of Object.entries(day.completed)) {
          if (v) day.status[k] = { status: "done", doneAt: null, doneBy: null, updatedAt: null, updatedBy: null };
        }
      }

      // Normalize status records
      for (const [k, rec] of Object.entries(day.status)) {
        if (rec === true) {
          day.status[k] = { status: "done", doneAt: null, doneBy: null, updatedAt: null, updatedBy: null };
          continue;
        }
        if (typeof rec === "string") {
          day.status[k] = { status: rec, doneAt: null, doneBy: null, updatedAt: null, updatedBy: null };
          continue;
        }
        if (!rec || typeof rec !== "object") {
          delete day.status[k];
          continue;
        }
        rec.status ||= "done";
        if (!("doneAt" in rec)) rec.doneAt = null;
        if (!("doneBy" in rec)) rec.doneBy = null;
        if (!("updatedAt" in rec)) rec.updatedAt = null;
        if (!("updatedBy" in rec)) rec.updatedBy = null;
      }

      day.order ||= { andre: [], jessica: [] };
      day.order.andre ||= [];
      day.order.jessica ||= [];
    }

    return parsed;
  };

  // Helper: ensure day state on an arbitrary state object (kept for compatibility with existing callers)
  const ensureDayStateOn = (st, isoDate) => {
    st.perDate ||= {};
    if (!st.perDate[isoDate]) {
      st.perDate[isoDate] = {
        completed: {},
        status: {},
        overrides: {},
        order: { andre: [], jessica: [] }
      };
    } else {
      st.perDate[isoDate].completed ||= {};
      st.perDate[isoDate].status ||= {};
      st.perDate[isoDate].overrides ||= {};
      st.perDate[isoDate].order ||= { andre: [], jessica: [] };
      st.perDate[isoDate].order.andre ||= [];
      st.perDate[isoDate].order.jessica ||= [];
    }
    return st.perDate[isoDate];
  };

  const ensureDayState = (isoDate) => {
    if (!state.perDate[isoDate]) {
      state.perDate[isoDate] = {
        completed: {}, // instanceKey->true (legacy)
        status: {}, // instanceKey->{status, doneAt, doneBy, updatedAt, updatedBy}
        overrides: {}, // instanceKey->{ owner?, deleted? }
        order: { andre: [], jessica: [] }
      };
    } else {
      state.perDate[isoDate].completed ||= {};
      state.perDate[isoDate].status ||= {};
      state.perDate[isoDate].overrides ||= {};
      state.perDate[isoDate].order ||= { andre: [], jessica: [] };
      state.perDate[isoDate].order.andre ||= [];
      state.perDate[isoDate].order.jessica ||= [];
    }
    return state.perDate[isoDate];
  };

  // Read-only day state (does not create/mutate state during render)
  const getDayStateRO = (isoDate) => {
    const ds = state.perDate?.[isoDate];
    const order = ds?.order || { andre: [], jessica: [] };
    return {
      completed: ds?.completed || {},
      status: ds?.status || {},
      overrides: ds?.overrides || {},
      order: {
        andre: order.andre || [],
        jessica: order.jessica || []
      }
    };
  };

  // ---------- recurrence ----------
  const occursOnDate = (task, isoDate) => {
    const day = parseISODate(isoDate);
    const start = parseISODate(task.startDate);

    if (day < start) return false;

    const dayMs = 24 * 60 * 60 * 1000;
    const diffDays = Math.floor((day - start) / dayMs);

    if (task.frequency === "one-time") return isoDate === task.startDate;
    if (task.frequency === "daily") return true;

    const wd = day.getDay();
    if (task.weekday == null) return false;
    if (wd !== task.weekday) return false;

    if (task.frequency === "weekly") return diffDays % 7 === 0;
    if (task.frequency === "biweekly") return diffDays % 14 === 0;

    return false;
  };

  const instanceKey = (taskId, isoDate) => `${taskId}__${isoDate}`;

  const effectiveOwner = (task, dayState, isoDate) => {
    const key = instanceKey(task.id, isoDate);
    const o = dayState.overrides[key];
    if (o && o.owner) return o.owner;
    return task.ownerDefault;
  };

  const isDeletedForDay = (task, dayState, isoDate) => {
    const key = instanceKey(task.id, isoDate);
    return Boolean(dayState.overrides[key]?.deleted);
  };

  const isDoneForDay = (task, dayState, isoDate) => {
    const key = instanceKey(task.id, isoDate);
    const rec = dayState.status?.[key];
    // If a structured status exists, it is authoritative.
    // (Prevents "flip back" when an old completed flag lingers in legacy data.)
    if (rec) return rec.status === "done";
    // Backward-compat
    return Boolean(dayState.completed?.[key]);
  };

  // Cross-date completion lookup (needed for streaks)
  const isDoneAtDate = (taskId, isoDate) => {
    const day = state.perDate?.[isoDate];
    if (!day) return false;
    const key = instanceKey(taskId, isoDate);
    const rec = day.status?.[key];
    if (rec) return rec.status === "done";
    // Backward-compat
    return Boolean(day.completed?.[key]);
  };

  const prevOccurrenceISO = (task, isoDate) => {
    if (task.frequency === "one-time") return null;
    const base = parseISODate(isoDate);

    let prev;
    if (task.frequency === "daily") prev = addDays(base, -1);
    else if (task.frequency === "weekly") prev = addDays(base, -7);
    else if (task.frequency === "biweekly") prev = addDays(base, -14);
    else prev = addDays(base, -1);

    const prevIso = toISODate(prev);
    // Stop if we go before the series start date
    if (prevIso < task.startDate) return null;
    // Sanity: ensure it should occur on that date
    if (!occursOnDate(task, prevIso)) return null;
    return prevIso;
  };

  const getStreak = (task, isoDate) => {
    if (task.frequency === "one-time") return null;
    let streak = 0;
    let cur = isoDate;
    // Count consecutive completed occurrences going backwards
    while (cur){
      if (!isDoneAtDate(task.id, cur)) break;
      streak += 1;
      cur = prevOccurrenceISO(task, cur);
    }
    return streak;
  };

  // ---------- rendering ----------
  // Cloud-canonical state, with explicit "Send" to persist.
  // No local persistence for unsent edits: refresh always reflects the cloud.
  const CLOUD_SCHEMA = 6;

  let state = defaultState();
  let selectedDate = toISODate(new Date());
  let isDirty = false;

  const updateSendButton = () => {
    if (!ui.sendBtn) return;
    ui.sendBtn.disabled = !isDirty;
  };

  const markDirty = () => {
    isDirty = true;
    updateSendButton();
  };

  // Keep signature for minimal changes elsewhere; patchFn is ignored.
  const commitState = (_patchFn) => {
    markDirty();
  };

  const applyServerState = (data) => {
    if (!data || typeof data !== "object") return;

    const schema = Number(data.schema || 0);
    if (schema !== CLOUD_SCHEMA) return;

    const revRaw = Number(data.rev ?? data.updatedAtMs ?? 0);
    const rev = Number.isFinite(revRaw) ? revRaw : 0;
    if (rev <= (cloud.lastRev || 0)) return;

    // Never overwrite local unsent edits.
    if (isDirty) {
      cloud.remoteWhileDirty = { rev, data };
      if (!cloud.warnedRemoteWhileDirty) {
        cloud.warnedRemoteWhileDirty = true;
        showToast("Cloud changed on another device. Your unsent edits are kept.");
      }
      return;
    }

    // If the user is mid-drag, cancel it before re-rendering to prevent weird UI states.
    if (typeof drag !== "undefined" && drag.active) {
      try {
        drag.active = false;
        drag.ghost && drag.ghost.remove();
        drag.ghost = null;
        drag.originLane = null;
        drag.originIndex = null;
        drag.taskId = null;
        drag.mode = null;
      } catch (_e) {}
    }

    state = normalizeLoadedState(data.state);
    cloud.lastRev = rev;
    ensureDayState(selectedDate);
    updateSendButton();
    render();
  };

  const pullFromServer = async (reason = "pull") => {
    if (!cloud.enabled || !cloud.roomRef) return;
    // Avoid pulling while user has unsent edits.
    if (isDirty) return;

    try {
      const snap = await getDocFromServer(cloud.roomRef);
      if (!snap.exists()) return;
      applyServerState(snap.data() || {});
    } catch (_e) {
      // silent; we'll surface issues only when user presses Send
    }
  };

  const startCloudWatchdog = () => {
    if (cloud.watchdogTimer) clearInterval(cloud.watchdogTimer);

    cloud.watchdogTimer = setInterval(() => {
      if (!cloud.enabled) return;
      const last = cloud.lastSnapshotAt || 0;
      if (Date.now() - last > 25000) pullFromServer("watchdog");
    }, 15000);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pullFromServer("visible");
    });
  };

  const initFirebaseSync = async () => {
    try {
      const app = initializeApp(firebaseConfig);
      const auth = getAuth(app);

      // Firestore: long polling improves reliability on some networks/proxies.
      const db = initializeFirestore(app, { experimentalForceLongPolling: true });
      cloud.db = db;

      await signInAnonymously(auth);

      cloud.roomRef = doc(db, CLOUD_COLLECTION, CLOUD_DOC_ID);
      cloud.enabled = true;

      // Initial server fetch (server-only)
      try {
        const snap = await getDocFromServer(cloud.roomRef);
        if (snap.exists()) applyServerState(snap.data() || {});
      } catch (_e) {}

      // Realtime listener
      onSnapshot(
        cloud.roomRef,
        { includeMetadataChanges: true },
        (snap) => {
          // Ignore cache-only snapshots to avoid "revert" behavior after refresh.
          if (snap.metadata?.fromCache) return;
          if (!snap.exists()) return;

          cloud.lastSnapshotAt = Date.now();

          // Ignore our own pending local writes; we already update UI locally.
          if (snap.metadata?.hasPendingWrites) return;

          applyServerState(snap.data() || {});
        },
        (_err) => {
          // silent; Send will surface if cloud is unavailable
        }
      );

      cloud.lastSnapshotAt = Date.now();
      startCloudWatchdog();
    } catch (_e) {
      cloud.enabled = false;
    }
  };

  const sendPendingChanges = async () => {
    if (!isDirty) return;

    if (!cloud.enabled || !cloud.db || !cloud.roomRef) {
      showToast("Cloud not ready (offline?)");
      return;
    }

    ui.sendBtn && (ui.sendBtn.disabled = true);
    const prevText = ui.sendBtn ? ui.sendBtn.textContent : null;
    if (ui.sendBtn) ui.sendBtn.textContent = "Sending...";

    let committedRev = null;

    try {
      // Write the whole state as the canonical snapshot (simple + reliable).
      await runTransaction(cloud.db, async (tx) => {
        const snap = await tx.get(cloud.roomRef);
        const data = snap.exists() ? (snap.data() || {}) : {};
        const schema = Number(data.schema || CLOUD_SCHEMA);

        const currentRevRaw = Number(data.rev ?? data.updatedAtMs ?? 0);
        const currentRev = Number.isFinite(currentRevRaw) ? currentRevRaw : 0;
        const nextRev = currentRev + 1;
        committedRev = nextRev;

        tx.set(
          cloud.roomRef,
          {
            schema: CLOUD_SCHEMA,
            state: state,
            rev: nextRev,
            updatedAtMs: Date.now(),
            updatedBy: CLIENT_ID
          },
          { merge: false }
        );
      });

      isDirty = false;
      cloud.warnedRemoteWhileDirty = false;
      cloud.remoteWhileDirty = null;
      if (committedRev != null) cloud.lastRev = Math.max(cloud.lastRev || 0, committedRev);

      updateSendButton();
      showToast("Sent");

      // Align with canonical server state
      await pullFromServer("postSend");
    } catch (_e) {
      showToast("Send failed (offline?)");
    } finally {
      if (ui.sendBtn) ui.sendBtn.textContent = prevText || "Send";
      updateSendButton();
    }
  };

  const setHeader = () => {
    ui.dateTitle.textContent = formatHeaderDate(selectedDate);
  };

  const tickClock = () => {
    const now = new Date();
    ui.nowClock.textContent = `Now: ${formatNowTime(now)}`;
    // if we're viewing today, update colors live
    if (selectedDate === toISODate(now) && !drag.active) render();
  };

  const normalizeOrder = (keysInLane, storedOrder) => {
    const set = new Set(keysInLane);
    // keep only existing keys in stored order
    const kept = storedOrder.filter(k => set.has(k));
    // append missing keys
    const missing = keysInLane.filter(k => !kept.includes(k));
    return [...kept, ...missing];
  };

  const timeToMinutes = (hhmm) => {
    const [h, m] = String(hhmm || "00:00").split(":").map(Number);
    return (h * 60) + (m || 0);
  };

  const getLaneTasks = (isoDate) => {
    const dayState = getDayStateRO(isoDate);

    const all = Object.values(state.series)
      .filter(t => occursOnDate(t, isoDate))
      .filter(t => !isDeletedForDay(t, dayState, isoDate));

    const tasksByOwner = { andre: [], jessica: [] };

    for (const t of all){
      const owner = effectiveOwner(t, dayState, isoDate);
      const vis = t.visibility || 'public';
      const visible = (currentViewer === 'both') ? (vis === 'public') : (vis === 'public' || currentViewer === owner);
      if (visible) tasksByOwner[owner].push(t);
    }

    const compare = (a, b) => {
      const ad = isDoneForDay(a, dayState, isoDate);
      const bd = isDoneForDay(b, dayState, isoDate);
      if (ad !== bd) return ad ? 1 : -1; // completed tasks to bottom

      const at = timeToMinutes(a.dueTime);
      const bt = timeToMinutes(b.dueTime);
      if (at !== bt) return at - bt;

      const ac = a.createdAt ?? 0;
      const bc = b.createdAt ?? 0;
      if (ac !== bc) return ac - bc;

      return String(a.title).localeCompare(String(b.title));
    };

    tasksByOwner.andre.sort(compare);
    tasksByOwner.jessica.sort(compare);

    return { dayState, tasksByOwner };
  };

  const statusClass = (task, isoDate, done) => {
    if (done) return "isDone";

    const now = new Date();
    const todayIso = toISODate(now);

    // Past dates are "expired"
    if (isoDate < todayIso) return "status-red";
    if (isoDate > todayIso) return ""; // future date: neutral

    // Today: compute minutes to due time
    const [hh, mm] = task.dueTime.split(":").map(Number);
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    const diffMin = Math.floor((due - now) / 60000);

    if (diffMin <= 0) return "status-red";
    if (diffMin <= 30) return "status-orange";
    if (diffMin <= 60) return "status-yellow";
    return "";
  };

  const labelFrequency = (freq) => {
    if (freq === "one-time") return "One-time";
    if (freq === "daily") return "Daily";
    if (freq === "weekly") return "Weekly";
    if (freq === "biweekly") return "Biweekly";
    return freq;
  };

  const makeTaskEl = (task, isoDate, dayState) => {
    const key = instanceKey(task.id, isoDate);
    const done = isDoneForDay(task, dayState, isoDate);

    const wrap = document.createElement("div");
    wrap.className = `task ${statusClass(task, isoDate, done)} ${done ? "isDone" : ""}`;
    wrap.dataset.taskId = task.id;
    wrap.dataset.instanceKey = key;
    wrap.dataset.frequency = task.frequency;
    wrap.dataset.isoDate = isoDate;

    const top = document.createElement("div");
    top.className = "task__top";

    const title = document.createElement("div");
    title.className = "task__title";
    title.textContent = task.title;

    const btns = document.createElement("div");
    btns.className = "task__btns";

    const btnDone = document.createElement("button");
    btnDone.className = "iconBtn";
    btnDone.type = "button";
    // Single-button toggle: click ✓ again to mark as pending.
    btnDone.title = done ? "Mark as pending" : "Mark as done";
    btnDone.textContent = "✓";
    btnDone.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const dsNow = getDayStateRO(isoDate);
      const doneNow = isDoneForDay(task, dsNow, isoDate);
      setDone(task.id, isoDate, !doneNow);
    });

    const btnEdit = document.createElement("button");
    btnEdit.className = "iconBtn";
    btnEdit.type = "button";
    btnEdit.title = "Edit";
    btnEdit.textContent = "✎";
    btnEdit.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openEditModal(task);
    });

    const btnDel = document.createElement("button");
    btnDel.className = "iconBtn";
    btnDel.type = "button";
    btnDel.title = "Delete";
    btnDel.textContent = "🗑";
    btnDel.addEventListener("click", (ev) => {
      ev.stopPropagation();
      requestDelete(task, isoDate);
    });

    btns.append(btnDone, btnEdit, btnDel);
    top.append(title, btns);

    const meta = document.createElement("div");
    meta.className = "task__meta";

    // Streak (recurring tasks only)
    const metaStreak = document.createElement("div");
    const isRecurring = (task.frequency !== "one-time");
    if (!isRecurring){
      metaStreak.className = "metaItem muted";
      metaStreak.textContent = "—";
    } else {
      const streak = getStreak(task, isoDate) || 0;
      metaStreak.className = "metaItem";
      metaStreak.textContent = `🔥 ${streak}`;
      metaStreak.title = `Streak: ${streak}`;
    }

    const metaTime = document.createElement("div");
    metaTime.className = "metaItem";
    metaTime.textContent = task.dueTime;

    const metaFreq = document.createElement("div");
    metaFreq.className = "metaItem";
    metaFreq.textContent = labelFrequency(task.frequency);

    const metaWd = document.createElement("div");
    const hasWd = (task.frequency === "weekly" || task.frequency === "biweekly");
    metaWd.className = `metaItem ${hasWd ? "" : "muted"}`;
    metaWd.textContent = hasWd ? fullWeekdayName(task.weekday) : "—";

    meta.append(metaStreak, metaTime, metaFreq, metaWd);

    wrap.append(top, meta);

    // pointer-based drag
    attachPointerDrag(wrap);

    return wrap;
  };

  const escapeHtml = (s) =>
    String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

  const render = () => {
    setHeader();

    const { dayState, tasksByOwner } = getLaneTasks(selectedDate);

    // clear lists
    ui.listAndre.innerHTML = "";
    ui.listJessica.innerHTML = "";

    const makeList = (owner, container) => {
      const tasks = tasksByOwner[owner] || [];
      if (!tasks.length){
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = "No tasks here.";
        empty.style.padding = "8px 4px";
        container.appendChild(empty);
        return;
      }
      for (const task of tasks){
        const node = makeTaskEl(task, selectedDate, dayState);
        container.appendChild(node);
      }
    };

    makeList("andre", ui.listAndre);
    makeList("jessica", ui.listJessica);

      };

  // ---------- actions ----------
  const setDone = (taskId, isoDate, isDone) => {
    const ts = Date.now();
    const by = (currentViewer === "both") ? "both" : (currentViewer || null);

    const dayState = ensureDayState(isoDate);
    const key = instanceKey(taskId, isoDate);
    dayState.status ||= {};

    if (isDone){
      dayState.status[key] = { status: "done", doneAt: ts, doneBy: by, updatedAt: ts, updatedBy: CLIENT_ID };
      // Backward-compat (older builds)
      dayState.completed[key] = true;
    } else {
      dayState.status[key] = { status: "pending", doneAt: null, doneBy: null, updatedAt: ts, updatedBy: CLIENT_ID };
      delete dayState.completed[key];
    }

    commitState((s) => {
      const ds = ensureDayStateOn(s, isoDate);
      ds.status ||= {};
      const k = instanceKey(taskId, isoDate);
      if (isDone){
        ds.status[k] = { status: "done", doneAt: ts, doneBy: by, updatedAt: ts, updatedBy: CLIENT_ID };
        ds.completed[k] = true;
      } else {
        ds.status[k] = { status: "pending", doneAt: null, doneBy: null, updatedAt: ts, updatedBy: CLIENT_ID };
        delete ds.completed[k];
      }
    });
    render();
  };

  const computeStartDate = (freq, isoDate, weekday) => {
    if (freq === "one-time") return isoDate;
    if (freq === "daily") return isoDate;

    // weekly / biweekly: closest occurrence of weekday at or after isoDate
    const d = parseISODate(isoDate);
    const target = Number(weekday);
    const cur = d.getDay();
    let delta = (target - cur + 7) % 7;
    // "closest": if same weekday, start today; else next occurrence
    const start = addDays(d, delta);
    return toISODate(start);
  };

  const addTask = ({ title, dueTime, frequency, weekday, ownerDefault, visibility }) => {
    const id = safeUUID();
    const startDate = computeStartDate(frequency, selectedDate, weekday);

    const t = {
      id,
      title: title.trim(),
      dueTime,
      frequency,
      weekday: (frequency === "weekly" || frequency === "biweekly") ? Number(weekday) : null,
      startDate,
      ownerDefault,
      visibility: visibility || "public",
      createdAt: Date.now()
    };

    state.series[id] = t;
    const tClone = JSON.parse(JSON.stringify(t));
    commitState((s) => { s.series ||= {}; s.series[id] = tClone; });
    render();
    showToast("Task created");
  };

  const updateTask = ({ taskId, title, dueTime, frequency, weekday, ownerDefault, visibility }) => {
    const t = state.series[taskId];
    if (!t) return;

    const oldFreq = t.frequency;
    const oldWd = (t.weekday == null) ? null : Number(t.weekday);
    const newWd = (frequency === "weekly" || frequency === "biweekly") ? Number(weekday) : null;

    const freqChanged = oldFreq !== frequency;
    const wdChanged = oldWd !== newWd;

    t.title = String(title || "").trim();
    t.dueTime = dueTime;
    t.frequency = frequency;
    t.weekday = newWd;
    t.ownerDefault = ownerDefault;
    t.visibility = visibility || t.visibility || "public";

    if (freqChanged || wdChanged){
      // re-anchor series so recurrence is consistent with the chosen weekday/frequency
      const wdForStart = (newWd == null) ? 0 : newWd;
      t.startDate = computeStartDate(frequency, selectedDate, wdForStart);
    }

    const tClone = JSON.parse(JSON.stringify(t));
    commitState((s) => { s.series ||= {}; s.series[taskId] = tClone; });
    render();
    showToast("Task updated");
  };

  // ---------- modals ----------
  let editingTaskId = null; // series id when editing

  // Visibility/owner interaction in Add/Edit modal
  let lastOwnerSelection = null;

  const applyVisibilityRules = () => {
    const viewer = currentViewer || "both";

    // In kiosk/both mode we only allow public tasks
    const privOpt = ui.taskVisibility?.querySelector?.('option[value="private"]');
    if (privOpt) privOpt.disabled = (viewer === "both");
    if (viewer === "both" && ui.taskVisibility.value === "private") {
      ui.taskVisibility.value = "public";
    }

    const vis = ui.taskVisibility.value;

    if (viewer === "andre" || viewer === "jessica") {
      if (vis === "private") {
        // Remember last public owner so switching back restores it
        if (lastOwnerSelection == null) lastOwnerSelection = ui.taskOwner.value;
        ui.taskOwner.value = viewer;
        ui.taskOwner.disabled = true;
        ui.taskOwner.classList.add("isDisabled");
      } else {
        ui.taskOwner.disabled = false;
        ui.taskOwner.classList.remove("isDisabled");
        // Restore last selection if we have one, otherwise default to the viewer
        if (lastOwnerSelection) ui.taskOwner.value = lastOwnerSelection;
        else ui.taskOwner.value = viewer;
      }
      return;
    }

    // viewer === 'both' (kiosk): can assign owners, but private is disabled
    ui.taskOwner.disabled = false;
    ui.taskOwner.classList.remove("isDisabled");
  };

  const openAddModal = () => {
    editingTaskId = null;
    ui.addModalTitle.textContent = "Add task";
    ui.saveTaskBtn.textContent = "Create";
    ui.addOverlay.classList.remove("hidden");
    ui.addOverlay.setAttribute("aria-hidden", "false");
    ui.taskTitle.focus();

    // defaults
    ui.taskTime.value ||= "18:00";
    ui.taskFreq.value ||= "one-time";
    if (currentViewer === "andre" || currentViewer === "jessica") ui.taskOwner.value = currentViewer;
    ui.taskVisibility.value = ui.taskVisibility.value || "public";
    updateWeekdayField();
    updateStartHelp();
    applyVisibilityRules();
  };

  const closeAddModal = () => {
    editingTaskId = null;
    ui.addModalTitle.textContent = "Add task";
    ui.saveTaskBtn.textContent = "Create";
    ui.addOverlay.classList.add("hidden");
    ui.addOverlay.setAttribute("aria-hidden", "true");
    ui.addForm.reset();
    ui.taskTime.value = "18:00";
    ui.taskFreq.value = "one-time";
    lastOwnerSelection = null;
    updateWeekdayField();
    updateStartHelp();
  };

  function openEditModal(task){
    if (!task) return;
    editingTaskId = task.id;

    ui.addModalTitle.textContent = "Edit task";
    ui.saveTaskBtn.textContent = "Save";

    ui.addOverlay.classList.remove("hidden");
    ui.addOverlay.setAttribute("aria-hidden", "false");

    ui.taskTitle.value = task.title || "";
    ui.taskTime.value = task.dueTime || "18:00";
    ui.taskFreq.value = task.frequency || "one-time";
    ui.taskOwner.value = task.ownerDefault || "andre";
    ui.taskVisibility.value = task.visibility || "public";

    lastOwnerSelection = ui.taskOwner.value;

    // weekday select only applies to weekly/biweekly
    const wd = (task.weekday == null) ? 1 : Number(task.weekday);
    ui.taskWeekday.value = String(wd);

    updateWeekdayField();
    updateStartHelp();
    applyVisibilityRules();
    ui.taskTitle.focus();
  }


  const updateWeekdayField = () => {
    const f = ui.taskFreq.value;
    const show = (f === "weekly" || f === "biweekly");
    ui.weekdayField.style.opacity = show ? "1" : "0.55";
    ui.taskWeekday.disabled = !show;
  };

  const updateStartHelp = () => {
    const f = ui.taskFreq.value;
    const wd = Number(ui.taskWeekday.value);
    const computed = computeStartDate(f, selectedDate, wd);

    if (editingTaskId && state.series[editingTaskId]){
      const cur = state.series[editingTaskId];
      const sameFreq = cur.frequency === f;
      const curWd = (cur.weekday == null) ? null : Number(cur.weekday);
      const newWd = (f === "weekly" || f === "biweekly") ? wd : null;
      const sameWd = curWd === newWd;

      if (sameFreq && sameWd){
        if (f === "one-time"){
          ui.startDateHelp.textContent = `Occurs only on ${formatHeaderDate(cur.startDate)}.`;
        } else if (f === "daily"){
          ui.startDateHelp.textContent = `Repeats daily (series start: ${formatHeaderDate(cur.startDate)}).`;
        } else if (f === "weekly"){
          ui.startDateHelp.textContent = `Repeats weekly on ${fullWeekdayName(wd)} (series start: ${formatHeaderDate(cur.startDate)}).`;
        } else if (f === "biweekly"){
          ui.startDateHelp.textContent = `Repeats every 2 weeks on ${fullWeekdayName(wd)} (series start: ${formatHeaderDate(cur.startDate)}).`;
        } else {
          ui.startDateHelp.textContent = "—";
        }
        return;
      }

      // Frequency/weekday changed while editing
      if (f === "one-time"){
        ui.startDateHelp.textContent = `Will become one-time on ${formatHeaderDate(selectedDate)}.`;
      } else if (f === "daily"){
        ui.startDateHelp.textContent = `Will start on ${formatHeaderDate(computed)} and repeat every day.`;
      } else if (f === "weekly"){
        ui.startDateHelp.textContent = `Will start on ${formatHeaderDate(computed)} and repeat every week (${fullWeekdayName(wd)}).`;
      } else if (f === "biweekly"){
        ui.startDateHelp.textContent = `Will start on ${formatHeaderDate(computed)} and repeat every 2 weeks (${fullWeekdayName(wd)}).`;
      } else {
        ui.startDateHelp.textContent = "—";
      }
      return;
    }

    // Add mode
    if (f === "one-time"){
      ui.startDateHelp.textContent = `Occurs only on ${formatHeaderDate(selectedDate)}.`;
    } else if (f === "daily"){
      ui.startDateHelp.textContent = `Starts on ${formatHeaderDate(computed)} and repeats every day.`;
    } else if (f === "weekly"){
      ui.startDateHelp.textContent = `Starts on ${formatHeaderDate(computed)} and repeats every week (${fullWeekdayName(wd)}).`;
    } else if (f === "biweekly"){
      ui.startDateHelp.textContent = `Starts on ${formatHeaderDate(computed)} and repeats every 2 weeks (${fullWeekdayName(wd)}).`;
    } else {
      ui.startDateHelp.textContent = "—";
    }
  };

  // scope modal: used after dragging recurring task
  let scopeResolve = null;
  const openScopeModal = (task) => {
    ui.scopeModalDesc.textContent =
      `"${task.title}" repeats. Apply this change only to the selected day, or for future repeats too?`;
    ui.scopeOverlay.classList.remove("hidden");
    ui.scopeOverlay.setAttribute("aria-hidden", "false");
    return new Promise((resolve) => { scopeResolve = resolve; });
  };
  const closeScopeModal = (choice = null) => {
    ui.scopeOverlay.classList.add("hidden");
    ui.scopeOverlay.setAttribute("aria-hidden", "true");
    if (scopeResolve) scopeResolve(choice);
    scopeResolve = null;
  };

  // delete modal
  let deleteResolve = null;
  let deleteTaskRef = null;
  let deleteIsoRef = null;

  const openDeleteModal = (task, isoDate) => {
    deleteTaskRef = task;
    deleteIsoRef = isoDate;
    ui.deleteOverlay.classList.remove("hidden");
    ui.deleteOverlay.setAttribute("aria-hidden", "false");
    return new Promise((resolve) => { deleteResolve = resolve; });
  };

  const closeDeleteModal = (choice = null) => {
    ui.deleteOverlay.classList.add("hidden");
    ui.deleteOverlay.setAttribute("aria-hidden", "true");
    if (deleteResolve) deleteResolve(choice);
    deleteResolve = null;
  };

  // ---------- delete behavior ----------
  const requestDelete = async (task, isoDate) => {
    // One-time tasks don't repeat, so delete immediately.
    if (task.frequency === "one-time"){
      deleteForever(task.id);
      return;
    }

    // Any repeating task (daily / weekly / biweekly) => ask "today" vs "forever"
    const choice = await openDeleteModal(task, isoDate);
    if (!choice) return;

    if (choice === "today"){
      const dayState = ensureDayState(isoDate);
      const key = instanceKey(task.id, isoDate);
      dayState.overrides[key] = { ...(dayState.overrides[key] || {}), deleted: true };
      commitState((s) => {
        const ds = ensureDayStateOn(s, isoDate);
        const k = instanceKey(task.id, isoDate);
        ds.overrides[k] = { ...(ds.overrides[k] || {}), deleted: true };
      });
      render();
      showToast("Deleted for this day");
    } else if (choice === "forever"){
      deleteForever(task.id);
    }
  };

  const deleteForever = (taskId) => {
    // remove series + all per-day artifacts remain but won't render anymore
    delete state.series[taskId];
    commitState((s) => { if (s.series) delete s.series[taskId]; });
    render();
    showToast("Deleted forever");
  };

  // ---------- drag & drop (pointer-based, mobile-friendly) ----------
  let drag = {
    active: false,
    pointerId: null,
    sourceList: null,
    sourceOwner: null,
    draggedEl: null,
    taskId: null,
    task: null,
    isoDate: null,
    ghost: null,
    placeholder: null,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
    started: false
  };

  const getListUnderPointer = (clientX, clientY) => {
    const node = document.elementFromPoint(clientX, clientY);
    if (!node) return null;

    // Prefer the list, but also accept dropping on lane headers/empty space
    const list = node.closest?.('.taskList');
    if (list) return list;
    const lane = node.closest?.('.lane');
    if (lane) return lane.querySelector('.taskList');
    return null;
  };

  const getTaskUnderPointer = (clientX, clientY) => {
    const node = document.elementFromPoint(clientX, clientY);
    if (!node) return null;
    const task = node.closest?.(".task");
    if (!task) return null;
    if (task.classList.contains("dragGhost")) return null;
    return task;
  };

  const attachPointerDrag = (taskEl) => {
    taskEl.addEventListener("pointerdown", (ev) => {
      // ignore if clicking buttons
      if (ev.target.closest(".iconBtn")) return;

      // lock to left click / touch / pen
      if (ev.pointerType === "mouse" && ev.button !== 0) return;

      drag.pointerId = ev.pointerId;
      drag.draggedEl = taskEl;
      drag.taskId = taskEl.dataset.taskId;
      drag.task = state.series[drag.taskId];
      drag.isoDate = taskEl.dataset.isoDate;

      const list = taskEl.closest(".taskList");
      drag.sourceList = list;
      drag.sourceOwner = list?.dataset.owner;

      drag.startX = ev.clientX;
      drag.startY = ev.clientY;

      // keep the ghost aligned with where the user grabbed the card
      const rect = taskEl.getBoundingClientRect();
      drag.offsetX = ev.clientX - rect.left;
      drag.offsetY = ev.clientY - rect.top;
      drag.started = false;
      drag.active = true;

      taskEl.setPointerCapture(ev.pointerId);

      // start after short delay (helps prevent accidental drags)
      window.clearTimeout(drag._delay);
      drag._delay = window.setTimeout(() => {
        if (drag.active && !drag.started){
          startDrag(ev.clientX, ev.clientY);
        }
      }, 120);
    });

    taskEl.addEventListener("pointermove", (ev) => {
      if (!drag.active || ev.pointerId !== drag.pointerId) return;

      const dx = Math.abs(ev.clientX - drag.startX);
      const dy = Math.abs(ev.clientY - drag.startY);

      if (!drag.started && (dx > 6 || dy > 6)){
        startDrag(ev.clientX, ev.clientY);
      }

      if (drag.started){
        moveDrag(ev.clientX, ev.clientY);
      }
    });

    taskEl.addEventListener("pointerup", async (ev) => {
      if (!drag.active || ev.pointerId !== drag.pointerId) return;

      window.clearTimeout(drag._delay);

      if (!drag.started){
        // treat as click
        drag.active = false;
        return;
      }

      await endDrag(ev.clientX, ev.clientY);

      drag.active = false;
      drag.pointerId = null;
    });

    taskEl.addEventListener("pointercancel", (ev) => {
      if (!drag.active || ev.pointerId !== drag.pointerId) return;
      cancelDrag();
      drag.active = false;
      drag.pointerId = null;
    });
  };

  const startDrag = (clientX, clientY) => {
    if (!drag.draggedEl) return;
    drag.started = true;

    // Recompute grab offset at the moment the drag actually starts (fixes pointer offset)
    const rect = drag.draggedEl.getBoundingClientRect();
    drag.offsetX = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    drag.offsetY = Math.min(Math.max(clientY - rect.top, 0), rect.height);

    // placeholder
    const ph = document.createElement("div");
    ph.className = "placeholder";
    drag.placeholder = ph;

    drag.draggedEl.parentNode.insertBefore(ph, drag.draggedEl.nextSibling);

    // ghost clone
    const ghost = drag.draggedEl.cloneNode(true);
    ghost.classList.add("dragGhost");

    // Match the original card width so the grab feels 1:1
    const w = Math.min(rect.width, Math.min(window.innerWidth * 0.92, 560));
    ghost.style.width = `${w}px`;

    document.body.appendChild(ghost);
    drag.ghost = ghost;

    drag.draggedEl.style.opacity = "0.35";

    moveDrag(clientX, clientY);
  };

  const moveDrag = (clientX, clientY) => {
    if (!drag.ghost || !drag.placeholder || !drag.draggedEl) return;

    // Keep the ghost positioned under the pointer at the same grab point
    const x = clientX - drag.offsetX;
    const y = clientY - drag.offsetY;
    drag.ghost.style.transform = "none";
    drag.ghost.style.left = `${x}px`;
    drag.ghost.style.top = `${y}px`;

    // highlight lists
    ui.listAndre.classList.remove("isOver");
    ui.listJessica.classList.remove("isOver");

    const list = getListUnderPointer(clientX, clientY) || drag.sourceList;
    if (list){
      list.classList.add("isOver");
      // Locked chronological order: always show placeholder at the end
      list.appendChild(drag.placeholder);
    }
  };

  const endDrag = async (clientX, clientY) => {
    ui.listAndre.classList.remove("isOver");
    ui.listJessica.classList.remove("isOver");

    const task = drag.task;
    const dropList = getListUnderPointer(clientX, clientY) || drag.sourceList;
    if (!dropList || !task){
      cancelDrag();
      return;
    }

    // cleanup visuals
    if (drag.draggedEl) drag.draggedEl.style.opacity = "1";
    if (drag.placeholder){
      drag.placeholder.remove();
      drag.placeholder = null;
    }

    if (drag.ghost){
      drag.ghost.remove();
      drag.ghost = null;
    }

    const toOwner = dropList.dataset.owner;
    const fromOwner = drag.sourceOwner;

    // If owner didn't change, snap back to sorted order
    if (toOwner === fromOwner){
      render();
      return;
    }

    // If recurring, ask scope
    let scope = "day";
    if (task.frequency !== "one-time"){
      const choice = await openScopeModal(task);
      if (!choice){
        render();
        return;
      }
      scope = (choice === "always") ? "always" : "day";
    } else {
      scope = "always";
    }

    applyDragResult({ task, isoDate: drag.isoDate, fromOwner, toOwner, scope });
  };

  const cancelDrag = () => {
    ui.listAndre.classList.remove("isOver");
    ui.listJessica.classList.remove("isOver");

    if (drag.draggedEl) drag.draggedEl.style.opacity = "1";
    if (drag.placeholder){
      drag.placeholder.remove();
      drag.placeholder = null;
    }
    if (drag.ghost){
      drag.ghost.remove();
      drag.ghost = null;
    }
    drag.active = false;
    drag.pointerId = null;
    drag.draggedEl = null;
    drag.taskId = null;
    drag.task = null;
    drag.started = false;
    render();
  };

  const applyDragResult = ({ task, isoDate, fromOwner, toOwner, scope }) => {
    const dayState = ensureDayState(isoDate);

    if (fromOwner === toOwner){
      render();
      return;
    }

    const key = instanceKey(task.id, isoDate);

    if (scope === "day"){
      dayState.overrides[key] = { ...(dayState.overrides[key] || {}), owner: toOwner };
      commitState((s) => {
        const ds = ensureDayStateOn(s, isoDate);
        const k = instanceKey(task.id, isoDate);
        ds.overrides[k] = { ...(ds.overrides[k] || {}), owner: toOwner };
      });
      render();
      showToast("Moved for this day");
      return;
    }

    // scope === "always"
    task.ownerDefault = toOwner;
    if (dayState.overrides[key]?.owner) delete dayState.overrides[key].owner;

    commitState((s) => {
      s.series ||= {};
      if (s.series[task.id]) s.series[task.id].ownerDefault = toOwner;
      const ds = ensureDayStateOn(s, isoDate);
      const k = instanceKey(task.id, isoDate);
      if (ds.overrides[k]?.owner) delete ds.overrides[k].owner;
    });
    render();
    showToast("Moved for future repeats");
  };

  // ---------- wire up ----------
  ui.addBtn.addEventListener("click", openAddModal);
  ui.sendBtn && ui.sendBtn.addEventListener("click", sendPendingChanges);
  ui.closeAddModal.addEventListener("click", closeAddModal);
  ui.cancelAdd.addEventListener("click", closeAddModal);

  ui.taskFreq.addEventListener("change", () => { updateWeekdayField(); updateStartHelp(); });
  ui.taskWeekday.addEventListener("change", updateStartHelp);

  ui.taskOwner.addEventListener("change", () => {
    if (!ui.taskOwner.disabled) lastOwnerSelection = ui.taskOwner.value;
  });
  ui.taskVisibility.addEventListener("change", applyVisibilityRules);

  ui.addForm.addEventListener("submit", (ev) => {
    ev.preventDefault();

    const title = ui.taskTitle.value.trim();
    const dueTime = ui.taskTime.value;
    const frequency = ui.taskFreq.value;
    let ownerDefault = ui.taskOwner.value;
    const visibility = ui.taskVisibility.value;
    if (visibility === "private" && (currentViewer === "andre" || currentViewer === "jessica")) {
      ownerDefault = currentViewer;
    }
    const weekday = ui.taskWeekday.value;

    if (!title){
      ui.taskTitle.focus();
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(dueTime)){
      alert("Please set a due time (24h format).");
      return;
    }

    if (editingTaskId){
      updateTask({ taskId: editingTaskId, title, dueTime, frequency, weekday, ownerDefault, visibility });
    } else {
      addTask({ title, dueTime, frequency, weekday, ownerDefault, visibility });
      
    }
    closeAddModal();
  });

  // scope modal buttons
  ui.scopeDayBtn.addEventListener("click", () => closeScopeModal("day"));
  ui.scopeAlwaysBtn.addEventListener("click", () => closeScopeModal("always"));
  ui.closeScopeModal.addEventListener("click", () => closeScopeModal(null));
  ui.scopeOverlay.addEventListener("click", (e) => {
    if (e.target === ui.scopeOverlay) closeScopeModal(null);
  });

  // delete modal buttons
  ui.deleteTodayBtn.addEventListener("click", () => { closeDeleteModal("today"); });
  ui.deleteForeverBtn.addEventListener("click", () => { closeDeleteModal("forever"); });
  ui.closeDeleteModal.addEventListener("click", () => closeDeleteModal(null));
  ui.deleteOverlay.addEventListener("click", (e) => {
    if (e.target === ui.deleteOverlay) closeDeleteModal(null);
  });

  // date picker
  ui.datePicker.addEventListener("change", () => {
    if (!ui.datePicker.value) return;
    selectedDate = ui.datePicker.value;
    ensureDayState(selectedDate);
    render();
  });

  // close add modal on overlay click
  ui.addOverlay.addEventListener("click", (e) => {
    if (e.target === ui.addOverlay) closeAddModal();
  });

  // Keyboard: Esc closes modals
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!ui.addOverlay.classList.contains("hidden")) closeAddModal();
    if (!ui.scopeOverlay.classList.contains("hidden")) closeScopeModal(null);
    if (!ui.deleteOverlay.classList.contains("hidden")) closeDeleteModal(null);
  });

  // initialize
  const init = () => {
    const today = toISODate(new Date());
    selectedDate = today;
    ui.datePicker.value = today;

    // default time for add form
    ui.taskTime.value = "18:00";
    updateWeekdayField();
    updateStartHelp();

    ensureDayState(today);
    render();
    updateSendButton();

    initFirebaseSync();
    tickClock();
    window.setInterval(tickClock, 1000 * 30); // update each 30s

    // If user has old sortIndex-less tasks, keep stable ordering by createdAt
    // We sort at render time via per-day order, but initial order comes from insertion order.
  };

  init();
  // initial viewer prompt
  if (!currentViewer) openWhoOverlay();

  // register service worker (PWA)
  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }

})();
