"""Regression checks for the pinned fixture vendor script. Run with unittest."""
import importlib.util
import json
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    "vendor_pybambu", Path(__file__).resolve().parents[1] / "scripts/vendor-pybambu.py"
)
vendor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vendor)


class VendorTests(unittest.TestCase):
    def test_scrub_preserves_versions_and_scrubs_addresses(self):
        for key in ("sw_ver", "hw_ver", "ver", "loader_ver", "ota_ver",
                    "version", "ota_new_version_number", "SW_VER"):
            with self.subTest(key=key):
                self.assertEqual(vendor.scrub({key: "01.05.00.00"}), {key: "01.05.00.00"})
        self.assertEqual(vendor.scrub({"message": "Connect to 10.20.30.40 now"}),
                         {"message": "Connect to 192.0.2.10 now"})
        self.assertEqual(vendor.scrub({"ip": "10.20.30.40", "sn": "SYNTHETIC0000001"}),
                         {"ip": "192.0.2.10", "sn": "000FAKE00000001"})
        self.assertEqual(vendor.scrub({"sw_ver": "aa:bb:cc:dd:ee:ff"}),
                         {"sw_ver": "02:00:00:00:00:01"})

    def test_fixture_ota_versions_match_pinned_upstream(self):
        versions = {"MOCK-A1": "01.05.00.00", "MOCK-H2D": "01.01.01.00",
                    "MOCK-X1CMULTIAMS": "01.09.00.01"}
        for model, version in versions.items():
            with self.subTest(model=model):
                fixture = json.loads((vendor.DEST / f"{model}.json").read_text())
                ota = next(m for m in fixture["get_version"]["info"]["module"] if m["name"] == "ota")
                self.assertEqual(ota["sw_ver"], version)


if __name__ == "__main__":
    unittest.main()
