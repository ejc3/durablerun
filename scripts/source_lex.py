"""Shared lexical views for source checkers.

The checkers need two different views of one TypeScript source:

- delimiters and object keys with comments and string contents blanked;
- SQL template contents with TypeScript/SQL comments and SQL literals blanked.

Both preserve byte positions and newlines, so a checker can inspect the raw
source after deciding structure without maintaining a second parser.
"""

from pathlib import Path


def _blank(chars: list[str], start: int, end: int) -> None:
    for index in range(start, end):
        if chars[index] not in "\r\n":
            chars[index] = " "


def _quoted_end(source: str, start: int, quote: str) -> int:
    index = start + 1
    while index < len(source):
        if source[index] == "\\":
            index += 2
            continue
        if source[index] == quote:
            return index + 1
        index += 1
    return len(source)


def _template_end(source: str, start: int) -> int:
    index = start + 1
    while index < len(source):
        if source[index] == "\\":
            index += 2
            continue
        if source[index] == "`":
            return index + 1
        if source.startswith("${", index):
            close = matching_delimiter(source[index + 1 :], 0)
            if close is None:
                return len(source)
            index += close + 2
            continue
        index += 1
    return len(source)


def typescript_structure(source: str) -> str:
    """Blank TypeScript comments and every quoted/template literal."""
    chars = list(source)
    index = 0
    while index < len(source):
        if source.startswith("//", index):
            end = source.find("\n", index + 2)
            end = len(source) if end < 0 else end
            _blank(chars, index, end)
            index = end
            continue
        if source.startswith("/*", index):
            close = source.find("*/", index + 2)
            end = len(source) if close < 0 else close + 2
            _blank(chars, index, end)
            index = end
            continue
        if source[index] in {"'", '"'}:
            end = _quoted_end(source, index, source[index])
            _blank(chars, index, end)
            index = end
            continue
        if source[index] == "`":
            end = _template_end(source, index)
            _blank(chars, index, end)
            index = end
            continue
        index += 1
    return "".join(chars)


def matching_delimiter(source: str, open_index: int) -> int | None:
    """Return the matching close index, ignoring quoted and commented spans."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    opening = source[open_index : open_index + 1]
    if opening not in pairs:
        raise ValueError(f"index {open_index} does not point at an opening delimiter")
    visible = typescript_structure(source)
    stack = [opening]
    for index in range(open_index + 1, len(source)):
        char = visible[index]
        if char in pairs:
            stack.append(char)
            continue
        if char not in pairs.values():
            continue
        if pairs[stack[-1]] != char:
            continue
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


def sql_template_view(
    source: str,
    preserve_literals: frozenset[str] = frozenset(),
) -> str:
    """Expose SQL template text while blanking every non-executable span."""
    chars = list(source)
    _blank(chars, 0, len(chars))
    index = 0
    while index < len(source):
        if source.startswith("//", index):
            end = source.find("\n", index + 2)
            index = len(source) if end < 0 else end
            continue
        if source.startswith("/*", index):
            close = source.find("*/", index + 2)
            index = len(source) if close < 0 else close + 2
            continue
        if source[index] in {"'", '"'}:
            index = _quoted_end(source, index, source[index])
            continue
        if source[index] != "`":
            index += 1
            continue

        index += 1
        while index < len(source):
            if source[index] == "\\":
                index += 2
                continue
            if source[index] == "`":
                index += 1
                break
            if source.startswith("${", index):
                close = matching_delimiter(source[index + 1 :], 0)
                index = len(source) if close is None else index + close + 2
                continue
            if source.startswith("--", index):
                end = source.find("\n", index + 2)
                index = len(source) if end < 0 else end
                continue
            if source.startswith("/*", index):
                close = source.find("*/", index + 2)
                index = len(source) if close < 0 else close + 2
                continue
            if source[index] in {"'", '"'}:
                end = _sql_quote_end(source, index, source[index])
                literal = source[index + 1 : max(index + 1, end - 1)].casefold()
                if literal in preserve_literals:
                    for position in range(index, end):
                        chars[position] = source[position]
                index = end
                continue
            chars[index] = source[index]
            index += 1
    return "".join(chars)


def validated_root(args: list[str], default: Path, program: str) -> Path:
    """Resolve one explicit root and refuse every vacuous spelling."""
    if len(args) > 1:
        raise ValueError(f"{program}: usage: {program} [root]")
    if args and args[0].startswith("-"):
        raise ValueError(f"{program}: unknown option {args[0]!r}")
    root = Path(args[0]).resolve() if args else default.resolve()
    if not root.is_dir():
        raise ValueError(f"{program}: root does not exist or is not a directory: {root}")
    if not (root / "packages").is_dir():
        raise ValueError(f"{program}: root has no packages directory: {root}")
    return root
