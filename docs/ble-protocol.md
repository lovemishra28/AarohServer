# Aaroh Sensing Stick: BLE Protocol v1

This document defines the GATT (Generic Attribute Profile) contract for the Aaroh ESP32 sensing stick and the AgroPulse React Native app.

## Advertising & Discovery

- **Device Name:** `Aaroh-Stick-<ID>` (where ID is the last 4 characters of the MAC address or a unique serial).
- **Service UUID (Primary):** `4fafc201-1fb5-459e-8fcc-c5c9c331914b` (Aaroh Service)

## Characteristics

### 1. Sensor Data Stream (Notify/Read)
- **UUID:** `beb5483e-36e1-4688-b7f5-ea07361b26a8`
- **Properties:** Notify, Read
- **Format:** CSV string (UTF-8)
- **Description:** 
  The stick pushes sensor data via notifications when a reading is captured or streams continuously during a sampling sequence. The payload is a comma-separated key-value string.
- **Payload Example:**
  `ID:P123,FW:1.0.2,N:100.5,P:20.1,K:30.0,pH:7.1,EC:1200,M:15,T:24.5,Lat:26.223,Lng:78.112,TS:1693353600`
- **Keys:**
  - `ID`: Probe serial ID
  - `FW`: Firmware version
  - `N`, `P`, `K`: Elemental NPK in mg/kg
  - `pH`: pH level (3.0 - 10.0)
  - `EC`: Conductivity in µS/cm
  - `M`: Moisture (VWC %)
  - `T`: Root-zone temperature in °C
  - `Lat`, `Lng`: GPS coordinates
  - `TS`: Timestamp (Unix Epoch, if stick RTC is set)

### 2. Command Channel (Write)
- **UUID:** `8b72e519-54d9-4de7-91f8-00a44f931d8c`
- **Properties:** Write, Write Without Response
- **Format:** String commands
- **Commands:**
  - `CMD:START`: Begin active sampling/streaming.
  - `CMD:STOP`: End sampling.
  - `CMD:SYNC_TIME:<unix_timestamp>`: Set the RTC on the ESP32.

## Connection Lifecycle

1. **Scan:** The app scans for devices advertising the Primary Service UUID.
2. **Connect & Negotiate MTU:** The app connects and requests an MTU of 512 bytes (to ensure full frame delivery in one packet if possible).
3. **Discover:** The app discovers services and characteristics.
4. **Subscribe:** The app subscribes to the Sensor Data Stream characteristic.
5. **Sync:** The app writes the current time to the Command Channel (if needed).
6. **Ingest:** The app receives frames, parses them, batches them, and handles upload via the `readings` API endpoint.
