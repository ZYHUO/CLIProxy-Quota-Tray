const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipQuota", {
  getSnapshot: (options) => ipcRenderer.invoke("snapshot", options || {}),
  readSettings: () => ipcRenderer.invoke("settings:read"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  clearUsage: () => ipcRenderer.invoke("usage:clear"),
  enableUsage: () => ipcRenderer.invoke("usage:enable"),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  setPinned: (pinned) => ipcRenderer.invoke("window:pin", pinned),
  onPinChange: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, pinned) => callback(pinned);
    ipcRenderer.on("pin-change", listener);
    return () => ipcRenderer.off("pin-change", listener);
  }
});
