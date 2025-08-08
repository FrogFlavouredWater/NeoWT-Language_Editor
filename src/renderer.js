const $ = (sel) => document.querySelector(sel);

// App state
const state = {
  cfg: null,
  filename: null,
  language: null,
  delimiter: ",",
  _lastFocus: null,
};

async function init() {
  if (!window.api) return; // preload failed; splash stays visible

  state.cfg = await window.api.loadConfig();
  const needsSetup = !state.cfg || !state.cfg.root_path;
  $("#splash").classList.toggle("hidden", !needsSetup);
  $("#main").classList.toggle("hidden", needsSetup);

  // Splash
  $("#btnBrowse").addEventListener("click", onBrowseRoot);
  $("#btnAuto").addEventListener("click", onAutoLocate);
  $("#btnSaveRoot").addEventListener("click", onSaveRoot);

  // Editor
  $("#btnSearch").addEventListener("click", onSearch);
  $("#csvSelect").addEventListener("change", onCsvChange);
  $("#langSelect").addEventListener("change", onLangChange);
  $("#btnUndo").addEventListener("click", onUndo);

  const searchWrap = document.querySelector(".search-input");
  const searchBox  = $("#searchBox");
  const btnClear   = $("#btnClearSearch");
  btnClear.addEventListener("click", clearSearch);
  // Esc clears when typing in the search box
  searchBox.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); clearSearch(); }
  });
  // updateClearVis();

  // inside init(), after your existing bindings:
  document.getElementById("btnUtilities").addEventListener("click", openUtilModal);
  document.getElementById("utilClose").addEventListener("click", closeUtilModal);
  document.getElementById("btnDeleteLang").addEventListener("click", onDeleteLang);
  document.getElementById("btnSaveProfile").addEventListener("click", onSaveProfile);
  document.getElementById("btnApplyProfile").addEventListener("click", onApplyProfile);
  document.getElementById("btnDeleteProfile").addEventListener("click", onDeleteProfile);

  document.getElementById("utilModal").addEventListener("click", (e) => {
    if (e.target.id === "utilModal") closeUtilModal();
  });

  const steamToggle = document.getElementById("toggleSteam");
  steamToggle.addEventListener("change", async (e) => {
    await window.api.saveConfig({ is_using_steam: e.target.checked ? 1 : 0 });
    toast(`Launch via ${e.target.checked ? "Steam" : "native launcher"}.`, "success");
  });

  bindClick("#btnLaunchWT", onLaunchWT);

// // Delegation backup in case the button node is replaced later
//   const utilModalRoot = document.getElementById("utilModal");
//   if (utilModalRoot) {
//     utilModalRoot.addEventListener("click", (ev) => {
//       const launchBtn = ev.target.closest("#btnLaunchWT");
//       if (launchBtn) onLaunchWT(ev);
//     });
//   }

  // Modal
  $("#editCancel").addEventListener("click", closeModal);
  $("#editSave").addEventListener("click", saveModal);
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal(); // click outside card
  });
  document.addEventListener("keydown", (e) => {
    const modalOpen = $("#modal").classList.contains("open");
    if (!modalOpen) return;
    if (e.key === "Escape") { e.preventDefault(); closeModal(); }
    if (e.key === "Enter" && !e.shiftKey && document.activeElement.id !== "editCancel") {
      e.preventDefault(); saveModal();
    }
  });

  if (!needsSetup) await afterSetup();
  await refreshChangesLog();
}

/* ---------- Splash ---------- */
async function onBrowseRoot() {
  const cfg = await window.api.chooseRoot();
  if (!cfg) return;
  state.cfg = cfg;
  $("#rootPath").value = cfg.root_path || "";
  $("#splashStatus").textContent = "Path selected.";
  toast("Selected War Thunder root.", "info");
}
async function onAutoLocate() {
  $("#splashStatus").textContent = "Searching common locations…";
  const cfg = await window.api.autoLocateRoot();
  if (!cfg) {
    $("#splashStatus").textContent = "Could not find War Thunder automatically. Please browse manually.";
    toast("Could not auto-locate War Thunder.", "error");
    return;
  }
  state.cfg = cfg;
  $("#rootPath").value = cfg.root_path || "";
  $("#splashStatus").textContent = "Found automatically.";
  toast("Found War Thunder automatically.", "success");
}
async function onSaveRoot() {
  const entered = $("#rootPath").value.trim();
  if (!entered && (!state.cfg || !state.cfg.root_path)) {
    $("#splashStatus").textContent = "Please select a folder or use auto locate.";
    toast("Select a folder or use auto locate.", "error");
    return;
  }
  const patch = entered ? { root_path: entered } : {};
  state.cfg = await window.api.saveConfig(patch);
  $("#splash").classList.add("hidden");
  $("#main").classList.remove("hidden");
  toast("Root path saved.", "success");
  await afterSetup();
}

/* ---------- Editor ---------- */
async function afterSetup() { await refreshCsvList(); }

async function refreshCsvList() {
  const files = await window.api.listCsvs();
  const sel = $("#csvSelect");
  sel.innerHTML = "";
  if (!files.length) {
    sel.innerHTML = "<option>No CSVs found</option>";
    toast("No CSV files found in /lang.", "error");
    return;
  }
  for (const f of files) {
    const opt = document.createElement("option");
    opt.value = f; opt.textContent = f;
    sel.appendChild(opt);
  }
  const last = state.cfg?.lastFile && files.includes(state.cfg.lastFile) ? state.cfg.lastFile : files[0];
  sel.value = last;
  await loadCsv(last);
}

async function loadCsv(filename) {
  const data = await window.api.loadCsv(filename);
  state.filename = filename;
  state.delimiter = data.delimiter;
  await populateLanguages(data.headers);
}

async function populateLanguages(headers) {
  const langSel = $("#langSelect"); langSel.innerHTML = "";
  const langs = headers.slice(1);
  for (const l of langs) {
    const opt = document.createElement("option"); opt.value = l; opt.textContent = l; langSel.appendChild(opt);
  }
  const preferred = state.cfg?.language && langs.includes(state.cfg.language) ? state.cfg.language : langs[0];
  langSel.value = preferred; state.language = preferred;
  state.cfg = await window.api.saveConfig({ language: preferred });
}

async function onCsvChange(e) { await loadCsv(e.target.value); }
async function onLangChange(e) { state.language = e.target.value; await window.api.saveConfig({ language: state.language }); }

async function onSearch() {
  const q = $("#searchBox").value;
  const resultsDiv = $("#results"); resultsDiv.innerHTML = "";
  if (!q) { resultsDiv.innerHTML = `<p class="muted tiny">Type something to search key or value.</p>`; return; }

  const { keyCol, matches } = await window.api.search({
    filename: state.filename, language: state.language, query: q
  });

  if (!matches.length) { resultsDiv.innerHTML = `<p>No matches found.</p>`; return; }

  const table = document.createElement("table"); table.className = "table";
  table.innerHTML = `<thead><tr>
    <th>#</th><th>${keyCol}</th><th>${state.language}</th><th>Action</th>
  </tr></thead><tbody></tbody>`;

  matches.forEach((row, i) => {
    const key = String(row[keyCol]);
    const val = String(row[state.language] ?? "");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><code>${highlight(key, q)}</code></td>
      <td>${highlight(val, q)}</td>
      <td><button class="edit-btn" data-key="${escapeAttr(key)}" data-val="${escapeAttr(val)}" title="Edit">✎</button></td>`;
    table.querySelector("tbody").appendChild(tr);
  });
  resultsDiv.appendChild(table);

  resultsDiv.querySelectorAll(".edit-btn").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      const key = ev.currentTarget.getAttribute("data-key");
      const val = ev.currentTarget.getAttribute("data-val") || "";
      openModal(key, val);
    });
  });
}

async function onUndo() {
  const res = await window.api.undo();
  if (!res.ok) { toast(res.message || "Nothing to undo.", "error"); return; }
  toast("Undid last change.", "success");
  await refreshChangesLog();
  if ($("#searchBox").value) await onSearch();
}


async function refreshChangesLog() {
  const div = $("#changesLog");
  const log = await window.api.listChanges();
  const items = log.changes || [];
  if (!items.length) {
    div.innerHTML = `<h3>Recent changes</h3><span class="tiny muted">No edits recorded yet.</span>`;
    return;
  }

  const html = items.slice(-50).reverse().map(ch => {
    const ts = new Date(ch.ts).toLocaleString();
    const oldSafe = escapeHtml(ch.oldValue);
    const newSafe = escapeHtml(ch.newValue);

    return `
      <div class="change-row">
        <div class="change-meta">
          <span class="badge">${ts}</span>

          <div class="meta-group" title="${escapeAttr(`${ch.filename} · ${ch.language} · ${ch.key}`)}">
            <span class="meta file">${escapeHtml(ch.filename)}</span>
            <span class="meta lang">${escapeHtml(ch.language)}</span>
            <span class="meta key">${escapeHtml(ch.key)}</span>

            <span class="meta delta">
              <span class="old" title="${oldSafe}">“${oldSafe}”</span>
              <span class="arrow">➜</span>
              <span class="new pill" title="${newSafe}">“${newSafe}”</span>
            </span>
          </div>
        </div>

        <button class="btn btn--ghost btn--xs change-undo"
                data-ts="${escapeAttr(ch.ts)}"
                title="Undo this change">Undo</button>
      </div>`;
  }).join("");

  div.innerHTML = `<h3>Recent changes</h3>${html}`;

  // Wire per-row undo
  div.querySelectorAll(".change-undo").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      const ts = ev.currentTarget.getAttribute("data-ts");
      const res = await window.api.undoOne(ts);
      if (!res.ok) { toast(res.message || "Could not undo change.", "error"); return; }
      toast("Change undone.", "success");
      await refreshChangesLog();
      if ($("#searchBox").value) await onSearch();
    });
  });
}

function clearSearch(){
  const box = $("#searchBox");
  box.value = "";
  document.querySelector(".search-input").classList.remove("has-value");
  const resultsDiv = $("#results");
  resultsDiv.innerHTML = "";            // remove the table/items
  box.focus();
}

/* ---------- Modal (animated) ---------- */
function openModal(key, currentValue) {
  $("#editKey").textContent = key;
  $("#editLang").textContent = state.language;
  const ta = $("#editInput");
  ta.value = currentValue;

  const modal = $("#modal");
  modal.classList.remove("hidden", "closing");
  // force reflow
  // eslint-disable-next-line no-unused-expressions
  modal.offsetWidth;
  modal.classList.add("open");

  state._lastFocus = document.activeElement;
  document.body.style.overflow = "hidden";
  setTimeout(() => ta.focus(), 0);
}
function closeModal() {
  const modal = $("#modal");
  if (!modal.classList.contains("open")) { modal.classList.add("hidden"); return; }
  modal.classList.add("closing");
  modal.classList.remove("open");
  setTimeout(() => {
    modal.classList.add("hidden");
    modal.classList.remove("closing");
  }, 220);
  document.body.style.overflow = "";
  if (state._lastFocus && state._lastFocus.focus) {
    try { state._lastFocus.focus(); } catch {}
  }
}
async function saveModal() {
  const key = $("#editKey").textContent;
  const newValue = $("#editInput").value;
  if (!key) return;
  const res = await window.api.applyChange({
    filename: state.filename, language: state.language, key, newValue
  });
  if (!res.ok) {
    toast(res.message || "Failed to apply change.", "error");
    return;
  }
  closeModal();
  toast("Value updated.", "success");
  await refreshChangesLog();
  if ($("#searchBox").value) await onSearch();
}

function bindClick(sel, fn){
  const el = document.querySelector(sel);
  if (el) el.addEventListener("click", fn);
  else console.warn("Missing element:", sel);
}

async function onLaunchWT(e){
  e?.preventDefault?.();
  // immediate feedback so we know the click fired
  toast("Launching…", "info");
  try {
    const res = await window.api.launchGame?.();
    if (!res || !res.ok) {
      toast(res?.message || "Failed to launch War Thunder.", "error");
      return;
    }
    toast(res.via === "steam" ? "Launching via Steam…" : "Launching via native launcher…", "success");
  } catch (err) {
    console.error(err);
    toast("Failed to launch War Thunder.", "error");
  }
}


/* ---------- Utilities modal ---------- */
async function openUtilModal(){
  // default profile name
  const cfg = await window.api.loadConfig();
  const steamToggle = document.getElementById("toggleSteam");
  steamToggle.checked = (cfg?.is_using_steam === 1);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const input = document.getElementById("profileName");
  if (input && !input.value) input.value = `profile-${ts}`;

  // load profiles
  await refreshProfileList();

  const m = document.getElementById("utilModal");
  m.classList.remove("hidden");
  // force reflow then open (anim if you kept it)
  // eslint-disable-next-line no-unused-expressions
  m.offsetWidth; m.classList.add("open");
}
function closeUtilModal(){
  const m = document.getElementById("utilModal");
  m.classList.remove("open");
  setTimeout(() => m.classList.add("hidden"), 200);
}

async function refreshProfileList(){
  const applySel  = document.getElementById("profileSelect");
  const delSel    = document.getElementById("profileDeleteSelect");
  const profiles  = await window.api.profileList();

  function fillSelect(sel){
    if (!sel) return;
    sel.innerHTML = "";
    if (!profiles.length){
      sel.innerHTML = `<option disabled selected>No profiles found</option>`;
      return;
    }
    profiles.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p; opt.textContent = p;
      sel.appendChild(opt);
    });
  }

  fillSelect(applySel);
  fillSelect(delSel);
}


/* ---------- Utility actions ---------- */
async function onDeleteProfile(){
  const sel = document.getElementById("profileDeleteSelect");
  const name = sel && sel.value;
  if (!name){ toast("Choose a profile to delete.", "error"); return; }

  const ok = confirm(`Delete profile "${name}"? This only removes the snapshot file.`);
  if (!ok) return;

  const res = await window.api.profileDelete(name);
  if (!res || !res.ok){
    toast(res?.message || "Failed to delete profile.", "error");
    return;
  }
  toast(`Deleted "${name}".`, "success");
  await refreshProfileList();
}

async function onDeleteLang(){
  if (!confirm("Delete the /lang folder in your War Thunder directory?\nThis removes all CSVs so the game can recreate them on next update/launch.\n\nIt will also clear your Recent changes history.")) return;

  const res = await window.api.deleteLang();
  if (!res.ok){
    toast(res.message || "Failed to delete /lang.", "error");
    return;
  }

  toast(res.cleared ? "/lang deleted and history cleared." : "/lang deleted.", "success");

  // Clear UI state
  document.getElementById("results").innerHTML = "";
  await refreshCsvList();
  await refreshChangesLog();   // <-- reflect cleared history
}

async function onSaveProfile(){
  const name = document.getElementById("profileName").value.trim();
  const res = await window.api.profileSave(name);
  if (!res.ok){ toast(res.message || "Failed to save profile.", "error"); return; }
  toast("Profile saved.", "success");
  await refreshProfileList();
}



async function onApplyProfile(){
  const sel = document.getElementById("profileSelect");
  if (!sel.value){ toast("Choose a profile first.", "error"); return; }
  const res = await window.api.profileApply(sel.value);
  if (!res.ok){ toast(res.message || "Failed to apply profile.", "error"); return; }
  toast(`Applied ${res.applied} change(s)${res.skipped?`, ${res.skipped} skipped`:``}.`, "success");

  await refreshChangesLog();               // ← repopulate the Recent changes UI

  if (document.getElementById("searchBox").value) await onSearch();
}



/* ---------- Toasts ---------- */
function toast(message, type="info", ms=2600){
  const stack = $("#toastStack");
  const div = document.createElement("div");
  div.className = `toast toast--${type}`;
  div.setAttribute("role","status");
  div.innerHTML = `<div class="toast__msg">${escapeHtml(message)}</div>`;
  stack.appendChild(div);

  const hide = () => {
    if (!div.classList.contains("hide")) {
      div.classList.add("hide");
      setTimeout(() => div.remove(), 220);
    }
  };
  const t = setTimeout(hide, ms);
  div.addEventListener("click", () => { clearTimeout(t); hide(); });
}

/* ---------- Utils ---------- */
function escapeHtml(s=""){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function escapeAttr(s=""){return escapeHtml(s).replace(/"/g,"&quot;")}
function highlight(text, query){
  const t = String(text ?? "");
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return escapeHtml(t);
  const idx = t.toLowerCase().indexOf(q);
  if (idx === -1) return escapeHtml(t);
  const before = escapeHtml(t.slice(0, idx));
  const mid = escapeHtml(t.slice(idx, idx + q.length));
  const after = escapeHtml(t.slice(idx + q.length));
  return `${before}<mark>${mid}</mark>${after}`;
}

init();
