// Generated from test/fixtures/tapes/p1s-01.09.00.00/idle-2026-09-18.jsonl, a scrubbed capture: the full report
// at t=11.995 without its envelope, and the module list at t=9.24. test/emulator.test.ts checks that it still
// matches the tape. The serial placeholders are replaced with the emulated printer's own serial.
import type { Schema } from "effect"

export const p1sReport: Schema.JsonObject = {
  "ipcam": {
    "ipcam_dev": "1",
    "ipcam_record": "enable",
    "timelapse": "disable",
    "resolution": "",
    "tutk_server": "disable",
    "mode_bits": 3
  },
  "upload": {
    "status": "idle",
    "progress": 0,
    "message": ""
  },
  "net": {
    "conf": 0,
    "info": [
      {
        "ip": 0,
        "mask": 0
      }
    ]
  },
  "nozzle_temper": 29.5,
  "nozzle_target_temper": 0,
  "bed_temper": 25.96875,
  "bed_target_temper": 0,
  "chamber_temper": 5,
  "mc_print_stage": "1",
  "heatbreak_fan_speed": "0",
  "cooling_fan_speed": "0",
  "big_fan1_speed": "0",
  "big_fan2_speed": "0",
  "mc_percent": 100,
  "mc_remaining_time": 0,
  "ams_status": 0,
  "ams_rfid_status": 0,
  "hw_switch_state": 0,
  "spd_mag": 100,
  "spd_lvl": 2,
  "print_error": 0,
  "lifecycle": "product",
  "wifi_signal": "-29dBm",
  "gcode_state": "FINISH",
  "gcode_file_prepare_percent": "100",
  "queue_number": 0,
  "queue_total": 0,
  "queue_est": 0,
  "queue_sts": 0,
  "project_id": "0",
  "profile_id": "0",
  "task_id": "1",
  "subtask_id": "0",
  "subtask_name": "scrubbed-job",
  "gcode_file": "",
  "stg": [],
  "stg_cur": 255,
  "print_type": "idle",
  "home_flag": 6504720,
  "mc_print_line_number": "0",
  "mc_print_sub_stage": 0,
  "sdcard": true,
  "force_upgrade": false,
  "mess_production_state": "active",
  "layer_num": 575,
  "total_layer_num": 575,
  "s_obj": [],
  "filam_bak": [],
  "fan_gear": 0,
  "nozzle_diameter": "0.4",
  "nozzle_type": "stainless_steel",
  "cali_version": 0,
  "k": "0.0200",
  "flag3": 651,
  "upgrade_state": {
    "sequence_id": 0,
    "progress": "",
    "status": "IDLE",
    "consistency_request": false,
    "dis_state": 0,
    "err_code": 0,
    "force_upgrade": false,
    "message": "0%, 0B/s",
    "module": "",
    "new_version_state": 0,
    "cur_state_code": 0,
    "idx2": 2820777707,
    "new_ver_list": []
  },
  "hms": [],
  "online": {
    "ahb": false,
    "rfid": false,
    "version": 1927395192
  },
  "ams": {
    "ams": [
      {
        "chip_id": "0000000000000000000000000000000",
        "ams_id": "006MOCK00000004",
        "check": 1,
        "id": "0",
        "humidity": "2",
        "humidity_raw": "32",
        "temp": "30.9",
        "dry_time": 0,
        "info": "1001",
        "tray": [
          {
            "id": "0",
            "state": 3,
            "remain": -1,
            "k": 0.019999999552965164,
            "n": 1,
            "cali_idx": -1,
            "total_len": 330000,
            "tag_uid": "0000000000000000",
            "tray_id_name": "",
            "tray_info_idx": "GFG00",
            "tray_type": "PETG",
            "tray_sub_brands": "",
            "tray_color": "A00014FF",
            "tray_weight": "0",
            "tray_diameter": "0.00",
            "tray_temp": "0",
            "tray_time": "0",
            "bed_temp_type": "0",
            "bed_temp": "0",
            "nozzle_temp_max": "240",
            "nozzle_temp_min": "200",
            "xcam_info": "000000000000000000000000",
            "tray_uuid": "00000000000000000000000000000000",
            "ctype": 0,
            "cols": [
              "A00014FF"
            ]
          },
          {
            "id": "1"
          },
          {
            "id": "2",
            "state": 3,
            "remain": -1,
            "k": 0.019999999552965164,
            "n": 1,
            "cali_idx": -1,
            "total_len": 330000,
            "tag_uid": "0000000000000000",
            "tray_id_name": "",
            "tray_info_idx": "GFA00",
            "tray_type": "PLA",
            "tray_sub_brands": "",
            "tray_color": "C44D9AFF",
            "tray_weight": "0",
            "tray_diameter": "0.00",
            "tray_temp": "0",
            "tray_time": "0",
            "bed_temp_type": "0",
            "bed_temp": "0",
            "nozzle_temp_max": "240",
            "nozzle_temp_min": "200",
            "xcam_info": "000000000000000000000000",
            "tray_uuid": "00000000000000000000000000000000",
            "ctype": 0,
            "cols": [
              "C44D9AFF"
            ]
          },
          {
            "id": "3",
            "state": 3,
            "remain": -1,
            "k": 0.03999999910593033,
            "n": 1,
            "cali_idx": -1,
            "total_len": 330000,
            "tag_uid": "0000000000000000",
            "tray_id_name": "",
            "tray_info_idx": "GFG00",
            "tray_type": "PETG",
            "tray_sub_brands": "",
            "tray_color": "E6E6E6FF",
            "tray_weight": "0",
            "tray_diameter": "0.00",
            "tray_temp": "0",
            "tray_time": "0",
            "bed_temp_type": "0",
            "bed_temp": "0",
            "nozzle_temp_max": "240",
            "nozzle_temp_min": "200",
            "xcam_info": "000000000000000000000000",
            "tray_uuid": "00000000000000000000000000000000",
            "ctype": 0,
            "cols": [
              "E6E6E6FF"
            ]
          }
        ]
      }
    ],
    "ams_exist_bits": "1",
    "tray_exist_bits": "d",
    "tray_is_bbl_bits": "d",
    "tray_tar": "255",
    "tray_now": "255",
    "tray_pre": "255",
    "tray_read_done_bits": "d",
    "tray_reading_bits": "0",
    "version": 72,
    "insert_flag": true,
    "power_on_flag": false
  },
  "vt_tray": {
    "id": "254",
    "tag_uid": "0000000000000000",
    "tray_id_name": "",
    "tray_info_idx": "",
    "tray_type": "",
    "tray_sub_brands": "",
    "tray_color": "00000000",
    "tray_weight": "0",
    "tray_diameter": "0.00",
    "tray_temp": "0",
    "tray_time": "0",
    "bed_temp_type": "0",
    "bed_temp": "0",
    "nozzle_temp_max": "0",
    "nozzle_temp_min": "0",
    "xcam_info": "000000000000000000000000",
    "tray_uuid": "00000000000000000000000000000000",
    "remain": 0,
    "k": 0.019999999552965164,
    "n": 1,
    "cali_idx": -1
  },
  "lights_report": [
    {
      "node": "chamber_light",
      "mode": "on"
    }
  ]
}

export const p1sModules: ReadonlyArray<Schema.JsonObject> = [
  {
    "name": "ota",
    "sw_ver": "01.09.00.00",
    "hw_ver": "OTA",
    "loader_ver": "00.00.00.00",
    "sn": "01PMOCK00000001",
    "product_name": "Bambu Lab P1S",
    "visible": true,
    "flag": 0
  },
  {
    "name": "esp32",
    "sw_ver": "01.16.36.43",
    "hw_ver": "AP04",
    "loader_ver": "00.00.00.00",
    "sn": "01PMOCK00000001",
    "product_name": "",
    "visible": false,
    "flag": 0
  },
  {
    "name": "mc",
    "sw_ver": "00.01.32.93",
    "hw_ver": "MC07",
    "loader_ver": "00.00.00.28",
    "sn": "01DMOCK00000002",
    "product_name": "",
    "visible": false,
    "flag": 0
  },
  {
    "name": "th",
    "sw_ver": "00.00.09.95",
    "hw_ver": "TH09",
    "loader_ver": "00.00.00.14",
    "sn": "01EMOCK00000003",
    "product_name": "",
    "visible": false,
    "flag": 0
  },
  {
    "name": "ams/0",
    "sw_ver": "00.01.06.62",
    "hw_ver": "AMS08",
    "loader_ver": "00.00.00.00",
    "sn": "006MOCK00000004",
    "product_name": "AMS (1)",
    "visible": true,
    "flag": 0
  }
]
