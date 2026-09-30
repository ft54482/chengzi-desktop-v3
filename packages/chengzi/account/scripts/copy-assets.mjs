// Copy the vendor logo assets next to the bundled node half. The host route
// module resolves its asset directory by walking up from the compiled file
// (lib/index.js) to the nearest `assets/logos` directory, so the logos must
// exist under lib/ in the packed app where only the package ships.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(packageRoot, 'assets', 'logos')
const target = join(packageRoot, 'lib', 'assets', 'logos')

if (!existsSync(source)) {
  console.error(`copy-assets: missing source directory ${source}`)
  process.exit(1)
}
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`copy-assets: logos → ${target}`)
