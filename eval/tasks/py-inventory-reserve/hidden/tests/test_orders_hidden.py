import unittest

from shop.inventory import Inventory, OutOfStock
from shop.orders import reserve_order


class HiddenReserveTest(unittest.TestCase):
    def test_all_or_nothing(self):
        inv = Inventory({"a": 5, "b": 1})
        with self.assertRaises(OutOfStock) as cm:
            reserve_order(inv, [("a", 2), ("b", 3)])
        self.assertEqual(cm.exception.sku, "b")
        self.assertEqual(inv.available("a"), 5)
        self.assertEqual(inv.available("b"), 1)

    def test_same_sku_on_several_lines(self):
        inv = Inventory({"a": 3, "b": 5})
        with self.assertRaises(OutOfStock) as cm:
            reserve_order(inv, [("b", 1), ("a", 2), ("a", 2)])
        self.assertEqual(cm.exception.sku, "a")
        self.assertEqual(inv.available("a"), 3)
        self.assertEqual(inv.available("b"), 5)
        reserve_order(inv, [("a", 1), ("a", 2)])
        self.assertEqual(inv.available("a"), 0)

    def test_unknown_sku_changes_nothing(self):
        inv = Inventory({"a": 3})
        with self.assertRaises(KeyError):
            reserve_order(inv, [("a", 1), ("zzz", 1)])
        self.assertEqual(inv.available("a"), 3)

    def test_existing_api(self):
        inv = Inventory({"a": 2})
        inv.reserve("a", 2)
        with self.assertRaises(OutOfStock):
            inv.reserve("a", 1)
        inv.release("a", 1)
        self.assertEqual(inv.available("a"), 1)


if __name__ == "__main__":
    unittest.main()
