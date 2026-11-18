// Runs the same test files on Bun (node:test) and on Node.js (Vitest).
type Run = () => void | Promise<void>

interface Harness {
  readonly test: (name: string, run: Run) => void
  /** A named rule that is not testable yet. It is reported as pending, never as passing. */
  readonly todo: (name: string) => void
}

const load = async (): Promise<Harness> => {
  if (process.versions.bun) {
    const runner = await import("node:test")

    return { test: (name, run) => runner.test(name, run), todo: (name) => runner.test(name, { todo: true }, () => {}) }
  }

  const runner = await import("vitest")

  return { test: (name, run) => runner.test(name, run), todo: (name) => runner.test.todo(name) }
}

export const { test, todo } = await load()
