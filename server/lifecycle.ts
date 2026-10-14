export type Lifecycle = { draining: boolean; active: Set<AbortController> }
export function createLifecycle(): Lifecycle { return { draining: false, active: new Set() } }
