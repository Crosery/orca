// Why: a per-element infinite CSS animation keeps Chromium's frame pipeline
// awake the whole time any agent spinner is mounted (~20-30ms CPU/s measured,
// nearly independent of cadence or spinner count), and because the main window
// disables background throttling on macOS (createMainWindow.ts black-surface
// hardening) that burn continues while Orca is hidden. One shared low-rate
// clock steps every registered spinner element's transform directly, so the
// renderer idles between ticks, stops fully while the window is hidden, and
// costs the same whether one agent or fifty are working.
import { isWindowVisible } from './window-visibility-interval'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '@/components/terminal-pane/stale-document-visibility'

const SPIN_STEP_DEGREES = 30
const SPIN_STEPS = 360 / SPIN_STEP_DEGREES
// Why: 30° steps at 6Hz keeps the old animation's step size (spin read as
// smooth) at half its rate. Above ~8Hz the per-tick JS wakeups cost more than
// the CSS animation did, defeating the point — do not "smooth" by raising Hz.
export const AGENT_SPINNER_TICK_MS = 167

const elements = new Set<HTMLElement>()
let timer: ReturnType<typeof setInterval> | null = null
let step = 0
let teardownGlobalListeners: (() => void) | null = null
// Why: on macOS, disabled background throttling pins document.visibilityState
// to 'visible', so main relays the window's real hide/show state instead
// (window:visibility-changed). Assume visible until told otherwise.
let mainReportsWindowVisible = true

function currentTransform(): string {
  return `rotate(${step * SPIN_STEP_DEGREES}deg)`
}

function tick(): void {
  step = (step + 1) % SPIN_STEPS
  const transform = currentTransform()
  for (const el of elements) {
    el.style.transform = transform
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function shouldRun(): boolean {
  // Why: the stale-visibility latch proves user input arrived while the macOS
  // occlusion tracker still claims hidden — keep spinning for the user we know
  // is watching instead of freezing until the tracker recovers.
  const visible =
    (isWindowVisible() && mainReportsWindowVisible) || isDocumentVisibilityProvenStale()
  return elements.size > 0 && visible && !prefersReducedMotion()
}

function reconcile(): void {
  if (shouldRun()) {
    if (timer === null) {
      // Advance immediately so a just-restored window visibly resumes.
      tick()
      timer = setInterval(tick, AGENT_SPINNER_TICK_MS)
    }
    return
  }
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

function installGlobalListeners(): void {
  if (
    teardownGlobalListeners !== null ||
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function'
  ) {
    return
  }
  const onSignal = (): void => {
    reconcile()
  }
  document.addEventListener('visibilitychange', onSignal)
  const reducedMotionQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  reducedMotionQuery?.addEventListener?.('change', onSignal)
  const unsubscribeMainVisibility =
    typeof window !== 'undefined' && window.api?.ui?.onWindowVisibilityChanged
      ? window.api.ui.onWindowVisibilityChanged((visible) => {
          mainReportsWindowVisible = visible
          reconcile()
        })
      : null
  const unregisterStaleRecovery = registerStaleDocumentVisibilityRecovery(onSignal)
  teardownGlobalListeners = () => {
    document.removeEventListener('visibilitychange', onSignal)
    reducedMotionQuery?.removeEventListener?.('change', onSignal)
    unsubscribeMainVisibility?.()
    unregisterStaleRecovery()
  }
}

export function registerAgentSpinnerElement(el: HTMLElement): () => void {
  elements.add(el)
  // Join in phase with the shared dial so late-mounting spinners stay in sync.
  el.style.transform = currentTransform()
  installGlobalListeners()
  reconcile()
  return () => {
    elements.delete(el)
    reconcile()
    if (elements.size === 0 && teardownGlobalListeners !== null) {
      teardownGlobalListeners()
      teardownGlobalListeners = null
    }
  }
}

/** Stable React ref callback: attach to a spinner element to spin it. */
export function agentSpinnerRef(el: HTMLElement | null): (() => void) | undefined {
  if (el === null) {
    return undefined
  }
  return registerAgentSpinnerElement(el)
}

export function resetAgentSpinnerClockForTesting(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  elements.clear()
  if (teardownGlobalListeners !== null) {
    teardownGlobalListeners()
    teardownGlobalListeners = null
  }
  step = 0
  mainReportsWindowVisible = true
}
