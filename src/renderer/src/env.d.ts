declare module '*.css'

// Vite's import.meta.glob, as the Docs view uses it (#188): eager, so the files are bundled into the build.
interface ImportMeta {
  glob<T = unknown>(pattern: string | string[], options: { eager: true; query?: string; import?: string }): Record<string, T>
}
