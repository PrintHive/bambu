"""Fetch pinned MIT fixtures and remove device identifiers before writing files."""
import json
from pathlib import Path
import re
import urllib.request

SHA = "0e027ff135a6d9265cb756d3e246747954c76722"
ROOT = f"https://raw.githubusercontent.com/greghesp/ha-bambulab/{SHA}"
DEST = Path(__file__).resolve().parents[1] / "test/fixtures/pybambu"
MODELS = ("MOCK-A1", "MOCK-X1CMULTIAMS", "MOCK-H2D")
VERSION_KEYS = {
    "sw_ver", "hw_ver", "ver", "loader_ver", "ota_ver", "version", "cali_version",
    "ahb_new_version_number", "ams_new_version_number", "ext_new_version_number",
    "ota_new_version_number", "new_version_state",
}


def scrub(value, key=""):
    lower = key.lower()
    if lower in {"sn", "serial", "serial_number", "dev_id", "device_id"}:
        return "000FAKE00000001"
    if lower in {"access_code", "accesscode", "password"}:
        return "FAKE0000"
    if lower in {"hostname", "host", "server", "tukt_server"}:
        return "printer.invalid" if value else value
    if lower in {"ip", "ip_address", "netmask", "gateway"}:
        return 3221225994 if isinstance(value, int) else "192.0.2.10"
    if "mac" in lower and isinstance(value, str):
        return "02:00:00:00:00:01"
    if lower in {"tag_uid", "tray_uuid"}:
        return "0" * len(value) if isinstance(value, str) else value
    if isinstance(value, dict):
        return {k: scrub(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, str):
        if lower not in VERSION_KEYS:
            value = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "192.0.2.10", value)
        value = re.sub(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b", "02:00:00:00:00:01", value)
        value = re.sub(r"(?<![A-Z0-9])[A-Z0-9]{15}(?![A-Z0-9])", "000FAKE00000001", value)
    return value


if __name__ == "__main__":
    DEST.mkdir(parents=True, exist_ok=True)
    for model in MODELS:
        path = f"custom_components/bambu_lab/pybambu/mock_data/{model}.json"
        with urllib.request.urlopen(f"{ROOT}/{path}") as response:
            clean = scrub(json.load(response))
        (DEST / f"{model}.json").write_text(json.dumps(clean, indent=2) + "\n")
    with urllib.request.urlopen(f"{ROOT}/LICENSE") as response:
        (DEST / "LICENSE").write_bytes(response.read())
