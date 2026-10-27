import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { ExtensionSettings } from './ExtensionSockets'
import { AppWindow, Bot, Check, Gauge, GitBranch, HardDrive, MessageSquare, Palette, Puzzle, ShieldCheck, TriangleAlert, User, Users, type LucideIcon } from 'lucide-react'
import { CLOSE_FINISHED_MAX, type AgentGitMode, type AppConfig, type ClaudePathCheck, type AssistantModel, type AssistantPersonality, type ResumeMentioned, type WorkerModel } from '@shared/types'
import { THEMES, extensionThemes, themeTokens, type ThemeDef, type ThemeKind } from '@shared/themes'
import { useThemeExtensions } from '../extensionSockets'
import { workerModelLabel } from '../components/Assistant'
import { EffortOptions, ModelOptions } from '../components/ModelOptions'
import type { ReasoningEffortSetting } from '@shared/reasoningEffort'
import { CrowEditor } from '../components/CrowEditor'
import { ProfilePicture } from '../components/ProfilePicture'
import { AgentDenyList } from '../components/AgentDenyList'
import { AGENT_PING_RANGES, WAKE_WARNING, type AgentPingLimits, type AgentPingStats } from '@shared/agentPings'
import { AUTO_RESUMES_PER_HOUR, INVOKES_PER_HOUR, KEEP_DAYS_MAX, KEEP_DAYS_MIN } from '@shared/board'
import { BOARD_VOICE_IDS, BOARD_VOICES, CUSTOM_VOICE_MAX, type BoardVoice } from '@shared/boardVoice'
import type { WelcomeMode } from '@shared/welcome'
import { slugify } from '@shared/docs'
import { LearnMore } from './DocsView'
import { baseName, projectKey, projectPath } from '@shared/projects'
import { checkUserName, USER_NAME_DEFAULT, USER_NAME_MAX } from '@shared/userName'
import { CONFIRM_WORKERS_ABOVE, HARD_MAX_WORKERS, SUGGESTED_WORKERS, WORKER_MINUTES } from '@shared/workerLimits'
import { pickTheme, setAgentBirds, setCrow, setFollowSystem, setState, toast } from '../store'
import { resetLayout } from '../layout'
import { AUTO_PANES, MIN_SPLIT, defaultLayout } from '../panes'
import { api } from '../api'
import { useStore } from '../store'
import { InfoTip, SettingLabel } from '../components/Tooltip'
import { shortCommit, useCorvidStatus } from './CorvidPanel'
import { UpdateCheckSetting } from '../components/UpdateBanner'
import { SecretStorageNotice, useSecretStorage } from '../components/RemoteSystems'
import { clickLabel, keyLabel, platform } from '../keys'
import { WAYLAND_HOTKEY, loginItemText, noTrayText } from '@shared/platformInfo'
import type { DesktopInfo } from '@shared/types'

export function SettingsView(): ReactNode {
  const storage = useSecretStorage()
  const config = useStore((s) => s.config)
  const sessions = useStore((s) => s.sessions)
  const progress = useStore((s) => s.progress)
  const claudeDefault = useStore((s) => s.claudeDefaultModel)
  const [hotkey, setHotkey] = useState(config?.hotkey ?? '')
  // what the desktop offers (#158): a tray to close to, and a notification daemon (Linux may have neither)
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null)
  useEffect(() => void api.desktopInfo().then(setDesktop), [])
  const login = loginItemText(platform.os, desktop?.tray ?? true)
  const noTray = noTrayText(platform.os, desktop?.tray ?? true)
  const [allGitOverrides, setAllGitOverrides] = useState(false)
  const [innerRef, cols] = useColumns()

  const projects = useMemo(() => {
    const m = new Map<string, { cwd: string; name: string; n: number }>()
    for (const s of Object.values(sessions)) {
      if (!s.cwd) continue
      const cwd = projectPath(s.cwd)
      const k = cwd.toLowerCase()
      const p = m.get(k) ?? { cwd, name: baseName(cwd), n: 0 }
      p.n++
      m.set(k, p)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [sessions])

  if (!config) return null
  const set = (patch: Parameters<typeof api.setConfig>[0]): void => void api.setConfig(patch)
  const setGitOverride = (cwd: string, mode: AgentGitMode | ''): void => {
    const { [projectKey(cwd)]: _, ...rest } = config.agentGitOverrides
    set({ agentGitOverrides: mode ? { ...rest, [projectKey(cwd)]: mode } : rest })
  }
  // only the projects with an override unless asked for all, so the page doesn't end in a list of every folder
  const gitRows = allGitOverrides ? projects : projects.filter((p) => config.agentGitOverrides[projectKey(p.cwd)])

  // #146: the settings grouped by what they do, in this reading order; weight is a rough height, for the columns
  const groups: Group[] = [
    {
      id: 'corvid',
      title: 'Corvid and models',
      icon: Bot,
      weight: 4,
      tip: `The assistant you talk to on the message board (${keyLabel('J')}): a message with no @mention, or @corvid. Runs your own Claude Code (claude) on your subscription. The limits on this page are enforced by the dashboard itself; Corvid can't change them.`,
      body: (
        <>
          <LimitRow label="Model" tip="The model Corvid itself runs on. Haiku is cheapest for chat and routing; Fable costs the most.">
            <select className="select" value={config.assistantModel} onChange={(e) => set({ assistantModel: e.target.value as AssistantModel })}>
              <ModelOptions />
            </select>
          </LimitRow>
          <LimitRow label="Effort" tip="How hard Corvid thinks before it answers (Claude Code's --effort). Higher is slower and uses more of your usage. Claude Code default passes nothing. A change applies from Corvid's next session, like a model change; the conversation carries over.">
            <select className="select" value={config.assistantEffort} onChange={(e) => set({ assistantEffort: e.target.value as ReasoningEffortSetting })}>
              <EffortOptions />
            </select>
          </LimitRow>
          <LimitRow label="Personality" tip="Tone of replies; applies from your next message.">
            <select className="select" value={config.assistantPersonality} onChange={(e) => set({ assistantPersonality: e.target.value as AssistantPersonality })}>
              <option value="default">Default</option>
              <option value="strict">Strict</option>
              <option value="casual">Casual</option>
            </select>
          </LimitRow>
          <LimitRow label="Worker model" tip="The model new workers run on.">
            <select className="select" value={config.workerModel} onChange={(e) => set({ workerModel: e.target.value as WorkerModel })}>
              <option value="default">{workerModelLabel('default', claudeDefault)}</option>
              <ModelOptions />
            </select>
          </LimitRow>
          <LimitRow label="Worker effort" tip="How hard new workers think (Claude Code's --effort). Higher is slower and uses more of your usage. Claude Code default passes nothing. Applies to workers started from now on; running ones keep theirs.">
            <select className="select" value={config.workerEffort} onChange={(e) => set({ workerEffort: e.target.value as ReasoningEffortSetting })}>
              <EffortOptions />
            </select>
          </LimitRow>
          <div className="setting">
            <SettingLabel label="Untagged messages go to Corvid" tip={"A message without an @mention goes to Corvid, and a reply to an agent's message goes to that agent. Choose Board only under the message box to post without waking Corvid. Each message to Corvid uses some of your Claude usage. Off, only @corvid reaches it. Agents' posts never wake it."} />
            <div className={`toggle${config.untaggedToCorvid ? ' on' : ''}`} onClick={() => set({ untaggedToCorvid: !config.untaggedToCorvid })} />
          </div>
        </>
      ),
    },
    {
      id: 'agents',
      title: 'Agents and workers',
      icon: Users,
      weight: 7,
      body: (
        <>
          <WorkerLimit config={config} />
          <LimitRow label="Worker time limit" hint="min" tip="Minutes of work, not counting sleep or waiting for you. The worker is warned 5 minutes before.">
            <NumberInput value={config.limits.workerMinutes} min={WORKER_MINUTES.min} max={WORKER_MINUTES.max} onChange={(v) => set({ limits: { ...config.limits, workerMinutes: v } })} />
          </LimitRow>
          <LimitRow
            label="Close finished agents after"
            tip="Minutes idle, once an agent has posted its done post and nothing needs you. Closing frees up the agent limit; mention a closed agent on the board to bring it back."
          >
            <select className="select" value={config.closeFinishedMinutes} onChange={(e) => set({ closeFinishedMinutes: Number(e.target.value) })}>
              {[...new Set([0, ...CLOSE_FINISHED_CHOICES, config.closeFinishedMinutes])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? 'Off' : `${m} min`}
                  </option>
                ))}
            </select>
          </LimitRow>
          <div className="setting">
            <SettingLabel
              label="Agents may suggest Corvid improvements"
              tip={'An agent on another project may end its done post with one line starting "Corvid could:", only when Corvid got in its way during the task. At most one per task; it never makes a task of it or works on it. Corvid collects the lines in the note "Corvid could: suggestions from agents" and raises them only when you ask. Off, agents are told not to suggest Corvid changes. Applies to agents started after a change.'}
            />
            <div className={`toggle${config.agentSuggestions !== false ? ' on' : ''}`} onClick={() => set({ agentSuggestions: config.agentSuggestions === false })} />
          </div>
          <div className="setting">
            <SettingLabel label="Tagging an agent wakes it" tip={`When you @mention a running agent on the board, Corvid types a short "Board: ..." message into its terminal so it answers now instead of at its next check. Only when it's idle: a busy agent gets it after its turn, one on a permission prompt after you answer. Only messages you type do this. At most ${INVOKES_PER_HOUR} wake-ups per agent an hour, and @all only wakes idle agents. Waking an agent uses usage.`} />
            <div className={`toggle${config.wakeTagged ? ' on' : ''}`} onClick={() => set({ wakeTagged: !config.wakeTagged })} />
          </div>
          <div className="setting">
            <SettingLabel label="Resume mentioned agents" tip={`When you @mention an agent that has ended, bring it back in its own Claude session, on its task branch, so it can answer. Only messages you type do this. It counts as a worker for the limits and its time limit starts again. Ask first shows a Resume button on your message instead. At most ${AUTO_RESUMES_PER_HOUR} automatic resumes an hour, then it asks. Resuming uses usage like any worker.`} />
            <select className="select" value={config.resumeMentioned} onChange={(e) => set({ resumeMentioned: e.target.value as ResumeMentioned })}>
              <option value="auto">Automatically</option>
              <option value="ask">Ask first</option>
              <option value="off">Off</option>
            </select>
          </div>
          <AgentPingSettings config={config} />
          <div className="setting">
            <SettingLabel label="Goofy agent names" tip={"Each agent the dashboard starts gets a made-up job title that fits its task, like “Senior Pixel Plumber”, with the task number and title underneath. The same task keeps its name. Off, agents get a short plain name like “Text Selector Agent”. Running agents keep theirs."} />
            <div className={`toggle${config.goofyNames ? ' on' : ''}`} onClick={() => set({ goofyNames: !config.goofyNames })} />
          </div>
        </>
      ),
    },
    {
      id: 'usage',
      title: 'Usage limits',
      icon: Gauge,
      weight: 5,
      body: (
        <>
          <UsageLimit config={config} />
          <div className="setting">
            <SettingLabel label="Quota refresh" tip={"How often to run claude /usage. Uses no tokens and writes no transcript."} />
            <select className="select" value={config.usagePollSec} onChange={(e) => set({ usagePollSec: Number(e.target.value) })}>
              {[60, 120, 180, 300, 600].map((s) => (
                <option key={s} value={s}>
                  every {s / 60} min
                </option>
              ))}
            </select>
          </div>
        </>
      ),
    },
    {
      id: 'git',
      title: 'Git and branches',
      icon: GitBranch,
      weight: 4,
      body: (
        <>
          <div className="setting">
            <SettingLabel label="Agent git workflow" tip={"Feature branches: a worker that changes files gets its own branch, task-<id>-<title>, in its own worktree next to the project (<project>-worktrees), so several can work in one repo at once. When its checks pass, the dashboard merges it into main (or master) with a merge commit. Conflicts, failed checks and uncommitted work on main stop the merge and leave the branch for you.\nCurrent branch: commits land wherever the folder is.\nProjects can override this below. Running workers are not affected."} />
            <select className="select" value={config.agentGit} onChange={(e) => set({ agentGit: e.target.value as AgentGitMode })}>
              <option value="branches">Feature branches</option>
              <option value="current">Work on the current branch</option>
            </select>
          </div>
          <div className="setting">
            <SettingLabel label="Push after merge" tip={"After a worker's branch is merged, push the default branch to its upstream. Never forced; a failed push leaves the merge local."} />
            <div className={`toggle${config.pushAfterMerge ? ' on' : ''}`} onClick={() => set({ pushAfterMerge: !config.pushAfterMerge })} />
          </div>
          <div className="git-overrides">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <div style={{ flex: 1 }}>Per project</div>
              {projects.length > 0 && (
                <button className="btn sm" onClick={() => setAllGitOverrides((v) => !v)}>
                  {allGitOverrides ? 'Show only overrides' : `Show all ${projects.length}`}
                </button>
              )}
            </div>
            <div className="d muted" style={{ fontSize: 12, marginBottom: gitRows.length ? 12 : 0 }}>
              {!allGitOverrides && !gitRows.length ? 'No project overrides it.' : 'Overrides Agent git workflow for that project.'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {gitRows.map((p) => (
                <div key={p.cwd} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 12px' }}>
                  <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                    <span>{p.name}</span> <span className="muted mono" style={{ fontSize: 11 }}>{p.cwd}</span>
                  </div>
                  <select
                    className="select"
                    title="Agent git workflow for this project"
                    value={config.agentGitOverrides[projectKey(p.cwd)] ?? ''}
                    onChange={(e) => setGitOverride(p.cwd, e.target.value as AgentGitMode | '')}
                  >
                    <option value="">Git: as set above</option>
                    <option value="branches">Git: feature branches</option>
                    <option value="current">Git: current branch</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        </>
      ),
    },
    {
      id: 'board',
      title: 'Board and notifications',
      icon: MessageSquare,
      weight: 6,
      body: (
        <>
          <BoardVoiceSetting config={config} />
          <div className="setting">
            <SettingLabel label="Welcome message" tip={"Corvid says hello on the board when you open the app, at most once every 4 hours and never after a restart, deploy or crash. With a quick status it adds what's new: finished agents, agents that need you, tasks in Doing, waiting approvals. It follows the Board voice and costs no usage."} />
            <select className="select" value={config.welcomeMessage} onChange={(e) => set({ welcomeMessage: e.target.value as WelcomeMode })}>
              <option value="off">Off</option>
              <option value="short">Short</option>
              <option value="status">With a quick status</option>
            </select>
          </div>
          <div className="setting">
            <SettingLabel label="Format messages" tip={"Show agents' and Corvid's messages with light structure: paragraphs, lists, bold, code, picked-out references, paths and status words, and long messages folded behind Show more. Your own messages stay plain, and copying or saving a message gives the exact text."} />
            <div className={`toggle${config.formatMessages ? ' on' : ''}`} onClick={() => set({ formatMessages: !config.formatMessages })} />
          </div>
          <div className="setting">
            <SettingLabel label="Show suggestion chips under the message box" tip={"With an empty box, up to four chips suggest a question for Corvid from what's going on: an agent's question you haven't answered, a running or just-finished worker, the project of the channel you're in, a pile in Done, or a usage bar past 60%. On an empty board they show how to start. Off hides the row."} />
            <div className={`toggle${config.boardChips !== false ? ' on' : ''}`} onClick={() => set({ boardChips: config.boardChips === false })} />
          </div>
          <div className="setting">
            <SettingLabel label="Keep messages for" tip={`Main chat messages expire after ${config.boardKeepDays} days and stay on this PC. Choose 7 to 30; they're removed when Corvid starts and about once a day while it runs. Notes saved from messages never expire.`} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' }}>
              <NumberInput value={config.boardKeepDays} min={KEEP_DAYS_MIN} max={KEEP_DAYS_MAX} onChange={(v) => set({ boardKeepDays: v })} />
              <span className="muted">days</span>
            </span>
          </div>
          {desktop?.notifications !== false && (
            <div className="setting">
              <SettingLabel label="Notifications" tip={"Toast when a session finishes or needs you while Corvid isn't focused."} />
              <div className={`toggle${config.notifications ? ' on' : ''}`} onClick={() => set({ notifications: !config.notifications })} />
            </div>
          )}
          <div className="setting">
            <SettingLabel label="Offer tours" tip={"Guided tours: the crow shows you around. Off hides the first-run offer and the board's Show me around chip; every tour stays in Docs."} />
            <div className={`toggle${config.offerTours !== false ? ' on' : ''}`} onClick={() => set({ offerTours: config.offerTours === false })} />
          </div>
          <div className="setting">
            <SettingLabel label="Live ticker" tip={"A slim bar along the bottom with the latest action across your sessions and agents, and who needs you. It holds still under the pointer and while Corvid isn't focused. Click it for the last 3 hours."} />
            <div className={`toggle${config.ticker !== false ? ' on' : ''}`} onClick={() => set({ ticker: config.ticker === false })} />
          </div>
        </>
      ),
    },
    {
      id: 'appearance',
      title: 'Appearance',
      icon: Palette,
      weight: 15,
      body: (
        <>
          <Appearance config={config} />
          <div className="setting">
            <SettingLabel label="Crow" tip={"A small crow that perches on the app and flies about now and then, and Corvid's avatar on the board. Click it to shoo it, right-click to hide it. Off, the avatar is a plain orb. Both sit still when the system's animations are turned off (reduced motion)."} />
            <div className={`toggle${config.crow ? ' on' : ''}`} onClick={() => setCrow(!config.crow)} />
          </div>
          <div className="setting">
            <SettingLabel label="Agent birds" tip={"Each running agent gets its own small crow in its avatar's look. It flies in when the agent starts, stays near its card and flies off when it stops. Hover a bird for its name, click to shoo, double-click to go to the card, right-click to hide them all. At most 8 at once. The Crow switch turns them off too."} />
            <div
              className={`toggle${config.crow && config.agentBirds !== false ? ' on' : ''}${config.crow ? '' : ' disabled'}`}
              title={config.crow ? undefined : 'Turn the Crow on first'}
              onClick={() => config.crow && setAgentBirds(config.agentBirds === false)}
            />
          </div>
          <div className="setting">
            <SettingLabel label="Random agent avatars" tip={"Each agent gets its own crow, picked at random from the Crow look options, beside its name on the board and its card. The same task keeps its crow and no two running agents look alike. Your own crow look stays Corvid's. Off, every agent shows the plain crow."} />
            <div className={`toggle${config.agentAvatars ? ' on' : ''}`} onClick={() => set({ agentAvatars: !config.agentAvatars })} />
          </div>
          <CrowEditor />
        </>
      ),
    },
    {
      id: 'profile',
      title: 'Profile',
      icon: User,
      weight: 2.5,
      body: (
        <>
          <UserNameSetting config={config} />
          <ProfilePicture />
        </>
      ),
    },
    {
      id: 'window',
      title: 'Window and layout',
      icon: AppWindow,
      weight: 4,
      body: (
        <>
          <div className="setting">
            <SettingLabel label="Open new views in" tip={`A view, task, note or agent terminal that isn't open yet gets its own pane, split off the focused (or largest) one while there's room: up to ${AUTO_PANES} panes of at least ${MIN_SPLIT.w}×${MIN_SPLIT.h} px. Past that, or in a narrow window, it opens as a tab. ${clickLabel} (or middle-click a rail icon) to open it the other way once.`} />
            <div className="seg">
              <button className={config.openViews !== 'tab' ? 'on' : ''} onClick={() => set({ openViews: 'split' })}>
                A new pane
              </button>
              <button className={config.openViews === 'tab' ? 'on' : ''} onClick={() => set({ openViews: 'tab' })}>
                A new tab
              </button>
            </div>
          </div>
          <div className="setting">
            <SettingLabel label="Layout" tip={"Drag the edge of the explorer, preview or terminal to resize it; double-click an edge to reset it. Split the main area with the buttons on a pane's tab strip (or Shift-click a rail icon), and drag tabs between panes. The arrangement is kept between launches."} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, flex: 'none' }}>
              <button
                className="btn"
                onClick={() => {
                  resetLayout()
                  toast('Pane sizes reset')
                }}
              >
                Reset sizes
              </button>
              <button
                className="btn"
                onClick={() => {
                  setState({ layout: defaultLayout('settings') })
                  toast('Panes reset to a single pane')
                }}
              >
                Reset panes
              </button>
            </div>
          </div>
          <div className="setting">
            <SettingLabel label={login.label} tip={login.tip} />
            <div className={`toggle${config.openAtLogin ? ' on' : ''}`} onClick={() => set({ openAtLogin: !config.openAtLogin })} />
          </div>
          {noTray && (
            <div className="setting">
              <SettingLabel label="No system tray" tip={noTray} />
              <span className="muted">Closing the window quits</span>
            </div>
          )}
          <div className="setting">
            <SettingLabel label="Global hotkey" tip={HOTKEY_TIP} />
            <input
              className="text mono"
              spellCheck={false}
              aria-label="Global hotkey"
              value={hotkey}
              onChange={(e) => setHotkey(e.target.value)}
              onBlur={() => hotkey !== config.hotkey && set({ hotkey })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </div>
        </>
      ),
    },
    {
      id: 'connections',
      title: 'Connections and safety',
      icon: ShieldCheck,
      weight: 10,
      body: (
        <>
          <div className="setting">
            <SettingLabel label="Connections" tip={`Servers, APIs and databases agents can reach, their secrets, approvals and the kill switch live in the Connections tab (${keyLabel('7')}).`} />
            <button className="btn sm" style={{ flex: 'none' }} onClick={() => setState({ view: 'connections', connectionsFocus: { area: 'connections' } })}>
              Open Connections
            </button>
          </div>
          <div className="setting">
            <SettingLabel label="Agents can propose connectors" tip={"An agent that needs a service with no connector can draft one: data only, never code. A draft does nothing until you approve it under Connections → Proposals, and agents can never create connections or enter secrets. Applies to agents started after a change."} />
            <div className={`toggle${config.agentDrafts !== false ? ' on' : ''}`} onClick={() => set({ agentDrafts: config.agentDrafts === false })} />
          </div>
          <div className="setting">
            <SettingLabel label="Connector page size" tip={"A result longer than this comes back to the agent one page at a time, in thousands of characters (4 to 22, default 20). The rest is held in memory for 10 minutes, for that agent only, never on disk. Smaller pages cost less per read."} />
            <NumberInput value={Math.round((config.connectorPageChars ?? 20_000) / 1000)} min={4} max={22} onChange={(v) => set({ connectorPageChars: v * 1000 })} />
          </div>
          <div className="setting">
            <SettingLabel label="Secret storage" tip={"Connection secrets and SSH passwords are encrypted with the system's secure storage: Windows data protection, the macOS Keychain, or a keyring (GNOME Keyring or KWallet) on Linux. Without one Corvid refuses to save secrets rather than keep them in plain text."} />
            <span className="muted" style={{ flex: 'none', fontSize: 12, color: storage.available ? undefined : 'var(--warn)' }}>
              {storage.available ? 'Available' : 'Not available'}
            </span>
          </div>
          <SecretStorageNotice />
          <AgentDenyList config={config} />
        </>
      ),
    },
    {
      id: 'system',
      title: 'System',
      icon: HardDrive,
      weight: 2,
      body: (
        <>
          <ClaudePathSetting config={config} />
          <div className="setting">
            <div className="setting-label">
              <div>Session index</div>
              <div className="d">
                {Object.keys(sessions).length} sessions indexed{progress.ready ? '' : ` · indexing ${progress.done}/${progress.total}`}
              </div>
            </div>
            <button className="btn sm" onClick={() => void api.refreshIndex()}>
              Rescan
            </button>
          </div>
          <UpdateCheckSetting on={config.updateCheck} set={(on) => set({ updateCheck: on })} />
        </>
      ),
    },
  ]
  const careful: Group = {
    id: 'careful',
    title: 'Rare and destructive',
    icon: TriangleAlert,
    weight: 0,
    tip: 'Actions that replace or remove saved data. Each one asks first.',
    body: (
      <>
        <RestoreBackup />
        <ClearMainChat />
      </>
    ),
  }

  return (
    <div className="settings" data-tour="settings.view">
      <div className="settings-inner" ref={innerRef}>
        <div className="page-head">
          <div>
            <h2>Settings</h2>
            <p>
              Stored in Corvid&apos;s data folder <InfoTip tip="Nothing here touches your Claude Code config." />
            </p>
            <BuildLine />
            <LicenseLine />
          </div>
        </div>

        <nav className="settings-jump" aria-label="Setting groups">
          {[...groups, careful].map((g) => (
            <button key={g.id} className="btn sm ghost" onClick={() => jumpTo(g.id)}>
              {g.title}
            </button>
          ))}
        </nav>

        <div className="settings-cols" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {toColumns(groups, cols).map((col, i) => (
            <div key={i} className="settings-col">
              {col.map((g) => (
                <SettingsGroup key={g.id} g={g} />
              ))}
            </div>
          ))}
        </div>

        <ExtensionSettings />

        <SettingsGroup g={careful} danger />
      </div>
    </div>
  )
}

type Group = { id: string; title: string; icon: LucideIcon; weight: number; tip?: string; body: ReactNode }

/** One group card: a small icon and title, and its rows. */
function SettingsGroup({ g, danger }: { g: Group; danger?: boolean }): ReactNode {
  const Icon = g.icon
  return (
    <section id={`settings-${g.id}`} className={`card settings-group${danger ? ' danger' : ''}`} aria-labelledby={`settings-${g.id}-title`} tabIndex={-1}>
      <h3 className="settings-group-head">
        <Icon size={13} aria-hidden />
        <span id={`settings-${g.id}-title`}>{g.title}</span>
        {g.tip && <InfoTip tip={g.tip} label={g.title} />}
        <LearnMore page={`settings/reference#${slugify(g.title)}`} className="settings-learn" />
      </h3>
      <div className="settings-group-body">{g.body}</div>
    </section>
  )
}

function jumpTo(id: string): void {
  const el = document.getElementById(`settings-${id}`)
  el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  // the next Tab goes into the group
  el?.focus({ preventScroll: true })
}

/** How many columns of cards fit the page's own width (a pane can be narrow in a wide window). */
function useColumns(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [cols, setCols] = useState(1)
  useLayoutEffect(() => {
    if (!el) return
    const fit = (): void => void (el.clientWidth > 0 && setCols(el.clientWidth >= 1100 ? 3 : el.clientWidth >= 720 ? 2 : 1))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, cols]
}

/**
 * Deals the groups into columns in order, each to the column that's shortest so far by weight. Weights are fixed,
 * so a card never jumps columns when a row inside it opens or closes; only a width change moves cards.
 */
function toColumns(groups: Group[], n: number): Group[][] {
  const cols: Group[][] = Array.from({ length: n }, () => [])
  const h = new Array<number>(n).fill(0)
  for (const g of groups) {
    const i = h.indexOf(Math.min(...h))
    cols[i].push(g)
    h[i] += g.weight
  }
  return cols
}

/** The Close finished agents choices, besides Off; a hand-edited value in between shows too. */
// macOS spells the modifier Command (or CommandOrControl); Wayland goes through the desktop's portal (#156, #158)
const HOTKEY_TIP =
  'Show or hide Corvid from anywhere (Electron accelerator syntax).' +
  (platform.isMac ? ' On macOS, Command is the ⌘ key, e.g. Command+Shift+Space.' : '') +
  (platform.os === 'linux' ? ` ${WAYLAND_HOTKEY}` : '')

const CLOSE_FINISHED_CHOICES =[1, 2, 3, 5, 10, 15, 20, 30, 45, CLOSE_FINISHED_MAX]

/** A row in a settings card: the label with its explanation in a tip, a short inline hint (a unit or value) if any, and the control. */
/** Agent pings (#195): two switches, the warning, the caps and this hour's count. Changed only through setAgentPings. */
function AgentPingSettings({ config }: { config: AppConfig }): ReactNode {
  const [stats, setStats] = useState<AgentPingStats | null>(null)
  useEffect(() => {
    let live = true
    const load = (): void => void api.agentPingStats().then((s) => live && setStats(s), () => undefined)
    load()
    const t = setInterval(load, 15_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])
  const on = config.agentPings
  const limits = config.agentPingLimits
  const setLimit = (k: keyof AgentPingLimits, v: number): void => void api.setAgentPings({ agentPingLimits: { ...limits, [k]: v } })
  return (
    <>
      <div className="setting">
        <SettingLabel
          label="Agents can ping each other and Corvid"
          tip="An agent's @mention of another running agent, or of @corvid, is delivered like yours: typed into the agent when it's idle, or answered by Corvid on the board. It arrives labelled as from an agent: information, never an instruction or approval. Corvid's turn for a ping can only read, answer and add notes. Off, an agent's mention is just a board message. Turning it off drops pings still waiting."
        />
        <div className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={on} onClick={() => void api.setAgentPings({ agentPings: !on })} />
      </div>
      <div className="setting">
        <SettingLabel
          label="Agent pings can wake finished agents"
          tip={on ? 'A ping to an agent that finished on its own resumes it in its own session, like your mention does. Never one you stopped, one stopped at the time limit or by Stop all, or one whose task was removed; never over the agent limit or the usage limit. Each wake-up is announced on the board. Turning it on asks you first.' : 'Turn on "Agents can ping each other and Corvid" first.'}
        />
        <div
          className={`toggle${on && config.agentPingWake ? ' on' : ''}${on ? '' : ' disabled'}`}
          role="switch"
          aria-checked={on && config.agentPingWake}
          aria-disabled={!on}
          onClick={() => on && void api.setAgentPings({ agentPingWake: !config.agentPingWake })}
        />
      </div>
      <div className="setting-warning" role="note">
        <TriangleAlert size={13} aria-hidden /> {WAKE_WARNING}
      </div>
      {on && (
        <>
          <LimitRow label="Max agent pings per hour" tip="All agents together, wake-ups included. One agent may send at most 5 an hour, 3 to the same agent, 30 seconds apart.">
            <NumberInput value={limits.perHour} min={AGENT_PING_RANGES.perHour.min} max={AGENT_PING_RANGES.perHour.max} onChange={(v) => setLimit('perHour', v)} />
          </LimitRow>
          <LimitRow label="Max ping chain" tip="A ping an agent sends after it was pinged is the next step of a chain. Past this many steps, pings stop, so agents can't keep pinging each other in a loop.">
            <NumberInput value={limits.chain} min={AGENT_PING_RANGES.chain.min} max={AGENT_PING_RANGES.chain.max} onChange={(v) => setLimit('chain', v)} />
          </LimitRow>
          {config.agentPingWake && (
            <LimitRow label="Max agent wake-ups per hour" tip="Finished agents that pings may wake in any hour, all agents together. Each one uses your plan like any worker.">
              <NumberInput value={limits.wakesPerHour} min={AGENT_PING_RANGES.wakesPerHour.min} max={AGENT_PING_RANGES.wakesPerHour.max} onChange={(v) => setLimit('wakesPerHour', v)} />
            </LimitRow>
          )}
          {stats && (
            <div className="setting-note muted">
              Agent pings this hour: {stats.pings} of {stats.perHour}
              {config.agentPingWake ? `, wake-ups ${stats.wakes} of ${stats.wakesPerHour}` : ''}
            </div>
          )}
        </>
      )}
    </>
  )
}

function LimitRow({ label, hint, tip, children }: { label: string; hint?: string; tip?: string; children: ReactNode }): ReactNode {
  return (
    <div className="setting">
      <div className="setting-name" style={{ flex: 1, minWidth: 0 }}>
        <span data-tip={tip}>{label}</span>
        {tip && <InfoTip tip={tip} label={label} />}
        {hint && (
          <span className="muted" style={{ fontSize: 11.5, marginLeft: 4 }}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

/** The usage limit for new agents (#93): a master switch, each gate with its own switch, and what happens above it. */
function UsageLimit({ config }: { config: AppConfig }): ReactNode {
  const l = config.limits
  const save = (patch: Partial<AppConfig['limits']>): void => void api.setConfig({ limits: { ...l, ...patch } })
  const gate = (label: string, on: boolean, value: number, key: 'gate5h' | 'gateWeek', onKey: 'gate5hOn' | 'gateWeekOn'): ReactNode => (
    <LimitRow label={label} hint={on ? '%' : 'no limit'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {on && <NumberInput value={value} min={5} max={100} onChange={(v) => save({ [key]: v })} />}
        <div className={`toggle${on ? ' on' : ''}`} title={on ? 'Turn this gate off (no limit)' : 'Use this gate'} onClick={() => save({ [onKey]: !on })} />
      </div>
    </LimitRow>
  )
  return (
    <>
      <LimitRow label="Usage limit for new agents" tip="Checked before each new agent starts.">
        <div className={`toggle${l.usageLimit ? ' on' : ''}`} onClick={() => save({ usageLimit: !l.usageLimit })} />
      </LimitRow>
      {l.usageLimit && (
        <>
          {gate('Limit at 5-hour usage', l.gate5hOn, l.gate5h, 'gate5h', 'gate5hOn')}
          {gate('Limit at weekly usage', l.gateWeekOn, l.gateWeek, 'gateWeek', 'gateWeekOn')}
          <LimitRow label="Above the limit" tip="Applies to every way an agent starts.">
            <select className="select" value={l.overLimit} onChange={(e) => save({ overLimit: e.target.value as 'ask' | 'block' })}>
              <option value="ask">Ask me first</option>
              <option value="block">Block new agents</option>
            </select>
          </LimitRow>
        </>
      )}
      <div className="muted settings-note" style={{ fontSize: 11.5 }}>
        {l.usageLimit
          ? "The limit only affects starting new agents: it doesn't stop agents already running. Running into your plan's real limit can stall agents mid-task."
          : "No limit: new agents start whatever your usage. Running into your plan's real limit can stall agents mid-task."}
      </div>
    </>
  )
}

/** Concurrent workers, with the usage warning under it; going above CONFIRM_WORKERS_ABOVE asks once first. */
function WorkerLimit({ config }: { config: AppConfig }): ReactNode {
  const [pending, setPending] = useState<number | null>(null)
  // remounts the field so a declined value goes back to the saved one
  const [reset, setReset] = useState(0)
  const saved = config.limits.maxWorkers
  const n = pending ?? saved
  const save = (v: number, ok?: boolean): void => void api.setConfig({ limits: { ...config.limits, maxWorkers: v }, ...(ok && { manyWorkersOk: true }) })
  const change = (v: number): void => {
    if (v > CONFIRM_WORKERS_ABOVE && !config.manyWorkersOk && v !== saved) return setPending(v)
    setPending(null)
    save(v)
  }
  return (
    <>
      <LimitRow label="Concurrent workers" hint={`suggested ${SUGGESTED_WORKERS}`} tip={`Suggested: ${SUGGESTED_WORKERS}. Allowed: 1 to ${HARD_MAX_WORKERS}.`}>
        <NumberInput key={reset} value={n} min={1} max={HARD_MAX_WORKERS} onChange={change} />
      </LimitRow>
      <div className="worker-warn">
        Each agent is its own Claude session running at the same time, so several agents can use up your 5-hour and weekly usage quickly, and the
        more agents, the faster. The usage limit only affects starting new agents; agents already running keep going until they
        finish, hit the time limit or you stop them.
        {n > SUGGESTED_WORKERS && pending === null && (
          <div className="worker-warn-strong">
            {n} at once is above the suggested {SUGGESTED_WORKERS}. Keep an eye on usage while they run, and stop agents you don&apos;t need.
          </div>
        )}
        {pending !== null && (
          <div className="worker-warn-strong">
            <div>
              Allow up to {pending} agents at once? That many Claude sessions together can use up your 5-hour usage very fast. You&apos;re only asked
              this once.
            </div>
            <div className="actions">
              <button className="btn sm" onClick={() => (setPending(null), save(pending, true))}>
                Allow {pending}
              </button>
              <button className="btn sm ghost" onClick={() => (setPending(null), setReset((r) => r + 1))}>
                Keep {saved}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function NumberInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }): ReactNode {
  const [v, setV] = useState(String(value))
  const commit = (): void => {
    const n = Math.round(Number(v))
    if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)))
    else setV(String(value))
  }
  return (
    <input
      className="text num"
      spellCheck={false}
      style={{ width: 72, height: 28, padding: '0 8px', borderRadius: 7, border: '1px solid var(--line-2)', background: 'var(--bg-2)', outline: 'none', textAlign: 'right' }}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

/** Every agent name the user's name can't take: open workers and terminals, and agents named on the board (as main checks it). */
function useAgentNames(): string[] {
  const workers = useStore((s) => s.assistant.workers)
  const terminals = useStore((s) => s.terminals)
  const messages = useStore((s) => s.board.messages)
  return useMemo(() => {
    const out: string[] = []
    for (const w of workers) if (w.agentName) out.push(w.agentName)
    for (const t of terminals) if (t.agentName && t.exited === undefined) out.push(t.agentName)
    for (const m of messages) {
      if (m.author === 'agent' && m.agentName) out.push(m.agentName)
      for (const t of m.to ?? []) if (t !== 'user' && t !== 'assistant') out.push(t)
    }
    return out
  }, [workers, terminals, messages])
}

/** Your name: how the board, mentions and notes show the user. Only what's typed here, never anything from the machine. */
function UserNameSetting({ config }: { config: AppConfig }): ReactNode {
  const [value, setValue] = useState(config.userName)
  const [error, setError] = useState('')
  const agents = useAgentNames()
  const save = async (): Promise<void> => {
    const r = checkUserName(value, agents)
    if ('error' in r) return setError(r.error)
    setError('')
    setValue(r.name)
    if (r.name === config.userName) return
    try {
      await api.setConfig({ userName: r.name })
      toast(r.name ? `The board calls you ${r.name} now. @user still reaches you.` : 'Back to "user" on the board.')
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  return (
    <div className="setting user-name">
      <div>
        <SettingLabel
          label="Your name"
          tip={`How the message board, @mentions and notes show you. ${config.userName ? `Agents can address you as @${config.userName} or @user.` : 'Agents address you as @user.'} Empty means "user". It stays on this PC.`}
        />
        {error && (
          <div className="d user-name-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <input
        className="text"
        spellCheck={false}
        maxLength={USER_NAME_MAX * 4}
        placeholder={USER_NAME_DEFAULT}
        aria-label="Your name"
        aria-invalid={!!error}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          // say so as soon as it can't work
          const r = checkUserName(e.target.value, agents)
          setError('error' in r ? r.error : '')
        }}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          else if (e.key === 'Escape') {
            setValue(config.userName)
            setError('')
          }
        }}
      />
    </div>
  )
}

/** How agents sound on the board: a preset, or the user's own guide, which can only change tone. */
function BoardVoiceSetting({ config }: { config: AppConfig }): ReactNode {
  const [custom, setCustom] = useState(config.boardVoiceCustom)
  const voice = config.boardVoice
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SettingLabel
            label="Board voice"
            tip={`How agents sound in their board posts: ${BOARD_VOICES[voice].hint}. Only the chat changes; commit messages, notes and anything you approve stay plain, and the board's rules, limits and done posts stay as they are. Applies to workers started after you change it.`}
          />
        </div>
        <select className="select" value={voice} onChange={(e) => void api.setConfig({ boardVoice: e.target.value as BoardVoice })}>
          {BOARD_VOICE_IDS.map((v) => (
            <option key={v} value={v}>
              {BOARD_VOICES[v].label}
            </option>
          ))}
        </select>
      </div>
      {voice === 'custom' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <textarea
            className="task-notes"
            rows={4}
            maxLength={CUSTOM_VOICE_MAX}
            spellCheck
            placeholder="Describe the tone you want, ideally with a few example posts. Empty uses Crow office."
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onBlur={() => custom !== config.boardVoiceCustom && void api.setConfig({ boardVoiceCustom: custom })}
          />
          <span className="muted" style={{ fontSize: 11.5 }}>
            {custom.length} / {CUSTOM_VOICE_MAX}. Tone only: it can&apos;t switch off the board&apos;s safety rules, limits or done posts.
          </span>
        </div>
      )}
    </div>
  )
}

// ---------- appearance ----------

/**
 * The theme picker. Themes come in a light group and a dark group; picking one also makes it that
 * group's pick, which is what Follow system and the title-bar toggle switch between.
 */
function Appearance({ config }: { config: AppConfig }): ReactNode {
  const shown = useStore((s) => s.theme)
  const follow = config.themeFollowSystem
  return (
    <div className="appearance">
      <div className="appearance-head">
        <SettingLabel
          label="Theme"
          tip={
            follow
              ? 'Uses your light pick while the system is in light mode and your dark pick in dark mode.'
              : 'The sun/moon button in the title bar swaps between your light pick and your dark pick.'
          }
        />
        <div className="seg">
          <button className={follow ? '' : 'on'} onClick={() => follow && setFollowSystem(false)}>
            One theme
          </button>
          <button className={follow ? 'on' : ''} onClick={() => !follow && setFollowSystem(true)}>
            Follow system
          </button>
        </div>
      </div>
      {(['dark', 'light'] as ThemeKind[]).map((kind) => {
        const pick = kind === 'light' ? config.themeLight : config.themeDark
        return (
          <div key={kind}>
            <div className="theme-group-label">{kind === 'dark' ? 'Dark' : 'Light'}</div>
            <div className="theme-grid" role="radiogroup" aria-label={`${kind === 'dark' ? 'Dark' : 'Light'} themes`}>
              {THEMES.filter((t) => t.kind === kind).map((t) => (
                <ThemeCard key={t.id} t={t} on={follow ? pick === t.id : config.theme === t.id} showing={shown === t.id} pick={pick === t.id} />
              ))}
            </div>
          </div>
        )
      })}
      <ExtensionThemes config={config} shown={shown} />
    </div>
  )
}

/**
 * Themes from extensions (#114), grouped by the extension that adds them, with the same swatch, a marker, any
 * readability warning, and a link to the extension in the Extensions tab. They take part in Follow system and the
 * toggle as their kind's pick, like the built-in ones.
 */
function ExtensionThemes({ config, shown }: { config: AppConfig; shown: string }): ReactNode {
  useThemeExtensions()
  const list = extensionThemes()
  if (!list.length) return null
  const follow = config.themeFollowSystem
  const owners = [...new Set(list.map((t) => t.ext!.owner))]
  const open = (owner: string): void => {
    setState({ view: 'extensions' })
    setTimeout(() => document.getElementById(`ext-socket-${owner}`)?.scrollIntoView({ block: 'center' }), 80)
  }
  return (
    <div>
      <div className="theme-group-label">From extensions</div>
      {owners.map((owner) => {
        const themes = list.filter((t) => t.ext!.owner === owner)
        return (
          <div key={owner} className="theme-ext-group">
            <div className="theme-ext-head">
              <Puzzle size={12} aria-hidden />
              <span>{themes[0].ext!.ownerName}</span>
              <button className="btn ghost sm theme-ext-link" onClick={() => open(owner)}>
                Extensions page
              </button>
            </div>
            <div className="theme-grid" role="radiogroup" aria-label={`Themes from ${themes[0].ext!.ownerName}`}>
              {themes.map((t) => {
                const pick = t.kind === 'light' ? config.themeLight : config.themeDark
                return <ThemeCard key={t.id} t={t} on={follow ? pick === t.id : config.theme === t.id} showing={shown === t.id} pick={pick === t.id} />
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ThemeCard({ t, on, showing, pick }: { t: ThemeDef; on: boolean; showing: boolean; pick: boolean }): ReactNode {
  const k = themeTokens(t.id)
  const note = showing ? 'Showing now' : pick ? `Your ${t.kind} pick` : ''
  const ext = t.ext
  const title = [t.blurb, ext && `From the ${ext.ownerName} extension`, note, ...(ext?.warnings ?? [])]
    .filter(Boolean)
    .map((s) => String(s).replace(/\.$/, ''))
    .join('. ')
  return (
    <button
      role="radio"
      aria-checked={on}
      className={`theme-card${on ? ' on' : ''}${ext ? ' from-ext' : ''}`}
      title={title}
      onClick={() => pickTheme(t.id)}
    >
      {/* a tiny window in the theme's own colours: background, a panel, text and the accent */}
      <span className="theme-swatch" style={{ background: k.bg, borderColor: k['line-2'] }} aria-hidden>
        <span className="ts-panel" style={{ background: k['bg-1'], borderColor: k['line-2'] }}>
          <span className="ts-text" style={{ color: k.text }}>
            Aa
          </span>
          <span className="ts-lines">
            <span style={{ background: k.text }} />
            <span style={{ background: k['text-3'] }} />
          </span>
          <span className="ts-accent" style={{ background: k.accent }} />
        </span>
      </span>
      <span className="theme-name">
        <span className="theme-name-text">
          {ext && <Puzzle size={11} className="theme-ext-mark" aria-label="From an extension" />}
          {t.name}
        </span>
        {on && <Check size={13} strokeWidth={2.5} />}
      </span>
      {ext?.lowContrast && (
        <span className="theme-warn">
          <TriangleAlert size={11} aria-hidden />
          low contrast
        </span>
      )}
    </button>
  )
}

/** Main chat (#125): clearing the board, with the confirmation the board's own header used to have. */
const CLAUDE_PATH_TIP =
  "The Claude Code program Corvid runs for agents, Corvid, usage checks and scans. Leave it empty and Corvid finds it itself. Browse picks the file, Check runs it with --version and nothing else, and Save asks you to confirm in Corvid's own dialog. Only you can change it here: agents, Corvid and extensions can't. " +
  (platform.os === 'win32'
    ? 'Pick claude.exe. A claude.bat, .cmd or .ps1 is refused: on some computers it runs Claude inside WSL.'
    : 'A symlink is fine; Check shows where it points.')

/**
 * The Claude Code path (#194): where the one in use comes from, a field with the chosen path (the detected one as the
 * placeholder), Browse, Check, Save once Check passed, and Reset to automatic detection. Main checks it again and asks.
 */
function ClaudePathSetting({ config }: { config: AppConfig }): ReactNode {
  const claude = useStore((s) => s.claude)
  const [draft, setDraft] = useState(config.claudePath ?? '')
  // the last Check's answer, and the text it checked: Save is for that text only
  const [result, setResult] = useState<(ClaudePathCheck & { for: string }) | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setDraft(config.claudePath ?? ''), [config.claudePath])
  const typed = draft.trim()
  const checked = result?.ok && result.for === typed ? result : null
  const changed = typed !== (config.claudePath ?? '')

  const check = async (path: string): Promise<void> => {
    if (!path.trim()) return
    setBusy(true)
    try {
      setResult({ ...(await api.claudePathCheck(path)), for: path.trim() })
    } finally {
      setBusy(false)
    }
  }
  const browse = async (): Promise<void> => {
    const p = await api.claudePathBrowse()
    if (!p) return
    setDraft(p)
    await check(p)
  }
  const save = async (path: string | null): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.claudePathSet(path)
      if (r.error) setResult({ ok: false, error: r.error, for: path ?? '' })
      else if (r.ok) {
        setResult(null)
        toast(path === null ? 'Corvid finds Claude Code itself again.' : 'Saved. Agents and Corvid started from now on use this Claude Code.')
      }
    } finally {
      setBusy(false)
    }
  }

  const fromYou = claude?.source === 'config'
  return (
    <div className="setting setting-wrap claude-path">
      <SettingLabel label="Claude Code path" tip={CLAUDE_PATH_TIP}>
        <div className="d mono" style={{ userSelect: 'text' }}>
          {claude ? `${fromYou ? 'Set by you' : 'Automatic'}: ${claude.path}` : 'not found'}
          {!claude && <LearnMore page="getting-started/install" className="claude-path-learn" />}
        </div>
        {config.claudePath && !fromYou && <div className="d warn-text">Your path {config.claudePath} can&apos;t be used, so Corvid found one itself.</div>}
      </SettingLabel>
      <span className="chip">{claude ? `v${claude.version}${fromYou ? '' : ` · ${claude.source}`}` : '—'}</span>
      <div className="claude-path-edit">
        <input
          className="text mono"
          spellCheck={false}
          aria-label="Claude Code path"
          placeholder={claude && !fromYou ? claude.path : platform.os === 'win32' ? 'C:\Users\you\.local\bin\claude.exe' : '/usr/local/bin/claude'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void check(draft)}
        />
        <button className="btn sm" disabled={busy} onClick={() => void browse()}>
          Browse…
        </button>
        <button className="btn sm" disabled={busy || !typed} onClick={() => void check(draft)}>
          Check
        </button>
        {changed && typed && (
          <button className="btn sm primary" disabled={busy || !checked} title={checked ? undefined : 'Check the path first'} onClick={() => void save(typed)}>
            Save
          </button>
        )}
        {config.claudePath && (
          <button className="btn sm ghost" disabled={busy} title="Use automatic detection" onClick={() => void save(null)}>
            Reset
          </button>
        )}
      </div>
      {result && (
        <div className={`claude-path-result ${result.ok ? 'ok' : 'bad'}`} role="status">
          {result.ok ? `Claude Code ${result.version}${result.resolved ? ` · points to ${result.resolved}` : ''}` : result.error}
        </div>
      )}
    </div>
  )
}

function ClearMainChat(): ReactNode {
  const count = useStore((s) => s.board.messages.length)
  const [confirm, setConfirm] = useState(false)
  // messages that expire or get cleared elsewhere while it's asking leave nothing to confirm
  useEffect(() => {
    if (!count) setConfirm(false)
  }, [count])
  const clear = async (): Promise<void> => {
    setConfirm(false)
    const n = await api.boardClear()
    toast(`Cleared ${n} message${n === 1 ? '' : 's'} from the board. Saved notes stay.`)
  }
  return (
    <div className="setting setting-wrap">
      <SettingLabel label="Main chat" tip={"The board on the Agents view, shared by you, the agents and Corvid. Agents see it only when they read it; nothing interrupts them. Clearing removes every message in every channel (channels are only filters over the one board); notes saved from them stay."} />
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flex: 'none' }}>
        <button className="btn sm" disabled={!count || confirm} title={count ? undefined : 'The main chat has no messages'} onClick={() => setConfirm(true)}>
          Clear main chat…
        </button>
        {!count && <span className="muted" style={{ fontSize: 11.5 }}>Nothing to clear</span>}
      </span>
      {confirm && count > 0 && (
        <div className="setting-confirm" role="alertdialog" aria-label="Clear the main chat">
          <span>
            Clear all {count} message{count === 1 ? '' : 's'} from the main chat, in every channel (All, General and each project's)? Notes saved from them stay.
          </span>
          <button className="btn sm danger" onClick={() => void clear()}>
            Clear
          </button>
          <button className="btn sm ghost" onClick={() => setConfirm(false)} autoFocus>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

type BackupList = Awaited<ReturnType<typeof api.listBackups>>

/** Restore one file from Corvid's rolling backups (#85). The dialog that confirms it, and the restart, are in main. */
function RestoreBackup(): ReactNode {
  const [list, setList] = useState<BackupList>([])
  const [item, setItem] = useState('config.json')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => void api.listBackups().then(setList), [])
  const backups = list.find((l) => l.item === item)?.backups ?? []
  const chosen = backups.some((b) => b.name === name) ? name : (backups[0]?.name ?? '')
  const restore = async (): Promise<void> => {
    setBusy(true)
    const r = await api.restoreBackup(item, chosen)
    setBusy(false)
    if (r.error) toast(r.error, 'error')
  }
  return (
    <div className="setting">
      <SettingLabel label="Restore from backup" tip={"Corvid keeps the last ten versions of its settings, tasks, projects, agents, notes, board and extensions (and one a day for a week) in its data folder. Secrets are never copied. Restoring restarts Corvid and keeps the current version as a backup first."} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select className="select" title="What to restore" value={item} onChange={(e) => setItem(e.target.value)}>
          {list.map((l) => (
            <option key={l.item} value={l.item}>
              {l.item}
            </option>
          ))}
        </select>
        <select className="select" title="Which backup" value={chosen} disabled={!backups.length} onChange={(e) => setName(e.target.value)}>
          {!backups.length && <option value="">no backups yet</option>}
          {backups.map((b) => (
            <option key={b.name} value={b.name}>
              {new Date(b.at).toLocaleString()}
            </option>
          ))}
        </select>
        <button className="btn sm" disabled={!chosen || busy} onClick={() => void restore()}>
          Restore…
        </button>
      </div>
    </div>
  )
}

/** Corvid's licence, quietly, under the version line (#120): the name and the full LICENSE text on request. */
function LicenseLine(): ReactNode {
  const [text, setText] = useState<string | null>()
  const [open, setOpen] = useState(false)
  const toggle = (): void => {
    if (open) return setOpen(false)
    if (text) return setOpen(true)
    void api.corvidLicenseText().then((t) => {
      if (!t) return toast("This install has no copy of the licence; it is the LICENSE file in Corvid's source.", 'info')
      setText(t)
      setOpen(true)
    })
  }
  return (
    <>
      <p style={{ fontSize: 11.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span>Functional Source License 1.1 (Apache 2.0 future license)</span>
        <button className="btn sm" onClick={toggle}>
          {open ? 'Hide licence' : 'View licence'}
        </button>
      </p>
      {open && text && (
        <pre className="mono" style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', maxWidth: '100%', padding: 10, border: '1px solid var(--line)', borderRadius: 6 }}>
          {text}
        </pre>
      )}
    </>
  )
}

/** The installed version and the commit it was built from (#78). */
function BuildLine(): ReactNode {
  const [s] = useCorvidStatus(5 * 60_000)
  if (!s) return null
  return (
    <p className="mono" style={{ fontSize: 11.5 }}>
      Corvid v{s.version} · build {shortCommit(s.commit)}
      {s.dirty ? ' (uncommitted changes)' : ''}
      {s.builtAt ? ` · built ${new Date(s.builtAt).toLocaleString()}` : ''}
    </p>
  )
}
