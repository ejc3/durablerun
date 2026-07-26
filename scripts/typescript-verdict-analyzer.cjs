#!/usr/bin/env node

const fs = require('node:fs')
const ts = require('typescript')

const VERDICT_HELPERS = new Set([
  'attributeExpectedFailure',
  'attributeReplacedFailure',
  'requireExpectedFailure',
])
const MUTATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERDICT_MARKER = /^mutation-verdict:(?:behavior|construction):[a-z0-9]+(?:[-:][a-z0-9]+)*$/

function unwrap(expression) {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function bareCallName(node) {
  if (!ts.isCallExpression(node)) return undefined
  const callee = unwrap(node.expression)
  return ts.isIdentifier(callee) ? callee.text : undefined
}

function promiseModifier(node) {
  let current = node
  let parent = current.parent
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent))
  ) {
    current = parent
    parent = current.parent
  }
  if (!parent || !ts.isPropertyAccessExpression(parent) || parent.expression !== current) {
    return undefined
  }
  return parent.name.text === 'rejects' || parent.name.text === 'resolves'
    ? parent.name.text
    : undefined
}

function literalProperty(property) {
  if (!ts.isPropertyAssignment(property)) return undefined
  const name = property.name
  const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined
  const value = unwrap(property.initializer)
  if (
    key === undefined ||
    (!ts.isStringLiteralLike(value) && !ts.isNoSubstitutionTemplateLiteral(value))
  ) {
    return undefined
  }
  return [key, value.text]
}

function verdictDescriptor(argument) {
  const value = unwrap(argument)
  if (!ts.isObjectLiteralExpression(value)) return undefined
  const fields = new Map()
  for (const property of value.properties) {
    const field = literalProperty(property)
    if (!field || fields.has(field[0])) return undefined
    fields.set(field[0], field[1])
  }
  if (fields.size !== 2) return undefined
  const kind = fields.get('kind')
  const mutation = fields.get('mutation')
  if (
    (kind !== 'behavior' && kind !== 'construction') ||
    !mutation ||
    !MUTATION_NAME.test(mutation)
  ) {
    return undefined
  }
  return [kind, mutation]
}

function analyze(path, source) {
  const modulePrefix = 'export {}\n'
  const sourceFile = ts.createSourceFile(
    path,
    `${modulePrefix}${source}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const diagnostics = (sourceFile.parseDiagnostics ?? []).map((diagnostic) => {
    const start = diagnostic.start ?? 0
    const location = sourceFile.getLineAndCharacterOfPosition(start)
    return `${location.line}:${location.character + 1} ${ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      '\n',
    )}`
  })
  const promiseMessageLines = new Set()
  const descriptors = new Map()
  const directMarkers = new Set()

  function visit(node) {
    if (
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      VERDICT_MARKER.test(node.text)
    ) {
      directMarkers.add(node.text)
    }
    const name = bareCallName(node)
    if (name === 'expect' && node.arguments.length > 1 && promiseModifier(node)) {
      promiseMessageLines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line)
    }
    if (name && VERDICT_HELPERS.has(name) && node.arguments.length > 0) {
      const descriptor = verdictDescriptor(node.arguments[0])
      if (descriptor) descriptors.set(descriptor.join(':'), descriptor)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return {
    diagnostics,
    promiseMessageLines: [...promiseMessageLines].sort((left, right) => left - right),
    helperVerdictDescriptors: [...descriptors.values()].sort((left, right) =>
      left.join(':').localeCompare(right.join(':')),
    ),
    directVerdictMarkers: [...directMarkers].sort(),
  }
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  if (!input || typeof input !== 'object' || !input.sources || typeof input.sources !== 'object') {
    throw new Error('expected {"sources": {"path.ts": "source"}}')
  }
  const files = {}
  for (const [path, source] of Object.entries(input.sources)) {
    if (typeof source !== 'string') throw new Error(`${path}: source must be a string`)
    files[path] = analyze(path, source)
  }
  process.stdout.write(`${JSON.stringify({ files })}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`typescript-verdict-analyzer: ${String(error)}\n`)
  process.exitCode = 1
}
