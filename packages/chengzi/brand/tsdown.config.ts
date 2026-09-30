import { clientBundle } from '../../client/tsdown.client.ts'

/**
 * Node half (lib/types/index.js → lib/index.js) plus the browser client half
 * (src/client/index.ts → lib/client.js, lazy-CJS factory for the client module
 * system). Same shape as the other chengzi packages: the tsc passes emit types
 * (and, for the Client build face, the lib/types tree the client bundle chains
 * its maps through); tsdown bundles each face from its own entry.
 */
export default clientBundle('dsh-plugin-chengzi-brand', ['lib/types/index.js'])
