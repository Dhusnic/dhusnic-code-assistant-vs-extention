"""Human-friendly durations for config files."""

_UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}


def parse_duration(text):
    """Seconds in a duration such as "90s" or "5m"."""
    text = text.strip()
    unit = text[-1]
    if unit not in _UNITS:
        raise ValueError(f"unknown unit in {text!r}")
    return float(text[:-1]) * _UNITS[unit]
