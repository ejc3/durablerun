"""Shared, position-preserving lexical views for store-source checkers.

One TypeScript pass owns the distinction between executable structure and
non-code. It blanks comments, string/template text, and regular expressions;
template interpolations remain executable code. The same pass records every
executable string-literal region for the SQL view, so changing a quote style
or putting a literal fragment in an interpolation cannot hide a clock.
"""

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


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
            elif char in ",:;=!?&|+-*%^~<>":
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


def _sql_quote_end(source: str, start: int, quote: str) -> int:
    index = start + 1
    while index < len(source):
        if source[index] == quote:
            if index + 1 < len(source) and source[index + 1] == quote:
                index += 2
                continue
            return index + 1
        if source[index] == "\\":
            index += 2
            continue
        index += 1
    return len(source)


def _sql_executable_text(
    text: str,
    preserve_literals: frozenset[str],
) -> str:
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
        if text[index] in {"'", '"'}:
            end = _sql_quote_end(text, index, text[index])
            literal = text[index + 1 : max(index + 1, end - 1)].casefold()
            if literal not in preserve_literals:
                _blank(chars, index, end)
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
