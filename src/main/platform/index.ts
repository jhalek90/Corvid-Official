// The platform layer (#149, part of #142's De-Windows work). Everything that differs between Windows, macOS
// and Linux lives behind these functions, and each takes the platform as its last argument (default
// process.platform) so scripts/test-platform.mjs can run every branch on any machine. See docs/PLATFORM.md.

export { PLATFORMS, platformOf, notYet, appDataDir, dataDirCandidates, realDataDir, installProfile, installOf, nativeDeps, electronNeedsDownload, ELECTRON_INSTALLER, gitInstallHint, desktopEntryText, autostartEntryPath } from './shared.mjs'
export type { Platform, InstallProfile } from './shared.mjs'
export { toNative, pathKey, within, absRule, tempDirs } from './paths'
export { claudeLocations, findClaude, cmpVersion, type ClaudeLocations, type ClaudeProbe } from './claude'
export { loadLoginEnv, loginEnvReady, loginEnvApplied, parseEnvOutput, mergePath, loginEnvChanges } from './loginEnv'
export { shellCandidates, shellList, projectShell, loginEnv, onPath, type ShellDef } from './shells'
export { killTree, killTreeCommand, listProcessesCommand, parseProcessList, psTreeCommand, parsePsTree, treeOf, posixKillPlan, type PsEntry } from './process'
export { loginItemKind, badgeKind, trayImage, externalTerminal, vscodeCommand, voiceSupported, voiceStatusOf } from './os'
export { shQuote, findTerminal, terminalAvailable, terminalScript, vscodeFileUri, LINUX_TERMINALS, VSCODE_BUNDLE_ID } from './os'
export { titleBarKind, titleBarOptions, restylesOverlay, needsYouBadge, usesAppUserModelId, TRAFFIC_LIGHTS, type NeedsYouBadge } from './window'
export { applyAutostart, isWayland, hotkeyFeature, parseHasOwner, hasTray, closeAction, hiddenStartAction, trayClicks, type AutostartFs } from './desktop'
export { secretStorageStatus, secretReadError, LINUX_KEYRINGS, NO_KEYRING, NO_SECURE_STORAGE, type SafeStorageLike } from './keyring'
export { platformInfo, shortcutLabel, VOICE_UNAVAILABLE, titleBarArg, titleBarFromArgv, type PlatformInfo, type TitleBarKind } from '@shared/platformInfo'
