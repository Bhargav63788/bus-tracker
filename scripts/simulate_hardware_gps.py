"""
Hardware GPS Telemetry Simulator for Bus Tracker.
Simulates an Electronic Ticket Machine (Android ETM or ESP32 u-blox GPS)
transmitting actual road telemetry to POST /update-location.
"""

import sys
import time
import requests

SERVER_URL = "http://localhost:3000/update-location"

# Sample highway coordinates along Bangalore - Electronic City Elevated Expressway (NH-44)
WAYPOINTS = [
    (12.91720, 77.62280, 42, 145),
    (12.91510, 77.62410, 48, 145),
    (12.91300, 77.62550, 52, 146),
    (12.91090, 77.62690, 55, 146),
    (12.90880, 77.62830, 54, 145),
    (12.90670, 77.62970, 50, 146),
    (12.90460, 77.63110, 48, 145),
    (12.90250, 77.63250, 52, 146),
    (12.90040, 77.63390, 56, 146),
    (12.89830, 77.63530, 55, 146)
]

def run_simulation(server_url=SERVER_URL, interval=2.0, count=len(WAYPOINTS)):
    print(f"🚌 Starting Hardware GPS Telemetry -> {server_url}")
    print(f"📡 Transmitting {count} GPS packets with ~{interval}s interval...")

    for i in range(count):
        lat, lng, spd, hdg = WAYPOINTS[i % len(WAYPOINTS)]
        payload = {
            "lat": lat,
            "lng": lng,
            "accuracy": 4.2,
            "speed": spd,
            "heading": hdg,
            "busId": "BUS-01",
            "source": "hardware_etm",
            "timestamp": int(time.time() * 1000)
        }

        try:
            res = requests.post(server_url, json=payload, timeout=5)
            data = res.json()
            snapped = " (Road Snapped: " + str(data.get("roadName")) + ")" if data.get("roadName") else ""
            print(f"[{i+1}/{count}] Fix sent: {lat:.5f}, {lng:.5f} | Speed: {spd} km/h{snapped}")
        except Exception as err:
            print(f"[{i+1}/{count}] ⚠️ Error sending to server: {err}")

        if i < count - 1:
            time.sleep(interval)

    print("✅ Hardware Telemetry sequence completed.")

if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else SERVER_URL
    run_simulation(server_url=url)
