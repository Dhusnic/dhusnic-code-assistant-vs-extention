"""Stock levels per SKU."""


class OutOfStock(Exception):
    def __init__(self, sku):
        super().__init__(f"not enough stock for {sku}")
        self.sku = sku


class Inventory:
    def __init__(self, stock):
        self._stock = dict(stock)
        self._reserved = {sku: 0 for sku in self._stock}

    def available(self, sku):
        return self._stock[sku] - self._reserved[sku]

    def reserve(self, sku, qty):
        if self.available(sku) < qty:
            raise OutOfStock(sku)
        self._reserved[sku] += qty

    def release(self, sku, qty):
        self._reserved[sku] = max(0, self._reserved[sku] - qty)
