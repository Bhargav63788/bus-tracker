# Bus Tracker

A simple real-time bus location tracker. A conductor can share a device's GPS location, and passengers can view the bus moving on a map.

## Features

- Live map powered by [Leaflet](https://leafletjs.com/) and OpenStreetMap.
- Conductor page for starting and stopping GPS location sharing.
- Bus position refreshes every three seconds.
- Shows GPS accuracy when the device provides it.
- Express server provides the web pages and location API.

## Live application

- **Bus tracker:** https://bus-tracker-bluz.onrender.com/track.html
- **Conductor panel:** https://bus-tracker-bluz.onrender.com/conductor.html

Open the conductor panel on the device sharing its location, allow location access, and select **Start Sharing**. Open the tracker link on the devices watching the bus.

## Requirements

- [Node.js](https://nodejs.org/) and npm.
- A browser that supports the Geolocation API.

## Run locally

From the project directory, install dependencies and start the server:

```bash
npm install
npm start
```

Open these pages in a browser:

- **Bus tracker:** http://localhost:3000/
- **Conductor panel:** http://localhost:3000/conductor.html

On the conductor device, open the conductor panel, allow location access, and select **Start Sharing**. Open the tracker on the device you want to use to watch the bus. Select **Stop Sharing** to stop sending GPS updates.

> Browsers generally require HTTPS for geolocation on other devices. `http://localhost` is allowed for local development; when accessing the app over a network or deploying it, use HTTPS.

## How it works

The conductor page sends GPS coordinates and accuracy to `POST /update-location`. The tracker polls `GET /get-location` every three seconds and displays the latest position. The Express server serves the tracker, conductor page, and bus icon.

The server keeps the latest location in memory, so it is cleared whenever the server restarts. This project does not include a database or user authentication.
