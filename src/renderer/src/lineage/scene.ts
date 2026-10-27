// The 3D scene of the Context cloud view (#205; named Lineage until #209): a force-directed node graph in three.js, drawn straight into a canvas the
// view owns. Nodes are three instanced meshes (one per shape) with a halo sprite each, edges one line batch, and the
// read and wrote edges carry a particle. The frame loop runs only while `running`: the view stops it whenever the
// pane is hidden, the window is minimised or blurred, and disposes the scene on unmount. Nothing here touches data.
//
// Live updates (#210): `append` adds nodes and edges to the running layout without rebuilding it. The buffers are
// allocated with slack and only reallocated when they run out. A new node pulses for a second, a new edge's
// particle starts at once, an edge whose event just happened draws bright with a denser, faster particle stream
// and eases back, and a running worker breathes. With reduced motion only the brightness changes.
//
// Edge shape (#212): `setEdgeMode` draws the same edges as straight lines or as quadratic curves, each a few
// segments in the same line batch, bending a hashed way per edge so parallel edges fan apart. Only the line batch
// is reallocated; the layout, the particles' phases and the live state stay. Particles follow the curve.
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { projectRelationOf, type LineageEdge, type LineageGraph, type LineageNode } from '@shared/lineage'
import {
  ACTIVE_EASE_MS,
  ACTIVE_MS,
  ACTIVE_OTHER_OPACITY,
  ACTIVE_PARTICLE_EXTRA,
  ACTIVE_PARTICLE_SPEED,
  ARRIVAL_PULSE_MS,
  activityOf,
  bendAngle,
  breathScale,
  controlPoint,
  degrees,
  edgeLevelOf,
  fadeOf,
  levelOf,
  linearGain,
  particleEdges,
  pulseScale,
  radiusOf,
  restLength,
  styleOf,
  timeSpan,
  verticesPerEdge,
  type EdgeMode,
  type Level,
  type Merge,
  type Shape,
  type Vec3
} from './helpers'

export interface SceneOptions {
  reducedMotion: boolean
  /** how the edges are drawn at first; setEdgeMode changes it later */
  edgeMode?: EdgeMode
  onHover: (node: LineageNode | undefined, x: number, y: number) => void
  onClick: (node: LineageNode | undefined) => void
}

const SHAPES: Shape[] = ['sphere', 'box', 'octa']
const BG = 0x070910
/** auto-rotate comes back after this long without a touch */
const IDLE_MS = 8000
/** a particle crosses its edge in this many frames at normal speed */
const PARTICLE_FRAMES = 240
/** extra particles for active edges, shared by all of them */
const ACTIVE_POOL = 96
/** how much heat an append puts back into a settled layout: enough to let the newcomers find a spot */
const APPEND_HEAT = 0.3

/** True when the GPU will give us a WebGL context at all. */
export function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

function haloTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Points whose size and colour come from attributes, with the halo texture: a cheap glow in one draw call. */
function glowMaterial(tex: THREE.Texture, scale: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, scale: { value: scale } },
    vertexShader: [
      'attribute float size;',
      'attribute vec3 tint;',
      'varying vec3 vTint;',
      'uniform float scale;',
      'void main() {',
      '  vTint = tint;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = size * scale / -mv.z;',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: ['uniform sampler2D map;', 'varying vec3 vTint;', 'void main() {', '  vec4 t = texture2D(map, gl_PointCoord);', '  gl_FragColor = vec4(vTint * t.a, t.a);', '}'].join('\n'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
}

/** The level's look as a linear factor: ACTIVE_OTHER_OPACITY and 100% for an active thing, like linearGain does for the levels. */
const activeGain = (level: Level): number => (level === 'other' ? Math.pow(ACTIVE_OTHER_OPACITY, 2.2) : 1)

interface Body {
  node: LineageNode
  shape: Shape
  /** index inside its shape's instanced mesh */
  slot: number
  radius: number
  color: THREE.Color
  fade: number
  fixed: boolean
  /** when it arrived live (Date.now()), for the pulse; undefined for a node that was there at load */
  born?: number
  /** a worker the store says is running: it breathes, and its started edges hold the neighbour level */
  running: boolean
}

interface Spring {
  a: number
  b: number
  rest: number
  kind: LineageEdge['kind']
  /** the time of its last event, when it arrived live: the active highlight runs from it */
  activeAt?: number
  /** which way its curve bends (#212), fixed per edge */
  bend: number
}

export class LineageScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private pointerPx = { x: 0, y: 0, moved: false, downX: 0, downY: 0 }
  private meshes: Record<Shape, THREE.InstancedMesh>
  private halo: THREE.Points
  private lines: THREE.LineSegments
  private particles: THREE.Points
  /** the spring of every normal particle */
  private particleEdge: number[] = []
  /** where each normal particle is along its edge, 0 at the from end */
  private particlePhase = new Float32Array(0)
  /** the extra particles of active edges: the spring each slot follows (-1 free) and its phase */
  private extraEdge = new Int32Array(ACTIVE_POOL).fill(-1)
  private extraPhase = new Float32Array(ACTIVE_POOL)
  private bodies: Body[] = []
  private edges: Spring[] = []
  private springOf = new Map<string, number>()
  // the layout: positions and velocities, flat xyz, with room to grow
  private pos = new Float32Array(0)
  private vel = new Float32Array(0)
  private nodeCap = 0
  private edgeCap = 0
  private particleCap = 0
  private shapeCap: Record<Shape, number> = { sphere: 0, box: 0, octa: 0 }
  private shapeCount: Record<Shape, number> = { sphere: 0, box: 0, octa: 0 }
  private alpha = 0
  private frame = 0
  private running = false
  private lastTouch = 0
  private hovered: Body | undefined
  private selected: string | undefined
  private neighbours = new Set<string>()
  private interactive = true
  private edgeColor = new Float32Array(0)
  /** straight lines or curves (#212), and how many line vertices each edge takes in the batch */
  private edgeMode: EdgeMode = 'straight'
  private lineVpe = 2
  /** the control point of every edge's curve, flat xyz, refreshed by place() in curved mode */
  private ctrl = new Float32Array(0)
  /** restyle every frame until this time (Date.now()): a pulse or an active edge is still changing */
  private liveUntil = 0
  private dummy = new THREE.Object3D()
  private tex = haloTexture()
  private haloMat: THREE.ShaderMaterial
  private particleMat: THREE.ShaderMaterial
  private offCanvas: (() => void)[] = []
  private runningIds = new Set<string>()
  /** the project in view (#213): foreign and shared nodes take their tint; undefined tints nothing */
  private focusProject: string | undefined

  constructor(
    private host: HTMLElement,
    private opts: SceneOptions
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(BG, 1)
    host.appendChild(this.renderer.domElement)
    this.scene.fog = new THREE.FogExp2(BG, 0.0016)
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 4000)
    this.camera.position.set(0, 40, 180)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.autoRotate = !opts.reducedMotion
    this.controls.autoRotateSpeed = 0.35
    this.controls.addEventListener('start', () => this.touch())
    this.edgeMode = opts.edgeMode ?? 'straight'
    this.lineVpe = verticesPerEdge(this.edgeMode)

    const geo: Record<Shape, THREE.BufferGeometry> = {
      sphere: new THREE.SphereGeometry(1, 20, 14),
      box: new THREE.BoxGeometry(1.6, 1.6, 1.6),
      octa: new THREE.OctahedronGeometry(1.3)
    }
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff })
    const meshes = {} as Record<Shape, THREE.InstancedMesh>
    for (const s of SHAPES) {
      const m = new THREE.InstancedMesh(geo[s], mat, 1)
      m.count = 0
      m.frustumCulled = false
      this.scene.add(m)
      meshes[s] = m
    }
    this.meshes = meshes
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(1, 2, 3)
    this.scene.add(key)

    this.haloMat = glowMaterial(this.tex, 900)
    this.halo = new THREE.Points(new THREE.BufferGeometry(), this.haloMat)
    this.halo.frustumCulled = false
    this.scene.add(this.halo)

    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.lines.frustumCulled = false
    this.scene.add(this.lines)

    this.particleMat = glowMaterial(this.tex, 260)
    this.particles = new THREE.Points(new THREE.BufferGeometry(), this.particleMat)
    this.particles.frustumCulled = false
    this.particles.visible = !opts.reducedMotion
    this.scene.add(this.particles)

    const el = this.renderer.domElement
    const move = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect()
      this.pointerPx.x = e.clientX - r.left
      this.pointerPx.y = e.clientY - r.top
      this.pointer.set((this.pointerPx.x / r.width) * 2 - 1, -(this.pointerPx.y / r.height) * 2 + 1)
      this.pointerPx.moved = true
    }
    const down = (e: PointerEvent): void => {
      this.pointerPx.downX = e.clientX
      this.pointerPx.downY = e.clientY
    }
    const up = (e: PointerEvent): void => {
      if (!this.interactive) return
      const d = Math.hypot(e.clientX - this.pointerPx.downX, e.clientY - this.pointerPx.downY)
      if (d < 4) this.opts.onClick(this.hovered?.node)
    }
    const leave = (): void => {
      this.hovered = undefined
      this.opts.onHover(undefined, 0, 0)
    }
    const wheel = (): void => this.touch()
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('wheel', wheel, { passive: true })
    this.offCanvas.push(() => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('wheel', wheel)
    })
    this.resize()
  }

  private touch(): void {
    this.lastTouch = performance.now()
    this.controls.autoRotate = false
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderOnce()
  }

  /** Where every node sits now, by id. */
  positions(): Map<string, Vec3> {
    const out = new Map<string, Vec3>()
    this.bodies.forEach((b, i) => out.set(b.node.id, [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]))
    return out
  }

  /** The project in view (#213): set before setGraph, so every body is coloured for it; a change recolours in place. */
  setFocusProject(project: string | undefined): void {
    if (project === this.focusProject) return
    this.focusProject = project
    for (const b of this.bodies) b.color = new THREE.Color(styleOf(b.node, projectRelationOf(b.node, project)).color)
    if (this.bodies.length) {
      this.restyle()
      this.renderOnce()
    }
  }

  private makeBody(node: LineageNode, degree: number, span: { oldest: number; newest: number } | undefined): Body {
    const st = styleOf(node, projectRelationOf(node, this.focusProject))
    const corvid = node.type === 'corvid'
    return {
      node,
      shape: st.shape,
      slot: this.shapeCount[st.shape]++,
      radius: radiusOf(degree, corvid),
      color: new THREE.Color(st.color),
      fade: span ? fadeOf(node.ts, span.oldest, span.newest) : 1,
      fixed: corvid,
      running: this.runningIds.has(node.id)
    }
  }

  private static springKey = (e: LineageEdge): string => `${e.from}|${e.to}|${e.kind}`

  /** The line batch for edgeCap edges in the current mode: a straight edge is one segment, a curve several. */
  private allocateLines(): void {
    this.lineVpe = verticesPerEdge(this.edgeMode)
    this.lines.geometry.dispose()
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.edgeCap * this.lineVpe * 3), 3))
    this.edgeColor = new Float32Array(this.edgeCap * this.lineVpe * 3)
    lg.setAttribute('color', new THREE.BufferAttribute(this.edgeColor, 3))
    this.lines.geometry = lg
    this.lines.geometry.setDrawRange(0, this.edges.length * this.lineVpe)
    this.ctrl = new Float32Array(this.edgeCap * 3)
  }

  /** Draw the edges straight or curved (#212). Only the line batch changes: nothing moves and nothing is reset. */
  setEdgeMode(mode: EdgeMode): void {
    if (mode === this.edgeMode) return
    this.edgeMode = mode
    if (this.edgeCap) {
      this.allocateLines()
      this.restyle()
    }
    this.renderOnce()
  }

  /**
   * Buffers for at least this many nodes, edges and particles, with slack so a few appends fit without another
   * allocation. The layout arrays, meshes and geometries are rebuilt; the next place() and restyle() refill them.
   */
  private allocate(nodes: number, edges: number, particles: number): void {
    const grow = (n: number): number => Math.max(16, Math.ceil(n * 1.5))
    if (nodes > this.nodeCap) {
      this.nodeCap = grow(nodes)
      const pos = new Float32Array(this.nodeCap * 3)
      const vel = new Float32Array(this.nodeCap * 3)
      pos.set(this.pos.subarray(0, Math.min(this.pos.length, pos.length)))
      vel.set(this.vel.subarray(0, Math.min(this.vel.length, vel.length)))
      this.pos = pos
      this.vel = vel
      this.halo.geometry.dispose()
      const hg = new THREE.BufferGeometry()
      hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.nodeCap * 3), 3))
      hg.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(this.nodeCap * 3), 3))
      hg.setAttribute('size', new THREE.BufferAttribute(new Float32Array(this.nodeCap), 1))
      this.halo.geometry = hg
    }
    for (const s of SHAPES) {
      if (this.shapeCount[s] <= this.shapeCap[s]) continue
      this.shapeCap[s] = grow(this.shapeCount[s])
      const m = this.meshes[s]
      const next = new THREE.InstancedMesh(m.geometry, m.material, this.shapeCap[s])
      next.frustumCulled = false
      this.scene.remove(m)
      m.dispose()
      this.scene.add(next)
      this.meshes[s] = next
    }
    if (edges > this.edgeCap) {
      this.edgeCap = grow(edges)
      this.allocateLines()
    }
    if (particles + ACTIVE_POOL > this.particleCap) {
      this.particleCap = grow(particles) + ACTIVE_POOL
      this.particles.geometry.dispose()
      const pg = new THREE.BufferGeometry()
      pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.particleCap * 3), 3))
      pg.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(this.particleCap * 3), 3))
      pg.setAttribute('size', new THREE.BufferAttribute(new Float32Array(this.particleCap).fill(1.6), 1))
      this.particles.geometry = pg
    }
    for (const s of SHAPES) this.meshes[s].count = this.shapeCount[s]
    this.halo.geometry.setDrawRange(0, this.bodies.length)
    this.lines.geometry.setDrawRange(0, this.edges.length * this.lineVpe)
    // the extra particles sit after the normal ones; a free slot is drawn at size 0 by moveParticles
    this.particles.geometry.setDrawRange(0, this.particleEdge.length + ACTIVE_POOL)
  }

  /** Replace the graph. Nodes already placed keep their spot, so a refresh does not reshuffle the picture;
   *  `positions` gives a spot to nodes that were not placed yet. */
  setGraph(g: LineageGraph, interactive = true, positions?: Map<string, Vec3>): void {
    this.interactive = interactive
    const old = this.positions()
    const deg = degrees(g.edges)
    const span = timeSpan(g.nodes)
    const n = g.nodes.length
    const spread = 18 + Math.cbrt(Math.max(1, n)) * 9
    this.shapeCount = { sphere: 0, box: 0, octa: 0 }
    const at = new Float32Array(n * 3)
    this.bodies = g.nodes.map((node, i) => {
      const was = old.get(node.id) ?? positions?.get(node.id)
      if (was) at.set(was, i * 3)
      else if (node.type === 'corvid') at.set([0, 0, 0], i * 3)
      else {
        // a random point in a ball, so the layout has something to untangle in every direction
        const r = spread * Math.cbrt(Math.random())
        const t = Math.random() * Math.PI * 2
        const u = Math.random() * 2 - 1
        const s = Math.sqrt(1 - u * u)
        at.set([r * s * Math.cos(t), r * u, r * s * Math.sin(t)], i * 3)
      }
      return this.makeBody(node, deg.get(node.id) ?? 0, span)
    })
    this.pos = at
    this.vel = new Float32Array(n * 3)
    this.nodeCap = 0
    const index = new Map<string, number>()
    this.bodies.forEach((b, i) => index.set(b.node.id, i))
    const keptEdge: number[] = []
    this.edges = []
    this.springOf.clear()
    g.edges.forEach((e, i) => {
      const a = index.get(e.from)
      const b = index.get(e.to)
      if (a === undefined || b === undefined) return
      const key = LineageScene.springKey(e)
      keptEdge[i] = this.edges.length
      this.springOf.set(key, this.edges.length)
      this.edges.push({ a, b, rest: restLength(e.kind), kind: e.kind, bend: bendAngle(key) })
    })
    this.particleEdge = particleEdges(g.edges)
      .map((i) => keptEdge[i])
      .filter((i) => i !== undefined)
    this.particlePhase = new Float32Array(this.particleEdge.length)
    for (let i = 0; i < this.particlePhase.length; i++) this.particlePhase[i] = Math.random()
    this.extraEdge.fill(-1)
    this.allocate(n, this.edges.length, this.particleEdge.length)

    this.selected = undefined
    this.neighbours.clear()
    this.hovered = undefined
    this.liveUntil = 0
    this.restyle()
    this.alpha = 1
    // fit the camera to the cloud, unless the user has moved it and it still sees the cloud
    const dist = 90 + spread * 3.4
    const now = this.camera.position.length()
    if (!this.lastTouch || now > dist * 2 || now < dist * 0.3) this.camera.position.setLength(dist)
    this.controls.target.set(0, 0, 0)
    this.renderOnce()
  }

  /**
   * Add what a batch brought (#210) to the running layout: the new nodes at the spots the merge gave them, the new
   * edges as springs, and a gentle reheat so the newcomers settle without the rest jumping. With `animate`, new
   * nodes pulse, new edges go active from their event time (an edge already there restarts its clock), and new
   * particles start at the from end; without it (a catch-up after the view was hidden) they just appear.
   */
  append(m: Merge, animate: boolean): void {
    const now = Date.now()
    const index = new Map<string, number>()
    this.bodies.forEach((b, i) => index.set(b.node.id, i))
    const deg = degrees(m.graph.edges)
    const span = timeSpan(m.graph.nodes)
    const byId = new Map(m.graph.nodes.map((n) => [n.id, n]))
    const fresh = m.added.map((id) => byId.get(id)).filter((n): n is LineageNode => !!n && !index.has(n.id))
    const first = this.bodies.length
    for (const node of fresh) {
      const b = this.makeBody(node, deg.get(node.id) ?? 0, span)
      if (animate && !this.opts.reducedMotion) b.born = now
      index.set(node.id, this.bodies.length)
      this.bodies.push(b)
    }
    // the bodies are counted per shape now, so the buffers can grow to fit them
    this.allocate(this.bodies.length, this.edges.length + m.addedEdges.length, this.particleEdge.length + m.addedEdges.length)
    fresh.forEach((node, k) => {
      const i = first + k
      this.pos.set(m.pos.get(node.id) ?? [0, 0, 0], i * 3)
      this.vel.fill(0, i * 3, i * 3 + 3)
    })
    // the fade is relative to the newest node, so every fade moves a little; degrees grow with the new edges
    for (const b of this.bodies) {
      b.fade = span ? fadeOf(b.node.ts, span.oldest, span.newest) : 1
      b.radius = radiusOf(deg.get(b.node.id) ?? 0, b.node.type === 'corvid')
    }
    const t = (this.frame % PARTICLE_FRAMES) / PARTICLE_FRAMES
    const wantParticle = new Set(particleEdges(m.graph.edges).map((i) => m.graph.edges[i]))
    for (const e of m.addedEdges) {
      const key = LineageScene.springKey(e)
      const had = this.springOf.get(key)
      if (had !== undefined) {
        // the same agent reading the same note again: one line, its clock restarted
        if (animate) this.edges[had].activeAt = Math.max(this.edges[had].activeAt ?? 0, e.ts)
        continue
      }
      const a = index.get(e.from)
      const b = index.get(e.to)
      if (a === undefined || b === undefined) continue
      const si = this.edges.length
      this.springOf.set(key, si)
      this.edges.push({ a, b, rest: restLength(e.kind), kind: e.kind, bend: bendAngle(key), ...(animate && { activeAt: e.ts }) })
      if (wantParticle.has(e) && this.particleEdge.length < this.particleCap - ACTIVE_POOL) {
        this.particleEdge.push(si)
        const phase = new Float32Array(this.particleEdge.length)
        phase.set(this.particlePhase)
        // starts at the from end now, or anywhere along for a catch-up
        phase[this.particleEdge.length - 1] = animate ? 0 : (t + Math.random()) % 1
        this.particlePhase = phase
      }
    }
    for (const s of SHAPES) this.meshes[s].count = this.shapeCount[s]
    this.halo.geometry.setDrawRange(0, this.bodies.length)
    this.lines.geometry.setDrawRange(0, this.edges.length * this.lineVpe)
    this.particles.geometry.setDrawRange(0, this.particleEdge.length + ACTIVE_POOL)
    if (animate) this.liveUntil = Math.max(this.liveUntil, now + ACTIVE_MS + ACTIVE_EASE_MS, now + ARRIVAL_PULSE_MS)
    if (this.selected) this.findNeighbours(this.selected)
    this.alpha = Math.max(this.alpha, fresh.length || m.addedEdges.length ? APPEND_HEAT : 0)
    this.restyle()
    this.renderOnce()
  }

  /** Which workers are running now: they breathe, and their started edges hold the neighbour level. */
  setRunning(ids: Set<string>): void {
    this.runningIds = ids
    let changed = false
    for (const b of this.bodies) {
      const r = ids.has(b.node.id)
      if (r !== b.running) changed = true
      b.running = r
    }
    if (changed) {
      this.restyle()
      this.renderOnce()
    }
  }

  private findNeighbours(id: string): void {
    this.neighbours.clear()
    const i = this.bodies.findIndex((b) => b.node.id === id)
    for (const e of this.edges) {
      if (e.a === i) this.neighbours.add(this.bodies[e.b].node.id)
      if (e.b === i) this.neighbours.add(this.bodies[e.a].node.id)
    }
  }

  /** Highlight a node and its neighbours and dim the rest; undefined clears it. */
  select(id: string | undefined): void {
    this.selected = id
    this.neighbours.clear()
    if (id) this.findNeighbours(id)
    this.restyle()
    this.renderOnce()
  }

  /** Colours for every node, halo, edge and particle: the time fade, then the pick's levels (#209): the picked node
   *  at full brightness, its neighbours and the edges to them at 90%, everything else at 20%, the fade kept inside
   *  each level. Instanced meshes and one line batch have no opacity per item, so against the dark background the
   *  colour is scaled instead, which reads the same; the levels are converted to linear light first (linearGain).
   *  On top (#210): an active edge and both its ends go to 100% (60% outside a selection) and ease back, a running
   *  worker's started edges hold 90%, and a node that just arrived glows while it pulses. */
  private restyle(): void {
    const tint = this.halo.geometry.getAttribute('tint') as THREE.BufferAttribute | undefined
    const size = this.halo.geometry.getAttribute('size') as THREE.BufferAttribute | undefined
    const lc = this.lines.geometry.getAttribute('color') as THREE.BufferAttribute | undefined
    const pt = this.particles.geometry.getAttribute('tint') as THREE.BufferAttribute | undefined
    // before the first setGraph there is nothing to colour
    if (!tint || !size || !lc || !pt) return
    const now = Date.now()
    // how active each node is: the most active edge touching it
    const nodeAct = new Float32Array(this.bodies.length)
    const edgeAct = new Float32Array(this.edges.length)
    this.edges.forEach((e, i) => {
      const a = activityOf(e.activeAt, now)
      edgeAct[i] = a
      if (a > nodeAct[e.a]) nodeAct[e.a] = a
      if (a > nodeAct[e.b]) nodeAct[e.b] = a
    })
    const c = new THREE.Color()
    this.bodies.forEach((b, i) => {
      const level = levelOf(b.node.id, this.selected, this.neighbours)
      // the body's normal look lifts the oldest off the background; the level scales that whole look
      let body = level === 'selected' ? 1 : (0.35 + 0.65 * b.fade) * linearGain(level)
      let g = level === 'selected' ? 0.9 : b.fade * 0.4 * linearGain(level)
      const act = nodeAct[i]
      if (act > 0 && level !== 'selected') {
        body += (Math.max(activeGain(level), body) - body) * act
        g += (Math.max(0.6 * activeGain(level), g) - g) * act
      }
      if (b.born !== undefined) {
        const age = now - b.born
        if (age < ARRIVAL_PULSE_MS) {
          const p = pulseScale(age) - 1
          body = Math.min(1, body + p)
          g = Math.min(1, g + p * 0.6)
        }
      }
      c.copy(b.color).multiplyScalar(body)
      this.meshes[b.shape].setColorAt(b.slot, c)
      // halos add up where nodes crowd, so they stay soft and smaller than the body for hubs
      tint.setXYZ(i, b.color.r * g, b.color.g * g, b.color.b * g)
      size.setX(i, Math.min(b.radius * (level === 'selected' ? 5 : 2.8), 14))
    })
    for (const s of SHAPES) {
      const m = this.meshes[s]
      if (m.instanceColor) m.instanceColor.needsUpdate = true
    }
    tint.needsUpdate = true
    size.needsUpdate = true
    const ec = new THREE.Color()
    const vpe = this.lineVpe
    this.edges.forEach((e, i) => {
      const a = this.bodies[e.a]
      const b = this.bodies[e.b]
      const level = edgeLevelOf(a.node.id, b.node.id, this.selected)
      // started edges are thinner: lines cannot change width, so they are fainter instead
      const base = e.kind === 'started' ? 0.22 : e.kind === 'merged' ? 0.6 : 0.42
      let w = base * Math.max(a.fade, b.fade) * linearGain(level)
      // a running worker's started edges hold the neighbour level, so you see what it works from
      if (e.kind === 'started' && b.running && level !== 'other') w = Math.max(w, base * linearGain('neighbour'))
      const act = edgeAct[i]
      if (act > 0) w += (Math.max(base * activeGain(level), w) - w) * act
      ec.copy(a.color).lerp(b.color, 0.5).multiplyScalar(w)
      // every vertex of the edge, straight or curved, takes the one colour
      for (let k = 0; k < vpe; k++) this.edgeColor.set([ec.r, ec.g, ec.b], (i * vpe + k) * 3)
    })
    lc.needsUpdate = true
    this.particleEdge.forEach((ei, i) => {
      const e = this.edges[ei]
      const level = edgeLevelOf(this.bodies[e.a].node.id, this.bodies[e.b].node.id, this.selected)
      const on = linearGain(level) + (activeGain(level) - linearGain(level)) * edgeAct[ei]
      pt.setXYZ(i, 0.9 * on, 0.95 * on, 1 * on)
    })
    // the extra particles of active edges are as bright as the edge is active
    const extraAt = this.particleEdge.length
    for (let k = 0; k < ACTIVE_POOL; k++) {
      const ei = this.extraEdge[k]
      const on = ei < 0 ? 0 : edgeAct[ei] * activeGain(edgeLevelOf(this.bodies[this.edges[ei].a].node.id, this.bodies[this.edges[ei].b].node.id, this.selected))
      pt.setXYZ(extraAt + k, 0.9 * on, 0.95 * on, 1 * on)
    }
    pt.needsUpdate = true
  }

  /** One step of the layout: repulsion between every pair within reach, springs on the edges, a pull to the centre. */
  private tick(): void {
    const n = this.bodies.length
    const p = this.pos
    const v = this.vel
    const a = this.alpha
    const rep = 160 * a
    for (let i = 0; i < n; i++) {
      const ix = i * 3
      const xi = p[ix]
      const yi = p[ix + 1]
      const zi = p[ix + 2]
      for (let j = i + 1; j < n; j++) {
        const jx = j * 3
        let dx = xi - p[jx]
        let dy = yi - p[jx + 1]
        let dz = zi - p[jx + 2]
        let d2 = dx * dx + dy * dy + dz * dz
        if (d2 < 0.01) {
          dx = (Math.random() - 0.5) * 0.1
          dy = (Math.random() - 0.5) * 0.1
          dz = (Math.random() - 0.5) * 0.1
          d2 = dx * dx + dy * dy + dz * dz
        }
        if (d2 > 3600) continue
        const f = rep / (d2 + 4)
        const fx = dx * f
        const fy = dy * f
        const fz = dz * f
        v[ix] += fx
        v[ix + 1] += fy
        v[ix + 2] += fz
        v[jx] -= fx
        v[jx + 1] -= fy
        v[jx + 2] -= fz
      }
    }
    const k = 0.06 * a
    for (const e of this.edges) {
      const ax = e.a * 3
      const bx = e.b * 3
      const dx = p[bx] - p[ax]
      const dy = p[bx + 1] - p[ax + 1]
      const dz = p[bx + 2] - p[ax + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01
      const f = ((d - e.rest) / d) * k
      v[ax] += dx * f
      v[ax + 1] += dy * f
      v[ax + 2] += dz * f
      v[bx] -= dx * f
      v[bx + 1] -= dy * f
      v[bx + 2] -= dz * f
    }
    const g = 0.012 * a
    for (let i = 0; i < n; i++) {
      const ix = i * 3
      if (this.bodies[i].fixed) {
        v[ix] = v[ix + 1] = v[ix + 2] = 0
        continue
      }
      v[ix] = (v[ix] - p[ix] * g) * 0.6
      v[ix + 1] = (v[ix + 1] - p[ix + 1] * g) * 0.6
      v[ix + 2] = (v[ix + 2] - p[ix + 2] * g) * 0.6
      p[ix] += v[ix]
      p[ix + 1] += v[ix + 1]
      p[ix + 2] += v[ix + 2]
    }
    this.alpha *= n > 800 ? 0.985 : 0.975
    if (this.alpha < 0.01) this.alpha = 0
  }

  /** Copy the layout into the meshes, halos and lines; a new node's pulse and a running worker's breathing scale
   *  the body here. */
  private place(): void {
    const hp = this.halo.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    const lp = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    // before the first setGraph the geometries are empty
    if (!hp || !lp) return
    const now = Date.now()
    const motion = !this.opts.reducedMotion
    const breath = breathScale(now)
    this.bodies.forEach((b, i) => {
      const ix = i * 3
      this.dummy.position.set(this.pos[ix], this.pos[ix + 1], this.pos[ix + 2])
      let scale = b.radius
      if (motion) {
        if (b.born !== undefined) scale *= pulseScale(now - b.born)
        if (b.running) scale *= breath
      }
      this.dummy.scale.setScalar(scale)
      this.dummy.rotation.set(0, this.frame * 0.004 + i, 0)
      this.dummy.updateMatrix()
      this.meshes[b.shape].setMatrixAt(b.slot, this.dummy.matrix)
      hp.setXYZ(i, this.pos[ix], this.pos[ix + 1], this.pos[ix + 2])
    })
    for (const s of SHAPES) this.meshes[s].instanceMatrix.needsUpdate = true
    hp.needsUpdate = true
    if (this.edgeMode === 'straight') {
      this.edges.forEach((e, i) => {
        lp.setXYZ(i * 2, this.pos[e.a * 3], this.pos[e.a * 3 + 1], this.pos[e.a * 3 + 2])
        lp.setXYZ(i * 2 + 1, this.pos[e.b * 3], this.pos[e.b * 3 + 1], this.pos[e.b * 3 + 2])
      })
    } else {
      // a quadratic curve per edge: the control point is kept for the particles, the segments go into the batch
      const segs = this.lineVpe / 2
      const p = this.pos
      this.edges.forEach((e, i) => {
        const ax = e.a * 3
        const bx = e.b * 3
        const a: Vec3 = [p[ax], p[ax + 1], p[ax + 2]]
        const b: Vec3 = [p[bx], p[bx + 1], p[bx + 2]]
        const c = controlPoint(a, b, e.bend)
        this.ctrl.set(c, i * 3)
        let px = a[0]
        let py = a[1]
        let pz = a[2]
        for (let s = 1; s <= segs; s++) {
          const t = s / segs
          const u = 1 - t
          const w0 = u * u
          const w1 = 2 * u * t
          const w2 = t * t
          const qx = w0 * a[0] + w1 * c[0] + w2 * b[0]
          const qy = w0 * a[1] + w1 * c[1] + w2 * b[1]
          const qz = w0 * a[2] + w1 * c[2] + w2 * b[2]
          const v = (i * segs + s - 1) * 2
          lp.setXYZ(v, px, py, pz)
          lp.setXYZ(v + 1, qx, qy, qz)
          px = qx
          py = qy
          pz = qz
        }
      })
    }
    lp.needsUpdate = true
  }

  /** Move the particles along their edges: the normal one per edge, faster while the edge is active, plus a few
   *  extra on each active edge from a shared pool, so the stream reads as denser. */
  private moveParticles(): void {
    const pp = this.particles.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    const ps = this.particles.geometry.getAttribute('size') as THREE.BufferAttribute | undefined
    if (!pp || !ps) return
    const now = Date.now()
    const step = 1 / PARTICLE_FRAMES
    const curved = this.edgeMode === 'curved'
    // along the straight line, or along the curve through the control point place() left for this edge
    const along = (i: number, ei: number, s: number): void => {
      const e = this.edges[ei]
      const ax = e.a * 3
      const bx = e.b * 3
      if (!curved) {
        pp.setXYZ(i, this.pos[ax] + (this.pos[bx] - this.pos[ax]) * s, this.pos[ax + 1] + (this.pos[bx + 1] - this.pos[ax + 1]) * s, this.pos[ax + 2] + (this.pos[bx + 2] - this.pos[ax + 2]) * s)
        return
      }
      const cx = ei * 3
      const u = 1 - s
      const w0 = u * u
      const w1 = 2 * u * s
      const w2 = s * s
      pp.setXYZ(
        i,
        w0 * this.pos[ax] + w1 * this.ctrl[cx] + w2 * this.pos[bx],
        w0 * this.pos[ax + 1] + w1 * this.ctrl[cx + 1] + w2 * this.pos[bx + 1],
        w0 * this.pos[ax + 2] + w1 * this.ctrl[cx + 2] + w2 * this.pos[bx + 2]
      )
    }
    const active: number[] = []
    this.particleEdge.forEach((ei, i) => {
      const e = this.edges[ei]
      const act = activityOf(e.activeAt, now)
      if (act > 0) active.push(ei)
      this.particlePhase[i] = (this.particlePhase[i] + step * (1 + (ACTIVE_PARTICLE_SPEED - 1) * act)) % 1
      along(i, ei, this.particlePhase[i])
    })
    // the extra pool: slots stay with their edge while it is active, free up after, newest edges first when short
    const base = this.particleEdge.length
    const want = new Set(active.sort((x, y) => (this.edges[y].activeAt ?? 0) - (this.edges[x].activeAt ?? 0)).slice(0, Math.floor(ACTIVE_POOL / ACTIVE_PARTICLE_EXTRA)))
    const slotsOf = new Map<number, number>()
    for (let k = 0; k < ACTIVE_POOL; k++) {
      const ei = this.extraEdge[k]
      if (ei >= 0 && !want.has(ei)) this.extraEdge[k] = -1
      else if (ei >= 0) slotsOf.set(ei, (slotsOf.get(ei) ?? 0) + 1)
    }
    let free = 0
    for (const ei of want) {
      let have = slotsOf.get(ei) ?? 0
      while (have < ACTIVE_PARTICLE_EXTRA && free < ACTIVE_POOL) {
        if (this.extraEdge[free] < 0) {
          this.extraEdge[free] = ei
          this.extraPhase[free] = (have + 1) / (ACTIVE_PARTICLE_EXTRA + 1)
          have++
        }
        free++
      }
    }
    for (let k = 0; k < ACTIVE_POOL; k++) {
      const ei = this.extraEdge[k]
      if (ei < 0) {
        ps.setX(base + k, 0)
        pp.setXYZ(base + k, 0, 0, 0)
        continue
      }
      this.extraPhase[k] = (this.extraPhase[k] + step * ACTIVE_PARTICLE_SPEED) % 1
      ps.setX(base + k, 1.3)
      along(base + k, ei, this.extraPhase[k])
    }
    pp.needsUpdate = true
    ps.needsUpdate = true
  }

  private pick(): void {
    if (!this.interactive || !this.pointerPx.moved) return
    this.pointerPx.moved = false
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(
      SHAPES.map((s) => this.meshes[s]),
      false
    )
    let found: Body | undefined
    for (const h of hits) {
      const s = SHAPES.find((x) => this.meshes[x] === h.object)
      if (s === undefined || h.instanceId === undefined) continue
      found = this.bodies.find((b) => b.shape === s && b.slot === h.instanceId)
      if (found) break
    }
    if (found !== this.hovered) {
      this.hovered = found
      this.renderer.domElement.style.cursor = found ? 'pointer' : ''
    }
    this.opts.onHover(found?.node, this.pointerPx.x, this.pointerPx.y)
  }

  private renderOnce(): void {
    this.place()
    this.renderer.render(this.scene, this.camera)
  }

  private loop = (): void => {
    if (!this.running) return
    this.frame++
    if (this.alpha > 0) {
      const steps = this.bodies.length > 800 ? 1 : 3
      for (let s = 0; s < steps && this.alpha > 0; s++) this.tick()
    }
    if (!this.opts.reducedMotion && !this.controls.autoRotate && performance.now() - this.lastTouch > IDLE_MS && !this.hovered) this.controls.autoRotate = true
    this.controls.update()
    // while an arrival pulses or an active edge eases back, the colours change every frame
    if (Date.now() < this.liveUntil) this.restyle()
    this.place()
    if (!this.opts.reducedMotion) this.moveParticles()
    this.pick()
    this.renderer.render(this.scene, this.camera)
    requestAnimationFrame(this.loop)
  }

  /** Start the frame loop; a no-op when it runs. */
  start(): void {
    if (this.running) return
    this.running = true
    requestAnimationFrame(this.loop)
  }

  /** Stop the frame loop: nothing is drawn or simulated until start(). */
  stop(): void {
    this.running = false
  }

  /** Whether the frame loop runs. */
  get active(): boolean {
    return this.running
  }

  /** How unsettled the layout still is: 0 once it has come to rest. */
  get settling(): number {
    return this.alpha
  }

  dispose(): void {
    this.stop()
    for (const off of this.offCanvas) off()
    this.controls.dispose()
    for (const s of SHAPES) {
      this.meshes[s].geometry.dispose()
      this.meshes[s].dispose()
    }
    ;(this.meshes.sphere.material as THREE.Material).dispose()
    this.halo.geometry.dispose()
    this.haloMat.dispose()
    this.lines.geometry.dispose()
    ;(this.lines.material as THREE.Material).dispose()
    this.particles.geometry.dispose()
    this.particleMat.dispose()
    this.tex.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}
