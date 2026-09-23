import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  IDENTIFIER_CHARACTERS,
  PERSISTED_COUNTER_FIELDS,
  PERSISTED_TEMPORAL_FIELDS,
} from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { ENGINE_INVARIANT_CONDITIONS } from '../src/invariants.js'
import { POISON_WITNESS_COUNT, POISON_WRITE_LABELS } from '../src/poison-matrix.js'
import { PORT_STRING_PLACES } from '../src/port-strings.js'
import { SELF_CONCURRENCY_CONTESTS } from '../src/self-concurrency.js'

const repoRoot = resolve(import.meta.dirname, '../../..')

// A count DESIGN.md states for a property the code pins carries a marker straight after
// the number, `116<!-- count: engine-invariant-conditions -->`, and the test holds it to
// the constant, table or list the code pins. Every count is a value the code exports, so a
// change that moves the code and leaves the sentence fails here by the count's name.
const PINNED: Readonly<Record<string, number>> = {
  'engine-invariant-conditions': ENGINE_INVARIANT_CONDITIONS.length,
  'poison-write-labels': POISON_WRITE_LABELS.length,
  'poison-witnesses': POISON_WITNESS_COUNT,
  'poison-cells': POISON_WRITE_LABELS.length * POISON_WITNESS_COUNT,
  'durable-counter-fields': PERSISTED_COUNTER_FIELDS.length,
  'temporal-fields': PERSISTED_TEMPORAL_FIELDS.length,
  'durable-integers': PERSISTED_COUNTER_FIELDS.length + PERSISTED_TEMPORAL_FIELDS.length,
  'port-string-places': PORT_STRING_PLACES.length,
  'self-concurrency-contests': SELF_CONCURRENCY_CONTESTS,
  'identifier-characters': IDENTIFIER_CHARACTERS,
  // The widest a name of that many code points takes: two UTF-16 units, or four UTF-8 bytes.
  'identifier-utf16-units': IDENTIFIER_CHARACTERS * 2,
  'identifier-utf8-bytes': IDENTIFIER_CHARACTERS * 4,
}

const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
]

/** The number written just before a marker: digits, with or without commas, or a word. */
function statedCounts(design: string): { key: string; stated: number; text: string }[] {
  const found: { key: string; stated: number; text: string }[] = []
  for (const match of design.matchAll(/(\S+)<!-- count: ([a-z0-9-]+) -->/g)) {
    const text = match[1] as string
    const stated = /^[0-9][0-9,]*$/.test(text)
      ? Number(text.replace(/,/g, ''))
      : WORDS.indexOf(text)
    found.push({ key: match[2] as string, stated, text })
  }
  return found
}

describe('DESIGN.md counts held to the code', () => {
  it('every count with a marker equals the value the code pins', async () => {
    const design = await readFile(join(repoRoot, 'DESIGN.md'), 'utf8')
    const stated = statedCounts(design)
    expect(stated.length).toBeGreaterThan(0)
    const unknown = stated.filter(({ key }) => !(key in PINNED)).map(({ key }) => key)
    expect(unknown, 'a marker names no pinned count').toEqual([])
    const unreadable = stated.filter(({ stated: n }) => n < 0 || Number.isNaN(n))
    expect(unreadable, 'the text before a marker is not a number').toEqual([])
    const wrong = stated
      .filter(({ key, stated: n }) => PINNED[key] !== n)
      .map(({ key, text }) => `${key}: DESIGN.md says ${text}, the code pins ${PINNED[key]}`)
    expect(wrong).toEqual([])
  })

  it('every pinned count is stated at least once, so a deleted marker fails', async () => {
    const design = await readFile(join(repoRoot, 'DESIGN.md'), 'utf8')
    const present = new Set(statedCounts(design).map(({ key }) => key))
    expect(Object.keys(PINNED).filter((key) => !present.has(key))).toEqual([])
  })

  it('reads digits with commas and words, and refuses text that is neither', () => {
    expect(
      statedCounts(
        'a 3,087<!-- count: poison-cells --> b eight<!-- count: temporal-fields --> c x<!-- count: k -->',
      ),
    ).toEqual([
      { key: 'poison-cells', stated: 3087, text: '3,087' },
      { key: 'temporal-fields', stated: 8, text: 'eight' },
      { key: 'k', stated: -1, text: 'x' },
    ])
  })
})
