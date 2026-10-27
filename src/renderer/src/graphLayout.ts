// Lane layout for the commit graph. Commits arrive newest first in topological order; each one sits in a lane,
// and the lines between rows are built once per load into one SVG path per lane colour.

export const LANE_COLORS = 8
export const ROW_H = 26
export const LANE_W = 14
const PAD = 8

export interface GraphNode {
  /** lane the commit's dot sits in */
  lane: number
  color: number
  merge: boolean
}

export interface GraphLayout {
  nodes: GraphNode[]
  /** SVG path data, indexed by colour */
  paths: string[]
  /** lanes in use at the widest row */
  lanes: number
}

export const laneX = (lane: number): number => PAD + lane * LANE_W
export const rowY = (row: number): number => row * ROW_H + ROW_H / 2

export function layoutGraph(commits: { hash: string; parents: string[] }[]): GraphLayout {
  /** the hash each lane is waiting for, or null when free */
  const lanes: (string | null)[] = []
  const laneColor: number[] = []
  /** lines leaving the previous row, still to be drawn down to this one */
  let pending: { fromLane: number; lane: number; color: number }[] = []
  const paths: string[][] = Array.from({ length: LANE_COLORS }, () => [])
  const nodes: GraphNode[] = []
  let nextColor = 0
  let widest = 0

  const alloc = (): number => {
    let k = lanes.indexOf(null)
    if (k < 0) k = lanes.push(null) - 1
    laneColor[k] = nextColor++ % LANE_COLORS
    return k
  }
  const line = (lane1: number, row1: number, lane2: number, row2: number, color: number): void => {
    const x1 = laneX(lane1)
    const x2 = laneX(lane2)
    const y1 = rowY(row1)
    const y2 = rowY(row2)
    if (x1 === x2) paths[color].push(`M${x1} ${y1}V${y2}`)
    else {
      const ym = (y1 + y2) / 2
      paths[color].push(`M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`)
    }
  }

  commits.forEach((c, row) => {
    let lane = lanes.indexOf(c.hash)
    if (lane < 0) lane = alloc()
    const color = laneColor[lane]

    // Lines from the row above: lanes waiting for this commit bend into its dot, the rest carry straight on.
    for (const p of pending) line(p.fromLane, row - 1, lanes[p.lane] === c.hash ? lane : p.lane, row, p.color)
    pending = []
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.hash) lanes[k] = null

    const [first, ...rest] = c.parents
    if (first) lanes[lane] = first
    const opened = new Set<number>()
    for (const parent of rest) {
      // A parent another lane already waits for joins that lane; otherwise it opens a new one.
      const existing = lanes.indexOf(parent)
      if (existing >= 0) pending.push({ fromLane: lane, lane: existing, color: laneColor[existing] })
      else {
        const k = alloc()
        lanes[k] = parent
        opened.add(k)
        pending.push({ fromLane: lane, lane: k, color: laneColor[k] })
      }
    }
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k] !== null && !opened.has(k)) pending.push({ fromLane: k, lane: k, color: laneColor[k] })
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    widest = Math.max(widest, lanes.length, lane + 1)
    nodes.push({ lane, color, merge: c.parents.length > 1 })
  })

  // Parents beyond the loaded history: run their lanes off the bottom.
  const last = commits.length - 1
  for (const p of pending) line(p.fromLane, last, p.lane, last + 0.5, p.color)

  return { nodes, paths: paths.map((p) => p.join('')), lanes: widest }
}
