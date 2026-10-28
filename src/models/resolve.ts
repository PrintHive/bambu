import { modelByCode, modelByPrinterType, modelBySerial, models } from "@printhive/bambu-models"
import type { Model, ModelId } from "@printhive/bambu-models"
import type { Serial } from "../wire/ids.ts"

export interface ModelResolution {
  readonly id: ModelId
  readonly via: "printer_type" | "serial_prefix"
  readonly facts: Model
}

export const resolveModel = (serial: Serial, printerType: string | undefined): ModelResolution | undefined => {
  // 0.1.1 has modelCodes but no printerTypes. Reported codes still use the registry.
  const reported = printerType === undefined ? undefined : modelByPrinterType(printerType) ?? modelByCode(printerType)
  const id = reported ?? modelBySerial(serial)

  return id === undefined ? undefined : { id, via: reported === undefined ? "serial_prefix" : "printer_type", facts: models[id] }
}
