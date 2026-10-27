// Runs electron-vite with ELECTRON_RUN_AS_NODE removed. Shells spawned by VS Code extensions
// (Claude Code included) set it, which makes `electron` start as plain Node and crash.
import { spawn } from 'node:child_process'

delete process.env.ELECTRON_RUN_AS_NODE
const child = spawn('electron-vite', process.argv.slice(2), { stdio: 'inherit', shell: true, env: process.env })
child.on('exit', (code) => process.exit(code ?? 0))
