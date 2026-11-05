const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  listPages: () => ipcRenderer.invoke("pages:list"),
  createPage: (options) => ipcRenderer.invoke("pages:create", options),
  updatePage: (payload) => ipcRenderer.invoke("pages:update", payload),
  deletePage: (id) => ipcRenderer.invoke("pages:delete", id),
  loadDocument: (id) => ipcRenderer.invoke("document:load", id),
  saveDocument: (blocks, options) => ipcRenderer.invoke("document:save", blocks, options),
  saveAttachment: (attachment) => ipcRenderer.invoke("attachment:save", attachment),
});
