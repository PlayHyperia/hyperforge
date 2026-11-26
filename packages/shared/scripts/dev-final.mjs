import fs from 'fs-extra'
import path from 'path'
import { execSync } from 'child_process'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import chokidar from 'chokidar'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(dirname, '../')
const buildDir = path.join(rootDir, 'build')

// Ensure build directory exists
await fs.ensureDir(buildDir)

/**
 * TypeScript Plugin for ESBuild
 */
const typescriptPlugin = {
  name: 'typescript',
  setup(build) {
    // Handle .ts and .tsx files
    build.onResolve({ filter: /\.tsx?$/ }, args => {
      return {
        path: path.resolve(args.resolveDir, args.path),
        namespace: 'file',
      }
    })
  },
}

/**
 * Run TypeScript Type Checking
 */
async function runTypeCheck() {
  console.log('Running TypeScript type checking...')
  try {
    execSync('bunx --yes tsc --noEmit', {
      stdio: 'inherit',
      cwd: rootDir,
    })
    console.log('Type checking passed ✓')
  } catch (error) {
    console.error('Type checking failed')
    // Don't exit in watch mode - continue watching for fixes
  }
}

/**
 * Compile a complete batch before publishing any output. The final atomic
 * client-file rename is Vite's commit signal, including worker-only edits.
 * This is reload coherence, not a multi-file crash-atomic filesystem commit.
 */
async function buildAll(contexts, isCurrent) {
  console.log('Rebuilding all targets...')
  const startTime = Date.now()
  let stagingDir
  let committed = false

  try {
    const outputs = new Map()
    for (const ctx of contexts) {
      const result = await ctx.rebuild()
      for (const output of result.outputFiles ?? []) {
        const relative = path.relative(buildDir, output.path)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
          throw new Error(`Build output escaped its owned directory: ${output.path}`)
        if (outputs.has(output.path))
          throw new Error(`Duplicate shared build output: ${output.path}`)
        outputs.set(output.path, output.contents)
      }
      if (!isCurrent()) return false
    }
    const clientCommit = path.join(buildDir, 'framework.client.js')
    if (!outputs.has(clientCommit)) throw new Error('Missing client build commit output')

    // Allocate unique owned staging only after every context has compiled.
    // A failed write still cannot expose a partial batch to the current page.
    stagingDir = await fs.mkdtemp(path.join(buildDir, '.dev-stage-'))
    const staged = new Map()
    for (const [target, contents] of outputs) {
      const source = path.join(stagingDir, path.relative(buildDir, target))
      await fs.outputFile(source, contents)
      staged.set(target, source)
    }
    if (!isCurrent()) return false
    for (const [target, source] of staged) {
      if (target !== clientCommit) await fs.rename(source, target)
    }
    await fs.rename(staged.get(clientCommit), clientCommit)
    committed = true
  } catch (error) {
    console.error('Shared batch failed; no client commit/reload published:', error)
  } finally {
    if (stagingDir) {
      try { await fs.remove(stagingDir) }
      catch (error) { console.error('Could not remove owned build staging:', stagingDir, error) }
    }
  }
  if (committed) console.log(`✓ Shared batch committed in ${Date.now() - startTime}ms`)
  return committed
}

/**
 * Main Dev Process with Watch Mode
 */
async function main() {
  console.log('Starting @hyperforge/shared in watch mode...')

  // Create esbuild contexts for watch mode
  const contexts = []

  // Fully bundled sibling consumed by the flattened framework Worker URL.
  const ctxGrounding = await esbuild.context({
    absWorkingDir: rootDir,
    write: false,
    entryPoints: ['src/utils/workers/GrassGroundingWorker.entry.ts'],
    outfile: 'build/grass-grounding.worker.js',
    platform: 'browser',
    format: 'esm',
    bundle: true,
    treeShaking: true,
    minify: true,
    keepNames: true,
    sourcemap: true,
    target: 'es2022',
  })
  contexts.push(ctxGrounding)

  // Build full library (server + client)
  console.log('Setting up framework.js (full) watch...')
  const ctxFull = await esbuild.context({
    absWorkingDir: rootDir,
    write: false,
    entryPoints: ['src/index.ts'],
    outfile: 'build/framework.js',
    platform: 'neutral',
    format: 'esm',
    bundle: true,
    treeShaking: true,
    minify: false,
    sourcemap: true,
    packages: 'external',
    target: 'esnext',
    loader: {
      '.ts': 'ts',
      '.tsx': 'tsx',
    },
    external: [
      './PhysXManager.server',
      './PhysXManager.server.js',
      './storage.server',
      './storage.server.js',
    ],
    plugins: [typescriptPlugin],
  })
  contexts.push(ctxFull)

  // Build server-specific modules separately
  console.log('Setting up server-specific modules watch...')
  const ctxServerPhysX = await esbuild.context({
    absWorkingDir: rootDir,
    write: false,
    entryPoints: ['src/physics/PhysXManager.server.ts'],
    outfile: 'build/PhysXManager.server.js',
    platform: 'node',
    format: 'esm',
    bundle: false,
    sourcemap: true,
    target: 'esnext',
  })
  contexts.push(ctxServerPhysX)

  const ctxServerStorage = await esbuild.context({
    absWorkingDir: rootDir,
    write: false,
    entryPoints: ['src/platform/server/storage.server.ts'],
    outfile: 'build/storage.server.js',
    platform: 'node',
    format: 'esm',
    bundle: false,
    sourcemap: true,
    target: 'esnext',
  })
  contexts.push(ctxServerStorage)

  // Build client-only library
  console.log('Setting up framework.client.js (client-only) watch...')
  const ctxClient = await esbuild.context({
    absWorkingDir: rootDir,
    write: false,
    entryPoints: ['src/index.client.ts'],
    outfile: 'build/framework.client.js',
    platform: 'browser',
    format: 'esm',
    bundle: true,
    treeShaking: true,
    minify: false,
    sourcemap: true,
    packages: 'external',
    target: 'esnext',
    loader: {
      '.ts': 'ts',
      '.tsx': 'tsx',
    },
    external: [
      './PhysXManager.server',
      './PhysXManager.server.js',
      './storage.server',
      './storage.server.js',
      'node:*',
      'os',
      'fs',
      'path',
      'url',
    ],
    plugins: [typescriptPlugin],
  })
  contexts.push(ctxClient)

  // Chokidar4 watches directories, not glob expressions. One owner covers
  // source add/change/unlink (including JSON); no independent esbuild watches.
  const sourceDir = path.join(rootDir, 'src')
  const watcher = chokidar.watch(sourceDir, {
    ignored: filepath => {
      const relative = path.relative(sourceDir, filepath)
      return /(^|[\/\\])\../.test(relative) || relative.includes('.dataless-backup-')
    },
    persistent: true,
    ignoreInitial: true,
  })
  let revision = 0, pending = true, stopped = false, debounce
  let activeBatch = null
  const drain = () => {
    if (activeBatch || stopped) return activeBatch
    activeBatch = (async () => {
      while (pending && !stopped) {
        pending = false
        const selectedRevision = revision
        const committed = await buildAll(contexts, () => !stopped && revision === selectedRevision)
        // A failed batch does not retry itself forever. Only a new observed
        // edit sets pending, including edits arriving during a failed build.
        if (committed && !pending && !stopped) await runTypeCheck()
      }
    })().finally(() => { activeBatch = null })
    return activeBatch
  }
  const changed = filepath => {
    if (stopped) return
    revision++
    pending = true
    console.log(`\n⚡ Shared source changed: ${path.relative(rootDir, filepath)}`)
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      drain()?.catch(error => console.error('Shared rebuild queue failed:', error))
    }, 100)
  }
  watcher.on('add', changed).on('change', changed).on('unlink', changed)
  watcher.on('error', error => console.error('Shared source watcher failed:', error))
  let resolveStop
  const stop = new Promise(resolve => { resolveStop = resolve })
  const shutdown = () => {
    if (stopped) return
    stopped = true
    clearTimeout(debounce)
    resolveStop()
    void Promise.all(contexts.map(ctx => ctx.cancel())).catch(error => console.error('Build cancellation failed:', error))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    await Promise.race([new Promise((resolve, reject) => {
      watcher.once('ready', resolve)
      watcher.once('error', reject)
    }), stop])
    if (stopped) return
    console.log('Running initial coherent build...')
    await drain()
    console.log('✓ Watch mode active - waiting for source changes...')
    await stop
  } finally {
    stopped = true
    clearTimeout(debounce)
    try { await watcher.close() }
    finally {
      try { await activeBatch }
      finally {
        try { await Promise.all(contexts.map(ctx => ctx.dispose())) }
        finally {
          process.removeListener('SIGINT', shutdown)
          process.removeListener('SIGTERM', shutdown)
        }
      }
    }
  }
}

// Run the dev watcher
main().catch(error => {
  console.error('Dev watch failed:', error)
  process.exit(1)
})
