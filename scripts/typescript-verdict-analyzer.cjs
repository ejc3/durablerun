#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
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

function staticMemberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (!ts.isElementAccessExpression(node) || !node.argumentExpression) return undefined
  const argument = unwrap(node.argumentExpression)
  return ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
    ? argument.text
    : undefined
}

function isDirectThisProperty(node, propertyName) {
  return (
    ts.isPropertyAccessExpression(node) &&
    !node.questionDotToken &&
    node.name.text === propertyName &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword
  )
}

function isDirectProperty(node, receiverName, propertyName) {
  return (
    ts.isPropertyAccessExpression(node) &&
    !node.questionDotToken &&
    node.name.text === propertyName &&
    ts.isPropertyAccessExpression(node.expression) &&
    !node.expression.questionDotToken &&
    node.expression.name.text === receiverName &&
    node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  )
}

function lexicalThisOwner(node) {
  let current = node.parent
  while (current) {
    if (ts.isArrowFunction(current)) {
      current = current.parent
      continue
    }
    if (ts.isFunctionLike(current)) return current
    current = current.parent
  }
  return undefined
}

function validRawThisOwner(node) {
  const owner = lexicalThisOwner(node)
  if (!owner) return true
  return (
    (ts.isMethodDeclaration(owner) ||
      ts.isGetAccessorDeclaration(owner) ||
      ts.isSetAccessorDeclaration(owner) ||
      ts.isConstructorDeclaration(owner)) &&
    (ts.isClassDeclaration(owner.parent) || ts.isClassExpression(owner.parent))
  )
}

function classImplementsSqlExecutor(node) {
  if (!ts.isClassDeclaration(node) || node.name?.text !== 'LibsqlExecutor') return false
  return (node.heritageClauses ?? []).some(
    (clause) =>
      clause.token === ts.SyntaxKind.ImplementsKeyword &&
      clause.types.some((type) => {
        const expression = unwrap(type.expression)
        return ts.isIdentifier(expression) && expression.text === 'SqlExecutor'
      }),
  )
}

function isCanonicalTransport(pathName, member, call) {
  if (
    pathName !== 'packages/store-libsql/src/executor.ts' ||
    !isDirectProperty(member, 'client', 'batch') ||
    call.expression !== member ||
    call.questionDotToken
  ) {
    return false
  }
  const owner = lexicalThisOwner(member.expression.expression)
  return (
    !!owner &&
    ts.isMethodDeclaration(owner) &&
    ts.isIdentifier(owner.name) &&
    owner.name.text === 'batch' &&
    classImplementsSqlExecutor(owner.parent)
  )
}

function symbolAt(checker, node) {
  return checker.getSymbolAtLocation(node)
}

function bindingSymbol(checker, name) {
  return ts.isIdentifier(name) ? symbolAt(checker, name) : undefined
}

function canonicalFencedImports(sourceFile, checker, canonicalExport) {
  const typeSymbols = new Set()
  const valueSymbols = new Set()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@durablerun/core'
    ) {
      continue
    }
    const clause = statement.importClause
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    for (const element of clause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (imported !== 'FencedBatch') continue
      const symbol = symbolAt(checker, element.name)
      if (
        !symbol ||
        (symbol.flags & ts.SymbolFlags.Alias) === 0 ||
        checker.getAliasedSymbol(symbol) !== canonicalExport
      ) {
        continue
      }
      typeSymbols.add(symbol)
      if (!clause.isTypeOnly && !element.isTypeOnly) valueSymbols.add(symbol)
    }
  }
  return { typeSymbols, valueSymbols }
}

function isCanonicalFencedReference(node, symbols, checker) {
  const expression = unwrap(node)
  return ts.isIdentifier(expression) && symbols.has(symbolAt(checker, expression))
}

function isConstDeclaration(node) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  )
}

function directFencedParameter(node, canonicalTypes, checker) {
  return (
    ts.isParameter(node) &&
    ts.isIdentifier(node.name) &&
    !!node.type &&
    ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    canonicalTypes.has(symbolAt(checker, node.type.typeName))
  )
}

function sourceOffsetMap(source) {
  const offsets = Array(source.length + 1)
  let utf16 = 0
  let codePoints = 0
  offsets[0] = 0
  for (const character of source) {
    for (let index = 0; index < character.length; index += 1) {
      offsets[utf16 + index] = codePoints
    }
    utf16 += character.length
    codePoints += 1
    offsets[utf16] = codePoints
  }
  return (position) => offsets[position]
}

function callDescriptor(kind, node, sourceFile, sourceOffset) {
  const argumentsList = node.arguments
  if (!argumentsList) {
    throw new Error(`${sourceFile.fileName}: ${kind} call has no argument list`)
  }
  const openParen = argumentsList.pos - 1
  const closeParen = node.end - 1
  if (sourceFile.text[openParen] !== '(' || sourceFile.text[closeParen] !== ')') {
    throw new Error(`${sourceFile.fileName}: ${kind} call boundary is opaque`)
  }
  return {
    kind,
    openParen: sourceOffset(openParen),
    closeParen: sourceOffset(closeParen),
    arguments: argumentsList.map((argument) => [
      sourceOffset(argument.getStart(sourceFile)),
      sourceOffset(argument.getEnd()),
    ]),
  }
}

function rootBindingSymbol(expression, checker) {
  let current = unwrap(expression)
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrap(current.expression)
  }
  return ts.isIdentifier(current) ? symbolAt(checker, current) : undefined
}

function recordWriteTarget(target, checker, writes) {
  const node = unwrap(target)
  if (ts.isIdentifier(node)) {
    const symbol = symbolAt(checker, node)
    if (symbol) writes.add(symbol)
    return
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const symbol = rootBindingSymbol(node, checker)
    if (symbol) writes.add(symbol)
    return
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = checker.getShorthandAssignmentValueSymbol(property)
        if (symbol) writes.add(symbol)
      } else if (ts.isPropertyAssignment(property)) {
        recordWriteTarget(property.initializer, checker, writes)
      } else if (ts.isSpreadAssignment(property)) {
        recordWriteTarget(property.expression, checker, writes)
      }
    }
    return
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      if (!ts.isOmittedExpression(element)) {
        recordWriteTarget(
          ts.isSpreadElement(element) ? element.expression : element,
          checker,
          writes,
        )
      }
    }
    return
  }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const element of node.elements) {
      if (ts.isBindingElement(element)) recordWriteTarget(element.name, checker, writes)
    }
  }
}

function collectWrites(sourceFile, checker, authorizationDeclarations) {
  const writes = new Set()

  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      recordWriteTarget(node.left, checker, writes)
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      recordWriteTarget(node.operand, checker, writes)
    } else if (ts.isDeleteExpression(node)) {
      recordWriteTarget(node.expression, checker, writes)
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          recordWriteTarget(declaration.name, checker, writes)
        }
      } else {
        recordWriteTarget(node.initializer, checker, writes)
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      !authorizationDeclarations.has(node)
    ) {
      recordWriteTarget(node.name, checker, writes)
    } else if (ts.isParameter(node) && node.initializer) {
      recordWriteTarget(node.name, checker, writes)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return writes
}

function batchPropertyBinding(node) {
  if (!ts.isBindingElement(node)) return false
  if (node.propertyName) {
    return (
      (ts.isIdentifier(node.propertyName) || ts.isStringLiteralLike(node.propertyName)) &&
      node.propertyName.text === 'batch'
    )
  }
  return ts.isIdentifier(node.name) && node.name.text === 'batch'
}

function analyzeBatchProgram(sources) {
  const virtualRoot = '/__durablerun_batch_analysis__'
  const canonicalCoreFile = path.posix.join(virtualRoot, '__canonical_core.d.ts')
  const sourceByFile = new Map()
  const pathByFile = new Map()
  for (const [pathName, source] of Object.entries(sources)) {
    if (typeof source !== 'string') throw new Error(`${pathName}: source must be a string`)
    const fileName = path.posix.join(virtualRoot, pathName.replaceAll('\\', '/'))
    sourceByFile.set(fileName, source)
    pathByFile.set(fileName, pathName)
  }
  sourceByFile.set(
    canonicalCoreFile,
    "declare module '@durablerun/core' { export class FencedBatch {} }\n",
  )

  const options = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
    moduleDetection: ts.ModuleDetectionKind.Force,
  }
  const fallback = ts.createCompilerHost(options, true)
  const host = {
    ...fallback,
    fileExists(fileName) {
      return sourceByFile.has(fileName) || fallback.fileExists(fileName)
    },
    readFile(fileName) {
      return sourceByFile.get(fileName) ?? fallback.readFile(fileName)
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const source = sourceByFile.get(fileName)
      if (source !== undefined) {
        return ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
      }
      return fallback.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
    },
  }
  const program = ts.createProgram({
    rootNames: [...sourceByFile.keys()],
    options,
    host,
  })
  const checker = program.getTypeChecker()
  const canonicalSource = program.getSourceFile(canonicalCoreFile)
  const canonicalModule = canonicalSource?.statements.find(
    (statement) =>
      ts.isModuleDeclaration(statement) &&
      ts.isStringLiteralLike(statement.name) &&
      statement.name.text === '@durablerun/core',
  )
  const canonicalModuleSymbol = canonicalModule
    ? symbolAt(checker, canonicalModule.name)
    : undefined
  const canonicalFencedExport = canonicalModuleSymbol
    ? checker
        .getExportsOfModule(canonicalModuleSymbol)
        .find((symbol) => symbol.name === 'FencedBatch')
    : undefined
  if (!canonicalFencedExport) {
    throw new Error('compiler did not bind the canonical @durablerun/core.FencedBatch export')
  }
  const files = {}

  for (const [fileName, pathName] of pathByFile) {
    const sourceFile = program.getSourceFile(fileName)
    if (!sourceFile) throw new Error(`${pathName}: compiler omitted source`)
    const diagnostics = (sourceFile.parseDiagnostics ?? []).map((diagnostic) => {
      const start = diagnostic.start ?? 0
      const location = sourceFile.getLineAndCharacterOfPosition(start)
      return `${location.line + 1}:${location.character + 1} ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        '\n',
      )}`
    })
    const errors = []
    const calls = []
    const sourceOffset = sourceOffsetMap(sourceFile.text)
    const allowedThisDb = new Set()
    const { typeSymbols, valueSymbols } = canonicalFencedImports(
      sourceFile,
      checker,
      canonicalFencedExport,
    )
    const authorizations = new Map()
    const authorizationDeclarations = new Set()
    let transportCalls = 0

    const reject = (message) => {
      errors.push(`batch call shape is opaque: ${message}`)
    }

    const collectAuthorizations = (node) => {
      if (ts.isNewExpression(node)) {
        const expression = unwrap(node.expression)
        const canonical = isCanonicalFencedReference(expression, valueSymbols, checker)
        if (canonical) {
          try {
            calls.push(callDescriptor('fenced', node, sourceFile, sourceOffset))
          } catch (error) {
            reject(String(error))
          }
          if (isConstDeclaration(node.parent) && node.parent.initializer === node) {
            const symbol = bindingSymbol(checker, node.parent.name)
            if (symbol) {
              authorizations.set(symbol, node.parent)
              authorizationDeclarations.add(node.parent)
            }
          }
        } else if (ts.isIdentifier(expression) && expression.text === 'FencedBatch') {
          reject('FencedBatch constructor does not resolve to @durablerun/core')
        }
      }
      if (directFencedParameter(node, typeSymbols, checker)) {
        const symbol = bindingSymbol(checker, node.name)
        if (symbol) {
          authorizations.set(symbol, node)
          authorizationDeclarations.add(node)
        }
      }
      ts.forEachChild(node, collectAuthorizations)
    }
    collectAuthorizations(sourceFile)
    const writes = collectWrites(sourceFile, checker, authorizationDeclarations)

    const validFencedRun = (call, member) => {
      if (
        !ts.isPropertyAccessExpression(member) ||
        member.questionDotToken ||
        member.name.text !== 'run' ||
        call.expression !== member ||
        call.questionDotToken ||
        call.arguments.length !== 1 ||
        !ts.isIdentifier(member.expression)
      ) {
        return false
      }
      const argument = call.arguments[0]
      if (!argument || !isDirectThisProperty(argument, 'db')) return false
      const symbol = symbolAt(checker, member.expression)
      const declaration = symbol ? authorizations.get(symbol) : undefined
      if (!symbol || !declaration || writes.has(symbol)) return false
      const thisOwner = lexicalThisOwner(argument.expression)
      const declarationOwner = lexicalThisOwner(declaration)
      if (!thisOwner || thisOwner !== declarationOwner) return false
      allowedThisDb.add(argument)
      return true
    }

    const inspect = (node) => {
      if (batchPropertyBinding(node)) {
        reject('destructured batch member is opaque')
      }

      if (ts.isCallExpression(node)) {
        const member = node.expression
        if (
          (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
          staticMemberName(member) === 'batch'
        ) {
          if (
            isDirectProperty(member, 'db', 'batch') &&
            !node.questionDotToken &&
            validRawThisOwner(member.expression.expression)
          ) {
            calls.push(callDescriptor('raw', node, sourceFile, sourceOffset))
            allowedThisDb.add(member.expression)
          } else if (isCanonicalTransport(pathName, member, node)) {
            transportCalls += 1
          } else {
            reject('indirect batch member is opaque')
          }
        }
        if (
          (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
          staticMemberName(member) === 'run' &&
          node.arguments.some(
            (argument) =>
              ts.isPropertyAccessExpression(argument) && isDirectThisProperty(argument, 'db'),
          ) &&
          !validFencedRun(node, member)
        ) {
          reject('this.db may only reach an immutable canonical FencedBatch')
        }
      }

      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        staticMemberName(node) === 'batch'
      ) {
        if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) {
          reject(
            isDirectProperty(node, 'db', 'batch')
              ? 'indirect this.db.batch reference is opaque'
              : 'indirect batch member is opaque',
          )
        }
      }
      ts.forEachChild(node, inspect)
    }
    inspect(sourceFile)

    const validateThis = (node) => {
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        if (
          !ts.isPropertyAccessExpression(node.parent) ||
          node.parent.expression !== node ||
          node.parent.questionDotToken
        ) {
          reject('indirect this reference is opaque')
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        isDirectThisProperty(node, 'db') &&
        !allowedThisDb.has(node)
      ) {
        reject('indirect this.db.batch reference is opaque')
      }
      ts.forEachChild(node, validateThis)
    }
    validateThis(sourceFile)

    if (pathName === 'packages/store-libsql/src/executor.ts' && transportCalls !== 1) {
      reject(`LibsqlExecutor.batch must own exactly one transport call (found ${transportCalls})`)
    }

    files[pathName] = {
      diagnostics,
      errors: [...new Set(errors)],
      batchCalls: calls.sort((left, right) => left.openParen - right.openParen),
    }
  }
  return { files }
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  if (!input || typeof input !== 'object' || !input.sources || typeof input.sources !== 'object') {
    throw new Error('expected {"sources": {"path.ts": "source"}}')
  }
  if (input.analysis === 'batches') {
    process.stdout.write(`${JSON.stringify(analyzeBatchProgram(input.sources))}\n`)
    return
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
