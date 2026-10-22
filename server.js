const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

let busLocation = null;

// serve pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "track.html")));
app.get("/track.html", (req, res) => res.sendFile(path.join(__dirname, "track.html")));
app.get("/conductor.html", (req, res) => res.sendFile(path.join(__dirname, "conductor.html")));
app.get("/bus.png", (req, res) => res.sendFile(path.join(__dirname, "bus.png")));

// receive location
app.post("/update-location", (req, res) => {
  const { lat, lng, accuracy } = req.body || {};
  if (
    typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
    typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180 ||
    (accuracy !== undefined && (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0))
  ) {
    return res.status(400).send("Invalid location");
  }
  busLocation = { lat, lng, accuracy: accuracy ?? null };
  console.log("Updated:", busLocation);
  res.send("Location updated");
});

// send location
app.get("/get-location", (req, res) => {
  res.json(busLocation);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
