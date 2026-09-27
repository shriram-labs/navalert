# NavAlert: Intelligent GPS Route Monitoring System

NavAlert is a smartphone-based intelligent GPS route monitoring and traveler safety system designed for college campuses, student commuters, and transit travelers. It continuously tracks a traveler's journey in real time, compares live GPS coordinates against a planned road route, identifies off-route deviations, and synchronizes telemetry to an observer dashboard without requiring proprietary GPS tracking hardware.

---

## Table of Contents

1. [Main Application Pages](#main-application-pages)
2. [System Architecture Overview](#system-architecture-overview)
3. [Search Architecture (`navalert-search.js`)](#search-architecture-navalert-searchjs)
4. [Routing Architecture (`navalert-routing.js`)](#routing-architecture-navalert-routingjs)
5. [Role of OSRM (Default Routing Engine)](#role-of-osrm-default-routing-engine)
6. [Optional Mapbox Integration (Non-Mandatory)](#optional-mapbox-integration-non-mandatory)
7. [Nominatim & Photon Fallback Chain](#nominatim--photon-fallback-chain)
8. [Firebase Realtime Database Synchronization](#firebase-realtime-database-synchronization)
9. [GPS Tracking & Deviation Detection Engine](#gps-tracking--deviation-detection-engine)
10. [Observer Dashboard & Real-Time Telemetry](#observer-dashboard--real-time-telemetry)
11. [Automated Test Suites](#automated-test-suites)
12. [How to Run Locally](#how-to-run-locally)

---

## Main Application Pages

- **Driver / Traveler Interface (`index.html`)**  
  The primary user interface running on the traveler's smartphone browser. Provides origin and destination autocomplete search, OSRM road route computation with alternative route selection, live GPS positioning, cross-track deviation monitoring, trip credential generation (Trip ID + 4-digit PIN), and automated Firebase telemetry sync.
  
- **Observer Dashboard (`observer.html`)**  
  The remote monitoring interface for family members, guardians, or campus security personnel. Observers authenticate with a shared Trip ID and secure PIN to view the traveler's live location, planned route line, actual traveled breadcrumb path, speed, and real-time audio-visual deviation alerts.

---

## System Architecture Overview

```
                      Traveler Smartphone Browser
                                (index.html)
                                     │
         ┌───────────────────────────┴───────────────────────────┐
         ▼                                                       ▼
Place Search Layer                                      Routing & Plan Layer
(NavalertSearchService)                                (NavalertRoutingService)
         │                                                       │
  ┌──────┴──────┐                                         ┌──────┴──────┐
  │ Nominatim   │ (Default open geocoding)                │ OSRM Engine │ (Default road router)
  │ Photon      │ (Komoot fallback)                       │ Mapbox      │ (Optional evaluation)
  │ Mapbox      │ (Optional with token)                   └──────┬──────┘
  └──────┬──────┘                                                │
         ▼                                                       ▼
Normalized Coordinates                                  Normalized Road Waypoints
[lat, lon]                                              [[lat, lon], ...]
         │                                                       │
         └───────────────────────────┬───────────────────────────┘
                                     │
                                     ▼
                        Live GPS Deviation Engine
                     (Haversine Perpendicular Distance)
                                     │
                   ┌─────────────────┴─────────────────┐
                   ▼                                   ▼
          Local Audio Alert                   Firebase Realtime DB
          (Buzzer + Speech)                   (trips/{id}/{pin})
                                                       │
                                                       ▼
                                              Observer Dashboard
                                                (observer.html)
```

---

## Search Architecture (`navalert-search.js`)

The place search subsystem is built on a provider-independent service layer (`NavalertSearchService`):

- **Pluggable Providers:** Registered providers implement a unified search contract.
  - `NominatimSearchProvider`: OpenStreetMap Nominatim API (open access).
  - `PhotonSearchProvider`: Komoot Photon search API (fast open autocomplete).
  - `MapboxSearchProvider`: Mapbox Geocoding v5 API (optional evaluation).
- **Coordinate Boundary Validation:** All coordinate pairs are strictly validated against WGS84 standards ($[-90.0, +90.0]$ latitude, $[-180.0, +180.0]$ longitude). Non-numeric, infinite, or out-of-bounds inputs are rejected defensively.
- **Spatial Deduplication:** Candidates within a ~100-meter radius or matching primary name and locality are deduplicated into high-relevance suggestions.
- **Proximity Biasing:** Autocomplete queries accept bias coordinates (e.g., current GPS position) to prioritize regional matches.

---

## Routing Architecture (`navalert-routing.js`)

The routing subsystem provides a decoupled abstraction (`NavalertRoutingService`) for road route planning:

- **Unified Normalized Route Contract:** Every provider returns standardized `NormalizedRoute` objects containing:
  - `distanceKm`: One-decimal precision string (e.g., `"6.0"`).
  - `durationSeconds` / `durationMin`: Travel duration in seconds and minutes.
  - `via`: Primary corridor road name (e.g., `"via Mandi Bazar Rd"`).
  - `waypoints`: High-density `[lat, lon]` coordinates for deviation analysis.
  - `geometry`: GeoJSON LineString coordinates `[lon, lat]` for map rendering.
- **NAVALERT Geometry Diversity Filtering:** When multi-route alternatives are returned, `computeGeometryOverlap()` calculates the spatial overlap percentage and maximum lateral separation (meters) between routes. This algorithm reliably separates **genuine route alternatives** (e.g., distinct highways) from **pseudo-duplicate parallel deviations** (e.g., minor service roads).

---

## Role of OSRM (Default Routing Engine)

**Open Source Routing Machine (OSRM)** is the default, primary, and zero-cost routing engine for NavAlert:
- Queries the public OSRM car profile (`https://router.project-osrm.org/route/v1/driving/`).
- Computes road network geometries and multi-route alternatives.
- Generates high-density waypoint sequences that form the baseline corridor for real-time deviation calculations.
- Operates out of the box without requiring any API keys, accounts, or paid subscriptions.

---

## Optional Mapbox Integration (Non-Mandatory)

> **IMPORTANT: Mapbox is completely OPTIONAL.**  
> The NavAlert project is 100% functional without Mapbox credentials.

- **No Token Required:** If no Mapbox access token is provided, the application runs entirely on OSRM, Nominatim, and Photon without any errors or degraded UI behavior.
- **Provider Isolation:** Both `MapboxSearchProvider` and `MapboxRoutingProvider` verify configuration state via `isConfigured()`. When unconfigured, they are safely bypassed by the service layer.
- **Optional Evaluation:** If a developer wishes to evaluate Mapbox services, a valid public access token can be supplied via configuration without modifying application logic.

---

## Nominatim & Photon Fallback Chain

To maintain high availability during search operations:
1. `NavalertSearchService` iterates through active providers in priority order.
2. If a provider encounters a rate limit (HTTP 429), timeout, network outage, or HTTP 403, the error is captured and logged.
3. The service automatically falls back to the next registered provider (e.g., Photon → Nominatim) without failing the user request or crashing the UI.

---

## Firebase Realtime Database Synchronization

NavAlert uses Firebase Realtime Database for low-latency state synchronization between the traveler and observer:

- **Path:** `trips/{tripId}/{pin}/`
- **Synchronized Data:**
  - `pickup`: Starting location name and coordinates.
  - `destination`: Target location name and coordinates.
  - `waypoints`: Planned road path coordinates.
  - `currentLocation`: Live traveler GPS coordinates, accuracy, and heading.
  - `travelPathPoints`: Chronological breadcrumb path of traveled points.
  - `status`: Journey status (`ACTIVE`, `DEVIATED`, `COMPLETED`).
  - `deviationMeters`: Current distance from the planned route.
  - `lastUpdated`: Server timestamp for liveness monitoring.

---

## GPS Tracking & Deviation Detection Engine

Continuous off-route deviation monitoring operates directly in the traveler's browser:

1. **Geolocation Tracking:** Smartphone GPS updates are streamed via `navigator.geolocation.watchPosition` with `enableHighAccuracy: true`.
2. **Cross-Track Calculation:** For every GPS fix, the algorithm computes the perpendicular distance to the closest segment of the planned route polyline using the **Haversine formula**.
3. **Deviation Threshold:** A traveler is flagged as off-route when cross-track distance exceeds **$100\text{ meters}$**.
4. **Sustained Deviation Filter:** To prevent false alarms caused by GPS jitter, multipath reflection, or brief road stops, an alert is triggered only after **3 consecutive off-route position updates**.
5. **Alert Actions:** When sustained deviation occurs, NavAlert plays an audio warning tone, speaks an alert via Web Speech synthesis, flashes the visual indicator, and updates the Firebase status to alert the observer.

---

## Observer Dashboard & Real-Time Telemetry

The observer dashboard (`observer.html`) provides a dedicated interface for remote monitoring:
- **Authentication:** Requires valid Trip ID and 4-digit PIN matching the driver's session.
- **MapLibre GL Mapping:** Renders the planned route geometry (`navalert-route`) alongside the live traveled path (`navalert-traveled`).
- **Telemetry Indicators:** Displays live distance from route, traveler speed, elapsed time, and battery/accuracy state.
- **Emergency Deviation Banner:** Immediately flashes an emergency alert if the traveler deviates from the planned route.

---

## Automated Test Suites

The project includes automated test coverage running on the Node.js test runner:

```bash
# Run all test suites
npm test

# Run search subsystem tests (22 tests)
npm run test:search

# Run routing subsystem tests (15 tests)
npm run test:routing
```

### Coverage Highlights:
- **`tests/search.test.js` (22 Tests):** Validates WGS84 boundary conditions, GeoJSON normalizers, spatial deduplication (~100m), empty/malformed handling, provider fallback, and unconfigured token safety.
- **`tests/routing.test.js` (15 Tests):** Validates route normalization, distance/duration conversions, waypoint extraction, geometry diversity overlap calculation, genuine vs. pseudo-duplicate classification, and OSRM backward compatibility.
- **`tests/ui_flow.test.js`:** Validates simulated DOM autocomplete interaction, search result selection, and coordinate extraction.

---

## How to Run Locally

### Why a Local HTTP Server is Required
Opening `index.html` via the `file://` protocol will cause browser security errors because:
- **Geolocation API** (`navigator.geolocation`) requires a secure origin (`http://localhost` or HTTPS).
- **Service Workers** (`service-worker.js`) cannot register under `file://`.
- **Firebase ES Modules** (`type="module"`) are blocked by browser CORS under `file://`.

### Starting the Local Development Server

1. **Prerequisites:** Ensure [Node.js](https://nodejs.org/) (v18+) is installed.
2. **Install Dependencies (if not already installed):**
   ```bash
   npm install
   ```
3. **Start the Local Server:**
   ```bash
   npm start
   ```
   *Alternative:*
   ```bash
   node server.js
   ```

4. **Access the Application in Your Browser:**
   - **Driver Interface:** [http://localhost:3000/index.html](http://localhost:3000/index.html) (or [http://localhost:3000/](http://localhost:3000/))
   - **Observer Dashboard:** [http://localhost:3000/observer.html](http://localhost:3000/observer.html)

---

## Project Information

- **Project Title:** NavAlert — Intelligent GPS Route Monitoring
- **Project Type:** Final Year Engineering Project
- **Domain:** GPS, Real-Time Web Telemetry, Traveler Safety
- **Core Technologies:** Vanilla JavaScript (ES6+), Leaflet / MapLibre GL, OSRM, OpenStreetMap / Photon, Firebase Realtime Database
