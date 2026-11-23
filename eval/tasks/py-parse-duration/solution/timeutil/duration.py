"""Human-friendly durations for config files."""
import re

_UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1, "ms": 0.001}
_PART = re.compile(r"\s*(\d+(?:\.\d+)?)(ms|d|h|m|s)\s*")


def parse_duration(text):
    """Seconds in a duration such as "90s", "1h30m" or "2d 4h"."""
    if not text.strip():
        raise ValueError("empty duration")
    pos, total, seen = 0, 0.0, set()
    while pos < len(text):
        m = _PART.match(text, pos)
        if not m:
            raise ValueError(f"invalid duration {text!r}")
        number, unit = m.groups()
        if unit in seen:
            raise ValueError(f"unit {unit!r} repeated in {text!r}")
        seen.add(unit)
        total += float(number) * _UNITS[unit]
        pos = m.end()
    return total
