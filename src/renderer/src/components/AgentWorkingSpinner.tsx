import React from 'react'
import { cn } from '@/lib/utils'
import { agentSpinnerRef } from '@/lib/agent-spinner-clock'

// Why: the working-state ring must not carry its own infinite CSS animation —
// that keeps the compositor awake per element (and, with macOS background
// throttling disabled, keeps burning while the window is hidden). The shared
// agent-spinner clock rotates every mounted ring in phase and stops cleanly
// when nothing can be seen. Callers size it via className (size-2 etc.).
export function AgentWorkingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      ref={agentSpinnerRef}
      data-agent-spinner=""
      className={cn(
        'block rounded-full border-2 border-yellow-500 border-t-transparent',
        className
      )}
    />
  )
}
