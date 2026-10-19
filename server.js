const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

let busLocation = { lat: 0, lng: 0 };

// serve pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "track.html")));
app.get("/track.html", (req, res) => res.sendFile(path.join(__dirname, "track.html")));
app.get("/conductor.html", (req, res) => res.sendFile(path.join(__dirname, "conductor.html")));
app.get("/bus.png", (req, res) => res.sendFile(path.join(__dirname, "bus.png")));

// receive location
app.post("/update-location", (req, res) => {
  busLocation = req.body;
  console.log("Updated:", busLocation);
  res.send("Location updated");
});

// send location
app.get("/get-location", (req, res) => {
  res.json(busLocation);
});

// use the port Render provides
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
