import {
  type SqlExecutor,
  decodeTaskOutcome,
  isTerminalState,
  taskDoneEventName,
  taskIdOfDoneEvent,
} from '@durablerun/core'
import { eventKey } from './invariants.js'

/** What `childTaskViolations` says of a terminal task that has no completion event. */
export function missingCompletionEvent(taskId: string): string {
  return `terminal-task-without-completion-event: ${taskId}`
}

/**
 * What specs/ChildTasks.tla requires of any history the engine itself produced, read
 * from the shared schema. It is not part of the invariant library, because that library
 * also judges states the poison matrix writes by hand, and a hand-written terminal task
 * has no batch that could have written its event. Every walk and scenario whose rows
 * only the engine wrote runs this beside the library.
 *
 * - TerminalImpliesDone: a terminal task has its completion event, in its own queue.
 * - DoneAuthority, as far as rows can show it: a completion event names a task of its
 *   queue, and its payload is an outcome `encodeTaskOutcome` wrote.
 */
export async function childTaskViolations(raw: SqlExecutor): Promise<string[]> {
  const [tasks, events] = await raw.batch(
    'child-task-violations',
    [
      { sql: 'SELECT task_id, queue, state FROM tasks', args: [] },
      { sql: 'SELECT queue, event_name, payload FROM events', args: [] },
    ],
    'read',
  )
  const violations: string[] = []
  const done = new Map<string, { eventName: string; payload: string }>()
  for (const event of events?.rows ?? []) {
    const eventName = String(event.event_name)
    if (taskIdOfDoneEvent(eventName) === null) continue
    done.set(eventKey(String(event.queue), eventName), {
      eventName,
      payload: String(event.payload),
    })
  }
  for (const task of tasks?.rows ?? []) {
    const taskId = String(task.task_id)
    const key = eventKey(String(task.queue), taskDoneEventName(taskId))
    const event = done.get(key)
    done.delete(key)
    if (event === undefined) {
      if (isTerminalState(task.state)) {
        violations.push(missingCompletionEvent(taskId))
      }
      continue
    }
    try {
      decodeTaskOutcome(taskId, event.payload)
    } catch (error) {
      violations.push(`completion-event-undecodable: ${taskId}: ${String(error)}`)
    }
  }
  for (const { eventName } of done.values()) {
    violations.push(`completion-event-without-task: ${eventName}`)
  }
  return violations
}
