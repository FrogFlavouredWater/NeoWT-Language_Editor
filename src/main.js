const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { spawn } = require("child_process");

process.on("uncaughtException", err => console.error("[main] uncaughtException:", err));
process.on("unhandledRejection", err => console.error("[main] unhandledRejection:", err));

const isProd = app.isPackaged;

const isMac = process.platform === "darwin";

const CONFIG_PATH = isProd
? path.join(app.getPath("userData"), "config.json")
: path.resolve(__dirname, "res", "config", "config.json");

const CHANGES_PATH = () => path.join(app.getPath("userData"), "res", "changes.json");
const PROFILES_DIR = () => path.join(app.getPath("userData"), "res", "profiles");

function defaultConfig() {
  return {
    root_path: "",
    size_x: 1200,
    size_y: 800,
    lastFile: "",
    language: "",
    is_using_steam: -1,
  };
}

function isSteamRoot(root) {
  if (!root) return false;
  const p = root.replace(/\\/g, "/").toLowerCase();
  return p.includes("/steamapps/");
}

function ensureConfigFiles() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2));

  const changesPath = CHANGES_PATH();
  fs.mkdirSync(path.dirname(changesPath), { recursive: true });
  if (!fs.existsSync(changesPath)) fs.writeFileSync(changesPath, JSON.stringify({ changes: [] }, null, 2));

  fs.mkdirSync(PROFILES_DIR(), { recursive: true });
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return defaultConfig(); }
}
function writeConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }

function readChanges() {
  try { return JSON.parse(fs.readFileSync(CHANGES_PATH(), "utf8")); }
  catch { return { changes: [] }; }
}
function writeChanges(data) { fs.writeFileSync(CHANGES_PATH(), JSON.stringify(data, null, 2)); }

function detectDelimiter(text) {
  const first = text.split(/\r?\n/)[0] || "";
  const c = (first.match(/,/g) || []).length;
  const s = (first.match(/;/g) || []).length;
  return s > c ? ";" : ",";
}
function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const delimiter = detectDelimiter(raw);
  const rows = parse(raw, { columns: true, skip_empty_lines: true, delimiter });
  const headers = Object.keys(rows[0] || {});
  return { headers, rows, delimiter };
}
function writeCsv(filePath, headers, rows, delimiter) {
  const out = stringify(rows, { header: true, columns: headers, delimiter });
  fs.writeFileSync(filePath, out, "utf8");
}

const stripDiacritics = (s) =>
String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const norm = (s) => stripDiacritics(s).toLowerCase().trim();
const tokenize = (s) => (norm(s).match(/[a-z0-9]+/g) || []);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let v0 = new Array(bl + 1);
  let v1 = new Array(bl + 1);
  for (let i = 0; i <= bl; i++) v0[i] = i;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    [v0, v1] = [v1, v0];
  }
  return v0[bl];
}
function ratio(a, b) {
  const A = norm(a), B = norm(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  if (A === B) return 1;
  const d = levenshtein(A, B);
  return 1 - d / Math.max(A.length, B.length);
}
function tokenSetRatio(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}
function boundaryHit(q, t) {
  if (!q) return false;
  const re = new RegExp(`\\b${escapeRe(norm(q))}\\b`, "i");
  return re.test(norm(t));
}
function substringTightness(q, t) {
  const Q = norm(q), T = norm(t);
  const idx = T.indexOf(Q);
  if (idx === -1) return 0;
  const tight = Q.length / Math.max(T.length, 1);
  const early = 1 - Math.min(idx / Math.max(T.length - 1, 1), 1);
  return 0.5 * tight + 0.5 * early;
}
function strictScore(q, t) {
  const b = boundaryHit(q, t) ? 0.85 + 0.15 * substringTightness(q, t) : 0;
  const sub = substringTightness(q, t) ? 0.6 + 0.4 * substringTightness(q, t) : 0;
  const r = ratio(q, t);
  const ts = tokenSetRatio(q, t);
  return Math.max(b, sub, r, ts);
}
function acceptStrict(q, key, value) {
  const qn = norm(q);
  const qLen = qn.length;
  const keyScore = strictScore(qn, key);
  const valScore = strictScore(qn, value);

  if (qLen <= 3) {
    const exactVal = norm(value) === qn;
    const shortBoundaryVal = value && value.length <= 40 && boundaryHit(qn, value);
    const keyOk = keyScore >= 0.6;
    const valOk = exactVal || shortBoundaryVal;
    return { ok: keyOk || valOk, score: Math.max(keyScore, valOk ? 0.95 : 0) };
  }
  if (qLen <= 6) {
    const thr = 0.72;
    const score = Math.max(keyScore, valScore);
    return { ok: score >= thr, score };
  }
  const thr = 0.62;
  const score = Math.max(keyScore, valScore);
  return { ok: score >= thr, score };
}

function tryAutoLocateRoot() {
  const home = os.homedir();
  const guesses = new Set();

  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] || "C:\\\\Program Files";
    const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\\\Program Files (x86)";
    guesses.add(path.join(pf86, "Steam", "steamapps", "common", "War Thunder"));
    guesses.add(path.join(pf86, "War Thunder"));
    guesses.add(path.join(pf, "War Thunder"));
    guesses.add("C:\\\\Games\\War Thunder");
  } else if (process.platform === "darwin") {
    guesses.add("/Applications/War Thunder.app/Contents/Resources/game");
    guesses.add(path.join(home, "Applications", "War Thunder.app", "Contents", "Resources", "game"));
  } else {
    guesses.add(path.join(home, ".local", "share", "Steam", "steamapps", "common", "War Thunder"));
    guesses.add(path.join(home, ".steam", "steam", "steamapps", "common", "War Thunder"));
    guesses.add(path.join(home, "Games", "WarThunder"));
  }

  for (const g of guesses) {
    try {
      if (fs.existsSync(g) && fs.existsSync(path.join(g, "lang"))) return g;
      const alt = path.join(g, "game");
      if (fs.existsSync(alt) && fs.existsSync(path.join(alt, "lang"))) return alt;
    } catch {}
  }
  return "";
}

let win;
async function createWindow() {
  ensureConfigFiles();
  const cfg = readConfig();

  win = new BrowserWindow({
    width: Math.max(parseInt(cfg.size_x) || 1200, 900),
    height: Math.max(parseInt(cfg.size_y) || 800, 650),
    minWidth: 900,
    minHeight: 650,
    center: true,
    backgroundColor: "#0b0e13",
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    },
  });

  win.webContents.on("did-finish-load", () => console.log("[main] did-finish-load"));

  try {
    await win.loadFile(path.join(__dirname, "index.html"));
  } catch (err) {
    console.error("[main] loadFile failed:", err);
  }

  win.setMenuBarVisibility(false);
  win.on("resize", () => {
    const [w, h] = win.getSize();
    writeConfig({ ...readConfig(), size_x: w, size_y: h });
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => { if (!isMac) app.quit(); });

ipcMain.handle("config:load", () => readConfig());
ipcMain.handle("config:save", (e, patch) => {
  const prev = readConfig();
  let next = { ...prev, ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, "root_path")) {
    const root = patch.root_path || "";
    next.is_using_steam = isSteamRoot(root) ? 1 : 0;
  }
  writeConfig(next);
  return next;
});

ipcMain.handle("util:launchGame", async () => {
  let cfg = readConfig();
  let mode = typeof cfg.is_using_steam === "number" ? cfg.is_using_steam : -1;

  if (mode === -1 && cfg.root_path) {
    mode = isSteamRoot(cfg.root_path) ? 1 : 0;
    cfg = { ...cfg, is_using_steam: mode };
    writeConfig(cfg);
  }

  if (mode === -1) {
    return { ok: false, message: "Set a War Thunder path or choose a launch method in Utilities." };
  }

  try {
    if (mode === 1) {
      const steamUrl = "steam://rungameid/236390";
      if (process.platform === "win32") {
        spawn("cmd.exe", ["/c", "start", "", steamUrl], { detached: true, stdio: "ignore" }).unref();
      } else if (process.platform === "darwin") {
        spawn("open", [steamUrl], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("xdg-open", [steamUrl], { detached: true, stdio: "ignore" }).unref();
      }
      return { ok: true, launched: steamUrl, via: "steam" };
    }

    const execPath = findWTExecutable(cfg.root_path);
    if (!execPath) {
      return { ok: false, message: "Could not find launcher/aces in the root. Switch to Steam in Utilities or correct the path." };
    }
    if (process.platform === "darwin") {
      spawn("open", [execPath], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn(execPath, [], { detached: true, stdio: "ignore" }).unref();
    }
    return { ok: true, launched: execPath, via: "native" };
  } catch (e) {
    return { ok: false, message: e.message || "Failed to launch War Thunder." };
  }
});

ipcMain.handle("profiles:delete", (e, profileFile) => {
  try {
    const fp = path.join(PROFILES_DIR(), profileFile);
    if (!profileFile || !fs.existsSync(fp)) {
      return { ok: false, message: "Profile not found." };
    }
    fs.unlinkSync(fp);
    return { ok: true, deleted: profileFile };
  } catch (e2) {
    return { ok: false, message: e2.message || "Failed to delete profile." };
  }
});

ipcMain.handle("dialog:chooseRoot", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  const root = result.filePaths[0];
  const cfg = readConfig();
  const next = {
    ...cfg,
    root_path: root,
    is_using_steam: isSteamRoot(root) ? 1 : 0,
  };
  writeConfig(next);
  return next;
});

ipcMain.handle("auto:locateRoot", () => {
  const found = tryAutoLocateRoot();
  if (!found) return null;
  const cfg = readConfig();
  const next = {
    ...cfg,
    root_path: found,
    is_using_steam: isSteamRoot(found) ? 1 : 0,
  };
  writeConfig(next);
  return next;
});

ipcMain.handle("lang:listCsvs", () => {
  const { root_path } = readConfig();
  if (!root_path) return [];
  const langDir = path.join(root_path, "lang");
  if (!fs.existsSync(langDir)) return [];
  return fs.readdirSync(langDir).filter(f => f.toLowerCase().endsWith(".csv")).sort();
});
ipcMain.handle("lang:loadCsv", (e, filename) => {
  const { root_path } = readConfig();
  if (!root_path) throw new Error("No root_path set.");
  const fp = path.join(root_path, "lang", filename);
  if (!fs.existsSync(fp)) throw new Error("File not found: " + filename);
  const { headers, rows, delimiter } = readCsv(fp);
  writeConfig({ ...readConfig(), lastFile: filename });
  return { headers, rows, delimiter, filename };
});
ipcMain.handle("lang:search", (e, { filename, language, query, limit = 150 }) => {
  const { root_path } = readConfig();
  const fp = path.join(root_path, "lang", filename);
  const { headers, rows, delimiter } = readCsv(fp);
  const keyCol = headers[0];
  if (!headers.includes(language)) throw new Error(`Language column not found: ${language}`);

  const q = String(query ?? "");
  if (!q.trim()) return { headers, keyCol, matches: [], delimiter, fuzzy: true };

  const ranked = [];
  for (const r of rows) {
    const key = String(r[keyCol] ?? "");
    const val = String(r[language] ?? "");
    const { ok, score } = acceptStrict(q, key, val);
    if (ok) ranked.push({ row: r, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const matches = ranked.slice(0, limit).map(x => x.row);
  return { headers, keyCol, matches, delimiter, fuzzy: true };
});

ipcMain.handle("lang:applyChange", (e, { filename, language, key, newValue }) => {
  const { root_path } = readConfig();
  const fp = path.join(root_path, "lang", filename);
  const { headers, rows, delimiter } = readCsv(fp);
  const keyCol = headers[0];
  if (!headers.includes(language)) throw new Error(`Language column not found: ${language}`);
  const idx = rows.findIndex(r => String(r[keyCol]) === String(key));
  if (idx === -1) throw new Error("Row not found for key: " + key);
  const oldValue = String(rows[idx][language] ?? "");
  rows[idx][language] = newValue;
  writeCsv(fp, headers, rows, delimiter);

  const log = readChanges();
  log.changes.push({ ts: new Date().toISOString(), filename, key, language, oldValue, newValue });
  writeChanges(log);
  return { ok: true };
});

ipcMain.handle("changes:list", () => readChanges());
ipcMain.handle("changes:undo", () => {
  const log = readChanges();
  const last = log.changes.pop();
  if (!last) return { ok: false, message: "No changes to undo." };

  const { root_path } = readConfig();
  const fp = path.join(root_path, "lang", last.filename);
  const { headers, rows, delimiter } = readCsv(fp);
  const keyCol = headers[0];
  const idx = rows.findIndex(r => String(r[keyCol]) === String(last.key));
  if (idx === -1) { log.changes.push(last); return { ok: false, message: "Original row not found; cannot undo." }; }
  rows[idx][last.language] = last.oldValue;
  writeCsv(fp, headers, rows, delimiter);
  writeChanges(log);
  return { ok: true, undone: last };
});
ipcMain.handle("changes:undoOne", (e, ts) => {
  const log = readChanges();
  const i = log.changes.findIndex(ch => ch.ts === ts);
  if (i === -1) return { ok: false, message: "Change not found." };

  const ch = log.changes[i];
  const { root_path } = readConfig();
  const fp = path.join(root_path, "lang", ch.filename);
  if (!fs.existsSync(fp)) return { ok: false, message: "CSV file not found." };

  const { headers, rows, delimiter } = readCsv(fp);
  const keyCol = headers[0];
  const idx = rows.findIndex(r => String(r[keyCol]) === String(ch.key));
  if (idx === -1) return { ok: false, message: "Original row not found; cannot undo." };

  rows[idx][ch.language] = ch.oldValue;
  writeCsv(fp, headers, rows, delimiter);

  log.changes.splice(i, 1);
  writeChanges(log);
  return { ok: true, undone: ch };
});

ipcMain.handle("util:deleteLang", () => {
  const { root_path } = readConfig();
  if (!root_path) return { ok: false, message: "Root path not set." };

  const langDir = path.join(root_path, "lang");
  if (!fs.existsSync(langDir)) {

    writeChanges({ changes: [] });
    return { ok: true, cleared: true, message: "No /lang directory found. Cleared change history." };
  }

  try {
    fs.rmSync(langDir, { recursive: true, force: true });

    writeChanges({ changes: [] });
    return { ok: true, cleared: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("profiles:list", () => {
  const dir = PROFILES_DIR();
  try {
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".json")).sort();
    return files;
  } catch { return []; }
});

ipcMain.handle("profiles:save", (e, name) => {
  const snapshot = readChanges();
  const dir = PROFILES_DIR();
  fs.mkdirSync(dir, { recursive: true });

  const safe = (name || new Date().toISOString().replace(/[:.]/g, "-"))
      .replace(/[^\w\-]+/g, "_")
      .slice(0, 80);

  const file = path.join(dir, `${safe}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
    return { ok: true, file };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("profiles:apply", (e, profileFile) => {
  const dir = PROFILES_DIR();
  const fp = path.join(dir, profileFile);
  if (!fs.existsSync(fp)) return { ok: false, message: "Profile not found." };

  const data = JSON.parse(fs.readFileSync(fp, "utf8"));
  const changes = data?.changes || [];
  if (!Array.isArray(changes) || changes.length === 0) {
    return { ok: false, message: "Profile has no changes." };
  }

  const { root_path } = readConfig();
  if (!root_path) return { ok: false, message: "Root path not set." };

  const updates = new Map();
  for (const ch of changes) {
    if (!ch || !ch.filename || !ch.key || !ch.language) continue;
    const byFile = updates.get(ch.filename) || new Map();
    const byKey = byFile.get(ch.key) || new Map();
    byKey.set(ch.language, ch.newValue ?? "");
    byFile.set(ch.key, byKey);
    updates.set(ch.filename, byFile);
  }

  const log = readChanges();
  let applied = 0, skipped = 0, filesTouched = 0, logged = 0;

  for (const [filename, byKey] of updates.entries()) {
    const csvPath = path.join(root_path, "lang", filename);
    if (!fs.existsSync(csvPath)) { skipped += byKey.size; continue; }

    const { headers, rows, delimiter } = readCsv(csvPath);
    const keyCol = headers[0];
    const langsInFile = new Set(headers.slice(1));
    let changed = false;

    for (const [key, byLang] of byKey.entries()) {
      const rowIdx = rows.findIndex(r => String(r[keyCol]) === String(key));
      if (rowIdx === -1) { skipped += byLang.size; continue; }

      for (const [lang, val] of byLang.entries()) {
        if (!langsInFile.has(lang)) { skipped++; continue; }

        const oldValue = String(rows[rowIdx][lang] ?? "");
        const newValue = String(val ?? "");
        if (oldValue !== newValue) {
          rows[rowIdx][lang] = newValue;
          applied++;
          changed = true;

          log.changes.push({
            ts: new Date().toISOString(),
            filename,
            key,
            language: lang,
            oldValue,
            newValue
          });
          logged++;
        }
      }
    }

    if (changed) {
      writeCsv(csvPath, headers, rows, delimiter);
      filesTouched++;
    }
  }

  writeChanges(log);
  return { ok: true, applied, skipped, filesTouched, logged };
});