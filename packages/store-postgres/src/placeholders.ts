export interface CompiledPostgresSql {
  readonly sql: string
  readonly parameterCount: number
}

function isIdentifierContinuation(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(char)
}

function dollarQuoteDelimiter(sql: string, start: number): string | null {
  if (sql[start] !== '$' || isIdentifierContinuation(sql[start - 1])) return null
  if (sql[start + 1] === '$') return '$$'

  const first = sql[start + 1]
  if (first === undefined || !/[A-Za-z_]/.test(first)) return null
  let end = start + 2
  while (/[A-Za-z0-9_]/.test(sql[end] ?? '')) end += 1
  return sql[end] === '$' ? sql.slice(start, end + 1) : null
}

/**
 * Compile the executor port's dialect-neutral `?` binds to node-postgres
 * parameters. Question marks inside PostgreSQL lexical literals and comments
 * are data, not binds, and therefore remain byte-for-byte unchanged.
 */
export function compilePostgresPlaceholders(sql: string): CompiledPostgresSql {
  let compiled = ''
  let parameterCount = 0
  let cursor = 0

  while (cursor < sql.length) {
    const char = sql[cursor] as string
    const next = sql[cursor + 1]

    if (char === "'" || char === '"') {
      const quote = char
      const start = cursor
      const escapeString =
        quote === "'" &&
        (sql[cursor - 1] === 'E' || sql[cursor - 1] === 'e') &&
        !isIdentifierContinuation(sql[cursor - 2])
      cursor += 1
      while (cursor < sql.length) {
        const quoted = sql[cursor]
        if (escapeString && quoted === '\\') {
          cursor += Math.min(2, sql.length - cursor)
          continue
        }
        if (quoted === quote) {
          if (sql[cursor + 1] === quote) {
            cursor += 2
            continue
          }
          cursor += 1
          break
        }
        cursor += 1
      }
      compiled += sql.slice(start, cursor)
      continue
    }

    if (char === '-' && next === '-') {
      const start = cursor
      cursor += 2
      while (cursor < sql.length && sql[cursor] !== '\n' && sql[cursor] !== '\r') cursor += 1
      compiled += sql.slice(start, cursor)
      continue
    }

    if (char === '/' && next === '*') {
      const start = cursor
      let depth = 1
      cursor += 2
      while (cursor < sql.length && depth > 0) {
        if (sql[cursor] === '/' && sql[cursor + 1] === '*') {
          depth += 1
          cursor += 2
        } else if (sql[cursor] === '*' && sql[cursor + 1] === '/') {
          depth -= 1
          cursor += 2
        } else {
          cursor += 1
        }
      }
      compiled += sql.slice(start, cursor)
      continue
    }

    if (char === '$') {
      const delimiter = dollarQuoteDelimiter(sql, cursor)
      if (delimiter !== null) {
        const start = cursor
        const bodyStart = cursor + delimiter.length
        const close = sql.indexOf(delimiter, bodyStart)
        cursor = close === -1 ? sql.length : close + delimiter.length
        compiled += sql.slice(start, cursor)
        continue
      }
    }

    if (char === '?') {
      parameterCount += 1
      compiled += `$${parameterCount}`
    } else {
      compiled += char
    }
    cursor += 1
  }

  return { sql: compiled, parameterCount }
}
