"""
The checklist as data: parse harness/CHECKLIST.md, decide each row's state
from a run, print the board, rewrite the State column.

What this must never do: mark a row green on its own. Green requires the
`Proven by` cell to be non-empty, and only a person writes that cell.
"""
import re
from dataclasses import dataclass

ROW = re.compile(r"^\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(check_\d\d)\s*\|\s*(\w+)\s*\|\s*(.*?)\s*\|$")


@dataclass
class Row:
    n: int
    flow: str
    check: str
    state: str
    proven: str


def load(path: str) -> list[Row]:
    rows = []
    for line in open(path, encoding="utf8"):
        m = ROW.match(line.rstrip("\n"))
        if m:
            rows.append(Row(int(m.group(1)), m.group(2), m.group(3), m.group(4), m.group(5)))
    if [r.n for r in rows] != list(range(1, len(rows) + 1)):
        raise SystemExit(f"CHECKLIST.md rows are not 1..{len(rows)} with no gaps: {[r.n for r in rows]}")
    return rows


def decide(row: Row, result: str) -> str:
    """result: 'pass' | 'fail' | 'missing' | 'skipped'."""
    if result == "missing":
        return "unbuilt"
    if result == "fail":
        return "red"
    if result == "skipped":
        return row.state  # not run this time; keep what the file says
    return "green" if row.proven.strip() else "unproven"


def render(rows: list[Row], detail: dict[int, str] | None = None) -> str:
    detail = detail or {}
    width = max(len(r.flow) for r in rows)
    out = []
    for r in rows:
        tail = detail.get(r.n, r.proven if r.state == "green" else "")
        out.append(f"{r.n:>2}  {r.flow:<{width}}  {r.state.upper():<8} {tail}")
    counts = {s: sum(1 for r in rows if r.state == s) for s in ("green", "unproven", "red", "unbuilt")}
    out.append("")
    out.append("  ".join(f"{k}={v}" for k, v in counts.items()))
    return "\n".join(out)


def exit_code(rows: list[Row]) -> int:
    return 1 if any(r.state in ("red", "unbuilt") for r in rows) else 0


def save(path: str, rows: list[Row]) -> None:
    by_n = {r.n: r for r in rows}
    lines = []
    for line in open(path, encoding="utf8"):
        m = ROW.match(line.rstrip("\n"))
        if m:
            r = by_n[int(m.group(1))]
            line = f"| {r.n} | {r.flow} | {r.check} | {r.state} | {r.proven} |\n"
        lines.append(line)
    open(path, "w", encoding="utf8").writelines(lines)
