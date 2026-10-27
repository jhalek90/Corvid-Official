// One registry per socket type (#102). Every entry belongs to the extension that added it, so turning an extension off
// removes all it registered in one call. Plain data and functions: no access to anything else in Corvid.

export interface Entry<T> {
  /** the extension id that registered it */
  owner: string
  item: T
}

export interface Registry<T> {
  /** Adds an entry for `owner`; refuses a key that is already taken. Returns the unregister function. */
  add: (owner: string, item: T) => () => void
  list: () => Entry<T>[]
  get: (key: string) => Entry<T> | undefined
  /** Removes everything `owner` registered. */
  removeOwner: (owner: string) => void
  clear: () => void
}

export function createRegistry<T>(socket: string, keyOf: (item: T) => string): Registry<T> {
  const entries = new Map<string, Entry<T>>()
  return {
    add: (owner, item) => {
      const key = keyOf(item)
      const had = entries.get(key)
      if (had) throw new Error(`${socket} "${key}" is already registered${had.owner === owner ? '' : ` by ${had.owner}`}.`)
      const e = { owner, item }
      entries.set(key, e)
      return () => void (entries.get(key) === e && entries.delete(key))
    },
    list: () => [...entries.values()],
    get: (key) => entries.get(key),
    removeOwner: (owner) => {
      for (const [k, e] of entries) if (e.owner === owner) entries.delete(k)
    },
    clear: () => entries.clear()
  }
}
