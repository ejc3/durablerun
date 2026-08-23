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
const VERDICT_MARKER_SOURCE =
  'mutation-verdict:(?:behavior|construction):[a-z0-9]+(?:[-:][a-z0-9]+)*'
const VERDICT_MARKER = new RegExp(`^${VERDICT_MARKER_SOURCE}$`)
const VERDICT_MARKER_BOUNDARY = String.raw`[\p{ID_Continue}$:-]`
const EXPECT_ERROR_VERDICT_MARKER = new RegExp(
  `(?<!${VERDICT_MARKER_BOUNDARY})${VERDICT_MARKER_SOURCE}(?!${VERDICT_MARKER_BOUNDARY})`,
  'gu',
)
const STATIC_VITEST_MODIFIERS = new Set([
  'concurrent',
  'fails',
  'only',
  'sequential',
  'skip',
  'todo',
])

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

function importDeclaration(node) {
  let current = node
  while (current && !ts.isImportDeclaration(current)) current = current.parent
  return current
}

function isCanonicalVerdictHelper(pathName, identifier, helperName, checker) {
  const symbol = checker.getSymbolAtLocation(identifier)
  if (!symbol) return false
  return (symbol.declarations ?? []).some((declaration) => {
    if (!ts.isImportSpecifier(declaration)) return false
    const imported = declaration.propertyName?.text ?? declaration.name.text
    const statement = importDeclaration(declaration)
    if (
      imported !== helperName ||
      declaration.name.text !== helperName ||
      !statement ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      return false
    }
    const moduleName = statement.moduleSpecifier.text
    return (
      moduleName === '@durablerun/core/testing' ||
      (pathName.startsWith('packages/core/test/') && moduleName === '../src/testing.js')
    )
  })
}

function canonicalVitestRegistration(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier)
  if (!symbol) return undefined
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isImportSpecifier(declaration)) continue
    const imported = declaration.propertyName?.text ?? declaration.name.text
    const statement = importDeclaration(declaration)
    if (
      (imported !== 'describe' && imported !== 'it' && imported !== 'test') ||
      !statement ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'vitest'
    ) {
      continue
    }
    return imported
  }
  return undefined
}

function vitestRegistration(expression, checker) {
  let current = unwrap(expression)
  let parameterized = false
  while (ts.isPropertyAccessExpression(current)) {
    if (current.name.text === 'each') {
      parameterized = true
    } else if (!STATIC_VITEST_MODIFIERS.has(current.name.text)) {
      return undefined
    }
    current = unwrap(current.expression)
  }
  if (ts.isCallExpression(current)) {
    const inner = vitestRegistration(current.expression, checker)
    return inner ? { ...inner, parameterized: true } : undefined
  }
  if (!ts.isIdentifier(current)) return undefined
  const kind = canonicalVitestRegistration(current, checker)
  return kind ? { kind, parameterized } : undefined
}

function staticTitle(argument) {
  const value = argument && unwrap(argument)
  return value && (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value))
    ? value.text
    : undefined
}

function analyze(path, sourceFile, checker) {
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
  const expectErrorMarkers = []
  const behaviorTitleOwners = new Map()
  const dynamicBehaviorTitleMarkers = new Set()

  for (const directive of sourceFile.commentDirectives ?? []) {
    if (directive.type !== ts.CommentDirectiveType.ExpectError) continue
    const comment = sourceFile.text.slice(directive.range.pos, directive.range.end)
    const directiveOffset = comment.indexOf('@ts-expect-error')
    if (directiveOffset === -1) continue
    const directiveLine = comment.slice(directiveOffset).split(/\r?\n/, 1)[0]
    const matches = [...directiveLine.matchAll(EXPECT_ERROR_VERDICT_MARKER)]
    if (matches.length > 1) {
      const line = sourceFile.getLineAndCharacterOfPosition(directive.range.pos).line
      diagnostics.push(
        `${line}:1 @ts-expect-error directive owns ${matches.length} verdict markers`,
      )
    }
    for (const match of matches) {
      directMarkers.add(match[0])
      const position = directive.range.pos + directiveOffset + (match.index ?? 0)
      const line = sourceFile.getLineAndCharacterOfPosition(position).line
      expectErrorMarkers.push([match[0], line])
    }
  }
  const markerCounts = new Map()
  for (const [marker] of expectErrorMarkers) {
    markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1)
  }
  for (const [marker, count] of markerCounts) {
    if (count > 1) diagnostics.push(`${marker} appears on ${count} @ts-expect-error directives`)
  }

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
      if (descriptor) {
        const callee = unwrap(node.expression)
        if (ts.isIdentifier(callee) && isCanonicalVerdictHelper(path, callee, name, checker)) {
          descriptors.set(descriptor.join(':'), descriptor)
        } else {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          diagnostics.push(
            `${location.line}:${
              location.character + 1
            } verdict helper ${name} does not resolve to its canonical testing import`,
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  function recordBehaviorMarker(node, suites, test) {
    if (
      !test ||
      (!ts.isStringLiteralLike(node) && !ts.isNoSubstitutionTemplateLiteral(node)) ||
      !node.text.startsWith('mutation-verdict:behavior:') ||
      !VERDICT_MARKER.test(node.text)
    ) {
      return
    }
    if (test.dynamic || suites.some((suite) => suite.dynamic)) {
      dynamicBehaviorTitleMarkers.add(node.text)
      return
    }
    const fullName = [...suites.map((suite) => suite.title), test.title].join(' ')
    const key = `${node.text}\u0000${fullName}`
    behaviorTitleOwners.set(key, [node.text, fullName])
  }

  function visitBehaviorOwners(node, suites, test) {
    recordBehaviorMarker(node, suites, test)
    if (ts.isCallExpression(node)) {
      const registration = vitestRegistration(node.expression, checker)
      if (registration) {
        const callback = node.arguments.find(
          (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
        )
        if (callback) {
          const title = staticTitle(node.arguments[0])
          const owner = {
            title,
            dynamic: registration.parameterized || title === undefined,
          }
          for (const argument of node.arguments) {
            if (argument !== callback) visitBehaviorOwners(argument, suites, test)
          }
          if (registration.kind === 'describe') {
            visitBehaviorOwners(callback, [...suites, owner], test)
          } else {
            visitBehaviorOwners(callback, suites, owner)
          }
          return
        }
      }
    }
    ts.forEachChild(node, (child) => visitBehaviorOwners(child, suites, test))
  }
  visitBehaviorOwners(sourceFile, [], undefined)

  return {
    diagnostics,
    promiseMessageLines: [...promiseMessageLines].sort((left, right) => left - right),
    helperVerdictDescriptors: [...descriptors.values()].sort((left, right) =>
      left.join(':').localeCompare(right.join(':')),
    ),
    directVerdictMarkers: [...directMarkers].sort(),
    behaviorVerdictTitleOwners: [...behaviorTitleOwners.values()].sort(
      (left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]),
    ),
    dynamicBehaviorVerdictTitleMarkers: [...dynamicBehaviorTitleMarkers].sort(),
    expectErrorVerdictMarkers: expectErrorMarkers.sort(
      (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
    ),
  }
}

function mutationOccurrence(source, find) {
  if (find.length === 0) return { error: 'mutation find text must not be empty' }
  const start = source.indexOf(find)
  if (start === -1) return { error: 'mutation pattern occurs 0 times; expected exactly one' }
  if (source.indexOf(find, start + find.length) !== -1) {
    return { error: 'mutation pattern occurs more than once; expected exactly one' }
  }
  return { start }
}

function mutationScriptKind(pathName) {
  if (pathName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (pathName.endsWith('.ts')) return ts.ScriptKind.TS
  return undefined
}

function createMutationBindingAnalyzer(sources) {
  if (typeof ts.isInExpressionContext !== 'function') {
    throw new Error('installed TypeScript does not expose isInExpressionContext')
  }
  const currentSources = new Map()
  const originalSources = new Map()
  const versions = new Map()
  const fileByPath = new Map()
  for (const [pathName, source] of Object.entries(sources)) {
    if (typeof source !== 'string') throw new Error(`${pathName}: source must be a string`)
    const fileName = path.resolve(process.cwd(), pathName)
    currentSources.set(fileName, source)
    originalSources.set(fileName, source)
    versions.set(fileName, 0)
    fileByPath.set(pathName, fileName)
  }
  const options = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
    moduleDetection: ts.ModuleDetectionKind.Force,
  }
  const host = {
    getScriptFileNames: () => [...currentSources.keys()],
    getScriptVersion: (fileName) => String(versions.get(fileName) ?? 0),
    getScriptSnapshot(fileName) {
      const source = currentSources.get(fileName) ?? ts.sys.readFile(fileName)
      return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source)
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: (fileName) => currentSources.has(fileName) || ts.sys.fileExists(fileName),
    readFile: (fileName) => currentSources.get(fileName) ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())

  const inErasedTypeContext = (node) => {
    for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
      if (
        ts.isTypeNode(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent)
      ) {
        return true
      }
    }
    return false
  }

  const isLocalValueExport = (node) => {
    const specifier = node.parent
    if (!ts.isExportSpecifier(specifier)) return false
    const declaration = specifier.parent.parent
    if (
      !ts.isExportDeclaration(declaration) ||
      declaration.isTypeOnly ||
      specifier.isTypeOnly ||
      declaration.moduleSpecifier
    ) {
      return false
    }
    return specifier.propertyName ? specifier.propertyName === node : specifier.name === node
  }

  const isRuntimeReference = (node) => {
    if (inErasedTypeContext(node)) return false
    const parent = node.parent
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
    if (ts.isMetaProperty(parent)) return false
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true
    if (isLocalValueExport(node)) return true
    if (
      (ts.isJsxOpeningElement(parent) ||
        ts.isJsxClosingElement(parent) ||
        ts.isJsxSelfClosingElement(parent)) &&
      parent.tagName === node &&
      ts.isIntrinsicJsxName(node.text)
    ) {
      return false
    }
    return ts.isInExpressionContext(node)
  }

  const unresolvedRuntimeReferences = (fileName) => {
    const program = service.getProgram()
    if (!program) throw new Error('TypeScript binding program is unavailable')
    const sourceFile = program.getSourceFile(fileName)
    if (!sourceFile) throw new Error(`${fileName}: TypeScript binding program omitted source`)
    const checker = program.getTypeChecker()
    const references = []
    const visit = (node) => {
      if (
        ts.isIdentifier(node) &&
        isRuntimeReference(node) &&
        !checker.resolveName(node.text, node, ts.SymbolFlags.Value, false)
      ) {
        const start = node.getStart(sourceFile)
        const location = sourceFile.getLineAndCharacterOfPosition(start)
        references.push({
          name: node.text,
          start,
          end: node.end,
          line: location.line + 1,
          character: location.character + 1,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return references
  }

  const baselineByFile = new Map()
  for (const fileName of currentSources.keys()) {
    baselineByFile.set(fileName, unresolvedRuntimeReferences(fileName))
  }

  const newlyUnbound = (original, mutated, baselineReferences, mutantReferences) => {
    let prefix = 0
    while (
      prefix < original.length &&
      prefix < mutated.length &&
      original.charCodeAt(prefix) === mutated.charCodeAt(prefix)
    ) {
      prefix += 1
    }
    let suffix = 0
    while (
      suffix < original.length - prefix &&
      suffix < mutated.length - prefix &&
      original.charCodeAt(original.length - 1 - suffix) ===
        mutated.charCodeAt(mutated.length - 1 - suffix)
    ) {
      suffix += 1
    }
    const delta = mutated.length - original.length
    const baselineKeys = new Set(
      baselineReferences.map(({ name, start, end }) => `${name}\0${start}\0${end}`),
    )
    return mutantReferences.filter((reference) => {
      let mappedStart
      let mappedEnd
      if (reference.end <= prefix) {
        mappedStart = reference.start
        mappedEnd = reference.end
      } else if (reference.start >= mutated.length - suffix) {
        mappedStart = reference.start - delta
        mappedEnd = reference.end - delta
      }
      return (
        mappedStart === undefined ||
        !baselineKeys.has(`${reference.name}\0${mappedStart}\0${mappedEnd}`)
      )
    })
  }

  return {
    analyze(pathName, mutated) {
      const fileName = fileByPath.get(pathName)
      if (!fileName) throw new Error(`${pathName}: TypeScript binding source is missing`)
      const original = originalSources.get(fileName)
      currentSources.set(fileName, mutated)
      versions.set(fileName, (versions.get(fileName) ?? 0) + 1)
      try {
        const references = unresolvedRuntimeReferences(fileName)
        return newlyUnbound(original, mutated, baselineByFile.get(fileName), references).map(
          ({ name, line, character }) =>
            `${line}:${character} newly unbound runtime identifier '${name}'`,
        )
      } finally {
        currentSources.set(fileName, original)
        versions.set(fileName, (versions.get(fileName) ?? 0) + 1)
      }
    },
    dispose() {
      service.dispose()
    },
  }
}

function analyzeMutationSyntax(sources, mutations) {
  if (!Array.isArray(mutations)) throw new Error('mutation syntax analysis requires mutations')
  const seen = new Set()
  const results = []
  const bindingAnalyzer = createMutationBindingAnalyzer(sources)
  try {
    for (const mutation of mutations) {
      if (!mutation || typeof mutation !== 'object') {
        throw new Error('mutation syntax entry must be an object')
      }
      const { name, file, find, replace } = mutation
      if (
        typeof name !== 'string' ||
        typeof file !== 'string' ||
        typeof find !== 'string' ||
        typeof replace !== 'string'
      ) {
        throw new Error('mutation syntax entry requires string name/file/find/replace')
      }
      if (seen.has(name)) throw new Error(`duplicate mutation syntax name ${name}`)
      seen.add(name)
      const source = sources[file]
      if (typeof source !== 'string') throw new Error(`${name}: source ${file} is missing`)
      const scriptKind = mutationScriptKind(file)
      if (scriptKind === undefined) throw new Error(`${name}: ${file} is not TypeScript source`)
      const occurrence = mutationOccurrence(source, find)
      if (occurrence.error) {
        results.push({
          name,
          file,
          materializationError: occurrence.error,
          diagnostics: [],
          runtimeBindingDiagnostics: [],
        })
        continue
      }
      const mutated =
        source.slice(0, occurrence.start) + replace + source.slice(occurrence.start + find.length)
      const sourceFile = ts.createSourceFile(
        file,
        mutated,
        ts.ScriptTarget.Latest,
        false,
        scriptKind,
      )
      const diagnostics = (sourceFile.parseDiagnostics ?? []).map((diagnostic) => {
        const start = diagnostic.start ?? 0
        const location = sourceFile.getLineAndCharacterOfPosition(start)
        return `${location.line + 1}:${location.character + 1} ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          '\n',
        )}`
      })
      const runtimeBindingDiagnostics =
        diagnostics.length === 0 ? bindingAnalyzer.analyze(file, mutated) : []
      results.push({
        name,
        file,
        materializationError: null,
        diagnostics,
        runtimeBindingDiagnostics,
      })
    }
  } finally {
    bindingAnalyzer.dispose()
  }
  return { mutations: results }
}

function analyzeVerdictProgram(sources) {
  const virtualRoot = '/__durablerun_verdict_analysis__'
  const sourceByFile = new Map()
  const pathByFile = new Map()
  for (const [pathName, source] of Object.entries(sources)) {
    if (typeof source !== 'string') throw new Error(`${pathName}: source must be a string`)
    const fileName = path.posix.join(virtualRoot, pathName.replaceAll('\\', '/'))
    sourceByFile.set(fileName, `export {}\n${source}`)
    pathByFile.set(fileName, pathName)
  }

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
  const files = {}
  for (const [fileName, pathName] of pathByFile) {
    const sourceFile = program.getSourceFile(fileName)
    if (!sourceFile) throw new Error(`${pathName}: compiler omitted source`)
    files[pathName] = analyze(pathName, sourceFile, checker)
  }
  return { files }
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
  if (input.analysis === 'mutation-syntax') {
    process.stdout.write(
      `${JSON.stringify(analyzeMutationSyntax(input.sources, input.mutations))}\n`,
    )
    return
  }
  if (input.analysis === 'batches') {
    process.stdout.write(`${JSON.stringify(analyzeBatchProgram(input.sources))}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(analyzeVerdictProgram(input.sources))}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`typescript-verdict-analyzer: ${String(error)}\n`)
  process.exitCode = 1
}
