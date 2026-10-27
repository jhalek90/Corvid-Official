// Scrolling the board to one message (a reply's quote, an m42 in a message). The board only draws its newest
// messages (#181), so one further back may not be on the page yet: then the board is asked to draw back to it,
// and scrolls there once it has.

export const BOARD_JUMP_EVENT = 'corvid:board-jump'

/** Scrolls to the message and flashes it, or asks the board to draw back to it first. */
export function jumpToMessage(id: number): void {
  const el = document.getElementById(`mb-${id}`)
  if (!el) {
    window.dispatchEvent(new CustomEvent(BOARD_JUMP_EVENT, { detail: id }))
    return
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1200)
}
