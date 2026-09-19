import { describe, expect, it } from 'vitest'
import {
  IDENTIFIER_CHARACTERS,
  InvalidDurableStringError,
  SAGA_PHASE_CHECKPOINT,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  SAGA_STEP_KEY_CHARACTERS,
  SAGA_TRIES_PREFIX,
  fitsCharacters,
  requireIdentifiersFit,
  requireSagaStepFits,
} from '../src/index.js'

describe('the width of a durable identifier', () => {
  it('is 255 characters, and a saga step key is 239', () => {
    expect({ IDENTIFIER_CHARACTERS, SAGA_STEP_KEY_CHARACTERS }).toEqual({
      IDENTIFIER_CHARACTERS: 255,
      SAGA_STEP_KEY_CHARACTERS: 239,
    })
  })

  it('counts Unicode code points, not UTF-16 units and not bytes', () => {
    const pair = '\u{1F600}'
    expect({
      'at the width': fitsCharacters('x'.repeat(255), 255),
      'one past it': fitsCharacters('x'.repeat(256), 255),
      'pairs at the width, 510 units': fitsCharacters(pair.repeat(255), 255),
      'pairs one past it': fitsCharacters(pair.repeat(256), 255),
      'a pair as the last character, 256 units': fitsCharacters(`${'x'.repeat(254)}${pair}`, 255),
      'a pair as the first character, 256 units': fitsCharacters(`${pair}${'x'.repeat(254)}`, 255),
      'a pair past the width': fitsCharacters(`${'x'.repeat(255)}${pair}`, 255),
      // A lone surrogate is one character, as it is to a string iterator.
      'lone high surrogates at the width': fitsCharacters('\ud800'.repeat(255), 255),
      'lone high surrogates one past it': fitsCharacters('\ud800'.repeat(256), 255),
      'a lone high surrogate past the width': fitsCharacters(`${'x'.repeat(255)}\ud800`, 255),
      // Low then high is two lone surrogates, never a pair.
      'low then high past the width, 256 units': fitsCharacters(
        `${'x'.repeat(254)}\udc00\ud800`,
        255,
      ),
      // Repeated, each high surrogate meets the next low one and they do pair: 129 characters.
      'low then high repeated, 256 units': fitsCharacters('\udc00\ud800'.repeat(128), 255),
      'only trailing spaces past the width': fitsCharacters(`${'x'.repeat(255)} `, 255),
    }).toEqual({
      'at the width': true,
      'one past it': false,
      'pairs at the width, 510 units': true,
      'pairs one past it': false,
      'a pair as the last character, 256 units': true,
      'a pair as the first character, 256 units': true,
      'a pair past the width': false,
      'lone high surrogates at the width': true,
      'lone high surrogates one past it': false,
      'a lone high surrogate past the width': false,
      'low then high past the width, 256 units': false,
      'low then high repeated, 256 units': true,
      'only trailing spaces past the width': false,
    })
  })

  it('agrees with a string iterator on every mix of pairs, lone surrogates and plain characters near the width', () => {
    const parts = ['x', '\u{1F600}', '\ud800', '\udc00', ' ']
    let state = 12345
    const next = () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state
    }
    for (let round = 0; round < 400; round++) {
      let raw = ''
      const characters = 250 + (next() % 12)
      for (let index = 0; index < characters; index++) raw += parts[next() % parts.length]
      expect(fitsCharacters(raw, 255), `round ${round}`).toBe([...raw].length <= 255)
    }
  })

  it('refuses the first identifier past the width in the caller’s terms, and leaves anything that is not a string alone', () => {
    const refusal = (identifiers: Record<string, unknown>) => {
      try {
        requireIdentifiersFit(identifiers)
        return 'accepted'
      } catch (error) {
        return error
      }
    }
    expect(refusal({ queue: 'q', runId: 'r'.repeat(255), taskId: undefined, other: 7 })).toBe(
      'accepted',
    )
    const refused = refusal({
      queue: 'q',
      'checkpoint.key': 'k'.repeat(256),
      runId: 'r'.repeat(300),
    })
    expect(refused).toBeInstanceOf(InvalidDurableStringError)
    expect(String((refused as Error).message)).toBe(
      'checkpoint.key is longer than the 255 characters a durable identifier holds',
    )
  })

  it('holds a step key to 239 characters where the step starts, and leaves its other saga names to the plain width', () => {
    const outcome = (name: unknown) => {
      try {
        requireSagaStepFits('checkpointName', name)
        return 'accepted'
      } catch (error) {
        return error instanceof InvalidDurableStringError ? 'refused' : String(error)
      }
    }
    const outcomes: Record<string, string> = {}
    for (const prefix of [SAGA_STARTED_PREFIX, SAGA_ROLLBACK_PREFIX, SAGA_TRIES_PREFIX]) {
      outcomes[`${prefix}<239>`] = outcome(`${prefix}${'k'.repeat(239)}`)
      outcomes[`${prefix}<240>`] = outcome(`${prefix}${'k'.repeat(240)}`)
      outcomes[`${prefix}<239 pairs>`] = outcome(`${prefix}${'\u{1F600}'.repeat(239)}`)
    }
    expect({
      ...outcomes,
      'the phase marker': outcome(SAGA_PHASE_CHECKPOINT),
      // Every name but a start marker is held to the plain width by the entry, not here.
      'a plain name of 300': outcome('k'.repeat(300)),
      'not a string': outcome(undefined),
    }).toEqual({
      '$started:<239>': 'accepted',
      '$started:<240>': 'refused',
      '$started:<239 pairs>': 'accepted',
      '$rollback:<239>': 'accepted',
      '$rollback:<240>': 'accepted',
      '$rollback:<239 pairs>': 'accepted',
      '$rollback-tries:<239>': 'accepted',
      '$rollback-tries:<240>': 'accepted',
      '$rollback-tries:<239 pairs>': 'accepted',
      'the phase marker': 'accepted',
      'a plain name of 300': 'accepted',
      'not a string': 'accepted',
    })
  })
})
