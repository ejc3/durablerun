"""Shared, position-preserving lexical views for store-source checkers.

One TypeScript pass owns the distinction between executable structure and
non-code. It blanks comments, string/template text, and regular expressions;
template interpolations remain executable code. The same pass records every
executable string-literal region for the SQL view, so changing a quote style
or putting a literal fragment in an interpolation cannot hide a clock.
"""

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal


def _blank(chars: list[str], start: int, end: int) -> None:
    for index in range(start, end):
        if chars[index] not in "\r\n":
            chars[index] = " "


@dataclass(frozen=True)
class _Literal:
    """Static source spans that form one TypeScript string/template value."""

    spans: tuple[tuple[int, int], ...]


@dataclass(frozen=True)
class _Lexed:
    structure: str
    literals: tuple[_Literal, ...]


BatchCallKind = Literal["raw", "fenced"]
BatchLabelKind = Literal["static", "template", "opaque"]


@dataclass(frozen=True)
class BatchCall:
    """One structurally resolved store batch construction or executor call."""

    kind: BatchCallKind
    open_paren: int
    close_paren: int
    arguments: tuple[tuple[int, int], ...]


@dataclass(frozen=True)
class BatchLabel:
    """The syntax-level label representation shared by every batch inventory."""

    kind: BatchLabelKind
    value: str


@dataclass(frozen=True)
class _TsToken:
    """One executable TypeScript token in the position-preserving source."""

    value: str
    start: int
    end: int


_EXPRESSION_PREFIX_WORDS = frozenset(
    {
        "await",
        "case",
        "delete",
        "else",
        "in",
        "instanceof",
        "new",
        "of",
        "return",
        "throw",
        "typeof",
        "void",
        "yield",
    }
)


class _TypeScriptLexer:
    def __init__(self, source: str) -> None:
        self.source = source
        self.structure = list(source)
        self.literals: list[_Literal] = []

    def lex(self) -> _Lexed:
        end = self._code(0)
        if end != len(self.source):
            raise ValueError("unexpected TypeScript lexical terminator")
        return _Lexed("".join(self.structure), tuple(self.literals))

    def _quoted_end(self, start: int, quote: str) -> int:
        index = start + 1
        while index < len(self.source):
            if self.source[index] == "\\":
                index += 2
                continue
            if self.source[index] == quote:
                return index + 1
            if self.source[index] in "\r\n":
                raise ValueError(f"unterminated TypeScript {quote} string")
            index += 1
        raise ValueError(f"unterminated TypeScript {quote} string")

    def _regex_end(self, start: int) -> int:
        index = start + 1
        in_class = False
        while index < len(self.source):
            char = self.source[index]
            if char == "\\":
                index += 2
                continue
            if char in "\r\n":
                raise ValueError("unterminated TypeScript regular expression")
            if char == "[":
                in_class = True
            elif char == "]":
                in_class = False
            elif char == "/" and not in_class:
                index += 1
                while index < len(self.source) and (
                    self.source[index].isalnum() or self.source[index] in "_$"
                ):
                    index += 1
                return index
            index += 1
        raise ValueError("unterminated TypeScript regular expression")

    def _template(self, start: int) -> int:
        _blank(self.structure, start, start + 1)
        spans: list[tuple[int, int]] = []
        index = start + 1
        static_start = index
        while index < len(self.source):
            if self.source[index] == "\\":
                index += 2
                continue
            if self.source[index] == "`":
                spans.append((static_start, index))
                _blank(self.structure, static_start, index + 1)
                self.literals.append(_Literal(tuple(spans)))
                return index + 1
            if self.source.startswith("${", index):
                spans.append((static_start, index))
                # Template text and `$` are not structure. The braces and
                # their contents are executable TypeScript and stay visible.
                _blank(self.structure, static_start, index + 1)
                close = self._code(index + 2, stop_on_brace=True)
                if close >= len(self.source) or self.source[close] != "}":
                    raise ValueError("unterminated TypeScript template interpolation")
                index = close + 1
                static_start = index
                continue
            index += 1
        raise ValueError("unterminated TypeScript template literal")

    def _code(self, start: int, *, stop_on_brace: bool = False) -> int:
        index = start
        brace_depth = 0
        expects_expression = True
        while index < len(self.source):
            char = self.source[index]

            if stop_on_brace and char == "}" and brace_depth == 0:
                return index
            if self.source.startswith("//", index):
                end = self.source.find("\n", index + 2)
                end = len(self.source) if end < 0 else end
                _blank(self.structure, index, end)
                index = end
                continue
            if self.source.startswith("/*", index):
                close = self.source.find("*/", index + 2)
                if close < 0:
                    raise ValueError("unterminated TypeScript block comment")
                end = close + 2
                _blank(self.structure, index, end)
                index = end
                continue
            if char in {"'", '"'}:
                end = self._quoted_end(index, char)
                self.literals.append(_Literal(((index + 1, end - 1),)))
                _blank(self.structure, index, end)
                index = end
                expects_expression = False
                continue
            if char == "`":
                index = self._template(index)
                expects_expression = False
                continue
            if self.source.startswith(("++", "--"), index):
                # Prefix and postfix forms preserve the state on their left:
                # `++n` still needs an expression, while `n++` has completed
                # one. Treating postfix `++` as two binary plus operators made
                # the following division slash look like a regex opener.
                index += 2
                continue
            if self.source.startswith(("!==", "!="), index):
                index += 3 if self.source.startswith("!==", index) else 2
                expects_expression = True
                continue
            if char == "!":
                # Logical prefix `!` preserves "expects an expression"; the
                # TypeScript postfix non-null assertion preserves "completed
                # an expression". Collapsing both into the binary-operator
                # bucket made division after `value!` look like a regex.
                index += 1
                continue
            if char == "/" and expects_expression:
                end = self._regex_end(index)
                _blank(self.structure, index, end)
                index = end
                expects_expression = False
                continue
            if char == "/":
                index += 2 if self.source.startswith("/=", index) else 1
                expects_expression = True
                continue
            if char.isspace():
                index += 1
                continue
            if char.isalpha() or char in "_$":
                end = index + 1
                while end < len(self.source) and (
                    self.source[end].isalnum() or self.source[end] in "_$"
                ):
                    end += 1
                expects_expression = self.source[index:end] in _EXPRESSION_PREFIX_WORDS
                index = end
                continue
            if char.isdigit():
                end = index + 1
                while end < len(self.source) and (
                    self.source[end].isalnum() or self.source[end] in "._"
                ):
                    end += 1
                index = end
                expects_expression = False
                continue
            if char == "{":
                brace_depth += 1
                expects_expression = True
            elif char == "}":
                if brace_depth:
                    brace_depth -= 1
                expects_expression = False
            elif char in "([":
                expects_expression = True
            elif char in ")]":
                expects_expression = False
            elif char in ",:;=?&|+-*%^~<>":
                expects_expression = True
            elif char == ".":
                expects_expression = True
            index += 1
        if stop_on_brace:
            raise ValueError("unterminated TypeScript template interpolation")
        return index


@lru_cache(maxsize=32)
def _lex_typescript(source: str) -> _Lexed:
    return _TypeScriptLexer(source).lex()


def typescript_structure(source: str) -> str:
    """Expose executable TypeScript structure and blank every non-code span."""
    return _lex_typescript(source).structure


def matching_delimiter(
    source: str,
    open_index: int,
    structure: str | None = None,
) -> int | None:
    """Return a structural delimiter's mate, or None for malformed structure."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    opening = source[open_index : open_index + 1]
    if opening not in pairs:
        raise ValueError(f"index {open_index} does not point at an opening delimiter")
    visible = structure if structure is not None else typescript_structure(source)
    stack = [opening]
    for index in range(open_index + 1, len(source)):
        char = visible[index]
        if char in pairs:
            stack.append(char)
        elif char in pairs.values():
            if not stack or pairs[stack[-1]] != char:
                return None
            stack.pop()
            if not stack:
                return index
    return None


def trivia_only(source: str) -> bool:
    """Whether a span contains only whitespace and TypeScript comments."""
    index = 0
    while index < len(source):
        if source[index].isspace():
            index += 1
            continue
        if source.startswith("//", index):
            end = source.find("\n", index + 2)
            index = len(source) if end < 0 else end
            continue
        if source.startswith("/*", index):
            close = source.find("*/", index + 2)
            if close < 0:
                return False
            index = close + 2
            continue
        return False
    return True


def split_top_level(
    source: str,
    structure: str,
    start: int,
    end: int,
) -> list[tuple[int, int]] | None:
    """Split a structural span on commas outside all nested delimiters."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack: list[str] = []
    parts: list[tuple[int, int]] = []
    part_start = start
    for index in range(start, end):
        char = structure[index]
        if char in pairs:
            stack.append(char)
        elif char in pairs.values():
            if not stack or pairs[stack[-1]] != char:
                return None
            stack.pop()
        elif char == "," and not stack:
            parts.append((part_start, index))
            part_start = index + 1
    if stack:
        return None
    parts.append((part_start, end))
    if parts and trivia_only(source[parts[-1][0] : parts[-1][1]]):
        parts.pop()
    return parts


_STATIC_BATCH_LABEL = re.compile(
    r"\s*(['\"])([A-Za-z0-9:_-]+)\1\s*",
    re.DOTALL,
)
_TEMPLATE_BATCH_LABEL = re.compile(
    r"\s*`([A-Za-z0-9:_-]*)\$\{[^{}]+\}`\s*",
    re.DOTALL,
)


def _typescript_tokens(structure: str) -> tuple[_TsToken, ...]:
    """Tokenize executable structure without reinterpreting erased literals.

    This is intentionally a closed surface, not another collection of regular
    expressions for known aliases. Identifiers and punctuation retain their
    exact source positions; comments, strings, template text, and regexes were
    already erased by ``typescript_structure``.
    """
    tokens: list[_TsToken] = []
    index = 0
    while index < len(structure):
        char = structure[index]
        if char.isspace():
            index += 1
            continue
        if char.isalpha() or char in "_$":
            end = index + 1
            while end < len(structure) and (
                structure[end].isalnum() or structure[end] in "_$"
            ):
                end += 1
            tokens.append(_TsToken(structure[index:end], index, end))
            index = end
            continue
        if char.isdigit():
            end = index + 1
            while end < len(structure) and (
                structure[end].isalnum() or structure[end] in "._"
            ):
                end += 1
            tokens.append(_TsToken(structure[index:end], index, end))
            index = end
            continue
        tokens.append(_TsToken(char, index, index + 1))
        index += 1
    return tuple(tokens)


def _import_token_indexes(tokens: tuple[_TsToken, ...]) -> frozenset[int]:
    """Return token indexes belonging to static ES import declarations."""
    imported: set[int] = set()
    for index, token in enumerate(tokens):
        if token.value != "import":
            continue
        cursor = index + 1
        while cursor < len(tokens) and tokens[cursor].value != "from":
            if tokens[cursor].value == "import":
                break
            imported.add(cursor)
            cursor += 1
    return frozenset(imported)


def _fenced_batch_surface(
    source: str,
    structure: str,
    tokens: tuple[_TsToken, ...],
) -> tuple[list[BatchCall], frozenset[str]]:
    """Harvest canonical constructors and the names allowed to execute them."""
    imported = _import_token_indexes(tokens)
    calls: list[BatchCall] = []
    executors: set[str] = set()

    for index, token in enumerate(tokens):
        if token.value != "FencedBatch":
            continue
        previous = tokens[index - 1].value if index else ""
        following = tokens[index + 1].value if index + 1 < len(tokens) else ""

        if index in imported:
            if previous == "as" or following == "as":
                raise ValueError(
                    "batch call shape is opaque: "
                    "indirect FencedBatch reference is opaque"
                )
            continue

        if previous == "new" and following == "(":
            calls.append(
                _batch_call(
                    source,
                    structure,
                    "fenced",
                    tokens[index + 1].start,
                )
            )
            if index >= 3 and tokens[index - 2].value == "=":
                candidate = tokens[index - 3].value
                if candidate and (candidate[0].isalpha() or candidate[0] in "_$"):
                    executors.add(candidate)
            continue

        # A direct type annotation is the only non-construction reference
        # admitted by the closed surface. It lets shared helpers accept and
        # execute an already-labelled FencedBatch without creating an alias to
        # the constructor itself.
        if previous == ":" and index >= 2:
            candidate = tokens[index - 2].value
            if candidate and (candidate[0].isalpha() or candidate[0] in "_$"):
                executors.add(candidate)
            continue

        raise ValueError(
            "batch call shape is opaque: indirect FencedBatch reference is opaque"
        )

    return calls, frozenset(executors)


def _batch_call(
    source: str,
    structure: str,
    kind: BatchCallKind,
    open_paren: int,
) -> BatchCall:
    close_paren = matching_delimiter(source, open_paren, structure)
    if close_paren is None:
        raise ValueError(
            f"cannot establish {kind} batch call boundary; "
            "refusing an opaque batch shape"
        )
    arguments = split_top_level(
        source,
        structure,
        open_paren + 1,
        close_paren,
    )
    if arguments is None:
        raise ValueError(f"{kind} batch call arguments are structurally opaque")
    return BatchCall(
        kind,
        open_paren,
        close_paren,
        tuple(arguments),
    )


def batch_calls(
    source: str,
    structure: str | None = None,
) -> tuple[BatchCall, ...]:
    """Harvest the two canonical store batch doors and reject every alias.

    Raw batches are exactly ``this.db.batch(...)``. Fenced batches are exactly
    ``new FencedBatch(...)`` and execute through a directly constructed or
    directly typed FencedBatch's ``run(this.db)``. Every other use of ``this``
    as a value, every optional/computed receiver, and every other ``this.db``
    placement fails closed. This is a token-level grammar for the property,
    not a list of alias spellings that happened to be found by review.
    """
    visible = structure if structure is not None else typescript_structure(source)
    tokens = _typescript_tokens(visible)
    calls, fenced_executors = _fenced_batch_surface(
        source,
        visible,
        tokens,
    )

    for index, token in enumerate(tokens):
        if token.value != "this":
            continue
        following = tokens[index + 1].value if index + 1 < len(tokens) else ""
        if following != ".":
            raise ValueError(
                "batch call shape is opaque: indirect this reference is opaque"
            )
        if index + 2 >= len(tokens) or tokens[index + 2].value != "db":
            continue

        after_db = index + 3
        if (
            after_db + 2 < len(tokens)
            and tokens[after_db].value == "."
            and tokens[after_db + 1].value == "batch"
            and tokens[after_db + 2].value == "("
        ):
            calls.append(
                _batch_call(
                    source,
                    visible,
                    "raw",
                    tokens[after_db + 2].start,
                )
            )
            continue

        # FencedBatch.run is the only place the executor may cross this
        # boundary without immediately invoking its labelled raw batch door.
        if (
            index >= 4
            and after_db < len(tokens)
            and tokens[index - 1].value == "("
            and tokens[index - 2].value == "run"
            and tokens[index - 3].value == "."
            and tokens[index - 4].value in fenced_executors
            and tokens[after_db].value == ")"
        ):
            continue

        raise ValueError(
            "batch call shape is opaque: "
            "indirect this.db.batch reference is opaque"
        )

    return tuple(sorted(calls, key=lambda call: call.open_paren))


def batch_label(source: str, call: BatchCall) -> BatchLabel:
    """Parse a harvested call's label syntax without guessing its value."""
    if not call.arguments:
        raise ValueError(f"{call.kind} batch call has no label argument")
    start, end = call.arguments[0]
    expression = source[start:end]
    static = _STATIC_BATCH_LABEL.fullmatch(expression)
    if static is not None:
        return BatchLabel("static", static.group(2))
    template = _TEMPLATE_BATCH_LABEL.fullmatch(expression)
    if template is not None:
        return BatchLabel("template", template.group(1))
    return BatchLabel("opaque", expression.strip())


def _sql_quote_end(source: str, start: int, quote: str) -> int:
    index = start + 1
    while index < len(source):
        if source[index] == quote:
            if index + 1 < len(source) and source[index + 1] == quote:
                index += 2
                continue
            return index + 1
        index += 1
    return len(source)


def _sql_executable_text(
    text: str,
    preserve_literals: frozenset[str],
) -> str:
    # The portable contract treats single quotes as data and double quotes as
    # identifiers (SQLite and PostgreSQL both execute `"cancel_at_ms"` as the
    # column). Erasing both quote styles made a quoted eligibility field
    # disappear from every SQL checker.
    chars = list(text)
    index = 0
    while index < len(text):
        if text.startswith("--", index):
            end = text.find("\n", index + 2)
            end = len(text) if end < 0 else end
            _blank(chars, index, end)
            index = end
            continue
        if text.startswith("/*", index):
            close = text.find("*/", index + 2)
            end = len(text) if close < 0 else close + 2
            _blank(chars, index, end)
            index = end
            continue
        if text[index] == "'":
            end = _sql_quote_end(text, index, "'")
            literal = text[index + 1 : max(index + 1, end - 1)].casefold()
            if literal not in preserve_literals:
                _blank(chars, index, end)
            index = end
            continue
        if text[index] == '"':
            end = _sql_quote_end(text, index, '"')
            chars[index] = " "
            if end <= len(text) and end > index + 1 and text[end - 1] == '"':
                chars[end - 1] = " "
            index = end
            continue
        index += 1
    return "".join(chars)


def sql_template_view(
    source: str,
    preserve_literals: frozenset[str] = frozenset(),
) -> str:
    """Expose SQL-like text in every executable TypeScript string literal.

    This deliberately does not guess which variable names or call sites are
    "SQL-bearing": a literal can be routed into SQL indirectly. SQL comments
    and SQL data literals remain blank. Literal strings inside `${...}` are
    separate executable fragments and are included.
    """
    lexed = _lex_typescript(source)
    visible = list(source)
    _blank(visible, 0, len(visible))

    for literal in lexed.literals:
        if not literal.spans:
            continue
        start = literal.spans[0][0]
        end = literal.spans[-1][1]
        candidate = [" "] * (end - start)
        for span_start, span_end in literal.spans:
            candidate[span_start - start : span_end - start] = source[
                span_start:span_end
            ]
        executable = _sql_executable_text("".join(candidate), preserve_literals)
        for offset, char in enumerate(executable):
            if not char.isspace():
                visible[start + offset] = char
    return "".join(visible)


def sql_file_view(
    source: str,
    preserve_literals: frozenset[str] = frozenset(),
) -> str:
    """Expose executable text from a standalone SQL source file."""
    return _sql_executable_text(source, preserve_literals)


def validated_root(args: list[str], default: Path, program: str) -> Path:
    """Resolve one explicit root and refuse every vacuous spelling."""
    if len(args) > 1:
        raise ValueError(f"{program}: usage: {program} [root]")
    if args and args[0].startswith("-"):
        raise ValueError(f"{program}: unknown option {args[0]!r}")
    root = Path(args[0]).resolve() if args else default.resolve()
    if not root.is_dir():
        raise ValueError(
            f"{program}: root does not exist or is not a directory: {root}"
        )
    if not (root / "packages").is_dir():
        raise ValueError(f"{program}: root has no packages directory: {root}")
    return root


def store_typescript_sources(root: Path, program: str) -> tuple[Path, ...]:
    """Return the auditable store source set and reject an empty harvest."""
    paths = tuple(
        path
        for store_dir in sorted(root.glob("packages/store-*/src"))
        for path in sorted(store_dir.rglob("*.ts"))
    )
    if not paths:
        raise ValueError(
            f"{program}: no store TypeScript sources matched "
            "packages/store-*/src/**/*.ts; refusing a vacuous audit"
        )
    return paths


def store_sql_sources(root: Path, program: str) -> tuple[Path, ...]:
    """Return every TypeScript or standalone SQL source under a store."""
    paths = tuple(
        path
        for store_dir in sorted(root.glob("packages/store-*/src"))
        for path in sorted(store_dir.rglob("*"))
        if path.is_file() and path.suffix in {".sql", ".ts"}
    )
    if not paths:
        raise ValueError(
            f"{program}: no store TypeScript sources or standalone SQL sources matched "
            "packages/store-*/src/**/*.{sql,ts}; refusing a vacuous audit"
        )
    return paths
