// Copies the Africa's Talking browser WebRTC SDK to public/vendor/.
// Runs automatically after `npm install` via the `postinstall` script.
//
// Why not just `import` it? — The AT npm package has a module-caching bug
// (zombie client) that requires the SDK to be loaded via dynamic <script>
// injection rather than bundled imports. Serving it from public/ lets the
// browser load a fresh, uncached copy on every reconnect.

import { copyFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const destDir   = resolve(__dirname, '../public/vendor')
const dest      = resolve(destDir, 'africastalking.js')

// AT package may expose the browser bundle under different filenames
const candidates = [
  resolve(__dirname, '../node_modules/africastalking-client/dist/africastalking.js'),
  resolve(__dirname, '../node_modules/africastalking-client/dist/bundle.js'),
  resolve(__dirname, '../node_modules/africastalking-client/dist/index.js'),
  resolve(__dirname, '../node_modules/africastalking-client/africastalking.js'),
]

mkdirSync(destDir, { recursive: true })

const src = candidates.find(existsSync)
if (!src) {
  console.warn(
    '[copy-at-sdk] africastalking-client not found in node_modules.\n' +
    '              Run `npm install africastalking-client` then re-run this script.\n' +
    '              Looked in:\n' + candidates.map(c => '  ' + c).join('\n')
  )
  process.exit(0) // non-fatal — AT is optional; Telnyx still works without it
}

copyFileSync(src, dest)
console.log(`[copy-at-sdk] ✓ Copied ${src.split('node_modules/')[1]} → public/vendor/africastalking.js`)
