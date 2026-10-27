import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Client, type ConnectConfig } from 'ssh2'
import type { RemoteSystem } from '@shared/types'
import { getSecret, knownHost, rememberHost } from './store'

// One SSH connection per command: connect, check the host key, run, collect output, close.
// No terminal, no agent forwarding, no stdin.

const MAX_OUTPUT = 256 * 1024
const CONNECT_TIMEOUT = 15_000
// uploads: 32 KB writes, a few at a time, so a far server isn't one round trip per chunk
const WRITE_CHUNK = 32 * 1024
const WRITES_IN_FLIGHT = 8

export interface RunResult {
  code: number | null
  signal?: string
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  durationMs: number
  /** set the first time we saw this host: its key was just remembered */
  newHostKey?: string
}

/** OpenSSH-style "SHA256:…" fingerprint and the key type from the wire-format key blob. */
function describeKey(key: Buffer): { type: string; fingerprint: string } {
  let type = 'unknown'
  try {
    const len = key.readUInt32BE(0)
    if (len > 0 && len < 64) type = key.subarray(4, 4 + len).toString('ascii')
  } catch {
    /* keep unknown */
  }
  return { type, fingerprint: 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') }
}

export class HostKeyChanged extends Error {}

function connectConfig(sys: RemoteSystem, onKey: (key: Buffer) => boolean): ConnectConfig {
  const cfg: ConnectConfig = {
    host: sys.host,
    port: sys.port,
    username: sys.user,
    readyTimeout: CONNECT_TIMEOUT,
    hostVerifier: onKey
  }
  if (sys.auth === 'password') {
    cfg.password = getSecret(sys.id, 'password')
    if (!cfg.password) throw new Error(`No password is stored for ${sys.name}. Add it in the Servers panel.`)
    cfg.tryKeyboard = true
  } else {
    if (!sys.keyPath) throw new Error(`No key file is set for ${sys.name}.`)
    try {
      cfg.privateKey = readFileSync(sys.keyPath)
    } catch {
      throw new Error(`Can't read the key file for ${sys.name}. Check the path in the Servers panel.`)
    }
    cfg.passphrase = getSecret(sys.id, 'passphrase')
  }
  return cfg
}

/** The host-key check every connection makes: remembered on first connect, refused when it changed. */
function hostCheck(sys: RemoteSystem): { onKey: (key: Buffer) => boolean; seen: { newHostKey?: string; keyError?: Error } } {
  const seen: { newHostKey?: string; keyError?: Error } = {}
  const onKey = (key: Buffer): boolean => {
    const got = describeKey(key)
    const known = knownHost(sys)
    if (!known) {
      // First connect: trust and remember (like ssh's accept-new).
      rememberHost(sys, got.type, got.fingerprint)
      seen.newHostKey = `${got.type} ${got.fingerprint}`
      return true
    }
    if (known.fingerprint === got.fingerprint) return true
    seen.keyError = new HostKeyChanged(
      `The host key for ${sys.name} has changed (remembered ${known.type} ${known.fingerprint}, got ${got.type} ${got.fingerprint}). ` +
        `Refusing to connect: this can mean someone is intercepting the connection. If the server was rebuilt or its key was replaced on purpose, ` +
        `the user can forget the old key in the Servers panel.`
    )
    return false
  }
  return { onKey, seen }
}

/** command null = log in and close (connection test). */
export function runCommand(sys: RemoteSystem, command: string | null, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const conn = new Client()
    const keys = hostCheck(sys)
    let settled = false
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.end()
      reject(keys.seen.keyError ?? e)
    }

    let cfg: ConnectConfig
    try {
      cfg = connectConfig(sys, keys.onKey)
    } catch (e) {
      reject(e)
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (!settled) conn.end()
    }, timeoutMs + CONNECT_TIMEOUT)

    const take = (cur: string, chunk: Buffer): string => {
      if (cur.length >= MAX_OUTPUT) {
        truncated = true
        return cur
      }
      const s = cur + chunk.toString('utf8')
      if (s.length > MAX_OUTPUT) truncated = true
      return s.slice(0, MAX_OUTPUT)
    }

    conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      // Password systems only: answer each prompt (usually just "Password:") with the password.
      finish(prompts.map(() => cfg.password ?? ''))
    })
    conn.on('ready', () => {
      if (command === null) {
        clearTimeout(timer)
        settled = true
        conn.end()
        resolve({ code: 0, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: Date.now() - started, newHostKey: keys.seen.newHostKey })
        return
      }
      conn.exec(command, (err, stream) => {
        if (err) return fail(err)
        stream.end()
        const cmdTimer = setTimeout(() => {
          timedOut = true
          stream.close()
          conn.end()
        }, timeoutMs)
        stream.on('data', (d: Buffer) => (stdout = take(stdout, d)))
        stream.stderr.on('data', (d: Buffer) => (stderr = take(stderr, d)))
        stream.on('close', (code: number | null, signal?: string) => {
          clearTimeout(cmdTimer)
          clearTimeout(timer)
          if (settled) return
          settled = true
          conn.end()
          resolve({ code: code ?? null, signal, stdout, stderr, truncated, timedOut, durationMs: Date.now() - started, newHostKey: keys.seen.newHostKey })
        })
      })
    })
    conn.on('error', (e) => fail(e))
    conn.on('close', () => fail(new Error(timedOut ? 'Timed out connecting.' : 'The connection closed before the command finished.')))
    conn.connect(cfg)
  })
}

export interface UploadResult {
  bytes: number
  /** an existing file was replaced (overwrite) */
  replaced: boolean
  durationMs: number
  newHostKey?: string
}

/**
 * Write `data` to `remotePath` over SFTP (#168), with the same sign-in and host-key check as runCommand and only the
 * connection user's permissions. Refuses an existing file unless `overwrite`, and a folder always. `signal` (the kill
 * switch) closes the connection mid-transfer.
 */
export function uploadFile(sys: RemoteSystem, data: Buffer, remotePath: string, opts: { overwrite: boolean; mode?: number }, timeoutMs: number, signal?: AbortSignal): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const conn = new Client()
    const keys = hostCheck(sys)
    let settled = false
    const done = (e: Error | null, replaced = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      conn.end()
      if (e) reject(keys.seen.keyError ?? e)
      else resolve({ bytes: data.length, replaced, durationMs: Date.now() - started, newHostKey: keys.seen.newHostKey })
    }
    const onAbort = (): void => done(signal?.reason instanceof Error ? signal.reason : new Error('The upload was stopped.'))
    const timer = setTimeout(() => done(new Error(`The upload timed out after ${Math.round(timeoutMs / 1000)} s; the file on the server may be incomplete.`)), timeoutMs + CONNECT_TIMEOUT)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    let cfg: ConnectConfig
    try {
      cfg = connectConfig(sys, keys.onKey)
    } catch (e) {
      return done(e as Error)
    }
    conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => finish(prompts.map(() => cfg.password ?? '')))
    conn.on('ready', () =>
      conn.sftp((err, sftp) => {
        if (err) return done(new Error(`The server did not open an SFTP session: ${err.message}`))
        sftp.stat(remotePath, (missing, st) => {
          const exists = !missing
          if (exists && st.isDirectory()) return done(new Error(`${remotePath} is a folder on the server. Give the full path of the file, including its name. Nothing was sent.`))
          if (exists && !opts.overwrite) return done(new Error(`${remotePath} already exists on the server. Nothing was sent; pass overwrite: true to replace it.`))
          const check = (): void =>
            sftp.stat(remotePath, (e, after) => {
              if (e) return done(new Error(`Wrote ${remotePath} but could not check it: ${e.message}`))
              if (after.size !== data.length) return done(new Error(`${remotePath} is ${after.size} bytes on the server, not ${data.length}; the upload did not finish.`))
              done(null, exists)
            })
          // not createWriteStream: it always fchmods (to 0666 by default), which would loosen a replaced file's mode.
          // wx: the server refuses if the file appeared since the stat, so nothing is replaced without overwrite
          sftp.open(remotePath, opts.overwrite ? 'w' : 'wx', opts.mode !== undefined ? { mode: opts.mode } : {}, (oe, handle) => {
            if (oe) return done(new Error(`Could not open ${remotePath} for writing: ${oe.message}. Nothing was sent.`))
            let next = 0
            let inFlight = 0
            let failed = false
            const pump = (): void => {
              if (settled || failed) return
              if (next >= data.length && !inFlight)
                return sftp.close(handle, (ce) => {
                  if (ce) return done(new Error(`Could not finish writing ${remotePath}: ${ce.message}`))
                  // the mode at creation is reduced by the server's umask, and an existing file keeps its own
                  if (opts.mode === undefined) return check()
                  sftp.chmod(remotePath, opts.mode, (e) => (e ? done(new Error(`Wrote ${remotePath} but could not set its mode: ${e.message}`)) : check()))
                })
              while (next < data.length && inFlight < WRITES_IN_FLIGHT) {
                const at = next
                const n = Math.min(WRITE_CHUNK, data.length - at)
                next += n
                inFlight++
                sftp.write(handle, data, at, n, at, (we) => {
                  inFlight--
                  if (we && !failed) {
                    failed = true
                    return done(new Error(`Could not write ${remotePath}: ${we.message}; the file on the server may be incomplete.`))
                  }
                  pump()
                })
              }
            }
            pump()
          })
        })
      })
    )
    conn.on('error', (e) => done(e))
    conn.on('close', () => done(new Error('The connection closed before the upload finished.')))
    conn.connect(cfg)
  })
}

/** Connect, verify the host key and log in, without running anything. */
export async function testConnection(sys: RemoteSystem): Promise<RunResult> {
  return runCommand(sys, null, 10_000)
}
