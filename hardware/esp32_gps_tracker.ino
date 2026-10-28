/*
  Bus Tracker - Embedded GPS Firmware for ESP32 + SIM7600 4G LTE + u-blox GPS
  
  Reads NMEA sentences from u-blox GPS (UART 2), formats JSON payload,
  and posts real-time coordinates to the Bus Tracker server over 4G LTE.
*/

#include <HardwareSerial.h>
#include <TinyGPSPlus.h>

// Configuration
const char* SERVER_URL = "https://your-bus-tracker.onrender.com/update-location";
const char* GPS_API_KEY = "your_secure_gps_api_key_here";
const char* BUS_ID = "BUS-42";
const char* ROUTE_ID = "route-42";
const unsigned long UPDATE_INTERVAL_MS = 3000; // 3 seconds

// Pin definitions
#define GPS_RX_PIN 16
#define GPS_TX_PIN 17
#define MODEM_RX_PIN 26
#define MODEM_TX_PIN 27

HardwareSerial gpsSerial(2);
HardwareSerial modemSerial(1);
TinyGPSPlus gps;

unsigned long lastUpdateMs = 0;

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  modemSerial.begin(115200, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);

  Serial.println(F("[INIT] ESP32 Bus Tracker initializing..."));
  delay(3000);

  // Initialize LTE Modem AT commands
  sendModemCommand("AT", 1000);
  sendModemCommand("ATE0", 1000); // Echo off
  sendModemCommand("AT+CPIN?", 1000); // Check SIM status
  sendModemCommand("AT+CREG?", 1000); // Check network registration
  sendModemCommand("AT+HTTPINIT", 2000); // Initialize HTTP service
  
  Serial.println(F("[READY] Waiting for GPS satellite lock..."));
}

void loop() {
  // Feed incoming GPS data to TinyGPS parser
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  // Periodic transmission
  if (millis() - lastUpdateMs >= UPDATE_INTERVAL_MS) {
    lastUpdateMs = millis();

    if (gps.location.isValid() && gps.location.age() < 2000) {
      double lat = gps.location.lat();
      double lng = gps.location.lng();
      double speedKmH = gps.speed.kmph();
      double headingDeg = gps.course.deg();
      double hdop = gps.hdop.hdop();
      double accuracyM = hdop * 3.5; // Approximate horizontal accuracy in meters

      Serial.printf("[GPS] Lat: %.6f, Lng: %.6f, Speed: %.1f km/h, Heading: %.1f deg\n",
                    lat, lng, speedKmH, headingDeg);

      transmitTelemetry(lat, lng, accuracyM, speedKmH, headingDeg);
    } else {
      Serial.println(F("[GPS] Searching for satellites (no valid fix yet)..."));
    }
  }
}

void transmitTelemetry(double lat, double lng, double accuracy, double speed, double heading) {
  // Construct JSON
  char jsonBuffer[256];
  snprintf(jsonBuffer, sizeof(jsonBuffer),
           "{\"lat\":%.6f,\"lng\":%.6f,\"accuracy\":%.1f,\"speed\":%.1f,\"heading\":%.1f,\"busId\":\"%s\",\"routeId\":\"%s\",\"source\":\"hardware\"}",
           lat, lng, accuracy, speed, heading, BUS_ID, ROUTE_ID);

  Serial.println(F("[MODEM] Sending HTTP POST to server..."));

  sendModemCommand("AT+HTTPPARA=\"CID\",1", 1000);
  
  char urlCmd[128];
  snprintf(urlCmd, sizeof(urlCmd), "AT+HTTPPARA=\"URL\",\"%s\"", SERVER_URL);
  sendModemCommand(urlCmd, 1000);

  sendModemCommand("AT+HTTPPARA=\"CONTENT\",\"application/json\"", 1000);

  // Set API Key header
  char headerCmd[128];
  snprintf(headerCmd, sizeof(headerCmd), "AT+HTTPPARA=\"USERDATA\",\"X-API-KEY: %s\"", GPS_API_KEY);
  sendModemCommand(headerCmd, 1000);

  // Write payload
  char dataCmd[64];
  snprintf(dataCmd, sizeof(dataCmd), "AT+HTTPDATA=%d,5000", strlen(jsonBuffer));
  sendModemCommand(dataCmd, 1000);
  modemSerial.print(jsonBuffer);
  delay(1000);

  // Execute POST (action 1 = POST)
  sendModemCommand("AT+HTTPACTION=1", 4000);

  // Read response
  sendModemCommand("AT+HTTPREAD", 2000);
}

void sendModemCommand(const char* cmd, unsigned long timeoutMs) {
  modemSerial.println(cmd);
  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    while (modemSerial.available()) {
      char c = modemSerial.read();
      Serial.write(c);
    }
  }
}
