import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// The commit and time a build was made from, shown on Corvid's project page and in Settings (#78).
function buildInfo(): string {
  const git = (cmd: string): string => {
    try {
      return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }
  return JSON.stringify({ commit: git('rev-parse HEAD'), time: Date.now(), dirty: !!git('status --porcelain --untracked-files=no') })
}

export default defineConfig({
  main: {
    define: { __CORVID_BUILD__: buildInfo() },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
    plugins: [react()]
  }
})
