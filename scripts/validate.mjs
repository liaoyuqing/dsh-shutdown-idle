/**
 * CI sanity gate — no dependencies, runs with plain node.
 * Validates the package manifest shape that `dsh plugin add` requires, plus
 * syntax of both halves.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const check = (ok, message) => { if (!ok) problems.push(message) }

check(typeof pkg.name === 'string' && pkg.name.length > 0, 'package.json: name missing')
check(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), 'package.json: version must be semver')
check(pkg.license === 'MIT', 'package.json: license must be MIT')
check(pkg.type === 'module', 'package.json: type must be module')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json: dsh.bundle.patch must be ./cordis.patch.yml')
check(pkg.dsh?.client?.platform === 'web', 'package.json: dsh.client.platform must be web')
check(pkg.exports?.['.'] === pkg.main, 'package.json: exports["."] must equal main (the host half)')
check(pkg.exports?.['./client'] === './client.js', 'package.json: exports["./client"] must point at the browser half')
check(pkg.exports?.['./package.json'] === './package.json', 'package.json: exports["./package.json"] required by resolvers')
check(pkg.repository?.url?.includes('liaoyuqing/dsh-shutdown-idle'), 'package.json: repository must point at the public repo')
check(!pkg.dependencies && !pkg.devDependencies, 'package.json: keep zero runtime deps (git installs need no build)')
check(typeof pkg.main === 'string' && existsSync(join(root, pkg.main)), 'package.json: main must name an existing host half')
check(existsSync(join(root, 'client.js')), 'client.js missing')
check(existsSync(join(root, 'cordis.patch.yml')), 'bundle cordis.patch.yml missing')
check(existsSync(join(root, 'LICENSE')), 'LICENSE missing')
check(existsSync(join(root, 'README.md')), 'README.md missing')
check(existsSync(join(root, 'README.en.md')), 'README.en.md missing')

const bundlePatch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
check(/- insert:/.test(bundlePatch), 'bundle patch: must start with an insert list')
check(/id: shutdown-idle/.test(bundlePatch), 'bundle patch: must insert id shutdown-idle')
check(bundlePatch.includes('name: ' + pkg.name), 'bundle patch: row name must equal the package name')

const client = readFileSync(join(root, 'client.js'), 'utf8')
check(client.startsWith('//') || client.startsWith('window.'), 'client.js: must not carry a BOM (breaks combo concatenation)')
check(client.charCodeAt(0) !== 0xFEFF, 'client.js: BOM stripped required')
check(client.includes(`id: "${pkg.name}"`), 'client.js: bundle registration id must equal the package name')

const host = readFileSync(join(root, pkg.main), 'utf8')
check(host.includes(`export const name = '${pkg.name}'`), 'host: plugin name export mismatch')
// The host half reaches the same-origin API the browser half calls; the route
// prefix is the contract between the two halves.
check(host.includes("const UI_PATH = '/dsh-shutdown'"), 'host: UI_PATH must stay /dsh-shutdown')

for (const file of [pkg.main, 'client.js']) {
  execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' })
}

if (problems.length > 0) {
  console.error('validate: FAIL')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('validate: OK (' + pkg.name + ' ' + pkg.version + ')')
