const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

let busLocation = { lat: 0, lng: 0 };

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

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
