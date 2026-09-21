import fs from 'fs-extra'
import path from 'path'
import { execSync } from 'child_process'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'

const dev = process.argv.includes('--dev')
const typecheck = !process.argv.includes('--no-typecheck')
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
  if (!typecheck) return

  console.log('Running TypeScript type checking...')
  execSync(`"${process.execPath}" x --yes tsc --noEmit`, {
    stdio: 'inherit',
    cwd: rootDir,
  })
  console.log('Type checking passed ✓')
}

/**
 * Build Library
 */
async function buildLibrary() {
  console.log('Building library...')

  // A real browser Worker must not inherit framework's external packages.
  // Emit before the flattened client, whose literal URL resolves this sibling.
  await esbuild.build({
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

  // Build full library (server + client)
  console.log('Building framework.js (full)...')
  const ctxFull = await esbuild.context({
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
    // Mark server-specific modules as external so they can be dynamically imported
    // These paths are relative to the build output location
    external: [
      './PhysXManager.server',
      './PhysXManager.server.js',
      './storage.server',
      './storage.server.js',
    ],
    plugins: [typescriptPlugin],
  })

  await ctxFull.rebuild()
  await ctxFull.dispose()
  console.log('✓ framework.js built successfully')

  // Build server-specific modules separately
  console.log('Building server-specific modules...')
  const ctxServerPhysX = await esbuild.context({
    entryPoints: ['src/physics/PhysXManager.server.ts'],
    outfile: 'build/PhysXManager.server.js',
    platform: 'node',
    format: 'esm',
    bundle: false,
    sourcemap: true,
    target: 'esnext',
  })
  await ctxServerPhysX.rebuild()
  await ctxServerPhysX.dispose()

  const ctxServerStorage = await esbuild.context({
    entryPoints: ['src/platform/server/storage.server.ts'],
    outfile: 'build/storage.server.js',
    platform: 'node',
    format: 'esm',
    bundle: false,
    sourcemap: true,
    target: 'esnext',
  })
  await ctxServerStorage.rebuild()
  await ctxServerStorage.dispose()
  console.log('✓ Server-specific modules built successfully')

  // Build client-only library (no Node.js modules)
  console.log('Building framework.client.js (client-only)...')
  const ctxClient = await esbuild.context({
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
    // Mark server-specific modules as external so they're not bundled
    // These paths are relative to the build output location
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

  await ctxClient.rebuild()
  await ctxClient.dispose()
  console.log('✓ framework.client.js built successfully')

  console.log('✓ All library builds completed')
}

/**
 * Generate TypeScript Declaration Files
 *
 * Always runs regardless of --no-typecheck, because downstream packages
 * (e.g. plugin-hyperia) need framework.d.ts to compile.
 */
async function generateDeclarations() {
  console.log('Generating TypeScript declarations...')

  // Generate declaration files using tsc (--skipLibCheck for speed when --no-typecheck)
  console.log('Creating type definitions...')
  // Always use --skipLibCheck for declaration generation because circular
  // dependencies (e.g. shared ↔ procgen) mean external package .d.ts
  // files may not exist yet during the build pipeline. Source declaration
  // errors remain fatal so downstream packages never consume partial types.
  execSync(
    `"${process.execPath}" x --yes tsc --emitDeclarationOnly --outDir build --skipLibCheck`,
    {
      stdio: 'inherit',
      cwd: rootDir,
    },
  )
  console.log('✓ Declaration files generated')

  // Copy index.d.ts to build root as framework.d.ts
  // tsc with --outDir build and rootDir src creates build/index.d.ts
  const indexDts = path.join(buildDir, 'index.d.ts')
  const frameworkDts = path.join(buildDir, 'framework.d.ts')

  if (await fs.pathExists(indexDts)) {
    await fs.copy(indexDts, frameworkDts)
    console.log('✓ Copied index.d.ts to framework.d.ts')
  } else {
    throw new Error(`Declaration entrypoint not found at ${indexDts}`)
  }
}

/**
 * Main Build Process
 */
async function main() {
  console.log(
    `Building @hyperforge/shared in ${dev ? 'development' : 'production'} mode...`,
  )

  await buildLibrary()

  if (!dev) {
    await generateDeclarations()
  } else {
    await runTypeCheck()
  }

  console.log('Build completed successfully!')
}

// Run the build
main().catch(error => {
  console.error('Build failed:', error)
  process.exit(1)
})
