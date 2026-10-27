// The docs the Docs view shows (#188), bundled into the renderer at build time from the repo's docs/ folder: every
// page, docs/sections.json and the images in docs/images. They ship inside the app (out/renderer, which
// electron-builder packs), so they work offline on a fresh install, and each Corvid update brings the docs that match
// it. In the dev build (npm run dev, npm run test-instance) Vite serves the same files live from docs/.
import sections from '../../../docs/sections.json'
import { loadDocs } from '@shared/docs'

const pages = import.meta.glob<string>(['../../../docs/index.md', '../../../docs/*/*.md'], { eager: true, query: '?raw', import: 'default' })
const images = import.meta.glob<string>('../../../docs/images/*', { eager: true, query: '?url', import: 'default' })

const rel = (key: string): string => key.replace(/^(\.\.\/)+docs\//, '')

/** Image paths relative to docs/ ("images/tasks-dark.png") to the bundled file's URL. */
export const docImages: ReadonlyMap<string, string> = new Map(Object.entries(images).map(([k, url]) => [rel(k), url]))

export const docs = loadDocs(
  Object.entries(pages).map(([k, text]) => ({ path: rel(k), text })),
  sections.sections,
  new Set(docImages.keys())
)
