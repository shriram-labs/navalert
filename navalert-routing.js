/**
 * NAVALERT ROUTE PLANNING & ROUTING SERVICE (PROVIDER-INDEPENDENT ABSTRACTION)
 * 
 * Provides a provider-independent routing and directions abstraction.
 * Pluggable Providers:
 *   - OsrmRoutingProvider (Current default / OpenStreetMap / Open access)
 *   - MapboxRoutingProvider (Directions API v5 / Driving & Traffic / Requires Token)
 * 
 * Architecture:
 *   NAVALERT Route Planning Service
 *              ↓
 *   NAVALERT Routing Service (NavalertRoutingService)
 *              ↓
 *   ┌────────────────────────┐
 *   │ Routing Provider       │
 *   ├────────────────────────┤
 *   │ OSRM       (Current)   │
 *   │ Mapbox     (Evaluate)  │
 *   └────────────────────────┘
 * 
 * Fully decoupled from UI, Firebase, and GPS deviation tracking layers.
 * Supports UMD (Browser window and Node.js CommonJS/ESM).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const exports = factory();
    root.NavalertRouting = exports;
    root.NavalertRoutingService = exports.NavalertRoutingService;
    root.OsrmRoutingProvider = exports.OsrmRoutingProvider;
    root.MapboxRoutingProvider = exports.MapboxRoutingProvider;
    root.computeGeometryOverlap = exports.computeGeometryOverlap;
    root.computeRouteViaLabels = exports.computeRouteViaLabels;
    root.filterAndRankRoutes = exports.filterAndRankRoutes;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ===================================================================
  // 1. GEODETIC & ROUTE DIVERSITY UTILITIES
  // ===================================================================

  function haversineMeters(lon1, lat1, lon2, lat2) {
    const R = 6371000.0;
    const dLat = (lat2 - lat1) * Math.PI / 180.0;
    const dLon = (lon2 - lon1) * Math.PI / 180.0;
    const a = Math.sin(dLat / 2.0) * Math.sin(dLat / 2.0) +
              Math.cos(lat1 * Math.PI / 180.0) * Math.cos(lat2 * Math.PI / 180.0) *
              Math.sin(dLon / 2.0) * Math.sin(dLon / 2.0);
    return 2.0 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  }

  /**
   * Computes the geometric spatial overlap and maximum lateral separation
   * between two route LineStrings within a spatial buffer (default: 100 meters).
   * 
   * @param {Array<[number, number]>} coordsA - Array of [lon, lat] pairs
   * @param {Array<[number, number]>} coordsB - Array of [lon, lat] pairs
   * @param {number} [bufferMeters=100.0] - Spatial buffer distance in meters
   * @returns {{ overlapPercent: number, maxSeparationMeters: number, sharedLengthMeters: number, totalLengthMeters: number }}
   */
  function computeGeometryOverlap(coordsA, coordsB, bufferMeters) {
    bufferMeters = bufferMeters || 100.0;
    if (!coordsA || !coordsB || coordsA.length < 2 || coordsB.length < 2) {
      return { overlapPercent: 0, maxSeparationMeters: 0, sharedLengthMeters: 0, totalLengthMeters: 0 };
    }

    let totalLen = 0;
    let sharedLen = 0;
    let maxSep = 0;

    for (let i = 0; i < coordsA.length - 1; i++) {
      const p1Lon = coordsA[i][0], p1Lat = coordsA[i][1];
      const p2Lon = coordsA[i+1][0], p2Lat = coordsA[i+1][1];
      const segLen = haversineMeters(p1Lon, p1Lat, p2Lon, p2Lat);
      totalLen += segLen;

      const midLon = (p1Lon + p2Lon) / 2.0;
      const midLat = (p1Lat + p2Lat) / 2.0;

      let minDist = Infinity;
      for (let j = 0; j < coordsB.length - 1; j++) {
        const aLon = coordsB[j][0], aLat = coordsB[j][1];
        const bLon = coordsB[j+1][0], bLat = coordsB[j+1][1];

        const dx = (bLon - aLon) * Math.cos((aLat + bLat) * Math.PI / 360.0) * 111320.0;
        const dy = (bLat - aLat) * 110540.0;
        const segLenSq = dx * dx + dy * dy;

        let d;
        if (segLenSq < 1.0) {
          d = haversineMeters(midLon, midLat, aLon, aLat);
        } else {
          const px = (midLon - aLon) * Math.cos((aLat + bLat) * Math.PI / 360.0) * 111320.0;
          const py = (midLat - aLat) * 110540.0;
          const t = Math.max(0.0, Math.min(1.0, (px * dx + py * dy) / segLenSq));
          const projLon = aLon + t * (bLon - aLon);
          const projLat = aLat + t * (bLat - aLat);
          d = haversineMeters(midLon, midLat, projLon, projLat);
        }
        if (d < minDist) minDist = d;
        if (minDist < 10.0) break;
      }

      if (minDist <= bufferMeters) {
        sharedLen += segLen;
      }
      if (minDist > maxSep) {
        maxSep = minDist;
      }
    }

    const overlapPct = totalLen > 0 ? (sharedLen / totalLen) * 100.0 : 0.0;
    return {
      overlapPercent: Math.round(overlapPct * 10) / 10,
      maxSeparationMeters: Math.round(maxSep),
      sharedLengthMeters: Math.round(sharedLen),
      totalLengthMeters: Math.round(totalLen)
    };
  }

  /**
   * Generates clean, distinct human-readable "via [Road Name]" labels
   * by identifying identifying road names present in one alternative but not others.
   */
  function computeRouteViaLabels(rawRoutes) {
    if (!Array.isArray(rawRoutes) || rawRoutes.length === 0) return [];

    const allRoutesRoads = [];
    rawRoutes.forEach(function (r) {
      const roads = [];
      const seen = new Set();
      if (r.legs && r.legs[0] && r.legs[0].steps) {
        r.legs[0].steps.forEach(function (step) {
          const name = (step.name || '').trim();
          if (name && !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            roads.push(name);
          }
        });
      }
      allRoutesRoads.push(roads);
    });

    return rawRoutes.map(function (r, i) {
      const myRoads = allRoutesRoads[i] || [];
      const otherRoads = new Set();
      allRoutesRoads.forEach(function (roads, j) {
        if (j !== i) {
          roads.forEach(function (rd) { otherRoads.add(rd.toLowerCase()); });
        }
      });

      const distinctRoads = myRoads.filter(function (rd) {
        return !otherRoads.has(rd.toLowerCase());
      });

      if (distinctRoads.length > 0) {
        return 'via ' + distinctRoads[0];
      } else if (myRoads.length > 0) {
        return 'via ' + myRoads.slice(0, 2).join(', ');
      } else if (r.legs && r.legs[0] && r.legs[0].summary && r.legs[0].summary.trim()) {
        return 'via ' + r.legs[0].summary.trim();
      } else {
        return i === 0 ? 'Primary Route' : 'Alternative Route ' + (i + 1);
      }
    });
  }

  // ===================================================================
  // 2. ROUTING PROVIDER: OSRM (Open Source Routing Machine)
  // ===================================================================

  const OsrmRoutingProvider = {
    name: 'osrm',
    baseUrl: 'https://router.project-osrm.org/route/v1/driving/',

    isConfigured() {
      return true; // Open access server, does not require an API key
    },

    async calculateRoute(origin, destination, options) {
      options = options || {};
      const alternatives = options.alternatives !== undefined ? options.alternatives : 3;
      const coordsParam = origin.lon + ',' + origin.lat + ';' + destination.lon + ',' + destination.lat;
      const url = this.baseUrl + coordsParam + '?overview=full&geometries=geojson&alternatives=' + alternatives + '&steps=true';

      const res = await fetch(url, { signal: options.signal });
      if (!res.ok) throw new Error('OSRM request failed (' + res.status + ')');
      const data = await res.json();
      if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
        return [];
      }
      return data.routes.slice(0, 3);
    },

    normalize(r, index, fastestDuration, fastestDistance) {
      if (!r || !r.geometry || !Array.isArray(r.geometry.coordinates)) return null;

      const coords = r.geometry.coordinates;
      const waypoints = coords.map(function (pair) {
        return { lat: pair[1], lon: pair[0] };
      });
      const distKm = (r.distance / 1000).toFixed(1);
      const durMin = Math.round(r.duration / 60);
      const diffMin = Math.round((r.duration - fastestDuration) / 60);
      const diffKm = ((r.distance - fastestDistance) / 1000).toFixed(1);

      return {
        id: 'osrm-' + index,
        provider: 'osrm',
        index: index,
        distanceMeters: r.distance,
        durationSeconds: r.duration,
        distanceKm: distKm,
        durationMin: durMin,
        coordinates: coords,
        waypoints: waypoints,
        via: '',
        summary: r.legs && r.legs[0] ? (r.legs[0].summary || '') : '',
        isFastest: (r.duration === fastestDuration),
        diffMin: diffMin,
        diffKm: diffKm,
        legs: r.legs || [],
        raw: r
      };
    }
  };

  // ===================================================================
  // 3. ROUTING PROVIDER: MAPBOX DIRECTIONS API (v5)
  // ===================================================================

  const MapboxRoutingProvider = (function () {
    let accessToken = '';

    // Isolated Configuration Point (re-uses established pattern)
    function resolveInitialToken() {
      if (typeof process !== 'undefined' && process.env && process.env.MAPBOX_ACCESS_TOKEN) {
        return process.env.MAPBOX_ACCESS_TOKEN;
      }
      if (typeof window !== 'undefined') {
        if (window.NAVALERT_MAPBOX_TOKEN) return window.NAVALERT_MAPBOX_TOKEN;
        try {
          const stored = window.localStorage.getItem('navalert_mapbox_token');
          if (stored) return stored;
        } catch (_) {}
      }
      return '';
    }

    accessToken = resolveInitialToken();

    return {
      name: 'mapbox',
      baseUrl: 'https://api.mapbox.com/directions/v5/mapbox',

      setAccessToken(token) {
        accessToken = (token || '').trim();
        if (typeof window !== 'undefined') {
          window.NAVALERT_MAPBOX_TOKEN = accessToken;
          try {
            if (accessToken) {
              window.localStorage.setItem('navalert_mapbox_token', accessToken);
            } else {
              window.localStorage.removeItem('navalert_mapbox_token');
            }
          } catch (_) {}
        }
      },

      getAccessToken() {
        return accessToken;
      },

      isConfigured() {
        return Boolean(
          accessToken &&
          accessToken.length > 10 &&
          !accessToken.startsWith('PASTE_') &&
          (accessToken.startsWith('pk.') || accessToken.startsWith('sk.'))
        );
      },

      async calculateRoute(origin, destination, options) {
        options = options || {};
        if (!this.isConfigured()) {
          const err = new Error('MapboxRoutingProvider is not configured: MAPBOX_ACCESS_TOKEN is missing or unconfigured.');
          err.code = 'PROVIDER_NOT_CONFIGURED';
          throw err;
        }

        // Profile selection: 'driving' (standard free-flow) or 'driving-traffic' (live traffic-aware)
        const profile = options.profile || (options.useTraffic ? 'driving-traffic' : 'driving');
        const coordsParam = origin.lon + ',' + origin.lat + ';' + destination.lon + ',' + destination.lat;
        const alternativesParam = options.alternatives !== false ? 'true' : 'false';

        const url = `${this.baseUrl}/${profile}/${coordsParam}?overview=full&geometries=geojson&alternatives=${alternativesParam}&steps=true&access_token=${encodeURIComponent(accessToken)}`;

        const res = await fetch(url, { signal: options.signal });
        if (!res.ok) {
          const status = res.status;
          let message = `Mapbox Directions API returned HTTP ${status}`;
          try {
            const body = await res.json();
            if (body && body.message) message += `: ${body.message}`;
          } catch (_) {}
          const error = new Error(message);
          error.status = status;
          throw error;
        }

        const data = await res.json();
        if (data.code !== 'Ok' || !data.routes || !Array.isArray(data.routes) || data.routes.length === 0) {
          return [];
        }

        return data.routes.slice(0, 3);
      },

      normalize(r, index, fastestDuration, fastestDistance) {
        if (!r || !r.geometry || !Array.isArray(r.geometry.coordinates)) return null;

        const coords = r.geometry.coordinates;
        const waypoints = coords.map(function (pair) {
          return { lat: pair[1], lon: pair[0] };
        });
        const distKm = (r.distance / 1000).toFixed(1);
        const durMin = Math.round(r.duration / 60);
        const diffMin = Math.round((r.duration - fastestDuration) / 60);
        const diffKm = ((r.distance - fastestDistance) / 1000).toFixed(1);

        return {
          id: 'mapbox-' + index,
          provider: 'mapbox',
          index: index,
          distanceMeters: r.distance,
          durationSeconds: r.duration,
          distanceKm: distKm,
          durationMin: durMin,
          coordinates: coords,
          waypoints: waypoints,
          via: '',
          summary: r.legs && r.legs[0] ? (r.legs[0].summary || '') : '',
          isFastest: (r.duration === fastestDuration),
          diffMin: diffMin,
          diffKm: diffKm,
          legs: r.legs || [],
          weight: r.weight,
          weightName: r.weight_name,
          raw: r
        };
      }
    };
  })();

  // ===================================================================
  // 4. ROUTE FILTERING & DIVERSITY RANKING
  // ===================================================================

  /**
   * Applies NAVALERT's geometry-diversity algorithm to filter and classify routes.
   * Classifications:
   *   - PRIMARY: The baseline route (usually fastest)
   *   - GENUINE_ALTERNATIVE: overlap < 75% AND maxSeparation >= 400m
   *   - PSEUDO_DUPLICATE: overlap >= 82% OR maxSeparation <= 250m
   *   - MARGINAL_DETOUR: in between genuine and pseudo-duplicate
   */
  function filterAndRankRoutes(rawRoutes, options) {
    options = options || {};
    if (!rawRoutes || rawRoutes.length === 0) return [];

    const viaLabels = computeRouteViaLabels(rawRoutes);

    let fastestDuration = rawRoutes[0].duration;
    let fastestDistance = rawRoutes[0].distance;
    let fastestIndex = 0;
    for (let i = 1; i < rawRoutes.length; i++) {
      if (rawRoutes[i].duration < fastestDuration) {
        fastestDuration = rawRoutes[i].duration;
        fastestDistance = rawRoutes[i].distance;
        fastestIndex = i;
      }
    }

    const providerName = options.provider || 'osrm';
    let provider = null;
    if (providerName === 'mapbox') provider = MapboxRoutingProvider;
    else provider = OsrmRoutingProvider;

    const normalizedRoutes = rawRoutes.map(function (r, i) {
      const norm = provider && provider.normalize
        ? provider.normalize(r, i, fastestDuration, fastestDistance)
        : r;
      norm.via = viaLabels[i] || (i === 0 ? 'Primary Route' : 'Alternative Route ' + (i + 1));
      return norm;
    });

    // Compute geometric overlap & separation against primary route
    const primaryRoute = normalizedRoutes[0];
    for (let i = 0; i < normalizedRoutes.length; i++) {
      const r = normalizedRoutes[i];
      if (i === 0) {
        r.overlapWithPrimary = 100.0;
        r.maxSeparationMeters = 0;
        r.isGenuineAlternative = true;
        r.diversityVerdict = 'PRIMARY';
      } else {
        const comp = computeGeometryOverlap(r.coordinates, primaryRoute.coordinates, 100.0);
        r.overlapWithPrimary = comp.overlapPercent;
        r.maxSeparationMeters = comp.maxSeparationMeters;

        if (comp.overlapPercent < 75.0 && comp.maxSeparationMeters >= 400.0) {
          r.isGenuineAlternative = true;
          r.diversityVerdict = 'GENUINE_ALTERNATIVE';
        } else if (comp.overlapPercent >= 82.0 || comp.maxSeparationMeters <= 250.0) {
          r.isGenuineAlternative = false;
          r.diversityVerdict = 'PSEUDO_DUPLICATE';
        } else {
          r.isGenuineAlternative = false;
          r.diversityVerdict = 'MARGINAL_DETOUR';
        }
      }
    }

    if (options.filterDuplicates) {
      return normalizedRoutes.filter(function (r) {
        return r.diversityVerdict !== 'PSEUDO_DUPLICATE';
      });
    }

    return normalizedRoutes;
  }

  // ===================================================================
  // 5. NAVALERT ROUTING SERVICE
  // ===================================================================

  const NavalertRoutingService = (function () {
    const providers = new Map();

    // Register built-in providers
    providers.set(OsrmRoutingProvider.name, OsrmRoutingProvider);
    providers.set(MapboxRoutingProvider.name, MapboxRoutingProvider);

    async function calculateRoute(origin, destination, options) {
      options = options || {};
      const providerName = options.provider || 'osrm';
      const provider = providers.get(providerName);
      if (!provider) {
        throw new Error("Routing provider '" + providerName + "' is not registered");
      }

      if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
        const err = new Error(`Routing provider '${providerName}' is not configured`);
        err.code = 'PROVIDER_NOT_CONFIGURED';
        throw err;
      }

      const rawRoutes = await provider.calculateRoute(origin, destination, options);
      if (!rawRoutes || rawRoutes.length === 0) {
        return { provider: providerName, routes: [], primaryRoute: null };
      }

      const ranked = filterAndRankRoutes(rawRoutes, {
        provider: providerName,
        filterDuplicates: options.filterDuplicates
      });

      return {
        provider: providerName,
        routes: ranked,
        primaryRoute: ranked[0] || null
      };
    }

    return {
      registerProvider(provider) {
        if (provider && provider.name) {
          providers.set(provider.name, provider);
        }
      },
      getProvider(name) {
        return providers.get(name) || null;
      },
      getRegisteredProviders() {
        return Array.from(providers.keys());
      },
      getActiveProviders() {
        const active = [];
        for (const [name, p] of providers.entries()) {
          if (typeof p.isConfigured === 'function' ? p.isConfigured() : true) {
            active.push(name);
          }
        }
        return active;
      },
      computeGeometryOverlap,
      computeRouteViaLabels,
      filterAndRankRoutes,
      calculateRoute
    };
  })();

  return {
    haversineMeters,
    computeGeometryOverlap,
    computeRouteViaLabels,
    filterAndRankRoutes,
    OsrmRoutingProvider,
    MapboxRoutingProvider,
    NavalertRoutingService
  };
});
