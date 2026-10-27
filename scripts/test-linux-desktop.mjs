// Tests for #158, Linux desktop integration: the app-menu and autostart .desktop entries (also with spaces and
// quotes in the install path), open at login written and removed in a temp HOME, the no-tray fallback with a fake
// D-Bus, the Wayland hotkey switch and texts, and setup's sandbox check with fake sysctl, stat and error text.
// Pure functions and a temp folder; no app, no real HOME, no data folder, no sudo.
//
//   npm run test-linux-desktop

import { register } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: 'data:text/javascript,export const app = {}', shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        for (const ext of ['.ts', '/index.ts']) {
          try { return await next(s + ext, c) } catch {}
        }
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const P = await import(src + 'main/platform/index.ts')
const K = await import(src + 'shared/platformInfo.ts')
const S = await import(pathToFileURL(join(root, 'scripts', 'linux-sandbox.mjs')).href)

/** A .desktop file's keys, read back the way the spec says: string escapes undone (\\ \s \n \t \r). */
function parseEntry(text) {
  const lines = text.split('\n')
  assert.equal(lines[0], '[Desktop Entry]')
  const out = {}
  for (const l of lines.slice(1).filter(Boolean)) {
    const i = l.indexOf('=')
    out[l.slice(0, i)] = l.slice(i + 1).replace(/\\(.)/g, (_, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c] ?? '\\' + c)
  }
  return out
}

/** The Exec value's arguments after the spec's quoting rules (on an already string-unescaped value). */
function execArgs(exec) {
  const args = []
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g
  for (let m; (m = re.exec(exec)); ) args.push(m[1] !== undefined ? m[1].replace(/\\(["`$\\])/g, '$1').replace(/%%/g, '%') : m[2])
  return args
}

test('the app-menu entry has the fields and round-trips any install path, spaces and quotes included', () => {
  for (const exe of ['/home/u/.local/share/corvid/app/corvid', '/home/a user/My Apps/corvid/app/corvid', '/home/x/we"ird $HOME `x` 50%\\dir/corvid']) {
    const icon = exe.replace(/app\/corvid$|corvid$/, 'icon.png')
    const e = parseEntry(P.desktopEntryText(exe, icon))
    assert.equal(e.Type, 'Application')
    assert.equal(e.Name, 'Corvid')
    assert.equal(e.Terminal, 'false')
    assert.equal(e.Categories, 'Development;')
    assert.equal(e.StartupWMClass, 'Corvid')
    assert.equal(e.TryExec, exe)
    assert.equal(e.Icon, icon)
    assert.deepEqual(execArgs(e.Exec), [exe, '%U'])
    assert.equal(e['X-GNOME-Autostart-enabled'], undefined)
  }
})

test('the autostart entry starts Corvid hidden, without a file argument', () => {
  const exe = '/home/a user/.local/share/corvid/app/corvid'
  const e = parseEntry(P.desktopEntryText(exe, undefined, { autostart: true }))
  assert.deepEqual(execArgs(e.Exec), [exe, '--hidden'])
  assert.equal(e['X-GNOME-Autostart-enabled'], 'true')
  assert.equal(e.Icon, undefined)
  assert.equal(P.autostartEntryPath({}, '/home/u'), '/home/u/.config/autostart/corvid.desktop')
  assert.equal(P.autostartEntryPath({ XDG_CONFIG_HOME: '/cfg dir' }, '/home/u'), '/cfg dir/autostart/corvid.desktop')
})

test('the install profile writes the menu entry only for a real install', () => {
  const real = P.installProfile('/src', 'linux', {}, '/home/u')
  assert.equal(real.desktopEntry, '/home/u/.local/share/applications/corvid.desktop')
  assert.equal(real.executable(real.installDir), '/home/u/.local/share/corvid/app/corvid')
  assert.equal(P.installProfile('/src', 'linux', { CORVID_INSTALL_DIR: '/tmp/x/app' }, '/home/u').desktopEntry, null)
  assert.equal(P.installProfile('/src', 'linux', { XDG_DATA_HOME: '/data home' }, '/home/u').desktopEntry, '/data home/applications/corvid.desktop')
  assert.equal(P.installProfile('/src', 'win32', { LOCALAPPDATA: 'C:\\L' }).desktopEntry, null)
  assert.equal(P.installProfile('/src', 'darwin', {}, '/Users/u').desktopEntry, null)
})

const home = mkdtempSync(join(tmpdir(), 'corvid-158-home-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('open at login writes, keeps and removes ~/.config/autostart/corvid.desktop in a temp HOME', () => {
  // POSIX-shaped paths under the temp folder, so this runs on Windows too
  const h = home.replace(/\\/g, '/')
  const file = join(home, '.config', 'autostart', 'corvid.desktop')
  const exe = `${h}/share dir/corvid/app/corvid`
  assert.equal(P.applyAutostart(false, exe, {}, h), 'unchanged', 'off and absent: nothing to do')
  assert.equal(existsSync(file), false)
  assert.equal(P.applyAutostart(true, exe, {}, h), 'written')
  const e = parseEntry(readFileSync(file, 'utf8'))
  assert.deepEqual(execArgs(e.Exec), [exe, '--hidden'])
  assert.equal(e.Icon, undefined, 'no icon beside the install yet')
  assert.equal(P.applyAutostart(true, exe, {}, h), 'unchanged', 'same text: not rewritten')
  assert.equal(P.applyAutostart(false, exe, {}, h), 'removed')
  assert.equal(existsSync(file), false)
})

test('open at login uses the icon deploy copies beside the install', () => {
  const files = new Map([['/home/u/.local/share/corvid/icon.png', '']])
  const fs = { exists: (p) => files.has(p), read: (p) => files.get(p), write: (p, t) => files.set(p, t), remove: (p) => files.delete(p) }
  assert.equal(P.applyAutostart(true, '/home/u/.local/share/corvid/app/corvid', {}, '/home/u', fs), 'written')
  assert.equal(parseEntry(files.get('/home/u/.config/autostart/corvid.desktop')).Icon, '/home/u/.local/share/corvid/icon.png')
})

test('open at login: Linux uses the autostart entry, Windows and macOS keep the login item', () => {
  assert.equal(P.loginItemKind('linux'), 'autostart-desktop')
  assert.equal(P.loginItemKind('win32'), 'electron')
  assert.equal(P.loginItemKind('darwin'), 'electron')
  assert.deepEqual(K.loginItemText('win32', true), { label: 'Start with Windows', tip: 'Launch hidden in the tray when you log in (installed app only).' })
  assert.match(K.loginItemText('linux', true).tip, /hidden in the tray.*autostart/)
  assert.match(K.loginItemText('linux', false).tip, /minimised/)
})

test('the tray probe reads gdbus or dbus-send, and says no tray when neither answers', async () => {
  assert.equal(P.parseHasOwner('(true,)\n'), true)
  assert.equal(P.parseHasOwner('(false,)\n'), false)
  assert.equal(P.parseHasOwner('method return time=1 sender=org.freedesktop.DBus\n   boolean true\n'), true)
  assert.equal(P.parseHasOwner('   boolean false\n'), false)
  assert.equal(P.parseHasOwner(''), undefined)
  const calls = []
  const fake = (answers) => async (cmd, args) => {
    calls.push(cmd)
    if (!(cmd in answers)) throw new Error('ENOENT')
    assert.ok(args.join(' ').includes('org.kde.StatusNotifierWatcher'))
    return answers[cmd]
  }
  assert.equal(await P.hasTray('linux', fake({ gdbus: '(true,)' })), true, 'KDE, or GNOME with AppIndicator')
  assert.equal(await P.hasTray('linux', fake({ gdbus: '(false,)' })), false, 'plain GNOME')
  assert.equal(await P.hasTray('linux', fake({ 'dbus-send': 'boolean true' })), true, 'no gdbus: dbus-send')
  assert.equal(await P.hasTray('linux', fake({})), false, 'no session bus tools: assume none')
  calls.length = 0
  assert.equal(await P.hasTray('win32', fake({})), true)
  assert.equal(await P.hasTray('darwin', fake({})), true)
  assert.deepEqual(calls, [], 'Windows and macOS never ask D-Bus')
})

test('without a tray, closing quits (or asks while things run) and a login start minimises', () => {
  // Windows and macOS: unchanged, always hide
  for (const p of ['win32', 'darwin']) {
    assert.equal(P.closeAction(true, 3, p), 'hide')
    assert.equal(P.closeAction(false, 3, p), 'hide')
    assert.equal(P.hiddenStartAction(false, p), 'hide')
  }
  assert.equal(P.closeAction(true, 0, 'linux'), 'hide')
  assert.equal(P.closeAction(false, 0, 'linux'), 'quit')
  assert.equal(P.closeAction(false, 2, 'linux'), 'ask')
  assert.equal(P.hiddenStartAction(true, 'linux'), 'hide')
  assert.equal(P.hiddenStartAction(false, 'linux'), 'minimize')
  assert.equal(P.trayClicks('linux'), false)
  assert.equal(P.trayClicks('win32'), true)
  assert.equal(K.noTrayText('linux', true), null)
  assert.equal(K.noTrayText('win32', false), null)
  assert.match(K.noTrayText('linux', false), /AppIndicator.*quits/)
})

test('the Wayland hotkey portal is turned on under Wayland only', () => {
  assert.equal(P.hotkeyFeature('linux', { XDG_SESSION_TYPE: 'wayland' }), 'GlobalShortcutsPortal')
  assert.equal(P.hotkeyFeature('linux', { WAYLAND_DISPLAY: 'wayland-0' }), 'GlobalShortcutsPortal')
  assert.equal(P.hotkeyFeature('linux', { XDG_SESSION_TYPE: 'x11' }), null)
  assert.equal(P.hotkeyFeature('win32', { WAYLAND_DISPLAY: 'wayland-0' }), null)
  assert.equal(P.hotkeyFeature('darwin', { XDG_SESSION_TYPE: 'wayland' }), null)
  assert.match(K.hotkeyFailText('Control+Alt+Space', 'linux', { XDG_SESSION_TYPE: 'wayland' }), /GlobalShortcuts portal/)
})

const EXE = '/home/u/.local/share/corvid/app/corvid'
const DEV = '/home/u/src/corvid/node_modules/electron/dist/electron'

test('sandbox: the sysctl and chrome-sandbox decide whether setup prints the fix', () => {
  assert.equal(S.sysctlOn('1\n'), true)
  assert.equal(S.sysctlOn('0\n'), false)
  assert.equal(S.sysctlOn(''), undefined)
  const user = { uid: 1000, mode: 0o100755 }
  const suid = { uid: 0, mode: 0o104755 }
  assert.equal(S.sandboxState({ restricted: false, profile: false, sandboxes: [user] }), 'ok', 'restriction off')
  assert.equal(S.sandboxState({ restricted: undefined, profile: false, sandboxes: [user] }), 'ok', 'no such sysctl')
  assert.equal(S.sandboxState({ restricted: true, profile: false, sandboxes: [user] }), 'restricted', 'Ubuntu 24.04 default')
  assert.equal(S.sandboxState({ restricted: true, profile: true, sandboxes: [user] }), 'ok', 'AppArmor profile installed')
  assert.equal(S.sandboxState({ restricted: true, profile: false, sandboxes: [suid] }), 'ok', 'setuid helper')
  assert.equal(S.sandboxState({ restricted: true, profile: false, sandboxes: [suid, null] }), 'restricted', 'one binary still blocked')
})

test('sandbox: checkSandbox reads the facts and prints the exact commands, never on Windows or macOS', () => {
  const facts = (sysctl, files = {}) => ({
    platform: 'linux',
    read: (p) => {
      assert.equal(p, S.RESTRICT_SYSCTL)
      if (sysctl === null) throw new Error('ENOENT')
      return sysctl
    },
    exists: (p) => p in files,
    stat: (p) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    }
  })
  assert.equal(S.checkSandbox([EXE], facts('0\n')), null)
  assert.equal(S.checkSandbox([EXE], facts(null)), null)
  assert.equal(S.checkSandbox([EXE], { ...facts('1\n'), platform: 'win32' }), null)
  assert.equal(S.checkSandbox([EXE], facts('1\n', { [S.PROFILE_FILE]: true })), null)
  const lines = S.checkSandbox([DEV, EXE], facts('1\n'))
  const text = lines.join('\n')
  assert.match(text, /apparmor_restrict_unprivileged_userns = 1/)
  assert.match(text, /sudo tee \/etc\/apparmor\.d\/corvid > \/dev\/null <<'EOF'/)
  assert.match(text, /abi <abi\/4\.0>,/)
  assert.match(text, /include <tunables\/global>/)
  assert.match(text, /profile corvid \/home\/u\/src\/corvid\/node_modules\/electron\/dist\/electron flags=\(unconfined\) \{\n\s+userns,/)
  assert.match(text, /profile corvid-2 \/home\/u\/\.local\/share\/corvid\/app\/corvid flags=\(unconfined\)/)
  assert.match(text, /sudo apparmor_parser -r \/etc\/apparmor\.d\/corvid/)
  assert.match(text, /sudo chown root:root '\/home\/u\/\.local\/share\/corvid\/app\/chrome-sandbox'/)
  assert.match(text, /sudo chmod 4755 '\/home\/u\/\.local\/share\/corvid\/app\/chrome-sandbox'/)
  assert.match(text, /never runs sudo/)
  assert.ok(!/--no-sandbox/.test(text), 'never suggests turning the sandbox off')
})

test('sandbox: a path with spaces is quoted in the profile and the commands', () => {
  const exe = "/home/a user/it's/corvid/app/corvid"
  assert.match(S.profileText([exe]), /profile corvid "\/home\/a user\/it's\/corvid\/app\/corvid" flags=\(unconfined\)/)
  const text = S.sandboxFix([exe], ["/home/a user/it's/corvid/app/chrome-sandbox"]).join('\n')
  assert.match(text, /sudo chown root:root '\/home\/a user\/it'\\''s\/corvid\/app\/chrome-sandbox'/)
})

test("sandbox: Chromium's sandbox and namespace errors are recognised", () => {
  const apparmor =
    '[1234:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:163] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I\'m aborting now. You need to make sure that /home/u/.local/share/corvid/app/chrome-sandbox is owned by root and has mode 4755.'
  const noUserns =
    "[5678:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md."
  assert.equal(S.isSandboxError(apparmor), true)
  assert.equal(S.isSandboxError(noUserns), true)
  assert.equal(S.isSandboxError('Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted'), true)
  assert.equal(S.isSandboxError('GPU process launch failed: error_code=1002'), false)
  assert.equal(S.isSandboxError(''), false)
  assert.equal(S.isSandboxError(undefined), false)
})
