// The docs page bundled into the main process as text (#202), like Vite's own ?raw imports in the renderer.
declare module '*.md?raw' {
  const text: string
  export default text
}
