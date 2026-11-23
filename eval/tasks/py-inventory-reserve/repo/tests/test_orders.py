import unittest

from shop.inventory import Inventory
from shop.orders import reserve_order


class ReserveOrderTest(unittest.TestCase):
    def test_reserves_all_lines(self):
        inv = Inventory({"a": 5, "b": 2})
        reserve_order(inv, [("a", 2), ("b", 1)])
        self.assertEqual(inv.available("a"), 3)
        self.assertEqual(inv.available("b"), 1)


if __name__ == "__main__":
    unittest.main()
