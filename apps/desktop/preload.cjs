const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  // 앱에 묶인 화면 전용 (서버 화면에서 부르면 메인 프로세스가 거절한다)
  listPages: () => ipcRenderer.invoke("pages:list"),
  createPage: (options) => ipcRenderer.invoke("pages:create", options),
  updatePage: (payload) => ipcRenderer.invoke("pages:update", payload),
  deletePage: (id) => ipcRenderer.invoke("pages:delete", id),
  loadDocument: (id) => ipcRenderer.invoke("document:load", id),
  saveDocument: (blocks, options) => ipcRenderer.invoke("document:save", blocks, options),
  saveAttachment: (attachment) => ipcRenderer.invoke("attachment:save", attachment),

  // 서버 화면 모드: 로그인 후 서버가 제공하는 웹 화면으로 옮겨 간다
  /** 앱에 묶인 로그인 화면에서 로그인한 뒤. 서버 화면으로 옮겼으면 true. */
  openServer: (serverHost, session) => ipcRenderer.invoke("server:open", { serverHost, session }),
  /** 서버 화면이 시작할 때 넘겨받은 로그인 세션 (한 번만, 없으면 null) */
  takePendingSession: () => ipcRenderer.sendSync("server:take-session"),
  /** 서버 화면에서 로그아웃: 앱에 묶인 로그인 화면으로 돌아간다 */
  leaveServer: () => ipcRenderer.invoke("server:leave"),
});
