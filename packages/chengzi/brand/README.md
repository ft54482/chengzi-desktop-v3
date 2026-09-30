# dsh-plugin-chengzi-brand

Chengzi Pro's browser brand occupants. Fills the generic browser-brand holes
the shell declares — the sidebar brand row (`sidebar.brand.mark`,
`sidebar.brand.name`) and the blank-session conversation hero
(`conversation.hero.brand.mark`) — with the orange-slice mark (brand orange
`#E8732A`) and the 橙子PRO wordmark.

Registrations take shadowing priority `-1`, so they win the single-slot
election against the official whale wordmark (registered at the default rank 0
by `@deepseek-ai/dsh-client-ui-brand-official`) without clashing, and are the
only occupant in local builds where the official plugin no-ops.

## Structure

- `src/index.ts` — inert node half (Loader host row).
- `src/client/` — slot registrations plus the brand artwork components.
- `tests/` — registration/shadowing/render smoke suite (jsdom).
