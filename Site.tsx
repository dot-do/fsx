/**
 * fsx.do Marketing Site
 *
 * Landing page for the fsx.do managed filesystem service.
 * Uses MDXUI Beacon components from dotdo.
 */

// import { Hero, Features, CodeBlock, CTA } from '@dotdo/mdxui'

export default function Site() {
  return (
    <div className="fsx-site">
      {/* Hero Section */}
      <section className="hero">
        <h1>fsx.do</h1>
        <p className="tagline">Virtual Filesystem on the Edge</p>
        <p className="description">
          A POSIX-like filesystem backed by Cloudflare Durable Objects
          with tiered storage and zero cold starts.
        </p>
      </section>

      {/* Features */}
      <section className="features">
        <div className="feature">
          <h3>POSIX-compatible API</h3>
          <p>
            Familiar Node.js fs-like interface with read, write, mkdir,
            readdir, stat, and more.
          </p>
        </div>

        <div className="feature">
          <h3>Tiered Storage</h3>
          <p>
            Automatic placement across hot (SQLite), warm (R2), and cold
            (archive) tiers for cost optimization.
          </p>
        </div>

        <div className="feature">
          <h3>Edge-Native</h3>
          <p>
            Runs on Cloudflare's global network with sub-millisecond
            latency and zero cold starts.
          </p>
        </div>

        <div className="feature">
          <h3>Unix Utilities</h3>
          <p>
            Built-in glob, grep, and find utilities for powerful file
            operations without external dependencies.
          </p>
        </div>
      </section>

      {/* Code Example */}
      <section className="example">
        <h2>Quick Start</h2>
        <pre><code>{`
import { FSx } from 'fsx.do'

const fs = new FSx(env.FSX)

// Write files
await fs.write('/config.json', JSON.stringify({ key: 'value' }))

// Read files
const content = await fs.read('/config.json', { encoding: 'utf-8' })

// List directories
const files = await fs.list('/src', { recursive: true })

// Pattern matching
const matches = await fs.glob('/src/**/*.ts')
        `.trim()}</code></pre>
      </section>

      {/* CTA */}
      <section className="cta">
        <h2>Get Started</h2>
        <p>
          Install @dotdo/fsx for the pure library, or use fsx.do for the
          managed service with DO storage.
        </p>
        <div className="buttons">
          <a href="https://github.com/dotdo/fsx" className="button primary">
            View on GitHub
          </a>
          <a href="/docs" className="button secondary">
            Read the Docs
          </a>
        </div>
      </section>
    </div>
  )
}
