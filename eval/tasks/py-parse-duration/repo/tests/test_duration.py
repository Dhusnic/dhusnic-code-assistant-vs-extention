import unittest

from timeutil.duration import parse_duration


class ParseDurationTest(unittest.TestCase):
    def test_single_units(self):
        self.assertEqual(parse_duration("90s"), 90)
        self.assertEqual(parse_duration("5m"), 300)

    def test_combined(self):
        self.assertEqual(parse_duration("1h30m"), 5400)


if __name__ == "__main__":
    unittest.main()
