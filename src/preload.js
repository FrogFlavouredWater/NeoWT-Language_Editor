const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // config & root
  launchGame: () => ipcRenderer.invoke("util:launchGame"),
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),
  chooseRoot: () => ipcRenderer.invoke("dialog:chooseRoot"),
  autoLocateRoot: () => ipcRenderer.invoke("auto:locateRoot"),

  // csv & search
  listCsvs: () => ipcRenderer.invoke("lang:listCsvs"),
  loadCsv: (filename) => ipcRenderer.invoke("lang:loadCsv", filename),
  search: (args) => ipcRenderer.invoke("lang:search", args),
  applyChange: (args) => ipcRenderer.invoke("lang:applyChange", args),

  // changes
  listChanges: () => ipcRenderer.invoke("changes:list"),
  undo: () => ipcRenderer.invoke("changes:undo"),
  undoOne: (ts) => ipcRenderer.invoke("changes:undoOne", ts),

  // utilities
  deleteLang: () => ipcRenderer.invoke("util:deleteLang"),

  // profiles
  profileList: () => ipcRenderer.invoke("profiles:list"),
  profileSave: (name) => ipcRenderer.invoke("profiles:save", name),
  profileApply: (file) => ipcRenderer.invoke("profiles:apply", file),
  profileDelete: (file) => ipcRenderer.invoke("profiles:delete", file),

});
