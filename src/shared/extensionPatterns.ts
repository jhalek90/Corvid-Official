// Red-flag instruction patterns for the extension scan (#96, docs/EXTENSIONS.md "Safety scanning"). A .corvid file
// becomes instructions to a build agent that can edit Corvid, so these look for wording that would be a red flag in
// a task: overriding instructions, hiding things from the user, sending data out, reading secrets, switching off
// safeguards, persistence, running downloads, obfuscation, git remotes.
//
// THIS LIST IS NOT EXHAUSTIVE. Rewording gets past any fixed list; the classifier, the sandboxed build (#98), the
// diff scan and the user's own review are the later layers. Keep the patterns plain and tested in
// scripts/test-extension-scan.mjs (every pattern has a hit there, and the clean corpus must stay clean).

import type { RiskCategory } from './extensionScan'

export interface RedFlagPattern {
  id: string
  category: RiskCategory
  /** what the user reads next to the cited line */
  label: string
  re: RegExp
}

const W = '[\\w-]*' // the rest of a word: "upload" also catches "uploads", "uploading"

export const RED_FLAG_PATTERNS: RedFlagPattern[] = [
  // ---- instructions that target the build agent itself
  { id: 'ignore-instructions', category: 'targets-agent', label: 'Tells the agent to ignore or override its instructions',
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|earlier|above|all|your|system|safety|the user'?s?|corvid'?s?)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|guidelines?|polic(y|ies)|directions?)\b/i },
  { id: 'new-instructions', category: 'targets-agent', label: 'Claims to replace the agent\'s instructions',
    re: /\b(new|real|actual|updated) (system )?(instructions?|prompt)\b[^.\n]{0,20}\b(are|is|follow)\b|\byou are (now|no longer)\b/i },
  { id: 'address-classifier', category: 'targets-agent', label: 'Speaks to the scanner or classifier',
    re: /\b(classifier|scanner|reviewer|safety (check|scan)|security (check|scan))\b[^.\n]{0,60}\b(should|must|will|mark|rate|report|output|return|ignore|say)\b|\b(mark|rate|classify|report) (this|it)( extension)? as (safe|clear|harmless|benign)\b|\bverdict\b[^.\n]{0,20}\b(clear|safe)\b/i },
  // ---- deceiving the user
  { id: 'hide-from-user', category: 'deception', label: 'Tells the agent to hide something from the user',
    re: /\b(do ?n[o']t|never|without)\b[^.\n]{0,15}\b(tell|telling|inform|informing|notify|notifying|mention|mentioning|show|showing|alert|alerting|ask|asking)(ing)?\b[^.\n]{0,15}\b(the )?(user|owner|wubs|them|anyone)\b|\b(hide|conceal|silently|secretly|quietly|covertly)\b[^.\n]{0,40}\b(from the user|the user|from them|log|output|change|commit|it)\b/i },
  // ---- sending data out
  { id: 'send-data', category: 'exfiltration', label: 'Sends, uploads, posts or syncs data somewhere',
    re: new RegExp(`\\b(send|upload|post|e-?mail|sync|transmit|exfiltrate|forward|beacon|report|ping|phone home)(s|es|ed|ing)?\\b[^.\\n]{0,60}\\b(to|at|into)\\b[^.\\n]{0,40}(https?://|\\b[a-z0-9-]+(\\.[a-z0-9-]+)+\\b|server|endpoint|webhook|remote|address|inbox)`, 'i') },
  { id: 'telemetry', category: 'exfiltration', label: 'Adds telemetry, analytics or tracking',
    re: /\b(telemetry|analytics|tracking pixel|usage stats|crash report(s|ing)? to|beacon)\b/i },
  // ---- reading secrets
  { id: 'read-secrets', category: 'secret-access', label: 'Reads secrets, tokens, keys or credentials',
    re: new RegExp(`\\b(read|open|load|copy|collect|dump|print|cat|grab|access|include|attach|export)${W}\\b[^.\\n]{0,50}\\b(secrets?|tokens?|api[ _-]?keys?|passwords?|credentials?|private keys?|\\.env\\b|keychain|cookies?|ssh keys?|id_rsa|\\.credentials)`, 'i') },
  { id: 'connections-file', category: 'secret-access', label: 'Touches the connections, their store or Corvid\'s data folder',
    re: /\b(connections?\.json|connectors?\/store|remote\/store|safeStorage|userData|appdata[\\/]+roaming[\\/]+corvid|corvid'?s data folder|the data folder|\.claude[\\/]|credentials\.json)/i },
  // the same on macOS and Linux (#161): the data folder under Application Support or ~/.config (and the old names),
  // credential folders, the Keychain and the Secret Service, and /proc files that hold a process's secrets
  { id: 'posix-data-folder', category: 'secret-access', label: 'Touches Corvid\'s data folder on macOS or Linux',
    re: /(library[\\/]+application support|\.config|\.local[\\/]+share|xdg_config_home\}?)[\\/]+(corvid|claude[ _-]?dashboard)\b/i },
  { id: 'posix-secrets', category: 'secret-access', label: 'Reads credential folders, the Keychain or the keyring on macOS or Linux',
    re: /(~|\$\{?HOME\}?)[\\/]+\.(ssh|aws|gnupg|kube|docker|netrc|git-credentials|npmrc|pypirc)\b|\.config[\\/]+(gcloud|gh|op|doctl)\b|\.aws[\\/]+credentials\b|library[\\/]+keychains\b|\blogin\.keychain|\bsecurity\s+(find|dump)-(generic|internet)-password\b|\bsecurity\s+dump-keychain\b|\bsecret-tool\s+(lookup|search|store|clear)\b|\bkwallet-query\b|\bkeyring\s+(get|set)\b|\/proc\/(self|\d+|\$\w+)\/(environ|mem|maps|fd|cmdline)\b/i },
  // ---- switching off safeguards
  { id: 'disable-safeguards', category: 'disabling-safeguards', label: 'Disables or bypasses approvals, safety levels, deny rules, scanning or backups',
    re: new RegExp(`\\b(disable|turn${W} off|switch${W} off|remove|bypass|skip|weaken|loosen|auto-?approve|circumvent|short-?circuit|neuter)${W}\\b[^.\\n]{0,50}\\b(approvals?|approve writes|strict mode|safety levels?|deny rules?|deny list|secret scan${W}|scann${W}|backups?|rollback|usage (limit|gate)s?|worker limits?|guards?|permission prompts?|confirmations?)\\b`, 'i') },
  { id: 'deploy-script', category: 'auto-deploy', label: 'Changes the deploy script or the rollback, or deploys by itself',
    re: /\b(deploy\.mjs|scripts\/deploy|ev\.mjs|the deploy script|the rollback|npm run deploy|auto-?deploy|deploy (it )?automatically|restart corvid (on its own|automatically))\b/i },
  // ---- persistence
  { id: 'persistence', category: 'persistence', label: 'Adds start-up or scheduled tasks',
    re: /\b(startup folder|start-?up (task|item|entry)|run at (login|startup|boot)|scheduled task|schtasks|task scheduler|crontab|cron job|launchd|systemd|registry run key|HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run|setLoginItemSettings)/i },
  { id: 'posix-persistence', category: 'persistence', label: 'Adds start-up items on macOS or Linux (launchd, systemd, cron, autostart, shell profiles)',
    re: /\bLaunch(Agents|Daemons)\b|\blaunchctl\b|\blogin items?\b|\bsystemctl\s+(--user\s+)?(enable|start|link|daemon-reload)\b|\bsystemd\s+(--user\s+)?(user\s+)?(unit|service|timer)s?\b|\.config[\\/]+(autostart|systemd)\b|\bautostart (entry|folder|file|desktop file)\b|\bcron\.(d|daily|hourly|weekly)\b|\/etc\/(crontab|cron|systemd|init\.d|rc\.local|profile|environment|ld\.so\.preload)\b|(^|[\s'"`~\\/(])\.(bashrc|zshrc|bash_profile|bash_login|zprofile|zshenv|zlogin|profile|xprofile|xinitrc)\b|\b(bash|zsh|shell) (profile|rc file|startup file)s?\b/i },
  // ---- running things
  { id: 'download-run', category: 'destructive', label: 'Downloads and runs something',
    re: new RegExp(`\\b(download|fetch|curl|wget|invoke-webrequest|iwr)${W}\\b[^\\n]{0,80}?\\b(run|execute|exec|install|launch|start|pipe)${W}\\b|\\b(curl|wget|iwr|irm)\\b[^\\n]{0,80}\\|\\s*(sh|bash|zsh|iex|invoke-expression|powershell|node|python)\\b`, 'i') },
  { id: 'posix-download-run', category: 'destructive', label: 'Downloads and runs a script (through sudo, process substitution or $(curl ...))',
    re: /\b(curl|wget|fetch)\b[^\n]{0,80}\|\s*sudo\s+(-\S+\s+)*(sh|bash|zsh|dash|ksh|fish|python3?|node|perl|ruby)\b|\b(curl|wget)\b[^\n]{0,80}\|\s*(dash|ksh|fish|python3|perl|ruby)\b|\b(sh|bash|zsh|source)\s+<\(\s*(curl|wget)\b|\$\(\s*(curl|wget)\b|`\s*(curl|wget)\b[^`\n]*`/i },
  { id: 'make-executable', category: 'destructive', label: 'Makes a file executable (chmod +x)',
    re: /\bchmod\s+(-[a-zA-Z]+\s+)*([ugoa]*\+[rwXst]*x|[0-7]*[1357][0-7]*)(\s|$)/ },
  { id: 'system-write', category: 'destructive', label: 'Writes to system folders or runs as root (/etc, /usr, /bin, sudo)',
    re: /(>{1,2}|\btee\s+(-a\s+)?|\b(cp|mv|install|ln|rsync)\s+[^\n]{0,60}?\s)\s*\/(etc|usr|bin|sbin|lib|lib64|boot|opt|System|Library)\/|\b(write|edit|modify|change|append|put|copy|install|place|drop)\w*\b[^.\n]{0,40}\s\/(etc|usr|bin|sbin|System|Library)\/|\bsudo\s+(-\S+\s+)*[a-z]/i },
  { id: 'install-script', category: 'persistence', label: 'Adds an install script (postinstall and similar)',
    re: /\b(postinstall|preinstall|prepare script|install script|lifecycle script|"install"\s*:)/i },
  { id: 'dynamic-code', category: 'obfuscation', label: 'Uses eval or dynamic code',
    re: /\b(eval\s*\(|new Function\s*\(|Function\s*\(\s*['"`]|vm\.run|runInNewContext|child_process|execSync|spawnSync|invoke-expression|\biex\b|dynamic(ally)? (import|load|execute|run)\w*)/i },
  { id: 'encoded-command', category: 'obfuscation', label: 'Uses an encoded command',
    re: /(powershell(\.exe)?[^\n]{0,30}\s-(e|en|enc|encodedcommand)\b|base64\s+(-d|--decode)|frombase64string|atob\s*\(|certutil[^\n]{0,20}-decode|\bxxd\s+-r)/i },
  { id: 'posix-scripting', category: 'obfuscation', label: 'Runs AppleScript or decodes a payload straight into a shell',
    re: /\bosascript\b|\bdo shell script\b|\bbase64\s+(-d|-D|--decode)\b[^\n]{0,40}\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|perl)\b|\bopenssl\s+(enc\s+[^\n]{0,30}-d|base64\s+-d)\b/i },
  { id: 'reverse-shell', category: 'exfiltration', label: 'Opens a network connection from the shell (/dev/tcp, nc -e)',
    re: /\/dev\/(tcp|udp)\/|\b(nc|ncat|netcat)\s+(-\S+\s+)*-[a-z]*e\b|\bmkfifo\b[^\n]{0,60}\b(nc|ncat|netcat)\b/i },
  { id: 'destructive', category: 'destructive', label: 'Deletes or wipes data',
    re: /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/[sfq]|format c:|wipe|delete (all|every|the whole)|drop table|truncate (all|the))\b/i },
  // ---- git
  { id: 'git-remote', category: 'exfiltration', label: 'Changes git remotes or pushes somewhere new',
    re: /\b(git remote (add|set-url|rename)|add (a|another|new) remote|push (to|the code to) (a |another |new |my )|git push\s+(https?:|git@|--mirror|-f\b|--force))/i }
]
