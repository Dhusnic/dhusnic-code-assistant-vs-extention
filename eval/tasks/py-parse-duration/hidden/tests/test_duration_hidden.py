import unittest

from timeutil.duration import parse_duration


class HiddenDurationTest(unittest.TestCase):
    def test_spaces_and_many_parts(self):
        self.assertEqual(parse_duration("2d 4h"), 2 * 86400 + 4 * 3600)
        self.assertEqual(parse_duration("1h 0m 15s"), 3615)

    def test_decimals_and_ms(self):
        self.assertEqual(parse_duration("1.5h"), 5400)
        self.assertAlmostEqual(parse_duration("1s500ms"), 1.5)
        self.assertAlmostEqual(parse_duration("250ms"), 0.25)

    def test_minutes_are_not_confused_with_ms(self):
        self.assertEqual(parse_duration("2m"), 120)
        self.assertAlmostEqual(parse_duration("2m5ms"), 120.005)

    def test_errors(self):
        for bad in ["", "   ", "5", "5x", "1h1h", "h", "1h30"]:
            with self.assertRaises(ValueError, msg=bad):
                parse_duration(bad)


if __name__ == "__main__":
    unittest.main()
