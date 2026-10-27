// Whether a remote can be pushed to (#143). A Corvid install made by `npm run setup` keeps the public repo as the
// remote "upstream" with its push URL set to DISABLED, so Corvid never pushes there and never counts commits
// "ahead" of it as unpushed.

/** The push URL setup gives the public repo's remote. */
export const PUSH_DISABLED = 'DISABLED'

/** True when `git remote get-url --push <remote>` printed a URL that can actually take a push. */
export const canPushTo = (pushUrl: string | undefined): boolean => {
  const u = pushUrl?.trim()
  return !!u && u.toUpperCase() !== PUSH_DISABLED && u.toLowerCase() !== 'no_push'
}
