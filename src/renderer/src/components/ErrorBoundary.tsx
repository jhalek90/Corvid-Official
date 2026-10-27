import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { api } from '../api'

// Error boundaries (#83): an error while one part of the window draws shows a small panel there, with the details,
// Try again and Reload, while the rest keeps working. Without them React drops the whole tree: a blank window.
// Every caught error goes to crash.log in the data folder.

interface Props {
  /** what this part is called in the panel and in crash.log, e.g. "Tasks" */
  area: string
  children: ReactNode
  /** a floating panel, for parts that overlay the window (dialogs, the ticker) instead of filling a space */
  floating?: boolean
  /** extra clean-up on Try again, e.g. closing the editor that broke */
  onReset?: () => void
}

interface State {
  error?: Error
  stack?: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const e = error instanceof Error ? error : new Error(String(error))
    this.setState({ stack: info.componentStack ?? undefined })
    console.error(`[${this.props.area}]`, e, info.componentStack)
    reportError(`Error in ${this.props.area}: ${e.message}`, `${e.stack ?? ''}\nComponent stack:${info.componentStack ?? ' (none)'}`)
  }

  reset = (): void => {
    this.props.onReset?.()
    this.setState({ error: undefined, stack: undefined })
  }

  render(): ReactNode {
    const { error, stack } = this.state
    if (!error) return this.props.children
    return (
      <div className={`crash-panel${this.props.floating ? ' floating' : ''}`} role="alert">
        <div className="crash-head">
          <TriangleAlert size={15} />
          <b>Something went wrong here</b>
          <span className="muted">{this.props.area}</span>
        </div>
        <p className="muted">The rest of Corvid keeps working, and agents keep running. The details are in crash.log.</p>
        <div className="crash-actions">
          <button className="btn sm" onClick={this.reset}>
            Try again
          </button>
          <button className="btn sm" onClick={() => location.reload()}>
            Reload window
          </button>
          <button className="btn sm ghost" onClick={() => void api.openCrashLog()}>
            Open crash.log
          </button>
        </div>
        <details>
          <summary>Error details</summary>
          <pre>{`${error.message}\n\n${error.stack ?? ''}${stack ? `\n\nComponent stack:${stack}` : ''}`}</pre>
        </details>
      </div>
    )
  }
}

/** Sends an error to crash.log; never throws, since it runs while something else already failed. */
export function reportError(what: string, details: string): void {
  try {
    api.reportError(what, details)
  } catch {
    /* the bridge is gone: nothing more to do */
  }
}

/** Errors outside React's drawing (event handlers, timers, promises) don't blank the window, but they're logged. */
export function catchWindowErrors(): void {
  window.addEventListener('error', (e) => reportError(`Uncaught error: ${e.message}`, (e.error as Error | undefined)?.stack ?? `${e.filename}:${e.lineno}`))
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | undefined
    reportError(`Unhandled promise rejection: ${r?.message ?? String(e.reason)}`, r?.stack ?? '')
  })
}
