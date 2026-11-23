"""Order handling."""
from collections import OrderedDict

from .inventory import OutOfStock


def reserve_order(inventory, lines):
    """Reserves every (sku, qty) line of an order, all or nothing."""
    totals = OrderedDict()
    for sku, qty in lines:
        totals[sku] = totals.get(sku, 0) + qty
    for sku, qty in totals.items():
        if inventory.available(sku) < qty:  # KeyError for an unknown SKU
            raise OutOfStock(sku)
    for sku, qty in totals.items():
        inventory.reserve(sku, qty)
