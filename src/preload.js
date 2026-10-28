// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

contextBridge.exposeInMainWorld('orion', {
  // Settings → Cosmetics → Text size: zooms the whole window.
  setZoomFactor: (factor) => {
    if (typeof factor === 'number' && Number.isFinite(factor) && factor >= 0.5 && factor <= 2) {
      webFrame.setZoomFactor(factor);
    }
  },
  // App persistence
  loadStore: () => ipcRenderer.invoke('storage:load'),
  saveStore: (value) => ipcRenderer.invoke('storage:save', value),
  loadThreadsHead: (input) => ipcRenderer.invoke('storage:loadThreadsHead', input),
  loadThreadsBatch: (input) => ipcRenderer.invoke('storage:loadThreadsBatch', input),
  saveThreads: (value) => ipcRenderer.invoke('storage:saveThreads', value),
  // Synchronous on purpose: the quit-time flush must block unload until the
  // write is on disk (an async invoke would race app teardown).
  saveThreadsSync: (value) => ipcRenderer.sendSync('storage:saveThreadsSync', value),
  clearStore: () => ipcRenderer.invoke('storage:clear'),

  // Claude Code / Codex conversation import
  scanImportableSessions: (input) => ipcRenderer.invoke('sessionImport:scan', input),
  readImportableSessions: (input) => ipcRenderer.invoke('sessionImport:read', input),

  // Dialog
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  browseDirectories: (requestedPath) => ipcRenderer.invoke('fs:browseDirectories', requestedPath),
  resolveProjectDirectory: (inputPath, options) =>
    ipcRenderer.invoke('fs:resolveProjectDirectory', inputPath, options),
  getNoProjectDir: () => ipcRenderer.invoke('app:getNoProjectDir'),

  // File system
  readDirectory: (dirPath) => ipcRenderer.invoke('fs:readDirectory', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  readFileResult: (filePath) => ipcRenderer.invoke('fs:readFileResult', filePath),
  setWatchedFiles: (filePaths) => ipcRenderer.invoke('fs:setWatchedFiles', filePaths),
  openLinkedFile: (input) => ipcRenderer.invoke('fs:openLinkedFile', input),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  createFile: (filePath, content = '') => ipcRenderer.invoke('fs:createFile', filePath, content),
  createDirectory: (dirPath) => ipcRenderer.invoke('fs:createDirectory', dirPath),
  deletePath: (targetPath) => ipcRenderer.invoke('fs:deletePath', targetPath),
  renamePath: (oldPath, newPath) => ipcRenderer.invoke('fs:renamePath', oldPath, newPath),
  showFileTreeMenu: (input) => ipcRenderer.invoke('fileTree:showContextMenu', input),
  confirmDeletePath: (input) => ipcRenderer.invoke('fileTree:confirmDelete', input),
  saveAttachment: (input) => ipcRenderer.invoke('attachment:save', input),
  // Kept for one release so a renderer hot-reload can still talk to an older
  // preload/main pair while Orion is being restarted after an update.
  saveImageAttachment: (input) => ipcRenderer.invoke('attachment:saveImage', input),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Git
  getGitState: (projectPath) => ipcRenderer.invoke('git:getState', projectPath),
  changeSourceControlToOrion: (input) => ipcRenderer.invoke('git:changeSourceControlToOrion', input),
  authorizeGithubMirror: (projectPath) => ipcRenderer.invoke('git:authorizeGithubMirror', projectPath),
  checkoutGitBranch: (input) => ipcRenderer.invoke('git:checkoutBranch', input),
  commitAndPush: (input) => ipcRenderer.invoke('git:commitAndPush', input),

  // Bundled durango-code CLI and Durango workspaces (docs/workspaces.md)
  durangoCliStatus: () => ipcRenderer.invoke('durangoCli:status'),
  durangoCliSignIn: () => ipcRenderer.invoke('durangoCli:signIn'),
  inspectDurangoWorkspaceProject: (input) => ipcRenderer.invoke('durangoWorkspace:inspect', input),
  createDurangoWorkspace: (input) => ipcRenderer.invoke('durangoWorkspace:create', input),
  findDurangoWorkspace: (input) => ipcRenderer.invoke('durangoWorkspace:find', input),
  removeDurangoWorkspace: (input) => ipcRenderer.invoke('durangoWorkspace:remove', input),
  durangoWorkspaceStatus: (input) => ipcRenderer.invoke('durangoWorkspace:status', input),
  missingDurangoWorkspaces: (input) => ipcRenderer.invoke('durangoWorkspace:missing', input),
  landDurangoWorkspace: (input) => ipcRenderer.invoke('durangoWorkspace:land', input),
  serveDurangoWorkspace: (input) => ipcRenderer.invoke('durangoWorkspace:serve', input),
  stopDurangoWorkspaceServer: (input) => ipcRenderer.invoke('durangoWorkspace:stopServer', input),
  onDurangoWorkspaceServerExited: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('durangoWorkspace:serverExited', listener);
    return () => ipcRenderer.removeListener('durangoWorkspace:serverExited', listener);
  },

  // Agent skills and MCP servers (Settings > Skills & MCPs)
  listSkills: () => ipcRenderer.invoke('skills:list'),
  importSkills: (input) => ipcRenderer.invoke('skills:import', input),
  setSkillEnabled: (input) => ipcRenderer.invoke('skills:setEnabled', input),
  deleteSkill: (input) => ipcRenderer.invoke('skills:delete', input),
  revealSkill: (input) => ipcRenderer.invoke('skills:reveal', input),
  openSkillsFolder: () => ipcRenderer.invoke('skills:openFolder'),
  listMcps: () => ipcRenderer.invoke('mcps:list'),
  setMcpEnabled: (input) => ipcRenderer.invoke('mcps:setEnabled', input),
  listOrionMcps: () => ipcRenderer.invoke('orionMcps:list'),
  addOrionMcp: (input) => ipcRenderer.invoke('orionMcps:add', input),
  updateOrionMcp: (input) => ipcRenderer.invoke('orionMcps:update', input),
  removeOrionMcp: (input) => ipcRenderer.invoke('orionMcps:remove', input),
  reconnectOrionMcp: (input) => ipcRenderer.invoke('orionMcps:reconnect', input),
  cancelOrionMcpSignIn: (input) => ipcRenderer.invoke('orionMcps:cancelSignIn', input),
  listProviderMcps: (input) => ipcRenderer.invoke('providerMcps:list', input),
  shareProviderMcp: (input) => ipcRenderer.invoke('providerMcps:share', input),
  // Dev servers (Settings > Dev Servers)
  listDevServers: (input) => ipcRenderer.invoke('devServers:list', input),
  openDevServer: (input) => ipcRenderer.invoke('devServers:open', input),
  killDevServers: (input) => ipcRenderer.invoke('devServers:kill', input),

  // Agent runtime
  listAgentModels: (input) => ipcRenderer.invoke('agent:listModels', input),
  onAgentModelsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('agent:modelsChanged', listener);
    return () => ipcRenderer.removeListener('agent:modelsChanged', listener);
  },
  supportsThreadReader: (providerId) => ipcRenderer.invoke('agent:supportsThreadReader', providerId),
  runAgentTurn: (input) => ipcRenderer.invoke('agent:runTurn', input),
  // Claude slash commands (built-ins + .claude/commands + skills + plugins)
  listSlashCommands: (input) => ipcRenderer.invoke('agent:listSlashCommands', input),
  clearClaudeSession: (threadId) => ipcRenderer.invoke('agent:clearClaudeSession', threadId),
  onSlashCommands: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('agent:slashCommands', listener);
    return () => ipcRenderer.removeListener('agent:slashCommands', listener);
  },
  steerAgentTurn: (runId, text, attachments) => ipcRenderer.invoke('agent:steerTurn', runId, text, attachments),
  getClaudeQuestions: (threadId) => ipcRenderer.invoke('agent:getClaudeQuestions', threadId),
  answerClaudeQuestions: (runId, requestId, answers) => ipcRenderer.invoke('agent:answerClaudeQuestions', runId, requestId, answers),
  getCodexQuestions: (threadId) => ipcRenderer.invoke('agent:getCodexQuestions', threadId),
  answerCodexQuestions: (runId, requestId, answers, text) => ipcRenderer.invoke('agent:answerCodexQuestions', runId, requestId, answers, text),
  discardClaudeBackgroundShellTasks: (runId) =>
    ipcRenderer.invoke('agent:discardClaudeBackgroundShellTasks', runId),
  stopAgentTurn: (runId, options) => ipcRenderer.invoke('agent:stopTurn', runId, options),
  isRunFinalizing: (runId) => ipcRenderer.invoke('agent:isRunFinalizing', runId),
  // Codex goal ops (pause/clear/status) for threads with no live goal run.
  codexGoalCommand: (input) => ipcRenderer.invoke('agent:codexGoal', input),
  disposeAgentThread: (threadId) => ipcRenderer.invoke('agent:disposeThread', threadId),
  generateThreadTitle: (input) => ipcRenderer.invoke('agent:generateTitle', input),
  getProviderStatus: () => ipcRenderer.invoke('providers:getStatus'),

  // Claude Code CLI embedded terminal (one PTY per thread, lives in main)
  terminalEnsure: (input) => ipcRenderer.invoke('terminal:ensure', input),
  terminalInput: (input) => ipcRenderer.invoke('terminal:input', input),
  terminalResize: (input) => ipcRenderer.invoke('terminal:resize', input),
  terminalSendPrompt: (input) => ipcRenderer.invoke('terminal:sendPrompt', input),
  terminalKill: (threadId) => ipcRenderer.invoke('terminal:kill', threadId),
  onTerminalData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  onTerminalActivity: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:activity', listener);
    return () => ipcRenderer.removeListener('terminal:activity', listener);
  },
  onTerminalSession: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:session', listener);
    return () => ipcRenderer.removeListener('terminal:session', listener);
  },
  checkProviderUpdates: (input) => ipcRenderer.invoke('providers:checkUpdates', input),
  updateProviders: (input) => ipcRenderer.invoke('providers:updateAll', input),
  getActiveProviderUpdate: () => ipcRenderer.invoke('providers:getActiveUpdate'),
  cancelProviderUpdate: (operationId) => ipcRenderer.invoke('providers:cancelUpdate', operationId),
  onProviderUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('providers:updateProgress', listener);
    return () => ipcRenderer.removeListener('providers:updateProgress', listener);
  },
  authenticateProvider: (providerId) => ipcRenderer.invoke('providers:authenticate', providerId),
  getFxConnections: () => ipcRenderer.invoke('fx:getConnections'),
  installFx: () => ipcRenderer.invoke('fx:install'),
  connectFx: (target) => ipcRenderer.invoke('fx:connect', target),
  disconnectFx: (target) => ipcRenderer.invoke('fx:disconnect', target),
  setFxGatewayApiKey: (key) => ipcRenderer.invoke('fx:setGatewayApiKey', key),
  onProviderAuthenticated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('providers:authenticated', listener);
    return () => ipcRenderer.removeListener('providers:authenticated', listener);
  },

  // Orion account
  getAccountSession: () => ipcRenderer.invoke('account:getSession'),
  startAccountAuth: () => ipcRenderer.invoke('account:startAuth'),
  signOutAccount: () => ipcRenderer.invoke('account:signOut'),

  // Orion Cloud repositories
  getCloudState: (projectPath) => ipcRenderer.invoke('cloud:getState', projectPath),
  publishToCloud: (input) => ipcRenderer.invoke('cloud:publish', input),
  pushToCloud: (projectPath) => ipcRenderer.invoke('cloud:push', projectPath),
  pullFromCloud: (projectPath) => ipcRenderer.invoke('cloud:pull', projectPath),
  openCloudRepoInBrowser: (projectPath) => ipcRenderer.invoke('cloud:openInBrowser', projectPath),
  deployToCloud: (projectPath) => ipcRenderer.invoke('cloud:deploy', projectPath),
  getCloudAppState: (projectPath) => ipcRenderer.invoke('cloud:getAppState', projectPath),
  openCloudAppInBrowser: (projectPath) => ipcRenderer.invoke('cloud:openAppInBrowser', projectPath),
  precheckCloudDeploy: (projectPath) => ipcRenderer.invoke('cloud:deployPrecheck', projectPath),
  openExternalUrl: (url) => ipcRenderer.invoke('app:openExternalUrl', url),

  // Linked tasks: Durango Tasks (legacy: the Durango Code web board)
  openBoardTasksWeb: () => ipcRenderer.invoke('tasks:openWeb'),
  listBoardTasks: () => ipcRenderer.invoke('tasks:list'),
  getBoardTask: (taskId) => ipcRenderer.invoke('tasks:get', taskId),
  linkBoardTask: (input) => ipcRenderer.invoke('tasks:link', input),
  unlinkBoardTask: (input) => ipcRenderer.invoke('tasks:unlink', input),
  updateBoardTaskThreadStatus: (input) => ipcRenderer.invoke('tasks:threadStatus', input),

  // Orchestration (Orion pseudo-model subagent spawns)
  reportSubagentResult: (payload) => ipcRenderer.invoke('orchestration:subagentResult', payload),
  onSubagentSpawnRequest: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('orchestration:spawnRequest', listener);
    return () => ipcRenderer.removeListener('orchestration:spawnRequest', listener);
  },
  // request_user_action / resolve_user_action from any agent run.
  onUserAction: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('agent:userAction', listener);
    return () => ipcRenderer.removeListener('agent:userAction', listener);
  },
  reportSubagentStopResult: (payload) =>
    ipcRenderer.invoke('orchestration:subagentStopResult', payload),
  onSubagentStopRequest: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('orchestration:stopRequest', listener);
    return () => ipcRenderer.removeListener('orchestration:stopRequest', listener);
  },

  // Computer use permissions (macOS TCC)
  getComputerUsePermissions: () => ipcRenderer.invoke('computerUse:getPermissions'),
  requestComputerUsePermission: (kind) => ipcRenderer.invoke('computerUse:requestPermission', kind),
  openChromeDebugSetup: () => ipcRenderer.invoke('computerUse:openChromeDebugSetup'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  focusWindow: () => ipcRenderer.invoke('app:focusWindow'),

  // App updates
  getAppUpdateState: () => ipcRenderer.invoke('appUpdate:getState'),
  checkForAppUpdate: (input) => ipcRenderer.invoke('appUpdate:check', input),
  downloadAppUpdate: () => ipcRenderer.invoke('appUpdate:download'),
  restartToUpdate: () => ipcRenderer.invoke('appUpdate:restart'),
  getWhatsNew: () => ipcRenderer.invoke('whatsNew:get'),
  dismissWhatsNew: () => ipcRenderer.invoke('whatsNew:dismiss'),

  // Project assets
  findProjectIcon: (projectPath) => ipcRenderer.invoke('project:findIcon', projectPath),

  // Open project in external apps
  listOpenWithApps: () => ipcRenderer.invoke('openWith:listApps'),
  openProjectWith: (input) => ipcRenderer.invoke('openWith:open', input),

  // Path utils
  basename: (p) => ipcRenderer.invoke('path:basename', p),
  dirname: (p) => ipcRenderer.invoke('path:dirname', p),
  join: (...parts) => ipcRenderer.invoke('path:join', ...parts),

  onAgentTurnEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('agent:turnEvent', listener);
    return () => ipcRenderer.removeListener('agent:turnEvent', listener);
  },

  onFileChange: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('fs:fileChanged', listener);
    return () => ipcRenderer.removeListener('fs:fileChanged', listener);
  },

  onAppUpdateState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('appUpdate:state', listener);
    return () => ipcRenderer.removeListener('appUpdate:state', listener);
  },

  onAccountChanged: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('account:changed', listener);
    return () => ipcRenderer.removeListener('account:changed', listener);
  },

  // Remote control (Settings > Remote Control, sidebar Machines section)
  remoteControlGetState: () => ipcRenderer.invoke('remote:getState'),
  remoteControlConfigure: (settings) => ipcRenderer.invoke('remote:configure', settings),
  remoteStartPairing: () => ipcRenderer.invoke('remote:startPairing'),
  remoteCancelPairing: () => ipcRenderer.invoke('remote:cancelPairing'),
  remoteRevokeDevice: (input) => ipcRenderer.invoke('remote:revokeDevice', input),
  remoteRelayDeregister: () => ipcRenderer.invoke('remote:relayDeregister'),
  remotePair: (input) => ipcRenderer.invoke('remote:pair', input),
  remoteRemoveMachine: (input) => ipcRenderer.invoke('remote:removeMachine', input),
  remoteConnectMachine: (input) => ipcRenderer.invoke('remote:connectMachine', input),
  remoteDisconnectMachine: (input) => ipcRenderer.invoke('remote:disconnectMachine', input),
  remoteFetchSnapshot: (input) => ipcRenderer.invoke('remote:fetchSnapshot', input),
  remoteFetchThread: (input) => ipcRenderer.invoke('remote:fetchThread', input),
  remoteRunTurn: (input) => ipcRenderer.invoke('remote:runTurn', input),
  remoteStopTurn: (input) => ipcRenderer.invoke('remote:stopTurn', input),
  remoteRendererReady: () => ipcRenderer.invoke('remote:rendererReady'),
  remoteClaimCommand: (input) => ipcRenderer.invoke('remote:claimCommand', input),
  reportRemoteCommandResult: (payload) => ipcRenderer.invoke('remote:commandResult', payload),
  onRemoteState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('remote:state', listener);
    return () => ipcRenderer.removeListener('remote:state', listener);
  },
  onRemoteEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('remote:event', listener);
    return () => ipcRenderer.removeListener('remote:event', listener);
  },
  onRemoteCommandRequest: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('remote:commandRequest', listener);
    return () => ipcRenderer.removeListener('remote:commandRequest', listener);
  },

  // Durango Chat (@chat mentions, optional profile memory in instructions)
  durangoSearchChats: (input) => ipcRenderer.invoke('durango:searchChats', input),
  durangoProfileMemory: () => ipcRenderer.invoke('durango:profileMemory'),
  durangoOpenChat: (input) => ipcRenderer.invoke('durango:openChat', input),
  // Durango Tasks backend + Durango Chat dispatch (agents started from chat)
  durangoConfigure: (input) => ipcRenderer.invoke('durango:configure', input),
  durangoDispatchState: () => ipcRenderer.invoke('durango:dispatchState'),
  durangoDispatchSettled: (input) => ipcRenderer.invoke('durango:dispatchSettled', input),
  onDurangoDispatchState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('durango:dispatchState', listener);
    return () => ipcRenderer.removeListener('durango:dispatchState', listener);
  },
  onDurangoFocusThread: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('durango:focusThread', listener);
    return () => ipcRenderer.removeListener('durango:focusThread', listener);
  },

  workspaceSyncConfigure: (settings) => ipcRenderer.invoke('sync:configure', settings),
  workspaceSyncNow: () => ipcRenderer.invoke('sync:now'),
  workspaceSyncGetState: () => ipcRenderer.invoke('sync:getState'),
  onWorkspaceSyncState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('sync:state', listener);
    return () => ipcRenderer.removeListener('sync:state', listener);
  },
});
