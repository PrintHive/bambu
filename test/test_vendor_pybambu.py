"""Regression checks for the pinned fixture vendor script. Run with unittest."""
import importlib.util
import json
import io
import runpy
from pathlib import Path
import unittest
from unittest.mock import patch

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

    def test_downloads_accept_exactly_one_mib(self):
        limit = 1024 * 1024
        license_data = b"a" * limit

        def open_response(url):
            return io.BytesIO(license_data if url.endswith("/LICENSE") else b" " * (limit - 2) + b"{}")

        with patch.object(vendor.urllib.request, "urlopen", side_effect=open_response), \
                patch.object(Path, "write_text") as write_fixture, \
                patch.object(Path, "write_bytes") as write_license:
            runpy.run_path(str(SPEC.origin), run_name="__main__")
        self.assertEqual(write_fixture.call_count, 3)
        write_license.assert_called_once_with(license_data)

    def test_downloads_reject_responses_over_one_mib(self):
        limit = 1024 * 1024
        for oversized in ("fixture", "license"):
            with self.subTest(oversized=oversized):
                rejected = []

                def open_response(url):
                    is_license = url.endswith("/LICENSE")
                    if is_license == (oversized == "license"):
                        response = io.BytesIO(b" " * limit + b"{}")
                        # Keep streams inspectable after their contexts close.
                        response.close = lambda: None
                        rejected.append(response)
                        return response
                    return io.BytesIO(b"MIT" if is_license else b"{}")

                with patch.object(vendor.urllib.request, "urlopen", side_effect=open_response), \
                        patch.object(Path, "write_text"), patch.object(Path, "write_bytes"):
                    with self.assertRaisesRegex(ValueError, "exceeds.*1048576"):
                        runpy.run_path(str(SPEC.origin), run_name="__main__")
                for response in rejected:
                    self.assertLessEqual(response.tell(), limit + 1)


if __name__ == "__main__":
    unittest.main()
