import { clientBundle } from '../../client/tsdown.client.ts'

/**
 * Node half (lib/types/index.js → lib/index.js) plus the browser client half
 * (src/client/index.ts → lib/client.js, lazy-CJS factory for the client module
 * system). The client face bundles src/client directly, so the package's tsc
 * pass only has to emit types + the node tree first.
 */
export default clientBundle('dsh-plugin-chengzi-account', ['lib/types/index.js'])
