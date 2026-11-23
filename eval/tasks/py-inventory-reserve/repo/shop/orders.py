"""Order handling."""
from .inventory import OutOfStock  # noqa: F401  (re-exported for callers)


def reserve_order(inventory, lines):
    """Reserves every (sku, qty) line of an order."""
    for sku, qty in lines:
        inventory.reserve(sku, qty)
