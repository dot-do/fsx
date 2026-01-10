/**
 * fsx.do Cockpit App
 *
 * A file browser interface for managing files in fsx.do.
 * Uses MDXUI Cockpit components from dotdo.
 */

// import { Cockpit, FileTree, Editor, Terminal } from '@dotdo/mdxui'
// import { FSx } from './index.js'

export default function App() {
  // TODO: Implement file browser with:
  // - FileTree component for navigation
  // - Editor component for viewing/editing files
  // - Terminal component for bash-like operations
  // - Support for drag & drop upload
  // - Real-time sync with Durable Object

  return (
    <div className="fsx-app">
      <header>
        <h1>fsx.do</h1>
        <p>Virtual filesystem on the edge</p>
      </header>

      <main>
        {/* File tree sidebar */}
        <aside className="file-tree">
          <nav>
            <ul>
              <li>/</li>
              <li>/docs</li>
              <li>/src</li>
            </ul>
          </nav>
        </aside>

        {/* Main content area */}
        <section className="content">
          <p>Select a file to view or edit</p>
        </section>
      </main>
    </div>
  )
}
